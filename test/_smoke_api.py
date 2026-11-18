#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_smoke_api.py — 后端「所有接口都还活着吗」的快速体检（十秒级，改完先跑它）

★ V2 起 HTTP **没有任何接口**，所以这个体检**全部走长连接**：
   连上 /api/ws → 发 {t:'call', path:'/api/xxx', …} → 看 ack。
   它一次把两件事都验掉：
     ① 每个接口还能不能干活（参数、状态码、错误文案）；
     ② "HTTP 侧确实一条接口都没有了"（打老接口就该 404）。

为什么要有它：搬代码/拆模块最容易出的错不是逻辑写错，而是**某个函数搬走了、
它依赖的名字没跟着搬** —— 那种错要等某个接口被调到才炸。完整套件跑一轮十几分钟，
这个十秒级，适合每改一步就跑。

用法：python test/_smoke_api.py            # 自己起隔离后端
      python test/_smoke_api.py 8877       # 指定端口
"""
import base64
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
DEFAULT_PW = "admin123"           # 首次启动自动创建的口令（见 core/auth.py）

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


def http_get(port, path, timeout=6):
    """只用来验「HTTP 侧没有接口了」和「页面还能拿」"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:                                          # noqa: BLE001
        return 0, str(e)


class Ws:
    """够用的长连接客户端（客户端 → 服务端的帧必须带掩码）"""

    def __init__(self, port, path="/api/ws", token="", timeout=15):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.buf = b""
        if token:
            path += "?token=" + token
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                           "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            c = self.sock.recv(4096)
            if not c:
                break
            head += c
        raw_head, _, self.buf = head.partition(b"\r\n\r\n")
        self.status_line = raw_head.split(b"\r\n")[0].decode("latin-1")
        self._seq = 1
        self.hello = self.wait_json("hello", 6) if self.upgraded else None

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

    def send(self, obj):
        payload = json.dumps(obj).encode("utf-8")
        m = os.urandom(4)
        masked = bytes(b ^ m[i % 4] for i, b in enumerate(payload))
        h = bytearray([0x81])
        n = len(payload)
        if n < 126:
            h.append(0x80 | n)
        elif n < (1 << 16):
            h.append(0x80 | 126)
            h += struct.pack("!H", n)
        else:
            h.append(0x80 | 127)
            h += struct.pack("!Q", n)
        self.sock.sendall(bytes(h) + m + masked)

    def read_frame(self, timeout=8.0):
        self.sock.settimeout(timeout)
        try:
            h = self._recv(2)
            if h is None:
                return None, None
            op = h[0] & 0x0F
            ln = h[1] & 0x7F
            if ln == 126:
                ln = struct.unpack("!H", self._recv(2))[0]
            elif ln == 127:
                ln = struct.unpack("!Q", self._recv(8))[0]
            payload = self._recv(ln) if ln else b""
            return (op, payload) if payload is not None else (None, None)
        except (socket.timeout, TimeoutError, OSError):
            return None, None

    def wait_json(self, want, timeout=8.0):
        """读到一条 t == want 的 JSON 帧（跳过状态帧与协议 ping）"""
        end = time.time() + timeout
        while time.time() < end:
            op, payload = self.read_frame(max(0.2, end - time.time()))
            if op is None or op != 0x1:
                continue
            try:
                j = json.loads(payload.decode("utf-8"))
            except ValueError:
                continue
            if not want or j.get("t") == want:
                return j
        return None

    def request(self, obj, timeout=10.0):
        """发一条消息并等它的 ack（按 id 配）"""
        mid = self._seq
        self._seq += 1
        self.send({**obj, "id": mid})
        end = time.time() + timeout
        while time.time() < end:
            j = self.wait_json("ack", max(0.2, end - time.time()))
            if j is None:
                return None
            if j.get("id") == mid:
                return j
        return None

    def call(self, path, method="POST", body=None, timeout=25.0):
        """★ V2 唯一的调接口方式：长连接上的 {t:'call'}"""
        return self.request({"t": "call", "path": path, "method": method, "body": body}, timeout)

    def ping(self, timeout=8.0):
        """ping 的应答是 {t:'pong', id} 而不是 ack，所以得单独等（request 只配 ack）"""
        mid = self._seq
        self._seq += 1
        self.send({"t": "ping", "id": mid})
        end = time.time() + timeout
        while time.time() < end:
            j = self.wait_json("pong", max(0.2, end - time.time()))
            if j is None:
                return None
            if j.get("id") == mid:
                return j
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else free_port()
    data = tempfile.mkdtemp(prefix="hmi-smoke-")
    env = {**os.environ, "HMI_DATA_DIR": data, "HMI_UPDATE_URL": ""}   # 关外网检查，别拖慢
    # ⚠ 故意**开着**登录闸门（不加 --no-auth）：这样能顺手验"要管理员的接口真的拦得住"、
    #   以及长连接上的登录/注销/token。默认口令 admin123（隔离数据目录首次启动自动创建）。
    srv = subprocess.Popen([PY, str(ROOT / "server" / "server.py"), "--port", str(port),
                            "--no-browser", "--poll-always"],
                           cwd=str(ROOT), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    ws = None
    try:
        # ── 等它起来：V2 用长连接探活（没有 /api/health 了）──
        up = False
        for _ in range(60):
            time.sleep(0.25)
            if srv.poll() is not None:
                print("后端启动就退出了，输出：\n" + srv.stdout.read().decode("utf-8", "replace")[-3000:])
                return 1
            try:
                ws = Ws(port)
                up = bool(ws.hello)
                break
            except OSError:
                ws = None
        if not up:
            print("后端没起来（长连接握不上）")
            return 1

        # ── hello：一份现状 ──
        h = ws.hello
        ok("长连接握上手，第一帧是 hello", bool(h) and h.get("t") == "hello")
        ok("hello 带 build/features/version/auth/plc/opcua/status",
           all(k in h for k in ("build", "features", "version", "auth", "plc", "opcua", "status")),
           ",".join(k for k in ("build", "features", "version", "auth", "plc", "opcua", "status") if k not in h))
        ok("能力表里有 websocket / ws_only / rpc",
           all(f in (h.get("features") or []) for f in ("websocket", "ws_only", "rpc")))
        # 版本号跟仓库里的 version.json 对得上（发版只改 version.json，别写死）
        want_ver = ""
        try:
            want_ver = str(json.loads((ROOT / "version.json").read_text(encoding="utf-8-sig")).get("version") or "")
        except Exception:                                        # noqa: BLE001
            want_ver = ""
        ok(f"版本号跟 version.json 一致（{want_ver or '读不到 version.json'}）",
           want_ver != "" and str((h.get("version") or {}).get("version")) == want_ver,
           str((h.get("version") or {}).get("version")))
        # hello 里的诊断段：现场靠它看"是不是有东西在偷偷发 HTTP"
        wsd = h.get("ws") or {}
        ok("hello 带 ws 诊断段（clients / reqs / conns）",
           all(k in wsd for k in ("clients", "reqs", "conns")), str(wsd)[:120])
        ok("诊断段报的连接数 ≥ 1（我们自己这条）", int(wsd.get("clients") or 0) >= 1, str(wsd.get("clients")))
        ok("**没登录时不给每条连接的明细**（里面有对端地址）", "detail" not in wsd, str(list(wsd.keys())))

        # ── HTTP 侧：接口全没了，页面还在 ──
        st, body = http_get(port, "/")
        ok("GET / 还是页面（200 且是 HTML）", st == 200 and "<" in body, f"status={st}")
        for path in ("/run", "/login"):
            st, _ = http_get(port, path)
            ok(f"GET {path} 还是页面", st == 200, f"status={st}")
        for old in ("/api/health", "/api/vars", "/api/plc", "/api/project", "/api/events", "/api/poll"):
            st, body = http_get(port, old)
            ok(f"HTTP {old} 已删除（404 + 人话）", st == 404 and "WebSocket" in body, f"status={st}")

        # ── 未登录：要管理员的接口拦得住，热路径放行 ──
        j = ws.call("/api/vars", "GET")
        ok("未登录也能读变量（HMI 的本职）", j and j.get("status") == 200, str(j and j.get("status")))
        j = ws.call("/api/project", "GET")
        ok("未登录能读工程存档（运行页要拿它画画面）", j and j.get("status") == 200)
        j = ws.call("/api/project", "POST", {"data": {"meta": {"name": "x"}, "pages": []}})
        ok("未登录**不能**存工程（401 + need_login）",
           j and j.get("status") == 401 and (j.get("data") or {}).get("need_login") is True,
           str(j and j.get("status")))
        j = ws.call("/api/logsettings", "GET")
        ok("未登录不能看日志设置（401）", j and j.get("status") == 401)
        j = ws.call("/api/plc", "POST", {"action": "disconnect"})
        ok("未登录也能改设备连接（现场 Ctrl+Shift+L 直接改；2.1.4 起不设闸门）",
           j and j.get("status") == 200, str(j and j.get("status")))
        j = ws.call("/api/plc", "GET")
        cfg = ((j or {}).get("data") or {}).get("config") or {}
        ok("未登录读设备配置也带口令（对话框要把上次填的带回来，否则改 IP 会清掉口令）",
           "password" in cfg, str(sorted(cfg.keys())))

        # ── 长连接上的登录 ──
        j = ws.request({"t": "session"})
        ok("session 报未登录（闸门开着）", j and j.get("logged_in") is False and j.get("auth_enabled") is True,
           str(j))
        bad = Ws(port)
        j = bad.request({"t": "login", "password": "definitely-wrong"})
        ok("错密码被拒", j and j.get("ok") is False and "密码" in (j.get("error") or ""), str(j))
        bad.close()
        j = ws.request({"t": "login", "password": DEFAULT_PW})
        ok("长连接上登录成功并拿到 token", j and j.get("ok") is True and bool(j.get("token")), str(j))
        token = (j or {}).get("token") or ""
        j = ws.request({"t": "session"})
        ok("登录后 session 报已登录", j and j.get("logged_in") is True)
        j = ws.call("/api/logsettings", "GET")
        ok("登录后能看日志设置", j and j.get("status") == 200 and "keep_days" in (j.get("data") or {}),
           str(j and j.get("status")))

        # token 认不认（刷新页面/重连之后靠它，不用再输密码）
        ws2 = Ws(port, token=token)
        j = ws2.request({"t": "session"})
        ok("带 token 重连＝已登录（刷新页面不用重输密码）", j and j.get("logged_in") is True)
        # 登录过的连接拿得到诊断明细（对端地址只发给管理员）
        ok("登录过的连接拿到 ws.detail（每条连接的收发帧数/空闲秒数）",
           isinstance((ws2.hello or {}).get("ws", {}).get("detail"), list),
           str((ws2.hello or {}).get("ws"))[:120])
        ws2.close()

        # ── 变量：热路径（write/writes/vars/declare）+ call ──
        j = ws.request({"t": "write", "name": "smokeA", "value": 11, "internal": True})
        ok("热路径写变量（{t:'write'}）", j and j.get("ok") is True, str(j))
        j = ws.request({"t": "vars"})
        ok("热路径读变量（{t:'vars'}）", j and (j.get("vars") or {}).get("smokeA") == 11)
        j = ws.request({"t": "writes", "items": [{"name": "smokeA", "value": 12, "internal": True},
                                                 {"name": "smokeB", "value": 13, "internal": True}]})
        ok("热路径批量写（{t:'writes'}）", j and all(r.get("ok") for r in (j.get("results") or [])))
        j = ws.request({"t": "declare",
                        "variables": [{"name": "smokeA", "type": "int", "address": "%MW100"}],
                        "active": ["smokeA"]})
        ok("下发变量表 + 采集范围（{t:'declare'}）", j and j.get("ok") is True, str(j))
        j = ws.call("/api/vars/declare", "POST", {"active": ["smokeA"]})
        ok("call /api/vars/declare（只改采集范围）", j and j.get("status") == 200)
        j = ws.call("/api/vars", "POST", {"name": "smokeA", "value": 21, "internal": True})
        ok("call /api/vars 写值", j and j.get("status") == 200 and (j.get("data") or {}).get("ok") is True)
        j = ws.call("/api/vars", "POST", {"value": 1})
        ok("call /api/vars 缺 name → 400 + 原因",
           j and j.get("status") == 400 and (j.get("data") or {}).get("error"), str(j and j.get("status")))
        j = ws.call("/api/vars/reset", "POST", {})
        ok("call /api/vars/reset（内部变量回初值）", j and j.get("status") == 200)

        # ── 工程存档 ──
        seed = {"meta": {"name": "smoke工程"}, "pages": [{"id": "p1", "type": "page", "widgets": []}]}
        j = ws.call("/api/project", "POST", {"data": seed})
        ok("call 存工程", j and j.get("status") == 200, str(j and j.get("status")))
        j = ws.call("/api/project", "GET")
        ok("call 读工程（存进去的读得回来）",
           j and (((j.get("data") or {}).get("data")) or {}).get("meta", {}).get("name") == "smoke工程")
        j = ws.call("/api/project", "POST", {"data": {"nope": 1}})
        ok("call 存工程（非法数据 → 400）", j and j.get("status") == 400)

        # ── 报警存档 ──
        j = ws.call("/api/alarms", "GET")
        ok("call 读报警历史",
           j and j.get("status") == 200 and isinstance((j.get("data") or {}).get("history"), list))
        j = ws.call("/api/alarms", "POST",
                    {"add": [{"key": "al_smoke", "at": int(time.time() * 1000), "text": "体检",
                              "level": "alarm"}]})
        ok("call 追加报警", j and j.get("status") == 200, str(j and j.get("status")))
        j = ws.call("/api/alarms", "POST", {"patch": [{"key": "al_smoke", "acked": True}]})
        ok("call 补丁（确认）", j and j.get("status") == 200)
        j = ws.call("/api/alarms", "POST", {"clear": True})
        ok("call 清空报警", j and j.get("status") == 200)

        # ── 日志设置 / 脚本日志 ──
        j = ws.call("/api/logsettings", "POST", {"keep_days": 5, "scriptlog_max_mb": 12})
        ok("call 存日志设置", j and j.get("status") == 200, str(j and j.get("status")))
        j = ws.call("/api/scriptlog", "POST", {"lines": [{"t": "info", "s": "smoke", "m": "体检写一行"}]})
        ok("call 写脚本日志（落盘）", j and j.get("status") == 200)
        j = ws.call("/api/scriptlog?limit=10", "GET")
        ok("call 读脚本日志（带 query 也认）",
           j and j.get("status") == 200 and isinstance((j.get("data") or {}).get("lines"), list),
           str(len(((j or {}).get("data") or {}).get("lines") or [])) + " 行")

        # ── 设备 ──
        j = ws.call("/api/plc", "GET")
        d = (j or {}).get("data") or {}
        ok("call 读设备配置+状态", j and j.get("status") == 200 and "config" in d and "status" in d,
           str(j and j.get("status")))
        j = ws.call("/api/plc", "POST", {"action": "connect", "ip": "127.0.0.1", "port": 1, "unit": 1})
        ok("call 连设备（连不上也要给结果，不 500）", j and j.get("status") == 200, str(j and j.get("status")))
        j = ws.call("/api/plc", "POST", {"action": "disconnect"})
        ok("call 断开设备", j and j.get("status") == 200)

        # ── 版本 / 更新（外网关掉了） ──
        j = ws.call("/api/update/check", "GET")
        ok("call 检查更新（外网关掉也不报错）",
           j and j.get("status") == 200 and "state" in ((j.get("data")) or {}),
           str(((j or {}).get("data") or {}).get("state")))

        # ── 未知接口 / 非 /api 路径 ──
        j = ws.call("/api/nope")
        ok("call 未知接口 → 404 + 人话",
           j and j.get("status") == 404 and (j.get("data") or {}).get("error"), str(j and j.get("status")))
        j = ws.call("/index.html", "GET")
        ok("长连接不拿来取页面（403 并说明）", j and j.get("status") == 403, str(j and j.get("status")))

        # ── 在线登记 / 状态 / ping ──
        j = ws.request({"t": "poll", "on": True})
        ok("在线登记（{t:'poll'}）", j and j.get("ok") is True, str(j))
        j = ws.ping()
        ok("应用层 ping → pong", j and j.get("t") == "pong", str(j))
        j = ws.request({"t": "status"})
        ok("设备状态随问随答（{t:'status'}）",
           j and j.get("ok") is True and isinstance(j.get("status"), dict))

        # ── 注销 ──
        j = ws.request({"t": "logout", "token": token})
        ok("注销", j and j.get("ok") is True)
        j = ws.request({"t": "session"})
        ok("注销后 session 报未登录", j and j.get("logged_in") is False)

        fails = [n for n, g in _results if not g]
        print(f"\n==== 后端体检（纯长连接）：{len(_results) - len(fails)}/{len(_results)} 通过 ====")
        if fails:
            print("没过的：" + "、".join(fails))
        return 1 if fails else 0
    finally:
        if ws:
            ws.close()
        try:
            srv.terminate()
            srv.wait(timeout=6)
        except Exception:                                           # noqa: BLE001
            srv.kill()
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
