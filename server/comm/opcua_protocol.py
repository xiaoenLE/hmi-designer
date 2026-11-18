#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""opcua_protocol.py — OPC UA（CODESYS / Invtmatic Studio 内置 OPC UA Server）

OPC UA 没有「区域/偏移/字数」那一套：地址就是一个 NodeId（ns=4;s=…）。
所以这条协议的 validate 覆写基类实现 —— 它报的明细是 ns/ident/describe，不是
area/offset（字段名仍按冻结契约，不用得上的填 None/空）。

解析/校验复用 opcua.py 的 parse_node_id / split_node_id / describe_node_id /
looks_like_modbus_address；建源返回现成的 OpcUaSource（不搬类）。
"""
from core.opcualib import opcua                # 同一份 server/opcua.py（asyncua 没装时这里是 None）
from core.plcsource import OpcUaSource         # opcualib 导出的那个类（asyncua 没装时是 None）
from .base import Protocol


class OpcUaProtocol(Protocol):
    """OPC UA：NodeId 写法（ns=N;s=符号 / ns=N;i=数字）"""

    id = "opcua"
    name = "OPC UA"
    comm = "opcua"
    addr_profile = ""
    default_address = "ns=4;s=|var|CODESYS Control Win V3.Application.GVL.x"
    probe_address = ""          # 探活探的是**端点**（opcua.probe(端点)），不是地址
    kind = "nodeid"
    help = "OPC UA NodeId：ns=N;s=符号名 / ns=N;i=数字（CODESYS 符号一般是 ns=4;s=|var|设备.应用.GVL.x）"
    prefixes = ()               # OPC UA 没有前缀表
    examples = ("ns=4;s=|var|CODESYS Control Win V3.Application.GVL.x", "ns=4;i=1001")

    # ── 解析 ──
    def parse(self, address, vtype=""):
        """NodeId 归一化成 'ns=N;<s|i|g|b>=...'（认不出抛 ValueError）"""
        return opcua.parse_node_id(address)

    # ── 校验（覆盖基类：OPC UA 没有 area/offset，明细换成 NodeId 那几项）──
    def validate(self, address, vtype="", write=None):
        raw = "" if address is None else str(address)
        text = raw.strip()
        out = {
            "ok": True, "valid": False, "unsupported": False, "code": "", "message": "",
            "warning": "", "writable": False, "protocol": self.id,
            "addr_profile": "", "prefix": "", "address": None,
        }
        if not text:
            out.update(code="empty", message="留空 = 内部变量（不采集、不下发）")
            return out
        if opcua.looks_like_modbus_address(text):
            # 填了 %MW100 / D100 / HR10 这种 —— 不是 NodeId 填错，是**协议选错了**：
            # 按内部变量处理（前端标灰），把协议改对就自动接上。
            out.update(unsupported=True, code="model",
                       message=f"地址 {raw!r} 是 Modbus/TS600 的写法，不是 OPC UA NodeId"
                               f"（当前协议 OPC UA；要填 D100 请把协议改成 TS600）")
            return out
        try:
            nodeid = opcua.parse_node_id(text)
            ns, ident_kind, ident = opcua.split_node_id(text)
        except ValueError as e:
            out.update(code="invalid", message=str(e) or "NodeId 认不出")
            return out
        out.update(valid=True, writable=True)   # OPC UA 写权限运行时按 AccessLevel 再判
        out["address"] = {
            "raw": raw,
            "area": "", "area_cn": "", "offset": None, "words": 0,
            "bit": None, "byte": None, "kind": "nodeid", "readonly": False,
            "nodeid": nodeid, "ns": ns, "ident": ident, "ident_kind": ident_kind,
            "describe": opcua.describe_node_id(text),
        }
        return out

    # ── 建数据源 ──
    def make_source(self, cfg, **callbacks):
        if opcua is None or not opcua.AVAILABLE or OpcUaSource is None:
            why = (getattr(opcua, "IMPORT_ERROR", "") or "模块没加载") if opcua else "模块没加载"
            hint = getattr(opcua, "INSTALL_HINT", "") if opcua else ""
            raise ValueError(f"后端没有可用的 asyncua（{why}）—— 装：{hint}")
        cfg = dict(cfg or {})
        return OpcUaSource(cfg.get("endpoint") or opcua.DEFAULT_ENDPOINT,
                           cfg.get("security", "none"),
                           cfg.get("username", ""),
                           cfg.get("password", ""),
                           cfg.get("poll_ms", 200),
                           cfg.get("timeout", 6.0),
                           cfg.get("default_ns", opcua.DEFAULT_NS),
                           on_change=callbacks.get("on_change"),
                           on_changes=callbacks.get("on_changes"),
                           retain=callbacks.get("retain"))


PROTOCOL = OpcUaProtocol()
