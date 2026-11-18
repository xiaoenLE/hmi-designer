// _t_editreturn.mjs — 复现「运行页 → 编辑器」这条链路：Ctrl+Shift+E → 登录页 → 编辑器
// 用法：node test/_t_editreturn.mjs
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
const ROOT = path.resolve(import.meta.dirname, '..');
const PW = 'admin123';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const out = [];
const ok = (n, c, e = '') => { out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`); if (!c) process.exitCode = 1; };

const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-editret-'));
// ⚠ **开登录闸门**（不带 --no-auth）：就是要复现"现场机没登录 → 要密码 → 进编辑器"
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA },
});
const H = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(H + '/')).ok) break; } catch { /* 等 */ } await sleep(300); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', e => logs.push('pageerror: ' + String(e)));

const where = () => page.evaluate(() => ({
  path: location.pathname,
  runOnly: window.app?.runOnly,
  hasToolbar: !!document.getElementById('toolbar')?.getClientRects().length,
  hasPw: !!document.querySelector('input[type=password]'),
  token: !!localStorage.getItem('hmi-ws-token'),
}));

/* ① 客户机（干净的浏览器）打开 / —— 应该是运行页 */
await page.goto(H + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 15000 });
await sleep(800);
const s1 = await where();
ok('客户机打开 / → 运行页（不用登录）', s1.runOnly === true && !s1.hasToolbar, JSON.stringify(s1));

/* ①b 客户机在 / 上按 Esc：**不许退出**（现场要求：退了只剩白屏） */
await page.keyboard.press('Escape');
await sleep(600);
const sEsc = await page.evaluate(() => ({
  running: !!(window.app?.project?.data), rtVisible: getComputedStyle(document.getElementById('runtimeRoot')).display,
  widgets: document.querySelectorAll('#rtPage .wd').length,
}));
ok('客户机在 / 上按 Esc 退不出去（画面还在）',
  sEsc.rtVisible !== 'none' && sEsc.widgets > 0, JSON.stringify(sEsc));

/* ①c 客户机在 / 上按 Ctrl+Shift+V：要管理员密码，不是直接就开 */
await page.keyboard.press('Control+Shift+V');
await sleep(900);
const sV = await page.evaluate(() => ({
  dlg: !document.getElementById('dlgMask')?.classList.contains('hidden'),
  title: document.getElementById('dlgTitle')?.textContent || '',
  panelHidden: document.getElementById('rtVarsPanel')?.classList.contains('rt-hidden'),
}));
ok('客户机在 / 上按 Ctrl+Shift+V → 先要密码（不直接开变量监控）',
  sV.dlg === true && /管理员/.test(sV.title || '') && sV.panelHidden === true, JSON.stringify(sV));
await page.keyboard.press('Escape');
await sleep(400);

/* ② 按 Ctrl+Shift+E —— 没登录，应该落到 /login */
await page.keyboard.press('Control+Shift+E');
await sleep(1500);
const s2 = await where();
ok('Ctrl+Shift+E（没登录）→ 落到登录页', s2.path === '/login' && s2.hasPw, JSON.stringify(s2));
console.log('  ↳ 按完 Ctrl+Shift+E 之后：', JSON.stringify(s2));
console.log('  ↳ 会话查询结果：', JSON.stringify(await page.evaluate(async () => {
  try { const m = await import('/js/api/backend.js'); return await m.backend.session(); } catch (e) { return { err: String(e && e.message || e) }; }
})));

/* ③ 登录页输密码 —— 应该回到 /，而且这回是**编辑器** */
if (s2.path !== '/login') {
  console.log('  ⚠ 没到登录页，后面的登录步骤跳过（先看上面为什么没跳）');
} else {
  await page.fill('#pw', PW);
  await page.click('button[type=submit]', { noWaitAfter: true }).catch(async () => {
    await page.evaluate(() => document.getElementById('f')?.requestSubmit?.());
  });
  await sleep(2500);
  const s3 = await where();
  ok('登录后 → 同一个 / 给的是编辑器（工具条出来了）',
    s3.path === '/' && s3.runOnly === false && s3.hasToolbar, JSON.stringify(s3));
  ok('登录后 token 存下来了（刷新还能接上）', s3.token === true, String(s3.token));
}

/* ④ 编辑器 → 去运行画面（/run）→ 再 Ctrl+Shift+E 回编辑器 */
await page.goto(H + '/run', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 15000 });
await sleep(800);
const s4 = await where();
ok('/run 是运行页', s4.runOnly === true, JSON.stringify(s4));
await page.keyboard.press('Control+Shift+E');
await sleep(2000);
const s5 = await where();
ok('运行页上再按 Ctrl+Shift+E（已登录）→ 回到编辑器',
  s5.runOnly === false && s5.hasToolbar, JSON.stringify(s5));

/* ⑤ 刷新一次：登录态应该还在，/ 直接给编辑器 */
await page.goto(H + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 15000 });
await sleep(900);
const s6 = await where();
ok('刷新 / 仍是编辑器（会话没丢）', s6.runOnly === false && s6.hasToolbar, JSON.stringify(s6));

console.log(out.join('\n'));
console.log('\n页面控制台：' + (logs.slice(-6).join(' | ') || '（无 warn/error）'));
console.log(`\n${out.filter(x => x.startsWith('PASS')).length}/${out.length} 通过`);
await browser.close();
srv.kill();
await sleep(300);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(process.exitCode || 0);
