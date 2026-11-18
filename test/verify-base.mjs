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
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
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
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-base-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await installPageShim(page);
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
  // 新 UI：多层列表（每层一行 ✕）+「添加一层」下拉；单层时列表里就一行「底1」
  const rows = [...document.querySelectorAll('#propBody [data-baseremove]')];
  const sel = document.getElementById('ppBaseAdd');
  const text = document.getElementById('propBody').textContent.replace(/\s+/g, ' ');
  return {
    exists: !!sel, rows: rows.length, rowBaseId: rows[0]?.dataset.baseremove || '', text,
  };
}, ids);
ok('普通页属性面板有「公共底」多层列表（1 层，选中了底1）',
  pageProp.exists && pageProp.rows === 1 && pageProp.rowBaseId === ids.base && pageProp.text.includes('底1'),
  JSON.stringify(pageProp));

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

/* ═══════════ 4b. ★ 一个页面叠**多层**公共底（现场要求：至少能叠 6 层）═══════════
   每层各放一个绑变量的灯（z 都写得很大，验"层间 z 不混着比"），验：
   数据模型 / 层序 / 画布与运行态的 z 顺序 / 采集范围含所有层的变量 /
   存读往返 / 老工程（只有 baseId）迁移 / 删一层只掉一层 / 属性面板增删移。 */
const multi = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  const p2 = project.getPage(ids.p2);
  const made = [];
  for (let i = 1; i <= 6; i++) {
    const b = project.addPage('base');
    project.updatePage(b.id, { name: `多层底${i}` });
    const lamp = project.addWidget('lamp', 8 + i * 26, 10);
    project.updateWidgetField(lamp.id, 'w', 16);
    project.updateWidgetField(lamp.id, 'h', 16);
    project.updateWidgetField(lamp.id, 'z', 100 + i);          // 故意都很大：层之间靠"层基准"分开
    project.updateWidgetField(lamp.id, 'bindings.variable', `bLayer${i}`);
    made.push({ id: b.id, lamp: lamp.id, name: `多层底${i}` });
  }
  made.forEach((_, i) => project.data.variables.push(
    { name: `bLayer${i + 1}`, type: 'bool', address: `%MX1.${i}`, value: false }));
  project.setPageBases(p2.id, made.map(x => x.id));            // 6 层，按顺序从下到上
  project.setCurrentPage(p2.id);
  project.commit('多层公共底');
  return { made, p2: p2.id };
}, ids);
await sleep(350);

const mbModel = await page.evaluate(async (multi) => {
  const { project } = await import('/js/core/project.js');
  const p2 = project.getPage(multi.p2);
  const layers = project.pageLayers(p2);
  const maxLayerTop = Math.max(0, ...layers.bases.map((l, i) => l.off + 100 + i + 1));
  return {
    n: project.basesOf(p2).length,
    ids: project.basesOf(p2).map(b => b.id),
    want: multi.made.map(x => x.id),
    baseId: p2.baseId,
    baseIdsLen: (p2.baseIds || []).length,
    renderLen: project.renderWidgets(p2).length,
    ownLen: p2.widgets.length,
    layerCount: layers.bases.length,
    offs: layers.bases.map(l => l.off),
    pageOff: layers.off,
    maxLayerTop,
    usingCount: project.pagesUsingBase(multi.made[3].id).length,
  };
}, multi);
ok('★ 一个页面能叠 6 层公共底（数据模型）',
  mbModel.n === 6 && mbModel.ids.join() === mbModel.want.join(), JSON.stringify(mbModel.ids));
ok('★ baseId 同步成第一层、baseIds 记全 6 层（老版本读新工程还能显示第一层）',
  mbModel.baseId === mbModel.want[0] && mbModel.baseIdsLen === 6, JSON.stringify({ baseId: mbModel.baseId, n: mbModel.baseIdsLen }));
ok('renderWidgets = 6 层底控件 + 页面自己的控件',
  mbModel.renderLen === 6 + mbModel.ownLen, `${mbModel.renderLen} = 6 + ${mbModel.ownLen}`);
ok('pageLayers：6 层、每层 z 基准递增、页面那层压在所有层上面',
  mbModel.layerCount === 6 && mbModel.offs.every((v, i) => i === 0 || v > mbModel.offs[i - 1])
  && mbModel.pageOff >= mbModel.maxLayerTop,
  JSON.stringify({ offs: mbModel.offs, pageOff: mbModel.pageOff, maxLayerTop: mbModel.maxLayerTop }));
ok('pagesUsingBase 数得对（那一层被这一页套用）', mbModel.usingCount === 1, String(mbModel.usingCount));

/* 编辑画布：6 层都画出来、z 逐层变大、本页控件在所有层上面 */
const mbCanvas = await page.evaluate(({ ids, multi }) => {
  const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
  const lamps = multi.made.map(x => document.querySelector(`#canvas .wd[data-id="${x.lamp}"]`)).filter(Boolean);
  const own = document.querySelector(`#canvas .wd[data-id="${ids.own2}"]`);
  return {
    n: lamps.length,
    zs: lamps.map(z),
    ownZ: own ? z(own) : null,
    allBelowOwn: !!own && lamps.every(e => z(e) < z(own)),
  };
}, { ids, multi });
ok('编辑画布把 6 层底都画出来了', mbCanvas.n === 6, String(mbCanvas.n));
ok('编辑画布：层间 z 逐层变大（第 1 层最下），本页控件压在最上面',
  mbCanvas.allBelowOwn && mbCanvas.zs.every((v, i) => i === 0 || v > mbCanvas.zs[i - 1]),
  JSON.stringify(mbCanvas));

/* 运行态：6 层都画、层序对；采集范围包含所有层的变量 */
const mbRt = await page.evaluate(async ({ ids, multi }) => {
  const rt = await import('/js/runtime/runtime.js');
  if (!window.app.isRun?.()) await rt.enterRun();
  await new Promise(r => setTimeout(r, 350));
  const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
  const lamps = multi.made.map(x => document.querySelector(`#rtPage .wd[data-id="${x.lamp}"]`)).filter(Boolean);
  const own = document.querySelector(`#rtPage .wd[data-id="${ids.own2}"]`);
  const scope = new Set(rt.pageVarScope());
  return {
    n: lamps.length,
    zs: lamps.map(z),
    ownZ: own ? z(own) : null,
    allBelowOwn: !!own && lamps.every(e => z(e) < z(own)),
    scopeHasAll: multi.made.every((_, i) => scope.has(`bLayer${i + 1}`)),
    scopeSize: scope.size,
  };
}, { ids, multi });
ok('运行态把 6 层底都画出来了（层控件照常进渲染列表）', mbRt.n === 6, String(mbRt.n));
ok('运行态：层间 z 逐层变大、本页控件压在最上面',
  mbRt.allBelowOwn && mbRt.zs.every((v, i) => i === 0 || v > mbRt.zs[i - 1]), JSON.stringify(mbRt));
ok('★ 采集范围（pageVarScope）包含**所有层**公共底上的变量', mbRt.scopeHasAll, `scope ${mbRt.scopeSize} 个`);
await page.evaluate(async () => { (await import('/js/runtime/runtime.js')).exitRun(); });
await sleep(200);

/* 属性面板：6 层各一行（✕）+「添加一层」下拉；✕ 去掉一层、下拉叠回来、↑/↓ 换层序 */
const mbUi = await page.evaluate(async (multi) => {
  const { project } = await import('/js/core/project.js');
  project.setCurrentPage(multi.p2);
  await new Promise(r => setTimeout(r, 320));
  return {
    rows: document.querySelectorAll('#propBody [data-baseremove]').length,
    hasAdd: !!document.getElementById('ppBaseAdd'),
    pageTag: [...document.querySelectorAll('#pageList .pg-basetag')].map(x => x.textContent.trim()).join(' | '),
  };
}, multi);
ok('属性面板列出 6 层（每层一个 ✕）并且有「添加一层」下拉',
  mbUi.rows === 6 && mbUi.hasAdd, JSON.stringify({ rows: mbUi.rows, hasAdd: mbUi.hasAdd }));
ok('页面列表那条「垫：」标签把 6 层名字都写上',
  multi.made.every(x => mbUi.pageTag.includes(x.name)), mbUi.pageTag);

const mbOps = await page.evaluate(async (multi) => {
  const { project } = await import('/js/core/project.js');
  const wait = () => new Promise(r => setTimeout(r, 300));
  const order = () => project.basesOf(multi.p2).map(b => b.id).join();
  // 面板上真正画出来的层（DOM）—— 用它验"点完立刻刷新"，不能只看 project 数据
  const domRows = () => [...document.querySelectorAll('#propBody [data-baseremove]')].map(b => b.dataset.baseremove);
  const before = order();
  const rm = document.querySelectorAll('#propBody [data-baseremove]')[2];
  const removed = rm.dataset.baseremove;
  rm.click(); await wait();
  const afterRemove = order();
  const domAfterRemove = domRows();
  const sel = document.getElementById('ppBaseAdd');
  sel.value = removed;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait();
  const afterAdd = order();
  const domAfterAdd = domRows();
  const down = document.querySelector('#propBody [data-basemove="down"]');
  down.click(); await wait();
  const afterMove = order();
  const domAfterMove = domRows();
  return { before, afterRemove, afterAdd, afterMove, removed, domAfterRemove, domAfterAdd, domAfterMove };
}, multi);
ok('属性面板 ✕ 只去掉那一层（其余 5 层还在、顺序不变）',
  mbOps.afterRemove.split(',').length === 5
  && !mbOps.afterRemove.split(',').includes(mbOps.removed)
  && mbOps.afterRemove === mbOps.before.split(',').filter(x => x !== mbOps.removed).join(),
  JSON.stringify({ afterRemove: mbOps.afterRemove, removed: mbOps.removed }));
ok('属性面板下拉能再叠一层回来', mbOps.afterAdd.split(',').length === 6 && mbOps.afterAdd.includes(mbOps.removed),
  JSON.stringify(mbOps.afterAdd));
ok('属性面板 ↓ 能换层序（前两层互换、层数不变）',
  mbOps.afterMove.split(',').length === 6
  && mbOps.afterMove.split(',').slice(0, 2).join() === mbOps.afterAdd.split(',').slice(0, 2).reverse().join(),
  JSON.stringify({ add: mbOps.afterAdd, move: mbOps.afterMove }));

/* ★ 面板必须**当场刷新**：点完 ✕ / 添加 / ↑↓ 不用切页就能看见（现场反馈过"要重新进去才更新"） */
ok('★ 属性面板点完立刻刷新：✕ 之后 DOM 里只剩 5 行、被去掉那层不在',
  mbOps.domAfterRemove.length === 5 && !mbOps.domAfterRemove.includes(mbOps.removed),
  JSON.stringify({ dom: mbOps.domAfterRemove, removed: mbOps.removed }));
ok('★ 属性面板点完立刻刷新：添加之后 DOM 里就是 6 行',
  mbOps.domAfterAdd.length === 6 && mbOps.domAfterAdd.includes(mbOps.removed),
  JSON.stringify(mbOps.domAfterAdd));
ok('★ 属性面板点完立刻刷新：↓ 之后 DOM 的层序真的换了（不是等切页）',
  mbOps.domAfterMove.join() === mbOps.afterMove,
  JSON.stringify({ dom: mbOps.domAfterMove, model: mbOps.afterMove }));

/* 存读往返：6 层原样回来；老工程（只有 baseId）自动迁成 baseIds */
const mbRound = await page.evaluate(async (multi) => {
  const { project } = await import('/js/core/project.js');
  project.replaceData(JSON.parse(JSON.stringify(project.data)));
  const p2 = project.getPage(multi.p2);
  const order = project.basesOf(p2).map(b => b.id).join();
  return { n: project.basesOf(p2).length, order, baseId: p2.baseId, baseIdsLen: (p2.baseIds || []).length };
}, multi);
ok('存成 JSON 再读回来：6 层底、层序、baseId 全都原样',
  mbRound.n === 6 && mbRound.baseIdsLen === 6 && mbRound.baseId === mbRound.order.split(',')[0]
  && mbRound.order.split(',').length === 6, JSON.stringify(mbRound));

const legacy = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const data = JSON.parse(JSON.stringify(project.data));
  const anyPage = data.pages.find(p => p.type === 'page');
  const anyBase = data.pages.find(p => p.type === 'base');
  delete anyPage.baseIds;                       // 2.0.10 及更早的工程：只有 baseId
  anyPage.baseId = anyBase.id;
  project.replaceData(data);
  const p = project.getPage(anyPage.id);
  return { n: project.basesOf(p).length, baseIds: p.baseIds || [], baseId: p.baseId || '' };
});
ok('老工程（只有 baseId）载入后自动迁成 baseIds=[baseId]',
  legacy.n === 1 && legacy.baseIds.length === 1 && legacy.baseId === legacy.baseIds[0], JSON.stringify(legacy));

/* 删掉其中一层底：只掉那一层，其余层序不变 */
const mbDel = await page.evaluate(async (multi) => {
  const { project } = await import('/js/core/project.js');
  const before = project.basesOf(multi.p2).map(b => b.id);
  const victim = before[2];
  project.deletePage(victim);
  return { before, after: project.basesOf(multi.p2).map(b => b.id), gone: !project.getPage(victim) };
}, multi);
ok('删掉其中一层底：只掉那一层（其余层序不变，不留悬空 id）',
  mbDel.gone && mbDel.after.length === 5
  && mbDel.after.join() === mbDel.before.filter(x => x !== mbDel.before[2]).join(),
  JSON.stringify(mbDel));

/* 收尾：把这 6 层都删掉、变量也去掉 —— 后面的"悬空引用 / 全是底"用例按原状跑 */
const mbClean = await page.evaluate(async (multi) => {
  const { project } = await import('/js/core/project.js');
  multi.made.forEach(x => { if (project.getPage(x.id)) project.deletePage(x.id); });
  const names = new Set(multi.made.map((_, i) => `bLayer${i + 1}`));
  project.data.variables = project.data.variables.filter(v => !names.has(v.name));
  return { bases: project.bases().length, p2Bases: project.basesOf(multi.p2).length };
}, multi);
ok('收尾：叠加的 6 层都删掉了（回到只剩原来那个底）',
  mbClean.bases === 1 && mbClean.p2Bases === 0, JSON.stringify(mbClean));

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
