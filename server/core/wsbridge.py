#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wsbridge.py — 长连接服务端胶水（帧协议本身在 server/wschannel.py）

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

wschannel.py 只管「怎么收发帧」；这里管「这条连接用来干什么」：
变量推送、写值、设备状态推送、在线登记（谁在看运行画面）。
"""

from .broadcast import _ws_clients
from .broadcast import _ws_lock
from .datasource import _source_status
from .plcsource import _plc_cfg
from .varapi import read_all_vars
from .varapi import var_declare
from .varapi import var_write
from .versioninfo import SERVER_BUILD
from .versioninfo import SERVER_FEATURES

import json
import poll_gate                  # 同目录：有没有人在看运行画面（没人看就不跟设备通讯）
import threading
import time
import wschannel                  # 同目录：WebSocket 双向通道（RFC 6455，见 wschannel.py）


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



def _plc_cfg_for(authed: bool) -> dict:
    """当前连接能看到的 PLC 配置（与 GET /api/plc 同一套口径：口令只给登录过的管理员）"""
    cfg = dict(_plc_cfg)
    if not authed:
        cfg.pop("password", None)
        cfg["has_password"] = bool(_plc_cfg.get("password"))
    return cfg



def _ws_dispatch(conn, msg: dict):
    """处理一条前端发来的消息。

    协议（与 js/api/backend.js 对齐，全部是 JSON）：
      收 {t:'write',  id, name, value, internal?, from?}  写一个变量 → {t:'ack', id, ok, error?}
      收 {t:'writes', id, items:[…]}                      批量写（脚本一个周期写一堆）→ 逐条 ack
      收 {t:'vars',   id}                                 全量读 → {t:'ack', id, ok, vars}
      收 {t:'declare',id, variables?, active?}            下发变量表 / 采集范围 → {t:'ack', id, ok, …}
      收 {t:'poll',   id, on?, always?}                   「我在看运行画面」登记 → {t:'ack', id, ok, …}
      收 {t:'status', id, on?}                            订阅/退订设备状态推送
      收 {t:'ping',   id}                                 应用层探活 → {t:'pong', id}
    服务端主动发：
      {t:'hello', build, features, authed, cfg, status}    连上就先给一份现状
      {t:'status', status, ts}                             每秒一次设备状态
      {t:'ack', id, ok, …}                                 应答
      以及广播帧 {name,value} / {vars:{…}} / {alarm:…}（与 SSE 完全同格式，前端一套解析）
    """
    t = str(msg.get("t") or "")
    mid = msg.get("id")

    if t == "write":
        ok, extra = var_write(msg.get("name"), msg.get("value"),
                              bool(msg.get("internal")),
                              str(msg.get("from") or "") == "script")
        conn.send({"t": "ack", "id": mid, "ok": ok, **extra})
        return

    if t == "writes":
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
                                  str(it.get("from") or "") == "script")
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



def _ws_hello(conn):
    """刚连上先给一份现状：前端不用再发 3 个 HTTP 探路请求就能把界面画对"""
    conn.send({"t": "hello", "build": SERVER_BUILD, "features": SERVER_FEATURES,
               "authed": conn.authed, "cid": conn.cid,
               "cfg": _plc_cfg_for(conn.authed), "status": _source_status(),
               "status_ms": WS_STATUS_MS, "server_time": time.time()})



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
    authed = handler._logged_in()
    with _ws_lock:
        _ws_seq += 1
        cid = f"ws{_ws_seq}"
    conn = wschannel.handshake(handler, cid, authed=authed, remote=handler._client_ip())
    if conn is None:
        return
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
        # 在这个线程里等这条连接结束：HTTP handler 线程 = 这条连接的生命周期（和 _sse 一样）。
        # 收发两个线程都是 daemon，连接断了它们会自己退出（见 WSConn._finish）。
        # ⚠ 用事件等，**不要 while + sleep 轮询** —— 一条连接一个轮询线程，几个页面就是无谓的唤醒。
        conn.wait_closed()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        conn.kill("handler 退出")
