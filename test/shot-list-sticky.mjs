// shot-list-sticky.mjs — 控件清单「页面下拉那一行」吸顶的效果图（顺带当人工核对）
// 用法：node test/shot-list-sticky.mjs   （自己起一个临时后端，不碰 8866/8901 那两套）
// 产出：docs/screenshot-list-sticky.png
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
const OUT = path.join(ROOT, 'docs', 'screenshot-list-sticky.png');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-data-'));
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-logs-'));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS } });
for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(H + '/')).ok) break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
await installPageShim(page);
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

// 往这一页塞 60 个控件（清单够长才看得出吸顶），再滚到中间
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const w = await import('/js/editor/workspace.js').catch(() => null);
  const cur = project.currentPage().id;
  for (let i = 0; i < 60; i++) {
    const id = project.addWidget('label', 40 + (i % 8) * 80, 40 + Math.floor(i / 8) * 40, cur);
    project.updateWidgetField(id, 'name', `文本${i + 1}`);
  }
  project.commit('灌清单');
});
await sleep(500);
await page.click('.dock-tabs .dock-tab[data-panel="list"], .lp-tab[data-panel="list"]').catch(() => {});
await sleep(400);
await page.evaluate(() => {
  const body = document.querySelector('#panel-list .panel-body');
  body.scrollTop = Math.round(body.scrollHeight * 0.55);
  body.dispatchEvent(new Event('scroll'));
});
await sleep(600);
await page.locator('#panel-list').screenshot({ path: OUT });
console.log(OUT);

await browser.close();
srv.kill();
await sleep(600);
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* 临时目录 */ }
