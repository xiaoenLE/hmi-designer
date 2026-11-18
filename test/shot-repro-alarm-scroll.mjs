// 复现「往上滚动时，下面的行穿过表头」：用用户真实工程 + 他的面板布局，滚动后再截图
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
// 工程文件现在是 .LE；本地开发目录里可能还是老的 .json —— 两个都试
const _PLE = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2/server/data/hmi_project.LE';
const PROJ = fs.existsSync(_PLE) ? _PLE : 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2/server/data/hmi_project.json';
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1912, height: 900 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
const real = fs.readFileSync(PROJ, 'utf8');
await page.evaluate(async (json) => {
  const { project } = await import('/js/core/project.js');
  const data = JSON.parse(json);
  data.layout = {
    dock: {
      left: ['toolbox', 'pages', 'scripts', 'list'],
      right: ['properties'],
      bottom: ['alarms', 'vars'],
      float: [],
      active: { left: 'toolbox', right: 'properties', bottom: 'alarms' },
      split: { left: null, right: null, bottom: { extra: ['vars'], grow: [0.45, 0.55] } },
    },
  };
  project.replaceData(data);
}, real);
await sleep(1200);

const probe = () => page.evaluate(() => {
  const body = document.querySelector('#panel-alarms .panel-body');
  const th = document.querySelector('#alarmTable table.vt.alarm thead th:nth-child(2)');
  const rows = [...document.querySelectorAll('#alarmRows tr')].slice(0, 3).map(tr => ({
    y: Math.round(tr.getBoundingClientRect().y), h: Math.round(tr.getBoundingClientRect().height),
    t: (tr.textContent || '').trim().slice(0, 16),
  }));
  const head = document.querySelector('#panel-alarms .panel-head');
  return {
    scrollTop: Math.round(body.scrollTop),
    bodyY: Math.round(body.getBoundingClientRect().y), bodyH: Math.round(body.getBoundingClientRect().height),
    headBottom: Math.round(head.getBoundingClientRect().bottom),
    thY: Math.round(th.getBoundingClientRect().y), thH: Math.round(th.getBoundingClientRect().height),
    thBg: getComputedStyle(th).backgroundColor, thPos: getComputedStyle(th).position, thZ: getComputedStyle(th).zIndex,
    tableBorder: getComputedStyle(document.querySelector('#alarmTable table.vt.alarm')).borderCollapse,
    filterY: Math.round(document.getElementById('alarmFilter').getBoundingClientRect().y),
    rows,
  };
});
console.log('未滚动:', JSON.stringify(await probe()));
await page.evaluate(() => { document.querySelector('#panel-alarms .panel-body').scrollTop = 90; });
await sleep(400);
console.log('滚到 90:', JSON.stringify(await probe()));
// 关键时刻：表头位置那一点，命中测试拿到的是表头还是**下面的行**？
const hit = await page.evaluate(() => {
  const th = document.querySelector('#alarmTable table.vt.alarm thead th:nth-child(2)');
  const r = th.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const el = document.elementFromPoint(x, y);
  const filter = document.getElementById('alarmFilter').getBoundingClientRect();
  const fx = Math.round(filter.x + filter.width / 2), fy = Math.round(filter.y + filter.height / 2);
  const fel = document.elementFromPoint(fx, fy);
  return {
    at: { x, y },
    hit: el ? `${el.tagName}.${el.className}` : null,
    hitRow: el?.closest('tr')?.dataset?.alarm || null,
    filterHit: fel ? `${fel.tagName}.${fel.className}` : null,
  };
});
console.log('表头位置命中:', JSON.stringify(hit));
// 关键：筛选框底边 与 吸顶表头顶边 之间**有没有缝**（有缝 → 行会从缝里透出来）
const gap = await page.evaluate(() => {
  const f = document.getElementById('alarmFilter').getBoundingClientRect();
  const th = document.querySelector('#alarmTable table.vt.alarm thead th:nth-child(2)').getBoundingClientRect();
  return { filterBottom: Math.round(f.bottom), headTop: Math.round(th.top), 缝: Math.round(th.top - f.bottom) };
});
console.log('筛选框底边/表头顶边:', JSON.stringify(gap));
await page.screenshot({ path: 'shots/repro-alarm-scroll.png', clip: { x: 0, y: 685, width: 870, height: 200 } });
// 强制整层重绘（改一下 opacity 再改回来）：如果重影消失 → 是**合成层残留**，不是布局问题
await page.evaluate(() => {
  const p = document.getElementById('panel-alarms');
  p.style.opacity = '0.999';
  void p.offsetHeight;
  p.style.opacity = '';
});
await sleep(300);
await page.screenshot({ path: 'shots/repro-alarm-scroll2.png', clip: { x: 0, y: 685, width: 870, height: 200 } });
// 再试：给表头单独提一层（will-change: transform 是 sticky+表格重影的常见解法）
await page.evaluate(async () => {
  const ths = document.querySelectorAll('#alarmTable table.vt.alarm thead th');
  ths.forEach(th => { th.style.willChange = 'transform'; });
  const body = document.querySelector('#panel-alarms .panel-body');
  body.scrollTop = 0; void body.offsetHeight; body.scrollTop = 90;
});
await sleep(400);
await page.screenshot({ path: 'shots/repro-alarm-scroll3.png', clip: { x: 0, y: 685, width: 870, height: 200 } });
// 再试：border-collapse: separate（sticky 表头 + collapse 是已知会串行的组合）
await page.evaluate(async () => {
  document.querySelectorAll('#alarmTable table.vt.alarm thead th').forEach(th => { th.style.willChange = ''; });
  document.querySelector('#alarmTable table.vt.alarm').style.borderCollapse = 'separate';
  document.querySelector('#alarmTable table.vt.alarm').style.borderSpacing = '0';
  const body = document.querySelector('#panel-alarms .panel-body');
  body.scrollTop = 0; void body.offsetHeight; body.scrollTop = 90;
});
await sleep(400);
await page.screenshot({ path: 'shots/repro-alarm-scroll4.png', clip: { x: 0, y: 685, width: 870, height: 200 } });
console.log('shots/repro-alarm-scroll.png  scroll2.png(重绘后)  scroll3.png(will-change)  scroll4.png(separate)');
// 变量表也滚一下看看：它上面没有筛选框，表头应该正好贴住面板顶边（不能有缝）
await page.evaluate(() => { document.querySelector('#panel-vars .panel-body').scrollTop = 80; });
await sleep(400);
const vgap = await page.evaluate(() => {
  const body = document.querySelector('#panel-vars .panel-body').getBoundingClientRect();
  const th = document.querySelector('#varTable table.vartbl thead th:nth-child(2)').getBoundingClientRect();
  return { bodyTop: Math.round(body.top), headTop: Math.round(th.top), 缝: Math.round(th.top - body.top) };
});
console.log('变量表 面板顶/表头顶:', JSON.stringify(vgap));
await page.screenshot({ path: 'shots/repro-vars-scroll.png', clip: { x: 860, y: 685, width: 1052, height: 190 } });
console.log('shots/repro-vars-scroll.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
