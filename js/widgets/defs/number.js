/**
 * number.js — 数值 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 数值（显示/输入二合一，主力数据控件） */
import { register, rutil } from '../registry.js';
const { fmtValue, escapeHtml, varValue } = rutil;
import { numberFmtOf } from '../../core/utils.js';
import { ARR_TYPES, SCALAR_NUM } from '../shared.js';

register({
  type: 'number',
  title: '数值',
  sub: '显示/输入二合一',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="10" width="28" height="16" rx="3" fill="#fff" stroke="#94a3b8"/><text x="15" y="22" font-size="10" fill="#1f2329" text-anchor="end" font-family="Consolas">12.5</text><rect x="27" y="16" width="5" height="5" rx="1" fill="#2563eb"/></svg>',
  defaults: { w: 150, h: 38, fmt: '%.1f', dispType: 'float', decimals: 1, editable: true, useKeyboard: true, unit: '', fontSize: 16, textColor: '#1f2329', bgColor: '#ffffff', borderColor: '#c3cbd6', borderWidth: 1, radius: 5 },
  props: [
    { key: 'editable', label: '可输入', type: 'check', defVal: true },
    { key: 'useKeyboard', label: '软键盘输入', type: 'check', defVal: true },
    // 绑数组变量时整段显示（[1, 2, 3]，只读）。要单个元素：数组「展开成单个变量」
    // （arrw[1]…arrw[N]）后绑那个元素变量 —— 不再有「数组元素」下标这一层。
    // 数据类型 int/uint/float/string；float 时附小数位（0=无小数点）。底层同步写 fmt 兼容旧工程
    { key: 'dispType', label: '数据类型', type: 'dtype' },
    { key: 'unit', label: '单位', type: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color', allowEmpty: true },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 12 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 60 },
  ],
  binding: { variable: { types: [...SCALAR_NUM, ...ARR_TYPES], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props;
    const v = varValue(w, vars);
    const val = fmtValue(v, numberFmtOf(p));   // 有效格式：优先 dispType/decimals，旧工程回落 fmt
    // 绑的是数组变量 → 整段显示、不可输入（往里写一个标量会与节点类型对不上）。
    // 要编辑某个元素：数组展开成 arrw[1]…arrw[N] 后绑那个元素变量。
    const isWholeArray = Array.isArray(v);
    const editable = p.editable !== false && !isWholeArray;   // 默认可输入
    // 不再显示 ✎ 图标：点击整个控件即可输入（软键盘或内联）
    return `<div class="w-number ${editable ? 'editable' : ''}" style="background:${p.bgColor || 'transparent'};border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};border-radius:${p.radius}px">
      <span class="wn-val" style="font-size:${p.fontSize}px;color:${p.textColor}">${escapeHtml(val)}</span>
      ${p.unit ? `<span class="wn-unit">${escapeHtml(p.unit)}</span>` : ''}
    </div>`;
  },
});
