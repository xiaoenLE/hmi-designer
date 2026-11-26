/**
 * trend.js — 波形抓取（趋势图）的数据与绘制
 *
 *   · 数据：每个波形控件一份缓冲 { [变量名]: [{t, v}] }，按 sampleMs 采样 varStore 的值
 *   · 运行态：按控件属性采样（运行结束/重新运行清空）；编辑态：画静态预览曲线，方便调外观
 *   · 绘制：一个 rAF 循环（约 30fps）把页面上的 .trend-cv 逐帧重画（网格 / 坐标 / 曲线 / 图例）
 *
 * 现场增强（属性面板里配）：
 *   · 时间轴：横轴 = 时间，显示最近「时间窗口」；
 *   · 双 Y 轴：勾上后右轴可单独选几路通道，左右各自量程/刻度，图例给右轴通道标「(右)」；
 *   · 运行态控件右上角「导出 CSV」按钮（属性里可关/可改文字），导出当前缓冲。
 *   ⚠ 原「XY 曲线」模式已移除（改用独立「XY 波形」控件 xyplot）：老工程残留的
 *     props.mode='xy' / bindings.xVar / autoX / xMin… 一律忽略，照旧按时间轴采样/绘制，不报错。
 *
 * 为什么单独一个模块：波形控件是「自绘」的（def.selfDrawn），不走 innerHTML 局部刷新，
 * 数据也不进工程文件 —— 它属于运行态状态，和 varStore 一样是临时的。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { exportText } from '../core/csv.js';
import { bindPlotControls, plotCapturing, plotSwitch, plotTickCount, updatePlotLegend } from '../widgets/defs/plotShared.js';
import { varStore } from './varstore.js';
import { onTick } from './ticker.js';

/** 通道配色（按勾选顺序取；可在属性面板里逐个改） */
export const PALETTE = ['#38bdf8', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb7185', '#a3e635'];
export const MAX_CHANNELS = 8;

const SAMPLE_TICK = 50;      // 采样调度粒度
const DRAW_INTERVAL = 33;    // 约 30fps
const KEEP_EXTRA = 1.15;     // 缓冲多留 15%，避免窗口边界处断线
const PAD_L = 42;            // 左轴刻度区宽度
const PAD_R_SINGLE = 8;      // 单轴时右边留白
const PAD_R_DUAL = 46;       // 双轴时要给右边刻度文字留位置
/* 单通道点数**硬上限**（内存闸门）。
   为什么必须有：缓冲原来只按「时间窗口 ÷ 采样周期」留点数 —— 这两个值都是属性面板里的数字，
   窗口给 600s、采样给 20ms 就是每通道 3 万点，8 路 = 24 万点（每个点一个 {t,v} 对象 ≈ 56 字节，
   一个控件 ~13MB）。点数还直接决定逐帧重绘的开销：24 万点 × 30fps = 每秒 700 万次 lineTo。
   而画布只有几百像素宽 —— 一个像素里塞几十个点，看不见任何差别，纯粹白烧内存和 CPU。
   现在按这个上限**自动放宽采样周期**（时间窗口一秒不少，只是老窗口的采样点变稀），
   现场怎么填属性都涨不上去：3000 点 × 8 路 ≈ 1.3MB/控件。 */
const MAX_PTS_CH = 3000;

const buffers = new Map();     // widgetId -> Map(varName -> [{t, at, v}])
const lastAt = new Map();      // widgetId -> 上次采样时刻
const localCapture = new Set(); // 本次运行中手动开启的波形 id
const cursors = new Map();     // widgetId -> { ratio|null, pinned, time } 光标状态
let running = false;
let paused = false;
let stopSample = null;         // 停止采样的回调（来自 ticker.js 的 onTick）
let raf = null;
let lastDraw = 0;
let idleUntil = 0;

/* ─────────── 数据 ─────────── */
function bufferOf(id) {
  let m = buffers.get(id);
  if (!m) { m = new Map(); buffers.set(id, m); }
  return m;
}

/** 这个波形控件的时间窗口（毫秒）。属性里是秒，缺省/非法一律按 20s */
function windowMsOf(w) {
  const sec = Number(w?.props?.windowSec);
  return Math.max(2, Number.isFinite(sec) && sec > 0 ? sec : 20) * 1000;
}

/** 实际采样周期（毫秒）= 属性里的采样周期，但**受点数上限约束**自动放宽：
 *  窗口越长、上限越小，采样就越稀 —— 保证「窗口内点数 ≤ MAX_PTS_CH」。
 *  ⚠ 采样和光标读数（valueAt 的容差）都用它，两边必须同一个口径，
 *    否则大窗口下光标会一直显示「--」（取到的点离光标时刻太远，被判成没数据）。 */
export function effPeriodOf(w) {
  const period = Math.max(20, Number(w?.props?.sampleMs) || 100);
  return Math.max(period, (windowMsOf(w) * KEEP_EXTRA) / MAX_PTS_CH);
}

/** 取某控件的全部通道数据（测试/调试用） */
export function seriesOf(id) { return buffers.get(id) || new Map(); }
/** 清空（不给 id = 全部清空） */
export function clearTrend(id) {
  if (id) { buffers.delete(id); lastAt.delete(id); }
  else { buffers.clear(); lastAt.clear(); }
}

/* ─────────── 增强用的属性口径（老工程缺键 = 老行为） ─────────── */

/** 采样值转数字：bool → 0/1；空/非法 → NaN */
function numOf(raw) {
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (raw === null || raw === undefined || raw === '') return NaN;
  return Number(raw);
}

/** 双 Y 轴：属性里勾了「双 Y 轴」且右轴通道号能对上**已启用**的通道，才算真双轴。
 *  rightChannels 是 1 开始、逗号分隔的通道号（对应属性面板通道列表左边的编号，如 2,4）。 */
export function rightSlotsOf(w) {
  const set = new Set();
  if (w?.props?.dualAxis !== true) return set;
  String(w?.props?.rightChannels ?? '').split(/[,，;；\s]+/).forEach(tok => {
    const n = parseInt(tok, 10);
    if (Number.isFinite(n) && n >= 1 && n <= MAX_CHANNELS) set.add(n - 1);
  });
  return set;
}

/** 现在真的是双轴吗（勾了 + 至少一路右轴通道还在用；否则按老的单轴画） */
export function isDualAxis(w) {
  const slots = rightSlotsOf(w);
  return slots.size > 0 && channelsOf(w).some(ch => slots.has(ch.slot));
}

/** 哪几路画在左轴 / 右轴（测试与图例用） */
export function axisChannelsOf(w) {
  const slots = isDualAxis(w) ? rightSlotsOf(w) : new Set();
  const chans = channelsOf(w);
  return {
    dual: slots.size > 0,
    left: chans.filter(ch => !slots.has(ch.slot)).map(ch => ch.name),
    right: chans.filter(ch => slots.has(ch.slot)).map(ch => ch.name),
  };
}

/** 图例文字：走右轴的通道后面加「(右)」（图例绘制与测试共用同一份口径） */
function legendText(w, ch, rightSet, valueText = '') {
  const right = rightSet.has(ch.slot);
  return `${ch.name}${right ? '(右)' : ''}${valueText ? ' ' + valueText : ''}`;
}
export function legendLabelOf(w, ch, valueText = '') {
  return legendText(w, ch, isDualAxis(w) ? rightSlotsOf(w) : new Set(), valueText);
}

/* ─────────── 抓取控制（两个可选变量：启动抓取 / 清除数据） ───────────
     · 「启动抓取」绑定时由变量电平决定；
     · 未绑定时，开启画面抓取按钮则手动开始，否则连续抓取；
     · 「清除数据」填了 = 它**从 0 变 1 那一刻**清一次（上升沿；一直保持 1 不会反复清，
       否则曲线永远是一张白纸 —— 现场那只手会把位一直按着）。
   两个变量都会自动进本页采集范围（见 runtime.js 的 collectPageVars），不采就永远是 undefined。 */
const clearPrev = new Map();           // widgetId -> 上一次「清除数据」变量的真假

/** 外部变量优先。未启用手动抓取的旧控件继续自动采样。 */
export function capturing(w) {
  return plotCapturing(w, name => varStore.get(name), localCapture.has(w?.id));
}

function viewEnd(w) {
  const now = performance.now();
  return running && (paused || !capturing(w)) ? (lastAt.get(w.id) ?? now) : now;
}

export function attachTrendControls(el, w, api) {
  bindPlotControls(el, w, api, {
    toggle() {
      if (!localCapture.delete(w.id)) localCapture.add(w.id);
      bus.emit('trend:capture');
      return capturing(w);
    },
    clear() {
      clearTrend(w.id);
      cursors.delete(w.id);
    },
  });
}

/** 「清除数据」这一拍是不是上升沿？（没设这个变量 = 永远不是） */
function clearEdge(w) {
  const name = w?.bindings?.clearVar;
  if (!name) { clearPrev.delete(w.id); return false; }
  const nowOn = plotSwitch(varStore.get(name));
  const was = clearPrev.get(w.id);
  clearPrev.set(w.id, nowOn);
  // 头一次看到就是 1（比如刚进运行态、PLC 那边本来就置着）→ **不清**：
  // 那不是"设备刚下了一条清除命令"，只是我们刚开机看到它
  return was === false && nowOn === true;
}
/** 运行结束/重进运行态：把上升沿记忆一起清掉（不然上次的 1 会挡住这次的第一次清除） */
function resetClearMemory() { clearPrev.clear(); }
export function isPaused() { return paused; }
export function setPaused(p) {
  const next = !!p;
  if (next === paused) return;
  paused = next;
  bus.emit('trend:paused', { paused });
}

/** 光标状态（测试/调试用）：{ pinned, ratio, time, values } */
export function cursorOf(id) {
  const c = cursors.get(id);
  if (!c || (!c.pinned && c.ratio == null)) return null;
  const w = project.findWidget(id);
  if (!w) return null;
  const buf = seriesOf(id);
  const winMs = Math.max(2, Number(w.props?.windowSec) || 20) * 1000;
  const end = viewEnd(w);
  const tCur = c.pinned ? c.time : end - winMs + c.ratio * winMs;
  const values = {};
  channelsOf(w).forEach(ch => { values[ch.name] = valueAt(buf.get(ch.name), tCur, w); });
  return { pinned: !!c.pinned, time: tCur, offsetSec: (tCur - end) / 1000, values };
}

/** 画布上某时间点的取值：取最近的采样点，离得太远算没数据 */
function valueAt(arr, t, w) {
  if (!arr || !arr.length) return NaN;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const a = arr[lo], b = arr[Math.max(0, lo - 1)];
  const pick = Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
  const tol = Math.max(250, effPeriodOf(w) * 2.5);
  return Math.abs(pick.t - t) > tol ? NaN : pick.v;
}

/** 通道颜色：属性里改过就用改过的，否则按槽位取调色板 */
export function channelColor(w, name, slot) {
  return w?.props?.colors?.[name] || PALETTE[slot % PALETTE.length];
}
/** 通道量程：显示值 = 原值 × 倍率 + 偏置（缓冲里存原值，量程只在画的时候套，
 *  这样改量程立刻重画历史曲线，不用重新采样） */
export function channelScale(w, name) {
  const s = w?.props?.scales?.[name];
  const k = Number(s?.k), b = Number(s?.b);
  return { k: Number.isFinite(k) ? k : 1, b: Number.isFinite(b) ? b : 0 };
}
const tf = (w, name, raw) => {
  const { k, b } = channelScale(w, name);
  return raw * k + b;
};
/**
 * 控件当前启用的通道（按槽位顺序）
 * 数据形状：bindings.variables = ['' | 变量名] × 8 —— 空串 = 该路未使用
 * @returns {{slot:number, name:string, color:string}[]}
 */
export function channelsOf(w) {
  const raw = Array.isArray(w?.bindings?.variables) ? w.bindings.variables : [];
  const exists = new Set(project.variables().map(v => v.name));
  const out = [];
  raw.forEach((name, slot) => {
    if (!name || !exists.has(name)) return;
    out.push({ slot, name, color: channelColor(w, name, slot) });
  });
  return out;
}
/** 只要变量名（清单/提示用） */
export function channelNames(w) { return channelsOf(w).map(c => c.name); }

/* 工程里所有波形控件。⚠ 采样每 50ms 跑一次，以前这里每次都要把**所有页面的所有控件**
   flatMap + filter 一遍：500 个控件时等于每秒新建 400 个 500 元素的数组（纯 GC 压力，
   帧率就是被这种"看不见"的分配拖下去的）。改成缓存，工程变了才重算。 */
let trendCache = null;
function trendWidgets() {
  if (trendCache) return trendCache;
  const out = [];
  const pages = project.pages();
  for (let i = 0; i < pages.length; i++) {
    const ws = pages[i].widgets;
    for (let j = 0; j < ws.length; j++) if (ws[j].type === 'trend') out.push(ws[j]);
  }
  trendCache = out;
  return out;
}
/** 供别的模块复用（例如运行态的按页采集范围）——同样只在工程变化时重算 */
export function allTrendWidgets() { return trendWidgets(); }

/** 被删掉的波形控件，它的缓冲/光标/采样时刻一并丢掉。
 *  为什么要有：buffers 是按**控件 id** 存的，控件删了 id 就没人再提，数据却一直挂在内存里
 *  （反复导入/删除页面时越攒越多）。工程一变就核对一次，只留还存在的控件。 */
function pruneDeadBuffers() {
  if (!buffers.size && !cursors.size && !clearPrev.size && !localCapture.size) return;
  const alive = new Set(trendWidgets().map(w => w.id));
  [...buffers.keys()].forEach(id => { if (!alive.has(id)) buffers.delete(id); });
  [...lastAt.keys()].forEach(id => { if (!alive.has(id)) lastAt.delete(id); });
  [...cursors.keys()].forEach(id => { if (!alive.has(id)) cursors.delete(id); });
  [...clearPrev.keys()].forEach(id => { if (!alive.has(id)) clearPrev.delete(id); });
  localCapture.forEach(id => { if (!alive.has(id)) localCapture.delete(id); });
}
bus.on('project:changed', () => { trendCache = null; pruneDeadBuffers(); });
bus.on('page:current', () => { trendCache = null; });

/** 采样一次：把每个波形控件的各通道当前值记进缓冲 */
function sampleOnce() {
  const now = performance.now();
  trendWidgets().forEach(w => {
    // 「清除数据」变量：**上升沿**清一次（一直保持 1 不会反复清，不然曲线永远画不出来）。
    // 没设这个变量 = 不清（老行为）。清不清跟"抓不抓"无关：停着也能清。
    if (clearEdge(w)) clearTrend(w.id);
    // 本地按钮和外部启动变量共用采样与采集范围判定。
    if (!capturing(w)) return;
    // 停止抓取时不枚举通道、更不读取通道值；只保留启动/清除控制变量的处理。
    const chans = channelsOf(w);
    // 通道全空了（变量被删/被置空）→ 连缓冲一起清掉，别让旧数据挂在内存里
    if (!chans.length) { if (buffers.has(w.id)) clearTrend(w.id); return; }
    const period = effPeriodOf(w);
    if (now - (lastAt.get(w.id) || 0) < period) return;
    lastAt.set(w.id, now);
    const keepMs = windowMsOf(w) * KEEP_EXTRA;
    const m = bufferOf(w.id);
    chans.forEach(ch => {
      let arr = m.get(ch.name);
      if (!arr) { arr = []; m.set(ch.name, arr); }
      arr.push({ t: now, at: Date.now(), v: numOf(varStore.get(ch.name)) });
      const cut = now - keepMs;
      let drop = 0;
      while (drop < arr.length && arr[drop].t < cut) drop++;
      // 兜底硬闸门：上面那条按时间窗口丢点，只要窗口/采样周期是"正常数字"就够；
      // 万一工程里的属性被填成离谱的值（导入的工程、手改 JSON），这里保证点数**绝不会**超上限
      if (arr.length - drop > MAX_PTS_CH) drop = arr.length - MAX_PTS_CH;
      if (drop) arr.splice(0, drop);
    });
    // 停用/删掉的通道不再留数据
    const keep = new Set(chans.map(c => c.name));
    [...m.keys()].forEach(k => { if (!keep.has(k)) m.delete(k); });
  });
}

function startSampling() {
  clearTrend();
  resetClearMemory();          // 「清除数据」那个上升沿记忆：新一次运行从零开始记
  sampleGen++;                 // 上一次运行还没跑的那一拍作废
  if (stopSample) { stopSample(); stopSample = null; }
  // 走统一节拍器（ticker.js）：页面切到后台时浏览器的页面定时器会被降频到 1 秒一次，
  // 用裸 setInterval 采样会让后台期间的波形变成「一秒一个点、时间轴被拉稀」——现场实测过。
  let lastAt = 0;
  stopSample = onTick((now) => {
    if (paused) return;
    if (now - lastAt < SAMPLE_TICK) return;      // 保持原来 50ms 的采样粒度，不多跑
    lastAt = now;
    scheduleSample();
  });
}

/* 采样**延到当前任务结束后**再跑（微任务）。
   为什么必须延：ticker.js 还挂在 `vars:changed` 上（数据一到就推一拍）——
   PLC 一批变量是一次“逐个 set”地进 varStore 的，那中间每 set 一个就同步推一拍；
   如果当场采样，就会抓到「一半通道已是新值、另一半还是旧值」这种半新半旧的组合。
   延到微任务 = 这一批 set 全部落地后再采一次，同一拍里各变量才是自洽的。 */
let samplePending = false;
let sampleGen = 0;
function scheduleSample() {
  if (samplePending) return;
  samplePending = true;
  const gen = sampleGen;
  const run = () => {
    samplePending = false;
    if (gen !== sampleGen || !running || paused) return;
    sampleOnce();
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else Promise.resolve().then(run);
}
function stopSampling() {
  sampleGen++;                 // 作废还没跑的那一拍（退出运行/重启时别再采一次）
  samplePending = false;
  if (stopSample) { stopSample(); stopSample = null; }
}

/* ─────────── 绘制 ─────────── */
export function startTrendLoop() {
  if (raf != null) return;
  const step = () => { raf = requestAnimationFrame(step); tickDraw(); };
  raf = requestAnimationFrame(step);
}
export function stopTrendLoop() {
  if (raf != null) { cancelAnimationFrame(raf); raf = null; }
}

function tickDraw() {
  const now = performance.now();
  if (now < idleUntil || now - lastDraw < DRAW_INTERVAL) return;
  lastDraw = now;
  const list = document.querySelectorAll('.trend-cv');
  if (!list.length) { idleUntil = now + 400; return; }   // 没有波形控件就放慢，别空转
  list.forEach(cv => {
    try { drawTrend(cv); } catch (e) { console.error('[trend] 绘制失败', e); }
  });
}

function fmt(v, decimals) {
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(Math.max(0, Math.min(3, decimals ?? 1)));
}

/** 画一个波形控件（每帧调用） */
function drawTrend(cv) {
  const wdEl = cv.closest('.wd');
  const w = wdEl && project.findWidget(wdEl.dataset.id);
  if (!w) return;
  const cssW = Math.max(20, cv.clientWidth);
  const cssH = Math.max(20, cv.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }

  const p = w.props || {};
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const chans = channelsOf(w);
  // 右轴通道（勾了双 Y 轴 + 通道号对得上才算；对不上按单轴画，不画半边空刻度）
  const rightSet = isDualAxis(w) ? rightSlotsOf(w) : new Set();
  const dual = rightSet.size > 0;
  const padL = PAD_L, padR = dual ? PAD_R_DUAL : PAD_R_SINGLE, padT = 8, padB = 16;
  const plotW = Math.max(10, cssW - padL - padR);
  const plotH = Math.max(10, cssH - padT - padB);

  const winMs = Math.max(2, Number(p.windowSec) || 20) * 1000;
  const runningNow = running;
  const data = seriesOf(w.id);
  const now = viewEnd(w);
  const t0 = now - winMs, t1 = now;

  const leftChans = chans.filter(ch => !rightSet.has(ch.slot));
  const rightChans = chans.filter(ch => rightSet.has(ch.slot));

  /** 自动量程：list 里的通道在**时间窗口内**可见点（套过量程后）的最小/最大值。 */
  const autoLoHi = (list) => {
    let mn = Infinity, mx = -Infinity;
    const take = (v) => { if (!Number.isFinite(v)) return; if (v < mn) mn = v; if (v > mx) mx = v; };
    if (runningNow) {
      list.forEach(ch => {
        (data.get(ch.name) || []).forEach(pt => {
          if (pt.t < t0) return;
          take(tf(w, ch.name, pt.v));
        });
      });
    }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null;
    if (mn === mx) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.12;
    return [mn - pad, mx + pad];
  };
  const manualRange = (a, b) => {
    let l = Number(a), h = Number(b);
    if (!Number.isFinite(l)) l = 0;
    if (!Number.isFinite(h) || h <= l) h = l + 1;
    return [l, h];
  };
  /** 一端自动就按数据算（没数据回落干净的 0~1），否则用属性里的固定范围 */
  const pickRange = (auto, a, b, list) =>
    (!auto ? manualRange(a, b) : (autoLoHi(list) || [0, 1]));
  const [lo, hi] = pickRange(p.autoY !== false, p.yMin, p.yMax, leftChans);
  const [lo2, hi2] = dual
    ? pickRange(p.autoY2 !== false, p.y2Min, p.y2Max, rightChans)
    : [0, 1];

  // 横轴：时间轴 = 最近 winMs（原 XY 模式已移除，老工程残留的 mode/xMin 等一律忽略）
  const X = t => padL + ((t - t0) / (t1 - t0)) * plotW;
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  const Y2 = v => padT + (1 - (v - lo2) / (hi2 - lo2)) * plotH;
  const Yof = ch => (rightSet.has(ch.slot) ? Y2 : Y);

  // 网格 + 刻度
  if (p.showGrid !== false) {
    const xSteps = plotTickCount(p.xTicks) - 1;
    const ySteps = plotTickCount(p.yTicks) - 1;
    ctx.strokeStyle = p.gridColor || '#1e3a5f';
    ctx.lineWidth = 1;
    ctx.fillStyle = p.textColor || '#cbd5e1';
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= ySteps; i++) {
      const y = padT + (plotH * i) / ySteps;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillText(fmt(hi - ((hi - lo) * i) / ySteps, p.decimals), padL - 5, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= xSteps; i++) {
      const x = padL + (plotW * i) / xSteps;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      const secs = Number(((-winMs * (1 - i / xSteps)) / 1000).toFixed(1));
      ctx.fillText(i === xSteps ? 'now' : secs + 's', x, padT + plotH + 3);
    }
    /* 右轴刻度：跟左轴共享水平刻度，只画文字不画网格（网格已经在上面画过一遍，
       再画一遍就是深浅两条线重叠，画面发脏）。 */
    if (dual) {
      ctx.fillStyle = p.textColor || '#cbd5e1';
      ctx.font = '10px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= ySteps; i++) {
        const y = padT + (plotH * i) / ySteps;
        ctx.fillText(fmt(hi2 - ((hi2 - lo2) * i) / ySteps, p.decimals), padL + plotW + 5, y);
      }
    }
  }

  // 曲线
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, Number(p.lineWidth) || 2);
  chans.forEach(ch => {
    ctx.strokeStyle = ch.color;
    if (!runningNow) return;
    const yOf = Yof(ch);
    ctx.beginPath();
    let started = false;
    const pts = data.get(ch.name) || [];
    for (const pt of pts) {
      if (pt.t < t0 || !Number.isFinite(pt.v)) { started = false; continue; }
      const x = X(pt.t), y = yOf(tf(w, ch.name, pt.v));
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  // 编辑态：画静态预览曲线 + 提示，方便调颜色/尺寸
  if (!runningNow) {
    ctx.setLineDash([5, 4]);
    chans.forEach(ch => {
      ctx.strokeStyle = ch.color;
      ctx.beginPath();
      const amp = 0.26 + ch.slot * 0.06;
      const yOf = Yof(ch);
      const yBase = yOf === Y2 ? lo2 : lo, ySpan = yOf === Y2 ? (hi2 - lo2) : (hi - lo);
      for (let k = 0; k <= 60; k++) {
        const r = k / 60;
        const v = (0.5 + amp * Math.sin(r * Math.PI * 2 * (1 + ch.slot * 0.5))) * ySpan + yBase;
        const x = padL + r * plotW;
        const y = yOf(v);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(148,163,184,.85)';
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!chans.length) ctx.fillText('编辑预览 · 请在右侧给通道选变量', padL + plotW / 2, padT + plotH / 2);
    else ctx.fillText('编辑预览（运行时开始抓取）', padL + plotW / 2, padT + plotH / 2);
  } else if (!chans.length) {
    ctx.fillStyle = 'rgba(148,163,184,.85)';
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('未选择数据通道', padL + plotW / 2, padT + plotH / 2);
  }

  const legend = cv.previousElementSibling?.querySelector('.w-plot-legend');
  if (legend && runningNow) {
    const entries = chans.map(ch => {
      const val = varStore.get(ch.name);
      const num = numOf(val);
      const shown = typeof val === 'boolean' ? String(num)
        : Number.isFinite(num) ? fmt(tf(w, ch.name, num), p.decimals) : '';
      return { color: ch.color, label: legendText(w, ch, rightSet, shown) };
    });
    if (paused) entries.push({ color: '#fbbf24', label: '⏸ 已暂停' });
    updatePlotLegend(legend, entries);
  }

  // 光标：悬停跟随 / 点击钉住，线上打点 + 读数框显示各通道该时刻的值
  if (runningNow && p.showCursor !== false && chans.length) {
    const c = cursors.get(w.id);
    if (c && (c.pinned || c.ratio != null)) {
      const tCur = c.pinned ? c.time : t0 + c.ratio * (t1 - t0);
      const xCur = X(tCur);
      if (xCur >= padL - 1 && xCur <= padL + plotW + 1) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = c.pinned ? '#fbbf24' : 'rgba(226,232,240,.75)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xCur, padT);
        ctx.lineTo(xCur, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        // 各通道在光标处的点
        chans.forEach(ch => {
          const v = valueAt(data.get(ch.name), tCur, w);
          if (!Number.isFinite(v)) return;
          ctx.fillStyle = ch.color;
          ctx.beginPath();
          ctx.arc(xCur, Yof(ch)(tf(w, ch.name, v)), 3, 0, Math.PI * 2);
          ctx.fill();
        });
        // 读数框
        const fs = Math.max(9, Math.min(13, Number(p.fontSize) || 11));
        ctx.font = fs + 'px Consolas, monospace';
        const rows = chans.map(ch => {
          const v = valueAt(data.get(ch.name), tCur, w);
          return { name: ch.name, color: ch.color, txt: Number.isFinite(v) ? fmt(tf(w, ch.name, v), p.decimals) : '--' };
        });
        const head = (tCur - now) / 1000;
        const headTxt = (head >= -0.05 ? 'now' : head.toFixed(1) + 's');
        const wBox = Math.max(ctx.measureText(headTxt).width,
          ...rows.map(r => ctx.measureText(`${r.name} ${r.txt}`).width + 12)) + 14;
        const hBox = (rows.length + 1) * (fs + 5) + 8;
        let bx = xCur + 10;
        if (bx + wBox > padL + plotW) bx = xCur - 10 - wBox;      // 右边放不下就翻到左边
        bx = Math.max(padL + 2, bx);
        let by = padT + 6;
        if (by + hBox > padT + plotH) by = padT + plotH - hBox - 2;
        ctx.fillStyle = 'rgba(15,23,42,.9)';
        ctx.strokeStyle = c.pinned ? '#fbbf24' : 'rgba(148,163,184,.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, wBox, hBox);
        ctx.fill();
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = c.pinned ? '#fbbf24' : '#94a3b8';
        ctx.fillText(c.pinned ? '📌 ' + headTxt : headTxt, bx + 7, by + (fs + 5) / 2 + 4);
        rows.forEach((r, i) => {
          const ry = by + (fs + 5) * (i + 1) + (fs + 5) / 2 + 4;
          ctx.fillStyle = r.color;
          ctx.fillRect(bx + 7, ry - 3, 6, 6);
          ctx.fillStyle = p.textColor || '#cbd5e1';
          ctx.fillText(`${r.name} ${r.txt}`, bx + 17, ry);
        });
        ctx.restore();
      }
    }
  }
}

/* ─────────── 光标交互（悬停跟随 / 点击钉住） ─────────── */
function cursorState(id) {
  let c = cursors.get(id);
  if (!c) { c = { ratio: null, pinned: false, time: 0 }; cursors.set(id, c); }
  return c;
}
function bindCursorEvents() {
  const canvasOf = e => (e.target?.closest ? e.target.closest('.trend-cv') : null);
  const idOf = cv => cv?.closest('.wd')?.dataset.id;

  document.addEventListener('pointermove', e => {
    const cv = canvasOf(e);
    if (!cv) return;
    const id = idOf(cv);
    if (!id) return;
    const c = cursorState(id);
    if (c.pinned) return;                       // 钉住后不再跟随鼠标
    const r = cv.getBoundingClientRect();
    if (!r.width) return;
    c.ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  });
  // pointerleave 不冒泡，用捕获阶段接
  document.addEventListener('pointerleave', e => {
    const cv = canvasOf(e);
    const id = idOf(cv);
    if (!id) return;
    const c = cursors.get(id);
    if (c && !c.pinned) c.ratio = null;
  }, true);
  // 点击钉子/取消（HMI 触摸屏上没有 hover，靠这个看值）
  document.addEventListener('click', e => {
    const cv = canvasOf(e);
    const id = idOf(cv);
    if (!id) return;
    const w = project.findWidget(id);
    if (!w) return;
    const c = cursorState(id);
    if (c.pinned) { c.pinned = false; c.ratio = null; return; }
    const r = cv.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const winMs = Math.max(2, Number(w.props?.windowSec) || 20) * 1000;
    c.pinned = true;
    c.ratio = ratio;
    c.time = viewEnd(w) - winMs + ratio * winMs;
  });
}

/* ─────────── 导出当前数据（CSV，UTF-8 BOM + CRLF，Excel 直接打开） ─────────── */
const pad2 = n => String(n).padStart(2, '0');
/** 本地时间 + 毫秒：`2026-10-18 14:32:05.123`（现场看表对时间方便，Excel 也认） */
function fmtTimeMs(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
const csvCell = v => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
/** 数值单元格：最多留 6 位小数（别把 0.30000000000000004 倒给 Excel）；非有限值留空 */
const numCell = v => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '');

/** 文件名：<项目名>-<页面名>-<控件名>.csv（哪一段取不到就用 trend 顶上；非法字符换成 _） */
export function csvFileNameOf(w) {
  const clean = s => String(s ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || 'trend';
  const proj = project?.data?.meta?.name || '';
  const page = project?.pages?.().find(p => (p.widgets || []).some(x => x.id === w?.id))?.name || '';
  return [clean(proj), clean(page), clean(w?.name || '')].join('-') + '.csv';
}

/**
 * 当前缓冲里的数据 → CSV 文本。
 *   · 列 = 时间,通道1…（时间是本地时间 + 毫秒；通道列用变量名，变量名不翻译）
 *   · 数值列用**显示值**（套过通道量程），跟画面上看到的一致；无值留空。
 *   · 行按时间升序；同一时刻各通道合成一行（通道是同一拍采的，偶尔差一拍也不会错行）。
 *   · 原 XY 模式的 `x,通道…` 列已移除（XY 曲线改用独立「XY 波形」控件）。
 */
export function csvTextOf(w) {
  const chans = channelsOf(w);
  const header = ['时间', ...chans.map(c => c.name)];
  const rows = [];
  const data = seriesOf(w.id);
  const byTime = new Map();            // 采样时刻 → { at, vals }
  chans.forEach(ch => (data.get(ch.name) || []).forEach(pt => {
    let row = byTime.get(pt.t);
    if (!row) { row = { at: pt.at, vals: new Map() }; byTime.set(pt.t, row); }
    row.vals.set(ch.name, pt.v);
  }));
  [...byTime.keys()].sort((a, b) => a - b).forEach(t => {
    const row = byTime.get(t);
    // 老数据没有 at（升级前采的点）：用"现在 - 已经过去的时间"反推墙钟时间
    const at = Number.isFinite(row.at) ? row.at : Date.now() - (performance.now() - t);
    rows.push([fmtTimeMs(at), ...chans.map(ch => numCell(tf(w, ch.name, row.vals.get(ch.name))))]);
  });
  const lines = [header, ...rows].map(r => r.map(csvCell).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** 导出用的文件名 + 文本（按钮与测试共用同一份实现） */
export function csvOf(w) {
  return { filename: csvFileNameOf(w), text: csvTextOf(w) };
}

/** 运行态控件右上角的「导出 CSV」按钮：事件委托绑一次（画布/按钮不重建，但页面会重建）。 */
function bindCsvButton() {
  document.addEventListener('click', e => {
    const btn = e.target?.closest?.('.trend-csv-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const w = project.findWidget(btn.closest('.wd')?.dataset.id);
    if (!w) return;
    try {
      const { filename, text } = csvOf(w);
      // exportText：桌面壳走原生另存为；浏览器退回收系统保存框/下载（见 core/csv.js）
      Promise.resolve(exportText(filename, text, { kind: 'csv' }))
        .catch(err => console.error('[trend] 导出 CSV 失败', err));
    } catch (err) {
      console.error('[trend] 导出 CSV 失败', err);
    }
  });
}

/* ─────────── 入口 ─────────── */
export function initTrend() {
  bus.on('mode:changed', ({ mode }) => {
    running = mode === 'run';
    cursors.clear();
    localCapture.clear();
    if (running) startSampling(); else { stopSampling(); clearTrend(); }
  });
  bindCursorEvents();
  bindCsvButton();
  startTrendLoop();
}
