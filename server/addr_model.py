#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
addr_model.py — **地址模型（可替换）**：把 HMI 里写的「逻辑地址」换算成实际要读写的
Modbus 区域 / 偏移 / 位，以及把读到的原始位拼回逻辑值。

为什么单独一个文件
------------------
不同 PLC 的**内存模型不一样**，而读写链路（轮询、写值、块合并）是通用的：
换一台控制器 / 换一种从站映射，只应该改这里，不该动 server.py 那条链路。
所以把「地址长什么样 → 落到哪个区」这件事集中在本文件，配一张 PROFILE 说明。

本文件现在实现的是 **Invtmatic / INVT Modbus_TCP_Slave**（手册表 5-5 / 表 5-6）：

  表 5-5 从站对外暴露的区域（功能码 → 地址区）
      0x01            %QX    位，读
      0x05 / 0x15     %QX    位，写
      0x02            %IX    位，读（只读）
      0x04            %IW    字，读（只读）
      0x03            %MW    字，读写
      0x06 / 0x16     %MW    字，写

  ⚠ 表 5-5 里**没有 %QW**（输出字区），也**没有 %MX**（内存位区）：
    · %QX 就是这个从站的输出区 —— 而它只有**位**。
      所以 `%QWn` 不是一个寄存器，而是 **16 个输出位拼出来的字**：
          %QWn = %QX(2n).0 … %QX(2n+1).7     （低位在前，见下表）
      读 = 读 16 个线圈再拼字；写 = 把字拆成 16 个位再 FC15 写线圈。
      如果把它当保持寄存器用，就会出现「%QW 和 %MW 同一个控制方式」——
      那是把**两个不同的区**混成了一个，写下去的地址根本不是操作员以为的那个。
    · %MX 与 %MW 是同一片内存（%MX195.0 落在 %MW97 的 bit8），所以它仍然
      按「保持寄存器 + 位号」读写（读改写一位），不是独立区。

  表 5-6 位/字节/字/双字的索引对应关系（表头是 %_X / %_B / %_W / %_D，下划线是占位符，
        也就是**三个区（M / I / Q）共用同一套索引换算**）：
      %_X  195.7~195.0 | 194.7~194.0 | 193.7~193.0 | 192.7~192.0
      %_B  195(高8位)  | 194(低8位)  | 193(高8位)  | 192(低8位)
      %_W              | 97(高16位)  | 96(低16位)
      %_D              |               48
    → 低字节/低字在**偶数**编号上：%MW96 = %MB192(低) + %MB193(高)；
      %MD48 = %MW96(低) + %MW97(高)。本文件的换算与它逐条对齐。

地址写法速查（换控制器时改的就是这张表）
----------------------------------------
    %MW96      保持寄存器 96              FC03 读 / FC06·FC16 写
    %MD48      双字 = %MW96(低) + %MW97(高)
    %MB194     字节 = %MW97 的低字节（偶=低字节，奇=高字节）
    %MX195.0   位  = %MW97 的 bit8（读改写一位）
    %QW0       输出字 = 16 个输出位 %QX0.0…%QX1.7（★本文件的新语义：走线圈，不是寄存器）
    %QB0       输出字节 = 8 个输出位 %QX0.0…%QX0.7（同样走线圈）
    %QD0       输出双字 = 32 个输出位 %QX0.0…%QX3.7（= %QW0 + %QW1）
    %QX1.2     输出位 → 线圈 1*8+2（FC01 读 / FC05·FC15 写）
    %IX0       离散输入 → 只读位（FC02）；%IX195.0 = 位 195*8+0
    %IW5       输入寄存器 5 → 只读字（FC04）
    %IB194     输入字节 = %IW97 的低字节（只读，和 %MB194 同一套换算）
    %ID48      输入双字 = %IW96(低) + %IW97(高)（只读，和 %MD48 同一套换算）
    HR100 / 4x0100 / 40101   兼容老写法 → 保持寄存器（无偏移）
"""
import re

# ── 区域 ──
COIL, DISCRETE, INPUT_REG, HOLDING = "coil", "discrete", "input_reg", "holding"
AREA_CN = {COIL: "线圈（输出位 %QX）", DISCRETE: "离散输入（%IX）",
           INPUT_REG: "输入寄存器（%IW）", HOLDING: "保持寄存器（%MW）"}

# ── 模型标识：日志/状态里报出来，现场一眼知道现在按哪家的地址模型在跑 ──
PROFILE = "invt-modbus-slave"          # Invtmatic / INVT Modbus_TCP_Slave（表 5-5 / 5-6）
PROFILE_CN = "Invtmatic/INVT Modbus_TCP_Slave（%QW 走 %QX 位拼字）"

BITS_PER_WORD = 16


class Address:
    """解析后的地址描述。

    bits：>0 表示「这个值不是一个寄存器，而是由 bits 个**位**拼出来的字」
          （%QW0 = 16 个线圈）。读写都要按位走，不能再当寄存器。
    """

    __slots__ = ("area", "offset", "words", "bit", "byte", "kind", "raw", "bits")

    def __init__(self, area, offset, words=1, bit=None, byte=None, kind="", raw="", bits=0):
        self.area = area          # COIL / DISCRETE / INPUT_REG / HOLDING
        self.offset = offset      # 寄存器号 或 位号
        self.words = words        # 占几个寄存器（1 / 2 / 4）
        self.bit = bit            # 字内位号 0-15（None = 整字）
        self.byte = byte          # 字内字节 0=低字节 1=高字节（None = 整字）
        self.kind = kind          # 原始种类：MW/MD/MB/MX/QW/QX/IX/IW/HR…
        self.raw = raw
        self.bits = bits          # >0 = 由 bits 个位拼成的字（%QW）

    @property
    def is_bit(self):
        """单个位（bool）：线圈/离散输入上的某一位"""
        return self.bit is not None and self.area in (COIL, DISCRETE)

    @property
    def is_word_of_bits(self):
        """字是「一串位拼出来的」（%QW）—— 读写都得按位来"""
        return self.bits > 0

    def __repr__(self):
        tail = f"×{self.bits}位拼字" if self.bits else (f".{self.bit}" if self.bit is not None else "")
        return f"<Addr {self.raw} → {self.area}#{self.offset}{tail}>"


def bits_to_word(bits):
    """一串**位**拼成一个字：第 0 个位是 bit0（低位在前，与表 5-6「低字节在偶数编号」一致）"""
    v = 0
    for i, b in enumerate(bits or []):
        if b and i < BITS_PER_WORD:
            v |= 1 << i
    return v & 0xFFFF


def word_to_bits(word, n=BITS_PER_WORD):
    """把一个字拆成 n 个位（同样是低位在前）"""
    w = int(word) & 0xFFFF
    return [bool((w >> i) & 1) for i in range(n)]


def parse_address(text, bit_area=COIL):
    """把地址字符串解析成 Address。解析不了抛 ValueError。

    bit_area: %QX/%MX 走哪个区域（默认线圈；若要按"内存位"读可传 HOLDING 走读改写）
    """
    if text is None:
        raise ValueError("地址为空")
    s = str(text).strip().upper().replace(" ", "")
    if not s:
        raise ValueError("地址为空")

    # ── 地址段写法：%MW200[10] = 从 200 起占 10 个字（字符串/数组用）──
    span = None
    m_span = re.match(r"^(.*)\[(\d+)\]$", s)
    if m_span:
        s = m_span.group(1)
        span = int(m_span.group(2))
        if not (1 <= span <= 125):
            raise ValueError(f"一段最多 125 个字：{text}")

    a = _parse_address_1(s, bit_area, text)
    if span:
        if a.area in (COIL, DISCRETE) or a.bit is not None or a.byte is not None or a.bits:
            raise ValueError(f"位/字节地址不能带 [字数]：{text}")
        a.words = span
    return a


def _parse_address_1(s, bit_area, text):
    # ── CODESYS / Invtmatic 风格：%MW96 / %MD48 / %MB194 / %MX195.0 ──
    if s.startswith("%"):
        body = s[1:]
        # %QX1.2 / %IX0.0 / %MX195.0 —— 带点的位地址
        if "." in body:
            head, _, bit_s = body.partition(".")
            m = head.rstrip("0123456789")
            num = head[len(m):]
            if not num.isdigit() or not bit_s.isdigit():
                raise ValueError(f"地址格式不对：{text}")
            kind = m or "X"
            base_byte = int(num)
            bit_in_byte = int(bit_s)
            if bit_in_byte > 7:
                raise ValueError(f"位号只能是 0-7：{text}")
            if kind in ("QX", "Q", "MX", "X"):
                # %MX 是内存位（与 %MW 同一片内存）→ 落到位号里，交给读改写处理
                if kind in ("MX",) or (kind in ("X",) and bit_area == HOLDING):
                    word = base_byte // 2
                    return Address(HOLDING, word, 1, bit=(base_byte % 2) * 8 + bit_in_byte, kind="MX", raw=text)
                return Address(COIL, base_byte * 8 + bit_in_byte, 1, bit=0, kind="QX", raw=text)
            if kind in ("IX", "I"):
                return Address(DISCRETE, base_byte * 8 + bit_in_byte, 1, bit=0, kind="IX", raw=text)
            raise ValueError(f"不认识的位地址：{text}")
        # 无点的：%MW96 / %MD48 / %MB194 / %QX0 / %IX0 / %IW5 / %QW0
        i = 0
        while i < len(body) and not body[i].isdigit():
            i += 1
        kind, num = body[:i], body[i:]
        if not num.isdigit():
            raise ValueError(f"地址格式不对：{text}")
        n = int(num)
        if not (0 <= n <= 65535):
            raise ValueError(f"地址超出 0-65535：{text}")
        if kind == "QW":
            # ★ 表 5-5 里这个从站的输出区**只有位**（%QX），没有输出字区。
            #   所以 %QW n 不是一个寄存器，而是 %QX(2n).0 … %QX(2n+1).7 这 16 个位拼出来的字
            #   （表 5-6：低字节在偶数编号上 → %QWn 的低字节是 %QB(2n) = %QX(2n).*）。
            #   ⚠ 不能落成 HOLDING：那会和 %MW 变成同一个控制方式，写下去的是别的区。
            if n * 2 > 65535:
                raise ValueError(f"%QW 超出范围：{text}")
            return Address(COIL, n * 2 * 8, 1, kind="QW", raw=text, bits=BITS_PER_WORD)
        if kind == "QB":
            # 输出字节 = %QX(n).0 … %QX(n).7 这 8 个位（同一个区：线圈）
            if n * 8 > 65535:
                raise ValueError(f"%QB 超出范围：{text}")
            return Address(COIL, n * 8, 1, kind="QB", raw=text, bits=8)
        if kind == "QD":
            # 输出双字 = %QW(2n) + %QW(2n+1) = 32 个输出位（2 个「位拼字」）
            if n * 32 > 65535:
                raise ValueError(f"%QD 超出范围：{text}")
            return Address(COIL, n * 32, 2, kind="QD", raw=text, bits=BITS_PER_WORD)
        if kind in ("MW", "W", "M"):
            return Address(HOLDING, n, 1, kind=kind or "MW", raw=text)
        if kind == "MD" or kind == "D":
            return Address(HOLDING, n * 2, 2, kind="MD", raw=text)
        if kind == "MB" or kind == "B":
            return Address(HOLDING, n // 2, 1, byte=n % 2, kind="MB", raw=text)
        if kind in ("MX", "QX", "X", "Q"):
            if kind in ("MX",) or (kind in ("X", "Q") and bit_area == HOLDING):
                return Address(HOLDING, n // 2, 1, bit=(n % 2) * 8, kind="MX", raw=text)
            return Address(COIL, n, 1, bit=0, kind="QX", raw=text)
        if kind in ("IX", "I"):
            return Address(DISCRETE, n, 1, bit=0, kind="IX", raw=text)
        if kind in ("IW",):
            return Address(INPUT_REG, n, 1, kind="IW", raw=text)
        if kind == "IB":
            # 输入字节 = %IW(n//2) 的某个字节（和 %MB 同一套换算，只是落在输入寄存器区）
            return Address(INPUT_REG, n // 2, 1, byte=n % 2, kind="IB", raw=text)
        if kind == "ID":
            # 输入双字 = 2 个输入寄存器：%IDn = %IW(2n)(低) + %IW(2n+1)(高)
            return Address(INPUT_REG, n * 2, 2, kind="ID", raw=text)
        raise ValueError(f"不认识的前缀 {kind}：{text}")

    # ── 兼容写法：HR100 / 4x0100 / 40101 / 100 ──
    if s.startswith("HR"):
        return Address(HOLDING, int(s[2:]), 1, kind="HR", raw=text)
    if s.startswith("4X"):
        return Address(HOLDING, int(s[2:]), 1, kind="HR", raw=text)
    if s.isdigit():
        n = int(s)
        if 40001 <= n <= 49999:          # 标准 Modbus 4x 区（40001 → 偏移 0）
            return Address(HOLDING, n - 40001, 1, kind="HR", raw=text)
        return Address(HOLDING, n, 1, kind="HR", raw=text)
    raise ValueError(f"无法解析的地址：{text}")
