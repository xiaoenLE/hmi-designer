// shot-log-settings.mjs — 给「工程 ▾ → 日志设置…」对话框拍一张图（README 用）
// 用法：node test/shot-log-settings.mjs   （自己起一个临时后端，不碰 8866/8901 那两套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const OUT = path.join(ROOT, 'docs', 'screenshot-log-settings.png');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-data-'));
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-logs-'));
// 摆几个像样的日志文件，好让对话框里"现在占多少"那行不是 0
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
fs.writeFileSync(path.join(LOGS, `hmi-${day(0)}.log`), 'x'.repeat(420 * 1024));
fs.writeFileSync(path.join(LOGS, `hmi-${day(1)}.log`), 'x'.repeat(380 * 1024));
fs.writeFileSync(path.join(LOGS, `script-${day(0)}.log`), 'x'.repeat(260 * 1024));
fs.writeFileSync(path.join(LOGS, `update-${day(0)}.log`), 'x'.repeat(12 * 1024));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS } });
for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(H + '/')).ok) break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
await installPageShim(page);
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);
await page.evaluate(async () => { (await import('/js/editor/logSettings.js')).openLogSettings(); });
await sleep(900);
await page.locator('#dlgBox').screenshot({ path: OUT });
console.log(OUT);

await browser.close();
srv.kill();
await sleep(600);
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* 临时目录 */ }
