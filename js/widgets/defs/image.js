/**
 * image.js — 图片 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * ⚠ 图片进来时就已经是「数据」了（data URL 内嵌进工程），所以：
 *   · **有图时不能再有底色/虚线框** —— 透明底的 PNG 放在浅灰底上会多出一块方框，
 *     现场的图多半是去底的设备图，必须让它跟画面底一个颜色（默认就是 transparent）。
 *   · 需要底色就自己设「背景色」；不设 = 透明（全工程的约定：空 = 透明）。
 *   · 占位（还没选图）那套虚线框 + 浅灰底只留给"没图"的状态，一眼能看出这是个图片控件。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { tr } from '../../core/i18n.js';

register({
  type: 'image',
  title: '图片',
  sub: '设备图/图标占位',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="7" width="26" height="22" rx="3" fill="#f7f8fa" stroke="#c3cbd6"/><circle cx="13" cy="14" r="3" fill="#d97706"/><path d="M7 26l7-8 5 5 4-4 6 7z" fill="#94a3b8"/></svg>',
  defaults: { w: 140, h: 100, src: '', bgColor: '' },
  props: [
    { key: 'src', label: '图片', type: 'image' },
    // 有图时才有意义：空 = 透明（透明的 PNG 就完全跟画面底走）
    { key: 'bgColor', label: '背景色', type: 'color', title: '留空或点「透明」= 不画底色（透明 PNG 看不出方框）' },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props || {};
    const src = p.src || '';
    if (src) {
      // 老工程没有 bgColor 这个键 → 同样按透明走（以前 CSS 给的是浅灰底，透明图会露方框）
      const bg = p.bgColor == null ? 'transparent' : (p.bgColor || 'transparent');
      return `<div class="w-image has-img" style="background:${escapeHtml(bg)}"><img src="${escapeHtml(src)}" alt=""></div>`;
    }
    return `<div class="w-image">
      <svg viewBox="0 0 24 24" width="26" height="26"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="#b6bec9" stroke-width="1.6"/><circle cx="9" cy="10" r="2" fill="#d97706"/><path d="M5 18l5-6 4 4 3-3 4 5z" fill="#c3cbd6"/></svg>
      <span>${escapeHtml(tr('图片占位'))}</span></div>`;
  },
});
