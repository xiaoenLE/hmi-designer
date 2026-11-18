// verify-ws-only.mjs — ★ V2 的核心断言：**前端只走一条长连接，HTTP 一条接口都不打**
//
// 验的是「http 全删」这件事真的成立，而不只是"代码里删掉了"：
//   ① 打开 / 时页面能起来（登录态现在由长连接说了算，不再由后端挑页面）；
//   ② 全程**没有任何 /api/* 的 HTTP 请求**（只有静态文件 + 长连接握手那一次 GET /api/ws）；
//   ③ 数据真的在动：变量推送、写值、工程读取都经长连接走通；
//   ④ 没登录 → 页面按运行页跑（客户打开地址就是画面）；长连接上登录后 → 编辑器。
//
// 用法：node test/verify-ws-only.mjs（自己起隔离后端，带登录闸门，口令 admin123）
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
const PW = 'admin123';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (n, c, e = '') => {
  results.push({ n, ok: !!c });
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
};

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-wsonly-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_UPDATE_URL: '' } });

// 等后端起来：V2 没有 /，用「/ 能拿到页面」当判据
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(300);
  try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { /* 等 */ }
}
if (!up) { console.log('后端没起来'); srv.kill(); process.exit(1); }

const H = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));

// 记录所有 HTTP 请求：**除静态文件与 WS 握手之外，一个 /api/* 都不该有**
const hits = [];
page.on('request', r => {
  const u = new URL(r.url());
  if (u.origin !== H) return;
  hits.push({ path: u.pathname, method: r.method() });
});
// ⚠ 长连接握手在 Playwright 里**不算 request**（它有自己的 websocket 事件），
//   所以单独收一份 —— 不能靠 request 事件去认它
const wsUrls = [];
page.on('websocket', ws => wsUrls.push(ws.url()));
const apiHits = () => hits.filter(h => h.path.startsWith('/api/'));

try {
  /* ── 1. 未登录打开 / ：应该起得来，并按运行页跑 ── */
  await page.goto(H + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.project?.data, { timeout: 20000 });
  await page.waitForTimeout(2500);          // 给 boot 里的"问登录态"+ 进运行态留时间

  const boot1 = await page.evaluate(() => ({
    runOnly: document.body.classList.contains('run-only'),
    runtimeUp: !document.getElementById('runtimeRoot')?.classList.contains('hidden'),
    online: window.app.backend.isOnline(),
    loggedIn: window.app.backend.auth?.logged_in === true,
    ws: window.app.backend.wsStats(),
    editorCodeLoaded: !!window.app.getZoom,     // 编辑器模块加载了没（运行页不该加载）
  }));
  ok('未登录打开 / 能起来（长连接连上）', boot1.online === true, JSON.stringify(boot1.ws));
  ok('未登录 → 按运行页跑（body.run-only）', boot1.runOnly === true);
  ok('未登录 → 进了运行态（runtimeRoot 显示出来了）', boot1.runtimeUp === true);
  ok('未登录 → **编辑器代码根本没加载**（客户机上摸不到改的入口）',
    boot1.editorCodeLoaded === false, `getZoom=${boot1.editorCodeLoaded}`);

  /* ── 2. 全程零 /api/* HTTP ── */
  const marked = hits.length;
  await page.waitForTimeout(6000);          // 晾 6 秒（1.x 这 6 秒里有 /api/plc×2、/api/poll 心跳…）
  const api = hits.slice(marked).filter(h => h.path.startsWith('/api/'));
  ok('晾 6 秒：一个 /api/* HTTP 请求都没有', api.length === 0,
    api.map(h => h.path).join(',') || '无');
  ok('HTTP 只用来拿页面和静态文件（/ 与 css/js）',
    hits.every(h => h.path === '/' || /\.(js|css|ico|png|svg|json)$/.test(h.path)),
    JSON.stringify([...new Set(hits.map(h => h.path))].slice(0, 8)));
  ok('长连接握手指向 /api/ws（升级不是"接口调用"）',
    wsUrls.some(u => u.endsWith('/api/ws')), wsUrls.join(',') || '没抓到长连接');
  const st1 = await page.evaluate(() => window.app.backend.wsStats());
  ok('长连接在收帧（推送是活的）', st1.frames > 3, `frames=${st1.frames} sent=${st1.sent}`);

  /* ── 3. 数据真的经长连接在动 ── */
  const wrote = await page.evaluate(async () => {
    const { backend } = await import('/js/api/backend.js');
    await backend.writeVar('wsOnlyA', 42, { internal: true });
    const v = await backend.readVars();
    return v.wsOnlyA;
  });
  ok('经长连接写变量并读回', wrote === 42, String(wrote));

  const proj0 = await page.evaluate(async () => {
    const { backend } = await import('/js/api/backend.js');
    const p = await backend.loadProject();       // 全新数据目录：这里本来就没工程
    return { called: true, has: !!p };
  });
  ok('经长连接读工程存档（空库返回 null，不报错）', proj0.called === true && proj0.has === false,
    JSON.stringify(proj0));

  /* ── 4. 长连接上登录 → 刷新后是编辑器 ── */
  const login = await page.evaluate(async (pw) => {
    const { backend } = await import('/js/api/backend.js');
    try { await backend.login(pw); return { ok: true, token: !!localStorage.getItem('hmi-ws-token') }; }
    catch (e) { return { ok: false, error: e.message }; }
  }, PW);
  ok('长连接上登录成功（并拿到 token 存本地）', login.ok === true && login.token === true,
    JSON.stringify(login));

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.project?.data, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const boot2 = await page.evaluate(() => ({
    runOnly: document.body.classList.contains('run-only'),
    loggedIn: window.app.backend.auth?.logged_in === true,
    editorCodeLoaded: !!window.app.getZoom,
  }));
  ok('登录后（带 token 重连）→ 页面是编辑器，不是运行页', boot2.runOnly === false, JSON.stringify(boot2));
  ok('登录后 → 编辑器代码加载了（工具条/属性面板那套）', boot2.editorCodeLoaded === true);

  // 登录后才能存工程（要管理员）→ 存了再读回，一条链都走长连接
  const round = await page.evaluate(async () => {
    const { backend } = await import('/js/api/backend.js');
    const data = { meta: { name: 'ws-only 工程' }, pages: [{ id: 'p1', type: 'page', widgets: [] }] };
    await backend.saveProject(data);
    const back = await backend.loadProject();
    return { name: back && back.meta && back.meta.name, pages: (back && back.pages || []).length };
  });
  ok('经长连接存工程 + 读回（往返一致）',
    round.name === 'ws-only 工程' && round.pages === 1, JSON.stringify(round));

  const api2 = apiHits();
  ok('登录 + 刷新 + 存读工程这一整轮：仍零 /api/* HTTP', api2.length === 0,
    api2.map(h => h.path).join(',') || '无');

  /* ── 5. 老接口在 HTTP 上确实没了 ── */
  for (const p of ['/api/health', '/api/vars', '/api/project']) {
    const r = await page.evaluate(async (p) => {
      const res = await fetch(p);
      return { status: res.status, body: await res.text() };
    }, p);
    ok(`HTTP ${p} 已删除（404 且说明走长连接）`,
      r.status === 404 && r.body.includes('WebSocket'), `status=${r.status}`);
  }

  ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

const fails = results.filter(r => !r.ok).length;
console.log(`\n==== V2 只走长连接（前端零 HTTP 接口）：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
