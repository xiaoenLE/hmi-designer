#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify-frp-orphan.py — frpc 不许留在机器上跑（现场报的 bug：软件关了它还在跑）

为什么单独测这两条：它们都跟"后端进程**怎么没的**"有关，用 HTTP 测不到 ——
 · A. job object：后端被**强杀**（taskkill /F / 任务管理器 / 关控制台窗口）时，
      内核要把 frpc 一起收掉。只靠 atexit()/finally 是收不住的，那些路径根本不跑 Python 代码。
 · B. 收尸（reap_stale）：万一 job 没绑上（老版本、权限）留下的野 frpc，下次后端起来按
      <数据目录>/frp/frpc.pid 收掉；而且**只收自己起的那个**（pid 被复用、不是同一个 exe 就不许动）。

跑法（tools/run-suites.mjs 会带上端口参数，本套件不用）：
  python test/verify-frp-orphan.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
PY = sys.executable
NOP = 0x08000000 if os.name == "nt" else 0        # CREATE_NO_WINDOW
# 子进程说的是中文（UTF-8）：别按 GBK 解，不然读回来是 None
OUT = {"encoding": "utf-8", "errors": "replace"}

try:                                              # 控制台按 UTF-8 说话（不然中文全成乱码）
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                 # noqa: BLE001
    pass

_passed = 0
_failed = 0


def ok(name, cond, info=""):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"PASS  {name}" + (f"  [{info}]" if info else ""))
    else:
        _failed += 1
        print(f"FAIL  {name}  [{info}]")


WORK = Path(tempfile.mkdtemp(prefix="hmi-frp-orphan-"))
DATA = WORK / "data"
LOGS = WORK / "logs"
DATA.mkdir(parents=True, exist_ok=True)
LOGS.mkdir(parents=True, exist_ok=True)

ENV = {**os.environ, "HMI_DATA_DIR": str(DATA), "HMI_LOG_DIR": str(LOGS),
       "PYTHONIOENCODING": "utf-8", "PYTHONPATH": str(SERVER)}

# 假 frpc：一个睡着的 Python 进程（真的进程，能查 pid、能被强杀；收尸那关认的也是它）
SLEEPER = WORK / "sleeper.py"
SLEEPER.write_text("import time\ntime.sleep(600)\n", encoding="utf-8")


def alive(pid):
    """pid 还活着吗（Windows 上用 tasklist，稳一点）"""
    if not pid:
        return False
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {int(pid)}", "/NH"],
                             capture_output=True, text=True, **OUT).stdout or ""
        return str(int(pid)) in out
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:                                            # noqa: BLE001
        return False


def kill_tree(pid):
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/PID", str(int(pid))],
                       capture_output=True, text=True, **OUT)
    else:
        try:
            os.kill(int(pid), 9)
        except Exception:                                        # noqa: BLE001
            pass


def run_py(code, env=None):
    """跑一小段 python（把 frp 的结论带回来），stdout 按 UTF-8 解

    @returns (最后一行 = 我们要的结论, 完整 stdout) —— frp 自己会 print 一句"收掉…"，
             所以结论取最后一行（前面那些是给日志看的）
    """
    p = subprocess.run([PY, "-c", f"import sys; sys.path.insert(0, r'{SERVER}'); {code}"],
                       capture_output=True, text=True, env=env or ENV, **OUT)
    out = (p.stdout or "").strip()
    return (out.splitlines()[-1].strip() if out else ""), out


# ── ① job object：起 frpc 的那个进程被强杀 → frpc 跟着死 ────────────────
SPAWNER = WORK / "spawner.py"
SPAWNER.write_text(f'''
import os, subprocess, sys, time
sys.path.insert(0, r"{SERVER}")
from core import frp

p = subprocess.Popen([r"{PY}", r"{SLEEPER}"], creationflags={NOP},
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
bound = frp.bind_lifetime(p)
open(r"{WORK / 'child.pid'}", "w").write(str(p.pid))
open(r"{WORK / 'bound.txt'}", "w").write("1" if bound else "0")
time.sleep(600)          # 等着被强杀（模拟"关软件"时那种不给收尾机会的死法）
''', encoding="utf-8")

sp = subprocess.Popen([PY, str(SPAWNER)], creationflags=NOP,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
child_pid = 0
bound = "0"
for _ in range(60):                                   # 等它把子进程 pid 写出来
    time.sleep(0.15)
    try:
        child_pid = int((WORK / "child.pid").read_text())
        bound = (WORK / "bound.txt").read_text().strip()
        break
    except Exception:                                         # noqa: BLE001
        pass
ok("起得来：假 frpc 起来了，并且绑进了 job（KILL_ON_JOB_CLOSE）",
   child_pid > 0 and alive(child_pid), f"frpc pid={child_pid} bound={bound}")
ok("绑得上 job（AssignProcessToJobObject 成功；绑不上这关就没意义了）", bound == "1", bound)

kill_tree(sp.pid)                                     # ← 强杀"后端"：不给 atexit/finally 机会
time.sleep(1.5)
ok("★ 强杀后端（taskkill /F，跑不到任何收尾代码）→ frpc 自己也没了",
   not alive(child_pid), f"frpc pid={child_pid}")

# ── ② 收尸：上次没善终留下的野 frpc，下次起来收掉；不是自己的不许动 ──────
FRP_DIR = DATA / "frp"
FRP_DIR.mkdir(parents=True, exist_ok=True)
PID_FILE = FRP_DIR / "frpc.pid"

# 一个"上一个后端"（已经死了的 owner）留下的野 frpc
stray = subprocess.Popen([PY, str(SLEEPER)], creationflags=NOP,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.6)
PID_FILE.write_text(json.dumps({"pid": stray.pid, "exe": PY,
                                "owner": 999999, "at": time.time()}), encoding="utf-8")   # owner 早就没了

reap, _err = run_py("from core import frp; print(frp.reap_stale())")
time.sleep(1.0)
ok("★ 上次遗留的野 frpc：后端一起来就把它收掉了（照 pid 文件认人）",
   reap == str(stray.pid) and not alive(stray.pid),
   f"reap={reap} 期望={stray.pid} 还活着={alive(stray.pid)}")

# 不是我们起的（pid 是别人的 / 换个 exe）→ 一根手指头都不许碰
innocent = subprocess.Popen([PY, str(SLEEPER)], creationflags=NOP,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.6)
PID_FILE.write_text(json.dumps({"pid": innocent.pid, "exe": r"C:\nonexistent\frpc.exe",
                                "owner": 999998, "at": time.time()}), encoding="utf-8")
reap2, _err = run_py("from core import frp; print(frp.reap_stale())")
time.sleep(0.6)
ok("认错人会出人命：pid 对不上 exe（不是自己起的）→ 绝不杀",
   reap2 == "0" and alive(innocent.pid),
   f"reap={reap2} 还活着={alive(innocent.pid)}")

# 上一个后端还活着（owner 在场）→ 别抢别人的 frpc
owner = subprocess.Popen([PY, str(SLEEPER)], creationflags=NOP,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
kid = subprocess.Popen([PY, str(SLEEPER)], creationflags=NOP,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.6)
PID_FILE.write_text(json.dumps({"pid": kid.pid, "exe": PY,
                                "owner": owner.pid, "at": time.time()}), encoding="utf-8")
reap3, _err = run_py("from core import frp; print(frp.reap_stale())")
time.sleep(0.6)
ok("别的实例还开着（owner 还在）→ 不收，免得把它的 frpc 抢了",
   reap3 == "0" and alive(kid.pid),
   f"reap={reap3} 还活着={alive(kid.pid)}")

for p in (stray, innocent, owner, kid):
    kill_tree(p.pid)
    try:
        p.wait(timeout=3)
    except Exception:                                            # noqa: BLE001
        pass

print(f"\n==== frpc 不许留在机器上跑：{_passed}/{_passed + _failed} 通过 ====")
try:
    import shutil
    shutil.rmtree(WORK, ignore_errors=True)
except Exception:                                                # noqa: BLE001
    pass
sys.exit(1 if _failed else 0)
