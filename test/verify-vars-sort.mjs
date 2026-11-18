// verify-vars-sort.mjs — 变量表点表头排序（名称 / 类型 / 地址）
//
//   现场要求（m02097）：「变量这个地方能不能可以实现排序，可以按照名称排或者类型地址等等」
//   口径：
//     · 点「名称」「类型」「地址」表头 = 排序：第 1 下升序 ▲、第 2 下降序 ▼、第 3 下取消（回工程原始顺序）
//     · 只改**显示顺序**，不动 project.variables() 的顺序（CSV 导出 / 下发后端仍在原顺序）
//     · 名称/类型用中文排序器（拼音 + 数字按大小：Cylinder2 < Cylinder10、d100 < d110）
//     · 地址按「区域 → 寄存器号 → 位号」排：线圈 → 离散输入 → 保持寄存器 → 输入寄存器；空地址（内部变量）排最后
//     · 排序状态记 localStorage（重开页面还按这个排）
//     · 拖列宽的把手（.col-grip）不算点表头，不能触发排序；「保持」列不可排序
//
// 用法：node test/verify-vars-sort.mjs <port>     （或 node tools/run-suites.mjs verify-vars-sort）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);

const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(300);

// 变量表的「当页协议」跟着后端走：backend 落盘口径是 protocol=modbus + addr_profile=ts600-modbus-tcp。
// ⚠ 后端每秒推 status，会把 plcInfo/profile 改回它自己的（隔离后端是 INVT）——所以挂个「保持」定时器不停改回来。
await page.evaluate(async () => {
  const u = await import('/js/core/utils.js');
  const { backend } = await import('/js/api/backend.js');
  window.__keepTs = true;
  const keep = () => {
    if (!window.__keepTs) return;
    u.setProfile('ts600-modbus-tcp', false);
    backend.setPlcInfo({ protocol: 'modbus', addr_profile: 'ts600-modbus-tcp' });
  };
  keep();
  window.__keepTimer = setInterval(keep, 100);
  localStorage.removeItem('hmi-vars-sort');
});
await page.click('.lp-tab[data-tab="vars"]');   // 切到「变量」页签，面板才可见
await sleep(600);

/* 刻意打乱的 8 条：名称（中英混排 / 数字）、类型、地址（线圈 M/Y、离散输入 X、保持寄存器 D/%MW、空）都乱着。
   ⚠ 类型要和元件对得上（bool 配位元件、数值配字元件），否则地址解析报错 → 会被当「排不了地址」排在最后。 */
const FIXTURE = [
  { name: 'bMotor', type: 'bool', address: 'M100', value: false },
  { name: 'aStart', type: 'real', address: 'D0', value: 0 },
  { name: 'Cylinder10', type: 'int', address: 'D10', value: 0 },
  { name: 'Cylinder2', type: 'int', address: 'D2', value: 0 },
  { name: '内部计数', type: 'dint', address: '', value: 0 },
  { name: 'xInput', type: 'bool', address: 'X17', value: false },
  { name: 'yOut', type: 'bool', address: 'Y0', value: false },
  { name: 'zLegacy', type: 'uint', address: '%MW100', value: 0 },
];
const ORDER = FIXTURE.map(v => v.name);

await page.evaluate(async (vs) => {
  window.app.project.variables().length = 0;
  for (const v of vs) window.app.project.variables().push({ ...v, len: 0 });
  const { bus } = await import('/js/core/eventBus.js');
  bus.emit('project:changed');
}, FIXTURE);
await sleep(400);

const rows = () => page.evaluate(() => [...document.querySelectorAll('#varRows tr[data-name]')].map(tr => ({
  name: tr.dataset.name,
  type: tr.querySelector('select[data-k="type"]')?.value ?? '',
  addr: tr.querySelector('input[data-k="address"]')?.value ?? '',
})));
const names = (rs) => rs.map(r => r.name);
const dirOf = (key) => page.evaluate((k) => {
  const th = document.querySelector(`#varTable th.vt-sort[data-sort="${k}"]`);
  return { dir: th?.dataset.dir ?? '', aria: th?.getAttribute('aria-sort') ?? '' };
}, key);
const clickHead = async (key) => { await page.click(`#varTable th.vt-sort[data-sort="${key}"]`); await sleep(350); };
/** 用**页面的排序器**验证单调（名称排序：拼音 + 数字按大小） */
const nameSorted = (list, dir) => page.evaluate((a) => {
  const c = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const v = a.arr;
  for (let i = 1; i < v.length; i++) {
    const d = c.compare(v[i - 1], v[i]);
    if (a.dir > 0 ? d > 0 : d < 0) return false;
  }
  return true;
}, { arr: list, dir });

/* ── ① 初始 = 工程原始顺序（不排序） ── */
let rs = await rows();
ok('① 一开始不排序：按工程里的原始顺序显示', JSON.stringify(names(rs)) === JSON.stringify(ORDER), names(rs).join(','));

/* ── ② 点「名称」→ 升序（拼音 + 数字按大小） ── */
await clickHead('name');
rs = await rows();
let d = await dirOf('name');
ok('② 点名称 → 升序：表头出现 ▲（data-dir=asc / aria-sort=ascending）', d.dir === 'asc' && d.aria === 'ascending', JSON.stringify(d));
const ascNames = names(rs);
ok('② 名称升序：确实按名称排好了', await nameSorted(ascNames, 1), ascNames.join(','));
ok('② 数字按大小排：Cylinder2 在 Cylinder10 前面（不是字符串序）',
  ascNames.indexOf('Cylinder2') < ascNames.indexOf('Cylinder10'), ascNames.join(','));
ok('② 英文名按字母：aStart 在 bMotor 前面',
  ascNames.indexOf('aStart') < ascNames.indexOf('bMotor'), ascNames.join(','));

/* ── ③ 再点「名称」→ 降序 ── */
await clickHead('name');
rs = await rows();
d = await dirOf('name');
const descNames = names(rs);
ok('③ 再点名称 → 降序 ▼', d.dir === 'desc' && d.aria === 'descending', JSON.stringify(d));
ok('③ 降序就是升序倒过来', JSON.stringify(descNames) === JSON.stringify([...ascNames].reverse()), descNames.join(','));

/* ── ④ 第三下 → 取消（回工程原始顺序，表头箭头消失、localStorage 清掉） ── */
await clickHead('name');
rs = await rows();
d = await dirOf('name');
const lsAfterCancel = await page.evaluate(() => localStorage.getItem('hmi-vars-sort'));
ok('④ 第三下取消排序：回工程原始顺序', JSON.stringify(names(rs)) === JSON.stringify(ORDER), names(rs).join(','));
ok('④ 取消后表头不再有箭头，localStorage 记录也清掉', d.dir === '' && d.aria === 'none' && lsAfterCancel === null, `${JSON.stringify(d)} / ${lsAfterCancel}`);

/* ── ⑤ 点「类型」→ 按类型顺序排（bool → int → uint → dint → real） ── */
const TYPE_RANK = { bool: 0, int: 1, uint: 2, dint: 3, udint: 4, real: 5, lreal: 6, string: 7, wstring: 8 };
await clickHead('type');
rs = await rows();
const ranks = rs.map(r => TYPE_RANK[r.type] ?? 99);
ok('⑤ 点类型 → 升序：bool → int → uint → dint → real', ranks.every((n, i) => i === 0 || ranks[i - 1] <= n), rs.map(r => r.type).join(','));
ok('⑤ 类型升序的头三条都是 bool', ranks.slice(0, 3).every(n => n === 0), rs.map(r => r.type).join(','));

/* ── ⑥ 点「地址」→ 按区域 + 寄存器号排，空地址排最后 ── */
const addrKey = (addr, vtype) => page.evaluate(async (a) => {
  if (!String(a.addr || '').trim()) return [9, 0, -1];
  const m = await import('/js/core/addrMap.js');
  const u = await import('/js/core/utils.js');
  try {
    const x = m.parseAddr(a.addr, a.vtype || '', u.PROFILE_TS600);
    const rank = { coil: 0, discrete: 1, holding: 2, input_reg: 3 };
    return [rank[x.area] ?? 8, x.offset || 0, x.bit == null ? -1 : x.bit];
  } catch { return [9, 0, -1]; }
}, { addr, vtype });
await clickHead('addr');
rs = await rows();
const keys = [];
for (const r of rs) keys.push(await addrKey(r.addr, r.type));
ok('⑥ 点地址 → 升序：线圈 M/Y → 离散输入 X → 保持寄存器 D/%MW', keys.every((k, i) => i === 0 || keys[i - 1][0] <= k[0]), rs.map(r => `${r.name}:${r.addr}`).join(' '));
ok('⑥ 升序里空地址（内部变量）排最后', keys[keys.length - 1][0] === 9, rs.map(r => `${r.name}:${r.addr}`).join(' '));
ok('⑥ 同区按寄存器号排（M100 在 Y0(=45056) 前；D0 < D2 < D10 < %MW100）',
  keys.every((k, i) => i === 0 || k[0] !== keys[i - 1][0] || k[1] >= keys[i - 1][1]), keys.map(k => k.join('/')).join(' '));

/* ── ⑦ 拖列宽的把手不算点表头（点它不能改排序） ── */
const before = (await dirOf('addr')).dir;
const gripClicked = await page.evaluate(() => {
  const g = document.querySelector('#varTable th.vt-sort[data-sort="addr"] .col-grip');
  if (!g) return false;
  g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
});
await sleep(200);
const after = (await dirOf('addr')).dir;
ok('⑦ 点列宽把手不触发排序（排序状态不变）', !gripClicked || before === after, `${before} → ${after}`);

/* ── ⑧ 「保持」列不可排序 ── */
const keepTh = await page.evaluate(() => {
  document.querySelector('#varTable th.vt-keep')?.click();
  const th = document.querySelector('#varTable th.vt-keep');
  return { sortable: !!th?.classList.contains('vt-sort'), dir: th?.dataset.dir ?? '' };
});
await sleep(200);
ok('⑧ 只有名称/类型/地址可排序，「保持」列点了没反应', !keepTh.sortable && keepTh.dir === '', JSON.stringify(keepTh));

/* ── ⑨ 排序状态记在本机：切成名称升序后刷新页面，还是名称升序 ── */
await clickHead('name');            // 从「地址」切成「名称升序」
const saved = await page.evaluate(() => localStorage.getItem('hmi-vars-sort'));
ok('⑨ 排序状态记进 localStorage', saved === JSON.stringify({ key: 'name', dir: 1 }), saved || '');
const rsBeforeReload = names(await rows());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);
const d2 = await dirOf('name');
const rs2 = names(await rows());
ok('⑨ 刷新后还是名称升序（箭头 + 顺序都对）', d2.dir === 'asc' && rs2.every((n, i) => i === 0 || n === rsBeforeReload[i]), `${d2.dir} / ${rs2.join(',')}`);
ok('⑨ 刷新后顺序确实是按名称升好序的', await nameSorted(rs2, 1), rs2.join(','));

/* ── ⑩ 全程无未捕获 JS 异常 ── */
ok('⑩ 全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(results.join('\n'));
const fail = results.filter(r => r.startsWith('FAIL'));
console.log(`\n==== 变量表排序：${results.length - fail.length}/${results.length} 通过 ====`);
process.exit(fail.length ? 1 : 0);
