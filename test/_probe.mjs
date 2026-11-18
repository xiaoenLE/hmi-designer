// _probe.mjs — 页面能不能起来 / 起不来时把真实报错打出来（拆文件后排查用）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-probe-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage();
page.on('console', m => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
page.on('requestfailed', r => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', r => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
await page.goto(H + '/', { waitUntil: 'load' });
await sleep(2500);
const st = await page.evaluate(() => ({
  app: !!window.app, errs: window.__appErrors || [],
  boot: document.getElementById('bootHint')?.textContent?.slice(0, 300) || '',
}));
console.log('window.app =', st.app);
console.log('__appErrors =', JSON.stringify(st.errs, null, 1));
console.log('bootHint =', st.boot);
await browser.close(); srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* */ }
