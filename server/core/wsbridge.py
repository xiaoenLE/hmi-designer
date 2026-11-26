#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wsbridge.py — 长连接服务端胶水（帧协议本身在 server/wschannel.py）

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

wschannel.py 只管「怎么收发帧」；这里管「这条连接用来干什么」：
变量推送、写值、设备状态推送、在线登记（谁在看运行画面），
以及 ★V2 起新增的**通用调接口通道**（{t:'call'} → core/api.py）和长连接上的登录。

⚠ V2 的定位：前端**只走这一条连接**。所以但凡是前端要做的事，都得能从这儿进：
  热路径（写值/读变量/设备状态）走专有消息类型；其余接口走 {t:'call'} 进 core/api.py
  —— 那是**所有接口的唯一实现**，不存在第二份。
"""

from . import ai
from . import api
from . import auth
from .broadcast import _ws_clients
from .broadcast import _ws_lock
from .datasource import _source_status
from .opcualib import opcua
from .paths import DATA_DIR
from .plcsource import _plc_cfg
from .updateapply import UPDATE_ARCHIVE_URL
from .updateapply import is_applying
from .varapi import read_all_vars
from .varapi import var_declare
from .varapi import var_write
from .users import STORE as USERS      # 多用户账号表：账号登录 / 角色闸门（见 core/users.py）
from .versioninfo import SERVER_BUILD
from .versioninfo import SERVER_FEATURES
from .versioninfo import _local_version
from . import updateapply

import json
import os
import poll_gate                  # 同目录：有没有人在看运行画面（没人看就不跟设备通讯）
import re
import threading
import time
import updater                   # 同目录：读取上次更新的落地结果（_update/status.json）
import wschannel                  # 同目录：WebSocket 双向通道（RFC 6455，见 wschannel.py）
from urllib.parse import parse_qs, urlparse


_ws_seq = 0

_ws_beat = None            # 心跳/状态推送线程

_ws_beat_lock = threading.Lock()

WS_STATUS_MS = 1000        # 设备状态推送间隔（原来是前端每 3 秒 GET /api/plc 问一次）



def _ws_alive():
    with _ws_lock:
        return [c for c in _ws_clients if c.alive]



def _ws_beat_loop():
    """WebSocket 心跳 + 状态推送：**一个线程管所有连接**，每 1 秒跑一次。

    为什么不做成「每条连接一个定时器」：连接数不多但一个全局心跳更好推理 ——
    而且「登记过 poll 的连接由连接本身续命」和「PING 判死」都要在这里统一做。

    它干的四件事：
      1. 给登记过「我在看运行画面」的连接续命（前端从此不用每 10 秒 POST /api/poll）；
      2. conn.tick()：发协议级 ping、把心跳超时的连接收掉；
      3. 把设备状态推给订阅了的连接（前端从此不用每 3 秒 GET /api/plc）；
      4. 一个连接都没有了就自己退出 —— 没人连的时候后端不该空转（下次有人连再起）。
    """
    global _ws_beat
    while True:
        time.sleep(WS_STATUS_MS / 1000.0)
        with _ws_lock:
            conns = list(_ws_clients)
        if not conns:
            with _ws_beat_lock:
                _ws_beat = None
            return
        now = time.time()
        try:
            st = _source_status()
        except Exception:                                          # noqa: BLE001
            st = {}
        live = [c for c in conns if c.alive]
        # 状态帧只序列化一次（所有连接的负载完全一样）
        status_text = json.dumps({"t": "status", "status": st, "ts": now}, ensure_ascii=False) if st else ""
        for c in live:
            if c.info.get("poll"):
                # 续命：连接还在 = 人还在看画面。断了 on_close 会注销，不用等超时。
                poll_gate.set_runner(c.cid, True)
            c.tick(now)
            if status_text and c.info.get("status"):
                c.send(status_text)



def _ws_beat_ensure():
    """确保心跳线程在跑（第一次有人连上来时启动）"""
    global _ws_beat
    with _ws_beat_lock:
        if _ws_beat is None or not _ws_beat.is_alive():
            _ws_beat = threading.Thread(target=_ws_beat_loop, name="ws-beat", daemon=True)
            _ws_beat.start()



ROLE_NAMES = ("admin", "operator", "viewer")     # viewer 已取消，但老会话还会带着它

# 写变量被拒时按角色给一句人话（口径：操作员这次也只能改设备连接）
_WRITE_DENY = {
    "operator": "当前账号（操作员）只能改设备连接，不能写变量",
    "viewer": "当前账号（观察员）只能看，不能写变量",
}


def conn_role(conn) -> str:
    """这条连接现在是什么角色：'' = 没登录；老会话/没角色字段 = 管理员（升级兼容）。

    ⚠ 用 auth.AUTH_ENABLED 判断（不能 from ... import AUTH_ENABLED 拿副本）：
      --no-auth 时没有"没登录"这回事，一切按管理员。
    """
    if not auth.AUTH_ENABLED:
        return "admin"
    if not getattr(conn, "authed", False):
        return ""
    role = str(getattr(conn, "role", "") or "").lower()
    return role if role in ROLE_NAMES else "admin"


def write_denied(conn, mid):
    """写变量（热路径）的权限闸门：操作员/观察员一律拒 —— 返回要回给前端的 ack，None = 放行。

    没登录的客户机运行页照旧能写（现场既有规矩）；管理员能写。
    """
    role = conn_role(conn)
    msg = _WRITE_DENY.get(role)
    if not msg:
        return None
    return {"t": "ack", "id": mid, "ok": False, "role": role, "error": msg}


def _plc_cfg_for(authed: bool = False, role: str = "") -> dict:
    """当前连接能看到的 PLC 配置。

    ⚠ **设备连接不设闸门**（2.1.4 现场口径，见 core/api.py 的 DEVICE_PATHS）：
      运行页按 Ctrl+Shift+L 就能直接改连接，所以口令也一并给 —— 对话框里口令留空
      再点「确定」会被当成"清空口令"，不给看就等于改个 IP 就把口令抹了。
      authed/role 只为调用点兼容留着，已经不参与判断。"""
    return dict(_plc_cfg)



def _ws_dispatch(conn, msg: dict):
    """处理一条前端发来的消息。

    协议（与 js/api/backend.js 对齐，全部是 JSON）：
      ── 热路径（每帧都很小，走专有的消息类型，不走 rpc）──
      收 {t:'write',  id, name, value, internal?, from?}  写一个变量 → {t:'ack', id, ok, error?}
      收 {t:'writes', id, items:[…]}                      批量写（脚本一个周期写一堆）→ 逐条 ack
      收 {t:'vars',   id}                                 全量读 → {t:'ack', id, ok, vars}
      收 {t:'declare',id, variables?, active?}            下发变量表 / 采集范围 → {t:'ack', id, ok, …}
      收 {t:'poll',   id, on?, always?}                   「我在看运行画面」登记 → {t:'ack', id, ok, …}
      收 {t:'status', id, on?}                            订阅/退订设备状态推送
      收 {t:'ping',   id}                                 应用层探活 → {t:'pong', id}
      ── 其余接口（V2：前端不发 HTTP 了，全从这儿进）──
      收 {t:'call',   id, path, method?, body?}           调一个 /api/* 接口 → {t:'ack', id, ok, status, data}
                                                          （后端只有一套实现，见 core/api.py）
      收 {t:'ai',     op:'chat'|'cancel', id, body?}       AI 助手（流式）→ ai_delta / ai_tool / ai_done / ai_error
                                                           （实现在 core/ai.py；**工作线程**里跑，不占读线程）
      收 {t:'login',  id, password}                       管理员登录 → {t:'ack', id, ok, token?}
      收 {t:'logout', id}                                 注销 → {t:'ack', id, ok}
      收 {t:'session',id}                                 现在登录着没 → {t:'ack', id, ok, auth_enabled, logged_in}
    服务端主动发：
      {t:'hello', build, features, authed, cfg, status}    连上就先给一份现状
      {t:'status', status, ts}                             每秒一次设备状态
      {t:'ack', id, ok, …}                                 应答
      以及广播帧 {name,value} / {vars:{…}} / {alarm:…}
    """
    t = str(msg.get("t") or "")
    mid = msg.get("id")

    if t == "ai":
        # AI 助手（见 core/ai.py，协议见 docs/ai-assistant.md §3）。
        # ★ ai.handle() 只做校验 + 起工作线程就返回：这条 dispatch 是**读线程**上的同步调用，
        #   在这儿同步等模型 = 整条连接收不了帧（前端表现为整个编辑器卡住）。所以必须是 ai 帧
        #   自己起线程、结果用 ai_delta/ai_tool/ai_done/ai_error 帧异步推。
        ai.handle(conn, msg)
        return

    if t == "call":
        # 通用「调一个接口」：把 path/method/body 交给 core/api.py（后端**唯一**的实现），
        # 结果原样回过去。V2 里 HTTP 已经没有接口了，所以这里是唯一的入口。
        path = str(msg.get("path") or "")
        method = str(msg.get("method") or "POST").upper()
        body = msg.get("body")
        if not isinstance(body, dict):
            body = {}
        # path 允许带 query（如 '/api/scriptlog?date=…&limit=50'）
        raw_path, _, raw_q = path.partition("?")
        clean = re.sub(r"/{2,}", "/", raw_path or "/").rstrip("/") or "/"
        try:
            query = parse_qs(raw_q)
        except Exception:                                          # noqa: BLE001
            query = {}
        ctx = api.Ctx(authed=conn.authed, client_ip=getattr(conn, "remote", "") or "-",
                      server_host=getattr(conn, "server_host", "127.0.0.1"),
                      server_port=getattr(conn, "server_port", 8866),
                      role=conn_role(conn), user=getattr(conn, "user", "") or "")
        status, data = api.dispatch(method, clean, query, body, ctx)
        conn.send({"t": "ack", "id": mid, "ok": 200 <= status < 300, "status": status, "data": data})
        return

    if t == "login":
        # 长连接上的登录（运行页按 Ctrl+Shift+E 那种，页面不跳转）。
        # 两种方式并存（口径见 core/users.py 的说明）：
        #   {t:'login', password}               → 内置管理员密码（= admin 角色，老前端照旧能用）
        #   {t:'login', user, password}         → 账号表里的账号 → 角色由账号决定
        # 成功 → 这条连接算登录了；同时给一个 token 让前端存起来，刷新页面还能接上
        # （HTTP 那套 Cookie 也能用 —— /login 页面走的是它，两条路并存，互相不冲突）。
        ip = getattr(conn, "remote", "") or ""
        wait = auth.login_blocked(ip)
        if wait:
            conn.send({"t": "ack", "id": mid, "ok": False,
                       "error": f"密码试错太多次，等 {wait} 秒再试"})
            return
        uname = str(msg.get("user") or "").strip()
        pw = msg.get("password")
        if uname:
            role = USERS.verify(uname, pw)          # 不存在 / 密码错 / 禁用 → None
            if not role:
                auth.note_login_fail(ip)
                print(f"[auth] 账号登录失败（{ip}，{uname}）")
                conn.send({"t": "ack", "id": mid, "ok": False, "error": "账号或密码不对（账号不存在 / 密码错 / 已禁用）"})
                return
            who = f"{uname}（{role}）"
        else:
            if not auth.check_password(pw):
                auth.note_login_fail(ip)
                print(f"[auth] 长连接上登录失败（{ip}）")
                conn.send({"t": "ack", "id": mid, "ok": False, "error": "密码不对"})
                return
            uname, role, who = "admin", "admin", "管理员（密码）"
        conn.authed = True
        conn.user = uname
        conn.role = role
        token = auth.new_session(user=uname, role=role)
        print(f"[auth] {who} 已登录（{ip}，长连接）")
        conn.send({"t": "ack", "id": mid, "ok": True, "logged_in": True,
                   "token": token, "role": role, "user": uname})
        return

    if t == "logout":
        conn.authed = False
        conn.user = ""
        conn.role = ""
        tok = msg.get("token")
        if tok:
            auth.drop_session(tok)
        conn.send({"t": "ack", "id": mid, "ok": True, "logged_in": False})
        return

    if t == "session":
        conn.send({"t": "ack", "id": mid, "ok": True,
                   "auth_enabled": bool(auth.AUTH_ENABLED), "logged_in": bool(conn.authed),
                   "role": conn_role(conn), "user": getattr(conn, "user", "") or ""})
        return

    if t == "write":
        deny = write_denied(conn, mid)
        if deny:
            conn.send(deny)
            return
        ok, extra = var_write(msg.get("name"), msg.get("value"),
                              bool(msg.get("internal")),
                              str(msg.get("from") or "") == "script",
                              actor=getattr(conn, "user", "") or "")
        conn.send({"t": "ack", "id": mid, "ok": ok, **extra})
        return

    if t == "writes":
        deny = write_denied(conn, mid)
        if deny:
            conn.send(deny)
            return
        items = msg.get("items")
        if not isinstance(items, list):
            conn.send({"t": "ack", "id": mid, "ok": False, "error": "items must be a list"})
            return
        # 脚本一个周期可能写十几个变量：一次收完、逐个写、一次性把结果回过去
        results = []
        for it in items[:512]:                    # 上限：一条消息不能变成无界工作
            if not isinstance(it, dict):
                results.append({"ok": False, "error": "bad item"})
                continue
            ok, extra = var_write(it.get("name"), it.get("value"),
                                  bool(it.get("internal")),
                                  str(it.get("from") or "") == "script",
                                  actor=getattr(conn, "user", "") or "")
            results.append({"ok": ok, **extra})
        conn.send({"t": "ack", "id": mid, "ok": all(r.get("ok") for r in results), "results": results})
        return

    if t == "vars":
        conn.send({"t": "ack", "id": mid, "ok": True, "vars": read_all_vars()})
        return

    if t == "declare":
        ok, extra = var_declare(msg.get("variables"), msg.get("active"))
        conn.send({"t": "ack", "id": mid, "ok": ok, **extra})
        return

    if t == "poll":
        if "always" in msg:
            poll_gate.set_always(bool(msg.get("always")))
        on = bool(msg.get("on"))
        conn.info["poll"] = on
        poll_gate.set_runner(conn.cid, on)
        conn.send({"t": "ack", "id": mid, "ok": True, **poll_gate.status()})
        return

    if t == "status":
        conn.info["status"] = bool(msg.get("on", True))
        st = _source_status()
        conn.send({"t": "ack", "id": mid, "ok": True, "status": st})
        return

    if t == "ping":
        conn.send({"t": "pong", "id": mid})
        return

    conn.send({"t": "ack", "id": mid, "ok": False, "error": f"不认识的消息类型：{t}"})



def _ws_diag(conn):
    """hello 里的**诊断段**（现场排查"怎么越来越慢"用的）。

    ★ 以前这些数在 `GET /api/health` 里；2.0 没有那个接口了，挪到 hello。

    怎么读这几个数：
      · `reqs`：**正常应该一动不动** —— 2.0 的 HTTP 只剩静态文件和这个升级请求。
        还在涨就说明有东西在偷偷发 HTTP（旧前端 / 中间加了反代 / 有别的程序在轮询）。
      · `conns`：累计接受过多少条 TCP 连接。每个页面正常 1 条左右；一直在涨说明前端在反复重连。
      · `clients` / `detail`：现在挂着几条长连接、每条收发了多少帧、空闲多久、发队列积了多少。
        （`detail` 里有对端地址，**只发给登录过的连接**。）
    """
    live = _ws_alive()
    out = {"clients": len(live),
           "reqs": int(getattr(getattr(conn, "handler_cls", None), "reqs", 0) or 0),
           "conns": int(getattr(getattr(conn, "handler_cls", None), "conns", 0) or 0)}
    if getattr(conn, "authed", False):
        try:
            out["detail"] = [c.stats() for c in live]
        except Exception:                                              # noqa: BLE001
            out["detail"] = []
    return out


def _ws_hello(conn):
    """刚连上先给一份现状。

    ★ V2 起这一帧要**顶掉以前的 `GET /api/health`**：前端不发 HTTP 了，
    "后端是哪个版本、有哪些能力、OPC UA 能不能用、现在登录着没、设备什么状态、
    连接配置是什么"全得在这儿一次说清（字段与 /api/health 对齐，前端只认一份口径）。
    """
    st = _source_status()
    conn.send({
        "t": "hello", "ok": True, "name": "hmi-server",
        "build": SERVER_BUILD, "features": SERVER_FEATURES,
        "authed": bool(conn.authed), "cid": conn.cid,
        "cfg": _plc_cfg_for(), "status": st, "plc": st,
        "vars": len(read_all_vars()),
        # 版本与"上次更新成没成"：状态栏要显示「这台上是哪个版本」
        "version": dict(_local_version(), build=SERVER_BUILD),
        "update": {"applying": bool(updateapply.is_applying()),
                   "enabled": bool(UPDATE_ARCHIVE_URL),
                   "last": updater.read_state(DATA_DIR, "status.json")},
        # OPC UA 靠第三方库 asyncua，缺了要能当场说明白（而不是连接时莫名失败）
        "opcua": {"available": bool(opcua is not None and opcua.AVAILABLE),
                  "import_error": (getattr(opcua, "IMPORT_ERROR", "") if opcua else "模块加载失败"),
                  "install": (getattr(opcua, "INSTALL_HINT", "") if opcua else ""),
                  "default_ns": (getattr(opcua, "DEFAULT_NS", 4) if opcua else 4)},
        "auth": {"enabled": bool(auth.AUTH_ENABLED), "logged_in": bool(conn.authed),
                 "role": conn_role(conn), "user": getattr(conn, "user", "") or ""},
        # AI 助手：只给"能不能用（开关 / 有没有 key）+ 用的哪个模型"，地址和 key 一律不下发。
        # 前端据此决定「AI」按钮亮不亮 / 按了先弹设置（见 core/ai.py 的 brief()）。
        "ai": ai.brief(),
        # 桌面 EXE 开启 --mcp-live 时，把 WebView2 调试端口告知本机 MCP；
        # 未开启时为空，普通浏览器 / 服务模式不暴露调试入口。
        "desktop": {"mcp_cdp_port": int(os.environ.get("HMI_MCP_CDP_PORT") or 0) or None},
        "status_ms": WS_STATUS_MS, "server_time": time.time(),
        # 诊断：连接数 + 每条连接的收发帧数/空闲秒数 + HTTP 那两个计数器（见 _ws_diag）
        "ws": _ws_diag(conn),
    })



def _ws_on_message(conn, msg):
    try:
        _ws_dispatch(conn, msg)
    except Exception as e:                                         # noqa: BLE001
        # 单条消息处理失败不能拉断连接（断开重连会让前端反复补全量，反而更糟）
        print(f"[ws] 消息处理异常（连接保留）：{e}")
        try:
            conn.send({"t": "ack", "id": msg.get("id"), "ok": False, "error": str(e)})
        except Exception:                                          # noqa: BLE001
            pass



def _ws_on_close(conn):
    """连接断了：把它的「我在看运行画面」登记注销掉。

    这一步以前是前端 `sendBeacon` 干的（关页面时发一次）；现在连接本身就是登记，
    断了自动就没了 —— 少一个请求，也少一个「页面被强杀所以没发出去」的漏子。"""
    with _ws_lock:
        if conn in _ws_clients:
            _ws_clients.remove(conn)
    if conn.info.get("poll"):
        poll_gate.set_runner(conn.cid, False)
    print(f"[ws] 客户端断开（在线 {len(_ws_alive())}）")



def _ws_serve(handler):
    """GET /api/ws：升级成 WebSocket 并进入这条连接的生命周期（阻塞到断开）。

    写成模块级函数、由 HMIServer._serve_ws 转调：它和 HTTP handler 的其它方法关系不大，
    放在类里只会让那个已经很长的类更难读。
    """
    global _ws_seq
    # 与写接口同一套来源校验：这条连接能直接改 PLC 变量，不能让任意网页连上来
    if not handler._origin_allowed():
        print(f"[block] 拒绝来源不明的 WebSocket Origin={handler.headers.get('Origin')}")
        return handler._json({"ok": False, "error": "origin not allowed"}, 403)
    if not wschannel.is_ws_request(handler):
        return handler._json({"ok": False, "error": "这个地址是 WebSocket 通道，"
                                                   "要用 Upgrade: websocket 请求"}, 400)
    # 登录态：① 浏览器带来的会话 Cookie（走过 /login 页面的就是这条）
    #         ② URL 上带的 ?token=（长连接上登录成功后前端存的，刷新页面还能接上）
    # 两条都认，所以"在运行页登录过"和"在登录页登录过"效果一样。
    # 会话里带着 {user, role}（见 auth.session_claims）—— 重连之后角色也跟着回来。
    tok, claims = "", {}
    try:
        q = parse_qs(urlparse(handler.path).query)
        tok = (q.get("token") or [""])[0]
    except Exception:                                              # noqa: BLE001
        tok = ""
    if not tok:
        try:
            tok = (handler._cookies() or {}).get(auth.SESSION_COOKIE) or ""
        except Exception:                                          # noqa: BLE001
            tok = ""
    if tok:
        claims = auth.session_claims(tok) or {}
    authed = handler._logged_in() or bool(claims)
    with _ws_lock:
        _ws_seq += 1
        cid = f"ws{_ws_seq}"
    conn = wschannel.handshake(handler, cid, authed=authed, remote=handler._client_ip())
    if conn is None:
        return
    # 握手带过来的会话：把用户/角色也挂到这条连接上（否则重连之后只剩"登录过"，
    # admin 路径又会按老口径当管理员 —— 观察员重连就变成管理员了，必须跟着令牌走）
    if claims:
        conn.user = str(claims.get("user") or "")
        conn.role = str(claims.get("role") or "admin")
    # 交给长连接的三样东西：
    #  · handler_cls —— 留着给需要 handler 的地方（目前只有诊断用）
    #  · host —— 来源校验/同源判断要用
    #  · server_host/port —— 「立即更新」要告诉重启助手"新实例该在哪个端口上起来"
    conn.handler_cls = type(handler)
    conn.host = handler.headers.get("Host") or "127.0.0.1"
    try:
        sa = handler.server.server_address
        conn.server_host, conn.server_port = str(sa[0]), int(sa[1])
    except Exception:                                              # noqa: BLE001
        conn.server_host, conn.server_port = "127.0.0.1", 8866
    conn.on_message = _ws_on_message
    conn.on_close = _ws_on_close
    with _ws_lock:
        _ws_clients.append(conn)
    print(f"[ws] 客户端接入（在线 {len(_ws_clients)}；"
          f"{'已登录' if authed else '未登录'} {conn.remote}）")
    _ws_beat_ensure()
    try:
        _ws_hello(conn)
        conn.start()
        # 在这个线程里等这条连接结束：HTTP handler 线程 = 这条连接的生命周期。
        # 收发两个线程都是 daemon，连接断了它们会自己退出（见 WSConn._finish）。
        # ⚠ 用事件等，**不要 while + sleep 轮询** —— 一条连接一个轮询线程，几个页面就是无谓的唤醒。
        conn.wait_closed()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        conn.kill("handler 退出")
