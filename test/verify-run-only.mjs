// verify-run-only.mjs — 现场部署的页面分工：**地址默认就是运行页**，改配置要登录
//   ① 管理员登录 /login → 登录后**同一个 / 就是编辑器**，组态并「存到服务器」（运行页读的就是这一份）
//   ② 客户机（没有 cookie）：GET / **直接就是运行画面**（不用登录、画出服务器上的工程）；
//      GET /run 永远给运行页；/edit 是老地址 → 302 跳回 /（登录了才看得到编辑器）
//   ③ 运行页上：没有工具条/工作区/右键菜单；Esc 退不出去；开机**不自动弹快捷键提示条**；
//      Ctrl+Shift+L **直接**弹 PLC 连接设置（2.1.4 起不再要管理员密码）；Ctrl+Shift+F 切视图照常
//   ④ 接口闸门：改**工程/账号/恢复初值**没登录一律 401；**设备连接（PLC/OPC UA）不设闸门** ——
//      现场运行页按 Ctrl+Shift+L 就能改，口令也随配置一起给（否则改个 IP 就把口令清掉了）；
//      **「立即更新」（/api/update/apply）也不设闸门**（2.1.6）：运行画面右下角徽标一点就更新；
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
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
import { wsHealth } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const out = [];
const ok = (n, c, e = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-runonly-'));
const PW = 'admin123';                    // 全新数据目录 → 后端按默认密码建口令文件

/** 起一个后端（重启那一段要复用：同一个端口 + 同一个数据目录） */
const startBackend = async (port) => {
  /* HMI_UPDATE_ARCHIVE='' → 这个后端的「立即更新」是关着的：套件只验证它**不被权限挡**，
     不能真去 Gitea 下代码包覆盖本机这份源码（见第 4 段的 /api/update/apply 断言）。 */
  const p = spawn(PY, ['server/server.py', '--port', String(port), '--no-browser'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_UPDATE_ARCHIVE: '' } });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { await fetch(`http://127.0.0.1:${port}/`); return p; } catch { /* 等 */ }
  }
  return p;
};
const srv = await startBackend(PORT);
let up = false;
try { await wsHealth(PORT); up = true; } catch { /* 没起来 */ }
if (!up) { console.log('FAIL  后端没起来'); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } });   // 客户机（没有任何 cookie）
const admin = await browser.newContext({ viewport: { width: 1280, height: 800 } });   // 管理员
/* ★ 页面里的 `/api/*` fetch 要改道到长连接 —— **两个 context 都要装**：
   本套件有两个页面（客户机 gPage、管理员 aPage），只装一个的话，另一个页面里
   `fetch('/api/session')` 会真的发 HTTP，拿到的是"V2 起后端没有 HTTP 接口了"那条 404 JSON，
   断言就变成 undefined 而不是 false（这种"看着像业务不对、其实是通道不对"最难查）。
   装在 context 上，之后这个 context 里新建的页面（含持久 profile 那个）一起生效。 */
await installPageShim(guest);
await installPageShim(admin);
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
const health = await wsHealth(PORT);
ok('健康检查里带 auth 信息（前端据此判断要不要登录）',
  health.auth?.enabled === true && health.auth?.logged_in === false,
  JSON.stringify(health.auth));

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
ok('运行页默认不弹右键菜单', runPage.ctxMenu === false);

// 客户机想摸编辑器：/edit 老地址跳回 /，而没登录的 / 是运行页
await gPage.goto(H + '/edit', { waitUntil: 'domcontentloaded' });
await sleep(300);
const guestEdit = await gPage.evaluate(() => ({
  path: location.pathname, hasPw: !!document.querySelector('input[type=password]'),
  runOnly: !!window.app?.runOnly,
}));
ok('客户机打开 /edit → 跳回 /，拿到的还是运行页（拿不到编辑器）',
  guestEdit.path === '/' && guestEdit.runOnly === true, JSON.stringify(guestEdit));

/* ══════ 2b. ★ **现场真正的地址是 `/`，不是 /run** ══════
   `/` 是"通用外壳"：「这是运行页」这个身份是页面自己连上长连接问完 session 才定的
   （后端发页面时不知道你登录没登录）—— 所以这一族判断必须在 `/` 上单独验一遍。
   以前 runtime.js 把它读成**模块加载时的常量**，于是 `/` 上全是反的：
     · 按 Esc → 退出运行画面（客户看到一片白）
     · 按 Ctrl+Shift+V → 连管理员密码都不问，直接开变量监控
     · 按 Ctrl+Shift+E → 按了没反应（进不去编辑器）
   而套件当年一律按 `/run` 测（那是后端**注入过标记**的地址，正好是对的）→ 全绿却漏了。
   改完（runtime.js 的 isRunOnlyNow）之后这三条在 `/` 上也对了，这里把它钉住。 */
await gPage.goto(H + '/', { waitUntil: 'domcontentloaded' });
await gPage.waitForFunction(() => window.app?.project?.data, null, { timeout: 15000 });
await sleep(500);
ok('/（现场地址）也是运行页（body.run-only + app.runOnly）',
  await gPage.evaluate(() => document.body.classList.contains('run-only') && window.app.runOnly === true));
/* 2.1.4：客户机/AI 窗口开机直接进运行态 —— 那条"快捷键提示"不再自动飘出来（现场嫌挡画面），
   要看就在编辑器里进运行态或右键菜单「快捷键提示」手动调 */
const bootHint = await gPage.evaluate(() => {
  const el = document.getElementById('rtHint');
  return { exists: !!el, hidden: !el || el.classList.contains('hidden'), text: el ? el.textContent : '' };
});
ok('★ 开机进运行态不自动弹快捷键提示条（rtHint 收着）',
  bootHint.exists === true && bootHint.hidden === true, JSON.stringify(bootHint));
await gPage.keyboard.press('Escape');
await sleep(400);
const rootEsc = await gPage.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  return { running: m.isRunning(), visible: getComputedStyle(document.getElementById('runtimeRoot')).display !== 'none',
    widgets: document.querySelectorAll('#rtPage .wd').length };
});
ok('★ / 上按 Esc 也退不出去（退了只剩白屏）',
  rootEsc.running === true && rootEsc.visible === true && rootEsc.widgets > 0, JSON.stringify(rootEsc));
await gPage.keyboard.press('Control+Shift+V');
await sleep(800);
const rootV = await gPage.evaluate(async () => ({
  dlg: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  varsVisible: (await import('/js/runtime/runtime.js')).isVarsVisible(),
}));
ok('★ / 上按 Ctrl+Shift+V 也要管理员密码（客户机上不能直接看变量监控）',
  rootV.dlg === true && /管理员验证/.test(rootV.title) && rootV.varsVisible === false, JSON.stringify(rootV));
await gPage.evaluate(() => document.getElementById('dlgCancel').click());
await sleep(400);
await gPage.keyboard.press('Control+Shift+E');
await sleep(1200);
const rootE = await gPage.evaluate(() => ({
  path: location.pathname, hasPw: !!document.querySelector('input[type=password]'),
}));
ok('★ / 上按 Ctrl+Shift+E（没登录）→ 落到 /login',
  rootE.path === '/login' && rootE.hasPw === true, JSON.stringify(rootE));

await openRun(gPage);                  // 回运行页继续
await sleep(300);

/* ══════ 3. 客户页面上：退不出去、看变量监控要密码、切视图照常 ══════ */
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

// 输入框获得焦点时，Ctrl+Shift+E 仍是编辑器快捷键。
await gPage.evaluate(() => {
  const input = document.createElement('input');
  document.getElementById('rtPage').append(input);
  input.focus();
});
await gPage.keyboard.press('Control+Shift+E');
await sleep(900);
const afterE = await gPage.evaluate(() => ({
  path: location.pathname, hasPw: !!document.querySelector('input[type=password]'),
}));
ok('输入框有焦点时 Ctrl+Shift+E 仍能进入管理员登录页',
  afterE.path === '/login' && afterE.hasPw === true, JSON.stringify(afterE));
await openRun(gPage);
await gPage.keyboard.press('F8');
await gPage.waitForURL(u => u.pathname === '/login');
ok('运行页的备用键 F8 可进入管理员登录页', await gPage.locator('#pw').isVisible());
await openRun(gPage);
await gPage.locator('#rtPage').dispatchEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 160 });
await gPage.getByRole('menuitem', { name: /进入编辑器/ }).click();
await gPage.waitForURL(u => u.pathname === '/login');
ok('运行页右键菜单可进入管理员登录页', await gPage.locator('#pw').isVisible());
await gPage.goto(H + '/?edit=1', { waitUntil: 'domcontentloaded' });
await gPage.waitForURL(u => u.pathname === '/login');
ok('进入编辑器时会话无效，重新打开登录页', await gPage.locator('#pw').isVisible());
await openRun(gPage);
await sleep(300);

/* ══════ 4. 接口闸门：改配置要登录，写变量值不拦 ══════ */
const guestProjectPost = await api('/api/project', { method: 'POST', body: JSON.stringify({ data: { pages: [] } }) });
ok('没登录：存工程 POST /api/project 被挡（401 + need_login）',
  guestProjectPost.status === 401 && guestProjectPost.json?.need_login === true, JSON.stringify(guestProjectPost));
ok('没登录：改 PLC 连接 POST /api/plc **放行**（现场 Ctrl+Shift+L 直接改连接）',
  (await api('/api/plc', { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) })).status === 200);
/* OPC UA 浏览/导入跟"改设备连接"是同一类：现场也得能改。没装 asyncua 时后端给 400（配置问题），
   但绝不会是 401（权限问题）—— 这里断言的是"不再被权限挡住" */
const guestUaBrowse = await api('/api/opcua/browse', { method: 'POST', body: JSON.stringify({}) });
ok('没登录：OPC UA 浏览/导入不再被权限挡（不是 401、不带 need_login）',
  guestUaBrowse.status !== 401 && guestUaBrowse.json?.need_login !== true, JSON.stringify(guestUaBrowse.status));
ok('没登录：内部变量恢复初值被挡',
  (await api('/api/vars/reset', { method: 'POST', body: JSON.stringify({}) })).status === 401);
ok('没登录：下发变量表/采集范围照旧放行（运行页面每次进运行态都要用）',
  (await api('/api/vars/declare', { method: 'POST', body: JSON.stringify({ variables: [] }) })).status === 200);
const guestRead = await api('/api/project');
ok('没登录：读工程 GET /api/project 放行（运行画面要拿它来画）',
  guestRead.status === 200 && !!guestRead.json?.data, String(guestRead.status));
/* 设备连接不设闸门 → 口令也一并给：对话框里"口令留空再点确定"等于清空口令，
   所以客户机必须把上次配好的口令带回来，否则改个 IP 就把口令抹了 */
const guestPlcCfg = await api('/api/plc');
ok('没登录：GET /api/plc 也带口令（现场改连接要看到上次填的）',
  Object.prototype.hasOwnProperty.call(guestPlcCfg.json?.config || {}, 'password'),
  JSON.stringify(Object.keys(guestPlcCfg.json?.config || {})));
/* 「立即更新」不设闸门（2.1.6 现场口径）：运行画面右下角的版本徽标，现场随手点一下就能更新。
   后端在这个套件里被 HMI_UPDATE_ARCHIVE='' 关成了"更新已关闭"，所以这里只断言**不是 401/need_login**
   （以前它是 ADMIN_PATHS 里的，客户机点了会弹"管理员登录"，更新根本没开始）。 */
const guestUpd = await api('/api/update/apply', { method: 'POST', body: JSON.stringify({}) });
ok('没登录：点「立即更新」不被权限挡（不是 401、不带 need_login）',
  guestUpd.status !== 401 && guestUpd.json?.need_login !== true,
  JSON.stringify({ status: guestUpd.status, error: guestUpd.json?.error }).slice(0, 160));

// 现场按钮写变量：HMI 的本职动作，必须开放，而且运行页面要能实时收到
const guestWrite = await api('/api/vars', { method: 'POST', body: JSON.stringify({ name: 'bRunCmd', value: true }) });
await sleep(700);
const liveVal = await gPage.evaluate(() => window.app.varStore.get('bRunCmd'));
ok('没登录也能写变量值（现场按钮/输入框就靠它），运行页面实时收到',
  guestWrite.status === 200 && liveVal === true, JSON.stringify({ status: guestWrite.status, liveVal }));

/* ══════ 4b. 现场也要能改 PLC 连接：Ctrl+Shift+L **直接**弹对话框（2.1.4 起不要密码）══════ */
await gPage.keyboard.press('Control+Shift+L');
await sleep(900);
const directDlg = await gPage.evaluate(() => ({
  title: document.getElementById('dlgTitle').textContent,
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  hasPw: !!document.getElementById('rtAdminPw'),
  hasEndpoint: !!document.getElementById('plcEndpoint'),
  hasProtocol: !!document.getElementById('plcProto'),
}));
ok('Ctrl+Shift+L 直接弹 PLC 连接设置（不先弹「管理员验证」、不要密码）',
  directDlg.open === true && /PLC 连接/.test(directDlg.title) && directDlg.hasPw === false
  && directDlg.hasEndpoint && directDlg.hasProtocol, JSON.stringify(directDlg));

/* 弹框不该顺带把页面登录成管理员：现场"能改连接"和"能进组态"是两回事（进编辑器仍要去 /login） */
const stillGuest = await gPage.evaluate(async () => (await (await fetch('/api/session')).json()));
ok('弹框没顺带把页面登录成管理员（仍是未登录态）', stillGuest.logged_in === false, JSON.stringify(stillGuest));

// 未登录也真的能提交：这就是"运行模式里直接改连接信息"
const plcNow = await gPage.evaluate(async () => {
  const r = await fetch('/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'disconnect' }) });
  return { status: r.status, body: await r.json().catch(() => null) };
});
ok('运行页里（未登录）改连接信息提交成功（200，不再 401）', plcNow.status === 200, JSON.stringify(plcNow));
// 把连接对话框关掉，别影响后面的检查
await gPage.evaluate(() => document.getElementById('dlgCancel').click());
await sleep(400);

/* 后面的检查（进编辑器 / 重启后还登录）需要登录态：走跟 /login 页面同一条后端登录（不是 Ctrl+Shift+L 带来的） */
await gPage.evaluate(async (pw) => {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }) });
  return r.json();
}, PW);
await sleep(800);
// ⚠ 要问**运行页面自己那份 cookie**（Node 侧那个是另一次登录，看不出页面登录没登录）
const afterLogin = await gPage.evaluate(async () => (await (await fetch('/api/session')).json()));
ok('登录之后这台浏览器就是登录态（12 小时不用再输）', afterLogin.logged_in === true,
  JSON.stringify(afterLogin));

// 模拟 PLC 请求占用主连接：切换不应等待这条连接上的会话请求。
await gPage.evaluate(() => { window.app.backend.session = () => new Promise(() => {}); });
await gPage.keyboard.press('Control+Shift+E');
await sleep(1400);
const intoEditor = await gPage.evaluate(() => ({
  path: location.pathname,
  editor: !document.body.classList.contains('run-only') && !!document.getElementById('workspace')?.offsetParent,
}));
ok('管理员按 Ctrl+Shift+E 可立即切换，无需等待旧页面的会话请求',
  intoEditor.path === '/' && intoEditor.editor === true, JSON.stringify(intoEditor));
await gPage.evaluate(() => window.app.enterRun());
await gPage.evaluate(() => {
  const input = document.createElement('input');
  document.getElementById('rtPage').append(input);
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', {
    code: 'KeyE', key: 'Process', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
});
ok('编辑器预览在输入法持有焦点时识别 Ctrl+Shift+E 并返回编辑',
  await gPage.locator('#runtimeRoot').isHidden());

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
ok('编辑器「工程 ▾」里有「打开运行画面」和「退出登录」（登录闸门开着时才出现）',
  projItems.some(x => x.includes('打开运行画面')) && projItems.some(x => x.includes('退出登录')),
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
await installPageShim(pctx);            // 这个 profile 里开的页面也要走改道
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
/* ⚠ `//` 归一后给的就是 `/` —— 而 2.0 的 `/` 是**通用外壳**：进运行页还是编辑器
   由页面连上长连接问一句 session 再定（见 server/core/handler.py 的 _serve_shell）。
   所以这里跟 `/` 逐字节比：一样就说明"多打一个斜杠照样进得去"（行为等价），
   另外再用浏览器确认它落到的确实是运行页。 */
const rootRes = await fetch(H + '/', { redirect: 'manual' });
const rootHtml = await rootRes.text();
const dbl = await fetch(H + '//', { redirect: 'manual' });
const dblHtml = await dbl.text();
ok('地址多打一个斜杠 // 归一成 /（同一份外壳）',
  dbl.status === 200 && dblHtml === rootHtml, `status=${dbl.status} 与 / 相同=${dblHtml === rootHtml}`);
const dblCtx = await browser.newContext({ viewport: { width: 900, height: 600 } });
await installPageShim(dblCtx);
const dblPage = await dblCtx.newPage();
await dblPage.goto(H + '//', { waitUntil: 'domcontentloaded' });
await dblPage.waitForFunction(() => window.app?.project?.data, null, { timeout: 15000 });
await sleep(500);
ok('客户机打开 // 落到的就是运行页（不是编辑器）',
  await dblPage.evaluate(() => window.app?.runOnly === true && document.body.classList.contains('run-only')),
  await dblPage.evaluate(() => String(location.pathname)));
await dblPage.context().close();
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
