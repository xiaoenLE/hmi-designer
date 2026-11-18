// verify-runtime-ui.mjs — 运行态界面：变量监控折叠 / 变量名常显 / 画面等比例适应窗口
// 用法：先启动 8866 服务，再 node test/verify-runtime-ui.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;
const PAD = 12;   // runtime.js 里的 FIT_PAD

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
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.evaluate(() => window.app.exitRun?.());
}
// 进运行态变量监控**整个收起**（运行主页面只有画面，见 verify-runtime-chrome）——
// 这个套件要测抽屉本身（变量名宽度 / 折叠展开 / 画面避让），每次进运行态先叫出来
const unfold = async () => {
  await page.evaluate(async () => {
    const rt = await import('/js/runtime/runtime.js');
    rt.setVarsVisible(true);
    if (rt.isVarsFolded()) rt.toggleVarsFold();      // 要列表，不是只露标题栏
  });
  await page.waitForTimeout(250);
};
// 画面缩放：Ctrl+Shift+Z 是三档轮换（原始/适应/填满），这里要指定某一档就直接调 API
const setZoom = async (mode) => {
  await page.evaluate(async (m) => (await import('/js/runtime/runtime.js')).setZoomMode(m), mode);
  await page.waitForTimeout(200);
};
const panelState = () => page.evaluate(() => {
  const panel = document.getElementById('rtVarsPanel');
  const list = document.getElementById('rtvList');
  return {
    folded: panel.classList.contains('folded'),
    listVisible: getComputedStyle(list).display !== 'none',
    headerVisible: document.querySelector('.rtv-head').getBoundingClientRect().height > 0,
    count: document.getElementById('rtvCount').textContent,
    rows: document.querySelectorAll('.rtv-row').length,
  };
});

/* ══════ 1. 变量监控：每一行都要看得到变量名（数值/字符串行也不能被输入框挤掉）══════ */
await boot();
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(300);
await unfold();
const names = await page.evaluate(() => [...document.querySelectorAll('.rtv-row')].map(r => {
  const n = r.querySelector('.rtv-name');
  const v = r.querySelector('.rtv-val');
  return {
    name: n?.textContent ?? '',
    nameW: Math.round(n?.getBoundingClientRect().width || 0),
    valW: Math.round(v?.getBoundingClientRect().width || 0),
    type: r.querySelector('input')?.type || 'switch',
  };
}));
const numberRows = names.filter(r => r.type === 'number' || r.type === 'text');
ok('变量行全部显示了变量名（宽度 > 20px）', names.length > 0 && names.every(r => r.name && r.nameW > 20),
  JSON.stringify(names.slice(0, 4)));
ok('数值/字符串变量行不再被输入框吃满整行', numberRows.length > 0 && numberRows.every(r => r.valW <= 120),
  `数值行 ${numberRows.length} 个，输入框宽 ${numberRows.map(r => r.valW).join('/')}`);
const cnt = await page.evaluate(() => document.getElementById('rtvCount').textContent);
ok('标题栏变量个数与变量表一致', cnt.includes(String(names.length)), `${cnt} / rows=${names.length}`);

/* ══════ 2. 折叠：点标题栏收起，行仍在 DOM 里（推送照常更新）══════ */
const beforeFold = await panelState();
await page.click('#rtvHead');
await page.waitForTimeout(150);
const folded = await panelState();
ok('点击标题栏可折叠变量监控', !beforeFold.folded && folded.folded && !folded.listVisible, JSON.stringify(folded));
ok('折叠后标题栏仍然可见（能再展开）', folded.headerVisible === true);
ok('折叠只是隐藏，变量行仍在 DOM（运行中推送不会丢）', folded.rows === beforeFold.rows && folded.rows > 0,
  `rows=${folded.rows}`);
// 折叠状态下变量更新 → 行内容仍被更新，展开即最新
await page.evaluate(() => window.app.varStore.set('rSpeed', 55.5, 'remote'));
await page.waitForTimeout(120);
const rowVal = await page.evaluate(() => [...document.querySelectorAll('.rtv-row')]
  .find(r => r.dataset.vname === 'rSpeed')?.querySelector('input')?.value);
ok('折叠期间变量推送仍更新到隐藏的行上', String(rowVal) === '55.5', String(rowVal));
await page.click('#rtvHead');
await page.waitForTimeout(150);
ok('再次点击展开', (await panelState()).listVisible === true);
await page.evaluate(() => window.app.exitRun());

/* ══════ 3. 折叠状态记住（刷新后仍折叠）══════ */
// 此时已退出运行态，面板不可见 → 用 JS 触发（折叠状态本身与是否运行无关）
await page.evaluate(() => document.getElementById('rtvHead').click());
await page.waitForTimeout(100);
const foldedSaved = await page.evaluate(() => localStorage.getItem('hmi-rtv-folded'));
await boot();                                    // 刷新
const afterReload = await panelState();
ok('折叠状态刷新后保持（localStorage）', afterReload.folded && !afterReload.listVisible && foldedSaved === '1',
  `${JSON.stringify(afterReload)} saved=${foldedSaved}`);
await page.evaluate(() => document.getElementById('rtvHead').click());   // 还原后继续
await page.waitForTimeout(100);

/* ══════ 4. 运行画面默认等比例放大填充（并避开变量监控面板） ══════ */
await boot();
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(400);
await unfold();                                   // 展开面板才谈得上「避让」
const readGeo = () => page.evaluate(() => {
  const c = window.app.project.data.meta.canvas;
  const r = document.getElementById('rtPage').getBoundingClientRect();
  const panel = document.getElementById('rtVarsPanel');
  const pr = panel.getBoundingClientRect();
  const folded = panel.classList.contains('folded');
  return {
    cw: c.w, ch: c.h, rw: r.width, rh: r.height, x: r.x, y: r.y,
    vw: window.innerWidth, vh: window.innerHeight,
    reserved: folded ? 0 : Math.round(pr.width) + 14, panelLeft: pr.left,
  };
});
const geo = await readGeo();
const availW = geo.vw - geo.reserved - PAD * 2, availH = geo.vh - PAD * 2;
const expectK = Math.min(availW / geo.cw, availH / geo.ch);
ok('画面按窗口等比例放大（不是 1:1 留黑边）',
  Math.abs(geo.rw - geo.cw * expectK) <= 2 && Math.abs(geo.rh - geo.ch * expectK) <= 2,
  `期望 ${(geo.cw * expectK).toFixed(0)}x${(geo.ch * expectK).toFixed(0)} 实际 ${geo.rw.toFixed(0)}x${geo.rh.toFixed(0)}`);
ok('放大后仍完整落在窗口内', geo.x >= -1 && geo.y >= -1 && geo.x + geo.rw <= geo.vw + 1 && geo.y + geo.rh <= geo.vh + 1,
  `x=${geo.x.toFixed(0)} y=${geo.y.toFixed(0)}`);
ok('保持原画布宽高比', Math.abs((geo.rw / geo.rh) - (geo.cw / geo.ch)) < 0.01,
  `${(geo.rw / geo.rh).toFixed(3)} vs ${(geo.cw / geo.ch).toFixed(3)}`);
ok('画面不被变量监控面板压住（避让展开的面板）', geo.x + geo.rw <= geo.panelLeft + 1,
  `画面右边界 ${(geo.x + geo.rw).toFixed(0)} / 面板左边界 ${geo.panelLeft.toFixed(0)}`);
const fitLabel = await page.textContent('#rtFit');
ok('按钮上显示当前缩放比例', /\d+%/.test(fitLabel), fitLabel);

/* ══════ 4b. 折叠变量监控 → 画面变大填满整窗 ══════ */
await page.click('#rtvHead');
await page.waitForTimeout(250);
const geoFolded = await readGeo();
ok('折叠变量监控后画面变大（吃满整个窗口）', geoFolded.rw > geo.rw + 20,
  `${geo.rw.toFixed(0)} → ${geoFolded.rw.toFixed(0)}`);
await page.click('#rtvHead');
await page.waitForTimeout(250);
ok('展开回来画面还原', Math.abs((await readGeo()).rw - geo.rw) <= 2);

/* ══════ 5. 放大状态下点击/交互仍然准（transform 命中测试）══════ */
await page.evaluate(() => window.app.varStore.resetFrom(window.app.project.data.variables));
// 选控件按「它干什么」找，不按文字找：按钮的「状态显示」跟着动作变量走，
// 模板里那个「启停切换」按钮（没显式绑状态变量）现在显示的是「关/开」，静态文字没了。
const btnSel = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.pages()[0].widgets.find(x =>
    x.type === 'button' && (x.actions || []).some(a => a.params?.variable === 'bRunCmd'));
  return w ? `#rtPage .wd[data-id="${w.id}"]` : '';
});
ok('找得到「启停切换」按钮（按动作变量 bRunCmd 定位）', !!btnSel, btnSel);
const btn = page.locator(btnSel);
await btn.click();
await page.waitForTimeout(150);
const toggled = await page.evaluate(() => window.app.varStore.get('bRunCmd'));
ok('放大状态下按钮点击命中正确（toggle 生效）', toggled === true, `bRunCmd=${toggled}`);

/* ══════ 6. 弹窗按同一比例缩放 + 可拖拽 + 可关闭 ══════ */
const popSel = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.pages()[0].widgets.find(x =>
    x.type === 'button' && (x.actions || []).some(a => a.type === 'showPopup'));
  return w ? `#rtPage .wd[data-id="${w.id}"]` : '';
});
ok('找得到「报警详情」按钮（按 showPopup 动作定位）', !!popSel, popSel);
await page.locator(popSel).click();
await page.waitForTimeout(300);
const pop = await page.evaluate(() => {
  const pg = window.app.project.getPage('pg_alarm');
  const card = document.querySelector('#rtPopupLayer .rt-popup');
  const r = card.getBoundingClientRect();
  const mask = document.querySelector('#rtPopupLayer .rt-popup-mask').getBoundingClientRect();
  const page = document.getElementById('rtPage').getBoundingClientRect();
  return { pw: pg.popupW, ph: pg.popupH, rw: r.width, rh: r.height,
    cx: r.x + r.width / 2, cy: r.y + r.height / 2, pageCx: page.x + page.width / 2,
    maskW: mask.width, maskH: mask.height, vw: window.innerWidth, vh: window.innerHeight };
});
const scaleNow = pop.rw / pop.pw;
ok('弹窗与页面同比例缩放', Math.abs(pop.rw - pop.pw * scaleNow) <= 2 && Math.abs(pop.rw / pop.pw - pop.rw / pop.pw) < 1e-6,
  `弹窗 ${pop.rw.toFixed(0)}x${pop.rh.toFixed(0)}（页面缩放 ${(scaleNow * 100).toFixed(0)}%）`);
ok('遮罩仍铺满整个窗口（不被缩放）', Math.abs(pop.maskW - pop.vw) <= 1 && Math.abs(pop.maskH - pop.vh) <= 1,
  `${pop.maskW} x ${pop.maskH} / 窗口 ${pop.vw} x ${pop.vh}`);
ok('弹窗与运行画面同一中心', Math.abs(pop.cx - pop.pageCx) <= 2, `弹窗中心 ${pop.cx.toFixed(0)} / 画面中心 ${pop.pageCx.toFixed(0)}`);

const head = await page.locator('#rtPopupLayer .rt-popup-head').boundingBox();
await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
await page.mouse.down();
await page.mouse.move(head.x + head.width / 2 + 140, head.y + head.height / 2 + 90, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const moved = await page.evaluate(() => {
  const r = document.querySelector('#rtPopupLayer .rt-popup').getBoundingClientRect();
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width };
});
ok('放大状态下弹窗标题栏拖拽跟手（位移≈指针位移）',
  Math.abs(moved.cx - (pop.cx + 140)) <= 4 && Math.abs(moved.cy - (pop.cy + 90)) <= 4,
  `中心 ${pop.cx.toFixed(0)},${pop.cy.toFixed(0)} → ${moved.cx.toFixed(0)},${moved.cy.toFixed(0)}`);
ok('拖拽后尺寸不变（缩放系数没被吃掉）', Math.abs(moved.w - pop.rw) <= 2, `${moved.w.toFixed(0)} vs ${pop.rw.toFixed(0)}`);
await page.evaluate(() => document.querySelector('#rtPopupLayer .rt-popup-close').click());
await page.waitForTimeout(200);
ok('弹窗仍可正常关闭', await page.evaluate(() => !document.querySelector('#rtPopupLayer .rt-popup')));

/* ══════ 7. 切回 1:1 原始尺寸 ══════ */
// ⚠ 运行主页面不再摆「适应窗口」按钮（界面精简，见 verify-runtime-chrome）——
//   功能走快捷键 Ctrl+Shift+Z（右键菜单里也有），按钮本身还在 DOM 里（只是隐藏）负责显示当前档位
await setZoom('orig');
const one2one = await page.evaluate(() => {
  const c = window.app.project.data.meta.canvas;
  const r = document.getElementById('rtPage').getBoundingClientRect();
  return { cw: c.w, ch: c.h, rw: r.width, rh: r.height };
});
ok('点一下切回 1:1 原始尺寸', Math.abs(one2one.rw - one2one.cw) <= 1 && Math.abs(one2one.rh - one2one.ch) <= 1,
  `${one2one.rw}x${one2one.rh} vs ${one2one.cw}x${one2one.ch}`);
const label2 = await page.textContent('#rtFit');
ok('按钮状态跟着切换', /100%/.test(label2), label2);

/* ══════ 8. 缩放模式也记住；退出运行后画面复位 ══════ */
await boot();
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(300);
const afterBoot = await page.evaluate(() => {
  const r = document.getElementById('rtPage').getBoundingClientRect();
  return { rw: Math.round(r.width) };
});
ok('1:1 模式刷新后保持', afterBoot.rw === 1024, `width=${afterBoot.rw}`);
await setZoom('fit');                             // 切回适应窗口
await page.waitForTimeout(200);
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(200);
const afterExit = await page.evaluate(() => document.getElementById('rtPage').style.transform);
ok('退出运行后清掉缩放，不影响下次进入', afterExit === 'none', `transform=${afterExit}`);

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 运行态界面回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
