/**
 * shared.js — 控件定义之间**共用的小工具**（拆文件之前它们都堆在 defs.js 顶部/报警段里）
 *
 * 为什么要单独一个文件：这些是跨控件的公共依赖 —— 拆成一控件一文件之后，
 * 谁把某个 helper 留在自己文件里，别的控件 import 不到就当场 ReferenceError。
 * 最典型的是 pickTimeFmt：它原先写在「报警控件」那一段里，**时钟控件也在用**。
 */

/* ── 变量表类型：控件能绑哪些类型 ──
   8 种标量是最常用的；数组（`int[]` 这种）只有**确实支持数组**的控件才能绑：
     · 数值/文本：整段只读显示（[1, 2, 3]），要单个元素就把数组展开成 arrw[k] 再绑那个变量
     · 表格的「数组填充」(arrFill)：把整段按行填进格子
   ⚠ 以前还有个「数组元素」下标属性（绑整段 + 选第几个），已经删掉了 ——
     数组一律走 `[]` 变量名，少一套 0 起/1 起的换算，写元素也不用整段读改写回。
   ⚠ 数值控件的可绑类型里必须留数组：OPC UA 导进来的数组变量（arrw，int[]）绑上去之后，
     属性面板的下拉会按类型过滤，没有数组类型的话当前绑定会被滤掉、面板显示「（未绑定）」。 */
export const ARR_TYPES = ['bool[]', 'int[]', 'uint[]', 'dint[]', 'udint[]', 'real[]', 'lreal[]', 'string[]'];
export const TEXT_ALIGN = [
  { v: 'left', t: '左对齐' },
  { v: 'center', t: '居中' },
  { v: 'right', t: '右对齐' },
];
export const SCALAR_NUM = ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'];

/** 表格用：按行/按列拆文本（一行一行写、逗号分列；空行忽略） */
export function splitLines(text) {
  return String(text ?? '').split(/\r?\n/).map(s => s.trim()).filter(s => s !== '');
}
export function splitRow(text) {
  return String(text ?? '').split(',').map(s => s.trim());
}

/** 时间格式：预设里选「自定义」就用 xxxCustom（报警控件和时钟共用） */
export function pickTimeFmt(p, fallback = 'hh:mm:ss', customFallback = fallback) {
  const f = p?.timeFmt || fallback;
  return f === 'custom' ? (p?.timeFmtCustom || customFallback) : f;
}
