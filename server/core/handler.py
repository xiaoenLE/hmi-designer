#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""handler.py — HTTP 层：**只发静态文件、只开三个页面、外加一个 WebSocket 升级口**

★ V2 起 HTTP **不提供任何接口**（没有 /api/vars、没有 /api/health、没有 /api/events）。
   前后端之间的一切都走那条长连接，接口实现在 core/api.py。

HTTP 上只剩这几件事 —— **都是"浏览器拿页面"绕不过去的**，不是"还留了条后路"：

    GET /api/ws          WebSocket 升级（长连接握手本身就是一次 HTTP GET，协议如此）
    GET /                前端外壳 index.html
    GET /run             同上，但带「只跑运行态」标记（客户机地址）
    GET /login           登录页（页面里的 JS 自己开长连接去登录，见 core/loginpage.py）
    GET /css/* /js/* …   静态文件

为什么页面不能用长连接发：浏览器必须先用 HTTP 把 index.html + js + css 拿下来，
才谈得上跑 JS、才谈得上开 WebSocket。这是浏览器的加载模型，不是设计选择。

登录态怎么定：页面打开时自己也**不知道**登录没登录 —— 它连上长连接、
发一条 {t:'session'} 问一句，再决定显示编辑器还是运行画面。
所以这里不再按登录状态挑页面（1.x 那种"没登录给运行页、登录了给编辑器"的分支没了），
`/` 永远发同一个外壳，登录与否由长连接说了算。
"""

from . import auth
from .auth import session_ok
from .hostutil import _is_local_host
from .hostutil import _split_host
from .loginpage import login_page_html
from .paths import EDITOR_PATH
from .paths import ROOT
from .paths import RUN_ALWAYS
from .wsbridge import _ws_serve

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import ipaddress
import json
import re


ALLOW_ANY_ORIGIN = False  # --allow-any-origin 打开后跳过来源校验（默认关）


# ─────────────────────────────────────────────
#  HTTP Server
# ─────────────────────────────────────────────
class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """浏览器关页面/刷新/长连接断开都是正常现象，socketserver 默认会为每个这种连接
    打一整段 ConnectionAbortedError 栈 —— 刷屏之后真正的 PLC 报错反而看不见了。"""

    daemon_threads = True
    _QUIET = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, ConnectionError)

    # 累计接受过多少条 TCP 连接（诊断用：和 reqs 一起看，就知道连接有没有被复用）。
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


class HMIServer(SimpleHTTPRequestHandler):
    """静态文件 + 三个页面 + WebSocket 升级口。**没有任何 /api/* 接口。**

    ⚠ `protocol_version = "HTTP/1.1"`（连接复用）在这里依然重要，但理由和 1.x 不同：
      1.x 是为了"写变量每秒十几发"（那部分已经搬进长连接了）；现在只剩页面和静态文件
      —— 一个页面要拿 70 多个 js/css，不复用就是 70 几次 TCP 三次握手。
    """

    protocol_version = "HTTP/1.1"

    # 空闲连接的等待上限：30 秒没动静就收掉。
    # `BaseHTTPRequestHandler.timeout` 默认是 None（无限等）—— 面板机睡下去了、网线闪一下，
    # 那些"半开"连接永远不会发 FIN，线程 + socket 就一直挂着，跑几天只增不减。
    timeout = 30

    _body_cache = None            # 本次请求的请求体（连接复用下实例是重用的）
    reqs = 0                      # 累计响应过多少个请求（诊断用，见 conns）

    # ⚠ 静态文件（css/js/index.html…）**一律从 ROOT 找**，不能靠"当前工作目录"：
    #   打包成 exe 装到 Program Files 之后，进程的工作目录是"从哪儿启动的"，
    #   按 cwd 找的话 js/main.js 全 404、页面一片白（踩过一次）。
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
        """请求体读掉（缓存）。
        ⚠ 连接复用下这是**正确性**要求：请求体不读完就提前 return，剩下的字节会被当成
        下一个请求的请求行解析 —— 整条连接从此串包。所以 do_GET 一进来就先调它。"""
        if self._body_cache is None:
            n = int(self.headers.get("Content-Length") or 0)
            try:
                self._body_cache = self.rfile.read(n) if n > 0 else b""
            except Exception:                                    # noqa: BLE001
                self._body_cache = b""
        return self._body_cache

    def _json(self, obj, status=200):
        """只在**出错**时用（比如"这不是 WebSocket 升级请求"）。正常业务数据不走 HTTP。"""
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, text: str, status: int = 200):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _origin_allowed(self):
        """来源校验（只用于 WebSocket 握手：这条连接能直接改 PLC 变量，
        不能让随便一个网页连上来）。
        · 没有 Origin（curl / 脚本 / 非浏览器客户端）→ 放行
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
        except Exception:                                        # noqa: BLE001
            return False
        return _is_local_host(oh) or (host and oh.lower() == host.lower())

    def _redirect(self, to: str):
        """老地址跳一下（只有 /edit → / 用到）"""
        self.send_response(302)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _cookies(self) -> dict:
        raw = self.headers.get("Cookie") or ""
        out = {}
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _logged_in(self) -> bool:
        """这个请求带没带管理员会话。
        只给 WebSocket 握手用：连上来时如果浏览器有 /login 种下的 Cookie（或 URL 上的
        ?token=，见 wsbridge），这条连接就算已登录。页面本身不再按登录态分岔。"""
        if not auth.AUTH_ENABLED:
            return True
        return session_ok(self._cookies().get(auth.SESSION_COOKIE))

    def _client_ip(self) -> str:
        return (self.client_address or ("", 0))[0] or "-"

    def _serve_shell(self, run_only: bool):
        """发前端外壳 index.html。

        ⚠ 不按登录态挑页面：页面自己也**不知道**登录没登录 —— 它连上长连接、
          发 {t:'session'} 问一句再决定显示编辑器还是运行画面（见 js/main.js）。
          所以 `/` 和 `/run` 的区别只有一句「只跑运行态」。
        """
        f = ROOT / "index.html"
        try:
            html = f.read_text(encoding="utf-8")
        except Exception as e:                                  # noqa: BLE001
            return self._html(f"<h1>读不到 index.html：{e}</h1>", 500)
        if run_only:
            html = html.replace("<title>WebHMI_设计器</title>",
                                "<title>WebHMI_设计器 · 运行</title>", 1)
        inject = ("<script>"
                  + (f"window.__HMI_RUN_ONLY__=true;" if run_only else "")
                  + f"window.__HMI_RUN_PATH__={json.dumps(RUN_ALWAYS)};"
                  + f"window.__HMI_EDITOR_PATH__={json.dumps(EDITOR_PATH)};"
                  + "</script>")
        html = html.replace("<head>", "<head>\n" + inject, 1)
        self._html(html)

    def log_message(self, fmt, *args):
        pass  # 静默常规访问日志（静态文件太多，打出来反而看不见真问题）

    def _serve_ws(self):
        """GET /api/ws：升级成长连接（实现在 core/wsbridge.py 的 _ws_serve，见那里的说明）

        ⚠ 这是前端**唯一**的数据通道：变量读写、设备状态、在线登记、以及所有接口的调用
          （{t:'call'} → core/api.py）都在这一条连接上。
        """
        return _ws_serve(self)

    def end_headers(self):
        # 零构建开发工具：HTML/JS/CSS 一律不缓存。
        # 缓存住旧 index.html 配新 JS，会出现「界面半边空白/面板全空」这种极难排查的问题。
        if not getattr(self, "_cache_header_sent", False):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        type(self).reqs += 1
        super().end_headers()

    # ── 路由（只有四条，见模块开头）──
    def do_OPTIONS(self):
        # 没有跨站接口了：只回一句"不允许"，别让外部网页以为这儿能调
        self._json({"ok": False, "error": "no CORS API here"}, 403)

    def do_POST(self):
        # 一个 POST 接口都没有了（登录也走长连接）。请求体读掉再回，免得连接串包。
        self._body_bytes()
        self._json({"ok": False, "error": f"后端没有 POST 接口（V2 起只走 WebSocket）：{self.path}"}, 404)

    def do_GET(self):
        self._body_bytes()          # 连接复用下请求体必须读完（见 _body_bytes 的说明）
        # 路径归一：//、/run/ 都认（现场手敲地址经常多一个斜杠）
        path = re.sub(r"/{2,}", "/", (self.path or "/").split("?")[0])
        p = path.rstrip("/") or "/"

        if p == "/api/ws":
            # ★ 唯一的数据通道。⚠ 这个调用会一直阻塞到连接断开，期间这个 handler 线程
            #   就归这条连接了。
            return self._serve_ws()
        if p == "/login":
            return self._html(login_page_html())
        if p == RUN_ALWAYS:                       # /run：客户机地址，只跑运行态
            return self._serve_shell(run_only=True)
        if p == "/edit":                          # 老地址兼容（那会儿编辑器在 /edit）
            return self._redirect("/")
        if p in ("/", "/index.html"):
            return self._serve_shell(run_only=False)
        if p.startswith("/api/"):
            # 曾经的接口全删了，但现场/脚本可能还在打 —— 给一句明确的话，
            # 而不是一个莫名其妙的 404 静态文件页
            return self._json({"ok": False, "error":
                               f"V2 起后端没有 HTTP 接口了（{path}）；"
                               "所有数据都走 WebSocket 长连接（/api/ws）"}, 404)
        return super().do_GET()                   # 静态文件（css / js / favicon …）
