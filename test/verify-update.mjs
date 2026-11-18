// verify-update.mjs — 版本显示 + 「有新版本」提示 + 「立即更新」入口（对话框这一层）
//   1) 编辑器状态栏常显当前版本号（拿不到版本就不显示，不挂一个「V?」）
//   2) 远端有新版 → 琥珀色「⬆ 有新版本 Vx.y.z」常驻，鼠标停上去有更新说明
//   3) 点徽标 / 工程 ▾ →「检查更新…」都能开说明对话框，说清当前/最新/新版说明/更新方式
//   4) 对话框里的「立即更新」按钮存在；**下载失败时要说清原因、按钮能重试、服务不受影响**
//      （真正的"下载→覆盖→重启→回滚"整条链路在 test/verify-update-apply.py 里测，
//        那要换进程，浏览器里看不到）
//   5) **查不到就彻底安静**：更新接口挂了也不弹错、不挂徽标、不留未捕获异常（现场没外网是常态）
//   6) 运行页（/run）不出现这套东西（客户看不到版本提示）
//
// 用法：先起一个后端，并把更新源指到"有更新但下不到包"的假地址上：
//   （假清单：一个 http 服务，里面放 version.json=9.9.9，**故意不放 archive.zip**）
//   set HMI_UPDATE_URL=http://127.0.0.1:8899/version.json
//   set HMI_UPDATE_ARCHIVE=http://127.0.0.1:8899/archive.zip   ← 故意不存在（测失败提示）
//   python server/server.py --port 8877 --no-browser --no-auth
//   node test/verify-update.mjs 8877
// ⚠ HMI_UPDATE_ARCHIVE 一定要指到假地址：不设的话它默认指向真仓库，
//   点「立即更新」会**真的去下真代码包**（虽然版本对不上会被拒，但别拿真仓库试）。
// ⚠ 假清单的版本号要**比本机 version.json 高**（这里用 9.9.9），否则不会出现「有新版本」。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8877';
const BASE = `http://127.0.0.1:${PORT}`;
// 本机版本号从 version.json 读（别在测试里写死）：发版只改版本清单，测试不用跟着改。
// 假远端固定用一个很高的版本号，这样它永远"比本机新"，不会因为本机升版而让这个套件失效
const LOCAL_VER = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version;
const FAKE_VER = '9.9.9';        // = %TEMP%\hmi-verify-manifest\version.json 里的版本
const has = (s, v) => String(s || '').includes(v);
const verKey = v => String(v || '').split('.').map(n => parseInt(n, 10) || 0);
const verGt = (a, b) => {
  const x = verKey(a), y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });

/** 打开编辑器页面，等启动完成 + 更新检查回来（启动后 3 秒才查，所以要等一会儿） */
async function openEditor({ killUpdateApi = false } = {}) {
  const p = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [], alerts = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
  if (killUpdateApi) await p.route('**/api/update/check*', r => r.abort());
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.app?.project?.data, { timeout: 10000 });
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
    '假清单 %TEMP%\\hmi-verify-manifest\\version.json 的版本号要比本机高');
  await p.waitForFunction(() => !document.getElementById('stUpdate').classList.contains('hidden'),
    { timeout: 15000 }).catch(() => {});
  const bar = await readBar(p);

  ok(`状态栏显示当前版本号（V${LOCAL_VER}）`,
    bar.verVisible && bar.verText === `V${LOCAL_VER}`, bar.verText);
  ok('版本号的鼠标提示里有版本/日期/build/更新源',
    /当前版本/.test(bar.verTitle) && /build/.test(bar.verTitle) && /更新源/.test(bar.verTitle),
    bar.verTitle.split('\n')[0]);
  ok('远端有新版 → 出现「⬆ 有新版本」徽标', bar.upVisible && /有新版本/.test(bar.upText), bar.upText);
  ok('徽标只写版本号（日期留给鼠标提示，状态栏一行别挤）',
    bar.upText === `⬆ 有新版本 V${FAKE_VER}`, bar.upText);
  ok('徽标是琥珀色（醒目但不刺眼）', bar.upColor === 'rgb(217, 119, 6)', bar.upColor);
  ok('徽标的鼠标提示里有「当前 → 最新」、日期和"可以在这台机器上更新"',
    has(bar.upTitle, LOCAL_VER) && has(bar.upTitle, FAKE_VER) && /2099-01-01/.test(bar.upTitle)
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
  ok('对话框里说清 当前版本 / 新版版本 / 新版说明',
    has(dlg1.body, LOCAL_VER) && has(dlg1.body, FAKE_VER) && /测试用的假新版/.test(dlg1.body));
  ok('对话框写明「只覆盖程序文件」且会跳过 server/data（现场数据不动）',
    /只覆盖程序文件/.test(dlg1.body) && /server\/data/.test(dlg1.body));
  ok('对话框写明"起不来自动用更新前的备份回滚"', /起不来自动用更新前的备份回滚/.test(dlg1.body));
  ok('对话框给出更新源和仓库链接', /version\.json/.test(dlg1.body) && /124\.221\.183\.24/.test(dlg1.html));
  ok(`对话框里有「立即更新到 V${FAKE_VER}」按钮`, has(dlg1.updBtn, `立即更新到 V${FAKE_VER}`), dlg1.updBtn);

  // 点「立即更新」：这个测试环境里代码包地址是**故意不存在**的 → 必须把失败原因说清楚，
  // 而且按钮要能重试、服务要照常活着（不能点一下就没了）
  await p.click('#updGo');
  await p.waitForFunction(() => /下载代码包失败|请求没成功|没有更新/.test(
    (document.getElementById('updPanel') || {}).textContent || ''), { timeout: 20000 })
    .catch(() => {});
  const after = await p.evaluate(() => ({
    panel: (document.getElementById('updPanel') || {}).textContent || '',
    btn: (document.getElementById('updGo') || {}).textContent || '',
    btnDisabled: !!(document.getElementById('updGo') || {}).disabled,
  }));
  ok('下载不到代码包 → 对话框里说清原因（不是干等或静默）',
    /下载代码包失败/.test(after.panel) && /404/.test(after.panel), after.panel.slice(0, 60));
  ok('失败后按钮还能再试（不是卡在"正在更新…"）', /再试一次/.test(after.btn) && !after.btnDisabled, after.btn);
  const health = await p.evaluate(async () => (await (await fetch('/api/health')).json()).ok);
  ok('更新失败后服务照常活着（没被点坏）', health === true);
  await p.click('#dlgOk');
  await p.waitForTimeout(200);

  // 工程 ▾ →「检查更新…」（人主动点：忽略缓存当场拉一次）
  await p.click('#btnProjMenu');
  await p.waitForSelector('#ctxMenu .ctx-item', { timeout: 3000 });
  const item = await p.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .map(b => b.textContent.trim()).find(t => t.includes('检查更新')));
  ok(`工程菜单里有「检查更新…（当前 V${LOCAL_VER}）」`, !!item && has(item, `V${LOCAL_VER}`), item || '(没有这一项)');
  await p.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .find(b => b.textContent.includes('检查更新')).click());
  await p.waitForSelector('#dlgMask:not(.hidden)', { timeout: 8000 });
  const dlg2 = await p.evaluate(() => document.getElementById('dlgBody').textContent);
  ok(`菜单点开的对话框照样说「有新版本 V${FAKE_VER}」`, has(dlg2, FAKE_VER));
  await p.click('#dlgOk');

  ok('整个过程没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  ok('整个过程没有弹 alert（版本提示走状态栏/对话框，不打断操作）', alerts.length === 0, alerts.join(' | '));

  await p.screenshot({ path: 'test/update-check.png', clip: { x: 0, y: 860, width: 1500, height: 40 } });
  await p.close();
}

/* ══════ 4. 查不到就彻底安静（现场没外网）══════ */
{
  const { p, errs, alerts } = await openEditor({ killUpdateApi: true });
  await p.waitForTimeout(5000);            // 等过启动后那次检查
  const bar = await readBar(p);
  ok('更新接口挂了 → 版本号照常显示', bar.verVisible && /^V\d/.test(bar.verText), bar.verText);
  ok('更新接口挂了 → 不挂「有新版本」徽标（安静）', !bar.upVisible, bar.upText);
  ok('更新接口挂了 → 不弹任何 alert', alerts.length === 0, alerts.join(' | '));
  ok('更新接口挂了 → 不留未捕获异常', errs.length === 0 && (await p.evaluate(() => window.__appErrors.length)) === 0,
    errs.slice(0, 2).join(' | '));
  await p.close();
}

/* ══════ 5. 运行页不出现这套东西 ══════ */
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
  ok('运行页不显示「有新版本」徽标', st.up === '' && st.upHidden !== false, `[${st.up}]`);
  await p.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 版本显示 / 更新提示：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
