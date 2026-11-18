// 用**用户自己的工程数据** + 他的面板布局复现「变量表顶部行重叠/显示不全」
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
const PROJ = 'C:/Users/Administrator/Desktop/hmi/hmi-designer/server/data/hmi_project.json';
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/api/health'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1912, height: 900 } });
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
await sleep(1500);
// 用户工程里那条「按名称分组」的折叠状态是从 localStorage 来的，这里模拟"分组开着"
console.log('变量数 =', await page.evaluate(() => window.app.project.variables().length));
console.log('行数 =', await page.evaluate(() => document.querySelectorAll('#varRows tr').length));
const top = await page.evaluate(() => {
  const t = document.querySelector('#varTable table.vartbl');
  const rows = [...document.querySelectorAll('#varRows tr')].slice(0, 6).map(tr => ({
    cls: tr.className, y: Math.round(tr.getBoundingClientRect().y), h: Math.round(tr.getBoundingClientRect().height),
    txt: (tr.textContent || '').trim().slice(0, 30), vrow: tr.dataset.vrow || '',
  }));
  return {
    tableY: Math.round(t.getBoundingClientRect().y),
    headY: Math.round(document.querySelector('#panel-vars .panel-head').getBoundingClientRect().y),
    bodyY: Math.round(document.querySelector('#panel-vars .panel-body').getBoundingClientRect().y),
    scrollTop: document.querySelector('#panel-vars .panel-body').scrollTop,
    rows,
  };
});
console.log(JSON.stringify(top, null, 1));
await page.screenshot({ path: 'shots/repro-vars-top.png', clip: { x: 860, y: 685, width: 1052, height: 190 } });
console.log('shots/repro-vars-top.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
