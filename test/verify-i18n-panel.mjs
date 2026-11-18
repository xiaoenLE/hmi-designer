// verify-i18n-panel.mjs — 「多语言 / 翻译…」对话框（工程 ▾）回归：
//   ① 工程菜单里有这一项、点了能打开对话框（语言区：默认语言那行标「原文」、不可删）
//   ② 添加语言（en）→ languages() 含它、语言列表/预览下拉都跟着长出来
//   ③ 导出翻译表 CSV → 表头 分类,位置,字段,原文,en；已有原文（按钮的「启动」）在表里
//   ④ 导入填好译文的 CSV → meta.i18n.dict.en['启动'] === 'Start'；预览切到 en → 编辑画布上的按钮显示 Start
//   ⑤ 删语言 → languages() 不含它、译文一起删、预览自动退回默认语言（画布文字变回原文）
//   ＋ 关对话框时改过就 project.commit('多语言设置') 一次（工程变脏、能一步撤销）
// 用法：node test/verify-i18n-panel.mjs   （自己拉起独立数据目录的后端，不碰 8866 上那套）
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
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18n-panel-'));
const TMP_CSV = path.join(os.tmpdir(), `hmi-i18n-import-${process.pid}-${Date.now()}.csv`);
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
page.on('dialog', d => d.accept());               // 删除语言 / 设为默认 的 confirm 一律点「确定」
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ── 先造一个按钮控件（原文「启动」）：导出翻译表时要能看见它 ── */
const btnId = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const b = project.addWidget('button', 40, 60);
  project.updateWidgetField(b.id, 'w', 120);
  project.updateWidgetField(b.id, 'h', 46);
  // 关掉「状态显示」：默认会绑变量表第一个变量，false 时文字会变成「关」，盖掉我们要验的原文
  project.updateWidgetProp(b.id, 'showState', false);   // 兼容旧调用；按钮仍按条件显示
  project.updateWidgetProp(b.id, 'text', '启动');
  project.commit('多语言测试：先造一个按钮');
  return b.id;
});
await sleep(400);
const beforeText = await page.evaluate(id =>
  document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`)?.textContent, btnId);
ok('（前提）画布上按钮文字是「启动」', beforeText === '启动', String(beforeText));

/* ═══════════ ① 工程菜单入口 + 打开对话框 ═══════════ */
await page.click('#btnProjMenu');
await sleep(150);
const menuLabels = await page.$$eval('#ctxMenu .ctx-item .ctx-label', els => els.map(e => e.textContent.trim()));
ok('工程菜单里出现「多语言 / 翻译…」', menuLabels.includes('多语言 / 翻译…'), menuLabels.join(' | '));

await page.evaluate(() => {
  const hit = [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .find(b => b.textContent.includes('多语言 / 翻译…'));
  if (hit) hit.click();
});
await page.waitForFunction(() => {
  const m = document.getElementById('dlgMask');
  return m && !m.classList.contains('hidden')
    && document.getElementById('dlgTitle').textContent.includes('多语言');
}, null, { timeout: 6000 });
await sleep(250);
const dlgState = await page.evaluate(async () => {
  const m = await import('/js/core/i18n.js');
  const row = document.querySelector('#i18nLangs .i18n-lang-row');
  return {
    title: document.getElementById('dlgTitle').textContent,
    rows: [...document.querySelectorAll('#i18nLangs .i18n-lang-row')].map(r => r.dataset.lang),
    defRowText: row ? row.textContent.replace(/\s+/g, ' ') : '',
    hasDel: !!row?.querySelector('[data-lang-del]'),
    hasDefaultBtn: !!row?.querySelector('[data-lang-default]'),
    hasOriginalBadge: !!row?.querySelector('.badge.blue'),
    uiTotal: document.getElementById('i18nTotal')?.textContent,
    realTotal: m.collectEntries().length,
    preview: [...document.querySelectorAll('#i18nLangPreview option')].map(o => o.value),
    status: document.getElementById('i18nStatus')?.textContent || '',
  };
});
ok('点菜单项打开「多语言 / 翻译」对话框', dlgState.title.includes('多语言'), dlgState.title);
ok('语言区先列出默认语言一行（标「原文」、没有删除/设为默认按钮）',
  dlgState.rows.length === 1 && dlgState.hasOriginalBadge && !dlgState.hasDel && !dlgState.hasDefaultBtn,
  JSON.stringify({ rows: dlgState.rows, badge: dlgState.hasOriginalBadge, del: dlgState.hasDel }));
ok('默认语言那行文字里有「原文」', dlgState.defRowText.includes('原文'), dlgState.defRowText);
ok('显示的「可翻译文字」条数 = collectEntries().length（且不是 0）',
  Number(dlgState.uiTotal) === dlgState.realTotal && dlgState.realTotal > 0,
  `UI ${dlgState.uiTotal} / 实际 ${dlgState.realTotal}`);
ok('预览语言下拉目前只有默认语言', dlgState.preview.length === 1, dlgState.preview.join(','));

/* ═══════════ ② 添加语言 en ═══════════ */
await page.fill('#i18nLangCode', 'en');
await page.click('#i18nAddLang');
await sleep(250);
const afterAdd = await page.evaluate(async () => {
  const m = await import('/js/core/i18n.js');
  const rows = [...document.querySelectorAll('#i18nLangs .i18n-lang-row')];
  return {
    langs: m.languages(),
    rowCodes: rows.map(r => r.dataset.lang),
    rowTexts: rows.map(r => r.textContent.replace(/\s+/g, ' ')),
    preview: [...document.querySelectorAll('#i18nLangPreview option')].map(o => o.value),
    status: document.getElementById('i18nStatus')?.textContent || '',
  };
});
const enLang = afterAdd.langs.find(l => l.code === 'en');
ok('添加 en 后 languages() 含它', !!enLang, JSON.stringify(afterAdd.langs.map(l => l.code)));
ok('显示名留空 → 用内置名 English', enLang?.label === 'English', String(enLang?.label));
ok('语言列表多出一行 en，并显示「已翻译 0 条」',
  afterAdd.rowCodes.includes('en')
  && afterAdd.rowTexts.some(t => t.includes('en') && t.includes('已翻译 0 条')),
  JSON.stringify(afterAdd.rowTexts));
ok('预览下拉里也有了 en', afterAdd.preview.includes('en'), afterAdd.preview.join(','));
ok('添加成功有状态提示', /已添加语言\s*en/.test(afterAdd.status), afterAdd.status);

/* ═══════════ ③ 导出翻译表 CSV ═══════════ */
// ⚠ 浏览器里点导出默认弹系统的「另存为」框，自动化点不了原生框 —— 先摘掉它，验"退回下载"那条路
await page.evaluate(() => { delete window.showSaveFilePicker; });
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#i18nExport'),
]);
const csvPath = await dl.path();
const csv = fs.readFileSync(csvPath, 'utf8');
const headerLine = csv.replace(/^\uFEFF/, '').split(/\r\n/)[0];
ok('导出翻译表 CSV：文件名是「<工程名>-翻译表.csv」', /-翻译表\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
ok('CSV 表头 = 分类,位置,字段,原文,控件ID,字号px,en,English字号%,English字号px（控件ID + 字号% + 该控件各语言字号px）',
  headerLine === '分类,位置,字段,原文,控件ID,字号px,en,English字号%,English字号px', headerLine);
const hitRow = csv.split(/\r\n/).find(l => l.split(',')[3] === '启动');
ok('CSV 里有刚造的按钮原文「启动」（原文列一格就是它）', !!hitRow, hitRow || '(没找到)');
ok('★ CSV 每行带「字号px」（控件字号，数字）', !!hitRow && /^\d+(\.\d+)?$/.test(hitRow.split(',')[5]),
  hitRow ? hitRow.split(',')[5] : '(没找到)');
ok('CSV 每行都带这门语言的字号%（默认 100）', !!hitRow && hitRow.split(',')[7] === '100',
  hitRow ? hitRow.split(',')[7] : '(没找到)');
ok('CSV 带 UTF-8 BOM + CRLF（Excel 打开中文不乱码）',
  csv.charCodeAt(0) === 0xFEFF && csv.includes('\r\n'), 'U+' + csv.charCodeAt(0).toString(16).toUpperCase());
ok('导出后状态行说已导出', await page.evaluate(() =>
  /已导出/.test(document.getElementById('i18nStatus')?.textContent || '')), '');

/* ═══════════ ④ 导入填好译文的 CSV + 预览切语言 ═══════════ */
const CSV_IN = '\uFEFF分类,位置,字段,原文,en,English字号%\r\n控件,x,文本,启动,Start,85\r\n';
fs.writeFileSync(TMP_CSV, CSV_IN, 'utf-8');
await page.setInputFiles('#i18nCsvFile', TMP_CSV);
await sleep(500);
const imported = await page.evaluate(async () => {
  const m = await import('/js/core/i18n.js');
  const { project } = await import('/js/core/project.js');
  return {
    dict: project.data.meta?.i18n?.dict?.en || {},
    count: m.translationCount('en'),
    scale: m.langScale('en'),
    rowTexts: [...document.querySelectorAll('#i18nLangs .i18n-lang-row')]
      .map(r => r.textContent.replace(/\s+/g, ' ')),
    status: document.getElementById('i18nStatus')?.textContent || '',
  };
});
ok("导入后 meta.i18n.dict.en['启动'] === 'Start'", imported.dict['启动'] === 'Start',
  JSON.stringify(imported.dict));
ok('★ 导入时「字号%」列也生效：en 的字号比例 = 85', imported.scale === 85, String(imported.scale));
ok('状态行报告「填了 1 条 / 跳过 0 条」', /填了\s*1\s*条\s*\/\s*跳过\s*0\s*条/.test(imported.status), imported.status);
ok('译文计数跟着变（en 已翻译 1 条）',
  imported.count === 1 && imported.rowTexts.some(t => t.includes('已翻译 1 条')),
  JSON.stringify({ count: imported.count, rows: imported.rowTexts }));

await page.selectOption('#i18nLangPreview', 'en');
await sleep(450);
const preview = await page.evaluate(async (id) => {
  const m = await import('/js/core/i18n.js');
  const el = document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`);
  return {
    lang: m.getLang(),
    text: el?.textContent,
    status: document.getElementById('i18nStatus')?.textContent || '',
    selected: document.getElementById('i18nLangPreview')?.value,
  };
}, btnId);
ok('预览切到 en：getLang() = en、下拉选中 en', preview.lang === 'en' && preview.selected === 'en',
  JSON.stringify({ lang: preview.lang, selected: preview.selected }));
ok('★ 切语言到 en 后画布上按钮显示 Start', preview.text === 'Start', String(preview.text));

/* ═══════════ ⑤ 删除语言 ═══════════ */
await page.click('#i18nLangs [data-lang-del="en"]');    // confirm 已被 page.on('dialog') 自动确定
await sleep(450);
const afterDel = await page.evaluate(async (id) => {
  const m = await import('/js/core/i18n.js');
  const { project } = await import('/js/core/project.js');
  const el = document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`);
  return {
    langs: m.languages().map(l => l.code),
    dictEn: project.data.meta?.i18n?.dict?.en,
    lang: m.getLang(),
    text: el?.textContent,
    rows: [...document.querySelectorAll('#i18nLangs .i18n-lang-row')].map(r => r.dataset.lang),
    status: document.getElementById('i18nStatus')?.textContent || '',
  };
}, btnId);
ok('删语言后 languages() 不含 en', !afterDel.langs.includes('en'), afterDel.langs.join(','));
ok('那门语言的译文一起删掉了（meta.i18n.dict.en 没了）', afterDel.dictEn === undefined,
  JSON.stringify(afterDel.dictEn));
ok('删的是预览中的语言 → 自动退回默认语言', afterDel.lang !== 'en', afterDel.lang);
ok('画布按钮文字跟着变回原文「启动」', afterDel.text === '启动', String(afterDel.text));
ok('语言列表回到只有默认语言一行', afterDel.rows.length === 1, afterDel.rows.join(','));

/* ═══════════ ＋ 语言管理：设为默认语言（原文换语言，原默认语言保留成一门可翻译语言） ═══════════ */
await page.fill('#i18nLangCode', 'ja');
await page.click('#i18nAddLang');
await sleep(250);
await page.click('#i18nLangs [data-lang-default="ja"]');   // confirm 已被 page.on('dialog') 自动确定
await sleep(400);
const afterDef = await page.evaluate(async () => {
  const m = await import('/js/core/i18n.js');
  const rows = [...document.querySelectorAll('#i18nLangs .i18n-lang-row')].map(r => ({
    code: r.dataset.lang,
    isDef: !!r.querySelector('.badge.blue'),
    hasDel: !!r.querySelector('[data-lang-del]'),
    text: r.textContent.replace(/\s+/g, ' '),
  }));
  return {
    def: m.defaultLang(),
    lang: m.getLang(),
    langs: m.languages().map(l => l.code),
    rows,
    status: document.getElementById('i18nStatus')?.textContent || '',
  };
});
ok('设为默认语言：defaultLang() 变成 ja、预览也切到 ja',
  afterDef.def === 'ja' && afterDef.lang === 'ja', JSON.stringify({ def: afterDef.def, lang: afterDef.lang }));
ok('原默认语言保留成一门可翻译语言（zh-CN 那行变成可删），ja 那行标「原文」',
  afterDef.langs.includes('zh-CN')
  && afterDef.rows.some(r => r.code === 'zh-CN' && !r.isDef && r.hasDel)
  && afterDef.rows.some(r => r.code === 'ja' && r.isDef),
  JSON.stringify(afterDef.rows));

/* ═══════════ ＋ 关对话框：改过就提交一次（工程变脏、能一步撤销） ═══════════ */
await page.click('#dlgOk');
await sleep(450);
const closed = await page.evaluate(async () => {
  const { history } = await import('/js/core/history.js');
  return {
    hidden: document.getElementById('dlgMask').classList.contains('hidden'),
    label: history.lastLabel(),
    canUndo: history.canUndo(),
  };
});
ok('关闭对话框后提交一次「多语言设置」（能撤销）',
  closed.hidden && closed.label === '多语言设置' && closed.canUndo === true, JSON.stringify(closed));

/* ═══════════ ＋ 取消关对话框也要提交（改动是即时生效的，「取消」只是关窗口） ═══════════ */
await page.click('#btnProjMenu');
await sleep(150);
await page.evaluate(() => {
  const hit = [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .find(b => b.textContent.includes('多语言 / 翻译…'));
  if (hit) hit.click();
});
await page.waitForFunction(() =>
  !document.getElementById('dlgMask').classList.contains('hidden'), null, { timeout: 6000 });
await sleep(250);
await page.fill('#i18nLangCode', 'de');
await page.click('#i18nAddLang');
await sleep(200);
await page.click('#dlgCancel');
await sleep(400);
const cancelPath = await page.evaluate(async () => {
  const m = await import('/js/core/i18n.js');
  const { history } = await import('/js/core/history.js');
  return {
    hidden: document.getElementById('dlgMask').classList.contains('hidden'),
    langs: m.languages().map(l => l.code),
    label: history.lastLabel(),
  };
});
ok('取消关对话框：改过的语言表照样提交一次「多语言设置」（能撤销）',
  cancelPath.hidden && cancelPath.langs.includes('de') && cancelPath.label === '多语言设置',
  JSON.stringify(cancelPath));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.unlinkSync(TMP_CSV); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 多语言 / 翻译对话框回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
