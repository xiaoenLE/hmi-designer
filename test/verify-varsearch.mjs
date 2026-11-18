// verify-varsearch.mjs — 变量「在哪用到 / 替换」（js/editor/varSearch.js）
//   现场诉求："里面还需要搜索功能，可以搜索变量有没有使用，都在那个地方使用。
//             记住上次的搜索记录，还可以替换。"
//   这套用例验四件事：
//     ① 扫描：控件绑定 / 波形通道（含配色·量程键）/ 动作 / 报警条件 / 报警内容 {变量} /
//             脚本触发变量 / 脚本代码里的 hmi.get·set('名字') 都找得到；
//             公共底上的控件要标成「公共底「底1」」；没被引用的变量要明确说"没被引用"
//     ② 记住上次搜索：只留最后一次（不是攒历史）+ 重新打开自动填上并重跑 + **Ctrl+F** 打开
//     ③ 定位：点「定位」跳到那一页并选中那个控件
//     ④ 替换：所有引用（含脚本字符串）一起换、可选删掉旧变量、**一步 Ctrl+Z 全回来**
// 用法：node test/verify-varsearch.mjs   （自己拉起独立数据目录的后端，不碰 8866 上那套）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-varsearch-'));
// ⚠ 日志目录也指到临时目录：脚本日志会落盘（logs/script-*.log），别往仓库的 logs/ 里写测试噪音
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-varsearch-logs-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS } });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { if ((await fetch(H + '/')).ok) up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ── 造一个"到处都用到 rSpeed"的工程 ── */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.newProject('blank');
  project.data.variables.push(
    { name: 'rSpeed', type: 'real', address: '%MW100', value: 0, len: 0 },
    { name: 'rSpeed2', type: 'real', address: '%MW102', value: 0, len: 0 },   // 没人用
    { name: 'bRun', type: 'bool', address: '%MX0.0', value: false, len: 0 },
  );
  const p1 = project.pages().find(p => p.type === 'page');
  project.updatePage(p1.id, { name: '主页' });

  // 主页：数值控件绑 rSpeed、按钮动作 toggle rSpeed、波形两通道 rSpeed/bRun + 配色量程
  const num = project.addWidget('number', 40, 40);
  project.updateWidgetField(num.id, 'bindings.variable', 'rSpeed');
  const btn = project.addWidget('button', 40, 120);
  project.updateWidgetActions(btn.id, [{ trigger: 'click', type: 'toggle', params: { variable: 'rSpeed' } }]);
  const trend = project.addWidget('trend', 300, 40);
  project.updateWidgetField(trend.id, 'bindings.variables', ['rSpeed', 'bRun']);
  project.updateWidgetProp(trend.id, 'colors', { rSpeed: '#ff0000' });
  project.updateWidgetProp(trend.id, 'scales', { rSpeed: 1 });

  // 公共底：底上也用一个（引用要能标出"是底上的"）
  const b = project.addPage('base');
  project.updatePage(b.id, { name: '底1' });
  const baseLamp = project.addWidget('label', 10, 10);
  project.updateWidgetField(baseLamp.id, 'bindings.variable', 'rSpeed');
  project.setPageBase(p1.id, b.id);

  // 报警：条件用 rSpeed，内容里 {rSpeed}
  project.data.alarms.push({
    id: 'al_test', name: '速度超限', variable: 'rSpeed', op: '>', value: 100,
    level: 'alarm', delaySec: 0, enabled: true, text: '转速 {rSpeed} 超限',
  });
  // 脚本：触发变量 rSpeed + 代码里 hmi.set/get('rSpeed')
  project.data.scripts.push({
    id: 'sc_test', name: '速度联动', trig: 'change', ms: 1000, variable: 'rSpeed', op: '==', value: 1, enabled: true,
    code: "hmi.set('rSpeed', hmi.get('rSpeed') + 1);\nhmi.log('tick');",
  });
  // 另一个脚本用**属性写法**（hmi.v.名字 / hmi.v['名字']）—— 扫描与改名都必须认（漏了就是"改名后静默失效"）
  project.data.scripts.push({
    id: 'sc_prop', name: '属性写法', trig: 'interval', ms: 500, enabled: true,
    code: "if (hmi.v.bRun) {\n  hmi.v.rSpeed = hmi.v.rSpeed + 1;\n}\nhmi.log(hmi.v['rSpeed']);",
  });
  project.setCurrentPage(p1.id);
  project.commit('查找引用测试');
  return { page: p1.id, base: b.id, num: num.id, btn: btn.id, trend: trend.id, baseLamp: baseLamp.id };
});
await sleep(400);

/* ═══════════ 1. 扫描：每一处引用都找得到 ═══════════ */
const scan = await page.evaluate(async () => {
  const m = await import('/js/editor/varSearch.js');
  return m.scanVarUsage('rSpeed');
});
const vSpeed = scan.vars.find(v => v.name === 'rSpeed');
const vSpeed2 = scan.vars.find(v => v.name === 'rSpeed2');
const kinds = {};
(vSpeed?.hits || []).forEach(h => { kinds[h.kind] = (kinds[h.kind] || 0) + 1; });
ok('模糊匹配：查 rSpeed 会同时列出 rSpeed 和 rSpeed2',
  !!vSpeed && !!vSpeed2, JSON.stringify(scan.vars.map(v => v.name)));
ok('控件绑定找到了（主页上的数值控件）',
  (vSpeed?.hits || []).some(h => h.kind === 'bind' && /数值/.test(h.label) && /主页/.test(h.label)),
  JSON.stringify(kinds));
ok('按钮动作找到了（切换）', (vSpeed?.hits || []).some(h => h.kind === 'action' && /切换/.test(h.label)),
  JSON.stringify((vSpeed?.hits || []).filter(h => h.kind === 'action').map(h => h.label)));
ok('波形通道找到了（第 1 通道）', (vSpeed?.hits || []).some(h => h.kind === 'wave' && /第 1 通道/.test(h.label)));
ok('波形通道的配色/量程键也算引用',
  (vSpeed?.hits || []).filter(h => h.kind === 'wave').length >= 3,
  JSON.stringify((vSpeed?.hits || []).filter(h => h.kind === 'wave').map(h => h.label)));
ok('**公共底上的控件**标成「公共底「底1」」',
  (vSpeed?.hits || []).some(h => /公共底「底1」/.test(h.label)),
  JSON.stringify((vSpeed?.hits || []).filter(h => /公共底/.test(h.label)).map(h => h.label)));
ok('报警触发条件找到了', (vSpeed?.hits || []).some(h => h.kind === 'alarm' && /速度超限/.test(h.label)));
ok('报警内容里的 {变量} 找到了', (vSpeed?.hits || []).some(h => h.kind === 'alarmText' && /\{rSpeed\}/.test(h.label)));
ok('脚本触发变量找到了', (vSpeed?.hits || []).some(h => h.kind === 'scriptTrig'));
// 一个脚本里用到多次也只算**一处**（列出来是"这个脚本里用到了它"，重复行没意义）
ok('脚本代码里的 hmi.get/set(变量名) 找到了（同一个脚本算一处）',
  (vSpeed?.hits || []).filter(h => h.kind === 'scriptCode').length === 2
  && /hmi\.set\('rSpeed'\)/.test((vSpeed?.hits || []).find(h => h.kind === 'scriptCode')?.label || ''),
  JSON.stringify((vSpeed?.hits || []).filter(h => h.kind === 'scriptCode').map(h => h.label)));
ok('★ 脚本代码里的**属性写法** hmi.v.名字 也算一处引用（新写法不能漏）',
  (vSpeed?.hits || []).some(h => h.kind === 'scriptCode'
    && /脚本「属性写法」代码里 hmi\.v\.rSpeed（属性写法）/.test(h.label)),
  JSON.stringify((vSpeed?.hits || []).filter(h => h.kind === 'scriptCode').map(h => h.label)));
ok('没被引用的变量明确说"没被引用"（hits 为空）', vSpeed2 && vSpeed2.hits.length === 0,
  JSON.stringify(vSpeed2?.hits));
const exact = await page.evaluate(async () => {
  const m = await import('/js/editor/varSearch.js');
  const s = m.scanVarUsage('rSpeed', { fuzzy: false });
  return { names: s.vars.map(v => v.name), hits: s.vars[0]?.hits.length };
});
ok('精确匹配（关掉"包含匹配"）只出 rSpeed 一个变量',
  exact.names.length === 1 && exact.names[0] === 'rSpeed' && exact.hits >= 8, JSON.stringify(exact));

/* ── **按地址**查（现场：拿着 PLC 上的点位找变量 ——"MW102 是哪个变量？用在哪？"）──
   以前只按名字匹配，打地址一律"没有匹配"（现场附图就是这么报的）。 */
const byAddr = await page.evaluate(async () => {
  const m = await import('/js/editor/varSearch.js');
  const out = {};
  for (const q of ['MW102', '%MW102', 'mw102', '102', 'HR102']) {
    const s = m.scanVarUsage(q);
    out[q] = { names: s.vars.map(v => v.name), byAddr: s.vars.map(v => !!v.byAddr) };
  }
  const ex = m.scanVarUsage('%MW102', { fuzzy: false });
  const exShort = m.scanVarUsage('MW102', { fuzzy: false });
  return { ...out, exactFull: ex.vars.map(v => v.name), exactShort: exShort.vars.map(v => v.name) };
});
ok('查找引用：按地址搜得到（MW102 → rSpeed2）',
  JSON.stringify(byAddr['MW102'].names) === JSON.stringify(['rSpeed2']) && byAddr['MW102'].byAddr[0] === true,
  JSON.stringify(byAddr['MW102']));
ok('查找引用：%MW102 / 大小写 都认', JSON.stringify(byAddr['%MW102'].names) === JSON.stringify(['rSpeed2'])
  && JSON.stringify(byAddr['mw102'].names) === JSON.stringify(['rSpeed2']), JSON.stringify(byAddr['%MW102']));
ok('查找引用：老写法 HR102 也认（跟变量表"地址写法自动统一"同一套）',
  JSON.stringify(byAddr['HR102'].names) === JSON.stringify(['rSpeed2']), JSON.stringify(byAddr['HR102']));
ok('查找引用：纯数字 102 也认（= %MW102）',
  JSON.stringify(byAddr['102'].names).includes('rSpeed2'), JSON.stringify(byAddr['102']));
ok('查找引用：精确匹配下 %MW102 / MW102 都出 rSpeed2',
  JSON.stringify(byAddr.exactFull) === JSON.stringify(['rSpeed2'])
  && JSON.stringify(byAddr.exactShort) === JSON.stringify(['rSpeed2']),
  JSON.stringify([byAddr.exactFull, byAddr.exactShort]));
const byAddrHits = await page.evaluate(async () => {
  const m = await import('/js/editor/varSearch.js');
  const s = m.scanVarUsage('MW100');     // 这个地址上挂着 rSpeed（引用最多那个）
  const v = s.vars.find(x => x.name === 'rSpeed');
  return { hits: v?.hits.length || 0, total: s.totalHits, names: s.vars.map(x => x.name) };
});
ok('查找引用：按地址命中的那条**引用也照常列出来**（不只是"找到变量"）',
  byAddrHits.hits >= 8 && byAddrHits.total >= 8, JSON.stringify(byAddrHits));

/* 名字命中的排前面、地址命中的排后面（打 rSpeed 时不能把别的地址里含 rSpeed 的挤前面） */
const order = await page.evaluate(async () => {
  const m = await import('/js/editor/varSearch.js');
  const s = m.scanVarUsage('Speed');     // 名字命中 rSpeed/rSpeed2；地址里没有
  return s.vars.map(v => ({ n: v.name, a: !!v.byAddr }));
});
ok('查找引用：名字命中的在前（byAddr 全是 false）', order.every(v => !v.a), JSON.stringify(order));

/* ═══════════ 2. 界面：搜索 + 历史 + 定位 ═══════════ */
await page.evaluate(() => { try { localStorage.removeItem('hmi-varsearch-v1'); } catch { /* 忽略 */ } });
await page.evaluate(() => document.querySelector('#leftPanel .lp-tab[data-panel="vars"]')?.click());
await sleep(300);
await page.click('#btnFindVar');
await sleep(300);
ok('变量面板的「🔍 查找/替换…」把对话框打开了',
  await page.locator('#dlgMask:not(.hidden) #vsQ').count() === 1);
await page.fill('#vsQ', 'rSpeed');
await page.keyboard.press('Enter');
await sleep(400);
const ui = await page.evaluate(() => ({
  vars: document.querySelectorAll('#vsOut .vs-var').length,
  hits: document.querySelectorAll('#vsOut .vs-hit').length,
  sum: document.querySelector('#vsOut .vs-sum')?.textContent.replace(/\s+/g, ' ').trim(),
  hist: JSON.parse(localStorage.getItem('hmi-varsearch-v1') || '{}'),
  datalist: document.querySelectorAll('#vsHist option').length,
}));
ok('结果区按变量分组列出引用行', ui.vars === 2 && ui.hits >= 9, JSON.stringify({ vars: ui.vars, hits: ui.hits }));
ok('结果区有一句汇总（匹配几个变量 / 共几处引用）', /共\s*\d+\s*处引用/.test(ui.sum || ''), ui.sum);
ok('**记住上次搜索**：只留最后一次那个词（不攒历史列表）',
  ui.hist.q === 'rSpeed' && !('history' in ui.hist) && ui.datalist === 0, JSON.stringify(ui.hist));

/* 界面上按**地址**查（现场附图那条：打 MW2000 说"没有匹配"）：要出变量行 + 「按地址」标记 */
await page.fill('#vsQ', 'MW102');
await page.keyboard.press('Enter');
await sleep(400);
const uiAddr = await page.evaluate(() => ({
  vars: [...document.querySelectorAll('#vsOut .vs-var')].map(el => ({
    name: el.querySelector('b')?.textContent || '',
    addr: el.querySelector('.vs-addr')?.textContent || '',
    tag: el.querySelector('.badge.addr')?.textContent || '',
  })),
  empty: !!document.querySelector('#vsOut .vs-empty'),
}));
ok('界面：按地址查出变量行（MW102 → rSpeed2，而不是"没有匹配"）',
  uiAddr.vars.length === 1 && uiAddr.vars[0].name === 'rSpeed2' && !uiAddr.empty, JSON.stringify(uiAddr));
ok('界面：地址命中的那条打「按地址」标记 + 显示地址（一眼核对）',
  uiAddr.vars[0]?.tag === '按地址' && /MW102/.test(uiAddr.vars[0]?.addr || ''), JSON.stringify(uiAddr.vars[0]));
await page.fill('#vsQ', 'MW100');
await page.keyboard.press('Enter');
await sleep(400);
const uiAddr2 = await page.evaluate(() => ({
  names: [...document.querySelectorAll('#vsOut .vs-var b')].map(el => el.textContent),
  hits: document.querySelectorAll('#vsOut .vs-hit').length,
}));
ok('界面：按地址命中的变量，它的**引用行也列出来**了（能直接定位/替换）',
  uiAddr2.names.includes('rSpeed') && uiAddr2.hits >= 9, JSON.stringify(uiAddr2));
ok('界面：查不到时文案说清是"按名称和地址都没找到"',
  await (async () => {
    await page.fill('#vsQ', 'zzz-nothing'); await page.keyboard.press('Enter'); await sleep(350);
    const t = await page.evaluate(() => document.querySelector('#vsOut .vs-empty')?.textContent || '');
    await page.fill('#vsQ', 'rSpeed'); await page.keyboard.press('Enter'); await sleep(300);
    return /名称和地址/.test(t);
  })(), '');

// 关掉再打开 → 上次的词自动填上并重跑
await page.click('#dlgCancel');
await sleep(200);
await page.click('#btnFindVar');
await sleep(400);
const reopen = await page.evaluate(() => ({
  q: document.getElementById('vsQ')?.value,
  vars: document.querySelectorAll('#vsOut .vs-var').length,
}));
ok('重新打开：自动填上次查的词，并立刻把结果重跑出来',
  reopen.q === 'rSpeed' && reopen.vars === 2, JSON.stringify(reopen));

// Ctrl+F 也能开（编辑态）；选中一个绑了变量的控件时，直接查它那个变量
await page.click('#dlgCancel');
await sleep(200);
await page.keyboard.press('Control+f');
await sleep(350);
const viaKey = await page.evaluate(() => ({
  open: !!document.querySelector('#dlgMask:not(.hidden) #vsQ'),
  q: document.getElementById('vsQ')?.value,
}));
ok('**Ctrl+F** 打开查找对话框（没选控件时填上次的词）',
  viaKey.open && viaKey.q === 'rSpeed', JSON.stringify(viaKey));

await page.click('#dlgCancel');
await sleep(200);
await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  project.setCurrentPage(ids.page);
  const canvas = await import('/js/editor/canvas.js');
  canvas.select([ids.num]);
  document.activeElement?.blur();
}, ids);
await sleep(250);
await page.keyboard.press('Control+f');
await sleep(350);
const viaKey2 = await page.evaluate(() => ({ q: document.getElementById('vsQ')?.value }));
ok('Ctrl+F 时选中了控件 → 直接查那个控件绑的变量（rSpeed）', viaKey2.q === 'rSpeed', JSON.stringify(viaKey2));
await page.click('#dlgCancel');
await sleep(200);

// 点「定位」→ 跳到那一页并选中那个控件
await page.click('#btnFindVar');
await sleep(300);
await page.fill('#vsQ', 'rSpeed');
await page.keyboard.press('Enter');
await sleep(400);
await page.click(`#vsOut .vs-hit[data-v="rSpeed"] .vs-jump`);
await sleep(500);
const jumped = await page.evaluate((ids) => ({
  dlgHidden: document.getElementById('dlgMask').classList.contains('hidden'),
  cur: window.app.project.currentId,
  sel: [...document.querySelectorAll('#canvas .wd.selected')].map(e => e.dataset.id),
}), ids);
ok('点「定位」：对话框收起、跳到那一页、控件被选中',
  jumped.dlgHidden && jumped.cur === ids.page && jumped.sel.length >= 1, JSON.stringify(jumped));

/* ═══════════ 3. 替换：所有引用一起换 + 一步撤销 ═══════════ */
await page.click('#btnFindVar');
await sleep(350);
await page.fill('#vsQ', 'rSpeed');
await page.keyboard.press('Enter');
await sleep(400);
await page.fill('#vsTo', 'rSpeed2');
await page.check('#vsDel');
await page.click('#vsGo');
await sleep(600);
const after = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const p1 = project.pages().find(p => p.name === '主页');
  const base = project.pages().find(p => p.type === 'base');
  const num = p1.widgets.find(w => w.type === 'number');
  const btn = p1.widgets.find(w => w.type === 'button');
  const trend = p1.widgets.find(w => w.type === 'trend');
  const al = project.alarms().find(a => a.id === 'al_test');
  const sc = project.scripts().find(s => s.id === 'sc_test');
  const scProp = project.scripts().find(s => s.id === 'sc_prop');
  return {
    bind: num.bindings.variable,
    action: btn.actions[0].params.variable,
    ch1: trend.bindings.variables[0],
    colors: Object.keys(trend.props.colors || {}),
    scales: Object.keys(trend.props.scales || {}),
    baseBind: base.widgets.find(w => w.type === 'label').bindings.variable,
    alarmVar: al.variable, alarmText: al.text,
    scriptTrig: sc.variable, scriptCode: sc.code, scriptProp: scProp.code,
    stillThere: project.variables().some(v => v.name === 'rSpeed'),
    hasNew: project.variables().some(v => v.name === 'rSpeed2'),
  };
});
ok('替换：控件绑定改到新变量', after.bind === 'rSpeed2', after.bind);
ok('替换：按钮动作改到新变量', after.action === 'rSpeed2', after.action);
ok('替换：波形通道 + 配色/量程键都改到新变量',
  after.ch1 === 'rSpeed2' && after.colors.includes('rSpeed2') && after.scales.includes('rSpeed2'),
  JSON.stringify([after.ch1, after.colors, after.scales]));
ok('替换：公共底上的控件也改了', after.baseBind === 'rSpeed2', after.baseBind);
ok('替换：报警条件 + 内容里的 {变量} 一起改',
  after.alarmVar === 'rSpeed2' && after.alarmText === '转速 {rSpeed2} 超限',
  JSON.stringify([after.alarmVar, after.alarmText]));
ok('替换：脚本触发变量 + **代码里的 hmi.get/set 字符串**一起改',
  after.scriptTrig === 'rSpeed2' && /hmi\.set\('rSpeed2', hmi\.get\('rSpeed2'\) \+ 1\)/.test(after.scriptCode),
  JSON.stringify(after.scriptCode));
ok('★ 替换：**属性写法** hmi.v.名字 / hmi.v[\'名字\'] 也一起改（点写法照旧点、方括号照旧方括号，别的变量不动）',
  /hmi\.v\.rSpeed2 = hmi\.v\.rSpeed2 \+ 1/.test(after.scriptProp || '')
  && /hmi\.log\(hmi\.v\['rSpeed2'\]\)/.test(after.scriptProp || '')
  && /hmi\.v\.bRun/.test(after.scriptProp || ''),
  JSON.stringify(after.scriptProp));
ok('勾了「删掉旧变量」：rSpeed 已从变量表消失（新变量还在）',
  after.stillThere === false && after.hasNew === true, JSON.stringify(after));

await page.click('#dlgCancel');
await sleep(200);
await page.click('#btnUndo');
await sleep(500);
const undone = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const p1 = project.pages().find(p => p.name === '主页');
  const num = p1.widgets.find(w => w.type === 'number');
  const sc = project.scripts().find(s => s.id === 'sc_test');
  const scProp = project.scripts().find(s => s.id === 'sc_prop');
  const al = project.alarms().find(a => a.id === 'al_test');
  return {
    back: project.variables().some(v => v.name === 'rSpeed'),
    bind: num.bindings.variable,
    alarmVar: al.variable, alarmText: al.text,
    script: sc.code, scriptTrig: sc.variable, scriptProp: scProp.code,
  };
});
ok('**一步撤销**：变量、绑定、报警、脚本全都回到替换前',
  undone.back === true && undone.bind === 'rSpeed' && undone.alarmVar === 'rSpeed'
  && undone.alarmText === '转速 {rSpeed} 超限' && /hmi\.set\('rSpeed'/.test(undone.script)
  && undone.scriptTrig === 'rSpeed'
  && /hmi\.v\.rSpeed/.test(undone.scriptProp || ''),      // 属性写法也一起退回来
  JSON.stringify(undone));

/* 变量行右键菜单里也有这两个入口 */
const menu = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  window.app.project.setCurrentPage(project.pages()[0].id);
  await new Promise(r => setTimeout(r, 250));
  document.querySelector('#leftPanel .lp-tab[data-panel="vars"]')?.click();
  await new Promise(r => setTimeout(r, 300));
  const tr = [...document.querySelectorAll('#varTable tr[data-name]')].find(r => r.dataset.name === 'rSpeed');
  const r = tr.getBoundingClientRect();
  tr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 8, clientY: r.y + 8 }));
  await new Promise(r2 => setTimeout(r2, 250));
  const labels = [...document.querySelectorAll('#ctxMenu .ctx-item')].map(i => i.textContent.trim());
  document.getElementById('ctxMenu')?.classList.add('hidden');
  return labels;
});
ok('变量行右键菜单有「查找引用」「替换成别的变量」',
  menu.some(t => /查找引用/.test(t)) && menu.some(t => /替换成别的变量/.test(t)), JSON.stringify(menu.slice(0, 8)));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 变量查找引用 / 替换回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
