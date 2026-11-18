#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
modbus.py — Modbus TCP 主站（客户端）+ CODESYS / Invtmatic 风格地址解析
========================================================================
零第三方依赖（只用标准库 socket），可直接被 server.py 当数据源用。

地址写法（对应手册「表 5-5 Modbus_TCP_Slave 功能码」「表 5-6 位/字节/字/双字对应关系」）：

    %MW96      保持寄存器 96              FC03 读 / FC06、FC16 写      16 位字
    %MD48      双字 = %MW96(低) + %MW97(高)                           32 位
    %MB194     字节 = %MW97 的低字节（偶=低字节，奇=高字节）
    %MX195.0   位  = 字节195 的第0位 → 落在 %MW97 的 bit8
    %QW0       输出字（等同保持寄存器）
    %QX1.2     线圈     FC01 读 / FC05、FC15 写   （位地址按 字节.位 写）
    %IX0      离散输入  FC02 读
    %IW5      输入寄存器 FC04 读
    HR100 / 4x0100 / 40101   兼容老写法 → 保持寄存器（无偏移，与手册一致）

双字/浮点的字序（现场 4 种写法都有，连接时选）：
    abcd  高字在前（大端）              12.5 → MW96=0x4148 MW97=0x0000
    cdab  低字在前（字交换）★默认       12.5 → MW96=0x0000 MW97=0x4148   Invtmatic 用这个
    badc  高字在前 + 字内字节交换        12.5 → MW96=0x4841 MW97=0x0000
    dcba  低字在前 + 字内字节交换        12.5 → MW96=0x0000 MW97=0x4841

⚠ 字长由「类型」决定，不是由地址写法决定：real/dint 占 2 个字、lreal 占 4 个字。
  地址只决定**起始寄存器**（%MW100 和 %MD50 都是 100 起，但 %MD48 自带 2 字语义）。
  以前轮询按地址字长取数：类型 real 而地址写 %MW100 时只读 1 个字，
  16 位被当成 double 解 → 界面上出现 6.4757e-320 这种非规格化数。
"""
import re
import socket
import struct
import threading

# ── 区域 / 地址模型 ──
# 「地址长什么样 → 落到哪个区」全在 addr_model.py（**可替换**：换控制器/换从站映射只改那一个文件）。
# 这里 re-export，历史上 `from modbus import parse_address, HOLDING, ...` 的写法继续有效。
from addr_model import (                                          # noqa: E402
    COIL, DISCRETE, INPUT_REG, HOLDING, AREA_CN,
    Address, parse_address, bits_to_word, word_to_bits,
    PROFILE, PROFILE_CN, BITS_PER_WORD,
)


class ModbusError(Exception):
    """通信失败或从站返回异常码。

    transport=True = **这条链路现在不通**（socket 超时 / 连不上 / 对方把连接关了 /
    这条流已经错位），而不是「地址写错了 / 写到只读区了」这类业务失败。

    为什么要分这个：一次链路失败要等一个 socket 超时（默认 1.5 秒）才回来。
    设备断了以后画面上和脚本里的写还在按周期发，于是一串写各自去等自己的超时，
    界面上就是一条接一条的「下发失败」——现场原话「断开时前面数据还在下发，
    弹出全部失败的命令才停」。有了这个标记，第一次失败就能把设备标成掉线，
    后面的写**立刻被拒**（见 core/plcsource.py 的 _ensure_writable），不再排队等超时。
    """

    def __init__(self, message, transport=False):
        super().__init__(message)
        self.transport = bool(transport)

    @property
    def kind(self):
        """给后端/前端看的失败分类：'link' = 链路不通，'var' = 这次请求本身有问题。
        （口径见 core/varapi.py 的 _err_kind）"""
        return "link" if self.transport else "var"




# ── 取值编解码 ──
# 双字/浮点的字节序：现场 4 种都有，连接 PLC 时选（默认 cdab = Invtmatic 的低字在前）
WORD_ORDERS = ("abcd", "cdab", "badc", "dcba")
WORD_ORDER_CN = {
    "abcd": "高字在前（ABCD，大端）",
    "cdab": "低字在前（CDAB，字交换）",
    "badc": "高字在前 + 字节交换（BADC）",
    "dcba": "低字在前 + 字节交换（DCBA）",
}
# 老配置里的 low/high 继续能用（low=cdab、high=abcd）
_ORDER_ALIAS = {
    "low": "cdab", "high": "abcd", "little": "dcba", "big": "abcd",
    "abcd": "abcd", "cdab": "cdab", "badc": "badc", "dcba": "dcba",
    "": "cdab", "none": "cdab",
}
# 大端字节串 [b0 b1 b2 b3] 按各字序重排后，每个字节取自哪一位
_ORDER_PERM = {"abcd": (0, 1, 2, 3), "cdab": (2, 3, 0, 1), "badc": (1, 0, 3, 2), "dcba": (3, 2, 1, 0)}


def normalize_order(order):
    """把 'low'/'high'/'ABCD'… 统一成 4 种字序之一；认不出的按默认 cdab（并在界面上提示）"""
    return _ORDER_ALIAS.get(str(order or "").strip().lower(), "cdab")


def order_ok(order):
    return str(order or "").strip().lower() in _ORDER_ALIAS


def elem_words(elem_type):
    """数组里**一个元素**占几个寄存器：real/dint=2、lreal=4，其余 1
    （CODESYS 把 ARRAY OF REAL 按元素连续摆，每个 REAL 两个字、低字在前 —— 和单变量一个规则）"""
    t = (elem_type or "uint").lower()
    if t in ("real", "dint", "udint", "dword"):
        return 2
    if t in ("lreal", "lint", "ulint", "lword"):
        return 4
    return 1


def words_for(vtype="uint", addr_words=1, length=None):
    """这个类型要占几个寄存器：real/dint=2、lreal=4、string 按字符数（2 字符 1 个字），
    数组 = 元素个数 × 每个元素占的字数；其余按类型的位数（至少 1 个字）。
    ⚠ 必须和读/写/轮询三处用同一个函数，否则「读 2 字、写 1 字」这类错位很难查。"""
    t = (vtype or "uint").lower()
    if t.endswith("[]"):
        # 数组：变量表「长度」列 = 元素个数；Modbus 里就是一段连续寄存器
        n = max(1, int(length or 1))
        return n * elem_words(t[:-2])
    if t == "wstring":
        # 宽字符：一个字一个字符（WSTRING(80) 占 80 个寄存器）
        return max(1, int(length) if length else max(1, int(addr_words or 1)))
    if t == "string":
        if length:
            return max(1, (int(length) + 1) // 2)          # 2 个字符占 1 个寄存器
        return max(1, int(addr_words or 1))                # 没填字符数 → 按地址里写的字数
    if t in ("real", "dint", "udint", "dword", "time", "time_of_day"):
        need = 2
    elif t in ("lreal", "lint", "ulint", "lword", "ltime", "dt", "date_and_time"):
        need = 4
    else:
        need = 1
    return max(need, max(1, int(addr_words or 1)))


# ── 字符串：Modbus 里就是一段字节，一个字装两个字符（先低字节，与 %MB 偶=低的约定一致）──
def decode_string(value, length=None):
    """STRING：一个字装两个字符（先低字节，与 %MB 偶=低的约定一致）"""
    words = value if isinstance(value, (list, tuple)) else [value]
    raw = bytearray()
    for w in words:
        w &= 0xFFFF
        raw.append(w & 0xFF)          # 先低字节
        raw.append((w >> 8) & 0xFF)
    if length:
        raw = raw[:int(length)]
    raw = bytes(raw).split(b"\x00", 1)[0]                  # 尾部 0 是空串填充
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", "replace")


def encode_string(value, length=None, words=None):
    """字符串 → 寄存器列表。没给长度就按内容长度（至少 1 个字）。"""
    data = str("" if value is None else value).encode("utf-8")
    if length:
        data = data[:int(length)]
    if len(data) % 2:
        data += b"\x00"
    n = words if words else max(1, (len(data) + 1) // 2)
    data = data.ljust(n * 2, b"\x00")[:n * 2]
    return [data[i] | (data[i + 1] << 8) for i in range(0, n * 2, 2)]


# ── WSTRING（宽字符串）：**一个字装一个字符**（UTF-16LE，每个字符 16 位）──
# CODESYS 的 WSTRING 在 Modbus 里就是这么摆的：字符数 = 寄存器数（STRING 是 2 字符 1 个字）。
# 变量表「长度」列填字符数：WSTRING(80) → 占 80 个寄存器；STRING(80) → 占 40 个。
def decode_wstring(value, length=None):
    words = value if isinstance(value, (list, tuple)) else [value]
    raw = bytearray()
    for w in words:
        w &= 0xFFFF
        raw.append(w & 0xFF)          # UTF-16LE：低字节在前
        raw.append((w >> 8) & 0xFF)
    if length:
        raw = raw[:int(length) * 2]
    raw = bytes(raw)
    # 尾部 0x0000 当结束符（和 STRING 一个约定）；按 2 字节对齐切
    end = len(raw)
    for i in range(0, len(raw) - 1, 2):
        if raw[i] == 0 and raw[i + 1] == 0:
            end = i
            break
    try:
        return raw[:end].decode("utf-16-le")
    except UnicodeDecodeError:
        return raw[:end].decode("utf-16-le", "replace")


def encode_wstring(value, length=None, words=None):
    """WSTRING → 寄存器列表：每字符一个字（UTF-16LE），尾部补 0"""
    text = str("" if value is None else value)
    if length:
        text = text[:int(length)]
    data = text.encode("utf-16-le")
    if len(data) % 2:
        data += b"\x00"
    n = words if words else max(1, len(data) // 2)
    data = data.ljust(n * 2, b"\x00")[:n * 2]
    return [data[i] | (data[i + 1] << 8) for i in range(0, n * 2, 2)]


def _bytes_from_int(value, size, order):
    """逻辑值 → 设备寄存器里的字节排列（size=2/4/8 字节）。16 位不受字序影响。"""
    if size <= 2:
        return (int(value) & 0xFFFF).to_bytes(2, "big")[:size]
    o = normalize_order(order)
    perm = _ORDER_PERM[o]
    be = (int(value) & ((1 << (8 * size)) - 1)).to_bytes(size, "big")
    groups = [bytes(be[i + j] for j in perm) for i in range(0, size, 4)]
    if o in ("cdab", "dcba"):
        groups.reverse()                       # 这两种把前后 4 字节组也调换
    return b"".join(groups)


def _int_from_bytes(buf, order):
    """设备寄存器里的字节排列 → 逻辑值（_bytes_from_int 的逆运算）"""
    size = len(buf)
    if size <= 2:
        return int.from_bytes(buf, "big")
    o = normalize_order(order)
    perm = _ORDER_PERM[o]
    inv = [0] * 4
    for i, p in enumerate(perm):
        inv[p] = i
    groups = [buf[i:i + 4] for i in range(0, size, 4)]
    if o in ("cdab", "dcba"):
        groups.reverse()
    return int.from_bytes(b"".join(bytes(g[j] for j in inv) for g in groups), "big")


def _words_to_int(words, word_order="cdab"):
    if isinstance(words, int):
        return words & 0xFFFF
    if len(words) <= 1:
        return (words[0] if words else 0) & 0xFFFF
    return _int_from_bytes(b"".join(struct.pack(">H", w & 0xFFFF) for w in words), word_order)


def _int_to_words(value, count, word_order="cdab"):
    if count <= 1:
        return [int(value) & 0xFFFF]
    buf = _bytes_from_int(int(value), count * 2, word_order)
    return list(struct.unpack(">" + "H" * count, buf))


def decode_value(words, vtype="uint", word_order="cdab", byte=None, bit=None, length=None):
    """把读回来的寄存器值转成变量值（words 可以是 int 或 [int,...]）"""
    if isinstance(words, int):
        words = [words]
    words = [w & 0xFFFF for w in (words or [0])]
    t = (vtype or "uint").lower()
    if t.endswith("[]"):
        # 数组：按元素切段，每段用元素类型解（字序规则和单变量完全一样）
        elem = t[:-2]
        ew = elem_words(elem)
        cnt = int(length) if length else max(1, len(words) // ew)
        return [decode_value(words[i * ew:(i + 1) * ew], elem, word_order, length=None)
                for i in range(cnt)]
    if t == "wstring":
        return decode_wstring(words, length)      # 宽字符：一个字一个字符（UTF-16LE）
    if t == "string":
        return decode_string(words, length)
    if t == "bool" or bit is not None:
        # 位取值：bit 是字内位号；给了 byte 就再加上字节偏移（%MB194+位 → 低字节的 bit）
        pos = (bit if bit is not None else 0) + (8 * byte if byte is not None else 0)
        return bool((words[0] >> pos) & 1)
    if byte is not None:
        return (words[0] >> (8 * byte)) & 0xFF      # %MB：按字节取值（0-255）
    # ⚠ 字数不够就别硬解：16 位被当成 double 解出来就是 6.4757e-320 这种鬼数
    if t in ("real", "dint", "udint", "dword") and len(words) < 2:
        raise ValueError(f"{vtype} 需要 2 个寄存器，但只拿到 {len(words)} 个"
                         f"（地址写成了单字 %MW？改用 %MD 或让轮询按类型取 2 字）")
    if t in ("lreal", "lint", "ulint", "lword") and len(words) < 4:
        raise ValueError(f"{vtype} 需要 4 个寄存器，但只拿到 {len(words)} 个")
    raw = _words_to_int(words, word_order)
    bits = 16 * len(words)
    if t in ("int",):
        return raw - (1 << 16) if raw & 0x8000 else raw
    if t in ("uint",):
        return raw
    if t in ("dint",):
        return raw - (1 << 32) if raw & 0x80000000 else raw
    if t in ("udint",):
        return raw
    if t in ("real", "lreal"):
        if bits == 32:
            return struct.unpack(">f", struct.pack(">I", raw & 0xFFFFFFFF))[0]
        return struct.unpack(">d", struct.pack(">Q", raw & 0xFFFFFFFFFFFFFFFF))[0]
    return raw


def encode_value(value, vtype="uint", words=1, word_order="cdab", byte=None, bit=None, old_word=None, length=None):
    """把变量值转成寄存器值。带 bit/byte 的返回 (新字, 掩码) 供读改写。"""
    t = (vtype or "uint").lower()
    if t.endswith("[]"):
        # 数组：逐个元素编码后连成一段（元素多/少都按 values 来，长度由调用方保证）
        elem = t[:-2]
        vals = value if isinstance(value, (list, tuple)) else [value]
        out = []
        for val in vals:
            enc = encode_value(val, elem, elem_words(elem), word_order)
            out.extend(enc if isinstance(enc, list) else [enc])
        return out
    if t == "wstring":
        return encode_wstring(value, length, words)
    if t == "string":
        return encode_string(value, length, words)
    if t == "bool":
        b = 1 if value in (True, 1, "1", "true", "TRUE") else 0
        if byte is not None and bit is not None:
            pos = 8 * byte + bit
        elif bit is not None:
            pos = bit
        else:
            pos = 0
        mask = (1 << pos) & 0xFFFF
        cur = (old_word or 0) & 0xFFFF
        return (cur | mask) if b else (cur & ~mask)
    if t in ("int", "uint"):
        return int(value) & 0xFFFF
    if t in ("dint", "udint", "dword"):
        return _int_to_words(int(value) & 0xFFFFFFFF, 2, word_order)
    if t in ("real",):
        return _int_to_words(struct.unpack(">I", struct.pack(">f", float(value)))[0], 2, word_order)
    if t in ("lreal",):
        return _int_to_words(struct.unpack(">Q", struct.pack(">d", float(value)))[0], 4, word_order)
    return _int_to_words(int(value) & 0xFFFF, words, word_order)


# ── Modbus TCP 主站 ──
FC_READ_COILS, FC_READ_DISCRETE = 0x01, 0x02
FC_READ_HOLDING, FC_READ_INPUT = 0x03, 0x04
FC_WRITE_COIL, FC_WRITE_REG = 0x05, 0x06
FC_WRITE_COILS, FC_WRITE_REGS = 0x0F, 0x10

EXC_TEXT = {
    1: "非法功能码", 2: "非法数据地址", 3: "非法数据值", 4: "从站设备故障",
    5: "确认（正在处理）", 6: "从站忙", 8: "存储奇偶校验错", 10: "网关路径不可用", 11: "网关目标无响应",
}


class ModbusTcpClient:
    """最小可用的 Modbus TCP 主站：读写寄存器/线圈。线程安全（内部串行化）。"""

    def __init__(self, host, port=502, unit=1, timeout=1.5):
        self.host = host
        self.port = int(port)
        self.unit = int(unit) & 0xFF
        self.timeout = timeout
        self._sock = None
        self._tid = 0
        self._lock = threading.Lock()
        self.last_error = ""
        self.last_write_fc = ""     # 最近一次多字写用的是 fc16 还是退回 fc06
        self.fc16_fallbacks = 0     # 从站不支持 FC16 的次数（状态里能看到）

    # -- 连接 --
    def connect(self):
        with self._lock:
            self._close_locked()
            s = socket.create_connection((self.host, self.port), timeout=self.timeout)
            s.settimeout(self.timeout)
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self._sock = s

    def close(self):
        with self._lock:
            self._close_locked()

    def _close_locked(self):
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    @property
    def connected(self):
        return self._sock is not None

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise ModbusError("连接被对方关闭", transport=True)
            buf += chunk
        return buf

    def _request(self, pdu):
        """发一帧并收一帧；异常码转成 ModbusError"""
        with self._lock:
            if not self._sock:
                raise ModbusError("未连接", transport=True)
            self._tid = (self._tid + 1) & 0xFFFF
            frame = struct.pack(">HHHB", self._tid, 0, len(pdu) + 1, self.unit) + pdu
            try:
                self._sock.sendall(frame)
                head = self._recv_exact(7)                     # MBAP
                tid, pid, length, unit = struct.unpack(">HHHB", head)
                body = self._recv_exact(max(0, length - 1))
            except (OSError, socket.timeout) as e:
                self._close_locked()                           # 出错就断开，下次重连
                raise ModbusError(f"通信失败：{e}", transport=True) from e
            if tid != self._tid:
                # 事务号对不上 = 这条流已经错位（上一次超时留下的残包 / 链路上丢了帧）：
                # 按**链路**算并断开重连，别当成"这个变量写坏了"。
                self._close_locked()
                raise ModbusError(f"事务号不匹配（发 {self._tid} 收 {tid}）", transport=True)
            if pid != 0:
                self._close_locked()
                raise ModbusError(f"协议号异常：{pid}", transport=True)
            if unit != self.unit:
                raise ModbusError(f"站号不匹配（期望 {self.unit} 收到 {unit}）")
            if body and body[0] & 0x80:                        # 异常响应
                code = body[1] if len(body) > 1 else 0
                raise ModbusError(f"从站异常 {code}：{EXC_TEXT.get(code, '未知')}")
            return body

    # -- 读 --
    def read_registers(self, offset, count, fc=FC_READ_HOLDING):
        if count < 1 or count > 125:
            raise ValueError("一次最多读 125 个寄存器")
        body = self._request(struct.pack(">BHH", fc, offset, count))
        if body[0] != fc or len(body) < 2 + count * 2:
            raise ModbusError("响应长度不对", transport=True)
        return list(struct.unpack(">" + "H" * count, body[2:2 + count * 2]))

    def read_bits(self, offset, count, fc=FC_READ_COILS):
        if count < 1 or count > 2000:
            raise ValueError("一次最多读 2000 个位")
        body = self._request(struct.pack(">BHH", fc, offset, count))
        nbytes = (count + 7) // 8
        if body[0] != fc or len(body) < 2 + nbytes:
            raise ModbusError("响应长度不对", transport=True)
        out = []
        for i in range(count):
            byte = body[2 + i // 8]
            out.append(bool((byte >> (i % 8)) & 1))
        return out

    # -- 写 --
    def write_register(self, offset, value):
        body = self._request(struct.pack(">BHH", FC_WRITE_REG, offset, int(value) & 0xFFFF))
        if body[0] != FC_WRITE_REG:
            raise ModbusError("写寄存器响应异常", transport=True)

    def write_registers(self, offset, values):
        """FC16 写多个寄存器。有些从站只认 FC06（单字写），
        REAL/DINT 这种 2 个字的写就会失败 —— 这时自动退回逐字 FC06 写。"""
        if not values:
            return
        vals = [int(v) & 0xFFFF for v in values]
        pdu = struct.pack(">BHHB", FC_WRITE_REGS, offset, len(vals), len(vals) * 2) \
            + struct.pack(">" + "H" * len(vals), *vals)
        try:
            body = self._request(pdu)
            if body[0] != FC_WRITE_REGS:
                raise ModbusError("写多寄存器响应异常", transport=True)
            self.last_write_fc = "fc16"
            return
        except ModbusError as e:
            # 从站不支持 FC16（非法功能码/非法数据值）→ 退成逐个 FC06
            if len(vals) < 2 or "从站异常" not in str(e):
                raise
            for i, v in enumerate(vals):
                self.write_register(offset + i, v)
            self.last_write_fc = f"fc06×{len(vals)}"
            self.fc16_fallbacks += 1

    def write_coil(self, offset, on):
        body = self._request(struct.pack(">BHH", FC_WRITE_COIL, offset, 0xFF00 if on else 0x0000))
        if body[0] != FC_WRITE_COIL:
            raise ModbusError("写线圈响应异常", transport=True)

    def write_coils(self, offset, bits):
        if not bits:
            return
        nbytes = (len(bits) + 7) // 8
        packed = bytearray(nbytes)
        for i, b in enumerate(bits):
            if b:
                packed[i // 8] |= 1 << (i % 8)
        pdu = struct.pack(">BHHB", FC_WRITE_COILS, offset, len(bits), nbytes) + bytes(packed)
        body = self._request(pdu)
        if body[0] != FC_WRITE_COILS:
            raise ModbusError("写多线圈响应异常", transport=True)

    # -- 按变量语义读写（地址 + 数据类型 + 字符串长度）--
    def read_var(self, address, vtype="uint", word_order="cdab", length=None):
        a = address if isinstance(address, Address) else parse_address(address)
        if a.bits:
            # %QW：输出字是**一串位拼出来的**（本机从站只有 %QX 位区，没有输出字区）。
            # 读 n 个字 = 读 16×n 个输出位，每 16 位拼成一个字（低位在前），再按类型解码。
            nw = words_for(vtype, a.words, length)
            got = self.read_bits(a.offset, a.bits * nw, FC_READ_COILS)
            raw = [bits_to_word(got[i * BITS_PER_WORD:(i + 1) * BITS_PER_WORD]) for i in range(nw)]
            return decode_value(raw, vtype, word_order, byte=None, bit=None, length=length)
        if a.area in (COIL, DISCRETE):
            fc = FC_READ_COILS if a.area == COIL else FC_READ_DISCRETE
            bits = self.read_bits(a.offset, 1, fc)
            return bool(bits[0])
        fc = FC_READ_HOLDING if a.area == HOLDING else FC_READ_INPUT
        words = words_for(vtype, a.words, length)   # real/dint=2、lreal=4、string 按字符数
        raw = self.read_registers(a.offset, words, fc)
        return decode_value(raw, vtype, word_order, byte=a.byte, bit=a.bit, length=length)

    def write_var(self, address, value, vtype="uint", word_order="cdab", length=None):
        a = address if isinstance(address, Address) else parse_address(address)
        if a.bits:
            # %QW/%QB/%QD：把字按类型编码成 n 个字，再拆成 a.bits×n 个位，FC15 一次写下去
            #（低位在前，和 read_var 拼回来的是同一套顺序，读写对称）
            # ⚠ 拆位要按 a.bits 来：%QW 是 16 位、%QB 只有 8 位 —— 一律拆 16 位的话，
            #   写 %QB2 会把 %QB3 那 8 个线圈一起盖掉。
            t = (vtype or "uint").lower()
            nw = words_for(t, a.words, length)
            enc = encode_value(value, t, nw, word_order, length=length)
            words_out = enc if isinstance(enc, list) else [enc]
            out = []
            for w in words_out:
                out.extend(word_to_bits(w, a.bits))
            return self.write_coils(a.offset, out)
        if a.area == COIL:
            return self.write_coil(a.offset, bool(value) if isinstance(value, bool)
                                   else str(value).lower() in ("1", "true", "on"))
        if a.area == DISCRETE:
            raise ModbusError(f"离散输入（{a.raw or '%IX'}）只读，写不了；要写就用输出位 %QX / %QW")
        if a.area == INPUT_REG:
            raise ModbusError(f"输入区（{a.raw or '%IW'}）只读，写不了；要写就用 %MW / %MD / %MB / %MX")
        t = (vtype or "uint").lower()
        if t == "bool" or a.bit is not None:
            on = value in (True, 1, "1", "true", "TRUE")
            if a.bit is not None:
                # %MX195.0 内存位：读改写那一位
                old = self.read_registers(a.offset, 1)[0]
                mask_pos = 8 * (a.byte or 0) + a.bit
                new = ((old | (1 << mask_pos)) if on else (old & ~(1 << mask_pos))) & 0xFFFF
                return self.write_register(a.offset, new)
            if a.byte is not None:
                # %MB243 字节地址：只改这一个字节（写 0/1，
                # 与读的时候「按该字节的 bit0 取值」一致），别把另一个字节清掉
                old = self.read_registers(a.offset, 1)[0]
                mask = 0xFF << (8 * a.byte)
                new = ((old & ~mask) | ((1 if on else 0) << (8 * a.byte))) & 0xFFFF
                return self.write_register(a.offset, new)
            # 整字地址（HR0 / %MW0 这种，没写位也没写字节）→ 直接写 0/1。
            # 以前这里 old=None 还去做位运算，写一个 bool 就 TypeError
            # （界面上只看到「下发失败：unsupported operand type(s) for |」）
            return self.write_register(a.offset, 1 if on else 0)
        if a.byte is not None and t not in ("dint", "udint", "real", "lreal"):
            # %MB：只改这一个字节，不能把整个字覆盖掉
            old = self.read_registers(a.offset, 1)[0]
            mask = 0xFF << (8 * a.byte)
            new = (old & ~mask) | ((int(value) & 0xFF) << (8 * a.byte))
            return self.write_register(a.offset, new & 0xFFFF)
        # 字长同样按类型来：real 写到 %MW100 也要占 100、101 两个寄存器，
        # 否则写 1 个字、读 2 个字，界面上永远是对不上的数
        enc = encode_value(value, t, words_for(t, a.words, length), word_order, length=length)
        if isinstance(enc, list):
            return self.write_registers(a.offset, enc)
        return self.write_register(a.offset, enc)

    def read_order_candidates(self, address, vtype="real", length=None):
        """把同一个地址按 4 种字序各解一次（只读，用于现场判断对方 PLC 用哪种）。
        返回 [{"order","cn","value"}...]，值合理的那个就是对的。"""
        a = address if isinstance(address, Address) else parse_address(address)
        if a.area not in (HOLDING, INPUT_REG):
            raise ModbusError("字序体检只对保持寄存器/输入寄存器有意义（位地址没有字序）")
        fc = FC_READ_HOLDING if a.area == HOLDING else FC_READ_INPUT
        words = self.read_registers(a.offset, words_for(vtype, a.words, length), fc)
        out = []
        for o in WORD_ORDERS:
            try:
                v = decode_value(words, vtype, o, byte=a.byte, bit=a.bit, length=length)
            except ValueError as e:
                v = f"（读不了：{e}）"
            out.append({"order": o, "cn": WORD_ORDER_CN[o], "value": v})
        return {"words": [f"0x{w:04X}" for w in words], "candidates": out}


def probe(host, port=502, unit=1, timeout=1.2, address="%MW0"):
    """连一下并读一个寄存器，用来判断"通讯是否正常"。返回 (ok, 说明)"""
    cli = ModbusTcpClient(host, port, unit, timeout)
    try:
        cli.connect()
        try:
            a = parse_address(address)
            val = cli.read_registers(a.offset, 1)[0]
            return True, f"OK，{address} = {val}"
        except ModbusError as e:
            return False, f"连上了但读失败：{e}"
    except OSError as e:
        return False, f"连不上 {host}:{port} —— {e}"
    finally:
        cli.close()
