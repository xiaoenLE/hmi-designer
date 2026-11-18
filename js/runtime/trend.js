/**
 * trend.js — 波形抓取（趋势图）的数据与绘制
 *
 *   · 数据：每个波形控件一份缓冲 { [变量名]: [{t, v}] }，按 sampleMs 采样 varStore 的值
 *   · 运行态：按控件属性采样（运行结束/重新运行清空）；编辑态：画静态预览曲线，方便调外观
 *   · 绘制：一个 rAF 循环（约 30fps）把页面上的 .trend-cv 逐帧重画（网格 / 坐标 / 曲线 / 图例）
 *
 * 为什么单独一个模块：波形控件是「自绘」的（def.selfDrawn），不走 innerHTML 局部刷新，
 * 数据也不进工程文件 —— 它属于运行态状态，和 varStore 一样是临时的。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { varStore } from './varstore.js';
import { onTick } from './ticker.js';

/** 通道配色（按勾选顺序取；可在属性面板里逐个改） */
export const PALETTE = ['#38bdf8', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb7185', '#a3e635'];
export const MAX_CHANNELS = 8;

const SAMPLE_TICK = 50;      // 采样调度粒度
const DRAW_INTERVAL = 33;    // 约 30fps
const KEEP_EXTRA = 1.15;     // 缓冲多留 15%，避免窗口边界处断线

const buffers = new Map();     // widgetId -> Map(varName -> [{t, v}])
const lastAt = new Map();      // widgetId -> 上次采样时刻
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

/** 取某控件的全部通道数据（测试/调试用） */
export function seriesOf(id) { return buffers.get(id) || new Map(); }
/** 清空（不给 id = 全部清空） */
export function clearTrend(id) {
  if (id) { buffers.delete(id); lastAt.delete(id); }
  else { buffers.clear(); lastAt.clear(); }
}
export function isPaused() { return paused; }
export function setPaused(p) { paused = !!p; }

/** 光标状态（测试/调试用）：{ pinned, ratio, time, values } */
export function cursorOf(id) {
  const c = cursors.get(id);
  if (!c || (!c.pinned && c.ratio == null)) return null;
  const w = project.findWidget(id);
  if (!w) return null;
  const buf = seriesOf(id);
  const winMs = Math.max(2, Number(w.props?.windowSec) || 20) * 1000;
  const tCur = c.pinned ? c.time : performance.now() - winMs + c.ratio * winMs;
  const values = {};
  channelsOf(w).forEach(ch => { values[ch.name] = valueAt(buf.get(ch.name), tCur, w); });
  return { pinned: !!c.pinned, time: tCur, offsetSec: (tCur - performance.now()) / 1000, values };
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
  const tol = Math.max(250, (Number(w?.props?.sampleMs) || 100) * 2.5);
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
bus.on('project:changed', () => { trendCache = null; });
bus.on('page:current', () => { trendCache = null; });

/** 采样一次：把每个波形控件的各通道当前值记进缓冲 */
function sampleOnce() {
  const now = performance.now();
  trendWidgets().forEach(w => {
    const chans = channelsOf(w);
    if (!chans.length) return;
    const period = Math.max(20, Number(w.props?.sampleMs) || 100);
    if (now - (lastAt.get(w.id) || 0) < period) return;
    lastAt.set(w.id, now);
    const keepMs = Math.max(2, Number(w.props?.windowSec) || 20) * 1000 * KEEP_EXTRA;
    const m = bufferOf(w.id);
    chans.forEach(ch => {
      let arr = m.get(ch.name);
      if (!arr) { arr = []; m.set(ch.name, arr); }
      const raw = varStore.get(ch.name);
      const v = typeof raw === 'boolean' ? (raw ? 1 : 0)
        : (typeof raw === 'number' && Number.isFinite(raw)) ? raw
        : (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
      arr.push({ t: now, v });
      const cut = now - keepMs;
      let drop = 0;
      while (drop < arr.length && arr[drop].t < cut) drop++;
      if (drop) arr.splice(0, drop);
    });
    // 停用/删掉的通道不再留数据
    const keep = new Set(chans.map(c => c.name));
    [...m.keys()].forEach(k => { if (!keep.has(k)) m.delete(k); });
  });
}

function startSampling() {
  clearTrend();
  if (stopSample) { stopSample(); stopSample = null; }
  // 走统一节拍器（ticker.js）：页面切到后台时浏览器的页面定时器会被降频到 1 秒一次，
  // 用裸 setInterval 采样会让后台期间的波形变成「一秒一个点、时间轴被拉稀」——现场实测过。
  let lastAt = 0;
  stopSample = onTick((now) => {
    if (paused) return;
    if (now - lastAt < SAMPLE_TICK) return;      // 保持原来 50ms 的采样粒度，不多跑
    lastAt = now;
    sampleOnce();
  });
}
function stopSampling() {
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
  const host = cv.parentElement;
  const cssW = Math.max(20, host?.clientWidth || w.w);
  const cssH = Math.max(20, host?.clientHeight || w.h);
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }

  const p = w.props || {};
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 42, padR = 8, padT = p.showLegend === false ? 8 : 20, padB = 16;
  const plotW = Math.max(10, cssW - padL - padR);
  const plotH = Math.max(10, cssH - padT - padB);

  // 背景
  ctx.fillStyle = p.bgColor || '#0f172a';
  ctx.fillRect(0, 0, cssW, cssH);

  const chans = channelsOf(w);
  const winMs = Math.max(2, Number(p.windowSec) || 20) * 1000;
  const runningNow = running;
  const data = seriesOf(w.id);
  const now = performance.now();
  const t0 = now - winMs, t1 = now;

  // 纵轴范围（用套过量程后的显示值）
  let lo = Number(p.yMin), hi = Number(p.yMax);
  const autoY = p.autoY !== false;
  if (autoY) {
    let mn = Infinity, mx = -Infinity;
    if (runningNow && chans.length) {
      chans.forEach(ch => (data.get(ch.name) || []).forEach(pt => {
        if (pt.t < t0 || !Number.isFinite(pt.v)) return;
        const v = tf(w, ch.name, pt.v);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }));
    }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
      lo = 0; hi = 1;                            // 还没数据：用干净的 0~1，别加余量免得刻度是 1.1/-0.1
    } else {
      if (mn === mx) { mn -= 1; mx += 1; }
      const pad = (mx - mn) * 0.12;
      lo = mn - pad; hi = mx + pad;
    }
  } else {
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  }
  const X = t => padL + ((t - t0) / (t1 - t0)) * plotW;
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * plotH;

  // 网格 + 刻度
  if (p.showGrid !== false) {
    ctx.strokeStyle = p.gridColor || '#1e3a5f';
    ctx.lineWidth = 1;
    ctx.fillStyle = p.textColor || '#cbd5e1';
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillText(fmt(hi - ((hi - lo) * i) / 4, p.decimals), padL - 5, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const x = padL + (plotW * i) / 4;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      const secs = Math.round((-winMs + (winMs * i) / 4) / 1000);
      ctx.fillText(secs === 0 ? 'now' : secs + 's', x, padT + plotH + 3);
    }
  }

  // 曲线
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, Number(p.lineWidth) || 2);
  chans.forEach(ch => {
    ctx.strokeStyle = ch.color;
    if (runningNow) {
      const pts = data.get(ch.name) || [];
      ctx.beginPath();
      let started = false;
      for (const pt of pts) {
        if (pt.t < t0 || !Number.isFinite(pt.v)) { started = false; continue; }
        const x = X(pt.t), y = Y(tf(w, ch.name, pt.v));
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

  // 编辑态：画静态预览曲线 + 提示，方便调颜色/尺寸
  if (!runningNow) {
    ctx.setLineDash([5, 4]);
    chans.forEach(ch => {
      ctx.strokeStyle = ch.color;
      ctx.beginPath();
      const amp = 0.26 + ch.slot * 0.06;
      for (let k = 0; k <= 60; k++) {
        const r = k / 60;
        const v = (0.5 + amp * Math.sin(r * Math.PI * 2 * (1 + ch.slot * 0.5))) * (hi - lo) + lo;
        const x = padL + r * plotW, y = Y(v);
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

  // 图例（颜色块 + 变量名 + 当前值）
  if (p.showLegend !== false && chans.length) {
    const fs = Math.max(9, Math.min(13, Number(p.fontSize) || 11));
    ctx.font = fs + 'px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let x = padL;
    const y = Math.max(9, padT / 2 + 2);
    chans.forEach(ch => {
      const val = runningNow ? varStore.get(ch.name) : null;
      const num = Number(val);
      const shown = typeof val === 'boolean' ? (val ? '1' : '0')
        : Number.isFinite(num) ? fmt(tf(w, ch.name, num), p.decimals) : '';
      const txt = `${ch.name} ${shown}`.trim();
      const tw = ctx.measureText(txt).width;
      if (x + tw + 16 > cssW - padR) return;      // 放不下就不画（窄控件不硬挤）
      ctx.fillStyle = ch.color;
      ctx.fillRect(x, y - 3, 6, 6);
      ctx.fillStyle = p.textColor || '#cbd5e1';
      ctx.fillText(txt, x + 10, y);
      x += tw + 22;
    });
    if (paused) {
      ctx.fillStyle = '#fbbf24';
      ctx.textAlign = 'right';
      ctx.fillText('⏸ 已暂停', cssW - padR, y);
    }
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
          ctx.arc(xCur, Y(tf(w, ch.name, v)), 3, 0, Math.PI * 2);
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
    c.time = performance.now() - winMs + ratio * winMs;
  });
}

/* ─────────── 入口 ─────────── */
export function initTrend() {
  bus.on('mode:changed', ({ mode }) => {
    running = mode === 'run';
    cursors.clear();
    if (running) startSampling(); else { stopSampling(); clearTrend(); }
  });
  bindCursorEvents();
  startTrendLoop();
}
