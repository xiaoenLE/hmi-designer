// verify-plc.mjs — PLC 对接：地址解析 / Modbus 主站 / 模拟 PLC / 后端数据源 / 界面连接
//   1) Python 侧单元：%MW/%MD/%MB/%MX 解析与编解码（手册表 5-6 的对应关系）
//   2) 起一个模拟 PLC（server/plc_sim.py），后端连上去，验证 读 / 写 / 轮询 / 坏地址
//   3) 浏览器里点「🔌 PLC」对话框连接，状态栏显示在线，界面上的值跟着模拟 PLC 变
// 用法：先启动 8866 后端，再 node test/verify-plc.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const HEAD = `http://127.0.0.1:${process.argv[2] || '8866'}`;
// 端口现取现用：固定端口会撞上用户自己开的模拟器（Windows 上 allow_reuse_address
// 会让两个实例同时 bind 同一端口，请求落到哪个进程不确定 → 数据时对时错）
const freePort = () => new Promise((res, rej) => {
  const srv = net.createServer();
  srv.on('error', rej);
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
});
const SIM_MB = await freePort();          // 模拟 PLC 的 Modbus 端口
const SIM_WEB = await freePort();         // 模拟 PLC 的网页端口
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

async function api(pathname, opts) {
  const r = await fetch(HEAD + pathname, opts);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: r.status }; }
}
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});
const simState = async () => (await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`)).json();
const simWrite = (body) => fetch(`http://127.0.0.1:${SIM_WEB}/api/write`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 模拟 PLC 里 %MD48（寄存器 96/97，低字在前）解出来的 REAL；寄存器还没写过返回 null */
function mw48Float(st) {
  const lo = st.holding['96'], hi = st.holding['97'];
  if (lo === undefined || hi === undefined) return null;
  const buf = new ArrayBuffer(4); new DataView(buf).setUint32(0, ((lo | (hi << 16)) >>> 0));
  return new DataView(buf).getFloat32(0);
}

/* ══════ 1. Python 侧：地址解析与编解码（手册表 5-6）══════ */
const py = `
import sys
sys.path.insert(0, r'${ROOT.replace(/\\/g, '\\\\')}\\server')
from modbus import (parse_address, decode_value, encode_value,
                    words_for, normalize_order, order_ok, WORD_ORDERS)
def eq(name, got, want):
    print(('PASS' if got == want else 'FAIL') + '  ' + name + '  [' + repr(got) + ']')
a = parse_address('%MW96');   eq('%MW96 → 保持寄存器96', (a.area, a.offset, a.words), ('holding', 96, 1))
a = parse_address('%MD48');   eq('%MD48 → 双字(96起2字)', (a.area, a.offset, a.words), ('holding', 96, 2))
a = parse_address('%MB194');  eq('%MB194 → MW97 低字节', (a.offset, a.byte), (97, 0))
a = parse_address('%MB195');  eq('%MB195 → MW97 高字节', (a.offset, a.byte), (97, 1))
a = parse_address('%MX195.0');eq('%MX195.0 → MW97 bit8', (a.offset, a.bit), (97, 8))
a = parse_address('%MX194.3');eq('%MX194.3 → MW97 bit3', (a.offset, a.bit), (97, 3))
a = parse_address('%QX1.2');  eq('%QX1.2 → 线圈10', (a.area, a.offset), ('coil', 10))
a = parse_address('%IX0');    eq('%IX0 → 离散输入', (a.area, a.offset), ('discrete', 0))
a = parse_address('%IW5');    eq('%IW5 → 输入寄存器', (a.area, a.offset), ('input_reg', 5))
a = parse_address('HR100');   eq('HR100 兼容写法', (a.area, a.offset), ('holding', 100))
a = parse_address('40101');   eq('40101 → 寄存器100', (a.offset,), (100,))
eq('REAL 12.5 低字在前 → [0x0000, 0x4148]', encode_value(12.5, 'real', 2, 'low'), [0x0000, 0x4148])
eq('读回 REAL', round(decode_value([0x0000, 0x4148], 'real', 'low'), 3), 12.5)
eq('DINT -123456 往返', decode_value(encode_value(-123456, 'dint', 2, 'low'), 'dint', 'low'), -123456)
eq('INT -5 往返', decode_value(encode_value(-5, 'int', 1, 'low'), 'int', 'low'), -5)
eq('字节取值 %MB194', decode_value([0x4148], 'uint', 'low', byte=0), 0x48)

# ── 双字/浮点 4 种字序（3.14159f = 0x40490FD0，4 种布局互不相同）──
for o, exp in (('abcd', [0x4049, 0x0fd0]), ('cdab', [0x0fd0, 0x4049]),
               ('badc', [0x4940, 0xd00f]), ('dcba', [0xd00f, 0x4940])):
    eq(f'{o.upper()} 字序编出的寄存器布局', encode_value(3.14159, 'real', 2, o), exp)
    eq(f'{o.upper()} 字序往返一致', round(decode_value(exp, 'real', o), 5), 3.14159)
eq('4 种字序互不相同',
   len({tuple(encode_value(3.14159, 'real', 2, o)) for o in WORD_ORDERS}), 4)
eq('老配置 low/high 仍是别名', (normalize_order('low'), normalize_order('high')), ('cdab', 'abcd'))
eq('认不出的字序能被识别出来（不再静默当 cdab）', order_ok('xyz'), False)
# ── 字长按类型算：real/dint=2、lreal=4（地址只写 1 个字也一样）──
eq('words_for real@%MW → 2 字', words_for('real', 1), 2)
eq('words_for dint@%MW → 2 字', words_for('dint', 1), 2)
eq('words_for lreal@%MW → 4 字', words_for('lreal', 1), 4)
eq('words_for int@%MW → 1 字', words_for('int', 1), 1)
eq('words_for int@%MD → 仍是 2 字（老行为）', words_for('int', 2), 2)
try:
    decode_value([0x3333], 'real', 'cdab'); print('FAIL  real 只给 1 个字应该报错')
except ValueError: print('PASS  real 只给 1 个字明确报错（不再出 6.4757e-320 这种数）')
try:
    decode_value([1, 2], 'lreal', 'cdab'); print('FAIL  lreal 只给 2 个字应该报错')
except ValueError: print('PASS  lreal 只给 2 个字明确报错')
# ── 地址段写法 %MW200[10] 与字符串长度 ──
a = parse_address('%MW200[10]'); eq('%MW200[10] → 从 200 起 10 个字', (a.offset, a.words), (200, 10))
a = parse_address('%MD48[4]');   eq('%MD48[4] → 从 96 起 4 个字', (a.offset, a.words), (96, 4))
try:
    parse_address('%MW200[0]'); print('FAIL  [0] 应该报错')
except ValueError: print('PASS  [0] 段长报错')
eq('words_for string(10 字符) → 5 个字', words_for('string', 1, 10), 5)
eq('words_for string(没填长度) → 按地址里的字数', words_for('string', 8, None), 8)
eq('字符串编码：一个字两个字符、先低字节', encode_value('ABCDEF', 'string', 5, 'cdab', length=10),
   [0x4241, 0x4443, 0x4645, 0x0000, 0x0000])
eq('字符串解码回去', decode_value([0x4241, 0x4443, 0x4645, 0, 0], 'string', 'cdab', length=10), 'ABCDEF')
eq('字符串奇数长度补 0', decode_value(encode_value('ABC', 'string', 2, 'cdab', length=4), 'string', 'cdab', length=4), 'ABC')
eq('字符串超出长度被截断', decode_value(encode_value('ABCDEFGH', 'string', 2, 'cdab', length=4), 'string', 'cdab', length=4), 'ABCD')
eq('空字符串 → 全 0', encode_value('', 'string', 2, 'cdab', length=4), [0, 0])
try:
    parse_address('%XX9'); print('FAIL  非法地址应报错')
except ValueError: print('PASS  非法地址报错')
`;

/* 写失败去重表（_err_seen）：键**只按变量名**，绝不能把异常文本掺进来。
   现场"设备断开时内存涨得更快"就有它一份：Modbus 的异常文本里带**每次都变的事务号**
   （「事务号不匹配（发 12 收 13）」），按 f"{name}|{e}" 当键的话，每次失败都算新的一条、
   表只加不减，跑一晚上几十万条。这里用一个"错误文本每次都变"的假数据源压 60 次，
   断言表里只有 1 条键、而且不会超过上限。 */
const pyErr = `
import json, sys, threading, time, http.client
sys.path.insert(0, r'${ROOT.replace(/\\/g, '\\\\')}\\server')
import server as S

class FlakySource:
    """写必失败，而且异常文本每次都不一样（模拟事务号变化）"""
    def __init__(self): self.n = 0
    def meta(self): return {'wFail': {'type': 'int'}}
    def read_all(self): return {}
    def write(self, name, value):
        self.n += 1
        raise RuntimeError('事务号不匹配（发 %d 收 %d）' % (self.n, self.n + 1))

S._err_seen.clear()
# ⚠ 换数据源要走 set_source()：直接写 S._source = ... 只在"数据源就是 server 模块的一个全局"
#   那会儿管用（拆成 core/ 之后 _source 住在 core.datasource 里，那么写只是挂个影子属性，
#   真正的数据源没换 —— 测试会静默地拿不到预期报错）
S.datasource.set_source(FlakySource())
srv = S.QuietThreadingHTTPServer(('127.0.0.1', 0), S.HMIServer)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
fails = 0
for i in range(60):
    c.request('POST', '/api/vars', body=json.dumps({'name': 'wFail', 'value': i}),
              headers={'Content-Type': 'application/json'})
    r = c.getresponse(); r.read()
    if r.status == 400: fails += 1
c.close(); srv.shutdown()
print(('PASS' if fails == 60 else 'FAIL') + '  写失败 60 次都如实返回 400（%d 次）' % fails)
print(('PASS' if len(S._err_seen) == 1 else 'FAIL')
      + '  错误文本每次都变，去重表仍只按变量名记 1 条（%d 条）' % len(S._err_seen))
print(('PASS' if len(S._err_seen) <= S.ERR_SEEN_CAP else 'FAIL')
      + '  去重表不超过上限 %d' % S.ERR_SEEN_CAP)
`;
let pyErrOut = '';
try {
  pyErrOut = execFileSync('python', ['-c', pyErr], { encoding: 'utf-8' });
} catch (e) {
  pyErrOut = String(e.stdout || '') + String(e.stderr || '');
}
pyErrOut.split('\n').filter(l => l.trim()).forEach(line => {
  const m = /^(PASS|FAIL)\s+(.*)$/.exec(line.trim());
  if (m) ok('py: ' + m[2], m[1] === 'PASS');
});
let pyOut = '';
try {
  pyOut = execFileSync('python', ['-c', py], { encoding: 'utf-8' });
} catch (e) {
  pyOut = String(e.stdout || '') + String(e.stderr || '');
}
pyOut.split('\n').filter(l => l.trim()).forEach(line => {
  const m = /^(PASS|FAIL)\s+(.*)$/.exec(line.trim());
  if (m) ok('py: ' + m[2], m[1] === 'PASS');
});

/* ══════ 2. 起模拟 PLC（端口现取现用，不会撞上用户自己开的模拟器）══════ */
const sim = spawn('python', ['server/plc_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore' });
let simUp = false;
for (let i = 0; i < 30 && !simUp; i++) {
  await sleep(300);
  try { await simState(); simUp = true; } catch { /* 还没起来 */ }
}
ok('模拟 PLC 已启动（Modbus 从站 + 网页调试台）', simUp, `mb=${SIM_MB} web=${SIM_WEB}`);
if (simUp) {
  const st0 = await simState();
  ok('模拟 PLC 预置了数据（%MW100=1250 / %MW104=8600）',
    st0.holding['100'] === 1250 && st0.holding['104'] === 8600, JSON.stringify({ mw100: st0.holding['100'], mw104: st0.holding['104'] }));
  ok('模拟 PLC 有自动正弦的字（方便看波形）', Object.keys(st0.auto).length > 0, JSON.stringify(Object.keys(st0.auto)));

  /* 模拟 PLC 的 REAL 输出：手动写 + 自动输出选 REAL（用来验证 REAL 通道） */
  const f32 = (v) => { const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, v); return new DataView(b).getUint32(0); };
  const readF32 = (st, a) => {
    const lo = st.holding[String(a)] ?? 0, hi = st.holding[String(a + 1)] ?? 0;
    const b = new ArrayBuffer(4); new DataView(b).setUint32(0, ((lo | (hi << 16)) >>> 0));
    return new DataView(b).getFloat32(0);
  };
  const u125 = f32(12.5);
  await simWrite({ kind: 'w', addr: 220, value: u125 & 0xFFFF });
  await simWrite({ kind: 'w', addr: 221, value: (u125 >>> 16) & 0xFFFF });
  await sleep(300);
  const stR = await simState();
  ok('模拟 PLC：网页里能手动写 REAL（%MW220/221 = 12.5，低字在前）',
    readF32(stR, 220) === 12.5, `${(stR.holding['220'] ?? 0).toString(16)}/${(stR.holding['221'] ?? 0).toString(16)} → ${readF32(stR, 220)}`);

  await fetch(`http://127.0.0.1:${SIM_WEB}/api/auto`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addr: 240, on: true, type: 'real', amp: 50, mid: 60, period: 4 }),
  });
  await sleep(1200);
  const stA = await simState();
  const vA = readF32(stA, 240), vB = readF32(stA, 240);
  ok('模拟 PLC：自动输出可选 REAL（在 %MW240/241 上跑浮点正弦）',
    stA.auto['240']?.type === 'real' && Number.isFinite(vA) && vA >= 9 && vA <= 111,
    `type=${stA.auto['240']?.type} 读数=${vA}`);
  await sleep(400);
  const stA2 = await simState();
  ok('模拟 PLC：REAL 自动输出在变化（不是定值）', readF32(stA2, 240) !== readF32(stA, 240),
    `${readF32(stA, 240)} → ${readF32(stA2, 240)}`);
  await fetch(`http://127.0.0.1:${SIM_WEB}/api/auto`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addr: 240, on: false }),
  });
}

/* ══════ 3. 后端连上模拟 PLC（Modbus 主站）══════ */
await post('/api/plc', { action: 'disconnect' });
const conn = await post('/api/plc', {
  action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'low',
  variables: [
    { name: 'rSpeed', type: 'real', address: '%MD48' },
    { name: 'iCount', type: 'int', address: '%MW104' },
    { name: 'rSetSpeed', type: 'real', address: '%MD50' },
    { name: 'bRunCmd', type: 'bool', address: '%QX0' },
    { name: 'bAlarm', type: 'bool', address: '%MX194.0' },
    { name: 'bAlarmHi', type: 'bool', address: '%MX195.0' },   // 高字节那位（%MW97 的 bit8）
    { name: 'badAddr', type: 'int', address: '%XX9' },
    { name: 'bAtReg', type: 'bool', address: 'HR120' },     // bool 落在整字上
    { name: 'bAtMb', type: 'bool', address: '%MB243' },     // bool 落在字节上（%MW121 高字节）
    { name: 'qb2', type: 'int', address: '%QB2' },          // 输出字节 = 线圈 16~23
    { name: 'qb3', type: 'int', address: '%QB3' },          // 输出字节 = 线圈 24~31（验证不被 qb2 盖掉）
    { name: 'qd8', type: 'udint', address: '%QD8' },        // 输出双字 = 线圈 256~287
    { name: 'ixBit', type: 'bool', address: '%IX0' },       // 离散输入（只读）
    { name: 'ixBit2', type: 'bool', address: '%IX1.2' },    // 离散位 10（只读）
    { name: 'iwWord', type: 'int', address: '%IW5' },       // 输入寄存器（只读）
    { name: 'ibByte', type: 'int', address: '%IB200' },     // 输入字节 = %IW100 低字节（只读）
    { name: 'idDword', type: 'udint', address: '%ID60' },   // 输入双字 = %IW120+%IW121（只读）
  ],
});
ok('后端切换到 Modbus TCP 数据源', conn.ok === true && conn.status?.mode === 'plc', JSON.stringify(conn.status?.mode));
// ★ connect 里**当场探一次活**并把结果带回来：连接对话框靠它判成败。
//   只等"后台轮询报在线"是不行的 —— 没人看运行画面时后端根本不采（poll_gate），
//   编辑器里按「确定」就永远等不到在线，只会弹「连接没有成功：设备没有响应」（现场踩过）。
ok('★ connect 带回探活结果（对话框据此立刻判成功，不等后台轮询）',
  conn.probe && conn.probe.ok === true, JSON.stringify(conn.probe));
await sleep(900);
const st1 = (await api('/api/plc')).status;
ok('轮询起来了（读到值 / 在线）', st1.online === true && st1.reads > 2, `online=${st1.online} reads=${st1.reads}`);
ok('解析不了的地址被列出来（%XX9）', (st1.bad_address || []).includes('badAddr'), JSON.stringify(st1.bad_address));

/* 读：模拟 PLC 改值 → 后端读到 */
await simWrite({ kind: 'w', addr: 104, value: 4321 });
await sleep(700);
let vars = (await api('/api/vars')).vars;
ok('模拟 PLC 改 %MW104=4321 → 后端读回 iCount=4321', vars.iCount === 4321, `iCount=${vars.iCount}`);
await simWrite({ kind: 'w', addr: 100, value: 33.3 });   // 这里故意写整字（%MD50 的低字）
await sleep(700);
vars = (await api('/api/vars')).vars;
ok('模拟 PLC 改 %MW100 → 后端 %MD50 的整数部分可见', typeof vars.rSetSpeed === 'number', `rSetSpeed=${vars.rSetSpeed}`);

/* 写：后端写 REAL → 模拟 PLC 的寄存器按手册低字在前落位 */
await post('/api/vars', { name: 'rSetSpeed', value: 33.3 });
await sleep(500);
const simAfter = await simState();
const w100 = simAfter.holding['100'], w101 = simAfter.holding['101'];
ok('后端写 REAL 33.3 → 模拟 PLC %MW100=0x3333 / %MW101=0x4205（低字在前）',
  w100 === 0x3333 && w101 === 0x4205, `MW100=${w100}(${w100?.toString(16)}) MW101=${w101}(${w101?.toString(16)})`);

/* 写 bool → %QX0 线圈 */
await post('/api/vars', { name: 'bRunCmd', value: true });
await sleep(500);
const coils = (await simState()).coils;
ok('后端写 bool → 模拟 PLC 线圈 %QX0 = ON', coils['0'] === true, JSON.stringify(coils['0']));

/* 写 bool → 整字/字节地址（HR、%MB，没写位也没写字节）：必须能写，别 TypeError */
await simWrite({ kind: 'w', addr: 121, value: 0 });
await post('/api/vars', { name: 'bAtReg', value: true });
await post('/api/vars', { name: 'bAtMb', value: true });
await sleep(700);
const bReg = await simState();
const bVals = (await api('/api/vars')).vars;
ok('bool 落在整字地址（HR120）→ 寄存器写 1（以前 TypeError 写不进去）',
  bReg.holding['120'] === 1, `MW120=${bReg.holding['120']}`);
ok('bool 落在字节地址（%MB243 = %MW121 高字节）→ 只改高字节',
  bReg.holding['121'] === 0x0100, `MW121=${(bReg.holding['121'] ?? 0).toString(16)}`);
ok('整字 bool 读回来是 true', bVals.bAtReg === true, JSON.stringify(bVals.bAtReg));

/* 写 bool → %MX194.0（内存位，落 %MW97 的 bit0） */
await simWrite({ kind: 'w', addr: 97, value: 0 });
await post('/api/vars', { name: 'bAlarm', value: true });
await sleep(600);
const mw97 = (await simState()).holding['97'];
ok('后端写内存位 %MX194.0 → 模拟 PLC %MW97 = 0x0001', mw97 === 0x0001, `MW97=${mw97}`);

/* 读方向的关键回归：%MX 也必须按**声明的位号**取值。
   以前轮询里 decode_value 的 bit 传的是 None（当 bit0 用）→ 同一个字上的位变量全都
   跟着第 0 位跑：%MX1.x 以上的位在界面上永远是 false、点它也不变。 */
await simWrite({ kind: 'w', addr: 97, value: 0x0100 });          // 只置 bit8
await sleep(800);
let mv = (await api('/api/vars')).vars;
ok('%MW97=0x0100 → %MX195.0（bit8）为 true', mv.bAlarmHi === true, JSON.stringify(mv.bAlarmHi));
ok('%MW97=0x0100 → %MX194.0（bit0）为 false', mv.bAlarm === false, JSON.stringify(mv.bAlarm));
await simWrite({ kind: 'w', addr: 97, value: 0x0001 });          // 只置 bit0
await sleep(800);
mv = (await api('/api/vars')).vars;
ok('%MW97=0x0001 → %MX194.0 为 true 且 %MX195.0 为 false（两位各认各的）',
  mv.bAlarm === true && mv.bAlarmHi === false, JSON.stringify({ bit0: mv.bAlarm, bit8: mv.bAlarmHi }));

/* ══════ 3c. I / Q 区全套写法：位·字节·字·双字都能读，输出区能写、输入区明确拒写 ══════ */
const simCoilsWord = async (start, n) => {
  const st = await simState();
  let w = 0;
  for (let i = 0; i < n; i++) if (st.coils[String(start + i)]) w |= (1 << i);
  return w >>> 0;
};
await simWrite({ kind: 'iw', addr: 5, value: 1234 });
await simWrite({ kind: 'iw', addr: 100, value: 0x00CD });        // %IB200 = %IW100 低字节
await simWrite({ kind: 'iw', addr: 120, value: 0x5678 });        // %ID60 低字
await simWrite({ kind: 'iw', addr: 121, value: 0x1234 });        // %ID60 高字
await simWrite({ kind: 'bit', area: 'discrete', addr: 0, value: true });
await simWrite({ kind: 'bit', area: 'discrete', addr: 10, value: true });
await sleep(900);
const iv = (await api('/api/vars')).vars;
ok('%IX0 / %IX1.2 读得到（离散输入位，FC02）', iv.ixBit === true && iv.ixBit2 === true,
  JSON.stringify({ ix0: iv.ixBit, ix1_2: iv.ixBit2 }));
ok('%IW5 读 = 1234（输入寄存器，FC04）', iv.iwWord === 1234, JSON.stringify(iv.iwWord));
ok('%IB200 读 = 0xCD（=%IW100 的低字节）', iv.ibByte === 0xCD, JSON.stringify(iv.ibByte));
ok('%ID60 读 = 0x12345678（=%IW120 低 + %IW121 高）', iv.idDword === 0x12345678, JSON.stringify(iv.idDword));

await post('/api/vars', { name: 'qb2', value: 0x5A });
await post('/api/vars', { name: 'qd8', value: 0x12345678 });
await sleep(1000);
ok('%QB2 写 0x5A → 模拟 PLC 线圈 16~23 = 0x5A', (await simCoilsWord(16, 8)) === 0x5A,
  `0x${(await simCoilsWord(16, 8)).toString(16)}`);
ok('%QB2 写只动那 8 位，没盖掉 %QB3（线圈 24~31 仍为 0）', (await simCoilsWord(24, 8)) === 0,
  `0x${(await simCoilsWord(24, 8)).toString(16)}`);
ok('%QD8 写 0x12345678 → 线圈 256~287 拼出来一致', (await simCoilsWord(256, 32)) === 0x12345678,
  `0x${(await simCoilsWord(256, 32)).toString(16)}`);
for (const [name, cn] of [['ixBit', '%IX'], ['iwWord', '%IW'], ['ibByte', '%IB'], ['idDword', '%ID']]) {
  const r = await post('/api/vars', { name, value: 1 });
  ok(`写 ${cn}（输入区）被明确拒绝：只读`, r.ok === false && /只读/.test(r.error || ''), JSON.stringify(r.error || r));
}

/* ══════ 3b. REAL 的字长/字序（现场最容易配错的两件事）══════ */
// ① 类型 real + 地址只写一个字 %MW124：必须按 2 个字读写，
//    以前轮询按地址字长只读 1 个字，16 位被当成 double 解 → 界面出现 6.4757e-320
await post('/api/plc', { action: 'disconnect' });
const conn3b = await post('/api/plc', {
  action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab',
  variables: [{ name: 'rAtMw', type: 'real', address: '%MW124' },
              { name: 'rBig', type: 'lreal', address: '%MW130' }],
});
ok('3b 段：后端换成只有 2 个变量的表（连接真的生效了）',
  conn3b.ok === true && conn3b.status?.vars === 2, JSON.stringify(conn3b.status));
await sleep(900);
await post('/api/vars', { name: 'rAtMw', value: 33.3 });
await sleep(700);
const mw = await simState();
const vAtMw = (await api('/api/vars')).vars.rAtMw;
ok('real 写在 %MW124（单字地址）自动占 124/125 两个字',
  mw.holding['124'] === 0x3333 && mw.holding['125'] === 0x4205,
  `MW124=${mw.holding['124']?.toString(16)} MW125=${mw.holding['125']?.toString(16)}`);
ok('real@%MW 轮询读回 33.3（不再是 6.4757e-320 这种非规格化数）',
  typeof vAtMw === 'number' && Math.abs(vAtMw - 33.3) < 1e-3 && Math.abs(vAtMw) > 1e-30, `rAtMw=${vAtMw}`);
// ② lreal 占 4 个字
const vBig = (await api('/api/vars')).vars.rBig;
ok('lreal 按 4 个字读写（地址只写 %MW130 也能读回合理值）',
  typeof vBig === 'number' && (vBig === 0 || Math.abs(vBig) > 1e-300), `rBig=${vBig}`);

/* ③ 换字序 DCBA：写同样的 3.14159，寄存器布局必须跟着变 */
await post('/api/plc', {
  action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'dcba',
  variables: [{ name: 'rAtMw', type: 'real', address: '%MW124' }],
});
await sleep(900);
await post('/api/vars', { name: 'rAtMw', value: 3.14159 });
await sleep(700);
const mwD = await simState();
ok('字序 DCBA → %MW124/125 = 0xD00F / 0x4940',
  mwD.holding['124'] === 0xD00F && mwD.holding['125'] === 0x4940,
  `MW124=${mwD.holding['124']?.toString(16)} MW125=${mwD.holding['125']?.toString(16)}`);
const vD = (await api('/api/vars')).vars.rAtMw;
ok('DCBA 写进去再读回来还是 3.14159', Math.abs(vD - 3.14159) < 1e-5, `rAtMw=${vD}`);

/* ④ 字序体检接口（只读）：4 种各读一遍，CDAB 这个位子上应该是 33.3 */
await post('/api/plc', {
  action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab',
  variables: [{ name: 'rAtMw', type: 'real', address: '%MW124' }],
});
await sleep(900);
await post('/api/vars', { name: 'rAtMw', value: 33.3 });
await sleep(600);
const probe = await post('/api/plc', { action: 'orders', address: '%MW124', vtype: 'real' });
const cdabV = probe.candidates?.find(c => c.order === 'cdab')?.value;
ok('字序体检返回 4 种候选，且 CDAB 的是正确值',
  probe.ok === true && probe.candidates?.length === 4 && Math.abs(cdabV - 33.3) < 1e-3,
  JSON.stringify(probe.candidates?.map(c => [c.order, c.value])));
ok('字序体检查到的原始寄存器是 0x3333/0x4205',
  JSON.stringify(probe.words) === JSON.stringify(['0x3333', '0x4205']), JSON.stringify(probe.words));

/* ⑤ 乱填字序要被拒绝，不能悄悄按默认值跑 */
const badOrder = await post('/api/plc', { action: 'connect', ip: '127.0.0.1', port: SIM_MB, word_order: 'xyz' });
ok('认不出的字序直接被拒绝（不再静默当 cdab）',
  badOrder.ok === false && /abcd|cdab/.test(badOrder.error || ''), JSON.stringify(badOrder).slice(0, 120));

/* ══════ 3c. 字符串：地址 + 长度（范围）组合 ══════ */
await post('/api/plc', { action: 'disconnect' });
await post('/api/plc', {
  action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab',
  variables: [
    { name: 'sMsg', type: 'string', address: '%MW200', len: 10 },   // 长度列：10 字符 → 5 个字
    { name: 'sTag', type: 'string', address: '%MW210[8]' },         // 地址里的段写法：8 个字 → 16 字符
  ],
});
await sleep(900);
await post('/api/vars', { name: 'sMsg', value: 'Hello' });
await post('/api/vars', { name: 'sTag', value: 'ABC' });
await sleep(800);
const sw = (await simState()).holding;
const hexOf = (a) => (sw[String(a)] ?? 0).toString(16);
ok('字符串「长度 10 字符」占 5 个字：%MW200..204 = 48 65 / 6C 6C / 6F 00 / 00 / 00',
  sw['200'] === 0x6548 && sw['201'] === 0x6C6C && sw['202'] === 0x006F && sw['203'] === 0 && sw['204'] === 0,
  [200, 201, 202, 203, 204].map(a => `${a}=${hexOf(a)}`).join(' '));
const varsS = (await api('/api/vars')).vars;
ok('字符串写进去再读回来一致', varsS.sMsg === 'Hello', `sMsg=${JSON.stringify(varsS.sMsg)}`);
ok('地址里的段写法 %MW210[8] 也按 8 个字（16 字符）读', varsS.sTag === 'ABC', `sTag=${JSON.stringify(varsS.sTag)}`);
// 从 PLC 侧改寄存器 → 界面按字符串读回
await simWrite({ kind: 'w', addr: 200, value: 0x6F57 });   // 'W','o'
await simWrite({ kind: 'w', addr: 201, value: 0x6C72 });   // 'r','l'
await simWrite({ kind: 'w', addr: 202, value: 0x0064 });   // 'd'
await sleep(800);
const s2 = (await api('/api/vars')).vars.sMsg;
ok('模拟 PLC 改寄存器 → 界面字符串跟着变（World）', s2 === 'World', JSON.stringify(s2));

/* ⑥ 后端能力表：前端靠它发现「后端忘重启」 */
const health = await api('/api/health');
ok('后端报告 build + features（供前端判断是不是配套版本）',
  typeof health.build === 'string' && health.build.length > 0
  && ['word_order4', 'words_by_type', 'string_range', 'orders_probe'].every(f => (health.features || []).includes(f)),
  `build=${health.build} features=${JSON.stringify(health.features)}`);

/* ══════ 4. 浏览器端：对话框连接 + 状态栏 + 数值跟着变 ══════ */
await post('/api/plc', { action: 'disconnect' });
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const pageErrors = [];
const dlgAlerts = [];                       // 弹窗（alert/confirm）记下来：有些动作**不该**弹窗
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => { dlgAlerts.push(d.message()); d.accept(); });
await page.goto(HEAD + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(400);

// ⚠ 这一段整段都按**变量名**在变量表里改地址/改类型，名字不能靠种子工程（内置模板会换）。
//   这里摆回这套用例原本依赖的那张小表（老种子工程就是这 6 个变量），后面整段照旧。
await page.evaluate(async () => {
  const pr = window.app.project;
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  const bk = (await import('/js/api/backend.js')).backend;
  pr.data.variables.length = 0;
  [['bRunCmd', 'bool', '%MX0.0', false], ['bRunStatus', 'bool', '%MX0.1', false],
   ['bAlarm', 'bool', '%MX0.2', false], ['rSpeed', 'real', '%MW100', 12.5],
   ['rSetSpeed', 'real', '%MW102', 0], ['iCount', 'int', '%MW104', 0]].forEach(([name, type, address, value]) => {
    pr.data.variables.push({ name, type, address, value });
  });
  pr.commit('PLC 浏览器验证用的变量表');
  vs.resetFrom(pr.variables());
  // ⚠ 还要**按"全部采集"下发一次**：编辑器默认只把"本页控件用到的变量"报给后端（按页采集），
  //   这张表里的变量没被本页任何控件用到 → 后端一个都不轮询 → 界面上永远等不到 PLC 的值
  //   （老种子工程里首页控件正好绑着 rSpeed，所以以前不用管这一步）。
  await bk.syncVarTable(pr.variables(), null);
});
await page.waitForTimeout(600);

// 变量表：把 rSpeed 的地址改成 %MD48，并把地址说明显示出来
await page.click('.lp-tab[data-panel="vars"]');
await page.waitForTimeout(250);
const addrHelp = await page.evaluate(() => {
  // 按变量名精确改地址（别按下标——变量顺序变了就会改错行）
  const set = (name, val) => {
    const inp = document.querySelector(`#varTable tr[data-name="${name}"] input[data-k="address"]`);
    inp.value = val;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return inp;
  };
  const rSpeed = set('rSpeed', '%MD48');
  const rSet = set('rSetSpeed', '%MD50');
  const bad = set('bAlarm', '%XX9');
  return { rSpeed: rSpeed.title, rSet: rSet.title, bad: bad.title, red: bad.style.color };
});
ok('变量表地址有「映射到什么寄存器」的说明',
  /%MW96\(低16位\)/.test(addrHelp.rSpeed.replace(/\s/g, '')) || /低16位/.test(addrHelp.rSpeed), addrHelp.rSpeed);
ok('第二个变量也能正确说明', /%MD50/.test(addrHelp.rSet), addrHelp.rSet);
ok('认不出的地址会标红提示', /⚠/.test(addrHelp.bad) && !!addrHelp.red, addrHelp.bad);

// 变量表：字长并进地址格（面板默认 300px，7 列时地址会被挤成一条缝）
const lenCol = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('#varTable thead th')].map(t => t.textContent.trim());
  const realRow = document.querySelector('#varTable tr[data-name="rSpeed"]');
  const addrInput = realRow?.querySelector('input[data-k="address"]');
  // 内部变量（没地址）那一格才显示灰字「N 字」；有地址的变量把它留给地址本身
  const internal = window.app.project.variables().find(v => !String(v.address || '').trim());
  const internalRow = internal ? document.querySelector(`#varTable tr[data-name="${CSS.escape(internal.name)}"]`) : null;
  return {
    heads, addrTitle: addrInput?.title || '',
    auto: internalRow?.querySelector('.vt-auto')?.textContent?.trim() || '',
  };
});
ok('变量表没有单独的「字长」列了（并进地址格：有地址看悬停提示，内部变量显示灰字）',
  !lenCol.heads.includes('字长') && /个字/.test(lenCol.addrTitle), JSON.stringify(lenCol));
const strLenFlow = await page.evaluate(async () => {
  // 把一个变量改成 string → 出现长度输入框
  const sel = document.querySelector('#varTable tr[data-name="rSetSpeed"] select[data-k="type"]');
  sel.value = 'string';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const inp = document.querySelector('#varTable tr[data-name="rSetSpeed"] input[data-k="len"]');
  const before = inp ? inp.value : null;
  if (inp) { inp.value = '20'; inp.dispatchEvent(new Event('change', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 200));
  const addrTitle = document.querySelector('#varTable tr[data-name="rSetSpeed"] input[data-k="address"]')?.title || '';
  const saved = window.app.project.variables().find(v => v.name === 'rSetSpeed');
  return { hasLen: !!inp, before, len: saved?.len, type: saved?.type, addrTitle };
});
ok('类型改成 string → 出现长度输入框，默认 10 字符', strLenFlow.hasLen && strLenFlow.before === '10', JSON.stringify(strLenFlow));
ok('长度改成 20 → 存进工程变量表，地址提示写明占几个字',
  strLenFlow.len === 20 && /20 个字符占 10 个字|10 个字/.test(strLenFlow.addrTitle), JSON.stringify(strLenFlow).slice(0, 200));

// 后端能力表正常时，对话框不该出现「旧版本」警告
await page.evaluate(async () => { const m = await import('/js/api/backend.js'); await m.backend.probe(); });
const noWarn = await page.evaluate(async () => {
  document.getElementById('btnPlc').click();
  await new Promise(r => setTimeout(r, 300));
  const txt = document.getElementById('dlgBox')?.textContent || '';
  return { stale: /后端是旧版本/.test(txt), hasOrderSel: !!document.getElementById('plcOrder') };
});
ok('后端是配套版本时对话框不误报「旧版本」', noWarn.hasOrderSel && !noWarn.stale, JSON.stringify(noWarn));
// 状态栏那颗灯也带版本判断（不打开 PLC 对话框就能看到）
const barOk = await page.evaluate(() => {
  const el = document.getElementById('stBackend');
  return { text: el.textContent, title: el.title, cls: el.className };
});
ok('状态栏显示「后端：在线」并带 build', /后端：在线/.test(barOk.text) && /build/.test(barOk.title), JSON.stringify(barOk));
const barStale = await page.evaluate(async () => {
  const m = await import('/js/api/backend.js');
  const keep = m.backend.features;
  m.backend.features = [];                     // 假装连的是旧后端
  m.backend.paintStatusBar();
  const el = document.getElementById('stBackend');
  const out = { text: el.textContent, title: el.title };
  m.backend.features = keep;
  m.backend.paintStatusBar();
  return out;
});
ok('后端是旧版本 → 状态栏直接显示「旧版本(需重启)」并说明原因',
  /旧版本/.test(barStale.text) && /start_server\.bat/.test(barStale.title), JSON.stringify(barStale));
// 模拟旧后端（能力表为空）→ 必须给出「忘了重启」的明确提示
const staleWarn = await page.evaluate(async () => {
  const m = await import('/js/api/backend.js');
  m.backend.features = [];                       // 假装连的是旧后端
  document.getElementById('dlgCancel')?.click();          // 先关掉上一个对话框（不然遮罩挡住后面点击）
  await new Promise(r => setTimeout(r, 250));
  document.getElementById('btnPlc').click();
  await new Promise(r => setTimeout(r, 300));
  const txt = document.getElementById('dlgBox')?.textContent || '';
  const shown = /后端是旧版本/.test(txt);
  m.backend.features = ['word_order4', 'words_by_type', 'string_range', 'orders_probe'];
  document.getElementById('dlgCancel')?.click();          // 关掉，后面重新打开
  await new Promise(r => setTimeout(r, 250));
  return { shown, sample: txt.replace(/\s+/g, ' ').slice(0, 90) };
});
ok('后端是旧版本（缺能力）时对话框红字提示「请重启服务」', staleWarn.shown, staleWarn.sample);

// 打开 PLC 对话框连接模拟 PLC
await page.click('#btnPlc');
await page.waitForTimeout(300);
ok('PLC 对话框打开', await page.evaluate(() => !document.getElementById('dlgMask').classList.contains('hidden')));
const orderOpts = await page.evaluate(() => [...document.querySelectorAll('#plcOrder option')].map(o => o.value));
ok('对话框里 4 种双字字序都能选（ABCD / CDAB / BADC / DCBA）',
  JSON.stringify(orderOpts) === JSON.stringify(['cdab', 'abcd', 'badc', 'dcba']), JSON.stringify(orderOpts));
const orderHint = await page.evaluate(() => document.querySelector('#plcOrder').closest('.f-row').nextElementSibling.textContent);
ok('对话框说明了「REAL 占 2 个寄存器、字长按类型算」',
  /2\s*个寄存器/.test(orderHint) && /类型/.test(orderHint), orderHint.replace(/\s+/g, ' ').slice(0, 80));
await page.fill('#plcIp', '127.0.0.1');
await page.fill('#plcPort', String(SIM_MB));
await page.fill('#plcUnit', '1');
await page.fill('#plcPoll', '200');
await page.selectOption('#plcOrder', 'cdab');
await page.click('#plcTest');
await page.waitForTimeout(900);
ok('对话框「测试连接」成功', /✔/.test(await page.textContent('#plcTestMsg')), await page.textContent('#plcTestMsg'));

// 字序体检按钮：只读地把同一个地址按 4 种字序各解一遍
// （地址用 3b 段写过 33.3 的 %MW124，别看 %MW120 —— 那是 bool 测试用的）
await page.fill('#plcOrderAddr', '%MW124');
await page.selectOption('#plcOrderType', 'real');
await page.click('#plcOrders');
await page.waitForTimeout(900);
const orderOut = await page.textContent('#plcOrderOut');
ok('对话框里能「按 4 种字序各读一次」并列出 4 行结果',
  ['ABCD', 'CDAB', 'BADC', 'DCBA'].every(o => orderOut.includes(o)) && /33\.3/.test(orderOut),
  orderOut.replace(/\s+/g, ' ').slice(0, 120));

// 模拟器控制台：整数/REAL 用勾选框选（不用下拉），且随时能勾（不先勾「自动」也行）
const simPage = await browser.newPage({ viewport: { width: 1100, height: 700 } });
await simPage.goto(`http://127.0.0.1:${SIM_WEB}/`, { waitUntil: 'networkidle' });
await simPage.waitForTimeout(600);
// 按**表头名字**取列号：控制台后来加过「位 %MX（可点）」列，写死 children[6] 会指到别的格子
await simPage.evaluate(() => {
  window.__mxCol = (name) => [...document.querySelectorAll('#tbl thead th')]
    .findIndex(th => th.textContent.trim() === name);
});
const autoCol = await simPage.evaluate(() => window.__mxCol('自动输出'));
ok('模拟器控制台：能按表头名找到「自动输出」列', autoCol >= 0, `列号=${autoCol}`);
// 每行「自动输出」那一格：读到两个勾选框（自动 / REAL）—— 有 <select> 就说明还是旧下拉
const boxesBefore = await simPage.evaluate(() => {
  const cell = document.querySelector('#tbl tbody tr').children[window.__mxCol('自动输出')];
  const boxes = [...cell.querySelectorAll('input[type=checkbox]')];
  return {
    selects: cell.querySelectorAll('select').length,
    labels: [...cell.querySelectorAll('label')].map(l => l.textContent.trim()),
    disabled: boxes.map(b => b.disabled),
    checked: boxes.map(b => b.checked),
  };
});
ok('模拟器控制台：整数/REAL 是勾选框不是下拉（那一格没有 <select>，两个勾选框=自动 / REAL）',
  boxesBefore.selects === 0 && JSON.stringify(boxesBefore.labels) === JSON.stringify(['自动', 'REAL']),
  JSON.stringify(boxesBefore));
ok('模拟器控制台：REAL 勾选框没勾「自动」时也能点（原本 disabled → 选不中一直是整数）',
  boxesBefore.disabled.every(d => d === false) && boxesBefore.checked.every(c => c === false),
  JSON.stringify(boxesBefore));
await simPage.evaluate(() => {
  const boxes = [...document.querySelector('#tbl tbody tr').children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  const real = boxes[1];
  real.checked = true;
  real.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(900);
const realAfter = await simPage.evaluate(() => {
  const row = document.querySelector('#tbl tbody tr');
  const boxes = [...row.children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  return { auto: boxes[0].checked, real: boxes[1].checked, note: row.lastElementChild.textContent.trim() };
});
const autoRow0 = (await simState()).auto['0'];
ok('勾 REAL 直接生效：该行自动跟着打开、说明写成 REAL 正弦（不用先勾「自动」）',
  realAfter.auto === true && realAfter.real === true && autoRow0?.type === 'real' && /REAL/.test(realAfter.note),
  JSON.stringify({ realAfter, autoRow0 }));
// 去掉 REAL 的勾 → 正在输出就切回单字整数正弦（不是整个关掉）
await simPage.evaluate(() => {
  const boxes = [...document.querySelector('#tbl tbody tr').children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  boxes[1].checked = false;
  boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(900);
const intAfter = await simPage.evaluate(() => {
  const row = document.querySelector('#tbl tbody tr');
  const boxes = [...row.children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  return { auto: boxes[0].checked, real: boxes[1].checked, note: row.lastElementChild.textContent.trim() };
});
const autoRow0b = (await simState()).auto['0'];
ok('去掉 REAL 的勾 → 还在输出、只是切成整数正弦（说明列不再写 REAL、也不写占两个字）',
  intAfter.auto === true && intAfter.real === false && autoRow0b?.type === 'int'
  && /整数/.test(intAfter.note) && !/REAL/.test(intAfter.note),
  JSON.stringify({ intAfter, autoRow0b }));
// 勾上 REAL → 关掉「自动」→ 再打开「自动」：类型要记着是 REAL，不能自己变回整数
await simPage.evaluate(() => {
  const boxes = [...document.querySelector('#tbl tbody tr').children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  boxes[1].checked = true; boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(700);
await simPage.evaluate(() => {
  const boxes = [...document.querySelector('#tbl tbody tr').children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  boxes[0].checked = false; boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(700);
const offState = await simState();
await simPage.evaluate(() => {
  const boxes = [...document.querySelector('#tbl tbody tr').children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  boxes[0].checked = true; boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(900);
const realAgain = (await simState()).auto['0'];
ok('勾过 REAL 再关/开「自动」→ 还是 REAL（勾选框不会因为刷新把选择丢掉）',
  offState.auto['0'] === undefined && realAgain?.type === 'real',
  JSON.stringify({ off: offState.auto['0'], again: realAgain }));
// 关掉，别影响后面的用例
await simPage.evaluate(() => {
  const boxes = [...document.querySelector('#tbl tbody tr').children[window.__mxCol('自动输出')].querySelectorAll('input[type=checkbox]')];
  boxes[0].checked = false; boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(500);

/* ── 刷新不许冲掉「正在改的值」（原来每 600ms 把整张表 innerHTML 重建：
      正在输入的数字、刚点的勾会被一起冲掉，值根本发不出去）── */
const W0 = '#tbl tbody tr[data-a="0"] input[data-k="w"]';
const W5 = '#tbl tbody tr[data-a="5"] input[data-k="w"]';
await simWrite({ kind: 'w', addr: 0, value: 111 });
await simWrite({ kind: 'w', addr: 5, value: 222 });
await sleep(700);
await simPage.click(W0);
await simPage.keyboard.press('Control+a');
await simPage.keyboard.type('1234');
await sleep(2000);                                   // 600ms 一刷 → 至少跨 3 轮
const typed = await simPage.evaluate(sel => {
  const i = document.querySelector(sel);
  return { value: i?.value, focused: document.activeElement === i, rows: document.querySelectorAll('#tbl tbody tr').length };
}, W0);
ok('正在输入的那一格：跨 3 轮刷新值还在、焦点还在（改得动、发得出去）',
  typed.value === '1234' && typed.focused === true, JSON.stringify(typed));
await simWrite({ kind: 'w', addr: 5, value: 4321 });
await sleep(900);
ok('只跳过正在输入的那一格，别的行照常刷新（不是把整张表冻住）',
  (await simPage.evaluate(sel => document.querySelector(sel)?.value, W5)) === '4321');
await simPage.keyboard.press('Enter');               // 回车 = 就地发送
await sleep(800);
ok('数字框里按回车就写进寄存器（不用先点到别处）', (await simState()).holding['0'] === 1234,
  `%MW0=${(await simState()).holding['0']}`);
const B0 = '#bits input[data-area="coils"][data-bit="0"]';
// 注意：线圈 0 可能已经被前面的用例（写 bRunCmd）置成 ON 了 —— 所以按「点一下应该翻面」来判，
// 不要写死「点完必须是 ON」，否则前面用过这块位就会误判。
const coilBefore = (await simState()).coils['0'] === true;
await simPage.click(B0);
await sleep(1500);
const coilAfter = (await simState()).coils['0'] === true;
ok('位区勾一下也不被刷新弹回去（页面上、模拟器里都跟着翻）',
  (await simPage.evaluate(sel => document.querySelector(sel)?.checked, B0)) === coilAfter
  && coilAfter !== coilBefore, `模拟器线圈 %QX0：${coilBefore} → ${coilAfter}`);
await simPage.click(B0);
await sleep(600);
await simPage.check('#pause');
await simWrite({ kind: 'w', addr: 7, value: 7777 });
await sleep(1500);
ok('「暂停刷新」勾上：整个画面定住（外面改了也不动）',
  (await simPage.evaluate(() => document.querySelector('#tbl tbody tr[data-a="7"] input[data-k="w"]')?.value)) !== '7777');
await simPage.uncheck('#pause');
await sleep(900);
ok('取消暂停 → 立刻追上真值', (await simPage.evaluate(() => document.querySelector('#tbl tbody tr[data-a="7"] input[data-k="w"]')?.value)) === '7777');

/* ── 「位 %MX」小格：点一下只翻转那一位（从站里先读回当前字、只改这一位、再整字写回）── */
await simWrite({ kind: 'w', addr: 4, value: 0x1234 });
await sleep(800);
const mxMap = await simPage.evaluate(() => [...document.querySelectorAll('#tbl tbody tr[data-a="4"] .mxb')]
  .map(el => el.getAttribute('title').split('　')[0].trim()));
ok('%MW 每一行 16 个 %MX 小格，地址按设计器那套算（%MW4 → %MX8.0~%MX9.7；%MX0.0~%MX1.7 = %MW0）',
  mxMap.length === 16 && mxMap[0] === '%MX8.0' && mxMap[8] === '%MX9.0' && mxMap[15] === '%MX9.7',
  JSON.stringify([mxMap[0], mxMap[8], mxMap[15]]));
ok('小格按当前字点亮（0x1234 → bit2/4/5/9/12）',
  (await simPage.evaluate(() => [...document.querySelectorAll('#tbl tbody tr[data-a="4"] .mxb')]
    .map((el, i) => (el.classList.contains('on') ? i : -1)).filter(i => i >= 0).join(','))) === '2,4,5,9,12');
await simPage.click('#tbl tbody tr[data-a="4"] .mxb[data-b="0"]');
await sleep(800);
const w4a = (await simState()).holding['4'];
ok('点第 0 位 → %MW4 = 0x1235（只置这一位，同字其他 15 位原样）', w4a === 0x1235, `0x${w4a.toString(16)}`);
await simPage.click('#tbl tbody tr[data-a="4"] .mxb[data-b="15"]');
await sleep(800);
const w4b = (await simState()).holding['4'];
ok('点第 15 位（高字节最高位）→ 0x9235', w4b === 0x9235, `0x${w4b.toString(16)}`);
const mxLog = (await simState()).log.join('\n');
ok('通讯日志写明「%MX9.7 = ON（%MW4: 0x1235 → 0x9235，只改这一位）」',
  /%MX9\.7 = ON（%MW4: 0x1235 → 0x9235，只改这一位）/.test(mxLog),
  (mxLog.split('\n').filter(l => /%MX9\.7/.test(l)).join(' ') || '(没找到)'));

await simWrite({ kind: 'w', addr: 0, value: 0 });
await simWrite({ kind: 'w', addr: 4, value: 0 });
await simWrite({ kind: 'w', addr: 5, value: 0 });
await simWrite({ kind: 'w', addr: 7, value: 0 });

/* ── 从站通讯开关：关掉 = 停监听 + 断开所有连接（主站那边就是掉线）；数据区照旧能改 ── */
const canConnect = () => new Promise(res => {
  const s = net.connect(SIM_MB, '127.0.0.1');
  const done = v => { s.destroy(); res(v); };
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
  s.setTimeout(1500, () => done(false));
});
/** 极简 FC03 读一个字（只用来验「恢复后真能通讯」，不算完整客户端） */
const mbReadOne = addr => new Promise((res, rej) => {
  const s = net.connect(SIM_MB, '127.0.0.1');
  s.setTimeout(2500, () => { s.destroy(); rej(new Error('超时')); });
  s.on('error', rej);
  s.on('connect', () => {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(3, 0); pdu.writeUInt16BE(addr, 1); pdu.writeUInt16BE(1, 3);
    const head = Buffer.alloc(7);
    head.writeUInt16BE(1, 0); head.writeUInt16BE(0, 2); head.writeUInt16BE(pdu.length + 1, 4); head.writeUInt8(1, 6);
    s.write(Buffer.concat([head, pdu]));
  });
  let buf = Buffer.alloc(0);
  s.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= 11) { s.destroy(); res(buf.readUInt16BE(9)); }
  });
});
let liveClosed = false;
const liveConn = net.connect(SIM_MB, '127.0.0.1');
liveConn.on('close', () => { liveClosed = true; });
await sleep(500);
const swOn = (await simState()).slave;
ok('从站开着：state 报 on + 端口 + 连接数（挂着 1 条长连接）',
  swOn.on === true && swOn.port === SIM_MB && swOn.conns >= 1, JSON.stringify(swOn));
await simPage.uncheck('#slaveOn');
await sleep(1000);
const swOff = (await simState()).slave;
ok('关掉「从站通讯」→ 停监听 + 现有连接全断开（新连接也连不上）',
  swOff.on === false && swOff.conns === 0 && liveClosed === true && (await canConnect()) === false,
  JSON.stringify({ swOff, liveClosed }));
ok('界面：徽标变「已停止（不通讯）」+ 顶上红条说清「数据区照旧能改」',
  await simPage.evaluate(() => {
    const b = document.getElementById('slaveOff');
    return /已停止/.test(document.getElementById('mode').textContent)
      && b.classList.contains('hidden') === false && /数据区照旧能改/.test(b.textContent);
  }));
await simWrite({ kind: 'w', addr: 6, value: 1234 });
await sleep(500);
ok('关着的时候数据区照旧能改（%MW6 = 1234 落进去，等着恢复通讯后给主站读）',
  (await simState()).holding['6'] === 1234);
await simPage.check('#slaveOn');
await sleep(1200);
const swBack = (await simState()).slave;
ok('再勾上 → 重新监听原端口', swBack.on === true && swBack.port === SIM_MB, JSON.stringify(swBack));
ok('恢复后 FC03 真能读到关着时改进去的值（%MW6 = 1234）', (await mbReadOne(6)) === 1234);
const swLog = (await simState()).log.join('\n');
ok('通讯日志记下开关动作（含断开几个连接）',
  /从站已关闭：停止监听 :\d+，断开 1 个连接/.test(swLog) && /从站已开启：监听 :\d+/.test(swLog),
  (swLog.split('\n').filter(x => /从站已/.test(x)).slice(-1)[0] || '(没有)'));
liveConn.destroy();
await simWrite({ kind: 'w', addr: 6, value: 0 });
await simPage.close();

await page.click('#dlgOk');
// 「在线」是后端第一轮轮询成功后才置上的，连接返回 ≠ 立刻在线：等它，而不是死等固定时间
let stText = '';
for (let i = 0; i < 25; i++) {
  stText = await page.textContent('#stPlc');
  if (/在线/.test(stText)) break;
  await sleep(200);
}
ok('状态栏显示 PLC 在线', /在线/.test(stText), stText);
ok('状态栏带出当前字序（现场一眼能对）', /字序\s*CDAB/.test(stText), stText);

/* ── 模拟器这边要能看出「设备在读什么」：读走了哪些 %MW/%QX（对着变量表核漏读）── */
let rdSum = {};
for (let i = 0; i < 20; i++) {
  rdSum = (await simState()).reads?.total || {};
  if ((rdSum.holding?.n || 0) > 0) break;
  await sleep(200);
}
const rdAddrs = (rdSum.holding?.ranges || []).flatMap(([s, e]) => Array.from({ length: e - s + 1 }, (_, i) => s + i));
ok('模拟器显示后端真的在读这些 %MW（变量表里的 %MW96/97、%MW100/101、%MW104 都在读地址里）',
  [96, 97, 100, 101, 104].every(a => rdAddrs.includes(a)), JSON.stringify(rdSum.holding));
ok('模拟器显示读走的 %QX 位（bRunCmd 落在 %QX0）', (rdSum.coils?.n || 0) >= 1, JSON.stringify(rdSum.coils));
// 输入寄存器区只读**变量表里声明的那几个**（%IW5 / %IB200→%IW100 / %ID60→%IW120,121），
// 不会顺带把整片输入区读一遍 —— 这条同时说明「区域不含糊」：读 %MW 时不会去碰 %IW。
const iwRanges = rdSum.input_reg?.ranges || [];
const iwAddrs = iwRanges.flatMap(([s, e]) => Array.from({ length: e - s + 1 }, (_, i) => s + i)).sort((a, b) => a - b);
ok('输入寄存器只读声明过的那几个（%IW5、%IW100、%IW120~121），别的一个不读',
  JSON.stringify(iwAddrs) === JSON.stringify([5, 100, 120, 121]), JSON.stringify(rdSum.input_reg));

// 模拟 PLC 改值 → 界面读到的值跟着变（rSpeed 已在上一步绑到 %MD48）
await simWrite({ kind: 'dw', addr: 96, value: 0 });          // 先清零，避免读到旧值
await sleep(300);
await page.evaluate(() => {                                   // 用整数位型写一个 REAL 12.5
  const b = new ArrayBuffer(4), dv = new DataView(b);
  dv.setFloat32(0, 12.5);
});
await fetch(`http://127.0.0.1:${SIM_WEB}/api/write`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'w', addr: 96, value: 0x0000 }),
});
await fetch(`http://127.0.0.1:${SIM_WEB}/api/write`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'w', addr: 97, value: 0x4148 }),   // 12.5f 的高字
});
await sleep(900);
// 后端读回来的值（设备 → 后端）：这是"PLC 改值能不能读到"的正题
const devRead = (await api('/api/vars')).vars?.rSpeed;
ok('模拟 PLC 写 %MD48=12.5 → 后端读回 12.5', Math.abs(devRead - 12.5) < 1e-6, String(devRead));
// 界面上的值：**编辑器没有 SSE**（只有进运行态才订阅推送），所以要显式读一次才会变 ——
// 这一步顺便验"读到的数据能进界面、变量值先变"（运行态那条路是持续推送的，见 verify-link-gate）
const shown = await page.evaluate(async () => {
  const bk = (await import('/js/api/backend.js')).backend;
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.applyRemote(await bk.readVars());
  return vs.get('rSpeed');
});
const why12 = Math.abs(shown - 12.5) < 1e-6 ? '' : JSON.stringify({
  word_order: (await api('/api/plc')).status.word_order,
  addr: (await api('/api/vars')).meta?.rSpeed?.address,
  backendVal: devRead,
  sim: ((await simState()).holding?.['96']) + '/' + ((await simState()).holding?.['97']),
});
ok('读一次 → 界面变量也变成 12.5', Math.abs(shown - 12.5) < 1e-6, String(shown) + (why12 ? ' ' + why12 : ''));

// 界面写值 → 模拟 PLC 收到（写的是 rSpeed → %MD48）
await page.evaluate(() => window.app.varStore.set('rSpeed', 45.75, 'local'));
// 下发是异步的（浏览器 fetch → 后端 → Modbus 写 → 从站生效），固定 sleep 后单点采样会偶发误判，
// 改成轮询到位；真丢写会一直读不到，仍然会失败。
let f = null, tries = 0;
for (; tries < 15; tries++) {
  f = mw48Float(await simState());
  if (typeof f === 'number' && Math.abs(f - 45.75) < 1e-4) break;
  await sleep(150);
}
ok('界面写 rSpeed=45.75 → 模拟 PLC %MD48 读到 45.75', typeof f === 'number' && Math.abs(f - 45.75) < 1e-4,
  `值=${f}，采样 ${tries + 1} 次`);
// 状态栏是「下发请求回来」才更新的，模拟器那边先变、浏览器后收到，
// 固定等一下（轮询到 ok 为止），不然会偶发读到还没刷新的状态
let okBadge = { text: '', cls: '' };
for (let i = 0; i < 20; i++) {
  okBadge = await page.evaluate(() => {
    const el = document.getElementById('stWrite');
    return { text: el.textContent, cls: el.className };
  });
  if (okBadge.cls.includes('ok')) break;
  await sleep(150);
}
ok('写成功后状态栏显示「下发正常」', /下发正常/.test(okBadge.text) && okBadge.cls.includes('ok'),
  JSON.stringify(okBadge));

/* ══════ 4c. 改地址要立刻生效 + 写失败必须看得见（往只读的 %IW 写）══════ */
// 以前地址映射只在「进运行态/连 PLC」时下发：连着 PLC 改地址等于没改。
// 现在变量表一变就重发映射，而且写变量会等映射落地 —— 这里改完直接写，必须走新地址。
await page.evaluate(() => {
  const inp = document.querySelector('#varTable tr[data-name="rSetSpeed"] input[data-k="address"]');
  if (inp) { inp.value = '%IW5'; inp.dispatchEvent(new Event('change', { bubbles: true })); }
});
let mapped = '';
for (let i = 0; i < 20; i++) {                       // 等后端确认拿到新映射（而不是靠固定 sleep）
  mapped = (await api('/api/vars')).meta?.rSetSpeed?.address || '';
  if (mapped === '%IW5') break;
  await sleep(150);
}
ok('改完地址后端立刻拿到新映射（不用重连）', mapped === '%IW5', `后端里 rSetSpeed 的地址 = ${mapped || '(空)'}`);

const iwSet = await page.evaluate(async () => {
  window.app.varStore.set('rSetSpeed', 999, 'local');
  await new Promise(r => setTimeout(r, 900));
  const el = document.getElementById('stWrite');
  return { text: el.textContent, cls: el.className, title: el.title };
});
const srvVals = await api('/api/vars');
ok('往只读的 %IW5 写 → 状态栏红字「下发失败」并给出原因',
  /下发失败/.test(iwSet.text) && iwSet.cls.includes('bad') && /只读/.test(iwSet.title),
  `${iwSet.text} | ${(iwSet.title || '').split('\n')[0]}`);
ok('失败的写没有落到后端（值没被改写）',
  Number(srvVals.vars?.rSetSpeed) !== 999, `后端 rSetSpeed=${srvVals.vars?.rSetSpeed}`);

/* ══════ 4d. 模拟 PLC 一帧多寄存器/多线圈写必须整体生效（不能读到半帧）══════ */
// 用「一帧只进一次临界区」这条确定性不变量来测：以前是逐个 set_w，
// 100 个寄存器就进 100 次锁，读线程能读到「前几个是新值、后面还是旧值」的半帧。
const atom = execFileSync('python', ['-c', `
import sys, struct, threading
sys.path.insert(0, r'${ROOT.replace(/\\/g, '\\\\')}\\server')
import plc_sim as ps

class CountLock:
    def __init__(self, inner): self.inner, self.n = inner, 0
    def __enter__(self): self.n += 1; return self.inner.__enter__()
    def __exit__(self, *a): return self.inner.__exit__(*a)
    def acquire(self, *a, **k): self.n += 1; return self.inner.acquire(*a, **k)
    def release(self): return self.inner.release()

def frames_for(probe):
    lock = CountLock(ps.STORE.lock); ps.STORE.lock = lock
    try:
        probe()
        return lock.n
    finally:
        ps.STORE.lock = lock.inner

def fc16():
    data = struct.pack('>HHB', 300, 100, 200) + struct.pack('>100H', *([0x1111] * 100))
    r = ps.ModbusSlaveHandler._dispatch(None, 0x10, data)
    assert r[0] == 0x10, r
fc15_data = struct.pack('>HHB', 0, 100, 13) + bytes([0xFF] * 13)
def fc15():
    r = ps.ModbusSlaveHandler._dispatch(None, 0x0F, fc15_data)
    assert r[0] == 0x0F, r

n16 = frames_for(fc16)
bad_w = [i for i in range(100) if ps.STORE.get_w(300 + i) != 0x1111]
n15 = frames_for(fc15)
bad_b = [i for i in range(100) if not ps.STORE.get_bit(ps.COIL, i)]
print(n16, len(bad_w), n15, len(bad_b))
`], { encoding: 'utf-8' }).trim().split(/\s+/);
ok('模拟 PLC：FC16 一帧 100 个寄存器只进一次临界区（整帧生效，不会读到半帧）',
  Number(atom[0]) <= 3 && atom[1] === '0', `进锁 ${atom[0]} 次 / 值不对的寄存器 ${atom[1]} 个`);
ok('模拟 PLC：FC15 一帧 100 个线圈同样整体生效',
  Number(atom[2]) <= 3 && atom[3] === '0', `进锁 ${atom[2]} 次 / 值不对的线圈 ${atom[3]} 个`);

/* 脚本临时量（变量表里**没有**的名字，如 `_lenAcc`）：只活在 HMI 本地 ——
   一个 /api/vars 请求都不发，也就不会弹「下发失败：变量 _lenAcc 未在变量表声明」。
   现场报过：一进运行态就看见那条橙条，以为哪里配错了，其实只是个临时累加器。 */
const tmpVar = await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  const { bus } = await import('/js/core/eventBus.js');
  const writes = [], fails = [];
  const realFetch = window.fetch;
  window.fetch = (u, o) => {
    if (String(u).includes('/api/vars') && o?.method === 'POST') writes.push(o.body);
    return realFetch(u, o);
  };
  const onW = e => { if (!e.ok) fails.push(e.name); };
  bus.on('vars:write', onW);
  varStore.set('_tmpScriptVar', 3.5, 'local');            // 表里没有这个名字
  await new Promise(r => setTimeout(r, 600));
  window.fetch = realFetch;
  bus.off?.('vars:write', onW);
  return { value: varStore.get('_tmpScriptVar'), writes, fails };
});
ok('★ 脚本临时量（表里没有的名字）写值：一个 /api/vars 请求都不发',
  !tmpVar.writes.some(w => /_tmpScriptVar/.test(w)), JSON.stringify(tmpVar.writes.map(w => JSON.parse(w).name)));
ok('★ 脚本临时量的值留在本地、也没有「下发失败」事件（橙条不会弹）',
  tmpVar.value === 3.5 && tmpVar.fails.length === 0, JSON.stringify(tmpVar));

/* 脚本写值 vs 人写值：脚本那条路要带 `from:script`，
   后端据此**不往 cmd 打 `[var] …` 操作日志**（脚本可能每 100ms 写一次，会把控制台刷爆）。
   控制台只留人在触摸屏上的操作（按钮/输入框/变量监控里手改）。

   ⚠ 断言的是**发出去的内容**，不是"走哪条路"：
   前端现在首选 WebSocket 长连接，写值走那条连接上的帧（不再有 POST /api/vars）；
   只有退回模式（旧后端 / 长连接没连上）才是 HTTP POST。所以两条传输都要抓，
   只抓 fetch 的话在长连接模式下会一条都抓不到（那是测法过时了，不是功能坏了）。
   真正要保证的行为在后端：脚本写 → 不打 `[var]`；人写 → 打。 */
const wSrc = await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  const { backend } = await import('/js/api/backend.js');
  const { project } = await import('/js/core/project.js');
  project.data.variables.length = 0;
  project.data.variables.push({ name: 'wSrcVar', type: 'int', address: '%MW300' });
  const seen = [];
  const realFetch = window.fetch;
  window.fetch = (u, o) => {
    if (String(u).includes('/api/vars') && o?.method === 'POST') seen.push(String(o.body));
    return realFetch(u, o);
  };
  // 长连接这条路：把发出去的帧也记下来（帧本身就是 JSON，和 POST 的 body 同一个形状）
  const ch = backend._channel;
  const realSend = ch ? ch.send.bind(ch) : null;
  if (ch) ch.send = (obj) => { if (obj && obj.t === 'write') seen.push(JSON.stringify(obj)); return realSend(obj); };
  varStore.set('wSrcVar', 7, 'local', 'script');   // 脚本那条路（hmi.set / hmi.v.x = …）
  await new Promise(r => setTimeout(r, 300));
  varStore.set('wSrcVar', 8, 'local');             // 人操作那条路（按钮/输入框/监控里手改）
  await new Promise(r => setTimeout(r, 300));
  window.fetch = realFetch;
  if (ch) ch.send = realSend;
  return seen;
});
ok('★ 脚本写值带 from:script（后端不打 [var] 操作日志）',
  wSrc.some(b => /"from":"script"/.test(b) && /wSrcVar/.test(b)), JSON.stringify(wSrc));
ok('★ 人写值不带 from（屏上操作照旧进控制台记录）',
  wSrc.some(b => /wSrcVar/.test(b) && !/from/.test(b)), JSON.stringify(wSrc));

/* 写变量的**连接复用**（后端 protocol_version = HTTP/1.1）。
   为什么这条要钉死：运行态写变量是每秒十几发的（脚本定时写 / 点动 / 报警落盘），
   后端原来是 http.server 默认的 HTTP/1.0 —— 一问一答就把连接关掉，于是每个写请求
   = 新建一个 TCP + 后端新起一个线程 + 一个 TIME_WAIT。实测改之前连续写 300 次
   = 345 个 TIME_WAIT；现场跑一晚上就是几十万次连接的生死，两边的内存都被拖爆。
   判据用后端自己的计数（/api/health 的 conns / reqs）：50 次写，请求数要 +50，
   连接数最多 +2（正常情况下全程复用同一条连接）。 */
const reuseBefore = await api('/api/health');
await page.evaluate(async () => {
  for (let i = 0; i < 50; i++) {
    await fetch('/api/vars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wReuseVar', value: i, internal: true }),
    });
  }
});
const reuseAfter = await api('/api/health');
const dReq = reuseAfter.reqs - reuseBefore.reqs;
const dConn = reuseAfter.conns - reuseBefore.conns;
ok('★ 写变量复用同一条连接（后端开了 keep-alive：50 次写不许开 50 条连接）',
  dReq >= 50 && dConn <= 2, JSON.stringify({ 请求增: dReq, 连接增: dConn }));

ok('界面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

/* ══════ 4.5 内部变量（地址留空）：写它必须成功，而且**一个字节都不发 PLC** ══════
   现场报过：接上 PLC 之后写内部变量弹「下发失败：变量 xxx 的地址 '' 无效：未填写」——
   那是老后端把"地址留空"当成"地址没填好的 PLC 变量"。这里把这条钉死。 */
const innerBefore = (await api('/api/plc')).status.writes;
await post('/api/vars/declare', {
  variables: [
    { name: 'n内部计数', type: 'int', address: '', value: 0, len: 0 },     // 内部变量（地址留空）
    { name: 'rPLC值', type: 'real', address: '%MW300', value: 0, len: 0 }, // PLC 变量（对照）
  ],
});
await sleep(200);
const wInner = await post('/api/vars', { name: 'n内部计数', value: 42 });
const afterInner = (await api('/api/plc')).status.writes;
const rdInner = (await api('/api/vars')).vars;
ok('★ 写**内部变量**（地址留空）成功，不再报「地址无效：未填写」',
  wInner.ok === true && rdInner['n内部计数'] === 42, JSON.stringify([wInner, rdInner['n内部计数']]));
ok('★ 而且**没往 PLC 发**：PLC 写次数一次没涨（内部变量只存在后端）',
  afterInner === innerBefore, `PLC writes ${innerBefore} → ${afterInner}`);
await post('/api/vars', { name: 'rPLC值', value: 12.5 });
await sleep(200);
const afterPlc = (await api('/api/plc')).status.writes;
ok('对照：写 **PLC 变量**照样真的下发了（写次数 +1）', afterPlc > afterInner, `PLC writes ${afterInner} → ${afterPlc}`);

/* 后端这张表里**没有**这个内部变量时（变量刚新建还没下发 / 这份后端上挂着别的工程）：
   前端会带 internal:true —— 必须照收，不能回一句「未在变量表声明」；
   而**不带 internal 的未知名字**仍然要挡住（脚本临时量、打错字不许发给 PLC）。 */
await post('/api/vars/declare', { variables: [{ name: 'rPLC值', type: 'real', address: '%MW300', value: 0, len: 0 }] });
await sleep(200);
const wGhost = await post('/api/vars', { name: 'var48', value: 5.0013, internal: true });
const rdGhost = (await api('/api/vars')).vars;
ok('★ 内部变量不在后端表里也照收（前端带 internal:true，不再报「未在变量表声明」）',
  wGhost.ok === true && Math.abs((rdGhost.var48 ?? 0) - 5.0013) < 1e-6, JSON.stringify([wGhost, rdGhost.var48]));
const wTypo = await post('/api/vars', { name: '这个变量不存在', value: 1 });
ok('★ 不带 internal 的未知名字仍然挡住：脚本临时量/打错字不许发给 PLC',
  wTypo.ok === false && /未在变量表声明/.test(wTypo.error || ''), JSON.stringify(wTypo.error || wTypo));

/* ══════ 5. 断开 → 回到内存模拟 ══════
   用**对话框里那个按钮**断（不是直接打接口）：现场反馈的是"点了断开、再点确定，
   它又给我连回去了，看着像断开没生效" —— 所以按钮点下去要**当场把对话框收掉**，
   「确定」（=按上面的参数去连）不能再被点到。 */
await page.click('#btnPlc');
await page.waitForTimeout(300);
ok('（前提）重新打开 PLC 对话框', await page.evaluate(() => !document.getElementById('dlgMask').classList.contains('hidden')));
const alertsBefore = dlgAlerts.length;
await page.click('#plcDisc');
await page.waitForTimeout(800);
const discState = await page.evaluate(async () => {
  const b = await (await import('/js/api/backend.js')).backend.getPlc();
  return { dlgOpen: !document.getElementById('dlgMask').classList.contains('hidden'), mode: b?.status?.mode,
    note: document.getElementById('stNote')?.textContent || '' };
});
ok('点「断开（回到内存模拟）」→ 对话框**当场收掉**（不会让人再点到「确定」）', discState.dlgOpen === false, JSON.stringify(discState));
ok('断开真的生效：数据源回到内存模拟', discState.mode === 'memory', String(discState.mode));
ok('断开给了一句反馈（走状态栏，不弹 alert 打断）',
  dlgAlerts.length === alertsBefore && /已断开/.test(discState.note),
  JSON.stringify({ alerts: dlgAlerts.length - alertsBefore, note: discState.note }));

await post('/api/plc', { action: 'disconnect' });
await sleep(300);
const stBack = (await api('/api/plc')).status;
ok('断开后回到内存模拟数据源', stBack.mode === 'memory', stBack.mode);

await browser.close();
sim.kill();
await sleep(200);
const failed = results.filter(r => !r.ok);
console.log(`\n==== PLC 对接回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
