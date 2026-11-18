#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""broadcast.py — 广播扇出：一条消息发给所有在线前端

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

⚠ **V2 起只有一条通道：WebSocket 长连接。**
   1.x 这里是「SSE 队列 + 长连接」两条一起发；2.0 把 SSE 整个删了 ——
   订阅者名册只剩一份（长连接对象），broadcast() 少了一半分支和一次入队，
   也不用再管"哪个客户端的队列满了"（长连接自带发送队列上限 + 看门狗，
   读得慢的连接会被它自己收掉，见 wschannel.tick）。

**名册放在这一层**（而不是各层自己拿）是有意的：broadcast 是**下层**（设备轮询发现值变了）
就要调用的，而「订阅者是谁」属于推送这一层。名册放这儿，依赖方向就只有
「大家都 → broadcast」一条，不会绕成环（见 core/__init__.py 的依赖图）。
"""

import json
import threading

# 在线长连接：[wschannel.WSConn]（登记/注销在 wsbridge，这里只是名册）
_ws_clients = []

_ws_lock = threading.Lock()


def broadcast(payload: dict):
    """一条消息 = 发给所有在线前端。

    ⚠ JSON 只序列化**一次**，所有连接共用同一个字符串：
       变量多的时候每帧几 KB，按连接各 dumps 一遍是白烧 CPU。
    长连接那边不用"唤醒写线程"—— 它自己阻塞在发送队列上。"""
    text = json.dumps(payload, ensure_ascii=False)
    with _ws_lock:
        conns = list(_ws_clients)
    for c in conns:
        c.send(text)
