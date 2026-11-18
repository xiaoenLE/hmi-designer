// 前端那条路的进程级体检：页面 + 现场那种"脚本每秒写十几次"，同时看
//   ① 页面内部：JS 堆 / DOM 节点 / 事件监听 / 分离文档（V8 那一侧）
//   ② 进程外部：渲染进程、GPU 进程、主进程的**私有内存**（Task Manager 看的就是这个）
// 为什么两个都要看：6GB 是进程内存，而进程内存 ≠ JS 堆 —— DOM/样式/图像/网络缓冲都在别处，
// 只看 performance.memory 会得出"什么也没涨"的错觉。
// 用法：node test/_fw_soak.mjs [分钟] [写变量次数/秒]
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const DATA = mkdtempSync(join(tmpdir(), 'fwsoak-'));
const MINUTES = Number(process.argv[2] || 10);
const WPS = Number(process.argv[3] || 12);
const SCENE = process.argv[4] || 'full';        // full | noscript | idle
const HEADED = process.argv.includes('headed'); // 有窗口（和 WebView2 一样有真正的合成器）
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const API = await freePort(), MB = await freePort(), WEB = await freePort();
const sim = spawn('python', ['server/plc_sim.py', '--port', String(MB), '--web-port', String(WEB), '--no-browser'], { cwd: ROOT, stdio: 'ignore' });
const srvEnv = { ...process.env, HMI_DATA_DIR: DATA };
if (SCENE !== 'idle') srvEnv.HMI_POLL_ALWAYS = '1';      // idle = 后端连设备都不采（干净的基线）
const srv = spawn('python', ['server/server.py', '--port', String(API), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: srvEnv });
for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${API}/api/health`); await fetch(`http://127.0.0.1:${WEB}/api/state`); break; } catch { await sleep(400); } }
const post = (p, b) => fetch(`http://127.0.0.1:${API}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

// 现场那种工程：一页 40 个绑变量的控件 + 100 个变量 + 一条"每秒写十几次"的脚本
const proj = {
  meta: { name: '内存压测', canvas: { w: 1024, h: 600 } },
  pages: [{ id: 'p1', name: '主页', type: 'page', widgets: [] }],
  variables: [], alarms: [], scripts: [],
};
proj.variables = Array.from({ length: 100 }, (_, i) => ({ name: `v${i}`, type: 'real', address: `%MW${100 + i * 2}`, value: 0 }));
const pg = proj.pages[0];
pg.widgets = Array.from({ length: 40 }, (_, i) => ({
  id: `w${i}`, type: i % 3 === 0 ? 'number' : i % 3 === 1 ? 'label' : 'bar',
  name: `控件${i}`, x: 10 + (i % 8) * 110, y: 10 + Math.floor(i / 8) * 70, w: 100, h: 60, z: i,
  bindings: { variable: `v${i}` }, props: {}, actions: [],
}));
proj.scripts = [{ id: 'sc1', name: '现场那种定时写', trig: 'interval', ms: Math.round(1000 / WPS),
  code: "for (let i = 0; i < 3; i++) hmi.set('v' + ((hmi.g.n = (hmi.g.n || 0) + 1) % 100), hmi.now() % 1000);",
  enabled: SCENE !== 'noscript' && SCENE !== 'idle' }];
await post('/api/project', { data: proj });
await post('/api/vars/declare', { variables: proj.variables });
await post('/api/plc', { action: 'connect', ip: '127.0.0.1', port: MB, unit: 1, poll_ms: 100, word_order: 'cdab', variables: proj.variables });

/* 认自己的进程：启动浏览器前后各拍一次 chrome.exe 列表，**新增的那些**就是这次这套
   （不用 --remote-debugging-port 当记号 —— 那个端口谁都能挂上 DevTools，
   一挂上就会保留全部请求/日志，渲染进程内存直接起飞，量出来的数是假的）。
   内存按 PID 逐行报，谁在涨一眼可见。 */
const listChrome = () => {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {
         $t = if ($_.CommandLine -match '--type=([a-z\\-]+)') { $matches[1] } else { 'browser' }
         $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
         if ($p) { "$($_.ProcessId) $($_.ParentProcessId) $t $($p.PrivateMemorySize64)" }
       }`], { encoding: 'utf8', timeout: 20000 });
    return out.trim().split(/\r?\n/).filter(Boolean).map(l => {
      const [pid, ppid, type, bytes] = l.trim().split(/\s+/);
      return { pid: +pid, ppid: +ppid, type, mb: +(Number(bytes) / 1048576).toFixed(1) };
    });
  } catch { return []; }
};
const before = new Set(listChrome().map(p => p.pid));
const browser = await chromium.launch({ executablePath: EXE, headless: !HEADED });
const mine0 = listChrome().filter(p => !before.has(p.pid));
const rootPid = (mine0.find(p => p.type === 'browser') || {}).pid || 0;
console.log(`本次浏览器根进程 PID=${rootPid}（新增进程 ${mine0.length} 个）`);
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${API}/run`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data?.pages?.length > 0, { timeout: 30000 });
if (SCENE === 'idle') {
  await page.evaluate(() => window.app.backend.setPolling(false));   // 连登记都不做：后端不采设备
} else {
  await page.evaluate(() => { const b = document.getElementById('rtvFold'); if (b) b.click(); });
}
await sleep(4000);
if (HEADED) {     // 有窗口：最小化（现场就是"没人看"的后台状态）
  const cdpW = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdpW.send('Browser.getWindowForTarget');
    await cdpW.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } catch (e) { console.log('最小化失败：', e.message); }
  await cdpW.detach().catch(() => {});
  await sleep(1500);
  console.log('窗口 hidden =', await page.evaluate(() => document.hidden));
}
const cdp = await page.context().newCDPSession(page);

/* 进程内存：CDP 的 SystemInfo 在 Playwright 的 chromium 上拿不到 pid，所以按"命令行特征"找：
   根进程 = 带 --remote-debugging-port=9333 且没有 --type= 的那个；renderer/gpu 都是它的子进程
   （按 ParentProcessId 找）。一次 PowerShell 调用把类型和私有内存都带回来。 */
/* 每次采样：只统计"根进程 + 它的子进程"里那些（别的 chrome 一律不算） */
const procMem = () => {
  const all = listChrome();
  const kids = new Set([rootPid]);
  let grew = true;
  while (grew) {                     // 子进程还有孙子（utility 之类）→ 一层层收进来
    grew = false;
    for (const p of all) if (kids.has(p.ppid) && !kids.has(p.pid)) { kids.add(p.pid); grew = true; }
  }
  const mine = all.filter(p => kids.has(p.pid));
  const sum = (t) => +(mine.filter(p => p.type === t).reduce((a, p) => a + p.mb, 0)).toFixed(1);
  return { renderer: sum('renderer'), gpu: sum('gpu-process'), browser: sum('browser'),
    detail: mine.filter(p => p.type !== 'utility').map(p => `${p.type}#${p.pid}:${p.mb}`).join(' ') };
};
const sample = async () => {
  const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({}));
  const js = await page.evaluate(() => ({
    heap: (performance.memory?.usedJSHeapSize || 0) / 1048576,
    nodes: document.getElementsByTagName('*').length,
    vars: Object.keys(window.app.varStore.values).length,
  }));
  const mem = procMem();
  return { ...js, renderer: mem.renderer, gpu: mem.gpu, brw: mem.browser,
    total: +(mem.renderer + mem.gpu + mem.browser).toFixed(1), detail: mem.detail,
    listeners: dom?.jsEventListeners ?? -1, docs: dom?.documents ?? -1 };
};

const first = await sample();
console.log(`场景=${SCENE}${HEADED ? '(有窗口/最小化)' : '(headless)'} · 脚本每秒写 ≈${WPS} 次 · 变量 ${first.vars} 个`);
console.log(`起始：${first.detail}\n`);
console.log('  时间   JS堆MB  渲染MB  GPU_MB  主进程MB  合计MB   DOM节点  监听  文档');
const t0 = Date.now();
let last = first;
for (let i = 1; i * 30 <= MINUTES * 60; i++) {
  await sleep(30000);
  const s = await sample();
  last = s;
  console.log(`  ${((Date.now() - t0) / 60000).toFixed(1).padStart(4)}分 ${s.heap.toFixed(1).padStart(7)} ${s.renderer.toFixed(0).padStart(7)} ${s.gpu.toFixed(0).padStart(7)} ${s.brw.toFixed(0).padStart(8)} ${s.total.toFixed(0).padStart(7)} ${String(s.nodes).padStart(9)} ${String(s.listeners).padStart(5)} ${String(s.docs).padStart(5)}`);
}
const mins = (Date.now() - t0) / 60000;
console.log(`\n${mins.toFixed(1)} 分钟：JS 堆 ${first.heap.toFixed(1)} → ${last.heap.toFixed(1)} MB（${((last.heap - first.heap) / mins).toFixed(2)} MB/分）`);
console.log(`渲染进程 ${first.renderer.toFixed(0)} → ${last.renderer.toFixed(0)} MB（${((last.renderer - first.renderer) / mins).toFixed(2)} MB/分 → 8 小时 ${((last.renderer - first.renderer) / mins * 480).toFixed(0)} MB）`);
console.log(`三进程合计 ${first.total.toFixed(0)} → ${last.total.toFixed(0)} MB · DOM ${first.nodes} → ${last.nodes} · 监听 ${first.listeners} → ${last.listeners} · 文档 ${first.docs} → ${last.docs}`);
console.log(`末尾明细：${last.detail}`);
const h = await fetch(`http://127.0.0.1:${API}/api/health`).then(r => r.json());
console.log(`后端：请求 ${h.reqs} · 接受连接 ${h.conns}（比值 ${(h.reqs / Math.max(1, h.conns)).toFixed(1)} 请求/连接）`);
console.log('页面报错：', errs.length ? errs.slice(0, 3) : '无');
await browser.close();
try { sim.kill(); } catch {}
try { srv.kill(); } catch {}
