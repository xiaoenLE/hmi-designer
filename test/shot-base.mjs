// shot-base.mjs — 公共底的两张图（编辑器里底那一层长什么样 / 运行态长什么样）
//   出来的图存 docs/screenshot-base-editor.png、docs/screenshot-base-run.png
//   用一个**空白工程**从零搭：两页普通页 + 一个公共底（标题栏 + 底部导航条），
//   这样图里看的全是公共底的效果，不会和演示工程自带的东西混在一起。
// 用法：node test/shot-base.mjs   （自己拉起独立后端，不碰 8866 上那套）
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
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-baseshot-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const set = (id, patch) => Object.assign(project.getWidget(id), patch);
  const prop = (id, k, v) => project.updateWidgetProp(id, k, v);

  project.newProject('blank');                       // 空白工程，图干净
  project.data.variables.push(
    { name: 'bRun', type: 'bool', address: '%MX0.0', value: true },
    { name: 'bAlarm', type: 'bool', address: '%MX0.2', value: false },
    { name: 'rSpeed', type: 'real', address: '%MW100', value: 12.5 });
  const p1 = project.pages().find(p => p.type === 'page');
  project.updatePage(p1.id, { name: '主页面' });

  // ── 公共底：标题栏（含报警灯）+ 底部导航条（4 个按钮，每个页面都长这样）──
  const b = project.addPage('base');
  project.updatePage(b.id, { name: '公共底1' });
  const title = project.addWidget('rect', 0, 0);
  set(title.id, { w: 1024, h: 56, z: 900 });
  prop(title.id, 'bgColor', '#2563eb');
  const t = project.addWidget('label', 20, 13);
  set(t.id, { w: 460, h: 30, z: 901 });
  prop(t.id, 'text', '玉邦6 单线切割机');
  prop(t.id, 'fontSize', 20); prop(t.id, 'textColor', '#ffffff'); prop(t.id, 'bold', true);
  const lamp = project.addWidget('lamp', 950, 3);
  set(lamp.id, { w: 50, h: 50, z: 902 });
  project.updateWidgetField(lamp.id, 'bindings.variable', 'bAlarm');
  const nav = project.addWidget('rect', 0, 540);
  set(nav.id, { w: 1024, h: 60, z: 903 });
  prop(nav.id, 'bgColor', '#eef2f7');
  ['主页面', '排线', '轴监控', '报警记录'].forEach((name, i) => {
    const bt = project.addWidget('button', 16 + i * 150, 548);
    set(bt.id, { w: 136, h: 44, z: 904 + i, bindings: {} });   // 清掉默认绑定：按钮就显示自己的文字
    prop(bt.id, 'text', name);
    prop(bt.id, 'fontSize', 15);
    project.updateWidgetActions(bt.id, [{
      trigger: 'click', type: 'gotoPage',
      params: { page: i === 3 ? p1.id : p1.id },               // 示意：点了跳页面（图里只看外观）
    }]);
  });

  project.setPageBase(p1.id, b.id);

  // ── 第一页自己的内容（页面控件在底**上面**那一层）──
  project.setCurrentPage(p1.id);
  const head = project.addWidget('label', 24, 78);
  set(head.id, { w: 300, h: 32 });
  prop(head.id, 'text', '主页面 · 运行状态'); prop(head.id, 'fontSize', 18); prop(head.id, 'bold', true);
  const card = project.addWidget('rect', 24, 122);
  set(card.id, { w: 480, h: 150, z: 1 });
  prop(card.id, 'bgColor', '#ffffff'); prop(card.id, 'borderColor', '#d0d7e2'); prop(card.id, 'radius', 10);
  const runLamp = project.addWidget('lamp', 60, 160);
  set(runLamp.id, { w: 50, h: 50, z: 2, bindings: { variable: 'bRun' } });
  const sp = project.addWidget('number', 200, 165);
  set(sp.id, { w: 160, h: 40, z: 2, bindings: { variable: 'rSpeed' } });
  prop(sp.id, 'unit', 'm/min');
  project.commit('公共底示例');
});
await sleep(500);

// 左区切到「页面」面板，让"底"那一行进画面
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('.dock-tabs .lp-tab')].find(t => t.textContent.includes('页面'))
    || [...document.querySelectorAll('.dock-tabs *')].find(t => t.textContent.trim() === '页面');
  tab?.click();
});
await sleep(400);

await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-base-editor.png') });
console.log('已存 docs/screenshot-base-editor.png');

await page.evaluate(async () => {
  (await import('/js/runtime/runtime.js')).enterRun();
  document.getElementById('rtHint')?.classList.add('hidden');   // 快捷键提示是临时的，别挡画面
});
await sleep(700);
await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-base-run.png') });
console.log('已存 docs/screenshot-base-run.png');

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
