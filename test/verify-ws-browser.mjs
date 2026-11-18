// verify-ws-browser.mjs — 前端真的走长连接、且**稳态一个轮询请求都不发**
//
// 后端侧的协议体检见 test/verify-ws.py；这一份验的是前端接上去之后的行为：
//   1. 页面（编辑器和运行页）都建立起 WebSocket；
//   2. 进运行态之后**晾着不动**：/api/plc、/api/poll、/api/vars 一个请求都不许发
//      —— 这三条就是以前"越跑越卡"的来源（每 3 秒 / 每 10 秒 / 每 30 秒一发）；
//   3. 变量推送照常：外部 HTTP 写一个值，画面上的数字控件要跟着变；
//   4. 写在长连接上：从画面上改值，后端要真收到；
//   5. 退回路径还在：后端没有 websocket 能力时必须回落到 SSE（旧后端照常能用）。
//
// 用法：node test/verify-ws-browser.mjs [端口]（自己起后端，端口参数忽略）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const ROOT = path.resolve(import.meta.dirname, '..');
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-wsbr-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_POLL_ALWAYS: '1' } });

let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await sleep(300);
  try { await fetch(`http://127.0.0.1:${PORT}/api/health`); up = true; } catch { /* 等它起来 */ }
}
if (!up) { console.log('后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));

// 记录所有 HTTP 请求（WS 升级请求不算 —— 它是长连接建立那一下）
const hits = [];
page.on('request', r => {
  const u = new URL(r.url());
  if (u.origin !== `http://127.0.0.1:${PORT}`) return;
  hits.push({ path: u.pathname, method: r.method() });
});
const countSince = (from, matcher) => hits.slice(from).filter(h => matcher(h.path)).length;

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.waitForTimeout(400);

  // 造两个变量 + 两个数字控件（跟 verify-sse-batch 一样的路子）
  const ids = await page.evaluate(async () => {
    const { project } = await import('/js/core/project.js');
    project.data.variables.length = 0;
    ['n1', 'n2'].forEach((n, i) => project.data.variables.push(
      { name: n, type: 'int', address: '%MW' + (100 + i), value: 0, len: 0 }));
    project.currentPage().widgets.length = 0;
    const mk = (name, x) => {
      const w = project.addWidget('number', x);
      project.updateWidgetField(w.id, 'bindings.variable', name);
      return w.id;
    };
    const out = { a: mk('n1', 20), b: mk('n2', 200) };
    project.commit('t');
    return out;
  });
  await page.waitForTimeout(200);

  // ── 1. 编辑器（没进运行态）也应该连上长连接 ──
  const edStats = await page.evaluate(() => window.app.backend.wsStats());
  ok('编辑器也建立了长连接', edStats.open === true, JSON.stringify(edStats));

  await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).enterRun(); });
  await page.waitForTimeout(600);

  const runStats = await page.evaluate(() => window.app.backend.wsStats());
  ok('运行页长连接已就绪', runStats.open === true, JSON.stringify(runStats));

  // ── 2. 稳态零轮询（这条是整件事的重点） ──
  const mark = hits.length;
  await page.waitForTimeout(6000);                 // 晾 6 秒（以前这 6 秒里会有 2~3 个 /api/plc）
  const pollPaths = p => p === '/api/plc' || p === '/api/poll' || p === '/api/vars';
  const nPlc = countSince(mark, p => p === '/api/plc');
  const nPoll = countSince(mark, p => p === '/api/poll');
  const nVars = countSince(mark, p => p === '/api/vars');
  const other = countSince(mark, p => !pollPaths(p));
  ok('6 秒内没有再问 /api/plc（原来每 3 秒一个）', nPlc === 0, `${nPlc} 次`);
  ok('6 秒内没有再发 /api/poll 心跳（原来每 10 秒一个）', nPoll === 0, `${nPoll} 次`);
  ok('6 秒内没有再拉 /api/vars 全量（原来每 30 秒一个）', nVars === 0, `${nVars} 次`);
  console.log(`      （这 6 秒里总共 ${other} 个其它请求：${JSON.stringify(hits.slice(mark).map(h => h.path))}）`);

  // ── 3. 变量推送照常（外部写 → 画面跟着变） ──
  const val = async (id) => Number(await page.evaluate((id) => {
    const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .wn-val`);
    return el ? el.textContent : 'NaN';
  }, id));

  await fetch(`http://127.0.0.1:${PORT}/api/vars`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'n1', value: 77 }),
  });
  await page.waitForTimeout(400);
  ok('外部写的值经长连接推到画面', (await val(ids.a)) === 77, String(await val(ids.a)));

  // 3b. 批量帧 {"vars":{…}}：后端一次轮询里变了多个变量时会合成一条
  //     （500 个变量一起变也只发一条 —— 长连接这边帧格式与 SSE 完全一致，共用同一套解析）。
  //     这种帧由后端轮询触发，测试里造不出来，所以直接把帧喂给通道自己那层派发。
  await page.evaluate(() => {
    window.app.backend._channel._dispatch({ vars: { n1: 111, n2: 222 } });
  });
  await page.waitForTimeout(150);
  const ba = await val(ids.a), bb = await val(ids.b);
  ok('长连接上的批量帧 {"vars":{…}} 一条能刷多个控件', ba === 111 && bb === 222, `${ba} / ${bb}`);

  // 3c. 报警广播帧 {alarm:…} 走长连接也要转成 alarms:remote（不用刷新页面）
  const gotRemote = await page.evaluate(async () => {
    const { bus } = await import('/js/core/eventBus.js');
    let seen = null;
    const h = (d) => { seen = d; };
    bus.on('alarms:remote', h);
    window.app.backend._channel._dispatch({ alarm: { clear: true } });
    await new Promise(r => setTimeout(r, 50));
    return seen;
  });
  ok('长连接上的报警帧转成 alarms:remote 事件', !!gotRemote && gotRemote.clear === true,
    JSON.stringify(gotRemote));

  // ── 4. 写在长连接上（从画面改值 → 后端真收到） ──
  const before = countSince(0, p => p === '/api/vars' && true);
  await page.evaluate(async () => {
    const { varStore } = await import('/js/runtime/varstore.js');
    varStore.set('n2', 313, 'local');
  });
  await page.waitForTimeout(700);
  const sv = await (await fetch(`http://127.0.0.1:${PORT}/api/vars`)).json();
  ok('从画面改的值真的写进了后端', Number(sv.vars?.n2) === 313, String(sv.vars?.n2));
  const afterWrites = hits.filter(h => h.path === '/api/vars' && h.method === 'POST').length;
  ok('这次写没有产生 POST /api/vars（走的是长连接）', afterWrites === 0, `${afterWrites} 次 POST`);

  // ── 5. 长连接状态里没有堆积的请求 ──
  const st2 = await page.evaluate(() => window.app.backend.wsStats());
  ok('长连接在收到帧（推送是活的）', st2.frames > 5, `frames=${st2.frames}`);
  ok('没有卡住等应答的请求', st2.pending === 0, `pending=${st2.pending}`);

  // ── 6. 退回路径：后端没有 websocket 能力 → 必须回落到 SSE ──
  const fallback = await page.evaluate(async () => {
    const b = window.app.backend;
    b._channel?.stop();
    b._channel = null;
    b.features = b.features.filter(f => f !== 'websocket');   // 假装后端是旧版本
    b.stopEvents();
    b.startEvents(() => {}, () => {});
    await new Promise(r => setTimeout(r, 400));
    const usedSse = !!b._es;
    const usedWs = !!b._channel;
    // 复原，别影响后面的检查
    b.features = [...b.features, 'websocket'];
    b.stopEvents();
    return { usedSse, usedWs };
  });
  ok('后端没有 websocket 能力时回落到 SSE', fallback.usedSse === true && fallback.usedWs === false,
    JSON.stringify(fallback));

  ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 前端长连接（零轮询）：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
