// verify-log-block.mjs — **控制台写不动时，后端不许跟着卡死**
//
// 现场踩过的坑（整个后端像"死"了一样）：Windows 控制台一旦被点住就进入「标记/选择」模式
// （窗口标题变成「选择 …」），这时**谁往控制台写谁就卡住**，直到有人在那个窗口里按 Esc。
// 而后端是**多线程**处理请求的：写变量那个请求里有一句 print（`[var] x = 1`），
// 控制台一被点住，那个线程就永远停在 write 上 —— 浏览器那边请求一直不返回，
// 界面表现就是「下发失败」刷屏 + 页面卡住、刷新都刷不动（看着像软件坏了，其实是控制台被选中）。
//
// 这一套就是把这个场景搬到测试里：给后端的 stdout 接一根**没人读**的管道（= 控制台写不动），
// 用足够多的日志把它灌满，然后打接口 —— 请求必须照常在 1 秒内返回。
//
// 用法：node test/verify-log-block.mjs [后端目录]      （后端目录用来看别的 checkout，比如旧代码对照）
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠ 第一个参数**可能是端口**：run-suites.mjs 一律按 `node test/xxx.mjs <端口>` 调套件
//   （本套件自己起后端，端口用不上）—— 所以数字当端口忽略掉，别把它当成"后端目录"（会 ENOENT）。
const _arg = process.argv[2] || '';
const SERVER_DIR = /^\d+$/.test(_arg) ? path.resolve(import.meta.dirname, '..') : (_arg || path.resolve(import.meta.dirname, '..'));
const PY = process.env.HMI_PY || 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-logblock-'));
// stdio: stdout/stderr 都是管道，而且我们**故意不读**它（Node 这边 pause 掉 = 不消费）
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HMI_DATA_DIR: DATA } });
srv.stdout.pause();
srv.stderr.pause();

const base = `http://127.0.0.1:${PORT}`;
const post = async (p, body, ms = 4000) => {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), signal: ctl.signal,
    });
    return { status: r.status, ms: Date.now() - t0, json: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, err: e.name };
  } finally { clearTimeout(to); }
};

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { const r = await fetch(base + '/api/health'); up = r.ok; } catch { /* 等它起来 */ }
}
ok('后端起来了（隔离数据目录）', up, `port=${PORT}`);
if (!up) { srv.kill(); console.log(results.join('\n')); process.exit(1); }

/* ── 1. 机制本身：控制台"写不动"时，打日志**绝不允许**把调用方拖住 ──
   用一个 write 会睡 30 秒的假控制台模拟"窗口被点住"。旧代码是直接在请求线程里同步 write，
   这里就会一直卡着（以前的表现：写变量请求永不返回 → 前端「下发失败」刷屏）。
   队列满了应该**丢日志**并立刻返回。 */
const probe = `
import os, sys, time
# ⚠ 要把 "<仓库>/server" 放进 sys.path 再 import server：直接放仓库根目录的话，
#   Python 会把 server/ 这个**目录**当成命名空间包导入（__file__ 都是 None），拿不到模块本体
sys.path.insert(0, os.path.join(r"${SERVER_DIR}", "server"))
import server
assert hasattr(server, "_ConsoleWriter"), "没有 _ConsoleWriter 这层保护（日志是同步写控制台的）"
class Stuck:
    def write(self, s): time.sleep(30)      # 模拟控制台被点住：写进去就出不来
    def flush(self): pass
w = server._ConsoleWriter(Stuck())
t0 = time.time()
for _ in range(3000):
    w.write("x" * 200)
print(f"{time.time() - t0:.3f} {w.dropped}")
`;
const pr = spawn(PY, ['-c', probe], { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
let pout = '', perr = '';
pr.stdout.on('data', d => pout += d);
pr.stderr.on('data', d => perr += d);
const pcode = await new Promise(res => pr.on('exit', res));
const [pdt, pdrop] = pout.trim().split(/\s+/);
ok('★ 控制台写不动时，打日志不会卡住调用方（3000 行日志立刻返回、多余的丢掉）',
  pcode === 0 && Number(pdt) < 1.0 && Number(pdrop) > 1000,
  `退出=${pcode} 耗时=${pdt}s 丢弃=${pdrop}${perr ? ' 错误=' + perr.trim().slice(0, 120) : ''}`);

// 声明一个变量（declare 不打日志，先确认接口本身是通的）
const dec = await post('/api/vars/declare', { variables: [{ name: 'x', type: 'string', value: '' }] });
ok('写之前：/api/vars/declare 正常', dec.status === 200, JSON.stringify(dec).slice(0, 120));

/* ── 把"控制台"塞满：每次写变量都会 print 一行 `[var] x = '<2KB>'` ──
   管道缓冲（Windows 一般 64KB）一满，旧代码的请求线程就卡在 write 上。 */
const big = 'x'.repeat(2048);
let filled = 0;
for (let i = 0; i < 120; i++) {
  const r = await post('/api/vars', { name: 'x', value: big + i }, 1500);
  if (r.status === 200) filled++;
}
ok('灌日志阶段：写入请求基本都没被拖住（旧代码在这里就开始有个别请求卡死）',
  filled >= 110, `成功 ${filled}/120`);

/* ── 关键断言：管道（控制台）已经满了，接口必须照常返回 ── */
const after = await post('/api/vars', { name: 'x', value: 'after-full' }, 3000);
ok('★ 控制台写不动时，写变量请求仍在 1 秒内返回（后端没跟着卡死）',
  after.status === 200 && after.ms < 1000, JSON.stringify(after));

const dec2 = await post('/api/vars/declare', { variables: [{ name: 'x', type: 'string', value: '' }] }, 3000);
ok('其它接口照常（declare 也返回）', dec2.status === 200, JSON.stringify(dec2).slice(0, 120));

const health = await fetch(base + '/api/health').then(r => r.ok).catch(() => false);
ok('健康检查照常', health === true);

// 收尾：把管道放开（读掉），别让子进程留在"写不动"的状态里
srv.stdout.resume(); srv.stderr.resume();
await sleep(300);
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 控制台卡住不再拖死后端：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
