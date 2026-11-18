// verify-canvas-zoom.mjs — 编辑画布鼠标缩放：Ctrl+滚轮 / 快捷键 / 按钮 / 缩放后坐标换算
// 用法：先启动 8866 服务，再 node test/verify-canvas-zoom.mjs [端口]
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;
installNodeFetchPatch(URL);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

const zoomOf = () => page.evaluate(() => Number(document.getElementById('canvas').style.zoom || 1));
const canvasRect = () => page.evaluate(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
async function boot() {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.waitForTimeout(250);
}
/** notches > 0 = 向上滚 = 放大；< 0 = 向下滚 = 缩小 */
async function wheelZoom(notches, anchor) {
  const box = await page.locator('#canvasWrap').boundingBox();
  const ax = anchor?.x ?? box.x + box.width / 2;
  const ay = anchor?.y ?? box.y + box.height / 2;
  await page.mouse.move(ax, ay);
  await page.keyboard.down('Control');
  for (let i = 0; i < Math.abs(notches); i++) await page.mouse.wheel(0, notches > 0 ? -120 : 120);
  await page.keyboard.up('Control');
  await page.waitForTimeout(200);
  return { ax, ay };
}

/* ══════ 0. 默认 100%，且画布尺寸等于设计尺寸 ══════ */
await boot();
const base = { zoom: await zoomOf(), rect: await canvasRect(),
  canvas: await page.evaluate(() => ({ ...window.app.project.data.meta.canvas })) };
ok('默认缩放 100%', base.zoom === 1, `${base.zoom}`);
ok('100% 时画布尺寸 = 设计尺寸', Math.abs(base.rect.w - base.canvas.w) < 1 && Math.abs(base.rect.h - base.canvas.h) < 1,
  `${base.rect.w}x${base.rect.h} vs ${base.canvas.w}x${base.canvas.h}`);

/* ══════ 1. Ctrl+滚轮放大 / 缩小 ══════ */
const a1 = await wheelZoom(3);                        // 向上滚 3 格 = 放大
const zIn = await zoomOf();
const rIn = await canvasRect();
ok('Ctrl+滚轮向上放大', zIn > 1.2, `zoom=${zIn}`);
ok('画布视觉尺寸随缩放变化', Math.abs(rIn.w - base.canvas.w * zIn) < 2, `${rIn.w.toFixed(0)} ≈ ${(base.canvas.w * zIn).toFixed(0)}`);
ok('工具条上的百分比同步', (await page.textContent('#zoomLabel')) === Math.round(zIn * 100) + '%',
  await page.textContent('#zoomLabel'));
await wheelZoom(-3);                                   // 向下滚 3 格 = 缩小
ok('Ctrl+滚轮向下缩小', (await zoomOf()) < zIn, `${zIn} → ${await zoomOf()}`);

/* ══════ 2. 以鼠标为锚点：指针下的画布位置不动 ══════
   （画布比视口小的那个方向是 margin:auto 居中的，滚动条管不着，所以先放大到两个方向都超出视口） */
await boot();
await page.evaluate(() => window.app.setZoom(1.6));
await page.waitForTimeout(200);
const anchor = await (async () => {
  const box = await page.locator('#canvasWrap').boundingBox();
  return { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 };
})();
const designBefore = await (async () => {
  const r = await canvasRect(); const z = await zoomOf();
  return { x: (anchor.x - r.x) / z, y: (anchor.y - r.y) / z };
})();
await wheelZoom(2, anchor);
const designAfter = await (async () => {
  const r = await canvasRect(); const z = await zoomOf();
  return { x: (anchor.x - r.x) / z, y: (anchor.y - r.y) / z };
})();
ok('缩放锚定在鼠标位置（指针下的画布点不跑）',
  Math.abs(designAfter.x - designBefore.x) < 3 && Math.abs(designAfter.y - designBefore.y) < 3,
  `设计坐标 (${designBefore.x.toFixed(0)},${designBefore.y.toFixed(0)}) → (${designAfter.x.toFixed(0)},${designAfter.y.toFixed(0)})`);

/* ══════ 3. 缩放后拖动控件：位移必须换算回设计坐标 ══════ */
const wid = await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('rect', 100, 100);
  w.w = 120; w.h = 80;
  pr.commit('缩放测试'); return w.id;
});
await page.evaluate(id => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, wid);
await page.waitForTimeout(200);
const before = await page.evaluate(id => { const w = window.app.project.getWidget(id); return { x: w.x, y: w.y }; }, wid);
const el = await page.locator(`#canvas .wd[data-id="${wid}"]`).boundingBox();
await page.mouse.move(el.x + el.width / 2, el.y + el.height / 2);
await page.mouse.down();
await page.mouse.move(el.x + el.width / 2 + 200, el.y + el.height / 2 + 100, { steps: 6 });   // 屏幕移动 200/100
await page.mouse.up();
await page.waitForTimeout(200);
const zoomNow = await zoomOf();
const after = await page.evaluate(id => { const w = window.app.project.getWidget(id); return { x: w.x, y: w.y }; }, wid);
const expectX = 200 / zoomNow, expectY = 100 / zoomNow;
ok('缩放状态下拖动 200/100 屏幕像素 = 200/z,100/z 设计像素',
  Math.abs((after.x - before.x) - expectX) <= 5 && Math.abs((after.y - before.y) - expectY) <= 5,
  `zoom=${zoomNow.toFixed(2)} 实际位移 ${after.x - before.x}/${after.y - before.y}，期望≈${expectX.toFixed(0)}/${expectY.toFixed(0)}`);

/* ══════ 4. 缩放后从工具箱拖新控件：落点也要换算 ══════ */
const dropAt = await (async () => {
  const r = await canvasRect(); const z = await zoomOf();
  const wrap = await page.locator('#canvasWrap').boundingBox();
  return { x: Math.min(wrap.x + wrap.width - 40, r.x + 400 * z), y: Math.min(wrap.y + wrap.height - 40, r.y + 300 * z), z, rx: r.x, ry: r.y };
})();
const nBefore = await page.evaluate(() => window.app.project.currentWidgets().length);
await page.locator('.tb-item', { hasText: '圆形' }).first().dragTo(page.locator('#canvasWrap'), {
  targetPosition: { x: dropAt.x - (await page.locator('#canvasWrap').boundingBox()).x, y: dropAt.y - (await page.locator('#canvasWrap').boundingBox()).y },
});
await page.waitForTimeout(250);
const dropped = await page.evaluate(() => {
  const ws = window.app.project.currentWidgets();
  const w = ws[ws.length - 1];
  return { n: ws.length, x: w.x, y: w.y, type: w.type };
});
const expDrop = { x: Math.round((dropAt.x - dropAt.rx) / dropAt.z / 5) * 5, y: Math.round((dropAt.y - dropAt.ry) / dropAt.z / 5) * 5 };
ok('缩放状态下拖放创建控件落在指针处（按设计坐标）',
  dropped.n === nBefore + 1 && Math.abs(dropped.x + 40 - expDrop.x) <= 12 && Math.abs(dropped.y + 40 - expDrop.y) <= 12,
  `zone=${dropAt.z.toFixed(2)} 落点设计坐标 ${dropped.x}/${dropped.y}（控件中心 ${dropped.x + 40}/${dropped.y + 40}，期望 ${expDrop.x}/${expDrop.y}）`);

/* ══════ 5. 快捷键与按钮 ══════ */
await boot();
await page.keyboard.press('Control+0');               // 先归位，后面的断言不受上一步残留影响
await page.waitForTimeout(150);
const z0 = await zoomOf();
await page.keyboard.press('Control+=');
await page.waitForTimeout(150);
const zKeyIn = await zoomOf();
await page.keyboard.press('Control+-');
await page.waitForTimeout(150);
const zKeyOut = await zoomOf();
ok('Ctrl+= 放大 / Ctrl+- 缩小', zKeyIn > z0 * 1.2 && zKeyOut < zKeyIn, `${z0} → ${zKeyIn} → ${zKeyOut}`);
await page.keyboard.press('Control+0');
await page.waitForTimeout(150);
ok('Ctrl+0 回到 100%', (await zoomOf()) === 1, String(await zoomOf()));
await page.click('#btnZoomIn');
await page.click('#btnZoomIn');
await page.waitForTimeout(150);
const zBtn = await zoomOf();
await page.click('#zoomLabel');
await page.waitForTimeout(150);
ok('＋按钮放大 / 点百分比归位', zBtn > 1.4 && (await zoomOf()) === 1, `${zBtn} → ${await zoomOf()}`);

/* ══════ 6. 适应窗口 ══════ */
await page.click('#btnZoomFit');
await page.waitForTimeout(250);
const fit = await page.evaluate(() => {
  const w = document.getElementById('canvasWrap').getBoundingClientRect();
  const c = document.getElementById('canvas').getBoundingClientRect();
  return { zw: w.width, zh: w.height, cw: c.width, ch: c.height, zoom: Number(document.getElementById('canvas').style.zoom || 1) };
});
ok('「适应」把整页缩放进可见区域', fit.cw <= fit.zw + 1 && fit.ch <= fit.zh + 1 && fit.zoom < 1,
  `画布 ${fit.cw.toFixed(0)}x${fit.ch.toFixed(0)} / 视口 ${fit.zw.toFixed(0)}x${fit.zh.toFixed(0)} zoom=${fit.zoom}`);

/* ══════ 7. 手动放大到超出视口：左上角仍可滚动到达 ══════ */
await page.evaluate(() => { window.app.setZoom(3); });
await page.evaluate(() => {
  const wrap = document.getElementById('canvasWrap');
  wrap.scrollLeft = 0; wrap.scrollTop = 0;
});
await page.waitForTimeout(200);
const reach = await page.evaluate(() => {
  const wrap = document.getElementById('canvasWrap').getBoundingClientRect();
  const c = document.getElementById('canvas').getBoundingClientRect();
  return { dx: Math.round(c.x - wrap.x), dy: Math.round(c.y - wrap.y),
    canScroll: document.getElementById('canvasWrap').scrollWidth > document.getElementById('canvasWrap').clientWidth };
});
ok('放大超出视口后左上角仍可见可滚（不会被居中裁掉）', reach.dx <= 1 && reach.dy <= 1 && reach.canScroll,
  `偏移 ${reach.dx},${reach.dy} 可横向滚动=${reach.canScroll}`);

/* ══════ 8. 缩放选择记忆 + 不影响运行态 ══════ */
await page.evaluate(() => { window.app.setZoom(1.6); });
await page.waitForTimeout(150);
await boot();
ok('缩放比例刷新后保持', Math.abs((await zoomOf()) - 1.6) < 0.01, String(await zoomOf()));
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(500);
const rt = await page.evaluate(() => {
  const r = document.getElementById('rtPage').getBoundingClientRect();
  const c = window.app.project.data.meta.canvas;
  return { w: Math.round(r.width), h: Math.round(r.height), cw: c.w };
});
ok('运行态不受编辑缩放影响（走自己的适应窗口）', rt.w !== Math.round(1024 * 1.6) && rt.w > 0, `${rt.w}x${rt.h}`);
await page.evaluate(() => window.app.exitRun());

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 画布缩放回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
