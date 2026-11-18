// smoke.mjs — 设计器自动化冒烟测试（playwright-core 驱动本地 Chromium）
// 用法：npm i playwright-core 后  node test/smoke.mjs
import { createRequire } from 'node:module';
// ESM 不认 NODE_PATH，用 createRequire 锚定到托管 node workspace 找 playwright-core
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
import { fileURLToPath } from 'url';
import path from 'path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8866/';
installNodeFetchPatch(URL);

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

await installPageShim(page);
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app && window.app.project && window.app.project.data);

// ── 1. 加载与无 JS 错误 ──
check('页面加载、app 就绪', await page.evaluate(() => !!window.app));
await page.waitForTimeout(300);
check('无控制台/页面错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

// ── 2. 种子工程 ──
const seed = await page.evaluate(() => ({
  pages: window.app.project.data.pages.length,
  vars: window.app.project.data.variables.length,
  wd: document.querySelectorAll('#canvas .wd').length,
}));
check('种子工程 3 页', seed.pages === 3, `pages=${seed.pages}`);
check('种子工程 6 变量', seed.vars === 6, `vars=${seed.vars}`);
check('主画面控件已渲染', seed.wd > 5, `wd=${seed.wd}`);

// ── 3. 真实拖放创建控件 ──
const before = await page.evaluate(() => document.querySelectorAll('#canvas .wd').length);
await page.locator('.tb-item', { hasText: '圆形' }).first().dragTo(page.locator('#canvas'));
await page.waitForTimeout(200);
const after = await page.evaluate(() => document.querySelectorAll('#canvas .wd').length);
check('拖放创建控件（+1）', after === before + 1, `${before} -> ${after}`);

// ── 4. 运行模式 ──
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(400);
const runOk = await page.evaluate(() =>
  !document.getElementById('runtimeRoot').classList.contains('hidden'));
check('进入运行模式', runOk);
const rtWd = await page.evaluate(() => document.querySelectorAll('#rtPage .wd').length);
check('运行页控件渲染', rtWd > 5, `rtWd=${rtWd}`);

// ── 5. 点动按钮（tap：按住 TRUE / 松开 FALSE）──
await page.evaluate(() => window.app.varStore.resetFrom(window.app.project.data.variables));
const jog = page.locator('#rtPage .wd-button', { hasText: '点动·前进' });
const jogBox = await jog.boundingBox();
await page.mouse.move(jogBox.x + jogBox.width / 2, jogBox.y + jogBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(120);
const tapDown = await page.evaluate(() => window.app.varStore.get('bRunCmd'));
await page.mouse.up();
await page.waitForTimeout(120);
const tapUp = await page.evaluate(() => window.app.varStore.get('bRunCmd'));
check('点动按下=TRUE', tapDown === true, `down=${tapDown}`);
check('点动松开=FALSE', tapUp === false, `up=${tapUp}`);

// ── 6. 切换按钮（toggle 翻转）──
await page.locator('#rtPage .wd-button', { hasText: '启停切换' }).click();
await page.waitForTimeout(100);
const toggled = await page.evaluate(() => window.app.varStore.get('bRunCmd'));
check('切换按钮翻转保持', toggled === true, `bRunCmd=${toggled}`);

// ── 7. 页面跳转 ──
await page.locator('#rtPage .wd-button', { hasText: '参数设定' }).click();
await page.waitForTimeout(150);
const onParam = await page.evaluate(() =>
  document.querySelector('#rtPage .wd-label')?.textContent.includes('参数设定') ||
  document.querySelector('#rtPage')?.textContent.includes('设定速度'));
check('跳转到参数页', onParam);

// ── 8. 弹窗（showPopup / hidePopup）──
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(150);
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(300);
await page.locator('#rtPage .wd-button', { hasText: '报警详情' }).click();
await page.waitForTimeout(150);
const popupShown = await page.evaluate(() => !!document.querySelector('#rtPopupLayer .rt-popup'));
check('打开弹窗', popupShown);
await page.locator('#rtPopupLayer .rt-popup .wd-button', { hasText: '确认复位' }).click();
await page.waitForTimeout(150);
const popupGone = await page.evaluate(() => !document.querySelector('#rtPopupLayer .rt-popup'));
const alarmReset = await page.evaluate(() => window.app.varStore.get('bAlarm'));
check('确认复位关弹窗+置变量', popupGone && alarmReset === false, `popupGone=${popupGone}, bAlarm=${alarmReset}`);

// ── 9. 退出运行 ──
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(150);
check('退出运行模式', await page.evaluate(() => document.getElementById('runtimeRoot').classList.contains('hidden')));

// ── 截图 ──
const outDir = path.dirname(fileURLToPath(import.meta.url));
await page.screenshot({ path: path.join(outDir, 'smoke.png'), fullPage: false });

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 结果：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
