#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""frp.py — 内置的 FRP 客户端（内网穿透）：在外面用手机看这台 HMI

现场场景：HMI 跑在车间那台一体机 / 电脑上（局域网里），人想**在厂外拿手机看画面**。
办法就是 FRP —— 本机跑一个 frpc，通过自己的 frps 服务器把本机的 HMI 端口映射出去。

以前是手工双击 `start_frpc.bat`（还得自己改 frpc.toml 里的服务器、token、端口）。
现在做进软件里（编辑器「工程 ▾ → FRP 内网穿透…」）：
  · 设置存**这台机器**（<数据目录>/settings.json 的 `frp` 段，跟"日志设置"一个口径）——
    服务器地址/端口/token/映射端口都是"这台机器所在网络"的事，**不跟工程走**；
  · 开启时**自动检测本机 IP**，并把「手机该访问的地址」算出来（局域网一条、外网一条）；
  · frpc 由后端**当子进程拉起来**并盯着（崩了自动重拉），输出进 <日志目录>/frpc.log；
  · 配置自动生成到 <数据目录>/frp/frpc.toml —— 不往安装目录里写东西（装机/更新都不影响它）；
  · 开机（后端启动）时如果上次是开着的，**自动接着开**（现场机器重启不用人再点一下）。

frpc.exe 从哪找（见 find_frpc）：
  ① 环境变量 `HMI_FRPC` —— 显式指定（自动化测试也用它，指到一个假 exe 就能测整条链路）
  ② `<安装目录>/frp/frpc.exe` —— 打包时跟着**安装包**一起装（16.7MB 的 Go 二进制，
     放"壳"那层：日常「立即更新」的代码包只有 3MB，不该每次都把这 17MB 重下一遍）
  ③ 程序目录下的 `frp/frpc.exe` / `FRP/frpc.exe`（源码方式跑，仓库里就有）
  ④ PATH 里的 `frpc`
找不到**不报错**：界面里会说清"没找到 frpc.exe、该放到哪儿"，别的功能一概不受影响。
"""
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

from .paths import DATA_DIR, LOG_DIR, ROOT
from .settings import _settings_load, _settings_save

FRP_KEY = "frp"                       # settings.json 里的段名
FRP_DIR = DATA_DIR / "frp"            # 生成的配置放这儿（跟数据走，不碰安装目录）
CONF_FILE = FRP_DIR / "frpc.toml"
PID_FILE = FRP_DIR / "frpc.pid"       # 我们起的那个 frpc 的 pid（下次起来先按它"收尸"）
LOG_FILE = LOG_DIR / "frpc.log"
LOG_MAX_BYTES = 1 << 20               # 日志到 1MB 就从头写过（够查最近的，不让它无限涨）
LOG_TAIL_LINES = 40                   # 界面上给最近这么多行

DEFAULTS = {
    "enabled": False,
    "server_addr": "",                # frps 的地址（域名或 IP）
    "server_port": 7000,              # frps 的 bindPort
    "token": "",                      # frps 的 auth.token（没设就留空）
    "remote_port": 0,                 # HMI 映射到服务器上的哪个端口（手机连这个）
    "local_port": 0,                  # 本机 HMI 的端口；0 = 用当前后端实际监听的那个
    "name": "",                       # HMI 那条的代理名（留空 = hmi-<主机名>）
    # 另外还要映射的端口（现场常见：把 **PLC 的 Modbus 端口**也映射出去，
    # 在外面用笔记本连 PLC 调试）。每条：{name, local_ip, local_port, remote_port, enabled}
    "extras": [],
}

_lock = threading.RLock()
_proc = None                          # 当前 frpc 子进程
_started_at = 0.0
_restarts = 0
_last_error = ""
_fail_streak = 0                      # 连续快速失败次数（超过阈值就别再死循环重拉了）
_next_try_at = 0.0                    # 下次允许重拉的时刻（退避）
_supervisor = None
_local_port = 0                       # 后端实际监听的端口（API/启动时告诉它）


# ───────────────────────── 设置 ─────────────────────────
def _clamp_port(v, dflt=0):
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return dflt
    return n if 1 <= n <= 65535 else dflt


def _clean_extra(e):
    """一条额外映射：备注名 / 本机地址 / 本机端口 / 远程端口（端口不全就算没配好，丢掉）"""
    if not isinstance(e, dict):
        return None
    lp = _clamp_port(e.get("local_port"), 0)
    rp = _clamp_port(e.get("remote_port"), 0)
    ip = str(e.get("local_ip") or "").strip() or "127.0.0.1"
    if not lp or not rp:
        return None
    return {
        "enabled": e.get("enabled", True) is not False,
        "name": str(e.get("name") or "").strip(),
        "local_ip": ip,
        "local_port": lp,
        "remote_port": rp,
    }


def config():
    """当前 FRP 设置（缺键用默认值：老机器/没配过都走得通）"""
    raw = _settings_load().get(FRP_KEY)
    cfg = dict(DEFAULTS)
    if isinstance(raw, dict):
        for k in DEFAULTS:
            if k in raw:
                cfg[k] = raw[k]
    cfg["enabled"] = bool(cfg["enabled"])
    cfg["server_addr"] = str(cfg["server_addr"] or "").strip()
    cfg["token"] = str(cfg["token"] or "")
    cfg["name"] = str(cfg["name"] or "").strip()
    cfg["server_port"] = _clamp_port(cfg["server_port"], 7000) or 7000
    cfg["remote_port"] = _clamp_port(cfg["remote_port"], 0)
    cfg["local_port"] = _clamp_port(cfg["local_port"], 0)
    cfg["extras"] = [c for c in (_clean_extra(e) for e in (cfg.get("extras") or [])) if c]
    return cfg


def save_config(patch):
    """把界面上的改动合并存回 settings.json；返回 (新配置, 错误文案)"""
    with _lock:
        cur = config()
        for k in ("enabled", "server_addr", "server_port", "token", "remote_port",
                  "local_port", "name", "extras"):
            if k in (patch or {}):
                cur[k] = patch[k]
        cfg = {
            "enabled": bool(cur["enabled"]),
            "server_addr": str(cur["server_addr"] or "").strip(),
            "server_port": _clamp_port(cur["server_port"], 7000) or 7000,
            "token": str(cur["token"] or ""),
            "remote_port": _clamp_port(cur["remote_port"], 0),
            "local_port": _clamp_port(cur["local_port"], 0),
            "name": str(cur["name"] or "").strip(),
            "extras": [c for c in (_clean_extra(e) for e in (cur.get("extras") or [])) if c],
        }
        d, err = _settings_save({FRP_KEY: cfg})
        if err:
            return config(), err
        return config(), ""


# ───────────────────────── 本机 IP / frpc 在哪 ─────────────────────────
def detect_ips():
    """本机的局域网 IPv4（第一项是"出网那张网卡"的地址，现场一般就填这个）

    做法：朝一个外网地址 `connect()`（UDP，不发任何包）—— 内核按路由表挑源地址，
    `getsockname()` 就是本机在那个网络里的 IP。**没外网也能用**（不真发包）；
    拿不到就退回主机名解析，再拿不到就只剩回环。
    """
    ips = []
    for probe in (("8.8.8.8", 80), ("223.5.5.5", 80)):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect(probe)
                ip = s.getsockname()[0]
            finally:
                s.close()
            if ip and ip not in ips and not ip.startswith("127."):
                ips.append(ip)
        except Exception:                                       # noqa: BLE001
            pass
    if not ips:
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if ip and ip not in ips and not ip.startswith("127."):
                    ips.append(ip)
        except Exception:                                       # noqa: BLE001
            pass
    return ips


def find_frpc():
    """找 frpc 可执行文件；找不到返回 ''（界面据此提示该放哪儿）"""
    env = (os.environ.get("HMI_FRPC") or "").strip()
    if env:
        p = Path(env)
        return str(p) if p.is_file() else ""
    app_dir = (os.environ.get("HMI_APP_DIR") or "").strip()
    cands = []
    if app_dir:                                   # 装出来的：<安装目录>/frp/frpc.exe
        cands.append(Path(app_dir).parent / "frp" / "frpc.exe")
    cands += [ROOT / "frp" / "frpc.exe", ROOT / "FRP" / "frpc.exe",
              ROOT / "packaging" / "frp" / "frpc.exe"]
    for c in cands:
        if c.is_file():
            return str(c)
    which = shutil.which("frpc") or shutil.which("frpc.exe")
    return which or ""


# ─────────── 别把 frpc 落在机器上跑（软件关了它也得走） ───────────
# 现场踩过：**软件退出了，frpc 还在跑**。原因是收尾只靠 atexit()/finally —— 关控制台窗口、
# 任务管理器结束进程、taskkill /F、后端自己崩掉，这些路径**根本不执行 Python 代码**，
# 子进程就没人管了。
#
# Windows 上的正解是 job object：把 frpc 放进一个 KILL_ON_JOB_CLOSE 的 job，句柄握在本进程手里
# —— 本进程无论怎么没的（包括被强杀），内核都会连 job 里的 frpc 一起收掉。
# 再留一手：pid 写进 <数据目录>/frp/frpc.pid，后端下次起来先"收尸"，
# 专门对付 job 没绑上 / 老版本 / 被强杀之后剩下的野 frpc。
_JOB_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9
_job = None                           # 句柄必须一直留着：进程一走它就关，frpc 跟着死

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class _EXT_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _BASIC_LIMIT),
                    ("IoInfo", _IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                             wintypes.LPVOID, wintypes.DWORD]
    _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    _k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]


def bind_lifetime(p):
    """把 frpc 绑进"本进程一走它就死"的 job（Windows）；绑不上返回 False（还有收尸兜底）"""
    global _job
    if os.name != "nt":
        return False
    try:
        if _job is None:
            h = _k32.CreateJobObjectW(None, None)
            if not h:
                return False
            info = _EXT_LIMIT()
            info.BasicLimitInformation.LimitFlags = _JOB_KILL_ON_JOB_CLOSE
            if not _k32.SetInformationJobObject(h, _JobObjectExtendedLimitInformation,
                                                ctypes.byref(info), ctypes.sizeof(info)):
                _k32.CloseHandle(h)
                return False
            _job = h
        return bool(_k32.AssignProcessToJobObject(_job, wintypes.HANDLE(int(p._handle))))
    except Exception:                                            # noqa: BLE001
        return False


def _proc_exe(pid):
    """pid 现在对应的可执行文件全路径；进程没了/没权限就给 ''（收尸前靠它认人）"""
    if os.name != "nt":
        return ""
    try:
        h = _k32.OpenProcess(0x1000, False, int(pid))            # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            n = wintypes.DWORD(len(buf))
            if not _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                return ""
            return buf.value
        finally:
            _k32.CloseHandle(h)
    except Exception:                                            # noqa: BLE001
        return ""


def _pid_alive(pid):
    """那个 pid 还活着吗"""
    try:
        pid = int(pid or 0)
    except Exception:                                            # noqa: BLE001
        return False
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except Exception:                                        # noqa: BLE001
            return False
    h = _k32.OpenProcess(0x00100000, False, pid)                 # SYNCHRONIZE
    if not h:
        return False
    try:
        return _k32.WaitForSingleObject(h, 0) == 0x00000102      # WAIT_TIMEOUT = 还活着
    finally:
        _k32.CloseHandle(h)


def _kill_pid(pid):
    """收掉一个 pid（只在我们确认过"这就是自己起的 frpc"之后才调）"""
    if os.name != "nt":
        try:
            os.kill(int(pid), 9)
            return True
        except Exception:                                        # noqa: BLE001
            return False
    h = _k32.OpenProcess(0x0001, False, int(pid))                # PROCESS_TERMINATE
    if not h:
        return False
    try:
        return bool(_k32.TerminateProcess(h, 1))
    finally:
        _k32.CloseHandle(h)


def _same_exe(a, b):
    """同一个可执行文件？（全路径优先；拿不到全路径时退一步比文件名）"""
    if not a or not b:
        return False
    na, nb = os.path.normcase(os.path.normpath(a)), os.path.normcase(os.path.normpath(b))
    return na == nb or os.path.basename(na) == os.path.basename(nb)


def _write_pid(p):
    """记下这次起的 frpc（pid + 可执行文件 + 谁起的）—— 下次启动收尸要用"""
    try:
        FRP_DIR.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(json.dumps({"pid": p.pid, "exe": find_frpc(),
                                        "owner": os.getpid(), "at": time.time()}),
                            encoding="utf-8")
    except Exception:                                            # noqa: BLE001
        pass


def _forget_pid():
    try:
        PID_FILE.unlink()
    except Exception:                                            # noqa: BLE001
        pass


def reap_stale():
    """收掉上次没善终留下的 frpc（老版本、job 没绑上、被强杀…）

    只认**我们自己写的 pid 文件**里那个 pid，而且要是**同一个可执行文件**才动手
    （pid 会被系统复用，认错了就杀了别人的进程）；上一个后端还活着（owner 在场）也不动它
    —— 那是另一个实例的 frpc，别抢。
    @returns 收掉的 pid；没收拾就 0
    """
    try:
        rec = json.loads(PID_FILE.read_text(encoding="utf-8"))
    except Exception:                                            # noqa: BLE001
        return 0
    owner = rec.get("owner")
    if owner == os.getpid() or _pid_alive(owner):
        return 0
    pid = int(rec.get("pid") or 0)
    if pid and _same_exe(_proc_exe(pid), str(rec.get("exe") or "")):
        _kill_pid(pid)
        print(f"[frp] 收掉上次遗留的 frpc（pid {pid}）")
        _forget_pid()
        return pid
    _forget_pid()                       # 早就没了 / 不是我们起的 → 只清记录
    return 0


def proxy_name(cfg):
    name = cfg.get("name") or ""
    if name:
        return name
    host = (socket.gethostname() or "hmi").strip() or "hmi"
    safe = "".join(ch if (ch.isalnum() or ch in "-_.") else "-" for ch in host)
    return f"hmi-{safe}"


def extra_proxy_name(cfg, e, idx):
    """额外映射的代理名（留空就按"plc-<地址>-<端口>"起一个，好看懂）"""
    if e.get("name"):
        return e["name"]
    host = "".join(ch if (ch.isalnum() or ch in "-_.") else "-" for ch in str(e.get("local_ip") or ""))
    return f"{host or 'dev'}-{e.get('local_port')}"


def mappings(cfg=None):
    """这次要建的**所有**映射：第一条永远是 HMI 自己，后面是 extras（PLC 之类）

    @returns [{kind:'hmi'|'extra', name, local_ip, local_port, remote_port}]
    """
    cfg = cfg or config()
    out = []
    if cfg.get("remote_port"):
        out.append({
            "kind": "hmi", "name": proxy_name(cfg), "local_ip": "127.0.0.1",
            "local_port": local_port(cfg), "remote_port": cfg["remote_port"],
        })
    for i, e0 in enumerate(cfg.get("extras") or []):
        e = _clean_extra(e0)                  # 端口没填全的条目直接不算（settings.json 被手改坏了也一样）
        if not e or not e.get("enabled", True):
            continue
        out.append({
            "kind": "extra", "name": extra_proxy_name(cfg, e, i),
            "local_ip": e["local_ip"], "local_port": e["local_port"], "remote_port": e["remote_port"],
        })
    # frp 要求代理名唯一：手填重的、或者两台设备端口撞了的，自动加序号（别整个起不来）
    seen = {}
    for m in out:
        n = m["name"]
        if n in seen:
            seen[n] += 1
            m["name"] = f"{n}-{seen[n]}"
        else:
            seen[n] = 1
    return out


def local_port(cfg=None):
    """本机要映射出去的 HMI 端口：**就是后端此刻实际监听的那个**

    以前这里优先用界面上手填的值 —— 端口一变（8866 被占、开发时跑在随机端口上）映射就指向
    一个没人监听的端口，手机打开是空白。现在一律跟着后端的实际端口走；`cfg.local_port`
    只当后端还没报端口时的兜底（老配置里存的旧值不再抢戏）。
    """
    cfg = cfg or config()
    return _local_port or _clamp_port(cfg.get("local_port"), 0) or 8866


def plc_hint():
    """当前 PLC 连接信息（界面「从 PLC 连接填入」用：把它的 IP:端口 变成一条映射）

    ⚠ 只在**真连 PLC**时给（内存模拟没有地址可填）；拿不到就返回空 dict。
    """
    try:
        from .plcsource import _plc_cfg            # 局部 import：frp 不该在模块级依赖 plc 那一摊
        mode = str((_plc_cfg or {}).get("mode") or "")
        if mode not in ("plc", "opcua"):
            return {}
        if mode == "opcua":
            ep = str((_plc_cfg or {}).get("endpoint") or "")
            return {"mode": mode, "endpoint": ep, "protocol": "opcua"}
        return {
            "mode": mode,
            "protocol": "modbus",
            "ip": str((_plc_cfg or {}).get("ip") or (_plc_cfg or {}).get("host") or ""),
            "port": _clamp_port((_plc_cfg or {}).get("port"), 502) or 502,
        }
    except Exception:                                           # noqa: BLE001
        return {}


# ───────────────────────── 生成 frpc.toml ─────────────────────────
def _q(s):
    """TOML 字符串：转义反斜杠和引号（token 里可能有怪字符）"""
    return '"' + str(s or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_toml(cfg=None):
    cfg = cfg or config()
    lines = [
        "# 这份配置是**软件自动生成**的（WebHMI_设计器 · 工程 ▾ → FRP 内网穿透…）",
        "# 手改没用：下次启动会按界面里的设置重写一遍。要改就改界面里的那几格。",
        f'serverAddr = {_q(cfg["server_addr"])}',
        f'serverPort = {cfg["server_port"]}',
    ]
    if cfg.get("token"):
        lines += ['auth.method = "token"', f'auth.token = {_q(cfg["token"])}']
    for m in mappings(cfg):
        lines += [
            "",
            "[[proxies]]",
            f'name = {_q(m["name"])}',
            'type = "tcp"',
            f'localIP = {_q(m["local_ip"])}',
            f'localPort = {m["local_port"]}',
            f'remotePort = {m["remote_port"]}',
        ]
    lines.append("")
    return "\n".join(lines)


def write_conf(cfg=None):
    """把配置写到 <数据目录>/frp/frpc.toml，返回路径"""
    FRP_DIR.mkdir(parents=True, exist_ok=True)
    CONF_FILE.write_text(render_toml(cfg), encoding="utf-8")
    return CONF_FILE


# ───────────────────────── 子进程 ─────────────────────────
def _log_tail(n=LOG_TAIL_LINES):
    try:
        if not LOG_FILE.exists():
            return []
        txt = LOG_FILE.read_text(encoding="utf-8", errors="replace")
        return [l for l in txt.splitlines() if l.strip()][-n:]
    except Exception:                                           # noqa: BLE001
        return []


def _log_roll():
    """日志超过上限就重开一个（不转存历史：这是排障用的，最近的够用）"""
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_MAX_BYTES:
            LOG_FILE.unlink()
    except Exception:                                           # noqa: BLE001
        pass


def _spawn(cfg):
    """拉起 frpc（配置先写好）。返回 (进程, 错误文案)"""
    global _proc, _started_at, _last_error
    exe = find_frpc()
    if not exe:
        _last_error = ("没找到 frpc.exe —— 装出来的版本在「<安装目录>\\frp\\frpc.exe」；"
                       "源码方式跑就放到程序的 frp\\ 或 FRP\\ 目录下")
        return None, _last_error
    if not cfg.get("server_addr"):
        _last_error = "还没填 FRPS 服务器地址"
        return None, _last_error
    if not mappings(cfg):
        _last_error = ("还没有要映射的端口 —— 至少填「映射端口」（手机看画面那个），"
                       "或者在下面加一条（PLC 之类）")
        return None, _last_error
    conf = write_conf(cfg)
    _log_roll()
    try:
        f = open(LOG_FILE, "a", encoding="utf-8", errors="replace")
        flags = 0x08000000 if os.name == "nt" else 0        # CREATE_NO_WINDOW：别弹黑框
        p = subprocess.Popen([exe, "-c", str(conf)], cwd=str(FRP_DIR),
                             stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             creationflags=flags)
    except Exception as e:                                      # noqa: BLE001
        _last_error = f"启动 frpc 失败：{type(e).__name__}: {e}"
        return None, _last_error
    _proc = p
    _started_at = time.time()
    _last_error = ""
    bind_lifetime(p)                                            # 后端一走，它跟着走
    _write_pid(p)
    try:
        maps = mappings(cfg)
        desc = "；".join(f"{m['local_ip']}:{m['local_port']} → 远程 {m['remote_port']}"
                         f"（{m['name']}）" for m in maps) or "（没有映射）"
        f.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} 启动 frpc（pid {p.pid}）"
                f"：{cfg['server_addr']}:{cfg['server_port']} —— {desc} ====\n")
        f.close()
    except Exception:                                           # noqa: BLE001
        pass
    return p, ""


def start(cfg=None, port=None):
    """启动（已经在跑就先停掉再起，让新配置生效）"""
    global _fail_streak, _next_try_at, _local_port
    with _lock:
        if port:
            _local_port = int(port)
        cfg = cfg or config()
        stop()
        p, err = _spawn(cfg)
        _fail_streak = 0 if p else _fail_streak + 1
        _next_try_at = 0.0
        return p is not None, err


def stop():
    """停掉 frpc（关软件 / 关掉开关时都走这里）"""
    global _proc, _started_at
    with _lock:
        p = _proc
        _proc = None
        _started_at = 0.0
        if not p:
            reap_stale()                  # 手上没进程，但可能有上次没收掉的（pid 文件里那个）
            return False
        try:
            p.terminate()
            try:
                p.wait(timeout=5)
            except Exception:                                   # noqa: BLE001
                p.kill()
        except Exception:                                       # noqa: BLE001
            pass
        _forget_pid()
        return True


def _alive():
    return bool(_proc) and _proc.poll() is None


def running():
    return _alive()


def status(with_log=True):
    """给界面看的现状（一次拿全：配置 / 跑没跑 / 为什么没跑 / 日志尾巴 / 该访问的地址）"""
    cfg = config()
    lp = local_port(cfg)
    exe = find_frpc()
    ips = detect_ips()
    st = {
        "config": cfg,
        "local_port": lp,
        "frpc": exe,
        "frpc_found": bool(exe),
        "config_file": str(CONF_FILE),
        "log_file": str(LOG_FILE),
        "ips": ips,
        "running": _alive(),
        "pid": (_proc.pid if _alive() else 0),
        "started_at": _started_at,
        "uptime_s": (round(time.time() - _started_at) if _alive() and _started_at else 0),
        "restarts": _restarts,
        "last_error": _last_error,
        # 这次实际会建哪些映射（第一条是 HMI，后面是 PLC 之类的 extras）
        "mappings": [dict(m, url=(f"http://{cfg['server_addr']}:{m['remote_port']}/run"
                                 if m["kind"] == "hmi" and cfg.get("server_addr") else ""))
                     for m in mappings(cfg)],
        "url_remote": (f"http://{cfg['server_addr']}:{cfg['remote_port']}/run"
                       if cfg.get("server_addr") and cfg.get("remote_port") else ""),
        # PLC 连接现状：界面用「从 PLC 连接填入」把它的 IP:端口 填进一条映射，省得手敲
        "plc": plc_hint(),
    }
    if with_log:
        st["log"] = _log_tail()
    return st


# ───────────────────────── 看门狗：崩了自动重拉 ─────────────────────────
SUPERVISE_SEC = 2.0
FAIL_WINDOW = 5            # 连续失败这么多次就先停手（把原因留在界面上，别无限重拉）
RETRY_AFTER_SEC = 10.0     # 超过这个时间又崩 = 当成"偶发"，重新数


def _supervise():
    global _restarts, _fail_streak, _next_try_at, _proc, _last_error
    while True:
        time.sleep(SUPERVISE_SEC)
        try:
            with _lock:
                cfg = config()
                if not cfg.get("enabled"):
                    continue
                if _alive():
                    continue
                now = time.time()
                if now < _next_try_at:
                    continue
                # 刚起来就死（<10s）= 多半配置不对（端口被占 / 服务器连不上 / token 错）
                if _started_at and (now - _started_at) < RETRY_AFTER_SEC:
                    _fail_streak += 1
                else:
                    _fail_streak = 1
                if _fail_streak > FAIL_WINDOW:
                    _last_error = (f"frpc 连续 {_fail_streak} 次起来就退出，先不重试了 —— "
                                   f"看日志：{LOG_FILE}")
                    _next_try_at = now + 60
                    continue
                _next_try_at = now + RETRY_AFTER_SEC
                _restarts += 1
                print(f"[frp] frpc 不在了，自动重拉（第 {_restarts} 次）")
                _spawn(cfg)
        except Exception as e:                                  # noqa: BLE001
            print(f"[frp] 看门狗出错（忽略，下次继续）：{type(e).__name__}: {e}")


def note_port(port):
    """后端告诉 frp："我现在监听的是这个端口" —— HMI 那条映射就映射它（见 local_port）"""
    global _local_port
    try:
        if port:
            _local_port = int(port)
    except Exception:                                            # noqa: BLE001
        pass
    return _local_port


def ensure(port=None):
    """后端启动时调一次：先收掉上次遗留的 frpc，上次开着就接着开"""
    global _supervisor
    if port:
        port = note_port(port)
    if _supervisor is None:
        _supervisor = threading.Thread(target=_supervise, name="frp-watch", daemon=True)
        _supervisor.start()
    reap_stale()                        # 上次没善终留下的野 frpc（关软件它没走那种）
    cfg = config()
    if not cfg.get("enabled"):
        return False
    print(f"[frp] 上次是开着的 → 自动启动 frpc（{cfg.get('server_addr')}:{cfg.get('server_port')}"
          f" → 本机 {local_port(cfg)} → 远程 {cfg.get('remote_port')}）")
    ok, err = start(cfg, port)
    if not ok:
        print(f"[frp] 启动失败：{err}")
    return ok


def apply(patch, action=""):
    """界面按「保存并启动 / 只保存 / 停止」时走这里：先存设置，再按开关与动作起停"""
    cfg, err = save_config(patch or {})
    if err:
        return {"ok": False, "error": err, "status": status()}
    act = str(action or "").lower()
    if act in ("stop", "disable"):
        stop()
    elif act in ("start", "restart") or cfg.get("enabled"):
        # 开着就（重新）拉起来：改了服务器/端口必须重启才生效
        ok, serr = start(cfg)
        if not ok and cfg.get("enabled"):
            return {"ok": False, "error": serr, "status": status()}
    else:
        stop()
    return {"ok": True, "error": "", "status": status()}
