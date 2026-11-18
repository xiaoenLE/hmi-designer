# -*- coding: utf-8 -*-
"""通讯协议注册表自测（server/comm/ + /api/comm/* + 老 /api/plc parse 兼容）。

单文件、**不用起模拟器、不碰网络**、不动现场配置：全部是纯函数/内存对象层面的校验，
覆盖 task-7 冻结契约里的：
    · validate 矩阵（ts600 / modbus / opcua 三种协议 × 合法/写法不匹配/非法/空/只读告警）
    · /api/comm/protocols 目录 schema（字段、顺序、前缀表、示例）
    · normalize 别名（""/"ts"/"modbus_ts"/"ua"/"invt"…）
    · 老 /api/plc action=parse 的 JSON 形状**一个字都没变**
    · make_source("ts600"/"modbus"/"opcua") 返回现成的 PlcSource / OpcUaSource（不搬类）

跑法（仓库根）：
    python test/_comm_selftest.py
    python test/_comm_selftest.py -v        # 每条断言都打印

全过 → 打印汇总，exit 0；任何一条不过 → exit 1。
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")

sys.path.insert(0, SERVER)

import comm                                                     # noqa: E402
import modbus                                                   # noqa: E402

CHECKS = []          # [(ok, title, detail)]
VERBOSE = False


def check(ok, title, detail=""):
    CHECKS.append((bool(ok), title, detail))
    if VERBOSE or not ok:
        print(("  [ok]   " if ok else "  [FAIL] ") + title + (f"  — {detail}" if detail else ""))
    return bool(ok)


def _dump(obj):
    """断言失败时打出来看的人话（中文不转义）"""
    try:
        return json.dumps(obj, ensure_ascii=False)
    except Exception:                                           # noqa: BLE001
        return str(obj)


def _v(pid, address, vtype="", write=None):
    """调一次 validate，失败时把异常也变成断言（不让自测自己崩）"""
    try:
        return comm.validate(pid, address, vtype=vtype, write=write), ""
    except Exception as e:                                      # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


# ─────────────────────────────────────────────
#  1) 目录 schema / 顺序 / 前缀表
# ─────────────────────────────────────────────
_INFO_KEYS = {"id", "name", "comm", "addr_profile", "default_address", "probe_address",
              "kind", "help", "prefixes", "examples"}
_PREFIX_KEYS = {"prefix", "label", "kind", "example", "types", "writable", "note"}
_PREFIX_KINDS = {"word", "bit", "bitword", "bits", "nodeid"}


def test_catalog():
    print("[1/6] 协议目录 schema（/api/comm/protocols）")
    items = comm.protocols()
    check(isinstance(items, list) and len(items) == 3,
          "目录里正好 3 条协议", str([x.get("id") for x in items]))
    ids = [x.get("id") for x in items]
    check(ids == ["modbus", "ts600", "opcua"],
          "顺序固定 modbus → ts600 → opcua", str(ids))

    for it in items:
        pid = it.get("id")
        miss = _INFO_KEYS - set(it)
        check(not miss, f"{pid} 目录字段齐全", str(sorted(miss)))
        check(it.get("kind") in ("element", "nodeid"),
              f"{pid} kind 是 element/nodeid", str(it.get("kind")))
        check(isinstance(it.get("prefixes"), list) and isinstance(it.get("examples"), list),
              f"{pid} prefixes/examples 是列表", _dump({k: it.get(k) for k in
              ("prefixes", "examples")})[:200])
        check(bool(it.get("help")) and bool(it.get("name")) and bool(it.get("comm")),
              f"{pid} name/comm/help 非空", _dump({k: it.get(k) for k in
              ("name", "comm", "help")}))
        # 同一个协议两次 info() 互不影响（注册表里的对象是单例，不能外泄引用）
        a, b = comm.info(pid), comm.info(pid)
        a["prefixes"].append({"prefix": "XXX"})
        check(len(b["prefixes"]) == len(it["prefixes"]),
              f"{pid} info() 每次新建 list（不污染注册表）", str(len(b["prefixes"])))
        for p in it["prefixes"]:
            pm = _PREFIX_KEYS - set(p)
            check(not pm, f"{pid} 前缀 {p.get('prefix')} 字段齐全", str(sorted(pm)))
            check(p.get("kind") in _PREFIX_KINDS,
                  f"{pid} 前缀 {p.get('prefix')} kind 合法", str(p.get("kind")))
            check(isinstance(p.get("types"), list) and isinstance(p.get("writable"), bool),
                  f"{pid} 前缀 {p.get('prefix')} types/writable 类型对", _dump(p)[:160])

    modbus_info, ts600_info, ua_info = items
    check(modbus_info["comm"] == "modbus-tcp" and modbus_info["addr_profile"] == "invt-modbus-slave"
          and modbus_info["default_address"] == "%MW0",
          "modbus 目录：modbus-tcp / invt-modbus-slave / %MW0",
          _dump({k: modbus_info.get(k) for k in ("comm", "addr_profile", "default_address")}))
    check(ts600_info["comm"] == "modbus-tcp" and ts600_info["addr_profile"] == "ts600-modbus-tcp"
          and ts600_info["default_address"] == "D0" and ts600_info["kind"] == "element",
          "ts600 目录：modbus-tcp / ts600-modbus-tcp / D0 / element",
          _dump({k: ts600_info.get(k) for k in
                 ("comm", "addr_profile", "default_address", "kind")}))
    check(ua_info["comm"] == "opcua" and ua_info["addr_profile"] == ""
          and ua_info["kind"] == "nodeid" and ua_info["prefixes"] == [],
          "opcua 目录：opcua / 空模型 / nodeid / 无前缀表",
          _dump({k: ua_info.get(k) for k in ("comm", "addr_profile", "kind", "prefixes")}))
    check(any("ns=" in x and "|var|" in x for x in ua_info["examples"]),
          "opcua 示例里有 CODESYS 风格的 |var| NodeId", _dump(ua_info["examples"]))

    ts_prefixes = {p["prefix"]: p for p in ts600_info["prefixes"]}
    check(set(ts_prefixes) == {"D", "R", "Z", "M", "S", "X", "Y", "T", "C"},
          "ts600 前缀表 = D/R/Z/M/S/X/Y/T/C", str(sorted(ts_prefixes)))
    check(ts_prefixes["X"]["writable"] is False and ts_prefixes["Y"]["writable"] is True,
          "ts600：X 只读、Y 可写",
          _dump({k: ts_prefixes[k]["writable"] for k in ("X", "Y")}))
    check(ts_prefixes["X"]["kind"] == "bit" and ts_prefixes["D"]["kind"] == "word"
          and ts_prefixes["T"]["kind"] == "bitword" and ts_prefixes["C"]["kind"] == "bitword",
          "ts600 前缀 kind：位=bit / 字=word / 定时器计数器=bitword",
          _dump({k: ts_prefixes[k]["kind"] for k in ("D", "X", "T", "C")}))
    check("8 进制" in (ts_prefixes["X"].get("note") or ""),
          "ts600 X 的前缀说明里写了「8 进制」", str(ts_prefixes["X"].get("note")))
    # T/C 是「触点 + 当前值」两副面孔：bool 走位区，数值走字区 —— 目录里必须写明白
    for k in ("T", "C"):
        note = ts_prefixes[k].get("note") or ""
        check("触点" in note and "当前值" in note,
              f"ts600 {k} 的 note 写清 bool=触点 / 数值=当前值", note)
    c_note = ts_prefixes["C"].get("note") or ""
    check("C0~C199" in c_note and "C200~C255" in c_note and "双字" in c_note,
          "ts600 C 的 note 标了 C0~C199 / C200~C255 双字", c_note)

    mb_prefixes = {p["prefix"]: p for p in modbus_info["prefixes"]}
    check({" %MW".strip(), "%MD", "%MB", "%MX", "%QW", "%QB", "%QD", "%QX",
           "%IX", "%IW", "%IB", "%ID"} <= set(mb_prefixes),
          "modbus 前缀表覆盖 %MW/%MD/%MB/%MX/%QW/%QB/%QD/%QX/%IX/%IW/%IB/%ID",
          str(sorted(mb_prefixes)))
    check(mb_prefixes["%IX"]["writable"] is False and mb_prefixes["%QW"]["kind"] == "bits",
          "modbus：%IX 只读、%QW 是位打包（bits）",
          _dump({k: (mb_prefixes[k]["writable"], mb_prefixes[k]["kind"]) for k in ("%IX", "%QW")}))
    check(bool(ts600_info.get("note")) and bool(modbus_info.get("note")),
          "ts600/modbus 带兼容写法 note", _dump({k: items[i].get("note") for i, k in
          ((0, "modbus"), (1, "ts600"))})[:160])

    # get/info/default_address/link_of/profile_of
    check(comm.get("ts600") is comm.get("ts600_tcp") is comm.get("ts"),
          "get() 认别名且拿到同一个协议对象（单例）")
    check(comm.default_address("modbus") == "%MW0" and comm.default_address("ts600") == "D0",
          "default_address：%MW0 / D0",
          comm.default_address("modbus") + " / " + comm.default_address("ts600"))
    check(comm.link_of("ts600") == "modbus-tcp" and comm.link_of("opcua") == "opcua",
          "link_of：TS600 也是 modbus-tcp", comm.link_of("ts600"))
    check(comm.profile_of("ts600") == "ts600-modbus-tcp" and comm.profile_of("opcua") == "",
          "profile_of：ts600-modbus-tcp / 空", comm.profile_of("ts600"))


# ─────────────────────────────────────────────
#  2) normalize：协议别名
# ─────────────────────────────────────────────
def test_normalize():
    print("[2/6] normalize（协议别名）")
    cases = {"": "modbus", "modbus": "modbus", "MODBUS": "modbus", "invt": "modbus",
             "invt-modbus-slave": "modbus", "modbus-tcp": "modbus",
             "ts": "ts600", "TS600": "ts600", "ts600_tcp": "ts600",
             "ts600-modbus-tcp": "ts600", "modbus_ts": "ts600", "modbus-ts": "ts600",
             "opcua": "opcua", "ua": "opcua", "opc-ua": "opcua"}
    for raw, want in cases.items():
        try:
            got = comm.normalize(raw)
        except Exception as e:                                  # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        check(got == want, f"normalize({raw!r}) → {want}", str(got))
    for bad in ("bogus", "s7", "modbus-rtu"):
        try:
            comm.normalize(bad)
            check(False, f"normalize({bad!r}) 应该抛 ValueError", "没抛")
        except ValueError as e:
            check("不认识" in str(e) and "modbus" in str(e) and "opcua" in str(e),
                  f"normalize({bad!r}) 抛 ValueError 且带可选列表", str(e))
        except Exception as e:                                  # noqa: BLE001
            check(False, f"normalize({bad!r}) 抛的不是 ValueError", f"{type(e).__name__}: {e}")
    try:
        comm.get("bogus")
        check(False, "get('bogus') 应该抛 ValueError", "没抛")
    except ValueError:
        check(True, "get('bogus') 抛 ValueError")

    # 落盘口径换算（datasource 用）
    check(comm.pid_for("modbus", "invt-modbus-slave") == "modbus",
          "pid_for(modbus + invt) → modbus")
    check(comm.pid_for("modbus", "ts600-modbus-tcp") == "ts600",
          "pid_for(modbus + ts600 模型) → ts600（老配置）")
    check(comm.pid_for("ts600", "") == "ts600", "pid_for(protocol=ts600) → ts600")
    check(comm.pid_for("opcua", "") == "opcua", "pid_for(opcua) → opcua")
    check(comm.pid_for("", "invt-modbus-slave") == "modbus", "pid_for(空 + invt) → modbus")


# ─────────────────────────────────────────────
#  3) validate 矩阵 —— TS600
# ─────────────────────────────────────────────
def _valid_rows(pid, rows):
    """rows: [(address, vtype, area, offset, words, prefix)] → 逐条断言 valid:true + 明细"""
    for address, vtype, area, offset, words, prefix in rows:
        r, err = _v(pid, address, vtype)
        if r is None:
            check(False, f"validate({pid}, {address!r}) 不该抛异常", err)
            continue
        a = r.get("address") or {}
        ok = (r.get("ok") is True and r.get("valid") is True and r.get("unsupported") is False
              and r.get("code") == "" and a.get("area") == area and a.get("offset") == offset
              and a.get("words") == words and r.get("prefix") == prefix)
        check(ok, f"validate({pid}, {address!r}, {vtype!r}) → {area} {offset}（{words} 字）",
              _dump({k: r.get(k) for k in ("valid", "unsupported", "code", "prefix")})
              + " addr=" + _dump(a))


def _model_rows(pid, addresses, vtype=""):
    """rows: 写法不属于这个协议 → valid:false / unsupported:true / code:"model" """
    for address in addresses:
        r, err = _v(pid, address, vtype)
        if r is None:
            check(False, f"validate({pid}, {address!r}) 不该抛异常", err)
            continue
        check(r.get("valid") is False and r.get("unsupported") is True and r.get("code") == "model"
              and bool(r.get("message")),
              f"validate({pid}, {address!r}) → 写法不匹配（内部变量）",
              _dump({k: r.get(k) for k in ("valid", "unsupported", "code", "message")}))


def _invalid_rows(pid, rows):
    """rows: [(address, vtype, 关键字)] → valid:false / code:"invalid" / 中文原因"""
    for address, vtype, keyword in rows:
        r, err = _v(pid, address, vtype)
        if r is None:
            check(False, f"validate({pid}, {address!r}) 不该抛异常", err)
            continue
        msg = r.get("message") or ""
        check(r.get("valid") is False and r.get("unsupported") is False and r.get("code") == "invalid"
              and keyword in msg,
              f"validate({pid}, {address!r}, {vtype!r}) → 非法（{keyword}）", msg)


def test_validate_ts600():
    print("[3/6] validate 矩阵 —— TS600")
    # 元件写法 + 兼容的 Modbus 写法（%MW / %W / %MD / HR / 4X / 纯数字都有效）
    _valid_rows("ts600", [
        ("D100", "uint", "holding", 100, 1, "D"),
        ("D100", "real", "holding", 100, 2, "D"),
        ("%MW100", "real", "holding", 100, 2, "MW"),
        ("%W100", "uint", "holding", 100, 1, "W"),
        ("%MD50", "uint", "holding", 100, 2, "MD"),
        ("HR100", "uint", "holding", 100, 1, "HR"),
        ("4X0100", "uint", "holding", 100, 1, "HR"),
        ("100", "uint", "holding", 100, 1, "HR"),
        ("M10", "bool", "coil", 10, 1, "M"),
        ("S10", "bool", "coil", 32778, 1, "S"),
        ("X17", "bool", "discrete", 40975, 1, "X"),
        ("Y10", "bool", "coil", 45064, 1, "Y"),
        ("T5", "bool", "coil", 49157, 1, "T"),
        ("T5", "int", "holding", 57349, 1, "T"),
        ("T5", "", "holding", 57349, 1, "T"),
        ("C5", "bool", "coil", 49669, 1, "C"),
        ("C5", "int", "holding", 57861, 1, "C"),
        ("C200", "bool", "coil", 49864, 1, "C"),
        ("C0", "bool", "coil", 49664, 1, "C"),
        ("C150", "int", "holding", 58006, 1, "C"),
        ("C200", "real", "holding", 58056, 2, "C"),
        ("R100", "uint", "holding", 32868, 1, "R"),
        ("Z3", "uint", "holding", 58371, 1, "Z"),
        ("D100[10]", "string", "holding", 100, 10, "D"),
    ])
    r, _ = _v("ts600", "X17", "bool")
    check(r and r.get("writable") is False and (r.get("address") or {}).get("readonly") is True,
          "X17 是只读输入（writable:false / readonly:true）",
          _dump({k: (r or {}).get(k) for k in ("writable", "address")})[:200])

    # TS600 没有字内取位 / 位打包 / 输入区地址 → 写法不匹配（不是错误）
    _model_rows("ts600", ["%MX0.0", "%QX0.0", "%QW0", "%QB1", "%IX5", "%IW5", "%IB3",
                          "%ID2", "%M100"])
    # 非法写法（真错）：八进制带 8/9、未映射的 R、类型不符、越区
    _invalid_rows("ts600", [
        ("Y18", "bool", "8 进制"),
        ("R20000", "uint", "R16384"),
        ("D100", "bool", "字元件"),
        ("D32767", "real", "超出"),
        ("C200", "int", "32 位"),
    ])
    r, _ = _v("ts600", "")
    check(r and r.get("valid") is False and r.get("code") == "empty"
          and "内部变量" in (r.get("message") or ""),
          "ts600 空地址 → code:empty（留空 = 内部变量）", _dump(r))
    r, _ = _v("ts600", "X17", "bool", write=True)
    check(r and r.get("valid") is True and r.get("writable") is False
          and (r.get("warning") or "").startswith("X 是输入元件"),
          "ts600 X17 + write → valid 但 writable:false + warning", _dump(r))


# ─────────────────────────────────────────────
#  4) validate 矩阵 —— Modbus(INVT) / OPC UA
# ─────────────────────────────────────────────
def test_validate_others():
    print("[4/6] validate 矩阵 —— Modbus（INVT）/ OPC UA")
    _valid_rows("modbus", [
        ("%MW100", "real", "holding", 100, 2, "MW"),
        ("%MW0", "uint", "holding", 0, 1, "MW"),
        ("%MD48", "uint", "holding", 96, 2, "MD"),
        ("%MB194", "uint", "holding", 97, 1, "MB"),
        ("%QX1.2", "bool", "coil", 10, 1, "QX"),
        ("%QW0", "int", "coil", 0, 1, "QW"),
        ("%IX0.0", "bool", "discrete", 0, 1, "IX"),
        ("%IW5", "int", "input_reg", 5, 1, "IW"),
        ("HR100", "uint", "holding", 100, 1, "HR"),
        ("4X0100", "uint", "holding", 100, 1, "HR"),
        ("40001", "uint", "holding", 0, 1, "HR"),
        ("100", "uint", "holding", 100, 1, "HR"),
    ])
    _model_rows("modbus", ["D100", "M10", "X17", "Y10", "T5", "C200", "S10", "R100", "Z3"])
    _invalid_rows("modbus", [("%MW70000", "uint", "65535")])
    r, _ = _v("modbus", "%IX0.0", "bool", write=True)
    check(r and r.get("valid") is True and r.get("writable") is False
          and "只能读" in (r.get("warning") or ""),
          "modbus %IX0.0 + write → valid 但 writable:false + warning", _dump(r))
    r, _ = _v("modbus", "")
    check(r and r.get("code") == "empty", "modbus 空地址 → code:empty", _dump(r))

    # OPC UA：NodeId 写法；Modbus/TS600 写法 = 协议选错了（按内部变量）
    rows = [("ns=4;s=PLC_PRG.x", ""), ("ns=4;i=1001", ""), ("PLC_PRG.x", "")]
    for address, vtype in rows:
        r, err = _v("opcua", address, vtype)
        if r is None:
            check(False, f"validate(opcua, {address!r}) 不该抛异常", err)
            continue
        a = r.get("address") or {}
        check(r.get("valid") is True and r.get("prefix") == "" and a.get("kind") == "nodeid"
              and str(a.get("nodeid", "")).startswith("ns="),
              f"validate(opcua, {address!r}) → 合法 NodeId", _dump(r)[:260])
    _model_rows("opcua", ["%MW100", "D100", "HR100"])
    r, _ = _v("opcua", "")
    check(r and r.get("code") == "empty", "opcua 空地址 → code:empty", _dump(r))
    r, _ = _v("opcua", "opc.tcp://127.0.0.1:4840")
    check(r and r.get("valid") is False and r.get("code") == "invalid"
          and "NodeId" in (r.get("message") or ""),
          "opcua 把端点填进地址 → invalid（提示要填 NodeId）", _dump(r))


# ─────────────────────────────────────────────
#  5) 老 /api/plc action=parse 形状兼容 + /api/comm/* 路由
# ─────────────────────────────────────────────
OLD_PARSE_KEYS = {"ok", "protocol", "area", "area_cn", "offset", "words", "bit", "byte",
                  "readonly", "kind", "profile", "words_for_type"}


def test_api():
    print("[5/6] api：老 /api/plc parse 形状 + /api/comm 路由")
    try:
        import core.api as api
    except Exception as e:                                      # noqa: BLE001
        check(False, "导入 core.api", f"{type(e).__name__}: {e}")
        return

    # ── /api/comm/protocols（GET，免登录）──
    status, p = api.dispatch("GET", "/api/comm/protocols", {}, {}, api.Ctx())
    check(status == 200 and p.get("ok") is True
          and [x.get("id") for x in (p.get("protocols") or [])] == ["modbus", "ts600", "opcua"],
          "GET /api/comm/protocols → {ok, protocols×3, current}",
          _dump({k: (p.get(k) if k != "protocols" else [x.get("id") for x in p[k]]) for k in p}))
    cur = p.get("current") or {}
    check(cur.get("protocol") in ("modbus", "ts600", "opcua") and "addr_profile" in cur,
          "current 带 protocol/addr_profile", _dump(cur))

    # ── /api/comm/validate（POST，免登录）──
    status, p = api.dispatch("POST", "/api/comm/validate", {}, 
                             {"protocol": "ts600", "address": "D100", "vtype": "real"}, api.Ctx())
    check(status == 200 and p.get("valid") is True and (p.get("address") or {}).get("offset") == 100,
          "POST /api/comm/validate（ts600 D100）→ valid", _dump(p)[:260])
    status, p = api.dispatch("POST", "/api/comm/validate", {},
                             {"protocol": "bogus", "address": "D100"}, api.Ctx())
    check(status == 400 and p.get("ok") is False and "可选" in (p.get("error") or ""),
          "POST /api/comm/validate（未知协议）→ 400 + 可选列表", _dump(p))
    check("/api/comm/protocols" in api.DEVICE_PATHS
          and "/api/comm/validate" in api.DEVICE_PATHS,
          "两条新路径都在 DEVICE_PATHS（免登录）", _dump(api.DEVICE_PATHS))

    # ── 老 /api/plc action=parse：形状一个字都不能变 ──
    status, p = api._ep_plc({"action": "parse", "address": "D100", "vtype": "real",
                             "addr_profile": "ts600"})
    check(status == 200 and p.get("ok") is True and p.get("protocol") == "modbus",
          "老 parse（ts600 D100 real）→ ok", _dump(p))
    check(set(p) == OLD_PARSE_KEYS, "老 parse 字段集合完全没变", str(sorted(set(p) ^ OLD_PARSE_KEYS)))
    check(p.get("area") == "holding" and p.get("offset") == 100 and p.get("words") == 2
          and p.get("words_for_type") == 2,
          "老 parse：area/offset/words/words_for_type（D100 real = 2 字）",
          _dump({k: p.get(k) for k in ("area", "offset", "words", "words_for_type")}))
    check(p.get("area_cn") == modbus.AREA_CN["holding"],
          "老 parse 的 area_cn 还是长名（和 addr_model.AREA_CN 一致）",
          f'{p.get("area_cn")} != {modbus.AREA_CN["holding"]}')
    check(p.get("profile") == "ts600-modbus-tcp" and p.get("readonly") is False,
          "老 parse：profile/readonly", _dump({k: p.get(k) for k in ("profile", "readonly")}))

    status, p = api._ep_plc({"action": "parse", "address": "%MW96", "vtype": "uint",
                             "protocol": "modbus", "addr_profile": "invt"})
    check(p.get("ok") is True and p.get("offset") == 96 and p.get("area") == "holding"
          and p.get("profile") == "invt-modbus-slave",
          "老 parse（INVT %MW96）→ holding 96", _dump(p))

    status, p = api._ep_plc({"action": "parse", "address": "X17", "vtype": "bool",
                             "addr_profile": "ts600"})
    check(p.get("ok") is True and p.get("readonly") is True and p.get("offset") == 40975
          and p.get("area") == "discrete",
          "老 parse（X17）→ discrete 40975 readonly", _dump(p))

    status, p = api._ep_plc({"action": "parse", "protocol": "modbus", "address": "D100",
                             "addr_profile": "invt"})
    check(status == 200 and p.get("ok") is False and p.get("unsupported") is True
          and p.get("profile") == "invt-modbus-slave" and bool(p.get("message")),
          "老 parse（INVT 下写 D100）→ ok:false/unsupported（不报错）", _dump(p))

    status, p = api._ep_plc({"action": "parse", "protocol": "ts600", "address": "D32767",
                             "vtype": "real"})
    check(p.get("ok") is False and not p.get("unsupported")
          and ("超出" in (p.get("message") or "") or "越区" in (p.get("message") or "")),
          "老 parse（越区）→ ok:false + 中文原因", _dump(p))

    status, p = api._ep_plc({"action": "parse", "protocol": "ts600", "address": ""})
    check(status == 200 and p.get("ok") is False and p.get("message") == "地址为空",
          "老 parse（空地址）→ 还是那句「地址为空」", _dump(p))

    if api.opcua is not None:
        status, p = api._ep_plc({"action": "parse", "protocol": "opcua",
                                 "address": "ns=4;s=PLC_PRG.x"})
        check(p.get("ok") is True and p.get("protocol") == "opcua"
              and p.get("ns") == 4 and p.get("ident") == "PLC_PRG.x" and p.get("describe"),
              "老 parse（OPC UA NodeId）→ ns/kind/ident/nodeid/describe", _dump(p))

    check(modbus.get_profile() == "invt-modbus-slave",
          "parse 用完把地址模型切回原样", modbus.get_profile())


# ─────────────────────────────────────────────
#  6) make_source：返回现成的 PlcSource / OpcUaSource（不搬类）
# ─────────────────────────────────────────────
def test_make_source():
    print("[6/6] make_source（薄适配，返回 PlcSource / OpcUaSource）")
    import core.plcsource as plcsource
    from core.plcsource import PlcSource

    cur = modbus.get_profile()
    try:
        src = comm.make_source("ts600", {"ip": "127.0.0.1", "port": 502, "unit": 1})
        check(isinstance(src, PlcSource), "make_source('ts600') 返回 PlcSource",
              type(src).__name__)
        check(modbus.get_profile() == "ts600-modbus-tcp",
              "make_source('ts600') 把当前模型切成 ts600（连上就该按它解析）",
              modbus.get_profile())
        # 建源后马上 declare（datasource.plc_connect 的用法）：D100 必须按 TS600 解析
        src.declare([{"name": "d100", "type": "uint", "address": "D100"},
                     {"name": "x17", "type": "bool", "address": "X17"}])
        v = getattr(src, "_vars", {}).get("d100") or {}
        parsed = v.get("parsed")
        check(parsed is not None and getattr(parsed, "offset", -1) == 100,
              "declare 后 D100 按 TS600 解析 offset=100", str(parsed))
        vx = getattr(src, "_vars", {}).get("x17") or {}
        check(getattr(vx.get("parsed"), "readonly", None) is True,
              "declare 后 X17 解析成只读输入", str(vx.get("parsed")))

        # 协议=ts600 时不管配置里带什么 addr_profile 都按 TS600（force_profile）
        src2 = comm.make_source("ts600", {"addr_profile": "invt-modbus-slave"})
        check(isinstance(src2, PlcSource) and modbus.get_profile() == "ts600-modbus-tcp",
              "make_source('ts600') 忽略配置里的 invt 模型（force_profile）",
              modbus.get_profile())

        src3 = comm.make_source("modbus", {"addr_profile": "invt-modbus-slave"})
        check(isinstance(src3, PlcSource) and modbus.get_profile() == "invt-modbus-slave",
              "make_source('modbus') 返回 PlcSource 并切回 invt 模型", modbus.get_profile())
        src3.declare([{"name": "mw96", "type": "uint", "address": "%MW96"}])
        v = getattr(src3, "_vars", {}).get("mw96") or {}
        check(getattr(v.get("parsed"), "offset", -1) == 96,
              "make_source('modbus') 后 %MW96 → offset 96", str(v.get("parsed")))

        # OPC UA：装了 asyncua 就返回 OpcUaSource；没装就是那句「没有可用的 asyncua」
        ua = plcsource.OpcUaSource
        try:
            src4 = comm.make_source("opcua", {"endpoint": "opc.tcp://127.0.0.1:4840"})
            check(ua is not None and isinstance(src4, ua) if ua else src4 is not None,
                  "make_source('opcua') 返回 OpcUaSource（asyncua 已装）", type(src4).__name__)
        except ValueError as e:
            check(ua is None and "asyncua" in str(e),
                  "make_source('opcua') 没装 asyncua → ValueError 提示安装", str(e))
    finally:
        # 别把模型留在测试里：后面的用例/别的进程不受影响（本进程内恢复）
        modbus.set_profile(cur)


# ─────────────────────────────────────────────
#  入口
# ─────────────────────────────────────────────
def main():
    global VERBOSE
    ap = argparse.ArgumentParser(description="通讯协议注册表后端自测（server/comm/）")
    ap.add_argument("-v", "--verbose", action="store_true", help="每条断言都打印")
    args = ap.parse_args()
    VERBOSE = bool(args.verbose)

    print(f"通讯协议注册表自测（repo {ROOT}）")
    test_catalog()
    test_normalize()
    test_validate_ts600()
    test_validate_others()
    test_api()
    test_make_source()

    bad = [c for c in CHECKS if not c[0]]
    print("")
    if bad:
        print(f"结果：{len(CHECKS) - len(bad)}/{len(CHECKS)} 项通过，{len(bad)} 项失败：")
        for _ok, title, detail in bad:
            print(f"  [FAIL] {title}" + (f"  — {detail}" if detail else ""))
        print("通讯协议注册表自测：失败")
        return 1
    print(f"结果：{len(CHECKS)}/{len(CHECKS)} 项通过")
    print("通讯协议注册表自测：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
