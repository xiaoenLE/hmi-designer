#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""auth.py — 管理员口令、会话、登录限流

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

⚠ `AUTH_ENABLED` 是**会被改的**（命令行 --no-auth 会关掉它）：
别的模块要用 `auth.AUTH_ENABLED` 读，不能 `from .auth import AUTH_ENABLED`
—— 那样拿到的是导入那一刻的副本，改了看不见（表现是「--no-auth 没生效」）。
"""

from .paths import AUTH_FILE
from .paths import SESSIONS_FILE

import hashlib
import hmac
import json
import secrets
import threading
import time


# 登录闸门：默认开 —— 「/run 给现场随便看，改东西（编辑器、PLC 配置、工程存档）要管理员登录」。
# --no-auth 关掉（本机开发/自动化测试用）。
AUTH_ENABLED = True

DEFAULT_PASSWORD = "admin123"    # 首次启动自动创建，控制台会提醒改

SESSION_TTL = 12 * 3600          # 登录有效期（12 小时，够上一个班）

SESSION_COOKIE = "hmi_sess"

_SESSIONS = {}                   # {token 的 sha256: {"exp": 过期时间戳, "user": 用户名, "role": 角色}}
                                 # ⚠ 老版本（V2.0.10 及以前）这里存的是裸 float 过期时间戳，
                                 #   load_sessions / session_claims 都兼容那种老格式（按管理员算）。

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



def _session_rec(v) -> dict:
    """会话记录归一化：新格式是 dict，老格式（裸 float）= 过期时间戳 + 管理员。

    ⚠ 升级兼容：老 sessions.json 里没有角色字段，那些人当时是用**管理员密码**登录的，
      所以老会话一律按 admin 算；否则升上来的机器会突然"有登录态但什么都干不了"。
    """
    if isinstance(v, dict):
        try:
            exp = float(v.get("exp") or 0)
        except (TypeError, ValueError):
            exp = 0.0
        user = str(v.get("user") or "")
        role = str(v.get("role") or "admin")
        return {"exp": exp, "user": user, "role": role}
    try:
        return {"exp": float(v or 0), "user": "", "role": "admin"}
    except (TypeError, ValueError):
        return {"exp": 0.0, "user": "", "role": "admin"}



def _save_sessions():
    try:
        tmp = SESSIONS_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_SESSIONS), encoding="utf-8")
        tmp.replace(SESSIONS_FILE)          # 原子写：别把文件写坏
    except Exception as e:                                      # noqa: BLE001
        print(f"[warn] 会话落盘失败（不影响当前登录）：{e}")



def load_sessions():
    """启动时把没过期的会话读回来 —— 否则「关掉窗口/重启后端就要重新登录」，
    现场（尤其 pywebview 窗口客户端，每次启动都是新进程）最烦这个。
    每条会话带着 {user, role}（见 _session_rec 对老格式的兼容）。"""
    global _SESSIONS
    try:
        if SESSIONS_FILE.exists():
            d = json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
            now = time.time()
            _SESSIONS = {k: rec for k, v in d.items()
                         if (rec := _session_rec(v))["exp"] > now}
    except Exception:                                           # noqa: BLE001
        _SESSIONS = {}



def new_session(user: str = "", role: str = "admin") -> str:
    """建一条会话（12 小时）。user/role 跟着 token 一起落盘 —— 重启后
    「刷新页面/重连」不仅知道登录过，还知道是**哪个账号、什么角色**。"""
    tok = secrets.token_urlsafe(24)
    with _SESS_LOCK:
        now = time.time()
        for k, rec in list(_SESSIONS.items()):      # 顺手清掉过期的，别让文件一直涨
            if _session_rec(rec)["exp"] < now:
                _SESSIONS.pop(k, None)
        _SESSIONS[_tok_key(tok)] = {"exp": now + SESSION_TTL,
                                    "user": str(user or ""), "role": str(role or "admin")}
        _save_sessions()
    return tok



def drop_session(tok: str):
    with _SESS_LOCK:
        if _SESSIONS.pop(_tok_key(tok), None) is not None:
            _save_sessions()



def session_claims(tok: str) -> dict:
    """token → {user, role, exp}；没登录/过期 → {}（空 dict，调用方按"未登录"处理）。"""
    if not tok:
        return {}
    key = _tok_key(tok)
    with _SESS_LOCK:
        rec = _session_rec(_SESSIONS.get(key)) if key in _SESSIONS else None
    if not rec:
        return {}
    if rec["exp"] < time.time():
        drop_session(tok)
        return {}
    return rec



def session_ok(tok: str) -> bool:
    return bool(session_claims(tok))



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
