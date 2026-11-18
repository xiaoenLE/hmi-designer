// shot-plc-link-mode.mjs — 截图：运行态**左下角的数据源提示**三态 + 断开即停的现场
//
// 出图（存到 docs/）：
//   1. screenshot-plc-link-internal.png  —— 没接设备：`内部变量运行中（未接 PLC） · 内部变量 N 个`
//   2. screenshot-plc-link-online.png    —— 接着模拟 PLC：`PLC 变量传输中（IP:端口）`
//   3. screenshot-plc-link-down.png      —— 设备断开：`PLC 已断开（IP:端口）` + 顶部红条
//
// 自己起隔离后端 + 模拟 PLC，不碰现场数据。用法：node test/shot-plc-link-mode.mjs
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
const DOCS = path.join(ROOT, 'docs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SIM_MB = await freePort();
const SIM_WEB = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-link-'));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(BASE + '/api/health'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
page.on('dialog', d => d.accept());
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, { timeout: 15000 });
await sleep(400);

/* 用内置演示工程（页面和变量表本来就是配套的），只**追加几个地址留空的内部变量** ——
   左下角提示要报「内部变量 N 个」，全是有 PLC 地址的变量就报不出这个数。 */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const d = project.data;
  d.meta.name = '单线切割机（演示）';
  [['本班产量', 'int'], ['累计长度', 'real'], ['当前配方号', 'int'], ['维护计时', 'real']]
    .forEach(([name, type]) => {
      if (project.variables().some(v => v.name === name)) return;
      d.variables.push({ name, type, address: '', value: 0, len: 0 });
    });
  project.commit('截图用工程');
  varStore.resetFrom(project.variables());
});
await sleep(300);

const shot = async (file, label) => {
  const tip = await page.evaluate(() => {
    const el = document.getElementById('rtInternalTip');
    return { text: el?.textContent || '', cls: el?.className || '', show: !!el && el.getClientRects().length > 0 };
  });
  await page.screenshot({ path: path.join(DOCS, file) });
  console.log(`${file}  ${label}\n   左下角：${JSON.stringify(tip)}`);
};

/* ── 1. 内存模拟（没接设备）── */
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.enterRun()));
await sleep(1500);
await shot('screenshot-plc-link-internal.png', '内存模拟：内部变量运行中');

/* ── 2. 接上模拟 PLC ── */
const sim = spawn(PY, ['server/plc_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore' });
let simUp = false;
for (let i = 0; i < 30 && !simUp; i++) {
  await sleep(300);
  try { simUp = (await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`)).ok; } catch { /* 等它起来 */ }
}
await fetch(BASE + '/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab' }),
});
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const st = await page.evaluate(async () => (await import('/js/api/backend.js')).backend.plcLink);
  if (st.mode === 'plc' && st.online) break;
}
await sleep(1200);
await shot('screenshot-plc-link-online.png', '接上模拟 PLC：PLC 变量传输中');

/* ── 3. 拔线：顶部红条 + 左下角转「PLC 已断开」 ── */
sim.kill();
await sleep(3500);
await shot('screenshot-plc-link-down.png', '设备断开：PLC 已断开');

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
console.log('\n三张图已写到 docs/');
