/**
 * select.js — 下拉框 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 下拉框 / 组合框 */
import { register, rutil } from '../registry.js';
const { escapeHtml, varValue } = rutil;
import { parseOptions, optionIndexByValue, comboMode, contrastTextOn } from '../../core/utils.js';
import { tr, trOptions } from '../../core/i18n.js';

register({
  type: 'select',
  title: '下拉框',
  sub: '选项选择（组合框）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="9" width="28" height="18" rx="3" fill="#fff" stroke="#94a3b8"/><text x="8" y="22" font-size="10" fill="#1f2329" font-family="Consolas">手动</text><path d="M24 15l3 4 3-4" fill="none" stroke="#64748b" stroke-width="2" stroke-linejoin="round"/></svg>',
  defaults: {
    w: 150, h: 44,
    items: '手动=0\n自动=1\n点动=2',     // 一行一个：显示文字 / 显示文字=值 / 显示文字=值=状态色
    valueMode: 'value',                  // value=写选项的值 / index0=写序号(从0) / index1=写序号(从1)
    placeholder: '--',                   // 变量值不在选项里时显示什么
    // 操作方式（三选一）：pick=点开列表选 / type=可选也可输入 / view=只显示状态（不可操作）
    // ⚠ 老工程用的是 readonly 复选框 → 载入时 project.normalize 迁成这里（见 core/utils.js 的 comboMode）
    operate: 'pick',
    // 每个状态可以各带一个颜色（写在选项行末：手动=0=#3b82f6）。
    // 这个开关说那个颜色用在哪：contrast=整块背景 + 文字自动配黑/白（默认，11 个状态也能都看清）/
    // bg=整块背景（文字用上面设的「文字色」）/ text=只染文字
    stateColorOn: 'contrast',
    optionH: 36,                         // 展开后每个选项的行高（原生下拉改不了，所以自绘）
    maxRows: 6,                          // 展开后最多显示几项，超出滚动
    fontSize: 15, textColor: '#1f2329', bgColor: '#ffffff',
    borderColor: '#c3cbd6', borderWidth: 1, radius: 5,
  },
  props: [
    { key: 'items', label: '选项', type: 'textarea', rows: 5, i18n: 'options' },
    // 状态颜色：每个状态一个取色器（属性面板里自绘，写回的就是上面那份选项表）
    // uiOnly：这一行只是面板里的编辑器，**不是**存在 w.props 里的属性 ——
    //   生成给 AI 看的控件库目录时跳过它（不然 AI 会照着一个存不进去的键去配颜色）
    { key: 'stateColors', label: '状态颜色', type: 'stateColors', uiOnly: true },
    { key: 'stateColorOn', label: '状态色用在', type: 'select', options: [
      { v: 'contrast', t: '背景（文字自动黑/白）' }, { v: 'bg', t: '背景（用上面的文字色）' },
      { v: 'text', t: '文字' }] },
    { key: 'operate', label: '操作方式', type: 'select', options: [
      { v: 'pick', t: '只能选（点开列表）' }, { v: 'type', t: '可选也可输入' },
      { v: 'view', t: '只显示状态（不可操作）' }] },
    { key: 'valueMode', label: '写值方式', type: 'select', options: [
      { v: 'value', t: '写选项的值' }, { v: 'index0', t: '写序号（从 0）' }, { v: 'index1', t: '写序号（从 1）' }] },
    { key: 'optionH', label: '选项行高', type: 'number', min: 20, max: 80 },
    { key: 'maxRows', label: '最多显示几项', type: 'number', min: 1, max: 20 },
    // 展开后顶部带一个筛选框：选项多的时候（几十个状态）边打字边缩小范围，回车选第一个
    { key: 'filterOn', label: '可筛选', type: 'check', defVal: false },
    { key: 'placeholder', label: '无匹配显示', type: 'text', i18n: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 40 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '绑定变量' } },
  actions: [],
  // 自绘下拉（不用原生 <select>）：原生弹层的行高由浏览器定，改不了也截不到图
  render(w, mode, vars) {
    const p = w.props;
    // 选项表只翻「= 前面」的显示文字（值/状态色原样）；占位提示也翻
    const opts = parseOptions(trOptions(p.items));
    const v = varValue(w, vars);
    const hit = optionIndexByValue(opts, v);
    const om = comboMode(p);                 // view / pick / type（老工程的 readonly 也在里面回落）
    const ro = om === 'view';                // 只显示状态：不展开、不带小三角
    const ph = tr(String(p.placeholder ?? '--'));
    const empty = v === null || v === undefined || v === '';
    // 「可选也可输入」时值不在选项里就**直接显示这个值** —— 自由输入的意义就在这儿
    // （选项表只是常用值；PLC 那边完全可能是别的数/别的字）。其它模式照旧显示占位提示。
    const cur = hit >= 0 ? opts[hit].label
      : om === 'type' ? (empty ? ph : String(v))
      : (empty ? ph : `${ph}（当前 ${v}）`);
    const itemH = Math.max(20, Math.round(+p.optionH || 36));
    const rows = Math.max(1, Math.min(20, Math.round(+p.maxRows || 6)));
    // 选中项自带颜色 → 状态色生效：默认铺在整块背景上（文字按底色自动配黑/白），也可只染文字
    const sc = hit >= 0 ? (opts[hit].color || '') : '';
    const colorOn = p.stateColorOn || 'contrast';   // 老工程没有这个键 → 跟默认值一个走法
    const byText = colorOn === 'text';
    const bgStyle = byText ? (p.bgColor || 'transparent') : (sc || p.bgColor || 'transparent');
    // contrast=背景＋文字自动（深色底配白字）· bg=背景＋自己设的文字色 · text=只染文字
    const curColor = byText ? sc : (colorOn === 'contrast' ? contrastTextOn(sc) : '');
    const curStyle = curColor ? `color:${curColor};` : '';
    return `<div class="w-combo${ro ? ' ro' : ''}${om === 'type' ? ' type' : ''}${mode === 'edit' ? ' edit' : ''}"
      style="--combo-item-h:${itemH}px;font-size:${p.fontSize}px;color:${p.textColor};
        background:${bgStyle};border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};
        border-radius:${p.radius}px">
      <div class="w-combo-box"><span class="w-combo-cur" style="${curStyle}">${escapeHtml(cur)}</span>${ro ? '' : '<span class="w-combo-car"></span>'}</div>
      <div class="w-combo-pop" style="max-height:${rows * itemH}px">
        ${opts.map((o, i) => {
          // 弹层恒定浅底：状态色铺满整块会看不清别的项，所以这里只用「色块 + 文字」提示这个状态是什么色
          const dot = (!byText && o.color) ? `<i class="w-combo-dot" style="background:${o.color}"></i>` : '';
          const st = (byText && o.color) ? ` style="color:${o.color}"` : '';
          return `<div class="w-combo-item${i === hit ? ' on' : ''}" data-idx="${i}"${st}>${dot}${escapeHtml(o.label)}</div>`;
        }).join('')}
        ${om === 'type' ? `<div class="w-combo-typerow" title="${escapeHtml(tr('手动输入一个值（不在选项里也行）'))}">✎ ${escapeHtml(tr('输入…'))}</div>` : ''}
      </div>
    </div>`;
  },
  /**
   * 运行态交互：「可筛选」的下拉展开后，在弹层顶部塞一个筛选框 —— 选项几十个时边打字边缩小范围
   * （回车选第一个匹配项、Esc 清掉筛选）。展开/收起本身是运行态的点击分发做的（见 runtime.js），
   * 这里只在"展开之后"补一个输入框；点它/在里面打字不会被当成"点了别处"（runtime 已放行）。
   * ⚠ 事件绑在控件根 el 上（委托）；def 里禁止用可选链（MCP 静态提取器会崩）。
   */
  attach(el, w) {
    if (!(w.props && w.props.filterOn)) return;
    const ensure = () => {
      const combo = el.querySelector('.w-combo');
      if (!combo || !combo.classList.contains('open')) return;
      const pop = combo.querySelector('.w-combo-pop');
      if (!pop) return;
      let box = pop.querySelector('.w-combo-filter');
      if (box) {
        if (box.value) {
          box.value = '';
          pop.querySelectorAll('.w-combo-item').forEach(it => { it.style.display = ''; });
        }
        return;
      }
      box = document.createElement('input');
      box.className = 'w-combo-filter';
      box.type = 'text';
      box.autocomplete = 'off';
      box.placeholder = tr('筛选…');
      box.style.cssText = 'width:100%;box-sizing:border-box;margin:2px 0 4px;padding:4px 6px;'
        + 'border:1px solid #c3cbd6;border-radius:4px;font-size:13px;outline:none;background:#fff;color:#1f2329';
      const filter = () => {
        const q = String(box.value || '').trim().toLowerCase();
        pop.querySelectorAll('.w-combo-item').forEach(it => {
          const hit = !q || String(it.textContent || '').toLowerCase().includes(q);
          it.style.display = hit ? '' : 'none';
        });
      };
      box.addEventListener('input', filter);
      box.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = [...pop.querySelectorAll('.w-combo-item')].find(it => it.style.display !== 'none');
          if (first) first.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          box.value = '';
          filter();
          box.blur();
        }
        e.stopPropagation();
      });
      pop.insertBefore(box, pop.firstChild);
      box.value = '';
      filter();
      setTimeout(() => { try { box.focus(); } catch (e) { /* 忽略 */ } }, 0);
    };
    // 运行态的展开是在同一次点击之后才切 .open —— 排到微任务之后再补筛选框
    el.addEventListener('click', () => { setTimeout(ensure, 0); });
  },
});
