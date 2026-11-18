// verify-fixes.mjs — 审计修复回归（2026-10 审计确认的 12 个 bug 逐条锁死）
// 用法：先启动 8866 服务，再 node test/verify-fixes.mjs [端口]
// 说明：全程 route 掉 /api/**，纯本地模拟，不会读写后端数据
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
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());   // 隔离后端
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

async function boot() {
  // ⚠ 先清掉本机存档再打开：boot 的意图是"回到演示工程"。
  //   不清的话，上一节 replaceData 写进 localStorage 的残缺工程会被读回来 ——
  //   下面按 pg_main / btn_popup 找控件的用例全落空（本项目里踩过）。
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('hmi-')) localStorage.removeItem(k);
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.evaluate(() => window.app.exitRun?.());
}
const newWidgetId = async (type, x, y, patch = {}) => page.evaluate(([type, x, y, patch]) => {
  const pr = window.app.project;
  const w = pr.addWidget(type, x, y);
  Object.assign(w, patch.fields || {});
  Object.assign(w.bindings, patch.bindings || {});
  Object.assign(w.props, patch.props || {});
  pr.commit('测试');
  return w.id;
}, [type, x, y, patch]);
/** 点一下画布上的控件把它选中（键盘操作需要选中态） */
const clickWidget = (id) => page.evaluate(id => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  if (!el) return false;
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return true;
}, id);

/* ══════ 1. 无 seedVersion 的工程（导入/读服务器）刷新后必须保留 ══════ */
await boot();
const persisted = await page.evaluate(async () => {
  const d = JSON.parse(JSON.stringify(window.app.project.data));
  delete d.meta.seedVersion;               // 老工程 / 导入 JSON 都没有这个键
  delete d.meta.template;
  d.meta.name = '用户自己的工程';
  window.app.project.replaceData(d);
  window.app.project.commit('t');
  await new Promise(r => setTimeout(r, 1400));   // 等自动保存 debounce
  return JSON.parse(localStorage.getItem('hmi-designer-project-v1') || '{}')?.meta?.name;
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
const keepName = await page.evaluate(() => window.app.project.data.meta.name);
ok('刷新后用户工程未被演示工程覆盖', persisted === '用户自己的工程' && keepName === '用户自己的工程',
  `localStorage=${persisted} 刷新后=${keepName}`);

/* ══════ 2. 残缺工程 JSON 不炸（normalize 补结构） ══════ */
const norm = await page.evaluate(() => {
  try {
    window.app.project.replaceData({ pages: [{ name: '缺字段页' }] });   // 没有 meta/canvas/variables/id
    const p = window.app.project.currentPage();
    const w = window.app.project.addWidget('label', 10, 10);
    const box = document.querySelector('#canvas').getBoundingClientRect();
    return { ok: true, canvasW: window.app.project.data.meta.canvas.w, page: p.name, widgetOk: !!w, box: box.width };
  } catch (e) { return { ok: false, err: String(e) }; }
});
ok('残缺工程 JSON 能加载且能继续加控件', norm.ok && norm.widgetOk && norm.canvasW === 1024, JSON.stringify(norm));

/* ══════ 3. 多层弹窗叠加居中（不是并排） ══════ */
await boot();
// ⚠ 不写死页/控件名（内置模板会换）：动作**挂到当前页第一个按钮上**，没有就现加一个。
//   注意别把模板自带的那一堆动作留着 —— 点一下先跳页就把弹窗那步带跑了。
const popBtn = await page.evaluate(() => {
  const pr = window.app.project;
  const pg2 = pr.addPage('popup');
  pg2.title = '第二层';
  const main = pr.pages()[0];
  pr.setCurrentPage(main.id);
  const first = pr.pages().find(p => p.type === 'popup' && p.id !== pg2.id) || pr.addPage('popup');
  let btn = main.widgets.find(w => w.type === 'button');
  if (!btn) { btn = pr.addWidget('button', 700, 500); btn.name = '弹窗按钮'; }
  btn.actions = [
    { trigger: 'click', type: 'showPopup', params: { page: first.id } },
    { trigger: 'click', type: 'showPopup', params: { page: pg2.id } },
  ];
  pr.commit('t');
  return { id: btn.id, name: btn.name };
});
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(300);
await page.locator(`#rtPage .wd[data-id="${popBtn.id}"]`).click();
await page.waitForTimeout(300);
const boxes = await page.evaluate(() => [...document.querySelectorAll('#rtPopupLayer .rt-popup')].map(el => {
  const r = el.getBoundingClientRect();
  return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), z: +getComputedStyle(el).zIndex };
}));
ok('两个弹窗叠在同一中心点（不再并排）',
  boxes.length === 2 && Math.abs(boxes[0].cx - boxes[1].cx) <= 2 && Math.abs(boxes[0].cy - boxes[1].cy) <= 2,
  JSON.stringify(boxes));
ok('后弹的层级更高', boxes[1]?.z > boxes[0]?.z, `z=${boxes[0]?.z},${boxes[1]?.z}`);
await page.evaluate(() => window.app.exitRun());

/* ══════ 4. 方向键微移不灌爆撤销栈（合并成 1 步） ══════ */
await boot();
const nudgeId = await newWidgetId('label', 700, 500);
await page.waitForTimeout(100);
await clickWidget(nudgeId);
await page.waitForTimeout(100);
const x0 = await page.evaluate(id => window.app.project.getWidget(id).x, nudgeId);
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
const xMoved = await page.evaluate(id => window.app.project.getWidget(id).x, nudgeId);
await page.evaluate(() => window.app.history.undo());
await page.waitForTimeout(100);
const xBack = await page.evaluate(id => window.app.project.getWidget(id).x, nudgeId);
ok('连按 30 次方向键后 1 次撤销即回到原位', xMoved === x0 + 30 && xBack === x0, `x ${x0} → ${xMoved} → 撤销后 ${xBack}`);

/* ══════ 5. 内联输入：再点输入框不抛异常、不丢输入 ══════ */
await boot();
// 变量名取工程里真实存在的（内置模板会换，写死 rSpeed 这种名字迟早落空）
const vNum = await page.evaluate(() => window.app.project.variables().find(v => v.type === 'real').name);
const inlineId = await newWidgetId('number', 600, 430, { props: { useKeyboard: false, editable: true }, bindings: { variable: vNum } });
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(200);
const errBefore = pageErrors.length;
const sel = `#rtPage .wd[data-id="${inlineId}"]`;
await page.locator(sel).click();
await page.waitForTimeout(120);
await page.keyboard.type('777');
const box2 = await page.locator(sel + ' .w-number').boundingBox();
await page.mouse.click(box2.x + 30, box2.y + box2.height / 2);   // 第 2 次点输入框本体
await page.waitForTimeout(200);
const afterClick = await page.evaluate(([id, vn]) => {
  const inp = document.querySelector(`#rtPage .wd[data-id="${id}"] input`);
  return { hasInput: !!inp, typed: inp?.value ?? null, store: window.app.varStore.get(vn) };
}, [inlineId, vNum]);
ok('内联输入再点一下不抛未捕获异常', pageErrors.length === errBefore, pageErrors.slice(errBefore).join(' | '));
ok('再点输入框不重置已输入内容（仍在编辑态、内容还是 777）',
  afterClick.hasInput && afterClick.typed === '777', JSON.stringify(afterClick));
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
const afterEnter = await page.evaluate(([id, vn]) => ({
  hasInput: !!document.querySelector(`#rtPage .wd[data-id="${id}"] input`),
  store: window.app.varStore.get(vn),
}), [inlineId, vNum]);
ok('回车提交 777 并退出编辑态', afterEnter.store === 777 && !afterEnter.hasInput, JSON.stringify(afterEnter));
await page.evaluate(() => window.app.exitRun());

/* ══════ 6. 软键盘：同一控件再点一下不重置已输入缓冲 ══════ */
await boot();
const vInt = await page.evaluate(() => window.app.project.variables().find(v => v.type === 'int').name);
const padId = await newWidgetId('number', 600, 500, { props: { useKeyboard: true, editable: true }, bindings: { variable: vInt } });
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(200);
const padSel = `#rtPage .wd[data-id="${padId}"]`;
await page.locator(padSel).click();
await page.waitForTimeout(150);
await page.locator('#npKeys button', { hasText: /^9$/ }).first().click();
const buf1 = await page.textContent('#npDisplay');
/* 键盘弹出时**默认盖着遮罩**（控件属性「屏蔽其他控件」，默认勾着）——
   画面上任何地方都点不动，所以"再点控件"要用真实鼠标点（Playwright 的 click 会一直等
   到超时，那是它的可点性检查，不是产品行为）：鼠标点在控件中心 → 命中的是遮罩，
   根本没点到控件，已输入的缓冲自然不会被重置。 */
const padBox2 = await page.locator(padSel).boundingBox();
await page.mouse.click(padBox2.x + padBox2.width / 2, padBox2.y + padBox2.height / 2);
await page.waitForTimeout(150);
const buf2 = await page.textContent('#npDisplay');
const maskOn = await page.evaluate(() => !document.getElementById('npMask').classList.contains('hidden'));
ok('软键盘输入中再点控件（被遮罩挡住）→ 缓冲保持', buf1.endsWith('9') && buf2 === buf1, `${buf1} → ${buf2}`);
ok('键盘弹出时遮罩盖着（默认屏蔽其他控件）', maskOn === true);
await page.locator('#npKeys button', { hasText: /^取消$/ }).first().click();
await page.waitForTimeout(150);
await page.evaluate(() => window.app.exitRun());

/* ══════ 7. 变量抽屉输入中，其它变量更新不夺焦点 ══════ */
await boot();
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(250);
// 进运行态抽屉整个收起（画面吃满整窗）—— 要摸抽屉里的输入框得先叫出来
await page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  rt.setVarsVisible(true);
});
await page.waitForTimeout(250);
const drawer = await page.evaluate(async () => {
  const inp = document.querySelector('.rtv-row input[type=number]');
  if (!inp) return { skip: true };
  const other = window.app.project.variables().find(v => v.type === 'real');
  inp.focus();
  window.app.varStore.applyRemote({ [other.name]: 33.3 });   // 模拟后端推送**别的**变量
  await new Promise(r => setTimeout(r, 30));
  return { stillFocused: document.activeElement === inp, inDom: document.body.contains(inp) };
});
ok('抽屉输入中遇到其它变量更新 → 焦点与节点都保留', drawer.stillFocused && drawer.inDom, JSON.stringify(drawer));
await page.evaluate(() => window.app.exitRun());

/* ══════ 8. 锁定控件不被 Delete 删除 ══════ */
await boot();
const lockId = await newWidgetId('rect', 800, 60, { fields: { locked: true } });
await page.waitForTimeout(120);
await page.evaluate(id => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, lockId);
await page.waitForTimeout(120);
await page.keyboard.press('Delete');
await page.waitForTimeout(120);
const stillThere = await page.evaluate(id => !!window.app.project.getWidget(id), lockId);
ok('锁定控件不被 Delete 删除', stillThere, `仍存在=${stillThere}`);

/* ══════ 9. 跨页面复制粘贴有效 ══════ */
await boot();
const copyId = await newWidgetId('circle', 500, 60);
await page.waitForTimeout(120);
await page.evaluate(id => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, copyId);
await page.keyboard.press('Control+c');
const page2 = await page.evaluate(() => { const p = window.app.project.addPage('page'); return p.id; });
await page.waitForTimeout(150);
await page.keyboard.press('Control+v');
await page.waitForTimeout(150);
const pasted = await page.evaluate(() => window.app.project.currentWidgets().map(w => w.type));
ok('复制后切页粘贴 → 控件出现在新页面', pasted.includes('circle'), JSON.stringify(pasted));

/* ══════ 10. 西侧缩放到下限：对边钉住，不瞬移 ══════ */
await boot();
const rszId = await newWidgetId('rect', 100, 120, { fields: { w: 150, h: 60 } });
await page.waitForTimeout(150);
await page.locator(`#canvas .wd[data-id="${rszId}"]`).click({ position: { x: 5, y: 5 } });
await page.waitForTimeout(150);
const hb = await page.locator('#canvas .sel-h-w').boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + 260, hb.y + hb.height / 2, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);
const rsz = await page.evaluate(id => { const w = window.app.project.getWidget(id); return { x: w.x, w: w.w }; }, rszId);
// 关键：左边界只允许往右收到最小尺寸附近，右边界必须钉在原处（原来会瞬移到 355..363）
ok('西侧拖过下限 → 右边界钉在原处（不跳到右边）',
  rsz.w === 8 && rsz.x > 100 && Math.abs((rsz.x + rsz.w) - 250) <= 5,
  `原 100..250 → 现 ${rsz.x}..${rsz.x + rsz.w} (w=${rsz.w})`);

/* ══════ 11. 字符串变量含引号 → 内联输入值不被截断 ══════ */
await boot();
const strId = await page.evaluate(() => {
  const pr = window.app.project;
  pr.variables().push({ name: 'sQuote', type: 'string', address: '', value: 'a"b' });
  const w = pr.addWidget('number', 620, 480);
  w.props.useKeyboard = false; w.bindings.variable = 'sQuote';
  pr.commit('t');
  return w.id;
});
await page.evaluate(() => { window.app.varStore.resetFrom(window.app.project.variables()); window.app.enterRun(); });
await page.waitForTimeout(200);
await page.locator(`#rtPage .wd[data-id="${strId}"]`).click();
await page.waitForTimeout(150);
const quoted = await page.evaluate(id => document.querySelector(`#rtPage .wd[data-id="${id}"] input`)?.value, strId);
ok('字符串含 " 时内联输入值完整', quoted === 'a"b', JSON.stringify(quoted));
await page.evaluate(() => window.app.exitRun());

/* ══════ 12. 未配置变量的动作：不产生垃圾键，属性面板标红 ══════ */
await boot();
const junk = await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('button', 400, 400);
  pr.updateWidgetActions(w.id, [{ trigger: 'click', type: 'tap', params: {} }]);
  pr.commit('t');
  return w.id;
});
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(200);
await page.locator(`#rtPage .wd-button`).last().click();
await page.waitForTimeout(150);
const keys = await page.evaluate(() => Object.keys(window.app.varStore.values).filter(k => k === '' || k === 'undefined' || k === 'null'));
ok('未配变量的动作不往 varStore 塞垃圾键', keys.length === 0, JSON.stringify(keys));
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(150);
const warn = await page.evaluate(id => {
  const pr = window.app.project;
  pr.setCurrentPage(pr.currentId);
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return null;
}, junk);
await page.waitForTimeout(200);
const illegal = await page.evaluate(() => ({
  hasWarn: !!document.querySelector('#propBody .act-invalid'),
  text: document.querySelector('#propBody .act-warn')?.textContent || '',
}));
ok('未配变量的动作在属性面板标红提示', illegal.hasWarn, illegal.text);

/* ══════ 13. 文本(label) 可配格式：不再原样吐 12.345678912 ══════ */
await boot();
const labelTxt = await page.evaluate(() => {
  const pr = window.app.project;
  pr.variables().push({ name: 'rFmt', type: 'real', address: '', value: 12.345678912 });
  const a = pr.addWidget('label', 500, 500);
  a.bindings.variable = 'rFmt';                       // 默认 %s → 原样
  const b = pr.addWidget('label', 500, 540);
  b.bindings.variable = 'rFmt'; b.props.fmt = '%.2f'; // 显式两位小数
  window.app.varStore.resetFrom(pr.variables());
  pr.commit('t');
  return {
    raw: document.querySelector(`#canvas .wd[data-id="${a.id}"] .w-label`)?.textContent,
    fmt: document.querySelector(`#canvas .wd[data-id="${b.id}"] .w-label`)?.textContent,
  };
});
ok('文本控件按格式显示（%.2f → 12.35）', labelTxt.raw === '12.345678912' && labelTxt.fmt === '12.35', JSON.stringify(labelTxt));

/* ══════ 14. 页面名不执行 HTML（导入的工程 JSON 带脚本也不怕） ══════ */
await boot();
const xss = await page.evaluate(() => {
  window.app.project.addPage('page');
  const p = window.app.project.currentPage();
  window.app.project.updatePage(p.id, { name: '<img src=x onerror="window.__xss=1">' });
  return { imgs: document.querySelectorAll('#pageList img').length, flag: !!window.__xss,
    shown: document.querySelector('#pageList .pg-name')?.textContent };
});
ok('页面名按文本渲染（无 HTML 注入）', xss.imgs === 0 && !xss.flag, JSON.stringify(xss));

/* ══════ 15. 全程无未捕获 JS 异常 ══════ */
ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 审计修复回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
