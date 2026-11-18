import { createRequire } from 'node:module';
import { installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8878';
installNodeFetchPatch(BASE);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(600);

// 造一个「点动」按钮：状态显示绑 bRun，动作 = 点动（按住 TRUE / 松开 FALSE）
const ids = await page.evaluate(async () => {
  const m = window.app.project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'bRun', type: 'bool', address: '%MX0.0', value: false, len: 0 });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const w = m.addWidget('button', 40, 40);
  w.name = 'btnJog';
  w.props.text = '点动';
  w.props.showState = true;
  w.props.onText = '运行中';
  w.props.offText = '停止';
  w.props.onColor = '#22c55e';
  w.props.offColor = '#9ca3af';
  // ⚠ 故意**不绑「状态显示」**，只配动作变量 —— 这就是"点动按钮不亮"的那种配法
  w.bindings.variable = '';
  w.actions = [{ trigger: 'click', type: 'tap', params: { variable: 'bRun' } }];
  m.commit('tap 测试');
  return { id: w.id };
});
console.log('按钮 id =', ids.id);

await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await page.waitForTimeout(1200);

const snap = () => page.evaluate((id) => {
  const btn = document.querySelector(`#rtPage .wd[data-id="${id}"] .w-btn`);
  const cs = btn ? getComputedStyle(btn) : null;
  return {
    text: btn?.textContent,
    bg: cs?.backgroundImage,
    store: window.app.varStore.get('bRun'),
  };
}, ids.id);

console.log('初始     :', JSON.stringify(await snap()));

const box = await page.locator(`#rtPage .wd[data-id="${ids.id}"]`).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(250);
console.log('按住中   :', JSON.stringify(await snap()), '  ← 期望 文字=运行中 / 绿底 / store=true');
await page.mouse.up();
await page.waitForTimeout(250);
console.log('松开后   :', JSON.stringify(await snap()), '  ← 期望 文字=停止 / 灰底 / store=false');

console.log('PAGE ERRORS:', JSON.stringify(errs));
await browser.close();
