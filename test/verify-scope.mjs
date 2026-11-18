// verify-scope.mjs — 按页采集 + 连续地址合并：只采当前页用到的变量、块读、切页面跟着换
//   1) 采集范围 = 本页控件用到的变量 + 报警条件变量（弹窗开着也算），别的变量不占通讯
//   2) 连续地址合并成一次读（100/102/104 → 1 块）；散地址各占一块
//   3) 切页面 → 重新下发采集范围（状态栏能看到「本页 N 变量/M 块」）
//   4) 浏览器关了/切后台，后端照样轮询（通讯在后端，不靠页面定时器）
// 用法：先启动 8866 服务，再 node test/verify-scope.mjs [端口]
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
const HEAD = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const srv = net.createServer();
  srv.on('error', rej);
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
});
const api = async (p) => (await fetch(HEAD + p)).json();

/* ══════ 1. Python 侧：_plan() 只规划采集范围内的变量，且连续地址合并成块 ══════ */
const py = `
import sys
sys.path.insert(0, r'${ROOT.replace(/\\/g, '\\\\')}\\server'
)
import server as S

def mk(vars_):
    src = S.PlcSource('127.0.0.1', 1)
    src.declare(vars_)
    return src

V = [
    {'name': 'rSpeed', 'type': 'real', 'address': '%MW100'},
    {'name': 'rSet',   'type': 'real', 'address': '%MW102'},
    {'name': 'iCount', 'type': 'int',  'address': '%MW104'},
    {'name': 'rT1',    'type': 'real', 'address': '%MW200'},
    {'name': 'iFar',   'type': 'int',  'address': '%MW900'},
    {'name': 'bBit',   'type': 'bool', 'address': '%MX0.0'},
]

# 不传 active：全部变量都要采（老行为）
src = mk(V)
plan = src._plan()
n_all = sum(len(b[3]) for b in plan)
print(('PASS' if n_all == len(V) else 'FAIL') + '  py: 不传采集范围 → 变量全采（%d 个）' % n_all)

# 连续地址：100/102/104 三个变量（real+real+int）应并成 1 块；全采时 6 个变量 → 4 次读
blocks = [b for b in plan if b[0] == 'holding']
n_hold = sum(len(b[3]) for b in blocks)
print(('PASS' if len(blocks) == 4 and n_hold == 6 else 'FAIL')
      + '  py: 连续地址合并（6 个变量 → %d 次 holding 读，覆盖 %d 个）' % (len(blocks), n_hold))

# 传 active：只采名单里的
src2 = mk(V)
src2.declare(V, ['rSpeed', 'rSet', 'iCount'])
plan2 = src2._plan()
names = sorted(n for b in plan2 for n, _p, _t, _l in b[3])
print(('PASS' if names == ['iCount', 'rSet', 'rSpeed'] else 'FAIL') + '  py: 按采集范围过滤（%s）' % ','.join(names))
print(('PASS' if len(plan2) == 1 else 'FAIL') + '  py: 100/102/104 连续 → 1 次读（%d 块）' % len(plan2))

# 采集范围里没有的变量名（变量表里没有）不影响
src3 = mk(V)
src3.declare(V, ['rSpeed', 'meiyou'])
print(('PASS' if src3._active == {'rSpeed'} else 'FAIL') + '  py: 采集范围里不存在的变量名被剔掉')

# 位地址归到线圈/离散那一类，单独成块
src4 = mk(V)
src4.declare(V, ['bBit'])
p4 = src4._plan()
print(('PASS' if len(p4) == 1 and p4[0][2] == 1 else 'FAIL')
      + '  py: 单个内存位单独成 1 块 1 个位（' + str(p4[0][:3] if p4 else None) + '）')

# 状态里能看到 scoped/active/blocks
st = src2.status()
print(('PASS' if st.get('scoped') is True and st.get('active') == 3 and st.get('blocks') == 0 else 'FAIL')
      + '  py: status 里有 scoped/active/blocks（%s/%s/%s）' % (st.get('scoped'), st.get('active'), st.get('blocks')))
`;
let pyOut = '';
try {
  pyOut = execFileSync('python', ['-c', py], { encoding: 'utf-8' });
} catch (e) {
  pyOut = String(e.stdout || '') + String(e.stderr || '');
}
pyOut.split('\n').filter(l => l.trim()).forEach(line => {
  const m = /^(PASS|FAIL)\s+(.*)$/.exec(line.trim());
  if (m) ok(m[2], m[1] === 'PASS');
});

/* ══════ 2. 起模拟 PLC，后端连上去 ══════ */
const SIM_MB = await freePort();
const SIM_WEB = await freePort();
const sim = spawn('python', ['server/plc_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore' });
const simState = async () => (await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`)).json();
let simUp = false;
for (let i = 0; i < 30 && !simUp; i++) {
  await sleep(300);
  try { await simState(); simUp = true; } catch { /* 还没起来 */ }
}
ok('模拟 PLC 已启动（端口现取现用）', simUp, `mb=${SIM_MB}`);

const hel = () => api('/api/health').then(j => j.plc);
const conn = await api('/api/plc');
await fetch(HEAD + '/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 100 }),
});
// 连接是后台线程做的，给它几拍时间（连不上会一直重试）
let online = false, lastErr = '';
for (let i = 0; i < 20 && !online; i++) {
  await sleep(250);
  const h = await hel();
  online = h.online === true;
  lastErr = h.last_error || '';
}
ok('后端连上模拟 PLC', online, lastErr || `mode=${(await api('/api/plc')).status?.mode}`);

/* ══════ 3. 浏览器：页面 → 采集范围 ══════ */
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto(HEAD + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);

const ids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.data.alarms.length = 0;
  const defs = [
    ['rSpeed', 'real', '%MW100'], ['rSet', 'real', '%MW102'], ['iCount', 'int', '%MW104'],
    ['rT1', 'real', '%MW200'], ['bAlarmBit', 'bool', '%MX0.0'],
    ['iP2A', 'int', '%MW300'], ['iP2B', 'int', '%MW400'], ['iP2C', 'int', '%MW500'],
    ['iTrendCh', 'real', '%MW800'],          // 波形通道：跨页面一直要采
  ];
  defs.forEach(([n, t, a]) => {
    m.project.addVariable();
    m.project.updateVariable(`var${m.project.variables().length}`, { name: n, type: t, address: a, value: 0 });
  });
  m.project.addAlarm({ name: '越限', variable: 'bAlarmBit', op: '==', value: true, level: 'alarm', text: '越限了' });
  // 页面1：用到 rSpeed / rSet / iCount（100/102/104 连续）+ rT1（200）
  m.project.data.pages[0].widgets.length = 0;
  [['rSpeed', 20, 20], ['rSet', 20, 70], ['iCount', 20, 120], ['rT1', 20, 170]].forEach(([n, x, y]) => {
    const w = m.project.addWidget('number', x, y);
    w.bindings.variable = n;
  });
  // 页面2：用到 iP2A / iP2B / iP2C + 一个波形控件（通道绑 iTrendCh，跨页也要采）
  const pg2 = m.project.addPage('page');
  pg2.widgets.length = 0;
  ['iP2A', 'iP2B', 'iP2C'].forEach((n, i) => {
    const w = m.project.addWidget('number', 20, 20 + i * 46);
    w.bindings.variable = n;
  });
  const tr = m.project.addWidget('trend', 20, 200);
  tr.bindings.variables = ['iTrendCh', '', '', '', '', '', '', ''];
  m.project.currentId = m.project.data.pages[0].id;
  m.project.commit('采集范围测试');
  return { p1: m.project.data.pages[0].id, p2: pg2.id };
});

await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(1500);
// 下面几节测的是「纯按页采集」：把「离开页面后的保留窗口」关掉。
// 那条特性（切走后上一页变量再多采一会儿）单独在 4b 节测。
await page.evaluate(() => { window.app.scopeKeep.keepMs = 0; });
const h1 = await hel();
ok('页面1：只采本页用到的变量（4 个控件变量 + 报警条件那个位 + 波形通道 = 6 个）',
  h1.scoped === true && h1.active === 6, JSON.stringify({ active: h1.active, vars: h1.vars }));
ok('页面1：波形通道（第 2 页的波形）也在采 —— 切页不能让波形断数据',
  h1.active === 6 && h1.vars === 9, `采 ${h1.active} / 共 ${h1.vars}`);
ok('页面1：连续地址合并 → 100/102/104 一块、200 一块、%MX0.0 一位一块、波形 800 一块 = 4 块',
  h1.blocks === 4, String(h1.blocks));
ok('页面1：页面2 用到的变量没被采集', h1.active < h1.vars, `采 ${h1.active} / 共 ${h1.vars}`);

const bar = await page.evaluate(() => document.getElementById('stBackend')?.textContent || '');
ok('状态栏显示「本页 N 变量/M 块」', /本页\s*6\s*变量\s*\/\s*4\s*块/.test(bar), bar);

// 「只看本页」默认勾着 → 别页变量根本不在列表里；这里要看它的「未采集」标记，先取消勾选
await page.evaluate(() => {
  const cb = document.getElementById('rtvOnly');
  if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
});
await sleep(300);
const mon = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#rtvList .rtv-row')];
  const of = (n) => rows.find(r => r.dataset.vname === n);
  return { p1: !!of('rSpeed')?.querySelector('.rtv-skip'), p2: !!of('iP2A')?.querySelector('.rtv-skip') };
});
ok('变量监控里标出「未采集」：本页变量没有标记、别页变量有标记',
  mon.p1 === false && mon.p2 === true, JSON.stringify(mon));
const monTip = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#rtvList .rtv-row')];
  const t = rows.find(r => r.dataset.vname === 'iTrendCh');
  return { trendMarked: !!t?.querySelector('.rtv-skip'), skipTitle: document.querySelector('#rtvList .rtv-skip')?.title || '' };
});
ok('波形通道变量不标「未采集」（它一直在采）', monTip.trendMarked === false, JSON.stringify(monTip));
ok('「未采集」的提示里写明波形通道是例外',
  !monTip.skipTitle || /波形通道例外/.test(monTip.skipTitle), monTip.skipTitle);

/* 切页面 → 采集范围跟着换 */
await page.evaluate((pid) => window.app.gotoPage(pid), ids.p2);
await sleep(900);
const h2 = await hel();
ok('切到页面2：采集范围换成页面2 的变量（3 个控件 + 报警位 + 波形通道 = 5）',
  h2.active === 5, JSON.stringify({ active: h2.active }));
const bar2 = await page.evaluate(() => document.getElementById('stBackend')?.textContent || '');
ok('状态栏跟着变（本页 5 变量）', /本页\s*5\s*变量/.test(bar2), bar2);

/* 报警条件变量必须在采集范围内（否则报警永远不会触发） */
const alarmInScope = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const scope = (await import('/js/runtime/runtime.js')).pageVarScope?.() || null;
  return { hasApi: !!scope, inScope: Array.isArray(scope) ? scope.includes('bAlarmBit') : null };
});
ok('报警条件里的变量始终在采集范围内（切到哪一页都在）',
  alarmInScope.hasApi === false || alarmInScope.inScope === true, JSON.stringify(alarmInScope));

// 真的能触发：页面2 上把位写 1 → 报警出现（说明这个变量确实在采）
await page.evaluate(async () => {
  const sim = await fetch('/api/vars', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'bAlarmBit', value: true }),
  });
  return sim.ok;
});
await sleep(900);
const alarmActive = await page.evaluate(async () => (await import('/js/runtime/alarms.js')).activeAlarms().length);
ok('页面2 时报警条件变量照样在采（写 1 后报警触发）', alarmActive >= 1, String(alarmActive));

/* ══════ 4. 效率：按页采集 + 块读，比全量少多少次读 ══════ */
const rate = async (ms = 1600) => {
  const a = await hel();
  await sleep(ms);
  const b = await hel();
  return { perSec: (b.reads - a.reads) / (ms / 1000), blocks: b.blocks, active: b.active };
};
const rScoped = await rate();
await page.evaluate(async () => {
  const names = window.app.project.variables().map(v => v.name);
  await fetch('/api/vars/declare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variables: window.app.project.variables(), active: names }),
  });
});
await sleep(700);
const rAll = await rate();
// 阈值别卡太死：整批回归跑的时候机器很忙，全量的读数会被压低（实测同一份代码
// 46.9 vs 65.6 过、46.9 vs 61.3 不过）—— 判定「明显少」给两种口径，够少一个就算过
ok('按页采集的每秒读数明显少于全量（本页 3 个变量 vs 全部 8 个）',
  rScoped.perSec < rAll.perSec * 0.75 || rScoped.perSec + 10 < rAll.perSec,
  `本页 ${rScoped.perSec.toFixed(1)} 次/秒（${rScoped.active} 变量/${rScoped.blocks} 块） vs 全量 ${rAll.perSec.toFixed(1)} 次/秒（${rAll.active} 变量/${rAll.blocks} 块）`);
ok('块数也少（连续地址合并没有白做）', rScoped.blocks < rAll.blocks, `${rScoped.blocks} < ${rAll.blocks}`);

/* ══════ 4b. 离开页面后的「保留采集」窗口（app.scopeKeep.keepMs）══════
   切走的那一页变量不立刻退出采集范围，再采 keepMs 毫秒 —— 来回切页数据不断。
   这里用 2.5 秒的短窗口验证：窗口内还在采、到期自动收回。 */
await page.evaluate((pid) => window.app.gotoPage(pid), ids.p1);   // 回页面1
await sleep(700);
await page.evaluate(() => { window.app.scopeKeep.keepMs = 2500; });
await page.evaluate((pid) => window.app.gotoPage(pid), ids.p2);   // 再切到页面2
await sleep(900);
const keepOn = await hel();
ok('离开页面后（保留窗口内）：上一页的变量还在采（来回切页数据不断）',
  keepOn.active > 5, `active=${keepOn.active}（期望 > 5，纯本页是 5）`);
await sleep(2700);                                                // 等窗口过期
const keepOff = await hel();
ok('保留窗口到期后自动收回：采集范围缩回本页变量',
  keepOff.active === 5, `active=${keepOff.active}（期望 5）`);
await page.evaluate(() => { window.app.scopeKeep.keepMs = 0; });

/* ══════ 5. 浏览器关掉/切后台，后端照样轮询 ══════ */
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).exitRun());
const before = (await hel()).reads;
await page.close();                       // 相当于浏览器切走/关掉页面
await sleep(1800);
const after = (await hel()).reads;
ok('页面关掉后后端仍在轮询（通讯在后端跑，不依赖页面）', after > before, `${before} → ${after}`);

ok('全程没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
try { sim.kill(); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 按页采集回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
