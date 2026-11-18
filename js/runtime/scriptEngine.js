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
import { backend } from '../api/backend.js';
import { compareVal, fmtTime } from '../core/utils.js';
import { onTick } from './ticker.js';

const CYCLE_MS = 50;          // 循环触发的周期（也是 cond 的检查周期）
const SLOW_MS = 50;           // 单次执行超过这么久 → 记一条警告
const MAX_ERRS = 5;           // 连续出错这么多次 → 自动禁用（本次运行内，不改工程）
const LOG_MAX = 60;

let running = false;
let armed = false;            // 触发已经挂上了没（startScripts 建档位 → armScripts 才开跑，见那里的说明）
const tabs = [];              // [{sc, prev, errs, disabled, logs:[], runs, ms, nextAt}]
const unsubs = [];

/**
 * 脚本自己的全局暂存（`hmi.g.xxx`）：**跨执行、跨脚本**都记得住，用来放那些"只是脚本自己要记"的东西
 * —— 防抖标记、上次的值、累加器。以前这些只能各占一条内部变量（变量表越写越长、还要起名字）。
 *
 * ⚠ 三条边界（写进编辑器「? 帮助」了）：
 *   · **不进变量表**：界面上看不见、不能绑定控件、变量监控里也查不到；
 *   · **不落盘**：退出运行态 / 刷新页面就清空（进运行态时也是全新的，见 startScripts）；
 *   · 要"看得见 / 能绑控件 / 掉电保持"的量，还是用变量表里的内部变量（地址留空）。
 */
let scriptGlobals = Object.create(null);

const tabOf = (id) => tabs.find(t => t.sc.id === id) || null;

/* ─────────── 注入给脚本的 API ─────────── */
function makeApi(sc, log) {
  const rt = window.__hmiRuntime || {};        // runtime.js 启动时挂上来（页面/弹窗操作）
  const num = (v) => (v === '' || v === undefined || v === null ? 0 : Number(v));
  const api = {
    /** 变量名 → 当前值（没这个名字返回 undefined，便于 if (hmi.get('x') === undefined) 判断） */
    get(name) { return varStore.get(name); },
    /** 写变量（和控件写值走同一条路：本地更新 + 下发给后端/PLC）
     *  ⚠ 'script' 这个标记是给后端的：脚本写的值**不打进 cmd 那行 `[var] …` 日志**
     *  （脚本可能每 100ms 写一次，会把控制台刷爆；脚本要记录就用 hmi.log）。
     *  屏上按钮/输入框/监控里手改的写值不带这个标记 —— 那些才是操作记录。 */
    set(name, value) {
      if (typeof name !== 'string' || !name) { log('warn', 'set：变量名不能为空'); return; }
      const v = project.variables().find(x => x.name === name);
      const val = !v ? value : v.type === 'bool' ? !!value
        : (v.type === 'string' ? String(value) : num(value));
      varStore.set(name, val, 'local', 'script');
      return val;
    },
    /** 变量名是否存在（脚本里防手滑） */
    has(name) { return project.variables().some(v => v.name === name); },
    /** 全部变量当前值（快照） */
    vars() { return varStore.getAll(); },
    log(...a) { log('log', ...a); },
    warn(...a) { log('warn', ...a); },
    /**
     * `hmi.logNo(…)` —— **只给调试看的日志：不落盘**（level='dbg'）。
     *
     * 为什么要有它：写脚本时经常想打一堆中间值（循环里每一步、每个分支走了哪条），
     * 这些用 `hmi.log` 打会**真的写进 logs/script-*.log** —— 日志文件有限速（每脚本 20 行/秒）
     * 和每天体积上限（默认 10MB，见「工程 ▾ → 日志设置…」），调试输出把额度占了，真出事时那份日志里全是噪音。
     * 用 `hmi.logNo` 打：只进内存（编辑器「▶ 试运行」的日志区、运行态「脚本日志」面板），
     * **永远不写日志文件**；内存里每条脚本留最近 60 行，满了先丢最旧的调试输出（不挤掉真日志）。
     *
     * 名字里的 No = "no save"（不落盘）。要留痕（事后能查）就用 `hmi.log`。
     */
    logNo(...a) { log('dbg', ...a); },
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
    /**
     * 现在是不是**内部仿真**（没接真设备：内存模拟 / 后端离线）→ true。
     *
     * 干什么用：演示工程里那段「产线仿真」脚本靠它决定要不要自己驱动模拟量 ——
     *   if (!hmi.sim()) return;   // 接了真 PLC / OPC UA 就别抢着写
     * 少了这道守卫会出什么事（踩过）：真设备接上之后，脚本还在每 500ms 写一批量，
     * 其中写**输入区**（%IX…，PLC 侧只读）和变量表里没有的量的那些会被后端拒，
     * 界面上就是「下发失败」一直刷屏、每次失败还带回读一整张变量表 → 页面越来越卡。
     */
    sim() { return rt.isSim ? rt.isSim() : true; },
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
  /* 两种"少写点字"的入口（都是加法，老写法一个字没变）：
       · api.v = 变量表的属性写法：hmi.v.rSpeedSet = 1200 / if (hmi.v.bRun) …
         —— 内部就是复用上面的 get/set/has，语义与函数写法完全一致 */
  api.v = makeVarProxy(api);
  /* · api.g = 脚本自己的全局暂存：跨执行、跨脚本记得住，不占变量表（见 scriptGlobals 的说明） */
  api.g = scriptGlobals;
  return api;
}

/** 数组元素写法 `arrw[3]`（和 varstore 里那条正则同一套口径） */
const ARR_ELEM_RE = /^(.+)\[(\d+)\]$/;

/**
 * `hmi.v.变量名` —— 变量表的**属性写法**（读、写都像普通属性）：
 *
 *     hmi.v.rSpeedSet = 1200          // 完全等于 hmi.set('rSpeedSet', 1200)（类型收敛 + 下发都在）
 *     if (hmi.v.bRun) { … }           // 完全等于 hmi.get('bRun')
 *     hmi.v.转速 = 100                // 中文变量名可以直接点出来
 *     hmi.v['1号泵'] = true           // 名字不是合法标识符（数字开头/横线/空格）→ 方括号
 *     hmi.v['arrw[3]'] = 999          // 数组元素照旧
 *
 * 只比函数写法多一条：**读/写变量表里没有的名字 → 当场抛错**。
 * 为什么不像 hmi.get 那样给 undefined：函数写法给 undefined 是为了能拿它判断"有没有这个变量"；
 * 而属性写法是天天用的日常写法，打错一个字静默给 undefined 就变成"这段脚本永不生效"——
 * 那正是现场最难查的一类问题（变量表里几百条，肉眼比对不出来）。想先判断在不在，用 hmi.has('名字')。
 */
function makeVarProxy(api) {
  const missing = (name) => new ReferenceError(
    `变量表里没有「${name}」：hmi.v 读写都会先查变量表（防打错字）。`
    + `想判断在不在 → hmi.has('${name}')；`
    + `想临时记点东西（不占变量表）→ hmi.g.名字`);
  /** `arrw[3]` 这种写法只有在"整段 arrw 还以数组存在"时才算（展开成单个变量后名字本身就叫 arrw[1]） */
  const arrBase = (name) => {
    const m = ARR_ELEM_RE.exec(name);
    return m && api.has(m[1]) ? m : null;
  };
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== 'string') return undefined;                    // Symbol（迭代/转原始值）不掺和
      if (api.has(key)) return api.get(key);                            // 变量优先（连叫 toString 的变量也认）
      const m = arrBase(key);
      if (m) { const cur = api.get(m[1]); return Array.isArray(cur) ? cur[Number(m[2])] : undefined; }
      /* 下面几条是"别在边角上炸"：hmi.v 被 console 看一眼、被 JSON.stringify、被 String() 时都要正常。
         ⚠ 顺序不能反：先认变量名（上面那两行），再走这些兜底 —— 否则变量真叫 toString 就读不到了。 */
      if (key === 'toString') return () => '[hmi.v 变量表]';
      if (key === 'toJSON') return undefined;                           // JSON.stringify(hmi.v) 会先问 toJSON
      if (key === 'then') return undefined;                             // 别被当成 thenable（await hmi.v 会挂住）
      if (key in Object.prototype) return undefined;                    // constructor / hasOwnProperty / __proto__ …
      throw missing(key);
    },
    set(_, key, value) {
      if (typeof key !== 'string') return true;
      if (api.has(key) || arrBase(key)) { api.set(key, value); return true; }
      throw missing(key);
    },
    has: (_, key) => typeof key === 'string' && (api.has(key) || !!arrBase(key)),
    // Object.keys(hmi.v) / for…in / {...hmi.v} 都能用（列出来的就是变量表里的名字）
    ownKeys: () => project.variables().map(v => v.name),
    getOwnPropertyDescriptor(_, key) {
      if (typeof key === 'string' && api.has(key)) {
        return { value: api.get(key), writable: true, enumerable: true, configurable: true };
      }
      return undefined;      // ⚠ ownKeys 列过的名字必须给得出描述符，否则 Proxy 会抛 TypeError
    },
    deleteProperty(_, key) {
      throw new Error(`脚本里不能删变量「${String(key)}」—— 要删请到变量表里删`);
    },
  });
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
  if (t.logs.length > LOG_MAX) {
    // 满了先丢**最旧的调试输出**（hmi.logNo，level='dbg'）：调试打得多的时候别把真日志挤出去
    //（真日志在落盘那份里还有，但面板/试运行里"我 log 的那行怎么没了"最让人困惑）
    const i = t.logs.findIndex(l => l.level === 'dbg');
    t.logs.splice(i === -1 ? 0 : i, 1);
  }
  bus.emit('script:log', { id: t.sc.id });
  /* ⚠ hmi.logNo（level='dbg'）**只活在内存里**：不送后端、不落盘 —— 它就是"写脚本时打中间值看看"
     的那个通道（日志文件有限速、有每天上限，调试输出不该占它的地方）。 */
  if (level !== 'dbg') slogEnqueue(t.sc, level, text);
}

/* ─────────── 脚本日志落盘（送后端写 logs/script-YYYY-MM-DD.log） ───────────
   为什么要送：脚本日志本来只在内存里（每条 60 行），**刷新就没、退出运行态就没**，
   运行页（/run）上更是连看都看不见 —— 现场出了事没有痕迹。
   送法：按批（默认 600ms 或攒够 100 行就发一次）、**按脚本限速**（令牌桶，20 行/秒、
   突发 40 行），队列满了丢最早的并记一笔"丢了多少行"。
   为什么非要限速：一个 100ms 的定时脚本里写一行 log 就是 10 行/秒，一天能到几 MB ——
   工控机的盘不能被日志写满。后端那边还有第三、四道闸（单请求行数、每天体积上限）。
   ⚠ 送日志**绝不能影响脚本本身**：后端没开/断网/旧版后端（404）都只当"这批发丢了"，
   不抛、不重试、不提示（要看日志的现场就在「脚本日志」面板里看内存那份）。 */
const SLOG_FLUSH_MS = 600;
const SLOG_MAX_BATCH = 100;
const SLOG_QUEUE_MAX = 400;
const SLOG_RATE = 20;                  // 每个脚本每秒最多多少行
const SLOG_BURST = 40;                 // 突发上限（一上来就连着打也能过一批）
let slogQueue = [];
let slogTimer = null;
let slogDropped = 0;                   // 因限速/队列丢弃的行数（面板上会写出来，不装作没丢）
const slogBuckets = new Map();         // sc.id → { tokens, at }

/** 令牌桶：这个脚本现在还能不能记一行 */
function slogAllowed(sc) {
  const now = performance.now();
  let b = slogBuckets.get(sc.id);
  if (!b) { b = { tokens: SLOG_BURST, at: now }; slogBuckets.set(sc.id, b); }
  b.tokens = Math.min(SLOG_BURST, b.tokens + ((now - b.at) / 1000) * SLOG_RATE);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function slogEnqueue(sc, level, text) {
  if (!backend.expectsServer()) return;        // file:// 双击打开的页面没有后端，别白试
  if (!slogAllowed(sc)) { slogDropped++; return; }
  slogQueue.push({ t: Date.now(), name: sc.name || '脚本', level, text });
  if (slogQueue.length > SLOG_QUEUE_MAX) {
    slogDropped += slogQueue.length - SLOG_QUEUE_MAX;
    slogQueue.splice(0, slogQueue.length - SLOG_QUEUE_MAX);
  }
  if (!slogTimer) slogTimer = setTimeout(() => { slogTimer = null; slogFlush(); }, SLOG_FLUSH_MS);
}

/** 把攒下的这批送出去（失败就算了：日志重要不过脚本本身）。退出运行态时会再冲一次 */
export function slogFlush() {
  if (!slogQueue.length) return;
  const batch = slogQueue.splice(0, SLOG_MAX_BATCH);
  if (slogQueue.length && !slogTimer) {
    slogTimer = setTimeout(() => { slogTimer = null; slogFlush(); }, SLOG_FLUSH_MS);
  }
  backend.sendScriptLog(batch).then(res => {
    if (res && res.dropped) slogDropped += res.dropped;    // 后端也丢过（到上限了），照实记着
  });
}

/* ─────────── 起停 ─────────── */
/**
 * 进运行态：**只做初始化** —— 清空 `hmi.g`、按变量表给每条脚本重建日志档位。
 * 真正开始触发的是 `armScripts()`。
 *
 * ⚠ **为什么拆成两步**：脚本第一拍就可能去写变量，而"现在接的是不是真设备"决定了
 *   `hmi.sim()` 和那道链路门（没读到数据不许写）。runtime 进运行态时要先问一次后端
 *   "现在在跟谁通讯"，那是异步的；以前这里把定时器一并挂上，于是**接了 PLC 的工程**
 *   在设备状态取回来之前会按"内存模拟"跑：仿真脚本抢着写 PLC 变量，设备断着的时候
 *   每一笔都要等一个 socket 超时 → 界面上刷出一串「下发失败」。
 *   拆开之后顺序是硬的：**状态先落地，脚本才开跑**（见 runtime.enterRun）。
 *
 * ⚠ 这一步必须**同步**做完（不许挪到 await 后面）：它同时负责把每条脚本的日志清空，
 *   晚一步就会把期间产生的日志（试运行、别的模块刚打的）一起抹掉。
 */
export function startScripts() {
  stopScripts();
  if (!project.scripts().length) return;
  running = true;
  scriptGlobals = Object.create(null);   // 进运行态 = 全新的 hmi.g（脚本自己的暂存不跨"这次运行"）
  project.scripts().forEach(sc => {
    tabs.push({ sc, prev: undefined, errs: 0, disabled: false, logs: [], runs: 0, ms: 0, nextAt: undefined });
  });
  bus.emit('scripts:changed', { started: true });
}

/**
 * 开始**真正触发**脚本（进入运行态一次 / 定时 / 循环 / 变量变化 / 条件）。
 * 由 runtime 在"数据源模式已经问清楚"之后调用一次；重复调用无副作用。
 */
export function armScripts() {
  if (!running || armed) return;
  armed = true;

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

  // 定时触发 + 循环 + 条件：都走统一节拍器（onTick）。
  //   ⚠ 不能用裸 setInterval：页面被切到后台时浏览器把页面定时器降频到 1 秒一次，
  //   100ms 的采样脚本会变成一秒跑一次、算出来的曲线一段一段（现场实测）。
  //   ticker.js 用 Worker 心跳 + 后端数据推送当唤醒源，后台也照旧按 ~20ms 推进。
  const due = (t, now, ms) => {
    if (t.nextAt === undefined) t.nextAt = now + ms;
    if (now < t.nextAt) return false;
    // 卡了一拍以上（后台/长任务）不补跑多次：按「现在」重排下一拍，采样类脚本要的是当下
    t.nextAt = now + ms;
    return true;
  };
  const onBeat = (now) => {
    tabs.forEach(t => {
      const sc = t.sc;
      if (t.disabled || sc.enabled === false) return;
      if (sc.trig === 'interval') {
        const ms = Math.max(10, Math.round(+sc.ms || 1000));
        if (due(t, now, ms)) run(sc, '');
      } else if (sc.trig === 'cycle') {
        if (due(t, now, CYCLE_MS)) run(sc, 'cycle');
      } else if (sc.trig === 'cond') {
        if (due(t, now, CYCLE_MS)) checkCond(t);
      }
    });
  };
  unsubs.push(onTick(onBeat));
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
  armed = false;                         // 下次进运行态要重新 arm（见 startScripts / armScripts）
  scriptGlobals = Object.create(null);   // 退出运行态 = hmi.g 清空（它不落盘，别指望下次还在）
  slogFlush();                           // 退出前把还没送出的那批日志送掉（不然最后几行就没了）
  slogBuckets.clear();                   // 令牌桶也跟着重置：下次进运行态重新开始
  unsubs.forEach(f => { try { f(); } catch { /* 忽略 */ } });
  unsubs.length = 0;
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

/**
 * **所有脚本**的日志合成一条时间线（运行态「脚本日志」面板用）：按时间倒序，新的在最上面。
 * 每条带上脚本名 + 级别 + 是否已停用 —— 现场不打开编辑器也要看得出"谁在说话、谁死了"。
 *
 * `hmi.logNo` 的调试输出（level='dbg'）默认**不返回**（现场画面上的调试噪音没意义），
 * 用 opts.dbg=true 才带上；两种情况下都给出 `dbg` 计数，界面好写"还有 N 行调试输出"。
 * @returns {{lines:Array, dropped:number, dbg:number, disabled:Array<{id,name}>}}
 */
export function scriptLogsAll(limit = 200, opts = {}) {
  const wantDbg = opts.dbg === true;
  const lines = [];
  const disabled = [];
  let dbg = 0;
  tabs.forEach(t => {
    if (t.disabled) disabled.push({ id: t.sc.id, name: t.sc.name });
    t.logs.forEach(l => {
      if (l.level === 'dbg') { dbg++; if (!wantDbg) return; }
      lines.push({ ...l, id: t.sc.id, name: t.sc.name, disabled: !!t.disabled });
    });
  });
  lines.sort((a, b) => a.at - b.at);          // 按时间正序，再取最后 limit 条（再倒过来显示）
  return {
    lines: lines.slice(-Math.max(1, limit)).reverse(),
    dropped: slogDropped,
    dbg,
    disabled,
  };
}
export function scriptStats() {
  return tabs.map(t => ({ id: t.sc.id, runs: t.runs, disabled: t.disabled, errs: t.errs }));
}
export function clearScriptLog(id) { const t = tabOf(id); if (t) t.logs.length = 0; }
/** 清掉**所有**脚本的内存日志（运行态「脚本日志」面板上的「清空」）—— 服务器上落盘的那份不动 */
export function clearAllScriptLogs() {
  tabs.forEach(t => { t.logs.length = 0; });
  slogDropped = 0;
  bus.emit('script:log', { id: null });
}
