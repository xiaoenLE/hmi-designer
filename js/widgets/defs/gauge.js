/**
 * gauge.js — 仪表盘（圆弧 + 指针 + 数值）控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 纯显示件，全部用**内联 SVG** 画（不引第三方、也不改公共 CSS）：
 *   · 圆弧：起点角度/扫过角度可调（默认 135°~405°，即经典"下半圆开口朝下"的表盘）
 *   · 数值区：按 min~max 折算角度，超过 warnAt / criticalAt 整条弧+数值换色（0 = 不启用该阈值）
 *   · 指针：跟着变量值转，指针色单独可调
 *   · 单位：走 js/core/i18n.js 的 tr()（props 里声明 i18n:'text'，切语言时跟着翻）
 */
import { register, rutil } from '../registry.js';
import { tr } from '../../core/i18n.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** 老工程缺键一律兜底（这套代码的固定风格）：认得出数字就用它，否则用默认值 */
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
/** 角度/坐标统一留两位小数：SVG 属性别塞一长串浮点，读起来也干净 */
const fmt2 = (n) => String(Math.round(n * 100) / 100);

/** 极坐标 → SVG 坐标（0° = 正右，顺时针为正；SVG 的 y 轴向下，所以 sin 直接就是顺时针） */
function polar(cx, cy, r, deg) {
  const a = deg * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** 圆弧 path：从 a0 顺时针画到 a1（a1 < a0 时反向），large-arc 按实际跨度算 */
function arcPath(cx, cy, r, a0, a1) {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${fmt2(x0)} ${fmt2(y0)} A ${r} ${r} 0 ${large} ${sweep} ${fmt2(x1)} ${fmt2(y1)}`;
}

register({
  type: 'gauge',                 // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '仪表盘',
  sub: '圆弧+指针，绑数值变量（可超限变色）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><path d="M5 27a13 13 0 1 1 26 0" fill="none" stroke="#c3cbd6" stroke-width="2.4" stroke-linecap="round"/><path d="M18 24l8-9" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round"/><circle cx="18" cy="24" r="2.4" fill="#2563eb"/><circle cx="9" cy="24" r="1.4" fill="#94a3b8"/><circle cx="27" cy="24" r="1.4" fill="#94a3b8"/></svg>',
  defaults: {
    w: 200, h: 200,
    min: 0, max: 100, decimals: 0, unit: '',
    warnAt: 0, warnColor: '#f59e0b',       // 0 = 不启用（跟棒图 warnAt 一个口径）
    criticalAt: 0, criticalColor: '#ef4444',
    showValue: true,
    arcColor: '#2563eb',                   // 正常状态的圆弧/数值色
    needleColor: '#1f2329',
    bgColor: '',                           // 表盘底色（空 = 透明）
    tickColor: '#64748b',                  // 刻度 + 未填充的圆弧轨道
    fontSize: 22,
    textColor: '#1f2329',
    startAngle: 135, sweepAngle: 270,      // 135°~405°：缺口朝下的经典表盘
  },
  props: [
    { key: 'min', label: '最小', type: 'number' },
    { key: 'max', label: '最大', type: 'number' },
    { key: 'decimals', label: '小数位', type: 'number', min: 0, max: 6, defVal: 0 },
    // 单位是"给人看的文字" → 声明 i18n，render 里用 tr() 包（切语言时跟着翻）
    { key: 'unit', label: '单位', type: 'text', i18n: 'text' },
    { key: 'warnAt', label: '警告阈值', type: 'number', defVal: 0 },
    { key: 'warnColor', label: '警告色', type: 'color' },
    { key: 'criticalAt', label: '严重阈值', type: 'number', defVal: 0 },
    { key: 'criticalColor', label: '严重色', type: 'color' },
    { key: 'showValue', label: '显示数值', type: 'check', defVal: true },
    { key: 'arcColor', label: '圆弧色', type: 'color' },
    { key: 'needleColor', label: '指针色', type: 'color' },
    { key: 'bgColor', label: '表盘底色', type: 'color' },
    { key: 'tickColor', label: '刻度色', type: 'color' },
    { key: 'textColor', label: '数值色', type: 'color' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'startAngle', label: '起始角度', type: 'number', min: -360, max: 720 },
    { key: 'sweepAngle', label: '扫过角度', type: 'number', min: 10, max: 360 },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const v = varValue(w, vars);
    const raw = (v === null || v === undefined || v === '') ? null : Number(v);
    const val = Number.isFinite(raw) ? raw : null;
    const min = numOr(p.min, 0);
    const max = numOr(p.max, 100);
    const span = (max - min) || 1;                                   // 防 0：min == max 时别除出 Infinity
    const dec = clamp(Math.round(numOr(p.decimals, 0)), 0, 6);
    const start = numOr(p.startAngle, 135);
    const sweep = clamp(numOr(p.sweepAngle, 270), 10, 360);
    // 值 → 0~1（超出量程就顶到两头，不画出表盘外）
    const ratio = val === null ? 0 : clamp((val - min) / span, 0, 1);
    const valueAngle = start + sweep * ratio;
    const warnAt = numOr(p.warnAt, 0);
    const criticalAt = numOr(p.criticalAt, 0);
    // 阈值按**变量值本身**比较；0 = 不启用（跟棒图一个口径）。严重优先。
    const isCritical = criticalAt > 0 && val !== null && val >= criticalAt;
    const isWarn = !isCritical && warnAt > 0 && val !== null && val >= warnAt;
    const state = isCritical ? 'critical' : isWarn ? 'warn' : 'normal';
    const stateColor = state === 'critical' ? (p.criticalColor || '#ef4444')
      : state === 'warn' ? (p.warnColor || '#f59e0b')
        : (p.arcColor || '#2563eb');
    const tick = p.tickColor || '#64748b';
    const needle = p.needleColor || '#1f2329';
    const bg = p.bgColor || 'none';
    const fs = clamp(numOr(p.fontSize, 22), 8, 72);
    const unit = tr(p.unit || '');
    const valueText = val === null ? '--' : `${val.toFixed(dec)}${unit}`;
    // 阈值分区：把"值"换算成角度，画两段彩弧（警告段 / 严重段）
    const angOf = (x) => start + sweep * clamp((x - min) / span, 0, 1);
    const fullEnd = start + sweep;
    let zones = '';
    if (warnAt > 0) {
      const a0 = angOf(warnAt);
      const a1 = criticalAt > 0 ? clamp(angOf(criticalAt), a0, fullEnd) : fullEnd;
      if (a1 - a0 > 0.05) zones += `<path class="wg-zone wg-zone-warn" d="${arcPath(100, 100, 80, a0, a1)}" fill="none" stroke="${p.warnColor || '#f59e0b'}" stroke-width="8" stroke-linecap="butt" opacity="0.9"/>`;
    }
    if (criticalAt > 0) {
      const a0 = angOf(criticalAt);
      if (fullEnd - a0 > 0.05) zones += `<path class="wg-zone wg-zone-critical" d="${arcPath(100, 100, 80, a0, fullEnd)}" fill="none" stroke="${p.criticalColor || '#ef4444'}" stroke-width="8" stroke-linecap="round"/>`;
    }
    // 刻度：固定 11 根（含首尾），跟扫过角度/起始角度一起转
    let ticks = '';
    for (let i = 0; i < 11; i++) {
      const deg = start + (sweep * i) / 10;
      const [x0, y0] = polar(100, 100, 92, deg);
      const [x1, y1] = polar(100, 100, 98, deg);
      ticks += `<line x1="${fmt2(x0)}" y1="${fmt2(y0)}" x2="${fmt2(x1)}" y2="${fmt2(y1)}" stroke="${tick}" stroke-width="2" stroke-linecap="round"/>`;
    }
    const [nx, ny] = polar(100, 100, 64, valueAngle);
    const needleEl = `<line class="wg-needle" x1="100" y1="100" x2="${fmt2(nx)}" y2="${fmt2(ny)}" stroke="${needle}" stroke-width="4" stroke-linecap="round"/>`;
    const hub = `<circle cx="100" cy="100" r="8" fill="${needle}"/><circle cx="100" cy="100" r="3.2" fill="${bg === 'none' ? '#ffffff' : bg}"/>`;
    const valueEl = p.showValue === false ? '' : `<text class="wg-value" x="100" y="152" text-anchor="middle" fill="${state === 'normal' ? (p.textColor || '#1f2329') : stateColor}" font-size="${fs}" font-weight="600" font-family="Segoe UI, Microsoft YaHei, sans-serif">${escapeHtml(valueText)}</text>`;
    return `<div class="w-gauge" data-gauge-state="${state}" data-gauge-value="${val === null ? '' : escapeHtml(String(val))}" data-start-angle="${fmt2(start)}" data-sweep-angle="${fmt2(sweep)}" data-needle-angle="${fmt2(valueAngle)}"
      style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;overflow:hidden">
      <svg class="wg-svg" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
        <circle cx="100" cy="100" r="97" fill="${bg}"/>
        <path class="wg-track" d="${arcPath(100, 100, 80, start, fullEnd)}" fill="none" stroke="${tick}" stroke-width="8" stroke-linecap="round" opacity="0.22"/>
        ${zones}
        <path class="wg-arc" d="${arcPath(100, 100, 80, start, valueAngle)}" fill="none" stroke="${stateColor}" stroke-width="8" stroke-linecap="round"/>
        ${ticks}
        ${needleEl}
        ${hub}
        ${valueEl}
      </svg>
    </div>`;
  },
});
