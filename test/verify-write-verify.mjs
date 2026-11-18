// verify-write-verify.mjs — 「写下去 ≠ 设备保持住了」：写后回读仲裁
//
// 现场问题（TS600 真机，2.1.7）：点一下切换按钮，HMI 上按钮和指示灯都亮了，
// 但 PLC 上的输出只闪一下就灭了（三菱 FX 系 TS600：HMI 用 FC05 写 Y，PLC 不在 RUN
// 或程序里用 OUT 每扫描周期覆盖 Y，写了立刻被改回去）。HMI 却一直亮着 —— 因为老逻辑是：
//
//   写下去 TRUE 后开「写后保护窗口」1s，窗口内回读到的**跟目标值不一样**的值当作
//   "写之前的旧回读"直接**丢掉**。而后端只在"值变了"时才推一条 —— 写 TRUE 之后
//   PLC 立刻改回 FALSE，只来这**一条** FALSE 推送，正好落在窗口里被丢掉；
//   之后再没有变化 → 界面永远停在 TRUE（按钮、指示灯都亮着，设备早灭了）。
//
// 现在改成：窗口内回读**记账**（不立刻盖界面），窗口一到就**重新读一次设备**再结账：
//   设备值跟写下去的不一样 → 界面跟着设备改回来，并报 vars:overridden（运行时弹「设备没保持」）。
//   —— 口径：**按钮只是把值交给设备，界面最终以设备为准**。
//
// 另外两条口径一起锁住：
//   · 「一定要先读取再写入」：切换(toggle)先读设备当前值、再写反值（不拿界面缓存取反）
//   · 后端读不到（刚断/没采到）时**不误判**：保留本地值、不报"设备没保持"
//
// 用法：node tools/run-suites.mjs verify-write-verify   （自己起隔离后端）
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

/* 写通道换成一台录音机 + 一台可控的假设备：
   __dev      = 设备上的值（backend.readVars 就把这份交出去）
   __readNull = 模拟"后端读不到"（刚断/还没采到）
   __writes   = 每一次下发（[名字, 值]）
   __ov       = 收到的 vars:overridden（"设备没保持"） */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  const b = m.backend;
  window.__writes = [];
  window.__dev = { bY: false };
  window.__readNull = false;
  window.__ov = [];
  b.plcLink = { mode: 'plc', online: true };
  b.probe = async () => null;
  b.expectsServer = () => true;
  b.getPlc = async () => ({
    status: {
      mode: 'plc', online: true, paused: false, vars: 1, host: '127.0.0.1', port: 502,
      unit: 1, protocol: 'modbus', addr_profile: 'ts600-modbus-tcp', word_order: 'cdab', errors: 0,
    },
  });
  b.writeVar = async (n, v) => { window.__writes.push([n, v]); window.__dev[n] = v; return { ok: true }; };
  b.writeVarsBatch = async () => [];
  b.readVars = async () => (window.__readNull ? null : { ...window.__dev });
  b.readVar = async n => (window.__readNull ? undefined : window.__dev[n]);
  b.syncVarTable = async () => false;
  b.declareVariables = async () => false;
  b.setPolling = async () => null;
  b.startEvents = () => {};
  b.loadAlarms = async () => [];
  b.saveAlarms = async () => ({ ok: true });
  b.pollOnce = async () => null;
}));

await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => {
  const m = window.app.project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'bY', type: 'bool', address: 'D0', value: false, len: 0 });
  const vs = window.app.varStore;
  vs.resetFrom(m.variables());
  vs.noteLink('plc', true);      // 「真设备 + 在线」
  vs.confirmFullRead();          // 已经读到过数据 → 允许写
  window.app.bus.on('vars:overridden', e => window.__ov.push(e));
});
await sleep(300);

/* ── 小工具 ── */
const val = () => page.evaluate(() => window.app.varStore.get('bY'));
const writes = () => page.evaluate(() => window.__writes.slice());
const ovs = () => page.evaluate(() => window.__ov.slice());
const clear = () => page.evaluate(() => { window.__writes = []; window.__ov = []; });
const dev = (v) => page.evaluate(v => { window.__dev.bY = v; }, v);
const push = (v) => page.evaluate(v => window.app.varStore.applyRemote({ bY: v }), v);
const nullReads = (on) => page.evaluate(on => { window.__readNull = on; }, on);
const setLocal = (v) => page.evaluate(v => window.app.varStore.set('bY', v, 'local'), v);
const sleepPastWindow = () => sleep(1300);   // 保护窗口 1000ms + 排队的回读结账

/* ══════ ① 基线：设备保持住了 → 界面不回退、不报错 ══════ */
{
  await dev(false); await push(false); await clear();
  await setLocal(true);
  await dev(true);                 // 设备真的保持住了
  await sleepPastWindow();
  ok('① 设备保持住了：界面值不回退（TRUE 还是 TRUE）', (await val()) === true, String(await val()));
  ok('① 设备保持住了：不报「设备没保持」', (await ovs()).length === 0, JSON.stringify(await ovs()));
}

/* ══════ ② 设备没保持、而且**一条变化推送都没来**（现场形态）══════ */
{
  await dev(false); await push(false); await clear();
  await setLocal(true);
  await dev(false);                // PLC 程序 / 不在 RUN：写下去立刻被改回去，后端没推变化
  await sleepPastWindow();
  const ov = await ovs();
  ok('② 设备没保持：界面回退成设备值（亮着的按钮灭掉）', (await val()) === false, String(await val()));
  ok('② 设备没保持：报了一条 vars:overridden（运行时弹「设备没保持」）',
    ov.length === 1 && ov[0].written === true && ov[0].device === false, JSON.stringify(ov));
}

/* ══════ ③ 窗口内来了一条"旧回读"推送 → 先扣住，窗口到点按设备收 ══════ */
{
  await dev(false); await push(false); await clear();
  await setLocal(true);
  await dev(false);               // PLC 程序 / 不在 RUN：写下去立刻被改回去
  await push(false);              // 后端又把写之前的旧值推来了（落在保护窗口里）
  ok('③ 保护窗口内的旧回读：先不盖掉界面值（TRUE 还在）', (await val()) === true, String(await val()));
  await sleepPastWindow();
  ok('③ 窗口到点：按设备真值收回来（FALSE）', (await val()) === false, String(await val()));
}

/* ══════ ④ 后端读不到（刚断/没采到）→ 不误判、不报错、保留本地值 ══════ */
{
  await dev(true); await push(true); await clear(); await nullReads(true);
  await setLocal(false);
  await sleepPastWindow();
  ok('④ 后端读不到：保留写下去的值（不拿"读不到"当"没保持"）', (await val()) === false, String(await val()));
  ok('④ 后端读不到：不误报「设备没保持」', (await ovs()).length === 0, JSON.stringify(await ovs()));
  await nullReads(false);
  await dev(false); await push(false);
}

/* ══════ ⑤ 切换(toggle)：先读设备、再写反值（不拿界面缓存取反）══════ */
{
  await dev(true);                 // 设备上是 TRUE
  await page.evaluate(() => { window.app.varStore.values.bY = false; });   // 界面缓存是旧的 FALSE
  await clear();
  await page.evaluate(async () => { await window.app.varStore.toggle('bY'); });
  const w = await writes();
  ok('⑤ 切换先读设备：设备 TRUE → 写的是 FALSE（不是拿界面 FALSE 取反成 TRUE）',
    w.length === 1 && w[0][1] === false, JSON.stringify(w));
  await dev(false); await sleep(1300);
}

/* ══════ ⑥ 切换时读不到设备 → 退回"界面值取反"（不能卡死）══════ */
{
  await nullReads(true);
  await page.evaluate(() => { window.app.varStore.values.bY = true; });
  await clear();
  await page.evaluate(async () => { await window.app.varStore.toggle('bY'); });
  const w = await writes();
  ok('⑥ 读不到设备：退回界面值取反（TRUE → 写 FALSE）', w.length === 1 && w[0][1] === false, JSON.stringify(w));
  await nullReads(false);
  await dev(false); await push(false);
}

await sleep(200);
ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(results.join('\n'));
console.log(`\n==== 写后回读仲裁（设备没保持要跟着设备改回来 / 切换先读后写）：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
