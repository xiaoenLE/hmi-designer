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

// 变量 a=int（老工程里 速度显示 就是绑 a 而控件写着 string，正好复现对不上）
const ids = await page.evaluate(() => {
  const m = window.app.project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'a', type: 'int', address: '%MW100', value: 7, len: 0 });
  m.data.variables.push({ name: 'r', type: 'real', address: '%MW102', value: 1.5, len: 0 });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const w = m.addWidget('value', 40, 40);
  w.name = 'v1'; w.bindings.variable = 'a'; w.props.dispType = 'string'; w.props.fmt = '%s';
  const w2 = m.addWidget('value', 40, 100);
  w2.name = 'v2'; w2.bindings.variable = 'r';
  m.commit('dtype 测试');
  return { v1: w.id, v2: w2.id };
});

const state = () => page.evaluate((id) => {
  const m = window.app.project;
  const w = m.getWidget(id);
  const vars = m.variables();
  return {
    widgetDisp: w.props.dispType, widgetFmt: w.props.fmt,
    varType: (vars.find(v => v.name === w.bindings.variable) || {}).type,
  };
}, ids.v1);

console.log('初始 (变量 a=int，控件却写 string):', JSON.stringify(await state()));

// 选中控件 → 属性面板的「数据类型」应该显示变量的类型 int
await page.evaluate(async (id) => {
  const c = await import('/js/editor/canvas.js');
  c.select([id]);
}, ids.v1);
await page.waitForTimeout(400);
const sel = await page.evaluate(() => {
  const s = document.querySelector('#propBody [data-dtype]');
  return s ? { value: s.value, title: s.title } : null;
});
console.log('属性面板「数据类型」显示:', JSON.stringify(sel), ' ← 期望 int（跟变量一致）');

// 在属性面板改成 float → 变量 a 的类型应该变成 real
await page.evaluate(() => {
  const s = document.querySelector('#propBody [data-dtype]');
  s.value = 'float';
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(500);
console.log('面板改成 float 后:', JSON.stringify(await state()), ' ← 期望 变量 a=real、控件 dispType=float');

// 反方向：在变量表把 r 改成 uint → 绑它的 v2 控件要跟着变
await page.evaluate(() => {
  const m = window.app.project;
  m.updateVariable('r', { type: 'uint' });
});
await page.waitForTimeout(300);
const v2 = await page.evaluate((id) => {
  const w = window.app.project.getWidget(id);
  return { dispType: w.props.dispType, fmt: w.props.fmt };
}, ids.v2);
console.log('变量表把 r 改成 uint 后，控件 v2:', JSON.stringify(v2), ' ← 期望 dispType=uint、fmt=%d');

console.log('PAGE ERRORS:', JSON.stringify(errs));
await browser.close();
