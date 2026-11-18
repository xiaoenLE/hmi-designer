// verify-input-range.mjs — 数值输入控件的「输入范围限制」+ 按钮默认「输入与输出同一个变量」
//
// 现场要的两件事：
//   ① 输入控件是数字时，可以给它做**输入范围限制** —— 上下限各自可以是固定值，也可以跟一个变量走
//      （配方上下限由 PLC 下发）；软键盘上要显示这个范围，输入越界时键盘输入框变红**并且写不进去**
//      （一个字节都不下发）。老工程没配过 = 行为一个字不变。
//   ② 按钮那边「变量与「状态显示」的变量一致」（输入与输出同一个变量）**默认勾选**。
//
// 用法：node tools/run-suites.mjs verify-input-range   （或先起服务再 node test/verify-input-range.mjs [端口]）
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
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* 后端隔离：本套件只验界面行为，不该被 PLC 连通性影响（写本地、不下发） */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
  m.backend.readVar = async () => undefined;
}));

/* ── 1. 老工程兼容：新控件的范围限制默认是关的 ── */
const fresh = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const w = m.addWidget('number', 20, 20);
  const out = { rangeOn: w.props.rangeOn, mode: w.props.rangeMinMode, value: w.props.rangeMinValue };
  m.deleteWidgets([w.id]);
  const b = m.addWidget('button', 20, 20);
  const bout = { followBind: b.followBind, bind: b.bindings?.variable };
  m.deleteWidgets([b.id]);
  return { out, bout };
});
ok('新建数值控件：范围限制默认关（rangeOn=false），老工程行为不变',
  fresh.out.rangeOn === false, JSON.stringify(fresh.out));
ok('新建数值控件：上下限默认是「固定值」且留空（= 两端都不限）',
  fresh.out.mode === 'fixed' && fresh.out.value === '', JSON.stringify(fresh.out));
ok('新建按钮：默认勾上「变量与显示的变量一致」（followBind=true）',
  fresh.bout.followBind === true, JSON.stringify(fresh.bout));

/* ── 2. 造工程：一排数值控件，各配一种范围 ── */
const W = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  const V = (n, v) => m.data.variables.push({ name: n, type: 'real', address: '', value: v });
  ['rFixed', 'rOnly', 'rVar', 'rInline', 'rInput', 'rLegacy', 'rBad', 'rMin', 'rMax'].forEach(n => V(n, 10));
  V('rMin', 0); V('rMax', 100);
  m.data.variables.push({ name: 'sText', type: 'string', len: 20, address: '', value: 'abc' });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const mk = (x, y, bind, props) => {
    const w = m.addWidget('number', x, y);
    w.bindings.variable = bind;
    Object.assign(w.props, props || {});
    return w.id;
  };
  const out = {
    fixed: mk(20, 20, 'rFixed', { rangeOn: true, rangeMinMode: 'fixed', rangeMinValue: '0', rangeMaxMode: 'fixed', rangeMaxValue: '100' }),
    oneSided: mk(20, 80, 'rOnly', { rangeOn: true, rangeMaxMode: 'fixed', rangeMaxValue: '100' }),
    byVar: mk(20, 140, 'rVar', { rangeOn: true, rangeMinMode: 'var', rangeMinVar: 'rMin', rangeMaxMode: 'var', rangeMaxVar: 'rMax' }),
    inline: mk(20, 200, 'rInline', { rangeOn: true, useKeyboard: false, rangeMaxMode: 'fixed', rangeMaxValue: '100' }),
    bad: mk(20, 260, 'rBad', { rangeOn: true, rangeMinMode: 'fixed', rangeMinValue: '200', rangeMaxMode: 'fixed', rangeMaxValue: '100' }),
    legacy: mk(20, 320, 'rLegacy', { rangeOn: true, rangeMaxMode: 'fixed', rangeMaxValue: '10' }),
  };
  const inp = m.addWidget('input', 300, 320);
  inp.bindings.variable = 'rInput';
  Object.assign(inp.props, { rangeOn: true, rangeMaxMode: 'fixed', rangeMaxValue: '10' });
  out.inputW = inp.id;
  m.commit('范围限制测试');
  return out;
});
await sleep(300);

/* ── 3. 属性面板：范围限制那一栏 ── */
// 先复位成"没配过"的样子（下面从"不勾"开始走一遍）
await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  Object.assign(m.getWidget(id).props, { rangeOn: false, rangeMinValue: '', rangeMaxValue: '' });
  m.commit('复位');
}, W.fixed);
await page.click(`#canvas .wd[data-id="${W.fixed}"]`);
await sleep(250);
let panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const label = (t) => rows.find(r => r.querySelector('.f-label')?.textContent.trim() === t);
  return {
    cb: document.querySelector('#propBody input[data-prop="rangeOn"]')?.checked ?? null,
    hasMin: !!label('下限'), hasMax: !!label('上限'),
    block: document.querySelector('#propBody input[data-prop="padBlockOthers"]')?.checked ?? null,
    groups: [...document.querySelectorAll('#propBody .prop-group-title')].map(e => e.textContent.trim()),
    rangeHints: (() => {
      const g = [...document.querySelectorAll('#propBody .prop-group')]
        .find(x => x.querySelector('.prop-group-title')?.textContent.trim() === '输入范围');
      // 灰色说明行 = 没有 label 但右边有文字的那些 .f-row（hint 渲染出来的）
      return g ? [...g.querySelectorAll('.f-row')]
        .filter(r => !r.querySelector('.f-label')?.textContent.trim() && r.textContent.trim()).length : -1;
    })(),
  };
});
ok('面板上有「范围限制」勾选框，默认不勾', panel.cb === false, String(panel.cb));
ok('面板上有「屏蔽其他控件」，**默认勾着**（= 键盘弹出默认就禁止点别处）',
  panel.block === true, String(panel.block));
ok('「输入范围」那一栏里没有灰色说明文字（提示不写进面板）', panel.rangeHints === 0, String(panel.rangeHints));
ok('不勾时不显示「下限/上限」两行（showIf）', !panel.hasMin && !panel.hasMax);
ok('「输入范围」单独一栏（可折叠）', panel.groups.includes('输入范围'), JSON.stringify(panel.groups));

await page.click('#propBody input[data-prop="rangeOn"]');
await sleep(300);
panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const label = (t) => rows.find(r => r.querySelector('.f-label')?.textContent.trim() === t);
  const min = label('下限');
  return {
    cb: document.querySelector('#propBody input[data-prop="rangeOn"]')?.checked ?? null,
    hasMin: !!min, hasMax: !!label('上限'),
    fmt: [...document.querySelectorAll('#propBody .f-row')]
      .filter(r => ['下限', '上限'].includes(r.querySelector('.f-label')?.textContent.trim()))
      .map(r => ({
        mode: r.querySelector('[data-vvmode]')?.value,
        modes: [...(r.querySelector('[data-vvmode]')?.options || [])].map(o => o.value),
        valVis: !r.querySelector('.vv-val')?.classList.contains('hidden'),
        varVis: !r.querySelector('.vv-var')?.classList.contains('hidden'),
        valProp: r.querySelector('.vv-val')?.dataset.prop,
        varProp: r.querySelector('.vv-var .vf-inp')?.dataset.prop,
        pick: r.querySelector('.vv-var .vf-inp')?.dataset.vpick,
      })),
  };
});
ok('勾上范围限制 → 下限/上限两行出现', panel.cb === true && panel.hasMin && panel.hasMax);
ok('每行都是「固定值 / 变量」二选一，默认停在固定值（显示固定值输入框）',
  panel.fmt.length === 2 && panel.fmt.every(f => f.mode === 'fixed' && f.modes.join(',') === 'fixed,var' && f.valVis && !f.varVis),
  JSON.stringify(panel.fmt));
ok('两行的键分别是 rangeMinValue/rangeMaxValue 与 rangeMinVar/rangeMaxVar',
  panel.fmt[0].valProp === 'rangeMinValue' && panel.fmt[0].varProp === 'rangeMinVar'
  && panel.fmt[1].valProp === 'rangeMaxValue' && panel.fmt[1].varProp === 'rangeMaxVar',
  JSON.stringify(panel.fmt.map(f => [f.valProp, f.varProp])));
ok('变量格挂了变量候选表（data-vpick=limit）', panel.fmt.every(f => f.pick === 'limit'));

// 切到「变量」：模式写进工程、两个输入框换显隐
await page.selectOption('#propBody select[data-vvmode="rangeMinMode"]', 'var');
await sleep(250);
const modeSwitch = await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  const row = [...document.querySelectorAll('#propBody .f-row')]
    .find(r => r.querySelector('.f-label')?.textContent.trim() === '下限');
  return {
    prop: m.getWidget(id).props.rangeMinMode,
    valVis: !row.querySelector('.vv-val').classList.contains('hidden'),
    varVis: !row.querySelector('.vv-var').classList.contains('hidden'),
  };
}, W.fixed);
ok('切到「变量」→ 模式存进工程，固定值框收起、变量框出现',
  modeSwitch.prop === 'var' && !modeSwitch.valVis && modeSwitch.varVis, JSON.stringify(modeSwitch));

// 变量格当场体检：字符串变量不能当上限（静默失效要看得见）
const badVar = await page.evaluate(() => {
  const inp = document.querySelector('#propBody [data-vpick="limit"]');
  inp.value = 'sText';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return { bad: inp.classList.contains('bad'), title: inp.title };
});
ok('范围变量填了字符串变量 → 当场标红并说清为什么', badVar.bad && /要数值变量/.test(badVar.title),
  JSON.stringify(badVar).slice(0, 120));
const goodVar = await page.evaluate(() => {
  const inp = document.querySelector('#propBody [data-vpick="limit"]');
  inp.value = 'rMin';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return { bad: inp.classList.contains('bad'), title: inp.title };
});
ok('范围变量填数值变量 → 不标红', goodVar.bad === false, JSON.stringify(goodVar).slice(0, 120));

// 取消勾选 → 两行收起（配置值留着，重新勾上不用再填一遍）
await page.click('#propBody input[data-prop="rangeOn"]');
await sleep(300);
const offAgain = await page.evaluate(() => [...document.querySelectorAll('#propBody .f-row')]
  .some(r => r.querySelector('.f-label')?.textContent.trim() === '下限'));
ok('取消勾选 → 下限/上限两行收起', offAgain === false);

/* ── 4. 复位各控件的范围配置（面板那几步把 fixed 那个改过了）── */
await page.evaluate(async (ids) => {
  const m = (await import('/js/core/project.js')).project;
  const set = (id, patch) => Object.assign(m.getWidget(id).props, patch);
  set(ids.fixed, { rangeOn: true, rangeMinMode: 'fixed', rangeMinValue: '0', rangeMinVar: '', rangeMaxMode: 'fixed', rangeMaxValue: '100' });
  set(ids.oneSided, { rangeOn: true, rangeMinMode: 'fixed', rangeMinValue: '', rangeMinVar: '', rangeMaxMode: 'fixed', rangeMaxValue: '100' });
  set(ids.byVar, { rangeOn: true, rangeMinMode: 'var', rangeMinVar: 'rMin', rangeMaxMode: 'var', rangeMaxVar: 'rMax' });
  // 老工程：整块键都不存在（老存档里没有这些键）
  const legacy = m.getWidget(ids.legacy);
  ['rangeOn', 'rangeMinMode', 'rangeMinValue', 'rangeMinVar', 'rangeMaxMode', 'rangeMaxValue', 'rangeMaxVar']
    .forEach(k => { delete legacy.props[k]; });
  m.commit('复位范围配置');
}, W);

/* ── 5. 运行态：软键盘 ── */
const enterRun = async () => { await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun()); await sleep(600); };
const exitRun = async () => { await page.evaluate(async () => (await import('/js/runtime/runtime.js')).exitRun()); await sleep(400); };
const pad = () => page.evaluate(() => ({
  open: !document.getElementById('numPad').classList.contains('hidden'),
  display: document.getElementById('npDisplay').textContent,
  bad: document.getElementById('npDisplay').classList.contains('bad'),
  range: document.getElementById('npRange').textContent,
  rangeShown: !document.getElementById('npRange').classList.contains('hidden'),
  rangeBad: document.getElementById('npRange').classList.contains('bad'),
  okDisabled: !!document.querySelector('#npKeys button.np-ok')?.disabled,
  label: document.getElementById('npVar').textContent,
  mask: document.getElementById('npMask')
    ? !document.getElementById('npMask').classList.contains('hidden') : null,
}));
const openPad = async (id) => { await page.click(`#rtPage .wd[data-id="${id}"]`); await sleep(330); return pad(); };
const tapNum = async (k) => { await page.click(`#npKeys button[data-k="${k}"]`); await sleep(90); };
const typeNum = async (s) => { for (const c of s) await tapNum(c); };
const store = (n) => page.evaluate((n) => window.app.varStore.get(n), n);
const setVar = async (n, v) => { await page.evaluate(([n, v]) => window.app.varStore.set(n, v, 'local'), [n, v]); await sleep(180); };
/** 绕过"确定按钮已禁用"，直接调提交那条路 —— 验"就算点了也一个字节都不下发" */
const forceOk = async () => {
  await page.evaluate(() => {
    const b = document.querySelector('#npKeys button.np-ok');
    b.disabled = false;      // 模拟脚本/自动化直接触发
    b.click();
  });
  await sleep(250);
};

await enterRun();

/* 5.1 固定值范围 */
let p = await openPad(W.fixed);
ok('键盘上显示限制范围（固定值）', p.rangeShown && p.range === '范围 0 ~ 100', p.range);
ok('刚打开时：输入框不红、确定可用', !p.bad && !p.rangeBad && !p.okDisabled);
await tapNum('clear');
await typeNum('150');
p = await pad();
ok('超出上限 → 键盘输入框变红', p.bad === true, p.display);
ok('超出上限 → 范围行也标红并写明「超出范围」', p.rangeBad && /超出范围/.test(p.range), p.range);
ok('超出上限 → 确定按钮禁用', p.okDisabled === true);
await forceOk();
p = await pad();
ok('超出上限 → 数据写不进去（变量还是 10）', Number(await store('rFixed')) === 10, String(await store('rFixed')));
ok('越界时键盘不关（就在这一屏改，不用重新点控件）', p.open === true);
ok('越界后输入框仍然红着（值还在，能接着改）', p.bad === true, p.display);

await tapNum('clear');
await typeNum('50');
p = await pad();
ok('改成 50 → 红框收掉、确定恢复可用', !p.bad && !p.rangeBad && !p.okDisabled, JSON.stringify(p).slice(0, 90));
await tapNum('ok');
ok('确定 → 50 写进变量', Number(await store('rFixed')) === 50, String(await store('rFixed')));
ok('确定后键盘自己关掉', (await pad()).open === false);

p = await openPad(W.fixed);
await tapNum('clear');
await typeNum('100');
p = await pad();
ok('正好等于上限 → 允许（不红、确定可用）', !p.bad && !p.okDisabled);
await tapNum('ok');
ok('等于上限的值写得进去（100）', Number(await store('rFixed')) === 100, String(await store('rFixed')));

p = await openPad(W.fixed);
await tapNum('clear');
await tapNum('+/-');
await tapNum('1');
p = await pad();
ok('低于下限（-1）→ 同样变红 + 不可写', p.display === '-1' && p.bad && p.okDisabled, JSON.stringify(p).slice(0, 90));
await tapNum('cancel');

// 中间态不能当场标红（刚按了 ± / 小数点，还没输完）
p = await openPad(W.fixed);
await tapNum('clear');
await tapNum('+/-');
p = await pad();
ok('只按了一个「±」（.- 中间态）不标红 —— 还没输完，不能当成越界',
  p.display === '-' && p.bad === false && p.okDisabled === false, JSON.stringify(p).slice(0, 90));
await tapNum('cancel');

/* 5.2 只配一端 */
p = await openPad(W.oneSided);
ok('只配上限 → 范围行写「范围 ≤ 100」', p.range === '范围 ≤ 100', p.range);
await tapNum('clear');
await tapNum('+/-');
await typeNum('50');
p = await pad();
ok('没配下限 → 负值允许（-50 不红、确定可用）', !p.bad && !p.okDisabled, JSON.stringify(p).slice(0, 90));
await tapNum('ok');
ok('负值写进变量（-50）', Number(await store('rOnly')) === -50, String(await store('rOnly')));

/* 5.3 上下限跟着变量走 */
await setVar('rMin', 0);
await setVar('rMax', 100);
p = await openPad(W.byVar);
ok('限制来自变量 → 范围行显示「变量名(当前值)」',
  p.range === '范围 rMin(0) ~ rMax(100)', p.range);
await setVar('rMax', 40);                       // 键盘开着的时候 PLC 把上限改小
p = await pad();
ok('键盘开着时限制变量变了 → 范围行当场跟着变（不缓存旧范围）',
  p.range === '范围 rMin(0) ~ rMax(40)', p.range);
await tapNum('clear');
await typeNum('50');
p = await pad();
ok('按变量上限判越界：50 > 40 → 变红 + 不可写', p.bad && p.okDisabled, JSON.stringify(p).slice(0, 90));
await forceOk();
ok('变量型范围越界同样一个字节都不下发', Number(await store('rVar')) === 10, String(await store('rVar')));
await tapNum('cancel');

// 限制变量必须在采集范围里（不采 = 永远读不到值 = 限制静默失效）
const scope = await page.evaluate(async () => (await import('/js/runtime/runtime.js')).pageVarScope());
ok('当上下限用的变量进了本页采集范围（否则限制会静默失效）',
  scope.includes('rMin') && scope.includes('rMax'), `采集 ${scope.length} 个：${scope.join(',')}`);

// 限制变量读不到值时：不拦，但键盘上要标出来（看着有范围、实际不拦最危险）
await setVar('rMax', undefined);
p = await openPad(W.byVar);
ok('限制变量没读到值 → 范围行标成 rMax(?)', /rMax\(\?\)/.test(p.range), p.range);
await tapNum('clear');
await typeNum('999');
p = await pad();
ok('这一端读不到值时不拦（明说"还没读到"，而不是装作拦住了）', !p.bad && !p.okDisabled, JSON.stringify(p).slice(0, 90));
await tapNum('cancel');
await setVar('rMax', 100);

/* 5.6 键盘弹出时屏蔽其他控件（默认就禁止点别处） */
p = await openPad(W.fixed);
const lay = await page.evaluate((id) => {
  const m = document.getElementById('npMask');
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    shown: !m.classList.contains('hidden'),
    maskZ: +getComputedStyle(m).zIndex, padZ: +getComputedStyle(document.getElementById('numPad')).zIndex,
    hitIsMask: hit === m,
  };
}, W.oneSided);
ok('默认：键盘一弹出就把画面挡住（遮罩出现，层级在键盘之下）',
  p.mask === true && lay.shown && lay.maskZ < lay.padZ, JSON.stringify(lay));
ok('键盘开着时，别的控件位置"命中"到的是遮罩（真点不到它）', lay.hitIsMask === true, JSON.stringify(lay));
// 真鼠标点在另一个数值控件上（走真实的命中判定，不经 Playwright 的可点性检查）：
// 点不动 → 键盘还停在原来那个控件上、已输入的内容也没被换掉
const otherBox = await page.locator(`#rtPage .wd[data-id="${W.oneSided}"]`).boundingBox();
await page.mouse.click(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2);
await sleep(300);
p = await pad();
ok('真点在别处 → 键盘没被换走（还是 rFixed 那个控件）',
  p.open && p.label.startsWith('rFixed'), JSON.stringify({ open: p.open, label: p.label }));
await tapNum('cancel');
ok('键盘关掉 → 遮罩跟着收（画面恢复可点）', (await pad()).mask === false);

// 取消勾选「屏蔽其他控件」= 老行为：还能点别处（点另一个输入控件就把键盘换过去）
await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  m.updateWidgetProp(id, 'padBlockOthers', false);
}, W.oneSided);
await sleep(150);
p = await openPad(W.oneSided);
ok('取消勾选后打开键盘 → 不盖遮罩', p.mask === false, JSON.stringify({ mask: p.mask, label: p.label }));
const fixedBox = await page.locator(`#rtPage .wd[data-id="${W.fixed}"]`).boundingBox();
await page.mouse.click(fixedBox.x + fixedBox.width / 2, fixedBox.y + fixedBox.height / 2);
await sleep(350);
p = await pad();
ok('取消勾选后点别处：照旧能点（键盘换到新点的那个控件）—— 老行为还在',
  p.open && p.label.startsWith('rFixed'), JSON.stringify({ open: p.open, label: p.label }));
await tapNum('cancel');
await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  m.updateWidgetProp(id, 'padBlockOthers', true);
}, W.oneSided);

/* 5.7 配错了（下限比上限大）：任何值都不合法 */p = await openPad(W.bad);
ok('下限比上限大 → 范围行照实显示（原值 10 也当场判越界）',
  p.range.startsWith('范围 200 ~ 100') && p.bad === true, p.range);
await tapNum('clear');
await typeNum('150');
p = await pad();
ok('配错时任何值都拦（150 也不合法）', p.bad && p.okDisabled, JSON.stringify(p).slice(0, 90));
await tapNum('cancel');

/* 5.5 老工程（没有这些键）：一个字都不变 */
p = await openPad(W.legacy);
ok('老工程控件：键盘上不出现范围行', p.rangeShown === false, p.range);
await tapNum('clear');
await typeNum('999');
p = await pad();
ok('老工程控件：999 照旧能输能确定（范围限制没被"默认打开"）', !p.bad && !p.okDisabled, JSON.stringify(p).slice(0, 90));
await tapNum('ok');
ok('老工程控件：999 照旧写得进去', Number(await store('rLegacy')) === 999, String(await store('rLegacy')));

/* ── 6. 运行态：内联输入（没勾「软键盘输入」的数值控件）── */
await page.click(`#rtPage .wd[data-id="${W.inline}"]`);
await sleep(300);
await page.fill(`#rtPage .wd[data-id="${W.inline}"] input`, '150');
await sleep(120);
let inline = await page.evaluate((id) => {
  const i = document.querySelector(`#rtPage .wd[data-id="${id}"] input`);
  return { has: !!i, bad: !!i?.classList.contains('bad') };
}, W.inline);
ok('内联输入超范围 → 打字时就变红', inline.has && inline.bad === true, JSON.stringify(inline));
await page.keyboard.press('Enter');
await sleep(250);
ok('内联输入超范围 + 回车 → 不写（变量还是 10）', Number(await store('rInline')) === 10, String(await store('rInline')));
inline = await page.evaluate((id) => {
  const i = document.querySelector(`#rtPage .wd[data-id="${id}"] input`);
  return { has: !!i, bad: !!i?.classList.contains('bad') };
}, W.inline);
ok('超范围回车后留在输入态（接着改，输入内容没被吞）', inline.has && inline.bad, JSON.stringify(inline));

await page.fill(`#rtPage .wd[data-id="${W.inline}"] input`, '80');
await page.keyboard.press('Enter');
await sleep(250);
ok('内联输入改成 80 → 写进变量', Number(await store('rInline')) === 80, String(await store('rInline')));

// 失焦提交：越界 → 不写，显示收回原值（值一个字节都没变）
await page.click(`#rtPage .wd[data-id="${W.inline}"]`);
await sleep(250);
await page.fill(`#rtPage .wd[data-id="${W.inline}"] input`, '150');
await page.evaluate((id) => document.querySelector(`#rtPage .wd[data-id="${id}"] input`)?.blur(), W.inline);
await sleep(300);
const afterBlur = await page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return { hasInput: !!el.querySelector('input'), shown: el.querySelector('.wn-val')?.textContent };
}, W.inline);
ok('内联输入超范围 + 失焦 → 不写也不留（值显示回 80）',
  Number(await store('rInline')) === 80 && !afterBlur.hasInput && afterBlur.shown === '80.0',
  JSON.stringify(afterBlur));

/* ── 7. 运行态：老「数据输入」控件（input）── */
await page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .w-input`);
  el.focus(); el.value = '99'; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur();
}, W.inputW);
await sleep(250);
const lw = await page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .w-input`);
  return { bad: el.classList.contains('bad'), val: el.value };
}, W.inputW);
ok('数据输入控件：超范围 → 输入框变红', lw.bad === true, JSON.stringify(lw));
ok('数据输入控件：超范围 → 不写进变量（还是 10）', Number(await store('rInput')) === 10, String(await store('rInput')));
await page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .w-input`);
  el.focus(); el.value = '7.5'; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur();
}, W.inputW);
await sleep(250);
ok('数据输入控件：范围内的值照旧写得进去（7.5）', Number(await store('rInput')) === 7.5, String(await store('rInput')));

await exitRun();

/* ── 8. 按钮：默认「输入与输出同一个变量」（变量与「状态显示」的变量一致）── */
const btn = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const w = m.addWidget('button', 420, 40);
  return { id: w.id, followBind: w.followBind, bind: w.bindings?.variable };
});
await sleep(250);
ok('新建按钮：followBind 默认 true，且默认绑了变量表第一个变量',
  btn.followBind === true && !!btn.bind, JSON.stringify(btn));
await page.click(`#canvas .wd[data-id="${btn.id}"]`);
await sleep(300);
const panelBtn = await page.evaluate(() => {
  const cb = document.getElementById('actFollow');
  return { has: !!cb, checked: cb?.checked ?? null, label: cb?.parentElement?.textContent.trim() || '' };
});
ok('属性面板上那个勾选框默认是勾上的', panelBtn.has && panelBtn.checked === true && /一致/.test(panelBtn.label),
  JSON.stringify(panelBtn));

await page.click('#actAdd');
await sleep(300);
const act1 = await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  const w = m.getWidget(id);
  return {
    var: w.actions[0]?.params?.variable,
    bind: w.bindings?.variable,
    readonlyInput: !!document.querySelector('#propBody [data-ap="variable"][readonly]'),
  };
}, btn.id);
ok('添加动作 → 动作变量跟着显示变量（输入与输出同一个变量）',
  act1.var === act1.bind && !!act1.var, JSON.stringify(act1));
ok('勾着的时候动作里的变量格是只读的（改上面「数据绑定」那一处就行）', act1.readonlyInput === true);

// 改显示变量 → 动作变量跟着改
await page.evaluate(async () => {
  const inp = document.querySelector('#propBody [data-bind="variable"]');
  inp.value = 'rMax';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(300);
const act2 = await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  const w = m.getWidget(id);
  return { var: w.actions[0]?.params?.variable, bind: w.bindings?.variable };
}, btn.id);
ok('改显示变量 → 动作变量当场跟着改（不用两处各改一遍）',
  act2.bind === 'rMax' && act2.var === 'rMax', JSON.stringify(act2));

// 取消勾选 → 动作变量可以自己填（老行为还在）
await page.click('#actFollow');
await sleep(300);
const un = await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  const w = m.getWidget(id);
  return { followBind: w.followBind, editable: !document.querySelector('#propBody [data-ap="variable"][readonly]') };
}, btn.id);
ok('取消勾选 → followBind=false，动作变量格恢复可编辑',
  un.followBind === false && un.editable === true, JSON.stringify(un));

// 老工程：控件里没有 followBind 这个键 → 照旧当没勾（不会被动改配置）
const legacyBtn = await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  const w = m.getWidget(id);
  delete w.followBind;
  m.commit('模拟老工程按钮');
  return { has: 'followBind' in w };
}, btn.id);
await page.click(`#canvas .wd[data-id="${btn.id}"]`);
await sleep(300);
const lb = await page.evaluate(() => document.getElementById('actFollow')?.checked ?? null);
ok('老工程按钮（没有 followBind 键）→ 面板上不勾、不被动改配置',
  legacyBtn.has === false && lb === false, JSON.stringify({ ...legacyBtn, checked: lb }));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 数值输入范围限制 + 按钮默认输入输出同变量：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
