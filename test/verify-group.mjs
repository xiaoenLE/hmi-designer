// verify-group.mjs — 编组：组合/取消组合、整组选中、一起移动、一起缩放、复制粘贴、删除、撤销
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(200);

/* 三个控件，位置明确好算 */
const ids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.pages[0].widgets.length = 0;
  const a = m.project.addWidget('lamp', 60, 60);
  const b = m.project.addWidget('label', 160, 60);
  const c = m.project.addWidget('rect', 320, 200);
  m.project.updateWidgetField(b.id, 'w', 80);
  m.project.updateWidgetField(b.id, 'h', 30);
  m.project.commit('建三个控件');
  return [a.id, b.id, c.id];
});
const canvas = await page.evaluate(async () => (await import('/js/editor/canvas.js')).setZoom(1));
await page.waitForTimeout(200);

const state = () => page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return m.project.currentWidgets().map(w => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, group: w.group || null, locked: !!w.locked }));
});
const selection = () => page.evaluate(async () => (await import('/js/editor/canvas.js')).getSelection());
const boxOf = (id) => page.locator(`#canvas .wd[data-id="${id}"]`).boundingBox();
/** 点控件中心（用坐标点，像真人一样 —— 内层 .w-lamp 之类会拦截 Playwright 的元素点击检查） */
async function clickWidget(id, mods = []) {
  const b = await boxOf(id);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(150);
}

const ribbon = page.locator('#alignGroup');
const ribbonOnGridRow = () => ribbon.evaluate(el => {
  const tools = el.getBoundingClientRect();
  const group = document.getElementById('btnUngroup').getBoundingClientRect();
  return tools.left >= group.right && tools.top < group.bottom && tools.bottom > group.top;
});
const ribbonHeight = (await ribbon.boundingBox()).height;
const selectionButtons = page.locator('#alignGroup button, #btnGroup, #btnUngroup');
const enabledSelectionTools = () => selectionButtons.evaluateAll(buttons =>
  buttons.filter(btn => !btn.disabled).map(btn => btn.dataset.align || btn.dataset.size || btn.id));
ok('没有选中控件时仍显示固定工具栏，操作全部禁用',
  await ribbon.isVisible() && (await enabledSelectionTools()).length === 0);
ok('组合和取消组合图标紧跟主工具栏的网格按钮',
  await page.locator('.toolbar-main .tb-cluster:has(#btnGrid) + .tb-cluster #btnGroup + #btnUngroup').isVisible());
ok('空间足够时对齐和尺寸图标紧跟组合按钮，留在网格所在行', await ribbonOnGridRow());
const toolbarClusters = page.locator('#toolbar .tb-cluster');
ok('历史、层级和锁定、画布辅助、编组各有独立方框',
  JSON.stringify(await toolbarClusters.evaluateAll(groups => groups.slice(0, 4).map(group => group.ariaLabel)))
    === JSON.stringify(['编辑历史', '控件层级和锁定', '画布辅助', '编组']));
ok('各操作分组的高度和边框一致', await toolbarClusters.evaluateAll(groups => {
  const [reference] = groups;
  const referenceStyle = getComputedStyle(reference);
  return groups.every(group => {
    const style = getComputedStyle(group);
    return group.offsetHeight === reference.offsetHeight && style.border === referenceStyle.border
      && style.borderRadius === referenceStyle.borderRadius;
  });
}));
ok('编辑工具只显示图标并保留操作提示',
  !(await ribbon.textContent()).trim() && await toolbarClusters.locator('button').evaluateAll(buttons =>
    buttons.every(btn => !btn.textContent.trim() && btn.querySelector('svg use') && btn.title && btn.ariaLabel)));
await page.evaluate(async selected => (await import('/js/editor/canvas.js')).select(selected), ids);
ok('三个独立控件选中时，等间距和等尺寸操作可用',
  (await enabledSelectionTools()).includes('hdist') && (await enabledSelectionTools()).includes('both'));
ok('选择变化时工具栏高度保持一致', (await ribbon.boundingBox()).height === ribbonHeight);

/* ── A. 组合：Ctrl+G ── */
await page.evaluate(async (id) => (await import('/js/editor/canvas.js')).select([id]), ids[0]);
await clickWidget(ids[1], ['Shift']);                      // Shift 加选第二个
let sel = await selection();
ok('先选中 2 个控件（点选 + Shift 加选）', sel.length === 2, JSON.stringify(sel));
const lockButton = page.locator('#btnLock');
await lockButton.click();
ok('锁定图标切换为解锁并更新悬停提示',
  await lockButton.getAttribute('aria-label') === '解锁' && await lockButton.getAttribute('title') === '解锁选中控件');
await lockButton.click();
ok('两个独立控件可对齐和组合，等间距操作禁用',
  (await enabledSelectionTools()).includes('left') && (await enabledSelectionTools()).includes('btnGroup')
    && !(await enabledSelectionTools()).includes('hdist'));
await page.getByRole('button', { name: '组合', exact: true }).click();
const iconGroup = (await state()).find(w => w.id === ids[0]).group;
ok('点击网格后的两个图标可以组合和取消组合',
  !!iconGroup && (await state()).find(w => w.id === ids[1]).group === iconGroup
  && await page.getByRole('button', { name: '取消组合', exact: true }).isEnabled());
await page.getByRole('button', { name: '取消组合', exact: true }).click();
ok('点击取消组合后，两个控件的组号清空', (await state()).every(w => !w.group));
await page.keyboard.press('Control+g');
await page.waitForTimeout(200);
let st = await state();
const g1 = st.find(w => w.id === ids[0]).group;
ok('Ctrl+G 组合：两个控件拿到同一个组号',
  !!g1 && st.find(w => w.id === ids[1]).group === g1 && st.find(w => w.id === ids[2]).group === null,
  JSON.stringify(st.map(w => [w.id.slice(-3), w.group])));
const statusText = await page.textContent('#stSel');
ok('状态栏写明「已选中 1 组」', /1 组/.test(statusText), statusText);
ok('画布上出现「组 N」角标', await page.locator('#canvas .group-tag').count() > 0);
ok('只选中一个整体组合时，仅取消组合可用', (await enabledSelectionTools()).join() === 'btnUngroup');

const upLayer = page.locator('#btnZUp');
const downLayer = page.locator('#btnZDown');
const paintedOrder = () => page.locator('#canvas .wd').evaluateAll((widgets, ids) => widgets
  .filter(el => ids.includes(el.dataset.id))
  .sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex))
  .map(el => el.dataset.id), ids);
const sameOrder = (actual, expected) => actual.join() === expected.join();
ok('组合在底部时可上移一层，下移按钮禁用', await upLayer.isEnabled() && await downLayer.isDisabled());
await upLayer.click();
ok('整个组合上移一层，组内叠放顺序保持', sameOrder(await paintedOrder(), [ids[2], ids[0], ids[1]])
  && await upLayer.isDisabled() && await downLayer.isEnabled());
await downLayer.click();
ok('点击下移一层能把组合移回原位置', sameOrder(await paintedOrder(), ids));
await page.locator('#btnZTop').click();
await downLayer.click();
ok('组合成员层级相同也能下移一层，并保持组内绘制顺序', sameOrder(await paintedOrder(), ids));

/* ── B. 点组里任意一个 = 选中整组 ── */
await page.evaluate(async () => (await import('/js/editor/canvas.js')).select([]));
await page.waitForTimeout(150);
await clickWidget(ids[1]);
sel = await selection();
ok('点组内一个控件 → 整组被选中', sel.length === 2 && sel.includes(ids[0]) && sel.includes(ids[1]), JSON.stringify(sel));

/* ── C. 一起拖动：位移量一致 ── */
const before = await state();
const box = await boxOf(ids[1]);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 25, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(250);
const after = await state();
const d0 = { dx: after[0].x - before[0].x, dy: after[0].y - before[0].y };
const d1 = { dx: after[1].x - before[1].x, dy: after[1].y - before[1].y };
ok('拖组内一个 → 两个一起移动，位移一致',
  d0.dx === 40 && d0.dy === 25 && d1.dx === 40 && d1.dy === 25, JSON.stringify({ d0, d1 }));
ok('组外的第三个控件没动',
  after[2].x === before[2].x && after[2].y === before[2].y, JSON.stringify(after[2]));

/* ── D. 整组缩放：按外框比例缩放，组内相对布局保持 ── */
const b0 = await state();
const gb = { x1: Math.min(...b0.slice(0, 2).map(w => w.x)), y1: Math.min(...b0.slice(0, 2).map(w => w.y)),
  x2: Math.max(...b0.slice(0, 2).map(w => w.x + w.w)), y2: Math.max(...b0.slice(0, 2).map(w => w.y + w.h)) };
const seHandle = await page.locator('#canvas .sel-h-se').boundingBox();
await page.mouse.move(seHandle.x + seHandle.width / 2, seHandle.y + seHandle.height / 2);
await page.mouse.down();
await page.mouse.move(seHandle.x + seHandle.width / 2 + Math.round((gb.x2 - gb.x1) / 2),
  seHandle.y + seHandle.height / 2 + Math.round((gb.y2 - gb.y1) / 2), { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const b1 = await state();
const rel0 = b0[1].x - b0[0].x, rel1 = b1[1].x - b1[0].x;
ok('整组缩放：外框变大、成员跟着变大（不是只改一个）',
  (b1[0].w > b0[0].w) && (b1[1].w > b0[1].w), JSON.stringify({ w0: [b0[0].w, b0[1].w], w1: [b1[0].w, b1[1].w] }));
ok('整组缩放：相对位置按比例放大（组内布局不变形）', rel1 > rel0, `相对间距 ${rel0} → ${rel1}`);

/* ── E. Alt+点击：只选组里这一个（方便单独调） ── */
await clickWidget(ids[0], ['Alt']);
sel = await selection();
ok('Alt+点击 → 只选中组里那一个', sel.length === 1 && sel[0] === ids[0], JSON.stringify(sel));

/* ── E. Alt+点击：只选组里这一个（方便单独调） ── */
await clickWidget(ids[0], ['Alt']);
sel = await selection();
ok('Alt+点击 → 只选中组里那一个', sel.length === 1 && sel[0] === ids[0], JSON.stringify(sel));

/* ── E2. 组内单个控件的「修改入口」：属性面板列表 / 右键菜单 / 清单 Alt+点击 ── */
// 选中整组 → 属性面板列出组内控件，点一个只选它
await clickWidget(ids[1]);                     // 点组内任意一个 = 选中整组
sel = await selection();
const panelGroup = await page.evaluate(() => ({
  count: document.querySelectorAll('#propBody .gm-item').length,
  names: [...document.querySelectorAll('#propBody .gm-item .gm-name')].map(e => e.textContent),
  hint: document.querySelector('#propBody .group-hint')?.textContent || '',
  title: [...document.querySelectorAll('#propBody .prop-group-title')].map(e => e.textContent).join('|'),
}));
ok('选中整组时，属性面板列出「组内控件（N 个）· 点一个只选它」',
  sel.length === 2 && panelGroup.count === 2 && /组内控件（2 个）/.test(panelGroup.title),
  JSON.stringify({ sel: sel.length, panelGroup }));
// 现场要求：属性面板不摆说明文字（Alt+点击 / 右键 那两句已经删掉），只留功能入口
ok('面板里不摆说明文字（现场要求：属性面板保持干净）',
  !/Alt \+ 点击/.test(panelGroup.hint) && !/右键/.test(panelGroup.hint), panelGroup.hint);
// 点第二个成员 → 只选它，属性面板切成它自己的属性
await page.evaluate((name) => {
  const btn = [...document.querySelectorAll('#propBody .gm-item')].find(b => b.querySelector('.gm-name')?.textContent === name);
  btn.click();
}, panelGroup.names[1]);
await page.waitForTimeout(300);
const picked = await page.evaluate(() => ({
  sel: null,
  nameVal: document.querySelector('#propBody [data-fld="name"]')?.value || '',
  hasGeom: !!document.querySelector('#propBody [data-fld="x"]'),
  groupHint: document.querySelector('#propBody .group-hint')?.textContent || '',
}));
sel = await selection();
ok('点面板里的成员 → 只选中它自己（组没散）',
  sel.length === 1 && picked.hasGeom && picked.nameVal === panelGroup.names[1]
  && (await state()).find(w => w.id === sel[0]).group === g1,
  JSON.stringify({ sel, picked }));
ok('单选组内控件时，面板只给「选中整组」按钮（说明文字已按现场要求删掉）',
  !/在组合里/.test(picked.groupHint) && !/只选中了这一个/.test(picked.groupHint)
  && !!(await page.$('#pickWholeGroup')), picked.groupHint.slice(0, 80));
// 点「选中整组」回到整组
await page.click('#pickWholeGroup');
await page.waitForTimeout(250);
sel = await selection();
ok('点「选中整组」→ 又回到整组选中', sel.length === 2 && sel.includes(ids[0]) && sel.includes(ids[1]), JSON.stringify(sel));

// 右键菜单：整组选中时能直接挑成员
await clickWidget(ids[1]);
const b = await boxOf(ids[0]);
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
await page.waitForTimeout(250);
const menu = await page.evaluate(() => ({
  labels: [...document.querySelectorAll('#ctxMenu .ctx-label')].map(e => e.textContent),
  headers: [...document.querySelectorAll('#ctxMenu .ctx-head')].map(e => e.textContent),
}));
ok('整组选中时右键菜单里有「单独选中组内某个控件」+ 每个成员一项',
  menu.headers.includes('单独选中组内某个控件') && menu.labels.includes(panelGroup.names[0]) && menu.labels.includes(panelGroup.names[1]),
  JSON.stringify(menu));
await page.evaluate((name) => {
  const item = [...document.querySelectorAll('#ctxMenu .ctx-item')].find(el => el.querySelector('.ctx-label')?.textContent === name);
  item.click();
}, panelGroup.names[0]);
await page.waitForTimeout(300);
sel = await selection();
ok('右键菜单里点成员名 → 只选中它', sel.length === 1 && sel[0] === ids[0], JSON.stringify(sel));

// 控件清单：Alt+点击行 = 只选它；普通点击仍是整组
await page.evaluate(() => document.querySelector('.lp-tab[data-panel="list"]')?.click());
await page.waitForTimeout(400);
const listInfo = await page.evaluate((targetId) => {
  const row = [...document.querySelectorAll('#widgetList .wl-item')].find(r => r.dataset.id === targetId);
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
  return { found: !!row };
}, ids[0]);
await page.waitForTimeout(350);
sel = await selection();
ok('控件清单里 Alt+点击一行 → 只选中这一个（普通点击仍是整组）',
  listInfo.found && sel.length === 1 && sel[0] === ids[0], JSON.stringify({ found: listInfo.found, sel }));
await page.evaluate(async (i) => (await import('/js/editor/canvas.js')).select([i]), ids[1]);
await page.waitForTimeout(200);
sel = await selection();
ok('清单普通点击仍是「选中整组」（老习惯不变）', sel.length === 2, JSON.stringify(sel));

/* ── F. 复制粘贴：粘贴出来的是"新的一组"，相对布局保持 ── */
await page.evaluate(async (i) => (await import('/js/editor/canvas.js')).select([i]), ids[0]);
await page.keyboard.press('Control+c');
await page.keyboard.press('Control+v');
await page.waitForTimeout(300);
const stP = await state();
const pasted = stP.filter(w => !ids.includes(w.id));
ok('Ctrl+C / Ctrl+V 粘贴出 2 个副本（保持相对布局）',
  pasted.length === 2 && (pasted[1].x - pasted[0].x) === (stP[1].x - stP[0].x), JSON.stringify(pasted.map(w => [w.x, w.y])));
ok('粘贴出来的两个是「新的一组」，组号与原件不同',
  !!pasted[0].group && pasted[0].group === pasted[1].group && pasted[0].group !== g1,
  JSON.stringify({ 新组: pasted[0].group, 原组: g1 }));

/* ── G. 取消组合：Ctrl+Shift+G ── */
await page.evaluate(async (i) => (await import('/js/editor/canvas.js')).select([i]), ids[2]);   // 先清一下选择
await page.evaluate(async (i) => (await import('/js/editor/canvas.js')).select([i]), pasted[0].id);
await page.keyboard.press('Control+Shift+g');
await page.waitForTimeout(250);
const stU = await state();
ok('Ctrl+Shift+G 取消组合（组号清空）',
  !stU.find(w => w.id === pasted[0].id).group && !stU.find(w => w.id === pasted[1].id).group,
  JSON.stringify(stU.map(w => w.group)));

/* ── H. 删除：选中组里一个 → 整组删掉 ── */
await page.evaluate(async (i) => (await import('/js/editor/canvas.js')).select([i]), ids[0]);
await page.waitForTimeout(150);
await page.keyboard.press('Delete');
await page.waitForTimeout(250);
const stD = await state();
ok('删除组内一个 → 整组一起删（原来 5 个，删掉 2 个）',
  stD.length === 3 && !stD.some(w => w.id === ids[0]) && !stD.some(w => w.id === ids[1]),
  JSON.stringify(stD.map(w => w.id.slice(-3))));

/* ── I. 撤销：把删除撤销回来 ── */
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const stZ = await state();
ok('Ctrl+Z 撤销 → 被删的整组回来了', stZ.length === 5, String(stZ.length));

/* ── J. 右键菜单里有组合项 ── */
// 注意：右键要点在"没被其它控件压住"的那个上（粘贴的副本会盖住原控件）
await page.evaluate(async ([i, j]) => (await import('/js/editor/canvas.js')).select([i, j]), [ids[0], ids[2]]);
await page.waitForTimeout(150);
const cbox = await boxOf(ids[2]);
await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, { button: 'right' });
await page.waitForTimeout(200);
const menuMulti = await page.textContent('#ctxMenu');
ok('多选右键菜单里有「组合 / 取消组合」',
  /组合/.test(menuMulti) && /取消组合/.test(menuMulti), menuMulti.replace(/\s+/g, ' ').slice(0, 80));
await page.keyboard.press('Escape');

/* ── K. 工程存档里带 group 字段（刷新后还是组） ── */
const round = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const json = JSON.parse(JSON.stringify(m.project.data));
  m.project.replaceData(json);
  return m.project.currentWidgets().filter(w => w.group).length;
});
ok('工程存档往返后编组关系还在（刷新不会丢组）', round === 2, String(round));

/* ── L. 对齐：组要当成"一个整体"挪，组内相对位置不能变 ── */
const laid = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const c = await import('/js/editor/canvas.js');
  m.project.data.pages[0].widgets.length = 0;
  const a = m.project.addWidget('lamp', 100, 100);      // 组内左
  const b = m.project.addWidget('label', 320, 140);     // 组内右（相对偏移 +220 / +40）
  const c1 = m.project.addWidget('rect', 500, 400);     // 组外，用它当对齐基准（宽 200）
  m.project.updateWidgetField(b.id, 'w', 80); m.project.updateWidgetField(b.id, 'h', 30);
  m.project.updateWidgetField(c1.id, 'w', 200); m.project.updateWidgetField(c1.id, 'h', 120);
  m.project.commit('对齐准备');
  c.select([a.id, b.id]);
  c.groupSelection();                                   // 组合
  return { a: a.id, b: b.id, other: c1.id };
});
await page.waitForTimeout(200);
const before2 = await state();
const relBefore = { dx: before2.find(w => w.id === laid.b).x - before2.find(w => w.id === laid.a).x,
  dy: before2.find(w => w.id === laid.b).y - before2.find(w => w.id === laid.a).y };
// 把「组外那个」设成主控件（最后选中）→ 组以它为基准左对齐
await page.evaluate(async ([g, o]) => {
  const c = await import('/js/editor/canvas.js');
  const members = (await import('/js/core/project.js')).project.groupMembers(g);
  c.select([...members, o]);                             // 组 + 组外控件（组外最后选 = 主控件）
}, [laid.a, laid.other]);
await page.waitForTimeout(150);
await page.setViewportSize({ width: 800, height: 600 });
const toolbarOverflow = await page.locator('#toolbar button:visible').evaluateAll(buttons =>
  buttons.filter(btn => btn.getBoundingClientRect().right > innerWidth).map(btn => btn.id || btn.title));
ok('窄窗口多选时，主工具栏和多选操作都在窗口内', toolbarOverflow.length === 0, toolbarOverflow.join(', '));
await page.locator('#alignGroup [data-align="left"]').click();
await page.waitForTimeout(250);
const after2 = await state();
const A = after2.find(w => w.id === laid.a), B = after2.find(w => w.id === laid.b), O = after2.find(w => w.id === laid.other);
const relAfter = { dx: B.x - A.x, dy: B.y - A.y };
ok('左对齐：整组挪到基准左边线上（组外框左边缘 = 基准左边缘）',
  Math.min(A.x, B.x) === O.x, `组左=${Math.min(A.x, B.x)} 基准左=${O.x}`);
ok('左对齐没有拆开组：组内相对位置完全没变（这就是之前的问题）',
  relAfter.dx === relBefore.dx && relAfter.dy === relBefore.dy,
  `相对 ${JSON.stringify(relBefore)} → ${JSON.stringify(relAfter)}`);

/* 顶对齐 + 水平居中 同样按整体走 */
const before3 = await state();
const relB3 = { dx: before3.find(w => w.id === laid.b).x - before3.find(w => w.id === laid.a).x };
await page.locator('#alignGroup [data-align="top"]').click();
await page.waitForTimeout(200);
const after3 = await state();
const A3 = after3.find(w => w.id === laid.a), B3 = after3.find(w => w.id === laid.b), O3 = after3.find(w => w.id === laid.other);
ok('顶对齐：整组上边缘贴基准，组内偏移不变',
  Math.min(A3.y, B3.y) === O3.y && (B3.x - A3.x) === relB3.dx, JSON.stringify({ A: [A3.x, A3.y], B: [B3.x, B3.y], O: [O3.x, O3.y] }));

/* 等大小：组按比例缩放到基准尺寸，组内布局不变形 */
const before4 = await state();
const w4a = before4.find(w => w.id === laid.a), w4b = before4.find(w => w.id === laid.b);
const rel4 = w4b.x - w4a.x;
const boxW4 = Math.max(w4a.x + w4a.w, w4b.x + w4b.w) - Math.min(w4a.x, w4b.x);
const memberW4 = w4a.w;                       // 组内成员宽度（缩放前）
await page.locator('#alignGroup [data-size="width"]').click();
await page.waitForTimeout(250);
const after4 = await state();
const A4 = after4.find(w => w.id === laid.a), B4 = after4.find(w => w.id === laid.b), O4 = after4.find(w => w.id === laid.other);
const boxW5 = Math.max(A4.x + A4.w, B4.x + B4.w) - Math.min(A4.x, B4.x);
const rel5 = B4.x - A4.x;
ok('等宽：组的整体宽度变成基准宽度', boxW5 === O4.w, `组宽 ${boxW4} → ${boxW5}，基准 ${O4.w}`);
ok('等宽：组内按比例缩放（相对间距跟着缩放，不是把成员各自拉到基准宽）',
  rel5 !== rel4 && Math.abs(rel5 - Math.round(rel4 * O4.w / boxW4)) <= 2 && A4.w !== memberW4,
  `相对间距 ${rel4} → ${rel5}（预期约 ${Math.round(rel4 * O4.w / boxW4)}）；成员宽 ${memberW4} → ${A4.w}`);

await page.setViewportSize({ width: 390, height: 720 });
await page.waitForFunction(() => !document.querySelector('.toolbar-main').classList.contains('align-inline'));
const wrapped = await ribbon.evaluate(el => {
  const groupTops = [...el.children].map(group => group.getBoundingClientRect().top);
  return groupTops.every(top => top === groupTops[0])
    && el.getBoundingClientRect().top >= document.getElementById('btnUngroup').getBoundingClientRect().bottom;
});
ok('空间不足时对齐和尺寸作为一组换到网格下方', wrapped && !(await ribbonOnGridRow()));
const narrowRibbonFits = await page.locator('#toolbar button:visible').evaluateAll(buttons =>
  buttons.every(btn => btn.getBoundingClientRect().right <= innerWidth));
ok('390px 窄窗口工具栏换行，所有按钮留在窗口内', narrowRibbonFits);
ok('窄窗口里编组仍与网格在同一行', await page.locator('#btnGrid').evaluate(grid =>
  grid.getBoundingClientRect().top === document.getElementById('btnGroup').getBoundingClientRect().top));
await page.setViewportSize({ width: 1500, height: 900 });
await page.waitForFunction(() => document.querySelector('.toolbar-main').classList.contains('align-inline'));
ok('窗口拉宽后对齐和尺寸自动回到网格所在行', await ribbonOnGridRow());
ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 编组回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
