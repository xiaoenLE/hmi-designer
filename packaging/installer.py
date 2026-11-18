# -*- coding: utf-8 -*-
"""
installer.py — 「WebHMI_设计器」安装器（自己做的，不依赖 Inno Setup）

为什么要自己做一个：Inno Setup 只发布在 GitHub，这台构建机连不上（被墙），winget 也因此卡死。
它要做的事其实不多，而**最关键的那条**必须由我们自己保证：

    ★ 现场数据（工程/变量表/PLC 配置/报警/口令）在 %ProgramData%\\HMI-Designer\\，
      安装、升级、卸载**都绝不碰它** —— 一个卸载器写错就可能删掉客户几年的工程，
      这个风险不值得交给"配置一个别人的脚本"。

功能：
  · **安装路径可以自己选**（有默认值 + 浏览按钮）
  · 装"壳 + app"两层：<目录>\\WebHMIDesigner.exe(+_internal) 与 <目录>\\app\\
  · 开始菜单/桌面快捷方式（可选）
  · 写"添加/删除程序"里的卸载项；生成的 uninstall.bat 只删程序、**保留数据**
  · 静默安装（自动化/大批量部署用）：--silent --dir=D:\\HMI [--no-launch] [--no-shortcut]
  · 静默卸载：--uninstall --dir=D:\\HMI

打出来的包长这样（PyInstaller onefile，payload 就打在 exe 里）：
    WebHMI-Designer-Setup-<版本>.exe
      └─ 运行时解到临时目录：payload\\WebHMIDesigner\\*（壳）、payload\\app\\*（业务代码）
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

APP_NAME = "WebHMI_设计器"
AUTHOR = "xiaoen"                      # 作者/发布者（写进"添加/删除程序"与 exe 属性）
EXE_NAME = "WebHMIDesigner.exe"
# 改名之前那版的可执行文件名/显示名：升级时要把它们收掉（否则新旧两个进程抢同一个端口、
# 桌面上还会留一个指向已删除 exe 的旧快捷方式）
OLD_EXE_NAMES = ("HMIDesigner.exe",)
OLD_APP_NAMES = ("HMI 组态设计器",)
DATA_ROOT = "HMI-Designer"            # ← 老机器上的现场数据就在这儿，**改名 = 工程消失**（%ProgramData%\HMI-Designer\）
UNINSTALL_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WebHMI-Designer"
OLD_UNINSTALL_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\HMI-Designer"


def payload_dir() -> Path:
    """安装内容在哪：打包后是 exe 解出来的临时目录，源码方式跑就是本目录的上一级 build\\stage"""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    for cand in (base / "payload", base.parent / "build" / "stage" / "payload"):
        if cand.is_dir():
            return cand
    raise SystemExit(f"找不到安装内容（payload）：{base}")


# 默认**安装**目录用新品牌名；而上面的 DATA_ROOT（现场数据目录）保持老名不变
INSTALL_DIRNAME = "WebHMI-Designer"


def default_dir() -> str:
    """默认安装目录。**如果机器上已经装过（旧名或新名），默认装回原位**——
    否则改名之后会变成"又装了一份"，用户桌面上两个图标、现场分不清哪个是哪个。"""
    for key in (UNINSTALL_KEY, OLD_UNINSTALL_KEY):
        try:
            r = run(["reg", "query", f"HKLM\\{key}", "/v", "InstallLocation"])
            for ln in (r.stdout or "").splitlines():
                if "InstallLocation" in ln and "REG_SZ" in ln:
                    p = ln.split("REG_SZ", 1)[1].strip()
                    if p and Path(p).parent.exists():
                        return p
        except Exception:                                               # noqa: BLE001
            pass
    return os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), INSTALL_DIRNAME)


def cleanup_old_install(log):
    """把改名之前那版留下的东西收干净：进程、旧卸载登记、旧快捷方式、目标目录里的旧 exe。
    ★ 只删**程序**，绝不碰 %ProgramData%\\HMI-Designer（现场工程与配置在那儿）。"""
    for exe in (EXE_NAME,) + OLD_EXE_NAMES:
        run(["taskkill", "/f", "/im", exe])
    try:
        r = run(["reg", "query", f"HKLM\\{OLD_UNINSTALL_KEY}"])
        if r.returncode == 0:
            run(["reg", "delete", f"HKLM\\{OLD_UNINSTALL_KEY}", "/f"])
            log("已清掉旧名（HMI-Designer）的卸载登记")
    except Exception:                                                   # noqa: BLE001
        pass
    dirs = [Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft/Windows/Start Menu/Programs",
            Path(os.environ.get("USERPROFILE", "")) / "Desktop",
            Path(os.environ.get("PUBLIC", "")) / "Desktop"]
    for d in dirs:
        for old in OLD_APP_NAMES:
            lnk = d / f"{old}.lnk"
            try:
                if lnk.exists():
                    lnk.unlink()
                    log(f"已删掉旧快捷方式：{lnk.name}")
            except Exception:                                           # noqa: BLE001
                pass


def version_of(payload: Path) -> str:
    try:
        return json.loads((payload / "app" / "version.json").read_text(encoding="utf-8")).get("version", "?")
    except Exception:                                                   # noqa: BLE001
        return "?"


def run(cmd, **kw):
    """跑个命令，别弹黑框"""
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("encoding", "utf-8")
    kw.setdefault("errors", "ignore")
    if os.name == "nt":
        kw.setdefault("creationflags", 0x08000000)      # CREATE_NO_WINDOW
    return subprocess.run(cmd, **kw)


def ensure_data_dirs(log):
    """建数据目录并给普通用户写权限（应用是普通用户跑的，ProgramData 下默认可能写不进去）。
    ★ 已存在就**一个字都不动**（现场工程在里面）。

    ⚠ 这里**只建 data**：日志不再放 ProgramData（现场说"%ProgramData% 不好找"），
      默认在安装目录下的 logs\\（见 ensure_install_logs）。万一安装目录写不进去、
      launcher 要退到 %ProgramData%\\HMI-Designer\\logs 时，那个目录会在创建时
      **自动继承**这底下这条 Users 的 (OI)(CI)M 权限 —— 所以不用预先建它。
      老机器上已经存在的 %ProgramData%\\HMI-Designer\\logs 一概不删（那是历史日志）。"""
    pd = os.environ.get("ProgramData") or r"C:\ProgramData"
    root = Path(pd) / DATA_ROOT
    for sub in ("", "data"):
        d = root / sub if sub else root
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception as e:                                          # noqa: BLE001
            log(f"⚠ 建不了 {d}（{e}）—— 程序自带兜底：会退到用户目录")
            continue
    # 给 Users 改权限（只在装的时候做一次；失败不影响安装）
    try:
        run(["icacls", str(root), "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/C", "/Q"])
        log(f"数据目录就绪：{root}（已给普通用户写权限；升级/卸载都不会删它）")
    except Exception as e:                                              # noqa: BLE001
        log(f"⚠ 设置数据目录权限失败（{e}）—— 程序会按自己的权限兜底")
    return root


def ensure_install_logs(target: Path, log):
    """建**安装目录下的 logs\\**（默认日志位置：现场双击安装目录进去就看见了，不用翻隐藏目录），
    并给普通用户写权限 —— 装在 Program Files 下默认写不进去，而应用是普通用户跑的。

    失败**不影响安装、也不影响使用**：launcher 会按"安装目录 → %ProgramData% → 数据目录"
    自己退到能写的地方（见 packaging/launcher.py 的 pick_log_dir），只是日志不在这儿而已。"""
    d = target / "logs"
    try:
        d.mkdir(parents=True, exist_ok=True)
        # 真写一个文件试一下（"建目录可以、写文件不行"在 Windows 上很常见）
        probe = d / ".write-test"
        probe.write_text("x", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except Exception as e:                                              # noqa: BLE001
        log(f"⚠ 日志目录 {d} 建不出来/写不进去（{e}）—— 日志会用 %ProgramData%\\{DATA_ROOT}\\logs")
        return None
    try:
        run(["icacls", str(d), "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/C", "/Q"])
        log(f"日志目录就绪：{d}（已给普通用户写权限，日志默认就写在这儿）")
    except Exception as e:                                              # noqa: BLE001
        log(f"⚠ 设置日志目录权限失败（{e}）—— 日志可能退到 %ProgramData%\\{DATA_ROOT}\\logs")
    return d


def make_shortcut(target: Path, link: Path, log):
    """用 Windows 自带的 WScript.Shell 建 .lnk（不引第三方库）"""
    ps = (f'$s=(New-Object -ComObject WScript.Shell).CreateShortcut("{link}");'
          f'$s.TargetPath="{target}";$s.WorkingDirectory="{target.parent}";'
          f'$s.IconLocation="{target}";$s.Save()')
    try:
        r = run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps])
        if r.returncode != 0:
            log(f"⚠ 建快捷方式失败：{link.name}")
    except Exception as e:                                              # noqa: BLE001
        log(f"⚠ 建快捷方式出错（{e}）")


def write_uninstaller(target: Path, log):
    """生成卸载器（.bat）。★ 只删程序，**永不触碰 %ProgramData%\\HMI-Designer**。

    ⚠ 日志在**安装目录下的 logs\\**（现场好找），卸载会跟着程序一起删掉 ——
      要留证据的话卸载前先把 logs\\ 拷出来。现场工程与配置在 %ProgramData%，不受影响。

    为什么要"复制自己到临时目录再跑"：bat 正在执行时它自己所在的目录删不掉。
    """
    bat = target / "uninstall.bat"
    bat.write_text(f"""@echo off
rem WebHMI_设计器 卸载（只删程序与安装目录下的 logs\\；现场工程与配置在 %ProgramData%\\{DATA_ROOT}，保留）
setlocal
set "DIR={target}"
set "TMPBAT=%TEMP%\\_hmi_uninstall_%RANDOM%.bat"
> "%TMPBAT%" echo @echo off
>>"%TMPBAT%" echo taskkill /f /im {EXE_NAME} >nul 2>nul
>>"%TMPBAT%" echo del /f /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\{APP_NAME}.lnk" >nul 2>nul
>>"%TMPBAT%" echo del /f /q "%USERPROFILE%\\Desktop\\{APP_NAME}.lnk" >nul 2>nul
>>"%TMPBAT%" echo del /f /q "%PUBLIC%\\Desktop\\{APP_NAME}.lnk" >nul 2>nul
>>"%TMPBAT%" echo reg delete "HKLM\\{UNINSTALL_KEY}" /f >nul 2>nul
>>"%TMPBAT%" echo ping -n 2 127.0.0.1 ^>nul
>>"%TMPBAT%" echo rmdir /s /q "%DIR%"
>>"%TMPBAT%" echo del /f /q "%~f0" ^>nul 2^>nul
start "" /min "%TMPBAT%"
endlocal
""", encoding="gbk", errors="ignore")     # cmd.exe 读 bat 按 ANSI(GBK)，UTF-8 会乱码
    log("已生成卸载器：uninstall.bat（保留现场数据；安装目录下的 logs\\ 会跟着删）")
    return bat


def write_registry(target: Path, version: str, log):
    size = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
    cmds = [
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "DisplayName", "/t", "REG_SZ", "/d", APP_NAME, "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "DisplayVersion", "/t", "REG_SZ", "/d", version, "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "Publisher", "/t", "REG_SZ", "/d", AUTHOR, "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "URLInfoAbout", "/t", "REG_SZ",
          "/d", "http://124.221.183.24:3000/xiaoen/hmi-designer", "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "InstallLocation", "/t", "REG_SZ", "/d", str(target), "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "DisplayIcon", "/t", "REG_SZ",
         "/d", str(target / EXE_NAME), "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "UninstallString", "/t", "REG_SZ",
         "/d", f'"{target / "uninstall.bat"}"', "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "NoModify", "/t", "REG_DWORD", "/d", "1", "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "NoRepair", "/t", "REG_DWORD", "/d", "1", "/f"],
        ["reg", "add", f"HKLM\\{UNINSTALL_KEY}", "/v", "EstimatedSize", "/t", "REG_DWORD",
         "/d", str(int(size / 1024)), "/f"],
    ]
    for c in cmds:
        run(c)
    log("已登记到「添加/删除程序」（卸载入口）")


def notify_shell(log):
    """装完告诉资源管理器"图标/关联变了"，让它立刻重读 exe 图标。

    为什么必须有：Windows 会把"某个路径 → 图标"缓存起来。换了新版 exe（图标也换了）之后，
    桌面/开始菜单上还是**旧图标**，用户第一反应是"你怎么没做图标"——其实 exe 里已经是新的
    （本地实测：抠出来看过），纯粹是缓存。SHChangeNotify(SHCNE_ASSOCCHANGED) 是官方做法，
    不用重启资源管理器（重启会闪桌面、关掉用户打开的文件夹窗口，装个软件不该这么干）。
    """
    try:
        import ctypes
        SHCNE_ASSOCCHANGED, SHCNF_IDLIST = 0x08000000, 0x0000
        ctypes.windll.shell32.SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None)
        log("已通知资源管理器刷新图标")
    except Exception as e:                                              # noqa: BLE001
        log(f"⚠ 通知资源管理器失败（{e}）—— 桌面图标可能要按一下 F5 才变")
    try:
        # Win10 自带的小工具，专门刷图标缓存；没有也不影响（上面那条已经够了）
        run(["ie4uinit.exe", "-show"], timeout=15)
    except Exception:                                                   # noqa: BLE001
        pass


def install(target: Path, payload: Path, log, shortcut=True):
    """真正的安装动作：拷壳 + 拷 app。★ 不碰 %ProgramData%，也不删 target 里别人的文件"""
    target.mkdir(parents=True, exist_ok=True)
    shell_src = payload / "WebHMIDesigner"
    app_src = payload / "app"
    if not (shell_src / EXE_NAME).exists():
        raise SystemExit(f"安装包内容不完整：找不到 {shell_src / EXE_NAME}")

    # 正在跑就先请它退出（否则 exe 被锁住换不了）；旧名那份（HMI-Designer.exe）与旧快捷方式、
    # 旧卸载登记一起收掉 —— 改名之后这些都会变成"孤儿"
    cleanup_old_install(log)
    for old in OLD_EXE_NAMES:
        stale = target / old
        if stale.exists():                     # 旧名残留的 exe：留着会让"双击哪个"说不清
            try:
                stale.unlink()
                log(f"已删除旧名的可执行文件：{old}")
            except Exception:                                           # noqa: BLE001
                pass
    time.sleep(1.0)

    n_shell = n_app = 0
    for src, dst, counter in ((shell_src, target, "shell"), (app_src, target / "app", "app")):
        for p in src.rglob("*"):
            rel = p.relative_to(src)
            rel_str = str(rel).replace("\\", "/")
            # ★ 绝不把"现场数据/日志"拷进安装目录 —— 但要**精确匹配**，不能一看到 data 就跳：
            #   js/data/pinyin.js 也是 data 目录（拼音数据），一刀切会把它一起跳过，
            #   结果前端模块 404、页面白板（踩过：装出来能开窗、接口全对，就是不出画面）
            if (rel_str == "server/data" or rel_str.startswith("server/data/")
                    or rel_str == "logs" or rel_str.startswith("logs/")
                    or "__pycache__" in rel.parts or p.suffix == ".pyc"):
                continue
            d = dst / rel
            if p.is_dir():
                d.mkdir(parents=True, exist_ok=True)
                continue
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, d)
            if counter == "shell":
                n_shell += 1
            else:
                n_app += 1
    log(f"程序文件已安装：壳 {n_shell} 个 + 业务代码 {n_app} 个 → {target}")
    # 日志目录：建好并给写权限（默认日志就写在这儿 —— 现场好找）。返回给上层提示用
    return ensure_install_logs(target, log)


def do_uninstall(target: Path, log):
    log(f"卸载：{target}（现场数据保留）")
    cleanup_old_install(log)          # 旧名那份的进程/快捷方式/卸载登记也一起收掉
    run(["taskkill", "/f", "/im", EXE_NAME])
    time.sleep(0.8)
    shutil.rmtree(target, ignore_errors=True)
    run(["reg", "delete", f"HKLM\\{UNINSTALL_KEY}", "/f"])
    for lnk in (Path(os.environ.get("ProgramData", "")) / "Microsoft/Windows/Start Menu/Programs",
                Path(os.environ.get("USERPROFILE", "")) / "Desktop",
                Path(os.environ.get("PUBLIC", "")) / "Desktop"):
        for name in (APP_NAME,) + OLD_APP_NAMES:
            try:
                (lnk / f"{name}.lnk").unlink(missing_ok=True)
            except Exception:                                           # noqa: BLE001
                pass
    notify_shell(log)                 # 图标缓存也刷一下，别让删掉的快捷方式还挂在桌面上
    log("已卸载程序与快捷方式（安装目录下的 logs\\ 也跟着删了）；%ProgramData%\\HMI-Designer 里的工程/配置没动")
    return 0


def gui(target_default: str, payload: Path, silent: bool, no_launch: bool, shortcut: bool) -> int:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    ver = version_of(payload)

    # ★ 高 DPI 声明（必须在建窗口之前）：不声明的话 Windows 会把整个窗口按缩放比**放大**——
    #   150% 缩放的机器上，620x430 的窗口会变成约 930x645 物理像素，小屏一体机/笔记本上
    #   底部就超出屏幕，「开始安装」被挤到屏幕外，点不到也装不了（现场真实踩到）。
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)     # Win8.1+：system DPI aware
        except Exception:                                       # noqa: BLE001
            ctypes.windll.user32.SetProcessDPIAware()           # 老系统兜底
    except Exception:                                           # noqa: BLE001
        pass

    root = tk.Tk()
    root.title(f"安装 {APP_NAME} {ver}")

    # 窗口尺寸**按实际屏幕算**并夹住上限，不再写死；居中偏上（别落到任务栏下面）
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    w = max(420, min(640, sw - 60))
    h = max(300, min(480, sh - 140))
    # 手动指定窗口大小：极端小屏/一体机上想再挤一点时用（HMI_INSTALLER_GEOM=420x300）
    env_geom = (os.environ.get("HMI_INSTALLER_GEOM") or "").strip().lower()
    if "x" in env_geom:
        a, _, b = env_geom.partition("x")
        if a.strip().isdigit() and b.strip().isdigit():
            w, h = int(a), int(b)
    root.geometry(f"{w}x{h}+{max(0, (sw - w) // 2)}+{max(0, (sh - h) // 3)}")
    # 允许缩放：屏幕特别小的机器，用户还能自己拉窗口（以前写死 resizable(False, False)，
    # 一旦有控件被挤出去就完全没救）
    root.minsize(380, 240)

    title_lab = tk.Label(root, text=f"{APP_NAME}  {ver}", font=("Microsoft YaHei UI", 13, "bold"))
    sep = ttk.Separator(root)
    lab_dir = tk.Label(root, text="安装位置：")
    row = tk.Frame(root)
    var_dir = tk.StringVar(value=target_default)
    ent = tk.Entry(row, textvariable=var_dir)
    ent.pack(side="left", fill="x", expand=True)

    def browse():
        d = filedialog.askdirectory(title="选择安装位置", initialdir=os.path.dirname(var_dir.get()))
        if d:
            var_dir.set(os.path.normpath(d))
    tk.Button(row, text="浏览…", command=browse).pack(side="left", padx=(6, 0))

    var_lnk = tk.BooleanVar(value=shortcut)
    var_run = tk.BooleanVar(value=not no_launch)
    chk1 = tk.Checkbutton(root, text="创建桌面快捷方式", variable=var_lnk)
    chk2 = tk.Checkbutton(root, text="安装完成后立即启动", variable=var_run)
    notice = tk.Label(root, text=f"日志就放在安装目录下的 logs\\（装完双击安装目录进去就能看见）。\n"
                                 f"现场数据（画面工程 / 变量表 / PLC 配置 / 报警记录）在 %ProgramData%\\{DATA_ROOT}\\，"
                                 "安装、升级、卸载都不会动它。",
                      fg="#0a7", justify="left", wraplength=max(300, w - 40))
    btn = tk.Button(root, text="开始安装", height=2, command=lambda: do_it())
    box = tk.Text(root, height=4, state="disabled", bg="#f7f8fa")

    # ★★ pack 顺序 = 抢空间的优先级。Tk 的 packer 是**先 pack 的先拿到空间**，
    #    side="bottom" 只是"从剩余空间的底部取"，并不等于优先 —— 这一点我踩过：
    #    以前按钮最后 pack，前面的标签/输入框把高度吃光，按钮分到 0 高度，
    #    小屏机器上就是"看不见安装按钮、装不了"。
    #    现在按重要性从高到低 pack：按钮 → 标题 → 安装路径 → 两个勾选 → 分隔线 → 说明 → 日志框。
    #    空间不够时最后 pack 的日志框先被挤掉，**按钮永远在**。
    btn.pack(side="bottom", fill="x", padx=14, pady=(6, 12))
    title_lab.pack(side="top", anchor="w", padx=14, pady=(10, 0))
    lab_dir.pack(side="top", anchor="w", padx=14)
    row.pack(side="top", fill="x", padx=14, pady=4)
    chk1.pack(side="top", anchor="w", padx=14)
    chk2.pack(side="top", anchor="w", padx=14)
    sep.pack(side="top", fill="x", padx=14, pady=6)
    notice.pack(side="top", anchor="w", padx=14, pady=(0, 4))
    box.pack(side="top", fill="both", expand=True, padx=14)

    def log(msg):
        box.configure(state="normal")
        box.insert("end", f"{msg}\n")
        box.see("end")
        box.configure(state="disabled")
        root.update()

    def do_it():
        target = Path(var_dir.get().strip().strip('"'))
        if not target.is_absolute():
            return messagebox.showerror("路径不对", "请填一个完整的安装路径（例如 D:\\WebHMI-Designer）")
        btn.configure(state="disabled")
        try:
            log(f"开始安装到 {target} …")
            logs_dir = install(target, payload, log, shortcut=var_lnk.get())
            data_root = ensure_data_dirs(log)
            write_uninstaller(target, log)
            write_registry(target, ver, log)
            if var_lnk.get():
                sm = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft/Windows/Start Menu/Programs"
                sm.mkdir(parents=True, exist_ok=True)
                make_shortcut(target / EXE_NAME, sm / f"{APP_NAME}.lnk", log)
                desk = Path(os.environ.get("USERPROFILE", "")) / "Desktop"
                if desk.is_dir():
                    make_shortcut(target / EXE_NAME, desk / f"{APP_NAME}.lnk", log)
                log("快捷方式已创建")
            notify_shell(log)
            log(f"完成 ✔  数据目录：{data_root}  日志目录：{logs_dir or (target / 'logs')}")
            messagebox.showinfo("安装完成", f"{APP_NAME} {ver} 已安装到：\n{target}\n\n"
                                            f"日志在：\n{logs_dir or (target / 'logs')}\n\n"
                                            f"现场数据（画面工程 / 变量表 / PLC 配置 / 报警记录）在：\n{data_root}")
            if var_run.get():
                subprocess.Popen([str(target / EXE_NAME)], cwd=str(target), close_fds=True)
            root.destroy()
        except Exception as e:                                          # noqa: BLE001
            log(f"✗ 出错：{type(e).__name__}: {e}")
            messagebox.showerror("安装失败", f"{type(e).__name__}: {e}")
            btn.configure(state="normal")

    # 回车也能装：万一在小屏机器上按钮还是被挡着，敲一下回车照样装
    root.bind("<Return>", lambda _e: btn.invoke())
    if silent:
        root.after(100, do_it)
    root.mainloop()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--dir", default="")
    ap.add_argument("--silent", action="store_true")
    ap.add_argument("--no-launch", action="store_true")
    ap.add_argument("--no-shortcut", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--info", action="store_true", help="只打印安装包信息（版本/默认目录）")
    args, _ = ap.parse_known_args()

    payload = payload_dir()
    ver = version_of(payload)
    if args.info:
        print(json.dumps({"version": ver, "default_dir": default_dir()}, ensure_ascii=False))
        return 0

    def console_log(msg):
        print(msg)

    if args.uninstall:
        return do_uninstall(Path(args.dir or default_dir()), console_log)

    if args.silent:
        target = Path(args.dir or default_dir())
        console_log(f"静默安装 {APP_NAME} {ver} → {target}")
        logs_dir = install(target, payload, console_log, shortcut=not args.no_shortcut)
        data_root = ensure_data_dirs(console_log)
        write_uninstaller(target, console_log)
        write_registry(target, ver, console_log)
        notify_shell(console_log)
        if not args.no_shortcut:
            sm = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft/Windows/Start Menu/Programs"
            sm.mkdir(parents=True, exist_ok=True)
            make_shortcut(target / EXE_NAME, sm / f"{APP_NAME}.lnk", console_log)
        console_log(f"安装完成：日志 {logs_dir or (target / 'logs')} · 现场数据 {data_root}")
        return 0

    return gui(args.dir or default_dir(), payload, False, args.no_launch, not args.no_shortcut)


if __name__ == "__main__":
    sys.exit(main())
