// verify-i18n-fontsize.mjs — 多语言**字号（字体大小）**：不同语言可以不一样大
//
// 现场："导出的语言应该还需要文本的文字大小，不一样语言字体大小应该不一样的"
//   · 每门语言有「字号%」（50~200，100 = 不缩放），存在工程里、跟着导出的翻译表 CSV 一起走；
//   · 切到那门语言时，控件里的内联 font-size 按比例缩放（编辑画布 + 运行页都一样）；
//   · 100% 时一个字都不变（老工程/默认语言零差异）。
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18nfs-'));
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

/* ── 0. 造工程：标签「启动」字号 24 + 一门 en + 译文 ── */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.replaceData({
    meta: {}, variables: [], alarms: [],
    pages: [{ id: 'pg-fs', name: '主画面', type: 'page', widgets: [
      { id: 'w-fs', type: 'label', x: 60, y: 60, w: 220, h: 60, z: 1,
        props: { text: '启动', fontSize: 24, textColor: '#1f2329', align: 'center' },
        bindings: {}, actions: [] },
    ] }],
  });
  const i18n = await import('/js/core/i18n.js');
  i18n.addLanguage('en', 'English');
  const meta = project.data.meta = project.data.meta || {};
  meta.i18n = meta.i18n || { default: 'zh-CN', langs: [], dict: {} };
  meta.i18n.dict = meta.i18n.dict || {};
  meta.i18n.dict.en = meta.i18n.dict.en || {};
  meta.i18n.dict.en['启动'] = 'Start';
  project.commit('字号测试：工程');
});
await sleep(400);

const canvasFont = () => page.evaluate(() => {
  const el = document.querySelector('#canvas .wd [style*="font-size"], #canvas .wd');
  const box = document.querySelector('#canvas .wd');
  if (!box) return null;
  // 取控件里第一个带内联 font-size 的元素（label 的文字在 span 上）
  const hit = [...box.querySelectorAll('*')].find(n => (n.getAttribute('style') || '').indexOf('font-size') >= 0) || box;
  return { px: parseFloat(getComputedStyle(hit).fontSize), inline: hit.getAttribute('style') || '', text: box.textContent };
});

/* ── 1. 默认（100%）不变 ── */
const base = await canvasFont();
ok('默认语言字号 100%：标签还是 24px（不做任何缩放）',
  base && Math.abs(base.px - 24) < 0.2 && /font-size:\s*24px/.test(base.inline),
  JSON.stringify(base));

/* ── 2. en 字号设 85% → 切到 en 后 24 * 0.85 = 20.4px ── */
const setScale = await page.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  const n = i18n.setLangScale('en', 85);
  i18n.setLang('en');
  return { n, scale: i18n.langScale('en'), lang: i18n.getLang() };
});
await sleep(450);
const enFont = await canvasFont();
ok('★ en 字号 85% + 切到 en → 画布字号 24 × 0.85 = 20.4px（文字变 Start）',
  setScale.scale === 85 && enFont && Math.abs(enFont.px - 20.4) < 0.3 && /Start/.test(enFont.text),
  JSON.stringify({ setScale, enFont }));

/* ── 3. 再放大到 120% → 28.8px（同一门语言也能改回来） ── */
await page.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  i18n.setLangScale('en', 120);
});
await sleep(450);
const enBig = await canvasFont();
ok('★ en 字号改成 120% → 24 × 1.2 = 28.8px', enBig && Math.abs(enBig.px - 28.8) < 0.3, JSON.stringify(enBig));

/* ── 4. 切回中文（100%）→ 回到 24px、文字变回原文 ── */
await page.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  i18n.setLang('zh-CN');
});
await sleep(450);
const zhFont = await canvasFont();
ok('★ 切回中文（字号 100%）→ 24px、文字回「启动」',
  zhFont && Math.abs(zhFont.px - 24) < 0.2 && /启动/.test(zhFont.text), JSON.stringify(zhFont));

/* ── 5. 对话框里每门语言有「字号」输入框，且值跟工程一致 ── */
await page.evaluate(async () => {
  const m = await import('/js/editor/i18nPanel.js');
  m.openI18nPanel();
});
await sleep(500);
const panelScale = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#i18nLangs .i18n-lang-row')];
  return rows.map(r => ({
    code: r.dataset.lang,
    scale: r.querySelector('[data-lang-scale]')?.value,
  }));
});
ok('★ 多语言对话框每门语言都有「字号%」输入框（en = 120，来自工程）',
  panelScale.length >= 2
  && panelScale.find(r => r.code === 'en')?.scale === '120'
  && panelScale.find(r => r.code === 'zh-CN')?.scale === '100',
  JSON.stringify(panelScale));

// 从面板里把 en 改成 90 → 画布（en 预览时）按 90% 重画
await page.selectOption('#i18nLangPreview', 'en');
await sleep(300);
await page.evaluate(() => {
  const inp = document.querySelector('#i18nLangs [data-lang-scale="en"]');
  inp.value = '90';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(450);
const panelChanged = await page.evaluate(() => {
  const box = document.querySelector('#canvas .wd');
  const hit = [...box.querySelectorAll('*')].find(n => (n.getAttribute('style') || '').indexOf('font-size') >= 0) || box;
  return { px: parseFloat(getComputedStyle(hit).fontSize), scale: document.querySelector('#i18nLangs [data-lang-scale="en"]').value };
});
ok('★ 对话框里把 en 字号改成 90 → 画布字号 24 × 0.9 = 21.6px',
  panelChanged.scale === '90' && Math.abs(panelChanged.px - 21.6) < 0.3, JSON.stringify(panelChanged));

/* ── 6. 运行页（/run）同样按语言缩放 ── */
await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const { project } = await import('/js/core/project.js');
  await backend.rpc('/api/project', { body: { data: project.data } });
});
await sleep(300);
await page.evaluate(() => localStorage.removeItem('hmi-lang'));
const run = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await installPageShim(run);
run.on('pageerror', e => errs.push(String(e))); 
run.on('dialog', d => d.accept());
await run.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await run.goto(H + '/run', { waitUntil: 'load' });
await run.waitForFunction(() => document.querySelector('#rtPage .wd'), null, { timeout: 15000 });
await sleep(700);
const runFont = (code) => run.evaluate((c) => {
  const box = document.querySelector('#rtPage .wd');
  const hit = [...box.querySelectorAll('*')].find(n => (n.getAttribute('style') || '').indexOf('font-size') >= 0) || box;
  return { px: parseFloat(getComputedStyle(hit).fontSize), text: box.textContent, lang: c };
}, code);
const runZh = await runFont('zh-CN');
ok('运行页默认中文：字号 24px', runZh && Math.abs(runZh.px - 24) < 0.2 && /启动/.test(runZh.text), JSON.stringify(runZh));
await run.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  i18n.setLang('en');
});
await sleep(600);
const runEn = await runFont('en');
ok('★ 运行页切到 en（字号 90%）→ 文字 Start、字号 24 × 0.9 = 21.6px',
  runEn && /Start/.test(runEn.text) && Math.abs(runEn.px - 21.6) < 0.3, JSON.stringify(runEn));
await run.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  i18n.setLang('zh-CN');
});
await sleep(600);
const runBack = await runFont('zh-CN');
ok('运行页切回中文 → 字号恢复 24px', runBack && Math.abs(runBack.px - 24) < 0.2 && /启动/.test(runBack.text), JSON.stringify(runBack));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 多语言字号（字体大小）回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
