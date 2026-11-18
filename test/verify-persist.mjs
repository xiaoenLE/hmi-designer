// verify-persist.mjs — 「换个浏览器 / 换个地址打开，东西还在吗？」
// 背景：客户机上一体机/PyWebView **每次打开都是新的浏览器 profile**（localStorage 空的），
//       127.0.0.1 与局域网 IP 打开也各自一份 localStorage。所以真正该落盘的东西必须存服务器。
//
// 本套件验四件事：
//   ① 报警记录存**服务器**（server/data/alarm_history.json）：另一个浏览器打开照样看得到；
//   ② 报警记录**环形存储**：超过 5MB 从最早那条开始丢，最近的留得住；
//   ③ 编辑器面板布局**跟着工程走**（project.data.layout.dock）：存服务器/存文件都带着；
//   ④ 本机浏览器里没有工程时，启动**自动从服务器读回**（本机有工程则绝不覆盖）。
//
// 用法：node test/verify-persist.mjs
//   自己拉起一个**独立数据目录**的后端（不碰 8866 上正在跑的那套，也不动它的工程/记录）。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
/** 轮询等条件成立（报警判定 200ms 一拍、落盘是异步的，不能死等固定毫秒）*/
const waitFor = async (fn, ms = 8000) => {
  for (let i = 0; i < ms / 200; i++) {
    try { if (await fn()) return true; } catch { /* 再等 */ }
    await sleep(200);
  }
  return false;
};

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-persist-'));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来（' + PY + '）'); srv.kill(); process.exit(1); }
console.log(`（独立后端 ${H}，数据目录 ${DATA}）`);

const api = async (url, opt = {}) => {
  const r = await fetch(H + url, {
    ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
};
const alarmsOnServer = async () => (await api('/api/alarms')).json?.history || [];
const projectOnServer = async () => (await api('/api/project')).json?.data || null;

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const errs = [];
/** 页面控制台的 warn/error：报警同步失败时 alarms.js 会往控制台说原因，
 *  断言只写"历史是空的"是查不出原因的 —— 把它一起带进失败信息里。 */
const logs = [];
/** 开一个"浏览器"（每个 context 都是独立存储 —— 正是 PyWebView 每次都是新 profile 的样子）*/
async function openCtx(w = 1400, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') logs.push(m.type() + ': ' + m.text()); });
  page.on('dialog', d => d.accept());
  return { ctx, page };
}
const bootApp = async (page, url, runOnly = false) => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 15000 });
  if (runOnly) await page.waitForFunction(() => document.querySelectorAll('#rtPage .wd').length > 0, null, { timeout: 15000 });
  await sleep(300);
};

/* ══════ 0. 管理员：往服务器放一份带报警的工程（客户机读的就是这一份）══════ */
const A = await openCtx();
await bootApp(A.page, H + '/');
const saved = await A.page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { backend } = await import('/js/api/backend.js');
  project.data.meta.name = '持久化测试工程';
  project.data.alarms = [];
  project.addAlarm({
    id: 'al_speed', name: '超速', variable: 'rSpeed', op: '>=', value: 100,
    level: 'alarm', text: '主轴转速过高：{rSpeed}',
  });
  await backend.saveProject(project.data);
  return { alarms: project.data.alarms.length, name: project.data.meta.name };
});
ok('管理员把带报警的工程存到服务器（运行页读的就是这一份）',
  saved.alarms === 1 && (await projectOnServer())?.meta?.name === '持久化测试工程', JSON.stringify(saved)
  + ` 服务器上=${JSON.stringify((await projectOnServer())?.meta?.name || null)}`);
ok('刚开始：服务器上还没有报警记录', (await alarmsOnServer()).length === 0);

/* ══════ 1. 报警触发 → 记录落进服务器（不是只躺在这个浏览器的 localStorage 里）══════ */
await A.page.evaluate(() => window.app.enterRun());
await sleep(500);
await A.page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('rSpeed', 150);           // 超过阈值 → 报警
});
const raisedOnServer = await waitFor(async () => (await alarmsOnServer()).length >= 1);
const rec = (await alarmsOnServer())[0] || {};
ok('① 报警一触发，记录就写进服务器 server/data/alarm_history.json',
  raisedOnServer && rec.key === 'al_speed' && /主轴转速过高/.test(rec.text || '') && rec.endAt === 0,
  JSON.stringify(rec));
ok('① 记录文件真的在数据目录里（不是内存里假装存了）',
  fs.existsSync(path.join(DATA, 'alarm_history.json')) &&
  /主轴转速过高/.test(fs.readFileSync(path.join(DATA, 'alarm_history.json'), 'utf-8')));

/* ══════ 2. 换个"浏览器"打开运行页（localStorage 全新）→ 记录还在 ══════ */
const B = await openCtx(1280, 800);
await bootApp(B.page, H + '/run', true);
const seenInB = await waitFor(async () => {
  const n = await B.page.evaluate(async () => (await import('/js/runtime/alarms.js')).alarmHistory().length);
  return n >= 1;
});
const infoB = await B.page.evaluate(async () => {
  const A2 = await import('/js/runtime/alarms.js');
  const { backend } = await import('/js/api/backend.js');
  // 顺手把"读服务器那份"的原始结果/错误带出来：只报"历史是空的"查不出原因
  let raw = null, err = '';
  try { raw = await backend.loadAlarms(); } catch (e) { err = String((e && e.message) || e); }
  return {
    local: localStorage.getItem('hmi-alarm-history'),          // 新浏览器：本来是空的
    hist: A2.alarmHistory().map(r => r.text),
    sync: A2.syncState(),
    raw: Array.isArray(raw) ? 'array(' + raw.length + ')' : JSON.stringify(raw),
    err, online: backend.isOnline(),
  };
});
ok('② 新浏览器（localStorage 空的）打开就看到了服务器上那条报警记录',
  seenInB && infoB.hist.some(t => /主轴转速过高/.test(t)),
  `本地缓存=${infoB.local ? '有' : '空'} 历史=${JSON.stringify(infoB.hist)} sync=${JSON.stringify(infoB.sync)}`
  + ` 直接读=${infoB.raw} 错误=${infoB.err || '无'} 在线=${infoB.online}`
  + (logs.length ? ` 控制台=${logs.slice(-3).join(' | ')}` : ''));
ok('② 两个页面同时判定同一条报警**不会记出重复记录**（服务器上仍然只有 1 条）',
  (await alarmsOnServer()).length === 1, `共 ${(await alarmsOnServer()).length} 条`);

/* ══════ 3. 「清空报警记录」要连服务器那份一起清（否则刷新/换地址又回来了）══════ */
await B.page.evaluate(async () => { (await import('/js/runtime/alarms.js')).clearHistory(); });
const cleared = await waitFor(async () => (await alarmsOnServer()).length === 0);
ok('③ 清空报警记录 → 服务器那份也清了', cleared, `服务器上还有 ${(await alarmsOnServer()).length} 条`);

/* ══════ 3b. 清空之后新报的警必须照样记下来 ══════
   踩过的坑：清空标记发成功之后没清掉，后面每次落盘都又带一次 {clear:true}
   —— 服务器"先清再加"，于是**后一条记录会把前一条顶掉**，历史看着一直在丢 */
const setSpeed = (v) => B.page.evaluate(async (val) => {
  (await import('/js/runtime/varstore.js')).varStore.set('rSpeed', val);
}, v);
await setSpeed(50);                        // 先把那条报警恢复正常（阈值是 >=100，要降到 100 以下）
await sleep(600);
await setSpeed(260);                       // 再超限 → 新记一条
const firstBack = await waitFor(async () => (await alarmsOnServer()).length === 1);
await setSpeed(50);                        // 再恢复 → 那一条补上恢复时间
await waitFor(async () => ((await alarmsOnServer())[0] || {}).endAt > 0);
await setSpeed(300);                       // 又超限 → 第二条
await waitFor(async () => (await alarmsOnServer()).length === 2);
const two = await alarmsOnServer();
ok('③ 清空之后新报的警照样记下来（后一条不会把前一条顶掉）',
  firstBack && two.length === 2 && two.some(r => /260/.test(r.text || '')) && two.some(r => /300/.test(r.text || '')),
  JSON.stringify(two.map(r => r.text)));

await A.ctx.close();
await B.ctx.close();

/* ══════ 4. 环形存储：超过 5MB 从最早那条开始丢 ══════ */
const BASE = Date.now() - 40 * 24 * 3600 * 1000;
const mk = (i) => ({ key: 'rk' + i, id: 'rk' + i, name: '压测' + i, text: '压测记录 ' + i,
  level: 'warn', value: i, at: BASE + i * 1000, endAt: 0, acked: false });
const TOTAL = 40000;
/* ⚠ 一批别超过长连接的单帧上限（server/wschannel.py 的 MAX_FRAME = 1MB）：
   一条 10000 条的记录 ≈ 1.3MB，后端会按协议回 1009（消息太大）并断开 ——
   1.x 走 HTTP 时没这个限制，2.0 一律走长连接，所以这里按 2000 条一批发。 */
for (let from = 0; from < TOTAL; from += 2000) {
  const chunk = [];
  for (let i = from; i < from + 2000; i++) chunk.push(mk(i));
  const r = await api('/api/alarms', { method: 'POST', body: JSON.stringify({ add: chunk }) });
  if (r.status !== 200) { ok('④ 压测写入', false, JSON.stringify(r.json)); break; }
}
const ring = await alarmsOnServer();
const ringBytes = Buffer.byteLength(JSON.stringify({ history: ring }), 'utf-8');
const fileBytes = fs.statSync(path.join(DATA, 'alarm_history.json')).size;
const hasNewest = ring.some(r => r.key === 'rk' + (TOTAL - 1));
const hasOldest = ring.some(r => r.key === 'rk0');
ok('④ 报警记录环形存储：文件不超过 5MB（超了丢最早的，最近的留得住）',
  fileBytes <= 5 * 1024 * 1024 && ringBytes <= 5 * 1024 * 1024 + 4096 && hasNewest && !hasOldest,
  `文件 ${(fileBytes / 1048576).toFixed(2)}MB，留下 ${ring.length}/${TOTAL} 条，最新一条在=${hasNewest}，最老一条还在=${hasOldest}`);

/* ══════ 5. 布局跟着工程走：摆好的面板，换个浏览器打开还是那样 ══════ */
const C = await openCtx();
await bootApp(C.page, H + '/');
const moved = await C.page.evaluate(async () => {
  const dock = await import('/js/editor/dock.js');
  const { project } = await import('/js/core/project.js');
  dock.dockPanelTo('vars', 'bottom');           // 把「变量」面板停到底部
  dock.floatPanelById('properties');            // 再把「属性」弹成浮动窗
  await new Promise(r => setTimeout(r, 200));
  return { bottom: dock._getLayout().bottom, float: dock._getLayout().float.map(f => f.id),
    savedInProject: !!project.data.layout?.dock };
});
ok('⑤ 摆面板 = 写进工程数据（project.data.layout.dock），不再是浏览器私有的 localStorage',
  moved.savedInProject && moved.bottom.includes('vars') && moved.float.includes('properties'),
  JSON.stringify(moved));

await C.page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { backend } = await import('/js/api/backend.js');
  await backend.saveProject(project.data);      // 「存到服务器」
});
const onSrvLayout = (await projectOnServer())?.layout?.dock;
ok('⑤ 「存到服务器」把布局一起带走了（工程文件里就有 layout.dock）',
  !!onSrvLayout && (onSrvLayout.bottom || []).includes('vars'),
  JSON.stringify(onSrvLayout && { bottom: onSrvLayout.bottom, float: (onSrvLayout.float || []).map(f => f.id) }));

const D = await openCtx();
await bootApp(D.page, H + '/');
const inD = await D.page.evaluate(async () => {
  const dock = await import('/js/editor/dock.js');
  const { project } = await import('/js/core/project.js');
  const varsPanel = document.getElementById('panel-vars');
  return {
    name: project.data.meta.name,
    bottom: dock._getLayout().bottom,
    whereVars: varsPanel?.closest('.dock')?.id || (varsPanel?.classList.contains('floating') ? 'float' : '?'),
    note: document.getElementById('stNote')?.textContent || '',
  };
});
ok('④ 新浏览器（没有工程）打开编辑器 → 自动从服务器读回工程 + 布局一起回来了',
  inD.name === '持久化测试工程' && inD.bottom.includes('vars') && inD.whereVars === 'bottomPanel',
  JSON.stringify(inD));
ok('④ 自动读回来时在状态栏说了一句（不然会以为"怎么自己变了"）',
  /自动从服务器读回/.test(inD.note), inD.note);

/* ══════ 6. 本机有工程就绝不覆盖（自动读回只针对"本机什么都没有"）══════ */
await D.page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.data.meta.name = '本机改过的工程';
  project.commit('改名');
});
// 等自动保存（800ms 防抖）落进浏览器缓存，再刷新 —— 刷新太早本地这份还没写下去
await waitFor(async () => D.page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('hmi-designer-project-v1') || '{}')?.meta?.name === '本机改过的工程'; }
  catch { return false; }
}), 4000);
await D.page.reload({ waitUntil: 'domcontentloaded' });
await D.page.waitForFunction(() => window.app?.project?.data);
await sleep(300);
const afterReload = await D.page.evaluate(() => window.app.project.data.meta.name);
ok('⑥ 本机已有工程时，刷新不会又被服务器那份顶掉（不静默覆盖用户的东西）',
  afterReload === '本机改过的工程', afterReload);
await D.ctx.close();
await C.ctx.close();

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 跨浏览器持久化回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
