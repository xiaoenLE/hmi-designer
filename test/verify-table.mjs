// verify-table.mjs — 表格控件：画格子（行列 / 表头 / 单元格文字 / 样式）
// 用法：先启动 8866 后端，再 node test/verify-table.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });
// 后端隔离：本套件只画表格，不连 PLC
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(200);

/* ── A. 控件已注册且出现在工具箱 ── */
const meta = await page.evaluate(async () => {
  const r = await import('/js/widgets/registry.js');
  const d = r.registry.get('table');
  return {
    has: !!d, title: d?.title, hidden: !!d?.hidden,
    defW: d?.defaults?.w, defH: d?.defaults?.h,
    toolbox: [...document.querySelectorAll('#toolboxList .tb-item, #toolboxList > div')]
      .some(el => el.textContent?.trim().startsWith('表格')),
  };
});
ok('表格控件已注册（标题「表格」）', meta.has && meta.title === '表格', JSON.stringify(meta.title));
ok('默认尺寸 300×120', meta.defW === 300 && meta.defH === 120, `${meta.defW}×${meta.defH}`);
ok('出现在左侧控件工具箱里', meta.toolbox === true, String(meta.toolbox));

/* ── 建一个表格控件，方便后面改属性 ── */
const id = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.pages[0].widgets.length = 0;
  const w = m.project.addWidget('table', 40, 40);
  m.project.commit('表格测试');
  return w.id;
});
await page.waitForTimeout(200);

/** 读画布上表格的结构与样式 */
const grab = () => page.evaluate((wid) => {
  const el = document.querySelector(`#canvas .wd[data-id="${wid}"] .w-table`);
  if (!el) return null;
  const thead = el.querySelector('thead');
  const rows = [...el.querySelectorAll('tbody tr')];
  const td = el.querySelector('tbody td') || el.querySelector('td');
  return {
    cols: el.querySelectorAll('colgroup col').length,
    head: thead ? [...thead.querySelectorAll('td')].map(t => t.textContent) : null,
    rowCount: rows.length,
    firstRow: rows[0] ? [...rows[0].querySelectorAll('td')].map(t => t.textContent) : null,
    rowCls: rows.map(r => r.className),                 // 每行 class（斑马纹用）
    cellStyle: td ? td.getAttribute('style') : '',
    tableStyle: el.getAttribute('style'),
    inputs: el.querySelectorAll('input,textarea,select').length,
  };
}, id);

/* ── B. 默认渲染：3 行 × 3 列 + 表头 ── */
let g = await grab();
ok('默认：3 列', g.cols === 3, String(g.cols));
ok('默认：表头一行 3 格（列1/列2/列3）',
  JSON.stringify(g.head) === JSON.stringify(['列1', '列2', '列3']), JSON.stringify(g.head));
ok('默认：表体 3 行', g.rowCount === 3, String(g.rowCount));
ok('默认：表体格子是空的（画格子而已）',
  JSON.stringify(g.firstRow) === JSON.stringify(['', '', '']), JSON.stringify(g.firstRow));
ok('表格里没有输入框（不抢光标）', g.inputs === 0, String(g.inputs));

/* ── C. 列数/行数/表头文字 ── */
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const p = (k, v) => m.project.updateWidgetProp(wid, k, v);
  p('cols', 4); p('rows', 2); p('headers', '名称,数值,单位');
  p('cells', '速度,12.5,m/min\n计数,8600,件\n多余的一行,会被忽略,-');
  m.project.commit('表格属性');
}, id);
await page.waitForTimeout(250);
g = await grab();
ok('列数 4 → 4 列', g.cols === 4, String(g.cols));
ok('行数 2 → 表体 2 行（多写的一行忽略）', g.rowCount === 2, String(g.rowCount));
ok('表头文字按逗号分列，不够的格子留空',
  JSON.stringify(g.head) === JSON.stringify(['名称', '数值', '单位', '']), JSON.stringify(g.head));
ok('单元格文字按「一行一行、逗号分列」落入格子',
  JSON.stringify(g.firstRow) === JSON.stringify(['速度', '12.5', 'm/min', '']), JSON.stringify(g.firstRow));

/* ── D. 表头可关；斑马纹；行高/字号/对齐 ── */
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'header', false);
  m.project.updateWidgetProp(wid, 'rowH', 30);
  m.project.updateWidgetProp(wid, 'fontSize', 15);
  m.project.updateWidgetProp(wid, 'align', 'center');
  m.project.commit('表格样式');
}, id);
await page.waitForTimeout(250);
g = await grab();
ok('关掉「画表头」→ 不再有 thead', g.head === null, JSON.stringify(g.head));
ok('行高/字号/对齐写进格子样式',
  /height:\s*30px/.test(g.cellStyle) && /font-size:\s*15px/.test(g.cellStyle) && /text-align:\s*center/.test(g.cellStyle),
  g.cellStyle);
ok('斑马纹：第 1 行不填色、第 2 行填色（隔行）',
  !/zebra/.test(g.rowCls[0] || '') && /zebra/.test(g.rowCls[1] || ''), JSON.stringify(g.rowCls));
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'zebra', false);
  m.project.updateWidgetProp(wid, 'borderColor', '#ff0000');
  m.project.updateWidgetProp(wid, 'header', true);
  m.project.commit('表格样式2');
}, id);
await page.waitForTimeout(250);
g = await grab();
ok('关掉斑马纹 → 行不再带色', !/zebra/.test(g.rowCls[1] || ''), JSON.stringify(g.rowCls));
ok('线色写进表格样式', /1px solid #ff0000/.test(g.tableStyle), g.tableStyle);

/* ── E. 文字转义（格子里的 HTML 不能当标签执行） ── */
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'cells', '<b>x</b>,<img src=x onerror=alert(1)>,"引号"');
  m.project.commit('转义测试');
}, id);
await page.waitForTimeout(250);
const esc = await page.evaluate((wid) => {
  const el = document.querySelector(`#canvas .wd[data-id="${wid}"]`);
  const td = el.querySelector('tbody td');
  return { text: td.textContent, html: el.querySelector('.w-table').innerHTML.includes('<b>'), imgs: el.querySelectorAll('tbody img').length };
}, id);
ok('单元格文字按纯文本渲染（HTML 被转义）',
  esc.text === '<b>x</b>' && esc.html === false && esc.imgs === 0, JSON.stringify(esc));

/* ── F. 属性面板：列数/行数/表头/单元格文字（多行输入框） ── */
await page.click(`#canvas .wd[data-id="${id}"]`);
await page.waitForTimeout(250);
const panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.find(r => r.querySelector('.f-label')?.textContent.trim() === t);
  const cells = byLabel('单元格文字')?.querySelector('textarea');
  return {
    labels: ['列数', '行数', '画表头', '表头文字', '单元格文字', '行高', '字号', '对齐', '线色', '斑马纹']
      .filter(t => !!byLabel(t)),
    hasArea: !!cells, areaVal: cells?.value?.split('\n')[0],
    colsVal: byLabel('列数')?.querySelector('input')?.value,
  };
});
ok('属性面板有完整的表格属性',
  panel.labels.length === 10, JSON.stringify(panel.labels));
ok('「单元格文字」是多行输入框，且回显当前内容',
  panel.hasArea && panel.areaVal === '<b>x</b>,<img src=x onerror=alert(1)>,"引号"', JSON.stringify(panel.areaVal));
ok('「列数」回显 4', panel.colsVal === '4', String(panel.colsVal));

/* 在面板里改多行文字 → 画布即时更新，且不打断输入（焦点不丢） */
const live = await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const area = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '单元格文字')?.querySelector('textarea');
  area.focus();
  area.value = 'A1,A2,A3,A4\nB1,B2,B3,B4';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 420));   // 属性输入 300ms 防抖后才写进工程（避免每敲一下都折腾设备）

  return { focused: document.activeElement === area, stillThere: !!document.querySelector('#propBody textarea') };
});
const afterLive = await grab();
ok('面板里改「单元格文字」→ 画布即时更新',
  JSON.stringify(afterLive.firstRow) === JSON.stringify(['A1', 'A2', 'A3', 'A4']), JSON.stringify(afterLive.firstRow));
ok('改字过程中输入框不被重建（焦点还在）', live.focused && live.stillThere, JSON.stringify(live));

/* ── G. 运行态：同样画出来，且没有输入光标 ── */
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
const rt = await page.evaluate((wid) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-table`);
  return {
    has: !!el,
    rows: el ? el.querySelectorAll('tbody tr').length : 0,
    cols: el ? el.querySelectorAll('colgroup col').length : 0,
    first: el ? [...el.querySelectorAll('tbody tr')[0].querySelectorAll('td')].map(t => t.textContent) : null,
    inputs: el ? el.querySelectorAll('input,textarea').length : -1,
    cursor: el ? getComputedStyle(el.closest('.wd')).cursor : '',
  };
}, id);
ok('运行态照原样画出表格（所见即所得）',
  rt.has && rt.rows === 2 && rt.cols === 4 && JSON.stringify(rt.first) === JSON.stringify(['A1', 'A2', 'A3', 'A4']),
  JSON.stringify(rt));
ok('运行态表格里没有输入框、光标是 default（不是 I 形）',
  rt.inputs === 0 && rt.cursor === 'default', `inputs=${rt.inputs} cursor=${rt.cursor}`);
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(200);

/* ── H. 存档：导出的工程里带着表格属性 ── */
const saved = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const w = m.project.getWidget(wid);
  const json = JSON.parse(JSON.stringify(m.project.data));
  const back = json.pages[0].widgets.find(x => x.id === wid);
  m.project.replaceData(json);                      // 走一遍「导入工程」的路径
  const w2 = m.project.getWidget(wid);
  return { type: w.type, cols: back?.props?.cols, rows: back?.props?.rows, after: { cols: w2?.props?.cols, rows: w2?.props?.rows } };
}, id);
ok('工程存档里表格属性完整，重新载入后不变',
  saved.type === 'table' && saved.cols === 4 && saved.rows === 2 && saved.after.cols === 4 && saved.after.rows === 2,
  JSON.stringify(saved));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 表格控件回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
