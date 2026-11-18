// verify-desktop.mjs — 现场客户端（PyWebView 原生窗口 + 内置后端，关窗口 = 关服务）
//   ① 自检模式真开一个 WebView2 原生窗口：默认地址就是运行页 /（只读运行页），并挂了 js_api
//   ② **窗口一关，端口就释放**（连不上）—— 这是这套客户端的核心诉求：不留后台进程
//   ③ --no-window：同一套后端照旧（/ 是运行页不用登录、/edit 要登录），SIGTERM 后端口也释放
//   ④ 窗口 profile 是**持久**的（pywebview 默认 private_mode=True 会把 cookie/localStorage 删掉）
//   ⑤ 端口被占用时自动换空闲端口（不会「地址已在使用」把人拦在门外）
//   ⑥ --no-auth 可以把登录闸门关掉（本机调试）
// 页面上的功能（Ctrl+Shift+E 进编辑页、登录、改连接…）都在**浏览器**套件 verify-run-only.mjs 里测：
// pywebview 窗口里跑的也是 Chromium，没必要重复一遍；这里只管窗口这层壳。
// 用法：node test/verify-desktop.mjs   （会短暂弹出一个原生窗口，跑完自动关）
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out = [];
const ok = (n, c, e = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const portOpen = (port) => new Promise(res => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(800, () => { s.destroy(); res(false); });
});
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-desktop-'));

/** 跑一次客户端，收集 stdout（不阻塞在窗口上：--self-test 自己会关窗口退出） */
const runClient = (args, waitMs = 60000) => new Promise(res => {
  const p = spawn(PY, ['server/hmi_desktop.py', ...args],
    { cwd: ROOT, env: { ...process.env, HMI_DATA_DIR: DATA } });
  let text = '';
  p.stdout.on('data', d => { text += d.toString('utf8'); });
  p.stderr.on('data', d => { text += d.toString('utf8'); });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, waitMs);
  p.on('exit', code => { clearTimeout(timer); res({ code, text }); });
});

/* ── 1. 自检：真开一个原生窗口，确认页面 + 关窗口后端口释放 ── */
const PORT1 = await freePort();
const t0 = Date.now();
const self = await runClient(['--port', String(PORT1), '--self-test']);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
ok('自检跑通（真开了一个 WebView2 原生窗口）',
  self.code === 0 && /SELFTEST_OK/.test(self.text), `exit=${self.code} 用时 ${secs}s`);
const info = (() => { try { return JSON.parse((self.text.match(/SELFTEST_OK port=\d+ (\{.*\})/) || [])[1] || '{}'); } catch { return {}; } })();
ok('窗口里加载的是「只读运行页」（默认地址 /run，window.app.runOnly === true）',
  info.runOnly === true && info.path === '/run', JSON.stringify(info));
ok('窗口里挂了 js_api（页面能在**同一个窗口**里换页，不用开第二个窗口）',
  info.jsApi === true, String(info.jsApi));
ok('关掉窗口后进程退出、端口立刻释放（不留后台服务）',
  self.code === 0 && (await portOpen(PORT1)) === false, `端口 ${PORT1} 仍在监听=${await portOpen(PORT1)}`);

/* ── 1b. 窗口 profile 要**持久**（关掉再开不用重新登录/重敲账号密码）──
   页面上的功能（Ctrl+Shift+E 进编辑页、登录、改 PLC 连接、验证码…）都在**浏览器**套件里测：
   verify-run-only.mjs。这里只管「窗口这层壳」：进程/端口生命周期、profile 持久化、参数。 */
ok('窗口 profile 落在数据目录里、而且是持久模式（pywebview 默认会把 cookie/localStorage 删掉）',
  info.persistent === true && /webview$/.test(info.store || '') && fs.existsSync(path.join(DATA, 'webview')),
  JSON.stringify({ persistent: info.persistent, store: info.store }));

/* ── 1c. --edit 是给管理员用的入口（编辑器要登录） ── */
const PORT1C = await freePort();
const second = await runClient(['--port', String(PORT1C), '--edit', '--self-test']);
const sinfo = (() => { try { return JSON.parse((second.text.match(/SELFTEST_OK port=\d+ (\{.*\})/) || [])[1] || '{}'); } catch { return {}; } })();
const sinfoAny = (() => { try { return JSON.parse((second.text.match(/\[desktop\] 自检：(\{.*\})/) || [])[1] || '{}'); } catch { return {}; } })();
const s = Object.keys(sinfo).length ? sinfo : sinfoAny;
ok('--edit 打开的是组态编辑页（要登录 → 落到登录页；不是运行页）',
  second.code === 0 && (s.path === '/edit' || s.path === '/login') && s.runOnly === false,
  JSON.stringify({ path: s.path, runOnly: s.runOnly, loginPage: s.loginPage }));

/* ── 1d. 控制实验：数据目录一换（等于换了台机器）就该重新登录 ── */
const FRESH = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-desktop-fresh-'));
const FRESH_PORT = await freePort();
const freshRun = await new Promise(res => {
  const p = spawn(PY, ['server/hmi_desktop.py', '--port', String(FRESH_PORT), '--edit', '--self-test'],
    { cwd: ROOT, env: { ...process.env, HMI_DATA_DIR: FRESH } });
  let text = '';
  p.stdout.on('data', d => { text += d.toString('utf8'); });
  p.stderr.on('data', d => { text += d.toString('utf8'); });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, 60000);
  p.on('exit', code => { clearTimeout(timer); res({ code, text }); });
});
const finfo = (() => { try { return JSON.parse((freshRun.text.match(/\[desktop\] 自检：(\{.*\})/) || [])[1] || '{}'); } catch { return {}; } })();
ok('换一个数据目录（= 换台机器）后 --edit 仍然要求登录（说明上一条确实是"记住了"，不是没设闸门）',
  finfo.loginPage === true && finfo.path === '/login', JSON.stringify({ path: finfo.path, loginPage: finfo.loginPage }));
try { fs.rmSync(FRESH, { recursive: true, force: true }); } catch { /* 忽略 */ }

/* ── 2. --no-window：同一套后端（/ 是运行页不用登录、/edit 要登录），退出后端口也释放 ── */
const PORT2 = await freePort();
const headless = spawn(PY, ['server/hmi_desktop.py', '--port', String(PORT2), '--no-window'],
  { cwd: ROOT, env: { ...process.env, HMI_DATA_DIR: DATA } });
let headOut = '';
headless.stdout.on('data', d => { headOut += d.toString('utf8'); });
headless.stderr.on('data', d => { headOut += d.toString('utf8'); });
let ready = false;
for (let i = 0; i < 40; i++) { await sleep(300); if (await portOpen(PORT2)) { ready = true; break; } }
ok('--no-window 起得来服务', ready, headOut.split('\n').slice(0, 2).join(' | '));
const runRes = await fetch(`http://127.0.0.1:${PORT2}/`, { redirect: 'manual' });
const runHtml = await runRes.text();
ok('/ 路由没登录时仍给现场运行页（窗口客户端默认地址已是 /run）',
  runRes.status === 200 && runHtml.includes('__HMI_RUN_ONLY__'), String(runRes.status));
const editRes = await fetch(`http://127.0.0.1:${PORT2}/edit`, { redirect: 'manual' });
ok('老地址 /edit 会 302 回到 /（不再是个单独的页面）',
  editRes.status === 302 && (editRes.headers.get('location') || '').endsWith('/'),
  `${editRes.status} → ${editRes.headers.get('location')}`);
const plcPost = await fetch(`http://127.0.0.1:${PORT2}/api/plc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }),
});
ok('窗口客户端也挡得住没登录的改配置请求', plcPost.status === 401, String(plcPost.status));

/* ── 3. 端口被占用 → 自动换空闲端口 ── */
const self2 = await runClient(['--port', String(PORT2), '--self-test']);
const port2Used = Number((self2.text.match(/SELFTEST_OK port=(\d+)/) || [])[1] || 0);
ok('端口被占用时自动换一个空闲端口（不会「地址已在使用」开不了窗）',
  self2.code === 0 && port2Used > 0 && port2Used !== PORT2 && /被占用/.test(self2.text),
  `请求 ${PORT2} → 实际 ${port2Used}`);
ok('换端口那次也是正常自检通过', /SELFTEST_OK/.test(self2.text), self2.text.split('\n').filter(l => l.includes('SELFTEST')).join(' | '));

// 收掉 --no-window 那个实例，确认端口跟着释放
headless.kill();
await sleep(1500);
ok('--no-window 实例被结束后端口也释放', (await portOpen(PORT2)) === false, `端口 ${PORT2}`);

/* ── 4. --no-auth：本机调试可以关掉闸门 ── */
const PORT4 = await freePort();
const noAuth = spawn(PY, ['server/hmi_desktop.py', '--port', String(PORT4), '--no-window', '--no-auth'],
  { cwd: ROOT, env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); if (await portOpen(PORT4)) break; }
const rootNoAuth = await fetch(`http://127.0.0.1:${PORT4}/`, { redirect: 'manual' });
const noAuthHtml = await rootNoAuth.text();
ok('--no-auth 时 / 直接就是编辑器（调试/跑测试省掉登录）',
  rootNoAuth.status === 200 && noAuthHtml.includes('id="toolbar"') && !noAuthHtml.includes('__HMI_RUN_ONLY__'),
  String(rootNoAuth.status));
noAuth.kill();
await sleep(1200);

const pass = out.filter(l => l.startsWith('PASS')).length;
console.log(out.join('\n'));
console.log(`\n==== 现场客户端（原生窗口 + 关窗口即停服务）：${pass}/${out.length} 通过 ====`);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
