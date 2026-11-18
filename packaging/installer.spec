# -*- mode: python ; coding: utf-8 -*-
"""
installer.spec — 把 packaging/installer.py 打成**安装包**（WebHMI-Designer-Setup-<版本>.exe）

· onefile：安装器就该是"一个文件"，双击就跑
· uac_admin=True：安装要写 Program Files 和 HKLM（卸载登记），必须提权；
  ⚠ 注意**只有安装器提权** —— 程序自己（WebHMIDesigner.exe）不提权，也**不需要**提权，
  所以日常更新（只换 app\\ 里的文本文件）不会弹 UAC。这是这套设计的重点之一。
· payload 打进 exe：payload\\WebHMIDesigner\\（壳）+ payload\\app\\（业务代码）
  ⚠ payload 里**绝不能有** server/data 或任何现场数据 —— 由 tools/build-release.ps1 保证。
"""
import os
from pathlib import Path

HERE = Path(SPECPATH)
STAGE = Path(os.environ.get("HMI_STAGE") or (HERE.parent / "build" / "stage"))
PAYLOAD = STAGE / "payload"
_ver_file = Path(os.environ.get("HMI_VERSION_FILE") or (HERE / "version_info.txt"))

if not (PAYLOAD / "WebHMIDesigner" / "WebHMIDesigner.exe").exists():
    raise SystemExit(f"payload 不完整：{PAYLOAD}\\WebHMIDesigner\\WebHMIDesigner.exe 不存在"
                     "（先跑 tools/build-release.ps1 打壳和 app）")

a = Analysis(
    [str(HERE / "installer.py")],
    pathex=[],
    binaries=[],
    datas=[(str(PAYLOAD), "payload")],
    hiddenimports=["tkinter", "tkinter.filedialog", "tkinter.messagebox", "tkinter.ttk"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["numpy", "matplotlib", "PIL", "webview", "asyncua", "pythonnet", "clr_loader"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="WebHMI-Designer-Setup",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,                 # 安装器是 GUI；静默安装那种场景用 --silent 也不会看到窗口
    disable_windowed_traceback=False,
    version=str(_ver_file) if _ver_file.exists() else None,
    icon=str(HERE / 'hmi.ico'),
    uac_admin=True,                # ★ 安装需要管理员；程序本身不需要
)
