/**
 * timer.js — 计时 / 时长 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 绑一个「秒」为单位的数值变量（PLC 里常见 DINT/UDINT 计时器），按 fmt 显示成：
 *   · 时:分:秒        → 01:01:01（超过 99 小时就照实显示 100:00:00，不截断）
 *   · 天 时:分:秒     → 1天 01:01:01
 *   · 时:分           → 01:01
 *   · 秒              → 3661
 * 0 / 负值 / 没绑变量 → 一律显示 00:00:00（现场：计时器没走就是 0，别显示负数或 NaN）。
 * 前缀/后缀是"给人看的文字" → props 里声明 i18n:'text'，render 里用 tr() 包，切语言跟着翻。
 */
import { register, rutil } from '../registry.js';
import { tr } from '../../core/i18n.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
const pad2 = (n) => (n < 10 ? '0' + n : String(n));

/** 秒 → 显示文字（0/负值统一 00:00:00；数字认不出的也当 0） */
function formatSeconds(sec, fmt) {
  const total = Math.floor(Number(sec));
  if (!Number.isFinite(total) || total <= 0) return '00:00:00';
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (fmt === 's') return String(total);
  if (fmt === 'hm') {
    // 「时:分」：小时把天也算进去（1天2小时 → 26:00），现场看的是"总共跑了多久"
    const hh = Math.floor(total / 3600);
    return `${pad2(hh)}:${pad2(m)}`;
  }
  if (fmt === 'dhms') return `${d}天 ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  // 默认 hms：小时不按 24 取模（100:00:00 是有效显示）
  const hh = Math.floor(total / 3600);
  return `${pad2(hh)}:${pad2(m)}:${pad2(s)}`;
}

register({
  type: 'timer',                 // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '计时',
  sub: '秒 → 时:分:秒（绑数值变量）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><circle cx="18" cy="20" r="11" fill="#fff" stroke="#2563eb" stroke-width="1.8"/><path d="M18 13v7l4.5 2.6" stroke="#2563eb" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M14 5h8M18 5v4" stroke="#52606d" stroke-width="2" stroke-linecap="round"/></svg>',
  defaults: {
    w: 200, h: 40,
    fmt: 'hms',                  // hms / dhms / hm / s
    prefix: '', suffix: '',
    fontSize: 20, textColor: '#1f2329', bold: false, align: 'center',
    bgColor: '', borderColor: '', borderWidth: 0, radius: 0,
  },
  props: [
    { key: 'fmt', label: '显示格式', type: 'select', defVal: 'hms', options: [
      { v: 'hms', t: '时:分:秒' },
      { v: 'dhms', t: '天 时:分:秒' },
      { v: 'hm', t: '时:分' },
      { v: 's', t: '秒' },
    ] },
    // 前缀/后缀是"给人看的文字" → 声明 i18n，render 里用 tr() 包
    { key: 'prefix', label: '前缀', type: 'text', i18n: 'text' },
    { key: 'suffix', label: '后缀', type: 'text', i18n: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 96 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bold', label: '加粗', type: 'check' },
    { key: 'align', label: '对齐', type: 'select', options: [
      { v: 'left', t: '左' }, { v: 'center', t: '中' }, { v: 'right', t: '右' },
    ] },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: '绑定变量（秒）' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const v = varValue(w, vars);
    const sec = (v === null || v === undefined || v === '') ? 0 : Number(v);
    const fmt = ['hms', 'dhms', 'hm', 's'].includes(p.fmt) ? p.fmt : 'hms';
    const base = formatSeconds(sec, fmt);
    const align = p.align === 'left' ? 'flex-start' : p.align === 'right' ? 'flex-end' : 'center';
    const bg = p.bgColor ? `background:${p.bgColor};` : '';
    const bw = clamp(numOr(p.borderWidth, 0), 0, 8);
    const bd = bw > 0 ? `border:${bw}px solid ${p.borderColor || '#c3cbd6'};` : '';
    const fs = clamp(numOr(p.fontSize, 20), 8, 96);
    const radius = clamp(numOr(p.radius, 0), 0, 100);
    // 前缀/后缀：先取译文再转义（译文里也可能有尖括号）
    const pre = tr(p.prefix || '');
    const suf = tr(p.suffix || '');
    const preEl = pre ? `<span class="wt-pre">${escapeHtml(pre)}</span>` : '';
    const sufEl = suf ? `<span class="wt-suf">${escapeHtml(suf)}</span>` : '';
    const secAttr = Number.isFinite(Number(sec)) ? String(Number(sec)) : '0';
    return `<div class="w-timer" data-fmt="${fmt}" data-sec="${escapeHtml(secAttr)}"
      style="width:100%;height:100%;display:flex;align-items:center;justify-content:${align};gap:4px;box-sizing:border-box;padding:0 8px;overflow:hidden;white-space:nowrap;
      font-size:${fs}px;color:${p.textColor || '#1f2329'};font-weight:${p.bold ? 700 : 400};${bg}${bd}border-radius:${radius}px">
      ${preEl}<span class="wt-val" style="font-variant-numeric:tabular-nums">${escapeHtml(base)}</span>${sufEl}
    </div>`;
  },
});
