// verify-sse-batch.mjs — 后端「一批变化合成一条推送」这条前端路径要能吃
//   后端在 server.py / opcua.py 的轮询回调里把一批变化合成 {"vars":{…}} 一条消息
//   （500 个变量一起变时省掉 499 次 JSON.parse + 事件派发）。
//   这里用假的 EventSource 把两种格式都喂一遍，验前端都认、控件都能跟着变。
//
// ⚠ 本套件测的是**退回 SSE** 那条路（旧后端 / 长连接没连上时用的）。
//   前端现在首选 WebSocket 长连接：不禁用的话真长连接一连上，这里的假 EventSource
//   根本不会被创建（__fakeES 是 undefined），全部断言都会失败 —— 那是测法的问题，不是功能坏了。
//   所以下面显式把长连接关掉，只留 SSE。长连接自己那条路（含同一个 {"vars":{…}} 批量帧）
//   由 verify-ws-browser.mjs 覆盖。
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8903';

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(300);

// 强制走退回模式：本套件验的就是这条兜底路径
await page.evaluate(async () => {
  const m = await import('/js/api/backend.js');
  m.backend._ensureChannel = () => null;     // 永远不建长连接
});

// 假 EventSource：把实例抓出来，自己喂消息
await page.evaluate(() => {
  class FakeES {
    constructor(url) { this.url = url; globalThis.__fakeES = this; this.readyState = 0; }
    close() { this.readyState = 2; }
  }
  globalThis.EventSource = FakeES;
});

const ids = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  ['n1', 'n2', 'n3'].forEach((n, i) => m.data.variables.push({ name: n, type: 'int', address: '%MW' + i, value: 0, len: 0 }));
  m.currentPage().widgets.length = 0;
  const mk = (name, x) => {
    const w = m.addWidget('number', x);
    m.updateWidgetField(w.id, 'bindings.variable', name);
    return w.id;
  };
  const out = { a: mk('n1', 20), b: mk('n2', 200), c: mk('n3', 380), free: mk('', 560) };
  m.commit('t');
  return out;
});
await page.waitForTimeout(150);
await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).enterRun(); });
await page.waitForTimeout(400);

// 数值控件默认按 1 位小数显示（222 → "222.0"），所以比较数值
const val = async (id) => Number(await page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .wn-val`);
  return el ? el.textContent : 'NaN';
}, id));
const feed = (payload) => page.evaluate((payload) => {
  const es = globalThis.__fakeES;
  if (!es || !es.onmessage) return false;
  es.onmessage({ data: JSON.stringify(payload) });
  return true;
}, payload);

ok('运行态已接上推送（假 EventSource 拿到了 onmessage）', (await feed({ name: 'n1', value: 0 })) === true);

// 1) 老格式：一条一个变量
await feed({ name: 'n1', value: 11 });
await page.waitForTimeout(60);
ok('单条格式 {"name","value"} 照旧能刷新', (await val(ids.a)) === 11, String(await val(ids.a)));

// 2) 新格式：一批变化合成一条
await feed({ vars: { n2: 222, n3: 333 } });
await page.waitForTimeout(60);
const vb = await val(ids.b), vc = await val(ids.c);
ok('批量格式 {"vars":{…}} 一条能刷多个控件', vb === 222 && vc === 333, `${vb} / ${vc}`);

// 3) 没绑变量的控件不该被影响
const freeBefore = await val(ids.free);
await feed({ vars: { n1: 44, n2: 55 } });
await page.waitForTimeout(60);
const aNow = await val(ids.a), freeNow = await val(ids.free);
ok('批量刷新只动绑了的控件（没绑的原样）',
  Number.isNaN(freeNow) && Number.isNaN(freeBefore) || freeNow === freeBefore, `free=${freeNow} n1=${aNow}`);
ok('批量里的变量都刷新了', aNow === 44, String(aNow));

// 4) 空/坏帧不炸
await feed({});
await feed({ vars: {} });
await page.waitForTimeout(50);
ok('空对象 / 空批量不报错', errs.length === 0, errs.slice(0, 2).join(' | '));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

const fails = results.filter(r => !r.ok).length;
console.log(`\n==== SSE 批量推送：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
