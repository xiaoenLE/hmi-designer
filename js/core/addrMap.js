/**
 * addrMap.js — **地址模型（可替换）**：把 HMI 里写的「逻辑地址」换算成实际要读写的
 * Modbus 区域 / 偏移 / 位，以及把地址翻译成人话（变量表 title、提示、校验都走这里）。
 *
 * 为什么单独一个模块：**换一台控制器 / 换一种从站映射，只改这一个文件**
 * （后端对应的是 `server/addr_model.py`，两边规则必须一致，改一边记得改另一边）。
 *
 * 当前实现的是 **Invtmatic / INVT Modbus_TCP_Slave**（手册表 5-5 / 表 5-6）：
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
 */
import { isOpcAddr, describeNodeId, normAddr, bumpAddr, isBitAddr, wordsFor } from './utils.js';

// 归一化 / 递增 / 字数 这些是**跟控制器无关**的通用工具（utils.js 里），这里转出去，
// 让「地址这一摊」都从 addrMap 一个口子进：换控制器时先看本文件，再看 utils 里那几个。
export { normAddr, bumpAddr, isBitAddr, wordsFor };

/** 模型标识（跟后端 server/addr_model.py 的 PROFILE 对齐） */
export const PROFILE = 'invt-modbus-slave';
export const PROFILE_CN = 'Invtmatic/INVT Modbus_TCP_Slave（%QW 走 %QX 位拼字）';

/** 四个区（与后端 modbus.COIL/DISCRETE/INPUT_REG/HOLDING 同名） */
export const AREA = { COIL: 'coil', DISCRETE: 'discrete', INPUT_REG: 'input_reg', HOLDING: 'holding' };
export const AREA_CN = {
  coil: '线圈（输出位 %QX）', discrete: '离散输入（%IX）',
  input_reg: '输入寄存器（%IW）', holding: '保持寄存器（%MW）',
};
export const BITS_PER_WORD = 16;

/**
 * 把地址文本解析成 { area, offset, words, byte, bit, bits, kind }（解析不了抛 Error）。
 * 与后端 `addr_model.parse_address` 逐条对齐 —— 只做预测/校验，真正的读写在后端。
 *   bits > 0 表示「这个字由 bits 个**位**拼出来」（%QW = 16 个输出位）。
 */
export function parseAddr(text) {
  const raw = String(text ?? '').trim();
  const s = raw.toUpperCase().replace(/\s+/g, '');
  if (!s) throw new Error('地址为空');
  // 段写法 %MW200[10]：占 10 个字（字符串/数组用）
  let span = 0;
  const mSpan = /^(.*)\[(\d+)\]$/.exec(s);
  const body0 = mSpan ? mSpan[1] : s;
  if (mSpan) span = +mSpan[2];
  const out = parseOne(body0);
  if (span) {
    if (out.area === AREA.COIL || out.area === AREA.DISCRETE || out.bit != null || out.byte != null || out.bits) {
      throw new Error('位/字节地址不能带 [字数]');
    }
    out.words = span;
  }
  return { raw, ...out };
}

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

/**
 * 地址 → 人话（变量表地址格的 title）。
 * @param {string} addr 地址文本
 * @param {string} vtype 变量类型（real/dint 占 2 字、lreal 4 字、string 按字符数）
 * @param {number} strlen 字符串声明的字符数（或数组元素个数）
 */
export function describeAddr(addr, vtype = '', strlen = 0) {
  // OPC UA：地址列放的是 NodeId，跟寄存器那套没关系
  if (isOpcAddr(addr)) return describeNodeId(addr);
  const s0 = String(addr || '').trim().toUpperCase().replace(/\s+/g, '');
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


