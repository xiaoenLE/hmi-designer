// _probe-undefined.mjs — 排查：**仿真跑起来之后，还有哪些地方会报"变量没有定义"**
//
// 用户原话：「现在触摸屏内部地址应该不会下发 PLC 了吧，就是防止报没有定义变量」
// 要把所有可能的来源一次抓干净：
//   ① 运行页面顶部橙条「下发失败（…）」的 sub 文案（后端给的原因）
//   ② 脚本日志里的运行错误（hmi.v.打错字会抛「变量表里没有「x」」）
//   ③ 控制台 warn/error（varstore 的 console.warn）
//   ④ 后端 ack 里的 error（直接抓长连接回了什么）
// 三种场景各跑一遍：内存模拟 / PLC 模式（设备在线）/ PLC 模式（后端表里**故意少几个变量**）
// 用法：node test/_probe-undefined.mjs
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SIM_MB = await freePort();
const SIM_WEB = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-probe-undef-'));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HMI_DATA_DIR: DATA, HMI_POLL_ALWAYS: '1' } });
const srvLog = [];
srv.stdout.on('data', b => srvLog.push(b.toString('utf-8')));
srv.stderr.on('data', b => srvLog.push(b.toString('utf-8')));
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(BASE + '/api/health'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on('dialog', d => d.accept());
const consoleMsgs = [];
page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') consoleMsgs.push(m.text()); });

// 抓后端到底回了什么 error（长连接 ack）
await page.addInitScript(() => {
  window.__acks = [];     // {t, ok, error, kind, name}
  window.__bars = [];     // 「下发失败」条出现过的文案
  setInterval(async () => {
    try {
      const { backend } = await import('/js/api/backend.js');
      if (!window.__probeHooked) {
        window.__probeHooked = true;
        const bar = document.getElementById('rtWriteAlarm');
        if (bar) {
          new MutationObserver(() => {
            if (!bar.classList.contains('hidden')) {
              window.__bars.push({
                text: document.getElementById('rtWriteAlarmText')?.textContent || '',
                sub: document.getElementById('rtWriteAlarmSub')?.textContent || '',
              });
            }
          }).observe(bar, { attributes: true, attributeFilter: ['class'] });
        }
      }
      const ch = backend._channel;
      if (!ch || ch.__ackHooked) return;
      ch.__ackHooked = true;
      const real = ch._dispatch.bind(ch);
      ch._dispatch = (j) => {
        if (j && j.t === 'ack' && j.ok === false) window.__acks.push({ error: j.error || '', kind: j.kind || '' });
        return real(j);
      };
    } catch { /* 等页面 */ }
  }, 200);
});

const snap = () => page.evaluate(async () => {
  const e = await import('/js/runtime/scriptEngine.js');
  const logs = e.scriptLogsAll(200, { dbg: true });
  return {
    bars: window.__bars.slice(),
    acks: window.__acks.slice(),
    scriptErrors: logs.lines.filter(l => l.level === 'error').map(l => `${l.name}: ${l.text}`),
    disabled: logs.disabled.map(d => d.name),
  };
});
const reset = async () => {
  consoleMsgs.length = 0;                                  // 这一份在 Node 这边
  await page.evaluate(() => { window.__acks = []; window.__bars = []; }).catch(() => {});
  await page.evaluate(async () => {
    const e = await import('/js/runtime/scriptEngine.js');
    e.clearAllScriptLogs();
  }).catch(() => {});
};

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, { timeout: 20000 });
await sleep(600);
console.log('内置演示工程：变量', await page.evaluate(() => window.app.project.variables().length),
  '个 / 脚本', await page.evaluate(() => window.app.project.scripts().length), '条');
console.log('  其中地址留空（内部变量）：',
  await page.evaluate(() => window.app.project.variables().filter(v => !String(v.address || '').trim()).map(v => v.name)));
console.log('  仿真脚本写的变量：',
  await page.evaluate(() => {
    const code = window.app.project.scripts().map(s => s.code || '').join('\n');
    const names = [...new Set([...code.matchAll(/hmi\.(?:set|get)\(['"]([^'"]+)['"]/g)].map(m => m[1]))];
    const inTbl = new Set(window.app.project.variables().map(v => v.name));
    const noAddr = new Set(window.app.project.variables().filter(v => !String(v.address || '').trim()).map(v => v.name));
    return { 提到的变量数: names.length, 不在变量表里的: names.filter(n => !inTbl.has(n)), 里面的内部变量: names.filter(n => noAddr.has(n)) };
  }));

const report = async (label) => {
  const s = await snap();
  const backendSaidUndef = srvLog.join('').match(/未在变量表声明|未定义|undefined/g) || [];
  console.log(`\n───── ${label} ─────`);
  console.log('  顶部「下发失败」条：', s.bars.length === 0 ? '一次都没弹' : JSON.stringify(s.bars.slice(0, 4)));
  console.log('  后端回的写失败：  ', s.acks.length === 0 ? '一笔都没有' : JSON.stringify(s.acks.slice(0, 6)));
  console.log('  脚本运行错误：    ', s.scriptErrors.length === 0 ? '没有' : JSON.stringify(s.scriptErrors.slice(0, 6)));
  console.log('  被自动停用的脚本：', s.disabled.length ? JSON.stringify(s.disabled) : '没有');
  console.log('  控制台 warn/error：', consoleMsgs.filter(m => !/\[init:|favicon/.test(m)).slice(0, 5));
  console.log('  后端日志里"未在变量表声明/未定义"出现次数：', backendSaidUndef.length);
  return s;
};

/* ── ① 内存模拟（纯仿真）── */
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.enterRun()));
await sleep(3000);
await report('① 内存模拟：仿真脚本跑起来');
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.exitRun()));

/* ── ② PLC 模式 + 设备在线（前端把自己的变量表整套下发）── */
const sim = spawn(PY, ['server/plc_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore' });
for (let i = 0; i < 30; i++) { await sleep(300); try { await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`); break; } catch { /* 等 */ } }
await reset();
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.enterRun()));
await sleep(500);
await fetch(BASE + '/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab' }),
});
await sleep(4000);
await report('② PLC 模式 + 设备在线');
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.exitRun()));

/* ── ③ PLC 模式 + 后端变量表**故意缺几个**（现场"两边表不一致"的那种）── */
const missing = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  // 拿前 3 个**有地址**的变量，故意不让后端知道它们
  return project.variables().filter(v => String(v.address || '').trim()).slice(0, 3).map(v => v.name);
});
await reset();
await fetch(BASE + '/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab',
    variables: await page.evaluate(async (miss) => {
      const { project } = await import('/js/core/project.js');
      return project.variables().filter(v => !miss.includes(v.name))
        .map(v => ({ name: v.name, type: v.type, address: v.address }));
    }, missing),
  }),
});
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.enterRun()));
await sleep(4500);
const s3 = await report(`③ PLC 模式 + 后端表里故意少了 ${JSON.stringify(missing)}`);

await browser.close();
srv.kill();
try { sim.kill(); } catch { /* 已杀 */ }
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }

const undef = s3.acks.filter(a => /未在变量表声明/.test(a.error));
console.log(`\n结论：后端表缺变量时，前端收到「未在变量表声明」${undef.length} 笔`);
console.log(undef.length ? `      样例：${JSON.stringify(undef.slice(0, 3))}` : '      （没有）');
