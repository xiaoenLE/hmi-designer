// verify-trend.mjs — 波形控件：多通道绑定 / 采样 / 绘制 / 量程 / 抓取控制
//                   + 导出 CSV / 双 Y 轴（XY 曲线模式已移除，改用独立「XY 波形」控件）
// 用法：
//   node test/verify-trend.mjs                 自己拉起一个独立数据目录的后端（随机端口，不碰 8866）
//   node tools/run-suites.mjs verify-trend     run-suites 起好后端，把端口作为参数传进来
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* 隔离后端：run-suites 会把端口当第一个参数传进来（那个后端它自己管）；单独跑就自己起一套，
   数据目录用临时目录 —— 绝不碰 8866 上正在用的那套。 */
const argPort = String(process.argv[2] || '').trim();
let PORT = 0, ownSrv = null, ownData = '';
if (/^\d+$/.test(argPort)) {
  PORT = +argPort;
} else {
  PORT = await freePort();
  ownData = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-trend-'));
  ownSrv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: ownData } });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); up = r.ok; } catch { /* 等它起来 */ }
  }
  if (!up) {
    console.log('FAIL  隔离后端没起来');
    try { ownSrv.kill(); } catch { /* 忽略 */ }
    try { fs.rmSync(ownData, { recursive: true, force: true }); } catch { /* 忽略 */ }
    process.exit(1);
  }
}
const cleanupBackend = () => {
  try { if (ownSrv) ownSrv.kill(); } catch { /* 忽略 */ }
  try { if (ownData) fs.rmSync(ownData, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanupBackend);                  // 中途抛异常也别把后端/临时目录留下

const URL = `http://127.0.0.1:${PORT}/`;
installNodeFetchPatch(URL);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('console', m => { if (/trend|绘制/.test(m.text())) console.log('CONSOLE:', m.text()); });

async function boot() {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.waitForTimeout(250);
}
/** 读某控件各通道缓冲（数量 + 首尾值）*/
const series = id => page.evaluate(i => {
  const out = {};
  window.app.trend.seriesOf(i).forEach((arr, k) => {
    out[k] = { n: arr.length, first: arr[0]?.v, last: arr[arr.length - 1]?.v };
  });
  return out;
}, id);
/** 画布非背景像素占比（判断"真的画出东西了"）*/
const inkRatio = sel => page.evaluate(s => {
  const cv = document.querySelector(s);
  if (!cv) return -1;
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let diff = 0, total = 0;
  for (let i = 0; i < d.length; i += 4 * 37) {          // 抽样即可
    total++;
    if (d[i + 3] > 24) diff++;
  }
  return diff / total;
}, sel);

/* ══════ 1. 工具箱里有波形控件，能拖到画布 ══════ */
await boot();
// ⚠ 波形要按**变量名**填 8 路通道，名字不能靠种子工程（内置模板会换）：这里自己摆好这张小表。
//   顺便把这些量从模板自带的仿真脚本里摘出来 —— 脚本每 500ms 写的量，会把本套件设的值冲掉。
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  m.data.variables.length = 0;
  [['bRunCmd', 'bool', '%MX0.0', false], ['rSpeed', 'real', '%MW100', 0],
   ['iCount', 'int', '%MW104', 0], ['bRun', 'bool', '%MX0.1', false]].forEach(([name, type, address, value]) => {
    m.data.variables.push({ name, type, address, value });
  });
  m.commit('波形套件用的变量表');
  vs.resetFrom(m.variables());
});
await page.waitForTimeout(200);
const toolbox = await page.evaluate(() => [...document.querySelectorAll('#toolboxList .tb-item')].map(e => e.textContent.trim()));
ok('控件库出现「波形」条目', toolbox.some(t => t.includes('波形')), toolbox.slice(-1)[0]);
const n0 = await page.evaluate(() => window.app.project.currentWidgets().length);
await page.locator('.tb-item', { hasText: '波形' }).first().dragTo(page.locator('#canvas'));
await page.waitForTimeout(300);
const wid = await page.evaluate(() => window.app.project.currentWidgets().slice(-1)[0].id);
ok('拖放创建波形控件', await page.evaluate(() => window.app.project.currentWidgets().length) === n0 + 1);
ok('控件里有 canvas 画布', await page.evaluate(id => !!document.querySelector(`#canvas .wd[data-id="${id}"] canvas.trend-cv`), wid));

/* ══════ 2. 属性面板：固定 8 路（未选 = 停用）══════ */
const chanRows = await page.evaluate(() => document.querySelectorAll('#propBody .chan-row').length);
const slots = await page.evaluate(() => document.querySelectorAll('#propBody [data-chanslot]').length);
ok('属性面板固定 8 路通道槽位', chanRows === 8 && slots === 8, `行数=${chanRows} 槽位数=${slots}`);
ok('面板标题显示 0/8', /（0\/8）/.test(await page.evaluate(() =>
  [...document.querySelectorAll('#propBody .prop-group-title')].map(e => e.textContent).join('|'))));
ok('未选变量的槽位颜色输入是禁用态', await page.evaluate(() =>
  [...document.querySelectorAll('#propBody [data-chancolor]')].every(i => i.disabled === true)));
// 依次给 3 个槽位填变量（变量格 = 输入框 + 候选表，回车确认 = 真实输入路径）
for (const [slot, name] of [[0, 'bRunCmd'], [1, 'rSpeed'], [2, 'iCount']]) {
  const sel = `#propBody [data-chanslot="${slot}"]`;
  await page.click(sel);
  await page.fill(sel, name);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
}
ok('每路一个变量格，填好后写入 bindings.variables（8 槽位，空串=未使用）',
  JSON.stringify(await page.evaluate(id => window.app.project.getWidget(id).bindings.variables, wid))
    === JSON.stringify(['bRunCmd', 'rSpeed', 'iCount', '', '', '', '', '']),
  JSON.stringify(await page.evaluate(id => window.app.project.getWidget(id).bindings.variables, wid)));
ok('标题计数跟着变（3/8）', /（3\/8）/.test(await page.evaluate(() =>
  [...document.querySelectorAll('#propBody .prop-group-title')].map(e => e.textContent).join('|'))));
ok('填过的槽位颜色输入变为可用', await page.evaluate(() =>
  document.querySelector('#propBody [data-chancolor]').disabled === false));
ok('同一变量不能重复占路（候选行里注明「已在通道2」）', await page.evaluate(async () => {
  const inp = document.querySelector('#propBody [data-chanslot="3"]');
  inp.focus();
  await new Promise(r => setTimeout(r, 150));
  const row = [...document.querySelectorAll('.vp-list .vp-row')]
    .find(r => r.querySelector('.vp-name')?.textContent === 'rSpeed');
  const note = row?.querySelector('.vp-note')?.textContent || '';
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return /已在通道2/.test(note);
}));
ok('出现「通道量程」区（倍率/偏置，只列已用的路）', await page.evaluate(() => document.querySelectorAll('#propBody .scale-row').length) === 3);

/* ══════ 2b. 控制变量：抓取控制（启动抓取 / 清除数据）══════
   现场要的：不设变量 = 一直抓；设了就用变量开抓 / 清数据。
   （原 XY 模式的「X 轴变量」已随 XY 模式移除，这一组只剩两个抓取控制变量。） */
const ctlRows = await page.evaluate(() => {
  const g = [...document.querySelectorAll('#propBody .prop-group')]
    .find(x => /控制变量/.test(x.querySelector('.prop-group-title')?.textContent || ''));
  return {
    has: !!g,
    labels: [...(g?.querySelectorAll('.f-label') || [])].map(e => e.textContent.trim()),
    keys: [...(g?.querySelectorAll('[data-bind]') || [])].map(e => e.dataset.bind),
    titles: Object.fromEntries([...(g?.querySelectorAll('[data-bind]') || [])]
      .map(e => [e.dataset.bind, e.getAttribute('title') || ''])),
    hint: g?.textContent || '',
  };
});
ok('★ 属性里「控制变量」一组只剩 启动抓取 / 清除数据 两个变量格（X 轴变量已移除）',
  ctlRows.has
  && JSON.stringify(ctlRows.labels) === JSON.stringify(['启动抓取', '清除数据'])
  && JSON.stringify(ctlRows.keys) === JSON.stringify(['startVar', 'clearVar'])
  && ctlRows.keys.indexOf('xVar') < 0,
  JSON.stringify(ctlRows));
ok('★ 这一组里**不摆说明文字**（现场要求）；口径在输入格的悬停提示里',
  !/一直抓/.test(ctlRows.hint) && /一直抓/.test(ctlRows.titles.startVar)
  && /从 0 变 1/.test(ctlRows.titles.clearVar),
  JSON.stringify([ctlRows.hint.replace(/\s+/g, ' ').slice(0, 40), ctlRows.titles]));
// 填一个**非 bool** 变量 → 当场标红说明（拿数值变量当开关 = 静默失效）
const badStart = await page.evaluate(async () => {
  const inp = document.querySelector('#propBody [data-bind="startVar"]');
  inp.value = 'rSpeed';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  return { bad: inp.classList.contains('bad'), title: inp.title };
});
ok('★ 启动抓取填了非 bool 变量 → 标红并说明（不能拿数值变量当开关）',
  badStart.bad === true && /要 bool/.test(badStart.title), JSON.stringify(badStart));
// 填对（bool）→ 写进 bindings.startVar / bindings.clearVar
await page.evaluate(async () => {
  const put = (k, v) => {
    const inp = document.querySelector(`#propBody [data-bind="${k}"]`);
    inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };
  put('startVar', 'bRunCmd');
  put('clearVar', 'bRunCmd');
  await new Promise(r => setTimeout(r, 300));
});
const ctlSaved = await page.evaluate(id => {
  window.app.project.commit('t');
  const b = window.app.project.getWidget(id).bindings;
  return { start: b.startVar, clear: b.clearVar };
}, wid);
ok('★ 两个变量分别写进 bindings.startVar / clearVar（各存各的，不串）',
  ctlSaved.start === 'bRunCmd' && ctlSaved.clear === 'bRunCmd', JSON.stringify(ctlSaved));
// 变量要进采集范围：不采就永远是 undefined → 永远开不了 / 清不掉
const ctlScope = await page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  const names = rt.pageVarScope();          // 当前采集范围的变量名（本页 + 报警 + 波形，含抓取控制）
  return { has: names.includes('bRunCmd'), trend: rt.scopeSummary().trend, names };
});
ok('★ 抓取控制变量也在采集范围里（不采就永远读不到值）',
  ctlScope.has === true && ctlScope.trend >= 1, JSON.stringify(ctlScope.names).slice(0, 140));
// 这两格**清回空**再往下走：后面几节验的是"没设变量 = 一直抓"的老行为
await page.evaluate(id => {
  const w = window.app.project.getWidget(id);
  delete w.bindings.startVar;
  delete w.bindings.clearVar;
  window.app.project.commit('清掉抓取控制（回到一直抓）');
}, wid);

/* ══════ 3. 编辑态：静态预览（还没运行也能看到样式）══════ */
const rafProbe = await page.evaluate(() => new Promise(res => {
  const t0 = performance.now();
  const t = setTimeout(() => res(-1), 1500);            // rAF 一直不来也要有结论（-1 = 压根没帧）
  requestAnimationFrame(() => { clearTimeout(t); res(Math.round(performance.now() - t0)); });
}));
await page.waitForTimeout(400);                          // 给逐帧绘制一点时间
const previewInk = await inkRatio(`#canvas .wd[data-id="${wid}"] canvas.trend-cv`);
const previewDiag = await page.evaluate(async id => {
  const t = await import('/js/runtime/trend.js');
  const m = window.app.project;
  const cv = document.querySelector(`#canvas .wd[data-id="${id}"] canvas.trend-cv`);
  const wd = cv?.closest('.wd');
  return {
    chans: t.channelsOf(m.getWidget(id)).map(c => c.name),
    vars: m.variables().map(v => v.name).slice(0, 8),
    cv: cv ? { w: cv.width, h: cv.height } : null,
    wdId: wd?.dataset?.id || null,
    found: !!m.findWidget(wd?.dataset?.id || ''),
    nCv: document.querySelectorAll('.trend-cv').length,
  };
}, wid);
ok('编辑态画出预览曲线（不是空白画布）', previewInk > 0.02,
  `raf=${rafProbe}ms ink=${previewInk.toFixed(3)} ${JSON.stringify(previewDiag)}`);

/* ══════ 4. 运行态：按采样周期抓取多个通道 ══════ */
await page.evaluate(id => {
  const w = window.app.project.getWidget(id);
  w.props.windowSec = 6; w.props.sampleMs = 100;
  window.app.project.commit('t');
}, wid);
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(60);                       // 只等一小会：一进运行态就采样，等 400ms 早就有数据了
const emptyAtStart = await series(wid);
ok('刚进运行态时缓冲是空的（重新开始抓）',
  Object.values(emptyAtStart).every(s => s.n <= 1), JSON.stringify(emptyAtStart));
// 持续改值 1.2 秒
for (let k = 0; k < 12; k++) {
  await page.evaluate(i => {
    window.app.varStore.set('rSpeed', 10 + i, 'local');
    window.app.varStore.set('iCount', 100 * i, 'local');
    window.app.varStore.set('bRunCmd', i % 2 === 0, 'local');
  }, k);
  await page.waitForTimeout(100);
}
const s1 = await series(wid);
ok('三个通道都在同时抓取', Object.keys(s1).length === 3, JSON.stringify(Object.keys(s1)));
ok('每通道样本数接近 采样时长/采样周期（≈12）',
  Object.values(s1).every(s => s.n >= 8 && s.n <= 20), JSON.stringify(s1));
ok('抓到的是变化后的值（首≠尾）',
  s1.rSpeed.first !== s1.rSpeed.last || s1.iCount.first !== s1.iCount.last, JSON.stringify({ r: s1.rSpeed, i: s1.iCount }));
ok('布尔通道按 0/1 记录',
  [0, 1].includes(s1.bRunCmd.first) && [0, 1].includes(s1.bRunCmd.last), JSON.stringify(s1.bRunCmd));
ok('运行态画面真的画出了曲线（非背景像素占比 > 3%）',
  await inkRatio('#rtPage canvas.trend-cv') > 0.03, `ink=${(await inkRatio('#rtPage canvas.trend-cv')).toFixed(3)}`);

/* ══════ 5. 时间窗口：超出窗口的旧数据被裁掉 ══════ */
const trim = await page.evaluate(async id => {
  const w = window.app.project.getWidget(id);
  w.props.windowSec = 2; w.props.sampleMs = 50;      // 2 秒窗口
  window.app.project.commit('t');
  await new Promise(r => setTimeout(r, 2600));        // 灌 2.6 秒数据
  const arr = window.app.trend.seriesOf(id).get('rSpeed') || [];
  const span = arr.length ? (arr[arr.length - 1].t - arr[0].t) : 0;
  return { n: arr.length, spanMs: Math.round(span) };
}, wid);
ok('缓冲只保留时间窗口内的数据（≈2s，不会无限增长）',
  trim.spanMs <= 2600 && trim.spanMs >= 1400, JSON.stringify(trim));

/* ══════ 5.5 点数硬上限：窗口/采样是属性面板里的数字，怎么填都不能把内存撑爆 ══════
   最坏填法 = 窗口拉满 600s、采样拉到最小 20ms，那是每通道 3 万点（8 路 24 万点、一个控件十几 MB，
   而且每帧要遍历全部点重画）。做法：窗口越长采样周期自动放宽，保证每通道 ≤ 3000 点。 */
const cap = await page.evaluate(async id => {
  const w = window.app.project.getWidget(id);
  w.props.windowSec = 600; w.props.sampleMs = 20;    // 最坏填法
  window.app.project.commit('t');
  await new Promise(r => setTimeout(r, 1200));
  const eff = (await import('/js/runtime/trend.js')).effPeriodOf(w);
  const buf = window.app.trend.seriesOf(id);
  const lens = [...buf.values()].map(a => a.length);
  return { effMs: Math.round(eff), maxLen: Math.max(0, ...lens), chans: lens.length };
}, wid);
ok('★ 点数硬上限：窗口 600s + 采样 20ms 时采样周期自动放宽，单通道不超过 3000 点',
  cap.maxLen <= 3000 && cap.effMs >= 200, JSON.stringify(cap));
const capReset = await page.evaluate(async id => {
  const w = window.app.project.getWidget(id);
  w.props.windowSec = 2; w.props.sampleMs = 50;       // 还原成上面「时间窗口」用例设的值，别影响后面的用例
  window.app.project.commit('t');
  await new Promise(r => setTimeout(r, 300));
  // 常规配置下采样周期不受上限影响（用纯对象算，不动控件属性）
  const { effPeriodOf } = await import('/js/runtime/trend.js');
  return effPeriodOf({ props: { windowSec: 20, sampleMs: 100 } });
}, wid);
ok('常规配置下采样周期就是属性里那个值（没被上限乱改）', capReset === 100, String(capReset));

/* ══════ 6. 图例显示通道名与实时值 ══════ */
const legend = await page.evaluate(id => {
  const cv = document.querySelector(`#rtPage .wd[data-id="${id}"] canvas.trend-cv`);
  // 图例是画在 canvas 上的：用「有文字像素」间接验证像素非空已在上一条，这里校验控件属性开关
  const w = window.app.project.getWidget(id);
  return { showLegend: w.props.showLegend, decimals: w.props.decimals, names: w.bindings.variables.filter(Boolean) };
}, wid);
ok('图例开关与通道名配置正确', legend.showLegend === true && legend.names.length === 3, JSON.stringify(legend));

/* ══════ 7. 量程：显示值 = 原值 × 倍率 + 偏置（只影响显示，不改缓冲原值）══════ */
const scaleCheck = await page.evaluate(id => {
  const w = window.app.project.getWidget(id);
  const rawBefore = (window.app.trend.seriesOf(id).get('iCount') || []).slice(-1)[0]?.v;
  w.props.scales = { iCount: { k: 0.001, b: 0 } };
  window.app.project.commit('t');
  const rawAfter = (window.app.trend.seriesOf(id).get('iCount') || []).slice(-1)[0]?.v;
  return { rawBefore, rawAfter };
}, wid);
ok('设置量程不改变缓冲里的原值', scaleCheck.rawBefore === scaleCheck.rawAfter, JSON.stringify(scaleCheck));

/* ══════ 7b. 光标：悬停跟随、点击钉住，读数取该时刻各通道的值 ══════ */
for (let k = 0; k < 10; k++) {                     // 继续灌数据（仍在运行态）
  await page.evaluate(i => {
    window.app.varStore.set('rSpeed', 10 + i * 3, 'local');
    window.app.varStore.set('iCount', 100 * i, 'local');
  }, k);
  await page.waitForTimeout(100);
}
const cvBox = await page.locator(`#rtPage .wd[data-id="${wid}"] canvas.trend-cv`).boundingBox();
await page.mouse.move(cvBox.x + cvBox.width * 0.4, cvBox.y + cvBox.height / 2);
await page.waitForTimeout(200);
const hover = await page.evaluate(i => window.app.trend.cursorOf(i), wid);
ok('鼠标移到波形上出现光标读数（跟随）',
  !!hover && hover.pinned === false && hover.offsetSec < -0.2 && hover.offsetSec > -25,
  JSON.stringify(hover && { pinned: hover.pinned, off: hover.offsetSec.toFixed(1) }));
ok('读数包含每个通道在该时刻的值',
  hover && Object.keys(hover.values).length === 3 && Object.values(hover.values).some(v => Number.isFinite(v)),
  JSON.stringify(hover?.values));
await page.mouse.click(cvBox.x + cvBox.width * 0.4, cvBox.y + cvBox.height / 2);
await page.waitForTimeout(250);
const pinned1 = await page.evaluate(i => window.app.trend.cursorOf(i), wid);
await page.mouse.move(cvBox.x + cvBox.width * 0.8, cvBox.y + cvBox.height / 2);   // 移开鼠标
await page.waitForTimeout(250);
const pinned2 = await page.evaluate(i => window.app.trend.cursorOf(i), wid);
ok('点击钉住光标，移开鼠标读数不变',
  pinned1?.pinned === true && pinned2?.pinned === true
  && Math.abs(pinned1.time - pinned2.time) < 1
  && JSON.stringify(pinned1.values) === JSON.stringify(pinned2.values),
  JSON.stringify({ off: pinned2?.offsetSec?.toFixed(2), values: pinned2?.values }));
await page.mouse.click(cvBox.x + cvBox.width * 0.4, cvBox.y + cvBox.height / 2);
await page.waitForTimeout(250);
const afterUnpin = await page.evaluate(i => window.app.trend.cursorOf(i), wid);
ok('再点一下取消钉住', afterUnpin === null || afterUnpin.pinned === false, JSON.stringify(afterUnpin));
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(200);
ok('退出运行时光标清掉', (await page.evaluate(i => window.app.trend.cursorOf(i), wid)) === null);


/* ══════ 8. 删除变量 → 通道自动摘掉；改名 → 通道跟着改 ══════ */
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(250);
await page.evaluate(i => {
  const el = document.querySelector(`#canvas .wd[data-id="${i}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, wid);
await page.waitForTimeout(200);
await page.evaluate(() => window.app.project.deleteVariable('iCount'));
await page.waitForTimeout(200);
// 通道数组是固定 8 槽位（空串=未使用），删变量应把那一槽置空而不是让后面的前移
const afterDelVar = await page.evaluate(id => window.app.project.getWidget(id).bindings.variables, wid);
ok('删除变量后该通道被置空（槽位不前移，颜色不乱）',
  JSON.stringify(afterDelVar) === JSON.stringify(['bRunCmd', 'rSpeed', '', '', '', '', '', '']),
  JSON.stringify(afterDelVar));
await page.evaluate(() => window.app.project.updateVariable('rSpeed', { name: 'rSpeed2' }));
await page.waitForTimeout(200);
const afterRename = await page.evaluate(id => window.app.project.getWidget(id).bindings.variables, wid);
ok('变量改名后通道名跟着改（位置不变）',
  JSON.stringify(afterRename) === JSON.stringify(['bRunCmd', 'rSpeed2', '', '', '', '', '', '']),
  JSON.stringify(afterRename));
ok('量程/颜色也跟随改名', await page.evaluate(id => {
  const w = window.app.project.getWidget(id);
  return !!w.props.scales?.rSpeed2 || !w.props.scales?.rSpeed;    // 要么跟着改名，要么已清掉，不留孤儿键
}, wid));

/* ══════ 9. 两个波形控件各自独立抓取 ══════ */
const two = await page.evaluate(() => {
  const a = window.app.project.addWidget('trend', 500, 60);
  a.bindings.variables = ['bRunCmd']; a.props.sampleMs = 100;
  const b = window.app.project.addWidget('trend', 500, 260);
  b.bindings.variables = ['bRunCmd'];
  window.app.project.commit('t');
  return [a.id, b.id];
});
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(700);
const twoSeries = await page.evaluate(ids => ids.map(i => window.app.trend.seriesOf(i).get('bRunCmd')?.length || 0), two);
ok('两个波形控件各自有独立缓冲且都在采样',
  twoSeries[0] > 2 && twoSeries[1] > 2, JSON.stringify(twoSeries));
await page.evaluate(() => window.app.exitRun());

/* ══════ 10. 波形是自绘控件：变量变化时不该重建它的画布 ══════ */
const selfDrawn = await page.evaluate(id => {
  const before = document.querySelector(`#rtPage .wd[data-id="${id}"] canvas.trend-cv`);
  window.app.enterRun();
  return !!before;
}, wid);
await page.waitForTimeout(300);
const canvasStable = await page.evaluate(id => {
  const w = window.app.project.getWidget(id);
  const before = document.querySelector(`#rtPage .wd[data-id="${id}"] canvas.trend-cv`);
  window.app.varStore.set('bRunCmd', true, 'local');   // 触发变量变化
  const after = document.querySelector(`#rtPage .wd[data-id="${id}"] canvas.trend-cv`);
  return before === after;                              // 同一个 DOM 节点 → 没被 innerHTML 重建
}, wid);
ok('变量变化时画布节点不被重建（selfDrawn 生效）', canvasStable, `enterRun=${selfDrawn}`);
await page.evaluate(() => window.app.exitRun());

/* ══════ 11. 抓取控制（运行态）：启动抓取 / 清除数据 ══════
   现场要的：这台设备想让我抓我才抓、让我清我才清；不设变量 = 一直抓（上面那几节已经验过）。 */
await page.evaluate(id => {
  const m = window.app.project;
  if (!m.variables().some(v => v.name === 'bRec')) {
    m.variables().push({ name: 'bRec', type: 'bool', address: '%MX1.0', value: false });
    m.variables().push({ name: 'bClr', type: 'bool', address: '%MX1.1', value: false });
  }
  const w = m.getWidget(id);
  w.bindings.startVar = 'bRec';
  w.bindings.clearVar = 'bClr';
  w.props.windowSec = 6; w.props.sampleMs = 100;
  m.commit('配抓取控制');
}, wid);
/** 这个控件当前抓到的点数（取最多的那一路；通道名中途被改名过，别写死） */
const pts = async () => Math.max(0, ...Object.values(await series(wid)).map(s => s.n));
await page.evaluate(() => window.app.enterRun());
await page.evaluate(() => {
  window.app.varStore.set('bRec', true, 'local');       // 设备说"开始抓"
  window.app.varStore.set('bClr', false, 'local');
});
await page.waitForTimeout(900);
const n1 = await pts();
ok('★ 「启动抓取」为 1 → 正常抓（点数在涨）', n1 > 3, String(n1));
await page.evaluate(() => window.app.varStore.set('bRec', false, 'local'));
await page.waitForTimeout(200);
const nA = await pts();
await page.waitForTimeout(700);                        // 停着不动
const nB = await pts();
ok('★ 「启动抓取」变 0 → **不再抓新点**（曲线停在那儿，老数据不丢）',
  nB === nA && nA > 3, `前=${nA} 后=${nB}`);
await page.evaluate(() => window.app.varStore.set('bRec', true, 'local'));
await page.waitForTimeout(700);
const nC = await pts();
ok('★ 再置回 1 → 接着抓（点数明显变多）', nC > nB + 2, `${nB} → ${nC}`);

// 「清除数据」：**上升沿**清一次；一直保持 1 不许反复清（否则曲线永远一张白纸）
await page.evaluate(() => window.app.varStore.set('bClr', true, 'local'));
await page.waitForTimeout(180);
const nClear = await pts();
ok('★ 「清除数据」从 0 变 1 → 曲线被清空（那一拍点数几乎归零）',
  nClear <= 3 && nC > 5, `清之前 ${nC} 点 → 清之后 ${nClear} 点`);
await page.waitForTimeout(700);                        // bClr 还是 1（设备没回 0）
const nHold = await pts();
ok('★ 一直保持 1 **不会反复清**（回 0 再来一次才清第二次）—— 曲线能重新画出来',
  nHold > 3, `保持 1 期间又攒了 ${nHold} 点`);
await page.evaluate(() => window.app.varStore.set('bClr', false, 'local'));
await page.waitForTimeout(150);
const nAfter = await pts();
await page.evaluate(() => window.app.varStore.set('bClr', true, 'local'));
await page.waitForTimeout(180);
const nSecond = await pts();
ok('★ 回 0 之后再置 1 → 又清一次（第二次清除照样有效）',
  nSecond <= 3 && nAfter > 2, `回0后 ${nAfter} 点 → 再置1后 ${nSecond} 点`);
await page.evaluate(() => window.app.exitRun());

/* ══════ 12. 属性 schema：保留项 + 「XY 模式已移除」+ 属性面板分栏 ══════
   现场要求：控件属性里保持干净 —— 属性名（label）要有，**说明文字（hint）一律不摆**。
   XY 曲线模式已移除（改用独立「XY 波形」控件）：mode / autoX / xMin / xMax / xyPoints / xVar 都不再存在。 */
const schema = await page.evaluate(async () => {
  const { registry } = await import('/js/widgets/registry.js');
  const def = registry.get('trend');
  const byKey = Object.fromEntries(def.props.map(p => [p.key, p]));
  return {
    defaults: def.defaults,
    propKeys: def.props.map(p => p.key),
    labels: Object.fromEntries(def.props.map(p => [p.key, p.label || ''])),
    hints: Object.fromEntries(def.props.map(p => [p.key, p.hint || ''])),
    csvI18n: byKey.csvBtnText?.i18n || '',
    bindingKeys: Object.keys(def.binding || {}),
  };
});
const keepPropKeys = ['windowSec', 'sampleMs', 'autoY', 'yMin', 'yMax', 'dualAxis', 'rightChannels',
  'autoY2', 'y2Min', 'y2Max', 'showCsvBtn', 'csvBtnText', 'showGrid', 'showLegend',
  'lineWidth', 'decimals', 'fontSize', 'bgColor', 'gridColor', 'textColor',
  'borderColor', 'borderWidth', 'radius'];
const removedPropKeys = ['mode', 'autoX', 'xMin', 'xMax', 'xyPoints'];
ok('★ 时间轴/双 Y 轴/导出 CSV 的属性都在、都有属性名（label），且**不摆说明文字**（hint 一律不加）',
  keepPropKeys.every(k => (schema.labels[k] || '').length >= 2)
  && schema.propKeys.every(k => !schema.hints[k]),
  JSON.stringify({ noLabel: keepPropKeys.filter(k => !schema.labels[k]), withHint: schema.propKeys.filter(k => schema.hints[k]) }));
ok('★ XY 模式属性已彻底移除：def.props 里没有 mode / autoX / xMin / xMax / xyPoints；「控制变量」里没有 xVar',
  removedPropKeys.every(k => schema.propKeys.indexOf(k) < 0)
  && schema.bindingKeys.indexOf('xVar') < 0
  && schema.bindingKeys.indexOf('startVar') >= 0 && schema.bindingKeys.indexOf('clearVar') >= 0,
  JSON.stringify({ removedStillThere: removedPropKeys.filter(k => schema.propKeys.indexOf(k) >= 0), bindingKeys: schema.bindingKeys }));
ok('★ 导出按钮文字仍声明 i18n:text（会进翻译表）',
  schema.csvI18n === 'text', String(schema.csvI18n));
ok('★ 保留属性的默认值：纵轴自动 / 单 Y 轴 / 显示导出按钮默认**不勾**（现场口径）',
  schema.defaults.autoY === true && schema.defaults.dualAxis === false && schema.defaults.showCsvBtn === false,
  JSON.stringify({ autoY: schema.defaults.autoY, dualAxis: schema.defaults.dualAxis, csv: schema.defaults.showCsvBtn }));
// 属性面板包含「双 Y 轴」「导出 CSV」；原「XY 曲线」栏已移除
await page.evaluate(i => {
  const el = document.querySelector(`#canvas .wd[data-id="${i}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, wid);
await page.waitForTimeout(250);
const panel = await page.evaluate(() => {
  const box = re => [...document.querySelectorAll('#propBody .prop-group')]
    .find(x => re.test(x.querySelector('.prop-group-title')?.textContent || ''));
  const info = re => {
    const g = box(re);
    return { props: [...(g?.querySelectorAll('[data-prop]') || [])].map(e => e.dataset.prop), text: g?.textContent || '' };
  };
  return {
    titles: [...document.querySelectorAll('#propBody .prop-group-title')].map(e => e.textContent.trim()),
    allProps: [...document.querySelectorAll('#propBody [data-prop]')].map(e => e.dataset.prop),
    dual: info(/双 Y 轴/), csv: info(/导出 CSV/),
  };
});
ok('★ 属性面板包含「双 Y 轴」「导出 CSV」（XY 曲线栏已消失）',
  panel.dual.props.join(',') === 'dualAxis,rightChannels,autoY2,y2Min,y2Max'
  && panel.csv.props.join(',') === 'showCsvBtn,csvBtnText'
  && !panel.titles.some(t => /XY/.test(t))
  && !panel.allProps.some(k => removedPropKeys.indexOf(k) >= 0 || k === 'xVar'),
  JSON.stringify({ titles: panel.titles, dual: panel.dual.props, csv: panel.csv.props }));
ok('★ 属性面板保持干净：这两栏只有属性名，没有说明文字行（现场要求：不摆 hint）',
  /双 Y 轴/.test(panel.dual.text) && /右轴通道号/.test(panel.dual.text) && /右轴自动/.test(panel.dual.text)
  && /显示导出按钮/.test(panel.csv.text) && /按钮文字/.test(panel.csv.text)
  && !/自动缩放|Excel 直接打开|哪几路用右轴|100~50000|左\/右两个|时间轴：/.test(panel.dual.text + panel.csv.text),
  JSON.stringify(panel.titles));

/* ══════ 13. 导出当前数据 CSV（时间轴）══════ */
// 新摆一个波形控件专门验新功能（前面的 wid 通道被删改过，别混着用）
const enh = await page.evaluate(() => {
  const m = window.app.project;
  ['rX', 'rA', 'rB', 'rC'].forEach(name => {
    if (!m.variables().some(v => v.name === name)) m.data.variables.push({ name, type: 'real', address: '', value: 0 });
  });
  m.commit('增强套件变量');
  const w = m.addWidget('trend', 480, 360);
  w.bindings.variables = ['rA', 'rB', 'rC'];
  w.props.windowSec = 6; w.props.sampleMs = 100;
  const defCsv = w.props.showCsvBtn;      // 新建波形控件「显示导出按钮」默认不勾（现场口径）
  w.props.showCsvBtn = true;              // 这个控件专门验 CSV 导出，手动打开
  m.commit('增强套件波形');
  const wDef = m.addWidget('trend', 860, 360);   // 再用默认值摆一个：验「默认不显示导出按钮」
  m.commit('增强套件波形默认');
  window.app.varStore.resetFrom(m.variables());
  const page = m.pages().find(p => (p.widgets || []).some(x => x.id === w.id));
  return { id: w.id, name: w.name, pageName: page?.name || '', projName: m.data?.meta?.name || '',
    defCsv, defId: wDef.id };
});
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(80);
for (let k = 0; k < 10; k++) {
  await page.evaluate(i => {
    window.app.varStore.set('rA', i, 'local');
    window.app.varStore.set('rB', 100 + i, 'local');
    window.app.varStore.set('rC', 1000 + i, 'local');
  }, k);
  await page.waitForTimeout(100);
}
const csvBtns = await page.evaluate(({ id, defId }) => {
  const pick = (i) => {
    const b = document.querySelector(`#rtPage .wd[data-id="${i}"] .trend-csv-btn`);
    return { exists: !!b, text: b?.textContent || '', title: b?.title || '',
      canvas: !!document.querySelector(`#rtPage .wd[data-id="${i}"] canvas.trend-cv`) };
  };
  return { on: pick(id), off: pick(defId) };
}, { id: enh.id, defId: enh.defId });
ok('★ 新建波形控件「显示导出按钮」默认不勾选（不留导出按钮）、勾上才出',
  enh.defCsv === false && csvBtns.off.exists === false,
  JSON.stringify({ defCsv: enh.defCsv, offExists: csvBtns.off.exists }));
const btnInfo = csvBtns.on;
ok('★ 运行态波形右上角有「导出 CSV」按钮（画布还在，selfDrawn 没被破坏）',
  btnInfo.exists && btnInfo.text === '导出 CSV' && btnInfo.canvas && /CSV/.test(btnInfo.title),
  JSON.stringify(btnInfo));
const csv = await page.evaluate(async i => {
  const t = await import('/js/runtime/trend.js');
  return t.csvOf(window.app.project.getWidget(i));
}, enh.id);
const csvLines = csv.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
ok('★ 导出 CSV 带 UTF-8 BOM + CRLF（Excel 打开中文不乱码）',
  csv.text.startsWith('\uFEFF') && csv.text.includes('\r\n') && csv.text.endsWith('\r\n'),
  JSON.stringify(csv.text.slice(0, 24)));
ok('★ 文件名 = 项目名-页面名-控件名.csv',
  csv.filename === `${enh.projName}-${enh.pageName}-${enh.name}.csv`,
  `${csv.filename}  ←  ${enh.projName} / ${enh.pageName} / ${enh.name}`);
ok('★ 时间轴 CSV 表头 = 时间,通道变量名；时间是本地时间 + 毫秒',
  csvLines[0] === '时间,rA,rB,rC'
  && csvLines.length > 4
  && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(csvLines[1].split(',')[0]),
  JSON.stringify(csvLines.slice(0, 2)));
ok('★ 时间轴 CSV 数值列 = 各通道同一拍的值（套过量程后）',
  csvLines.slice(1).some(l => {
    const c = l.split(',');
    return c[2] === String(100 + Number(c[1]));
  }),
  JSON.stringify(csvLines.slice(1, 4)));
// 真点按钮 → 浏览器里拦下载（拦不到下载才退回"直接调内部导出函数"已经验过内容）
await page.evaluate(() => {
  // 无头浏览器里别弹系统保存框：拿掉它，导出就会走 <a download> 那条路（和普通浏览器兜底一致）
  try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch { /* 忽略 */ }
  try { delete window.showSaveFilePicker; } catch { /* 忽略 */ }
});
const dlWait = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
await page.click(`#rtPage .wd[data-id="${enh.id}"] .trend-csv-btn`);
const dl = await dlWait;
let dlName = '', dlText = '';
if (dl) {
  dlName = dl.suggestedFilename();
  try { const p2 = await dl.path(); if (p2) dlText = fs.readFileSync(p2, 'utf8'); } catch { /* 读不到就算了 */ }
}
ok('★ 点「导出 CSV」按钮真的导出一份文件（文件名/内容对得上）',
  !!dl && dlName === `${enh.projName}-${enh.pageName}-${enh.name}.csv`
  && dlText.startsWith('\uFEFF') && dlText.split('\r\n')[0].includes('时间,rA,rB,rC'),
  JSON.stringify({ got: !!dl, dlName, head: dlText.slice(0, 30) }));
// 「显示导出按钮」不勾 / 按钮文字可改 + 走 tr（多语言）—— 属性改动在编辑态配，重进运行态生效
await page.evaluate(i => {
  const w = window.app.project.getWidget(i);
  w.props.showCsvBtn = false;
  window.app.project.commit('先关导出按钮');
}, enh.id);
await page.evaluate(() => window.app.exitRun());
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(250);
const noBtn = await page.evaluate(i => !!document.querySelector(`#rtPage .wd[data-id="${i}"] .trend-csv-btn`), enh.id);
ok('★ 「显示导出按钮」不勾 → 运行画面上没有按钮', noBtn === false, String(noBtn));
await page.evaluate(() => window.app.exitRun());
const i18nBtn = await page.evaluate(async i => {
  const m = window.app.project;
  const w = m.getWidget(i);
  w.props.showCsvBtn = true;
  w.props.csvBtnText = '导出数据';
  m.data.meta.i18n = { default: 'zh-CN', langs: [{ code: 'en', label: 'English' }], dict: { en: { '导出数据': 'Export Data' } } };
  m.commit('配多语言');
  const i18n = await import('/js/core/i18n.js');
  i18n.setLang('en');
  window.app.enterRun();
  await new Promise(r => setTimeout(r, 250));
  const btn = document.querySelector(`#rtPage .wd[data-id="${i}"] .trend-csv-btn`);
  return { lang: i18n.getLang(), text: btn?.textContent || '' };
}, enh.id);
ok('★ 按钮文字可配且走 tr：切成英文后按钮显示译文（Export Data）',
  i18nBtn.lang === 'en' && i18nBtn.text === 'Export Data', JSON.stringify(i18nBtn));
// 还原（后面几节还要用这个控件）
await page.evaluate(async i => {
  const m = window.app.project;
  const w = m.getWidget(i);
  w.props.csvBtnText = '导出 CSV';
  delete m.data.meta.i18n;
  m.commit('还原多语言');
  const i18n = await import('/js/core/i18n.js');
  i18n.setLang('zh-CN');
  window.app.exitRun();
}, enh.id);
await page.waitForTimeout(200);

/* ══════ 14. 双 Y 轴：右轴通道映射 / 右轴刻度 / 图例「(右)」══════ */
await page.evaluate(i => {
  const w = window.app.project.getWidget(i);
  w.props.dualAxis = true;
  w.props.rightChannels = '2';          // 通道列表第 2 路 = rB → 走右轴
  w.props.autoY = true; w.props.autoY2 = true;
  window.app.project.commit('配双 Y 轴');
}, enh.id);
const axisMap = await page.evaluate(async i => {
  const t = await import('/js/runtime/trend.js');
  const m = window.app.project;
  const w = m.getWidget(i);
  const chans = t.channelsOf(w);
  return {
    axis: t.axisChannelsOf(w),
    rightSlots: [...t.rightSlotsOf(w)],
    legendRight: t.legendLabelOf(w, chans.find(c => c.name === 'rB'), '1005'),
    legendLeft: t.legendLabelOf(w, chans.find(c => c.name === 'rA'), '5'),
    off: (() => {
      const w2 = { ...w, props: { ...w.props, dualAxis: false } };
      return t.axisChannelsOf(w2);
    })(),
  };
}, enh.id);
ok('★ 双 Y 轴：rightChannels="2" 把第 2 路映射到右轴，其余留左轴；不勾双轴时全回左轴',
  axisMap.axis.dual === true
  && JSON.stringify(axisMap.axis.right) === JSON.stringify(['rB'])
  && JSON.stringify(axisMap.axis.left) === JSON.stringify(['rA', 'rC'])
  && axisMap.off.dual === false && axisMap.off.left.length === 3,
  JSON.stringify(axisMap.axis));
ok('★ 图例里右轴通道带「(右)」，左轴通道不带',
  axisMap.legendRight.includes('(右)') && axisMap.legendRight.includes('1005')
  && !axisMap.legendLeft.includes('(右)'),
  JSON.stringify({ right: axisMap.legendRight, left: axisMap.legendLeft }));
// 右轴刻度是**画在画布上**的：右边缘上方那一小条只在双轴时出现多行文字像素（单轴时只有一条网格线）
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(80);
for (let k = 0; k < 8; k++) {
  await page.evaluate(i => {
    window.app.varStore.set('rA', i, 'local');          // 左轴：0~10
    window.app.varStore.set('rB', 1000 + i, 'local');   // 右轴：1000~1010（量级差 100 倍）
    window.app.varStore.set('rC', i * 2, 'local');
  }, k);
  await page.waitForTimeout(100);
}
const rightBandRows = i => page.evaluate(id => {
  const cv = document.querySelector(`#rtPage .wd[data-id="${id}"] canvas.trend-cv`);
  if (!cv) return { ok: false };
  const ctx = cv.getContext('2d');
  const dpr = cv.width / Math.max(1, cv.clientWidth);
  const cssW = cv.clientWidth;
  const padT = 8;                                   // 图例在 canvas 上方
  const x0 = Math.max(0, Math.round((cssW - 44) * dpr));
  const x1 = Math.min(cv.width, Math.round((cssW - 10) * dpr));
  const y0 = Math.max(0, Math.round((padT - 6) * dpr));
  const y1 = Math.min(cv.height, Math.round((padT + 6) * dpr));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const d = ctx.getImageData(x0, y0, w, h).data;
  const rows = new Set();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      if (d[k + 3] > 24) { rows.add(y); break; }
    }
  }
  return { ok: true, rows: rows.size, w, h };
}, i);
await page.evaluate(i => {
  window.app.project.getWidget(i).props.dualAxis = false;
  window.app.project.commit('先单轴');
}, enh.id);
await page.waitForTimeout(500);
const singleBand = await rightBandRows(enh.id);
await page.evaluate(i => {
  window.app.project.getWidget(i).props.dualAxis = true;
  window.app.project.commit('再双轴');
}, enh.id);
await page.waitForTimeout(500);
const dualBand = await rightBandRows(enh.id);
ok('★ 右轴刻度真的画在画布右边缘（双轴时出现 5 档文字，不是重复网格线）',
  dualBand.ok && dualBand.rows >= 3 && singleBand.ok && singleBand.rows <= 2,
  JSON.stringify({ single: singleBand.rows, dual: dualBand.rows }));
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(150);

/* ══════ 15. XY 模式已移除：接口/缓冲不再有；老工程残留 mode:'xy' 仍按时间轴画、CSV 只有时间列 ══════ */
// 运行态模块里 XY 相关接口已删（modeOf / xyPointsOf / xyRangeOf / xyPointLimitOf）
const xyGone = await page.evaluate(async () => {
  const t = await import('/js/runtime/trend.js');
  return {
    modeOf: typeof t.modeOf, xyPointsOf: typeof t.xyPointsOf,
    xyRangeOf: typeof t.xyRangeOf, xyPointLimitOf: typeof t.xyPointLimitOf,
  };
});
ok('★ 运行态模块里 XY 接口已删除（modeOf / xyPointsOf / xyRangeOf / xyPointLimitOf 都不再导出）',
  xyGone.modeOf === 'undefined' && xyGone.xyPointsOf === 'undefined'
  && xyGone.xyRangeOf === 'undefined' && xyGone.xyPointLimitOf === 'undefined',
  JSON.stringify(xyGone));
// 老工程兼容：控件里残留 mode='xy' / bindings.xVar / autoX / xMin / xMax / xyPoints
// → 不报错、**一律按时间轴**采样和绘制（这些键被忽略，不要求从工程里删掉）
await page.evaluate(i => {
  const m = window.app.project;
  const w = m.getWidget(i);
  w.props.mode = 'xy';                 // 老工程残留键（已不是 trend 的属性）
  w.props.autoX = false;
  w.props.xMin = -5; w.props.xMax = 5; w.props.xyPoints = 100;
  w.bindings.xVar = 'rX';              // 老工程残留绑定（已不是 trend 的 binding）
  w.props.dualAxis = false;
  w.props.sampleMs = 50; w.props.windowSec = 6;
  m.commit('模拟老工程残留 XY 键');
}, enh.id);
await page.evaluate(() => window.app.enterRun());
await page.evaluate(() => window.app.backend.stopEvents());
for (let k = 0; k < 8; k++) {
  await page.evaluate(i => {
    window.app.varStore.set('rA', i, 'local');
    window.app.varStore.set('rB', 100 + i, 'local');
    window.app.varStore.set('rC', i * 2, 'local');
  }, k);
  await page.waitForTimeout(100);
}
const compat = await page.evaluate(async i => {
  const t = await import('/js/runtime/trend.js');
  const buf = t.seriesOf(i);
  const lens = [...buf.values()].map(a => a.length);
  return { keys: [...buf.keys()], lens, n: Math.max(0, ...lens) };
}, enh.id);
ok('★ 老工程残留 mode="xy" + xVar：不报错，照旧按**时间轴**采样（三通道都有缓冲、点数在涨）',
  compat.n > 3 && compat.keys.length === 3,
  JSON.stringify(compat));
ok('★ 老工程残留 XY 键不影响绘制：画布上仍有时间轴曲线像素（不是空白）',
  await inkRatio('#rtPage canvas.trend-cv') > 0.03,
  `ink=${(await inkRatio('#rtPage canvas.trend-cv')).toFixed(3)}`);
const csvCompat = await page.evaluate(async i => {
  const t = await import('/js/runtime/trend.js');
  return t.csvOf(window.app.project.getWidget(i));
}, enh.id);
const compatLines = csvCompat.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
ok('★ CSV 只有时间列：表头 = 时间,通道…（不再有 x 列；老工程的 XY 键不影响）',
  compatLines[0] === '时间,rA,rB,rC'
  && compatLines[0].split(',').indexOf('x') < 0
  && compatLines.length > 2
  && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(compatLines[1].split(',')[0]),
  JSON.stringify(compatLines.slice(0, 2)));
await page.evaluate(() => window.app.exitRun());
await page.waitForTimeout(200);
const compatExit = await page.evaluate(async i => {
  const t = await import('/js/runtime/trend.js');
  return { series: [...t.seriesOf(i).values()].reduce((a, x) => a + x.length, 0) };
}, enh.id);
ok('★ 退出运行态：时间轴采样缓冲清空（XY 缓冲已随功能一起删除）',
  compatExit.series === 0, JSON.stringify(compatExit));

/* ══════ 16. 画面抓取按钮和外部变量可分别选择 ══════ */
const [manualId, autoId, xyGridId] = await page.evaluate(async () => {
  const { project: m, varStore } = window.app;
  m.addPage('page');
  m.variables().push(
    { name: 'trendLocalA', type: 'real', address: '', value: 10 },
    { name: 'trendLocalB', type: 'real', address: '', value: 20 },
    { name: 'trendExtStart', type: 'bool', address: '', value: false },
    { name: 'trendExtClear', type: 'bool', address: '', value: false },
  );
  const manual = m.addWidget('trend', 20, 20);
  const auto = m.addWidget('trend', 430, 20);
  const xy = m.addWidget('xyplot', 20, 240);
  Object.assign(xy.props, { xTicks: 7, yTicks: 3, gridColor: '#ff00ff', showClearBtn: true });
  manual.props.gridColor = '#ff00ff';
  manual.bindings.variables = ['trendLocalA'];
  auto.bindings.variables = ['trendLocalB'];
  for (const w of [manual, auto]) {
    w.props.windowSec = 20;
    w.props.sampleMs = 50;
  }
  varStore.resetFrom(m.variables());
  m.commit('测试波形画面按钮');
  const { select } = await import('/js/editor/canvas.js');
  select([manual.id]);
  return [manual.id, auto.id, xy.id];
});
await page.locator('#propBody [data-prop="showCaptureBtn"]').check();
await page.locator('#propBody [data-prop="showClearBtn"]').check();
for (const [key, value] of [['xTicks', '8'], ['yTicks', '4']]) {
  const field = page.locator(`#propBody [data-prop="${key}"]`);
  await field.fill(value);
  await field.press('Tab');
}
const editTrend = page.locator(`#canvas .wd[data-id="${manualId}"]`);
const sameHeaderRow = widget => widget.locator('.w-plot-header').evaluate(el => {
  const label = el.querySelector('.w-plot-legend').getBoundingClientRect();
  const tools = el.querySelector('.w-plot-tools').getBoundingClientRect();
  return Math.abs((label.top + label.height / 2) - (tools.top + tools.height / 2)) < 1
    && label.right <= tools.left;
});
ok('★ 编辑态预览按钮与变量图例同一行，按钮不可执行',
  (await editTrend.locator('.w-plot-legend').textContent()).includes('trendLocalA')
  && await editTrend.getByRole('button', { name: '开始抓取' }).isDisabled()
  && await editTrend.getByRole('button', { name: '清除数据' }).isDisabled()
  && await sameHeaderRow(editTrend));
const enterTrendRun = () => page.evaluate(async () => {
  window.app.enterRun();
  window.app.backend.stopEvents();
  (await import('/js/runtime/runtime.js')).hideRuntimeHint();
});
const manualRun = page.locator(`#rtPage .wd[data-id="${manualId}"]`);
const autoRun = page.locator(`#rtPage .wd[data-id="${autoId}"]`);
const captureButton = manualRun.locator('.w-plot-capture');
const clearButton = manualRun.locator('.w-plot-clear');
const countSamples = id => page.evaluate(i => {
  const points = window.app.trend.seriesOf(i).values().next().value;
  return points?.length ?? 0;
}, id);
const waitForSamples = id => page.waitForFunction(i => {
  const points = window.app.trend.seriesOf(i).values().next().value;
  return points?.length >= 3;
}, id, { timeout: 3000 });
const samplesManualChannel = () => page.evaluate(async () =>
  (await import('/js/runtime/runtime.js')).pageVarScope().includes('trendLocalA'));

await enterTrendRun();
await waitForSamples(autoId);
ok('★ 从属性面板勾选按钮：手动波形初始停抓，默认波形继续自动抓取',
  await captureButton.textContent() === '开始抓取' && await clearButton.isVisible()
  && await countSamples(manualId) === 0 && !(await samplesManualChannel())
  && await autoRun.locator('.w-plot-tools').count() === 0);
const toolbarBottom = await manualRun.locator('.w-plot-tools').evaluate(e => e.getBoundingClientRect().bottom);
const plotTop = await manualRun.locator('canvas').evaluate(e => e.getBoundingClientRect().top);
ok('★ 运行态按钮和图例同一行，位于绘图区上方',
  await sameHeaderRow(manualRun) && toolbarBottom <= plotTop + 0.5);

// 分数缩放时，图例与 canvas 接缝处不能露出页面底色。
const uniformHeaderJoin = async id => {
  const chart = page.locator(`#rtPage .wd[data-id="${id}"] .w-plot-header`);
  await chart.evaluate(el => {
    el.parentElement.style.transformOrigin = 'top left';
    el.parentElement.style.transform = 'translateY(0.47px) scaleY(1.07)';
  });
  try {
    const header = await chart.boundingBox();
    const png = await page.screenshot({ clip: {
      x: Math.floor(header.x + header.width / 2), y: Math.floor(header.y + header.height) - 2,
      width: 20, height: 5,
    } });
    return await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return pixels.every((value, i) => value === [15, 23, 42, 255][i % 4]);
    }, png.toString('base64'));
  } finally {
    await chart.evaluate(el => {
      el.parentElement.style.removeProperty('transform');
      el.parentElement.style.removeProperty('transform-origin');
    });
  }
};
ok('★ 时间波形和 XY 波形在分数缩放下无图例接缝',
  await uniformHeaderJoin(manualId) && await uniformHeaderJoin(xyGridId));

const gridCounts = id => page.evaluate(i => {
  const cv = document.querySelector(`#rtPage .wd[data-id="${i}"] canvas`);
  const { width, height } = cv;
  const pixels = cv.getContext('2d').getImageData(0, 0, width, height).data;
  const cols = new Array(width).fill(0), rows = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      if (pixels[px + 3] > 40 && pixels[px] > 95 && pixels[px + 1] < 40 && pixels[px + 2] > 95) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  // 半像素抗锯齿可能让一根网格线占两列或两行，连续像素算同一条。
  const lines = (counts, threshold) => counts.filter((value, i) =>
    value > threshold && (i === 0 || counts[i - 1] <= threshold)).length;
  return [lines(cols, height / 2), lines(rows, width / 2)];
}, id);
const timeTicks = await gridCounts(manualId);
const xyTicks = await gridCounts(xyGridId);
ok('★ 时间波形与 XY 波形分别按设置绘制 X/Y 网格线（含两端）',
  timeTicks.join() === '8,4' && xyTicks.join() === '7,3',
  JSON.stringify({ timeTicks, xyTicks }));

await captureButton.click();
await waitForSamples(manualId);
ok('★ 点击开始抓取：缓冲开始积累，通道加入采集范围',
  await captureButton.textContent() === '停止抓取' && await samplesManualChannel());
await captureButton.click();
const stoppedCount = await countSamples(manualId);
const autoBeforeClear = await countSamples(autoId);
await page.waitForTimeout(250);
ok('★ 点击停止抓取：保留记录并从采集范围移出通道',
  stoppedCount >= 3 && await countSamples(manualId) === stoppedCount
  && await captureButton.textContent() === '开始抓取' && !(await samplesManualChannel()));
await clearButton.click();
ok('★ 停止时仍可清除，只清本控件且不影响另一波形',
  await countSamples(manualId) === 0 && await countSamples(autoId) > autoBeforeClear);

await captureButton.click();
await page.evaluate(() => window.app.exitRun());
await enterTrendRun();
ok('★ 重新进入运行态时，手动抓取回到等待开始状态',
  await captureButton.textContent() === '开始抓取' && await countSamples(manualId) === 0);
await page.evaluate(i => {
  window.app.exitRun();
  const w = window.app.project.getWidget(i);
  w.bindings.startVar = 'trendExtStart';
  window.app.project.commit('外部抓取，画面清除');
}, manualId);
await enterTrendRun();
ok('★ 可混合使用：绑定启动变量时只隐藏画面抓取按钮',
  await captureButton.count() === 0 && await clearButton.isVisible());
await page.evaluate(() => window.app.varStore.set('trendExtStart', true, 'local'));
await waitForSamples(manualId);
await page.evaluate(i => {
  window.app.exitRun();
  const w = window.app.project.getWidget(i);
  w.bindings.clearVar = 'trendExtClear';
  window.app.project.commit('改用两个外部控制变量');
}, manualId);
await enterTrendRun();
ok('★ 两项均绑定变量时，两个画面按钮均隐藏',
  await manualRun.isVisible() && await manualRun.locator('.w-plot-tools').count() === 0);
await page.evaluate(() => window.app.exitRun());

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 波形控件回归（时间轴 / 双Y轴 / 导出CSV；XY 模式已移除）：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
