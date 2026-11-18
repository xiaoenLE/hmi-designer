# -*- coding: utf-8 -*-
"""
_restart.py — 更新之后的「重启 + 保险」助手（只在点了「立即更新」时被拉起来一次）

为什么要单独一个进程：更新完**当前这个 Python 进程里的代码已经是旧的了**（模块早就加载完了），
必须整个进程换掉才能跑新代码；而它自己又不能"先退出再启动自己"。所以由它临走前拉起这个助手：

    _restart.py <pending.json>
      1. 等老进程把端口放开（它正在退出）
      2. 用**新代码**把服务拉起来（按原来的启动方式：命令行 or 原生窗口）
      3. 长连接握手探活（连 /api/ws 读 hello）：起来了、版本对了 → 收工
      4. **起不来 / 版本不对 → 用备份自动回滚，再把旧代码拉起来**（现场不能因为一次更新就黑屏）
      5. 全程写 logs/update-YYYY-MM-DD.log，结果写 data/_update/status.json

谁不需要它：`start_server.bat` 启动的（柜台窗口）由 bat 自己循环重启，压根不走这条路
（老控制台窗口留着、输出不断）。见 start_server.bat 里的 :serve 循环。

⚠ 这个文件在更新时**自己也会被覆盖**（它在 server/ 下）。没关系：助手是更新**之后**才拉起来的，
  跑的就是新版本；回滚时那份旧代码由备份还原，助手的内存逻辑不受影响。
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import updater                                                  # noqa: E402  （同目录）

# 日志目录：跟 server.py 一个规矩 —— HMI_LOG_DIR 优先。
# ⚠ 打包成 exe 时日志目录是**壳**定的（默认安装目录下的 logs\，写不进去才退到
#   %ProgramData%\HMI-Designer\logs）；更新助手是壳拉起来的，环境变量一路带过来，
#   所以更新日志跟运行日志在同一个目录 —— 不认这个变量的话，更新日志会被 try/except
#   静默吞掉，现场"更新失败"时就没有任何线索可查（踩过一次）。
LOG_DIR = Path(os.environ.get("HMI_LOG_DIR") or (ROOT / "logs"))

WAIT_PORT_FREE = 30.0      # 等老进程放开端口的上限（它要 flush 变量、关 socket）
WAIT_HEALTHY = 45.0        # 等新进程"能应答健康检查"的上限（首次启动要加载工程/连 PLC）
POLL = 0.7


def log_line(msg: str, log_path: Path):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:                                           # noqa: BLE001
        pass


def probe(host: str, port: int) -> bool:
    """端口上有没有人在听（和 server.py 里 _port_in_use 一个思路：连接探测，不靠 bind）"""
    probe_host = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex((probe_host, port)) == 0
    except OSError:
        return False


def health(base: str, timeout: float = 2.0):
    """问一句「后端起来了吗、是哪个版本」→ 返回那份现状 dict；起不来返回 None

    ★ V2 起没有 /api/health 这个 HTTP 接口了（HTTP 只剩静态文件和页面），
      改成**开一次长连接、读 hello 帧**：起的来就一定能握手，hello 里还带着版本号
      （更新助手核对"新版起没起来"就靠它）。
    """
    u = base.split("//", 1)[-1]
    hostport, _, _ = u.partition("/")
    host, _, port = hostport.partition(":")
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from core.hostutil import probe_service          # noqa: PLC0415  同目录后端模块
        return probe_service(int(port or 80), host or "127.0.0.1", timeout=timeout)
    except Exception:                                           # noqa: BLE001
        return None


def version_of(j) -> str:
    return str(((j or {}).get("version") or {}).get("version") or "")


def _force_port(argv, port: int):
    """给新实例的启动参数**钉住端口**（丢掉旧的 --port，补上我们要的那个）。

    为什么必须钉：`hmi_desktop` 的默认行为是"首选端口被占就换一个空闲端口"。
    更新时它退出、端口短暂空着，但机器上如果有别的东西长期占着首选端口
    （比如另一个窗口在源码模式跑着 8866），新实例就会**又换一个随机端口** ——
    于是助手还在老端口上问健康，问不到就判"没起来"→ **误回滚**（现场踩过：
    更新后自己退回上一版，日志里写着「端口 8866 被占用，改用空闲端口 60805」）。
    """
    out, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--port":
            i += 2
            continue
        if a.startswith("--port="):
            i += 1
            continue
        out.append(a)
        i += 1
    return out + ["--port", str(port)]


def spawn(state: dict, log_path: Path) -> subprocess.Popen:
    """按**原来的启动方式**把服务重新拉起来。

    三种情况：
      · 打包成 exe（frozen）：**重启 exe 自己**（程序目录里没有 python 解释器了），
        argv 原样带过去 —— 用户原来怎么开的（--fullscreen / --port / --edit）就还怎么开
      · 原生窗口客户端（源码方式）：python server/hmi_desktop.py
      · 命令行后端：python server/server.py，并补 `--no-browser`（页面本来就开着）

    · 一律 DETACHED：助手自己也会退出，不能让孩子跟着一起被收走
    · 孩子的 stdout/stderr **接进更新日志**：新代码起不来时 traceback 必须留下 ——
      否则现场只看到"服务没了"，什么线索都没有
    """
    launcher = state.get("launcher") or "console"
    want_port = int(state.get("port") or 0)
    if state.get("frozen"):
        exe = str(state.get("exe") or sys.executable)
        argv = _force_port(list(state.get("argv") or []), want_port) if want_port else list(state.get("argv") or [])
        cmd = [exe] + argv
    else:
        if launcher == "desktop":
            script = ROOT / "server" / "hmi_desktop.py"
            argv = list(state.get("argv") or [])
        else:
            script = ROOT / "server" / "server.py"
            argv = list(state.get("argv") or [])
            if "--no-browser" not in argv:
                argv.append("--no-browser")
        if want_port:                     # ★ 钉住端口，别让它又换一个（换了就查不到健康）
            argv = _force_port(argv, want_port)
        cmd = [sys.executable, str(script)] + argv
    env = dict(os.environ)
    env.update({k: v for k, v in (state.get("env") or {}).items() if v is not None})
    env["PYTHONIOENCODING"] = "utf-8"      # 子进程输出别按系统区域(GBK)编，日志按 UTF-8 读的
    log_line(f"拉起：{' '.join(cmd)}（launcher={launcher}）", log_path)
    # ⚠ 新进程的输出写**另一个文件**：助手自己也往 log_path 写日志，
    #   两个写者共用一个文件会把行穿插、中文截断成乱码（踩过）
    child_log = log_path.with_name(log_path.stem + "-app.log")
    out = open(child_log, "a", encoding="utf-8")
    kw = dict(cwd=str(ROOT), env=env, stdout=out, stderr=out, stdin=subprocess.DEVNULL)
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200     # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    p = subprocess.Popen(cmd, **kw)
    p._hmi_log = out                                          # noqa: SLF001  （留着，别让 GC 关掉文件）
    return p


def _up_bases(base: str, data_dir: Path):
    """要问健康检查的地址们：先是"记下来的那个端口"，再加上**新实例自己报到的端口**。

    新实例启动后会往 <数据目录>/_update/up.json 写一行 {port, version, pid}（见 server.py / hmi_desktop.py）。
    为什么要这个兜底：万一首选端口在"助手确认空闲"到"新实例绑定"这一瞬被别人抢走，
    它会换端口启动 —— 只问老端口就会把"其实起来了"误判成"没起来"→ 自动回滚（现场踩过）。
    """
    out = [base]
    try:
        info = json.loads((Path(data_dir) / updater.UPDATE_STATE_DIRNAME / "up.json").read_text(encoding="utf-8"))
        port = int(info.get("port") or 0)
        if port and f":{port}" not in base:
            u = base.split("//", 1)[-1]
            host = u.split(":", 1)[0] or "127.0.0.1"
            out.append(f"http://{host}:{port}")
    except Exception:                                           # noqa: BLE001
        pass
    return out


def wait_up(base: str, want: str, timeout: float, log_path: Path, what: str, data_dir: Path = None):
    """等长连接握手能读到 hello、且版本 == want。返回 hello 那帧的 json 或 None"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        time.sleep(POLL)
        for b in (_up_bases(base, data_dir) if data_dir else [base]):
            j = health(b)
            if not j:
                continue
            last = j
            v = version_of(j)
            if not want or v == want:
                log_line(f"{what}：服务已应答（版本 V{v or '?'}，{b}）", log_path)
                return j
    if last is not None:
        log_line(f"{what}：服务应答了，但版本是 V{version_of(last)}，不是期望的 V{want}", log_path)
    return None


def manual_rollback(data_dir: Path) -> int:
    """逃生口：`python server/_restart.py --rollback` —— 不用打开编辑器、不用网络，
    直接把代码退回最近一次「立即更新」之前的备份（现场服务起不来时的最后一条路）。
    只还原备份清单里的文件，现场数据照旧不碰。"""
    log_path = LOG_DIR / f"update-{time.strftime('%Y-%m-%d')}.log"
    root_bk = Path(data_dir) / updater.BACKUP_DIRNAME
    dirs = sorted([d for d in root_bk.iterdir() if d.is_dir()], key=lambda p: p.name) if root_bk.is_dir() else []
    if not dirs:
        print(f"没有可回滚的备份（{root_bk} 里是空的）—— 说明这台机器没做过「立即更新」")
        return 2
    last = dirs[-1]
    log_line(f"手动回滚：用备份 {last.name}", log_path)
    rb = updater.rollback(last, ROOT, log=log_line_wrap(log_path))
    print(f"回滚结果：{'成功' if rb.get('ok') else '有问题'} —— 还原 {rb.get('restored')} 个、"
          f"删掉新增 {rb.get('removed')} 个；现在代码是 V{rb.get('from_version') or '?'}"
          f"（回滚前是 V{rb.get('to_version') or '?'}）")
    if rb.get("failed"):
        print(f"这几个没弄成：{rb['failed']}")
    print("接着请重新启动服务：start_server.bat 或 start_hmi_window.bat")
    return 0 if rb.get("ok") else 1


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] in ("--rollback", "-r"):
        data_dir = Path(os.environ.get("HMI_DATA_DIR") or (ROOT / "server" / "data"))
        return manual_rollback(data_dir)
    if len(sys.argv) < 2:
        print("用法：python server/_restart.py <pending.json>")
        return 2
    pending = Path(sys.argv[1])
    try:
        state = json.loads(pending.read_text(encoding="utf-8"))
    except Exception as e:                                      # noqa: BLE001
        print(f"读不到 {pending}：{e}")
        return 2

    data_dir = Path(state.get("data_dir") or (ROOT / "server" / "data"))
    log_path = LOG_DIR / f"update-{time.strftime('%Y-%m-%d')}.log"
    host, port = state.get("host") or "127.0.0.1", int(state.get("port") or 8866)
    if host in ("", "0.0.0.0", "::"):        # 监听全网卡时，健康检查还是要往回环问
        host = "127.0.0.1"
    base = f"http://{host}:{port}"
    frm, to = str(state.get("from_version") or ""), str(state.get("to_version") or "")

    log_line(f"==== 更新助手启动：V{frm} → V{to}（{' '.join(sys.argv)}）====", log_path)

    # 1) 等老进程退出（它在 flush 变量、关 socket；不等就会抢端口）
    end = time.time() + WAIT_PORT_FREE
    while time.time() < end and probe(host, port):
        time.sleep(0.3)
    if probe(host, port):
        log_line(f"⚠ 端口 {port} 还被占着就动手了（可能上一个实例没退干净）", log_path)

    # 2) 用新代码起来
    proc = spawn(state, log_path)
    j = wait_up(base, to, WAIT_HEALTHY, log_path, "新版本", data_dir)
    if j is not None:
        updater.write_state(data_dir, "status.json", {
            "state": "ok", "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "from_version": frm, "to_version": version_of(j), "port": port, "launcher": state.get("launcher"),
            "detail": "更新完成，服务已用新版本起来",
        })
        updater.clear_state(data_dir, "pending.json")
        updater.clear_state(data_dir, updater.RESTART_FLAG)
        updater.prune_backups(data_dir, log=log_line_wrap(log_path))
        log_line(f"==== 更新完成：现在跑的是 V{version_of(j)} ====", log_path)
        return 0

    # 3) 新版本没起来 → 回滚（现场不能因为一次更新就黑屏）
    log_line("新版本没能起来 —— 开始自动回滚", log_path)
    try:
        proc.terminate()
    except Exception:                                           # noqa: BLE001
        pass
    time.sleep(1.0)
    rb = updater.rollback(Path(state.get("backup_dir") or ""), ROOT, log=log_line_wrap(log_path))
    proc2 = spawn(state, log_path)
    j2 = wait_up(base, frm, WAIT_HEALTHY, log_path, "回滚后的旧版本", data_dir)
    state_obj = {
        "state": "rolled_back" if j2 is not None else "failed",
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "from_version": frm, "to_version": to, "port": port, "launcher": state.get("launcher"),
        "rollback": rb,
        "detail": ("已回滚到 V" + version_of(j2)) if j2 is not None
                  else "回滚后服务没能在我们等的地址上应答（可能换了端口或真没起来）—— 看 logs/ 里最新的日志，"
                       "或重新双击 start_server.bat / start_hmi_window.bat",
    }
    updater.write_state(data_dir, "status.json", state_obj)
    updater.clear_state(data_dir, "pending.json")
    updater.clear_state(data_dir, updater.RESTART_FLAG)
    log_line(f"==== 更新失败：{state_obj['detail']} ====", log_path)
    return 1


def log_line_wrap(log_path: Path):
    """updater 里的 log 回调（它只想"说一句"，落哪儿由这里定）"""
    return lambda msg: log_line(msg, log_path)


if __name__ == "__main__":
    sys.exit(main())
