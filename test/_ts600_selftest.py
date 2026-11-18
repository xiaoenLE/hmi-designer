# -*- coding: utf-8 -*-
"""TS600 地址模型自测（后端链路）。

单文件、不依赖外网：自己起一个 server/plc_sim.py --profile ts600（随机端口），
用同一个 server/modbus.py 当客户端，把「TS600 元件写法 → Modbus 协议地址」这条
链路整条跑一遍；再顺手校验 PlcSource.declare/status 和 api._ep_plc 的模型入口。

跑法（仓库根）：
    python test/_ts600_selftest.py
    python test/_ts600_selftest.py -v        # 每条断言都打印

全过 → 打印汇总，exit 0；任何一条不过 → exit 1。
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
SIM = os.path.join(SERVER, "plc_sim.py")
PY = sys.executable

sys.path.insert(0, SERVER)

import modbus                                                   # noqa: E402

PROFILE = "ts600-modbus-tcp"

CHECKS = []          # [(ok, title, detail)]
VERBOSE = False


def check(ok, title, detail=""):
    CHECKS.append((bool(ok), title, detail))
    if VERBOSE or not ok:
        print(("  [ok]   " if ok else "  [FAIL] ") + title + (f"  — {detail}" if detail else ""))
    return bool(ok)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _http_json(port, path="/api/state", timeout=2.0):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _http_post(port, path, payload, timeout=3.0):
    """返回 (HTTP 状态码, JSON)；网页控制台的接口返回 400 也要能读到 body。"""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


class Sim:
    """起 plc_sim 子进程；输出边读边存，退出时一定收干净。"""

    def __init__(self, port, web_port):
        self.port = port
        self.web_port = web_port
        self.lines = []
        self.proc = None

    def start(self):
        cmd = [PY, SIM, "--profile", "ts600", "--host", "127.0.0.1",
               "--port", str(self.port), "--web-port", str(self.web_port), "--no-browser"]
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        self.proc = subprocess.Popen(cmd, cwd=SERVER, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True,
                                     encoding="utf-8", errors="replace", env=env)
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        try:
            for line in self.proc.stdout:
                self.lines.append(line.rstrip("\n"))
        except Exception:                                       # noqa: BLE001
            pass

    def wait_ready(self, timeout=25.0):
        """从站 + 网页都起来；返回 (ok, 说明)。"""
        t0 = time.time()
        last = ""
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                return False, f"plc_sim 提前退出（exit {self.proc.returncode}）：{self.tail()}"
            cli = modbus.ModbusTcpClient("127.0.0.1", self.port, 1, 0.8)
            try:
                cli.connect()
                cli.read_registers(0, 1)
                return True, ""
            except Exception as e:                              # noqa: BLE001
                last = f"{type(e).__name__}: {e}"
            finally:
                cli.close()
            time.sleep(0.25)
        return False, f"等待 plc_sim 就绪超时（{timeout:.0f}s，最后错误 {last}）；输出：{self.tail()}"

    def tail(self, n=12):
        return " | ".join(self.lines[-n:])

    def stop(self):
        if not self.proc:
            return
        try:
            self.proc.terminate()
            self.proc.wait(timeout=8)
        except Exception:                                       # noqa: BLE001
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:                                   # noqa: BLE001
                pass


# ─────────────────────────────────────────────
#  1) 纯解析：地址模型换算（不用起模拟器）
# ─────────────────────────────────────────────
def test_parse():
    print("[1/8] 地址解析（TS600 元件写法 → 协议地址）")
    setp = modbus.set_profile("ts600") if hasattr(modbus, "set_profile") else None
    check(setp == PROFILE, "set_profile('ts600') 归一化为 ts600-modbus-tcp", f"得到 {setp!r}")
    check(modbus.get_profile() == PROFILE, "get_profile() 生效", modbus.get_profile())
    check(modbus.default_address() == "D0", "默认地址 = D0（TS600）", modbus.default_address())

    def parse(text, vtype=""):
        return modbus.parse_address(text, vtype=vtype)

    a = parse("D100", "uint")
    check((a.area, a.offset, a.words) == ("holding", 100, 1),
          "D100 uint → holding 100，1 字", f"{a.area} {a.offset} words={a.words}")

    a = parse("R100", "uint")
    check((a.area, a.offset) == ("holding", 32868), "R100 → holding 32868", f"{a.area} {a.offset}")

    a = parse("T5", "int")
    check((a.area, a.offset) == ("holding", 57349), "T5 int → holding 57349（字区）", f"{a.area} {a.offset}")

    a = parse("T5", "bool")
    check((a.area, a.offset) == ("coil", 49157), "T5 bool → coil 49157（位区）", f"{a.area} {a.offset}")

    a = parse("C200", "real")
    check((a.area, a.offset, a.words) == ("holding", 58056, 2),
          "C200 real → holding 58056，2 字", f"{a.area} {a.offset} words={a.words}")

    a = parse("C150", "int")
    check((a.area, a.offset, a.words) == ("holding", 58006, 1), "C150 int → holding 58006", f"{a.area} {a.offset}")

    a = parse("Z3", "uint")
    check((a.area, a.offset) == ("holding", 58371), "Z3 → holding 58371", f"{a.area} {a.offset}")

    a = parse("X17", "bool")
    check(a.area == "discrete" and a.offset == 40975 and a.readonly is True,
          "X17 bool → discrete 40975 且只读", f"{a.area} {a.offset} readonly={a.readonly}")

    a = parse("D100[10]", "string")
    check(a.offset == 100 and a.words == 10, "D100[10] string → holding 100，10 字", f"{a.offset} words={a.words}")

    try:
        parse("D32767", "real")
        check(False, "D32767 real 应报越区，实际没报", "")
    except ValueError as e:
        check(("超出" in str(e)) or ("越区" in str(e)), "D32767 real 报越区（中文）", str(e))


# ─────────────────────────────────────────────
#  2) 模拟器联调：读写（word / bit / 双字 / 字符串 / 只读）
# ─────────────────────────────────────────────
def test_sim(sim, cli):
    print("[2/8] 模拟器读写（plc_sim --profile ts600）")
    check(modbus.get_profile() == PROFILE, "客户端也切到 ts600 模型", modbus.get_profile())

    # D100：单字读写
    cli.write_var("D100", 77, vtype="int")
    check(cli.read_var("D100", vtype="int") == 77, "D100 写 77 读回 77",
          str(cli.read_var("D100", vtype="int")))
    check(cli.read_registers(100, 1)[0] == 77, "D100 落在协议寄存器 100", str(cli.read_registers(100, 1)))

    # M10：bool 位
    cli.write_var("M10", True, vtype="bool")
    check(bool(cli.read_var("M10", vtype="bool")) is True, "M10 bool 写 True 读回 True", "")
    check(bool(cli.read_bits(10, 1)[0]), "M10 落在线圈 10", str(cli.read_bits(10, 1)))
    cli.write_var("M10", False, vtype="bool")
    check(bool(cli.read_var("M10", vtype="bool")) is False, "M10 bool 写 False 读回 False", "")

    # T5：int / bool 双语义 —— 两个区互不干扰
    cli.write_var("T5", 1234, vtype="int")
    check(cli.read_var("T5", vtype="int") == 1234, "T5 int 写 1234 读回 1234", "")
    check(bool(cli.read_var("T5", vtype="bool")) is False, "写完 T5 int 后，T5 bool（线圈）仍是 False", "")
    cli.write_var("T5", True, vtype="bool")
    check(bool(cli.read_var("T5", vtype="bool")) is True, "T5 bool 写 True 读回 True", "")
    check(cli.read_var("T5", vtype="int") == 1234, "再写 T5 bool 不影响 T5 int（57349 仍是 1234）",
          str(cli.read_var("T5", vtype="int")))
    check(cli.read_registers(57349, 1)[0] == 1234, "T5 int 落在寄存器 57349", str(cli.read_registers(57349, 1)))

    # C200：REAL 双字
    cli.write_var("C200", 3.5, vtype="real")
    check(abs((cli.read_var("C200", vtype="real") or 0.0) - 3.5) < 1e-6, "C200 REAL 写 3.5 读回 3.5",
          str(cli.read_var("C200", vtype="real")))
    cli.write_var("C200", 123456, vtype="dint")
    check(cli.read_var("C200", vtype="dint") == 123456, "C200 DINT 写 123456 读回 123456",
          str(cli.read_var("C200", vtype="dint")))
    check(len(cli.read_registers(58056, 2)) == 2, "C200 占 58056/58057 两个字", "")

    # C150 int / Z3
    cli.write_var("C150", -7, vtype="int")
    check(cli.read_var("C150", vtype="int") == -7, "C150 int 写 -7 读回 -7", "")
    cli.write_var("Z3", 99, vtype="uint")
    check(cli.read_var("Z3", vtype="uint") == 99, "Z3 写 99 读回 99", "")
    check(cli.read_registers(58371, 1)[0] == 99, "Z3 落在寄存器 58371", "")

    # R100：区偏移
    cli.write_var("R100", 42, vtype="int")
    check(cli.read_var("R100", vtype="int") == 42, "R100 写 42 读回 42", "")
    check(cli.read_registers(32868, 1)[0] == 42, "R100 落在寄存器 32868", "")

    # D100[10]：字符串
    cli.write_var("D100[10]", "HELLO", vtype="string")
    check(cli.read_var("D100[10]", vtype="string") == "HELLO", "D100[10] string 写 HELLO 读回 HELLO",
          repr(cli.read_var("D100[10]", vtype="string")))

    # X17：ts600 下 X 是离散输入，写必须被拒
    a = modbus.parse_address("X17", vtype="bool")
    check(a.readonly, "X17 解析为 只读", str(a))
    try:
        cli.write_var("X17", True, vtype="bool")
        check(False, "写 X17 应抛只读错误，实际写成功了", "")
    except modbus.ModbusError as e:
        check(bool(str(e)), "写 X17 抛 ModbusError（只读）", str(e))

    # 越区地址在客户端这层就报错
    try:
        cli.write_var("D32767", 1.0, vtype="real")
        check(False, "D32767 real 应报越区，实际写成功了", "")
    except ValueError as e:
        check("超出" in str(e) or "越区" in str(e), "D32767 real 写前即报越区", str(e))

    # 网页 /api/state 也要暴露当前模型（调试台顶上显示）
    try:
        st = _http_json(sim.web_port)
        check(st.get("profile") == PROFILE, "/api/state 带 profile", str(st.get("profile")))
        check(bool(st.get("profile_cn")), "/api/state 带 profile_cn", str(st.get("profile_cn")))
        ids = [p.get("id") for p in (st.get("profiles") or [])]
        check("ts600-modbus-tcp" in ids and "invt-modbus-slave" in ids,
              "/api/state 带 models 列表", str(ids))
    except Exception as e:                                      # noqa: BLE001
        check(False, "/api/state 可访问", f"{type(e).__name__}: {e}")

    # 网页「地址控制台」：按当前模型解析；bool 传 "0" 必须真的是 False；X17 写要被拒
    code, r = _http_post(sim.web_port, "/api/console/write",
                         {"address": "M10", "vtype": "bool", "value": "0"})
    check(code == 200 and r.get("ok"), "控制台写 M10 bool '0' 成功", json.dumps(r, ensure_ascii=False))
    check(bool(cli.read_var("M10", vtype="bool")) is False,
          "控制台 '0' 写成 False（不是 bool('0')=True）", "")
    code, r = _http_post(sim.web_port, "/api/console/write",
                         {"address": "M10", "vtype": "bool", "value": "1"})
    check(code == 200 and bool(cli.read_var("M10", vtype="bool")) is True,
          "控制台写 M10 bool '1' 读回 True", "")
    code, r = _http_post(sim.web_port, "/api/console/write",
                         {"address": "D200", "vtype": "real", "value": "12.5"})
    check(code == 200 and abs((cli.read_var("D200", vtype="real") or 0.0) - 12.5) < 1e-6,
          "控制台写 D200 real 12.5 读回", json.dumps(r, ensure_ascii=False))
    code, r = _http_post(sim.web_port, "/api/console/read", {"address": "D200", "vtype": "real"})
    check(code == 200 and abs((r.get("value") or 0.0) - 12.5) < 1e-6, "控制台读 D200 real 12.5", str(r))
    code, r = _http_post(sim.web_port, "/api/console/write",
                         {"address": "X17", "vtype": "bool", "value": True})
    check(code == 400 and r.get("ok") is False
          and ("只读" in (r.get("error") or "") or "输入" in (r.get("error") or "")),
          "控制台写 X17 被拒（400，只读）", json.dumps(r, ensure_ascii=False))


# ─────────────────────────────────────────────
#  3) PlcSource：declare 的模型校验 + status 带模型
# ─────────────────────────────────────────────
def test_plcsource(port):
    print("[3/8] PlcSource.declare / status")
    from core.plcsource import PlcSource
    import poll_gate
    # 轮询闸门默认「有人看运行画面才通讯」；自测里没有网页在跑，手动放行
    prev_gate = poll_gate.is_always()
    poll_gate.set_always(True)
    src = PlcSource("127.0.0.1", port, 1, poll_ms=100)
    try:
        src.declare([
            {"name": "d100", "type": "uint", "address": "D100"},
            {"name": "t5i", "type": "int", "address": "T5"},
            {"name": "t5b", "type": "bool", "address": "T5"},
            {"name": "x17", "type": "bool", "address": "X17"},
            {"name": "bad", "type": "real", "address": "D32767"},
        ])
        v = src._vars
        check(v["d100"]["parsed"].offset == 100, "PlcSource D100 解析 offset=100", str(v["d100"]["parsed"]))
        check(v["t5i"]["parsed"].area == "holding" and v["t5b"]["parsed"].area == "coil",
              "同一 T5：int 走 holding、bool 走 coil", f'{v["t5i"]["parsed"].area} / {v["t5b"]["parsed"].area}')
        check(v["x17"]["parsed"].readonly is True, "PlcSource X17 readonly", str(v["x17"]["parsed"]))
        check(bool(v["bad"]["addr_error"]) and v["bad"]["parsed"] is None,
              "PlcSource 越区地址进 addr_error（不崩）", v["bad"]["addr_error"])
        st = src.status()
        check(st.get("addr_profile") == PROFILE, "status.addr_profile", str(st.get("addr_profile")))
        check(bool(st.get("addr_profile_cn")), "status.addr_profile_cn", str(st.get("addr_profile_cn")))

        src.start()
        deadline = time.time() + 10
        while time.time() < deadline and not src.online:
            time.sleep(0.1)
        check(src.online, "PlcSource 连上 plc_sim", src.last_error)
        if src.online:
            src.write("d100", 88)
            time.sleep(0.4)
            check(src.read("d100") == 88, "PlcSource 写 D100=88 读回", str(src.read("d100")))
            src.write("t5b", True)
            time.sleep(0.4)
            check(bool(src.read("t5b")) is True, "PlcSource 写 T5 bool=True 读回", str(src.read("t5b")))
            st = src.status()
            check(st.get("addr_profile") == PROFILE, "在线 status 仍带模型", str(st.get("addr_profile")))
    finally:
        try:
            src.stop()
        except Exception:                                       # noqa: BLE001
            pass
        poll_gate.set_always(prev_gate)


# ─────────────────────────────────────────────
#  3.5) 采集计划：位区（M/S/X/Y）必须分段——跨区请求 TS600 会整块判 02 异常
# ─────────────────────────────────────────────
def test_plan_split():
    print("[3.5/8] PlcSource._plan 位区分块")
    from core.plcsource import PlcSource
    src = PlcSource("127.0.0.1", 502, 1, poll_ms=100)
    src.declare([
        {"name": "m10", "type": "bool", "address": "M10"},
        {"name": "m32767", "type": "bool", "address": "M32767"},
        {"name": "s0", "type": "bool", "address": "S0"},
        {"name": "s4095", "type": "bool", "address": "S4095"},
        {"name": "x0", "type": "bool", "address": "X0"},
        {"name": "x100", "type": "bool", "address": "X100"},
        {"name": "y0", "type": "bool", "address": "Y0"},
        {"name": "y10", "type": "bool", "address": "Y10"},
        {"name": "y100", "type": "bool", "address": "Y100"},
    ])
    plan = src._plan()
    coils = [b for b in plan if b[0] == "coil"]
    names = [m[0] for b in plan for m in b[3]]
    # 以前：整个线圈区合成一块、跨距 >512 就整块丢掉 → 9 个位变量一个都不采
    check(len(set(names)) == 9, "位变量全部进了采集计划（一个都不漏）", str(sorted(names)))
    check(any(b[1] == 10 and b[2] == 1 for b in coils), "M10 单独一块")
    check(any(b[1] == 32767 and b[2] == 1 for b in coils),
          "M32767 与 S0 切成两块（跨区请求会被从站拒绝）",
          str([(b[1], b[2]) for b in coils]))
    check(any(b[1] == 32768 and b[2] == 1 for b in coils), "S0 独立一块")
    check(any(b[1] == 45056 and b[2] == 65 for b in coils),
          "Y0~Y100（八进制 100=64）并成 65 位一块", str([(b[1], b[2]) for b in coils]))
    bad = []
    for b in coils:
        z = modbus.bit_zone(b[1])
        if not z or b[1] + b[2] - 1 > z[1]:
            bad.append((b[1], b[2]))
    check(not bad, "每个线圈块都在同一个元件区内", str(bad))
    disc = [b for b in plan if b[0] == "discrete"]
    check(any(b[1] == 40960 and b[2] == 65 for b in disc), "X0~X100 并成 65 位一块",
          str([(b[1], b[2]) for b in disc]))


# ─────────────────────────────────────────────
#  3.6) 轮询节拍：poll_ms 最小 1ms = 「尽可能快」（实测周期 = 读一轮的耗时）
# ─────────────────────────────────────────────
def test_poll_pace(port):
    print("[3.6/8] 轮询节拍（poll_ms=1 不再被夹成 50；cycle_ms/round_ms 上报）")
    from core.plcsource import PlcSource
    import poll_gate
    prev_gate = poll_gate.is_always()
    poll_gate.set_always(True)
    src = PlcSource("127.0.0.1", port, 1, poll_ms=1)
    try:
        src.declare([
            {"name": "m10", "type": "bool", "address": "M10"},
            {"name": "s0", "type": "bool", "address": "S0"},
            {"name": "y10", "type": "bool", "address": "Y10"},
            {"name": "d100", "type": "int", "address": "D100"},
        ])
        src.start()
        deadline = time.time() + 10
        while time.time() < deadline and src.reads < 20:
            time.sleep(0.1)
        st = src.status()
        check(st.get("poll_ms") == 1, "poll_ms=1 不再被夹成 50（最小改成 1ms）", str(st.get("poll_ms")))
        check((st.get("round_ms") or 0) > 0, "status.round_ms 上报「读一轮花了多少 ms」", str(st.get("round_ms")))
        cyc, rnd = st.get("cycle_ms") or 0, st.get("round_ms") or 0
        check(cyc >= rnd * 0.9, "poll_ms=1 时 cycle_ms ≈ 读一轮的耗时（不 sleep、不排队）",
              f"cycle={cyc} round={rnd}")
        check(cyc < 50, "poll_ms=1 实测周期 < 50ms（比原来的 50ms 下限快）", str(cyc))
        check(src.reads >= 20, "1ms 目标下一小会儿就读了几十次", str(src.reads))
    finally:
        try:
            src.stop()
        except Exception:                                       # noqa: BLE001
            pass
        poll_gate.set_always(prev_gate)


# ─────────────────────────────────────────────
#  4) api._ep_plc：profiles / parse / test / 非法模型
# ─────────────────────────────────────────────
def test_api(port):
    print("[4/8] api._ep_plc（profiles / parse / test / 非法模型）")
    try:
        import core.api as api
    except Exception as e:                                      # noqa: BLE001
        check(False, "导入 core.api", f"{type(e).__name__}: {e}")
        return

    status, p = api._ep_plc({"action": "profiles"})
    ids = [x.get("id") for x in (p.get("profiles") or [])]
    check(status == 200 and p.get("ok") and "ts600-modbus-tcp" in ids,
          "action=profiles 返回注册表", str(ids))
    check(p.get("current") in ids, "action=profiles 带 current", str(p.get("current")))

    status, p = api._ep_plc({"action": "parse", "address": "D100", "vtype": "uint",
                             "addr_profile": "ts600"})
    check(status == 200 and p.get("ok") and p.get("offset") == 100,
          "parse D100 → offset 100", json.dumps(p, ensure_ascii=False))
    check(p.get("profile") == PROFILE and p.get("readonly") is False and p.get("kind"),
          "parse 返回 profile/readonly/kind", json.dumps({k: p.get(k) for k in
          ("profile", "readonly", "kind")}, ensure_ascii=False))

    status, p = api._ep_plc({"action": "parse", "address": "X17", "vtype": "bool",
                             "addr_profile": "ts600"})
    check(p.get("ok") and p.get("readonly") is True and p.get("offset") == 40975,
          "parse X17 → discrete 40975 readonly", json.dumps({k: p.get(k) for k in
          ("area", "offset", "readonly")}, ensure_ascii=False))

    status, p = api._ep_plc({"action": "parse", "address": "D32767", "vtype": "real",
                             "addr_profile": "ts600"})
    check(p.get("ok") is False and ("超出" in (p.get("message") or "") or "越区" in (p.get("message") or "")),
          "parse 越区地址 → ok False（中文原因）", str(p.get("message")))

    status, p = api._ep_plc({"action": "test", "ip": "127.0.0.1", "port": port, "unit": 1,
                             "addr_profile": "ts600"})
    check(status == 200 and p.get("ok") is True,
          "test 连接按 TS600 默认地址 D0 探活", json.dumps(p, ensure_ascii=False))
    check(p.get("addr_profile") == PROFILE and p.get("address") == "D0",
          "test 返回 addr_profile/address", f'{p.get("addr_profile")} / {p.get("address")}')
    check(modbus.get_profile() == PROFILE, "test 探完把模型切回原样", modbus.get_profile())

    status, p = api._ep_plc({"action": "test", "ip": "127.0.0.1", "port": port, "unit": 1,
                             "addr_profile": "没有这个模型"})
    check(status == 400 and p.get("ok") is False and "不认识" in (p.get("error") or ""),
          "非法模型 → 400 中文", str(p))

    status, p = api._ep_plc({"action": "connect", "protocol": "modbus", "ip": "127.0.0.1",
                             "port": port, "addr_profile": "没有这个模型"})
    check(status == 400 and "不认识" in (p.get("error") or ""), "connect 非法模型 → 400", str(p))


# ─────────────────────────────────────────────
#  5) datasource：保持历史记忆（不改 plc.json，只查状态字段）
# ─────────────────────────────────────────────
def test_datasource_fields():
    print("[5/8] datasource 内存模式 status 带模型")
    try:
        from core import datasource
        raw = datasource._source_status_raw()
        check("addr_profile" in raw and "addr_profile_cn" in raw,
              "内存模式 status 带 addr_profile/addr_profile_cn", str(raw.get("addr_profile")))
        check(raw.get("mode") == "memory", "当前是内存模式（未动用户配置）", str(raw.get("mode")))
    except Exception as e:                                      # noqa: BLE001
        check(False, "datasource 状态可读", f"{type(e).__name__}: {e}")


# ─────────────────────────────────────────────
#  6) 端到端：plc_connect 存 addr_profile（用临时 plc.json，不碰现场配置）
# ─────────────────────────────────────────────
def test_plc_connect_save(port):
    print("[6/8] plc_connect 端到端（临时 plc.json，不动现场配置）")
    import tempfile
    from pathlib import Path
    from core import datasource, plcsource

    prev_file = plcsource.PLCFG_FILE
    prev_cfg = dict(plcsource._plc_cfg)
    tmpdir = tempfile.mkdtemp(prefix="ts600_selftest_")
    plcsource.PLCFG_FILE = Path(tmpdir) / "plc.json"
    try:
        st = datasource.plc_connect(
            {"protocol": "modbus", "ip": "127.0.0.1", "port": port, "unit": 1,
             "poll_ms": 100, "addr_profile": "ts600"},
            [{"name": "d100", "type": "uint", "address": "D100"}])
        check(st.get("addr_profile") == PROFILE, "plc_connect 返回 status 带 ts600",
              str(st.get("addr_profile")))
        src = datasource.get_source()
        check(src._vars["d100"]["parsed"].offset == 100,
              "建源后 declare 按 TS600 解析（D100 → 100）", str(src._vars["d100"]["parsed"]))
        with open(plcsource.PLCFG_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        check(saved.get("addr_profile") == PROFILE,
              "plc.json 里存了 addr_profile=ts600", str(saved.get("addr_profile")))
        check(saved.get("mode") == "plc", "plc.json mode=plc", str(saved.get("mode")))
        check(plcsource._plc_cfg.get("addr_profile") == PROFILE,
              "_plc_cfg 内存里也记了模型", str(plcsource._plc_cfg.get("addr_profile")))
    finally:
        try:
            datasource.plc_disconnect()
        except Exception:                                       # noqa: BLE001
            pass
        plcsource.PLCFG_FILE = prev_file
        plcsource._plc_cfg.clear()
        plcsource._plc_cfg.update(prev_cfg)
        modbus.set_profile("ts600")
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


# ─────────────────────────────────────────────
#  7) 三协议选项 + 地址写法不匹配 → 内部变量（不采集、不报错）
# ─────────────────────────────────────────────
def test_protocol_mismatch(port):
    print("[7/8] 三协议选项 + 地址不匹配当内部变量")
    from core import datasource, plcsource

    # ① INVT 模型下写 TS600 元件写法 → UnsupportedAddress
    modbus.set_profile("invt")
    for addr in ("D100", "M10", "X17", "C200"):
        try:
            modbus.parse_address(addr, vtype="uint")
            raised, msg = False, "没抛异常（这不对）"
        except modbus.UnsupportedAddress as e:
            raised, msg = True, str(e)
        except ValueError as e:                                 # noqa: BLE001
            raised, msg = False, f"普通 ValueError：{e}"
        check(raised, f"INVT 模型 parse {addr} 抛 UnsupportedAddress", msg)

    # ② TS600 模型下写 %MX/%QX/%QW/%QB/%IX/%IW/%IB/%ID → UnsupportedAddress（TS 没有字内取位）
    modbus.set_profile("ts600")
    for addr, vt in (("%MX0.0", "bool"), ("%QX0.0", "bool"), ("%QW3", "uint"),
                     ("%QB3", "uint"), ("%IX5", "bool"), ("%IW5", "uint"),
                     ("%IB5", "uint"), ("%ID5", "uint"), ("%M0", "bool"),
                     ("%M10.2", "bool"), ("%B0", "uint")):
        try:
            modbus.parse_address(addr, vtype=vt)
            raised, msg = False, "没抛异常（这不对）"
        except modbus.UnsupportedAddress as e:
            raised, msg = True, str(e)
        except ValueError as e:                                 # noqa: BLE001
            raised, msg = False, f"普通 ValueError：{e}"
        check(raised, f"TS600 模型 parse {addr} 抛 UnsupportedAddress", msg)

    # ③ PlcSource.declare：写法不匹配 → internal=True，不进 bad_address、不进采集块
    src = plcsource.PlcSource("127.0.0.1", port, 1, 200)
    try:
        modbus.set_profile("invt")
        src.declare([
            {"name": "ts_addr", "type": "uint", "address": "D100"},
            {"name": "bad_addr", "type": "real", "address": "ZZZ"},
        ])
        v = src._vars
        check(v["ts_addr"]["internal"] is True and v["ts_addr"]["parsed"] is None
              and bool(v["ts_addr"].get("addr_note")),
              "INVT 下 D100 → internal=True + addr_note", str(v["ts_addr"].get("addr_note")))
        check(v["bad_addr"].get("internal") is False and bool(v["bad_addr"]["addr_error"]),
              "真错误（认不出）仍进 addr_error", str(v["bad_addr"].get("addr_error")))
        st = src.status()
        names = [x["name"] for x in st["internal_by_addr"]]
        check("ts_addr" in names, "status.internal_by_addr 含写法不匹配变量", str(names))
        check("ts_addr" not in st["bad_address"] and "bad_addr" in st["bad_address"],
              "bad_address 只留真错误", str(st["bad_address"]))
        meta = src.meta()
        check(meta["ts_addr"].get("internal") is True and bool(meta["ts_addr"].get("addr_note")),
              "meta 带 internal/addr_note", json.dumps(meta["ts_addr"], ensure_ascii=False))
        check(src.plan_count() == 0, "写法不匹配的变量不进采集块（离线 0 块）", str(src.plan_count()))

        # 换成 TS600 模型：%MX0.0 变内部变量，D100 恢复正常解析
        modbus.set_profile("ts600")
        src.declare([
            {"name": "mx_addr", "type": "bool", "address": "%MX0.0"},
            {"name": "d100", "type": "uint", "address": "D100"},
        ])
        v = src._vars
        check(v["mx_addr"]["internal"] is True and not v["d100"].get("internal"),
              "TS 下 %MX0.0 internal、D100 正常",
              f'{v["mx_addr"]["internal"]} / {v["d100"].get("internal")}')
        check(src.write("mx_addr", True) is True and src.read("mx_addr") is True,
              "内部变量写值走本地（不碰 PLC）", str(src.read("mx_addr")))
    finally:
        try:
            src.stop()
        except Exception:                                       # noqa: BLE001
            pass

    # ④ api 层协议别名 + 非法协议
    try:
        import core.api as api
    except Exception as e:                                      # noqa: BLE001
        check(False, "导入 core.api", f"{type(e).__name__}: {e}")
        return
    for prot in ("ts600", "ts", "modbus_ts", "ts600_tcp", "TS600"):
        status, p = api._ep_plc({"action": "parse", "protocol": prot, "address": "D100",
                                 "vtype": "uint"})
        ok = status == 200 and p.get("ok") and p.get("offset") == 100
        check(ok, f"protocol={prot} 按 TS600 解析 D100", json.dumps(p, ensure_ascii=False)[:160])
    status, p = api._ep_plc({"action": "test", "protocol": "bogus", "ip": "127.0.0.1",
                             "port": port})
    check(status == 400 and "不认识" in (p.get("error") or ""),
          "非法 protocol → 400 中文", str(p))
    status, p = api._ep_plc({"action": "parse", "protocol": "modbus",
                             "addr_profile": "invt", "address": "D100"})
    check(status == 200 and p.get("ok") is False and p.get("unsupported") is True and p.get("message"),
          "parse INVT+D100 → unsupported（前端标内部变量）",
          json.dumps(p, ensure_ascii=False)[:200])

    # ⑤ plc_connect：protocol=ts600 落成 protocol=modbus + addr_profile=ts600-modbus-tcp
    import tempfile
    from pathlib import Path
    prev_file = plcsource.PLCFG_FILE
    prev_cfg = dict(plcsource._plc_cfg)
    tmpdir = tempfile.mkdtemp(prefix="ts600_proto_")
    plcsource.PLCFG_FILE = Path(tmpdir) / "plc.json"
    try:
        st = datasource.plc_connect({"protocol": "ts600", "ip": "127.0.0.1", "port": port,
                                     "unit": 1, "poll_ms": 100},
                                    [{"name": "d100", "type": "uint", "address": "D100"}])
        check(st.get("addr_profile") == PROFILE, "protocol=ts600 → status 带 ts600",
              str(st.get("addr_profile")))
        check(st.get("protocol") == "modbus", "返回 status.protocol 仍是 modbus",
              str(st.get("protocol")))
        with open(plcsource.PLCFG_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        check(saved.get("protocol") == "modbus" and saved.get("addr_profile") == PROFILE,
              "plc.json 存成 modbus + ts600",
              json.dumps({k: saved.get(k) for k in ("protocol", "addr_profile")},
                         ensure_ascii=False))
        check(datasource.get_source()._vars["d100"]["parsed"].offset == 100,
              "protocol=ts600 建源后按 TS600 解析 D100", str(datasource.get_source()._vars["d100"]["parsed"]))

        st2 = datasource.plc_connect({"protocol": "modbus", "addr_profile": PROFILE,
                                      "ip": "127.0.0.1", "port": port, "unit": 1,
                                      "poll_ms": 100})
        check(st2.get("addr_profile") == PROFILE and st2.get("protocol") == "modbus",
              "protocol=modbus+addr_profile 等价",
              f'{st2.get("protocol")}/{st2.get("addr_profile")}')

        # ts 协议必须覆盖请求里写错的 addr_profile
        st3 = datasource.plc_connect({"protocol": "ts", "addr_profile": "invt",
                                      "ip": "127.0.0.1", "port": port, "unit": 1,
                                      "poll_ms": 100})
        check(st3.get("addr_profile") == PROFILE, "protocol=ts 覆盖 addr_profile=invt",
              str(st3.get("addr_profile")))
        with open(plcsource.PLCFG_FILE, encoding="utf-8") as f:
            saved3 = json.load(f)
        check(saved3.get("protocol") == "modbus" and saved3.get("addr_profile") == PROFILE,
              "覆盖后 plc.json 仍是 modbus+ts600",
              json.dumps({k: saved3.get(k) for k in ("protocol", "addr_profile")},
                         ensure_ascii=False))
    finally:
        try:
            datasource.plc_disconnect()
        except Exception:                                       # noqa: BLE001
            pass
        plcsource.PLCFG_FILE = prev_file
        plcsource._plc_cfg.clear()
        plcsource._plc_cfg.update(prev_cfg)
        modbus.set_profile("ts600")
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_opcua_mismatch():
    print("[8/8] OPC UA：Modbus/TS600 写法 → 内部变量（真 NodeId 错仍报错）")
    try:
        import opcua
    except Exception as e:                                       # noqa: BLE001
        check(False, "导入 server/opcua.py", f"{type(e).__name__}: {e}")
        return
    # 纯函数：哪些写法一眼就不是 NodeId（裸 "D100" 会被 parse_node_id 当字符串 NodeId 而不报错，
    # 所以必须先做风格判断）
    for raw in ("D100", "%MW100", "HR10", "4X3", "123", "M10"):
        check(opcua.looks_like_modbus_address(raw), f"识别 Modbus 写法 {raw}", "True")
    for raw in ("ns=4;s=PLC_PRG.x", "opc.tcp://127.0.0.1:4840", "|var|PLC_PRG.x", ""):
        check(not opcua.looks_like_modbus_address(raw), f"不误判 NodeId 写法 {raw!r}", "False")

    src = opcua.OpcUaSource("opc.tcp://127.0.0.1:4840")
    src.declare([
        {"name": "ts_addr", "type": "uint", "address": "D100"},
        {"name": "mw_addr", "type": "uint", "address": "%MW100"},
        {"name": "good_node", "type": "uint", "address": "ns=4;s=PLC_PRG.x"},
        {"name": "bad_node", "type": "real", "address": "opc.tcp://127.0.0.1:4840"},
    ])
    v = src._vars
    check(v["ts_addr"].get("internal") is True
          and "OPC UA 要填 NodeId" in (v["ts_addr"].get("addr_note") or ""),
          "OPC UA 下 D100 → internal + addr_note",
          (v["ts_addr"].get("addr_note") or "")[:60])
    check(v["mw_addr"].get("internal") is True, "OPC UA 下 %MW100 → internal", "")
    check(v["good_node"].get("internal") is False
          and v["good_node"].get("nodeid") == "ns=4;s=PLC_PRG.x",
          "真 NodeId 正常解析", str(v["good_node"].get("nodeid")))
    check(not v["good_node"].get("addr_error"), "真 NodeId 无 addr_error", "")
    check(bool(v["bad_node"].get("addr_error")), "真 NodeId 写错仍进 addr_error",
          (v["bad_node"].get("addr_error") or "")[:60])
    st = src.status()
    names = [x["name"] for x in st.get("internal_by_addr", [])]
    check("ts_addr" in names and "mw_addr" in names, "status.internal_by_addr 含不匹配变量",
          str(names))
    check("bad_node" in (st.get("bad_address") or []), "bad_address 只留真错误的 NodeId",
          str(st.get("bad_address")))
    meta = src.meta()
    check(meta.get("ts_addr", {}).get("internal") is True
          and bool(meta.get("ts_addr", {}).get("addr_note")),
          "meta 带 internal/addr_note",
          json.dumps(meta.get("ts_addr"), ensure_ascii=False)[:80])


# ─────────────────────────────────────────────
#  主流程
# ─────────────────────────────────────────────
def main():
    global VERBOSE
    ap = argparse.ArgumentParser(description="TS600 地址模型后端链路自测")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    VERBOSE = args.verbose
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:                                       # noqa: BLE001
            pass

    print("TS600 地址模型自测（仓库 %s）" % ROOT)
    test_parse()

    port, web_port = _free_port(), _free_port()
    sim = Sim(port, web_port)
    cli = None
    try:
        print(f"[启动] plc_sim --profile ts600（modbus 127.0.0.1:{port}，网页 :{web_port}）")
        sim.start()
        ok, why = sim.wait_ready()
        if not check(ok, "plc_sim 启动并就绪", why):
            return finish()
        modbus.set_profile("ts600")
        cli = modbus.ModbusTcpClient("127.0.0.1", port, 1, 1.5)
        cli.connect()
        test_sim(sim, cli)
        test_plcsource(port)
        test_plan_split()
        test_poll_pace(port)
        test_api(port)
        test_datasource_fields()
        test_plc_connect_save(port)
        test_protocol_mismatch(port)
        test_opcua_mismatch()
    finally:
        try:
            if cli:
                cli.close()
        except Exception:                                       # noqa: BLE001
            pass
        sim.stop()
        # Windows 上 terminate() 由 TerminateProcess 收尾，退出码 1 是正常的；0 也算正常
        if sim.proc and sim.proc.returncode not in (0, 1, None):
            print(f"  (plc_sim 退出码 {sim.proc.returncode})")
        if any(not ok for ok, _, _ in CHECKS[-3:]) or not CHECKS:
            print("  plc_sim 输出尾部：" + sim.tail(15))
    return finish()


def finish():
    total = len(CHECKS)
    bad = [c for c in CHECKS if not c[0]]
    print("")
    print(f"结果：{total - len(bad)}/{total} 项通过")
    if bad:
        print("失败项：")
        for _, title, detail in bad:
            print(f"  - {title}" + (f"  — {detail}" if detail else ""))
        print("TS600 自测：FAILED")
        return 1
    print("TS600 自测：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
