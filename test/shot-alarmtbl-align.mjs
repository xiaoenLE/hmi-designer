// 确认报警控件的"说明栏 / 数据行"列**严格对齐**（编辑态和运行态都量一遍）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-'));
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1200, height: 800 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(async () => {
  const p = (await import('/js/core/project.js')).project;
  p.data.pages[0].widgets.length = 0;
  p.data.meta.canvas.w = 880; p.data.meta.canvas.h = 620;
  const mk = (type, x, y, w, h) => { const k = p.addWidget(type, x, y); p.updateWidgetField(k.id, 'w', w); p.updateWidgetField(k.id, 'h', h); return k; };
  const a = mk('alarmList', 20, 20, 620, 200); p.updateWidgetProp(a.id, 'maxRows', 6);
  const h = mk('alarmHistory', 20, 240, 620, 220); p.updateWidgetProp(h.id, 'maxRows', 7);
  p.commit('列对齐检查');
  window.__a = a.id; window.__h = h.id;
});
await sleep(600);

const align = (root, tag) => page.evaluate(([r, t]) => {
  const el = document.querySelector(`${r} .w-alarmtbl`);
  const heads = [...el.querySelectorAll('.at-table thead tr:last-child td')].map(td => Math.round(td.getBoundingClientRect().left));
  const row = el.querySelector('.at-table tbody tr');
  const cells = row ? [...row.cells].map(td => Math.round(td.getBoundingClientRect().left)) : [];
  return { 说明栏: heads, 数据行: cells, 对齐: JSON.stringify(heads) === JSON.stringify(cells), 表数: el.querySelectorAll('table').length };
}, [root, tag]);

console.log('编辑态 当前报警:', JSON.stringify(await align('#canvas', 'edit')));
console.log('编辑态 报警历史:', JSON.stringify(await align('#canvas', 'edit')));
await page.screenshot({ path: 'shots/alarmtbl-edit.png', clip: { x: 240, y: 60, width: 660, height: 100 } });
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(700);
console.log('运行态 当前报警:', JSON.stringify(await align('#rtPage', 'run')));
console.log('运行态 报警历史:', JSON.stringify(await align('#rtPage', 'run')));
await page.screenshot({ path: 'shots/alarmtbl-edit.png', clip: { x: 0, y: 0, width: 660, height: 470 } });
console.log('shots/alarmtbl-edit.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
