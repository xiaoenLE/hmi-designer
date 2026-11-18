/**
 * aiTools.js — AI 助手的「手」：工具定义 + 工具执行 + 多轮对话编排
 *
 * 三层：
 *   ① TOOL_DEFS  给模型看的 24 个工具（OpenAI function-calling schema）
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
import { aiClient } from '../api/ai.js';

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
  if (depth >= 6) return Array.isArray(v) ? `[…${v.length} 项]` : '{…}';
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

/** 把模型给的动作数组规范成工程真格式；顺手校验页面/变量 */
function normalizeActions(list, warnings) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach(raw => {
    if (!raw || typeof raw !== 'object') return;
    const type = String(raw.type || '');
    if (!ACTION_DEFS[type]) { warnings.push(`动作类型「${type}」不认识，已忽略`); return; }
    const params = { ...(raw.params && typeof raw.params === 'object' ? { ...raw.params } : {}) };
    if (params.page !== undefined) {
      if (type === 'gotoPage' || type === 'showPopup') {
        const pg = findPage(params.page);
        if (!pg) { warnings.push(`动作 ${type} 的页面「${params.page}」不存在，已忽略`); return; }
        params.page = pg.id;
      }
    }
    if (params.variable !== undefined && !varNames().includes(String(params.variable))) {
      warnings.push(`动作 ${type} 的变量「${params.variable}」不在变量表，已忽略`);
      return;
    }
    out.push({ trigger: raw.trigger || 'click', type, params });
  });
  return out;
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
    const acts = normalizeActions(spec.actions, warnings);
    if (acts) project.updateWidgetActions(widget.id, acts);
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

  list.forEach(w => {
    if (Object.keys(geo).length) project.updateWidgets([w.id], geo);
    const def = registry.get(w.type);
    if (a.props && typeof a.props === 'object') applyWidgetProps(w, def || { type: w.type, props: [], defaults: {} }, a.props, warnings);
    if (a.variable !== undefined) project.updateWidgetField(w.id, 'bindings.variable', String(a.variable || ''));
    if (channels) project.updateWidgetField(w.id, 'bindings.variables', channels);
    if (a.actions !== undefined) {
      const acts = normalizeActions(a.actions, warnings);
      if (acts) project.updateWidgetActions(w.id, acts);
    }
  });
  project.commit(`AI 修改${list.length > 1 ? ` ${list.length} 个控件` : '控件'}`);
  return okRes(`改了 ${list.length} 个控件`, { pageId: page.id, widgets: list.map(w => ({ id: w.id, type: w.type, name: w.name })) }, { warnings: warnings.length ? warnings : undefined });
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
  tool('get_project', '看工程现状。给 page = 一次读整页（含每个控件的几何、属性值、绑定、动作），别再逐个控件查；给 widgetId 只查单个控件；都不给 = 工程清单。detail=full|brief 控制是否带属性值。',
    { page: S, widgetId: S, detail: str('full|brief，默认 full') }),
  tool('get_widget_catalog', '查控件库：不给 type 给简表；给 type 给完整属性白名单（props 键必须来自这里）。',
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
      props: O, variable: O, channels: ANY, actions: ANY, items: ANY,
      count: N, layout: str('row|col|grid'), gap: N, cols: N, locked: B,
    }, ['type']),
  tool('update_widget', '改控件：几何/名称/props/绑定/动作。定位优先级 ids > name > type > 当前选中。',
    { page: S, ids: STR, name: S, type: S, x: N, y: N, w: N, h: N, props: O, variable: S, channels: STR, actions: ANY, locked: B }),
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
  tool('tidy_layout', '排版整理（画完必调）：对齐 8px、收进画布、同行对齐、重叠推开。一步撤销。', { page: S }),
  tool('inspect_layout', '排版自检（只读）：出界/重叠/栅格/字号/配色/密度。交付前必调，有 error 先修。', { page: S }),
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
  const impl = TOOL_IMPL[name];
  if (!impl) return badRes(`没有工具「${name}」`);
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

/* ── 按需下发工具（省 token）：外部 MCP agent 便宜，是因为它常驻工具少；
 *    我们 27 个工具的 schema 每轮都要重发 8.4k 字符。做法：每句话只下发"可能用到"的工具组，
 *    一轮对话内工具集保持不变（放请求最前面，厂商侧缓存才可能命中）。
 *    cfg.tool_mode === 'full' 时才下发全部 27 个。 */
const TOOL_GROUP = {
  page: ['list_pages', 'add_page', 'update_page', 'delete_page', 'set_current_page', 'get_project'],
  widget: ['add_widget', 'update_widget', 'delete_widgets', 'select_widgets', 'get_widget_catalog'],
  vars: ['list_vars', 'add_vars', 'update_var', 'delete_vars'],
  scripts: ['list_scripts', 'add_script', 'update_script', 'delete_script', 'check_script'],
  alarms: ['list_alarms', 'add_alarm', 'update_alarm', 'delete_alarm'],
  layout: ['apply_layout_recipe', 'tidy_layout', 'inspect_layout'],
};
const BASE_TOOLS = ['get_project', 'get_widget_catalog', 'list_pages', 'list_vars', 'add_page', 'set_current_page',
  'add_widget', 'update_widget', 'delete_widgets', 'apply_layout_recipe', 'tidy_layout', 'inspect_layout'];
const GROUP_HINTS = [
  ['widget', /控件|按钮|标签|文本|数值|表格|波形|曲线|仪表|管道|管道图|画面元素|输入框|下拉|开关|指示|报警条|报警列表|配方|班次|图片|箭头|棒图|滑动条|lamp|label|button|trend|gauge/i],
  ['page', /页面|页|画面|弹窗|公共底|底图|切换页/i],
  ['vars', /变量|点位|信号|地址|plc|modbus|读写|置位|复位|初值|类型/i],
  ['scripts', /脚本|逻辑|定时|循环|周期|仿真|开机|初始化|on\s?init|script/i],
  ['alarms', /报警|告警|故障|越限|alarm/i],
  ['layout', /排版|对齐|美观|好看|布局|版式|整理|重叠|间距|栅格/i],
];
/** 按用户这句话挑工具（auto 模式）；不认识就只给基础集 */
export function pickTools(text = '', mode = 'auto') {
  if (mode === 'full') return TOOL_DEFS;
  const want = new Set(BASE_TOOLS);
  const t = String(text || '');
  GROUP_HINTS.forEach(([g, re]) => { if (re.test(t)) (TOOL_GROUP[g] || []).forEach(n => want.add(n)); });
  const out = TOOL_DEFS.filter(d => want.has(d.function.name));
  return out.length ? out : TOOL_DEFS;
}

/* ════════════════════════════════════════════════════════════════
 * 4. 提示词
 * ════════════════════════════════════════════════════════════════ */

/** 给模型看的「当前工程简报」——每轮都重算（上一轮改了什么，下一轮立刻知道） */
/** 统计工程里现有的颜色/字号（给提示词当"这个工程长什么样"的参考，新页面要跟着走） */
function styleSnapshot() {
  const colors = new Map();
  const fonts = new Map();
  allPages().forEach(p => (p.widgets || []).forEach(w => {
    const pr = w.props || {};
    Object.keys(pr).forEach(k => {
      const v = pr[k];
      if (/color/i.test(k) && /^#[0-9a-fA-F]{6}$/.test(String(v || ''))) {
        const c = String(v).toLowerCase();
        colors.set(c, (colors.get(c) || 0) + 1);
      }
      if (k === 'fontSize' && Number(v) > 0) fonts.set(Number(v), (fonts.get(Number(v)) || 0) + 1);
    });
  }));
  const topC = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
  const topF = [...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
  return { colors: topC, fonts: topF };
}

export function projectBrief() {
  const meta = project.data?.meta || {};
  const cur = project.currentPage();
  const lines = [];
  lines.push(`工程：${meta.name || '(未命名)'}｜画布 ${meta.canvas?.w || 1024}×${meta.canvas?.h || 600}`);
  const ps = allPages().map(p => `${p.name}[${PAGE_TYPES[p.type] || p.type},${(p.widgets || []).length}控件,${p.id}]`);
  lines.push(`页面(${ps.length})：${ps.join(' ') || '（空）'}`);
  if (cur) {
    const sel = getSelection();
    const selNames = (cur.widgets || []).filter(w => sel.includes(w.id)).map(w => `${w.name || w.type}(${w.id})`);
    lines.push(`当前页：${cur.name}（${(cur.widgets || []).length} 控件）｜选中：${selNames.join('、') || '无'}`);
  }
  const vs = allVars();
  // 变量只报"名字:类型"，不报 PLC 地址（地址模型基本用不到，几十个变量光地址就几百字）；超过 24 个只列前 24 个
  const vsShown = vs.slice(0, 24).map(v => `${v.name}:${v.type}`).join(' ');
  lines.push(`变量(${vs.length})：${vsShown || '（空）'}${vs.length > 24 ? ` …（还有 ${vs.length - 24} 个，用 list_vars 查）` : ''}`);
  lines.push(`报警 ${allAlarms().length} 条｜脚本 ${allScripts().length} 个${allScripts().length ? '（' + allScripts().map(s => `${s.name}:${s.trig}`).join(' ') + '）' : ''}`);
  try {
    const st = i18nState();
    const langs = (st.langs || []).map(l => l.code);
    lines.push(`语言：默认 ${st.default || ''}｜其它 ${langs.join(',') || '（无，要翻译先加语言）'}`);
  } catch { /* ignore */ }
  const st = styleSnapshot();
  if (st.colors.length || st.fonts.length) {
    lines.push(`视觉风格（已有页面在用的，新页面必须沿用）：颜色 ${st.colors.join(' ') || '—'}｜字号 ${st.fonts.join('/') || '—'}`);
  } else {
    lines.push('视觉风格：工程还是空的 → 用内置工控色板（#11283f 深色条 / #35c8d2 强调 / #ffffff 卡片 / #d8e2eb 描边 / #eaf1f6 浅底 / #24518f 主按钮 / #173550 标题 / #4b657a 正文）');
  }
  lines.push(`危险操作闸门：${allowDestructive ? '已打开' : '已关闭（删东西会被拒绝，只能改/加）'}`);
  return lines.join('\n');
}

/** 控件速查表（写进 system prompt，省得每个都去查 catalog） —— 只列 type=中文名，默认尺寸由 catalog 提供 */
function widgetCheatSheet() {
  return registry.list().map(def => `${def.type}=${def.title}`).join(' ');
}

const SCRIPT_API_DOC = [
  'hmi.get(名)、hmi.set(名, 值)、hmi.has(名)、hmi.vars()、hmi.log(...)、hmi.warn(...)、hmi.logNo(...)',
  'hmi.page(页名或id)、hmi.popup(页名或id)、hmi.hidePopup()、hmi.back()、hmi.alarms()',
  'hmi.permLevel()、hmi.can(级别)、hmi.lock()、hmi.now()、hmi.time(fmt)、hmi.sim()、hmi.fmtTime(ts, fmt)',
  'hmi.project.name()、hmi.project.pageId()、hmi.project.pageName()',
  'hmi.v：属性写法 hmi.v.变量名（读写，打错名字会抛异常）；hmi.g：跨次调用/跨脚本的临时对象（不落盘）',
  '代码是严格模式（strict）：必须用 let/const，不能用隐式全局；每次执行是新的 let/const 作用域，所以跨调用状态放 hmi.g',
  '没有 async/await、没有 import/require、没有 DOM、没有超时中断（死循环会卡死界面）',
].join('\n');

export function buildSystemPrompt() {
  return [
    '你是「HMI 组态设计器」内置的 AI 助手，直接操作当前工程；用户是工控/电气工程师，说话简短。你要动手干活，不要长篇解释。',
    '',
    '【工作方式】',
    '1) 先看后改，但"看"要一次看全：读整页用 get_project{page}（一次回整页的几何+属性值+绑定+动作，别再按控件逐个查）；工程清单用 get_project{}；配属性前先 get_widget_catalog 查白名单（同一个 type 查一次就够）。',
    '2) 一轮可以发多个工具调用：能并行的合并到同一轮（同时查多个控件/同时建多个控件），不要一个动作一轮、不要问一句等一句。改完用一两句中文说清"改了什么、在哪个页面、怎么验证"，不要贴 JSON、不要复述工具结果。',
    '3) 变量、页面先建后用：绑变量必须先 add_vars；跳转引用的页面必须先 add_page（同一轮里建完再引用）。',
    '4) 脚本触发按意图选：init=开机一次；interval=每 ms；cycle=每 50ms；change=变量变了才跑；cond=条件成立才跑。只用 hmi 那套 API。',
    '5) 用户要"整站翻译"时，让他点面板「翻译」按钮（专门的多语言批量流程）；你只负责界面文字本身写对。',
    '6) 删除类操作被安全闸拒绝时不要重试，直接请用户勾「允许破坏性操作」。',
    '7) 工具返回 ok:false 时按 error 改参数重试最多 2 次，再不行就说明原因。',
    '8) 中文回答，简洁具体，带页面名和控件名；不要 markdown 表格，代码只给必要几行。',
    '9) 新建页面/大改版面，交付前必须 tidy_layout → inspect_layout；有 error（出界、重叠）必须修掉才能说完成。',
    '10) 同一个查询（同样参数的 get_project / list_* / get_widget_catalog / check_script）在一次任务里只调一次：拿到结果就直接动手改；重复调用不会得到新信息，系统会直接判"原地打转"，连续 3 轮就停手。',
    '',
    '',
    '【一轮干完】（最重要：每多一轮 = 整套上下文再付一次钱）',
    '工具在一次回复里按顺序依次执行，所以"建页面→画控件→排版→自检"可以全部放进同一轮：',
    '· 新建整页：同一轮发 [add_page(...), add_widget({page, items:[{type,x,y,w,h,props,variable}, …整页所有控件…]}), apply_layout_recipe 或 tidy_layout, inspect_layout]；variable 可以直接写 {"name":"x","type":"real"}，不存在的变量会顺手建好，不用先 add_vars。',
    '· 改造现有页：同一轮发 [get_project(page) 拿真实 id/名称, update_widget(...) ×N 或 add_widget(items) 补控件]。',
    '· 只有"必须先看到真实数据才能决定下一步"时才分两轮（例如用户没说清要改哪一页）；能一次发齐却分成多轮，属于错误用法。',
    '· 局部任务（加 1~2 个控件）就一个 add_widget 或 update_widget 调用，不要先查工程、也不要逐个试。',
    '· 不重复读：同样参数的查询一次就够，已经拿到的内容在历史里，再查一遍既没新信息又多付一轮钱。',    '【视觉规范】栅格 8px；页边距 16；卡片 gap 16、内边距 16；x/y/w/h 都取 8 的倍数。字号 24/16/14/12（≥10，同页 ≤4 种）。一页 ≤15 控件；配色 ≤3 类、含描边 ≤6 色。工控色板：#11283f 深条 / #f7fbff 条上字 / #35c8d2 强调 / #ffffff 卡片 / #d8e2eb 描边 / #eaf1f6 浅底 / #24518f 主按钮 / #173550 标题 / #4b657a 正文 / #718497 次要。结构：顶部深色标题条（标题+副标题+右上标签）→ 中间 2~4 张白卡（radius 14、1px 描边）→ 底部浅底条；KPI 上排、报警放顶部或右侧显眼处。禁止：重叠、出界、塞满、渐变、文字压边框。',
    '',
    '【布局配方】新做一页先 apply_layout_recipe（overview=总览 / dashboard=看板 / control=操作页）铺骨架，再改文字、绑变量；铺几十个控件只占 1 步撤销。套完 tidy_layout → inspect_layout → 按 issues 修。只要加一个按钮/数值这类局部改动，别套整页，直接对齐进已有卡片的 8px 网格。',
    '',
    '【工程数据模型】page: {id,name,type:"page|popup|base",title,popupW,popupH,showClose,baseIds?,widgets[]}｜widget: {id,type,name,x,y,w,h,z,locked,props{},bindings{variable?|variables?|startVar?},actions[{trigger:"click",type,params}]}｜variable: {name,type:"bool|int|real|string",address,value,len}｜alarm: {id,name,variable,op,value,level:"info|warn|alarm|urgent",delaySec,enabled,text}｜script: {id,name,trig,ms,variable,op,value,code,enabled}｜多语言译文 meta.i18n.dict[语言][原文]（整句共享）。',
    '',
    '【控件速查】' + widgetCheatSheet(),
    '',
    '【脚本可用 API】',
    SCRIPT_API_DOC,
    '',
    '【摆放约定】原点左上；起摆取 16/24 倍数、间距 16；按钮 110×46；波形/仪表盘单独占卡，别压别的控件。',
  ].join('\n');
}

/* ════════════════════════════════════════════════════════════════
 * 5. 多轮对话编排
 * ════════════════════════════════════════════════════════════════ */

/** 会话历史（只存 user / assistant / tool 三类消息，滚动保留最近若干条） */
const _conv = [];
const MAX_HISTORY = 400;
// 省 token：最近 8 条消息保持原文（含刚拿到的工具结果），更早的降级（工具结果换占位、长正文截断）
const KEEP_FULL = 8;
const OLD_TOOL_STUB = '（早期工具结果已省略：内容太多，需要时用更精确的参数重新调用）';
const OLD_TEXT_MAX = 500;
/** 单条工具结果写进历史的字数上限（超出就只留 ok/summary/warnings + 截断提示） */
const TOOL_MSG_MAX = 1200;
// 会话压缩：历史估算超过这个字数（≈2.5k token），就把更早的对话压成一段"前情提要"
const CONV_CHAR_BUDGET = 9000;
const CONV_MSG_MAX = 40;
const AGGR_KEEP = 6;
const SUMMARY_MAX = 2600;
/** 更早对话压缩成的一段提要（跟着系统提示一起发，不进 _conv） */
let _convSummary = '';
// 工具失败保护：第一批就失败 → 立刻注入纠偏提示；同类错误连续 3 批还不停 → 直接停手，别烧 token
const FAIL_HINT_AT = 1;
const FAIL_STOP_AT = 3;
// 不思考（thinking=disabled）时模型容易原地打转、反复发同样的查询：同参数只查询一次，重复的直接回提示
const DUP_STOP_AT = 3;              // 连续这么多轮全是重复查询就停手
const READ_TOOLS = new Set(['get_project', 'get_widget_catalog', 'list_pages', 'list_vars', 'list_scripts', 'list_alarms', 'check_script']);
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

export function resetConversation() { _conv.length = 0; _convSummary = ''; }
export function conversationLength() { return _conv.length; }
/** 诊断用：当前会话的估算字符数 / 是否已压缩过 */
export function conversationStats() {
  return { messages: _conv.length, chars: convChars(), summarized: !!_convSummary };
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

function msgChars(m) {
  if (!m) return 0;
  let n = typeof m.content === 'string' ? m.content.length : 0;
  if (Array.isArray(m.tool_calls)) {
    for (const c of m.tool_calls) {
      const raw = c && c.function && c.function.arguments;
      if (typeof raw === 'string') n += raw.length;
    }
  }
  return n;
}
function convChars() {
  let n = _convSummary.length;
  for (const m of _conv) n += msgChars(m);
  return n;
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 把一批较早的消息压成一段"前情提要"（纯本地规则，不花 token） */
function summarizeOlder(msgs) {
  const asks = [];
  const dids = [];
  let toolCount = 0;
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === 'user') {
      const t = oneLine(m.content, 100);
      if (t) asks.push(t);
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content.trim()) {
        const t = oneLine(m.content, 110);
        if (t && dids[dids.length - 1] !== t) dids.push(t);
      }
    } else if (m.role === 'tool') {
      toolCount++;
    }
  }
  const tail = a => (a.length > 4 ? a.slice(-4) : a);
  const lines = [];
  lines.push(`【前情提要（更早的 ${msgs.length} 条对话为省 token 已压缩，其中 ${toolCount} 次工具调用）】`);
  lines.push('用户先后要求：' + (asks.length ? tail(asks).join('；') : '—'));
  if (dids.length) lines.push('已经做过/说过：' + tail(dids).join('；'));
  return lines.join('\n');
}

function trimHistory() {
  if (_conv.length > MAX_HISTORY) _conv.splice(0, _conv.length - MAX_HISTORY);

  // 第一级：滑动窗口 —— 最近 KEEP_FULL 条原样；更早的降级（历史每轮都要重发，这是"省钱"关键）
  const cut = _conv.length - KEEP_FULL;
  for (let i = 0; i < cut; i++) {
    const m = _conv[i];
    if (!m) continue;
    if (m.role === 'tool') {
      if (m.content !== OLD_TOOL_STUB) m.content = OLD_TOOL_STUB;
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > OLD_TEXT_MAX) {
      m.content = m.content.slice(0, OLD_TEXT_MAX) + '…（后文省略）';
    } else if (m.role === 'system' && typeof m.content === 'string' && m.content.length > 400) {
      m.content = m.content.slice(0, 400) + '…';
    }
  }

  // 第二级：还是太长（或消息太多）→ 把更早的整段压成"前情提要"，只留最近 AGGR_KEEP 条
  if (convChars() <= CONV_CHAR_BUDGET && _conv.length <= CONV_MSG_MAX) return;
  let keepFrom = Math.max(0, _conv.length - AGGR_KEEP);
  // 不能把 assistant(tool_calls) 和它对应的 tool 结果切开，也不能让历史以 tool 开头
  while (keepFrom < _conv.length && _conv[keepFrom] && _conv[keepFrom].role === 'tool') keepFrom++;
  if (keepFrom <= 0) return;
  const older = _conv.slice(0, keepFrom);
  const summary = summarizeOlder(older);
  if (!summary) return;
  _convSummary = (_convSummary ? _convSummary + '\n' + summary : summary).slice(-SUMMARY_MAX);
  _conv.splice(0, keepFrom);
}

// 稳定序列化：同样的查询参数永远得到同一个签名（去重用，键顺序不影响）
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

function callSig(name, args) { return String(name) + '|' + stableJson(args || {}); }

function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return { __raw: String(raw) }; }
}

/**
 * 跑一轮完整对话（内部自己决定要不要继续调模型）。
 *
 * @param {object} opt
 * @param {string} [opt.text] 用户新消息（省略 = 只继续跑上一轮没做完的工具循环，目前用不到）
 * @param {object} opt.handlers 面板回调：
 *   onUser(text) onRound(n) onRoundEnd({round,elapsed_ms,finish_reason,usage})
 *   onDelta({text,reasoning}) onToolStart(list) onToolEnd(list)
 *   onDone({content, rounds, usage, elapsed_ms}) onError(message, code)
 * @returns {{cancel:()=>void}} 立即返回，方便面板绑"停止"按钮
 */
export function runAssistant(opt = {}) {
  const text = (opt.text === undefined || opt.text === null) ? '' : String(opt.text);
  const handlers = opt.handlers || {};
  const ctl = { cancelled: false, chat: null };
  const h = (name, ...args) => {
    const fn = handlers[name];
    if (typeof fn === 'function') { try { fn(...args); } catch (e) { console.warn('[aiTools] handler 出错：' + name, e); } }
  };

  const cancel = () => {
    ctl.cancelled = true;
    try { ctl.chat?.cancel(); } catch { /* 已经结束了 */ }
  };

  (async () => {
    if (text.trim()) {
      _conv.push({ role: 'user', content: text });
      h('onUser', text);
    }
    try {
      const cfg = await aiClient.getConfig().catch(() => null);
      // 对话轮次**不限**：工具调用属于内部往返，不消耗轮次预算。
      // max_rounds 只当"工具批次保险"用：>0 时，一次提问里工具批次达到上限就停（并提示可以再发「继续」）。
      const rawBatches = Number(cfg?.max_rounds);
      const maxBatches = Number.isFinite(rawBatches) && rawBatches > 0 ? Math.round(rawBatches) : 0;
      // 单次提问的输入 token 预算：每轮 prompt_tokens 已含"重发的全部历史"，累加就是真实输入花费
      const rawBudget = Number(cfg?.budget_tokens);
      const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.round(rawBudget) : 0;
      let lastContent = '';
      let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
      let elapsed = 0;
      let roundNo = 0;
      let batchCount = 0;   // 已经执行过的工具批次
      let failStreak = 0;   // 连续失败的工具批次（一旦成功就清零）
  let dupStreak = 0;   // 连续「整轮都是重复查询」的轮数（模型原地打转）
  const seenReads = new Map();   // 本回合已执行过的只读查询（同参数不重复执行）
      let lastFailMsg = '';
      // 工具集在整轮对话内保持一致（放请求最前面，厂商侧前缀缓存才可能命中）
      const tools = pickTools(opt.text, cfg?.tool_mode === 'full' ? 'full' : 'auto');
      for (let round = 1; ; round++) {
        if (maxBatches > 0 && batchCount >= maxBatches) break;
        roundNo = round;
        if (ctl.cancelled) return;
        h('onRound', round);
        trimHistory();
        const messages = [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'system', content: '【当前工程简报】\n' + projectBrief() },
          ...(_convSummary ? [{ role: 'system', content: _convSummary }] : []),
          ..._conv,
        ];
        let streamed = '';
        let finish = '';
        let toolCalls = null;
        let usage = null;
        let errMsg = '';
        let errCode = '';
        const t0 = Date.now();
        let roundMs = 0;
        const res = await new Promise(resolve => {
          const pending = { done: false };
          const finishOnce = payload => { if (pending.done) return; pending.done = true; resolve(payload); };
          ctl.chat = aiClient.chat({ messages, tools, tool_choice: 'auto' }, {
            onDelta: d => {
              if (ctl.cancelled) return;
              if (d && d.text) { streamed += d.text; }
              if (d) h('onDelta', d);
            },
            onTool: calls => { toolCalls = calls; },
            onDone: info => {
              finish = info?.finish_reason || '';
              if (info?.content) streamed = info.content;
              toolCalls = (info && Array.isArray(info.tool_calls) && info.tool_calls.length) ? info.tool_calls : toolCalls;
              usage = info?.usage || null;
              roundMs = Number(info?.elapsed_ms) || 0;
              elapsed += Number(info?.elapsed_ms) || 0;
              finishOnce({ ok: true });
            },
            onError: (msg, code) => {
              errMsg = String(msg || '未知错误');
              errCode = String(code || '');
              finishOnce({ ok: false, code: errCode, message: errMsg });
            },
          });
          if (ctl.cancelled) { try { ctl.chat?.cancel(); } catch { /* ignore */ } finishOnce({ ok: false, code: 'cancel', message: '已取消' }); }
        });
        // 这一轮模型请求的用时（后端测的 elapsed_ms；取消/报错时用本地墙钟兜底）
        h('onRoundEnd', { round, elapsed_ms: roundMs || (Date.now() - t0), finish_reason: finish, usage });
        if (!res.ok) {
          // 取消：也要通知面板一声，它才知道这次是"用户按了停止"（好画「（已停止）」）
          if (res.code === 'cancel' || ctl.cancelled) { h('onError', '已取消', 'cancel'); return; }
          h('onError', res.message, res.code || 'http');
          return;
        }
        if (usage) {
          totalUsage.prompt_tokens += Number(usage.prompt_tokens) || 0;
          totalUsage.completion_tokens += Number(usage.completion_tokens) || 0;
        }
        if (streamed.trim()) { lastContent = streamed.trim(); h('onContent', lastContent); }

        if (!toolCalls || !toolCalls.length) {
          _conv.push({ role: 'assistant', content: lastContent || '' });
          h('onDone', { content: lastContent || '', rounds: round, usage: totalUsage, elapsed_ms: elapsed, finish_reason: finish });
          return;
        }

        // 预算到量：本轮工具结果先别丢，但不再继续下一轮（防长任务无声烧钱）
        if (budget > 0 && totalUsage.prompt_tokens >= budget) {
          _conv.push({ role: 'assistant', content: lastContent || '' });
          h('onDone', { content: lastContent || '', rounds: round, usage: totalUsage, elapsed_ms: elapsed, truncated: true, budget_limit: budget });
          return;
        }

        // 1) 把助手的 tool_calls 记进历史（OpenAI 格式，arguments 保持字符串）
        _conv.push({
          role: 'assistant',
          content: lastContent || '',
          tool_calls: toolCalls.map(c => ({
            id: String(c.id || ''), type: 'function',
            function: { name: String(c.name || ''), arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}) },
          })),
        });
        const calls = toolCalls.map(c => ({ id: String(c.id || ''), name: String(c.name || ''), args: parseArgs(c.arguments) }));
        h('onToolStart', calls.map(c => ({ id: c.id, name: c.name, args: c.args })));
        if (ctl.cancelled) return;

        // 2) 顺序执行（工具会改工程，并发执行顺序不可控；也便于面板逐条显示结果）
        const results = [];
        for (const call of calls) {
          if (ctl.cancelled) return;
          const isRead = READ_TOOLS.has(call.name);
          const sig = isRead ? callSig(call.name, call.args) : '';
          let r;
          if (isRead && seenReads.has(sig)) {
            // 同一个查询本回合已经跑过了：别再执行一遍、别再塞一份大结果（不思考时模型就是这么原地打转的）
            r = {
              ok: true,
              duplicate: true,
              summary: '这个查询本回合已经执行过，结果在前面那条 tool 结果里，直接用它。',
              hint: '不要重复读同样的内容：拿到的信息够用就直接动手改；要更多信息就换参数或换别的工具。',
            };
          } else {
            r = runTool(call.name, call.args);
            if (isRead && r && r.ok !== false) seenReads.set(sig, true);
          }
          results.push({ id: call.id, name: call.name, result: r, duplicate: !!r.duplicate });
          // 进历史的工具结果先瘦身（原样塞进去，之后每轮都要重发、重复付费）
          _conv.push({ role: 'tool', tool_call_id: call.id, content: compactToolMessage(call.name, r) });
        }
        h('onToolEnd', results);

        // ---- 原地打转保护：连续整轮都是重复查询（常见于 thinking=disabled）----
        const allDup = calls.length > 0 && results.every(x => x.duplicate);
        if (allDup) {
          dupStreak += 1;
          if (dupStreak >= DUP_STOP_AT) {
            h('onError', `连续 ${dupStreak} 轮都在重复查同一批内容，模型一直没往前走，我先停下。\n`
              + '建议：① 把设置里的「思考过程」改成「交给模型（auto）」再试 —— 不思考时模型很容易原地打转；'
              + '② 或者直接说清要改哪里、改成什么（比如"给主画面的报警条换个颜色"）。', 'tool');
            return;
          }
          _conv.push({
            role: 'system',
            content: '【系统提示】你这一轮调用的全是"本回合已经查过"的查询，结果在历史里。'
              + '不要再读同样的内容：直接基于已有结果动手改；确实缺信息就换参数/换工具；也可以先问用户要改什么。',
          });
        } else {
          dupStreak = 0;
        }
        batchCount += 1;

        // ---- 失败纠偏：工具连续失败时，先把错误亮给模型，再考虑停手 ----
        const failed = results.filter(r => r.result && r.result.ok === false);
        if (failed.length) {
          const rawErr = String((failed[0].result && (failed[0].result.error || failed[0].result.summary)) || '工具执行失败');
          // 失败结果里的可执行信息（真实控件清单 / 候选人 / 建议）单独抠出来，明确塞回给模型和用户
          const fix = failedFixText(failed[0].result);
          // 报错里常带 id/名字/数字（"没有控件 lbl_title_8" vs "…_9"），不归一化就会被当成"新错误"永远清零 —— 于是死循环
          const sig = rawErr
            .replace(/[0-9a-f]{6,}/gi, '#')
            .replace(/[A-Za-z_]*\d+[A-Za-z0-9_]*/g, '#')
            .replace(/「[^」]*」/g, '「X」')
            .replace(/\d+/g, 'N');
          if (lastFailMsg && sig !== lastFailMsg) failStreak = 0;
          lastFailMsg = sig;
          failStreak += 1;
          if (failStreak >= FAIL_STOP_AT) {
            h('onError', `连续 ${failStreak} 次工具调用都失败了，我先停下（最后一次：${rawErr}）。`
              + (fix ? `\n可用的真实信息：${fix}` : '')
              + '\n建议：① 换个说法或换个思路让我重做；② 你先手动改一下那部分，再让我接着做；③ 把这条报错发给我，我针对性修。', 'tool');
            return;
          }
          if (failStreak >= FAIL_HINT_AT) {
            _conv.push({
              role: 'system',
              content: `【系统提示】最近连续 ${failStreak} 次工具调用失败，最后一次报错：${rawErr}\n`
                + (fix ? `这页/这次真实的可用信息：${fix}\n` : '')
                + '不要再重复同样的调用和参数，也不要再猜 id —— 直接用上面给出的真实名字和 id，不要自己拼；'
                + '要更多清单就用 list_pages / list_vars / get_project（不带 widgetId）查。改参数、换工具或换个做法；确实做不到就直接告诉用户哪一步需要人工处理。',
            });
          }
        } else {
          failStreak = 0;
          lastFailMsg = '';
        }
        // 下一轮：模型看到工具结果，继续说话或继续调工具
      }
      // 到达用户设的"工具批次"保险上限：收尾并告诉用户怎么接着做
      h('onDone', { content: lastContent || '', rounds: roundNo, usage: totalUsage, elapsed_ms: elapsed, truncated: true, batch_limit: maxBatches });
    } catch (e) {
      if (ctl.cancelled) return;
      h('onError', `AI 助手内部错误：${e && e.message ? e.message : e}`, 'http');
    } finally {
      ctl.chat = null;
    }
  })();

  return { cancel };
}
