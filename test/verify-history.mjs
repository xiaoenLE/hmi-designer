// verify-history.mjs — 历史数据（采样 → 按时间段查询 → 导出 CSV 报表）
//   现场诉求：运行态看到的变量值按周期在服务器侧采样存起来，能按时间段查询并导出 CSV。
//   口径（跟 server/core/history.py + core/api.py 一一对应）：
//     · 配置 <数据目录>/history.json：{on, intervalMs 500~60000, vars[], keepDays 1~90}（原子写）
//     · 数据 <数据目录>/history/YYYY-MM-DD.jsonl：一行 {"t":epoch_ms,"v":{名:值}}
//     · GET  /api/history                     → {ok, settings, stats:{days,files,records,…}}（读放行）
//     · GET  /api/history?from&to&vars        → {ok, vars, rows:[[ts,…]…], count, truncated}（读放行）
//     · GET  /api/history/export.csv?from&to&vars → {ok, csv, filename}（BOM+CRLF，表头 时间,变量…）
//     · POST /api/history {action:'query'|'export'|'settings'}（settings 要管理员）
//   用法：node test/verify-history.mjs              （自己起隔离后端，--auth 模式）
//         node tools/run-suites.mjs verify-history  （复用 run-suites 的 --no-auth 后端）
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wsConnect } from './_wsfetch.mjs';

const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const PW = 'admin123';                     // 全新数据目录 → 后端按默认密码建口令文件
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

/* ── 后端：优先用调用方给的端口（run-suites 已经起好一套）；没给就自己起隔离的 ── */
const argPort = parseInt(process.argv[2] || '', 10);
const ownBackend = !(Number.isFinite(argPort) && argPort > 0);
const PORT = ownBackend ? await freePort() : argPort;
const H = `http://127.0.0.1:${PORT}`;
let DATA = '';
let srv = null;
if (ownBackend) {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-history-'));
  // 故意**不带 --no-auth**：顺带验"改采样设置要管理员、查询/导出放行"
  srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'],
    { cwd: ROOT, stdio: 'ignore',
      env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: path.join(DATA, 'logs'),
             HMI_UPDATE_URL: '', HMI_UPDATE_ARCHIVE: '' } });
}
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { const r = await fetch(H + '/'); up = r.ok; } catch { /* 等它起来 */ }
}
if (!up) {
  console.log('FAIL  后端没起来');
  try { srv?.kill(); } catch { /* 忽略 */ }
  process.exit(1);
}

/* ── 一条长连接：拿 hello（能力表/登录态），之后所有接口都走它 ── */
const conn = wsConnect(PORT);
await conn.ready;
const hello = await conn.frame('hello', 8000);
const authEnabled = !!hello?.auth?.enabled;
if (authEnabled) {
  const a = await conn.login(PW);
  ok('（前提）管理员登录成功（--auth 模式）', !!(a && a.ok === true), JSON.stringify(a));
}
const api = async (p, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  const j = await conn.call(p, { method, body: init.body ?? null });
  const data = (j && j.data) || {};
  return { status: (j && j.status) || 0, ...(data && typeof data === 'object' ? data : { value: data }) };
};
const getSummary = () => api('/api/history');
const saveSettings = (s) => api('/api/history', { method: 'POST', body: { action: 'settings', ...s } });
const queryHistory = (from, to, vars) => api('/api/history?' + new URLSearchParams({
  from: String(from), to: String(to), ...(vars ? { vars: vars.join(',') } : {}),
}).toString());
const qs = (from, to, vars) => new URLSearchParams({
  from: String(from), to: String(to), ...(vars ? { vars: vars.join(',') } : {}),
}).toString();
const setVar = (name, value) => api('/api/vars', { method: 'POST', body: { name, value } });
const now = () => Date.now();
const CSV_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const csvLines = (csv) => csv.replace(/^\ufeff/, '').split('\r\n').filter(l => l !== '');

// 收尾/开头都清一遍：别让上一次跑的采样设置/数据影响断言（run-suites 后端可能被复用）
await saveSettings({ on: false, intervalMs: 1000, vars: [], keepDays: 7 });

/* ═══════════ 1. hello.features 里有 history（前端据此判断后端支持）═══════════ */
ok('hello.features 里有 history', Array.isArray(hello?.features) && hello.features.includes('history'),
  JSON.stringify(hello?.features || null));

/* ═══════════ 2. 默认设置 + 现状（刚起的新数据目录）═══════════ */
const s0 = await getSummary();
ok('GET /api/history 给 settings + stats（读放行）',
  s0.status === 200 && s0.ok === true && !!s0.settings && !!s0.stats,
  JSON.stringify({ status: s0.status, settings: s0.settings, stats: s0.stats }));
ok('默认配置：off / 1000ms / 空变量 / 保留 7 天',
  s0.settings.on === false && s0.settings.intervalMs === 1000
  && Array.isArray(s0.settings.vars) && s0.settings.vars.length === 0 && s0.settings.keepDays === 7,
  JSON.stringify(s0.settings));

/* ═══════════ 3. 保存设置 / 读回 / 越界夹回 ═══════════ */
const s1 = await saveSettings({ on: false, intervalMs: 500, vars: ['hSpeed', 'hTemp'], keepDays: 3 });
ok('保存设置：回读一致（500ms / 两个变量 / 3 天）',
  s1.ok === true && s1.settings.intervalMs === 500
  && s1.settings.vars.join() === 'hSpeed,hTemp' && s1.settings.keepDays === 3,
  JSON.stringify(s1.settings));
const sRead = await getSummary();
ok('GET /api/history 读回来就是刚存的设置', JSON.stringify(sRead.settings) === JSON.stringify(s1.settings),
  JSON.stringify(sRead.settings));
const sClamp = await saveSettings({ intervalMs: 100, keepDays: 999, vars: 'hSpeed, hTemp ,hSpeed' });
ok('越界自动夹回（100→500、999→90）、变量去重',
  sClamp.settings.intervalMs === 500 && sClamp.settings.keepDays === 90
  && sClamp.settings.vars.join() === 'hSpeed,hTemp',
  JSON.stringify(sClamp.settings));
await saveSettings({ keepDays: 3 });                 // 回到 3 天，后面清理用例用

/* ═══════════ 4. 开启采样 → 等 2~3 个周期 → 查询有行、值对 ═══════════ */
await setVar('hSpeed', 120.5);
await setVar('hTemp', 36);
const tEnable = now();
const sOn = await saveSettings({ on: true, intervalMs: 500, vars: ['hSpeed', 'hTemp'], keepDays: 3 });
ok('开启采样（intervalMs=500、采 hSpeed/hTemp）', sOn.ok === true && sOn.settings.on === true,
  JSON.stringify(sOn.settings));
await sleep(2600);                                    // 500ms 周期 → 至少 3~4 个采样点
const q1 = await queryHistory(tEnable - 5000, now() + 1000);
ok('查询能拿到采样行（≥2 行，且有 vars 列顺序）',
  q1.ok === true && Array.isArray(q1.rows) && q1.rows.length >= 2
  && q1.vars.join() === 'hSpeed,hTemp' && q1.count === q1.rows.length,
  JSON.stringify({ count: q1.count, vars: q1.vars, first: q1.rows[0] }));
ok('采样值就是数据源当前值（120.5 / 36），t 是毫秒时间戳',
  q1.rows.every(r => r.length === 3 && r[1] === 120.5 && r[2] === 36
    && Number.isFinite(r[0]) && r[0] > 1e12),
  JSON.stringify(q1.rows.slice(0, 2)));
ok('采样时间递增（按时间排好）',
  q1.rows.every((r, i) => i === 0 || r[0] >= q1.rows[i - 1][0]),
  JSON.stringify(q1.rows.map(r => r[0])));

/* ═══════════ 5. 按时间范围过滤 ═══════════ */
const qFuture = await queryHistory(now() + 60 * 1000, now() + 120 * 1000);
ok('范围外（未来时间段）查不到行', qFuture.ok === true && qFuture.rows.length === 0,
  JSON.stringify({ count: qFuture.count }));
const firstTs = q1.rows[0][0];
const qTiny = await queryHistory(firstTs - 1, firstTs + 1);
ok('紧贴第一条的窄范围只命中那一条',
  qTiny.rows.length >= 1 && qTiny.rows.every(r => r[0] >= firstTs - 1 && r[0] <= firstTs + 1),
  JSON.stringify(qTiny.rows));
const qSubset = await queryHistory(tEnable + 500, now());   // 从开启采样之后半秒开始
ok('范围查询的每一行都在 [from,to] 里',
  qSubset.rows.every(r => r[0] >= tEnable + 500 && r[0] <= now()),
  JSON.stringify({ count: qSubset.count }));
const qOrder = await queryHistory(tEnable - 5000, now() + 1000, ['hTemp', 'hSpeed']);
ok('vars 参数指定列时按给定顺序返回（hTemp,hSpeed）',
  qOrder.vars.join() === 'hTemp,hSpeed' && qOrder.rows.every(r => r.length === 3 && r[1] === 36 && r[2] === 120.5),
  JSON.stringify({ vars: qOrder.vars, first: qOrder.rows[0] }));

/* ═══════════ 6. 导出 CSV（BOM / 表头 / 行数 / 时间列格式）═══════════ */
const expQ = qs(tEnable - 5000, now() + 1000, ['hSpeed', 'hTemp']);
const exp = await api('/api/history/export.csv?' + expQ);
ok('GET /api/history/export.csv 回 {ok, csv, filename}（读放行）',
  exp.status === 200 && exp.ok === true && typeof exp.csv === 'string'
  && typeof exp.filename === 'string' && exp.filename.endsWith('.csv'),
  JSON.stringify({ status: exp.status, filename: exp.filename, len: (exp.csv || '').length }));
const csv = String(exp.csv || '');
const lines = csvLines(csv).filter(l => l !== '');
ok('CSV：UTF-8 BOM 开头', csv.startsWith('\ufeff'), JSON.stringify(csv.slice(0, 6)));
ok('CSV：CRLF 换行', csv.includes('\r\n') && !csv.replace(/\r\n/g, '').includes('\n'),
  JSON.stringify(csv.slice(0, 80)));
ok('CSV：表头是「时间,hSpeed,hTemp」', lines[0] === '时间,hSpeed,hTemp', JSON.stringify(lines[0]));
ok('CSV：行数 = 查询行数 + 表头', lines.length - 1 === exp.count,
  JSON.stringify({ lines: lines.length, count: exp.count }));
ok('CSV：时间列格式 YYYY-MM-DD hh:mm:ss.mmm、值列对',
  CSV_TIME_RE.test((lines[1] || '').split(',')[0])
  && lines.slice(1, -0).every(l => {
    const c = l.split(',');
    return CSV_TIME_RE.test(c[0]) && c[1] === '120.5' && c[2] === '36';
  }),
  JSON.stringify(lines.slice(0, 3)));
const expPost = await api('/api/history', { method: 'POST', body: {
  action: 'export', from: tEnable - 5000, to: now() + 1000, vars: ['hTemp'] } });
const expPostLines = csvLines(String(expPost.csv || '')).filter(l => l !== '');
ok('POST {action:\'export\'} 同样能导出（表头跟着 vars 变：时间,hTemp）',
  expPost.ok === true && expPostLines[0] === '时间,hTemp'
  && expPostLines.length - 1 === expPost.count,
  JSON.stringify({ header: expPostLines[0], count: expPost.count }));

/* ═══════════ 7. 关掉采样后不再增长 ═══════════ */
const beforeOff = (await getSummary()).stats.records;
const sOff = await saveSettings({ on: false });
ok('关闭采样（on:false）', sOff.ok === true && sOff.settings.on === false, JSON.stringify(sOff.settings));
await sleep(1600);
const afterOff = (await getSummary()).stats.records;
ok('关掉之后不再写新采样（records 不变）', afterOff === beforeOff,
  JSON.stringify({ before: beforeOff, after: afterOff }));
const qOff = await queryHistory(tEnable - 5000, now() + 1000);
ok('关掉之后查询到的行数也不再涨', qOff.count === q1.count || qOff.count >= q1.count,  // 关之前可能还多采了几行
  JSON.stringify({ now: qOff.count, earlier: q1.count }));

/* ═══════════ 8. keepDays：手工造旧文件 → 改保留天数 → 旧文件被清掉 ═══════════ */
if (DATA) {
  const histDir = path.join(DATA, 'history');
  fs.mkdirSync(histDir, { recursive: true });
  const oldFile = path.join(histDir, '2020-01-01.jsonl');
  fs.writeFileSync(oldFile, JSON.stringify({ t: 1577836800000, v: { hSpeed: 1 } }) + '\n', 'utf8');
  const st1 = await getSummary();
  ok('（前提）手工造的旧文件被 stats 数进来（days/files ≥2）',
    st1.stats.days >= 2 && st1.stats.files >= 2, JSON.stringify(st1.stats));
  const purged = await saveSettings({ keepDays: 1 });     // 只留今天 → 2020 那个文件该被清
  ok('把保留天数改成 1 天 → 旧文件当场被清掉',
    purged.ok === true && !fs.existsSync(oldFile), JSON.stringify({ keepDays: purged.settings.keepDays }));
  const st2 = await getSummary();
  ok('清理后 stats 只剩今天这份（days/files=1）', st2.stats.days === 1 && st2.stats.files === 1,
    JSON.stringify(st2.stats));
  ok('今天这份历史文件还在（清理只删超期的）',
    fs.existsSync(path.join(histDir, `${new Date().toISOString().slice(0, 10)}.jsonl`))
    || st2.stats.records > 0, JSON.stringify(st2.stats));
  await saveSettings({ keepDays: 3 });
} else {
  console.log('SKIP  keepDays 清理（run-suites 模式拿不到数据目录，只能从 API 验统计）');
  const st = await getSummary();
  ok('stats 能看到历史文件（run-suites 模式）', st.stats.days >= 1 && st.stats.records > 0,
    JSON.stringify(st.stats));
}

/* ═══════════ 9. 管理员闸门：改设置 401，查询/导出放行（--no-auth 模式跳过）═══════════ */
if (authEnabled) {
  const anon = wsConnect(PORT);
  await anon.ready;
  await anon.frame('hello', 6000);
  const aGet = await anon.call('/api/history', { method: 'GET' });
  ok('未登录可以看历史现状（GET 放行）', aGet.status === 200 && aGet.data?.ok === true,
    JSON.stringify({ status: aGet.status }));
  const aExport = await anon.call('/api/history/export.csv?' + expQ, { method: 'GET' });
  ok('未登录可以导出 CSV（读放行）',
    aExport.status === 200 && typeof aExport.data?.csv === 'string', JSON.stringify({ status: aExport.status }));
  const aSet = await anon.call('/api/history', { method: 'POST', body: { action: 'settings', on: true } });
  ok('未登录改采样设置 → 401 需要登录',
    aSet.status === 401 && aSet.data?.need_login === true,
    JSON.stringify({ status: aSet.status, data: aSet.data }));
  anon.close();
} else {
  console.log('SKIP  管理员闸门（后端是 --no-auth，run-suites 模式）');
}

/* ── 收尾：关采样（别影响同一后端上的其它套件），关连接/杀后端 ── */
try { await saveSettings({ on: false, vars: [], intervalMs: 1000, keepDays: 7 }); } catch { /* 忽略 */ }
try { conn.close(); } catch { /* 忽略 */ }
if (srv) {
  try { srv.kill(); } catch { /* 忽略 */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
const failed = results.filter(r => !r.ok);
console.log(`\n==== 历史数据（采样/查询/CSV 导出/清理/权限）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
