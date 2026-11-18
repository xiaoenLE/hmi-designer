// verify-base.mjs — **公共底**（页面 type:'base'）：写一次，多页共用的那一层
//   现场诉求：「现在有弹窗和页面，我还需要一点底的 —— 页面那边能调用，公共底，相同的只写一次」。
//   口径（跟实现一一对应）：
//     · 底 = 一个页面对象（type:'base'），普通页用 baseId 指它；弹窗不套底
//     · 渲染顺序 = 底控件在前（下面那层），页面自己的控件在后（盖在上面）；
//       **两层 z 不混着比**：底那一层整体偏移，作者给底写的 z 再大也压不住页面内容
//     · 底上的控件：运行态照常能点/能亮/能显示变量；在**别的页面**上编辑时点不动、双击跳过去改
//     · 画布/清单/属性面板/存读往返/删底清引用 都要跟着对
// 用法：node test/verify-base.mjs   （自己拉起一个独立数据目录的后端，不碰 8866 上那套）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-base-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ── 造数据：一个公共底（底图 rect z=999 / 底部按钮 z=1000 / 指示灯 z=1001）
      套到两个普通页上；两页各自再放一个自己的控件（z=1，故意很小） ── */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.data.variables.push({ name: 'bBaseLamp', type: 'bool', address: '%MX0.7', value: false });
  const normals = project.pages().filter(p => p.type === 'page');
  const p1 = normals[0], p2 = normals[1];
  if (!p1 || !p2) throw new Error('演示工程里没有两个普通页');

  const b = project.addPage('base');
  project.updatePage(b.id, { name: '底1' });
  const bg = project.addWidget('rect', 0, 0);
  project.updateWidgetField(bg.id, 'w', 1024);
  project.updateWidgetField(bg.id, 'h', 600);
  project.updateWidgetProp(bg.id, 'bgColor', '#ffffff');
  project.updateWidgetField(bg.id, 'z', 999);          // 故意给很大的 z（见下面"两层 z 不混着比"）

  const btn = project.addWidget('button', 20, 548);
  project.updateWidgetField(btn.id, 'w', 140);
  project.updateWidgetField(btn.id, 'h', 46);
  project.updateWidgetProp(btn.id, 'text', '去第二页');
  project.updateWidgetField(btn.id, 'z', 1000);
  project.updateWidgetActions(btn.id, [{ trigger: 'click', type: 'gotoPage', params: { page: p2.id } }]);

  const lamp = project.addWidget('lamp', 950, 548);
  project.updateWidgetField(lamp.id, 'z', 1001);
  project.updateWidgetField(lamp.id, 'bindings.variable', 'bBaseLamp');

  project.setPageBase(p1.id, b.id);
  project.setPageBase(p2.id, b.id);

  project.setCurrentPage(p1.id);
  const own1 = project.addWidget('label', 40, 100);
  project.updateWidgetProp(own1.id, 'text', '第一页自己的控件');
  project.updateWidgetField(own1.id, 'z', 1);
  project.setCurrentPage(p2.id);
  const own2 = project.addWidget('label', 40, 100);
  project.updateWidgetProp(own2.id, 'text', '第二页自己的控件');
  project.updateWidgetField(own2.id, 'z', 1);

  project.setCurrentPage(p1.id);
  project.commit('公共底测试');
  return { base: b.id, p1: p1.id, p2: p2.id, own1: own1.id, own2: own2.id, btn: btn.id, lamp: lamp.id, bg: bg.id };
});
await sleep(350);

/* ═══════════ 1. 数据模型 ═══════════ */
const model = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  const b = project.getPage(ids.base);
  return {
    isBase: b?.type === 'base',
    baseCount: project.bases().length,
    p1Base: project.baseOf(ids.p1)?.id || '',
    p2Base: project.baseOf(ids.p2)?.id || '',
    renderLen: project.renderWidgets(ids.p1).length,
    ownLen: project.getPage(ids.p1).widgets.length,
    layers: project.pageLayers(ids.p1),
    usingCount: project.pagesUsingBase(ids.base).length,
  };
}, ids);
ok('公共底建出来了（type=base，能被找到）', model.isBase && model.baseCount === 1);
ok('两个普通页都指向这个底（baseId）', model.p1Base === ids.base && model.p2Base === ids.base);
ok('renderWidgets = 底控件 + 页面自己的控件（渲染口径）',
  model.renderLen === 3 + model.ownLen, `${model.renderLen} = 3 + ${model.ownLen}`);
ok('pageLayers 给的 z 偏移 > 底上最大 z（保证底那一层整体在下面）',
  model.layers.base?.id === ids.base && model.layers.off > 1001, JSON.stringify(model.layers.off));
ok('pagesUsingBase 数得对（2 页套用）', model.usingCount === 2, String(model.usingCount));

/* ═══════════ 2. 编辑器：页面列表 / 画布分层 ═══════════ */
const panel = await page.evaluate(() => ({
  baseRows: [...document.querySelectorAll('#pageList .pg-item.pg-base')].map(x => x.querySelector('.badge')?.textContent),
  baseTags: [...document.querySelectorAll('#pageList .pg-basetag')].map(x => x.textContent.trim()),
}));
ok('页面列表里有一行「底」角标（紫色徽章）', panel.baseRows.length === 1 && panel.baseRows[0] === '底',
  JSON.stringify(panel.baseRows));
ok('普通页那两行标出「垫：底1」', panel.baseTags.length === 2 && panel.baseTags.every(t => t.includes('底1')),
  JSON.stringify(panel.baseTags));

const canvas = await page.evaluate((ids) => {
  const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
  const baseEls = [...document.querySelectorAll('#canvas .wd-base')];
  const ownEl = document.querySelector(`#canvas .wd[data-id="${ids.own1}"]`);
  return {
    baseEls: baseEls.length,
    baseIds: baseEls.map(e => e.dataset.id).sort(),
    maxBaseZ: Math.max(0, ...baseEls.map(z)),
    ownZ: ownEl ? z(ownEl) : null,
    allBaseAboveOwn: !!ownEl && baseEls.every(e => z(e) < z(ownEl)),
  };
}, ids);
ok('编辑画布上把底那一层也画出来了（3 个）', canvas.baseEls === 3, String(canvas.baseEls));
ok('底那一层整体压在页面控件下面（底上 z 写到 1001 也压不住 z=1 的本页控件）',
  canvas.allBaseAboveOwn && canvas.maxBaseZ < canvas.ownZ,
  `base maxZ=${canvas.maxBaseZ} ownZ=${canvas.ownZ}`);

/* 点底上的控件：不选中 + 状态栏提示；双击：跳到公共底页
   ⚠ 先 scrollIntoView 再量坐标：画布视口会被停靠的面板压短（内置模板自带底部面板 +
     一组 1024×600 的画面，底上那个按钮正好在画面下沿），不滚进来的话点在面板上，
      后面那几条断言就会莫名其妙地"看得见却点不着"。 */
const center = (sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const vp = document.getElementById('canvasWrap').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2,
    inView: r.left >= vp.left - 1 && r.top >= vp.top - 1 && r.right <= vp.right + 1 && r.bottom <= vp.bottom + 1 };
}, sel);
const btnPt = await center(`#canvas .wd[data-id="${ids.btn}"]`);
ok('底上的按钮在画布上找得到（能点）', !!btnPt, JSON.stringify(btnPt));
ok('（前提）点之前控件真在画布可视区里', btnPt?.inView === true, JSON.stringify(btnPt));
await page.mouse.click(btnPt.x, btnPt.y);
await sleep(150);
const afterClick = await page.evaluate(async () => ({
  sel: document.getElementById('stSel').textContent,
  note: document.getElementById('stNote').textContent,
  cur: (await import('/js/core/project.js')).project.currentId,
}));
ok('点底上的控件：**选不中**（不会误改影响所有页面）', afterClick.sel === '未选中', afterClick.sel);
ok('点底上的控件：状态栏提示这是公共底上的', afterClick.note.includes('公共底'), afterClick.note);
ok('单击不会换页', afterClick.cur === ids.p1);

await page.mouse.dblclick(btnPt.x, btnPt.y);
await sleep(250);
const afterDbl = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  return { cur: project.currentId, title: document.getElementById('pageTitle').textContent,
    badge: document.getElementById('pageTypeBadge').textContent };
});
ok('双击底上的控件 → 跳到公共底页去编辑', afterDbl.cur === ids.base, JSON.stringify(afterDbl));
ok('顶栏角标显示「公共底」', afterDbl.badge === '公共底', afterDbl.badge);
const baseCanvas = await page.evaluate(() => ({
  normal: document.querySelectorAll('#canvas .wd-base').length,
  all: document.querySelectorAll('#canvas .wd').length,
}));
ok('在底页上：那 3 个控件是**正常的（可编辑）控件**，不再标成底那一层',
  baseCanvas.normal === 0 && baseCanvas.all === 3, JSON.stringify(baseCanvas));

/* 底页属性面板：被几页套用 */
const baseProp = await page.evaluate(() => document.getElementById('propBody').textContent.replace(/\s+/g, ' '));
ok('底页属性面板显示「被 2 个页面套用」', /被\s*2\s*个页面套用/.test(baseProp), baseProp.slice(0, 120));

/* 回到普通页：属性面板的「套用公共底」下拉 */
await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  project.setCurrentPage(ids.p1);
}, ids);
await sleep(250);
const pageProp = await page.evaluate((ids) => {
  const sel = document.getElementById('ppBase');
  return { exists: !!sel, value: sel?.value || '', text: sel?.selectedOptions?.[0]?.textContent || '' };
}, ids);
ok('普通页属性面板有「套用公共底」下拉，且选中了底1',
  pageProp.exists && pageProp.value === ids.base && pageProp.text.includes('底1'), JSON.stringify(pageProp));

/* 换成"不套用" → 画布上底那一层消失；再套回来 */
const detach = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  project.setPageBase(ids.p1, '');
  await new Promise(r => setTimeout(r, 120));
  return {
    baseId: project.getPage(ids.p1).baseId || '',
    baseEls: document.querySelectorAll('#canvas .wd-base').length,
    all: document.querySelectorAll('#canvas .wd').length,
    ownLen: project.getPage(ids.p1).widgets.length,
  };
}, ids);
ok('取消套用 → 画布上底那一层没了（本页控件一个不少）',
  detach.baseId === '' && detach.baseEls === 0 && detach.all === detach.ownLen, JSON.stringify(detach));
await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  project.setPageBase(ids.p1, ids.base);
}, ids);
await sleep(250);
ok('再套回来 → 底那一层又回来了',
  (await page.evaluate(() => document.querySelectorAll('#canvas .wd-base').length)) === 3);

/* 控件清单：底那层的控件也列出来，带「底」标记 */
const listPanel = await page.evaluate((ids) => {
  const rows = [...document.querySelectorAll('#widgetList .wl-item')];
  const baseRows = rows.filter(r => r.classList.contains('wl-base'));
  return {
    total: rows.length,
    baseRows: baseRows.length,
    tag: baseRows[0]?.querySelector('.wl-basetag')?.textContent || '',
    hasOwn: rows.some(r => r.dataset.id === ids.own1 && !r.classList.contains('wl-base')),
  };
}, ids);
ok('控件清单把底那一层也列出来（带「底」标记，共 3 行）',
  listPanel.baseRows === 3 && listPanel.tag === '底' && listPanel.hasOwn, JSON.stringify(listPanel));

/* ═══════════ 3. 运行态 ═══════════ */
const rt = await page.evaluate(async (ids) => {
  const runtime = await import('/js/runtime/runtime.js');
  if (!window.app.isRun?.()) await runtime.enterRun();
  await new Promise(r => setTimeout(r, 250));
  const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
  const baseEls = [ids.bg, ids.btn, ids.lamp].map(id => document.querySelector(`#rtPage .wd[data-id="${id}"]`)).filter(Boolean);
  const ownEl = document.querySelector(`#rtPage .wd[data-id="${ids.own1}"]`);
  return {
    baseCount: baseEls.length,
    ownThere: !!ownEl,
    allBaseBelow: !!ownEl && baseEls.every(e => z(e) < z(ownEl)),
    baseOnly1: !document.querySelector(`#rtPage .wd[data-id="${ids.own2}"]`),
  };
}, ids);
ok('运行态：底那一层画出来了（3 个控件都在画面上）', rt.baseCount === 3, String(rt.baseCount));
ok('运行态：底在页面控件下面（z 顺序和编辑态一致）', rt.allBaseBelow);
ok('运行态：只画当前页（第二页自己的控件不在）', rt.baseOnly1);

/* 底上的控件绑变量照样刷新（说明它进了 boundIndex） */
const lampBefore = await page.evaluate((ids) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${ids.lamp}"] .w-lamp`);
  return el ? getComputedStyle(el).backgroundColor : '';
}, ids);
await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('bBaseLamp', true);
});
await sleep(200);
const lampAfter = await page.evaluate((ids) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${ids.lamp}"] .w-lamp`);
  return el ? getComputedStyle(el).backgroundColor : '';
}, ids);
ok('底上的指示灯跟着变量变（底控件也进了"变量→控件"索引）',
  lampBefore !== lampAfter && lampAfter === 'rgb(34, 197, 94)', `${lampBefore} → ${lampAfter}`);

/* 底上的按钮能点（公共导航条）：点一下跳第二页 */
const rtBtnPt = await center(`#rtPage .wd[data-id="${ids.btn}"]`);
await page.mouse.click(rtBtnPt.x, rtBtnPt.y);
await sleep(300);
const jumped = await page.evaluate((ids) => ({
  own2There: !!document.querySelector(`#rtPage .wd[data-id="${ids.own2}"]`),
  own1There: !!document.querySelector(`#rtPage .wd[data-id="${ids.own1}"]`),
  baseThere: !!document.querySelector(`#rtPage .wd[data-id="${ids.btn}"]`),
}), ids);
ok('底上的按钮在运行态点得动：跳到第二页，且底照旧跟着走',
  jumped.own2There && !jumped.own1There && jumped.baseThere, JSON.stringify(jumped));

/* 公共底不是"能进的画面"：脚本/动作拿它跳页要被挡住 */
const navGuard = await page.evaluate(async (ids) => {
  const runtime = await import('/js/runtime/runtime.js');
  const r1 = runtime.gotoPage('底1');          // 按名字
  const r2 = runtime.gotoPage(ids.base);       // 按 id
  await new Promise(r => setTimeout(r, 120));
  return { r1, r2, own2There: !!document.querySelector(`#rtPage .wd[data-id="${ids.own2}"]`) };
}, ids);
ok('gotoPage 到底页无效（返回 false，画面不动）',
  navGuard.r1 === false && navGuard.r2 === false && navGuard.own2There, JSON.stringify(navGuard));

await page.evaluate(async () => { (await import('/js/runtime/runtime.js')).exitRun(); });
await sleep(200);

/* ═══════════ 4. 存读往返 / 删底清引用 / 容错 ═══════════ */
const roundTrip = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  const json = JSON.parse(JSON.stringify(project.data));   // 存文件 / 存服务器 / 导出都走这条
  project.replaceData(json);                               // 打开 / 读回来
  const b = project.getPage(ids.base);
  return {
    isBase: b?.type === 'base',
    stillUses: project.baseOf(ids.p1)?.id === ids.base && project.baseOf(ids.p2)?.id === ids.base,
    widgetCount: b?.widgets.length,
  };
}, ids);
ok('存成 JSON 再读回来：底还是底、页面还套着它（不会被拍平成普通页）',
  roundTrip.isBase && roundTrip.stillUses && roundTrip.widgetCount === 3, JSON.stringify(roundTrip));

const dangling = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  const data = JSON.parse(JSON.stringify(project.data));
  data.pages = data.pages.filter(p => p.id !== ids.base);       // 底没了，但页面还写着 baseId
  data.pages.find(p => p.id === ids.p1).baseId = 'pg_not_exist';
  project.replaceData(data);
  return { left: project.getPage(ids.p1).baseId || '', baseCount: project.bases().length };
}, ids);
ok('悬空引用（底被删了）自动清掉 → 当"不套底"，不报错', dangling.left === '' && dangling.baseCount === 0,
  JSON.stringify(dangling));

const delClean = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  const data = JSON.parse(JSON.stringify(project.data));
  // 重新搭一遍：把底找回来（用刚才那份被清过的数据已经没底了）
  project.replaceData(data);
  const b = project.addPage('base');
  project.updatePage(b.id, { name: '底临时' });
  project.setCurrentPage(ids.p1);
  project.setPageBase(ids.p1, b.id);
  project.deletePage(b.id);                                    // 删底
  return {
    hasBase: !!project.getPage(b.id),
    pageBaseId: project.getPage(ids.p1).baseId || '',
    pagesOk: project.pages().filter(p => p.type === 'page').length > 0,
  };
}, ids);
ok('删公共底：套用它那些页面自动回到「不套底」（不留悬空 id）',
  !delClean.hasBase && delClean.pageBaseId === '' && delClean.pagesOk, JSON.stringify(delClean));

const baseOnly = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const data = JSON.parse(JSON.stringify(project.data));
  data.pages = data.pages.filter(p => p.type !== 'page');      // 只剩底（没人套用）
  data.pages[0].type = 'base';
  project.replaceData(data);
  return { normal: project.pages().filter(p => p.type === 'page').length };
});
ok('一个普通页都没有时（全是底）自动补一个普通页（运行态要有地方落）',
  baseOnly.normal >= 1, String(baseOnly.normal));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 公共底（写一次多页共用）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
