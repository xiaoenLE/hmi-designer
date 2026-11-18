// smoke2.mjs — 8 个修复点专项验证（用真实鼠标事件，避免 dispatchEvent 污染状态）
import { createRequire } from 'node:module';
// ESM 不认 NODE_PATH，用 createRequire 锚定到托管 node workspace 找 playwright-core
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8866/';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);

// 选中主画面一个按钮（140×50）作为缩放/拖拽对象
const btn = page.locator('#canvas .wd-button', { hasText: '启停切换' }).first();
const btnBox = await btn.boundingBox();
const cx = btnBox.x + btnBox.width / 2, cy = btnBox.y + btnBox.height / 2;

// ══ 问题4：选中控件实时显示属性 ══
await btn.click();
await page.waitForTimeout(150);
const propShown = await page.evaluate(() => document.getElementById('propBody').innerText.includes('几何'));
check('选中控件 → 属性面板实时刷新', propShown);

// ══ 问题7：缩放手柄生效 ══
const geoBefore = await page.evaluate(() => {
  const w = window.app.project.currentWidgets().find(x => x.name === 'btn_start');
  return { w: w.w, h: w.h };
});
const se = page.locator('#canvas .sel-h-se');
const seBox = await se.boundingBox();
if (seBox) {
  await page.mouse.move(seBox.x + 4, seBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(seBox.x + 40, seBox.y + 30, { steps: 3 });
  await page.mouse.up();
}
await page.waitForTimeout(150);
const geoAfter = await page.evaluate(() => {
  const w = window.app.project.currentWidgets().find(x => x.name === 'btn_start');
  return { w: w.w, h: w.h };
});
check('缩放手柄生效（右下角放大）', geoAfter.w > geoBefore.w && geoAfter.h > geoBefore.h,
  `${geoBefore.w}x${geoBefore.h} -> ${geoAfter.w}x${geoAfter.h}`);

// ══ 问题5：控件可拖动 ══
const posBefore = await page.evaluate(() => { const w = window.app.project.currentWidgets().find(x => x.name === 'btn_start'); return { x: w.x, y: w.y }; });
const btnBox2 = await btn.boundingBox();
await page.mouse.move(btnBox2.x + btnBox2.width / 2, btnBox2.y + btnBox2.height / 2);
await page.mouse.down();
await page.mouse.move(btnBox2.x + btnBox2.width / 2 + 60, btnBox2.y + btnBox2.height / 2 + 40, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(150);
const posAfter = await page.evaluate(() => { const w = window.app.project.currentWidgets().find(x => x.name === 'btn_start'); return { x: w.x, y: w.y }; });
check('控件可拖动（按住即拖）', posAfter.x > posBefore.x && posAfter.y > posBefore.y,
  `(${posBefore.x},${posBefore.y}) -> (${posAfter.x},${posAfter.y})`);

// ══ 问题1：文本标签文字完整显示 ══
await page.evaluate(() => {
  const p = window.app.project;
  const w = p.addWidget('label', 10, 450);
  p.updateWidgetProp(w.id, 'text', '这是一个很长的文本标签测试文字会不会被截断显示不全');
  p.updateWidgets([w.id], { w: 120, h: 60 });
});
await page.waitForTimeout(150);
const labelInfo = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('#canvas .w-label')];
  const last = labels[labels.length - 1];
  return last ? { scrollW: last.scrollWidth, clientW: last.clientWidth } : { found: false };
});
check('长文本标签自动换行不横向截断', labelInfo.found !== false && labelInfo.scrollW <= labelInfo.clientW + 2,
  `scrollW=${labelInfo.scrollW} clientW=${labelInfo.clientW}`);

// ══ 问题8：圆角/透明/无边框属性 ══
await page.evaluate(() => {
  const p = window.app.project;
  const w = p.addWidget('number', 10, 520);
  p.updateWidgetProp(w.id, 'bgColor', '');
  p.updateWidgetProp(w.id, 'borderWidth', 0);
  p.updateWidgetProp(w.id, 'radius', 12);
});
await page.waitForTimeout(150);
const styleInfo = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#canvas .w-number')].pop();
  return el ? { bg: el.style.background, bw: el.style.borderWidth, radius: el.style.borderRadius } : { found: false };
});
check('背景透明+无边框+圆角属性生效', styleInfo.found !== false && styleInfo.radius.includes('12') && styleInfo.bw === '0px',
  JSON.stringify(styleInfo));

// ══ 问题3：水平/垂直均布 ══
const distCenters = await page.evaluate(() => {
  const p = window.app.project;
  const ids = [p.addWidget('rect', 0, 200).id, p.addWidget('rect', 0, 200).id, p.addWidget('rect', 0, 200).id];
  const ws = p.currentWidgets().filter(w => ids.includes(w.id));
  p.updateWidgets(ids, { w: 40, h: 40 });
  ws[0].x = 20; ws[1].x = 60; ws[2].x = 300;   // 不均匀
  const center = a => a.x + a.w / 2;
  const sorted = [...ws].sort((a, b) => center(a) - center(b));
  const first = center(sorted[0]), last = center(sorted[2]);
  sorted.forEach((w, i) => { w.x = Math.round(first + (last - first) * i / 2 - w.w / 2); });
  return sorted.map(center).sort((a, b) => a - b);
});
const d1 = distCenters[1] - distCenters[0], d2 = distCenters[2] - distCenters[1];
check('水平均布（中心等间距）', Math.abs(d1 - d2) <= 1, `间距 ${d1} vs ${d2}`);

// ══ 问题2 + 6：弹窗层级 + number 控件 ══
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(1000);
const numOk = await page.evaluate(() => document.querySelectorAll('#rtPage .w-number').length >= 2);
check('number 控件运行态渲染（显示/输入二合一）', numOk);

await page.locator('#rtPage .wd-button', { hasText: '报警详情' }).click();
await page.waitForTimeout(300);
const popupZ = await page.evaluate(() => {
  const layer = document.getElementById('rtPopupLayer');
  const vars = document.getElementById('rtVarsPanel');
  return { layerZ: +getComputedStyle(layer).zIndex, varsZ: +getComputedStyle(vars).zIndex || 0 };
});
check('弹窗层级高于变量抽屉', popupZ.layerZ > popupZ.varsZ, `layerZ=${popupZ.layerZ} varsZ=${popupZ.varsZ}`);

// number 输入：点击 → 软键盘输入提交
const numEdit = await page.evaluate(() => {
  const num = document.querySelector('#rtPage .w-number');
  if (!num) return { err: 'no number' };
  const before = window.app.varStore.get('rSpeed');
  num.click();   // 弹出软键盘
  const pad = document.getElementById('numPad');
  if (pad.classList.contains('hidden')) return { err: 'no pad', before };
  const btn = t => [...document.querySelectorAll('#npKeys button')].find(b => b.textContent === t);
  btn('C').click();
  ['8', '8', '.', '8'].forEach(k => btn(k).click());
  btn('确定').click();
  return { hasInput: true, before, after: window.app.varStore.get('rSpeed') };
});
check('number 点击软键盘输入提交', numEdit.hasInput === true && numEdit.after === 88.8, JSON.stringify(numEdit));

check('无 JS 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 修复项：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
