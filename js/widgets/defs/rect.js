/**
 * rect.js — 矩形 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
import { register } from '../registry.js';

register({
  type: 'rect',
  title: '矩形',
  sub: '面板/边框装饰',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="6" y="9" width="24" height="18" rx="2" fill="#e3edff" stroke="#2563eb"/></svg>',
  defaults: { w: 160, h: 100, bgColor: '#eef2f7', borderColor: '#c3cbd6', borderWidth: 1, radius: 6 },
  props: [
    { key: 'bgColor', label: '填充色', type: 'color', allowEmpty: true },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 12 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 60 },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props;
    // 空色值兜底：拼进 CSS 会产生非法声明被浏览器整条丢弃（透明语义 = transparent）
    const bg = p.bgColor && p.bgColor !== 'transparent' ? p.bgColor : 'transparent';
    const bd = p.borderColor || 'transparent';
    return `<div class="w-rect" style="background:${bg};border:${p.borderWidth}px solid ${bd};border-radius:${p.radius}px"></div>`;
  },
});
