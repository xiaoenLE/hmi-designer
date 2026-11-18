#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
opcua.py — OPC UA 客户端数据源（asyncua）
========================================================================
和 modbus.py 的定位一样：给 server.py 当一个 DataSource，只是协议换成 OPC UA。
与 Modbus 那套的区别（现场要记住的几条）：

    Modbus                      OPC UA
    ─────────────────────────   ──────────────────────────────────────────
    地址是「寄存器号」%MW100     地址是「NodeId」ns=4;s=|var|CODESYS ...PLC_PRG.x
    地址能手写、有规律           NodeId 没规律 → 用「从服务器导入变量」勾选
    字长/字序要自己配（real=2字）类型由服务器给（Float/Double/Int16...），
                               没有字序问题，没有 %MD 这种写法
    一次读连续寄存器区块         一次 Request 可以读多个节点（批量读）

依赖：asyncua（OPC UA 协议栈）。**必须装 1.x**：
    python -m pip install "asyncua<2"
原因：本机 `py -3` 是 Python 3.10.0b1（2021 年的 beta），asyncua 2.x 的
二进制序列化在它上面会直接抛 TypeError（见文件末尾 _UNIONTYPE_SHIM 的说明）；
1.1.5 实测可用。没装 asyncua 时本模块的 AVAILABLE = False，
server.py 会明确告诉前端「装了才能用 OPC UA」，Modbus 那条路照旧不受影响。

安全策略：v1 只做 SecurityPolicy **None**（CODESYS/Invtmatic 内置 OPC UA Server
默认就是这个，配匿名或用户名密码）。Sign&Encrypt 需要证书，留作后续扩展点
（见 set_security 那一段的注释）。
"""
import asyncio
import re
import socket
import threading
import time
import types
import re
import xml.etree.ElementTree as ET

# ── 兼容补丁：必须在 import asyncua 之前 ──────────────────────────────
# Python 3.10.0b1（本机 py -3）没有 types.UnionType（正式版 3.10 才有），
# 而 typing_extensions ≥4.13 在导入时就会用到它 → 直接 AttributeError。
# ⚠ 这里补的是一个**谁也匹配不上的哨兵类**，不是 types.Union、也不是 type(int | str)：
#   3.10.0b1 里 `int | str` 造出来的就是 types.Union 的实例，而它没有 __parameters__；
#   typing_extensions._collect_type_vars 一 isinstance 到它就去读 __parameters__，
#   于是 `AttributeError: 'types.Union' object has no attribute '__parameters__'`
#   —— pycparser（→ cffi → clr_loader → pythonnet → pywebview）那条链就是这么炸的。
#   哨兵不匹配 → 这段分支直接跳过，谁都不炸。
# 3.10 正式版及以上这个分支不会执行。
if not hasattr(types, "UnionType"):
    types.UnionType = type("UnionType", (), {})

AVAILABLE = True
IMPORT_ERROR = ""
try:
    from asyncua import Client, ua
except Exception as _e:                      # noqa: BLE001  （缺包 / 版本不对）
    AVAILABLE = False
    IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

INSTALL_HINT = 'python -m pip install "asyncua<2"'

DEFAULT_ENDPOINT = "opc.tcp://127.0.0.1:4840"
DEFAULT_NS = 4          # CODESYS 内置 OPC UA Server 里应用符号一般在 ns=4
BATCH_NODES = 250       # 一次 Read 请求最多带多少个节点（"块"的概念在这里）

# ─────────────────────────────────────────────
#  CODESYS / Invtmatic 「符号配置」导出文件（.xml）离线导入
# ─────────────────────────────────────────────
# CODESYS 的 OPC UA 符号是「符号配置（Symbol Configuration）」对象里勾出来的，
# 这个对象可以导出成一份 XML（Invtmatic Studio 里：右键符号配置 → 导出符号配置）：
#
#   <Symbolconfiguration xmlns="http://www.3s-software.com/schemas/Symbolconfiguration.xsd">
#     <Header><ProjectInfo name="OPCUA" devicename="Device" appname="Application"/></Header>
#     <TypeList><TypeSimple name="T_BOOL" typeclass="Bool" iecname="BOOL"/>…</TypeList>
#     <NodeList><Node name="Application"><Node name="GVL">
#         <Node name="a" type="T_INT" access="ReadWrite"/>
#     </Node></Node></NodeList>
#   </Symbolconfiguration>
#
# 有了它就能**不连服务器**把地址导进来：符号路径 + IEC 类型都在文件里，
# NodeId 按 CODESYS 的约定拼出来即可：
#     ns=4;s=|var|<设备名>.<应用名>.<POU>.<符号>
# （ns 的序号由服务器运行时决定，CODESYS 一般是 4 —— 对话框里可改「默认命名空间」）

# IEC 类型（TypeSimple 的 iecname / typeclass）→ 变量表那 8 种类型
#  ⚠ STRING 和 WSTRING 在 OPC UA 侧都是 UA String（服务器自己转），但落到变量表要分开：
#    Modbus 那边 STRING 是「2 字符 1 个寄存器」、WSTRING 是「1 个宽字符 1 个寄存器」，
#    混成一个 string 会让 %MW 段的字数算错。变量表里 string/wstring 各有独立类型。
IEC2HMI = {
    "BOOL": "bool", "BIT": "bool",
    "SINT": "int", "INT": "int", "DINT": "dint", "LINT": "dint",
    "USINT": "uint", "UINT": "uint", "UDINT": "udint", "ULINT": "udint",
    "BYTE": "uint", "WORD": "uint", "DWORD": "udint", "LWORD": "udint",
    "REAL": "real", "LREAL": "lreal",
    "STRING": "string", "CHAR": "string",
    "WSTRING": "wstring", "WCHAR": "wstring",
}
# typeclass（XML 里没有 iecname 时用）→ 变量表类型
TYPECLASS2HMI = {
    "Bool": "bool", "Int": "int", "UInt": "uint", "DInt": "dint", "UDInt": "udint",
    "Real": "real", "LReal": "lreal", "String": "string", "WString": "wstring",
    "Byte": "uint", "Word": "uint", "DWord": "udint", "LWord": "udint",
}
# 这些 IEC 类型在变量表里没有对应项：按最近的类型放，并在导入结果里说明
IEC_FALLBACK = {
    "TIME": "dint", "TIME_OF_DAY": "udint", "TOD": "udint", "DATE": "udint",
    "DATE_AND_TIME": "udint", "DT": "udint", "LTIME": "dint",
}


def _local(tag):
    """去掉 XML 命名空间前缀（CODESYS 导出带默认 xmlns，按本地名匹配最省事）"""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_all(root, name):
    return [el for el in root.iter() if _local(el.tag) == name]


def parse_symbol_config_xml(text, device="", app="", ns=DEFAULT_NS, include_complex=False):
    """解析 CODESYS/Invtmatic 导出的「符号配置」XML → 变量清单（离线，不连服务器）。

    返回 {ok, project, device, app, ns, nodes:[{name, path, nodeid, iec, ua_type, hmi_type,
          writable, complex}], skipped:[{path, why}], message}
    """
    s = (text or "").strip()
    if not s:
        return {"ok": False, "message": "文件是空的", "nodes": []}
    try:
        root = ET.fromstring(s)
    except ET.ParseError as e:
        return {"ok": False, "message": f"XML 解析失败：{e}（确认导出的是「符号配置」XML）", "nodes": []}
    if _local(root.tag) != "Symbolconfiguration":
        got = _local(root.tag)
        hint = ""
        if got == "UANodeSet":
            hint = "；这是 OPC UA 的 NodeSet 文件，不是 CODESYS 的符号配置导出"
        return {"ok": False, "message": f"不是 CODESYS 符号配置 XML（根节点是 {got}{hint}）", "nodes": []}

    # ── 头部：工程名 / 设备名 / 应用名（NodeId 要用它们拼）──
    proj = dev = appname = ""
    for pi in _find_all(root, "ProjectInfo"):
        proj = pi.get("name", "") or proj
        dev = pi.get("devicename", "") or dev
        appname = pi.get("appname", "") or appname
    device = (device or dev).strip()
    app = (app or appname).strip()
    version = ""
    for v in _find_all(root, "Version"):
        version = (v.text or "").strip()
        break

    # ── 类型表：T_XXX → IEC 名 / 基类型 / 数组元素个数 ──
    # 结构：{类型名: {iec, cls, base, count}}；TypeArray/TypeDerived 要跟到基类型，
    # 不然数组符号（T_ARRAY__1__13__OF_INT）只能靠名字猜元素类型
    tmap = {}

    def add_type(el, cls_default=""):
        nm = el.get("name", "")
        if not nm:
            return
        dims = []
        for d in el:
            if _local(d.tag) == "ArrayDim":
                try:
                    dims.append((int(d.get("minrange", 0)), int(d.get("maxrange", 0))))
                except (TypeError, ValueError):
                    pass
        count = 1
        for lo, hi in dims:
            count *= max(0, hi - lo + 1)
        tmap[nm] = {
            "iec": (el.get("iecname") or "").upper(),
            "cls": el.get("typeclass", "") or cls_default,
            "base": el.get("basetype", "") or el.get("basedtype", ""),
            "count": count if dims else 0,
            "dims": len(dims),
            "size": el.get("size", ""),
        }

    for el in root.iter():
        tag = _local(el.tag)
        if tag in ("TypeSimple", "TypeDerived", "TypeArray", "TypeStruct", "TypePointer"):
            add_type(el, "Array" if tag == "TypeArray" else ("Struct" if tag == "TypeStruct" else ""))

    def type_info(type_name, node_el=None):
        """type 引用 → {label, hmi, complex, elems, dims, len}
        · 数组：hmi=元素类型、elems=元素个数、dims=维度
        · 字符串：len=声明的字符数（TypeSimple 的 size：STRING 81 字节 → 80 字符；
          WSTRING 162 字节 → 80 个宽字符）—— 导入时直接把它填进变量表「长度」列，
          不用手填，Modbus 那边算字数也不会错。"""
        out = {"label": "", "hmi": "dint", "complex": False, "elems": 0, "dims": 0, "len": 0}
        entry = tmap.get(type_name or "")
        if entry:
            cls = entry["cls"]
            if cls in ("Array", "Struct") or (entry["base"] and cls != "Pointer"):
                base = {"hmi": "dint", "label": "", "len": 0}
                if entry["base"]:
                    base = type_info(entry["base"])
                label = entry["iec"] or cls.upper() + (" OF " + base["label"] if base["label"] else "")
                if cls == "Struct":
                    return {**out, "label": label or "STRUCT", "hmi": base["hmi"], "complex": True}
                return {**out, "label": label or "ARRAY", "hmi": base["hmi"], "complex": True,
                        "elems": int(entry["count"] or 0), "dims": int(entry["dims"] or 1),
                        "len": base.get("len", 0)}
            if entry["iec"]:
                hmi = IEC2HMI.get(entry["iec"]) or IEC_FALLBACK.get(entry["iec"])
                if hmi:
                    return {**out, "label": entry["iec"], "hmi": hmi,
                            "len": _str_len_of(entry["iec"], entry.get("size"))}
                return {**out, "label": entry["iec"], "hmi": "dint"}
            if entry["cls"] in TYPECLASS2HMI:
                hmi = TYPECLASS2HMI[entry["cls"]]
                return {**out, "label": entry["cls"].upper(), "hmi": hmi,
                        "len": _str_len_of(entry["cls"].upper(), entry.get("size"))}
        # 类型表里没有：拿类型名硬猜（老版本导出 / 手改过的文件）
        iec = (type_name or "").replace("T_", "").upper()
        if "ARRAY" in iec:
            m = re.search(r"OF_?([A-Z]+)$", iec)
            elem = m.group(1) if m else ""
            return {**out, "label": iec, "hmi": IEC2HMI.get(elem, "dint"), "complex": True,
                    "elems": _array_elems(iec), "dims": 1, "len": _str_len_of(elem, None)}
        if iec in IEC2HMI:
            return {**out, "label": iec, "hmi": IEC2HMI[iec], "len": _str_len_of(iec, None)}
        if iec in IEC_FALLBACK:
            return {**out, "label": iec, "hmi": IEC_FALLBACK[iec]}
        if node_el is not None:
            tc = node_el.get("typeclass", "")
            if tc in TYPECLASS2HMI:
                hmi = TYPECLASS2HMI[tc]
                return {**out, "label": tc.upper(), "hmi": hmi,
                        "len": _str_len_of(tc.upper(), node_el.get("size"))}
        return {**out, "label": iec}

    nodes, skipped = [], []

    def walk(el, path):
        for child in el:
            if _local(child.tag) != "Node":
                continue
            nm = child.get("name", "") or ""
            kids = [k for k in child if _local(k.tag) == "Node"]
            here = path + [nm]
            type_name = child.get("type", "")
            ti = type_info(type_name, child)
            iec, hmi, complex_, elems, dims = ti["label"], ti["hmi"], ti["complex"], ti["elems"], ti["dims"]
            access = (child.get("access", "") or "").lower()
            if kids:
                # 有子节点 = 数组（元素名 [0] [1]…）/ 结构体 / POU
                is_array = all((k.get("name", "") or "").startswith("[") for k in kids)
                if is_array:
                    n = elems or len(kids)
                    nodes.append(_mk_node(device, app, here, iec, hmi, access, "array", n, dims or 1))
                    continue
                walk(child, here)                     # 结构体/POU：继续往下走
                continue
            if complex_:
                if "ARRAY" in (iec or "").upper():
                    # 数组：变量表里表达成 `元素类型[]` + 元素个数（一维直接用，多维标出来不默认勾）
                    kind = "array" if (dims or 1) <= 1 else "array_multi"
                    nodes.append(_mk_node(device, app, here, iec, hmi, access, kind, elems, dims or 1))
                else:
                    nodes.append(_mk_node(device, app, here, iec, hmi, access, "struct", 0, 0))
                continue
            nodes.append(_mk_node(device, app, here, iec, hmi, access, "", 0, 0, ti["len"]))

    nodelist = _find_all(root, "NodeList")
    for nl in nodelist:
        for top in nl:
            if _local(top.tag) != "Node":
                continue
            top_name = top.get("name", "") or ""
            # 顶层那个节点就是应用（Application）：它不算路径的一段，
            # 否则拼出来会变成 |var|设备.Application.Application.GVL.a（多一层）
            walk(top, [] if top_name == app else [top_name])
    # POU 那层（Application/GVL/...）：路径里第一段如果是应用名就去掉，导入的名字更短
    for n in nodes:
        parts = n["path"].split(".")
        if parts and parts[0] == app:
            n["path"] = ".".join(parts[1:])
        n["nodeid"] = f"ns={int(ns)};s={n['symbol']}"     # 命名空间按配置（默认 4）

    return {
        "ok": True, "project": proj, "device": device, "app": app, "ns": int(ns),
        "version": version, "nodes": nodes, "skipped": skipped,
        "message": f"符号配置 XML：工程 {proj or '?'}，设备 {device or '?'}，"
                   f"应用 {app or '?'}，共 {len(nodes)} 个符号"
                   + (f"（跳过 {len(skipped)} 个数组/结构体）" if skipped else ""),
    }


def _str_len_of(iec, size):
    """字符串声明了多少个字符 —— 从 TypeSimple 的 size（字节数）反推。

    CODESYS：STRING(80) 的 size=81（80 字符 + 结束符）、WSTRING(80) 的 size=162
    （80 个宽字符 × 2 字节 + 结束符）。导入时把它填进变量表「长度」列，
    现场就不用自己去数 PLC 里声明了多长（Modbus 那边算占几个寄存器也要它）。"""
    t = (iec or "").upper()
    if not size:
        return 0
    try:
        n = int(size)
    except (TypeError, ValueError):
        return 0
    if t.startswith("WSTRING") or t.startswith("WCHAR"):
        return max(1, n // 2 - 1)
    if t.startswith("STRING") or t.startswith("CHAR"):
        return max(1, n - 1)
    return 0


def _mk_node(device, app, path_parts, iec, hmi, access, kind="", elems=0, dims=1, str_len=0):
    """把符号路径拼成变量条目：NodeId 按 CODESYS 约定 |var|设备.应用.POU.符号

    kind：'' 标量 / 'array' 一维数组（变量表里是 `元素类型[]` + 元素个数）/ 'array_multi' 多维 /
          'struct' 结构体（变量表放不下，列出来但不勾）。"""
    symbol = "|var|" + ".".join([p for p in [device, app] if p] + list(path_parts))
    if kind.startswith("array") and not elems:
        elems = _array_elems(iec)
    if kind == "array":
        hmi_type = f"{hmi}[]"
        complex_ = False                     # 一维数组现在支持了 → 导入时默认就勾上
    else:
        hmi_type = hmi
        complex_ = bool(kind)                # 结构体 / 多维数组：列出来但不默认勾
    # 字符串长度：一维字符串数组按元素长度；标量字符串按声明长度
    if hmi_type in ("string", "wstring") and not str_len:
        str_len = 0
    return {
        "name": path_parts[-1],
        "path": ".".join(path_parts),
        "symbol": symbol,
        "nodeid": f"ns={DEFAULT_NS};s={symbol}",      # ns 由 parse_symbol_config_xml 按配置覆盖
        "iec": iec, "ua_type": iec, "hmi_type": hmi_type,
        "elem_type": hmi, "elements": int(elems or 0), "dims": int(dims or 1),
        "is_array": kind.startswith("array"),
        # 字符串声明的字符数（导入时填进变量表「长度」列）；其它类型是 0
        "len": int(str_len or 0),
        "writable": access != "readonly",
        "complex": complex_,
    }


def _array_elems(iec):
    """ARRAY__1__13__OF_INT → 13（CODESYS 的数组类型名里带着上下界）。

    有了这个数，模拟器就能按真机那样建一个长度一致的数组节点（方便验「数组节点」，
    变量表本身不放数组，导入时默认跳过）。"""
    m = re.search(r"ARRAY__(-?\d+)__(-?\d+)", iec or "")
    if m:
        try:
            lo, hi = int(m.group(1)), int(m.group(2))
            return max(0, hi - lo + 1)
        except ValueError:
            return 0
    return 0


# ─────────────────────────────────────────────
#  类型映射：OPC UA VariantType ↔ 变量表类型
# ─────────────────────────────────────────────
# 变量表里那 8 种类型是现场习惯（跟 Modbus 那边一致），UA 的类型更细，
# 导入变量时按这张表翻译；读回来的值也照变量表的类型收敛一下，
# 免得 Int32 的 3 在界面上变成 "3"（字符串）或者 Float 出现浮点尾巴。
_VT2HMI = {}


def _vt_name(vt):
    return getattr(vt, "name", str(vt))


def _init_type_table():
    if not AVAILABLE:
        return
    pairs = [
        (ua.VariantType.Boolean, "bool"),
        (ua.VariantType.SByte, "int"), (ua.VariantType.Int16, "int"),
        (ua.VariantType.Byte, "uint"), (ua.VariantType.UInt16, "uint"),
        (ua.VariantType.Int32, "dint"), (ua.VariantType.UInt32, "udint"),
        (ua.VariantType.Int64, "dint"), (ua.VariantType.UInt64, "udint"),
        (ua.VariantType.Float, "real"), (ua.VariantType.Double, "lreal"),
        (ua.VariantType.String, "string"), (ua.VariantType.DateTime, "string"),
        (ua.VariantType.Guid, "string"), (ua.VariantType.ByteString, "string"),
    ]
    for vt, hmi in pairs:
        _VT2HMI[_vt_name(vt)] = hmi


_init_type_table()

# 变量表类型 → 写节点时用的 VariantType（节点自己的类型优先，这只是兜底）
_HMI2VT = {}


def _init_hmi_table():
    if not AVAILABLE:
        return
    pairs = [
        ("bool", ua.VariantType.Boolean),
        ("int", ua.VariantType.Int16), ("uint", ua.VariantType.UInt16),
        ("dint", ua.VariantType.Int32), ("udint", ua.VariantType.UInt32),
        ("real", ua.VariantType.Float), ("lreal", ua.VariantType.Double),
        ("string", ua.VariantType.String),
    ]
    _HMI2VT.update(pairs)


_init_hmi_table()


def hmi_type_of_variant(vt_name):
    """UA 类型名 → 变量表类型（认不出就当 real；数组/结构体由调用方另作处理）"""
    return _VT2HMI.get(str(vt_name), "real")


def ua_variant_name(vt):
    return _vt_name(vt)


# ─────────────────────────────────────────────
#  NodeId：解析 / 归一化 / 说人话
# ─────────────────────────────────────────────
# 认这几种写法（其余一律报错，不猜 —— 猜错了写错节点比报错危险得多）：
#   ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.x   ← CODESYS 导入出来的样子
#   ns=2;i=1001            数值型
#   ns=2;g=...             16 字节 GUID
#   ns=2;b=base64          不透明字节串
#   s=PLC_PRG.x / i=1001   省了 ns= → 用配置里的「默认命名空间」
#   |var|CODESYS ... .x    直接粘贴 CODESYS 的符号（没带 ns= 也一样认）
_NS_RE = re.compile(r"^ns=(\d+)\s*;\s*(.*)$", re.IGNORECASE)
# ⚠ 标识类型有 4 种：s 字符串 / i 数值 / g GUID / b 字节串。
#   少写一个字母（比如漏了 i）会把 "i=1001" 当成字符串标识，NodeId 就悄悄拼错了
_IDENT_RE = re.compile(r"^([sSiIgGbB])\s*=\s*(.+)$")


def parse_node_id(raw, default_ns=DEFAULT_NS):
    """把用户/导入来的写法归一化成 'ns=N;<s|i|g|b>=...'；认不出抛 ValueError（带人话原因）"""
    s = str(raw or "").strip()
    if not s:
        raise ValueError("没填 NodeId")
    if s.lower().startswith("opc.tcp://"):
        raise ValueError("这里要填的是 NodeId（如 ns=4;s=PLC_PRG.x），不是端点地址")
    ns = None
    m = _NS_RE.match(s)
    if m:
        ns = int(m.group(1))
        s = m.group(2).strip()
    # '' 这种写法：ns 已给，剩下的是标识
    m2 = _IDENT_RE.match(s)
    if m2:
        kind = m2.group(1).lower()
        ident = m2.group(2).strip()
    else:
        # 裸 CODESYS 符号（|var|Device.Application.PLC_PRG.x）：当成字符串标识
        kind, ident = "s", s
    if not ident:
        raise ValueError("NodeId 的标识部分是空的")
    if ns is None:
        ns = int(default_ns if default_ns is not None else DEFAULT_NS)
    if kind == "i":
        if not ident.isdigit():
            raise ValueError(f"数值型 NodeId 的 i= 后面要是数字：{ident!r}")
    return f"ns={ns};{kind}={ident}"


def split_node_id(raw, default_ns=DEFAULT_NS):
    """归一化后的 NodeId 拆成 (ns, kind, ident)，用于展示/提示"""
    s = parse_node_id(raw, default_ns)
    m = _NS_RE.match(s)
    ns = int(m.group(1))
    k, ident = _IDENT_RE.match(m.group(2).strip()).groups()
    return ns, k.lower(), ident


def describe_node_id(raw, default_ns=DEFAULT_NS):
    """变量表地址格里那句提示：这个 NodeId 是什么、CODESYS 符号长什么样"""
    try:
        ns, kind, ident = split_node_id(raw, default_ns)
    except ValueError as e:
        return f"⚠ OPC UA NodeId 认不出：{e}（写法 ns=4;s=符号名 / ns=2;i=1001）"
    kind_cn = {"s": "字符串", "i": "数值", "g": "GUID", "b": "字节串"}.get(kind, kind)
    extra = ""
    if str(ident).startswith("|var|"):
        # |var|设备名.Application.PLC_PRG.x → 拆出 PLC 变量名，现场看着亲切
        parts = str(ident).split(".")
        extra = f"　符号：{'.'.join(parts[-2:]) if len(parts) >= 2 else ident}"
    elif kind == "s" and "|" not in str(ident):
        extra = f"　符号：{ident}"
    return (f"OPC UA NodeId：命名空间 ns={ns}，{kind_cn}标识"
            f"（{str(ident)[:60]}{'…' if len(str(ident)) > 60 else ''}）{extra}")


def is_opcua_addr(raw):
    """看着像 OPC UA NodeId 而不是 Modbus 地址（前端判断该按哪种规则校验/归一化）"""
    s = str(raw or "").strip()
    if not s:
        return False
    if re.match(r"^ns=\d+\s*;", s, re.IGNORECASE):
        return True
    if re.match(r"^[sigb]\s*=", s, re.IGNORECASE) and not re.match(r"^%", s):
        return True
    return s.startswith("|var|")


def norm_endpoint(ep):
    """端点归一化：允许只填 IP 或 IP:4840（现场常见），补成 opc.tcp://IP:4840"""
    s = str(ep or "").strip()
    if not s:
        return DEFAULT_ENDPOINT
    if s.lower().startswith(("opc.tcp://", "opc.https://", "https://", "opc.wss://")):
        return s
    if "://" in s:
        return s
    s = s.rstrip("/")
    if ":" not in s:
        s += ":4840"
    return "opc.tcp://" + s


def _close(sock_like):
    try:
        sock_like.close()
    except Exception:                       # noqa: BLE001
        pass


def _tcp_probe(host, port, timeout=1.5):
    """先做一次纯 TCP 探测：连不上时能给出比 UA 栈更直白的原因（端口/防火墙/IP）"""
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True, ""
    except OSError as e:
        return False, f"TCP 连不上 {host}:{port}（{e.strerror or e}）—— 确认服务在跑、IP/端口对、防火墙放行"


def endpoint_host_port(endpoint):
    s = norm_endpoint(endpoint)
    body = s.split("://", 1)[-1]
    host = body.split("/", 1)[0]
    if host.startswith("["):                                  # IPv6
        h, _, p = host[1:].partition("]")
        port = (p or "").lstrip(":") or "4840"
        return h, int(port)
    if ":" in host:
        h, p = host.rsplit(":", 1)
        return h, int(p or 4840)
    return host, 4840


def _is_conn_error(e):
    """是不是「连接断了」这类错误（区别于「某个节点读不了」）。

    ⚠ 必须分清：节点坏了要退回逐个读、把坏的那个标出来；连接断了就得让
    轮询循环掉出去走重连 —— 以前不分，服务器进程没了以后每一轮都「成功」，
    界面一直显示在线、值全是 None，现场根本查不出来。"""
    if isinstance(e, (ConnectionError, ConnectionResetError, ConnectionAbortedError,
                      BrokenPipeError, TimeoutError, asyncio.TimeoutError, OSError)):
        return True
    name = type(e).__name__
    msg = str(e)
    if "Connection" in name or "Timeout" in name:
        return True
    return ("Connection is closed" in msg or "BadConnectionClosed" in msg
            or "ConnectionError" in msg or "BadServerNotConnected" in msg)


# ─────────────────────────────────────────────
#  值转换
# ─────────────────────────────────────────────
def coerce_read(value, hmi_type):
    """读回来的值按变量表类型收敛（UA 的 Int16 就是 Python int，Float 是 float）

    数组类型写成 `int[]`（元素类型 + `[]`）：CODESYS 的 ARRAY [1..13] OF INT 在 OPC UA 里
    是一个节点，读回来就是一个列表，这里按元素类型逐个收敛。"""
    if value is None:
        return None
    t = str(hmi_type or "").lower()
    if t.endswith("[]"):
        elem = t[:-2]
        if isinstance(value, (list, tuple)):
            return [coerce_read(x, elem) for x in value]
        return [coerce_read(value, elem)]          # 服务器给了单值（不该发生）：当 1 元素数组
    try:
        if t == "bool":
            if isinstance(value, str):
                return value.strip().lower() in ("1", "true", "on", "yes")
            return bool(value)
        if t in ("int", "uint", "dint", "udint"):
            return int(round(float(value))) if not isinstance(value, bool) else int(value)
        if t in ("real", "lreal"):
            return float(value)
        if t == "string":
            return value if isinstance(value, str) else str(value)
    except (TypeError, ValueError):
        return value
    return value


def coerce_write(value, vt_name, hmi_type=""):
    """写下去的值按**节点的实际类型**收敛：Float 节点写 33.5（Double）会被服务器拒
    （BadTypeMismatch），必须先转成对应 Variant 类型 —— 这是接真机最容易踩的一条。

    数组（hmi_type 以 [] 结尾，或值本身是 list）：逐个元素收敛后整体写。"""
    is_arr = str(hmi_type or "").lower().endswith("[]") or isinstance(value, (list, tuple))
    if is_arr:
        if isinstance(value, str):
            value = [v for v in re.split(r"[,;\s]+", value.strip().strip("[]")) if v != ""]
        return [coerce_write(v, vt_name) for v in (value or [])]
    n = str(vt_name or "")
    if n in ("Boolean",):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "on", "yes")
        return bool(value)
    if n in ("SByte", "Int16", "Int32", "Int64", "Byte", "UInt16", "UInt32", "UInt64"):
        return int(round(float(value)))
    if n in ("Float", "Double"):
        return float(value)
    if n in ("String", "Guid", "ByteString", "DateTime"):
        return "" if value is None else str(value)
    return value


# ─────────────────────────────────────────────
#  临时连接（测试连接 / 导入变量时用，用完就断）
# ─────────────────────────────────────────────
async def _connect_async(endpoint, security="none", username="", password="", timeout=6.0):
    cli = Client(endpoint, timeout=max(2.0, float(timeout)))
    if username:
        cli.set_user(username)
        cli.set_password(password or "")
    await cli.connect()
    return cli


def probe(endpoint, security="none", username="", password="", timeout=6.0):
    """「测试连接」：连上读命名空间表 + 服务器信息，然后断开。返回 (ok, message, info)

    连不上时**顺手做一次端点诊断**（不建会话就能问）——现场最常见的三种情况
    （CODESYS 没开匿名 / 只给了加密端点 / 端口上其实是别的服务）当场就能看出来，
    不用对着 `BadSessionNotActivated` 这种协议级报错猜。"""
    if not AVAILABLE:
        return False, f"后端没装 asyncua（{IMPORT_ERROR}）。装：{INSTALL_HINT}", {}
    ep = norm_endpoint(endpoint)
    host, port = endpoint_host_port(ep)
    good, why = _tcp_probe(host, port)
    if not good:
        return False, why, {}

    async def run():
        cli = await _connect_async(ep, security, username, password, timeout)
        try:
            nss = list(await cli.get_namespace_array())
            info = {"namespaces": nss, "endpoint": ep}
            try:
                node = cli.get_node(ua.NodeId(ua.ObjectIds.Server_ServerStatus_BuildInfo))
                bi = await node.read_value()
                info["product"] = getattr(bi, "ProductName", "") or ""
                info["build"] = f"{getattr(bi, 'SoftwareVersion', '')} {getattr(bi, 'BuildNumber', '')}".strip()
            except Exception:                       # noqa: BLE001
                info["product"] = info["build"] = ""
            return info
        finally:
            try:
                await cli.disconnect()
            except Exception:                       # noqa: BLE001
                pass

    try:
        info = asyncio.run(run())
    except Exception as e:                          # noqa: BLE001
        msg = f"连接失败：{_ua_err(e)}"
        diag = describe_endpoints(ep, timeout=timeout)
        if diag.get("ok"):
            info.update(diag)
            msg += "\n\n" + diag["advice"]
        return False, msg, info
    ns_txt = "、".join(f"ns{i}={u}" for i, u in enumerate(info.get("namespaces") or []) if i > 0)
    msg = f"连接成功（{ep}）"
    if info.get("product"):
        msg += f"\n服务器：{info['product']} {info.get('build', '')}".rstrip()
    if ns_txt:
        msg += f"\n命名空间：{ns_txt}"
    return True, msg, info


def _policy_short(uri):
    if not uri:
        return ""
    return uri.rsplit("#", 1)[-1]


def describe_endpoints(endpoint, timeout=6.0):
    """只问「你是谁、开了哪些端点、接受哪种身份」—— **不需要建会话**，
    所以匿名被拒/密码不对时它照样能给出有用信息。

    返回 {ok, server:{name,uri,product}, endpoints:[…], tokens:[…], policies:[…], advice}
    """
    if not AVAILABLE:
        return {"ok": False, "message": f"后端没装 asyncua（{IMPORT_ERROR}）。装：{INSTALL_HINT}"}
    ep = norm_endpoint(endpoint)
    host, port = endpoint_host_port(ep)
    good, why = _tcp_probe(host, port)
    if not good:
        return {"ok": False, "message": why}

    async def run():
        cli = Client(ep, timeout=max(2.0, float(timeout)))
        return await cli.connect_and_get_server_endpoints()

    try:
        eps = asyncio.run(run())
    except Exception as e:                          # noqa: BLE001
        return {"ok": False, "message": f"问端点失败：{_ua_err(e)}"}

    out, tokens, policies = [], [], []
    server = {}
    for e in eps:
        try:
            srv = e.Server
            if srv and not server.get("name"):
                server = {"name": getattr(getattr(srv, "ApplicationName", None), "Text", "") or "",
                          "uri": getattr(srv, "ApplicationUri", "") or "",
                          "product": getattr(srv, "ProductUri", "") or "",
                          "type": getattr(srv, "ApplicationType", "")}
        except Exception:                           # noqa: BLE001
            pass
        pol = _policy_short(e.SecurityPolicyUri)
        if pol and pol not in policies:
            policies.append(pol)
        tk = []
        for t in (e.UserIdentityTokens or []):
            name = getattr(t.TokenType, "name", str(t.TokenType))
            tk.append({"type": name, "policy_id": t.PolicyId or ""})
            if name not in tokens:
                tokens.append(name)
        out.append({"url": e.EndpointUrl, "mode": getattr(e.SecurityMode, "name", str(e.SecurityMode)),
                    "policy": pol, "tokens": tk})
    return {"ok": True, "endpoint": ep, "server": server, "endpoints": out,
            "tokens": tokens, "policies": policies,
            "advice": _endpoint_advice(server, policies, tokens)}


def _endpoint_advice(server, policies, tokens):
    """把端点信息翻译成「下一步该干什么」——现场用得上的就是这几句"""
    who = server.get("name") or "服务器"
    lines = [f"· 这个端点上跑的是：{who}"
             + (f"（{server.get('uri')}）" if server.get("uri") else "")]
    lines.append(f"· 安全策略：{'、'.join(policies) or '（没报）'}")
    lines.append(f"· 声明的身份方式：{'、'.join(tokens) or '（一个都没声明）'}")
    has_none = any(p == "None" for p in policies)
    if not has_none:
        lines.append("→ 服务器**只提供加密端点**（Sign / Sign&Encrypt）：需要客户端证书才能连，"
                     "当前版本只做 SecurityPolicy None —— 要么在 CODESYS 的 OPC UA Server 里把 None 端点加上，"
                     "要么给它配上 Basic256Sha256 + 证书（这版还没做）")
    elif "Anonymous" not in tokens:
        lines.append("→ 服务器**没有声明匿名身份**：多半是 CODESYS 工程里没开匿名访问。"
                     "改法：设备树里双击 **OPC UA Server** → 安全设置（Security Settings）里给 None 端点勾上 "
                     "**Anonymous**（匿名），然后**重新下载到运行时**再重连；"
                     "或者改用**用户名/密码**（需要在 OPC UA Server 里配用户，且通常要求加密通道）")
    else:
        lines.append("→ 端点声明了匿名，理论上可以直接连；连不上就看上面的具体报错（用户名密码 / 证书 / 权限）")
    return "\n".join(lines)


def _identity_advice(msg):
    """身份类报错 → 一句能照着做的提示。

    为什么单独拎出来：CODESYS 工程默认**不许匿名**（Security Settings 里没勾 Anonymous），
    这时候客户端带着匿名令牌去激活会话，服务器直接回
    `BadSessionNotActivated / BadIdentityTokenInvalid / BadUserAccessDenied` ——
    字面上完全看不出"该怎么办"。导入对话框以前不带密码，撞上这个就是一句天书。"""
    low = str(msg or "").lower()
    keys = ("badsessionnotactivated", "badidentitytoken", "baduseraccessdenied",
            "badsecuritychecksfailed", "identity", "anonymous", "user token")
    if not any(k in low for k in keys):
        return ""
    return ("\n→ 服务器不接受匿名（或身份不对）：在对话框里填上 **用户名 / 密码** 再浏览；"
            "CODESYS 侧在设备树里双击 **OPC UA Server → 安全设置**，给 None 端点勾上 Anonymous，"
            "或启用「用户名/密码」身份并配好用户，改完**重新下载到运行时**。"
            "也可以先用工具栏 🔌 PLC 连上（那条连接带着身份），浏览会**复用已认证的连接**。")


def _ua_err(e, op="read"):
    """把 asyncua 的异常翻成人话（现场看的是这句话）

    op：这次是在干什么（read / write / browse）—— 同一句 BadUserAccessDenied
    在「写」和「浏览」下原因完全不同：写多半是节点只读，浏览多半是**服务器不许匿名**、
    或者账号密码不对。翻错了现场会照着错的提示去查（踩过）。"""
    name = type(e).__name__
    msg = str(e)
    if ("Connection is closed" in msg or "ConnectionRefused" in msg or "ConnectionError" in msg
            or "BadConnectionClosed" in msg or "refused" in msg.lower()):
        return (f"与 OPC UA 服务器的连接断了（{msg}）—— 服务器关了 / 网线或网络不通 / 被防火墙拦了；"
                "后端会自己按轮询周期重连，恢复后自动继续")
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)) or "Timeout" in name:
        return f"OPC UA 请求超时（{msg}）—— 服务器没响应、网络慢，或节点太多一次读太久"
    if "BadUserAccessDenied" in msg or "BadIdentityTokenRejected" in msg or "BadIdentityTokenInvalid" in msg:
        if op == "browse":
            return (f"服务器不接受这次连接 / 浏览（{msg}）—— 最常见就是**服务器不许匿名**："
                    "把用户名密码填上再浏览（CODESYS 侧也可以在 OPC UA Server 的安全设置里允许匿名）")
        return (f"服务器拒绝写入/身份校验没过（{msg}）—— 常见三种："
                "①这个节点是只读的（AccessLevel 没有写权限）；"
                "②用户名密码不对；③该服务器要求加密通道（Sign&Encrypt）才能用用户名，"
                "而当前连的是 SecurityPolicy None")
    if "BadNotWritable" in msg or "BadWriteNotSupported" in msg:
        return f"这个节点不让写（{msg}）—— 变量表里把它当只读用"
    if "BadSecurityPolicyRejected" in msg or "BadSecurityModeRejected" in msg:
        return f"安全策略不被接受（{msg}）—— 服务器可能要求 Sign&Encrypt（v1 只做 None）"
    if "BadConnectionClosed" in msg or "ConnectionRefused" in msg:
        return f"连接被关闭（{msg}）—— 端点地址/端口不对，或服务器只接受加密连接"
    if "BadNodeIdUnknown" in msg:
        return f"节点不存在（{msg}）—— NodeId 拼错或该符号没在 OPC UA 里发布"
    return f"{name}: {msg}"


def browse(endpoint, node_id="", depth=4, max_nodes=3000, filter_text="",
           security="none", username="", password="", default_ns=DEFAULT_NS, timeout=8.0,
           include_arrays=True, only_app_symbols=False):
    """浏览节点树：给「从 OPC UA 导入变量」和「按服务器实际符号纠正地址」用。
    返回 {ok, nodes:[{nodeid,name,path,ua_type,hmi_type,writable,is_array}], truncated, namespaces, message}
    默认跳过 ns=0（那是 UA 标准节点：Server/DeviceSet…，现场根本不关心）。
    only_app_symbols=True 时只收 CODESYS 应用符号（标识以 |var| 开头）——
    用来跟变量表里的地址「对答案」（设备名/命名空间写错时一键纠正）。"""
    if not AVAILABLE:
        return {"ok": False, "message": f"后端没装 asyncua（{IMPORT_ERROR}）。装：{INSTALL_HINT}", "nodes": []}
    ep = norm_endpoint(endpoint)
    host, port = endpoint_host_port(ep)
    good, why = _tcp_probe(host, port)
    if not good:
        return {"ok": False, "message": why, "nodes": []}
    start = ""
    if str(node_id or "").strip():
        try:
            start = parse_node_id(node_id, default_ns)
        except ValueError as e:
            return {"ok": False, "message": str(e), "nodes": []}
    try:
        return asyncio.run(_browse_async(ep, start, depth, max_nodes, filter_text,
                                         security, username, password, timeout, include_arrays,
                                         only_app_symbols))
    except ValueError as e:
        return {"ok": False, "message": str(e), "nodes": []}
    except Exception as e:                          # noqa: BLE001
        msg = _ua_err(e, op="browse")
        return {"ok": False, "message": msg + _identity_advice(msg), "nodes": []}


async def _browse_async(ep, start, depth, max_nodes, filter_text, security, username,
                        password, timeout, include_arrays, only_app_symbols=False):
    cli = await _connect_async(ep, security, username, password, timeout)
    try:
        namespaces = list(await cli.get_namespace_array())
        root = cli.get_node(start) if start else cli.get_node(ua.NodeId(ua.ObjectIds.ObjectsFolder))
        out = await _collect_variables(cli, root, depth, max_nodes, include_arrays, only_app_symbols)
        truncated = len(out) >= max_nodes
        flt = str(filter_text or "").strip().lower()
        if flt:
            out = [n for n in out
                   if flt in n["name"].lower() or flt in n["path"].lower() or flt in n["nodeid"].lower()]
        return {"ok": True, "nodes": out, "truncated": truncated,
                "namespaces": namespaces, "endpoint": ep,
                "message": f"找到 {len(out)} 个变量节点" + ("（已达上限，缩小浏览范围或加过滤词）" if truncated else "")}
    finally:
        try:
            await cli.disconnect()
        except Exception:                           # noqa: BLE001
            pass


# ─────────────────────────────────────────────
#  常驻数据源（轮询）
# ─────────────────────────────────────────────
class OpcUaSource:
    """把一台 OPC UA 服务器当数据源。接口与 modbus.PlcSource 对齐：
    declare / read_all / read / write / start / stop / plan_count / status。

    线程模型：一个后台线程跑 asyncio 事件循环（asyncua 是 asyncio 的），
    HTTP 线程要读写时用 run_coroutine_threadsafe 投进去 —— 这样
    server.py 那边完全不用改（它只认「同步方法」）。
    """

    def __init__(self, endpoint, security="none", username="", password="",
                 poll_ms=200, timeout=6.0, default_ns=DEFAULT_NS, on_change=None, on_changes=None,
                 retain=None):
        self.endpoint = norm_endpoint(endpoint)
        self.security = (security or "none").lower()
        self.username = username or ""
        self.password = password or ""
        self.poll_ms = max(50, int(poll_ms))
        self.timeout = max(2.0, float(timeout))
        self.default_ns = int(default_ns if default_ns is not None else DEFAULT_NS)
        # 掉电保持存档（server.py 的 RetainStore）：地址留空的**内部变量**勾了「保持」就落盘。
        # 传 None（直接构造的测试）也能跑，只是不落盘。
        self.retain = retain
        self._lock = threading.RLock()
        self._vars = {}                 # name -> {type, address, nodeid, node, value, vt, addr_error}
        self._active = None             # 本页要采集的变量名集合（None = 全部）
        self._blocks = 0
        self._cli = None
        self._loop = None
        self._stop = threading.Event()
        self._thread = None
        self._on_change = on_change
        self._on_changes = on_changes   # 一批变化一起回调（优先用：别一条变量一条 SSE）
        self._dirty = False             # 变量表变了 → 重新解析节点
        self._verify = set()            # 刚写过的变量名：下一轮不管在不在采集范围内都要读一次
        self.online = False
        self.last_error = ""
        self.last_ok = 0.0
        self.namespaces = []
        self.reads = 0
        self.writes = 0
        self.errors = 0

    # ── 变量表同步（HTTP 线程调用）──
    def declare(self, variables, active=None):
        cache = getattr(self, "_addr_cache", None)
        if cache is None:
            cache = self._addr_cache = {}
        new = {}
        with self._lock:
            old_map = self._vars
            for v in variables or []:
                if not isinstance(v, dict):
                    continue
                name = v.get("name")
                if not name:
                    continue
                addr = (v.get("address") or "").strip()
                nodeid, perr = "", ""
                if addr:
                    hit = cache.get(addr)
                    if hit is not None:
                        nodeid, perr = hit
                    else:
                        try:
                            nodeid = parse_node_id(addr, self.default_ns)
                        except ValueError as e:
                            perr = str(e)
                        cache[addr] = (nodeid, perr)
                old = old_map.get(name) or {}
                # 地址留空 = **内部变量**（HMI 自己算，不读不写服务器）——和 Modbus 侧同一口径：
                # 勾了「保持」的由 RetainStore 落盘，重启/断电后还在
                if not addr:
                    r = bool(v.get("retain"))
                    value = old.get("value")
                    if value is None:
                        value = (self.retain.get(name, v.get("value")) if (r and self.retain) else v.get("value"))
                    elif r and self.retain and not self.retain.has(name):
                        self.retain.set(name, value)
                    if old.get("retain") and not r and self.retain:
                        self.retain.forget(name)
                    new[name] = {
                        "type": v.get("type", "real"),
                        "address": "",
                        "nodeid": "",
                        "node": None,
                        "vt": "",
                        "value": value,
                        "default": v.get("value"),
                        "addr_error": "",
                        "internal": True,
                        "retain": r,
                    }
                    continue
                keep = nodeid and old.get("nodeid") == nodeid   # NodeId 没变 → 复用已解析节点与缓存类型
                new[name] = {
                    "type": v.get("type", "real"),
                    "address": addr,
                    "nodeid": nodeid,
                    "node": old.get("node") if keep else None,
                    "vt": old.get("vt") if keep else "",
                    "value": old.get("value", v.get("value")),
                    "default": v.get("value"),
                    "addr_error": perr,
                }
            self._vars = new
            if active is not None:
                self._active = set(active) & set(new.keys())
            self._dirty = True

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
        """**只重置内部变量**（地址留空的那些）：服务器上的节点一个都不碰。
        和 Modbus 侧同一口径 —— 接不接设备，"内部变量：恢复初值"这个入口都在。"""
        changed = {}
        with self._lock:
            for name, rec in list(self._vars.items()):
                if not rec.get("internal"):
                    continue
                if clear:
                    del self._vars[name]
                    if self.retain:
                        self.retain.forget(name)
                    continue
                if "default" in rec:
                    rec["value"] = rec["default"]
                if rec.get("retain") and self.retain:
                    self.retain.set(name, rec["value"])
                changed[name] = rec.get("value")
        return changed

    # ── 写（HTTP 线程调用 → 投到事件循环）──
    def write(self, name, value):
        # 内部变量（地址留空）：不碰服务器，值存在后端（勾了「保持」的顺带落盘）
        # ⚠ 判据是**地址本身**，不是 internal 标记：老档案里可能没有那个键（见 server.py 里同类注释），
        #   只看标记会把内部变量当成"NodeId 没填好的变量"直接拒掉。
        name_s = str(name or "")
        with self._lock:
            v0 = self._vars.get(name_s)
        if v0 is not None and (v0.get("internal") or not (v0.get("address") or "").strip()):
            with self._lock:
                v0["value"] = value
            if v0.get("retain") and self.retain:
                self.retain.set(name_s, value)
            return True
        if not AVAILABLE:
            raise ValueError(f"后端没装 asyncua（{IMPORT_ERROR}）。装：{INSTALL_HINT}")
        # 数组元素写法 `arrw[3]`：UA 的写是整节点写，元素写 = 读当前整段 → 换掉那个元素 → 整段写回
        name_s = str(name or "")
        elem_idx = None
        base_name = name_s
        with self._lock:
            v = self._vars.get(name_s)
        if v is None:
            # ⚠ 先按**整名**找变量，找不到才当「数组的第 n 个元素」：
            #   数组被「展开成单个变量」后，变量名本身就长这样（arrw[1]），而且
            #   CODESYS 侧 arrw[1] 本身就是个独立节点，直接写它比读改写整段更干净。
            m = re.match(r"^(.+)\[(\d+)\]$", name_s)
            if m:
                base_name, elem_idx = m.group(1), int(m.group(2))
                with self._lock:
                    v = self._vars.get(base_name)
        if not v:
            raise ValueError(f"变量 {base_name} 未在变量表声明")
        if not v.get("nodeid"):
            raise ValueError(f"变量 {base_name} 的 NodeId {v.get('address')!r} 无效：{v.get('addr_error') or '未填写'}")
        if not self._loop or not self.online:
            raise ValueError(f"OPC UA 未连接：{self.last_error or '尚未连上'}")
        fut = asyncio.run_coroutine_threadsafe(self._write_async(base_name, v, value, elem_idx), self._loop)
        try:
            fut.result(timeout=self.timeout + 4)
        except Exception as e:                       # noqa: BLE001
            msg = _ua_err(e)
            # BadOutOfRange 写在 string 上：CODESYS 的 STRING(n) 是**按字节**算的单字节字符串，
            # 中文这种多字节字符塞不进一个字节 → 服务器直接拒（实测）。放中文要用 WSTRING。
            if "BadOutOfRange" in str(e) and str(v.get("type", "")).lower() == "string":
                msg += ("\n（这个变量的类型是 string：CODESYS 的 STRING(n) 按字节算，"
                        "中文/日文这类多字节字符写不进去 —— PLC 里把它声明成 WSTRING，"
                        "变量表类型也改成 wstring 就能存中文）")
            raise ValueError(msg) from None
        with self._lock:
            if elem_idx is None:
                v["value"] = coerce_read(value, v.get("type"))
            else:
                cur = v.get("value")
                arr = list(cur) if isinstance(cur, list) else []
                while len(arr) <= elem_idx:
                    arr.append(coerce_read(0, (v.get("type") or "").replace("[]", "") or "dint"))
                arr[elem_idx] = coerce_read(value, (v.get("type") or "").replace("[]", "") or "dint")
                v["value"] = arr
        # 刚写过的变量下一轮**一定要读一次**（哪怕它不在本页采集范围里）：
        # 现场现象是「PLC 那边已经变回 false 了，HMI 还显示 true」——多半就是它不在
        # 采集范围内，后端根本没读，界面就永远停在本地下发的那个值上。
        self._verify.add(base_name)
        self.writes += 1

    async def _write_async(self, name, v, value, elem_idx=None):
        node = v.get("node") or self._cli.get_node(v["nodeid"])
        v["node"] = node
        vt = v.get("vt") or ""
        if not vt:
            vt = ua_variant_name(await node.read_data_type_as_variant_type())
            v["vt"] = vt
        hmi = v.get("type", "")
        if elem_idx is not None:
            # 读改写：UA 没有「写第 i 个元素」这种服务，只能整段读回来改一个再写回
            cur = await node.read_value()
            arr = list(cur) if isinstance(cur, (list, tuple)) else ([cur] if cur is not None else [])
            elem_hmi = hmi[:-2] if str(hmi).endswith("[]") else "dint"
            while len(arr) <= elem_idx:
                arr.append(coerce_write(0, vt, elem_hmi))
            arr[elem_idx] = coerce_write(value, vt, elem_hmi)
            await node.write_value(ua.Variant(arr, getattr(ua.VariantType, vt, None)))
            self.last_error = ""
            return
        cast = coerce_write(value, vt, hmi)
        await node.write_value(ua.Variant(cast, getattr(ua.VariantType, vt, None)))
        self.last_error = ""

    # ── 线程 / 事件循环 ──
    def start(self):
        if not AVAILABLE:
            self.online = False
            self.last_error = f"没装 asyncua（{IMPORT_ERROR}）。装：{INSTALL_HINT}"
            print(f"[opcua] {self.last_error}")
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._thread_main, daemon=True)
        self._thread.start()

    def stop(self):
        """停止轮询并断开（停不干净的话 asyncua 会在控制台刷
        「Task was destroyed but it is pending」——现场看着像出错了）"""
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)
        self.online = False

    def _thread_main(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._main())
        except Exception as e:                       # noqa: BLE001
            self.last_error = _ua_err(e)
            print(f"[opcua] 轮询线程退出：{self.last_error}")
        finally:
            self._shutdown_loop()

    def _shutdown_loop(self):
        """收尾：把没跑完的任务取消掉再关循环（asyncua 内部有
        renew_channel / monitor_server 两个常驻任务，不取消就会刷警告）"""
        loop = self._loop
        if loop is None:
            return
        try:
            pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
            for t in pending:
                t.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:                            # noqa: BLE001
            pass
        try:
            loop.close()
        except Exception:                            # noqa: BLE001
            pass
        self._loop = None

    async def _main(self):
        while not self._stop.is_set():
            try:
                await self._connect()
                await self._poll_loop()
            except Exception as e:                   # noqa: BLE001
                self.errors += 1
                self.online = False
                self.last_error = _ua_err(e)
                await self._disconnect_async()
                if self._stop.is_set():
                    break
                # 断线重连：等一会儿再试（和 Modbus 那边一个节奏）
                await self._sleep(min(2.0, self.poll_ms / 1000 * 5))
        await self._disconnect_async()

    async def _connect(self):
        # ⚠ Client 必须在事件循环线程里构造（它内部持有 asyncio 原语）
        cli = Client(self.endpoint, timeout=self.timeout)
        if self.username:
            cli.set_user(self.username)
            cli.set_password(self.password)
        # 安全策略：v1 只做 None（不调 set_security 就是 None + 匿名通道）。
        # 要接「必须 Sign&Encrypt」的服务器时在这里加：
        #   cli.set_security(SecurityPolicyType.Basic256Sha256_SignAndEncrypt, cert, key)
        # 并在前端连接对话框里加证书文件选择（后续扩展点）。
        if self.security not in ("none", "", "无"):
            raise ValueError(f"暂时只支持安全策略 None（当前配的是 {self.security}）")
        await cli.connect()
        self._cli = cli
        self.online = True
        self.last_error = ""
        try:
            self.namespaces = list(await cli.get_namespace_array())
        except Exception:                            # noqa: BLE001
            self.namespaces = []
        ns_txt = "、".join(f"ns{i}={u}" for i, u in enumerate(self.namespaces) if i > 0)
        print(f"[opcua] 已连接 {self.endpoint}"
              + (f"（用户 {self.username}）" if self.username else "（匿名）")
              + (f"　命名空间：{ns_txt}" if ns_txt else ""))

    async def _disconnect_async(self):
        cli, self._cli = self._cli, None
        if cli:
            try:
                await cli.disconnect()
            except Exception:                        # noqa: BLE001
                pass

    async def _sleep(self, sec):
        """可被 stop() 打断的等待（切成小片，退出运行态时不用干等）"""
        t0 = time.time()
        while not self._stop.is_set() and time.time() - t0 < sec:
            await asyncio.sleep(min(0.1, max(0.01, sec)))

    async def _liveness(self):
        """空采集范围时的保活：读一下服务器的 ServerStatus（标准节点，一定存在）。
        读不动 = 连接有问题 → 抛出去让 _main 走重连。"""
        node = self._cli.get_node(ua.NodeId(ua.ObjectIds.Server_ServerStatus))
        await asyncio.wait_for(node.read_value(), timeout=self.timeout + 2)

    async def _read_chunk(self, chunk, nodes):
        """批量读一批节点。**整批失败要退回逐个读** ——
        UA 服务器遇到一个它序列化不了的节点会直接回 ServiceFault，
        整批就全废了（实测：一个类型不匹配的符号能让整页变量都不刷新）。
        退回逐个读之后，坏的只在它自己那行报错，好的照常更新。

        ⚠ 但「连接断了」不能走这条路：那种失败要抛给轮询循环去重连，
        否则每轮都「读完了」（值全是 None），界面一直显示在线。

        ⚠⚠ 而且**必须带超时**：服务器进程被杀掉时，asyncua 的读请求有时不返回
        也不报错（连接已断但 future 一直挂着），轮询就卡死在这儿 —— 表现是
        「界面一直显示在线、值不动、运行页面也不出掉线条」，现场根本看不出问题。
        超时按客户端超时 +2 秒算，超了就当连接故障处理。"""
        try:
            return await asyncio.wait_for(self._read_chunk_inner(chunk, nodes),
                                          timeout=self.timeout + 2)
        except asyncio.TimeoutError:
            raise TimeoutError(f"读超时（{self.timeout + 2:.0f}s 没响应）—— 连接可能已经断了") from None

    async def _read_chunk_inner(self, chunk, nodes):
        try:
            return await self._cli.read_attributes(nodes)
        except Exception as e:                       # noqa: BLE001
            if _is_conn_error(e):
                raise
            self.last_error = f"批量读失败，已退回逐个读：{_ua_err(e)}"
            out, live = [], 0
            for name, node in zip(chunk, nodes):
                try:
                    dvs = await self._cli.read_attributes([node])
                    out.append(dvs[0])
                    live += 1
                except Exception as e2:              # noqa: BLE001
                    if _is_conn_error(e2):
                        raise
                    with self._lock:
                        v = self._vars.get(name)
                        if v:
                            v["addr_error"] = _ua_err(e2)
                    out.append(None)
            if not live:
                raise RuntimeError(f"这一批 {len(nodes)} 个节点全读失败：{self.last_error}")
            return out

    async def _poll_loop(self):
        while not self._stop.is_set():
            with self._lock:
                active = self._active
                names = [n for n, v in self._vars.items()
                         if v.get("nodeid") and (active is None or n in active or n in self._verify)]
                # ⚠ 写入过的变量**一直留在采集范围里**（不清空）：现场就是"HMI 按了按钮把 bool 置 true，
                #   PLC 那边又变回 false，界面还一直显示 true"——原因是那个变量不在本页采集范围内，
                #   后端根本不读它。HMI 写过的变量就是操作员关心的变量，必须持续读回来对账。
                need_resolve = [n for n in names if self._vars[n].get("node") is None]
                self._dirty = False
            # 解析还没拿到 Node 对象的（本地解析，不发请求）
            for n in need_resolve:
                with self._lock:
                    v = self._vars.get(n)
                if not v:
                    continue
                try:
                    v["node"] = self._cli.get_node(v["nodeid"])
                except Exception as e:               # noqa: BLE001
                    with self._lock:
                        if n in self._vars:
                            self._vars[n]["addr_error"] = str(e)
            blocks = 0
            if not names:
                # 本页没用到任何变量（采集范围是空的）时也要**保活探一下**：
                # 否则这一轮"什么都没做"也算成功，服务器断了永远发现不了 ——
                # 界面一直显示在线、运行页面也不出掉线条（实测踩过）。
                await self._liveness()
                blocks = 0
            for i in range(0, len(names), BATCH_NODES):
                if self._stop.is_set():
                    return
                chunk = names[i:i + BATCH_NODES]
                with self._lock:
                    nodes = [self._vars[n]["node"] for n in chunk if self._vars.get(n, {}).get("node")]
                if not nodes:
                    continue
                dvs = await self._read_chunk(chunk, nodes)
                blocks += 1
                self.reads += 1
                changed = []
                with self._lock:
                    for name, dv in zip(chunk, dvs):
                        v = self._vars.get(name)
                        if not v:
                            continue
                        code = getattr(dv, "StatusCode", None)
                        if code is not None and not code.is_good():
                            # 节点不存在/无权限：报出来，别往界面塞旧值装作没事
                            v["addr_error"] = f"读取被拒（{code.name if hasattr(code, 'name') else code}）"
                            continue
                        if dv is None or dv.Value is None:
                            continue
                        v["addr_error"] = ""
                        if not v.get("vt"):
                            v["vt"] = ua_variant_name(dv.Value.VariantType)
                        val = coerce_read(dv.Value.Value, v.get("type"))
                        if v.get("value") != val and not (isinstance(val, float)
                                                          and isinstance(v.get("value"), float)
                                                          and abs(val - v["value"]) < 1e-9):
                            v["value"] = val
                            changed.append((name, val))
                # 一批变化优先走批量回调（500 个变量一起变时只发一条 SSE，别发 500 条）
                if changed:
                    if self._on_changes:
                        self._on_changes(changed)
                    elif self._on_change:
                        for name, val in changed:
                            self._on_change(name, val)
                if self._dirty:                      # 变量表/采集范围变了 → 立刻按新的来
                    break
            self._blocks = blocks
            self.last_ok = time.time()
            self.online = True
            # 低频心跳（60 秒一条）：让日志里能看出轮询**一直在跑**。
            # 没有它，日志里只有「连上 / 写入」几条，看着像"读了一次就不读了"，
            # 其实是轮询太安静 —— 现场排查时最容易被这个误导。
            if self.last_ok - getattr(self, "_beat_at", 0.0) >= 60:
                self._beat_at = self.last_ok
                print(f"[poll] OPC UA 本页采 {len(names)} 变量 / {blocks} 块，"
                      f"累计读 {self.reads} 次，在线 {self.online}")
            await self._sleep(self.poll_ms / 1000)

    # ── 状态 ──
    def plan_count(self):
        with self._lock:
            active = self._active
            n = len([k for k, v in self._vars.items()
                     if v.get("nodeid") and (active is None or k in active)])
        return max(1, (n + BATCH_NODES - 1) // BATCH_NODES) if n else 0

    def _stale_after(self):
        """多久没成功读一次就算「掉线」：3 个轮询周期 + 客户端超时，最少 3 秒。

        为什么要这一手：服务器进程被杀掉时，asyncua 的读请求**有时既不返回也不报错**
        （连接断了但 future 一直挂着 —— 实测轮询线程会卡住，reads 计数冻在那儿）。
        那样 status 里 online 会一直是 true、界面不报掉线、运行页面的红条也不出来，
        现场看着像「数据不动但一切正常」。这里用「最后一次成功读取的时间」兜底：
        卡住了照样判离线，前端既能提示、也能触发重连。"""
        return max(3.0, self.poll_ms / 1000.0 * 3 + self.timeout)

    def status(self):
        with self._lock:
            bad = [n for n, v in self._vars.items() if v.get("nodeid") and v.get("addr_error")]
            n_vars = len(self._vars)
            active = None if self._active is None else len(self._active)
            scoped = self._active is not None
        stale = bool(self.online and self.last_ok
                     and (time.time() - self.last_ok) > self._stale_after())
        last_error = self.last_error
        if stale and not last_error:
            last_error = f"读取无响应超过 {self._stale_after():.0f} 秒（连接可能已断）"
        return {
            "mode": "opcua", "protocol": "opcua",
            "endpoint": self.endpoint, "security": self.security,
            "username": self.username,
            "host": endpoint_host_port(self.endpoint)[0], "port": endpoint_host_port(self.endpoint)[1],
            "poll_ms": self.poll_ms,
            "online": bool(self.online and self._cli is not None and not stale),
            "stale": stale,
            "last_error": last_error, "last_ok": self.last_ok,
            "reads": self.reads, "writes": self.writes, "errors": self.errors,
            "vars": n_vars, "bad_address": bad[:10],
            "scoped": scoped, "active": n_vars if active is None else active, "blocks": self._blocks,
            "namespaces": self.namespaces,
            "available": AVAILABLE, "import_error": IMPORT_ERROR,
        }

    # ── 从常驻连接上浏览（导入变量时如果已经连着，就不用再开一条连接）──
    def browse(self, node_id="", depth=4, max_nodes=3000, filter_text="", include_arrays=True,
               only_app_symbols=False):
        if self.online and self._loop and self._cli:
            fut = asyncio.run_coroutine_threadsafe(
                self._browse_async(node_id, depth, max_nodes, filter_text, include_arrays,
                                   only_app_symbols), self._loop)
            try:
                res = fut.result(timeout=self.timeout + 15)
                if res.get("ok"):
                    return res
                # 常驻连接可能是「半死」的（服务器刚重启 / 连接被关）：再开一条临时连接试一次，
                # 别让导入对话框看到一句 Connection is closed 就没法用
                self.last_error = f"复用连接浏览失败，改走临时连接：{res.get('message')}"
            except ValueError as e:
                return {"ok": False, "message": str(e), "nodes": []}
            except Exception as e:                   # noqa: BLE001
                self.last_error = f"复用连接浏览失败，改走临时连接：{_ua_err(e)}"
        return browse(self.endpoint, node_id, depth, max_nodes, filter_text,
                      self.security, self.username, self.password, self.default_ns,
                      self.timeout, include_arrays, only_app_symbols)

    async def _browse_async(self, node_id, depth, max_nodes, filter_text, include_arrays,
                            only_app_symbols=False):
        # 复用常驻客户端的做法：临时借用它的 _browse_async 实现（同一套逻辑）
        start = ""
        if str(node_id or "").strip():
            try:
                start = parse_node_id(node_id, self.default_ns)
            except ValueError as e:
                return {"ok": False, "message": str(e), "nodes": []}
        root = self._cli.get_node(start) if start else self._cli.get_node(ua.NodeId(ua.ObjectIds.ObjectsFolder))
        nodes = await _collect_variables(self._cli, root, depth, max_nodes, include_arrays,
                                         only_app_symbols)
        flt = str(filter_text or "").strip().lower()
        if flt:
            nodes = [n for n in nodes
                     if flt in n["name"].lower() or flt in n["path"].lower() or flt in n["nodeid"].lower()]
        return {"ok": True, "nodes": nodes, "truncated": False,
                "namespaces": self.namespaces, "endpoint": self.endpoint,
                "message": f"找到 {len(nodes)} 个变量节点"}


async def _collect_variables(cli, root, depth, max_nodes, include_arrays, only_app_symbols=False):
    """从 root 往下收集变量节点（浏览/导入/纠错共用；临时连接和常驻连接都走这里）

    ⚠ 数组节点会**换成它的元素节点**（arrw → arrw[1]…arrw[13]）：CODESYS 里数组元素本身就是
      独立 Variable 节点（能单独读写），而元素只挂在数组节点下面 —— 浏览默认不下钻 Variable，
      不收的话：① 「从服务器导入」拿不到真实元素 NodeId；② 「按服务器实际符号纠正地址」
         修不了 `arrw[k]` 那批地址，「换个 PLC / 设备改名」之后数组永远写不进去（BadNodeIdUnknown）。"""
    out, queue, seen = [], [(root, "", 0)], set()
    # 起始节点本身要能读 —— 填错 NodeId 时给一句人话，
    # 而不是「找到 0 个节点」让人对着空列表猜（导入对话框最常见的困惑）
    try:
        await root.read_browse_name()
    except Exception as e:                           # noqa: BLE001
        raise ValueError(f"起始节点读不到：{root.nodeid.to_string()}（{_ua_err(e)}）") from None
    while queue and len(out) < max_nodes:
        node, path, d = queue.pop(0)
        try:
            kids = await node.get_children()
        except Exception:                            # noqa: BLE001
            kids = []
        var_kids = []
        for kid in kids:
            nid_str = kid.nodeid.to_string()
            if nid_str in seen:
                continue
            seen.add(nid_str)
            try:
                cls = await kid.read_node_class()
                bn = await kid.read_browse_name()
            except Exception:                        # noqa: BLE001
                continue
            name = bn.Name
            kid_path = f"{path}/{name}" if path else name
            if cls == ua.NodeClass.Variable:
                var_kids.append((kid, name, kid_path, nid_str))
            elif cls == ua.NodeClass.Object and d < depth and kid.nodeid.NamespaceIndex != 0:
                queue.append((kid, kid_path, d + 1))
        if not var_kids:
            continue
        infos = await _read_var_infos(cli, var_kids)
        # 数组 → 换成元素节点（见函数说明）；展开失败就还是留数组节点本身
        replaced = False
        for i, info in enumerate(infos):
            if not (info["is_array"] and info["dim_n"] == 1 and "|var|" in info["nid"]):
                continue
            elems = await _element_nodes(cli, info)
            if elems:
                infos[i] = None
                out.extend(elems)
                replaced = True
        for info in infos:
            if info is None:
                continue
            if only_app_symbols and "|var|" not in info["nid"]:
                continue                             # 只要 CODESYS 应用符号（|var|…）
            if info["is_array"] and not include_arrays:
                continue
            out.append({"nodeid": info["nid"], "name": info["name"], "path": info["path"],
                        "ua_type": info["vt"], "hmi_type": info["hmi_type"],
                        "elem_type": info["base_hmi"], "elements": info["elems"], "dims": info["dim_n"],
                        "is_array": info["is_array"], "complex": bool(info["is_array"] and info["dim_n"] > 1),
                        "writable": info["writable"], "ns": info["kid"].nodeid.NamespaceIndex})
        if replaced:
            continue
    return out


def _writable(al):
    if al is None:
        return False
    try:
        return bool(al.Value.Value & ua.AccessLevel.CurrentWrite)
    except Exception:                                # noqa: BLE001
        return False


async def _read_var_infos(cli, var_kids):
    """一批变量节点 → 类型/数组维数/可写性（浏览和数组元素两处都用它）"""
    nodes = [k[0] for k in var_kids]
    try:
        dvs = await cli.read_attributes(nodes, ua.AttributeIds.Value)
    except Exception:                                # noqa: BLE001
        dvs = [None] * len(nodes)
    try:
        als = await cli.read_attributes(nodes, ua.AttributeIds.AccessLevel)
    except Exception:                                # noqa: BLE001
        als = [None] * len(nodes)
    infos = []
    for (kid, name, kid_path, nid_str), dv, al in zip(var_kids, dvs, als):
        vt_name, is_array = "", False
        if dv is not None and dv.Value is not None:
            vt_name = ua_variant_name(dv.Value.VariantType)
            is_array = bool(getattr(dv.Value, "is_array", False))
        base_hmi = hmi_type_of_variant(vt_name)
        dims = list(getattr(dv.Value, "Dimensions", None) or []) if (is_array and dv) else []
        elems = int(dims[0]) if dims else 0
        dim_n = len(dims) if dims else (1 if is_array else 0)
        infos.append({
            "kid": kid, "name": name, "path": kid_path, "nid": nid_str,
            "vt": vt_name, "base_hmi": base_hmi, "elems": elems, "dim_n": dim_n,
            "is_array": is_array, "hmi_type": f"{base_hmi}[]" if is_array else base_hmi,
            "writable": _writable(al),
        })
    return infos


async def _element_nodes(cli, info):
    """数组节点的元素子节点（arrw[1]…arrw[N]）——CODESYS 里它们是独立 Variable 节点。

    元素自己的类型可能读不出来（实测 CODESYS 上有的读回空），那就**继承父数组的元素类型**，
    别一律当 real —— 类型错了导入进来的变量表就跟着错。"""
    try:
        kids = await info["kid"].get_children()
    except Exception:                                # noqa: BLE001
        return []
    items = []
    for k in kids:
        nid = k.nodeid.to_string()
        if "|var|" not in nid:
            continue                                 # 跳过 Dimensions/IndexMin/IndexMax 这些 |vprop| 属性节点
        try:
            if await k.read_node_class() != ua.NodeClass.Variable:
                continue
            bn = await k.read_browse_name()
        except Exception:                            # noqa: BLE001
            continue
        items.append((k, bn.Name, f"{info['path']}/{bn.Name}", nid))
    if not items:
        return []
    sub = await _read_var_infos(cli, items)
    out = []
    for s in sub:
        elem_hmi = s["base_hmi"] if s["vt"] else info["base_hmi"]
        out.append({
            "nodeid": s["nid"], "name": s["name"], "path": s["path"],
            "ua_type": s["vt"] or info["base_hmi"], "hmi_type": elem_hmi,
            "elem_type": elem_hmi, "elements": 0, "dims": 0,
            "is_array": False, "complex": False,
            "writable": s["writable"], "ns": s["kid"].nodeid.NamespaceIndex,
        })
    return out


# ─────────────────────────────────────────────
#  自带体检：python server/opcua.py <端点>   （不依赖 server.py，现场排查用）
# ─────────────────────────────────────────────
if __name__ == "__main__":
    import argparse
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:                                # noqa: BLE001
        pass
    ap = argparse.ArgumentParser(description="OPC UA 连接体检（读命名空间 / 浏览节点 / 读写一个节点）")
    ap.add_argument("endpoint", nargs="?", default=DEFAULT_ENDPOINT)
    ap.add_argument("--user", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--node", default="", help="要读写试试的 NodeId（不给就只浏览）")
    ap.add_argument("--browse", default="", help="从这个 NodeId 往下浏览（默认 Objects 文件夹）")
    ap.add_argument("--depth", type=int, default=4)
    ap.add_argument("--write", default="", help="往 --node 写一个值（只读体检时别填）")
    ap.add_argument("--default-ns", type=int, default=DEFAULT_NS)
    args = ap.parse_args()

    if not AVAILABLE:
        print(f"[X] 没装 asyncua（{IMPORT_ERROR}）。装：{INSTALL_HINT}")
        sys.exit(2)
    ok, msg, info = probe(args.endpoint, username=args.user, password=args.password)
    print(("[OK] " if ok else "[X] ") + msg)
    if not ok:
        sys.exit(1)
    if args.browse or args.node or args.depth:
        r = browse(args.endpoint, args.browse, args.depth, 500, "",
                   username=args.user, password=args.password, default_ns=args.default_ns)
        print(("[OK] " if r.get("ok") else "[X] ") + str(r.get("message")))
        for n in (r.get("nodes") or [])[:40]:
            print(f"   {n['nodeid']}   {n['ua_type']}/{n['hmi_type']}"
                  f"{'  [数组]' if n['is_array'] else ''}{'  [只读]' if not n['writable'] else ''}")
    if args.node:
        src = OpcUaSource(args.endpoint, username=args.user, password=args.password,
                          default_ns=args.default_ns, poll_ms=200)
        src.declare([{"name": "probe", "type": "real", "address": args.node}], ["probe"])
        src.start()
        t0 = time.time()
        while time.time() - t0 < 8 and not src.online:
            time.sleep(0.2)
        st = src.status()
        print(f"[{'OK' if st['online'] else 'X'}] 连接：{st['last_error'] or '已连上'}")
        if st["online"]:
            print(f"   读到 {args.node} = {src.read('probe')!r}")
            if args.write:
                src.write("probe", args.write)
                time.sleep(0.5)
                print(f"   写入 {args.write} 后 = {src.read('probe')!r}")
        src.stop()
