// verify-var-add.mjs — 变量框里"顺手新建变量"（现场：在按钮动作的变量框里直接打一个还没定义的变量名，
//   希望弹窗问一句"要不要新建"，并且能把**地址 / 数据类型**一起设好）
//
//   做法：候选表（varPick）在"框里的名字变量表里没有"时多给一行
//   「＋ 新建变量「xxx」…」；点它（或一个匹配都没有时直接回车）弹「新建变量」对话框
//   （名称 / 数据类型 / PLC 地址 / 字符数 / 掉电保持，见 js/editor/varAdd.js），
//   建完**自动填回那个变量框**（绑定/动作用的就是它），变量表面板里也立刻有这一条。
//
// 用法：node tools/run-suites.mjs verify-var-add
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

/* 造两个变量 + 一个按钮（动作 = 点动，变量框就是现场截图里那个位置） */
const ids = await page.evaluate(() => {
  const pr = window.app.project;
  pr.data.variables.length = 0;
  pr.data.variables.push({ name: 'bRun', type: 'bool', address: '%MX0.0', value: false, len: 0 });
  pr.data.variables.push({ name: 'rSpeed', type: 'real', address: '%MW100', value: 0, len: 0 });
  const w = pr.addWidget('button', 620, 500);
  pr.updateWidgetActions(w.id, [{ trigger: 'click', type: 'tap', params: { variable: '' } }]);
  pr.commit('按钮');
  return { btn: w.id };
});
await sleep(250);
await page.evaluate(i => {
  const el = document.querySelector(`#canvas .wd[data-id="${i}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, ids.btn);
await sleep(300);

/** 动作里的那个变量框（现场截图位置：动作区「变量」那一格，data-vpick="act"） */
const actInputSel = '#actList input[data-ap="variable"]';
/* 现场截图里那个位置是**可编辑**的动作变量框：新建按钮默认勾着「变量与显示的变量一致」，
   这时动作变量跟着"数据绑定"走（只读）—— 先按现场那样把它取消勾选，动作变量框才可填。 */
await page.uncheck('#actFollow');
await sleep(300);
ok('取消「变量与显示的变量一致」后，动作里的变量框可编辑',
  await page.locator(`${actInputSel}:not([readonly])`).count() === 1, actInputSel);

const vpRows = () => page.evaluate(() => {
  const el = document.querySelector('.vp-list');
  if (!el || el.hidden) return null;
  return [...el.querySelectorAll('.vp-row')].map(r => ({
    name: r.querySelector('.vp-name')?.textContent ?? '',
    isNew: r.dataset.new === '1',
    typed: r.dataset.nm || '',
  }));
});
/** 在动作的变量框里打字（边打边出候选） */
const typeAct = async (q) => {
  await page.click(actInputSel);
  await page.fill(actInputSel, '');
  if (q) await page.type(actInputSel, q, { delay: 12 });
  await sleep(250);
  return vpRows();
};
const varsOf = () => page.evaluate(() => window.app.project.variables().map(v => ({ ...v })));
const dlgOpen = () => page.evaluate(() => !!document.querySelector('#dlgMask:not(.hidden) #vaName'));
const closeDlg = async () => { await page.click('#dlgCancel'); await sleep(200); };

/* ══════ A. 「＋ 新建变量」那一行什么时候给 ══════ */
const rowsExisting = await typeAct('rSpeed');
ok('A 名字已经在变量表里 → 只给匹配的候选，**不出现**「＋ 新建变量」',
  !!rowsExisting && rowsExisting.some(r => r.name === 'rSpeed') && !rowsExisting.some(r => r.isNew),
  JSON.stringify(rowsExisting));

const rowsNew = await typeAct('Hb反向点动[7]');
ok('A 名字不在变量表里 → 候选表底下给出「＋ 新建变量「Hb反向点动[7]」…」',
  !!rowsNew && rowsNew.some(r => r.isNew && r.typed === 'Hb反向点动[7]'), JSON.stringify(rowsNew));

/* ══════ B. 点那一行 → 弹「新建变量」对话框 ══════ */
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.vp-list .vp-row')].find(r => r.dataset.new === '1');
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, bubbles: true }));
});
await sleep(300);
ok('B 点「＋ 新建变量」→ 弹出「新建变量」对话框（候选表让位）',
  await dlgOpen() && !(await page.evaluate(() => !document.querySelector('.vp-list')?.hidden)),
  JSON.stringify({ open: await dlgOpen() }));
const dlg = await page.evaluate(() => {
  const t = document.getElementById('vaType');
  return {
    title: document.getElementById('dlgTitle')?.textContent,
    name: document.getElementById('vaName')?.value,
    types: [...(t?.options || [])].map(o => o.value),
    addrPh: document.getElementById('vaAddr')?.placeholder,
    hint: document.querySelector('#dlgMask .dlg-hint')?.textContent || '',
    retain: !!document.getElementById('vaRetain'),
    lenHidden: getComputedStyle(document.getElementById('vaLenWrap')).display === 'none',
  };
});
ok('B 对话框把刚打的名字预填好（不用重打一遍）', dlg.title === '新建变量' && dlg.name === 'Hb反向点动[7]', JSON.stringify(dlg));
ok('B 数据类型是下拉（9 种标量，和变量表那格一致）',
  dlg.types.join(',') === 'bool,int,uint,dint,udint,real,lreal,string,wstring', JSON.stringify(dlg.types));
ok('B 地址有写法提示（Modbus 下给 %MW；留空 = 内部变量）',
  /%MW/.test(dlg.addrPh || ''), dlg.addrPh);
ok('B 提示里写了「百分号可以省」（现场口径：mx100.0 也行）',
  /百分号可以省/.test(dlg.hint), dlg.hint.slice(0, 120));
ok('B 有「掉电保持」勾选；字符数那一格默认收着（非字符串类型用不上）',
  dlg.retain && dlg.lenHidden, JSON.stringify({ retain: dlg.retain, lenHidden: dlg.lenHidden }));

/* ══════ C. 建一个 bool + PLC 地址：地址归一化 + 填回变量框 + 真的进了工程 ══════ */
await page.fill('#vaName', 'Hb反向点动[7]');
await page.selectOption('#vaType', 'bool');
await page.fill('#vaAddr', 'HR7');           // 老写法 → 应归一化成 %MW7
await page.click('#dlgOk');
await sleep(400);
const made = (await varsOf()).find(v => v.name === 'Hb反向点动[7]');
ok('C 建出来了：名称/类型对', !!made && made.type === 'bool', JSON.stringify(made));
ok('C 地址按变量表那套归一化（HR7 → %MW7）', made?.address === '%MW7', String(made?.address));
const afterCreate = await page.evaluate((sel) => ({
  dlgOpen: !!document.querySelector('#dlgMask:not(.hidden) #vaName'),
  actVar: document.querySelector(sel)?.value ?? '',
}), actInputSel);
ok('C 建完对话框关掉、名字**自动填回变量框**', !afterCreate.dlgOpen && /Hb反向点动\[7\]/.test(afterCreate.actVar),
  JSON.stringify(afterCreate));
const bound = await page.evaluate((id) => window.app.project.getWidget(id)?.actions?.[0]?.params?.variable, ids.btn);
ok('C 动作里的变量真的写进工程了（点动就绑在这个新变量上）', bound === 'Hb反向点动[7]', String(bound));

/* ══════ C2. 百分号可以省：mx100.0 → %MX100.0（现场口径，少敲一个 %） ══════ */
await typeAct('bMxTest');
await page.evaluate(() => {
  [...document.querySelectorAll('.vp-list .vp-row')].find(r => r.dataset.new === '1')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
await sleep(300);
await page.fill('#vaName', 'bMxTest');
await page.selectOption('#vaType', 'bool');
await page.fill('#vaAddr', 'mx100.0');
await page.click('#dlgOk');
await sleep(400);
const bareVar = (await varsOf()).find(v => v.name === 'bMxTest');
ok('C2 地址少敲 % 也认（mx100.0 → %MX100.0）', bareVar?.address === '%MX100.0', String(bareVar?.address));

/* ══════ D. 内部变量：地址留空 + 勾「保持」 ══════ */
await typeAct('_本班产量');
await page.evaluate(() => {
  [...document.querySelectorAll('.vp-list .vp-row')].find(r => r.dataset.new === '1')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
await sleep(300);
await page.fill('#vaName', '本班产量');
await page.selectOption('#vaType', 'dint');
const retainEnabled = await page.evaluate(() => !document.getElementById('vaRetain').disabled);
await page.check('#vaRetain');
await page.click('#dlgOk');
await sleep(400);
const internal = (await varsOf()).find(v => v.name === '本班产量');
ok('D 地址留空 = 内部变量，类型 dint、初值 0、勾了掉电保持',
  !!internal && internal.address === '' && internal.type === 'dint' && internal.value === 0 && internal.retain === true,
  JSON.stringify(internal));
ok('D 地址留空时「保持」可勾', retainEnabled === true, String(retainEnabled));

/* 有地址时「保持」自动禁掉（和变量表那条规矩一致：保持是 PLC 的事） */
await typeAct('_x1');
await page.evaluate(() => {
  [...document.querySelectorAll('.vp-list .vp-row')].find(r => r.dataset.new === '1')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
await sleep(250);
await page.fill('#vaAddr', '%MW300');
const retainWhenAddr = await page.evaluate(() => ({ disabled: document.getElementById('vaRetain').disabled, checked: document.getElementById('vaRetain').checked }));
ok('D 填了 PLC 地址 → 「保持」自动禁用（保持由 PLC 负责）',
  retainWhenAddr.disabled === true && retainWhenAddr.checked === false, JSON.stringify(retainWhenAddr));
await closeDlg();

/* ══════ E. 字符串类型：字符数那一格出现并生效 ══════ */
await typeAct('_sMsg');
await page.evaluate(() => {
  [...document.querySelectorAll('.vp-list .vp-row')].find(r => r.dataset.new === '1')
    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
await sleep(250);
await page.selectOption('#vaType', 'string');
const lenShown = await page.evaluate(() => getComputedStyle(document.getElementById('vaLenWrap')).display !== 'none');
await page.fill('#vaName', 'sMsg');
await page.fill('#vaLen', '24');
await page.click('#dlgOk');
await sleep(400);
const strVar = (await varsOf()).find(v => v.name === 'sMsg');
ok('E 选 string → 「字符数」那一格出现，填 24 → 变量里 len=24',
  lenShown === true && strVar?.len === 24 && strVar?.type === 'string', JSON.stringify({ lenShown, strVar }));

/* ══════ F. 一个匹配都没有时**直接回车**就弹新建框 ══════ */
await page.click(actInputSel);
await page.fill(actInputSel, '');
await page.type(actInputSel, 'Hb正向点动[9]', { delay: 10 });
await sleep(250);
await page.keyboard.press('Enter');
await sleep(300);
const byEnter = await page.evaluate(() => ({
  open: !!document.querySelector('#dlgMask:not(.hidden) #vaName'),
  name: document.getElementById('vaName')?.value,
}));
ok('F 没有匹配时直接回车 → 直接弹「新建变量」（名字已预填）',
  byEnter.open && byEnter.name === 'Hb正向点动[9]', JSON.stringify(byEnter));

/* 有匹配时回车照旧是"选第一个"（老行为不变） */
await closeDlg();
await page.click(actInputSel);
await page.fill(actInputSel, '');
await page.type(actInputSel, 'rSpe', { delay: 10 });
await sleep(250);
await page.keyboard.press('Enter');
await sleep(300);
const byEnter2 = await page.evaluate((sel) => ({
  dlg: !!document.querySelector('#dlgMask:not(.hidden) #vaName'),
  bound: document.querySelector(sel)?.value || '',
}), actInputSel);
const bound2 = await page.evaluate((id) => window.app.project.getWidget(id)?.actions?.[0]?.params?.variable, ids.btn);
ok('F 有匹配时回车照旧选第一个（不会误弹新建框）', !byEnter2.dlg && bound2 === 'rSpeed', JSON.stringify({ byEnter2, bound2 }));

/* ══════ G. 重名 / 取消 ══════ */
await page.click(actInputSel);
await page.fill(actInputSel, '');
await page.type(actInputSel, 'Hb新点位', { delay: 10 });
await sleep(250);
await page.keyboard.press('Enter');
await sleep(300);
await page.fill('#vaName', 'bRun');                       // 改成变量表里已有的名字
await page.click('#dlgOk');
await sleep(300);
const dup = await page.evaluate(() => ({
  open: !!document.querySelector('#dlgMask:not(.hidden) #vaName'),
  msg: document.getElementById('vaMsg')?.textContent || '',
}));
const dupCount = (await varsOf()).filter(v => v.name === 'bRun').length;
ok('G 重名 → 报错、对话框不关、不重复建', dup.open && /已经有/.test(dup.msg) && dupCount === 1,
  JSON.stringify({ dup, count: dupCount }));
await page.fill('#vaName', 'Hb新点位');
await closeDlg();
await sleep(200);
ok('G 点「取消」→ 什么都没建', !(await varsOf()).some(v => v.name === 'Hb新点位'), '');

/* ══════ H. 变量表面板里能看到新建的（不是只活在动作里） ══════ */
await page.click('.lp-tab[data-tab="vars"]');
await sleep(300);
await page.fill('#varFilter', 'Hb反向点动');
await sleep(300);
const inPanel = await page.evaluate(() => [...document.querySelectorAll('#varRows tr')]
  .map(tr => tr.dataset.name).filter(Boolean));
ok('H 变量表面板里确实有这一条（搜索也能搜到）', inPanel.includes('Hb反向点动[7]'), JSON.stringify(inPanel));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 变量框里顺手新建变量：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
