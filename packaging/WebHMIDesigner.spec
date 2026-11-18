# -*- mode: python ; coding: utf-8 -*-
"""
WebHMIDesigner.spec — 把 packaging/launcher.py 打成"壳"（PyInstaller onedir）

为什么是 onedir 而不是 onefile：
  · onefile 每次启动都要把整个运行时解压到临时目录，慢（几秒），而且解压出来的路径每次不同；
  · onedir 的目录结构就是"安装目录"的样子：exe + _internal（运行时）+ 我们另外放进去的 app（业务代码），
    更新只需要换 app 里那几个文件 —— 这正是"运行中的 exe 不能覆盖自己"的解法。

⚠ **业务代码绝对不能打进 exe**：一旦 server/*.py 被编译进 exe，就地更新就失效了
  （得重新打包 + 重装）。launcher.py 是用「动态加载磁盘上的 app\\server\\hmi_desktop.py」
  的方式跑的，PyInstaller 静态分析看不见它；这里再用 excludes 兜一道。
"""
import os
from pathlib import Path

# ⚠ 一律用 SPECPATH（spec 文件所在目录）拼路径：PyInstaller 里相对路径是相对"调用它的工作目录"，
#   换个目录调用就找不到入口脚本了（踩过一次）
HERE = Path(SPECPATH)
# 版本信息（属性里看得到，现场报问题时对得上）——由 tools/build-release.ps1 生成后传进来
_ver_file = Path(os.environ.get("HMI_VERSION_FILE") or (HERE / "version_info.txt"))

a = Analysis(
    [str(HERE / "launcher.py")],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        # 运行时才 import 的东西，静态分析看不到，必须显式列出来
        "webview", "webview.platforms.winforms", "webview.platforms.edgechromium",
        "clr_loader", "pythonnet",
        "asyncua", "asyncua.sync", "asyncua.client", "asyncua.common.xmlimporter",
        "PIL", "PIL.Image",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 业务代码：绝不能进 exe（见文件开头说明）
        "server", "hmi_desktop", "updater", "modbus", "opcua", "opcua_sim", "plc_sim", "addr_model",
        # 用不上的大件，别塞进来（安装包体积）
        "tkinter", "unittest", "pydoc_data", "test", "distutils",
        "matplotlib", "numpy", "scipy", "pandas", "PyQt5", "PySide2", "PySide6",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="WebHMIDesigner",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                       # upx 压缩过的 exe 常被杀软误报，现场机器不值得冒这个险
    console=False,                   # 现场客户端不该弹黑框（日志走 %ProgramData%\\WebHMI-Designer\\logs）
    disable_windowed_traceback=False,
    version=str(_ver_file) if _ver_file.exists() else None,
    icon=str(HERE / 'hmi.ico'),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="WebHMIDesigner",
)
