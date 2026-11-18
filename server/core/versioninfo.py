#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""versioninfo.py — 构建标识 + 版本清单 + 检查更新

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

构建标识 SERVER_BUILD / 能力表 SERVER_FEATURES 也在这儿：
前端靠能力表判断「后端是不是旧版本、要不要重启」（见 js/api/backend.js）。
⚠ 现场机常常没外网：查不到就**静默** —— 只把原因放进结果里，绝不报错、不卡界面。
"""

from .paths import VERSION_FILE

from urllib.parse import parse_qs, urlparse
import http.client
import json
import os
import re
import threading
import time


# 后端「能力表」：前端据此判断跑的是不是配套版本。
# 改了 modbus/server 的对外行为就把 feature 加进来，这样「忘了重启后端」会当场提示，
# 而不是让人对着旧行为查半天（旧后端会把新参数当默认值静默用掉）。
SERVER_BUILD = "2026-10-07"

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
    "keepalive",        # HTTP/1.1 连接复用（写变量每秒十几发，原来一问一答一连接）+ health 里的 conns/reqs
    "websocket",        # WebSocket 双向通道（GET /api/ws）：变量推送/写入、设备状态、在线登记
                        # 全走一条长连接 —— 稳态下前端**一个 HTTP 轮询都不发**。
                        # 前端发现后端没有这个能力就退回 SSE + HTTP 轮询（旧后端照常能用）。
]

_DEFAULT_UPDATE_URL = "http://124.221.183.24:3000/xiaoen/hmi-designer/raw/branch/master/release/version.json"

# 换更新源：设环境变量 HMI_UPDATE_URL；**显式设成空串 = 关掉更新检查**（客户机不许外联的场合）
# ⚠ 清单为什么放 release/ 而不是仓库根：
#   · 根目录的 version.json 是**人改的版本源**（version/date/notes），开发机 push 会覆盖它；
#   · 而发布清单是**构建脚本生成的**（多出 app_zip 的地址与 sha256、min_launcher），
#     两个文件要是同一个路径，下一次 git push 就会把清单里的 sha256 冲掉 → 客户端校验全失败。
#   所以：源码写在根 version.json，构建脚本生成 release/version.json，互不打架。
# 安装包与代码包不进 git 历史，作为本仓库 tag v<版本> 的 Release 附件（几 MB / 36 MB）。
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
    info = {"app": "WebHMI_设计器", "version": "", "date": SERVER_BUILD, "notes": "", "url": ""}
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
