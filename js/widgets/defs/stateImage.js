/**
 * stateImage.js — 多状态图片 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 用途：一个变量有几种状态（0/1/2、运行/停止/故障…），每种状态配一张图，值一变就换图。
 *   · 「状态图」是一个多行文本框，一行一条：`值=图片URL`（也支持 data: 内嵌图）
 *   · 值对不上任何一行（或变量没绑 / 还没值）→ 用「兜底图」；兜底图也没配 → 显示占位
 *   · 编辑态：绑的值没命中时显示**第一张**（所见即所得，作者一眼知道这个控件长什么样）
 *   · 图片显示方式（contain/cover/fill）、圆角、边框都在属性面板里调，样式全部内联，不改公共 CSS
 */
import { register, rutil } from '../registry.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);

/**
 * 解析「值=图片」多行文本。
 * 只按**第一个** `=` 切（dataURL 里可能还有 =，不能被切坏）；认不出的行直接跳过，不让一行坏数据拖垮整张图。
 * @returns {{key:string, src:string}[]}
 */
function parseImages(text) {
  const out = [];
  String(text ?? '').split('\n').forEach(line => {
    const s = line.trim();
    if (!s) return;
    const i = s.indexOf('=');
    if (i <= 0) return;
    const key = s.slice(0, i).trim();
    const src = s.slice(i + 1).trim();
    if (!key || !src) return;
    out.push({ key, src });
  });
  return out;
}

/** 变量值和状态键是否算同一个：数字按数值比（1 和 "1" 都认），其余按字符串比 */
function sameValue(key, v) {
  if (String(key) === v) return true;
  const a = Number(key), b = Number(v);
  return String(key).trim() !== '' && v !== '' && Number.isFinite(a) && Number.isFinite(b) && a === b;
}

register({
  type: 'stateImage',            // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '多状态图片',
  sub: '按变量值切图（运行/停止/故障…）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="9" width="21" height="16" rx="2" fill="#e5e7eb" stroke="#c3cbd6"/><rect x="11" y="5" width="21" height="16" rx="2" fill="#f7f8fa" stroke="#94a3b8"/><circle cx="17" cy="11" r="2" fill="#d97706"/><path d="M13 19l5-5 3 3 3-2 4 4z" fill="#94a3b8"/></svg>',
  defaults: {
    w: 160, h: 120,
    images: '',                  // 多行「值=图片URL / dataURL」
    fallback: '',                // 兜底图（值没命中时用）
    fit: 'contain',              // contain / cover / fill
    radius: 0,                   // 圆角
    borderColor: '', borderWidth: 0,
  },
  props: [
    { key: 'images', label: '状态图', type: 'textarea', rows: 5,
      placeholder: '一行一条：值=图片地址\n如：\n0=/img/stop.png\n1=/img/run.png\n2=/img/fault.png' },
    { key: 'fallback', label: '兜底图', type: 'text' },
    { key: 'fit', label: '显示方式', type: 'select', defVal: 'contain', options: [
      { v: 'contain', t: '完整显示（contain）' },
      { v: 'cover', t: '铺满裁切（cover）' },
      { v: 'fill', t: '拉伸铺满（fill）' },
    ] },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
  ],
  binding: { variable: { types: ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '绑定变量' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const pairs = parseImages(p.images);
    const v = varValue(w, vars);
    const raw = (v === null || v === undefined) ? '' : String(v).trim();
    // bool 变量两种写法都认：状态图里写 true/false 或 1/0 都能命中
    const candidates = v === true ? ['true', '1'] : v === false ? ['false', '0'] : (raw === '' ? [] : [raw]);
    const fit = ['contain', 'cover', 'fill'].includes(p.fit) ? p.fit : 'contain';
    const radius = clamp(Math.round(numOr(p.radius, 0)), 0, 100);
    const bw = clamp(numOr(p.borderWidth, 0), 0, 8);
    const bd = bw > 0 ? `border:${bw}px solid ${p.borderColor || '#c3cbd6'};` : '';
    const boxStyle = `position:relative;width:100%;height:100%;box-sizing:border-box;overflow:hidden;border-radius:${radius}px;${bd}`;
    // 先按变量值找图；编辑态没命中就退回第一张（作者在画布上能看到这个控件长什么样）
    let src = '';
    if (candidates.length) {
      const hit = pairs.find(x => candidates.some(c => sameValue(x.key, c)));
      src = hit ? hit.src : '';
    }
    if (!src && mode === 'edit' && pairs.length) src = pairs[0].src;
    if (!src) src = String(p.fallback || '').trim();
    if (!src) {
      return `<div class="w-stateImage si-empty" data-state-value="${escapeHtml(raw)}" title="多状态图片：在属性面板「状态图」里一行填一条「值=图片地址」"
        style="${boxStyle}display:flex;align-items:center;justify-content:center;gap:6px;color:#8a94a6;font-size:12px;background:repeating-linear-gradient(45deg,#f7f8fa 0 8px,#eef1f5 8px 16px)">
        <svg viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="#b6bec9" stroke-width="1.6"/><circle cx="9" cy="10" r="2" fill="#d97706"/><path d="M5 18l5-6 4 4 3-3 4 5z" fill="#c3cbd6"/></svg>
        <span>多状态图片</span></div>`;
    }
    return `<div class="w-stateImage" data-state-value="${escapeHtml(raw)}" data-fit="${fit}" style="${boxStyle}background:#f7f8fa">
      <img class="si-img" src="${escapeHtml(src)}" alt="" data-src="${escapeHtml(src)}"
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};display:block;border-radius:${radius}px">
    </div>`;
  },
});
