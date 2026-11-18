/**
 * table.js — 表格 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 表格（纯画格子：行列 + 表头 + 单元格文字） */
import { register, rutil } from '../registry.js';
const { fmtValue, escapeHtml } = rutil;
import { ARR_TYPES, SCALAR_NUM, splitLines, splitRow } from '../shared.js';

register({
  type: 'table',
  title: '表格',
  sub: '画表格 / 排文字',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="7" width="28" height="22" rx="2" fill="#fff" stroke="#94a3b8"/><path d="M4 14h28M4 21h28M14 7v22M24 7v22" stroke="#c3cbd6" stroke-width="1.4"/><rect x="4" y="7" width="28" height="7" fill="#eef2f7"/></svg>',
  defaults: {
    w: 300, h: 120,
    cols: 3, rows: 3,                 // 列数 / 行数（不含表头）
    header: true,                     // 是否画表头行
    headers: '列1,列2,列3',            // 表头文字，逗号分列
    cells: '',                        // 单元格文字：一行一行写，逗号分列
    rowH: 24, fontSize: 13, align: 'left',
    textColor: '#1f2329', headerBg: '#eef2f7', headerColor: '#1f2329',
    bgColor: '#ffffff', borderColor: '#c3cbd6', borderWidth: 1, radius: 4, zebra: true,
    arrFill: false,                   // 数组填充：绑一个数组变量，逐格填进表格
    arrStart: 0,                      // 从第几个元素开始填（0 起）
    arrFmt: '',                       // 元素显示格式（空=原样；%d / %.2f 这种）
  },
  props: [
    { key: 'cols', label: '列数', type: 'number', min: 1, max: 12 },
    { key: 'rows', label: '行数', type: 'number', min: 1, max: 30 },
    { key: 'header', label: '画表头', type: 'check', defVal: true },
    { key: 'headers', label: '表头文字', type: 'text', hint: '逗号分列，例如 参数,数值,单位' },
    // 数组填充：绑上数组变量后，格子按「一行一行」的顺序从数组里取值
    //   （先填满第一行的每一列，再第二行）—— 一行 3 列填 13 个元素，就是 5 行 3 列
    { key: 'arrFill', label: '数组填充', type: 'check', defVal: false,
      hint: '绑一个数组变量（int[]/real[]…），把元素按行列顺序填进格子；不够的格子用「单元格文字」补' },
    { key: 'arrStart', label: '起始元素', type: 'number', min: 0, max: 4095, defVal: 0,
      hint: '从数组第几个元素开始填（0 起）' },
    { key: 'arrFmt', label: '元素格式', type: 'text', hint: '空=原样；可用 %d / %.1f / %.2f' },
    { key: 'cells', label: '单元格文字', type: 'textarea', rows: 6,
      hint: '一行一行写，逗号分列，写不满留空' },
    { key: 'rowH', label: '行高', type: 'number', min: 16, max: 80 },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 40 },
    { key: 'align', label: '对齐', type: 'select', options: [{ v: 'left', t: '左' }, { v: 'center', t: '居中' }, { v: 'right', t: '右' }] },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'headerBg', label: '表头底色', type: 'color' },
    { key: 'headerColor', label: '表头文字', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '线色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'zebra', label: '斑马纹', type: 'check', defVal: true },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  binding: { variable: { types: [...SCALAR_NUM, 'bool', ...ARR_TYPES],
    label: '数组变量（勾「数组填充」时用）' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props;
    const cols = Math.max(1, Math.min(12, Math.round(+p.cols || 3)));
    const rowCount = Math.max(1, Math.min(30, Math.round(+p.rows || 3)));
    const cellText = (txt) => splitRow(txt);
    const heads = cellText(p.headers);
    const lines = splitLines(p.cells);
    const cellStyle = `height:${Math.max(16, +p.rowH || 24)}px;font-size:${p.fontSize}px;`
      + `text-align:${p.align || 'left'};color:${p.textColor}`;
    const pad = (arr) => Array.from({ length: cols }, (_, i) => arr[i] ?? '');
    const headHTML = (p.header !== false)
      ? `<thead><tr>${pad(heads).map(t =>
        `<td class="th" style="${cellStyle}">${escapeHtml(t)}</td>`).join('')}</tr></thead>`
      : '';
    // 数组填充：把数组元素按行填进格子（第 0 行从左到右，然后第 1 行…）
    //   —— 一行 3 列 × 5 行正好摆 13 个元素；比一个个摆数值控件省事得多
    let fill = null;
    if (p.arrFill && w.bindings?.variable) {
      const v = vars?.get ? vars.get(w.bindings.variable) : undefined;
      if (Array.isArray(v)) fill = v;
    }
    const cellVal = (r, c) => {
      const idx = (r * cols + c) - 0;
      const start = Math.max(0, Math.round(+p.arrStart || 0));
      const pos = start + idx;
      if (fill && pos < fill.length) {
        const elem = fill[pos];
        return p.arrFmt ? fmtValue(elem, p.arrFmt) : fmtValue(elem, '');
      }
      return cellText(lines[r] ?? '')[c] ?? '';
    };
    const bodyHTML = Array.from({ length: rowCount }, (_, r) => {
      const cls = (p.zebra !== false && r % 2) ? ' class="zebra"' : '';
      return `<tr${cls}>${Array.from({ length: cols }, (_, c) =>
        `<td style="${cellStyle}">${escapeHtml(cellVal(r, c))}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="w-table" style="background:${p.bgColor || 'transparent'};
      border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};border-radius:${p.radius}px;
      --wt-head-bg:${p.headerBg};--wt-head-fg:${p.headerColor};--wt-line:${p.borderColor}">
      <colgroup>${Array.from({ length: cols }, () => '<col>').join('')}</colgroup>
      ${headHTML}<tbody>${bodyHTML}</tbody></table>`;
  },
});
