/**
 * label.js — 文本 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 文本标签 */
import { register, rutil } from '../registry.js';
const { fmtValue, escapeHtml, varValue } = rutil;
import { ARR_TYPES, SCALAR_NUM } from '../shared.js';

register({
  type: 'label',
  title: '文本',
  sub: '静态文字/动态文本',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="8" width="28" height="20" rx="3" fill="#eef2f7" stroke="#c3cbd6"/><text x="18" y="22" font-size="11" fill="#1f2329" text-anchor="middle">文本</text></svg>',
  defaults: { w: 120, h: 32, text: '文本', fmt: '%s', fontSize: 14, textColor: '#1f2329', align: 'left', bold: false, bgColor: '' },
  props: [
    { key: 'text', label: '文本', type: 'text' },
    // 绑数组变量时整段显示（[1, 2, 3]）。要单独显示某个元素：把数组
    // 「展开成单个变量」（arrw[1]…arrw[N]）后绑那个元素变量 —— 不再有「数组元素」下标这一层。
    // 绑定变量时的显示格式：老工程没有 fmt 键 → fmtValue 原样输出（行为不变）
    { key: 'fmt', label: '格式', type: 'select', options: [
      { v: '%s', t: '%s 原样' }, { v: '%d', t: '%d 整数' },
      { v: '%.1f', t: '%.1f 一位小数' }, { v: '%.2f', t: '%.2f 两位小数' }, { v: '%.3f', t: '%.3f 三位小数' }] },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'align', label: '对齐', type: 'select', options: [{ v: 'left', t: '左' }, { v: 'center', t: '中' }, { v: 'right', t: '右' }] },
    { key: 'bold', label: '加粗', type: 'check' },
    { key: 'bgColor', label: '背景色', type: 'color', allowEmpty: true },
  ],
  binding: { variable: { types: [...SCALAR_NUM, 'bool', ...ARR_TYPES], label: '动态绑定(可选)' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props;
    const v = varValue(w, vars);
    const text = (v !== null && v !== undefined && v !== '') ? fmtValue(v, p.fmt) : p.text;
    // 注意：整行拼接，标签与文字之间不能有换行/缩进，
    // 否则 pre-wrap 会把它当真实内容渲染出空行
    const align = p.align === 'center' ? 'center' : p.align === 'right' ? 'flex-end' : 'flex-start';
    const bg = p.bgColor ? `background:${p.bgColor};border-radius:4px;` : '';
    return `<div class="w-label" style="font-size:${p.fontSize}px;color:${p.textColor};justify-content:${align};font-weight:${p.bold ? 700 : 400};${bg}">${escapeHtml(text)}</div>`;
  },
});
