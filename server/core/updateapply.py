#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""updateapply.py — 「立即更新」：下载代码包 → 只覆盖代码 → 自己重启

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

⚠ apply_update() **发完响应就会让进程退出**：调用方（前端）收到 ok 之后
要开始等它回来，别以为是自己断线了（见 js/editor/updateCheck.js 的 waitBackendBack）。
"""

from . import datasource
from .paths import DATA_DIR
from .paths import LOG_DIR
from .paths import ROOT
from .plcsource import _REMOTE_SRC
from .versioninfo import LAUNCHER_VERSION
from .versioninfo import UPDATE_MANIFEST_URL
from .versioninfo import _local_version
from .versioninfo import check_update

from pathlib import Path
import os
import subprocess
import sys
import threading
import time
import updater                    # 同目录：自己更新（下载代码包 / 只覆盖代码 / 备份 / 回滚）


# ─────────────────────────────────────────────
#  「立即更新」：下载新版代码 → 只覆盖代码 → 换进程重启
#  ⚠ 和上面"只检查"是两码事：这一段的**会动自己代码**，铁律见 updater.py 开头
#    （绝不碰 server/data、覆盖前先备份、只认白名单）。
#  ⚠ 进程会在响应发出去之后自杀 —— Python 里的模块早就加载完了，不换进程跑不上新代码。
#    **谁来把它拉起来：一律是 server/_restart.py 助手**（它才带回滚）。
#    launcher 只用来决定"用哪个命令拉回来"：
#      · start_hmi_window.bat（原生窗口）→ 连窗口一起拉回来
#      · 其它（命令行后端）→ 起 server/server.py，并补 --no-browser
#    ⚠ 别给某些启动方式开"让启动脚本自己循环重启"的口子：那样那条路就**没有回滚**了
#      （新版起不来 → 循环拉起一个坏版本 → 现场一直黑屏）。统一走助手，回滚才处处都有。
# ─────────────────────────────────────────────
_DEFAULT_UPDATE_ARCHIVE = "http://124.221.183.24:3000/xiaoen/hmi-designer/archive/master.zip"

# 换下载源：环境变量 HMI_UPDATE_ARCHIVE；显式空串 = 关掉「立即更新」（只保留版本提示）
UPDATE_ARCHIVE_URL = (os.environ["HMI_UPDATE_ARCHIVE"].strip() if "HMI_UPDATE_ARCHIVE" in os.environ
                      else _DEFAULT_UPDATE_ARCHIVE)

_update_apply_lock = threading.Lock()

_apply_running = False          # 正在更新（前端的进度提示 / health 里会报）



def _update_launcher() -> str:
    """这个进程是怎么起来的 —— 决定**用哪个命令**把它拉回来。
    由启动方设置：hmi_desktop.py 设 desktop、start_server.bat 设 console-bat；
    直接 python server/server.py 时为 console（默认）。"""
    return (os.environ.get("HMI_LAUNCH") or "console").strip() or "console"



def _restart_helper_cmd(pending_file: Path):
    """拉起重启助手用的命令。

    · 源码方式跑（python server/server.py）：助手就是 server/_restart.py，用同一个解释器跑
    · 打包成 exe 跑：**程序目录里没有 python 解释器**，但 exe 自己带着 —— 所以让 exe
      用 `--hmi-update-helper` 再起一个自己（见 packaging/launcher.py 里那个模式）。
      这也顺带解决了"exe 不能覆盖自己"：助手是另一个进程，等老进程退出才动手。"""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--hmi-update-helper", str(pending_file)]
    return [sys.executable, str(ROOT / "server" / "_restart.py"), str(pending_file)]



def _spawn_restart_helper(pending_file: Path, log_path: Path):
    """拉起重启助手。必须 detached：它得活到**本进程退出之后**（否则跟着一起被收走）

    ⚠ 助手的输出**不能接到它自己那份日志上**（log_path）：助手自己也会往那个文件里写日志，
      两个写者共用一个文件 → 行与行互相穿插、中文被截断成乱码（踩过：更新日志"看不懂"就是这个）。
    ⚠ 子进程的 stdout 编码默认跟系统区域走（中文 Windows 是 GBK），而日志按 UTF-8 读 →
      所以显式给 PYTHONIOENCODING=utf-8。
    """
    cmd = _restart_helper_cmd(pending_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    child_log = log_path.with_name(log_path.stem + "-child.log")
    out = open(child_log, "a", encoding="utf-8")
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    kw = {"cwd": str(ROOT), "env": env, "stdout": out, "stderr": out, "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200     # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen(cmd, **kw)
    print(f"[update] 已拉起重启助手（{'exe 自带解释器' if getattr(sys, 'frozen', False) else sys.executable}）"
          f"，它的原始输出在 {child_log.name}")



def _exit_for_update(pending_file: Path, log_path: Path):
    """响应发出去之后再退出。先停轮询、把变量落盘 —— 跟正常关闭一样的收尾顺序。
    然后**一定**拉起重启助手（它才带回滚；这是唯一一条把服务带回来的路）。"""
    time.sleep(1.0)                       # 让 HTTP 响应先到前端（否则界面只看到"连接被断开"）
    print("[update] 正在退出，准备用新代码重启 …")
    try:
        if isinstance(datasource.get_source(), _REMOTE_SRC):
            datasource.get_source().stop()
    except Exception as e:                                      # noqa: BLE001
        print(f"[update] 停轮询时出错（继续退出）：{e}")
    try:
        datasource.get_source().flush()                   # 合并窗口里没落盘的变量写下去
    except Exception as e:                                      # noqa: BLE001
        print(f"[update] 变量落盘出错（继续退出）：{e}")
    try:
        _spawn_restart_helper(pending_file, log_path)
        print("[update] 服务稍后由助手用新代码拉起（起不来会自动回滚；本窗口可以关掉）")
    except Exception as e:                                      # noqa: BLE001
        print(f"[update] 拉起重启助手失败：{type(e).__name__}: {e} —— 请手动重新运行 start_server.bat")
    try:
        sys.stdout.flush()
    except Exception:                                           # noqa: BLE001
        pass
    os._exit(0)



def write_up_report(host: str, port: int):
    """把「我起来了 + 实际绑在哪个端口」写进数据目录（更新助手靠它确认新版本到底起没起来）。

    ⚠ 为什么不能只按"记下来的那个端口"查健康：端口可能被别的东西占着，hmi_desktop 会自动
      换一个空闲端口 —— 助手只在老端口上问，就会把"其实起来了"误判成"没起来"，于是**自动回滚**
      （现场真实踩到：更新后自己退回上一版，日志里写着「端口 8866 被占用，改用空闲端口 60805」）。
    """
    try:
        updater.write_state(DATA_DIR, "up.json", {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "version": str((_local_version() or {}).get("version") or ""),
            "host": host, "port": int(port), "pid": os.getpid(),
            "launcher": _update_launcher(),
        })
    except Exception as e:                                      # noqa: BLE001
        print(f"[update] 写「已启动」报告失败（不影响运行）：{e}")



def apply_update(host: str = "127.0.0.1", port: int = 8866):
    """「立即更新」：下载 + 覆盖代码 + 准备重启。返回给前端的 dict。

    ⚠ 返回之后进程会在 ~1 秒内退出 → 调用方（do_POST）必须**先把结果发出去**。
    ⚠ 任何一步失败都只是"没更新成"，代码保持原样（覆盖中途失败会自动回滚）——
      现场不能因为点了更新就变成半新半旧。"""
    global _apply_running
    if not UPDATE_ARCHIVE_URL:
        return {"ok": False, "error": "「立即更新」已关闭（启动时 HMI_UPDATE_ARCHIVE 设成了空串）"}
    if not _update_apply_lock.acquire(blocking=False):
        return {"ok": False, "error": "已经有一次更新在进行，等它跑完"}
    try:
        if _apply_running:
            return {"ok": False, "error": "已经有一次更新在进行，等它跑完"}
        # 1) 先问清楚"该不该更新"：本地版本 / 远端版本 / 能不能连上
        chk = check_update(force=True)
        lv = str((chk.get("local") or {}).get("version") or "")
        rv = str((chk.get("remote") or {}).get("version") or "")
        if chk.get("state") == "disabled":
            return {"ok": False, "error": "更新功能已关闭（HMI_UPDATE_URL 为空）"}
        if chk.get("state") == "error":
            return {"ok": False, "error": f"连不上更新服务器，没法更新：{chk.get('error') or '未知原因'}"
                                          "（现场没外网就会这样；请在能上仓库的机器上更新）"}
        if not chk.get("available"):
            why = {"same": f"已经是最新版本（V{lv}）",
                   "local_newer": f"仓库里还是 V{rv}，比本地 V{lv} 旧 —— 不更新"}.get(
                       chk.get("state"), f"没有可用的更新（{chk.get('state')}）")
            return {"ok": False, "error": why}

        # 1.5) 壳版本门禁：清单说"这次要更新的壳版本比我高" → 就地更新做不到，
        #      只能装新版安装包（运行时的升级不可能靠在旁边放几个 .py 文件完成）
        remote = chk.get("remote") or {}
        need = str(remote.get("min_launcher") or "").strip()
        if need and updater.version_key(LAUNCHER_VERSION or "0") < updater.version_key(need):
            return {"ok": False, "need_launcher": need, "now_launcher": LAUNCHER_VERSION,
                    "setup": updater.package_url(remote, "setup", UPDATE_MANIFEST_URL),
                    "error": f"这一版要新版运行环境（壳 {need}，本机是 {LAUNCHER_VERSION or '未知'}）——"
                             "请下载并运行新版安装包 WebHMI-Designer-Setup-*.exe（安装它不会动现场工程与配置）"}

        # 2) 下载（标准库直连；下不完整就丢弃）。
        #    优先用清单里指的那个代码包（发布仓库里的 app 包，带 sha256）；老清单没有就退回默认地址
        url = updater.package_url(remote, "app_zip", UPDATE_MANIFEST_URL) or UPDATE_ARCHIVE_URL
        want_sha = ""
        pkg = remote.get("app_zip")
        if isinstance(pkg, dict):
            want_sha = str(pkg.get("sha256") or "")
        zip_path = updater.temp_download_path()
        dl = updater.download_archive(url, zip_path)
        if not dl.get("ok"):
            return {"ok": False, "error": f"下载代码包失败：{dl.get('error')}"}

        # 3) 覆盖代码（白名单 + 先备份；**数据目录一个字节都不动** —— updater 里有硬断言）
        res = updater.apply_archive(zip_path, ROOT, DATA_DIR, lv, expect_version=rv,
                                   expect_sha256=want_sha)
        try:
            zip_path.unlink(missing_ok=True)
        except Exception:                                       # noqa: BLE001
            pass
        if not res.get("ok"):
            return {"ok": False, "error": f"更新失败（代码没动）：{res.get('error')}",
                    "rollback": res.get("rollback")}

        # 4) 安排重启：状态文件写进 data（它不会被更新覆盖），然后退出
        _apply_running = True
        launcher = _update_launcher()
        use_helper = True        # 一律走助手 —— 它是唯一带回滚的那条路（见上面那段说明）
        pending = {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "from_version": lv, "to_version": str(res.get("version") or rv),
            "backup_dir": str(res.get("backup_dir") or ""), "launcher": launcher,
            "argv": list(sys.argv[1:]),
            "host": host, "port": int(port),
            # 只带 HMI_* 这几个（数据目录/更新源/启动方式）——全新进程要把它们接上，
            # 否则重启后可能换一份数据目录，现场看着就是"工程没了"
            "env": {k: v for k, v in os.environ.items() if k.startswith("HMI_")},
            "root": str(ROOT), "data_dir": str(DATA_DIR), "use_helper": use_helper,
            # 打包成 exe 时：助手由 exe 自己当（程序目录里没有 python），重启也重启 exe。
            # frozen/exe 这两个字段就是给 server/_restart.py 的 spawn() 看的。
            "frozen": bool(getattr(sys, "frozen", False)),
            "exe": sys.executable,
        }
        pending_file = updater.write_state(DATA_DIR, "pending.json", pending)
        (updater.state_dir(DATA_DIR) / updater.RESTART_FLAG).write_text("1", encoding="utf-8")
        # 更新日志跟 hmi 日志放一起（LOG_DIR 认 HMI_LOG_DIR）——
        # 打包成 exe 时程序目录在 Program Files 下写不进去，写那儿等于把线索丢了
        log_path = LOG_DIR / f"update-{time.strftime('%Y-%m-%d')}.log"
        threading.Thread(target=_exit_for_update, args=(pending_file, log_path),
                         name="update-exit", daemon=True).start()
        print(f"[update] 代码已覆盖：V{lv} → V{pending['to_version']}（备份 {pending['backup_dir']}），准备重启")
        return {"ok": True, "from_version": lv, "to_version": pending["to_version"],
                "copied": res.get("copied"), "created": res.get("created"),
                "backup_dir": pending["backup_dir"],
                "restart": "服务由重启助手拉起来（起不来自动回滚）",
                "note": "服务马上重启（画面与采集会断几秒）；起不来会自动回滚到旧版本"}
    except Exception as e:                                      # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        _update_apply_lock.release()

# ─────────────────────────────────────────────
#  访问器（拆分时新增，见 core/__init__.py 铁律①）
# ─────────────────────────────────────────────
def is_applying():
    """现在是不是正在「立即更新」（前端的进度提示、hello 帧的 update.applying 用它）。

    ⚠ 别的模块一律用这个读，不要 `from .updateapply import _apply_running`：
    那个标记**会被改**（apply_update 里置 True），直接 import 拿到的是导入那一刻的副本,
    于是"正在更新"永远报 False（前端就不会等它，反而以为后端挂了）。
    """
    return bool(_apply_running)
