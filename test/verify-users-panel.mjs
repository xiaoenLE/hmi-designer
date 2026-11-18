// verify-users-panel.mjs — 多用户/角色：登录页（账号 + 管理员密码）+ 「工程 ▾ → 用户与角色…」管理面板
//
// 验界面这一层（后端角色闸门/账号存储由 test/verify-users.mjs 负责）：
//   ① 登录页有「账号」格：留空 = 内置管理员密码（老现场），填了 = 账号表
//   ② 密码错 → 显示人话错误、不跳转；管理员密码对 → 进编辑器
//   ③ 用户面板：列表、加账号（操作员/观察员）、改角色、禁用、改密码、删除，全部**真写后端**
//   ④ 列表接口不回密码；角色中文名对
//   ⑤ 操作员账号登录 → 直接去运行画面 /run（不让他进编辑器改配置）
//   ⑥ 全程无未捕获 JS 异常
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
const PW = 'admin123';                       // 全新数据目录 → 后端按默认密码建口令文件

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
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-userspanel-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'],
  {
    cwd: ROOT, stdio: 'ignore',
    env: {
      ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: path.join(DATA, 'logs'),
      HMI_UPDATE_URL: '', HMI_UPDATE_ARCHIVE: '',
    },
  });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const pageErrors = [];

/* ── 1. 登录页：字段 + 错密码 + 管理员密码 ── */
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await installPageShim(page);
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(H + '/login', { waitUntil: 'load' });
const loginUi = await page.evaluate(() => ({
  hasUser: !!document.getElementById('user'),
  hasPw: !!document.getElementById('pw'),
  userPlaceholder: document.getElementById('user')?.placeholder || '',
  title: document.querySelector('h1')?.textContent || '',
}));
ok('登录页有「账号」格（留空 = 管理员密码）和密码格',
  loginUi.hasUser && loginUi.hasPw && /留空/.test(loginUi.userPlaceholder) && /登录/.test(loginUi.title),
  JSON.stringify(loginUi));

await page.fill('#user', '');
await page.fill('#pw', 'wrong-password');
await page.click('#go');
await page.waitForTimeout(700);
const badLogin = await page.evaluate(() => ({
  err: document.getElementById('err')?.textContent || '',
  shown: document.getElementById('err')?.style.display !== 'none',
  stillLogin: location.pathname === '/login',
}));
ok('密码错：显示人话错误、留在登录页', badLogin.shown && badLogin.err.length >= 3 && badLogin.stillLogin,
  JSON.stringify(badLogin));

await page.fill('#user', '');
await page.fill('#pw', PW);
await page.click('#go');
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 15000 });
await page.waitForTimeout(600);
ok('管理员密码登录 → 进编辑器（工程已载入）', true, await page.evaluate(() => location.pathname));

/* ── 2. 用户面板：初始空 → 加两个操作员（现场口径：只留管理员+操作员） ── */
await page.evaluate(async () => {
  const m = await import('/js/editor/usersPanel.js');
  m.openUsersPanel();
});
await page.waitForTimeout(500);
const openUi = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  listText: document.getElementById('usrList')?.textContent || '',
  roleOpts: [...(document.getElementById('usrRole')?.options || [])].map(o => o.textContent),
}));
ok('「用户与角色」对话框打开、初始无账号、角色下拉**只有管理员/操作员**',
  openUi.open && openUi.title === '用户与角色' && /还没有账号/.test(openUi.listText)
  && openUi.roleOpts.length === 2
  && openUi.roleOpts.includes('管理员') && openUi.roleOpts.includes('操作员')
  && !openUi.roleOpts.includes('观察员'),
  JSON.stringify(openUi));

const addUser = async (name, pwd, role) => {
  await page.evaluate(([n, p, r]) => {
    document.getElementById('usrName').value = n;
    document.getElementById('usrPwd').value = p;
    document.getElementById('usrRole').value = r;
  }, [name, pwd, role]);
  await page.click('#usrAdd');
  await page.waitForTimeout(700);
};
await addUser('op1', 'op1234', 'operator');
await addUser('op2', 'op2234', 'operator');

const listAfterAdd = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const r = await backend.rpc('/api/users', { method: 'GET' });
  return { users: r.users, roles: r.roles, roleCn: r.role_cn, msg: document.getElementById('usrMsg')?.textContent || '' };
});
ok('加两个操作员账号 → 后端真有了（角色对；后端 roles 也只有两种）',
  listAfterAdd.users.length === 2
  && listAfterAdd.users.find(u => u.name === 'op1')?.role === 'operator'
  && listAfterAdd.users.find(u => u.name === 'op2')?.role === 'operator'
  && listAfterAdd.roles.length === 2 && !listAfterAdd.roles.includes('viewer'),
  JSON.stringify(listAfterAdd.users));
ok('列表接口不回密码字段', listAfterAdd.users.every(u => !('pwd' in u) && !('password' in u) && !('salt' in u)),
  JSON.stringify(Object.keys(listAfterAdd.users[0] || {})));
const rowCount = await page.evaluate(() => document.querySelectorAll('#usrList .usr-row').length);
ok('面板里两行账号都画出来了', rowCount === 2, String(rowCount));

/* ── 3. 改角色 / 禁用 / 改密码 / 删除（都真写后端） ── */
await page.selectOption('[data-role="op1"]', 'admin');
await page.waitForTimeout(700);
let st = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const r = await backend.rpc('/api/users', { method: 'GET' });
  return { op1: r.users.find(u => u.name === 'op1') };
});
ok('面板改角色 → 后端变了（操作员 → 管理员）', st.op1?.role === 'admin', JSON.stringify(st.op1));
// ⚠ 后端有「最后一个启用中的管理员不许降级」的保护：先用 op2 再顶一个管理员，
//    才能把 op1 改回操作员（否则 op1 是唯一管理员，降级会被正确地拒绝）。
await page.selectOption('[data-role="op2"]', 'admin');
await page.waitForTimeout(700);
await page.selectOption('[data-role="op1"]', 'operator');
await page.waitForTimeout(700);
st = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const r = await backend.rpc('/api/users', { method: 'GET' });
  return { op1: r.users.find(u => u.name === 'op1'), op2: r.users.find(u => u.name === 'op2') };
});
ok('面板改回操作员（另有一个管理员顶着，不被"最后管理员"挡）',
  st.op1?.role === 'operator' && st.op2?.role === 'admin', JSON.stringify(st));

await page.click('[data-enable="op1"]');
await page.waitForTimeout(700);
st = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const r = await backend.rpc('/api/users', { method: 'GET' });
  return {
    op1: r.users.find(u => u.name === 'op1'),
    dis: !!document.querySelector('#usrList .usr-row.dis'),
  };
});
ok('面板禁用账号 → 后端 enabled=false，行变灰', st.op1?.enabled === false && st.dis === true, JSON.stringify(st));

await page.click('[data-pwd="op1"]');
await page.waitForTimeout(200);
const pwdUi = await page.evaluate(() => !!document.getElementById('usrNewPwd'));
ok('点「改密码…」出现新密码格', pwdUi === true);
await page.fill('#usrNewPwd', 'newop99');
await page.click('[data-pwdok="op1"]');
await page.waitForTimeout(800);
const pwdMsg = await page.evaluate(() => document.getElementById('usrMsg')?.textContent || '');
ok('改密码成功提示（人话）', /密码/.test(pwdMsg), pwdMsg);

await page.click('[data-del="op1"]');
await page.waitForTimeout(800);
const delState = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const r = await backend.rpc('/api/users', { method: 'GET' });
  return { names: r.users.map(u => u.name), rows: document.querySelectorAll('#usrList .usr-row').length };
});
ok('删除账号 → 后端和面板都没了', !delState.names.includes('op1') && delState.rows === 1, JSON.stringify(delState));

// 后端不再接受「观察员」：直接调接口传 viewer 应被拒（界面下拉已没有它）
const viewerRejected = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  try {
    await backend.rpc('/api/users', { body: { action: 'add', user: 'oldview', password: 'vw1234', role: 'viewer' } });
    return { ok: false, err: '' };
  } catch (e) {
    return { ok: true, err: String((e && e.message) || e) };
  }
});
ok('新建账号不再接受「观察员」角色（后端 400）', viewerRejected.ok && /角色|viewer|观察员/.test(viewerRejected.err),
  JSON.stringify(viewerRejected));

/* ── 4. 操作员账号登录 → 直接去运行画面 /run ──
   ⚠ 前面把 op1 禁用了 —— 另建一个干净的操作员账号来验登录跳转。 */
await addUser('op3', 'op3222', 'operator');
const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page2 = await ctx2.newPage();
await installPageShim(page2);
page2.on('pageerror', e => pageErrors.push(String(e)));
await page2.goto(H + '/login', { waitUntil: 'load' });
await page2.fill('#user', 'op3');
await page2.fill('#pw', 'op3222');
await page2.click('#go');
await page2.waitForTimeout(2500);
const opNav = await page2.evaluate(() => ({ path: location.pathname, hasRun: !!document.getElementById('runtimeRoot') }));
ok('操作员登录 → 直接进运行画面（不进编辑器）', opNav.path === '/run' || opNav.hasRun, JSON.stringify(opNav));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 多用户/角色界面回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
