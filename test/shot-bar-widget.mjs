// shot-bar-widget.mjs — 新建的「棒图」控件效果图：工具箱条目 + 画布上的两种状态（正常/超限）+ 自动长出来的属性面板
// 用法：node test/shot-bar-widget.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-bar-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/api/health'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(400);

const info = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const { select } = await import('/js/editor/canvas.js');
  // 两个真实变量：主轴转速（正常区）、液压油温（超限区）
  project.data.variables.push(
    { name: 'rSpindle', type: 'real', address: '%MD100', value: 0 },
    { name: 'rOilTemp', type: 'real', address: '%MD104', value: 0 },
  );
  varStore.resetFrom(project.variables());
  const mk = (x, y, name, v) => {
    const w = project.addWidget('bar', x, y);
    w.name = name;
    w.w = 420; w.h = 30;
    w.bindings.variable = v;
    w.props.max = 3000; w.props.decimals = 1; w.props.unit = ' m/min';
    w.props.warnAt = 90; w.props.showText = true;
    return w;
  };
  const b1 = mk(80, 120, '棒图1', 'rSpindle');
  const b2 = mk(80, 200, '棒图2', 'rOilTemp');
  b2.props.min = 0; b2.props.max = 100; b2.props.unit = ' ℃'; b2.props.warnAt = 85;
  b2.props.warnColor = '#ef4444';
  // 给个运行值看得见效果：1680/3000 = 56%（正常），92/100 = 92%（超限 → 变红）
  varStore.set('rSpindle', 1680, 'local');
  varStore.set('rOilTemp', 92, 'local');
  select([b1.id]);
  await new Promise(r => setTimeout(r, 300));
  return {
    inToolbox: [...document.querySelectorAll('#toolboxList .tb-item')].map(i => i.textContent.trim().split('\n')[0]),
    propRows: [...document.querySelectorAll('#propBody .f-label')].map(e => e.textContent.trim()),
    // ⚠ 两层类名别搞混：外层定位壳是 `.wd-bar`（registry 自动加的 `wd-<type>`），
    //    控件自己画的那个才是 `.w-bar`（我写在 render 里的）
    barHtml: [...document.querySelectorAll('#canvas .w-bar')].map(e => e.outerHTML.replace(/\s+/g, ' ').slice(0, 110)),
    overCount: document.querySelectorAll('#canvas .w-bar.over').length,
  };
});

console.log('工具箱：', info.inToolbox.join(' / '));
console.log('属性面板自动长出的行：', info.propRows.join(' · '));
console.log('超限变色的棒图个数：', info.overCount);
info.barHtml.forEach((h, i) => console.log(`  棒图${i + 1}: ${h}`));

const out = path.join(ROOT, 'docs', 'screenshot-new-widget-bar.png');
await page.screenshot({ path: out });
console.log('→ docs/screenshot-new-widget-bar.png');

await browser.close(); srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
