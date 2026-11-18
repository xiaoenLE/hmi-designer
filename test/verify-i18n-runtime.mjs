// verify-i18n-runtime.mjs — 多语言（画面文字翻译）在**运行态/编辑画布**里的落地
//
// 现场要求：「多语言，那些语言可以直接全部导出翻译」→ 翻译表按原文作键（js/core/i18n.js），
// 这里验的是**翻译真的显示在画面上**，而不是只存了个字典：
//   ① 加了语言 + 译文后：编辑画布上的按钮/标签文字跟着变（预览语言）；
//   ② 运行态：按钮/标签文字、报警条文字（带 {变量} 的模板）都按当前语言显示；
//   ③ 运行态右键菜单里有「语言」一项，点一下就换、画面当场重画，换回去还是原文；
//   ④ 导出翻译表 CSV 含表头/原文；导入译文 CSV 能填进 dict；
//   ⑤ 没配译文的那句**原样显示**（不能出现空白）。
// 自己起隔离后端 + 浏览器（随机端口、临时数据目录），不碰 8866 / 现场数据。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim } from './_wsfetch.mjs';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = process.env.HMI_PY || 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18n-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ── 造数据：一个按钮 + 一个标签 + 一个报警条 + 一条带 {变量} 的报警，并配 en 译文 ── */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const i18n = await import('/js/core/i18n.js');
  const pg = project.pages().find(p => p.type === 'page');
  project.setCurrentPage(pg.id);
  project.data.variables.push(
    { name: 'bI18nStart', type: 'bool', address: '%MX0.0', value: false },
    { name: 'rI18nSpeed', type: 'real', address: '%MW10', value: 0 });
  const btn = project.addWidget('button', 40, 40);
  project.updateWidgetField(btn.id, 'w', 160);
  project.updateWidgetField(btn.id, 'h', 56);
  project.updateWidgetProp(btn.id, 'text', '启动');
  project.updateWidgetProp(btn.id, 'showState', false);   // 旧开关会被忽略，旧 text 映射到未满文字
  project.updateWidgetField(btn.id, 'bindings.variable', 'bI18nStart');
  const lab = project.addWidget('label', 40, 140);
  project.updateWidgetProp(lab.id, 'text', '当前状态');
  const bar = project.addWidget('alarmBar', 40, 220);
  project.updateWidgetField(bar.id, 'w', 600);
  project.updateWidgetField(bar.id, 'h', 46);
  // 一条会立刻触发的报警（内容里带 {变量}，翻译表里也按带占位符的整句存）
  project.data.alarms.push({
    id: 'al_i18n_test', name: '超速报警', variable: 'rI18nSpeed', op: '>=', value: 1000,
    level: 'alarm', delaySec: 0, enabled: true, text: '主轴转速过高：{rI18nSpeed}',
  });
  // 多语言：加 en + 译文
  i18n.addLanguage('en', 'English');
  const st = i18n.i18nState();
  st.dict.en = st.dict.en || {};
  Object.assign(st.dict.en, {
    '启动': 'Start',
    '当前状态': 'Status',
    '主轴转速过高：{rI18nSpeed}': 'Spindle overspeed: {rI18nSpeed}',
    '超速报警': 'Overspeed alarm',
  });
  project.commit('i18n 测试数据');
  i18n.setLang('zh-CN');
  return { page: pg.id, btn: btn.id, lab: lab.id };
});
await sleep(400);

/* ── ① 编辑画布：预览语言切到 en，画布上的按钮/标签文字跟着变 ── */
const canvasZh = await page.evaluate((ids) => ({
  btn: document.querySelector(`#canvas .wd[data-id="${ids.btn}"]`)?.textContent || '',
  lab: document.querySelector(`#canvas .wd[data-id="${ids.lab}"]`)?.textContent || '',
}), ids);
ok('（翻译前）画布上按钮/标签是原文', /启动/.test(canvasZh.btn) && /当前状态/.test(canvasZh.lab), JSON.stringify(canvasZh));
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await sleep(300);
const canvasEn = await page.evaluate((ids) => ({
  btn: document.querySelector(`#canvas .wd[data-id="${ids.btn}"]`)?.textContent || '',
  lab: document.querySelector(`#canvas .wd[data-id="${ids.lab}"]`)?.textContent || '',
}), ids);
ok('★ 编辑画布切到 English：按钮显示 Start、标签显示 Status',
  /Start/.test(canvasEn.btn) && /Status/.test(canvasEn.lab), JSON.stringify(canvasEn));
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('zh-CN'); });
await sleep(200);

/* ── ② 运行态：按钮/标签/报警条按当前语言显示 ── */
await page.evaluate(async () => { (await import('/js/runtime/runtime.js')).enterRun(); });
await sleep(600);
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await sleep(400);
const rtEn = await page.evaluate((ids) => ({
  btn: document.querySelector(`#rtPage .wd[data-id="${ids.btn}"]`)?.textContent || '',
  lab: document.querySelector(`#rtPage .wd[data-id="${ids.lab}"]`)?.textContent || '',
}), ids);
ok('★ 运行态切 English：按钮 Start、标签 Status', /Start/.test(rtEn.btn) && /Status/.test(rtEn.lab), JSON.stringify(rtEn));

// 触发报警（运行态里改变量 → 报警引擎下一拍判出来 → 报警条显示译文模板 + 当前值）
await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('rI18nSpeed', 2000);
});
await sleep(600);
const alarmEn = await page.evaluate(() => document.body.innerText);
const barText = await page.evaluate(() => {
  const el = document.querySelector('#rtPage .w-alarmbar');
  return el ? el.textContent : '';
});
ok('★ 运行态报警条按当前语言显示（模板翻过 + {变量} 替换成真实值）',
  /Spindle overspeed: 2000/.test(alarmEn) || /Spindle overspeed: 2000/.test(barText), JSON.stringify(barText).slice(0, 200));

/* ── ③ 运行态右键菜单里有「语言」项，点它当场换、画面重画 ── */
// 从 DOM 走真实右键：在运行画面空白处右键
const rtPoint = await page.evaluate(() => {
  const el = document.getElementById('rtPage');
  const r = el.getBoundingClientRect();
  return { x: r.left + 10, y: r.top + 10 };
});
await page.mouse.click(rtPoint.x, rtPoint.y, { button: 'right' });
await sleep(300);
const menuItems = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
  .map(b => b.querySelector('.ctx-label')?.textContent || ''));
const hasLangMenu = menuItems.some(t => /English/.test(t)) && menuItems.some(t => /中文/.test(t));
ok('★ 运行态右键菜单里有「语言」项（列出已知语言）', hasLangMenu, JSON.stringify(menuItems));
// 点中文那项 → 画面回到原文
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .find(x => /中文/.test(x.querySelector('.ctx-label')?.textContent || ''));
  if (b) b.click();
});
await sleep(400);
const rtZh = await page.evaluate((ids) => ({
  btn: document.querySelector(`#rtPage .wd[data-id="${ids.btn}"]`)?.textContent || '',
  lab: document.querySelector(`#rtPage .wd[data-id="${ids.lab}"]`)?.textContent || '',
}), ids);
ok('★ 菜单里点「中文」→ 运行画面当场换回原文（不用退出重进）',
  /启动/.test(rtZh.btn) && /当前状态/.test(rtZh.lab), JSON.stringify(rtZh));

/* ── ④ 翻译表导出 / 导入 ── */
const csvInfo = await page.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  const csv = i18n.exportTranslationCsv();
  const head = csv.split(/\r?\n/)[0];
  const hasBtn = /启动/.test(csv) && /当前状态/.test(csv);
  const imported = i18n.importTranslationCsv('分类,位置,字段,原文,en\r\n控件,x,文本,当前状态,StateX\r\n');
  return { head, hasBtn, imported, dictNow: i18n.i18nState().dict.en?.['当前状态'] };
});
ok('★ 导出翻译表：表头带语言列（en），内容含画面原文',
  /分类/.test(csvInfo.head) && /原文/.test(csvInfo.head) && /\ben\b/.test(csvInfo.head) && csvInfo.hasBtn,
  JSON.stringify(csvInfo.head));
ok('★ 导入译文 CSV：译文填进字典并生效',
  csvInfo.imported.ok === true && csvInfo.imported.filled >= 1 && csvInfo.dictNow === 'StateX', JSON.stringify(csvInfo.imported));

/* ── ⑤ 没配译文的那句原样显示（不能变空白） ── */
const raw = await page.evaluate(async () => {
  const { tr } = await import('/js/core/i18n.js');
  return tr('这句没配译文');
});
ok('没配译文的文字原样显示（不会变空白）', raw === '这句没配译文', JSON.stringify(raw));

await page.evaluate(async () => {
  (await import('/js/runtime/runtime.js')).exitRun();
  (await import('/js/core/i18n.js')).setLang('zh-CN');
});
await sleep(200);

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const failed = results.filter(r => r.startsWith('FAIL'));
console.log(results.join('\n'));
console.log(`\n==== 多语言（运行态/画布/导出导入）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
