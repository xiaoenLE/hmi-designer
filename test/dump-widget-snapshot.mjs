// dump-widget-snapshot.mjs — 把**运行中的控件库**整份 dump 成 JSON（拆分/重构前后各跑一次，diff 一致 = 行为零变化）
//
// 为什么不只看 extract-catalog：那个只静态读 `register({...})` 的**声明字段**，
// 读不到 render 里用到的东西。这份快照会把每个控件的 render **真的跑一遍**
// （编辑态 + 运行态，给一份假变量值），所以少 import 一个 helper 这种错当场就露出来。
//
// 用法：
//   node test/dump-widget-snapshot.mjs                        → test/golden-widgets.json
//   node test/dump-widget-snapshot.mjs test/a.json            → 指定输出
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const OUT = path.resolve(ROOT, process.argv[2] || 'test/golden-widgets.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-dump-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
// **冻结时间**：时钟控件显示"现在"、报警演示数据用 Date.now() 造相对时间 ——
// 不冻的话前后两次快照必然差几秒，diff 就永远"有差异"，等于白做。
await page.addInitScript(() => {
  const FIXED = 1759500000000;              // 2025-10-03 固定住，纯粹为了可比
  const Real = Date;
  class Frozen extends Real {
    constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
    static now() { return FIXED; }
  }
  globalThis.Date = Frozen;
});
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(300);

const snapshot = await page.evaluate(async () => {
  const { registry } = await import('/js/widgets/registry.js');
  const { renderWidgetDOM } = await import('/js/widgets/registry.js');
  // 假变量值：数值/字符串/bool 都给一份，render 里怎么取都不会 undefined
  const vals = new Map([['vDummy', 12], ['vDummy2', 3.5], ['vDummy3', true], ['sDummy', 'abc']]);
  const vars = { get: (n) => vals.get(n), has: (n) => vals.has(n) };

  const out = [];
  for (const def of registry.list()) {
    const { w: dw, h: dh, ...propDefs } = def.defaults || {};
    const mk = () => ({
      id: 'wDump', type: def.type, name: 'dump',
      x: 0, y: 0, w: dw ?? 100, h: dh ?? 40, z: 1,
      props: JSON.parse(JSON.stringify(propDefs)),
      bindings: { variable: 'vDummy', variables: ['vDummy', 'vDummy2'] },
      actions: (def.actions || []).slice(0, 1).map(t => ({ trigger: 'click', type: t, params: { variable: 'vDummy', page: '' } })),
    });
    const rec = {
      type: def.type, title: def.title, sub: def.sub || '',
      hidden: !!def.hidden, defaultBind: !!def.defaultBind, selfDrawn: !!def.selfDrawn,
      defaultW: dw ?? null, defaultH: dh ?? null,
      defaults: JSON.parse(JSON.stringify(propDefs)),
      props: JSON.parse(JSON.stringify(def.props || [])),
      binding: JSON.parse(JSON.stringify(def.binding || {})),
      actions: (def.actions || []).slice(),
      iconLen: String(def.icon || '').length,
      render: {},
    };
    for (const mode of ['edit', 'run']) {
      try {
        const el = renderWidgetDOM(mk(), mode, vars);
        rec.render[mode] = { ok: true, html: el.innerHTML };
      } catch (e) {
        rec.render[mode] = { ok: false, err: String(e && e.message || e) };
      }
    }
    out.push(rec);
  }
  return { order: registry.list().map(d => d.type), widgets: out };
});

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2), 'utf8');
const bad = snapshot.widgets.filter(w => !w.render.edit.ok || !w.render.run.ok);
console.log(`控件数 ${snapshot.widgets.length} · 顺序 ${snapshot.order.join(',')}`);
console.log(`render 报错：${bad.length ? bad.map(b => `${b.type}(${b.render.edit.err || b.render.run.err})`).join(' / ') : '无'}`);
console.log(`页面错误：${errs.length ? errs.join(' | ') : '无'}`);
console.log(`→ ${OUT}`);
if (bad.length || errs.length) process.exit(1);
