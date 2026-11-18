#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""modbus_protocol.py — Modbus TCP（INVT Modbus_TCP_Slave 的 %MW/%QX 写法）

*地址写法*不在这个文件实现：解析/校验复用 addr_model.parse_address（协议基类
ModbusTcpProtocol 负责临时切到 invt-modbus-slave 模型）。这里只有：
    · 目录（下拉框、前缀提示、示例）
    · 建数据源（返回现有 PlcSource，链路一行没改）
"""
from .base import ModbusTcpProtocol

# 地址前缀目录（前端「地址前缀」提示 + 校验后回显；每项字段冻结，见 task-7 契约）
#   prefix 前缀写法 / label 中文名 / kind 类型（word|bit|bitword|bits|nodeid）
#   types  支持的数据类型 / writable 能不能写 / example 示例 / note 一句话说明
_PREFIXES = [
    {"prefix": "%MW", "label": "保持寄存器", "kind": "word",
     "types": ["int", "uint", "real", "dint", "udint", "lreal"], "writable": True,
     "example": "%MW100", "note": "保持寄存器 0~65535（FC03 读 / FC06、FC16 写）"},
    {"prefix": "%MD", "label": "保持寄存器（双字）", "kind": "word",
     "types": ["dint", "udint", "real"], "writable": True,
     "example": "%MD48", "note": "%MD48 = %MW96（低字）+ %MW97（高字），低字在前"},
    {"prefix": "%MB", "label": "保持寄存器（字节）", "kind": "word",
     "types": ["int", "uint"], "writable": True,
     "example": "%MB194", "note": "%MB 是 %MW 的 8 位字节（偶编号=低字节、奇=高字节）：%MB194 = %MW97 低字节"},
    {"prefix": "%MX", "label": "位（在寄存器里）", "kind": "bit",
     "types": ["bool"], "writable": True,
     "example": "%MX195.0", "note": "%MX 和 %MW 同一片内存：%MX195.0 = %MW97 的 bit8；写一位走「读-改-写」"},
    {"prefix": "%QW", "label": "输出字（16 个输出位）", "kind": "bits",
     "types": ["int", "uint"], "writable": True,
     "example": "%QW0", "note": "输出字 = %QX(2n).0～%QX(2n+1).7 共 16 个输出位（**不是寄存器**）"},
    {"prefix": "%QB", "label": "输出字节（8 个输出位）", "kind": "bits",
     "types": ["int", "uint"], "writable": True,
     "example": "%QB0", "note": "输出字节 = 8 个输出位 %QX(n).0～%QX(n).7"},
    {"prefix": "%QD", "label": "输出双字（32 个输出位）", "kind": "bits",
     "types": ["dint", "udint", "real"], "writable": True,
     "example": "%QD0", "note": "输出双字 = 32 个输出位（%QW0 + %QW1）"},
    {"prefix": "%QX", "label": "输出位", "kind": "bit",
     "types": ["bool"], "writable": True,
     "example": "%QX1.2", "note": "输出位 → 线圈（FC01 读 / FC05、FC15 写）"},
    {"prefix": "%IX", "label": "输入位（只读）", "kind": "bit",
     "types": ["bool"], "writable": False,
     "example": "%IX0.0", "note": "离散输入 → 只读位（FC02），不能写"},
    {"prefix": "%IW", "label": "输入寄存器（只读）", "kind": "word",
     "types": ["int", "uint"], "writable": False,
     "example": "%IW5", "note": "输入寄存器 → 只读字（FC04），不能写"},
    {"prefix": "%IB", "label": "输入寄存器（字节，只读）", "kind": "word",
     "types": ["int", "uint"], "writable": False,
     "example": "%IB194", "note": "%IB194 = %IW97 的低字节（只读，和 %MB 同一套换算）"},
    {"prefix": "%ID", "label": "输入寄存器（双字，只读）", "kind": "word",
     "types": ["dint", "udint", "real"], "writable": False,
     "example": "%ID48", "note": "%ID48 = %IW96（低字）+ %IW97（高字）（只读）"},
]


class ModbusProtocol(ModbusTcpProtocol):
    """Modbus TCP：INVT Modbus_TCP_Slave 的 %MW/%MD/%MB/%MX/%QW/%IX… 写法"""

    id = "modbus"
    name = "Modbus TCP（INVT）"
    comm = "modbus-tcp"
    addr_profile = "invt-modbus-slave"
    default_address = "%MW0"
    probe_address = "%MW0"
    kind = "element"
    help = ("Modbus TCP（INVT Modbus_TCP_Slave）：写 %MW/%MD/%MB/%MX、%QW/%QB/%QD、"
            "%QX；只读 %IX/%IW/%IB/%ID")
    prefixes = tuple(_PREFIXES)
    examples = ("%MW100", "%MD48", "%QX1.2", "%IX0.0", "%IW5", "HR100")
    note = ("也认标准写法：HR100 / 4x0100 → 保持寄存器偏移 100；纯数字按 Modbus 地址编号解析"
            "（40001~49999 → 偏移 n-40001，其余按偏移 n）")
    force_profile = False


PROTOCOL = ModbusProtocol()
