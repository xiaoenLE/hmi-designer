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

本文件里有**两套**地址模型（`PROFILES`，连接 PLC 时选，配置存 plc.json 的 addr_profile）：

① `invt-modbus-slave` —— Invtmatic / INVT Modbus_TCP_Slave（手册表 5-5 / 表 5-6）

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

  地址写法速查
      %MW96      保持寄存器 96              FC03 读 / FC06·FC16 写
      %MD48      双字 = %MW96(低) + %MW97(高)
      %MB194     字节 = %MW97 的低字节（偶=低字节，奇=高字节）
      %MX195.0   位  = %MW97 的 bit8（读改写一位）
      %QW0       输出字 = 16 个输出位 %QX0.0…%QX1.7（★本文件语义：走线圈，不是寄存器）
      %QB0       输出字节 = 8 个输出位 %QX0.0…%QX0.7（同样走线圈）
      %QD0       输出双字 = 32 个输出位 %QX0.0…%QX3.7（= %QW0 + %QW1）
      %QX1.2     输出位 → 线圈 1*8+2（FC01 读 / FC05·FC15 写）
      %IX0       离散输入 → 只读位（FC02）；%IX195.0 = 位 195*8+0
      %IW5       输入寄存器 5 → 只读字（FC04）
      %IB194     输入字节 = %IW97 的低字节（只读，和 %MB194 同一套换算）
      %ID48      输入双字 = %IW96(低) + %IW97(高)（只读，和 %MD48 同一套换算）
      HR100 / 4x0100 / 40101   兼容老写法 → 保持寄存器（无偏移）

② `ts600-modbus-tcp` —— TS600 系列可编程逻辑控制器（手册 7.7.3.2「地址绑定表」）

  作 Modbus TCP 从站时，元件 → 协议地址（十进制偏移，**无 1 偏移**，即 D0 = 寄存器 0）：

      元件          类型    数量    协议地址            支持功能码        说明
      M0~M32767     位      32768   0x0000~0x7FFF       01、05、15       M0~M999 掉电不保存
      S0~S4095      位      4096    0x8000~0x8FFF       01、05、15       S0~S999 掉电不保存
      X0~X1777      位      1024    0xA000~0xA3FF       01、02           输入，8 进制编码 BOOL，**只读**
      Y0~Y1777      位      1024    0xB000~0xB3FF       01、05、15       输出，8 进制编码 BOOL
      T0~T399       位      400     0xC000~0xC18F       01、05、15       定时器触点（100ms/10ms/1ms）
      C0~C255       位      256     0xC200~0xC2FF       01、05、15       计数器触点
      D0~D32767     字      32768   0x0000~0x7FFF       03、06、16       数据寄存器
      R0~R16383     字      16384   0x8000~0xBFFF       03、06、16       R16384~R32767 未映射
      T0~T399       字      400     0xE000~0xE18F       03、06、16       定时器当前值（每点 1 个字）
      C0~C199       字      200     0xE200~0xE2C7       03、06、16       16 位计数器当前值
      C200~C255     字      56      0xE2C8~0xE337       03、06、16       32 位计数器，**双字元件/2 寄存器**
      Z0~Z15        字      16      0xE400~0xE40F       03、06、16       变址寄存器
    注意：T 和 C 同时有字元件与位元件 —— 同一个 T5 是 bool 就落在定时器触点（线圈区），
    是数值就落在定时器当前值（保持寄存器区）。本文件按**变量类型** (vtype) 区分；
    X 是输入元件，只能读（写 X 直接报错，不等从站返异常码）。

  地址写法速查（大小写都行，中间不能有空格）
      D100       数据寄存器 D100            FC03 读 / FC06·FC16 写
      R100       R100 = 协议寄存器 32868
      T5         bool → 定时器触点（线圈 49157）；int → 当前值（寄存器 57349）
      C200       32 位计数器 → 寄存器 58056~58057（words=2，类型必须 dint/udint/real）
      Z3         变址寄存器 58371
      M10        辅助继电器（线圈 10）
      S10        状态继电器（线圈 32778）
      X17        输入（离散输入 40975，八进制：X17 = 十进制 15，只读）
      Y10        输出（线圈 45064，八进制：Y10 = 十进制 8）
      D100[10]   从 D100 起占 10 个字（字符串/数组用）

  兼容写法：`%MW/%MD/%MB/%MX/%QW/%QX/%IX/%IW`、`HR100`、`4x0100`、纯数字（40101）在
  TS600 模型下照样按**协议偏移**解析（它们描述的就是 Modbus 地址本身，跟元件名无关）。

模型标识（PROFILE / PROFILE_CN）会出现在状态栏与日志里，现场一眼知道现在按哪家地址模型在跑；
换控制器只改这个文件（注册到 PROFILES 即可），读写链路一行都不用动。
"""
import re

# ── 区域 ──
COIL, DISCRETE, INPUT_REG, HOLDING = "coil", "discrete", "input_reg", "holding"
AREA_CN = {COIL: "线圈（输出位 %QX）", DISCRETE: "离散输入（%IX）",
           INPUT_REG: "输入寄存器（%IW）", HOLDING: "保持寄存器（%MW）"}

BITS_PER_WORD = 16


class UnsupportedAddress(ValueError):
    """「这种写法不属于当前地址模型」——不是拼写/越界错误，是模型不匹配。

    例如：当前模型是 INVT 时写 D100（TS600 元件写法）；当前模型是 TS600 时写
    %MX0.0 / %QX / %QW（TS600 没有字内取位、位打包、输入寄存器地址）。

    调用方（PlcSource.declare）把这类变量**当内部变量**处理：不采集、不下发、
    不报错，只在变量表里注明原因。真正的错误（认不出、越界、类型不配）仍然
    抛普通 ValueError，按坏地址显示。
    """


# ── 地址模型注册表：换控制器时在这里加一套，并在 parse_address 里接上 ──
PROFILES = {
    "invt-modbus-slave": "Invtmatic/INVT Modbus_TCP_Slave（%MW/%MD/%QX/%QW… 写法）",
    "ts600-modbus-tcp": "TS600 系列（D/M/X/Y/S/T/C/R/Z 元件写法）",
}

# 当前生效的模型（import 时是 INVT，保持向后兼容；连接 PLC 时用 set_profile 切）
PROFILE = "invt-modbus-slave"
PROFILE_CN = PROFILES[PROFILE]

# 别名：现场输入/老配置里可能写 ts、ts600、invt…
_PROFILE_ALIASES = {
    "": "invt-modbus-slave",
    "invt": "invt-modbus-slave",
    "invtmatic": "invt-modbus-slave",
    "invt-modbus-slave": "invt-modbus-slave",
    "ts": "ts600-modbus-tcp",
    "ts600": "ts600-modbus-tcp",
    "ts600-modbus-tcp": "ts600-modbus-tcp",
    "ts600-modbus": "ts600-modbus-tcp",
}


def profiles():
    """所有可用地址模型：[{id, cn}]（前端下拉框直接用）"""
    return [{"id": k, "cn": v} for k, v in PROFILES.items()]


def _profile_key(name):
    """把用户给的模型名归一成注册表 key；认不出抛 ValueError"""
    raw = str(name or "").strip().lower()
    key = _PROFILE_ALIASES.get(raw)
    if key is None:
        raise ValueError(f"不认识的地址模型 {name!r}，目前支持：{'、'.join(PROFILES)}")
    return key


def get_profile():
    """当前生效的地址模型 id"""
    return PROFILE


def profile_ok(name):
    try:
        _profile_key(name)
        return True
    except ValueError:
        return False


def set_profile(name):
    """切换当前地址模型（连接 PLC 时由 plc.json 的 addr_profile 决定）。返回归一后的 id"""
    global PROFILE, PROFILE_CN
    key = _profile_key(name)
    PROFILE = key
    PROFILE_CN = PROFILES[key]
    return PROFILE


def profile_cn(name=None):
    return PROFILES.get(_profile_key(name) if name else PROFILE, PROFILE_CN)


def default_address():
    """「测试连接」探一个地址用：每套模型给一个一定存在的字元件"""
    return "D0" if PROFILE == "ts600-modbus-tcp" else "%MW0"


# ─────────────────────────────────────────────
#  Address
# ─────────────────────────────────────────────
class Address:
    """解析后的地址描述。

    bits：>0 表示「这个值不是一个寄存器，而是由 bits 个**位**拼出来的字」
          （%QW0 = 16 个线圈）。读写都要按位走，不能再当寄存器。
    readonly：只读元件（TS600 的 X 输入）。读可以，写直接拒绝（别等从站返回异常码）。
    """

    __slots__ = ("area", "offset", "words", "bit", "byte", "kind", "raw", "bits",
                 "readonly", "profile")

    def __init__(self, area, offset, words=1, bit=None, byte=None, kind="", raw="", bits=0,
                 readonly=False, profile=""):
        self.area = area          # COIL / DISCRETE / INPUT_REG / HOLDING
        self.offset = offset      # 寄存器号 或 位号
        self.words = words        # 占几个寄存器（1 / 2 / 4）
        self.bit = bit            # 字内位号 0-15（None = 整字）
        self.byte = byte          # 字内字节 0=低字节 1=高字节（None = 整字）
        self.kind = kind          # 原始种类：MW/MD/MB/MX/QW… 或 TS600 的 D/M/X/Y/S/T/C/R/Z
        self.raw = raw
        self.bits = bits          # >0 = 由 bits 个位拼成的字（%QW/%QB/%QD）
        self.readonly = bool(readonly)   # 只读元件（TS600 的 X）
        self.profile = profile    # 解析时用的地址模型（排查/校验用；'' = 未记录）

    @property
    def is_bit(self):
        """单个位（bool）：线圈/离散输入上的某一位"""
        return self.bit is not None and self.area in (COIL, DISCRETE)

    @property
    def is_word_of_bits(self):
        """字是「一串位拼出来的」（%QW）—— 读写都得按位来"""
        return self.bits > 0

    @property
    def writable(self):
        return not self.readonly

    def __repr__(self):
        tail = f"×{self.bits}位拼字" if self.bits else (f".{self.bit}" if self.bit is not None else "")
        ro = "只读" if self.readonly else ""
        return f"<Addr {self.raw} → {self.area}#{self.offset}{tail}{ro}>"


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


# ─────────────────────────────────────────────
#  统一入口
# ─────────────────────────────────────────────
def parse_address(text, bit_area=COIL, vtype="", profile=None):
    """把地址字符串解析成 Address。解析不了抛 ValueError。

    bit_area: %QX/%MX 走哪个区域（默认线圈；若要按"内存位"读可传 HOLDING 走读改写）
    vtype:    变量类型（bool/int/uint/real/dint/udint/lreal/string/[…]）。
              **只有 TS600 模型需要它**：T/C 的位元件与字元件靠类型区分
              （bool → 触点/线圈；数值 → 当前值/寄存器）。不传 = 按字元件处理。
    profile:  显式指定地址模型（不传 = 当前生效的 PROFILE）。
    """
    if text is None:
        raise ValueError("地址为空")
    key = _profile_key(profile) if profile else PROFILE
    raw = str(text)
    s = raw.strip().upper().replace(" ", "").replace("\u3000", "")
    if not s:
        raise ValueError("地址为空")

    # ── 地址段写法：%MW200[10] / D100[10] = 从该地址起占 N 个字（字符串/数组用）──
    span = None
    m_span = re.match(r"^(.*)\[(\d+)\]$", s)
    if m_span:
        s = m_span.group(1)
        span = int(m_span.group(2))
        if not (1 <= span <= 125):
            raise ValueError(f"一段最多 125 个字：{text}")

    if key == "ts600-modbus-tcp":
        return _parse_ts600(s, raw, span, str(vtype or ""), key)

    try:
        a = _parse_address_1(s, bit_area, raw)
    except UnsupportedAddress:
        raise
    except ValueError:
        # INVT 模型下写了 TS600 元件写法（D100 / M100 / X17 …）：不是错，是模型不匹配
        # → 交给调用方当内部变量（用户要求：写法不匹配就不通讯，不报错）
        if re.fullmatch(r"([DMSXYTCRZ])([0-9]+)", s):
            raise UnsupportedAddress(
                f"当前地址模型是「{PROFILE_CN}」，不认 TS600 元件写法「{raw}」；"
                f"在 PLC 设置里把协议改成 TS600 TCP 才会通讯，否则按内部变量处理")
        raise
    if span is not None:
        _apply_span(a, span, raw)
    a.profile = key
    return a


def _apply_span(a, span, raw):
    if span is None:
        return
    if a.area in (COIL, DISCRETE) or a.bit is not None or a.byte is not None or a.bits:
        raise ValueError(f"位/字节地址不能带 [字数]：{raw}")
    a.words = span


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


# ─────────────────────────────────────────────
#  TS600 地址模型
# ─────────────────────────────────────────────
# 位元件：元件 → (协议基址, 数量, 进制, 是否只读)
_TS_BIT_ZONES = {
    "M": (0x0000, 32768, 10, False),   # M0~M32767       线圈
    "S": (0x8000, 4096, 10, False),    # S0~S4095        线圈
    "X": (0xA000, 1024, 8, True),      # X0~X1777        离散输入，只读
    "Y": (0xB000, 1024, 8, False),     # Y0~Y1777        线圈
    "T": (0xC000, 400, 10, False),     # T0~T399         定时器触点
    "C": (0xC200, 256, 10, False),     # C0~C255         计数器触点
}

# 字元件：元件 → (协议基址, 数量, 每元件字数, 说明)
_TS_WORD_ZONES = {
    "D": (0x0000, 32768, 1, "数据寄存器 D0~D32767"),
    "R": (0x8000, 16384, 1, "R0~R16383（R16384~R32767 未映射）"),
    "T": (0xE000, 400, 1, "定时器当前值 T0~T399（16 位）"),
    "C": (0xE200, 200, 1, "16 位计数器当前值 C0~C199"),
    "C32": (0xE2C8, 56, 2, "32 位计数器 C200~C255（双字元件，占 2 个寄存器）"),
    "Z": (0xE400, 16, 1, "变址寄存器 Z0~Z15"),
}

# 16 位 / 32 位 / 64 位 / 字符串：和 modbus.words_for 保持一致
_TS_T16 = ("int", "uint")
_TS_T32 = ("real", "dint", "udint", "dword", "time", "time_of_day")
_TS_T64 = ("lreal", "lint", "ulint", "lword", "ltime", "dt", "date_and_time")
_TS_TSTR = ("string", "wstring")


def _ts_base_type(vtype):
    """'real[]' → ('real', True)；'bool' → ('bool', False)；'' → ('', False)"""
    v = str(vtype or "").strip().lower()
    if v.endswith("[]"):
        return v[:-2].strip(), True
    return v, False


def _ts_need_words(vtype):
    """类型占几个寄存器；None = 由字符串长度/数组长度决定（这里算不出来）"""
    base, arr = _ts_base_type(vtype)
    if not base:
        return 1
    if arr:
        return None
    if base in _TS_T32:
        return 2
    if base in _TS_T64:
        return 4
    if base in _TS_TSTR:
        return None
    return 1


def _ts_index(digits, radix, count, kind, raw):
    """编号校验 + 进制换算（X/Y 是 8 进制）"""
    if radix == 8:
        if any(c not in "01234567" for c in digits):
            raise ValueError(f"{kind} 是 8 进制编码的元件（手册：8 进制编码 BOOL 类型），"
                             f"编号里不能出现 8/9：{raw}")
        n = int(digits, 8)
        rng = f"0~{format(count - 1, 'o')}（八进制）"
    else:
        n = int(digits)
        rng = f"0~{count - 1}"
    if n < 0 or n >= count:
        raise ValueError(f"{kind} 编号超出范围 {rng}：{raw}")
    return n


def _ts_check_bit_vtype(kind, vtype, raw):
    """位元件只吃 bool（X 只读，但读也必须是 bool）"""
    base, arr = _ts_base_type(vtype)
    if not base:
        return
    if arr and base == "bool":
        raise ValueError(f"位元件不支持 bool[] 数组变量（拆成多个 bool 变量）：{raw}")
    if base != "bool":
        raise ValueError(f"{kind} 元件是位元件，只能配 bool 变量；"
                         f"数值请放字元件（D/R/T/C/Z）：{raw}")


def _ts_check_word16(kind, n, vtype, raw):
    """16 位字元件（T 当前值 / C0~C199）只吃 int/uint"""
    base, _arr = _ts_base_type(vtype)
    if not base:
        return
    if base in _TS_T32 or base in _TS_T64 or base in _TS_TSTR:
        what = "32 位" if base in _TS_T32 else ("64 位" if base in _TS_T64 else "字符串")
        raise ValueError(f"{kind}{n} 是 16 位字元件（1 个寄存器），放不下{what}类型；"
                         f"{what}数据请放 D/R（C200~C255 是 32 位计数器）：{raw}")


def _ts_check_word32(kind, n, vtype, raw):
    """32 位双字元件（C200~C255）必须配 32 位类型（否则只读到低 16 位，值会莫名对不上）"""
    base, _arr = _ts_base_type(vtype)
    if not base:
        return
    if base in _TS_T16 or base in _TS_TSTR or base in _TS_T64 or base == "bool":
        raise ValueError(f"{kind}{n} 是 32 位双字计数器（2 个寄存器对应 1 个元件），"
                         f"变量类型要用 dint/udint/real：{raw}")


def _ts_fit(a, zone_end, raw):
    """多字读写不能越出元件区（D32767 放 REAL 会踩到 D 区外）"""
    if not a.words:
        return
    if a.offset + a.words - 1 > zone_end:
        raise ValueError(f"{raw} 占 {a.words} 个字，超出元件区末地址 "
                         f"(协议 {zone_end})：换个小一点的编号，或改用能放下的类型")


def _parse_ts600(s, raw, span, vtype, key):
    base_type, _arr = _ts_base_type(vtype)
    is_bool = base_type == "bool"

    # ① 兼容「协议地址」写法：TS600 没有 %MX0.0 这类字内取位、位打包地址，
    #    只认直接描述寄存器号的 %MW/%W/%MD、HR100、4x0100、纯数字。
    #    其它 % 写法（%MX/%QX/%QW/%QB/%QD/%IX/%IW/%IB/%ID/%M…）一律算「模型不匹配」，
    #    由调用方当内部变量处理（用户口径：写法不匹配就不通讯，不报错）。
    if s.startswith("%"):
        body = s[1:]
        proto_kind = body.rstrip("0123456789")
        if "." in body or proto_kind not in ("MW", "W", "MD"):
            raise UnsupportedAddress(
                f"TS600 没有「{raw}」这种写法（没有 %MX/%QX/%QW/%QB/%IX/%IW 字内取位、"
                f"位打包、输入区地址）；位直接写元件位地址 M10/X17/Y10，"
                f"寄存器写 D100 或 %MW100。这种变量按内部变量处理，不通讯")
        a = _parse_address_1(s, COIL, raw)
        _apply_span(a, span, raw)
        a.profile = key
        return a
    if s.startswith("HR") or s.startswith("4X") or s.isdigit():
        a = _parse_address_1(s, COIL, raw)
        _apply_span(a, span, raw)
        a.profile = key
        return a

    m = re.fullmatch(r"([A-Z])([0-9]+)", s)
    if not m:
        raise ValueError(f"TS600 地址写法应为「元件字母+编号」"
                         f"（D100 / M200 / S10 / X17 / Y10 / T5 / C200 / R100 / Z3），"
                         f"也兼容 %MW/HR/数字写法：{raw}")
    kind, digits = m.group(1), m.group(2)

    # ② 位元件：M / S / X / Y / T / C（bool 变量）
    if kind in _TS_BIT_ZONES and (kind in ("M", "S", "X", "Y") or is_bool):
        _ts_check_bit_vtype(kind, vtype, raw)
        if span is not None:
            raise ValueError(f"位元件不能带 [字数]（那是给字元件/字符串用的）：{raw}")
        base_addr, count, radix, readonly = _TS_BIT_ZONES[kind]
        n = _ts_index(digits, radix, count, kind, raw)
        area = DISCRETE if kind == "X" else COIL
        return Address(area, base_addr + n, 1, bit=0, kind=kind, raw=raw,
                       readonly=readonly, profile=key)

    # ③ 字元件：D / R / T / C / Z（数值/字符串变量）
    if kind not in _TS_WORD_ZONES:
        raise UnsupportedAddress(
            f"TS600 只有 M/S/X/Y/T/C 位元件和 D/R/T/C/Z 字元件，没有「{kind}{digits}」"
            f"这类写法（%MX/%QX/%QW/%QB/%IX/%IW 也没有）；这种变量按内部变量处理，不通讯：{raw}")

    if kind == "C":
        n = _ts_index(digits, 10, 256, "C", raw)
        if n >= 200:
            _ts_check_word32("C", n, vtype, raw)
            base_addr = _TS_WORD_ZONES["C32"][0]
            a = Address(HOLDING, base_addr + (n - 200) * 2, 2, kind="C", raw=raw, profile=key)
            if span is not None:
                if span % 2:
                    raise ValueError(f"C200~C255 是双字元件（2 个寄存器 1 个元件），"
                                     f"只能偶数个字读写（[4] 行、[3] 不行）：{raw}")
                a.words = span
            _ts_fit(a, _TS_WORD_ZONES["C32"][0] + _TS_WORD_ZONES["C32"][1] * 2 - 1, raw)
            return a
        _ts_check_word16("C", n, vtype, raw)
        a = Address(HOLDING, _TS_WORD_ZONES["C"][0] + n, 1, kind="C", raw=raw, profile=key)
        _apply_span(a, span, raw)
        _ts_fit(a, _TS_WORD_ZONES["C"][0] + _TS_WORD_ZONES["C"][1] - 1, raw)
        return a

    if kind == "T":
        n = _ts_index(digits, 10, 400, "T", raw)
        _ts_check_word16("T", n, vtype, raw)
        a = Address(HOLDING, _TS_WORD_ZONES["T"][0] + n, 1, kind="T", raw=raw, profile=key)
        _apply_span(a, span, raw)
        _ts_fit(a, _TS_WORD_ZONES["T"][0] + _TS_WORD_ZONES["T"][1] - 1, raw)
        return a

    if kind == "R":
        n = _ts_index(digits, 10, 32768, "R", raw)
        if n >= 16384:
            raise ValueError(f"R{n}：手册写明 R16384~R32767 没有映射到协议地址上，"
                             f"只能访问 R0~R16383：{raw}")
        base_addr, count, _, _ = _TS_WORD_ZONES["R"]
        a = Address(HOLDING, base_addr + n, 1, kind="R", raw=raw, profile=key)
        _apply_span(a, span, raw)
        _ts_fit(a, base_addr + count - 1, raw)
        return a

    # D / Z
    base_addr, count, _, _label = _TS_WORD_ZONES[kind]
    n = _ts_index(digits, 10, count, kind, raw)
    if is_bool:
        raise ValueError(f"{kind} 是字元件，bool 变量请用位元件（M/S/Y/T/C 的位地址）：{raw}")
    need = _ts_need_words(vtype)
    a = Address(HOLDING, base_addr + n, 1, kind=kind, raw=raw, profile=key)
    if span is not None:
        a.words = span
    elif need:
        a.words = need
    _ts_fit(a, base_addr + count - 1, raw)
    return a


# ─────────────────────────────────────────────
#  元件区边界（轮询/写入前校验「多字读写不越区」用；目前 TS600 才有意义）
# ─────────────────────────────────────────────
def region_end(a):
    """这个地址所在元件区的协议末地址；认不出（如 INVT 模型）返回 None。

    用途：REAL/DINT/字符串要占多个寄存器时，确认它没有跨出元件区
    （D32767 放 REAL 会踩到不存在的 D32768 —— 现场看到的是从站异常码 02）。
    """
    if not isinstance(a, Address) or a.profile != "ts600-modbus-tcp":
        return None
    off = a.offset
    if a.area == HOLDING:
        zones = [(0xE2C8, 0xE337), (0xE200, 0xE2C7), (0xE000, 0xE18F),
                 (0xE400, 0xE40F), (0x8000, 0xBFFF), (0x0000, 0x7FFF)]
        for lo, hi in zones:
            if lo <= off <= hi:
                return hi
        return None
    if a.area in (COIL, DISCRETE):
        z = bit_zone(off)
        return z[1] if z else None
    return None


# 位元件区（协议地址空间）。分开列出来的原因：TS600 把没映射的地址当「非法数据地址」，
# 一次 FC01/FC02 请求**跨区**（比如 M32767 连到 S0 读 2 位）会整块被拒（异常码 02），
# 所以轮询合并块必须按区切开。
_TS_BIT_RANGES = ((0x0000, 0x7FFF), (0x8000, 0x8FFF), (0xA000, 0xA3FF),
                  (0xB000, 0xB3FF), (0xC000, 0xC18F), (0xC200, 0xC2FF))


def bit_zone(offset):
    """位元件地址落在哪个区 → (区首, 区末)；认不出返回 None。

    轮询（server/core/plcsource.py）拿它把线圈/离散输入按区切块，别让一次请求跨区。
    """
    try:
        off = int(offset)
    except (TypeError, ValueError):
        return None
    for lo, hi in _TS_BIT_RANGES:
        if lo <= off <= hi:
            return lo, hi
    return None
