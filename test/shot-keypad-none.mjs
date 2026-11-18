// shot-keypad-none.mjs — 软键盘「标题显示 = 都不显示」的效果图（标题栏只剩左上角的 ✕）
// 用法：node test/shot-keypad-none.mjs   （自己起一个临时后端，不碰 8866/8901 那两套）
// 产出：docs/screenshot-keypad-none.png（标题显示「都不显示」）+ docs/screenshot-keypad-var.png（默认，变量名）
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
const page = await browser.newPage({ viewport: { width: 1300, height: 860 } });
await installPageShim(page);
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

const id = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'rWait', type: 'int', address: '%MW100', value: 30 });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const w = m.addWidget('number', 20, 20);
  w.bindings.variable = 'rWait';
  w.props.useKeyboard = true;
  w.name = '换向等待时间_副本';
  m.commit('拍图');
  return w.id;
});
await sleep(300);

const shoot = async (label, out) => {
  await page.evaluate(async (l) => {
    const m = (await import('/js/core/project.js')).project;
    m.setKeypad({ mode: 'edit', label: l });
    const rt = await import('/js/runtime/runtime.js');
    rt.exitRun();
    await rt.enterRun();
  }, label);
  await sleep(700);
  await page.click(`#rtPage .wd[data-id="${id}"]`);
  await sleep(500);
  await page.locator('#numPad').screenshot({ path: path.join(ROOT, 'docs', out) });
  console.log(path.join(ROOT, 'docs', out));
  await page.click('#npCancel');
  await sleep(300);
};
await shoot('none', 'screenshot-keypad-none.png');     // 标题显示：都不显示（只剩 ✕）
await shoot('var', 'screenshot-keypad-var.png');       // 默认：变量名

await browser.close();
srv.kill();
await sleep(600);
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* 临时目录 */ }
