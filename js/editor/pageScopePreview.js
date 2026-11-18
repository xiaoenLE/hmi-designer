/**
 * pageScopePreview.js — 编辑器里预览「这一页运行时会采哪些变量」
 *
 * 口径与运行态 `runtime.js` 的 pageVarScope() **完全一致**（这里只出名单，避免两处算法打架）：
 *   · 本页控件（含套用的公共底）
 *   · **所有页面的波形通道**（波形跨页面一直采，切走不能断）
 *   · **报警条件里的变量**（不在采集范围里报警永远不会触发）
 * 拿到的名单交给后端 `/api/vars/declare` 的 active 字段，后端会按地址合并算出「几块」——
 * 所以状态栏能显示「该页 N 变量/M 块」，跟运行态看到的数字是同一套算法。
 *
 * ⚠ 这只是**预览**：后端没人在运行态时根本不读设备（见 server/poll_gate.py），
 *   下发采集范围只是让后端算个数，不产生任何设备通讯。
 */
import { project } from '../core/project.js';

/** 一个控件用到哪些变量（绑定 / 多通道绑定 / 波形通道键 / 动作变量） */
function addWidgetVars(w, names) {
  if (!w) return;
  const b = w.bindings || {};
  if (b.variable) names.add(b.variable);
  (b.variables || []).forEach(n => n && names.add(n));
  Object.keys(w.props?.colors || {}).forEach(n => n && names.add(n));
  Object.keys(w.props?.scales || {}).forEach(n => n && names.add(n));
  (w.actions || []).forEach(a => { if (a.params?.variable) names.add(a.params.variable); });
}

/** 这一页（含它套用的公共底）用到的变量名 */
function addPageVars(pageId, names) {
  const pg = project.getPage(pageId);
  if (!pg) return;
  (pg.widgets || []).forEach(w => addWidgetVars(w, names));
  const base = pg.base ? project.getPage(pg.base) : null;
  if (base) (base.widgets || []).forEach(w => addWidgetVars(w, names));
}

/** 当前页运行时的采集范围（变量名数组，只保留变量表里有的） */
export function editorPageVarNames(pageId) {
  const names = new Set();
  addPageVars(pageId, names);
  // 波形通道：所有页面的波形都一直在采（和运行态一致）
  project.pages().forEach(p => (p.widgets || []).forEach(w => {
    if (w.type === 'trend') addWidgetVars(w, names);
  }));
  // 报警条件变量：不采它，报警在别的页面上就不会触发
  project.alarms().forEach(a => { if (a.enabled !== false && a.variable) names.add(a.variable); });
  const known = new Set(project.variables().map(v => v.name));
  return [...names].filter(n => known.has(n));
}
