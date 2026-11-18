#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hostutil.py — host 判定 / 端口探测 / **服务探活**

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

端口探测用「连一下」而不是 bind：Windows 上有个坑 ——
被别的进程占着但没在监听的端口，bind 是成功的，于是「没占用」会误判。

★ V2 起探活不再打 HTTP 接口（那些接口全没了），改成**开一次长连接、读 hello**：
  既能认出"这是不是我们的服务"，又能顺手拿到版本号（更新助手要用它核对新版起没起来），
  而且比以前的 HTTP 探活更实在 —— 它证明的是"应用活着、长连接能通"，
  不只是"有个东西在监听端口"。
"""

import base64
import ipaddress
import json
import os
import socket
import struct


def _split_host(h: str) -> str:
    """从 Host / Origin 里取主机名（兼容 127.0.0.1:8866 与 [::1]:8866）"""
    h = (h or "").strip()
    if h.startswith("["):
        return h[1:h.find("]")] if "]" in h else h
    return h.rsplit(":", 1)[0] if ":" in h else h


def _is_local_host(host: str) -> bool:
    host = (host or "").lower()
    if host in ("localhost", "::1", "127.0.0.1"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _port_in_use(host: str, port: int) -> bool:
    """探测端口是否已有服务在监听。
    不能只靠 bind 失败来判断：Windows 上 SO_REUSEADDR 允许两个进程绑同一端口，
    重复双击启动会悄悄跑起第二个实例。"""
    probe = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.4)
            return s.connect_ex((probe, port)) == 0
    except OSError:
        return False


def probe_service(port: int, host: str = "127.0.0.1", timeout: float = 1.5):
    """开一次长连接、读回 hello → 返回那个 dict；不是我们的服务 / 连不上 → None

    这是 V2 的**唯一探活方式**（HTTP 接口已经没有了）。用它认名字、拿版本号。
    """
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            s.sendall((f"GET /api/ws HTTP/1.1\r\nHost: {host}:{port}\r\n"
                       "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode("ascii"))
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    return None
                buf += chunk
            head, _, rest = buf.partition(b"\r\n\r\n")
            if b" 101 " not in head.split(b"\r\n")[0]:
                return None
            # 读帧：服务端连上第一帧就是 hello（可能先来一个协议级 ping，跳过）
            for _ in range(6):
                frame, rest = _read_frame(s, rest, timeout)
                if frame is None:
                    return None
                fin, op, payload = frame
                if op == 0x1:
                    j = json.loads(payload.decode("utf-8"))
                    return j if isinstance(j, dict) else None
            return None
    except (OSError, ValueError, struct.error):
        return None


def _read_frame(sock, buf: bytes, timeout: float):
    """读一个 WebSocket 帧 → ((fin, opcode, payload), 剩余缓冲)；断了返回 (None, b'')"""
    sock.settimeout(timeout)

    def need(n, b):
        while len(b) < n:
            chunk = sock.recv(65536)
            if not chunk:
                raise OSError("closed")
            b += chunk
        return b[:n], b[n:]

    head, buf = need(2, buf)
    b1, b2 = head[0], head[1]
    op = b1 & 0x0F
    ln = b2 & 0x7F
    if ln == 126:
        ext, buf = need(2, buf)
        ln = struct.unpack("!H", ext)[0]
    elif ln == 127:
        ext, buf = need(8, buf)
        ln = struct.unpack("!Q", ext)[0]
    payload = b""
    if ln:
        payload, buf = need(ln, buf)
    return (bool(b1 & 0x80), op, payload), buf


def _our_service_running(port: int) -> bool:
    """端口上那个服务是不是我们自己（开长连接读 hello 认名字）"""
    j = probe_service(port)
    return bool(j) and j.get("ok") is True and j.get("name") == "hmi-server"
