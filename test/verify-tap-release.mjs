// verify-tap-release.mjs — 点动(tap)「松手必须停」：松手那一下不能被丢掉
//
// 现场问题（手机等触屏设备上映射端口看画面）：点动按钮偶尔「松手了输出还保持」，
// 而且不是每次都复现（看时序）。点动是"按住 = TRUE / 松手 = FALSE"两个时刻的一对动作，
// **丢了松手那一半 = 机器一直走**，所以这里把几条真实成因各造一遍：
//
//   A. 松手事件送不到那个控件上：
//      A1 触摸被系统抢走（下拉通知栏 / 来电 / 系统手势）—— 一个事件都不补，看下一次触摸能不能救回来
//      A1b 两根手指同时按（现场"按住点动 + 按住使能"的用法）**不能**被误当成丢了
//      A2 按住中换页 / A3 按住中弹窗整层重画（手机上地址栏/软键盘/转屏 → resize 就重画弹窗）
//      A4 按住中切到后台（锁屏 / 来电 / 切应用）  A5 窗口失焦
//   B. 松手那一下"发出去了但被吞了"：
//      B1 按住期间后端回读的**旧值**把界面值盖回去 → 松手时被判成"值没变"→ 一个字节都不下发
//      B2 刚重连还没读到数据 / B3 设备掉线 —— 停止命令被链路门静默丢弃
//   D. 老行为一条都不能变（鼠标点动、移出松手、长按点动、没配变量的点动、别变成刷屏）
//
// 用法：node tools/run-suites.mjs verify-tap-release   （自己起隔离后端）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);

const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
// hasTouch：手机/触摸屏那条路 —— 用**真的**触摸事件（CDP 派发），不是拿鼠标冒充
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
const page = await ctx.newPage();
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
const cdp = await ctx.newCDPSession(page);

/* 后端隔离：本套件只看"松手有没有下发出去"，所以把写通道换成一台录音机（记下每一次下发），
   其余读写通道一起掐掉，跑起来才可重复。 */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  window.__writes = [];
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.expectsServer = () => true;
  m.backend.writeVar = async (n, v) => { window.__writes.push([n, v]); return { ok: true }; };
  m.backend.writeVarsBatch = async () => [];
  m.backend.readVars = async () => null;
  m.backend.readVar = async () => undefined;
  m.backend.syncVarTable = async () => false;
  m.backend.declareVariables = async () => false;
  m.backend.setPolling = async () => null;
  m.backend.startEvents = () => {};
  m.backend.loadAlarms = async () => [];
  m.backend.saveAlarms = async () => ({ ok: true });
}));
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => { try { localStorage.removeItem('hmi-alarm-history'); } catch { /* 忽略 */ } });
await sleep(300);

/* ── 造画面 ─────────────────────────────────────────────────────────
   画面1：点动按钮（bTap）+ 长按点动（bHold，holdMs=300）+ 没配变量的点动（bNone）
   画面2：空页面（测"按住中换页"）
   弹窗1：点动按钮（bPop）—— 窗口尺寸一变，弹窗整层会重画 */
const ids = await page.evaluate(() => {
  const m = window.app.project;
  m.data.variables.length = 0;
  m.data.alarms.length = 0;
  [['bTap', '%MX0.0'], ['bHold', '%MX0.2'], ['bPop', '%MX0.1']]
    .forEach(([name, address]) => m.data.variables.push({ name, type: 'bool', address, value: false, len: 0 }));
  const pg = m.data.pages[0];
  m.setCurrentPage(pg.id);
  pg.widgets.length = 0;
  const mk = (x, y, vname, holdMs) => {
    const w = m.addWidget('button', x, y);
    if (vname) {
      m.updateWidgetField(w.id, 'bindings.variable', vname);
      m.updateWidgetActions(w.id, [{ trigger: 'click', type: 'tap', params: { variable: vname } }]);
    }
    if (holdMs) m.updateWidgetProp(w.id, 'holdMs', holdMs);
    return w.id;
  };
  const jog = mk(80, 220, 'bTap');
  const hold = mk(280, 220, 'bHold', 300);
  const none = mk(480, 220, '');                       // 没配变量的点动：不该有反应，也不该报错
  const pg2 = m.addPage('page');
  const pop = m.addPage('popup');
  const popW = mk(40, 40, 'bPop');
  m.setCurrentPage(pg.id);
  m.commit('点动松手测试');
  return { jog, hold, none, page: pg.id, page2: pg2.id, pop: pop.id, popW };
});
await page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  await rt.enterRun();
  rt.hideRuntimeHint();          // 快捷键提示条别压着控件
});
await sleep(400);

/* ── 小工具 ── */
const val = (n) => page.evaluate(n => window.app.varStore.get(n), n);
/** 清掉录音机，并把某个变量按"后端推来的"改掉（= 后端轮询/回读那一路：runtime 走的是 applyRemote） */
const setVals = (obj) => page.evaluate(o => {
  window.__writes = [];
  window.app.varStore.applyRemote(o);
}, obj);
const writesOf = (n) => page.evaluate(n => (window.__writes || []).filter(w => w[0] === n).map(w => w[1]), n);
const lastWrite = (n) => page.evaluate(n => {
  const l = (window.__writes || []).filter(w => w[0] === n);
  return l.length ? l[l.length - 1][1] : null;
}, n);
const centerOf = async (sel) => {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error('找不到控件：' + sel);
  return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
};
const jogSel = (id) => `#rtPage .wd[data-id="${id}"]`;
const popSel = (id) => `#rtPopupLayer .wd[data-id="${id}"]`;

/** 真·触摸：按下 / 抬起分开两步（中间可以做别的事，模拟"半路出事"） */
const touchDown = (x, y) => cdp.send('Input.dispatchTouchEvent',
  { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }] });
const touchUp = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
/** 记下最后一次 pointerdown 的 pointerId（合成事件要跟真触摸对上号） */
const watchPids = () => page.evaluate(() => {
  window.__pids = [];
  if (!window.__pidHook) {
    window.__pidHook = true;
    document.addEventListener('pointerdown', e => { (window.__pids ||= []).push(e.pointerId); }, true);
  }
});

/* ── A0. 触摸通道本身可用（不然下面几条测的就是空气）── */
await setVals({ bTap: false });
await watchPids();
let c = await centerOf(jogSel(ids.jog));
await touchDown(...c);
await sleep(80);
ok('A0 真触摸：按住点动 → TRUE（触摸通道可用）', (await val('bTap')) === true, String(await val('bTap')));
await touchUp();
await sleep(80);
ok('A0 真触摸：正常松手 → FALSE', (await val('bTap')) === false, String(await val('bTap')));

/* ── A1. 触摸被系统抢走（下拉通知栏 / 来电 / 系统手势）：宿主一个事件都不补。
       用户下一次在画面上按下去时，那笔"按住"必须被放开。
       判据（只用指针事件，因为"触摸被拿走"这件事浏览器只在指针事件里说得清）：
       新按下的这个 **isPrimary=true**（按下时第一个指针才是 primary，第二根手指是 false）
       就说明浏览器认为"正在按的那个"已经不在活动指针里了。
       ⚠ 这里用合成的 pointerdown 派发（事件属性就是浏览器会给的那套）——CDP 那套触摸
         没法造出"上一个触摸凭空消失"这种状态。 */
await setVals({ bTap: false });
await watchPids();
await touchDown(...c);
await sleep(80);
ok('A1 系统抢走触摸前：变量是 TRUE', (await val('bTap')) === true, String(await val('bTap')));
const a1 = await page.evaluate(({ x, y }) => {
  const target = document.elementFromPoint(x, y) || document.body;
  target.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: 4242, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: y,
  }));
  return window.app.varStore.get('bTap');
}, { x: c[0] + 90, y: c[1] });
ok('A1 触摸被系统抢走后，下一次按下先把上一次卡住的点动放开（变量回 FALSE）',
  a1 === false, String(a1));
await touchUp();                                   // 收拾：把这次触摸收掉
await sleep(80);

/* ── A1b. 两根手指同时按（现场"按住点动 + 按住使能"）：老二 isPrimary=false → 不许放开 ── */
await setVals({ bTap: false });
await touchDown(...c);
await sleep(80);
const a1b = await page.evaluate(({ x, y }) => {
  const target = document.elementFromPoint(x, y) || document.body;
  target.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: 4243, pointerType: 'touch', isPrimary: false, bubbles: true, clientX: x + 340, clientY: y,
  }));
  return window.app.varStore.get('bTap');
}, { x: c[0], y: c[1] });
ok('A1b 两根手指同时按：按住中的点动**不能**被误放开（还是 TRUE）', a1b === true, String(a1b));
await touchUp();
await sleep(120);
ok('A1b 收拾干净：松手后回到 FALSE', (await val('bTap')) === false, String(await val('bTap')));

/* ── A2. 按住中换页（控件被重画）：手指抬起时那个控件已经不在文档里 ── */
await setVals({ bTap: false });
await touchDown(...c);
await sleep(80);
ok('A2 按住中：变量是 TRUE', (await val('bTap')) === true, String(await val('bTap')));
await page.evaluate(id => window.app.gotoPage(id), ids.page2);
await sleep(150);
await touchUp();                                   // 手指抬起（落点已经不是原来那个控件了）
await sleep(150);
ok('A2 按住中换页（控件被重画）→ 松手后变量必须回 FALSE（不能卡在 TRUE）',
  (await val('bTap')) === false, String(await val('bTap')));
await page.evaluate(id => window.app.gotoPage(id), ids.page);
await sleep(200);

/* ── A3. 按住中弹窗整层重画（手机：地址栏/软键盘/转屏 → resize → 弹窗重画）── */
await page.evaluate(id => import('/js/runtime/runtime.js').then(m => m.showPopup(id)), ids.pop);
await sleep(250);
await setVals({ bPop: false });
const cp = await centerOf(popSel(ids.popW));
await touchDown(...cp);
await sleep(80);
ok('A3 弹窗里的点动按住 → TRUE', (await val('bPop')) === true, String(await val('bPop')));
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
await sleep(200);
ok('A3 重画后手指还没抬：仍按着（TRUE）', (await val('bPop')) === true, String(await val('bPop')));
await touchUp();
await sleep(200);
ok('A3 按住中弹窗被重画 → 松手后变量必须回 FALSE（不能卡在 TRUE）',
  (await val('bPop')) === false, String(await val('bPop')));
await page.evaluate(() => window.__hmiRuntime.hidePopup());
await sleep(200);

/* ── A4. 按住中切到后台（锁屏 / 来电 / 切应用）—— 手机必走这条 ── */
await setVals({ bTap: false });
await touchDown(...c);
await sleep(80);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(120);
ok('A4 按住中切到后台（visibilitychange=hidden）→ 变量必须回 FALSE',
  (await val('bTap')) === false, String(await val('bTap')));
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
await touchUp();
await sleep(80);

/* ── A5. 按住中窗口失焦（桌面上的弹窗/切窗口，手机上被别的应用盖住）── */
await setVals({ bTap: false });
await touchDown(...c);
await sleep(80);
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await sleep(120);
ok('A5 按住中窗口失焦 → 变量必须回 FALSE', (await val('bTap')) === false, String(await val('bTap')));
await touchUp();
await sleep(80);

/* ── A6. 最后一道保险（默认关）：app.tapGuard.maxHoldMs ——
       某些工控 WebView 里连 touchcancel 都不发，什么事件都拿不到时，按住超过这么久自己放开
       （宁可误停也不能一直走）。默认 0 = 不启用，老行为一点不变。 */
await setVals({ bTap: false });
await page.evaluate(() => { window.app.tapGuard.maxHoldMs = 250; });
await touchDown(...c);
await sleep(100);
const a6mid = await val('bTap');
await sleep(320);                                    // 超过 250ms
const a6after = await val('bTap');
const a6why = await page.evaluate(() => window.app.tapGuard.lastWhy);
await touchUp();
await sleep(100);
ok('A6 松手最长保持=250ms：没到点还按着 / 到点自己放开',
  a6mid === true && a6after === false, JSON.stringify([a6mid, a6after]));
ok('A6 放开理由记在 app.tapGuard.lastWhy（诊断"松手还在走"先看它）',
  a6why === 'max-hold', String(a6why));

await page.evaluate(() => { window.app.tapGuard.maxHoldMs = 0; });
await setVals({ bTap: false });
await touchDown(...c);
await sleep(420);
const a6b = await val('bTap');
await touchUp();
await sleep(120);
ok('A6b 默认（maxHoldMs=0）不启用：按住 420ms 仍然是 TRUE（老行为不变）',
  a6b === true, String(a6b));
ok('A6b 正常松手的理由记成 pointerup', (await page.evaluate(() => window.app.tapGuard.lastWhy)) === 'pointerup',
  String(await page.evaluate(() => window.app.tapGuard.lastWhy)));

/* ── B1. 按住期间后端回读的**旧值**把界面值盖回去 → 松手必须照样下发 ──
   （这是"松手还在走"的另一半：事件没丢，但 FALSE 被"值没变"吞了） */
await setVals({ bTap: false });
c = await centerOf(jogSel(ids.jog));
await touchDown(...c);
await sleep(80);
ok('B1 按住 → 下发 TRUE', (await lastWrite('bTap')) === true, String(await lastWrite('bTap')));
await setVals({ bTap: false });        // 后端推回旧值（写还没落到 PLC，下个周期读到的还是 FALSE）
await sleep(60);
ok('B1 回读的旧值不能把按住中的界面值盖掉（仍是 TRUE）',
  (await val('bTap')) === true, String(await val('bTap')));
await touchUp();
await sleep(150);
ok('B1 松手 → FALSE 必须真的下发出去（不能被"值没变"吞掉）',
  (await lastWrite('bTap')) === false, JSON.stringify(await writesOf('bTap')));
ok('B1 松手后变量是 FALSE', (await val('bTap')) === false, String(await val('bTap')));

/* ── B2. 刚重连（还没读到数据）那一下：按住照旧被拦，但松手那笔不能丢 ── */
await setVals({ bTap: false });
await page.evaluate(() => {
  window.app.backend.plcLink = { mode: 'plc', online: true };
  window.app.varStore.noteLink('plc', true);      // 链路状态一变 → 又要"先读一遍"
  window.__writes = [];
});
await touchDown(...c);
await sleep(80);
const b2press = await writesOf('bTap');
await touchUp();
await sleep(150);
ok('B2 刚连上还没读到数据时的「按住」照旧被拦（一个字节都不发）',
  b2press.length === 0, JSON.stringify(b2press));
ok('B2 但松手那一下（停止命令）不许被静默丢弃 → 依然下发 FALSE',
  (await lastWrite('bTap')) === false, JSON.stringify(await writesOf('bTap')));

/* ── B3. 设备掉线时的松手：命令照样发出去（成败由后端/界面说话，不能悄悄吞）── */
await page.evaluate(() => {
  window.app.backend.plcLink = { mode: 'plc', online: false };
  window.app.varStore.noteLink('plc', false);
  window.__writes = [];
});
await touchDown(...c);
await sleep(80);
await touchUp();
await sleep(150);
ok('B3 设备掉线时松手也照样下发 FALSE（成败由后端说，不由前端偷偷吞）',
  (await lastWrite('bTap')) === false, JSON.stringify(await writesOf('bTap')));
await page.evaluate(() => {
  window.app.backend.plcLink = { mode: '', online: false };
  window.app.varStore.noteLink('', false);
});
await sleep(60);

/* ── D. 老行为回归（改了松手那条路，这些一条都不能变）── */
// D1 鼠标点动：按下 TRUE / 松开 FALSE
await setVals({ bTap: false });
await page.mouse.move(c[0], c[1]);
await page.mouse.down();
await sleep(90);
const d1down = await val('bTap');
await page.mouse.up();
await sleep(120);
ok('D1 鼠标点动：按住 TRUE / 松开 FALSE', d1down === true && (await val('bTap')) === false,
  JSON.stringify([d1down, await val('bTap')]));

// D2 按住后移出控件 → 照旧算松手（pointerleave 那条不变）
await setVals({ bTap: false });
await page.mouse.move(c[0], c[1]);
await page.mouse.down();
await sleep(80);
await page.mouse.move(c[0], c[1] + 260);
await sleep(100);
const d2out = await val('bTap');
await page.mouse.up();
await sleep(100);
ok('D2 按住后移出控件 → 立刻放开（移出就算松手）', d2out === false, String(d2out));

// D3 鼠标"在别处又按了一下"（上一次按下早就结束了）→ 卡住的那笔也要放开
await setVals({ bTap: false });
await watchPids();
await page.mouse.move(c[0], c[1]);
await page.mouse.down();
await sleep(80);
await page.evaluate(() => { window.__writes = []; });   // 只看"再按一下"之后发生了什么
await page.mouse.move(c[0], c[1] + 300);
await page.mouse.down();                                 // 没有松开过：同 id 再按 = 上一次早就结束了
await sleep(120);
const d3 = await val('bTap');
await page.mouse.up();
await sleep(120);
ok('D3 同一次按下又出现（同 pointerId）→ 先把上一次卡住的放开',
  d3 === false || (await lastWrite('bTap')) === false, JSON.stringify([d3, await writesOf('bTap')]));

// D4 长按点动（holdMs>0）：没到点不置 TRUE / 到点 TRUE / 松手 FALSE
await setVals({ bHold: false });
const ch = await centerOf(jogSel(ids.hold));
await page.mouse.move(ch[0], ch[1]);
await page.mouse.down();
await sleep(140);
const d4early = await val('bHold');
await sleep(300);                              // 累计 > 300ms
const d4fired = await val('bHold');
await page.mouse.up();
await sleep(120);
ok('D4 长按点动：没到点不置 TRUE / 到点置 TRUE / 松手 FALSE',
  d4early === false && d4fired === true && (await val('bHold')) === false,
  JSON.stringify([d4early, d4fired, await val('bHold')]));

// D5 没配变量的点动：按了不报错、不写任何变量
await page.evaluate(() => { window.__writes = []; });
const cn = await centerOf(jogSel(ids.none));
await page.mouse.move(cn[0], cn[1]);
await page.mouse.down();
await sleep(60);
await page.mouse.up();
await sleep(100);
const noneWrites = await page.evaluate(() => (window.__writes || []).length);
ok('D5 没配变量的点动：按了不报错、一个字节都不下发', noneWrites === 0, String(noneWrites));

// D6 重复写同一个值 → 只发一次（脚本定时写那种，不能被"必须补发"带成刷屏）
const rep = await page.evaluate(() => {
  window.__writes = [];
  const s = window.app.varStore;
  s.set('bTap', true, 'local');      // 变 → 发
  s.set('bTap', false, 'local');     // 变 → 发
  s.set('bTap', false, 'local');     // 没变 → 不发
  s.set('bTap', false, 'local');     // 没变 → 不发
  return (window.__writes || []).filter(w => w[0] === 'bTap').map(w => w[1]);
});
ok('D6 连着写同一个值不刷屏（只发真正变过的那两次）',
  rep.length === 2 && rep[0] === true && rep[1] === false, JSON.stringify(rep));

// D7 后端确认过目标值之后，继续重复写同一个值同样不发（防"改完变刷屏"）
const rep2 = await page.evaluate(() => {
  window.__writes = [];
  const s = window.app.varStore;
  s.set('bTap', true, 'local');
  s.set('bTap', true, 'remote');     // 后端读回来确认了 = 目标值已落地
  s.set('bTap', true, 'local');
  s.set('bTap', true, 'local');
  return (window.__writes || []).filter(w => w[0] === 'bTap').map(w => w[1]);
});
ok('D7 回读确认之后继续重复写同一个值 → 不发（脚本定时写不会变刷屏）',
  rep2.length === 1 && rep2[0] === true, JSON.stringify(rep2));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 点动松手可靠性：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
