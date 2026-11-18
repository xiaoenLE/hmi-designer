// shot-input-range.mjs — 截图看「输入范围限制」长什么样（改样式/排版时用来自检）
//   out/range-1-pad.png      软键盘上显示范围（固定值）
//   out/range-2-over.png     输入越界：输入框变红 + 范围行标红 + 确定禁用
//   out/range-3-var.png      上下限跟着变量走（显示 变量名(值)）
//   out/range-4-panel.png    属性面板的「输入范围」那一栏（固定值 / 变量）
//   out/range-5-inline.png   没勾软键盘时的内联输入：越界变红
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8889';
installNodeFetchPatch(PORT);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null; m.backend.state = 'offline';
  m.backend.writeVar = async () => {}; m.backend.readVars = async () => null;
}));

const W = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  const V = (n, t, v) => m.data.variables.push({ name: n, type: t, address: '', value: v });
  V('Hr_LineSpd', 'real', 12.5); V('Hr_SpdMin', 'real', 0); V('Hr_SpdMax', 'real', 120);
  const pg = m.pages()[0]; pg.widgets.length = 0;
  const mk = (x, y, bind, props) => {
    const w = m.addWidget('number', x, y);
    w.bindings.variable = bind;
    Object.assign(w.props, props || {});
    w.name = '线速度设定';
    return w.id;
  };
  const out = {
    fixed: mk(40, 40, 'Hr_LineSpd', { rangeOn: true, rangeMinMode: 'fixed', rangeMinValue: '0', rangeMaxMode: 'fixed', rangeMaxValue: '100' }),
    byVar: mk(40, 110, 'Hr_LineSpd', { rangeOn: true, rangeMinMode: 'var', rangeMinVar: 'Hr_SpdMin', rangeMaxMode: 'var', rangeMaxVar: 'Hr_SpdMax' }),
    inline: mk(40, 180, 'Hr_LineSpd', { rangeOn: true, useKeyboard: false, rangeMaxMode: 'fixed', rangeMaxValue: '100' }),
  };
  m.commit('范围截图');
  return out;
});
await sleep(300);

/* 属性面板：输入范围那一栏（固定值 / 变量两种模式各来一张）。
   面板比屏幕长，「输入范围」在最下面 —— 先滚到底再截右栏 */
await page.click(`#canvas .wd[data-id="${W.byVar}"]`);
await sleep(400);
await page.evaluate(() => {
  const row = document.querySelector('#propBody input[data-prop="rangeOn"]');
  row?.closest('.prop-group')?.scrollIntoView({ block: 'end' });
});
await sleep(300);
await page.screenshot({ path: 'out/range-4-panel.png', clip: await page.evaluate(() => {
  const r = document.querySelector('#propBody').getBoundingClientRect();
  const body = document.querySelector('#propBody').closest('.panel-body').getBoundingClientRect();
  return { x: Math.max(0, body.x - 8), y: Math.max(0, body.y - 30), width: Math.min(1500, body.width + 16), height: Math.min(940, body.height + 36) };
}) });

await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(700);
const padBox = async () => {
  const b = await page.locator('#numPad').boundingBox();
  return { x: Math.max(0, b.x - 14), y: Math.max(0, b.y - 14), width: Math.min(1500, b.width + 28), height: Math.min(940, b.height + 28) };
};
const tap = async (k) => { await page.click(`#npKeys button[data-k="${k}"]`); await sleep(80); };

await page.click(`#rtPage .wd[data-id="${W.fixed}"]`);
await sleep(400);
await page.screenshot({ path: 'out/range-1-pad.png', clip: await padBox() });
// 连画面一起截：键盘弹出时别的控件被遮罩挡住（防误碰）
await page.screenshot({ path: 'out/range-6-mask.png' });
await tap('clear');
for (const c of '150') await tap(c);
await sleep(250);
await page.screenshot({ path: 'out/range-2-over.png', clip: await padBox() });
await tap('cancel');

await page.click(`#rtPage .wd[data-id="${W.byVar}"]`);
await sleep(400);
await page.screenshot({ path: 'out/range-3-var.png', clip: await padBox() });
await tap('cancel');

await page.click(`#rtPage .wd[data-id="${W.inline}"]`);
await sleep(300);
await page.fill(`#rtPage .wd[data-id="${W.inline}"] input`, '150');
await sleep(250);
await page.screenshot({ path: 'out/range-5-inline.png' });

console.log('截图完成：out/range-*.png');
await browser.close();
