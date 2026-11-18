#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""poll_gate.py — 「有没有人在看运行画面」这个闸门：决定后端要不要跟 PLC/设备通讯。

现场要求（原话）：「不在运行时应该不需要和其他设备通讯」。
编辑器里改画面/变量、或者根本没人打开运行页面时，后端不该一直轮询设备 ——
既占着通讯口（可能和编程软件抢），又白白给 PLC 增加负载。

做法：
  · 运行页面（编辑器的「运行预览」、客户页 `/run`）**连上长连接就算登记**（接进来登记、
    断开自动注销，后端每秒给连着的那几条续命）—— 2.0 起不再靠前端每 10 秒发心跳；
  · 退出运行态 / 页面关掉 / 连接断掉 → 这条登记就没了；
  · 后端只要还有「新鲜的」登记就照常轮询；一条都没有就**停**：不读数、连 `_connect()`
    都不调 —— 一个字节都不发。
  · 现场调试想「不管有没有人看都一直采」：`--poll-always` 或 `HMI_POLL_ALWAYS=1`，
    也可以运行时在长连接上发 `{t:'poll', always:true}`（2.0 没有 `POST /api/poll` 了）。
"""
import threading
import time

IDLE_S = 30.0                      # 心跳超时：这么久没动静就当那个页面已经没了
_runners = {}                      # client id -> 最后一次心跳时间
_lock = threading.RLock()
_always = False                    # True = 不管有没有人看都一直采（现场调试用）


def set_always(on):
    global _always
    with _lock:
        _always = bool(on)
    return _always


def is_always():
    with _lock:
        return _always


def set_runner(cid, on):
    """登记 / 注销一个「正在看运行画面」的客户端（心跳也用 on=True 再调一次）"""
    cid = str(cid or "")
    if not cid:
        return
    with _lock:
        if on:
            _runners[cid] = time.time()
        else:
            _runners.pop(cid, None)


def wanted():
    """现在该不该跟设备通讯"""
    if is_always():
        return True
    now = time.time()
    with _lock:
        for k, t in list(_runners.items()):
            if now - t > IDLE_S:
                del _runners[k]
        return bool(_runners)


def status():
    now = time.time()
    with _lock:
        alive = [k for k, t in _runners.items() if now - t <= IDLE_S]
        return {"paused": not (_always or alive), "running_clients": len(alive),
                "always": _always, "idle_s": IDLE_S}
