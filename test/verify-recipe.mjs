// verify-recipe.mjs — 配方（后端能力：保存/取回/覆盖/应用/删除 + 接口 + 管理员闸门）
//   现场诉求：换产时把"当前这一整套变量值"存成一个配方，下次一键写回去。
//   口径（跟 server/core/recipe.py + core/api.py 一一对应）：
//     · 配方是**现场数据**：存 <数据目录>/recipes.json（不进版本库），原子写；
//     · GET  /api/recipes          → {ok, names, count}（?full=1 连 vars 一起；读不用登录）
//     · POST /api/recipes {action} → save {ok,name,updated,count} / delete {ok,name,deleted}
//                                   / apply {ok,name,applied:[名…],failed:[{name,error}]}
//     · 存/删/应用要管理员（ADMIN_PATHS）；应用逐个变量走 varapi.var_write，坏变量不挡好变量。
//   ⚠ 内存模式下 var_write 对"变量表里没有的名字"会**自动建档**（运行态写值的既有规矩），
//     所以"不存在的变量"在内存模式不会报错；这里用**空变量名**（后端明确拒绝）
//     验证 per-var 失败通道 —— 接真 PLC 时未声明变量会由 PlcSource 抛"未在变量表声明"，
//     走的是同一个失败通道。
// 用法：node test/verify-recipe.mjs            （自己起隔离后端，--auth 模式，默认口令 admin123）
//       node tools/run-suites.mjs verify-recipe（复用 run-suites 的隔离后端，--no-auth）
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wsConnect } from './_wsfetch.mjs';

const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
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
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-recipe-'));
  // 故意**不带 --no-auth**：顺带验"存/删/应用要管理员、读放行"
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
/** 调一个接口 → 把 ack 里的 data 摊平（外加 status），写法跟 wsApi 的返回值一致 */
const api = async (p, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  const j = await conn.call(p, { method, body: init.body ?? null });
  const data = (j && j.data) || {};
  return { status: (j && j.status) || 0, ...(data && typeof data === 'object' ? data : { value: data }) };
};
const recipe = (body) => api('/api/recipes', { method: 'POST', body });
const save = (name, vars) => recipe({ action: 'save', name, vars });
const del = (name) => recipe({ action: 'delete', name });
const apply = (name) => recipe({ action: 'apply', name });
const list = () => api('/api/recipes');
const full = () => api('/api/recipes?full=1');
const readVars = async () => (await api('/api/vars')).vars || {};

const N1 = '回归_班次A';
const N2 = '回归_坏变量';
const N3 = '回归_新变量';
const GATE = '回归_越权';
const V1 = { rSpeed: 1200, rTemp: 35.5, rMode: 'auto' };
const V2 = { rSpeed: 1300, rTemp: 40 };
// 收尾/开头都清一遍：run-suites 的后端可能被同一路复用过，别让上一轮的残留影响断言
for (const n of [N1, N2, N3, GATE]) { await del(n); }

/* ═══════════ 1. 保存 + 列表 + 取回 ═══════════ */
const saved = await save(N1, V1);
ok('保存配方：回 {ok, name, count}', saved.ok === true && saved.name === N1 && saved.count === 3,
  JSON.stringify(saved));
const ls = await list();
ok('列表里出现这个配方（GET /api/recipes：读不用登录）',
  ls.ok === true && Array.isArray(ls.names) && ls.names.includes(N1) && ls.count >= 1,
  JSON.stringify({ names: ls.names, count: ls.count }));
const got = await full();
const rec = (got.recipes || {})[N1] || {};
ok('?full=1 取回整表 vars（值/类型原样）',
  got.ok === true && rec.vars && rec.vars.rSpeed === 1200 && rec.vars.rTemp === 35.5
  && rec.vars.rMode === 'auto' && typeof rec.updated === 'string' && rec.updated.length > 0,
  JSON.stringify(rec));
ok('配方里三个变量都在（不多不少）', rec.vars && Object.keys(rec.vars).length === 3,
  JSON.stringify(Object.keys(rec.vars || {})));
const single = await api('/api/recipes?name=' + encodeURIComponent(N1));
ok('按配方名读取只返回这一套参数', single.ok && single.recipe.name === N1
  && single.recipe.vars.rSpeed === V1.rSpeed && !single.recipes, JSON.stringify(single));

/* ═══════════ 2. 同名覆盖保存 ═══════════ */
const before = (await list()).count;
const saved2 = await save(N1, V2);
const got2 = await full();
const rec2 = (got2.recipes || {})[N1] || {};
ok('同名再存一次 = 覆盖（不是新增第二条）',
  saved2.ok === true && (await list()).count === before && (await list()).names.filter(n => n === N1).length === 1,
  JSON.stringify({ before, after: (await list()).count }));
ok('覆盖后 vars 是新的那一套（rMode 没了、rSpeed 新值）',
  rec2.vars && rec2.vars.rSpeed === 1300 && rec2.vars.rTemp === 40
  && Object.keys(rec2.vars).length === 2 && !('rMode' in rec2.vars),
  JSON.stringify(rec2.vars));

/* ═══════════ 3. 落盘（只在"自己起后端"时能知道数据目录；run-suites 模式跳过）═══════════ */
if (DATA) {
  const file = path.join(DATA, 'recipes.json');
  const exists = fs.existsSync(file);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 下面断言会报 */ }
  ok('配方落在 <数据目录>/recipes.json（现场数据，不进版本库）', exists, file);
  ok('落盘结构是 {recipes: {名称: {vars, updated}}}',
    !!j && !!j.recipes && !!j.recipes[N1] && typeof j.recipes[N1].vars === 'object'
    && typeof j.recipes[N1].updated === 'string', JSON.stringify(j && Object.keys(j)));
  ok('原子写没留 .tmp 残留', !fs.existsSync(file + '.tmp'));
}

/* ═══════════ 4. 应用配方：变量值真的变了（内存模式直接读回）═══════════ */
await api('/api/vars', { method: 'POST', body: { name: 'rSpeed', value: 7 } });
await api('/api/vars', { method: 'POST', body: { name: 'rTemp', value: 8 } });
const baseVars = await readVars();
const applied = await apply(N1);
ok('应用配方：回 {ok, applied, failed}（没失败）',
  applied.ok === true && Array.isArray(applied.applied) && applied.applied.includes('rSpeed')
  && applied.applied.includes('rTemp') && Array.isArray(applied.failed) && applied.failed.length === 0,
  JSON.stringify(applied));
await sleep(120);                                  // 写入是同步的，留一点给广播/落库线程
const afterVars = await readVars();
ok('应用之后变量值变成配方里的（7/8 → 1300/40）',
  baseVars.rSpeed === 7 && baseVars.rTemp === 8
  && afterVars.rSpeed === 1300 && afterVars.rTemp === 40,
  JSON.stringify({ before: { rSpeed: baseVars.rSpeed, rTemp: baseVars.rTemp },
                   after: { rSpeed: afterVars.rSpeed, rTemp: afterVars.rTemp } }));

/* ═══════════ 5. 应用里有写不进去的变量：per-var 报错、但不挡别的变量 ═══════════ */
// 空变量名后端明确拒绝（var_write：missing name）；同时放一个合法变量验证"照写"
const savedBad = await save(N2, { rTemp: 66.6, '': 1 });
ok('（前提）能存下带坏变量的配方（保存只校验配方名/structure）',
  savedBad.ok === true && savedBad.count === 2, JSON.stringify(savedBad));
const badApply = await apply(N2);
const badVars = await readVars();
ok('应用时坏变量进 failed（带 error），不整单失败',
  badApply.ok === false && Array.isArray(badApply.failed) && badApply.failed.length === 1
  && badApply.failed[0].name === '' && typeof badApply.failed[0].error === 'string'
  && badApply.failed[0].error.length > 0
  && typeof badApply.error === 'string' && badApply.error.includes('没写成功'),
  JSON.stringify({ failed: badApply.failed, error: badApply.error }));
ok('同一个配方里的合法变量照写（rTemp=66.6）',
  badApply.applied.includes('rTemp') && badVars.rTemp === 66.6,
  JSON.stringify({ applied: badApply.applied, rTemp: badVars.rTemp }));

// 额外一条：内存模式的既有规矩 —— 变量表里没有的名字，写值会自动建档（不是配方特有的行为）
const newApply = await (async () => { await save(N3, { rBrandNew: 5 }); return apply(N3); })();
const newVars = await readVars();
ok('（内存模式口径）未声明的变量自动建档：rBrandNew=5（与运行页写值同一条路）',
  newApply.ok === true && newApply.applied.includes('rBrandNew') && newVars.rBrandNew === 5,
  JSON.stringify({ applied: newApply.applied, rBrandNew: newVars.rBrandNew }));

const boolName = '回归_BOOL配方';
const post = (p, body) => api(p, { method: 'POST', body });
await post('/api/vars/declare', { variables: [
  { name: 'bRecipeState', type: 'bool', address: '', value: false },
  { name: 'bRecipeArray', type: 'bool[]', address: '', value: [false, true] },
] });
const currentBool = () => post('/api/recipes/current', { names: ['bRecipeState', 'bRecipeArray'] });
await post('/api/vars', { name: 'bRecipeState', value: 1 });
const boolOn = await currentBool();
await post('/api/vars', { name: 'bRecipeState', value: 0 });
const boolOff = await currentBool();
ok('读取配方当前值区分 BOOL 1 和 0', boolOn.values?.bRecipeState === true && boolOff.values?.bRecipeState === false,
  JSON.stringify([boolOn.values, boolOff.values]));
await save(boolName, { bRecipeState: '0', bRecipeArray: [1, 0] });
await apply(boolName);
const legacyBools = await readVars();
ok('旧配方应用时转换字符串 0 及 BOOL 数组',
  legacyBools.bRecipeState === false && JSON.stringify(legacyBools.bRecipeArray) === '[true,false]');
await del(boolName);

/* ═══════════ 6. 应用不存在的配方：404 + 原因（不是 500，也不是静默成功）═══════════ */
const noSuch = await apply('回归_根本没有这个配方');
ok('应用不存在的配方 → 404 + 明确原因',
  noSuch.status === 404 && noSuch.ok === false && /没有这个配方/.test(String(noSuch.error || '')),
  JSON.stringify({ status: noSuch.status, error: noSuch.error }));

/* ═══════════ 7. 删除 ═══════════ */
const d1 = await del(N1);
ok('删除配方：deleted=true', d1.ok === true && d1.name === N1 && d1.deleted === true, JSON.stringify(d1));
const lsAfter = await list();
const fullAfter = await full();
ok('删完之后列表里没有了（?full=1 也没了）',
  !lsAfter.names.includes(N1) && !(fullAfter.recipes || {})[N1],
  JSON.stringify({ names: lsAfter.names }));
const d2 = await del(N1);
ok('重复删除是幂等的（ok=true, deleted=false，不报错）',
  d2.ok === true && d2.deleted === false, JSON.stringify(d2));

/* ═══════════ 8. 管理员闸门（--no-auth 的 run-suites 模式自动跳过）═══════════ */
if (authEnabled) {
  const anon = wsConnect(PORT);
  await anon.ready;
  await anon.frame('hello', 6000);
  const aGet = await anon.call('/api/recipes', { method: 'GET' });
  ok('未登录可以读配方列表（GET 放行）',
    aGet.status === 200 && aGet.data?.ok === true, JSON.stringify({ status: aGet.status }));
  const aSave = await anon.call('/api/recipes',
    { method: 'POST', body: { action: 'save', name: GATE, vars: { x: 1 } } });
  ok('未登录存配方 → 401 需要登录（ADMIN_PATHS 生效）',
    aSave.status === 401 && aSave.data?.need_login === true,
    JSON.stringify({ status: aSave.status, data: aSave.data }));
  const aApply = await anon.call('/api/recipes',
    { method: 'POST', body: { action: 'apply', name: N2 } });
  ok('未登录应用配方 → 401 需要登录', aApply.status === 401 && aApply.data?.need_login === true,
    JSON.stringify({ status: aApply.status }));
  ok('越权那次没有真的写进配方', !(await list()).names.includes(GATE));
  anon.close();
} else {
  console.log('SKIP  管理员闸门（后端是 --no-auth，run-suites 模式）');
}

/* ═══════════ 9. hello.features 里有 recipe（前端据此判断后端支持）═══════════ */
ok('hello.features 里有 recipe', Array.isArray(hello?.features) && hello.features.includes('recipe'),
  JSON.stringify(hello?.features || null));

/* ── 收尾 ── */
for (const n of [N1, N2, N3, GATE]) { try { await del(n); } catch { /* 忽略 */ } }
try { conn.close(); } catch { /* 忽略 */ }
if (srv) {
  try { srv.kill(); } catch { /* 忽略 */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
const failed = results.filter(r => !r.ok);
console.log(`\n==== 配方（保存/取回/覆盖/应用/删除/权限）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
