// verify-fit-narrow.mjs — 窗口**宽度不够**时（手机竖屏 / 窄窗口），运行画面要整幅等比例缩进窗内
//
// 现场问题（手机上看运行画面）：宽度不够时画面**没能整幅等比缩进去**，右边一截直接被切掉
//   （"后面不能正常显示"）。
// 根因：运行页 #rtPage 是 #runtimeRoot（flex 居中）里的**弹性子项**，宽度写死 1024 时
//   默认 flex-shrink:1 会把它**压扁到窗口宽**（1024 → 785），可内容仍按画布坐标摆 1024 宽
//   → 盒子上的 overflow:hidden 先把右边切掉，再整体 scale 一次，切掉的还是切掉的。
//   （applyRuntimeScale 算的是"画布尺寸 × 可用区域"，跟被压扁的盒子尺寸对不上。）
//
// 用法：node tools/run-suites.mjs verify-fit-narrow
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);

const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
const page = await ctx.newPage();
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.expectsServer = () => false;
  m.backend.readVars = async () => null;
  m.backend.syncVarTable = async () => false;
  m.backend.setPolling = async () => null;
  m.backend.startEvents = () => {};
  m.backend.loadAlarms = async () => [];
}));
await page.waitForFunction(() => window.app?.project?.data);

/* 画布 1024×600；四个角的控件都要能看全（右下角那个专门抓"被切掉"） */
const CANVAS = { W: 1024, H: 600 };
const ids = await page.evaluate(({ W, H }) => {
  const m = window.app.project;
  m.data.meta.canvas.w = W;
  m.data.meta.canvas.h = H;
  m.data.variables.length = 0;
  m.data.alarms.length = 0;
  m.data.variables.push({ name: 'bLamp', type: 'bool', address: '', value: true, len: 0 });
  const pg = m.data.pages[0];
  m.setCurrentPage(pg.id);
  pg.widgets.length = 0;
  const mk = (x, y, w, h) => {
    const t = m.addWidget('rect', x, y);
    m.updateWidgetField(t.id, 'w', w);
    m.updateWidgetField(t.id, 'h', h);
    return t.id;
  };
  const tl = mk(0, 0, 120, 60);
  const tr = mk(W - 150, 0, 150, 80);          // 右上角：贴右边
  const br = mk(W - 150, H - 90, 150, 90);     // 右下角：贴右下（最容易被切的那个）
  const bl = mk(0, H - 60, 120, 60);
  m.commit('缩放测试');
  return { tl, tr, br, bl, page: pg.id };
}, CANVAS);
await page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  await rt.enterRun();
  rt.hideRuntimeHint();
});
await sleep(300);

/** 量一份"画面到底在哪儿、被缩了多少" */
const geom = () => page.evaluate(({ W, H }) => {
  const rt = document.getElementById('rtPage');
  const cs = getComputedStyle(rt);
  const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) };
  };
  const q = (id) => rect(`#rtPage .wd[data-id="${id}"]`);
  const first = q(window.__ids.tl), right = q(window.__ids.tr), bottom = q(window.__ids.br);
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    // 布局盒子（没被 transform 影响的原始尺寸）—— 必须一直是画布尺寸
    boxW: rt.offsetWidth, boxH: rt.offsetHeight,
    canvasW: W, canvasH: H,
    scaleX: +m.a.toFixed(4), scaleY: +m.d.toFixed(4), tx: +m.e.toFixed(1),
    pageRect: rect('#rtPage'),
    tl: first, tr: right, br: bottom,
    mode: (window.app.__zoomMode || '') ,
  };
}, CANVAS);
const installIds = (idList) => page.evaluate(o => { window.__ids = o; }, idList);
await installIds({ tl: ids.tl, tr: ids.tr, br: ids.br });

/* ── 1. 窄窗口（手机竖屏 785×970，就是现场截图那个尺寸）── */
await page.setViewportSize({ width: 785, height: 970 });
await sleep(500);
let g = await geom();
ok('1 窄窗口：画面布局盒子仍是画布尺寸（没被 flex 压扁）',
  g.boxW === g.canvasW && g.boxH === g.canvasH, JSON.stringify([g.boxW, g.boxH, g.canvasW, g.canvasH]));
ok('1 窄窗口：等比缩放（scaleX === scaleY）',
  Math.abs(g.scaleX - g.scaleY) < 1e-3, JSON.stringify([g.scaleX, g.scaleY]));
ok('1 窄窗口：整幅都在窗口内（左/右/上/下都不越界）',
  g.pageRect.l >= -0.5 && g.pageRect.r <= g.vw + 0.5 && g.pageRect.t >= -0.5 && g.pageRect.b <= g.vh + 0.5,
  JSON.stringify([g.pageRect, g.vw, g.vh]));
ok('1 窄窗口：右下角那个控件完整可见（右边没被切掉）',
  !!g.br && g.br.r <= g.vw + 0.5 && g.br.b <= g.vh + 0.5 && g.br.l >= -0.5,
  JSON.stringify([g.br, g.vw, g.vh]));
ok('1 窄窗口：缩放比例 = min(可用宽/画布宽, 可用高/画布高)（按宽受限就是宽那一项）',
  Math.abs(g.scaleX - Math.min((g.vw - 24) / g.canvasW, (g.vh - 24) / g.canvasH)) < 0.01,
  JSON.stringify([g.scaleX, (g.vw - 24) / g.canvasW, (g.vh - 24) / g.canvasH]));

/* ── 2. 更窄（手机竖屏 360×640）：一样要整幅可见 ── */
await page.setViewportSize({ width: 360, height: 640 });
await sleep(500);
g = await geom();
ok('2 极窄窗口：等比 + 整幅可见 + 右下角控件没被切',
  Math.abs(g.scaleX - g.scaleY) < 1e-3 && g.br.r <= g.vw + 0.5 && g.br.b <= g.vh + 0.5
  && g.boxW === g.canvasW, JSON.stringify([g.scaleX, g.scaleY, g.br, g.vw, g.boxW]));

/* ── 3. 高度受限（横屏矮窗 1280×400）：按高受限，整幅仍要可见 ── */
await page.setViewportSize({ width: 1280, height: 400 });
await sleep(500);
g = await geom();
ok('3 矮窗口：按高受限等比缩、整幅可见',
  Math.abs(g.scaleX - g.scaleY) < 1e-3 && g.pageRect.b <= g.vh + 0.5 && g.pageRect.r <= g.vw + 0.5
  && Math.abs(g.scaleX - Math.min((g.vw - 24) / g.canvasW, (g.vh - 24) / g.canvasH)) < 0.01,
  JSON.stringify([g.scaleX, g.pageRect, g.vw, g.vh]));

/* ── 4. 换页 / 重新进运行态之后仍然是"盒子=画布尺寸"（别只在首屏对）── */
await page.setViewportSize({ width: 785, height: 970 });
await sleep(300);
await page.evaluate(async (pid) => {
  const rt = await import('/js/runtime/runtime.js');
  const m = window.app.project;
  const pg2 = m.addPage('page');
  m.commit('第二页');
  rt.gotoPage(pg2.id);
  await new Promise(r => setTimeout(r, 120));
  rt.gotoPage(pid);
}, ids.page);
await sleep(400);
g = await geom();
ok('4 换页回来：盒子还是画布尺寸、整幅仍在窗内',
  g.boxW === g.canvasW && g.boxH === g.canvasH && g.br.r <= g.vw + 0.5 && g.br.b <= g.vh + 0.5,
  JSON.stringify([g.boxW, g.boxH, g.br, g.vw, g.vh]));

/* ── 5. 「填满窗口」档：窄窗口下也不能有控件跑到窗外面去 ── */
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).setZoomMode('fill'));
await sleep(400);
g = await geom();
ok('5 填满窗口（窄窗）：页面上所有控件都还在窗内',
  g.pageRect.l >= -0.5 && g.pageRect.r <= g.vw + 0.5 && g.pageRect.t >= -0.5 && g.pageRect.b <= g.vh + 0.5,
  JSON.stringify([g.pageRect, g.vw, g.vh]));

/* ── 6.「原始尺寸」档：允许超出（自己滚/裁是这一档的语义），但别被 flex 压扁 ── */
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).setZoomMode('orig'));
await sleep(400);
g = await geom();
ok('6 原始尺寸档：1:1 不缩放，盒子仍是画布尺寸（宽窗口里整幅可见）',
  g.scaleX === 1 && g.scaleY === 1 && g.boxW === g.canvasW && g.boxH === g.canvasH,
  JSON.stringify([g.scaleX, g.scaleY, g.boxW, g.boxH]));

/* ── 7. 回到适应档 + 宽窗口：一切照旧（老行为回归）── */
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).setZoomMode('fit'));
await page.setViewportSize({ width: 1440, height: 900 });
await sleep(500);
g = await geom();
ok('7 宽窗口（1440×900）+ 适应档：等比、居中、整幅可见、比例仍是 1024/600',
  Math.abs(g.scaleX - g.scaleY) < 1e-3
  && Math.abs((g.pageRect.r - g.pageRect.l) / (g.pageRect.b - g.pageRect.t) - CANVAS.W / CANVAS.H) < 0.02
  && g.pageRect.l >= -0.5 && g.pageRect.r <= g.vw + 0.5,
  JSON.stringify([g.scaleX, g.pageRect]));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 窄窗口整幅显示（等比例缩放）：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
