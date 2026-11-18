// verify-varpicker.mjs — 变量选择：属性面板（数据绑定 / 波形 8 路通道 / 动作变量）+ 变量监控抽屉
//   做法（js/editor/varPick.js）：**输入框本身就是搜索框**，点进去/一打字就出候选表，
//   按 名称 / 地址 / 类型 三样过滤（中文名照样输得进、搜得到），↑↓ 选、回车或点一下确认。
//   为什么不用原生 <datalist>：候选弹层是浏览器自己的原生素件，过滤规则由它定（按地址/类型
//   搜不一定生效），自动化里也拍不到 —— 那些能力只能自己实现，也才测得了。
//
// 用法：node test/verify-varpicker.mjs   （自己拉起一个独立数据目录的后端，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-varpick-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());   // 纯本地，不碰后端
await page.goto(H + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(300);

/** 造一堆变量：模拟"变量很多"，并且变量表里**中英文都有**（中文名排在后面 —— 老下拉选不到） */
await page.evaluate(() => {
  const pr = window.app.project;
  for (let i = 1; i <= 30; i++) {
    pr.variables().push({ name: `bMotor${i}`, type: 'bool', address: `HR${200 + i}`, value: false });
  }
  pr.variables().push({ name: 'rTemp', type: 'real', address: 'HR500', value: 25.5 });
  pr.variables().push({ name: 'iBatch', type: 'int', address: 'DB1.DBW0', value: 7 });
  pr.variables().push({ name: 'sMsg', type: 'string', address: 'DB2.DBB0', value: '' });
  pr.variables().push({ name: '速度1', type: 'real', address: 'HR600', value: 0 });
  pr.commit('t');
});
let total = await page.evaluate(() => window.app.project.variables().length);

/* ──  helpers  ── */
/** 候选表（varPick 画的浮层）里当前的行；没打开返回 null */
const vpRows = () => page.evaluate(() => {
  const el = document.querySelector('.vp-list');
  if (!el || el.hidden) return null;
  return [...el.querySelectorAll('.vp-row')].map(r => ({
    name: r.querySelector('.vp-name')?.textContent ?? '',
    meta: r.querySelector('.vp-meta')?.textContent ?? '',
    note: r.querySelector('.vp-note')?.textContent ?? '',
    cur: r.classList.contains('cur'),
  }));
});
/** 点进变量框里，打关键字（= 边输入边检索） */
const typeQ = async (sel, q) => {
  await page.click(sel);
  await page.fill(sel, '');
  if (q) await page.type(sel, q, { delay: 12 });
  await page.waitForTimeout(160);
};
const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(120); };
const stNote = () => page.evaluate(() => document.getElementById('stNote')?.textContent || '');
const bindOf = id => page.evaluate(i => window.app.project.getWidget(i)?.bindings?.variable ?? null, id);
const selectWidget = id => page.evaluate(i => {
  const el = document.querySelector(`#canvas .wd[data-id="${i}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, id);

/* ══════ 1. 单变量绑定：输入框即搜索框 ══════ */
const lampId = await page.evaluate(() => {
  const w = window.app.project.addWidget('label', 620, 500);
  window.app.project.commit('t');
  return w.id;
});
await page.waitForTimeout(200);
await selectWidget(lampId);
await page.waitForTimeout(250);

const bindInfo = await page.evaluate(() => {
  const el = document.querySelector('#propBody [data-bind="variable"]');
  return {
    tag: el?.tagName, hasList: !!el?.list, listAttr: el?.getAttribute('list'),
    vpick: el?.dataset.vpick, searchRow: !!document.querySelector('#propBody [data-vsearch]'),
  };
});
ok('绑定变量是输入框（不再是下拉），面板里也没有单独的「搜索」行了',
  bindInfo.tag === 'INPUT' && bindInfo.vpick === 'bind' && bindInfo.searchRow === false
    && !bindInfo.listAttr, JSON.stringify(bindInfo));

await typeQ('#propBody [data-bind="variable"]', '');
const allRows = await vpRows();
ok('点进框里就出**全量**候选（变量表有多少就列多少）', allRows && allRows.length === total,
  `${allRows?.length}/${total}`);
ok('候选里**中文变量也在**（老下拉只放前几十个，中文名排在后面根本选不到）',
  !!allRows?.some(r => r.name === '速度1'), JSON.stringify((allRows || []).slice(-3).map(r => r.name)));
ok('候选行右边带类型 + 地址（重名长得像的变量一眼分得清）',
  allRows?.find(r => r.name === 'bMotor7')?.meta === 'bool · HR207',
  allRows?.find(r => r.name === 'bMotor7')?.meta);

const namesAfter = async (q) => {
  await typeQ('#propBody [data-bind="variable"]', q);
  const rows = await vpRows();
  return rows ? rows.map(r => r.name) : null;
};
ok('边输入边检索：按名称（motor7 → bMotor7）', JSON.stringify(await namesAfter('motor7')) === JSON.stringify(['bMotor7']),
  JSON.stringify(await namesAfter('motor7')));
ok('中文名搜得到（速度 → 速度1）', JSON.stringify(await namesAfter('速度')) === JSON.stringify(['速度1']),
  JSON.stringify(await namesAfter('速度')));
// 只按**变量名**匹配：地址/类型只是给人看的备注，不参与检索（打 HR500 不该冒出一串变量）
ok('地址不参与检索（打 HR500 → 一个都不匹配）', JSON.stringify(await namesAfter('HR500')) === JSON.stringify([]),
  JSON.stringify(await namesAfter('HR500')));
ok('类型也不参与检索（打 real → 只有当变量名里真含 real 才匹配）',
  JSON.stringify(await namesAfter('real')) === JSON.stringify([]), JSON.stringify(await namesAfter('real')));

// 回车 = 选第一个匹配并写进绑定
await typeQ('#propBody [data-bind="variable"]', 'motor12');
await page.keyboard.press('Enter');
await page.waitForTimeout(350);
ok('回车 = 选中第一个匹配并写入绑定', (await bindOf(lampId)) === 'bMotor12', await bindOf(lampId));

// 鼠标点候选行也能选
await typeQ('#propBody [data-bind="variable"]', 'iBatch');
await page.click('.vp-list .vp-row');
await page.waitForTimeout(350);
ok('鼠标点候选行同样能选（不会因为输入框失焦就点不着）',
  (await bindOf(lampId)) === 'iBatch', await bindOf(lampId));
ok('选完候选表自己收起来', (await vpRows()) === null);

// 框里已经有名字时，**点进去就按这个名字先检索**（现场要求：点回来通常是找同名/近名的那个，
// 一进去甩 300 个变量、还得先删一个字符才检索，太绕）；想浏览全部就把框清空。
await page.click('#propBody [data-bind="variable"]');
await page.waitForTimeout(180);
const clickAll = await vpRows();
const boundNow = await bindOf(lampId);
ok('框里已有变量名时，点进去 = 先按这个名字检索（不是甩全量、也不是只列它自己）',
  !!clickAll && clickAll.length > 0 && clickAll.length < total
  && clickAll.some(r => r.name === boundNow)
  && clickAll.every(r => r.name.toLowerCase().includes(String(boundNow).toLowerCase())),
  `${clickAll?.length}/${total} 当前绑定=${boundNow} 前几行=${JSON.stringify((clickAll || []).slice(0, 3).map(r => r.name))}`);
await esc();

// 清空框 → 才回到"浏览全部"
await page.fill('#propBody [data-bind="variable"]', '');
await page.click('#propBody [data-bind="variable"]');
await page.waitForTimeout(180);
const clickEmpty = await vpRows();
ok('框里清空后点进去 = 全部候选（想浏览变量表就走这条）',
  clickEmpty?.length === total, `${clickEmpty?.length}/${total}`);
await esc();

// Esc 关掉
await typeQ('#propBody [data-bind="variable"]', 'motor');
ok('打字时候选表是开着的', (await vpRows())?.length > 0);
await esc();
ok('Esc 关掉候选表（不误关面板/对话框）', (await vpRows()) === null);

// 名字不在变量表里 → 当场标红（不然运行起来静默失效）
await page.fill('#propBody [data-bind="variable"]', 'noSuchVar');
await page.waitForTimeout(400);
const badInfo = await page.evaluate(() => {
  const el = document.querySelector('#propBody [data-bind="variable"]');
  return { bad: el.classList.contains('bad'), title: el.title };
});
ok('变量表里没有的名字 → 输入框标红 + 悬停说明为什么', badInfo.bad && /变量表里没有/.test(badInfo.title),
  JSON.stringify(badInfo));

// ✕ 清空
const clearHidden = await page.evaluate(async () => {
  const btn = document.querySelector('#propBody [data-bind="variable"] + .vf-clear');
  const shown = !btn.hidden;
  btn.click();
  await new Promise(r => setTimeout(r, 350));
  const el = document.querySelector('#propBody [data-bind="variable"]');
  return { shown, cleared: el.value, btnHidden: document.querySelector('#propBody [data-bind="variable"] + .vf-clear').hidden };
});
ok('✕ 清空：绑定变量清空、✕ 自己收起来',
  clearHidden.shown === true && clearHidden.cleared === '' && (await bindOf(lampId)) === '' && clearHidden.btnHidden === true,
  JSON.stringify({ ...clearHidden, bind: await bindOf(lampId) }));

/* ══════ 1b. OPC UA 那种长 NodeId 地址：候选行里**变量名要在**，不能被地址挤没 ══════ */
const uaRows = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.variables().push({
    name: 'GVL.中1[1]', type: 'int', value: 0, len: 0,
    address: 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.中1[1]',
  });
  m.commit('t');
  await new Promise(r => setTimeout(r, 200));
  const inp = document.querySelector('#propBody [data-bind="variable"]');
  inp.focus();
  inp.value = 'GVL.中';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const el = document.querySelector('.vp-list');
  const row = el?.querySelector('.vp-row');
  const nameEl = row?.querySelector('.vp-name');
  const out = {
    rowText: row?.textContent.trim() || '',
    name: nameEl?.textContent || '',
    nameLeft: nameEl ? Math.round(nameEl.getBoundingClientRect().left - el.getBoundingClientRect().left) : -1,
    nameW: nameEl ? Math.round(nameEl.getBoundingClientRect().width) : 0,
    overflowX: el ? el.scrollWidth - el.clientWidth : -1,
    tip: row?.title || '',
  };
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return out;
});
ok('OPC UA 长 NodeId 地址：候选行左起就是**变量名**，且没被地址挤出去',
  uaRows.name === 'GVL.中1[1]' && uaRows.nameLeft <= 14 && uaRows.nameW > 30,
  JSON.stringify(uaRows));
ok('长地址不塞进候选行（只在悬停提示里给全），列表也不出现横向滚动',
  !uaRows.rowText.includes('ns=4;') && uaRows.overflowX <= 1 && /ns=4;/.test(uaRows.tip),
  JSON.stringify(uaRows));
ok('打 `GVL.中` 能按变量名检出 OPC UA 变量', uaRows.name === 'GVL.中1[1]', uaRows.name);
total += 1;      // 上面往变量表里加了一个 OPC UA 变量，后面按"全量"断言的用例要跟着走

/* ══════ 1c. 在候选表里滚动/翻页不能把表关掉（现场反馈"没法正常下拉选择"） ══════ */
await typeQ('#propBody [data-bind="variable"]', 'bMotor1');
const beforeWheel = (await vpRows())?.map(r => r.name) ?? [];
ok('打 bMotor1 有多个候选（够滚一屏）', beforeWheel.length > 3, JSON.stringify(beforeWheel.slice(0, 4)));
const listBox = await page.evaluate(() => {
  const r = document.querySelector('.vp-list').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 2) };
});
await page.mouse.move(listBox.x, listBox.y);
await page.mouse.wheel(0, 160);              // 在候选表里滚轮翻页
await page.waitForTimeout(220);
ok('在候选表里滚轮翻页 → 表不会被自己关掉（以前一滚就没了）',
  (await vpRows()) !== null, JSON.stringify(vpRows === null));
await page.click('.vp-list .vp-row');        // 滚完点一行
await page.waitForTimeout(350);
const pickedByClick = await bindOf(lampId);
ok('滚过之后点一行照样能选中', beforeWheel.includes(pickedByClick), `选中=${pickedByClick}`);

// 方向键翻页（会 scrollIntoView，同样不能把表关掉）+ 回车确认
await typeQ('#propBody [data-bind="variable"]', 'bMotor1');
const kbdRows = (await vpRows())?.map(r => r.name) ?? [];
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(150);
ok('按 ↓↓ 翻候选时表还开着', (await vpRows()) !== null, JSON.stringify(kbdRows.slice(0, 3)));
await page.keyboard.press('Enter');
await page.waitForTimeout(350);
const afterKbd = await bindOf(lampId);
ok('方向键选中的那一个被写进绑定（↓↓ = 第 2 行）',
  afterKbd === kbdRows[1], `期望 ${kbdRows[1]}，实际 ${afterKbd}`);

/* ══════ 2. 波形控件：8 路通道 + 同一套候选 ══════ */
const trendId = await page.evaluate(() => {
  const w = window.app.project.addWidget('trend', 60, 380);
  w.w = 300; w.h = 160;
  window.app.project.commit('t');
  return w.id;
});
await page.waitForTimeout(250);
await selectWidget(trendId);
await page.waitForTimeout(250);
const chanInfo = await page.evaluate(() => {
  const els = [...document.querySelectorAll('#propBody [data-chanslot]')];
  return { n: els.length, tag: els[0]?.tagName, vpick: els[0]?.dataset.vpick, ph: els[0]?.placeholder };
});
ok('波形 8 路通道也是输入框（同一套候选）',
  chanInfo.n === 8 && chanInfo.tag === 'INPUT' && chanInfo.vpick === 'chan', JSON.stringify(chanInfo));
ok('未使用的通道是空的，占位文字说明「未使用」', /未使用/.test(chanInfo.ph || ''), chanInfo.ph);

await typeQ('#propBody [data-chanslot="2"]', 'bMotor5');
ok('通道里打字即检索（bMotor5 → 只剩它）', JSON.stringify((await vpRows())?.map(r => r.name)) === JSON.stringify(['bMotor5']),
  JSON.stringify((await vpRows())?.map(r => r.name)));
await page.keyboard.press('Enter');
await page.waitForTimeout(350);
const vars1 = await page.evaluate(id => window.app.project.getWidget(id).bindings.variables, trendId);
ok('回车选中 → 写进对应槽位（这一路启用）',
  JSON.stringify(vars1) === JSON.stringify(['', '', 'bMotor5', '', '', '', '', '']), JSON.stringify(vars1));
ok('该路颜色输入变为可用', await page.evaluate(() =>
  document.querySelector('#propBody [data-chanslot="2"]').closest('.chan-row').querySelector('[data-chancolor]').disabled === false));

await typeQ('#propBody [data-chanslot="0"]', '');
const dupRow = (await vpRows())?.find(r => r.name === 'bMotor5');
ok('候选行里注明「已在通道3」（选中前就知道会撞）', dupRow?.note === '已在通道3', JSON.stringify(dupRow));
await esc();

// 同一变量占两路：拒绝写入 + 状态栏说清（画面上两条一样的线只会更迷惑）
// ⚠ 打完字要按回车（或失焦）才真的提交 —— Playwright 的 fill 只发 input，不发 change，
//   真实用户那条路径是「打完字敲回车 / 点到别处」。
await page.fill('#propBody [data-chanslot="0"]', 'bMotor5');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const dupTry = await page.evaluate(id => ({
  arr: window.app.project.getWidget(id).bindings.variables,
  val: document.querySelector('#propBody [data-chanslot="0"]').value,
  note: document.getElementById('stNote')?.textContent || '',
}), trendId);
ok('同一变量想占第二路 → 不写入、输入框退回原值，状态栏说明缘由',
  JSON.stringify(dupTry.arr) === JSON.stringify(['', '', 'bMotor5', '', '', '', '', ''])
    && dupTry.val === '' && /已经在通道3/.test(dupTry.note), JSON.stringify(dupTry));

await page.fill('#propBody [data-chanslot="0"]', 'bMotor99');
await page.waitForTimeout(300);
ok('通道里写了不存在的变量 → 标红',
  await page.evaluate(() => document.querySelector('#propBody [data-chanslot="0"]').classList.contains('bad')));

const chanCleared = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // ✕ 是输入框的**兄弟**节点（都在 .vf 里），所以用 "+ .vf-clear"
  document.querySelector('#propBody [data-chanslot="0"] + .vf-clear').click();
  await wait(350);
  document.querySelector('#propBody [data-chanslot="2"] + .vf-clear').click();
  await wait(350);
  return [...document.querySelectorAll('#propBody [data-chanslot]')].map(i => i.value);
});
const vars2 = await page.evaluate(id => window.app.project.getWidget(id).bindings.variables, trendId);
ok('✕ 清空通道 = 停用这一路',
  chanCleared.every(v => v === '') && JSON.stringify(vars2) === JSON.stringify(['', '', '', '', '', '', '', '']),
  JSON.stringify({ chanCleared, vars2 }));

/* ══════ 3. 动作编辑器里的变量格：同一套候选 ══════ */
const btnId = await page.evaluate(() => {
  const w = window.app.project.addWidget('button', 400, 500);
  window.app.project.updateWidgetActions(w.id, [{ trigger: 'click', type: 'setValue', params: {} }]);
  window.app.project.commit('t');
  return w.id;
});
await page.waitForTimeout(250);
await selectWidget(btnId);
await page.waitForTimeout(250);
ok('动作变量格是输入框', await page.evaluate(() =>
  document.querySelector('#propBody [data-ap="variable"]')?.tagName === 'INPUT'));
await typeQ('#propBody [data-ap="variable"]', 'iBatch');
ok('动作变量格同样边打字边检索（iBatch → 只剩它）',
  JSON.stringify((await vpRows())?.map(r => r.name)) === JSON.stringify(['iBatch']),
  JSON.stringify((await vpRows())?.map(r => r.name)));
await page.keyboard.press('Enter');
await page.waitForTimeout(350);
ok('回车把选中的变量写进动作参数',
  await page.evaluate(id => window.app.project.getWidget(id).actions[0].params.variable, btnId) === 'iBatch',
  await page.evaluate(id => window.app.project.getWidget(id).actions[0].params.variable, btnId));
await page.fill('#propBody [data-ap="variable"]', 'ghost');
await page.waitForTimeout(300);
ok('动作变量写了不存在的名字 → 标红 + 说明',
  await page.evaluate(() => {
    const el = document.querySelector('#propBody [data-ap="variable"]');
    return el.classList.contains('bad') && /变量表里没有/.test(el.title);
  }));

/* ══════ 4. 变量监控抽屉：筛选（运行态） ══════ */
// 「后台一直在采」的变量先造好（波形通道 + 报警条件）——运行态不会因为改了工程就重算采集范围，
// 所以必须在 enterRun 之前摆好：
//   bMotor5 = 只在波形通道里（后台，跟本页无关）
//   bMotor7 = 既是波形通道、又绑在本页一个 label 上（本页也在用 → 「不看后台」不该把它藏掉）
//   rTemp   = 报警条件（后台一直在采）
await page.evaluate(tid => {
  const pr = window.app.project;
  const tw = pr.getWidget(tid);
  tw.bindings.variables = ['bMotor5', 'bMotor7', '', '', '', '', '', ''];
  const lab = pr.addWidget('label', 620, 620);
  lab.bindings.variable = 'bMotor7';
  pr.alarms().push({ id: 'alX', enabled: true, name: '温度高', variable: 'rTemp', op: '>=', value: '60',
                     delaySec: 0, level: 'warn', text: '温度高' });
  pr.commit('t');
}, trendId);
await page.waitForTimeout(250);
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(600);
// 进运行态变量监控整个收起（画面要吃满整窗，见 verify-runtime-chrome）——
// 这里要测抽屉本身，先按 Ctrl+Shift+V 叫出来
await page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  rt.setVarsVisible(true);
});
await page.waitForTimeout(400);
// 「只看本页」默认勾着：变量上千个时全列出来会卡，所以默认只列本页在采的
const onlyDefault = await page.evaluate(() => ({
  checked: document.getElementById('rtvOnly').checked,
  rows: [...document.querySelectorAll('.rtv-row')].filter(r => r.style.display !== 'none').length,
}));
ok('「只看本页」默认勾着，监控只列本页在采的变量',
  onlyDefault.checked === true && onlyDefault.rows > 0 && onlyDefault.rows < total,
  JSON.stringify({ ...onlyDefault, total }));
// 取消勾选 → 恢复全量（下面按全量测筛选）
await page.uncheck('#rtvOnly');
await page.waitForTimeout(250);
const rowsAll = await page.evaluate(() => [...document.querySelectorAll('.rtv-row')].filter(r => r.style.display !== 'none').length);
ok('取消「只看本页」后列出全部变量', rowsAll === total, `${rowsAll}/${total}`);
await page.fill('#rtvFilter', 'motor3');
await page.waitForTimeout(250);
const shown = await page.evaluate(() => [...document.querySelectorAll('.rtv-row')]
  .filter(r => r.style.display !== 'none').map(r => r.dataset.vname));
ok('抽屉按名称筛选（motor3 → motor3 / motor30）',
  JSON.stringify(shown.sort()) === JSON.stringify(['bMotor3', 'bMotor30']), JSON.stringify(shown));
await page.fill('#rtvFilter', 'hr207');
await page.waitForTimeout(250);
ok('抽屉也能按地址筛选',
  JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.rtv-row')]
    .filter(r => r.style.display !== 'none').map(r => r.dataset.vname))) === JSON.stringify(['bMotor7']));
await page.focus('#rtvFilter');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
ok('Esc 清空筛选恢复全部',
  await page.evaluate(() => [...document.querySelectorAll('.rtv-row')].filter(r => r.style.display !== 'none').length) === total);

/* ── 4b. 「不看后台」：波形通道/报警条件这类后台一直在采的可以不列出来 ── */
const monNames = () => page.evaluate(() => [...document.querySelectorAll('.rtv-row')]
  .filter(r => r.style.display !== 'none').map(r => r.dataset.vname));
await page.check('#rtvOnly');                    // 回到「只看本页」（模拟现场默认）
await page.waitForTimeout(300);
const bgOff = await monNames();
ok('默认不勾「不看后台」：波形通道/报警条件的变量照旧列在监控里（bMotor5 波形、rTemp 报警）',
  bgOff.includes('bMotor5') && bgOff.includes('rTemp'),
  JSON.stringify({ n: bgOff.length, has5: bgOff.includes('bMotor5'), hasTemp: bgOff.includes('rTemp') }));
const noBgDefault = await page.evaluate(() => document.getElementById('rtvNoBg').checked);
ok('「不看后台」默认不勾（不改现场的老样子）', noBgDefault === false, String(noBgDefault));

await page.check('#rtvNoBg');
await page.waitForTimeout(300);
const bgOn = await monNames();
ok('勾上「不看后台」：只在后台采的（波形通道 bMotor5、报警条件 rTemp）不再列出来',
  !bgOn.includes('bMotor5') && !bgOn.includes('rTemp'), JSON.stringify(bgOn));
ok('本页画面上也在用的照旧列（bMotor7 既是波形通道又绑在本页控件上）',
  bgOn.includes('bMotor7'), JSON.stringify(bgOn.filter(n => /^bMotor|rTemp/.test(n))));
ok('列表上方不再有「已收起后台采集的 N 个…」这类说明行（现场嫌吵，去掉）',
  await page.evaluate(() => !/已收起后台采集/.test(
    [...document.querySelectorAll('.rtv-tip')].map(e => e.textContent).join('\n'))),
  await page.evaluate(() => [...document.querySelectorAll('.rtv-tip')].map(e => e.textContent).join(' | ') || '(没有说明行)'));
ok('「在采 N 个 = 本页 + 报警条件 + 波形通道…」也不再当文字行显示，只在标题的 (N/M) 悬停提示里',
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.rtv-tip')].map(e => e.textContent).join('\n');
    return !/在采 \d+ 个/.test(rows) && /在采 \d+ 个 = /.test(document.getElementById('rtvCount').title);
  }),
  await page.evaluate(() => [...document.querySelectorAll('.rtv-tip')].map(e => e.textContent).join(' | ')
    + ' ‖ title=' + document.getElementById('rtvCount').title.replace(/\n/g, ' ')));
ok('个数那个括号也跟着变（分子变小、分母还是整个变量表）',
  await page.evaluate(() => /\(\d+\/\d+\)/.test(document.getElementById('rtvCount').textContent)),
  await page.evaluate(() => document.getElementById('rtvCount').textContent));
ok('选择记进 localStorage（下次进运行态照旧）',
  await page.evaluate(() => localStorage.getItem('hmi-vars-nobg')) === '1');
await page.uncheck('#rtvNoBg');
await page.waitForTimeout(300);
const bgBack = await monNames();
ok('取消「不看后台」→ 后台那些又都回来了',
  bgBack.includes('bMotor5') && bgBack.includes('rTemp'), JSON.stringify(bgBack));
ok('取消后 localStorage 也记着关掉了（不勾 = 0）',
  await page.evaluate(() => localStorage.getItem('hmi-vars-nobg')) === '0');
// 折叠时筛选框一起收起
await page.click('#rtvHead');
await page.waitForTimeout(200);
ok('面板折叠时筛选框一起隐藏', await page.evaluate(() =>
  getComputedStyle(document.querySelector('.rtv-filter')).display === 'none'));
await page.evaluate(() => window.app.exitRun());

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录，清不掉也无所谓 */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 变量选择回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
