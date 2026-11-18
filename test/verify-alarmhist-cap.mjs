// verify-alarmhist-cap.mjs — 报警历史控件的**行数上限**（"跑几天越来越卡"那条主线之一）
//
// 背景：报警历史是现场唯一会一直涨的那份数据（历史文件按 5MB 环形封顶，实测一天能到 3 万多条）。
//   这个控件原来是「当天有多少条就建多少个 <tr>」—— `maxRows` 只拿来算滚动区的高度（CSS
//   max-height），**完全没限制画多少行**。而 alarms:changed 每来一次就把整块重建一遍，
//   于是：一天 3 万条 = 每次重绘 3 万次 fmtTime + escapeHtml + 3 万次 DOM 插入，
//   越跑越慢。旁边的「当前报警」控件早就用 LIST_MAX 挡过同一件事，历史这份漏了。
//
// 这里验三件事：
//   ① 一天几千条记录时，真正建出来的 <tr> 是有上限的（HIST_MAX + 1 行提示）；
//   ② 超出的那部分要有一行说明（不能悄悄少给，否则看着像"记录丢了"）；
//   ③ 角上的「共 N 条」仍然是**真实总数**（上限只是不画，不是把数据丢了）。
//
// 用法：node test/verify-alarmhist-cap.mjs [端口]（自己起隔离后端，端口参数忽略）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (n, c, e = '') => {
  results.push({ n, ok: !!c });
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
};

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-ahcap-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });

let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await sleep(300);
  try { await fetch(`http://127.0.0.1:${PORT}/api/health`); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));

// 造多少条：够多到能看出"上限生效"，又不至于让套件跑很久。
// HIST_MAX = 800，所以给 3000 条 —— 没上限的话这里会画出 3000 行。
const N = 3000;

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  // 本套件只测"画多少行"，把后端报警同步掐掉（免得服务器那份掺进来）
  await page.evaluate(() => import('/js/api/backend.js').then(m => {
    m.backend.probe = async () => null;
    m.backend.state = 'offline';
    m.backend.loadAlarms = async () => [];
    m.backend.saveAlarms = async () => ({ ok: true });
    m.backend.expectsServer = () => false;
  }));
  await page.waitForFunction(() => window.app?.project?.data);
  await page.waitForTimeout(300);

  // 放一个「报警历史」控件
  const wid = await page.evaluate(async () => {
    const { project } = await import('/js/core/project.js');
    project.currentPage().widgets.length = 0;
    const w = project.addWidget('alarmHistory', 40);
    project.commit('t');
    return w.id;
  });

  // 往今天塞 N 条（走 localStorage，和真实持久化同一条路）
  await page.evaluate(async (n) => {
    const base = new Date(); base.setHours(1, 0, 0, 0);
    const list = [];
    for (let i = 0; i < n; i++) {
      list.push({ key: 'k' + i, id: 'k' + i, name: '', text: '报警第 ' + i + ' 条',
        level: 'alarm', value: 1, at: base.getTime() + i * 1000, endAt: base.getTime() + i * 1000 + 500, acked: true });
    }
    localStorage.setItem('hmi-alarm-history', JSON.stringify(list));
    const rt = await import('/js/runtime/runtime.js');
    rt.exitRun();
    await rt.enterRun();
  }, N);
  await page.waitForTimeout(1200);

  const read = () => page.evaluate((w) => {
    const root = document.querySelector(`#rtPage .wd[data-id="${w}"]`);
    const trs = [...root.querySelectorAll('.at-table tbody tr')];
    return {
      total: trs.length,
      hint: trs.filter(tr => tr.querySelector('td.almore')).map(tr => tr.textContent.trim()),
      count: root.querySelector('.at-count')?.textContent.trim() || '',
      // 头几行的文字，确认最新那条在最上面
      first: trs[0]?.querySelector('td:nth-child(3)')?.textContent.trim() || '',
    };
  }, wid);

  const r = await read();
  const HIST_MAX = await page.evaluate(() => import('/js/widgets/defs/alarmShared.js')
    .then(m => m.HIST_MAX));
  console.log(`     （HIST_MAX=${HIST_MAX}，塞了 ${N} 条，实际画了 ${r.total} 行）`);

  ok('历史里有 N 条记录（数据没丢）', (await page.evaluate(async () =>
    (await import('/js/runtime/alarms.js')).historyOfDay(Date.now()).length)) === N);

  ok('画出来的行数被上限挡住（不是 N 行）', r.total < N / 2, `${r.total} 行 / 共 ${N} 条`);
  ok('画出来的行数不超过 HIST_MAX + 1（那 1 行是提示行）',
    r.total <= HIST_MAX + 1, `${r.total} 行，上限 ${HIST_MAX}`);
  ok('确实画满了上限（不是索性不画了）', r.total >= HIST_MAX, `${r.total} 行`);

  ok('多出来的部分有一行说明（不静默少给）',
    r.hint.length === 1 && /\d+/.test(r.hint[0]), JSON.stringify(r.hint));
  ok('提示行报的是真实剩余条数',
    r.hint.length === 1 && r.hint[0].includes(String(N - HIST_MAX)),
    JSON.stringify(r.hint));

  ok('角上「共 N 条」仍是真实总数（上限只影响画多少行）',
    r.count === `${N} 条`, `角上显示 ${JSON.stringify(r.count)}`);

  ok('最新的一条排在表格最上面（截的是最早的，不是最新的）',
    /第\s*2999\s*条/.test(r.first), r.first);

  ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 报警历史行数上限：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
