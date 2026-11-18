// verify-retain.mjs — HMI **内部掉电保持变量**（变量表「保持」列）
//   要现场解决的事：「直接在 HMI 里定义掉电保持，全局可以用」——
//     · 地址留空的变量 = **内部变量**（HMI 自己算，不读不写 PLC）
//     · 勾上「保持」→ 值由后端落盘（server/data/retain_vars.json），后端重启 / 整机断电后还在
//     · 控件（按变量名绑定）和脚本（hmi.get/set('名字')）全局都能用
//     · **接了真 PLC 也照样能用**（以前这种变量写下去会报"地址 '' 无效：未填写"→ 界面挂"下发失败"）
//   这套用例重点验证三件事：
//     ① 内存模式下勾了保持的值落盘、重启后端值还在；没勾的重启回初值
//     ② **PLC 模式**（指向一个死端点，连不上也无所谓）下：内部变量照样能读写、保持值跨重启还在，
//        而带地址的 PLC 变量写失败的样子不变（错误照旧看得见）
//     ③ 「恢复初值」在 PLC 模式下也能用，而且**只重置内部变量**（一个字节都不碰 PLC）
// 用法：node test/verify-retain.mjs   （自己拉起独立数据目录的后端，不碰 8866 上那套）
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
const DEAD_PORT = await freePort();          // "PLC"：一个没人听的端口（连不上，正是要验的情形）
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-retain-'));
const RETAIN = path.join(DATA, 'retain_vars.json');

/** 起后端（同一个数据目录可以起第二次 = 模拟"重启/断电再来一遍"） */
function startServer() {
  return spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { const r = await fetch(H + '/api/health'); if (r.ok) return true; } catch { /* 等 */ }
  }
  return false;
}
const api = async (pathname, body) => {
  const r = await fetch(H + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, ok: r.ok, body: j };
};
const readRetain = () => { try { return JSON.parse(fs.readFileSync(RETAIN, 'utf8')); } catch { return null; } };

/* 变量表：两个内部变量（一个勾保持、一个不勾）+ 一个带地址的 PLC 变量 */
const VARS = [
  { name: '内测_计数', type: 'uint', address: '', value: 0, len: 0, retain: true },
  { name: '内测_临时', type: 'uint', address: '', value: 5, len: 0 },
  { name: '内测_PLC值', type: 'uint', address: '%MW900', value: 0, len: 0 },
];

let srv = startServer();
if (!await waitUp()) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

/* ═══════════ 1. 编辑器：变量表「保持」列 ═══════════ */
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

const ui = await page.evaluate(async (vars) => {
  const { project } = await import('/js/core/project.js');
  project.newProject('blank');
  vars.forEach(v => project.data.variables.push({ ...v }));
  project.commit('掉电保持测试');
  await new Promise(r => setTimeout(r, 300));
  document.querySelector('#leftPanel .lp-tab[data-panel="vars"]')?.click();
  await new Promise(r => setTimeout(r, 400));
  const cell = (n) => [...document.querySelectorAll('#varTable tr')]
    .find(tr => tr.querySelector('input[data-k="name"]')?.value === n)
    ?.querySelector('input[data-k="retain"]');
  const ck = cell('内测_计数'), ck2 = cell('内测_临时'), ck3 = cell('内测_PLC值');
  return {
    header: !!document.querySelector('#varTable thead .vt-keep'),
    countChecked: !!ck?.checked,
    tempChecked: !!ck2?.checked,
    plcDisabled: !!ck3?.disabled,
    tip: (document.getElementById('varTip')?.textContent || '').replace(/\s+/g, ' '),
  };
}, VARS);
ok('变量表有「保持」列，表头在', ui.header);
ok('勾了保持的内部变量：复选框是勾上的', ui.countChecked);
ok('没勾的内部变量：复选框没勾', !ui.tempChecked);
ok('有 PLC 地址的变量：保持列**禁用**（保持由 PLC 负责）', ui.plcDisabled);
ok('表下方提示写清"地址留空=内部变量、勾保持=掉电保持"',
  /内部变量/.test(ui.tip) && /掉电保持/.test(ui.tip) && /retain_vars\.json/.test(ui.tip), ui.tip.slice(0, 90));

/* 用界面真点一下：给"内测_临时"勾上保持 → 工程里就该有 retain:true */
const toggled = await page.evaluate(async () => {
  const tr = [...document.querySelectorAll('#varTable tr')]
    .find(t => t.querySelector('input[data-k="name"]')?.value === '内测_临时');
  const cb = tr.querySelector('input[data-k="retain"]');
  cb.click();
  await new Promise(r => setTimeout(r, 250));
  const { project } = await import('/js/core/project.js');
  const v = project.variables().find(x => x.name === '内测_临时');
  return { retain: !!v.retain, note: document.getElementById('stNote').textContent };
});
ok('界面点一下「保持」→ 写进工程数据（retain:true）', toggled.retain, JSON.stringify(toggled));
await page.evaluate(async () => {   // 点回去，后面按"没勾"来验
  const tr = [...document.querySelectorAll('#varTable tr')]
    .find(t => t.querySelector('input[data-k="name"]')?.value === '内测_临时');
  tr.querySelector('input[data-k="retain"]').click();
  await new Promise(r => setTimeout(r, 200));
});

/* CSV 往返：保持列要能导出/导入 */
const csv = await page.evaluate(async () => {
  const { varsToCsv, importCsv } = await import('/js/core/csv.js');
  const { project } = await import('/js/core/project.js');
  const text = varsToCsv(project.variables());
  project.data.variables = [];              // 清空后按 CSV 重建
  const r = importCsv(text);
  const v = project.variables().find(x => x.name === '内测_计数');
  return { header: text.split(/\r?\n/)[0], added: r.added, retain: !!v?.retain };
});
ok('CSV 导出带「保持」列，导入回来还是勾上的',
  /保持/.test(csv.header) && csv.added === 3 && csv.retain, JSON.stringify(csv));

/* ═══════════ 2. 内存模式：落盘 + 跨重启 ═══════════ */
await api('/api/vars/declare', { variables: VARS });
const w1 = await api('/api/vars', { name: '内测_计数', value: 41 });
const w2 = await api('/api/vars', { name: '内测_临时', value: 9 });
ok('内存模式：写内部变量成功', w1.body?.ok === true && w2.body?.ok === true, JSON.stringify([w1.body, w2.body]));
const memRead = await api('/api/vars');
ok('内存模式：读回来是刚写的值',
  memRead.body?.vars?.['内测_计数'] === 41 && memRead.body?.vars?.['内测_临时'] === 9,
  JSON.stringify(memRead.body?.vars));
await sleep(2600);                                   // 等合并落盘（FLUSH_INTERVAL = 2s）
const rf1 = readRetain();
ok('勾了「保持」的内部变量落盘到 retain_vars.json（没勾的不进这个文件）',
  rf1 && rf1['内测_计数'] === 41 && !('内测_临时' in rf1), JSON.stringify(rf1));

srv.kill();                                          // ── 重启后端 = 断电再来一遍 ──
await sleep(600);
srv = startServer();
if (!await waitUp()) { console.log('FAIL  后端重启失败'); process.exit(1); }
await api('/api/vars/declare', { variables: VARS });  // 前端启动时会重新下发变量表
const after1 = await api('/api/vars');
const v1 = after1.body?.vars || {};
ok('重启后：勾了保持的那个值还在（41）', v1['内测_计数'] === 41, JSON.stringify(v1));
// 内存模式**所有**变量本来就落盘（vars.json，老行为：换浏览器接着联调），
// 所以"没勾保持的回初值"这一条要在 PLC 模式下才算数（下面第 3 节验）。
ok('内存模式：没勾保持的值也留着（vars.json 的老行为，换浏览器接着联调）',
  v1['内测_临时'] === 9, JSON.stringify({ 内测_临时: v1['内测_临时'] }));

/* ═══════════ 3. PLC 模式（指向死端点）：内部变量照常可用 ═══════════ */
const plc = await api('/api/plc', {
  action: 'connect', protocol: 'modbus', ip: '127.0.0.1', port: DEAD_PORT, unit: 1,
  poll_ms: 200, word_order: 'cdab', variables: VARS,
});
ok('切到 PLC 模式（端点连不上也算切过去了）', plc.body?.ok !== false, JSON.stringify(plc.body).slice(0, 120));
await sleep(300);
const w3 = await api('/api/vars', { name: '内测_计数', value: 42 });
ok('**接了 PLC，内部变量照样能写**（以前报「地址 \'\' 无效：未填写」）',
  w3.status === 200 && w3.body?.ok === true, JSON.stringify(w3.body));
const w4 = await api('/api/vars', { name: '内测_PLC值', value: 1 });
ok('带地址的 PLC 变量：写失败照样如实报错（没被内部变量那条路吞掉）',
  w4.ok === false || w4.body?.ok === false, JSON.stringify(w4.body).slice(0, 120));
const after3 = await api('/api/vars');
ok('PLC 模式下读得到内部变量的新值（42）', after3.body?.vars?.['内测_计数'] === 42,
  JSON.stringify(after3.body?.vars?.['内测_计数']));
await sleep(2600);
const rf2 = readRetain();
ok('PLC 模式下勾了保持的值也落盘', rf2 && rf2['内测_计数'] === 42, JSON.stringify(rf2));

/* PLC 模式下「恢复初值」：只重置内部变量，而且不报"当前接的是真实设备" */
const reset = await api('/api/vars/reset', {});
ok('PLC 模式下「内部变量：恢复初值」可用（不再 400）', reset.status === 200 && reset.body?.ok === true,
  JSON.stringify(reset.body).slice(0, 120));
ok('恢复初值：内部变量回到初值（内测_计数 → 0）', reset.body?.vars?.['内测_计数'] === 0,
  JSON.stringify(reset.body?.vars));
ok('恢复初值：**没有**去动带地址的 PLC 变量（返回里只有内部变量）',
  !('内测_PLC值' in (reset.body?.vars || {})), JSON.stringify(Object.keys(reset.body?.vars || {})));
await sleep(2600);
const rf3 = readRetain();
ok('恢复初值后：存档里的保持值也跟着回初值（否则重启又把它带回来）',
  rf3 && rf3['内测_计数'] === 0, JSON.stringify(rf3));

/* ═══════════ 4. 取消勾选「保持」→ 存盘那份丢掉 ═══════════ */
await api('/api/vars/declare', { variables: VARS.map(v => ({ ...v, retain: false })) });
await sleep(2600);
const rf4 = readRetain();
ok('取消勾选「保持」→ 存档里那条被清掉（重启不会再冒出来）',
  rf4 && !('内测_计数' in rf4), JSON.stringify(rf4));

/* ═══════════ 4b. PLC 模式重启：保持值活下来、没勾的回初值 ═══════════
   这一段才是"掉电保持"真正要保证的事：接 PLC 时 HMI 自己的变量不再由 PLC 读回，
   只能靠自己存 —— 勾了保持的必须有，没勾的就该回变量表初值。 */
await api('/api/vars/declare', { variables: VARS });          // 回到"计数=勾保持、临时=不勾"
await api('/api/vars', { name: '内测_计数', value: 88 });
await api('/api/vars', { name: '内测_临时', value: 66 });
await sleep(2600);
srv.kill();
await sleep(600);
srv = startServer();
if (!await waitUp()) { console.log('FAIL  后端第二次重启失败'); process.exit(1); }
const mode2 = (await api('/api/health')).body || {};
await api('/api/vars/declare', { variables: VARS });
const after4 = (await api('/api/vars')).body?.vars || {};
ok('PLC 模式重启后：勾了保持的值还在（88）', after4['内测_计数'] === 88,
  JSON.stringify({ mode: mode2.mode, 内测_计数: after4['内测_计数'] }));
ok('PLC 模式重启后：没勾保持的回到变量表初值（5，不是 66）', after4['内测_临时'] === 5,
  JSON.stringify({ 内测_临时: after4['内测_临时'] }));

/* ═══════════ 5. 脚本全局可用（hmi.get/set → 后端） ═══════════ */
await api('/api/vars/declare', { variables: VARS });
const scripted = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.data.variables = JSON.parse(JSON.stringify(project.data.variables));
  const { backend } = await import('/js/api/backend.js');
  await backend.probe();
  const res = await backend.writeVar('内测_计数', 77);
  const r = await fetch('/api/vars');
  const j = await r.json();
  return { wrote: !!res, back: j.vars?.['内测_计数'] };
});
ok('脚本那条路（hmi.set → 后端写变量）对内部变量照样下发', scripted.wrote && scripted.back === 77,
  JSON.stringify(scripted));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== HMI 内部掉电保持变量回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
