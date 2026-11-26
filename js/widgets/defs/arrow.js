/**
 * arrow.js — 箭头 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 流程图里指方向、标流向：
 *   · 上 / 下 / 左 / 右（dir，默认右）—— 没绑变量（或变量给 0/认不出）时用它
 *   · 大小（size，px）、粗细（thickness）、颜色（color）、实心 / 空心（outline）
 *   · 用**内联 SVG** 画（viewBox 100×100，按控件框的短边等比缩放并居中），不引第三方、不改公共 CSS
 *   · **方向可以由变量控制**（绑定可选，binding.variable）：
 *       数值 1=上 2=右 3=下 4=左（0/其它 = 按静态 dir）；
 *       字符串 up/上、right/右、down/下、left/左（大小写不敏感，'1'~'4' 也认）；
 *       其它字符串 = 按静态 dir。
 *     没绑变量 = 完全按静态 dir —— 老工程/老画面一个像素都不变。
 *     运行态不用 attach：绑了变量就自动进「变量→控件」索引，变量一变就重画（箭头跟着转）。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
const fmt2 = (n) => String(Math.round(n * 100) / 100);

/** 方向 → 旋转角（箭头本体按"朝右"画，其它方向整体转） */
const DIR_ANGLE = { right: 0, down: 90, left: 180, up: 270 };
/** 方向变量里认的字符串（统一 trim + 小写后查表；数字字符串 1~4 也认） */
const DIR_WORDS = {
  up: 'up', '上': 'up', right: 'right', '右': 'right',
  down: 'down', '下': 'down', left: 'left', '左': 'left',
  '1': 'up', '2': 'right', '3': 'down', '4': 'left',
};
/** 静态 dir → 合法方向（老工程缺键 / 手改坏了都回落 right） */
function staticDir(p) {
  return Object.prototype.hasOwnProperty.call(DIR_ANGLE, p.dir) ? p.dir : 'right';
}
/** 最终方向：绑了方向变量就以变量为准；没绑 / 0 / 认不出 = 静态 dir */
function dirOf(w, vars) {
  const p = w.props || {};
  const v = varValue(w, vars);
  if (v === null || v === undefined || v === '') return staticDir(p);
  if (typeof v === 'number') {
    if (v === 1) return 'up';
    if (v === 2) return 'right';
    if (v === 3) return 'down';
    if (v === 4) return 'left';
    return staticDir(p);
  }
  const s = String(v).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DIR_WORDS, s)) return DIR_WORDS[s];
  return staticDir(p);
}

register({
  type: 'arrow',                 // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '箭头',
  sub: '流程方向指示（四向 / 空心）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><path d="M5 18h20" stroke="#52606d" stroke-width="3" stroke-linecap="round"/><path d="M20 10l8 8-8 8z" fill="#52606d"/></svg>',
  defaults: {
    w: 120, h: 80,
    dir: 'right',                // up / down / left / right
    size: 60,                    // 箭头长度（px）
    color: '#52606d',
    outline: false,              // 空心（只描边不填充）
    thickness: 8,                // 粗细（px）
  },
  props: [
    { key: 'dir', label: '方向', type: 'select', defVal: 'right', options: [
      { v: 'up', t: '上' }, { v: 'down', t: '下' }, { v: 'left', t: '左' }, { v: 'right', t: '右' },
    ] },
    { key: 'size', label: '大小', type: 'number', min: 10, max: 200, defVal: 60 },
    { key: 'color', label: '颜色', type: 'color' },
    { key: 'outline', label: '空心', type: 'check', defVal: false, title: '不勾 = 实心箭头；勾上 = 只描边（线宽就是「粗细」）' },
    { key: 'thickness', label: '粗细', type: 'number', min: 1, max: 40, defVal: 8 },
    // 线型只在空心（描边）模式下有意义；实心箭头没有描边，改它不影响渲染
    { key: 'lineStyle', label: '线型', type: 'select', defVal: 'solid', title: '虚线/点线只在空心（描边）模式下生效', options: [
      { v: 'solid', t: '实线' }, { v: 'dashed', t: '虚线' }, { v: 'dotted', t: '点线' },
    ] },
  ],
  // 方向变量是**可选**的：不绑 = 完全按静态 dir（老工程老画面不变）。
  // 绑上之后运行态自动进「变量→控件」索引，变量一变就重画，不需要 attach。
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '方向变量（可选）' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const dir = dirOf(w, vars);                            // 变量优先，没绑/0/认不出 = 静态 dir
    const deg = DIR_ANGLE[dir];
    const boxW = Math.max(1, numOr(w.w, 120));
    const boxH = Math.max(1, numOr(w.h, 80));
    // viewBox 固定 100×100：短边 = S px。size / thickness 是 px，换算成 viewBox 单位
    const S = Math.max(10, Math.min(boxW, boxH));
    const sizePx = clamp(Math.round(numOr(p.size, 60)), 10, 200);
    const thickPx = clamp(numOr(p.thickness, 8), 1, 40);
    const L = clamp((sizePx / S) * 100, 10, 220);        // 箭头总长
    const T = clamp((thickPx / S) * 100, 2, 60);         // 粗细（viewBox 单位）
    const headW = L * 0.42;                              // 箭头尖那一段的长度
    const headH = Math.max(T * 2, L * 0.5);              // 箭头尖那一段的高度
    const shaftT = Math.min(T, headH * 0.7);             // 杆的粗细（别比箭头还宽）
    const left = 50 - L / 2;
    const right = 50 + L / 2;
    const hx = right - headW;                            // 箭头尖的根部
    const pts = [
      [left, 50 - shaftT / 2], [hx, 50 - shaftT / 2], [hx, 50 - headH / 2],
      [right, 50],
      [hx, 50 + headH / 2], [hx, 50 + shaftT / 2], [left, 50 + shaftT / 2],
    ].map(([x, y]) => `${fmt2(x)},${fmt2(y)}`).join(' ');
    const color = escapeHtml(p.color || '#52606d');
    const outline = p.outline === true;
    // 线型：只认 实线/虚线/点线；实心（不描边）没有线型可言，渲染结果照旧 —— 老工程像素不变
    const ls = ['dashed', 'dotted'].includes(p.lineStyle) ? p.lineStyle : 'solid';
    let dash = '';
    if (outline && ls === 'dashed') dash = ` stroke-dasharray="${fmt2(T * 3)} ${fmt2(T * 2)}"`;
    else if (outline && ls === 'dotted') dash = ` stroke-dasharray="${fmt2(T)} ${fmt2(T * 2)}"`;
    const shape = outline
      ? `<polygon class="wa-shape" points="${pts}" fill="none" stroke="${color}" stroke-width="${fmt2(T)}"${dash} stroke-linejoin="round" stroke-linecap="round"/>`
      : `<polygon class="wa-shape" points="${pts}" fill="${color}" stroke="none"/>`;
    return `<div class="w-arrow" data-dir="${dir}" data-size="${sizePx}" data-outline="${outline ? 1 : 0}" data-thickness="${fmt2(thickPx)}"
      style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;overflow:hidden">
      <svg class="wa-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
        <g transform="rotate(${deg} 50 50)">${shape}</g>
      </svg>
    </div>`;
  },
});
