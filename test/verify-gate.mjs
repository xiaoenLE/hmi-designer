// verify-gate.mjs — 控件「按条件启用」（变量判定）：不满足时**藏起来 / 锁住**
//
// 现场两条要求（其实是同一套判定 + 两种表现）：
//   ① 像权限锁那样锁住控件，但**开锁靠变量条件**（不是密码），支持多个变量 + 与/或/非；
//   ② 条件不满足时整个控件**不显示**，那块位置也点不了它。
// 属性：启用 gateOn / 不满足时 gateMode('hide' 看不见也点不了 | 'lock' 看得见但点不了)
//       / 条件之间 gateLogic('and' 与 | 'or' 或) / 条件表 gateConds[{v,op,val,not}]
// 判定与动作拦截：js/runtime/gate.js + runtime.js 的 applyGate/actAllowed/gateTick
//
// 用法：node tools/run-suites.mjs verify-gate
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(300);

/* ── 造画面：三个按钮叠着装（验证"藏起来之后那块位置谁接着响应"）+ 几个判定变量 ── */
const ids = await page.evaluate(() => {
  const pr = window.app.project;
  pr.data.variables.length = 0;
  pr.data.alarms.length = 0;
  const V = (name, type, address, value) => pr.data.variables.push({ name, type, address, value, len: 0 });
  V('bShow', 'bool', '%MX0.0', false);      // 判定：藏/显示
  V('bA', 'bool', '%MX0.1', false);         // 判定：与/或
  V('bB', 'bool', '%MX0.2', false);
  V('iMode', 'int', '%MW10', 0);            // 判定：数值（>= 比）
  V('bOut', 'bool', '%MX1.0', false);       // 被控对象的动作结果
  V('bUnder', 'bool', '%MX1.1', false);
  const pg = pr.pages()[0];
  pr.setCurrentPage(pg.id);
  pg.widgets.length = 0;
  const mk = (x, y, text, outVar) => {
    const w = pr.addWidget('button', x, y);
    pr.updateWidgetProp(w.id, 'text', text);
    pr.updateWidgetActions(w.id, [{ trigger: 'click', type: 'toggle', params: { variable: outVar } }]);
    return w.id;
  };
  const gate = mk(60, 120, '受控', 'bOut');        // 受条件控制
  const under = mk(60, 120, '底下那个', 'bUnder'); // 故意**压在同一位置**（后加的在上层）
  // 把"受控"抬到上面（后加的默认在上面，所以这里把 under 压下去）
  const gw = pr.getWidget(gate), uw = pr.getWidget(under);
  gw.z = 5; uw.z = 1;
  const lock = mk(300, 120, '锁住但看得见', 'bOut');
  const plain = mk(540, 120, '没配条件', 'bUnder');   // 老工程：行为一点不变
  // 点动按钮 + 条件（C2 用：按着的时候条件变不满足、控件被藏起来 → 松手不能卡在 TRUE）
  const tapW = pr.addWidget('button', 780, 120);
  pr.updateWidgetProp(tapW.id, 'text', '点动');
  pr.updateWidgetActions(tapW.id, [{ trigger: 'click', type: 'tap', params: { variable: 'bOut' } }]);
  pr.updateWidgetProp(tapW.id, 'gateOn', true);
  pr.updateWidgetProp(tapW.id, 'gateMode', 'hide');
  pr.updateWidgetProp(tapW.id, 'gateConds', [{ v: 'bShow', op: '==', val: 'true' }]);
  pr.commit('条件启用测试');
  return { gate, under, lock, plain, tap: tapW.id, page: pg.id };
});
await sleep(250);

/** 给控件配条件（走工程 API，等同属性面板里那几行） */
const setGate = (id, patch) => page.evaluate(({ id, patch }) => {
  const pr = window.app.project;
  Object.entries(patch).forEach(([k, v]) => pr.updateWidgetProp(id, k, v));
  pr.commit('配置条件启用');
}, { id, patch });

const setVars = (obj) => page.evaluate((o) => {
  Object.entries(o).forEach(([k, v]) => window.app.varStore.set(k, v, 'local'));
}, obj);
const val = (n) => page.evaluate(n => window.app.varStore.get(n), n);
const enterRun = () => page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  await rt.enterRun();
  rt.hideRuntimeHint();
});
const clickAt = async (id) => {
  const b = await page.locator(`#rtPage .wd[data-id="${id}"]`).boundingBox();
  if (!b) return false;                      // 元素藏起来了 → 没得点
  await page.mouse.click(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
  await sleep(120);
  return true;
};
/** 运行态里这个控件的样子 */
const look = (id) => page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  if (!el) return { exists: false };
  const cs = getComputedStyle(el);
  return {
    exists: true,
    display: cs.display,
    visible: cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null,
    locked: el.classList.contains('rt-gate-locked'),
    hidden: el.classList.contains('rt-gate-hidden'),
    badge: el.querySelector(':scope > .rt-gate-badge')?.textContent || '',
    badgeTitle: el.querySelector(':scope > .rt-gate-badge')?.title || '',
  };
}, id);

/* ══════ A. 属性面板：这一组在不在、能不能配 ══════ */
await page.evaluate(async (id) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, ids.gate);
await sleep(350);
const panel = await page.evaluate(() => {
  const groups = [...document.querySelectorAll('#propBody .prop-group')];
  const g = groups.find(x => /按条件启用/.test(x.querySelector('.prop-group-title')?.textContent || ''));
  return {
    has: !!g,
    enable: !!g?.querySelector('input[data-prop="gateOn"]'),
    modeOpts: [...(g?.querySelector('select[data-prop="gateMode"]')?.options || [])].map(o => o.value),
    logicOpts: [...(g?.querySelector('select[data-prop="gateLogic"]')?.options || [])].map(o => o.value),
    hint: !!g?.querySelector('input[data-prop="gateHint"]'),
    hintOn: !!g?.querySelector('input[data-prop="gateHint"]')?.checked,
    hintTitle: g?.querySelector('input[data-prop="gateHint"]')?.closest('label')?.title || '',
    add: !!g?.querySelector('#gateAdd'),
    rows: g?.querySelectorAll('.gate-cond').length ?? -1,
  };
});
ok('A 属性面板里有「按条件启用」这一组（启用 / 不满足时 / 条件之间 / ＋添加条件）',
  panel.has && panel.enable && panel.add && panel.rows === 0, JSON.stringify(panel));
ok('★ 这一组里有「弹提示」开关，**默认不勾**（现场要求：不满足时不弹那句提示）',
  panel.hint && panel.hintOn === false && /不弹/.test(panel.hintTitle), JSON.stringify([panel.hint, panel.hintOn]));
ok('A 「不满足时」两个选项：看不见也点不了（hide）/ 看得见但点不了（lock）',
  JSON.stringify(panel.modeOpts) === JSON.stringify(['hide', 'lock']), JSON.stringify(panel.modeOpts));
ok('A 「条件之间」两个选项：全部满足（and）/ 任一满足（or）',
  JSON.stringify(panel.logicOpts) === JSON.stringify(['and', 'or']), JSON.stringify(panel.logicOpts));

// 点「＋ 添加条件」→ 出一行；每行的零件齐（变量/运算符/值/非/删除）
await page.click('#gateAdd');
await sleep(250);
const row = await page.evaluate(() => {
  const r = document.querySelector('#propBody .gate-cond');
  return {
    has: !!r,
    vpick: r?.querySelector('input[data-gk="v"]')?.dataset.vpick,
    ops: [...(r?.querySelectorAll('select[data-gk="op"] option') || [])].map(o => o.value),
    val: !!r?.querySelector('[data-gk="val"]'),
    not: !!r?.querySelector('input[data-gk="not"]'),
    del: !!r?.querySelector('[data-gdel]'),
    props: window.app.project.getWidget(window.__gid || '')?.props?.gateConds,
  };
});
ok('A 「＋ 添加条件」出一行条件（变量格挂候选表 + 运算符 + 值 + 非 + ✕）',
  row.has && row.vpick === 'gate' && row.val && row.not && row.del, JSON.stringify(row));

// 选一个 bool 变量 → 运算符只剩 = / ≠，值是「真 / 假」下拉
await page.evaluate(() => {
  const inp = document.querySelector('#propBody .gate-cond input[data-gk="v"]');
  inp.value = 'bShow';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(300);
const boolRow = await page.evaluate(() => {
  const r = document.querySelector('#propBody .gate-cond');
  const valEl = r?.querySelector('[data-gk="val"]');
  return {
    ops: [...(r?.querySelectorAll('select[data-gk="op"] option') || [])].map(o => o.value),
    valTag: valEl?.tagName,
    valOpts: [...(valEl?.querySelectorAll('option') || [])].map(o => o.value),
    conds: window.app.project.getWidget([...document.querySelectorAll('#canvas .wd')].find(e => e.classList.contains('sel'))?.dataset.id || '')?.props?.gateConds,
  };
});
ok('A bool 变量 → 运算符只留 = / ≠，值变成「真 TRUE / 假 FALSE」下拉',
  JSON.stringify(boolRow.ops) === JSON.stringify(['==', '!=']) && boolRow.valTag === 'SELECT'
  && boolRow.valOpts.join(',') === 'true,false', JSON.stringify(boolRow));

/* ── A2. 提示文案：值那一格空着得写明（现场截图反馈：`b急停 ≥ ）` 看不懂是哪儿没填）── */
await setVars({ bShow: true });            // 「非」那条要底下成立、取反后不成立，先钉住值
const whyTxt = await page.evaluate(async () => {
  const { _probe } = await import('/js/runtime/gate.js');
  const mk = (conds) => ({ props: { gateOn: true, gateMode: 'lock', gateConds: conds }, bindings: {} });
  return {
    empty: _probe(mk([{ v: 'b急停', op: '>=', val: '' }])).why,
    filled: _probe(mk([{ v: 'iMode', op: '>=', val: '5' }])).why,
    not: _probe(mk([{ v: 'bShow', op: '==', val: 'true', not: true }])).why,
  };
});
ok('★ 条件里值没填 → 提示写「（空）」', /b急停 ≥ （空）/.test(whyTxt.empty), whyTxt.empty);
ok('值填了照旧原样写出来（数值 / bool / 非 都对）',
  /iMode ≥ 5/.test(whyTxt.filled) && /非 bShow = true/.test(whyTxt.not), JSON.stringify(whyTxt));

/* 后面直接用工程 API 配条件（面板那套已经验过了） */
await setGate(ids.gate, {
  gateOn: true, gateMode: 'hide', gateLogic: 'and', gateConds: [{ v: 'bShow', op: '==', val: 'true' }],
});
await setGate(ids.lock, {
  gateOn: true, gateMode: 'lock', gateLogic: 'and', gateConds: [{ v: 'bShow', op: '==', val: 'true' }],
});
await setVars({ bShow: false, bOut: false, bUnder: false, bA: false, bB: false, iMode: 0 });
await enterRun();
await sleep(350);

/* ══════ B. 「看不见，也点不了」══════ */
const hiddenLook = await look(ids.gate);
ok('B 条件不满足 + 看不见：控件真的不显示（display:none）',
  hiddenLook.exists && hiddenLook.display === 'none' && hiddenLook.hidden, JSON.stringify(hiddenLook));
const clickedWhenHidden = await clickAt(ids.gate);
await sleep(150);
ok('B 藏起来之后：点那块位置，它自己的动作**不执行**（bOut 没变）',
  (await val('bOut')) === false, JSON.stringify({ clickedWhenHidden, bOut: await val('bOut') }));
/* 「那块位置」现在归压在下层的、看得见的那个控件（藏起来的控件没有盒子，点不到它）——
   这里点下层那个（= 现场"点在原来的位置上"），它照常响应、被藏的仍然不动 */
await setVars({ bUnder: false, bOut: false });
await sleep(120);
await clickAt(ids.under);
ok('B 藏起来时那块位置**归下面的控件**（压在下面那个照常响应，不是"死区"）',
  (await val('bUnder')) === true && (await val('bOut')) === false,
  JSON.stringify({ bUnder: await val('bUnder'), bOut: await val('bOut') }));

await setVars({ bShow: true });               // 条件满足 → 当场就该出来
await sleep(200);
const shownLook = await look(ids.gate);
ok('B 条件满足 → 控件**当场**显示出来（不用重进运行态）',
  shownLook.visible && !shownLook.hidden, JSON.stringify(shownLook));
await setVars({ bOut: false, bUnder: false });
await sleep(120);
await clickAt(ids.gate);
ok('B 条件满足后能正常点（动作照做）', (await val('bOut')) === true, String(await val('bOut')));

/* ══════ C. 「看得见，但点不了」══════ */
await setVars({ bShow: false, bOut: false });
await sleep(200);
const lockLook = await look(ids.lock);
ok('C 条件不满足 + 看得见：控件还在（没被藏），带 .rt-gate-locked + 🔒 角标',
  lockLook.visible && lockLook.locked && lockLook.badge === '🔒', JSON.stringify(lockLook));
ok('C 角标悬停说清"为什么点不动"', /条件不满足/.test(lockLook.badgeTitle) && /bShow/.test(lockLook.badgeTitle),
  lockLook.badgeTitle);
await clickAt(ids.lock);
await sleep(150);
ok('C 看得见但点不了：点了动作**不执行**', (await val('bOut')) === false, String(await val('bOut')));
const tipShown = await page.evaluate(() => {
  const t = document.getElementById('rtGateTip');
  return { on: !!t && t.classList.contains('on'), text: t?.textContent || '' };
});
ok('★ 默认**不弹**「条件不满足」那条小提示（现场要求：画面上干干净净，原因看 🔒 的悬停）',
  tipShown.on === false, JSON.stringify(tipShown));
// 勾上「弹提示」→ 同一次点击就该弹出来（属性 panel 那一格，默认不勾）
await page.evaluate(async (id) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(id, 'gateHint', true);
  m.project.commit('开提示');
}, ids.lock);
await page.evaluate(() => {                     // 3 秒节流：换个时刻再点
  const t = document.getElementById('rtGateTip');
  if (t) t.classList.remove('on');
});
await sleep(200);
await clickAt(ids.lock);
await sleep(180);
const tipOn = await page.evaluate(() => {
  const t = document.getElementById('rtGateTip');
  return { on: !!t && t.classList.contains('on'), text: t?.textContent || '' };
});
ok('★ 勾上「弹提示」→ 点了才弹那句「条件不满足（bShow …）」（关着时一声不吭）',
  tipOn.on && /条件不满足/.test(tipOn.text) && /bShow/.test(tipOn.text), JSON.stringify(tipOn));
await page.evaluate(async (id) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(id, 'gateHint', null);      // 还原成"老工程没这个键"的样子
  m.project.commit('还原提示设置');
}, ids.lock);
await setVars({ bShow: true });
await sleep(200);
const lockOpen = await look(ids.lock);
ok('C 条件满足 → 解锁、角标消失、能点了', lockOpen.visible && !lockOpen.locked && lockOpen.badge === '',
  JSON.stringify(lockOpen));

/* ══════ C2. 按住（点动）当中条件变不满足、控件被藏起来 → 松手不能把输出卡在 TRUE ══════
   现场要命的那种组合：点动按钮按着按着条件不满足了（控件没了），这时的松手要是丢了，
   机器就一直走 —— 松手兜底（第 19 轮那套窗口级监听）必须接住。 */
const tapId = ids.tap;
await setVars({ bShow: true, bOut: false });
await sleep(250);
const tb = await page.locator(`#rtPage .wd[data-id="${tapId}"]`).boundingBox();
await page.mouse.move(Math.round(tb.x + tb.width / 2), Math.round(tb.y + tb.height / 2));
await page.mouse.down();
await sleep(120);
const tapDown = await val('bOut');
await setVars({ bShow: false });          // 按着的时候条件变得不满足 → 控件被藏起来
await sleep(150);
const hiddenMidPress = await look(tapId);
await page.mouse.up();                    // 在"已经不存在的控件"上松手
await sleep(200);
ok('C2 点动按着的时候条件变不满足 → 控件藏起来（按住中就消失了）',
  tapDown === true && hiddenMidPress.display === 'none', JSON.stringify({ tapDown, hiddenMidPress }));
ok('C2 这种情况下松手**不能把输出卡在 TRUE**（松手兜底接住）',
  (await val('bOut')) === false, String(await val('bOut')));

/* ══════ D. 多条件：与 / 或 / 非 ══════ */
await setGate(ids.gate, { gateConds: [{ v: 'bA', op: '==', val: 'true' }, { v: 'bB', op: '==', val: 'true' }], gateLogic: 'and' });
await setVars({ bA: true, bB: false, bOut: false });
await sleep(200);
ok('D 与（and）：只满足一条 → 拦住（藏起来）', (await look(ids.gate)).display === 'none', JSON.stringify(await look(ids.gate)));
await setVars({ bB: true });
await sleep(200);
ok('D 与（and）：两条都满足 → 显示', (await look(ids.gate)).visible, JSON.stringify(await look(ids.gate)));

await setGate(ids.gate, { gateLogic: 'or' });
await setVars({ bA: true, bB: false });
await sleep(200);
ok('D 或（or）：满足任意一条就显示', (await look(ids.gate)).visible, JSON.stringify(await look(ids.gate)));
await setVars({ bA: false, bB: false });
await sleep(200);
ok('D 或（or）：一条都不满足 → 藏起来', (await look(ids.gate)).display === 'none', JSON.stringify(await look(ids.gate)));

await setGate(ids.gate, { gateLogic: 'and', gateConds: [{ v: 'bA', op: '==', val: 'true', not: true }] });
await setVars({ bA: false });
await sleep(200);
ok('D 非（not）：勾了「非」→ bA=false 时条件成立（显示）', (await look(ids.gate)).visible, JSON.stringify(await look(ids.gate)));
await setVars({ bA: true });
await sleep(200);
ok('D 非（not）：bA=true 时反而不成立（藏起来）', (await look(ids.gate)).display === 'none', JSON.stringify(await look(ids.gate)));

await setGate(ids.gate, { gateConds: [{ v: 'bA', op: '==', val: 'false' }] });
await setVars({ bA: false });
await sleep(200);
ok('D bool 写 =false 也按真假比（bA=false 成立 → 显示）', (await look(ids.gate)).visible, JSON.stringify(await look(ids.gate)));
await setGate(ids.gate, { gateConds: [{ v: 'iMode', op: '>=', val: '5' }] });
await setVars({ iMode: 4 });
await sleep(200);
ok('D 数值条件（iMode ≥ 5）：4 不满足 → 藏', (await look(ids.gate)).display === 'none', JSON.stringify(await look(ids.gate)));
await setVars({ iMode: 5 });
await sleep(200);
ok('D 数值条件（iMode ≥ 5）：5 满足 → 显示', (await look(ids.gate)).visible, JSON.stringify(await look(ids.gate)));

/* ══════ E. 采集范围 / 缺值 / 老工程 ══════ */
// 当前这一页配的条件变量 = gate 的 iMode（数值条件）+ lock 的 bShow —— 两个都得在采集范围里
const scope = await page.evaluate(async () => (await import('/js/runtime/runtime.js')).pageVarScope());
ok('E 条件里的变量**自动进采集范围**（不采就永远读不到值 → 条件永远不成立）',
  scope.includes('bShow') && scope.includes('iMode'), JSON.stringify(scope.filter(n => ['bShow', 'bA', 'bB', 'iMode'].includes(n))));

await setGate(ids.gate, { gateConds: [{ v: 'bNoSuchVar', op: '==', val: 'true' }] });
await sleep(200);
ok('E 条件里的变量**不存在**（读不到值）→ 判定不满足（宁可不放行，不静默放行）',
  (await look(ids.gate)).display === 'none', JSON.stringify(await look(ids.gate)));

await setGate(ids.gate, { gateOn: false, gateConds: [] });
await sleep(200);
const offLook = await look(ids.gate);
await setVars({ bOut: false });
await sleep(100);
await clickAt(ids.gate);
ok('E 不勾「启用」→ 和以前一模一样（显示、能点）',
  offLook.visible && !offLook.hidden && !offLook.locked && (await val('bOut')) === true,
  JSON.stringify({ offLook, bOut: await val('bOut') }));

const plainLook = await look(ids.plain);
ok('E 没配条件的控件（老工程）完全不受影响', plainLook.visible && !plainLook.hidden && !plainLook.locked && !plainLook.badge,
  JSON.stringify(plainLook));

/* 组态画布上照常能选中/能拖（条件只作用于运行态） */
await page.evaluate(async () => { (await import('/js/runtime/runtime.js')).exitRun(); });
await sleep(250);
const canvasOk = await page.evaluate((id) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  if (!el) return { exists: false };
  const cs = getComputedStyle(el);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return { exists: true, display: cs.display, selected: el.classList.contains('sel') };
}, ids.gate);
ok('E 组态画布上照常显示、能选中（条件只作用于运行态，不然藏起来的控件没法再编辑）',
  canvasOk.exists && canvasOk.display !== 'none', JSON.stringify(canvasOk));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 控件按条件启用（藏起来 / 锁住）：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
