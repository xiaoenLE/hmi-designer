# -*- coding: utf-8 -*-
"""_wspy.py — 给 **Python 侧**测试用的长连接小工具（纯标准库，零依赖）

为什么需要它：2.0 把 HTTP 接口全删了（`/api/*` 一律 404），所有接口都走那条
WebSocket 长连接上的 `{t:'call', path, method, body}`。套件里原来那些
`http_json("http://…/api/update/check")` 就全都落空了 —— 尤其是**更新验收**
（`verify-exe-update.py` / `verify-update-apply.py`）：它们驱动的是另一个进程里的
打包产物，没法在进程内直接调函数，只能真的走协议。

用法：
    from _wspy import api, hello, connect

    hello(port)                                  # 探活（替代以前的 /api/health），读回 hello 帧
    api(port, "/api/update/check?force=1")       # 调接口 → 直接拿 payload（dict）
    api(port, "/api/update/apply", method="POST", timeout=60)

    c = connect(port, token="…")                 # 要连着调好几次就复用一条连接
    c.api("/api/vars"); c.close()

返回的 payload 就是后端 `core/api.py` 里那个 dict（跟 1.x 的 HTTP JSON 一模一样），
所以套件里的 `r.get("ok")` / `chk["remote"]["app_zip"]["sha256"]` 这些写法都不用改。
"""
import base64
import json
import os
import socket
import struct

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HOST = "127.0.0.1"


class WsError(RuntimeError):
    """连接层的问题（连不上 / 断了 / 帧不对）—— 不是后端业务报错。"""


class Conn:
    """一条长连接：`hello` 是连上第一帧，`api()` 调接口，`close()` 关掉。"""

    def __init__(self, sock, hello_frame=None):
        self.s = sock
        self.buf = b""
        self.seq = 1
        self.hello = hello_frame
        self.frames = []          # hello / status 这类服务端主动发的帧，谁要看谁取

    # ── 底层收发 ──
    def _read_exact(self, n, timeout=10.0):
        self.s.settimeout(timeout)
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise WsError("连接被对端关掉了")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _read_frame(self, timeout=10.0):
        hdr = self._read_exact(2, timeout)
        b1, b2 = hdr[0], hdr[1]
        fin, op = bool(b1 & 0x80), b1 & 0x0F
        masked, ln = bool(b2 & 0x80), b2 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._read_exact(2, timeout))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._read_exact(8, timeout))[0]
        mask = self._read_exact(4, timeout) if masked else None
        payload = self._read_exact(ln, timeout) if ln else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return fin, op, payload

    def _send_frame(self, op, data: bytes):
        head = bytes([0x80 | op])
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        try:
            self.s.sendall(head + mask + masked)
        except OSError as e:
            raise WsError(f"发送失败：{e}") from e

    def send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def read_json(self, timeout=10.0):
        """读一条完整消息（跳过 ping、拼分片）；返回解析好的 dict。"""
        data = b""
        while True:
            fin, op, payload = self._read_frame(timeout)     # 超时 → socket.timeout
            if op == 0x9:                                    # ping：按协议回 pong
                self._send_frame(0xA, payload)
                continue
            if op == 0xA:                                    # pong：忽略
                continue
            if op == 0x8:                                    # close
                raise WsError("服务端主动断开（close 帧）")
            data += payload
            if fin:
                break
        try:
            return json.loads(data.decode("utf-8"))
        except Exception as e:                               # noqa: BLE001
            raise WsError(f"收到的不是 JSON：{data[:120]!r}") from e

    # ── 接口 ──
    def call(self, path, method="POST", body=None, timeout=60.0):
        """调一个接口 → 返回整条 ack（{t,id,ok,status,data}）。"""
        mid = self.seq
        self.seq += 1
        self.send_json({"t": "call", "id": mid, "path": path, "method": method, "body": body or {}})
        while True:
            j = self.read_json(timeout)
            if j.get("t") == "ack" and j.get("id") == mid:
                return j
            self.frames.append(j)            # hello / status 之类：攒着，别丢

    def api(self, path, method="POST", body=None, timeout=60.0):
        """调接口 → 直接返回 payload（跟 1.x 的 HTTP JSON 同一个形状）。"""
        ack = self.call(path, method=method, body=body, timeout=timeout)
        data = ack.get("data")
        return data if isinstance(data, dict) else {}

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:                                        # noqa: BLE001
            pass
        try:
            self.s.close()
        except Exception:                                        # noqa: BLE001
            pass


def connect(port, host=HOST, timeout=10.0, token="", path="/api/ws"):
    """连上长连接并读回 hello 帧（顺带把 hello 填进 conn.hello）。"""
    s = socket.create_connection((host, int(port)), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    if token:
        path += "?token=" + token
    req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
           "Upgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
    s.sendall(req.encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            s.close()
            raise WsError("握手就被对端关掉了（不是 WebSocket 服务？）")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    if b" 101 " not in head.split(b"\r\n")[0]:
        s.close()
        raise WsError("握手没升级成功：" + head.split(b"\r\n")[0].decode("latin1"))
    c = Conn(s)
    c.buf = rest
    try:
        c.hello = c.read_json(timeout)        # 连上第一帧就是 hello
        if isinstance(c.hello, dict) and c.hello.get("t") != "hello":
            c.frames.append(c.hello)
            c.hello = None
    except Exception:                                          # noqa: BLE001
        c.hello = None
    return c


def hello(port, host=HOST, timeout=3.0):
    """探活：连得上就返回 hello 帧，连不上返回 None（替代以前的 GET /api/health）。"""
    try:
        c = connect(port, host=host, timeout=timeout)
        try:
            return c.hello
        finally:
            c.close()
    except Exception:                                          # noqa: BLE001
        return None


def api(port, path, method="POST", body=None, host=HOST, timeout=60.0):
    """一次性连接调一个接口（要连着调好几次就用 connect() 复用）。"""
    c = connect(port, host=host, timeout=min(timeout, 10.0))
    try:
        return c.api(path, method=method, body=body, timeout=timeout)
    finally:
        c.close()
