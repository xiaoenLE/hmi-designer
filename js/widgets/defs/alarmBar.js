/**
 * alarmBar.js — 报警条 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 报警条：多条报警拼成一串，在里面一直滚（跑马灯） */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { fmtTime } from '../../core/utils.js';
import { compareAlarmPriority, levelOf } from '../../runtime/alarms.js';
import { alarmRuntime, alarmLevelFilterProp, filterByLevel, editSampleActive } from './alarmShared.js';
import { tr } from '../../core/i18n.js';

register({
  type: 'alarmBar',
  title: '报警条',
  sub: '多条报警拼一串，持续滚动',
  preserveBody: true,             // 报警文字没变时保留当前滚动进度
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="3" y="12" width="30" height="12" rx="3" fill="#ef4444"/><path d="M8 18h3M13 18h12" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="29" cy="18" r="2.4" fill="#fff"/></svg>',
  defaults: {
    w: 420, h: 38,
    levelFilter: 'all',
    joinAll: true,                 // 所有报警拼成一串（不勾 = 只显示最严重那条 + 还有 N 条）
    sepText: '●',
    showIcon: true, showTime: true, blink: true, scroll: true, speed: 40,
    hideWhenNone: true,            // 没报警时整条隐藏（勾掉就显示下面那句）
    noAlarmText: '无报警', fontSize: 15,
    sound: false,                  // 有新报警触发时响两声（哪一页放了勾「报警声」的报警控件才响）
    clickJump: '',                 // 点这条报警条跳到哪个页面（页面名或 id，留空 = 不跳）
    bgColor: '#ef4444', textColor: '#ffffff', borderColor: '', borderWidth: 0, radius: 4,
  },
  props: [
    alarmLevelFilterProp,
    { key: 'joinAll', label: '拼接全部', type: 'check', defVal: true },
    { key: 'sepText', label: '分隔符', type: 'text' },
    { key: 'hideWhenNone', label: '无报警时隐藏', type: 'check', defVal: true },
    { key: 'noAlarmText', label: '无报警时', type: 'text', i18n: 'text' },
    { key: 'sound', label: '报警声', type: 'check', defVal: false },
    { key: 'clickJump', label: '点条跳转', type: 'text' },
    { key: 'showIcon', label: '显示图标', type: 'check', defVal: true },
    { key: 'showTime', label: '显示时间', type: 'check', defVal: true },
    { key: 'blink', label: '闪烁', type: 'check', defVal: true },
    { key: 'scroll', label: '持续滚动', type: 'check', defVal: true },
    { key: 'speed', label: '滚动速度', type: 'number', min: 10, max: 200 },
    { key: 'fontSize', label: '字号', type: 'number', min: 10, max: 40 },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
  ],
  binding: {}, actions: [],
  render(w, mode) {
    const p = w.props;
    const rt = alarmRuntime();
    const list = filterByLevel(rt.active(), p.levelFilter);
    // 编辑态没真报警就拿示例顶上（不然画布上什么都看不到，没法调位置）；
    // 工程里有真实报警时用真实定义（已按当前语言翻好）→ 切语言时画布也跟着变
    const items = mode === 'edit' && !list.length
      ? editSampleActive(p.levelFilter).slice(0, 2) : list.slice().sort(compareAlarmPriority);
    const empty = !items.length;
    if (empty && mode !== 'edit' && p.hideWhenNone !== false) return '';
    const lv = levelOf(items[0]?.level);
    const jumpRef = String(p.clickJump || '').trim();   // 点整条跳到哪页（留空 = 不可点）
    // ⚠ 「透明」按钮是把颜色清空（全工程一个约定：空 = 透明，见 verify-btn-transparent）。
    //   这里以前写 `p.bgColor || lv.color` —— 清了颜色就回落到**报警级别色（红）**，
    //   于是「设成透明反而变红」。只有老工程里压根没有这个键时才用级别色兜底。
    const bg = (p.bgColor === undefined || p.bgColor === null) ? lv.color : (p.bgColor || 'transparent');
    const barStyle = `--ab-bg:${bg};--ab-fg:${p.textColor || '#fff'};font-size:${p.fontSize}px;
        border:${p.borderWidth}px solid ${p.borderColor || 'transparent'};border-radius:${p.radius}px`;
    const blink = (!empty && p.blink !== false && lv.rank > 0) ? ' blink' : '';
    const icon = p.showIcon === false ? '' : `<span class="ab-ico">${empty ? '✔' : '⚠'}</span>`;

    const one = (item) => `${p.showTime !== false ? `[${fmtTime(item.at, 'hh:mm:ss')}] ` : ''}${item.text}`;
    // 拼接全部：几条报警连成一串一起滚；不勾就只显示最严重那条 + 「还有 N 条」
    let text;
    if (empty) text = tr(p.noAlarmText || '无报警');
    else if (p.joinAll === false) text = one(items[0]) + (items.length > 1 ? `　（还有 ${items.length - 1} 条）` : '');
    else text = items.map(one).join(`　${p.sepText || '●'}　`);

    const speed = p.scroll === false ? 0 : Math.max(10, +p.speed || 40);
    return `<div class="w-alarmbar${empty ? ' empty' : ''}${blink}"
      data-ab-speed="${speed}" style="${barStyle}${!empty && jumpRef ? ';cursor:pointer' : ''}">
      ${icon}
      <span class="ab-view"><span class="ab-reel">
        <span class="ab-copy">${escapeHtml(text)}</span>
      </span></span>
    </div>`;
  },
  // 运行态：点整条报警条 → 跳到「点条跳转」里配的页面（页面名或 id 都认）。
  // ⚠ 绑在 el（.wd 根）上用委托；「无报警」占位条（.empty）不跳。
  attach(el, w, api) {
    el.addEventListener('click', (e) => {
      if (!api || typeof api.gotoPage !== 'function') return;
      const p = w.props || {};
      const ref = String(p.clickJump || '').trim();
      if (!ref) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      const bar = t.closest('.w-alarmbar');
      if (!bar) return;
      if (bar.classList.contains('empty')) return;
      api.gotoPage(ref);
    });
  },
});
