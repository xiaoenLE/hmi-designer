// _probe-user-undef.mjs — 用现场那份存档工程跑**仿真**，把"没有定义变量"这类报错原样抓出来。
// 只读那份工程（拷进隔离数据目录），不碰现场存档。用法：node test/_probe-user-undef.mjs
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
const SAVED = path.join(ROOT, 'server', 'data', 'hmi_project.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

if (!fs.existsSync(SAVED)) { console.log('没有现场存档工程，跳过'); process.exit(0); }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-user-undef-'));
fs.copyFileSync(SAVED, path.join(DATA, 'hmi_project.json'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HMI_DATA_DIR: DATA } });
const srvLog = [];
srv.stdout.on('data', b => srvLog.push(b.toString('utf-8')));
srv.stderr.on('data', b => srvLog.push(b.toString('utf-8')));
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(BASE + '/api/health'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on('dialog', d => d.accept());
const warns = [];
page.on('console', m => { if (['warning', 'error'].includes(m.type())) warns.push(m.text()); });
await page.addInitScript(() => {
  window.__bars = []; window.__acks = [];
  setInterval(async () => {
    try {
      const { backend } = await import('/js/api/backend.js');
      if (!window.__h) {
        window.__h = true;
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
      if (!ch || ch.__a) return;
      ch.__a = true;
      const real = ch._dispatch.bind(ch);
      ch._dispatch = (j) => {
        if (j && j.t === 'ack' && j.ok === false) window.__acks.push({ error: j.error || '', kind: j.kind || '' });
        return real(j);
      };
    } catch { /* 等页面 */ }
  }, 200);
});
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, { timeout: 20000 });
await sleep(600);

// 静态体检：脚本里提到了哪些变量、其中哪些**不在变量表里**
const audit = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const tbl = new Set(project.variables().map(v => v.name));
  const noAddr = new Set(project.variables().filter(v => !String(v.address || '').trim()).map(v => v.name));
  const out = [];
  for (const sc of project.scripts()) {
    const code = sc.code || '';
    // hmi.v.名字 / hmi.v['名字'] / hmi.set('名字') / hmi.get('名字')
    const names = new Set();
    for (const m of code.matchAll(/hmi\.(?:set|get)\(\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
    for (const m of code.matchAll(/hmi\.v\[['"]([^'"]+)['"]\]/g)) names.add(m[1]);
    for (const m of code.matchAll(/hmi\.v\.([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/g)) names.add(m[1]);
    out.push({
      id: sc.id, name: sc.name, trig: sc.trig, ms: sc.ms, enabled: sc.enabled,
      提到: names.size,
      不在变量表里: [...names].filter(n => !tbl.has(n)),
      其中的内部变量: [...names].filter(n => noAddr.has(n)),
    });
  }
  return { 变量数: project.variables().length, 内部变量: [...noAddr], scripts: out };
});
console.log(`工程变量 ${audit.变量数} 个；内部变量（地址留空）：${JSON.stringify(audit.内部变量)}`);
for (const s of audit.scripts) {
  console.log(`\n脚本「${s.name}」 trig=${s.trig} ms=${s.ms} enabled=${s.enabled} 提到变量 ${s.提到} 个`);
  console.log(`  ⚠ 不在变量表里的：${s.不在变量表里.length ? JSON.stringify(s.不在变量表里) : '没有'}`);
  console.log(`  其中内部变量：${JSON.stringify(s.其中的内部变量)}`);
}

/* 跑仿真（内存模拟），看运行时报什么 */
await page.evaluate(() => import('/js/runtime/runtime.js').then(m => m.enterRun()));
await sleep(5000);
const run = await page.evaluate(async () => {
  const e = await import('/js/runtime/scriptEngine.js');
  const logs = e.scriptLogsAll(300, { dbg: true });
  const { backend } = await import('/js/api/backend.js');
  return {
    errors: logs.lines.filter(l => l.level === 'error').map(l => `${l.name}: ${l.text}`),
    disabled: logs.disabled.map(d => d.name),
    bars: window.__bars.slice(),
    acks: window.__acks.slice(),
    link: { ...backend.plcLink },
  };
});
console.log('\n───── 仿真跑 5 秒之后 ─────');
console.log('  脚本运行错误：  ', run.errors.length ? JSON.stringify(run.errors.slice(0, 8), null, 1) : '没有');
console.log('  被停用的脚本：  ', run.disabled.length ? JSON.stringify(run.disabled) : '没有');
console.log('  「下发失败」条：', run.bars.length ? JSON.stringify(run.bars.slice(0, 4)) : '一次都没弹');
console.log('  后端回的写失败：', run.acks.length ? JSON.stringify(run.acks.slice(0, 6)) : '一笔都没有');
console.log('  控制台 warn：   ', warns.filter(w => !/\[init:|favicon/.test(w)).slice(0, 6));
const undef = srvLog.join('').match(/未在变量表声明|未定义|没有「/g) || [];
console.log('  后端日志里"未在变量表声明/未定义"：', undef.length, '次');

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
