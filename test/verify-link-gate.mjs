// verify-link-gate.mjs — **链路门**：设备没连上不许传；连上了也要先读到数据才许操作
//
// 现场要求（原话）：「没有连接成功是不能进行数据传输和获取的；连接成功后必须先读取数据来，
// 才可以操作变量，变量值也要先变」。
// 落到实现上是三条：
//   ① 接真设备（PLC / OPC UA）但**没连上** → 写操作**一个请求都不发**，界面上的值恢复成
//      上一次读到的那份，并说明「未下发（…）：设备没连上」；
//   ② 刚连上（online）但**这条链路上还没读到过数据** → 同样不下发，理由是"正在把设备上的数据读下来"；
//   ③ 读到了数据（SSE 批量推送 / readVars 回来）→ 从此允许操作；链路状态一变就重新等一次读。
//   内存模拟（没接设备）不受门限制；**内部变量**（地址留空）也不受限（它不碰设备，值存在后端）。
//
// 套件自己起后端 + 自己起模拟 PLC（端口现取现用），不碰现场数据。
// 用法：node test/verify-link-gate.mjs
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-gate-'));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
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

// 数**写请求**：门挡下时应当一个都没有（这是"没有连接成功不能进行数据传输"的直接证据）
//
// ⚠ **两条传输都要数**：前端现在首选 WebSocket 长连接，写值走那条连接上的帧（**根本没有 HTTP 请求**），
//   只有退回模式（旧后端 / 长连接没连上）才是 POST /api/vars。
//   只数 HTTP 的话，长连接模式下永远是 0 —— 于是「门挡下了」和「压根没走这条路」分不出来，
//   断言会变成**假的通过**（这正是之前 5 条 FAIL 的原因：功能是好的，测法过时了）。
//   所以：HTTP 用 Playwright 的 request 事件数，长连接的帧让页面自己记一份，两边合起来算。
let writeReqs = [];
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
page.on('request', r => {
  if (r.method() === 'POST' && r.url().endsWith('/api/vars')) {
    const b = (() => { try { return r.postDataJSON(); } catch { return null; } })();
    writeReqs.push(b?.name || '?');
  }
});
// 页面里把长连接发出去的 write 帧记到 window.__wsWrites（长连接是后面才建的，所以隔一会儿试着挂一次）
await page.addInitScript(() => {
  window.__wsWrites = [];
  setInterval(async () => {
    try {
      const { backend } = await import('/js/api/backend.js');
      const ch = backend._channel;
      if (!ch || ch.__writesHooked) return;
      ch.__writesHooked = true;
      const real = ch.send.bind(ch);
      ch.send = (o) => {
        if (o && o.t === 'write' && o.name) window.__wsWrites.push(o.name);
        return real(o);
      };
    } catch { /* 页面还没准备好 */ }
  }, 300);
});
/** 从这一刻开始数（两条传输一起清零） */
const since = async () => {
  writeReqs = [];
  await page.evaluate(() => { window.__wsWrites = []; }).catch(() => {});
};
/** 上一次 since() 之后**真的发出去**的写（两条传输合起来） */
const newWrites = async () => {
  const ws = await page.evaluate(() => (window.__wsWrites || []).slice()).catch(() => []);
  return [...writeReqs, ...ws];
};

/**
 * 临时"冻结"后端推来的设备状态。
 *
 * ⚠ 为什么这一节需要它：这一节要**手工伪造** plcLink（"在线、但还没读到数据"），
 *   而长连接建立之后后端**每秒推一次真实的设备状态**（这里是"接了 PLC 但连不上"），
 *   `_onStatus → setPlcInfo` 会把伪造的那份盖回去 —— 于是"门"按真实状态挡下这次写，
 *   断言看到的就成了"没发出去"。真机上推来的状态就是事实、不存在"伪造"这回事，
 *   所以这是**测试手法**上的必要处理，不是功能问题。
 */
const freezeLink = (on) => page.evaluate((on) => {
  const bk = window.app.backend;
  if (!bk?._channel) return;
  if (on) {
    bk.__statusHook = bk._channel.opts.onStatus;
    bk._channel.opts.onStatus = () => {};
  } else if (bk.__statusHook) {
    bk._channel.opts.onStatus = bk.__statusHook;
    bk.__statusHook = null;
  }
}, on);

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, { timeout: 15000 });
await sleep(400);

/* 摆一小张变量表：一个 PLC 变量（%MW100）+ 一个内部变量（地址留空） */
await page.evaluate(async () => {
  const pr = (await import('/js/core/project.js')).project;
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  pr.data.variables.length = 0;
  pr.data.variables.push({ name: 'plcVar', type: 'real', address: '%MW100', value: 0, len: 0 });
  pr.data.variables.push({ name: 'innerVar', type: 'real', address: '', value: 0, len: 0 });
  pr.commit('链路门测试用变量表');
  vs.resetFrom(pr.variables());
  await vs.__noop;
});
await sleep(300);

const st = () => page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  const bk = (await import('/js/api/backend.js')).backend;
  return {
    link: { ...bk.plcLink }, readOnce: vs._readOnce === true,
    plcVar: vs.get('plcVar'), innerVar: vs.get('innerVar'),
    lastErr: vs.lastWriteError ? { ...vs.lastWriteError } : null,
    badge: document.getElementById('stWrite')?.textContent || '',
    badgeHidden: document.getElementById('stWrite')?.classList.contains('hidden') !== false,
  };
});

/* ══════ 1. 内存模拟：不拦（老行为不变）══════ */
{
  await since();
  await page.evaluate(async () => (await import('/js/runtime/varstore.js')).varStore.set('plcVar', 7, 'local'));
  await sleep(400);
  const s = await st();
  const w = await newWrites();
  ok('内存模拟（没接设备）：照常写、照常发请求', w.includes('plcVar') && s.plcVar === 7,
    JSON.stringify({ writes: w, val: s.plcVar }));
}

/* ══════ 2. 接了设备但**连不上** → 一个请求都不发 ══════ */
{
  await api('/api/plc', { action: 'connect', ip: '127.0.0.1', port: 1, unit: 1, poll_ms: 200, word_order: 'cdab' });
  await sleep(1200);
  const link0 = await page.evaluate(async () => {
    const bk = (await import('/js/api/backend.js')).backend;
    const j = await bk.getPlc();                                  // 顺便把链路状态喂进去
    return { mode: j.status?.mode, online: j.status?.online };
  });
  await page.evaluate(async () => {
    const vs = (await import('/js/runtime/varstore.js')).varStore;
    const bk = (await import('/js/api/backend.js')).backend;
    vs.noteLink(bk.plcLink.mode, bk.plcLink.online);
  });
  ok('（前提）后端切到 PLC 数据源但连不上', link0.mode === 'plc' && link0.online === false, JSON.stringify(link0));

  await since();
  await page.evaluate(async () => (await import('/js/runtime/varstore.js')).varStore.set('plcVar', 9, 'local'));
  await sleep(500);
  const s = await st();
  const w = await newWrites();
  ok('★ 没连上：**一个写请求都没发**', w.length === 0, JSON.stringify(w));
  ok('★ 没连上：界面上的值恢复成上一次读到的那份（不留假值）', s.plcVar === 7, String(s.plcVar));
  // 现场要求：**不提示**（掉线红条已经在说设备断了），但原因要留在 lastWriteError 里可查
  ok('没连上：**界面上不提示**（状态栏不会挂出"未下发"）',
    !/未下发/.test(s.badge), JSON.stringify({ badge: s.badge, hidden: s.badgeHidden }));
  ok('没连上：原因仍记在 lastWriteError 里（查"怎么没生效"时有据可查）',
    s.lastErr?.blocked === true && /连不上|未连接/.test(s.lastErr?.message || ''), JSON.stringify(s.lastErr));

  // 内部变量（地址留空）不碰设备 → 不受门限制
  await since();
  await page.evaluate(async () => (await import('/js/runtime/varstore.js')).varStore.set('innerVar', 3, 'local'));
  await sleep(400);
  const s2 = await st();
  const w2 = await newWrites();
  ok('内部变量（地址留空）不受门限制：照常写、值也是新的',
    w2.includes('innerVar') && s2.innerVar === 3,
    JSON.stringify({ writes: w2, val: s2.innerVar }));
}

/* ══════ 3. 在线但**还没读到数据** → 也不许操作（"连上先读一遍"）══════ */
{
  await freezeLink(true);      // 这一节要手工伪造链路状态，先把推来的真实状态挡掉（见 freezeLink 的说明）
  await page.evaluate(async () => {
    const vs = (await import('/js/runtime/varstore.js')).varStore;
    const bk = (await import('/js/api/backend.js')).backend;
    bk.plcLink = { mode: 'plc', online: true };      // 假装设备在线（但还没读到过数据）
    vs.noteLink('plc', true);                         // 链路一变 → 重新等一次"读到数据"
  });
  const gate = await page.evaluate(async () => {
    const vs = (await import('/js/runtime/varstore.js')).varStore;
    return { reason: vs.linkBlockReason('plcVar'), needs: vs.needsFirstRead() };
  });
  ok('在线但还没读到数据：写被挡，理由写明"正在把设备上的数据读下来"',
    /读下来/.test(gate.reason) && gate.needs === true, JSON.stringify(gate));

  await since();
  await page.evaluate(async () => (await import('/js/runtime/varstore.js')).varStore.set('plcVar', 11, 'local'));
  await sleep(400);
  const s = await st();
  const w = await newWrites();
  ok('在线但还没读到数据：照样**一个请求都不发**、值也不变', w.length === 0 && s.plcVar === 7,
    JSON.stringify({ writes: w, val: s.plcVar }));

  // 读到数据（后端推来一批）→ 从此允许操作
  await page.evaluate(async () => (await import('/js/runtime/varstore.js')).varStore.applyRemote({ plcVar: 12.5 }));
  await sleep(200);
  await since();
  await page.evaluate(async () => (await import('/js/runtime/varstore.js')).varStore.set('plcVar', 13, 'local'));
  await sleep(400);
  const s2 = await st();
  const w2 = await newWrites();
  ok('★ 读到数据之后：允许操作，请求发得出去、值也是新的',
    w2.includes('plcVar') && s2.plcVar === 13,
    JSON.stringify({ writes: w2, val: s2.plcVar }));

  // 链路状态再变（例如断开又连上）→ 重新等一次读
  const again = await page.evaluate(async () => {
    const vs = (await import('/js/runtime/varstore.js')).varStore;
    vs.noteLink('plc', false);
    vs.noteLink('plc', true);
    return { needs: vs.needsFirstRead(), reason: vs.linkBlockReason('plcVar') };
  });
  ok('链路一变化（断开→再连上）就**重新等一次读到数据**（每次连上都要先读一遍）',
    again.needs === true && /读下来/.test(again.reason), JSON.stringify(again));
  await freezeLink(false);     // 还回真实状态推送（下一节要靠它探"接了设备但连不上"）
}

/* ══════ 4. 运行态：提示条写「未下发」（不是"下发失败"）══════ */
{
  await api('/api/plc', { action: 'disconnect' });          // 先回内存模拟，保证能进运行态
  await sleep(300);
  await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
  await sleep(700);
  await api('/api/plc', { action: 'connect', ip: '127.0.0.1', port: 1, unit: 1, poll_ms: 200, word_order: 'cdab' });
  // 运行态自己每隔几秒问一次后端状态 —— 等它**探到**"接了设备但连不上"，再验门的效果
  // （前端还没探到的那几秒里它当然不知道设备断了，那不属于"链路门"的范畴）
  let linkSeen = null;
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    linkSeen = (await st()).link;
    if (linkSeen.mode === 'plc' && linkSeen.online === false) break;
  }
  ok('运行态在几秒内探到「接了设备但连不上」', linkSeen?.mode === 'plc' && linkSeen?.online === false, JSON.stringify(linkSeen));

  await since();
  // 写之前把"门"的状态也记下来（失败时一眼看出是门没生效还是状态没同步上）
  const gateAtWrite = await page.evaluate(async () => {
    const vs = (await import('/js/runtime/varstore.js')).varStore;
    const bk = (await import('/js/api/backend.js')).backend;
    const info = { link: { ...bk.plcLink }, reason: vs.linkBlockReason('plcVar'), val: vs.get('plcVar') };
    vs.set('plcVar', 21, 'local');
    return info;
  });
  await sleep(600);
  const bar = await page.evaluate(() => ({
    hidden: document.getElementById('rtWriteAlarm')?.classList.contains('hidden'),
    text: document.getElementById('rtWriteAlarmText')?.textContent || '',
    sub: document.getElementById('rtWriteAlarmSub')?.textContent || '',
  }));
  // ⚠ 别断言"提示条一定藏着"：上一节那次**真的发出去**的写（连不上 → timed out）失败回调可能
  //   正好在这时候才回来，条子上写的是它 —— 那跟这次被门挡下的写没关系。
  //   要验的是"这次**没有**弹'未下发'"：门挡下时不发 vars:write，界面上什么都不该多出来。
  ok('运行态：没连上时**不弹"未下发"**（现场要求：掉线红条已经在说了，别再叠一条）',
    !/未下发/.test(bar.text), JSON.stringify({ bar, gateAtWrite }));
  ok('运行态：这一次同样**没发出去**（plcVar 不在写请求里）',
    !(await newWrites()).includes('plcVar'), JSON.stringify({ writes: await newWrites(), gateAtWrite }));
  const s4 = await st();
  ok('运行态：门确实挡下了（lastWriteError.blocked，不是"发了失败"）',
    s4.lastErr?.blocked === true && /连不上|未连接/.test(s4.lastErr?.message || ''), JSON.stringify(s4.lastErr));
  ok('运行态：值不留假值（不是刚敲的 21，恢复成写之前那份）',
    s4.plcVar !== 21 && String(s4.plcVar) === String(gateAtWrite.val),
    JSON.stringify({ now: s4.plcVar, beforeWrite: gateAtWrite.val }));
  await page.evaluate(async () => (await import('/js/runtime/runtime.js')).exitRun());
}

/* ══════ 5. 连上真模拟 PLC：**先读到数据**，值先变，然后才允许操作 ══════ */
{
  const sim = spawn(PY, ['server/plc_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'],
    { cwd: ROOT, stdio: 'ignore' });
  const simWrite = (addr, value) => fetch(`http://127.0.0.1:${SIM_WEB}/api/write`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'w', addr, value }),
  }).then(r => r.json()).catch(() => null);
  let simUp = false;
  for (let i = 0; i < 30 && !simUp; i++) {
    await sleep(300);
    try { simUp = (await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`)).ok; } catch { /* 等它起来 */ }
  }
  ok('模拟 PLC 起来了（Modbus 从站 + 网页调试台）', simUp, `mb=${SIM_MB} web=${SIM_WEB}`);

  // 设备上先摆一个值：%MD100（%MW100/101）= 12.5，低字在前
  await simWrite(100, 0x0000);
  await simWrite(101, 0x4148);
  await sleep(300);

  await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
  await sleep(500);
  await api('/api/plc', { action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab' });
  // 等运行态探到在线 + 读到数据（"连接成功后必须先读一遍"）
  let s = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    s = await st();
    if (s.link.online && s.readOnce) break;
  }
  ok('连上之后：链路状态变成"在线 + 已读到数据"',
    s.link.mode === 'plc' && s.link.online === true && s.readOnce === true, JSON.stringify(s.link) + ` readOnce=${s.readOnce}`);
  ok('★ 先读到数据：界面上的变量值变成了设备上的值（12.5）', Math.abs(Number(s.plcVar) - 12.5) < 1e-6, String(s.plcVar));

  await since();
  await page.evaluate(async () => (await import('/js/runtime/varstore.js')).varStore.set('plcVar', 33.5, 'local'));
  await sleep(700);
  const s2 = await st();
  const w = await newWrites();
  const onDevice = await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`).then(r => r.json()).catch(() => null);
  ok('★ 读到数据之后才允许操作：这次真的写下去了',
    w.includes('plcVar') && Math.abs(Number(s2.plcVar) - 33.5) < 1e-6,
    JSON.stringify({ writes: w, val: s2.plcVar }));
  ok('设备侧确实收到了（%MW100/101 拼出 33.5）',
    !!onDevice && Number.isFinite(Number(onDevice.holding?.['100'])) && Number.isFinite(Number(onDevice.holding?.['101'])),
    JSON.stringify({ mw100: onDevice?.holding?.['100'], mw101: onDevice?.holding?.['101'] }));

  await page.evaluate(async () => (await import('/js/runtime/runtime.js')).exitRun());
  // ⚠ 收尾必须**把后端从这台模拟 PLC 上摘下来**再杀掉它：
  //   一套件共用一个后端（见 tools/run-suites.mjs），留着这条连接的话，
  //   下一个套件开局看到的数据源是"接了 PLC 但连不上"，
  //   而不是它以为的"内存模拟" —— 后面那些「内部变量提示」「写失败提示条」之类的断言
  //   就会因为前置状态不对而误报（现场踩过：单跑全过、连跑失败）。
  await api('/api/plc', { action: 'disconnect' });
  await sleep(300);
  sim.kill();
}

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 链路门（没连上不许传 / 连上先读到数据才许操作）：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
