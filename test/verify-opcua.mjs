// verify-opcua.mjs — OPC UA 数据源全链路：NodeId 解析 / 模拟 UA 服务器 / 连接与轮询 / 读写 /
//   按页采集 / 断线重连 / 浏览导入变量 / 变量表与 CSV 里的 NodeId 不被改坏
//
// 用法：先启动**新版**后端（带 opcua 能力表），再 node test/verify-opcua.mjs [端口]
//   node test/verify-opcua.mjs 8877
// 本套件会自己拉起模拟 OPC UA 服务器（server/opcua_sim.py，端口现取现用，跑完关掉），
// 需要 py -3 指向装了 asyncua 的那个 Python（本机 = Python310）。
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPageShim, installNodeFetchPatch, wsConnect, wsHealth } from './_wsfetch.mjs';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const HEAD = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.OPCUA_PY || (() => {
  // 直接用解释器本体（不用 py 启动器）：py.exe 是父进程，kill 掉它子进程还在，
  // 「服务器挂掉」那一段就测不出来（端口还占着、后端还以为在线）
  try {
    return execFileSync('py', ['-3', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf-8' }).trim();
  } catch { return 'python'; }
})();

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const api = async (p) => (await fetch(HEAD + p)).json();
const post = async (p, body) => {
  const r = await fetch(HEAD + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
};
const freePort = () => new Promise((res, rej) => {
  const srv = net.createServer();
  srv.on('error', rej);
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
});

/* ══════ 1. Python 侧：NodeId 解析 / 类型映射 / 端点归一化 ══════ */
const py = `
import json, sys
sys.path.insert(0, r'${ROOT.replace(/\\/g, '\\\\')}\\server')
import opcua


def try_(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except Exception as e:
        return 'ERR:' + str(e)[:60]

out = {'available': opcua.AVAILABLE, 'install': opcua.INSTALL_HINT}
out['parse'] = {
    'codesys': try_(opcua.parse_node_id, 'ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun'),
    'numeric': try_(opcua.parse_node_id, 'ns=2;i=1001'),
    'bare_ns': try_(opcua.parse_node_id, 's=PLC_PRG.x'),
    'bare_symbol': try_(opcua.parse_node_id, '|var|Dev.Application.PLC_PRG.x'),
    'no_ns_default': try_(opcua.parse_node_id, 'i=77', 6),
    'empty': try_(opcua.parse_node_id, ''),
    'endpoint_instead': try_(opcua.parse_node_id, 'opc.tcp://127.0.0.1:4840'),
    'bad_numeric': try_(opcua.parse_node_id, 'ns=2;i=abc'),
}
out['is_addr'] = [opcua.is_opcua_addr(x) for x in
                  ['ns=4;s=a', '%MW100', '|var|X.Y', 'i=5', 'HR100', '']]
out['endpoint'] = [opcua.norm_endpoint(x) for x in
                   ['127.0.0.1', '127.0.0.1:4841', 'opc.tcp://10.0.0.5:4840', 'opc.tcp://h:4840/hmi/', '']]
out['split'] = try_(opcua.split_node_id, 'ns=4;s=|var|A.B.C.x')
out['describe'] = opcua.describe_node_id('ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.rSpeed')
out['types'] = {n: opcua.hmi_type_of_variant(n) for n in ['Boolean', 'Int16', 'UInt32', 'Float', 'Double', 'String', 'DateTime']}
out['write_cast'] = {
    'float_from_int': opcua.coerce_write(33, 'Float'),
    'double_from_str': opcua.coerce_write('31.5', 'Double'),
    'bool_from_1': opcua.coerce_write('1', 'Boolean'),
    'int_from_float': opcua.coerce_write(12.6, 'Int16'),
    'str_from_num': opcua.coerce_write(7, 'String'),
}
out['read_cast'] = {
    'int': opcua.coerce_read(3.0, 'int'),
    'bool_from_str': opcua.coerce_read('true', 'bool'),
    'real': opcua.coerce_read(1500, 'real'),
}
print(json.dumps(out, ensure_ascii=False))
`;
let pyOut = {};
try {
  pyOut = JSON.parse(execFileSync(PY, ['-c', py],
    { encoding: 'utf-8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
} catch (e) {
  console.log('Python 侧自检失败：' + (e.stdout || '') + (e.stderr || '') + (e.message || ''));
}
ok('后端能 import opcua（asyncua 可用）', pyOut.available === true, String(pyOut.install || ''));
ok('NodeId 解析：CODESYS 符号 / 数值 / 裸符号 / 缺 ns 用默认',
  pyOut.parse?.codesys === 'ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun'
  && pyOut.parse?.numeric === 'ns=2;i=1001'
  && pyOut.parse?.bare_ns === 'ns=4;s=PLC_PRG.x'
  && pyOut.parse?.bare_symbol === 'ns=4;s=|var|Dev.Application.PLC_PRG.x'
  && pyOut.parse?.no_ns_default === 'ns=6;i=77',
  JSON.stringify(pyOut.parse));
ok('NodeId 解析：空值 / 端点地址 / i=非数字 都明确报错（不猜）',
  String(pyOut.parse?.empty).startsWith('ERR:')
  && String(pyOut.parse?.endpoint_instead).includes('不是端点地址')
  && String(pyOut.parse?.bad_numeric).startsWith('ERR:'),
  JSON.stringify([pyOut.parse?.empty, pyOut.parse?.endpoint_instead, pyOut.parse?.bad_numeric]));
ok('地址识别：NodeId 与 Modbus 地址分得清（%MW100/HR100 不算 NodeId）',
  JSON.stringify(pyOut.is_addr) === JSON.stringify([true, false, true, true, false, false]),
  JSON.stringify(pyOut.is_addr));
ok('端点归一化：只填 IP / IP:端口 都补成 opc.tcp://…:4840，已写全的不动',
  JSON.stringify(pyOut.endpoint) === JSON.stringify([
    'opc.tcp://127.0.0.1:4840', 'opc.tcp://127.0.0.1:4841',
    'opc.tcp://10.0.0.5:4840', 'opc.tcp://h:4840/hmi/', 'opc.tcp://127.0.0.1:4840']),
  JSON.stringify(pyOut.endpoint));
ok('UA 类型 → 变量表类型（Boolean/Int16/UInt32/Float/Double/String…）',
  pyOut.types?.Boolean === 'bool' && pyOut.types?.Int16 === 'int' && pyOut.types?.UInt32 === 'udint'
  && pyOut.types?.Float === 'real' && pyOut.types?.Double === 'lreal' && pyOut.types?.String === 'string',
  JSON.stringify(pyOut.types));
ok('写入按节点类型收敛（Float 节点写 int、字符串转 Double 都由这里兜住）',
  pyOut.write_cast?.float_from_int === 33 && pyOut.write_cast?.double_from_str === 31.5
  && pyOut.write_cast?.bool_from_1 === true && pyOut.write_cast?.int_from_float === 13
  && pyOut.write_cast?.str_from_num === '7',
  JSON.stringify(pyOut.write_cast));

/* ══════ 2. 起模拟 OPC UA 服务器（测试工具自己也得测） ══════ */
const SIM_UA = await freePort();
const SIM_WEB = await freePort();
const sim = spawn(PY, ['server/opcua_sim.py', '--port', String(SIM_UA),
  '--web-port', String(SIM_WEB), '--no-browser'], { cwd: ROOT, stdio: 'ignore' });
const simApi = async (p, body) => {
  const r = body
    ? await fetch(`http://127.0.0.1:${SIM_WEB}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    : await fetch(`http://127.0.0.1:${SIM_WEB}${p}`);
  return r.json();
};
let simUp = false;
for (let i = 0; i < 40 && !simUp; i++) {
  await sleep(400);
  try { await simApi('/api/state'); simUp = true; } catch { /* 还没起来 */ }
}
ok('模拟 OPC UA 服务器已启动（端口现取现用）', simUp, `ua=${SIM_UA} web=${SIM_WEB}`);
const EP = `opc.tcp://127.0.0.1:${SIM_UA}`;
const st0 = simUp ? await simApi('/api/state') : { vars: [] };
ok('模拟服务器按 CODESYS 符号造节点（ns=4;s=|var|设备.Application.POU.符号）',
  st0.vars?.length >= 8 && st0.vars.every(v => v.nodeid.startsWith('ns=4;s=|var|'))
  && st0.vars.some(v => v.nodeid.endsWith('.PLC_PRG.rSpeed')) && st0.vars.some(v => v.nodeid.endsWith('.GVL.rTemp')),
  JSON.stringify((st0.vars || []).slice(0, 3).map(v => v.nodeid)));
ok('模拟服务器节点带类型/只读/数组标记（网页调试台能一眼看懂）',
  st0.vars?.some(v => v.ua_type === 'Boolean' && v.hmi === 'bool')
  && st0.vars?.some(v => v.writable === false) && st0.vars?.some(v => v.array_len > 0),
  JSON.stringify((st0.vars || []).filter(v => !v.writable || v.array_len).map(v => v.name)));
const rSpeedNode = (st0.vars || []).find(v => v.name === 'rSpeed')?.nodeid || '';
const rSetNode = (st0.vars || []).find(v => v.name === 'rSet')?.nodeid || '';
const rTempNode = (st0.vars || []).find(v => v.name === 'rTemp')?.nodeid || '';
const iSerialNode = (st0.vars || []).find(v => v.name === 'iSerial')?.nodeid || '';

/* ══════ 3. 后端 HTTP：健康检查 / 测试连接 / 浏览 ══════ */
const health = await wsHealth(PORT).catch(() => ({}));
ok('后端具备 OPC UA 能力（features 里有 protocol/opcua/opcua_browse/opcua_xml）',
  ['protocol', 'opcua', 'opcua_browse', 'opcua_xml'].every(f => (health.features || []).includes(f)),
  JSON.stringify(health.features));
ok('/api/health 报出 asyncua 可用性与安装提示（缺了要能说清楚）',
  health.opcua?.available === true && typeof health.opcua?.install === 'string',
  JSON.stringify(health.opcua));
const testCon = await post('/api/plc', { action: 'test', protocol: 'opcua', endpoint: EP });
ok('测试连接（OPC UA）成功并带回命名空间/服务器名',
  testCon.ok === true && /连接成功/.test(testCon.message || '')
  && (testCon.info?.namespaces || []).some(u => u.includes('invtmatic')),
  (testCon.message || '').replace(/\n/g, ' / ').slice(0, 90));
const testBad = await post('/api/plc', { action: 'test', protocol: 'opcua', endpoint: 'opc.tcp://127.0.0.1:1' });
ok('测试连接：连不上时给的是人话（TCP 连不上 + 原因）',
  testBad.ok === false && /TCP 连不上/.test(testBad.message || ''), String(testBad.message).slice(0, 70));

// 端点诊断（不建会话）：现场「匿名被拒 / 只给加密端点」这类问题的第一手排查
const diag = await post('/api/plc', { action: 'endpoints', protocol: 'opcua', endpoint: EP });
ok('端点诊断：问出服务器身份 / 端点 / 安全策略 / 身份方式（不需要建会话）',
  diag.ok === true && !!diag.server?.name && (diag.endpoints || []).length >= 1
  && (diag.policies || []).includes('None'),
  JSON.stringify({ server: diag.server?.name, policies: diag.policies, tokens: diag.tokens }));
ok('端点诊断：模拟服务器声明了匿名 → 结论是「可以直接连」',
  (diag.tokens || []).includes('Anonymous') && /端点声明了匿名/.test(diag.advice || ''),
  String(diag.advice).slice(-40));
const diagDead = await post('/api/plc', { action: 'endpoints', protocol: 'opcua', endpoint: 'opc.tcp://127.0.0.1:1' });
ok('端点诊断：连不上时给的是「TCP 连不上 + 原因」，不是协议级报错',
  diagDead.ok === false && /TCP 连不上/.test(diagDead.message || ''), String(diagDead.message).slice(0, 60));
const diagMb = await post('/api/plc', { action: 'endpoints', protocol: 'modbus' });
ok('端点诊断只对 OPC UA 有意义（Modbus 下明确说明）',
  diagMb.ok === false && /只对 OPC UA/.test(diagMb.message || ''), String(diagMb.message).slice(0, 50));

const browse = await post('/api/opcua/browse', { endpoint: EP, depth: 4 });
ok('浏览节点树：找到变量节点（只读操作）',
  browse.ok === true && (browse.nodes || []).length >= 8, browse.message);
ok('浏览结果带 NodeId/类型/可写/数组标记（导入对话框直接用）',
  (browse.nodes || []).every(n => n.nodeid && n.ua_type && 'writable' in n && 'is_array' in n)
  && (browse.nodes || []).some(n => n.is_array),
  JSON.stringify((browse.nodes || [])[0]));
const browseFilter = await post('/api/opcua/browse', { endpoint: EP, depth: 4, filter_text: 'rS' });
ok('浏览支持过滤词（按名称/路径/NodeId）',
  browseFilter.ok === true && (browseFilter.nodes || []).length > 0
  && (browseFilter.nodes || []).length < (browse.nodes || []).length
  && (browseFilter.nodes || []).every(n => /rs/i.test(n.name + n.path + n.nodeid)),
  JSON.stringify((browseFilter.nodes || []).map(n => n.name)));
const badBrowse = await post('/api/opcua/browse', { endpoint: EP, node_id: '乱七八糟' });
ok('浏览：起始 NodeId 不存在时明确报错（不当成空结果糊弄）',
  badBrowse.ok === false && /起始节点读不到|不存在/.test(badBrowse.message || ''),
  String(badBrowse.message).slice(0, 70));

/* ══════ 4. 连接 + 轮询 + 读写 ══════ */
const VARS = [
  { name: 'bRun', type: 'bool', address: `ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun` },
  { name: 'iCount', type: 'int', address: `ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.iCount` },
  { name: 'rSpeed', type: 'real', address: rSpeedNode },
  { name: 'rSet', type: 'real', address: rSetNode },
  { name: 'sMode', type: 'string', address: `ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.sMode` },
  { name: 'rTemp', type: 'lreal', address: rTempNode },
  { name: 'iSerial', type: 'dint', address: iSerialNode },
  { name: 'rBad', type: 'real', address: `ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.notExist` },
];
const conn = await post('/api/plc', { action: 'connect', protocol: 'opcua', endpoint: EP, poll_ms: 300, variables: VARS });
ok('连接成功：status 里 mode=opcua + 端点 + 变量数',
  conn.ok === true && conn.status?.mode === 'opcua' && conn.status?.endpoint === EP && conn.status?.vars === VARS.length,
  JSON.stringify({ mode: conn.status?.mode, vars: conn.status?.vars }));
await sleep(2500);
let st = await wsHealth(PORT).then(j => j.plc);
ok('轮询起来了：online=true，reads 在涨',
  st.online === true && st.reads > 0, JSON.stringify({ online: st.online, reads: st.reads }));
ok('批量读：8 个节点合成 1 次读（blocks=1），不是一节点一请求',
  st.blocks === 1 && st.active === VARS.length, JSON.stringify({ blocks: st.blocks, active: st.active }));
const vals = (await api('/api/vars')).vars;
ok('读值正确：bRun/iCount/sMode(中文)/rTemp/iSerial',
  vals.bRun === false && vals.iCount === 0 && vals.sMode === '手动'
  && typeof vals.rTemp === 'number' && Math.abs(vals.rTemp - 26.5) < 0.001 && vals.iSerial === 20261002,
  JSON.stringify({ bRun: vals.bRun, iCount: vals.iCount, sMode: vals.sMode, rTemp: vals.rTemp, iSerial: vals.iSerial }));
const s1 = (await api('/api/vars')).vars.rSpeed;
await sleep(700);
const s2 = (await api('/api/vars')).vars.rSpeed;
ok('模拟器的自动正弦在跑 → 后端每次轮询读到的是新值（真在采，不是缓存）',
  s1 !== s2, `${s1} → ${s2}`);
ok('不存在的 NodeId 被单独标出来（bad_address），不拖累其它变量',
  (st.bad_address || []).includes('rBad') && vals.rSpeed !== null,
  JSON.stringify(st.bad_address));

// 写：数值 / 布尔 / 字符串 → 模拟器侧确认真的落地
const w1 = await post('/api/vars', { name: 'rSet', value: 1234.5 });
await post('/api/vars', { name: 'bRun', value: true });
await post('/api/vars', { name: 'sMode', value: '自动' });
await sleep(600);
const simAfter = await simApi('/api/state');
const simVal = (n) => simAfter.vars.find(v => v.name === n)?.value;
ok('写数值 → 模拟服务器节点真的变了（不是只改界面）',
  w1.ok === true && Math.abs(simVal('rSet') - 1234.5) < 0.001, String(simVal('rSet')));
ok('写布尔 / 写字符串（中文）都到位', simVal('bRun') === true && simVal('sMode') === '自动',
  JSON.stringify({ bRun: simVal('bRun'), sMode: simVal('sMode') }));
ok('模拟服务器日志记下「来自客户端」的写入（调试台能看见谁写的）',
  (simAfter.log || []).some(l => l.includes('rSet') && l.includes('客户端')),
  ((simAfter.log || []).slice(-3).join(' | ')).slice(0, 90));

// 写只读节点 / 写不存在的节点：都要明确报错
const wRo = await post('/api/vars', { name: 'iSerial', value: 999 });
ok('写只读节点被拒，且原因说清楚了（只读/权限 + 三种可能）',
  wRo.ok === false && /只读|权限|身份/.test(wRo.error || ''), String(wRo.error).slice(0, 80));
const wBad = await post('/api/vars', { name: 'rBad', value: 1 });
ok('写不存在的 NodeId 报「节点不存在」，不会静默丢掉', wBad.ok === false, String(wBad.error).slice(0, 70));

// 模拟器侧改值 → 后端轮询读到（外部改值要能上来）
const setResp = await simApi('/api/set', { key: rTempNode, value: 88.25 });
ok('模拟器调试台改值（网页调试台那个「写入」按钮）返回成功',
  setResp.ok === true, JSON.stringify(setResp).slice(0, 80));
await sleep(900);
const t2 = (await api('/api/vars')).vars.rTemp;
ok('模拟器里改值 → 后端下一轮就读到（88.25）', Math.abs(t2 - 88.25) < 0.001, String(t2));

/* ══════ 5. 按页采集（OPC UA 版）══ */
await post('/api/vars/declare', { variables: VARS, active: ['bRun', 'iCount', 'rSpeed'] });
await sleep(900);
const scoped = await wsHealth(PORT).then(j => j.plc);
ok('按页采集生效：只采本页 3 个变量（active=3、blocks=1）',
  scoped.scoped === true && scoped.active === 3 && scoped.blocks === 1,
  JSON.stringify({ active: scoped.active, blocks: scoped.blocks, scoped: scoped.scoped }));
await simApi('/api/set', { key: rTempNode, value: 91.25 });
await sleep(650);
const recipeBefore = (await api('/api/vars')).vars.rTemp;
const recipeCurrent = await post('/api/recipes/current', { names: ['rTemp'] });
const scopeAfterRecipe = await wsHealth(PORT).then(j => j.plc.active);
ok('配方读取当前值：临时读取范围外的 OPC UA 节点，不改变画面的采集范围',
  recipeBefore === 88.25 && recipeCurrent.values?.rTemp === 91.25 && scopeAfterRecipe === 3,
  JSON.stringify({ recipeBefore, values: recipeCurrent.values, scopeAfterRecipe }));
await post('/api/vars/declare', { variables: VARS, active: VARS.map(v => v.name) });
await sleep(600);

/* ══════ 6. 断线 / 重连 ══════ */
sim.kill();
let offline = null;
for (let i = 0; i < 40 && !offline; i++) {          // 实测 ~6~8 秒内会掉线（等够 20 秒）
  await sleep(500);
  const j = await wsHealth(PORT).then(r => r.plc).catch(() => null);
  if (j && j.online === false && j.last_error) offline = j;
}
ok('服务器挂掉 → 状态变离线并给出原因（不是一直显示在线）',
  !!offline, offline ? String(offline.last_error).slice(0, 70) : '一直没变离线');

const reconnectPoll = wsConnect(PORT);
await reconnectPoll.ready;
const prevPoll = await reconnectPoll.ask({ t: 'poll', on: false });
const paused = await reconnectPoll.ask({ t: 'poll', on: false, always: false });
const sim2 = spawn(PY, ['server/opcua_sim.py', '--port', String(SIM_UA),
  '--web-port', String(SIM_WEB), '--no-browser'], { cwd: ROOT, stdio: 'ignore' });
let back = false;
try {
  let connectedBeforeRead;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const status = await wsHealth(PORT).then(r => r.plc).catch(() => null);
    if (status?.last_error === '') { connectedBeforeRead = status; break; }
  }
  await simApi('/api/set', { key: rSetNode, value: 432.5 });
  const saved = await post('/api/recipes', { action: 'save', name: '重连保护自检', vars: { rSet: 123.5 } });
  const applyRecipe = () => post('/api/recipes', { action: 'apply', name: '重连保护自检', revision: saved.revision });
  const blocked = await applyRecipe();
  ok('新 OPC UA 会话已建立，采集首轮数据前拒绝配方写入',
    paused.paused && connectedBeforeRead?.online === false && blocked.failed?.length === 1,
    JSON.stringify({ online: connectedBeforeRead?.online, error: blocked.error }));
  await reconnectPoll.ask({ t: 'poll', on: true, always: prevPoll.always });
  let liveValue;
  for (let i = 0; i < 40 && !back; i++) {
    await sleep(300);
    const j = await wsHealth(PORT).then(r => r.plc).catch(() => null);
    liveValue = (await api('/api/vars')).vars.rSet;
    back = j?.online === true && liveValue === 432.5;
  }
  ok('OPC UA 重连后先采集实时值，未补发首读前被拒的请求', back, String(liveValue));
  const reapplied = await applyRecipe();
  ok('OPC UA 首读后重新应用成功', reapplied.applied?.includes('rSet'), JSON.stringify(reapplied));
} finally {
  await reconnectPoll.ask({ t: 'poll', on: false, always: prevPoll.always });
  reconnectPoll.close();
}
ok('服务器回来后自动重连（不用手动点连接）', back === true);

/* ══════ 7. 浏览器：连接对话框 / 变量表 / 导入变量 / CSV ══════ */
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(HEAD + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
// 变量表清空（演示工程自带几个变量，不清掉的话导入会撞名变成 rSet_2，看不出导入本身对不对）
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.pages[0].widgets.length = 0;
  m.project.data.variables.length = 0;
  m.project.commit('OPC UA 测试准备');
});
await sleep(300);

// 打开连接对话框（从工具栏按钮进）
await page.click('#btnPlc');
await sleep(300);
const dlg = await page.evaluate(() => {
  const sel = document.getElementById('plcProto');
  return {
    title: document.getElementById('dlgTitle').textContent,
    hasProto: !!sel,
    // 协议下拉三项：modbus（Modbus TCP）/ ts600（TS600 TCP）/ opcua（OPC UA）
    protos: sel ? [...sel.options].map((o) => o.value) : [],
    uaHidden: document.getElementById('plcOpcua').style.display === 'none',
  };
});
ok('连接对话框有协议选择（Modbus TCP / TS600 TCP / OPC UA）',
  dlg.hasProto && /Modbus TCP/.test(dlg.title) && /OPC UA/.test(dlg.title)
    && dlg.protos.join(',') === 'modbus,ts600,opcua', JSON.stringify(dlg));
await page.selectOption('#plcProto', 'opcua');
await sleep(250);
const uaView = await page.evaluate(() => ({
  modbusHidden: document.getElementById('plcModbus').style.display === 'none',
  uaShown: document.getElementById('plcOpcua').style.display !== 'none',
  orderHidden: document.getElementById('plcOrderRow').style.display === 'none',
  importShown: document.getElementById('plcImport').style.display !== 'none',
  ordersHidden: document.getElementById('plcOrders').style.display === 'none',
  endpoint: document.getElementById('plcEndpoint').value,
}));
ok('切到 OPC UA：Modbus 字段与「字序体检」隐藏，端点/身份/导入按钮出现',
  uaView.modbusHidden && uaView.uaShown && uaView.orderHidden && uaView.importShown && uaView.ordersHidden,
  JSON.stringify(uaView));
await page.fill('#plcEndpoint', EP);
await page.click('#plcTest');
await sleep(2500);
const testMsg = await page.textContent('#plcTestMsg');
ok('对话框里的「测试连接」在 OPC UA 下走 UA 探测并给出结果',
  /✔/.test(testMsg || '') && /连接成功/.test(testMsg || ''), String(testMsg).replace(/\n/g, ' / ').slice(0, 80));

// 从服务器导入变量：浏览 → 过滤 → 全选匹配 → 导入
await page.click('#plcImport');
await sleep(400);
const impShown = await page.evaluate(() => ({
  title: document.getElementById('dlgTitle').textContent,
  hasList: !!document.getElementById('oiList'),
}));
ok('「从服务器导入变量」对话框打开', /导入变量/.test(impShown.title || '') && impShown.hasList, JSON.stringify(impShown));
// 在线浏览这条线：切到「连上服务器浏览」方式
await page.check('input[name="oiMode"][value="live"]');
await sleep(300);
await page.fill('#oiEp', EP);
await page.click('#oiBrowse');
await sleep(4000);
const impList = await page.evaluate(() => ({
  rows: document.querySelectorAll('#oiList tbody tr').length,
  msg: document.getElementById('oiMsg').textContent,
}));
ok('浏览后列出节点（含类型列 / 可写列）', impList.rows >= 8, JSON.stringify(impList).slice(0, 120));
await page.fill('#oiFilter', 'rS');
await sleep(300);
await page.click('#oiAll');
await sleep(250);
const picked = await page.evaluate(() => ({
  count: document.getElementById('oiCount').textContent,
  checked: document.querySelectorAll('#oiList input[data-pick]:checked').length,
}));
ok('过滤 + 「全选匹配项」只勾中匹配的节点',
  picked.checked === 2 && /已勾选 2/.test(picked.count), JSON.stringify(picked));
await page.click('#dlgOk');
await sleep(700);
const imported = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const vs = m.project.variables();
  return {
    total: vs.length,
    rSet: vs.find(v => v.name === 'rSet'),
    rSpeed: vs.find(v => v.name === 'rSpeed'),
  };
});
ok('导入到变量表：名称/类型/NodeId 都对（real → Float 节点）',
  imported.total === 2 && imported.rSet?.address === rSetNode && imported.rSet.type === 'real'
  && imported.rSpeed?.address === rSpeedNode,
  JSON.stringify({ total: imported.total, rSet: imported.rSet?.address, type: imported.rSet?.type }));

// 变量表地址格：NodeId 里的空格绝不能被吃掉（normAddr 回归）
const addrKept = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const u = await import('/js/core/utils.js');
  const node = 'ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun';
  const v = m.project.variables()[0];
  m.project.updateVariable(v.name, { address: u.normAddr(node) });
  return {
    norm: u.normAddr(node),
    keepSpaces: u.normAddr(node).includes('Win V3'),
    modbusStill: u.normAddr('HR100'),
    modbusNum: u.normAddr('100'),
    isOpc: u.isOpcAddr(node) && !u.isOpcAddr('%MW100'),
    desc: u.describeNodeId(node),
    normNoNs: u.normNodeId('|var|D.Application.PLC_PRG.x', 4),
  };
});
ok('normAddr 不再改坏 NodeId（空格保留），Modbus 归一化照旧',
  addrKept.keepSpaces && addrKept.norm === 'ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun'
  && addrKept.modbusStill === '%MW100' && addrKept.modbusNum === '%MW100' && addrKept.isOpc,
  JSON.stringify(addrKept).slice(0, 120));
ok('NodeId 说明文字 / 缺 ns 自动补默认命名空间',
  /OPC UA NodeId/.test(addrKept.desc) && addrKept.normNoNs === 'ns=4;s=|var|D.Application.PLC_PRG.x',
  JSON.stringify([addrKept.desc.slice(0, 40), addrKept.normNoNs]));

// 变量表面板：OPC UA 模式下地址格给的是 NodeId 提示
const cell = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const b = await import('/js/api/backend.js');
  const v = m.project.variables()[0];
  m.project.updateVariable(v.name, { address: 'ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun' });
  b.backend.setPlcInfo({ protocol: 'opcua' });
  const el = document.querySelector(`#varTable input[data-k="address"][data-vtype]`);
  const rows = [...document.querySelectorAll('#varTable tbody tr')];
  const row = rows.find(r => r.querySelector('input[data-k="address"]'));
  const inp = row?.querySelector('input[data-k="address"]');
  return { has: !!inp, title: inp?.title || '', ph: inp?.placeholder || '', ua: inp?.dataset.ua };
});
ok('变量表地址格在 OPC UA 下给 NodeId 提示与占位（不再是 %MW96）',
  cell.has && /OPC UA NodeId/.test(cell.title) && /ns=4/.test(cell.ph) && cell.ua === '1',
  JSON.stringify(cell).slice(0, 120));

// CSV 往返：NodeId 原样进出
const csvRound = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const c = await import('/js/core/csv.js');
  const before = m.project.variables().map(v => ({ ...v }));
  const text = c.varsToCsv(before);
  m.project.data.variables.length = 0;
  const res = c.importCsv(text);
  const after = m.project.variables();
  return {
    added: res.added, errors: res.errors.length,
    same: before.length === after.length
      && before.every((v, i) => v.name === after[i].name && v.address === after[i].address && v.type === after[i].type),
    sample: after[0]?.address || '',
  };
});
ok('变量表 CSV 导出→导入：NodeId 逐字段不变（12 列写法不会被转成 %MW）',
  csvRound.added === 2 && csvRound.errors === 0 && csvRound.same && /^ns=4;/.test(csvRound.sample),
  JSON.stringify(csvRound).slice(0, 120));

// 状态栏：连上 OPC UA 后显示协议与端点
const status = await page.evaluate(async () => {
  const t = await import('/js/editor/toolbar.js');
  await t.refreshPlcStatus();
  return document.getElementById('stPlc')?.textContent || '';
});
ok('状态栏显示 OPC UA 在线 + 端点（不再写 PLC：在线 IP:502）',
  /OPC UA：在线/.test(status) && status.includes(String(SIM_UA)), status);

// 运行态：连着的 OPC UA 值能进界面
const rt = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const p = m.project.data.pages[0];
  p.widgets.length = 0;
  const w = m.project.addWidget('label', 20, 20);
  m.project.updateWidgetField(w.id, 'bindings.variable', 'rSpeed');
  m.project.commit('OPC UA 显示测试');
  await (await import('/js/runtime/runtime.js')).enterRun();
  await new Promise(r => setTimeout(r, 1600));
  const el = document.querySelector(`#rtPage .wd[data-id="${w.id}"] .w-label`);
  const out = { text: el?.textContent || '', online: window.__hmiRuntime ? true : true };
  (await import('/js/runtime/runtime.js')).exitRun();
  return out;
});
ok('运行态：绑定的变量显示出来（后端轮询的值进了界面）',
  rt.text.trim() !== '' && rt.text.trim() !== '--', JSON.stringify(rt).slice(0, 80));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

/* ══════ 8. CODESYS/Invtmatic「符号配置」XML：离线导入（不连服务器） ══════ */
const FIXTURE = path.join(ROOT, 'test', 'data', 'OPCUA.Device.Application.xml');
let xmlText = '';
try { xmlText = readFileSync(FIXTURE, 'utf-8'); } catch { /* 没放样例文件 */ }
ok('样例文件在（CODESYS 导出的符号配置 XML）', xmlText.includes('Symbolconfiguration'), FIXTURE);
const parsed = await post('/api/opcua/parse-xml', { xml: xmlText, ns: 4 });
const scalars = (parsed.nodes || []).filter(n => !n.is_array);
const arrays = (parsed.nodes || []).filter(n => n.is_array && n.dims === 1);
ok('解析符号配置 XML：设备名/应用名/符号数都对（不连服务器也能导地址）',
  parsed.ok === true && parsed.device === 'Device' && parsed.app === 'Application'
  && (parsed.nodes || []).length === 18,
  `${parsed.message}`);
ok('NodeId 按 CODESYS 约定拼出来：ns=4;s=|var|设备.应用.POU.符号',
  (parsed.nodes || []).some(n => n.nodeid === 'ns=4;s=|var|Device.Application.GVL.a')
  && (parsed.nodes || []).every(n => n.nodeid.startsWith('ns=4;s=|var|Device.Application.GVL.')),
  JSON.stringify((parsed.nodes || []).slice(0, 2).map(n => n.nodeid)));
ok('标量 IEC 类型 → 变量表类型（BOOL/BYTE/INT/UINT/WORD/DINT/REAL/LREAL/STRING/WSTRING）',
  JSON.stringify(scalars.map(n => `${n.name}:${n.hmi_type}`).sort())
  === JSON.stringify(['a:int', 'b:uint', 'by:uint', 'c:real', 'd:lreal', 'dd:bool',
    'di:dint', 'string0:string', 'w:uint', 'wstring0:wstring'].sort()),
  JSON.stringify(scalars.map(n => `${n.name}:${n.hmi_type}`)));
ok('字符串类型按声明长度带出来（STRING 81 字节→80 字符；WSTRING 162 字节→80 宽字符）',
  parsed.nodes.find(n => n.name === 'string0')?.len === 80
  && parsed.nodes.find(n => n.name === 'wstring0')?.len === 80
  && parsed.nodes.find(n => n.name === 'wstring0')?.hmi_type === 'wstring'
  && parsed.nodes.find(n => n.name === 'string0')?.hmi_type === 'string',
  JSON.stringify((parsed.nodes || []).filter(n => /string/.test(n.name))
    .map(n => `${n.name}:${n.hmi_type}/${n.len}`)));
ok('数组元素类型不止 INT：REAL/WORD/LREAL/BOOL/STRING/WSTRING 都翻成 `元素类型[]` + 个数',
  JSON.stringify(arrays.map(n => `${n.name}:${n.hmi_type}/${n.elements}`).sort())
  === JSON.stringify(['arrBool:bool[]/4', 'arrLR:lreal[]/3', 'arrReal:real[]/4',
    'arrStr:string[]/2', 'arrWStr:wstring[]/2', 'arrWord:uint[]/3', 'arrw:int[]/13'].sort()),
  JSON.stringify(arrays.map(n => `${n.name}:${n.hmi_type}/${n.elements}`)));
ok('一维数组默认就勾（能用），多维数组列出来但默认不勾',
  arrays.every(n => n.complex === false)
  && (parsed.nodes || []).some(n => n.name === 'arr2d' && n.dims === 2 && n.complex === true),
  JSON.stringify(parsed.nodes.find(n => n.name === 'arr2d')));
ok('不再有「跳过」的符号（数组支持了，全部能导）',
  (parsed.skipped || []).length === 0, JSON.stringify(parsed.skipped));
const parsedArr = await post('/api/opcua/parse-xml', { xml: xmlText, ns: 4, include_complex: true });
const arrNode = (parsedArr.nodes || []).find(n => n.name === 'arrw');
ok('数组节点信息完整（元素类型 int / 元素个数 13 / 一维）',
  arrNode && arrNode.elements === 13 && arrNode.elem_type === 'int' && arrNode.dims === 1,
  JSON.stringify(arrNode));
const parsedBad = await post('/api/opcua/parse-xml', { xml: '<UANodeSet xmlns="x"/>' });
ok('传进来的不是符号配置 XML 时明确报错（并说明它是什么）',
  parsedBad.ok === false && /不是 CODESYS 符号配置/.test(parsedBad.message || ''),
  String(parsedBad.message).slice(0, 70));

// 模拟服务器也按同一份 XML 建节点 → 地址应当与导入的一字不差
const X_UA = await freePort();
const X_WEB = await freePort();
const simX = spawn(PY, ['server/opcua_sim.py', '--port', String(X_UA), '--web-port', String(X_WEB),
  '--no-browser', '--device', 'Device', '--import-symbol-xml', FIXTURE], { cwd: ROOT, stdio: 'ignore' });
const xApi = async (p, body) => {
  const r = body
    ? await fetch(`http://127.0.0.1:${X_WEB}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    : await fetch(`http://127.0.0.1:${X_WEB}${p}`);
  return r.json();
};
let xUp = false;
for (let i = 0; i < 40 && !xUp; i++) { await sleep(400); try { await xApi('/api/state'); xUp = true; } catch { /* 等 */ } }
const xState = xUp ? await xApi('/api/state') : { vars: [] };
ok('模拟服务器按同一份 XML 建节点（真机那套符号，含各种元素类型的数组）',
  xUp && xState.vars.length === 18
  && xState.vars.some(v => v.nodeid === 'ns=4;s=|var|Device.Application.GVL.a')
  && xState.vars.some(v => v.name === 'arrw' && v.array_len === 13)
  && xState.vars.some(v => v.name === 'arrReal' && v.array_len === 4)
  && xState.vars.some(v => v.name === 'arrWStr' && v.array_len === 2),
  JSON.stringify({ n: xState.vars?.length, sample: (xState.vars || []).slice(0, 2).map(v => v.nodeid) }));
const XEP = `opc.tcp://127.0.0.1:${X_UA}`;
const X_VARS = (parsed.nodes || []).filter(n => !n.complex).map(n => ({
  name: n.name, type: n.hmi_type, address: n.nodeid, len: n.len || n.elements || 0,
}));
const xConn = await post('/api/plc', {
  action: 'connect', protocol: 'opcua', endpoint: XEP, poll_ms: 300, variables: X_VARS,
});
await sleep(2000);
const xVals = (await api('/api/vars')).vars;
const xSt = await wsHealth(PORT).then(j => j.plc);
ok('按 XML 导出的 NodeId 直连就能读到值（含各种数组，地址拼对了）',
  xConn.ok === true && xSt.online === true && xSt.bad_address.length === 0,
  JSON.stringify({ online: xSt.online, bad: xSt.bad_address }));
ok('读到的值类型对得上（bool/int/real/lreal/string/wstring）',
  xVals.dd === false && xVals.a === 0 && typeof xVals.c === 'number'
  && typeof xVals.d === 'number' && xVals.string0 === '' && xVals.wstring0 === '',
  JSON.stringify({ dd: xVals.dd, a: xVals.a, c: xVals.c, d: xVals.d, s: xVals.string0, ws: xVals.wstring0 }));
ok('各元素类型的数组读回来长度都对（int13/real4/uint3/lreal3/bool4/string2/wstring2）',
  xVals.arrw?.length === 13 && xVals.arrReal?.length === 4 && xVals.arrWord?.length === 3
  && xVals.arrLR?.length === 3 && xVals.arrBool?.length === 4
  && xVals.arrStr?.length === 2 && xVals.arrWStr?.length === 2,
  JSON.stringify({ int: xVals.arrw?.length, real: xVals.arrReal?.length, word: xVals.arrWord?.length,
    lreal: xVals.arrLR?.length, bool: xVals.arrBool?.length, str: xVals.arrStr?.length, wstr: xVals.arrWStr?.length }));
const xWrite = await post('/api/vars', { name: 'a', value: 123 });
await post('/api/vars', { name: 'string0', value: '自动模式' });
await post('/api/vars', { name: 'wstring0', value: '宽字符OK' });
await sleep(800);
ok('按 XML 导出的地址写值也到位（含中文 STRING / WSTRING）',
  xWrite.ok === true
  && (await xApi('/api/state')).vars.find(v => v.name === 'a')?.value === 123
  && (await xApi('/api/state')).vars.find(v => v.name === 'string0')?.value === '自动模式'
  && (await xApi('/api/state')).vars.find(v => v.name === 'wstring0')?.value === '宽字符OK',
  JSON.stringify((await xApi('/api/state')).vars.filter(v => /string|^a$/.test(v.name)).map(v => `${v.name}=${v.value}`)));
// 数组：整段写 + 单元素写（后端读改写整段），各种元素类型都试一遍
const arrWrite = await post('/api/vars', { name: 'arrw', value: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] });
await post('/api/vars', { name: 'arrReal', value: [1.5, 2.5, 3.5, 4.5] });
await post('/api/vars', { name: 'arrWord', value: [100, 200, 300] });
await post('/api/vars', { name: 'arrBool', value: [true, false, true, false] });
await post('/api/vars', { name: 'arrStr', value: ['自动', '手动'] });
await post('/api/vars', { name: 'arrWStr', value: ['宽字符一', '宽字符二'] });
await sleep(800);
const xState2 = await xApi('/api/state');
const av = (n) => xState2.vars.find(v => v.name === n)?.value;
ok('各种元素类型的数组整段写进去（int / real / word(uint) / bool / string / wstring）',
  arrWrite.ok === true && av('arrw')?.[0] === 1 && av('arrw')?.[12] === 13
  && Math.abs(av('arrReal')?.[3] - 4.5) < 0.001 && av('arrWord')?.[2] === 300
  && av('arrBool')?.[0] === true && av('arrBool')?.[1] === false
  && av('arrStr')?.[0] === '自动' && av('arrWStr')?.[1] === '宽字符二',
  JSON.stringify({ real: av('arrReal'), word: av('arrWord'), bool: av('arrBool'),
    str: av('arrStr'), wstr: av('arrWStr') }));
const elemWrite = await post('/api/vars', { name: 'arrw[3]', value: 999 });
const elemWriteR = await post('/api/vars', { name: 'arrReal[1]', value: 77.5 });
await sleep(700);
const xState3 = await xApi('/api/state');
const av3 = (n) => xState3.vars.find(v => v.name === n)?.value;
ok('数组按元素写（int 的 arrw[3] / real 的 arrReal[1] → 只改那一个，其余不动）',
  elemWrite.ok === true && elemWriteR.ok === true
  && av3('arrw')?.[3] === 999 && av3('arrw')?.[0] === 1 && av3('arrw')?.[12] === 13
  && Math.abs(av3('arrReal')?.[1] - 77.5) < 0.001 && Math.abs(av3('arrReal')?.[0] - 1.5) < 0.001,
  JSON.stringify({ arrw: av3('arrw')?.slice(0, 5), arrReal: av3('arrReal') }));
const elemWriteS = await post('/api/vars', { name: 'arrWStr[0]', value: '改一个宽串' });
await sleep(600);
const av4 = (await xApi('/api/state')).vars.find(v => v.name === 'arrWStr')?.value;
ok('字符串数组也能按元素写（arrWStr[0]，只动第 1 个）',
  elemWriteS.ok === true && av4?.[0] === '改一个宽串' && av4?.[1] === '宽字符二',
  JSON.stringify(av4));

/* 浏览器里走同一条路：变量表面板 → 从 OPC UA 导入 → 选 XML → 导入 */
await page.evaluate(() => document.querySelector('.lp-tab[data-panel="vars"]')?.click());
await sleep(300);
await page.click('#btnOpcImport');
await sleep(400);
const xmlDlg = await page.evaluate(() => ({
  title: document.getElementById('dlgTitle').textContent,
  mode: document.querySelector('input[name="oiMode"]:checked')?.value,
  xmlBox: document.getElementById('oiXmlBox')?.style.display !== 'none',
}));
ok('导入对话框默认就是「符号配置 XML」方式（离线，不用连服务器）',
  /导入变量/.test(xmlDlg.title || '') && xmlDlg.mode === 'xml' && xmlDlg.xmlBox, JSON.stringify(xmlDlg));
await page.setInputFiles('#oiXmlFile', FIXTURE);
await sleep(1500);
const xmlRows = await page.evaluate(() => ({
  rows: document.querySelectorAll('#oiList tbody tr').length,
  checked: document.querySelectorAll('#oiList input[data-pick]:checked').length,
  msg: document.getElementById('oiXmlMsg').textContent,
  device: document.getElementById('oiDevice').value,
}));
ok('选文件后自动解析：18 个符号、一维数组默认全勾（多维那个不勾）',
  xmlRows.rows === 18 && xmlRows.checked === 17 && xmlRows.device === 'Device',
  JSON.stringify(xmlRows).slice(0, 140));
ok('解析结果里说明了 NodeId 怎么拼出来',
  /ns=4;s=\|var\|Device\.Application/.test(xmlRows.msg),
  xmlRows.msg.replace(/\s+/g, ' ').slice(0, 140));
await page.click('#dlgOk');
await sleep(800);
const xmlImported = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const vs = m.project.variables();
  const by = (n) => vs.find(v => v.name === n);
  return {
    total: vs.length,
    xmlCount: vs.filter(v => /^ns=4;s=\|var\|Device\.Application\./.test(v.address || '')).length,
    // ⚠ 生成的变量名用**带点的符号路径**（GVL.a），不是裸名（a）：
    //   一个工程里同名符号很常见（GVL 里一个 a、某个 POU 里也有一个 a），
    //   裸名会撞车被改成 a_2，看不出是哪个；带 GVL/POU 这一段和 PLC 里的路径对得上。
    a: by('GVL.a'), c: by('GVL.c'), dd: by('GVL.dd'), wstring: by('GVL.wstring0'),
    arr1: by('GVL.arrw[1]'), arr13: by('GVL.arrw[13]'),
    // 老的「整块数组变量」不该再出现（数组一律展开成元素变量）
    oldArr: by('GVL.arrw'),
    // 裸名不该再生成（否则老工程会多出一份同地址的重名变量）
    bareA: by('a'),
  };
});
// 数组一律**自动展开**成单个元素变量：arrw(13) → arrw[1]…arrw[13]，
// 下标按 PLC 的写法（CODESYS 是 ARRAY[1..13] → 从 1 起），NodeId 直接接 [k]。
ok('XML 导入到变量表：10 个标量 + 7 个数组展开成 31 个元素 = 41 个（WSTRING 单独一类）',
  xmlImported.xmlCount === 41 && !xmlImported.oldArr && !xmlImported.bareA
  && xmlImported.arr1?.type === 'int'
  && xmlImported.arr1?.address === 'ns=4;s=|var|Device.Application.GVL.arrw[1]'
  && xmlImported.arr13?.address === 'ns=4;s=|var|Device.Application.GVL.arrw[13]'
  && xmlImported.a?.address === 'ns=4;s=|var|Device.Application.GVL.a' && xmlImported.a.type === 'int'
  && xmlImported.c.type === 'real' && xmlImported.dd.type === 'bool'
  && xmlImported.wstring.type === 'wstring',
  JSON.stringify({ total: xmlImported.total, xml: xmlImported.xmlCount, arr1: xmlImported.arr1, old: !!xmlImported.oldArr }));
void xmlText;

/* ══════ 9. 设备名对不上：连上了但变量读不到 → 一键纠正 ══════
   CODESYS 的符号 NodeId 里带**设备名**（|var|<设备名>.Application.POU.符号），
   而符号配置 XML 里的设备名是「导出那份工程」的设备名 —— 运行时上跑的应用来自另一个工程时
   整张变量表全部 BadNodeIdUnknown，表现就是「连是连上了，变量就是不动」。
   这里用模拟器重现：XML 说设备叫 Device，模拟器发布的名字换成 SimRuntime。 */
const Y_UA = await freePort();
const Y_WEB = await freePort();
const simY = spawn(PY, ['server/opcua_sim.py', '--port', String(Y_UA), '--web-port', String(Y_WEB),
  '--no-browser', '--device', 'SimRuntime', '--import-symbol-xml', FIXTURE], { cwd: ROOT, stdio: 'ignore' });
let yUp = false;
for (let i = 0; i < 40 && !yUp; i++) {
  await sleep(400);
  try { await fetch(`http://127.0.0.1:${Y_WEB}/api/state`).then(r => r.json()); yUp = true; } catch { /* 等 */ }
}
const yState = yUp ? await fetch(`http://127.0.0.1:${Y_WEB}/api/state`).then(r => r.json()) : { vars: [] };
ok('模拟服务器按「另一个设备名」发布符号（重现设备名对不上的现场）',
  yState.vars?.some(v => v.nodeid === 'ns=4;s=|var|SimRuntime.Application.GVL.a'),
  JSON.stringify((yState.vars || []).slice(0, 1).map(v => v.nodeid)));
const YEP = `opc.tcp://127.0.0.1:${Y_UA}`;
// 变量表清空后只放「XML 里那套」（设备名 Device）→ 连上去应该「全是坏地址」
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.commit('设备名错位测试准备');
});
await sleep(300);
const yConn = await post('/api/plc', {
  action: 'connect', protocol: 'opcua', endpoint: YEP, poll_ms: 300,
  variables: (parsed.nodes || []).map(n => ({ name: n.name, type: n.hmi_type, address: n.nodeid, len: n.len || n.elements || 0 })),
});
await sleep(2000);
const ySt = await wsHealth(PORT).then(j => j.plc);
ok('设备名对不上时：连上了但地址全读不到（bad_address 列出来，界面不装作正常）',
  // 后端为了不回大包，bad_address 只回前 10 个（界面上同样是显示前 10 个 + 省略号）
  yConn.ok === true && (ySt.bad_address || []).length === 10, JSON.stringify(ySt.bad_address));

// 一键纠正：从服务器捞真实 |var| 符号，按符号尾巴对号入座
const fix = await page.evaluate(async (ep) => {
  const m = await import('/js/core/project.js');
  const t = await import('/js/editor/toolbar.js');
  // 变量表里先摆成 XML 那套（设备名 Device），模拟「导出的那份工程和运行的不是同一个」
  const nodes = [
    ['a', 'int', 'ns=4;s=|var|Device.Application.GVL.a'],
    ['b', 'uint', 'ns=4;s=|var|Device.Application.GVL.b'],
    ['c', 'real', 'ns=4;s=|var|Device.Application.GVL.c'],
    ['d', 'lreal', 'ns=4;s=|var|Device.Application.GVL.d'],
    ['dd', 'bool', 'ns=4;s=|var|Device.Application.GVL.dd'],
    ['string0', 'string', 'ns=4;s=|var|Device.Application.GVL.string0'],
    ['w', 'uint', 'ns=4;s=|var|Device.Application.GVL.w'],
    ['wstring0', 'wstring', 'ns=4;s=|var|Device.Application.GVL.wstring0'],
  ];
  nodes.forEach(([name, type, address]) => m.project.data.variables.push({ name, type, address, value: 0, len: 0 }));
  m.project.commit('摆好设备名对不上的地址');
  return t.fixOpcAddresses({ endpoint: ep, security: 'none', username: '', password: '', defaultNs: 4 });
}, YEP);
ok('一键纠正：8 个地址全部按服务器实际符号改对（只有设备名不同）',
  fix.ok === true && fix.changed.length === 8 && fix.unmatched.length === 0
  && fix.changed.every(c => c.to.includes('|var|SimRuntime.Application.')),
  JSON.stringify({ total: fix.total, changed: fix.changed.length, unmatched: fix.unmatched, first: fix.changed[0] }));
await sleep(1500);
const yAfter = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { addrs: m.project.variables().map(v => v.address) };
});
ok('纠正后的地址写进了变量表（刷新/存盘都留着）',
  yAfter.addrs.length === 8 && yAfter.addrs.every(a => a.includes('|var|SimRuntime.Application.')),
  JSON.stringify(yAfter.addrs.slice(0, 2)));
const yHealth = await wsHealth(PORT).then(j => j.plc);
const yVals = (await api('/api/vars')).vars;
ok('纠正后变量表重新下发 → 坏地址清零、值到位（真的在通讯了）',
  (yHealth.bad_address || []).length === 0 && yHealth.online === true
  && typeof yVals.c === 'number' && yVals.dd === false,
  JSON.stringify({ bad: yHealth.bad_address, c: yVals.c, dd: yVals.dd }));

/* ══════ 10. 运行中掉线要有提示 + 恢复后先把现场数据读下来（Modbus / OPC UA 同一个机制） ══════ */
// 先把后端连回 simY（这一段要自己保证状态，别依赖上一段留下的连接）
await post('/api/plc', {
  action: 'connect', protocol: 'opcua', endpoint: YEP, poll_ms: 300,
  variables: [{ name: 'c', type: 'real', address: 'ns=4;s=|var|SimRuntime.Application.GVL.c' },
    { name: 'a', type: 'int', address: 'ns=4;s=|var|SimRuntime.Application.GVL.a' }],
});
await sleep(1500);
// offlineDelayMs：红条默认要"连续连不上 5 秒"才挂（见 runtime.js 那段说明）；
// 这段验的是"断了要报、恢复了要重读"，不是那个观察期，所以调小让节奏快点
await page.evaluate(() => { window.app.plcWatch.pollMs = 1000; window.app.plcWatch.remindMs = 2000; window.app.plcWatch.offlineDelayMs = 1000; });
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(1500);
const bannerBefore = await page.evaluate(() => {
  const b = document.getElementById('rtPlcAlarm');
  return { hidden: b?.classList.contains('hidden'), text: document.getElementById('rtPlcAlarmText')?.textContent || '' };
});
ok('运行中正常连着时不显示断开条', bannerBefore.hidden === true, JSON.stringify(bannerBefore));

// 把模拟服务器停掉 → 运行页面应当挂红条，文案认 OPC UA 并带端点
simY.kill();
const portUp = () => new Promise(res => {
  const s = net.connect({ host: '127.0.0.1', port: Y_UA });
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 800);
});
await sleep(1500);
const yUaStill = await portUp();
let bannerDown = null;
for (let i = 0; i < 40 && !bannerDown; i++) {
  await sleep(500);
  const b = await page.evaluate(() => {
    const el = document.getElementById('rtPlcAlarm');
    const sub = document.getElementById('rtPlcAlarmSub');
    return { hidden: el?.classList.contains('hidden'), ok: el?.classList.contains('ok'),
      text: document.getElementById('rtPlcAlarmText')?.textContent || '',
      sub: sub?.textContent || '', subTitle: sub?.title || '' };
  });
  if (b.hidden === false && b.text) bannerDown = b;
}
ok('模拟服务器确实被杀掉了（端口不再监听）', yUaStill === false, `UA ${Y_UA} 还在听=${yUaStill}`);
ok('OPC UA 掉线 → 运行页面挂出红条（文案是「OPC UA 已断开」+ 端点）',
  !!bannerDown && /OPC UA 已断开/.test(bannerDown.text) && bannerDown.text.includes(String(Y_UA)),
  JSON.stringify(bannerDown) + ' 后端：' + JSON.stringify(await wsHealth(PORT).then(j => j.plc).then(p => ({
    mode: p.mode, online: p.online, endpoint: p.endpoint, reads: p.reads, active: p.active,
    blocks: p.blocks, scoped: p.scoped, stale: p.stale, vars: p.vars, err: p.last_error,
    last_ok: p.last_ok,
  }))) + ' 页面：' + JSON.stringify(await page.evaluate(async () => {
    const b = await (await import('/js/api/backend.js')).backend.getPlc();
    const el = document.getElementById('rtPlcAlarm');
    return { mode: b?.status?.mode, online: b?.status?.online, ep: b?.status?.endpoint,
      hidden: el?.classList.contains('hidden'),
      text: document.getElementById('rtPlcAlarmText')?.textContent };
  })));
// 红条上**只说两件事**：哪台断了 + 断了多久（现场嫌原来那串太长：原因 + "断开期间写的值不会下发…"）；
// 后端给的原因改挂在那一行的悬停提示里（sub.title）
ok('红条上只写断开时长（后端给的原因挪到悬停提示，不再占屏幕）',
  /^已断开 \d+ 秒$/.test((bannerDown?.sub || '').trim()) && (bannerDown?.subTitle || '').length > 0,
  JSON.stringify({ sub: bannerDown?.sub, title: bannerDown?.subTitle }));

// 掉线期间改界面上的值 → 下发会失败，界面必须自动回到设备上的真实值（不留假值）
const staleWrite = await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  const before = vs.get('c');
  vs.set('c', 12345, 'local');             // 故意在掉线时改
  await new Promise(r => setTimeout(r, 1500));
  return { before, after: vs.get('c'), err: vs.lastWriteError?.message || '' };
});
ok('掉线时写的值不会留在界面上（下发失败 → 自动回读真实值盖回去）',
  staleWrite.after !== 12345 && /断开|未连接|连不上|closed/i.test(staleWrite.err || ''),
  JSON.stringify(staleWrite));

// 服务器回来 → 绿条 + 「已重新读取现场数据」
const simY2 = spawn(PY, ['server/opcua_sim.py', '--port', String(Y_UA), '--web-port', String(Y_WEB),
  '--no-browser', '--device', 'SimRuntime', '--import-symbol-xml', FIXTURE], { cwd: ROOT, stdio: 'ignore' });
let bannerOk = null;
for (let i = 0; i < 60 && !bannerOk; i++) {
  await sleep(500);
  const b = await page.evaluate(() => {
    const el = document.getElementById('rtPlcAlarm');
    return { hidden: el?.classList.contains('hidden'), ok: el?.classList.contains('ok'),
      text: document.getElementById('rtPlcAlarmText')?.textContent || '',
      sub: document.getElementById('rtPlcAlarmSub')?.textContent || '' };
  });
  if (b.hidden === false && b.ok) bannerOk = b;
}
ok('恢复后显示绿条「OPC UA 已恢复连接」',
  !!bannerOk && /已恢复连接/.test(bannerOk.text || ''), JSON.stringify(bannerOk));
ok('恢复后**先把现场数据重新读下来**（绿条里写明读了多少个、几个和界面上不一样）',
  /已重新读取现场数据/.test(bannerOk?.sub || '') && /\d+ 个变量/.test(bannerOk?.sub || ''),
  String(bannerOk?.sub));

// 界面上的值和设备上的值应当一致（重读生效）
await sleep(1000);
const afterSync = await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  const vars = await (await import('/js/api/backend.js')).backend.readVars();
  const diffs = Object.entries(vars).filter(([n, v]) => vs.get(n) !== v && !Array.isArray(v));
  return { checked: Object.keys(vars).length, diffs: diffs.slice(0, 3) };
});
ok('重读之后界面值与设备值一致（没有停在掉线前的旧值上）',
  afterSync.checked > 0 && afterSync.diffs.length === 0, JSON.stringify(afterSync));
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
try { simY2.kill(); } catch { /* 忽略 */ }

/* ══════ 带身份的服务器：匿名浏览要说人话、填了账号就能导（现场最常撞的一个坑）══════
   CODESYS 工程默认不许匿名：客户端带着匿名令牌去激活会话，服务器回
   BadSessionNotActivated —— 以前导入对话框压根不带密码，撞上就是一句天书。 */
const A_UA = await freePort();
const simAuth = spawn(PY, ['server/opcua_sim.py', '--port', String(A_UA), '--web-port', String(await freePort()),
  '--no-browser', '--user', 'ua', '--password', 'uapass'], { cwd: ROOT, stdio: 'ignore' });
await sleep(2500);
const authEp = `opc.tcp://127.0.0.1:${A_UA}`;

// ⚠ 先断开：后端如果已经连着这台服务器（带身份），浏览会**复用那条已认证的连接**，
//   匿名检查就复现不出来了（那是另一个用例要测的行为）
await post('/api/plc', { action: 'disconnect' });
await sleep(500);

// 匿名 = **明确传空字符串**（不带这两个字段是「没填」，后端会用当前连接那套身份兜底 —— 见下面那条用例）
const anonBrowse = await post('/api/opcua/browse', { endpoint: authEp, depth: 3, username: '', password: '' });
ok('服务器不许匿名时，匿名浏览会失败（复现现场那个 BadSessionNotActivated）',
  anonBrowse.ok === false, String(anonBrowse.message || '').slice(0, 80));
ok('失败信息里**直接告诉该怎么办**（填用户名/密码、CODESYS 里开匿名或用户名身份）',
  /用户名\s*\/\s*密码|用户名\/密码/.test(anonBrowse.message || '')
  && /OPC UA Server|匿名/.test(anonBrowse.message || ''),
  String(anonBrowse.message || '').slice(0, 160));

const withAuth = await post('/api/opcua/browse', { endpoint: authEp, depth: 3, username: 'ua', password: 'uapass' });
ok('填上用户名/密码就能浏览（找到节点）',
  withAuth.ok === true && (withAuth.nodes || []).length > 0,
  JSON.stringify({ ok: withAuth.ok, nodes: (withAuth.nodes || []).length, msg: withAuth.message }));

// 老前端不带 username/password 字段 → 后端用「当前连接那套身份」兜底
await post('/api/plc', { action: 'connect', protocol: 'opcua', endpoint: authEp, poll_ms: 500,
  username: 'ua', password: 'uapass', default_ns: 4,
  variables: [{ name: 'bRun', type: 'bool', address: 'ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun' }] });
await sleep(1500);
const fallbackBrowse = await post('/api/opcua/browse', { endpoint: authEp, depth: 3 });   // 故意不带身份字段
ok('老前端不带身份字段时，浏览沿用当前连接的账号（不再默默走匿名）',
  fallbackBrowse.ok === true, JSON.stringify({ ok: fallbackBrowse.ok, msg: String(fallbackBrowse.message || '').slice(0, 80) }));

// 后端把配好的连接（含账号）存着：连接对话框/导入对话框就能带回来，现场不用每次重敲。
// ⚠ 口令只发给**登录过的**会话（这条后端是 --no-auth 起的，等于全放行 → 这里能拿到；
//   开着闸门又没登录时不给口令，那条在 verify-run-only.mjs 里验）
const plcCfgKept = await api('/api/plc');
ok('GET /api/plc 带得回已保存的连接配置（含账号密码，对话框不用重敲）',
  plcCfgKept.config?.username === 'ua' && plcCfgKept.config?.password === 'uapass',
  JSON.stringify({ user: plcCfgKept.config?.username, has_pw: !!plcCfgKept.config?.password }));

// 界面上：导入对话框要有「用户名 / 密码」两格，并且真能拿它导进来
await post('/api/plc', { action: 'disconnect' });
await page.evaluate(() => document.querySelector('.lp-tab[data-panel="vars"]')?.click());
await sleep(300);
await page.click('#btnOpcImport');
await sleep(400);
await page.click('input[name="oiMode"][value="live"]');
await sleep(300);
const fields = await page.evaluate(() => ({
  user: !!document.getElementById('oiUser'), pass: !!document.getElementById('oiPass'),
  passType: document.getElementById('oiPass')?.type,
}));
ok('导入对话框（连服务器浏览）里有「用户名 / 密码」两格', fields.user && fields.pass && fields.passType === 'password',
  JSON.stringify(fields));
await page.fill('#oiEp', authEp);
await page.fill('#oiUser', 'ua');
await page.fill('#oiPass', 'uapass');
await page.fill('#oiDepth', '4');
await page.click('#oiBrowse');
let browseMsg = '';
for (let i = 0; i < 30; i++) {
  await sleep(500);
  browseMsg = await page.textContent('#oiMsg');
  if (/找到|失败/.test(browseMsg || '')) break;
}
ok('在对话框里填账号点「浏览节点」→ 真的浏览成功（不再是 BadSessionNotActivated）',
  /找到\s*\d+\s*个/.test(browseMsg || ''), String(browseMsg).slice(0, 120));
await page.evaluate(() => document.getElementById('dlgCancel')?.click());
try { simAuth.kill(); } catch { /* 忽略 */ }

/* ══════ 清理 ══════ */
try { await post('/api/plc', { action: 'disconnect' }); } catch { /* 忽略 */ }
await browser.close();
try { sim.kill(); } catch { /* 已死 */ }
try { sim2.kill(); } catch { /* 忽略 */ }
try { simX.kill(); } catch { /* 忽略 */ }
try { simY.kill(); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== OPC UA 全链路回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
