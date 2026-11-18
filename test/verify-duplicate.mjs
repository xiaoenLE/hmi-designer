// verify-duplicate.mjs — 多重复制：Ctrl+D / 对话框（份数·排列·间距）/ 名称与变量名递增 / 整块复制 / 撤销
// 用法：先启动 8866 服务，再 node test/verify-duplicate.mjs
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
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
let lastDialog = '';
page.on('dialog', d => { lastDialog = d.message(); d.accept(); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(250);

/** 造一个带序号的指示灯并选中它 */
async function makeLamp(name, variable, x = 60, y = 60) {
  return page.evaluate(([name, variable, x, y]) => {
    const pr = window.app.project;
    const w = pr.addWidget('lamp', x, y);
    w.name = name; w.bindings.variable = variable;
    pr.commit('t');
    const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return w.id;
  }, [name, variable, x, y]);
}
const lamps = () => page.evaluate(() => window.app.project.currentWidgets()
  .filter(w => w.type === 'lamp')
  .map(w => ({ name: w.name, v: w.bindings.variable || '', x: w.x, y: w.y }))
  .sort((a, b) => a.x - b.x || a.y - b.y));
const byName = (list, n) => list.filter(l => l.name.startsWith(n));

/* ══════ 1. 造 6 个序号变量（bAlarm1..6），先只建到 4 ══════ */
await page.evaluate(() => {
  const pr = window.app.project;
  ['bAlarm1', 'bAlarm2', 'bAlarm3', 'bAlarm4'].forEach(n =>
    pr.variables().push({ name: n, type: 'bool', address: '', value: false }));
  pr.commit('t');
});
const src = await makeLamp('指示灯1', 'bAlarm1');
await page.waitForTimeout(200);

/* ══════ 2. Ctrl+D：快速再复制一份（右下堆叠 +16，名称/变量一起递增）══════ */
await page.keyboard.press('Control+d');
await page.waitForTimeout(300);
const afterD = await lamps();
const copy1 = afterD.find(l => l.name === '指示灯2');
ok('Ctrl+D 复制出一份', !!copy1, JSON.stringify(afterD.filter(l => l.name.startsWith('指示灯'))));
ok('副本名称末尾数字 +1（指示灯1 → 指示灯2）', copy1?.name === '指示灯2');
ok('副本变量名末尾数字 +1（bAlarm1 → bAlarm2）', copy1?.v === 'bAlarm2', copy1?.v);
ok('副本右下偏移 16px', copy1 && copy1.x === 76 && copy1.y === 76, `${copy1?.x},${copy1?.y}`);
ok('复制后选中的是副本（可继续操作）', await page.evaluate(() => {
  const sel = document.querySelector('#canvas .wd.selected');
  const w = window.app.project.getWidget(sel?.dataset.id);
  return w?.name === '指示灯2';
}));
ok('一次复制 = 一步撤销（Ctrl+Z 能整体退回）', await page.evaluate(() => {
  window.app.history.undo();
  return !window.app.project.currentWidgets().some(w => w.name === '指示灯2');
}));
await page.evaluate(() => window.app.history.redo());
await page.waitForTimeout(150);

/* ══════ 3. 多重复制对话框：向右排列 3 份，间距 20 ══════ */
await page.evaluate(() => {
  // 选中「指示灯1」作为源
  const w = window.app.project.currentWidgets().find(x => x.name === '指示灯1');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await page.waitForTimeout(200);
await page.keyboard.press('Control+Shift+d');
await page.waitForTimeout(300);
ok('Ctrl+Shift+D 打开多重复制对话框',
  await page.evaluate(() => !document.getElementById('dlgMask').classList.contains('hidden'))
  && /多重复制/.test(await page.evaluate(() => document.getElementById('dlgTitle').textContent)),
  await page.evaluate(() => document.getElementById('dlgTitle').textContent));
ok('对话框有份数/排列/间距/递增开关 + 序号步长/地址间隔/自动建变量',
  await page.evaluate(() => ['dupCount', 'dupMode', 'dupGapX', 'dupGapY', 'dupNameSeq', 'dupVarSeq',
    'dupSeqStep', 'dupVarMode', 'dupAddrStep', 'dupAutoVar'].every(id => !!document.getElementById(id))));
ok('序号步长可以填负数（-1 = 倒着排）',
  await page.evaluate(() => {
    const el = document.getElementById('dupSeqStep');
    return el.type === 'number' && +el.min <= -1;
  }));
ok('默认（勾了自动建变量）地址间隔是可填的，填得进负数',
  await page.evaluate(() => {
    const el = document.getElementById('dupAddrStep');
    if (el.disabled) return false;
    el.value = '-2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === '-2' && +el.min <= -2;
  }));
// 还原成默认值，别影响下面的坐标断言
await page.fill('#dupAddrStep', '0');
await page.fill('#dupCount', '5');
await page.selectOption('#dupMode', 'right');
await page.fill('#dupGapX', '20');
await page.click('#dlgOk');
await page.waitForTimeout(400);
// 源「指示灯1」在 x=60、宽 50 → 步进 = 50+20 = 70；只挑这次新建的那些（x>=130）
const made = (await lamps()).filter(l => l.name.startsWith('指示灯') && l.x >= 130);
ok('向右复制出 5 份', made.length === 5, JSON.stringify(made.map(m => m.name)));
ok('水平步进 = 控件宽 + 间距（50+20=70）',
  JSON.stringify(made.map(m => m.x)) === JSON.stringify([130, 200, 270, 340, 410]), JSON.stringify(made.map(m => m.x)));
ok('Y 不变（水平排列）', made.every(m => m.y === 60), JSON.stringify(made.map(m => m.y)));
ok('名称逐个递增', JSON.stringify(made.map(m => m.name)) === JSON.stringify(['指示灯2', '指示灯3', '指示灯4', '指示灯5', '指示灯6']),
  JSON.stringify(made.map(m => m.name)));
ok('变量名逐份递增（bAlarm2…bAlarm6）',
  JSON.stringify(made.map(m => m.v)) === JSON.stringify(['bAlarm2', 'bAlarm3', 'bAlarm4', 'bAlarm5', 'bAlarm6']),
  JSON.stringify(made.map(m => m.v)));
ok('默认「自动建变量」：复制时把 bAlarm5/bAlarm6 直接建进变量表（不用自己去补）',
  /自动创建了 2 个变量/.test(lastDialog) && /bAlarm5/.test(lastDialog) && /bAlarm6/.test(lastDialog),
  lastDialog.replace(/\n/g, ' ').slice(0, 90));
const autoMade = await page.evaluate(() => window.app.project.variables().map(v => v.name));
ok('变量表里确实多了这两个（bAlarm1…6 齐了）',
  ['bAlarm1', 'bAlarm2', 'bAlarm3', 'bAlarm4', 'bAlarm5', 'bAlarm6'].every(n => autoMade.includes(n)),
  JSON.stringify(autoMade.filter(n => n.startsWith('bAlarm'))));

/* ══════ 4. 名字没数字：默认也自动加序号（rDup → rDup1/2/3，地址按类型往后排）══════ */
await page.evaluate(() => {
  const pr = window.app.project;
  pr.variables().push({ name: 'rDup', type: 'real', address: '%MW100', value: 12.5 });
  const w = pr.addWidget('label', 60, 400);
  w.name = '转速'; w.bindings.variable = 'rDup';
  pr.commit('t');
});
await page.waitForTimeout(200);
const addrRes = await page.evaluate(() => {
  const pr = window.app.project;
  const srcW = pr.currentWidgets().find(w => w.name === '转速');
  const res = pr.duplicateWidgets([srcW.id], { count: 3, mode: 'down', gapY: 10, nameSeq: true, varSeq: true });
  const copies = res.ids.map(id => pr.getWidget(id) || pr.findWidget(id));
  return {
    created: res.createdVars,
    noAddr: res.noAddrVars,
    missing: res.missingVars,
    bind: copies.map(w => w.bindings.variable),
    names: copies.map(w => w.name),
    vars: pr.variables().filter(v => v.name.startsWith('rDup')).map(v => ({ n: v.name, t: v.type, a: v.address, val: v.value })),
  };
});
ok('名字没数字也递增（rDup → rDup1/rDup2/rDup3）',
  JSON.stringify(addrRes.bind) === JSON.stringify(['rDup1', 'rDup2', 'rDup3']), JSON.stringify(addrRes.bind));
ok('副本各自绑到新变量（不是三个都指 rDup）', new Set(addrRes.bind).size === 3);
ok('新变量直接建进变量表（类型/初值照抄源变量）',
  addrRes.created.length === 3 && addrRes.vars.length === 4
  && addrRes.vars.every(v => v.t === 'real' && v.val === 12.5),
  JSON.stringify(addrRes.vars.map(v => `${v.n}@${v.a}/${v.t}/${v.val}`)));
ok('地址按类型自动往后排：real 占 2 个字 → %MW102 / %MW104 / %MW106',
  JSON.stringify(addrRes.created.map(c => c.address)) === JSON.stringify(['%MW102', '%MW104', '%MW106']),
  JSON.stringify(addrRes.created.map(c => `${c.name}@${c.address}`)));
ok('没建出悬空绑定（missing 为空）', addrRes.missing.length === 0 && addrRes.noAddr.length === 0, JSON.stringify(addrRes.missing));

/* 手填「地址间隔」：每份 +1 个字（不按类型）、换一个源变量名免得命中上面刚建的 */
const stepRes = await page.evaluate(() => {
  const pr = window.app.project;
  pr.variables().push({ name: 'rStep', type: 'real', address: '%MW200', value: 3.5 });
  const w = pr.addWidget('label', 300, 500);
  w.name = '步进'; w.bindings.variable = 'rStep';
  pr.commit('t');
  const res = pr.duplicateWidgets([w.id], { count: 2, mode: 'down', nameSeq: false, varSeq: true, addrStep: 1 });
  return { created: res.createdVars };
});
ok('地址间隔填 1 → 每份只挪 1 个字（%MW201 / %MW202）',
  JSON.stringify(stepRes.created.map(c => c.address)) === JSON.stringify(['%MW201', '%MW202']),
  JSON.stringify(stepRes.created.map(c => `${c.name}@${c.address}`)));

/* 序号步长填负数 + 地址间隔填负数：倒着排 */
const minusRes = await page.evaluate(() => {
  const pr = window.app.project;
  pr.variables().push({ name: 'bDown5', type: 'real', address: '%MW300', value: 1 });
  const w = pr.addWidget('label', 500, 500);
  w.name = '倒排5'; w.bindings.variable = 'bDown5';
  pr.commit('t');
  const res = pr.duplicateWidgets([w.id], {
    count: 2, mode: 'down', nameSeq: true, varSeq: true, seqStep: -1, addrStep: -2 });
  const copies = res.ids.map(id => pr.getWidget(id) || pr.findWidget(id));
  return { created: res.createdVars, names: copies.map(c => c.name), bind: copies.map(c => c.bindings.variable) };
});
ok('序号步长 -1 → 名称和变量名倒着排（倒排5 → 倒排4、倒排3；bDown5 → bDown4、bDown3）',
  JSON.stringify(minusRes.names) === JSON.stringify(['倒排4', '倒排3'])
  && JSON.stringify(minusRes.bind) === JSON.stringify(['bDown4', 'bDown3']),
  JSON.stringify([minusRes.names, minusRes.bind]));
ok('地址间隔 -2 → 地址往回排（%MW298 / %MW296）',
  JSON.stringify(minusRes.created.map(c => c.address)) === JSON.stringify(['%MW298', '%MW296']),
  JSON.stringify(minusRes.created.map(c => `${c.name}@${c.address}`)));

/* 关掉「自动建变量」→ 只提醒，不写变量表 */
const noAuto = await page.evaluate(() => {
  const pr = window.app.project;
  pr.variables().push({ name: 'rNoAuto', type: 'real', address: '%MW400', value: 0 });
  const w = pr.addWidget('label', 700, 500);
  w.name = '不自动'; w.bindings.variable = 'rNoAuto';
  pr.commit('t');
  const before = pr.variables().length;
  const res = pr.duplicateWidgets([w.id], { count: 1, mode: 'down', nameSeq: false, varSeq: true, autoVar: false });
  return { before, after: pr.variables().length, missing: res.missingVars, created: res.createdVars.length };
});
ok('关掉「自动建变量」→ 不写变量表，只回报缺哪些变量',
  noAuto.after === noAuto.before && noAuto.created === 0 && noAuto.missing.join() === 'rNoAuto1', JSON.stringify(noAuto));

/* bool 的位地址按「位」往后排；认不出的写法才留空让人手填 */
const oddAddr = await page.evaluate(() => {
  const pr = window.app.project;
  pr.variables().push({ name: 'bBit', type: 'bool', address: '%MX0.0', value: false });
  const w = pr.addWidget('lamp', 300, 400);
  w.name = '位变量'; w.bindings.variable = 'bBit';
  const w2 = pr.addWidget('label', 400, 400);
  w2.name = '怪写法'; w2.bindings.variable = 'rDb';
  pr.variables().push({ name: 'rDb', type: 'real', address: 'DB1.DBD4', value: 1 });
  pr.commit('t');
  const bits = pr.duplicateWidgets([w.id], { count: 3, mode: 'down', varSeq: true, nameSeq: false });
  const odd = pr.duplicateWidgets([w2.id], { count: 1, mode: 'down', varSeq: true, nameSeq: false });
  return { bits: bits.createdVars, odd: odd.createdVars, oddNoAddr: odd.noAddrVars };
});
ok('bool 位地址按「位」往后排：%MX0.0 → %MX0.1 / %MX0.2 / %MX0.3',
  JSON.stringify(oddAddr.bits.map(c => c.address)) === JSON.stringify(['%MX0.1', '%MX0.2', '%MX0.3']),
  JSON.stringify(oddAddr.bits.map(c => `${c.name}@${c.address}`)));
ok('认不出的写法（DB1.DBD4）→ 变量照样建，但地址留空并回报手填',
  oddAddr.odd.length === 1 && oddAddr.odd[0].address === '' && oddAddr.oddNoAddr.length === 1,
  JSON.stringify(oddAddr));

/* ══════ 5. 无序号变量名保持不变（选「保持同一个变量」时的老行为）══════ */
await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('button', 600, 500);
  w.name = '启停'; w.bindings.variable = 'bRunCmd';
  pr.commit('t');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await page.waitForTimeout(200);
await page.evaluate(() => window.app.project.duplicateWidgets(
  [window.app.project.currentWidgets().find(w => w.name === '启停').id],
  { count: 2, mode: 'right', gapX: 10, nameSeq: true, varSeq: true, varMode: 'digit' }));
await page.waitForTimeout(300);
const btns = await page.evaluate(() => window.app.project.currentWidgets()
  .filter(w => w.type === 'button' && w.name.startsWith('启停'))
  .map(w => ({ name: w.name, v: w.bindings.variable })));
ok('选「保持同一个变量」：名字带序号 → 名称递增；变量名无序号 → 三个都指 bRunCmd',
  btns.length === 3 && btns.every(b => b.v === 'bRunCmd') && btns.map(b => b.name).join() === '启停,启停1,启停2',
  JSON.stringify(btns));

/* ══════ 5. 垂直 / 网格排列 ══════ */
const grid = await page.evaluate(() => {
  const pr = window.app.project;
  pr.currentWidgets().filter(w => w.name.startsWith('启停') || w.name.startsWith('指示灯')).forEach(w => { w.z = 5; });
  const src = pr.addWidget('rect', 700, 60);
  src.name = '格子1'; src.w = 40; src.h = 30;
  pr.commit('t');
  const res = pr.duplicateWidgets([src.id], { count: 5, mode: 'grid', cols: 3, gapX: 10, gapY: 5, nameSeq: true });
  return res.ids.map(id => pr.getWidget(id) || pr.findWidget(id)).map(w => ({ x: w.x, y: w.y }));
});
// 源「格子1」在 (700,60)、40x30、间距 10/5 → 步进 50/35；源自己占第 0 格，副本从 i=1 开始排
ok('垂直方向：网格 3 列 → 第 4 份换行',
  JSON.stringify(grid) === JSON.stringify([
    { x: 750, y: 60 }, { x: 800, y: 60 },        // i=1,2 → 第 1 行第 2、3 列
    { x: 700, y: 95 }, { x: 750, y: 95 }, { x: 800, y: 95 },   // i=3,4,5 → 第 2 行
  ]), JSON.stringify(grid));
const down = await page.evaluate(() => {
  const pr = window.app.project;
  const src = pr.addWidget('rect', 60, 300);
  src.name = '竖排1'; src.w = 40; src.h = 30;
  pr.commit('t');
  const res = pr.duplicateWidgets([src.id], { count: 2, mode: 'down', gapY: 10 });
  return res.ids.map(id => pr.findWidget(id)).map(w => ({ x: w.x, y: w.y }));
});
ok('向下排列：y 步进 = 高 + 间距', down[0].y === 340 && down[1].y === 380 && down.every(d => d.x === 60), JSON.stringify(down));

/* ══════ 6. 多选整块复制：相对布局不变 ══════ */
const block = await page.evaluate(() => {
  const pr = window.app.project;
  const a = pr.addWidget('lamp', 40, 520); a.name = '块A';
  const b = pr.addWidget('label', 100, 540); b.name = '块B';
  pr.commit('t');
  const before = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  const res = pr.duplicateWidgets([a.id, b.id], { count: 1, mode: 'right', gapX: 20, nameSeq: true, varSeq: false });
  const copies = res.ids.map(id => pr.findWidget(id));
  return {
    dx: copies.map(c => c.x), dy: copies.map(c => c.y),
    relW: (copies[1].x - copies[0].x) === (b.x - a.x) && (copies[1].y - copies[0].y) === (b.y - a.y),
    before,
  };
});
ok('多选整块复制：保持相对位置',
  block.relW && block.dx[0] === 240 && block.dx[1] === 300 && block.dy[0] === 520 && block.dy[1] === 540,
  JSON.stringify(block));   // 块宽 180 + 间距 20 = 步进 200 → 40+200=240、100+200=300

/* ══════ 7. 波形控件多通道复制：通道名/颜色/量程一起递增 ══════ */
const trend = await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('trend', 60, 700);
  w.w = 200; w.h = 80;
  w.name = '波形1';
  w.bindings.variables = ['bAlarm1', 'bAlarm2'];
  w.props.colors = { bAlarm1: '#111111' };
  w.props.scales = { bAlarm2: { k: 2, b: 1 } };
  pr.commit('t');
  const res = pr.duplicateWidgets([w.id], { count: 1, mode: 'cascade', nameSeq: true, varSeq: true });
  const c = pr.findWidget(res.ids[0]);
  return { name: c.name, vars: c.bindings.variables, colors: c.props.colors, scales: c.props.scales };
});
ok('波形副本：多通道名一起递增',
  JSON.stringify(trend.vars) === JSON.stringify(['bAlarm2', 'bAlarm3']), JSON.stringify(trend.vars));
ok('波形副本：颜色键跟着改名',
  JSON.stringify(trend.colors) === JSON.stringify({ bAlarm2: '#111111' }), JSON.stringify(trend.colors));
ok('波形副本：量程键跟着改名',
  JSON.stringify(trend.scales) === JSON.stringify({ bAlarm3: { k: 2, b: 1 } }), JSON.stringify(trend.scales));

/* ══════ 8. 右键菜单入口 ══════ */
const w1 = await page.evaluate(() => {
  const w = window.app.project.currentWidgets().find(x => x.name === '指示灯1');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(w1.x, w1.y, { button: 'right' });
await page.waitForTimeout(250);
const menu = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-label')].map(e => e.textContent));
ok('控件右键菜单里有「再复制一份 / 多重复制…」',
  menu.includes('再复制一份') && menu.includes('多重复制…'), JSON.stringify(menu));
await page.keyboard.press('Escape');

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 多重复制回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
