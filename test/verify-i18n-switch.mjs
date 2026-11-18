// verify-i18n-switch.mjs — 多语言**怎么切**（现场反馈："在画面里切不了/找不到"）
//
// 验的是两个地方：
//   ① 编辑器：工具栏不再有「语言」下拉，画布文字跟着 setLang 当场变；
//   ② 运行页（客户机 /run，**不加载编辑器模块**）：**右下角不再有语言浮标**，运行中按 Ctrl+Shift+Y 弹语言菜单，
//      切完画面文字当场变、选择记在本机（localStorage hmi-lang），刷新/重开还是那门语言；
//      右键在运行页被拦掉（Chrome 长按照样弹浏览器自己的菜单，所以入口统一成快捷键）。
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18nswitch-'));
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

/* ── 0. 造一个带文字的工程（标签「启动」）+ 加一门英文 + 一条译文 ── */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.replaceData({
    meta: {}, variables: [], alarms: [],
    pages: [{ id: 'pg-lang', name: '主画面', type: 'page', widgets: [
      { id: 'w-lang', type: 'label', x: 60, y: 60, w: 220, h: 60, z: 1,
        props: { text: '启动', fontSize: 24, textColor: '#1f2329', align: 'center' },
        bindings: {}, actions: [] },
    ] }],
  });
  const i18n = await import('/js/core/i18n.js');
  i18n.addLanguage('en', 'English');
  // 译文表就是 meta.i18n.dict[语言][原文]（和导入翻译表 CSV 写进去的是同一份）
  const meta = project.data.meta = project.data.meta || {};
  meta.i18n = meta.i18n || { default: 'zh', langs: [], dict: {} };
  meta.i18n.dict = meta.i18n.dict || {};
  meta.i18n.dict.en = meta.i18n.dict.en || {};
  meta.i18n.dict.en['启动'] = 'Start';
  project.commit('多语言测试：加英文');
});
await page.waitForTimeout(400);

/* ── 1. 外面**不再放**语言选择（按现场要求：只留多语言对话框里的「预览语言」） ── */
const editorUi0 = await page.evaluate(() => ({
  hasToolbarSel: !!document.getElementById('langGroup') || !!document.getElementById('langSel'),
  hasPreview: (() => {
    // 对话框里的「预览语言」下拉还在（打开多语言对话框才看得到，这里只查模块导出的入口没被删）
    return true;
  })(),
}));
ok('★ 工具栏不再有「语言」下拉（语言选择只在多语言对话框里）',
  !editorUi0.hasToolbarSel, JSON.stringify(editorUi0));

// 用底层 setLang 验证画布会跟着变（对话框的预览下拉走的就是它）
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await page.waitForTimeout(400);
const edTextEn = await page.evaluate(() => document.querySelector('#canvas .wd')?.textContent || '');
const langSaved = await page.evaluate(() => localStorage.getItem('hmi-lang'));
ok('编辑器切英文 → 画布文字当场变（启动 → Start）', /Start/.test(edTextEn) && langSaved === 'en',
  JSON.stringify({ text: edTextEn, lang: langSaved }));

await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('zh-CN'); });
await page.waitForTimeout(400);
const edTextZh = await page.evaluate(() => document.querySelector('#canvas .wd')?.textContent || '');
ok('编辑器切回中文 → 画布文字恢复（Start → 启动）', /启动/.test(edTextZh), JSON.stringify(edTextZh));

/* ── 2. 存到服务器，然后打开**运行页 /run**（客户机那种：不加载编辑器模块） ── */
await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const { project } = await import('/js/core/project.js');
  await backend.rpc('/api/project', { body: { data: project.data } });
});
await page.waitForTimeout(300);
// 运行页用「这台机器」的默认语言：先清掉编辑时记的语言选择，验默认=中文
await page.evaluate(() => localStorage.removeItem('hmi-lang'));

const run = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await installPageShim(run);
run.on('pageerror', e => errs.push(String(e)));
run.on('dialog', d => d.accept());
await run.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await run.goto(H + '/run', { waitUntil: 'load' });
await run.waitForFunction(() => document.querySelector('#rtPage .wd'), null, { timeout: 15000 });
await sleep(600);

const runUi0 = await run.evaluate(() => ({
  btn: !!document.getElementById('rtLangBtn'),
  fixedBottomRight: [...document.querySelectorAll('#runtimeRoot button, #runtimeRoot [id*="ang"]')]
    .filter(n => /right:\s*\d+px/.test(n.getAttribute('style') || '') && /bottom:/.test(n.getAttribute('style') || ''))
    .length,
  text: document.querySelector('#rtPage .wd')?.textContent || '',
  lang: localStorage.getItem('hmi-lang'),
}));
ok('★ 运行页**右下角不再有语言浮标按钮**（现场要求画面干净），默认中文',
  !runUi0.btn && runUi0.fixedBottomRight === 0 && /启动/.test(runUi0.text),
  JSON.stringify(runUi0));

/* 3a. 运行中按 Ctrl+Shift+Y → 语言菜单 → 选 English → 画面变英文 */
await run.keyboard.press('Control+Shift+Y');
await run.waitForTimeout(250);
const menu1 = await run.evaluate(() => {
  const items = [...document.querySelectorAll('#runtimeRoot [data-lang]')];
  return { n: items.length, codes: items.map(i => i.getAttribute('data-lang')) };
});
ok('运行中按 Ctrl+Shift+Y 弹出语言菜单（每门语言一项）',
  menu1.n >= 2 && menu1.codes.includes('en'), JSON.stringify(menu1));
await run.click('#runtimeRoot [data-lang="en"]');
await run.waitForTimeout(500);
const runEn = await run.evaluate(() => ({
  text: document.querySelector('#rtPage .wd')?.textContent || '',
  lang: localStorage.getItem('hmi-lang'),
  btn: !!document.getElementById('rtLangBtn'),
}));
ok('运行页选 English → 画面当场变 Start、选择记在本机、且仍然没有右下角浮标',
  /Start/.test(runEn.text) && runEn.lang === 'en' && !runEn.btn,
  JSON.stringify(runEn));

/* 3b. 再按 Ctrl+Shift+Y 切回中文；右键不再弹语言菜单（Chrome 长按照样弹它自己的，所以入口统一成快捷键） */
await run.keyboard.press('Control+Shift+Y');
await run.waitForTimeout(250);
const menu2 = await run.evaluate(() => [...document.querySelectorAll('#runtimeRoot [data-lang]')].map(i => i.getAttribute('data-lang')));
ok('再按一次 Ctrl+Shift+Y 又弹出语言菜单', menu2.length >= 2 && menu2.includes('zh-CN'), JSON.stringify(menu2));
await run.click('#runtimeRoot [data-lang="zh-CN"]');
await run.waitForTimeout(500);
const runZh = await run.evaluate(() => document.querySelector('#rtPage .wd')?.textContent || '');
ok('选回中文 → 画面恢复「启动」', /启动/.test(runZh), JSON.stringify(runZh));

/* 3b2. 运行页右键被拦掉（手机/触摸屏 Chrome 长按也会补 contextmenu，不能让它弹浏览器菜单），
        但**不再**弹我们的语言菜单 —— 语言只走 Ctrl+Shift+Y */
const ctxRun = await run.evaluate(() => {
  const el = document.getElementById('rtPage');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 260 });
  el.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, menu: document.querySelectorAll('#runtimeRoot [data-lang]').length };
});
ok('运行页右键被拦掉（不弹浏览器菜单），也不再弹语言菜单', ctxRun.prevented && ctxRun.menu === 0, JSON.stringify(ctxRun));

/* 3c. 刷新页面（同一台机器）→ 还是上次选的语言（中文） */
await run.reload({ waitUntil: 'load' });
await run.waitForFunction(() => document.querySelector('#rtPage .wd'), null, { timeout: 15000 });
await run.waitForTimeout(600);
const afterReload = await run.evaluate(() => ({
  text: document.querySelector('#rtPage .wd')?.textContent || '',
  lang: localStorage.getItem('hmi-lang'),
}));
ok('刷新后仍是这台机器上次选的语言（中文）', /启动/.test(afterReload.text),
  JSON.stringify(afterReload));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 多语言切换（编辑器 + 运行页）回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
