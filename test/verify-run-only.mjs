// verify-run-only.mjs — 现场部署的页面分工：**地址默认就是运行页**，改配置要登录
//   ① 管理员登录 /login → 登录后**同一个 / 就是编辑器**，组态并「存到服务器」（运行页读的就是这一份）
//   ② 客户机（没有 cookie）：GET / **直接就是运行画面**（不用登录、画出服务器上的工程）；
//      GET /run 永远给运行页；/edit 是老地址 → 302 跳回 /（登录了才看得到编辑器）
//   ③ 运行页上：没有工具条/工作区/右键菜单；Esc 退不出去；Ctrl+Shift+L 要管理员密码；Ctrl+Shift+F 切视图照常
//   ④ 接口闸门：改配置的（存工程 / 连 PLC / OPC UA 导入 / 恢复初值）没登录一律 401；
//      HMI 本身的动作（写变量值、下发采集范围、读工程）照旧开放 —— 现场的按钮就是靠它
//   ⑤ Ctrl+Shift+E：没登录 → /login；登录过 → 同一个 / 给出编辑器（**地址不拆开**）
//   ⑥ 记住登录：重启后端、关掉浏览器再开都还是登录态（会话落盘 + 持久 cookie）
//   ⑦ 退出登录 → 回到运行页 /；//、/run/ 也都能进
// 用法：node test/verify-run-only.mjs（自己拉起一个**带登录闸门**的后端 + 临时数据目录，跟批量端口无关）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const out = [];
const ok = (n, c, e = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-runonly-'));
const PW = 'admin123';                    // 全新数据目录 → 后端按默认密码建口令文件

/** 起一个后端（重启那一段要复用：同一个端口 + 同一个数据目录） */
const startBackend = async (port) => {
  const p = spawn(PY, ['server/server.py', '--port', String(port), '--no-browser'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { await fetch(`http://127.0.0.1:${port}/api/health`); return p; } catch { /* 等 */ }
  }
  return p;
};
const srv = await startBackend(PORT);
let up = false;
try { await fetch(H + '/api/health'); up = true; } catch { /* 没起来 */ }
if (!up) { console.log('FAIL  后端没起来'); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } });   // 客户机（没有任何 cookie）
const admin = await browser.newContext({ viewport: { width: 1280, height: 800 } });   // 管理员
const gPage = await guest.newPage();
const aPage = await admin.newPage();
const gErrs = []; gPage.on('pageerror', e => gErrs.push(String(e)));
const aErrs = []; aPage.on('pageerror', e => aErrs.push(String(e)));
for (const p of [gPage, aPage]) p.on('dialog', d => d.accept());

const api = async (url, opt = {}) => {
  const r = await fetch(H + url, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
};
const loginCookie = async () => {
  const r = await fetch(H + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
};
const asAdmin = (cookie) => async (url, opt = {}) => {
  const r = await fetch(H + url, { ...opt, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opt.headers || {}) } });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
};
/** 运行页一直挂着 SSE 长连接，networkidle 永远不满足 → 用 domcontentloaded + 等控件画出来。
 *  ⚠ 用 /run（**永远**给运行页）：单地址模式下登录以后 / 会变成编辑器，
 *    而这个套件里有几步是在"已经登录"的状态下回运行页的。 */
const openRun = async (p, reload = false) => {
  if (reload) await p.reload({ waitUntil: 'domcontentloaded' });
  else await p.goto(H + '/run', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelectorAll('#rtPage .wd').length > 0, null, { timeout: 15000 });
};
const vis = (sel) => `(() => { const el = document.querySelector('${sel}'); if (!el) return 'missing';
  const r = el.getBoundingClientRect();
  return (el.getClientRects().length > 0 && r.width > 0 && r.height > 0) ? 'shown' : 'hidden'; })()`;

/* ══════ 1. 管理员：登录 → 编辑器 → 把演示工程存到服务器 ══════ */
const health = await api('/api/health');
ok('健康检查里带 auth 信息（前端据此判断要不要登录）',
  health.json?.auth?.enabled === true && health.json?.auth?.logged_in === false,
  JSON.stringify(health.json?.auth));

await aPage.goto(H + '/login', { waitUntil: 'domcontentloaded' });
ok('登录页有密码框，也有「回到运行画面」的出口（指向运行页 /）',
  await aPage.evaluate(() => !!document.querySelector('input[type=password]') && !!document.querySelector('a[href="/"]')));

await aPage.fill('#pw', 'wrong-password');
await aPage.click('button[type=submit]', { noWaitAfter: true });
await sleep(1200);
const badLogin = await aPage.evaluate(() => ({ path: location.pathname, err: document.querySelector('.err')?.textContent || '' }));
ok('密码不对 → 留在登录页并给出提示', badLogin.path === '/login' && /密码不对/.test(badLogin.err), JSON.stringify(badLogin));

await aPage.fill('#pw', PW);
await aPage.click('button[type=submit]', { noWaitAfter: true });
await aPage.waitForURL(u => u.pathname === '/', { timeout: 8000 });   // 登录后同一个 / 就是编辑器
await aPage.waitForFunction(() => window.app?.project?.data);
await sleep(600);
const editor = await aPage.evaluate((v) => ({
  runOnly: !!window.app?.runOnly, toolbar: eval(v), workspace: eval(v.replace('#toolbar', '#workspace')),
  hasCanvas: !!document.getElementById('canvas'),
}), vis('#toolbar'));
ok('登录成功后同一个 / 给的就是编辑器（工具条/工作区都在，不是运行页）',
  editor.runOnly === false && editor.toolbar === 'shown' && editor.workspace === 'shown' && editor.hasCanvas,
  JSON.stringify(editor));
ok('登录后 /api/session 报 logged_in=true',
  (await api('/api/session', { headers: { Cookie: await loginCookie() } })).json?.logged_in === true);

// 管理员把演示工程「存到服务器」——这正是运行页会读到的那一份
const seed = await aPage.evaluate(() => window.app.project.data);
const cookie = await loginCookie();
const adm = asAdmin(cookie);
const saveRes = await adm('/api/project', { method: 'POST', body: JSON.stringify({ data: seed }) });
ok('登录后：存工程 POST /api/project 放行', saveRes.status === 200, JSON.stringify(saveRes.json));
ok('登录后：改 PLC 连接放行',
  (await adm('/api/plc', { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) })).status === 200);

/* ══════ 2. 客户机：打开地址**默认就是运行页**，编辑器进不去 ══════ */
await gPage.goto(H + '/', { waitUntil: 'domcontentloaded' });        // 就是根地址
await gPage.waitForFunction(() => document.querySelectorAll('#rtPage .wd').length > 0, null, { timeout: 15000 });
await sleep(400);
const guestAtRoot = await gPage.evaluate(() => ({
  path: location.pathname, hasPw: !!document.querySelector('input[type=password]'),
  runOnly: !!window.app?.runOnly, editorPath: window.__HMI_EDITOR_PATH__,
  isEditor: !document.body.classList.contains('run-only') && !!document.getElementById('toolbar')?.offsetParent,
}));
ok('客户机打开根地址 / → **直接是运行页**（不用登录、不是登录页、不是编辑器）',
  guestAtRoot.path === '/' && guestAtRoot.runOnly === true && guestAtRoot.hasPw === false
  && guestAtRoot.isEditor === false,
  JSON.stringify(guestAtRoot));
ok('运行页里带上了编辑页地址（Ctrl+Shift+E 要跳的地方）',
  guestAtRoot.editorPath === '/', String(guestAtRoot.editorPath));

const runPage = await gPage.evaluate((vs) => ({
  runOnly: window.app?.runOnly === true,
  bodyClass: document.body.classList.contains('run-only'),
  toolbar: eval(vs), workspace: eval(vs.replace('#toolbar', '#workspace')),
  runtime: eval(vs.replace('#toolbar', '#runtimeRoot')),
  widgets: document.querySelectorAll('#rtPage .wd').length,
  ctxMenu: !!document.getElementById('ctxMenu')?.innerHTML,
}), vis('#toolbar'));
ok('根地址就是「只读运行页」（body.run-only）',
  runPage.runOnly && runPage.bodyClass, JSON.stringify({ runOnly: runPage.runOnly, bodyClass: runPage.bodyClass }));
ok('运行页没有编辑器界面（工具条/工作区都不显示）',
  runPage.toolbar === 'hidden' && runPage.workspace === 'hidden', JSON.stringify([runPage.toolbar, runPage.workspace]));
ok('运行页直接进运行态并画出服务器上的工程',
  runPage.runtime === 'shown' && runPage.widgets > 0, JSON.stringify({ runtime: runPage.runtime, widgets: runPage.widgets }));
ok('运行页不建右键菜单（客户摸不到编辑器入口）', runPage.ctxMenu === false);

// 客户机想摸编辑器：/edit 老地址跳回 /，而没登录的 / 是运行页
await gPage.goto(H + '/edit', { waitUntil: 'domcontentloaded' });
await sleep(300);
const guestEdit = await gPage.evaluate(() => ({
  path: location.pathname, hasPw: !!document.querySelector('input[type=password]'),
  runOnly: !!window.app?.runOnly,
}));
ok('客户机打开 /edit → 跳回 /，拿到的还是运行页（拿不到编辑器）',
  guestEdit.path === '/' && guestEdit.runOnly === true, JSON.stringify(guestEdit));
await openRun(gPage);                  // 回运行页继续
await sleep(300);

/* ══════ 3. 客户页面上：退不出去、改配置要密码、切视图照常 ══════ */
await gPage.keyboard.press('Escape');
await sleep(300);
const afterEsc = await gPage.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  return { running: m.isRunning(), visible: getComputedStyle(document.getElementById('runtimeRoot')).display !== 'none' };
});
ok('客户页面按 Esc 退不出去（没有编辑器可回，退了就是白屏）',
  afterEsc.running === true && afterEsc.visible === true, JSON.stringify(afterEsc));

// Ctrl+Shift+V（变量监控）：弹管理员验证，取消后什么都不开
await gPage.keyboard.press('Control+Shift+V');
await sleep(600);
const adminDlg = await gPage.evaluate(() => {
  const mask = document.getElementById('dlgMask');
  return { open: !mask.classList.contains('hidden'), title: document.getElementById('dlgTitle').textContent,
    overRt: mask.classList.contains('over-runtime'), hasPw: !!document.getElementById('rtAdminPw') };
});
ok('客户页面按 Ctrl+Shift+V → 弹「管理员验证」框（压在运行画面上面）',
  adminDlg.open === true && /管理员验证/.test(adminDlg.title) && adminDlg.hasPw && adminDlg.overRt,
  JSON.stringify(adminDlg));
await gPage.evaluate(() => document.getElementById('dlgCancel').click());
await sleep(600);
const afterCancel = await gPage.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  return { varsVisible: m.isVarsVisible(), dlg: !document.getElementById('dlgMask').classList.contains('hidden') };
});
ok('验证框取消 → 变量监控不打开（密码没给就不放行）',
  afterCancel.varsVisible === false && afterCancel.dlg === false, JSON.stringify(afterCancel));

const zoomBefore = await gPage.evaluate(async () => (await import('/js/runtime/runtime.js')).getZoomMode());
await gPage.keyboard.press('Control+Shift+F');
await sleep(350);
const zoomAfter = await gPage.evaluate(async () => (await import('/js/runtime/runtime.js')).getZoomMode());
ok('Ctrl+Shift+F 切视图在客户页面上照常能用（不用密码）', zoomAfter !== zoomBefore, `${zoomBefore} → ${zoomAfter}`);

// Ctrl+Shift+E：没登录 → 跳 /login（服务端按登录状态决定 / 给哪个页面）
await gPage.keyboard.press('Control+Shift+E');
await sleep(900);
const afterE = await gPage.evaluate(() => ({
  path: location.pathname, hasPw: !!document.querySelector('input[type=password]'),
}));
ok('Ctrl+Shift+E 没登录时落到 /login（进去要密码）',
  afterE.path === '/login' && afterE.hasPw === true, JSON.stringify(afterE));
await openRun(gPage);            // 回到运行页继续后面的检查
await sleep(300);

/* ══════ 4. 接口闸门：改配置要登录，写变量值不拦 ══════ */
const guestProjectPost = await api('/api/project', { method: 'POST', body: JSON.stringify({ data: { pages: [] } }) });
ok('没登录：存工程 POST /api/project 被挡（401 + need_login）',
  guestProjectPost.status === 401 && guestProjectPost.json?.need_login === true, JSON.stringify(guestProjectPost));
ok('没登录：改 PLC 连接 POST /api/plc 被挡',
  (await api('/api/plc', { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) })).status === 401);
ok('没登录：OPC UA 浏览/导入被挡',
  (await api('/api/opcua/browse', { method: 'POST', body: JSON.stringify({}) })).status === 401);
ok('没登录：内部变量恢复初值被挡',
  (await api('/api/vars/reset', { method: 'POST', body: JSON.stringify({}) })).status === 401);
ok('没登录：下发变量表/采集范围照旧放行（运行页面每次进运行态都要用）',
  (await api('/api/vars/declare', { method: 'POST', body: JSON.stringify({ variables: [] }) })).status === 200);
const guestRead = await api('/api/project');
ok('没登录：读工程 GET /api/project 放行（运行画面要拿它来画）',
  guestRead.status === 200 && !!guestRead.json?.data, String(guestRead.status));
// 设备口令只发给登录过的会话（运行页要读状态，但不该顺手把 PLC 密码也送出去）
const guestPlcCfg = await api('/api/plc');
ok('没登录：GET /api/plc 不发设备口令（只说「有没有」，配置对话框那边也一样）',
  guestPlcCfg.json?.config?.password === undefined && guestPlcCfg.json?.config?.has_password !== undefined,
  JSON.stringify({ has_password: guestPlcCfg.json?.config?.has_password, leaked: guestPlcCfg.json?.config?.password }));

// 现场按钮写变量：HMI 的本职动作，必须开放，而且运行页面要能实时收到
const guestWrite = await api('/api/vars', { method: 'POST', body: JSON.stringify({ name: 'bRunCmd', value: true }) });
await sleep(700);
const liveVal = await gPage.evaluate(() => window.app.varStore.get('bRunCmd'));
ok('没登录也能写变量值（现场按钮/输入框就靠它），运行页面实时收到',
  guestWrite.status === 200 && liveVal === true, JSON.stringify({ status: guestWrite.status, liveVal }));

/* ══════ 4b. 现场也要能改 PLC 连接：Ctrl+Shift+L → 密码 → 对话框 → 真能连上 ══════ */
await gPage.keyboard.press('Control+Shift+L');
await sleep(700);
const needPw = await gPage.evaluate(() => ({
  title: document.getElementById('dlgTitle').textContent,
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
}));
ok('Ctrl+Shift+L 先要管理员密码（不是直接甩去登录页）',
  needPw.open === true && /管理员验证/.test(needPw.title), JSON.stringify(needPw));

// 密码错：留在验证框并报错，PLC 对话框不许出现
await gPage.fill('#rtAdminPw', 'definitely-wrong');
await gPage.evaluate(() => document.getElementById('dlgOk').click());
await sleep(1200);
const wrongPw = await gPage.evaluate(() => ({
  title: document.getElementById('dlgTitle').textContent,
  msg: document.getElementById('rtAdminMsg')?.textContent || '',
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
}));
ok('密码错 → 留在验证框并提示，打不开 PLC 设置',
  wrongPw.open === true && /管理员验证/.test(wrongPw.title) && /登录失败/.test(wrongPw.msg), JSON.stringify(wrongPw));
ok('密码错时改连接请求照样被挡（401）',
  (await api('/api/plc', { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) })).status === 401);

// 密码对：验证框关掉 → 真的弹出 PLC 连接设置
await gPage.fill('#rtAdminPw', PW);
await gPage.evaluate(() => document.getElementById('dlgOk').click());
await sleep(1500);
const plcDlg = await gPage.evaluate(() => ({
  title: document.getElementById('dlgTitle').textContent,
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  hasEndpoint: !!document.getElementById('plcEndpoint'),
  hasProtocol: !!document.getElementById('plcProto'),
}));
ok('密码对 → 弹出 PLC 连接设置（能改端点/协议/用户名，现场就能更新连接信息）',
  plcDlg.open === true && /PLC 连接/.test(plcDlg.title) && plcDlg.hasEndpoint && plcDlg.hasProtocol,
  JSON.stringify(plcDlg));

// 登录后的会话：改连接真的放行（这就是"运行模式可以更新连接信息"）
// ⚠ 要问**运行页面自己那份 cookie**（Node 侧那个是另一次登录，看不出页面登录没登录）
const afterLogin = await gPage.evaluate(async () => (await (await fetch('/api/session')).json()));
ok('验证过之后这台浏览器就是登录态（12 小时不用再输）', afterLogin.logged_in === true,
  JSON.stringify(afterLogin));
const plcNow = await gPage.evaluate(async () => {
  const r = await fetch('/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'disconnect' }) });
  return { status: r.status, body: await r.json().catch(() => null) };
});
ok('运行页里改连接信息提交成功（不再是 401）', plcNow.status === 200, JSON.stringify(plcNow));
// 把连接对话框关掉，别影响后面的检查
await gPage.evaluate(() => document.getElementById('dlgCancel').click());
await sleep(400);

// 登录过之后再按 Ctrl+Shift+E：这回同一个 / 给的就是编辑器
await gPage.keyboard.press('Control+Shift+E');
await sleep(1400);
const intoEditor = await gPage.evaluate(() => ({
  path: location.pathname,
  editor: !document.body.classList.contains('run-only') && !!document.getElementById('workspace')?.offsetParent,
}));
ok('已经登录过之后，Ctrl+Shift+E 直接进组态编辑器（不用再输密码）',
  intoEditor.path === '/' && intoEditor.editor === true, JSON.stringify(intoEditor));

/* ══════ 4c. 重启后端也不用重新登录（会话落盘 sessions.json）══════ */
srv.kill();
await sleep(1500);
await startBackend(PORT);
await gPage.goto(H + '/', { waitUntil: 'domcontentloaded' });
await sleep(600);
const afterRestart = await gPage.evaluate(() => ({
  path: location.pathname,
  editor: !!document.getElementById('toolbar')?.getClientRects().length,
  logged_in: null,
}));
afterRestart.logged_in = await gPage.evaluate(async () => (await (await fetch('/api/session')).json()).logged_in);
ok('重启后端后**还是登录态**（会话落盘，不用重新输密码）',
  afterRestart.path === '/' && afterRestart.editor === true && afterRestart.logged_in === true, JSON.stringify(afterRestart));
// 回运行页继续
await openRun(gPage);
await sleep(300);
const seed2 = JSON.parse(JSON.stringify(seed));
seed2.meta = { ...(seed2.meta || {}), name: '现场工程-改过' };
ok('管理员改名后再存一次', (await adm('/api/project', { method: 'POST', body: JSON.stringify({ data: seed2 }) })).status === 200);
await openRun(gPage, true);
await sleep(600);
const afterSave = await gPage.evaluate(() => ({
  title: document.title,
  widgets: document.querySelectorAll('#rtPage .wd').length,
  name: window.app.project.data?.meta?.name || '',
}));
ok('客户刷新运行页就看到刚存上去的那一份（标题也跟工程名走）',
  afterSave.widgets > 0 && afterSave.name === '现场工程-改过' && /现场工程-改过/.test(afterSave.title),
  JSON.stringify(afterSave));

/* ══════ 6. 退出登录 → 回到运行页（这个窗口就只剩运行页了） ══════ */
// 用「工程 ▾ → 退出登录」这条真路子（aPage 已经登录着，cookie 也拿到了）
await aPage.click('#btnProjMenu');
await sleep(350);
const projItems = await aPage.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
  .map(b => b.querySelector('.ctx-label').textContent));
ok('编辑器「工程 ▾」里有「去运行画面」和「退出登录」（登录闸门开着时才出现）',
  projItems.some(x => x.includes('去运行画面')) && projItems.some(x => x.includes('退出登录')),
  JSON.stringify(projItems.slice(-4)));
await aPage.evaluate(() => {
  const b = [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .find(x => x.querySelector('.ctx-label').textContent === '退出登录');
  if (b) b.click();
});
await aPage.waitForURL(u => u.pathname === '/', { timeout: 8000 }).catch(() => {});
await sleep(700);
const afterLogout = await aPage.evaluate(async () => ({
  path: location.pathname,
  runOnly: window.app?.runOnly,
  logged_in: (await (await fetch('/api/session')).json()).logged_in,
}));
ok('退出登录后回到运行页（只剩运行页，要改东西得重新登录）',
  ['/', '/run'].includes(afterLogout.path) && afterLogout.runOnly === true
  && afterLogout.logged_in === false, JSON.stringify(afterLogout));

/* ══════ 7. 浏览器/窗口关了再开也不用重新登录（cookie 带 Max-Age，不是一关就没的会话 cookie）══════ */
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-persist-'));
let pctx = await chromium.launchPersistentContext(UD, { executablePath: EXE, headless: true, viewport: { width: 1100, height: 700 } });
let pp = await pctx.newPage();
await pp.goto(H + '/login', { waitUntil: 'domcontentloaded' });
await pp.fill('#pw', PW);
await pp.click('button[type=submit]', { noWaitAfter: true });
await pp.waitForURL(u => u.pathname === '/', { timeout: 8000 }).catch(() => {});
await sleep(500);
const firstOpen = await pp.evaluate(() => location.pathname);
await pctx.close();                        // 相当于关掉浏览器 / 关掉 pywebview 窗口
await sleep(400);
pctx = await chromium.launchPersistentContext(UD, { executablePath: EXE, headless: true, viewport: { width: 1100, height: 700 } });
pp = await pctx.newPage();
await pp.goto(H + '/', { waitUntil: 'domcontentloaded' });
await sleep(600);
const secondOpen = await pp.evaluate(() => location.pathname);
ok('浏览器/窗口关掉再开：登录态还在，/ 直接进编辑器（不用重新输密码）',
  firstOpen === '/' && secondOpen === '/', JSON.stringify({ first: firstOpen, second: secondOpen }));
await pctx.close();
try { fs.rmSync(UD, { recursive: true, force: true }); } catch { /* 忽略 */ }

/* ══════ 9. 路径归一 ══════ */
const dbl = await fetch(H + '//', { redirect: 'manual' });
ok('地址多打一个斜杠 // 也能进运行页',
  dbl.status === 200 && (await dbl.text()).includes('__HMI_RUN_ONLY__'), String(dbl.status));
const oldRun = await fetch(H + '/run', { redirect: 'manual' });
const oldRunHtml = await oldRun.text();
ok('/run 永远给运行页（登录状态下想看运行画面就走它）',
  oldRun.status === 200 && oldRunHtml.includes('__HMI_RUN_ONLY__'), String(oldRun.status));
ok('/run/ 也一样', (await fetch(H + '/run/', { redirect: 'manual' })).status === 200);
const guestEditRes = await fetch(H + '/edit', { redirect: 'manual' });
ok('老地址 /edit 的响应是 302 → /',
  guestEditRes.status === 302 && (guestEditRes.headers.get('location') || '').endsWith('/'),
  `${guestEditRes.status} → ${guestEditRes.headers.get('location')}`);
await aPage.goto(H + '/', { waitUntil: 'domcontentloaded' });
await sleep(400);
ok('注销之后打开 / 又变回运行页（拿不到编辑器）',
  await aPage.evaluate(() => location.pathname === '/' && window.app?.runOnly === true));

ok('客户页面全程无未捕获 JS 异常', gErrs.length === 0, gErrs.slice(0, 2).join(' | '));
ok('编辑器页面全程无未捕获 JS 异常', aErrs.length === 0, aErrs.slice(0, 2).join(' | '));

const pass = out.filter(l => l.startsWith('PASS')).length;
console.log(out.join('\n'));
console.log(`\n==== 默认进运行页 + 登录才能改组态：${pass}/${out.length} 通过 ====`);
try { await browser.close(); } catch { /* 忽略 */ }
try { srv.kill(); } catch { /* 忽略 */ }
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
