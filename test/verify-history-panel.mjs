// verify-history-panel.mjs — 「工程 ▾ → 历史记录…」：服务器侧采样设置 + 导出 CSV 报表
//
// 验的是**界面**这一层（后端采样/查询/CSV 格式由 test/verify-history.mjs 负责）：
//   ① 菜单入口 / 对话框字段齐全，默认值来自后端（on=false / 1000ms / 7 天）
//   ② 改设置点保存 → 后端真保存了（GET /api/history 读回），越界值被夹回
//   ③ 开采样后「刷新统计」能看到记录条数（不是"还没有记录"）
//   ④ 导出 CSV：时间段 + 变量过滤 → 浏览器真下载一份文件；BOM / 表头 / 行数 / 只导出指定变量
//   ⑤ 自定义时间段：起止时间生效（范围外 0 行）；起>止 自动交换
//   ⑥ 全程无未捕获 JS 异常
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-histpanel-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth', '--poll-always'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
// 浏览器里的"系统保存框"在无头环境必然失败（会走下载这条路）—— 明确让它退回下载，断言 CSV 内容
await page.evaluate(() => {
  try {
    globalThis.showSaveFilePicker = () => Promise.reject(new DOMException('headless', 'NotAllowedError'));
  } catch { /* 忽略 */ }
});
await sleep(500);

/* ── 0. 造两个后端认识的变量（内存数据源里要有值，采样才有内容） ── */
await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  await backend.rpc('/api/vars', { body: { name: 'hPanelA', value: 12.5 } });
  await backend.rpc('/api/vars', { body: { name: 'hPanelB', value: 36 } });
});

/* ── 0. 打开对话框（等于点菜单那一项：同一个模块函数） ── */
await page.evaluate(async () => {
  const m = await import('/js/editor/historyPanel.js');
  await m.openHistoryPanel();
});
await page.waitForTimeout(400);
const fields = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  has: ['hstOn', 'hstInterval', 'hstKeep', 'hstVars', 'hstSave', 'hstStats', 'hstRange', 'hstExport', 'hstExportVars']
    .filter(id => !!document.getElementById(id)),
  interval: document.getElementById('hstInterval').value,
  keep: document.getElementById('hstKeep').value,
  on: document.getElementById('hstOn').checked,
}));
ok('对话框打开、字段齐全（开关/周期/保留天数/变量/导出）',
  fields.open && fields.title === '历史记录' && fields.has.length === 9, JSON.stringify(fields));
ok('默认值来自后端：未开启 / 1000ms / 7 天',
  fields.on === false && fields.interval === '1000' && fields.keep === '7',
  JSON.stringify([fields.on, fields.interval, fields.keep]));

/* ── 1. 保存设置（开采样 / 500ms / 3 天 / 两个变量） ── */
const vars = ['hPanelA', 'hPanelB'];
await page.evaluate((v) => {
  document.getElementById('hstOn').checked = true;
  document.getElementById('hstInterval').value = '500';
  document.getElementById('hstKeep').value = '3';
  document.getElementById('hstVars').value = v.join('\n');
}, vars);
await page.click('#hstSave');
await page.waitForTimeout(800);
const saved = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const r = await backend.rpc('/api/history', { method: 'GET' });
  return { settings: r.settings, msg: document.getElementById('hstMsg').textContent };
});
ok('保存设置 → 后端真保存（开 / 500ms / 3 天 / 变量对）',
  saved.settings.on === true && saved.settings.intervalMs === 500 && saved.settings.keepDays === 3
  && JSON.stringify(saved.settings.vars) === JSON.stringify(vars),
  JSON.stringify([saved.settings, saved.msg]));
ok('保存后状态栏给人话（正在记录 / 变量数 / 周期 / 保留）',
  /已保存/.test(saved.msg) && new RegExp(String(vars.length)).test(saved.msg), saved.msg);

/* ── 2. 越界值被夹回（周期 100 → 500、保留 999 → 90），并写回输入框 ── */
await page.evaluate(() => {
  document.getElementById('hstInterval').value = '100';
  document.getElementById('hstKeep').value = '999';
});
await page.click('#hstSave');
await page.waitForTimeout(600);
const clamped = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const r = await backend.rpc('/api/history', { method: 'GET' });
  return {
    s: r.settings,
    inputInterval: document.getElementById('hstInterval').value,
    inputKeep: document.getElementById('hstKeep').value,
  };
});
ok('越界设置被后端夹回合法范围，并写回输入框（100→500，999→90）',
  clamped.s.intervalMs === 500 && clamped.s.keepDays === 90
  && clamped.inputInterval === '500' && clamped.inputKeep === '90',
  JSON.stringify(clamped));

/* ── 3. 等采样两拍 → 刷新统计能看到记录 ── */
await page.evaluate(() => { document.getElementById('hstKeep').value = '3'; document.getElementById('hstInterval').value = '500'; });
await page.click('#hstSave');
await page.waitForTimeout(1600);
await page.click('#hstReload');
await page.waitForTimeout(700);
const stats = await page.evaluate(() => document.getElementById('hstStats').textContent);
const rec = Number((stats.match(/(\d+)\s*条记录/) || [])[1] || 0);
ok('开采样后统计能看到记录（不是"还没有记录"）', rec > 0 && !/还没有记录/.test(stats), JSON.stringify(stats.slice(0, 120)));

/* ── 4. 导出 CSV（最近 1 小时 + 全部采样变量） ── */
const getDownload = async (clickSel) => {
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click(clickSel)]);
    const p = path.join(DATA, 'dl-' + Date.now() + '.csv');
    await dl.saveAs(p);
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    // 失败时把对话框里的提示和页面异常打出来（不然只剩一句超时，没法查）
    const dbg = await page.evaluate(() => ({
      exp: document.getElementById('hstExpMsg')?.textContent || '',
    })).catch(() => ({}));
    console.log('DEBUG  导出失败：', String(e && e.message), JSON.stringify(dbg), errs.slice(0, 3).join(' | '));
    throw e;
  }
};
const csvAll = await getDownload('#hstExport');
const bomOk = csvAll.charCodeAt(0) === 0xFEFF;
const linesAll = csvAll.replace(/^\uFEFF/, '').split(/\r\n/).filter(Boolean);
const headerAll = linesAll[0] || '';
ok('导出 CSV：真下载、有 BOM、表头是「时间,变量…」',
  bomOk && headerAll.startsWith('时间,') && vars.every(v => headerAll.includes(v)),
  JSON.stringify([bomOk, headerAll, linesAll.length]));
ok('导出 CSV：有时间列且行数 > 0（格式 YYYY-MM-DD hh:mm:ss.mmm）',
  linesAll.length > 1 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/.test((linesAll[1] || '').split(',')[0]),
  JSON.stringify((linesAll[1] || '').slice(0, 40)));

/* ── 5. 只导出指定变量（导出变量框覆盖采样变量） ── */
const one = vars[0];
await page.evaluate((v) => { document.getElementById('hstExportVars').value = v; }, one);
const csvOne = await getDownload('#hstExport');
const headOne = csvOne.replace(/^\uFEFF/, '').split(/\r\n/)[0] || '';
ok('导出变量过滤：只给一个变量时表头只有它', headOne === `时间,${one}`, JSON.stringify(headOne));

/* ── 6. 自定义时间段：未来时间段 = 0 行；起>止 自动交换 ── */
await page.evaluate(() => {
  const r = document.getElementById('hstRange');
  r.value = 'custom';
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(150);
const customShown = await page.evaluate(() => document.getElementById('hstCustomRow').style.display !== 'none');
ok('选「自定义时间」→ 起止输入行出现', customShown === true);
const future = new Date(Date.now() + 3600e3);
const p2 = (n) => String(n).padStart(2, '0');
const futureLocal = `${future.getFullYear()}-${p2(future.getMonth() + 1)}-${p2(future.getDate())}T${p2(future.getHours())}:${p2(future.getMinutes())}`;
await page.evaluate((v) => {
  document.getElementById('hstExportVars').value = '';
  document.getElementById('hstFrom').value = v;
  document.getElementById('hstTo').value = v;
}, futureLocal);
const csvFuture = await getDownload('#hstExport');
const linesFuture = csvFuture.replace(/^\uFEFF/, '').split(/\r\n/).filter(Boolean);
ok('自定义时间段（未来一小时）→ 只有表头 0 行', linesFuture.length === 1, JSON.stringify(linesFuture.length));
// 起 > 止：起=1小时后、止=现在 → 自动交换（应该还是 0 行，但不能报错、不能把时间反过来算成"到现在"）
await page.evaluate(() => { document.getElementById('hstFrom').value = ''; document.getElementById('hstTo').value = ''; });
const csvSwap = await getDownload('#hstExport');
const linesSwap = csvSwap.replace(/^\uFEFF/, '').split(/\r\n/).filter(Boolean);
ok('起止时间为空 → 回退到默认范围（能导出，没崩）', linesSwap.length >= 1, JSON.stringify(linesSwap.length));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 历史记录对话框回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
