/**
 * runtime.js — 运行时引擎
 *
 *   · 页面栈（gotoPage / back）
 *   · 弹窗栈（showPopup / hidePopup，支持多层）
 *   · 动作系统：tap(点动) / toggle(切换) / setValue / gotoPage / showPopup / hidePopup / back
 *   · 变量绑定控件实时刷新（本地模拟 或 Python 后端 SSE 推送）
 *   · 变量监控抽屉（运行中手动改值测试逻辑）
 */
import { bus } from '../core/eventBus.js';
import { project, PAD_REPLACE, PAD_LABEL_WIDGET } from '../core/project.js';
import { renderWidgetDOM, refreshWidgetBody, rutil } from '../widgets/registry.js';
import { varStore } from './varstore.js';
import { backend } from '../api/backend.js';
import { fmtValue, numberFmtOf, parseOptions, comboMode, isClickThrough,
  inputRangeOf, parseNumInput, inRange } from '../core/utils.js';
import { startAlarms, stopAlarms, ackAlarm, clearHistory, setAlarmHistoryDay, shiftAlarmHistoryDay, activeAlarms } from './alarms.js';
import * as perm from './permissions.js';
import { layoutBar } from '../widgets/alarmBar.js';
import { createVList } from '../core/vlist.js';
import { startScripts, armScripts, stopScripts, scriptLogsAll, clearAllScriptLogs } from './scriptEngine.js';
import { allTrendWidgets } from './trend.js';
// 软键盘的中文输入：离线拼音表（tools/gen_pinyin.py 生成，别手改）
import { pinyinCandidates, pinyinComplete } from '../data/pinyin.js';

let rtRoot, rtPage, popupLayer, rtvList;
let pageStack = [];
/** 页面栈最多留多少页（只用来支持「返回上一页」；见 gotoPage 的说明） */
const PAGE_STACK_MAX = 50;
let popupStack = [];
let running = false;
/** true = 这份页面是给现场/客户的「只读运行」页面（后端 /run 注入的标记，见 main.js）：
    没有编辑器、退不出去、改配置的入口全部拦下并提示「要管理员登录」 */
const RUN_ONLY = window.__HMI_RUN_ONLY__ === true;

/* 运行画面缩放：三种模式（原始 1:1 / 适应窗口 / 填满窗口），默认「适应窗口」，
   选中的模式记在 localStorage（ZOOM_KEY），下次进运行态照旧 */
const FIT_PAD = 12;            // 画面与窗口边缘留白（px）
let scaleK = 1;                // 等比缩放系数（原始/适应两档就是它）
let scaleX = 1, scaleY = 1;    // 实际的横竖缩放（填满档是拉伸：横竖各自算）
let offsetX = 0;               // 画面水平避让变量监控后的偏移
/** 弹窗被拖动后的屏幕像素偏移（按页面 id 记住，重绘/缩放都不丢位置） */
const popupPan = new Map();

/* ── 变量 → 控件 索引（500 个控件时的关键优化）────────────────────────
   原来「每次变量变化都把**所有页面的所有控件**扫一遍」是 O(控件数 × 变化数)：
   一次轮询 500 个变量全变 = 25 万次判断（每次还要新建 actions 数组做 stateVarOf），
   实测光这一项就要 20ms+，轮询周期 100ms 时帧率直接掉下来。
   现在改成「画面/弹窗重画时建一次表」，刷新时一次查表命中，只碰真正绑了那个变量的控件。 */
const ALARM_WIDGET_TYPES = new Set(['alarmBar', 'alarmList', 'alarmHistory']);
let pageRendered = [];          // 当前页面上真实存在的控件 [{ w, el }]
let popupRendered = [];         // 打开着的弹窗里的控件 [{ w, el }]
let boundIndex = new Map();     // 变量名 -> [{ w, el }]
let alarmCells = [];            // 报警控件 [{ w, el }]

/** 画面/弹窗重画之后调一次：把「变量 → 控件」「报警控件」两张表重算出来 */
function reindexRendered() {
  boundIndex = new Map();
  alarmCells = [];
  const add = ({ w, el }) => {
    if (ALARM_WIDGET_TYPES.has(w.type)) alarmCells.push({ w, el });
    const sv = rutil.stateVarOf(w);
    if (!sv) return;
    let l = boundIndex.get(sv);
    if (!l) { l = []; boundIndex.set(sv, l); }
    l.push({ w, el });
  };
  pageRendered.forEach(add);
  popupRendered.forEach(add);
}

export function initRuntime() {
  rtRoot = document.getElementById('runtimeRoot');
  rtPage = document.getElementById('rtPage');
  popupLayer = document.getElementById('rtPopupLayer');
  rtvList = document.getElementById('rtvList');
  // 现场在画面上点/按键 = "有人在操作" → 重新计自动上锁的时间（超过 N 分钟没动才自动锁）
  perm.attachActivity(rtRoot);

  document.getElementById('rtExit').addEventListener('click', exitRun);
  // 运行中的「PLC 设置」：直接复用编辑器那个连接对话框（运行态也能改连接，确定即生效）
  document.getElementById('rtPlcBtn').addEventListener('click', openRuntimePlcDialog);
  // 快捷键提示：点一下立刻收起（别挡着画面）
  document.getElementById('rtHint')?.addEventListener('click', hideRuntimeHint);
  document.addEventListener('keydown', e => {
    if (!running) return;
    // 输入框里打字不抢键（变量监控筛选框、数值输入框、脚本区…）
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // 快捷键一律**两个键一起按**（Ctrl+Shift+字母）：现场是按画面不是打字，
    // 单字母（F/V）太容易误触 —— 原来按个 V 就把变量监控翻出来、按个 F 画面就变了。
    //   Ctrl+Shift<E 退出运行 · Ctrl+Shift+L PLC 连接设置
    //   Ctrl+Shift+V 变量监控显示/隐藏 · Ctrl+Shift+F 切换视图（原始 → 适应 → 填满）
    //   Ctrl+Shift+J 脚本日志 · Ctrl+Shift+Q 退出操作权限（配了权限管理的工程才用得上）
    if (!typing && !e.repeat && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'f') { e.preventDefault(); cycleZoomMode(); return; }   // 切视图：现场自己能用
      // 下面这些是「改配置/退出」—— 客户机（/run）上先要管理员密码，过了才真做
      if (k === 'e') { e.preventDefault(); enterEditorFromRuntime(); return; }
      if (k === 'l') { e.preventDefault(); openRuntimePlcDialog(); return; }
      if (k === 'v') { e.preventDefault(); toggleVarsPanel(); return; }
      // Ctrl+Shift+J：脚本日志（脚本里的 hmi.log/出错都在里面，运行页上看不到别的线索）
      if (k === 'j') { e.preventDefault(); toggleLogPanel(); return; }
      // Ctrl+Shift+Q：退出操作权限（现场把密码交回去了 —— 不用去翻有没有那个按钮）
      if (k === 'q') { e.preventDefault(); perm.lock('已退出权限'); return; }
      return;
    }
    if (e.key !== 'Escape') return;
    // 展开着的下拉框先收起来（最内层优先）
    if (document.querySelector('.w-combo.open')) { closeCombos(null); return; }
    // 正在输入框里按 Esc：只退出输入，别把整个运行模式关掉（变量监控的筛选框、值输入框都会踩到）
    if (typing) {
      document.activeElement.blur();
      return;
    }
    if (!numPad.classList.contains('hidden')) { closeNumPad(); return; }
    if (RUN_ONLY) return;      // 客户机：Esc 不退（退了也没编辑器可回，只会白屏）
    exitRun();
  });
  bus.on('vars:changed', ({ name }) => {
    if (!running || !name) return;
    refreshBoundEverywhere(name);
    padRangeVarChanged(name);   // 当限制用的变量变了 → 键盘上那条范围当场跟着改
  });
  // 操作权限变了（解锁/退出/自动上锁/等级被改）→ 重画控件角上的小锁 + 顶部那个"已解锁"小胶囊
  bus.on('perm:changed', () => { if (running) refreshPermMarks(); });
  // 设备状态一到（后端每秒推一次 / 退回模式下由 plcWatch 每 3 秒问一次）就把左下角提示刷新 —— 
  // 不这样就只能等 plcWatchTick 那一秒，接上/断开设备后提示会"慢一拍"，看着像没生效
  bus.on('plc:status', () => { if (running) updateInternalTip(); });
  // 下发失败 → 运行页面挂一条琥珀色提示（全屏运行时状态栏看不见，必须挂出来）
  bus.on('vars:write', ({ name, ok, message, kind }) => {
    if (!running) return;
    if (ok) { hideWriteAlarm(name); return; }
    showWriteAlarm(name, message, kind);
  });
  // 报警变化 → 刷新三个报警控件（它们不吃变量绑定，吃报警引擎的数据）
  // 报警条件里的变量必须在采集范围内，所以顺手重算一次本页采集范围
  bus.on('alarms:changed', () => { if (running) { refreshAlarmWidgets(); syncScope(); } });
  // 浏览器切回前台：补一次采集范围下发 + 拉一遍当前值（后台期间 SSE 可能被节流）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !running) return;
    scopeFp = '';
    syncScope();
    backend.readVars().then(v => varStore.applyRemote(v)).catch(() => { /* 后端没开就算了 */ });
  });
  // 下拉框（组合框）：用事件委托，控件 DOM 每次刷新重建也不用重新绑定
  document.addEventListener('click', onRuntimeClick);
  document.addEventListener('change', onAlarmChange);
  // 输入框打字 → 范围越界就当场标红（见 onRuntimeInput）：同样走委托，DOM 重建也不用重绑
  document.addEventListener('input', onRuntimeInput);
  initNumPad();
  initVarsFold();
  initLogPanel();

  // 缩放模式：原始 1:1 / 适应窗口（整幅都在窗内）/ 填满窗口（铺满，可能裁边）—— 记住上次选的
  zoomMode = loadZoomMode();
  document.getElementById('rtFit').addEventListener('click', cycleZoomMode);
  window.addEventListener('resize', () => {
    if (!running) return;
    applyRuntimeScale();
    if (popupStack.length) renderPopupLayer();
  });
}

/* ─────────── 变量监控抽屉：折叠 + 筛选 ─────────── */
const FOLD_KEY = 'hmi-rtv-folded';
let setVarsFoldedRef = null;   // 供右键菜单调用
let varFilter = '';
let rtvOnly = null;
let rtvNoBg = null;
const ONLY_KEY = 'hmi-vars-onlypage';
const NOBG_KEY = 'hmi-vars-nobg';
function initVarsFold() {
  const panel = document.getElementById('rtVarsPanel');
  const head = document.getElementById('rtvHead');
  const btn = document.getElementById('rtvFold');
  const filter = document.getElementById('rtvFilter');
  rtvOnly = document.getElementById('rtvOnly');
  if (rtvOnly) {
    let savedOnly = true;
    try { savedOnly = localStorage.getItem(ONLY_KEY) !== '0'; } catch { /* 忽略 */ }
    rtvOnly.checked = savedOnly;
    rtvOnly.addEventListener('change', () => {
      try { localStorage.setItem(ONLY_KEY, rtvOnly.checked ? '1' : '0'); } catch { /* 忽略 */ }
      if (running) renderVarsPanel();
    });
  }
  // 「不看后台」：波形通道（示波器）/报警条件这类一直在后台采的，跟当前画面无关，列表常被它们占满
  rtvNoBg = document.getElementById('rtvNoBg');
  if (rtvNoBg) {
    let savedNoBg = false;
    try { savedNoBg = localStorage.getItem(NOBG_KEY) === '1'; } catch { /* 忽略 */ }
    rtvNoBg.checked = savedNoBg;
    rtvNoBg.addEventListener('change', () => {
      try { localStorage.setItem(NOBG_KEY, rtvNoBg.checked ? '1' : '0'); } catch { /* 忽略 */ }
      if (running) renderVarsPanel();
    });
  }
  const setFolded = f => {
    panel.classList.toggle('folded', f);
    btn.textContent = f ? '▸' : '▾';
    btn.title = f ? '展开变量监控' : '折叠变量监控';
    try { localStorage.setItem(FOLD_KEY, f ? '1' : '0'); } catch { /* 忽略 */ }
    // 折叠/展开会改变可用区域 → 画面重新贴合（折叠后画面吃满整窗）
    if (running) {
      applyRuntimeScale();
      if (popupStack.length) renderPopupLayer();
    }
  };
  setVarsFoldedRef = setFolded;
  let saved = false;
  try { saved = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* 忽略 */ }
  setFolded(saved);
  // 整个标题栏都能折叠（徽标、箭头都在标题栏里，点哪都该有反应）
  head.addEventListener('click', () => setFolded(!panel.classList.contains('folded')));
  // 变量多了靠筛选找：名称或地址模糊匹配
  filter.addEventListener('input', () => {
    varFilter = filter.value.trim().toLowerCase();
    applyVarFilter();
  });
  filter.addEventListener('keydown', e => {
    if (e.key === 'Escape') { filter.value = ''; varFilter = ''; applyVarFilter(); }
  });
}

/** 按筛选词显示/隐藏变量行（用 Map 查，别再每行 find 一遍：上万变量时那是 O(n²)） */
function applyVarFilter() {
  renderVarsPanel();     // 窗口化列表：筛选 = 换一份数据，不再逐行 display（上万行时那样要遍历全部）
}

/* 运行态右键菜单用 */
export function isRunning() { return running; }

/* ── 操作权限：给右键菜单/别的模块用的两个小入口 ── */
/** 当前解锁到的等级名（'' = 没解锁） */
export const permLevelName = () => perm.currentLevelName();
/** 退出权限（交回操作权限） */
export function lockPerm(reason) { return perm.lock(reason || '已退出权限'); }
/* ⚠ 面板元素缓存一份：isVarsVisible 会被「每次变量变化」问一遍（500 个变量一起变就是
   500 次 getElementById），缓存下来省掉这些查找 */
let rtvPanelEl = null;
function rtvPanel() { return rtvPanelEl || (rtvPanelEl = document.getElementById('rtVarsPanel')); }
export function isVarsFolded() { return rtvPanel()?.classList.contains('folded') ?? false; }
export function toggleVarsFold() { setVarsFoldedRef?.(!isVarsFolded()); }
/* 整个变量监控面板的显示/隐藏（进运行态默认隐藏：主页面只有画面，右上角也不留东西） */
export function isVarsVisible() { return !rtvPanel()?.classList.contains('rt-hidden'); }
export function setVarsVisible(v) {
  const panel = document.getElementById('rtVarsPanel');
  if (!panel) return;
  const hide = !v;
  if (panel.classList.contains('rt-hidden') === hide) return;   // 状态没变就别白刷一遍
  panel.classList.toggle('rt-hidden', hide);
  if (!hide) {
    setVarsFoldedRef?.(false);      // 打开就展开列表（不是只露个标题栏）
    renderVarsPanel();              // 隐藏期间窗口化列表量不到高度，叫出来时按可见高度重画一遍
  }
  if (running) {
    applyRuntimeScale();
    if (popupStack.length) renderPopupLayer();
  }
}
export function toggleVarsPanel() {
  if (!RUN_ONLY) return setVarsVisible(!isVarsVisible());
  // 客户机：变量监控是给管理员调试用的，同样过一道密码（登录过一次就不再问）
  ensureAdmin('变量监控').then(ok => { if (ok) setVarsVisible(!isVarsVisible()); });
}

/* ─────────── 脚本日志面板（Ctrl+Shift+J） ───────────
   脚本里的 hmi.log/warn/运行错误以前只在脚本编辑器下面那条日志区里，
   而**运行页上连编辑器都没有** —— 现场出了事看不到任何线索。
   这里给运行态一个面板，两份数据：
     · 实时（默认）：内存里那份（每条脚本最近 60 行），合成一条时间线，带脚本名与级别
     · 服务器历史：读后端落盘的 logs/script-YYYY-MM-DD.log（按天，能前后翻天）
   规矩跟变量监控一致：进运行态默认收起；客户机（/run）上打开要管理员密码
   （面板里会露出变量值，跟变量监控一个性质）；详细面板要密码，但「脚本被停用」那条**人人可见**。 */
const LOG_FOLD_KEY = 'hmi-rtl-folded';
const LOG_DBG_KEY = 'hmi-rtl-dbg';
let rtlList = null, rtlMon = null;
let logVisible = false, logMode = 'live';       // 'live' 内存实时 | 'server' 服务器历史
let logDbg = false;                             // 显示 hmi.logNo 的调试输出（默认不显示，记在本机）
let logServer = null;                           // 服务器那份的结果（{lines, days, date, size, truncated}）
let logDay = '';                                // 服务器历史在看哪一天
let logErr = '';

function rtlPanel() { return document.getElementById('rtLogPanel'); }
export function isLogVisible() { return logVisible; }
export function setLogVisible(v) {
  const panel = rtlPanel();
  if (!panel) return;
  logVisible = !!v;
  panel.classList.toggle('rt-hidden', !logVisible);
  if (logVisible) renderLogPanel();
}
export function toggleLogPanel() {
  if (!RUN_ONLY) return setLogVisible(!logVisible);
  // 客户机：同上，调试用的面板要管理员密码
  ensureAdmin('脚本日志').then(ok => { if (ok) setLogVisible(!logVisible); });
}

/** 拉服务器上落盘的脚本日志（?date= 那天，最多 300 行） */
async function loadServerLog(day) {
  logMode = 'server';
  logErr = '';
  const res = await backend.readScriptLog(day || '', 300);
  if (!res) {
    logServer = null;
    logErr = '读不到服务器日志（后端没开 / 旧版后端没有这个接口）';
  } else {
    logServer = res;
    logDay = res.date;
  }
  renderLogPanel();
}

function renderLogPanel() {
  const box = document.getElementById('rtlList');
  if (!box) return;
  const count = document.getElementById('rtlCount');
  const badge = document.getElementById('rtlBadge');
  const dateBox = document.getElementById('rtlDate');
  document.getElementById('rtlHist')?.classList.toggle('hidden', logMode === 'server');
  document.getElementById('rtlLive')?.classList.toggle('hidden', logMode === 'live');
  dateBox?.classList.toggle('hidden', logMode !== 'server');
  document.getElementById('rtlClear')?.classList.toggle('hidden', logMode === 'server');
  // 「调试」勾选框只对**内存那份**有意义（落盘那份里本来就没有 hmi.logNo 的输出）
  document.getElementById('rtlDbgWrap')?.classList.toggle('hidden', logMode === 'server');

  const stat = scriptLogsAll(200, { dbg: logDbg });
  const disabled = stat.disabled;
  badge?.classList.toggle('hidden', !disabled.length);
  if (badge) badge.textContent = disabled.length ? `⚠ ${disabled.length} 个脚本已停用` : '';
  const esc2 = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmmss = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  if (logMode === 'server') {
    const days = logServer?.days || [];
    const i = days.indexOf(logDay);
    const prev = document.getElementById('rtlPrev');
    const next = document.getElementById('rtlNext');
    const dayEl = document.getElementById('rtlDay');
    if (dayEl) dayEl.textContent = logDay || '—';
    // days 是**倒序**（新的在前）：‹ 看更早那天 → 下标 +1
    if (prev) prev.disabled = !(i >= 0 && i + 1 < days.length);
    if (next) next.disabled = !(i > 0);
    const lines = logServer?.lines || [];
    count.textContent = logServer ? `（服务器 ${logDay}，${lines.length} 行）` : '';
    const head = logErr
      ? `<div class="rtl-note">${esc2(logErr)}</div>`
      : `<div class="rtl-note">服务器 logs/<b>script-${esc2(logDay)}.log</b>`
        + `${logServer?.size ? `（${(logServer.size / 1024).toFixed(0)} KB` : '（'}`
        + `${logServer?.max_mb ? `／每天最多 ${logServer.max_mb} MB` : ''}）`
        + `${logServer?.truncated ? '，只读了文件尾部' : ''}：最近 ${lines.length} 行</div>`;
    box.innerHTML = head + (lines.length
      ? lines.map(l => `<div class="rtl-line ${esc2(l.level)}">
          <span class="rtl-at">${esc2((l.at || '').slice(11) || '--:--:--')}</span>
          <span class="rtl-who">${esc2(l.name || '')}</span>
          <span class="rtl-txt">${esc2(l.text)}</span></div>`).join('')
      : '<div class="rtl-empty">这一天没有脚本日志。</div>');
    box.scrollTop = box.scrollHeight;
    return;
  }

  const lines = stat.lines || [];
  count.textContent = lines.length ? `（最近 ${lines.length} 行）` : '';
  const flow = disabled.length
    ? `<div class="rtl-note">⚠ <b>${disabled.map(d => esc2(d.name)).join('、')}</b> 连续出错已自动停用`
      + `（本次运行内不再执行；改好代码后再进一次运行态）</div>`
    : '';
  const dropped = stat.dropped
    ? `<div class="rtl-note">因限速/上限丢了 <b>${stat.dropped}</b> 行（脚本日志限速 20 行/秒/脚本）</div>`
    : '';
  // hmi.logNo 的调试输出默认不显示：说清"藏了几行、怎么打开"，别让人以为日志丢了
  const dbgNote = (!logDbg && stat.dbg)
    ? `<div class="rtl-note">还有 <b>${stat.dbg}</b> 行调试输出（<code>hmi.logNo</code>，只在内存里、不落盘）`
      + `—— 勾上面的「调试」就能看到</div>`
    : (logDbg && stat.dbg ? `<div class="rtl-note">调试输出（<code>hmi.logNo</code>）已显示，共 ${stat.dbg} 行</div>` : '');
  box.innerHTML = flow + dropped + dbgNote + (lines.length
    ? lines.map(l => `<div class="rtl-line ${esc2(l.level)}">
        <span class="rtl-at">${hhmmss(l.at)}</span>
        <span class="rtl-who" title="${esc2(l.name)}">${esc2(l.name)}</span>
        <span class="rtl-txt">${esc2(l.text)}</span></div>`).join('')
    : `<div class="rtl-empty">还没有脚本日志。脚本里写 <code>hmi.log('...')</code> 就会出现在这里，
        读服务器上落盘的那份点「服务器历史」；写脚本时打中间值用 <code>hmi.logNo(...)</code>（不落盘）。</div>`);
  box.scrollTop = box.scrollHeight;
}

function initLogPanel() {
  const panel = rtlPanel();
  if (!panel) return;
  rtlList = document.getElementById('rtlList');
  const head = document.getElementById('rtlHead');
  const btn = document.getElementById('rtlFold');
  const setFolded = f => {
    panel.classList.toggle('folded', f);
    btn.textContent = f ? '▸' : '▾';
    try { localStorage.setItem(LOG_FOLD_KEY, f ? '1' : '0'); } catch { /* 忽略 */ }
  };
  let saved = false;
  try { saved = localStorage.getItem(LOG_FOLD_KEY) === '1'; } catch { /* 忽略 */ }
  setFolded(saved);
  // 「调试」：显示 hmi.logNo 的输出（只在内存里那份里；选择记在本机）
  const dbgBox = document.getElementById('rtlDbg');
  if (dbgBox) {
    try { logDbg = localStorage.getItem(LOG_DBG_KEY) === '1'; } catch { /* 忽略 */ }
    dbgBox.checked = logDbg;
    dbgBox.addEventListener('change', () => {
      logDbg = dbgBox.checked;
      try { localStorage.setItem(LOG_DBG_KEY, logDbg ? '1' : '0'); } catch { /* 忽略 */ }
      renderLogPanel();
    });
  }
  head.addEventListener('click', () => setFolded(!panel.classList.contains('folded')));
  document.getElementById('rtlClear')?.addEventListener('click', () => { clearAllScriptLogs(); renderLogPanel(); });
  document.getElementById('rtlHist')?.addEventListener('click', () => {
    // 打开就停在"服务器上最新那天"（不一定等于本机今天：现场可能跨零点没刷新）
    loadServerLog('');
  });
  document.getElementById('rtlLive')?.addEventListener('click', () => { logMode = 'live'; renderLogPanel(); });
  document.getElementById('rtlPrev')?.addEventListener('click', () => {
    const days = logServer?.days || [];
    const i = days.indexOf(logDay);
    if (i >= 0 && i + 1 < days.length) loadServerLog(days[i + 1]);
  });
  document.getElementById('rtlNext')?.addEventListener('click', () => {
    const days = logServer?.days || [];
    const i = days.indexOf(logDay);
    if (i > 0) loadServerLog(days[i - 1]);
  });
  // 有新日志 / 有脚本被停用 → 面板开着就刷新。
  // ⚠ **合并刷新**（250ms 一次）：脚本可能 10ms 写一行（一秒上百行），每行都重画一次面板
  //   （200 个 DOM 行整块重建）会把主线程吃掉 → 画面卡顿、触摸操作发涩。
  //   日志是给人看的，4 次/秒足够；折叠着/没打开时干脆不画（打开时一次性渲染）。
  bus.on('script:log', () => {
    if (running && logVisible && logMode === 'live' && !panel.classList.contains('folded')) scheduleLogRender();
  });
  bus.on('scripts:changed', (ev) => {
    if (!running) return;
    // ⚠ 「有脚本被停用」这个徽标跟"看的是哪一份"无关（历史那一份也可能开着）→ 一律重画
    if (ev && ev.disabled) showScriptAlarm(ev.id);
    if (logVisible && !panel.classList.contains('folded')) scheduleLogRender();
  });
}

/* 面板重画的节流：最多 250ms 一次（脚本刷屏时不至于把帧率拖下去） */
const LOG_RENDER_MS = 250;
let logRenderTimer = null;
function scheduleLogRender() {
  if (logRenderTimer) return;
  logRenderTimer = setTimeout(() => { logRenderTimer = null; renderLogPanel(); }, LOG_RENDER_MS);
}

/* ── 「脚本被自动停用」提醒条 ──
   为什么值得单独喊一声：引擎干这事的理由是"连续出错 5 次"（多半是代码写错了/变量名打错了），
   停用是**为了保护界面**（不然日志刷屏、页面越来越卡）。但对现场来说，现象只是"这脚本不干活了"，
   不给提示根本查不出来。条子挂 20 秒（不常驻、不挡画面），详情在脚本日志面板里、也已落盘。 */
let scriptAlarmTimer = null;
function showScriptAlarm(id) {
  const box = document.getElementById('rtScriptAlarm');
  if (!box) return;
  const sc = project.getScript(id);
  const name = sc?.name || '脚本';
  const t = document.getElementById('rtScriptAlarmText');
  const sub = document.getElementById('rtScriptAlarmSub');
  if (t) t.textContent = `脚本「${name}」已自动停用`;
  if (sub) sub.textContent = '连续出错 5 次（本次运行内不再执行；Ctrl+Shift+J 看脚本日志）';
  box.classList.remove('hidden');
  box.classList.remove('flash');
  void box.offsetWidth;
  box.classList.add('flash');
  clearTimeout(scriptAlarmTimer);
  scriptAlarmTimer = setTimeout(hideScriptAlarm, 20000);
}
function hideScriptAlarm() {
  clearTimeout(scriptAlarmTimer);
  const box = document.getElementById('rtScriptAlarm');
  box?.classList.add('hidden');
  box?.classList.remove('flash');
}

/** 现在是不是「内部变量」模式（没接真 PLC、走内存模拟）—— 恢复初值只能在这种模式下做 */
export function isInternalVars() { return !plcStatus || plcStatus.mode === 'memory'; }

/** 内部变量恢复初值：把模拟值还原成变量表初值（联调改乱了、或看着像"改了没反应"时用） */
export async function resetInternalVars() {
  if (RUN_ONLY && !(await ensureAdmin('恢复初值'))) return 0;
  const vals = await backend.resetVars();
  if (vals && Object.keys(vals).length) varStore.applyRemote(vals);
  return Object.keys(vals || {}).length;
}

/* 画面缩放：三种模式，选中的记进 localStorage（下次进运行态照旧） */
const ZOOM_KEY = 'hmi-rt-zoom';
/** orig = 1:1 原始尺寸 · fit = 适应窗口（整幅都在窗内）· fill = 填满窗口（铺满，可能裁边） */
export const ZOOM_MODES = ['orig', 'fit', 'fill'];
export const ZOOM_CN = { orig: '原始尺寸 1:1', fit: '适应窗口', fill: '填满窗口' };
let zoomMode = 'fit';
function loadZoomMode() {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (ZOOM_MODES.includes(raw)) return raw;
    if (raw === '0') return 'orig';          // 老版本存的是 0/1（fitMode 布尔）
    if (raw === '1') return 'fit';
  } catch { /* 忽略 */ }
  return 'fit';
}
export function getZoomMode() { return zoomMode; }
export function setZoomMode(m) {
  if (!ZOOM_MODES.includes(m)) return;
  zoomMode = m;
  try { localStorage.setItem(ZOOM_KEY, m); } catch { /* 忽略 */ }
  applyRuntimeScale();
  if (popupStack.length) renderPopupLayer();
}
/** 依次切换：原始 → 适应 → 填满 → 原始（右键菜单/按钮/Ctrl+Shift+F 都走它） */
export function cycleZoomMode() {
  const i = ZOOM_MODES.indexOf(zoomMode);
  setZoomMode(ZOOM_MODES[(i + 1) % ZOOM_MODES.length]);
  return zoomMode;
}
/* 兼容旧调用（原来只有「适应 / 原始」两态） */
export function isFitMode() { return zoomMode === 'fit'; }
export function toggleFitMode() { return cycleZoomMode(); }

/* ─────────── 运行态快捷键提示 ───────────
   运行主页面一个按钮都不摆（现场全屏看画面），所以进运行态先飘一条快捷键说明，
   几秒后自动收起；点一下立刻收起；右键菜单里也能再叫出来。 */
const HINT_MS = 7000;
let hintTimer = null;
export function hideRuntimeHint() {
  clearTimeout(hintTimer);
  document.getElementById('rtHint')?.classList.add('hidden');
}
export function showRuntimeHint(ms = HINT_MS) {
  const el = document.getElementById('rtHint');
  if (!el) return;
  const K = (...keys) => keys.map(k => `<kbd>${k}</kbd>`).join('+');
  // 配了操作权限的工程：把「退出权限」那个键也写上（现场干完活要交回权限）
  const permTip = perm.isPermEnabled() ? `${K('Ctrl', 'Shift', 'Q')} 退出权限<span class="rt-hint-sep">·</span>` : '';
  el.innerHTML = RUN_ONLY
    // 客户机：只说它能干什么（改配置要密码，这里直接写明走法，省得现场摸不着）
    ? '<b>运行中</b><span class="rt-hint-sep">·</span>'
      + permTip
      + `${K('Ctrl', 'Shift', 'F')} 切换视图<span class="rt-hint-sep">·</span>`
      + `${K('Ctrl', 'Shift', 'L')} 改 PLC 连接<span class="rt-hint-sep">·</span>`
      + `${K('Ctrl', 'Shift', 'J')} 脚本日志<span class="rt-hint-sep">·</span>`
      + `${K('Ctrl', 'Shift', 'E')} 进组态编辑<span class="rt-hint-sep">·</span>`
      + '<span style="color:rgba(229,231,235,.55)">（E 进去要登录；L 要管理员密码）</span>'
    : '<b>快捷键</b><span class="rt-hint-sep">·</span>'
      + permTip
      + `${K('Esc')} 退出运行<span class="rt-hint-sep">·</span>`
      + `${K('Ctrl', 'Shift', 'L')} PLC 连接设置<span class="rt-hint-sep">·</span>`
      + `${K('Ctrl', 'Shift', 'V')} 变量监控<span class="rt-hint-sep">·</span>`
      + `${K('Ctrl', 'Shift', 'J')} 脚本日志<span class="rt-hint-sep">·</span>`
      + `${K('Ctrl', 'Shift', 'F')} 切换视图：原始/适应/填满`;
  el.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/** 客户机（/run）上按了「要管理员才能做」的键：说清楚 + 给出走法 */
const NEED_ADMIN_MS = 8000;
function needAdmin(what, hint) {
  const el = document.getElementById('rtHint');
  if (!el) return;
  el.innerHTML = `<b>${what}需要管理员</b><span class="rt-hint-sep">·</span>`
    + (hint || '这个页面只能运行和操作，改配置要密码登录：'
      + '<a href="/login" style="color:#60a5fa;text-decoration:underline">去登录</a>');
  el.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.add('hidden'), NEED_ADMIN_MS);
}

/** 这份页面是不是「给现场的只读运行页」（客户机开 /run） */
export function isRunOnly() { return RUN_ONLY; }

/**
 * 管理员验证（只在客户机 /run 上用）：
 * 现场运行页平时是只读的 —— 能看、能操作，但**改 PLC 连接信息**这类配置要过这一关。
 * 已经登录过（cookie 还在，12 小时）就直接放行，不用反复输密码。
 * @returns {Promise<boolean>} 验证通过 true；取消 / 密码错到底 false
 */
async function ensureAdmin(what) {
  const s = await backend.session().catch(() => null);
  if (!s || s.logged_in || s.auth_enabled === false) return true;   // 没开闸门 / 已登录
  const tb = await import('../editor/toolbar.js');
  return await new Promise(resolve => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearInterval(tick); resolve(v); } };
    tb.showDialog({
      title: '管理员验证',
      okText: '登录',
      body: `<div style="font-size:13px;line-height:1.8">
          <b>${what}</b>要管理员密码。<br>
          <span style="color:var(--text-2)">运行页平时只读：看数据、按按钮、输数值不用密码；
          改 PLC 连接/配置才需要这一步（登录后 12 小时内不用再输）。</span></div>
        <div class="f-row" style="margin-top:10px"><span class="f-label">密码</span>
          <input class="f-input" id="rtAdminPw" type="password" placeholder="管理员密码"></div>
        <div id="rtAdminMsg" style="color:var(--danger);font-size:12px;line-height:1.7;margin-top:8px"></div>`,
      onOk: async () => {
        const pw = document.getElementById('rtAdminPw')?.value || '';
        try {
          await backend.login(pw);
          finish(true);
          return true;                      // 关掉验证框
        } catch (e) {
          const m = document.getElementById('rtAdminMsg');
          if (m) m.textContent = '登录失败：' + (e?.message || e);
          return false;                     // 密码错：留着框让人重试
        }
      },
    });
    // 点「取消」/ 点遮罩关掉了 → 视为放弃（showDialog 没有 onCancel，用轮询兜底）
    const tick = setInterval(() => {
      if (document.getElementById('dlgMask')?.classList.contains('hidden')) finish(false);
    }, 250);
  });
}

/** 真正打开 PLC 连接设置（编辑器和运行页面共用这一个对话框） */
function reallyOpenPlcDialog() {
  import('../editor/toolbar.js')
    .then(m => m.openPlcDialog())
    .catch(e => {
      console.warn('[runtime] 打开 PLC 设置失败：', e);
      alert('打不开 PLC 连接设置：' + (e?.message || e));
    });
}
/** 打开组态编辑器：**直接换到 /**（浏览器和 pywebview 窗口都是同一个窗口换页，不开新窗口）。
    ⚠ 别改成调 window.pywebview.api 再让 Python 去 load_url/evaluate_js ——
      js_api 调用期间页面 JS 是阻塞的，Python 那边再回头操作页面会直接卡住（实测过）。 */

/** 运行中打开 PLC 连接设置（左上角按钮已隐藏，走 Ctrl+Shift+L 或右键菜单） */
export function openRuntimePlcDialog() {
  if (!RUN_ONLY) return reallyOpenPlcDialog();
  // 客户机：先过管理员验证（改连接信息 = 改配置），过了才给对话框
  ensureAdmin('PLC 连接设置').then(ok => { if (ok) reallyOpenPlcDialog(); });
}

/** 客户机上「进组态编辑」：**同一个地址**，服务端按登录状态决定给运行页还是编辑器 ——
    所以这里先问一句「登录着没」：登录着就直接跳 `/`（出来的就是编辑器）；
    没登录就跳 `/login`，输一次密码后自动进编辑器。
    （地址不拆开就是为了少一堆"走错页"的问题） */
export function enterEditorFromRuntime() {
  if (!RUN_ONLY) return exitRun();
  const go = (logged) => { location.href = logged ? (globalThis.__HMI_EDITOR_PATH__ || '/') : '/login'; };
  backend.session().then(s => go(!!(s && (s.logged_in || s.auth_enabled === false)))).catch(() => go(false));
}

/* ─────────── 运行画面缩放（原始 / 适应 / 填满） ─────────── */
/** 变量监控展开时右侧要避让的宽度（隐藏或折叠后返回 0，画面就能吃满整个窗口） */
function reservedRight() {
  const panel = document.getElementById('rtVarsPanel');
  if (!panel || panel.classList.contains('folded') || panel.classList.contains('rt-hidden')) return 0;
  const w = panel.getBoundingClientRect().width;
  return w ? w + 14 : 0;   // 面板 CSS 是 right:14px
}

function applyRuntimeScale() {
  const page = project.getPage(pageStack[pageStack.length - 1]);
  if (!page) return;
  const { w, h } = pageCanvasSize(page);
  const vw = window.innerWidth, vh = window.innerHeight;
  const availW = Math.max(160, vw - reservedRight() - FIT_PAD * 2);
  const availH = Math.max(120, vh - FIT_PAD * 2);
  if (zoomMode === 'orig') {
    // 原始：1:1，画布多大就多大（窗口小就自己滚/裁，不做任何缩放）
    scaleX = scaleY = 1;
    offsetX = (FIT_PAD + availW / 2) - vw / 2;
  } else if (zoomMode === 'fill') {
    // 填满：**横竖各自拉到可用区域大小**（铺满整窗、边上不留黑边），
    //   换来的是「页面里的控件一个不少全在窗内」—— 原来这里是取 max 等比放大
    //   （铺满但长边会被裁掉），现场反馈「控件被切掉了」，所以改成拉伸。
    //   可用区域 = 窗口减去变量监控展开占的那一条：抽屉一开，画面缩到左边继续铺满，
    //   不会被抽屉压住（填满也不留 FIT_PAD 那圈留白）
    const fillW = Math.max(160, vw - reservedRight());
    scaleX = fillW / w;
    scaleY = vh / h;
    offsetX = fillW / 2 - vw / 2;
  } else {
    // 适应：等比缩到整幅都在窗内（短边留黑边），不裁不拉
    const k = Math.max(0.1, Math.min(availW / w, availH / h));
    scaleX = scaleY = k;
    offsetX = (FIT_PAD + availW / 2) - vw / 2;
  }
  const parts = [];
  if (Math.abs(offsetX) > 0.5) parts.push(`translate(${offsetX.toFixed(1)}px, 0px)`);
  if (scaleX !== 1 || scaleY !== 1) {
    parts.push(scaleX === scaleY ? `scale(${scaleX})` : `scale(${scaleX}, ${scaleY})`);
  }
  rtPage.style.transform = parts.length ? parts.join(' ') : 'none';
  const btn = document.getElementById('rtFit');
  if (btn) {
    const px = Math.round(scaleX * 100), py = Math.round(scaleY * 100);
    btn.textContent = zoomMode === 'orig' ? '▣ 原始尺寸 100%'
      : zoomMode === 'fill' ? `⛶ 填满窗口 ${px}%×${py}%`
        : `⤢ 适应窗口 ${px}%`;
    btn.classList.toggle('active', zoomMode !== 'orig');
    btn.title = `当前：${ZOOM_CN[zoomMode]}（Ctrl+Shift+F 依次切换 原始 → 适应 → 填满）`;
  }
}

/** 弹窗卡片：与页面同一中心、同一缩放系数（填满模式是横竖各自的比例），加上用户拖拽偏移 */
function applyCardTransform(card, pan) {
  const x = (pan.x + offsetX).toFixed(1), y = pan.y.toFixed(1);
  card.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`
    + (scaleX === 1 && scaleY === 1 ? ''
      : scaleX === scaleY ? ` scale(${scaleX})` : ` scale(${scaleX}, ${scaleY})`);
}

/* ─────────── 进入 / 退出 ─────────── */
export async function enterRun() {
  running = true;
  // 进运行态 = 有人在看画面 → 向后端登记（后端从这一刻起才跟设备通讯），之后每 10 秒心跳一次。
  // 现场要求：编辑器里改画面时别占着 PLC 通讯口（见 server/poll_gate.py）。
  backend.setPolling(true);
  varStore.resetFrom(project.variables());
  bus.emit('selection:changed', { ids: [] });   // 清空编辑选中态（避免选择框残留）

  // 起始页：当前编辑页（若停弹窗/公共底上，则取第一个普通页 —— 底不是能"进"的画面）
  let start = project.currentId;
  if (project.getPage(start)?.type !== 'page') {
    start = project.pages().find(p => p.type === 'page')?.id;
  }
  pageStack = [start];
  popupStack = [];
  popupPan.clear();

  rtRoot.classList.remove('hidden');
  bus.emit('mode:changed', { mode: 'run' });

  renderPage();
  // 变量监控：进运行态**整个收起**（主页面只留画面，右上角也不占一角）——
  // Ctrl+Shift+V 或右键菜单随时叫出来；收起时顺手归位成「展开」，
  // 下次叫出来直接是变量列表而不是只露个标题栏。变量行仍在 DOM 里照常收推送，一开就是最新的
  setVarsVisible(false);
  setVarsFoldedRef?.(false);
  renderVarsPanel();
  // 脚本日志：同样进运行态先收起（Ctrl+Shift+J 叫出来），并回到"实时"那一份
  logMode = 'live';
  logServer = null;
  setLogVisible(false);
  hideScriptAlarm();
  hideWriteAlarm();          // 进运行态先清掉上一次的下发失败提示
  writeFailMuted = 0;
  applyRuntimeScale();
  layoutAlarmBars(rtPage);   // 报警条：量一下要不要滚
  showRuntimeHint();         // 主页面没有按钮 → 飘一条快捷键说明（几秒后自动收起）
  perm.refreshChip();        // 操作权限：解锁着的话把顶部小胶囊画出来（退出权限的入口）
  startAlarms();          // 报警引擎：进运行态开始判定（条件成立就记当前报警 + 历史）
  // 脚本引擎：**这一下只建档位**（清 hmi.g、按变量表重建每条脚本的日志），**不开跑** ——
  // 开跑要等下面把"现在在跟谁通讯"问清楚（armScripts）。见 scriptEngine 的 startScripts 说明。
  // ⚠ 必须在这一步（同步）做：它同时负责清空各脚本的日志，晚一步会把期间产生的日志抹掉。
  startScripts();

  /* ── 先问清楚"现在在跟谁通讯"，再让脚本真的跑起来 ──
     ⚠ 顺序是硬要求（现场踩过）：脚本第一拍就可能写变量，而写不写、算不算"内部仿真"
       全看接的是不是真设备。以前脚本先跑、设备状态后到，于是"接了 PLC 的工程"在头一拍
       被当成内部模拟：`hmi.sim()` 为真 → 仿真脚本抢着写那些本该由 PLC 给的量 →
       设备断着的时候每一笔都去等一个 socket 超时，界面上就是一屏「下发失败」。
       现在：状态先落地（含链路门要的 mode/online），再 armScripts() 开跑。 */
  const health = await backend.probe();
  if (backend.isOnline()) {
    // ① 先把**设备链路状态**喂给变量存储（它决定"要不要先读一遍、能不能操作"），
    //    再去下发采集范围、读当前值 —— 顺序反了的话，刚进运行态那一下会被判成
    //    "刚连上还没读到数据"，第一次操作白白被挡
    const st0 = await fetchPlcStatus().catch(() => null);
    if (st0) { plcStatus = st0; varStore.noteLink(st0.mode, !!st0.online); }
    // 变量表元数据（地址映射）+ **本页采集范围**：只轮询这一页用到的变量
    backend.syncVarTable(project.variables(), pageVarScope());
    try {
      const vars = await backend.readVars();
      varStore.applyRemote(vars);        // 读到数据了 → 这才允许操作变量
    } catch { /* 保持初值 */ }
    // 单条 / 批量两条路都接：后端一批变化会合成一条 {"vars":{…}}（500 个变量一起变时
    // 少掉 499 次 JSON.parse + 事件派发），老后端仍按一条一个变量发。
    backend.startEvents((name, value) => varStore.applyRemote({ [name]: value }),
      (vars) => varStore.applyRemote(vars));
  }
  updateInternalTip();       // 左下角数据源提示（模式已经确定了才画得对）
  refreshBackendBadge();
  armScripts();             // ★ 数据源模式确定了 → 脚本这才开始触发
  startPlcWatch();          // 运行中盯着 PLC：掉线就一直挂在上面，每 10 秒再提醒一次
}

export function exitRun() {
  // 客户机页面（/run）没有编辑器可回：退出去只会剩一片空白，所以不退
  if (RUN_ONLY) return;
  running = false;
  stopPlcWatch();
  stopAlarms();           // 报警引擎停掉（历史已经落盘：服务器 + 本机兜底，不会丢）
  perm.resetPerm();       // 退出运行态 = 把操作权限也交回去（下次进来重新输密码）
  stopScripts();          // 脚本引擎停掉（定时器全清，别在编辑态继续跑）；退出前会把没送出的日志送掉
  setLogVisible(false);   // 脚本日志面板跟着收掉
  hideScriptAlarm();
  closeCombos(null);
  hideRuntimeHint();      // 快捷键提示别漏到编辑态
  backend.stopEvents();
  // 退出运行态 = 没人在看画面了 → 注销登记（后端一个客户端都不剩时就不再跟设备通讯）
  backend.setPolling(false);
  if (numPad) closeNumPad();
  rtRoot.classList.add('hidden');
  popupLayer.innerHTML = '';
  popupStack = [];
  popupPan.clear();
  clearScopeKeep();       // 退出运行：保留窗口和定时器一起清掉
  scaleK = scaleX = scaleY = 1;
  rtPage.style.transform = 'none';
  bus.emit('mode:changed', { mode: 'edit' });
}

/* ─────────── PLC 掉线提醒 ───────────
   运行页面里如果 TCP 断了（后端连不上 PLC / 一直读失败），顶部挂一条红条，
   并且每 remindMs（默认 10 秒）再闪一下提醒 —— 现场没人盯状态栏，掉线要主动喊。
   恢复后闪一条绿的再收起。间隔可在控制台里调：app.plcWatch.remindMs = 5000       */
const PLC_WATCH = { pollMs: 3000, remindMs: 10000, okShowMs: 4000 };
/** 现场/测试可调：app.plcWatch.remindMs = 5000（不设就用上面的默认值） */
function watchCfg() { return { ...PLC_WATCH, ...(globalThis.app?.plcWatch || {}) }; }
let plcTimer = null;
let plcStatus = null;        // 最近一次 /api/plc 的 status
let plcTick = 0;
let plcOfflineSince = 0;     // 本次掉线从什么时候开始（0 = 当前在线）
let plcLastRemind = 0;       // 上次"再提醒"的时刻
let plcOkAt = 0;             // 刚恢复的时刻（绿条显示 4 秒）
let plcEverHadPlc = false;   // 见过一次 mode=plc（后端自己挂了也要提醒）

function plcAlarmEls() {
  return {
    box: document.getElementById('rtPlcAlarm'),
    text: document.getElementById('rtPlcAlarmText'),
    sub: document.getElementById('rtPlcAlarmSub'),
  };
}

/* ─────────── 下发失败提示条 ───────────
   全屏运行时看不到底部状态栏，写 PLC 失败必须像掉线一样主动喊出来：
   ⚠ 下发失败（变量名） + 后端给的原因（只读 / 地址无效 / 设备离线…）。
   ⚠ **链路门挡下的那种不算**（没连上 / 刚连上还没读到数据）：那种**一个请求都没发**、
   值也已经恢复成设备上的那份，现场要求"别弹、别挂"—— 运行画面顶上那条「PLC 已断开」
   红条已经把话说清楚了（原因仍写进控制台，见 varstore.blocked）。
   成功写一次就把对应那条收掉（用户要的「成功自动消失」）。

   ── 一串失败不能再刷成一串提示（现场原话：「如果变量很多，弹完全部失败的命令才停」）──
   ① 设备断了（kind='link'，或链路本来就是断的）：**根本不该弹这一条** ——
      顶上那条红条已经在说"设备断了"，这里再一条条报"某某变量下发失败"纯属噪音。
      只默默记个数（恢复后清掉），必要时在控制台里看得见。
   ② 设备好好的、只是几个变量本身写不了（地址错/只读）：**只挂一条**，
      名字按第一个失败的算，后面再来就累加"等 N 个变量" —— 一次操作里挂了 5 个变量，
      现场看到的是"5 个变量有问题"，而不是被刷 5 次、每次都以为只错了最后一个。 */
let writeAlarmTimer = null;
let writeAlarmNames = new Set();      // 这一条提示条覆盖了哪些变量
let writeFailMuted = 0;               // 设备断开期间被压掉的失败笔数（恢复后归零）

/** 设备链路现在是不是断的（断着的时候失败提示一律压掉，交给顶部红条说话） */
function deviceLinkDown() {
  if (!backend.isDeviceMode()) return false;
  return backend.plcLink?.online !== true;
}

function showWriteAlarm(name, message, kind) {
  const box = document.getElementById('rtWriteAlarm');
  if (!box) return;
  // ① 设备断了 → 不弹（顶部红条负责说这件事），只记一笔
  if (kind === 'link' || deviceLinkDown()) {
    writeFailMuted++;
    console.warn(`[runtime] 设备已断开，压掉第 ${writeFailMuted} 条下发失败提示：${name} ${message || ''}`);
    return;
  }
  writeFailMuted = 0;
  const text = document.getElementById('rtWriteAlarmText');
  const sub = document.getElementById('rtWriteAlarmSub');
  const wasShowing = !box.classList.contains('hidden');
  // ② 已经挂着同一条了 → 只累加，**不换名字**（换名字看着就像"又刷了一条"，正是要治的）
  if (wasShowing) {
    writeAlarmNames.add(name);
    const first = text.dataset.first || name;
    text.textContent = writeAlarmNames.size > 1
      ? `下发失败（${first} 等 ${writeAlarmNames.size} 个变量）`
      : `下发失败（${first}）`;
  } else {
    writeAlarmNames = new Set([name]);
    text.dataset.first = name || '';
    text.textContent = `下发失败（${name || '变量'}）`;
  }
  sub.textContent = message || 'PLC 没有接受这次写入（值已按设备真实值回读）';
  box.classList.remove('hidden');
  box.classList.remove('flash');
  void box.offsetWidth;               // 重启动画：连续失败时能看见"又失败了一次"
  box.classList.add('flash');
  clearTimeout(writeAlarmTimer);
  writeAlarmTimer = setTimeout(() => hideWriteAlarm(), 6000);   // 6 秒后自己收（避免一直挂着）
}
function hideWriteAlarm(name) {
  const box = document.getElementById('rtWriteAlarm');
  if (!box || box.classList.contains('hidden')) return;
  // 只有"写成功了这条里点过名的变量"才收条；别的变量写成功不该把这条挤掉
  const text = document.getElementById('rtWriteAlarmText');
  if (name && !writeAlarmNames.has(name)) return;
  clearTimeout(writeAlarmTimer);
  box.classList.add('hidden');
  box.classList.remove('flash');
  writeAlarmNames = new Set();
  if (text) text.dataset.first = '';
}

/* ─────────── 现在在跟谁通讯：PLC / OPC UA / 内部变量 ───────────
 *
 * ⚠ 这一节是「接了 PLC 就不许悄悄退化成内部变量模式」的唯一判据来源。
 *
 * 以前 isSim() 和左下角提示都只看运行态自己那份 `plcStatus`，而它是**进运行态时才去取的**：
 * 取回来之前是 null → 于是"接了 PLC 的工程"在头一拍被当成"没接设备"——
 *   · `hmi.sim()` 返回 true → 演示/仿真脚本抢着往 PLC 变量上写；
 *   · 左下角写「内部变量运行中（未接 PLC）」，现场以为配好的 PLC 没生效；
 *   · 链路门也不认这是设备链路 → 那些写真的发了出去。
 * 设备断着的时候更糟：每一笔写都去等一个 1.5 秒的 socket 超时，串成一屏「下发失败」。
 *
 * 现在统一按 **配置模式** 判（后端每秒推的 `mode`，权威且掉线期间也仍然是 'plc'/'opcua'），
 * 只有"问不出模式"的那一小段才算未知 —— 未知时**按接了设备处理**（保守一侧）：
 * 少跑一次仿真脚本没关系，往 PLC 上乱写不行。 */
function dataMode() {
  const m = backend.plcLink?.mode || plcStatus?.mode || '';
  if (m === 'plc' || m === 'opcua') return m;
  if (m === 'memory') return 'memory';
  // 模式还没问出来：后端都没连上 / file:// 直开 → 确实是本地模拟；后端在线但模式未知 = 未知
  return backend.isOnline() ? '' : 'memory';
}

/** 内部变量（地址留空）有几个 —— 它们**不下发设备**（Modbus TCP / OPC UA 都不发），
 *  值就活在 HMI 里。左下角提示里报个数，现场一眼知道哪些量跟 PLC 无关。 */
function internalVarCount() {
  try {
    return project.variables().filter(v => !String(v.address || '').trim()).length;
  } catch { return 0; }
}

/* ─────────── 运行态左下角的数据源提示 ───────────
 *
 * 运行态一直挂着一条，说的就是现场最关心的那件事：**现在这些变量是往哪儿走的**。
 *   · 接设备   → `PLC 变量传输中（127.0.0.1:502）`（掉线时转红：`PLC 已断开（…）`）
 *   · 内存模拟 → `内部变量运行中（未接 PLC）· 内部变量 12 个`（琥珀色）
 *
 * ⚠ 以前只在"没接设备"时才显示，接上设备就消失 —— 现场反而看不出来到底在跟谁通讯；
 *   而且它按 `plcStatus` 判，进运行态头一拍（还没取到状态）会**谎报**"未接 PLC"，
 *   明明配着 PLC 的工程看着像没生效（"自动切到内部变量模式"就是这么来的）。
 *   现在按配置模式判（见 dataMode），并且**常显**。
 *
 * 提示文字只留短句，细节（内部变量几个 / 设备地址 / 采集范围）全放 title —— 触摸屏上不占地方。 */
function updateInternalTip() {
  const el = document.getElementById('rtInternalTip');
  if (!el) return;
  const mode = dataMode();
  const nInner = internalVarCount();
  const innerTxt = nInner ? ` · 内部变量 ${nInner} 个` : '';
  if (mode === 'plc' || mode === 'opcua') {
    const dev = mode === 'opcua' ? 'OPC UA' : 'PLC';
    const where = backend.deviceWhere();
    const online = backend.plcLink?.online === true;
    el.textContent = online
      ? `${dev} 变量传输中${where ? `（${where}）` : ''}`
      : `${dev} 已断开${where ? `（${where}）` : ''}`;
    el.title = (online
      ? `${dev} 变量传输中：变量表里有地址的变量按地址跟设备读写。`
      : `${dev} 连不上：这期间的写不下发（顶部红条给了原因），恢复后会先重读一遍现场数据。`)
      + (nInner ? `\n其中 ${nInner} 个变量地址留空 = 内部变量，只活在 HMI 里，`
        + `**不走 Modbus TCP / OPC UA**（本页用不到就随页面一起走）。` : '');
    el.classList.remove('hidden');
    el.classList.toggle('warn', !online);
    el.classList.toggle('info', online);
    return;
  }
  el.textContent = (mode === 'memory' && backend.isOnline()
    ? '内部变量运行中（未接 PLC）'
    : '内部变量运行中（后端离线）') + innerTxt;
  el.title = '现在没有接真实设备（PLC / OPC UA）：变量值由 HMI / 后端内存维护，一个字节都不往设备发。\n'
    + '要接设备：Ctrl+Shift+L 打开「PLC 连接设置」填好 IP/端口再点「确定」。'
    + (nInner ? `\n变量表里地址留空的 ${nInner} 个就是内部变量 —— 接了设备以后它们同样不下发。` : '');
  el.classList.remove('hidden', 'info');
  el.classList.add('warn');
}

function renderPlcAlarm(offline, where, why, now) {
  const { box, text, sub } = plcAlarmEls();
  if (!box) return;
  const cfg = watchCfg();
  const dev = plcStatus?.protocol === 'opcua' || plcStatus?.mode === 'opcua' ? 'OPC UA' : 'PLC';
  if (offline) {
    // 现场要求**只说两件事**：哪台断了（IP/端点）+ 断了多久。
    // 后端那句原因（timed out / 连不上…）和"掉线期间的值不下发、恢复后重读"那串说明都不往屏幕上摆
    // —— 挂在 title 上：浏览器里鼠标停一下还能看到，触摸屏上不占地方。
    const secs = Math.max(1, Math.round((now - plcOfflineSince) / 1000));
    text.textContent = `${dev} 已断开（${where}）`;
    sub.textContent = `已断开 ${secs} 秒`;
    sub.title = why || '';
    box.classList.remove('hidden', 'ok');
    if (now - plcLastRemind >= cfg.remindMs) {             // 每 remindMs 再提醒一次
      plcLastRemind = now;
      box.classList.remove('flash');
      void box.offsetWidth;                                // 重启动画
      box.classList.add('flash');
    }
  } else if (plcOkAt && now - plcOkAt < cfg.okShowMs) {
    text.textContent = `${dev} 已恢复连接`;
    sub.textContent = plcResyncMsg || where;
    sub.title = '';
    box.classList.remove('hidden', 'flash');
    box.classList.add('ok');
  } else {
    box.classList.add('hidden');
    box.classList.remove('flash', 'ok');
  }
}

/** 掉线期间界面上的值是"旧的"，恢复连接后必须先把现场数据重新读下来再用
 *  （否则用户看着旧值去改，很容易把错的数写进 PLC —— 现场最怕这个） */
let plcResyncMsg = '';

async function resyncAfterReconnect() {
  try {
    const before = new Map(Object.entries(varStore.values));
    await varStore.resync();                      // 把设备上的真实值整套读回来
    let changed = 0, total = 0;
    Object.entries(varStore.values).forEach(([name, value]) => {
      if (!before.has(name)) return;
      total++;
      if (before.get(name) !== value) changed++;
    });
    plcResyncMsg = `已重新读取现场数据（${total} 个变量，其中 ${changed} 个和界面上不一样，已更新）`;
  } catch {
    plcResyncMsg = '已重新读取现场数据';
  }
  renderPlcAlarm(false, '', '', Date.now());
}

async function plcWatchTick() {
  if (!running) return;
  const now = Date.now();
  if (plcTick++ % Math.max(1, Math.round(watchCfg().pollMs / 1000)) === 0) {
    plcStatus = await fetchPlcStatus();
  }
  const isDev = plcStatus?.mode === 'plc' || plcStatus?.mode === 'opcua';
  if (isDev) plcEverHadPlc = true;
  // 链路状态喂给变量存储：没连上**不发写请求**、连上后**先读到数据**才允许操作（见 varstore 的链路门）
  varStore.noteLink(plcStatus?.mode, !!plcStatus?.online);
  // 掉线判定：① 接了设备（Modbus PLC 或 OPC UA）但不在线  ② 连后端都问不到了（且本来接的是设备）
  const offline = plcStatus ? (isDev && !plcStatus.online)
    : (plcEverHadPlc && backend.expectsServer());
  const where = (plcStatus?.protocol === 'opcua' || plcStatus?.mode === 'opcua')
    ? (plcStatus.endpoint || '（OPC UA）')
    : (plcStatus?.host ? `${plcStatus.host}:${plcStatus.port}` : '（连不上后端服务）');
  const why = plcStatus ? (plcStatus.last_error || '') : '后端服务可能已停止';
  updateInternalTip();          // 内部变量提示跟着数据源状态走（memory/离线 → 显示）
  refreshBackendBadge();        // 变量监控顶上那颗标签：PLC 在线/离线 + 本页采多少（每秒跟着刷）
  // 设备在线但这条链路上还没读到数据 → 立刻补读一遍（"连接成功后必须先读一遍才能操作"）
  if (varStore.needsFirstRead()) {
    backend.readVars().then(v => varStore.applyRemote(v)).catch(() => { /* 读不到就继续等下一轮 */ });
  }
  if (offline && !plcOfflineSince) { plcOfflineSince = now; plcLastRemind = 0; }
  if (!offline && plcOfflineSince) {
    // 刚恢复：先把现场数据重新读下来（掉线期间界面上的值是旧的），再显示绿条
    plcOkAt = now; plcOfflineSince = 0;
    writeFailMuted = 0;          // 掉线期间压掉的那些失败提示计数归零
    await resyncAfterReconnect();
  }
  renderPlcAlarm(offline, where, why, now);
}

async function fetchPlcStatus() {
  try {
    const j = await backend.getPlc();
    return j?.status || null;
  } catch { return null; }
}

function startPlcWatch() {
  stopPlcWatch();
  plcTick = 0; plcOfflineSince = 0; plcLastRemind = 0; plcOkAt = 0; plcEverHadPlc = false;
  const { box } = plcAlarmEls();
  if (box) box.classList.add('hidden');
  plcTimer = setInterval(() => { plcWatchTick().catch(() => {}); }, 1000);
  plcWatchTick().catch(() => {});
}

function stopPlcWatch() {
  if (plcTimer) { clearInterval(plcTimer); plcTimer = null; }
  const { box } = plcAlarmEls();
  if (box) box.classList.add('hidden');
  plcStatus = null; plcOfflineSince = 0; plcOkAt = 0;
}

/** 变量监控顶上那颗小标签：**现在在跟谁通讯、这一页采多少** ——
 *  现场看画面时不用去翻编辑器状态栏（运行页面里那条状态栏常常被画面盖着），
 *  一开变量监控（Ctrl+Shift+V）就能在最顶上看到「PLC 在线 · 本页 13 变量/6 块」。
 *  ⚠ 这一行在 `.rtv-head` 里，是面板的固定头（列表滚动时不会被顶走）。 */
function refreshBackendBadge() {
  const badge = document.getElementById('rtvMode');
  if (!badge) return;
  const online = backend.isOnline();
  const scoped = online && backend.supports('page_scope');
  const link = backend.plcLink || {};
  const sc = backend.scope || {};
  const scopeTxt = scoped && sc.scoped && sc.active !== undefined
    ? ` · 本页 ${sc.active} 变量/${sc.blocks} 块` : '';
  const dev = link.mode === 'plc' || link.mode === 'opcua';
  const devName = link.mode === 'opcua' ? 'OPC UA' : 'PLC';
  if (!online) {
    badge.textContent = '本地模拟';
    badge.className = 'badge orange';
    badge.title = '后端没连上：用本地模拟数据（写值不会下发 PLC）';
  } else if (!scoped) {
    // 旧后端会忽略「本页采集范围」，还是全量轮询 —— 说清楚，不然用户以为按页采集没生效
    badge.textContent = '后端旧版·全量采集';
    badge.className = 'badge orange';
    badge.title = '后端还是旧版本，缺 page_scope：它会把变量表里所有变量都轮询一遍。\n'
      + '关掉后端重新运行 start_server.bat 之后，就只采当前页面用到的（+ 报警条件 + 波形通道）。';
  } else if (dev) {
    badge.textContent = `${devName} ${link.online ? '在线' : '离线'}${scopeTxt}`;
    badge.className = 'badge ' + (link.online ? 'blue' : 'orange');
    badge.title = `${devName}：${link.online ? '已连接，正在采' : '连不上（顶部红条给了原因）'}`
      + (scopeTxt ? `\n按页采集：本页在采 ${sc.active} 个变量，地址合并成 ${sc.blocks} 次读`
        + '\n（切页面会重新下发采集范围；轮询在后端跑）' : '');
  } else {
    badge.textContent = '内存模拟' + scopeTxt;
    badge.className = 'badge';
    badge.title = '没接设备：值由后端内存维护（内部变量、脚本算出来的量都在这儿）'
      + (scopeTxt ? `\n本页用到 ${sc.active} 个变量` : '');
  }
  backend.paintStatusBar();      // 状态栏那颗灯统一由 backend 画（含「后端是旧版本」的提示）
}
bus.on('backend:status', refreshBackendBadge);

/** 下发结果：写 PLC 失败要立刻看得见，不然「界面变了、PLC 没变」最难查。
 *  ⚠ 链路门挡下的那种（没连上/还没读到数据）**根本不发 vars:write**，所以这里也不会走到
 *  —— 现场要求"没连上就别弹提示"，原因只在控制台/日志里（见 varstore.blocked）。 */
function refreshWriteBadge(ev) {
  const el = document.getElementById('stWrite');
  if (!el) return;
  if (!ev) {
    el.className = 'st-write hidden';
    return;
  }
  if (ev.ok) {
    el.className = 'st-write ok';
    el.textContent = `下发正常（${ev.name}）`;
    el.title = `最近一次下发成功：${ev.name} = ${ev.value}`;
  } else {
    el.className = 'st-write bad';
    el.textContent = `⚠ 下发失败（${ev.name}）`;
    el.title = `写 ${ev.name} = ${ev.value} 失败：${ev.message}\n` +
      '值只改在界面上，PLC 没收到。检查：变量地址、站号、PLC 是否允许该区域写入（%IW/%IX 只读）';
  }
}
bus.on('vars:write', refreshWriteBadge);

/* ─────────── 页面渲染 ─────────── */
function pageCanvasSize(page) {
  if (page.type === 'popup') return { w: page.popupW || 420, h: page.popupH || 240 };
  return { w: project.data.meta.canvas.w, h: project.data.meta.canvas.h };
}

function renderPage() {
  const id = pageStack[pageStack.length - 1];
  const page = project.getPage(id);
  if (!page) return;
  // 换页了 → 把「刚离开的那一页」放进保留窗口（见 pageVarScope 上面那段说明）
  if (lastRenderedPage && lastRenderedPage !== id) markPageLeft(lastRenderedPage);
  lastRenderedPage = id;
  const { w, h } = pageCanvasSize(page);
  rtPage.style.width = w + 'px';
  rtPage.style.height = h + 'px';
  rtPage.style.background = project.data.meta.canvas.bg || '#fff';
  rtPage.innerHTML = '';
  pageRendered = [];
  // 公共底：先画底那一层（在下面），页面自己的控件盖上去。
  // 底上的控件**照常进 pageRendered** —— 运行态要能点（公共导航条）、要能亮（灯/文本绑变量）、
  // 要按变量刷新，所以它和页面控件走同一套 buildWidget 逻辑，只是 z 整体低一层。
  const { base, off } = project.pageLayers(page);
  // ⚠ 先攒进 DocumentFragment 再一次性挂上：500 个控件逐个 appendChild 会触发 500 次
  //   样式/布局失效，攒起来只失效一次（首屏进运行态明显更快）
  const frag = document.createDocumentFragment();
  if (base) base.widgets.forEach(wgt => {
    const el = buildWidget(wgt);          // 底层不加偏移
    frag.appendChild(el);
    pageRendered.push({ w: wgt, el });
  });
  page.widgets.forEach(wgt => {
    const el = buildWidget(wgt, off);     // 页面这层整体加偏移 → 一定盖在底上面
    frag.appendChild(el);
    pageRendered.push({ w: wgt, el });     // 建索引用（别在刷新时再 querySelector 找一遍）
  });
  rtPage.appendChild(frag);
  reindexRendered();
  applyRuntimeScale();   // 换页后按新页面尺寸重算缩放
  // ⚠️ 换页后必须**重新量一次**报警条「要不要滚」（alarmBar.js 的 layoutBar：量一份内容多宽 → 写 .roll 类 + --ab-dur）。
  //    不调会怎样：换页新画出来的报警条没有 .roll/--ab-dur，CSS 动画不上 → **卡住不动**，而且不报任何错。
  //    用户报的现象正是这个：报警条画在**公共底**上时，第 1 个页面（进运行态时 layout 过）正常滚，
  //    换到第 2 个页面就停；等报警内容变化触发 refreshAlarmWidgets()（它里面有 layoutAlarmBars）才又动起来。
  //    放在 applyRuntimeScale() 之后量 —— 那时的宽度才是缩放后的真实值。
  layoutAlarmBars(rtPage);
  syncScope();           // 换了页面 → 只采这一页用到的变量（多余的别占通讯）
}


/* ── 按页采集 ──────────────────────────────────────────────────────
   采集范围 = 当前页面（+ 打开着的弹窗）用到的变量 + **报警条件里的变量**
   （不在范围里报警永远不会触发）+ **波形通道变量（所有页面的波形都算）**。
   别的变量不占通讯带宽。切页面/开关弹窗/改报警都重新下发一次。

   为什么波形要例外：trend.js 的采样是扫**所有页面**的波形控件一直在跑的
   （不是"这一页才画"就不采），如果切走就不采了，那段时间波形里就是一段死值 ——
   用户明确说过「抓取数据这个如果是波形是可以抓取的」。

   注意：实际轮询是在 Python 后端跑的，所以浏览器切到后台、页面失去焦点都照旧通讯。 */

/* ── 离开页面后的「保留采集」窗口（默认关）────────────────────────────
   切走的那一页用到的变量**不立刻退出采集范围**，再多采 keepMs 毫秒：
   来回切页（主画面 ↔ 参数设定）时，切回来的那一下读到的还是连续数据，
   不会出现一段「切走期间没人读」的死值。
   **默认 0（不保留）**：切走就不采，切回来 100ms 内就刷新，看不出差别；
   留着 30 秒反而会让「在采的变量数」一路涨（来回翻几页就下不来）。
   现场想开：app.scopeKeep.keepMs = 10000。 */
const SCOPE_KEEP = { keepMs: 0 };
const recentPages = new Map();      // pageId -> 切走时刻（performance.now()）
const keepTimers = new Map();       // pageId -> 到期把该页收回采集范围的定时器
let lastRenderedPage = null;
function scopeKeepMs() {
  const v = globalThis.app?.scopeKeep?.keepMs;
  return Math.max(0, Number(v ?? SCOPE_KEEP.keepMs) || 0);
}
/** 记下「刚离开这一页」；窗口到期后再把它收回采集范围（回收时要重算一次范围） */
function markPageLeft(id) {
  const keepMs = scopeKeepMs();
  if (!id || !keepMs) return;
  recentPages.set(id, performance.now());
  clearTimeout(keepTimers.get(id));
  keepTimers.set(id, setTimeout(() => {
    keepTimers.delete(id);
    recentPages.delete(id);
    if (running) syncScope();
  }, keepMs + 50));
}
function clearScopeKeep() {
  keepTimers.forEach(t => clearTimeout(t));
  keepTimers.clear();
  recentPages.clear();
  lastRenderedPage = null;
}
/** 收一页用到的所有变量名（绑定 / 多通道绑定 / 波形通道键 / 动作变量）
 *  公共底上的控件也算这一页在用的（它们就画在这一页上，不采就是"底上的灯永远不亮"） */
function collectPageVars(pg, names) {
  if (!pg) return;
  project.renderWidgets(pg).forEach(w => {
    if (w.bindings?.variable) names.add(w.bindings.variable);
    (w.bindings?.variables || []).forEach(n => n && names.add(n));
    Object.keys(w.props?.colors || {}).forEach(n => n && names.add(n));    // 波形通道颜色/量程键
    Object.keys(w.props?.scales || {}).forEach(n => n && names.add(n));
    (w.actions || []).forEach(a => { if (a.params?.variable) names.add(a.params.variable); });
    // 输入范围限制里当上下限用的变量：**也必须在采集范围里**。
    // 不采就永远读到 undefined → 那一端限制静默失效（看着配了范围、实际一个值都不拦），
    // 这正是这个功能要防的事，所以跟绑定变量一视同仁地收进来。
    if (w.props?.rangeOn) {
      if (w.props.rangeMinMode === 'var' && w.props.rangeMinVar) names.add(w.props.rangeMinVar);
      if (w.props.rangeMaxMode === 'var' && w.props.rangeMaxVar) names.add(w.props.rangeMaxVar);
    }
  });
}

let scopeFp = '';
/** 采集范围分四份算出来（变量监控里要说清「这一页怎么采了这么多」）：
 *  self  = 本页控件（含公共底）+ 打开着的弹窗
 *  keep  = 刚离开、还在保留窗口里的页面（keepMs，默认 0 = 不保留）
 *  trend = 波形通道（所有页面的波形都算，跨页面不能断）
 *  alarm = 报警条件变量（不在范围里报警永远不会触发） */
function scopeParts() {
  const self = new Set(), keep = new Set(), trend = new Set(), alarm = new Set();
  const cur = pageStack[pageStack.length - 1];
  [cur, ...popupStack.map(p => p.id)].filter(Boolean)
    .forEach(id => collectPageVars(project.getPage(id), self));
  // 刚离开、还在保留窗口里的页面 → 变量继续采（keepMs 默认 0：纯按页采集，不留）
  const keepMs = scopeKeepMs();
  if (keepMs > 0) {
    const now = performance.now();
    recentPages.forEach((t, id) => {
      if (id === cur) { recentPages.delete(id); return; }
      if (now - t > keepMs) { recentPages.delete(id); return; }
      collectPageVars(project.getPage(id), keep);
    });
  }
  // 波形通道：跨页面一直在采（见上面说明），所以任何一页都要把它们算进来。
  // 波形控件清单走 trend.js 的缓存（那儿已经有「所有页面扫一遍」的结果，别在这儿重扫）
  allTrendWidgets().forEach(w => {
    (w.bindings?.variables || []).forEach(n => n && trend.add(n));
    Object.keys(w.props?.colors || {}).forEach(n => n && trend.add(n));
    Object.keys(w.props?.scales || {}).forEach(n => n && trend.add(n));
  });
  project.alarms().forEach(a => { if (a.enabled !== false && a.variable) alarm.add(a.variable); });
  const known = new Set(project.variables().map(v => v.name));
  const only = s => new Set([...s].filter(n => known.has(n)));
  const parts = { self: only(self), keep: only(keep), trend: only(trend), alarm: only(alarm) };
  parts.names = new Set([...parts.self, ...parts.keep, ...parts.trend, ...parts.alarm]);
  return parts;
}
let currentParts = { self: new Set(), keep: new Set(), trend: new Set(), alarm: new Set(), names: new Set() };
/** 当前采集范围的变量名（本页 + 报警条件 + 波形通道 [+ 保留窗口里的上一页]；测试/脚本可用） */
export function pageVarScope() { return [...scopeParts().names]; }
/** 给调试/现场看的范围明细（app.scopeSummary() 用）：四份各几个 + 合计 */
export function scopeSummary() {
  const p = scopeParts();
  return { self: p.self.size, keep: p.keep.size, trend: p.trend.size, alarm: p.alarm.size, total: p.names.size };
}
function syncScope() {
  const parts = scopeParts();
  currentParts = parts;
  const scope = [...parts.names];
  const fp = scope.slice().sort().join(',');
  currentScope = new Set(scope);
  if (!backend.expectsServer()) { scopeFp = ''; renderVarsPanel(); return; }   // 还没连后端：连上再下发
  if (fp === scopeFp) return;
  scopeFp = fp;
  // 下发完成后刷新顶上那颗标签：把「本页 N 变量/M 块」跟着换掉（后端算的块数才算数）
  backend.syncVarTable(project.variables(), scope).then(() => refreshBackendBadge()).catch(() => {});
  renderVarsPanel();       // 变量监控里标出哪些没在采（否则看着像"值不动就是坏了"）
}
let currentScope = new Set();
function renderPopupLayer() {
  popupLayer.innerHTML = '';
  popupRendered = [];
  syncScope();           // 弹窗里的变量也要采集（关掉就不再采）
  popupStack.forEach((page, idx) => {
    const base = 9000 + idx * 2;   // 后弹的层级更高，保证始终盖住前面
    const mask = document.createElement('div');
    mask.className = 'rt-popup-mask';
    mask.style.zIndex = base;
    // 模态：遮罩只拦截后方点击（pointer-events:auto），不再关闭弹窗；
    // 关闭只能通过弹窗内的 ✕ 或配置的 hidePopup 动作（用户要求）
    const card = document.createElement('div');
    card.className = 'rt-popup';
    card.style.zIndex = base + 1;
    const { w, h } = pageCanvasSize(page);
    card.style.width = w + 'px';
    // ⚠ 卡片高度**不写死成 h**：标题栏（有标题或有关闭按钮时才出现）是 flex:none，
    //   会从卡片高度里分走一块（约 37px）—— 写死 h 的话内容区只剩 h-37，
    //   贴着底边画的控件会被 overflow:hidden 切掉（现场反馈："开了关闭按钮，弹窗下面显示不全"）。
    //   改成：内容区固定 = 设计高度 h（下面 body 上设），卡片高度自动 = 标题栏 + h。
    card.style.height = 'auto';
    card.style.background = project.data.meta.canvas.bg || '#fff';
    applyCardTransform(card, popupPan.get(page.id) || { x: 0, y: 0 });

    // 标题栏（页面属性里配置 title / showClose，可拖拽移动弹窗）
    const title = page.title || '';
    const showClose = page.showClose !== false;
    if (title || showClose) {
      const head = document.createElement('div');
      head.className = 'rt-popup-head';
      head.innerHTML = `<span>${esc(title)}</span>${showClose ? '<button class="rt-popup-close" title="关闭">✕</button>' : ''}`;
      head.querySelector('.rt-popup-close')?.addEventListener('click', hidePopup);
      // 标题栏拖拽：记录屏幕像素偏移（与缩放无关，1:1 跟手）
      let drag = false, sx = 0, sy = 0, pan0 = { x: 0, y: 0 };
      head.addEventListener('pointerdown', e => {
        if (e.target.closest('.rt-popup-close')) return;
        drag = true;
        pan0 = { ...(popupPan.get(page.id) || { x: 0, y: 0 }) };
        sx = e.clientX; sy = e.clientY;
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', e => {
        if (!drag) return;
        const pan = { x: pan0.x + (e.clientX - sx), y: pan0.y + (e.clientY - sy) };
        popupPan.set(page.id, pan);
        applyCardTransform(card, pan);
      });
      const endDrag = () => { drag = false; };
      head.addEventListener('pointerup', endDrag);
      head.addEventListener('pointercancel', endDrag);
      card.appendChild(head);
    }

    const body = document.createElement('div');
    body.className = 'rt-popup-body';
    // 内容区高度 = 页面属性里设的「弹窗高」（控件就是按这个坐标系画的）；
    // 卡片总高自动多出一个标题栏 —— 标题栏/关闭按钮不会把内容挤掉（见上面那段说明）
    body.style.height = h + 'px';
    const frag = document.createDocumentFragment();
    page.widgets.forEach(wgt => {
      const el = buildWidget(wgt);
      frag.appendChild(el);
      popupRendered.push({ w: wgt, el });
    });
    body.appendChild(frag);
    card.appendChild(body);
    popupLayer.appendChild(mask);
    popupLayer.appendChild(card);
  });
  reindexRendered();     // 弹窗里的控件也要进「变量 → 控件」表
  popupLayer.style.display = popupStack.length ? 'flex' : 'none';
}

/** ── 操作权限（运行态分级密码）──
 *  权限不够时**不执行动作**，默认弹密码框让用户解锁（输完再按一次）。
 *  为什么不做"解锁后自动补执行"：点动/长按/置值这类动作自动补执行很容易出意外
 *  （输密码时手可能还按在按钮上，解锁瞬间就下发一个启动命令）—— 宁可多按一下。
 *  控件属性「密码框 → 权限不够时自动弹出」不勾的话：权限不够就是**点不动**，
 *  不弹框也不提示（现场不想把密码入口摆出来时用）。
 *  报警历史控件里的「清空记录」也走这一套（按**这个控件自己的等级**拦，没有单独的开关）。 */
function permAllowed(w) {
  const need = perm.needOf(w);
  if (perm.can(need)) { perm.touchActivity(); return true; }
  if (perm.autoPromptOf(w)) perm.ensureLevel(need);   // 弹密码框（异步）；这次动作不执行
  return false;
}
/** 权限变了（解锁/上锁/等级改了）→ 重画所有控件角上的小锁 + 顶部胶囊 */
function refreshPermMarks() {
  [...pageRendered, ...popupRendered].forEach(({ w, el }) => perm.decorate(el, w));
  perm.refreshChip();
}

/** 构建运行态控件 DOM 并绑定交互
 *  @param {number} zOff 页面那层的 z 基准（公共底那一层传 0，见 project.pageLayers） */
function buildWidget(w, zOff = 0) {
  const el = renderWidgetDOM(w, 'run', varStore);
  if (zOff) el.style.zIndex = (w.z || 0) + zOff;
  perm.decorate(el, w);          // 要权限的控件角上挂个小锁（🔒 未解锁 / 🔓 已解锁）
  // 点击穿透（属性面板「点击穿透」那一栏的勾，见 fireBelowWidgets）：
  //   勾上 = 点我照常算数（我自己的动作照做），**同时继续往下传** —— 压在下面那个控件的动作也一起做。
  //   所以叠着的两个控件点一下两个都触发；方框自己没配动作时，就等价于"透过方框点到下面的按钮"。
  //   只作用于运行态：组态画布上照样能点中、能拖（不然被压住的框就选不中了）
  const ct = isClickThrough(w.props);

  const clickActs = (w.actions || []).filter(a => a.trigger === 'click');
  if (clickActs.length) {
    const taps = clickActs.filter(a => a.type === 'tap');
    const clicks = clickActs.filter(a => a.type !== 'tap');
    // 延迟触发（长按）：按住达到 holdMs 才执行；0 或缺键（老工程）= 按下/点一下立即执行。
    // ⚠ 点动(tap) 同样要过这道闸：按住够久才置 TRUE，中途松手什么都没发生，
    //   松开(已触发)立即置 FALSE —— 现场就是「防误碰：要按住 1 秒机器才动」。
    const holdMs = Math.max(0, Math.round(+w.props?.holdMs || 0));
    if (holdMs > 0) {
      bindHoldActions(el, w, { taps, clicks }, holdMs);
    } else {
      let tapArmed = false;      // 点动这次按下是不是"允许"的（权限不够就不置 TRUE，松手也不置 FALSE）
      if (taps.length) {
        el.addEventListener('pointerdown', () => {
          tapArmed = permAllowed(w);
          if (tapArmed) taps.forEach(a => doAction(a, 'down'));
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
          el.addEventListener(ev, () => {
            if (!tapArmed) return;
            tapArmed = false;
            taps.forEach(a => doAction(a, 'up'));
          }));
      }
      if (clicks.length) el.addEventListener('click', () => {
        if (!permAllowed(w)) return;
        clicks.forEach(a => doAction(a, 'click'));
      });
    }
    el.style.cursor = 'pointer';
  }
  // 穿透：没配动作也要挂（方框自己没动作、只要求"穿过我，让下面那个也触发"是完全正常的用法）
  if (ct) {
    if (!clickActs.length) el.style.cursor = 'pointer';
    el.addEventListener('click', e => fireBelowWidgets(el, w, e));
  }

  // 数据输入控件（旧 input）：回车 / 失焦提交
  if (w.type === 'input' && w.bindings?.variable) {
    const input = el.querySelector('input');
    if (input) {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { if (permAllowed(w)) commitInput(w, input); input.blur(); }
      });
      input.addEventListener('blur', () => { if (permAllowed(w)) commitInput(w, input); });
    }
  }

  // 数值控件（number 二合一）：可输入时，点击整块进入输入
  // ⚠ 绑的是数组变量（int[]）时是整段只读显示，点它不该进输入态
  //   （往里写一个标量跟节点的数组类型对不上，服务器会拒）。
  //   要编辑某个元素：把数组展开成 arrw[1]…arrw[N]，控件绑到那个元素变量上。
  const boundType = project.variables().find(x => x.name === w.bindings?.variable)?.type || '';
  const wholeArray = boundType.endsWith('[]');
  if (w.type === 'number' && w.bindings?.variable && w.props?.editable !== false && !wholeArray) {
    el.addEventListener('click', e => {
      // 点在正在编辑的输入框上 → 什么都不做。否则会「blur 提交重建 DOM」+「click 再进编辑态」
      // 撞在一起，控制台抛 NotFoundError 且输入内容被吞
      if (e.target.closest('input')) return;
      if (el.querySelector('.w-number input')) return;              // 已在内联编辑态
      if (!permAllowed(w)) return;                                   // 要权限：先输密码
      if (w.props?.useKeyboard !== false) {
        if (padTarget && padTarget.w.id === w.id) return;           // 软键盘已为它开着 → 别重置已输入缓冲
        openNumPad(w, el);
      } else enterNumberEdit(w, el);                               // 内联输入框
    });
  }
  return el;
}

/** ─────────── 延迟触发（长按执行） ───────────
    按钮属性「延迟触发(ms)」> 0 时：按住够这么久才执行动作，中途松手 / 移出 / 触摸取消 = 不执行。
    现场用途：启停、清报警记录这类怕误碰的操作，要求「按住 1 秒」才认。

    点动(tap) 也走这里（第 17 轮）：到点才 doAction('down') 置 TRUE，松开 doAction('up') 置 FALSE，
    没到点就松手 = 一个字节都不下发。这样一个「点动」按钮配上 1000ms 就是「按住 1 秒机器才动」。
    同一个按钮上若同时有点动和点击类动作，共用一条进度条、一次到点、一起执行。

    进度条挂在 .wd 外壳上而不是 .wd-body 里：变量一变就会重建 .wd-body 的 innerHTML，
    画在里面按到一半会被刷没。外壳上的节点不受影响，监听也挂在它上面（子按钮重建也不掉）。
    到点后进度条满格变绿，一直按着就一直亮着（告诉用户"好了，可以松手了"），松手才收起。 */
function bindHoldActions(el, w, groups, holdMs) {
  const taps = groups.taps || [];
  const clicks = groups.clicks || [];
  const ov = document.createElement('div');
  ov.className = 'wd-hold';
  ov.style.borderRadius = `0 0 ${Math.min(4, w.props?.radius ?? 7)}px ${Math.min(4, w.props?.radius ?? 7)}px`;
  el.appendChild(ov);
  let raf = 0, t0 = 0, fired = false, held = false, settle = 0, winBound = false;

  const stopAnim = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  const hide = () => { ov.classList.remove('on', 'done'); ov.style.width = '0%'; };

  /* 松手路径挂到 window 上（capture）：手指划出按钮、触摸被系统打断、
     甚至浏览器失焦 —— 点动一旦置了 TRUE 就必须保证有人把它放回 FALSE。
     只在按住期间挂，松手立刻摘掉，不在全局留监听。
     ⚠ blur 只认「窗口自己失焦」（e.target === window）：元素级 blur 在捕获阶段也会路过
     window，若不判目标，按住按钮时页面上任何输入框失焦都会把点动误停。 */
  const onWinBlur = (e) => { if (e.target === window) release(); };
  const release = () => {
    unbindWin();
    if (settle) { clearTimeout(settle); settle = 0; }
    if (held) { taps.forEach(a => doAction(a, 'up')); held = false; }   // 点动：松开 = 停
    if (fired) { hide(); fired = false; }                              // 已触发过：把进度条收掉
    else reset();                                                      // 没到点：取消，动作不执行
  };
  function unbindWin() {
    if (!winBound) return;
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    window.removeEventListener('blur', onWinBlur, true);
    winBound = false;
  }
  const bindWin = () => {
    if (winBound) return;
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', onWinBlur, true);
    winBound = true;
  };

  const reset = () => {
    stopAnim();
    unbindWin();
    if (settle) { clearTimeout(settle); settle = 0; }
    fired = false; held = false;
    hide();
  };

  const step = () => {
    raf = 0;
    const p = Math.min(1, (performance.now() - t0) / holdMs);
    ov.style.width = (p * 100).toFixed(1) + '%';
    if (p < 1) { raf = requestAnimationFrame(step); return; }
    fired = true;                                   // 到点：只执行一次
    clicks.forEach(a => doAction(a, 'click'));
    if (taps.length) { held = true; taps.forEach(a => doAction(a, 'down')); }
    ov.classList.add('done');
    // 兜底：万一手一直按着不松，1.5 秒后先把进度条收掉（点动不会因此被放开，
    // 真正的松手由上面的 release 负责；失焦也已经算松手了）
    settle = setTimeout(() => { if (fired) hide(); settle = 0; }, 1500);
  };

  el.addEventListener('pointerdown', e => {
    if (e.button) return;                           // 只认左键/单指（右键留给菜单）
    if (!permAllowed(w)) return;                    // 要权限：先输密码（不arm，进度条也不走）
    reset();
    bindWin();
    t0 = performance.now();
    ov.classList.add('on');
    raf = requestAnimationFrame(step);
  });
  // 移出元素 = 松手（点击类：取消；点动：停）
  el.addEventListener('pointerleave', release);
}

/** ─────────── 数值控件的目标变量 / 当前值 ───────────
    以前还有一套「绑整段数组 + 设『数组元素』下标」的第二机制，现在已经去掉了：
    数组都展开成独立变量（arrw[1]…arrw[N]），**要哪个元素就直接绑哪个变量**。
    这么一来变量名本身就是 PLC 的 NodeId 写法，写元素也不用「整段读回来 → 改一个 → 写回」。
    绑到数组变量（int[]）的控件只剩「整段只读显示」这一种用法（见 buildWidget 里的 wholeArray）。 */
function numTarget(w) {
  return w.bindings?.variable || '';
}
/** 当前显示值（绑数组就是整段，fmtValue 会显示成 [1, 2, 3]） */
function numValue(w) {
  return varStore.get(w.bindings?.variable);
}

/** number 控件进入输入态：值位置替换为输入框，回车/失焦提交后恢复显示态 */
function enterNumberEdit(w, el) {
  const body = el.querySelector('.wd-body');
  if (!body || body.querySelector('input')) return;   // 已在编辑态 → 不重建（避免抢走已输入内容）
  const name = numTarget(w);
  const p = w.props;
  const cur = numValue(w);
  // 绑 string/wstring 时用文本键盘模式：inputmode=decimal 会让系统只弹数字键盘，字母根本打不进去
  const vInfo = padVarInfo(w);
  const imode = isTextType(vInfo.type) ? 'text' : 'decimal';
  const maxAttr = (isTextType(vInfo.type) && vInfo.maxLen) ? ` maxlength="${vInfo.maxLen}"` : '';
  // 输入范围限制（只对数值变量）：越界时这个框变红、回车/失焦都不写进去
  const range = isTextType(vInfo.type) ? null : padRange(w);
  body.innerHTML = `<div class="w-number" style="background:${p.bgColor || 'transparent'};border:${p.borderWidth}px solid ${p.borderColor};border-radius:${p.radius}px">
    <input type="text" inputmode="${imode}"${maxAttr} value="${esc(cur ?? '')}" style="font-size:${p.fontSize}px;color:${p.textColor}"${range ? ` title="${esc(range.tip)}"` : ''}>
    ${p.unit ? `<span class="wn-unit">${esc(p.unit)}</span>` : ''}</div>`;
  const inp = body.querySelector('input');
  inp.focus(); inp.select();
  // 越界判定：只认"已经是一个数"（'-' / '1.' 这种中间态不算）—— 见 padRange 上面那段说明
  const overNow = () => {
    if (!range) return false;
    const n = parseNumInput(inp.value);
    return n !== null && !inRange(n, range);
  };
  let done = false;   // 防重入：Enter 提交后会触发 blur，避免二次 commit
  const commit = (fromBlur) => {
    if (done) return;
    if (overNow()) {
      // 超范围：**不写**。回车时留着让用户接着改；失焦就把这一格收回去（值一个字节都没变过）
      inp.classList.add('bad');
      inp.title = range.tip;
      if (fromBlur) { done = true; refreshWidgetBody(el, w, 'run', varStore); }
      return;
    }
    done = true;
    const v = project.variables().find(x => x.name === w.bindings.variable);
    // 数组元素：按元素类型收敛（int[] → int）；整段：按变量类型
    const base = w.bindings.variable;
    const elemType = String(v?.type || '').endsWith('[]') ? String(v.type).slice(0, -2) : (v?.type || 'real');
    const val = castType(inp.value, elemType);
    if (String(numValue(w)) !== String(val)) varStore.set(numTarget(w), val, 'local');
    refreshWidgetBody(el, w, 'run', varStore);   // 恢复显示态
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(false); });
  inp.addEventListener('blur', () => commit(true));
}

function commitInput(w, input) {
  const name = w.bindings.variable;
  const v = project.variables().find(x => x.name === name);
  // 显示出来的值是四舍五入过的（12.345679 → 12.3）：点进来又点出去、没真改，
  // 不能把舍入后的值当成"用户输入"写回 PLC
  if (input.dataset && input.dataset.shown !== undefined && input.value === input.dataset.shown) return;
  // 输入范围限制：越界就不写（框标红 + 悬停说清范围），值保持原样。
  // ⚠ 这里的框**不恢复原值**：让那串越界的数字留在红框里，用户一眼就知道"是这个数没让写"。
  const range = isTextType(v?.type) ? null : padRange(w);
  const n = parseNumInput(input.value);
  if (range && n !== null && !inRange(n, range)) {
    input.classList.add('bad');
    input.title = `${range.text} —— ${range.tip}`;
    return;
  }
  input.classList.remove('bad');
  const val = castType(input.value, v?.type || 'real');
  if (String(varStore.get(name)) !== String(val)) {
    varStore.set(name, val, 'local');
    const shown = fmtValue(val, numberFmtOf(w.props));
    input.value = shown;
    if (input.dataset) input.dataset.shown = shown;
  }
}

/* 报警条：一整串报警在里面一直滚，超不超宽由 alarmBar.js 量（量完写 --ab-dur） */
function layoutAlarmBars(root) {
  if (!root) return;
  root.querySelectorAll('.w-alarmbar').forEach(bar => layoutBar(bar));
}

/* ─────────── 报警控件刷新 + 确认/清空 ─────────── */
function refreshAlarmWidgets() {
  // 报警控件也在「变量 → 控件」那套索引里一起建好了（alarmCells），不再全表扫
  alarmCells.forEach(({ w, el }) => {
    if (el.isConnected) refreshWidgetBody(el, w, 'run', varStore);
  });
  layoutAlarmBars(rtPage);     // 重绘后重新量一次「要不要滚」
  popupLayer.querySelectorAll('.rt-popup').forEach(c => layoutAlarmBars(c));
}

function onAlarmClick(e) {
  if (!running) return;
  const ack = e.target?.closest?.('[data-ackbtn]');
  if (ack) {
    e.stopPropagation();
    ackAlarm(ack.dataset.ackbtn);
    return true;
  }
  const dayBtn = e.target?.closest?.('[data-alarmday]');
  if (dayBtn) {
    e.stopPropagation();
    const id = dayBtn.closest('.wd')?.dataset.id;
    const kind = dayBtn.dataset.alarmday;
    if (id && kind === 'prev') shiftAlarmHistoryDay(id, -1);
    else if (id && kind === 'next') shiftAlarmHistoryDay(id, 1);
    else if (id) setAlarmHistoryDay(id, Date.now());      // 今天
    return true;
  }
  if (e.target?.closest?.('[data-alarmclear]')) {
    e.stopPropagation();
    // 报警历史控件里那个「清空记录」按钮：按**这个控件自己的权限等级**拦
    // （以前单开过一档「清空报警记录」权限设置，现场觉得多余 —— 去了；想保护历史记录
    //   就给报警历史控件配一级，跟别的控件一个口径）
    const wid = e.target.closest('.wd')?.dataset.id;
    if (wid && !permAllowed(project.getWidget(wid))) return true;
    clearHistory();
    return true;
  }
  return false;
}

/** 日期框改日期 → 切到那天（change 事件，单独绑一次委托） */
function onAlarmChange(e) {
  if (!running) return;
  const dateInp = e.target?.closest?.('[data-alarmdate]');
  if (!dateInp || !dateInp.value) return;
  const t = new Date(`${dateInp.value}T00:00:00`).getTime();
  if (Number.isFinite(t)) setAlarmHistoryDay(dateInp.dataset.alarmdate, t);
}

/* ─────────── 下拉框（组合框）：自绘弹层 ───────────
   点方框展开、点选项写变量、点别处/Esc 收起。用事件委托，控件 DOM 刷新重建也不用重绑。 */
function onRuntimeClick(e) {
  if (!running) return;
  if (onAlarmClick(e)) return;          // 报警列表里的「确认 / 清空记录」先处理
  const item = e.target?.closest?.('.w-combo-item');
  const typeRow = e.target?.closest?.('.w-combo-typerow');
  const combo = e.target?.closest?.('.w-combo');
  if (typeRow && combo) {
    startComboType(combo);
    return;
  }
  if (item && combo) {
    pickComboItem(combo, Number(item.dataset.idx));
    return;
  }
  if (combo && e.target?.closest?.('.w-combo-box')) {
    if (combo.classList.contains('ro')) return;      // 只读：不展开
    // 要权限的下拉框：点开就先要密码（免得选完才发现不许写，白白选一次）
    const cw = project.findWidget(combo.closest('.wd')?.dataset.id);
    if (cw && !permAllowed(cw)) return;
    const willOpen = !combo.classList.contains('open');
    closeCombos(combo);
    if (willOpen) openCombo(combo); else combo.classList.remove('open');
    return;
  }
  closeCombos(null);
}

/** 展开弹层：先看下面还有没有地方 —— 不够就往上翻，并按可用空间限高
 *（运行画面 #rtPage 自带 overflow:hidden，弹层太靠下会被裁掉）
 * ⚠ 渲染时写的 max-height 是按「最多显示几项 × 选项行高」算的，量完要还原，别清掉 */
function openCombo(combo) {
  const pop = combo.querySelector('.w-combo-pop');
  if (!pop) return;
  combo.classList.add('open');
  combo.classList.remove('up');
  const base = pop.dataset.baseMax ?? pop.style.maxHeight ?? '';
  pop.dataset.baseMax = base;
  pop.style.maxHeight = base;                        // 还原成 maxRows 算出来的高度
  const boxRect = combo.getBoundingClientRect();
  const need = pop.getBoundingClientRect().height;
  const below = window.innerHeight - boxRect.bottom - 6;
  const above = boxRect.top - 6;
  if (need > below && above > below) {
    combo.classList.add('up');
    pop.style.maxHeight = Math.max(60, Math.min(need, above)) + 'px';
  } else if (need > below) {
    pop.style.maxHeight = Math.max(60, below) + 'px';
  }
  pop.style.overflowY = 'auto';
}

/**
 * ─────────── 点击穿透：一次点击，叠着的控件一起触发 ───────────
 *
 * 现场场景：把两个控件叠着放（比如一个大方框 + 下面一个按钮，或者两个透明按钮压在一起），
 * 希望**点一下两个都生效**。浏览器默认只把点击给最上面那个，下面的收不到 —— 这里自己往下传。
 *
 * 怎么找「下面的控件」：`document.elementsFromPoint` 给出这个点上**从最上面到最下面**的元素栈
 * （它按绘制顺序来，z-index 也算在内），找到自己那一个，再顺着栈往下走。
 *
 * 往下走的规则（跟属性面板「点击穿透」那个勾对上）：
 *   · 勾了穿透的控件：执行它的动作，然后**继续往下**
 *   · 没勾（不穿透）的控件：执行它的动作，然后**停** —— 它是个"实心"控件，挡住后面的
 * ⚠ 只在**同一层容器**里传（页面那层 #rtPage / 弹窗那张卡片的内容区）：
 *   不然点在弹窗上会顺手把弹窗底下主画面的按钮也点一遍，那是很危险的事。
 * ⚠ 往下传的只有**点击类**动作：点动(tap) 是"按住/松手"两个时刻，不是一次点击能表达的东西，
 *   下传会变成"按住上面、下面也点动"，语义混乱。要下面那个也点动，就让它自己收点击。
 */
function fireBelowWidgets(el, w, e) {
  const host = el.parentElement;
  if (!host || typeof document.elementsFromPoint !== 'function') return;
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  const mine = stack.indexOf(el);
  if (mine < 0) return;
  const done = new Set([w.id]);
  for (let i = mine + 1; i < stack.length; i++) {
    const cel = stack[i].closest?.('.wd');
    // 只认同一层的控件（弹窗里的控件是弹窗卡片的子节点，跟页面控件不是一个父节点）
    if (!cel || cel.parentElement !== host || done.has(cel.dataset.id)) continue;
    const child = project.findWidget(cel.dataset.id);
    if (!child) continue;
    done.add(child.id);
    const acts = (child.actions || []).filter(a => a.trigger === 'click' && a.type !== 'tap');
    if (acts.length && permAllowed(child)) acts.forEach(a => doAction(a, 'click'));
    if (!isClickThrough(child.props)) break;           // 不穿透：到这层为止
  }
}

/**
 * 「可选也可输入」：点列表末尾那一行 → 开软键盘，手动填一个值（不在选项里也行）。
 * 现场是触摸屏，没有系统输入法：文本变量给全键盘、数值给数字键盘，都由 openNumPad 按变量类型分。
 * 绑数组变量（int[]）的控件是**整段只读显示** —— 往里写一个标量跟节点的数组类型对不上，
 * 服务器会拒（跟数值控件同一条规矩），所以这一行点了不响应。
 */
function startComboType(combo) {
  closeCombos(null);                              // 键盘一开就把弹层收起来，免得压在一起
  const el = combo.closest('.wd');
  const w = project.findWidget(el?.dataset.id);
  if (!w || w.type !== 'select') return;
  if (comboMode(w.props) !== 'type' || !w.bindings?.variable) return;
  if (!permAllowed(w)) return;                    // 要权限：先输密码（这次输入不算）
  const t = String(project.variables().find(x => x.name === w.bindings.variable)?.type || '');
  if (t.endsWith('[]')) return;
  if (padTarget && padTarget.w.id === w.id) return;   // 键盘已为它开着 → 别重置已输入的内容
  openNumPad(w, el);
}

function closeCombos(except) {
  document.querySelectorAll('.w-combo.open').forEach(c => {
    if (c === except) return;
    c.classList.remove('open', 'up');
    const pop = c.querySelector('.w-combo-pop');
    if (pop) pop.style.maxHeight = pop.dataset.baseMax ?? '';   // 还原，下次展开重新量
  });
}
function pickComboItem(combo, idx) {
  closeCombos(null);
  const w = project.findWidget(combo.closest('.wd')?.dataset.id);
  if (!w || w.type !== 'select') return;
  if (!permAllowed(w)) return;                    // 要权限：先输密码（这次选择不算）
  const name = w.bindings?.variable;
  if (!name) return;
  const opts = parseOptions(w.props.items);
  if (!Number.isFinite(idx) || idx < 0 || idx >= opts.length) return;
  const mode = w.props.valueMode || 'value';
  const raw = mode === 'index0' ? idx : mode === 'index1' ? idx + 1 : opts[idx].value;
  const vtype = project.variables().find(x => x.name === name)?.type || 'int';
  // 按变量类型落值：int 系取整、real 系转浮点、string 原样、bool 看真假
  const val = vtype === 'bool' ? !(raw === 0 || raw === '0' || raw === false)
    : vtype === 'string' ? String(raw)
    : (vtype === 'real' || vtype === 'lreal') ? (Number(raw) || 0)
    : Math.round(Number(raw) || 0);
  if (String(varStore.get(name)) !== String(val)) varStore.set(name, val, 'local');
  // 写完后 vars:changed 会重渲染这个控件（弹层随之收起、选中项跟着变）
}

/* ─────────── 软键盘（触摸屏输入）───────────
   数值（int/real…）→ 数字键盘（原来那套，行为不变）
   文本（string/wstring）→ 全键盘：英文大小写 + 数字 + 符号 + 中文拼音候选
   为什么要分两套：现场是触摸屏，没有实体键盘也没有系统输入法。给文本变量弹数字键盘
   等于根本输不进去；中文只能页面上自己拼（拼音表在 js/data/pinyin.js，离线）。

   起手方式（**工程级一处设置**：「工程 ▾ → 软键盘设置…」，project.keypad()）：
     mode  edit    接着原值改 —— 老行为：打开键盘显示当前值，按的键接在原值后面
           replace 首键清空重输 —— 打开时**照样显示当前值**（看得见现在是多少），但按下的
                   第一个「字符键」先把原值让掉，直接开始输新值（省掉一次按 C）
     label var     标题栏显示变量名（老行为）
           widget  标题栏显示控件名（现场认"线速度设定"比认 Hr_LineSpd 快） */
let numPad, npDisplay, npVar, npCand, npText, npRange, npMask;
let padTarget = null;   // { w, el, mode, buffer, py, upper, page, zh, maxLen, fresh, range }

/** 是不是文本类型（含数组的字符串元素 arrw[] 的 string 元素） */
function isTextType(t) {
  const s = String(t || '').toLowerCase().replace(/\[\]$/, '');
  return s === 'string' || s === 'wstring';
}
/** 当前控件的有效元素类型 + 字符数上限（变量表里 len = CODESYS STRING(n) 的 n） */
function padVarInfo(w) {
  const v = project.variables().find(x => x.name === (w.bindings?.variable || ''));
  const raw = String(v?.type || '');
  return { type: raw.replace(/\[\]$/, ''), maxLen: Math.max(0, Math.round(+v?.len || 0)) };
}

/* ── 输入范围限制 ──
   控件属性「输入范围限制」：上下限各自可以是固定值，也可以跟一个变量走
   （现场最常见的配法：配方上下限由 PLC 下发）。这里的几条规矩，都是现场踩出来的：

   · **每次现算**，不缓存：PLC 把上限改小了，键盘上那条范围和判越界要立刻跟着变
     （见 padRangeVarChanged）。缓存一份就会出现"显示 100、实际按 80 拦"。
   · 判据只有一条：**缓冲里已经是一个数**且越界。'' / '-' / '1.' 这些是中间态
     （用户刚按了 ± 或小数点），当场标红只会显得键盘坏了。
   · 越界 = 输入框变红 + 确定按钮禁用 + 提交时**一个字节都不下发**；
     键盘**不关**，用户就在这个界面上改，不用重新点一次控件。
   · 限制变量没读到值（没在采集范围里/后端断了）时那一端不拦，但范围行上标 `变量名(?)`
     —— 看着有范围、实际一个值都不拦，是比"不让输"危险得多的事，必须让人看得见。 */
function padRange(w) { return inputRangeOf(w?.props, (n) => varStore.get(n)); }

/** 键盘上那条「范围」行 + 输入框变红 + 确定按钮禁用 —— 三件事一处管，免得三处各判一遍对不上。
 *  返回 true = 当前缓冲越界。 */
function paintPadRange() {
  const t = padTarget;
  const r = t?.range || null;
  const n = t ? parseNumInput(t.buffer) : null;
  const over = !!r && n !== null && !inRange(n, r);
  if (npRange) {
    npRange.classList.toggle('hidden', !r);
    npRange.classList.toggle('bad', over);
    npRange.textContent = r ? (r.text + (over ? '　✕ 超出范围' : '')) : '';
    npRange.title = r ? r.tip : '';
  }
  npDisplay.classList.toggle('bad', over);
  if (r) npDisplay.title = r.tip; else npDisplay.removeAttribute('title');
  const ok = numPad?.querySelector('#npKeys button.np-ok');
  if (ok) ok.disabled = over;
  return over;
}

/** 当限制用的那个变量变了 → 键盘上的范围和越界判断当场重算（用户正在输的内容一个字不动） */
function padRangeVarChanged(name) {
  const t = padTarget;
  if (!t || !t.range) return;
  if (![t.range.min, t.range.max].some(l => l && l.mode === 'var' && l.src === name)) return;
  t.range = padRange(t.w);
  paintPadRange();
}

/** 运行态输入框的「范围」实时反馈（事件委托：控件 DOM 每次刷新重建也不用重绑）。
 *  数值控件的内联输入框、老「数据输入」控件的输入框，一打字就判越界 → 变红。
 *  ⚠ 这里只标红，**不拦打字** —— 拦在提交那一步（回车/失焦时越界就不写，见 commitInput /
 *    enterNumberEdit），因为"打到一半超界"是完全正常的输入过程。 */
function onRuntimeInput(e) {
  if (!running) return;
  const inp = e.target?.closest?.('.w-input, .w-number input');
  if (!inp) return;
  const w = project.findWidget(inp.closest('.wd')?.dataset.id);
  if (!w) return;
  // 文本变量没有"范围"这回事（跟软键盘那边同一个口径：文本键盘既不显示范围也不拦）
  const range = isTextType(padVarInfo(w).type) ? null : padRange(w);
  if (!range) { inp.classList.remove('bad'); return; }
  const n = parseNumInput(inp.value);
  const over = n !== null && !inRange(n, range);
  inp.classList.toggle('bad', over);
  inp.title = over ? `${range.text} —— ${range.tip}` : range.tip;
}
/** 这份工程用的是哪种起手方式（工程 ▾ → 软键盘设置…）。认不出的一律当"接着原值改" */
function padReplaceMode() { return project.keypad?.().mode === PAD_REPLACE; }
/** 键盘标题栏那一行：名字 + 类型 + 字符数上限。
 *  名字显示**变量名**（默认）还是**控件名**，也由「工程 ▾ → 软键盘设置…」定
 *  —— 现场认"线速度设定"比认 Hr_LineSpd 快。控件没名字时回落变量名（不能显示成空白）。 */
function padVarLabel() {
  const t = padTarget;
  if (!t) return '';
  const info = padVarInfo(t.w);
  const vname = t.w.bindings?.variable || '';
  const wname = String(t.w.name || '').trim();
  const name = (project.keypad?.().label === PAD_LABEL_WIDGET && wname) ? wname : vname;
  const typeTxt = info.type ? `  (${info.type}${info.maxLen ? ` ${info.maxLen} 字符` : ''})` : '';
  return `${name}${typeTxt}`;
}
/** 「首键清空重输」：显示区里那条是**原值**（看得见现在是多少），
 *  但第一个"字符键"一按就把它让掉，从新值打起。按 ⌫ / C 的路径不走这里
 *  —— 那两个键的意思是"我要改原值"，顺手把这次起手状态收掉即可。 */
function padStartFresh() {
  const t = padTarget;
  if (!t || !t.fresh) return;
  t.fresh = false;
  t.buffer = '';
}

function initNumPad() {
  numPad = document.getElementById('numPad');
  npDisplay = document.getElementById('npDisplay');
  npVar = document.getElementById('npVar');
  npCand = document.getElementById('npCand');
  npText = document.getElementById('npText');
  npRange = document.getElementById('npRange');
  npMask = document.getElementById('npMask');
  document.getElementById('npCancel').addEventListener('click', closeNumPad);

  // 标题栏拖拽移动键盘（位置持久化）
  const head = numPad.querySelector('.np-head');
  let dragging = false, offX = 0, offY = 0;
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('.np-x')) return;   // ✕ 按钮不触发拖拽
    dragging = true;
    const r = numPad.getBoundingClientRect();
    offX = e.clientX - r.left; offY = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', e => {
    if (!dragging) return;
    numPad.style.left = (e.clientX - offX) + 'px';
    numPad.style.top = (e.clientY - offY) + 'px';
  });
  head.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    const r = numPad.getBoundingClientRect();
    localStorage.setItem('hmi-numpad-pos', JSON.stringify({ left: r.left, top: r.top }));
  });

  const keys = document.getElementById('npKeys');
  const layout = ['7', '8', '9', 'back', '4', '5', '6', 'clear', '1', '2', '3', '+/-', '0', '.', 'ok', 'cancel'];
  layout.forEach(k => {
    const b = document.createElement('button');
    b.type = 'button';
    if (k === 'back') { b.textContent = '⌫'; b.className = 'np-fn'; }
    else if (k === 'clear') { b.textContent = 'C'; b.className = 'np-fn'; }
    else if (k === '+/-') { b.textContent = '±'; b.className = 'np-fn'; }
    else if (k === 'ok') { b.textContent = '确定'; b.className = 'np-ok'; }
    else if (k === 'cancel') { b.textContent = '取消'; b.className = 'np-fn'; }
    else b.textContent = k;
    b.dataset.k = k;                             // 给自动化测试/脚本留个抓手
    b.addEventListener('click', () => padKey(k));
    keys.appendChild(b);
  });
}

/* ── 键盘布局 ──
   键 = 字符串（直接输入）或 {k, kind, label, wide}
   kind：shift 大小写 / back 退格 / space 空格 / clear 清空 / cancel 取消 / ok 确定
         lang 中英切换 / page 符号页切换 / hint 拼音补全提示 */
const KB_ABC = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  [{ k: '⇧', kind: 'shift' }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', { k: '⌫', kind: 'back', label: '⌫' }],
  [{ k: '中/英', kind: 'lang' }, { k: '#+=', kind: 'page', label: '#+=' },
    { k: '空格', kind: 'space', label: '空格', wide: 2 }, { k: '清空', kind: 'clear', label: '清空' },
    { k: '取消', kind: 'cancel', label: '取消' }, { k: '确定', kind: 'ok', label: '确定' }],
];
const KB_SYM = [
  ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
  ['-', '_', '=', '+', '[', ']', '{', '}', ';', ':'],
  ["'", '"', ',', '.', '?', '/', '\\', '|', '<', '>'],
  ['~', '`', '€', '£', '¥', '°', '±', '×', '÷', '√'],
  [{ k: '中/英', kind: 'lang' }, { k: 'abc', kind: 'page', label: 'abc' },
    { k: '空格', kind: 'space', label: '空格', wide: 2 }, { k: '清空', kind: 'clear', label: '清空' },
    { k: '取消', kind: 'cancel', label: '取消' }, { k: '确定', kind: 'ok', label: '确定' }],
];
/* 中文标点单开一行：中文模式下最常用，藏在符号页里反而难找。
   ⚠ 这一行**两种模式都画**（英文模式下用不到，但少一行会让整块键盘忽高忽低，
     切中英/切符号页时手指正按着的键位就跑了）—— 高度稳定优先。 */
const KB_CN_PUNCT = ['，', '。', '？', '！', '、', '：', '；', '“', '”', '（', '）', '《', '》', '—', '…'];

/** 画全键盘（模式/大小写/符号页切换后重画） */
function renderTextPad() {
  const t = padTarget;
  if (!t || t.mode !== 'text') return;
  const rows = (t.page === 'sym' ? KB_SYM : KB_ABC).slice();
  rows.push(KB_CN_PUNCT);                 // 固定多这一行：高度不随模式变
  npText.innerHTML = '';
  rows.forEach(row => {
    const line = document.createElement('div');
    line.className = 'np-row' + (row === KB_CN_PUNCT ? ' punct' : '');
    row.forEach(k => {
      if (typeof k === 'string' && row === KB_CN_PUNCT) { addPadKey(line, { k, kind: 'punct' }); return; }
      addPadKey(line, typeof k === 'string' ? { k } : k);
    });
    npText.appendChild(line);
  });
}
function addPadKey(line, spec) {
  const t = padTarget;
  const b = document.createElement('button');
  b.type = 'button';
  const kind = spec.kind || 'char';
  let label = spec.label ?? spec.k;
  if (kind === 'shift') label = t.upper ? '⇪' : '⇧';
  if (kind === 'lang') label = t.zh ? '中/英' : 'ABC';
  if (!spec.label && kind === 'char' && /^[a-z]$/.test(spec.k)) label = t.upper ? spec.k.toUpperCase() : spec.k;
  b.textContent = label;
  if (kind === 'ok') b.className = 'np-ok';
  else if (kind !== 'char' && kind !== 'punct') b.className = 'np-fn';
  if (kind === 'shift' && t.upper) b.classList.add('on');
  if (kind === 'lang' && t.zh) b.classList.add('on');
  if (spec.wide) b.classList.add('wide2');
  b.dataset.k = spec.k;                        // 给自动化测试/脚本留个抓手
  b.dataset.kind = kind;
  b.addEventListener('click', () => padKey(spec.k, kind));
  line.appendChild(b);
}

/** 一行放得下几个候选（按候选栏实测宽度算；末尾要放「上一页 / 下一页」两个按钮时给它们留位置） */
function candPerPage(total) {
  const rowW = Math.max(120, npCand.clientWidth || 614);
  const gap = 6, btn = 44;
  let per = Math.floor((rowW + gap) / (btn + gap));
  if (total > per) per = Math.floor((rowW - PAGE_BTNS_W) / (btn + gap));   // 让出翻页按钮那两格
  return Math.max(1, per);
}
// 末尾两个翻页按钮占的宽度：‹ + 「2/5 ›」+ 两个间隙
const PAGE_BTNS_W = 44 + 64 + 6 * 2;

/** 拼音候选条：**固定一行**、不滚动，字多了用末尾的翻页按钮翻。
 *  两种模式都占着这一行 —— 候选有没有、中文还是英文都不改键盘高度，
 *  不然打字时整块键盘忽高忽低，手指正按着的键位就跑了。没内容就是空白一行。 */
function renderCand() {
  const t = padTarget;
  if (!t || t.mode !== 'text') { npCand.classList.add('hidden'); npCand.innerHTML = ''; return; }
  npCand.classList.remove('hidden');
  npCand.innerHTML = '';
  if (!t.zh || !t.py) return;                    // 英文模式 / 还没打拼音：这一行留空
  const py = t.py;
  const chars = pinyinCandidates(py);
  const hints = chars.length ? [] : pinyinComplete(py);
  if (!chars.length && !hints.length) {
    const tip = document.createElement('span');
    tip.className = 'np-cand-tip';
    tip.textContent = `「${py}」没有对应的字 —— ⌫ 改一下，或点空格当字母输进去`;
    npCand.appendChild(tip);
    return;
  }
  const list = chars.length ? chars : hints;
  const per = candPerPage(list.length);
  const pages = Math.max(1, Math.ceil(list.length / per));
  const page = Math.min(t.candPage || 0, pages - 1);
  t.candPage = page;
  list.slice(page * per, page * per + per).forEach(item => {
    const b = document.createElement('button');
    b.type = 'button';
    if (chars.length) {
      b.textContent = item;
      b.addEventListener('click', () => {
        if (t.maxLen && [...t.buffer].length >= t.maxLen) { padFlash('已到长度上限'); return; }
        t.buffer += item;                        // 选字 = 上屏，拼音缓冲清掉
        t.py = ''; t.candPage = 0;
        renderPad();
        renderCand();
      });
    } else {
      b.className = 'hint';                      // 音节补全提示（点一下补全，不是上屏）
      b.innerHTML = `<b>${rutil.escapeHtml(py)}</b>${rutil.escapeHtml(item.slice(py.length))}`;
      b.title = `补全成 ${item}`;
      b.addEventListener('click', () => { t.py = item; t.candPage = 0; renderPad(); renderCand(); });
    }
    npCand.appendChild(b);
  });
  if (pages > 1) {
    // 两个按钮挨着放：来回翻的时候手指不用来回跑；翻到底/翻到头都绕回去（不会卡在死按钮上）
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'np-page np-prev';
    prev.textContent = '‹';
    prev.title = `上一页（当前第 ${page + 1} 页，共 ${pages} 页）`;
    prev.addEventListener('click', () => {
      t.candPage = (page - 1 + pages) % pages;
      renderCand();
    });
    npCand.appendChild(prev);
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'np-page np-next';
    next.textContent = `${page + 1}/${pages} ›`;
    next.title = '下一页';
    next.addEventListener('click', () => {
      t.candPage = (page + 1) % pages;
      renderCand();
    });
    npCand.appendChild(next);
  }
}

function openNumPad(w, el) {
  const info = padVarInfo(w);
  const mode = isTextType(info.type) ? 'text' : 'num';
  padTarget = {
    w, el, mode, type: info.type, maxLen: info.maxLen,
    buffer: String(numValue(w) ?? ''), py: '', upper: false, page: 'abc', zh: false, candPage: 0,
    // 输入范围限制（只在数值键盘上生效；文本变量没有"范围"这回事）
    range: mode === 'num' ? padRange(w) : null,
    // 首键清空重输：buffer 里放的**就是原值**（显示区照旧看得见现在是多少），
    // 只多一个"第一个字符键来了就先让位"的状态。接着原值改（默认）时它是 false，行为一个字不变。
    fresh: padReplaceMode(),
  };
  npVar.textContent = padVarLabel();
  numPad.classList.toggle('wide', mode === 'text');
  // 「屏蔽其他控件」（控件属性，**默认勾着**）：键盘一弹出就把遮罩盖上 ——
  // 画面上的其他控件/弹窗一律点不动（防误碰：键盘开着时手滑按到"启动"是大事）。
  // 没勾的控件不盖（老行为：能点别处）。见 css/runtime.css 的 #npMask。
  npMask?.classList.toggle('hidden', w?.props?.padBlockOthers === false);
  document.getElementById('npKeys').classList.toggle('hidden', mode !== 'num');
  npText.classList.toggle('hidden', mode !== 'text');
  npDisplay.classList.toggle('left', mode === 'text');
  if (mode === 'text') { renderTextPad(); renderCand(); } else { npCand.classList.add('hidden'); npCand.innerHTML = ''; }
  renderPad();
  numPad.classList.remove('hidden');   // 先显示以量取尺寸
  if (mode === 'text') renderCand();   // 显示之后再算一次：一行放得下几个候选要按实测宽度算
  // 定位：恢复上次拖动位置，否则居中
  let placed = false;
  try {
    const saved = JSON.parse(localStorage.getItem('hmi-numpad-pos'));
    if (saved && saved.left != null && saved.top != null) {
      numPad.style.left = Math.max(0, Math.min(saved.left, window.innerWidth - 40)) + 'px';
      numPad.style.top = Math.max(0, Math.min(saved.top, window.innerHeight - 40)) + 'px';
      placed = true;
    }
  } catch { /* 忽略 */ }
  if (!placed) {
    numPad.style.left = Math.round((window.innerWidth - numPad.offsetWidth) / 2) + 'px';
    numPad.style.top = Math.round((window.innerHeight - numPad.offsetHeight) / 2) + 'px';
  }
}

function renderPad() {
  const t = padTarget;
  if (!t) return;
  // 首键清空重输：显示区里这条还没被"接管"，淡一点 —— 一眼分得出"这是原值"和"这是我刚输的"
  npDisplay.classList.toggle('fresh', !!t.fresh);
  if (t.mode !== 'text') {
    npDisplay.textContent = t.buffer === '' ? '0' : t.buffer;
    paintPadRange();                       // 范围行 + 变红 + 确定按钮禁用（三件事一处管）
    return;
  }
  const body = t.buffer === ''
    ? '<span class="np-empty">（空）</span>'
    : rutil.escapeHtml(t.buffer);
  const py = t.py ? `<span class="np-py"> ${rutil.escapeHtml(t.py)}</span>` : '';
  const over = (t.maxLen && [...t.buffer].length >= t.maxLen) ? '<span class="np-empty"> 已满</span>' : '';
  npDisplay.innerHTML = `${body}${py}<span class="np-caret">│</span>${over}`;
  paintPadRange();                         // 文本键盘没范围 → 把范围行/红框/禁用态收干净
}

/** 往缓冲里塞一个字符（超长/超字符数上限就拒绝）
 *  —— 全键盘的字母/数字/符号/空格/中文标点都走这里，所以"首键清空"也收在这一处 */
function padType(ch) {
  const t = padTarget;
  if (!t) return;
  padStartFresh();                             // 第一个字符键：原值让位（接着原值改时什么都不做）
  if (t.maxLen && [...t.buffer].length >= t.maxLen) { padFlash('已到长度上限'); return; }
  t.buffer += ch;
}

/** 长度到顶时闪一下输入框（不然用户以为键坏了） */
function padFlash(msg) {
  npDisplay.style.transition = 'none';
  npDisplay.style.background = 'rgba(220, 38, 38, .35)';
  npVar.textContent = msg;
  setTimeout(() => {
    npDisplay.style.transition = '';
    npDisplay.style.background = '';
    if (padTarget) npVar.textContent = padVarLabel();
  }, 700);
}

function padKey(k, kind = 'num') {
  const t = padTarget;
  if (!t) return;
  if (kind === 'num') {                        // 数字键盘（老路径）
    switch (k) {
      // ⌫ / C / ± ：都是"我要动原值"的操作，先把首键清空这次起手收掉（不然按完 ⌫ 再按数字会被清）
      case 'back': t.fresh = false; t.buffer = t.buffer.slice(0, -1); break;
      case 'clear': t.fresh = false; t.buffer = ''; break;
      // ± 算起手（第一个键按 ± = "输一个负数"）：从 - 打起；已经输过东西之后按它还是老行为（翻正负号）
      case '+/-':
        if (t.fresh) { t.fresh = false; t.buffer = '-'; break; }
        t.buffer = t.buffer.startsWith('-') ? t.buffer.slice(1) : '-' + t.buffer; break;
      case 'ok': commitNumPad(); return;
      case 'cancel': closeNumPad(); return;
      default:
        padStartFresh();
        if (k === '.' && t.buffer.includes('.')) return;   // 只允许一个小数点
        t.buffer += k;
    }
    renderPad();
    return;
  }
  /* ── 全键盘 ── */
  switch (kind) {
    case 'shift': t.upper = !t.upper; renderTextPad(); return;
    case 'lang': t.zh = !t.zh; t.py = ''; t.candPage = 0; renderTextPad(); renderCand(); renderPad(); return;
    case 'page': t.page = (t.page === 'sym' ? 'abc' : 'sym'); renderTextPad(); return;
    case 'space':
      // 中文模式下还有没上屏的拼音 → 空格把它当字母落下来（打英文不用切模式）
      if (t.py) { const py = t.py; t.py = ''; t.candPage = 0; padType(py + ' '); }
      else padType(' ');
      renderCand(); renderPad(); return;
    case 'clear': t.fresh = false; t.buffer = ''; t.py = ''; t.candPage = 0; renderCand(); renderPad(); return;
    case 'cancel': closeNumPad(); return;
    case 'ok': commitNumPad(); return;
    case 'back':
      // 改拼音 → 从第一页重新看（翻到第 5 页时删一个字母，还停在第 5 页就没道理了）
      // 首键清空模式下：⌫ 的意思是"我要改原值"，所以先收起这次起手（别让下一个字母把原值吞了）
      if (t.py) { t.py = t.py.slice(0, -1); t.candPage = 0; }
      else { t.fresh = false; t.buffer = t.buffer.slice(0, -1); }
      renderCand(); renderPad(); return;
    case 'punct': padType(k); renderPad(); return;
    default: {
      // 字母键：中文模式进拼音缓冲，否则直接上屏（数字/符号也一样直接上屏）
      const isLetter = /^[a-z]$/.test(k);
      // 中文模式下头一个拼音字母就算"起手"：原值这时就该让位，别等选完字往后面接
      if (t.zh && isLetter) { padStartFresh(); t.py += k; t.candPage = 0; renderCand(); renderPad(); return; }
      padType(t.upper && isLetter ? k.toUpperCase() : k);
      renderPad();
      return;
    }
  }
}

function commitNumPad() {
  const t = padTarget;
  if (!t) return;
  // 软键盘开着的时候权限被自动锁掉了 → 这一下不算数（重新按控件、输了密码再输值）
  if (!perm.allowedFor(t.w)) { closeNumPad(); perm.ensure(t.w); return; }
  // 输入范围限制：越界**一个字节都不下发**。确定按钮这时也是禁用的，这里是双保险
  //（脚本/自动化直接调 padKey('ok')，或键盘开着的时候 PLC 把上限改小了都会走到这儿）。
  const rn = parseNumInput(t.buffer);
  if (t.range && rn !== null && !inRange(rn, t.range)) {
    padFlash(t.range.bad ? '下限比上限大，写不进去' : '超出范围，写不进去');
    paintPadRange();
    return;                     // 键盘不关：就在这儿改，别让用户再点一次控件
  }
  // 中文模式下还留着一串没上屏的拼音（没选字就按了确定）→ 当字母落下来，别悄悄丢掉
  if (t.mode === 'text' && t.py) { t.buffer += t.py; t.py = ''; }
  const v = project.variables().find(x => x.name === t.w.bindings.variable);
  // 按变量类型收敛后写整值（数组变量绑的控件是只读的，根本进不到这里）
  const vtype = String(v?.type || (t.mode === 'text' ? 'string' : 'real'));
  const elemType = vtype.endsWith('[]') ? vtype.slice(0, -2) : vtype;
  const val = castType(t.buffer, elemType);
  if (String(numValue(t.w)) !== String(val)) {
    varStore.set(numTarget(t.w), val, 'local');
  }
  closeNumPad();
}

function closeNumPad() {
  padTarget = null;
  numPad.classList.add('hidden');
  npMask?.classList.add('hidden');     // 遮罩跟着键盘一起收（不然画面就点不动了）
  // 范围那几处状态收干净：下次开键盘（可能是另一个控件、可能没有范围）不带着上一次的红框
  paintPadRange();
}

/* ─────────── 动作执行 ─────────── */
function doAction(act, phase) {
  const p = act.params || {};
  switch (act.type) {
    case 'tap': {
      // 点动：按住 TRUE / 松开 FALSE（未配变量 = 静默跳过，不往变量表塞垃圾键）
      if (!p.variable) return;
      varStore.set(p.variable, phase === 'down', 'local');
      break;
    }
    case 'toggle': {
      if (!p.variable) return;
      varStore.set(p.variable, !varStore.get(p.variable), 'local');
      break;
    }
    case 'setValue': {
      if (!p.variable) return;
      const v = project.variables().find(x => x.name === p.variable);
      varStore.set(p.variable, castType(p.value, v?.type || 'string'), 'local');
      break;
    }
    case 'gotoPage': {
      if (p.page) gotoPage(p.page);
      break;
    }
    case 'showPopup': showPopup(p.page); break;
    case 'hidePopup': hidePopup(); break;
    case 'back': goBack(); break;
    case 'clearAlarm': {
      // 清空报警「历史记录」（报警历史控件里那个「清空记录」按钮是同一件事）。
      // 当前报警不在这里清：它由引擎每 200ms 按条件重算，条件还在就立刻会回来，清了也没意义。
      clearHistory();
      break;
    }
    case 'exitPerm': {
      // 退出权限（锁定）：现场按钮上配这一个动作，就有一个"我干完了，交班"的入口
      perm.lock('已退出权限');
      break;
    }
  }
}

/* ── 页面/弹窗操作（控件动作和脚本 API 都走这几个函数） ── */
/** 页面：可以给 id 也可以给页面名（脚本里写 hmi.page('画面2') 更顺手）
 *  ⚠ 只有普通页能跳：弹窗走 showPopup，**公共底不是能"进"的画面**（它是套在页面上的那一层）
 *  —— 脚本里手滑写成 hmi.page('公共底1') 也不会把画面切成一张底 */
export function gotoPage(pageIdOrName) {
  const pg = resolvePage(pageIdOrName);
  if (!running || !pg || pg.type !== 'page') return false;
  if (pageStack[pageStack.length - 1] !== pg.id) pageStack.push(pg.id);
  // ⚠ 只 push 不封顶：脚本要是用页面跳转做"轮播"（一秒切几次），这个栈一天能涨几十万项
  //   —— 而它只用来支持「返回上一页」。留最近 PAGE_STACK_MAX 页足够用，从**最早**的丢
  //   （goBack 是从末尾弹的，丢开头不影响"返回"）。
  if (pageStack.length > PAGE_STACK_MAX) pageStack.splice(0, pageStack.length - PAGE_STACK_MAX);
  popupStack = [];
  renderPage();
  renderPopupLayer();
  return true;
}
export function showPopup(pageIdOrName) {
  const pg = resolvePage(pageIdOrName);
  if (!running || !pg || pg.type !== 'popup') return false;
  if (popupStack.find(x => x.id === pg.id)) return true;
  popupStack.push(pg);
  renderPopupLayer();
  return true;
}
export function goBack() {
  if (!running || pageStack.length <= 1) return false;
  pageStack.pop();
  renderPage();
  return true;
}
/** 脚本引擎通过这个句柄做页面/弹窗/报警操作（避免 runtime ↔ scriptEngine 相互 import 成环） */
window.__hmiRuntime = {
  gotoPage, showPopup, hidePopup, goBack, activeAlarms,
  // 脚本里 hmi.sim()：现在是"内部仿真"（没接真设备）吗 —— 演示脚本靠它决定要不要自己驱动模拟量。
  // ⚠ 按**配置模式**判（见 dataMode）：接了 PLC 就一直是 false，**掉线期间也是 false** ——
  //   否则设备一断，仿真脚本会立刻接手去写那些本该由 PLC 给的量，而这时设备是断的，
  //   每一笔写都要等一个超时才失败，界面上就是一屏「下发失败」。
  //   模式还没问出来时也按"接了设备"算（保守一侧）：宁可少跑一拍仿真，也不能往 PLC 上乱写。
  isSim: () => { const m = dataMode(); return !(m === 'plc' || m === 'opcua'); },
  // 操作权限：脚本里 hmi.permLevel() / hmi.can('工程师') / hmi.lock()
  permLevelName: () => perm.currentLevelName(),
  permCan: (id) => perm.can(id),
  lockPerm: (why) => perm.lock(why || '已退出权限'),
};
function resolvePage(x) {
  if (!x) return null;
  return project.getPage(x) || project.pages().find(p => p.name === x) || null;
}

function hidePopup() {
  if (popupStack.length) { popupStack.pop(); renderPopupLayer(); }
}

function castType(raw, type) {
  if (/\[\]$/.test(String(type || ''))) {
    // 数组：文本按逗号/空格拆；已经是数组就逐元素按元素类型收敛
    const elem = String(type).slice(0, -2);
    if (Array.isArray(raw)) return raw.map(x => castType(x, elem));
    return String(raw ?? '').replace(/^\[|\]$/g, '').split(/[,;\s]+/).filter(s => s !== '')
      .map(s => castType(s, elem));
  }
  if (type === 'bool') return raw === true || raw === 'true' || raw === '1' || raw === 1;
  if (type === 'uint' || type === 'udint') return Math.max(0, parseInt(raw, 10) || 0);
  if (type === 'int' || type === 'dint') return Math.round(parseFloat(raw) || 0);
  if (type === 'real' || type === 'lreal') return parseFloat(raw) || 0;
  return String(raw ?? '');
}

/* ─────────── 变量变化 → 刷新绑定控件 ─────────── */
const attrEsc = (s) => (globalThis.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

function refreshBoundEverywhere(name) {
  // ⚠ 一次查表就够：boundIndex 是「画面/弹窗重画」时建好的 变量名 → [{w,el}]。
  //    以前这里是「所有页面 × 所有控件」全扫（500 控件 × 500 变量变化 = 25 万次判断），
  //    现在只碰真正绑了这个变量的那几个控件（通常 1~5 个）。
  const list = boundIndex.get(name);
  if (list) {
    for (let i = 0; i < list.length; i++) {
      const w = list[i].w, el = list[i].el;
      // 控件可能已经被换页/关弹窗换掉了（索引是上一版画面的）→ 元素不在文档里就跳过
      if (!el.isConnected) continue;
      const inp = el.querySelector('input');
      // 正在输入中的控件不打断（本地焦点优先）
      if (inp && document.activeElement === inp) continue;

      if (w.type === 'input') {
        // ⚠️ 这里是「变量变化」的就地更新路径：以前直接塞原始值，
        //    读回来的 REAL 12.34567928314209 会把整条浮点尾巴显示在输入框里。
        //    显示要和 render 一致（按小数位），并且记下显示的样子，
        //    免得用户点进来又点出去时把四舍五入后的值当输入写回 PLC。
        if (inp) {
          const shown = fmtValue(varStore.get(name), numberFmtOf(w.props));
          inp.value = shown;
          inp.dataset.shown = shown;
        }
      } else {
        refreshWidgetBody(el, w, 'run', varStore);
        // refreshWidgetBody 重建了 DOM → input 事件重新绑一遍（只有 input 控件需要）
        if (w.type === 'input' && w.bindings?.variable) {
          const inp2 = el.querySelector('input');
          if (inp2) {
            inp2.addEventListener('keydown', e => {
              if (e.key === 'Enter') { commitInput(w, inp2); inp2.blur(); }
            });
            inp2.addEventListener('blur', () => commitInput(w, inp2));
          }
        }
      }
    }
  }
  // 变量面板：只更新那一行 —— 不整表重建，否则正在输入其它变量时会被夺走焦点和已输内容。
  // ⚠ 走「变量名 → 行」的缓存表，别再每次 querySelectorAll 出一整个数组再 find
  //   （500 个变量一起变就是白扔 500 次数组分配）。表在变量列表重画时重建。
  const row = rowOfVar(name);
  if (row) updateVarRow(row, name);        // 不在当前窗口里的行不用刷（滚动过去时会按最新值画）
}

/* 变量监控「变量名 → 行元素」的缓存。
   为什么不直接 querySelector：500 个变量一起变时每次都全表找一遍是白扔的开销。
   为什么要重建：窗口化列表在 rAF 里才画行、滚动时还会整批重建（旧行脱离文档），
   所以这张表**定期（250ms）重建一次**最省心，重建本身只是查一次可视区那几十行。
   取出来还要核一遍名字 —— 行会被回收复用成别的变量，名字对不上就当没有。 */
let rowIndex = null, rowIndexAt = 0;
function rebuildRowIndex() {
  rowIndex = new Map();
  if (rtvList) rtvList.querySelectorAll('.rtv-row').forEach(r => rowIndex.set(r.dataset.vname, r));
}
function rowOfVar(name) {
  if (!rtvList) return null;
  const now = performance.now();
  if (!rowIndex || now - rowIndexAt > 250) { rebuildRowIndex(); rowIndexAt = now; }
  const row = rowIndex.get(name);
  return (row && row.isConnected && row.dataset.vname === name) ? row : null;
}

/** 监控列显示文本：浮点只留 6 位有效数字（原始值仍然照旧下发，只是看着不糊） */
function monitorText(v, val) {
  if ((v.type === 'real' || v.type === 'lreal') && typeof val === 'number') {
    return String(Number(val.toPrecision(6)));
  }
  return String(val ?? '');
}

/** 就地刷新变量抽屉某一行（正在输入的那一行不打断） */
function updateVarRow(row, name) {
  const v = project.variables().find(x => x.name === name);
  const input = row.querySelector('input');
  if (!v || !input) return;
  if (document.activeElement === input) return;   // 本地焦点优先
  const val = varStore.get(name);
  if (v.type === 'bool') { input.checked = !!val; return; }
  const shown = monitorText(v, val);
  input.value = shown;
  input.dataset.shown = shown;
}

/* ─────────── 变量监控抽屉 ─────────── */
let monVl = null;                // 变量监控的窗口化列表（变量上万时不整表建 DOM）

/** 本页「普通控件」在用的变量（**波形控件整个跳过**）。
 *  「不看后台」靠它判断：一个变量虽然被波形通道/报警条件占着，但本页还有别的控件在用它
 *  （比如同一个量既有曲线又有数值），那就不是"纯后台"，得留着 —— 藏了现场反而没法核对。 */
function pagePlainVars() {
  const names = new Set();
  const ids = [pageStack[pageStack.length - 1], ...popupStack.map(p => p.id)].filter(Boolean);
  ids.forEach(id => project.renderWidgets(project.getPage(id)).forEach(w => {
    if (w.type === 'trend') return;
    if (w.bindings?.variable) names.add(w.bindings.variable);
    (w.bindings?.variables || []).forEach(n => n && names.add(n));
    Object.keys(w.props?.colors || {}).forEach(n => n && names.add(n));
    Object.keys(w.props?.scales || {}).forEach(n => n && names.add(n));
    (w.actions || []).forEach(a => { if (a.params?.variable) names.add(a.params.variable); });
  }));
  return names;
}

/** 「在采的 N 个是怎么来的」——本页 / 报警条件 / 波形通道 / 上一页保留，逐项写清 */
function breakdownText(short) {
  const p = currentParts;
  const bits = [`本页（含公共底/弹窗）${p.self.size} 个`];
  if (p.alarm.size) bits.push(`报警条件 ${p.alarm.size} 个`);
  if (p.trend.size) bits.push(`波形通道 ${p.trend.size} 个`);
  if (p.keep.size) bits.push(`刚离开那页保留 ${p.keep.size} 个`);
  const head = `在采 ${currentScope.size} 个 = ` + bits.join(' + ');
  if (short) return head;
  return head + '\n（报警条件/波形通道一直采：不采报警不会触发、波形会断开）';
}

function renderVarsPanel() {
  if (!rtvList) return;
  const all = project.variables();
  // 1000+ 变量全列出来要建几千个节点、每次进运行态都卡一下；
  // 默认只列「本页在采的」（按页采集那一套：本页控件 + 报警条件 + 波形通道），
  // 想写别的变量就把监控头上的「只看本页」勾掉。
  const only = rtvOnly ? rtvOnly.checked : true;
  const noBg = rtvNoBg ? rtvNoBg.checked : false;
  const scopedList = only && currentScope.size ? all.filter(v => currentScope.has(v.name)) : all;
  // 「不看后台」：波形通道（示波器）、报警条件一直在后台采，跟当前画面无关，列表常被它们占满。
  // 但本页**别的控件**上也在用的照旧列出来（波形控件不算：它的通道正是要收起来的那批）。
  const bg = new Set([...currentParts.trend, ...currentParts.alarm]);
  const hiddenNames = new Set();
  if (noBg) {
    const plain = pagePlainVars();
    for (const v of scopedList) if (bg.has(v.name) && !plain.has(v.name)) hiddenNames.add(v.name);
  }
  const list = hiddenNames.size ? scopedList.filter(v => !hiddenNames.has(v.name)) : scopedList;
  const q = varFilter;
  const vars = q
    ? list.filter(v => `${v.name} ${v.address || ''}`.toLowerCase().includes(q))
    : list;

  const cnt = document.getElementById('rtvCount');
  if (cnt) {
    const narrowed = (only && currentScope.size) || hiddenNames.size;
    cnt.textContent = all.length
      ? (narrowed ? ` (${vars.length}/${all.length})` : ` (${vars.length}${q ? '/' + all.length : ''})`)
      : '';
    cnt.title = (all.length && only) ? breakdownText() : '';
  }

  // 说明行（本页没用到变量 / 后端旧版）单独放在列表上面，不参与窗口化。
  // ⚠ 「在采 N 个 = 本页 + 报警条件 + 波形通道…」「已收起后台采集的 N 个…」这类信息行现场嫌吵，
  //   已经去掉：想看明细鼠标停在标题的 (N/M) 上（title 里还是那份逐项拆解），
  //   列表里留的只有"真出事"的两条 —— 本页没用到变量、后端是旧版本。
  let tipBox = rtvList.querySelector('.rtv-tips');
  if (!tipBox) {
    tipBox = document.createElement('div');
    tipBox.className = 'rtv-tips';
    rtvList.insertBefore(tipBox, rtvList.firstChild);
  }
  tipBox.innerHTML = '';
  if (currentScope.size === 0 && all.length) {
    const tip = document.createElement('div');
    tip.className = 'rtv-tip';
    tip.textContent = '本页没用到变量：按页采集只采「本页用到的 + 报警条件 + 波形通道」，别的显示未采集、值不会刷新。';
    if (backend.isOnline() && !backend.supports('page_scope')) {
      tip.textContent += '（当前后端是旧版本，其实还在全量采集 —— 重启后端后按页采集才生效）';
    }
    tipBox.appendChild(tip);
  } else if (backend.isOnline() && !backend.supports('page_scope') && all.length) {
    const tip = document.createElement('div');
    tip.className = 'rtv-tip';
    tip.textContent = '后端是旧版本：还在全量采集（重启后端后按页采集才生效）。';
    tipBox.appendChild(tip);
  }

  let host = rtvList.querySelector('#rtvRows');
  if (!host) {
    host = document.createElement('div');
    host.id = 'rtvRows';
    rtvList.appendChild(host);
  }
  if (!monVl) {
    monVl = createVList({
      scroller: rtvList,
      host,
      rowH: 34,
      keyOf: v => v.name,
      makePad: h => {
        const d = document.createElement('div');
        d.className = 'rtv-pad';
        d.style.height = Math.round(h) + 'px';
        return d;
      },
      renderRow: v => buildVarRow(v),
    });
  }
  monVl.setItems(vars);
  rowIndex = null;       // 行要重画了 → 「变量名 → 行」的缓存作废（下次查的时候重建）
}

/** 监控里的一行：变量名 + 值（可改，改了才下发）+ 未采集标记 */
function buildVarRow(v) {
  const row = document.createElement('div');
  row.className = 'rtv-row';
  row.dataset.vname = v.name;
  const isArr = /\[\]$/.test(String(v.type || ''));
  let ctrl = '';
  const val = varStore.get(v.name);
  if (isArr) {
    // 数组：监控里只给「看」（一段数据逐格编辑没意义，要改用脚本 hmi.set('arrw[3]', v)）
    const shown = Array.isArray(val) ? val.join(', ') : String(val ?? '');
    ctrl = `<input class="rtv-val" type="text" value="${esc(shown)}" readonly
      title="数组（${v.len || '?'} 个 ${String(v.type).replace('[]', '')}）：监控里只读；要改写用脚本 hmi.set('${v.name}[0]', 值)">`;
  } else if (v.type === 'bool') {
    ctrl = `<label class="rtv-switch rtv-val">
      <input type="checkbox" ${val ? 'checked' : ''}>
      <span class="track"></span></label>`;
  } else if (v.type === 'string' || v.type === 'wstring') {
    const s = String(val ?? '');
    ctrl = `<input class="rtv-val" type="text" value="${esc(s)}" data-shown="${esc(s)}">`;
  } else {
    const isFloat = v.type === 'real' || v.type === 'lreal';
    // 监控列只用来"看"：浮点保留 6 位有效数字（12.34567928314209 → 12.3457），
    // 不然 REAL 读回来那一长串尾巴糊满一列。改了才按输入的值下发（没改不写回）
    const shown = monitorText(v, val);
    ctrl = `<input class="rtv-val" type="number" step="${isFloat ? 'any' : '1'}" value="${esc(shown)}" data-shown="${esc(shown)}">`;
  }
  // 变量名常显（长名靠 title 看全）：名称 + 类型 + 地址；不在本页采集范围里的标一下
  const scoped = !currentScope.size || currentScope.has(v.name);
  const tip = `${v.name}　类型: ${v.type}${v.len ? `（长度 ${v.len}）` : ''}　地址: ${v.address || '(未设置)'}`
    + (scoped ? '' : '\n本页没用到 → 不参与轮询（切到用它的页面才会刷新；波形通道例外，一直在采）');
  row.innerHTML = `<span class="rtv-name" title="${esc(tip)}">${esc(v.name)}</span>${ctrl}`
    + (scoped ? '' : '<span class="rtv-skip" title="本页采集范围之外，值不会刷新（波形通道例外）">未采集</span>');
  const input = row.querySelector('input');
  if (isArr) return row;                        // read-only，不挂写回
  input.addEventListener('change', () => {
    // 只是点进来又退出（没改）→ 不要把显示用的舍入值写回去
    if (input.dataset.shown !== undefined && input.value === input.dataset.shown) return;
    const value = v.type === 'bool' ? input.checked : castType(input.value, v.type);
    input.dataset.shown = input.value;
    varStore.set(v.name, value, 'local');
  });
  return row;
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
