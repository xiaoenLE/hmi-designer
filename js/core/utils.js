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

/** 地址归一化：HR100 → %MW100；100 → %MW100；%mw100 → %MW100。认不出的原样返回 */
export function normAddr(addr) {
  const s = String(addr ?? '').trim().replace(/\s+/g, '');
  if (!s) return '';
  // OPC UA 的 NodeId 不走下面那套（去空格 + 转 %MW）：去空格会把 CODESYS 符号改坏
  if (isOpcAddr(addr)) return String(addr ?? '').trim();
  const up = s.toUpperCase();
  let m;
  if ((m = /^(?:HR|4X)(\d+)$/.exec(up))) return `%MW${Number(m[1])}`;   // 4x0101 → %MW101（后端同样按偏移 101 解析）
  if (/^\d+$/.test(up)) {
    const n = Number(up);
    if (n >= 40001 && n <= 49999) return up;      // 标准 4x 写法：后端按 40001→偏移 0，别自作主张改
    return `%MW${n}`;
  }
  if ((m = /^%(MW|QW|MD|MB|MX|IX|IW|QX)(\d+(?:\.\d+)?)$/.exec(up))) return `%${m[1]}${m[2]}`;
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

/** 是不是位地址（bool 该用这种）：%MX195.0 / %QX0 / %IX5 / %MX0 */
export function isBitAddr(addr) {
  const s = String(addr ?? '').trim().toUpperCase();
  return /^%M?[QI]?X\d+(\.\d)?$/.test(s) || /^%M?X\d+\.\d$/.test(s);
}

/**
 * 地址 + 偏移（多重复制时按间隔往后/往前排）：%MW100 + 2 → %MW102；%MW100 + (-2) → %MW98
 * · 数字位数保持原样（%MW0100 + 2 → %MW0102）
 * · 位地址 %MX0.0 按**位**往后排（+1 → %MX0.1，%MX0.7 +1 → %MX1.0）；%QX5/%IX5 这种本来就是位号
 * · %MD50 是「第 50 个双字」→ 挪 2 个字才算 +1 个 %MD（挪奇数个字没法用 %MD 表示 → 返回 ''）
 * · %MB194 是字节地址 → 挪 1 个字 = 挪 2 个字节
 * · 认不出的写法（DB1.DBD4）→ 返回 ''（宁可不猜，让用户手填）
 */
export function bumpAddr(addr, words) {
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
 * 组：1 = 点写法的名字 · 2 = 引号 · 3 = 方括号写法的名字。
 * ⚠ 只能当**工厂**用（带 g 的正则有 lastIndex 状态）：扫描引用、改名替换两边各取一个新实例，
 *   否则一边 exec 到一半、另一边从中间接着匹配，会漏。
 * ⚠ 别把 `hmi.vars()` 也吃进来：点写法要求 `v` 后面**紧跟一个点**，`hmi.vars` 不满足。
 */
export const scriptVarPropRe = () =>
  /\bhmi\s*\.\s*v\s*\.\s*([\p{L}\p{N}_$]+)|\bhmi\s*\.\s*v\s*\[\s*(['"])([^'"]+)\2\s*\]/gu;

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
  if (t === 'int' || t === 'uint' || t === 'dint' || t === 'udint') return '%d';
  if (t === 'float' || t === 'real' || t === 'lreal') {
    return '%.' + Math.max(0, Math.min(6, Math.round(p.decimals ?? 1))) + 'f';
  }
  return p.fmt || '%.1f';
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
 * 状态比较（按钮状态显示用）：返回 true = 「开」状态
 *   bool → 直接真假；数值 → 按 op 与 threshold 比较；字符串 → 仅 == / != 等值比较
 */
export function compareVal(v, op, threshold) {
  if (typeof v === 'boolean') return v;
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
