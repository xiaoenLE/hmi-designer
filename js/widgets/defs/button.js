/**
 * button.js — 按钮 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml, stateVarOf } = rutil;
import { compareVal } from '../../core/utils.js';

register({
  type: 'button',
  title: '按钮',
  sub: '点动/切换/状态显示',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="10" width="26" height="16" rx="4" fill="#2563eb"/><text x="18" y="22" font-size="10" fill="#fff" text-anchor="middle">启停</text></svg>',
  defaults: { w: 110, h: 46, text: '按钮', fontSize: 15, textColor: '#ffffff', bgColor: '#2563eb', borderColor: '', radius: 7, borderWidth: 1,
    holdMs: 0,   // 延迟触发（长按）毫秒数，0 = 点一下立即触发（老工程缺键按 0，行为不变）
    showState: true, onText: '开', offText: '关', op: '>=', threshold: '1', onColor: '#22c55e', offColor: '#9ca3af' },
  defaultBind: true,   // 新建时默认绑定变量表第一个变量（状态显示与操作变量同源）
  // 新建时**默认勾上**「变量与显示的变量一致」（面板上那一栏）：动作里的变量（按钮写出去的）
  // 跟状态显示变量（读回来的）同源 —— 现场九成的按钮就是"看一个状态、点它改同一个变量"，
  // 默认勾上省一次点击，也不会出现"显示绑 a、动作写 b"这种自己看不出来的错配。
  // ⚠ 只作用于**新建**的按钮：老工程里没这个键的控件照旧当没勾（行为一个字不变）。
  defaultFollow: true,
  props: [
    { key: 'text', label: '文本', type: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 40 },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    // 延迟触发（长按）：按住够久才执行动作 —— 启停、清记录这类怕误碰的操作要求「按住 1 秒」。
    // 点动(tap) 同样受这道闸管：按住够久才置 TRUE，中途松手一个字节都不下发，松开立即置 FALSE。
    // ⚠ 这行的说明文字**不在属性面板里显示**（用户要求）：README「按钮延迟触发」那节和
    //   下面这段注释里都有，面板上就不要再摊一大段解释了。
    { key: 'holdMs', label: '延迟触发(ms)', type: 'number', min: 0, max: 60000, defVal: 0 },
    // 状态显示：绑定变量后生效。bool 直接开/关；数值/字符串按比较条件决定开/关（文字+底色双态切换）
    // showVarType='notBool'：绑定变量为数值/字符串时才显示比较行（bool 直接开/关，无需比较）
    // ⚠ 这几行都带 `group:'状态显示'` → 属性面板里**单独成一栏**（可折叠，现场要求：
    //   按钮属性一大串，状态显示相关的收起来看别的更清爽）
    { key: 'showState', label: '状态显示', type: 'check', defVal: true, group: '状态显示' },
    { key: 'onText', label: '满足文字', type: 'text', group: '状态显示' },
    { key: 'offText', label: '未满文字', type: 'text', group: '状态显示' },
    { key: 'op', label: '比较', type: 'select', showVarType: 'notBool', group: '状态显示', options: [
      { v: '==', t: '== 等于' }, { v: '!=', t: '!= 不等' },
      { v: '>', t: '> 大于' }, { v: '<', t: '< 小于' },
      { v: '>=', t: '>= 不小于' }, { v: '<=', t: '<= 不大于' }] },
    { key: 'threshold', label: '比较值', type: 'text', showVarType: 'notBool', group: '状态显示' },
    { key: 'onColor', label: '满足底色', type: 'color', group: '状态显示' },
    { key: 'offColor', label: '未满底色', type: 'color', group: '状态显示' },
  ],
  binding: { variable: { types: ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '状态显示(可选)' } },
  actions: ['tap', 'toggle', 'gotoPage', 'showPopup', 'hidePopup', 'back', 'setValue', 'clearAlarm', 'exitPerm'],
  render(w, mode, vars) {
    const p = w.props;
    const bw = p.borderWidth ?? 1;
    let text = p.text;
    let bg = p.bgColor;
    // 状态显示：老工程控件缺 showState 键视为启用（与新默认 true 同源）；显式 false 仍关闭
    if (p.showState ?? true) {
      // 状态显示变量：优先显式绑定，没绑但动作里有变量就用它（点动按钮的常见配法）
      const sv = stateVarOf(w);
      const v = sv ? (vars?.get ? vars.get(sv) : undefined) : null;
      if (v !== null && v !== undefined) {
        // op/threshold 缺键兜底（老工程），与新默认一致
        const active = compareVal(v, p.op ?? '>=', p.threshold ?? '1');
        text = active ? (p.onText || '开') : (p.offText || '关');
        bg = active ? p.onColor : p.offColor;
      }
    }
    // 背景色有效性：空串/transparent = 真透明。此前直接拼进 linear-gradient
    // 产生非法 CSS（如 "transparentdd"），整条 background 声明被浏览器丢弃，
    // 回落 .w-btn 的蓝色渐变默认样式 → 「选透明变蓝色」bug
    // ⚠️ bgOn/bgStyle/bd 必须在状态覆盖 bg【之后】计算，否则状态色不生效（第 16 轮回归教训）
    const bgOn = !!bg && bg !== 'transparent';
    const bgStyle = bgOn ? `background:linear-gradient(180deg,${bg}dd,${bg})` : 'background:none';
    // 边框色：显式设置优先；未设置时跟随背景色（背景透明则边框也透明 = 纯文字按钮）
    const bd = p.borderColor || (bgOn ? bg : 'transparent');
    return `<button class="w-btn" type="button" tabindex="-1" style="font-size:${p.fontSize}px;color:${p.textColor};${bgStyle};border:${bw}px solid ${bd};border-radius:${p.radius}px">${escapeHtml(text)}</button>`;
  },
});
