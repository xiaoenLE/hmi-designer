// verify-pageio.mjs — 单页导出 / 导入（把一页画面搬到别的工程）
//   现场诉求："还可以单独导出那个画和导入。"
//   验：
//     ① 导出负载里有什么：这一页的控件 + 它用到的变量 + 它套的公共底 + 跳转目标页名字
//     ② 导进**另一个工程**：新页面（新 id）、变量缺的补上、底一起带过来并套上、跳转按页名对上
//     ③ 页名重了自动加序号；同名变量保留现有的（地址不同只提醒，不静默改）
//     ④ 跳转目标在新工程里没有 → 清空并提示（不留指不到哪去的 id）
//     ⑤ 一步 Ctrl+Z 撤销；整份工程 JSON 也能当导入源（挑一页）
//     ⑥ 菜单入口：页面行右键 /「＋ 新建 ▾」里都有导出导入
// 用法：node test/verify-pageio.mjs   （自己拉起独立数据目录的后端，不碰 8866 上那套）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-pageio-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { if ((await fetch(H + '/')).ok) up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
const dialogs = [];
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ── 工程 A：一页「排线」+ 一页「主页」（跳转目标）+ 一个公共底，排线页套底、绑变量、带波形/动作 ── */
const src = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.newProject('blank');
  project.data.meta.name = '工程A';
  project.data.variables.push(
    { name: 'rPitch', type: 'real', address: '%MW100', value: 0.6, len: 0 },
    { name: 'bDir', type: 'bool', address: '%MX0.0', value: false, len: 0 },
    { name: 'rUnused', type: 'real', address: '%MW200', value: 0, len: 0 },      // 排线页不用它 → 不该被导出
    { name: 'nShift', type: 'uint', address: '', value: 0, len: 0, retain: true }, // 内部保持变量，底上用到
  );
  const home = project.pages().find(p => p.type === 'page');
  project.updatePage(home.id, { name: '主页' });
  const b = project.addPage('base'); project.updatePage(b.id, { name: '底1' });
  const navBtn = project.addWidget('button', 20, 540);
  project.updateWidgetProp(navBtn.id, 'text', '回主页');
  project.updateWidgetActions(navBtn.id, [{ trigger: 'click', type: 'gotoPage', params: { page: home.id } }]);
  const shiftLamp = project.addWidget('lamp', 900, 540);
  project.updateWidgetField(shiftLamp.id, 'bindings.variable', 'nShift');

  const line = project.addPage('page'); project.updatePage(line.id, { name: '排线' });
  project.setPageBase(line.id, b.id);
  const num = project.addWidget('number', 40, 40);
  project.updateWidgetField(num.id, 'bindings.variable', 'rPitch');
  const btn = project.addWidget('button', 40, 120);
  project.updateWidgetActions(btn.id, [
    { trigger: 'click', type: 'toggle', params: { variable: 'bDir' } },
    { trigger: 'click', type: 'gotoPage', params: { page: home.id } },
  ]);
  const trend = project.addWidget('trend', 300, 40);
  project.updateWidgetField(trend.id, 'bindings.variables', ['rPitch', 'bDir']);
  project.updateWidgetProp(trend.id, 'colors', { rPitch: '#ff0000' });
  project.commit('准备导出');
  project.setCurrentPage(line.id);
  return { line: line.id, home: home.id, base: b.id };
});
await sleep(400);

const payload = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  return project.pageExportPayload(ids.line);
}, src);
ok('导出负载带上了这一页（含控件）', payload?.page?.name === '排线' && payload.page.widgets.length === 3,
  JSON.stringify({ name: payload?.page?.name, n: payload?.page?.widgets?.length }));
const pv = (payload.variables || []).map(v => v.name).sort();
ok('导出负载带上了它用到的变量（含底上的），没用到的不带',
  pv.join(',') === 'bDir,nShift,rPitch', JSON.stringify(pv));
ok('导出负载带上了它套的公共底（bases 数组，可多层）',
  payload.bases?.length === 1 && payload.bases[0].name === '底1' && payload.bases[0].widgets.length === 2,
  JSON.stringify({ bases: (payload.bases || []).map(b => b.name), n: payload.bases?.[0]?.widgets?.length }));
ok('导出负载记了跳转目标页的名字（导进别的工程时按名字重新对上）',
  Object.values(payload.pageRefs || {}).some(r => r.name === '主页'), JSON.stringify(payload.pageRefs));
ok('内部掉电保持变量一起带走（retain 标记还在）',
  payload.variables.find(v => v.name === 'nShift')?.retain === true);

/* ── 导进「另一个工程」（清空重建，模拟换了一台机器/另一个项目） ──
   走**真界面那条路**：造一个 File 喂给 pageIO.importPageFile（解析 + 导入 + 切页 + 弹报告一条龙） */
const imported = await page.evaluate(async (payload) => {
  const { project } = await import('/js/core/project.js');
  const m = await import('/js/editor/pageIO.js');
  project.newProject('blank');                     // 空白工程：只有 1 页
  project.data.meta.name = '工程B';
  // 这一页改名叫「主页」→ 导进来的「跳转页面 → 主页」应该按**名字**重新对上它
  const homeB = project.pages()[0].id;
  project.updatePage(homeB, { name: '主页' });
  project.data.variables.push({ name: 'rPitch', type: 'real', address: '%MW900', value: 9, len: 0 });  // 同名不同地址
  const before = { pages: project.pages().length, vars: project.variables().length };
  const file = new File([JSON.stringify(payload, null, 2)], '工程A-排线.page.json', { type: 'application/json' });
  await m.importPageFile(file);
  const cur = project.currentPage();               // 导入后应该自动切到新页
  const base = project.baseOf(cur);
  const num = cur.widgets?.find(w => w.type === 'number');
  const btn = cur.widgets?.find(w => w.type === 'button');
  const trend = cur.widgets?.find(w => w.type === 'trend');
  return {
    before, homeB,
    pages: project.pages().length, vars: project.variables().length,
    curName: cur?.name || '', widgets: cur?.widgets?.length || 0,
    baseName: base?.name || '', baseWidgets: base?.widgets.length || 0,
    numVar: num?.bindings.variable, ch: trend?.bindings.variables?.[0],
    btnActionVars: (btn?.actions || []).map(a => a.params.variable || a.params.page || ''),
    pitchAddr: project.variables().find(v => v.name === 'rPitch')?.address,
    shiftRetain: project.variables().find(v => v.name === 'nShift')?.retain === true,
    hasUnused: project.variables().some(v => v.name === 'rUnused'),
    idsOk: (cur?.widgets || []).every(w => w.id && !payload.page.widgets.some(x => x.id === w.id)),
    onCanvasNow: project.currentPage()?.name === '排线',
  };
}, payload);
ok('导入后多了「排线」这一页 + 一并建的底（新 id，控件 id 全换过）',
  imported.pages === imported.before.pages + 2 && imported.curName === '排线' && imported.idsOk,
  JSON.stringify({ pages: imported.pages, before: imported.before.pages, name: imported.curName }));
ok('导进来的页面控件一个不少，绑定还在',
  imported.widgets === 3 && imported.numVar === 'rPitch' && imported.ch === 'rPitch',
  JSON.stringify({ widgets: imported.widgets, numVar: imported.numVar, ch: imported.ch }));
ok('公共底一起带过来了，并且这一页**套上了**它',
  imported.baseName === '底1' && imported.baseWidgets === 2, JSON.stringify({ baseName: imported.baseName, baseWidgets: imported.baseWidgets }));
ok('变量：缺的补上（bDir/nShift）、没用到的不带（rUnused 不进表）',
  imported.vars === imported.before.vars + 2 && imported.hasUnused === false,
  JSON.stringify({ vars: imported.vars, before: imported.before.vars }));
ok('同名变量（rPitch）保留**工程里现有的**地址（%MW900），并在报告里提醒地址不一样',
  imported.pitchAddr === '%MW900'
  && dialogs.some(m => /已导入「排线」/.test(m) && /地址和导出文件里不一样/.test(m)),
  JSON.stringify({ addr: imported.pitchAddr }));
ok('内部掉电保持变量导进来还是"保持"的', imported.shiftRetain === true);
ok('跳转目标「主页」在新工程里按**名字**重新对上（指到新工程那一页的 id）',
  imported.btnActionVars.includes(imported.homeB),
  JSON.stringify({ actions: imported.btnActionVars, homeB: imported.homeB }));
ok('导入后自动切到新页面那页', imported.onCanvasNow === true);
ok('导出/导入的提示说清了建了哪一页、补了哪些变量',
  dialogs.some(m => /已导入「排线」/.test(m) && /变量表新增/.test(m)), JSON.stringify(dialogs.slice(-2)));

/* 跳转目标在新工程里没有 → 清空 + 提示 */
const unlinked = await page.evaluate(async (payload) => {
  const { project } = await import('/js/core/project.js');
  project.newProject('blank');                       // 这个工程里没有「主页」
  const r = project.importPage(payload);
  const cur = project.getPage(r.pageId);
  const btn = cur.widgets.find(w => w.type === 'button');
  return { r, actions: btn.actions.map(a => a.params.page || ''), unlinked: r.unlinked };
}, payload);
ok('新工程里没有「主页」→ 那个跳转动作被清空，并在报告里点名',
  unlinked.actions.every(x => x === '') && unlinked.unlinked.length === 1 && /主页/.test(unlinked.unlinked[0]),
  JSON.stringify(unlinked));

/* 页名重了自动加序号 + 一步撤销 */
const dup = await page.evaluate(async (payload) => {
  const { project } = await import('/js/core/project.js');
  project.newProject('blank');
  const a = project.importPage(payload);
  const b = project.importPage(payload);
  return { a: a.pageName, b: b.pageName, pages: project.pages().length };
}, payload);
ok('连着导两次：第二个自动叫「排线2」（不重名）', dup.a === '排线' && dup.b === '排线2', JSON.stringify(dup));
await page.evaluate(() => document.getElementById('dlgMask')?.classList.add('hidden'));
await page.click('#btnUndo');
await sleep(400);
const undone = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  return { pages: project.pages().length, names: project.pages().map(p => p.name) };
});
ok('一步 Ctrl+Z：第二次导入整份回退（页面、变量、底一起）',
  undone.names.filter(n => n === '排线2').length === 0 && undone.pages === dup.pages - 1,
  JSON.stringify(undone));

/* 整份工程 JSON 也能当导入源（挑一页） */
const fromProject = await page.evaluate(async (payload) => {
  const { project } = await import('/js/core/project.js');
  const whole = project.pageExportPayload;      // 借它的类型判断：这里造一份"整份工程"
  const data = { meta: { name: '别人的工程' }, canvas: { w: 1024, h: 600, bg: '#fff' }, variables: payload.variables,
    pages: [{ id: 'pg_x', name: '排线', type: 'page', widgets: payload.page.widgets }] };
  project.newProject('blank');
  const r = project.importPage(data, { pageRef: '排线' });
  return { ok: r.ok, name: r.pageName, widgets: project.getPage(r.pageId)?.widgets.length };
}, payload);
ok('整份工程 JSON 也能导（按页名/序号挑一页）',
  fromProject.ok && fromProject.name === '排线' && fromProject.widgets === 3, JSON.stringify(fromProject));

/* 菜单入口 */
const menus = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.setCurrentPage(project.pages().find(p => p.type === 'page').id);
  await new Promise(r => setTimeout(r, 250));
  document.querySelector('#leftPanel .lp-tab[data-panel="pages"]')?.click();
  await new Promise(r => setTimeout(r, 300));
  // ① 页面行右键
  const row = document.querySelector('#pageList .pg-item');
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 8, clientY: r.y + 8 }));
  await new Promise(r2 => setTimeout(r2, 250));
  const rowMenu = [...document.querySelectorAll('#ctxMenu .ctx-item')].map(i => i.textContent.trim());
  document.getElementById('ctxMenu')?.classList.add('hidden');
  // ② ＋ 新建 ▾
  document.getElementById('btnAddPage').click();
  await new Promise(r2 => setTimeout(r2, 250));
  const newMenu = [...document.querySelectorAll('#ctxMenu .ctx-item')].map(i => i.textContent.trim());
  document.getElementById('ctxMenu')?.classList.add('hidden');
  return { rowMenu, newMenu, hasFileInput: !!document.getElementById('pageImportFile') };
});
ok('页面行右键有「导出这一页…」和「导入页面…」',
  menus.rowMenu.some(t => /导出这一页/.test(t)) && menus.rowMenu.some(t => /导入页面/.test(t)),
  JSON.stringify(menus.rowMenu));
ok('「＋ 新建 ▾」里也有导入 / 导出页面', menus.newMenu.some(t => /导入页面/.test(t)) && menus.newMenu.some(t => /导出这一页/.test(t)),
  JSON.stringify(menus.newMenu));
ok('隐藏的文件选择框在（导入走它）', menus.hasFileInput);

/* 真走一遍"导出一个文件、再导回来"（点菜单会触发下载） */
// ⚠ 浏览器里点导出默认弹系统「另存为」框（js/core/csv.js 的 saveTextFile → showSaveFilePicker）；
//   无头 Chromium 里那个框弹不出来、调用会**当场以 AbortError 结束**（跟"用户点了取消"分不开）——
//   这一节验的是"载荷 + 状态栏"，所以先把保存框接口摘掉，让它走下载那条路
//   （弹框那条路在 verify-export-file.mjs 里用假 handle 验）
await page.evaluate(() => { delete window.showSaveFilePicker; });
const dl = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const m = await import('/js/editor/pageIO.js');
  const p = project.pages().find(x => x.type === 'page');
  const payload = m.exportPage(p.id);
  // ⚠ 导出现在是**异步**的：桌面窗口里会弹「另存为」（见 js/core/csv.js 的 saveTextFile），
  //   状态栏那句要等保存框有结果才写 —— 所以这里要等它出现，别当场读（会读到空串）
  const el = document.getElementById('stNote');
  let note = '';
  for (let i = 0; i < 40; i++) {
    note = el.textContent || '';
    if (/已导出/.test(note)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  return { ok: !!payload, name: payload?.page?.name, note };
});
ok('导出函数跑通（浏览器里会落一个 .page.json 文件）', dl.ok && /已导出/.test(dl.note || ''), JSON.stringify(dl));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 单页导出 / 导入回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
