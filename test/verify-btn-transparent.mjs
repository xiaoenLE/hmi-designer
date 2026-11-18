// verify-btn-transparent.mjs — 按钮透明背景修复（非法 CSS 回落蓝色渐变 bug）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });

/* 后端隔离 */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
}));

/* ── 准备：4 个按钮覆盖各场景 + 1 个透明圆 ── */
const ids = await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.addVariable(); m.project.updateVariable('var1', { name: 'bRun', type: 'bool', value: false });
  const mk = (props, pos) => {
    const w = m.project.addWidget('button', pos, 40);
    // ⚠ 按钮新建时默认绑定变量表第一个变量（defaultBind），绑上又有值就会走「状态显示」那一路
    //   （背景变成状态色），这里要验的是**静态透明背景**，所以显式解绑 —— 别依赖
    //   "种子工程里恰好没有这个名字的变量"（内置模板里就有个 bRun，靠巧合会误红）
    m.project.updateWidgetField(w.id, 'bindings.variable', '');
    Object.entries(props).forEach(([k, v]) => {
      m.project.updateWidgetProp(w.id, k, v);
      // 「背景色」两行已并入「未满底色」（状态显示常开）：没绑变量时画的就是未满态，
      // 所以验透明底要同时设 offColor（老工程载入时 project.js 也会把 bgColor 搬过来）
      if (k === 'bgColor') m.project.updateWidgetProp(w.id, 'offColor', v);
    });
    return w.id;
  };
  const bEmpty = mk({ bgColor: '' }, 40);                       // 点「透明」后的实际值
  const bTrans = mk({ bgColor: 'transparent' }, 170);           // 显式 transparent
  const bNormal = mk({ bgColor: '#2563eb' }, 300);              // 正常色（回归对照）
  const bEdge = mk({ bgColor: '', borderColor: '#111111' }, 430); // 透明底+自选边框
  const cT = (() => { const w = m.project.addWidget('circle', 560, 40);
    m.project.updateWidgetProp(w.id, 'bgColor', ''); return w.id; })();
  m.project.commit('透明按钮测试');
  return { bEmpty, bTrans, bNormal, bEdge, cT };
})());
await page.waitForTimeout(150);

/* 隔离渲染 */
const renderBtn = (wid, varsObj) => page.evaluate(async ([wid, varsObj]) => {
  const m = await import('/js/core/project.js');
  const r = await import('/js/widgets/registry.js');
  const w = m.project.getWidget(wid);
  return r.registry.get('button').render(w, 'run', { get: (n) => varsObj?.[n] });
}, [wid, varsObj]);

/* ── A. 渲染层 ── */
let h = await renderBtn(ids.bEmpty, {});
ok('bgColor="" → background:none', h.includes('background:none'), h.match(/background:[^;]+/)?.[0]);
ok('bgColor="" → 不再产生非法渐变', !h.includes('linear-gradient(180deg,dd,') && !h.includes('transparentdd'));
h = await renderBtn(ids.bTrans, {});
ok('bgColor="transparent" → background:none', h.includes('background:none'));
h = await renderBtn(ids.bNormal, {});
ok('正常色仍走渐变（回归对照）', h.includes('linear-gradient(180deg,#2563ebdd,#2563eb)'), h.match(/background:[^;]+/)?.[0]);
h = await renderBtn(ids.bEdge, {});
ok('透明底+自选边框色 → 边框用 borderColor', h.includes('background:none') && h.includes('border:1px solid #111111'), h.match(/border:[^;]+/)?.[0]);
h = await renderBtn(ids.bEmpty, {});
ok('透明底+无边框色 → 边框透明（纯文字按钮）', h.includes('border:1px solid transparent'), h.match(/border:[^;]+/)?.[0]);

/* 状态显示分支：变量有值 → onColor 渐变正常；变量无值 → 透明 */
const bState = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.addWidget('button', 40, 120);
  m.project.updateWidgetField(w.id, 'bindings.variable', 'bRun');
  m.project.updateWidgetProp(w.id, 'bgColor', '');   // 静态背景透明（老键）
  m.project.updateWidgetProp(w.id, 'offColor', '');  // 未满底色也透明
  m.project.commit('状态透明');
  return w.id;
});
h = await renderBtn(bState, {});                       // 变量无值 → 用静态透明背景
ok('状态显示但变量无值 → 保持透明', h.includes('background:none'));
h = await renderBtn(bState, { bRun: true });           // 有值 → onColor
ok('状态显示变量=true → onColor 渐变', h.includes('linear-gradient(180deg,#22c55edd,#22c55e)'), h.match(/background:[^;]+/)?.[0]);

/* ── B. 真实 DOM：编辑画布 computed style ── */
await page.click(`#canvas .wd[data-id="${ids.bEmpty}"]`);
await page.waitForTimeout(150);
const dom = await page.evaluate((wid) => {
  const el = document.querySelector(`#canvas .wd[data-id="${wid}"] .w-btn`);
  const cs = getComputedStyle(el);
  return { bgImg: cs.backgroundImage, bgColor: cs.backgroundColor };
}, ids.bEmpty);
ok('编辑画布：透明按钮无渐变背景图', dom.bgImg === 'none', dom.bgImg);
ok('编辑画布：背景色为全透明 rgba(0,0,0,0)', dom.bgColor === 'rgba(0, 0, 0, 0)', dom.bgColor);
const domN = await page.evaluate((wid) =>
  getComputedStyle(document.querySelector(`#canvas .wd[data-id="${wid}"] .w-btn`)).backgroundImage, ids.bNormal);
ok('编辑画布：正常按钮渐变仍在（回归对照）', domN.includes('linear-gradient'), domN.slice(0, 60));

/* ── C. 旧工程兼容：无 borderColor 键的老按钮 ── */
const legacy = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.addWidget('button', 170, 120);
  delete w.props.borderColor;   // 模拟旧工程控件
  // 旧工程没绑变量 → 画的是「未满」那一态，底色取未满底色（老键 bgColor 载入时已搬过来）
  m.project.updateWidgetProp(w.id, 'offColor', '#2563eb');
  m.project.commit('旧工程');
  return w.id;
});
const lh = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const r = await import('/js/widgets/registry.js');
  return r.registry.get('button').render(m.project.getWidget(wid), 'run', { get: () => null });
}, legacy);
ok('旧工程无 borderColor 键 → 边框跟随背景色', lh.includes('border:1px solid #2563eb'), lh.match(/border:[^;]+/)?.[0]);

/* ── D. 圆形透明顺手修复 ── */
const ch = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const r = await import('/js/widgets/registry.js');
  return r.registry.get('circle').render(m.project.getWidget(wid), 'run', { get: () => null });
}, ids.cT);
ok('圆 bgColor="" → background:transparent 且边框色保留（合法声明）',
  ch.includes('background:transparent') && ch.includes('solid #d97706'), ch.replace(/\s+/g, ' ').slice(0, 90));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
await browser.close();
process.exit(fails ? 1 : 0);
