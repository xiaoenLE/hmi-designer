// verify-vars-jump-find.mjs — 变量表两件事（现场报的）：
//   ① **新建变量后自动跳到它** —— 变量上千时新变量落在列表最末尾，得自己滚到底去找，
//      而且**名称格要直接聚焦**（建完就是要改名/填地址）；搜索框里有词时还得先把它清掉，
//      不然新变量被搜索条件挡着，看着像"没建上"。
//   ② **搜索要能按地址搜** —— 现场常常是拿着 PLC 上的点位来找变量（"MW100 是哪个变量"）：
//      · 变量表的搜索框：名称 / 地址 / 类型都参与（这条本来就有，这里钉住别退化）
//      · 选变量的地方（属性面板那个框 varPick）：以前**只认变量名**（老要求：打 HR500 别冒出
//        一堆不相干的）—— 现在按地址也能搜到，但**名字命中的排在前面**、地址命中的打标记，
//        两边都不耽误
//
// 用法：node tools/run-suites.mjs verify-vars-jump-find
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
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());   // 纯本地，不碰后端
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(300);

/* ── 造 300 个变量：让变量表进入**窗口化渲染**（只画可视区那几十行）。
      这样"新建后没跳过去"= 新那一行压根没被画出来，一眼就能断言。 ── */
await page.evaluate(() => {
  const pr = window.app.project;
  pr.data.variables.length = 0;
  for (let i = 1; i <= 300; i++) {
    pr.data.variables.push({ name: `bMotor${i}`, type: 'bool', address: `%MX${Math.floor(i / 8)}.${i % 8}`, value: false, len: 0 });
  }
  pr.data.variables.push({ name: 'rTemp', type: 'real', address: '%MW100', value: 25.5, len: 0 });
  pr.data.variables.push({ name: '线速度', type: 'real', address: '%MD50', value: 0, len: 0 });
  pr.commit('造变量');
});
await sleep(300);
await page.click('.lp-tab[data-tab="vars"]');       // 切到「变量」面板
await sleep(300);

/* ── 小工具 ── */
const scroller = '#varTable';
const panelState = () => page.evaluate((sel) => {
  const box = document.querySelector(sel);
  const s = box.closest('.panel-body') || box.parentElement;
  const trs = [...document.querySelectorAll('#varRows tr[data-vrow]')];
  return {
    rendered: trs.length,
    scrollTop: Math.round(s.scrollTop),
    scrollable: s.scrollHeight > s.clientHeight + 2,
  };
}, scroller);
/** 某一行在不在**视野内**（窗口化渲染下，没滚过去连行都没有） */
const rowInView = (name) => page.evaluate((n) => {
  const s = document.querySelector('#varTable').closest('.panel-body');
  const tr = document.querySelector(`#varRows tr[data-vrow="${n}"]`);
  if (!tr) return { exists: false };
  const r = tr.getBoundingClientRect(), sr = s.getBoundingClientRect();
  return {
    exists: true,
    inView: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1,
    top: Math.round(r.top), panelTop: Math.round(sr.top), panelBottom: Math.round(sr.bottom),
  };
}, name);
const varNames = () => page.evaluate(() => window.app.project.variables().map(v => v.name));
/** 变量表里当前**画出来**的行名（搜索是渲染前过滤，所以这就是"搜出来的结果"） */
const listedNames = async (q) => {
  await page.fill('#varFilter', q ?? '');
  await sleep(260);
  return page.evaluate(() => [...document.querySelectorAll('#varRows tr[data-vrow]')]
    .map(tr => tr.dataset.vrow).filter(k => !k.startsWith('g:')));
};
const filterValue = () => page.evaluate(() => document.getElementById('varFilter').value);

/* ══════ A. 新建变量 → 自动跳到它 ══════ */
const st0 = await panelState();
ok('A 前置：300+ 变量时变量表是**窗口化**的（只画了一部分行）',
  st0.rendered > 0 && st0.rendered < 300, JSON.stringify(st0));
const totalVars = (await varNames()).length;
const before = await varNames();
ok('A 前置：新变量还没建', !before.includes(`var${before.length + 1}`), String(before.length));

// 先把列表滚到最上面（模拟"正在看开头那几个变量"）
await page.evaluate(() => { document.querySelector('#varTable').closest('.panel-body').scrollTop = 0; });
await sleep(150);
await page.click('#btnAddVar');
await sleep(500);
const names1 = await varNames();
const added = names1[names1.length - 1];
ok('A 点「添加变量」真的建了一个（排在末尾）', names1.length === before.length + 1 && added === `var${before.length + 1}`, added);
const j1 = await rowInView(added);
ok('A 新建后**自动跳到新变量那一行**（行被画出来且在视野内）', j1.exists && j1.inView, JSON.stringify(j1));
const focus1 = await page.evaluate(() => {
  const a = document.activeElement;
  return { k: a?.dataset?.k || '', val: a?.value || '', inPanel: !!a?.closest('#varTable') };
});
ok('A 新建后名称格**直接聚焦并全选**（建完就能改名/填地址，不用再去点一下）',
  focus1.inPanel && focus1.k === 'name' && focus1.val === added, JSON.stringify(focus1));

/* 搜索框里有词时新建：新变量会被条件挡住 → 必须把它露出来（清掉搜索词） */
await page.fill('#varFilter', 'bMotor1');
await sleep(250);
await page.click('#btnAddVar');
await sleep(500);
const names2 = await varNames();
const added2 = names2[names2.length - 1];
const j2 = await rowInView(added2);
ok('A 搜索框里有词时新建：自动把搜索词清掉（新变量不能被搜索条件挡着看不见）',
  (await filterValue()) === '' && j2.exists && j2.inView,
  JSON.stringify({ filter: await filterValue(), row: j2, added: added2 }));
ok('A 清掉搜索词后变量表回到全量（计数按总数走）',
  (await page.evaluate(() => document.getElementById('varCount').textContent)).includes(String(names2.length)),
  await page.evaluate(() => document.getElementById('varCount').textContent));

/* 右键菜单那条路（menus.js 也调 project.addVariable）一样要跳过去 */
await page.evaluate(() => { document.querySelector('#varTable').closest('.panel-body').scrollTop = 0; });
await sleep(150);
const added3 = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return m.project.addVariable().name;
});
await sleep(500);
const j3 = await rowInView(added3);
ok('A 别的入口建变量（右键菜单那条路）也一样跳过去',
  j3.exists && j3.inView, JSON.stringify({ added3, row: j3 }));

/* 面板不在当前页签时（画布右键菜单加变量）：切到「变量」页签时要补上这一跳 */
await page.click('.lp-tab[data-tab="alarms"]');       // 先切走
await sleep(250);
const added4 = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return m.project.addVariable().name;
});
await sleep(250);
await page.click('.lp-tab[data-tab="vars"]');         // 切回变量页签
await sleep(500);
const j4 = await rowInView(added4);
ok('A 面板不在当前页签时加变量 → 切到「变量」页签时补上这一跳',
  j4.exists && j4.inView, JSON.stringify({ added4, row: j4 }));

/* ══════ B. 变量表搜索：名称 / 地址 / 类型 都能搜 ══════ */
const byAddr = await listedNames('MW100');
ok('B 变量表：按**地址**搜得到（MW100 → rTemp）', byAddr.includes('rTemp'), JSON.stringify(byAddr));
ok('B 变量表：带 % 前缀也搜得到（%MW100）', (await listedNames('%MW100')).includes('rTemp'),
  JSON.stringify(await listedNames('%MW100')));
ok('B 变量表：大小写不敏感（mw100）', (await listedNames('mw100')).includes('rTemp'));
ok('B 变量表：地址命中不误伤（MW100 只该出 rTemp 一个）',
  JSON.stringify(await listedNames('MW100')) === JSON.stringify(['rTemp']),
  JSON.stringify(await listedNames('MW100')));
ok('B 变量表：按名称搜照旧（rTemp）', (await listedNames('rTemp')).includes('rTemp'));
ok('B 变量表：中文名照旧（线速度）', (await listedNames('线速度')).includes('线速度'));
await page.fill('#varFilter', '');
await sleep(200);

/* ══════ C. 选变量的地方（属性面板那个框）：按地址也能搜到 ══════ */
const lampId = await page.evaluate(() => {
  const w = window.app.project.addWidget('label', 620, 500);
  window.app.project.commit('t');
  return w.id;
});
await sleep(250);
await page.evaluate(i => {
  const el = document.querySelector(`#canvas .wd[data-id="${i}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, lampId);
await sleep(300);
const vpRows = () => page.evaluate(() => {
  const el = document.querySelector('.vp-list');
  if (!el || el.hidden) return null;
  // 末尾那行「＋ 新建变量…」是"顺手新建"的入口（见 verify-var-add），不算候选变量
  return [...el.querySelectorAll('.vp-row')].filter(r => !r.classList.contains('vp-new')).map(r => ({
    name: r.querySelector('.vp-name')?.textContent ?? '',
    byAddr: r.dataset.byaddr === '1',
    meta: r.querySelector('.vp-meta')?.textContent ?? '',
  }));
});
const SEL = '#propBody [data-bind="variable"]';
const typeQ = async (q) => {
  await page.click(SEL);
  await page.fill(SEL, '');
  if (q) await page.type(SEL, q, { delay: 10 });
  await sleep(200);
  return (await vpRows()) || [];
};

const cAddr = await typeQ('MW100');
ok('C 选变量时按**地址**搜得到（MW100 → rTemp）', cAddr.some(r => r.name === 'rTemp'), JSON.stringify(cAddr.map(r => r.name)));
ok('C 按地址命中的那条**打了标记**（一眼看出它是按地址匹配上的，不是名字）',
  cAddr.find(r => r.name === 'rTemp')?.byAddr === true, JSON.stringify(cAddr));
ok('C 按地址命中时，候选行右边照旧显示类型+地址（能核对）',
  /real/.test(cAddr.find(r => r.name === 'rTemp')?.meta || ''), cAddr.find(r => r.name === 'rTemp')?.meta);

const cMixed = await typeQ('Motor1');
ok('C 名字命中的排在前面（打 Motor1 → 全是名字命中的那些）',
  cMixed.length > 0 && cMixed.every(r => r.name.startsWith('bMotor1')), JSON.stringify(cMixed.map(r => r.name).slice(0, 4)));

const cName = await typeQ('rTemp');
ok('C 按名字搜照旧（rTemp 自己排第一）', cName[0]?.name === 'rTemp', JSON.stringify(cName.map(r => r.name).slice(0, 3)));

const cLong = await typeQ('MD50');
ok('C 换成另一个地址照样搜得到（MD50 → 线速度）', cLong.some(r => r.name === '线速度'),
  JSON.stringify(cLong.map(r => r.name)));

await page.keyboard.press('Escape');

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 变量表：新建后跳过去 + 按地址搜索：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
