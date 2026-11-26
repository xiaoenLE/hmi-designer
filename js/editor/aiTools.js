/**
 * aiTools.js — AI 助手的「手」：工具定义 + 工具执行 + 多轮对话编排
 *
 * 三层：
 *   ① TOOL_DEFS  组态工具定义（OpenAI function-calling schema）
 *   ② TOOL_IMPL  真正干活的执行器：全部走 project / canvas / registry 的公开 API，
 *                所以改动天然进撤销栈、天然触发 project:changed（画布/面板自动刷新）
 *   ③ runAssistant()  一轮 = 发请求 → 有 tool_calls 就执行 → 把结果回灌 → 再发；轮数默认不限（max_rounds=0）
 *
 * 设计约定（和 docs/ai-assistant.md §7 对齐，改工具一定两处一起改）：
 *   · 工具名/参数名/返回结构都是**对外契约**，面板 UI、假模型测试都按它断言，改名要同步。
 *   · 所有执行器返回 { ok, summary, data?, warnings?, error? }：
 *       summary = 一句话给"工具卡片"显示；data = 给模型看的结构化结果（别塞 render 函数/图标 SVG）。
 *   · 会删东西的工具（删页面/控件/变量/脚本/报警）受 allowDestructive 闸门控制：
 *       面板上的「允许破坏性操作」没勾 → 直接返回失败，让模型自己改口去问用户。
 *   · 模型给的变量名/页面名/控件类型一律**校验**（变量必须已在变量表、页面必须存在、
 *     控件类型必须在注册表、props 必须在 def.props 白名单里），不合格就报错让模型重来，
 *     绝不"猜一个相近的"硬写进工程（写坏了比不写更难查）。
 */

import { project } from '../core/project.js';
import { bus } from '../core/eventBus.js';
import { registry, ACTION_DEFS } from '../widgets/registry.js';
import { history } from '../core/history.js';
import { getSelection, select } from '../editor/canvas.js';
import { i18nState } from '../core/i18n.js';
import { aiClient, AI_DEFAULTS } from '../api/ai.js';
import { messageWithAttachments } from './aiAttachments.js';

/* ════════════════════════════════════════════════════════════════
 * 0. 小工具 / 常量
 * ════════════════════════════════════════════════════════════════ */

const PAGE_TYPES = { page: '页面', popup: '弹窗', base: '公共底' };
const VAR_TYPES = ['bool', 'int', 'real', 'string'];
const ALARM_LEVELS = ['info', 'warn', 'alarm', 'urgent'];
const ALARM_LEVEL_CN = { info: '提示', warn: '警告', alarm: '报警', urgent: '紧急' };
const SCRIPT_TRIGS = ['init', 'interval', 'cycle', 'change', 'cond'];
const SCRIPT_TRIG_CN = { init: '启动时一次', interval: '每隔若干毫秒', cycle: '每 50ms周期', change: '变量变化时', cond: '条件成立时' };
const CMP_OPS = ['==', '!=', '>', '>=', '<', '<='];

/**
 * 把工具结果里的"长字符串/长数组"统一削一遍。
 * 目的：不管哪个工具返回什么（图片 dataURL、整页 props、长脚本…），进模型上下文前都不会爆。
 */
const SLIM_STR = 200;
const SLIM_ARR = 150;
function slimData(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    return v.length > SLIM_STR ? v.slice(0, SLIM_STR) + `…（共 ${v.length} 字）` : v;
  }
  if (typeof v !== 'object') return v;
  if (depth >= 7) return Array.isArray(v) ? `[…${v.length} 项]` : '{…}';
  if (Array.isArray(v)) {
    const head = v.slice(0, SLIM_ARR).map(x => slimData(x, depth + 1));
    if (v.length > SLIM_ARR) head.push(`…（省略 ${v.length - SLIM_ARR} 项）`);
    return head;
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = slimData(v[k], depth + 1);
  return out;
}

const okRes = (summary, data, extra) => ({ ok: true, summary, data: slimData(data), ...(extra || {}) });
const badRes = (error, extra) => ({ ok: false, error: String(error), ...(extra || {}) });

const allPages = () => project.pages() || [];
const allVars = () => project.variables() || [];
const allScripts = () => project.scripts() || [];
const allAlarms = () => project.alarms() || [];
const varNames = () => allVars().map(v => v.name);

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** 把一串「自己会 commit」的操作合成一步撤销：中途不推栈不刷事件，结束只推一次。
 *  用于一次铺很多控件的场景（配方/批量），否则 20 个控件 = 20 步 Ctrl+Z。 */
function batchCommit(label, fn) {
  const real = project.commit;
  project.commit = () => {};
  try {
    return fn();
  } finally {
    project.commit = real;
    real.call(project, label);
  }
}

/** 页面引用：id / 名称 / 'current' / 空 → 页面对象；找不到返回 null */
function findPage(ref) {
  if (ref === undefined || ref === null || ref === '' || ref === 'current') return project.currentPage() || null;
  const s = String(ref);
  return allPages().find(p => p.id === s) || allPages().find(p => p.name === s) || null;
}

function findWidgetOn(page, ref) {
  const key = String(ref == null ? '' : ref).trim();
  if (!key) return null;
  const list = page?.widgets || [];
  const idHit = list.find(x => x.id === key);
  if (idHit) return idHit;
  // 也接受控件「名称」—— 模型经常把名称当 id 用，别让它为此白跑一轮
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  const nk = norm(key);
  const nameHit = list.find(x => norm(x.name) === nk) || list.find(x => norm(x.type) === nk);
  if (nameHit) return nameHit;
  // 允许只给控件 id（跨页找）
  return project.findWidget(key) || null;
}

function pageOfWidget(widget) {
  if (!widget) return null;
  return allPages().find(p => (p.widgets || []).includes(widget)) || null;
}

function requirePage(ref, toolName) {
  const p = findPage(ref);
  if (!p) return { err: badRes(`找不到页面「${ref ?? ''}」（${toolName}）`, { pages: allPages().map(x => x.name) }) };
  return { page: p };
}

/** 破坏性操作的闸门（面板上那个复选框） */
let allowDestructive = false;
export function setAllowDestructive(v) { allowDestructive = !!v; }
export function getAllowDestructive() { return allowDestructive; }

function needDestructive(what) {
  if (allowDestructive) return null;
  return badRes(`「${what}」是破坏性操作，被安全闸拦住了。请先让用户在 AI 面板上勾选「允许破坏性操作」，或者改用不删除的做法。`);
}

/* ════════════════════════════════════════════════════════════════
 * 1. 控件目录（从注册表实时生成，不读 hmi-mcp 的过期快照）
 * ════════════════════════════════════════════════════════════════ */

function propBrief(p) {
  const o = { key: p.key, label: p.label, type: p.type };
  if (Array.isArray(p.options) && p.options.length) {
    o.options = p.options.map(x => (x && typeof x === 'object' ? { v: x.v, t: x.t } : { v: x, t: x }));
  }
  if (p.min !== undefined) o.min = p.min;
  if (p.max !== undefined) o.max = p.max;
  if (p.defVal !== undefined) o.defVal = p.defVal;
  if (p.showVarType) o.showVarType = p.showVarType;
  return o;
}

/** 单个控件的完整对外描述（跳过 render/icon 这类没法 JSON 化的东西） */
function catalogEntry(def) {
  const d = def.defaults || {};
  const defaults = {};
  Object.entries(d).forEach(([k, v]) => {
    if (k === 'w' || k === 'h') return;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') defaults[k] = v;
  });
  return {
    type: def.type,
    title: def.title,
    sub: def.sub || '',
    hidden: !!def.hidden,
    defaultW: Number(d.w) || 100,
    defaultH: Number(d.h) || 40,
    defaults,
    props: (def.props || []).filter(p => p && p.key && !p.uiOnly).map(propBrief),
    binding: def.binding || null,
    actions: Array.isArray(def.actions) ? def.actions : [],
  };
}

/** 控件写 props 的白名单：def.props（去掉 uiOnly）+ defaults 里的标量键 */
function propWhitelist(def) {
  const set = new Set();
  (def.props || []).forEach(p => { if (p && p.key && !p.uiOnly) set.add(p.key); });
  Object.entries(def.defaults || {}).forEach(([k, v]) => {
    if (k === 'w' || k === 'h') return;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') set.add(k);
  });
  return set;
}

/* ════════════════════════════════════════════════════════════════
 * 1.5 视觉规范：栅格 / 房屋色板 / 布局配方 / 排版自检
 *    —— 让模型自由摆控件基本不可能"好看"，所以把"好看的规则"固化成数据：
 *       · 坐标一律 8px 栅格、卡片 16px gap、内边距 16
 *       · 色板直接用工程里已经调好的页面（设备总览）那一套，新页面天然跟老页面统一
 *       · apply_layout_recipe 先铺骨架，tidy_layout 收尾对齐，inspect_layout 自检
 * ════════════════════════════════════════════════════════════════ */

const GRID = 8;             // 坐标/尺寸对齐到 8 的倍数
const PAGE_PAD = 16;        // 画布四周留白
const CARD_GAP = 16;        // 卡片之间
const INNER_PAD = 16;       // 卡片内边距

/** 本机「房屋风格」（取自 server/data/hmi_project.LE 里人工调过的设备总览页） */
const HOUSE = {
  band: '#11283f',        // 顶部深色标题条
  bandText: '#f7fbff',
  bandSub: '#b8cde0',
  accent: '#35c8d2',      // 标题条上的强调细条
  card: '#ffffff',
  cardBorder: '#d8e2eb',
  cardRadius: 14,
  soft: '#eaf1f6',        // 浅色分区/底部条
  softBorder: '#d8e2eb',
  primary: '#24518f',     // 主按钮
  primaryText: '#ffffff',
  title: '#173550',       // 标题文字
  text: '#4b657a',        // 正文
  muted: '#718497',       // 次要说明
  divider: '#e5edf3',
  ok: '#22c55e',
  warn: '#f59e0b',
  err: '#ef4444',
};

const snap = (v) => Math.round((Number(v) || 0) / GRID) * GRID;

const wRect = (x, y, w, h, props) => ({
  type: 'rect', x, y, w, h,
  props: { bgColor: HOUSE.card, borderColor: HOUSE.cardBorder, borderWidth: 1, radius: HOUSE.cardRadius, ...(props || {}) },
});
const wLabel = (x, y, w, h, text, fontSize, textColor) => ({
  type: 'label', x, y, w, h,
  props: { text: String(text ?? ''), fontSize, textColor, bgColor: '' },
});
const wButton = (x, y, w, h, text, kind) => ({
  type: 'button', x, y, w, h,
  props: kind === 'primary'
    ? { offText: text, onText: text, bgColor: HOUSE.primary, textColor: HOUSE.primaryText, borderColor: HOUSE.primary, borderWidth: 1, radius: 8, fontSize: 15, onColor: HOUSE.ok, offColor: HOUSE.muted }
    : { offText: text, onText: text, bgColor: HOUSE.soft, textColor: HOUSE.title, borderColor: HOUSE.softBorder, borderWidth: 1, radius: 8, fontSize: 15, onColor: HOUSE.ok, offColor: HOUSE.muted },
});

/** 顶部标题条（所有配方共用）：返回标题条、强调条、标题、副标题、右上角小字 */
function recipeHeader(o = {}) {
  const w = 992;
  return [
    wRect(16, 16, w, 88, { bgColor: HOUSE.band, borderColor: '', borderWidth: 0, radius: 14 }),
    wRect(32, 40, 8, 40, { bgColor: HOUSE.accent, borderColor: '', borderWidth: 0, radius: 4 }),
    wLabel(56, 32, 520, 32, o.title || '画面标题', 24, HOUSE.bandText),
    wLabel(56, 64, 560, 16, o.subtitle || '一句话说明这个画面是干什么的', 12, HOUSE.bandSub),
    wLabel(784, 48, 208, 16, 'HMI   /   ' + (o.tag || 'SCREEN'), 12, HOUSE.bandSub),
  ];
}

/** 一张卡片：白底 + 圆角 + 细边框 + 标题 + 可选副标题，返回该卡片的「内容区」坐标 */
function recipeCard(x, y, w, h, title, sub) {
  const out = [wRect(x, y, w, h)];
  if (title) out.push(wLabel(x + INNER_PAD, y + INNER_PAD, w - INNER_PAD * 2, 24, title, 16, HOUSE.title));
  if (sub) out.push(wLabel(x + INNER_PAD, y + INNER_PAD + 24, w - INNER_PAD * 2, 16, sub, 12, HOUSE.muted));
  const top = y + INNER_PAD + (title ? 24 : 0) + (sub ? 16 : 0) + 12;
  return { widgets: out, inner: { x: x + INNER_PAD, y: top, w: w - INNER_PAD * 2, h: y + h - INNER_PAD - top } };
}

const LAYOUT_RECIPES = {
  overview: {
    label: '概览/导航页：顶部标题条 + 左侧大卡片 + 右侧入口卡 + 底部说明条',
    build(o = {}) {
      const out = [...recipeHeader(o)];
      const left = recipeCard(16, 120, 600, 336, o.leftTitle || '主要内容', o.leftSub || '这里放设备示意图 / 结构图');
      out.push(...left.widgets);
      out.push(wRect(left.inner.x, left.inner.y, left.inner.w, left.inner.h, { bgColor: '#eef3f8', borderColor: '', borderWidth: 0, radius: 10 }));
      const right = recipeCard(632, 120, 376, 336, o.rightTitle || '快捷入口', o.rightSub || '选择要去的画面');
      out.push(...right.widgets);
      out.push(wRect(648, 200, 344, 1, { bgColor: HOUSE.divider, borderColor: '', borderWidth: 0, radius: 0 }));
      out.push(wButton(648, 216, 344, 48, o.button1 || '进入主画面', 'primary'));
      out.push(wButton(648, 280, 344, 48, o.button2 || '打开第二页', 'soft'));
      out.push(wButton(648, 344, 344, 48, o.button3 || '返回', 'soft'));
      out.push(wLabel(648, 408, 344, 16, '只切换画面，不触发设备控制。', 12, HOUSE.muted));
      out.push(wRect(16, 472, 992, 112, { bgColor: HOUSE.soft, borderColor: '', borderWidth: 0, radius: 12 }));
      out.push(wLabel(32, 488, 200, 24, o.noteTitle || '说明', 16, HOUSE.title));
      out.push(wLabel(32, 520, 648, 24, o.note || '这里写这一页的用途、操作注意事项。', 13, HOUSE.text));
      out.push(wLabel(696, 520, 296, 24, o.footer || '页面 / 变量', 13, HOUSE.text));
      return out;
    },
  },
  dashboard: {
    label: '运行看板：标题条 + 3 张 KPI 卡 + 趋势卡 + 报警卡',
    build(o = {}) {
      const out = [...recipeHeader(o)];
      const kpis = o.kpis || ['指标一', '指标二', '指标三'];
      const xs = [16, 352, 688];
      const values = o.values || ['0.0', '0', '0'];
      const units = o.units || ['unit', '件', '件'];
      for (let i = 0; i < 3; i++) {
        const x = xs[i];
        out.push(wRect(x, 120, 320, 136));
        out.push(wLabel(x + INNER_PAD, 136, 288, 20, kpis[i] || `指标${i + 1}`, 13, HOUSE.muted));
        out.push(wLabel(x + INNER_PAD, 164, 200, 56, values[i] ?? '0', 40, HOUSE.title));
        out.push(wLabel(x + 216, 196, 88, 20, units[i] || '', 13, HOUSE.muted));
      }
      const trend = recipeCard(16, 272, 640, 200, o.trendTitle || '趋势', o.trendSub || '最近一段时间的曲线');
      out.push(...trend.widgets);
      out.push({ type: 'trend', x: trend.inner.x, y: trend.inner.y, w: trend.inner.w, h: trend.inner.h - 8, props: { bgColor: '#0f172a', gridColor: '#1e3a5f', textColor: '#cbd5e1', borderColor: '#334155', borderWidth: 1, radius: 8, fontSize: 11 } });
      const al = recipeCard(672, 272, 336, 200, o.alarmTitle || '当前报警', '');
      out.push(...al.widgets);
      out.push({ type: 'alarmList', x: al.inner.x, y: al.inner.y - 8, w: al.inner.w, h: al.inner.h + 8, props: { bgColor: HOUSE.card, borderColor: HOUSE.cardBorder, borderWidth: 1, radius: 8, fontSize: 12 } });
      out.push(wRect(16, 488, 992, 96, { bgColor: HOUSE.soft, borderColor: '', borderWidth: 0, radius: 12 }));
      out.push(wLabel(32, 504, 200, 20, '运行状态', 14, HOUSE.title));
      out.push(wLabel(32, 532, 648, 20, o.note || '把 KPI 数字换成「数值显示」控件并绑变量；趋势卡里换成「波形」并绑通道。', 12, HOUSE.muted));
      out.push(wLabel(696, 532, 296, 20, '更新时间 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 12, HOUSE.muted));
      return out;
    },
  },
  control: {
    label: '操作面板：标题条 + 左侧设备示意卡 + 右侧操作按钮组 + 底部状态条',
    build(o = {}) {
      const out = [...recipeHeader(o)];
      const left = recipeCard(16, 120, 600, 344, o.leftTitle || '设备示意', o.leftSub || '放设备图 / 状态指示');
      out.push(...left.widgets);
      out.push(wRect(left.inner.x, left.inner.y, left.inner.w, left.inner.h, { bgColor: '#eef3f8', borderColor: '', borderWidth: 0, radius: 10 }));
      const right = recipeCard(632, 120, 376, 344, o.rightTitle || '操作', o.rightSub || '');
      out.push(...right.widgets);
      out.push(wButton(648, 216, 168, 56, o.btn1 || '启动', 'primary'));
      out.push(wButton(832, 216, 168, 56, o.btn2 || '停止', 'soft'));
      out.push(wButton(648, 288, 168, 56, o.btn3 || '复位', 'soft'));
      out.push(wButton(832, 288, 168, 56, o.btn4 || '返回', 'soft'));
      out.push(wLabel(648, 360, 344, 16, '关键操作建议加二次确认。', 12, HOUSE.muted));
      out.push(wRect(16, 480, 992, 104, { bgColor: HOUSE.soft, borderColor: '', borderWidth: 0, radius: 12 }));
      out.push(wLabel(32, 496, 200, 20, '状态', 14, HOUSE.title));
      out.push(wLabel(32, 524, 320, 18, o.s1 || '运行状态：待机', 12, HOUSE.text));
      out.push(wLabel(376, 524, 320, 18, o.s2 || '当前速度：0.0', 12, HOUSE.text));
      out.push(wLabel(720, 524, 320, 18, o.s3 || '当前计数：0', 12, HOUSE.text));
      return out;
    },
  },
};

const containedIn = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
/** 位置撞车判定：完全包含（卡片底框 vs 卡内控件）是有意的层次，不算撞；只有部分相交才算 */
const rectHit = (a, b) => !containedIn(a, b) && !containedIn(b, a)
  && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 铺布局配方骨架（只放结构/文字/按钮，变量绑定留给模型后面用 update_widget 做） */
function t_apply_layout_recipe(a = {}) {
  const name = String(a.recipe || '').trim();
  const rec = LAYOUT_RECIPES[name];
  if (!rec) return badRes(`没有配方「${name}」，可选：${Object.keys(LAYOUT_RECIPES).join(' / ')}`);
  const page = findPage(a.page);
  if (!page) return badRes(a.page ? `找不到页面「${a.page}」` : '当前没有打开任何页面');
  const specs = rec.build({
    title: a.title, subtitle: a.subtitle, tag: a.tag,
    kpis: a.kpis, values: a.values, units: a.units,
  });
  if (page.id !== project.currentPage()?.id) project.setCurrentPage(page.id);
  const made = [];
  batchCommit('AI 套用布局配方（' + name + '）', () => {
    specs.forEach(s => {
      const def = registry.get(s.type);
      if (!def) return;
      const w = project.addWidget(s.type, snap(s.x), snap(s.y));
      if (!w) return;
      project.updateWidgets([w.id], { x: snap(s.x), y: snap(s.y), w: snap(s.w), h: snap(s.h) });
      try { applyWidgetProps(w, def, s.props || {}, []); } catch { /* 属性名对不上就算了，不影响几何 */ }
      made.push(w);
    });
  });
  return okRes(`在「${page.name}」套用配方「${rec.label}」：铺了 ${made.length} 个控件`, {
    pageId: page.id, recipe: name, count: made.length,
    widgets: made.slice(0, 40).map(w => ({ id: w.id, type: w.type, name: w.name, x: w.x, y: w.y, w: w.w, h: w.h })),
    next: '变量还没绑：把 KPI 数字换成 value 控件、趋势换成 trend 并绑通道；最后调 tidy_layout 再 inspect_layout。一次 Ctrl+Z 可整体撤销。',
  });
}

/** 排版整理：8px 栅格对齐 + 收进画布 + 同行对齐 + 消除重叠（一步撤销） */
function t_tidy_layout(a = {}) {
  const page = findPage(a.page);
  if (!page) return badRes(a.page ? `找不到页面「${a.page}」` : '当前没有打开任何页面');
  const canvas = project.data?.meta?.canvas || { w: 1024, h: 600 };
  const W = Number(canvas.w) || 1024;
  const H = Number(canvas.h) || 600;
  const widgets = (page.widgets || []).slice();
  if (!widgets.length) return okRes(`「${page.name}」没有控件，不用整理`, { pageId: page.id, changed: 0 });
  const box = new Map();
  const notes = [];
  widgets.forEach(w => {
    let x = snap(w.x), y = snap(w.y);
    let cw = Math.max(GRID, snap(w.w)), ch = Math.max(GRID, snap(w.h));
    if (cw > W) cw = W;
    if (ch > H) ch = H;
    x = Math.max(0, Math.min(W - cw, x));
    y = Math.max(0, Math.min(H - ch, y));
    box.set(w.id, { x, y, w: cw, h: ch });
  });
  // 同一行（y 差 ≤ 6）统一到行顶
  const sorted = widgets.slice().sort((p, q) => (box.get(p.id).y - box.get(q.id).y) || (box.get(p.id).x - box.get(q.id).x));
  for (let i = 0; i < sorted.length; i++) {
    const bi = box.get(sorted[i].id);
    for (let j = i + 1; j < sorted.length; j++) {
      const bj = box.get(sorted[j].id);
      if (Math.abs(bj.y - bi.y) <= 6) bj.y = bi.y;
    }
  }
  // 消除重叠：往下 → 往右 → 往上 → 往左 找第一个放得下的空位；都放不下就压到最下面
  let moved = 0;
  const fitsAt = (t, self) => t.x >= 0 && t.y >= 0 && t.x + t.w <= W && t.y + t.h <= H
    && ![...box.values()].some(o => o !== self && rectHit(o, t));
  for (let pass = 0; pass < 80; pass++) {
    let dirty = false;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const A = box.get(sorted[i].id), B = box.get(sorted[j].id);
        if (!rectHit(A, B)) continue;
        dirty = true;
        const cands = [
          { x: B.x, y: snap(A.y + A.h + CARD_GAP) },
          { x: snap(A.x + A.w + CARD_GAP), y: B.y },
          { x: B.x, y: snap(A.y - B.h - CARD_GAP) },
          { x: snap(A.x - B.w - CARD_GAP), y: B.y },
        ];
        let placed = false;
        for (const c of cands) {
          const t = {
            x: Math.max(0, Math.min(W - B.w, c.x)), y: Math.max(0, Math.min(H - B.h, c.y)),
            w: B.w, h: B.h,
          };
          if (fitsAt(t, B)) { B.x = t.x; B.y = t.y; placed = true; break; }
        }
        if (!placed) {
          // 四邻都放不下：从左上角按 8px 步长扫描第一个空位
          let spot = null;
          for (let y = 0; !spot && y + B.h <= H; y += GRID) {
            for (let x = 0; x + B.w <= W; x += GRID) {
              const t = { x, y, w: B.w, h: B.h };
              if (fitsAt(t, B)) { spot = t; break; }
            }
          }
          if (spot) { B.x = spot.x; B.y = spot.y; }
          else B.y = snap(Math.max(0, Math.min(H - B.h, A.y + A.h + CARD_GAP)));
        }
      }
    }
    if (!dirty) break;
  }
  // 改控件前先切到目标页：updateWidgets 只作用在当前页上
  if (page.id !== project.currentPage()?.id) project.setCurrentPage(page.id);
  widgets.forEach(w => {
    const b = box.get(w.id);
    if (w.x === b.x && w.y === b.y && w.w === b.w && w.h === b.h) return;
    project.updateWidgets([w.id], { x: b.x, y: b.y, w: b.w, h: b.h });
    moved++;
  });
  // 对齐完再自检一遍，把问题一并回给模型
  const check = inspectPage(page);
  if (moved) project.commit('AI 排版整理（' + moved + ' 个控件）');
  const left = check.issues.filter(i => i.level === 'error');
  return okRes(`「${page.name}」整理完成：对齐 8px 栅格、收进画布、消除重叠，调整 ${moved} 个控件${left.length ? '；还剩 ' + left.length + ' 个问题见 data.issues' : ''}`, {
    pageId: page.id, changed: moved, issues: check.issues.slice(0, 20),
  });
}

/** 排版自检（只读）：出界 / 重叠 / 没对齐 8px / 字号 / 配色数量 / 密度 */
function inspectPage(page) {
  const canvas = project.data?.meta?.canvas || { w: 1024, h: 600 };
  const W = Number(canvas.w) || 1024;
  const H = Number(canvas.h) || 600;
  const widgets = page.widgets || [];
  const issues = [];
  const colors = new Set();
  const fonts = new Set();
  widgets.forEach(w => {
    const nm = w.name || w.type;
    if (w.x < 0 || w.y < 0 || w.x + w.w > W || w.y + w.h > H) {
      issues.push({ level: 'error', widgetId: w.id, message: `「${nm}」超出画布（x${w.x},y${w.y},${w.w}×${w.h}，画布 ${W}×${H}）` });
    }
    if ((w.x % GRID) || (w.y % GRID) || (w.w % GRID) || (w.h % GRID)) {
      issues.push({ level: 'warn', widgetId: w.id, message: `「${nm}」没有对齐 ${GRID}px 栅格（${w.x},${w.y},${w.w}×${w.h}）` });
    }
    const fs = Number((w.props || {}).fontSize);
    if (fs && (fs < 10 || fs > 32)) issues.push({ level: 'warn', widgetId: w.id, message: `「${nm}」字号 ${fs} 超出 10~32` });
    if (fs) fonts.add(fs);
    Object.entries(w.props || {}).forEach(([k, v]) => {
      if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) && /color/i.test(k)) colors.add(v.toLowerCase());
    });
  });
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const A = widgets[i], B = widgets[j];
      if (!rectHit(A, B)) continue;
      const area = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)) * Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
      issues.push({ level: 'error', widgetId: B.id, message: `「${A.name || A.type}」和「${B.name || B.type}」重叠 ${Math.round(area)}px²` });
    }
  }
  if (colors.size > 6) issues.push({ level: 'warn', message: `这个页面用了 ${colors.size} 种颜色（建议 ≤3 类：背景 + 主色 + 状态色）` });
  if (fonts.size > 4) issues.push({ level: 'warn', message: `这个页面用了 ${fonts.size} 种字号（建议标题 24 / 区块 16 / 正文 14 / 小字 12）` });
  if (widgets.length > 18) issues.push({ level: 'warn', message: `控件 ${widgets.length} 个，偏密（建议 ≤15，重要信息优先）` });
  return { canvas: { w: W, h: H }, widgets, issues, colors: [...colors], fonts: [...fonts].sort((a, b) => a - b) };
}

function t_inspect_layout(a = {}) {
  const page = findPage(a.page);
  if (!page) return badRes(a.page ? `找不到页面「${a.page}」` : '当前没有打开任何页面');
  const r = inspectPage(page);
  const errs = r.issues.filter(i => i.level === 'error');
  const warns = r.issues.filter(i => i.level === 'warn');
  const head = errs.length
    ? `${page.name}：${errs.length} 个必改问题、${warns.length} 个建议｜${errs.slice(0, 4).map(i => i.message).join('；')}`
    : `${page.name}：排版检查通过（${r.widgets.length} 个控件，对齐 ${GRID}px、无重叠、无出界）${warns.length ? '｜' + warns.length + ' 个建议：' + warns.slice(0, 3).map(i => i.message).join('；') : ''}`;
  return okRes(head, {
    pageId: page.id, canvas: r.canvas, colors: r.colors, fonts: r.fonts,
    issues: r.issues.slice(0, 40),
    widgets: r.widgets.map(w => ({ id: w.id, name: w.name || w.type, type: w.type, x: w.x, y: w.y, w: w.w, h: w.h })),
  });
}

/* ════════════════════════════════════════════════════════════════
 * 2. 工具执行器
 * ════════════════════════════════════════════════════════════════ */

/* ── 2.1 只读 ─────────────────────────────────────────────────── */

function t_get_project(a = {}) {
  const cur = project.currentPage();
  const meta = project.data?.meta || {};
  let langs = { default: '', langs: [] };
  try {
    const s = i18nState();
    langs = { default: s.default || '', langs: (s.langs || []).map(l => l.code) };
  } catch { /* 老工程没 i18n，无所谓 */ }
  const brief = {
    name: meta.name || '',
    canvas: meta.canvas || {},
    pages: allPages().map(p => ({ id: p.id, name: p.name, type: p.type, widgets: (p.widgets || []).length })),
    currentPageId: cur?.id || '',
    selected: getSelection(),
    variables: allVars().map(v => ({ name: v.name, type: v.type, address: v.address || '', retain: !!v.retain })),
    alarms: allAlarms().length,
    scripts: allScripts().map(s => ({ id: s.id, name: s.name, trig: s.trig, enabled: s.enabled !== false })),
    languages: langs,
    canUndo: history.canUndo(),
  };
  if (!a.page && !a.widgetId) {
    return okRes(`工程「${brief.name || '(未命名)'}」：${brief.pages.length} 页 / ${brief.variables.length} 变量 / ${brief.alarms} 报警 / ${brief.scripts.length} 脚本`, { project: brief });
  }
  const r = requirePage(a.page, 'get_project');
  if (r.err) return r.err;
  const p = r.page;
  const pageInfo = {
    id: p.id, name: p.name, type: p.type, title: p.title || '',
    popupW: p.popupW, popupH: p.popupH, showClose: p.showClose !== false,
    baseIds: Array.isArray(p.baseIds) ? p.baseIds : [],
  };
  // 大查询只回"轻简报"：页面名 + 画布，别把 48 个变量/脚本再塞一遍（重发历史时这最费钱）
  const lightBrief = {
    name: brief.name, canvas: brief.canvas,
    currentPageId: brief.currentPageId,
    pages: brief.pages.map(x => x.name + '(' + x.id + ')'),
    pageCount: brief.pages.length, varCount: brief.variables.length,
    alarmCount: brief.alarms, scriptCount: brief.scripts.length,
  };
  if (a.widgetId) {
    const w = findWidgetOn(p, String(a.widgetId));
    if (!w) {
      // 关键：把真实清单（名称 = id）回给模型，否则它只能拿新字符串再猜一轮（一轮就是几千 token）
      const all = p.widgets || [];
      const shown = all.slice(0, 24);
      const rows = shown.map(x => `「${x.name || x.type}」= ${x.id}`);
      const more = all.length > shown.length ? `（这页共 ${all.length} 个控件，先列前 ${shown.length} 个）` : '';
      return badRes(`页面「${p.name}」里没有控件「${a.widgetId}」${more}`, {
        pageId: p.id, pageName: p.name, count: all.length,
        widgets: shown.map(x => ({ id: x.id, type: x.type, name: x.name || '' })),
        hint: rows.join('；') + '｜上面每行是「控件名称 = 控件id」；widgetId 填 id 或名称都行（名称已兼容）',
      });
    }
    return okRes(`控件「${w.name || w.type}」（${w.id}）`, { project: lightBrief, page: pageInfo, widget: w });
  }
  // 整页一次读全：默认带每个控件的属性值（省掉"一个控件一轮"的来回）；太长才在尾部降级成键名
  const budget = 12000;
  let used = 0;
  let degraded = 0;
  pageInfo.widgets = (p.widgets || []).map(w => {
    const o = { id: w.id, type: w.type, name: w.name || '', x: w.x, y: w.y, w: w.w, h: w.h, z: w.z };
    if (w.locked) o.locked = true;
    const pk = Object.keys(w.props || {});
    const bd = {};
    for (const k of Object.keys(w.bindings || {})) {
      const val = w.bindings[k];
      if (val === '' || val === null || val === undefined) continue;
      const arr = Array.isArray(val) ? val.filter(x => x !== '' && x !== null && x !== undefined) : null;
      const v = arr && !arr.length ? '' : (arr || val);
      if (v !== '') bd[k] = v;
    }
    if (Object.keys(bd).length) o.bindings = slimData(bd);
    if (Array.isArray(w.actions) && w.actions.length) o.actions = w.actions.map(x => ({ trigger: x.trigger, type: x.type, params: x.params }));
    const propsObj = {};
    pk.forEach(k => { propsObj[k] = slimData(w.props[k]); });
    const full = JSON.stringify({ ...o, props: propsObj }).length;
    if (String(a.detail || '').toLowerCase() === 'brief' || (used >= budget && used + full > budget)) {
      if (pk.length) o.props = pk;
      if (!o.bindings && Object.keys(bd).length) o.bindings = slimData(bd);
      degraded++;
    } else {
      if (pk.length) o.props = propsObj;
      used += full;
    }
    return o;
  });
  pageInfo.widgetCount = pageInfo.widgets.length;
  const note = degraded ? `（整页太大，尾部 ${degraded} 个控件只给属性键名，要看值用 widgetId 查）` : '';
  return okRes(`页面「${p.name}」：${pageInfo.widgets.length} 个控件整页读全（含属性值）${note}；改之前不必再逐个控件查`, { project: lightBrief, page: pageInfo });
}

function t_get_widget_catalog(a = {}) {
  const want = String(a.type || '').trim();
  if (want) {
    const def = registry.get(want);
    if (!def) return badRes(`没有「${want}」这种控件`, { types: registry.list().map(d => d.type) });
    return okRes(`${def.title}（${def.type}）的完整属性`, catalogEntry(def));
  }
  const list = registry.list().map(def => {
    const d = def.defaults || {};
    return { type: def.type, title: def.title, w: Number(d.w) || 0, h: Number(d.h) || 0, hidden: !!def.hidden };
  });
  return okRes(`共 ${list.length} 种控件（要完整属性，再按 type 查一次）`, { widgets: list });
}

function t_list_pages() {
  return okRes(`${allPages().length} 个页面`, {
    pages: allPages().map(p => ({
      id: p.id, name: p.name, type: p.type, typeCn: PAGE_TYPES[p.type] || p.type,
      widgets: (p.widgets || []).length, title: p.title || '', baseIds: p.baseIds || [],
    })),
  });
}

function t_list_vars() {
  return okRes(`${allVars().length} 个变量`, {
    variables: allVars().map(v => ({ name: v.name, type: v.type, address: v.address || '', value: v.value, len: v.len || 0, retain: !!v.retain })),
  });
}

function t_list_scripts() {
  return okRes(`${allScripts().length} 个脚本`, {
    scripts: allScripts().map(s => ({
      id: s.id, name: s.name, trig: s.trig, trigCn: SCRIPT_TRIG_CN[s.trig] || s.trig,
      ms: s.ms, variable: s.variable || '', op: s.op || '', value: s.value, enabled: s.enabled !== false,
      code: String(s.code || '').slice(0, 1200),
    })),
  });
}

function t_list_alarms() {
  return okRes(`${allAlarms().length} 条报警`, {
    alarms: allAlarms().map(a => ({
      id: a.id, name: a.name || '', text: a.text || '', variable: a.variable || '', op: a.op || '>=', value: a.value,
      level: a.level || 'alarm', levelCn: ALARM_LEVEL_CN[a.level] || a.level, delaySec: a.delaySec || 0, enabled: a.enabled !== false,
    })),
  });
}

/* ── 2.2 页面 ─────────────────────────────────────────────────── */

function t_add_page(a = {}) {
  const type = PAGE_TYPES[a.type] ? String(a.type) : 'page';
  const page = project.addPage(type);                       // 内部已 commit + 切当前页
  const nm = a.name ? project.uniquePageName(String(a.name)) : project.uniquePageName(page.name);
  page.name = nm;
  if (a.title !== undefined) page.title = String(a.title || '');
  if (type === 'popup') {
    page.popupW = clampNum(a.popupW, 120, 4096, page.popupW || 420);
    page.popupH = clampNum(a.popupH, 80, 4096, page.popupH || 240);
    if (a.showClose !== undefined) page.showClose = !!a.showClose;
  }
  if (Array.isArray(a.baseIds) && type === 'page') {
    const baseIds = allPages().filter(p => p.type === 'base').map(p => p.id);
    const picked = a.baseIds.map(String).filter(id => baseIds.includes(id));
    if (picked.length) project.setPageBases(page.id, picked);   // 会再 commit 一次；有则用
    else if (a.baseIds.length) return okRes(`新建页面「${nm}」，但给的 baseIds 里没有有效的公共底，已忽略`, { pageId: page.id, name: nm, type });
  }
  project.touch();
  return okRes(`新建${PAGE_TYPES[type]}「${nm}」`, { pageId: page.id, name: nm, type });
}

function t_update_page(a = {}) {
  const r = requirePage(a.page, 'update_page');
  if (r.err) return r.err;
  const p = r.page;
  const changed = [];
  if (a.name !== undefined) {
    const nm = project.uniquePageName(String(a.name), [p.name]);
    p.name = nm;
    changed.push(`名称→${nm}`);
  }
  if (a.title !== undefined) { p.title = String(a.title || ''); changed.push('标题'); }
  if (a.type !== undefined && PAGE_TYPES[a.type] && a.type !== p.type) {
    p.type = String(a.type);
    changed.push(`类型→${PAGE_TYPES[a.type]}`);
  }
  if (a.popupW !== undefined) { p.popupW = clampNum(a.popupW, 120, 4096, p.popupW || 420); changed.push('宽'); }
  if (a.popupH !== undefined) { p.popupH = clampNum(a.popupH, 80, 4096, p.popupH || 240); changed.push('高'); }
  if (a.showClose !== undefined) { p.showClose = !!a.showClose; changed.push('显示关闭按钮'); }
  if (Array.isArray(a.baseIds)) {
    const baseIds = allPages().filter(x => x.type === 'base').map(x => x.id);
    project.setPageBases(p.id, a.baseIds.map(String).filter(id => baseIds.includes(id)));
    changed.push('公共底');
  }
  if (!changed.length) return badRes('update_page 没有任何要改的字段');
  project.touch();
  bus.emit('page:current', { pageId: project.currentPage()?.id || '' });
  return okRes(`页面「${p.name}」已更新：${changed.join('、')}`, { pageId: p.id, name: p.name, type: p.type });
}

function t_delete_page(a = {}) {
  const guard = needDestructive('删除页面');
  if (guard) return guard;
  const r = requirePage(a.page, 'delete_page');
  if (r.err) return r.err;
  const p = r.page;
  const name = p.name;
  project.deletePage(p.id);
  return okRes(`已删除${PAGE_TYPES[p.type] || '页面'}「${name}」及其 ${(p.widgets || []).length} 个控件`, { deletedPageId: p.id });
}

function t_set_current_page(a = {}) {
  const r = requirePage(a.page, 'set_current_page');
  if (r.err) return r.err;
  project.setCurrentPage(r.page.id);
  return okRes(`已切到「${r.page.name}」`, { pageId: r.page.id });
}

/* ── 2.3 控件 ─────────────────────────────────────────────────── */

/** 动作必须在落盘前解析成属性面板和运行态共用的格式。 */
function normalizeActions(list, def, binding = '') {
  if (list === undefined) return {};
  if (!Array.isArray(list)) return { error: 'actions 必须是数组' };
  const actions = [];
  for (const raw of list) {
    const type = String(raw?.type || '');
    const schema = Object.hasOwn(ACTION_DEFS, type) ? ACTION_DEFS[type].params : null;
    if (!schema || !def?.actions?.includes(type)) return { error: '此控件不支持动作「' + type + '」' };
    if (raw.trigger && raw.trigger !== 'click') return { error: '动作 ' + type + ' 的 trigger 应为 click' };
    const input = raw.params && typeof raw.params === 'object' ? raw.params : {};
    const params = {};
    if (schema.page) {
      const ref = input.page || input.pageId || input.targetPage || input.targetPageId || input.target
        || raw.page || raw.pageId || raw.targetPage || raw.targetPageId || raw.target;
      const pg = ref && findPage(String(ref).trim());
      const kind = type === 'showPopup' ? 'popup' : 'page';
      if (!pg || pg.type !== kind) return { error: type + ' 需要 params.page 指向已存在的' + (kind === 'popup' ? '弹窗' : '普通页') + (ref ? '，收到「' + ref + '」' : '') };
      params.page = pg.id;
    }
    if (schema.variable) {
      const variable = String(input.variable || input.variableName || raw.variable || raw.variableName || binding || '').trim();
      if (!varNames().includes(variable)) return { error: type + ' 需要 params.variable 为已存在的变量名' + (variable ? '，收到「' + variable + '」' : '') };
      params.variable = variable;
    }
    if (schema.value) {
      const value = input.value ?? raw.value;
      const scalar = item => ['string', 'number', 'boolean'].includes(typeof item);
      if (!scalar(value) && !(Array.isArray(value) && value.every(scalar))) {
        return { error: type + ' 需要 params.value，可填写数字、布尔值、文本或数组' };
      }
      params.value = value;
    }
    actions.push({ trigger: 'click', type, params });
  }
  return { actions };
}

function applyWidgetProps(widget, def, props, warnings) {
  const whitelist = propWhitelist(def);
  const entries = Object.entries(props && typeof props === 'object' ? props : {});
  // ⚠ 顺序有讲究：dispType 先、fmt 最后。
  //   · 先写 dispType，后面写 decimals 时 project.updateWidgetProp 才知道"当前是整数"，
  //     按整数规则补 fmt（只给 decimals 不给 fmt 的情况，见 updateWidgetProp 里的注释）；
  //   · fmt 最后写，显式给的格式永远压过自动补出来的那个。
  const rank = (k) => (k === 'dispType' ? 0 : k === 'fmt' ? 2 : 1);
  entries.sort((a, b) => rank(a[0]) - rank(b[0]));
  entries.forEach(([k, v]) => {
    if (k === 'w' || k === 'h') return;                        // 尺寸走 updateWidgets
    if (!whitelist.has(k)) { warnings.push(`${def.type} 没有属性「${k}」`); return; }
    project.updateWidgetProp(widget.id, k, v);
  });
}

/** 变量引用解析：字符串=必须已存在；{name,type} 或 [name,type]=不存在就顺手建（省一轮 add_vars） */
function resolveVarRef(ref, warnings) {
  const raw = typeof ref === 'string' || typeof ref === 'number' ? { name: String(ref) } : (Array.isArray(ref) ? { name: String(ref[0] || ''), type: String(ref[1] || '') } : (ref || {}));
  const name = String(raw.name || '').trim();
  if (!name) return { err: '变量名为空' };
  const has = varNames().includes(name);
  if (has) {
    if (raw.type && !VAR_TYPES.includes(String(raw.type))) (warnings || []).push(`变量「${name}」已存在，类型按原样保留（没改成 ${raw.type}）`);
    return { name };
  }
  if (!raw.type) return { err: `变量「${name}」不在变量表里。先在同一个回合里 add_vars 建它，或者把 variable 写成 {"name":"${name}","type":"real"} 让我顺手建。`, variables: varNames() };
  const type = String(raw.type).toLowerCase();
  if (!VAR_TYPES.includes(type)) return { err: `变量「${name}」类型「${raw.type}」不认识（可用 bool/int/real/string）` };
  const created = project.addVariable();
  if (!created) return { err: `创建变量「${name}」失败` };
  project.updateVariable(created.name, { name, type });
  (warnings || []).push(`变量「${name}:${type}」原来不存在，已自动创建（顺手建的，请核对类型/地址）`);
  return { name, created: true };
}

function t_add_widget(a = {}) {
  const r = requirePage(a.page, 'add_widget');
  if (r.err) return r.err;
  const page = r.page;
  const warnings = [];
  const isBatch = Array.isArray(a.items) && a.items.length > 0;

  // 单控件模式：type 必填；批量模式：每个 item 自带 type
  let def0 = null;
  if (!isBatch) {
    const type0 = String(a.type || '').trim();
    def0 = registry.get(type0);
    if (!def0) return badRes(`没有「${type0 || '(空)'}」这种控件，先用 get_widget_catalog 查类型 id`, { types: registry.list().map(d => d.type) });
  }

  if (page.id !== project.currentPage()?.id) project.setCurrentPage(page.id);

  const created = [];
  const commitLabel = isBatch ? `AI 批量画 ${a.items.length} 个控件` : `AI 添加${def0.title}${Math.max(1, Math.min(40, Math.trunc(Number(a.count) || 1))) > 1 ? ` ×${Math.max(1, Math.min(40, Math.trunc(Number(a.count) || 1)))}` : ''}`;

  /** 画一个控件；spec 形如 {type,x,y,w,h,name,props,variable,channels,actions,locked} */
  const drawOne = (spec, idx) => {
    const type = String(spec.type || '').trim();
    const def = registry.get(type);
    if (!def) { warnings.push(`第 ${idx + 1} 个：没有「${type || '(空)'}」这种控件，已跳过`); return null; }
    const d = def.defaults || {};
    const x = Number.isFinite(Number(spec.x)) ? Math.round(Number(spec.x)) : 24;
    const y = Number.isFinite(Number(spec.y)) ? Math.round(Number(spec.y)) : 24;
    const w = clampNum(spec.w, 4, 4096, Number(d.w) || 100);
    const h = clampNum(spec.h, 4, 4096, Number(d.h) || 40);
    let varName = '';
    if (spec.variable !== undefined && spec.variable !== null && spec.variable !== '') {
      const vr = resolveVarRef(spec.variable, warnings);
      if (vr.err) { warnings.push(`第 ${idx + 1} 个：${vr.err}`); return null; }
      varName = vr.name;
    }
    let channels = null;
    if (Array.isArray(spec.channels) && spec.channels.length) {
      channels = [];
      for (const ch of spec.channels) {
        if (!ch) { channels.push(''); continue; }
        const vr = resolveVarRef(ch, warnings);
        if (vr.err) { warnings.push(`第 ${idx + 1} 个：${vr.err}`); return null; }
        channels.push(vr.name);
      }
    }
    const actionResult = normalizeActions(spec.actions, def, varName);
    if (actionResult.error) { warnings.push('第 ' + (idx + 1) + ' 个：' + actionResult.error); return null; }
    const widget = project.addWidget(type, x, y);   // 内部 commit('添加控件')，外层 batchCommit 会吞掉
    if (!widget) { warnings.push(`第 ${idx + 1} 个：添加「${type}」失败`); return null; }
    project.updateWidgets([widget.id], { w, h });
    const nm = String(spec.name || '').trim();
    if (nm) project.updateWidgets([widget.id], { name: nm });
    applyWidgetProps(widget, def, spec.props, warnings);
    if (varName) project.updateWidgetField(widget.id, 'bindings.variable', varName);
    if (channels) {
      project.updateWidgetField(widget.id, 'bindings.variables', channels);
      if (!varName && channels[0]) project.updateWidgetField(widget.id, 'bindings.startVar', channels[0]);
    }
    if (actionResult.actions) project.updateWidgetActions(widget.id, actionResult.actions);
    if (spec.locked !== undefined) project.updateWidgets([widget.id], { locked: !!spec.locked });
    const row = { id: widget.id, type, name: widget.name || '', x: widget.x, y: widget.y };
    created.push(row);
    return row;
  };

  if (isBatch) {
    // 整页一次画完：一个工具调用画 N 个控件、只占 1 步撤销
    batchCommit(commitLabel, () => { a.items.forEach((it, i) => drawOne(it && typeof it === 'object' ? { ...a, ...it } : { ...a, type: it }, i)); });
    if (!created.length) return badRes(`一个控件都没建成：${warnings[0] || '原因未知'}`, { warnings, variables: varNames() });
    return okRes(`在「${page.name}」一次画了 ${created.length} 个控件`, { pageId: page.id, widgets: created }, { warnings: warnings.length ? warnings : undefined });
  }

  // 单控件模式（保留原来的 count/layout/gap/cols 网格复制语义）
  const type0 = String(a.type || '').trim();
  const count = Math.max(1, Math.min(40, Math.trunc(Number(a.count) || 1)));
  const d0 = def0.defaults || {};
  const w0 = clampNum(a.w, 4, 4096, Number(d0.w) || 100);
  const h0 = clampNum(a.h, 4, 4096, Number(d0.h) || 40);
  const gap = clampNum(a.gap, 0, 400, 16);
  const cols = Math.max(1, Math.min(30, Math.trunc(Number(a.cols) || Math.ceil(Math.sqrt(count)) || 1)));
  const layout = ['row', 'col', 'grid'].includes(a.layout) ? a.layout : (count > 1 ? 'grid' : 'row');
  const ax = Number.isFinite(Number(a.x)) ? Number(a.x) : 24;
  const ay = Number.isFinite(Number(a.y)) ? Number(a.y) : 24;
  const specs = [];
  for (let i = 0; i < count; i++) {
    let x = ax; let y = ay;
    if (layout === 'row') { x = ax + i * (w0 + gap); y = ay; }
    else if (layout === 'col') { x = ax; y = ay + i * (h0 + gap); }
    else { x = ax + (i % cols) * (w0 + gap); y = ay + Math.floor(i / cols) * (h0 + gap); }
    specs.push({ ...a, type: type0, x, y, w: w0, h: h0, name: count > 1 && a.name ? `${a.name}${i + 1}` : a.name });
  }
  batchCommit(commitLabel, () => specs.forEach((s, i) => drawOne(s, i)));
  if (!created.length) return badRes(`一个控件都没建成：${warnings[0] || '原因未知'}`, { warnings, variables: varNames() });
  return okRes(`在「${page.name}」上加了 ${created.length} 个${def0.title}`, { pageId: page.id, widgets: created }, { warnings: warnings.length ? warnings : undefined });
}
/** 找出要改的控件：ids 优先，其次 name/type，最后"当前选中" */
/** 把一组「控件 id 或名称」解析成该页上的控件；模型经常两种混用，别让它为名称白跑一轮 */
function resolveWidgetRefs(page, refs) {
  const list = [];
  const missing = [];
  (refs || []).forEach(ref => {
    const w = findWidgetOn(page, ref);
    if (w && (page.widgets || []).includes(w)) list.push(w);
    else missing.push(String(ref));
  });
  return { list, missing };
}

function resolveTargets(page, a) {
  const ids = Array.isArray(a.ids) ? a.ids.map(String) : [];
  const own = page.widgets || [];
  if (ids.length) {
    const r = resolveWidgetRefs(page, ids);
    return r;
  }
  if (a.name) {
    const nm = String(a.name);
    const hit = own.filter(w => String(w.name || '') === nm);
    if (hit.length) return { list: hit, missing: [] };
    const loose = resolveWidgetRefs(page, [nm]);       // 名称带空格/大小写不同也认
    return { list: loose.list, missing: loose.missing };
  }
  if (a.type) {
    const tp = String(a.type);
    return { list: own.filter(w => w.type === tp), missing: [] };
  }
  const sel = getSelection();
  return { list: own.filter(w => sel.includes(w.id)), missing: [] };
}

function t_update_widget(a = {}) {
  const r = requirePage(a.page, 'update_widget');
  if (r.err) return r.err;
  const page = r.page;
  if (page.id !== project.currentPage()?.id) project.setCurrentPage(page.id);
  const { list, missing } = resolveTargets(page, a);
  const warnings = [];
  if (missing.length) warnings.push(`这些控件 id 不在「${page.name}」上：${missing.join('、')}`);
  if (!list.length) return badRes('没找到要改的控件：给 ids / name / type，或者先在画布上选中它', { pageId: page.id, widgets: (page.widgets || []).map(w => ({ id: w.id, type: w.type, name: w.name })) });

  if (a.variable !== undefined && a.variable !== null && String(a.variable) !== '' && !varNames().includes(String(a.variable))) {
    return badRes(`变量「${a.variable}」不在变量表里`, { variables: varNames() });
  }
  let channels = null;
  if (Array.isArray(a.channels)) {
    channels = a.channels.map(String);
    const bad = channels.filter(n => n && !varNames().includes(n));
    if (bad.length) return badRes(`波形通道变量不在变量表：${bad.join('、')}`, { variables: varNames() });
  }

  const geo = {};
  ['x', 'y', 'w', 'h'].forEach(k => { if (a[k] !== undefined) geo[k] = clampNum(a[k], -20000, 20000, undefined); });
  if (a.name !== undefined) geo.name = String(a.name);
  if (a.locked !== undefined) geo.locked = !!a.locked;

  const actionPlans = list.map(w => normalizeActions(a.actions, registry.get(w.type),
    a.variable === undefined ? w.bindings?.variable : String(a.variable || '')));
  const invalid = actionPlans.findIndex(item => item.error);
  if (invalid >= 0) return badRes('控件「' + list[invalid].name + '」：' + actionPlans[invalid].error,
    { hint: '跳转用 {type:"gotoPage",params:{page:"页面名或ID"}}；赋值用 {type:"setValue",params:{variable:"变量名",value:0}}。' });
  list.forEach((w, i) => {
    if (Object.keys(geo).length) project.updateWidgets([w.id], geo);
    const def = registry.get(w.type);
    if (a.props && typeof a.props === 'object') applyWidgetProps(w, def || { type: w.type, props: [], defaults: {} }, a.props, warnings);
    if (a.variable !== undefined) project.updateWidgetField(w.id, 'bindings.variable', String(a.variable || ''));
    if (channels) project.updateWidgetField(w.id, 'bindings.variables', channels);
    const { actions } = actionPlans[i];
    if (actions) {
      const bound = w.bindings?.variable;
      if (w.followBind && bound && actions.some(act => act.params.variable && act.params.variable !== bound)) {
        w.followBind = false;
      }
      project.updateWidgetActions(w.id, actions);
    }
  });
  project.commit(`AI 修改${list.length > 1 ? ` ${list.length} 个控件` : '控件'}`);
  return okRes(`改了 ${list.length} 个控件`, { pageId: page.id, widgets: list.map(w => ({ id: w.id, type: w.type, name: w.name, ...(a.actions !== undefined ? { actions: w.actions } : {}) })) }, { warnings: warnings.length ? warnings : undefined });
}

function t_delete_widgets(a = {}) {
  const guard = needDestructive('删除控件');
  if (guard) return guard;
  const r = requirePage(a.page, 'delete_widgets');
  if (r.err) return r.err;
  const page = r.page;
  if (page.id !== project.currentPage()?.id) project.setCurrentPage(page.id);
  const refs = Array.isArray(a.ids) ? a.ids.map(String) : [];
  const { list: targets, missing } = resolveWidgetRefs(page, refs);
  const ids = targets.map(w => w.id);
  if (!ids.length) {
    return badRes(`delete_widgets 里这些都没在「${page.name}」上：${(missing.length ? missing : refs).join('、')}`,
      { pageId: page.id, widgets: (page.widgets || []).map(w => ({ id: w.id, name: w.name })) });
  }
  const names = targets.map(w => w.name || w.type);
  project.deleteWidgets(ids);
  return okRes(`删掉了 ${ids.length} 个控件：${names.join('、')}`, { pageId: page.id, ids }, { warnings: missing.length ? [`这些没找到、已跳过：${missing.join('、')}`] : undefined });
}

function t_select_widgets(a = {}) {
  const refs = Array.isArray(a.ids) ? a.ids.map(String) : [];
  const found = [];
  const missing = [];
  refs.forEach(ref => {
    let w = project.findWidget(ref);
    if (!w) {
      // 也支持填名称：跨所有页面按名称/类型找
      const hit = allPages().flatMap(p => (p.widgets || []).filter(x => {
        const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
        return norm(x.name) === norm(ref) || norm(x.type) === norm(ref);
      }));
      w = hit[0] || null;
    }
    if (w) found.push(w.id); else missing.push(ref);
  });
  if (!found.length) return badRes(`select_widgets 里这些都没找到：${missing.join('、')}`, { ids: missing });
  const first = project.findWidget(found[0]);
  const pg = pageOfWidget(first);
  if (pg && pg.id !== project.currentPage()?.id) project.setCurrentPage(pg.id);
  select(found);
  return okRes(`已在画布上选中 ${found.length} 个控件`, { ids: found, pageId: pg?.id || '' },
    { warnings: missing.length ? [`这些没找到、已跳过：${missing.join('、')}`] : undefined });
}

/* ── 2.4 变量 ─────────────────────────────────────────────────── */

function t_add_vars(a = {}) {
  const specs = Array.isArray(a.vars) ? a.vars : [];
  if (!specs.length) return badRes('add_vars 需要 vars 数组，例如 [{name:"启动按钮",type:"bool"}]');
  const warnings = [];
  const added = [];
  for (const raw of specs) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    if (!name) { warnings.push('有一条变量没给名字，跳过'); continue; }
    if (!/^[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5.%\[\]-]*$/.test(name)) { warnings.push(`变量名「${name}」含非法字符，跳过`); continue; }
    if (varNames().includes(name)) { warnings.push(`变量「${name}」已存在，跳过`); continue; }
    const type = VAR_TYPES.includes(raw.type) ? raw.type : 'bool';
    const v = project.addVariable();                                  // 内部 commit
    const patch = { name, type };
    if (raw.address !== undefined) patch.address = String(raw.address || '');
    if (raw.value !== undefined) patch.value = raw.value;
    if (raw.len !== undefined) patch.len = clampNum(raw.len, 0, 1024, 0);
    if (raw.retain !== undefined && !String(patch.address ?? v.address ?? '').trim()) patch.retain = !!raw.retain;
    try { project.updateVariable(v.name, patch); } catch (e) { warnings.push(`建「${name}」时出错：${e.message}`); }
    added.push({ name, type });
  }
  if (!added.length) return badRes(`一个都没建成${warnings.length ? '：' + warnings.join('；') : ''}`);
  return okRes(`新建 ${added.length} 个变量：${added.map(x => `${x.name}(${x.type})`).join('、')}`, { variables: added }, { warnings: warnings.length ? warnings : undefined });
}

function t_update_var(a = {}) {
  const name = String(a.name || '');
  if (!varNames().includes(name)) return badRes(`变量「${name}」不在变量表里`, { variables: varNames() });
  const patch = {};
  if (a.newName !== undefined) {
    const nn = String(a.newName || '').trim();
    if (!nn) return badRes('新名字不能是空的');
    if (varNames().includes(nn) && nn !== name) return badRes(`新名字「${nn}」已经有变量在用了`);
    patch.name = nn;
  }
  if (a.type !== undefined) {
    if (!VAR_TYPES.includes(a.type)) return badRes(`变量类型只能是 ${VAR_TYPES.join('/')}`);
    patch.type = a.type;
  }
  if (a.address !== undefined) patch.address = String(a.address || '');
  if (a.value !== undefined) patch.value = a.value;
  if (a.len !== undefined) patch.len = clampNum(a.len, 0, 1024, 0);
  if (!Object.keys(patch).length) return badRes('update_var 没有任何要改的字段');
  project.updateVariable(name, patch);
  const v = allVars().find(x => x.name === (patch.name || name));
  return okRes(`变量「${name}」已更新${patch.name ? `，改名为「${patch.name}」` : ''}`, { variable: v ? { name: v.name, type: v.type, address: v.address || '' } : null });
}

function t_delete_vars(a = {}) {
  const guard = needDestructive('删除变量');
  if (guard) return guard;
  const names = (Array.isArray(a.names) ? a.names.map(String) : []).filter(n => varNames().includes(n));
  if (!names.length) return badRes('delete_vars 需要 names，而且必须是变量表里有的名字', { variables: varNames() });
  const n = project.deleteVariables(names);
  return okRes(`删了 ${n} 个变量：${names.join('、')}（引用它们的绑定/动作/报警已一并清掉）`, { names });
}

/* ── 2.5 脚本 ─────────────────────────────────────────────────── */

function checkScriptCode(code) {
  const errs = [];
  const warns = [];
  const src = String(code || '');
  if (!src.trim()) errs.push('代码是空的');
  try {
    // 只编译不执行：和引擎一样按"函数体"解析（顶层 await/import 会在这里报 SyntaxError）
    // eslint-disable-next-line no-new-func
    new Function(src);
  } catch (e) {
    errs.push(`语法错误：${e.message}`);
  }
  if (/(^|[^\w.$])await\s/.test(src)) errs.push('脚本里不能用 await（引擎是同步执行，没有 async）');
  if (/(^|[^\w.$])import\s+[\w{*]/.test(src)) errs.push('脚本里不能用 import');
  if (/(^|[^\w.$])require\s*\(/.test(src)) errs.push('脚本里不能用 require');
  if (/(^|[^\w.$])process\./.test(src)) warns.push('脚本里没有 process');
  if (/(^|[^\w.$])(document|window|localStorage)\./.test(src)) warns.push('脚本里没有 DOM/浏览器 API');
  if (/while\s*\(\s*true\s*\)/.test(src)) warns.push('死循环会卡死整个界面（每 50ms 一个周期，跑不完就不会排下一次）');
  if (/\bhmi\.set\s*\(/.test(src)) warns.push('hmi.set 会真的把值写下去（运行态连 PLC 会真发报文）');
  if (src.length > 20000) warns.push('脚本很长（>2 万字符），现场不好维护');
  return { errs, warns };
}

function t_check_script(a = {}) {
  const code = String(a.code ?? '');
  const { errs, warns } = checkScriptCode(code);
  if (errs.length) return { ok: false, error: errs.join('；'), warnings: warns, data: { ok: false, errors: errs, warnings: warns } };
  return okRes(`语法 OK${warns.length ? `（${warns.length} 条提醒）` : ''}`, { ok: true, errors: [], warnings: warns }, { warnings: warns.length ? warns : undefined });
}

function t_add_script(a = {}) {
  const code = String(a.code ?? '');
  if (!code.trim()) return badRes('add_script 需要 code（脚本正文）');
  const { errs } = checkScriptCode(code);
  if (errs.length) return badRes(`脚本存不进去，先改好：${errs.join('；')}`, { errors: errs });
  const trig = SCRIPT_TRIGS.includes(a.trig) ? a.trig : 'interval';
  const patch = { trig, code };
  if (a.name !== undefined) patch.name = String(a.name || '');
  if (a.ms !== undefined) patch.ms = clampNum(a.ms, 10, 3600000, 1000);
  if (a.enabled !== undefined) patch.enabled = !!a.enabled;
  if (trig === 'change' || trig === 'cond') {
    const vn = String(a.variable || '');
    if (!varNames().includes(vn)) return badRes(`${SCRIPT_TRIG_CN[trig]} 的脚本必须指定 variable（变量表里的名字）`, { variables: varNames() });
    patch.variable = vn;
    if (trig === 'cond') {
      if (a.op !== undefined && !CMP_OPS.includes(a.op)) return badRes(`比较符只能是 ${CMP_OPS.join(' ')}`);
      patch.op = CMP_OPS.includes(a.op) ? a.op : '==';
      if (a.value !== undefined) patch.value = a.value;
    }
  } else if (a.variable !== undefined && String(a.variable) !== '' && varNames().includes(String(a.variable))) {
    patch.variable = String(a.variable);
  }
  if (trig === 'interval' && patch.ms === undefined) patch.ms = 1000;
  const s = project.addScript(patch);                      // 内部 commit
  bus.emit('scripts:changed', { id: s.id });
  return okRes(`新建脚本「${s.name}」（${SCRIPT_TRIG_CN[trig]}）`, { id: s.id, name: s.name, trig });
}

function t_update_script(a = {}) {
  const id = String(a.id || '');
  const s = project.getScript(id);
  if (!s) return badRes(`没有脚本 ${id || '(空)'}`, { scripts: allScripts().map(x => ({ id: x.id, name: x.name })) });
  const patch = {};
  if (a.name !== undefined) patch.name = String(a.name || '');
  if (a.trig !== undefined) {
    if (!SCRIPT_TRIGS.includes(a.trig)) return badRes(`触发方式只能是 ${SCRIPT_TRIGS.join('/')}`);
    patch.trig = a.trig;
  }
  if (a.code !== undefined) {
    const { errs } = checkScriptCode(a.code);
    if (errs.length) return badRes(`脚本没改：${errs.join('；')}`, { errors: errs });
    patch.code = String(a.code);
  }
  if (a.ms !== undefined) patch.ms = clampNum(a.ms, 10, 3600000, s.ms || 1000);
  if (a.variable !== undefined) {
    const vn = String(a.variable || '');
    if (vn && !varNames().includes(vn)) return badRes(`变量「${vn}」不在变量表里`, { variables: varNames() });
    patch.variable = vn;
  }
  if (a.op !== undefined) {
    if (!CMP_OPS.includes(a.op)) return badRes(`比较符只能是 ${CMP_OPS.join(' ')}`);
    patch.op = a.op;
  }
  if (a.value !== undefined) patch.value = a.value;
  if (a.enabled !== undefined) patch.enabled = !!a.enabled;
  if (!Object.keys(patch).length) return badRes('update_script 没有任何要改的字段');
  project.updateScript(id, patch);
  bus.emit('scripts:changed', { id });
  return okRes(`脚本「${patch.name || s.name}」已更新`, { id, patch: Object.keys(patch) });
}

function t_delete_script(a = {}) {
  const guard = needDestructive('删除脚本');
  if (guard) return guard;
  const id = String(a.id || '');
  const s = project.getScript(id);
  if (!s) return badRes(`没有脚本 ${id || '(空)'}`);
  project.deleteScript(id);
  bus.emit('scripts:changed', { id });
  return okRes(`已删除脚本「${s.name}」`, { id });
}

/* ── 2.6 报警 ─────────────────────────────────────────────────── */

function alarmPatch(raw) {
  const patch = {};
  if (raw.name !== undefined) patch.name = String(raw.name || '');
  if (raw.text !== undefined) patch.text = String(raw.text || '');
  if (raw.variable !== undefined) patch.variable = String(raw.variable || '');
  if (raw.op !== undefined) patch.op = String(raw.op);
  if (raw.value !== undefined) patch.value = raw.value;
  if (raw.level !== undefined) patch.level = String(raw.level);
  if (raw.delaySec !== undefined) patch.delaySec = clampNum(raw.delaySec, 0, 3600, 0);
  if (raw.enabled !== undefined) patch.enabled = !!raw.enabled;
  return patch;
}

function t_add_alarm(a = {}) {
  const patch = alarmPatch(a);
  if (patch.variable !== undefined && !varNames().includes(patch.variable)) {
    return badRes(`变量「${patch.variable}」不在变量表里`, { variables: varNames() });
  }
  if (patch.op !== undefined && !CMP_OPS.includes(patch.op)) return badRes(`比较符只能是 ${CMP_OPS.join(' ')}`);
  if (patch.level !== undefined && !ALARM_LEVELS.includes(patch.level)) return badRes(`报警级别只能是 ${ALARM_LEVELS.join('/')}`);
  const al = project.addAlarm(patch);                     // 内部 commit
  return okRes(`新建报警「${al.name}」：${al.variable || '?'} ${al.op || '>='} ${al.value ?? ''}（${ALARM_LEVEL_CN[al.level] || al.level}）`, { id: al.id, name: al.name });
}

function t_update_alarm(a = {}) {
  const id = String(a.id || '');
  const al = project.getAlarm(id);
  if (!al) return badRes(`没有报警 ${id || '(空)'}`, { alarms: allAlarms().map(x => ({ id: x.id, name: x.name })) });
  const patch = alarmPatch(a);
  if (patch.variable !== undefined && !varNames().includes(patch.variable)) return badRes(`变量「${patch.variable}」不在变量表里`, { variables: varNames() });
  if (patch.op !== undefined && !CMP_OPS.includes(patch.op)) return badRes(`比较符只能是 ${CMP_OPS.join(' ')}`);
  if (patch.level !== undefined && !ALARM_LEVELS.includes(patch.level)) return badRes(`报警级别只能是 ${ALARM_LEVELS.join('/')}`);
  if (!Object.keys(patch).length) return badRes('update_alarm 没有任何要改的字段');
  project.updateAlarm(id, patch);
  return okRes(`报警「${patch.name || al.name}」已更新`, { id, patch: Object.keys(patch) });
}

function t_delete_alarm(a = {}) {
  const guard = needDestructive('删除报警');
  if (guard) return guard;
  const id = String(a.id || '');
  const al = project.getAlarm(id);
  if (!al) return badRes(`没有报警 ${id || '(空)'}`);
  project.deleteAlarm(id);
  return okRes(`已删除报警「${al.name}」`, { id });
}

/* ════════════════════════════════════════════════════════════════
 * 3. 工具清单（对外契约：24 个名字不许随便改）
 * ════════════════════════════════════════════════════════════════ */

// 提示词成本敏感：参数说明只给"猜不到"的（枚举/格式），x/y/w/h 这类不写说明，省下的就是每轮的 token
const S = { type: 'string' };
const N = { type: 'number' };
const B = { type: 'boolean' };
const O = { type: 'object', additionalProperties: true };
const STR = { type: 'array', items: { type: 'string' } };
const ACTIONS = {
  type: 'array',
  description: '替换点击动作，按执行顺序填。例：[{"type":"setValue","params":{"variable":"运行模式","value":0}},{"type":"gotoPage","params":{"page":"手动画面"}}]',
  items: { type: 'object', properties: {
    type: { type: 'string', enum: Object.keys(ACTION_DEFS) },
    params: { type: 'object', properties: {
      page: { type: 'string', description: 'gotoPage / showPopup 的页面名称或 ID' },
      variable: { type: 'string', description: 'setValue / toggle / tap 的变量名' },
      value: { description: 'setValue 的赋值，支持数字、布尔、文本或数组' },
    } },
  }, required: ['type'] },
};
const ANY = { type: 'array', items: {} };
const str = (description, extra) => ({ type: 'string', description, ...(extra || {}) });
const num = (description, extra) => ({ type: 'number', description, ...(extra || {}) });
const bool = (description) => ({ type: 'boolean', description });
const obj = (description) => ({ type: 'object', description, additionalProperties: true });
const anyArr = (description) => ({ type: 'array', description, items: {} });
const strArr = (description) => ({ type: 'array', description, items: { type: 'string' } });

function tool(name, description, properties, required) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: properties || {}, required: required || [] } },
  };
}

export const TOOL_DEFS = [
  tool('get_project', '读工程清单、指定页控件或指定控件。detail 控制是否带属性值。',
    { page: S, widgetId: S, detail: str('full|brief，默认 full') }),
  tool('get_widget_catalog', '列控件类型，传 type 查尺寸、属性和动作。',
    { type: S }),
  tool('list_pages', '列页面（类型/控件数）。', {}),
  tool('add_page', '新建页面。type: page=普通页 popup=弹窗 base=公共底。',
    { name: S, type: str('page|popup|base，默认 page'), title: S, popupW: N, popupH: N, showClose: B, baseIds: STR }),
  tool('update_page', '改页面：name/title/type/弹窗尺寸/公共底。',
    { page: S, name: S, title: S, type: str('page|popup|base'), popupW: N, popupH: N, showClose: B, baseIds: STR }, ['page']),
  tool('delete_page', '删页面（破坏性，需勾「允许破坏性操作」）。', { page: S }, ['page']),
  tool('set_current_page', '切换当前页（后续 add_widget 默认建在这页）。', { page: S }, ['page']),
  tool('add_widget', '画控件。整页一次画完用 items（一个调用画任意多个/任意类型，只占 1 步撤销）；单画一个用 type+坐标。props 键须来自 get_widget_catalog。variable 可以是变量名，也可以写 {"name":"x","type":"real"} 顺手建变量。',
    {
      page: S, type: S, name: S, x: N, y: N, w: N, h: N,
      props: O, variable: { anyOf: [S, O] }, channels: ANY, actions: ACTIONS, items: ANY,
      count: N, layout: str('row|col|grid'), gap: N, cols: N, locked: B,
    }),
  tool('update_widget', '改控件：几何/名称/props/绑定/动作。定位优先级 ids > name > type > 当前选中。',
    { page: S, ids: STR, name: S, type: S, x: N, y: N, w: N, h: N, props: O, variable: S, channels: STR, actions: ACTIONS, locked: B }),
  tool('delete_widgets', '删控件（破坏性，需勾允许破坏性操作）。', { page: S, ids: STR }, ['ids']),
  tool('select_widgets', '在画布上选中控件（方便用户微调）。', { ids: STR }, ['ids']),
  tool('list_vars', '列变量表：名字/类型/地址/当前值/保持。', {}),
  tool('add_vars', '批量建变量。PLC 变量带 address，内部变量留空。',
    {
      vars: {
        type: 'array', items: {
          type: 'object', properties: {
            name: S, type: str('bool|int|real|string，默认 bool'), address: str('PLC 地址，如 40001/D100'), value: N, len: N, retain: B,
          }, required: ['name'],
        },
      },
    }, ['vars']),
  tool('update_var', '改变量：改名（全工程引用一起改）/类型/地址/初值。',
    { name: S, newName: S, type: str('bool|int|real|string'), address: S, value: N, len: N }, ['name']),
  tool('delete_vars', '删变量（破坏性；相关绑定/动作/报警会清掉）。', { names: STR }, ['names']),
  tool('list_scripts', '列脚本：触发/间隔/变量/代码前 1200 字。', {}),
  tool('add_script', '新建脚本。trig: init=启动一次 interval=每 ms 毫秒 cycle=每 50ms change=变量变化 cond=条件成立。代码可用 hmi.get/set/log/page/popup/back/alarms/permLevel/now/sim/project、hmi.v.名、hmi.g。',
    { name: S, trig: str('init|interval|cycle|change|cond，默认 interval'), code: S, ms: N, variable: S, op: S, value: N, enabled: B }, ['code']),
  tool('update_script', '改脚本（改代码会先语法检查）。',
    { id: S, name: S, trig: str('init|interval|cycle|change|cond'), code: S, ms: N, variable: S, op: S, value: N, enabled: B }, ['id']),
  tool('delete_script', '删脚本（破坏性，需勾允许破坏性操作）。', { id: S }, ['id']),
  tool('check_script', '只检查脚本语法/常见坑（不保存）。', { code: S }, ['code']),
  tool('list_alarms', '列报警：变量/条件/级别/延时/内容。', {}),
  tool('add_alarm', '新建报警：变量满足条件时触发；text 里 {变量名} 会替换成实际值。',
    { name: S, variable: S, op: str('==|!=|>|>=|<|<=，默认 >='), value: N, level: str('info|warn|alarm|urgent，默认 alarm'), delaySec: N, text: S, enabled: B }),
  tool('update_alarm', '改报警：变量/条件/级别/延时/内容/启停。',
    { id: S, name: S, variable: S, op: S, value: N, level: str('info|warn|alarm|urgent'), delaySec: N, text: S, enabled: B }, ['id']),
  tool('delete_alarm', '删报警（破坏性，需勾允许破坏性操作）。', { id: S }, ['id']),
  tool('apply_layout_recipe', '套现成版式骨架（推荐第一步）：overview=总览 dashboard=看板 control=操作页，坐标已按 8px 栅格排好，套完再改内容/绑变量。',
    { recipe: str('overview|dashboard|control'), page: S, title: S, subtitle: S, tag: S, kpis: STR, values: STR, units: STR }, ['recipe']),
  tool('tidy_layout', '排版整理（整页排版用）：对齐 8px、收进画布、同行对齐、重叠推开。一步撤销。', { page: S }),
  tool('inspect_layout', '排版自检（只读）：出界/重叠/栅格/字号/配色/密度。整页修改后检查。', { page: S }),
];

/* 工具名 → 执行器（顺序和 TOOL_DEFS 无关，按名字查） */
const TOOL_IMPL = {
  get_project: t_get_project,
  get_widget_catalog: t_get_widget_catalog,
  list_pages: t_list_pages,
  add_page: t_add_page,
  update_page: t_update_page,
  delete_page: t_delete_page,
  set_current_page: t_set_current_page,
  add_widget: t_add_widget,
  update_widget: t_update_widget,
  delete_widgets: t_delete_widgets,
  select_widgets: t_select_widgets,
  list_vars: t_list_vars,
  add_vars: t_add_vars,
  update_var: t_update_var,
  delete_vars: t_delete_vars,
  list_scripts: t_list_scripts,
  add_script: t_add_script,
  update_script: t_update_script,
  delete_script: t_delete_script,
  check_script: t_check_script,
  list_alarms: t_list_alarms,
  add_alarm: t_add_alarm,
  update_alarm: t_update_alarm,
  delete_alarm: t_delete_alarm,
  apply_layout_recipe: t_apply_layout_recipe,
  tidy_layout: t_tidy_layout,
  inspect_layout: t_inspect_layout,
};

/** 同步执行一个工具（不抛异常：任何意外都变成 {ok:false,error}，让模型有机会自己纠正） */
export function runTool(name, args) {
  if (!Object.hasOwn(TOOL_IMPL, name)) return badRes(`没有工具「${name}」`);
  const impl = TOOL_IMPL[name];
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return badRes(`参数不是合法 JSON：${String(args).slice(0, 200)}`); }
  }
  if (!a || typeof a !== 'object') a = {};
  try {
    return impl(a);
  } catch (e) {
    return badRes(`工具 ${name} 执行出错：${e && e.message ? e.message : e}`);
  }
}

export function toolNames() { return TOOL_DEFS.map(t => t.function.name); }

// 自动模式只在识别到工程任务时开放工具，显式选择优先。
const TOOL_GROUPS = [
  { key: 'page', hint: /页|画面|弹窗|公共底|底图|page/i,
    names: ['list_pages', 'add_page', 'update_page', 'delete_page', 'set_current_page'] },
  { key: 'widget', hint: /控件|按钮|标签|文本|文字|数值|表格|波形|曲线|仪表|管道|输入框|下拉|开关|指示灯|报警条|报警列表|配方|班次|图片|箭头|棒图|滑动条|选中|widget|lamp|label|button|trend|gauge/i,
    names: ['get_widget_catalog', 'add_widget', 'update_widget', 'delete_widgets', 'select_widgets'] },
  { key: 'vars', hint: /变量|点位|信号|地址|绑定|初值|tag|\bplc\b/i,
    names: ['list_vars', 'add_vars', 'update_var', 'delete_vars'] },
  { key: 'scripts', hint: /脚本|定时任务|初始化|script/i,
    names: ['list_scripts', 'add_script', 'update_script', 'delete_script', 'check_script'] },
  { key: 'alarms', hint: /报警|告警|越限|alarm/i,
    names: ['list_alarms', 'add_alarm', 'update_alarm', 'delete_alarm'] },
  { key: 'layout', hint: /排版|对齐|美观|好看|布局|版式|重叠|间距|栅格|总览|看板|操作页|整页|画(?:一|个|整).{0,4}(?:页|画面)|复刻|还原|(?:按|照着|根据).*(?:图|附件).*(?:画|做|搭)/i,
    names: ['apply_layout_recipe', 'tidy_layout', 'inspect_layout'] },
];
const PROJECT_HINT = /工程|项目|组态|画布/;
const PROJECT_ACTION = /新建|创建|建一个|建个|添加|加点|加到|帮我做|移到|移动|换到|打开|新增|增加|建立|加上|加个|加一|放个|放一|放几|放上|画个|画一|画整|画出|画面上|复刻|还原|(?:按|照着|根据).*(?:截图|图片|附件).*(?:画|做|搭)|套用|删除|删掉|改一下|改成|改为|调整|修改|更改|改造|换个|换成|替换|检查|查看|看看|查询|查一下|列出|列一下|选中|切换|整理|排版|对齐|写个|写一|写.*脚本|做个|做一|做得|设计|绑定|\b(?:add|create|update|delete|list|inspect)\b/i;
const ACTION_HINT = /跳转|置变量值|赋值|点击动作|导航按钮|gotoPage|setValue/i;
const PROJECT_SCOPE = /当前|选中|这个|这些|这页|本页|我的|我们(?:的)?|现有|工程里|上面/;
const EXPLAIN = /怎么|怎样|如何|啥是|什么是|为什么|讲讲|解释|介绍一下|举例|请教|^(?:what|how|why)\b/i;
const FOLLOW_UP = /^(?:请)?(?:继续|接着|然后|再|那就|照着|按这个|按上面)|(?:改成|改为|换成|移到|缩小|放大|往[上下左右]移)/;

function topicsFor(text) {
  const keys = new Set(TOOL_GROUPS.filter(g => g.hint.test(text)).map(g => g.key));
  if (ACTION_HINT.test(text)) keys.add('widget');
  if (/跳转|导航|gotoPage/i.test(text)) keys.add('page');
  if (/置变量值|赋值|setValue/i.test(text)) keys.add('vars');
  if (keys.has('layout')) {
    keys.add('page');
    keys.add('widget');
  }
  return keys;
}

export function assistantMode(text, preference = 'auto') {
  if (preference === 'chat' || preference === 'project') return preference;
  const ask = String(text || '').trim();
  if (!ask || EXPLAIN.test(ask)) return 'chat';
  const mentionsProject = PROJECT_HINT.test(ask) || topicsFor(ask).size > 0;
  if (mentionsProject && (PROJECT_ACTION.test(ask) || PROJECT_SCOPE.test(ask) || ACTION_HINT.test(ask))) return 'project';
  const previous = turns.at(-1);
  return previous?.mode === 'project' && FOLLOW_UP.test(ask) ? 'project' : 'chat';
}

export function pickTools(text = '') {
  const topics = topicsFor(text);
  if (!topics.size) return TOOL_DEFS;
  const names = new Set(['get_project']);
  for (const { key, names: group } of TOOL_GROUPS) {
    if (topics.has(key)) group.forEach(name => names.add(name));
  }
  if (topics.has('alarms')) names.add('list_vars');
  return TOOL_DEFS.filter(def => names.has(def.function.name));
}

const CHAT_PROMPT = '你是 HMI 组态设计器的助手。按用户的语言简明回答；如果用户要求读取或修改当前工程，提示使用「工程」模式。';
const PROJECT_PROMPT = [
  '你是 HMI 组态助手。按用户要求读取或修改当前工程，结果用简短中文说明。',
  '局部修改直接操作；需要真实 ID 或属性时，先集中查询，只用已确认的引用。不要重复读取。',
  '工具按给出的次序执行。同一批先建页面或变量，再加控件、绑定或跳转。整页控件用 add_widget.items 批量创建。',
  '整页设计尽量同批建页、批量加控件、整理并检查出界和重叠。删除被拒绝时说明如何启用删除。批量翻译使用面板的「翻译」。',
  '布局沿用原有风格，8px 对齐、16px 边距；空白页可用 overview 总览、dashboard 看板、control 操作页。',
].join('\n');

export function buildSystemPrompt(tools = TOOL_DEFS) {
  const names = new Set(tools.map(def => def.function.name));
  const notes = [PROJECT_PROMPT];
  if (names.has('add_widget') || names.has('update_widget')) {
    notes.push('控件类型：' + registry.list().map(def => `${def.type}=${def.title}`).join('、'));
    notes.push('看控件属性前先查对应类型；数值显示用 number，editable:false。');
  }
  if (names.has('add_script') || names.has('update_script')) {
    notes.push('脚本 API：hmi.get/set/has/vars/log/warn/page/popup/hidePopup/back/alarms/permLevel/can/lock/now/time/fmtTime/sim/project，hmi.v.变量名和 hmi.v.数组名[2] 可读写，hmi.g 存跨调用状态。使用 let/const，无 DOM、import 或 async。');
  }
  return notes.join('\n');
}

export function projectBrief() {
  const meta = project.data?.meta || {};
  const page = project.currentPage();
  const ids = getSelection();
  const selected = (page?.widgets || []).filter(w => ids.includes(w.id))
    .slice(0, 5).map(w => [shorten(w.name || w.type, 80), w.id]);
  return JSON.stringify({
    工程: shorten(meta.name || '未命名', 80),
    画布: [meta.canvas?.w || 1024, meta.canvas?.h || 600],
    当前页: page && { 名称: shorten(page.name, 80), id: page.id, 控件数: page.widgets?.length || 0 },
    选中: selected,
    允许删除: allowDestructive,
  });
}

const turns = [];
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 3600;
const TOOL_MSG_MAX = 1200;
const TOOL_HISTORY_CHARS = 9000;
const TOOL_HISTORY_BATCHES = 6;
const ROUND_STOP = 3;
const READ_TOOLS = new Set(['get_project', 'get_widget_catalog', 'list_pages', 'list_vars', 'list_scripts', 'list_alarms', 'check_script']);
const STABLE_READ_TOOLS = new Set(['get_widget_catalog', 'check_script']);
let activeTurn = null;

/** 失败结果里最值得回给模型的"可执行纠正信息"字段（清单/候选人/建议） */
const FAIL_KEEP = ['hint', 'widgets', 'ids', 'pages', 'variables', 'types', 'recipes', 'props', 'actions', 'name', 'pageId', 'pageName'];

/** 从失败结果里抠出一句"真实可用的信息"（控件清单 名称=id、变量候选、页面候选…），喂给模型和用户 */
function failedFixText(r, max = 600) {
  if (!r || r.ok !== false) return '';
  const parts = [];
  if (typeof r.hint === 'string' && r.hint.trim()) parts.push(r.hint.trim());
  if (!parts.length) {
    if (Array.isArray(r.widgets) && r.widgets.length) {
      parts.push('控件：' + r.widgets.slice(0, 20).map(w => `「${w.name || w.type || w.id}」= ${w.id}`).join('；'));
    }
    if (Array.isArray(r.variables) && r.variables.length) {
      parts.push('变量：' + r.variables.slice(0, 30).map(v => (typeof v === 'string' ? v : v.name)).filter(Boolean).join('、'));
    }
    if (Array.isArray(r.pages) && r.pages.length) {
      parts.push('页面：' + r.pages.slice(0, 30).map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean).join('、'));
    }
    if (Array.isArray(r.types) && r.types.length) parts.push('可用类型：' + r.types.slice(0, 40).join('、'));
    if (Array.isArray(r.ids) && r.ids.length) parts.push('可用 id：' + r.ids.slice(0, 20).join('、'));
  }
  const s = parts.join('｜');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 把工具执行结果压成「够模型判断、又不会撑爆上下文」的一段 JSON 字符串。
 * 面板显示用的是 onToolEnd 的完整结果，不受这里影响。
 */
export function compactToolMessage(name, r) {
  try {
    // 页面查询：模型最需要的是"这页有哪些控件、id 是什么、摆在哪"。
    // 超过 1200 字就整包砍掉 → 模型看不到 id 只能瞎猜（线上那次报"没有控件 rect_标题条"就是这么来的），
    // 所以这里专门压成"紧凑行"，放宽到 2400 字。
    if (name === 'get_project' && r && r.ok && r.data && r.data.page && Array.isArray(r.data.page.widgets)) {
      const pg = r.data.page;
      // 整页读的返回值本身就是「紧凑行 + 属性值」，别再二次压：模型一次就能看到全页，
      // 这里只做"上限保护"（6000 字 ≈ 一页 50 个控件的量），超了先丢属性值、再限行数。
      const rowOf = (w, withProps) => {
        const bits = [w.name || '', w.id, w.type, `${w.x},${w.y}`, `${w.w}x${w.h}`];
        if (w.bindings && typeof w.bindings === 'object' && Object.keys(w.bindings).length) bits.push('v:' + JSON.stringify(slimData(w.bindings)).slice(0, 160));
        if (w.actions?.length) bits.push('a:' + JSON.stringify(w.actions).slice(0, 360));
        if (withProps) {
          const pv = (w.props && typeof w.props === 'object' && !Array.isArray(w.props)) ? w.props : null;
          if (pv && Object.keys(pv).length) bits.push('p:' + JSON.stringify(pv).slice(0, 400));
          else if (Array.isArray(w.props) && w.props.length) bits.push('p:' + w.props.slice(0, 10).join('/'));
        }
        return bits.filter(Boolean).join('|');
      };
      const pack = (list) => JSON.stringify({
        ok: true,
        summary: String(r.summary || ''),
        data: { pageId: pg.id, pageName: pg.name, count: pg.widgetCount || pg.widgets.length, widgets: list },
      });
      const CAP = 6000;
      let out = pack(pg.widgets.map(w => rowOf(w, true)));
      if (out.length > CAP) out = pack(pg.widgets.map(w => rowOf(w, false)));
      if (out.length > CAP) out = pack(pg.widgets.map(w => rowOf(w, false)).slice(0, 30));
      if (out.length <= CAP) return out;
    }
    // 控件目录是最大的一类：完整 def（每个属性的 label/options/defVal）没必要进历史，留键名+类型就够
    if (name === 'get_widget_catalog' && r && r.ok && r.data) {
      const d = r.data;
      if (Array.isArray(d.widgets)) {
        const list = d.widgets.map(w => [w.type, w.title, (w.w && w.h) ? (w.w + 'x' + w.h) : ''].filter(Boolean).join('|'));
        return JSON.stringify({ ok: true, summary: String(r.summary || ''), data: { widgets: list } });
      }
      if (d.type) {
        const props = Array.isArray(d.props)
          ? d.props.map(p => (typeof p === 'string' ? p : p.key)).filter(Boolean)
          : [];
        const actions = Array.isArray(d.actions)
          ? d.actions.map(a => (typeof a === 'string' ? a : a.type)).filter(Boolean)
          : [];
        const slim = JSON.stringify({
          ok: true,
          summary: String(r.summary || ''),
          data: { type: d.type, title: d.title, w: d.w || d.defaultW, h: d.h || d.defaultH, props, actions },
        });
        if (slim.length <= TOOL_MSG_MAX) return slim;
      }
    }
    const full = JSON.stringify(r);
    // 失败结果单独放宽：里面往往正是"真实 id / 候选人 / 建议"这类可执行信息，
    // 按成功结果的 1200 字砍掉，模型就只剩一句报错，只能继续瞎猜（线上就是这么死循环的）
    const fail = r && r.ok === false;
    const cap = fail ? 2200 : TOOL_MSG_MAX;
    if (full.length <= cap) return full;
    if (fail) {
      const out = { ok: false, error: r && r.error ? String(r.error).slice(0, 300) : '工具执行失败' };
      FAIL_KEEP.forEach(k => {
        if (r && r[k] !== undefined && r[k] !== null && r[k] !== '') out[k] = slimData(r[k]);
      });
      if (Array.isArray(r && r.warnings) && r.warnings.length) out.warnings = r.warnings.slice(0, 6);
      // 还是太长就按优先级砍（先砍长清单，保留 hint）
      const shrink = () => {
        if (out.widgets && Array.isArray(out.widgets) && out.widgets.length > 12) out.widgets = out.widgets.slice(0, 12);
        if (out.variables && Array.isArray(out.variables) && out.variables.length > 20) out.variables = out.variables.slice(0, 20);
        if (typeof out.hint === 'string' && out.hint.length > 900) out.hint = out.hint.slice(0, 900) + '…';
      };
      shrink();
      let s = JSON.stringify(out);
      if (s.length > cap && typeof out.hint === 'string') { out.hint = out.hint.slice(0, 400); s = JSON.stringify(out); }
      if (s.length > cap && Array.isArray(out.widgets)) { out.widgets = out.widgets.slice(0, 6); s = JSON.stringify(out); }
      if (s.length > cap) {
        delete out.widgets; delete out.variables; delete out.pages; delete out.types; delete out.recipes; delete out.props; delete out.actions;
        s = JSON.stringify(out);
      }
      if (s.length <= cap) return s;
      return JSON.stringify({ ok: false, error: String(out.error || '').slice(0, 200), hint: String(out.hint || '').slice(0, 300), note: '失败详情过长，已精简' });
    }
    return JSON.stringify({
      ok: !!(r && r.ok),
      summary: r && r.summary ? String(r.summary).slice(0, 600) : '',
      error: r && r.error ? String(r.error).slice(0, 600) : undefined,
      warnings: Array.isArray(r && r.warnings) ? r.warnings.slice(0, 6) : undefined,
      note: '结果太长，已截断；需要细节请换个更精确的参数重新调用，或看右侧面板的完整输出',
    });
  } catch {
    return JSON.stringify({ ok: false, error: '工具结果无法序列化' });
  }
}

function shorten(text, limit) {
  const value = String(text || '');
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function historyFor(mode) {
  const recent = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.mode !== mode) continue;
    const user = shorten(turn.text, 900);
    const reply = [shorten(turn.reply, 930), shorten(turn.activity, 420)].filter(Boolean).join('\n');
    if (chars + user.length + reply.length > HISTORY_CHARS) break;
    chars += user.length + reply.length;
    recent.unshift(...(reply ? [{ role: 'user', content: user }, { role: 'assistant', content: reply }] : [{ role: 'user', content: user }]));
  }
  return recent;
}

export function resetConversation() {
  activeTurn?.cancel();
  turns.length = 0;
}
export function restoreConversation(history) {
  resetConversation();
  turns.push(...history.slice(-HISTORY_TURNS));
}
export function conversationLength() { return turns.length; }

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function parseCall(call, round, index) {
  const raw = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {});
  let args = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch { /* 执行前报参数错误 */ }
  return { id: call.id || `call_${round}_${index}`, name: call.name, args, raw };
}

function toolBatch(calls, content, results) {
  return [
    {
      role: 'assistant', content: content || null,
      tool_calls: calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.args ? c.raw : '{}' },
      })),
    },
    ...results.map(r => ({ role: 'tool', tool_call_id: r.id, content: compactToolMessage(r.name, r.result) })),
  ];
}

function requestRound(ctl, body, emit) {
  return new Promise((resolve, reject) => {
    let text = '';
    let outputStarted = false;
    ctl.chat = aiClient.chat(body, {
      onDelta: delta => {
        outputStarted ||= !!(delta.text || delta.reasoning);
        text += delta.text || '';
        emit('onDelta', delta);
      },
      onDone: info => resolve({ ...info, content: (info.content || text).trim() }),
      onError: (message, code) => reject(Object.assign(new Error(message), { code, outputStarted })),
    });
  });
}

/** 完整执行一次提问。工具消息只在本次任务内使用，按整批保留协议配对。 */
export function runAssistant({ text, mode = 'auto', attachments = [], handlers = {} } = {}) {
  const ask = String(text || '').trim();
  if (!ask || activeTurn) return { cancel() {} };

  const scope = assistantMode(ask, mode);
  const previous = turns.findLast(turn => turn.mode === 'project');
  const intent = scope === 'project' && previous && FOLLOW_UP.test(ask) && !topicsFor(ask).size
    ? previous.intent : ask;
  const tools = scope === 'project' ? pickTools(intent) : [];
  const allowed = new Set(tools.map(def => def.function.name));
  const system = [
    { role: 'system', content: scope === 'chat' ? CHAT_PROMPT : buildSystemPrompt(tools) },
    ...(tools.length ? [{ role: 'system', content: '当前工程：' + projectBrief() }] : []),
  ];
  const user = { role: 'user', content: messageWithAttachments(ask, attachments) };
  let history = historyFor(scope);

  const batches = [];
  const activity = [];
  const earlier = [];
  const ctl = { chat: null, cancel };
  const usage = { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 };
  let reply = '';
  let activeRound = 0;
  let started = 0;
  let elapsed = 0;
  let toolChars = 0;
  let retriedContext = false;
  function emit(name, ...args) {
    try { handlers[name]?.(...args); } catch (error) { console.warn('[aiTools] 回调失败', error); }
  }
  function finish(name, ...args) {
    if (activeTurn !== ctl) return;
    activeTurn = null;
    const context = {
      mode: scope, text: shorten(ask, 1350), intent: shorten(intent, 900),
      reply: shorten(reply, 1350), activity: activity.length ? '已执行：' + activity.join('；') : '',
    };
    turns.push(context);
    if (turns.length > HISTORY_TURNS) turns.shift();
    emit('onTurn', context);
    emit(name, ...args);
  }
  function roundEnd(info = {}) {
    if (!activeRound) return;
    const ms = Number(info.elapsed_ms) || Date.now() - started;
    elapsed += ms;
    emit('onRoundEnd', { round: activeRound, elapsed_ms: ms, finish_reason: info.finish_reason, usage: info.usage });
    activeRound = 0;
  }
  function cancel() {
    if (activeTurn !== ctl) return;
    ctl.chat?.cancel();
    roundEnd();
    finish('onError', '已取消', 'cancel');
  }

  activeTurn = ctl;
  emit('onUser', ask);
  void (async () => {
    try {
      const cfg = aiClient.config || await aiClient.getConfig().catch(() => AI_DEFAULTS);
      const { budget_tokens: budget, max_rounds: maxBatches } = { ...AI_DEFAULTS, ...cfg };
      const seen = new Set();
      let readVersion = 0;
      let repeats = 0;
      let failures = 0;
      let failedSignature = '';
      const archiveBatch = () => {
        const old = batches.shift();
        toolChars -= old.chars;
        old.reads.forEach(signature => seen.delete(signature));
        if (old.summary) earlier.push(shorten(old.summary, 325));
        if (earlier.length > 4) earlier.shift();
      };
      const nextContext = () => [
        ...system, ...history, user,
        ...(earlier.length ? [{ role: 'assistant', content: '本次任务前面已处理：' + earlier.join('；') }] : []),
        ...(retriedContext && activity.length ? [{ role: 'assistant',
          content: '已执行的修改：' + activity.join('；') + '。请只继续未完成的部分。' }] : []),
        ...batches.flatMap(batch => batch.messages),
      ];
      const request = messages => requestRound(ctl, tools.length ? { messages, tools } : { messages }, emit);
      for (let round = 1; activeTurn === ctl; round++) {
        activeRound = round;
        started = Date.now();
        emit('onRound', round);
        if (activeTurn !== ctl) return;
        const done = extra => finish('onDone', { content: reply, rounds: round, elapsed_ms: elapsed, usage, ...extra });
        const context = nextContext();
        let info;
        try {
          info = await request(context);
        } catch (error) {
          if (error.code !== 'context_limit' || error.outputStarted || retriedContext || activeTurn !== ctl) throw error;
          // 用户这条指令和原附件完整保留，压缩已发送过的对话和已执行的工具记录。
          const i = history.findLastIndex(message => message.role === 'user');
          if (i >= 0) history = history.slice(i).map(message => ({ ...message, content: shorten(message.content, 240) }));
          while (batches.length) archiveBatch();
          retriedContext = true;
          const compacted = nextContext();
          if (JSON.stringify(compacted).length >= JSON.stringify(context).length) {
            retriedContext = false;
            throw error;
          }
          emit('onCompact');
          if (activeTurn !== ctl) return;
          info = await request(compacted);
          info.elapsed_ms = Date.now() - started;
        }
        if (activeTurn !== ctl) return;
        ctl.chat = null;
        roundEnd(info);
        for (const key of Object.keys(usage)) usage[key] += Number(info.usage?.[key]) || 0;
        if (info.content) {
          reply = info.content;
          emit('onContent', reply);
        }
        if (info.finish_reason === 'length' || info.finish_reason === 'max_tokens') {
          done({ finish_reason: 'length' });
          return;
        }
        if (!tools.length && info.tool_calls?.length && !info.content) {
          finish('onError', '模型返回了工程操作。需要执行时，请切换到「工程」模式。', 'tool');
          return;
        }
        if (!tools.length || !info.tool_calls?.length) {
          done({ finish_reason: info.finish_reason });
          return;
        }
        if (budget > 0 && usage.prompt_tokens >= budget) {
          done({ truncated: true, budget_limit: budget });
          return;
        }

        const calls = info.tool_calls.map((call, index) => parseCall(call, round, index));
        emit('onToolStart', calls);
        if (activeTurn !== ctl) return;
        const reads = [];
        const results = calls.map(call => {
          let result;
          const isRead = READ_TOOLS.has(call.name);
          const version = STABLE_READ_TOOLS.has(call.name) ? 0 : readVersion;
          const signature = isRead && call.args ? stableJson([call.name, version, call.args]) : '';
          if (!allowed.has(call.name)) result = badRes('当前任务没有开放此工具：' + call.name);
          else if (!call.args) result = badRes('参数必须是合法的 JSON 对象');
          else if (signature && seen.has(signature)) {
            result = { ok: true, duplicate: true, summary: '已经执行过此查询，请使用前面的结果。需要新信息时缩小或调整查询范围。' };
          } else {
            result = runTool(call.name, call.args);
            if (result.ok && signature) {
              seen.add(signature);
              reads.push(signature);
            }
            if (result.ok && !isRead) {
              readVersion++;
              activity.push(shorten(result.summary || call.name, 120));
              if (activity.length > 6) activity.shift();
            }
          }
          return { id: call.id, name: call.name, result, duplicate: !!result.duplicate };
        });
        emit('onToolEnd', results);
        if (activeTurn !== ctl) return;

        repeats = results.every(r => r.duplicate) ? repeats + 1 : 0;
        if (repeats >= ROUND_STOP) {
          finish('onError', `连续 ${repeats} 轮都在重复查同一批内容，已停止。可在设置里将「思考过程」改为「交给模型（auto）」，或指定要处理的页面和控件。`, 'tool');
          return;
        }
        const failed = results.find(r => !r.result.ok);
        const error = failed?.result.error || '';
        const sig = error.replace(/「[^」]*」|[\da-f]{6,}|\d+/gi, '#');
        failures = sig ? (sig === failedSignature ? failures + 1 : 1) : 0;
        failedSignature = sig;
        if (failures >= ROUND_STOP) {
          const fix = failedFixText(failed.result);
          finish('onError', `连续 ${failures} 次工具调用都失败了。\n${error}${fix ? '\n' + fix : ''}\n可换个说法，或指定要处理的页面和控件。`, 'tool');
          return;
        }
        if (maxBatches > 0 && round >= maxBatches) {
          done({ truncated: true, batch_limit: maxBatches });
          return;
        }

        const current = toolBatch(calls, info.content, results);
        const chars = JSON.stringify(current).length;
        const summary = results.filter(r => !r.duplicate).map(r => {
          const note = r.result.summary || r.result.error || '';
          return shorten(r.name + ' ' + note, 100);
        }).slice(0, 6).join('，');
        batches.push({ messages: current, chars, summary, reads });
        toolChars += chars;
        while (batches.length > 1 && (toolChars > TOOL_HISTORY_CHARS || batches.length > TOOL_HISTORY_BATCHES)) {
          archiveBatch();
        }
      }
    } catch (error) {
      if (activeTurn !== ctl) return;
      roundEnd();
      const message = error.code === 'context_limit'
        ? (retriedContext ? '压缩历史后仍超过模型上下文。请缩短本条指令或附件，再试一次。'
          : '模型上下文超限，请缩短本条指令或附件，或改用支持更长上下文的模型。')
        : (error.message || 'AI 请求失败');
      finish('onError', message, error.code || 'http');
    }
  })();
  return { cancel };
}
