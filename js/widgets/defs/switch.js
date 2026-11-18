/**
 * switch.js — 拨动开关 控件定义（运行态可点）
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 绑 BOOL 变量：运行态点一下 = 取反写回（api.set 走 varStore 的统一链路：链路门 / 写后保护 /
 * 失败回读都在里面，这里不自己判断"设备连没连上"）。画面状态**只由变量值决定** —— 点完立刻
 * api.refresh() 按真值重画，所以被链路门挡下时开关不会"假装合上了"。
 * 事件绑在控件根 el 上（refreshWidgetBody 只换里面的 .wd-body，绑子元素会被一起换掉）。
 */
import { register, rutil } from '../registry.js';
import { tr } from '../../core/i18n.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
/** 变量值算不算"开"（bool true / 1 / 'true' / '1' 都认，和指示灯一个口径） */
const isOn = (v) => v === true || v === 1 || v === 'true' || v === '1';

register({
  type: 'switch',                // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '拨动开关',
  sub: '点一下切换 BOOL（运行态可操作）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="7" y="11" width="22" height="14" rx="7" fill="#22c55e"/><circle cx="22" cy="18" r="5" fill="#fff"/></svg>',
  defaults: {
    w: 96, h: 44,
    onText: '开', offText: '关', showText: true,
    onColor: '#22c55e', offColor: '#9ca3af', knobColor: '#ffffff',
    textColor: '#ffffff', fontSize: 14, radius: 22,
  },
  props: [
    // 开/关文字是"给人看的文字" → 声明 i18n，render 里用 tr() 包
    { key: 'onText', label: '开时文字', type: 'text', i18n: 'text' },
    { key: 'offText', label: '关时文字', type: 'text', i18n: 'text' },
    { key: 'showText', label: '显示文字', type: 'check', defVal: true },
    { key: 'onColor', label: '开时底色', type: 'color' },
    { key: 'offColor', label: '关时底色', type: 'color' },
    { key: 'knobColor', label: '手柄色', type: 'color' },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 48 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 200 },
  ],
  binding: { variable: { types: ['bool'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const v = varValue(w, vars);
    const on = isOn(v);
    const boxW = Math.max(1, numOr(w.w, 96));
    const boxH = Math.max(1, numOr(w.h, 44));
    const fs = clamp(Math.round(numOr(p.fontSize, 14)), 8, 48);
    // 半径给的是"轨道圆角"：默认 22（胶囊），超过控件一半高度也没关系（浏览器自己收敛）
    const radius = clamp(Math.round(numOr(p.radius, 22)), 0, 200);
    const pad = 3;
    const knobW = Math.max(14, boxH - pad * 2);
    // 文字放在手柄的**另一边**（关=手柄在左、文字靠右；开=手柄在右、文字靠左），不会压在手柄下面
    const textPad = on
      ? `padding-left:${Math.round(fs * 0.9)}px;padding-right:${knobW + 6}px;justify-content:flex-start;`
      : `padding-left:${knobW + 6}px;padding-right:${Math.round(fs * 0.9)}px;justify-content:flex-end;`;
    const text = on ? tr(p.onText || '') : tr(p.offText || '');
    const txtEl = p.showText === false ? ''
      : `<span class="wsw-text" style="position:absolute;inset:0;display:flex;align-items:center;box-sizing:border-box;${textPad}font-size:${fs}px;color:${p.textColor || '#ffffff'};font-weight:600;white-space:nowrap;overflow:hidden;pointer-events:none">${escapeHtml(text)}</span>`;
    const knobEl = `<div class="wsw-knob" style="position:absolute;top:${pad}px;${on ? 'right' : 'left'}:${pad}px;width:${knobW}px;height:${knobW}px;border-radius:50%;background:${p.knobColor || '#ffffff'};box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s,right .15s"></div>`;
    return `<div class="w-switch" data-on="${on ? 1 : 0}"
      style="position:relative;width:100%;height:100%;box-sizing:border-box;cursor:pointer;user-select:none;overflow:hidden;
      background:${on ? (p.onColor || '#22c55e') : (p.offColor || '#9ca3af')};border-radius:${radius}px;transition:background .15s">
      ${knobEl}${txtEl}
    </div>`;
  },
  /** 运行态交互：点一下取反写回；绑的是 BOOL 变量（没绑 = 只是装饰，点了不做事） */
  attach(el, w, api) {
    const varName = () => (w.bindings ? (w.bindings.variable || '') : '');
    el.addEventListener('click', () => {
      const name = varName();
      if (!name) return;
      if (!api.allowed()) return;                     // 权限 / 按条件启用：先过闸
      // **先读设备再写反值**（api.toggle）—— 拿界面缓存取反，在"刚写完还没回读确认"或
      // "设备上的值已经被 PLC 改过"时会写反（看着就是拨了没反应）。旧运行时没这个入口就退回老写法。
      if (typeof api.toggle === 'function') api.toggle(name);
      else api.set(name, !isOn(api.get(name)));
      // 按 varStore 里的真值重画：写成功 / 被链路门挡下，画面都不会留"假开关"
      api.refresh();
    });
  },
});
