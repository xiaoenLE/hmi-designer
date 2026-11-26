/**
 * line.js — 直线 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 画面上的分割线、表格框线、边框线都用它：
 *   · 方向：水平 / 垂直 / 斜线 ↘ / 斜线 ↗ —— 拖控件两端就能改长度（宽=横长，高=竖长）
 *   · 线宽（px）、颜色、线型（实线 / 虚线 / 点线）
 *   · 和箭头一样用**内联 SVG** 画：viewBox 就是控件自己的像素尺寸，
 *     所以线宽是真正的 px（拖多大都不会被拉伸糊掉），也不引第三方、不改公共 CSS。
 *   · 不绑变量、没有动作：它就是根线。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;

const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt2 = (n) => String(Math.round(n * 100) / 100);

register({
  type: 'line',                  // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '直线',
  sub: '分割线 / 边框线（实线、虚线、点线）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><path d="M6 26h24" stroke="#52606d" stroke-width="3" stroke-linecap="round"/><path d="M6 17h24" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-dasharray="4 4"/></svg>',
  defaults: {
    w: 220, h: 8,
    dir: 'h',                    // h 水平 / v 垂直 / d1 左上→右下 / d2 左下→右上
    color: '#52606d',
    thickness: 2,
    lineStyle: 'solid',
  },
  props: [
    { key: 'dir', label: '方向', type: 'select', defVal: 'h', options: [
      { v: 'h', t: '水平' }, { v: 'v', t: '垂直' }, { v: 'd1', t: '斜线 ↘' }, { v: 'd2', t: '斜线 ↗' },
    ] },
    { key: 'color', label: '颜色', type: 'color' },
    { key: 'thickness', label: '线宽', type: 'number', min: 1, max: 40, defVal: 2 },
    { key: 'lineStyle', label: '线型', type: 'select', defVal: 'solid', options: [
      { v: 'solid', t: '实线' }, { v: 'dashed', t: '虚线' }, { v: 'dotted', t: '点线' },
    ] },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props || {};
    const W = Math.max(1, Math.round(numOr(w.w, 220)));
    const H = Math.max(1, Math.round(numOr(w.h, 8)));
    const T = clamp(numOr(p.thickness, 2), 1, 40);
    const half = T / 2;                       // 线本身有宽度：两端各让半个线宽，别被视口切掉
    const dir = ['v', 'd1', 'd2'].includes(p.dir) ? p.dir : 'h';
    let x1, y1, x2, y2;
    if (dir === 'v') { x1 = x2 = W / 2; y1 = half; y2 = Math.max(half, H - half); }
    else if (dir === 'd1') { x1 = half; y1 = half; x2 = Math.max(half, W - half); y2 = Math.max(half, H - half); }
    else if (dir === 'd2') { x1 = Math.max(half, W - half); y1 = half; x2 = half; y2 = Math.max(half, H - half); }
    else { y1 = y2 = H / 2; x1 = half; x2 = Math.max(half, W - half); }

    const color = escapeHtml(p.color || '#52606d');
    const ls = ['dashed', 'dotted'].includes(p.lineStyle) ? p.lineStyle : 'solid';
    let dash = '';
    if (ls === 'dashed') dash = ` stroke-dasharray="${fmt2(T * 3)} ${fmt2(T * 2)}"`;
    else if (ls === 'dotted') dash = ` stroke-dasharray="${fmt2(T)} ${fmt2(T * 2)}"`;

    return `<div class="w-line" data-dir="${dir}" data-line-style="${ls}" data-thickness="${fmt2(T)}">
      <svg class="wl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%;display:block">
        <line x1="${fmt2(x1)}" y1="${fmt2(y1)}" x2="${fmt2(x2)}" y2="${fmt2(y2)}"
          stroke="${color}" stroke-width="${fmt2(T)}"${dash} stroke-linecap="round"/>
      </svg>
    </div>`;
  },
});
