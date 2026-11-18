/**
 * clock.js — 时钟 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 时钟（当前时间，格式自定义） */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { fmtTime, TIME_PRESETS } from '../../core/utils.js';
import { pickTimeFmt } from '../shared.js';
import { tr } from '../../core/i18n.js';

/* 倒计时 / 累计的走时状态：widgetId -> { elapsedMs, lastAt, mode }
   为什么放在 def 里：这是"这个控件自己的显示状态"，不需要进工程文件，也不需要 runtime 知道。
   attach 里 250ms api.refresh() 推进；元素被换掉（换页/重画）时旧定时器自己发现 isConnected=false 退出。 */
const TIMER_STATE = new Map();

/** 秒 → 时:分:秒（累计超 24h 不归零；小时位至少两位） */
function fmtHms(sec) {
  let total = Math.floor(Math.abs(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
/** 非「当前时间」模式下，按状态 Map 算出该显示多少秒 */
function timerSecOf(w, mode) {
  const p = w.props || {};
  const startRaw = Number(p.timerStartSec);
  const startMs = (Number.isFinite(startRaw) && startRaw > 0 ? startRaw : 0) * 1000;
  const st = TIMER_STATE.get(w.id);
  const elapsed = st ? st.elapsedMs : 0;
  if (mode === 'countdown') return Math.max(0, startMs - elapsed) / 1000;
  return (startMs + elapsed) / 1000;
}
/** 计时变量当真假用（1/'1'/true 都认）；没填 = 一直走 */
function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE';
}

register({
  type: 'clock',
  title: '时钟',
  sub: '当前时间（年月日时分秒）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><circle cx="18" cy="18" r="12" fill="#fff" stroke="#2563eb" stroke-width="1.6"/><path d="M18 11v7l4.5 3" stroke="#2563eb" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
  defaults: {
    w: 190, h: 34,
    timeFmt: 'YYYY-MM-DD hh:mm:ss', timeFmtCustom: 'YYYY-MM-DD hh:mm:ss',
    // 显示模式：current = 当前时间（默认，老行为）；countdown = 倒计时；cumulative = 累计时长
    mode: 'current',
    timerVar: '', timerStartSec: 0,
    prefix: '', suffix: '',
    fontSize: 16, textColor: '#1f2329', bold: false, align: 'left',
    bgColor: '', borderColor: '#c3cbd6', borderWidth: 0, radius: 4,
  },
  props: [
    { key: 'mode', label: '显示模式', type: 'select', options: [
      { v: 'current', t: '当前时间' }, { v: 'countdown', t: '倒计时' }, { v: 'cumulative', t: '累计时长' }] },
    { key: 'timeFmt', label: '时间格式', type: 'select', options: TIME_PRESETS },
    { key: 'timeFmtCustom', label: '自定义格式', type: 'text' },
    // 计时控制：只有倒计时/累计模式用得到，单独一栏
    { key: 'timerVar', label: '计时变量', type: 'text', group: '计时' },
    { key: 'timerStartSec', label: '起始秒', type: 'number', min: 0, max: 315360000, defVal: 0, group: '计时' },
    { key: 'prefix', label: '前缀', type: 'text', i18n: 'text' },
    { key: 'suffix', label: '后缀', type: 'text', i18n: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 96 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bold', label: '加粗', type: 'check' },
    { key: 'align', label: '对齐', type: 'select', options: [{ v: 'left', t: '左' }, { v: 'center', t: '中' }, { v: 'right', t: '右' }] },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props;
    const mode = p.mode === 'countdown' ? 'countdown' : p.mode === 'cumulative' ? 'cumulative' : 'current';
    const align = p.align === 'center' ? 'center' : p.align === 'right' ? 'flex-end' : 'flex-start';
    const bg = p.bgColor ? `background:${p.bgColor};` : '';
    const bd = +p.borderWidth > 0 ? `border:${+p.borderWidth}px solid ${p.borderColor || 'transparent'};` : '';
    let timeHTML;
    if (mode === 'current') {
      // 当前时间：data-clock-fmt 由 widgets/clock.js 的定时器统一刷新文字（毫秒格式自动加快到 100ms 一拍）
      const fmt = pickTimeFmt(p, 'YYYY-MM-DD hh:mm:ss');
      timeHTML = `<span class="wc-time" data-clock-fmt="${escapeHtml(fmt)}">${escapeHtml(fmtTime(Date.now(), fmt))}</span>`;
    } else {
      // 倒计时 / 累计：时:分:秒，由本 def 的 attach 定时推进（不带 data-clock-fmt，别被当前时间定时器覆盖）
      timeHTML = `<span class="wc-time">${escapeHtml(fmtHms(timerSecOf(w, mode)))}</span>`;
    }
    return `<div class="w-clock" style="font-size:${p.fontSize}px;color:${p.textColor};font-weight:${p.bold ? 700 : 400};justify-content:${align};${bg}${bd}border-radius:${p.radius}px"><span class="wc-pre">${escapeHtml(tr(p.prefix || ''))}</span>${timeHTML}<span class="wc-suf">${escapeHtml(tr(p.suffix || ''))}</span></div>`;
  },
  /**
   * 倒计时 / 累计的走时：250ms 推进一次，api.refresh() 只重建样式和文字（不抢焦点）。
   * timerVar 非空时：它为真才走，变假就停住（已走的时间保留）；留空 = 一直走。
   * ⚠ 当前时间模式不在这里做（那边由 widgets/clock.js 的全局定时器刷）。
   */
  attach(el, w, api) {
    const p = w.props || {};
    const mode = p.mode === 'countdown' ? 'countdown' : p.mode === 'cumulative' ? 'cumulative' : 'current';
    if (mode === 'current') return;
    let st = TIMER_STATE.get(w.id);
    if (!st) { st = { elapsedMs: 0, lastAt: 0, mode }; TIMER_STATE.set(w.id, st); }
    else if (st.mode !== mode) { st.elapsedMs = 0; st.lastAt = 0; st.mode = mode; }
    let tid = 0;
    let connected = false;
    let miss = 0;
    const tick = () => {
      // ⚠ attach 是在 buildWidget 里调的，那时控件还没被 append 进文档（isConnected=false）：
      //   首拍先等它插进去；曾经连上过又断开（换页/重画）才是真没了 → 停表。
      if (!el.isConnected) {
        if (connected) { clearInterval(tid); return; }
        miss++;
        if (miss > 20) clearInterval(tid);           // 5 秒都没插进文档：别再空转
        return;
      }
      connected = true;
      // 运行中属性被改（页面重画、脚本改工程）：以最新 props 为准
      const nowMode = p.mode === 'countdown' ? 'countdown' : p.mode === 'cumulative' ? 'cumulative' : 'current';
      if (nowMode !== mode) return;
      const startRaw = Number(p.timerStartSec);
      const startMs = (Number.isFinite(startRaw) && startRaw > 0 ? startRaw : 0) * 1000;
      const tv = String(p.timerVar == null ? '' : p.timerVar).trim();
      const now = performance.now();
      const go = tv === '' ? true : truthy(api.get(tv));
      if (go) {
        if (st.lastAt) st.elapsedMs += now - st.lastAt;
        st.lastAt = now;
        if (mode === 'countdown' && st.elapsedMs > startMs) st.elapsedMs = startMs;  // 倒到 0 就停在 0
      } else {
        st.lastAt = 0;                                        // 停住：下次为真从这一刻接着走
      }
      api.refresh();
    };
    tid = setInterval(tick, 250);
  },
});
