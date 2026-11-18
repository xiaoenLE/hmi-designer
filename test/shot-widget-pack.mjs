// shot-widget-pack.mjs — 控件包的两张"眼见为实"截图：
//   1) 选中控件 → 右键菜单里有「导出为控件包…（给别人用）」
//   2) 导入一个**带自定义控件定义（代码）**的包 → 那个"看清源码再点头"的确认框
// 用法：node test/shot-widget-pack.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'docs');
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-packshot-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(400);

/* 准备：画面上摆一个按钮 + 一个自定义控件（模拟"别人做好的控件"） */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const pack = await import('/js/widgets/pack.js');
  project.data.variables.push({ name: 'bStart', type: 'bool', address: '%MX0.0', value: false });
  const b = project.addWidget('button', 80, 60);
  b.props.text = '启动'; b.bindings.variable = 'bStart';
  b.actions = [{ trigger: 'click', type: 'toggle', params: { variable: 'bStart' } }];
  pack.registerCustomDefChecked({
    type: 'packgauge', title: '棒图', sub: '别人做好的控件',
    icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="12" width="26" height="12" rx="3" fill="#22c55e"/></svg>',
    defaults: { w: 220, h: 30, min: 0, max: 100, fontSize: 13 },
    props: [{ key: 'min', label: '最小', type: 'number' }, { key: 'max', label: '最大', type: 'number' }],
    binding: { variable: { types: ['int', 'real'], label: '绑定变量' } },
    actions: [],
    renderSrc: `render(w, mode, vars) {
  const p = w.props;
  const v = varValue(w, vars);
  const pct = Math.max(0, Math.min(100, ((Number(v) || 0) - p.min) / ((p.max - p.min) || 1) * 100));
  return '<div class="w-bar"><i style="width:' + pct.toFixed(1) + '%"></i><b>' + escapeHtml(String(Math.round(pct))) + '%</b></div>';
}`,
    css: '.w-bar{position:relative;width:100%;height:100%;background:#e5e7eb;border-radius:6px;overflow:hidden}\n.w-bar i{position:absolute;left:0;top:0;height:100%;background:#22c55e}\n.w-bar b{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px}',
  });
  const g = project.addWidget('packgauge', 80, 140);
  g.name = '棒图1'; g.bindings.variable = 'bStart';
  const { select } = await import('/js/editor/canvas.js');
  select([b.id]);
});

/* ① 右键菜单里的「导出为控件包…」 */
const btnBox = await page.evaluate(async () => {
  const el = document.querySelector('#canvas .wd');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(btnBox.x, btnBox.y, { button: 'right' });
await sleep(400);
await page.screenshot({ path: path.join(OUT, 'screenshot-widget-export-menu.png') });
console.log('→ docs/screenshot-widget-export-menu.png');

/* ② 导入带代码的包 → 确认框 */
await page.keyboard.press('Escape');
await sleep(200);
const packJson = await page.evaluate(async () => {
  const { project, } = await import('/js/core/project.js');
  const { select } = await import('/js/editor/canvas.js');
  const g = project.currentPage().widgets.find(w => w.type === 'packgauge');
  select([g.id]);
  return JSON.stringify(project.widgetExportPayload([g.id]));
});
await page.evaluate(async (json) => {
  const m = await import('/js/editor/widgetIO.js');
  const f = new File([json], '别人的棒图.hmiw.json', { type: 'application/json' });
  await m.importPackFile(f);
}, packJson);
await sleep(600);
await page.screenshot({ path: path.join(OUT, 'screenshot-widget-import-confirm.png') });
console.log('→ docs/screenshot-widget-import-confirm.png');

/* ③ 点「知道了，导入」→ 控件进画面 + **左侧控件库里当场多出这个自定义控件**（带「包」角标） */
await page.click('#dlgOk');
await sleep(700);
const toolboxHasIt = await page.evaluate(() => ({
  items: [...document.querySelectorAll('#toolboxList .tb-item')].map(i => i.textContent.trim().split('\n')[0]),
  badge: !!document.querySelector('#toolboxList .tb-badge'),
  onCanvas: document.querySelectorAll('#canvas .wd-packgauge').length,
}));
console.log('工具箱条目：', toolboxHasIt.items.join(' / '));
console.log('自定义角标：', toolboxHasIt.badge, '· 画布上的自定义控件：', toolboxHasIt.onCanvas);
await page.screenshot({ path: path.join(OUT, 'screenshot-widget-imported.png') });
console.log('→ docs/screenshot-widget-imported.png');

await browser.close(); srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
