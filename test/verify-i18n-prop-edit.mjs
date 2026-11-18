// verify-i18n-prop-edit.mjs — 属性面板**跟随当前语言**：文本显示/编辑译文，字号按控件按语言
//
// 现场问题：切到英文后属性面板里的值还是中文原文；改字号"一起变"（改的是基础字号，所有语言都跟着变）。
// 本套件验：
//   ① 默认语言（中文）：面板显示原文 / 基础字号，编辑行为与以前完全一样（改原文 / 基础字号）
//   ② 切英文：面板文本格显示译文（Stop），字号格显示「这门语言下这个控件的生效 px」；
//      改文本 → 只写 dict.en，原文 prop 不变、画布立即变；
//      改字号 → 只写 meta.i18n.wsize.en['<控件id>|fontSize']，画布按「覆盖/基础」缩放，基础 fontSize 不变
//   ③ 切回中文：面板文本回原文、字号回基础值，画布也回基础字号；再切英文 → 面板又是 Stop / 30
//   ④ 导出的翻译表 en 列是 Stop
//   ⑤ 默认语言下改文本仍然改的是原文
//   ⑥ 全程无未捕获 JS 异常
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18nprop-'));
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

/* ── 0. 造工程：标签「启动」字号 24 + 一门 en（预置 dict.en['启动']='Start'），选中它 ── */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const i18n = await import('/js/core/i18n.js');
  project.replaceData({
    meta: {}, variables: [], alarms: [],
    pages: [{ id: 'pg-pe', name: '主画面', type: 'page', widgets: [
      { id: 'w-pe', type: 'label', x: 60, y: 60, w: 260, h: 70, z: 1,
        props: { text: '启动', fontSize: 24, textColor: '#1f2329', align: 'center', bold: false },
        bindings: {}, actions: [] },
    ] }],
  });
  i18n.addLanguage('en', 'English');
  const s = i18n.i18nState();
  s.dict = s.dict || {};
  s.dict.en = { '启动': 'Start' };       // 预置一份译文，等价"翻译表里已经翻过"
  project.commit('属性面板多语言：工程');
  const { select } = await import('/js/editor/canvas.js');
  select(['w-pe']);
});
await sleep(500);

/* ── 小工具 ── */
const panel = () => page.evaluate(() => {
  const q = (k) => document.querySelector(`#propBody [data-prop="${k}"]`);
  const ti = q('text');
  const fi = q('fontSize');
  return {
    text: ti ? ti.value : null,
    font: fi ? fi.value : null,
    textI18n: !!(ti && ti.dataset.i18ntext),
    fontI18n: !!(fi && fi.dataset.i18nfont),
  };
});
const canvas = () => page.evaluate(() => {
  const box = document.querySelector('#canvas .wd[data-id="w-pe"]');
  if (!box) return null;
  const hit = [...box.querySelectorAll('*')].find(n => (n.getAttribute('style') || '').indexOf('font-size') >= 0) || box;
  return { text: box.textContent.trim(), px: parseFloat(getComputedStyle(hit).fontSize), inline: hit.getAttribute('style') || '' };
});
const setProp = (k, v) => page.evaluate(([k, v]) => {
  const i = document.querySelector(`#propBody [data-prop="${k}"]`);
  if (!i) return false;
  i.value = v;
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, [k, v]);
const state = () => page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const i18n = await import('/js/core/i18n.js');
  const w = project.getWidget('w-pe');
  const s = i18n.i18nState();
  const has = (n) => typeof i18n[n] === 'function';
  return {
    lang: i18n.getLang(), defLang: i18n.defaultLang(),
    rawText: w.props.text, baseFont: w.props.fontSize,
    dictEn: (s.dict && s.dict.en) || {},
    wsizeEn: (s.wsize && s.wsize.en) || {},
    textOf: i18n.textOf(w.props.text),
    px: i18n.widgetFontPx(w, 'fontSize'),
    factor: i18n.fontFactorForWidget(w),
    helpers: ['textOf', 'setTranslationFor', 'widgetFontPx', 'setWidgetFontPx', 'fontFactorForWidget'].every(has),
  };
});
const setLang = (lang) => page.evaluate(async (lang) => {
  const i18n = await import('/js/core/i18n.js');
  i18n.setLang(lang);
  return i18n.getLang();
}, lang);

/* ═══════════ 1. 默认语言：行为不变（原文 / 基础字号） ═══════════ */
const zh0 = await panel();
const st0 = await state();
ok('默认语言（中文）：面板显示原文「启动」/ 基础字号 24（不加 i18n 标记，行为与以前一样）',
  zh0.text === '启动' && zh0.font === '24' && !zh0.textI18n && !zh0.fontI18n
  && st0.lang === 'zh-CN' && st0.helpers,
  JSON.stringify({ panel: zh0, state: { lang: st0.lang, helpers: st0.helpers } }));
const c0 = await canvas();
ok('默认语言：画布 24px / 文字「启动」', !!c0 && Math.abs(c0.px - 24) < 0.2 && c0.text.includes('启动'), JSON.stringify(c0));

/* ═══════════ 2. 切英文：面板文本显示译文、字号显示这门语言的生效值 ═══════════ */
await setLang('en');
await sleep(450);
const en1 = await panel();
const st1 = await state();
ok('★ 切英文后：属性面板文本格显示**译文 Start**（带 i18n 标记），字号格取这门语言的生效 px=24',
  en1.text === 'Start' && en1.textI18n && en1.font === '24' && en1.fontI18n
  && st1.lang === 'en' && st1.textOf === 'Start',
  JSON.stringify({ panel: en1, textOf: st1.textOf }));
const cEn1 = await canvas();
ok('切英文后画布文字 Start / 字号 24px', !!cEn1 && cEn1.text.includes('Start') && Math.abs(cEn1.px - 24) < 0.2, JSON.stringify(cEn1));

/* ═══════════ 3. 英文下把文本改成 Stop：只写译文，原文不动 ═══════════ */
await setProp('text', 'Stop');
await sleep(500);
const en2 = await panel();
const st2 = await state();
const cEn2 = await canvas();
ok('★ 英文下改文本=Stop → 只写 dict.en（原文 prop 仍「启动」），画布立刻变 Stop',
  st2.rawText === '启动' && st2.dictEn['启动'] === 'Stop' && en2.text === 'Stop'
  && !!cEn2 && cEn2.text.includes('Stop') && !cEn2.text.includes('启动'),
  JSON.stringify({ raw: st2.rawText, dictEn: st2.dictEn, panel: en2.text, canvas: cEn2 && cEn2.text }));

/* ═══════════ 4. 英文下把字号改成 30：只写 wsize.en（基础字号仍 24），画布按覆盖缩放 = 30px ═══════════ */
await setProp('fontSize', '30');
await sleep(500);
const en3 = await panel();
const st3 = await state();
const cEn3 = await canvas();
ok('★ 英文下改字号=30 → 只写 meta.i18n.wsize.en[控件id|fontSize]，基础 fontSize 仍 24',
  Number(st3.wsizeEn['w-pe|fontSize']) === 30 && Number(st3.baseFont) === 24
  && st3.px === 30 && Math.abs(st3.factor - 1.25) < 0.001 && en3.font === '30',
  JSON.stringify({ wsizeEn: st3.wsizeEn, baseFont: st3.baseFont, px: st3.px, factor: st3.factor, panel: en3.font }));
ok('★ 英文下画布字号 24 × (30/24) = 30px', !!cEn3 && Math.abs(cEn3.px - 30) < 0.3, JSON.stringify(cEn3));

/* ═══════════ 5. 切回中文：面板文本回原文、字号回 24；画布也回 24 ═══════════ */
await setLang('zh-CN');
await sleep(500);
const zh2 = await panel();
const stZh = await state();
const cZh = await canvas();
ok('★ 切回中文：面板文本回「启动」、字号回 24（英文覆盖不污染基础字号）',
  zh2.text === '启动' && zh2.font === '24' && !zh2.textI18n && !zh2.fontI18n
  && Number(stZh.baseFont) === 24 && Number(stZh.wsizeEn['w-pe|fontSize']) === 30,
  JSON.stringify({ panel: zh2, baseFont: stZh.baseFont, wsizeEn: stZh.wsizeEn }));
ok('★ 切回中文后画布字号 24px / 文字「启动」', !!cZh && Math.abs(cZh.px - 24) < 0.2 && cZh.text.includes('启动'), JSON.stringify(cZh));

/* ═══════════ 6. 再切英文：面板文本 Stop / 字号 30；画布 30px ═══════════ */
await setLang('en');
await sleep(450);
const en4 = await panel();
const cEn4 = await canvas();
ok('★ 再切英文：面板文本还是 Stop、字号 30；画布 Stop / 30px',
  en4.text === 'Stop' && en4.font === '30'
  && !!cEn4 && cEn4.text.includes('Stop') && Math.abs(cEn4.px - 30) < 0.3,
  JSON.stringify({ panel: en4, canvas: cEn4 }));

/* ═══════════ 7. 导出的翻译表：en 列是 Stop ═══════════ */
const csvRow = await page.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  const csv = i18n.exportTranslationCsv(['en']);
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(',');
  const idx = head.indexOf('en');
  const line = lines.find(l => l.split(',')[3] === '启动') || '';
  const cells = line.split(',');
  return { idx, src: cells[3], en: idx >= 0 ? cells[idx] : null, head: head.slice(0, 8) };
});
ok('★ 导出的翻译表：原文「启动」那一行的 en 列是 Stop',
  csvRow.idx >= 0 && csvRow.src === '启动' && csvRow.en === 'Stop',
  JSON.stringify(csvRow));

/* ═══════════ 8. 默认语言下改文本：改的仍是原文（不是译文） ═══════════ */
await setLang('zh-CN');
await sleep(400);
await setProp('text', '运行');
await sleep(500);
const stDef = await state();
const zh3 = await panel();
const cZh3 = await canvas();
ok('★ 默认语言下改文本=运行 → 改的是**原文 prop**（dict.en 里的旧译文不动）',
  stDef.rawText === '运行' && stDef.dictEn['启动'] === 'Stop' && zh3.text === '运行'
  && !!cZh3 && cZh3.text.includes('运行'),
  JSON.stringify({ raw: stDef.rawText, dictEn: stDef.dictEn, panel: zh3.text }));

/* ═══════════ 9. 新原文没译文：切英文显示原文（不串旧译文） ═══════════ */
await setLang('en');
await sleep(450);
const en5 = await panel();
const stEn5 = await state();
ok('切英文：新原文「运行」没有译文 → 面板显示原文「运行」（不串旧译文 Stop）',
  en5.text === '运行' && stEn5.dictEn['运行'] === undefined && stEn5.dictEn['启动'] === 'Stop',
  JSON.stringify({ panel: en5.text, dictEn: stEn5.dictEn }));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 属性面板多语言（文本/字号）回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
