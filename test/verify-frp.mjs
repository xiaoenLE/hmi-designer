// verify-frp.mjs — 内置 FRP 客户端：页面里配「FRP 服务器 / 映射端口（画面 + PLC）」，开启就自动拉 frpc
//
// 为什么能自动化：frpc 的路径可以由环境变量 `HMI_FRPC` 指定（见 server/core/frp.py 的 find_frpc）——
// 这里把它指到一个**假的 frpc**（一个只睡不干活的 .bat），于是"生成配置 → 拉起进程 → 状态 → 停止
// → 崩了自动重拉"整条链路都能测，**不需要真的 frps 服务器**。
//
// 用法：node tools/run-suites.mjs verify-frp   （自己起隔离后端 + 临时数据目录）
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

/* ── 假的 frpc：参数里有 -c 就说明配置传进来了；起来就睡，直到被杀 ── */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-frp-'));
const DATA = path.join(WORK, 'data');
const STUB = path.join(WORK, 'frpc.exe.bat');
fs.writeFileSync(STUB, '@echo off\r\necho STUB frpc %*\r\nping -n 3600 127.0.0.1 >nul\r\n', 'utf-8');

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(DATA, { recursive: true });
const LOGS = path.join(WORK, 'logs');
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS, HMI_FRPC: STUB } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { if ((await fetch(H + '/')).ok) up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const api = async (p, body) => {
  const r = await fetch(H + p, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const confPath = path.join(DATA, 'frp', 'frpc.toml');
const readConf = () => (fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf-8') : '');
const pidPath = path.join(DATA, 'frp', 'frpc.pid');
const readPid = () => (fs.existsSync(pidPath) ? JSON.parse(fs.readFileSync(pidPath, 'utf-8')) : null);
const settings = () => JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf-8'));

/* ══════ A. 现状（还没配过）══════ */
const st0 = await api('/api/frp');
ok('A 读得到 FRP 现状（默认：没开、没配）',
  st0.ok === true && st0.running === false && st0.config?.enabled === false && !st0.config?.server_addr,
  JSON.stringify({ ok: st0.ok, running: st0.running, addr: st0.config?.server_addr }));
ok('A 自动检测到本机 IP（局域网地址，非空）',
  Array.isArray(st0.ips) && st0.ips.length > 0 && /^\d+\.\d+\.\d+\.\d+$/.test(st0.ips[0]), JSON.stringify(st0.ips));
ok('A 本机 HMI 端口 = 后端实际监听的那个', st0.local_port === PORT, `${st0.local_port} vs ${PORT}`);
ok('A 找得到 frpc（测试里由 HMI_FRPC 指到假的那个）',
  st0.frpc_found === true && /frpc\.exe\.bat$/.test(st0.frpc || ''), st0.frpc);
ok('A 还没接 PLC（内存模拟）→ plc 提示为空（界面据此提示手填）',
  !st0.plc || !st0.plc.mode, JSON.stringify(st0.plc));

/* ══════ B. 开启：生成配置 + 拉起 frpc（画面一条 + PLC 一条）══════ */
const saved = await api('/api/frp', {
  action: 'save',
  config: {
    enabled: true, server_addr: '159.75.50.193', server_port: 7000, token: 'xiaoen123',
    local_port: 0, remote_port: 6100, name: '',
    extras: [
      { name: 'PLC', local_ip: '192.168.1.10', local_port: 502, remote_port: 6502, enabled: true },
      { name: '没填全的', local_ip: '1.2.3.4', local_port: 0, remote_port: 0, enabled: true },
    ],
  },
});
ok('B 保存并开启 → frpc 起来了（running + pid）',
  saved.ok === true && saved.running === true && saved.pid > 0, JSON.stringify({ ok: saved.ok, pid: saved.pid, err: saved.last_error }));
ok('B 设置写进了 settings.json 的 frp 段（跟工程无关，跟着这台机器走）',
  settings().frp?.server_addr === '159.75.50.193' && settings().frp?.remote_port === 6100,
  JSON.stringify(settings().frp));
ok('B 起了 frpc 就把 pid 记下来了（<数据目录>/frp/frpc.pid：下次启动按它收尸 / 认自己人）',
  readPid()?.pid === saved.pid && readPid()?.owner === srv.pid,
  JSON.stringify({ pid: readPid()?.pid, want: saved.pid, owner: readPid()?.owner, srv: srv.pid }));
const toml = readConf();
ok('B 生成了 frpc.toml（在数据目录 frp\\ 下，不往安装目录写）', toml.length > 0, confPath);
ok('B 配置里有服务器 / 端口 / token', /serverAddr = "159\.75\.50\.193"/.test(toml)
  && /serverPort = 7000/.test(toml) && /auth\.token = "xiaoen123"/.test(toml),
  toml.split('\n').slice(0, 6).join(' | '));
ok('B 配置里有**画面那条**（127.0.0.1:本机端口 → 远程 6100）',
  /localIP = "127\.0\.0\.1"/.test(toml) && new RegExp(`localPort = ${PORT}`).test(toml) && /remotePort = 6100/.test(toml));
ok('B 配置里有**PLC 那条**（192.168.1.10:502 → 远程 6502）',
  /localIP = "192\.168\.1\.10"/.test(toml) && /localPort = 502/.test(toml) && /remotePort = 6502/.test(toml));

/* ══════ B2. 画面映射的本机端口：跟后端实际端口走，旧值不许抢戏 ══════
   现场报的：后端换个端口（8866 被占 / 开发时随机端口）映射就指着没人监听的端口，手机打开空白。
   所以 settings.json 里就算存着一个旧端口，画面那条也必须映射**当前这个后端监听的端口**。 */
const stale = await api('/api/frp', {
  action: 'save',
  config: { enabled: true, server_addr: '159.75.50.193', remote_port: 6100, local_port: 12345 },
});
ok('B2 存了一个旧端口（local_port=12345）也不作数：配置里映射的还是当前后端的端口',
  stale.ok === true && stale.local_port === PORT && new RegExp(`localPort = ${PORT}`).test(readConf())
  && !/localPort = 12345/.test(readConf()),
  `local_port=${stale.local_port} 端口=${PORT}`);
ok('B2 状态里给界面的那条映射，本机端口也是当前这个（界面照着显示，不用手填）',
  (stale.mappings || [])[0]?.local_port === PORT,
  JSON.stringify((stale.mappings || []).map(m => [m.kind, m.local_port])));
ok('B 没填全的那条**不进配置**（端口 0 不算数，免得 frpc 起不来）',
  !/1\.2\.3\.4/.test(toml), toml.includes('1.2.3.4') ? '竟然写进去了' : '没写进去');
ok('B 两条 [[proxies]] 都在（画面 + PLC）', (toml.match(/\[\[proxies\]\]/g) || []).length === 2,
  String((toml.match(/\[\[proxies\]\]/g) || []).length));
ok('B 状态里给了"手机该访问的地址"',
  saved.url_remote === 'http://159.75.50.193:6100/run', saved.url_remote);
ok('B 状态里列了这次建的两条映射', (saved.mappings || []).length === 2
  && saved.mappings[0].kind === 'hmi' && saved.mappings[1].kind === 'extra',
  JSON.stringify((saved.mappings || []).map(m => [m.kind, m.local_ip, m.local_port, m.remote_port])));
ok('B frpc 的启动参数里有 -c 配置（假 frpc 把参数打进了日志）',
  (saved.log || []).join('\n').includes('-c') || (saved.log || []).length > 0,
  JSON.stringify((saved.log || []).slice(-2)));

/* ══════ C. 停止 ══════ */
const stopped = await api('/api/frp', { action: 'stop' });
ok('C 「停止」→ frpc 停了（running=false）', stopped.running === false, JSON.stringify({ running: stopped.running, pid: stopped.pid }));
ok('C 停了就把 pid 记录清掉（别再拿一个过期的 pid 去收尸）', readPid() === null, JSON.stringify(readPid()));

/* ══════ D. 崩了自动重拉（看门狗）══════ */
const started = await api('/api/frp', { action: 'restart' });
const pid1 = started.pid;
await new Promise(r => { try { process.kill(pid1); } catch { /* 已经没了 */ } r(); });
await sleep(500);
const dead = await api('/api/frp');
await sleep(4500);                         // 看门狗 2 秒一轮 + 重拉
const revived = await api('/api/frp');
ok('D 手动杀掉 frpc（模拟崩溃）→ 看门狗把它拉回来了',
  dead.running === false && revived.running === true && revived.pid > 0 && revived.pid !== pid1,
  JSON.stringify({ pid1, deadRunning: dead.running, newPid: revived.pid, restarts: revived.restarts }));

/* ══════ E. 配置不全时的说法 ══════ */
const noMap = await api('/api/frp', { action: 'save', config: { enabled: true, server_addr: 'a.b.c', remote_port: 0, extras: [] } });
ok('E 开着但一条映射都没有 → 明确说清要填什么（不是静默不起来）',
  noMap.ok === false && /映射/.test(noMap.error || ''), JSON.stringify(noMap.error));
const noAddr = await api('/api/frp', { action: 'save', config: { enabled: true, server_addr: '', remote_port: 6100 } });
ok('E 没填服务器地址 → 明确报错', noAddr.ok === false && /服务器地址/.test(noAddr.error || ''), JSON.stringify(noAddr.error));

/* ══════ F. 界面：对话框里能配这几格、能看到映射和地址 ══════ */
await api('/api/frp', { action: 'save', config: { enabled: true, server_addr: '159.75.50.193', server_port: 7000, token: 'xiaoen123', remote_port: 6100, extras: [{ name: 'PLC', local_ip: '192.168.1.10', local_port: 502, remote_port: 6502, enabled: true }] } });
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(H + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(300);
await page.evaluate(() => import('/js/editor/frpSettings.js').then(m => m.openFrpSettings()));
await sleep(700);
const ui = await page.evaluate(() => ({
  open: !!document.getElementById('frpAddr'),
  addr: document.getElementById('frpAddr')?.value,
  sport: document.getElementById('frpSPort')?.value,
  token: document.getElementById('frpToken')?.value,
  rport: document.getElementById('frpRPort')?.value,
  lport: document.getElementById('frpLPort')?.textContent?.trim(),
  on: !!document.getElementById('frpOn')?.checked,
  maps: [...document.querySelectorAll('#frpExtras .frp-map')].map(r => ({
    name: r.querySelector('[data-e="name"]')?.value,
    ip: r.querySelector('[data-e="local_ip"]')?.value,
    lp: r.querySelector('[data-e="local_port"]')?.value,
    rp: r.querySelector('[data-e="remote_port"]')?.value,
  })),
  out: document.getElementById('frpOut')?.textContent || '',
}));
ok('F 对话框打得开，服务器/端口/token/映射端口都回填了',
  ui.open && ui.addr === '159.75.50.193' && ui.sport === '7000' && ui.token === 'xiaoen123'
  && ui.rport === '6100' && ui.on === true, JSON.stringify(ui).slice(0, 200));
ok('F PLC 那条映射也回填出来（能改/能删/能再加）',
  ui.maps.length === 1 && ui.maps[0].ip === '192.168.1.10' && ui.maps[0].lp === '502' && ui.maps[0].rp === '6502',
  JSON.stringify(ui.maps));
ok('F 现状里写着"手机该访问的地址"和这次的两条映射',
  /159\.75\.50\.193:6100/.test(ui.out) && /192\.168\.1\.10:502/.test(ui.out), ui.out.slice(0, 160));
ok('F 现状里「本机」就是 127.0.0.1（本机地址不探测），局域网地址另起一行',
  /本机：127\.0\.0\.1/.test(ui.out) && /局域网 IP：\d+\.\d+\.\d+\.\d+/.test(ui.out)
  && !/本机：(?!127\.0\.0\.1)\d/.test(ui.out), ui.out.slice(0, 200));
ok('F 画面映射的本机端口是"显示出来的"（不是填空格），写的就是后端当前端口 —— 端口变它自己变',
  ui.lport === String(PORT), `卡片上是 ${ui.lport}，后端是 ${PORT}`);
ok('F 那一格是只读显示，不是输入框（省得存进一个和实际端口对不上的数）',
  await page.evaluate(() => document.getElementById('frpLPort')?.tagName) === 'CODE');
ok('F 界面上根本没有"控制台黑框"的按钮（跑在后端，不是弹出个 cmd 窗口）',
  !/cmd|黑框/i.test(ui.out));

// 点「＋ 添加一条」→ 多一行（能自己再加别的设备）
await page.click('#frpAddExtra');
await sleep(250);
const added = await page.evaluate(() => document.querySelectorAll('#frpExtras .frp-map').length);
ok('F 「＋ 添加一条」能加行（PLC 之外还想映射别的设备）', added === 2, String(added));

// frpc 找不到时，界面要说清放哪儿（用假的 GET 结果验）
const missing = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const orig = backend.rpc;
  backend.rpc = async () => ({
    ok: true, frpc_found: false, frpc: '', running: false, ips: ['192.168.1.50'], local_port: 8866,
    config: { enabled: false, server_addr: '', server_port: 7000, remote_port: 6100, extras: [] },
    mappings: [], url_remote: '',
  });
  try {
    await import('/js/editor/frpSettings.js').then(m => m.openFrpSettings());
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('frpOut')?.textContent || '';
  } finally { backend.rpc = orig; }
});
ok('F 没找到 frpc.exe 时，界面明确说该放到哪儿（不静默失败）',
  /没找到 frpc\.exe/.test(missing) && /frp/.test(missing), missing.slice(0, 120));
ok('F frpc 找不到时「本机」照样是 127.0.0.1（跟 frpc 在不在没关系）',
  /本机：127\.0\.0\.1/.test(missing) && /局域网 IP：192\.168\.1\.50/.test(missing), missing.slice(0, 200));
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 忽略 */ }

const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 内置 FRP 客户端（页面里配 + 自动拉起）：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
