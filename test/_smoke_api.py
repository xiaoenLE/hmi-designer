#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_smoke_api.py — 后端「所有接口都还活着吗」的快速体检（重构/搬家时用）

为什么要有它：把 server.py 拆成 core/ 下面的一堆模块时，最容易出的错不是逻辑写错，
而是**某个函数搬走了、它依赖的名字没跟着搬**（ImportError / NameError）——
那种错在启动时不一定暴露，往往要等某个接口被调到才炸。完整的 24 个套件跑一轮要十几分钟，
不适合每搬一步都跑。这个是**十秒级**的闸门：起一个隔离后端，把每个路由都打一遍，
谁炸了立刻看得见。

覆盖：health / session / login+logout / vars 读·写·declare·reset / project 读·写 /
alarms 读·写 / plc 读·状态 / logsettings / scriptlog 读·写 / update check /
静态页（/ 与 /run 与 /login）/ 未知路由与错误路径 / **WebSocket 握手 + 收发**。

用法：python test/_smoke_api.py          # 自己起隔离后端
      python test/_smoke_api.py 8877     # 用指定端口起
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable or "python"

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


def req(port, path, method="GET", body=None, ctype="application/json"):
    """返回 (status, 解析后的 body 或原始文本)"""
    data = None
    headers = {}
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        headers["Content-Type"] = ctype
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw
    except Exception as e:                                            # noqa: BLE001
        return 0, {"__err": str(e)}


def ws_roundtrip(port):
    """握手 + ping/pong（不依赖第三方库，客户端帧带掩码）。

    ⚠ "health 里看得到这条连接" 必须在**连接还开着的时候**问 —— 放外面问的话连接已经关了，
    必然是 0（第一次就是这么误报的）。所以连上之后顺手在内部问一次。"""
    import struct
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=8)
    except OSError as e:
        return False, f"连不上：{e}", None
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
              .encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c:
            return False, "握手时连接断了", None
        buf += c
    head, _, buf = buf.partition(b"\r\n\r\n")
    if b" 101 " not in head.split(b"\r\n")[0]:
        return False, head.split(b"\r\n")[0].decode("latin-1"), None

    def send_text(txt):
        payload = txt.encode()
        m = os.urandom(4)
        masked = bytes(b ^ m[i % 4] for i, b in enumerate(payload))
        h = bytearray([0x81])
        n = len(payload)
        if n < 126:
            h.append(0x80 | n)
        else:
            h.append(0x80 | 126)
            h += struct.pack("!H", n)
        s.sendall(bytes(h) + m + masked)

    def read_frame():
        s.settimeout(6)
        try:
            h = b""
            while len(h) < 2:
                c = s.recv(2 - len(h))
                if not c:
                    return None, None
                h += c
            ln = h[1] & 0x7F
            if ln == 126:
                e = s.recv(2)
                ln = struct.unpack("!H", e)[0]
            elif ln == 127:
                e = s.recv(8)
                ln = struct.unpack("!Q", e)[0]
            data = b""
            while len(data) < ln:
                c = s.recv(ln - len(data))
                if not c:
                    return None, None
                data += c
            return h[0] & 0x0F, data
        except OSError:
            return None, None

    try:
        # 连上先该收到 hello（中间可能夹着协议级 ping，跳过）
        hello = None
        for _ in range(12):
            op, data = read_frame()
            if op is None:
                return False, "hello 没到就来断了", None
            if op == 0x1:
                hello = json.loads(data.decode("utf-8"))
                break
        if not hello or hello.get("t") != "hello":
            return False, f"第一帧不是 hello：{hello}", None
        # 连接还开着的时候问一次 health（看得到才说明登记/记账是对的）
        _, hj = req(port, "/api/health")
        seen = (hj.get("ws") or {}).get("clients") if isinstance(hj, dict) else None
        send_text(json.dumps({"t": "ping", "id": 1}))
        for _ in range(12):
            op, data = read_frame()
            if op is None:
                return False, "ping 之后断了", seen
            if op == 0x1:
                j = json.loads(data.decode("utf-8"))
                if j.get("t") == "pong" and j.get("id") == 1:
                    return True, "hello + pong 都拿到了", seen
        return False, "没等到 pong", seen
    finally:
        try:
            s.close()
        except OSError:
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else free_port()
    data = tempfile.mkdtemp(prefix="hmi-smoke-")
    env = {**os.environ, "HMI_DATA_DIR": data, "HMI_UPDATE_URL": ""}   # 关掉外网检查，别拖慢
    srv = subprocess.Popen([PY, str(ROOT / "server" / "server.py"), "--port", str(port),
                            "--no-browser", "--poll-always", "--no-auth"],
                           cwd=str(ROOT), env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        up = False
        for _ in range(60):
            time.sleep(0.25)
            if srv.poll() is not None:                 # 进程自己退了 = 启动就炸
                out = srv.stdout.read().decode("utf-8", "replace")
                print("后端启动就退出了，输出：\n" + out[-3000:])
                return 1
            st, _ = req(port, "/api/health")
            if st == 200:
                up = True
                break
        if not up:
            print("后端没起来")
            return 1

        # ── 健康 / 能力表 ──
        st, j = req(port, "/api/health")
        ok("GET /api/health", st == 200 and j.get("ok") is True)
        ok("health 带 build/features/version/plc/ws/auth",
           all(k in j for k in ("build", "features", "version", "plc", "ws", "auth", "conns", "reqs")),
           f"build={j.get('build')} features={len(j.get('features') or [])}")
        ok("能力表里有 keepalive 与 websocket",
           "keepalive" in (j.get("features") or []) and "websocket" in (j.get("features") or []))

        # 鉴权用 --no-auth 起（和 run-suites 一样，重点是"路由本身还活着"）。
        # 顺手确认闸门本身没被拆坏：另外起一个带闸门的实例代价太大，这里只验 health 里的 auth 字段自洽
        ok("health 里的 auth 段自洽（enabled 与 logged_in 都是布尔）",
           isinstance((j.get("auth") or {}).get("enabled"), bool)
           and isinstance((j.get("auth") or {}).get("logged_in"), bool),
           json.dumps(j.get("auth")))

        # ── 会话 / 登录 ──
        st, j = req(port, "/api/session")
        ok("GET /api/session", st == 200 and "logged_in" in j)
        if (j or {}).get("auth_enabled"):        # 带闸门时错密码必须被拒（--no-auth 下这个接口也放行）
            st, j = req(port, "/api/login", "POST", {"password": "definitely-wrong"})
            ok("POST /api/login 错密码被拒（401）", st == 401, f"status={st}")
        else:
            st, j = req(port, "/api/login", "POST", {"password": "definitely-wrong"})
            ok("POST /api/login 关掉闸门时也不崩", st in (200, 401), f"status={st}")

        # ── 变量 ──
        st, j = req(port, "/api/vars")
        ok("GET /api/vars", st == 200 and isinstance(j.get("vars"), dict) and "meta" in j)
        st, j = req(port, "/api/vars", "POST", {"name": "smokeA", "value": 11, "internal": True})
        ok("POST /api/vars 写内部变量", st == 200 and j.get("ok") is True)
        st, j = req(port, "/api/vars")
        ok("写进去的值读得回来", (j.get("vars") or {}).get("smokeA") == 11)
        st, j = req(port, "/api/vars", "POST", {"value": 1})
        ok("POST /api/vars 缺 name → 400 且有原因", st == 400 and "error" in j)
        st, j = req(port, "/api/vars/declare", "POST",
                    {"variables": [{"name": "smokeA", "type": "int", "address": "%MW100"}], "active": ["smokeA"]})
        ok("POST /api/vars/declare（全表 + 采集范围）", st == 200 and j.get("ok") is True
           and j.get("active") == 1, json.dumps({k: j.get(k) for k in ("active", "blocks", "scoped")}))
        st, j = req(port, "/api/vars/declare", "POST", {"active": ["smokeA"]})
        ok("POST /api/vars/declare（只改采集范围、不动变量表）", st == 200 and j.get("ok") is True)
        st, j = req(port, "/api/vars/reset", "POST", {})
        ok("POST /api/vars/reset", st == 200 and j.get("ok") is True)

        # ── 工程存档 ──
        st, j = req(port, "/api/project")
        ok("GET /api/project", st == 200 and "data" in j)
        seed = {"meta": {"name": "smoke工程"}, "pages": [{"id": "p1", "type": "page", "widgets": []}]}
        st, j = req(port, "/api/project", "POST", {"data": seed})
        ok("POST /api/project 存盘", st == 200, f"status={st}")
        st, j = req(port, "/api/project")
        ok("存进去的工程读得回来", (j.get("data") or {}).get("meta", {}).get("name") == "smoke工程")

        # ── 报警存档 ──
        st, j = req(port, "/api/alarms")
        ok("GET /api/alarms", st == 200 and isinstance(j.get("history"), list))
        st, j = req(port, "/api/alarms", "POST",
                    {"add": [{"key": "al_smoke", "at": int(time.time() * 1000), "text": "体检报警", "level": "alarm"}]})
        ok("POST /api/alarms 追加", st == 200, f"status={st}")
        st, j = req(port, "/api/alarms")
        ok("追加的报警读得回来", any(r.get("key") == "al_smoke" for r in (j.get("history") or [])))
        st, j = req(port, "/api/alarms", "POST", {"patch": [{"key": "al_smoke", "acked": True}]})
        ok("POST /api/alarms 补丁（确认）", st == 200, f"status={st}")
        st, j = req(port, "/api/alarms", "POST", {"clear": True})
        ok("POST /api/alarms 清空", st == 200 and (j.get("history") in ([], None) or j.get("total") == 0),
           json.dumps(j)[:120])

        # ── PLC ──
        st, j = req(port, "/api/plc")
        ok("GET /api/plc", st == 200 and "config" in j and "status" in j)
        ok("设备状态里有 mode/protocol/online", all(k in (j.get("status") or {}) for k in ("mode", "protocol", "online")))
        st, j = req(port, "/api/plc", "POST", {"action": "connect", "ip": "127.0.0.1", "port": 1, "unit": 1})
        ok("POST /api/plc connect（连不上也要给结果，不 500）", st == 200, f"status={st}")
        st, j = req(port, "/api/plc", "POST", {"action": "disconnect"})
        ok("POST /api/plc disconnect", st == 200 and j.get("ok") is True)

        # ── 日志设置 / 脚本日志 ──
        st, j = req(port, "/api/logsettings")
        ok("GET /api/logsettings", st == 200 and "keep_days" in j, f"status={st}")
        st, j = req(port, "/api/logsettings", "POST", {"keep_days": 5, "scriptlog_max_mb": 12})
        ok("POST /api/logsettings", st == 200 and j.get("ok") is True, f"status={st}")
        st, j = req(port, "/api/scriptlog", "POST",
                    {"lines": [{"t": "info", "s": "smoke", "m": "体检写一行"}]})
        ok("POST /api/scriptlog（落盘）", st == 200, f"status={st}")
        st, j = req(port, "/api/scriptlog?limit=10")
        ok("GET /api/scriptlog（读回）", st == 200 and isinstance(j.get("lines"), list),
           f"status={st} lines={len((j or {}).get('lines') or [])}")

        # ── 更新检查（外网关掉了：要给结果、不许报错） ──
        st, j = req(port, "/api/update/check")
        ok("GET /api/update/check（外网关掉也不报错）", st == 200 and "state" in j, f"state={j.get('state')}")

        # ── 静态页 ──
        for path, want in (("/", 200), ("/run", 200), ("/login", 200)):
            st, body = req(port, path)
            ok(f"GET {path} 返回页面", st == 200 and isinstance(body, str) and "<" in body, f"status={st}")

        # ── 错误路径 ──
        st, j = req(port, "/api/nope")
        ok("未知 GET 路由给 404（不是 500）", st == 404, f"status={st}")
        st, j = req(port, "/api/nope", "POST", {})
        ok("未知 POST 路由给 404 + 人话", st == 404 and isinstance(j, dict) and j.get("error"), f"status={st}")
        st, j = req(port, "/api/ws")
        ok("普通 GET /api/ws 给明确提示", st == 400 and "WebSocket" in str(j.get("error", "")), f"status={st}")

        # ── WebSocket ──
        good, why, seen = ws_roundtrip(port)
        ok("WebSocket 握手 + hello + ping/pong", good, why)
        ok("连着的时候 health 里看得到这条长连接", seen == 1, f"clients={seen}")

        fails = [n for n, g in _results if not g]
        print(f"\n==== 后端接口体检：{len(_results) - len(fails)}/{len(_results)} 通过 ====")
        if fails:
            print("没过的：" + "、".join(fails))
        return 1 if fails else 0
    finally:
        try:
            srv.terminate()
            srv.wait(timeout=6)
        except Exception:                                             # noqa: BLE001
            srv.kill()
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
