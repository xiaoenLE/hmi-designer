// verify-btn-hold.mjs — 按钮「延迟触发（按住够久才执行）」+ 按钮动作「清空报警记录」
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

/* 后端隔离：stub 掉 probe 强制「本地模拟」，防止 Python 后端把变量值拉回去。
   ⚠ 只 stub probe 不够：写过不去的地址时（后端 plc 模式 + 端口不通），
   varStore.push 失败会 resync 把界面值改回设备值 —— 那样「按住到点置 TRUE」永远读成 false。
   把读写通道一起掐掉，本套件只管交互时序。 */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
  m.backend.readVar = async () => undefined;
  // 报警记录会落盘到服务器（server/data/alarm_history.json）并在进运行态时读回来 ——
  // 本套件只看交互时序和"本地那份清没清"，把这条通道也掐掉，测试才可重复
  m.backend.loadAlarms = async () => [];
  m.backend.saveAlarms = async () => ({ ok: true });
  m.backend.expectsServer = () => false;
}));
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => { try { localStorage.removeItem('hmi-alarm-history'); } catch { /* 忽略 */ } });
await sleep(300);

/* ── A. 定义：默认值 / 属性 schema / 动作表 ── */
const def = await page.evaluate(async () => {
  const r = await import('/js/widgets/registry.js');
  const d = r.registry.get('button');
  const p = d.props.find(x => x.key === 'holdMs');
  return {
    defVal: d.defaults.holdMs,
    has: !!p, label: p?.label, type: p?.type, min: p?.min, max: p?.max, hint: p?.hint || '',
    actions: d.actions,
    clearLabel: r.ACTION_DEFS.clearAlarm?.label,
  };
});
ok('按钮默认「延迟触发」= 0（点一下立即执行，老工程行为不变）', def.defVal === 0, String(def.defVal));
ok('按钮属性 schema 里有「延迟触发(ms)」（数字，0~60000）',
  def.has && def.label === '延迟触发(ms)' && def.type === 'number' && def.min === 0 && def.max === 60000,
  JSON.stringify([def.label, def.type, def.min, def.max]));
ok('按钮动作列表里有「清空报警记录」，ACTION_DEFS 有中文标签',
  def.actions.includes('clearAlarm') && def.clearLabel === '清空报警记录',
  JSON.stringify([def.actions, def.clearLabel]));
ok('新增动作不影响默认动作（添加动作弹的仍是「点动」）', def.actions[0] === 'tap', def.actions[0]);

/* ── B. 属性面板：一行「延迟触发(ms)」── */
const ids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.pages[0].widgets.length = 0;
  m.project.data.variables.length = 0;
  m.project.data.alarms.length = 0;
  m.project.addVariable(); m.project.updateVariable('var1', { name: 'bHold', type: 'bool', value: false });
  m.project.addVariable(); m.project.updateVariable('var2', { name: 'bFast', type: 'bool', value: false });
  m.project.addVariable(); m.project.updateVariable('var3', { name: 'iAlarm', type: 'int', value: 0 });
  const w = m.project.addWidget('button', 40, 40);
  m.project.commit('准备按钮');
  return { w: w.id };
});
await sleep(250);

/** 选中控件（用真鼠标点：选中判定挂在 pointerdown 上，合成 .click() 选不中）→ 读属性面板里那一行 */
const panelOf = async (wid) => {
  await page.click(`#canvas .wd[data-id="${wid}"]`);
  await sleep(180);
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('#propBody .f-row')];
    const row = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '延迟触发(ms)');
    const inp = row?.querySelector('input');
    const hint = rows.find(r => /松手/.test(r.textContent) && !r.querySelector('input'));
    return { has: !!row, value: inp?.value, type: inp?.type, min: inp?.min, hint: !!hint };
  });
};

let pb = await panelOf(ids.w);
ok('面板里出现「延迟触发(ms)」输入行（number，min=0）',
  pb.has && pb.type === 'number' && pb.min === '0' && pb.value === '0', JSON.stringify(pb));
ok('面板里只留输入行，不再摊一大段说明文字（按住/松手那段话不显示了）', pb.hint === false);

// 面板里改成 800 → 写进工程 props.holdMs（number，不是字符串）
await page.evaluate(() => {
  const inp = document.querySelector('#propBody input[data-prop="holdMs"]');
  inp.value = '800';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(400);
const wrote = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const v = m.project.getWidget(wid).props.holdMs;
  return { v, type: typeof v };
}, ids.w);
ok('面板改成 800 → 工程里存成数字 800', wrote.v === 800 && wrote.type === 'number', JSON.stringify(wrote));

// 超出上限按边界收敛（60000）
await page.evaluate(() => {
  const inp = document.querySelector('#propBody input[data-prop="holdMs"]');
  inp.value = '999999';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(400);
const clamped = await page.evaluate(async (wid) => (await import('/js/core/project.js')).project.getWidget(wid).props.holdMs, ids.w);
ok('超上限收敛到 60000（不许填出离谱值）', clamped === 60000, String(clamped));

/* 老工程：props 里没有 holdMs 键 → 面板显示 0，不是 undefined */
const legacyId = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.addWidget('button', 300, 40);
  delete w.props.holdMs;
  m.project.commit('老工程按钮');
  return w.id;
});
await sleep(250);
const pl = await panelOf(legacyId);
ok('老工程缺 holdMs 键 → 面板显示 0（不显示 undefined）', pl.has && pl.value === '0', String(pl.value));

/* ── C. 运行态：按住够久才执行 ── */
const rt = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const pg = m.project.data.pages[0];
  pg.widgets.length = 0;
  const mk = (x, holdMs, variable, acts) => {
    const w = m.project.addWidget('button', x, 60);
    m.project.updateWidgetField(w.id, 'bindings.variable', variable);
    m.project.updateWidgetProp(w.id, 'holdMs', holdMs);
    m.project.updateWidgetActions(w.id, acts);
    return w.id;
  };
  // 点动按钮的两个变量（第 17 轮：点动也要过延迟触发的闸）
  m.project.addVariable(); m.project.updateVariable('var4', { name: 'bTap', type: 'bool', value: false });
  m.project.addVariable(); m.project.updateVariable('var5', { name: 'bTapFast', type: 'bool', value: false });
  const hold = mk(40, 400, 'bHold', [{ trigger: 'click', type: 'toggle', params: { variable: 'bHold' } }]);
  const fast = mk(200, 0, 'bFast', [{ trigger: 'click', type: 'toggle', params: { variable: 'bFast' } }]);
  const clear = mk(360, 300, 'iAlarm', [{ trigger: 'click', type: 'clearAlarm', params: {} }]);
  const tap = mk(520, 400, 'bTap', [{ trigger: 'click', type: 'tap', params: { variable: 'bTap' } }]);
  const tapFast = mk(680, 0, 'bTapFast', [{ trigger: 'click', type: 'tap', params: { variable: 'bTapFast' } }]);
  m.project.commit('长按测试按钮');
  return { hold, fast, clear, tap, tapFast };
});
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(400);

const box = async (id) => page.locator(`#rtPage .wd[data-id="${id}"]`).boundingBox();
const holdState = (id, vname = 'bHold') => page.evaluate(([id, vname]) => {
  const ov = document.querySelector(`#rtPage .wd[data-id="${id}"] .wd-hold`);
  return {
    v: window.app.varStore.get(vname),
    exists: !!ov,
    on: !!ov && ov.classList.contains('on'),
    done: !!ov && ov.classList.contains('done'),
    pct: ov ? parseFloat(ov.style.width || '0') : -1,
  };
}, [id, vname]);
/** 在控件中心按下 → 等 ms → （可选）松手 */
async function press(id, ms, release = true) {
  const b = await box(id);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await sleep(ms);
  const mid = await holdState(id);
  if (release) await page.mouse.up();
  return { mid, ...(await box(id)) };
}

const bh = await box(rt.hold);
ok('运行态按钮上有进度层 .wd-hold（初始隐藏）',
  (await holdState(rt.hold)).exists === true && (await holdState(rt.hold)).on === false);

// C1. 短按（没到 400ms）→ 不执行
const short = await press(rt.hold, 120);
await sleep(250);
const afterShort = await holdState(rt.hold);
ok('按住 120ms（< 400）松手 → 动作不执行（bHold 仍 false）', afterShort.v === false, String(afterShort.v));
ok('按住过程有进度反馈（进度层显示、宽度在 0~100% 之间）',
  short.mid.on === true && short.mid.pct > 0 && short.mid.pct < 100, JSON.stringify(short.mid));
ok('松手后进度收起（不残留半格进度条）',
  afterShort.on === false && afterShort.done === false && afterShort.pct === 0, JSON.stringify(afterShort));

// C2. 长按到点 → 执行一次（松开时不再重复触发）
const long = await press(rt.hold, 520);
ok('按住 520ms（> 400）→ 动作执行（bHold 翻成 true）', long.mid.v === true, String(long.mid.v));
ok('到点后进度满格（.wd-hold done + 100%）', long.mid.done === true && long.mid.pct === 100, JSON.stringify(long.mid));
await sleep(300);
const afterLong = await holdState(rt.hold);
ok('一次长按只执行一次（松开时 click 不会再来一遍 → 仍是 true）',
  afterLong.v === true, String(afterLong.v));
ok('触发后进度自动收起', afterLong.on === false && afterLong.done === false, JSON.stringify(afterLong));

// C3. 再来一次：值翻转回去（说明取消过/执行过的状态都复位了）
const again = await press(rt.hold, 600);
await sleep(200);
ok('再次长按仍然生效（bHold 翻回 false，无残留状态）',
  again.mid.v === false && (await holdState(rt.hold)).v === false, String(again.mid.v));

// C4. 按住过程中变量被外部改写（绑定控件 DOM 会被重建）→ 长按照常算数
//     （进度条挂在外壳 .wd 上就是为了这个：画在 .wd-body 里会被重建刷掉）
const b4 = await box(rt.hold);
await page.mouse.move(b4.x + b4.width / 2, b4.y + b4.height / 2);
await page.mouse.down();
await sleep(150);
await page.evaluate(() => window.app.varStore.set('bHold', true, 'remote'));   // 触发 refreshWidgetBody
await sleep(100);
const midRebuild = await holdState(rt.hold);
await sleep(400);                                                             // 累计超过 400ms
const firedRebuild = await holdState(rt.hold);
await page.mouse.up();
await sleep(200);
ok('按住中被外部改值重建 DOM，进度条还在（挂在外壳上没被刷掉）',
  midRebuild.on === true && midRebuild.pct > 0, JSON.stringify(midRebuild));
ok('按住中被重建也不影响触发（到点照样满格执行一次）',
  firedRebuild.on === true && firedRebuild.done === true && firedRebuild.pct === 100, JSON.stringify(firedRebuild));
ok('重建后触发的动作按当时的变量值算（true → 翻成 false）',
  firedRebuild.v === false, String(firedRebuild.v));

// C5. 按住后移出控件 → 取消（哪怕超过阈值）
const b5 = await box(rt.hold);
await page.mouse.move(b5.x + b5.width / 2, b5.y + b5.height / 2);
await page.mouse.down();
await sleep(150);
const midLeave = await holdState(rt.hold);
await page.mouse.move(b5.x + b5.width / 2, b5.y + b5.height / 2 + 220);   // 移出控件
await sleep(500);                                                        // 已超过 400ms
const outState = await holdState(rt.hold);
await page.mouse.up();
await sleep(200);
ok('按住后移出控件 → 取消（超过阈值也不执行）', outState.v === false, String(outState.v));
ok('移出后进度立刻收起', midLeave.on === true && outState.on === false && outState.pct === 0,
  JSON.stringify([midLeave.on, outState.on, outState.pct]));

// C6. 取消之后还能正常触发
const afterCancel = await press(rt.hold, 550);
await sleep(200);
ok('取消过一次之后照常能用（bHold 翻成 true）', afterCancel.mid.v === true, String(afterCancel.mid.v));

// C7. 延迟触发 = 0 的按钮：点一下立即执行（老行为回归）
const bf = await box(rt.fast);
await page.mouse.click(bf.x + bf.width / 2, bf.y + bf.height / 2);
await sleep(200);
const fastVal = await page.evaluate(() => window.app.varStore.get('bFast'));
const fastOverlay = await page.evaluate((id) => {
  const ov = document.querySelector(`#rtPage .wd[data-id="${id}"] .wd-hold`);
  return { exists: !!ov, on: !!ov && ov.classList.contains('on') };
}, rt.fast);
ok('延迟触发=0 的按钮：点一下立即执行（bFast=true）', fastVal === true, String(fastVal));
ok('延迟触发=0 的按钮不挂进度层（不多余 DOM）', fastOverlay.exists === false, JSON.stringify(fastOverlay));

/* ── C8. 点动(tap) + 延迟触发：按住够久才置 TRUE，松开立即 FALSE，没到点一个字节都不下发 ──
   现场诉求：「点动按钮时延时功能也要生效」—— 按住 1 秒机器才动，防止误碰。 */
const tapVal = (n) => page.evaluate((n) => window.app.varStore.get(n), n);
const tapAt = async (id, ms, vname, release = true) => {
  const b = await box(id);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await sleep(ms);
  const mid = await holdState(id, vname);
  if (release) await page.mouse.up();
  return mid;
};
await page.evaluate(() => { window.app.varStore.set('bTap', false, 'test'); window.app.varStore.set('bTapFast', false, 'test'); });
await sleep(150);

// C8a 短按（没到 400ms）→ 一次都不下发
const tapShort = await tapAt(rt.tap, 120, 'bTap');
const tapShortFired = await tapVal('bTap');
await sleep(200);
ok('点动+延迟：按住 120ms（< 400）松手 → 没到点，一次都没下发（bTap 全程 false）',
  tapShort.v === false && tapShortFired === false && (await tapVal('bTap')) === false,
  JSON.stringify([tapShort.v, tapShortFired, await tapVal('bTap')]));
ok('点动+延迟：按住过程有进度反馈', tapShort.on === true && tapShort.pct > 0 && tapShort.pct < 100, JSON.stringify(tapShort));

// C8b 长按到点 → TRUE；松开 → 立即 FALSE
const b8 = await box(rt.tap);
await page.mouse.move(b8.x + b8.width / 2, b8.y + b8.height / 2);
await page.mouse.down();
await sleep(230);
const tapMidNotYet = await tapVal('bTap');
await sleep(260);                                     // 累计 490 > 400
const tapFired = await holdState(rt.tap, 'bTap');
await page.mouse.up();
await sleep(200);
const tapReleased = await holdState(rt.tap, 'bTap');
ok('点动+延迟：按住中未到点仍是 FALSE（不提前动作）', tapMidNotYet === false, String(tapMidNotYet));
ok('点动+延迟：按住到点 → 置 TRUE（机器开始动）', tapFired.v === true, String(tapFired.v));
ok('点动+延迟：到点后进度满格变绿（告诉用户"可以松手了"）',
  tapFired.on === true && tapFired.done === true && tapFired.pct === 100, JSON.stringify(tapFired));
ok('点动+延迟：松开 → 立即置 FALSE（机器停）', tapReleased.v === false, String(tapReleased.v));
ok('点动+延迟：松手后进度收起，无残留',
  tapReleased.on === false && tapReleased.done === false && tapReleased.pct === 0, JSON.stringify(tapReleased));

// C8c 到点后把指针移出控件 → 也算松开（必须回 FALSE）
const b8c = await box(rt.tap);
await page.mouse.move(b8c.x + b8.width / 2, b8c.y + b8.height / 2);
await page.mouse.down();
await sleep(480);
const beforeLeave = await holdState(rt.tap, 'bTap');
await page.mouse.move(b8c.x + b8.width / 2, b8c.y + b8.height / 2 + 240);   // 移出控件
await sleep(200);
const afterLeave = await holdState(rt.tap, 'bTap');
await page.mouse.up();
await sleep(150);
ok('点动+延迟：到点后在控件外松手 → 变量必须回 FALSE（点动不能卡在 TRUE）',
  beforeLeave.v === true && afterLeave.v === false && (await tapVal('bTap')) === false,
  JSON.stringify([beforeLeave.v, afterLeave.v, await tapVal('bTap')]));

// C8d 到点后窗口失焦（触摸被系统打断 / 用户切窗口）→ 也必须回 FALSE
const b8d = await box(rt.tap);
await page.mouse.move(b8d.x + b8.width / 2, b8d.y + b8.height / 2);
await page.mouse.down();
await sleep(480);
const beforeBlur = await tapVal('bTap');
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await sleep(200);
const afterBlur = await tapVal('bTap');
await page.mouse.up();
await sleep(150);
ok('点动+延迟：到点后窗口失焦 → 兜底放回 FALSE（安全兜底，不靠松手事件）',
  beforeBlur === true && afterBlur === false, JSON.stringify([beforeBlur, afterBlur]));

// C8e 再到点一次，确认取消/触发后状态都复位了
const again8 = await tapAt(rt.tap, 520, 'bTap');
await sleep(150);
ok('点动+延迟：取消过一次之后照常能用（再按住到点 → TRUE）', again8.v === true, String(again8.v));
await page.mouse.up();
await sleep(150);

// C8f 点动 + 延迟=0：按下立即 TRUE，松开 FALSE（老行为回归）
const b8f = await box(rt.tapFast);
await page.mouse.move(b8f.x + b8f.width / 2, b8f.y + b8f.height / 2);
await page.mouse.down();
await sleep(90);
const fastDown = await tapVal('bTapFast');
const fastOverlay2 = await page.evaluate((id) => {
  const ov = document.querySelector(`#rtPage .wd[data-id="${id}"] .wd-hold`);
  return { exists: !!ov };
}, rt.tapFast);
await page.mouse.up();
await sleep(180);
const fastUp = await tapVal('bTapFast');
ok('点动+延迟=0：按下立即 TRUE（老工程行为不变）', fastDown === true, String(fastDown));
ok('点动+延迟=0：松开立即 FALSE', fastUp === false, String(fastUp));
ok('点动+延迟=0 的按钮不挂进度层（不多余 DOM）', fastOverlay2.exists === false, JSON.stringify(fastOverlay2));

// C8g 面板上不再摊说明文字（用户要求）：点动同样受延迟触发管这件事，行为本身在下面验
ok('面板上不再显示「延迟触发」的说明文字（只留输入行）', !def.hint, def.hint || '(没有说明文字)');

/* ── D. 按钮动作「清空报警记录」 ── */
const alarmReady = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const a = m.project.addAlarm();
  m.project.updateAlarm(a.id, { name: '长按测试报警', variable: 'iAlarm', op: '>=', value: 1, level: 'alarm', text: '计数到 {iAlarm}' });
  m.project.commit('加一条报警');
  return { alarmVar: m.project.alarms()[0].variable };
});
await sleep(200);
// 写变量 → 引擎判定 → 进当前报警 + 记一条历史
await page.evaluate(() => window.app.varStore.set('iAlarm', 3, 'remote'));
await sleep(500);
const before = await page.evaluate(async () => {
  const A = await import('/js/runtime/alarms.js');
  return { active: A.activeAlarms().length, hist: A.alarmHistory().length };
});
ok('准备：条件成立后有 1 条当前报警 + 1 条历史记录',
  before.active === 1 && before.hist === 1, JSON.stringify(before));

// 带延迟触发的「清空报警记录」按钮：短按不清（防误碰）
await press(rt.clear, 120);
await sleep(200);
const afterShortClick = await page.evaluate(async () => (await import('/js/runtime/alarms.js')).alarmHistory().length);
ok('清记录按钮带延迟触发：短按（120ms < 300）不动历史', afterShortClick === 1, String(afterShortClick));

// 按住到点 → 历史清空，当前报警不受影响
await press(rt.clear, 520);
await sleep(300);
const afterClear = await page.evaluate(async () => {
  const A = await import('/js/runtime/alarms.js');
  return {
    hist: A.alarmHistory().length,
    active: A.activeAlarms().length,
    stored: JSON.parse(localStorage.getItem('hmi-alarm-history') || '[]').length,
  };
});
ok('按住够久 → 报警历史被清空', afterClear.hist === 0, String(afterClear.hist));
ok('清的是「记录」，当前报警不受影响（条件还在，仍是 1 条）', afterClear.active === 1, String(afterClear.active));
ok('清空同时写进 localStorage（刷新不会又冒出来）', afterClear.stored === 0, String(afterClear.stored));

// 面板动作下拉里能选到「清空报警记录」
const actPanel = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const rt2 = await import('/js/runtime/runtime.js');
  rt2.exitRun();
  m.project.setCurrentPage(m.project.pages()[0].id);
  const w = m.project.addWidget('button', 520, 60);
  m.project.commit('动作下拉检查');
  return w.id;
});
await sleep(400);
await page.click(`#canvas .wd[data-id="${actPanel}"]`);
await sleep(250);
await page.click('#actAdd');
await sleep(300);
const actOptions = await page.evaluate(async (wid) => {
  const sel = document.querySelector('#actList select[data-atype]');
  return { opts: [...(sel?.querySelectorAll('option') || [])].map(o => o.textContent.trim()), sel: sel?.value };
}, actPanel);
ok('面板动作下拉里有「清空报警记录」选项',
  actOptions.opts.includes('清空报警记录'), actOptions.opts.join(' / '));
ok('添加动作后选中项仍是「点动」（默认动作没被改掉）', actOptions.sel === 'tap', String(actOptions.sel));

/* ── E. 存档往返：延迟触发设置跟着工程走 ── */
const roundTrip = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const json = JSON.parse(JSON.stringify(m.project.data));
  m.project.replaceData(json);
  const w = m.project.getWidget(wid);
  return { holdMs: w?.props?.holdMs, act: w?.actions?.[0]?.type };
}, rt.clear);
ok('存档往返后 holdMs 还在（300 → 刷新页面不掉）', roundTrip.holdMs === 300, String(roundTrip.holdMs));
ok('存档往返后 clearAlarm 动作还在', roundTrip.act === 'clearAlarm', String(roundTrip.act));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 按钮延迟触发 + 清空报警记录：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
