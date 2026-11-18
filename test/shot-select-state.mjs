// 看一眼下拉框新东西长什么样（截图）：
//   ① 属性面板的「状态颜色」每一行一个色块  ② 只显示状态（状态色铺背景）
//   ③ 可选也可输入（弹层末尾那一行「✎ 输入…」）
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
const page = await b.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);

// 仿现场那条「机器状态」：11 个状态，各配一个颜色
const ITEMS = [
  '初始化中=0=#94a3b8', '轴未全部使能=1=#eab308', '待机中=2=#0ea5e9', '点动运行中=3=#22c55e',
  '手动绕线中=4=#14b8a6', '定长绕线中=5=#3b82f6', '自动运行中=6=#b91c1c', '消弧运行中=7=#8b5cf6',
  '切割完成=8=#0891b2', '急停中=9=#f97316', '设备故障=10=#ef4444',
].join('\n');
await page.evaluate(async ([items]) => {
  const m = (await import('/js/core/project.js')).project;
  m.data.pages[0].widgets.length = 0;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'i状态', type: 'int', address: '%MW10', value: 6, len: 0 });
  m.data.variables.push({ name: 'i模式', type: 'int', address: '%MW12', value: 1, len: 0 });
  const a = m.addWidget('select', 30, 30);
  m.updateWidgetField(a.id, 'bindings.variable', 'i状态');
  m.updateWidgetProp(a.id, 'items', items);
  m.updateWidgetProp(a.id, 'operate', 'view');            // 只显示状态（当状态牌用）
  m.updateWidgetProp(a.id, 'w', 190); m.updateWidgetProp(a.id, 'h', 52);
  m.updateWidgetProp(a.id, 'fontSize', 17); m.updateWidgetProp(a.id, 'maxRows', 11);
  const c = m.addWidget('select', 30, 110);
  m.updateWidgetField(c.id, 'bindings.variable', 'i模式');
  m.updateWidgetProp(c.id, 'items', '手动=0\n自动=1\n点动=2');
  m.updateWidgetProp(c.id, 'operate', 'type');            // 可选也可输入
  m.updateWidgetProp(c.id, 'maxRows', 8);
  m.commit('截图用');
  window.__a = a.id; window.__c = c.id;
}, [ITEMS]);
await sleep(400);
// 变量值先写进去：运行画面/画布都按它显示
await page.evaluate(() => window.app.varStore.set('i状态', 6, 'remote'));
await sleep(300);

await page.screenshot({ path: 'shots/select-state-canvas.png', clip: await page.evaluate(() => {
  const a = document.querySelector(`#canvas .wd[data-id="${window.__a}"]`).getBoundingClientRect();
  const c = document.querySelector(`#canvas .wd[data-id="${window.__c}"]`).getBoundingClientRect();
  const x = Math.min(a.x, c.x) - 10, y = Math.min(a.y, c.y) - 10;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(a.width, c.width) + 20), height: Math.round(c.bottom - y + 10) };
}) });
// ② 选中状态牌 → 属性面板（含 11 行状态颜色）
await page.click(`#canvas .wd[data-id="${await page.evaluate(() => window.__a)}"]`);
await sleep(400);
const panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .prop-group')];
  const g = rows.find(r => /下拉框 属性/.test(r.textContent));
  const r = g.getBoundingClientRect();
  return { x: Math.round(r.x) - 4, y: Math.round(r.y) - 4, width: Math.round(r.width) + 8, height: Math.min(880, Math.round(r.height) + 8) };
});
await page.screenshot({ path: 'shots/select-state-panel.png', clip: panel });
// ③ 运行态：可输入那个下拉展开的样子
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(500);
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).exitRun(); })());
await sleep(200);
await page.evaluate(async () => { (await import('/js/core/project.js')).project.commit('t'); });
const cbox = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const el = document.querySelector(`#canvas .wd[data-id="${window.__c}"]`);
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x) - 6, y: Math.round(r.y) - 6, width: Math.round(r.width) + 12, height: 260 };
});
await page.evaluate(async () => {
  const m = await import('/js/widgets/defs.js');
  const p = await import('/js/core/project.js');
  const el = document.querySelector(`#canvas .wd[data-id="${window.__c}"] .w-combo`);
  el.classList.add('open');                       // 编辑态直接展开看一眼（点不动是故意的）
  void m; void p;
});
await sleep(300);
await page.screenshot({ path: 'shots/select-editable-pop.png', clip: cbox });
console.log('shots/select-state-canvas.png\nshots/select-state-panel.png\nshots/select-editable-pop.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
