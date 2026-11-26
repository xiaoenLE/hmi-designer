/**
 * shift.js — 班次产量 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 用途（现场「班次功能」）：显示总产量计数，并统计**本班**产量、OK/NG，以及**每小时产出**。
 *   · binding.variable = 总产量计数（必办/数值）；props 里还能填 OK / NG / 重置变量名（都是可选的）。
 *   · 班次从每天的 `shiftStart` 开始，末班到次日第一班开始时结束。
 *   · 总产量保留计数器原值，本班数字累加计数器的正向变化。班中计数器清零后可接着统计。
 *   · 每小时计数：运行态每秒（refreshMs）采样一次总产量，把增量记到当前小时 key；
 *     维护最近 `hourlyRows` 小时（最新在上），本小时标「进行中」。
 *   · resetVar 上升沿：把基线设为当前值、清每小时表（只清"本班统计"，不动 PLC 计数器）。
 *   · **历史班次**：本地按天记录每班的累计值（localStorage；key 见 `shiftHistoryKey(w)`），
 *     标题下历史条选日期 → 列出那天开始的班次（当前班也在列表里、实时更新）→ 点某班把
 *     主数据行/每小时表切成那班数据（标题旁标「历史」，不跟实时刷新）；「回到本班」回实时。
 *     保留 `historyDays` 天；写盘节流（≥5s 或页面隐藏/卸载时补写）。
 *   · 运行态状态放**模块级 Map**（widgetId → state），不写进 w.props；定时器在控件离开文档 /
 *     退出运行态（runtimeRoot 隐藏）时自己清掉。
 *   · 给 el 挂 `el.__shiftState()` 测试钩子（班次窗口/总产量/OK/NG/每小时表/基线 + view/histDate/histShifts）。
 *   · 样式全部内联，不改公共 CSS；文字走 tr，标题声明 i18n。
 *   · 变量名 props 会被 runtime 的采集范围收进来（register 里导出 `scopeVars: scopeVarsOf`）。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml, varValue } = rutil;
import { tr } from '../../core/i18n.js';
import { project } from '../../core/project.js';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 取整并夹在 [lo, hi]；认不出/缺键用 dflt（老工程缺键兜底） */
function numIn(v, dflt, lo, hi) {
  const n = Math.round(+v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
/** 数字显示：整数千分位；认不出 → '—' */
function fmtCount(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const neg = n < 0;
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + s;
}
const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** 'HH:MM' → 从 0 点起的分钟数；认不出返回 -1 */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s === null || s === undefined ? '' : s).trim());
  if (!m) return -1;
  const h = +m[1];
  const mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return -1;
  return h * 60 + mi;
}
/** 某个时刻所在本地日的「当天 startMin 点」 */
function anchorOf(nowMs, startMin) {
  const d = new Date(nowMs);
  d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
  return d.getTime();
}
/** 时刻 → 本地 'MM-DD HH:MM'（班次 key 用，跨天不混） */
function stampOf(ms) {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const hhmmOf = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * 当前班次窗口（纯函数，测试可单独调）。
 * 班次从 `shiftStart`（HH:MM）起每 `hours` 小时一班、跨天连续，
 * 返回**包含（或最近一个已开始的）**那个窗口：{ start, end, hours, key, startLabel, endLabel }。
 * @param {number} nowMs 现在（毫秒）
 * @param {string} start 'HH:MM'（认不出按 08:00）
 * @param {number} hours 1~24（认不出按 8）
 */
export function shiftWindowOf(nowMs, start, hours) {
  const h = numIn(hours, 8, 1, 24);
  const dur = h * HOUR_MS;
  let startMin = parseHHMM(start);
  if (startMin < 0) startMin = 8 * 60;                 // 认不出按 08:00
  const first = new Date(anchorOf(nowMs, startMin));
  if (first.getTime() > nowMs) first.setDate(first.getDate() - 1);
  const anchor = first.getTime();
  first.setDate(first.getDate() + 1);
  const k = Math.floor((nowMs - anchor) / dur);        // 最近一个「已开始」的班次
  const startMs = anchor + k * dur;
  const endMs = Math.min(startMs + dur, first.getTime());
  return {
    start: startMs,
    end: endMs,
    hours: h,
    key: stampOf(startMs),
    startLabel: hhmmOf(startMs),
    endLabel: hhmmOf(endMs),
  };
}

/** 某个时刻所在的「小时 key」（纯函数）：{ key, hh, day } */
export function hourKeyOf(nowMs) {
  const d = new Date(nowMs);
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { key: `${day} ${pad2(d.getHours())}:00`, hh: `${pad2(d.getHours())}:00`, day: day };
}

/* ─────────── 本地班次历史 + 每小时计数持久化（同一个 key / 同一份 JSON） ───────────
   结构：{ days: { 'YYYY-MM-DD': { 'HH:MM'(班次开始): { total, ok, ng, hourly, startLabel, endLabel } } },
           hourly: [{ key:'YYYY-MM-DD HH:00', hh:'HH:00', count, ok, ng }] }
   · days 里 total/ok/ng 存的是**本班累计增量**（PLC 原始总计数一直涨，历史里存增量才有意义）；
   · 每小时条目 {count, ok, ng} = 那个小时内的产量 / OK / NG 增量；OK/NG 没绑变量记 null（显示「—」）；
     老存档没有 ok/ng 字段的读回时一律按 null 处理（不报错）；
   · 顶层 hourly = **实时每小时表**（最新在前）：退出运行/刷新页面都要读回来，只有 resetVar 上升沿才清；
   · key 里带工程名 + 控件 id + 总产量变量名 —— 同一台机器上多个工程/多个控件互不串；
   · localStorage 是现场数据，不进工程；写盘节流 + 页面隐藏/卸载时补写一次。 */
const HISTORY_WRITE_MS = 1000;    // 值变化时写盘的最小间隔（页面隐藏/换班/进运行会强制写）

/** 把 undefined/''/认不出的值转成 null（老存档缺 ok/ng 用） */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/** 两个「可能是 null」的原始计数取大：null 安全（都 null → null） */
function maxNum(a, b) {
  const A = numOrNull(a);
  const B = numOrNull(b);
  if (A === null) return B;
  if (B === null) return A;
  return Math.max(A, B);
}
/** 每小时表归一化：{h,count} / {key,hh,day,count,ok,ng} 都认 → 统一结构，按时间新→旧排 */
function normalizeHourly(list) {
  if (!Array.isArray(list)) return [];
  const rows = list.map((r) => {
    const o = (r && typeof r === 'object') ? r : {};
    const key = String(o.key || '');
    const hh = String(o.hh || o.h || key || '');
    return {
      key: key || hh,
      hh: hh,
      day: String(o.day || ''),
      count: Number.isFinite(+o.count) ? +o.count : 0,
      ok: numOrNull(o.ok),       // 老存档没 ok/ng → null（界面显示「—」）
      ng: numOrNull(o.ng),
    };
  }).filter(r => r.hh !== '');
  rows.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));   // key 形如 'YYYY-MM-DD HH:00'
  return rows;
}
/** 复制一份每小时表（记录里存快照，不和实时表共享引用） */
function cloneHourly(list) {
  return normalizeHourly(list).map(r => ({ key: r.key, hh: r.hh, day: r.day, count: r.count, ok: r.ok, ng: r.ng }));
}
/**
 * 把增量记到某个每小时表（最新在前；跨小时换行）。
 * dTotal 是产量增量；dOk/dNg 是 OK/NG 增量（null = 没绑变量，行里记 null）。
 */
function bumpHourly(list, hk, dTotal, dOk, dNg) {
  if (!Array.isArray(list)) return list;
  const t = (dTotal !== null && dTotal > 0) ? dTotal : 0;
  const okAdd = (dOk !== null && dOk > 0) ? dOk : 0;
  const ngAdd = (dNg !== null && dNg > 0) ? dNg : 0;
  if (!t && !okAdd && !ngAdd) return list;           // 这一拍没有增量就不建行
  if (!list.length || list[0].key !== hk.key) {
    list.unshift({ key: hk.key, hh: hk.hh, day: hk.day, count: 0, ok: null, ng: null });
  }
  const row = list[0];
  row.count += t;
  if (dOk !== null) row.ok = (row.ok === null ? 0 : row.ok) + okAdd;
  if (dNg !== null) row.ng = (row.ng === null ? 0 : row.ng) + ngAdd;
  if (list.length > 24) list.length = 24;
  return list;
}

/** 本地日期 key：'YYYY-MM-DD' */
function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 'YYYY-MM-DD' ±N 天（本地时区） */
function dayShift(day, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day === null || day === undefined ? '' : day));
  if (!m) return dayKeyOf(Date.now());
  const d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
  d.setDate(d.getDate() + delta);
  return dayKeyOf(d.getTime());
}
/** 工程名（历史 key 的一部分；读不到按空串） */
function projectNameOf() {
  try {
    const d = project && project.data;
    const m = d && d.meta;
    return String((m && m.name) || '');
  } catch (e) { return ''; }
}
/** 历史记录在 localStorage 里的 key（含工程名 + 控件 id + 总产量变量名；测试也用这个） */
export function shiftHistoryKey(w) {
  const totalVar = (w && w.bindings && w.bindings.variable) || '';
  const id = (w && w.id) || '';
  return 'hmi-shift-history:' + projectNameOf() + ':' + id + ':' + totalVar;
}
/** 读整份本地存档：{ days, hourly, raw }（读不到/坏了返回空）
 *  raw = 最近一次采样到的**原始计数** {total,ok,ng}：重进运行态时用它防止
 *  「varStore 先退回工程初值、后端再回读真实累计值」的跳变被当成产量增量加一遍。 */
function readShiftStorage(w) {
  try {
    const raw = localStorage.getItem(shiftHistoryKey(w));
    if (!raw) return { days: {}, hourly: [], raw: { total: null, ok: null, ng: null } };
    const j = JSON.parse(raw);
    const days = (j && j.days && typeof j.days === 'object') ? j.days : {};
    const hourly = normalizeHourly(j && j.hourly);
    const r = (j && j.raw && typeof j.raw === 'object') ? j.raw : {};
    return {
      days: days,
      hourly: hourly,
      raw: { total: numOrNull(r.total), ok: numOrNull(r.ok), ng: numOrNull(r.ng) },
    };
  } catch (e) {
    return { days: {}, hourly: [], raw: { total: null, ok: null, ng: null } };
  }
}
/** 读本地班次历史 → { 'YYYY-MM-DD': { 'HH:MM': {…} } }（读不到/坏了返回 {}） */
export function readShiftHistory(w) {
  return readShiftStorage(w).days;
}
/**
 * 读**持久化的每小时计数**（导出给测试/排查用）→ [{ key, h, count }]（最新在前）。
 * 没有顶层 hourly（老存档）时，退回读「最近一条班次记录」里的 hourly。
 */
export function readShiftHourly(w) {
  const saved = readShiftStorage(w);
  let list = saved.hourly;
  if (!list.length) {
    const dayKeys = Object.keys(saved.days).sort();
    for (let i = dayKeys.length - 1; i >= 0 && !list.length; i--) {
      const bucket = saved.days[dayKeys[i]] || {};
      const shiftKeys = Object.keys(bucket).sort();
      for (let k = shiftKeys.length - 1; k >= 0 && !list.length; k--) {
        list = normalizeHourly(bucket[shiftKeys[k]] && bucket[shiftKeys[k]].hourly);
      }
    }
  }
  return list.map(r => ({ key: r.key, h: r.hh, count: r.count, ok: r.ok, ng: r.ng }));
}
/** 写本地存档（配额满/隐私模式写不进去就算了，不影响统计显示）；
 *  raw = 最近一次采样到的原始计数，下次 attach 时用来对齐 lastTotal（防重复累计）。 */
function writeShiftHistory(w, days, hourly, raw) {
  try {
    const r = raw && typeof raw === 'object' ? raw : {};
    localStorage.setItem(shiftHistoryKey(w), JSON.stringify({
      days: days || {},
      hourly: cloneHourly(hourly),
      raw: { total: numOrNull(r.total), ok: numOrNull(r.ok), ng: numOrNull(r.ng) },
    }));
  } catch (e) { /* ignore */ }
}
/** 只留最近 keep 天（YYYY-MM-DD 字典序 = 时间序），超出的从最老删 */
function trimHistoryDays(days, keep) {
  const keys = Object.keys(days);
  if (keys.length <= keep) return false;
  keys.sort();
  const cut = keys.length - keep;
  for (let i = 0; i < cut; i++) delete days[keys[i]];
  return true;
}
/** 某天某班的记录（没有就建一条空的）；顺带把起止标签写进去 */
function ensureShiftRecord(days, win) {
  const day = dayKeyOf(win.start);
  if (!days[day] || typeof days[day] !== 'object') days[day] = {};
  let rec = days[day][win.startLabel];
  if (!rec || typeof rec !== 'object') {
    rec = { total: 0, ok: 0, ng: 0, hourly: [], startLabel: win.startLabel, endLabel: win.endLabel };
    days[day][win.startLabel] = rec;
  }
  rec.startLabel = win.startLabel;
  rec.endLabel = win.endLabel;
  if (!Array.isArray(rec.hourly)) rec.hourly = [];
  if (!Number.isFinite(+rec.total)) rec.total = 0;
  if (!Number.isFinite(+rec.ok)) rec.ok = 0;
  if (!Number.isFinite(+rec.ng)) rec.ng = 0;
  return { day: day, rec: rec };
}
/** 某天开始的班次列表（按开始时间排序；当前班也在里面，数据是实时记录） */
function historyShiftsOf(days, day, live) {
  const bucket = (days && days[day]) || {};
  const rows = Object.keys(bucket).map((k) => {
    const r = bucket[k] || {};
    const startLabel = String(r.startLabel || k);
    const endLabel = String(r.endLabel || '');
    const isCur = !!(live && live.day === day && live.startLabel === startLabel);
    return {
      key: startLabel,
      start: startLabel,
      end: endLabel,
      startLabel: startLabel,
      endLabel: endLabel,
      total: Number.isFinite(+r.total) ? +r.total : 0,
      ok: Number.isFinite(+r.ok) ? +r.ok : 0,
      ng: Number.isFinite(+r.ng) ? +r.ng : 0,
      hourly: Array.isArray(r.hourly) ? r.hourly : [],
      has: true,
      current: isCur,
    };
  });
  rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return rows;
}

/** 当前「看历史」选中的那条记录（没选就取那天最新一班；实时视图返回 null） */
function pastRecordOf(st, live) {
  if (!st || st.view !== 'past' || !st.days) return null;
  const day = st.histDate || dayKeyOf(Date.now());
  const rows = historyShiftsOf(st.days, day, live);
  let hit = null;
  if (st.histSel) hit = rows.find(r => r.key === st.histSel) || null;
  if (!hit && rows.length) hit = rows[rows.length - 1];
  return hit;
}

/** 绑定的统计变量名（ok / ng / reset）：用**绑定扩展**而不是文本属性 ——
 *  这样属性面板里是真正的「变量选择框」（能搜/能选/能新建），不是手打变量名的文本框。
 *  兼容：老写法 props.okVar/ngVar/resetVar 里填过的也认（新工程不会再有）。 */
function boundStatVar(w, key) {
  const b = (w && w.bindings) || {};
  const s = String(b[key] === null || b[key] === undefined ? '' : b[key]).trim();
  if (s) return s;
  const p = (w && w.props) || {};
  const legacy = { ok: 'okVar', ng: 'ngVar', reset: 'resetVar' }[key];
  return legacy ? String(p[legacy] === null || p[legacy] === undefined ? '' : p[legacy]).trim() : '';
}

/** 采集范围：OK / NG / 重置变量（总产量走 binding.variable，runtime 自己会收） */
function scopeVarsOf(w) {
  const out = [];
  ['ok', 'ng', 'reset'].forEach((k) => {
    const s = boundStatVar(w, k);
    if (s) out.push(s);
  });
  return out;
}

/** 运行态状态：widgetId → state（不写进 w.props；定时器也在里面） */
const STATES = new Map();
function stateOf(w, create) {
  let s = STATES.get(w.id);
  if (!s && create) {
    s = {
      timer: 0,
      init: false,
      shiftKey: '',
      baseline: 0, okBase: 0, ngBase: 0,
      total: null, ok: null, ng: null,
      lastTotal: null, lastOk: null, lastNg: null,
      lastReset: false,
      sampledAt: 0,     // 最近一次采样时间（测试用：退出运行后不再前进 = 定时器停掉了）
      readIssue: '',
      hourly: [],      // [{ key, hh, day, count }]，最新在前
      // ── 历史班次（本地按天）──
      days: null,      // { 'YYYY-MM-DD': { 'HH:MM': {total,ok,ng,hourly,startLabel,endLabel} } }
      rec: null,       // 当前班次正在累加的那条记录（引用 days 里的对象）
      view: 'live',    // 'live' | 'past'（看历史时主数据不跟实时刷新）
      histDate: '',    // 历史条上选中的日期 'YYYY-MM-DD'
      histSel: null,   // 选中的历史班次开始时间 'HH:MM'
      lastSaveAt: 0,   // 上次写 localStorage 的时间（节流）
      histDirty: false,
      pendingHourly: null,   // 从存档读回来、待合并进实时每小时表的计数
      // ── 防重复累计（重进运行态 / 刷新页面时 varStore 先退回初值、后端再回读真值）──
      savedRaw: null,  // 存档里的最近一次原始计数 {total,ok,ng}（旧存档/没存档是 null）
      settleLeft: 0,   // 稳定期还剩几拍：只更新显示、不累加
      aligned: false,  // 稳定期结束的那一拍是否已把 last* 对齐当前值
      raw: { total: null, ok: null, ng: null },   // 本次采样读到的原始计数（落盘用）
    };
    STATES.set(w.id, s);
  }
  return s;
}

/** 仅测试用：清掉模块级运行态（模拟"刷新页面"——存档还在 localStorage 里，内存状态清空）。 */
export function __resetShiftMemoryForTest() {
  STATES.clear();
  return true;
}

/** 变量名 prop（空串 → ''） */
const nameOf = (p, k) => String((p && p[k] !== null && p[k] !== undefined) ? p[k] : '').trim();
const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

register({
  type: 'shift',                   // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '班次产量',
  sub: '总产量 / OK / NG / 每小时计数',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="6" width="28" height="24" rx="3" fill="#fff" stroke="#94a3b8"/><path d="M4 13h28" stroke="#c3cbd6" stroke-width="1.6"/><path d="M10 22V18M14 22V15M18 22V19M22 22V16M26 22V20" stroke="#2563eb" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="9.5" r="1.4" fill="#22c55e"/><circle cx="14" cy="9.5" r="1.4" fill="#e5e7eb"/><circle cx="18" cy="9.5" r="1.4" fill="#e5e7eb"/></svg>',
  selfDrawn: false,
  refreshOnVariable: false,       // 定时采样统一刷新，避免 PLC 高频推送重建日期框和列表
  defaults: {
    w: 340, h: 240,
    title: '班次产量',
    shiftStart: '08:00',           // 班次开始时间 HH:MM
    shiftHours: 8,                 // 一班几小时（1~24）
    showHourly: true,              // 显示每小时列表
    hourlyRows: 8,                 // 每小时列表最多几行（1~24）
    refreshMs: 1000,               // 采样/刷新周期（500~10000）
    showShiftTime: true,           // 显示本班时间段/已过时间
    showHistory: true,             // 显示「历史条」（日期选择看之前班次）
    historyDays: 30,               // 本地历史保留天数（1~366）
    fontSize: 13, numberSize: 26,
    textColor: '#1f2329', okColor: '#16a34a', ngColor: '#dc2626',
    bgColor: '#ffffff', borderColor: '#c3cbd6', borderWidth: 1, radius: 6,
  },
  props: [
    { key: 'title', label: '标题', type: 'text', i18n: 'text' },
    { key: 'shiftStart', label: '班次开始', type: 'text' },
    { key: 'shiftHours', label: '每班小时', type: 'number', min: 1, max: 24, defVal: 8 },
    { key: 'showShiftTime', label: '显示班次时间', type: 'check', defVal: true },
    { key: 'showHourly', label: '显示每小时', type: 'check', defVal: true },
    { key: 'hourlyRows', label: '每小时行数', type: 'number', min: 1, max: 24, defVal: 8 },
    { key: 'refreshMs', label: '刷新周期ms', type: 'number', min: 500, max: 10000, defVal: 1000 },
    { key: 'showHistory', label: '显示历史条', type: 'check', defVal: true },
    { key: 'historyDays', label: '历史保留天数', type: 'number', min: 1, max: 366, defVal: 30 },
    { key: 'fontSize', label: '字号', type: 'number', min: 9, max: 30 },
    { key: 'numberSize', label: '数字字号', type: 'number', min: 12, max: 64 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'okColor', label: 'OK 颜色', type: 'color' },
    { key: 'ngColor', label: 'NG 颜色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
  ],
  binding: {
    variable: { types: ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: '总产量计数' },
    // 统计变量（可选）：走**绑定扩展** → 属性面板直接给变量选择框（和波形「启动抓取」同一套）
    ok: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: 'OK 计数', group: '统计变量', placeholder: '（可留空）' },
    ng: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: 'NG 计数', group: '统计变量', placeholder: '（可留空）' },
    reset: { types: ['bool'], label: '重置统计', group: '统计变量', placeholder: '（可留空：上升沿清本班统计）' },
  },
  actions: [],
  // 复杂逻辑放模块级函数（hmi-mcp 静态提取器只认这种「只写函数名」的写法）
  scopeVars: scopeVarsOf,
  render(w, mode, vars) {
    const p = w.props || {};
    const fs = numIn(p.fontSize, 13, 9, 30);
    const numSize = numIn(p.numberSize, 26, 12, 64);
    const bw = numIn(p.borderWidth, 1, 0, 8);
    const radius = numIn(p.radius, 6, 0, 100);
    const fg = p.textColor || '#1f2329';
    const bg = p.bgColor || '#ffffff';
    const line = p.borderColor || '#c3cbd6';
    const okColor = p.okColor || '#16a34a';
    const ngColor = p.ngColor || '#dc2626';
    const now = Date.now();
    const win = shiftWindowOf(now, p.shiftStart, p.shiftHours);
    const st = (mode === 'run') ? stateOf(w, false) : null;
    const ready = !!(st && st.init);
    // 历史视图：'live' 跟实时；'past' 主数据/小时表锁在选中的历史班次上（不跟实时刷新）
    const historyOn = p.showHistory !== false;
    const liveView = !(historyOn && mode === 'run' && st && st.view === 'past');
    const histDate = (mode === 'run' && st && st.histDate) ? st.histDate : dayKeyOf(now);
    const liveDay = dayKeyOf(win.start);
    let pastRows = [];
    let pastSel = null;
    if (!liveView && st && st.days) {
      pastRows = historyShiftsOf(st.days, histDate, { day: liveDay, startLabel: win.startLabel });
      if (st.histSel) pastSel = pastRows.find(r => r.key === st.histSel) || null;
      if (!pastSel && pastRows.length) pastSel = pastRows[pastRows.length - 1];   // 默认选最新一班
    }

    // 取变量值：运行态 state 是采样结果；编辑态/首帧直接用运行值表预览
    const getV = (name) => {
      if (!name || !vars || typeof vars.get !== 'function') return undefined;
      return vars.get(name);
    };
    const okVar = boundStatVar(w, 'ok');
    const ngVar = boundStatVar(w, 'ng');
    const waiting = st && st.readIssue;
    const total = ready ? st.total : (waiting ? null : toNum(varValue(w, vars)));
    const okNow = ready ? st.ok : (okVar && !waiting ? toNum(getV(okVar)) : null);
    const ngNow = ready ? st.ng : (ngVar && !waiting ? toNum(getV(ngVar)) : null);
    const shiftTotal = total === null ? null : (st && st.rec ? st.rec.total : 0);
    const okShift = okNow === null ? null : (st && st.rec ? st.rec.ok : 0);
    const ngShift = ngNow === null ? null : (st && st.rec ? st.rec.ng : 0);
    // 主数据行显示哪一份：看历史时用那一班的累计值
    const viewTotal = liveView ? total : (pastSel ? pastSel.total : null);
    const viewOk = liveView ? okNow : (pastSel ? pastSel.ok : null);
    const viewNg = liveView ? ngNow : (pastSel ? pastSel.ng : null);

    const title = tr(p.title || '班次产量');
    const subStyle = `font-size:${Math.max(9, fs - 2)}px;color:#6b7280;white-space:nowrap`;
    const numStyle = (color) => `font-size:${numSize}px;font-weight:700;line-height:1.05;color:${color};font-variant-numeric:tabular-nums`;
    const cell = (cls, label, value, extra, color) => `<div class="sh-cell ${cls}" style="display:flex;flex-direction:column;min-width:0;flex:1">
      <span class="sh-label" style="${subStyle}">${escapeHtml(label)}</span>
      <span class="sh-num" style="${numStyle(color || fg)}">${escapeHtml(value)}</span>
      ${extra ? `<span class="sh-sub" style="${subStyle}">${escapeHtml(extra)}</span>` : ''}
    </div>`;

    // 班次时间段 + 进度条：看历史时显示那一班的时间段（已结束 → 进度 100%）
    let winTxt = `${win.startLabel}–${win.endLabel}`;
    let pct = Math.max(0, Math.min(100, Math.round(((now - win.start) / (win.end - win.start)) * 100)));
    if (!liveView && pastSel) {
      winTxt = `${pastSel.startLabel}–${pastSel.endLabel || pastSel.startLabel}`;
      pct = 100;
    } else if (!liveView) {
      winTxt = '';
    } else if (p.showShiftTime !== false) {
      const elapsed = Math.max(0, Math.min(win.end - win.start, now - win.start));
      const em = Math.floor(elapsed / 60000);
      winTxt += ` · ${tr('已过')} ${Math.floor(em / 60)}:${pad2(em % 60)}`;
    }
    const bar = ((liveView && p.showShiftTime !== false) || (!liveView && pastSel))
      ? `<div class="sh-bar" style="height:3px;border-radius:2px;background:#eef2f7;overflow:hidden;flex:none"><i style="display:block;height:100%;width:${pct}%;background:#2563eb"></i></div>`
      : '';

    // ── 历史条（标题行下面）：‹ 日期 › + 「回到本班」（只看历史时出现）──
    const hBtnStyle = `flex:none;height:${Math.max(18, fs + 8)}px;padding:0 8px;box-sizing:border-box;border:1px solid ${line};border-radius:${Math.max(0, radius - 2)}px;background:#f7f8fa;color:${fg};font-size:${Math.max(10, fs - 1)}px;line-height:1;cursor:pointer;`;
    const hInputStyle = `flex:0 1 auto;width:${Math.max(136, fs * 7 + 32)}px;min-width:0;height:${Math.max(20, fs + 10)}px;box-sizing:border-box;border:1px solid ${line};border-radius:${Math.max(0, radius - 2)}px;background:#ffffff;color:${fg};font-size:${Math.max(10, fs - 1)}px;padding:0 4px;`;
    const histBar = historyOn ? `<div class="sh-histbar" style="display:flex;align-items:center;gap:4px;flex:none;min-width:0">
        <button type="button" class="sh-hbtn" data-shact="histPrev"${mode === 'edit' ? ' disabled' : ''} style="${hBtnStyle}">‹</button>
        <input class="sh-hdate" type="date" data-shhist="date" value="${escapeHtml(histDate)}"${mode === 'edit' ? ' disabled' : ''} style="${hInputStyle}">
        <button type="button" class="sh-hbtn" data-shact="histNext"${mode === 'edit' ? ' disabled' : ''} style="${hBtnStyle}">›</button>
        <span style="flex:none;width:4px"></span>
        ${(!liveView) ? `<button type="button" class="sh-hbtn sh-hlive" data-shact="histLive" style="${hBtnStyle}">${escapeHtml(tr('回到本班'))}</button>` : ''}
      </div>` : '';

    // ── 历史班次列表（选中日期那天开始的班次；当前班也在里面、数据实时）──
    let pastList = '';
    if (historyOn && !liveView) {
      const lineH = Math.max(18, fs + 10);
      const rowsHtml = pastRows.length ? pastRows.map((r) => {
        const sel = pastSel && pastSel.key === r.key;
        const txt = `${r.startLabel}–${r.endLabel || r.startLabel} · ${tr('产量')} ${fmtCount(r.total)} · OK ${fmtCount(r.ok)} · NG ${fmtCount(r.ng)}`;
        return `<div class="sh-pastrow${sel ? ' sel' : ''}${r.current ? ' cur' : ''}" data-shpast="${escapeHtml(r.key)}" style="display:flex;align-items:center;gap:6px;min-height:${lineH}px;padding:0 6px;box-sizing:border-box;border-bottom:1px solid #f1f3f6;font-size:${Math.max(9, fs - 1)}px;color:${fg};cursor:pointer;${sel ? 'background:#eef4ff;box-shadow:inset 3px 0 0 #2563eb;' : ''}">
          <span class="sh-pasttext" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(txt)}</span>
          ${r.current ? `<span class="sh-pastcur" style="flex:none;color:#2563eb;font-size:${Math.max(8, fs - 3)}px">${escapeHtml(tr('进行中'))}</span>` : ''}
        </div>`;
      }).join('') : `<div class="sh-pastempty" style="padding:8px;color:#8a94a6;font-size:${Math.max(9, fs - 1)}px;text-align:center">${escapeHtml(tr('没有记录'))}</div>`;
      pastList = `<div class="sh-pastlist" style="flex:none;max-height:${lineH * 3}px;overflow:auto;border:1px solid ${line};border-radius:${Math.max(0, radius - 2)}px">${rowsHtml}</div>`;
    }

    // 每小时列表（最新在上；本小时标「进行中」）—— 看历史时用那一班的每小时
    // 列：小时 | 产量 | OK | NG（表头小字）；OK/NG 没绑变量 / 老存档缺字段 → 「—」
    let hourly = '';
    if (p.showHourly !== false) {
      const maxRows = numIn(p.hourlyRows, 8, 1, 24);
      const curKey = hourKeyOf(now).key;
      let rows;
      if (!liveView) {
        rows = normalizeHourly(pastSel ? pastSel.hourly : []).slice(0, maxRows);
      } else {
        rows = ready ? st.hourly.slice(0, maxRows) : [{ key: curKey, hh: hourKeyOf(now).hh, day: hourKeyOf(now).day, count: 0, ok: okVar ? 0 : null, ng: ngVar ? 0 : null }];
      }
      const cur = rows.length ? rows[0] : null;
      const showOk = (v) => (v === null || v === undefined) ? '—' : fmtCount(v);
      const tagW = Math.max(26, Math.round(fs * 3));
      const tagStyle = `flex:none;width:${tagW}px;text-align:right;color:#2563eb;font-size:${Math.max(8, fs - 3)}px`;
      const rowsHtml = rows.map((r) => {
        const on = liveView && r.key === curKey;
        return `<div class="sh-hrow" data-shhour="${escapeHtml(r.key)}" style="display:flex;align-items:center;gap:6px;padding:1px 2px;border-bottom:1px solid #f1f3f6;font-size:${Math.max(9, fs - 1)}px;color:${fg}">
          <span class="sh-hkey" style="flex:none;min-width:38px;color:#6b7280">${escapeHtml(r.hh)}</span>
          <span class="sh-hcount" style="flex:1;text-align:right;font-variant-numeric:tabular-nums;font-weight:${on ? 700 : 400}">${escapeHtml(fmtCount(r.count))}</span>
          <span class="sh-hok" style="flex:none;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;color:${okColor}">${escapeHtml(showOk(r.ok))}</span>
          <span class="sh-hng" style="flex:none;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;color:${ngColor}">${escapeHtml(showOk(r.ng))}</span>
          ${on ? `<span class="sh-hcur" style="${tagStyle}">${escapeHtml(tr('进行中'))}</span>` : `<span style="flex:none;width:${tagW}px"></span>`}
        </div>`;
      }).join('');
      // 表头小字：小时 | 产量 | OK | NG（和行同宽，保证列对齐）
      const colStyle = `font-size:${Math.max(8, fs - 3)}px;color:#8a94a6;padding:0 2px`;
      const colHead = `<div class="sh-hcols" style="display:flex;align-items:center;gap:6px;flex:none">
          <span class="sh-hkey" style="${colStyle};flex:none;min-width:38px">${escapeHtml(tr('小时'))}</span>
          <span style="${colStyle};flex:1;text-align:right">${escapeHtml(tr('产量'))}</span>
          <span style="${colStyle};flex:none;min-width:34px;text-align:right">OK</span>
          <span style="${colStyle};flex:none;min-width:34px;text-align:right">NG</span>
          <span style="${colStyle};flex:none;width:${tagW}px"></span>
        </div>`;
      hourly = `<div class="sh-hourly" style="flex:1;min-height:0;display:flex;flex-direction:column;border-top:1px solid ${line};padding-top:4px">
        <div class="sh-hhead" style="display:flex;align-items:baseline;gap:6px;flex:none;padding:0 2px">
          <span style="${subStyle}">${escapeHtml(tr('每小时'))}</span>
        </div>
        ${colHead}
        <div class="sh-hlist" style="flex:1;min-height:0;overflow:auto">${rowsHtml}</div>
      </div>`;
    }

    // 标题旁「历史」标记（看历史时）
    const histMark = (!liveView)
      ? `<span class="sh-histmark" style="flex:none;color:#2563eb;font-size:${Math.max(9, fs - 2)}px;border:1px solid #2563eb;border-radius:${Math.max(0, radius - 2)}px;padding:0 4px;line-height:1.6">${escapeHtml(tr('历史'))}</span>`
      : '';

    return `<div class="w-shift" style="width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:8px;overflow:hidden;background:${bg};border:${bw}px solid ${line};border-radius:${radius}px;color:${fg}">
      <div class="sh-head" style="display:flex;align-items:baseline;gap:8px;flex:none;min-width:0">
        <span class="sh-title" style="font-size:${fs + 1}px;font-weight:600;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(title)}</span>
        ${histMark}
        <span class="sh-window" title="${waiting && liveView ? escapeHtml(waiting) : ''}" style="flex:1;text-align:right;${subStyle}">${escapeHtml(waiting && liveView ? tr('等待设备数据') : winTxt)}</span>
      </div>
      ${histBar}
      ${bar}
      ${pastList}
      <div class="sh-main" style="display:flex;align-items:flex-end;gap:10px;flex:none;min-width:0">
        ${cell('sh-total', tr('总产量'), fmtCount(viewTotal), liveView && shiftTotal !== null ? `${tr('本班')} ${fmtCount(shiftTotal)}` : '', fg)}
        ${cell('sh-ok', tr('OK'), okVar ? fmtCount(viewOk) : '—', (liveView && okVar && okShift) ? ('+' + fmtCount(okShift)) : '', okColor)}
        ${cell('sh-ng', tr('NG'), ngVar ? fmtCount(viewNg) : '—', (liveView && ngVar && ngShift) ? ('+' + fmtCount(ngShift)) : '', ngColor)}
      </div>
      ${hourly}
    </div>`;
  },
  /**
   * 运行态交互（runtime.js 建好控件后调用）：每秒采样一次总产量/OK/NG/重置变量，
   * 更新模块级状态后 api.refresh() 重画。事件/定时器都挂在这个控件实例上。
   */
  attach(el, w, api) {
    const p = w.props || {};
    const st = stateOf(w, true);
    const period = numIn(p.refreshMs, 1000, 500, 10000);
    const read = (name) => (name ? api.get(name) : undefined);

    // ── 本地存档：班次历史 + 每小时计数 + 上次落盘的原始计数（防重进运行态重复累计）──
    const saved = readShiftStorage(w);
    if (!st.days) {
      st.days = saved.days;
      st.pendingHourly = saved.hourly;     // 待合并进实时每小时表（退出运行/刷新页面不丢）
    }
    st.savedRaw = saved.raw;               // 上次落盘的原始计数（旧存档缺 raw → 三项 null，也安全）
    st.settleLeft = 2;                     // 稳定期：前 2 拍只更新显示、不累加（挡 varStore 回退→回读的跳变）
    st.aligned = false;                    // 稳定期结束那拍才对齐 last*（这一拍也不累加）
    trimHistoryDays(st.days, numIn(p.historyDays, 30, 1, 366));
    if (!st.histDate) st.histDate = dayKeyOf(Date.now());
    if (!st.view) st.view = 'live';
    st.lastSaveAt = 0;

    /** 写一次本地存档：值有变化才写、且最多 1 秒一次（不刷盘）；
     *  进运行/换班、页面隐藏/卸载、手动清 hourly 时 force 强写（那一笔不能丢）。
     *  同时把本次采样到的**原始计数**一起存（raw），下次 attach 靠它对齐、不重复累计。 */
    const saveHistory = (force) => {
      if (!st.days) return;
      const now = Date.now();
      if (!force && !st.histDirty) return;
      if (!force && now - st.lastSaveAt < HISTORY_WRITE_MS) return;
      writeShiftHistory(w, st.days, st.hourly, st.raw);
      st.lastSaveAt = now;
      st.histDirty = false;
    };

    /** 采样一次：维护班次基线 / 每小时增量 / 重置上升沿 / 当前班的历史记录 */
    const sample = () => {
      // 变量名每拍现读（运行中改属性也能跟上）；总产量走 binding.variable
      const totalVar = (w.bindings && w.bindings.variable) || '';
      const okVar = boundStatVar(w, 'ok');
      const ngVar = boundStatVar(w, 'ng');
      const resetVar = boundStatVar(w, 'reset');
      const now = Date.now();
      st.readIssue = [totalVar, okVar, ngVar, resetVar].filter(Boolean).map(api.blockReason).find(Boolean) || '';
      if (st.readIssue) return;
      const win = shiftWindowOf(now, p.shiftStart, p.shiftHours);
      const total = toNum(read(totalVar));
      const ok = okVar ? toNum(read(okVar)) : null;
      const ng = ngVar ? toNum(read(ngVar)) : null;
      const resetNow = !!read(resetVar);
      const hk = hourKeyOf(now);
      st.sampledAt = now;
      // 防重复累计：拿「当前读数」和「上次落盘的原始计数」取大（null 安全）——
      // 重进运行态时 varStore 先退回工程初值、后端稍后才回读真实累计值，直接用当前读数当基线
      // 会把回读的跳变算成产量（现场 bug：产量没增加，班次记录却又加了一遍）。
      const maxT = maxNum(total, st.savedRaw ? st.savedRaw.total : null);
      const maxOk = maxNum(ok, st.savedRaw ? st.savedRaw.ok : null);
      const maxNg = maxNum(ng, st.savedRaw ? st.savedRaw.ng : null);
      st.raw = { total: total, ok: ok, ng: ng };   // 本次实际采样值（落盘）
      st.total = total;
      st.ok = ok;
      st.ng = ng;

      // ① 首次 / 换班：基线取当前值；首次若是同一班的老记录，接着它已累计的数续上
      if (!st.init || st.shiftKey !== win.key) {
        const first = !st.init;
        const er = ensureShiftRecord(st.days, win);
        trimHistoryDays(st.days, numIn(p.historyDays, 30, 1, 366));   // 加上这一班后仍只留 historyDays 天
        st.rec = er.rec;
        const rec = er.rec;
        st.init = true;
        st.shiftKey = win.key;
        if (first) {
          // 基线用 max(当前, 上次落盘)：即使当前读数还是被重置过的初值，也按磁盘上的真实累计对齐
          st.baseline = (maxT === null ? 0 : maxT) - (Number.isFinite(+rec.total) ? +rec.total : 0);
          st.okBase = (maxOk === null ? 0 : maxOk) - (Number.isFinite(+rec.ok) ? +rec.ok : 0);
          st.ngBase = (maxNg === null ? 0 : maxNg) - (Number.isFinite(+rec.ng) ? +rec.ng : 0);
          // 每小时表：优先用存档里的实时 hourly（退出运行/刷新页面不丢），老存档退回当前班记录
          const savedH = normalizeHourly(st.pendingHourly);
          st.pendingHourly = null;
          st.hourly = savedH.length ? savedH : normalizeHourly(rec.hourly);
          if (!st.hourly.length) st.hourly = [{ key: hk.key, hh: hk.hh, day: hk.day, count: 0, ok: okVar ? 0 : null, ng: ngVar ? 0 : null }];
          if (!rec.hourly.length) {
            const firstHour = hourKeyOf(win.start).key;
            const lastHour = hourKeyOf(now).key;
            rec.hourly = cloneHourly(st.hourly.filter(r => r.key >= firstHour && r.key <= lastHour));
          }
        } else {
          // 换班：新班的记录从 0 开始；**实时每小时表不清**（继续滚动，只有 resetVar 手动清）
          rec.total = 0; rec.ok = 0; rec.ng = 0;
          rec.hourly = [];
          st.baseline = (total === null ? 0 : total);
          st.okBase = (ok === null ? 0 : ok);
          st.ngBase = (ng === null ? 0 : ng);
        }
        st.lastTotal = maxT;
        st.lastOk = maxOk;
        st.lastNg = maxNg;
        st.lastReset = resetNow;
        st.histDirty = true;
        saveHistory(true);                 // 进运行/换班先落一次：刷新页面也能接着看
        return;
      }

      // ② 稳定期（进运行后前 2 拍）：只更新显示，**不累加任何增量、不改记录/小时表**
      if (st.settleLeft > 0) {
        st.settleLeft--;
        return;
      }
      // ③ 稳定期结束的第一拍：把 last* 对齐 max(当前, 存档原始值)，重算本班基线（这一拍也不累加）
      if (!st.aligned) {
        st.lastTotal = maxT;
        st.lastOk = maxOk;
        st.lastNg = maxNg;
        st.lastReset = resetNow;
        if (st.rec) {
          st.baseline = (maxT === null ? 0 : maxT) - (Number.isFinite(+st.rec.total) ? +st.rec.total : 0);
          st.okBase = (maxOk === null ? 0 : maxOk) - (Number.isFinite(+st.rec.ok) ? +st.rec.ok : 0);
          st.ngBase = (maxNg === null ? 0 : maxNg) - (Number.isFinite(+st.rec.ng) ? +st.rec.ng : 0);
        }
        st.savedRaw = { total: maxT, ok: maxOk, ng: maxNg };
        st.aligned = true;
        st.histDirty = true;
        saveHistory(true);
        return;
      }

      let changed = false;
      // ② 每小时增量：产量 / OK / NG 分别记到实时表（持久化，跨班不清）和当前班记录
      const dT = (total !== null && st.lastTotal !== null && total > st.lastTotal) ? (total - st.lastTotal) : null;
      const dOk = (ok !== null && st.lastOk !== null) ? (ok - st.lastOk) : null;
      const dNg = (ng !== null && st.lastNg !== null) ? (ng - st.lastNg) : null;
      if (dT !== null || (dOk !== null && dOk > 0) || (dNg !== null && dNg > 0)) {
        bumpHourly(st.hourly, hk, dT, dOk, dNg);
        if (st.rec) bumpHourly(st.rec.hourly, hk, dT, dOk, dNg);
        changed = true;
      }
      if (st.rec) {
        if (dT !== null) st.rec.total = (Number.isFinite(+st.rec.total) ? +st.rec.total : 0) + dT;
        if (dOk !== null && dOk > 0) st.rec.ok = (Number.isFinite(+st.rec.ok) ? +st.rec.ok : 0) + dOk;
        if (dNg !== null && dNg > 0) st.rec.ng = (Number.isFinite(+st.rec.ng) ? +st.rec.ng : 0) + dNg;
      }
      if (st.hourly.length > 24) st.hourly.length = 24;    // 界面上最多看 24 小时
      if (st.rec && Array.isArray(st.rec.hourly) && st.rec.hourly.length > 24) st.rec.hourly.length = 24;

      // ③ 重置变量上升沿 = **手动清**：清本班统计基线 + 实时每小时表 + 当前班记录，并立即落盘
      if (resetNow && !st.lastReset) {
        st.baseline = (total === null ? 0 : total);
        st.okBase = (ok === null ? 0 : ok);
        st.ngBase = (ng === null ? 0 : ng);
        st.hourly = [{ key: hk.key, hh: hk.hh, day: hk.day, count: 0, ok: okVar ? 0 : null, ng: ngVar ? 0 : null }];
        if (st.rec) {
          st.rec.total = 0; st.rec.ok = 0; st.rec.ng = 0;
          st.rec.hourly = cloneHourly(st.hourly);
        }
        changed = true;
        st.histDirty = true;
        saveHistory(true);                 // 手动清：内存 + localStorage 一起清（不等节流）
      }

      st.lastTotal = total;
      st.lastOk = ok;
      st.lastNg = ng;
      st.lastReset = resetNow;
      st.total = total;
      st.ok = ok;
      st.ng = ng;
      if (changed) st.histDirty = true;
      if (st.histDirty) saveHistory(false);
    };

    /** 测试钩子：当前状态快照 */
    el.__shiftState = () => {
      const win = shiftWindowOf(Date.now(), p.shiftStart, p.shiftHours);
      const ready = !!st.init;
      const total = st.total;
      const shiftTotal = (ready && total !== null) ? st.rec.total : null;
      // hourly 跟当前视图：实时 = 持久化的实时每小时表；看历史 = 那班记录里的每小时
      const liveInfo = { day: dayKeyOf(win.start), startLabel: win.startLabel };
      const pastRec = pastRecordOf(st, liveInfo);
      const shownHourly = st.view === 'past' ? normalizeHourly(pastRec ? pastRec.hourly : []) : st.hourly;
      const viewHourly = shownHourly.map(r => ({ h: r.hh, count: r.count, key: r.key, ok: r.ok, ng: r.ng }));
      return {
        shiftKey: win.key,
        start: win.start,
        end: win.end,
        startLabel: win.startLabel,
        endLabel: win.endLabel,
        hours: win.hours,
        total: total,
        shiftTotal: shiftTotal,
        ok: st.ok,
        ng: st.ng,
        okShift: (st.rec && st.ok !== null) ? st.rec.ok : null,
        ngShift: (st.rec && st.ng !== null) ? st.rec.ng : null,
        baseline: st.baseline,
        okBase: st.okBase,
        ngBase: st.ngBase,
        sampledAt: st.sampledAt,
        hourly: viewHourly,
        // ── 历史查看状态（测试/现场排查用）──
        view: (st.view === 'past') ? 'past' : 'live',
        histDate: st.histDate || dayKeyOf(Date.now()),
        histSel: st.histSel,
        histShifts: historyShiftsOf(st.days, st.histDate || dayKeyOf(Date.now()), {
          day: dayKeyOf(Date.now()),
          startLabel: shiftWindowOf(Date.now(), p.shiftStart, p.shiftHours).startLabel,
        }).map((r) => ({ start: r.start, end: r.end, total: r.total, ok: r.ok, ng: r.ng, has: r.has, current: r.current })),
      };
    };

    /** 切到某个历史日期（自动选中那天最新的一班；空日期按今天） */
    const gotoHistory = (day) => {
      st.view = 'past';
      st.histDate = dayShift(day || dayKeyOf(Date.now()), 0);
      const nowWin = shiftWindowOf(Date.now(), p.shiftStart, p.shiftHours);
      const rows = historyShiftsOf(st.days, st.histDate, { day: dayKeyOf(nowWin.start), startLabel: nowWin.startLabel });
      st.histSel = rows.length ? rows[rows.length - 1].key : null;
      refreshView();
    };
    const refreshView = () => {
      const selectors = ['.sh-hlist', '.sh-pastlist'];
      const positions = selectors.map(sel => el.querySelector(sel)?.scrollTop || 0);
      api.refresh();
      selectors.forEach((sel, i) => {
        const list = el.querySelector(sel);
        if (list) list.scrollTop = positions[i];
      });
    };

    // 历史条 / 历史班次行 的交互（事件全挂 el 上做委托，body 重画也不受影响）
    el.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const act = t.closest('[data-shact]');
      if (act) {
        const kind = act.getAttribute('data-shact');
        if (kind === 'histPrev' || kind === 'histNext') {
          gotoHistory(dayShift(st.histDate || dayKeyOf(Date.now()), kind === 'histPrev' ? -1 : 1));
          return;
        }
        if (kind === 'histLive') {
          st.view = 'live';
          st.histSel = null;
          st.histDate = dayKeyOf(Date.now());
          refreshView();
          return;
        }
        return;
      }
      const row = t.closest('[data-shpast]');
      if (row) {
        st.view = 'past';
        st.histSel = row.getAttribute('data-shpast') || null;
        refreshView();
      }
    });
    // 日期框变了 → 看那天的历史
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-shhist') !== 'date') return;
      gotoHistory(String(t.value || ''));
    });

    // 页面隐藏 / 卸载：补写一次本地历史（节流窗口外的值不丢）
    const flushHistory = () => { try { saveHistory(true); } catch (e) { /* ignore */ } };
    const onPageHide = () => { if (el.isConnected) flushHistory(); };
    const onVisibility = () => {
      if (!el.isConnected) {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        return;
      }
      if (document.visibilityState === 'hidden') flushHistory();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    const alive = () => {
      const root = document.getElementById('runtimeRoot');
      return !!el.isConnected && !!root && !root.classList.contains('hidden');
    };
    let myTimer = 0;
    const stop = () => {
      const id = myTimer || st.timer;
      if (id) clearInterval(id);
      myTimer = 0;
      if (st.timer === id) st.timer = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
    const tick = () => {
      if (!alive()) {                      // 元素离开文档 / 退出运行态
        flushHistory();
        stop();
        return;
      }
      sample();
      // 打开原生日历期间只采样，待操作结束后才重建控件内容。
      if (document.activeElement !== el.querySelector('.sh-hdate')) refreshView();
    };

    if (st.timer) { clearInterval(st.timer); st.timer = 0; }   // 重画/切语言后 attach 会再跑一次
    sample();
    myTimer = setInterval(tick, period);
    st.timer = myTimer;
  },
});
