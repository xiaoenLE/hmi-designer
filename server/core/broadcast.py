#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""broadcast.py — 广播扇出：一条消息发给所有在线前端

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

两条通道（SSE 与长连接）走同一个 broadcast()，所以
「HTTP 写一个值、长连接那边也收得到」是天然成立的。
**订阅者名册也放在这儿**（而不是各层自己拿）：broadcast 是下层就要调的，
名册放这儿，依赖就只有「大家都 → broadcast」一个方向，不会成环。
"""

import json
import queue
import threading


# ─────────────────────────────────────────────
#  SSE 广播通道
# ─────────────────────────────────────────────
_clients = []          # [queue.Queue]

_clients_lock = threading.Lock()


def broadcast(payload: dict):
    """一条消息 = 发给所有在线前端（SSE 和 WebSocket 两条通道都发）。

    ⚠ JSON 只序列化**一次**：以前在 SSE 的循环里逐个 put，变量多的时候每帧都要
    重新 dumps 一遍（几 KB × N 个客户端）。现在两个通道共用同一个字符串。
    WebSocket 那边不用唤醒写线程 —— 它是自己阻塞在队列上的。"""
    text = json.dumps(payload, ensure_ascii=False)
    with _clients_lock:
        for q in _clients:
            try:
                q.put_nowait(text)
            except queue.Full:
                pass
    with _ws_lock:
        conns = list(_ws_clients)
    for c in conns:
        c.send(text)



# ─────────────────────────────────────────────
#  WebSocket 双向通道（见 wschannel.py 开头的说明）
# ─────────────────────────────────────────────
_ws_clients = []           # [wschannel.WSConn]

_ws_lock = threading.Lock()
