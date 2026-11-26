/**
 * pipe.js — 管道 / 流程线 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 画工艺流程图时当管道/输送线用：
 *   · 横 / 竖（vertical）
 *   · 粗细（thickness）、外壁色（color）、内壁色（innerColor）、圆角（radius）
 *   · flow 勾上 = 内壁流动条纹动画（纯 CSS：repeating-linear-gradient + @keyframes 平移背景），
 *     周期由 flowSpeed（秒）控制；不引第三方库、也不改公共 CSS —— 样式与 @keyframes 都写在
 *     render 返回的内联 <style> 里，每个控件一个唯一动画名（刷新重建时旧的一份一起被换掉）。
 *   · **流动方向可以由变量控制**（绑定是可选的，binding.variable）：
 *       数值 >0 = 正向、<0 = 反向；字符串 right/down/正/正转/forward = 正向，
 *       left/up/反/反转/reverse = 反向；0 / 空 / 认不出 = 用属性面板的静态 flowDir。
 *       **bool 变量按 1/0 判断**：true（1）= 正向、false（0）= 反向（现场常见："泵在转"ON 正向、
 *       OFF 反向/停流；bool 的 0 不再被当成"没给方向"）。
 *     没绑变量 = 完全按静态 flowDir（默认正向）—— 老工程/老画面一个像素都不变。
 *     运行态不用 attach：绑了变量就自动进「变量→控件」索引，变量一变就重画（方向跟着变）。
 */
import { register, rutil } from '../registry.js';
import { project } from '../../core/project.js';
const { escapeHtml, varValue } = rutil;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const numOr = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);

/* ── 流动方向：正向 / 反向 ──
   方向变量只决定"正/反"，具体横竖还是由 vertical 决定（横着就是左右、竖着就是上下）。 */
const DIR_FWD = 1;
const DIR_REV = -1;
const FWD_WORDS = ['right', 'down', '正', '正转', 'forward'];
const REV_WORDS = ['left', 'up', '反', '反转', 'reverse'];
/** 静态 flowDir → 方向（老工程缺这个键 = 正向，行为跟以前一模一样） */
function staticFlowDir(p) {
  return p.flowDir === 'rev' ? DIR_REV : DIR_FWD;
}
/** 绑定的方向变量是什么类型（bool 变量要按 1/0 判断方向，不能把它的 0 当成"没给方向"） */
function dirVarType(w) {
  const name = w.bindings && w.bindings.variable;
  if (!name) return '';
  try {
    const v = project.variables().find(x => x.name === name);
    return String((v && v.type) || '').toLowerCase();
  } catch (e) {
    return '';
  }
}
/** 最终流动方向：绑了方向变量就以变量为准；没绑 / 数值 0 / 认不出的值 = 静态 flowDir
 *  ⚠ bool 变量特殊：true/1 = 正向、false/0 = 反向（现场要"0 和 1 判断方向"）。 */
function flowDirOf(w, vars) {
  const p = w.props || {};
  const v = varValue(w, vars);
  if (v === null || v === undefined || v === '') return staticFlowDir(p);
  const isBoolVar = dirVarType(w) === 'bool';
  if (typeof v === 'boolean') return v ? DIR_FWD : DIR_REV;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return staticFlowDir(p);
    if (isBoolVar) return v !== 0 ? DIR_FWD : DIR_REV;   // bool 变量的 0/1 → 反向/正向
    if (v === 0) return staticFlowDir(p);
    return v > 0 ? DIR_FWD : DIR_REV;
  }
  const s = String(v).trim().toLowerCase();
  if (s === 'true') return DIR_FWD;
  if (s === 'false') return DIR_REV;
  if (FWD_WORDS.indexOf(s) >= 0) return DIR_FWD;
  if (REV_WORDS.indexOf(s) >= 0) return DIR_REV;
  return staticFlowDir(p);
}

register({
  type: 'pipe',                  // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '管道',
  sub: '工艺流程图里的管道/输送线（可流动）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="3" y="13" width="30" height="10" rx="4" fill="#94a3b8"/><rect x="6" y="16" width="24" height="4" rx="2" fill="#e2e8f0"/><path d="M9 18h4M17 18h4M25 18h3" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/></svg>',
  defaults: {
    w: 260, h: 24,
    vertical: false,
    thickness: 14,               // 管道粗细（px）
    color: '#94a3b8',            // 外壁色
    innerColor: '#e2e8f0',       // 内壁色
    flow: false,                 // 流动动画
    flowDir: 'fwd',              // 静态流动方向：fwd 正向 / rev 反向（没绑方向变量时用它）
    flowSpeed: 2,                // 秒 / 一个流动周期
    radius: 6,
  },
  props: [
    { key: 'vertical', label: '竖着画', type: 'check', defVal: false, title: '不勾 = 横管（左右流动）；勾上 = 竖管（上下流动）' },
    { key: 'thickness', label: '粗细', type: 'number', min: 4, max: 80, defVal: 14 },
    { key: 'color', label: '外壁色', type: 'color' },
    { key: 'innerColor', label: '内壁色', type: 'color' },
    { key: 'flow', label: '流动动画', type: 'check', defVal: false, title: '内壁条纹按 flowSpeed 的周期滚动 —— 表示介质在流' },
    { key: 'flowDir', label: '流动方向', type: 'select', defVal: 'fwd', options: [
      { v: 'fwd', t: '正向' }, { v: 'rev', t: '反向' },
    ] },
    { key: 'flowSpeed', label: '流动周期(秒)', type: 'number', min: 0.5, max: 8, step: 0.1, defVal: 2 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
  ],
  // 方向变量是**可选**的：不绑 = 完全按静态 flowDir（老工程老画面不变）。
  // 绑上之后运行态自动进「变量→控件」索引，变量一变就重画，不需要 attach。
  binding: { variable: { types: ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '方向变量（可选）' } },
  actions: [],
  render(w, mode, vars) {
    const p = w.props || {};
    const vertical = p.vertical === true;
    const dir = flowDirOf(w, vars);                        // 变量优先，没绑/0/认不出 = 静态 flowDir
    const rev = dir === DIR_REV;
    const th = clamp(Math.round(numOr(p.thickness, 14)), 4, 80);
    const color = p.color || '#94a3b8';
    const inner = p.innerColor || '#e2e8f0';
    const radius = clamp(Math.round(numOr(p.radius, 6)), 0, 100);
    const flow = p.flow === true;
    const speed = clamp(numOr(p.flowSpeed, 2), 0.5, 8);
    const wall = Math.max(1, Math.round(th * 0.22));        // 内壁相对外壁往里缩多少 = "管壁厚"
    const step = Math.max(6, Math.round(th * 1.15));        // 一条流动条纹的宽度
    // 唯一动画名：同一页上多个管道控件各转各的（重建时整段 <style> 一起被换掉，不会残留）
    const uid = 'wp' + String(w.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    const axis = vertical ? 'y' : 'x';
    const gradDir = vertical ? '180deg' : '90deg';
    const flowColor = 'rgba(255,255,255,.55)';
    const grad = `repeating-linear-gradient(${gradDir}, rgba(255,255,255,0) 0 ${step}px, ${flowColor} ${step}px ${step * 2}px)`;
    const styleBlock = flow ? `<style>
      @keyframes ${uid}-${axis} { from { background-position: 0 0; } to { background-position: ${axis === 'x' ? `${step * 2}px 0` : `0 ${step * 2}px`}; } }
    </style>` : '';
    const flowEl = flow
      ? `<i class="w-pipe-flow" style="position:absolute;inset:0;display:block;background:${grad};background-size:auto;will-change:background-position;animation:${uid}-${axis} ${speed}s linear infinite${rev ? ' reverse' : ''}"></i>`
      : '';
    const trackStyle = vertical
      ? `width:${th}px;height:100%;`
      : `width:100%;height:${th}px;`;
    return `${styleBlock}<div class="w-pipe${vertical ? ' vert' : ''}" data-vertical="${vertical ? 1 : 0}"
      data-thickness="${th}" data-flow="${flow ? 1 : 0}" data-flow-dir="${rev ? 'rev' : 'fwd'}" data-flow-speed="${speed}"
      style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;overflow:hidden">
      <div class="wp-track" style="${trackStyle}position:relative;background:${color};border-radius:${radius}px;box-sizing:border-box">
        <div class="wp-inner" style="position:absolute;inset:${wall}px;background:${inner};border-radius:${Math.max(0, radius - wall)}px;overflow:hidden">
          ${flowEl}
        </div>
      </div>
    </div>`;
  },
});
