#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hostutil.py — host 判定 / 端口占用探测

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

端口探测用「连一下」而不是 bind：Windows 上有个坑 ——
被别的进程占着但没在监听的端口，bind 是成功的，于是「没占用」会误判。
"""

import http.client
import ipaddress
import json
import socket


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



def _our_service_running(port: int) -> bool:
    """端口上那个服务是不是我们自己（读 /api/health 认名字）"""
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=0.6)
        c.request("GET", "/api/health")
        j = json.loads(c.getresponse().read().decode("utf-8"))
        return bool(j.get("ok")) and j.get("name") == "hmi-server"
    except Exception:
        return False
