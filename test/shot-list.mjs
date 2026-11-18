// 截图：控件清单（类型配色 + 配置列 + 隐藏名称前后各一张）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-listshot-'));
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
await sleep(400);
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'rSpd', type: 'real', address: '%MW100', value: 0, len: 0 });
  m.data.variables.push({ name: 'bRun', type: 'bool', address: '%MX0.0', value: false, len: 0 });
  m.data.variables.push({ name: 'GVL.中1[1]', type: 'int', value: 0, len: 0, address: 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.中1[1]' });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const mk = (type, name, variable, extra = {}) => {
    const w = m.addWidget(type, 40, 40);
    w.name = name;
    Object.assign(w.props, extra);
    if (variable) w.bindings.variable = variable;
    return w;
  };
  mk('button', '启动按钮', 'bRun', { permLevel: '' });
  mk('button', '停止按钮', 'bRun');
  mk('lamp', '运行指示', 'bRun');
  mk('number', '转速显示', 'rSpd');
  mk('value', '中文变量显示', 'GVL.中1[1]');
  mk('input', '转速设定', 'rSpd');
  mk('label', '标题文字', '');
  mk('table', '参数表格', '');
  mk('clock', '班次时钟', '');
  mk('trend', '温度曲线', '');
  mk('alarmBar', '报警条', '');
  mk('rect', '底板', '');
  m.commit('清单截图');
});
await sleep(500);
await page.click('.lp-tab[data-tab="list"]');
await sleep(300);
const clip = await page.evaluate(() => {
  const r = document.getElementById('panel-list').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.min(Math.round(r.height), 560) };
});
await page.screenshot({ path: 'shots/list-names.png', clip });
await page.click('#listHideName');
await sleep(300);
await page.screenshot({ path: 'shots/list-noname.png', clip });
console.log('shots/list-names.png\nshots/list-noname.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
