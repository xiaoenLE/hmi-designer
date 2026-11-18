/**
 * lamp.js — 指示灯 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml, varValue } = rutil;

register({
  type: 'lamp',
  title: '指示灯',
  sub: '绑定 BOOL 变量',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><circle cx="18" cy="18" r="11" fill="#22c55e" stroke="#52606d" stroke-width="2"/><ellipse cx="14" cy="14" rx="4" ry="2.5" fill="rgba(255,255,255,.5)"/></svg>',
  defaults: { w: 50, h: 50, onColor: '#22c55e', offColor: '#9ca3af', offText: '', onText: '', textPos: 'inside', fontSize: 14, textColor: '#1f2329' },
  props: [
    // 双状态文字：灯有两个状态，文字随亮/灭切换；defFrom=老工程 text 键的回落显示
    { key: 'offText', label: '灭时文字', type: 'text', defFrom: 'text' },
    { key: 'onText', label: '亮时文字', type: 'text', defFrom: 'text' },
    { key: 'textPos', label: '文字位置', type: 'select', options: [{ v: 'right', t: '右侧' }, { v: 'left', t: '左侧' }, { v: 'bottom', t: '下方' }, { v: 'inside', t: '里面' }] },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'onColor', label: '点亮色', type: 'color' },
    { key: 'offColor', label: '熄灭色', type: 'color' },
  ],
  binding: { variable: { types: ['bool'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props;
    const v = varValue(w, vars);
    const on = v === true || v === 1 || v === 'true';
    const color = on ? p.onColor : p.offColor;
    const glow = on ? `box-shadow:0 0 12px ${p.onColor}88;` : '';
    const lamp = `<div class="w-lamp" style="background:${color};${glow}"></div>`;
    // 双状态文字：亮显示 onText、灭显示 offText；老工程无新键时回落旧 text（两态同文=旧版行为）
    // 该状态文字为空则该状态不显示 span，但只要任一状态有文字就保持 wrap 结构（状态切换不跳版式）
    const onT = (p.onText ?? p.text ?? '').trim();
    const offT = (p.offText ?? p.text ?? '').trim();
    if (!onT && !offT) return lamp;   // 两态均无文字 = 纯灯
    const txt = on ? onT : offT;
    const t = txt ? `<span class="lamp-text" style="font-size:${p.fontSize}px;color:${p.textColor}">${escapeHtml(txt)}</span>` : '';
    // 文字位置：右侧(默认)/左侧/下方/里面(叠加在灯体中央)
    const cls = p.textPos === 'bottom' ? ' lamp-v'
      : p.textPos === 'left' ? ' lamp-l'
      : p.textPos === 'inside' ? ' lamp-in' : '';
    return `<div class="lamp-wrap${cls}">${lamp}${t}</div>`;
  },
});
