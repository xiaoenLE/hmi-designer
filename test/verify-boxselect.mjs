// verify-boxselect.mjs — 画布框选：画布**外面**那一圈也能起框，往里框到的控件照样选中
//
// 现场要的：鼠标落在画布外的灰色区域按下、拖进画布把几个控件圈住 → 松手就都选中。
// 以前只能在画布内部的空白处按下才能拉框，想框画布边缘那几个控件得先精确点在画布里的空白上。
//
// ⚠ 起框点一定要落在**空白处**：压在控件上按下会变成"拖控件"（那是另一条路径，见 bindPointer）。
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => fetch('/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) }).catch(() => {}));
await page.waitForTimeout(300);

/* ── 摆 4 个控件：左上一对（A/B）、左下角一个（C）、右下远一点一个（D） ── */
const ids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const p = m.project;
  p.data.pages[0].widgets.length = 0;
  // 画布改小一点，保证四周留得下灰色区域（框选从画布外开始）
  p.data.meta.canvas.w = 620; p.data.meta.canvas.h = 420;
  const mk = (x, y, w, h, text) => {
    const k = p.addWidget('button', x, y);
    p.updateWidgetField(k.id, 'w', w); p.updateWidgetField(k.id, 'h', h);
    p.updateWidgetProp(k.id, 'text', text);
    return k.id;
  };
  const out = { a: mk(40, 40, 90, 50, 'A'), b: mk(150, 40, 90, 50, 'B'), c: mk(40, 240, 90, 50, 'C'), d: mk(480, 320, 90, 50, 'D') };
  p.commit('框选测试');
  return out;
});
await page.waitForTimeout(300);
// 适应窗口：画布缩到可见区里，四周就有灰色区域可下手了
await page.evaluate(async () => (await import('/js/editor/canvas.js')).zoomFit());
await page.waitForTimeout(300);

const geom = () => page.evaluate(async () => {
  const cv = document.getElementById('canvas').getBoundingClientRect();
  const wp = document.getElementById('canvasWrap').getBoundingClientRect();
  const z = (await import('/js/editor/canvas.js')).getZoom();
  const at = (x, y) => ({ x: cv.left + x * z, y: cv.top + y * z });   // 设计坐标 → 屏幕坐标
  return {
    cv: { left: cv.left, top: cv.top, right: cv.right, bottom: cv.bottom, w: cv.width, h: cv.height },
    wp: { left: wp.left, top: wp.top, right: wp.right, bottom: wp.bottom },
    z,
    empty: at(10, 10),          // 画布内左上角的空白（宽 30px 内没有控件）
    coverAB: at(250, 100),      // 框住 A+B（B 右边到 240）
    coverABC: at(250, 295),     // 框住 A+B+C（C 下边到 290）
    cornerA: at(45, 45),        // 只压住 A 的左上角
    gray: { x: cv.left - 12, y: cv.top + 10 },   // 画布左边那一圈灰色
  };
});
let G = await geom();
ok('画布外确实有灰色区域可以从那儿下手（测试前提）',
  G.gray.x > G.wp.left + 2 && G.cv.left > G.wp.left + 4, JSON.stringify([G.wp.left, G.cv.left]));

const selNow = () => page.evaluate(() => [...document.querySelectorAll('#canvas .wd.selected')].map(e => e.dataset.id));
const NAMES = () => ({ [ids.a]: 'A', [ids.b]: 'B', [ids.c]: 'C', [ids.d]: 'D' });
const names = async () => { const n = NAMES(); return (await selNow()).map(id => n[id] || '?').sort().join(''); };
const drag = async (from, to, steps = 8) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
};

/* ── A. 老行为：画布里面的空白处起框 ── */
await drag(G.empty, G.coverAB);
ok('画布内部起框（老行为）：框住 A、B → 都选中', await names() === 'AB', await names());

/* ── B. 新行为：从画布外的灰色区域按下，拖进画布框住控件 ── */
await page.mouse.click(G.gray.x, G.gray.y);          // 点画布外空白 → 清掉选择
await page.waitForTimeout(200);
ok('点画布外的空白 → 取消选择', (await selNow()).length === 0, JSON.stringify(await selNow()));

await drag(G.gray, G.coverAB);
ok('★ 从画布外的灰色区域起框、拖进画布框住 A+B → 正常选中', await names() === 'AB', await names());

/* ── C. 从画布外起框、一直框到画布里面（跨过整个画布） ── */
await drag(G.gray, G.coverABC);
ok('★ 从画布外一路框到画布中间 → A、B、C 都选中（远处的 D 不受影响）', await names() === 'ABC', await names());

/* ── D. 从画布外起框、也**在画布外松手**（拉出的框整个盖住画布） ── */
await drag({ x: G.gray.x, y: G.gray.y - 30 }, { x: G.cv.right + 20, y: G.cv.bottom + 20 });
ok('★ 从画布外起框到画布外松手（框整个盖住画布）→ 4 个控件全选中', await names() === 'ABCD', await names());

/* ── E. 框选时那个蓝色的框要看得见（画布外那一段也要画出来） ── */
await page.mouse.move(G.gray.x, G.gray.y + 20);
await page.mouse.down();
await page.mouse.move(G.gray.x - 6, G.gray.y + 20);
await page.mouse.move(G.cv.left + 60, G.cv.top + 60);
await page.waitForTimeout(150);
const box = await page.evaluate(() => {
  const b = document.querySelector('#canvas .box-select');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  const cv = document.getElementById('canvas').getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cvLeft: Math.round(cv.left) };
});
await page.mouse.up();
await page.waitForTimeout(150);
ok('拖的过程中画得出蓝框（.box-select 存在且尺寸正常）', box && box.w > 20 && box.h > 20, JSON.stringify(box));
ok('蓝框有一部分画在画布左边（画布外那一段没被裁掉）', box && box.left < box.cvLeft, JSON.stringify(box));

/* ── F. 画布外**单击**（没拖动）= 点空白 → 取消选择 ── */
await drag(G.empty, G.coverAB);
ok('先框住 A、B', await names() === 'AB', await names());
await page.mouse.click(G.gray.x, G.gray.y);
await page.waitForTimeout(200);
ok('在画布外的灰色区域点一下（没拖）→ 取消选择', (await selNow()).length === 0, JSON.stringify(await selNow()));

/* ── G. 缩放后照样准（设计坐标 → 屏幕坐标的换算不能错） ── */
await page.evaluate(async () => (await import('/js/editor/canvas.js')).setZoom(0.5));
await page.waitForTimeout(300);
G = await geom();
ok('缩放到 50%', Math.abs(G.z - 0.5) < 0.01, String(G.z));
await drag(G.gray, G.coverAB);
ok('★ 50% 缩放下从画布外框选 → 框住的还是 A+B（换算没错位）', await names() === 'AB', await names());
await page.evaluate(async () => (await import('/js/editor/canvas.js')).zoomFit());
await page.waitForTimeout(300);

/* ── H. 放大 + 滚动容器之后照样准 ── */
await page.evaluate(async () => (await import('/js/editor/canvas.js')).setZoom(1.6));   // 放大到要滚动
await page.waitForTimeout(250);
await page.evaluate(() => { const w = document.getElementById('canvasWrap'); w.scrollLeft = 60; w.scrollTop = 40; });
await page.waitForTimeout(250);
G = await geom();
const scrolled = await page.evaluate(() => ({ l: document.getElementById('canvasWrap').scrollLeft, t: document.getElementById('canvasWrap').scrollTop }));
// 放大后画布可能已经贴住容器边缘（没灰色了），那就从画布内部起框 —— 要验的是"换算准不准"
const from = G.cv.left - 6 > G.wp.left + 2 ? { x: G.cv.left - 6, y: G.cv.top + 8 } : { x: G.cv.left + 4, y: G.cv.top + 4 };
await drag(from, G.coverAB);
ok('★ 放大并滚动过画布容器之后，框选依然准（A+B）', await names() === 'AB', `${await names()} scroll=${JSON.stringify(scrolled)}`);
await page.evaluate(async () => (await import('/js/editor/canvas.js')).zoomFit());
await page.waitForTimeout(250);

/* ── I. 只碰到一点边也算框住（沿用原来的"相交即选中"） ── */
G = await geom();
await drag(G.empty, G.cornerA);
ok('框只压住 A 的一角 → A 选中（相交即选中，行为不变）', await names() === 'A', await names());

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 画布框选回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
