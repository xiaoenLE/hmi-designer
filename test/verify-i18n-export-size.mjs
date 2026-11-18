// verify-i18n-export-size.mjs — 翻译表导出/导入要带上「各语言按控件字号」
//
// 现场问题：英文下给控件单独设的字号（meta.i18n.wsize[lang]['<控件id>|<字号prop>']，task-29 做的）
// 没进翻译表 CSV → 导出/导入/换机器后各语言字号对不上，只有本机编辑时正常。
// 本套件验：
//   ① collectEntries 每条带 widgetId / sizeKey
//   ② 导出表头含 控件ID、<语言>字号px；该行 en 字号px = 30（覆盖值）
//   ③ 删掉 wsize → 英文画布回 24px；把导出的 CSV 再导入 → wsize 恢复、英文画布 30px、中文 24px
//   ④ 老格式 CSV（没有 控件ID/字号px 列）照常导入不报错
//   ⑤ 无未捕获 JS 异常
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18n-size-'));
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

/* ── 0. 工程：一个标签「启动」字号 24 + en（译文 Start）；给 en 设专属字号 30 ── */
const setup = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const i18n = await import('/js/core/i18n.js');
  project.replaceData({
    meta: {}, variables: [], alarms: [],
    pages: [{ id: 'pg-es', name: '主画面', type: 'page', widgets: [
      { id: 'w-es', type: 'label', x: 60, y: 60, w: 240, h: 60, z: 1,
        props: { text: '启动', fontSize: 24, textColor: '#1f2329', align: 'center' }, bindings: {}, actions: [] },
    ] }],
  });
  i18n.addLanguage('en', 'English');
  const s = i18n.i18nState();
  s.dict = s.dict || {};
  s.dict.en = { '启动': 'Start' };
  // 在英文下把该控件字号设成 30（写 wsize.en['w-es|fontSize']=30）
  i18n.setLang('en');
  const w = project.getWidget('w-es');
  i18n.setWidgetFontPx(w, 'fontSize', 30);
  i18n.setLang('zh-CN');
  project.commit('翻译表字号测试');
  const es = i18n.collectEntries();
  const e = es.find(x => x.source === '启动') || {};
  return {
    wsizeEn: i18n.i18nState().wsize.en || {},
    widgetId: e.widgetId || '', sizeKey: e.sizeKey || '',
    entryCount: es.length,
  };
});
await sleep(400);
ok('collectEntries：控件行带 widgetId / sizeKey（w-es / fontSize）',
  setup.widgetId === 'w-es' && setup.sizeKey === 'fontSize',
  JSON.stringify({ widgetId: setup.widgetId, sizeKey: setup.sizeKey, n: setup.entryCount }));
ok('英文专属字号已写进 wsize.en（<控件id>|fontSize = 30）',
  Number(setup.wsizeEn['w-es|fontSize']) === 30, JSON.stringify(setup.wsizeEn));

/* ── 1. 导出：表头有 控件ID / English字号px；该行 en 字号px = 30 ── */
const exp = await page.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  const csv = i18n.exportTranslationCsv(['en']);
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(',');
  const row = lines.map(l => l.split(',')).find(c => c[3] === '启动') || [];
  const mi = (name) => head.indexOf(name);
  return { head, row, csv, idx: { id: mi('控件ID'), base: mi('字号px'), en: mi('en'), pct: mi('English字号%'), px: mi('English字号px') } };
});
ok('导出表头 = 分类,位置,字段,原文,控件ID,字号px,en,English字号%,English字号px',
  exp.head.join(',') === '分类,位置,字段,原文,控件ID,字号px,en,English字号%,English字号px',
  exp.head.join(','));
ok('导出控件行：控件ID = w-es、基础字号px = 24、en 译文 = Start',
  exp.row[exp.idx.id] === 'w-es' && exp.row[exp.idx.base] === '24' && exp.row[exp.idx.en] === 'Start',
  JSON.stringify(exp.row));
ok('★ 导出「English字号px」= 该控件英文下的生效字号 30（wsize 覆盖值）',
  exp.row[exp.idx.px] === '30' && exp.row[exp.idx.pct] === '100',
  JSON.stringify({ px: exp.row[exp.idx.px], pct: exp.row[exp.idx.pct] }));

/* ── 2. 删掉 wsize → 英文生效字号回到 24（模拟换机器/清掉本机覆盖） ── */
const cleared = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const i18n = await import('/js/core/i18n.js');
  const s = i18n.i18nState();
  s.wsize = {};
  const w = project.getWidget('w-es');
  i18n.setLang('en');
  const pxEn = i18n.widgetFontPx(w, 'fontSize');
  i18n.setLang('zh-CN');
  return { pxEn, wsize: s.wsize };
});
ok('删掉 wsize 后：英文生效字号回到 24（不再有 30 覆盖）',
  cleared.pxEn === 24 && !cleared.wsize.en, JSON.stringify({ pxEn: cleared.pxEn, wsize: cleared.wsize }));

/* ── 3. 把刚才导出的 CSV 再导入 → wsize 恢复，英文画布 30px、中文 24px ── */
const imp = await page.evaluate(async (csv) => {
  const i18n = await import('/js/core/i18n.js');
  const r = i18n.importTranslationCsv(csv);
  return { r, wsize: JSON.parse(JSON.stringify(i18n.i18nState().wsize)) };
}, exp.csv);
ok('★ 导入导出的翻译表 → wsize 恢复（w-es|fontSize = 30），导入结果 ok 且带字号写入计数',
  imp.r.ok && Number((imp.wsize.en || {})['w-es|fontSize']) === 30
  && imp.r.sizes >= 1 && imp.r.filled >= 1,
  JSON.stringify({ r: imp.r, wsize: imp.wsize }));

const canvasFont = () => page.evaluate(() => {
  const box = document.querySelector('#canvas .wd[data-id="w-es"]');
  if (!box) return null;
  const hit = [...box.querySelectorAll('*')].find(n => (n.getAttribute('style') || '').indexOf('font-size') >= 0) || box;
  return { px: parseFloat(getComputedStyle(hit).fontSize), text: box.textContent.trim() };
});
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('en'); });
await sleep(450);
const enFont = await canvasFont();
ok('★ 导入后切英文：画布字号 30px、文字 Start',
  enFont && Math.abs(enFont.px - 30) < 0.3 && enFont.text === 'Start', JSON.stringify(enFont));
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('zh-CN'); });
await sleep(450);
const zhFont = await canvasFont();
ok('导入后切中文：画布字号回到基础 24px、文字「启动」',
  zhFont && Math.abs(zhFont.px - 24) < 0.3 && zhFont.text === '启动', JSON.stringify(zhFont));

/* ── 4. 老格式 CSV（没有 控件ID / <语言>字号px 列）照常导入、不报错 ── */
const old = await page.evaluate(async () => {
  const i18n = await import('/js/core/i18n.js');
  const csv = '\uFEFF分类,位置,字段,原文,字号px,en,English字号%\r\n控件,x,文本,启动,15,StartOld,100\r\n';
  let r = null, err = '';
  try { r = i18n.importTranslationCsv(csv); } catch (e) { err = String(e && e.message || e); }
  return { r, err, dict: (i18n.i18nState().dict.en || {})['启动'], wsize: JSON.parse(JSON.stringify(i18n.i18nState().wsize)) };
});
ok('老格式 CSV（无 控件ID/字号px 列）导入不报错，译文照常生效',
  !!old.r && old.r.ok && old.err === '' && old.dict === 'StartOld' && old.r.sizes === 0,
  JSON.stringify(old));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 翻译表各语言字号导出/导入回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
