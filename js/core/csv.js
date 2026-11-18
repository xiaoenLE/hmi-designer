/**
 * csv.js — 变量表 / 报警表 / 脚本表 CSV 导入/导出（与 Excel 互通）
 *
 * 变量表：名称,类型,地址,长度,初始值,保持（首行表头可有可无，自动识别；
 *   「保持」= **HMI 内部掉电保持**，只对地址留空的内部变量有意义：写 是/1/true/Y 都算勾上）
 * 报警表：名称,变量,比较,阈值,延时s,级别,内容,启用
 * 脚本表：名称,触发,时间ms,变量,比较,阈值,启用,代码
 *   · 导出带 UTF-8 BOM + CRLF，Excel 直接打开中文不乱码
 *   · 导入按「名称」upsert：同名更新，不存在的新增（报警/脚本还能整表替换/追加）
 *   · 非法行/空名行跳过并回报原因
 */
import { project } from './project.js';
import { genId, normAddr, isArrayType, elemTypeOf, parseArrayText, statusNote } from './utils.js';

// 标量 9 种（含 wstring）+ 数组 9 种（数组：初值写 `1 2 3`，长度列 = 元素个数）
export const VAR_TYPES = ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string', 'wstring',
  'bool[]', 'int[]', 'uint[]', 'dint[]', 'udint[]', 'real[]', 'lreal[]', 'string[]', 'wstring[]'];
const HEADER = ['名称', '类型', '地址', '长度', '初始值', '保持'];

/** 浏览器里下载一段文本（Blob + 游离锚点在 Chromium 下不可靠，必须挂进 DOM） */
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/** 是不是"原生窗口客户端"（PyWebView：打包的 exe / start_hmi_window.bat） */
export function inDesktopShell() {
  const api = globalThis.pywebview?.api;
  return !!(api && typeof api.save_text === 'function');
}

/** 保存框的过滤器（Chrome/Edge 的 showSaveFilePicker 要这种结构） */
function pickerTypes(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'csv') return [{ description: 'CSV 表格', accept: { 'text/csv': ['.csv'] } }];
  if (ext === 'json') return [{ description: 'JSON 文件', accept: { 'application/json': ['.json'] } }];
  return undefined;
}

/**
 * 现在这一下是"用户刚点的"吗。
 * ⚠ Chromium 的 showSaveFilePicker **要在用户手势里调**：脚本里直接调（没有手势）时它会当场拒
 *   （AbortError/SecurityError）—— 看起来就跟"用户点了取消"一模一样。所以没有手势就干脆不试它，
 *   直接走下面的下载兜底（从菜单/脚本里触发的导出就属于这种）。
 *   （`userActivation` 认不出来的环境照旧试一次。）
 */
function inUserGesture() {
  const ua = globalThis.navigator?.userActivation;
  return ua ? ua.isActive === true : true;
}

/**
 * 导出一段文本：**弹「另存为」框让用户自己选存哪儿**（桌面窗口和浏览器都一样）。
 *
 * 两条弹框路，按环境选：
 *   ① 桌面窗口（PyWebView / 打包的 exe）：`window.pywebview.api.save_text` → Python 弹原生保存框。
 *      为什么不用网页那套下载：exe 里 `<a download>` **没有宿主处理**（没人接 WebView2 的
 *      DownloadStarting）→ 下载被就地取消：不弹框、不报错、文件一个字节都不落盘
 *      （实测：exe 那个 webview profile 的下载库里 state=2「已取消」、target_path 全空）。
 *   ② 浏览器 / WebView2 页面：`showSaveFilePicker`（系统保存框）。
 *      ⚠ 要**安全上下文**：`http://127.0.0.1`、`http://localhost`、`https://` 才有；
 *        用局域网 IP（http://192.168.x.x）或 Firefox 时它不存在 → 自动退回下面的下载。
 *      ⚠ 必须在**用户手势**里调：本函数从点击事件那条链上同步进来（前面没有 await），
 *        所以这里能弹；真被浏览器拒了（NotAllowedError 之类）也退回下载，不让用户白点。
 *
 * @returns {{ok:boolean, path?:string, cancelled?:boolean, download?:boolean, fallback?:boolean, error?:string}}
 *   ok+path    = 已经写好了（浏览器只知道**文件名**，拿不到完整路径；桌面版给的是完整路径）
 *   ok+download= 走了浏览器下载（老浏览器/局域网 IP 的老行为）
 *   cancelled  = 用户在保存框里点了取消（什么都不做）
 */
export async function saveTextFile(filename, text, opts = {}) {
  // ① 桌面窗口：Python 那条（实测能弹出、能拿到完整路径）
  if (inDesktopShell()) {
    try {
      const r = await globalThis.pywebview.api.save_text(filename, text, opts.kind || '', opts.path || '');
      if (r && r.ok && r.path) return { ok: true, path: r.path, fallback: !!r.fallback };
      if (r && r.cancelled) return { ok: false, cancelled: true };
      if (r && r.error) return { ok: false, error: String(r.error) };
      // 桌面 API 回了看不懂的东西 → 往下走浏览器下载（至少不静默什么都不做）
    } catch (e) {
      // 桌面接口本身炸了（不是"用户取消"）→ 也退回下载：宁可多落一份，也别让用户点了没反应
      console.warn('[export] 桌面保存接口出错，改为浏览器下载：', e);
    }
  } else if (typeof globalThis.showSaveFilePicker === 'function' && inUserGesture()) {
    // ② 浏览器：系统保存框（用户自己选目录）
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: filename, types: pickerTypes(filename),
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { ok: true, path: handle.name || filename };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, cancelled: true };   // 用户点了取消
      // 弹不出来（权限/手势丢了/浏览器不让）→ 退回下载，别让"导出"变成点了没反应
      console.warn('[export] 系统保存框没弹成，退回浏览器下载：', e);
    }
  }
  downloadText(filename, text);
  return { ok: true, download: true };
}

/**
 * 导出 + 给用户一句人话（导到哪儿了）。**各面板的导出按钮都走这一个**：
 * 弹保存框（桌面走原生框、浏览器走系统框）→ 拿不到就退回下载；取消时不打扰，失败时说清原因。
 */
export async function exportText(filename, text, opts = {}) {
  const r = await saveTextFile(filename, text, opts);
  if (r.cancelled) return r;                                   // 用户自己取消的：别刷提示
  if (r.ok && r.path) {
    // 桌面版给的是完整路径；浏览器只给文件名（File System Access 故意不暴露目录）
    const where = /[\\/]/.test(r.path) ? r.path : `${r.path}（存到你选的位置）`;
    statusNote(`已导出：${where}${r.fallback ? '（保存框没弹出，已放到「下载」文件夹）' : ''}`, 9000);
  } else if (r.ok) statusNote(`已导出（浏览器「下载」文件夹）：${filename}`, 7000);
  else if (r.error) statusNote(`导出失败：${r.error}`, 9000);
  return r;
}


/** 初值按类型规整（与变量面板手动输入同一套语义） */
export function castValue(raw, type) {
  if (isArrayType(type)) return parseArrayText(raw, elemTypeOf(type));   // 数组初值：1,2,3
  if (type === 'wstring') return String(raw ?? '');
  if (type === 'bool') return raw === 'true' || raw === '1' || raw === true || raw === 1;
  if (type === 'uint' || type === 'udint') return Math.max(0, parseInt(raw, 10) || 0);
  if (type === 'int' || type === 'dint') return Math.round(parseFloat(raw) || 0);
  if (type === 'real' || type === 'lreal') return parseFloat(raw) || 0;
  return String(raw ?? '');
}

/** 变量表 → CSV 文本（含 BOM）。第 4 列「长度」：string=字符数、数组=元素个数，其它类型留空 */
export function varsToCsv(vars) {
  const cell = (c) => {
    c = String(c ?? '');
    return /[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
  };
  const lines = [HEADER.join(',')];
  (vars || []).forEach(v => {
    const len = (v.type === 'string' || v.type === 'wstring' || isArrayType(v.type)) ? (v.len || 10) : '';
    const val = Array.isArray(v.value) ? v.value.join(' ') : v.value;   // 数组用空格分隔，CSV 里不用加引号
    // 「保持」列：只有勾上的才写「是」（没勾留空 —— 否则几百条 Modbus 变量全是"否"，看着累）
    lines.push([v.name, v.type, v.address || '', len, val, v.retain ? '是' : ''].map(cell).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

/** CSV 里「保持」列的写法 → 布尔（是/1/true/y/√/勾 都算；空 = 不保持） */
const truthy = (s) => /^(是|1|true|y|yes|√|✓|on)$/i.test(String(s ?? '').trim());

/* ── 文件 → 文本：编码自动识别 ──────────────────────────────────────
   Excel 在中文 Windows 上「另存为 CSV」默认存的是 **GBK/ANSI**，
   直接按 UTF-8 读会把中文读成乱码（张三 → 寮犱笁 这种）。
   这里按 BOM → UTF-8 → GB18030/GBK/Big5 的顺序试，谁都解不出替换字符就用它。 */

/** ArrayBuffer → 文本（自动认 UTF-8 / UTF-16 / GBK） */
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  const bom = (a, b) => u8.length > 1 && u8[0] === a && u8[1] === b;
  if (bom(0xFF, 0xFE)) return new TextDecoder('utf-16le').decode(u8);
  if (bom(0xFE, 0xFF)) return new TextDecoder('utf-16be').decode(u8);
  const utf8 = new TextDecoder('utf-8').decode(u8);          // 带 BOM 会自动吃掉 BOM
  if (!utf8.includes('\uFFFD')) return utf8;                 // 干净解出来 = 就是 UTF-8
  for (const enc of ['gb18030', 'gbk', 'big5']) {
    try {
      const t = new TextDecoder(enc).decode(u8);
      if (!t.includes('\uFFFD')) return t;
    } catch { /* 浏览器不认这个编码，换下一个 */ }
  }
  return utf8;                                               // 都失败就按 UTF-8 交出去（至少有内容）
}

/** 读本地文件为文本（Promise）。导入 CSV 一律走这个，别直接 readAsText(utf-8)。 */
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(decodeText(fr.result));
    fr.readAsArrayBuffer(file);
  });
}

/** CSV 文本 → 行数组（支持引号转义、逗号/换行内嵌；自动去 BOM、过滤全空行） */
export function parseCsv(text) {  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }   // "" → "
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/**
 * 导入 CSV 到工程变量表（upsert by 名称）
 * @returns {{added:number, updated:number, errors:string[]}}
 */
export function importCsv(text) {
  const rows = parseCsv(text);
  const errors = [];
  let added = 0, updated = 0;
  const vars = project.variables();
  rows.forEach((r, idx) => {
    // 首行是表头则跳过（容忍英文表头）
    if (idx === 0 && r.some(c => HEADER.includes(c.trim()) || /^(name|type|address|len|length|value)$/i.test(c.trim()))) return;
    const name = String(r[0] || '').trim();
    const type = String(r[1] || 'real').trim();
    // 地址统一成 %MW 写法（HR100 / 100 → %MW100）；认不出的（DB1.DBD4、4x_Bit100.0）原样留着
    const address = normAddr(String(r[2] || '').trim());
    if (!name) { errors.push(`第${idx + 1}行：名称为空`); return; }
    if (!VAR_TYPES.includes(type)) { errors.push(`第${idx + 1}行「${name}」：类型 ${type || '(空)'} 不合法`); return; }
    // 长度列：string = 字符数，数组 = 元素个数。
    // 老文件是 4 列（名称,类型,地址,初值）→ 第 4 列是初值；新文件 5 列 → 第 4 列是长度。
    const isNew = r.length >= 5;
    const lenRaw = isNew ? String(r[3] ?? '').trim() : '';
    const len = (type === 'string' || type === 'wstring')
      ? Math.min(250, Math.max(1, parseInt(lenRaw, 10) || 10))
      : isArrayType(type) ? Math.min(4096, Math.max(1, parseInt(lenRaw, 10) || 10))
        : 0;
    const valueRaw = isNew ? r[4] : r[3];       // 第 5 列（新）/ 第 4 列（老）= 初值
    const value = castValue(valueRaw, type);
    // 第 6 列「保持」：HMI 内部掉电保持（只有地址留空的内部变量才有意义 → 有地址就忽略）
    const retain = r.length >= 6 && !address && truthy(r[5]);
    const exist = vars.find(v => v.name === name);
    if (exist) {
      Object.assign(exist, { type, address, len, value });
      if (retain) exist.retain = true; else delete exist.retain;
      updated++;
    } else {
      const nv = { name, type, address, len, value };
      if (retain) nv.retain = true;
      vars.push(nv); added++;
    }
  });
  if (added || updated) project.commit('CSV 导入变量');   // 整批一次提交，不灌爆历史
  return { added, updated, errors };
}

/* ══ 报警表 CSV ══════════════════════════════════════════════════════
   列：名称,变量,比较,阈值,延时s,级别,内容,启用

   「内容」经常带逗号、括号、换行 → 导出统一按 RFC4180 加引号转义，
   Excel / WPS / 记事本都能原样读回来（多行内容也不会串行）。
   级别写中文（提示/警告/报警/紧急）或英文键（info/warn/alarm/urgent）都认；
   启用写 是/否（1/0、true/false、Y/N、空 也认，空 = 启用）。
   ───────────────────────────────────────────────────────────────── */
export const ALARM_HEADER = ['名称', '变量', '比较', '阈值', '延时s', '级别', '内容', '启用'];

/** 兜底级别表（面板传 ALARM_LEVELS 进来，保持单一来源；这里只为直接调用时不炸） */
const LEVEL_FALLBACK = [
  { v: 'info', t: '提示' }, { v: 'warn', t: '警告' },
  { v: 'alarm', t: '报警' }, { v: 'urgent', t: '紧急' },
];

/** 报警表 → CSV 文本（含 BOM + CRLF） */
export function alarmsToCsv(alarms, levels) {
  const lv = (levels && levels.length) ? levels : LEVEL_FALLBACK;
  const cell = (c) => {
    c = String(c ?? '');
    return /[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
  };
  const levelText = (v) => (lv.find(l => l.v === (v || 'alarm')) || lv[2] || { t: '报警' }).t;
  const lines = [ALARM_HEADER.join(',')];
  (alarms || []).forEach(a => lines.push([
    a.name, a.variable, a.op || '>=', a.value, Number(a.delaySec) || 0,
    levelText(a.level), a.text, a.enabled === false ? '否' : '是',
  ].map(cell).join(',')));
  return '\uFEFF' + lines.join('\r\n');
}

/** 比较符：中文/全角/Excel 里手写的各种写法都归一化 */
const OP_ALIAS = {
  '>=': '>=', '≥': '>=', '＞=': '>=', '=>': '>=', '≧': '>=',
  '<=': '<=', '≤': '<=', '＜=': '<=', '=<': '<=', '≦': '<=',
  '>': '>', '＞': '>', '<': '<', '＜': '<',
  '==': '==', '=': '==', '＝': '==', 'eq': '==',
  '!=': '!=', '≠': '!=', '<>': '!=', 'ne': '!=',
};
export function normOp(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return '>=';
  return OP_ALIAS[s] || null;
}

/** 级别：中文名 / 英文键 / 数字都认 */
export function parseLevel(raw, levels) {
  const lv = (levels && levels.length) ? levels : LEVEL_FALLBACK;
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'alarm';
  const hit = lv.find(l => l.v.toLowerCase() === s || String(l.t).toLowerCase() === s);
  return hit ? hit.v : null;
}

const FALSE_WORDS = ['否', '0', 'false', 'no', 'n', 'off', '停用', '禁用', '关闭', '不启用', '×', 'x'];
function parseEnabled(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return true;                       // 留空 = 启用
  return !FALSE_WORDS.includes(s);
}

/**
 * 报警 CSV → 工程报警表
 * @param {string} text CSV 文本
 * @param {{mode?:'upsert'|'replace'|'append', levels?:Array, variables?:string[]}} [opt]
 *   upsert（默认）= 同名更新、新名称追加；replace = 清空后导入；append = 全部当新报警
 * @returns {{added:number, updated:number, total:number, errors:string[], warnings:string[]}}
 */
export function importAlarmsCsv(text, opt = {}) {
  const mode = opt.mode || 'upsert';
  const levels = opt.levels && opt.levels.length ? opt.levels : LEVEL_FALLBACK;
  // ⚠ 变量上万、报警上千时不能用数组 includes / find：那是 O(行数×条数)，
  //   2000 行导入要 3.3 秒（实测）。查表用 Set/Map。
  const varNames = new Set(opt.variables || project.variables().map(v => v.name));
  const rows = parseCsv(text);
  const errors = [], warnings = [];
  const parsed = [];

  rows.forEach((r, idx) => {
    // 首行是表头就跳过（报警/变量两套表头都容忍，防止把变量表贴进来）
    if (idx === 0 && r.some(c => ALARM_HEADER.includes(String(c).trim())
      || HEADER.includes(String(c).trim())
      || /^(name|variable|var|op|compare|value|threshold|level|text|message|content|enabled|delay)$/i.test(String(c).trim()))) return;
    const at = `第${idx + 1}行`;
    const op = normOp(r[2]);
    if (op === null) { errors.push(`${at}：比较符「${String(r[2] ?? '').trim()}」不合法（可用 >= > <= < == !=）`); return; }
    const level = parseLevel(r[5], levels);
    if (level === null) { errors.push(`${at}：级别「${String(r[5] ?? '').trim()}」不合法（可用 ${levels.map(l => l.t).join('/')}）`); return; }
    const valueRaw = String(r[3] ?? '').trim();
    const text_ = String(r[6] ?? '');
    const variable = String(r[1] ?? '').trim();
    const name = String(r[0] ?? '').trim() || `报警${parsed.length + 1}`;
    if (!variable) warnings.push(`${at}「${name}」：没填变量，这条永远不会触发`);
    else if (!varNames.has(variable)) warnings.push(`${at}「${name}」：变量 ${variable} 不在变量表里（先去变量面板补上）`);
    if (valueRaw === '') warnings.push(`${at}「${name}」：阈值为空，按 0 处理`);
    if (valueRaw !== '' && Number.isNaN(Number(valueRaw)) && (op === '>' || op === '>=' || op === '<' || op === '<=')) {
      warnings.push(`${at}「${name}」：阈值「${valueRaw}」不是数字，大小比较只对数值变量有意义`);
    }
    parsed.push({
      name, variable, op,
      value: valueRaw !== '' && !Number.isNaN(Number(valueRaw)) ? Number(valueRaw) : valueRaw,
      delaySec: Math.max(0, Math.min(600, Math.round(Number(String(r[4] ?? '').trim()) || 0))),
      level, text: text_, enabled: parseEnabled(r[7]),
    });
  });

  const list = project.alarms();
  if (mode === 'replace') list.length = 0;
  // 同名更新：先建一张「名称 → 报警」表，别每行都从头 find 一遍（2000×2000 次要 3 秒）
  const byName = new Map(list.map(a => [a.name, a]));
  let added = 0, updated = 0;
  parsed.forEach(p => {
    const exist = mode === 'append' ? null : byName.get(p.name);
    if (exist) { Object.assign(exist, p); updated++; }
    else {
      const fresh = { id: genId('al'), ...p };
      list.push(fresh);
      byName.set(p.name, fresh);      // 同一批里重名的行：后面的更新前面的，不再重复追加
      added++;
    }
  });
  if (added || updated || mode === 'replace') project.commit('CSV 导入报警');   // 整批一次提交
  return { added, updated, total: parsed.length, errors, warnings };
}

/* ────────────────────────── 脚本：CSV 导入 / 导出 ──────────────────────────
   列：名称,触发,时间ms,变量,比较,阈值,启用,代码
   · 触发写中文（进运行态一次 / 定时 / 循环 / 变量变化 / 条件成立）或英文键（init/interval/cycle/change/cond）都认
   · **代码那一格**里逗号、换行、引号都能原样进出（RFC4180 转义，跟报警「内容」一个路子）——
     所以脚本可以整体在 Excel/记事本里批量写好、一次性导进来
   ───────────────────────────────────────────────────────────────── */
export const SCRIPT_HEADER = ['名称', '触发', '时间ms', '变量', '比较', '阈值', '启用', '代码'];
export const TRIG_TEXT = {
  init: '进运行态一次', interval: '定时', cycle: '循环', change: '变量变化', cond: '条件成立',
};
/** 触发方式的各种写法 → 英文键（认不出返回 null，让导入那行报错跳过） */
const TRIG_ALIAS = {
  init: 'init', '进运行态一次': 'init', '进运行态时一次': 'init', '运行一次': 'init', '初始化': 'init', once: 'init', start: 'init',
  interval: 'interval', '定时': 'interval', '定时器': 'interval', '周期': 'interval', timer: 'interval',
  cycle: 'cycle', '循环': 'cycle', '每周期': 'cycle', '每个周期': 'cycle',
  change: 'change', '变量变化': 'change', '变化': 'change', '变量变化时': 'change',
  cond: 'cond', '条件': 'cond', '条件成立': 'cond', '变量条件成立': 'cond', '上升沿': 'cond',
};
export function normTrig(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return 'init';                       // 留空 = 进运行态一次（最不容易出事的那个）
  return TRIG_ALIAS[s] || null;
}

/** 脚本表 → CSV 文本（含 BOM + CRLF） */
export function scriptsToCsv(scripts) {
  const cell = (c) => {
    c = String(c ?? '');
    return /[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
  };
  const lines = [SCRIPT_HEADER.join(',')];
  (scripts || []).forEach(s => lines.push([
    s.name, TRIG_TEXT[s.trig] || s.trig || '进运行态一次', Math.max(10, Math.round(+s.ms || 1000)),
    s.variable || '', s.op || '==', s.value ?? '', s.enabled === false ? '否' : '是', s.code || '',
  ].map(cell).join(',')));
  return '\uFEFF' + lines.join('\r\n');
}

/** 代码能不能编译（只编译不执行；编译不过只提醒、不拦 —— 运行态会把它记进脚本日志） */
function codeCompiles(code) {
  if (!String(code || '').trim()) return true;
  try { new Function(String(code)); return true; } catch { return false; }
}

/**
 * 脚本 CSV → 工程脚本表
 * @param {string} text CSV 文本
 * @param {{mode?:'upsert'|'replace'|'append', variables?:string[]}} [opt]
 *   upsert（默认）= 同名更新、新名称追加；replace = 清空后导入；append = 全部当新脚本
 * @returns {{added:number, updated:number, total:number, errors:string[], warnings:string[]}}
 */
export function importScriptsCsv(text, opt = {}) {
  const mode = opt.mode || 'upsert';
  const varNames = new Set(opt.variables || project.variables().map(v => v.name));
  const rows = parseCsv(text);
  const errors = [], warnings = [];
  const parsed = [];

  rows.forEach((r, idx) => {
    // 首行是表头就跳过（英文列名也认，防止把别处的表贴进来）
    if (idx === 0 && r.some(c => SCRIPT_HEADER.includes(String(c).trim())
      || /^(name|trig|trigger|ms|interval|variable|var|op|compare|value|enabled|code)$/i.test(String(c).trim()))) return;
    const at = `第${idx + 1}行`;
    const trig = normTrig(r[1]);
    if (trig === null) {
      errors.push(`${at}：触发方式「${String(r[1] ?? '').trim()}」不合法（可用 ${Object.keys(TRIG_TEXT).map(k => TRIG_TEXT[k]).join('/')}）`);
      return;
    }
    const op = normOp(r[4]);
    if (trig === 'cond' && op === null) {
      errors.push(`${at}：比较符「${String(r[4] ?? '').trim()}」不合法（可用 >= > <= < == !=）`);
      return;
    }
    const name = String(r[0] ?? '').trim() || `脚本${parsed.length + 1}`;
    const variable = String(r[3] ?? '').trim();
    if ((trig === 'change' || trig === 'cond') && !variable) warnings.push(`${at}「${name}」：${TRIG_TEXT[trig]}得选一个变量，现在没填（不会触发）`);
    else if (variable && !varNames.has(variable)) warnings.push(`${at}「${name}」：变量 ${variable} 不在变量表里（先去变量面板补上）`);
    const code = String(r[7] ?? '');
    if (!code.trim()) warnings.push(`${at}「${name}」：代码是空的（跑起来什么都不做）`);
    else if (!codeCompiles(code)) warnings.push(`${at}「${name}」：代码有语法错误，运行时会在脚本日志里报错`);
    const valueRaw = String(r[5] ?? '').trim();
    parsed.push({
      name, trig, ms: Math.max(10, Math.min(3600000, Math.round(Number(String(r[2] ?? '').trim()) || 1000))),
      variable, op: op || '==',
      value: valueRaw !== '' && !Number.isNaN(Number(valueRaw)) ? Number(valueRaw) : valueRaw,
      enabled: parseEnabled(r[6]), code,
    });
  });

  const list = project.scripts();
  if (mode === 'replace') list.length = 0;
  const byName = new Map(list.map(s => [s.name, s]));
  let added = 0, updated = 0;
  parsed.forEach(p => {
    const exist = mode === 'append' ? null : byName.get(p.name);
    if (exist) { Object.assign(exist, p); updated++; }
    else {
      const fresh = { id: genId('sc'), ...p };
      list.push(fresh);
      byName.set(p.name, fresh);      // 同一批里重名的行：后面的更新前面的，不再重复追加
      added++;
    }
  });
  if (added || updated || mode === 'replace') project.commit('CSV 导入脚本');   // 整批一次提交
  return { added, updated, total: parsed.length, errors, warnings };
}
