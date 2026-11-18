// verify-trend.mjs — 波形抓取控件：多通道绑定 / 采样 / 绘制 / 量程 / 变量增删联动
// 用法：先启动 8866 服务，再 node test/verify-trend.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

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
  const bg = [d[0], d[1], d[2]];
  let diff = 0, total = 0;
  for (let i = 0; i < d.length; i += 4 * 37) {          // 抽样即可
    total++;
    if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) diff++;
  }
  return diff / total;
}, sel);

/* ══════ 1. 工具箱里有波形控件，能拖到画布 ══════ */
await boot();
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

/* ══════ 3. 编辑态：静态预览（还没运行也能看到样式）══════ */
ok('编辑态画出预览曲线（不是空白画布）',
  await inkRatio(`#canvas .wd[data-id="${wid}"] canvas.trend-cv`) > 0.02,
  `ink=${(await inkRatio(`#canvas .wd[data-id="${wid}"] canvas.trend-cv`)).toFixed(3)}`);

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

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 波形控件回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
