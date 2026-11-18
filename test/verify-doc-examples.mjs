// verify-doc-examples.mjs — **把 docs/add-widget.md 里的 json 例子全部抽出来真跑一遍**
//
// 为什么要有这个：文档里的例子是给人复制粘贴用的，一旦写错（少逗号、renderSrc 转义错、
// props 没写全），用户照抄就会踩坑，而文档自己不会报错。所以让测试盯着它：
//   ① 每个 ```json 块必须是**合法 JSON**（能 parse）
//   ② 其中"完整控件包"（有 kind:widgets + widgets）必须**真的能导进一份干净工程**
//      并且在画布上渲染出来（自定义控件的 defs 也要注册成功、冒烟渲染通过）
//
// 用法：node test/verify-doc-examples.mjs
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
const DOC = path.join(ROOT, 'docs', 'add-widget.md');
const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/* ── 1. 抽 ```json 块 ── */
const md = fs.readFileSync(DOC, 'utf8');
// ⚠ 围栏后面可能是 \r\n（文档在 Windows 上编辑过就是 CRLF）—— 只认 \n 的话会**一块都抽不到**，
//   然后"文档里抽出 0 个 json 代码块"这种失败看着像文档没写例子，其实是换行符没兼容（踩过）。
const blocks = [...md.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m, i) => ({ i: i + 1, text: m[1] }));
ok(`文档里抽出 ${blocks.length} 个 json 代码块`, blocks.length >= 3, `共 ${blocks.length} 块`);

const parsed = [];
let jsonBad = 0;
for (const b of blocks) {
  try {
    parsed.push({ ...b, json: JSON.parse(b.text) });
  } catch (e) {
    jsonBad++;
    ok(`第 ${b.i} 个 json 块是合法 JSON`, false, e.message);
  }
}
ok('所有 json 代码块都是合法 JSON（能 parse）', jsonBad === 0, jsonBad ? `${jsonBad} 块有问题` : '');

// 只挑"完整控件包"来导（片段/示例对象不导）
const packs = parsed.filter(p => p.json && p.json.kind === 'widgets' && Array.isArray(p.json.widgets));
ok('文档里至少有 3 个完整可导的控件包示例', packs.length >= 3, `找到 ${packs.length} 个：${packs.map(p => `第${p.i}块(${p.json.widgets.length}控件)`).join('、')}`);

/* ── 2. 起后端 + 浏览器 ── */
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-doc-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(300); try { await fetch(H + '/'); up = true; } catch { /* 等 */ } }
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const errs = [];

/* 每个例子用**各自全新的上下文**（localStorage 干净 = 只有种子演示工程），
   所以第 N 个例子导入时，前面例子里注册的自定义控件类型都不在 —— 正好证明定义确实跟着包走 */
for (const p of packs) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(`第${p.i}块: ${e}`));
  page.on('dialog', d => d.accept());
  await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
  await page.goto(H + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
  await sleep(250);

  const r = await page.evaluate(async (text) => {
    const { project } = await import('/js/core/project.js');
    const before = project.currentPage().widgets.length;
    const res = project.importWidgetPack(JSON.parse(text), { allowCode: true });
    await new Promise(x => setTimeout(x, 400));
    const cur = project.currentPage();
    const added = cur.widgets.slice(before);
    return {
      ok: res.ok, reason: res.reason, added: res.widgetsAdded, defsAdded: res.defsAdded,
      defsFailed: res.defsFailed, varsAdded: res.varsAdded, warnings: res.warnings,
      // 每个导进来的控件在画布上都要真的有对应 DOM（渲染不出来的会缺）
      missingDom: added.filter(w => !document.querySelector(`#canvas .wd[data-id="${w.id}"]`)).map(w => `${w.name}(${w.type})`),
      unknownOnCanvas: document.querySelectorAll('#canvas .wd-unknown').length,
      types: added.map(w => w.type),
    };
  }, p.text);

  const label = `第${p.i}块（${r.types.join('、')}）`;
  ok(`${label} 能导入`, r.ok && r.added === p.json.widgets.length, r.ok ? `${r.added} 个控件` : r.reason);
  ok(`${label} 里面的定义全部注册成功（含冒烟渲染）`, (r.defsFailed || []).length === 0,
    (r.defsFailed || []).join('；') || `${(r.defsAdded || []).length} 个定义`);
  ok(`${label} 每个控件都在画布上渲染出来了`, r.missingDom.length === 0 && r.unknownOnCanvas === 0,
    r.missingDom.length ? `缺 DOM：${r.missingDom.join('、')}` : `未知控件占位 ${r.unknownOnCanvas} 个`);
  if (p.json.variables?.length) {
    ok(`${label} 变量按预期补进变量表`, r.varsAdded === p.json.variables.length, `新增 ${r.varsAdded}/${p.json.variables.length}`);
  }
  await ctx.close();
}

ok('浏览器无页面错误', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close(); srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

const bad = results.filter(r => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
