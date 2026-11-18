/**
 * scriptEngine.js — 脚本引擎（运行态）
 *
 * 一条脚本 = 触发方式 + 一段 JS。触发方式五种：
 *   init      进入运行态时执行一次（初始化）
 *   interval  定时：每 N 毫秒一次
 *   cycle     循环：每个运行周期（CYCLE_MS）一次
 *   change    变量变化时（值真的变了才触发）
 *   cond      变量条件成立时（上升沿触发一次，持续成立不会一直重复触发）
 *
 * 代码在 `new Function('hmi', code)` 里跑，注入一个受控的 hmi 对象（get/set/log/…），
 * 不用 eval 全局作用域里的东西 —— 但**这不是安全沙箱**（本机自用工具，脚本就是你自己写的代码）。
 * 真正要防的是「写错了把界面卡死/刷屏」：
 *   · 每次执行都有 try/catch，错误进日志（带行号），不往外抛
 *   · 执行耗时 > SLOW_MS 记一条警告；连续出错 MAX_ERRS 次自动禁用该脚本（本次运行内）
 *   · 日志按脚本留最近 LOG_MAX 行
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { varStore } from './varstore.js';
import { compareVal, fmtTime } from '../core/utils.js';

const CYCLE_MS = 50;          // 循环触发的周期（也是 cond 的检查周期）
const SLOW_MS = 50;           // 单次执行超过这么久 → 记一条警告
const MAX_ERRS = 5;           // 连续出错这么多次 → 自动禁用（本次运行内，不改工程）
const LOG_MAX = 60;

let running = false;
let cycleTimer = null;
const tabs = [];              // [{sc, timer, prev, errs, disabled, logs:[], runs, ms}]
const unsubs = [];

const tabOf = (id) => tabs.find(t => t.sc.id === id) || null;

/* ─────────── 注入给脚本的 API ─────────── */
function makeApi(sc, log) {
  const rt = window.__hmiRuntime || {};        // runtime.js 启动时挂上来（页面/弹窗操作）
  const num = (v) => (v === '' || v === undefined || v === null ? 0 : Number(v));
  return {
    /** 变量名 → 当前值（没这个名字返回 undefined，便于 if (hmi.get('x') === undefined) 判断） */
    get(name) { return varStore.get(name); },
    /** 写变量（和控件写值走同一条路：本地更新 + 下发给后端/PLC） */
    set(name, value) {
      if (typeof name !== 'string' || !name) { log('warn', 'set：变量名不能为空'); return; }
      const v = project.variables().find(x => x.name === name);
      const val = !v ? value : v.type === 'bool' ? !!value
        : (v.type === 'string' ? String(value) : num(value));
      varStore.set(name, val, 'local');
      return val;
    },
    /** 变量名是否存在（脚本里防手滑） */
    has(name) { return project.variables().some(v => v.name === name); },
    /** 全部变量当前值（快照） */
    vars() { return varStore.getAll(); },
    log(...a) { log('log', ...a); },
    warn(...a) { log('warn', ...a); },
    /** 页面/弹窗：按 id 或名称 */
    page(p) { return rt.gotoPage ? rt.gotoPage(p) : false; },
    popup(p) { return rt.showPopup ? rt.showPopup(p) : false; },
    hidePopup() { return rt.hidePopup ? rt.hidePopup() : false; },
    back() { return rt.goBack ? rt.goBack() : false; },
    /** 当前报警（只读） */
    alarms() { return rt.activeAlarms ? rt.activeAlarms() : []; },
    /* 操作权限：
       · level() = 现在解锁到的等级名（'' = 没解锁）
       · can(levelIdOrName) = 当前权限够不够某一级（脚本里做"有权限才显示/才写值"）
       · lock() = 退出权限（交回去） */
    permLevel() { return rt.permLevelName ? rt.permLevelName() : ''; },
    can(levelIdOrName) {
      const key = String(levelIdOrName || '');
      if (!key) return true;
      const lv = project.permLevels().find(l => l.id === key || l.name === key);
      return rt.permCan ? rt.permCan(lv?.id || key) : true;
    },
    lock() { return rt.lockPerm ? rt.lockPerm('脚本退出权限') : false; },
    now() { return Date.now(); },
    time(fmt) { return fmtTime(Date.now(), fmt || 'hh:mm:ss'); },
    /* 只读的工程信息。
       pageName() = **当前打开那一页的名字**（运行态正在显示的那一页 / 弹窗也算当前页）；
       pageId() 是它的 id。要按页面判断（比如"在这一页才做某件事"）用 pageName 最好读。 */
    project: {
      name: () => project.data?.meta?.name || '',
      pageId: () => project.currentId,
      pageName: () => project.currentPage()?.name || '',
    },
    fmtTime,
  };
}

/* ─────────── 执行一条脚本 ─────────── */
/** 把值变成日志里好读的一行（字符串带引号、对象走 JSON） */
function fmtVal(v) {
  if (typeof v === 'string') return `'${v}'`;
  if (v === null) return 'null';
  if (Array.isArray(v) || typeof v === 'object') {
    try { const s = JSON.stringify(v); return s.length > 200 ? s.slice(0, 200) + '…' : s; }
    catch { return String(v); }
  }
  return String(v);
}

/**
 * 行号偏移：报错栈里的行号是「eval 包壳之后」的行，具体多几行跟引擎实现有关（Chrome 是 +2）。
 * 与其写死一个数（哪天包壳改了就不准），不如**现场标定一次**：故意抛一个 1 行的错，
 * 看它报第几行，就知道偏移是几。标定结果缓存起来。
 */
let LINE_OFFSET = null;
function calibrateLineOffset() {
  if (LINE_OFFSET !== null) return LINE_OFFSET;
  LINE_OFFSET = 2;
  try {
    const f = new Function('hmi', 'code', '"use strict";\nreturn eval(code);\n');
    f({}, "throw new Error('calib')");
  } catch (e) {
    const m = /<anonymous>:(\d+):\d+/.exec(String(e.stack || ''));
    if (m) LINE_OFFSET = Math.max(0, Number(m[1]) - 1);     // 1 行代码报出来的行号 = 1 + 偏移
  }
  return LINE_OFFSET;
}

/**
 * @param {boolean} [capture] 试运行：把「最后一句话的值」也打出来（像控制台那样）
 *   为什么用 eval：直接 eval 会返回最后一条语句的**完成值**（1*5 → 5、let x=4; x*3 → 12），
 *   而 new Function 的最后一个表达式语句是拿不到值的（那个值被丢掉，写 1*5 什么也看不见）。
 */
function run(sc, why, capture) {
  const t = tabOf(sc.id);
  if (!t || t.disabled) return false;
  const log = (level, ...args) => pushLog(t, level, args);
  const t0 = performance.now();
  let fn;
  try {
    fn = new Function('hmi', 'code', `"use strict";\nreturn eval(code);\n`);
  } catch (e) {
    pushLog(t, 'error', [`语法错误：${e.message}`]);
    t.errs++;
    if (t.errs >= MAX_ERRS) disable(t, '语法错误连续多次');
    return false;
  }
  try {
    const ret = fn(makeApi(sc, log), sc.code);
    if (capture && ret !== undefined) pushLog(t, 'value', [`= ${fmtVal(ret)}`]);
  } catch (e) {
    if (e instanceof SyntaxError) {                 // 编辑器拦过一次，这里兜底（比如直接改了工程 JSON）
      pushLog(t, 'error', [`语法错误：${e.message}`]);
      t.errs++;
      if (t.errs >= MAX_ERRS) disable(t, '语法错误连续多次');
      return false;
    }
    // 行号：eval 的栈是两层的 ——
    //     at eval (eval at <anonymous> (…), <anonymous>:2:7)   ← 用户代码那一帧（要的就是它）
    //     at eval (eval at run (…), <anonymous>:4:8)           ← 包壳 return eval(code) 那一帧
    // 取**第一个** <anonymous>:行:列 就是用户代码的行，再减去标定出来的偏移（标定用的是同一套取法）。
    const m = /<anonymous>:(\d+):\d+/.exec(String(e.stack || ''));
    const raw = m ? Number(m[1]) : 0;
    const line = raw ? Math.max(1, raw - calibrateLineOffset()) : 0;
    pushLog(t, 'error', [`运行错误${line ? `（第 ${line} 行）` : ''}：${e.message}`]);
    t.errs++;
    if (t.errs >= MAX_ERRS) disable(t, `连续 ${MAX_ERRS} 次运行错误`);
    return false;
  }
  t.errs = 0;
  t.runs++;
  const dt = performance.now() - t0;
  if (dt > SLOW_MS) pushLog(t, 'warn', [`这次执行用了 ${dt.toFixed(0)}ms（超过 ${SLOW_MS}ms，别在脚本里写死循环/长等待）`]);
  if (why && why !== 'cycle') pushLog(t, 'run', [`执行（${why}）`]);
  return true;
}

function disable(t, reason) {
  t.disabled = true;
  if (t.timer) { clearInterval(t.timer); t.timer = null; }
  pushLog(t, 'error', [`已自动停用这条脚本：${reason}。改好代码后再进一次运行态`]);
  bus.emit('scripts:changed', { id: t.sc.id, disabled: true });
}

function pushLog(t, level, args) {
  const text = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  t.logs.push({ at: Date.now(), level, text });
  if (t.logs.length > LOG_MAX) t.logs.splice(0, t.logs.length - LOG_MAX);
  bus.emit('script:log', { id: t.sc.id });
}

/* ─────────── 起停 ─────────── */
export function startScripts() {
  stopScripts();
  if (!project.scripts().length) return;
  running = true;
  project.scripts().forEach(sc => {
    tabs.push({ sc, timer: null, prev: undefined, errs: 0, disabled: false, logs: [], runs: 0, ms: 0 });
  });

  // 变量变化 / 条件：都挂在 vars:changed 上（变化即算，不用等下一个周期）
  const onVar = ({ name }) => {
    tabs.forEach(t => {
      if (t.disabled) return;
      const sc = t.sc;
      if (sc.enabled === false) return;
      if (sc.trig === 'change' && sc.variable && sc.variable === name) run(sc, `变量 ${name} 变化`);
      else if (sc.trig === 'cond' && sc.variable && sc.variable === name) checkCond(t);
    });
  };
  bus.on('vars:changed', onVar);
  unsubs.push(() => bus.off?.('vars:changed', onVar));

  // 进入运行态时一次（等一帧，让页面先渲染出来）
  setTimeout(() => {
    if (!running) return;
    tabs.forEach(t => { if (t.sc.enabled !== false && t.sc.trig === 'init') run(t.sc, '进入运行态'); });
  }, 120);

  // 定时触发：每条脚本自己的 interval（ms 下限 10，免得写 1ms 把界面拖死）
  tabs.forEach(t => {
    const sc = t.sc;
    if (sc.enabled === false || sc.trig !== 'interval') return;
    const ms = Math.max(10, Math.round(+sc.ms || 1000));
    t.timer = setInterval(() => run(sc, ''), ms);
    unsubs.push(() => clearInterval(t.timer));
  });

  // 循环 + 条件：一个共用心跳
  cycleTimer = setInterval(() => {
    tabs.forEach(t => {
      const sc = t.sc;
      if (t.disabled || sc.enabled === false) return;
      if (sc.trig === 'cycle') run(sc, 'cycle');
      else if (sc.trig === 'cond') checkCond(t);
    });
  }, CYCLE_MS);
  unsubs.push(() => clearInterval(cycleTimer));
  bus.emit('scripts:changed', { started: true });
}

/**
 * 条件成立时触发：只在「上一次不成立、这次成立」这个上升沿跑一次。
 * 头一次判定就成立（was === undefined）也算一次 —— 进运行态时条件本来就成立，用户期望它跑。
 */
function checkCond(t) {
  const sc = t.sc;
  if (!sc.variable) return;
  const v = varStore.get(sc.variable);
  if (v === undefined || v === null) return;
  const on = compareVal(v, sc.op || '==', sc.value);
  const was = t.prev;
  t.prev = on;
  if (on && was !== true) run(sc, `条件成立（${sc.variable} ${sc.op} ${sc.value}）`);
}

export function stopScripts() {
  running = false;
  unsubs.forEach(f => { try { f(); } catch { /* 忽略 */ } });
  unsubs.length = 0;
  tabs.forEach(t => { if (t.timer) clearInterval(t.timer); t.timer = null; });
  if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
  tabs.length = 0;
}

export const scriptsRunning = () => running;

/* ─────────── 编辑器用：试运行 / 日志 / 统计 ─────────── */
/** 编辑态「试运行」：不进运行态也能跑一次（写变量走本地预览 + 后端下发那条路）
 *  @returns {{ok:boolean, ms:number, logs:Array, error:string}} */
export function runScriptOnce(id) {
  const sc = project.getScript(id);
  if (!sc) return { ok: false, ms: 0, logs: [], error: '脚本不存在' };
  const t = tabOf(id) || { sc, timer: null, prev: undefined, errs: 0, disabled: false, logs: [], runs: 0, ms: 0 };
  if (!tabOf(id)) tabs.push(t);          // 记日志用（运行态没起时也留个位置）
  t.logs.length = 0;
  t.disabled = false;
  const t0 = performance.now();
  const ok = run(sc, '试运行', true);      // 试运行会多打一行「= 最后一句话的值」
  return {
    ok, ms: performance.now() - t0, logs: t.logs.slice(),
    error: ok ? '' : (t.logs.filter(l => l.level === 'error').slice(-1)[0]?.text || '执行失败'),
  };
}

export function scriptLog(id) { return tabOf(id)?.logs.slice() || []; }
export function scriptStats() {
  return tabs.map(t => ({ id: t.sc.id, runs: t.runs, disabled: t.disabled, errs: t.errs }));
}
export function clearScriptLog(id) { const t = tabOf(id); if (t) t.logs.length = 0; }
