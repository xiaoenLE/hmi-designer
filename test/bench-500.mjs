// bench-500.mjs — 500 个控件时运行态的刷新开销基准（改前 / 改后对比）
// 用法：先起个 --no-auth 服务，再 node test/bench-500.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = `http://127.0.0.1:${process.argv[2] || '8903'}`;

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(400);

const built = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const pg = m.currentPage();
  m.data.variables.length = 0;
  pg.widgets.length = 0;
  const COLS = 25, CELL_W = 40, CELL_H = 28;
  for (let i = 0; i < 500; i++) {
    const name = 'v' + i;
    m.data.variables.push({ name, type: 'int', address: '%MW' + (i + 1), value: 0, len: 0 });
    pg.widgets.push({
      id: 'w' + i, type: 'number', name,
      x: (i % COLS) * CELL_W, y: Math.floor(i / COLS) * CELL_H,
      w: CELL_W - 2, h: CELL_H - 2, z: 10 + i,
      props: { fmt: '%d', dispType: 'int', editable: false, fontSize: 11 },
      bindings: { variable: name },
      actions: [],
    });
  }
  m.commit('bench');
  return { vars: m.data.variables.length, widgets: pg.widgets.length };
});
console.log('工程规模：', JSON.stringify(built));

const buildMs = await page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  const t0 = performance.now();
  await rt.enterRun();
  return Math.round(performance.now() - t0);
});
await page.waitForTimeout(600);
console.log('首屏进入运行态：', buildMs, 'ms   （渲染出', await page.evaluate(() => document.querySelectorAll('#rtPage .wd').length), '个控件）');

// ① 旧路径 vs 新路径：一次变量变化要做的「找控件」工作
const scan = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const reg = await import('/js/widgets/registry.js');
  const pages = m.pages();
  const N = 200;
  // 旧：所有页面 × 所有控件 全扫（每次还要 stateVarOf）
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    const name = 'v' + (k % 500);
    pages.forEach(pg => pg.widgets.forEach(w => {
      if (w.bindings?.variable !== name && reg.rutil.stateVarOf(w) !== name) return;
    }));
  }
  const oldMs = (performance.now() - t0) / N;
  return { oldMs: +oldMs.toFixed(4) };
});
console.log(`找控件（旧：全表扫）：${scan.oldMs} ms/次变量变化  →  500 个变量一起变约 ${(scan.oldMs * 500).toFixed(1)} ms`);

// ② 新路径：一次批次（500 个变量全变），取 8 次平均
const batch = await page.evaluate(async () => {
  const vm = await import('/js/runtime/varstore.js');
  const runs = [];
  for (let r = 0; r < 8; r++) {
    const obj = {};
    for (let i = 0; i < 500; i++) obj['v' + i] = r * 1000 + i;
    const t0 = performance.now();
    vm.varStore.applyRemote(obj);
    const t1 = performance.now();
    void document.getElementById('rtPage').offsetHeight;
    runs.push(t1 - t0);
  }
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  return { avg: +avg.toFixed(1), min: +Math.min(...runs).toFixed(1) };
});
console.log(`一批 500 个变量全变（含一次强制重排）：平均 ${batch.avg} ms / 最快 ${batch.min} ms`);

// ③ 单次变量变化（含 DOM 更新）
const single = await page.evaluate(async () => {
  const vm = await import('/js/runtime/varstore.js');
  const N = 200;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) vm.varStore.applyRemote({ v0: 100000 + k });
  return +((performance.now() - t0) / N).toFixed(4);
});
console.log('单个变量变化（含该控件重绘）：', single, 'ms/次');

// ④ 波形采样一拍的调度开销（每 50ms 一次）
const trend = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const pages = m.pages();
  const N = 100;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    // 旧写法：每次采样都把「所有页面的所有控件」flatMap + filter
    const list = pages.flatMap(p => p.widgets).filter(w => w.type === 'trend');
    void list.length;
  }
  const oldMs = (performance.now() - t0) / N;
  const t1 = performance.now();
  const tr = await import('/js/runtime/trend.js');
  for (let k = 0; k < N; k++) { void tr.allTrendWidgets().length; }
  const newMs = (performance.now() - t1) / N;
  return { oldMs: +oldMs.toFixed(4), newMs: +newMs.toFixed(4) };
});
console.log(`波形采样找控件：旧 ${trend.oldMs} ms/拍 → 新 ${trend.newMs} ms/拍（每秒跑 20 拍）`);

console.log('PAGE ERRORS:', JSON.stringify(errs));
await browser.close();
