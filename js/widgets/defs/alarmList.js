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
import { alarmRuntime, alarmTimeFmt, DEMO_ACTIVE, LIST_MAX, esc, editSampleActive } from './alarmShared.js';
import { tr } from '../../core/i18n.js';

register({
  type: 'alarmList',
  title: '当前报警',
  sub: '正在发生的报警（表格）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="6" width="28" height="24" rx="2" fill="#fff" stroke="#94a3b8"/><rect x="4" y="6" width="28" height="7" fill="#fee2e2"/><circle cx="9" cy="19" r="2" fill="#ef4444"/><path d="M13 19h14M9 25h14" stroke="#c3cbd6" stroke-width="1.6"/></svg>',
  defaults: {
    w: 420, h: 150,
    maxRows: 5, showHeader: true, showTime: true, timeFmt: 'hh:mm:ss', timeFmtCustom: 'hh:mm:ss.SSS',
    showAck: true, ackText: '确认', emptyText: '当前无报警',
    sound: false,                  // 有新报警触发时响两声（哪一页放了勾「报警声」的报警控件才响）
    jumpPage: '',                  // 点一行跳到哪个页面（页面名或 id，留空 = 不跳）
    rowH: 26, fontSize: 13, align: 'left', zebra: true,
    textColor: '#1f2329', bgColor: '#ffffff', headerBg: '#fee2e2', headerColor: '#1f2329',
    borderColor: '#c3cbd6', borderWidth: 1, radius: 4,
  },
  props: [
    { key: 'maxRows', label: '显示条数', type: 'number', min: 1, max: 50 },
    { key: 'showHeader', label: '显示表头', type: 'check', defVal: true },
    { key: 'showTime', label: '显示时间列', type: 'check', defVal: true },
    { key: 'timeFmt', label: '时间格式', type: 'select', options: TIME_PRESETS },
    { key: 'timeFmtCustom', label: '自定义格式', type: 'text' },
    { key: 'showAck', label: '可确认', type: 'check', defVal: true },
    { key: 'ackText', label: '确认按钮文字', type: 'text', i18n: 'text' },
    { key: 'emptyText', label: '无报警时', type: 'text', i18n: 'text' },
    { key: 'sound', label: '报警声', type: 'check', defVal: false },
    { key: 'jumpPage', label: '点行跳转', type: 'text' },
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
    const rows = (mode === 'edit' && !list.length) ? editSampleActive() : list;
    const fmt = alarmTimeFmt(p);
    const cellH = Math.max(16, +p.rowH || 26);
    const jumpRef = String(p.jumpPage || '').trim();   // 点一行跳到哪页（留空 = 行不可点）
    const cell = (txt, style = '') => `<td style="height:${cellH}px;${style}">${txt}</td>`;
    const cols = [tr('级别'), ...(p.showTime !== false ? [tr('时间')] : []), tr('报警内容'), ...(p.showAck !== false ? [''] : [])];
    const head = p.showHeader === false ? '' : `<thead><tr>${cols.map(c =>
      `<td class="th" style="height:${cellH}px">${c}</td>`).join('')}</tr></thead>`;
    // ⚠ 同时在报警的条数可能上千（2000 条时整块重建要 31ms，帧率直接掉到 50fps 以下，实测）：
    //   面板本来只看得到 maxRows 行（其余靠滚动），所以最多画 LIST_MAX 行，多出来的写一行提示。
    const shown = rows.slice(0, LIST_MAX);
    const rest = rows.length - shown.length;
    const body = shown.length ? shown.map((a, i) => {
      const lv = levelOf(a.level);
      // 行上带报警 key（运行态 attach 靠它认出"点的是某一条报警"）；能点跳页时给个手型
      const cls = [p.zebra !== false && i % 2 ? 'zebra' : '', jumpRef ? 'jumpable' : ''].filter(Boolean).join(' ');
      const rowStyle = jumpRef ? ' style="cursor:pointer"' : '';
      return `<tr data-alarm="${esc(String(a.key || ''))}"${cls ? ` class="${cls}"` : ''}${rowStyle}>
        ${cell(`<span style="color:${lv.color};font-weight:600">${escapeHtml(tr(lv.t))}</span>`)}
        ${p.showTime !== false ? cell(escapeHtml(fmtTime(a.at, fmt)), 'color:#6b7280;white-space:nowrap') : ''}
        ${cell(`<span title="${escapeHtml(a.text)}">${escapeHtml(a.text)}</span>`)}
        ${p.showAck !== false ? cell(a.acked
          ? `<span style="color:#6b7280;font-size:.85em">${escapeHtml(tr('已确认'))}</span>`
          : (mode === 'edit' ? '' : `<button class="al-ack" type="button" data-ackbtn="${esc(a.key)}" style="color:${lv.color};border-color:${lv.color}">${escapeHtml(tr(p.ackText || '确认'))}</button>`))
          : ''}
      </tr>`;
    }).join('') + (rest > 0
      ? `<tr><td class="almore" colspan="${cols.length}" style="height:${cellH}px">…还有 ${rest} 条报警（同时发生的太多，只列前 ${LIST_MAX} 条）</td></tr>`
      : '') : `<tr><td class="alempty" colspan="${cols.length}" style="height:${cellH}px">${escapeHtml(tr(p.emptyText || '当前无报警'))}</td></tr>`;
    return `<div class="w-alarmtbl" style="--at-line:${p.borderColor};--at-head:${p.headerBg};--at-headfg:${p.headerColor};
        font-size:${p.fontSize}px;color:${p.textColor};background:${p.bgColor};
        border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};border-radius:${p.radius}px">
      <div class="at-scroll" style="max-height:${Math.max(1, +p.maxRows || 5) * cellH + (head ? cellH : 0)}px">
        <table class="w-table at-table">${head}<tbody>${body}</tbody></table></div></div>`;
  },
  // 运行态：点一行 → 跳到「点行跳转」里配的页面（页面名或 id 都认）。
  // ⚠ 绑在 el（.wd 根）上用委托，refreshWidgetBody 只重建里面的 .body，绑子元素会丢。
  // ⚠ 「确认」按钮（data-ackbtn）有自己的事（runtime 的点击分发负责 ack），点它不跳页。
  attach(el, w, api) {
    el.addEventListener('click', (e) => {
      if (!api || typeof api.gotoPage !== 'function') return;
      const p = w.props || {};
      const ref = String(p.jumpPage || '').trim();
      if (!ref) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('[data-ackbtn]')) return;                 // 确认按钮：别顺手跳页
      const row = t.closest('tr[data-alarm]');
      if (!row) return;                                       // 表头 / 无报警占位行 / 「还有 N 条」提示行不跳
      api.gotoPage(ref);
    });
  },
});
