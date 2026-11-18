/**
 * main.js — 应用入口：组装各模块（依赖注入 + 初始化顺序）
 *
 * 两种页面：
 *   · 编辑器    http://<机器>:8866/      要登录（后端把关），下面那一整套模块都初始化
 *   · 现场运行  http://<机器>:8866/run   不用登录，**只**初始化运行态那几个模块
 *     （编辑器模块在客户机上连加载都不加载 —— 见下面的 RUN_ONLY 分支）
 */
import { bus } from './core/eventBus.js';
import { project } from './core/project.js';
import { history } from './core/history.js';
import { storage } from './core/storage.js';
import { backend } from './api/backend.js';
import { varStore } from './runtime/varstore.js';
import { statusNote } from './core/utils.js';

// 副作用导入：触发控件定义注册（必须早于 project.load()）—— 两种页面都要
import './widgets/defs.js';

/* 调试句柄 + 错误收集（联调用）
   ⚠ 只留最近 MAX_ERR 条：这是个"只会往后加"的数组，一旦某个错误在运行态里反复出现
   （定时器里的异常、失败的 promise），跑一晚上就是几十万条字符串挂在内存里。*/
const MAX_ERR = 200;
window.__appErrors = [];
const noteErr = (s) => {
  window.__appErrors.push(s);
  if (window.__appErrors.length > MAX_ERR) window.__appErrors.shift();
};
window.addEventListener('error', e => noteErr(String(e.message)));
window.addEventListener('unhandledrejection', e => noteErr(String(e.reason)));

/* ── 运行专属模式（客户机）：后端 /run 会给这份页面插一句 window.__HMI_RUN_ONLY__=true ──
   客户/现场只开 http://<机器>:8866/run —— 没有编辑器、没有工具条、没有右键菜单，
   工程从服务器读，进页面直接进运行态；要改东西得管理员用密码登录 /（见 README「给客户用」）。*/
const RUN_ONLY = window.__HMI_RUN_ONLY__ === true;
if (RUN_ONLY) document.body.classList.add('run-only');

/* ── 启动序列 ── */
project.load();

/**
 * 本机浏览器里没有工程（客户机/PyWebView **每次打开都是新的浏览器 profile**，
 * localStorage 是空的；也可能是清了站点数据、换了台机器）→ 启动时自动把
 * 「存到服务器」那份读回来，别让现场对着一个演示工程发懵（以为工程丢了）。
 *
 * ⚠ 只在**本地确实没有工程**（或现在这份还是没动过的默认演示工程）时才动，
 *   本地有用户自己的工程绝不覆盖 —— 见 project.needServerPull()。
 * ⚠ 放在界面初始化之前：这样画面/面板一上来就是对的，不会先画一遍演示工程再刷掉。
 */
async function pullServerProjectIfNeeded() {
  if (!project.needServerPull()) return false;
  let data = null;
  try {
    data = await backend.loadProject();          // GET /api/project 不需要登录
  } catch { return false; }                      // 后端没开：保持本地这份，照常能用
  if (!data || !Array.isArray(data.pages) || !data.pages.length) return false;
  const name = data.meta?.name || '未命名工程';
  // 当前这份只是"没动过的默认演示工程"时不用备份（备份它只会把「恢复上一个工程」里
  // 真正有用的那份顶掉）；本地有真东西才留备份
  const backup = project.data?.meta?.autoSeed !== true;
  storage.replaceProject(data, '自动读回服务器工程', { backup });
  storage.cacheNow();                                  // 当场落进浏览器缓存，别等防抖
  console.log(`[boot] 本机没有工程 → 已自动从服务器读回「${name}」`);
  statusNote(`本机浏览器里没有工程，已自动从服务器读回「${name}」`, 12000);
  return true;
}
if (!RUN_ONLY) await pullServerProjectIfNeeded();

// 撤销栈快照回调注入（保持 history 与 project 单向依赖）
// ⚠ **面板布局不进撤销栈**：布局跟着工程存（project.data.layout），但它不是"编辑内容"——
//   如果不排掉，Ctrl+Z 会把面板位置也一起退回去（摆一下面板再撤销，面板自己跳走，很莫名）。
//   所以快照里去掉 layout，恢复时再把当前布局接回去。
history.init({
  get: () => JSON.stringify(project.data, (k, v) => (k === 'layout' ? undefined : v)),
  set: json => {
    const data = JSON.parse(json);
    data.layout = project.data?.layout;
    project.replaceData(data);
  },
});
history.push('初始状态');

// 编辑态绑定预览的初值
varStore.resetFrom(project.variables());
// 「地址留空 = 内部变量」：写它不碰设备，所以**不受"没连上不许传"那道门限制**。
// 判定放这儿（varstore 不反向依赖 project，保持单向）。
// ⚠ 表里**没有**的名字更简单：那是脚本的临时量（`_lenAcc` 这种），
//   既不发给设备、也不发后端，只活在本地 —— 见下面的 isDeclaredVar 与 varstore.push()。
varStore.isInternalVar = (name) => {
  const v = project.variables().find(x => x.name === name);
  return !!v && !String(v.address || '').trim();
};
// 「这个名字在变量表里吗」——不在 = 脚本临时量：写它一个请求都不发（别弹「未在变量表声明」）
varStore.isDeclaredVar = (name) => project.variables().some(x => x.name === name);

/* 各模块依次初始化。
   ⚠️ 每个都单独 try/catch：某个模块因为 DOM 不匹配（例如浏览器缓存了旧页面）、
   或某个面板被删掉而抛错时，不能让后面的模块全部停摆 —— 那会变成「外壳在、面板全空」。

   运行专属模式（/run，给现场/客户）：**编辑器那几个模块连加载都不加载**（动态 import），
   客户机上压根没有编辑器代码，也就不可能从界面或控制台上摸到"改"的入口。 */
let MODULES, canvasMod = null, trendMod = null, clockMod = null, rtMod = null;

if (RUN_ONLY) {
  rtMod = await import('./runtime/runtime.js');
  trendMod = await import('./runtime/trend.js');
  clockMod = await import('./widgets/clock.js');
  MODULES = [
    ['runtime', rtMod.initRuntime],
    ['trend', trendMod.initTrend],          // 波形抓取（采样 + 逐帧绘制）
    ['clock', clockMod.startClockTicker],   // 时钟控件走时
  ];
} else {
  const [canvasM, toolboxM, pagesM, varsM, alarmsM, scriptsM, scriptEdM, propsM,
    toolbarM, listM, panelsM, dockM, menusM, ctxM, rtM, trendM, clockM, varSearchM, widgetIOM, updateM] = await Promise.all([
    import('./editor/canvas.js'), import('./editor/toolbox.js'), import('./editor/pagesPanel.js'),
    import('./editor/varsPanel.js'), import('./editor/alarmsPanel.js'), import('./editor/scriptsPanel.js'),
    import('./editor/scriptEditor.js'), import('./editor/properties.js'), import('./editor/toolbar.js'),
    import('./editor/listPanel.js'), import('./editor/panels.js'), import('./editor/dock.js'),
    import('./editor/menus.js'), import('./core/contextMenu.js'), import('./runtime/runtime.js'),
    import('./runtime/trend.js'), import('./widgets/clock.js'), import('./editor/varSearch.js'),
    import('./editor/widgetIO.js'), import('./editor/updateCheck.js'),
  ]);
  canvasMod = canvasM; trendMod = trendM; clockMod = clockM; rtMod = rtM;
  MODULES = [
    ['panels', panelsM.initPanels],
    ['dock', dockM.initDock],            // 面板停靠（会移动面板元素 → 必须在面板模块建 UI 之前跑）
    ['toolbar', toolbarM.initToolbar],
    ['toolbox', toolboxM.initToolbox],
    ['pagesPanel', pagesM.initPagesPanel],
    ['varsPanel', varsM.initVarsPanel],
    ['alarmsPanel', alarmsM.initAlarmsPanel],
    ['scriptEditor', scriptEdM.initScriptEditor],   // 编辑器浮层要先建（面板里点 ✎ 会用到）
    ['scriptsPanel', scriptsM.initScriptsPanel],
    ['listPanel', listM.initListPanel],
    ['properties', propsM.initProperties],
    ['canvas', canvasM.initCanvas],
    ['runtime', rtM.initRuntime],
    ['trend', trendM.initTrend],         // 波形抓取（采样 + 逐帧绘制）
    ['clock', clockM.startClockTicker],  // 时钟控件走时（一个定时器刷新所有时钟文字）
    ['contextMenu', ctxM.initContextMenu],
    ['menus', menusM.initMenus],
    ['widgetIO', widgetIOM.initWidgetIO],     // 控件包导入（#widgetPackFile 的文件框；导出走右键菜单）
    ['varSearch', varSearchM.initVarSearch],   // Ctrl+F = 查找变量在哪用到 / 替换
    ['updateCheck', updateM.initUpdateCheck],  // 状态栏显示版本号 + 「有新版本」提示（只提示，不自动更新）
  ];
  storage.init();                        // 自动保存/落盘那一套只有编辑器要
}

MODULES.forEach(([name, fn]) => {
  try {
    fn();
  } catch (e) {
    noteErr(`[init:${name}] ${e && e.message}`);
    console.error(`[init:${name}] 初始化失败（其余模块继续）`, e);
  }
});

// 后台探测一次 Python 后端（编辑态仅更新状态栏；运行模式会真正建立数据流）
// 状态栏那颗灯由 backend.paintStatusBar() 统一画：
// 后端是旧版本（改了 modbus/server 没重启）时会直接显示「后端：旧版本(需重启)」，
// 不用等连 PLC 才发现字序/字长/字符串长度这些设置根本没生效
if (!RUN_ONLY) backend.probe().then(() => backend.paintStatusBar());

/* 全局调试句柄（编辑器那几项只在编辑器页面有；运行页面给 undefined 不报错） */
window.app = { project, history, bus, backend, varStore,
  getZoom: canvasMod?.getZoom, setZoom: canvasMod?.setZoom, zoomFit: canvasMod?.zoomFit,
  tickClocksNow: clockMod?.tickClocksNow,   // 测试/调试用：立刻把所有时钟刷成"现在"
  trend: { seriesOf: trendMod?.seriesOf, clear: trendMod?.clearTrend, setPaused: trendMod?.setPaused,
    isPaused: trendMod?.isPaused, cursorOf: trendMod?.cursorOf, PALETTE: trendMod?.PALETTE },
  // 运行页面「PLC 掉线提醒」的节奏（现场可调：pollMs 多久问一次、remindMs 多久再提醒一次）
  plcWatch: { pollMs: 3000, remindMs: 10000 },
  // 离开页面后，那一页的变量还保留采多久（毫秒）。默认 **0 = 不保留**（纯按页采集：
  // 切走就不采了，免得来回翻几页后「在采的变量数」一直涨、看着像在偷读）；
  // 现场想留一段（来回切页数据不断）就设成 10000 之类。
  scopeKeep: { keepMs: 0 },
  // 采集范围明细（本页 / 报警条件 / 波形通道 / 上一页保留 各几个）：控制台 app.scopeSummary()
  scopeSummary: () => import('./runtime/runtime.js').then(m => m.scopeSummary()),
  enterRun: () => import('./runtime/runtime.js').then(m => m.enterRun()),
  exitRun: () => import('./runtime/runtime.js').then(m => m.exitRun()),
  gotoPage: (id) => import('./runtime/runtime.js').then(m => m.gotoPage(id)),
  runOnly: RUN_ONLY };          // true = 这份页面是给现场用的（/run，没有编辑器）

/* 「不在运行态就不跟设备通讯」：编辑页面（不是 /run）打开时先注销登记 + 问一下后端状态 ——
   后端一个登记的客户端都没有时就不轮询设备（现场要求：编辑画面别占着 PLC 通讯口）。
   /run 客户页走下面的 enterRun()，那里会登记「有人在看画面」。 */
if (!RUN_ONLY) {
  backend.setPolling(false).then(() => backend.paintStatusBar()).catch(() => {});
}
// 页面关闭/刷新时顺手注销（sendBeacon，卸载时也发得出去），不让后端白采 30 秒
window.addEventListener('pagehide', () => backend.leavePolling());

// 状态栏那颗「后端」灯点一下 = 切「编辑态也一直采设备」：
// 默认编辑态不采（现场要求：改画面别占设备通讯口），但调试时想一边改一边看 PLC 上的值就用它。
document.getElementById('stBackend')?.addEventListener('click', () => backend.toggleAlwaysPoll());

/* 编辑态也显示「这一页运行时会采多少变量 / 合并成几次读」：
   只把**采集范围**下发给后端（后端据此算块数，算法与运行态同一个），
   而没人在运行态时后端不读设备（见 server/poll_gate.py）—— 所以这纯粹是预览，不产生设备通讯。
   运行态由 runtime.js 自己按页下发，这里让开（mode:changed 里判）。 */
if (!RUN_ONLY) {
  let runningNow = false;
  let previewTimer = null;
  const pushPreview = async () => {
    if (runningNow) return;
    const { editorPageVarNames } = await import('./editor/pageScopePreview.js');
    // 只问「这一页会采几个变量/几块」，**不动后端的变量表**（见 backend.previewScope 的说明）
    backend.previewScope(editorPageVarNames(project.currentId));
  };
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(pushPreview, 250);      // 切页/改工程时抖一下，别每敲一下就发一次
  };
  bus.on('page:current', schedulePreview);
  bus.on('project:changed', schedulePreview);
  bus.on('mode:changed', ({ mode }) => {
    runningNow = mode === 'run';
    if (!runningNow) schedulePreview();
  });
  schedulePreview();
}

if (RUN_ONLY) {
  /* 客户机流程：工程从**服务器**读（这台机器的浏览器里没有 localStorage 工程），
     读完直接进运行态。 */
  (async () => {
    let loaded = false;
    try {
      const r = await fetch('/api/project');
      const j = await r.json();
      if (j && j.data && Array.isArray(j.data.pages) && j.data.pages.length) {
        project.replaceData(j.data);
        loaded = true;
        document.title = `${j.data?.meta?.name || 'HMI'} · 运行`;
      }
    } catch (e) {
      noteErr('[run] 读服务器工程失败：' + (e && e.message));
    }
    if (!loaded) {
      /* 服务器上还没有工程（第一次装机就是这种状态）。
         ⚠ 以前这里只挂一条「还没有工程 + 去 /login」的提示就 return ——
           客户第一次打开看到的是一句提示和一条通往编辑器的链接，**根本没进运行态**，
           看着像"这软件装完不能跑"。现在改成：只要本地有一份能显示的画面（全新机器
           就是内置演示工程），就**先进运行态**，角上常显一句说明告诉管理员下一步。 */
      const usable = Array.isArray(project.data?.pages) && project.data.pages.length > 0;
      if (usable) {
        showRunNotice('<b>演示画面</b>（服务器上还没有工程）'
          + '<br>管理员：<b>Ctrl+Shift+E</b> 登录 → 「工程 ▾ → 存到服务器」，客户机刷新即为正式画面');
        await import('./runtime/runtime.js').then(m => m.enterRun());
        return;
      }
      const box = document.getElementById('bootHint');
      if (box) {
        box.innerHTML = '<b>服务器上还没有工程</b>'
          + '<div>现场运行画面用的是「存到服务器」的那一份工程，现在服务器上还没有。</div>'
          + '<div>管理员：打开 <a href="/login" style="color:#60a5fa">/login</a> 登录后，'
          + '在编辑器里点「工程 ▾ → 存到服务器」，刷新本页即可。</div>';
        box.classList.remove('hidden');
      }
      return;
    }
    await import('./runtime/runtime.js').then(m => m.enterRun());
  })();
}

/** 运行页左下角常显一句说明（不挡画面、不用点掉）——目前只有"显示的是演示画面"用 */
function showRunNotice(html) {
  const el = document.getElementById('rtNotice');
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

console.log('%cWebHMI_设计器已启动', 'color:#2563eb;font-weight:bold');
