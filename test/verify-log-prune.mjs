// verify-log-prune.mjs — 日志只留最近 3 天，**自动清理**（不用人去删）
//
// 现场机器磁盘不大：日志是排查问题用的，一直堆着没意义（演示工程那段脚本每秒十来行 [var]，
// 一天 1~2MB，挂半年就几百 MB）。规矩：
//   · 只认 `hmi-YYYY-MM-DD.log` / `update-YYYY-MM-DD.log`，**日期从文件名取**（不看 mtime：
//     拷来拷去、备份还原会把 mtime 改掉，文件名不会）；
//   · 保留窗口默认 3 天（今天 + 前两天），可用 HMI_LOG_KEEP_DAYS 调；
//   · 启动时清一次，跨天换文件时再清一次；**别的文件一个都不碰**。
//
// 做法：给后端一个临时日志目录，先摆好"老的/新的/不是日志的"几种文件，起服务后看谁还在。
// 用法：node test/verify-log-prune.mjs [端口]      （端口用不上，套件自己起后端）
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installNodeFetchPatch } from './_wsfetch.mjs';

const PY = process.env.HMI_PY || 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dayStr = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);

const PORT = await freePort();
installNodeFetchPatch(PORT);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-prune-data-'));
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-prune-logs-'));

/* 摆好现场：老的（该删）/ 边界上的（该留）/ 不是日志的（不许动） */
const old1 = `hmi-${dayStr(30)}.log`;        // 30 天前 → 删
const old2 = `hmi-${dayStr(4)}.log`;         // 4 天前 → 删（窗口是"今天 + 前两天"）
const keep1 = `hmi-${dayStr(2)}.log`;        // 前天 → 留
const keep2 = `hmi-${dayStr(1)}.log`;        // 昨天 → 留
const upd = `update-${dayStr(9)}.log`;       // 9 天前的更新日志 → 删
const slogOld = `script-${dayStr(5)}.log`;   // 5 天前的**脚本日志**（hmi.log 落盘那份）→ 删
const slogKeep = `script-${dayStr(1)}.log`;  // 昨天的脚本日志 → 留
const other = 'notes.txt';                   // 不是日志 → 不许动
const weird = 'hmi-备份.log';                 // 名字不合法 → 不许动
for (const f of [old1, old2, keep1, keep2, upd, slogOld, slogKeep, other, weird]) {
  fs.writeFileSync(path.join(LOGS, f), 'x\n');
}

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { /* 等它起来 */ }
}
ok('后端起来了（日志目录被指到临时目录）', up, `logs=${LOGS}`);
await sleep(500);

const left = fs.readdirSync(LOGS).sort();
const has = (f) => left.includes(f);
ok('★ 超窗口的旧日志被自动删掉（30 天前、4 天前）', !has(old1) && !has(old2), JSON.stringify(left));
ok('保留窗口内的日志留着（前天、昨天）', has(keep1) && has(keep2), JSON.stringify(left));
ok('更新日志（update-*.log）走同一套规矩', !has(upd), JSON.stringify(left));
ok('★ 脚本日志（script-*.log，hmi.log 落盘那份）也走同一套：超窗口的删、窗口内的留',
  !has(slogOld) && has(slogKeep), JSON.stringify(left));
ok('不是日志的文件一个都不碰', has(other) && has(weird), JSON.stringify(left));
ok('今天这份日志正常建出来（服务在写）', left.some(f => f === `hmi-${dayStr(0)}.log`), JSON.stringify(left));

/* 清理动作会写一行说明进当天的日志（现场能看出"谁把日志删了"） */
const today = fs.readFileSync(path.join(LOGS, `hmi-${dayStr(0)}.log`), 'utf8');
ok('日志里留了一行"清掉 N 个旧日志"的说明', /\[log\] 清掉 \d+ 个超过 3 天的旧日志/.test(today),
  JSON.stringify(today.split('\n').filter(l => /\[log\]/.test(l)).slice(0, 2)));

/* 保留窗口可调：HMI_LOG_KEEP_DAYS=1 → 只留今天（昨天那份该被删） */
srv.kill();
await sleep(600);
const srv2 = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS, HMI_LOG_KEEP_DAYS: '1' } });
let up2 = false;
for (let i = 0; i < 40 && !up2; i++) {
  await sleep(300);
  try { up2 = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { /* 等它起来 */ }
}
ok('HMI_LOG_KEEP_DAYS=1 时后端照样起得来', up2 === true);
await sleep(400);
const left2 = fs.readdirSync(LOGS).sort();
ok('保留窗口可调（=1 → 昨天那份也被清掉）', !left2.includes(keep2) && !left2.includes(keep1),
  JSON.stringify(left2));
srv2.kill();

try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* 临时目录 */ }

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 日志自动清理（只留最近 3 天）：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
