/**
 * bar.js — 棒图（进度条）控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 这个控件是"手把手新建控件"的样板，它把要用的东西都占全了：
 *   · 三种属性面板控件：number（最小/最大/阈值）、check（显示数值）、color（三个颜色）、text（单位）
 *   · 绑定一个数值变量，按 min~max 折成 0~100%
 *   · 超过阈值就换色（现场最常见的"超限变红"）
 *   · 老工程缺键一律 `?? 默认值` 兜底（这套代码的固定风格）
 */
import { register, rutil } from '../registry.js';
const { escapeHtml, varValue } = rutil;
import { tr } from '../../core/i18n.js';

register({
  type: 'bar',                    // ⚠ 永久 id：存进工程 JSON、CSS 类名 wd-bar 都靠它，定了别再改
  title: '棒图',
  sub: '按变量比例填充（可超限变色）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="12" width="28" height="12" rx="3" fill="#e5e7eb"/><rect x="4" y="12" width="16" height="12" rx="3" fill="#22c55e"/></svg>',
  // w/h 是几何（进控件自己的 w/h 字段，**不进 props**）；其余键都会作为新建时的 props 初值
  defaults: {
    w: 200, h: 28,
    min: 0, max: 100, decimals: 0, unit: '',
    showText: true, vertical: false,
    warnAt: 0,                    // 0 = 不启用超限变色；>0 时按"占满的百分比"算阈值
    barColor: '#22c55e', warnColor: '#ef4444',
    bgColor: '#e5e7eb', textColor: '#1f2329',
    radius: 6, borderColor: '', borderWidth: 0,
  },
  // 属性面板的 schema：面板上**一行一条**，顺序就是这个数组的顺序
  props: [
    { key: 'min', label: '最小', type: 'number' },
    { key: 'max', label: '最大', type: 'number' },
    { key: 'decimals', label: '小数位', type: 'number', min: 0, max: 6, defVal: 0 },
    { key: 'unit', label: '单位', type: 'text', i18n: 'text' },
    { key: 'showText', label: '显示数值', type: 'check', defVal: true },
    { key: 'vertical', label: '竖着画', type: 'check', defVal: false },
    { key: 'warnAt', label: '超限阈值%', type: 'number', min: 0, max: 100, defVal: 0 },
    { key: 'barColor', label: '填充色', type: 'color' },
    { key: 'warnColor', label: '超限色', type: 'color' },
    { key: 'bgColor', label: '底色', type: 'color' },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 24 },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
  ],
  // 能绑哪些变量：棒图要的是"数值"，bool 和字符串没意义所以不列
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: '绑定变量' } },
  actions: [],                    // 纯显示控件 → 空数组，属性面板就不会出现「动作」那一栏
  /**
   * 返回 body 的 innerHTML。编辑态和运行态共用这一个函数 —— 所以它俩长得一模一样（所见即所得）。
   * @param {object} w 控件数据（w.props 是属性面板里的值）
   * @param {'edit'|'run'} mode 组态 / 运行
   * @param {Map} vars 变量运行值（编辑态是一份预览值）
   */
  render(w, mode, vars) {
    const p = w.props;
    const v = varValue(w, vars);                       // 没绑变量 / 没值 → null
    const num = (v === null || v === undefined || v === '') ? null : Number(v);
    const min = Number.isFinite(+p.min) ? +p.min : 0;
    const max = Number.isFinite(+p.max) ? +p.max : 100;
    const span = (max - min) || 1;                     // 防 0：min == max 时别除出 Infinity
    // 占满的百分比：夹在 0~100（变量超范围时棒子画到边就停，不会画出框）
    const pct = num === null ? 0 : Math.max(0, Math.min(100, ((num - min) / span) * 100));
    const warnAt = Math.max(0, Math.min(100, +p.warnAt || 0));
    const over = warnAt > 0 && pct >= warnAt;          // 超限 → 换色
    const fill = over ? (p.warnColor || '#ef4444') : (p.barColor || '#22c55e');
    // 小数位：0 = 不显示小数点；老工程缺 decimals 键按 0（fmtValue 那套是给 fmt 字符串用的，这里自己算）
    const dec = Math.max(0, Math.min(6, +p.decimals || 0));
    const text = num === null ? (mode === 'edit' ? tr('未绑定变量') : '--') : `${num.toFixed(dec)}${tr(p.unit || '')}`;
    const vertical = p.vertical === true;
    const bd = (+p.borderWidth > 0)
      ? `border:${+p.borderWidth}px solid ${p.borderColor || 'transparent'};` : '';
    const bg = p.bgColor && p.bgColor !== 'transparent' ? p.bgColor : 'transparent';
    const label = p.showText === false ? '' : `<span class="w-bar-txt" style="color:${p.textColor || '#1f2329'}">${escapeHtml(text)}</span>`;
    // 竖着画就是把"宽度百分比"换成"高度百分比"，并且从**底边**往上长（bottom:0）
    const fillStyle = vertical
      ? `left:0;bottom:0;width:100%;height:${pct.toFixed(1)}%`
      : `left:0;top:0;height:100%;width:${pct.toFixed(1)}%`;
    return `<div class="w-bar${over ? ' over' : ''}${vertical ? ' vert' : ''}"
      style="background:${bg};border-radius:${+p.radius || 0}px;${bd}">
      <i class="w-bar-fill" style="${fillStyle};background:${fill};border-radius:${+p.radius || 0}px"></i>
      ${label}
    </div>`;
  },
});
