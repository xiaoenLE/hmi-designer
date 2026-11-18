// verify-cursor.mjs — 光标语义：不是输入框的地方不许出现文本输入光标（I 形），
// 该有的光标（pointer / move / grab / col-resize / resize 柄）一个都不能少
// 用法：先启动 8866 服务，再 node test/verify-cursor.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => window.app.exitRun?.());

/** 取第一个匹配元素的 computed cursor（找不到返回 'MISSING'） */
const cur = sel => page.evaluate(s => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).cursor : 'MISSING';
}, sel);

/* ══════ 1. 编辑器：不是输入框、也不可点击的地方必须是箭头 ══════ */
const flat = {
  '工具栏标题': await cur('#toolbar .tb-logo span'),
  '工具栏分组标签': await cur('#toolbar .tb-label'),
  '状态栏坐标文字': await cur('#stPos'),
  '属性面板字段标签': await cur('#propBody .f-label'),
  '画布顶部页面名': await cur('#pageTitle'),
};
const notDefault = Object.entries(flat).filter(([, v]) => v !== 'default');
ok('编辑器里的纯文字不是 I 形光标（一律 default）', notDefault.length === 0,
  notDefault.map(([k, v]) => `${k}=${v}`).join(' , ') || JSON.stringify(flat));
ok('可点击的文字保持 pointer（属性分组标题）',
  (await cur('#propBody .prop-group-title')) === 'pointer', await cur('#propBody .prop-group-title'));
ok('停靠标签是可抓取的 grab（既能点也能拖）', (await cur('.lp-tab.active')) === 'grab', await cur('.lp-tab.active'));

/* ══════ 2. 编辑器：该有的光标还在 ══════ */
// 先选中一个控件，缩放柄才有 DOM
await page.evaluate(() => {
  const el = document.querySelector('#canvas .wd');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await page.waitForTimeout(200);
ok('画布控件仍是 move（可拖动）', (await cur('#canvas .wd')) === 'move', await cur('#canvas .wd'));
ok('控件里的文字跟随 move（不退回箭头）', (await cur('#canvas .w-label')) === 'move', await cur('#canvas .w-label'));
ok('工具箱条目仍是 grab', (await cur('.tb-item')) === 'grab', await cur('.tb-item'));
ok('工具箱条目内文字跟随 grab', (await cur('.tb-item .sub')) === 'grab', await cur('.tb-item .sub'));
ok('缩放柄仍是 ns-resize', (await cur('.sel-h-n')) === 'ns-resize', await cur('.sel-h-n'));
ok('面板分隔条仍是 col-resize', (await cur('#leftResizer')) === 'col-resize', await cur('#leftResizer'));
ok('工具栏按钮仍是 pointer', (await cur('#btnRun')) === 'pointer', await cur('#btnRun'));

/* 清单 / 页面行（先切到相应 tab） */
await page.click('.lp-tab[data-tab="list"]');
await page.waitForTimeout(150);
ok('清单行仍是 pointer', (await cur('#widgetList .wl-item')) === 'pointer', await cur('#widgetList .wl-item'));
ok('清单行内文字跟随 pointer', (await cur('#widgetList .wl-name')) === 'pointer', await cur('#widgetList .wl-name'));
await page.click('.lp-tab[data-tab="pages"]');
await page.waitForTimeout(150);
ok('页面行仍是 pointer', (await cur('.pg-item')) === 'pointer', await cur('.pg-item'));
ok('页面行内文字跟随 pointer', (await cur('.pg-item .pg-name')) === 'pointer', await cur('.pg-item .pg-name'));

/* ══════ 3. 真正的输入控件仍然保留 text 光标 ══════ */
ok('属性面板输入框仍是 text', (await cur('#propBody [data-fld="x"]')) === 'text', await cur('#propBody [data-fld="x"]'));
ok('属性面板复选框是箭头（不是 I 形）', ['default', 'pointer'].includes(await cur('#propBody .f-check')),
  await cur('#propBody .f-check'));
await page.click('.lp-tab[data-tab="vars"]');
await page.waitForTimeout(200);
ok('变量表输入框仍是 text', (await cur('#varTable input[data-k="name"]')) === 'text', await cur('#varTable input[data-k="name"]'));
ok('变量表类型下拉是箭头', (await cur('#varTable select[data-k="type"]')) === 'default', await cur('#varTable select[data-k="type"]'));

/* ══════ 4. 对话框 ══════ */
await page.click('#btnCanvasSetting');
await page.waitForTimeout(200);
ok('对话框标题/正文不是 I 形光标', (await cur('#dlgTitle')) === 'default' && (await cur('#dlgBox .f-label')) === 'default',
  `title=${await cur('#dlgTitle')} label=${await cur('#dlgBox .f-label')}`);
ok('对话框输入框仍是 text', (await cur('#csW')) === 'text', await cur('#csW'));
await page.click('#dlgCancel');
await page.waitForTimeout(150);

/* ══════ 5. 运行态：页面/弹窗/变量监控/软键盘 ══════ */
// 种子里是 number 控件，这里补一个旧版"数据输入"控件用于验证输入例外
await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('input', 420, 420);
  w.bindings.variable = 'rSetSpeed';
  pr.commit('测试输入控件');
});
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(500);
const runFlat = {
  '显示文本控件': await cur('#rtPage .w-label'),
  '数值控件': await cur('#rtPage .w-number'),
  '数值显示值': await cur('#rtPage .wn-val'),
  '变量监控变量名': await cur('.rtv-name'),
};
const runBad = Object.entries(runFlat).filter(([, v]) => v !== 'default');
ok('运行态纯显示元素不是 I 形光标（变量名等）', runBad.length === 0,
  runBad.map(([k, v]) => `${k}=${v}`).join(' , ') || JSON.stringify(runFlat));
ok('变量监控标题栏内文字保持 pointer（整条可点击）',
  ['pointer'].includes(await cur('.rtv-title')) && ['pointer'].includes(await cur('.rtv-count')),
  `${await cur('.rtv-title')} / ${await cur('.rtv-count')}`);
ok('运行态数据输入控件仍是 text（例外保留）', (await cur('#rtPage .w-input')) === 'text', await cur('#rtPage .w-input'));
ok('运行态按钮仍是 pointer', (await cur('#rtPage .wd-button')) === 'pointer', await cur('#rtPage .wd-button'));
ok('退出/适应窗口按钮是 pointer', (await cur('#rtExit')) === 'pointer' && (await cur('#rtFit')) === 'pointer',
  `${await cur('#rtExit')} / ${await cur('#rtFit')}`);
ok('变量监控标题栏可点击 → pointer', (await cur('#rtvHead')) === 'pointer', await cur('#rtvHead'));
ok('变量开关（label）是 pointer', (await cur('.rtv-switch')) === 'pointer', await cur('.rtv-switch'));
ok('变量开关滑块跟随 pointer', (await cur('.rtv-switch .track')) === 'pointer', await cur('.rtv-switch .track'));
ok('变量监控里的输入框仍是 text', (await cur('.rtv-row input.rtv-val')) === 'text', await cur('.rtv-row input.rtv-val'));

/* 软键盘 */
await page.evaluate(() => {
  const n = document.querySelector('#rtPage .w-number');
  n.click();
});
await page.waitForTimeout(250);
ok('软键盘显示屏不是 I 形光标', (await cur('#npDisplay')) === 'default', await cur('#npDisplay'));
ok('软键盘按键是 pointer', (await cur('#npKeys button')) === 'pointer', await cur('#npKeys button'));
ok('软键盘变量名不是 I 形光标（在可拖动标题栏内 → move）', ['move', 'default'].includes(await cur('.np-var')),
  await cur('.np-var'));
await page.evaluate(() => document.getElementById('npCancel').click());
await page.waitForTimeout(150);

/* 弹窗 */
await page.locator('#rtPage .wd-button', { hasText: '报警详情' }).click();
await page.waitForTimeout(300);
ok('弹窗正文区不是 I 形光标', (await cur('.rt-popup-body')) === 'default', await cur('.rt-popup-body'));
ok('弹窗内显示控件不是 I 形光标', (await cur('.rt-popup .w-label')) === 'default', await cur('.rt-popup .w-label'));
ok('弹窗标题栏仍是 move（可拖动）', (await cur('.rt-popup-head')) === 'move', await cur('.rt-popup-head'));
ok('弹窗标题文字跟随 move', (await cur('.rt-popup-head span')) === 'move', await cur('.rt-popup-head span'));
ok('弹窗关闭按钮是 pointer', (await cur('.rt-popup-close')) === 'pointer', await cur('.rt-popup-close'));
ok('模态遮罩不是 I 形光标', (await cur('.rt-popup-mask')) === 'default', await cur('.rt-popup-mask'));
await page.evaluate(() => document.querySelector('.rt-popup-close').click());
await page.evaluate(() => window.app.exitRun());

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 光标语义回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
