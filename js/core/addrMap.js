/**
 * addrMap.js — **地址模型（可替换）**：把 HMI 里写的「逻辑地址」换算成实际要读写的
 * Modbus 区域 / 偏移 / 位，以及把地址翻译成人话（变量表 title、提示、校验都走这里）。
 *
 * 为什么单独一个模块：**换一台控制器 / 换一种从站映射，只改这一个文件**
 * （后端对应的是 `server/addr_model.py`，两边规则必须一致，改一边记得改另一边）。
 *
 * 现在支持**两套**地址模型（用哪套跟着 PLC 连接 / 工程走，状态在 utils.js）：
 *
 * ① `invt-modbus-slave` —— Invtmatic / INVT Modbus_TCP_Slave（手册表 5-5 / 表 5-6）：
 *
 *   表 5-5 从站对外暴露的区域：0x01/0x05/0x15 → %QX（位）；0x02 → %IX（位，只读）；
 *                              0x04 → %IW（字，只读）；0x03/0x06/0x16 → %MW（字，读写）
 *   ⚠ 表里**没有 %QW**（输出字区），输出区只有**位**（%QX）。所以 `%QWn` 不是一个寄存器，
 *     而是 `%QX(2n).0 … %QX(2n+1).7` 这 16 个位拼出来的字（低位在前）。
 *     当保持寄存器用就会跟 %MW 变成同一个控制方式 —— 那写下去的是**另一个区**。
 *   ⚠ 表里也**没有 %MX 区**，但 %MX 与 %MW 是同一片内存（%MX195.0 = %MW97 的 bit8），
 *     所以它仍按「保持寄存器 + 位号」走，不是独立区。
 *
 *   表 5-6（表头 `%_X / %_B / %_W / %_D` 是占位符，M/I/Q 三个区共用同一套索引换算）：
 *     %_X  195.7~195.0 | 194.7~194.0 | 193.7~193.0 | 192.7~192.0
 *     %_B  195(高8位)  | 194(低8位)  | 193(高8位)  | 192(低8位)
 *     %_W              | 97(高16位)  | 96(低16位)
 *     %_D              |               48
 *   → 低字节/低字在**偶数**编号上：%MW96 = %MB192(低)+%MB193(高)；%MD48 = %MW96(低)+%MW97(高)。
 *
 * ② `ts600-modbus-tcp` —— TS600 系列（元件写法 D/M/X/Y/S/T/C/R/Z）：
 *    D/R/T/C/Z 是字元件（D/R 数值，T/C 当前值，Z 变址），M/S/X/Y/T/C 是位元件（bool）
 *    T/C **一个编号既可能是位、也可能是字**：bool 变量 → 触点（线圈区），数值 → 当前值（寄存器区）。
 *    X 是 8 进制编码的只读输入；C200~C255 是 32 位双字计数器（2 个寄存器 1 个元件）。
 *    R16384~R32767 手册没映射到协议地址，直接拒绝。
 *    也兼容「协议写法」%MW/%MD/%QX…、HR100、4x0100、纯数字（这些在两套模型下语义一致）。
 *    每个元件区的协议基址 / 数量 / 进制，与后端 `server/addr_model.py` 的
 *    `_TS_BIT_ZONES` / `_TS_WORD_ZONES` 逐条对齐。
 */
import {
  isOpcAddr, describeNodeId, normAddr, bumpAddr, isBitAddr, wordsFor,
  PROFILES, PROFILE_INVT, PROFILE_TS600, PROFILE_DEFAULT, getProfile, setProfile, profileId,
  profileCn, isTs600,
} from './utils.js';

// 归一化 / 递增 / 字数 / 当前模型 —— 这些是**跟控制器无关**的通用工具（utils.js 里），这里转出去，
// 让「地址这一摊」都从 addrMap 一个口子进：换控制器时先看本文件，再看 utils 里那几个。
export {
  normAddr, bumpAddr, isBitAddr, wordsFor,
  PROFILES, PROFILE_INVT, PROFILE_TS600, PROFILE_DEFAULT, getProfile, setProfile, profileId,
  profileCn, isTs600,
};

/** 模型标识（跟后端 server/addr_model.py 的 PROFILE 对齐）
 *  注意：这是**默认模型**，当前实际用的是 getProfile() —— 老代码只读常量，别依赖它跟着切换 */
export const PROFILE = PROFILE_DEFAULT;
export const PROFILE_CN = 'INVT Modbus_TCP_Slave（%QW 走 %QX 位拼字）';

/** 四个区（与后端 modbus.COIL/DISCRETE/INPUT_REG/HOLDING 同名） */
export const AREA = { COIL: 'coil', DISCRETE: 'discrete', INPUT_REG: 'input_reg', HOLDING: 'holding' };
export const AREA_CN = {
  coil: '线圈（输出位 %QX）', discrete: '离散输入（%IX）',
  input_reg: '输入寄存器（%IW）', holding: '保持寄存器（%MW）',
};
export const BITS_PER_WORD = 16;

// ── TS600 元件区（后端 addr_model._TS_BIT_ZONES / _TS_WORD_ZONES 的镜像）──
// 位元件：M0~M32767 / S0~S4095 / X0~X1777(8 进制,只读) / Y0~Y1777(8 进制) / T0~T399 / C0~C255
const TS_BIT_ZONES = {
  M: { base: 0x0000, count: 32768, radix: 10, readonly: false },
  S: { base: 0x8000, count: 4096, radix: 10, readonly: false },
  X: { base: 0xA000, count: 1024, radix: 8, readonly: true },
  Y: { base: 0xB000, count: 1024, radix: 8, readonly: false },
  T: { base: 0xC000, count: 400, radix: 10, readonly: false },
  C: { base: 0xC200, count: 256, radix: 10, readonly: false },
};
// 字元件：D0~D32767 / R0~R16383 / T0~T399 / C0~C199(16位) / C200~C255(32位,2字) / Z0~Z15
const TS_WORD_ZONES = {
  D: { base: 0x0000, count: 32768, per: 1 },
  R: { base: 0x8000, count: 16384, per: 1 },
  T: { base: 0xE000, count: 400, per: 1 },
  C: { base: 0xE200, count: 200, per: 1 },
  C32: { base: 0xE2C8, count: 56, per: 2 },
  Z: { base: 0xE400, count: 16, per: 1 },
};
const TS_T16 = ['int', 'uint'];
const TS_T32 = ['real', 'dint', 'udint', 'dword', 'time', 'time_of_day'];
const TS_T64 = ['lreal', 'lint', 'ulint', 'lword', 'ltime', 'dt', 'date_and_time'];
const TS_TSTR = ['string', 'wstring'];

/**
 * 把地址文本解析成 { area, offset, words, byte, bit, bits, kind, readonly, profile }（解析不了抛 Error）。
 * 与后端 `addr_model.parse_address` 逐条对齐 —— 只做预测/校验，真正的读写在后端。
 *   bits > 0 表示「这个字由 bits 个**位**拼出来」（%QW = 16 个输出位）。
 *   vtype 传给 TS600：T/C 靠它区分「触点(bool)」还是「当前值(数值)」。
 *   profile 不传 = 当前模型（老调用不用改）。
 */
export function parseAddr(text, vtype = '', profile = getProfile()) {
  const raw = String(text ?? '').trim();
  const s = raw.toUpperCase().replace(/\s+/g, '').replace(/\u3000/g, '');
  if (!s) throw new Error('地址为空');
  const pid = profileId(profile);
  // 段写法 %MW200[10] / D100[10]：占 10 个字（字符串/数组用）
  let span = 0;
  const mSpan = /^(.*)\[(\d+)\]$/.exec(s);
  const body0 = mSpan ? mSpan[1] : s;
  if (mSpan) {
    span = +mSpan[2];
    if (!(span >= 1 && span <= 125)) throw new Error(`一段最多 125 个字：${raw}`);
  }
  if (pid === PROFILE_TS600) {
    const out = parseTs600(body0, raw, span || null, String(vtype || ''), pid);
    return { raw, ...out, profile: pid };
  }
  const out = parseOne(invtPercent(body0));
  if (span) {
    if (out.area === AREA.COIL || out.area === AREA.DISCRETE || out.bit != null || out.byte != null || out.bits) {
      throw new Error('位/字节地址不能带 [字数]');
    }
    out.words = span;
  }
  return { raw, ...out, profile: pid, readonly: false };
}

/** 百分号可以省（现场口径）：mx100.0 / QX0 / MW200 → 补成 %MX100.0 / %QX0 / %MW200。
 *  只认**多字母前缀**（QW/QB/QD/QX/MW/MD/MB/MX/IX/IW/IB/ID）—— 单字母 M/D/X/Y/S/T/C/R/Z 是
 *  TS600 的元件写法，这里不能补 %；其它写法原样返回，交给 parseOne 去报错。 */
const BARE_ADDR = /^(QW|QB|QD|QX|MW|MD|MB|MX|IX|IW|IB|ID)(\d+(?:\.\d+)?)$/;
function invtPercent(s) {
  if (typeof s !== 'string' || s.startsWith('%')) return s;
  return BARE_ADDR.test(s) ? '%' + s : s;
}

// ── INVT 那套（原样保留调用面）──────────────────────────────
function parseOne(s) {
  if (s.startsWith('%')) {
    const body = s.slice(1);
    // 带点的位地址：%QX1.2 / %IX0.0 / %MX195.0
    if (body.includes('.')) {
      const [head, bitS] = body.split('.');
      const m = head.replace(/\d+$/, '');
      const num = head.slice(m.length);
      if (!/^\d+$/.test(num) || !/^\d+$/.test(bitS)) throw new Error('地址格式不对');
      const kind = m || 'X';
      const baseByte = +num, bitInByte = +bitS;
      if (bitInByte > 7) throw new Error('位号只能是 0-7');
      if (kind === 'MX') {
        return { area: AREA.HOLDING, offset: Math.floor(baseByte / 2), words: 1, byte: null,
          bit: (baseByte % 2) * 8 + bitInByte, bits: 0, kind: 'MX' };
      }
      if (kind === 'QX' || kind === 'Q') {
        return { area: AREA.COIL, offset: baseByte * 8 + bitInByte, words: 1, byte: null, bit: 0, bits: 0, kind: 'QX' };
      }
      if (kind === 'IX' || kind === 'I') {
        return { area: AREA.DISCRETE, offset: baseByte * 8 + bitInByte, words: 1, byte: null, bit: 0, bits: 0, kind: 'IX' };
      }
      throw new Error('不认识的位地址');
    }
    // 无点：%MW96 / %MD48 / %MB194 / %QX0 / %IX0 / %IW5 / %QW0
    const m = /^([A-Z]*)(\d+)$/.exec(body);
    if (!m) throw new Error('地址格式不对');
    const kind = m[1], n = +m[2];
    if (n > 65535) throw new Error('地址超出 0-65535');
    const base = { area: AREA.HOLDING, offset: n, words: 1, byte: null, bit: null, bits: 0, kind };
    if (kind === 'QW') {
      // ★ 输出字 = 16 个输出位拼出来的（这个从站没有输出字区，输出只有位）
      return { ...base, area: AREA.COIL, offset: n * 2 * 8, bits: BITS_PER_WORD };
    }
    if (kind === 'QB') {   // 输出字节 = 8 个输出位（同一个区：线圈）
      return { ...base, area: AREA.COIL, offset: n * 8, bits: 8 };
    }
    if (kind === 'QD') {   // 输出双字 = 32 个输出位（= %QW(2n) + %QW(2n+1)）
      return { ...base, area: AREA.COIL, offset: n * 32, words: 2, bits: BITS_PER_WORD };
    }
    if (kind === 'MW' || kind === 'W' || kind === 'M') return base;
    if (kind === 'MD' || kind === 'D') return { ...base, offset: n * 2, words: 2, kind: 'MD' };
    if (kind === 'MB' || kind === 'B') return { ...base, offset: Math.floor(n / 2), byte: n % 2, kind: 'MB' };
    if (kind === 'MX') return { ...base, offset: Math.floor(n / 2), bit: (n % 2) * 8, kind: 'MX' };
    if (kind === 'QX' || kind === 'X' || kind === 'Q') return { ...base, area: AREA.COIL, bit: 0, kind: 'QX' };
    if (kind === 'IX' || kind === 'I') return { ...base, area: AREA.DISCRETE, bit: 0, kind: 'IX' };
    if (kind === 'IW') return { ...base, area: AREA.INPUT_REG, kind: 'IW' };
    if (kind === 'IB') {   // 输入字节 = %IW(n//2) 的某个字节（只读）
      return { ...base, area: AREA.INPUT_REG, offset: Math.floor(n / 2), byte: n % 2, kind: 'IB' };
    }
    if (kind === 'ID') {   // 输入双字 = 2 个输入寄存器（只读）
      return { ...base, area: AREA.INPUT_REG, offset: n * 2, words: 2, kind: 'ID' };
    }
    throw new Error(`不认识的前缀 ${kind}`);
  }
  // 兼容写法 HR100 / 4x0100 / 40101 / 100
  if (/^HR\d+$/.test(s)) return { area: AREA.HOLDING, offset: +s.slice(2), words: 1, byte: null, bit: null, bits: 0, kind: 'HR' };
  if (/^4X[0-9A-F]+$/.test(s)) return { area: AREA.HOLDING, offset: +s.slice(2), words: 1, byte: null, bit: null, bits: 0, kind: 'HR' };
  if (/^\d+$/.test(s)) {
    const n = +s;
    return { area: AREA.HOLDING, offset: n >= 40001 && n <= 49999 ? n - 40001 : n,
      words: 1, byte: null, bit: null, bits: 0, kind: 'HR' };
  }
  throw new Error('无法解析的地址');
}

// ── TS600 那套（与后端 _parse_ts600 及几个 _ts_* 校验函数逐条对齐）──────────
function tsBaseType(vtype) {
  const v = String(vtype || '').trim().toLowerCase();
  if (v.endsWith('[]')) return [v.slice(0, -2).trim(), true];
  return [v, false];
}

/** 编号校验 + 进制换算（X/Y 是 8 进制，编号里不许出现 8/9） */
function tsIndex(digits, radix, count, kind, raw) {
  if (radix === 8 && /[^0-7]/.test(digits)) {
    throw new Error(`${kind} 是 8 进制编码的元件（手册：8 进制编码 BOOL 类型），编号里不能出现 8/9：${raw}`);
  }
  const n = parseInt(digits, radix);
  const rng = radix === 8 ? `0~${(count - 1).toString(8)}（八进制）` : `0~${count - 1}`;
  if (!(n >= 0 && n < count)) throw new Error(`${kind} 编号超出范围 ${rng}：${raw}`);
  return n;
}

/** 位元件只吃 bool（X 只读，但读也必须是 bool） */
function tsCheckBitVtype(kind, vtype, raw) {
  const [base, arr] = tsBaseType(vtype);
  if (!base) return;
  if (arr && base === 'bool') throw new Error(`位元件不支持 bool[] 数组变量（拆成多个 bool 变量）：${raw}`);
  if (base !== 'bool') {
    throw new Error(`${kind} 元件是位元件，只能配 bool 变量；数值请放字元件（D/R/T/C/Z）：${raw}`);
  }
}

function tsWhat(base) {
  if (TS_T32.includes(base)) return '32 位';
  if (TS_T64.includes(base)) return '64 位';
  return '字符串';
}

/** 16 位字元件（T 当前值 / C0~C199）只吃 int/uint */
function tsCheckWord16(kind, n, vtype, raw) {
  const [base] = tsBaseType(vtype);
  if (!base) return;
  if (TS_T32.includes(base) || TS_T64.includes(base) || TS_TSTR.includes(base)) {
    const what = tsWhat(base);
    throw new Error(`${kind}${n} 是 16 位字元件（1 个寄存器），放不下${what}类型；`
      + `${what}数据请放 D/R（C200~C255 是 32 位计数器）：${raw}`);
  }
}

/** 32 位双字元件（C200~C255）必须配 32 位类型（否则只读到低 16 位，值会莫名对不上） */
function tsCheckWord32(kind, n, vtype, raw) {
  const [base] = tsBaseType(vtype);
  if (!base) return;
  if (TS_T16.includes(base) || TS_TSTR.includes(base) || TS_T64.includes(base) || base === 'bool') {
    throw new Error(`${kind}${n} 是 32 位双字计数器（2 个寄存器对应 1 个元件），`
      + `变量类型要用 dint/udint/real：${raw}`);
  }
}

/** 类型占几个寄存器；null = 由字符串长度/数组长度决定（这里算不出来） */
function tsNeedWords(vtype) {
  const [base, arr] = tsBaseType(vtype);
  if (!base) return 1;
  if (arr) return null;
  if (TS_T32.includes(base)) return 2;
  if (TS_T64.includes(base)) return 4;
  if (TS_TSTR.includes(base)) return null;
  return 1;
}

/** 多字读写不能越出元件区（D32767 放 REAL 会踩到 D 区外） */
function tsFit(a, zoneEnd, raw) {
  if (!a.words) return;
  if (a.offset + a.words - 1 > zoneEnd) {
    throw new Error(`${raw} 占 ${a.words} 个字，超出元件区末地址 (协议 ${zoneEnd})：`
      + '换个小一点的编号，或改用能放下的类型');
  }
}

function tsAddr(area, offset, words, kind, pid, extra = {}) {
  return { area, offset, words, byte: null, bit: null, bits: 0, kind, readonly: false, profile: pid, ...extra };
}

function parseTs600(s, raw, span, vtype, pid) {
  const [baseType] = tsBaseType(vtype);
  const isBool = baseType === 'bool';

  // ① 兼容「协议地址」写法：%MW/%MD/%QX…、HR100、4x0100、纯数字。
  //    这些写法描述的就是 Modbus 地址本身（和元件名无关），在两套模型下语义一致。
  if (s.startsWith('%') || s.startsWith('HR') || s.startsWith('4X') || /^\d+$/.test(s)) {
    const a = parseOne(s);
    if (span != null) {
      if (a.area === AREA.COIL || a.area === AREA.DISCRETE || a.bit != null || a.byte != null || a.bits) {
        throw new Error(`位/字节地址不能带 [字数]：${raw}`);
      }
      a.words = span;
    }
    return { ...a, profile: pid, readonly: false };
  }

  const m = /^([A-Z])([0-9]+)$/.exec(s);
  if (!m) {
    throw new Error('TS600 地址写法应为「元件字母+编号」'
      + '（D100 / M200 / S10 / X17 / Y10 / T5 / C200 / R100 / Z3），'
      + `也兼容 %MW/HR/数字写法：${raw}`);
  }
  const kind = m[1], digits = m[2];

  // ② 位元件：M / S / X / Y / T / C（bool 变量；T/C 传了数值类型就走字元件）
  if (TS_BIT_ZONES[kind] && (['M', 'S', 'X', 'Y'].includes(kind) || isBool)) {
    tsCheckBitVtype(kind, vtype, raw);
    if (span != null) throw new Error(`位元件不能带 [字数]（那是给字元件/字符串用的）：${raw}`);
    const z = TS_BIT_ZONES[kind];
    const n = tsIndex(digits, z.radix, z.count, kind, raw);
    return tsAddr(kind === 'X' ? AREA.DISCRETE : AREA.COIL, z.base + n, 1, kind, pid,
      { bit: 0, readonly: z.readonly });
  }

  // ③ 字元件：D / R / T / C / Z（数值/字符串变量）
  if (!TS_WORD_ZONES[kind]) {
    throw new Error(`TS600 没有 ${kind} 这类元件（位元件 M/S/X/Y/T/C，字元件 D/R/T/C/Z）：${raw}`);
  }

  if (kind === 'C') {
    const n = tsIndex(digits, 10, 256, 'C', raw);
    if (n >= 200) {                              // C200~C255：32 位双字计数器
      tsCheckWord32('C', n, vtype, raw);
      const a = tsAddr(AREA.HOLDING, TS_WORD_ZONES.C32.base + (n - 200) * 2, 2, 'C', pid);
      if (span != null) {
        if (span % 2) {
          throw new Error('C200~C255 是双字元件（2 个寄存器 1 个元件），'
            + `只能偶数个字读写（[4] 行、[3] 不行）：${raw}`);
        }
        a.words = span;
      }
      tsFit(a, TS_WORD_ZONES.C32.base + TS_WORD_ZONES.C32.count * 2 - 1, raw);
      return a;
    }
    tsCheckWord16('C', n, vtype, raw);
    const a = tsAddr(AREA.HOLDING, TS_WORD_ZONES.C.base + n, 1, 'C', pid);
    if (span != null) a.words = span;
    tsFit(a, TS_WORD_ZONES.C.base + TS_WORD_ZONES.C.count - 1, raw);
    return a;
  }

  if (kind === 'T' || kind === 'R') {
    const z = TS_WORD_ZONES[kind];
    // R 按 0~32767 校验编号，再由下面的专门提示拒绝 R16384~R32767（和后端一致）
    const n = tsIndex(digits, 10, kind === 'R' ? 32768 : z.count, kind, raw);
    if (kind === 'R' && n >= 16384) {
      throw new Error(`R${n}：手册写明 R16384~R32767 没有映射到协议地址上，只能访问 R0~R16383：${raw}`);
    }
    if (kind === 'T') tsCheckWord16('T', n, vtype, raw);
    const a = tsAddr(AREA.HOLDING, z.base + n, 1, kind, pid);
    if (span != null) a.words = span;
    tsFit(a, z.base + z.count - 1, raw);
    return a;
  }

  // D / Z
  const z = TS_WORD_ZONES[kind];
  const n = tsIndex(digits, 10, z.count, kind, raw);
  if (isBool) throw new Error(`${kind} 是字元件，bool 变量请用位元件（M/S/Y/T/C 的位地址）：${raw}`);
  const need = tsNeedWords(vtype);
  const a = tsAddr(AREA.HOLDING, z.base + n, 1, kind, pid);
  if (span != null) a.words = span;
  else if (need) a.words = need;
  tsFit(a, z.base + z.count - 1, raw);
  return a;
}

/**
 * 地址 → 人话（变量表地址格的 title）。
 * @param {string} addr 地址文本
 * @param {string} vtype 变量类型（real/dint 占 2 字、lreal 4 字、string 按字符数）
 * @param {number} strlen 字符串声明的字符数（或数组元素个数）
 * @param {string} profile 地址模型（不传 = 当前模型）
 */
export function describeAddr(addr, vtype = '', strlen = 0, profile = getProfile()) {
  if (isTs600(profile)) return describeTs600(addr, vtype, strlen, profileId(profile));
  return describeInvt(addr, vtype, strlen);
}

/** TS600：元件写法说人话。协议写法（%MW/HR/数字）直接借 INVT 的描述（语义一致）。 */
function describeTs600(addr, vtype, strlen, profile) {
  if (isOpcAddr(addr)) return describeNodeId(addr);
  const s0 = String(addr || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s0) return '未填地址（不会参与 PLC 采集）';
  // TS600 只认 %MW/%W/%MD、HR/4X/数字这几种协议写法；%MX0.0 / %QX / %QW / %M100 一律没有
  // （TS600 没有字内取位、位打包、输入区地址）→ 说清楚，别让人照着 INVT 的写法填。
  const base0 = s0.replace(/\[\d+\]$/, '');
  if (base0.startsWith('%')) {
    const body = base0.slice(1);
    const kind = body.replace(/[0-9]+$/, '');
    if (body.includes('.') || !['MW', 'W', 'MD'].includes(kind)) {
      return `⚠ TS600 没有 ${base0} 这种写法（没有 %MX/%QX/%QW/%QB/%IX/%IW 字内取位、位打包、输入区地址）；`
        + '位直接写元件位地址 M10 / X17 / Y10，寄存器写 D100 或 %MW100'
        + '（这种变量后端会按内部变量处理：不采集、不下发，不报错）';
    }
  }
  if (/^(?:%|HR|4X|\d)/.test(s0)) return describeInvt(addr, vtype, strlen);
  if (!/^[DMSXYTCRZ]\d+(?:\[\d+\])?$/.test(s0)) {
    return '⚠ TS600 地址写法：D100/M100/S10/X17/Y10/T5/C200/R100/Z3';
  }
  let a;
  try {
    a = parseAddr(s0, vtype, profile);
  } catch (e) {
    return `⚠ ${e && e.message ? e.message : e}`;      // 类型配错/越界/8 进制写错：直接把人话原样给用户
  }
  const kind = a.kind;
  // 反算元件编号（C200~C255 在双字区，编号 = 200 + 区内序号）
  let index;
  if (a.area === AREA.COIL || a.area === AREA.DISCRETE) index = a.offset - TS_BIT_ZONES[kind].base;
  else if (kind === 'C') {
    index = a.offset >= TS_WORD_ZONES.C32.base
      ? 200 + (a.offset - TS_WORD_ZONES.C32.base) / 2
      : a.offset - TS_WORD_ZONES.C.base;
  } else index = a.offset - TS_WORD_ZONES[kind].base;
  const isOct = kind === 'X' || kind === 'Y';
  const num = isOct ? index.toString(8) : String(index);
  const show = `${kind}${num}`;
  const wordsNote = a.words > 1 && !(kind === 'C' && a.offset >= TS_WORD_ZONES.C32.base)
    ? `　占 ${a.words} 个字：寄存器 ${a.offset}~${a.offset + a.words - 1}` : '';

  if (a.area === AREA.DISCRETE) return `输入 ${show}（八进制 → 离散输入 ${a.offset}，只读）`;
  if (a.area === AREA.COIL) {
    if (isOct) return `输出 ${show}（八进制 → 线圈 ${a.offset}）`;   // Y 和 X 一样按 8 进制编码
    const cn = { M: '辅助继电器', S: '状态继电器', T: '定时器触点', C: '计数器触点' }[kind] || kind;
    return `${cn} ${show}（线圈 ${a.offset}）`;
  }
  if (kind === 'D') return `数据寄存器 ${show}（协议寄存器 ${a.offset}）${wordsNote}`;
  if (kind === 'R') return `${show}（寄存器 ${a.offset}）${wordsNote}`;
  if (kind === 'Z') return `变址寄存器 ${show}（寄存器 ${a.offset}）${wordsNote}`;
  if (kind === 'T') return `定时器当前值 ${show}（寄存器 ${a.offset}，16 位）${wordsNote}`;
  if (kind === 'C') {
    if (a.offset >= TS_WORD_ZONES.C32.base) {
      return `32 位计数器 ${show}（双字：寄存器 ${a.offset}~${a.offset + a.words - 1}）`;
    }
    return `16 位计数器 ${show}（寄存器 ${a.offset}）${wordsNote}`;
  }
  return `⚠ TS600 地址写法：D100/M100/S10/X17/Y10/T5/C200/R100/Z3`;
}

/** INVT / Invtmatic：原来的 describeAddr 正文（一字没改，verify 脚本还按它断言） */
function describeInvt(addr, vtype = '', strlen = 0) {
  // OPC UA：地址列放的是 NodeId，跟寄存器那套没关系
  if (isOpcAddr(addr)) return describeNodeId(addr);
  let s0 = String(addr || '').trim().toUpperCase().replace(/\s+/g, '');
  s0 = invtPercent(s0);            // 百分号可以省：mx100.0 → %MX100.0（跟着 normAddr 走）
  const t = String(vtype || '').toLowerCase();
  // 段写法 %MW200[10]：从 200 起占 10 个字
  const mSpan = /^(%[A-Z]+\d+(?:\.\d+)?)\[(\d+)\]$/.exec(s0);
  const s = mSpan ? mSpan[1] : s0;
  const spanWords = mSpan ? +mSpan[2] : 0;
  const spanNote = mSpan ? `　地址写了 [${mSpan[2]}]：这一段占 ${mSpan[2]} 个字` : '';
  if (!s) return '未填地址（不会参与 PLC 采集）';
  const note = styleNote(s, t);

  // ── %QW：输出字 = 16 个输出位拼出来的（⚠ 不是寄存器）──
  let m;
  if ((m = /^%QW(\d+)$/.exec(s))) {
    const n = +m[1], b0 = n * 2;
    return `输出字 %QW${n} = 输出位 %QX${b0}.0 … %QX${b0 + 1}.7 这 16 个位拼出来的字（低位在前）`
      + '\n　本机从站（表 5-5）的输出区**只有位**，没有输出字区，所以它不是寄存器：'
      + '\n　读 = 读 16 个线圈再拼字；写 = 把字拆成 16 个位（FC15 写线圈）。'
      + '\n　⚠ 和 %MW 是**两个不同的区**，别当同一个地方用。';
  }

  // 占几个寄存器（real/dint 2、lreal 4、string 按字符数）——只对字类型给提示
  const span = (start) => {
    if (t === 'string') {
      const chars = Number(strlen) || 0;
      const w = chars ? Math.ceil(chars / 2) : (spanWords || 0);
      if (w) {
        return `　字符串：占 ${w} 个字（%MW${start}…%MW${start + w - 1} = ${w * 2} 个字符，`
          + '一个字 2 个字符、先低字节、尾部 0 结束）';
      }
      return `　字符串：在「长度」列填字符数，或地址写 %MW${start}[10] 表示 10 个字`;
    }
    if (!['real', 'dint', 'udint', 'lreal'].includes(t)) {
      return spanWords && spanWords > 1 ? `　这一段占 ${spanWords} 个字（%MW${start}…%MW${start + spanWords - 1}）` : '';
    }
    const need = t === 'lreal' ? 4 : 2;
    const list = Array.from({ length: need }, (_, i) => `%MW${start + i}`).join(' + ');
    const md = start % 2 === 0 ? `　= %MD${start / 2}` : '';
    return `　本变量类型 ${t.toUpperCase()} 占 ${need} 个字：${list}（低字在前）${md}`;
  };

  if ((m = /^%MW(\d+)$/.exec(s))) {
    return `保持寄存器 %MW${m[1]}（Modbus 寄存器 ${m[1]}）` + span(+m[1]) + note;
  }
  if ((m = /^%MD(\d+)$/.exec(s))) {
    const n = +m[1];
    return `双字 %MD${n} = %MW${n * 2}(低16位) + %MW${n * 2 + 1}(高16位)` + span(n * 2) + note;
  }
  if ((m = /^%MB(\d+)$/.exec(s))) {
    const n = +m[1];
    return `字节 %MB${n} = %MW${Math.floor(n / 2)} 的${n % 2 ? '高' : '低'}字节` + note;
  }
  if ((m = /^%MX(\d+)\.(\d+)$/.exec(s))) {
    const b = +m[1], bit = +m[2];
    if (bit > 7) return '位号只能是 0-7';
    return `内存位 %MX${b}.${bit} = %MW${Math.floor(b / 2)} 的 bit${(b % 2) * 8 + bit}` + note;
  }
  if ((m = /^%(QX|IX)(\d+)$/.exec(s))) {
    return `${m[1] === 'QX' ? '输出位（线圈）' : '离散输入'} %${m[1]}${m[2]}` + note;
  }
  if ((m = /^%(QX|IX)(\d+)\.(\d+)$/.exec(s))) {
    const b = +m[2], bit = +m[3];
    if (m[1] === 'QX') return `输出位 %QX${b}.${bit} = 线圈 ${b * 8 + bit}（FC01 读 / FC05·FC15 写）`;
    return `离散输入 %IX${b}.${bit} = 位 ${b * 8 + bit}（FC02，只读）`;
  }
  if ((m = /^%QW(\d+)$/.exec(s))) {
    const n = +m[1];
    return `输出字 %QW${n} = 16 个输出位 %QX${n * 2}.0…%QX${n * 2 + 1}.7`
      + '（走线圈 FC01/FC15，不是保持寄存器）' + note;
  }
  if ((m = /^%QB(\d+)$/.exec(s))) {
    const n = +m[1];
    return `输出字节 %QB${n} = 8 个输出位 %QX${n}.0…%QX${n}.7（走线圈 FC01/FC15）` + note;
  }
  if ((m = /^%QD(\d+)$/.exec(s))) {
    const n = +m[1];
    return `输出双字 %QD${n} = %QW${n * 2} + %QW${n * 2 + 1} = 32 个输出位 `
      + `%QX${n * 4}.0…%QX${n * 4 + 3}.7（走线圈）` + note;
  }
  if ((m = /^%IW(\d+)$/.exec(s))) {
    return `输入寄存器 %IW${m[1]}（FC04，只读）` + (spanWords ? `　这一段占 ${spanWords} 个字` : '') + note;
  }
  if ((m = /^%IB(\d+)$/.exec(s))) {
    const n = +m[1];
    return `输入字节 %IB${n} = %IW${Math.floor(n / 2)} 的${n % 2 ? '高' : '低'}字节（FC04，只读）` + note;
  }
  if ((m = /^%ID(\d+)$/.exec(s))) {
    const n = +m[1];
    return `输入双字 %ID${n} = %IW${n * 2}(低16位) + %IW${n * 2 + 1}(高16位)（FC04，只读）` + note;
  }
  if (/^HR\d+$/.test(s)) {
    const n = +s.slice(2);
    return `保持寄存器 ${s}（Modbus 寄存器 ${n}）` + span(n) + (spanWords ? `　这一段占 ${spanWords} 个字` : '');
  }
  if (/^4X[0-9A-F]+$/.test(s)) {
    const n = parseInt(s.slice(2), 16);
    return `保持寄存器 ${n}（4x 区）` + span(n);
  }
  if (/^\d{1,5}$/.test(s)) {
    const n = +s >= 40001 ? +s - 40001 : +s;
    return (+s >= 40001 ? `保持寄存器 ${n}（标准 4x 写法）` : `保持寄存器 ${n}`) + span(n);
  }
  return '⚠ 认不出的地址写法（支持 %MW/%MD/%MB/%MX/%QW/%QB/%QD/%QX/%IX/%IW/%IB/%ID，也可直接写数字：100 = %MW100）';
}

/** 地址写法跟类型配不配（bool 该用位地址，字类型才用 %MW/%MD）。NodeId 不适用 */
function styleNote(s, t) {
  if (!t || isOpcAddr(s)) return '';
  if (/^%QW\d+$/.test(s)) return '';                   // %QW 是字，类型由用户挑
  const bit = /^(%[MQI]X\d+(\.\d)?|%[QI]X\d+)$/.test(s);
  if (t === 'bool' && !bit) {
    return '　⚠ 标准写法里 bool 用位地址：%MX0.0 内存位 / %QX0.0 输出位 / %IX0.0 只读输入'
      + '（位号也可以往后排，如 %IX0.1、%QX2.3）';
  }
  if (t !== 'bool' && bit) return `　⚠ 这是位地址（1 位），放不下 ${String(t).toUpperCase()}，字类型用 %MW/%MD`;
  return '';
}
