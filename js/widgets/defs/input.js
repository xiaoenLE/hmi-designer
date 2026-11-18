/**
 * input.js — 数据输入 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 数据输入（已并入 number，隐藏保留兼容旧工程） */
import { register, rutil } from '../registry.js';
const { fmtValue, escapeHtml, varValue } = rutil;
import { numberFmtOf } from '../../core/utils.js';

register({
  type: 'input',
  title: '数据输入',
  hidden: true,
  sub: '运行时可编辑提交',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="10" width="28" height="16" rx="3" fill="#fdfdff" stroke="#94a3b8"/><text x="18" y="22" font-size="10" fill="#6b7280" text-anchor="middle">[输入]</text></svg>',
  defaults: { w: 140, h: 36, placeholder: '输入数值…', fmt: '%.1f', fontSize: 15, textColor: '#1f2329' },
  props: [
    { key: 'placeholder', label: '提示文字', type: 'text' },
    // 显示格式：float 时附小数位（0=无小数点）。旧工程只有 fmt 时按 fmt 显示
    { key: 'dispType', label: '数据类型', type: 'dtype' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props;
    const v = varValue(w, vars);
    // ⚠️ 读回来的值也要按小数位显示：REAL 12.345679 直接 String(v) 会把
    //    整条浮点尾巴（12.34567928314209）显示出来 —— 输入框里看着像坏了
    const shown = (v !== null && v !== undefined) ? String(fmtValue(v, numberFmtOf(p))) : '';
    return `<input class="w-input" type="text" ${mode === 'edit' ? 'disabled' : ''}
      value="${escapeHtml(shown)}" data-shown="${escapeHtml(shown)}" placeholder="${escapeHtml(p.placeholder)}"
      style="font-size:${p.fontSize}px;color:${p.textColor}" inputmode="decimal">`;
  },
});
