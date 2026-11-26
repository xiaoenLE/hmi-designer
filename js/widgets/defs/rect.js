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
    // 线型：默认实线（不写进 defaults，老工程没这个键也按实线画，像素不变）
    { key: 'lineStyle', label: '线型', type: 'select', defVal: 'solid', options: [
      { v: 'solid', t: '实线' }, { v: 'dashed', t: '虚线' }, { v: 'dotted', t: '点线' },
    ] },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props;
    // 空色值兜底：拼进 CSS 会产生非法声明被浏览器整条丢弃（透明语义 = transparent）
    const bg = p.bgColor && p.bgColor !== 'transparent' ? p.bgColor : 'transparent';
    const bd = p.borderColor || 'transparent';
    // 线型：只认 实线/虚线/点线；旧工程没这个键、手改坏了都回落实线
    const ls = ['dashed', 'dotted'].includes(p.lineStyle) ? p.lineStyle : 'solid';
    return `<div class="w-rect" style="background:${bg};border:${p.borderWidth}px ${ls} ${bd};border-radius:${p.radius}px"></div>`;
  },
});
