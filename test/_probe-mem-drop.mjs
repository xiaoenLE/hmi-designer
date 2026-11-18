// _probe-mem-drop.mjs — 复现「正常连接后突然断开，运行内存暴涨一下、过一会才降下来」
//
// 只测这次改动碰到的那条路径：写值下发 → 设备突然断开 → 断开之后还在写的这段时间。
// 同时采三样，好判断内存是谁涨的：
//   · 后端进程：WorkingSet（工作集）/ 线程数 / 句柄数        ← PowerShell 采样进程
//   · 后端接口：/api/health 的 reqs / conns / ws 在线数      ← 看有没有"HTTP 回退风暴"
//   · 浏览器页面：JS 堆（performance.memory）                ← 看有没有前端侧堆积
//
// 两种设备链路都测（这次改动两条都碰了）：
//   node test/_probe-mem-drop.mjs              # Modbus TCP（模拟 PLC）
//   node test/_probe-mem-drop.mjs --opcua      # OPC UA（模拟 OPC UA 服务器）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const USE_OPCUA = process.argv.includes('--opcua');
const N_VARS = Number(process.env.HMI_PROBE_VARS || 10);       // Modbus：变量表里放几个
const BURST_MS = Number(process.env.HMI_PROBE_MS || 100);      // 写节奏（毫秒）
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = process.env.HMI_PY || 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort(), SIM_MB = await freePort(), SIM_WEB = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-mem-'));

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_POLL_ALWAYS: '1' } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(BASE + '/api/health'); break; } catch { /* 等 */ } }
const sim = USE_OPCUA
  ? spawn(PY, ['server/opcua_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'], { cwd: ROOT, stdio: 'ignore' })
  : spawn(PY, ['server/plc_sim.py', '--port', String(SIM_MB), '--web-port', String(SIM_WEB), '--no-browser'], { cwd: ROOT, stdio: 'ignore' });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(`http://127.0.0.1:${SIM_WEB}/api/state`); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on('dialog', d => d.accept());
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, { timeout: 20000 });
await sleep(500);

/* 变量表：OPC UA 用 CODESYS 符号节点，Modbus 用 %MW100… */
const UA_EP = `opc.tcp://127.0.0.1:${SIM_MB}`;
await page.evaluate(async ({ opcua, nVars }) => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  project.data.variables.length = 0;
  if (opcua) {
    // 模拟 OPC UA 服务器按 CODESYS 符号发布（见 server/opcua_sim.py）
    for (const [n, t] of [['a', 'int'], ['b', 'uint'], ['c', 'real'], ['d', 'lreal'], ['dd', 'bool'], ['w', 'uint']]) {
      project.data.variables.push({ name: n, type: t, address: `ns=4;s=|var|SimRuntime.Application.GVL.${n}`, value: 0, len: 0 });
    }
  } else {
    for (let i = 0; i < nVars; i++) {
      project.data.variables.push({ name: `mw${i}`, type: 'int', address: `%MW${100 + i}`, value: 0, len: 0 });
    }
  }
  project.data.scripts.length = 0;
  project.commit('内存探测用变量表');
  varStore.resetFrom(project.variables());
}, { opcua: USE_OPCUA, nVars: N_VARS });
await sleep(300);
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.enterRun()));
await sleep(400);
await fetch(BASE + '/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(USE_OPCUA
    ? { action: 'connect', protocol: 'opcua', endpoint: UA_EP, poll_ms: 300 }
    : { action: 'connect', ip: '127.0.0.1', port: SIM_MB, unit: 1, poll_ms: 200, word_order: 'cdab' }),
});
for (let i = 0; i < 40; i++) {
  await sleep(300);
  const l = await page.evaluate(async () => (await import('/js/api/backend.js')).backend.plcLink).catch(() => null);
  if (l?.mode && l.online) break;
}
await sleep(1500);
const devVars = await page.evaluate(async () => (await import('/js/core/project.js')).project.variables().map(v => v.name));
console.log(`已连上模拟设备（${USE_OPCUA ? 'OPC UA ' + UA_EP : 'Modbus 127.0.0.1:' + SIM_MB}），变量 ${devVars.length} 个，开始采样…`);

/* ── 采样器：一个 PowerShell 进程按 250ms 记后端进程的三项 ── */
const t0 = Date.now();
const samp = spawn('powershell', ['-NoProfile', '-Command',
  `$id=${srv.pid}; $end=(Get-Date).AddSeconds(45); while ((Get-Date) -lt $end) { ` +
  `$p=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { ` +
  `"$([int]((Get-Date)-[datetime]'${new Date(t0).toISOString()}').TotalMilliseconds),$($p.WorkingSet64),$($p.Threads.Count),$($p.HandleCount)" }; ` +
  `Start-Sleep -Milliseconds 250 }`],
  { stdio: ['ignore', 'pipe', 'ignore'] });
let sampOut = '';
samp.stdout.on('data', b => { sampOut += b.toString(); });

/* ── 浏览器侧：页面 JS 堆 + 每 500ms 记一行时间线 ── */
await page.evaluate(() => {
  window.__tl = [];
  window.__timer = setInterval(() => {
    const m = performance.memory || {};
    window.__tl.push({ t: Date.now(), heap: m.usedJSHeapSize || 0, pending: 0 });
  }, 500);
});

/* ── 脚本在写（默认每 100ms 把整张表写一遍；现场那种"一批过程映像 + 高频脚本"可以调大）── */
await page.evaluate(({ names, ms }) => {
  window.__burst = { on: true, n: 0 };
  (async () => {
    const { varStore } = await import('/js/runtime/varstore.js');
    while (window.__burst.on) {
      for (const n of names) varStore.set(n, window.__burst.n % 30000, 'local');
      window.__burst.n++;
      await new Promise(r => setTimeout(r, ms));
    }
  })();
}, { names: devVars, ms: BURST_MS });
console.log(`  写节奏：每 ${BURST_MS}ms 把 ${devVars.length} 个变量写一遍`
  + `（≈ ${Math.round(devVars.length * 1000 / BURST_MS)} 笔/秒）`);

const health = async () => (await fetch(BASE + '/api/health').then(r => r.json()).catch(() => ({})));
const h0 = await health();
await sleep(4000);

/* ── ★ 突然断开 ── */
const dropAt = Date.now() - t0;
console.log(`t=${(dropAt / 1000).toFixed(1)}s  ★ 拔线（杀模拟 PLC）`);
sim.kill();
const heapAtDrop = await page.evaluate(() => (performance.memory || {}).usedJSHeapSize || 0);

await sleep(16000);                        // 断开之后继续写 16 秒（"过一会才降下来"要看得见）
const h1 = await health();
await page.evaluate(() => { window.__burst.on = false; clearInterval(window.__timer); });
await sleep(1500);
const h2 = await health();
const tl = await page.evaluate(() => window.__tl || []);

samp.kill();
await sleep(400);

/* ── 输出时间线 ── */
const rows = sampOut.trim().split(/\r?\n/).map(l => l.split(','))
  .filter(a => a.length === 4 && /^\d+$/.test(a[0]))
  .map(([ms, ws, th, hd]) => ({ s: +ms / 1000, ws: +ws / 1048576, th: +th, hd: +hd }));
const base = rows.filter(r => r.s < dropAt / 1000 - 0.5);
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const baseline = avg(base.map(r => r.ws));
const peak = rows.length ? Math.max(...rows.map(r => r.ws)) : 0;
const peakRow = rows.find(r => r.ws === peak);
const settled = rows.filter(r => r.s > peakRow?.s).slice(-4);
console.log(`\n后端进程（Python）工作集：`);
console.log(`  断开前均值 ${baseline.toFixed(1)} MB · 峰值 ${peak.toFixed(1)} MB @ t=${peakRow?.s?.toFixed(1)}s`
  + ` （涨了 ${(peak - baseline).toFixed(1)} MB，×${(peak / (baseline || 1)).toFixed(2)}）`);
console.log(`  末尾稳定在 ${avg(settled.map(r => r.ws)).toFixed(1)} MB；线程数 基线 ${avg(base.map(r => r.th)).toFixed(0)}`
  + ` → 峰值 ${Math.max(...rows.map(r => r.th))} → 末尾 ${avg(settled.map(r => r.th)).toFixed(0)}`);
console.log(`  句柄数 峰值 ${Math.max(...rows.map(r => r.hd))} → 末尾 ${avg(settled.map(r => r.hd)).toFixed(0)}`);

const heapRows = tl.map(x => ({ s: (x.t - t0) / 1000, mb: x.heap / 1048576 }));
const hb = avg(heapRows.filter(r => r.s < dropAt / 1000 - 0.5).map(r => r.mb));
const hp = heapRows.length ? Math.max(...heapRows.map(r => r.mb)) : 0;
console.log(`\n页面 JS 堆：断开前均值 ${hb.toFixed(1)} MB · 峰值 ${hp.toFixed(1)} MB`
  + ` · 末尾 ${avg(heapRows.slice(-4).map(r => r.mb)).toFixed(1)} MB`);

console.log(`\n后端接口计数：断开前 reqs=${h0.reqs} conns=${h0.conns}`
  + ` → 断开 16 秒后 reqs=${h1.reqs} conns=${h1.conns}`
  + ` → 停写 1.5 秒后 reqs=${h2.reqs} conns=${h2.conns}`);
console.log(`  （这段里新增 HTTP 请求 ${(h1.reqs ?? 0) - (h0.reqs ?? 0)} 个 —— 走长连接时应该接近 0）`);

console.log('\nt 秒 | 后端工作集 MB | 线程 | 句柄');
for (const r of rows.filter((_, i) => i % 4 === 0)) {
  const mark = Math.abs(r.s - dropAt / 1000) < 0.3 ? '  ← 拔线' : '';
  console.log(`${r.s.toFixed(1).padStart(5)} | ${r.ws.toFixed(1).padStart(10)} | ${String(r.th).padStart(4)} | ${String(r.hd).padStart(5)}${mark}`);
}

await browser.close();
srv.kill();
try { sim.kill(); } catch { /* 已杀 */ }
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
try { fs.rmSync(CSV, { force: true }); } catch { /* 忽略 */ }
