// verify-widget-export.mjs — **控件包导出**的端到端回归（点菜单 → 浏览器真的落盘 → 文件能被导回来）
//
// 为什么单独一个套件：verify-widget-pack.mjs 测的是**数据层**（project/pack 的方法），
// 而"用户在右键菜单点一下、浏览器下载出一个 .hmiw.json"这条路径谁都没走到 ——
// 菜单项文案、文件名、下载有没有真的发出、状态栏说不说、导出的文件能不能被导回来，
// 全是只有端到端才看得见的东西。
//
// 用法：node test/verify-widget-export.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
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

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-export-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-dl-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(300);

/** 等下一个下载落盘，返回 {name, file, json} */
// ⚠ 浏览器里点导出默认弹系统「另存为」框（js/core/csv.js 的 saveTextFile → showSaveFilePicker），
//   自动化点不了那个原生框 —— 这里先摘掉保存框接口，验的是**退回浏览器下载**那条路
//   （弹框那条路在 verify-export-file.mjs 里用假 handle 验）
await page.evaluate(() => { delete window.showSaveFilePicker; });
const downloads = [];
page.on('download', d => downloads.push(d));
async function waitDownload(timeoutMs = 6000) {
  const n = downloads.length;
  for (let i = 0; i < timeoutMs / 100 && downloads.length === n; i++) await sleep(100);
  const d = downloads[downloads.length - 1];
  if (!d) return null;
  const file = path.join(DL, `${Date.now()}-${d.suggestedFilename()}`);
  await d.saveAs(file);
  const text = fs.readFileSync(file, 'utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON 就是有问题，交给断言 */ }
  return { name: d.suggestedFilename(), file, text, json };
}

/** 右键点某个控件（真实鼠标），再点菜单里匹配的那一项 */
async function rightClickWidgetAndPick(widgetId, labelRe) {
  const box = await page.evaluate((id) => {
    const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, widgetId);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(250);
  const menu = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')].map(b => b.textContent.trim()));
  const hit = await page.evaluate((re) => {
    const rx = new RegExp(re);
    const b = [...document.querySelectorAll('#ctxMenu .ctx-item')].find(x => rx.test(x.textContent));
    if (b) { b.click(); return b.textContent.trim(); }
    return '';
  }, labelRe.source);
  return { menu, hit };
}

/* ── 准备：一个按钮（绑定变量 + 一个动作） ── */
const prep = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.data.meta.name = '导出测试工程';
  project.data.variables.push({ name: 'bStart', type: 'bool', address: '%MX0.0', value: false });
  const b = project.addWidget('button', 120, 90);
  b.name = '启动按钮';
  b.props.text = '启动';
  b.bindings.variable = 'bStart';
  b.actions = [{ trigger: 'click', type: 'toggle', params: { variable: 'bStart' } }];
  return { id: b.id };
});

/* ── ① 单个控件：右键 → 「导出为控件包…（给别人用）」 → 浏览器落盘 ── */
const r1 = await rightClickWidgetAndPick(prep.id, /导出为控件包/);
ok('控件右键菜单里有导出项，文案是「导出为控件包…（给别人用）」',
  /导出为控件包…（给别人用）/.test(r1.hit), r1.hit || r1.menu.join(' | '));
const d1 = await waitDownload();
ok('点一下真的下载出一个 .hmiw.json 文件', !!d1 && /\.hmiw\.json$/.test(d1.name), d1?.name || '没等到下载');
ok('文件名 = 工程名-控件名.hmiw.json', d1?.name === '导出测试工程-启动按钮.hmiw.json', d1?.name || '');
ok('文件内容是合法控件包（kind/version/widgets/variables/pageRefs）',
  d1?.json?.kind === 'widgets' && d1.json.version === 1 && d1.json.widgets.length === 1
  && d1.json.variables.some(v => v.name === 'bStart') && typeof d1.json.pageRefs === 'object',
  d1 ? JSON.stringify({ kind: d1.json?.kind, widgets: d1.json?.widgets?.length, vars: d1.json?.variables?.map(v => v.name) }) : '');
ok('内置控件的包**一行代码都不含**（defs 是空数组）', Array.isArray(d1?.json?.defs) && d1.json.defs.length === 0);
const note = await page.evaluate(() => document.getElementById('stNote')?.textContent || '');
ok('状态栏说清楚导出了什么', /已导出/.test(note) && /内置控件（不带代码）/.test(note), note.slice(0, 90));

/* ── ② 多选：文案变成「导出这 N 个控件（控件包）…」，包里 N 个控件 ── */
const two = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { select } = await import('/js/editor/canvas.js');
  const p = project.currentPage();
  const lamp = project.addWidget('lamp', 300, 90);
  lamp.bindings.variable = 'bStart';
  const ids = [p.widgets.find(w => w.name === '启动按钮').id, lamp.id];
  select(ids);
  return ids;
});
const r2 = await rightClickWidgetAndPick(two[0], /导出这 \d+ 个控件/);
ok('多选时菜单文案是「导出这 N 个控件（控件包）…」', /导出这 2 个控件/.test(r2.hit), r2.hit || r2.menu.join(' | '));
const d2 = await waitDownload();
ok('多选导出的包里是 2 个控件', d2?.json?.widgets?.length === 2, String(d2?.json?.widgets?.length));

/* ── ③ 清单面板那一行右键（不切页、也不在画布上点） ── */
await page.keyboard.press('Escape');
await page.evaluate(async (id) => {
  const row = document.querySelector(`#widgetList .wl-item[data-id="${id}"]`);
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 20, clientY: r.y + 8 }));
}, prep.id);
await sleep(200);
const menu3 = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')].map(b => b.textContent.trim()));
const hit3 = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#ctxMenu .ctx-item')].find(x => /导出为控件包/.test(x.textContent));
  if (b) { b.click(); return b.textContent.trim(); }
  return '';
});
const d3 = await waitDownload();
ok('控件清单那一行右键也能导出单个控件', /导出为控件包/.test(hit3) && d3?.json?.widgets?.length === 1,
  hit3 || menu3.join(' | '));

/* ── ④ 自定义控件：包里必须带上定义（render 源码 + CSS） ── */
const custom = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { select } = await import('/js/editor/canvas.js');
  const pack = await import('/js/widgets/pack.js');
  pack.registerCustomDefChecked({
    type: 'expbar', title: '导出棒图', sub: '自定义',
    icon: '<svg viewBox="0 0 36 36" width="30" height="30"></svg>',
    defaults: { w: 200, h: 26, min: 0, max: 100 },
    props: [{ key: 'min', label: '最小', type: 'number' }, { key: 'max', label: '最大', type: 'number' }],
    binding: { variable: { types: ['int', 'real'], label: '绑定变量' } },
    actions: [],
    renderSrc: 'render(w, vars0, vars) { const v = varValue(w, vars); return \'<div class="w-expbar">\' + escapeHtml(String(v ?? \'-\')) + \'</div>\'; }',
    css: '.w-expbar{background:#111;color:#0f0;height:100%}',
  });
  const g = project.addWidget('expbar', 500, 200);
  g.name = '导出棒图1';
  g.bindings.variable = 'bStart';
  select([g.id]);
  return { id: g.id };
});
const r4 = await rightClickWidgetAndPick(custom.id, /导出为控件包/);
const d4 = await waitDownload();
ok('自定义控件导出时带上定义（render 源码 + CSS）',
  /\.hmiw\.json$/.test(d4?.name || '') && d4?.json?.defs?.length === 1
  && /^render\(/.test(d4.json.defs[0].renderSrc || '') && /\.w-expbar/.test(d4.json.defs[0].css || ''),
  d4 ? JSON.stringify({ name: d4.name, defs: d4.json?.defs?.length, css: (d4.json?.defs?.[0]?.css || '').slice(0, 30) }) : '没等到下载');
ok('状态栏点明"带自定义控件定义（带代码）"', /自定义控件定义（带代码）/.test(await page.evaluate(() => document.getElementById('stNote')?.textContent || '')));

/* ── ⑤ 闭环：**导出的文件能导回来**（这才是"别人能用"） ── */
const back = await page.evaluate(async (text) => {
  const { project } = await import('/js/core/project.js');
  const before = project.currentPage().widgets.length;
  const r = project.importWidgetPack(JSON.parse(text), { allowCode: true });
  return { ok: r.ok, added: r.widgetsAdded, delta: project.currentPage().widgets.length - before, defsAdded: r.defsAdded };
}, d1.text);
ok('导出的文件能被导回来（内置控件包，闭环）', back.ok && back.added === 1 && back.delta === 1, JSON.stringify(back));

/* ── ⑥ 导入入口在位（画布空白处右键） ── */
await page.evaluate(() => {
  const c = document.getElementById('canvas');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 30, clientY: r.y + r.height - 30 }));
});
await sleep(200);
const blankMenu = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')].map(b => b.textContent.trim()));
ok('画布空白处右键有「导入控件包…（.hmiw.json）」', blankMenu.some(t => /导入控件包/.test(t)), blankMenu.join(' | '));

ok('浏览器无页面错误', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close(); srv.kill();
for (const d of [DATA, DL]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }

const bad = results.filter(r => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);

