// verify-dock.mjs — 面板停靠系统：拖出浮动 / 合并成标签 / 停到底部或侧边 / 刷新后保持
// 用法：先启动 8866 服务，再 node test/verify-dock.mjs [端口]
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;
installNodeFetchPatch(URL);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

async function boot() {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.waitForTimeout(250);
}
/** 某停靠区当前有哪些标签（按顺序）*/
const tabsOf = dock => page.evaluate(d => [...document.querySelectorAll(`#${d} .dock-tabs .lp-tab`)].map(t => t.textContent), dock);
/** 面板元素现在挂在哪 */
const whereIs = id => page.evaluate(id => {
  const p = document.getElementById('panel-' + id);
  if (!p) return 'MISSING';
  if (p.classList.contains('floating')) return 'float';
  const dock = p.closest('.dock');
  return dock ? dock.id : (p.parentElement?.id || 'detached');
}, id);
/** 把某个 dock 的某个标签拖到屏幕坐标 (x,y)；holdBeforeDrop=true 时只移到位置不松手 */
async function dragTab(dock, id, x, y, opts = {}) {
  const box = await page.locator(`#${dock} .lp-tab[data-panel="${id}"]`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 3 });   // 越过拖拽阈值
  await page.mouse.move(x, y, { steps: 8 });
  if (opts.holdBeforeDrop) { await page.waitForTimeout(150); return; }
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/* ══════ 1. 默认布局：和原来的三栏一模一样 ══════ */
await boot();
ok('默认：左区 6 个标签（控件/页面/变量/报警/脚本/清单）', JSON.stringify(await tabsOf('leftPanel')) === JSON.stringify(['控件', '页面', '变量', '报警', '脚本', '清单']),
  JSON.stringify(await tabsOf('leftPanel')));
ok('默认：右区只有「属性」', JSON.stringify(await tabsOf('rightPanel')) === JSON.stringify(['属性']),
  JSON.stringify(await tabsOf('rightPanel')));
ok('默认：底部停靠区隐藏（空区自动收起）',
  (await page.evaluate(() => getComputedStyle(document.getElementById('bottomPanel')).display)) === 'none');
ok('默认：各面板在正确位置',
  (await whereIs('toolbox')) === 'leftPanel' && (await whereIs('properties')) === 'rightPanel',
  `${await whereIs('toolbox')} / ${await whereIs('properties')}`);

/* ══════ 2. 点标签切换（旧用法不变）══════ */
await page.click('.lp-tab[data-tab="vars"]');
await page.waitForTimeout(150);
const switched = await page.evaluate(() => ({
  active: document.querySelector('#leftPanel .lp-tab.active')?.dataset.panel,
  visible: !!document.querySelector('#panel-vars.active'),
  rows: document.querySelectorAll('#varTable tr').length,
}));
ok('点标签切换面板（变量表渲染出来了）', switched.active === 'vars' && switched.visible && switched.rows > 3,
  JSON.stringify(switched));

/* ══════ 3. 拖到右边缘（右区的标签栏）→ 和「属性」合并成标签 ══════ */
// ⚠ 落在面板区里现在是「自动分屏」；并成标签页要拖到**标签栏**上
const rtab0 = await page.locator('#rightPanel .dock-tabs').boundingBox();
await dragTab('leftPanel', 'list', rtab0.x + rtab0.width / 2, rtab0.y + rtab0.height / 2);
ok('拖到右边缘 → 停靠到右区', (await whereIs('list')) === 'rightPanel', await whereIs('list'));
ok('右区两个面板合并成标签页',
  JSON.stringify(await tabsOf('rightPanel')) === JSON.stringify(['属性', '清单']),
  JSON.stringify(await tabsOf('rightPanel')));
ok('并入右区后成为当前标签', await page.evaluate(() => document.querySelector('#rightPanel .lp-tab.active')?.dataset.panel === 'list'));

/* ══════ 4. 拖到下边缘 → 中部/底部停靠区出现 ══════ */
await dragTab('leftPanel', 'vars', 700, 860);
ok('拖到下边缘 → 底部停靠区出现',
  (await page.evaluate(() => getComputedStyle(document.getElementById('bottomPanel')).display)) !== 'none' &&
  (await whereIs('vars')) === 'bottomPanel', await whereIs('vars'));
ok('底部区标签正确', JSON.stringify(await tabsOf('bottomPanel')) === JSON.stringify(['变量']), JSON.stringify(await tabsOf('bottomPanel')));
ok('底部出现后左区剩控件/页面/报警/脚本',
  JSON.stringify(await tabsOf('leftPanel')) === JSON.stringify(['控件', '页面', '报警', '脚本']), JSON.stringify(await tabsOf('leftPanel')));

/* ══════ 4b. 拖到「画布下方那条灰色带」也算停靠到底部 ══════ */
// 拖动过程中要有半透明落点预览，明确告诉用户会停到哪儿（不然容易误判成浮动窗）
// ⚠ 落点选底部区的**标签栏**：落在面板区里现在是「自动分屏」（那是 4c 的用例）
const btabs = await page.locator('#bottomPanel .dock-tabs').boundingBox();
await dragTab('rightPanel', 'list', btabs.x + 60, btabs.y + btabs.height / 2, { holdBeforeDrop: true });
const preview = await page.evaluate(() => {
  const el = document.querySelector('.dock-preview');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { text: el.textContent, display: getComputedStyle(el).display, top: Math.round(r.top), w: Math.round(r.width) };
});
ok('拖动时有落点预览，且标明「停靠到底部」',
  !!preview && preview.display === 'flex' && preview.text === '停靠到底部' && preview.w > 500, JSON.stringify(preview));
await page.mouse.up();
await page.waitForTimeout(250);
ok('松手后预览消失', await page.evaluate(() => getComputedStyle(document.querySelector('.dock-preview')).display === 'none'));
ok('拖到画布下缘外侧 → 也停靠到底部（不再变成浮动窗）',
  (await whereIs('list')) === 'bottomPanel', await whereIs('list'));
ok('底部区现在是两个标签', JSON.stringify(await tabsOf('bottomPanel')) === JSON.stringify(['变量', '清单']),
  JSON.stringify(await tabsOf('bottomPanel')));
// 挪回去，后面的用例仍按原布局跑
// ⚠ 落点要在**标签栏**上：落在面板区里现在是「自动分屏」，只有标签栏才是「并成标签页」
const rtabs = await page.locator('#rightPanel .dock-tabs').boundingBox();
await dragTab('bottomPanel', 'list', rtabs.x + rtabs.width / 2, rtabs.y + rtabs.height / 2);
ok('再拖回右区恢复原状', (await whereIs('list')) === 'rightPanel', await whereIs('list'));

/* ══════ 5. 搬运之后面板功能照旧（事件监听没丢）══════ */
const varAdd = await page.evaluate(async () => {
  const before = window.app.project.variables().length;
  document.getElementById('btnAddVar').click();
  await new Promise(r => setTimeout(r, 120));
  return { before, after: window.app.project.variables().length,
    rows: document.querySelectorAll('#varTable tr').length };
});
ok('搬到下面的「变量」面板：＋添加变量 仍然有效', varAdd.after === varAdd.before + 1, JSON.stringify(varAdd));

/* ══════ 6. 拖到画布中间 → 浮动窗口 ══════ */
await dragTab('leftPanel', 'pages', 700, 320);
const floating = await page.evaluate(() => {
  const p = document.getElementById('panel-pages');
  const r = p.getBoundingClientRect();
  return { floating: p.classList.contains('floating'), parent: p.parentElement.tagName,
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
ok('拖到画布中间 → 变成浮动窗口', floating.floating && floating.parent === 'BODY', JSON.stringify(floating));
ok('浮动窗口尺寸合理（不是停靠区那么高）', floating.h <= 560 && floating.w <= 440, `${floating.w}x${floating.h}`);
ok('浮动后左区不再有「页面」标签',
  JSON.stringify(await tabsOf('leftPanel')) === JSON.stringify(['控件', '报警', '脚本']), JSON.stringify(await tabsOf('leftPanel')));

/* ══════ 7. 浮动窗口：拖标题移动 + 里面的按钮还能用 ══════ */
const head = await page.locator('#panel-pages .panel-head').boundingBox();
await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
await page.mouse.down();
await page.mouse.move(head.x + head.width / 2 - 180, head.y + head.height / 2 + 120, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(150);
const moved = await page.evaluate(() => {
  const r = document.getElementById('panel-pages').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y) };
});
ok('拖浮动窗口标题可以移动', Math.abs(moved.x - (floating.x - 180)) <= 3 && Math.abs(moved.y - (floating.y + 120)) <= 3,
  `(${floating.x},${floating.y}) → (${moved.x},${moved.y})`);
const pageAdd = await page.evaluate(async () => {
  const before = window.app.project.pages().length;
  // 「＋ 新建 ▾」现在是**下拉菜单**（面板窄时四个按钮会挤出去）→ 点开再点「新建页面」
  document.getElementById('btnAddPage').click();
  await new Promise(r => setTimeout(r, 150));
  [...document.querySelectorAll('#ctxMenu .ctx-item')].find(i => /新建页面/.test(i.textContent))?.click();
  await new Promise(r => setTimeout(r, 150));
  return { before, after: window.app.project.pages().length,
    items: document.querySelectorAll('#pageList .pg-item').length };
});
ok('浮动窗口里的「＋ 新建 ▾ → 新建页面」仍然有效', pageAdd.after === pageAdd.before + 1, JSON.stringify(pageAdd));

/* ══════ 8. 浮动窗口：点 ⇤ 停靠回去 ══════ */
await page.click('#panel-pages [data-redock]');
await page.waitForTimeout(200);
ok('点 ⇤ 停靠回原区域（左区）', (await whereIs('pages')) === 'leftPanel', await whereIs('pages'));
// 重新停靠回去的面板会排在标签最后（正常行为）→ 这里比集合不比顺序
const leftBack = (await tabsOf('leftPanel')).slice().sort();
ok('左区几个标签都在（控件/页面/报警/脚本）', JSON.stringify(leftBack) === JSON.stringify(['控件', '报警', '脚本', '页面'].sort()),
  JSON.stringify(leftBack));

/* ══════ 9. 刷新后布局保持 ══════ */
await boot();
const after = {
  left: await tabsOf('leftPanel'),
  right: await tabsOf('rightPanel'),
  bottom: await tabsOf('bottomPanel'),
  listAt: await whereIs('list'),
  varsAt: await whereIs('vars'),
};
ok('刷新后：右区仍是 属性+清单', JSON.stringify(after.right) === JSON.stringify(['属性', '清单']), JSON.stringify(after.right));
ok('刷新后：底部仍是 变量', JSON.stringify(after.bottom) === JSON.stringify(['变量']) && after.varsAt === 'bottomPanel',
  JSON.stringify(after));
ok('刷新后：左区仍是 控件+页面+报警+脚本', JSON.stringify(after.left.slice().sort()) === JSON.stringify(['控件', '页面', '报警', '脚本'].sort()),
  JSON.stringify(after.left));

/* ══════ 10. ⧉ 一键浮动 + 空区自动隐藏 + 底部区域可折叠 ══════ */
// 左区标签数量不固定（以后还可能加面板），所以循环浮到空为止
const floatedIds = [];
for (let i = 0; i < 8; i++) {
  const act = await page.evaluate(() => document.querySelector('#leftPanel .lp-tab.active')?.dataset.panel);
  if (!act) break;
  await page.click('#leftPanel .dock-float');           // ⧉ 浮动「当前标签」那个面板
  await page.waitForTimeout(200);
  floatedIds.push(act);
  if (i === 0) ok('点 ⧉ 把当前标签面板弹成浮动窗口', (await whereIs(act)) === 'float', `${act} → ${await whereIs(act)}`);
}
const act1 = floatedIds[0];
ok('面板全部浮动后左区自动隐藏（画布吃满）',
  (await page.evaluate(() => getComputedStyle(document.getElementById('leftPanel')).display)) === 'none',
  `浮动的：${floatedIds.join(' / ')}`);
const overlap = await page.evaluate(() => {
  const rs = [...document.querySelectorAll('.panel.floating')].map(p => p.getBoundingClientRect());
  if (rs.length < 2) return true;
  return !(Math.abs(rs[0].x - rs[1].x) < 10 && Math.abs(rs[0].y - rs[1].y) < 10);   // 两个浮动窗不能完全叠在一起
});
ok('连续弹出的浮动窗自动错开（不叠罗汉）', overlap);
await page.click(`#panel-${act1} [data-redock]`);
await page.waitForTimeout(200);
ok('停靠回来后左区恢复显示',
  (await page.evaluate(() => getComputedStyle(document.getElementById('leftPanel')).display)) !== 'none' &&
  (await whereIs(act1)) === 'leftPanel', await whereIs(act1));
// 底部折叠
await page.click('#bottomResizer .rz-toggle-h');
await page.waitForTimeout(150);
ok('底部停靠区可折叠',
  (await page.evaluate(() => getComputedStyle(document.getElementById('bottomPanel')).display)) === 'none');
await page.click('#bottomResizer .rz-toggle-h');
await page.waitForTimeout(150);
ok('底部停靠区可展开',
  (await page.evaluate(() => getComputedStyle(document.getElementById('bottomPanel')).display)) !== 'none');

/* ══════ 11. 面板高度：浮窗停靠回来必须撑满（不能留着浮窗那点高度）══════ */
await page.click('#rightPanel .lp-tab[data-panel="properties"]');   // 先切到「属性」，否则它 display:none 量到 0
await page.waitForTimeout(200);
const heightAfterRedock = await page.evaluate(() => {
  const panel = document.getElementById('panel-properties');
  const dock = document.getElementById('rightPanel');
  const pr = panel.getBoundingClientRect(), dr = dock.getBoundingClientRect();
  const panes = dock.querySelector('.dock-panes');
  return { panel: Math.round(pr.height), dock: Math.round(dr.height),
    split: panes.classList.contains('split'), splitV: panes.classList.contains('split-v'),
    grow: panel.style.flexGrow || '',
    inlineH: panel.style.height || '(空)', inlineW: panel.style.width || '(空)' };
});
ok('停靠回来的面板撑满停靠区高度（没有残留浮窗尺寸）',
  heightAfterRedock.panel >= heightAfterRedock.dock - 40 && heightAfterRedock.inlineH === '(空)'
  && heightAfterRedock.inlineW === '(空)',
  JSON.stringify(heightAfterRedock));

// 完整走一遍：浮动 → 拖大 → 停靠回来，高度应恢复成停靠区高度
const roundTrip = await page.evaluate(async () => {
  const panel = document.getElementById('panel-properties');
  const dock = document.getElementById('rightPanel');
  const mod = await import('/js/editor/dock.js');
  mod.floatPanelById('properties');
  await new Promise(r => setTimeout(r, 150));
  panel.style.height = '120px';                      // 模拟用户把浮窗拖矮
  const floatH = Math.round(panel.getBoundingClientRect().height);
  mod.dockPanelTo('properties', 'right');
  await new Promise(r => setTimeout(r, 150));
  return { floatH, backH: Math.round(panel.getBoundingClientRect().height),
    dockH: Math.round(dock.getBoundingClientRect().height), inlineH: panel.style.height || '(空)' };
});
ok('浮窗（拉矮到120）停靠回来 → 恢复撑满',
  roundTrip.backH >= roundTrip.dockH - 40 && roundTrip.backH > roundTrip.floatH + 100
  && roundTrip.inlineH === '(空)',
  JSON.stringify(roundTrip));

/* ══════ 12. 属性面板内容超出要能滚动（不能裁掉） ══════ */
await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('trend', 40, 380);          // 波形属性最多，最容易超
  pr.commit('t');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await page.waitForTimeout(300);
const scroll = await page.evaluate(() => {
  const body = document.getElementById('propBody');
  const cs = getComputedStyle(body);
  const before = body.scrollTop;
  body.scrollTop = 9999;                              // 真滚一下
  const after = body.scrollTop;
  return { overflowY: cs.overflowY, clientH: Math.round(body.clientHeight),
    scrollH: Math.round(body.scrollHeight), before, after };
});
ok('属性面板溢出时是 auto 且真的可以滚',
  scroll.overflowY === 'auto' && scroll.scrollH > scroll.clientH && scroll.after > scroll.before,
  JSON.stringify(scroll));
ok('滚动区被正确限高（不超出面板可视高度）',
  scroll.clientH <= Math.round(await page.evaluate(() => document.getElementById('rightPanel').getBoundingClientRect().height)),
  `clientH=${scroll.clientH}`);

/* ══════ 13. 底部停靠区里的面板同样撑满 ══════ */
const bottomFit = await page.evaluate(() => {
  const panel = document.getElementById('panel-vars');
  const dock = document.getElementById('bottomPanel');
  const ps = getComputedStyle(panel);
  return { panel: Math.round(panel.getBoundingClientRect().height),
    dock: Math.round(dock.getBoundingClientRect().height),
    inlineH: panel.style.height || '(空)', position: ps.position, display: ps.display,
    tabsH: Math.round(document.querySelector('#bottomPanel .dock-tabs').getBoundingClientRect().height) };
});
ok('底部停靠区的面板撑满（高度 = 停靠区 - 标签栏，且无残留内联尺寸）',
  bottomFit.display !== 'none' && bottomFit.position === 'static' && bottomFit.inlineH === '(空)'
  && bottomFit.panel >= bottomFit.dock - bottomFit.tabsH - 2 && bottomFit.panel <= bottomFit.dock - bottomFit.tabsH + 2,
  JSON.stringify(bottomFit));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 面板停靠回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
