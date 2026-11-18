// 截图：① 报警弹窗里的变量格（新选择器）② 运行态弹窗（标题栏 + 贴底控件不被切）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot2-'));
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ① 报警弹窗：变量格 + 候选 */
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  ['rSpeed', 'iCount', 'sMode', '温度', 'GVL.中1[1]'].forEach((n, i) =>
    m.data.variables.push({ name: n, type: i === 2 ? 'string' : (i === 1 ? 'int' : 'real'), address: `HR${100 + i}`, value: 0, len: 0 }));
  m.data.alarms = [{ id: 'al1', name: '转速过高', variable: 'rSpeed', op: '>=', value: 3000, level: 'alarm', delaySec: 0, enabled: true, text: '主轴转速 {rSpeed} 超限' }];
  m.commit('截图准备');
  const mod = await import('/js/editor/alarmsPanel.js');
  mod.openAlarmEditor('al1');
});
await sleep(500);
await page.evaluate(() => {
  const inp = document.getElementById('alVariable');
  inp.focus();
  inp.value = '';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const dlgBox = await page.evaluate(() => {
  const r = document.getElementById('dlgBox').getBoundingClientRect();
  return { x: Math.max(0, Math.round(r.x) - 8), y: Math.max(0, Math.round(r.y) - 8), width: Math.round(r.width) + 16, height: Math.round(r.height) + 16 };
});
await page.screenshot({ path: 'shots/alarm-dialog-pick.png', clip: dlgBox });
await page.click('#dlgCancel');
await sleep(200);

/* ② 运行态弹窗：标题栏（带 ✕）+ 贴底控件 */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const pg = project.addPage('popup');
  project.updatePage(pg.id, { popupW: 360, popupH: 220, title: '报警详情', showClose: true });
  const mk = (type, text, y, h) => {
    const w = project.addWidget(type, 20, y);
    project.updateWidgetField(w.id, 'w', 320);
    project.updateWidgetField(w.id, 'h', h);
    project.updateWidgetProp(w.id, 'text', text);
    return w.id;
  };
  mk('label', '主轴转速过高，请检查刀具', 20, 30);
  mk('label', '这是一条贴着底边的提示（以前会被切掉）', 220 - 34, 34);
  project.commit('弹窗截图');
  return { pop: pg.id };
});
await sleep(300);
await page.evaluate(async (id) => {
  const rt = await import('/js/runtime/runtime.js');
  await rt.enterRun();
  rt.showPopup(id);
}, ids.pop);
await sleep(500);
const popBox = await page.evaluate(() => {
  const r = document.querySelector('#rtPopupLayer .rt-popup').getBoundingClientRect();
  return { x: Math.max(0, Math.round(r.x) - 10), y: Math.max(0, Math.round(r.y) - 10), width: Math.round(r.width) + 20, height: Math.round(r.height) + 20 };
});
await page.screenshot({ path: 'shots/popup-titled.png', clip: popBox });
console.log('shots/alarm-dialog-pick.png\nshots/popup-titled.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
