// verify-dtype-lock.mjs — 「数据类型」这一格什么时候能改
//   ① OPC UA：变量是导入的，类型以 PLC 为准 → 那一行只看不改（改了会把导入来的类型覆盖掉，
//      声明类型和节点实际类型对不上 → 读回来/写下去都按错类型解，现场就是「值不对、写不进」）
//   ② bool / 认不出的类型：没有对应的数值格式，面板按 int 兜底显示，同样**锁住不许改**
//      （顺着它写回变量表就等于把 bool 变量改成 int，地址还指着原来的位，读写全乱）
//   ③ Modbus TCP（含没配 PLC 的老工程）：可以改，改的是**变量表里**的类型
// 用法：node test/verify-dtype-lock.mjs   （自己拉起一个独立数据目录的后端，不碰 8866 上那套）
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
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-dtype-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(`${H}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(500);

/* 后端只用来加载页面，读写通道掐掉（本套件只管属性面板的可编辑性） */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
}));

/* 准备：一个数值控件绑一个 real 变量 */
const ids = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'rSpd', type: 'real', address: '%MW100', value: 1.5, len: 0 });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const w = m.addWidget('number', 40, 40);
  w.name = 'numA';
  w.bindings.variable = 'rSpd';
  const wol = m.addWidget('number', 300, 40);
  wol.name = 'numB';                       // 故意不绑变量
  m.commit('dtype 锁测试');
  return { num: w.id, loose: wol.id };
});
await page.waitForTimeout(300);

const setProto = (p) => page.evaluate(async (p) => {
  const m = await import('/js/api/backend.js');
  m.backend.setPlcInfo({ protocol: p });
}, p);
const panel = () => page.evaluate(() => {
  const s = document.querySelector('#propBody [data-dtype="dispType"]');
  // 锁住时行下面会挂一句可见说明（🔒 …）—— 不靠悬停就能看到"为什么不能改"
  const note = [...document.querySelectorAll('#propBody .f-row')]
    .map(r => r.textContent).find(t => t.includes('🔒') && t.includes('类型')) || '';
  return { exists: !!s, value: s?.value, disabled: !!s?.disabled, title: s?.title || '', note };
});
const typeOf = (n) => page.evaluate(async (n) => {
  const m = (await import('/js/core/project.js')).project;
  return m.variables().find(v => v.name === n)?.type;
}, n);
const select = async (wid) => { await page.click(`#canvas .wd[data-id="${wid}"]`); await page.waitForTimeout(300); };
/** 绕过 disabled 硬改（模拟脚本/旧代码路径），验证代码里那道保险 */
const forceChange = (val) => page.evaluate((val) => {
  const s = document.querySelector('#propBody [data-dtype="dispType"]');
  s.disabled = false;
  s.value = val;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}, val);

/* ── 1. 默认（Modbus）：那一行可改，改了会改变量表 ── */
await setProto('modbus');
await select(ids.num);
const p1 = await panel();
ok('Modbus 下：数据类型下拉存在且**可改**', p1.exists && p1.disabled === false, JSON.stringify(p1));
ok('Modbus 下：显示的是绑定变量的类型（real→float）', p1.value === 'float', String(p1.value));
await page.selectOption('#propBody [data-dtype="dispType"]', 'int');
await page.waitForTimeout(400);
ok('Modbus 下：改数据类型 → 变量表里的类型跟着变（real → int）', (await typeOf('rSpd')) === 'int', String(await typeOf('rSpd')));
ok('Modbus 下：没有「OPC UA 不许改」的提示', (await panel()).note === '');

/* ── 2. 切到 OPC UA：那一行锁住 ── */
await setProto('opcua');
await page.waitForTimeout(300);
const p2 = await panel();
ok('切到 OPC UA（面板开着）→ 下拉立刻变只读（不用重新选中控件）', p2.disabled === true, JSON.stringify(p2));
ok('OPC UA 下：下拉仍显示绑定的类型（int），不是空白', p2.value === 'int', String(p2.value));
ok('OPC UA 下：title 写明「以 PLC 为准，这里不能改」',
  /PLC 为准/.test(p2.title) && /导入/.test(p2.title), p2.title);
ok('OPC UA 下：行下面有一句可见说明（不靠悬停）', /OPC UA 变量是导入的/.test(p2.note), p2.note);

/* ── 3. 硬绕过 disabled 也改不动变量（代码里那道保险） ── */
const before = await typeOf('rSpd');
await forceChange('float');
await page.waitForTimeout(400);
const after = await typeOf('rSpd');
ok('OPC UA 下：硬派 change 事件也改不动变量类型（保险生效）', before === after, `${before} → ${after}`);

/* ── 4. 没绑变量的控件：不受影响（这里只决定显示格式，不碰变量表） ── */
await select(ids.loose);
const p4 = await panel();
ok('OPC UA 下：**没绑变量**的数值控件仍可改显示格式（没有变量可被弄坏）',
  p4.exists && p4.disabled === false, JSON.stringify(p4));
ok('OPC UA 下：没绑变量的控件不显示「导入…不能改」提示', p4.note === '', p4.note);

/* ── 5. 切回 Modbus：恢复可改 ── */
await select(ids.num);
await setProto('modbus');
await page.waitForTimeout(300);
const p5 = await panel();
ok('切回 Modbus → 下拉恢复可改', p5.disabled === false, JSON.stringify(p5));

/* ── 6. bool 变量：面板按 int 兜底显示，且**锁住**（Modbus 下也不许改） ── */
await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  m.variables().push({ name: 'bRunX', type: 'bool', address: '%MX0', value: false });
  m.updateWidgetField(id, 'bindings.variable', 'bRunX');
  m.commit('t');
}, ids.num);
await select(ids.num);
await page.waitForTimeout(300);
const p6 = await panel();
ok('绑 bool 变量：这一格显示 int（不再掉回控件自己那份 dint/float）', p6.value === 'int', JSON.stringify(p6));
ok('绑 bool 变量：下拉锁住 —— Modbus 下也不许在这一格改', p6.disabled === true, JSON.stringify(p6));
ok('绑 bool 变量：行下面有一句可见说明（写明变量是 bool）',
  /bool/.test(p6.note) && /0\/1/.test(p6.note), p6.note);
const boolBefore = await typeOf('bRunX');
await forceChange('float');
await page.waitForTimeout(400);
ok('绑 bool 变量：硬派 change 也改不动变量表（还是 bool）',
  (await typeOf('bRunX')) === boolBefore && boolBefore === 'bool', `${boolBefore} → ${await typeOf('bRunX')}`);

/* ── 7. bool 控件本身（绑 bool 变量的灯/开关）不受影响 ── */
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const w = m.addWidget('lamp', 500, 300);
  w.bindings.variable = 'bRunX';
  m.commit('t');
  window.__lampId = w.id;
});
const lid = await page.evaluate(() => window.__lampId);
await select(lid);
await page.waitForTimeout(300);
ok('绑 bool 的指示灯：本来就没有「数据类型」那一行（不显示数值格式）', await page.evaluate(() =>
  !document.querySelector('#propBody [data-dtype="dispType"]')));
await select(ids.num);
await page.waitForTimeout(200);

/* ── 8. 自动切换：同一个控件，用变量选择器换变量 → 那格当场跟着换 ── */
const pickVar = async (name) => {
  await page.click('#propBody [data-bind="variable"]');
  await page.fill('#propBody [data-bind="variable"]', name);
  await page.keyboard.press('Enter');           // 候选表里的确认键
  await page.waitForTimeout(400);
  return panel();
};
await select(ids.num);
await page.waitForTimeout(200);
const s8a = await pickVar('rSpd');
ok('选 rSpd（第 1 节里已改成 int）→ 类型格显示 int 且可改（Modbus TCP）',
  s8a.value === 'int' && s8a.disabled === false, JSON.stringify(s8a));
const s8b = await pickVar('bRunX');
ok('紧接着换成 bool 变量 → 同一格当场变成 int 并锁住（跟着变量自动切换，不用重新选控件）',
  s8b.value === 'int' && s8b.disabled === true && /bool/.test(s8b.note), JSON.stringify(s8b));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 「数据类型」该不该锁：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fails ? 1 : 0);
