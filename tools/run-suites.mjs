/**
 * run-suites.mjs — 跑回归套件的小跑腿：**自己起一个隔离后端**（临时数据目录、随机空闲端口），
 * 依次把套件跑完，最后把后端关掉、临时目录删掉。
 *
 * 为什么要它：套件大多用 `node test/verify-x.mjs [端口]` 连一个已在跑的服务 ——
 *   手工起服务容易忘了关，也容易手滑打到 8866 上那套正在用的服务（会覆盖用户自己的存档）。
 *   这里把"起服务/给端口/收尾"都收在一处，跑测试就一条命令。
 *
 * ────────── 选哪些套件（别动不动全量，69 个套件跑一轮十几分钟） ──────────
 *   node tools/run-suites.mjs --changed          ★ 常用：只跑「跟这次改动有关」的套件
 *   node tools/run-suites.mjs --changed --list     只列出来（不跑、不起浏览器，秒回）
 *   node tools/run-suites.mjs verify-input-range   点名跑
 *   node tools/run-suites.mjs                      默认那批（跟变量/属性面板/权限/报警相关的）
 *   node tools/run-suites.mjs --all                全量（发布前 / 大改动）
 *
 *   「哪些改动 → 哪些套件」的对照表在 tools/suite-map.json（改了新东西就顺手挂进去）。
 *
 *   --changed 怎么算"这次改了哪些文件"（都不用你操心，按顺序取第一条能用的）：
 *     ① --since <提交>      → 跟那个提交比（git diff --name-only）
 *     ② 有上次跑测试的记录   → **比"上次跑测试"之后被改过的文件**（按修改时间，最贴合"我刚改了什么"）
 *     ③ 都没有              → git status（工作区 vs HEAD；仓库里堆着别人的改动时会选得多，会提示你）
 *   ★ 上次**没过**的套件会被一直带着跑，直到它通过（改了 A 导致 B 挂了，下次点 A 不会再漏掉 B）。
 *   记录写在 out/.suite-run.json（out/ 不进版本库）。
 *
 *   --changed 会打印是**哪些文件把哪些套件拉进来的**，并提示：没认出来的文件（走兜底）、
 *   没被任何规则覆盖的「孤儿套件」、以及"改动面很大，建议 --all"。
 *
 * ────────── 跑多快（--jobs） ──────────
 *   并行数**默认自动**（本机 16 线程 → 4 路；核少的机器自动退回串行），不用记参数：
 *   并行数是"同时跑几个套件"，**每一路各起一个隔离后端**（自己的端口 + 临时数据目录），互不影响；
 *   套件自己起的模拟器端口也是现取现用。并行时输出**按套件分组**打印（跑完一个打一个），不会搅在一起。
 *   node tools/run-suites.mjs --all --jobs 1       想复现老行为 / 怀疑并行抖动时用串行
 *
 * 其它：
 *   node tools/run-suites.mjs --include-windowed    连会弹原生窗口的也跑（会打断你手上的活）
 *   node tools/run-suites.mjs --since HEAD~1        按"跟某个提交比改了哪些"来选（默认跟 HEAD 比工作区）
 *   node tools/run-suites.mjs --suite-timeout 300   单个套件超时秒数（默认 300，超了连进程树一起杀掉）
 *
 * 说明：套件自己会起后端的那几个（verify-perm / verify-varpicker / verify-widget-split …）
 *   会忽略多出来的端口参数，照旧自己起一套，互不影响。
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 会**在用户桌面上弹东西**的套件：--all / --changed 默认跳过。
 * verify-desktop 的第 1 节就是"真开一个 WebView2 原生窗口"，跑它会在人眼前弹一个窗
 * （现场就反馈过"你怎么把它打开了"）—— 要跑请显式点名或加 --include-windowed。
 */
const WINDOWED = new Set(['verify-desktop']);

const ROOT = path.resolve(import.meta.dirname, '..');
const TESTDIR = path.join(ROOT, 'test');
const MAPFILE = path.join(import.meta.dirname, 'suite-map.json');
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const DEFAULT_SUITES = ['verify-varpicker', 'verify-dtype-lock', 'verify-number', 'verify-arrbind', 'verify-trend',
  'verify-perm', 'verify-alarm', 'verify-alarm-csv', 'verify-project', 'verify-prop-live'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const secs = (ms) => (ms / 1000).toFixed(1) + 's';
const allSuites = () => fs.readdirSync(TESTDIR)
  .filter(f => /^verify-.*\.mjs$/.test(f)).map(f => f.replace(/\.mjs$/, '')).sort();

/* ─────────── 参数 ─────────── */
const argv = process.argv.slice(2);
const flagVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
// 带值的开关后面那个词是**参数**，不是"点名的套件"
const consumed = new Set();
for (const name of ['--since', '--jobs', '--suite-timeout']) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) consumed.add(i + 1);
}
const includeWindowed = argv.includes('--include-windowed');
const onlyList = argv.includes('--list');
const since = flagVal('--since', '');
// 并行数：**默认自动**（核多就并行，核少就老实串行）—— 不传 --jobs 也能快起来；
// 想复现老行为/怀疑并行导致抖动时用 --jobs 1
const AUTO_JOBS = Math.max(1, Math.min(4, Math.floor((os.cpus()?.length || 4) / 4)));
const jobs = Math.max(1, Math.min(8, parseInt(flagVal('--jobs', String(AUTO_JOBS)), 10) || 1));
const suiteTimeoutMs = Math.max(30, parseInt(flagVal('--suite-timeout', '300'), 10) || 300) * 1000;
const named = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i));

/* ─────────── 「改了哪些文件 → 跑哪些套件」 ─────────── */
/** 把 'js/core/**' 这种写法转成正则：** 跨目录，* 不跨目录 */
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;                                     // 吃掉第二个 *
        if (g[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; }   // '**/' = 任意层目录（含零层）
        else re += '[\\s\\S]*';                                // 末尾的 '**' = 后面什么都行
      } else re += '[^/]*';
    } else if ('\\^$.|?+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
/** git 里"这次改了哪些文件"（默认：工作区 + 暂存区 vs HEAD；--since 比某个提交） */
function changedFiles() {
  const args = since ? ['diff', '--name-only', since] : ['status', '--porcelain'];
  let out = '';
  try {
    out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    console.log(`（读不到 git 改动：${e.message} —— --changed 需要 git；也可以直接点名套件）`);
    return null;
  }
  return out.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean)
    .map(l => (since ? l.trim() : l.slice(3).trim()))          // porcelain 前 3 列是状态
    .map(p => (p.includes(' -> ') ? p.split(' -> ').pop() : p)) // 重命名：取新名字
    // 生成物/缓存/日志不算"改动"（out/、logs/、打包产物…；被删掉的老日志也别把套件拉进来）
    .filter(p => p && !p.endsWith('/') && !/^(out|logs|build|release|node_modules|dist)\//.test(p))
    .filter(p => !/\.(log|png|ico|zip|exe|pyc)$/.test(p));
}

/* ── 「上次跑测试」的记录：**按套件**记时间，谁被改过就重跑谁 ──
   为什么按套件记、而不是记一个全局时间：只跑了一个套件（很常见）之后，
   全局时间一往前走，别的**受影响但没跑**的套件就再也选不出来了 —— 那才是真正的漏测。 */
const STAMP = path.join(ROOT, 'out', '.suite-run.json');
// 这些目录不参与"改过没改过"的比对（生成物 / 缓存 / 数据 / 测试报告自己）
const SKIP_DIRS = new Set(['.git', 'out', 'node_modules', 'logs', 'build', 'release', '__pycache__', 'data']);
function readStamp() {
  try {
    const j = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    return (j && typeof j === 'object') ? j : null;
  } catch { return null; }
}
function writeStamp(ran, bad) {
  const old = readStamp() || {};
  const suites = { ...(old.suites || {}) };
  const at = Date.now();
  for (const s of ran) if (!bad.includes(s)) suites[s] = at;   // 只给**过了的**盖章：没过的一直算"脏"，下次自动带上
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, JSON.stringify({ at, suites, failed: [...bad] }, null, 1), 'utf8');
  } catch { /* 写不了就算了（下次退回 git 口径） */ }
}
/** 仓库里所有"算改动"的文件 + 修改时间（跳过生成物/缓存/数据/日志） */
function walkFiles() {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (/\.(pyc|log|png|ico|zip|exe|hmiw)$/.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      out.push([path.relative(ROOT, p).split(path.sep).join('/'), st.mtimeMs]);
    }
  };
  walk(ROOT);
  return out;
}

/** 一个文件会牵动哪些套件（映射表 + "套件自己改了就跑它自己"） */
function suitesForFile(f, map, existing, unknownInMap) {
  const out = new Set();
  for (const rule of map.rules || []) {
    if (!globToRe(rule.match).test(f)) continue;
    for (const s of rule.suites || []) {
      if (!existing.has(s)) { unknownInMap?.add(s); continue; }
      out.add(s);
    }
  }
  const t = /^test\/(verify-[\w.-]+)\.mjs$/.exec(f);
  if (t && existing.has(t[1])) out.add(t[1]);
  return out;
}

/** 按映射表算出「这次该跑哪些套件」 */
function pickChanged() {
  const map = JSON.parse(fs.readFileSync(MAPFILE, 'utf8'));
  const stamp = readStamp();
  const existing = new Set(allSuites());
  const picked = new Map();          // suite → 为什么被拉进来（驱动文件）
  const unknownInMap = new Set();
  const add = (s, why) => {
    if (!picked.has(s)) picked.set(s, []);
    if (why && !picked.get(s).includes(why)) picked.get(s).push(why);
  };
  const files = walkFiles();         // [相对路径, 修改时间]
  const broadHit = [];

  if (since) {
    /* ① 跟某个提交比：改动文件 → 套件（git 口径） */
    const changed = changedFiles();
    if (!changed) return null;
    console.log(`这次改了 ${changed.length} 个文件（口径：git diff --name-only ${since}）`);
    for (const f of changed) for (const s of suitesForFile(f, map, existing, unknownInMap)) add(s, f);
  } else {
    /* ② 默认：**按套件算脏** —— 每个套件跟"它自己上次跑过"比，而不是跟"上次那次跑"比。
       为什么：只跑一个套件是常态；要是拿一个全局时间当基准，别的受影响但没跑的套件
       就再也选不出来了（那才是真正的漏测）。 */
    const drive = new Map();         // suite → [[文件, 时间]…]
    const noOwner = [];              // 没归属到任何套件的文件（会静默漏测，得说出来）
    for (const [f, ms] of files) {
      const ss = suitesForFile(f, map, existing, unknownInMap);
      if (!ss.size) { noOwner.push(f); continue; }
      for (const s of ss) {
        if (!drive.has(s)) drive.set(s, []);
        drive.get(s).push([f, ms]);
      }
    }
    const noOwnerLate = noOwner.filter(f => (files.find(([p]) => p === f)?.[1] || 0) > (stamp?.at || 0));
    if (noOwnerLate.length) {
      console.log(`（这 ${noOwnerLate.length} 个文件没归属到任何套件，改了它们不会自动跑测试：${noOwnerLate.slice(0, 5).join('、')}${noOwnerLate.length > 5 ? ' …' : ''}）`);
    }
    const dirty = [];
    const lateFiles = new Set();
    for (const [s, list] of drive) {
      const ran = stamp?.suites?.[s] || 0;
      const late = list.filter(([, ms]) => ms > ran).map(([f]) => f);
      if (late.length) {
        dirty.push(s);
        late.forEach(f => lateFiles.add(f));
        add(s, late.slice(0, 3).join(' , ') + (late.length > 3 ? ` …(+${late.length - 3})` : ''));
      }
    }
    for (const f of lateFiles) for (const b of map.broad?.match || []) if (globToRe(b).test(f)) broadHit.push(f);
    console.log(`改动口径：每个套件跟"它自己上次跑过"比（仓库里 ${files.length} 个文件、${drive.size} 个套件有归属）`);
  }

  // 上次没过的套件一直带着跑，直到它通过（knownFail 例外，见 tools/suite-map.json）
  const knownFail = new Set(map.knownFail?.suites || []);
  for (const s of (stamp?.failed || [])) {
    if (knownFail.has(s)) continue;
    if (existing.has(s) && !picked.has(s)) add(s, '上次没过，接着跑');
  }

  // 提示（都是"让人看见"的，不拦）
  if (knownFail.size) console.log(`（已知失败、不自动带上：${[...knownFail].join('、')} —— 修好了从 tools/suite-map.json 的 knownFail 里删掉）`);
  if (unknownInMap.size) console.log(`⚠ tools/suite-map.json 里有不存在的套件名（改名了？）：${[...unknownInMap].join('、')}`);
  const covered = new Set((map.rules || []).flatMap(r => r.suites || []));
  const orphans = allSuites().filter(s => !covered.has(s) && !WINDOWED.has(s));
  if (orphans.length) console.log(`⚠ 没被任何规则覆盖的套件（--changed 不会自动选中它们）：${orphans.join('、')}`);
  if (broadHit.length) {
    console.log(`⚠ 这次有 ${broadHit.length} 个"影响面大"的文件被改过（${[...new Set(broadHit)].slice(0, 4).join('、')}${broadHit.length > 4 ? ' …' : ''}）—— 有条件就跑一次 --all`);
  }
  return { list: [...picked.keys()].sort(), why: picked };
}

function resolveList() {
  if (argv.includes('--changed')) {
    const r = pickChanged();
    if (!r) return null;
    console.log('改动 → 套件：');
    for (const s of r.list) console.log(`  · ${s}   ←  ${r.why.get(s).slice(0, 3).join(' , ')}${r.why.get(s).length > 3 ? ` …(+${r.why.get(s).length - 3})` : ''}`);
    if (!r.list.length) console.log('  （没有套件跟这次改动相关）');
    return r.list;
  }
  if (argv.includes('--all')) return allSuites();
  if (named.length) return named;
  return DEFAULT_SUITES;
}

let list = resolveList();
if (!list) process.exit(1);
if (!includeWindowed) {
  const skipped = list.filter(t => WINDOWED.has(t));
  list = list.filter(t => !WINDOWED.has(t));
  if (skipped.length) console.log(`（跳过会弹窗口的套件：${skipped.join('、')} —— 要跑加 --include-windowed）`);
}
const missing = list.filter(t => !fs.existsSync(path.join(TESTDIR, `${t}.mjs`)));
if (missing.length) console.log(`⚠ 没有这些套件（跳过）：${missing.join('、')}`);
list = list.filter(t => !missing.includes(t));

if (onlyList) {
  console.log(`\n共 ${list.length} 个套件：${list.join(' ')}`);
  process.exit(0);
}
if (!list.length) { console.log('没有要跑的套件，收工'); process.exit(0); }

/* ─────────── 隔离后端（每一路一个） ─────────── */
async function startBackend() {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-suites-'));
  const proc = spawn(PY, ['server/server.py', '--port', String(port), '--no-browser', '--no-auth'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: data, HMI_POLL_ALWAYS: '1' } });
  // 等后端起来：V2 没有 /api/health，改成长连接握手（HTTP 只剩静态页和 /api/ws 升级）
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${port}/`); up = r.ok; } catch { /* 等它起来 */ }
  }
  if (!up) { proc.kill(); throw new Error(`后端没起来（port=${port}）`); }
  return {
    port, data, proc,
    stop() { try { proc.kill(); } catch { /* 忽略 */ } try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* 忽略 */ } },
  };
}

/** 跑一个套件；返回 { code, out, ms }。timeout 到点连**整棵进程树**一起杀（Chromium 别留着） */
function runSuite(name, port) {
  const file = path.join(TESTDIR, `${name}.mjs`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      out += `\n!! ${name} 超过 ${suiteTimeoutMs / 1000}s 没跑完 —— 杀掉（套件卡住了？）\n`;
      killTree(p.pid);
    }, suiteTimeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, ms: Date.now() - t0 });
    });
  });
}
function killTree(pid) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 忽略 */ }
}

/* ─────────── 跑 ─────────── */
const bad = [];
const times = [];
const started = Date.now();
const backends = [];
console.log(jobs > 1
  ? `隔离后端 ×${jobs}（每路一个），套件 ${list.length} 个\n`
  : `隔离后端：一套，套件 ${list.length} 个\n`);

try {
  if (jobs === 1) {
    /* 单路：老行为 —— 输出直接透传（边跑边看） */
    const be = await startBackend();
    backends.push(be);
    console.log(`隔离后端：port=${be.port} 数据目录=${be.data}`);
    for (const t of list) {
      console.log(`\n===== ${t} =====`);
      const r = await runSuite(t, be.port);
      process.stdout.write(r.out);
      console.log(`----- ${t}：${r.code === 0 ? '通过' : '失败'}（${secs(r.ms)}）`);
      times.push([t, r.ms]);
      if (r.code !== 0) bad.push(t);
    }
  } else {
    /* 多路：每路一个后端，跑完一个套件打一段（分组输出，不搅在一起） */
    for (let i = 0; i < Math.min(jobs, list.length); i++) backends.push(await startBackend());
    console.log(`隔离后端端口：${backends.map(b => b.port).join(', ')}`);
    const queue = list.slice();
    await Promise.all(backends.map(async (be) => {
      for (;;) {
        const t = queue.shift();
        if (!t) return;
        console.log(`\n===== ${t} =====   (port ${be.port})`);
        const r = await runSuite(t, be.port);
        process.stdout.write(r.out);
        console.log(`----- ${t}：${r.code === 0 ? '通过' : '失败'}（${secs(r.ms)}）`);
        times.push([t, r.ms]);
        if (r.code !== 0) bad.push(t);
      }
    }));
  }
} finally {
  for (const b of backends) b.stop();
}

const total = Date.now() - started;
writeStamp(list, bad);   // 只给**过了的**套件盖章：没过的一直算"脏"，下次 --changed 自动带上
console.log(`\n===== 汇总：${list.length - bad.length}/${list.length} 个套件通过 · 总耗时 ${secs(total)}`
  + `（并行 ${jobs} 路）=====`);
if (times.length > 5) {
  const slow = times.slice().sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, ms]) => `${t} ${secs(ms)}`).join('、');
  console.log(`最慢的三个：${slow}`);
}
if (bad.length) console.log(`没过的：${bad.join('、')}（下次 --changed 会自动带上它们）`);
process.exit(bad.length ? 1 : 0);
