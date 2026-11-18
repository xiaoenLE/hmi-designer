# -*- coding: utf-8 -*-
"""
launcher.py — 打包成 exe 之后的「壳」

打出来的东西长这样（PyInstaller onedir）：

    C:\\Program Files\\WebHMI-Designer\\        ← 安装目录（安装时可选）
    ├── WebHMIDesigner.exe                      ← 这个壳：Python 运行时 + pywebview + 启动逻辑
    ├── _internal\\                          ← exe 自带的运行时/DLL（很少变，不参与日常更新）
    ├── logs\\                               ← **日志默认就在这儿**（安装包已建好并给了写权限）
    └── app\\                                 ← **业务代码放这儿，日常更新只换这一层**
        ├── index.html  css\\  js\\
        ├── server\\  (server.py / modbus.py / updater.py / _restart.py …)
        └── version.json

    C:\\ProgramData\\HMI-Designer\\           ← **现场数据在这儿，谁也碰不到**
    ├── data\\      (画面工程 / 变量表 / PLC 配置 / 报警记录 / 口令 / 掉电保持值)
    └── logs\\      (只在安装目录写不进去时才用：老安装包 / 权限极严的机器，见 pick_log_dir)

为什么要拆成"壳 + app"两层（改动前先想清楚）：
  · **运行中的 exe 不能覆盖自己**：Windows 会锁住正在执行的可执行文件 ——
    所以"更新"绝不能是"替换 exe"，只能是"替换旁边那几个文本文件"。
  · 于是更新不需要管理员（不弹 UAC）、不需要重装，几 MB 就够；只有"壳"本身
    （Python 运行时/pywebview）要升级时才重跑安装包（那时才需要 UAC）。
  · **数据**（工程/变量表/配置）放 %ProgramData% 而不是安装目录：装在 Program Files 下
    程序目录本来就写不进去，而且这样一来**安装 / 更新 / 卸载都碰不到现场工程与配置** ——
    这是"更新不会删配置和工程"的根本保证，比"更新时小心别删"可靠
    （见 server/updater.py 里还有第二道断言）。
  · **日志**放安装目录下的 logs\\（现场要求：%ProgramData% 默认是隐藏目录，日志"找不到"）：
    安装包把它建好并给普通用户写权限，真写不进去时自动退到 %ProgramData%\\HMI-Designer\\logs
    → 再不行退到数据目录下的 logs（见 pick_log_dir；**永远不让"写不了日志"把程序卡住**）。

这个文件**不打进 exe 的模块里被 import**，而是 exe 的入口：它再动态加载 app\\ 下的代码，
所以 app\\ 里的东西改了立刻就生效，不需要重新打包。
"""
import importlib.util
import os
import shutil
import sys
import time
from pathlib import Path

APP_DIRNAME = "app"
PROGRAM_DATA_APP = "HMI-Designer"       # ⚠ 保持老名：现场数据在这个目录里，改名 = 工程消失       # %ProgramData%\HMI-Designer\
LAUNCHER_VERSION = "2.0.0"              # 壳自己的版本（跟应用的 version.json 分开，见 min_launcher）
                                        # ⚠ 2.0 的壳跟 1.x 不通用：应用改成"前端只走长连接"了，
                                        #   用 1.x 的壳 + 2.0 的 app 目录（或反过来）都会出怪问题 →
                                        #   发布清单里 min_launcher 写 2.0.0，逼着必须装新安装包。


def is_frozen() -> bool:
    """是不是"打包后的 exe"在跑。

    ⚠ 两个打包器判定方式不一样，**两个都要认**（这条别删）：
      · PyInstaller → sys.frozen = True
      · Nuitka      → **不设 sys.frozen**，但每个被编译的模块里都会注入一个 __compiled__ 全局
    （Nuitka 那条漏了会怎样：壳以为自己是在源码目录里跑 → exe_dir() 往上多退一级 →
       app\\ 路径整个错位 → 双击没反应，日志里 exe= 那行指到上一级目录去）
    """
    return bool(getattr(sys, "frozen", False)) or "__compiled__" in globals()


def exe_dir() -> Path:
    """exe 所在目录（没打包时 = 本文件所在目录的上一级，方便直接 python 跑这个壳做测试）"""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _msgbox(title: str, text: str):
    """没控制台的 exe 里出了事只能弹框说 —— 否则用户只看到"双击没反应" """
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)   # MB_ICONERROR
    except Exception:                                               # noqa: BLE001
        print(f"[launcher] {title}: {text}")


def pick_data_dir(base: Path, log) -> Path:
    """现场数据目录：**默认 %ProgramData%\\HMI-Designer\\data**（全机器共用、服务/多用户都能读写、
    不在安装目录里 → 更新/卸载都碰不到）。

    · 环境变量 HMI_DATA_DIR 优先（自动化测试、多套部署用）
    · %ProgramData% 建不出来（权限极严的机器）→ 退到用户目录，并在日志里说清楚
    """
    env = (os.environ.get("HMI_DATA_DIR") or "").strip()
    if env:
        p = Path(env)
        p.mkdir(parents=True, exist_ok=True)
        return p
    pd = (os.environ.get("ProgramData") or r"C:\ProgramData").strip()
    for cand in (Path(pd) / PROGRAM_DATA_APP / "data",
                 Path(os.environ.get("LOCALAPPDATA") or (base / "userdata")) / PROGRAM_DATA_APP / "data"):
        try:
            cand.mkdir(parents=True, exist_ok=True)
            # 真写一个文件试一下：ProgramData 有时"建目录可以、写文件不行"
            probe = cand / ".write-test"
            probe.write_text("x", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return cand
        except Exception as e:                                      # noqa: BLE001
            log(f"数据目录 {cand} 不能用（{type(e).__name__}: {e}），换下一个")
    raise SystemExit("找不到可写的数据目录（%ProgramData% 和用户目录都写不进去）")


def _writable(d: Path) -> bool:
    """这个目录真能写文件吗（Windows 上"能建目录、写不进文件"很常见，所以真写一个试）"""
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".write-test"
        probe.write_text("x", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:                                               # noqa: BLE001
        return False


def pick_log_dir(base: Path, data_dir: Path) -> tuple:
    """日志目录：**默认就是安装目录下面的 logs\\**。

    现场要求（原话）："logs 日志默认路径就放在安装路径下边吧，不要放在 ProgramData，
    这个不好找" —— %ProgramData% 在资源管理器里默认是隐藏的，让人去那儿翻日志确实绕。

    顺序（第一个能写的就用它；**永远不让"写不了日志"把程序卡住**）：
      ① 环境变量 HMI_LOG_DIR —— 多套部署 / 自动化测试显式指定，**优先级最高，这条规矩别动**
      ② <安装目录>\\logs —— 安装包已经建好并给了普通用户写权限（见 installer.py / .iss）
      ③ %ProgramData%\\HMI-Designer\\logs —— 老位置：老安装包装的、没重新装过安装包，
         或者机器权限特别严时用它兜底（能写就用，写不了继续往下退）
      ④ <数据目录>\\logs —— 最后兜底：数据都在那儿写着了，一定写得进去

    ⚠ **数据**（工程 / 变量表 / PLC 配置）仍然留在 %ProgramData%\\HMI-Designer\\data，这里不动它 ——
      "安装 / 更新 / 卸载都碰不到现场工程"这条保证靠的就是它（见本文件开头那段）。
    @returns (目录, 说明)  说明只用来写进启动日志，方便现场回答"日志到底在哪"
    """
    env = (os.environ.get("HMI_LOG_DIR") or "").strip()
    if env and _writable(Path(env)):
        return Path(env), "HMI_LOG_DIR（部署指定）"
    cands = ((base / "logs", "安装目录"),
             (Path(os.environ.get("ProgramData") or r"C:\ProgramData") / PROGRAM_DATA_APP / "logs",
              "%ProgramData%（老位置兜底）"),
             (data_dir / "logs", "数据目录（最后兜底）"))
    for cand, where in cands:
        if _writable(cand):
            return cand, where
    raise SystemExit("找不到可写的日志目录（安装目录 / %ProgramData% / 数据目录都写不进去）")


def adopt_legacy_data(app_dir: Path, data_dir: Path, log):
    """老布局（程序目录\\server\\data 里放着现场工程）→ 搬进新的数据目录。

    只在**新目录还是空的**时搬，而且**不删老目录**（万一还有别的东西在用；也不给现场
    "有人动过我的工程"的错觉）。这一步只为了一件事：老机器换新版之后工程不能"消失"。
    """
    legacy = app_dir / "server" / "data"
    if data_dir.resolve() == legacy.resolve() or not legacy.is_dir():
        return
    # 新目录已经有工程了就不动（工程文件后缀是 .LE；老机器上可能是老的 .json，两个都算"已经有了"）
    if (data_dir / "hmi_project.LE").exists() or (data_dir / "hmi_project.json").exists():
        return
    try:
        items = [p for p in legacy.iterdir() if p.name not in ("webview", "__pycache__")]
        if not items:
            return
        for p in items:
            dst = data_dir / p.name
            if p.is_dir():
                shutil.copytree(p, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(p, dst)
        log(f"已把老位置的数据搬到新数据目录（老目录保留）：{legacy} → {data_dir}")
    except Exception as e:                                          # noqa: BLE001
        log(f"搬老数据失败（{type(e).__name__}: {e}）—— 程序会照常启动，数据还在老位置")


def load_module(path: Path, name: str):
    """从磁盘加载一个 .py（**动态加载**：不经 PyInstaller 静态分析 → 不会被打进 exe → 能就地更新）"""
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"加载不了 {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    base = exe_dir()
    app_dir = base / APP_DIRNAME

    # 数据目录要先定下来（下面写日志、判断"装没装好"都要用）
    data_dir = pick_data_dir(base, lambda m: None)
    log_dir, log_where = pick_log_dir(base, data_dir)

    def log(msg: str):
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"
        try:
            with open(log_dir / "launcher.log", "a", encoding="utf-8") as f:
                f.write(line)
        except Exception:                                           # noqa: BLE001
            pass

    log(f"==== 启动：exe={base} app={app_dir} data={data_dir} logs={log_dir}（{log_where}） 壳版本={LAUNCHER_VERSION} ====")

    if not (app_dir / "server" / "hmi_desktop.py").exists():
        _msgbox("WebHMI_设计器",
                f"程序文件不完整：找不到\n{app_dir / 'server' / 'hmi_desktop.py'}\n\n"
                "请重新运行安装包（WebHMI-Designer-Setup-*.exe）安装。\n"
                f"（现场数据在 {data_dir}，重装不会动它）")
        return 2

    adopt_legacy_data(app_dir, data_dir, log)

    # 交给 app 里的后端：数据目录/日志目录/启动方式/壳版本都通过环境变量告诉它
    os.environ["HMI_DATA_DIR"] = str(data_dir)
    os.environ["HMI_LOG_DIR"] = str(log_dir)
    os.environ["HMI_LAUNCH"] = "desktop"          # 原生窗口：更新后要连窗口一起拉回来
    os.environ["HMI_LAUNCHER_VERSION"] = LAUNCHER_VERSION
    os.environ["HMI_APP_DIR"] = str(app_dir)

    # app 代码接上 sys.path：hmi_desktop.py 里 `import server as hmi` 才找得到
    sys.path.insert(0, str(app_dir / "server"))
    sys.path.insert(0, str(app_dir))

    # 更新助手模式：`WebHMIDesigner.exe --hmi-update-helper <pending.json>`（或 --rollback）
    # 为什么要绕这么一圈：更新助手要"等老进程退出 → 用新代码把服务拉起来 → 起不来就回滚"，
    # 它必须能活过老进程，还得**有 Python 解释器**——exe 里就带着解释器，所以由 exe 来当这个助手。
    argv = sys.argv[1:]
    if "--hmi-update-helper" in argv:
        argv = [a for a in argv if a != "--hmi-update-helper"]
        sys.argv = [str(app_dir / "server" / "_restart.py")] + argv
        rest = load_module(app_dir / "server" / "_restart.py", "hmi_restart_helper")
        return int(rest.main())

    # 正常启动：进原生窗口（hmi_desktop.main 自己解析 argv / 开窗 / 关窗即停服务）
    desktop = load_module(app_dir / "server" / "hmi_desktop.py", "hmi_desktop_app")
    return int(desktop.main())


if __name__ == "__main__":
    sys.exit(main())
