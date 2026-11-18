// 截图：运行态密码框（带「解锁哪一级」下拉）+ 解锁了不够的等级之后的那句提示
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-permshot-'));
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/api/health'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1200, height: 820 } });
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

const info = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { obfuscate } = await import('/js/core/sha256.js');
  const rt = await import('/js/runtime/runtime.js');
  const pg = project.pages()[0];
  pg.widgets.length = 0;
  project.setPermissions({ enabled: true, lockAfterMin: 0 });
  project.data.permissions.levels = [];
  const op = project.addPermLevel({ name: '操作员' });
  project.updatePermLevel(op.id, { pw: obfuscate('1111', op.id) });
  const en = project.addPermLevel({ name: '工程师' });
  project.updatePermLevel(en.id, { pw: obfuscate('2222', en.id) });
  const w = project.addWidget('button', 60, 60);
  project.updateWidgetField(w.id, 'w', 200);
  project.updateWidgetField(w.id, 'h', 60);
  project.updateWidgetProp(w.id, 'text', '启动设备（要工程师）');
  project.updateWidgetProp(w.id, 'permLevel', en.id);
  project.updateWidgetActions(w.id, [{ trigger: 'click', type: 'tap', params: {} }]);
  project.commit('权限截图');
  await rt.enterRun();
  await new Promise(r => setTimeout(r, 500));
  return { wid: w.id, op: op.id, en: en.id, opName: op.name, enName: en.name };
});
await sleep(400);
await page.locator(`#rtPage .wd[data-id="${info.wid}"]`).click();
await sleep(400);
const cardBox = await page.evaluate(() => {
  const r = document.querySelector('.rt-perm-card').getBoundingClientRect();
  return { x: Math.max(0, Math.round(r.x) - 14), y: Math.max(0, Math.round(r.y) - 14), width: Math.round(r.width) + 28, height: Math.round(r.height) + 28 };
});
await page.screenshot({ path: 'shots/perm-pw-dialog.png', clip: cardBox });
// 改选「操作员」+ 它的密码 → 解锁后那句"还不够"的提示
await page.selectOption('#permLevelSel', info.op);
await page.waitForTimeout(150);
await page.fill('#permPw', '1111');
await page.click('#permOk');
await page.waitForTimeout(400);
const toastBox = await page.evaluate(() => {
  const t = document.querySelector('.rt-perm-toast');
  const c = document.getElementById('rtPermChip');
  const a = t.getBoundingClientRect(), b2 = c.getBoundingClientRect();
  const x = Math.min(a.x, b2.x), y = Math.min(a.y, b2.y);
  return { x: Math.max(0, Math.round(x) - 12), y: Math.max(0, Math.round(y) - 12),
    width: Math.round(Math.max(a.right, b2.right) - x) + 24, height: Math.round(Math.max(a.bottom, b2.bottom) - y) + 24 };
});
await page.screenshot({ path: 'shots/perm-unlock-lower.png', clip: toastBox });
console.log('shots/perm-pw-dialog.png\nshots/perm-unlock-lower.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
