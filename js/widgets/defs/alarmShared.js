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
import { escapeHtml } from '../../core/utils.js';
import { pickTimeFmt } from '../shared.js';
import { setExtraHelpers } from '../pack.js';

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
export const LEVEL_RANK = { info: 0, warn: 1, alarm: 2, urgent: 3 };
/** 按「最低级别」过滤：warn → 只看 warn/alarm/urgent */
export function filterByLevel(list, filter) {
  const min = LEVEL_RANK[filter];
  if (min === undefined) return list;
  return list.filter(a => (LEVEL_RANK[a.level] ?? 2) >= min);
}
/** 最严重的一条（同级取最早发生的） */
export function worstOf(list) {
  if (!list.length) return null;
  return list.slice().sort((a, b) =>
    (LEVEL_RANK[b.level] ?? 2) - (LEVEL_RANK[a.level] ?? 2) || a.at - b.at)[0];
}
export const DEMO_ACTIVE = [
  { key: 'd1', text: '主轴转速过高：3120 m/min（上限 3000）', level: 'alarm', at: Date.now() - 42000 },
  { key: 'd2', text: '液压油温偏高：62 ℃', level: 'warn', at: Date.now() - 9000 },
];
/** 「当前报警」列表最多画多少行（同时报警上千条时，整块 DOM 重建会拖低帧率） */
export const LIST_MAX = 200;
export const DEMO_HISTORY = [
  ...DEMO_ACTIVE.map(x => ({ ...x, endAt: Date.now() - 3000, acked: true })),
  { key: 'd3', text: '急停按钮被按下', level: 'urgent', at: Date.now() - 3600e3, endAt: Date.now() - 3500e3, acked: true },
];

/* 把报警类 helper 补进「控件包」的 render 白名单（见 js/widgets/pack.js）：
   别人导进来的自定义报警控件，render 里才能用 activeAlarms / levelOf 这些。
   ⚠ 只能这样"注入"，不能在 pack.js 里直接 import —— project.js → pack.js → alarms.js → project.js 会绕成环。 */
setExtraHelpers({ activeAlarms, alarmHistory, historyOfDay, alarmHistoryDay, levelOf, esc });
