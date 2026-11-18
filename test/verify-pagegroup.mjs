// verify-pagegroup.mjs — 页面列表按类型分组 + 展开收起（js/editor/pagesPanel.js）
//   现场诉求："页面栏那边现在有三种格式，他们应该也可以展开和合并，画面的和画面在一起，
//             弹窗和弹窗在一起，方便观察。"
//   验：
//     ① 默认按类型分组：页面 / 弹窗 / 公共底 各一组，组表头带个数，同类排在一起（不再按建立顺序交叉）
//     ② 点组表头能收起/展开；收起状态记在本机（刷新后还在）
//     ③ 切到某一页时，它所在的那一组自动展开（收起状态下"切过去了但看不见自己"）
//     ④ 右上角小按钮可以切成平铺（按建立顺序），状态同样记住
//     ⑤ 行本身照旧：点击切页、双击改名、公共底行角标/垫标签都在；复制/删除走右键菜单
//        （行上不再摆任何按钮；**公共底右键也能复制此页**）
// 用法：node test/verify-pagegroup.mjs   （自己拉起独立数据目录的后端，不碰 8866 上那套）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-pagegroup-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { if ((await fetch(H + '/api/health')).ok) up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* 造数据：3 个页面 + 2 个弹窗 + 1 个公共底，而且**故意交叉着建**（页面/弹窗/页面/底/弹窗/页面） */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.newProject('blank');                       // 1 个空白页
  const first = project.pages()[0];
  project.updatePage(first.id, { name: '主页' });
  const out = { first: first.id };
  const pop1 = project.addPage('popup'); project.updatePage(pop1.id, { name: '报警详情' });
  const p2 = project.addPage('page'); project.updatePage(p2.id, { name: '参数设定' });
  const b = project.addPage('base'); project.updatePage(b.id, { name: '底1' });
  const pop2 = project.addPage('popup'); project.updatePage(pop2.id, { name: '断线快照' });
  const p3 = project.addPage('page'); project.updatePage(p3.id, { name: '轴监控' });
  project.setPageBase(p2.id, b.id);
  project.setCurrentPage(first.id);
  project.commit('分组测试');
  return { ...out, pop1: pop1.id, p2: p2.id, p3: p3.id, base: b.id, pop2: pop2.id };
});
await page.evaluate(() => { try { localStorage.removeItem('hmi-pages-fold-v1'); localStorage.removeItem('hmi-pages-group'); } catch { /* 忽略 */ } });
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.touch();     // 重新按默认状态画一遍
});
await sleep(400);
await page.evaluate(() => document.querySelector('#leftPanel .lp-tab[data-panel="pages"]')?.click());
await sleep(400);

const rows = () => page.evaluate(() => [...document.querySelectorAll('#pageList > *')].map(el => ({
  group: el.classList.contains('pg-group'),
  gtype: el.dataset.gtype || '',
  text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40),
  name: el.querySelector('.pg-name')?.textContent || '',
  badge: el.querySelector('.badge')?.textContent || '',
  base: el.classList.contains('pg-base'),
})));
const r0 = await rows();

/* ① 分组 */
ok('默认按类型分组：三个组表头（页面 / 弹窗 / 公共底）',
  r0.filter(r => r.group).map(r => r.gtype).join(',') === 'page,popup,base',
  JSON.stringify(r0.filter(r => r.group).map(r => r.text)));
const grp = (list, t) => list.find(r => r.group && r.gtype === t)?.text || '';
ok('组表头带个数（页面 3 个 / 弹窗 2 个 / 公共底 1 个）',
  /页面 3 个/.test(grp(r0, 'page')) && /弹窗 2 个/.test(grp(r0, 'popup')) && /公共底 1 个/.test(grp(r0, 'base')),
  JSON.stringify(r0.filter(r => r.group).map(r => r.text)));
const order = r0.filter(r => !r.group).map(r => r.name);
ok('同类的排在一起（页面：主页/参数设定/轴监控 → 弹窗：报警详情/断线快照 → 公共底：底1）',
  order.join('|') === '主页|参数设定|轴监控|报警详情|断线快照|底1', JSON.stringify(order));
ok('组里的页面行缩进一格（看得出属于上面那个组）',
  await page.evaluate(() => document.querySelector('#pageList .pg-item')?.classList.contains('pg-in')));
ok('行本身照旧：公共底行带「底」角标 / 套了底的页面挂「垫：」标签',
  r0.some(r => r.base && r.badge === '底')
  && await page.evaluate(() => [...document.querySelectorAll('#pageList .pg-basetag')].length) === 1);

/* 行里一个按钮都不摆（复制/删除/导出全走右键菜单）—— 现场要求 */
const rowBtns = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#pageList .pg-item')];
  const base = items.find(el => el.classList.contains('pg-base'));
  const normal = items.find(el => !el.classList.contains('pg-base'));
  return {
    delCount: document.querySelectorAll('#pageList .pg-del').length,
    dupCount: document.querySelectorAll('#pageList .pg-dup').length,
    baseHtml: (base?.innerHTML || '').length,
    nameTitle: normal?.querySelector('.pg-name')?.title || '',
  };
});
ok('页面行里没有 ✕ / ⧉ 按钮了（复制·删除·导出全在右键菜单里）',
  rowBtns.delCount === 0 && rowBtns.dupCount === 0, JSON.stringify(rowBtns));
ok('页面名悬停提示里写明"右键：复制 / 导出 / 删除"', /右键/.test(rowBtns.nameTitle), rowBtns.nameTitle);
// 右键里确实有复制和删除（行上按钮去掉后，这条路必须还在）
const pageMenu = await page.evaluate(async () => {
  const row = document.querySelector('#pageList .pg-item');
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 8, clientY: r.y + 8 }));
  await new Promise(r2 => setTimeout(r2, 250));
  const labels = [...document.querySelectorAll('#ctxMenu .ctx-item')].map(i => i.textContent.trim());
  document.getElementById('ctxMenu')?.classList.add('hidden');
  return labels;
});
ok('普通页右键里有「复制此页」「删除此页」',
  pageMenu.some(t => /复制此页/.test(t)) && pageMenu.some(t => /删除此页/.test(t)), JSON.stringify(pageMenu));
const baseMenu = await page.evaluate(async () => {
  const row = document.querySelector('#pageList .pg-item.pg-base');
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 8, clientY: r.y + 8 }));
  await new Promise(r2 => setTimeout(r2, 250));
  const labels = [...document.querySelectorAll('#ctxMenu .ctx-item')].map(i => i.textContent.trim());
  document.getElementById('ctxMenu')?.classList.add('hidden');
  return labels;
});
ok('**公共底右键也能复制此页**（现场要的：行上没按钮，但底也要能复制出「底2」），删除也在',
  baseMenu.some(t => /复制此页/.test(t)) && baseMenu.some(t => /删除这个公共底/.test(t)), JSON.stringify(baseMenu));

/* ② 收起 / 展开 + 记住 */
await page.click('#pageList .pg-group-page');
await sleep(300);
const r1 = await rows();
ok('点「页面」组表头 → 收起：那 3 行不显示了，表头还在',
  r1.filter(r => r.group).length === 3 && !r1.some(r => r.name === '主页')
  && /▸/.test(r1.find(r => r.gtype === 'page')?.text || ''),
  JSON.stringify(r1.filter(r => r.group).map(r => r.text)));
ok('收起时表头右边写出「当前：主页」（不然切过去了看不见自己在哪）',
  /当前：主页/.test(r1.find(r => r.gtype === 'page')?.text || ''),
  r1.find(r => r.gtype === 'page')?.text);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hmi-pages-fold-v1') || '{}'));
ok('收起状态记在本机（localStorage）', stored.page === true, JSON.stringify(stored));
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.evaluate(() => document.querySelector('#leftPanel .lp-tab[data-panel="pages"]')?.click());
await sleep(400);
const r2 = await rows();
ok('刷新后还是收起的样子', !r2.some(r => r.name === '主页') && /▸/.test(r2.find(r => r.gtype === 'page')?.text || ''),
  JSON.stringify(r2.filter(r => r.group).map(r => r.text)));

/* ③ 切页时自动展开它所在的那一组 */
await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  project.setCurrentPage(ids.p3);        // 轴监控（在收起的「页面」组里）
}, ids);
await sleep(400);
const r3 = await rows();
ok('切到收起的组里的某一页 → 那一组自动展开（能看见自己）',
  r3.some(r => r.name === '轴监控')
  && /▾/.test(r3.find(r => r.gtype === 'page')?.text || ''),
  JSON.stringify(r3.filter(r => r.group).map(r => r.text)));
ok('自动展开只影响当前页所在那一组（弹窗那组没被动）',
  r3.filter(r => !r.group).map(r => r.name).join('|') === '主页|参数设定|轴监控|报警详情|断线快照|底1',
  JSON.stringify(r3.filter(r => !r.group).map(r => r.name)));

/* ④ 平铺开关 */
await page.click('#btnPgGroup');
await sleep(350);
const r4 = await rows();
ok('点右上角小按钮 → 平铺（按建立顺序一列到底，没有组表头）',
  r4.every(r => !r.group) && r4.map(r => r.name).join('|') === '主页|报警详情|参数设定|底1|断线快照|轴监控',
  JSON.stringify(r4.map(r => r.name)));
ok('平铺状态也记住（localStorage）',
  await page.evaluate(() => localStorage.getItem('hmi-pages-group')) === '0');
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.evaluate(() => document.querySelector('#leftPanel .lp-tab[data-panel="pages"]')?.click());
await sleep(400);
ok('刷新后仍是平铺', (await rows()).every(r => !r.group));
await page.click('#btnPgGroup');       // 切回分组
await sleep(350);
ok('再点一下切回分组', (await rows()).filter(r => r.group).length === 3);

/* ⑤ 行操作照旧能用（复制改走**右键菜单**了；顺便守着"只复制一份"这条：
      上次对话框里填过份数 5，也不能影响"复制此页"—— 那是个把 {count:1, ...s} 写反顺序的老 bug） */
const acts = await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  try { localStorage.setItem('hmi-designer-pagedup-v1', JSON.stringify({ count: 5, seqStep: 1 })); } catch { /* 忽略 */ }
  const before = project.pages().length;
  const row = document.querySelector(`#pageList .pg-item[data-page-id="${ids.first}"]`);
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 8, clientY: r.y + 8 }));
  await new Promise(r2 => setTimeout(r2, 250));
  [...document.querySelectorAll('#ctxMenu .ctx-item')].find(i => /复制此页/.test(i.textContent))?.click();
  await new Promise(r2 => setTimeout(r2, 300));
  const afterDup = project.pages().length;
  document.querySelector(`#pageList .pg-item[data-page-id="${ids.pop1}"]`)?.click();
  await new Promise(r2 => setTimeout(r2, 250));
  return { before, afterDup, cur: project.currentId, pop1: ids.pop1 };
}, ids);
ok('右键「复制此页」照常好使，而且**只复制一份**（不受上次对话框份数影响）；点行照常切页',
  acts.afterDup === acts.before + 1 && acts.cur === acts.pop1, JSON.stringify(acts));

/* ⑥ 「＋ 新建 ▾」下拉：三个新建 + 复制/多重复制，全在一个菜单里（面板窄也不会挤出去） */
await page.click('#btnAddPage');
await sleep(250);
const menu = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')].map(i => i.textContent.trim()));
ok('「＋ 新建 ▾」下拉里有：新建页面 / 新建弹窗 / 新建公共底 / 复制这一页 / 多重复制页…',
  ['新建页面', '新建弹窗', '新建公共底'].every(t => menu.some(x => x.includes(t)))
  && menu.some(x => /复制这一页/.test(x)) && menu.some(x => /多重复制页/.test(x)),
  JSON.stringify(menu));
await page.evaluate(() => {
  [...document.querySelectorAll('#ctxMenu .ctx-item')].find(i => /新建弹窗/.test(i.textContent))?.click();
});
await sleep(350);
const afterMenu = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  return { popups: project.pages().filter(p => p.type === 'popup').length, cur: project.currentPage()?.type };
});
ok('菜单里点「新建弹窗」→ 真的建了一个弹窗并切过去',
  afterMenu.popups === 3 && afterMenu.cur === 'popup', JSON.stringify(afterMenu));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 页面列表分组 / 展开收起回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
