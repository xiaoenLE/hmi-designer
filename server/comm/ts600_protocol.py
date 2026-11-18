#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ts600_protocol.py — TS600（Invtmatic Studio / TS600 元件写法 D100、M10、X17）

链路就是 Modbus TCP（TS600 的 D/M/… 全落在 Modbus 的保持寄存器 / 线圈上），
区别只在**地址模型**：addr_model 里 ts600-modbus-tcp 那套元件表。
解析/校验直接复用 addr_model.parse_address（基类临时切模型），这里只有目录和建源。
"""
from .base import ModbusTcpProtocol

# TS600 元件表（地址前缀目录；字段见 base.Protocol / task-7 契约）
_PREFIXES = [
    {"prefix": "D", "label": "数据寄存器", "kind": "word",
     "types": ["int", "uint", "real", "dint", "udint", "lreal"], "writable": True,
     "example": "D100", "note": "D0~D32767 数据寄存器（保持寄存器）"},
    {"prefix": "R", "label": "扩展数据寄存器", "kind": "word",
     "types": ["int", "uint", "real", "dint", "udint", "lreal"], "writable": True,
     "example": "R100", "note": "R0~R16383（R16384~R32767 手册未映射，写了会报错）"},
    {"prefix": "Z", "label": "变址寄存器", "kind": "word",
     "types": ["int", "uint"], "writable": True,
     "example": "Z3", "note": "Z0~Z15 变址寄存器（16 位）"},
    {"prefix": "M", "label": "内部辅助继电器", "kind": "bit",
     "types": ["bool"], "writable": True,
     "example": "M10", "note": "M0~M32767（M0~M999 掉电不保存）"},
    {"prefix": "S", "label": "状态继电器", "kind": "bit",
     "types": ["bool"], "writable": True,
     "example": "S10", "note": "S0~S4095（S0~S999 掉电不保存）"},
    {"prefix": "X", "label": "输入继电器（只读）", "kind": "bit",
     "types": ["bool"], "writable": False,
     "example": "X17", "note": "X0~X1777 输入，**8 进制**编号，只读"},
    {"prefix": "Y", "label": "输出继电器", "kind": "bit",
     "types": ["bool"], "writable": True,
     "example": "Y10", "note": "Y0~Y1777 输出，**8 进制**编号"},
    {"prefix": "T", "label": "定时器", "kind": "bitword",
     "types": ["bool", "int", "uint"], "writable": True,
     "example": "T5",
     "note": ("T0~T399：bool = 触点（可写位，位元件区 0xC000+n），"
              "数值 = 当前值（16 位字，字元件区 0xE000+n）")},
    {"prefix": "C", "label": "计数器", "kind": "bitword",
     "types": ["bool", "int", "uint", "dint", "udint", "real"], "writable": True,
     "example": "C200",
     "note": ("bool = 触点（可写位，位元件区 0xC200+n），数值 = 当前值（字）；"
              "C0~C199 int/uint；C200~C255 dint/udint/real 双字")},
]


class Ts600Protocol(ModbusTcpProtocol):
    """TS600 TCP：元件写法（D/R/Z 字，M/S/X/Y 位，T/C 触点+当前值）"""

    id = "ts600"
    name = "TS600 TCP"
    comm = "modbus-tcp"
    addr_profile = "ts600-modbus-tcp"
    default_address = "D0"
    probe_address = "D0"
    kind = "element"
    help = "TS600 元件写法：位 M/S/X/Y/T/C，字 D/R/T/C/Z"
    prefixes = tuple(_PREFIXES)
    examples = ("D100", "M10", "X17", "Y10", "T5", "C200")
    note = ("也认 Modbus 写法（%MW/%W/%MD、HR100、4x0100、纯数字），按 TS600 的 Modbus "
            "映射解析；D 从偏移 0 开始")
    # 协议下拉选了 TS600 就必须按 TS600 解析：老前端可能还带着 addr_profile=invt，
    # 不能因此把 D100 当内部变量（现场「连上了但值不动」就是这么来的）。
    force_profile = True


PROTOCOL = Ts600Protocol()
