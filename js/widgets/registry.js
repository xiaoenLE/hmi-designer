/**
 * registry.js — 控件注册表
 *
 * 控件定义（def）结构：
 *   type      类型标识
 *   title     中文名（工具箱显示）
 *   sub       工具箱副标题
 *   icon      SVG 字符串
 *   defaults  默认属性 { w, h, ...props }
 *   props     属性面板 schema [{key,label,type,options?,min?,max?}]
 *   binding   绑定声明 { variable: {types:['bool'], required?} }
 *   actions   该控件允许配置的动作类型列表
 *   render(w, mode, vars) → body innerHTML（编辑/运行共用，所见即所得）
 */
import { fmtValue, escapeHtml } from '../core/utils.js';
import { langFontFactor, fontFactorForWidget } from '../core/i18n.js';

const defs = new Map();

/**
 * 把 render 出来的 HTML 里**内联 font-size** 乘一遍（多语言字号）。
 * 为什么在这儿做：控件 render 里写的都是 `font-size:20px`，没法用 CSS 变量统一乘
 * （各控件各写各的），而在「HTML 字符串」这一层替换是唯一不用改几十个 def 的地方。
 * 只处理内联样式 `font-size:NNpx` 和 SVG 的 `font-size="NN"`；CSS 类里的字号不动。
 *
 * 缩放系数：**按控件**算 ——
 *   · 属性面板在非默认语言下给这个控件单独调过字号 → 用「覆盖px / 基础px」（只影响这个控件）；
 *   · 否则用全局「这门语言的字号%」；
 * 系数 = 1 时原样返回（零开销、老工程/默认语言一个字节都不变）。
 */
function scaleFontSizes(html, w) {
  const f = w ? fontFactorForWidget(w) : langFontFactor();
  if (!(f > 0) || Math.abs(f - 1) < 0.001) return html;
  const mul = (n) => String(Math.round(Number(n) * f * 10) / 10);
  return String(html)
    .replace(/(font-size\s*:\s*)([\d.]+)px/gi, (m, a, n) => a + mul(n) + 'px')
    .replace(/(font-size\s*=\s*")([\d.]+)(")/gi, (m, a, n, b) => a + mul(n) + b);
}

export function register(def) { defs.set(def.type, def); }
/** 撤掉一个控件类型（导入控件包时"定义跑不起来"要把半成品回滚掉，见 pack.js） */
export function unregister(type) { return defs.delete(type); }

export const registry = {
  get(type) { return defs.get(type); },
  list() { return [...defs.values()]; },
};

/* ── 动作类型定义（按钮等交互控件的动作编辑器共用） ── */
export const ACTION_DEFS = {
  tap:       { label: '点动（按住=TRUE / 松开=FALSE）', params: { variable: 'var' } },
  toggle:    { label: '切换（点击翻转保持）',            params: { variable: 'var' } },
  gotoPage:  { label: '跳转页面',                        params: { page: 'page' } },
  showPopup: { label: '打开弹窗',                        params: { page: 'popup' } },
  hidePopup: { label: '关闭弹窗',                        params: {} },
  back:      { label: '返回上一页',                      params: {} },
  setValue:  { label: '置变量值',                        params: { variable: 'var', value: 'value' } },
  clearAlarm: { label: '清空报警记录',                    params: {} },
  // 操作权限：现场干完活把权限交回去（交班）。等价于点画面顶部那个"已解锁"小胶囊 / Ctrl+Shift+Q
  exitPerm:  { label: '退出权限（锁定）',                  params: {} },
};

/* ── 通用渲染入口：外层 .wd 定位壳 + .wd-body 内容 ── */
/**
 * 控件类型在本机**没有定义**时的占位内容。
 *
 * 为什么不能直接让它抛：`def.render(...)` 抛出去会把调用它的那一次渲染**整块打断** ——
 * 画布上 24 个控件只画到第 19 个就停了，剩下那几个连看都看不见，更别说选中删掉；
 * 运行态同理（客户看到半张画面，还查不出为什么）。所以这里画一个**看得见、选得中、删得掉**的占位，
 * 并且把原因写在脸上。什么时候会遇到：工程里带的控件定义丢了（手改过 JSON / 换了台没带定义的机器），
 * 或者某个控件类型在本机这份代码里被删掉/改名了（type 是永久 id，改了就认不出来）。
 */
function missingDefHtml(w) {
  return `<div class="wd-missing" title="这个控件的类型在本机没有定义：${escapeHtml(w.type)}。
可能原因：① 这份工程/控件包里的自定义控件定义丢了（手改过 JSON，或那份工程没带定义）；
② 这个控件类型在本机这份代码里被删掉或改了名字。
办法：删掉它，或者导入带这个控件的控件包（画布空白处右键 → 导入控件包…）。">⚠ 未知控件<span>${escapeHtml(w.type)}</span></div>`;
}

export function renderWidgetDOM(w, mode, vars) {
  const def = registry.get(w.type);
  const el = document.createElement('div');
  el.className = `wd wd-${w.type}`;
  el.dataset.id = w.id;
  el.style.left = w.x + 'px';
  el.style.top = w.y + 'px';
  el.style.width = w.w + 'px';
  el.style.height = w.h + 'px';
  el.style.zIndex = w.z;
  if (!def) {
    el.classList.add('wd-unknown');
    el.innerHTML = `<div class="wd-body">${missingDefHtml(w)}</div>`;
    return el;
  }
  el.innerHTML = `<div class="wd-body">${scaleFontSizes(def.render(w, mode, vars), w)}</div>`;
  return el;
}

/** 仅刷新控件内容（变量值变化时的局部更新）。
 *  def.selfDrawn = true 的控件（如波形）自己逐帧重绘，重建 DOM 反而会毁掉它的画布 → 直接跳过 */
export function refreshWidgetBody(el, w, mode, vars) {
  const def = registry.get(w.type);
  if (!def || def.selfDrawn) return;
  const body = el.querySelector('.wd-body');
  if (body) body.innerHTML = scaleFontSizes(def.render(w, mode, vars), w);
}

/* ── defs.js 各类型共享的小工具 ── */
export const rutil = {
  fmtValue, escapeHtml,
  /** 控件的「状态显示变量」：优先用显式绑定；**没绑但动作里有变量就用那个**。
   *  为什么要有这条兜底：点动/切换按钮最常见的配法就是「只配动作变量、不单独特意去绑状态」，
   *  以前那种配法按钮永远不亮/不换色（stateVar 是空的），现场看着就是"点动没反应"。
   *  runtime 的「变量变化 → 刷新绑定控件」也走同一个函数，两边必须一致，
   *  否则会出现"值变了但控件不重画"。 */
  stateVarOf(w) {
    const b = w?.bindings?.variable;
    if (b) return b;
    const a = (w?.actions || []).find(x => x?.params?.variable);
    return (a && a.params.variable) || '';
  },
  /** 取绑定变量当前值（无绑定返回 null）
   *  数组变量：整段拿回来（显示成 [1, 2, 3]，只读）。
   *  要单独用某一个元素，就把变量**展开成单个变量**（arrw[1]…arrw[N]）再绑那个 ——
   *  不再有「绑整段 + 元素下标」这套第二机制了。 */
  varValue(w, vars) {
    const name = w.bindings?.variable;
    if (!name || !vars) return null;
    return vars.get(name);
  },
};
