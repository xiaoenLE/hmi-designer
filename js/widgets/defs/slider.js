/**
 * slider.js — 滑动条 控件定义（运行态可拖）
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 交互分两层：
 *   · render(w, mode, vars) 只负责画（编辑态 / 运行态同一个样子，所见即所得）
 *   · attach(el, w, api) 只在**运行态**由 runtime.buildWidget 调一次，绑的是**控件根 el** 上的
 *     事件委托 —— 变量一变 refreshWidgetBody 只重建里面的 .wd-body，绑子元素就跟着 DOM 一起没了。
 *
 * 写入只在松手时做（拖动过程中只改 DOM 预览）：pointerdown→setPointerCapture→pointermove 实时预览
 * →pointerup/cancel 调 api.set()（varStore 里那套链路门 / 写后保护 / 失败回读全照旧走）。
 * 最后统一 api.refresh()：链路门挡下 / 权限不够时画面按 varStore 里的**真值**重画，绝不留在假预览上。
 */
import { register, rutil } from '../registry.js';
import { tr } from '../../core/i18n.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
/** 数字里有几位小数（给步长/小数位取整用：step=0.1 时不能按 0 位取整） */
const decimalsOf = (s) => {
  const t = String(s);
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
};

/** 从事件位置算"指针落在量程的哪一段" → 折成 0~1（水平左→右，垂直下→上） */
function ratioOf(el, e, vertical) {
  const wrap = el.querySelector('.wsl-trackwrap');
  if (!wrap) return null;
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  let ratio;
  if (vertical) ratio = 1 - (e.clientY - r.top) / r.height;
  else ratio = (e.clientX - r.left) / r.width;
  return clamp(ratio, 0, 1);
}

/** 0~1 → 按 step 吸附、夹进 min~max 的数值（小数位按 decimals 与 step 里较多的那位取） */
function valueOfRatio(p, ratio) {
  const min = numOr(p.min, 0);
  const max = numOr(p.max, 100);
  const span = (max - min) || 1;
  const stepRaw = numOr(p.step, 1);
  const step = stepRaw > 0 ? stepRaw : 1;
  const dec = clamp(Math.round(numOr(p.decimals, 0)), 0, 6);
  const fixed = Math.min(6, Math.max(dec, decimalsOf(step)));
  const snapped = min + Math.round((ratio * span) / step) * step;
  return clamp(Number(clamp(snapped, min, max).toFixed(fixed)), min, max);
}

register({
  type: 'slider',                // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '滑动条',
  sub: '拖动设置数值（运行态可操作）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="16" width="28" height="4" rx="2" fill="#c3cbd6"/><rect x="4" y="16" width="17" height="4" rx="2" fill="#2563eb"/><circle cx="21" cy="18" r="6" fill="#fff" stroke="#2563eb" stroke-width="2"/></svg>',
  defaults: {
    w: 220, h: 44,
    min: 0, max: 100, step: 1,
    orientation: 'h',              // h 水平 / v 垂直
    showValue: true,
    unit: '', decimals: 0,
    trackColor: '#e5e7eb', fillColor: '#2563eb', knobColor: '#ffffff', textColor: '#1f2329',
    trackH: 8, radius: 4,
  },
  props: [
    { key: 'min', label: '最小', type: 'number' },
    { key: 'max', label: '最大', type: 'number' },
    { key: 'step', label: '步长', type: 'number', min: 0, max: 10000, defVal: 1 },
    { key: 'orientation', label: '方向', type: 'select', options: [
      { v: 'h', t: '水平' }, { v: 'v', t: '垂直' },
    ] },
    { key: 'showValue', label: '显示数值', type: 'check', defVal: true },
    // 单位是"给人看的文字" → 声明 i18n，render 里用 tr() 包
    { key: 'unit', label: '单位', type: 'text', i18n: 'text' },
    { key: 'decimals', label: '小数位', type: 'number', min: 0, max: 6, defVal: 0 },
    { key: 'trackColor', label: '滑轨色', type: 'color' },
    { key: 'fillColor', label: '填充色', type: 'color' },
    { key: 'knobColor', label: '手柄色', type: 'color' },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'trackH', label: '滑轨粗细', type: 'number', min: 2, max: 60 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
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
    const span = (max - min) || 1;
    const ratio = val === null ? 0 : clamp((val - min) / span, 0, 1);
    const pct = (ratio * 100).toFixed(2);
    const vertical = p.orientation === 'v';
    const dec = clamp(Math.round(numOr(p.decimals, 0)), 0, 6);
    const unit = tr(p.unit || '');
    const txt = val === null ? '--' : val.toFixed(dec) + unit;
    const trackH = clamp(Math.round(numOr(p.trackH, 8)), 2, 60);
    const radius = clamp(Math.round(numOr(p.radius, 4)), 0, 30);
    const trackColor = p.trackColor || '#e5e7eb';
    const fillColor = p.fillColor || '#2563eb';
    const knobColor = p.knobColor || '#ffffff';
    const textColor = p.textColor || '#1f2329';
    const knob = Math.max(trackH + 10, 18);
    // 数值字号没有单独属性（属性面板已经够长了）：按控件短边缩放，别在小控件上糊成一团
    const boxW = Math.max(1, numOr(w.w, 220));
    const boxH = Math.max(1, numOr(w.h, 44));
    const fs = clamp(Math.round(Math.min(boxW, boxH) * 0.3), 10, 26);
    const valEl = p.showValue === false ? ''
      : `<span class="wsl-val" style="flex:none;${vertical ? 'padding-top:4px;' : 'min-width:2.4em;text-align:right;'}font-size:${fs}px;color:${textColor};font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden">${escapeHtml(txt)}</span>`;
    const trackEl = `<div class="wsl-track" style="position:absolute;${vertical
      ? 'left:50%;top:0;bottom:0;transform:translateX(-50%);width:' + trackH + 'px;'
      : 'left:0;right:0;top:50%;transform:translateY(-50%);height:' + trackH + 'px;'}background:${trackColor};border-radius:${radius}px"></div>`;
    const fillEl = `<div class="wsl-fill" style="position:absolute;${vertical
      ? 'left:50%;bottom:0;transform:translateX(-50%);width:' + trackH + 'px;height:' + pct + '%;'
      : 'left:0;top:50%;transform:translateY(-50%);height:' + trackH + 'px;width:' + pct + '%;'}background:${fillColor};border-radius:${radius}px"></div>`;
    const knobEl = `<div class="wsl-knob" style="position:absolute;${vertical
      ? 'left:50%;bottom:' + pct + '%;transform:translate(-50%,50%);'
      : 'top:50%;left:' + pct + '%;transform:translate(-50%,-50%);'}width:${knob}px;height:${knob}px;border-radius:50%;background:${knobColor};border:2px solid ${fillColor};box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.28)"></div>`;
    return `<div class="w-slider" data-orientation="${vertical ? 'v' : 'h'}" data-min="${min}" data-max="${max}"
      style="width:100%;height:100%;display:flex;flex-direction:${vertical ? 'column' : 'row'};align-items:center;gap:8px;box-sizing:border-box;padding:2px 4px;cursor:pointer;touch-action:none;user-select:none;overflow:hidden">
      <div class="wsl-trackwrap" style="position:relative;${vertical ? 'flex:1;width:100%;min-height:0;' : 'flex:1;height:100%;min-width:0;'}">
        ${trackEl}${fillEl}${knobEl}
      </div>
      ${valEl}
    </div>`;
  },
  /**
   * 运行态交互。事件全部绑在控件根 el 上（refreshWidgetBody 只换 .wd-body），
   * 每次用 el.querySelector 现取子元素 —— 重建过也照样拿得到。
   */
  attach(el, w, api) {
    let drag = null;                 // { id: pointerId, value: 当前预览值 }
    const varName = () => (w.bindings ? (w.bindings.variable || '') : '');
    const props = () => w.props || {};
    const preview = (val) => {
      const p = props();
      const min = numOr(p.min, 0);
      const max = numOr(p.max, 100);
      const span = (max - min) || 1;
      const vertical = p.orientation === 'v';
      const pct = ((clamp(val, min, max) - min) / span * 100).toFixed(2);
      const fill = el.querySelector('.wsl-fill');
      const knob = el.querySelector('.wsl-knob');
      const label = el.querySelector('.wsl-val');
      if (fill) {
        if (vertical) { fill.style.height = pct + '%'; fill.style.width = ''; }
        else { fill.style.width = pct + '%'; fill.style.height = ''; }
      }
      if (knob) {
        if (vertical) { knob.style.bottom = pct + '%'; knob.style.left = '50%'; }
        else { knob.style.left = pct + '%'; knob.style.bottom = ''; }
      }
      if (label) {
        const dec = clamp(Math.round(numOr(p.decimals, 0)), 0, 6);
        label.textContent = val.toFixed(dec) + tr(p.unit || '');
      }
    };
    const finish = () => {
      if (!drag) return;
      const id = drag.id;
      const value = drag.value;
      drag = null;
      try { if (el.releasePointerCapture) el.releasePointerCapture(id); } catch (e) { /* 指针已经没了 */ }
      const name = varName();
      if (name && api.allowed()) api.set(name, value);
      // 统一按 varStore 里的真值重画：写成功 / 被链路门挡下 / 没权限，三种情况都不会留在假预览上
      api.refresh();
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!api.allowed()) return;                     // 权限 / 按条件启用：先过闸（该弹密码框的会弹）
      if (!varName()) return;                         // 没绑变量：纯显示，不响应
      const ratio = ratioOf(el, e, props().orientation === 'v');
      if (ratio === null) return;
      const value = valueOfRatio(props(), ratio);
      e.preventDefault();                             // 拖动时别选中文字 / 别触发页面滚动
      drag = { id: e.pointerId, value: value };
      try { if (el.setPointerCapture) el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      preview(value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const ratio = ratioOf(el, e, props().orientation === 'v');
      if (ratio === null) return;
      drag.value = valueOfRatio(props(), ratio);
      preview(drag.value);
    });
    el.addEventListener('pointerup', (e) => {
      if (drag && e.pointerId === drag.id) finish();
    });
    el.addEventListener('pointercancel', (e) => {
      if (drag && e.pointerId === drag.id) finish();
    });
  },
});
