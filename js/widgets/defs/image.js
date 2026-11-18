/**
 * image.js — 图片 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;

register({
  type: 'image',
  title: '图片',
  sub: '设备图/图标占位',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="7" width="26" height="22" rx="3" fill="#f7f8fa" stroke="#c3cbd6"/><circle cx="13" cy="14" r="3" fill="#d97706"/><path d="M7 26l7-8 5 5 4-4 6 7z" fill="#94a3b8"/></svg>',
  defaults: { w: 140, h: 100, src: '' },
  props: [
    { key: 'src', label: '图片', type: 'image' },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props;
    if (p.src) return `<div class="w-image"><img src="${escapeHtml(p.src)}" alt=""></div>`;
    return `<div class="w-image">
      <svg viewBox="0 0 24 24" width="26" height="26"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="#b6bec9" stroke-width="1.6"/><circle cx="9" cy="10" r="2" fill="#d97706"/><path d="M5 18l5-6 4 4 3-3 4 5z" fill="#c3cbd6"/></svg>
      <span>图片占位</span></div>`;
  },
});
