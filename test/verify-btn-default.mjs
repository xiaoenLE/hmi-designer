// verify-btn-default.mjs — 按钮默认状态显示 + 默认绑第一个变量 + 比较行按变量类型显隐
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });

/* 后端隔离 */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
}));

/* ── A. 默认值：空变量表 / 有变量表 ── */
const a = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  const wEmpty = m.project.addWidget('button', 40, 40);      // 空变量表
  m.project.addVariable(); m.project.updateVariable('var1', { name: 'bRun', type: 'bool', value: false });
  m.project.addVariable(); m.project.updateVariable('var2', { name: 'rSpd', type: 'real', value: 0 });
  m.project.addVariable(); m.project.updateVariable('var3', { name: 'sName', type: 'string', value: '' });
  const wBind = m.project.addWidget('button', 170, 40);      // 有变量表
  return {
    emptyBind: wEmpty.bindings.variable ?? '',
    bind: wBind.bindings.variable,
    showState: wBind.props.showState,
    onText: wBind.props.onText,
    offText: wBind.props.offText,
    firstVar: m.project.variables()[0].name,
    id: wBind.id, emptyId: wEmpty.id,
  };
});
ok('变量表为空 → 新按钮不绑定（不崩）', a.emptyBind === '', a.emptyBind);
ok('有变量表 → 新按钮默认绑第一个变量', a.bind === a.firstVar && a.firstVar === 'bRun', a.bind);
ok('新建按钮：状态显示常开（props 里不再有 showState 勾/键）',
  a.showState === undefined && a.onText === '开' && a.offText === '关',
  `${a.showState} / ${a.onText} / ${a.offText}`);

/* ── B. 面板：比较行按绑定变量类型显隐 ── */
await page.click(`#canvas .wd[data-id="${a.id}"]`);
await page.waitForTimeout(150);
const panelOf = (wid) => page.evaluate(async (wid) => {
  document.querySelector(`#canvas .wd[data-id="${wid}"]`)?.click();
  await new Promise(r => setTimeout(r, 120));
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.filter(r => r.querySelector('.f-label')?.textContent.trim() === t);
  return {
    stateRow: byLabel('状态显示').length,
    hasOn: byLabel('满足文字').length,
    hasOff: byLabel('未满文字').length,
    hasOldText: byLabel('文本').length,
    hasOldBg: byLabel('背景色').length,
    bind: document.querySelector('#propBody [data-bind="variable"]')?.value,
    hasOp: byLabel('比较').length > 0,
    hasThr: byLabel('比较值').length > 0,
    opOptions: [...(byLabel('比较')[0]?.querySelectorAll('select option') || [])].map(o => o.value),
  };
}, wid);

let pb = await panelOf(a.id);
ok('面板：没有「状态显示」勾这一行（常开，没得选）', pb.stateRow === 0, `行数=${pb.stateRow}`);
ok('面板：老「文本/背景色」两行已并进 满足/未满（原行不再出现）',
  pb.hasOn === 1 && pb.hasOff === 1 && pb.hasOldText === 0 && pb.hasOldBg === 0,
  `满足=${pb.hasOn} 未满=${pb.hasOff} 文本=${pb.hasOldText} 背景=${pb.hasOldBg}`);
ok('面板：绑 bool → 无比较行', pb.bind === 'bRun' && !pb.hasOp && !pb.hasThr, `hasOp=${pb.hasOp}`);

// 切换绑定到数值变量 → 比较行出现（联动刷新）
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetField(wid, 'bindings.variable', 'rSpd');
}, a.id);
let pn = await panelOf(a.id);
ok('面板：绑数值 → 比较行出现', pn.hasOp && pn.hasThr, `hasOp=${pn.hasOp}`);
ok('面板：数值 → 比较符含 6 种', pn.opOptions.length === 6, pn.opOptions.join(','));

// 切换到字符串变量 → op 只剩 ==/!=
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetField(wid, 'bindings.variable', 'sName');
}, a.id);
let ps = await panelOf(a.id);
ok('面板：绑字符串 → 比较符仅 ==/!=', ps.hasOp && ps.opOptions.length === 2 && ps.opOptions.includes('==') && ps.opOptions.includes('!='), ps.opOptions.join(','));

// 取消绑定 → 比较行消失
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetField(wid, 'bindings.variable', '');
}, a.id);
const pNone = await panelOf(a.id);
ok('面板：未绑定 → 无比较行', !pNone.hasOp && !pNone.hasThr, `hasOp=${pNone.hasOp}`);

// 切回 bool → 无比较行（验证来回切换稳定性）
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetField(wid, 'bindings.variable', 'bRun');
}, a.id);
pb = await panelOf(a.id);
ok('面板：切回 bool → 比较行再次隐藏', pb.bind === 'bRun' && !pb.hasOp);

/* ── C. 渲染兜底：老工程缺键 ── */
const legacyRender = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const r = await import('/js/widgets/registry.js');
  const vars = { get: (n) => n === 'bRun' ? true : undefined };
  // 老控件：缺 showState/op/threshold 键，绑 bool 值 true
  const w1 = m.project.addWidget('button', 300, 40);
  delete w1.props.showState; delete w1.props.op; delete w1.props.threshold;
  m.project.updateWidgetField(w1.id, 'bindings.variable', 'bRun');
  const h1 = r.registry.get('button').render(w1, 'run', vars);
  // 老控件：旧字段迁到未满态；showState:false 不再关闭条件显示
  const w2 = m.project.addWidget('button', 430, 40);
  w2.props.showState = false;
  w2.props.text = '原文本';
  w2.props.offText = '不一致的新文本';
  w2.props.bgColor = '#123456';
  m.project.updateWidgetField(w2.id, 'bindings.variable', 'bRun');
  const data = structuredClone(m.project.data);
  m.project.replaceData(data);  // 执行与打开旧工程相同的规范化迁移
  const old = m.project.getWidget(w2.id);
  const h2 = r.registry.get('button').render(old, 'run', vars);
  const h2off = r.registry.get('button').render(old, 'run', { get: () => false });
  // 缺 op/threshold + 数值变量 12 → 默认 >= 1 → 开
  const varsN = { get: () => 12 };
  const w3 = m.project.addWidget('button', 560, 40);
  delete w3.props.op; delete w3.props.threshold;
  m.project.updateWidgetField(w3.id, 'bindings.variable', 'rSpd');
  const h3 = r.registry.get('button').render(w3, 'run', varsN);
  m.project.deleteWidgets([w1.id, w2.id, w3.id]);
  return {
    legacyOn: h1.match(/>([^<]*)<\/button>/)?.[1],
    satisfied: h2.match(/>([^<]*)<\/button>/)?.[1],
    offText: h2off.match(/>([^<]*)<\/button>/)?.[1],
    props: { offText: old.props.offText, text: old.props.text, showState: old.props.showState, offColor: old.props.offColor },
    numDefault: h3.match(/>([^<]*)<\/button>/)?.[1],
  };
});
ok('缺 showState 键 → 状态显示仍生效（bool=true → 开）', legacyRender.legacyOn === '开', legacyRender.legacyOn);
ok('旧工程 text 覆盖不一致 offText 并映射为未满文字',
  legacyRender.offText === '原文本' && legacyRender.props.offText === '原文本' && legacyRender.props.text === '原文本',
  JSON.stringify(legacyRender.props));
ok('旧工程 showState:false 删除，满足状态仍按条件显示',
  legacyRender.satisfied === '开' && legacyRender.props.showState === undefined,
  `${legacyRender.satisfied} / showState=${legacyRender.props.showState}`);
ok('旧 bgColor 迁到未满底色', legacyRender.props.offColor === '#123456', legacyRender.props.offColor);
ok('缺 op/threshold 键 → 默认 >=1（数值 12 → 开）', legacyRender.numDefault === '开', legacyRender.numDefault);

/* ── D. 动作变量默认同源 ── */
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetField(wid, 'bindings.variable', 'bRun');
}, a.id);
await page.click(`#canvas .wd[data-id="${a.id}"]`);
await page.waitForTimeout(200);
const diagAdd = await page.evaluate(() => ({
  actAdd: !!document.getElementById('actAdd'),
  sel: document.querySelector('#canvas .wd.selected')?.dataset.id ?? null,
}));
await page.click('#actAdd').catch(() => {});
await page.waitForTimeout(200);
const actVar = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const w = m.project.getWidget(wid);
  const last = (w.actions || []).slice(-1)[0];
  return { type: last?.type, variable: last?.params?.variable, n: (w.actions || []).length };
}, a.id);
ok('actAdd 按钮存在且控件已选中', diagAdd.actAdd === true && diagAdd.sel === a.id, JSON.stringify(diagAdd));
ok('添加动作 → 变量默认 = 绑定变量（同源）',
  actVar.type === 'tap' && actVar.variable === 'bRun',
  JSON.stringify(actVar));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
await browser.close();
process.exit(fails ? 1 : 0);
