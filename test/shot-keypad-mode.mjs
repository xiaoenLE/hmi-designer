// shot-keypad-mode.mjs — 截图看「软键盘起手方式」长什么样（设置对话框 + 运行态键盘）
// 用法：node tools/run-suites.mjs 起不来就自己起服务，再 node test/shot-keypad-mode.mjs [端口]
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
}));

/* ① 设置对话框（工程 ▾ → 软键盘设置…） */
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'rSpeed', type: 'real', address: '%MW100', value: 12.5 });
  const pg = m.pages()[0]; pg.widgets.length = 0;
  const w = m.addWidget('number', 40, 40); w.bindings.variable = 'rSpeed'; w.name = '线速度设定';
  m.commit('键盘截图');
});
await sleep(300);
await page.evaluate(async () => (await import('/js/editor/toolbar.js')).openKeypadDialog());
await sleep(400);
await page.screenshot({ path: 'docs/screenshot-keypad-setting.png', clip: await clipOf('#dlgBox') });
await page.keyboard.press('Escape');
await sleep(250);

/* ② 运行态：首键清空重输 + 标题显示控件名（显示区里那条是原值，淡色） */
await page.evaluate(async () => (await import('/js/core/project.js')).project.setKeypad({ mode: 'replace', label: 'widget' }));
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(600);
const id = await page.evaluate(async () => (await import('/js/core/project.js')).project.pages()[0].widgets[0].id);
await page.click(`#rtPage .wd[data-id="${id}"]`);
await sleep(400);
await page.screenshot({ path: 'docs/screenshot-keypad-replace.png', clip: await clipOf('#numPad') });

console.log('截图完成：docs/screenshot-keypad-setting.png · docs/screenshot-keypad-replace.png');
await browser.close();

async function clipOf(sel) {
  const b = await page.locator(sel).boundingBox();
  return {
    x: Math.max(0, b.x - 12), y: Math.max(0, b.y - 12),
    width: Math.min(1500 - b.x, b.width + 24), height: Math.min(940 - b.y, b.height + 24),
  };
}
