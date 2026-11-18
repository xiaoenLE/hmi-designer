#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify-ws.py — WebSocket 双向通道端到端体检（纯标准库，不需要浏览器）

验的是「一条长连接把以前那些 HTTP 轮询全替掉」这件事到底成不成：

  · 握手：101 + Sec-WebSocket-Accept 与 RFC 6455 §4.2.2 的算法一致；
  · 连上先给一份现状（hello：build / features / 设备状态 / 配置）；
  · 双向：ping↔pong、写变量→ack、读全量→ack、下发变量表→ack、登记运行态→ack；
  · 推送：写进去的值会广播回来；设备状态每秒推一条；
  · **稳态零轮询**（这条最关键）：什么都不干晾 4 秒，/api/health 里的 reqs 只涨
    体检自己问的那两次 —— 也就是前端再也不发 /api/plc、/api/poll、/api/vars 了；
  · 登记的生命周期绑定连接：连着就续命，断开就自动注销（不用前端 sendBeacon）；
  · 协议错误：客户端帧不带掩码必须被断开（RFC 6455 §5.3）。

自己起一个隔离后端（临时数据目录 + 空闲端口），跑完关掉。
用法：python test/verify-ws.py
"""
import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable or "python"

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_results = []


def ok(name, cond, extra=""):
    _results.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{extra}]" if extra else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http_json(port, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


class WsClient:
    """够用的 WebSocket 客户端（客户端 → 服务端的帧必须带掩码）"""

    def __init__(self, port, path="/api/ws", origin=None):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n")
        if origin:
            req += f"Origin: {origin}\r\n"
        req += "\r\n"
        self.sock.sendall(req.encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            c = self.sock.recv(4096)
            if not c:
                break
            head += c
        raw_head, _, rest = head.partition(b"\r\n\r\n")
        self.buf = rest
        self.status_line = raw_head.split(b"\r\n")[0].decode("latin-1")
        self.headers = {}
        for line in raw_head.split(b"\r\n")[1:]:
            if b":" in line:
                k, v = line.split(b":", 1)
                self.headers[k.decode("latin-1").strip().lower()] = v.decode("latin-1").strip()
        self.expect_key = key
        self._closed = False

    @property
    def upgraded(self):
        return self.status_line.startswith("HTTP/1.1 101")

    def _recv(self, n):
        while len(self.buf) < n:
            c = self.sock.recv(65536)
            if not c:
                return None
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _frame(self, payload: bytes, opcode=0x1):
        mask = os.urandom(4)
        n = len(payload)
        head = bytearray([0x80 | opcode])
        if n < 126:
            head.append(0x80 | n)
        elif n < (1 << 16):
            head.append(0x80 | 126)
            head += struct.pack("!H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack("!Q", n)
        head += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return bytes(head) + masked

    def send(self, obj, opcode=0x1):
        data = obj if isinstance(obj, (bytes, bytearray)) else json.dumps(obj).encode("utf-8")
        self.sock.sendall(self._frame(bytes(data), opcode))

    def send_raw(self, payload: bytes, opcode=0x1, mask=True):
        """故意可以发**不带掩码**的帧（测协议错误路径）"""
        n = len(payload)
        head = bytearray([0x80 | opcode])
        if n < 126:
            head.append((0x80 if mask else 0) | n)
        else:
            head.append((0x80 if mask else 0) | 126)
            head += struct.pack("!H", n)
        if mask:
            m = os.urandom(4)
            head += m
            payload = bytes(b ^ m[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(head) + payload)

    def read_frame(self, timeout=6.0):
        """返回 (opcode, payload_bytes)；超时/断开返回 (None, None)"""
        self.sock.settimeout(timeout)
        try:
            h = self._recv(2)
            if h is None:
                return None, None
            b1, b2 = h[0], h[1]
            op = b1 & 0x0F
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._recv(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._recv(8))[0]
            payload = self._recv(ln) if ln else b""
            if payload is None:
                return None, None
            return op, payload
        except (socket.timeout, TimeoutError, OSError):
            return None, None

    def next_json(self, want=None, timeout=6.0, skip_control=True):
        """读到一条 JSON 文本帧。want = 期望的 t 字段（其它类型跳过）"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            op, payload = self.read_frame(max(0.2, deadline - time.time()))
            if op is None:
                continue
            if op in (0x9,):                       # ping → 回 pong
                self.sock.sendall(self._frame(payload, 0xA))
                continue
            if op == 0xA:
                continue
            if op != 0x1:
                continue
            try:
                j = json.loads(payload.decode("utf-8"))
            except ValueError:
                continue
            if want is None or j.get("t") == want:
                return j
        return None

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self.sock.sendall(self._frame(struct.pack("!H", 1000), 0x8))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def collect(self, seconds=3.0):
        """把这段时间里收到的**所有** JSON 帧收下来。

        ⚠ 不能用「按类型过滤着读」的方式边读边挑：广播帧（{"name","value"}）和 ack 是
        排在同一条队列上的，过滤 ack 的时候会把广播帧顺手吃掉 —— 那是体检自己的锅，
        不是后端的锅（第一次就是这么误报的）。"""
        out = []
        deadline = time.time() + seconds
        while time.time() < deadline:
            j = self.next_json(None, timeout=max(0.2, deadline - time.time()))
            if j:
                out.append(j)
        return out


def main():
    port = free_port()
    data = tempfile.mkdtemp(prefix="hmi-ws-")
    env = {**os.environ, "HMI_DATA_DIR": data}
    srv = subprocess.Popen([PY, str(ROOT / "server" / "server.py"), "--port", str(port),
                            "--no-browser", "--no-auth"],
                           cwd=str(ROOT), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        up = False
        for _ in range(50):
            time.sleep(0.3)
            try:
                http_json(port, "/api/health")
                up = True
                break
            except Exception:                                        # noqa: BLE001
                pass
        if not up:
            print("后端没起来")
            return 1

        health = http_json(port, "/api/health")
        ok("后端声明了 websocket 能力", "websocket" in health.get("features", []),
           str(health.get("build")))
        ok("/api/health 带 ws 段", isinstance(health.get("ws"), dict))

        # ── 1. 握手 ──
        c = WsClient(port)
        ok("握手返回 101", c.upgraded, c.status_line)
        expect = base64.b64encode(hashlib.sha1((c.expect_key + GUID).encode()).digest()).decode()
        ok("Sec-WebSocket-Accept 算法正确",
           c.headers.get("sec-websocket-accept") == expect,
           str(c.headers.get("sec-websocket-accept")))
        ok("声明 Upgrade: websocket", (c.headers.get("upgrade") or "").lower() == "websocket")

        # ── 2. hello ──
        hello = c.next_json("hello")
        ok("连上先收到 hello", bool(hello))
        if hello:
            ok("hello 带 build/features/状态", bool(hello.get("build")) and bool(hello.get("features"))
               and isinstance(hello.get("status"), dict))
            ok("hello 带采集范围（设备状态）", "paused" in (hello.get("status") or {}))

        # ── 3. ping / pong ──
        c.send({"t": "ping", "id": 1})
        pong = c.next_json("pong")
        ok("应用层 ping → pong（id 原样带回）", bool(pong) and pong.get("id") == 1)

        # ── 4. 写变量（与 HTTP /api/vars 同一套语义） ──
        # 广播帧和 ack 在同一条队列上：一起收下来再分别断言（见 collect 的说明）
        c.send({"t": "write", "id": 2, "name": "n_ws", "value": 42})
        frames = c.collect(2.0)
        ack = next((f for f in frames if f.get("t") == "ack" and f.get("id") == 2), None)
        ok("写变量收到 ack ok", bool(ack) and ack.get("ok") is True,
           json.dumps(ack, ensure_ascii=False) if ack else "没收到 ack")
        # 写进去的值会**广播回来**（前端不用自己回读；别的页面也能看到）
        bc = next((f for f in frames if f.get("name") == "n_ws"), None)
        ok("写入的值广播回来了", bool(bc) and bc.get("value") == 42,
           json.dumps(bc, ensure_ascii=False) if bc else "没收到广播帧")

        # ── 5. 外部 HTTP 写 → WebSocket 也能收到（两条通道是一条广播链） ──
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/vars",
                                     data=json.dumps({"name": "n_http", "value": 7}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=5).read()
        frames = c.collect(2.0)
        seen = next((f for f in frames if f.get("name") == "n_http"), None)
        ok("HTTP 写的值也会推到 WebSocket（同一个广播链）", bool(seen),
           json.dumps(seen, ensure_ascii=False) if seen else "没收到")

        # ── 6. 全量读 ──
        c.send({"t": "vars", "id": 3})
        vr = c.next_json("ack")
        while vr is not None and vr.get("id") != 3:
            vr = c.next_json("ack")
        ok("WebSocket 全量读变量", bool(vr) and vr.get("ok") is True and "n_ws" in (vr.get("vars") or {}),
           str(len((vr or {}).get("vars") or {})) + " 个")

        # ── 7. 下发变量表 / 采集范围 ──
        c.send({"t": "declare", "id": 4,
                "variables": [{"name": "n_ws", "type": "int", "address": "%MW100"}],
                "active": ["n_ws"]})
        dr = None
        deadline = time.time() + 4
        while time.time() < deadline:
            j = c.next_json("ack", timeout=1.0)
            if j and j.get("id") == 4:
                dr = j
                break
        ok("WebSocket 下发变量表 + 采集范围", bool(dr) and dr.get("ok") is True,
           json.dumps({k: dr.get(k) for k in ("ok", "active", "blocks", "scoped")}, ensure_ascii=False) if dr else "")

        # ── 8. 设备状态推送 ──
        st = c.next_json("status", timeout=4)
        ok("设备状态每秒推一条", bool(st) and isinstance(st.get("status"), dict))
        st2 = c.next_json("status", timeout=4)
        ok("状态推送是持续的（不是只发一次）", bool(st2))

        # ── 9. 运行登记绑连接 ──
        c.send({"t": "poll", "id": 5, "on": True})
        pr = None
        deadline = time.time() + 4
        while time.time() < deadline:
            j = c.next_json("ack", timeout=1.0)
            if j and j.get("id") == 5:
                pr = j
                break
        ok("WebSocket 上登记「我在看运行画面」", bool(pr) and pr.get("ok") is True,
           json.dumps({k: pr.get(k) for k in ("paused", "running_clients")}, ensure_ascii=False) if pr else "")
        h2 = http_json(port, "/api/health")
        ok("健康接口看得到这条 WS 连接", (h2.get("ws") or {}).get("clients") == 1,
           str((h2.get("ws") or {}).get("clients")))
        ok("登记生效（不再 paused）", h2.get("plc", {}).get("running_clients") == 1
           and h2.get("plc", {}).get("paused") is False,
           json.dumps(h2.get("plc"), ensure_ascii=False))

        # ── 10. 稳态零轮询（这条最关键） ──
        # ⚠ reqs 是在 end_headers 里加的，而响应体里的值是**加之前**读的 ——
        #   所以连着两次 /api/health 报出来的数正好差 1（第一次自己那一下）。
        #   差 1 = 中间没有任何别的请求；差更多就说明还有东西在轮询。
        r0 = http_json(port, "/api/health")["reqs"]
        time.sleep(4.0)                       # 什么都不干，晾 4 秒
        r1 = http_json(port, "/api/health")["reqs"]
        ok("稳态 4 秒内 HTTP 请求数一点没涨", r1 - r0 == 1, f"reqs {r0} → {r1}（差 {r1 - r0}，期望 1）")

        # ── 11. 长连接要能扛过"闲着不动"（> handler 的 30 秒超时） ──
        # 这条是防回归的硬闸：HMIServer 上设了 timeout=30（回收空闲的 keep-alive 连接），
        # 而 socketserver 会把它落到这条 socket 上。可 rfile 是 makefile() 包出来的 SocketIO，
        # **读超时一次就永久作废**（之后任何读都抛 OSError）—— 所以 WS 握手时把它清成阻塞模式。
        # 要是哪天有人把那行清了，这里 35 秒之后发的 ping 就再也收不到 pong。
        # （测试里这段时间刻意**不读**也不回 pong：模拟"后端一直没收到任何帧"的最坏情况。）
        print("      … 长连接静置 35 秒（跨过 30 秒的 handler 超时）")
        time.sleep(35)
        c.send({"t": "ping", "id": 99})
        late = c.next_json("pong", timeout=10)
        ok("静置 35 秒（跨过 30 秒超时）后长连接仍然可用", bool(late) and late.get("id") == 99,
           json.dumps(late) if late else "没收到 pong —— 很可能 socket 超时把 rfile 弄废了")
        h_idle = http_json(port, "/api/health")
        ok("静置期间连接没被误杀", (h_idle.get("ws") or {}).get("clients") == 1,
           str((h_idle.get("ws") or {}).get("clients")))

        # ── 12. 协议错误：客户端帧不带掩码必须断开 ──
        bad = WsClient(port)
        bad.next_json("hello")
        bad.send_raw(b'{"t":"ping"}', opcode=0x1, mask=False)
        op, _ = bad.read_frame(timeout=4)
        closed = (op == 0x8) or (op is None)
        ok("不带掩码的客户端帧被断开（§5.3）", closed, f"opcode={op}")
        bad.close()

        # ── 13. 断开自动注销运行登记 ──
        c.close()
        time.sleep(0.8)
        h3 = http_json(port, "/api/health")
        ok("连接断开后自动注销运行登记",
           (h3.get("plc", {}).get("running_clients") or 0) == 0,
           json.dumps(h3.get("plc"), ensure_ascii=False))
        ok("断开后 WS 连接数归零", (h3.get("ws") or {}).get("clients") == 0,
           str((h3.get("ws") or {}).get("clients")))

        # ── 14. 非升级请求打到 /api/ws 要给一句人话 ──
        # （urlopen 对 4xx 会抛 HTTPError，但错误响应体还在里面 —— 得从异常里把它读出来）
        gave_hint, body = False, {}
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ws", timeout=5) as r:
                body = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode())
            except Exception:                                        # noqa: BLE001
                body = {"err": f"HTTP {e.code}"}
        except Exception as e:                                       # noqa: BLE001
            body = {"err": str(e)}
        gave_hint = body.get("ok") is False and "WebSocket" in (body.get("error") or "")
        ok("普通 GET /api/ws 给明确提示（不静默断连）", gave_hint, json.dumps(body, ensure_ascii=False))

        fails = [n for n, good in _results if not good]
        print(f"\n==== WebSocket 双向通道：{len(_results) - len(fails)}/{len(_results)} 通过 ====")
        if fails:
            print("没过的：" + "、".join(fails))
        return 1 if fails else 0
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:                                            # noqa: BLE001
            srv.kill()
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
