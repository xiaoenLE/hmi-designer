// 一次性验证：变量表 CSV 导入/导出
import { createRequire } from 'node:module';
import fs from 'node:fs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

// 待导入的测试 CSV（含引号逗号、非法类型、空名等边界）
const CSV1 = '名称,类型,地址,初始值\n电机运行,bool,4x_Bit100.0,1\n设定速度,real,HR0,12.5\n批次号,uint,HR1,-5\n备注,string,,"含,逗号"';
const CSV2 = '名称,类型,地址,初始值\n电机运行,bool,4x_Bit100.1,0\n坏类型,intt,HR9,1\n,real,HR8,1\n设定速度,real,HR0,33.25';
fs.writeFileSync('test/tmp-vars1.csv', '\uFEFF' + CSV1, 'utf-8');

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const dialogs = [];
page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
// 本套件假设后端是内存/Modbus 模式：先断掉可能残留的 OPC UA 连接
// （接着 OPC UA 时地址格按 NodeId 规则走是正确行为，但那和这里的断言无关）
await page.evaluate(() => fetch('/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'disconnect' }),
}).catch(() => {}));
await page.waitForTimeout(300);

/* ── 清空变量表，从零开始 ── */
await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.commit('清空变量');
})());
await page.waitForTimeout(150);

/* ── A. 纯函数：导出格式 ── */
const csvOut = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const c = await import('/js/core/csv.js');
  const vars = [
    { name: '电机运行', type: 'bool', address: '4x_Bit100.0', value: true },
    { name: '备注', type: 'string', address: '', value: '含,逗号' },
  ];
  return c.varsToCsv(vars);
});
ok('导出带 UTF-8 BOM', csvOut.charCodeAt(0) === 0xFEFF);
ok('首行表头 + CRLF 行距（含「长度」列 + 新的「保持」列）',
  csvOut.startsWith('\uFEFF名称,类型,地址,长度,初始值,保持\r\n'),
  JSON.stringify(csvOut.split('\r\n')[0]));
ok('含逗号的字段自动加引号', csvOut.includes('"含,逗号"'), JSON.stringify(csvOut.split('\r\n')[2]));
ok('老的四列格式（名称,类型,地址,初值）照样能导出成新格式',
  csvOut.includes('电机运行,bool,4x_Bit100.0,,true'), JSON.stringify(csvOut.split('\r\n')[1]));

/* ── B. UI 导入：change 事件 → 真实文件（onchange 已在 init 时绑定） ── */
await page.click('.lp-tab[data-tab="vars"]');   // 切到「变量」tab，面板可见
const importViaUI = async (file) => {
  await page.setInputFiles('#varCsvFile', file);
  await page.waitForTimeout(300);
};
await importViaUI('test/tmp-vars1.csv');
const varsA = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return m.project.variables().map(v => ({ ...v }));
});
ok('导入 4 个变量（同名不存在→新增）', varsA.length === 4, JSON.stringify(varsA.map(v => v.name)));
const byName = (n) => varsA.find(v => v.name === n) || {};
ok('bool 初值 "1" → true，地址保留', byName('电机运行').value === true && byName('电机运行').address === '4x_Bit100.0');
ok('real 初值 12.5', byName('设定速度').value === 12.5);
ok('uint 负数钳位 0', byName('批次号').value === 0, String(byName('批次号').value));
ok('引号内逗号正确解析（string）', byName('备注').value === '含,逗号', String(byName('备注').value));
ok('导入完成提示（alert 文案）', (dialogs[0] || '').includes('新增 4 个'), (dialogs[0] || '').split('\n')[0]);
const rowCount = await page.evaluate(() => document.querySelectorAll('#varTable tbody tr').length);
ok('变量面板自动刷新显示 4 行', rowCount === 4, String(rowCount));

/* ── C. 二次导入：同名更新 + 非法行跳过 ── */
fs.writeFileSync('test/tmp-vars2.csv', CSV2, 'utf-8');
await importViaUI('test/tmp-vars2.csv');
const stateB = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const vars = m.project.variables();
  return {
    count: vars.length,
    motor: vars.find(v => v.name === '电机运行'),
    speed: vars.find(v => v.name === '设定速度'),
  };
});
ok('同名更新不重复新增（总数仍 4）', stateB.count === 4, String(stateB.count));
ok('电机运行：地址/初值被更新（false / 4x_Bit100.1）', stateB.motor.value === false && stateB.motor.address === '4x_Bit100.1');
ok('设定速度：初值更新 33.25', stateB.speed.value === 33.25);
ok('非法行被跳过并回报（2 行）', (dialogs[1] || '').includes('跳过 2 行'), (dialogs[1] || '').split('\n').slice(0, 3).join(' | '));

/* ── D. UI 导出：真实下载 ── */
// ⚠ 浏览器里点导出默认弹系统「另存为」框（js/core/csv.js 的 saveTextFile → showSaveFilePicker），
//   自动化点不了那个原生框 —— 这里先摘掉保存框接口，验的是**退回浏览器下载**那条路
//   （弹框那条路在 verify-export-file.mjs 里用假 handle 验）
await page.evaluate(() => { delete window.showSaveFilePicker; });
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnExportVars'),
]);
await download.saveAs('test/tmp-export.csv');
const exported = fs.readFileSync('test/tmp-export.csv', 'utf-8');
ok('下载文件带 BOM、表头正确', exported.charCodeAt(0) === 0xFEFF && exported.includes('名称,类型,地址,长度,初始值'),
  JSON.stringify(exported.split('\r\n')[0]));
ok('导出内容与变量表一致（bool→false 原样）', exported.includes('电机运行,bool,4x_Bit100.1,,false'), exported.split('\r\n')[1] || '');
// 字符串带长度导出：备注 是 string 且没有设过长度 → 默认 10
ok('字符串变量导出带长度列', /备注,string,,10,/.test(exported), (exported.split('\r\n').find(l => l.includes('备注')) || ''));

/* ── D2. 老的四列文件仍然能导入（不能因为加了长度列就不认老文件）── */
fs.writeFileSync('test/tmp-vars3.csv', '名称,类型,地址,初值\n老字符串,string,%MW300,老值\n老实数,real,HR5,7.5', 'utf-8');
await importViaUI('test/tmp-vars3.csv');
const legacy = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const vars = m.project.variables();
  return { s: vars.find(v => v.name === '老字符串'), r: vars.find(v => v.name === '老实数') };
});
ok('老四列 CSV：string 的初值没被当成长度吃掉',
  legacy.s?.value === '老值' && (legacy.s?.len || 10) === 10, JSON.stringify(legacy.s));
ok('老四列 CSV：real 的初值照旧', legacy.r?.value === 7.5, JSON.stringify(legacy.r));

/* ── E. 纯函数：解析器边界 ── */
const edge = await page.evaluate(async () => {
  const c = await import('/js/core/csv.js');
  const rows = c.parseCsv('a,"b""q",c\n\ntest,1');
  return { rows, n: rows.length };
});
ok('引号转义 "" 与空行过滤', JSON.stringify(edge.rows) === JSON.stringify([['a', 'b"q', 'c'], ['test', '1']]), JSON.stringify(edge.rows));

/* ── F. 地址统一成 %MW 写法（HR100 / 100 → %MW100）── */
const hex = await page.evaluate(async () => {
  const u = await import('/js/core/utils.js');
  return {
    hr: u.normAddr('HR100'), hrLower: u.normAddr('hr100'), bare: u.normAddr('100'),
    bare0: u.normAddr('0'), mwLower: u.normAddr('%mw200'), md: u.normAddr('%MD50'),
    span: u.normAddr('%mw200[10]'), std4x: u.normAddr('40101'), x4: u.normAddr('4x0101'),
    db: u.normAddr('DB1.DBD4'), junk: u.normAddr('4x_Bit100.0'), empty: u.normAddr('  '),
    four: u.normAddr('4X00FF'),
  };
});
ok('HR100 → %MW100（大小写都认）', hex.hr === '%MW100' && hex.hrLower === '%MW100', JSON.stringify([hex.hr, hex.hrLower]));
ok('纯数字 100 → %MW100、0 → %MW0', hex.bare === '%MW100' && hex.bare0 === '%MW0', JSON.stringify([hex.bare, hex.bare0]));
ok('%mw200 大小写统一 → %MW200，段写法 %mw200[10] → %MW200[10]',
  hex.mwLower === '%MW200' && hex.span === '%MW200[10]', JSON.stringify([hex.mwLower, hex.span]));
ok('%MD50 不动（本来就是 %MW 写法）', hex.md === '%MD50', hex.md);
ok('标准 4x 写法（40101）不动 —— 后端按 40001=偏移0，改了意思就变了', hex.std4x === '40101', hex.std4x);
ok('认不出的地址（DB1.DBD4 / 4x_Bit100.0）原样留着，交给后端报错',
  hex.db === 'DB1.DBD4' && hex.junk === '4x_Bit100.0' && hex.empty === '', JSON.stringify([hex.db, hex.junk, hex.empty]));

/* 面板里手打：输入框自己会转 */
const typed = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.addVariable();
  m.project.updateVariable('var1', { name: 'rIn', type: 'real' });
  m.project.commit('t');
  const inp = document.querySelector('#varTable input[data-k="address"]');
  const set = (v) => { inp.value = v; inp.dispatchEvent(new Event('change', { bubbles: true })); return inp.value; };
  const out = { hr: set('HR100'), bare: set('100'), md: set('%md50'), junk: set('DB1.DBD4') };
  out.stored = m.project.variables()[0].address;
  return out;
});
ok('变量表里打 HR100 → 立刻变成 %MW100', typed.hr === '%MW100', typed.hr);
ok('变量表里打 100 → 变成 %MW100', typed.bare === '%MW100', typed.bare);
ok('变量表里打 %md50 → 统一成 %MD50', typed.md === '%MD50', typed.md);
ok('认不出的写法不硬转（DB1.DBD4 留着，提示交给 title）', typed.junk === 'DB1.DBD4', typed.junk);

/* CSV 导入也照样转：老文件里写 HR5 也能用 */
const csvNorm = await page.evaluate(async () => {
  const c = await import('/js/core/csv.js');
  const m = await import('/js/core/project.js');
  c.importCsv('名称,类型,地址,初值\nCSV老写法,real,HR5,7.5\nCSV新写法,real,%MW7,8.5');
  const v = m.project.variables();
  return { old: v.find(x => x.name === 'CSV老写法')?.address, neu: v.find(x => x.name === 'CSV新写法')?.address };
});
ok('CSV 导入：HR5 → %MW5，%MW7 不动', csvNorm.old === '%MW5' && csvNorm.neu === '%MW7', JSON.stringify(csvNorm));

/* 存档里的老地址在载入时也会被转（老工程打开就统一了） */
const migrated = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const KEY = 'hmi-designer-project-v1';
  const mini = {
    meta: { name: '迁移测试', canvas: { w: 800, h: 600, bg: '#fff' } },
    variables: [
      { name: 'oldVar', type: 'int', address: 'HR321', value: 3 },
      { name: 'oldBare', type: 'real', address: '100', value: 1 },
      { name: 'oldOk', type: 'real', address: '%MW400', value: 2 },
    ],
    pages: [{ id: 'pg_x', name: '画面1', type: 'page', widgets: [] }],
  };
  localStorage.setItem(KEY, JSON.stringify(mini));
  m.project.load();
  return { addrs: m.project.variables().map(v => v.address), n: m.project.variables().length };
});
ok('存档里的 HR321 / 100 载入时转成 %MW321 / %MW100（%MW400 不动）',
  JSON.stringify(migrated.addrs) === JSON.stringify(['%MW321', '%MW100', '%MW400']), JSON.stringify(migrated));

/* ── F2. 按标准分配地址：bool 用位地址（%MX/QX/IX），字类型用 %MW/%MD ── */
const style = await page.evaluate(async () => {
  const vp = await import('/js/editor/varsPanel.js');
  const u = await import('/js/core/utils.js');
  return {
    boolOnWord: vp.describeAddress('%MW0', 'bool', 0),
    boolOnBit: vp.describeAddress('%MX0.0', 'bool', 0),
    realOnBit: vp.describeAddress('%MX0.0', 'real', 0),
    realOnWord: vp.describeAddress('%MW100', 'real', 0),
    boolOnCoil: vp.describeAddress('%QX0', 'bool', 0),
    isBit: [u.isBitAddr('%MX0.0'), u.isBitAddr('%QX5'), u.isBitAddr('%IX1'), u.isBitAddr('%MW100'), u.isBitAddr('100')],
    bumpBit: [u.bumpAddr('%MX0.0', 1), u.bumpAddr('%MX0.7', 1), u.bumpAddr('%MX1.3', -4), u.bumpAddr('%QX5', 2), u.bumpAddr('%IX0', 1)],
  };
});
ok('bool 落在 %MW 上会提醒「标准写法用位地址」', /位地址/.test(style.boolOnWord) && /%MX0\.0/.test(style.boolOnWord), style.boolOnWord);
ok('bool 落在 %MX / %QX 上不唠叨', !/⚠/.test(style.boolOnBit) && !/⚠/.test(style.boolOnCoil), JSON.stringify([style.boolOnBit, style.boolOnCoil]));
ok('字类型落在位地址上会提醒（real 放不进 1 个位）', /位地址/.test(style.realOnBit) && !/⚠/.test(style.realOnWord), JSON.stringify([style.realOnBit, style.realOnWord]));
ok('isBitAddr 认 %MX0.0 / %QX5 / %IX1，不认 %MW100 / 100',
  JSON.stringify(style.isBit) === JSON.stringify([true, true, true, false, false]), JSON.stringify(style.isBit));
ok('位地址按位递增：%MX0.0+1→%MX0.1，%MX0.7+1→%MX1.0，%MX1.3-4→%MX0.7；%QX5+2→%QX7',
  JSON.stringify(style.bumpBit) === JSON.stringify(['%MX0.1', '%MX1.0', '%MX0.7', '%QX7', '%IX1']),
  JSON.stringify(style.bumpBit));

/* 默认模板（新工程）里的地址风格：**bool 一律位地址、字类型一律字地址**
   （内置模板会换，所以这里不写死 %MX/%MW 三个前缀，只验"按类型分风格"这条规矩：
     bool → %MX/%QX/%IX 的 位号写法；real/int/dint… → %MW/%MD 的字写法。
     现在的模板用的是 %IX（输入位）/%QX（输出位）/%MW/%MD —— 这正是现场接 PLC 的写法。） */
const seedVars = await page.evaluate(() => {
  const KEY = 'hmi-designer-project-v1';
  const keep = localStorage.getItem(KEY);
  localStorage.removeItem(KEY);
  return import('/js/core/project.js').then(async (m) => {
    m.project.load();                 // 没存档 → 用默认模板
    const vars = m.project.variables().map(v => ({ n: v.name, t: v.type, a: v.address }));
    if (keep) localStorage.setItem(KEY, keep);
    return vars;
  });
});
const seedBool = seedVars.filter(v => v.t === 'bool' && v.a);          // 只看有地址的（内部变量留空）
const seedWord = seedVars.filter(v => v.t !== 'bool' && v.a);
ok('默认模板：bool 变量用**位地址**（%MX0.0 / %QX0.0 / %IX0.0 这类）',
  seedBool.length > 0 && seedBool.every(v => /^%[MQI]X\d+\.\d$/.test(v.a)),
  JSON.stringify(seedBool.slice(0, 6)));
ok('默认模板：字类型用**字地址**（%MW/%MD）',
  seedWord.length > 0 && seedWord.every(v => /^%M[WD]\d+$/.test(v.a)),
  JSON.stringify(seedWord.map(v => `${v.n}:${v.a}`).slice(0, 6)));

/* ── G. 多选删除变量：勾选 / 全选 / 批量删 / 没人引用就不弹确认 ── */
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.data.pages[0].widgets.length = 0;
  ['v1', 'v2', 'v3', 'v4'].forEach(n => m.project.variables().push({ name: n, type: 'real', address: '%MW100', value: 1 }));
  const w = m.project.addWidget('number', 40, 40);
  m.project.updateWidgetField(w.id, 'bindings.variable', 'v2');   // v2 被控件引用着
  m.project.commit('准备多选删除');
});
await page.waitForTimeout(300);
const ui = await page.evaluate(() => ({
  selCells: document.querySelectorAll('#varTable input[data-k="sel"]').length,
  hasAll: !!document.getElementById('varSelAll'),
  delHidden: document.getElementById('btnDelVars')?.hidden,
  tipLen: (document.querySelector('#varTable .vt-tip')?.textContent || '').replace(/\s+/g, '').length,
}));
ok('变量表每行都有勾选框 + 表头全选', ui.selCells === 4 && ui.hasAll, JSON.stringify(ui));
ok('没勾选时「删除选中」按钮是收起来的', ui.delHidden === true);
// 说明文字保持"三行以内"：① 地址怎么写 ② 留空=内部变量、勾保持=掉电保持 ③ 初值不用填
// （老版本这里是一大段几百字的解释，现场看着累；现在是三条短句，阈值放在 260 字）
ok('变量表面板的说明文字收短了（不再是那一大段）', ui.tipLen > 0 && ui.tipLen < 260, `${ui.tipLen} 字`);

/* 加上勾选框以后，变量表**行尾不再有 ✕**（现场要求）：
   删一条 = 勾上它 + 底部「删除选中 (1)」，或者在这一行右键「删除变量」 */
const noRowDel = await page.evaluate(() => ({
  rowDel: !!document.querySelector('#varTable tr[data-name] .vt-del'),
  cols: document.querySelector('#varTable tr[data-name]')?.children.length,
  heads: document.querySelectorAll('#varTable thead th').length,
}));
ok('变量表行尾的「✕」已经去掉（5 列 = 勾选/名称/类型/地址/保持）',
  noRowDel.rowDel === false && noRowDel.cols === 5 && noRowDel.heads === 5, JSON.stringify(noRowDel));

/* 单个删除：没人引用 → 勾上它、点「删除选中」不弹确认，直接就删了 */
const before1 = dialogs.length;
await page.evaluate(() => {
  const tr = [...document.querySelectorAll('#varTable tr[data-name]')].find(t => t.dataset.name === 'v1');
  tr.querySelector('input[data-k="sel"]').click();
});
await page.waitForTimeout(200);
await page.click('#btnDelVars');
await page.waitForTimeout(250);
const solo = await page.evaluate(async () => (await import('/js/core/project.js')).project.variables().map(v => v.name));
ok('删没人引用的变量：不弹确认，直接就删了',
  dialogs.length === before1 && !solo.includes('v1'), JSON.stringify({ dialogs: dialogs.length - before1, solo }));

/* 单个删除：还被引用 → 弹一次确认，说明有几处引用 */
await page.evaluate(() => {
  const tr = [...document.querySelectorAll('#varTable tr[data-name]')].find(t => t.dataset.name === 'v2');
  tr.querySelector('input[data-k="sel"]').click();
});
await page.waitForTimeout(200);
await page.click('#btnDelVars');
await page.waitForTimeout(250);
const refMsg = dialogs[dialogs.length - 1] || '';
const afterRef = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { names: m.project.variables().map(v => v.name), bind: m.project.currentWidgets()[0]?.bindings.variable };
});
ok('删还被引用的变量：弹一次确认并说明「还有 1 处引用」',
  /还有 1 处引用/.test(refMsg) && /v2/.test(refMsg), refMsg.replace(/\n/g, ' | ').slice(0, 70));
ok('确认后：变量删掉、控件绑定被清空', !afterRef.names.includes('v2') && afterRef.bind === '', JSON.stringify(afterRef));

/* 撤销能把删掉的变量找回来（所以单个删除不用弹确认也不怕手滑） */
await page.evaluate(() => window.app.history.undo());
await page.waitForTimeout(250);
const undone = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { names: m.project.variables().map(v => v.name), bind: m.project.currentWidgets()[0]?.bindings.variable };
});
ok('Ctrl+Z 撤销 → v2 和它的控件绑定一起回来（一次删除 = 一步撤销）',
  undone.names.includes('v2') && undone.bind === 'v2', JSON.stringify(undone));
await page.evaluate(() => window.app.history.undo());
await page.waitForTimeout(250);
const undone2 = await page.evaluate(async () => (await import('/js/core/project.js')).project.variables().map(v => v.name));
ok('再撤销一步 → v1 也回来（四次变量都在了）',
  JSON.stringify(undone2) === JSON.stringify(['v1', 'v2', 'v3', 'v4']), JSON.stringify(undone2));

/* 多选 + 批量删除：只弹一次确认（不是每个变量弹一次） */
await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('#varTable input[data-k="sel"]')];
  ['v1', 'v3'].forEach(n => {
    const tr = [...document.querySelectorAll('#varTable tr[data-name]')].find(t => t.dataset.name === n);
    const cb = tr.querySelector('input[data-k="sel"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
await page.waitForTimeout(200);
const marked = await page.evaluate(() => ({
  btn: document.getElementById('btnDelVars').textContent.trim(),
  hidden: document.getElementById('btnDelVars').hidden,
  rows: document.querySelectorAll('#varTable tr.sel').length,
}));
ok('勾两行 → 按钮变成「删除选中 (2)」并显示出来，行高亮',
  marked.btn === '删除选中 (2)' && marked.hidden === false && marked.rows === 2, JSON.stringify(marked));

const before2 = dialogs.length;
await page.click('#btnDelVars');
await page.waitForTimeout(300);
const batch = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return {
    names: m.project.variables().map(v => v.name),
    btnHidden: document.getElementById('btnDelVars').hidden,
    msg: document.getElementById('varMsg')?.textContent.trim() || '',
  };
});
ok('批量删除只用了一次确认（不是每行弹一次）', dialogs.length - before2 === 0, `弹了 ${dialogs.length - before2} 次（都没被引用）`);
ok('一次删掉两个，选择清空、按钮收起，并提示可撤销',
  JSON.stringify(batch.names) === JSON.stringify(['v2', 'v4']) && batch.btnHidden === true && /已删除 2 个/.test(batch.msg),
  JSON.stringify(batch));

/* 表头全选 → 一次删光 */
await page.evaluate(() => {
  const all = document.getElementById('varSelAll');
  all.checked = true;
  all.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(200);
const allSel = await page.evaluate(() => ({
  rows: document.querySelectorAll('#varTable tr.sel').length,
  btn: document.getElementById('btnDelVars').textContent.trim(),
}));
ok('表头全选 → 每行都勾上', allSel.rows === 2 && allSel.btn === '删除选中 (2)', JSON.stringify(allSel));
await page.click('#btnDelVars');   // v2 被引用着 → 这一次会弹确认（带引用数）
await page.waitForTimeout(350);
const empty = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { n: m.project.variables().length, bind: m.project.currentWidgets()[0]?.bindings.variable };
});
ok('全选删除 → 变量表清空、引用一起清掉',
  empty.n === 0 && empty.bind === '', JSON.stringify(empty));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
fs.unlinkSync('test/tmp-vars1.csv');
fs.unlinkSync('test/tmp-vars2.csv');
fs.unlinkSync('test/tmp-vars3.csv');
fs.unlinkSync('test/tmp-export.csv');
await browser.close();
process.exit(fails ? 1 : 0);

