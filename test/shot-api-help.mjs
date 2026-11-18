// 看一眼「脚本 API 帮助」长什么样（编辑器里点「? 帮助」）
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
await page.evaluate(async () => {
  const p = (await import('/js/core/project.js')).project;
  p.data.variables.length = 0;
  const add = (name, type, address) => p.data.variables.push({ name, type, address, value: 0, len: 0 });
  add('rSpeed', 'real', '%MW100'); add('bOverSpeed', 'bool', '%MX0.0'); add('nCount', 'int', '%MW20');
  p.commit('演示');
  await (await import('/js/editor/scriptEditor.js')).openScriptEditor();
});
await sleep(500);
// 帮助框 + 它右边的「API 速查」一起截进来
await page.evaluate(() => document.getElementById('seHelp').click());
await sleep(500);
await page.screenshot({ path: 'shots/api-help.png' });
const info = await page.evaluate(() => {
  const box = document.getElementById('dlgBox').getBoundingClientRect();
  return { 条数: document.querySelectorAll('#dlgBody .api-help-row').length, 插入按钮: document.querySelectorAll('#dlgBody .api-help-ins').length, 框: `${Math.round(box.width)}x${Math.round(box.height)}` };
});
console.log(JSON.stringify(info));
console.log('shots/api-help.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
