// _repro-user-project.mjs — 用**现场那份存档工程**复现截图里的场景：
//   PLC 模式 + 设备连不上 + 演示工程那条**没有 hmi.sim() 守卫**的仿真脚本（每 500ms 写一批模拟量）
// 问的是：还会不会「前面数据一直下发、一条条弹『下发失败』直到弹完才停」。
// 只读地用那份工程（拷进隔离数据目录），不碰现场存档。
// 用法：node test/_repro-user-project.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const SAVED = path.join(ROOT, 'server', 'data', 'hmi_project.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

if (!fs.existsSync(SAVED)) { console.log('没有现场存档工程，跳过'); process.exit(0); }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-repro-user-'));
fs.copyFileSync(SAVED, path.join(DATA, 'hmi_project.json'));

const PORT = await freePort();
const DEAD = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_POLL_ALWAYS: '1' } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(BASE + '/api/health'); break; } catch { /* 等 */ } }

let writeReqs = 0;
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on('dialog', d => d.accept());
page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/vars')) writeReqs++; });
await page.addInitScript(() => {
  window.__wsWrites = 0; window.__fails = []; window.__barShown = 0; window.__wsNames = {};
  setInterval(async () => {
    try {
      const { backend } = await import('/js/api/backend.js');
      const { bus } = await import('/js/core/eventBus.js');
      if (!window.__hooked) {
        window.__hooked = true;
        bus.on('vars:write', ev => { if (ev.ok === false) window.__fails.push({ n: ev.name, kind: ev.kind || '' }); });
        const bar = document.getElementById('rtWriteAlarm');
        if (bar) {
          let h = bar.classList.contains('hidden');
          new MutationObserver(() => {
            const nh = bar.classList.contains('hidden');
            if (h && !nh) window.__barShown++;
            h = nh;
          }).observe(bar, { attributes: true, attributeFilter: ['class'] });
        }
      }
      const ch = backend._channel;
      if (!ch || ch.__w) return;
      ch.__w = true;
      const real = ch.send.bind(ch);
      ch.send = (o) => {
        if (o && o.t === 'write') { window.__wsWrites++; (window.__wsNames[o.name] = (window.__wsNames[o.name] || 0) + 1); }
        return real(o);
      };
    } catch { /* 等页面 */ }
  }, 250);
});
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, { timeout: 20000 });
await sleep(600);
console.log('工程变量数 =', await page.evaluate(() => window.app.project.variables().length));
console.log('脚本数 =', await page.evaluate(() => window.app.project.scripts().length),
  '| 那条脚本有没有 hmi.sim() 守卫 =',
  await page.evaluate(() => window.app.project.scripts().some(s => /hmi\.sim\(\)/.test(s.code || ''))));

// 先连一个死端口（= 截图里的 127.0.0.1:502 连不上）
await fetch(BASE + '/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'connect', ip: '127.0.0.1', port: DEAD, unit: 1, poll_ms: 200, word_order: 'cdab' }),
});
await sleep(1200);
await page.evaluate(() => { window.__wsWrites = 0; window.__fails = []; window.__barShown = 0; window.__wsNames = {}; });
writeReqs = 0;

await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.enterRun()));
await sleep(8000);                       // 脚本每 500ms 写一批，8 秒 = 十几拍

const out = await page.evaluate(async () => {
  const bk = (await import('/js/api/backend.js')).backend;
  const { project } = await import('/js/core/project.js');
  const hasAddr = (n) => !!String(project.variables().find(v => v.name === n)?.address || '').trim();
  const sent = window.__wsNames || {};
  const inner = {}, plc = {};
  for (const [n, c] of Object.entries(sent)) (hasAddr(n) ? plc : inner)[n] = c;
  return {
    wsWrites: window.__wsWrites, sentInner: inner, sentPlc: plc, fails: window.__fails.length,
    kinds: [...new Set(window.__fails.map(f => f.kind))],
    names: [...new Set(window.__fails.map(f => f.n))].slice(0, 8),
    barShown: window.__barShown,
    barHidden: document.getElementById('rtWriteAlarm')?.classList.contains('hidden'),
    tip: document.getElementById('rtInternalTip')?.textContent || '',
    link: { ...bk.plcLink },
    sim: window.__hmiRuntime.isSim(),
  };
});
console.log('\n运行 8 秒之后：');
console.log('  发出去的写：HTTP', writeReqs, '笔 / 长连接', out.wsWrites, '笔');
console.log('  发给**设备**的（有 PLC 地址）：', JSON.stringify(out.sentPlc), '  ← 断开期间必须是空的');
console.log('  内部变量的同步（发给本机后端，不碰设备）：', JSON.stringify(out.sentInner));
console.log('  失败事件：', out.fails, '笔  分类：', JSON.stringify(out.kinds), ' 涉及变量：', JSON.stringify(out.names));
console.log('  「下发失败」条弹出次数：', out.barShown, '（现在藏着 =', out.barHidden, '）');
console.log('  左下角提示：', JSON.stringify(out.tip), '| hmi.sim() =', out.sim, '| 链路 =', JSON.stringify(out.link));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
const bad = [];
if (Object.keys(out.sentPlc).length) bad.push(`断开期间还给设备发了写：${JSON.stringify(out.sentPlc)}`);
if (out.fails > 0) bad.push(`还有失败事件（${out.fails} 笔）`);
if (out.barShown > 0) bad.push(`「下发失败」条弹了 ${out.barShown} 次`);
if (!/PLC 已断开/.test(out.tip)) bad.push(`左下角提示不对：${out.tip}`);
if (out.sim !== false) bad.push(`hmi.sim() 应该是 false，实际 ${out.sim}`);
console.log(bad.length ? `\n✗ ${bad.join('；')}` : '\n✓ 断开期间：**没有一笔发往设备**、没有失败弹条、左下角如实写「PLC 已断开」');
process.exit(bad.length ? 1 : 0);
