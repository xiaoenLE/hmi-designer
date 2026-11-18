import { createRequire } from 'node:module';
import { installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8878';
installNodeFetchPatch(BASE);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(600);

const wid = await page.evaluate(async () => {
  const m = window.app.project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'rTail', type: 'real', address: '%MW100', value: 0, len: 0 });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const inp = m.addWidget('input', 60, 60);
  inp.bindings.variable = 'rTail';
  inp.props.fmt = '%.1f';
  m.commit('input 测试');
  return inp.id;
});
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await page.waitForTimeout(800);

const dump = (tag) => page.evaluate(async ([wid, tag]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-input`);
  const st = await import('/js/runtime/varstore.js');
  return {
    tag,
    value: el?.value, shown: el?.dataset?.shown,
    store: st.varStore.get('rTail'),
    active: document.activeElement === el,
    sameEl: !!el,
  };
}, [wid, tag]);

await page.evaluate(async () => {
  (await import('/js/runtime/varstore.js')).varStore.set('rTail', 12.34567928314209, 'remote');
});
await page.waitForTimeout(300);
console.log('① 远端读回后 :', JSON.stringify(await dump('after-remote')));

// 复刻测试里那一步：聚焦 → 改值 → 失焦，都在同一次 evaluate 里
const r = await page.evaluate(async (wid) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-input`);
  const beforeVal = el.value, beforeShown = el.dataset.shown;
  el.focus();
  const focused = document.activeElement === el;
  el.value = '7.25';
  const midVal = el.value;
  el.blur();
  const st = await import('/js/runtime/varstore.js');
  return { beforeVal, beforeShown, focused, midVal, afterVal: el.value, store: st.varStore.get('rTail') };
}, wid);
console.log('② 聚焦/改值/失焦 :', JSON.stringify(r));

console.log('PAGE ERRORS:', JSON.stringify(errs));
await browser.close();
