/**
 * input.js — 数据输入 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 数据输入（已并入 number，隐藏保留兼容旧工程） */
import { TEXT_ALIGN } from '../shared.js';
import { register, rutil } from '../registry.js';
const { fmtValue, escapeHtml, varValue } = rutil;
import { textAlignOf, numberFmtOf, dispValueOf } from '../../core/utils.js';
import { tr } from '../../core/i18n.js';

register({
  type: 'input',
  title: '数据输入',
  hidden: true,
  sub: '运行时可编辑提交',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="10" width="28" height="16" rx="3" fill="#fdfdff" stroke="#94a3b8"/><text x="18" y="22" font-size="10" fill="#6b7280" text-anchor="middle">[输入]</text></svg>',
  defaults: {
    w: 140, h: 36, placeholder: '输入数值…', fmt: '%.1f', fontSize: 15, align: 'left', textColor: '#1f2329',
    // 背景/边框色：和「数值」「数值显示」同一套透明语义（空串 = 透明）。
    // 老工程没有这两个键 → render 里不写内联色，外观仍由 css/widgets.css 的 .w-input 默认规则给，
    // 一个字都不变；只有明确设过（含点「透明」清成空串）才走内联。
    bgColor: '#fdfdff', borderColor: '#c3cbd6',
    // 输入范围限制：和「数值」控件同一套键、同一套行为（见 js/core/utils.js 的 inputRangeOf）
    rangeOn: false,
    rangeMinMode: 'fixed', rangeMinValue: '', rangeMinVar: '',
    rangeMaxMode: 'fixed', rangeMaxValue: '', rangeMaxVar: '',
  },
  props: [
    { key: 'placeholder', label: '提示文字', type: 'text', i18n: 'text' },
    // 显示格式：float 时附小数位（0=无小数点）。旧工程只有 fmt 时按 fmt 显示
    { key: 'dispType', label: '数据类型', type: 'dtype' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'align', label: '对齐', type: 'select', options: TEXT_ALIGN, defVal: 'left' },
    { key: 'textColor', label: '文字色', type: 'color' },
    // 背景/边框色：清成空串（属性面板「透明」按钮）= 全透明，无底无边无内阴影
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    /* 输入范围限制：与「数值」控件同一套（上限/下限各自可以是固定值或变量）。
       越界时这个输入框自己变红、值不写进变量（见 runtime.js 的 commitInput）。 */
    { key: 'rangeOn', label: '范围限制', type: 'check', defVal: false, group: '输入范围' },
    { key: 'rangeMinValue', label: '下限', type: 'varOrValue', group: '输入范围', showIf: 'rangeOn',
      modeKey: 'rangeMinMode', varKey: 'rangeMinVar' },
    { key: 'rangeMaxValue', label: '上限', type: 'varOrValue', group: '输入范围', showIf: 'rangeOn',
      modeKey: 'rangeMaxMode', varKey: 'rangeMaxVar' },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props;
    const v = varValue(w, vars);
    // ⚠️ 读回来的值也要按小数位显示：REAL 12.345679 直接 String(v) 会把
    //    整条浮点尾巴（12.34567928314209）显示出来 —— 输入框里看着像坏了
    const shown = (v !== null && v !== undefined) ? String(fmtValue(dispValueOf(v, p), numberFmtOf(p))) : '';
    // 透明语义（全工程约定：空串 = 透明）：只有键存在时才写内联色 —— 老工程没有这些键，
    // 保持 css/widgets.css 的 .w-input 默认外观；新控件 defaults 带初值，等价于原样。
    const off = (c) => c === '' || c === 'transparent';
    const flat = off(p.bgColor) || off(p.borderColor);
    const bgCss = p.bgColor == null ? '' : `background:${p.bgColor || 'transparent'};`;
    const bdCss = p.borderColor == null ? '' : `border-color:${p.borderColor || 'transparent'};`;
    return `<input class="w-input${flat ? ' is-flat' : ''}" type="text" ${mode === 'edit' ? 'disabled' : ''}
      value="${escapeHtml(shown)}" data-shown="${escapeHtml(shown)}" placeholder="${escapeHtml(tr(p.placeholder))}"
      style="text-align:${textAlignOf(p.align)};font-size:${p.fontSize}px;color:${p.textColor};${bgCss}${bdCss}" inputmode="decimal">`;
  },
});
