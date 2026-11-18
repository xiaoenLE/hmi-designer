#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""users.py — 多用户账号表（角色：admin / operator；viewer 只为老数据兼容）

现场口径（已收敛成两种角色）：

    admin     全权：改 PLC/工程/日志/FRP 配置、用户管理、配方管理、写变量
    operator  **只能改设备连接**（PLC / OPC UA 的连接与参数）；读画面不受限，
              但其它写操作一律拒 —— 写变量也不行

    viewer    **已取消**：只为老数据兼容。老的 users.json / 老会话里还是 viewer 的账号
              照旧能登录、且按"只读"处理；但新增账号/改角色不能再选 viewer（接口回 400），
              GET /api/users 的 roles 列表里也不再出现它。

存储：`<数据目录>/users.json`（**原子写**：先写 .tmp 再 replace，写坏只影响写那一下）

    {"users": {
        "zhangsan": {"pwd": "<盐>$<sha256(盐+密码)>", "role": "operator",
                     "enabled": true, "created": "YYYY-MM-DD HH:MM:SS"}
    }}

⚠ 密码**绝不存明文**：每个账号一个随机盐（16 字节 hex），`pwd` 存的是 `盐$sha256(盐+密码)`；
  连盐带哈希一起存，文件被别人看到也拿不到密码（这里的口径按任务要求是 sha256(盐+密码)，
  不是 auth.py 里内置管理员那套 PBKDF2 —— 两套各管各的，互不影响）。
⚠ 这个文件是**现场数据**（一台一份），不进版本库（.gitignore 里有 server/data/users.json）。
⚠ 内置管理员（/login 那个密码，见 auth.py）**不在这张表里**：账号表是额外身份，
  两套登录方式并存 —— 只给 password = 内置管理员；给 user + password = 账号。
⚠ 账号表损坏（JSON 坏了）→ 打一句 warn 当空表跑，**绝不因此起不来**（现场最重要）。
"""
from .paths import USERS_FILE

import hashlib
import hmac
import json
import secrets
import threading
import time

# 对外只有两种角色（新增账号/改角色只认这两个；顺序 = 权限从低到高）
ROLES = ("admin", "operator")

ROLE_CN = {"admin": "管理员", "operator": "操作员"}

# viewer：**已取消**，仅为老数据兼容（老 users.json / 老会话里还可能是它）。
# ⚠ 它不在 ROLES 里 → add / set_role 传 viewer 会被拒（400）；
#   但 _load 会把老数据里的 viewer 原样保留，verify() 出来仍是 viewer（闸门按只读处理）。
LEGACY_ROLES = ("viewer",)

_ALL_ROLES = ROLES + LEGACY_ROLES

PWD_MIN_LEN = 4          # 和内置管理员的 set_password 口径一致（至少 4 位）
NAME_MAX_LEN = 64

_SALT_BYTES = 16


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _new_salt() -> str:
    return secrets.token_hex(_SALT_BYTES)


def _hash_pwd(password: str, salt: str) -> str:
    """sha256(盐 + 密码) —— 盐是 hex 字符串的字节形式（与 pwd 字段里存的那段一致）"""
    return hashlib.sha256(bytes.fromhex(salt) + str(password).encode("utf-8")).hexdigest()


def _split_pwd(pwd: str):
    """'盐$哈希' → (盐, 哈希)；格式不对返回 ('', '')"""
    s = str(pwd or "")
    if "$" not in s:
        return "", ""
    salt, _, digest = s.partition("$")
    if not salt or not digest:
        return "", ""
    try:
        bytes.fromhex(salt)
    except ValueError:
        return "", ""
    return salt, digest


class UsersStore:
    """账号表的读写（线程安全：一把 RLock 管住内存表 + 落盘）。

    所有方法失败都抛 ValueError，**错误文案是给现场看的**（api.py 原样回给前端）。
    """

    def __init__(self, path=None):
        self.path = path if path is not None else USERS_FILE
        self._lock = threading.RLock()
        self._users = {}
        self._load()

    # ── 读写文件 ──
    def _load(self):
        try:
            if not self.path.exists():
                self._users = {}
                return
            d = json.loads(self.path.read_text(encoding="utf-8"))
            raw = d.get("users") if isinstance(d, dict) else None
            if not isinstance(raw, dict):
                raise ValueError("users.json 里没有 users 表")
            users = {}
            for name, rec in raw.items():
                if not isinstance(rec, dict) or not isinstance(name, str) or not name:
                    continue
                pwd = str(rec.get("pwd") or "")
                if not _split_pwd(pwd)[0]:
                    continue                       # 没有合法 pwd 的条目丢掉（坏档案不扩散）
                users[name] = {
                    "pwd": pwd,
                    # 老数据里的 viewer 要原样留着（只读）；认不出的脏值也当 viewer（最保守）
                    "role": rec.get("role") if rec.get("role") in _ALL_ROLES else "viewer",
                    "enabled": bool(rec.get("enabled", True)),
                    "created": str(rec.get("created") or _now()),
                }
            self._users = users
        except Exception as e:                                  # noqa: BLE001
            print(f"[warn] 账号表读不了（{type(e).__name__}: {e}）→ 先按空表跑：{self.path}")
            self._users = {}

    def _save_locked(self):
        """原子写（先 .tmp 再 replace）：写一半断电也不会留下半个 JSON"""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({"users": self._users}, ensure_ascii=False, indent=2)
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(self.path)
        except OSError as e:
            print(f"[warn] 账号表落盘失败：{e}（本次改动只在内存里，重启会丢）")
            raise ValueError(f"账号表保存失败：{e}") from None

    # ── 查询 ──
    def list(self) -> list:
        """所有账号（按用户名排序）；**绝不返回密码/盐/哈希**。"""
        with self._lock:
            out = []
            for name in sorted(self._users):
                rec = self._users[name]
                out.append({"name": name, "role": rec.get("role", "viewer"),
                            "enabled": bool(rec.get("enabled", True)),
                            "created": rec.get("created", "")})
            return out

    def count(self) -> int:
        with self._lock:
            return len(self._users)

    def get(self, user) -> dict | None:
        """单个账号的公开信息（不含密码）；不存在 → None"""
        name = str(user or "").strip()
        with self._lock:
            rec = self._users.get(name)
            if not rec:
                return None
            return {"name": name, "role": rec.get("role", "viewer"),
                    "enabled": bool(rec.get("enabled", True)),
                    "created": rec.get("created", "")}

    def roles(self) -> dict:
        """角色 → 中文名（前端/接口给提示用）"""
        return dict(ROLE_CN)

    # ── 校验 ──
    @staticmethod
    def _check_name(user) -> str:
        name = str(user or "").strip()
        if not name:
            raise ValueError("用户名不能为空")
        if len(name) > NAME_MAX_LEN:
            raise ValueError(f"用户名太长（最多 {NAME_MAX_LEN} 个字符）")
        if any(c.isspace() for c in name):
            raise ValueError("用户名里不能有空格")
        if any(ord(c) < 32 for c in name):
            raise ValueError("用户名里有非法字符")
        return name

    @staticmethod
    def _check_pwd(pwd) -> str:
        s = str(pwd if pwd is not None else "")
        if not s:
            raise ValueError("密码不能为空")
        if len(s) < PWD_MIN_LEN:
            raise ValueError(f"密码太短（至少 {PWD_MIN_LEN} 位）")
        return s

    @staticmethod
    def _check_role(role, default: str = "operator") -> str:
        r = str(role or default).strip().lower()
        if r not in ROLES:
            raise ValueError(f"角色只能是：{' / '.join(ROLES)}（收到 {role!r}；观察员已取消）")
        return r

    def _require_locked(self, name: str) -> dict:
        rec = self._users.get(name)
        if not rec:
            raise ValueError(f"用户不存在：{name}")
        return rec

    def _enabled_admins_locked(self, exclude: str = "") -> list:
        return [n for n, r in self._users.items()
                if n != exclude and r.get("role") == "admin" and r.get("enabled")]

    def _guard_last_admin_locked(self, name: str, new_role=None, new_enabled=None):
        """不许把「最后一个启用中的 admin」删掉/降级/禁掉 —— 否则再也没人能管理了。

        注意只数**账号表里**的管理员；内置管理员（/login 那个密码）不算在内：
        它的密码在 auth.json，谁都能用，所以账号表里一个 admin 都没有时也不会锁死。
        但账号表里有 admin 时，把它删空就等于"账号体系废了"，还是挡一下。
        """
        rec = self._users.get(name)
        if not rec or rec.get("role") != "admin" or not rec.get("enabled"):
            return
        becoming_not_admin = (new_role is not None and new_role != "admin")
        becoming_disabled = (new_enabled is False)
        if not (becoming_not_admin or becoming_disabled):
            return
        if not self._enabled_admins_locked(exclude=name):
            raise ValueError("不能删除/降级/禁用最后一个管理员（会没人能管理账号）")

    # ── 账号维护 ──
    def add(self, user, pwd, role="operator") -> dict:
        name = self._check_name(user)
        password = self._check_pwd(pwd)
        r = self._check_role(role)
        salt = _new_salt()
        with self._lock:
            if name in self._users:
                raise ValueError(f"用户已存在：{name}")
            self._users[name] = {"pwd": f"{salt}${_hash_pwd(password, salt)}", "role": r,
                                 "enabled": True, "created": _now()}
            self._save_locked()
            return {"name": name, "role": r, "enabled": True,
                    "created": self._users[name]["created"]}

    def set_password(self, user, pwd) -> dict:
        name = self._check_name(user)
        password = self._check_pwd(pwd)
        with self._lock:
            rec = self._require_locked(name)
            salt = _new_salt()
            rec["pwd"] = f"{salt}${_hash_pwd(password, salt)}"
            self._save_locked()
            return {"name": name, "role": rec.get("role", "viewer"),
                    "enabled": bool(rec.get("enabled", True)), "created": rec.get("created", "")}

    def set_role(self, user, role) -> dict:
        name = self._check_name(user)
        r = self._check_role(role)
        with self._lock:
            rec = self._require_locked(name)
            self._guard_last_admin_locked(name, new_role=r)
            rec["role"] = r
            self._save_locked()
            return {"name": name, "role": r, "enabled": bool(rec.get("enabled", True)),
                    "created": rec.get("created", "")}

    def set_enabled(self, user, enabled) -> dict:
        name = self._check_name(user)
        rec_enabled = bool(enabled)
        with self._lock:
            rec = self._require_locked(name)
            self._guard_last_admin_locked(name, new_enabled=rec_enabled)
            rec["enabled"] = rec_enabled
            self._save_locked()
            return {"name": name, "role": rec.get("role", "viewer"), "enabled": rec_enabled,
                    "created": rec.get("created", "")}

    def delete(self, user) -> bool:
        """删账号；不存在 → False（幂等，和配方删除一个口径）。最后一个管理员 → ValueError"""
        name = self._check_name(user)
        with self._lock:
            if name not in self._users:
                return False
            self._guard_last_admin_locked(name, new_role="")
            del self._users[name]
            self._save_locked()
            return True

    # ── 登录校验 ──
    def verify(self, user, pwd):
        """账号 + 密码 → 角色；**不存在 / 密码错 / 禁用 → None**（调用方不要区分，免得枚举账号）"""
        name = str(user or "").strip()
        if not name:
            return None
        with self._lock:
            rec = self._users.get(name)
            if not rec or not rec.get("enabled", True):
                return None
            salt, want = _split_pwd(rec.get("pwd", ""))
            if not salt or not want:
                return None
            try:
                got = _hash_pwd(str(pwd if pwd is not None else ""), salt)
            except Exception:                                   # noqa: BLE001
                return None
            return rec.get("role") if hmac.compare_digest(got, want) else None


# 全后端共用一份（api.py / wsbridge.py / server.py 都读它）
STORE = UsersStore()
