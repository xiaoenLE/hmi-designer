/**
 * clock.js — 时钟 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 时钟（当前时间，格式自定义） */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { fmtTime, TIME_PRESETS } from '../../core/utils.js';
import { pickTimeFmt } from '../shared.js';

register({
  type: 'clock',
  title: '时钟',
  sub: '当前时间（年月日时分秒）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><circle cx="18" cy="18" r="12" fill="#fff" stroke="#2563eb" stroke-width="1.6"/><path d="M18 11v7l4.5 3" stroke="#2563eb" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
  defaults: {
    w: 190, h: 34,
    timeFmt: 'YYYY-MM-DD hh:mm:ss', timeFmtCustom: 'YYYY-MM-DD hh:mm:ss',
    prefix: '', suffix: '',
    fontSize: 16, textColor: '#1f2329', bold: false, align: 'left',
    bgColor: '', borderColor: '#c3cbd6', borderWidth: 0, radius: 4,
  },
  props: [
    { key: 'timeFmt', label: '时间格式', type: 'select', options: TIME_PRESETS,
      hint: '预设不够用就选「自定义…」，在下面那行填' },
    { key: 'timeFmtCustom', label: '自定义格式', type: 'text',
      hint: 'YYYY 年 MM 月 DD 日 hh 时 mm 分 ss 秒 SSS 毫秒（如 YYYY年MM月DD日 hh:mm:ss）' },
    { key: 'prefix', label: '前缀', type: 'text', hint: '显示在时间前面的文字，如「当前时间：」' },
    { key: 'suffix', label: '后缀', type: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 96 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bold', label: '加粗', type: 'check' },
    { key: 'align', label: '对齐', type: 'select', options: [{ v: 'left', t: '左' }, { v: 'center', t: '中' }, { v: 'right', t: '右' }] },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  binding: null,
  actions: [],
  render(w) {
    const p = w.props;
    const fmt = pickTimeFmt(p, 'YYYY-MM-DD hh:mm:ss');
    const align = p.align === 'center' ? 'center' : p.align === 'right' ? 'flex-end' : 'flex-start';
    const bg = p.bgColor ? `background:${p.bgColor};` : '';
    const bd = +p.borderWidth > 0 ? `border:${+p.borderWidth}px solid ${p.borderColor || 'transparent'};` : '';
    // data-clock-fmt：由 widgets/clock.js 的定时器统一刷新文字（毫秒格式会自动加快到 100ms 一拍）
    return `<div class="w-clock" style="font-size:${p.fontSize}px;color:${p.textColor};font-weight:${p.bold ? 700 : 400};justify-content:${align};${bg}${bd}border-radius:${p.radius}px"><span class="wc-pre">${escapeHtml(p.prefix || '')}</span><span class="wc-time" data-clock-fmt="${escapeHtml(fmt)}">${escapeHtml(fmtTime(Date.now(), fmt))}</span><span class="wc-suf">${escapeHtml(p.suffix || '')}</span></div>`;
  },
});
