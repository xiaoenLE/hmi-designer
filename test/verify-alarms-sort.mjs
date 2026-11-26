// verify-alarms-sort.mjs — 报警表点表头排序（名称 / 变量 / 级别）
//
//   现场要求（m01238）：「报警栏那边应该也可以和变量那边一样，可以进行排序」
//   口径：
//     · 点「名称」「变量」「级别」表头 = 排序：第 1 下升序 ▲、第 2 下降序 ▼、第 3 下取消（回工程原始顺序）
//     · 只改**显示顺序**，不动 project.alarms() 的顺序（CSV 导出 / 下发后端仍在原顺序）
//     · 名称/变量用中文排序器（拼音 + 数字按大小：报警2 < 报警10）
//     · 级别按四档优先级排：info 提示 → warn 警告 → alarm 报警 → urgent 紧急（同档保持原相对顺序）
//     · 排序状态记 localStorage['hmi-alarm-sort']（重开页面还按这个排）
//     · 拖列宽的把手（.col-grip）不算点表头；「内容」「阈值」「延时」等列不可排序
//
// 用法：node test/verify-alarms-sort.mjs <port>   （或 node tools/run-suites.mjs verify-alarms-sort）
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
await page.evaluate(() => localStorage.removeItem('hmi-alarm-sort'));
await sleep(300);

await page.click('.lp-tab[data-tab="alarms"]');   // 切到「报警」页签，面板才可见
await sleep(600);

/* 刻意打乱的 8 条：名称（中英混排 / 数字）、变量（大小写）、级别（四档都有）都乱着。 */
const FIXTURE = [
  { name: '报警10', variable: 'Zeta', level: 'warn', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
  { name: '报警2', variable: 'alpha', level: 'urgent', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
  { name: 'bAlarm', variable: 'Temp', level: 'info', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
  { name: 'aAlarm', variable: 'temp2', level: 'alarm', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
  { name: '报警1', variable: 'Speed', level: 'urgent', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
  { name: 'CAlarm', variable: 'pump', level: 'info', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
  { name: '报警20', variable: 'flow', level: 'alarm', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
  { name: 'dAlarm', variable: 'zeta', level: 'warn', text: 'x', op: '>=', value: 1, delaySec: 0, enabled: true },
];
const ORDER = FIXTURE.map(a => a.name);
const RANK = { info: 0, warn: 1, alarm: 2, urgent: 3 };

await page.evaluate((list) => {
  const al = window.app.project.alarms();
  al.length = 0;
  list.forEach((a, i) => al.push({ ...a, id: 'al_sort_' + i }));
  window.app.bus.emit('project:changed');
}, FIXTURE);
await sleep(500);

const rows = () => page.evaluate(() => [...document.querySelectorAll('#alarmTable tr[data-alarm]')].map(tr => ({
  id: tr.dataset.alarm,
  name: tr.querySelector('input[data-k="name"]')?.value ?? '',
  variable: tr.querySelector('input[data-k="variable"]')?.value ?? '',
  level: tr.querySelector('select[data-k="level"]')?.value ?? '',
})));
const names = (rs) => rs.map(r => r.name);
const dirOf = (key) => page.evaluate((k) => {
  const th = document.querySelector(`#alarmTable th.vt-sort[data-sort="${k}"]`);
  return { dir: th?.dataset.dir ?? '', aria: th?.getAttribute('aria-sort') ?? '' };
}, key);
const clickHead = async (key) => { await page.click(`#alarmTable th.vt-sort[data-sort="${key}"]`); await sleep(350); };
/** 用**页面的排序器**验证单调（中文按拼音、数字按大小） */
const zhSorted = (list, dir) => page.evaluate((a) => {
  const c = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const v = a.arr;
  for (let i = 1; i < v.length; i++) {
    const d = c.compare(v[i - 1], v[i]);
    if (a.dir > 0 ? d > 0 : d < 0) return false;
  }
  return true;
}, { arr: list, dir });
const projectOrder = () => page.evaluate(() => window.app.project.alarms().map(a => a.name));

/* ── ① 初始 = 工程原始顺序（不排序） ── */
let rs = await rows();
ok('① 一开始不排序：按工程里的原始顺序显示', JSON.stringify(names(rs)) === JSON.stringify(ORDER), names(rs).join(','));

/* ── ② 点「名称」→ 升序 ── */
await clickHead('name');
rs = await rows();
let d = await dirOf('name');
const ascNames = names(rs);
ok('② 点名称 → 升序：表头出现 ▲（data-dir=asc / aria-sort=ascending）', d.dir === 'asc' && d.aria === 'ascending', JSON.stringify(d));
ok('② 名称升序：确实按名称排好了', await zhSorted(ascNames, 1), ascNames.join(','));
ok('② 数字按大小排：报警2 在 报警10 前面（不是字符串序）',
  ascNames.indexOf('报警2') < ascNames.indexOf('报警10'), ascNames.join(','));
ok('② 英文名按字母：aAlarm 在 dAlarm 前面',
  ascNames.indexOf('aAlarm') < ascNames.indexOf('dAlarm'), ascNames.join(','));

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
const lsAfterCancel = await page.evaluate(() => localStorage.getItem('hmi-alarm-sort'));
ok('④ 第三下取消排序：回工程原始顺序', JSON.stringify(names(rs)) === JSON.stringify(ORDER), names(rs).join(','));
ok('④ 取消后表头不再有箭头，localStorage 记录也清掉', d.dir === '' && d.aria === 'none' && lsAfterCancel === null, `${JSON.stringify(d)} / ${lsAfterCancel}`);

/* ── ⑤ 点「变量」→ 按变量名升序 ── */
await clickHead('variable');
rs = await rows();
d = await dirOf('variable');
const vars = rs.map(r => r.variable);
ok('⑤ 点变量 → 升序：表头 ▲', d.dir === 'asc' && d.aria === 'ascending', JSON.stringify(d));
ok('⑤ 变量名按字母序（大小写不敏感）', await zhSorted(vars, 1), vars.join(','));
ok('⑤ 只按变量排：名称列顺序跟着乱（证明不是名称排序的残留）',
  JSON.stringify(names(rs)) !== JSON.stringify(ascNames), names(rs).join(','));

/* ── ⑥ 点「级别」→ 四档优先级（提示 → 警告 → 报警 → 紧急），同档保持原相对顺序 ── */
await clickHead('level');
rs = await rows();
d = await dirOf('level');
const ranks = rs.map(r => RANK[r.level] ?? 99);
ok('⑥ 点级别 → 升序：表头 ▲', d.dir === 'asc' && d.aria === 'ascending', JSON.stringify(d));
ok('⑥ 级别按优先级排：提示 → 警告 → 报警 → 紧急',
  ranks.every((n, i) => i === 0 || ranks[i - 1] <= n), rs.map(r => `${r.name}:${r.level}`).join(' '));
ok('⑥ 头两条是「提示」，末两条是「紧急」',
  ranks.slice(0, 2).every(n => n === 0) && ranks.slice(-2).every(n => n === 3), ranks.join(','));
ok('⑥ 同档保持原相对顺序（稳定排序）：warn 档里 报警10 仍在 dAlarm 前',
  (() => { const w = rs.filter(r => r.level === 'warn').map(r => r.name); return w.indexOf('报警10') < w.indexOf('dAlarm'); })(),
  rs.filter(r => r.level === 'warn').map(r => r.name).join(','));

/* ── ⑦ 项目数据没被改：project.alarms() 还是原始顺序 ── */
ok('⑦ 排序只改显示，不动 project.alarms() 的顺序（导出/下发仍是原顺序）',
  JSON.stringify(await projectOrder()) === JSON.stringify(FIXTURE.map(a => a.name)), (await projectOrder()).join(','));

/* ── ⑧ 拖列宽的把手不算点表头（点它不能改排序） ── */
const before = (await dirOf('level')).dir;
const gripClicked = await page.evaluate(() => {
  const g = document.querySelector('#alarmTable th.vt-sort[data-sort="level"] .col-grip');
  if (!g) return false;
  g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
});
await sleep(200);
const after = (await dirOf('level')).dir;
ok('⑧ 点列宽把手不触发排序（排序状态不变）', !gripClicked || before === after, `${before} → ${after}`);

/* ── ⑨ 「内容」「阈值」这类列不可排序 ── */
const nonSortable = await page.evaluate(() => {
  const bad = [...document.querySelectorAll('#alarmTable thead th')]
    .filter(th => !th.classList.contains('vt-sort')).length;
  return { sortableCount: document.querySelectorAll('#alarmTable thead th.vt-sort').length, bad };
});
ok('⑨ 只有名称/变量/级别三列可排序', nonSortable.sortableCount === 3, JSON.stringify(nonSortable));

/* ── ⑩ 排序状态记在本机：切成名称升序后刷新页面，还是名称升序 ── */
await clickHead('name');            // 从「级别」切成「名称升序」
const saved = await page.evaluate(() => localStorage.getItem('hmi-alarm-sort'));
ok('⑩ 排序状态记进 localStorage', saved === JSON.stringify({ key: 'name', dir: 1 }), saved || '');
const beforeReload = names(await rows());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(600);
await page.click('.lp-tab[data-tab="alarms"]');
await sleep(600);
const d2 = await dirOf('name');
const afterReload = names(await rows());
ok('⑩ 刷新后还是名称升序（箭头 + 顺序都对）', d2.dir === 'asc' && JSON.stringify(afterReload) === JSON.stringify(beforeReload), `${d2.dir} / ${afterReload.join(',')}`);

/* ── ⑪ 全程无未捕获 JS 异常 ── */
ok('⑪ 全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(results.join('\n'));
const fail = results.filter(r => r.startsWith('FAIL'));
console.log(`\n==== 报警表排序：${results.length - fail.length}/${results.length} 通过 ====`);
process.exit(fail.length ? 1 : 0);
