// verify-users.mjs — 多用户/角色（后端能力：账号表 + 登录角色 + 用户管理接口 + 权限闸门）
//   现场口径（本轮调整后）：**只有管理员 + 操作员两种角色**，而且
//     · admin    全权（改配置/存工程/日志/FRP/用户/配方/写变量）
//     · operator **只能改设备连接**（PLC / OPC UA 连接与参数）；读画面不受限，
//                其它写操作一律拒 —— 写变量也不行
//     · viewer   **已取消**，只为老数据兼容：老的 users.json / 老会话里的 viewer
//                仍能登录、且按只读处理；但 add/role 传 viewer 会被拒（400）
//   口径（跟 server/core/users.py + core/api.py + core/wsbridge.py 一一对应）：
//     · 账号表存 <数据目录>/users.json（现场数据，原子写；密码 = 盐$sha256(盐+密码)，绝不存明文）；
//     · 登录（长连接原生消息）：
//         {t:'login', password}         → 内置管理员密码 = admin 角色（老前端照旧能用）
//         {t:'login', user, password}   → 账号表里的账号 → 角色由账号决定
//       登录 ack 带 {ok, logged_in, token, role, user}；{t:'session'} 也带 {role, user}；
//     · GET  /api/users（admin）    → {ok, users:[…], roles:['admin','operator'], role_cn}
//     · POST /api/users（admin）    → {action:'add'|'delete'|'passwd'|'role'|'enable', …}
//     · 闸门：/api/plc 与 /api/opcua/browse|parse-xml 要 operator+；
//             其余配置类（工程/日志/FRP/update/用户/配方 save·delete·**apply**）要 admin；
//             写变量（/api/vars POST 与热路径 {t:write}/{t:writes}）对 operator/viewer 都 403。
// 用法：node test/verify-users.mjs
//   ⚠ 这套**自己起 --auth 模式的隔离后端**（即使 run-suites 传了端口也自己起一套）：
//     账号/角色闸门只有在登录闸门开着时才有意义；run-suites 的后端是 --no-auth，跑那套
//     等于把最重要的断言全跳过。数据目录用临时目录，跑完就删。
//   ⚠ 起后端**之前**先往临时数据目录里塞一个 viewer 账号（老数据兼容路径）：
//     现在 API 已经不让建 viewer 了，但现场升级上来的 users.json 里可能还有。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wsConnect } from './_wsfetch.mjs';

const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const PW = 'admin123';                       // 全新数据目录 → 后端按默认密码建口令文件
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

/* ══════ 0. 隔离数据目录：预置一个**老 viewer 账号**，再起 --auth 后端 ══════ */
const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-users-'));
const LEGACY_PWD = 'vw1234';
const legacySalt = crypto.randomBytes(16).toString('hex');
const legacyHash = crypto.createHash('sha256')
  .update(Buffer.concat([Buffer.from(legacySalt, 'hex'), Buffer.from(LEGACY_PWD, 'utf8')]))
  .digest('hex');
fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify({ users: {
  vwOld: { pwd: `${legacySalt}$${legacyHash}`, role: 'viewer', enabled: true,
           created: '2026-01-01 00:00:00' },
} }, null, 2), 'utf8');
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: path.join(DATA, 'logs'),
           HMI_UPDATE_URL: '', HMI_UPDATE_ARCHIVE: '' } });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { const r = await fetch(H + '/run'); up = r.ok; } catch { /* 等它起来 */ }
}
if (!up) {
  console.log('FAIL  后端没起来');
  try { srv.kill(); } catch { /* 忽略 */ }
  process.exit(1);
}

/* ══════ 工具：连接 / 登录 / 调接口 ══════ */
const openConn = async () => {
  const c = wsConnect(PORT);
  await c.ready;
  const hello = await c.frame('hello', 8000);
  return { c, hello };
};
const loginPw = (c, pw) => c.ask({ t: 'login', password: pw }, 15000);
const loginUser = (c, user, password) => c.ask({ t: 'login', user, password }, 15000);
const apiOf = (c) => async (p, { method = 'GET', body = null } = {}) => {
  const j = await c.call(p, { method, body });
  const data = (j && j.data) || {};
  return { status: (j && j.status) || 0, ...(data && typeof data === 'object' ? data : { value: data }) };
};
const usersOf = (api, body) => api('/api/users', { method: 'POST', body });
const listUsers = (api) => api('/api/users');

/* ══════ 1. hello：能力表 / 登录态 ══════ */
const adminConn = await openConn();
const hello = adminConn.hello;
const admin = apiOf(adminConn.c);
ok('hello.features 里有 users（前端据此判断后端支持账号/角色）',
  Array.isArray(hello?.features) && hello.features.includes('users'),
  JSON.stringify(hello?.features || null));
ok('hello.auth 是 {enabled:true, logged_in:false}（开了闸门、还没登录）',
  hello?.auth?.enabled === true && hello?.auth?.logged_in === false,
  JSON.stringify(hello?.auth));

/* ══════ 2. 未登录：管理接口 401 + need_login（前端据此弹登录）══════ */
const anonGate = await admin('/api/users', { method: 'POST', body: { action: 'add', user: 'x', password: 'xxxx' } });
ok('未登录开账号 → 401 + need_login', anonGate.status === 401 && anonGate.need_login === true,
  JSON.stringify({ status: anonGate.status, need_login: anonGate.need_login }));
const anonProject = await admin('/api/project', { method: 'POST', body: { data: { pages: [] } } });
ok('未登录存工程 → 401 + need_login', anonProject.status === 401 && anonProject.need_login === true,
  JSON.stringify({ status: anonProject.status }));

/* ══════ 3. 内置管理员密码登录 = admin（老前端那条路）══════ */
const aLogin = await loginPw(adminConn.c, PW);
ok('管理员密码登录：ok + role=admin + 有 token',
  aLogin?.ok === true && aLogin.role === 'admin' && !!aLogin.token,
  JSON.stringify({ ok: aLogin?.ok, role: aLogin?.role, user: aLogin?.user, token: !!aLogin?.token }));
const aSess = await adminConn.c.session();
ok('session 报 admin 角色（登录后知道"我是谁、什么角色"）',
  aSess?.logged_in === true && aSess.role === 'admin' && aSess.user === 'admin',
  JSON.stringify(aSess));
const adminCfg = await admin('/api/plc');
ok('管理员 GET /api/plc 能看到 password 字段（连接对话框要带上一次的口令）',
  typeof adminCfg.config === 'object' && 'password' in adminCfg.config,
  JSON.stringify(Object.keys(adminCfg.config || {})));

/* ══════ 4. 管理员开账号：只认 admin/operator（viewer 已取消）══════ */
const addOp = await usersOf(admin, { action: 'add', user: 'op1', password: 'op1234', role: 'operator' });
const addVw = await usersOf(admin, { action: 'add', user: 'vw1', password: 'vw1234', role: 'viewer' });
const addAdm2 = await usersOf(admin, { action: 'add', user: 'adm2', password: 'adm12345', role: 'admin' });
ok('加 operator 账号：回公开字段 {name,role,enabled,created}，没有密码',
  addOp?.ok === true && addOp.user?.name === 'op1' && addOp.user?.role === 'operator'
  && addOp.user?.enabled === true && typeof addOp.user?.created === 'string'
  && !('pwd' in addOp.user) && !('password' in addOp.user),
  JSON.stringify(addOp?.user));
ok('加 admin 账号成功', addAdm2?.ok === true && addAdm2.user?.role === 'admin',
  JSON.stringify({ adm2: addAdm2?.user?.role }));
ok('**加 viewer 账号 → 400**（观察员已取消：只认 admin / operator）',
  addVw.status === 400 && addVw.ok === false
  && /admin/.test(String(addVw.error || '')) && /operator/.test(String(addVw.error || '')),
  JSON.stringify({ status: addVw.status, error: addVw.error }));
const dup = await usersOf(admin, { action: 'add', user: 'op1', password: 'again1', role: 'operator' });
ok('重名再开 → 400 + 明确原因（不是静默覆盖）',
  dup.status === 400 && dup.ok === false && /已存在/.test(String(dup.error || '')),
  JSON.stringify({ status: dup.status, error: dup.error }));
const badRole = await usersOf(admin, { action: 'add', user: 'xx1', password: 'xxxx1', role: 'root' });
ok('角色写错 → 400 + 提示只能是 admin/operator',
  badRole.status === 400 && /admin/.test(String(badRole.error || '')) && /operator/.test(String(badRole.error || '')),
  JSON.stringify({ status: badRole.status, error: badRole.error }));
const shortPwd = await usersOf(admin, { action: 'add', user: 'xx2', password: '123', role: 'operator' });
ok('密码太短 → 400（和内置管理员 set_password 的 ≥4 位口径一致）',
  shortPwd.status === 400 && /密码/.test(String(shortPwd.error || '')),
  JSON.stringify({ status: shortPwd.status, error: shortPwd.error }));

/* ══════ 5. 用户列表：roles 只有两种；老 viewer 仍在（但列表不提供该角色）══════ */
const lst = await listUsers(admin);
const names = (lst.users || []).map(u => u.name).sort();
ok('用户列表含 op1/adm2 + 预置的老 viewer（vwOld），角色/启用/创建时间齐全',
  lst.ok === true && JSON.stringify(names) === JSON.stringify(['adm2', 'op1', 'vwOld'])
  && lst.users.every(u => typeof u.name === 'string' && typeof u.role === 'string'
    && typeof u.enabled === 'boolean' && typeof u.created === 'string'),
  JSON.stringify(lst.users));
ok('用户列表**不回密码/盐/哈希**（键只有 name/role/enabled/created，整包也没有 pwd/password）',
  lst.users.every(u => Object.keys(u).sort().join(',') === 'created,enabled,name,role')
  && !/"pwd"|"password"|"salt"|"hash"/.test(JSON.stringify(lst)),
  JSON.stringify(Object.keys(lst.users[0] || {})));
ok('GET /api/users 的 roles 只有 admin/operator（viewer 不再对外提供）',
  JSON.stringify(lst.roles) === JSON.stringify(['admin', 'operator']),
  JSON.stringify(lst.roles));
ok('role_cn 里没有 viewer（前端下拉框不会再出现「观察员」）',
  !('viewer' in (lst.role_cn || {})) && Object.keys(lst.role_cn || {}).sort().join(',') === 'admin,operator',
  JSON.stringify(lst.role_cn));

/* ══════ 6. operator 登录（运行态只能改设备连接）══════ */
const opConn = await openConn();
const opLogin = await loginUser(opConn.c, 'op1', 'op1234');
ok('账号登录（operator）：ok + role=operator + token',
  opLogin?.ok === true && opLogin.role === 'operator' && opLogin.user === 'op1' && !!opLogin.token,
  JSON.stringify({ ok: opLogin?.ok, role: opLogin?.role, user: opLogin?.user }));
const opToken = opLogin.token;
const opSess = await opConn.c.session();
ok('operator 的 session 带 role/user', opSess?.logged_in === true && opSess.role === 'operator' && opSess.user === 'op1',
  JSON.stringify(opSess));
const op = apiOf(opConn.c);

/* ══════ 7. operator：写变量一律 403（"只能改设备连接"）══════ */
const opApiWrite = await op('/api/vars', { method: 'POST', body: { name: 'opVar', value: 42 } });
ok('operator 写变量（/api/vars POST）→ 403「只能改设备连接」',
  opApiWrite.status === 403 && opApiWrite.ok === false
  && /操作员/.test(String(opApiWrite.error || '')) && /只能改设备连接/.test(String(opApiWrite.error || '')),
  JSON.stringify({ status: opApiWrite.status, error: opApiWrite.error }));
const opHotWrite = await opConn.c.ask({ t: 'write', name: 'opVar', value: 1 });
ok('operator 写变量（长连接热路径 {t:write}）→ 拒，带原因',
  opHotWrite?.ok === false && /操作员/.test(String(opHotWrite?.error || ''))
  && /只能改设备连接/.test(String(opHotWrite?.error || '')),
  JSON.stringify({ ok: opHotWrite?.ok, error: opHotWrite?.error }));
const opHotWrites = await opConn.c.ask({ t: 'writes', items: [{ name: 'a', value: 1 }] });
ok('operator 批量写（{t:writes}）→ 也拒', opHotWrites?.ok === false && /只能改设备连接/.test(String(opHotWrites?.error || '')),
  JSON.stringify({ ok: opHotWrites?.ok }));
const opRead = await op('/api/vars');
ok('operator 读变量 → 放行（读画面不受限）', opRead.status === 200 && typeof opRead.vars === 'object',
  JSON.stringify({ status: opRead.status }));

/* ══════ 8. operator：能改设备连接（PLC 连接 / OPC UA 解析）；配置类全 403 ══════ */
const CLOSED = await freePort();          // 一个没人监听的端口：连不上，但接口本身要放行
const opPlcConnect = await op('/api/plc', { method: 'POST', body: {
  action: 'connect', ip: '127.0.0.1', port: CLOSED, unit: 1, poll_ms: 200, word_order: 'cdab',
} });
ok('operator **改 PLC 连接 → 放行**（接口 200；探活失败只写在 probe 里，不是权限问题）',
  opPlcConnect.ok === true && !!opPlcConnect.probe,
  JSON.stringify({ ok: opPlcConnect.ok, mode: opPlcConnect.status?.mode, probe: opPlcConnect.probe?.ok }));
const opCfg = await op('/api/plc');
ok('operator GET /api/plc 能看到 password（他要改连接，就得看到/填口令）',
  opCfg.ok === true && 'password' in (opCfg.config || {}),
  JSON.stringify(Object.keys(opCfg.config || {})));
await admin('/api/plc', { method: 'POST', body: { action: 'disconnect' } });    // 还原成内存模拟
const opXml = await op('/api/opcua/parse-xml', { method: 'POST', body: { xml: '<X/>' } });
ok('operator OPC UA 符号配置解析 → 放行（不是 403）',
  opXml.status === 200, JSON.stringify({ status: opXml.status }));
const opProto = await op('/api/project', { method: 'POST', body: { data: { pages: [] } } });
ok('operator 存工程 → 403（不是改连接，不能动）',
  opProto.status === 403 && opProto.ok === false && /权限|管理员/.test(String(opProto.error || '')),
  JSON.stringify({ status: opProto.status, error: opProto.error }));
const opUsersGet = await op('/api/users', { method: 'GET' });
const opUsersAdd = await usersOf(op, { action: 'add', user: 'zz', password: 'zzzz1', role: 'operator' });
ok('operator 看/改用户管理 → 403（账号管理只有管理员）',
  opUsersGet.status === 403 && opUsersAdd.status === 403,
  JSON.stringify({ get: opUsersGet.status, post: opUsersAdd.status }));
const opLogGet = await op('/api/logsettings');
const opLogPost = await op('/api/logsettings', { method: 'POST', body: { keep_days: 5 } });
const opFrp = await op('/api/frp');
ok('operator 日志设置 / FRP → 403（本机配置类）',
  opLogGet.status === 403 && opLogPost.status === 403 && opFrp.status === 403,
  JSON.stringify({ logGet: opLogGet.status, logPost: opLogPost.status, frp: opFrp.status }));
const opVarsReset = await op('/api/vars/reset', { method: 'POST', body: {} });
ok('operator 内部变量恢复初值 → 403（ADMIN_PATHS）', opVarsReset.status === 403,
  JSON.stringify({ status: opVarsReset.status }));

/* ══════ 9. 配方：operator 连"应用"都不行（save/delete/apply 全 admin）══════ */
const adminSaveR = await admin('/api/recipes', { method: 'POST', body: { action: 'save', name: 'R_shift', vars: { rSpeed: 1200 } } });
ok('（前提）管理员存下配方 R_shift', adminSaveR.ok === true && adminSaveR.name === 'R_shift',
  JSON.stringify(adminSaveR));
const opRecipeSave = await op('/api/recipes', { method: 'POST', body: { action: 'save', name: 'R_op', vars: { a: 1 } } });
const opRecipeApply = await op('/api/recipes', { method: 'POST', body: { action: 'apply', name: 'R_shift' } });
const opRecipeDel = await op('/api/recipes', { method: 'POST', body: { action: 'delete', name: 'R_shift' } });
ok('operator 配方 save / **apply** / delete → 全部 403（配方是配置类，apply 也会批量写变量）',
  opRecipeSave.status === 403 && opRecipeApply.status === 403 && opRecipeDel.status === 403,
  JSON.stringify({ save: opRecipeSave.status, apply: opRecipeApply.status, del: opRecipeDel.status }));
await admin('/api/recipes', { method: 'POST', body: { action: 'delete', name: 'R_shift' } });   // 收尾
const opTokenConn = wsConnect(PORT, { token: opToken });
await opTokenConn.ready;
await opTokenConn.frame('hello', 8000);
const opTokenSess = await opTokenConn.session();
ok('operator 用 token 重连 → session 仍是 operator（会话落盘带角色）',
  opTokenSess?.logged_in === true && opTokenSess.role === 'operator' && opTokenSess.user === 'op1',
  JSON.stringify(opTokenSess));
opTokenConn.close();

/* ══════ 10. 老 viewer 账号（老数据兼容）：仍能登录、且只读 ══════ */
const vwConn = await openConn();
const vwLogin = await loginUser(vwConn.c, 'vwOld', LEGACY_PWD);
ok('老 viewer 账号仍能登录（users.json 里的老值不会因为"取消 viewer"就登不上）',
  vwLogin?.ok === true && vwLogin.role === 'viewer',
  JSON.stringify({ ok: vwLogin?.ok, role: vwLogin?.role }));
const vw = apiOf(vwConn.c);
const vwHotWrite = await vwConn.c.ask({ t: 'write', name: 'vwVar', value: 1 });
const vwApiWrite = await vw('/api/vars', { method: 'POST', body: { name: 'vwVar', value: 2 } });
ok('老 viewer 写变量（热路径 + /api/vars POST）→ 都拒（只读）',
  vwHotWrite?.ok === false && /观察员/.test(String(vwHotWrite?.error || '')) && vwApiWrite.status === 403,
  JSON.stringify({ hot: vwHotWrite?.ok, api: vwApiWrite.status }));
const vwRead = await vw('/api/vars');
ok('老 viewer 读变量 → 放行', vwRead.status === 200, JSON.stringify({ status: vwRead.status }));
const vwUsers = await vw('/api/users');
ok('老 viewer 看用户管理 → 403', vwUsers.status === 403, JSON.stringify({ status: vwUsers.status }));
ok('老 viewer 仍在管理员看到的用户列表里（role=viewer；老数据不会丢）',
  (lst.users.find(u => u.name === 'vwOld') || {}).role === 'viewer',
  JSON.stringify(lst.users.find(u => u.name === 'vwOld') || null));

/* ══════ 11. 管理员改角色 / 改密码 / 禁用启用 ══════ */
const setViewer = await usersOf(admin, { action: 'role', user: 'op1', role: 'viewer' });
ok('把账号改成 viewer → 400（观察员已取消，改角色也只认 admin/operator）',
  setViewer.status === 400 && /admin/.test(String(setViewer.error || ''))
  && /operator/.test(String(setViewer.error || '')),
  JSON.stringify({ status: setViewer.status, error: setViewer.error }));
const setOperator = await usersOf(admin, { action: 'role', user: 'op1', role: 'operator' });
ok('把账号改成 operator → 成功', setOperator.ok === true && setOperator.user?.role === 'operator',
  JSON.stringify(setOperator.user));
const setPwd = await usersOf(admin, { action: 'passwd', user: 'op1', password: 'newpass1' });
ok('管理员改 op1 密码：接口 ok', setPwd.ok === true && setPwd.user?.name === 'op1', JSON.stringify(setPwd.user));
const opNewConn = await openConn();
const opNewLogin = await loginUser(opNewConn.c, 'op1', 'newpass1');
ok('op1 用新密码登录成功', opNewLogin?.ok === true && opNewLogin.role === 'operator',
  JSON.stringify({ ok: opNewLogin?.ok, role: opNewLogin?.role }));
opNewConn.c.close();
const disableVw = await usersOf(admin, { action: 'enable', user: 'vwOld', enabled: false });
const disabledList = await listUsers(admin);
ok('管理员禁用老 viewer：enabled=false（用户列表里能看到）',
  disableVw.ok === true && disableVw.user?.enabled === false
  && (disabledList.users.find(u => u.name === 'vwOld') || {}).enabled === false,
  JSON.stringify(disableVw.user));
await usersOf(admin, { action: 'enable', user: 'vwOld', enabled: true });
const vwAgainConn = await openConn();
const vwAgain = await loginUser(vwAgainConn.c, 'vwOld', LEGACY_PWD);
ok('重新启用后老 viewer 能再登录', vwAgain?.ok === true && vwAgain.role === 'viewer',
  JSON.stringify({ ok: vwAgain?.ok }));
vwAgainConn.c.close();

/* ══════ 12. 落盘：users.json 结构 / 不含明文密码 / 没有 .tmp 残留 / 会话带角色 ══════ */
const uf = path.join(DATA, 'users.json');
let uj = null;
try { uj = JSON.parse(fs.readFileSync(uf, 'utf8')); } catch { /* 下面断言会报 */ }
ok('账号表落在 <数据目录>/users.json，结构是 {users:{用户名:{pwd,role,enabled,created}}}',
  !!uj && !!uj.users && !!uj.users.op1 && typeof uj.users.op1.pwd === 'string'
  && uj.users.op1.role === 'operator' && uj.users.op1.enabled === true
  && typeof uj.users.op1.created === 'string' && uj.users.vwOld.role === 'viewer',
  JSON.stringify(uj && Object.keys(uj)));
const rawUsers = fs.existsSync(uf) ? fs.readFileSync(uf, 'utf8') : '';
ok('账号表里**没有明文密码**（op1234 / newpass1 / vw1234 一个都搜不到）',
  rawUsers.length > 0 && !rawUsers.includes('op1234') && !rawUsers.includes('newpass1')
  && !rawUsers.includes('vw1234'), `文件 ${rawUsers.length} 字节`);
ok('pwd 是「盐$哈希」两段（盐每账号随机，不是明文/固定串）',
  /^[0-9a-f]{32}\$[0-9a-f]{64}$/.test(String(uj?.users?.op1?.pwd || '')),
  String(uj?.users?.op1?.pwd || '').slice(0, 12) + '…');
ok('原子写没留 .tmp 残留', !fs.existsSync(uf + '.tmp'));
let sj = {};
try { sj = JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8')); } catch { /* 忽略 */ }
const sessVals = Object.values(sj || {});
ok('sessions.json 里每条会话是 {exp,user,role}（重启/重连后角色不会丢）',
  sessVals.length > 0 && sessVals.every(v => v && typeof v === 'object')
  && sessVals.some(v => v.role === 'operator' && v.user === 'op1')
  && sessVals.some(v => v.role === 'admin')
  && sessVals.some(v => v.role === 'viewer' && v.user === 'vwOld'),
  JSON.stringify(sessVals.map(v => ({ u: v.user, r: v.role }))));

/* ══════ 13. 最后一个管理员不许删/降/禁（账号体系不能自己锁死）══════ */
const addAdm3 = await usersOf(admin, { action: 'add', user: 'adm3', password: 'adm3123', role: 'admin' });
const delAdm2 = await usersOf(admin, { action: 'delete', user: 'adm2' });
ok('有两个 admin 时能删掉其中一个', addAdm3.ok === true && delAdm2.ok === true && delAdm2.deleted === true,
  JSON.stringify({ add: addAdm3.ok, del: delAdm2 }));
const delLastAdm = await usersOf(admin, { action: 'delete', user: 'adm3' });
ok('删最后一个管理员 → 400（防止没人能管理账号）',
  delLastAdm.status === 400 && /最后一个管理员/.test(String(delLastAdm.error || '')),
  JSON.stringify({ status: delLastAdm.status, error: delLastAdm.error }));
const demoteLastAdm = await usersOf(admin, { action: 'role', user: 'adm3', role: 'viewer' });
const disableLastAdm = await usersOf(admin, { action: 'enable', user: 'adm3', enabled: false });
ok('把最后一个管理员降级/禁用 → 也拒（同一个保护）',
  demoteLastAdm.status === 400 && disableLastAdm.status === 400,
  JSON.stringify({ role: demoteLastAdm.status, disable: disableLastAdm.status }));
const delGhost = await usersOf(admin, { action: 'delete', user: 'no_such_user' });
ok('删不存在的账号 → 幂等 deleted=false（不报 500）',
  delGhost.status === 200 && delGhost.ok === true && delGhost.deleted === false,
  JSON.stringify(delGhost));

/* ══════ 14. 登录失败（放在最后：连错 5 次会触发限流，这套只用到 4 次）══════ */
const fail1 = await loginUser((await openConn()).c, 'op1', 'wrong-pass');
ok('账号密码错 → 登录失败（不区分"账号不存在/密码错"）',
  fail1?.ok === false && /账号或密码/.test(String(fail1?.error || '')), JSON.stringify({ ok: fail1?.ok }));
const fail2 = await loginUser((await openConn()).c, 'op1', 'op1234');   // 已经改成 newpass1 了
ok('旧密码（改过之后）→ 登录失败', fail2?.ok === false, JSON.stringify({ ok: fail2?.ok }));
const fail3 = await loginUser((await openConn()).c, 'nouser', 'whatever');
ok('不存在的账号 → 登录失败', fail3?.ok === false, JSON.stringify({ ok: fail3?.ok }));
await usersOf(admin, { action: 'enable', user: 'vwOld', enabled: false });
const fail4 = await loginUser((await openConn()).c, 'vwOld', LEGACY_PWD);
ok('禁用账号 → 登录失败（禁用后密码对也进不来）', fail4?.ok === false,
  JSON.stringify({ ok: fail4?.ok }));

/* ══════ 收尾 ══════ */
try { adminConn.c.close(); } catch { /* 忽略 */ }
try { opConn.c.close(); } catch { /* 忽略 */ }
try { vwConn.c.close(); } catch { /* 忽略 */ }
try { srv.kill(); } catch { /* 忽略 */ }
await sleep(150);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

const failed = results.filter(r => !r.ok);
console.log(`\n==== 多用户/角色（只留 admin+operator；操作员只能改设备连接）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
