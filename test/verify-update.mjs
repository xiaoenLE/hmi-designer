// verify-update.mjs — 版本显示 + 「有新版本」提示 + 「立即更新」入口（对话框这一层）
//   1) 编辑器状态栏常显当前版本号（拿不到版本就不显示，不挂一个「V?」）
//   2) 远端有新版 → 琥珀色「⬆ 有新版本 Vx.y.z」常驻，鼠标停上去有更新说明
//   3) 点徽标 / 工程 ▾ →「检查更新…」都能开对话框，说清：当前版本 / 新版本号+日期 / 新版说明
//      ⚠ **流程细节（下载→覆盖→重启→回滚）、更新源地址、仓库链接都不摆在这个对话框里** ——
//        现场嫌那些跟"到底改了什么"混在一起看不清（维护者要看就调 /api/update/check）。
//   4) 对话框里的「立即更新」按钮存在；**下载失败时要说清原因、按钮能重试、服务不受影响**
//      （真正的"下载→覆盖→重启→回滚"整条链路在 test/verify-update-apply.py 里测，那要换进程）
//   5) **查不到就彻底安静**：更新接口挂了也不弹错、不挂徽标、不留未捕获异常（现场没外网是常态）
//   6) 运行页（/run）不加载编辑器这套状态栏提示（客户看不到版本号/编辑器徽标；
//      运行页自己的右下角更新徽标是另一套，见 verify-run-update）
//
// **套件自己起后端 + 自己起假更新源**（以前要人工先摆一套环境，`--all` 里跑不了）：
//   · 假清单：本地 http 服务，version.json 写 9.9.9（永远比本机新）+ 假日期 2099-01-01
//   · HMI_UPDATE_ARCHIVE 指向**故意不存在**的包地址 → 专门验"下载失败要把原因说清、还能重试"
//   · 数据目录是临时目录，不碰现场数据；不设 HMI_UPDATE_URL 时它默认指真仓库，所以必须设
// 用法：node test/verify-update.mjs     （端口参数用不上：套件自己起后端）
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
import { wsHealth } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = process.env.HMI_PY || 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
// 本机版本号从 version.json 读（别在测试里写死）：发版只改版本清单，测试不用跟着改。
// 假远端固定用一个很高的版本号，这样它永远"比本机新"，不会因为本机升版而让这个套件失效
const LOCAL_VER = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version;
const FAKE_VER = '9.9.9';
const FAKE_DATE = '2099-01-01';
const has = (s, v) => String(s || '').includes(v);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const verKey = v => String(v || '').split('.').map(n => parseInt(n, 10) || 0);
const verGt = (a, b) => {
  const x = verKey(a), y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};

/* ── 假更新源：清单有、代码包**故意不放**（点「立即更新」必然 404）── */
const MANIFEST = {
  app: 'WebHMI_设计器', version: FAKE_VER, date: FAKE_DATE,
  notes: '测试用的假新版：只在验证"有新版本"提示时用', url: '',
};
const FAKE_PORT = await freePort();
const fake = http.createServer((rq, rs) => {
  if (rq.url.startsWith('/version.json')) {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return rs.end(JSON.stringify(MANIFEST));
  }
  rs.writeHead(404, { 'Content-Type': 'text/plain' });
  rs.end('not found');
});
await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));

/* ── 自带后端（环境变量指向假更新源）── */
const PORT = await freePort();
installNodeFetchPatch(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-update-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'], {
  cwd: ROOT, stdio: 'ignore',
  env: {
    ...process.env, HMI_DATA_DIR: DATA,
    HMI_UPDATE_URL: `http://127.0.0.1:${FAKE_PORT}/version.json`,
    HMI_UPDATE_ARCHIVE: `http://127.0.0.1:${FAKE_PORT}/archive.zip`,   // 故意不存在
  },
});
let up = false;
for (let i = 0; i < 40 && !up; i++) { await sleep(300); try { up = (await wsHealth(PORT)).ok; } catch { /* 等它起来 */ } }

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
ok('后端起来了（更新源指向本地假清单）', up, `port=${PORT} manifest=http://127.0.0.1:${FAKE_PORT}/version.json`);

const browser = await chromium.launch({ executablePath: EXE });

/** 打开编辑器页面，等启动完成 + 更新检查回来（启动后 3 秒才查，所以要等一会儿） */
async function openEditor({ killUpdateApi = false } = {}) {
  const p = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [], alerts = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
  /* 「更新源挂了」在 2.0 里得换个办法模拟：1.x 前端是自己 fetch 更新清单的（abort 那条路由就行），
     2.0 是**后端**去拉清单、前端只问长连接 —— 拦页面的路由一点用都没有。
     这里直接把前端的 checkUpdate 换成一个必定失败的实现（3 秒后才跑第一次，来得及换）。 */
  if (killUpdateApi) await p.addInitScript(() => {
    window.__killUpdateApi = true;
  });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.app?.project?.data, { timeout: 10000 });
  if (killUpdateApi) {
    await p.evaluate(async () => {
      const m = await import('/js/api/backend.js');
      m.backend.checkUpdate = async () => { throw new Error('更新源连不上（测试模拟）'); };
    });
  }
  return { p, errs, alerts };
}

const readBar = p => p.evaluate(() => {
  const v = document.getElementById('stVersion');
  const u = document.getElementById('stUpdate');
  const vis = el => !!el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 0;
  return {
    verText: v?.textContent || '', verVisible: vis(v), verTitle: v?.title || '',
    upText: u?.textContent || '', upVisible: vis(u), upTitle: u?.title || '',
    upColor: u ? getComputedStyle(u).color : '',
  };
});

/* ══════ 1~3. 有新版本：版本号 + 徽标 + 两个入口的对话框 ══════ */
{
  const { p, errs, alerts } = await openEditor();
  ok(`测试前提：假远端（V${FAKE_VER}）比本机（V${LOCAL_VER}）新`, verGt(FAKE_VER, LOCAL_VER),
    `本机 V${LOCAL_VER} / 假清单 V${FAKE_VER}`);
  await p.waitForFunction(() => !document.getElementById('stUpdate').classList.contains('hidden'),
    { timeout: 20000 }).catch(() => {});
  const bar = await readBar(p);

  ok(`状态栏显示当前版本号（V${LOCAL_VER}）`,
    bar.verVisible && bar.verText === `V${LOCAL_VER}`, bar.verText);
  ok('版本号的鼠标提示里有版本/日期/build，并说明点它=检查更新',
    /当前版本/.test(bar.verTitle) && /build/.test(bar.verTitle) && /点这里 = 检查更新/.test(bar.verTitle),
    bar.verTitle.split('\n')[0]);
  ok('版本号的鼠标提示里**不再堆更新源地址**（维护者要看就调 /api/update/check）',
    !/更新源/.test(bar.verTitle), JSON.stringify(bar.verTitle.split('\n').slice(0, 5)));
  ok('远端有新版 → 出现「⬆ 有新版本」徽标', bar.upVisible && /有新版本/.test(bar.upText), bar.upText);
  ok('徽标只写版本号（日期留给鼠标提示，状态栏一行别挤）',
    bar.upText === `⬆ 有新版本 V${FAKE_VER}`, bar.upText);
  ok('徽标是琥珀色（醒目但不刺眼）', bar.upColor === 'rgb(217, 119, 6)', bar.upColor);
  ok('徽标的鼠标提示里有「当前 → 最新」（含日期）和"可以直接在这台机器上更新"',
    has(bar.upTitle, LOCAL_VER) && has(bar.upTitle, FAKE_VER) && has(bar.upTitle, FAKE_DATE)
    && /可以直接在这台机器上更新/.test(bar.upTitle), bar.upTitle.split('\n').pop());

  // 点徽标 → 说明对话框
  await p.click('#stUpdate');
  await p.waitForSelector('#dlgMask:not(.hidden)', { timeout: 3000 });
  const dlg1 = await p.evaluate(() => ({
    title: document.getElementById('dlgTitle').textContent,
    body: document.getElementById('dlgBody').textContent,
    html: document.getElementById('dlgBody').innerHTML,
    updBtn: (document.getElementById('updGo') || {}).textContent || '',
  }));
  ok('点徽标 → 弹出「有新版本可用」对话框', dlg1.title === '有新版本可用', dlg1.title);
  ok('对话框里说清 当前版本 / 新版本号+日期 / 新版说明',
    has(dlg1.body, LOCAL_VER) && has(dlg1.body, FAKE_VER) && has(dlg1.body, FAKE_DATE)
    && /测试用的假新版/.test(dlg1.body));
  // 只讲"这次改了什么"：流程细节/更新源/仓库链接都不在这儿（现场嫌混在一起看不清）
  ok('对话框里不再堆流程细节与更新源（只讲这次更新了什么）',
    !/只覆盖程序文件/.test(dlg1.body) && !/server\/data/.test(dlg1.body)
    && !/版本\.json/.test(dlg1.body) && !/version\.json/.test(dlg1.body),
    dlg1.body.replace(/\s+/g, ' ').slice(0, 80));
  ok(`对话框里有「立即更新到 V${FAKE_VER}」按钮`, has(dlg1.updBtn, `立即更新到 V${FAKE_VER}`), dlg1.updBtn);

  // 点「立即更新」：这个测试环境里代码包地址是**故意不存在**的 → 必须把失败原因说清楚，
  // 而且按钮要能重试、服务要照常活着（不能点一下就没了）
  await p.click('#updGo');
  await p.waitForFunction(() => /下载代码包失败|请求没成功|没有更新/.test(
    (document.getElementById('updPanel') || {}).textContent || ''), { timeout: 25000 })
    .catch(() => {});
  const after = await p.evaluate(() => ({
    panel: (document.getElementById('updPanel') || {}).textContent || '',
    btn: (document.getElementById('updGo') || {}).textContent || '',
    btnDisabled: !!(document.getElementById('updGo') || {}).disabled,
  }));
  ok('下载不到代码包 → 对话框里说清原因（不是干等或静默）',
    /HTTP 404/.test(after.panel), after.panel.slice(0, 90));
  ok('失败后按钮还能再试（不是卡在"正在更新…"）', /再试一次/.test(after.btn) && !after.btnDisabled, after.btn);
  // 2.0 没有 /api/health 了：探活 = 连一次长连接读 hello（Node 侧做，别在页面里 fetch）
  const health = await wsHealth(PORT).then(h => h.ok === true).catch(() => false);
  ok('更新失败后服务照常活着（没被点坏）', health === true);
  await p.click('#dlgOk');
  await p.waitForTimeout(200);

  // 工程 ▾ →「检查更新…」（人主动点：忽略缓存当场拉一次）
  await p.click('#btnProjMenu');
  await p.waitForSelector('#ctxMenu .ctx-item', { timeout: 3000 });
  const item = await p.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .map(b => b.textContent.trim()).find(t => t.includes('检查更新')));
  ok('工程菜单里有「检查更新…」这一项（版本号挂在状态栏，菜单上不重复写）',
    item === '检查更新…', item || '(没有这一项)');
  await p.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .find(b => b.textContent.includes('检查更新')).click());
  await p.waitForSelector('#dlgMask:not(.hidden)', { timeout: 8000 });
  const dlg2 = await p.evaluate(() => ({
    title: document.getElementById('dlgTitle').textContent,
    body: document.getElementById('dlgBody').textContent,
  }));
  ok(`菜单点开的对话框照样说「V${FAKE_VER}」`, has(dlg2.body, FAKE_VER), dlg2.body.slice(0, 60));
  ok('人主动点开的那次标题是「检查更新」（不是"有新版本可用"）', dlg2.title === '检查更新', dlg2.title);
  await p.click('#dlgOk');

  ok('整个过程没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  ok('整个过程没有弹 alert（版本提示走状态栏/对话框，不打断操作）', alerts.length === 0, alerts.join(' | '));

  await p.screenshot({ path: 'out/update-check.png', clip: { x: 0, y: 860, width: 1500, height: 40 } });
  await p.close();
}

/* ══════ 4. 查不到就彻底安静（现场没外网）══════ */
{
  const { p, errs, alerts } = await openEditor({ killUpdateApi: true });
  await p.waitForTimeout(5000);            // 等过启动后那次检查（它在 3 秒后才跑）
  const bar = await readBar(p);
  ok('更新接口挂了 → 版本号照常显示', bar.verVisible && /^V\d/.test(bar.verText), bar.verText);
  ok('更新接口挂了 → 不挂「有新版本」徽标（安静）', !bar.upVisible, bar.upText);
  ok('更新接口挂了 → 不弹任何 alert', alerts.length === 0, alerts.join(' | '));
  ok('更新接口挂了 → 不留未捕获异常', errs.length === 0 && (await p.evaluate(() => window.__appErrors.length)) === 0,
    errs.slice(0, 2).join(' | '));
  await p.close();
}

/* ══════ 5. 运行页不出现编辑器这套状态栏（运行页有自己那套，见 verify-run-update） ══════ */
{
  const p = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await p.goto(BASE + '/run', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);            // 编辑器那套延时 3 秒才跑，运行页压根不该跑
  const st = await p.evaluate(() => ({
    runOnly: window.app?.runOnly === true,
    ver: document.getElementById('stVersion')?.textContent || '',
    up: document.getElementById('stUpdate')?.textContent || '',
    upHidden: document.getElementById('stUpdate')?.classList.contains('hidden'),
  }));
  ok('/run 确实是运行页', st.runOnly === true);
  ok('运行页不显示版本号（客户看不到）', st.ver === '', `[${st.ver}]`);
  ok('运行页不出现编辑器状态栏的版本号/徽标（客户看不到编辑器那套）', st.ver === '' && st.up === '' && st.upHidden !== false, `[${st.ver}] [${st.up}]`);
  await p.close();
}

await browser.close();
srv.kill();
fake.close();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 版本显示 / 更新提示：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
