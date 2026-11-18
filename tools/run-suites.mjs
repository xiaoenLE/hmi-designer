/**
 * run-suites.mjs — 跑回归套件的小跑腿：**自己起一个隔离后端**（临时数据目录、随机空闲端口），
 * 依次把套件跑完，最后把后端关掉、临时目录删掉。
 *
 * 为什么要它：套件大多用 `node test/verify-x.mjs [端口]` 连一个已在跑的服务 ——
 *   手工起服务容易忘了关，也容易手滑打到 8866 上那套正在用的服务（会覆盖用户自己的存档）。
 *   这里把"起服务/给端口/收尾"都收在一处，跑测试就一条命令。
 *
 * 用法：
 *   node tools/run-suites.mjs                      # 跑默认这批（跟变量/属性面板/权限/报警相关）
 *   node tools/run-suites.mjs verify-trend verify-number
 *   node tools/run-suites.mjs --all                # 跑 test/ 下所有 verify-*.mjs（**跳过会弹窗的那几个**）
 *   node tools/run-suites.mjs --all --include-windowed   # 连会弹原生窗口的也跑（会打断你手上的活）
 * 说明：套件自己会起后端的那几个（verify-perm / verify-varpicker / verify-dtype-lock …）
 *   会忽略多出来的端口参数，照旧自己起一套，互不影响。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 会**在用户桌面上弹东西**的套件：--all 默认跳过。
 * verify-desktop 的第 1 节就是"真开一个 WebView2 原生窗口"，跑它会在人眼前弹一个窗
 * （现场就反馈过"你怎么把它打开了"）—— 要跑请显式点名或加 --include-windowed。
 */
const WINDOWED = new Set(['verify-desktop']);

const ROOT = path.resolve(import.meta.dirname, '..');
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const args = process.argv.slice(2);
const includeWindowed = args.includes('--include-windowed');
let list = args.filter(a => !a.startsWith('--'));
const named = list.length > 0;                 // 点名跑的就照跑（哪怕它会弹窗）
if (args.includes('--all')) {
  list = fs.readdirSync(path.join(ROOT, 'test'))
    .filter(f => /^verify-.*\.mjs$/.test(f)).map(f => f.replace(/\.mjs$/, '')).sort();
  if (!includeWindowed) {
    const skipped = list.filter(t => WINDOWED.has(t));
    list = list.filter(t => !WINDOWED.has(t));
    if (skipped.length) console.log(`（跳过会弹窗口的套件：${skipped.join('、')} —— 要跑加 --include-windowed）`);
  }
}
if (!named && !args.includes('--all')) {
  list = ['verify-varpicker', 'verify-dtype-lock', 'verify-number', 'verify-arrbind', 'verify-trend',
    'verify-perm', 'verify-alarm', 'verify-alarm-csv', 'verify-project', 'verify-prop-live'];
}

const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-suites-'));
console.log(`隔离后端：port=${PORT} 数据目录=${DATA}`);
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(`http://127.0.0.1:${PORT}/api/health`); up = true; } catch { /* 等它起来 */ }
}
if (!up) { console.log('后端没起来，收工'); srv.kill(); process.exit(1); }

const bad = [];
for (const t of list) {
  const file = path.join(ROOT, 'test', `${t}.mjs`);
  if (!fs.existsSync(file)) { console.log(`\n===== ${t} =====  跳过（没有这个文件）`); bad.push(t); continue; }
  console.log(`\n===== ${t} =====`);
  const code = await new Promise(res => {
    const p = spawn(process.execPath, [file, String(PORT)], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', c => res(c ?? 1));
  });
  if (code !== 0) { bad.push(t); console.log(`!! ${t} 退出码 ${code}`); }
}

srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也无妨 */ }
console.log(`\n===== 汇总：${list.length - bad.length}/${list.length} 个套件通过 =====`);
if (bad.length) console.log(`没过的：${bad.join('、')}`);
process.exit(bad.length ? 1 : 0);
