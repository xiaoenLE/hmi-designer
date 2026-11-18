#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HMI 组态设计器 — Python 后端（零第三方依赖，标准库实现）
=========================================================
一条命令启动：
    python server.py              # 默认 http://127.0.0.1:8866，自动开浏览器
    python server.py --port 9000  # 自定义端口
    python server.py --no-browser # 不自动开浏览器

职责：
  1. 静态托管前端（上级目录的 index.html / css / js）
  2. REST 变量读写：GET/POST /api/vars（前端按钮/输入控件的动作会下发到这里）
  3. SSE 实时推送：GET /api/events（变量一旦被写入，所有在线前端立即刷新）
  4. 工程存档：GET/POST /api/project（前端「存到服务器/读服务器」）
  5. 报警历史存档：GET/POST /api/alarms（存 server/data/alarm_history.json ——
     浏览器 profile 每次都是新的（PyWebView）、换地址换浏览器也都是各自一份，
     报警记录只有存在服务器上才不会"消失"）
  6. DataSource 抽象 —— 当前为内存模拟；接入真实 PLC 时只需实现一个子类
     （见文件底部 ModbusSource 预留模板），前端零改动。

与前端协议对齐：js/api/backend.js
"""
import argparse
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import modbus                     # 同目录：Modbus TCP 主站 + %MW/%MD 地址解析
import updater                    # 同目录：自己更新（下载代码包 / 只覆盖代码 / 备份 / 回滚）
try:
    import opcua                   # 同目录：OPC UA 客户端（可选依赖 asyncua，见 opcua.py）
except Exception as _e:            # noqa: BLE001  —— 缺包也不能让整个后端起不来
    opcua = None
    print(f"[warn] OPC UA 模块加载失败：{_e}")

ROOT = Path(__file__).resolve().parent.parent   # 前端根目录
# 存档目录：默认 server/data；HMI_DATA_DIR 可指到别处（多套部署/自动化测试用独立数据）
DATA_DIR = Path(os.environ.get("HMI_DATA_DIR") or (ROOT / "server" / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
VARS_FILE = DATA_DIR / "vars.json"
PROJECT_FILE = DATA_DIR / "hmi_project.json"
AUTH_FILE = DATA_DIR / "auth.json"              # 管理员口令（PBKDF2 哈希，见 _hash_pw）
ALARMS_FILE = DATA_DIR / "alarm_history.json"   # 报警历史（运行记录，**跟工程分开存**）
RETAIN_FILE = DATA_DIR / "retain_vars.json"     # HMI 内部**掉电保持**变量的当前值（见 RetainStore）

# ─────────────────────────────────────────────────────────
# 日志：按天落盘 —— print / stderr / 未捕获异常都写进 logs/hmi-YYYY-MM-DD.log。
# 用 pythonw（pyw，无控制台窗口）跑时 sys.stdout 是 None，照样能写日志；
# 用 python（有控制台）跑时控制台照常显示，同时日志落盘。跨天自动换新文件。
# ⚠ 打包成 exe 之后程序目录在 Program Files 下（写不进去），所以壳会设 HMI_LOG_DIR
#   把日志指到 %ProgramData%\HMI-Designer\logs；源码方式跑还是程序目录下的 logs/。
# ─────────────────────────────────────────────────────────
LOG_DIR = Path(os.environ.get("HMI_LOG_DIR") or (ROOT / "logs"))
_LOG_FILE = None
_LOG_DAY = ""


def _log_ensure():
    """返回「今天」的日志文件句柄；日期变了就换新文件"""
    global _LOG_FILE, _LOG_DAY
    day = time.strftime("%Y-%m-%d")
    if _LOG_FILE is not None and day == _LOG_DAY:
        return _LOG_FILE
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if _LOG_FILE is not None:
            _LOG_FILE.close()
        _LOG_FILE = open(LOG_DIR / f"hmi-{day}.log", "a", encoding="utf-8")
        _LOG_DAY = day
    except Exception:                                           # noqa: BLE001
        _LOG_FILE = None
    return _LOG_FILE


def _log_line(text):
    f = _log_ensure()
    if f is not None:
        try:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}\n")
            f.flush()
        except Exception:                                       # noqa: BLE001
            pass


class _Tee:
    """把 stdout/stderr 同时写进控制台（若有）和当天日志文件"""
    def __init__(self, console):
        self.console = console
        self.pending = ""

    def reconfigure(self, *a, **kw):
        # 兼容 main() 里的 sys.stdout.reconfigure(encoding="utf-8")：转给真正的控制台
        if self.console is not None:
            try:
                return self.console.reconfigure(*a, **kw)
            except Exception:                                   # noqa: BLE001
                pass
        return self

    def write(self, s):
        if self.console is not None:
            try:
                self.console.write(s)
            except Exception:                                   # noqa: BLE001
                pass
        self.pending += s
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            if line.strip():
                _log_line(line)

    def flush(self):
        if self.pending.strip():
            _log_line(self.pending.rstrip("\n"))
            self.pending = ""
        if self.console is not None:
            try:
                self.console.flush()
            except Exception:                                   # noqa: BLE001
                pass
        f = _log_ensure()
        if f is not None:
            try:
                f.flush()
            except Exception:                                   # noqa: BLE001
                pass


def _install_daily_log():
    console_out, console_err = sys.stdout, sys.stderr
    sys.stdout = _Tee(console_out)
    sys.stderr = _Tee(console_err)

    def _hook(t, v, tb):
        import traceback
        msg = "".join(traceback.format_exception(t, v, tb)).rstrip()
        for line in msg.splitlines():
            _log_line(line)
        if console_err is not None:
            try:
                console_err.write(msg + "\n")
            except Exception:                                   # noqa: BLE001
                pass
    sys.excepthook = _hook


_install_daily_log()

FLUSH_INTERVAL = 2.0    # 变量落盘的合并窗口（秒）
ALLOW_ANY_ORIGIN = False  # --allow-any-origin 打开后跳过来源校验（默认关）
# 页面分工（**不拆地址**，一个地址按登录状态给不同页面）：
#   · 没登录 / 没装闸门 → **运行页**（默认就是运行状态，客户打开地址就是画面）
#   · 登录过（管理员）  → 同一个地址给**编辑器**
#   · /run 永远给运行页（编辑器里「去运行画面」、管理员想再看运行画面时用）
RUN_PATH = "/"            # 运行页（默认地址）
RUN_ALWAYS = "/run"       # 强制运行页
EDITOR_PATH = "/"         # 编辑器也是这个地址（登录后才给）
# 登录闸门：默认开 —— 「/run 给现场随便看，改东西（编辑器、PLC 配置、工程存档）要管理员登录」。
# --no-auth 关掉（本机开发/自动化测试用）。
AUTH_ENABLED = True
DEFAULT_PASSWORD = "admin123"    # 首次启动自动创建，控制台会提醒改
SESSION_TTL = 12 * 3600          # 登录有效期（12 小时，够上一个班）
SESSION_COOKIE = "hmi_sess"
SESSIONS_FILE = DATA_DIR / "sessions.json"   # 会话落盘：**重启后端也不掉登录**
_SESSIONS = {}                   # {token 的 sha256: 过期时间戳}
_SESS_LOCK = threading.Lock()
_LOGIN_FAILS = {}                # {ip: [失败次数, 最近一次时间]} —— 简单挡一下暴力猜密码
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_SEC = 20


def _hash_pw(password: str, salt: str) -> str:
    """口令哈希（PBKDF2-HMAC-SHA256）—— auth.json 里绝不存明文"""
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 120_000).hex()


def _new_salt() -> str:
    return secrets.token_hex(16)


def load_auth() -> dict:
    """读管理员口令；没有就按默认密码建一份（并在控制台提醒改）"""
    if AUTH_FILE.exists():
        try:
            d = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
            if d.get("salt") and d.get("hash"):
                return d
        except Exception as e:                                  # noqa: BLE001
            print(f"[warn] 登录口令文件读不了（{e}），按默认密码重建：{AUTH_FILE}")
    d = write_auth(DEFAULT_PASSWORD, quiet=True)
    print(f"[auth] 已创建管理员口令文件：{AUTH_FILE}")
    print(f"[auth] 默认密码 {DEFAULT_PASSWORD} —— 建议改一个：双击 set_password.bat 你的新密码")
    return d


def write_auth(password: str, quiet: bool = False) -> dict:
    salt = _new_salt()
    d = {"salt": salt, "hash": _hash_pw(password, salt),
         "updated": time.strftime("%Y-%m-%d %H:%M:%S")}
    AUTH_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    if not quiet:
        print(f"[auth] 管理员密码已更新（{AUTH_FILE}）")
    return d


def check_password(password: str) -> bool:
    d = load_auth()
    try:
        return hmac.compare_digest(_hash_pw(password or "", d["salt"]), d["hash"])
    except Exception:                                           # noqa: BLE001
        return False


def _tok_key(token: str) -> str:
    """会话文件里只存 token 的 sha256 —— 文件被看到也没法直接拿去冒充登录"""
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _save_sessions():
    try:
        tmp = SESSIONS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_SESSIONS), encoding="utf-8")
        tmp.replace(SESSIONS_FILE)          # 原子写：别把文件写坏
    except Exception as e:                                      # noqa: BLE001
        print(f"[warn] 会话落盘失败（不影响当前登录）：{e}")


def load_sessions():
    """启动时把没过期的会话读回来 —— 否则「关掉窗口/重启后端就要重新登录」，
    现场（尤其 pywebview 窗口客户端，每次启动都是新进程）最烦这个。"""
    global _SESSIONS
    try:
        if SESSIONS_FILE.exists():
            d = json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
            now = time.time()
            _SESSIONS = {k: float(v) for k, v in d.items() if float(v) > now}
    except Exception:                                           # noqa: BLE001
        _SESSIONS = {}


def new_session() -> str:
    tok = secrets.token_urlsafe(24)
    with _SESS_LOCK:
        now = time.time()
        for k, exp in list(_SESSIONS.items()):      # 顺手清掉过期的，别让文件一直涨
            if exp < now:
                _SESSIONS.pop(k, None)
        _SESSIONS[_tok_key(tok)] = now + SESSION_TTL
        _save_sessions()
    return tok


def drop_session(tok: str):
    with _SESS_LOCK:
        if _SESSIONS.pop(_tok_key(tok), None) is not None:
            _save_sessions()


def session_ok(tok: str) -> bool:
    if not tok:
        return False
    key = _tok_key(tok)
    with _SESS_LOCK:
        exp = _SESSIONS.get(key)
    if not exp:
        return False
    if exp < time.time():
        drop_session(tok)
        return False
    return True


def login_blocked(ip: str):
    """返回还要等多少秒（0 = 可以试）。连错 5 次锁 20 秒，够挡脚本猜密码了。"""
    rec = _LOGIN_FAILS.get(ip)
    if not rec:
        return 0
    n, t = rec
    if n < LOGIN_MAX_FAILS:
        return 0
    left = LOGIN_LOCK_SEC - (time.time() - t)
    if left <= 0:
        _LOGIN_FAILS.pop(ip, None)
        return 0
    return int(left) + 1


def note_login_fail(ip: str):
    n, _ = _LOGIN_FAILS.get(ip, (0, 0))
    _LOGIN_FAILS[ip] = (n + 1, time.time())


def _split_host(h: str) -> str:
    """从 Host / Origin 里取主机名（兼容 127.0.0.1:8866 与 [::1]:8866）"""
    h = (h or "").strip()
    if h.startswith("["):
        return h[1:h.find("]")] if "]" in h else h
    return h.rsplit(":", 1)[0] if ":" in h else h


def _is_local_host(host: str) -> bool:
    host = (host or "").lower()
    if host in ("localhost", "::1", "127.0.0.1"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _port_in_use(host: str, port: int) -> bool:
    """探测端口是否已有服务在监听。
    不能只靠 bind 失败来判断：Windows 上 SO_REUSEADDR 允许两个进程绑同一端口，
    重复双击启动会悄悄跑起第二个实例。"""
    probe = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.4)
            return s.connect_ex((probe, port)) == 0
    except OSError:
        return False


def _our_service_running(port: int) -> bool:
    """端口上那个服务是不是我们自己（读 /api/health 认名字）"""
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=0.6)
        c.request("GET", "/api/health")
        j = json.loads(c.getresponse().read().decode("utf-8"))
        return bool(j.get("ok")) and j.get("name") == "hmi-server"
    except Exception:
        return False

# 后端「能力表」：前端据此判断跑的是不是配套版本。
# 改了 modbus/server 的对外行为就把 feature 加进来，这样「忘了重启后端」会当场提示，
# 而不是让人对着旧行为查半天（旧后端会把新参数当默认值静默用掉）。
SERVER_BUILD = "2026-10-06"
SERVER_FEATURES = [
    "plc",              # Modbus TCP 数据源
    "word_order4",      # 双字/浮点 4 种字序（abcd/cdab/badc/dcba）
    "words_by_type",    # 字长按类型算（real/dint=2、lreal=4）
    "string_range",     # 字符串按长度占多个寄存器（%MW200[10] / 变量表长度列）
    "orders_probe",     # 只读的 4 种字序体检
    "fc16_fallback",    # 从站不支持 FC16 时退回逐个 FC06 写
    "write_status",     # 写失败在界面上可见
    "page_scope",       # 按页采集：只轮询当前页面用到的变量（+报警条件）
    "block_read",       # 连续地址合并成一次读（块数在状态里可见）
    "vars_reset",       # 内部变量（内存模拟）一键恢复变量表初值
    "protocol",         # 连接对话框里带「协议」字段（modbus / opcua）
    "opcua",            # OPC UA 数据源（NodeId 寻址，批量读）
    "opcua_browse",     # 浏览 OPC UA 节点树（导入变量用）
    "opcua_xml",        # 解析 CODESYS/Invtmatic 导出的符号配置 XML（离线导入地址）
    "opcua_endpoints",  # 端点诊断（不建会话，问出服务器身份/安全策略/身份方式）
    "alarm_store",      # 报警历史存服务器（/api/alarms）：换地址/换浏览器/新开窗口都还在
    "update_check",     # 版本清单 + 更新检查（/api/update/check，/api/health 里带 version）
    "update_apply",     # 点一下自己更新（/api/update/apply：下载代码包→只覆盖代码→自动重启）
]


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
_DEFAULT_UPDATE_URL = "http://124.221.183.24:3000/xiaoen/hmi-designer-release/raw/branch/master/version.json"
# 换更新源：设环境变量 HMI_UPDATE_URL；**显式设成空串 = 关掉更新检查**（客户机不许外联的场合）
# 发布仓库（hmi-designer-release）里放的是"装出来的东西"：version.json（清单，带 app_zip 与 sha256）、
# HMI-Designer-<版本>-app.zip（日常更新用的代码包）、HMIDesigner-Setup-<版本>.exe（完整安装包）。
# 源码仓库（hmi-designer）继续只放源码 —— 两边不混。
UPDATE_MANIFEST_URL = (os.environ["HMI_UPDATE_URL"].strip() if "HMI_UPDATE_URL" in os.environ
                       else _DEFAULT_UPDATE_URL)
# 壳（exe）版本：由 packaging/launcher.py 通过环境变量告诉后端。清单里的 min_launcher 比它高 →
# 说明"这次更新需要新版壳（装了新运行时的安装包）"，就**不许就地更新**，改成提示装安装包。
LAUNCHER_VERSION = (os.environ.get("HMI_LAUNCHER_VERSION") or "").strip()
UPDATE_TTL_SEC = 6 * 3600        # 成功查到后 6 小时内不再问远端（别给更新服务器添乱）
UPDATE_MIN_GAP_SEC = 30          # **自动**检查之间的最小间隔（开机预热 / 页面后台查）
UPDATE_FORCE_GAP_SEC = 2.0       # **人主动**点「检查更新/立即更新」时的最小间隔：只为挡连点。
                                 # ⚠ 以前 force 也吃上面那个 30 秒 —— 于是刚重启完（预热才拉过）
                                 #   点「立即更新」会拿**旧缓存**回一句"已经是最新版本"，
                                 #   现场会一模一样地踩（明明提示有新版本，一点却说没有）
UPDATE_HTTP_TIMEOUT = 4.0        # 拉 version.json 的超时：网慢也不能把界面卡在那儿

_update_lock = threading.Lock()
_update_last_try = 0.0
_update_cache = None             # 上次的检查结果；断网时保留旧结果并标 stale，别让提示凭空消失


def _local_version():
    """本地版本（读仓库根 version.json）。文件丢了/写坏了也要能用 → 退回 build 日期"""
    info = {"app": "HMI 组态设计器", "version": "", "date": SERVER_BUILD, "notes": "", "url": ""}
    try:
        # utf-8-sig：记事本/Excel 存出来的 UTF-8 带 BOM，按 utf-8 读第一行会是个乱字符
        # （变量表 CSV 导入踩过同一个坑，见 README「导入自动认编码」）
        raw = json.loads(VERSION_FILE.read_text(encoding="utf-8-sig"))
        if isinstance(raw, dict):
            info.update({k: str(v) for k, v in raw.items() if k in info and isinstance(v, (str, int, float))})
    except FileNotFoundError:
        print(f"[update] 没有 {VERSION_FILE.name}：版本号先按 build 日期显示")
    except Exception as e:                                      # noqa: BLE001
        print(f"[update] {VERSION_FILE.name} 读不出来（{e}）：版本号先按 build 日期显示")
    if not info["version"]:
        info["version"] = SERVER_BUILD
    return info


def _version_key(text):
    """'1.0.2' → (1,0,2)。带后缀（1.0.2-beta）只比数字部分；一个数字都没有 → 空元组（不比大小）"""
    nums = re.findall(r"\d+", str(text or ""))
    return tuple(int(n) for n in nums[:4]) if nums else ()


def _http_get_json(url: str, timeout: float = UPDATE_HTTP_TIMEOUT):
    """直接取一个 JSON（GET）。用 http.client 而不是 urllib：
    urllib 认 http_proxy/https_proxy 环境变量，车间里的代理会把**内网地址也代理掉**，
    然后表现为「莫名其妙查不到版本」——直连最省心。"""
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError(f"更新地址不合法：{url}")
    port = u.port or (443 if u.scheme == "https" else 80)
    path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    conn = cls(u.hostname, port, timeout=timeout)
    try:
        conn.request("GET", path, headers={"Accept": "application/json",
                                           "User-Agent": "hmi-designer-update-check"})
        resp = conn.getresponse()
        raw = resp.read(64 * 1024)          # 只读前 64KB：这个文件必须很小，大文件说明地址配错了
        if resp.status != 200:
            raise ValueError(f"HTTP {resp.status}")
        # utf-8-sig：远端这份多半是在 Windows 上用记事本/编辑器存的，BOM 很常见 ——
        # 不认 BOM 的话现场表现就是「明明有 version.json 却说没查到」
        return json.loads(raw.decode("utf-8-sig"))
    finally:
        conn.close()


def _version_result(local, remote, err, source, checked_at, stale=False):
    """把「本地 / 远端 / 失败原因」拼成给前端的结果 —— 版本高低的判断只在这一处"""
    lv = str(local.get("version") or "")
    rv = str((remote or {}).get("version") or "")
    lk, rk = _version_key(lv), _version_key(rv)
    if not rv:
        state = "error"
    elif lk and rk and rk > lk:
        state = "newer"           # 远端更新 → 提示
    elif lk and rk and lk > rk:
        state = "local_newer"     # 本地比远端新（自己改了还没推 / 远端回滚过）→ 不提示，但要说清楚
    else:
        state = "same"
    return {"ok": state != "error", "state": state, "available": state == "newer",
            "local": local, "remote": remote, "error": err, "source": source,
            "checkedAt": checked_at, "stale": bool(stale), "ttl": UPDATE_TTL_SEC}


def check_update(force: bool = False):
    """检查有没有新版本。**任何异常都变成结果里的 error**，绝不往外抛 —— 界面不能被它搞崩。"""
    global _update_last_try, _update_cache
    # build 一起带上：/api/health 里有、这里也得有 —— 前端两个来源混着画状态栏，
    # 少一个字段就会出现「鼠标提示里有时有 build、有时没有」
    local = dict(_local_version(), build=SERVER_BUILD)
    if not UPDATE_MANIFEST_URL:
        r = _version_result(local, None, "", "", 0)
        r.update({"ok": True, "state": "disabled", "available": False})
        return r

    now = time.time()
    with _update_lock:                       # 锁住的是「真拉取」这一段：并发请求不会一拥而上
        if _update_cache:
            age = now - (_update_cache.get("checkedAt") or 0)
            since_try = now - _update_last_try
            # force（人主动点的）只挡"连点"；自动查才吃 6 小时 TTL / 30 秒间隔
            blocked = (since_try < UPDATE_FORCE_GAP_SEC) if force else (
                since_try < UPDATE_MIN_GAP_SEC or age < UPDATE_TTL_SEC)
            if blocked:
                return dict(_update_cache)
        _update_last_try = now
        remote, err = None, ""
        try:
            remote = _http_get_json(UPDATE_MANIFEST_URL)
            if not isinstance(remote, dict):
                raise ValueError("version.json 不是 JSON 对象")
        except Exception as e:                                  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
        if remote is not None:
            res = _version_result(local, remote, "", UPDATE_MANIFEST_URL, now)
        elif _update_cache and _update_cache.get("remote"):
            # 这次没拉到，但上次成功过：留着上次的结论并标 stale ——
            # 「本来提示有新版本，网一断提示就没了」比不提示更让人糊涂
            res = _version_result(local, _update_cache["remote"], err, UPDATE_MANIFEST_URL,
                                  _update_cache.get("checkedAt") or 0, stale=True)
        else:
            res = _version_result(local, None, err, UPDATE_MANIFEST_URL, now)
            print(f"[update] 检查更新失败：{err}（现场没外网就会这样，不影响使用）")
        _update_cache = res
        return dict(res)


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
        if isinstance(_source, _REMOTE_SRC):
            _source.stop()
    except Exception as e:                                      # noqa: BLE001
        print(f"[update] 停轮询时出错（继续退出）：{e}")
    try:
        _source.flush()                   # 合并窗口里没落盘的变量写下去
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
                             "请下载并运行新版安装包 HMIDesigner-Setup-*.exe（安装它不会动现场工程与配置）"}

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
#  报警历史（运行记录）：**存服务器**，不能只放浏览器
#  · 为什么：客户机/一体机上每次打开都是**新的浏览器 profile**（PyWebView 尤其明显），
#    换地址（127.0.0.1 ↔ 局域网 IP）也是各自一份 localStorage —— 报警记录就这么"消失"了。
#    报警记录是现场凭据，必须落在跑 server.py 那台机器上。
#  · 为什么不塞进工程文件：报警是**运行数据**（一直长），工程是配置（会被整份覆盖），
#    混在一起就会「存一次工程把记录冲掉」。
#  · 写入不设登录闸门：报警由**运行页**产生（客户机上没人登录），和写变量一个性质
#    （见 HMIServer.ADMIN_PATHS 的说明）。
# ─────────────────────────────────────────────
ALARM_CAP_BYTES = 5 * 1024 * 1024   # 报警记录**环形存储**上限：5MB，超了就从最早那条开始丢
                                    # （现场记录是凭据，但也不能无限长 —— 满盘比丢老记录更糟）
ALARM_DUP_WINDOW_MS = 60000         # 同一条报警在这个窗口内的"又一次触发"算**同一次**
                                    # （两个页面同时在跑判定、或页面重开时会各判一次，不去重就记出重复条目）
_alarm_lock = threading.Lock()


def _alarms_load():
    """读存档（读不出来就按空记录继续 —— 宁可少几条，也不能让接口 500）"""
    if not ALARMS_FILE.exists():
        return []
    try:
        raw = json.loads(ALARMS_FILE.read_text(encoding="utf-8"))
    except Exception as e:                                   # noqa: BLE001
        print(f"[alarm] 报警记录文件读不出来（{e}）：本次按空记录继续，文件没动")
        return []
    items = raw.get("history") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    return [r for r in items if isinstance(r, dict)]


def _alarms_save(items):
    """整份落盘：按**环形**截断（超过 ALARM_CAP_BYTES 就丢最早的那些），再原子替换。

    · 先写临时文件再 replace：写一半断电也不会把记录毁掉；
    · 紧凑 JSON（不缩进）：文件是给机器读的，缩进白占两成空间，能多留两成记录。"""
    items = sorted(items, key=lambda r: r.get("at") or 0)
    body = json.dumps({"history": items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    dropped = 0
    while len(body) > ALARM_CAP_BYTES and len(items) > 1:
        # 一次丢最早的一成（至少 1 条）再量一次：几万条记录也只循环十几次，
        # 比逐条重算（每次都序列化整个数组）快得多
        drop = max(1, len(items) // 10)
        items = items[drop:]
        dropped += drop
        body = json.dumps({"history": items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp = ALARMS_FILE.with_name(ALARMS_FILE.name + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(ALARMS_FILE)
    if dropped:
        print(f"[alarm] 记录超过 {ALARM_CAP_BYTES // 1048576}MB 上限：环形丢掉最早的 {dropped} 条，"
              f"现在 {len(items)} 条 / {len(body) / 1024:.0f}KB")
    return items


def _alarm_add(items, adds):
    """追加记录。

    去重规则（前端 js/runtime/alarms.js 用的是同一条规则，两边必须一致）：
      同一条报警（key 相同）**还没恢复**（endAt 空）且起始时间在 DUP 窗口内 → 算同一次触发，
      不新记一条，把服务器上那条回给前端（前端拿它换掉自己刚记的那条）。
    另外：真的记了一条新触发时，把同一条报警还挂着的旧记录补上结束时间
    （现场换班/重启后重新触发，老记录不该永远"未恢复"）。"""
    added, skipped, closed = [], [], []
    for r in adds:
        if not isinstance(r, dict):
            continue
        key = r.get("key")
        if not key:
            continue
        at = int(r.get("at") or 0)
        rec = {
            "key": key, "id": r.get("id") or key, "name": r.get("name") or "",
            "text": r.get("text") or "", "level": r.get("level") or "alarm",
            "value": r.get("value"), "at": at, "endAt": int(r.get("endAt") or 0),
            "acked": bool(r.get("acked")),
        }
        opens = [x for x in items if x.get("key") == key and not x.get("endAt")]
        dup = next((x for x in opens if abs(int(x.get("at") or 0) - at) <= ALARM_DUP_WINDOW_MS), None)
        if dup is not None:
            # 同一次报警（多客户端同时判定 / 前端重发）→ 只更新"当时的值/文字"，不再记一条
            dup["value"] = rec["value"]
            if rec["text"]:
                dup["text"] = rec["text"]
            skipped.append(dup)
            continue
        for x in opens:            # 新的这次触发之前还挂着的旧记录：补结束时间
            x["endAt"] = at or int(time.time() * 1000)
            closed.append(x)
        items.append(rec)
        added.append(rec)
    return items, added, skipped, closed


def _alarm_patch(items, patches):
    """改记录（补恢复时间 / 确认）：按 key（+at）找到那一条"""
    patched = []
    for p in patches:
        if not isinstance(p, dict) or not p.get("key"):
            continue
        key = p.get("key")
        at = int(p.get("at") or 0)
        same = [x for x in items if x.get("key") == key]
        if not same:
            continue
        cand = [x for x in same if at and int(x.get("at") or 0) == at]
        if not cand:
            cand = [x for x in same if not x.get("endAt")] or same
        tgt = cand[-1]
        changed = False
        if p.get("endAt") and not tgt.get("endAt"):
            tgt["endAt"] = int(p["endAt"])
            changed = True
        if p.get("acked") and not tgt.get("acked"):
            tgt["acked"] = True
            changed = True
        if changed:
            patched.append(tgt)
    return items, patched



# ─────────────────────────────────────────────
#  登录页（客户机上只有 /run 是开放的；改东西要先在这登录）
# ─────────────────────────────────────────────
LOGIN_PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:,">
<title>登录 · HMI 组态设计器</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#1b1f26; color:#e5e7eb;
         font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif; }
  .card { width:340px; background:#232831; border:1px solid rgba(255,255,255,.1);
          border-radius:12px; padding:26px 24px 22px; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  h1 { margin:0 0 4px; font-size:17px; }
  p.sub { margin:0 0 18px; color:#9aa4b2; font-size:12.5px; line-height:1.7; }
  label { display:block; font-size:12.5px; color:#9aa4b2; margin-bottom:6px; }
  input { width:100%; height:38px; padding:0 11px; border-radius:7px; font-size:14px;
          border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.07); color:#fff; outline:none; }
  input:focus { border-color:#60a5fa; }
  button { width:100%; height:38px; margin-top:14px; border:none; border-radius:7px; cursor:pointer;
           background:#2563eb; color:#fff; font-size:14px; font-weight:600; }
  button:hover { background:#1d4ed8; }
  .err { margin-top:12px; padding:8px 10px; border-radius:6px; font-size:12.5px; line-height:1.6;
         background:rgba(220,38,38,.16); border:1px solid rgba(220,38,38,.5); color:#fca5a5; }
  .foot { margin-top:16px; font-size:12px; color:#9aa4b2; line-height:1.7; }
  .foot a { color:#60a5fa; }
</style></head>
<body>
  <form class="card" method="POST" action="/login" id="f">
    <h1>管理员登录</h1>
    <p class="sub">现场运行画面在 <b>/run</b>，不用登录也能看。<br>要改画面、变量、PLC 连接才需要登录。</p>
    <label for="pw">密码</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
    <input type="hidden" name="next" value="/">
    <button type="submit">登录</button>
    __ERR__
    <div class="foot">
      忘了密码？在服务器上双击 <b>set_password.bat 新密码</b> 重设。<br>
      <a href="__RUN__">← 回到运行画面</a>
    </div>
  </form>
</body></html>
"""


def login_page_html(err: str = "") -> str:
    """登录页（__RUN__ = 运行页地址、__ERR__ = 错误提示，按当前路由模式填）"""
    return (LOGIN_PAGE.replace("__RUN__", RUN_PATH)
            .replace("__ERR__", f'<div class="err">{err}</div>' if err else ""))


# ─────────────────────────────────────────────
#  数据源抽象（Python ↔ 设备 的唯一对接点）
# ─────────────────────────────────────────────
class RetainStore:
    """HMI 内部的**掉电保持**变量：值存 server/data/retain_vars.json。

    只对**地址留空**的变量（= 内部变量，见前端变量表的「保持」列）有意义 ——
    这类变量不读也不写 PLC，值就是 HMI 自己算/自己写的：

        · 勾了「保持」 → 值落盘，**后端重启 / 整机断电后还在**（和报警历史一个级别：
          跟着跑后端这台机器走，换浏览器、换台电脑打开都一样）
        · 没勾     → 只在内存里，重启回变量表初值

    为什么**不做**"开机把保持值下发给 PLC"：那等于开机偷偷写设备（掉电前是"启动"、
    上电就自动下发，现场不可预料）。要写 PLC 请在脚本/控件里显式做。

    写盘策略和内存模式一致：写入只标脏，后台线程每 FLUSH_INTERVAL 秒合并写一次
    （原子写：先写 .tmp 再替换，断电不会写坏存档）。
    """

    def __init__(self, path: Path, interval: float = FLUSH_INTERVAL):
        self.path = path
        self.interval = interval
        self._lock = threading.Lock()
        self._vals = {}
        self._dirty = False
        try:
            if path.exists():
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self._vals = raw
        except Exception as e:
            print(f"[warn] 掉电保持值读不出来（先当空的）: {e}")
        threading.Thread(target=self._flush_loop, daemon=True).start()

    def all(self) -> dict:
        with self._lock:
            return dict(self._vals)

    def get(self, name, default=None):
        with self._lock:
            return self._vals.get(name, default)

    def has(self, name) -> bool:
        with self._lock:
            return name in self._vals

    def set(self, name, value):
        with self._lock:
            if self._vals.get(name) == value and name in self._vals:
                return False
            self._vals[name] = value
            self._dirty = True
        return True

    def forget(self, *names):
        """不再保持（取消勾选 / 变量删掉）→ 把存盘那份丢掉"""
        with self._lock:
            hit = False
            for n in names:
                if n in self._vals:
                    del self._vals[n]
                    hit = True
            if hit:
                self._dirty = True
        return hit

    def flush(self):
        with self._lock:
            if not self._dirty:
                return False
            self._dirty = False
            payload = json.dumps(self._vals, ensure_ascii=False, indent=2)
        try:
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(self.path)
            return True
        except Exception as e:
            print(f"[warn] 掉电保持值落盘失败: {e}")
            with self._lock:
                self._dirty = True
            return False

    def _flush_loop(self):
        while True:
            time.sleep(self.interval)
            try:
                self.flush()
            except Exception as e:
                print(f"[warn] 掉电保持落盘线程异常: {e}")


# 全局一份：两种数据源（内存模拟 / 真 PLC）共用 ——
# 掉电保持是 **HMI 自己的**数据，跟当前接没接 PLC 无关。
_retain = RetainStore(RETAIN_FILE)


class DataSource:
    """数据源接口。读写均以「变量名」寻址；变量 → 寄存器地址的映射
    来自前端变量表里用户填写的 address 字段（存在 self._meta 中）。

    地址留空的变量 = **内部变量**：不参与 PLC 读写，值由 HMI 自己维护
    （勾了「保持」的由 RetainStore 落盘）。两种数据源的行为必须一致。"""

    def read_all(self) -> dict:
        raise NotImplementedError

    def read(self, name):
        raise NotImplementedError

    def write(self, name, value):
        raise NotImplementedError

    def meta(self) -> dict:
        """返回 {name: {address, type}} 映射，供真实设备寻址使用。"""
        raise NotImplementedError


class MemorySource(DataSource):
    """内存模拟数据源（当前默认）。
    变量表持久化到 server/data/vars.json，重启后保留。
    落盘合并：写入只标脏，由后台线程每 FLUSH_INTERVAL 秒写一次
    （点动一次 = 按下+松开两次写，逐次全量重写文件在真机上会拖慢响应）。"""

    def __init__(self):
        self._lock = threading.Lock()
        # {name: {"value": ..., "type": ..., "address": ...}}
        self._vars = {}
        self._active = None          # 跟 PlcSource 对齐（内存模式不轮询，只是别让属性缺失）
        self._dirty = False
        if VARS_FILE.exists():
            try:
                self._vars = json.loads(VARS_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass
        # 老档案补齐 internal 标记：**按地址算**（地址留空 = 内部变量）。
        # 不补的话，从旧档案起来的内部变量写值会报「地址 '' 无效：未填写」。
        for rec in self._vars.values():
            if isinstance(rec, dict):
                rec["internal"] = not (rec.get("address") or "").strip()
        threading.Thread(target=self._flush_loop, daemon=True).start()

    def read_all(self):
        with self._lock:
            return {k: v["value"] for k, v in self._vars.items()}

    def read(self, name):
        with self._lock:
            v = self._vars.get(name)
            return None if v is None else v["value"]

    def write(self, name, value):
        with self._lock:
            if name in self._vars:
                self._vars[name]["value"] = value
                keep = bool(self._vars[name].get("retain"))
            else:  # 前端新变量自动建档
                self._vars[name] = {"value": value, "type": type(value).__name__, "address": ""}
                keep = False
            self._dirty = True
        if keep:
            _retain.set(name, value)      # 勾了「保持」的：同时进掉电保持存档
        return True

    def declare(self, variables, active=None):
        """前端连接成功后同步变量表（保留当前值，补齐元数据）

        active 参数这里**用不上**（内存模式不轮询），但签名必须跟 PlcSource 一致：
        以前只收一个参数，前端改成传 (variables, active) 之后，只要没连 PLC（内存模式），
        每次变量表下发都会 TypeError → 连接被直接掐断（浏览器里只看到 ERR_EMPTY_RESPONSE），
        表现就是"改了变量不生效"。签名对齐后这个坑就没了。
        """
        with self._lock:
            for v in variables:
                if not isinstance(v, dict):
                    continue
                name = v.get("name")
                if not name or not isinstance(name, str):
                    continue
                # 「保持」只对**无地址的内部变量**有意义（有地址的变量，保持是 PLC 的事）
                retain = bool(v.get("retain")) and not (v.get("address") or "").strip()
                # 地址留空 = 内部变量：这个标记**必须写进档案**（要和 PlcSource/OpcUaSource 一个口径）。
                # 以前内存模式不写这个键，落盘的 vars.json 里就没有它 —— 之后任何按 internal 判断的
                # 地方（写值、恢复初值）都会把内部变量当成"地址没填好的 PLC 变量"。
                internal = not (v.get("address") or "").strip()
                old = self._vars.get(name) or {}
                if not old:
                    # 第一次见这个变量：勾了保持就用**存档里的值**（上次运行/上次断电前的值），
                    # 没有才回变量表初值 —— 否则重启后每下发一次变量表就把保持值冲掉
                    value = _retain.get(name, v.get("value")) if retain else v.get("value")
                    self._vars[name] = {
                        "value": value,
                        "type": v.get("type", "real"),
                        "address": v.get("address", ""),
                        "internal": internal,
                        # default = 变量表里的初值：运行中把模拟值改乱了，
                        # 「恢复初值」按它还原（见 reset()）
                        "default": v.get("value"),
                        "retain": retain,
                    }
                else:
                    self._vars[name]["type"] = v.get("type", old.get("type"))
                    self._vars[name]["address"] = v.get("address", old.get("address", ""))
                    self._vars[name]["internal"] = internal      # 地址改空/改回来时跟着更新
                    # 变量表里改了初值 → 跟着走（前端每次下发变量表都带着 value 初值）
                    self._vars[name]["default"] = v.get("value")
                    was = bool(old.get("retain"))
                    self._vars[name]["retain"] = retain
                    if was and not retain:
                        # 取消勾选「保持」→ 存盘那份丢掉（不然下次重启它又冒出来）
                        _retain.forget(name)
                    elif retain and not _retain.has(name):
                        _retain.set(name, self._vars[name]["value"])
            self._dirty = True
            if active is not None:
                self._active = set(active) & set(self._vars.keys())

    def reset(self, clear=False):
        """把所有变量恢复成**变量表里的初值**（内存模拟专用）。

        场景：内部变量跑联调时手改了一堆值，或者上一次留下的值（true / 12 之类）
        让这次「改了没反应」—— 一键回到干净状态。接真设备时没有这个方法（不能拿它去盖 PLC）。

        clear=True 更进一步：**整份清空**（变量档案一起丢掉，下次下发变量表按表里的初值重建）。
        自动化测试每跑一个用例前用它，免得上一个用例留下的值让下一个用例的判断失真。
        """
        with self._lock:
            if clear:
                self._vars = {}
                _retain.forget(*list(_retain.all().keys()))
            else:
                for name, rec in self._vars.items():
                    if "default" in rec:
                        rec["value"] = rec["default"]
                        # 勾了「保持」的：重置后的值也写回存档，否则重启又把它带回来
                        if rec.get("retain"):
                            _retain.set(name, rec["value"])
            self._dirty = True
            return {k: v["value"] for k, v in self._vars.items()}

    def meta(self):
        with self._lock:
            return {k: {"address": v.get("address", ""), "type": v.get("type", "")}
                    for k, v in self._vars.items()}

    def flush(self):
        """把脏数据落盘（原子写：先写临时文件再替换，避免断电写坏存档）"""
        with self._lock:
            if not self._dirty:
                return False
            self._dirty = False
            payload = json.dumps(self._vars, ensure_ascii=False, indent=2)
        try:
            tmp = VARS_FILE.with_suffix(".json.tmp")
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(VARS_FILE)
            return True
        except Exception as e:
            print(f"[warn] 变量持久化失败: {e}")
            with self._lock:
                self._dirty = True
            return False

    def _flush_loop(self):
        while True:
            time.sleep(FLUSH_INTERVAL)
            try:
                self.flush()
            except Exception as e:
                print(f"[warn] 落盘线程异常: {e}")


# ─────────────────────────────────────────────
#  真实设备接入：Modbus TCP 主站数据源
# ─────────────────────────────────────────────
class PlcSource(DataSource):
    """把 PLC（Modbus TCP 从站，如 Invtmatic 的 Modbus_TCP_Slave）当数据源。

    变量表里的地址决定怎么读写：
        %MW96 保持寄存器   %MD48 双字(低字在前)   %MB194 字节   %MX195.0 内存位
        %QX0 线圈(FC01/05) %IX0 离散输入(FC02)    %IW5 输入寄存器(FC04)
    轮询线程把地址按区域合并成连续区间批量读（最多 125 个寄存器/帧），
    值变化时通过 on_change 回调广播给前端。
    """

    def __init__(self, host, port=502, unit=1, poll_ms=200, word_order="cdab", timeout=1.5,
                 on_change=None, on_changes=None):
        self.host = host
        self.port = int(port)
        self.unit = int(unit)
        self.poll_ms = max(50, int(poll_ms))
        # 4 种字序：abcd / cdab / badc / dcba（low/high 作兼容别名）
        self.word_order = modbus.normalize_order(word_order)
        self._lock = threading.RLock()
        self._vars = {}                 # name -> {"type","address","value","parsed"}
        self._active = None             # 本页要采集的变量名集合（None = 全部）
        self._blocks = 0                # 上一次规划的读取块数（状态栏/体检用）
        self._cli = modbus.ModbusTcpClient(host, self.port, self.unit, timeout)
        self._stop = threading.Event()
        self._thread = None
        self._on_change = on_change
        self._on_changes = on_changes      # 一批变化一起回调（优先用，见 _emit_changed）
        self.online = False
        self.last_error = ""
        self.last_ok = 0.0
        self.reads = 0
        self.writes = 0
        self.errors = 0

    # ── 变量表同步 ──
    def declare(self, variables, active=None):
        """整体替换变量表：删掉的变量要真的不再采集/广播（只增量更新会一直留着）。

        active：**本页需要的变量名**（不传 = 全部采集）。前端切页面时只把当前页用到的
        变量名发过来，轮询就只读这些 —— 画面上的控件、报警条件之外的一律不占通讯带宽。

        地址解析结果按**地址字符串**缓存：变量表上万时，每改一个变量都要重新解析全部地址
        （10000 次 parse_address ≈ 上百毫秒），缓存后只有真变了的地址才重解析。
        """
        cache = getattr(self, "_addr_cache", None)
        if cache is None:
            cache = self._addr_cache = {}
        new = {}
        with self._lock:
            for v in variables or []:
                if not isinstance(v, dict):
                    continue
                name = v.get("name")
                if not name:
                    continue
                addr = (v.get("address") or "").strip()
                vtype = v.get("type", "uint")
                parsed = None
                perr = ""
                if addr:
                    hit = cache.get(addr)
                    if hit is not None:
                        parsed, perr = hit
                    else:
                        try:
                            parsed = modbus.parse_address(addr)
                        except ValueError as e:
                            perr = str(e)
                        cache[addr] = (parsed, perr)
                old = self._vars.get(name) or {}
                # 地址留空 = **内部变量**：不读不写 PLC，值由 HMI 自己维护（见 RetainStore）。
                # ⚠ 以前这种变量被当成"地址没填好的 PLC 变量"：写它会报
                #   「地址 '' 无效：未填写」，界面上就是一条「下发失败」——
                #   于是"接上真 PLC 之后，HMI 自己的内部变量全废了"。
                internal = not addr
                if internal:
                    retain = bool(v.get("retain"))
                    value = old.get("value")
                    if value is None:
                        value = _retain.get(name, v.get("value")) if retain else v.get("value")
                    elif retain and not _retain.has(name):
                        _retain.set(name, value)
                    if old.get("retain") and not retain:
                        _retain.forget(name)         # 取消勾选「保持」→ 存盘那份丢掉
                    new[name] = {
                        "type": vtype,
                        "address": "",
                        "value": value,
                        "default": v.get("value"),   # 「恢复初值」按它还原
                        "parsed": None,
                        "addr_error": "",
                        "internal": True,
                        "retain": retain,
                        "len": v.get("len") or old.get("len") or 0,
                    }
                    continue
                new[name] = {
                    "type": vtype,
                    "address": addr,
                    "value": old.get("value", v.get("value")),
                    "default": v.get("value"),
                    "parsed": parsed,
                    "addr_error": perr,
                    # 字符串长度（字符数）：变量表「长度」列，或地址里的 %MW200[10]（10 个字）
                    "len": v.get("len") or old.get("len") or 0,
                }
            self._vars = new
            if active is not None:
                self._active = set(active)
                # 变量表里没有的（或已删掉的）不算在采集范围里
                self._active &= set(new.keys())

    def meta(self):
        with self._lock:
            return {k: {"address": v.get("address", ""), "type": v.get("type", "")}
                    for k, v in self._vars.items()}

    def read_all(self):
        with self._lock:
            return {k: v.get("value") for k, v in self._vars.items()}

    def read(self, name):
        with self._lock:
            v = self._vars.get(name)
            return None if v is None else v.get("value")

    def reset(self, clear=False):
        """**只重置内部变量**（地址留空的那些）—— 接真 PLC 时按这个口径：

            · PLC 变量一个字节都不碰（"恢复初值"绝不能去盖设备上的值）
            · 内部变量 → 回变量表初值；勾了「保持」的连存档一起改掉（否则重启又带回来）
            · clear=True → 内部变量整份清空，下次下发变量表按初值重建

        这样接不接 PLC，"内部变量：恢复初值"这个入口都在（前端右键菜单）。
        """
        changed = {}
        with self._lock:
            for name, rec in list(self._vars.items()):
                if not rec.get("internal"):
                    continue
                if clear:
                    del self._vars[name]
                    _retain.forget(name)
                    continue
                if "default" in rec:
                    rec["value"] = rec["default"]
                if rec.get("retain"):
                    _retain.set(name, rec["value"])
                changed[name] = rec.get("value")
        return changed

    # ── 写 ──
    def write(self, name, value):
        # 数组元素写法 `arrw[3]`：只写那一个元素占的寄存器（地址往后挪 i×每元素字数），
        # 其余寄存器一个都不碰 —— 和 OPC UA 侧的「读改写整段」是同一个语义，前端不用改
        name_s = str(name or "")
        elem_idx = None
        base_name = name_s
        with self._lock:
            v = self._vars.get(name_s)
        if v is None:
            # ⚠ 先按**整名**找变量，找不到才当「数组的第 n 个元素」解析：
            #   数组被「展开成单个变量」之后变量名本身就长这样（arrw[1]），
            #   不做这一步的话，展开出来的元素一个都写不进去（报"arrw 未声明"）。
            m = re.match(r"^(.+)\[(\d+)\]$", name_s)
            if m:
                base_name, elem_idx = m.group(1), int(m.group(2))
                with self._lock:
                    v = self._vars.get(base_name)
        if not v:
            raise ValueError(f"变量 {base_name} 未在变量表声明")
        # 内部变量（地址留空）：不碰 PLC，值就存在后端（勾了「保持」的顺带落盘）。
        # ⚠ 这里**不能只看 internal 标记**：老版本的 vars.json / 内存模式落盘的档案里没有这个键，
        #   只看它就会把内部变量当成"地址没填好的 PLC 变量"，写值直接报
        #   「变量 _demoT 的地址 '' 无效：未填写」—— 界面上就是一条刺眼的「下发失败」，
        #   而它其实根本不该往 PLC 发。所以**地址本身才是判据**，标记只是补充。
        if v.get("internal") or not (v.get("address") or "").strip():
            # 内部变量：不碰 PLC，值就存在后端（勾了「保持」的顺带落盘）
            with self._lock:
                v["value"] = value
            if v.get("retain"):
                _retain.set(base_name, value)
            return True
        if not v.get("parsed"):
            raise ValueError(f"变量 {base_name} 的地址 {v.get('address')!r} 无效：{v.get('addr_error') or '未填写'}")
        if not self._cli.connected:
            self._connect()
        before = self._cli.fc16_fallbacks
        vtype = v.get("type", "uint")
        if elem_idx is not None and str(vtype).lower().endswith("[]"):
            elem = str(vtype)[:-2].lower()
            ew = modbus.elem_words(elem)
            a = v["parsed"]
            sub = modbus.Address(a.area, a.offset + elem_idx * ew, ew, kind=a.kind)
            self._cli.write_var(sub, value, elem, self.word_order)
        else:
            self._cli.write_var(v["parsed"], value, vtype, self.word_order,
                                length=v.get("len") or None)
        self.writes += 1
        if self._cli.fc16_fallbacks > before:
            self.last_error = ""            # 退回落是正常兜底，不算错，但要留个痕
            print(f"[plc] 从站不支持 FC16（写多寄存器），{v.get('address')} 已退回逐个 FC06 写")
        with self._lock:
            if elem_idx is None:
                v["value"] = value
            else:
                cur = v.get("value")
                arr = list(cur) if isinstance(cur, list) else []
                while len(arr) <= elem_idx:
                    arr.append(0)
                arr[elem_idx] = value
                v["value"] = arr
        # HMI 写过的变量**一直留在采集范围里**：否则它一旦不在本页采集范围内就再也不读了，
        # 界面上会永远停在下发的那个值上（PLC 已经变回去了，界面还显示旧值 —— 实测踩过）
        seen = getattr(self, "_written", None)
        if seen is None:
            seen = self._written = set()
        seen.add(base_name)

    # ── 轮询 ──
    def _connect(self):
        if self._cli.connected:
            return
        self._cli.connect()
        self.online = True
        self.last_error = ""
        print(f"[plc] 已连接 {self.host}:{self.port} 站号 {self.unit}")

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._cli.close()

    def _plan(self):
        """把「本页要采的」地址按区域合并成连续区间：[(area, start, count, [(name, parsed, vtype, vlen)])]

        连续地址合并成一次读（FC03 一次读多个寄存器）—— %MW100/102/104 三个变量
        以前是 3 次请求，现在 1 次读回 5 个字就都有了。间隔 ≤ 8 个字就并进同一块，
        块内最多 125 个字（Modbus 单次上限）。
        """
        active = getattr(self, "_active", None)
        written = getattr(self, "_written", None) or set()
        with self._lock:
            items = [(n, v["parsed"]) for n, v in self._vars.items()
                     if v.get("parsed") and (active is None or n in active or n in written)]
        plan = []
        for area in (modbus.HOLDING, modbus.INPUT_REG):
            regs = sorted([(p.offset, n, p, (self._vars.get(n) or {}).get("type", "uint"),
                            (self._vars.get(n) or {}).get("len") or None)
                           for n, p in items if p.area == area and not p.is_bit],
                          key=lambda x: x[0])
            block = None
            for off, name, p, vtype, vlen in regs:
                # ⚠ 字数按「类型」算（real=2、lreal=4、string 按字符数），不能只看地址写法：
                # 地址写 %MW100 而类型是 real 时，只读 1 个字会解出 6.4757e-320 这种鬼数
                span = modbus.words_for(vtype, p.words, vlen)
                end = off + span
                if block and off - (block[1] + block[2]) <= 8 and (end - block[1]) <= 125:
                    block[2] = end - block[1]
                    block[3].append((name, p, vtype, vlen))
                else:
                    block = [area, off, end - off, [(name, p, vtype, vlen)]]
                    plan.append(block)
        for area in (modbus.COIL, modbus.DISCRETE):
            bits = sorted([(p.offset, n, p) for n, p in items if p.area == area], key=lambda x: x[0])
            if bits:
                lo = bits[0][0]
                # ⚠ %QW 是「16 个位拼成的字」（见 addr_model.py）：它占的位范围要按 p.bits 算进去，
                #   只按 offset 算的话块只盖住第一位，拼出来的字高 15 位全丢。
                hi = max(p.offset + max(1, p.bits) - 1 for _, _, p in bits)
                if hi - lo <= 512:
                    plan.append([area, lo, hi - lo + 1,
                                 [(n, p, (self._vars.get(n) or {}).get("type", "uint"),
                                   (self._vars.get(n) or {}).get("len") or None) for _, n, p in bits]])
        return plan

    def _poll_loop(self):
        while not self._stop.is_set():
            try:
                if not self._cli.connected:
                    self._connect()
                plan = self._plan()
                self._blocks = len(plan)
                if not plan:
                    # 本页没用变量（采集范围空）→ 什么都不读也"成功"，PLC 断了发现不了。
                    # 保活：探一个寄存器/线圈，读不动就按掉线处理（界面上要能提示）
                    self._cli.read_registers(0, 1, modbus.FC_READ_HOLDING)
                    self.reads += 1
                    self.last_ok = time.time()
                    self.online = True
                    self._stop.wait(self.poll_ms / 1000)
                    continue
                for area, start, count, members in plan:
                    if self._stop.is_set():
                        return
                    if area == modbus.HOLDING:
                        words = self._cli.read_registers(start, count, modbus.FC_READ_HOLDING)
                    elif area == modbus.INPUT_REG:
                        words = self._cli.read_registers(start, count, modbus.FC_READ_INPUT)
                    else:
                        fc = modbus.FC_READ_COILS if area == modbus.COIL else modbus.FC_READ_DISCRETE
                        bits = self._cli.read_bits(start, count, fc)
                        words = None
                    self.reads += 1
                    changed = []
                    with self._lock:
                        for name, p, vtype, vlen in members:
                            v = self._vars.get(name)
                            if not v:
                                continue
                            # %MX 内存位：与 %MW 同一片内存，从那个字里取第 p.bit 位
                            #   ⚠ 这里必须先于下面的「整字解码」—— 否则会落到 decode_value 的
                            #   bool 分支，而那里 bit 传的是 None（当 bit0 用），结果「不管置的是哪一位，
                            #   读回来都是第 0 位」：%MX0.0 那些看着正常，%MX1.x 以上全错。
                            if words is not None and p.bit is not None and not p.bits:
                                w = words[p.offset - start] if 0 <= p.offset - start < len(words) else 0
                                val = bool((w >> p.bit) & 1)
                            elif words is not None and not p.is_bit:
                                # 字数和 _plan 用同一个函数算，读/写/轮询三处必须一致
                                cnt = modbus.words_for(vtype or v.get("type"), p.words, vlen)
                                seg = words[p.offset - start: p.offset - start + cnt]
                                try:
                                    val = modbus.decode_value(seg, vtype or v.get("type"), self.word_order,
                                                              byte=p.byte, bit=None, length=vlen)
                                except ValueError as e:
                                    # 声明和读数对不上时不要塞垃圾值进界面，报到状态里让人看见
                                    self.last_error = f"{name}：{e}"
                                    continue
                            elif p.bits:                            # %QW：16 个位拼成的字
                                nw = modbus.words_for(vtype or v.get("type") or "uint", p.words, vlen)
                                seg = bits[p.offset - start: p.offset - start + p.bits * nw]
                                raw = [modbus.bits_to_word(seg[i * 16:(i + 1) * 16]) for i in range(nw)]
                                try:
                                    val = modbus.decode_value(raw, vtype or v.get("type") or "uint",
                                                              self.word_order, length=vlen)
                                except ValueError as e:
                                    self.last_error = f"{name}：{e}"
                                    continue
                            else:                                   # 线圈/离散输入（单个 bool）
                                idx = p.offset - start
                                val = bits[idx] if 0 <= idx < len(bits) else False
                            if v.get("value") != val and not (isinstance(val, float) and isinstance(v.get("value"), float)
                                                              and abs(val - v["value"]) < 1e-9):
                                v["value"] = val
                                changed.append((name, val))
                    _emit_changed(changed, self._on_changes, self._on_change)
                self.last_ok = time.time()
                self.online = True            # 这一轮读成功 = 通讯正常
                # 低频心跳（60 秒一条）：让日志里能看出轮询一直在跑，而不是"读了一次就不读了"
                if self.last_ok - getattr(self, "_beat_at", 0.0) >= 60:
                    self._beat_at = self.last_ok
                    with self._lock:
                        n_act = len(self._active) if self._active is not None else len(self._vars)
                    print(f"[poll] Modbus 本页采 {n_act} 变量 / {self._blocks} 块，"
                          f"累计读 {self.reads} 次，在线 {self.online}")
            except modbus.ModbusError as e:
                self.errors += 1
                self.last_error = str(e)
                self.online = False
                self._cli.close()
                time.sleep(min(2.0, self.poll_ms / 1000 * 5))
            except Exception as e:                                  # noqa: BLE001
                self.errors += 1
                self.last_error = str(e)
                self.online = False
                self._cli.close()
                time.sleep(1.0)
            self._stop.wait(self.poll_ms / 1000)

    def plan_count(self):
        """现在这套采集范围会合并成几次读（前端状态栏「本页 N 变量/M 块」用）。
        注意不能读 self._blocks：那是上一轮轮询留下的，刚改完范围时会差一拍。"""
        try:
            return len(self._plan())
        except Exception:                              # noqa: BLE001
            return self._blocks

    def status(self):
        with self._lock:
            bad = [n for n, v in self._vars.items() if v.get("address") and not v.get("parsed")]
            n_vars = len(self._vars)
            active = None if self._active is None else len(self._active)
            scoped = self._active is not None
        return {
            "mode": "plc", "host": self.host, "port": self.port, "unit": self.unit,
            "poll_ms": self.poll_ms, "word_order": self.word_order,
            "word_order_cn": modbus.WORD_ORDER_CN.get(self.word_order, self.word_order),
            "online": bool(self.online and self._cli.connected),
            "last_error": self.last_error,
            "last_ok": self.last_ok,
            "reads": self.reads, "writes": self.writes, "errors": self.errors,
            "fc16_fallbacks": getattr(self._cli, "fc16_fallbacks", 0),
            "vars": n_vars, "bad_address": bad[:10],
            # 按页采集：active = 本页实际在采几个变量，blocks = 合并成几次读（连续地址并成一块）
            "scoped": scoped, "active": n_vars if active is None else active, "blocks": self._blocks,
        }

    def order_candidates(self, address="%MW0", vtype="real", length=None):
        """只读：把某个地址按 4 种字序各解一遍，现场用来判断对方 PLC 是哪种"""
        if not self._cli.connected:
            self._connect()
        return self._cli.read_order_candidates(address, vtype, length)


# ─────────────────────────────────────────────
#  真实设备接入预留（示例模板，未启用）
# ─────────────────────────────────────────────
# class ModbusSource(DataSource):
#     """Modbus TCP 数据源（需 pip install pymodbus，然后替换下方 _source）
#
#     变量 → 寄存器地址来自前端变量表的 address 列。写失败要抛异常并把原因带上：
#     HMIServer.do_POST 会把它变成 400 + 文字回给前端（而不是丢一个 500 栈）。
#     """
#     def __init__(self, host="192.168.1.10", port=502):
#         from pymodbus.client import ModbusTcpClient
#         self._cli = ModbusTcpClient(host, port)
#         self._meta = {}          # name -> {"address": "HR100", "type": "real"}
#
#     @staticmethod
#     def parse_address(name, raw):
#         """支持 HR100 / 4x0100 / 40101 三种写法；其它写法直接报错，
#         免得写错地址时静默写到 0 号寄存器上。"""
#         a = (raw or "").strip().upper()
#         if a.startswith("HR"):
#             a = a[2:]
#         elif a.startswith("4X"):
#             a = a[2:]
#         elif a.startswith("4") and a.isdigit() and len(a) > 1:
#             a = a[1:]
#         if not a.isdigit():
#             raise ValueError(f"变量 {name} 的地址 {raw!r} 无法解析（约定 HR100 / 4x0100）")
#         return int(a)
#
#     def write(self, name, value):
#         m = self._meta.get(name)
#         if not m:
#             raise ValueError(f"变量 {name} 未在变量表声明")
#         addr = self.parse_address(name, m.get("address"))
#         if m.get("type") == "bool":
#             r = self._cli.write_coil(addr, bool(value))
#         else:
#             r = self._cli.write_register(addr, int(value))
#         if r.isError():
#             raise IOError(f"Modbus 写 {name}@{m.get('address')} 失败: {r}")
#
#     def read_all(self):
#         ...  # 按地址块轮询保持寄存器/线圈 → 返回 {name: value}
# _source = ModbusSource("192.168.1.10")
_source = MemorySource()          # ← 换成真实数据源只需改这一行
# OPC UA 数据源类（没装 asyncua 时 opcua.py 自己会把 AVAILABLE 置 False，类仍在）
OpcUaSource = getattr(opcua, "OpcUaSource", None) if opcua else None
_REMOTE_SRC = tuple(c for c in (PlcSource, OpcUaSource) if c is not None)
_source_lock = threading.RLock()
PLCFG_FILE = DATA_DIR / "plc.json"          # PLC 连接配置（重启后还记得）
# protocol: modbus（默认，老工程原样）/ opcua
_plc_cfg = {"mode": "memory", "protocol": "modbus", "ip": "127.0.0.1", "port": 502, "unit": 1,
            "poll_ms": 200, "word_order": "cdab",
            # OPC UA 专有
            "endpoint": "opc.tcp://127.0.0.1:4840", "security": "none",
            "username": "", "password": "", "default_ns": 4}


def _protocol_of(cfg=None):
    p = str((cfg or _plc_cfg).get("protocol") or "modbus").strip().lower()
    return "opcua" if p in ("opcua", "ua", "opc-ua", "opcua_ua") else "modbus"


def _load_plc_cfg():
    global _plc_cfg
    if PLCFG_FILE.exists():
        try:
            _plc_cfg.update(json.loads(PLCFG_FILE.read_text(encoding="utf-8")))
        except Exception:                                       # noqa: BLE001
            pass


def _save_plc_cfg():
    try:
        PLCFG_FILE.write_text(json.dumps(_plc_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:                                      # noqa: BLE001
        print(f"[warn] PLC 配置保存失败: {e}")


# 模块一加载就把上次保存的 PLC 配置读进内存（server.py 直接跑 / hmi_desktop.py import 都覆盖到）。
# 不读的话 _plc_cfg 永远是内存默认值（mode=memory），_autoconnect_saved_plc() 的
# 「mode == 'plc'」判断永远过不去 → 开机自动连上次配好的服务器就失效，得每次手动点连接。
_load_plc_cfg()


def _on_plc_change(name, value):
    """PLC 值变化 → 广播给所有在线前端（与 /api/vars 写入同一通道）"""
    broadcast({"name": name, "value": value})


def _on_plc_changes(changed):
    """一批 PLC 值变化 → **一条** SSE 消息（{"vars": {...}}）。

    为什么要有批量这条：一次轮询 500 个变量都变了，按老路子要发 500 条 SSE 消息，
    浏览器那边就是 500 次 JSON.parse + 500 次事件派发 —— 光这一项就能吃掉几毫秒，
    而且和控件数无关地白白浪费。合成一条之后前端一次性 applyRemote。"""
    if not changed:
        return
    if len(changed) == 1:
        name, value = changed[0]
        broadcast({"name": name, "value": value})
        return
    broadcast({"vars": {n: v for n, v in changed}})


def _emit_changed(changed, on_changes, on_change):
    """把一批变化交给回调：优先批量回调，没有就退回逐条（老接口仍可用）"""
    if not changed:
        return
    if on_changes:
        on_changes(changed)
        return
    if on_change:
        for name, val in changed:
            on_change(name, val)


def plc_connect(cfg, variables=None):
    """切到真实数据源（先断开旧的）。protocol = modbus / opcua。返回状态字典。"""
    global _source
    proto = _protocol_of(cfg)
    with _source_lock:
        old = _source
        if isinstance(old, _REMOTE_SRC):
            old.stop()
        if proto == "opcua":
            if opcua is None or not opcua.AVAILABLE:
                why = (opcua.IMPORT_ERROR if opcua is not None else "模块加载失败")
                raise ValueError(f"后端没有可用的 asyncua（{why}）—— 装："
                                 f"{opcua.INSTALL_HINT if opcua is not None else ''}")
            src = OpcUaSource(cfg.get("endpoint") or opcua.DEFAULT_ENDPOINT,
                              cfg.get("security", "none"), cfg.get("username", ""),
                              cfg.get("password", ""), cfg.get("poll_ms", 200),
                              default_ns=cfg.get("default_ns", opcua.DEFAULT_NS),
                              on_change=_on_plc_change, on_changes=_on_plc_changes,
                              retain=_retain)   # 内部变量的掉电保持（HMI 自己的，跟 PLC 无关）
        else:
            src = PlcSource(cfg.get("ip"), cfg.get("port", 502), cfg.get("unit", 1),
                            cfg.get("poll_ms", 200), cfg.get("word_order", "cdab"),
                            on_change=_on_plc_change, on_changes=_on_plc_changes)
        if variables:
            src.declare(variables)
        _source = src
        src.start()
        keep = ("protocol", "ip", "port", "unit", "poll_ms", "word_order",
                "endpoint", "security", "username", "password", "default_ns")
        _plc_cfg.update({"mode": "plc", **{k: cfg.get(k, _plc_cfg.get(k)) for k in keep}})
        _plc_cfg["protocol"] = proto
        _save_plc_cfg()
        return src.status()


def _autoconnect_saved_plc():
    """启动时按上次保存的配置自动连设备。

    客户机就是这个用法：管理员配好一次（点确定时配置会存进 server/data/plc.json），
    之后开机只要跑起后端，现场打开 /run 就是连着的真实数据 —— 不用谁去点「连接 PLC」。
    """
    if _protocol_of() == "opcua" or _plc_cfg.get("ip"):
        if str(_plc_cfg.get("mode") or "") != "plc":
            return
        try:
            st = plc_connect(dict(_plc_cfg))
            print(f"[plc] 已按上次的配置自动连接：{_protocol_of()} "
                  f"{_plc_cfg.get('endpoint') if _protocol_of() == 'opcua' else str(_plc_cfg.get('ip')) + ':' + str(_plc_cfg.get('port'))}"
                  f"（在线={st.get('online')}）")
        except Exception as e:                                  # noqa: BLE001
            print(f"[warn] 自动连接设备失败：{e}（现场还能手动登录后在「PLC」里重连）")


def plc_disconnect():
    """切回内存模拟数据源"""
    global _source
    with _source_lock:
        if isinstance(_source, _REMOTE_SRC):
            _source.stop()
        _source = MemorySource()
        _plc_cfg["mode"] = "memory"
        _save_plc_cfg()
        return _source_status()


def _source_status():
    with _source_lock:
        if isinstance(_source, _REMOTE_SRC):
            st = _source.status()
            st.setdefault("protocol", "opcua" if isinstance(_source, OpcUaSource) else "modbus")
            return st
    order = modbus.normalize_order(_plc_cfg.get("word_order"))
    return {"mode": "memory", "protocol": _protocol_of(), "online": True, "vars": len(_source.read_all()),
            "host": "", "port": 0, "unit": 0,
            "poll_ms": _plc_cfg.get("poll_ms", 200),
            "word_order": order, "word_order_cn": modbus.WORD_ORDER_CN.get(order, ""),
            "endpoint": _plc_cfg.get("endpoint", ""), "security": _plc_cfg.get("security", "none"),
            "reads": 0, "writes": 0, "errors": 0, "last_error": "",
            # 内存模式不轮询：这几个键保持和 PLC 模式一致，前端状态栏不用分支处理
            "scoped": False, "active": len(_source.read_all()), "blocks": 0,
            "bad_address": []}

# ─────────────────────────────────────────────
#  SSE 广播通道
# ─────────────────────────────────────────────
_clients = []          # [queue.Queue]
_clients_lock = threading.Lock()

def broadcast(payload: dict):
    with _clients_lock:
        for q in _clients:
            try:
                q.put_nowait(json.dumps(payload, ensure_ascii=False))
            except queue.Full:
                pass

# ─────────────────────────────────────────────
#  HTTP Handler
# ─────────────────────────────────────────────
class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """浏览器关页面/刷新/SSE 断开都是正常现象，socketserver 默认会为每个这种连接
    打一整段 ConnectionAbortedError 栈 —— 刷屏之后真正的 PLC 报错反而看不见了。"""

    daemon_threads = True
    _QUIET = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, ConnectionError)

    def handle_error(self, request, client_address):
        import sys as _sys
        exc = _sys.exc_info()[1]
        if isinstance(exc, self._QUIET):
            return                       # 客户端提前断开：属于正常，不打印
        super().handle_error(request, client_address)


# 显式补上 .js / .mjs 的 MIME：Python 3.10 的 extensions_map 里没有 .js，
# 靠 mimetypes 兜底在个别机器/版本上可能给错或给空 → 浏览器按 HTML 规范拒绝加载
# ES module（「Failed to load module script」），前端整个白屏。这里写死最稳。
SimpleHTTPRequestHandler.extensions_map.update({
    ".js": "application/javascript",
    ".mjs": "application/javascript",
})


class HMIServer(SimpleHTTPRequestHandler):
    # ⚠ 静态文件（css/js/index.html…）**一律从 ROOT 找**，不能靠"当前工作目录"。
    #   SimpleHTTPRequestHandler 默认按 cwd 找文件，源码方式跑时 cwd 正好是工程根目录
    #   （start_server.bat 里 `cd /d "%~dp0"`）—— 看着没事；但打包成 exe 装到
    #   Program Files 之后，进程的工作目录是"从哪儿启动的"，于是 js/main.js 全 404、
    #   页面一片白（窗口能开、接口正常，就是不显示——踩过一次，窗口自检才逮到）。
    def translate_path(self, path):
        saved = getattr(self, "directory", None)
        self.directory = str(ROOT)
        try:
            return super().translate_path(path)
        finally:
            self.directory = saved

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    # ── 工具 ──
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        """只回显「自己人」的来源，绝不发 '*'。
        发 '*' 等于让任意网站都能读写这台机器上的变量 —— 接真 PLC 后就是
        「任何网页都能改设定值」的后门。"""
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _origin_allowed(self):
        """写请求的来源校验：
        · 没有 Origin（curl / 脚本 / 网关等非浏览器客户端）→ 放行
        · 本机来源（127.0.0.1 / localhost / [::1]）→ 放行
        · 与 Host 同源（同一台服务器托管的页面，含局域网 IP 访问）→ 放行
        · 其它（随便一个网页、DNS rebinding）→ 拒绝
        """
        if ALLOW_ANY_ORIGIN:
            return True
        host = _split_host(self.headers.get("Host"))
        # 用域名访问时一律按同源处理会留下 rebinding 口子 → 只认 IP 字面量/localhost
        if host and not (host.lower() == "localhost" or _is_local_host(host)):
            try:
                ipaddress.ip_address(host)
            except ValueError:
                return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            oh = urlparse(origin).hostname or ""
        except Exception:
            return False
        return _is_local_host(oh) or (host and oh.lower() == host.lower())

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _raw_body(self) -> str:
        """请求体原文（只读一次！登录页是表单提交，要先拿原文再决定按 JSON 还是 form 解）"""
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return ""
        try:
            return self.rfile.read(n).decode("utf-8", "replace")
        except Exception:
            return ""

    # ── 登录 / 会话 ──
    def _cookies(self) -> dict:
        raw = self.headers.get("Cookie") or ""
        out = {}
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _logged_in(self) -> bool:
        if not AUTH_ENABLED:
            return True
        return session_ok(self._cookies().get(SESSION_COOKIE))

    def _client_ip(self) -> str:
        return (self.client_address or ("", 0))[0] or "-"

    def _set_session_cookie(self, token: str, expired: bool = False):
        # HttpOnly：脚本偷不走；SameSite=Lax：别站点的跨站请求带不上（挡 CSRF）；
        # Max-Age：**必须是持久 cookie** —— 只给会话 cookie 的话，关掉浏览器/关掉
        # pywebview 窗口就没了，现场每次打开都要重新输密码（用户明确嫌这个烦）。
        c = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax"
        c += "; Max-Age=0" if expired else f"; Max-Age={SESSION_TTL}"
        self.send_header("Set-Cookie", c)

    def _redirect(self, to: str):
        self.send_response(302)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _html(self, text: str, status: int = 200):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _need_login(self, what: str = "这个操作"):
        """没登录就 401（前端据此弹登录）；返回 False 表示已经拦下"""
        if self._logged_in():
            return True
        self._json({"ok": False, "need_login": True,
                    "error": f"{what}需要管理员登录（浏览器打开 /login）"}, 401)
        return False

    def _serve_run_only(self):
        """运行页：index.html 原样发，只多两句
        · window.__HMI_RUN_ONLY__=true → 前端只跑运行态（没有编辑器、没有工具条、没有右键菜单）
        · window.__HMI_RUN_PATH__      → 「去运行画面」用哪个地址（/run，登录了也能看）"""
        f = ROOT / "index.html"
        try:
            html = f.read_text(encoding="utf-8")
        except Exception as e:                                  # noqa: BLE001
            return self._html(f"<h1>读不到 index.html：{e}</h1>", 500)
        html = html.replace("<title>HMI 组态设计器</title>", "<title>HMI 运行</title>", 1)
        html = html.replace(
            "<head>",
            "<head>\n<script>window.__HMI_RUN_ONLY__=true;"
            f"window.__HMI_RUN_PATH__={json.dumps(RUN_ALWAYS)};"
            f"window.__HMI_EDITOR_PATH__={json.dumps(EDITOR_PATH)};</script>", 1)
        self._html(html)

    def _serve_editor(self):
        """组态编辑器：index.html 原样发（+ 一句「运行页在哪」，编辑器里「去运行画面」要用）"""
        f = ROOT / "index.html"
        try:
            html = f.read_text(encoding="utf-8")
        except Exception as e:                                  # noqa: BLE001
            return self._html(f"<h1>读不到 index.html：{e}</h1>", 500)
        html = html.replace(
            "<head>",
            "<head>\n<script>"
            f"window.__HMI_RUN_PATH__={json.dumps(RUN_ALWAYS)};"
            f"window.__HMI_EDITOR_PATH__={json.dumps(EDITOR_PATH)};</script>", 1)
        self._html(html)

    def _serve_login_page(self):
        return self._html(login_page_html())

    def log_message(self, fmt, *args):
        pass  # 静默常规访问日志；API 打印见各分支

    def end_headers(self):
        # 零构建开发工具：HTML/JS/CSS 一律不缓存。
        # 缓存住旧 index.html 配新 JS，会出现「界面半边空白/面板全空」这种极难排查的问题。
        if not getattr(self, "_cache_header_sent", False):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    # ── 路由 ──
    def do_OPTIONS(self):
        if not self._origin_allowed():
            return self._json({"ok": False, "error": "origin not allowed"}, 403)
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # 路径归一：//、/run/ 都认（现场手敲地址经常多一个斜杠）
        path = re.sub(r"/{2,}", "/", (self.path or "/").split("?")[0])
        p = path.rstrip("/") or "/"
        if p == "/login":
            return self._serve_login_page()
        # ⚠ **不拆地址**：/ 默认就是运行页（客户打开地址就是画面）；
        #   登录过的管理员打开同一个 / 才给编辑器 —— 少一套地址就少一堆"走错页"的问题。
        if p == RUN_ALWAYS:
            return self._serve_run_only()            # /run：永远运行页（登录了也能看运行画面）
        if p in ("/", "/index.html"):
            if AUTH_ENABLED and not self._logged_in():
                return self._serve_run_only()        # 默认状态 = 运行
            return self._serve_editor()              # 登录过 = 编辑器
        if p == "/edit":
            return self._redirect("/")               # 老地址兼容（那会儿编辑器在 /edit）
        if self.path == "/api/health":
            with _clients_lock:
                n = len(_clients)
            st = _source_status()
            # build/features 让前端能发现「后端还是旧版本，忘了重启」——
            # 旧后端会把新参数静默当默认值用掉，比报错难查得多
            self._json({"ok": True, "name": "hmi-server", "build": SERVER_BUILD,
                        "features": SERVER_FEATURES,
                        # 当前版本（version.json + build）：状态栏要显示「这台机器上是哪个版本」——
                        # 现场报问题第一句就是「你那是哪个版本」，以前只能靠 build 日期猜
                        "version": dict(_local_version(), build=SERVER_BUILD),
                        # 更新的进行时/上次结果：前端据此显示「正在更新」和「上次更新失败已回滚」，
                        # 现场排查时也能直接看到"上一跳是怎么落地的"（详情在 logs/update-*.log）
                        "update": {"applying": bool(_apply_running), "enabled": bool(UPDATE_ARCHIVE_URL),
                                   "last": updater.read_state(DATA_DIR, "status.json")},
                        # OPC UA 靠第三方库 asyncua，缺了要能当场说明白（而不是连接时莫名失败）
                        "opcua": {"available": bool(opcua is not None and opcua.AVAILABLE),
                                  "import_error": (getattr(opcua, "IMPORT_ERROR", "") if opcua else "模块加载失败"),
                                  "install": (getattr(opcua, "INSTALL_HINT", "") if opcua else ""),
                                  "default_ns": (getattr(opcua, "DEFAULT_NS", 4) if opcua else 4)},
                        "vars": len(_source.read_all()), "clients": n, "plc": st,
                        # 客户机上要能看出「要不要登录才能改」/「现在登录着没」
                        "auth": {"enabled": AUTH_ENABLED, "logged_in": self._logged_in()}})
        elif self.path == "/api/session":
            self._json({"ok": True, "auth_enabled": AUTH_ENABLED, "logged_in": self._logged_in()})
        elif self.path == "/api/plc":
            # 口令只发给**登录过的**管理员（连接对话框要用它把上次配好的账号密码带回来，
            # 省得现场每次重连都重新敲）。没登录时只告诉「有没有」——
            # 运行页读状态不需要口令，不能让它被随便拿走
            cfg = dict(_plc_cfg)
            if not self._logged_in():
                cfg.pop("password", None)
                cfg["has_password"] = bool(_plc_cfg.get("password"))
            self._json({"ok": True, "config": cfg, "status": _source_status()})
        elif self.path == "/api/vars":
            self._json({"vars": _source.read_all(), "meta": _source.meta()})
        elif self.path == "/api/project":
            data = None
            if PROJECT_FILE.exists():
                try:
                    data = json.loads(PROJECT_FILE.read_text(encoding="utf-8"))
                except Exception:
                    pass
            self._json({"ok": True, "data": data})
        elif self.path == "/api/alarms":
            # 报警历史（运行记录）：运行页要读它，**不用登录**
            with _alarm_lock:
                items = _alarms_load()
            self._json({"ok": True, "history": items, "total": len(items)})
        elif self.path == "/api/events":
            self._sse()
        elif p == "/api/update/check":
            # 有没有新版本（只读，不用登录：编辑器自己的状态栏要用）。
            # ?force=1 = 「检查更新」按钮：忽略缓存当场再拉一次（仍受 30 秒最小间隔限制）。
            # 拉不到远端不报错，结果里给 error —— 现场没外网是常态
            q = parse_qs(urlparse(self.path).query)
            force = str((q.get("force") or ["0"])[0]).lower() in ("1", "true", "yes")
            self._json(check_update(force=force))
        else:
            super().do_GET()

    # 改配置 = 要管理员登录（客户机上没密码就动不了这些）。
    # ⚠ 不含 /api/vars 与 /api/vars/declare：写变量值是 HMI 本身的动作，
    #   下发表格/采集范围是运行页面每次进运行态都要做的 —— 拦了客户机就没数据了。
    ADMIN_PATHS = ("/api/project", "/api/plc", "/api/opcua/parse-xml",
                   "/api/opcua/browse", "/api/vars/reset",
                   "/api/update/apply")     # 自己更新会换掉程序文件，必须管理员

    def do_POST(self):
        if not self._origin_allowed():
            print(f"[block] 拒绝来源不明的写请求 Origin={self.headers.get('Origin')}")
            return self._json({"ok": False, "error": "origin not allowed"}, 403)

        # ── 登录 / 注销（不需要先登录）。/login 是登录页表单提交的地址（地址栏停在 /login 上） ──
        if self.path in ("/api/login", "/login"):
            ip = self._client_ip()
            wait = login_blocked(ip)
            if wait:
                return self._json({"ok": False, "error": f"密码试错太多次，等 {wait} 秒再试"}, 429)
            raw = self._raw_body()                 # ⚠ 请求体只能读一次，先拿原文再解
            try:
                body = json.loads(raw) if raw.strip().startswith("{") else {}
            except Exception:
                body = {}
            pw = body.get("password")
            if pw is None:      # 登录页是普通表单提交（application/x-www-form-urlencoded）
                from urllib.parse import parse_qs
                pw = (parse_qs(raw).get("password") or [""])[0]
            if not check_password(pw):
                note_login_fail(ip)
                print(f"[auth] 登录失败（{ip}）")
                if self.headers.get("Accept", "").find("text/html") >= 0:
                    return self._html(login_page_html('密码不对，再试一次。'), 401)
                return self._json({"ok": False, "error": "密码不对"}, 401)
            _LOGIN_FAILS.pop(ip, None)
            tok = new_session()
            print(f"[auth] 管理员已登录（{ip}）")
            if self.headers.get("Accept", "").find("text/html") >= 0:
                # 登录页表单提交：种 cookie 后跳进编辑器
                body_txt = ("<!DOCTYPE html><meta charset='utf-8'>"
                            f"<script>location.replace('{EDITOR_PATH}');</script>已登录，正在进入…")
                payload = body_txt.encode("utf-8")
                self.send_response(302)
                self._set_session_cookie(tok)
                self.send_header("Location", EDITOR_PATH)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                return self.wfile.write(payload)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            payload = json.dumps({"ok": True, "logged_in": True}, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._set_session_cookie(tok)
            self.end_headers()
            return self.wfile.write(payload)

        if self.path == "/api/logout":
            drop_session(self._cookies().get(SESSION_COOKIE))
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            payload = json.dumps({"ok": True, "logged_in": False}, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._set_session_cookie("", expired=True)
            self.end_headers()
            return self.wfile.write(payload)

        # ── 其它写接口：改工程/改连接/改采集范围都要管理员 ──
        # ⚠ /api/vars（写变量值）**不拦**：那就是 HMI 本身的动作 —— 现场的按钮、
        #   输入框、下拉框全靠它，客户本来就应该能用（只是不能改配置）。
        if AUTH_ENABLED and self.path in self.ADMIN_PATHS and not self._logged_in():
            print(f"[auth] 拒绝未登录的 {self.path}")
            return self._json({"ok": False, "need_login": True,
                               "error": "需要管理员登录（浏览器打开 /login）"}, 401)

        if self.path == "/api/vars":
            body = self._body()
            name, value = body.get("name"), body.get("value")
            if not isinstance(name, str) or not name:
                return self._json({"ok": False, "error": "missing name"}, 400)
            try:
                _source.write(name, value)
            except Exception as e:
                # 接真设备后地址写错/通信失败要能看见原因，而不是丢一个 500 栈给前端
                print(f"[error] 写变量失败 {name}={value!r}: {e}")
                return self._json({"ok": False, "error": str(e)}, 400)
            broadcast({"name": name, "value": value})
            print(f"[var] {name} = {value!r}")
            self._json({"ok": True})
        elif self.path == "/api/vars/reset":
            # 内部变量（内存模拟）恢复变量表初值；接了真设备就没这一步（别去盖 PLC）
            if not hasattr(_source, "reset"):
                return self._json({"ok": False, "error": "当前接的是真实设备，没有「恢复初值」——"
                                                          "要还原请直接改 PLC 里的值"}, 400)
            clear = bool((self._body() or {}).get("clear"))
            values = _source.reset(clear=clear)
            for k, v in values.items():
                broadcast({"name": k, "value": v})
            print(f"[var] {'清空' if clear else '恢复'}内部变量（{len(values)} 个）")
            self._json({"ok": True, "cleared": clear, "vars": values})
        elif self.path == "/api/update/apply":
            # 「立即更新」（要管理员，见 ADMIN_PATHS）：下载新版代码 → 只覆盖代码 → 重启。
            # ⚠ 这个响应发出去之后进程就退出了 —— 前端收到 ok 就要开始等它回来（见 updateCheck.js）
            info = self.server.server_address if getattr(self, "server", None) else ("127.0.0.1", 8866)
            self._json(apply_update(host=str(info[0]), port=int(info[1])))
        elif self.path == "/api/vars/declare":
            body = self._body()
            variables = body.get("variables") or []
            if not isinstance(variables, list):
                return self._json({"ok": False, "error": "variables must be a list"}, 400)
            # active：本页要采集的变量名（缺省 = 全部）；切页面时前端会重新发一次
            active = body.get("active", None)
            if active is not None and not isinstance(active, list):
                return self._json({"ok": False, "error": "active must be a list"}, 400)
            if hasattr(_source, "declare"):
                _source.declare(variables, active)
            st = _source_status()
            # blocks 要用「刚规划出来的」数：status 里那份是上一轮轮询留下的，会差一拍
            blocks = _source.plan_count() if hasattr(_source, "plan_count") else st.get("blocks")
            self._json({"ok": True, "vars": _source.read_all(),
                        "active": st.get("active"), "blocks": blocks, "scoped": st.get("scoped")})
        elif self.path == "/api/plc":
            body = self._body()
            action = (body.get("action") or "connect").lower()
            proto = _protocol_of(body)
            if action == "disconnect":
                return self._json({"ok": True, "status": plc_disconnect()})
            if action == "endpoints":
                # 只问「你是谁、开了哪些端点、接受哪种身份」——不需要建会话，
                # 所以匿名被拒/密码不对时照样能给出有用信息（连不上时的第一手排查）
                if proto == "opcua":
                    if opcua is None or not opcua.AVAILABLE:
                        why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
                        return self._json({"ok": False, "message": f"后端没有可用的 asyncua（{why}）"})
                    r = opcua.describe_endpoints(body.get("endpoint") or _plc_cfg.get("endpoint"))
                    print(f"[opcua] 端点诊断 {body.get('endpoint')}：{r.get('message') or r.get('advice', '').splitlines()[0] if r.get('advice') else ''}")
                    return self._json(r)
                return self._json({"ok": False, "message": "端点诊断只对 OPC UA 有意义（Modbus 直接看「测试连接」）"})
            if action == "test":
                if proto == "opcua":
                    if opcua is None or not opcua.AVAILABLE:
                        why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
                        return self._json({"ok": False, "message": f"后端没有可用的 asyncua（{why}）；"
                                                                    f"装：{getattr(opcua, 'INSTALL_HINT', '')}"})
                    okc, msg, info = opcua.probe(body.get("endpoint") or _plc_cfg.get("endpoint"),
                                                 body.get("security", "none"),
                                                 body.get("username", ""), body.get("password", ""))
                    print(f"[opcua] 测试连接 {body.get('endpoint')} → {'成功' if okc else '失败'}：{msg}")
                    return self._json({"ok": okc, "message": msg, "info": info})
                ip = body.get("ip") or _plc_cfg.get("ip")
                port = int(body.get("port") or _plc_cfg.get("port") or 502)
                unit = int(body.get("unit") or _plc_cfg.get("unit") or 1)
                addr = body.get("address") or "%MW0"
                okc, msg = modbus.probe(ip, port, unit, address=addr)
                print(f"[plc] 测试连接 {ip}:{port} → {'成功' if okc else '失败'}：{msg}")
                return self._json({"ok": okc, "message": msg})
            if action == "parse":
                # 前端变量表地址格/连接对话框的即时提示用：按协议解析地址
                if proto == "opcua":
                    if opcua is None:
                        return self._json({"ok": False, "message": "OPC UA 模块没加载"})
                    addr = body.get("address") or ""
                    try:
                        ns, kind, ident = opcua.split_node_id(addr, body.get("default_ns", opcua.DEFAULT_NS))
                        return self._json({"ok": True, "protocol": "opcua", "ns": ns, "kind": kind,
                                           "ident": ident, "nodeid": opcua.parse_node_id(addr),
                                           "describe": opcua.describe_node_id(addr)})
                    except ValueError as e:
                        return self._json({"ok": False, "message": str(e)})
                try:
                    a = modbus.parse_address(body.get("address") or "")
                    return self._json({"ok": True, "protocol": "modbus",
                                       "area": a.area, "area_cn": modbus.AREA_CN[a.area],
                                       "offset": a.offset, "words": a.words, "bit": a.bit, "byte": a.byte,
                                       "words_for_type": modbus.words_for(body.get("vtype") or "real", a.words)})
                except ValueError as e:
                    return self._json({"ok": False, "message": str(e)})
            if action == "orders":
                # 只读：同一个地址按 4 种字序各解一次，让现场一眼看出对方 PLC 是哪种
                if proto == "opcua":
                    return self._json({"ok": False,
                                       "message": "OPC UA 没有字序这回事（类型由服务器给，Float/Double 直接就是对的）"})
                addr = body.get("address") or "%MW0"
                vtype = body.get("vtype") or "real"
                length = body.get("length") or None
                try:
                    if isinstance(_source, PlcSource):
                        res = _source.order_candidates(addr, vtype, length)
                    else:
                        cli = modbus.ModbusTcpClient(body.get("ip") or _plc_cfg.get("ip"),
                                                     int(body.get("port") or _plc_cfg.get("port") or 502),
                                                     int(body.get("unit") or _plc_cfg.get("unit") or 1),
                                                     1.5)
                        cli.connect()
                        try:
                            res = cli.read_order_candidates(addr, vtype, length)
                        finally:
                            cli.close()
                except (ValueError, modbus.ModbusError, OSError) as e:
                    return self._json({"ok": False, "message": str(e)})
                print(f"[plc] 字序体检 {addr}（{vtype}）：字 = {res['words']}")
                return self._json({"ok": True, "address": addr, "vtype": vtype, **res})
            # 默认：连接（可同时带变量表，连上就开始轮询）
            keep = ("protocol", "ip", "port", "unit", "poll_ms", "word_order",
                    "endpoint", "security", "username", "password", "default_ns")
            cfg = {k: body.get(k, _plc_cfg.get(k)) for k in keep}
            cfg["protocol"] = proto
            if proto == "opcua":
                if opcua is None or not opcua.AVAILABLE:
                    why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
                    return self._json({"ok": False, "error": f"后端没有可用的 asyncua（{why}）—— 装："
                                                             f"{getattr(opcua, 'INSTALL_HINT', '')}"}, 400)
                cfg["endpoint"] = opcua.norm_endpoint(cfg.get("endpoint"))
            else:
                raw_order = cfg.get("word_order")
                if raw_order is not None and not modbus.order_ok(raw_order):
                    return self._json({"ok": False,
                                       "error": f"字序 {raw_order!r} 不认识，只能是 abcd / cdab / badc / dcba"}, 400)
                cfg["word_order"] = modbus.normalize_order(raw_order)
            if body.get("variables") is not None:
                variables = body.get("variables")
            else:
                variables = [{"name": k, "type": v["type"], "address": v["address"]}
                             for k, v in _source.meta().items()]
            try:
                st = plc_connect(cfg, variables)
            except ValueError as e:
                return self._json({"ok": False, "error": str(e)}, 400)
            if proto == "opcua":
                print(f"[opcua] 连接 {cfg['endpoint']}"
                      + (f"（用户 {cfg.get('username')}）" if cfg.get("username") else "（匿名）")
                      + f"，变量 {len(variables)} 个")
            else:
                print(f"[plc] 连接 {cfg['ip']}:{cfg['port']} 站号 {cfg['unit']}，字序 {cfg['word_order']}，"
                      f"变量 {len(variables)} 个")
            self._json({"ok": True, "status": st})
        elif self.path == "/api/opcua/parse-xml":
            # 离线导入：解析 CODESYS/Invtmatic 导出的「符号配置」XML（不连服务器）
            body = self._body()
            if opcua is None:
                return self._json({"ok": False, "message": "OPC UA 模块没加载"}, 400)
            res = opcua.parse_symbol_config_xml(
                body.get("xml") or "",
                device=body.get("device") or "", app=body.get("app") or "",
                ns=body.get("ns") or opcua.DEFAULT_NS,
                include_complex=bool(body.get("include_complex")))
            if res.get("ok"):
                print(f"[opcua] 解析符号配置 XML：{len(res['nodes'])} 个符号"
                      f"（设备 {res.get('device')}，应用 {res.get('app')}，ns={res.get('ns')}）")
            else:
                print(f"[opcua] 符号配置 XML 解析失败：{res.get('message')}")
            self._json(res)
        elif self.path == "/api/opcua/browse":
            # 「从 OPC UA 导入变量」：浏览节点树（只读）。已连着就用现成连接，没连就临时连一次
            body = self._body()
            if opcua is None or not opcua.AVAILABLE:
                why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
                return self._json({"ok": False, "message": f"后端没有可用的 asyncua（{why}）；"
                                                           f"装：{getattr(opcua, 'INSTALL_HINT', '')}"}, 400)
            ep = opcua.norm_endpoint(body.get("endpoint") or _plc_cfg.get("endpoint"))
            depth = max(0, min(10, int(body.get("depth") or 4)))
            max_nodes = max(1, min(20000, int(body.get("max_nodes") or 3000)))
            # 身份：调用方给了就用它的（空字符串 = 明确要匿名）；**没给**就用当前连接那套 ——
            # 老前端不带这两个字段，撞上「服务器不许匿名」就只会看到一句天书报错
            ua_user = body.get("username")
            ua_pass = body.get("password")
            if ua_user is None:
                ua_user = _plc_cfg.get("username", "")
            if ua_pass is None:
                ua_pass = _plc_cfg.get("password", "")
            args = dict(node_id=body.get("node_id") or "", depth=depth, max_nodes=max_nodes,
                        filter_text=body.get("filter_text") or "",
                        include_arrays=bool(body.get("include_arrays", True)),
                        only_app_symbols=bool(body.get("only_app_symbols", False)))
            src = _source
            if isinstance(src, OpcUaSource) and getattr(src, "online", False) and src.endpoint == ep:
                res = src.browse(**args)          # 复用常驻连接（省一次连接开销）
            else:
                res = opcua.browse(ep, security=body.get("security", "none"),
                                   username=ua_user, password=ua_pass,
                                   default_ns=body.get("default_ns", opcua.DEFAULT_NS), **args)
            print(f"[opcua] 浏览 {ep}：{res.get('message')}")
            self._json(res)
        elif self.path == "/api/project" and self.command == "POST":
            body = self._body()
            data = body.get("data")
            if not isinstance(data, dict) or "pages" not in data:
                return self._json({"ok": False, "error": "invalid project"}, 400)
            PROJECT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[project] 已保存 {PROJECT_FILE}")
            self._json({"ok": True})
        elif self.path == "/api/alarms":
            # 报警历史（运行记录）：存 server/data/alarm_history.json。
            # 三种写法，可同时给（顺序：先 clear，再 add，最后 patch）：
            #   {clear:true}            清空（现场"清空报警记录"按钮）
            #   {add:[记录,…]}          新报警 / 上次离线时本地攒下的记录（自动去重）
            #   {patch:[{key,at,endAt,acked}]}  补恢复时间 / 确认
            # 不加登录闸门：报警是运行页产生的，客户机上没人登录（同 /api/vars）。
            body = self._body()
            with _alarm_lock:
                items = _alarms_load()
                added, skipped, closed, patched = [], [], [], []
                if body.get("clear"):
                    items = []
                if isinstance(body.get("add"), list):
                    items, added, skipped, closed = _alarm_add(items, body["add"])
                if isinstance(body.get("patch"), list):
                    items, patched = _alarm_patch(items, body["patch"])
                items = _alarms_save(items)
                total = len(items)
            delta = {"add": added + closed, "patch": patched,
                     "clear": bool(body.get("clear"))}
            # 推给其它打开着的页面（另一个地址/另一个浏览器）：报警表立刻跟着更新，
            # 不用刷新才看见。收到的一侧按同一套规则去重，不会再回写（不成环）
            if added or closed or patched or body.get("clear"):
                broadcast({"alarm": delta})
            if added or skipped or patched or body.get("clear"):
                print(f"[alarm] 记录 +{len(added)}"
                      + (f"，同一次跳过 {len(skipped)}" if skipped else "")
                      + (f"，补恢复 {len(patched)}" if patched else "")
                      + (f"，补结束 {len(closed)}" if closed else "")
                      + f"（共 {total} 条）")
            self._json({"ok": True, "total": total, "added": len(added),
                        "skipped": skipped, "patched": patched, "closed": closed})
        else:
            # 未知 POST 路径：给一句明确的话。
            # ⚠ 别落到 super().do_POST()：SimpleHTTPRequestHandler 根本没有这个方法，
            #   会抛 AttributeError 把连接直接掐掉，前端只看到「fetch failed」，查无可查
            #   （后端忘了重启、新接口还没生效时就是这个现象）
            self._json({"ok": False, "error": f"后端不认识这个接口：{self.path}"
                                              f"（build {SERVER_BUILD}；改了后端代码要重启服务）"}, 404)

    # ── SSE ──
    def _sse(self):
        q = queue.Queue(maxsize=256)
        with _clients_lock:
            _clients.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self._cache_header_sent = True
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self._cors()
        self.end_headers()
        print(f"[sse] 客户端接入（在线 {len(_clients)}）")
        try:
            # 先推一帧全量
            self.wfile.write(b"event: hello\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")   # 心跳
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _clients_lock:
                if q in _clients:
                    _clients.remove(q)
            print(f"[sse] 客户端断开（在线 {len(_clients)}）")


# ─────────────────────────────────────────────
#  入口
# ─────────────────────────────────────────────
def main():
    global ALLOW_ANY_ORIGIN
    ap = argparse.ArgumentParser(description="HMI 组态设计器后端")
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
    args = ap.parse_args()
    ALLOW_ANY_ORIGIN = args.allow_any_origin

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

    global AUTH_ENABLED
    AUTH_ENABLED = not args.no_auth
    if AUTH_ENABLED:
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
    print("=" * 52)
    print(f"  HMI 组态设计器 · 后端服务已启动   版本 V{_v['version']}（{_v['date']} · build {SERVER_BUILD}）")
    print(f"  运行/编辑: {url}/        ← **就这一个地址**：客户打开就是运行画面（不用登录）")
    if AUTH_ENABLED:
        print(f"             登录后同一个地址给组态编辑器（改画面/变量/PLC 连接）")
        print(f"  登录     : {url}/login  （改密码：set_password.bat 新密码）")
    else:
        print("  登录闸门 : 已关（--no-auth）→ / 直接就是编辑器")
    print(f"  强制运行 : {url}/run     ← 登录状态下也想看运行画面时用")
    print(f"  监听     : {args.host}:{args.port}")
    print(f"  前端     : {ROOT}")
    print(f"  数据源   : {type(_source).__name__}（可替换为 Modbus/PLC）")
    print(f"  变量存   : {VARS_FILE}")
    print(f"  工程存   : {PROJECT_FILE}")
    print(f"  报警记录 : {ALARMS_FILE}")
    if not _is_local_host(args.host) and args.host != "127.0.0.1":
        print("  ⚠ 已监听非本机地址：局域网内任何机器都能访问，请确认现场网络可信")
    print("=" * 52)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url + RUN_PATH)).start()
    _autoconnect_saved_plc()      # 上次配好的设备：开机就自动连上（现场打开 /run 就有数据）
    # 版本检查预热：开机就在后台查一次（现场机连不上更新服务器时，这 4 秒超时也发生在后台线程里，
    # 不占启动时间）。这样前端打开页面时 /api/update/check 直接给缓存结果 —— 不用等一个来回
    threading.Thread(target=check_update, kwargs={"force": True},
                     name="update-check", daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _source.flush()   # 退出前把合并窗口里没落盘的变量写下去
        print("\n再见。")


if __name__ == "__main__":
    main()
