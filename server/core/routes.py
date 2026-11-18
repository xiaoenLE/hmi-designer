#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""routes.py — 路由表：do_GET / do_POST

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

一个接口一段注释，照着注释找。
工具方法（_json / _body / _cors / _origin_allowed / _serve_run_only…）在 core/handler.py。
"""

from . import auth
from . import datasource
from . import updateapply
from .alarmstore import _alarm_add
from .alarmstore import _alarm_lock
from .alarmstore import _alarm_patch
from .alarmstore import _alarms_load
from .alarmstore import _alarms_save
from .applog import _log_prune
from .auth import SESSION_COOKIE
from .auth import _LOGIN_FAILS
from .auth import check_password
from .auth import drop_session
from .auth import login_blocked
from .auth import new_session
from .auth import note_login_fail
from .broadcast import _clients
from .broadcast import _clients_lock
from .broadcast import broadcast
from .datasource import _source_status
from .datasource import plc_connect
from .datasource import plc_disconnect
from .loginpage import login_page_html
from .paths import DATA_DIR
from .paths import EDITOR_PATH
from .paths import PROJECT_FILE
from .paths import RUN_ALWAYS
from .paths import SETTINGS_FILE
from .plcsource import OpcUaSource
from .plcsource import PlcSource
from .plcsource import _plc_cfg
from .plcsource import _protocol_of
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
from .updateapply import UPDATE_ARCHIVE_URL
from .updateapply import apply_update
from .varapi import read_all_vars
from .varapi import var_declare
from .varapi import var_write
from .versioninfo import SERVER_BUILD
from .versioninfo import SERVER_FEATURES
from .versioninfo import _local_version
from .versioninfo import check_update
from .wsbridge import WS_STATUS_MS
from .wsbridge import _ws_alive

from .opcualib import opcua
from urllib.parse import parse_qs, urlparse
import json
import modbus                     # 同目录：Modbus TCP 主站 + %MW/%MD 地址解析
import poll_gate                  # 同目录：有没有人在看运行画面（没人看就不跟设备通讯）
import re
import updater                    # 同目录：自己更新（下载代码包 / 只覆盖代码 / 备份 / 回滚）


class RoutesMixin:

    def do_GET(self):
        self._body_bytes()          # 连接复用下请求体必须读完（见 _body_bytes 的说明）
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
            if auth.AUTH_ENABLED and not self._logged_in():
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
                        # 连接数 / 请求数（诊断）：两个数一起涨 = 每个请求都在新建 TCP 连接。
                        # 现场"跑一晚上内存涨到几个 G"就是这条线：写变量每秒十几发，
                        # 后端原来是一问一答关连接（HTTP/1.0），一晚几十万次连接的生死。
                        # 正常应该 requests 一路涨、connections 基本不动（keep-alive 在复用）。
                        "conns": type(self.server).conns,
                        "reqs": type(self).reqs,
                        # 当前版本（version.json + build）：状态栏要显示「这台机器上是哪个版本」——
                        # 现场报问题第一句就是「你那是哪个版本」，以前只能靠 build 日期猜
                        "version": dict(_local_version(), build=SERVER_BUILD),
                        # 更新的进行时/上次结果：前端据此显示「正在更新」和「上次更新失败已回滚」，
                        # 现场排查时也能直接看到"上一跳是怎么落地的"（详情在 logs/update-*.log）
                        "update": {"applying": bool(updateapply.is_applying()), "enabled": bool(UPDATE_ARCHIVE_URL),
                                   "last": updater.read_state(DATA_DIR, "status.json")},
                        # OPC UA 靠第三方库 asyncua，缺了要能当场说明白（而不是连接时莫名失败）
                        "opcua": {"available": bool(opcua is not None and opcua.AVAILABLE),
                                  "import_error": (getattr(opcua, "IMPORT_ERROR", "") if opcua else "模块加载失败"),
                                  "install": (getattr(opcua, "INSTALL_HINT", "") if opcua else ""),
                                  "default_ns": (getattr(opcua, "DEFAULT_NS", 4) if opcua else 4)},
                        "vars": len(datasource.get_source().read_all()), "clients": n, "plc": st,
                        # WebSocket 通道状态（诊断）：客户端接进来之后稳态下应该是
                        # **reqs 一动不动、ws 连接数 1~N**。还有 reqs 在涨就说明前端没走
                        # 长连接（旧前端 / 旧后端 / 退回 SSE 轮询了），现场一眼能看出来。
                        "ws": {"clients": len(_ws_alive()), "status_ms": WS_STATUS_MS,
                               "conns": [_c.stats() for _c in _ws_alive()]},
                        # 客户机上要能看出「要不要登录才能改」/「现在登录着没」
                        "auth": {"enabled": auth.AUTH_ENABLED, "logged_in": self._logged_in()}})
        elif self.path == "/api/session":
            self._json({"ok": True, "auth_enabled": auth.AUTH_ENABLED, "logged_in": self._logged_in()})
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
            self._json({"vars": read_all_vars(), "meta": datasource.get_source().meta()})
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
        elif p == "/api/scriptlog":
            # 脚本日志（hmi.log 落盘那份，见 scriptlog_write）：编辑器与运行页都要读，**不用登录**。
            # ?date=YYYY-MM-DD 看哪天（默认今天）、?limit=N 最多几行（默认 300，上限 2000）
            q = parse_qs(urlparse(self.path).query)
            try:
                lim = int((q.get("limit") or ["300"])[0])
            except ValueError:
                lim = 300
            self._json(scriptlog_read((q.get("date") or [""])[0], lim))
        elif p == "/api/logsettings":
            # 日志设置（这台机器的：保留天数 / 脚本日志每天上限）。
            # 要管理员：它决定这台机器留多少日志、占多少盘（GET 也一样，免得客户机看出来）
            if not self._need_login("看日志设置"):
                return
            self._json({"ok": True, "keep_days": log_keep_days(),
                        "scriptlog_max_mb": scriptlog_max_mb(),
                        "limits": {"keep_days": [_LOG_KEEP_MIN, _LOG_KEEP_MAX],
                                   "scriptlog_max_mb": [0.5, SCRIPTLOG_MAX_MB_HARD]},
                        "fallback": {"keep_days": _LOG_KEEP_ENV,
                                     "scriptlog_max_mb": _SCRIPTLOG_MAX_MB_ENV},
                        "saved": _settings_load(),      # 界面上设过什么（空 = 还没设过，走环境/默认）
                        "usage": log_usage(), "file": str(SETTINGS_FILE)})
        elif self.path == "/api/events":
            self._sse()
        elif p == "/api/ws":
            # WebSocket 双向通道：变量推送 / 变量写入 / 设备状态 / 在线登记全在这一条连接上。
            # ⚠ 这是**长连接**：下面这个调用会一直阻塞到连接断开，期间这个 handler 线程
            #   就归这条连接了（和 _sse 一样）。
            self._serve_ws()
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
                   "/api/opcua/browse", "/api/vars/reset", "/api/logsettings",
                   "/api/update/apply")     # 自己更新会换掉程序文件，必须管理员

    def do_POST(self):
        # ⚠ 第一件事就把请求体读完（见 _body_bytes）：下面有一堆"提前 return"的分支
        #   （来源被拒 / 限流 / 要管理员登录），连接复用之后没读完的请求体会被当成下一个请求解析。
        self._body_bytes()
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
        if auth.AUTH_ENABLED and self.path in self.ADMIN_PATHS and not self._logged_in():
            print(f"[auth] 拒绝未登录的 {self.path}")
            return self._json({"ok": False, "need_login": True,
                               "error": "需要管理员登录（浏览器打开 /login）"}, 401)

        if self.path == "/api/poll":
            # 「有没有人在看运行画面」的登记（运行页面进运行态时登记 + 每 10 秒心跳）：
            # 没人登记 → 后端不跟设备通讯（现场要求：不在运行时别占用设备通讯口）。
            body = self._body() or {}
            if "always" in body:
                poll_gate.set_always(bool(body.get("always")))
            poll_gate.set_runner(body.get("client"), bool(body.get("on")))
            return self._json({"ok": True, **poll_gate.status()})

        if self.path == "/api/vars":
            body = self._body()
            # 逻辑全在 var_write 里（WebSocket 通道走的是同一个函数）——
            # 这里只是把它翻译成 HTTP 状态码：失败 400 + 原因，成功 200。
            # `from='script'` = 脚本发起的写：脚本可能每 100ms 写一次，那行 `[var] …`
            # 会把 cmd 刷爆 —— 所以脚本写值不打操作日志，控制台只留人在触摸屏上的操作。
            ok, extra = var_write(body.get("name"), body.get("value"),
                                  bool(body.get("internal")),
                                  str(body.get("from") or "") == "script")
            self._json({"ok": ok, **extra}, 200 if ok else 400)
        elif self.path == "/api/vars/reset":
            # 内部变量（内存模拟）恢复变量表初值；接了真设备就没这一步（别去盖 PLC）
            if not hasattr(datasource.get_source(), "reset"):
                return self._json({"ok": False, "error": "当前接的是真实设备，没有「恢复初值」——"
                                                          "要还原请直接改 PLC 里的值"}, 400)
            clear = bool((self._body() or {}).get("clear"))
            values = datasource.get_source().reset(clear=clear)
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
            # 逻辑在 var_declare 里（WebSocket 通道走同一个函数），见那里的说明：
            # variables 为 None = 只改采集范围、不动变量表（编辑器切页面预览用）。
            ok, extra = var_declare(body.get("variables", None), body.get("active", None))
            self._json({"ok": ok, **extra}, 200 if ok else 400)
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
                    if isinstance(datasource.get_source(), PlcSource):
                        res = datasource.get_source().order_candidates(addr, vtype, length)
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
                             for k, v in datasource.get_source().meta().items()]
            try:
                st = plc_connect(cfg, variables)
            except ValueError as e:
                return self._json({"ok": False, "error": str(e)}, 400)
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
                    probe_ok, probe_msg = modbus.probe(
                        cfg["ip"], int(cfg["port"]), int(cfg["unit"]),
                        address=(body.get("address") or "%MW0"))
                except Exception as e:                       # noqa: BLE001
                    probe_ok, probe_msg = False, str(e)
            if proto == "opcua":
                print(f"[opcua] 连接 {cfg['endpoint']}"
                      + (f"（用户 {cfg.get('username')}）" if cfg.get("username") else "（匿名）")
                      + f"，变量 {len(variables)} 个"
                      + f"，探活 {'成功' if probe_ok else '失败：' + probe_msg}")
            else:
                print(f"[plc] 连接 {cfg['ip']}:{cfg['port']} 站号 {cfg['unit']}，字序 {cfg['word_order']}，"
                      f"变量 {len(variables)} 个"
                      + f"，探活 {'成功' if probe_ok else '失败：' + probe_msg}")
            self._json({"ok": True, "status": st, "probe": {"ok": probe_ok, "message": probe_msg}})
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
            src = datasource.get_source()
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
        elif self.path == "/api/scriptlog":
            # 脚本日志落盘（见 scriptlog_write 的说明）。**不用登录**：脚本跑在运行页上，客户机没人登录。
            # 体积极限：请求体硬上限 + 单请求行数上限 + 单行长度上限 + 每天体积上限（四道）
            if int(self.headers.get("Content-Length") or 0) > SCRIPTLOG_MAX_BODY:
                # 一条脚本日志不可能这么大：直接拒，读都不读
                # （HTTP/1.0，没开 keep-alive，剩下的字节随连接关掉一起丢，不会串到下一个请求）
                return self._json({"ok": False, "error": "脚本日志请求体太大"}, 413)
            body = self._body()
            rows = body.get("lines") if isinstance(body.get("lines"), list) else []
            self._json({"ok": True, **scriptlog_write(rows)})
        elif self.path == "/api/logsettings":
            # 存这台机器的日志设置（界面「工程 ▾ → 日志设置…」）。要管理员（改的是本机磁盘策略）。
            # 存完**立刻生效**：保留天数改小了当场清一次，脚本日志上限下次写入就用新值（不用重启后端）
            if not self._need_login("改日志设置"):
                return
            body = self._body()
            patch = {}
            if "keep_days" in body:
                patch["log_keep_days"] = _clamp_int(body.get("keep_days"), _LOG_KEEP_MIN, _LOG_KEEP_MAX, _LOG_KEEP_DEFAULT)
            if "scriptlog_max_mb" in body:
                patch["scriptlog_max_mb"] = _clamp_float(body.get("scriptlog_max_mb"), 0.5,
                                                         SCRIPTLOG_MAX_MB_HARD, SCRIPTLOG_MAX_MB_DEFAULT)
            if not patch:
                return self._json({"ok": False, "error": "没有要改的设置（keep_days / scriptlog_max_mb）"}, 400)
            saved, err = _settings_save(patch)
            if err:
                return self._json({"ok": False, "error": err}, 500)
            pruned = _log_prune(force=True)             # 保留天数改小了：当场按新窗口清一次
            print(f"[log] 日志设置已更新：保留 {log_keep_days()} 天、脚本日志每天 {scriptlog_max_mb():g} MB"
                  + (f"（顺手清掉 {pruned} 个过期文件）" if pruned else ""))
            self._json({"ok": True, "keep_days": log_keep_days(),
                        "scriptlog_max_mb": scriptlog_max_mb(), "pruned": pruned,
                        "usage": log_usage(), "saved": saved})
        else:
            # 未知 POST 路径：给一句明确的话。
            # ⚠ 别落到 super().do_POST()：SimpleHTTPRequestHandler 根本没有这个方法，
            #   会抛 AttributeError 把连接直接掐掉，前端只看到「fetch failed」，查无可查
            #   （后端忘了重启、新接口还没生效时就是这个现象）
            self._json({"ok": False, "error": f"后端不认识这个接口：{self.path}"
                                              f"（build {SERVER_BUILD}；改了后端代码要重启服务）"}, 404)
