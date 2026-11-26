// verify-xyplot.mjs — 新增独立「XY 波形」控件（多对 X/Y 两两组合 + 数组描点）
//
// 验收点（对应 task-19）：
//   ① 注册成功（type/title/sub/selfDrawn）、工具箱出现、属性面板 props 齐全且**没有任何 hint**；
//   ② 编辑态渲染出 canvas 容器（内联网格静态示意），可选中；
//   ③ 运行态标量对：每 sampleMs 追加 (x,y)，__xyState().pairs 的 n 随时间增长、范围覆盖数据、canvas 有非空像素；
//   ④ 数组描点：变量值都是数组 → kind='array'、n=min(lenX,lenY)、连续两拍 n 不变（不累加）、
//      数组数据一换整条跟着变；长度不等取 min；
//   ⑤ 空行/认不出的行跳过；最多 8 对；手动范围（autoX/autoY 关掉）生效；
//   ⑥ 切回标量对仍工作；退出运行态不报错、无未捕获 JS 异常。
//
// 用法：node test/verify-xyplot.mjs
//   （自己拉起一个隔离后端：随机端口 + 临时数据目录，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-xyplot-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* ═══════════ 0. 造数据：2 对标量变量 + 2 个数组变量 + 1 个 xyplot 控件 ═══════════ */
const S = await page.evaluate(async () => {
  const m = window.app.project;
  const target = m.pages().find(p => p.type === 'page');
  if (!target) throw new Error('演示工程里没有普通页');
  m.setCurrentPage(target.id);
  const vars = [
    ['x1', 'real', 1], ['y1', 'real', 2], ['x2', 'real', 3], ['y2', 'real', 4],
    ['arrX', 'real[]', []], ['arrY', 'real[]', []],
    ['xyStart', 'bool', false], ['xyClear', 'bool', false],
  ];
  vars.forEach(([name, type, value]) => {
    const old = m.data.variables.find(v => v.name === name);
    if (old) { old.type = type; old.value = value; old.address = ''; }
    else m.data.variables.push({ name, type, address: '', value });
  });
  m.commit('XY 波形测试：变量');
  window.app.varStore.resetFrom(m.variables());
  const w = m.addWidget('xyplot', 40, 40);
  m.updateWidgetProp(w.id, 'pairs', 'x1,y1\nx2,y2');
  m.updateWidgetProp(w.id, 'sampleMs', 50);
  m.updateWidgetProp(w.id, 'points', 500);
  m.commit('XY 波形测试：控件');
  return { id: w.id, page: target.id };
});
await sleep(400);

/* ── 通用小工具 ── */
const setVar = async (name, value) => {
  await page.evaluate(async ([name, value]) => {
    const { varStore } = await import('/js/runtime/varstore.js');
    varStore.set(name, value);
  }, [name, value]);
};
const setPairs = async (text) => {
  await page.evaluate(([id, text]) => window.app.project.updateWidgetProp(id, 'pairs', text), [S.id, text]);
  await sleep(250);
};
const setProps = async (patch) => {
  await page.evaluate(([id, patch]) => {
    const { project } = window.app;
    Object.keys(patch).forEach(k => project.updateWidgetProp(id, k, patch[k]));
  }, [S.id, patch]);
  await sleep(250);
};
const xyState = () => page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  if (!el || typeof el.__xyState !== 'function') return null;
  return el.__xyState();
}, S.id);
const inkRatio = (sel) => page.evaluate((s) => {
  const cv = document.querySelector(s);
  if (!cv) return -1;
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let diff = 0, total = 0;
  for (let i = 0; i < d.length; i += 4 * 37) {
    total++;
    if (d[i + 3] > 24) diff++;
  }
  return diff / total;
}, sel);

/* ═══════════ 1. 注册 / 工具箱 / 属性面板（编辑态） ═══════════ */
const reg = await page.evaluate(async (id) => {
  const { registry } = await import('/js/widgets/registry.js');
  const def = registry.get('xyplot');
  const box = [...document.querySelectorAll('#toolboxList .tb-item')].map(e => e.textContent.trim());
  const canvas = document.querySelector(`#canvas .wd[data-id="${id}"] canvas.wxy-cv`);
  return {
    ok: !!def,
    title: def ? def.title : '', sub: def ? def.sub : '', selfDrawn: def ? def.selfDrawn === true : false,
    props: def ? (def.props || []).map(p => p.key) : [],
    hints: def ? (def.props || []).filter(p => p && p.hint).map(p => p.key) : ['NO_DEF'],
    pairsI18n: def ? ((def.props || []).find(p => p.key === 'pairs') || {}).i18n || '' : 'NO_DEF',
    inToolbox: box.some(t => t.includes('XY 波形')),
    canvas: !!canvas,
    canvasStyle: canvas ? canvas.getAttribute('style') || '' : '',
  };
}, S.id);
ok('★ 注册成功：type=xyplot / title「XY 波形」/ sub 带「多对 X/Y」/ selfDrawn',
  reg.ok && reg.title === 'XY 波形' && reg.sub.indexOf('多对 X/Y') >= 0 && reg.selfDrawn === true,
  JSON.stringify({ title: reg.title, sub: reg.sub, selfDrawn: reg.selfDrawn }));
ok('★ 工具箱里出现「XY 波形」', reg.inToolbox);
ok('★ 编辑态渲染出 canvas 容器（wxy-cv），带内联网格静态示意',
  reg.canvas && reg.canvasStyle.indexOf('background-image') >= 0, JSON.stringify({ canvas: reg.canvas }));
const NEED_PROPS = ['pairs', 'sampleMs', 'points', 'autoX', 'xMin', 'xMax', 'autoY', 'yMin', 'yMax',
  'showGrid', 'showLegend', 'xTicks', 'yTicks', 'showCaptureBtn', 'showClearBtn', 'lineWidth', 'pointSize', 'decimals',
  'bgColor', 'gridColor', 'textColor', 'borderColor', 'borderWidth', 'radius'];
ok('★ props 齐全（pairs/sampleMs/points/范围/网格/图例/线宽/圆点/小数位/配色/边框圆角）',
  NEED_PROPS.every(k => reg.props.includes(k)),
  JSON.stringify(NEED_PROPS.filter(k => !reg.props.includes(k))));
ok('★ 属性面板：props 一律没有 hint（现场要求）、pairs 也没声明 i18n（变量对不是给人看的文字）',
  reg.hints.length === 0 && reg.pairsI18n === '', JSON.stringify({ hints: reg.hints, i18n: reg.pairsI18n }));
// 选中控件 → 属性面板里真的长出新输入格
await page.evaluate(async (id) => {
  const { select } = await import('/js/editor/canvas.js');
  select([id]);
}, S.id);
await sleep(200);
const panel = await page.evaluate(() => {
  const keys = [...document.querySelectorAll('#propBody [data-prop]')].map(e => e.dataset.prop);
  const bodyText = document.getElementById('propBody').textContent || '';
  return { keys, text: bodyText };
});
ok('★ 属性面板长出 pairs（textarea）等新输入格',
  NEED_PROPS.every(k => panel.keys.includes(k)),
  JSON.stringify(NEED_PROPS.filter(k => !panel.keys.includes(k))));

/* ═══════════ 2. 运行态：2 对标量（n 增长 / 范围 / 像素） ═══════════ */
await page.evaluate(() => window.app.enterRun());
await sleep(500);
for (let k = 0; k < 10; k++) {
  await page.evaluate((i) => {
    window.app.varStore.set('x1', 1 + i, 'local');
    window.app.varStore.set('y1', 2 + i * 2, 'local');
    window.app.varStore.set('x2', 3 + i, 'local');
    window.app.varStore.set('y2', 4 + i * 2, 'local');
  }, k);
  await sleep(80);
}
const st1 = await xyState();
ok('★ 运行态：__xyState() 有 2 对标量，n 已随采样增长',
  !!st1 && st1.pairs.length === 2
  && st1.pairs.every(p => p.kind === 'scalar' && p.n > 3 && Number.isFinite(p.lastX)),
  JSON.stringify(st1 && { pairs: st1.pairs }));
await sleep(500);
const st2 = await xyState();
ok('★ 标量对缓冲持续累加（500ms 后 n 变多）',
  !!st1 && !!st2 && st2.pairs[0].n > st1.pairs[0].n && st2.pairs[1].n > st1.pairs[1].n,
  JSON.stringify({ before: st1 && st1.pairs.map(p => p.n), after: st2 && st2.pairs.map(p => p.n) }));
ok('★ 自动范围覆盖数据（x 约 1~11、y 约 2~24，范围比数据宽且有限）',
  !!st2 && st2.xMin <= 1 && st2.xMax >= 11 && st2.yMin <= 2 && st2.yMax >= 22
  && Number.isFinite(st2.xMin) && Number.isFinite(st2.xMax),
  JSON.stringify(st2 && { xMin: st2.xMin, xMax: st2.xMax, yMin: st2.yMin, yMax: st2.yMax }));
const ink = await inkRatio(`#rtPage .wd[data-id="${S.id}"] canvas.wxy-cv`);
ok('★ 运行态 canvas 有非空像素（真的画出了曲线/网格，不是空白）', ink > 0.02, `ink=${ink.toFixed(3)}`);

/* ═══════════ 3. pairs 解析：空行 / 认不出的行跳过 ═══════════ */
await setPairs('\n  x1,y1  \n\n只有一列\nx1,y1,多出来的\n，x2，y2\n');
const stSkip = await xyState();
ok('★ pairs 解析：空行、非两列的行跳过，中文逗号 / 前后空格能认',
  !!stSkip && stSkip.pairs.length === 2
  && stSkip.pairs[0].x === 'x1' && stSkip.pairs[1].x === 'x2',
  JSON.stringify(stSkip && stSkip.pairs.map(p => p.x + '→' + p.y)));
await setPairs('x1,y1\nx2,y2');
await sleep(300);

/* ═══════════ 4. 数组描点：整条刷新、不累加、长度不等取 min ═══════════ */
await setPairs('x1,y1\narrX,arrY');
await page.evaluate(() => {
  const vs = window.app.varStore;
  vs.values.arrX = [0, 1, 2, 3, 4];
  vs.values.arrY = [0, 1, 4, 9, 16];
});
await sleep(350);
const arr1 = await xyState();
ok('★ 数组描点：X/Y 都是数组 → kind=array、n=min(lenX,lenY)=5、lastX/lastY 是最末元素',
  !!arr1 && arr1.pairs.length === 2 && arr1.pairs[1].kind === 'array'
  && arr1.pairs[1].n === 5 && arr1.pairs[1].lastX === 4 && arr1.pairs[1].lastY === 16,
  JSON.stringify(arr1 && arr1.pairs[1]));
await sleep(400);
const arr2 = await xyState();
ok('★ 数组模式不累加：连续两拍 n 不变（数组没变 → 整条重画）',
  !!arr1 && !!arr2 && arr2.pairs[1].n === arr1.pairs[1].n,
  JSON.stringify({ a: arr1 && arr1.pairs[1].n, b: arr2 && arr2.pairs[1].n }));
await page.evaluate(() => {
  const vs = window.app.varStore;
  vs.values.arrX = [10, 11, 12];
  vs.values.arrY = [100, 110, 120];
});
await sleep(350);
const arr3 = await xyState();
ok('★ 数组一变整条刷新：n 跟着新数组变成 3，lastX/lastY 换成新数据（不是旧缓冲拼出来的）',
  !!arr3 && arr3.pairs[1].kind === 'array' && arr3.pairs[1].n === 3
  && arr3.pairs[1].lastX === 12 && arr3.pairs[1].lastY === 120,
  JSON.stringify(arr3 && arr3.pairs[1]));
await page.evaluate(() => {
  const vs = window.app.varStore;
  vs.values.arrX = [0, 1, 2];
  vs.values.arrY = [0, 1, 4, 9, 16, 25];   // 故意比 X 长
});
await sleep(350);
const arr4 = await xyState();
ok('★ 数组长度不等：按 min(lenX,lenY) 配对（3 vs 6 → n=3）',
  !!arr4 && arr4.pairs[1].n === 3, JSON.stringify(arr4 && arr4.pairs[1]));
const arrInk = await inkRatio(`#rtPage .wd[data-id="${S.id}"] canvas.wxy-cv`);
ok('★ 数组描点画面有像素（数组曲线画出来了）', arrInk > 0.02, `ink=${arrInk.toFixed(3)}`);

/* ═══════════ 5. 手动范围 / 最多 8 对 ═══════════ */
await setProps({ autoX: false, xMin: -10, xMax: 10, autoY: false, yMin: -20, yMax: 20 });
const manual = await xyState();
ok('★ 手动范围生效：autoX/autoY 关掉 → state 里的四边范围 = props 里的值',
  !!manual && manual.xMin === -10 && manual.xMax === 10
  && manual.yMin === -20 && manual.yMax === 20,
  JSON.stringify(manual && { x: [manual.xMin, manual.xMax], y: [manual.yMin, manual.yMax] }));
await setProps({ autoX: true, autoY: true });
await setPairs(Array.from({ length: 10 }, (_, i) => `vx${i},vy${i}`).join('\n'));
const many = await xyState();
ok('★ 最多 8 对：给 10 行也只保留 8 对（多出来的忽略）',
  !!many && many.pairs.length === 8, String(many && many.pairs.length));

/* ═══════════ 6. 切回标量对仍工作 ═══════════ */
await setPairs('x1,y1');
await sleep(400);
const back1 = await xyState();
await sleep(400);
const back2 = await xyState();
ok('★ 切回标量对仍工作：kind=scalar、n 继续增长（数组→标量会清掉旧数组缓冲）',
  !!back1 && !!back2 && back1.pairs.length === 1 && back1.pairs[0].kind === 'scalar'
  && back2.pairs[0].n > back1.pairs[0].n,
  JSON.stringify({ a: back1 && back1.pairs, b: back2 && back2.pairs }));

/* ═══════════ 7. 画面按钮、变量控制和数组清除 ═══════════ */
await page.evaluate(async id => {
  const { project: m } = window.app;
  window.app.exitRun();
  m.updateWidgetProp(id, 'pairs', 'x1,y1\narrX,arrY');
  (await import('/js/editor/canvas.js')).select([id]);
}, S.id);
await page.locator('#propBody [data-prop="showCaptureBtn"]').check();
await page.locator('#propBody [data-prop="showClearBtn"]').check();
const editXY = page.locator(`#canvas .wd[data-id="${S.id}"]`);
const runXY = page.locator(`#rtPage .wd[data-id="${S.id}"]`);
const capture = runXY.getByRole('button', { name: /抓取/ });
const clear = runXY.getByRole('button', { name: '清除数据' });
const readHeader = widget => widget.locator('.w-plot-header').evaluate(el => {
  const legend = el.querySelector('.w-plot-legend');
  const labels = legend.getBoundingClientRect();
  const buttons = el.querySelector('.w-plot-tools').getBoundingClientRect();
  return {
    legend: legend.textContent,
    sameRow: Math.abs((labels.top + labels.height / 2) - (buttons.top + buttons.height / 2)) < 1
      && labels.right <= buttons.left,
  };
});
const editHeader = await readHeader(editXY);
ok('★ XY 编辑态：变量对和按钮同一行，按钮只预览',
  editHeader.sameRow && editHeader.legend.includes('arrX→arrY')
  && await editXY.getByRole('button', { name: '开始抓取' }).isDisabled()
  && await editXY.getByRole('button', { name: '清除数据' }).isDisabled());

const enter = () => page.evaluate(async () => {
  await window.app.enterRun();
  (await import('/js/runtime/runtime.js')).hideRuntimeHint();
});
const setArrays = (x, y) => page.evaluate(([x, y]) => {
  window.app.varStore.values.arrX = x;
  window.app.varStore.values.arrY = y;
}, [x, y]);
await enter();
await setArrays([1, 2, 3], [2, 4, 6]);
await sleep(160);
ok('★ XY 运行态：图例同排，手动抓取初始等待开始',
  (await readHeader(runXY)).sameRow && await capture.textContent() === '开始抓取'
  && (await xyState()).pairs.every(pair => pair.n === 0));
await capture.click();
await sleep(240);
const grabbed = await xyState();
ok('★ XY 开始抓取采标量和数组，图例标记数组对',
  grabbed.pairs[0].n > 1 && grabbed.pairs[1].n === 3
  && (await readHeader(runXY)).legend.includes('arrX→arrY 数组'));
await capture.click();
const stopped = await xyState();
await setArrays([10, 20], [30, 40]);
await sleep(200);
const held = await xyState();
ok('★ XY 停止抓取会同时冻结两种曲线',
  held.pairs[0].n === stopped.pairs[0].n && held.pairs[1].n === 3 && held.pairs[1].lastY === 6);
await clear.click();
await sleep(140);
ok('★ XY 停止时清除两种曲线',
  (await xyState()).pairs.every(pair => pair.n === 0));
await capture.click();
await sleep(180);
await clear.click();
await setArrays([10, 20], [30, 40]); // PLC 回读相同数组，不会重画旧曲线
await sleep(180);
ok('★ XY 抓取中清除数组后，相同回读不会恢复旧曲线',
  (await xyState()).pairs[1].n === 0);
await setArrays([10, 20], [31, 41]);
await sleep(180);
ok('★ XY 收到新数组后继续画曲线',
  (await xyState()).pairs[1].n === 2 && (await xyState()).pairs[1].lastY === 41);

await page.evaluate(id => {
  window.app.exitRun();
  const m = window.app.project;
  const binding = m.getWidget(id).bindings;
  binding.startVar = 'xyStart';
  binding.clearVar = 'xyClear';
  m.commit('切换为 XY 外部控制');
}, S.id);
await enter();
await setArrays([1, 2], [2, 4]);
await sleep(150);
const scope = await page.evaluate(async () => (await import('/js/runtime/runtime.js')).pageVarScope());
ok('★ XY 外部变量均进入采集范围，对应按钮隐藏且初始停止',
  scope.includes('xyStart') && scope.includes('xyClear') && await capture.count() === 0
  && await clear.count() === 0 && (await xyState()).pairs.every(pair => pair.n === 0));
await setVar('xyStart', true);
await sleep(180);
ok('★ XY 外部启动为 1 时抓取', (await xyState()).pairs[1].n === 2);
await setVar('xyStart', false);
await setVar('xyClear', true);
await sleep(200);
ok('★ XY 外部清除上升沿在停止时也能清空', (await xyState()).pairs.every(pair => pair.n === 0));
await setVar('xyStart', true);
await sleep(210);
ok('★ XY 外部清除保持为 1 不会反复清除', (await xyState()).pairs[1].n === 2);

await page.evaluate(() => window.app.exitRun());
await sleep(200);
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
try { srv.kill(); } catch { /* 忽略 */ }
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== XY 波形控件回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
