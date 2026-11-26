/**
 * utils.js — 纯工具函数（无状态，无依赖）
 */

let idCounter = 0;
/** 生成短 id（前缀可区分对象类型） */
export function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function deepClone(obj) {
  return structuredClone(obj);
}

/* ── 变量地址 ──────────────────────────────────────────────────────
   工程里统一用 Invtmatic/CODESYS 的 %MW 写法（%MW100）；HR100、纯数字 100
   这些兼容写法在输入/导入时自动转成 %MW100，免得同一张表里三种写法混着。
   后端（server/modbus.py）三种都认，所以老数据即使没转过也能跑。

   ⚠ 改用 OPC UA 之后，地址列放的是 **NodeId**（ns=4;s=|var|CODESYS ... .PLC_PRG.x）：
   它不是寄存器号、也没有规律，所以下面这套「归一化/递增/位地址判断」都要先问一句
   isOpcAddr() —— 否则会把 NodeId 里的空格吃掉，而 CODESYS 的设备名里正好带空格，
   地址当场就废了。 */

/** 是不是 OPC UA 的 NodeId（而不是 Modbus 的 %MW/%QX 地址） */
export function isOpcAddr(addr) {
  const s = String(addr ?? '').trim();
  if (!s) return false;
  if (/^ns=\d+\s*;/i.test(s)) return true;
  if (/^[sigb]\s*=/i.test(s) && !s.startsWith('%')) return true;
  return s.startsWith('|var|');                  // 直接粘 CODESYS 符号
}

/** NodeId 归一化：补 ns=（缺省用 defaultNs），裸 CODESYS 符号按字符串标识处理。
 *  认不出的原样返回（交给后端报错，不猜）。 */
export function normNodeId(addr, defaultNs = 4) {
  const s = String(addr ?? '').trim();
  if (!s) return '';
  let ns = null, rest = s;
  const m = /^ns=(\d+)\s*;\s*(.*)$/i.exec(s);
  if (m) { ns = Number(m[1]); rest = m[2].trim(); }
  const mi = /^([sigb])\s*=\s*(.+)$/i.exec(rest);
  const kind = mi ? mi[1].toLowerCase() : 's';
  const ident = mi ? mi[2].trim() : rest;
  if (!ident) return s;
  if (ns === null) ns = Number(defaultNs) || 4;
  return `ns=${ns};${kind}=${ident}`;
}

/** NodeId 说人话（变量表地址格的 title / 导入对话框用） */
export function describeNodeId(addr, defaultNs = 4) {
  const s = String(addr ?? '').trim();
  if (!s) return '未填 NodeId（不会参与 OPC UA 采集）';
  if (/^opc\.tcp:\/\//i.test(s)) return '⚠ 这里要填 NodeId（如 ns=4;s=PLC_PRG.x），不是端点地址';
  const m = /^(?:ns=(\d+)\s*;\s*)?([sigb])\s*=\s*(.+)$/i.exec(s);
  if (!m) return '⚠ 认不出的 NodeId 写法（支持 ns=4;s=符号名 / ns=2;i=1001 / 直接粘 |var|… 符号）';
  const ns = m[1] !== undefined ? m[1] : String(defaultNs);
  const kind = (m[2] || 's').toLowerCase();
  const ident = m[3];
  const kindCn = { s: '字符串', i: '数值', g: 'GUID', b: '字节串' }[kind] || kind;
  const sym = ident.startsWith('|var|') ? ident.split('.').slice(-1)[0] : ident;
  return `OPC UA NodeId：命名空间 ns=${ns}，${kindCn}标识　符号：${sym}`
    + (ident.length > 60 ? '（标识较长，完整值见地址格）' : '');
}

/* ==================== 地址模型（PLC 地址体系）====================
 * 现场有两套 PLC：Invtmatic/INVT（%MW/%MD/%QX… 写法）与 TS600（D/M/X/Y/S/T/C/R/Z 元件写法）。
 * 同一串地址在两套模型下的含义完全不同，所以「当前用哪套」必须显式记住、跟着连接/工程走。
 * 规则以 server/addr_model.py 为准（parseAddr/describeAddr 在 core/addrMap.js，这里只放状态）。
 * 为什么状态放 utils：addrMap.js 已经 import utils.js，反向 import 会形成循环依赖。
 */
export const PROFILE_INVT = 'invt-modbus-slave';
export const PROFILE_TS600 = 'ts600-modbus-tcp';
export const PROFILE_DEFAULT = PROFILE_INVT;
/** 下拉/提示用：id 与后端的 addr_profile 一字不差，cn 是给人看的 */
export const PROFILES = [
  { id: PROFILE_INVT, cn: 'Invtmatic/INVT Modbus_TCP_Slave（%MW/%MD/%QX/%QW… 写法）' },
  { id: PROFILE_TS600, cn: 'TS600 系列（D/M/X/Y/S/T/C/R/Z 元件写法）' },
];
const PROFILE_LS_KEY = 'hmi-addr-profile';
const PROFILE_ALIASES = {
  '': PROFILE_INVT, invt: PROFILE_INVT, invtmatic: PROFILE_INVT,
  'invt-modbus-slave': PROFILE_INVT, 'invt-modbus-tcp': PROFILE_INVT,
  ts: PROFILE_TS600, ts600: PROFILE_TS600, 'ts600-modbus': PROFILE_TS600,
  'ts600-modbus-tcp': PROFILE_TS600,
};
let _profile = '';

/** 地址模型 id 归一：别名/空/认不出的都回默认 INVT（不抛错，调用方别为这个写 try） */
export function profileId(name) {
  const k = String(name ?? '').trim().toLowerCase();
  return PROFILE_ALIASES[k] || PROFILE_DEFAULT;
}

/** 当前地址模型 id。第一次调用时从 localStorage 懒加载；
 *  node 里没有 localStorage 也能正常跑（导入 utils 的脚本/自测不受影响） */
export function getProfile() {
  if (!_profile) {
    let saved = '';
    try {
      if (typeof localStorage !== 'undefined') saved = localStorage.getItem(PROFILE_LS_KEY) || '';
    } catch { /* 隐私模式/localStorage 被禁：当作没存过 */ }
    _profile = profileId(saved);
  }
  return _profile;
}

/** 切换地址模型（同时记住，下次打开还是它）；返回归一后的 id。
 *  注意：连上 PLC 后应以 /api/plc 的 addr_profile 为准（backend.getPlc 里会再同步一次）。
 *  @param {string} name 模型名/别名
 *  @param {boolean} [persist=true] 是否写进 localStorage。后端「当前配置」恢复用 false ——
 *    那是**服务器说的是什么**，不是用户自己选的，别把 hasStoredProfile() 弄脏。 */
export function setProfile(name, persist = true) {
  _profile = profileId(name);
  if (persist) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(PROFILE_LS_KEY, _profile);
    } catch { /* 同上 */ }
  }
  return _profile;
}

/** 本机有没有**显式选过**地址模型（localStorage 里有记录）。
 *  全新浏览器 = false：这时以后端 /api/plc 的 addr_profile 为准恢复；
 *  用户自己在对话框里选过 = true：内存模拟时不要被后端的默认值冲掉。 */
export function hasStoredProfile() {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem(PROFILE_LS_KEY);
  } catch { return false; }
}

/** 地址模型的中文名（对话框下拉、状态栏提示用） */
export function profileCn(name) {
  const id = profileId(name === undefined ? getProfile() : name);
  const p = PROFILES.find(x => x.id === id);
  return p ? p.cn : id;
}

/** 是不是 TS600 那套（元件字母+编号）；不传参数就看当前模型 */
export function isTs600(name) {
  return profileId(name === undefined ? getProfile() : name) === PROFILE_TS600;
}

/* ==================== 连接协议（PLC 对话框下拉，三项）====================
 * 现场只选「接的是哪种 PLC」，地址规则由协议推导 —— 不再让人单独选「地址模型」：
 *   ① modbus → Modbus TCP + INVT/CODESYS 地址写法（%MW/%MD/%QX/%QW…）
 *   ② ts600  → Modbus TCP + TS600 元件写法（D/M/X/Y/S/T/C/R/Z）
 *              ⚠ 落盘口径：protocol 存 "modbus"、addr_profile 存 "ts600-modbus-tcp"
 *                （后端 normalize 就是这样，前端读回时靠 addr_profile 认出 TS600）
 *   ③ opcua  → OPC UA：地址是 NodeId，没有「地址模型」这回事
 */
export const PROTOCOLS = [
  { id: 'modbus', cn: 'Modbus TCP' },
  { id: 'ts600', cn: 'TS600 TCP' },
  { id: 'opcua', cn: 'OPC UA' },
];
/** 协议名归一（含现场/老配置里的别名）；认不出返回 ''，由调用方决定怎么兜底 */
const PROTOCOL_ALIASES = {
  modbus: 'modbus', 'modbus-tcp': 'modbus', modbus_tcp: 'modbus',
  invt: 'modbus', invtmatic: 'modbus', 'invt-modbus-slave': 'modbus', 'invt-modbus-tcp': 'modbus',
  ts: 'ts600', ts600: 'ts600', 'ts600-modbus': 'ts600', 'ts600-modbus-tcp': 'ts600',
  'ts600-tcp': 'ts600', ts600_tcp: 'ts600', modbus_ts: 'ts600', 'modbus-ts': 'ts600',
  opcua: 'opcua', 'opc-ua': 'opcua', opc_ua: 'opcua', ua: 'opcua',
};

/** 协议 id 归一：'TS600' / 'ts600_tcp' / 'invt' → 'ts600' / 'ts600' / 'modbus'；认不出返回 '' */
export function protocolId(name) {
  const k = String(name ?? '').trim().toLowerCase();
  return PROTOCOL_ALIASES[k] || '';
}

/** 协议 → 地址模型 id（OPC UA 返回 ''：NodeId 没有地址模型） */
export function profileForProtocol(name) {
  const id = protocolId(name);
  if (id === 'opcua') return '';
  return id === 'ts600' ? PROFILE_TS600 : PROFILE_INVT;
}

/** 地址模型 → 协议 id（只有 Modbus 那两支有地址模型） */
export function protocolForProfile(name) {
  return profileId(name) === PROFILE_TS600 ? 'ts600' : 'modbus';
}

/** 从一份连接配置（localStorage / 工程 meta.plc / 后端 config/status）里读出三项协议之一。
 *  规则：protocol 优先（opcua / ts600 直接认）；protocol=modbus 时再看 addr_profile 是不是
 *  ts600-modbus-tcp（后端落盘就是 protocol:"modbus" + addr_profile:"ts600-modbus-tcp"）；
 *  老配置只有 protocol 的按 modbus / opcua 处理；什么都没有返回 ''。 */
export function protocolOfConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  const id = protocolId(cfg.protocol);
  if (id === 'opcua' || id === 'ts600') return id;
  const prof = String(cfg.addr_profile || cfg.addr_model || '').trim();
  if (prof && isTs600(prof)) return 'ts600';
  if (id === 'modbus' || prof) return 'modbus';
  return '';
}

/** 协议的中文名（「Modbus TCP」/「TS600 TCP」/「OPC UA」） */
export function protocolCn(name) {
  const id = protocolId(name);
  const p = PROTOCOLS.find(x => x.id === id);
  return p ? p.cn : '';
}

/** 这个协议名是不是「TS600」（也接受 ts / ts600-modbus-tcp 这类别名） */
export function isTsProtocol(name) {
  return protocolId(name) === 'ts600';
}

/** 地址归一化：HR100 → %MW100；100 → %MW100；%mw100 → %MW100。认不出的原样返回。
 *  **百分号可以省**：mx100.0 → %MX100.0、QX0 → %QX0、mw200 → %MW200（现场口径，少敲一个字符）。
 *  TS600 模型下：d100 / D 100 / X17 → D100 / X17（大写元件、编号去前导零）；
 *  %MW/HR/4X/数字是「兼容写法」，按后端规则原样大写（**不**改写成 %MW，两套模型里含义一样）。 */
export function normAddr(addr) {
  const s = String(addr ?? '').trim().replace(/\s+/g, '');
  if (!s) return '';
  // OPC UA 的 NodeId 不走下面那套（去空格 + 转 %MW）：去空格会把 CODESYS 符号改坏
  if (isOpcAddr(addr)) return String(addr ?? '').trim();
  const up = s.toUpperCase();
  let m;
  if (isTs600()) {
    // 段写法 D100[10] 归一时别把后缀弄丢
    const sp = /^(.*?)\[(\d+)\]$/.exec(s);
    const body = (sp ? sp[1] : s).toUpperCase();
    const tail = sp ? `[${sp[2]}]` : '';
    if ((m = /^([DMSXYTCRZ])(\d+)$/.exec(body))) return `${m[1]}${Number(m[2])}${tail}`;
    if ((m = /^%(MW|QW|MD|MB|MX|IX|IW|QX)(\d+(?:\.\d+)?)$/.exec(body))) return `%${m[1]}${m[2]}${tail}`;
    if (/^(?:HR|4X)[0-9A-F]+$/.test(body) || /^\d+$/.test(body)) return body + tail;  // 兼容写法：只大写，不转换
    return s;                                    // 认不出的（DB1.DBD4 之类）不猜，交给后端报错
  }
  if ((m = /^(?:HR|4X)(\d+)$/.exec(up))) return `%MW${Number(m[1])}`;   // 4x0101 → %MW101（后端同样按偏移 101 解析）
  if (/^\d+$/.test(up)) {
    const n = Number(up);
    if (n >= 40001 && n <= 49999) return up;      // 标准 4x 写法：后端按 40001→偏移 0，别自作主张改
    return `%MW${n}`;
  }
  if ((m = /^%(MW|QW|MD|MB|MX|IX|IW|QX)(\d+(?:\.\d+)?)$/.exec(up))) return `%${m[1]}${m[2]}`;
  // 百分号可以省（现场口径：少敲一个 %）：mx100.0 / QX0 / MW200 / IX0.0 都补成 %MX100.0 …
  //   只认**多字母前缀**（QW/QB/QD/QX/MW/MD/MB/MX/IX/IW/IB/ID）：单字母 M/D/X/Y/S/T/C/R/Z
  //   是 TS600 的元件写法，在 INVT 模型里要保持「写法不匹配 → 按内部变量」，不能偷偷补成 %M/%D。
  if ((m = /^(QW|QB|QD|QX|MW|MD|MB|MX|IX|IW|IB|ID)(\d+(?:\.\d+)?)(\[\d+\])?$/.exec(up))) {
    return `%${m[1]}${m[2]}${m[3] || ''}`;
  }
  if ((m = /^(%[A-Z]+\d+)\[(\d+)\]$/.exec(up))) return `${m[1]}[${m[2]}]`;   // 段写法 %MW200[10]
  if (/^4X[0-9A-F]+$/.test(up)) return up;        // 4x 区（十六进制）保持大写原样
  return s;                                      // DB1.DBD4 / 4x_Bit100.0 之类：不猜，交给后端报错
}

/** 数组里一个元素占几个寄存器（和后端 modbus.elem_words 一致） */
export function elemWords(elemType) {
  const t = String(elemType || '').toLowerCase();
  if (t === 'real' || t === 'dint' || t === 'udint') return 2;
  if (t === 'lreal') return 4;
  return 1;
}

/** 类型占几个寄存器（和后端 modbus.words_for 一致）：
 *  string = 2 字符 1 个字、wstring = 1 个宽字符 1 个字、
 *  数组 = 元素个数 × 每个元素占的字数（real[]/dint[] 每元素 2 字） */
export function wordsFor(type, len) {
  const t = String(type || '').toLowerCase();
  if (isArrayType(t)) return Math.max(1, Number(len) || 1) * elemWords(elemTypeOf(t));
  if (t === 'wstring') return Math.max(1, Number(len) || 10);
  if (t === 'string') return Math.max(1, Math.ceil((Number(len) || 10) / 2));
  if (t === 'lreal') return 4;
  if (t === 'real' || t === 'dint' || t === 'udint') return 2;
  return 1;
}

/** 数组类型：`int[]` / `real[]` …（元素类型 + 元素个数，个数存在变量表的「字长/个数」列）
 *  为什么用这种写法：变量表类型列本来就是个下拉，加 8 个 `xxx[]` 选项最省事，
 *  也不用为数组单开一列（个数复用 string 已经在用的「长度」列）。 */
export function isArrayType(type) {
  return /\[\]$/.test(String(type || '').trim());
}

/** 取数组的元素类型：'int[]' → 'int'；非数组原样返回 */
export function elemTypeOf(type) {
  const t = String(type || '').trim();
  return isArrayType(t) ? t.slice(0, -2) : t;
}

/** 数组/字符串这类「带长度」的类型，长度存在 v.len 里 */
export function arrayLenOf(v, dflt = 10) {
  return Math.max(1, Math.min(4096, Number(v?.len) || dflt));
}

/** 把「1,2,3」/「[1 2 3]」这类文本解析成元素数组（CSV 导入初值、脚本 set 都用它） */
export function parseArrayText(text, elemType = 'real') {
  const parts = String(text ?? '').replace(/^\[|\]$/g, '').split(/[,;\s]+/).filter(s => s !== '');
  return parts.map(p => {
    const t = String(elemType || '').toLowerCase();
    if (t === 'bool') return p === 'true' || p === '1';
    if (t === 'string') return p;
    if (t === 'real' || t === 'lreal') return Number(p) || 0;
    return Math.round(Number(p) || 0);
  });
}

/** 是不是位地址（bool 该用这种）：%MX195.0 / %QX0 / %IX5 / %MX0；
 *  TS600 下则是位元件 M10 / S10 / X17 / Y10 / T5 / C150，字元件 D/R/Z 不算 */
export function isBitAddr(addr, profile = getProfile()) {
  const s = String(addr ?? '').trim().toUpperCase();
  if (isTs600(profile)) {
    if (/^[MSXYTC]\d+$/.test(s)) return true;
    if (/^[DRZ]\d+$/.test(s)) return false;
  }
  return /^%M?[QI]?X\d+(\.\d)?$/.test(s) || /^%M?X\d+\.\d$/.test(s);
}

/** TS600 元件地址 + 偏移（D100 + 2 → D102）。
 *  返回 null = 「这不是元件写法」（交给 %MW 那套处理）；返回 '' = 越界/不猜。
 *  位元件 M/S/X/Y 之间没有可靠的编号关系（M10 的「下一个」到底是 M11 还是下一个字的位？），不猜。 */
function bumpTs600(s, n) {
  const m = /^([DMSXYTCRZ])(\d+)(?:\[(\d+)\])?$/.exec(s.toUpperCase());
  if (!m) return null;
  const kind = m[1], digits = m[2], spanN = m[3];
  const cur = Number(digits);
  const out = next => `${kind}${String(next).padStart(digits.length, '0')}${spanN ? `[${spanN}]` : ''}`;
  if ('MSXY'.includes(kind)) return n ? '' : s;
  let step = n, lim;
  if (kind === 'C') {
    if (cur >= 200) {                 // C200~C255：2 个寄存器 1 个元件，挪奇数个字对不上编号
      if (n % 2) return '';
      step = n / 2;
      lim = 255;
    } else {
      lim = 199;
    }
  } else if (kind === 'D') lim = 32767;
  else if (kind === 'R') lim = 16383;
  else if (kind === 'Z') lim = 15;
  else if (kind === 'T') lim = 399;
  else return null;
  const next = cur + step;
  if (next < 0 || next > lim) return '';
  return out(next);
}

/**
 * 地址 + 偏移（多重复制时按间隔往后/往前排）：%MW100 + 2 → %MW102；%MW100 + (-2) → %MW98
 * · 数字位数保持原样（%MW0100 + 2 → %MW0102）
 * · 位地址 %MX0.0 按**位**往后排（+1 → %MX0.1，%MX0.7 +1 → %MX1.0）；%QX5/%IX5 这种本来就是位号
 * · %MD50 是「第 50 个双字」→ 挪 2 个字才算 +1 个 %MD（挪奇数个字没法用 %MD 表示 → 返回 ''）
 * · %MB194 是字节地址 → 挪 1 个字 = 挪 2 个字节
 * · 认不出的写法（DB1.DBD4）→ 返回 ''（宁可不猜，让用户手填）
 * · TS600 元件写法按元件区走：D100 + 2 → D102；M10 这类位元件没有「下一个」可推 → 返回 ''；
 *   C200~C255 是双字计数器（2 个寄存器 1 个元件），挪偶数个字才算 +1 个 C
 */
export function bumpAddr(addr, words, profile = getProfile()) {
  const s = String(addr ?? '').trim();
  const n = Math.round(Number(words) || 0);
  if (!s) return '';
  // OPC UA NodeId：普通 NodeId 之间没有任何算术关系（不能猜），**只有数组元素**这种写法能推 ——
  // …GVL.arrw[3] + 1 → …GVL.arrw[4]。页面上用了「展开成单个变量」的元素时，
  // 多重复制就靠这一条把副本指到下一个元素上。
  if (isOpcAddr(s)) {
    const m = /^(.*\[)(\d+)(\])$/.exec(s);
    if (!m) return '';                 // 普通 NodeId：彼此没有算术关系，不猜（让用户手填）
    if (!n) return s;                  // 偏移 0 = 原样
    return `${m[1]}${Number(m[2]) + n}${m[3]}`;
  }
  if (isTs600(profile)) {
    const ts = bumpTs600(s, n);
    if (ts !== null) return ts;        // 元件写法自己算；%MW/HR/数字 交给下面那套
  }
  const bit = /^(%[MQI]X)(\d+)\.(\d)$/.exec(s.toUpperCase());
  if (bit) {                                    // %MX0.0：按位进位（byte.bit）
    if (!n) return s;
    const total = Number(bit[2]) * 8 + Number(bit[3]) + n;
    if (total < 0 || total > 65535 * 8 + 7) return '';
    return `${bit[1]}${Math.floor(total / 8)}.${total % 8}`;
  }
  if (s.includes('.')) return '';               // 其它带点的写法不猜
  const span = /^(.*?)(\d+)(\[(\d+)\])?$/.exec(s);
  if (!span) return '';
  const [, head, digits, , spanN] = span;
  const up = head.toUpperCase();
  let step = n;
  if (up.endsWith('%MD')) {
    if (n % 2) return '';                       // 半个别字对不上 %MD 的编号
    step = n / 2;
  } else if (up.endsWith('%MB')) {
    step = n * 2;                               // 一个字 = 两个字节
  }
  const next = Number(digits) + step;
  if (!Number.isFinite(next) || next < 0 || next > 65535) return '';
  const out = head + String(next).padStart(digits.length, '0');
  return spanN ? `${out}[${spanN}]` : out;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 这个变量名能不能写成**点属性**（`hmi.v.名字`）？
 *
 * JS 的 IdentifierName：首字符是字母（含中文等 Unicode 字母）/ `_` / `$`，后面可以带数字。
 * 首字符是**数字**就不行（`hmi.v.1号泵` 会被当成数字字面量 → 语法错），带横线/空格/点的也不行
 * —— 这几种只能写方括号：`hmi.v['1号泵']`。
 *
 * 三处共用（一处改口径三处一致）：脚本编辑器的例子片段、查找引用扫描、变量改名的改写。
 */
export function isIdentName(name) {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(String(name || ''));
}

/**
 * 脚本里变量「**属性写法**」的正则：`hmi.v.名字` / `hmi.v['名字']`（新写法，见 scriptEngine 的 hmi.v）。
 *
 * 组：1 = 点写法的名字 · 2 = 引号 · 3 = 方括号写法的名字 · 4 = 可选的字面量下标。
 * ⚠ 只能当**工厂**用（带 g 的正则有 lastIndex 状态）：扫描引用、改名替换两边各取一个新实例，
 *   否则一边 exec 到一半、另一边从中间接着匹配，会漏。
 * ⚠ 别把 `hmi.vars()` 也吃进来：点写法要求 `v` 后面**紧跟一个点**，`hmi.vars` 不满足。
 */
export const scriptVarPropRe = () =>
  /\bhmi\s*\.\s*v\s*(?:\.\s*([\p{L}\p{N}_$]+)|\[\s*(['"])([^'"]+)\2\s*\])(?:[ \t]*\[[ \t]*(\d+)[ \t]*\])?/gu;

/** 属性写法的代码片段（名字不是合法标识符时自动用方括号）—— 编辑器插例子、文档都用它 */
export const varSnippet = (name, value = 'true') =>
  (isIdentName(name) ? `hmi.v.${name}` : `hmi.v['${name}']`) + ` = ${value}`;

/**
 * 工控习惯的格式化：支持 %d / %.Nf / %s（与 CODESYS 文本模板一致）
 * fmtValue(12.3456, '%.1f') → '12.3'
 */
export function fmtValue(v, fmt) {
  if (v === null || v === undefined || v === '') return '--';
  // 数组（OPC UA 的 ARRAY 节点读回来就是一段）：显示成 [1, 2, 3]，
  // 元素多的时候截断，别把控件撑爆（要看全用表格控件或脚本）
  if (Array.isArray(v)) {
    const shown = v.slice(0, 8).map(x => (typeof x === 'number' && fmt ? fmtValue(x, fmt) : String(x)));
    return '[' + shown.join(', ') + (v.length > 8 ? `, …共 ${v.length} 个` : '') + ']';
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' && fmt) {
    const m = /^%(\d+)?(?:\.(\d+))?[dfs]$/.exec(fmt.trim());
    if (m) {
      if (m[0].endsWith('d')) return String(Math.round(v));
      const dec = m[2] !== undefined ? +m[2] : (m[0].endsWith('f') ? 6 : undefined);
      if (dec !== undefined) return v.toFixed(dec);
      return String(v);
    }
  }
  return String(v);
}

/**
 * 数值控件的「有效格式」：优先按显式数据类型（dispType/decimals）推导，
 * 旧工程没有这两个键时回落到原 fmt 字符串（%d / %.nf / %s）
 *   int/uint/dint/udint → %d        float/real/lreal + 小数位n → %.nf（n=0 即无小数点）        string → %s
 */
export function numberFmtOf(p) {
  if (!p) return '%.1f';
  const t = p.dispType;
  if (t === 'string') return '%s';
  if (isIntDtype(t)) {
    const n = intDecimalsOf(p);
    return n > 0 ? '%.' + n + 'f' : '%d';
  }
  if (t === 'float' || t === 'real' || t === 'lreal') {
    return '%.' + Math.max(0, Math.min(6, Math.round(p.decimals ?? 1))) + 'f';
  }
  return p.fmt || '%.1f';
}

/** 数据类型是不是整数类（int/uint/dint/udint） */
export function isIntDtype(dtype) {
  const s = String(dtype || '').trim().toLowerCase();
  return s === 'int' || s === 'uint' || s === 'dint' || s === 'udint';
}

/**
 * 整数控件的小数位 = 定点缩放位数 N：PLC 里 123、屏上 1.23（N=2）。
 * N=0（默认）= 纯整数，一个缩放都不做。
 *
 * ⚠ `fmt` 才是缩放开关，不是 decimals：老工程/老控件的 fmt 恒为 `%d`
 *   （decimals 里可能还残留着默认的 1），只有显式写成 `%.Nf` 才算开了缩放 ——
 *   否则升级后现场所有整数会集体小 10 倍。
 */
export function intDecimalsOf(p) {
  if (!p) return 0;
  // fmt 里的位数就是准绳（面板每次改小数位都会把 fmt 写成 %.Nf，两者永远一致）；
  // decimals 只在 fmt 没写位数时兜底（如 `%.f`），绝不反过来让残留的 decimals 盖掉 fmt
  const m = /^%\.(\d*)f$/.exec(String(p.fmt || '').trim());
  if (!m) return 0;
  const raw = m[1] !== '' ? +m[1] : +((p.decimals === undefined || p.decimals === null || p.decimals === '') ? 0 : p.decimals);
  const n = Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.min(6, Math.round(n)));
}

/** 整数控件的定点倍率：10^N（N=0 → 1，不缩放）。浮点/字符串/老工程一律 1 */
export function fixedScaleOf(p) {
  const n = isIntDtype(p && p.dispType) ? intDecimalsOf(p) : 0;
  return n > 0 ? 10 ** n : 1;
}

/** PLC 原始值 → 屏上显示值：整数定点 123 → 1.23；浮点/非数字原样返回（数组逐元素换算） */
export function dispValueOf(v, p) {
  const sc = fixedScaleOf(p);
  if (sc === 1 || typeof v !== 'number' || !Number.isFinite(v)) {
    if (sc !== 1 && Array.isArray(v)) return v.map(x => dispValueOf(x, p));
    return v;
  }
  return v / sc;
}

/** 屏上输入值 → 写进 PLC 的原始值：1.23 → 123（四舍五入；整数变量只认整数） */
export function rawValueOf(v, p) {
  const sc = fixedScaleOf(p);
  if (sc === 1 || typeof v !== 'number' || !Number.isFinite(v)) return v;
  return Math.round(v * sc);
}

/** 数据类型 + 小数位 → fmt（整数：0 位 = %d，1~6 位 = %.Nf 定点；浮点：%.Nf） */
export function fmtOfDecimals(dtype, decimals) {
  const s = String(dtype || '').trim().toLowerCase();
  if (s === 'string') return '%s';
  const int = isIntDtype(s);
  const raw = (decimals === undefined || decimals === null || decimals === '') ? (int ? 0 : 1) : +decimals;
  const n = Math.max(0, Math.min(6, Math.round(Number.isFinite(raw) ? raw : (int ? 0 : 1))));
  if (int) return n > 0 ? '%.' + n + 'f' : '%d';
  return '%.' + n + 'f';
}

/**
 * 变量表类型 → 数值控件的「数据类型」下拉值。**两边必须一一对齐**，否则会出现
 * 「变量是 int、控件写着 string」这种对不上的组合（现场表现就是数字显示成字符串/反过来）。
 *   real  → float      （下拉里 float/real 是同一项）
 *   wstring → string
 *   数组  → 取元素类型（int[] → int）
 *   bool / 认不出 → '' （交给控件自己那份 dispType，别硬套）
 */
export function dtypeOfVarType(type) {
  const s = String(type || '').trim().toLowerCase();
  if (s.endsWith('[]')) return dtypeOfVarType(s.slice(0, -2));
  if (s === 'real') return 'float';
  if (s === 'wstring') return 'string';
  if (s === 'int' || s === 'uint' || s === 'dint' || s === 'udint' || s === 'lreal' || s === 'string') return s;
  return '';
}

/** 数值控件的「数据类型」→ 变量表类型（float → real，其余同名） */
export function varTypeOfDtype(dtype) {
  const s = String(dtype || '').trim().toLowerCase();
  if (s === 'float') return 'real';
  return s;
}

/** 数据类型 + 小数位 → 老式的 fmt 串（%d / %.nf / %s）。三者一直是一起写的 */
export function fmtOfDtype(dtype, decimals) {
  const s = String(dtype || '').trim().toLowerCase();
  if (s === 'string') return '%s';
  if (s === 'float' || s === 'real' || s === 'lreal') {
    return '%.' + Math.max(0, Math.min(6, Math.round(decimals ?? 1))) + 'f';
  }
  return '%d';
}

/** 从旧 fmt 字符串反推数据类型（属性面板显示用，仅老工程缺 dispType 时） */
export function dtypeFromFmt(fmt) {
  if (fmt === '%d') return 'int';
  if (/^%\.\d+f$/.test(String(fmt || ''))) return 'float';
  if (fmt === '%s') return 'string';
  return 'float';
}

/**
 * 这个地址值不值得显示（清单/候选表这类"一行里塞不下多少字"的地方用）。
 *
 * 为什么要有它：OPC UA 的地址是完整 NodeId（`ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.中1[1]`），
 * 里面基本重复了变量名，一行根本放不下 —— 显示出来就是"变量名被挤没、只剩一团地址"。
 * Modbus/TCP 的 `%MW100` 不一样：短、而且是现场对着表查点位要用的，必须显示。
 * 所以规则是：**NodeId 式的一律不显示，过长的也不显示**，其余原样给（拿不到就返回空串）。
 */
export function shortAddr(addr, max = 24) {
  const s = String(addr || '').trim();
  if (!s) return '';
  if (/^(ns=|opc\.tcp:|s=|i=|g=|b=)/i.test(s)) return '';   // NodeId / 端点地址
  return s.length <= max ? s : '';
}

/** 从旧 fmt 字符串反推小数位 */
export function decimalsFromFmt(fmt) {
  if (fmt === '%d') return 0;
  const m = /^%\.(\d+)f$/.exec(String(fmt || ''));
  return m ? +m[1] : 1;
}

/**
 * 颜色写法：`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()・rgba()・hsl()・hsla()`。
 * **故意不认颜色名**（red、红…）：`显示=red` 里的 red 到底是"值"还是"颜色"，没法分清 ——
 * 认不出来就还按值处理，老工程的选项表行为一点不变。
 */
export function isColorToken(s) {
  const t = String(s ?? '').trim();
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)
    || /^(rgb|rgba|hsl|hsla)\(/i.test(t);
}

/**
 * 下拉框（组合框）的选项表：一行一个，`显示文字` / `显示文字=值` / `显示文字=值=颜色`。
 * 值写成数字就当数字用（写进 PLC 的通常是 0/1/2 这种），否则按字符串。
 * 颜色是该状态的专用色（状态显示时整块/文字跟着变），见 defs.js 的 stateColorOn。
 * 例：  手动=0=#3b82f6\n自动=1=#22c55e      或    启动\n停止      或    手动=0\n自动=1
 */
export function parseOptions(text) {
  return String(text ?? '').split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      let body = line, color = '';
      // 末段是颜色才算颜色：`手动=0=#22c55e`。先剥掉它，剩下那段还按老规矩拆「文字=值」，
      // 所以 `启动=#22c55e`（没写值）也认 —— 值本来就是文字本身。
      const j = body.lastIndexOf('=');
      if (j > 0 && isColorToken(body.slice(j + 1))) {
        color = body.slice(j + 1).trim();
        body = body.slice(0, j);
      }
      const i = body.lastIndexOf('=');
      if (i <= 0) return { label: body, value: body, color };
      const label = body.slice(0, i).trim();
      const raw = body.slice(i + 1).trim();
      const num = raw !== '' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
      return { label, value: num, color };
    });
}

/**
 * 颜色 → 该配黑字还是白字（自动对比），返回 '#1f2329' / '#ffffff'。
 * 认不出的写法（hsl() 之类）返回空串，调用方回落到自己的文字色。
 *
 * 算法：按 sRGB 加权算相对亮度 L，再比「配黑字」和「配白字」哪个对比度大 ——
 * 分界正好落在 L≈0.179（1.05/(L+0.05) 与 (L+0.05)/0.05 相等处），不是拍脑袋定的阈值。
 * 用途：下拉框状态色铺满整块时，深色底要白字、浅色底要黑字；11 个状态一种文字色不可能都看得清。
 */
export function contrastTextOn(color) {
  const m = /^#([0-9a-f]{3,4})$/i.exec(String(color || '').trim());
  let rgb = null;
  if (m) rgb = [...m[1].slice(0, 3)].map(h => parseInt(h + h, 16));
  else {
    const m6 = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (m6) rgb = [0, 2, 4].map(i => parseInt(m6[1].slice(i, i + 2), 16));
    else {
      const mr = /^rgba?\(([^)]+)\)$/i.exec(String(color || '').trim());
      if (mr) {
        const p = mr[1].split(/[,\s/]+/).map(Number);
        if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) rgb = p.slice(0, 3);
      }
    }
  }
  if (!rgb) return '';
  const lin = rgb.map(v => {
    const c = Math.max(0, Math.min(255, v)) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.179 ? '#1f2329' : '#ffffff';
}

export function textAlignOf(value, fallback = 'left') {
  return ['left', 'center', 'right'].includes(value) ? value : fallback;
}

/**
 * 这个控件勾了「点击穿透」吗（老工程 / 没勾 = 不穿透）。
 * 穿透的意思：运行态点我，我自己的动作照做，**压在下面的控件的动作也一起做**
 * （两个控件叠着放，点一下两个都触发；方框没配动作时 = 透过方框点到下面的按钮）。
 * 值既认勾选框的真假（现在的写法），也认 'on'/'both' 这两个字符串（第一版三选一留下的写法，
 * 已经选了的老工程照样认）。
 */
export function isClickThrough(props) {
  const v = props?.clickThrough;
  return v === true || v === 'on' || v === 'both';
}

/**
 * 下拉框（组合框）的「操作方式」：view=只显示状态 / pick=只能选 / type=可选也可输入。
 * 老工程只有 readonly（true = 只显示不可选）这一个勾 —— 认不到 operate 就按它回落；
 * 载入时 project.normalize 会把老键迁成 operate，属性面板上就只剩一处开关。
 */
export function comboMode(props) {
  const m = String(props?.operate || '');
  if (m === 'view' || m === 'pick' || m === 'type') return m;
  return props?.readonly === true ? 'view' : 'pick';
}

/**
 * 给「选项」文本里第 idx 个（第 idx+1 个非空行）选项设颜色，**返回改写后的整段文本**。
 * 颜色就存在这一份选项表里，不另存一张颜色表 —— 两处存必然会有对不上的一天。
 * color 传空串 = 清掉这个状态的颜色。只动点名的那一行（行数、顺序、其它行原样保留）。
 */
export function setOptionColor(text, idx, color) {
  const lines = String(text ?? '').split(/\r?\n/);
  let seen = -1;
  for (let n = 0; n < lines.length; n++) {
    if (lines[n].trim() === '') continue;
    seen++;
    if (seen !== idx) continue;
    const o = parseOptions(lines[n])[0];
    if (!o) return String(text ?? '');
    const head = String(o.value) === o.label ? o.label : `${o.label}=${o.value}`;
    const c = String(color || '').trim();
    lines[n] = c ? `${head}=${c}` : head;
    break;
  }
  return lines.join('\n');
}

/** 值 → 选中哪一项（按字符串比，兼容 1 与 '1'）*/
export function optionIndexByValue(options, value) {
  if (value === null || value === undefined) return -1;
  return options.findIndex(o => String(o.value) === String(value));
}

/**
 * 阈值这一格写的是"真 / 假"还是"0 / 1"（两种写法现场都在用）→ true / false；
 * 认不出来（空着、写了别的）给 null，交给调用方决定怎么办。
 */
export function boolOf(x) {
  if (x === true || x === 1) return true;
  if (x === false || x === 0) return false;
  const s = String(x ?? '').trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

/**
 * 状态比较（按钮状态显示 / 报警条件 / 脚本触发条件）：返回 true = 条件成立
 *   bool → 阈值写了 0/1（或 true/false）就**按 0/1 比**（`b急停 == 0` 就是"等于假"）；
 *          阈值空着或认不出来 → 老口径：bool 自己就是状态（true 成立）
 *   数值 → 按 op 与 threshold 比较；字符串 → 仅 == / != 等值比较
 *
 * ⚠ 现场踩过：以前 bool 是**直接返回它自己、根本不看阈值** —— 于是「bool 变量等于 0 时报警」
 *   这种完全正常的写法永远不成立（而"等于 1"看着像对的，其实是巧合）。
 *   默认阈值（新报警行给的是 `>= 1`）在两种口径下结果一致，所以老工程不受影响。
 */
export function compareVal(v, op, threshold) {
  if (typeof v === 'boolean') {
    const t = boolOf(threshold);
    if (t === null) return v;                      // 没写阈值 → 老口径：bool 自己就是状态
    const nv = v ? 1 : 0, nt = t ? 1 : 0;          // 写了 0/1 → 按 0/1 比（Modbus 里 bool 就是 0/1）
    switch (op) {
      case '==': return nv === nt;
      case '!=': return nv !== nt;
      case '>':  return nv > nt;
      case '<':  return nv < nt;
      case '>=': return nv >= nt;
      case '<=': return nv <= nt;
      default:   return nv === nt;
    }
  }
  const nv = parseFloat(v), nt = parseFloat(threshold);
  if (!Number.isNaN(nv) && !Number.isNaN(nt)) {
    switch (op) {
      case '==': return nv === nt;
      case '!=': return nv !== nt;
      case '>':  return nv > nt;
      case '<':  return nv < nt;
      case '>=': return nv >= nt;
      case '<=': return nv <= nt;
    }
  }
  const sv = String(v), st = String(threshold ?? '');
  if (op === '==') return sv === st;
  if (op === '!=') return sv !== st;
  return false;
}

/**
 * **条件判定**用的比较（控件属性「按条件启用」用：条件满足才让操作 / 才显示）。
 *   · bool 变量按**真假**比：`== true` / `== false` / `!= …`（阈值写 true/false、"1"/"0" 都认）
 *   · 数值按 op 比；字符串只认 == / !=
 *   · **取不到值（undefined/null）= 不满足** —— 读不到就别放行，宁可不给操作
 * ⚠ 和 compareVal 的区别（别合并，两处语义不同）：
 *   compareVal 是「状态显示 / 报警 / 脚本触发」那套（**阈值空着时** bool 自己就是状态）；
 *   这里是"拿阈值去比"，BOOL 也要比（`bAuto == false` 是完全正常的写法），
 *   且**读不到值一律不满足**（compareVal 那边取不到值由调用方先挡掉）。
 */
export function condMet(v, op, threshold) {
  if (v === undefined || v === null) return false;
  const o = op || '==';
  if (typeof v === 'boolean') {
    const t = boolOf(threshold) === true;      // 认不出来（含空着）当"假"比 —— 老口径不变
    return o === '!=' ? v !== t : v === t;
  }
  const nv = parseFloat(v), nt = parseFloat(threshold);
  if (!Number.isNaN(nv) && !Number.isNaN(nt)) {
    switch (o) {
      case '==': return nv === nt;
      case '!=': return nv !== nt;
      case '>':  return nv > nt;
      case '<':  return nv < nt;
      case '>=': return nv >= nt;
      case '<=': return nv <= nt;
    }
  }
  const sv = String(v), st = String(threshold ?? '');
  if (o === '==') return sv === st;
  if (o === '!=') return sv !== st;
  return false;
}

/* ══════════ 数值输入的范围限制（数值 / 数据输入控件）══════════
   现场用途：设定值不许越界写进 PLC —— 超范围时软键盘上的输入框变红、**一个字节都不下发**。

   数据模型（都存在控件 props 里，老工程缺键 = 不限制，行为一个字不变）：
     rangeOn       是否启用范围限制（不勾 = 这一整块不生效）
     rangeMinMode  'fixed' | 'var'  下限从哪来：写死的值 / 一个变量的运行值
     rangeMinValue 固定值（**存字符串**）
     rangeMinVar   变量名（用它的运行值当下限，现场就是"配方上下限由 PLC 下发"）
     rangeMaxMode / rangeMaxValue / rangeMaxVar  上限同此
   上下限各自独立：只填一端 = 只卡那一端（另一端不限）。

   为什么固定值存字符串而不是数字：空串必须能表示"这一端不限"。
   存数字的话清空输入框会变成 0 —— 把"不限"悄悄变成"下限 0"，现场就成了"负值输不进去"，
   而且看不出来是谁干的。 */

/** 这一端的限制（返回 null = 这一端不限）：
 *  { v: 数值, mode: 'fixed'|'var', src: 变量名（固定值时为空串）, unknown: 变量还没读到值 }
 *  @param getVar 取变量运行值的函数（(name) => number），编辑态没有运行值时传 undefined
 *
 *  ⚠ 变量型限制"还没读到值"（变量没在采集范围里 / 后端刚断开）时 v 是 null：
 *    这时候**不拦**（跟"没读到就当没有"一个口径），但键盘上会把 `变量名(?)` 明说出来 ——
 *    默默放行才是危险的：看着有范围限制、实际一个值都不拦，现场根本发现不了。 */
export function limitOf(props, side, getVar) {
  const p = props || {};
  if (p[`range${side}Mode`] === 'var') {
    const name = String(p[`range${side}Var`] ?? '').trim();
    if (!name) return null;                                  // 选了"变量"但还没选变量 = 这一端不限
    const n = Number(getVar ? getVar(name) : NaN);
    return Number.isFinite(n)
      ? { v: n, mode: 'var', src: name, unknown: false }
      : { v: null, mode: 'var', src: name, unknown: true };
  }
  const raw = String(p[`range${side}Value`] ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? { v: n, mode: 'fixed', src: '', unknown: false } : null;
}

/**
 * 控件当前生效的输入范围（不启用 / 两端都没填 → 返回 null）。
 * 返回 { min, max, lo, hi, text, tip, bad, unknown }：
 *   min/max  两端各自的来源（null = 这一端不限）—— 软键盘要显示"限制是多少、是哪个变量给的"
 *   lo/hi    夹到 ±Infinity 的实际边界，运行时用它判越界（值为空的变量端当 ±Infinity）
 *   text     键盘上那一行（如 `范围 0 ~ Hr_Max(120)`）
 *   bad      下限比上限还大（两个限制变量交叉了）—— 这种配置下**任何值都不合法**，得说出来
 *   unknown  有变量型限制没读到值（这时那一端不拦，但键盘上要标出来）
 */
export function inputRangeOf(props, getVar) {
  const p = props || {};
  if (!p.rangeOn) return null;
  const min = limitOf(p, 'Min', getVar);
  const max = limitOf(p, 'Max', getVar);
  if (!min && !max) return null;
  const lo = (min && min.v !== null) ? min.v : -Infinity;
  const hi = (max && max.v !== null) ? max.v : Infinity;
  const side = (l) => (l.mode === 'var' ? `${l.src}(${l.v === null ? '?' : fmtLimitNum(l.v)})` : fmtLimitNum(l.v));
  const text = !min ? `范围 ≤ ${side(max)}`
    : !max ? `范围 ≥ ${side(min)}`
    : `范围 ${side(min)} ~ ${side(max)}`;
  const bad = Number.isFinite(lo) && Number.isFinite(hi) && lo > hi;
  const unknown = !!(min?.unknown || max?.unknown);
  return { min, max, lo, hi, text, bad, unknown, tip: rangeTipOf(min, max, bad, unknown) };
}

/** 越界时那行提示（键盘上接着范围后面显示 / 悬停说明都用它） */
export function rangeTipOf(min, max, bad, unknown) {
  if (bad) return '下限比上限大（检查两个限制变量）—— 任何值都写不进去';
  const a = min && min.v !== null ? fmtLimitNum(min.v) : '', b = max && max.v !== null ? fmtLimitNum(max.v) : '';
  let s = '';
  if (min && max) s = `只能输入 ${a} ~ ${b} 之间的值`;
  else if (min) s = `只能输入不小于 ${a} 的值`;
  else if (max) s = `只能输入不大于 ${b} 的值`;
  const missing = [min, max].filter(l => l?.unknown).map(l => l.src);
  if (missing.length) s += `${s ? '；' : ''}${missing.join(' / ')} 的值还没读到，这一端暂时不拦`;
  return s;
}

/** 数值边界显示：留 6 位有效数字（浮点尾巴不上键盘），-0 显示成 0 */
export function fmtLimitNum(n) {
  if (!Number.isFinite(n)) return '';
  const s = String(Number(n.toPrecision(6)));
  return s === '-0' ? '0' : s;
}

/**
 * 键盘缓冲里那一串是不是一个"能判越界的数"。
 * '' / '-' / '.' / '-.' 这些**中间态**返回 null（还没输完，不能当场标红）；
 * 输入框里带前后空格的（现场粘贴进来的）也认。
 */
export function parseNumInput(s) {
  const t = String(s ?? '').trim();
  if (t === '' || t === '-' || t === '.' || t === '-.' || t === '+') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 这个值在范围内吗（范围为空 = 不限，永远算在范围内） */
export function inRange(n, r) {
  if (!r || n === null || n === undefined) return true;
  if (!Number.isFinite(n)) return true;
  return n >= r.lo && n <= r.hi;
}

/**
 * 时间格式化（报警时间用）：支持到毫秒
 *   YYYY 年  MM 月  DD 日  hh 时  mm 分  ss 秒  SSS 毫秒
 *   fmtTime(Date.now(), 'MM-DD hh:mm:ss.SSS') → '05-12 14:03:07.482'
 */
const TIME_TOK = {
  YYYY: (d) => String(d.getFullYear()),
  MM: (d) => String(d.getMonth() + 1).padStart(2, '0'),
  DD: (d) => String(d.getDate()).padStart(2, '0'),
  hh: (d) => String(d.getHours()).padStart(2, '0'),
  mm: (d) => String(d.getMinutes()).padStart(2, '0'),
  ss: (d) => String(d.getSeconds()).padStart(2, '0'),
  SSS: (d) => String(d.getMilliseconds()).padStart(3, '0'),
};
export const TIME_PRESETS = [
  { v: 'hh:mm:ss', t: '时:分:秒' },
  { v: 'hh:mm:ss.SSS', t: '时:分:秒.毫秒' },
  { v: 'MM-DD hh:mm:ss', t: '月-日 时:分:秒' },
  { v: 'MM-DD hh:mm:ss.SSS', t: '月-日 时:分:秒.毫秒' },
  { v: 'YYYY-MM-DD hh:mm:ss', t: '年月日 时:分:秒' },
  { v: 'YYYY-MM-DD hh:mm:ss.SSS', t: '年月日 时:分:秒.毫秒' },
  { v: 'custom', t: '自定义…' },
];
export function fmtTime(ts, fmt = 'hh:mm:ss.SSS') {
  const n = Number(ts);
  const d = new Date(Number.isFinite(n) && n > 0 ? n : Date.now());
  return String(fmt || 'hh:mm:ss.SSS').replace(/YYYY|MM|DD|hh|mm|ss|SSS/g, (m) => TIME_TOK[m](d));
}
/** 某天 0 点的时间戳（按本地时区） */
export function dayStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 日期显示 YYYY-MM-DD */
export const fmtDate = (ts) => fmtTime(ts, 'YYYY-MM-DD');

/** debounce */
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** 把 #rrggbb 转成 'rgba(r,g,b,a)' */
export function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 驼峰 → 中文标签 */
export function keyLabel(key) {
  const map = {
    x: 'X', y: 'Y', w: '宽', h: '高', z: '层级', name: '名称', text: '文本',
    fontSize: '字号', textColor: '文字色', bgColor: '背景色', borderColor: '边框色',
    borderWidth: '边框宽', radius: '圆角', unit: '单位', fmt: '格式', align: '对齐',
    onColor: '点亮色', offColor: '熄灭色', src: '图片地址', value: '初值',
    address: 'PLC 地址', type: '类型', popupW: '弹窗宽', popupH: '弹窗高', bold: '加粗',
  };
  return map[key] || key;
}


/**
 * 变量下拉的 <option> 片段：**有上限**。
 *
 * 为什么不能全塞进去：变量能到上万个，把 1 万个 option 建出来要 1.4 秒（实测），
 * 建一次就卡一秒多。这里只放「当前选中的 + 前 cap 个」，其余交给搜索框按关键字重建
 * （见 alarmsPanel.js 报警弹窗里的 data-vsearch）。
 * ⚠ 属性面板 / 脚本面板**已经不用它了**：那边改成 `<input list>` + 全量 datalist
 *   （见下面 ensureVarList）—— 输入框本身就是搜索框，中文名也选得到。
 *
 * @param {Array<{name:string,type?:string,address?:string}>} vars 候选变量（调用方先按类型过滤）
 * @param {{selected?:string, cap?:number, emptyLabel?:string, disabled?:Set<string>, note?:function, all?:Array}} [opt]
 *   disabled：这些变量名要置灰（波形通道里「已被别的通道占用」）
 *   note：给某个变量名补一句说明（如「（已在通道2）」）
 *   all：**未过滤**的完整变量表。当前选中的那个若被类型过滤掉了，从这里补回下拉里
 *        （否则 <select> 没有匹配项 → 面板显示「（未绑定）」，
 *         明明是绑好的控件却看着像没绑，用户以为「这个变量选不了/切不了」）
 */
export function varOptionsHtml(vars, opt = {}) {
  const list = vars || [];
  const cap = Math.max(1, opt.cap || 50);
  const selected = opt.selected || '';
  const pick = [];
  const inList = list.find(v => v.name === selected);
  const sel = inList || (opt.all || []).find(v => v.name === selected);
  const mismatch = !!sel && !inList;      // 当前绑定不在候选里（类型对不上，多半是老工程/数组）
  if (sel) pick.push(sel);
  for (const v of list) {
    if (pick.length >= cap) break;
    if (v.name !== selected) pick.push(v);
  }
  const head = opt.emptyLabel === null ? '' : `<option value="">${escapeHtml(opt.emptyLabel ?? '（未绑定）')}</option>`;
  return head + pick.map(v => {
    const dis = opt.disabled && opt.disabled.has(v.name) ? ' disabled' : '';
    const note = opt.note ? opt.note(v.name) : '';
    // 补回来的那个要说清为什么不在正常候选里 —— 不然用户不知道为什么它孤零零一个
    const warn = (mismatch && v.name === selected) ? '（类型与控件不匹配）' : '';
    return `<option value="${escapeHtml(v.name)}"${v.name === selected ? ' selected' : ''}${dis}>`
      + `${escapeHtml(v.name)}${escapeHtml(note)}${escapeHtml(warn)}</option>`;
  }).join('');
}

/* ═══════════ 变量名的「输入即检索」候选表 ═══════════
 * 现在的做法见 js/editor/varPick.js：输入框 + 自己画的候选表（按 名称/地址/类型 过滤）。
 * 为什么不用原生 <datalist>：候选弹层是浏览器自己的原生素件 —— 长相控制不了，
 * 过滤规则也由它定（按地址/类型搜不一定生效），自动化里还**测不到**（拍不到那张弹层）。
 */

/**
 * 状态栏里临时说一句（比如「本机浏览器里没有工程，已自动从服务器读回…」）。
 * 为什么不用 alert：这句话多半出现在**每次启动**（PyWebView 每次都像新浏览器），
 * 弹窗每回都要点一下才烦人；状态栏说一句、过几秒自己收掉刚好。
 */
let _noteTimer = null;
export function statusNote(text, ms = 8000) {
  const el = typeof document === 'undefined' ? null : document.getElementById('stNote');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
  if (_noteTimer) { clearTimeout(_noteTimer); _noteTimer = null; }
  if (text) _noteTimer = setTimeout(() => { el.classList.add('hidden'); _noteTimer = null; }, ms);
}
