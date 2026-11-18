/**
 * circle.js — 圆形 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
import { register } from '../registry.js';

register({
  type: 'circle',
  title: '圆形',
  sub: '装饰形状',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><circle cx="18" cy="18" r="11" fill="#fde68a" stroke="#d97706" stroke-width="2"/></svg>',
  defaults: { w: 80, h: 80, bgColor: '#fde68a', borderColor: '#d97706', borderWidth: 2 },
  props: [
    { key: 'bgColor', label: '填充色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 12 },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props;
    const bg = p.bgColor && p.bgColor !== 'transparent' ? p.bgColor : 'transparent';
    const bd = p.borderColor || 'transparent';
    return `<div class="w-circle" style="background:${bg};border:${p.borderWidth}px solid ${bd}"></div>`;
  },
});
