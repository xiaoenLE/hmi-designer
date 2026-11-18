#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wschannel.py — 纯标准库 WebSocket 服务端通道（RFC 6455）

为什么要用它（现场问题）
------------------------
以前前后端全靠 HTTP 一问一答：

  · 编辑器 / 运行页每 3 秒 `GET /api/plc` 问一次设备状态；
  · 运行页每 10 秒 `POST /api/poll` 续一次「我还在看画面」的命；
  · 运行页每 30 秒 `GET /api/vars` 补一次全量；
  · **每次写变量一个 POST**（脚本定时写、点动、报警落盘 —— 每秒十几发）。

一个页面一小时就是一千多个请求，每个请求都要走一遍 HTTP 解析 / 线程 / JSON 序列化。
跑一晚上就是几万个来回，两边内存和 CPU 都被这些「例行公事」吃掉 —— 表现就是越跑越卡
（更早还踩过一次：HTTP/1.0 每请求一条 TCP，一晚几十万个连接的生死，把内存拖到 6G）。

改成一条 WebSocket 长连接之后，**稳态下一个 HTTP 请求都不发**：
变量推送、变量写入、设备状态、在线登记全在这一条连接上双向走。

设计要点
--------
· **一条连接两个线程**：读线程（收帧 → 交给 on_message）+ 写线程（发队列 → 发帧）。
  写全部集中在写线程，所以不需要写锁；读线程要回话（pong / close）也是往队列里塞。
· **不用 socket 超时**（重要）：`socket.makefile()` 包出来的 `SocketIO` 一旦超时就会置
  `_timeout_occurred`，之后**任何读都直接抛 OSError** —— 也就是说「给 rfile 设个短超时
  当心跳」这条路是死的（对象一次性作废）。所以这里读写都用阻塞调用，
  连接活性交给服务端那个 1 秒跑一次的线程统一管：`tick()` 负责发 ping、判死、开杀。
· 客户端帧**必须**带掩码（RFC 6455 §5.3）；不带 = 协议错误，直接断。
· 单帧 / 单消息 / 发送队列都有上限：坏客户端或「不读数据的对端」不能把后端内存吃掉。
· 只做「服务端发 unmasked 帧」，不做扩展协商：负载就是几十~几百字节的 JSON，
  permessage-deflate 省不了几个字节，反而多一层 CPU 和一堆边界情况。
· 服务端每 PING_SEC 发协议级 ping：**浏览器会自动回 pong**（JS 一行都不用写），
  据此判断连接还活着吗 —— 面板机网线松一下，TCP 可能几十分钟都不报错。
"""
import base64
import hashlib
import json
import queue
import socket
import struct
import threading
import time

# RFC 6455 §1.3 的魔法字符串：Accept = base64(sha1(key + GUID))
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BIN = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

MAX_FRAME = 1 << 20          # 单帧 1MB（我们的帧都是几百字节；这是防坏客户端的硬闸）
MAX_MSG = 4 << 20            # 一条消息（分片合计）上限
OUT_MAX = 512                # 发送队列上限：满了说明对端不读了，断开重连比无限堆着强
PING_SEC = 20.0              # 服务端协议级 ping 间隔
IDLE_LIMIT = 90.0            # 这么久没收到任何帧（含浏览器自动回的 pong）就当连接死了

CLOSE_NORMAL = 1000
CLOSE_GOING = 1001
CLOSE_PROTO = 1002           # 协议错误
CLOSE_TOOBIG = 1009          # 消息太大


def accept_value(key: str) -> str:
    """握手应答值：base64(sha1(key + GUID)) —— RFC 6455 §4.2.2"""
    raw = (key or "").strip().encode("utf-8") + GUID.encode("ascii")
    return base64.b64encode(hashlib.sha1(raw).digest()).decode("ascii")


def _unmask(data: bytes, key: bytes) -> bytes:
    """按掩码解出载荷。

    用 int.from_bytes 整段异或，而不是 Python 里逐字节循环 —— 脚本写变量时一秒钟几十帧，
    逐字节循环在这儿是白烧 CPU（4 字节掩码平铺成等长掩码再一次性异或）。"""
    n = len(data)
    if not n:
        return b""
    mask = (key * ((n >> 2) + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(mask, "big")).to_bytes(n, "big")


def encode_frame(payload: bytes, opcode: int = OP_TEXT) -> bytes:
    """服务端 → 客户端的帧（§5.1：服务端发的帧一律**不加掩码**）"""
    n = len(payload)
    head = bytearray()
    head.append(0x80 | (opcode & 0x0F))              # FIN=1 + opcode
    if n < 126:
        head.append(n)
    elif n < (1 << 16):
        head.append(126)
        head += struct.pack("!H", n)
    else:
        head.append(127)
        head += struct.pack("!Q", n)
    return bytes(head) + payload


def is_ws_request(handler) -> bool:
    """这个 HTTP 请求是不是在请求升级成 WebSocket"""
    up = (handler.headers.get("Upgrade") or "").strip().lower()
    return up == "websocket" and bool(handler.headers.get("Sec-WebSocket-Key"))


def handshake(handler, cid: str, authed: bool = False, remote: str = ""):
    """完成 101 握手，返回 WSConn；不是合法 WS 请求返回 None。

    ⚠ 读写一律走 handler.rfile / handler.wfile，**不要**绕过它们直接 recv/send 到 socket：
    `rfile` 是 BufferedReader，握手请求读完之后它很可能已经把客户端紧接着发来的第一帧
    收进了自己的缓冲区 —— 绕过它去读 socket，那几个字节就永远读不到了，帧从此对不齐。
    """
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key:
        return None
    ver = (handler.headers.get("Sec-WebSocket-Version") or "").strip()
    if ver and ver != "13":
        handler.send_response(426)
        handler.send_header("Sec-WebSocket-Version", "13")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return None
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept_value(key))
    handler.end_headers()
    # ⚠ **必须把 socket 超时清掉**：HMIServer 设了 `timeout = 30`（用来回收空闲的 keep-alive
    #   连接，见那里的说明），而 socketserver 的 setup() 会把它落到这个 socket 上。
    #   但 `rfile` 是 `socket.makefile()` 包出来的 SocketIO：**一旦读超时一次**，
    #   它就置上 `_timeout_occurred`，之后任何读都直接抛
    #   `OSError: cannot read from timed out object` —— 整条连接就废了。
    #   普通 HTTP 请求不会踩到（一问一答，30 秒内必有下一个请求），长连接一定会踩到。
    #   所以这里明确改回阻塞模式：这条连接的活性由 WSConn.tick() 统一管（发 ping、判死）。
    try:
        handler.connection.settimeout(None)
    except OSError:
        pass
    # 这条连接从此由 WSConn 接管：HTTP 层不要再想在这条连接上读下一个请求
    handler.close_connection = True
    return WSConn(handler, cid, authed=authed, remote=remote)


class WSConn:
    """一条 WebSocket 连接。

    对外只有四样：`send()` 发东西、`on_message` 收回调、`on_close` 收断开通知、
    `tick()` 由服务端心跳线程每秒调一次。其余的（分片、掩码、ping/pong、队列、
    线程生命周期）都在内部。
    """

    def __init__(self, handler, cid, authed: bool = False, remote: str = ""):
        self.cid = cid                       # 连接自己的 id（poll_gate 拿它当 key）
        self.authed = bool(authed)           # 握手时带没带管理员会话（决定配置里给不给口令）
        self.remote = remote or ""
        self.rfile = handler.rfile
        self.wfile = handler.wfile
        self.sock = handler.connection
        self.out = queue.Queue(maxsize=OUT_MAX)
        self.alive = True
        self.info = {"status": True, "poll": False}   # 这条连接的订阅 / 登记状态
        self.on_message = None               # fn(conn, dict)
        self.on_close = None                 # fn(conn)
        self.opened_at = time.time()
        self.last_recv = time.time()
        self.sent = 0                        # 发出去多少帧（诊断用）
        self.recvd = 0                       # 收到多少帧（诊断用）
        self._last_ping = time.time()
        self._finished = threading.Event()
        self._frag_op = None                 # 分片消息：首帧的 opcode
        self._frag_parts = []
        self._frag_len = 0
        self._reader = None
        self._writer = None

    # ── 对外 ──
    def start(self):
        self._writer = threading.Thread(target=self._write_loop, name=f"ws-tx-{self.cid}", daemon=True)
        self._reader = threading.Thread(target=self._read_loop, name=f"ws-rx-{self.cid}", daemon=True)
        self._writer.start()
        self._reader.start()
        return self

    def send(self, payload):
        """发一条文本帧。payload 可以是 dict（自动 JSON）或 str。非阻塞。"""
        if not self.alive:
            return False
        if isinstance(payload, (bytes, bytearray)):
            text = bytes(payload).decode("utf-8", "replace")
        elif isinstance(payload, str):
            text = payload
        else:
            text = json.dumps(payload, ensure_ascii=False)
        try:
            self.out.put_nowait(text)
            return True
        except queue.Full:
            # 对端不读了：继续堆只会把后端内存吃掉。断开 → 前端重连 → 重连时补全量，值不会丢。
            self.kill("发送队列满（对端不读了）")
            return False

    def close(self, code=CLOSE_NORMAL, reason=""):
        """礼貌关闭：排一个 close 帧 + 收工信号，写完就断。"""
        if self._finished.is_set():
            return
        self.alive = False
        body = struct.pack("!H", code) + (reason or "").encode("utf-8")[:123]
        for item in (("__FRAME__", OP_CLOSE, body), None):
            try:
                self.out.put_nowait(item)
            except queue.Full:
                break

    def kill(self, reason=""):
        """立刻断（不发 close 帧）—— 读写两个线程都会因为 socket 被 shutdown 而退出。"""
        self.alive = False
        try:
            self.out.put_nowait(None)        # 唤醒写线程
        except queue.Full:
            pass
        self._finish()

    def wait_closed(self):
        """等这条连接彻底结束。

        给占着 HTTP handler 线程的那个调用方用：**阻塞等事件**，不轮询。
        （连接一定会结束：最晚 tick() 在 IDLE_LIMIT 秒没收到帧时把它收掉。）"""
        self._finished.wait()

    def tick(self, now=None):
        """服务端心跳线程每秒调一次：发协议级 ping、判死。

        浏览器收到 ping 会**自动**回 pong，所以 last_recv 一直在动就说明这条 TCP 真的活着；
        反过来说，网线松了/对端进程没了，这里最迟 IDLE_LIMIT 秒就会把连接收掉。"""
        if self._finished.is_set():
            return
        now = now or time.time()
        if now - self.last_recv > IDLE_LIMIT:
            self.kill("心跳超时")
            return
        if now - self._last_ping >= PING_SEC:
            self._last_ping = now
            self._queue_frame(OP_PING, b"")

    def stats(self):
        return {"cid": self.cid, "remote": self.remote, "authed": self.authed,
                "alive": self.alive, "sent": self.sent, "recvd": self.recvd,
                "uptime": round(time.time() - self.opened_at, 1),
                "queued": self.out.qsize(), "idle": round(time.time() - self.last_recv, 1),
                "info": dict(self.info)}

    # ── 写线程 ──
    def _write_loop(self):
        try:
            while True:
                item = self.out.get()
                if item is None:
                    break
                if isinstance(item, tuple) and item and item[0] == "__FRAME__":
                    data = encode_frame(item[2], item[1])
                else:
                    data = encode_frame(str(item).encode("utf-8"), OP_TEXT)
                self.wfile.write(data)
                self.wfile.flush()
                self.sent += 1
        except (OSError, ValueError, AttributeError):
            pass
        finally:
            self._finish()

    def _finish(self):
        """收尾（幂等）：关 socket。读写两边谁先到都行，shutdown 会把对方也叫醒。"""
        if self._finished.is_set():
            return
        self._finished.set()
        self.alive = False
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    # ── 读线程 ──
    def _read_loop(self):
        try:
            while self.alive:
                frame = self._read_frame()
                if frame is None:
                    break
                fin, op, data = frame
                self.recvd += 1
                self.last_recv = time.time()
                if not self._handle_frame(fin, op, data):
                    break
        except (OSError, ValueError, struct.error):
            pass
        finally:
            self.alive = False
            try:
                self.out.put_nowait(None)     # 叫写线程收工
            except queue.Full:
                pass
            cb, self.on_close = self.on_close, None
            if cb:
                try:
                    cb(self)
                except Exception:                                  # noqa: BLE001
                    pass
            self._finish()

    def _queue_frame(self, opcode, payload):
        try:
            self.out.put_nowait(("__FRAME__", opcode, payload))
        except queue.Full:
            self.kill("发送队列满")

    def _recv_exact(self, n):
        """精确读 n 字节；对端关了返回 None。

        用 rfile.read(n) 阻塞读到够为止 —— 不能在这里加 socket 超时（见模块开头的说明：
        makefile 出来的对象一旦超时就读不了任何东西了）。"""
        buf = b""
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def _read_frame(self):
        """读一个完整帧 → (fin, opcode, payload)；连接结束返回 None"""
        head = self._recv_exact(2)
        if head is None:
            return None
        b1, b2 = head[0], head[1]
        fin = bool(b1 & 0x80)
        op = b1 & 0x0F
        masked = bool(b2 & 0x80)
        ln = b2 & 0x7F
        if ln == 126:
            ext = self._recv_exact(2)
            if ext is None:
                return None
            ln = struct.unpack("!H", ext)[0]
        elif ln == 127:
            ext = self._recv_exact(8)
            if ext is None:
                return None
            ln = struct.unpack("!Q", ext)[0]
        if op >= 0x8:                        # 控制帧：FIN 必须为 1、载荷 ≤125
            if not fin or ln > 125:
                self.close(CLOSE_PROTO, "bad control frame")
                return None
        elif ln > MAX_FRAME:
            self.close(CLOSE_TOOBIG, "frame too big")
            return None
        if not masked:
            # §5.3：客户端发来的帧必须带掩码。不带 = 协议错误（也是防缓存投毒的要求）。
            self.close(CLOSE_PROTO, "client frame must be masked")
            return None
        key = self._recv_exact(4)
        if key is None:
            return None
        data = self._recv_exact(ln) if ln else b""
        if data is None:
            return None
        return fin, op, _unmask(data, key)

    def _handle_frame(self, fin, op, data) -> bool:
        """处理一个帧；返回 False = 该断开这条连接了"""
        if op == OP_CLOSE:
            self.close(CLOSE_NORMAL)
            return False
        if op == OP_PING:
            self._queue_frame(OP_PONG, data)
            return True
        if op == OP_PONG:
            return True                       # last_recv 在调用处已经更新过了
        if op == OP_CONT:
            if self._frag_op is None:
                self.close(CLOSE_PROTO, "unexpected continuation")
                return False
            self._frag_parts.append(data)
            self._frag_len += len(data)
        elif op in (OP_TEXT, OP_BIN):
            if self._frag_op is not None:
                self.close(CLOSE_PROTO, "nested fragment")
                return False
            if fin:
                return self._deliver(op, data)
            self._frag_op = op
            self._frag_parts = [data]
            self._frag_len = len(data)
            return True
        else:
            self.close(CLOSE_PROTO, "bad opcode")
            return False
        if self._frag_len > MAX_MSG:
            self.close(CLOSE_TOOBIG, "message too big")
            return False
        if fin:
            parts, op0 = self._frag_parts, self._frag_op
            self._frag_op, self._frag_parts, self._frag_len = None, [], 0
            return self._deliver(op0, b"".join(parts))
        return True

    def _deliver(self, op, data) -> bool:
        if len(data) > MAX_MSG:
            self.close(CLOSE_TOOBIG, "message too big")
            return False
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            self.close(CLOSE_PROTO, "bad utf-8")
            return False
        if not text.strip():
            return True
        try:
            msg = json.loads(text)
        except ValueError:
            return True                       # 不是 JSON 就忽略（不为一条坏帧断开整条连接）
        if not isinstance(msg, dict):
            return True
        if self.on_message is not None:
            try:
                self.on_message(self, msg)
            except Exception as e:                                # noqa: BLE001
                # 一条消息处理失败不能拉断整条连接（否则前端会陷入「一连就断」的死循环）
                print(f"[ws] 处理消息出错（连接保留）：{e}")
        return True
