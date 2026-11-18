// 看一眼「点击穿透」的效果（截图）：
//   ① 属性面板里新增的「点击穿透」那一栏
//   ② 运行态：一个大方框压在按钮上，点一下**两个都触发**（两个计数值都变成 1）
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

// 画一个「方框压住按钮」的画面：两个控件完全叠在一起，各写一个变量，右边用两个数值控件显示结果
await page.evaluate(async () => {
  const p = (await import('/js/core/project.js')).project;
  p.data.pages[0].widgets.length = 0;
  p.data.variables.length = 0;
  const add = (name) => p.data.variables.push({ name, type: 'int', address: '', value: 0, len: 0 });
  add('n上'); add('n下');
  const mkLabel = (text, x, y, size, color) => {
    const l = p.addWidget('label', x, y);
    p.updateWidgetProp(l.id, 'text', text);
    p.updateWidgetProp(l.id, 'fontSize', size);
    p.updateWidgetProp(l.id, 'textColor', color);
    p.updateWidgetField(l.id, 'w', 260); p.updateWidgetField(l.id, 'h', 34);
    return l;
  };
  mkLabel('叠在一起的两个控件（方框压住按钮）', 30, 20, 16, '#1f2329');
  mkLabel('① 下面那个：按钮「启动」', 30, 66, 14, '#64748b');
  mkLabel('② 上面那个：一层透明方框（框住按钮）', 30, 196, 14, '#64748b');
  mkLabel('点一下（点的是方框）→ 两个都触发：', 30, 330, 15, '#1f2329');
  mkLabel('方框计数', 30, 372, 14, '#2563eb');
  mkLabel('按钮计数', 30, 432, 14, '#16a34a');
  const num = (name, x, y, color) => {
    const n = p.addWidget('number', x, y);
    p.updateWidgetField(n.id, 'bindings.variable', name);
    p.updateWidgetProp(n.id, 'fontSize', 24);
    p.updateWidgetProp(n.id, 'textColor', color);
    p.updateWidgetProp(n.id, 'bgColor', '#f1f5f9');
    p.updateWidgetProp(n.id, 'borderColor', '#cbd5e1');
    p.updateWidgetField(n.id, 'w', 120); p.updateWidgetField(n.id, 'h', 44);
    return n;
  };
  num('n上', 30, 394, '#2563eb');
  num('n下', 30, 454, '#16a34a');

  // 下面那个：按钮
  const under = p.addWidget('button', 330, 60);
  p.updateWidgetField(under.id, 'w', 260); p.updateWidgetField(under.id, 'h', 110);
  p.updateWidgetProp(under.id, 'text', '启动');
  p.updateWidgetProp(under.id, 'fontSize', 24);
  p.updateWidgetProp(under.id, 'bgColor', '#16a34a');
  p.updateWidgetProp(under.id, 'showState', false);      // 演示用：按钮上就写「启动」，别跟着动作变量变开/关
  p.updateWidgetActions(under.id, [{ type: 'setValue', trigger: 'click', params: { variable: 'n下', value: '1' } }]);
  // 上面那个：同位置的透明方框（只留蓝色粗边框，正好把按钮整个框住）
  const top = p.addWidget('rect', 330, 60);
  p.updateWidgetField(top.id, 'w', 260); p.updateWidgetField(top.id, 'h', 110);
  p.updateWidgetProp(top.id, 'bgColor', '');
  p.updateWidgetProp(top.id, 'borderColor', '#2563eb');
  p.updateWidgetProp(top.id, 'borderWidth', 4);
  p.updateWidgetProp(top.id, 'radius', 8);
  p.updateWidgetProp(top.id, 'clickThrough', true);        // ← 就是这一栏：勾上「穿透」
  p.updateWidgetActions(top.id, [{ type: 'setValue', trigger: 'click', params: { variable: 'n上', value: '1' } }]);
  p.commit('点击穿透演示');
  window.__top = top.id;
});
await sleep(400);

// ① 属性面板那一栏
await page.click(`#canvas .wd[data-id="${await page.evaluate(() => window.__top)}"]`);
await sleep(400);
const g = await page.evaluate(() => {
  const grp = [...document.querySelectorAll('#propBody .prop-group')].find(x => /点击穿透/.test(x.textContent));
  const r = grp.getBoundingClientRect();
  return { x: Math.round(r.x) - 4, y: Math.round(r.y) - 4, width: Math.round(r.width) + 8, height: Math.round(r.height) + 8 };
});
await page.screenshot({ path: 'shots/clickthrough-panel.png', clip: g });

// ② 运行态：点一下方框，两个计数都变 1
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(500);
const box = await page.locator(`#rtPage .wd[data-id="${await page.evaluate(() => window.__top)}"]`).boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await sleep(400);
const shot = await page.evaluate(() => {
  // 整块运行画面都截进来：左边两块计数 + 右边叠着的方框/按钮，一眼看到「两个都触发了」
  const p = document.querySelector('#rtPage').getBoundingClientRect();
  return { x: Math.round(p.x) - 8, y: Math.round(p.y) - 8, width: Math.round(p.width) + 16, height: Math.round(p.height) + 16 };
});
await page.screenshot({ path: 'shots/clickthrough-run.png', clip: shot });
const counts = await page.evaluate(() => ({ top: window.app.varStore.get('n上'), under: window.app.varStore.get('n下') }));
console.log('点一下方框之后：方框计数 =', counts.top, ' 按钮计数 =', counts.under);
console.log('shots/clickthrough-panel.png\nshots/clickthrough-run.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
