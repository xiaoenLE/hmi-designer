// verify-widget-split.mjs — **控件库拆分**（defs.js → defs/ 一控件一文件）的回归护栏
//
// 为什么要有这个套件：控件定义拆成 16 个文件之后，"改一个控件"很容易顺手改坏别的
// （少 import 一个 helper、注册顺序挪了、薄壳不再转出…），而且这些错**只有渲染时才炸**。
// 所以这里守四件事：
//   ① 控件库和基线（test/golden-widgets.json）**逐字节一致** —— 声明字段 + 编辑/运行两态 render 输出
//   ② 每个控件的 render 在 edit / run 两态都能跑通（少 import 当场暴露）
//   ③ 结构约定：一控件一文件（每个 type 在 defs/ 下有同名文件）、defs.js 薄壳照样转出老接口
//   ④ MCP 的静态提取器（hmi-mcp/tools/extract-catalog.mjs）扫目录的结果 == 运行中的真注册表
//      —— 拆文件最容易连带搞坏的就是它（它以前只认 defs.js 一个文件）
//
// 用法：node test/verify-widget-split.mjs
//       node test/verify-widget-split.mjs --update   （确认改动是有意的，就重建基线）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GOLDEN = path.join(HERE, 'golden-widgets.json');
const UPDATE = process.argv.includes('--update');

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* ── ③-a 结构约定：一控件一文件（纯文件系统检查，不需要浏览器） ── */
const DEFDIR = path.join(ROOT, 'js', 'widgets', 'defs');
const allDefFiles = fs.existsSync(DEFDIR) ? fs.readdirSync(DEFDIR).filter(f => f.endsWith('.js') && f !== 'index.js') : [];
const readDef = (f) => fs.readFileSync(path.join(DEFDIR, f), 'utf8');
// 「控件文件」= 里面有 register( 的；alarmShared.js 这种是共享 helper，不算控件
const widgetFiles = allDefFiles.filter(f => /^\s*register\(/m.test(readDef(f)));
const helperFiles = allDefFiles.filter(f => !widgetFiles.includes(f));
const shell = fs.readFileSync(path.join(ROOT, 'js', 'widgets', 'defs.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(DEFDIR, 'index.js'), 'utf8');
const indexImports = [...indexSrc.matchAll(/^import '\.\/([\w.-]+\.js)';/gm)].map(m => m[1]);
// ⚠ 这里**不写死控件个数** —— 加一个控件是正常开发动作，不该让护栏"失败"。
//   守着的是结构约定：一控件一文件、文件名=type、index 里每个都 import 了、helper 不被当控件。
ok('defs/ 里一控件一文件（控件文件 + 共享 helper）',
  widgetFiles.length >= 16 && widgetFiles.length + helperFiles.length === allDefFiles.length,
  `控件 ${widgetFiles.length} 个 + helper ${helperFiles.length} 个（${helperFiles.join(',')}）`);
ok('defs/index.js 每个控件各 import 一行，且一个不漏',
  indexImports.length === widgetFiles.length && widgetFiles.every(f => indexImports.includes(f)),
  `${indexImports.length} 行 / 控件 ${widgetFiles.length} 个`);
ok('共享 helper 不被 index.js 当控件 import（由用它的控件自己 import）',
  helperFiles.every(f => !indexImports.includes(f)), helperFiles.join(','));
ok('每个控件文件名 = 它的 type', widgetFiles.every(f => new RegExp(`type:\\s*'${f.replace(/\.js$/, '')}'`).test(readDef(f))));
ok('defs.js 是薄壳（不再直接堆 register）', !/^\s*register\(/m.test(shell) && /defs\/index\.js/.test(shell));
for (const name of ['registry', 'register', 'ACTION_DEFS', 'renderWidgetDOM', 'refreshWidgetBody', 'rutil']) {
  ok(`defs.js 照样转出 ${name}（老路径/老测试不破）`, new RegExp(`\\b${name}\\b`).test(shell));
}

/* ── 起后端 + 浏览器 ── */
const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-split-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
// 和 dump-widget-snapshot.mjs 用**同一个冻结时间**，否则时钟/报警演示数据每次都差几秒，基线永远对不上
await page.addInitScript(() => {
  const FIXED = 1759500000000;
  const Real = Date;
  class Frozen extends Real {
    constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
    static now() { return FIXED; }
  }
  globalThis.Date = Frozen;
});
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(300);

/* ── ② 每个控件两态渲染 + 拿运行中的真注册表 ── */
const snap = await page.evaluate(async () => {
  const { registry, renderWidgetDOM } = await import('/js/widgets/registry.js');
  const vals = new Map([['vDummy', 12], ['vDummy2', 3.5], ['vDummy3', true], ['sDummy', 'abc']]);
  const vars = { get: (n) => vals.get(n), has: (n) => vals.has(n) };
  const out = [];
  for (const def of registry.list()) {
    const { w: dw, h: dh, ...propDefs } = def.defaults || {};
    const mk = () => ({
      id: 'wDump', type: def.type, name: 'dump', x: 0, y: 0, w: dw ?? 100, h: dh ?? 40, z: 1,
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
      try { rec.render[mode] = { ok: true, html: renderWidgetDOM(mk(), mode, vars).innerHTML }; }
      catch (e) { rec.render[mode] = { ok: false, err: String(e && e.message || e) }; }
    }
    out.push(rec);
  }
  return { order: registry.list().map(d => d.type), widgets: out };
});

const live = snap.widgets;
// 隐藏兼容控件不出现在工具箱，旧工程仍要能读取它们的定义。
const hidden = live.filter(w => w.hidden).map(w => w.type).sort();
ok('隐藏兼容控件 barcode / value / input 仍在注册表里',
  hidden.join(',') === 'barcode,input,value', `隐藏：${hidden.join(',') || '（无）'}`);
ok('可见控件数 = 总数 - 隐藏数', live.filter(w => !w.hidden).length === live.length - hidden.length,
  `共 ${live.length} 个（可见 ${live.length - hidden.length}）`);
const renderBad = live.filter(w => !w.render.edit.ok || !w.render.run.ok);
ok('每个控件的 render 在编辑态/运行态都跑通', renderBad.length === 0,
  renderBad.map(b => `${b.type}: ${b.render.edit.err || b.render.run.err}`).join(' / '));
ok('浏览器无页面错误（模块加载/少 import 会在这里露）', errs.length === 0, errs.slice(0, 3).join(' | '));

/* ── ① 与基线逐字节一致 ── */
if (UPDATE || !fs.existsSync(GOLDEN)) {
  fs.writeFileSync(GOLDEN, JSON.stringify(snap, null, 2), 'utf8');
  console.log(`（已重建基线 ${path.relative(ROOT, GOLDEN)} ← 本次运行的控件库）`);
} else {
  const base = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const A = JSON.stringify(base, null, 1).split('\n');
  const B = JSON.stringify(snap, null, 1).split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) diff.push(`行${i + 1}\n  基线: ${A[i]}\n  现在: ${B[i]}`);
  ok('控件库与基线逐字节一致（声明字段 + 两态 render 输出）', diff.length === 0, diff.length ? diff.slice(0, 3).join('\n') : '');
  if (diff.length) {
    console.log('  （如果改动是有意的：node test/verify-widget-split.mjs --update 重建基线）');
  }
}

/* ── ④ MCP 静态提取器 vs 运行中注册表 ──
   两边都走**提取器自己的通道**（静态 parseDefs / 在线 parseLive），这样过滤口径一致
   （uiOnly 的属性两边都该滤掉）—— 拿原始 registry.props 去比会差在 uiOnly 上，那是比法不对 */
try {
  const mcp = await import('file:///' + path.resolve(ROOT, '..', 'hmi-mcp', 'tools', 'extract-catalog.mjs').replace(/\\/g, '/'));
  const statics = mcp.parseDefs(DEFDIR);
  const r = await mcp.parseLive(H);
  if (r.error) {
    ok('MCP 在线提取（parseLive /run）', false, r.error);
  } else {
    const problems = mcp.diffCatalogs(statics, r.widgets);
    ok('MCP 静态提取（扫 defs/ 目录）== 在线（运行中注册表）', problems.length === 0, problems.slice(0, 4).join(' / '));
    ok('提取出来的控件定义带 file 字段（AI 知道去哪儿改）', statics.every(w => /defs\/[\w.-]+\.js$/.test(w.file || '')));
    // 顺带盯住那个曾经被静默吞掉的跨文件常量：TIME_PRESETS 必须真的展开成选项数组
    const clockFmt = statics.find(w => w.type === 'clock')?.props.find(p => p.key === 'timeFmt');
    ok('跨文件常量 TIME_PRESETS 展开成选项（曾经是空/字符串）',
      Array.isArray(clockFmt?.options) && clockFmt.options.some(o => o.v === 'custom'), JSON.stringify(clockFmt?.options?.length ?? clockFmt?.options));
  }
} catch (e) {
  ok('MCP 静态提取器可导入并解析 defs/ 目录', false, String(e.message));
}

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

const bad = results.filter(r => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
