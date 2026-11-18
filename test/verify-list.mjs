// verify-list.mjs — 控件清单（对象导航）的显示口径
//   ① 类型徽章按"家族"配色：操作/数值/文本表格/报警/波形/图形 一眼分得清，同类型同色
//   ② 配置那一列：Modbus/TCP → 「变量名 @%MW100」（短地址是现场查点位要用的）；
//      OPC UA / NodeId 式长地址 → **只显示变量名**（NodeId 跟变量名基本重复，还长到塞不下）
//   ③ 「隐藏名称」开关：清单只留 类型 + 配置（自动名如"数值4"是噪音），选择要记住；悬停仍能看到名字
//   ④ 「底」开关：页面套的公共底那一层的控件可以收起来（只看本页自己的控件），选择也记住
// 用法：node test/verify-list.mjs   （自己拉起一个独立数据目录的后端，不碰 8866 上那套）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-list-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
// 清单面板要**切到前台**（标签页是 pointerdown 切换的，evaluate 里 .click() 不管用）
await page.click('.lp-tab[data-tab="list"]');
await sleep(250);

/* ── 准备：三个变量（Modbus 短地址 / NodeId 长地址）+ 若干类型的控件 ── */
const ids = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'rSpd', type: 'real', address: '%MW100', value: 0, len: 0 });
  m.data.variables.push({ name: 'bRun', type: 'bool', address: '%MX0.0', value: false, len: 0 });
  m.data.variables.push({
    name: 'GVL.中1[1]', type: 'int', value: 0, len: 0,
    address: 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.中1[1]',
  });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const mk = (type, name, variable) => {
    const w = m.addWidget(type, 40, 40);
    w.name = name;
    if (variable) w.bindings.variable = variable;
    return w.id;
  };
  const out = {
    btn: mk('button', '启动按钮', 'bRun'),
    num: mk('number', '转速显示', 'rSpd'),
    val: mk('value', '中文变量显示', 'GVL.中1[1]'),
    lab: mk('label', '标题文字', ''),
    trend: mk('trend', '温度曲线', ''),
    clock: mk('clock', '班次时钟', ''),
    btn2: mk('button', '停止按钮', 'bRun'),
  };
  m.commit('清单测试');
  return out;
});
await sleep(400);

/** 读某一行的徽章底色、配置文本、名称可见性 */
const rowOf = (id) => page.evaluate((id) => {
  const r = document.querySelector(`#widgetList .wl-item[data-id="${id}"]`);
  if (!r) return null;
  const badge = r.querySelector('.badge');
  const nameEl = r.querySelector('.wl-name');
  return {
    badgeText: badge?.textContent || '',
    badgeBg: badge ? getComputedStyle(badge).backgroundColor : '',
    badgeCls: badge?.className || '',
    name: nameEl?.textContent || '',
    nameShown: nameEl ? getComputedStyle(nameEl).display !== 'none' : false,
    info: r.querySelector('.wl-info')?.textContent || '',
    title: r.title,
  };
}, id);

/* ── 1. 类型徽章按家族配色 ── */
const rows = {};
for (const [k, id] of Object.entries(ids)) rows[k] = await rowOf(id);
const bgOf = (k) => rows[k]?.badgeBg;
ok('清单里每行都有类型徽章', !!rows.btn?.badgeText && !!rows.num?.badgeText,
  JSON.stringify([rows.btn?.badgeText, rows.num?.badgeText]));
ok('不同类型 = 不同颜色（按钮/数值/文本/波形/时钟 底色两两不同）',
  new Set([bgOf('btn'), bgOf('num'), bgOf('lab'), bgOf('trend'), bgOf('clock')]).size === 5,
  JSON.stringify([bgOf('btn'), bgOf('num'), bgOf('lab'), bgOf('trend'), bgOf('clock')]));
ok('同类型同色（两个按钮底色一致）', bgOf('btn') === bgOf('btn2'),
  JSON.stringify([bgOf('btn'), bgOf('btn2')]));
ok('配色是按家族给的类名（badge t-xxx，不是内联色）',
  /badge t-/.test(rows.btn?.badgeCls || ''), rows.btn?.badgeCls);

/* ── 2. 配置列：短地址显示、长 NodeId 不显示 ── */
ok('Modbus 短地址照旧显示：变量名 @%MW100', rows.num?.info === 'rSpd @%MW100', rows.num?.info);
ok('NodeId 式长地址**不显示**（只留变量名）', rows.val?.info === 'GVL.中1[1]', rows.val?.info);
ok('短地址的 bool 位地址也显示（%MX0.0）', rows.btn?.info === 'bRun @%MX0.0', rows.btn?.info);
ok('不显示地址时信息不丢：悬停提示里仍有名称', /转速显示/.test(rows.num?.title || '')
  && /启动按钮/.test(rows.btn?.title || ''), rows.num?.title?.split('\n')[1]);

/* ── 3. 协议切到 OPC UA：连 %MW100 也不显示了（地址跟变量名重复，没意义） ── */
await page.evaluate(async () => {
  const m = await import('/js/api/backend.js');
  m.backend.setPlcInfo({ protocol: 'opcua' });
  (await import('/js/core/project.js')).project.commit('切 OPC UA');
});
await sleep(350);
const uaRow = await rowOf(ids.num);
const uaBtn = await rowOf(ids.btn);
ok('OPC UA 下：配置列只显示变量名（连 %MW100 也不带）',
  uaRow?.info === 'rSpd' && uaBtn?.info === 'bRun', JSON.stringify([uaRow?.info, uaBtn?.info]));
await page.evaluate(async () => {
  const m = await import('/js/api/backend.js');
  m.backend.setPlcInfo({ protocol: 'modbus' });
  (await import('/js/core/project.js')).project.commit('切回 Modbus');
});
await sleep(350);
ok('切回 Modbus：地址又回来了', (await rowOf(ids.num))?.info === 'rSpd @%MW100');

/* ── 4. 「隐藏名称」开关 ── */
ok('清单里有个「隐藏名称」按钮（在内容区，分屏布局下也点得着）',
  await page.evaluate(() => !!document.getElementById('listHideName')));
await page.click('#listHideName');
await sleep(250);
const hidden = await rowOf(ids.num);
ok('点一下 → 名称收起，配置照样在（行更紧凑）',
  hidden?.nameShown === false && hidden?.info === 'rSpd @%MW100' && !!hidden?.badgeText,
  JSON.stringify(hidden));
ok('这个选择记在本机（刷新还在）',
  await page.evaluate(() => localStorage.getItem('hmi-list-hidename') === '1'));
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.click('.lp-tab[data-tab="list"]');
await sleep(250);
ok('刷新后名称仍是收起的', (await rowOf(ids.num))?.nameShown === false);
await page.click('#listHideName');
await sleep(250);
ok('再点一下恢复显示名称', (await rowOf(ids.num))?.nameShown === true);

/* ── 5. 「底」开关：公共底那一层的控件可以收起来（现场要求） ── */
const baseIds = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const pg = m.pages().find(p => p.type === 'page');
  const b = m.addPage('base');
  m.updatePage(b.id, { name: '底1' });
  const nav = m.addWidget('button', 10, 500);
  nav.name = '底上的导航钮';
  nav.bindings.variable = 'bRun';
  m.setPageBase(pg.id, b.id);
  m.setCurrentPage(pg.id);
  m.commit('加个底');
  return { page: pg.id, base: b.id, nav: nav.id };
});
await sleep(450);
const baseRow = () => page.evaluate((id) => {
  const r = document.querySelector(`#widgetList .wl-item[data-id="${id}"]`);
  return r ? { cls: r.className, tag: r.querySelector('.wl-basetag')?.textContent || '', title: r.title } : null;
}, baseIds.nav);
ok('套了公共底 → 清单里把底那一层也列出来，行上带「底」标记',
  (await baseRow())?.tag === '底' && /wl-base/.test((await baseRow())?.cls || ''),
  JSON.stringify(await baseRow()));
ok('底那一行的悬停提示写明"点一下跳到底页去改"',
  /跳到底页/.test((await baseRow())?.title || ''), (await baseRow())?.title?.split('\n').slice(-1)[0]);
ok('清单里有个「底」开关（在内容区，分屏布局下也点得着）',
  await page.evaluate(() => !!document.getElementById('listHideBase')));
await page.click('#listHideBase');
await sleep(350);
ok('点一下 → 底那一层的行不见了（本页自己的控件照旧在）',
  (await baseRow()) === null && (await rowOf(ids.num)) !== null,
  JSON.stringify({ base: await baseRow(), own: !!(await rowOf(ids.num)) }));
ok('这个选择也记在本机（localStorage）',
  await page.evaluate(() => localStorage.getItem('hmi-list-hidebase') === '1'));
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(450);
await page.click('.lp-tab[data-tab="list"]');
await sleep(300);
ok('刷新后底那一层仍是收起的', (await baseRow()) === null);
await page.click('#listHideBase');
await sleep(350);
ok('再点一下 → 底那一层的行又回来了', (await baseRow())?.tag === '底');

/* ── 6. 点击行仍能定位（这几处改动不能把清单的基本功能碰坏） ── */
await page.evaluate((id) => document.querySelector(`#widgetList .wl-item[data-id="${id}"]`).click(), ids.trend);
await sleep(400);
ok('点清单行 → 画布上选中该控件',
  await page.evaluate((id) => document.querySelector(`#canvas .wd[data-id="${id}"]`)?.classList.contains('selected') === true, ids.trend));

/* ── 7. 页面下拉那一行**吸顶**（现场要求：清单几百行，滚下去还得能换页/切「底」「Aa」） ── */
const sticky = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const pid = project.currentPage().id;
  for (let i = 0; i < 60; i++) {                       // 灌够行数，不然没得滚
    const id = project.addWidget('label', 40 + (i % 8) * 80, 40 + Math.floor(i / 8) * 40, pid);
    project.updateWidgetField(id, 'name', `吸顶测试${i + 1}`);
  }
  project.commit('吸顶测试');
  await new Promise(r => setTimeout(r, 400));
  const body = document.querySelector('#panel-list .panel-body');
  const cs = getComputedStyle(document.querySelector('.list-tools'));
  const before = document.querySelector('.list-tools').getBoundingClientRect().top;
  body.scrollTop = Math.round(body.scrollHeight * 0.6);
  body.dispatchEvent(new Event('scroll'));
  await new Promise(r => setTimeout(r, 500));
  const t = document.querySelector('.list-tools').getBoundingClientRect();
  const p = body.getBoundingClientRect();
  return {
    pos: cs.position, bg: cs.backgroundColor, z: cs.zIndex,
    padB: cs.paddingBottom, borderB: cs.borderBottomWidth,
    moved: Math.round(before - t.top),              // 滚之前/之后这一行自己挪了多少
    insideTop: Math.round(t.top - p.top),           // 吸住后它离面板可视区顶边多远
    insideBottom: Math.round(p.bottom - t.bottom),
  };
});
ok('★ 页面下拉那一行是吸顶的（position: sticky）', sticky.pos === 'sticky', sticky.pos);
ok('★ 清单滚下去它**没跟着滚走**（还在面板可视区里，几乎贴住顶边）',
  sticky.insideTop >= -1 && sticky.insideTop <= 2 && sticky.insideBottom > 0,
  JSON.stringify([sticky.insideTop, sticky.insideBottom]));
ok('吸顶那一条是不透明背景 + 有层级（行从底下过不会透出来）',
  /^rgb\(/.test(sticky.bg) && sticky.bg !== 'rgba(0, 0, 0, 0)' && Number(sticky.z) >= 2,
  JSON.stringify([sticky.bg, sticky.z]));
ok('吸顶那一条自带下边距 + 一条分隔线（吸住时和下面的行分得开）',
  parseFloat(sticky.padB) >= 6 && parseFloat(sticky.borderB) >= 1,
  JSON.stringify([sticky.padB, sticky.borderB]));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 控件清单显示回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
