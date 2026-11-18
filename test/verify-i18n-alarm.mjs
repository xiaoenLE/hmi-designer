// verify-i18n-alarm.mjs — 报警文字的翻译（现场：切语言后报警还是中文）
//
// 覆盖：
//   ① 编辑画布：工程里有真实报警时，报警控件预览用**真实报警定义**（按当前语言翻），不再写死中文示例；
//   ② 运行态：报警条 / 当前报警 / 报警历史 切英文后都变英文、切回中文恢复；
//   ③ 历史记录兜底：报警定义被删/改了 id 时，历史里存下来的那句中文也按翻译表翻（不再是中文）。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18n-alarm-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* ── 0. 工程：一条中文报警 + 英文翻译 + 三个报警控件 ── */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  project.replaceData({
    meta: {}, variables: [{ name: 'bDoor', type: 'bool', address: '', value: false }],
    alarms: [{ id: 'al1', name: '门未关', text: '安全门未关闭，请检查', variable: 'bDoor', op: '>=', value: 1, level: 'alarm', enabled: true }],
    pages: [{ id: 'pg-a', name: '主画面', type: 'page', widgets: [
      { id: 'w-bar', type: 'alarmBar', x: 20, y: 20, w: 520, h: 40, z: 1, props: {}, bindings: {}, actions: [] },
      { id: 'w-list', type: 'alarmList', x: 20, y: 80, w: 620, h: 240, z: 2, props: {}, bindings: {}, actions: [] },
      { id: 'w-hist', type: 'alarmHistory', x: 20, y: 340, w: 620, h: 240, z: 3, props: {}, bindings: {}, actions: [] },
    ] }],
  });
  const i18n = await import('/js/core/i18n.js');
  i18n.addLanguage('en', 'English');
  const meta = project.data.meta = project.data.meta || {};
  meta.i18n = meta.i18n || { default: 'zh-CN', langs: [], dict: {}, scale: {} };
  meta.i18n.dict = meta.i18n.dict || {};
  meta.i18n.dict.en = { '门未关': 'Door Open', '安全门未关闭，请检查': 'Safety door is open - please check' };
  project.commit('报警多语言测试');
  varStore.resetFrom(project.variables());
});
await sleep(500);

/* ── 1. 编辑画布：真实报警按语言翻（不再是写死的中文示例） ── */
const edZh = await page.evaluate(() => document.querySelector('#canvas .w-alarmtbl')?.textContent || '');
ok('编辑画布：报警列表用真实报警定义（中文：安全门未关闭）',
  /安全门未关闭/.test(edZh), JSON.stringify(edZh.slice(0, 80)));
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await sleep(500);
const edEn = await page.evaluate(() => document.querySelector('#canvas .w-alarmtbl')?.textContent || '');
ok('★ 编辑画布切英文 → 报警列表也变英文（Safety door is open）',
  /Safety door is open/.test(edEn) && !/安全门/.test(edEn), JSON.stringify(edEn.slice(0, 100)));
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('zh-CN'); });
await sleep(400);

/* ── 2. 运行态：报警条/当前报警/历史都跟语言走 ── */
await page.evaluate(() => window.app.enterRun());
await sleep(600);
await page.evaluate(async () => { (await import('/js/runtime/varstore.js')).varStore.set('bDoor', true); });
await sleep(900);
const runZh = await page.evaluate(() => ({
  bar: document.querySelector('#rtPage .w-alarmbar')?.textContent || '',
  list: document.querySelector('#rtPage .w-alarmtbl')?.textContent || '',
}));
ok('运行态（中文）：报警条和当前报警列表都是中文',
  /安全门未关闭/.test(runZh.bar) && /安全门未关闭/.test(runZh.list),
  JSON.stringify({ bar: runZh.bar.slice(0, 60), list: runZh.list.slice(0, 80) }));

await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await sleep(800);
const runEn = await page.evaluate(() => ({
  bar: document.querySelector('#rtPage .w-alarmbar')?.textContent || '',
  list: document.querySelector('#rtPage .w-alarmtbl')?.textContent || '',
}));
ok('★ 运行态切英文 → 报警条 + 当前报警列表都变英文',
  /Safety door is open/.test(runEn.bar) && /Safety door is open/.test(runEn.list) && !/安全门/.test(runEn.list),
  JSON.stringify({ bar: runEn.bar.slice(0, 60), list: runEn.list.slice(0, 80) }));

/* ── 3. 历史记录（恢复后进历史）：切语言也跟着变 ── */
await page.evaluate(async () => { (await import('/js/runtime/varstore.js')).varStore.set('bDoor', false); });
await sleep(1000);
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('zh-CN'); });
await sleep(600);
let histZh = await page.evaluate(() => document.querySelector('#rtPage .w-alarmtbl.hist')?.textContent || '');
ok('运行态历史（中文）：记录里是中文', /安全门未关闭/.test(histZh), JSON.stringify(histZh.slice(0, 100)));
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await sleep(700);
let histEn = await page.evaluate(() => document.querySelector('#rtPage .w-alarmtbl.hist')?.textContent || '');
ok('★ 运行态历史切英文 → 历史里的报警内容也变英文', /Safety door is open/.test(histEn), JSON.stringify(histEn.slice(0, 120)));

/* ── 4. 兜底：报警定义被删了，历史里存的中文也要按翻译表翻 ── */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.data.alarms = [];                 // 模拟"报警被删掉/改了 id"
  project.commit('删掉报警定义');
  (await import('/js/core/i18n.js')).setLang('zh-CN');
});
await sleep(500);
// 再切英文：此时项目里没有报警定义了，历史里存的是中文原文 → 直接按翻译表翻
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await sleep(700);
const histFallback = await page.evaluate(() => document.querySelector('#rtPage .w-alarmtbl.hist')?.textContent || '');
ok('★ 报警定义被删后，历史记录里的中文也能按翻译表翻成英文（兜底）',
  /Safety door is open/.test(histFallback), JSON.stringify(histFallback.slice(0, 120)));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 报警多语言（编辑画布 / 运行态 / 历史兜底）回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
