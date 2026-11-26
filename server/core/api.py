#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""api.py — 后端所有接口的**唯一实现**

★ V2 起 HTTP 不再提供任何接口：这些实现只由长连接调用
  （前端发 `{t:'call', path:'/api/xxx', method, body}` → core/wsbridge.py → 这里）。

为什么是"纯函数"而不是塞在 HTTP 处理器的方法里
----------------------------------------------
1.x 这些逻辑写在 `do_GET`/`do_POST` 里，于是"能不能在长连接上用"变成了
"要不要再抄一份" —— 抄一份迟早两边行为不一致（现场最难查的就是这个）。

现在统一成：`dispatch(method, path, query, body, ctx) -> (status, payload)`，
不碰 socket、不碰 `self`，谁调都一样。因此：
  · 长连接上的一次调用与以前一次 HTTP 请求**返回同一个东西**（同样的状态码、同样的
    错误文案）—— 现场那句「地址无效 / 从站异常 / 需要管理员登录」一个字都没变；
  · 想加接口只改这一个文件；
  · 测试也能直接 import 它调（不必先起一个 HTTP 服务）。

登录/注销/会话**不在这里**：它们本来就是"这条连接的登录态"，
由 core/wsbridge.py 用 `{t:'login'|'logout'|'session'}` 原生处理（见那里的说明）。
"""
from . import ai                      # AI 助手（配置 + 连通性测试，见 core/ai.py）
from . import auth
from . import operations
from . import datasource
from .alarmstore import _alarm_add
from .alarmstore import _alarm_lock
from .alarmstore import _alarm_patch
from .alarmstore import _alarms_load
from .alarmstore import _alarms_save
from .applog import _log_prune
from .datasource import _source_status
from .datasource import plc_connect
from .datasource import plc_disconnect
from . import frp                      # FRP 内网穿透（内置 frpc 客户端，见 core/frp.py）
from .opcualib import opcua
from .paths import PROJECT_FILE
from .projectfile import read_project_file
from .projectfile import write_project_file
from .paths import SETTINGS_FILE
from .plcsource import OpcUaSource
from .plcsource import PlcSource
from .plcsource import _plc_cfg
from .plcsource import _norm_protocol_name
from .plcsource import _addr_model_lock
from .plcsource import _protocol_of
from .recipe import _recipes          # 配方（现场数据：配方名 + 变量值，见 core/recipe.py）
from .recipe import RecipeConflict, recipe_value
from .history import _history         # 历史数据（采样/查询/CSV，见 core/history.py）
from .users import ROLES as USER_ROLES       # 多用户/角色（账号表，见 core/users.py）
from .users import ROLE_CN as USER_ROLE_CN
from .users import STORE as USERS
from .broadcast import broadcast
from .scriptlog import SCRIPTLOG_MAX_BODY
from .scriptlog import scriptlog_read
from .scriptlog import scriptlog_write
from .settings import SCRIPTLOG_MAX_MB_DEFAULT
from .settings import SCRIPTLOG_MAX_MB_HARD
from .settings import _LOG_KEEP_DEFAULT
from .settings import _LOG_KEEP_ENV
from .settings import _LOG_KEEP_MAX
from .settings import _LOG_KEEP_MIN
from .settings import _SCRIPTLOG_MAX_MB_ENV
from .settings import _clamp_float
from .settings import _clamp_int
from .settings import _settings_load
from .settings import _settings_save
from .settings import log_keep_days
from .settings import log_usage
from .settings import scriptlog_max_mb
from .updateapply import apply_update
from .varapi import read_all_vars
from .varapi import var_declare
from .varapi import var_write
from .versioninfo import SERVER_BUILD
from .versioninfo import check_update

import json
import re
import comm                       # 同目录：通讯协议注册表 + 地址校验（server/comm/，可扩展）
import modbus                     # 同目录：Modbus TCP 主站 + %MW/%MD 地址解析

# 改配置 = 要**管理员**（角色 admin）。
# ⚠ **设备连接配置不再要登录**（2.1.4 现场口径）：`/api/plc`（PLC 连接/参数/测试/字序体检）
#   与 `/api/opcua/browse|parse-xml`（OPC UA 浏览导入）在客户机运行页按 Ctrl+Shift+L
#   就能直接打开对话框改、改完立即生效 —— 现场不习惯在运行画面上敲管理员密码。
# ⚠ **「立即更新」也不设闸门**（2.1.6 现场口径）：客户机运行画面右下角那个「⬆ 新版本」
#   徽标，点「立即更新」就是日常运维动作（只换 app 层代码、不动现场数据），不该先让人登录。
#   要管理员的是"改配置"这类会改工程/账号/口令的操作。
#   边界：工程、日志设置、FRP、账号、配方仍然是管理员（见 ADMIN_PATHS）。
# ⚠ 不含 /api/vars 与 /api/vars/declare：没登录的客户机运行页照旧能写/下发采集范围
#   （现场既有规矩）；但**登录成操作员/观察员之后写变量会被拒**（见 _deny_write）。
# ⚠ 配方整块（save/delete/**apply**）都是配置类 → 要管理员（进 ADMIN_PATHS）。
# ⚠ AI 配置（/api/ai/config、/api/ai/test）也是配置类：里面有 API Key，
#   而且 GET 就会回掩码后的 key —— 读写都只让管理员（进 ADMIN_PATHS）。
ADMIN_PATHS = ("/api/project", "/api/vars/reset", "/api/logsettings", "/api/frp",
               "/api/users", "/api/recipes", "/api/ai/config", "/api/ai/test")

# 设备连接配置（PLC 连接 / OPC UA 浏览导入）：**不设登录闸门**（见上面的现场口径）。
# 留着这个名字是给 dispatch 的注释、前端/测试引用：改这一块不用登录，改别的配置要 admin。
# 2.1.8 起通讯协议做成了注册表（server/comm/）：`/api/comm/protocols`（协议目录）和
# `/api/comm/validate`（地址校验）和它俩一样是设备配置，不登录也能调（运行页变量表用）。
DEVICE_PATHS = ("/api/plc", "/api/opcua/parse-xml", "/api/opcua/browse",
                "/api/comm/protocols", "/api/comm/validate")


class Ctx:
    """一次接口调用的上下文（登录态 + 客户端地址 + 这台服务的地址）。

    调用方（长连接）持有它：`authed` 是这条连接的登录态，`role` 是这个登录账号的角色
    （admin / operator / viewer；空 = 没登录）。老会话没有角色字段 → 按管理员算（升级兼容）。
    `server_host/port` 只给「立即更新」用 —— 它要告诉重启助手"新实例该在哪个端口上起来"。
    """

    __slots__ = ("authed", "role", "user", "client_ip", "server_host", "server_port",
                 "token", "clear_token")

    def __init__(self, authed: bool = False, client_ip: str = "-",
                 server_host: str = "127.0.0.1", server_port: int = 8866,
                 role: str = "", user: str = ""):
        self.authed = bool(authed)
        self.role = str(role or "")        # '' = 没登录 / 老会话（按管理员算，见 _ctx_role）
        self.user = str(user or "")
        self.client_ip = client_ip or "-"
        self.server_host = server_host or "127.0.0.1"
        self.server_port = int(server_port or 8866)
        self.token = None          # 登录成功时填：调用方把会话给前端带上
        self.clear_token = False   # 注销时置上：调用方把会话清掉


# ── 角色（与 core/users.py 的 ROLES 对齐；数字越大权限越高）──
# ⚠ viewer 已取消（只剩 admin / operator），但它仍出现在**老会话/老账号**里：
#   闸门照旧按"只读"处理它（rank 最低），只是新增/改角色不能再选它。
ROLE_ADMIN, ROLE_OPERATOR, ROLE_VIEWER = "admin", "operator", "viewer"

ROLE_RANK = {ROLE_VIEWER: 1, ROLE_OPERATOR: 2, ROLE_ADMIN: 3}

# 提示文案用的全量中文名（含已取消的 viewer：老会话还会带着它）
ROLE_CN_ALL = {"admin": "管理员", "operator": "操作员", "viewer": "观察员"}


def _ctx_role(ctx: Ctx) -> str:
    """当前调用者的角色；'' = 没登录。

    ⚠ 老会话（升级前的 sessions.json）没有 role 字段，那些人是用**管理员密码**登录的
      → 一律按 admin 算，否则升级上来现场会突然"有登录态但什么都改不了"。
    """
    if not ctx.authed:
        return ""
    role = str(getattr(ctx, "role", "") or "").lower()
    return role if role in ROLE_RANK else ROLE_ADMIN


def _ctx_user(ctx: Ctx) -> str:
    return str(getattr(ctx, "user", "") or "")


_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _is_day(text) -> bool:
    """'YYYY-MM-DD' 才算一天（操作记录这类按天查询的入参校验）。"""
    return bool(_DAY_RE.match(str(text or "")))


def _is_admin(ctx: Ctx) -> bool:
    """管理员（或 --no-auth 没开闸门）—— 判断"改配置/管账号"用"""
    if not auth.AUTH_ENABLED:
        return True
    return _ctx_role(ctx) == ROLE_ADMIN


def _need_role(ctx: Ctx, min_role: str, what: str):
    """权限闸门：没登录 → 401（need_login=true，前端弹登录）；角色不够 → 403。

    返回 (status, payload) 或 None（None = 放行）。
    """
    if not auth.AUTH_ENABLED:
        return None
    role = _ctx_role(ctx)
    if not role:
        return 401, {"ok": False, "need_login": True,
                     "error": f"{what}需要管理员登录（在页面上按 Ctrl+Shift+E，或打开 /login 登录）"}
    if ROLE_RANK.get(role, 0) < ROLE_RANK.get(min_role, 99):
        cn = ROLE_CN_ALL.get(role, role)
        need = ROLE_CN_ALL.get(min_role, min_role)
        return 403, {"ok": False, "need_login": False, "role": role,
                     "error": f"当前账号（{cn}）没有权限：{what}需要{need}"}
    return None


def _need_login(ctx: Ctx, what: str = "这个操作"):
    """要**管理员**（ADMIN_PATHS / 配置类操作）。

    ⚠ 1.x 里这里只判断"登录过"；V2 有角色之后"登录过 ≠ 有权限"——
      操作员/观察员登录了也不能改配置，所以闸门升级成"必须是 admin"。
    """
    return _need_role(ctx, ROLE_ADMIN, what)


# 写变量被拒时按角色给一句人话
_WRITE_DENY = {
    ROLE_OPERATOR: "当前账号（操作员）只能改设备连接，不能{what}",
    ROLE_VIEWER: "当前账号（观察员）只能看，不能{what}",
}


def _deny_write(ctx: Ctx, what: str = "写变量"):
    """**登录成操作员/观察员之后不能写变量**（这次现场口径：操作员只能改设备连接）。

    ⚠ 没登录的客户机运行页照旧能写（现场既有规矩，/api/vars 本来就不在 ADMIN_PATHS 里）；
      管理员当然能写。viewer 是已取消角色，但老会话还可能是它 → 仍按只读挡。
    """
    if not auth.AUTH_ENABLED:
        return None
    role = _ctx_role(ctx)
    if role in _WRITE_DENY:
        return 403, {"ok": False, "need_login": False, "role": role,
                     "error": _WRITE_DENY[role].format(what=what)}
    return None


def dispatch(method: str, path: str, query: dict, body: dict, ctx: Ctx):
    """跑一个接口 → (status:int, payload:dict)

    path  已经去掉 query 的路径（如 '/api/plc'）
    query parse_qs 出来的字典（如 {'force': ['1']}）
    body  已解析的请求体（GET 给 {}）
    """
    body = body if isinstance(body, dict) else {}
    q1 = lambda k, d="": (query.get(k) or [d])[0]        # noqa: E731  取 query 里的单值

    # ⚠ 只放行 /api/* ：页面（/、/run、/login）和静态文件必须走真的 HTTP ——
    #   长连接不是文件传输，拿它取 index.html 只会得到一句莫名其妙的 404。
    if not path.startswith("/api/"):
        return 403, {"ok": False,
                     "error": f"长连接只用来调 /api/* 接口（页面与静态文件走 HTTP）：{path}"}

    # ───────────────────────── 读接口 ─────────────────────────
    if path == "/api/plc" and method == "GET":
        # 设备连接配置**不设闸门**（现场运行页要能改连接），口令一并给：
        # 对话框里口令留空再点「确定」= 清空口令（POST 体里带 password:""），
        # 所以在客户机上也必须把上次配好的口令带回来，否则改个 IP 就把口令清掉了。
        return 200, {"ok": True, "config": dict(_plc_cfg), "status": _source_status()}

    if path == "/api/comm/protocols" and method == "GET":
        # 通讯协议目录（注册表）：前端「PLC」页的协议下拉 + 地址格式提示/示例全部来自这里。
        # 顺序固定 modbus → ts600 → opcua（见 server/comm/__init__.py 的 _ORDER）。
        return 200, _ep_comm_protocols()

    if path == "/api/vars" and method == "GET":
        return 200, {"vars": read_all_vars(), "meta": datasource.get_source().meta()}

    if path == "/api/project" and method == "GET":
        return 200, {"ok": True, "data": read_project_file()}

    if path == "/api/alarms" and method == "GET":
        # 报警历史（运行记录）：运行页要读它，**不用登录**
        with _alarm_lock:
            items = _alarms_load()
        return 200, {"ok": True, "history": items, "total": len(items)}

    if path == "/api/scriptlog" and method == "GET":
        # ?date=YYYY-MM-DD 看哪天（默认今天）、?limit=N 最多几行（默认 300，上限 2000）
        try:
            lim = int(q1("limit", "300"))
        except ValueError:
            lim = 300
        return 200, scriptlog_read(q1("date", ""), lim)

    if path == "/api/logsettings" and method == "GET":
        # 日志设置（这台机器的：保留天数 / 脚本日志每天上限）。
        # 要管理员：它决定这台机器留多少日志、占多少盘（GET 也一样，免得客户机看出来）
        deny = _need_login(ctx, "看日志设置")
        if deny:
            return deny
        return 200, {"ok": True, "keep_days": log_keep_days(),
                     "scriptlog_max_mb": scriptlog_max_mb(),
                     "limits": {"keep_days": [_LOG_KEEP_MIN, _LOG_KEEP_MAX],
                                "scriptlog_max_mb": [0.5, SCRIPTLOG_MAX_MB_HARD]},
                     "fallback": {"keep_days": _LOG_KEEP_ENV,
                                  "scriptlog_max_mb": _SCRIPTLOG_MAX_MB_ENV},
                     "saved": _settings_load(),      # 界面上设过什么（空 = 还没设过）
                     "usage": log_usage(), "file": str(SETTINGS_FILE)}

    if path == "/api/update/check":
        # 有没有新版本（只读，不用登录：编辑器自己的状态栏要用）。
        # ?force=1 = 「检查更新」按钮：忽略缓存当场再拉一次（仍受最小间隔限制）。
        # 拉不到远端不报错，结果里给 error —— 现场没外网是常态
        force = str(q1("force", "0")).lower() in ("1", "true", "yes")
        return 200, check_update(force=force)

    if path == "/api/recipes" and method == "GET":
        if q1("summary", "") == "1":
            return 200, {"ok": True, "rows": _recipes.summary()}
        name = str(q1("name", "")).strip()
        if name:
            recipe = _recipes.get(name)
            if recipe is None:
                return 404, {"ok": False, "error": f"没有这个配方：{name}"}
            return 200, {"ok": True, "recipe": recipe}
        # 配方列表（运行页/编辑器都要看）：**读不用登录**；存/删/应用才要管理员。
        # ?full=1 = 连每个配方的 vars 一起给（界面一次拿全，省得逐个取）。
        full = str(q1("full", "0")).lower() in ("1", "true", "yes")
        out = {"ok": True, "names": _recipes.list_names(), "count": _recipes.count()}
        if full:
            out["recipes"] = _recipes.snapshot()
        return 200, out

    if path == "/api/operations" and method == "GET":
        deny = _need_login(ctx, "查看操作记录")
        if deny:
            return deny
        day = str(q1("date", "") or "").strip()
        if day and not _is_day(day):
            return 400, {"ok": False, "error": "日期格式应为 YYYY-MM-DD"}
        try:
            return 200, {"ok": True, **operations.recent(
                q1("limit", "200"), day or None, offset=q1("offset", "0"),
                query=str(q1("q", ""))[:360], actions=query.get("action", []),
                results=[value == "1" for value in query.get("result", []) if value in ("0", "1")],
            )}
        except OSError:
            return 500, {"ok": False, "error": "读取操作记录失败"}

    if path == "/api/operations/button" and method == "POST":
        name = str((body or {}).get("name") or "").strip()[:200]
        if not name:
            return 400, {"ok": False, "error": "缺少按钮名称"}
        text = str((body or {}).get("text") or "").strip()[:360]
        if not operations.record(_ctx_user(ctx), "button", name, True, text):
            return 500, {"ok": False, "error": "保存操作记录失败"}
        return 200, {"ok": True}

    if path == "/api/operations/page" and method == "POST":
        # 运行画面切换的留痕：谁把画面切到了哪一页（运行态用户可能没登录，所以**不设闸门**，
        # 只接一个页面名，写完就返回 —— 读记录仍然只给管理员）。
        name = str((body or {}).get("name") or "").strip()[:80]
        if not name:
            return 400, {"ok": False, "error": "缺少页面名"}
        operations.record(_ctx_user(ctx), "page", name, True, f"切到「{name}」")
        return 200, {"ok": True}

    if path == "/api/operations/clear" and method == "POST":
        # 清空操作记录 = 删审计存档，只给管理员（和查看操作记录同一道闸）
        deny = _need_login(ctx, "清空操作记录")
        if deny:
            return deny
        day = str((body or {}).get("date") or "").strip()
        if day and not _is_day(day):
            return 400, {"ok": False, "error": "日期格式应为 YYYY-MM-DD"}
        try:
            removed = operations.clear(day or None)
        except OSError:
            return 500, {"ok": False, "error": "清空操作记录失败"}
        # 清空本身也记一笔：谁清的、清的是哪一天、删了多少条（审计留痕）
        operations.record(_ctx_user(ctx), "clear", day or "全部", True, f"清除 {removed} 条")
        return 200, {"ok": True, "removed": removed}

    if path == "/api/history" and method == "GET":
        # 历史数据：不带 from/to/vars = 现状（配置 + 统计）；带了 = 查采样点。
        # **读不用登录**（运行页/报表要看）；改采样设置才要管理员（见 _ep_history）。
        if any(k in query for k in ("from", "to", "vars")):
            frm, to = _history.normalize_range(q1("from", ""), q1("to", ""))
            return 200, {"ok": True, **_history.query(frm, to, _query_vars(query))}
        return 200, {"ok": True, "settings": _history.settings(), "stats": _history.stats()}

    if path == "/api/history/export.csv" and method == "GET":
        # 导出 CSV。V2 没有 HTTP 接口可以真下载：WS 通道回来后端给 {ok, csv, filename}，
        # 前端拿到字符串再落盘（filename 已经带时间范围，一次导好几段不会重名）。
        frm, to = _history.normalize_range(q1("from", ""), q1("to", ""))
        q = _history.query(frm, to, _query_vars(query))
        return 200, {"ok": True, "csv": _history.csv_from_query(q),
                     "filename": _history.csv_filename(frm, to),
                     "from": frm, "to": to, "count": q["count"], "truncated": q["truncated"]}

    # ───────────────────────── 用户/角色管理（只有管理员） ─────────────────────────
    if path == "/api/users":
        deny = _need_login(ctx, "用户管理")
        if deny:
            print(f"[auth] 拒绝 {_ctx_user(ctx) or '未登录'}（{_ctx_role(ctx) or '-'}）访问 {path}")
            return deny
        if method == "GET":
            return 200, {"ok": True, "users": USERS.list(), "count": USERS.count(),
                         "roles": list(USER_ROLES), "role_cn": dict(USER_ROLE_CN)}
        if method != "POST":
            return 405, {"ok": False, "error": f"用户管理只认 GET / POST（收到 {method}）"}
        return _ep_users(body)

    # ───────────────────────── 写接口 ─────────────────────────
    # 不设闸门的两个日常运维动作：
    #   · 设备连接（DEVICE_PATHS）：运行页 Ctrl+Shift+L 直接改连接信息（现场口径 2.1.4），
    #     改完立即生效、不用登录；
    #   · 「立即更新」（/api/update/apply）：运行画面右下角徽标一点就更新（现场口径 2.1.6），
    #     也不用登录。
    # 其余配置类接口（ADMIN_PATHS）仍要管理员。

    if path in ADMIN_PATHS:
        deny = _need_login(ctx, "改这个配置")
        if deny:
            print(f"[auth] 拒绝 {_ctx_user(ctx) or '未登录'}（{_ctx_role(ctx) or '-'}）访问 {path}")
            return deny

    # ───────────────────────── AI 助手（只有管理员，见 ADMIN_PATHS） ─────────────────────────
    # 实现在 core/ai.py：/api/ai/config 读写 ai.json（key 只写、读回掩码），
    # /api/ai/test 用**已存配置**打一次模型测连通性。
    # 真正的对话不走这儿：它必须流式，走长连接 `{t:'ai', op:'chat'}`（见 wsbridge.py）。
    if path == "/api/ai/config":
        return ai.ep_config(method, body)

    if path == "/api/ai/test":
        return ai.ep_test(body)

    if path == "/api/vars" and method == "POST":
        # 操作员/观察员写变量一律拒（操作员这次也收紧了：只能改设备连接）；
        # 没登录的客户机运行页照旧能写，见 _deny_write
        deny = _deny_write(ctx, "写变量")
        if deny:
            return deny
        # 逻辑全在 var_write 里（长连接的热路径走的是同一个函数）——
        # 这里只是把它翻译成状态码：失败 400 + 原因，成功 200。
        # `from='script'` = 脚本发起的写：脚本可能每 100ms 写一次，那行 `[var] …`
        # 会把 cmd 刷爆 —— 所以脚本写值不打操作日志，控制台只留人在触摸屏上的操作。
        ok, extra = var_write(body.get("name"), body.get("value"),
                              bool(body.get("internal")),
                              str(body.get("from") or "") == "script",
                              actor=_ctx_user(ctx))
        return (200 if ok else 400), {"ok": ok, **extra}

    if path == "/api/vars/declare":
        # variables 为 None = 只改采集范围、不动变量表（编辑器切页面预览用）
        ok, extra = var_declare(body.get("variables", None), body.get("active", None))
        return (200 if ok else 400), {"ok": ok, **extra}

    if path == "/api/vars/reset":
        # 内部变量（内存模拟）恢复变量表初值；接了真设备就没这一步（别去盖 PLC）
        src = datasource.get_source()
        if not hasattr(src, "reset"):
            return 400, {"ok": False, "error": "当前接的是真实设备，没有「恢复初值」——"
                                               "要还原请直接改 PLC 里的值"}
        clear = bool(body.get("clear"))
        values = src.reset(clear=clear)
        for k, v in values.items():
            broadcast({"name": k, "value": v})
        print(f"[var] {'清空' if clear else '恢复'}内部变量（{len(values)} 个）")
        return 200, {"ok": True, "cleared": clear, "vars": values}

    if path == "/api/plc" and method == "POST":
        return _ep_plc(body)

    if path == "/api/comm/validate" and method == "POST":
        # 地址校验（变量表地址格 / 连接对话框 / 前端批量体检用）：不落盘、不连设备、不切当前模型。
        # 参数：{protocol, address, vtype?, write?}；返回形状见 task-7 契约（comm.Protocol.validate）。
        return _ep_comm_validate(body)


    if path == "/api/opcua/parse-xml":
        # 离线导入：解析 CODESYS/Invtmatic 导出的「符号配置」XML（不连服务器）
        if opcua is None:
            return 400, {"ok": False, "message": "OPC UA 模块没加载"}
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
        return 200, res

    if path == "/api/opcua/browse":
        return _ep_opcua_browse(body)

    if path == "/api/project" and method == "POST":
        data = body.get("data")
        if not isinstance(data, dict) or "pages" not in data:
            return 400, {"ok": False, "error": "invalid project"}
        p = write_project_file(data)                 # 写 .LE（老 hmi_project.json 不动）
        print(f"[project] 已保存 {p}")
        return 200, {"ok": True}
    if path == "/api/recipes" and method == "POST":
        # 配方是存下来的配置：save / delete / **apply** 统统要管理员（admin 闸门已在上面）——
        # 操作员"只能改设备连接"，应用配方这种批量写变量的动作也不给他。
        status, result = _ep_recipes(body)
        action = str(body.get("action") or "").strip().lower()
        name = str(body.get("name") or "").strip()
        if name and action in ("save", "delete", "apply"):
            detail = result.get("error", "")
            if action == "apply" and "applied" in result:
                detail = f"成功 {len(result['applied'])} 项，失败 {len(result['failed'])} 项。" + detail
            elif action == "save" and result.get("ok"):
                detail = f"{result['count']} 项"
            elif action == "delete" and result.get("deleted") is False:
                detail = "配方已不存在"
            operations.record(_ctx_user(ctx), "recipe_" + action, name, result["ok"], detail)
        return status, result
    if path == "/api/recipes/current" and method == "POST":
        deny = _need_login(ctx, "读取配方当前值")
        if deny:
            return deny
        names = body.get("names")
        if (not isinstance(names, list) or len(names) > 5000
                or any(not isinstance(n, str) or not n for n in names)):
            return 400, {"ok": False, "error": "请选择有效的配方变量（最多 5000 项）"}
        source = datasource.get_source()
        fresh = getattr(source, "read_fresh", None)
        if fresh:
            values = fresh(names)
        else:
            cached = read_all_vars()
            values = {n: cached[n] for n in names if n in cached}
        meta = source.meta()
        values = {name: recipe_value(value, meta.get(name, {}).get("type")) for name, value in values.items()}
        return 200, {"ok": True, "values": values}
    if path == "/api/history" and method == "POST":
        return _ep_history(body, ctx)
    if path == "/api/alarms" and method == "POST":
        return _ep_alarms(body)

    if path == "/api/scriptlog" and method == "POST":
        # 脚本日志落盘。**不用登录**：脚本跑在运行页上，客户机没人登录。
        # 体积极限：单请求行数 + 单行长度 + 每天体积（这里再加一道"整批太大就拒"，
        # 1.x 那道是看 HTTP 的 Content-Length；长连接上没有头，按实际长度算）
        rows = body.get("lines") if isinstance(body.get("lines"), list) else []
        try:
            if len(json.dumps(rows, ensure_ascii=False).encode("utf-8")) > SCRIPTLOG_MAX_BODY:
                return 413, {"ok": False, "error": "脚本日志请求体太大"}
        except Exception:                                           # noqa: BLE001
            pass
        return 200, {"ok": True, **scriptlog_write(rows)}

    if path == "/api/logsettings" and method == "POST":
        # 存这台机器的日志设置（「工程 ▾ → 日志设置…」）。要管理员（改的是本机磁盘策略）。
        # 存完**立刻生效**：保留天数改小了当场清一次，脚本日志上限下次写入就用新值（不用重启）
        deny = _need_login(ctx, "改日志设置")
        if deny:
            return deny
        patch = {}
        if "keep_days" in body:
            patch["log_keep_days"] = _clamp_int(body.get("keep_days"), _LOG_KEEP_MIN,
                                                _LOG_KEEP_MAX, _LOG_KEEP_DEFAULT)
        if "scriptlog_max_mb" in body:
            patch["scriptlog_max_mb"] = _clamp_float(body.get("scriptlog_max_mb"), 0.5,
                                                     SCRIPTLOG_MAX_MB_HARD, SCRIPTLOG_MAX_MB_DEFAULT)
        if not patch:
            return 400, {"ok": False, "error": "没有要改的设置（keep_days / scriptlog_max_mb）"}
        saved, err = _settings_save(patch)
        if err:
            return 500, {"ok": False, "error": err}
        pruned = _log_prune(force=True)             # 保留天数改小了：当场按新窗口清一次
        print(f"[log] 日志设置已更新：保留 {log_keep_days()} 天、脚本日志每天 {scriptlog_max_mb():g} MB"
              + (f"（顺手清掉 {pruned} 个过期文件）" if pruned else ""))
        return 200, {"ok": True, "keep_days": log_keep_days(),
                     "scriptlog_max_mb": scriptlog_max_mb(), "pruned": pruned,
                     "usage": log_usage(), "saved": saved}

    if path == "/api/frp" and method == "GET":
        # FRP 内网穿透现状（「工程 ▾ → FRP 内网穿透…」）：配置 + 跑没跑 + 本机 IP + 该访问的地址。
        # 要管理员：它暴露的是这台机器的网络配置（服务器地址/token/开了哪个端口）。
        deny = _need_login(ctx, "看 FRP 设置")
        if deny:
            return deny
        frp.note_port(ctx.server_port)      # 画面映射的本机端口 = 这个后端实际监听的端口
        return 200, {"ok": True, **frp.status()}

    if path == "/api/frp" and method == "POST":
        # 存 FRP 设置并（按开关与动作）起停 frpc。要管理员（改的是这台机器对外的网络出口）。
        # body: {action?: 'save'|'start'|'stop'|'restart', config: {enabled, server_addr, …}}
        deny = _need_login(ctx, "改 FRP 设置")
        if deny:
            return deny
        patch = body.get("config")
        if not isinstance(patch, dict):
            patch = {k: v for k, v in body.items() if k not in ("action",)}
        # 本机要映射的端口：不用界面填 —— 就是**这个后端实例实际监听的端口**（ctx 给的，最准）
        frp.note_port(ctx.server_port)
        r = frp.apply(patch, str(body.get("action") or ""))
        if not r.get("ok"):
            return 400, r
        st = r.get("status") or {}
        if st.get("running"):
            print(f"[frp] 已启动：{st['config'].get('server_addr')}:{st['config'].get('server_port')}"
                  f" → 本机 {st.get('local_port')} → 远程 {st['config'].get('remote_port')}")
        return 200, {"ok": True, "local_port_hint": ctx.server_port, **st}

    if path == "/api/update/apply":
        # 「立即更新」：下载新版代码 → 只覆盖代码 → 重启。
        # ⚠ 这个结果发回去之后进程就退出了 —— 调用方收到 ok 就要开始等它回来（见 updateCheck.js）
        return 200, apply_update(host=ctx.server_host, port=ctx.server_port)

    # 未知接口：给一句明确的话，别静默
    return 404, {"ok": False, "error": f"后端不认识这个接口：{path}"
                                       f"（build {SERVER_BUILD}；改了后端代码要重启服务）"}


# ─────────────────────────────────────────────
#  /api/plc：连接 / 断开 / 测试 / 字序体检 / 端点诊断 / 地址解析
# ─────────────────────────────────────────────
def _profile_ids_cn():
    """「地址模型」下拉用的可读串：ts600-modbus-tcp（TS600） / invt-modbus-slave（Invtmatic）"""
    return " / ".join(f"{p['id']}（{p['cn']}）" for p in modbus.profiles())


def _check_addr_profile(raw):
    """校验请求里的 addr_profile；返回 (归一化 id, 错误文本)。空 = 用当前模型。"""
    if raw is None or str(raw).strip() == "":
        return modbus.get_profile(), ""
    if not modbus.profile_ok(raw):
        return "", (f"地址模型 {raw!r} 不认识；可选：{_profile_ids_cn()}"
                    f"（也可以写 ts600 / invt 这类简称）")
    return modbus.set_profile(raw), ""


# 协议下拉（三项）。落盘口径：TS600 也是 Modbus TCP —— protocol 存 "modbus"，
# 地址模型存 "ts600-modbus-tcp"；前端传 ts600/ts/modbus_ts/ts600_tcp 都收。
_PROTOCOL_IDS = ("modbus（Modbus TCP，INVT 写法 %MW/%MD/%QX…） / "
                 "ts600（TS600 TCP，元件写法 D100/M10/X17…） / opcua（OPC UA）")


def _protocol_choice(raw):
    """协议下拉 → (实际链路 proto, 强制地址模型 or None, 错误文本)。

    空 = 沿用请求里其它字段（兼容老前端只传 addr_profile / 不传 protocol）。
    ts* 都是「Modbus TCP + TS600 地址模型」，且**必须**覆盖 addr_profile 成 ts600。
    """
    p = str(raw or "").strip().lower()
    if p == "":
        return "", None, ""
    q = _norm_protocol_name(p)
    if q == "modbus":
        return "modbus", None, ""
    if q == "ts600":
        return "modbus", "ts600-modbus-tcp", ""
    if q == "opcua":
        return "opcua", None, ""
    return "", None, (f"协议 {raw!r} 不认识；可选：{_PROTOCOL_IDS}"
                      f"（也可以写 ts / modbus_ts / ts600_tcp 这类写法）")


# ─────────────────────────────────────────────
#  /api/comm：通讯协议注册表 + 地址校验（实现在 server/comm/，加协议只改那个包）
# ─────────────────────────────────────────────
def _comm_current():
    """当前生效的协议 + 地址模型（前端下拉框的 current）。

    落盘口径没变：TS600 也是 protocol="modbus" + addr_profile="ts600-modbus-tcp"，
    这里用 comm.pid_for() 换算成「协议下拉框里的那一项」给前端看。
    """
    with _addr_model_lock:
        prof = modbus.get_profile()
    return {"protocol": comm.pid_for(_plc_cfg.get("protocol"), prof),
            "addr_profile": prof}


def _ep_comm_protocols():
    return {"ok": True, "protocols": comm.protocols(), "current": _comm_current()}


def _ep_comm_validate(body: dict):
    """POST /api/comm/validate → {ok, valid, unsupported, code, message, warning, writable, …}

    协议认不出回 400（带可选列表）；地址不合法**不报错**——valid:false + code 说明原因。
    """
    try:
        pid = comm.normalize(body.get("protocol"))
    except ValueError as e:
        return 400, {"ok": False, "error": str(e)}
    write = comm.as_bool(body.get("write"))
    try:
        res = comm.validate(pid, body.get("address") or "",
                            vtype=body.get("vtype") or "", write=write)
    except ValueError as e:                     # 注册表缺项之类的兜底（正常走不到）
        return 400, {"ok": False, "error": str(e)}
    return 200, res


def _ep_plc(body: dict):
    action = (body.get("action") or "connect").lower()
    proto = _protocol_of(body)

    if action == "profiles":
        # 地址模型注册表：前端「PLC」页/变量表用它填下拉框；current = 当前生效的模型
        return 200, {"ok": True, "profiles": modbus.profiles(), "current": modbus.get_profile()}

    if action == "disconnect":
        return 200, {"ok": True, "status": plc_disconnect()}

    if action == "endpoints":
        # 只问「你是谁、开了哪些端点、接受哪种身份」——不需要建会话，
        # 所以匿名被拒/密码不对时照样能给出有用信息（连不上时的第一手排查）
        if proto == "opcua":
            if opcua is None or not opcua.AVAILABLE:
                why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
                return 200, {"ok": False, "message": f"后端没有可用的 asyncua（{why}）"}
            r = opcua.describe_endpoints(body.get("endpoint") or _plc_cfg.get("endpoint"))
            print(f"[opcua] 端点诊断 {body.get('endpoint')}")
            return 200, r
        return 200, {"ok": False, "message": "端点诊断只对 OPC UA 有意义（Modbus 直接看「测试连接」）"}

    if action == "test":
        proto2, forced, perr = _protocol_choice(body.get("protocol"))
        if perr:
            return 400, {"ok": False, "error": perr}
        if proto2:
            proto = proto2
        if proto == "opcua":
            if opcua is None or not opcua.AVAILABLE:
                why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
                return 200, {"ok": False, "message": f"后端没有可用的 asyncua（{why}）；"
                                                     f"装：{getattr(opcua, 'INSTALL_HINT', '')}"}
            okc, msg, info = opcua.probe(body.get("endpoint") or _plc_cfg.get("endpoint"),
                                         body.get("security", "none"),
                                         body.get("username", ""), body.get("password", ""))
            print(f"[opcua] 测试连接 {body.get('endpoint')} → {'成功' if okc else '失败'}：{msg}")
            return 200, {"ok": okc, "message": msg, "info": info}
        ip = body.get("ip") or _plc_cfg.get("ip")
        port = int(body.get("port") or _plc_cfg.get("port") or 502)
        unit = int(body.get("unit") or _plc_cfg.get("unit") or 1)
        # 地址模型：对话框里选了就按它算默认地址（invt → %MW0，TS600 → D0）；
        # ⚠ 只在探测这一小段切模型，探完切回去 —— 现场可能连着另一个模型在跑。
        with _addr_model_lock:
            cur_prof = modbus.get_profile()
            prof, perr = _check_addr_profile(forced or body.get("addr_profile")
                                             or _plc_cfg.get("addr_profile"))
            if perr:
                return 400, {"ok": False, "error": perr}
            try:
                if prof != cur_prof:
                    modbus.set_profile(prof)
                addr = body.get("address") or modbus.default_address()
                okc, msg = modbus.probe(ip, port, unit, address=addr)
            finally:
                if prof != cur_prof:
                    modbus.set_profile(cur_prof)
        print(f"[plc] 测试连接 {ip}:{port}（{prof}，地址 {addr}）→ {'成功' if okc else '失败'}：{msg}")
        return 200, {"ok": okc, "message": msg, "addr_profile": prof, "address": addr}

    if action == "parse":
        # 变量表地址格 / 连接对话框的即时提示用：按协议解析地址
        proto2, forced, perr = _protocol_choice(body.get("protocol"))
        if perr:
            return 400, {"ok": False, "error": perr}
        if proto2:
            proto = proto2
        if proto == "opcua":
            if opcua is None:
                return 200, {"ok": False, "message": "OPC UA 模块没加载"}
            addr = body.get("address") or ""
            try:
                ns, kind, ident = opcua.split_node_id(addr, body.get("default_ns", opcua.DEFAULT_NS))
                return 200, {"ok": True, "protocol": "opcua", "ns": ns, "kind": kind,
                             "ident": ident, "nodeid": opcua.parse_node_id(addr),
                             "describe": opcua.describe_node_id(addr)}
            except ValueError as e:
                return 200, {"ok": False, "message": str(e)}
        # 解析走**注册表**（server/comm/）里同一套地址校验逻辑，这里只把结果拼回
        # **老字段**：变量表/连接对话框、现场前端套件都依赖这个形状，字段名一个都不能动。
        # 解析用的是请求里选中的模型：先归一切到它，错误文案里的模型名才和下拉一致；
        # 解析完切回原样。协议是 ts600 时不管前端带什么 addr_profile 都按 TS600 解析。
        raw_addr = body.get("address") or ""
        vtype = body.get("vtype") or ""
        with _addr_model_lock:
            cur_prof = modbus.get_profile()
            prof, perr = _check_addr_profile(forced or body.get("addr_profile"))
            if perr:
                return 400, {"ok": False, "error": perr}
            try:
                if not str(raw_addr).strip():
                    # 老形状的文案就是这句（新接口 /api/comm/validate 用的是更细的
                    # code:"empty" +「留空 = 内部变量」，两套别混）
                    return 200, {"ok": False, "profile": prof, "message": "地址为空"}
                res = comm.validate("ts600" if prof == "ts600-modbus-tcp" else "modbus",
                                    raw_addr, vtype=vtype, write=False)
            except modbus.UnsupportedAddress as e:
                # 写法不属于这个协议/模型：不当成错误弹窗 —— 变量会被当内部变量，前端标原因即可
                return 200, {"ok": False, "unsupported": True,
                             "profile": prof, "message": str(e)}
            except ValueError as e:
                return 200, {"ok": False, "profile": prof, "message": str(e)}
            finally:
                if prof != cur_prof:
                    modbus.set_profile(cur_prof)
        if res.get("unsupported"):
            return 200, {"ok": False, "unsupported": True,
                         "profile": prof, "message": res.get("message") or ""}
        if not res.get("valid"):
            return 200, {"ok": False, "profile": prof, "message": res.get("message") or ""}
        a = res["address"]
        return 200, {"ok": True, "protocol": "modbus",
                     "area": a["area"],
                     # ⚠ 老形状用的是 addr_model.AREA_CN 的**长名**（"保持寄存器（%MW）"）；
                     # 新接口 /api/comm/validate 用短名（"保持寄存器"）—— 别拿 comm.AREA_CN 顶替
                     "area_cn": modbus.AREA_CN[a["area"]],
                     "offset": a["offset"], "words": a["words_parsed"],
                     "bit": a["bit"], "byte": a["byte"],
                     # 只读 / 元件类型 / 按哪个地址模型解析的：前端据此提示「X 是输入，不能写」，
                     # 以及在 TS600 的 T/C 上区分「它是线圈还是寄存器」
                     "readonly": bool(a["readonly"]), "kind": a["kind"], "profile": prof,
                     "words_for_type": modbus.words_for(vtype or "real", a["words_parsed"])}

    if action == "orders":
        # 只读：同一个地址按 4 种字序各解一次，让现场一眼看出对方 PLC 是哪种
        proto2, forced, perr = _protocol_choice(body.get("protocol"))
        if perr:
            return 400, {"ok": False, "error": perr}
        if proto2:
            proto = proto2
        if proto == "opcua":
            return 200, {"ok": False,
                         "message": "OPC UA 没有字序这回事（类型由服务器给，Float/Double 直接就是对的）"}
        with _addr_model_lock:
            cur_prof = modbus.get_profile()
            prof = forced
            if not prof and body.get("addr_profile"):
                prof, perr = _check_addr_profile(body.get("addr_profile"))
                if perr:
                    return 400, {"ok": False, "error": perr}
            try:
                # 对话框里选了 TS600 就按它的默认地址（D0）和解析规则试，试完切回去
                if prof and prof != cur_prof:
                    modbus.set_profile(prof)
                addr = body.get("address") or modbus.default_address()
                vtype = body.get("vtype") or "real"
                length = body.get("length") or None
                src = datasource.get_source()
                if isinstance(src, PlcSource):
                    res = src.order_candidates(addr, vtype, length)
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
                return 200, {"ok": False, "message": str(e)}
            finally:
                if prof and prof != cur_prof:
                    modbus.set_profile(cur_prof)
        print(f"[plc] 字序体检 {addr}（{vtype}）：字 = {res['words']}")
        return 200, {"ok": True, "address": addr, "vtype": vtype, **res}

    # 默认：连接（可同时带变量表，连上就开始轮询）
    proto2, forced, perr = _protocol_choice(body.get("protocol"))
    if perr:
        return 400, {"ok": False, "error": perr}
    if proto2:
        proto = proto2
    keep = ("protocol", "ip", "port", "unit", "poll_ms", "word_order", "addr_profile",
            "endpoint", "security", "username", "password", "default_ns")
    cfg = {k: body.get(k, _plc_cfg.get(k)) for k in keep}
    cfg["protocol"] = proto
    if proto == "opcua":
        if opcua is None or not opcua.AVAILABLE:
            why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
            return 400, {"ok": False, "error": f"后端没有可用的 asyncua（{why}）—— 装："
                                               f"{getattr(opcua, 'INSTALL_HINT', '')}"}
        cfg["endpoint"] = opcua.norm_endpoint(cfg.get("endpoint"))
    else:
        raw_order = cfg.get("word_order")
        if raw_order is not None and not modbus.order_ok(raw_order):
            return 400, {"ok": False,
                         "error": f"字序 {raw_order!r} 不认识，只能是 abcd / cdab / badc / dcba"}
        cfg["word_order"] = modbus.normalize_order(raw_order)
        # 地址模型：连接时定下来并存进 plc.json（下次开机 _autoconnect_saved_plc 按它解析）；
        # 协议选的是 ts600 时，强制覆盖成 ts600-modbus-tcp（ts 必须覆盖）
        prof, perr = _check_addr_profile(forced or cfg.get("addr_profile"))
        if perr:
            return 400, {"ok": False, "error": perr}
        cfg["addr_profile"] = prof
    if body.get("variables") is not None:
        variables = body.get("variables")
    else:
        variables = [{"name": k, "type": v["type"], "address": v["address"]}
                     for k, v in datasource.get_source().meta().items()]
    try:
        st = plc_connect(cfg, variables)
    except ValueError as e:
        return 400, {"ok": False, "error": str(e)}

    # ⚠ 连完**当场探一次**（和「测试连接」走同一条路）。
    #   后台轮询只在「有人看运行画面」时才跑（poll_gate）——编辑器里按「确定」时它不跑，
    #   不探这一下，前端轮着看状态永远是"没在线"，对话框只会弹「连接没有成功：设备没有响应」，
    #   而"测试连接"明明是通的（现场踩过，就是这个）。
    probe_ok, probe_msg = True, ""
    if proto == "opcua":
        if opcua is not None and opcua.AVAILABLE:
            probe_ok, probe_msg, _pinfo = opcua.probe(
                cfg.get("endpoint"), cfg.get("security", "none"),
                cfg.get("username", ""), cfg.get("password", ""))
        else:
            probe_ok, probe_msg = False, "后端没有可用的 asyncua"
    else:
        try:
            probe_ok, probe_msg = modbus.probe(cfg["ip"], int(cfg["port"]), int(cfg["unit"]),
                                               address=(body.get("address")
                                                        or modbus.default_address()))
        except Exception as e:                                       # noqa: BLE001
            probe_ok, probe_msg = False, str(e)
    if proto == "opcua":
        print(f"[opcua] 连接 {cfg['endpoint']}"
              + (f"（用户 {cfg.get('username')}）" if cfg.get("username") else "（匿名）")
              + f"，变量 {len(variables)} 个"
              + f"，探活 {'成功' if probe_ok else '失败：' + probe_msg}")
    else:
        print(f"[plc] 连接 {cfg['ip']}:{cfg['port']} 站号 {cfg['unit']}，字序 {cfg['word_order']}，"
              f"地址模型 {cfg.get('addr_profile')}，变量 {len(variables)} 个"
              + f"，探活 {'成功' if probe_ok else '失败：' + probe_msg}")
    return 200, {"ok": True, "status": st, "probe": {"ok": probe_ok, "message": probe_msg}}


# ─────────────────────────────────────────────
#  /api/opcua/browse：浏览节点树（导入变量用，只读）
# ─────────────────────────────────────────────
def _ep_opcua_browse(body: dict):
    if opcua is None or not opcua.AVAILABLE:
        why = opcua.IMPORT_ERROR if opcua is not None else "模块加载失败"
        return 400, {"ok": False, "message": f"后端没有可用的 asyncua（{why}）；"
                                             f"装：{getattr(opcua, 'INSTALL_HINT', '')}"}
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
    src = datasource.get_source()
    if isinstance(src, OpcUaSource) and getattr(src, "online", False) and src.endpoint == ep:
        res = src.browse(**args)          # 复用常驻连接（省一次连接开销）
    else:
        res = opcua.browse(ep, security=body.get("security", "none"),
                           username=ua_user, password=ua_pass,
                           default_ns=body.get("default_ns", opcua.DEFAULT_NS), **args)
    print(f"[opcua] 浏览 {ep}：{res.get('message')}")
    return 200, res


# ─────────────────────────────────────────────
#  /api/alarms：报警历史存档（运行记录）
# ─────────────────────────────────────────────
def _ep_alarms(body: dict):
    """三种写法，可同时给（顺序：先 clear，再 add，最后 patch）：
         {clear:true}                    清空（现场"清空报警记录"按钮）
         {add:[记录,…]}                  新报警 / 上次离线时本地攒下的记录（自动去重）
         {patch:[{key,at,endAt,acked}]}  补恢复时间 / 确认
    不加登录闸门：报警是运行页产生的，客户机上没人登录（同 /api/vars）。"""
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
    # 推给其它打开着的页面（另一个地址/另一个浏览器）：报警表立刻跟着更新，不用刷新才看见。
    # 收到的一侧按同一套规则去重，不会再回写（不成环）
    if added or closed or patched or body.get("clear"):
        broadcast({"alarm": delta})
    if added or skipped or patched or body.get("clear"):
        print(f"[alarm] 记录 +{len(added)}"
              + (f"，同一次跳过 {len(skipped)}" if skipped else "")
              + (f"，补恢复 {len(patched)}" if patched else "")
              + (f"，补结束 {len(closed)}" if closed else "")
              + f"（共 {total} 条）")
    return 200, {"ok": True, "total": total, "added": len(added),
                 "skipped": skipped, "patched": patched, "closed": closed}


# ─────────────────────────────────────────────
#  /api/recipes：配方（现场数据，存 <数据目录>/recipes.json，见 core/recipe.py）
# ─────────────────────────────────────────────
def _ep_recipes(body: dict):
    """配方三件事，一次一个 action：

        POST /api/recipes {action:'save',   name, vars}  → {ok, name, updated, count}
        POST /api/recipes {action:'delete', name}        → {ok, name, deleted}
        POST /api/recipes {action:'apply',  name}        → {ok, name, applied, failed}

    · 要管理员（在 ADMIN_PATHS 里）：配方是**存下来的配置**，不能让没登录的客户机改。
    · 应用（apply）逐个变量走 varapi.var_write，所以某个变量写不进去**不挡**其它变量：
      结果里 applied 是写成功的变量名、failed 是 [{name, error}]，前端照着显示哪几个没成。
    · 配方不存在：delete 当幂等（deleted:false），apply 回 404 + 明确原因。
    """
    action = str(body.get("action") or "").strip().lower()
    name = str(body.get("name") or "").strip()
    revision = body.get("revision")
    try:
        if action == "save":
            if not name:
                return 400, {"ok": False, "error": "缺少配方名（name）"}
            rec = _recipes.save(name, body.get("vars"), expected=revision,
                                create_only=body.get("create_only") is True)
            return 200, {"ok": True, "name": rec["name"], "updated": rec["updated"],
                         "count": len(rec["vars"]), "revision": rec["revision"]}
        if action == "delete":
            if not name:
                return 400, {"ok": False, "error": "缺少配方名（name）"}
            return 200, {"ok": True, "name": name, "deleted": _recipes.delete(name, expected=revision)}
        if action == "apply":
            if not name:
                return 400, {"ok": False, "error": "缺少配方名（name）"}
            result = _recipes.apply(name, expected=revision)
            return (200 if result["ok"] or result["failed"] else 404), result
        return 400, {"ok": False,
                     "error": f"不认识的配方操作：{action!r}（只认 save / delete / apply）"}
    except RecipeConflict as e:
        return 409, {"ok": False, "error": str(e)}
    except ValueError as e:                                     # 参数不合法（名字空/太长、vars 不是对象）
        return 400, {"ok": False, "error": str(e)}
    except OSError as e:                                        # 盘写不进去：现场要看见，别假装存上了
        print(f"[recipe] 配方文件写入失败：{type(e).__name__}: {e}")
        return 500, {"ok": False, "error": f"配方文件读写失败：{e}"}


# ─────────────────────────────────────────────
#  /api/history：历史数据（采样/查询/导出 CSV，见 core/history.py）
# ─────────────────────────────────────────────
def _query_vars(query):
    """query 里的 vars：parse_qs 给的是列表；一个值里也可能用逗号写多个（?vars=a,b）"""
    out = []
    for chunk in (query or {}).get("vars") or []:
        for x in str(chunk).replace("，", ",").split(","):
            n = x.strip()
            if n and n not in out:
                out.append(n)
    return out


def _ep_history(body: dict, ctx: Ctx):
    """历史数据的三件事（一次一个 action）：

        POST /api/history {action:'query',    from?, to?, vars?}  → {ok, vars, rows, count, …}
        POST /api/history {action:'export',   from?, to?, vars?}  → {ok, csv, filename, …}
        POST /api/history {action:'settings', on?, intervalMs?, vars?, keepDays?}
                                                                 → {ok, settings, stats}（要管理员）

    · query / export 是只读：**不用登录**（跟 GET 一个口径，报表页/客户机都要看）。
    · settings 要管理员：它决定这台机器要不要持续采样、采哪些变量、留几天
      （改的是磁盘和采集策略，不能让没登录的客户机随手改）。
    · 采样周期 500~60000ms、保留 1~90 天，超范围会夹回边界（现场手滑不用报错）。
    """
    action = str(body.get("action") or "query").strip().lower()
    if action == "settings":
        deny = _need_login(ctx, "改历史采样设置")
        if deny:
            return deny
        try:
            cfg = _history.save_settings(body)
        except OSError as e:                                    # 盘写不进去：别假装存上了
            print(f"[history] 保存采样设置失败：{type(e).__name__}: {e}")
            return 500, {"ok": False, "error": f"历史配置文件写入失败：{e}"}
        return 200, {"ok": True, "settings": cfg, "stats": _history.stats()}
    if action in ("query", "export"):
        frm, to = _history.normalize_range(body.get("from"), body.get("to"))
        q = _history.query(frm, to, body.get("vars"))
        if action == "query":
            return 200, {"ok": True, **q}
        return 200, {"ok": True, "csv": _history.csv_from_query(q),
                     "filename": _history.csv_filename(frm, to),
                     "from": frm, "to": to, "count": q["count"], "truncated": q["truncated"]}
    return 400, {"ok": False,
                 "error": f"不认识的历史数据操作：{action!r}（只认 query / settings / export）"}


# ─────────────────────────────────────────────
#  /api/users：多用户/角色管理（账号表 <数据目录>/users.json，见 core/users.py）
# ─────────────────────────────────────────────
def _ep_users(body: dict):
    """账号管理的写操作（**只有管理员能进来**，闸门在 dispatch 里）：

        POST /api/users {action:'add',    user, password, role}   → {ok, user:{name,role,enabled,created}}
        POST /api/users {action:'delete', user}                   → {ok, user, deleted}
        POST /api/users {action:'passwd', user, password}         → {ok, user}
        POST /api/users {action:'role',   user, role}             → {ok, user}
        POST /api/users {action:'enable', user, enabled}          → {ok, user}
        （delete / role / enable 这几个名字也认：del/remove、set_password、set_role、disable）

    结果里的 user 只有公开字段，**永远不带密码/盐/哈希**。
    错误用 400 + 一句人话（重名 / 不存在 / 最后一个管理员 / 密码太短 …），前端直接显示。
    """
    action = str(body.get("action") or "").strip().lower()
    name = str(body.get("user") or body.get("name") or "").strip()
    try:
        if action == "add":
            rec = USERS.add(name, body.get("password"),
                            body.get("role") or ROLE_OPERATOR)
            print(f"[users] 新账号 {rec['name']}（{rec['role']}）")
            return 200, {"ok": True, "user": rec}
        if action in ("delete", "del", "remove"):
            deleted = USERS.delete(name)
            if deleted:
                print(f"[users] 已删除账号 {name}")
            return 200, {"ok": True, "user": name, "deleted": deleted}
        if action in ("passwd", "password", "set_password"):
            rec = USERS.set_password(name, body.get("password"))
            print(f"[users] 已改密码：{name}")
            return 200, {"ok": True, "user": rec}
        if action in ("role", "set_role"):
            rec = USERS.set_role(name, body.get("role"))
            print(f"[users] 已改角色：{name} → {rec['role']}")
            return 200, {"ok": True, "user": rec}
        if action in ("enable", "disable", "set_enabled", "enabled"):
            enabled = body.get("enabled")
            if enabled is None:
                enabled = action != "disable"
            rec = USERS.set_enabled(name, enabled)
            print(f"[users] 已{'启用' if rec['enabled'] else '禁用'}账号：{name}")
            return 200, {"ok": True, "user": rec}
        return 400, {"ok": False,
                     "error": f"不认识的用户操作：{action!r}"
                              "（只认 add / delete / passwd / role / enable）"}
    except ValueError as e:                                     # 重名/不存在/最后一个管理员/密码太短…
        return 400, {"ok": False, "error": str(e)}
