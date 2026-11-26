import { escapeHtml } from '../../core/utils.js';
import { tr } from '../../core/i18n.js';

export const PLOT_TICKS = [
  { key: 'xTicks', label: 'X 轴刻度数', type: 'number', min: 2, max: 20, defVal: 5, group: '网格刻度' },
  { key: 'yTicks', label: 'Y 轴刻度数', type: 'number', min: 2, max: 20, defVal: 5, group: '网格刻度' },
];

export const PLOT_BUTTONS = [
  { key: 'showCaptureBtn', label: '开始／停止抓取', type: 'check', defVal: false, group: '画面按钮',
    title: '运行时手动开始或停止本波形。绑定了启动抓取变量时由变量控制。' },
  { key: 'showClearBtn', label: '清除数据', type: 'check', defVal: false, group: '画面按钮',
    title: '运行时清除本波形的记录。绑定了清除数据变量时由变量控制。' },
];

export function plotTickCount(value) {
  const n = Number(value ?? 5);
  return Number.isFinite(n) ? Math.max(2, Math.min(20, Math.round(n))) : 5;
}

export function plotSwitch(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'TRUE';
}

export function plotCapturing(w, get, manual) {
  const name = w?.bindings?.startVar;
  return name ? plotSwitch(get(name)) : w?.props?.showCaptureBtn !== true || manual;
}

export function plotColor(value, fallback) {
  return typeof value === 'string' && CSS.supports('color', value) && !value.includes(';') ? value : fallback;
}

function plotLegendRows(entries) {
  return entries.map(({ label, color }) =>
    `<span class="w-plot-entry"><span class="w-plot-swatch" style="background-color:${escapeHtml(plotColor(color, '#38bdf8'))}"></span><span>${escapeHtml(label)}</span></span>`).join('');
}

const captureLabel = active => tr(active ? '停止抓取' : '开始抓取');

export function renderPlotHeader(w, mode, entries, active, extra = '') {
  const p = w.props || {};
  const bindings = w.bindings || {};
  const preview = mode === 'run' ? '' : ' disabled';
  const buttons = [];
  if (p.showCaptureBtn === true && !bindings.startVar) {
    buttons.push(`<button type="button" class="w-plot-capture${active ? ' capturing' : ''}"${preview}>${escapeHtml(captureLabel(active))}</button>`);
  }
  if (p.showClearBtn === true && !bindings.clearVar) {
    buttons.push(`<button type="button" class="w-plot-clear"${preview}>${escapeHtml(tr('清除数据'))}</button>`);
  }
  if (extra) buttons.push(extra);

  const legend = p.showLegend !== false && entries.length ? `<div class="w-plot-legend">${plotLegendRows(entries)}</div>` : '';
  if (!legend && buttons.length === 0) return '';
  const tools = buttons.length ? `<div class="w-plot-tools">${buttons.join('')}</div>` : '';
  const fg = escapeHtml(plotColor(p.textColor, '#cbd5e1'));
  const fs = Math.max(9, Math.min(13, Number(p.fontSize) || 11));
  return `<div class="w-plot-header" style="color:${fg};font-size:${fs}px">${legend}${tools}</div>`;
}

export function updatePlotLegend(legend, entries) {
  if (!legend) return;
  if (legend.children.length !== entries.length) {
    legend.innerHTML = plotLegendRows(entries);
    return;
  }
  entries.forEach(({ label, color }, i) => {
    const item = legend.children[i];
    const text = item.lastElementChild;
    if (text.textContent !== label) text.textContent = label;
    const swatch = item.firstElementChild;
    if (swatch.dataset.color !== color) {
      swatch.style.backgroundColor = plotColor(color, '#38bdf8');
      swatch.dataset.color = color;
    }
  });
}

export function bindPlotControls(el, w, api, { toggle, clear }) {
  el.addEventListener('click', e => {
    const button = e.target.closest('.w-plot-capture, .w-plot-clear');
    if (!button || button.disabled) return;
    e.stopPropagation();
    if (button.classList.contains('w-plot-capture')) {
      if (w.bindings?.startVar || !api.allowed()) return;
      const active = toggle();
      button.textContent = captureLabel(active);
      button.classList.toggle('capturing', active);
    } else {
      if (!w.bindings?.clearVar && api.allowed()) clear();
    }
  });
}
