// verify-script-logs.mjs — 脚本日志「看得见 + 留得住」
//
// 现场问题：脚本里的 hmi.log 以前**只活在浏览器内存里**（每条脚本最近 60 行）——
//   刷新就没、退出运行态就没，而运行页（/run）上连看都看不见：出了事一点痕迹都没有。
// 现在两件事：
//   ① **落盘**：运行态把日志按批送给后端，后端写 logs/script-YYYY-MM-DD.log
//      （按天、只留最近 3 天、单请求行数/单行长度/每天体积三道上限，前端还有按脚本的限速）
//   ② **运行态能看**：Ctrl+Shift+J 的「脚本日志」面板（内存实时 + 服务器历史按天翻）
//      外加「脚本连续出错自动停用」的提醒条（以前现场只会看到"这脚本怎么不干活了"）
//
// 用法：node test/verify-script-logs.mjs   （自己起独立数据目录+独立日志目录的后端）
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
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-slog-data-'));
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-slog-logs-'));
const TODAY = new Date().toISOString().slice(0, 10);
const slogFile = path.join(LOGS, `script-${TODAY}.log`);
// ⚠ Windows 上写出去的是 CRLF（Python 文本模式），按行断言前先把 \r 去掉
const readSlog = () => { try { return fs.readFileSync(slogFile, 'utf8').replace(/\r/g, ''); } catch { return ''; } };
const slogLines = () => readSlog().split('\n').filter(Boolean);

/** 起后端（起过的都记进 spawned：收尾要杀干净再删临时目录，不然 Windows 上会撞文件占用） */
const spawned = [];
const spawnSrv = (env) => {
  const p = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS, ...env } });
  spawned.push(p);
  return p;
};

let srv = spawnSrv({});
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { if ((await fetch(H + '/api/health')).ok) up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

/* ═══════════ 1. 后端接口本身（不用浏览器先验一遍） ═══════════ */
const post = async (body) => (await fetch(H + '/api/scriptlog', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const r1 = await post({ lines: [
  { t: Date.now(), name: '产量脚本', level: 'log', text: "hmi.log('本班产量', 12)" },
  { t: Date.now(), name: '报警联动', level: 'warn', text: '状态变了：1' },
] });
ok('POST /api/scriptlog：一次收两行、写进 script-日期.log', r1.ok && r1.written === 2, JSON.stringify(r1));
const raw1 = readSlog();
ok('文件里是一行一条、格式 [时间] [脚本名] [级别] 正文',
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[产量脚本\] \[log\] hmi\.log\('本班产量', 12\)$/m.test(raw1),
  JSON.stringify(raw1.split('\n').slice(0, 2)));

await post({ lines: [{ name: '脏数据', level: 'log', text: 'a\nb\tc' }] });
ok('正文里的换行/制表符换成空格（一条记录只占一行，不然文件是乱的）',
  /\[脏数据\] \[log\] a b c/.test(readSlog()), JSON.stringify(readSlog().split('\n').slice(-2)));
await post({ lines: [{ name: 'na]me[', level: 'LOG', text: '方括号[1] 照原样' }] });
ok('脚本名里的方括号换成圆括号（字段解析不会串）、级别统一小写、正文里的方括号照原样',
  /\[na\)me\(\] \[log\] 方括号\[1\] 照原样/.test(readSlog()), JSON.stringify(slogLines().slice(-1)));

/* 单行长度截断 + 单请求行数上限 */
const long = 'x'.repeat(5000);
const r2 = await post({ lines: [{ name: '长行', level: 'log', text: long }] });
ok('单行超长被截断（不会一行几 MB）', r2.written === 1 && /x{500}…/.test(readSlog()), `written=${r2.written}`);
const many = await post({ lines: Array.from({ length: 500 }, (_, i) => ({ name: '批量', level: 'log', text: 'n' + i })) });
ok('单请求行数上限（500 行只收 200 行，其余算丢弃）',
  many.written === 200 && many.dropped === 300, JSON.stringify(many));
const bigBody = await fetch(H + '/api/scriptlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [{ text: 'x'.repeat(700 * 1024) }] }) });
ok('请求体过大直接拒（413），不往内存里读', bigBody.status === 413, String(bigBody.status));

/* ═══════════ 2. 读回来（GET，按天） ═══════════ */
const got = await (await fetch(`${H}/api/scriptlog?limit=400`)).json();
ok('GET /api/scriptlog 读回最近几行（结构化：时间/脚本名/级别/正文）',
  got.ok && got.lines.length > 5 && got.lines[0].at && got.lines[0].name !== undefined
  && got.lines.some(l => l.name === '产量脚本' && l.level === 'log'),
  JSON.stringify({ n: got.lines.length, last: got.lines.slice(-1) }));
ok('读回来的正文不带 "\\r"（CRLF 文件按行切开时要收拾干净）',
  got.lines.every(l => !/\r/.test(l.text)), JSON.stringify(got.lines.slice(-1)));
const gotTail = await (await fetch(`${H}/api/scriptlog?limit=3`)).json();
ok('limit 生效（要 3 行就给 3 行）', gotTail.lines.length === 3, String(gotTail.lines.length));
ok('返回里带「哪几天有日志」+ 文件大小（界面做按天翻看、也知道文件多大）',
  Array.isArray(got.days) && got.days.includes(TODAY) && got.size > 0, JSON.stringify({ days: got.days, size: got.size }));
ok('★ 每天体积上限默认 10MB（可在「日志设置…」里改，最大 100MB —— 接口里也能核对）',
  got.max_mb === 10 && got.hard_mb === 100, JSON.stringify({ max_mb: got.max_mb, hard_mb: got.hard_mb }));
const missing = await (await fetch(`${H}/api/scriptlog?date=2020-01-01&limit=5`)).json();
ok('那天没有日志 → 空列表（不是报错）', missing.ok === true && missing.lines.length === 0, JSON.stringify(missing.lines));

/* 每天体积上限：调到最小（0.5MB）重启一个后端来验，别真写 100MB */
srv.kill();
await sleep(600);
const srvCap = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS, HMI_SCRIPTLOG_MAX_MB: '0.5' } });
for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(H + '/api/health')).ok) break; } catch { /* 等 */ } }
const capCfg = await (await fetch(`${H}/api/scriptlog?limit=1`)).json();
ok('HMI_SCRIPTLOG_MAX_MB 能往小调（盘小就调小，这里 0.5MB）',
  capCfg.max_mb === 0.5 && capCfg.hard_mb === 100, JSON.stringify({ max_mb: capCfg.max_mb, hard_mb: capCfg.hard_mb }));
let capped = null;
for (let i = 0; i < 12 && !capped; i++) {
  const r = await post({ lines: Array.from({ length: 200 }, () => ({ name: '灌满', level: 'log', text: 'y'.repeat(400) })) });
  if (r.capped) capped = r;
}
ok('每天体积到上限 → 当天不再记，并且写一行说明（绝不把盘写满）',
  !!capped && capped.capped === true, JSON.stringify(capped));
ok('到上限时那一行说明进了文件（现场看得出"后面为什么没有了"）',
  /今天的脚本日志已到上限（0\.5 MB）/.test(readSlog()),
  JSON.stringify(readSlog().split('\n').filter(l => /上限/.test(l)).slice(0, 1)));
srvCap.kill();
await sleep(600);

/* 硬上限：env 想调大也得被压回 100MB（"最大 100MB"这句话得在所有情况下成立） */
const srvBig = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS, HMI_SCRIPTLOG_MAX_MB: '9999' } });
for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(H + '/api/health')).ok) break; } catch { /* 等 */ } }
const bigCfg = await (await fetch(`${H}/api/scriptlog?limit=1`)).json();
ok('★ 想把上限调到 9999MB 也会被压回 100MB（最大就是 100MB）',
  bigCfg.max_mb === 100 && bigCfg.hard_mb === 100, JSON.stringify({ max_mb: bigCfg.max_mb }));
srvBig.kill();
await sleep(600);

/* ═══════════ 2b. 软件里能设置这两个参数（工程 ▾ → 日志设置…） ═══════════
   设置存在**服务器**上（server/data/settings.json），取值顺序：界面 > 环境变量 > 默认。
   改完**立刻生效、不用重启后端**（这是这节最要紧的一条）。用独立的数据/日志目录，别搅到后面浏览器那一节 */
const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-slog-set-'));
const LOGS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-slog-setlogs-'));
const setFile = path.join(DATA2, 'settings.json');
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const spawnSet = (env = {}) => spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA2, HMI_LOG_DIR: LOGS2, ...env } });
const waitUp = async () => { for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(H + '/api/health')).ok) return true; } catch { /* 等 */ } } return false; };
const getSet = async () => (await fetch(`${H}/api/logsettings`)).json();
const postSet = async (patch) => (await fetch(`${H}/api/logsettings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
})).json();

let srvSet = spawnSet();
await waitUp();
const s0 = await getSet();
ok('GET /api/logsettings：默认 保留 3 天 / 脚本日志每天 10MB，还带范围、兜底值、日志目录现状',
  s0.ok && s0.keep_days === 3 && s0.scriptlog_max_mb === 10
  && Array.isArray(s0.limits?.keep_days) && s0.usage && typeof s0.usage.bytes === 'number'
  && /logs/.test(s0.usage.dir || ''),
  JSON.stringify({ keep: s0.keep_days, mb: s0.scriptlog_max_mb, limits: s0.limits, usage: s0.usage }));

// 摆两个"超期"文件（3 天前），看改小保留天数会不会**当场**清掉
const oldScript = path.join(LOGS2, `script-${dayAgo(3)}.log`);
const oldHmi = path.join(LOGS2, `hmi-${dayAgo(3)}.log`);
fs.writeFileSync(oldScript, 'x\n');
fs.writeFileSync(oldHmi, 'x\n');

const rSet = await postSet({ keep_days: 1, scriptlog_max_mb: 20 });
ok('POST /api/logsettings：存进去并回报生效值（顺手清掉过期日志）',
  rSet.ok && rSet.keep_days === 1 && rSet.scriptlog_max_mb === 20 && rSet.pruned >= 2,
  JSON.stringify({ keep: rSet.keep_days, mb: rSet.scriptlog_max_mb, pruned: rSet.pruned }));
ok('保留天数改小 → **当场**把超期的删掉（不用重启后端）',
  !fs.existsSync(oldScript) && !fs.existsSync(oldHmi), JSON.stringify(fs.readdirSync(LOGS2)));
ok('设置写进了服务器上的 settings.json（换浏览器打开也是同一份）',
  fs.existsSync(setFile) && JSON.parse(fs.readFileSync(setFile, 'utf8')).log_keep_days === 1,
  fs.existsSync(setFile) ? fs.readFileSync(setFile, 'utf8').replace(/\s+/g, ' ') : 'MISSING');

// 上限改小也**立刻**生效：灌 1MB 就该被拦住（0.5MB 上限是我们这就改的，后端没重启过）
await postSet({ scriptlog_max_mb: 0.5 });
let capped2 = null;
for (let i = 0; i < 8 && !capped2; i++) {
  const r = await post({ lines: Array.from({ length: 200 }, () => ({ name: '灌满', level: 'log', text: 'z'.repeat(400) })) });
  if (r.capped) capped2 = r;
}
ok('★ 上限在界面上改成 0.5MB → 立刻生效（后端没重启过）',
  !!capped2 && capped2.capped === true, JSON.stringify(capped2));

// 重启后端：设置还在（存的是文件，不是内存）
srvSet.kill();
await sleep(700);
srvSet = spawnSet();
await waitUp();
const s1 = await getSet();
ok('重启后端后设置还在（界面里设过的优先于默认值）',
  s1.keep_days === 1 && s1.scriptlog_max_mb === 0.5, JSON.stringify({ keep: s1.keep_days, mb: s1.scriptlog_max_mb }));
srvSet.kill();
await sleep(700);

// 没在界面上设过时，环境变量兜底
fs.rmSync(setFile, { force: true });
srvSet = spawnSet({ HMI_LOG_KEEP_DAYS: '5', HMI_SCRIPTLOG_MAX_MB: '7' });
await waitUp();
const s2 = await getSet();
ok('界面上没设过 → 按环境变量兜底（HMI_LOG_KEEP_DAYS=5 / HMI_SCRIPTLOG_MAX_MB=7）',
  s2.keep_days === 5 && s2.scriptlog_max_mb === 7, JSON.stringify({ keep: s2.keep_days, mb: s2.scriptlog_max_mb }));
const s3 = await postSet({ keep_days: 2, scriptlog_max_mb: 3 });
const s4 = await getSet();
ok('★ 界面里设过之后以界面为准（不再跟着环境变量走）',
  s3.ok && s4.keep_days === 2 && s4.scriptlog_max_mb === 3, JSON.stringify({ keep: s4.keep_days, mb: s4.scriptlog_max_mb }));
const s5 = await postSet({ keep_days: 999, scriptlog_max_mb: 9999 });
ok('★ 界面上乱填也会被夹回合法范围（保留 ≤30 天、上限 ≤100MB）',
  s5.ok && s5.keep_days === 30 && s5.scriptlog_max_mb === 100, JSON.stringify({ keep: s5.keep_days, mb: s5.scriptlog_max_mb }));
srvSet.kill();
await sleep(700);

// 要管理员：开着登录闸门的后端上，这两个接口一个都不放行（免得客户机偷看/偷改）
const DATA3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-slog-auth-'));
const srvAuth = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA3, HMI_LOG_DIR: LOGS2 } });
await waitUp();
const gateGet = await fetch(`${H}/api/logsettings`);
const gatePost = await fetch(`${H}/api/logsettings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"keep_days":1}' });
ok('★ 没登录时：读/改日志设置都被挡（401）',
  gateGet.status === 401 && gatePost.status === 401, `${gateGet.status} / ${gatePost.status}`);
srvAuth.kill();
await sleep(700);

/* ═══════════ 3. 浏览器：脚本真的写、后端真的有、运行态看得见 ═══════════ */
const srv2 = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS } });
for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await fetch(H + '/api/health')).ok) break; } catch { /* 等 */ } }
fs.rmSync(slogFile, { force: true });        // 从干净的文件开始看浏览器这一路

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* 造一个脚本：进运行态跑一次就写四行日志（含 warn）*/
const prep = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.newProject('blank');
  project.data.scripts.length = 0;
  project.data.variables.push({ name: 'nCount', type: 'int', address: '', value: 0, len: 0 });
  project.addScript({
    name: '日志脚本', trig: 'init', variable: '',
    code: ["hmi.log('脚本起来了')", "hmi.g.n = (hmi.g.n || 0) + 1", "hmi.warn('第', hmi.g.n, '次')",
      "hmi.log('数组 arrw[3] 也照原样')"].join('\n'),
  });
  project.commit('日志测试');
  return project.scripts().length;
});
ok('准备：一条会在进运行态时写日志的脚本', prep === 1, String(prep));

await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(1500);                                   // 让脚本跑 + 让批（600ms 一批）送出去

const written = readSlog();
ok('★ 脚本里的 hmi.log/warn 真的落到服务器文件里了',
  /\[日志脚本\] \[log\] 脚本起来了/.test(written) && /\[日志脚本\] \[warn\] 第 1 次/.test(written),
  JSON.stringify(written.split('\n').filter(Boolean).slice(0, 3)));
ok('正文里的方括号照原样（arrw[3] 不会被改坏）', /数组 arrw\[3\] 也照原样/.test(written),
  JSON.stringify(written.split('\n').filter(l => /arrw/.test(l))));

/* 运行态「脚本日志」面板：Ctrl+Shift+J 打开，内容对得上 */
await page.keyboard.press('Control+Shift+J');
await sleep(500);
const panel = await page.evaluate(() => {
  const p = document.getElementById('rtLogPanel');
  return {
    visible: p && !p.classList.contains('rt-hidden'),
    lines: [...document.querySelectorAll('#rtlList .rtl-line')].map(el => el.textContent.replace(/\s+/g, ' ').trim()),
    count: document.getElementById('rtlCount')?.textContent || '',
    who: document.querySelector('#rtlList .rtl-who')?.textContent || '',
  };
});
ok('★ 运行态 Ctrl+Shift+J 打开「脚本日志」面板，能看到脚本名与内容',
  panel.visible && panel.lines.some(l => /脚本起来了/.test(l)) && /日志脚本/.test(panel.who),
  JSON.stringify({ visible: panel.visible, who: panel.who, count: panel.count }));
ok('warn 那行也在（级别分了颜色：warn/error 各一套）',
  panel.lines.some(l => /第 1 次/.test(l)), JSON.stringify(panel.lines.slice(0, 4)));

/* 面板切「服务器历史」：读的是落盘那份 */
await page.evaluate(() => document.getElementById('rtlHist').click());
await sleep(700);
const hist = await page.evaluate(() => ({
  date: document.getElementById('rtlDay')?.textContent || '',
  note: document.querySelector('#rtlList .rtl-note')?.textContent.replace(/\s+/g, ' ').trim() || '',
  lines: [...document.querySelectorAll('#rtlList .rtl-line')].map(el => el.textContent.replace(/\s+/g, ' ').trim()),
  liveBtn: !document.getElementById('rtlLive')?.classList.contains('hidden'),
}));
ok('★ 面板里点「服务器历史」→ 读出落盘那份（写明是哪天的哪个文件）',
  /script-\d{4}-\d{2}-\d{2}\.log/.test(hist.note) && hist.date.length >= 8
  && hist.lines.some(l => /脚本起来了/.test(l)) && hist.liveBtn,
  JSON.stringify({ date: hist.date, note: hist.note.slice(0, 60) }));

/* ═══════════ 4. 脚本连续出错自动停用 → 现场看得见 ═══════════ */
const broke = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const rt = await import('/js/runtime/runtime.js');
  project.addScript({ name: '会出错', trig: 'cycle', variable: '', code: "hmi.set('nope', 1);\nthrow new Error('炸了');" });
  project.commit('加坏脚本');
  rt.exitRun(); rt.enterRun();                 // 引擎在运行态不认新脚本 → 重进一次
  return true;
});
await sleep(1200);
// 重进运行态后面板是收起的、且回到"实时"那一份 → 按一次快捷键打开来看
await page.keyboard.press('Control+Shift+J');
await sleep(500);
const disableUi = await page.evaluate(() => ({
  alarmVisible: !document.getElementById('rtScriptAlarm')?.classList.contains('hidden'),
  alarmText: document.getElementById('rtScriptAlarmText')?.textContent || '',
  badge: document.getElementById('rtlBadge')?.textContent || '',
  badgeHidden: document.getElementById('rtlBadge')?.classList.contains('hidden'),
  flow: document.querySelector('#rtlList .rtl-note')?.textContent.replace(/\s+/g, ' ').trim() || '',
}));
ok('★ 脚本连续出错被自动停用 → 运行画面挂提醒条（现场不再只是"怎么不干活了"）',
  disableUi.alarmVisible && /会出错/.test(disableUi.alarmText), JSON.stringify(disableUi.alarmText));
ok('★ 脚本日志面板头上有「N 个脚本已停用」徽标，面板里也写了是哪条、什么原因',
  !disableUi.badgeHidden && /已停用/.test(disableUi.badge) && /会出错/.test(disableUi.flow),
  JSON.stringify({ badge: disableUi.badge, flow: disableUi.flow.slice(0, 60) }));

/* 停用这件事同样落了盘（事后查得到） */
const afterDisable = readSlog();
ok('★ 停用的那条也落盘了（脚本日志里有"已自动停用这条脚本"）',
  /已自动停用这条脚本/.test(afterDisable) && /运行错误/.test(afterDisable),
  JSON.stringify(afterDisable.split('\n').filter(l => /停用|运行错误/.test(l)).slice(0, 2)));

/* ═══════════ 5. 限速：狂写日志也不会把后端/磁盘打爆 ═══════════ */
const flood = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const rt = await import('/js/runtime/runtime.js');
  project.addScript({
    name: '刷屏', trig: 'interval', ms: 10, variable: '',
    code: "hmi.log('刷屏刷屏刷屏刷屏刷屏刷屏刷屏刷屏刷屏刷屏', hmi.now())",
  });
  project.commit('刷屏脚本');
  rt.exitRun(); rt.enterRun();
  return true;
});
await sleep(2500);
const floodRes = await page.evaluate(async () => {
  const e = await import('/js/runtime/scriptEngine.js');
  const rt = await import('/js/runtime/runtime.js');
  rt.exitRun();                                  // 退出运行态会把最后一批冲出去
  const st = e.scriptLogsAll(500);
  return { dropped: st.dropped };
});
await sleep(800);
// ⚠ 数**行数**，不是数文本里出现了几次"刷屏"（那一行正文本身就带 10 个）
const floodLines = slogLines().filter(l => /\[刷屏\]/.test(l)).length;
ok('★ 10ms 一次的刷屏脚本：限速生效（前端按脚本 20 行/秒 + 突发），落盘行数被压住',
  floodLines > 0 && floodLines < 200, `落盘 ${floodLines} 行（脚本在 2.5 秒里想写 ~250 行）`);
ok('★ 丢了就如实说（面板上写"因限速/上限丢了 N 行"），不装作没丢',
  floodRes.dropped > 0, JSON.stringify(floodRes));

/* ═══════════ 5.5 hmi.logNo：只在内存里看，**永远不落盘** ═══════════ */
const noSave = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const rt = await import('/js/runtime/runtime.js');
  project.data.scripts.length = 0;
  const s = project.addScript({
    name: '调试脚本', trig: 'interval', ms: 1000, variable: '',
    code: ["hmi.logNo('调试输出 A', hmi.v.nCount)",
      "hmi.log('这条要留痕')",
      "hmi.logNo('调试输出 B')"].join('\n'),
  });
  project.commit('调试脚本');
  rt.exitRun(); rt.enterRun();
  await new Promise(r => setTimeout(r, 1400));
  const all = e.scriptLogsAll(200, { dbg: true });
  const noDbg = e.scriptLogsAll(200);
  const perScript = e.scriptLog(s.id).map(l => `${l.level}:${l.text}`);
  rt.exitRun();                                  // 退出时会把没送出的那批冲出去，正好验"没送 logNo"
  return { all: all.lines.map(l => `${l.level}:${l.text}`), dbgCount: all.dbg,
           shown: noDbg.lines.map(l => l.level), hiddenDbg: noDbg.dbg, perScript };
});
ok('★ hmi.logNo 的输出在内存日志里（试运行/面板看得到），级别是 dbg',
  noSave.dbgCount >= 2 && noSave.all.some(l => /^dbg:调试输出 A/.test(l))
  && noSave.all.some(l => /^dbg:调试输出 B/.test(l)),
  JSON.stringify({ dbg: noSave.dbgCount, all: noSave.all.slice(0, 4) }));
ok('脚本自己的日志（编辑器「试运行」那个日志区拿的就是它）里也有 dbg 行',
  noSave.perScript.some(l => /^dbg:调试输出 A/.test(l)) && noSave.perScript.some(l => /^log:这条要留痕/.test(l)),
  JSON.stringify(noSave.perScript.slice(0, 5)));
ok('运行态面板默认**不显示** dbg（免得现场画面上全是调试噪音），但会告诉你有几行',
  !noSave.shown.includes('dbg') && noSave.hiddenDbg >= 2,
  JSON.stringify({ shown: noSave.shown, hidden: noSave.hiddenDbg }));
await sleep(900);                                // 等最后一批（如果有）落盘
const splog = readSlog();
ok('★★ logNo 的内容**一个字都没进日志文件**（"这条要留痕"进了）',
  !/调试输出 A|调试输出 B/.test(splog) && /这条要留痕/.test(splog),
  JSON.stringify(splog.split('\n').filter(l => /调试|留痕/.test(l)).slice(0, 3)));

/* dbg 打再多也不能把真日志挤出内存（满了先丢最旧的调试输出） */
const ring = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  project.data.scripts.length = 0;
  const s = project.addScript({
    name: '刷屏调试', trig: 'interval', ms: 1000, variable: '',
    code: ["hmi.log('真日志 1')", "for (let i = 0; i < 90; i++) hmi.logNo('调试', i)", "hmi.log('真日志 2')"].join('\n'),
  });
  project.commit('刷屏调试');
  e.runScriptOnce(s.id);
  const lines = e.scriptLog(s.id).map(l => l.level);
  return { n: lines.length, dbg: lines.filter(x => x === 'dbg').length, hasLog1: e.scriptLog(s.id).some(l => l.text === '真日志 1'),
           hasLog2: e.scriptLog(s.id).some(l => l.text === '真日志 2') };
});
ok('★ 一口气打 90 行 logNo：内存只留 60 行，且**真日志没被挤掉**（先丢调试输出）',
  ring.n <= 60 && ring.hasLog1 && ring.hasLog2 && ring.dbg >= 50, JSON.stringify(ring));

/* 面板上勾「调试」就看得见 */
const dbgUi = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const rt = await import('/js/runtime/runtime.js');
  rt.enterRun();
  // ⚠ 别等定时器（脚本 ms=1000，等 900ms 会飘）：直接跑一次，日志立刻就在内存里
  const id = project.scripts()[0]?.id;
  if (id) e.runScriptOnce(id);
  await new Promise(r => setTimeout(r, 300));
  rt.setLogVisible(true);
  await new Promise(r => setTimeout(r, 300));
  const before = [...document.querySelectorAll('#rtlList .rtl-line')].map(el => el.className);
  // ⚠ 面板上可能同时挂着别的说明行（比如"因限速丢了 N 行"），要把所有 note 都扫一遍
  const notesBefore = [...document.querySelectorAll('#rtlList .rtl-note')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
  const box = document.getElementById('rtlDbg');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const after = [...document.querySelectorAll('#rtlList .rtl-line')].map(el => el.className);
  return { before, after, notesBefore };
});
ok('★ 面板上勾「调试」→ hmi.logNo 的行就出来了（之前是灰的、还写着"还有几行调试输出"）',
  !dbgUi.before.some(c => /dbg/.test(c)) && dbgUi.after.some(c => /dbg/.test(c))
  && dbgUi.notesBefore.some(t => /调试输出/.test(t)),
  JSON.stringify({ before: dbgUi.before.slice(0, 3), after: dbgUi.after.slice(0, 3),
    notes: dbgUi.notesBefore.map(t => t.slice(0, 30)) }));

/* 编辑器里也能看到（API 速查 + ? 帮助里都有它） */
const docHas = await page.evaluate(async () => {
  const m = await import('/js/editor/scriptEditor.js');
  m.initScriptEditor(); m.openScriptEditor();
  await new Promise(r => setTimeout(r, 200));
  const rows = [...document.querySelectorAll('#seDoc .se-doc-row')].map(r => r.dataset.insert);
  document.getElementById('seHelp').click();
  await new Promise(r => setTimeout(r, 250));
  const help = [...document.querySelectorAll('#dlgBody .api-help-row')].map(r => r.querySelector('code')?.textContent || '');
  const eg = [...document.querySelectorAll('#dlgBody .api-help-row')]
    .filter(r => /hmi\.logNo/.test(r.querySelector('code')?.textContent || ''))
    .map(r => r.querySelector('.api-help-eg')?.textContent || '')[0] || '';
  document.getElementById('dlgX')?.click();
  return { rows, help, eg };
});
ok('★ API 速查里有 hmi.logNo，帮助里有它的一条（写明"不落盘"）与能直接抄的例子',
  docHas.rows.some(r => /hmi\.logNo/.test(r))
  && docHas.help.some(h => /hmi\.logNo/.test(h)) && /logNo/.test(docHas.eg),
  JSON.stringify({ rows: docHas.rows.filter(r => /logNo/.test(r)), eg: docHas.eg.slice(0, 50) }));

/* ═══════════ 5.6 内存与卡顿：日志**不会全进内存**，刷屏也不该把面板画爆 ═══════════
   两条硬账：
     · 内存里每条脚本只留 60 行（环形缓冲）—— 落盘那 100MB 跟内存**一点关系都没有**；
     · 面板重画是**合并刷新**（最多 250ms 一次）：脚本 10ms 打一行（≈100 行/秒），
       旧写法每行重画一次 = 一秒重建 100 次 200 行 DOM，主线程会被吃掉。
   测法：用 MutationObserver 数 `#rtlList` 真的被重建了几次。 */
const perf = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const rt = await import('/js/runtime/runtime.js');
  const ta = document.getElementById('seCode');
  if (ta) { ta.value = ''; }                      // 编辑器日志区别掺进来
  (await import('/js/editor/scriptEditor.js')).closeScriptEditor?.();
  project.data.scripts.length = 0;
  project.addScript({
    name: '狂刷', trig: 'interval', ms: 10, variable: '',
    code: "hmi.logNo('刷屏刷屏刷屏刷屏', hmi.now())\nhmi.log('真日志', hmi.now())",
  });
  project.commit('狂刷');
  rt.exitRun(); rt.enterRun();
  rt.setLogVisible(true);
  await new Promise(r => setTimeout(r, 400));
  // 数面板重建次数
  let rebuilds = 0;
  const obs = new MutationObserver(muts => { if (muts.some(m => m.type === 'childList')) rebuilds++; });
  obs.observe(document.getElementById('rtlList'), { childList: true });
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, 2000));
  obs.disconnect();
  const secs = (performance.now() - t0) / 1000;
  // 这段时间里脚本到底打了多少行（内存日志按 60 行封顶）
  const st = e.scriptLogsAll(500, { dbg: true });
  const rows = document.querySelectorAll('#rtlList .rtl-line').length;
  rt.exitRun();
  return { rebuilds, secs: Math.round(secs * 10) / 10, rows, dbg: st.dbg, memLines: st.lines.length };
});
ok('★ 狂刷 2 秒：面板只重建了很少几次（合并刷新，不是每行一次）',
  perf.rebuilds > 0 && perf.rebuilds <= Math.ceil(perf.secs / 0.25) + 2,
  JSON.stringify(perf));
ok('★ 内存里只留 60 行（不是把日志全攒在内存里；落盘那 100MB 跟内存无关）',
  perf.memLines <= 200 && perf.dbg <= 60, JSON.stringify({ memLines: perf.memLines, dbg: perf.dbg }));
ok('面板 DOM 行数有上限（最多画 200 行，不会随日志量无限长）',
  perf.rows > 0 && perf.rows <= 200, String(perf.rows));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

/* ═══════════ 6. 软件里的入口：工程 ▾ →「日志设置…」对话框 ═══════════ */
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).exitRun());
await sleep(300);
const dlgOpened = await page.evaluate(async () => {
  (await import('/js/editor/logSettings.js')).openLogSettings();
  await new Promise(r => setTimeout(r, 600));
  return {
    open: !document.getElementById('dlgMask')?.classList.contains('hidden'),
    title: document.getElementById('dlgTitle')?.textContent || '',
    keep: document.getElementById('logKeep')?.value,
    mb: document.getElementById('logMb')?.value,
    hint: (document.querySelector('#dlgBody .dlg-hint')?.textContent || '').replace(/\s+/g, ' ').trim(),
    hasDir: /logs/.test(document.getElementById('dlgBody')?.textContent || ''),
  };
});
ok('★ 对话框能打开，两个参数都在（当前值回显）+ 写明现状与目录',
  dlgOpened.open && dlgOpened.keep && dlgOpened.mb && dlgOpened.hasDir,
  JSON.stringify(dlgOpened));
const dlgSaved = await page.evaluate(async () => {
  document.getElementById('logKeep').value = '7';
  document.getElementById('logMb').value = '12';
  document.getElementById('dlgOk').click();
  await new Promise(r => setTimeout(r, 700));
  const s = await (await import('/js/api/backend.js')).backend.logSettings();
  return { keep: s?.keep_days, mb: s?.scriptlog_max_mb, closed: document.getElementById('dlgMask')?.classList.contains('hidden') };
});
ok('★ 在对话框里改完点「保存」→ 真的存到服务器（再读回来就是新值）',
  dlgSaved.keep === 7 && dlgSaved.mb === 12, JSON.stringify(dlgSaved));
const menuHas = await page.evaluate(async () => {
  // 「工程 ▾」菜单里真要有这一项（现场找不到入口等于没有）——把菜单打开，看菜单项文字
  document.getElementById('btnProjMenu').click();
  await new Promise(r => setTimeout(r, 250));
  const items = [...document.querySelectorAll('#ctxMenu .ctx-item')].map(i => i.textContent.trim());
  document.getElementById('ctxMenu')?.classList.add('hidden');
  return items.find(t => /日志设置/.test(t)) || '';
});
ok('★ 「工程 ▾」菜单里真有「日志设置…」这一项（不是只有代码里有）',
  /日志设置/.test(menuHas), JSON.stringify(menuHas));

console.log(`\n==== 脚本日志（落盘 + 运行态可见）：${results.filter(r => r.ok).length}/${results.length} 通过 ====`);
await browser.close();
for (const p of spawned) { try { p.kill(); } catch { /* 已经死了 */ } }
await sleep(900);            // ⚠ 等子进程真退掉再删临时目录/退出：Windows 上撞着文件占用会崩（踩过）
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* 临时目录 */ }
try { fs.rmSync(DATA2, { recursive: true, force: true }); fs.rmSync(DATA3, { recursive: true, force: true }); fs.rmSync(LOGS2, { recursive: true, force: true }); } catch { /* 临时目录 */ }
process.exit(results.some(r => !r.ok) ? 1 : 0);
