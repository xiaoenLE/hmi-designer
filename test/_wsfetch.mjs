/**
 * _wsfetch.mjs — 回归套件用的「长连接调接口」小工具
 *
 * ★ V2 起后端一条 HTTP 接口都没有了，套件里那些 `fetch(H + '/api/xxx')` 全部落空。
 *   这个文件把"调一个接口"改成长连接上的 {t:'call'}，并且**尽量长得像 fetch**，
 *   这样套件里的断言一行都不用改：
 *
 *     Node 侧：  const api = await wsApi(PORT);   await api('/api/plc', {action:'connect'})
 *     页面侧：  await installPageShim(page);      页面里 fetch('/api/vars') 自动走长连接
 *
 * 页面侧那个 shim 是给"套件在 page.evaluate 里 fetch 后端"用的（很多套件这么写），
 * 装上之后浏览器里的 /api/* 请求也被改道到长连接 —— 于是**一条 HTTP 接口都不会发**，
 * 和真实前端的行为完全一致（这正是 V2 要保证的事）。
 *
 * Node 侧用 Node 自带的 WebSocket（Node 22+ 有全局 WebSocket），不引第三方库。
 */

const RPC_TIMEOUT_MS = 40000;

function wsUrl(port, path = '/api/ws') {
  return `ws://127.0.0.1:${port}${path}`;
}

/**
 * 建一条长连接并返回 `call(path, {method, body})` → ack 对象
 * （{t:'ack', id, ok, status, data}）。
 */
export function wsConnect(port, { token = '' } = {}) {
  const url = wsUrl(port) + (token ? `?token=${encodeURIComponent(token)}` : '');
  const ws = new WebSocket(url);
  let seq = 1;
  const waiting = new Map();      // id → {resolve, timer}
  const queue = [];               // hello / status 那些先攒着，谁要看谁取
  let opened = false;
  let failed = false;
  const openWaiters = [];

  ws.addEventListener('message', ev => {
    let j;
    try { j = JSON.parse(ev.data); } catch { return; }
    if (!j || typeof j !== 'object') return;
    if (j.t === 'ack' || j.t === 'pong') {
      const w = waiting.get(j.id);
      if (w) { waiting.delete(j.id); clearTimeout(w.timer); w.resolve(j); return; }
    }
    queue.push(j);
  });
  ws.addEventListener('open', () => {
    opened = true;
    for (const r of openWaiters.splice(0)) r(true);
  });
  // 连不上（后端还没起来 / 端口不对）时立刻失败，别让套件干等 10 秒
  ws.addEventListener('error', () => {
    failed = true;
    for (const r of openWaiters.splice(0)) r(false);
    for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new Error('长连接出错')); }
    waiting.clear();
  });
  // 连接被关掉（后端重启 / 套件收尾）时，把还在等 ack 的请求放掉 ——
  // 不然它们要白等 40 秒，套件看起来就是"卡住了"
  ws.addEventListener('close', () => {
    failed = true;
    for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new Error('长连接已断开')); }
    waiting.clear();
  });
  const ready = new Promise((resolve, reject) => {
    if (opened) return resolve(true);
    if (failed) return reject(new Error('长连接没连上'));
    openWaiters.push((good) => good ? resolve(true) : reject(new Error('长连接没连上')));
    setTimeout(() => { if (!opened && !failed) reject(new Error('长连接没连上')); }, 10000);
  });

  function send(obj) { ws.send(JSON.stringify(obj)); }

  /** 发一条带 id 的消息并等它的 ack（call / login / logout / session 都走这里） */
  function ask(obj, timeout = RPC_TIMEOUT_MS) {
    return ready.then(() => new Promise((resolve, reject) => {
      const id = seq++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`等 ack 超时：${obj.t}${obj.path ? ' ' + obj.path : ''}`));
      }, timeout);
      // ⚠ reject 也要存进去：连接出错/断开时得把还在等 ack 的那些请求**放掉**，
      //   不然它们会一直悬着（套件表现为"卡住"或拿到 undefined 再炸）。
      waiting.set(id, { resolve, reject, timer });
      send({ ...obj, id });
    }));
  }

  function call(path, { method = 'POST', body = null, timeout = RPC_TIMEOUT_MS } = {}) {
    return ask({ t: 'call', path, method, body }, timeout);
  }

  /** ★ V2 的登录是**长连接上的原生消息**（不再有 POST /api/login）：
   *  在这条连接上登录 → 这条连接就是管理员；ack 里还带 token（可存起来下次 ?token= 秒接上）。*/
  const login = (password) => ask({ t: 'login', password }, 15000);
  const logout = (token) => ask({ t: 'logout', token }, 15000);
  const session = () => ask({ t: 'session' }, 15000);

  /** 等一条服务端主动发的帧（hello / status） */
  async function frame(t, timeout = 6000) {
    const end = Date.now() + timeout;
    for (;;) {
      const i = queue.findIndex(j => j.t === t);
      if (i >= 0) return queue.splice(i, 1)[0];
      if (Date.now() > end) return null;
      await new Promise(r => setTimeout(r, 30));
    }
  }

  return {
    call, frame, ready, send, ask, login, logout, session,
    isDead: () => failed || !opened,
    raw: ws,
    close: () => { try { ws.close(); } catch { /* 忽略 */ } },
  };
}

/**
 * 套件在 Node 侧调接口用这个：返回一个 **像 fetch 一样**的 async 函数
 *   const api = await wsApi(PORT);
 *   const j   = await api('/api/plc');                        // 直接给 JSON（和以前一样）
 *   const r   = await api('/api/vars', { method: 'POST', body: {...} });
 *   r.ok / r.status / await r.json()                          // 也长得像 Response
 *
 * ⚠ 两种用法都能满足：返回值既是解析好的 JSON，又带 oks/status/json()/text()。
 */
export async function wsApi(port, opts = {}) {
  const conn = await (async () => { const c = wsConnect(port, opts); await c.ready; return c; })();
  // opts.password：建好连接就顺手在**这条连接上**登录成管理员（V2 的会话是跟着连接走的）
  if (opts.password) {
    const a = await conn.login(opts.password);
    conn.token = (a && a.token) || '';
  }
  const fn = async (path, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    let body = init.body;
    if (typeof body === 'string' && body) { try { body = JSON.parse(body); } catch { body = null; } }
    const j = await conn.call(path, { method, body });
    const data = (j && j.data) || {};
    const status = (j && j.status) || 0;
    const okFlag = !!(j && j.ok);
    const txt = JSON.stringify(data);
    // 直接返回 data（老套件都是 `(await api(x)).status` 这种取字段的写法），
    // 同时把 fetch 那套挂上去，两种写法都认。
    const out = (data && typeof data === 'object') ? data : { value: data };
    // ⚠ 只在 data **没有**这个键时才补：后端的 payload 自己就带 `ok`（比如
    //   /api/scriptlog 的 `{"ok":true,"written":2}`）。以前这里无条件 defineProperty，
    //   把人家那个**可枚举**的 ok 改成了不可枚举 → JSON.stringify 一过就没了 →
    //   套件里 `r.ok` 变 undefined，报出一堆"看起来对但就是不过"的断言。
    const extra = { ok: okFlag, status, json: async () => data, text: async () => txt };
    for (const k of Object.keys(extra)) {
      if (!(k in out)) Object.defineProperty(out, k, { value: extra[k], enumerable: false });
    }
    return out;
  };
  fn.conn = conn;
  fn.token = conn.token || '';
  fn.login = (pw) => conn.login(pw).then(a => { conn.token = (a && a.token) || ''; fn.token = conn.token; return a; });
  fn.close = () => conn.close();
  return fn;
}

/**
 * 页面侧：把浏览器里的 `/api/*` fetch 改道到长连接。
 *
 * 装上之后，套件里 `page.evaluate(() => fetch('/api/vars'))` 这类写法照样能用，
 * 而且**真的走长连接**（没有 HTTP 接口可打）。非 /api/* 的 fetch（静态文件）照旧。
 */
export async function installPageShim(page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      let u = null;
      try { u = new URL(url, location.origin); } catch { /* 交给原生 */ }
      if (!u || u.origin !== location.origin || !u.pathname.startsWith('/api/')) {
        return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
      }
      const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
      let body = null;
      if (init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }
      const json = (obj, status) => new Response(JSON.stringify(obj), {
        status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
      try {
        const { backend } = await import('/js/api/backend.js');
        // ★ 登录/注销/会话在 2.0 是**长连接上的原生消息**，不是 /api/* 接口。
        //   套件里 `page.evaluate(() => fetch('/api/session'))` 这种写法（好几套都有）
        //   得在这儿接住，否则会拿到"后端不认识这个接口：/api/session"。
        if (u.pathname === '/api/session') {
          const s = await backend.session();
          return json({ ok: true, auth_enabled: !!s.auth_enabled, logged_in: !!s.logged_in }, 200);
        }
        if (u.pathname === '/api/login') {
          const a = await backend.login((body && body.password) || '');
          return a && a.ok === false
            ? json({ ok: false, error: '密码不对' }, 401)
            : json({ ok: true, logged_in: true }, 200);
        }
        if (u.pathname === '/api/logout') {
          await backend.logout();
          return json({ ok: true }, 200);
        }
        const d = await backend.rpc(u.pathname + u.search, { method, body, timeout: 40000 });
        return json(d, 200);
      } catch (e) {
        // 把后端的 401 / 400 语义原样还原（套件里有断言 need_login / 错误文案的）
        const st = (e && e.status) ? e.status : 503;
        return json({ ok: false, error: (e && e.message) || String(e), need_login: !!(e && e.needLogin) }, st);
      }
    };
  });
}

/**
 * ★ 最省事的一条：**把 Node 里发往后端的 `/api/*` fetch 改道到长连接**。
 *
 * 为什么这么做：套件里 Node 侧那一堆 `api()` / `post()` 辅助函数、以及零散的
 * `fetch(H + '/api/...')`，形态各不相同（有的返回 JSON、有的返回 Response、
 * 有的还带 status）。逐个改写既费事又容易改错。既然它们最后都是"打后端的一个接口"，
 * 那就统一在 fetch 这一层改道 —— 每个套件只要在拿到端口之后加一行：
 *
 *     installNodeFetchPatch(PORT, { password: PW });
 *
 * ⚠ **只改发往后端那个端口的 /api/***：
 *   套件还会去打**模拟器**（plc_sim / opcua_sim 的 /api/state、/api/write），
 *   那些是真的 HTTP 服务，必须原样放行 —— 不加端口限制就会把它们也劫持掉。
 *
 * ★ 登录也被一并接上了（V2 里 login/logout/session 是长连接上的原生消息）：
 *   套件原来那套「POST /api/login 拿 cookie → 之后带着 Cookie 打接口」的写法**一行都不用改**：
 *     · `/api/login`    → 在**管理员那条连接**上登录，返回带 `set-cookie` 的响应（token 就是"cookie"）
 *     · 请求带 Cookie   → 走管理员连接（所以 asAdmin(cookie) 自动就是管理员）
 *     · 不带 Cookie     → 走访客连接（未登录，闸门那几条断言照样能验）
 *     · `/api/logout`   → 长连接上的 logout
 *     · `/api/session`  → 长连接上的 session
 *   于是"访客"和"管理员"各自有自己的连接，互不串味。
 */
export function installNodeFetchPatch(port, opts = {}) {
  // 传 '8866' / 'http://127.0.0.1:8866' / 'http://127.0.0.1:8866/' 都认（套件里三种写法都有）
  const s = String(port).trim().replace(/\/+$/, '');
  const m = s.match(/:(\d+)$/) || s.match(/^(\d+)$/);
  port = m ? m[1] : s;
  if (globalThis.__wsFetchPatched === port) return globalThis.__wsFetchPatched;
  const native = globalThis.fetch.bind(globalThis);
  const adminPw = opts.password || opts.adminPassword || '';
  const json = (obj, status, extra = {}) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });

  let guest = null, admin = null, adminToken = '', adminPwUsed = '';
  /** 建一条（访客/管理员）长连接 —— 这里**不用 wsApi 那层包装**：
   *  我们要的是"ack 里的 data 原样变成响应体"，包装层会往上挂 ok/status 之类的东西。 */
  const conn = async (token = '', pw = '') => {
    const c = wsConnect(port, token ? { token } : opts);
    await c.ready;
    if (pw) {
      const a = await c.login(pw);
      if (!a || a.ok === false) throw new Error('密码不对');
      c.token = (a && a.token) || '';
    } else if (token) {
      c.token = token;
    }
    return c;
  };
  const getGuest = async () => { if (!guest) guest = await conn(); return guest; };
  /** 管理员那条连接按需建：**优先用 token 重连**（会话落在 sessions.json 里，后端重启也还在），
   *  没有 token 就用密码登一次。密码/令牌都记着，连接断了（后端被重启）能自己接回来。 */
  const getAdmin = async (pw) => {
    if (pw) adminPwUsed = pw;
    if (!admin) admin = await conn(adminToken, adminPwUsed || adminPw);
    adminToken = admin.token || adminToken;
    return admin;
  };

  const raw = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    // 认两种：带端口的绝对地址、以及套件里偶尔直接写的 '/api/xxx'（Node 里那只能是后端）
    if (!url.startsWith(`http://127.0.0.1:${port}/api/`) && !url.startsWith('/api/')) return null;
    const u = new URL(url, `http://127.0.0.1:${port}`);
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    const hdr = init.headers || {};
    const cookie = hdr.Cookie || hdr.cookie
      || (typeof hdr.get === 'function' ? hdr.get('cookie') : '') || '';
    let body = init.body;
    if (typeof body === 'string' && body) { try { body = JSON.parse(body); } catch { body = null; } }
    return { path: u.pathname + u.search, method, body, cookie: String(cookie || '') };
  };

  globalThis.fetch = async (input, init = {}) => {
    const r = await raw(input, init);
    if (!r) return native(input, init);
    const { path, method, body, cookie } = r;
    const clean = path.split('?')[0];
    try {
      // 登录：走管理员连接，把 token 当 cookie 发回去（套件只关心"有个 cookie 能用"）
      if (clean === '/api/login') {
        const pw = (body && body.password) || adminPw;
        const c = await getAdmin(pw);
        if (!c.token) {
          const j = await c.login(pw);
          if (j && j.ok === false) return json({ ok: false, error: '密码不对' }, 401);
          c.token = (j && j.token) || '';
          adminToken = c.token || adminToken;
        }
        return json({ ok: true, logged_in: true },
          200, { 'set-cookie': `hmi_session=${c.token || 'ws'}; Path=/; Max-Age=43200` });
      }
      if (clean === '/api/logout') {
        const c = await getAdmin();
        await c.logout(c.token);
        adminToken = '';
        return json({ ok: true }, 200);
      }
      if (clean === '/api/session') {
        const c = cookie ? await getAdmin() : await getGuest();
        const j = await c.session();
        return json({ ok: true, auth_enabled: !!(j && j.auth_enabled), logged_in: !!(j && j.logged_in) }, 200);
      }
      const c = cookie ? await getAdmin() : await getGuest();
      let j;
      try {
        j = await c.call(path, { method, body });
      } catch (e) {
        // ★ 后端被套件**重启**过（verify-retain / verify-update 这类），这条连接已经死了；
        //   1.x 的 HTTP 请求无所谓，长连接就得重连一次再打 —— 不然后面全是一串"等 ack 超时"。
        if (!c.isDead()) throw e;
        if (cookie) admin = null; else guest = null;
        const c2 = cookie ? await getAdmin() : await getGuest();
        j = await c2.call(path, { method, body });
      }
      // ★ 响应体 = ack 里的 data **原样**（后端 payload 里那个 ok 也在）——
      //   套件既有 `(await fetch(...)).json()` 的用法，也有直接看 `.status` 的，
      //   data 里少一个键就会冒出一堆"看着对却不过"的断言。
      return json((j && j.data) || {}, (j && j.status) || 200);
    } catch (e) {
      return json({ ok: false, error: (e && e.message) || String(e), need_login: !!(e && e.needLogin) }, 503);
    }
  };
  globalThis.__wsFetchPatched = port;
  return port;
}

/** 关掉改道并恢复原生 fetch（套件收尾用；不调也行，进程就退了） */
export async function uninstallNodeFetchPatch() {
  if (globalThis.__wsFetchPatched) {
    globalThis.fetch = globalThis.__fetchNative || globalThis.fetch;
    globalThis.__wsFetchPatched = null;
  }
}

/**
 * ★ `POST /api/poll` 的替代品（V2 把「我在看运行画面」的登记**绑在长连接上**了）。
 *
 * 1.x 是"发一个 client id 去登记、再每 10 秒心跳续命"；2.0 是**接进来就算登记、
 * 断开自动注销**（后端每秒给连着的那几条续命）。所以：
 *
 *   wsPoll(port, { always: true|false })   全局开关「编辑态也一直采设备」，当场生效
 *   wsPoll(port, { on: true })             开一条连接**登记**成"在看运行画面"（保持打开）
 *   wsPoll(port, { on: false })            关掉那条连接 = 注销（没人看了）
 *
 * 返回 poll_gate 的状态（`{paused, running_clients, always}`）。
 */
const _viewers = new Map();      // port → 那条"在看运行画面"的连接

export async function wsPoll(port, { on, always } = {}) {
  const key = String(port);
  let c = _viewers.get(key);
  if (on === false && !c) {
    // 没开过也算"没人看"：随便开一条问一下状态就走
    const t = wsConnect(port);
    await t.ready;
    const j = await t.ask({ t: 'poll', on: false });
    t.close();
    return (j && j.data) || j || {};
  }
  if (!c) {
    c = wsConnect(port);
    await c.ready;
    _viewers.set(key, c);
  }
  const msg = {};
  if (on !== undefined) msg.on = !!on;
  if (always !== undefined) msg.always = !!always;
  const j = await c.ask({ t: 'poll', ...msg });
  if (on === false) {
    c.close();
    _viewers.delete(key);
  }
  return Object.assign({}, (j && j.data) || {}, j || {});
}

/** 套件用来"等后端起来"：V2 没有 /api/health，改成等长连接握手成功 */export async function waitBackend(port, tries = 60, gapMs = 300) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = wsConnect(port);
      await c.ready;
      c.close();
      return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, gapMs));
  }
  return false;
}

/**
 * ★ `/api/health` 的替代品：**连上长连接读 hello**。
 *
 * 以前套件用 `api('/api/health')` 读 j.plc / j.version / j.build / j.opcua，
 * hello 帧里这些字段**一个不少**（见 server/core/wsbridge.py 的 _ws_hello）——
 * 所以替换是等价的，只是走的通道变了。
 *
 * ⚠ **连不上就抛错**（不是返回 null）：套件里那些
 * `for (...) { try { await wsHealth(P) } catch { 再等 } }` 的写法和 fetch 一样靠异常判断
 * "后端还没起来"。返回 null 的话 `up = true` 会立刻成立，探活等于没做。
 * 参数可以是端口号，也可以是 `http://127.0.0.1:8866` 这样的地址（套件里两种都有）。
 */
export async function wsHealth(port) {
  const s = String(port).trim().replace(/\/+$/, '');
  const m = s.match(/:(\d+)$/) || s.match(/^(\d+)$/);
  const p = m ? m[1] : s;
  const c = wsConnect(p);
  try {
    await c.ready;
    const h = await c.frame('hello', 6000);
    if (!h) throw new Error('连上了但没等到 hello');
    return h;
  } finally {
    c.close();
  }
}
