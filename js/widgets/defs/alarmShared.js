/**
 * alarmShared.js — 三个报警控件（报警条 / 当前报警 / 报警历史）共用的取数与排版 helper
 *
 * 拆文件之前它们堆在 defs.js 的「报警控件」小节里，只有这三个控件用，
 * 所以整体搬过来，不放进 shared.js（免得别的控件也被迫拖着这份依赖）。
 *
 * 报警控件（报警条 / 当前报警 / 报警历史）
 * 三个都从运行态报警引擎取数据（js/runtime/alarms.js）。
 * 编辑态没有运行数据 → 显示示例内容，方便调样式。
 */
import { activeAlarms, alarmHistory, historyOfDay, alarmHistoryDay, levelOf } from '../../runtime/alarms.js';
import { alarmLevelMatcher } from '../../core/alarmLevels.js';
import { escapeHtml } from '../../core/utils.js';
import { pickTimeFmt } from '../shared.js';
import { setExtraHelpers } from '../pack.js';
import { tr } from '../../core/i18n.js';

export const alarmRuntime = () => ({
  active: activeAlarms,
  history: alarmHistory,
  historyOfDay,                                  // 某一天的记录（报警历史翻页用）
  historyDay: (id) => alarmHistoryDay(id),       // 运行态正在看哪一天（默认今天）
});
export const esc = escapeHtml;
export function alarmTimeFmt(p) {
  return pickTimeFmt(p, 'hh:mm:ss', 'hh:mm:ss.SSS');
}
export const alarmLevelFilterProp = {
  key: 'levelFilter', label: '显示级别', type: 'alarmLevels', defVal: 'all',
};

export function filterByLevel(list, filter) {
  if (!filter || filter === 'all') return list;
  const match = alarmLevelMatcher(filter);
  return list.filter(a => match(levelOf(a.level)));
}
/** 编辑态预览/示例统一用**固定时间**：不随真实时间变，控件库基线（verify-widget-split）才稳定 */
const DEMO_T0 = 1750000000000;   // 2025-06-15 前后（只用于预览占位）
const DEMO_ACTIVE = [
  { key: 'd1', text: '主轴转速过高：3120 m/min（上限 3000）', level: 'alarm', at: DEMO_T0 - 42000 },
  { key: 'd2', text: '液压油温偏高：62 ℃', level: 'warn', at: DEMO_T0 - 9000 },
];

/** 编辑态预览行：**优先用工程里真实的报警定义**（按当前语言翻好，多语言切了画布跟着变）；
 *  工程里一条报警都没配时，退回示例内容（方便调样式）。
 *  ⚠ 示例内容是写死的，翻译表里没有它们 —— 所以有真实报警时一定要用真实定义，
 *    否则"切了英文画布还是中文"就出在这儿。 */
export function editSampleActive(filter) {
  const proj = (typeof globalThis !== 'undefined' && globalThis.app) ? globalThis.app.project : null;
  const list = (proj && typeof proj.alarms === 'function') ? (proj.alarms() || []) : [];
  if (!list.length) return filterByLevel(DEMO_ACTIVE, filter);
  const now = DEMO_T0;
  return filterByLevel(list, filter).slice(0, 6).map((a, i) => ({
    key: a.id || ('e' + i),
    name: tr(a.name || ''),
    text: tr(a.text || a.name || ''),
    level: a.level || 'alarm',
    at: now - i * 61e3,
    acked: false,
  }));
}
/** 编辑态预览「报警历史」行（真实报警 + 恢复时间） */
export function editSampleHistory(filter) {
  const now = DEMO_T0;
  return editSampleActive(filter).map((r, i) => ({ ...r, at: now - (i + 1) * 3600e3, endAt: now - (i + 1) * 3540e3, acked: true }));
}
/** 「当前报警」列表最多画多少行（同时报警上千条时，整块 DOM 重建会拖低帧率） */
export const LIST_MAX = 200;
/** 「报警历史」一天最多画多少行。
 *
 *  ⚠ 报警历史才是现场真正会涨到几万条的那一份（历史文件按 5MB 封顶，实测一天能到 3 万多条）。
 *    以前这个控件**没有行数上限** —— `maxRows` 只拿来算滚动区的高度（CSS max-height），
 *    表格却仍给当天的每一条记录建一个 `<tr>`。于是每天都比昨天更慢一点：
 *    `alarms:changed` 一来就重建全部行，3 万行 = 3 万次 fmtTime + escapeHtml + 3 万次 DOM 插入，
 *    这正是"跑几天以后越来越卡"的主因（旁边那个「当前报警」控件早就用 LIST_MAX 挡过同一件事，
 *    历史这一份当时漏了）。
 *    滚动区本来就只看得到 maxRows 行，所以最多画 HIST_MAX 行、剩下的写一行提示 ——
 *    800 行足够操作工往回翻，按钮上/翻页条上的"共 N 条"仍然报的是真实总数。 */
export const HIST_MAX = 800;

/* 把报警类 helper 补进「控件包」的 render 白名单（见 js/widgets/pack.js）：
   别人导进来的自定义报警控件，render 里才能用 activeAlarms / levelOf 这些。
   ⚠ 只能这样"注入"，不能在 pack.js 里直接 import —— project.js → pack.js → alarms.js → project.js 会绕成环。 */
setExtraHelpers({ activeAlarms, alarmHistory, historyOfDay, alarmHistoryDay, levelOf, esc });
