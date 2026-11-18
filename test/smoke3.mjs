// smoke3.mjs — 第 2 轮 4 项修复验证
import { createRequire } from 'node:module';
// ESM 不认 NODE_PATH，用 createRequire 锚定到托管 node workspace 找 playwright-core
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8866/';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);

// ══ 问题3：变量类型 uint/udint/lreal ══
const types = await page.evaluate(() => {
  const p = window.app.project;
  const opts = [...document.querySelectorAll('#varTable select[data-k="type"] option')].map(o => o.value);
  return { opts };
});
check('变量类型含 uint/udint/dint/lreal', ['uint', 'udint', 'dint', 'lreal'].every(t => types.opts.includes(t)),
  JSON.stringify(types.opts));

// 类型转换正确性（uint 非负、lreal 浮点）
const castOk = await page.evaluate(() => {
  const p = window.app.project;
  p.addVariable(); const a = p.variables().at(-1); p.updateVariable(a.name, { name: 't_uint', type: 'uint' });
  p.addVariable(); const b = p.variables().at(-1); p.updateVariable(b.name, { name: 't_lreal', type: 'lreal' });
  // 直接通过运行态变量抽屉逻辑：创建 number 绑定 uint 变量并提交 -5 应被钳为 0
  const w = p.addWidget('number', 10, 450);
  p.updateWidgetField(w.id, 'bindings.variable', 't_uint');
  return { hasUint: !!p.variables().find(v => v.name === 't_uint' && v.type === 'uint'), hasLreal: !!p.variables().find(v => v.name === 't_lreal' && v.type === 'lreal') };
});
check('新增 uint/lreal 变量成功', castOk.hasUint && castOk.hasLreal);

// ══ 问题1：number 可输入/只读属性 ══
const editable = await page.evaluate(() => {
  const p = window.app.project;
  const ro = p.addWidget('number', 10, 500);
  p.updateWidgetProp(ro.id, 'editable', false);
  const rw = p.addWidget('number', 200, 500);
  return {
    ro: document.querySelector(`#canvas .wd[data-id="${ro.id}"] .w-number`)?.classList.contains('editable'),
    rw: document.querySelector(`#canvas .wd[data-id="${rw.id}"] .w-number`)?.classList.contains('editable'),
  };
});
check('number 只读/可输入属性（editable class）', editable.ro === false && editable.rw === true, JSON.stringify(editable));

// ══ 问题2：label 无前导空白且不裁 ══
const labelClean = await page.evaluate(() => {
  const p = window.app.project;
  const w = p.addWidget('label', 10, 560);
  p.updateWidgetProp(w.id, 'text', '测试文字');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"] .w-label`);
  return { text: el.textContent, scrollH: el.scrollHeight, clientH: el.clientHeight };
});
check('label 无前导空白且不裁', labelClean.text === '测试文字' && labelClean.scrollH <= labelClean.clientH + 2,
  JSON.stringify(labelClean));

// ══ 问题4：控件清单 + 定位跳转 ══
await page.click('.lp-tab[data-tab="list"]');
await page.waitForTimeout(200);
const listCount = await page.evaluate(() => document.querySelectorAll('#widgetList .wl-item').length);
check('清单列出当前页控件', listCount > 0, `count=${listCount}`);

// 清单含配置摘要（地址/动作）
const hasInfo = await page.evaluate(() => {
  const infos = [...document.querySelectorAll('#widgetList .wl-info')].map(e => e.textContent).filter(Boolean);
  return infos.length;
});
check('清单显示地址/动作摘要', hasInfo > 0, `info=${hasInfo}`);

// 点击清单行 → 定位选中
await page.evaluate(() => document.querySelector('#widgetList .wl-item').click());
await page.waitForTimeout(300);
const selected = await page.evaluate(() => document.querySelectorAll('#canvas .wd.selected').length);
check('点击清单行 → 定位选中控件', selected >= 1, `selected=${selected}`);

// 跨页：下拉切到参数页，点行跳转
const jump = await page.evaluate(() => {
  const sel = document.getElementById('listPageSel');
  const paramId = window.app.project.pages().find(p => p.name === '参数设定').id;
  sel.value = paramId;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return paramId;
});
await page.waitForTimeout(200);
await page.evaluate(() => { const it = document.querySelector('#widgetList .wl-item'); if (it) it.click(); });
await page.waitForTimeout(400);
const currentPage = await page.evaluate(() => window.app.project.currentPage().name);
check('清单跨页跳转定位', currentPage === '参数设定', `current=${currentPage}`);

check('无 JS 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 第2轮修复：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
