/**
 * addrCatalog.js — 「这台 PLC 的地址该写成什么样」的**目录 + 校验**（前端侧的门面）
 *
 * 两个问题分开答：
 *   ① **目录**（loadCatalog / catalog / protocolInfo / prefixes / defaultAddress）：
 *      有哪些通讯协议、每种协议认哪些地址前缀、默认地址/探测地址是什么。
 *      来源是后端 `GET /api/comm/protocols`（新增协议时前端不用改代码）；
 *      老后端没有这个接口 → 用本文件的 FALLBACK（就是现在这三项协议）兜底，界面照常能用。
 *   ② **校验**（validate）：某个地址在当前协议下对不对。
 *      先问后端 `POST /api/comm/validate`（结论以后端为准 —— 后端拿着 server/addr_model.py
 *      那套规则，比前端预判更权威）；后端没有这个接口 / 超时 → 退回 addrMap.parseAddr 本地判定。
 *
 * 三个结论的界面口径（和 docs/ts600-modbus-tcp.md 7.3 一致，别自己发明）：
 *   · valid:false + code:'invalid'          → 真错（语法/范围/类型）→ 红框红字
 *   · unsupported:true 或 code:'model'      → 写法与协议不匹配 = **内部变量**（灰字，不标红）
 *   · 空地址                                → 正常用法（灰字「留空 = 内部变量」）
 *   · writable:false                        → 只读地址（能读不能写；红不红看 valid）
 */
import { bus } from './eventBus.js';
import { PROTOCOLS, protocolId, profileForProtocol, profileCn, isOpcAddr, describeNodeId } from './utils.js';
import { parseAddr, describeAddr, PROFILE_INVT, PROFILE_TS600 } from './addrMap.js';
import { backend } from '../api/backend.js';

/** 目录里已知协议的固定顺序（状态栏/下拉都按这个排；后端顺序不一致时也纠正过来）。
 *  ⚠ verify-opcua.mjs:343 断言 `[...options].map(o=>o.value).join(',') === 'modbus,ts600,opcua'`，别改顺序。 */
const ORDER = ['modbus', 'ts600', 'opcua'];

const orderIndex = (id) => {
  const i = ORDER.indexOf(String(id || '').toLowerCase());
  return i < 0 ? ORDER.length + 1 : i;
};

/** 前缀一条：prefix='%MW' label='保持寄存器（字）' kind='word' example='%MW100' */
function pre(prefix, label, kind, example, extra = {}) {
  return {
    prefix,
    label,
    kind,
    example,
    types: Array.isArray(extra.types) ? extra.types : [],
    writable: extra.writable !== false,
    note: String(extra.note || ''),
  };
}

/** 本地兜底目录（后端没有 comm_api 时用）。内容 = 现在三项协议 + 两套地址模型的前缀，
 *  改这里之前先看 js/core/addrMap.js（真正做映射的地方）和 docs/ts600-modbus-tcp.md 7.4。 */
function fallbackProtocols() {
  return [
    {
      id: 'modbus',
      name: 'Modbus TCP',
      comm: 'modbus',
      addr_profile: 'invt-modbus-slave',
      default_address: '%MW0',
      probe_address: '%MW0',
      kind: 'element',
      help: 'INVT/CODESYS 写法（%MW/%MD/%QX…）',
      prefixes: [
        pre('%MW', '保持寄存器（字，读写）', 'word', '%MW100'),
        pre('%MD', '双字（2 个寄存器，读写）', 'word', '%MD50'),
        pre('%MX', '保持区字内取位（位）', 'bit', '%MX0.0'),
        pre('%QX', '输出位（线圈，读写）', 'bit', '%QX1.2'),
        pre('%IX', '输入位（只读）', 'bit', '%IX0.0', { writable: false }),
        pre('%IW', '输入寄存器（只读，字）', 'word', '%IW5', { writable: false }),
      ],
      examples: ['%MW100', '%MD50', '%MX0.0', '%QX1.2', 'HR100', '100'],
    },
    {
      id: 'ts600',
      name: 'TS600 TCP',
      comm: 'ts600',
      addr_profile: 'ts600-modbus-tcp',
      default_address: 'D0',
      probe_address: 'D0',
      kind: 'element',
      help: 'D/M/X/Y/S/T/C/R/Z 元件写法，不支持 %MX 字内取位',
      prefixes: [
        pre('D', '数据寄存器（字，读写）', 'word', 'D100'),
        pre('M', '内部辅助继电器（位）', 'bit', 'M10'),
        pre('X', '输入继电器（位，8 进制，只读）', 'bit', 'X17', { writable: false }),
        pre('Y', '输出继电器（位，8 进制）', 'bit', 'Y10'),
        pre('S', '步进继电器（位）', 'bit', 'S10'),
        pre('T', '定时器 T（bool = 触点，数值 = 当前值）', 'bitword', 'T5'),
        pre('C', '计数器 C（bool = 触点；C0~C199 数值；C200~C255 双字）', 'bitword', 'C5'),
        pre('R', '文件寄存器（字）', 'word', 'R100'),
        pre('Z', '变址寄存器（字）', 'word', 'Z3'),
      ],
      examples: ['D100', 'M10', 'Y10', 'X17', 'T5', 'C200', 'R100', 'Z3'],
    },
    {
      id: 'opcua',
      name: 'OPC UA',
      comm: 'opcua',
      addr_profile: '',
      default_address: '',
      probe_address: '',
      kind: 'nodeid',
      help: 'NodeId（ns=4;s=…）',
      prefixes: [],
      examples: ['ns=4;s=|var|设备.Application.POU.符号'],
    },
  ];
}

/** 把后端/本地给的目录归一成前端用的形状（前缀字段容错，缺的补默认值） */
function normalize(src, source) {
  const list = Array.isArray(src && src.protocols) ? src.protocols : [];
  const protocols = list.map((p) => ({
    id: protocolId(p && p.id) || String((p && p.id) || ''),
    name: String((p && (p.name || p.cn)) || (p && p.id) || ''),
    comm: String((p && (p.comm || p.id)) || ''),
    addr_profile: String((p && (p.addr_profile || p.profile)) || ''),
    default_address: String((p && p.default_address) || ''),
    probe_address: String((p && (p.probe_address || p.default_address)) || ''),
    kind: String((p && p.kind) || 'element'),
    help: String((p && p.help) || ''),
    prefixes: (Array.isArray(p && p.prefixes) ? p.prefixes : []).map((x) => pre(
      String((x && x.prefix) || ''),
      String((x && x.label) || ''),
      String((x && x.kind) || 'word'),
      String((x && x.example) || ''),
      { types: x && x.types, writable: !(x && x.writable === false), note: x && x.note },
    )).filter((x) => x.prefix),
    examples: Array.isArray(p && p.examples) ? p.examples.map(String) : [],
  })).filter((p) => p.id);

  // 后端目录缺了已知协议时补本地那份（界面别突然少一个协议选项）；
  // 顺序固定成 modbus / ts600 / opcua（后端顺序不一致也纠正过来）。
  const byId = {};
  for (const p of protocols) byId[p.id] = p;
  for (const p of fallbackProtocols()) if (!byId[p.id]) protocols.push(p);
  protocols.sort((a, b) => (orderIndex(a.id) - orderIndex(b.id)) || String(a.id).localeCompare(String(b.id)));

  return {
    protocols,
    byId: protocols.reduce((m, p) => { m[p.id] = p; return m; }, {}),
    current: src && src.current ? { protocol: protocolId(src.current.protocol) || String(src.current.protocol || ''), addr_profile: String(src.current.addr_profile || '') } : null,
    source,
    at: Date.now(),
  };
}

let snap = null;

/** 当前目录（同步；首次调用返回本地 FALLBACK，loadCatalog 成功后才换成后端的） */
export function catalog() {
  return snap || (snap = normalize({ protocols: fallbackProtocols() }, 'fallback'));
}

/** 目录来自哪里：'backend' = 后端给了；'fallback' = 本地兜底 */
export function catalogSource() { return catalog().source; }

/** 协议列表（顺序 modbus / ts600 / opcua） */
export function protocols() { return catalog().protocols; }

/** 某个协议的目录项（认不出返回 null） */
export function protocolInfo(pid) {
  const c = catalog();
  const id = protocolId(pid) || String(pid || '').toLowerCase();
  return c.byId[id] || null;
}

/** 某个协议认的地址前缀（[{prefix,label,kind,example,types,writable,note}]） */
export function prefixes(pid) {
  const p = protocolInfo(pid);
  return (p && p.prefixes) || [];
}

/** 默认地址（连接对话框「测试连接 / 字序体检」的默认值）：modbus %MW0 / ts600 D0 / opcua '' */
export function defaultAddress(pid) {
  const p = protocolInfo(pid);
  if (p && p.default_address) return p.default_address;
  const id = protocolId(pid);
  return id === 'ts600' ? 'D0' : (id === 'opcua' ? '' : '%MW0');
}

/** 探测地址（后端目录里给了 probe_address 就用它；否则同默认地址） */
export function probeAddress(pid) {
  const p = protocolInfo(pid);
  return (p && (p.probe_address || p.default_address)) || defaultAddress(pid);
}

/** 这个协议的地址是 NodeId 写法吗（OPC UA → 界面不显示「前缀下拉」） */
export function isNodeIdProtocol(pid) {
  const p = protocolInfo(pid);
  return !!p && p.kind === 'nodeid';
}

/** 协议的中文名（目录优先；认不出退回 utils 的 protocolCn） */
export function protocolName(pid) {
  const p = protocolInfo(pid);
  return (p && p.name) || protocolCn(pid) || String(pid || '');
}

/** 从地址文本里认出前缀（'%MW100' → '%MW'；'D100' → 'D'；认不出 → ''）。
 *  只认目录里的前缀，且前缀后面必须紧跟数字/点（避免 '%M' 吃掉 '%MW100' 这种误判）。 */
export function prefixOf(pid, address) {
  const s = String(address == null ? '' : address).trim().toUpperCase();
  if (!s) return '';
  let best = '';
  for (const x of prefixes(pid)) {
    const q = String(x.prefix || '').toUpperCase();
    if (!q || !s.startsWith(q)) continue;
    const rest = s.slice(q.length);
    if (rest && !/^[0-9.]/.test(rest)) continue;
    if (q.length > best.length) best = x.prefix;
  }
  return best;
}

/** 从后端拿一次目录（缓存 60s；force=true 强刷）。
 *  后端没有 comm_api / 连不上 → 保持本地 FALLBACK，**不抛错**（界面不能因为目录拿不到就坏）。
 *  @returns {Promise<object>} 目录快照（catalog() 同款） */
export async function loadCatalog({ force = false } = {}) {
  let d = null;
  try { d = await backend.commProtocols({ force }); } catch { d = null; }
  if (d && Array.isArray(d.protocols) && d.protocols.length) {
    const next = normalize(d, 'backend');
    const changed = !snap || snap.source !== 'backend'
      || JSON.stringify(snap.protocols) !== JSON.stringify(next.protocols);
    snap = next;
    if (changed) { try { bus.emit('addr:catalog', next); } catch { /* 忽略 */ } }
    return next;
  }
  if (!snap) snap = normalize({ protocols: fallbackProtocols() }, 'fallback');
  return snap;
}

/**
 * 地址校验：先问后端（结论以后端为准），拿不到结论时退回本地 addrMap 判定。
 * @param {string} pid 协议 id（modbus / ts600 / opcua）
 * @param {string} address 地址文本（空 = 内部变量）
 * @param {string} [vtype] 变量类型（bool/int/real/string/…；TS600 的 T/C 靠它分触点/当前值）
 * @param {boolean} [write] 这个变量是否会被写（只读地址写要提示）
 * @returns {Promise<object>} {valid, unsupported, code, message, warning, writable, protocol,
 *          addr_profile, prefix, address, source:'backend'|'local'}
 */
export async function validate(pid, address, vtype = '', write = false) {
  const proto = protocolId(pid) || 'modbus';
  const raw = String(address == null ? '' : address).trim();
  // 空地址 = 内部变量：这是正常用法，不必问后端（后端按 code:'empty' 返回，口径和界面不同）
  if (!raw) return localValidate(proto, raw, vtype, write);
  let got = null;
  try { got = await backend.validateAddr({ protocol: proto, address: raw, vtype, write }); } catch { got = null; }
  if (got && typeof got.valid === 'boolean') {
    const out = {
      ...got,
      protocol: protocolId(got.protocol) || proto,
      prefix: got.prefix || prefixOf(got.protocol || proto, raw),
      source: 'backend',
    };
    // 后端「有效」时不一定带说明文案：补一句「映射到哪个寄存器 / 占几个字」的灰字（变量表 title 同款）
    if (out.valid && !out.message) {
      try { out.message = describeAddr(raw, vtype, 0, profileForProtocol(out.protocol) || undefined); } catch { /* 忽略 */ }
    }
    return out;
  }
  return localValidate(proto, raw, vtype, write);
}

/** 本地判定（后端没有 comm_api / 超时兜底）：规则全部委托给 addrMap，别在这儿另写一套。 */
export function localValidate(proto, address, vtype = '', write = false) {
  const pid = protocolId(proto) || 'modbus';
  const raw = String(address == null ? '' : address).trim();
  const out = {
    ok: true,
    valid: true,
    unsupported: false,
    code: '',
    message: '',
    warning: '',
    writable: true,
    readonly: false,
    protocol: pid,
    addr_profile: profileForProtocol(pid) || '',
    prefix: prefixOf(pid, raw),
    address: null,
    source: 'local',
  };
  const invalid = (message) => ({ ...out, valid: false, unsupported: false, code: 'invalid', message });
  /** 写法与协议不匹配 = 内部变量（灰字，不标红 —— 既有现场口径） */
  const modelBad = (message) => ({
    ...out, valid: false, unsupported: true, code: 'model', writable: true, readonly: false, message,
  });
  const internalNote = (name) => `地址 ${raw} 不符合当前协议（${name}），按内部变量处理：不采集、不下发`;
  const pName = protocolName(pid);

  if (!raw) return { ...out, code: 'empty', message: '留空 = 内部变量（不采集、不下发）' };

  if (pid === 'opcua') {
    if (isOpcAddr(raw)) {
      return { ...out, message: describeNodeId(raw), address: { raw, kind: 'nodeid' } };
    }
    return modelBad(internalNote(pName) + '（OPC UA 要填完整 NodeId：ns=4;s=…）');
  }

  if (pid === 'ts600') {
    // NodeId / %MX 字内取位 / %QX / %QW / %IW 这些 TS600 没有的写法 → 内部变量，不报错。
    // 兼容写法（%MW / %W / %MD、HR100 / 4x0100、纯数字）和元件写法 D/M/X/Y/S/T/C/R/Z 一样有效。
    if (isOpcAddr(raw)) return modelBad(internalNote(pName) + '（TS600 没有 NodeId 写法）');
    const s = raw.toUpperCase().replace(/\s+/g, '');
    if (s.startsWith('%')) {
      const base = s.replace(/\[\d+\]$/, '');
      const kind = ((/^%([A-Z]+)/.exec(base) || [])[1]) || '';
      const compat = !base.includes('.') && ['MW', 'W', 'MD'].includes(kind);
      if (!compat) {
        return modelBad(internalNote(pName)
          + `（TS600 没有 ${'%' + kind} 这类字内取位/位打包/输入区写法；位请写元件地址 M10 / X17 / Y10，寄存器写 D100 或 %MW100）`);
      }
    }
    try {
      const a = parseAddr(raw, vtype, PROFILE_TS600);
      const ro = a.readonly === true;
      return {
        ...out,
        valid: true,
        writable: !ro,
        readonly: ro,
        message: describeAddr(raw, vtype, 0, PROFILE_TS600),
        address: { ...a },
      };
    } catch (e) {
      const note = describeAddr(raw, vtype, 0, PROFILE_TS600);
      return invalid(/^⚠/.test(note) ? note : `⚠ ${(e && e.message) || note || '地址不合法'}`);
    }
  }

  // modbus（INVT / Invtmatic 写法）
  if (isOpcAddr(raw)) return modelBad(internalNote(pName) + '（Modbus TCP 不认 NodeId；NodeId 请切到 OPC UA 协议）');
  if (/^[DMSXYTCRZ][0-9]+$/i.test(raw)) {
    return modelBad(internalNote(pName) + '（要写 INVT 写法 %MW100 / %MX0.0；TS600 元件写法请先在连接对话框里切协议）');
  }
  try {
    const a = parseAddr(raw, vtype, PROFILE_INVT);
    const ro = a.area === 'discrete' || a.area === 'input_reg';
    return {
      ...out,
      valid: true,
      writable: !ro,
      readonly: ro,
      message: describeAddr(raw, vtype, 0, PROFILE_INVT),
      address: { ...a },
    };
  } catch (e) {
    const note = describeAddr(raw, vtype, 0, PROFILE_INVT);
    return invalid(/^⚠/.test(note) ? note : `⚠ ${(e && e.message) || note || '地址不合法'}`);
  }
}

export { PROTOCOLS };
