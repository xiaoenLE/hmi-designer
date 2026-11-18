// _t_fetchpatch.mjs — 自检：Node 侧 fetch 改道（含登录/访客分流、模拟器放行）
// 用法：node test/_t_fetchpatch.mjs    （自己拉起一个带登录闸门的后端 + 临时数据目录）
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { installNodeFetchPatch, wsHealth } from './_wsfetch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PY = process.env.HMI_PY || 'python';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const out = [];
const ok = (n, c, e = '') => { out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`); if (!c) process.exitCode = 1; };

const PORT = await freePort();
const SIM = await freePort();               // 假装是"模拟器"的另一个 HTTP 服务
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-fp-'));
const PW = 'admin123';

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA },
});
const sim = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sim: true, url: req.url }));
});
await new Promise(r => sim.listen(SIM, '127.0.0.1', r));

const H = `http://127.0.0.1:${PORT}`;
// 等后端起来：先用**原生** HTTP 打静态首页（改道是后面才装的）
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(H + '/'); if (r.ok) break; } catch { /* 还没起来 */ }
  await sleep(300);
}
installNodeFetchPatch(PORT);

// ① 访客打接口
const vars = await (await fetch(H + '/api/vars')).json();
ok('改道后 /api/vars 照样拿得到 JSON（走长连接）', vars && typeof vars === 'object' && 'vars' in vars, JSON.stringify(vars).slice(0, 90));

// ② 访客打管理接口 → 401（闸门还在）
const guestPost = await fetch(H + '/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { pages: [] } }) });
ok('没登录也能写工程 → 401（管理员闸门原样）', guestPost.status === 401, 'status=' + guestPost.status);

// ③ 登录拿 cookie
const login = await fetch(H + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
ok('POST /api/login（其实是在长连接上登录）返回 cookie', login.status === 200 && /hmi_session=.+/.test(cookie), 'status=' + login.status + ' cookie=' + cookie.slice(0, 24));

// ④ 带 cookie → 管理员
const admPost = await fetch(H + '/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ data: { pages: [{ id: 'p1', name: '页1', widgets: [] }], meta: { name: '自检' } } }) });
ok('带 cookie 写工程 → 200（管理员那条连接）', admPost.status === 200, 'status=' + admPost.status);

// ⑤ 会话查询：带 cookie 是登录态，不带不是
const sessAdm = await (await fetch(H + '/api/session', { headers: { Cookie: cookie } })).json();
const sessGuest = await (await fetch(H + '/api/session')).json();
ok('带 cookie 的 /api/session → logged_in=true', sessAdm.logged_in === true && sessAdm.auth_enabled === true, JSON.stringify(sessAdm));
ok('不带 cookie 的 /api/session → logged_in=false（访客连接没被带登录）', sessGuest.logged_in === false, JSON.stringify(sessGuest));

// ⑥ 模拟器（别的端口）必须**原样走 HTTP**，不能被劫持
const simRes = await (await fetch(`http://127.0.0.1:${SIM}/api/state`)).json();
ok('别的端口的 /api/* 原样走 HTTP（模拟器没被劫持）', simRes.sim === true, JSON.stringify(simRes));

// ⑦ 老接口真的没了（改道只对套件生效，不改后端行为）
const old = await fetch(H + '/api/health');
ok('/api/health 仍然是 404（后端一条 HTTP 接口都没留）', old.status === 404, 'status=' + old.status);

// ⑧ ★ 后端被重启之后，改道要能自己接回来（verify-retain / verify-update 这种会重启后端的套件）
srv.kill();
await sleep(800);
const srv2 = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA },
});
for (let i = 0; i < 60; i++) { try { const r = await fetch(H + '/'); if (r.ok) break; } catch { /* 等 */ } await sleep(300); }
const afterBoot = await (await fetch(H + '/api/vars')).json();
ok('后端重启后：访客连接自动重连，接口照常能打', afterBoot && typeof afterBoot === 'object' && 'vars' in afterBoot,
  JSON.stringify(afterBoot).slice(0, 90));
// 带 cookie 的那条是管理员：token 落在 sessions.json 里，重启后应该**还是管理员**（不用重新登录）
const admAfter = await fetch(H + '/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ data: { pages: [{ id: 'p1', name: '页1', widgets: [] }], meta: { name: '重启后' } } }) });
ok('后端重启后：管理员那条连接用 token 自动接回（不用重新输密码）', admAfter.status === 200, 'status=' + admAfter.status);
const sessAfter = await (await fetch(H + '/api/session', { headers: { Cookie: cookie } })).json();
ok('重启后 /api/session 仍报登录态', sessAfter.logged_in === true, JSON.stringify(sessAfter));

srv2.kill(); sim.close();
await sleep(300);
for (const l of out) console.log(l);
console.log(`\n${out.filter(x => x.startsWith('PASS')).length}/${out.length} 通过`);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(process.exitCode || 0);
