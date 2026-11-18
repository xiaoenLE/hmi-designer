// verify-link-drop.mjs — **设备断开之后立刻停止下发** + 不再弹一串「下发失败」+ 运行态左下角提示
//
// 现场报的两件事（原话）：
//   ① 「当在连接 PLC 模式时，不能自动切到使用内部变量模式触发自己去 PLC 里面配置当内部变量使用，
//       然后再运行中左下角要有提示。然后没有配置地址的都是内部变量，不进行 TCP 或者 OPC UA 变量下发的。」
//   ② 「当断开连接后，应该就不用触发下发指令了，现在是断开时，前面数据还在下发，
//       如果变量很多，没有回弹出全部下面失败的命令才停。」
//
// 这两句各自对应下面几节：
//   1. **PLC 模式下不许退化成"内部变量/仿真"模式**（设备连不上也一样）——
//      `hmi.sim()` 必须是 false，仿真脚本不许抢着往 PLC 变量上写，左下角提示必须写「PLC」。
//      对照组：内存模拟下 `hmi.sim()` 仍然为 true（仿真脚本照跑，功能没被砍掉）。
//   2. **设备断开 → 立刻停止下发**：断开之后新的一笔写都不许再发出去，界面也不再一条条弹失败。
//   3. **地址留空 = 内部变量 → 一个字节都不进设备**（Modbus TCP / OPC UA 都不发），
//      同时左下角提示把"有几个内部变量"报出来。
//
// 套件自己起后端 + 自己起模拟 PLC（端口现取现用），不碰现场数据。
// 用法：node test/verify-link-drop.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = process.env.HMI_PY || 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SIM_MB = await freePort();
const SIM_WEB = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-drop-'));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_POLL_ALWAYS: '1' } });
const api = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ok: r.ok, body: await r.json().catch(() => null) };
};
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(300); try { up = (await api('/api/health')).ok; } catch { /* 等 */ } }
ok('后端起来了（隔离数据目录）', up, `port=${PORT}`);

/* ── 数"真的发出去的写"：HTTP 的 POST /api/vars + 长连接上的 write 帧（两条传输一起数）──
   ⚠ 只数 HTTP 会永远数到 0（稳态下写走长连接），断言就成了"假的通过"。 */
let writeReqs = [];
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
page.on('request', r => {
  if (r.method() === 'POST' && r.url().endsWith('/api/vars')) {
    const b = (() => { try { return r.postDataJSON(); } catch { return null; } })();
    writeReqs.push({ name: b?.name || '?', at: Date.now() });
  }
});
await page.addInitScript(() => {
  window.__wsWrites = [];        // 长连接发出去的 write 帧
  window.__writeEvents = [];     // 后端回来的下发结果（成败都要，用来看"弹了几条失败"）
  window.__barShown = 0;         // 「下发失败」提示条**被挂出来过几次**（挂一次算一次）
  setInterval(async () => {
    try {
      const { backend } = await import('/js/api/backend.js');
      const { bus } = await import('/js/core/eventBus.js');
      if (!window.__evHooked) {
        window.__evHooked = true;
        bus.on('vars:write', ev => window.__writeEvents.push({
          name: ev.name, ok: ev.ok, kind: ev.kind || '', message: ev.message || '', at: Date.now(),
        }));
        const bar = document.getElementById('rtWriteAlarm');
        if (bar) {
          let wasHidden = bar.classList.contains('hidden');
          new MutationObserver(() => {
            const nowHidden = bar.classList.contains('hidden');
            if (wasHidden && !nowHidden) window.__barShown++;   // 从"藏着"变成"挂出来" = 弹了一次
            wasHidden = nowHidden;
          }).observe(bar, { attributes: true, attributeFilter: ['class'] });
        }
      }
      const ch = backend._channel;
      if (!ch || ch.__writesHooked) return;
      ch.__writesHooked = true;
      const real = ch.send.bind(ch);
      ch.send = (o) => {
        if (o && o.t === 'write' && o.name) window.__wsWrites.push({ name: o.name, at: Date.now() });
        return real(o);
      };
    } catch { /* 页面还没准备好 */ }
  }, 250);
});
/** 两条传输合起来的写记录（带时刻，用来判断"断开之后还有没有在发"） */
const allWrites = async () => {
  const ws = await page.evaluate(() => (window.__wsWrites || []).slice()).catch(() => []);
  return [...writeReqs, ...ws];
};
const writeEvents = async () => page.evaluate(() => (window.__writeEvents || []).slice()).catch(() => []);
const clearWrites = async () => {
  writeReqs = [];
  await page.evaluate(() => {
    window.__wsWrites = []; window.__writeEvents = []; window.__barShown = 0;
  }).catch(() => {});
};
const barShown = async () => page.evaluate(() => window.__barShown || 0).catch(() => 0);

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, { timeout: 15000 });
await sleep(400);

/* 变量表：10 个有地址的 PLC 变量（%MW100…%MW109）+ 1 个地址留空的内部变量。
   再挂一条**仿真脚本**：只在 hmi.sim()（内部仿真）时写 plcVar —— 用来验"接 PLC 模式
   下仿真脚本不许抢着写"（真实现场就是这么写的，见演示工程那段产线仿真）。 */
await page.evaluate(async () => {
  const pr = (await import('/js/core/project.js')).project;
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  pr.data.variables.length = 0;
  for (let i = 0; i < 10; i++) {
    pr.data.variables.push({ name: `mw${i}`, type: 'int', address: `%MW${100 + i}`, value: 0, len: 0 });
  }
  pr.data.variables.push({ name: 'innerVar', type: 'real', address: '', value: 0, len: 0 });
  pr.data.scripts.length = 0;
  pr.data.scripts.push({
    id: 'sc_sim', name: '仿真脚本', enabled: true, trig: 'cycle', ms: 50,
    variable: '', op: '==', value: 1,
    code: "if (hmi.sim()) { hmi.set('mw0', 999); }",
  });
  pr.commit('链路断开测试用工程');
  vs.resetFrom(pr.variables());
  await vs.__noop;
});
await sleep(300);

const st = () => page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  const bk = (await import('/js/api/backend.js')).backend;
  const m = await import('/js/runtime/runtime.js');
  return {
    link: { ...bk.plcLink }, readOnce: vs._readOnce === true,
    mw0: vs.get('mw0'), innerVar: vs.get('innerVar'),
    sim: window.__hmiRuntime?.isSim ? window.__hmiRuntime.isSim() : null,
    running: m.isRunning(),
    tip: document.getElementById('rtInternalTip')?.textContent || '',
    tipHidden: document.getElementById('rtInternalTip')?.classList.contains('hidden') !== false,
    tipInfo: document.getElementById('rtInternalTip')?.classList.contains('info') === true,
    writeBar: {
      hidden: document.getElementById('rtWriteAlarm')?.classList.contains('hidden') !== false,
      text: document.getElementById('rtWriteAlarmText')?.textContent || '',
    },
  };
});

const DEAD_PORT = await freePort();          // 没人听的端口 = "接了个 PLC 但连不上"

/* ══════ 1. PLC 模式（设备连不上）下不许退化成"内部变量/仿真"模式 ══════ */
{
  await api('/api/plc', { action: 'connect', ip: '127.0.0.1', port: DEAD_PORT, unit: 1, poll_ms: 200, word_order: 'cdab' });
  await sleep(1000);
  await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).enterRun(); });
  await sleep(1800);                        // 跑几拍脚本，给"退化"留足机会
  const s = await st();
  const w = await allWrites();
  ok('（前提）后端在 PLC 模式但连不上', s.link.mode === 'plc' && s.link.online === false, JSON.stringify(s.link));
  ok('★ 运行态：hmi.sim() 为 false（接了 PLC 就不算"内部仿真"，掉线期间也不是）',
    s.sim === false, `sim=${s.sim}`);
  ok('★ 仿真脚本**没有**抢着写 PLC 变量（mw0 没被写成 999）', s.mw0 !== 999, String(s.mw0));
  ok('★ 而且一笔写请求都没发出去', !w.some(x => x.name === 'mw0'), JSON.stringify(w.map(x => x.name).slice(0, 6)));
  ok('★ 左下角提示写的是 PLC（**不是**「内部变量运行中」），且常显',
    !s.tipHidden && /PLC/.test(s.tip) && !/内部变量运行中/.test(s.tip), JSON.stringify({ tip: s.tip, hidden: s.tipHidden }));
  await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).exitRun(); });
  await sleep(300);
}

/* ══════ 2. 对照组：内存模拟下 hmi.sim() 仍然为真（仿真脚本照跑）══════ */
{
  await api('/api/plc', { action: 'disconnect' });
  await sleep(400);
  await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).enterRun(); });
  await sleep(1500);
  const s = await st();
  ok('对照组：内存模拟下 hmi.sim() 为 true（没接设备时仿真脚本照跑）', s.sim === true, `sim=${s.sim}`);
  ok('对照组：仿真脚本确实写进去了（mw0 = 999）', s.mw0 === 999, String(s.mw0));
  ok('对照组：左下角提示是「内部变量运行中」，并报出内部变量个数',
    !s.tipHidden && /内部变量运行中/.test(s.tip) && /内部变量 1 个/.test(s.tip), s.tip);
  await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).exitRun(); });
  await sleep(300);
}

/* ══════ 3. 接真设备（模拟 PLC）→ 内部变量一个字节都不进设备 ══════ */
const sim = spawn(PY, ['server/plc_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore' });
const simWrite = (addr, value) => fetch(`http://127.0.0.1:${SIM_WEB}/api/write`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'w', addr, value }),
}).then(r => r.json()).catch(() => null);
const simState = () => fetch(`http://127.0.0.1:${SIM_WEB}/api/state`).then(r => r.json()).catch(() => null);
{
  let simUp = false;
  for (let i = 0; i < 30 && !simUp; i++) {
    await sleep(300);
    try { simUp = (await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`)).ok; } catch { /* 等它起来 */ }
  }
  ok('模拟 PLC 起来了（Modbus 从站 + 网页调试台）', simUp, `mb=${SIM_MB} web=${SIM_WEB}`);

  await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).enterRun(); });
  await sleep(500);
  await api('/api/plc', { action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab' });
  // ⚠ 等条件里必须带 **mode==='plc'**：内存模式的 online 本来就是 true，
  //   只看 online+readOnce 会在"前端还没收到 mode 变了"那一下就跳出循环（量到的还是旧状态）。
  let s = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    s = await st();
    if (s.link.mode === 'plc' && s.link.online && s.readOnce) break;
  }
  await sleep(1200);                     // 给左下角提示留一拍（它跟着状态推送刷新）
  s = await st();
  ok('连上模拟 PLC：链路在线 + 已读到数据', s.link.online === true && s.readOnce === true, JSON.stringify(s.link));
  ok('连上之后左下角提示变成「PLC 变量传输中」', !s.tipHidden && /PLC 变量传输中/.test(s.tip), s.tip);
  ok('★ 连上之后仿真脚本也不再抢写（hmi.sim() 跟着变 false）', s.sim === false, `sim=${s.sim}`);

  // 设备侧先摆一个可辨认的值，记下**本工程用到的那几个寄存器**
  // ⚠ 只比 100..109：模拟 PLC 自己在 %MW110 上跑了一条正弦（见 plc_sim.py 的 STORE.auto），
  //   把整张表拿来比会把它的自由变化算成"我们写进去了"。
  await simWrite(100, 0x0042);
  await sleep(500);
  const usedRegs = (stt) => Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [String(100 + i), stt?.holding?.[String(100 + i)]]));
  const before = usedRegs(await simState());
  const innerVal = 7.25;
  const wrote = await page.evaluate(async (v) => {
    const vs = (await import('/js/runtime/varstore.js')).varStore;
    vs.set('innerVar', v, 'local');
    await new Promise(r => setTimeout(r, 800));
    return { val: vs.get('innerVar'), err: vs.lastWriteError ? { ...vs.lastWriteError } : null };
  }, innerVal);
  await sleep(600);
  const after = usedRegs(await simState());
  ok('★ 内部变量（地址留空）写成功、值也在界面上', wrote.val === innerVal && !wrote.err,
    JSON.stringify(wrote));
  ok('★ 内部变量**没有**动设备：本工程用到的 10 个保持寄存器一个都没变',
    JSON.stringify(before) === JSON.stringify(after),
    JSON.stringify({ before, after }));
  const meta = await api('/api/health');
  ok('（背景）后端在 PLC 模式', meta.body?.plc?.mode === 'plc', JSON.stringify(meta.body?.plc?.mode));

  /* ── 后端自己的计数：内部变量有没有被当成"下发"过 ──
     `plc.writes` 是 **PlcSource.write 真的碰了设备** 才 +1 的计数器（内部变量在它前面就 return 了）。
     这是比"看寄存器快照"更直接的证据：内部变量写得再多，这个数不该动。 */
  const w0 = (await api('/api/health')).body?.plc?.writes ?? 0;
  await page.evaluate(async () => {
    const { varStore } = await import('/js/runtime/varstore.js');
    for (let i = 0; i < 20; i++) varStore.set('innerVar', i + 0.5, 'local');
    await new Promise(r => setTimeout(r, 900));
  });
  const w1 = (await api('/api/health')).body?.plc?.writes ?? 0;
  ok('★★ 内部变量连写 20 次：后端的「下发到设备」计数一次都没涨', w1 === w0,
    `plc.writes ${w0} → ${w1}`);

  /* ── 业务失败（写到只读输入区 %IX）不能被当成"链路失败" ──
     现场踩过：这种错被判成 link → 前端把设备标掉线、顶部挂「PLC 已断开」，
     后面 1.5 秒里的正经写全被挡（而且提示条也变成"设备断了"的口气）。
     现在必须：分类 = 'var'、设备**仍然在线**、后面紧接着的写照发不误。 */
  await page.evaluate(async () => {
    const { project } = await import('/js/core/project.js');
    const { backend } = await import('/js/api/backend.js');
    const { varStore } = await import('/js/runtime/varstore.js');
    if (!project.variables().some(v => v.name === 'roBit')) {
      project.data.variables.push({ name: 'roBit', type: 'bool', address: '%IX0.1', value: false, len: 0 });
      project.commit('加一个只读输入位的变量');
    }
    varStore.resetFrom(project.variables());
    await backend.syncVarTable(project.variables());
  });
  await sleep(600);
  await clearWrites();
  const roRes = await page.evaluate(async () => {
    const { varStore } = await import('/js/runtime/varstore.js');
    const { backend } = await import('/js/api/backend.js');
    varStore.set('roBit', true, 'local');
    await new Promise(r => setTimeout(r, 1200));
    return { err: varStore.lastWriteError ? { ...varStore.lastWriteError } : null, link: { ...backend.plcLink } };
  });
  const afterRo = await st();
  const roWrites = await allWrites();
  ok("★ 写只读输入位（%IX）→ 分类是 'var'（不是 link）",
    roRes.err?.kind === 'var', JSON.stringify(roRes.err));
  ok('★ 这种业务失败**不会**把设备判成掉线（plcLink.online 仍然 true）',
    roRes.link.online === true && afterRo.link.online === true, JSON.stringify(roRes.link));
  ok('★ 它照旧挂一条「下发失败」提示（设备好好的，该让用户看见）',
    afterRo.writeBar.hidden === false && /下发失败/.test(afterRo.writeBar.text || ''),
    JSON.stringify(afterRo.writeBar));
  ok('紧接着的正经写**没有**被冷却期挡住（照发）',
    await (async () => {
      await clearWrites();
      await page.evaluate(async () => {
        const { varStore } = await import('/js/runtime/varstore.js');
        varStore.set('mw1', 4321, 'local');
        await new Promise(r => setTimeout(r, 700));
      });
      const w = await allWrites();
      return w.some(x => x.name === 'mw1');
    })(), JSON.stringify(roWrites.map(x => x.name).slice(0, 8)));
}

/* ══════ 4. 设备断开 → 立刻停止下发、不再弹一串「下发失败」 ══════ */
{
  // 连续快写：模拟"脚本一个周期写一批"（真实现场就是这么写的）
  await page.evaluate(() => {
    window.__burst = { on: true, n: 0 };
    (async () => {
      const { varStore } = await import('/js/runtime/varstore.js');
      while (window.__burst.on) {
        for (let i = 0; i < 10; i++) varStore.set(`mw${i}`, (window.__burst.n + i) % 30000, 'local');
        window.__burst.n++;
        await new Promise(r => setTimeout(r, 50));
      }
    })();
  });
  await sleep(800);
  const beforeDrop = await writeEvents();
  ok('（前提）快写期间确实在下发（设备在线）', beforeDrop.some(e => e.ok), `events=${beforeDrop.length}`);

  // 顺便盯住"在途的设备写"有多少笔 —— 它没有上限的话，设备卡住时会堆成一串各等一个超时
  await page.evaluate(async () => {
    const { varStore } = await import('/js/runtime/varstore.js');
    window.__maxInflight = 0;
    window.__inflightTimer = setInterval(() => {
      if (varStore._devInflight > window.__maxInflight) window.__maxInflight = varStore._devInflight;
    }, 20);
  });

  await clearWrites();
  const dropAt = Date.now();
  sim.kill();                                    // ★ 拔线：设备从这一刻起没了
  await sleep(6000);                             // 让"超时 + 后续每一笔"都有机会暴露
  await page.evaluate(() => { window.__burst.on = false; clearInterval(window.__inflightTimer); });
  await sleep(500);
  const evs = await writeEvents();
  const ws = await allWrites();
  const shown = await barShown();
  const fails = evs.filter(e => e.ok === false);
  const linkFails = fails.filter(e => e.kind === 'link');
  const lateWrites = ws.filter(x => x.at > dropAt + 2500);      // 断开 2.5 秒之后还在发？
  const httpPosts = writeReqs.length;            // 这一段里发出的 **HTTP 写请求**（长连接超时后的回退）
  const maxInflight = await page.evaluate(() => window.__maxInflight || 0);
  const s = await st();

  ok('★ 设备断开之后**不再有新的一笔下发**（断开 2.5 秒后 0 笔）',
    lateWrites.length === 0, JSON.stringify(lateWrites.map(x => x.name).slice(0, 8)));
  ok('★ 失败不再"一个变量弹一条"：失败笔数被压在个位数（旧行为是排几十秒的队、一直弹）',
    fails.length <= 12, `fails=${fails.length} link=${linkFails.length}`);
  // ⚠ 这一条治的是"内存暴涨一下"：长连接**等应答超时**如果被当成"连接断了"而回退 HTTP，
  //   后端每收一个请求就新起一个线程 —— 实测 300 变量 × 50ms 时断开 16 秒冒出 3374 个请求。
  ok('★★ 断开期间**没有 HTTP 回退风暴**（回退一个写 = 后端多一个线程 = 内存暴涨的来源）',
    httpPosts <= 2, `HTTP 写请求 ${httpPosts} 个`);
  ok('★★ 在途的设备写被压在 64 笔以内（不排队各等一个超时）',
    maxInflight > 0 && maxInflight <= 64, `在途峰值 ${maxInflight}`);
  ok('★ 失败**都带上了链路标记**（前端据此当场判掉线、停止继续下发）',
    fails.length > 0 && linkFails.length === fails.length,
    JSON.stringify(fails.map(e => e.kind).slice(0, 8)));
  ok('★ 界面上**一次都没弹**「下发失败」条（设备断了由顶部红条说话，不一条条刷）',
    shown === 0 && s.writeBar.hidden === true,
    JSON.stringify({ 弹出次数: shown, hidden: s.writeBar.hidden, text: s.writeBar.text }));
  ok('前端已经知道设备断了（plcLink.online=false）', s.link.online === false, JSON.stringify(s.link));
  ok('左下角提示跟着变成「PLC 已断开」', !s.tipHidden && /PLC 已断开/.test(s.tip), s.tip);
}

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).exitRun(); }).catch(() => {});
await browser.close();
srv.kill();
try { sim.kill(); } catch { /* 已经杀了 */ }
await api('/api/plc', { action: 'disconnect' }).catch(() => {});
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 断开即停 / 不退化内部变量 / 内部变量不下发设备：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
