/**
 * multiPosition.js — 多档位选择器 控件定义（运行态可点）
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 绑数值/字符串变量：items 一行一档，格式 `显示文字=值=状态色`（和下拉框的「选项」同一套写法，
 * 复用 core/utils.js 的 parseOptions —— 不写值就是"显示文字当值"，写颜色就按那个颜色高亮当前档）。
 * 运行态点某一档 → api.set() 写这一档的值；画面高亮**只由变量值决定**（点完 api.refresh() 按真值重画，
 * 链路门挡下时不会假装切过去了）。
 */
import { register, rutil } from '../registry.js';
import { parseOptions, optionIndexByValue } from '../../core/utils.js';
import { tr, trOptions } from '../../core/i18n.js';
import { project } from '../../core/project.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
/** 数值变量：写数字；字符串变量：写字符串（没写值时字符串变量照旧用显示文字） */
const NUM_TYPES = ['int', 'uint', 'dint', 'udint', 'real', 'lreal'];

/** 绑定变量在变量表里的类型（拿不到就当字符串处理，绝不因此抛异常把整个画面打断） */
function boundVarType(w) {
  const name = w.bindings ? (w.bindings.variable || '') : '';
  if (!name) return '';
  try {
    const list = project.variables();
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].name === name) return String(list[i].type || '');
    }
  } catch (e) { /* 变量表还没就绪：按字符串走 */ }
  return '';
}

/** 这一档该往变量里写什么：数值变量写数字（没写值 → 档位序号，0 起）；字符串变量写字符串 */
function valueOfOption(w, o, idx) {
  if (NUM_TYPES.indexOf(boundVarType(w)) >= 0) {
    if (typeof o.value === 'number') return o.value;
    const txt = String(o.value === undefined || o.value === null ? '' : o.value).trim();
    if (txt !== '' && /^-?\d+(\.\d+)?$/.test(txt)) return Number(txt);
    return idx;                        // 「暂停」「运行」这种没写值的档：数字变量按档位序号写
  }
  return String(o.value === undefined || o.value === null ? o.label : o.value);
}

register({
  type: 'multiPosition',         // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '多档位',
  sub: '点选一档（运行态可操作）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="13" width="28" height="11" rx="3" fill="#e5e7eb" stroke="#c3cbd6"/><rect x="4" y="13" width="9.3" height="11" rx="3" fill="#2563eb"/><path d="M13.3 13v11M22.6 13v11" stroke="#c3cbd6" stroke-width="1.2"/></svg>',
  defaults: {
    w: 240, h: 44,
    items: '',                     // 一行一档：显示=值=状态色（复用下拉框那套选项写法）
    orientation: 'h',              // h 水平 / v 垂直
    optionH: 36,                   // 垂直时每档高度
    activeBg: '#2563eb', activeText: '#ffffff', inactiveText: '#1f2329',
    fontSize: 14, borderColor: '#c3cbd6', radius: 6,
  },
  props: [
    // 选项表是"给人看的文字"：i18n:'options' → 逐行只翻 = 前面的显示文字（值/状态色原样）
    { key: 'items', label: '档位', type: 'textarea', rows: 5, i18n: 'options',
      placeholder: '一行一档：显示=值=状态色\n如：\n手动=0=#3b82f6\n自动=1=#22c55e\n检修=2=#f59e0b' },
    { key: 'orientation', label: '方向', type: 'select', options: [
      { v: 'h', t: '水平' }, { v: 'v', t: '垂直' },
    ] },
    { key: 'optionH', label: '档高', type: 'number', min: 16, max: 120, defVal: 36 },
    { key: 'activeBg', label: '选中底色', type: 'color' },
    { key: 'activeText', label: '选中文字色', type: 'color' },
    { key: 'inactiveText', label: '未选文字色', type: 'color' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 48 },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    // 选项表先整段翻（trOptions 只翻 = 前面的显示文字，值和颜色原样），再按老规矩解析
    const opts = parseOptions(trOptions(p.items || ''));
    const vertical = p.orientation === 'v';
    const radius = clamp(Math.round(numOr(p.radius, 6)), 0, 30);
    const optH = clamp(Math.round(numOr(p.optionH, 36)), 16, 120);
    const borderColor = p.borderColor || '#c3cbd6';
    const fs = clamp(Math.round(numOr(p.fontSize, 14)), 8, 48);
    const boxStyle = `width:100%;height:100%;display:flex;flex-direction:${vertical ? 'column' : 'row'};box-sizing:border-box;
      border:1px solid ${borderColor};border-radius:${radius}px;overflow:${vertical ? 'auto' : 'hidden'};user-select:none`;
    if (!opts.length) {
      return `<div class="w-mp wmp-empty" data-orientation="${vertical ? 'v' : 'h'}" data-count="0"
        style="${boxStyle}align-items:center;justify-content:center;color:#8a94a6;font-size:12px;cursor:default;background:#f7f8fa">
        <span>${escapeHtml(tr('未配置档位'))}</span></div>`;
    }
    const v = varValue(w, vars);
    const hit = optionIndexByValue(opts, v);       // 当前值那一档高亮（值不在选项里 = 不高亮）
    const activeBg = p.activeBg || '#2563eb';
    const activeText = p.activeText || '#ffffff';
    const inactiveText = p.inactiveText || '#1f2329';
    const items = opts.map((o, i) => {
      const on = i === hit;
      const bg = on ? (o.color || activeBg) : 'transparent';       // 档位自带状态色时优先用它
      const fg = on ? activeText : inactiveText;
      // 分隔线：水平的画右边（最后一档不画）、垂直的画下边 —— 内联样式，不动公共 CSS
      const sep = i < opts.length - 1
        ? (vertical ? `border-bottom:1px solid ${borderColor};` : `border-right:1px solid ${borderColor};`)
        : '';
      const sizeStyle = vertical
        ? `height:${optH}px;flex:none;`
        : 'flex:1 1 0;min-width:0;height:100%;';
      return `<div class="wmp-item${on ? ' on' : ''}" data-idx="${i}" data-value="${escapeHtml(String(o.value))}"
        style="position:relative;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0 6px;
        overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;${sizeStyle}background:${bg};color:${fg};font-size:${fs}px;${sep}">${escapeHtml(o.label)}</div>`;
    }).join('');
    return `<div class="w-mp" data-orientation="${vertical ? 'v' : 'h'}" data-count="${opts.length}" style="${boxStyle}">
      ${items}
    </div>`;
  },
  /** 运行态交互：点某一档 → 写这一档的值（事件绑根 el 做委托，档位 DOM 重建也不丢） */
  attach(el, w, api) {
    const varName = () => (w.bindings ? (w.bindings.variable || '') : '');
    el.addEventListener('click', (e) => {
      const name = varName();
      if (!name) return;                             // 没绑变量：纯显示，不响应
      // 事件委托：点到哪一档（.wmp-item）就写哪一档；点到边框/空白处什么都不做
      const item = e.target && e.target.closest ? e.target.closest('.wmp-item') : null;
      if (!item || !el.contains(item)) return;
      if (!api.allowed()) return;                    // 权限 / 按条件启用：先过闸
      const idx = Number(item.getAttribute('data-idx'));
      const opts = parseOptions(trOptions(w.props ? (w.props.items || '') : ''));
      if (!Number.isFinite(idx) || idx < 0 || idx >= opts.length) return;
      api.set(name, valueOfOption(w, opts[idx], idx));
      // 按 varStore 里的真值重画：写成功 / 被链路门挡下，高亮都不会停在假的档上
      api.refresh();
    });
  },
});
