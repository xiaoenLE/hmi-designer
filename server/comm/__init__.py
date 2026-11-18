#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""server/comm/ — **通讯协议注册表**（可扩展）

以后加一种通讯（比如 Siemens S7、Modbus RTU）只做三件事：
    1. 在 comm/ 下新建 xxx_protocol.py，写个 Protocol 子类（填目录 + parse/make_source）；
    2. 在下面 _REGISTRY / _ORDER 里登记；
    3. core/datasource.py 不用动（它只认 make_source 返回的 PlcSource / OpcUaSource 接口）。

对外的公共 API（前后端冻结契约，见 task-7）：
    protocols() -> [{info}, …]            GET  /api/comm/protocols
    get(pid) / info(pid)                  取单个协议对象 / 它的目录项
    normalize(raw) -> pid                 协议名→id（"ts"/"modbus_ts"/"ua"… 都收；"" = modbus）
    validate(pid, address, vtype, write)  POST /api/comm/validate
    default_address(pid)                  新变量默认地址 /「测试连接」探活地址
    make_source(pid, cfg, **callbacks)    按配置建数据源（薄适配，返回已有的源对象）

另外给 core/datasource.py 用的两个小工具（不属于前端契约）：
    pid_for(protocol, addr_profile)       落盘口径（protocol=modbus/opcua + addr_profile=…）→ pid
    link_of(pid) / profile_of(pid)        这条协议实际走什么链路 / 用哪个地址模型

⚠ 落盘口径**没变**：TS600 还是 protocol="modbus" + addr_profile="ts600-modbus-tcp"
（现场 plc.json 里就是这么存的，改了老配置就认不出来）。
"""
from .base import AREA_CN, Protocol, as_bool, profile_id
from .modbus_protocol import PROTOCOL as _MODBUS
from .ts600_protocol import PROTOCOL as _TS600
from .opcua_protocol import PROTOCOL as _OPCUA

# 注册表顺序 = 前端下拉框顺序（**顺序是契约的一部分**）：modbus → ts600 → opcua
_ORDER = ("modbus", "ts600", "opcua")
_REGISTRY = {"modbus": _MODBUS, "ts600": _TS600, "opcua": _OPCUA}

# 协议别名（现场配置/老前端留下的写法都收）——normalize 用
_TS_ALIASES = ("ts", "ts600", "ts600_tcp", "ts600-tcp", "ts600_modbus_tcp",
               "ts600-modbus-tcp", "ts600 modbus tcp", "modbus_ts", "modbus-ts")
_UA_ALIASES = ("opcua", "opc-ua", "opc_ua", "ua", "opcua_ua")
_MODBUS_ALIASES = ("", "modbus", "modbus-tcp", "modbus_tcp", "modbus tcp",
                   "invt", "invtmatic", "invt-modbus-slave")

# 协议不认识时给人话（和 /api/plc 里 _PROTOCOL_IDS 同一个口径）
_PROTOCOL_HELP = ("modbus（Modbus TCP，INVT 写法 %MW/%MD/%QX…） / "
                  "ts600（TS600 TCP，元件写法 D100/M10/X17…） / opcua（OPC UA）")


def normalize(raw):
    """协议名 → 协议 id：'' → modbus；ts/ts600/ts600_tcp/modbus_ts… → ts600；ua → opcua。

    认不出抛 ValueError（带可选列表）。
    """
    p = str(raw or "").strip().lower()
    if p in _TS_ALIASES:
        return "ts600"
    if p in _UA_ALIASES:
        return "opcua"
    if p in _MODBUS_ALIASES:
        return "modbus"
    raise ValueError(f"协议 {raw!r} 不认识；可选：{_PROTOCOL_HELP}"
                     f"（也可以写 ts / modbus_ts / ts600_tcp / ua 这类写法）")


def _is_ts_profile(raw):
    """地址模型 id/别名是不是 TS600 那一套（老配置 protocol=modbus + addr_profile=ts600）"""
    s = str(raw or "").strip().lower()
    return s in _TS_ALIASES


def pid_for(protocol="", addr_profile=""):
    """落盘口径 → comm 协议 id（core/datasource.py 用）。

    现场 plc.json 存的是 protocol="modbus"/"opcua" + addr_profile="invt-modbus-slave"/
    "ts600-modbus-tcp"，所以「选的是哪条协议」要看这两项一起：
      · protocol 是 ts 别名 → ts600（协议下拉三项里的 TS600，链路仍是 Modbus TCP）
      · protocol 是 modbus 但 addr_profile 是 TS600 模型 → ts600（三协议下拉的中间版本）
      · protocol 是 opcua → opcua（不看 addr_profile）
      · 其余 → modbus
    """
    pid = normalize(protocol)              # "" → modbus
    if pid == "opcua":
        return "opcua"
    if pid == "ts600":
        return "ts600"
    return "ts600" if _is_ts_profile(addr_profile) else "modbus"


def get(pid):
    """协议 id（或别名）→ 协议对象"""
    key = normalize(pid)
    try:
        return _REGISTRY[key]
    except KeyError:                        # normalize 只吐上面三个，兜底防手滑
        raise ValueError(f"协议 {pid!r} 没有注册；可选：{' / '.join(_ORDER)}")


def info(pid):
    """单条协议的目录项（形状见 base.Protocol.info / task-7 契约）"""
    return get(pid).info()


def protocols():
    """协议目录（/api/comm/protocols 的 protocols[]）—— 顺序固定 modbus→ts600→opcua"""
    return [info(pid) for pid in _ORDER]


def default_address(pid):
    """这条协议的「默认地址」：新变量默认填它，「测试连接」也探它"""
    return str(get(pid).default_address)


def link_of(pid):
    """实际链路：modbus-tcp / opcua（前端据此决定填 IP+端口 还是端点）"""
    return get(pid).comm


def profile_of(pid):
    """这条协议对应的地址模型 id（OPC UA 没有 → ""）"""
    return get(pid).addr_profile


def validate(pid, address, vtype="", write=None):
    """地址校验（POST /api/comm/validate 的实现，形状见 base.Protocol.validate）。

    协议不认识抛 ValueError（接口层回 400），**地址本身不合法不抛异常**。
    """
    return get(pid).validate(address, vtype=vtype, write=write)


def make_source(pid, cfg, **callbacks):
    """按配置建数据源（薄适配）。

    回调：on_change / on_changes（值变了）/ retain（OPC UA 内部变量的掉电保持存档）。
    ⚠ 地址模型是进程级全局量：modbus/ts600 会在这里把模型切成自己的那套并**保持**，
      调用方紧接着 declare(variables) 才能按对的模型解析 —— 这段请持 _addr_model_lock
      （core/datasource.py 的 plc_connect 就是这么做的，别在锁外建源 + 声明）。
    """
    return get(pid).make_source(cfg, **callbacks)


__all__ = [
    "AREA_CN", "Protocol", "as_bool", "profile_id",
    "protocols", "get", "info", "normalize", "validate", "make_source",
    "default_address", "link_of", "profile_of", "pid_for",
]
