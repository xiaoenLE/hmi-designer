// verify-i18n-prop.mjs — 切换语言后，属性面板里的修改还生不生效？
//
// 现场问："切换语言后，属性中修改能不能生效"
//   现在的口径（属性面板跟随当前语言）：切到英文后，面板里的文本格显示的是**译文**、字号格显示的是
//   「这门语言下这个控件的生效 px」——
//   ① 切到英文后在面板改**文字**：写的是**当前语言的译文**（dict.en），原文 prop 不动；
//   ② 改**字号**：只改这个控件这门语言的覆盖 px（基础字号不动）；
//   ③ 改**颜色**：立刻变（颜色不分语言）；
//   ④ 切回中文：文字回原文、字号回基础值（英文下改的两样都不污染中文）。
//   默认语言下改文字仍然是改原文（见 verify-i18n-prop-edit）。
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-i18n-prop-'));
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

/* ── 0. 工程：一个标签 + en 语言（含 启动/停止 译文）+ 切到 en ── */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.replaceData({
    meta: {}, variables: [], alarms: [],
    pages: [{ id: 'pg1', name: '主画面', type: 'page', widgets: [
      { id: 'w1', type: 'label', x: 60, y: 60, w: 240, h: 60, z: 1,
        props: { text: '启动', fontSize: 24, textColor: '#1f2329', align: 'center' }, bindings: {}, actions: [] },
    ] }],
  });
  const i18n = await import('/js/core/i18n.js');
  i18n.addLanguage('en', 'English');
  const meta = project.data.meta = project.data.meta || {};
  meta.i18n = meta.i18n || { default: 'zh-CN', langs: [], dict: {}, scale: {} };
  meta.i18n.dict.en = { '启动': 'Start', '停止': 'Stop' };
  i18n.setLangScale('en', 90);            // 顺带验字号百分比
  project.commit('属性/多语言测试');
  const { select } = await import('/js/editor/canvas.js');
  select(['w1']);
  i18n.setLang('en');
});
await sleep(600);

const snap = () => page.evaluate(() => {
  const box = document.querySelector('#canvas .wd[data-id="w1"]');
  const hit = [...(box ? box.querySelectorAll('*') : [])].find(n => (n.getAttribute('style') || '').indexOf('font-size') >= 0) || box;
  return {
    text: box ? box.textContent.trim() : null,
    px: hit ? parseFloat(getComputedStyle(hit).fontSize) : null,
    inline: hit ? (hit.getAttribute('style') || '') : '',
  };
});
/** 用**属性面板真实输入框**改一格（模拟现场） */
const setPanelProp = async (key, value) => {
  const okFound = await page.evaluate(([k, v]) => {
    const inp = document.querySelector(`#propBody [data-prop="${k}"]`);
    if (!inp) return false;
    inp.value = v;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [key, value]);
  await sleep(450);
  return okFound;
};

/* ── 1. 切英文后：属性面板显示译文，改文字 → 写当前语言译文（原文不动） ── */
let s = await snap();
ok('切到英文后画布显示译文（24 × 90% = 21.6px）',
  s.text === 'Start' && Math.abs(s.px - 21.6) < 0.3, JSON.stringify(s));
const panelText = await page.evaluate(() => {
  const i = document.querySelector('#propBody [data-prop="text"]');
  return i ? i.value : null;
});
ok('切英文后属性面板文本格显示译文 Start', panelText === 'Start', JSON.stringify(panelText));
ok('属性面板能改文字（真实输入框存在）', await setPanelProp('text', 'Stop'));
s = await snap();
const afterText = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const i18n = await import('/js/core/i18n.js');
  const w = project.getWidget('w1');
  return { raw: w.props.text, dictEn: i18n.i18nState().dict.en };
});
ok('★ 切语言后改文字：画布立刻变 Stop；**只写译文 dict.en，原文 prop 仍「启动」**',
  s.text === 'Stop' && afterText.raw === '启动' && afterText.dictEn['启动'] === 'Stop',
  JSON.stringify({ canvas: s.text, ...afterText }));

/* ── 2. 改字号：只改这个控件这门语言的覆盖 px（基础字号不动，画布 = 覆盖值） ── */
await setPanelProp('fontSize', 30);
s = await snap();
const afterFont = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const i18n = await import('/js/core/i18n.js');
  const w = project.getWidget('w1');
  return { base: w.props.fontSize, wsize: i18n.i18nState().wsize.en };
});
ok('★ 切语言后改字号：画布 30px；只写 wsize.en 覆盖，基础字号仍 24',
  Math.abs(s.px - 30) < 0.3 && /font-size:30px/.test(s.inline)
  && Number(afterFont.base) === 24 && Number(afterFont.wsize['w1|fontSize']) === 30,
  JSON.stringify({ px: s.px, inline: s.inline, ...afterFont }));

/* ── 3. 改颜色：立刻生效（颜色不分语言） ── */
await setPanelProp('textColor', '#ff0000');
s = await snap();
ok('★ 切语言后改颜色：画布文字立刻变红', /color:#ff0000/.test(s.inline), JSON.stringify(s.inline));

/* ── 4. 再改当前语言译文：画布跟着变（不会串回旧译文） ── */
await setPanelProp('text', '报警测试');
s = await snap();
ok('英文下再改译文 → 画布显示新译文（不是旧译文）', s.text === '报警测试', JSON.stringify(s));

/* ── 5. 切回中文：文字回原文、字号回基础值 24px（英文覆盖不污染中文） ── */
await page.evaluate(async () => { (await import('/js/core/i18n.js')).setLang('zh-CN'); });
await sleep(500);
s = await snap();
const zhPanel = await page.evaluate(() => {
  const q = (k) => document.querySelector(`#propBody [data-prop="${k}"]`);
  return { text: q('text') ? q('text').value : null, font: q('fontSize') ? q('fontSize').value : null };
});
ok('切回中文：文字回原文「启动」、字号回基础值 24px；面板也跟着回原文/24',
  s.text === '启动' && Math.abs(s.px - 24) < 0.3 && zhPanel.text === '启动' && zhPanel.font === '24',
  JSON.stringify({ px: s.px, text: s.text, panel: zhPanel }));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 切语言后属性修改回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
