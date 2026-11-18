#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""handler.py — HTTP 处理器基类 + 静态页 + SSE / WebSocket 入口

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

路由表（do_GET / do_POST）在 core/routes.py —— 找「某个接口在哪儿」看那个文件。
组装出来的类叫 HMIServer；⚠ **RoutesMixin 必须排在基类前面**（见文件末尾的说明）。
"""

from . import auth
from .auth import SESSION_COOKIE
from .auth import SESSION_TTL
from .auth import session_ok
from .broadcast import _clients
from .broadcast import _clients_lock
from .hostutil import _is_local_host
from .hostutil import _split_host
from .loginpage import login_page_html
from .paths import EDITOR_PATH
from .paths import ROOT
from .paths import RUN_ALWAYS
from .routes import RoutesMixin
from .wsbridge import _ws_serve

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import ipaddress
import json
import queue


ALLOW_ANY_ORIGIN = False  # --allow-any-origin 打开后跳过来源校验（默认关）


# ─────────────────────────────────────────────
#  HTTP Handler
# ─────────────────────────────────────────────
class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """浏览器关页面/刷新/SSE 断开都是正常现象，socketserver 默认会为每个这种连接
    打一整段 ConnectionAbortedError 栈 —— 刷屏之后真正的 PLC 报错反而看不见了。"""

    daemon_threads = True
    _QUIET = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, ConnectionError)

    # 累计接受过多少条 TCP 连接（诊断用：和 /api/health 里的 reqs 一起看，
    # 就知道连接有没有被复用 —— 两个数一起涨 = 每个请求都在新建连接，那内存早晚被拖爆）。
    conns = 0

    def get_request(self):
        sock, addr = super().get_request()
        type(self).conns += 1
        return sock, addr

    def handle_error(self, request, client_address):
        import sys as _sys
        exc = _sys.exc_info()[1]
        if isinstance(exc, self._QUIET):
            return                       # 客户端提前断开：属于正常，不打印
        super().handle_error(request, client_address)



# 显式补上 .js / .mjs 的 MIME：Python 3.10 的 extensions_map 里没有 .js，
# 靠 mimetypes 兜底在个别机器/版本上可能给错或给空 → 浏览器按 HTML 规范拒绝加载
# ES module（「Failed to load module script」），前端整个白屏。这里写死最稳。
SimpleHTTPRequestHandler.extensions_map.update({
    ".js": "application/javascript",
    ".mjs": "application/javascript",
})

class HMIHandlerBase(SimpleHTTPRequestHandler):
    # ⚠ **HTTP/1.1 = 连接复用（keep-alive）**，这不是"优化一下"，是现场内存问题的根子：
    #   http.server 默认 HTTP/1.0 —— 一问一答就把连接关掉。而运行态**写变量是每秒十几发**的
    #   （脚本定时写、点动、报警落盘…），一关一开等于：浏览器新开一个 TCP + 后端新起一个线程 +
    #   留一个 TIME_WAIT。实测：连续写 300 次变量 = 345 个 TIME_WAIT（一个请求一个连接）。
    #   跑一晚上几十万个连接的生死 → 浏览器网络服务与 Python 线程两边内存都被拖爆（6GB 那种）。
    #   开复用之后同样的 300 次写 = 1~2 个连接。
    #   前提（都满足了才敢开）：① 每个响应都带 Content-Length（_json/_html/_redirect、
    #   静态文件也带）；② 请求体**必须读完**（见 _body_bytes：没读完就 return 会把剩下的字节
    #   当成下一个请求，整条连接串包）；③ SSE 是长连接，显式 close（见 _sse）。
    protocol_version = "HTTP/1.1"

    # ⚠ 连接复用之后，一个 handler 线程会在一条连接上一直等下一个请求 ——
    #   `BaseHTTPRequestHandler.timeout` 默认是 None，也就是**无限等**。
    #   正常情况下浏览器会自己关掉空闲连接（每个源最多几只），没问题；但面板机睡下去了、
    #   网线/无线闪一下、浏览器被强杀 —— 这些"半开"连接永远不会发 FIN，
    #   于是那个线程 + socket + 缓冲区就一直挂在那儿，没人回收。跑几天下来线程只增不减。
    #   给个等待上限：30 秒没动静就收掉（SSE 不受影响，它每 ≤15 秒就写一次心跳）。
    timeout = 30

    _body_cache = None            # 本次请求的请求体（每个请求开头清一次，连接复用下实例是重用的）
    reqs = 0                      # 累计响应过多少个请求（诊断用，见 conns）

    # ⚠ 静态文件（css/js/index.html…）**一律从 ROOT 找**，不能靠"当前工作目录"。
    #   SimpleHTTPRequestHandler 默认按 cwd 找文件，源码方式跑时 cwd 正好是工程根目录
    #   （start_server.bat 里 `cd /d "%~dp0"`）—— 看着没事；但打包成 exe 装到
    #   Program Files 之后，进程的工作目录是"从哪儿启动的"，于是 js/main.js 全 404、
    #   页面一片白（窗口能开、接口正常，就是不显示——踩过一次，窗口自检才逮到）。
    def translate_path(self, path):
        saved = getattr(self, "directory", None)
        self.directory = str(ROOT)
        try:
            return super().translate_path(path)
        finally:
            self.directory = saved

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def handle_one_request(self):
        # 连接复用之后，一个 handler 实例会连着服务好几个请求 → 每个请求开头都要清缓存
        self._body_cache = None
        super().handle_one_request()

    # ── 工具 ──
    def _body_bytes(self) -> bytes:
        """请求体只读一次并缓存。
        ⚠ 连接复用（keep-alive）之后这是**正确性**要求：请求体没读完就提前 return
        （来源被拒 / 要管理员登录 / 限流…），剩下的字节会被当成下一个请求的请求行解析 ——
        整条连接从此串包。所以 do_GET / do_POST 一进来就先调它。"""
        if self._body_cache is None:
            n = int(self.headers.get("Content-Length") or 0)
            try:
                self._body_cache = self.rfile.read(n) if n > 0 else b""
            except Exception:                                    # noqa: BLE001
                self._body_cache = b""
        return self._body_cache

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        """只回显「自己人」的来源，绝不发 '*'。
        发 '*' 等于让任意网站都能读写这台机器上的变量 —— 接真 PLC 后就是
        「任何网页都能改设定值」的后门。"""
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _origin_allowed(self):
        """写请求的来源校验：
        · 没有 Origin（curl / 脚本 / 网关等非浏览器客户端）→ 放行
        · 本机来源（127.0.0.1 / localhost / [::1]）→ 放行
        · 与 Host 同源（同一台服务器托管的页面，含局域网 IP 访问）→ 放行
        · 其它（随便一个网页、DNS rebinding）→ 拒绝
        """
        if ALLOW_ANY_ORIGIN:
            return True
        host = _split_host(self.headers.get("Host"))
        # 用域名访问时一律按同源处理会留下 rebinding 口子 → 只认 IP 字面量/localhost
        if host and not (host.lower() == "localhost" or _is_local_host(host)):
            try:
                ipaddress.ip_address(host)
            except ValueError:
                return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            oh = urlparse(origin).hostname or ""
        except Exception:
            return False
        return _is_local_host(oh) or (host and oh.lower() == host.lower())

    def _body(self):
        raw = self._body_bytes()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _raw_body(self) -> str:
        """请求体原文（只读一次！登录页是表单提交，要先拿原文再决定按 JSON 还是 form 解）"""
        return self._body_bytes().decode("utf-8", "replace")

    # ── 登录 / 会话 ──
    def _cookies(self) -> dict:
        raw = self.headers.get("Cookie") or ""
        out = {}
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _logged_in(self) -> bool:
        if not auth.AUTH_ENABLED:
            return True
        return session_ok(self._cookies().get(SESSION_COOKIE))

    def _client_ip(self) -> str:
        return (self.client_address or ("", 0))[0] or "-"

    def _set_session_cookie(self, token: str, expired: bool = False):
        # HttpOnly：脚本偷不走；SameSite=Lax：别站点的跨站请求带不上（挡 CSRF）；
        # Max-Age：**必须是持久 cookie** —— 只给会话 cookie 的话，关掉浏览器/关掉
        # pywebview 窗口就没了，现场每次打开都要重新输密码（用户明确嫌这个烦）。
        c = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax"
        c += "; Max-Age=0" if expired else f"; Max-Age={SESSION_TTL}"
        self.send_header("Set-Cookie", c)

    def _redirect(self, to: str):
        self.send_response(302)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _html(self, text: str, status: int = 200):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _need_login(self, what: str = "这个操作"):
        """没登录就 401（前端据此弹登录）；返回 False 表示已经拦下"""
        if self._logged_in():
            return True
        self._json({"ok": False, "need_login": True,
                    "error": f"{what}需要管理员登录（浏览器打开 /login）"}, 401)
        return False

    def _serve_run_only(self):
        """运行页：index.html 原样发，只多两句
        · window.__HMI_RUN_ONLY__=true → 前端只跑运行态（没有编辑器、没有工具条、没有右键菜单）
        · window.__HMI_RUN_PATH__      → 「去运行画面」用哪个地址（/run，登录了也能看）"""
        f = ROOT / "index.html"
        try:
            html = f.read_text(encoding="utf-8")
        except Exception as e:                                  # noqa: BLE001
            return self._html(f"<h1>读不到 index.html：{e}</h1>", 500)
        html = html.replace("<title>WebHMI_设计器</title>", "<title>WebHMI_设计器 · 运行</title>", 1)
        html = html.replace(
            "<head>",
            "<head>\n<script>window.__HMI_RUN_ONLY__=true;"
            f"window.__HMI_RUN_PATH__={json.dumps(RUN_ALWAYS)};"
            f"window.__HMI_EDITOR_PATH__={json.dumps(EDITOR_PATH)};</script>", 1)
        self._html(html)

    def _serve_editor(self):
        """组态编辑器：index.html 原样发（+ 一句「运行页在哪」，编辑器里「去运行画面」要用）"""
        f = ROOT / "index.html"
        try:
            html = f.read_text(encoding="utf-8")
        except Exception as e:                                  # noqa: BLE001
            return self._html(f"<h1>读不到 index.html：{e}</h1>", 500)
        html = html.replace(
            "<head>",
            "<head>\n<script>"
            f"window.__HMI_RUN_PATH__={json.dumps(RUN_ALWAYS)};"
            f"window.__HMI_EDITOR_PATH__={json.dumps(EDITOR_PATH)};</script>", 1)
        self._html(html)

    def _serve_login_page(self):
        return self._html(login_page_html())

    def log_message(self, fmt, *args):
        pass  # 静默常规访问日志；API 打印见各分支

    def end_headers(self):
        # 零构建开发工具：HTML/JS/CSS 一律不缓存。
        # 缓存住旧 index.html 配新 JS，会出现「界面半边空白/面板全空」这种极难排查的问题。
        if not getattr(self, "_cache_header_sent", False):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        type(self).reqs += 1        # 每响应一个请求加一（诊断用，和 conns 一起看连接有没有复用）
        super().end_headers()

    # ── 路由 ──
    def do_OPTIONS(self):
        if not self._origin_allowed():
            return self._json({"ok": False, "error": "origin not allowed"}, 403)
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ── SSE ──
    def _sse(self):
        q = queue.Queue(maxsize=256)
        with _clients_lock:
            _clients.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self._cache_header_sent = True
        self.send_header("Cache-Control", "no-cache")
        # SSE 是**永不结束**的流：没有 Content-Length，只能靠"连接关闭"划边界。
        # 所以这条连接明确 close（后端协议已是 HTTP/1.1，不说清楚会被当成可复用的连接，
        # 处理完还想在同一条连接上读下一个请求）；它本来就是一条长连接，不参与复用。
        self.send_header("Connection", "close")
        self.close_connection = True
        self._cors()
        self.end_headers()
        print(f"[sse] 客户端接入（在线 {len(_clients)}）")
        try:
            # 先推一帧全量
            self.wfile.write(b"event: hello\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")   # 心跳
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _clients_lock:
                if q in _clients:
                    _clients.remove(q)
            print(f"[sse] 客户端断开（在线 {len(_clients)}）")

    # ── WebSocket ──
    def _serve_ws(self):
        """GET /api/ws（实现在模块级的 _ws_serve，见那里的说明）"""
        return _ws_serve(self)


class HMIServer(RoutesMixin, HMIHandlerBase):
    """HTTP 处理器。

    路由表（do_GET / do_POST）在 core/routes.py 的 RoutesMixin，**必须排在前面**：
    SimpleHTTPRequestHandler 自带 do_GET（静态文件），排在后面会把它盖掉、所有 /api/* 全 404。
    工具方法（_json / _body / _cors …）、静态页、SSE、WebSocket 入口在 HMIHandlerBase。
    """
