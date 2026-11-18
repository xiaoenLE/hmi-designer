/**
 * barcode.js — 条码输入 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 用途：绑一个 string/wstring 变量，现场用**扫码枪**（USB 扫码枪就是一个"打字 + 回车"的键盘）
 *   或手输条码，回车 / 失焦 / 输入停顿（自动提交 ms）时把内容写进变量。
 *   · render 画的是**真的 `<input>`**：扫码枪的字符直接进框里；
 *   · 触屏没有系统输入法时，点控件右边那个 ⌨（或输入框外的空白）弹运行态软键盘（string 变量自动是文字键盘）；
 *   · 运行态交互全部挂在 el（控件根 .wd）上做委托 —— refreshWidgetBody 只重建里面的 .body，
 *     绑在子元素上的监听会跟着 DOM 一起没（见 runtime.js 的 buildWidget / attach）。
 *   · 写变量一律走 api.set（= varStore 统一门：链路门 / 写后保护 / 失败回读都在那一层）。
 *   · 显示用缓冲放 WeakMap，不挂到 w 上：w 要存进工程 JSON，多一个键就是一条脏数据。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml, varValue } = rutil;
import { tr } from '../../core/i18n.js';

/** 取整并夹在 [lo, hi]；认不出/缺键用 dflt（老工程缺键兜底） */
function intIn(v, dflt, lo, hi) {
  const n = Math.round(+v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 运行态输入缓冲：w → { text, timer }
 *   text === null  → 显示变量当前值（没在输入 / 刚提交完）
 *   text === ''    → 提交后清空（clearAfterSubmit），等下一次扫码
 *   为什么不用 w.xxx：w 是工程数据，反序列化/存档会把它带出去。
 */
const buffers = new WeakMap();
function bufOf(w, create) {
  let s = buffers.get(w);
  if (!s && create) { s = { text: null, timer: 0 }; buffers.set(w, s); }
  return s;
}

register({
  type: 'barcode',                 // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '条码输入',
  sub: '扫码枪/键盘输入，回车提交',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="8" width="28" height="20" rx="3" fill="#fff" stroke="#94a3b8"/><path d="M9 13v10M12 13v10M16 13v10M19 13v10M22 13v10M26 13v10" stroke="#1f2329" stroke-width="1.4" stroke-linecap="round"/></svg>',
  defaults: {
    w: 240, h: 44,
    placeholder: '扫描条码…',
    autoSubmitMs: 0,                 // ≥100 = 输入停顿这么久就自动提交；0 = 只认回车/失焦
    minLen: 1,                       // 少于这个长度不写（恢复原值），防止扫半截就提交
    clearAfterSubmit: false,         // 提交后清空输入框（连扫多件时用）
    uppercase: false,                // 统一转大写（条码常有大写字母）
    trim: true,                      // 去掉首尾空格（扫码枪有时会多带一个）
    fontSize: 16, textColor: '#1f2329', bgColor: '#ffffff',
    borderColor: '#c3cbd6', borderWidth: 1, radius: 5,
  },
  props: [
    { key: 'placeholder', label: '提示文字', type: 'text', i18n: 'text' },
    { key: 'autoSubmitMs', label: '自动提交(ms)', type: 'number', min: 0, max: 60000, defVal: 0 },
    { key: 'minLen', label: '最小长度', type: 'number', min: 0, max: 256, defVal: 1 },
    { key: 'clearAfterSubmit', label: '提交后清空', type: 'check', defVal: false },
    { key: 'uppercase', label: '转大写', type: 'check', defVal: false },
    { key: 'trim', label: '去首尾空格', type: 'check', defVal: true },
    { key: 'fontSize', label: '字号', type: 'number', min: 10, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  binding: { variable: { types: ['string', 'wstring'], label: '绑定变量（条码字符串）' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const bw = intIn(p.borderWidth, 1, 0, 8);
    const radius = intIn(p.radius, 5, 0, 30);
    const fs = intIn(p.fontSize, 16, 10, 72);
    // 绑定变量的当前值就是待显示的内容（编辑态所见即所得）；运行态如果在输入中，用缓冲里的字
    const v = varValue(w, vars);
    let shown = (v === null || v === undefined) ? '' : String(v);
    const st = bufOf(w, false);
    if (mode === 'run' && st && st.text !== null) shown = st.text;
    const bd = bw > 0 ? `border:${bw}px solid ${p.borderColor || '#c3cbd6'};` : 'border:none;';
    const ph = tr(p.placeholder || '');
    return `<div class="w-barcode" style="position:relative;width:100%;height:100%;box-sizing:border-box;display:flex;align-items:center;gap:4px;background:${p.bgColor || '#ffffff'};border-radius:${radius}px;${bd}">
      <input class="w-barcode-inp" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
        value="${escapeHtml(shown)}" placeholder="${escapeHtml(ph)}"${mode === 'edit' ? ' disabled' : ''}
        style="flex:1;min-width:0;height:100%;box-sizing:border-box;border:none;outline:none;background:transparent;padding:0 8px;font-size:${fs}px;color:${p.textColor || '#1f2329'}">
      <span class="w-barcode-kb" data-barcode-pad="1" style="flex:none;display:flex;align-items:center;justify-content:center;width:${fs + 16}px;height:100%;color:#8a94a6;font-size:${fs}px;user-select:none;cursor:pointer">⌨</span>
    </div>`;
  },
  /**
   * 运行态交互（runtime.js 建好控件后调用；事件全部挂在 el 上做委托）
   * @param {Element} el 控件根 .wd（刷新只换里面的 .wd-body，这层不动）
   * @param {object} w 控件数据
   * @param {object} api { get, set, blockReason, allowed, refresh, editNumber }
   */
  attach(el, w, api) {
    const p = w.props || {};
    const name = (w.bindings && w.bindings.variable) || '';
    const st = bufOf(w, true);
    st.text = null;                  // 每次进运行态（或切语言重画）都从变量当前值显示
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    let submitting = false;          // 防重入：回车换行/刷新 DOM 时 blur 可能再进来一次

    const inputEl = () => el.querySelector('.w-barcode-inp');
    const varText = () => {
      const v = api.get(name);
      return (v === null || v === undefined) ? '' : String(v);
    };
    const normalize = (s) => {
      let out = String(s === null || s === undefined ? '' : s);
      if (p.uppercase) out = out.toUpperCase();
      if (p.trim !== false) out = out.trim();
      return out;
    };
    const showText = (text) => { const i = inputEl(); if (i) i.value = text; };
    const showWhy = (why) => { const i = inputEl(); if (i) i.title = why; };
    const clearWhy = () => { const i = inputEl(); if (i) i.removeAttribute('title'); };
    const armAuto = () => {
      if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
      const ms = Math.round(+p.autoSubmitMs || 0);
      if (ms < 100) return;
      st.timer = setTimeout(() => { st.timer = 0; submit(); }, ms);
    };
    const submit = () => {
      if (submitting) return;
      submitting = true;
      try {
        if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
        const before = varText();
        const text = st.text === null ? normalize(before) : normalize(st.text);
        // 没绑变量：只是显示用，什么都不写
        if (!name) { st.text = null; showText(before); return; }
        // 太短（扫半截 / 清空后误提交）→ 不写，恢复原值
        const minLen = intIn(p.minLen, 1, 0, 256);
        if ([...text].length < minLen) { st.text = null; showText(before); return; }
        // 权限/条件闸：不让操作就什么都不做（actAllowed 该弹密码框的已经弹了）
        if (!api.allowed()) { st.text = null; showText(before); return; }
        // 链路门：设备没连上 / 刚连上还没读到数据 → 不写，把原因挂在悬停提示上
        const why = api.blockReason(name);
        if (why) { st.text = null; showText(before); showWhy(why); return; }
        clearWhy();
        st.text = null;              // 先回到"显示变量值"
        if (text !== before) api.set(name, text);
        if (p.clearAfterSubmit) { st.text = ''; showText(''); }   // 连扫多件：提交后框里留空
        else showText(text);
      } finally {
        submitting = false;
      }
    };

    // 打字（扫码枪逐字符送进来）/ 手动输入：更新缓冲，按「自动提交」定时
    el.addEventListener('input', (e) => {
      const i = e.target;
      if (!i || !i.classList || !i.classList.contains('w-barcode-inp')) return;
      st.text = normalize(i.value);
      armAuto();
    });
    // 回车 = 扫码枪的结束符（扫码枪默认在条码后打一个 Enter）
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const i = e.target;
      if (!i || !i.classList || !i.classList.contains('w-barcode-inp')) return;
      e.preventDefault();
      st.text = normalize(i.value);
      submit();
    });
    // 失焦也提交（点画面别处、点软键盘图标都算"这一格输完了"）
    el.addEventListener('focusout', (e) => {
      const i = e.target;
      if (!i || !i.classList || !i.classList.contains('w-barcode-inp')) return;
      if (st.text === null) return;    // 没在输入（例如软键盘提交后重画）→ 不重复提交
      st.text = normalize(i.value);
      submit();
    });
    // 点输入框以外的空白 / 右边 ⌨ → 开运行态软键盘（触屏没有系统输入法时靠它）
    el.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.w-barcode-inp')) return;   // 点输入框 = 扫码枪聚焦，不弹键盘
      if (!name) return;
      if (!api.allowed()) return;
      st.text = null;
      api.editNumber(name, el);
    });
  },
});
