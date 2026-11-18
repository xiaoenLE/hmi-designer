#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""paths.py — 路径与目录常量（数据目录 / 日志目录 / 各存档文件）

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

数据目录可以被 HMI_DATA_DIR 指到别处、日志目录是 HMI_LOG_DIR —— 现场部署换目录只看这一个文件。
⚠ 本文件在 core/ 下面：ROOT 要往上**三层**才是工程根（少一层前端就全 404、存档也找错地方）。
"""

from pathlib import Path
import os


# ⚠ 这个文件在 server/core/ 下面（原来在 server/ 里），所以要多上一层：
#   core/paths.py → core/ → server/ → 工程根。
#   搬家时这种「往上几层」最容易错：少一层 ROOT 就变成 server/ —— 前端全 404、存档也找错地方。
ROOT = Path(__file__).resolve().parent.parent.parent   # 前端根目录（工程根）

# 存档目录：默认 server/data；HMI_DATA_DIR 可指到别处（多套部署/自动化测试用独立数据）
DATA_DIR = Path(os.environ.get("HMI_DATA_DIR") or (ROOT / "server" / "data"))

DATA_DIR.mkdir(parents=True, exist_ok=True)

VARS_FILE = DATA_DIR / "vars.json"

PROJECT_FILE = DATA_DIR / "hmi_project.json"

AUTH_FILE = DATA_DIR / "auth.json"              # 管理员口令（PBKDF2 哈希，见 _hash_pw）

ALARMS_FILE = DATA_DIR / "alarm_history.json"   # 报警历史（运行记录，**跟工程分开存**）

RETAIN_FILE = DATA_DIR / "retain_vars.json"     # HMI 内部**掉电保持**变量的当前值（见 RetainStore）

SETTINGS_FILE = DATA_DIR / "settings.json"      # **这台机器**的设置（日志保留天数 / 脚本日志每天上限）


# ─────────────────────────────────────────────────────────
# 日志：按天落盘 —— print / stderr / 未捕获异常都写进 logs/hmi-YYYY-MM-DD.log。
# 用 pythonw（pyw，无控制台窗口）跑时 sys.stdout 是 None，照样能写日志；
# 用 python（有控制台）跑时控制台照常显示，同时日志落盘。跨天自动换新文件。
# ⚠ 打包成 exe 之后程序目录在 Program Files 下（写不进去），所以壳会设 HMI_LOG_DIR
#   把日志指到 %ProgramData%\WebHMI-Designer\logs；源码方式跑还是程序目录下的 logs/。
#
# **只留最近几天，自动清理**（默认 3 天）：日志是排查问题用的，
#   现场机器磁盘不大，一直堆着没意义（演示工程那段脚本每秒十来行 [var]，一天就 1~2MB，
#   挂半年就是几百 MB）。启动时清一次、跨天换文件时再清一次 —— 删的都是文件名里带日期、
#   且日期超过保留窗口的 `hmi-*.log` / `update-*.log` / `script-*.log`；别的文件一个都不碰。
# ⚠ 保留天数**可以在软件里改**（工程 ▾ → 日志设置…，存在 server/data/settings.json）：
#   取值顺序 = 界面里设的 > 环境变量 HMI_LOG_KEEP_DAYS > 默认 3，见 log_keep_days()。
# ─────────────────────────────────────────────────────────
LOG_DIR = Path(os.environ.get("HMI_LOG_DIR") or (ROOT / "logs"))


FLUSH_INTERVAL = 2.0    # 变量落盘的合并窗口（秒）

# 页面分工（**不拆地址**，一个地址按登录状态给不同页面）：
#   · 没登录 / 没装闸门 → **运行页**（默认就是运行状态，客户打开地址就是画面）
#   · 登录过（管理员）  → 同一个地址给**编辑器**
#   · /run 永远给运行页（编辑器里「去运行画面」、管理员想再看运行画面时用）
RUN_PATH = "/"            # 运行页（默认地址）

RUN_ALWAYS = "/run"       # 强制运行页

EDITOR_PATH = "/"         # 编辑器也是这个地址（登录后才给）

SESSIONS_FILE = DATA_DIR / "sessions.json"   # 会话落盘：**重启后端也不掉登录**



# ─────────────────────────────────────────────
#  应用版本 / 「有新版本」提示
#  · 本地版本 = 仓库根的 version.json；远端版本 = **同一份文件**（Gitea 的 raw 链接）。
#    一处改、两头读 —— 发版只改 version.json 里的 version/date/notes，提交推上去就行。
#  · 为什么不用 git 判断：现场机（HMI 一体机）不一定装 git，也不一定有外网；
#    而 raw 链接只要浏览器能打开就行，后端用标准库 http.client 拉，零依赖。
#  · ⚠ 车间/客户机常常**根本连不上外网**：查不到就**静默** —— 只把失败原因放进结果里，
#    绝不报错、不卡界面、不在运行页弹任何东西（运行页压根不初始化这套，见 main.js）。
#  · ⚠ 只提示，**不自动下载、不自动覆盖**：现场机器上可能正在跑画面、工程还在改，
#    自动更新（尤其 git pull）会把 server/data 里现场的数据一起冲掉。
# ─────────────────────────────────────────────
VERSION_FILE = ROOT / "version.json"


PLCFG_FILE = DATA_DIR / "plc.json"          # PLC 连接配置（重启后还记得）
