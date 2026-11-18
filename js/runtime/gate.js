/**
 * gate.js — 控件「按条件启用」（用变量判定这个控件能不能用 / 显不显示）
 *
 * 现场要的两件事，其实是**同一套判定 + 两种"不满足"的表现**：
 *   ① 像权限锁那样锁住控件，但**开锁靠变量条件**（不是密码）：条件满足才能操作；
 *   ② 条件不满足时**整个控件不显示**（看不见的那块位置当然也点不了）。
 *
 * 组态（都存在控件 props 里，**缺键 = 不启用，老工程行为一个字不变**）：
 *   gateOn      false      是否启用这块（不勾 = 下面全部不生效）
 *   gateMode    'hide'     条件不满足时：「看不见，也点不了」/「看得见，但点不了」
 *   gateLogic   'and'      条件之间：全部满足（与）/ 任一满足（或）
 *   gateConds   []         条件表：[{ v:'变量名', op:'>=', val:'100', not:false }]
 *                          `not` = 这一条**取反**（非）：`!=` 那种写法不够用时用它
 *
 * 判定规则：
 *   · 一条条件都没有（或没勾「启用」）→ **永远满足** —— 免得"配了个空条件把控件锁死"；
 *   · 变量读不到值 → 那条**不满足**（读不到就别放行）；
 *   · 与/或按 gateLogic 合，每条各自可选"取反"。
 *
 * ⚠ 判定是**每次要用的时候现算**（不放缓存）：变量一变就重算，见 runtime.js 的 gateTick。
 * ⚠ 条件里的变量**必须在采集范围里**（collectPageVars 会把它们收进去）——
 *   不采就永远读到 undefined → 条件永远不满足 → 控件永远锁着/藏着（现场最难查的一类）。
 */
import { condMet } from '../core/utils.js';
import { varStore } from './varstore.js';

/** 这个控件开没开「按条件启用」 */
export const gateOn = (w) => w?.props?.gateOn === true;
/** 条件不满足时的表现：'hide' = 看不见也点不了（默认）/ 'lock' = 看得见但点不了 */
export const gateMode = (w) => (String(w?.props?.gateMode || '') === 'lock' ? 'lock' : 'hide');
/** 条件之间：'and'（默认，全部满足）/ 'or'（任一满足） */
export const gateLogic = (w) => (String(w?.props?.gateLogic || '') === 'or' ? 'or' : 'and');

/** 条件表（只留"填了变量名"的那些：半截行（刚点了"添加条件"还没选变量）不算条件） */
export function condsOf(w) {
  const list = w?.props?.gateConds;
  return Array.isArray(list) ? list.filter(c => c && String(c.v || '').trim()) : [];
}

/** 一条条件成立吗（`not` 取反） */
export function condHit(c) {
  const ok = condMet(varStore.get(c.v), c.op || '==', c.val);
  return c.not ? !ok : ok;
}

/**
 * 条件满足吗？没启用 / 没配条件 → true（**永远满足**）。
 * @returns {boolean}
 */
export function gateOk(w) {
  if (!gateOn(w)) return true;
  const list = condsOf(w);
  if (!list.length) return true;
  return gateLogic(w) === 'or' ? list.some(condHit) : list.every(condHit);
}

/** 这个控件占用的**条件变量**（采集范围要用：不采就是永远读不到值 → 条件永远不成立） */
export function gateVars(w) {
  return gateOn(w) ? condsOf(w).map(c => String(c.v)) : [];
}

/** 不满足时点了它，要不要弹那句提示（控件属性「按条件启用 → 弹提示」）。
 *  **默认不弹**（现场要求：点不动就是点不动，画面干净；原因看 🔒 角标的悬停提示）。
 *  只有「看得见，但点不了」这一档会弹（藏起来那档根本看不到控件）。 */
export function gateHint(w) {
  return w?.props?.gateHint === true;
}

/**
 * 给现场看的一句话：为什么这个控件现在点不动 / 看不见。
 * @returns {string} 空串 = 没被条件拦着
 */
export function gateWhy(w) {
  if (gateOk(w)) return '';
  const list = condsOf(w);
  // 值那一格**空着**时写「（空）」：数值条件（≥ > ≤ <）空值永远不成立，
  // 直接印成 `b急停 ≥ ）` 现场看不懂是哪儿没填（截图就是这么反馈上来的）
  const shown = list.slice(0, 3).map(c => {
    const raw = c.val;
    const v = (raw === undefined || raw === null || String(raw).trim() === '') ? '（空）' : raw;
    return `${c.not ? '非 ' : ''}${c.v} ${opText(c.op)} ${v}`;
  }).join(gateLogic(w) === 'or' ? ' 或 ' : ' 且 ');
  const more = list.length > 3 ? ` 等 ${list.length} 条` : '';
  return `条件不满足（${shown}${more}）`;
}

const opText = (op) => ({ '>=': '≥', '>': '>', '<=': '≤', '<': '<', '==': '=', '!=': '≠' }[String(op || '==')] || '=');

/* 运行态脚本/测试想看当前判定结果时用（`app.gate?.ok(w)` 之类不暴露；这里只给内部用） */
export const _probe = (w) => ({ on: gateOn(w), mode: gateMode(w), logic: gateLogic(w), ok: gateOk(w),
                                why: gateWhy(w), hint: gateHint(w) });
