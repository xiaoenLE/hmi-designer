/**
 * alarmList.js — 当前报警 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 当前报警：表格（级别 / 时间 / 内容 / 确认） */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { fmtTime, TIME_PRESETS } from '../../core/utils.js';
import { levelOf } from '../../runtime/alarms.js';
import { alarmRuntime, alarmTimeFmt, DEMO_ACTIVE, LIST_MAX, esc } from './alarmShared.js';

register({
  type: 'alarmList',
  title: '当前报警',
  sub: '正在发生的报警（表格）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="6" width="28" height="24" rx="2" fill="#fff" stroke="#94a3b8"/><rect x="4" y="6" width="28" height="7" fill="#fee2e2"/><circle cx="9" cy="19" r="2" fill="#ef4444"/><path d="M13 19h14M9 25h14" stroke="#c3cbd6" stroke-width="1.6"/></svg>',
  defaults: {
    w: 420, h: 150,
    maxRows: 5, showHeader: true, showTime: true, timeFmt: 'hh:mm:ss', timeFmtCustom: 'hh:mm:ss.SSS',
    showAck: true, ackText: '确认', emptyText: '当前无报警',
    rowH: 26, fontSize: 13, align: 'left', zebra: true,
    textColor: '#1f2329', bgColor: '#ffffff', headerBg: '#fee2e2', headerColor: '#1f2329',
    borderColor: '#c3cbd6', borderWidth: 1, radius: 4,
  },
  props: [
    { key: 'maxRows', label: '显示条数', type: 'number', min: 1, max: 50, hint: '超出的靠滚动查看' },
    { key: 'showHeader', label: '显示表头', type: 'check', defVal: true },
    { key: 'showTime', label: '显示时间列', type: 'check', defVal: true },
    { key: 'timeFmt', label: '时间格式', type: 'select', options: TIME_PRESETS,
      hint: '要精确到毫秒就选带 .毫秒 的，或选「自定义」自己拼' },
    { key: 'timeFmtCustom', label: '自定义格式', type: 'text',
      hint: 'YYYY 年 MM 月 DD 日 hh 时 mm 分 ss 秒 SSS 毫秒' },
    { key: 'showAck', label: '可确认', type: 'check', defVal: true, hint: '确认只做标记，报警恢复前仍留在列表里' },
    { key: 'ackText', label: '确认按钮文字', type: 'text' },
    { key: 'emptyText', label: '无报警时', type: 'text' },
    { key: 'rowH', label: '行高', type: 'number', min: 16, max: 80 },
    { key: 'fontSize', label: '字号', type: 'number', min: 9, max: 30 },
    { key: 'zebra', label: '斑马纹', type: 'check', defVal: true },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'headerBg', label: '表头底色', type: 'color' },
    { key: 'headerColor', label: '表头文字', type: 'color' },
    { key: 'borderColor', label: '线色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  binding: {}, actions: [],
  render(w, mode) {
    const p = w.props;
    const rt = alarmRuntime();
    const list = rt.active();
    const rows = (mode === 'edit' && !list.length) ? DEMO_ACTIVE : list;
    const fmt = alarmTimeFmt(p);
    const cellH = Math.max(16, +p.rowH || 26);
    const cell = (txt, style = '') => `<td style="height:${cellH}px;${style}">${txt}</td>`;
    const cols = ['级别', ...(p.showTime !== false ? ['时间'] : []), '报警内容', ...(p.showAck !== false ? [''] : [])];
    const head = p.showHeader === false ? '' : `<thead><tr>${cols.map(c =>
      `<td class="th" style="height:${cellH}px">${c}</td>`).join('')}</tr></thead>`;
    // ⚠ 同时在报警的条数可能上千（2000 条时整块重建要 31ms，帧率直接掉到 50fps 以下，实测）：
    //   面板本来只看得到 maxRows 行（其余靠滚动），所以最多画 LIST_MAX 行，多出来的写一行提示。
    const shown = rows.slice(0, LIST_MAX);
    const rest = rows.length - shown.length;
    const body = shown.length ? shown.map((a, i) => {
      const lv = levelOf(a.level);
      const cls = (p.zebra !== false && i % 2) ? ' class="zebra"' : '';
      return `<tr${cls}>
        ${cell(`<span style="color:${lv.color};font-weight:600">${escapeHtml(lv.t)}</span>`)}
        ${p.showTime !== false ? cell(escapeHtml(fmtTime(a.at, fmt)), 'color:#6b7280;white-space:nowrap') : ''}
        ${cell(`<span title="${escapeHtml(a.text)}">${escapeHtml(a.text)}</span>`)}
        ${p.showAck !== false ? cell(a.acked
          ? '<span style="color:#6b7280;font-size:.85em">已确认</span>'
          : (mode === 'edit' ? '' : `<button class="al-ack" type="button" data-ackbtn="${esc(a.key)}" style="color:${lv.color};border-color:${lv.color}">${escapeHtml(p.ackText || '确认')}</button>`))
          : ''}
      </tr>`;
    }).join('') + (rest > 0
      ? `<tr><td class="almore" colspan="${cols.length}" style="height:${cellH}px">…还有 ${rest} 条报警（同时发生的太多，只列前 ${LIST_MAX} 条）</td></tr>`
      : '') : `<tr><td class="alempty" colspan="${cols.length}" style="height:${cellH}px">${escapeHtml(p.emptyText || '当前无报警')}</td></tr>`;
    return `<div class="w-alarmtbl" style="--at-line:${p.borderColor};--at-head:${p.headerBg};--at-headfg:${p.headerColor};
        font-size:${p.fontSize}px;color:${p.textColor};background:${p.bgColor};
        border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};border-radius:${p.radius}px">
      <div class="at-scroll" style="max-height:${Math.max(1, +p.maxRows || 5) * cellH + (head ? cellH : 0)}px">
        <table class="w-table at-table">${head}<tbody>${body}</tbody></table></div></div>`;
  },
});
