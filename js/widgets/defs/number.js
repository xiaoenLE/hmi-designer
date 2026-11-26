/**
 * number.js — 数值 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 数值（显示/输入二合一，主力数据控件） */
import { register, rutil } from '../registry.js';
const { fmtValue, escapeHtml, varValue } = rutil;
import { textAlignOf, numberFmtOf, inputRangeOf, dispValueOf, fixedScaleOf } from '../../core/utils.js';
import { ARR_TYPES, SCALAR_NUM, TEXT_ALIGN } from '../shared.js';
import { tr } from '../../core/i18n.js';

/** 步进按钮的公共内联样式（不引 CSS：现场控件包导出时样式跟着走） */
function stepBtnStyle() {
  return 'flex:none;width:22px;height:22px;border:1px solid #c3cbd6;border-radius:4px;'
    + 'background:#eef2f7;color:#334155;font-size:14px;line-height:1;'
    + 'display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer';
}

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
    unit: '', fontSize: 16, align: 'left', textColor: '#1f2329', bgColor: '#ffffff', borderColor: '#c3cbd6', borderWidth: 1, radius: 5,
    // 输入范围限制（见 js/core/utils.js 的 inputRangeOf）：默认关，老工程/新控件行为都不变
    rangeOn: false,
    rangeMinMode: 'fixed', rangeMinValue: '', rangeMinVar: '',
    rangeMaxMode: 'fixed', rangeMaxValue: '', rangeMaxVar: '',
    // 步进按钮（−/+）：默认关 = 老行为一个字不变；开了之后点一下按 step 加减（受「范围限制」clamp）
    stepper: false, step: 1,
  },
  props: [
    { key: 'editable', label: '可输入', type: 'check', defVal: true },
    { key: 'stepper', label: '步进按钮', type: 'check', defVal: false },
    { key: 'step', label: '步长', type: 'number', defVal: 1 },
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
    { key: 'unit', label: '单位', type: 'text', i18n: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'align', label: '对齐', type: 'select', options: TEXT_ALIGN, defVal: 'left' },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color', allowEmpty: true },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 12 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
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
    // 有效格式：优先 dispType/decimals，旧工程回落 fmt。
    // 整数 + 小数位>0 是定点缩放（PLC 里 123、屏上 1.23），见 utils.js 的 dispValueOf
    const val = fmtValue(dispValueOf(v, p), numberFmtOf(p));
    // 绑的是数组变量 → 整段显示、不可输入（往里写一个标量会与节点类型对不上）。
    // 要编辑某个元素：数组展开成 arrw[1]…arrw[N] 后绑那个元素变量。
    const isWholeArray = Array.isArray(v);
    const editable = p.editable !== false && !isWholeArray;   // 默认可输入
    // 步进按钮：值两侧各一个 −/+（样式内联；不可输入/整段数组时禁用）
    const stepOn = p.stepper === true;
    const dis = editable ? '' : ' disabled';
    const minus = stepOn
      ? `<button type="button" class="wn-step" data-step="-1" tabindex="-1" title="减" style="${stepBtnStyle()}${editable ? '' : ';opacity:.4;cursor:default'}"${dis}>\u2212</button>`
      : '';
    const plus = stepOn
      ? `<button type="button" class="wn-step" data-step="1" tabindex="-1" title="加" style="${stepBtnStyle()}${editable ? '' : ';opacity:.4;cursor:default'}"${dis}>+</button>`
      : '';
    // 「透明 / 无边框」语义（全工程约定：颜色空串 = 透明，见属性面板的「透明」按钮）：
    // 背景空、边框色空、边框宽为 0 —— 任意一条成立就加 is-flat。
    // 为什么只加 class、不把 box-shadow 写进内联：内联能盖住 background / border，
    // 盖不住 CSS 类里 `.w-number` 的 box-shadow: inset …（就是透明后仍看得到的那条淡边/3D 感），
    // 那一条由 css/widgets.css 的 .w-number.is-flat 清掉。
    // ⚠ is-flat 只压内阴影，不压 border-color：「透明底 + 自选边框色」是合法配法。
    const off = (c) => !c || c === 'transparent';
    const flat = off(p.bgColor) || off(p.borderColor) || !(Number(p.borderWidth) > 0);
    // 不再显示 ✎ 图标：点击整个控件即可输入（软键盘或内联）
    return `<div class="w-number${editable ? ' editable' : ''}${flat ? ' is-flat' : ''}" style="background:${p.bgColor || 'transparent'};border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};border-radius:${p.radius}px">
      ${minus}
      <span class="wn-val" style="text-align:${textAlignOf(p.align)};font-size:${p.fontSize}px;color:${p.textColor}">${escapeHtml(val)}</span>
      ${p.unit ? `<span class="wn-unit">${escapeHtml(tr(p.unit))}</span>` : ''}
      ${plus}
    </div>`;
  },
  /**
   * 运行态步进：点 −/+ 按当前值 ±step，再按「范围限制」clamp，最后走 api.set（链路门/失败回读全在 varStore）。
   * ⚠ 用**捕获阶段**：runtime.js 给 number 控件挂的"点整块开软键盘"是 el 上的冒泡监听，
   *   捕获阶段先跑 + stopPropagation() → 点 ± 不会再弹软键盘。
   */
  attach(el, w, api) {
    const p = w.props || {};
    if (p.stepper !== true) return;
    el.addEventListener('click', (e) => {
      const t = e.target;
      const btn = t && t.closest ? t.closest('[data-step]') : null;
      if (!btn) return;                       // 点的不是 ±：交给 runtime 原来的整块点击
      e.preventDefault();
      e.stopPropagation();                    // 别再冒泡去开软键盘
      const name = w.bindings ? w.bindings.variable : '';
      if (!name) return;
      if (!api.allowed()) return;
      const dir = btn.getAttribute('data-step') === '-1' ? -1 : 1;
      const stepRaw = Number(p.step);
      const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 1;
      const raw = api.get(name);
      let cur = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
      if (!Number.isFinite(cur)) cur = 0;
      // 整数定点：加减在**显示单位**里做（屏上 1.23、步长 0.01），写回去再乘回 10^N。
      // 否则「屏上显示 1.23、点一下 +1 变成 124」这种就对不上了。
      const scale = fixedScaleOf(p);
      let next = (cur / scale + dir * step) * scale;
      // 范围限制：固定值 / 变量上限那一套跟软键盘共用 inputRangeOf，比较也在显示单位
      const r = inputRangeOf(p, (n) => api.get(n));
      if (r) {
        if (Number.isFinite(r.lo) && next < r.lo * scale) next = r.lo * scale;
        if (Number.isFinite(r.hi) && next > r.hi * scale) next = r.hi * scale;
      }
      if (scale > 1) {
        next = Math.round(next);              // 整数变量只认整数：0.01 的步长乘回来会有浮点尾巴
        // 小数位限制得比原始精度还细时，四舍五入可能又跨出范围：按显示范围再收一次
        if (r) {
          if (Number.isFinite(r.lo) && next < r.lo * scale) next = Math.ceil(r.lo * scale);
          if (Number.isFinite(r.hi) && next > r.hi * scale) next = Math.floor(r.hi * scale);
        }
      } else if (step % 1 !== 0 || cur % 1 !== 0) {
        next = Math.round(next * 1e6) / 1e6;  // 浮点尾巴（0.1 步长累加出 0.30000000000000004）
      }
      api.set(name, next);
    }, true);
  },
});
