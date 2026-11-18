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
  defaults: {
    w: 150, h: 38, fmt: '%.1f', dispType: 'float', decimals: 1, editable: true, useKeyboard: true,
    // 键盘弹出时挡住画面上的其他控件：默认挡住。老工程没这个键 → 运行时按"挡住"走
    //（`!== false` 那套兜底），新控件把 true 显式存下来，面板上勾选态与运行时永远一致
    padBlockOthers: true,
    unit: '', fontSize: 16, textColor: '#1f2329', bgColor: '#ffffff', borderColor: '#c3cbd6', borderWidth: 1, radius: 5,
    // 输入范围限制（见 js/core/utils.js 的 inputRangeOf）：默认关，老工程/新控件行为都不变
    rangeOn: false,
    rangeMinMode: 'fixed', rangeMinValue: '', rangeMinVar: '',
    rangeMaxMode: 'fixed', rangeMaxValue: '', rangeMaxVar: '',
  },
  props: [
    { key: 'editable', label: '可输入', type: 'check', defVal: true },
    { key: 'useKeyboard', label: '软键盘输入', type: 'check', defVal: true },
    // 键盘弹出时挡住画面上的其他控件（默认挡住，防误碰：输设定值时手滑按到"启动"是大事）。
    // 取消勾选 = 老行为：还能点别处（点另一个输入控件就把键盘换过去）。
    // 说明写在 title 里（悬停才看得见）—— 面板上不摊解释文字
    { key: 'padBlockOthers', label: '屏蔽其他控件', type: 'check', defVal: true,
      title: '软键盘弹出时挡住画面上的其他控件（防误碰）：键盘开着时点别处没反应，只有键盘能用。\n取消勾选 = 老行为：还能点别处（点另一个输入控件就把键盘换过去）' },
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
    /* ── 输入范围限制（单独一栏，可折叠）──
       只对数值输入有意义：上限/下限**各自**可以写死一个数，也可以跟着一个变量走
       （现场最常见的配法：配方上下限由 PLC 下发，操作工只能在框内改）。
       运行时越界 = 软键盘上的输入框变红 + 确定按钮禁用 + **一个字节都不下发**
       （见 js/runtime/runtime.js 的 padRange / commitNumPad）。
       两端都留空 = 等于没配（不启用），所以老工程一个字都不变。 */
    { key: 'rangeOn', label: '范围限制', type: 'check', defVal: false, group: '输入范围' },
    { key: 'rangeMinValue', label: '下限', type: 'varOrValue', group: '输入范围', showIf: 'rangeOn',
      modeKey: 'rangeMinMode', varKey: 'rangeMinVar' },
    { key: 'rangeMaxValue', label: '上限', type: 'varOrValue', group: '输入范围', showIf: 'rangeOn',
      modeKey: 'rangeMaxMode', varKey: 'rangeMaxVar' },
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
