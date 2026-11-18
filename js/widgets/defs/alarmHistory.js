/**
 * alarmHistory.js — 报警历史 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 报警历史：表格 + 按天翻看（级别 / 时间 / 内容 / 恢复时间） */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { fmtTime, fmtDate, dayStart, TIME_PRESETS } from '../../core/utils.js';
import { alarmHistory, levelOf } from '../../runtime/alarms.js';
import { alarmRuntime, alarmTimeFmt, DEMO_HISTORY, HIST_MAX, esc } from './alarmShared.js';

register({
  type: 'alarmHistory',
  title: '报警历史',
  sub: '按天查看报警记录（表格）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="6" width="28" height="24" rx="2" fill="#fff" stroke="#94a3b8"/><rect x="4" y="6" width="28" height="7" fill="#e2e8f0"/><path d="M9 18h6M9 24h10M20 18h7" stroke="#c3cbd6" stroke-width="1.6"/><circle cx="29" cy="24" r="4" fill="#94a3b8"/><path d="M27.4 24H29v-2" stroke="#fff" stroke-width="1.4" fill="none"/></svg>',
  defaults: {
    w: 460, h: 190,
    maxRows: 6, showHeader: true, dayNav: true, showTime: true,
    timeFmt: 'MM-DD hh:mm:ss', timeFmtCustom: 'hh:mm:ss.SSS',
    showEnd: true, clearable: true, clearText: '清空记录', todayText: '今天',
    emptyText: '这一天没有报警记录',
    rowH: 26, fontSize: 13, zebra: true,
    textColor: '#1f2329', bgColor: '#ffffff', headerBg: '#e2e8f0', headerColor: '#1f2329',
    borderColor: '#c3cbd6', borderWidth: 1, radius: 4,
  },
  props: [
    { key: 'dayNav', label: '按天翻看', type: 'check', defVal: true, hint: '带前后一天按钮和日期框，运行时切到哪一天就看哪天' },
    { key: 'maxRows', label: '显示条数', type: 'number', min: 1, max: 50 },
    { key: 'showHeader', label: '显示表头', type: 'check', defVal: true },
    { key: 'showTime', label: '显示时间列', type: 'check', defVal: true },
    { key: 'timeFmt', label: '时间格式', type: 'select', options: TIME_PRESETS,
      hint: '要精确到毫秒就选带 .毫秒 的，或选「自定义」自己拼' },
    { key: 'timeFmtCustom', label: '自定义格式', type: 'text',
      hint: 'YYYY 年 MM 月 DD 日 hh 时 mm 分 ss 秒 SSS 毫秒' },
    { key: 'showEnd', label: '显示恢复时间', type: 'check', defVal: true },
    { key: 'clearable', label: '可清空', type: 'check', defVal: true, hint: '只清历史，不影响当前报警' },
    { key: 'clearText', label: '清空按钮文字', type: 'text' },
    { key: 'todayText', label: '今天按钮文字', type: 'text' },
    { key: 'emptyText', label: '无记录时', type: 'text' },
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
    const day = rt.historyDay(w.id);                     // 运行时正在看哪一天（0 = 今天）
    const isToday = dayStart(day) === dayStart();
    const all = rt.historyOfDay(day);
    const rows = (mode === 'edit' && !all.length ? DEMO_HISTORY : all).slice().reverse();   // 最新在上
    const fmt = alarmTimeFmt(p);
    const cellH = Math.max(16, +p.rowH || 26);
    const cell = (txt, style = '') => `<td style="height:${cellH}px;${style}">${txt}</td>`;
    const cols = ['级别', ...(p.showTime !== false ? ['时间'] : []), '报警内容', ...(p.showEnd !== false ? ['恢复'] : [])];
    const head = p.showHeader === false ? '' : `<thead><tr>${cols.map(c =>
      `<td class="th" style="height:${cellH}px">${c}</td>`).join('')}</tr></thead>`;
    // ⚠ 行数上限（见 alarmShared.js 的 HIST_MAX）：一天几万条记录不能全建成 DOM ——
    //   滚动区只看得到 maxRows 行，多画的行除了拖慢每一次重绘没有任何用。
    const shown = rows.slice(0, HIST_MAX);
    const rest = rows.length - shown.length;
    const body = shown.length ? shown.map((a, i) => {
      const lv = levelOf(a.level);
      const cls = (p.zebra !== false && i % 2) ? ' class="zebra"' : '';
      return `<tr${cls}>
        ${cell(`<span style="color:${lv.color};font-weight:600">${escapeHtml(lv.t)}</span>`)}
        ${p.showTime !== false ? cell(escapeHtml(fmtTime(a.at, fmt)), 'color:#6b7280;white-space:nowrap') : ''}
        ${cell(`<span title="${escapeHtml(a.text)}">${escapeHtml(a.text)}</span>`)}
        ${p.showEnd !== false ? cell(a.endAt
          ? escapeHtml(fmtTime(a.endAt, fmt))
          : '<span style="color:#ef4444">未恢复</span>', 'color:#6b7280;white-space:nowrap') : ''}
      </tr>`;
    }).join('') + (rest > 0
      ? `<tr><td class="almore" colspan="${cols.length}" style="height:${cellH}px">…这一天还有 ${rest} 条更早的记录（只列最新 ${HIST_MAX} 条）</td></tr>`
      : '') : `<tr><td class="alempty" colspan="${cols.length}" style="height:${cellH}px">${escapeHtml(p.emptyText || '这一天没有报警记录')}</td></tr>`;
    // 日期切换条（编辑态只显示、不可点）
    const nav = p.dayNav === false ? '' : `
      <div class="at-nav">
        <button class="at-btn" type="button" data-alarmday="prev" ${mode === 'edit' ? 'disabled' : ''} title="前一天">‹</button>
        <input class="at-date" type="date" data-alarmdate="${esc(w.id)}" value="${fmtDate(day)}"
          ${mode === 'edit' ? 'disabled' : ''} title="选任意一天">
        <button class="at-btn" type="button" data-alarmday="next" ${mode === 'edit' ? 'disabled' : ''} title="后一天">›</button>
        <button class="at-btn at-today${isToday ? ' on' : ''}" type="button" data-alarmday="today"
          ${mode === 'edit' ? 'disabled' : ''}>${escapeHtml(p.todayText || '今天')}</button>
        <span class="at-count">${rows.length} 条</span>
        ${p.clearable !== false && mode !== 'edit'
          ? `<button class="at-btn at-clear" type="button" data-alarmclear="1">${escapeHtml(p.clearText || '清空记录')}</button>` : ''}
      </div>`;
    return `<div class="w-alarmtbl hist" style="--at-line:${p.borderColor};--at-head:${p.headerBg};--at-headfg:${p.headerColor};
        font-size:${p.fontSize}px;color:${p.textColor};background:${p.bgColor};
        border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};border-radius:${p.radius}px">
      ${nav}
      <div class="at-scroll" style="max-height:${Math.max(1, +p.maxRows || 6) * cellH + (head ? cellH : 0)}px">
        <table class="w-table at-table">${head}<tbody>${body}</tbody></table></div></div>`;
  },
});
