// test/verify-comm-api.mjs —— 通讯协议目录 / 单地址校验接口（/api/comm/*）黑盒套件
//
// 用法：
//   node tools/run-suites.mjs verify-comm-api         （自己起隔离后端，推荐）
//   node test/verify-comm-api.mjs [端口]              （连一个已经在跑的仓库后端，默认 8866）
//
// 覆盖：
//   A. GET  /api/comm/protocols  三协议顺序、字段、TS600 前缀、X 只读、OPC UA 无前缀、current
//   B. POST /api/comm/validate   valid / 只读 / empty / model / invalid / 未知协议 400 / 别名
//   C. 老接口 POST /api/plc action=parse 形状不变（兼容）
//   D. 浏览器里走 backend.rpc()（WS {t:'call'}）同一套接口，且页面无 JS 报错
//
// 失败打印真实响应体，便于直接把「实测 JSON」贴给 lead 判定契约偏差。
import { createRequire } from 'node:module';
import { installNodeFetchPatch } from './_wsfetch.mjs';

// playwright-core 不在仓库 node_modules 里，按仓库既有约定从工作区 require
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const PORT = process.argv[2] || '8866';
const HEAD = `http://127.0.0.1:${PORT}`;

// V2 后端只有 WS 长连接一条路：Node 侧的 fetch 走 _wsfetch 的补丁（和 verify-plc 同一套），
// 补丁后 await fetch(HEAD + '/api/comm/…') 等价于页面里 backend.rpc()。
installNodeFetchPatch(HEAD);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const eq = (name, actual, expect) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expect),
    `actual=${JSON.stringify(actual)} expect=${JSON.stringify(expect)}`);
const brief = (v) => {
  try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 400 ? s.slice(0, 400) + '…' : s; }
  catch { return String(v); }
};

let HTTP = 0; // 统计请求数，方便判断是不是后端根本没起
async function api(pathname, opts = {}) {
  HTTP++;
  const init = { method: opts.method || 'GET', headers: { ...(opts.headers || {}) } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  init.signal = AbortSignal.timeout(opts.timeout || 20000);
  let r;
  try { r = await fetch(HEAD + pathname, init); }
  catch (e) { return { status: 0, body: null, error: String(e && e.message || e) }; }
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 800) }; }
  return { status: r.status, body, text };
}
async function validate(payload) {
  const r = await api('/api/comm/validate', { method: 'POST', body: payload });
  return { status: r.status, b: r.body || {}, raw: r };
}

// ── 0. 探活 ───────────────────────────────────────────────────────────────────
const alive = await api('/api/comm/protocols');
if (alive.status === 0) {
  console.log(`FAIL  后端没连上 ${HEAD}（${alive.error}）—— 先用 tools/run-suites.mjs 起隔离后端或指定端口`);
  console.log(`\n==== verify-comm-api：0/1 通过 ====`);
  process.exit(1);
}

// ── A. 目录接口 GET /api/comm/protocols ──────────────────────────────────────
console.log('\n── A. GET /api/comm/protocols（协议目录）──');
const dir = await api('/api/comm/protocols');
ok('A1 目录接口 200', dir.status === 200, `status=${dir.status} body=${brief(dir.body)}`);
const db = dir.body || {};
ok('A2 ok:true', db.ok === true, brief(db));
const list = Array.isArray(db.protocols) ? db.protocols : [];
ok('A3 protocols 是数组且 3 项', list.length === 3, `len=${list.length}`);
eq('A4 协议顺序固定 [modbus,ts600,opcua]', list.map(p => p && p.id), ['modbus', 'ts600', 'opcua']);

const byId = {};
for (const p of list) if (p && p.id) byId[p.id] = p;

const required = ['id', 'name', 'comm', 'default_address', 'kind', 'help', 'prefixes', 'examples'];
for (const pid of ['modbus', 'ts600', 'opcua']) {
  const p = byId[pid] || {};
  const missing = required.filter(k => p[k] === undefined || p[k] === null || p[k] === '');
  // addr_profile 必须存在；但 OPC UA 没有地址模型，契约就是 ""（不能用同一套「非空」判据）
  if (p.addr_profile === undefined || p.addr_profile === null) missing.push('addr_profile');
  if (pid !== 'opcua' && !p.addr_profile) missing.push('addr_profile');
  ok(`A5 ${pid} 字段齐全（${required.join('/')}）`, missing.length === 0,
    missing.length ? `缺 ${missing.join(',')} / 实际 ${brief(p)}` : `comm=${p.comm} profile=${p.addr_profile} default=${p.default_address}`);
  ok(`A6 ${pid} prefixes 是数组`, Array.isArray(p.prefixes), brief(p.prefixes));
}

const ts = byId.ts600 || {};
const tsPrefixes = (ts.prefixes || []).map(x => x && x.prefix);
ok('A7 ts600 前缀含 D/R/Z/M/S/X/Y/T/C',
  ['D', 'R', 'Z', 'M', 'S', 'X', 'Y', 'T', 'C'].every(x => tsPrefixes.includes(x)),
  `actual=${JSON.stringify(tsPrefixes)}`);
const xInfo = (ts.prefixes || []).find(x => x && x.prefix === 'X') || null;
ok('A8 ts600 的 X 标记只读（writable:false）', xInfo && xInfo.writable === false, brief(xInfo));
ok('A9 ts600 默认地址 D0', ts.default_address === 'D0', `actual=${brief(ts.default_address)}`);

const mb = byId.modbus || {};
const mbPrefixes = (mb.prefixes || []).map(x => x && x.prefix);
ok('A10 modbus 前缀含 %MW/%MD/%QX/%IX',
  ['%MW', '%MD', '%QX', '%IX'].every(x => mbPrefixes.includes(x)), `actual=${JSON.stringify(mbPrefixes)}`);
ok('A11 modbus 默认地址 %MW0', mb.default_address === '%MW0', `actual=${brief(mb.default_address)}`);
ok('A12 modbus 不把 D（TS600 元件写法）当前缀', !mbPrefixes.includes('D'), `actual=${JSON.stringify(mbPrefixes)}`);

const ua = byId.opcua || {};
ok('A13 opcua kind=nodeid', ua.kind === 'nodeid', `actual=${brief(ua.kind)}`);
ok('A14 opcua prefixes 为空数组', Array.isArray(ua.prefixes) && ua.prefixes.length === 0, brief(ua.prefixes));

const cur = db.current || {};
ok('A15 current 有 protocol + addr_profile', typeof cur.protocol === 'string' && cur.protocol !== '' &&
  typeof cur.addr_profile === 'string', brief(cur));

// ── B. 校验接口 POST /api/comm/validate ─────────────────────────────────────
console.log('\n── B. POST /api/comm/validate（单地址矩阵）──');

// 合法：D100 + real
let r = await validate({ protocol: 'ts600', address: 'D100', vtype: 'real' });
let b = r.b, a = b.address || {};
ok('B1 D100+real 合法', r.status === 200 && b.ok === true && b.valid === true && b.unsupported === false && b.code === '',
  `status=${r.status} code=${brief(b.code)} body=${brief(b)}`);
ok('B2 D100 解析为 holding 100 / 2 字', a.area === 'holding' && a.offset === 100 && a.words === 2 && a.bit === null,
  brief(a));
ok('B3 D100 回显协议与模型', b.protocol === 'ts600' && b.addr_profile === 'ts600-modbus-tcp' && b.prefix === 'D',
  `protocol=${brief(b.protocol)} profile=${brief(b.addr_profile)} prefix=${brief(b.prefix)}`);
ok('B4 D100 area_cn 含「保持寄存器」', typeof a.area_cn === 'string' && /保持寄存器/.test(a.area_cn), brief(a.area_cn));
ok('B5 D100 writable:true', b.writable === true, brief(b.writable));

// 合法：M10 + bool → coil 10
r = await validate({ protocol: 'ts600', address: 'M10', vtype: 'bool' });
b = r.b; a = b.address || {};
ok('B6 M10+bool 合法 = coil 10', r.status === 200 && b.valid === true && a.area === 'coil' && a.offset === 10,
  `status=${r.status} valid=${brief(b.valid)} addr=${brief(a)} body=${brief(b)}`);

// 只读：X17 + write → valid 但 writable:false
r = await validate({ protocol: 'ts600', address: 'X17', vtype: 'bool', write: true });
b = r.b; a = b.address || {};
ok('B7 X17 合法但 writable:false', r.status === 200 && b.valid === true && b.unsupported !== true && b.writable === false,
  `writable=${brief(b.writable)} body=${brief(b)}`);
ok('B8 X17 给 warning（只能读不能写）', typeof b.warning === 'string' && b.warning.length > 0 && /只能读|不能写/.test(b.warning),
  brief(b.warning));
ok('B9 X17 = discrete 40975（八进制 17→15）/ readonly', a.area === 'discrete' && a.offset === 40975 && a.readonly === true,
  brief(a));

// 真错误：Y18（八进制出现 8）
r = await validate({ protocol: 'ts600', address: 'Y18', vtype: 'bool' });
b = r.b;
ok('B10 Y18 invalid', r.status === 200 && b.valid === false && b.code === 'invalid' && b.unsupported !== true &&
  typeof b.message === 'string' && b.message.length > 0,
  `status=${r.status} code=${brief(b.code)} msg=${brief(b.message)} body=${brief(b)}`);

// 真错误：R20000 越界
r = await validate({ protocol: 'ts600', address: 'R20000', vtype: 'int' });
b = r.b;
ok('B11 R20000 invalid', r.status === 200 && b.valid === false && b.code === 'invalid' && b.unsupported !== true,
  `status=${r.status} code=${brief(b.code)} msg=${brief(b.message)}`);

// 真错误：D32767 + real 越区
r = await validate({ protocol: 'ts600', address: 'D32767', vtype: 'real' });
b = r.b;
ok('B12 D32767+real invalid', r.status === 200 && b.valid === false && b.code === 'invalid' && b.unsupported !== true,
  `status=${r.status} code=${brief(b.code)} msg=${brief(b.message)}`);

// 真错误：C200 + int（32 位双字计数器）
r = await validate({ protocol: 'ts600', address: 'C200', vtype: 'int' });
b = r.b;
ok('B13 C200+int invalid', r.status === 200 && b.valid === false && b.code === 'invalid' && b.unsupported !== true,
  `status=${r.status} code=${brief(b.code)} msg=${brief(b.message)}`);

// 合法：C200 + real（双字）
r = await validate({ protocol: 'ts600', address: 'C200', vtype: 'real' });
b = r.b; a = b.address || {};
ok('B14 C200+real 合法 = holding 58056 / 2 字', b.valid === true && a.area === 'holding' && a.offset === 58056 && a.words === 2,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

// 合法：T5 + int（16 位当前值）
r = await validate({ protocol: 'ts600', address: 'T5', vtype: 'int' });
b = r.b; a = b.address || {};
ok('B15 T5+int 合法 = holding 57349 / 1 字', b.valid === true && a.area === 'holding' && a.offset === 57349 && a.words === 1,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

// 模型不匹配（内部变量）：TS600 下 %MW100 是兼容写法 → 合法，而 %MX 才是 model
r = await validate({ protocol: 'ts600', address: '%MW100', vtype: 'real' });
b = r.b; a = b.address || {};
ok('B16 %MW100@ts600 兼容合法 = holding 100 / 2 字', b.valid === true && a.area === 'holding' && a.offset === 100 && a.words === 2,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

r = await validate({ protocol: 'ts600', address: '%MX0.0', vtype: 'bool' });
b = r.b;
ok('B17 %MX0.0@ts600 = 内部变量（unsupported/model，非红）', r.status === 200 && b.valid === false &&
  b.unsupported === true && b.code === 'model' && typeof b.message === 'string' && b.message.length > 0,
  `status=${r.status} unsupported=${brief(b.unsupported)} code=${brief(b.code)} msg=${brief(b.message)}`);

r = await validate({ protocol: 'modbus', address: 'D100', vtype: 'int' });
b = r.b;
ok('B18 D100@modbus = 内部变量（unsupported/model）', r.status === 200 && b.valid === false &&
  b.unsupported === true && b.code === 'model',
  `status=${r.status} unsupported=${brief(b.unsupported)} code=${brief(b.code)} msg=${brief(b.message)}`);

// 留空 = 内部变量
r = await validate({ protocol: 'ts600', address: '' });
b = r.b;
ok('B19 空地址 = empty', r.status === 200 && b.valid === false && b.code === 'empty' && b.unsupported !== true &&
  typeof b.message === 'string' && b.message.length > 0,
  `status=${r.status} code=${brief(b.code)} msg=${brief(b.message)}`);
r = await validate({ protocol: 'ts600', address: '   ' });
b = r.b;
ok('B20 纯空白 = empty', r.status === 200 && b.valid === false && b.code === 'empty', `code=${brief(b.code)}`);

// 未知协议 → HTTP 400
r = await validate({ protocol: 'modbus-rtu', address: '100' });
b = r.b;
ok('B21 未知协议 HTTP 400 + ok:false + error 文案', r.status === 400 && b.ok === false &&
  typeof b.error === 'string' && /modbus|ts600|opcua/.test(b.error),
  `status=${r.status} body=${brief(b)}`);

// 别名归一
r = await validate({ protocol: 'ts', address: 'D100', vtype: 'int' });
b = r.b;
ok('B22 协议别名 ts → ts600', b.valid === true && b.protocol === 'ts600', `protocol=${brief(b.protocol)} body=${brief(b)}`);

// INVT：%MW100
r = await validate({ protocol: 'modbus', address: '%MW100', vtype: 'real' });
b = r.b; a = b.address || {};
ok('B23 %MW100@modbus = holding 100 / 2 字', b.valid === true && a.area === 'holding' && a.offset === 100 && a.words === 2,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

// INVT：%IX0 只读输入
r = await validate({ protocol: 'modbus', address: '%IX0', vtype: 'bool', write: true });
b = r.b; a = b.address || {};
ok('B24 %IX0@modbus 合法但只读（writable:false）', b.valid === true && a.area === 'discrete' && b.writable === false,
  `valid=${brief(b.valid)} writable=${brief(b.writable)} addr=${brief(a)}`);

// TS600：T/C 的「双身份」——同一个地址，bool = 触点（线圈），数值 = 当前值（字元件）。
// 含义由 vtype 决定、不由地址字面决定（用户口径：地址 Tx/Cx 表示的是 bool 类型的 T/C）。
r = await validate({ protocol: 'ts600', address: 'T5', vtype: 'bool' });
b = r.b; a = b.address || {};
ok('B25 T5+bool = 触点线圈 coil 49157', b.valid === true && a.area === 'coil' && a.offset === 49157 && b.writable === true,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

r = await validate({ protocol: 'ts600', address: 'C5', vtype: 'bool' });
b = r.b; a = b.address || {};
ok('B26 C5+bool = 触点线圈 coil 49669', b.valid === true && a.area === 'coil' && a.offset === 49669 && b.writable === true,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

r = await validate({ protocol: 'ts600', address: 'C5', vtype: 'int' });
b = r.b; a = b.address || {};
ok('B27 C5+int = 16 位当前值 holding 57861', b.valid === true && a.area === 'holding' && a.offset === 57861 && a.words === 1,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

r = await validate({ protocol: 'ts600', address: 'C200', vtype: 'bool' });
b = r.b; a = b.address || {};
ok('B28 C200+bool = 触点线圈 coil 49864', b.valid === true && a.area === 'coil' && a.offset === 49864 && b.writable === true,
  `valid=${brief(b.valid)} addr=${brief(a)}`);

// ── C. 老接口 /api/plc action=parse 兼容 ─────────────────────────────────────
console.log('\n── C. 老接口 POST /api/plc action=parse（形状不变）──');
r = await api('/api/plc', { method: 'POST', body: { action: 'parse', protocol: 'ts600', address: 'D100', vtype: 'real' } });
b = r.body || {};
ok('C1 老 parse 仍返回 ok + area/offset/words/profile',
  r.status === 200 && b.ok === true && b.area === 'holding' && b.offset === 100 &&
  typeof b.area_cn === 'string' && /保持寄存器/.test(b.area_cn) && String(b.profile || '').includes('ts600'),
  `status=${r.status} body=${brief(b)}`);
ok('C2 老 parse 仍带 words_for_type/kind/readonly', b.words_for_type !== undefined && b.kind === 'D' && b.readonly === false,
  `words_for_type=${brief(b.words_for_type)} kind=${brief(b.kind)} readonly=${brief(b.readonly)}`);

r = await api('/api/plc', { method: 'POST', body: { action: 'parse', protocol: 'ts600', address: '%MX0.0', vtype: 'bool' } });
b = r.body || {};
ok('C3 老 parse 的「不匹配写法」仍回 ok:false + unsupported:true', r.status === 200 && b.ok === false && b.unsupported === true,
  `status=${r.status} body=${brief(b)}`);

// ── D. 浏览器路径：backend.rpc()（WS {t:'call'}）──────────────────────────────
console.log('\n── D. 浏览器 backend.rpc() 同一套接口 ──');
let browser = null;
try {
  browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  await page.goto(HEAD + '/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => !!(window.app && window.app.project && window.app.project.data), null, { timeout: 60000 });

  const viaRpc = await page.evaluate(async () => {
    const mod = await import('/js/api/backend.js');
    const bk = mod.backend;
    const out = {};
    try { out.dir = await bk.rpc('/api/comm/protocols', { method: 'GET' }); }
    catch (e) { out.dirErr = String(e && e.message || e); out.dirStatus = e && e.status; }
    try { out.v1 = await bk.rpc('/api/comm/validate', { body: { protocol: 'ts600', address: 'D100', vtype: 'real' } }); }
    catch (e) { out.v1Err = String(e && e.message || e); }
    try { out.v2 = await bk.rpc('/api/comm/validate', { body: { protocol: 'modbus-rtu', address: '1' } }); }
    catch (e) { out.v2Err = String(e && e.message || e); out.v2Status = e && e.status; }
    return out;
  });

  ok('D1 页面 rpc(GET /api/comm/protocols) 通', !viaRpc.dirErr && viaRpc.dir && viaRpc.dir.ok !== false &&
    Array.isArray(viaRpc.dir.protocols) && viaRpc.dir.protocols.length === 3,
    viaRpc.dirErr ? `err=${viaRpc.dirErr}` : brief(viaRpc.dir && viaRpc.dir.protocols && viaRpc.dir.protocols.map(p => p.id)));
  ok('D2 页面 rpc(validate D100) 合法', !viaRpc.v1Err && viaRpc.v1 && viaRpc.v1.valid === true &&
    viaRpc.v1.address && viaRpc.v1.address.offset === 100,
    viaRpc.v1Err ? `err=${viaRpc.v1Err}` : brief(viaRpc.v1));
  ok('D3 页面 rpc(未知协议) 报 400', viaRpc.v2Status === 400 && !!viaRpc.v2Err,
    `status=${brief(viaRpc.v2Status)} err=${brief(viaRpc.v2Err)}`);
  ok('D4 页面无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  ok('D0 浏览器路径可跑（chromium 启动/页面加载）', false, String(e && e.message || e));
} finally {
  if (browser) await browser.close().catch(() => {});
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter(x => !x.ok);
console.log(`\n（共发出 ${HTTP} 个接口请求）`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  ✗ ' + f.name);
}
console.log(`\n==== verify-comm-api：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
