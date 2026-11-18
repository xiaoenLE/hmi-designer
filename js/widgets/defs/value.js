/**
 * value.js — 数值显示 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 数值显示（已并入 number，隐藏保留兼容旧工程） */
import { register, rutil } from '../registry.js';
const { fmtValue, escapeHtml, varValue } = rutil;
import { numberFmtOf, dispValueOf } from '../../core/utils.js';
import { tr } from '../../core/i18n.js';

register({
  type: 'value',
  title: '数值显示',
  hidden: true,
  sub: '绑定变量输出',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="10" width="28" height="16" rx="3" fill="#fff" stroke="#94a3b8"/><text x="23" y="22" font-size="10" fill="#1f2329" text-anchor="end" font-family="Consolas">12.5</text></svg>',
  defaults: { w: 120, h: 38, fmt: '%.1f', dispType: 'float', decimals: 1, unit: '', fontSize: 16, textColor: '#1f2329', bgColor: '#ffffff', borderColor: '#c3cbd6' },
  props: [
    // 老工程只有 fmt 下拉（%d / %.1f / %.2f / %.3f）—— 现在和「数值」一样能选数据类型 + 自己填小数位
    { key: 'dispType', label: '数据类型', type: 'dtype' },
    { key: 'unit', label: '单位', type: 'text', i18n: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props;
    const v = varValue(w, vars);
    return `<div class="w-value" style="background:${p.bgColor};border-color:${p.borderColor}">
      <span class="v" style="font-size:${p.fontSize}px;color:${p.textColor}">${fmtValue(dispValueOf(v, p), numberFmtOf(p))}</span>
      ${p.unit ? `<span class="u">${escapeHtml(tr(p.unit))}</span>` : ''}</div>`;
  },
});
