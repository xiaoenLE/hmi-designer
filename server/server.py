#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WebHMI_设计器 — Python 后端**入口**（零第三方依赖，标准库实现）

一条命令启动：
    python server.py              # 默认 http://127.0.0.1:8866，自动开浏览器
    python server.py --port 9000  # 自定义端口
    python server.py --no-browser # 不自动开浏览器

⚠ **这个文件只做三件事**：解析命令行、把后端拉起来、把 core/ 里的名字再导出出去。
真正的实现全在 **server/core/** 下面 —— 模块索引（"某个功能在哪个文件"）见
`server/core/__init__.py`，照那张表找文件即可，不用在本文件里翻。

后端职责（实现分散在 core/ 各模块）：
  1. 静态托管前端（上级目录的 index.html / css / js）         → core/handler.py
  2. **所有接口的唯一实现**（长连接 `{t:'call'}` 落到这里）      → core/api.py
  3. 实时推送 **只走长连接**（/api/ws；SSE 在 2.0 已删除）        → core/broadcast.py、core/wsbridge.py
                                                             （帧协议本身在 server/wschannel.py）
  4. 变量读写（内部变量 / 采集范围 / 掉电保持）                 → core/varapi.py
  5. 报警历史存档（长连接上的 /api/alarms）                     → core/alarmstore.py
  6. 数据源（内存模拟 / Modbus PLC / OPC UA）                   → core/sourcebase.py、
     core/datasource.py、core/plcsource.py

与前端协议对齐：js/api/backend.js
"""

import sys
from pathlib import Path

# ⚠ 先把自己所在目录放进 sys.path 再 import core：直接跑本文件时（python server/server.py）
#   sys.path[0] 本来就是 server/，但换个入口（比如 `python -c "import server"`）未必 ——
#   补这一下，免得出现「换个启动方式就 ImportError: core」这种莫名其妙的问题。
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse
import atexit
import os
import threading
import webbrowser

import poll_gate                  # 同目录：有没有人在看运行画面（没人看就不跟设备通讯）

# 实现都在 core/ 下面。这里 import 模块名，是为了下面的兼容再导出、以及属性访问
# （`hmi.auth.AUTH_ENABLED = …` / `datasource.get_source()` 这种，见 core/__init__.py 铁律①）
from core import (
    alarmstore, api, applog, auth, broadcast, datasource, handler, hostutil, loginpage, opcualib,
    paths, plcsource, retain, scriptlog, settings, sourcebase, updateapply, varapi, versioninfo, wsbridge
)


# 报警历史存档（5MB 环形）
from core.alarmstore import (
    ALARM_CAP_BYTES, ALARM_DUP_WINDOW_MS, _alarm_add, _alarm_lock, _alarm_patch, _alarm_rec_bytes,
    _alarms_load, _alarms_save
)

# 运行日志：按天轮转、自动清理、控制台同时落盘
from core.applog import (
    _ConsoleWriter, _Tee, _install_daily_log, _log_ensure, _log_line, _log_prune
)

# 管理员口令、会话、登录限流（AUTH_ENABLED 的家）
from core.auth import (
    DEFAULT_PASSWORD, LOGIN_LOCK_SEC, LOGIN_MAX_FAILS, SESSION_COOKIE, SESSION_TTL, _LOGIN_FAILS,
    _SESS_LOCK, _hash_pw, _new_salt, _save_sessions, _tok_key, check_password, drop_session,
    load_auth, load_sessions, login_blocked, new_session, note_login_fail, session_ok, write_auth
)

# 广播扇出（V2 起只有长连接一条通道）
from core.broadcast import _ws_clients, _ws_lock, broadcast

# 数据源基类 / 内存模拟 / **当前数据源** / 连接管理 / 设备状态
from core.datasource import (
    ERR_SEEN_CAP, MemorySource, _autoconnect_saved_plc, _err_seen, _extra_internal, _source_lock,
    _source_status, _source_status_raw, plc_connect, plc_disconnect
)

# HTTP 处理器（静态文件 + 三个页面 + WebSocket 升级口）
from core.handler import HMIServer, QuietThreadingHTTPServer

# FRP 内网穿透（内置 frpc 客户端：手机在外面看画面）
from core import frp

# host 判定 / 端口占用探测
from core.hostutil import _is_local_host, _our_service_running, _port_in_use, _split_host

# 登录页 HTML
from core.loginpage import LOGIN_PAGE, login_page_html

# 画面工程存档（服务器上那一份）的读写：**一处收口** —— 后缀是 .LE，老 hmi_project.json 也认
from core.projectfile import project_file_in_use, read_project_file, write_project_file  # noqa: F401

# 路径与目录常量（数据目录/日志目录/各存档文件）
from core.paths import (
    ALARMS_FILE, AUTH_FILE, DATA_DIR, EDITOR_PATH, FLUSH_INTERVAL, LOG_DIR, PLCFG_FILE,
    PROJECT_FILE, RETAIN_FILE, ROOT, RUN_ALWAYS, RUN_PATH, SESSIONS_FILE, SETTINGS_FILE, VARS_FILE,
    VERSION_FILE
)

# PlcSource（Modbus/OPC UA 轮询与读写）+ PLC 配置
from core.plcsource import (
    OpcUaSource, PlcSource, _REMOTE_SRC, _emit_changed, _load_plc_cfg, _on_plc_change,
    _on_plc_changes, _plc_cfg, _protocol_of, _save_plc_cfg
)

# 掉电保持变量的落盘
from core.retain import RetainStore, _retain

# 脚本日志（hmi.log 落盘那份）
from core.scriptlog import (
    SCRIPTLOG_MAX_BODY, SCRIPTLOG_MAX_CHARS, SCRIPTLOG_MAX_LINES, _SLOG_FIELD_MAP, _SLOG_LINE_RE,
    _slog_ensure, _slog_field, _slog_text, scriptlog_read, scriptlog_write
)

# 这台机器的设置（日志保留天数 / 脚本日志上限）
from core.settings import (
    SCRIPTLOG_MAX_MB_DEFAULT, SCRIPTLOG_MAX_MB_HARD, _LOG_KEEP_DEFAULT, _LOG_KEEP_ENV,
    _LOG_KEEP_MAX, _LOG_KEEP_MIN, _LOG_NAME_RE, _SCRIPTLOG_MAX_MB_ENV, _SETTINGS_LOCK, _clamp_float,
    _clamp_int, _settings_load, _settings_save, log_keep_days, log_usage, scriptlog_max_mb
)

# 
from core.sourcebase import DataSource

# 「立即更新」：下载代码包 → 覆盖代码 → 自己重启
from core.updateapply import (
    UPDATE_ARCHIVE_URL, _DEFAULT_UPDATE_ARCHIVE, _exit_for_update, _restart_helper_cmd,
    _spawn_restart_helper, _update_apply_lock, _update_launcher, apply_update, write_up_report
)

# 变量读写的唯一实现（HTTP 与长连接共用）
from core.varapi import _note_write_error, read_all_vars, var_declare, var_write

# 构建标识 + 版本清单 + 检查更新
from core.versioninfo import (
    LAUNCHER_VERSION, SERVER_BUILD, SERVER_FEATURES, UPDATE_FORCE_GAP_SEC, UPDATE_HTTP_TIMEOUT,
    UPDATE_MANIFEST_URL, UPDATE_MIN_GAP_SEC, UPDATE_TTL_SEC, _DEFAULT_UPDATE_URL, _http_get_json,
    _local_version, _update_lock, _version_key, _version_result, check_update
)

# WebSocket 服务端胶水（协议在 server/wschannel.py）
from core.wsbridge import (
    WS_STATUS_MS, _plc_cfg_for, _ws_alive, _ws_beat_ensure, _ws_beat_lock, _ws_beat_loop,
    _ws_dispatch, _ws_hello, _ws_on_close, _ws_on_message, _ws_serve
)


def main():

    ap = argparse.ArgumentParser(description="WebHMI_设计器后端")
    ap.add_argument("--port", type=int, default=8866)
    # 默认只绑本机：这台后端能直接读写 PLC 变量，不该默认对整个局域网敞开
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（局域网访问用 0.0.0.0）")
    ap.add_argument("--allow-any-origin", action="store_true",
                    help="关闭来源校验（默认拒绝外部网页的写请求）")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-auth", action="store_true",
                    help="关掉登录闸门（本机开发/自动化测试用）；开着时：没登录看到运行页，登录后看到编辑器")
    ap.add_argument("--set-password", metavar="新密码",
                    help="设置/修改管理员密码后退出（不改密码就删掉 server/data/auth.json 重来）")
    ap.add_argument("--poll-always", action="store_true",
                    help="不管有没有人打开运行页面都一直跟设备通讯（默认：没人看运行画面就不通讯）")
    args = ap.parse_args()
    handler.ALLOW_ANY_ORIGIN = args.allow_any_origin
    # 没人看运行画面就不跟设备通讯（见 poll_gate.py）。自动化测试/现场调试可以强制一直采：
    #   --poll-always，或环境变量 HMI_POLL_ALWAYS=1
    if args.poll_always or os.environ.get("HMI_POLL_ALWAYS") in ("1", "true", "yes"):
        poll_gate.set_always(True)
        print("[poll] 强制一直采集（--poll-always）：不等前端登记就轮询设备")

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if args.set_password is not None:
        pw = args.set_password.strip()
        if len(pw) < 4:
            print("[auth] 密码太短（至少 4 位）")
            sys.exit(2)
        write_auth(pw)
        print("=" * 52)
        print("  管理员密码已更新")
        print(f"  口令文件 : {AUTH_FILE}")
        print(f"  登录地址 : http://127.0.0.1:{args.port}/login")
        print(f"  现场地址 : http://127.0.0.1:{args.port}/run   （不用登录）")
        print("=" * 52)
        return


    auth.AUTH_ENABLED = not args.no_auth
    if auth.AUTH_ENABLED:
        load_auth()          # 没有口令文件就按默认密码建一份并提醒
        load_sessions()      # 上次登录（12 小时内）接着用，重启不用重新输密码

    url = f"http://127.0.0.1:{args.port}"

    # 端口预检：已在运行就直接用，别起第二个实例（Windows 上 bind 不一定报错）
    if _port_in_use(args.host, args.port):
        if _our_service_running(args.port):
            print("=" * 52)
            print(f"  服务已经在运行：{url}")
            if args.no_browser:
                print("  （--no-browser：未自动打开浏览器）")
            else:
                print("  正在打开浏览器 ...")
                webbrowser.open(url)
            print("=" * 52)
            return
        print("=" * 52)
        print(f"  [启动失败] 端口 {args.port} 已被其它程序占用")
        print(f"  · 换端口   : start_server.bat --port 9000")
        print(f"  · 看占用   : netstat -ano | findstr :{args.port}")
        print("=" * 52)
        sys.exit(2)

    try:
        srv = QuietThreadingHTTPServer((args.host, args.port), HMIServer)
    except OSError as e:
        # 兜底：预检没探到但绑定仍失败
        print("=" * 52)
        print(f"  [启动失败] 无法监听 {args.host}:{args.port} —— {e.strerror or e}")
        print(f"  · 直接用   : {url}")
        print(f"  · 重启服务 : 先运行 stop_server.bat {args.port} 再启动")
        print("  · 换端口   : start_server.bat --port 9000")
        print("=" * 52)
        sys.exit(2)

    _v = _local_version()
    # 报到：把「实际绑在哪个端口」写进数据目录（更新助手靠它确认新版起没起来，
    # 免得"换了端口"被误判成"没起来"→ 自动回滚）
    write_up_report(args.host, args.port)
    print("=" * 52)
    print(f"  WebHMI_设计器 · 后端服务已启动   版本 V{_v['version']}（{_v['date']} · build {SERVER_BUILD}）")
    print(f"  运行/编辑: {url}/        ← **就这一个地址**：客户打开就是运行画面（不用登录）")
    if auth.AUTH_ENABLED:
        print(f"             登录后同一个地址给组态编辑器（改画面/变量/PLC 连接）")
        print(f"  登录     : {url}/login  （改密码：set_password.bat 新密码）")
    else:
        print("  登录闸门 : 已关（--no-auth）→ / 直接就是编辑器")
    print(f"  强制运行 : {url}/run     ← 登录状态下也想看运行画面时用")
    print(f"  监听     : {args.host}:{args.port}")
    print(f"  前端     : {ROOT}")
    print(f"  数据源   : {type(datasource.get_source()).__name__}（可替换为 Modbus/PLC）")
    print(f"  变量存   : {VARS_FILE}")
    print(f"  工程存   : {project_file_in_use()}")
    print(f"  报警记录 : {ALARMS_FILE}")
    if not _is_local_host(args.host) and args.host != "127.0.0.1":
        print("  ⚠ 已监听非本机地址：局域网内任何机器都能访问，请确认现场网络可信")
    print("=" * 52)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url + RUN_PATH)).start()
    _autoconnect_saved_plc()      # 上次配好的设备：开机就自动连上（现场打开 /run 就有数据）
    # FRP 内网穿透：上次开着就接着开（现场机器重启不用人再点一下）；关软件时把 frpc 一起收掉
    try:
        frp.ensure(args.port)
        atexit.register(frp.stop)
    except Exception as e:                                          # noqa: BLE001
        print(f"[frp] 启动检查失败（不影响其它功能）：{type(e).__name__}: {e}")
    # 版本检查预热：开机就在后台查一次（现场机连不上更新服务器时，这 4 秒超时也发生在后台线程里，
    # 不占启动时间）。这样前端打开页面时 /api/update/check 直接给缓存结果 —— 不用等一个来回
    threading.Thread(target=check_update, kwargs={"force": True},
                     name="update-check", daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            frp.stop()                    # 关服务 = 把内网穿透也收掉（别留个孤儿 frpc 在那儿）
        except Exception:                                          # noqa: BLE001
            pass
        datasource.get_source().flush()   # 退出前把合并窗口里没落盘的变量写下去
        print("\n再见。")


if __name__ == "__main__":
    main()
