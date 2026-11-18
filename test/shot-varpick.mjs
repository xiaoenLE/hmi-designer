// 看一眼候选表长什么样（截图）；顺带确认长 NodeId 不再挤掉变量名
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-'));
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/api/health'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1500, height: 940 } });
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);

await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  const add = (name, type, address) => m.data.variables.push({ name, type, address, value: 0, len: 0 });
  add('GVL.中1[1]', 'int', 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.中1[1]');
  add('GVL.中1[2]', 'int', 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.中1[2]');
  add('GVL.速度设定', 'real', 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.速度设定');
  add('rSpeedMain', 'real', '%MW100');
  add('bRun', 'bool', '%MX0.0');
  add('iCount', 'int', '%MW20');
  const w = m.addWidget('number', 40, 40);
  m.commit('t');
  window.__wid = w.id;
});
await sleep(300);
await page.click(`#canvas .wd[data-id="${await page.evaluate(() => window.__wid)}"]`);
await sleep(300);
await page.click('#propBody [data-bind="variable"]');
await page.waitForTimeout(250);
const box = await page.evaluate(() => {
  const el = document.querySelector('.vp-list');
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x) - 6, y: Math.round(r.y) - 6, width: Math.round(r.width) + 12, height: Math.round(r.height) + 12 };
});
await page.screenshot({ path: 'shots/varpick-list.png', clip: box });
// 再打几个字（只按变量名过滤）
await page.fill('#propBody [data-bind="variable"]', 'GVL.中');
await page.waitForTimeout(250);
const box2 = await page.evaluate(() => {
  const el = document.querySelector('.vp-list');
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x) - 6, y: Math.round(r.y) - 6, width: Math.round(r.width) + 12, height: Math.round(r.height) + 12 };
});
await page.screenshot({ path: 'shots/varpick-typed.png', clip: box2 });
console.log('shots/varpick-list.png\nshots/varpick-typed.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
