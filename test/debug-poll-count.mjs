// 实测：同一个变量被一堆控件引用时，后端到底采几次
// 1) 前端按页收集变量名（Set 去重）→ 2) 后端按块读 → 看 /api/plc 的 active / blocks / reads
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '8907';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

// 造页：30 个控件绑同一个 %MW100，另外两个变量各 1 个控件，再放一个没人用的
const info = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  const V = (n, a) => ({ name: n, type: 'int', address: a, value: 0, len: 0 });
  m.data.variables.push(V('same', '%MW100'), V('near', '%MW102'), V('far', '%MW110'), V('unused', '%MW300'));
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  for (let i = 0; i < 30; i++) {
    const w = m.addWidget('number', 20 + (i % 6) * 60, 20 + Math.floor(i / 6) * 40);
    w.bindings.variable = 'same';
  }
  const w2 = m.addWidget('number', 400, 20); w2.bindings.variable = 'near';
  const w3 = m.addWidget('number', 400, 60); w3.bindings.variable = 'far';
  m.commit('轮询实验');
  return { widgets: pg.widgets.length };
});
console.log(`页面：${info.widgets} 个控件（30 个绑 same，各 1 个绑 near/far），变量表 4 个（unused 没人用）`);

// 连上模拟器（Modbus），进运行态
const st0 = await page.evaluate(() => import('/js/api/backend.js').then(m => m.backend.probe()).then(() => 'ok'));
await sleep(500);
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(2500);

const s1 = await page.evaluate(async () => {
  const m = await import('/js/api/backend.js');
  const j = await m.backend.getPlc();
  return { status: j.status, scope: m.backend.scope };
});
const s = s1.status || {};
console.log(`进运行态：mode=${s.mode} protocol=${s.protocol} 变量表=${s.vars} 本页采集(active)=${s.active} 读块(blocks)=${s.blocks} 累计读=${s.reads} 错=${s.errors}`);
console.log(`前端报的采集范围：${JSON.stringify(s1.scope)}`);

// 等 2 秒，看累计读次数增长（一个轮询周期读几次）
await sleep(2000);
const s2 = await page.evaluate(async () => (await (await import('/js/api/backend.js')).backend.getPlc()).status);
console.log(`2 秒后：累计读=${s2.reads}（轮询周期 ${s2.poll_ms ?? '?'}ms → 每轮 ${s2.blocks} 次读）`);

// 切到没变量的页面 → 采集范围应该清空
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const p = m.addPage();
  m.setCurrentPage(p.id);
});
await sleep(1200);
const s3 = await page.evaluate(async () => (await (await import('/js/api/backend.js')).backend.getPlc()).status);
console.log(`换到空页面：本页采集=${s3.active} 读块=${s3.blocks}`);
await browser.close();
