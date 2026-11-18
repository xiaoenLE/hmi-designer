#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify-frp-boot.py — "开了 FRP，重开软件它得自己起来"（现场报的 bug）

现场症状：界面里把「FRP 内网穿透」打开、也跑起来了；关掉软件再打开 → **frpc 没跟着起来**，
还得人手点一次「保存并应用」，等于"必须开着软件窗口才记得起"。

原因不在 frp.py，而在**启动路径有两条**：
  · `server/server.py`（start_server.bat / 服务方式）—— 启动时有 `frp.ensure()`；
  · `server/hmi_desktop.py`（**桌面窗口**：客户机装出来的就是这条）—— 它自己起服务，
    不走 server.py 的 main，**以前没接这一步**。
所以本套件不去测接口，而是**真的把桌面那条路起一遍**（`--no-window`，不弹窗），看 frpc 自己起没起。
收尾也一起验：强杀这个进程 → frpc 跟着没（job object / stop 两道都行，至少不能剩下）。

跑法（tools/run-suites.mjs 会带上端口参数，本套件不用）：
  python test/verify-frp-boot.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
NOP = 0x08000000 if os.name == "nt" else 0        # CREATE_NO_WINDOW
OUT = {"encoding": "utf-8", "errors": "replace"}

try:                                              # 控制台按 UTF-8 说话
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


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        o = subprocess.run(["tasklist", "/FI", f"PID eq {int(pid)}", "/NH"],
                           capture_output=True, text=True, **OUT).stdout or ""
        return str(int(pid)) in o
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:                                            # noqa: BLE001
        return False


WORK = Path(tempfile.mkdtemp(prefix="hmi-frp-boot-"))
DATA = WORK / "data"
LOGS = WORK / "logs"
(DATA / "frp").mkdir(parents=True, exist_ok=True)
LOGS.mkdir(parents=True, exist_ok=True)

# 假的 frpc：真的起得来、能睡住（跟 verify-frp.mjs 里那个 .bat 一个套路）
STUB = WORK / "frpc.exe.bat"
STUB.write_text("@echo off\r\necho STUB frpc %*\r\nping -n 3600 127.0.0.1 >nul\r\n", encoding="utf-8")

# 现场那台机器的样子：FRP 开着、服务器和映射端口都填好了
(DATA / "settings.json").write_text(json.dumps({
    "log_keep_days": 3,
    "frp": {"enabled": True, "server_addr": "159.75.50.193", "server_port": 7000,
            "token": "xiaoen123", "remote_port": 6100, "local_port": 8866, "name": "",
            "extras": [{"name": "PLC", "local_ip": "192.168.1.10", "local_port": 502,
                        "remote_port": 6502, "enabled": True}]},
}, ensure_ascii=False), encoding="utf-8")

PORT = free_port()
ENV = {**os.environ, "HMI_DATA_DIR": str(DATA), "HMI_LOG_DIR": str(LOGS),
       "HMI_FRPC": str(STUB), "PYTHONIOENCODING": "utf-8"}

# ── ① 桌面窗口那条启动路径（--no-window：一样的代码，只是不弹窗）──────────
proc = subprocess.Popen([PY, str(ROOT / "server" / "hmi_desktop.py"),
                         "--no-window", "--no-auth", "--port", str(PORT)],
                        cwd=str(ROOT), env=ENV, creationflags=NOP,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **OUT)
conf = DATA / "frp" / "frpc.toml"
pid_file = DATA / "frp" / "frpc.pid"
for _ in range(120):                                  # 等它起来 + 自己把 frpc 拉起来
    time.sleep(0.25)
    if conf.exists() and pid_file.exists():
        break

srv_up = False                                        # 服务真在监听吗（配置出来之后再多试几次）
for _ in range(40):
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            srv_up = True
            break
    except Exception:                                         # noqa: BLE001
        time.sleep(0.25)

toml = conf.read_text(encoding="utf-8") if conf.exists() else ""
frpc_pid = 0
try:
    frpc_pid = int(json.loads(pid_file.read_text(encoding="utf-8")).get("pid") or 0)
except Exception:                                             # noqa: BLE001
    pass

ok("桌面窗口这条路起来了（服务在监听）", srv_up, f"pid={proc.pid} port={PORT}")
ok("★ 开了 FRP → 软件一打开就**自己生成配置**（不用人点任何东西）",
   "remotePort = 6100" in toml and "159.75.50.193" in toml,
   (toml.splitlines()[:6] or [""])[-1][:80])
ok("★ 画面那条映射的本机端口 = 当前后端端口（不是手填的旧值）",
   f"localPort = {PORT}" in toml and "localPort = 8866" not in toml,
   f"port={PORT}")
ok("★ PLC 那条也跟着起来了（extras 一起写进配置）",
   "localPort = 502" in toml and "remotePort = 6502" in toml)
ok("★ frpc 进程**真的在跑**（不是只写了个配置文件）", frpc_pid > 0 and alive(frpc_pid),
   f"frpc pid={frpc_pid}")

srclog = ""
try:
    srclog = (LOGS / f"hmi-{time.strftime('%Y-%m-%d')}.log").read_text(encoding="utf-8", errors="replace")
except Exception:                                             # noqa: BLE001
    pass
ok("日志里写明了「上次是开着的 → 自动启动 frpc」（现场排障看得见）",
   "自动启动 frpc" in srclog,
   " | ".join([l for l in srclog.splitlines() if "[frp]" in l][:2]))

# ── ② 关掉软件：frpc 不许留下（这次走的是真关：terminate → _shutdown/finally）──
proc.terminate()
try:
    proc.wait(timeout=15)
except Exception:                                             # noqa: BLE001
    proc.kill()
    proc.wait(timeout=5)
time.sleep(1.5)
ok("★ 关掉软件 → frpc 也跟着收了（不留孤儿）", not alive(frpc_pid), f"frpc pid={frpc_pid}")

# ── ③ 再来一次：这次**强杀**（跑不到收尾代码）→ 也得没 ────────────────────
proc2 = subprocess.Popen([PY, str(ROOT / "server" / "hmi_desktop.py"),
                          "--no-window", "--no-auth", "--port", str(PORT)],
                         cwd=str(ROOT), env=ENV, creationflags=NOP,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pid2 = 0
for _ in range(120):
    time.sleep(0.25)
    try:
        pid2 = int(json.loads(pid_file.read_text(encoding="utf-8")).get("pid") or 0)
    except Exception:                                         # noqa: BLE001
        pid2 = 0
    if pid2 and alive(pid2) and pid2 != frpc_pid:
        break
ok("再开一次也照样自己起来（换了个新 frpc 进程）", pid2 > 0 and pid2 != frpc_pid and alive(pid2),
   f"新 frpc pid={pid2}（上一次 {frpc_pid}）")

if os.name == "nt":
    subprocess.run(["taskkill", "/F", "/PID", str(proc2.pid)],
                   capture_output=True, text=True, **OUT)
else:
    proc2.kill()
time.sleep(1.5)
ok("★ 强杀软件（taskkill /F，跑不到收尾代码）→ frpc 也没了", not alive(pid2), f"frpc pid={pid2}")

# ── ④ 另一条启动路径也要一样（server.py：start_server.bat / 服务方式）────────
#    两条路各写各的启动代码，这条以前有 ensure、桌面那条漏了 —— 所以两条都得盯着
pid_file.unlink(missing_ok=True)
PORT2 = free_port()
proc3 = subprocess.Popen([PY, str(ROOT / "server" / "server.py"),
                          "--port", str(PORT2), "--no-browser", "--no-auth"],
                         cwd=str(ROOT), env=ENV, creationflags=NOP,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pid3 = 0
for _ in range(120):
    time.sleep(0.25)
    try:
        pid3 = int(json.loads(pid_file.read_text(encoding="utf-8")).get("pid") or 0)
    except Exception:                                         # noqa: BLE001
        pid3 = 0
    if pid3 and alive(pid3):
        break
ok("★ 服务方式（server.py）也是开了就自己起来", pid3 > 0 and alive(pid3), f"frpc pid={pid3}")

if os.name == "nt":
    subprocess.run(["taskkill", "/F", "/PID", str(proc3.pid)], capture_output=True, text=True, **OUT)
else:
    proc3.kill()
time.sleep(1.5)
ok("★ 服务方式被强杀 → frpc 也没了", not alive(pid3), f"frpc pid={pid3}")

try:
    if proc.stdout:
        proc.stdout.close()
except Exception:                                             # noqa: BLE001
    pass
for p in (pid2, pid3):                                        # 兜底清理，别给机器留垃圾
    if alive(p):
        subprocess.run(["taskkill", "/F", "/PID", str(p)], capture_output=True, **OUT)

print(f"\n==== 开了 FRP 重开软件要自己起来：{_passed}/{_passed + _failed} 通过 ====")
try:
    import shutil
    shutil.rmtree(WORK, ignore_errors=True)
except Exception:                                             # noqa: BLE001
    pass
sys.exit(1 if _failed else 0)
