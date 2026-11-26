/**
 * paramTable.js — 参数表 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 用途：一页把**多个参数**排成一张表（速度 / 数量 / 配方名…），省得摆一墙数值控件。
 *   · 绑 `bindings.variables`（按行，最多 32 个变量；空槽 = 未绑定行）；
 *   · 「labels」每行一个显示名（换行分列，缺省显示变量名）；「units」每行一个单位；
 *   · 运行态点某一行 → 用运行态**软键盘**改这个变量（api.editNumber；数值变量数字键盘、
 *     string 变量自动文字键盘），确定后变量一改，表格由「变量 → 控件」索引自动重画；
 *     「readonlyRows」里点名的行（1 开始，逗号分列）点了不开键盘。
 *   · 点表头、点没绑变量的空行都不响应。
 *   · 样式全部内联，不改公共 CSS；显示文字（labels / units / 表头 / 未绑定变量）走多语言。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { tr, trLines } from '../../core/i18n.js';

/** 取整并夹在 [lo, hi]；认不出/缺键用 dflt（老工程缺键兜底） */
function intIn(v, dflt, lo, hi) {
  const n = Math.round(+v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** 小数位：0~6，缺键按 2；空串按 0（属性面板清空输入框会得到空串） */
function decOf(v) {
  if (v === '' || v === null || v === undefined) return 0;
  return intIn(v, 2, 0, 6);
}

/** 值 → 显示文字：数值按小数位；字符串原样；bool 用 TRUE/FALSE；没值 → 空串 */
function formatValue(v, dec) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(dec) : String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** 「只读行」文本（1 开始，逗号分列，如 "1,3,5"）→ 行号集合；认不出的段跳过 */
function readOnlySet(text) {
  const set = new Set();
  String(text === null || text === undefined ? '' : text).split(',').forEach(part => {
    const n = parseInt(String(part).trim(), 10);
    if (Number.isFinite(n) && n > 0) set.add(n);
  });
  return set;
}

register({
  type: 'paramTable',              // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '参数表',
  sub: '多个参数排成表，点行改值',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="7" width="28" height="22" rx="2" fill="#fff" stroke="#94a3b8"/><rect x="4" y="7" width="28" height="7" fill="#eef2f7"/><path d="M4 21h28M18 7v22" stroke="#c3cbd6" stroke-width="1.4"/><path d="M21 18h7M21 25h5" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round"/></svg>',
  defaults: {
    w: 360, h: 220,
    labels: '',                      // 每行一个显示名（换行分列；缺省用变量名）
    units: '',                       // 每行一个单位（换行分列）
    decimals: 2,                     // 数值显示的小数位（0~6）
    showHeader: true,                // 画表头（参数 / 数值）
    readonlyRows: '',                // 只读行号（1 开始，逗号分列，如 1,3,5）：点了不开键盘
    rowH: 30, fontSize: 14,
    textColor: '#1f2329', bgColor: '#ffffff', headerBg: '#eef2f7', lineColor: '#c3cbd6',
    zebra: true, radius: 4,
  },
  props: [
    { key: 'labels', label: '显示名', type: 'textarea', rows: 5, i18n: 'lines' },
    { key: 'units', label: '单位', type: 'textarea', rows: 5, i18n: 'lines' },
    { key: 'decimals', label: '小数位', type: 'number', min: 0, max: 6, defVal: 2 },
    { key: 'showHeader', label: '画表头', type: 'check', defVal: true },
    { key: 'readonlyRows', label: '只读行号', type: 'text' },
    { key: 'rowH', label: '行高', type: 'number', min: 16, max: 80 },
    { key: 'fontSize', label: '字号', type: 'number', min: 9, max: 40 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'headerBg', label: '表头底色', type: 'color' },
    { key: 'lineColor', label: '线色', type: 'color' },
    { key: 'zebra', label: '斑马纹', type: 'check', defVal: true },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
  ],
  binding: {
    variables: {
      types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string', 'wstring'],
      label: '参数变量（按行）', max: 32,
    },
  },
  // 属性面板形态：multi 绑定只给"一行一个变量"的变量格（通道色/量程那套是波形的概念，参数表不摆）。
  // ⚠ 放**顶层**而不是 binding.variables.simple：MCP 静态提取器给 binding 做归一化，
  //   多带一个键会让「静态提取 == 运行中注册表」的守卫误报（见 verify-widgets-param 第 3 组）。
  bindPanel: 'simple',
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const fg = p.textColor || '#1f2329';
    const line = p.lineColor || '#c3cbd6';
    const bg = p.bgColor || '#ffffff';
    const headBg = p.headerBg || '#eef2f7';
    const fs = intIn(p.fontSize, 14, 9, 40);
    const rowH = intIn(p.rowH, 30, 16, 80);
    const radius = intIn(p.radius, 4, 0, 100);
    const dec = decOf(p.decimals);
    // 显示名 / 单位：多行文字逐行翻（i18n:'lines'），再按行取
    const labelLines = trLines(p.labels || '').split('\n').map(s => s.trim());
    const unitLines = trLines(p.units || '').split('\n').map(s => s.trim());
    const roSet = readOnlySet(p.readonlyRows);
    // 绑定变量（按行）：属性面板写的是定长数组（末尾可能一串空串）→ 去掉尾部空槽再画
    const raw = (w.bindings && Array.isArray(w.bindings.variables)) ? w.bindings.variables : [];
    let end = raw.length - 1;
    while (end >= 0 && !raw[end]) end--;
    const names = end >= 0 ? raw.slice(0, end + 1) : ['', '', ''];   // 新控件：先给 3 个空行，画布上看得见
    const getVal = (name) => {
      if (vars && typeof vars.get === 'function') return vars.get(name);
      return undefined;
    };
    const cell = `height:${rowH}px;padding:0 8px;box-sizing:border-box;border-bottom:1px solid ${line};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
    let head = '';
    if (p.showHeader !== false) {
      head = `<thead><tr>
        <th class="pt-head" style="${cell};background:${headBg};font-weight:600;text-align:left;border-right:1px solid ${line}">${escapeHtml(tr('参数'))}</th>
        <th class="pt-head" style="${cell};background:${headBg};font-weight:600;text-align:right">${escapeHtml(tr('数值'))}</th>
      </tr></thead>`;
    }
    const body = names.map((name, i) => {
      const ro = roSet.has(i + 1);
      const label = labelLines[i] || name || tr('未绑定变量');
      const unit = unitLines[i] || '';
      const boundOk = !!name;
      const value = boundOk ? (formatValue(getVal(name), dec) + (unit ? ' ' + unit : '')) : '--';
      const zebra = (p.zebra !== false && i % 2 === 1) ? 'background:#f7f8fa;' : '';
      // 运行态、有变量、非只读 → 整行可点（开软键盘改值）；编辑态不摆"可点"手势
      const cursor = (mode === 'run' && boundOk && !ro) ? 'cursor:pointer;' : 'cursor:default;';
      return `<tr class="pt-row${ro ? ' pt-ro' : ''}" data-paramrow="${i}" data-paramvar="${escapeHtml(name)}"${ro ? ' data-paramro="1"' : ''} style="height:${rowH}px;${zebra}">
        <td class="pt-name" style="${cell};border-right:1px solid ${line};color:${fg};${cursor}">${escapeHtml(label)}</td>
        <td class="pt-value" data-paramcol="1" style="${cell};text-align:right;color:${ro ? '#6b7280' : fg};${cursor}">${escapeHtml(value)}</td>
      </tr>`;
    }).join('');
    return `<div class="w-paramTable" style="width:100%;height:100%;box-sizing:border-box;overflow:auto;background:${bg};border:1px solid ${line};border-radius:${radius}px">
      <table class="pt-table" style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:${fs}px;color:${fg}">
        <colgroup><col style="width:48%"><col style="width:52%"></colgroup>
        ${head}<tbody>${body}</tbody>
      </table>
    </div>`;
  },
  /**
   * 运行态交互（runtime.js 建好控件后调用；事件挂在 el 上做委托，body 重画后照样有效）
   * 点「有变量且不是只读」的行 → 用运行态软键盘改那个变量（多行共用一套键盘，不用每行各写一个控件）。
   * @param {Element} el 控件根 .wd（刷新只换里面的 .wd-body，这层不动）
   * @param {object} w 控件数据
   * @param {object} api { get, set, blockReason, allowed, refresh, editNumber }
   */
  attach(el, w, api) {
    el.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const row = t.closest('tr[data-paramrow]');
      if (!row) return;                                   // 表头 / 表格外
      if (row.classList.contains('pt-ro')) return;        // 只读行：点了不开键盘
      const name = row.getAttribute('data-paramvar') || '';
      if (!name) return;                                  // 空行（未绑定变量）
      if (!api.allowed()) return;                         // 权限 / 条件闸
      api.editNumber(name, row);                          // 数值 → 数字键盘；string → 文字键盘
    });
  },
});
