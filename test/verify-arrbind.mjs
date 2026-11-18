// verify-arrbind.mjs — 属性面板里选/切「数组变量」的那些坑（自建工程，不依赖任何外部工程文件）
//
// 背景：OPC UA 导进来的数组（arrw，int[]，地址是 NodeId）绑到控件上以后，
//   1) 控件的「可绑类型」里没有数组类型 → 下拉把它过滤掉了，面板显示「（未绑定）」
//      （更别扭的是搜索框那条路不按类型过滤，一搜又冒出来 —— 前后不一致）
//   2) 那一行「数据类型」原来会把数组变量打成标量（int[] → real），地址还指着数组节点
// 这两条都在这里钉住。
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8886';
installNodeFetchPatch(PORT);
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* 后端隔离：本套件只管属性面板的候选/可编辑性 */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
  // 协议要**钉死成 Modbus**：OPC UA 模式下「数据类型」那一行是只读的（导入来的类型以 PLC 为准），
  // 而本套件测的正是可编辑那条路。getPlc 状态轮询会把它改回后端实际的协议，这里一起 stub 掉。
  m.backend.plcInfo.protocol = 'modbus';
  m.backend.getPlc = async () => ({ ok: true, config: {}, status: { mode: 'memory', protocol: 'modbus' } });
}));

/* 自建工程：一批标量 + 一个 OPC UA 风格的数组变量（int[]，地址是 NodeId） */
const NS = 'ns=4;s=|var|Device.Application.GVL.';
const w = await page.evaluate(async (NS) => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  const V = (name, type, address, value) => ({ name, type, address, value, len: 0 });
  m.data.variables.push(V('bRun', 'bool', NS + 'bRun', false));
  m.data.variables.push(V('a', 'int', NS + 'a', 0));
  m.data.variables.push(V('c', 'real', NS + 'c', 0));
  m.data.variables.push(V('sName', 'string', NS + 'sName', ''));
  m.data.variables.push(V('arrw', 'int[]', NS + 'arrw', 0));       // ← 没展开的数组变量
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const num = m.addWidget('number', 40, 40);      // number：支持数组（有「数组元素」）
  num.name = 'numA'; num.bindings.variable = 'arrw';
  const val = m.addWidget('value', 40, 140);      // value：不支持数组（没有数组元素属性）
  val.name = 'valA'; val.bindings.variable = 'arrw';
  const scalar = m.addWidget('number', 40, 240);
  scalar.name = 'numB'; scalar.bindings.variable = 'a';
  m.commit('数组绑定测试');
  return { num: num.id, val: val.id, scalar: scalar.id };
}, NS);
await sleep(300);

const panel = async (wid) => {
  await page.click(`#canvas .wd[data-id="${wid}"]`);
  await sleep(320);
  return page.evaluate(async (wid) => {
    const m = (await import('/js/core/project.js')).project;
    const sel = document.querySelector('#propBody [data-bind="variable"]');
    const ds = document.querySelector('#propBody [data-dtype="dispType"]');
    // 变量格现在是「输入框 + 候选表」（js/editor/varPick.js）。⚠ 现在点进去会**先按框里已有的
    // 名字过滤**（现场要求）—— 下面几条断言要的都是"arrw 在候选里"，正好按 'arrw' 过滤后也在。
    sel?.focus();
    await new Promise(r => setTimeout(r, 150));
    const rows = [...document.querySelectorAll('.vp-list .vp-row')].map(r => ({
      name: r.querySelector('.vp-name').textContent,
      note: r.querySelector('.vp-note')?.textContent || '',
    }));
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));   // 关掉候选表
    return {
      bound: m.getWidget(wid)?.bindings?.variable,
      selValue: sel?.value,
      rowNames: rows.map(r => r.name),
      mismatched: rows.filter(r => /不匹配/.test(r.note)).map(r => r.name),
      dtype: ds?.value, dtypeDisabled: !!ds?.disabled, dtypeTitle: ds?.title || '',
    };
  }, wid);
};

/* ── 0. 「数组元素」属性已经删掉 ──
   数组一律走 `[]` 变量名（arrw[1]…arrw[N]，和 PLC 的 NodeId 一致），
   不再有「绑整段 + 选第几个元素」那套第二机制（还带 0 起/1 起的换算坑）。 */
const defs = await page.evaluate(async () => {
  const r = await import('/js/widgets/registry.js');
  const g = t => (r.registry.get(t).props || []).map(p => p.key);
  return {
    num: g('number'), label: g('label'),
    numDef: 'arrIdx' in (r.registry.get('number').defaults || {}),
    labelDef: 'arrIdx' in (r.registry.get('label').defaults || {}),
  };
});
ok('数值控件的属性里没有「数组元素」了', !defs.num.includes('arrIdx'), JSON.stringify(defs.num));
ok('文本控件的属性里没有「数组元素」了', !defs.label.includes('arrIdx'), JSON.stringify(defs.label));
ok('两个控件的 defaults 里也不带 arrIdx 了', defs.numDef === false && defs.labelDef === false,
  JSON.stringify([defs.numDef, defs.labelDef]));

/* ── 1. number 控件绑数组变量（int[]）── */
const p1 = await panel(w.num);
ok('选中绑数组的数值控件：面板里**没有**「数组元素」这一行',
  await page.evaluate(() => !document.querySelector('#propBody [data-prop="arrIdx"]')));
ok('数值控件绑数组变量：候选里能看到 arrw', p1.rowNames?.includes('arrw') === true, JSON.stringify(p1.rowNames));
ok('数值控件绑数组变量：变量格里就是 arrw（不再是空白/未绑定）', p1.selValue === 'arrw', String(p1.selValue));
ok('数值控件绑数组变量：候选行里没给它标「类型不匹配」（number 本来就支持数组）',
  !p1.mismatched.includes('arrw'), JSON.stringify(p1.mismatched));

/* ── 2. 来回切换 ── */
const setSel = async (target) => {
  const sel = '#propBody [data-bind="variable"]';
  await page.click(sel);
  await page.fill(sel, target);
  await page.keyboard.press('Enter');       // 回车 = 选中第一个匹配（varPick 的确认键）
  await sleep(350);
  return page.evaluate(async (wid) => (await import('/js/core/project.js')).project.getWidget(wid)?.bindings?.variable, w.num);
};
ok('数值控件：能切到别的变量（arrw → a）', (await setSel('a')) === 'a');
ok('数值控件：能切回数组变量（a → arrw）', (await setSel('arrw')) === 'arrw');

/* ── 3. 边打字边检索：打 arrw 就只剩 arrw 一个候选 ── */
await page.click('#propBody [data-bind="variable"]');
await page.fill('#propBody [data-bind="variable"]', 'arrw');
await sleep(400);
const p3 = await panel(w.num);
ok('打 arrw：候选里就 arrw 一个，且变量格里还是它',
  p3.rowNames.length >= 1 && p3.rowNames.every(n => n.includes('arrw')) && p3.selValue === 'arrw',
  JSON.stringify([p3.rowNames, p3.selValue]));

/* ── 4. 「数据类型」行：数组变量不能被打成标量 ── */
const p4 = await panel(w.num);
ok('数组变量的「数据类型」显示元素类型 int', p4.dtype === 'int', String(p4.dtype));
ok('数组变量的「数据类型」说明写的是「元素类型…数组本身不变」', /元素类型/.test(p4.dtypeTitle), p4.dtypeTitle);
await page.selectOption('#propBody [data-dtype="dispType"]', 'float');
await sleep(450);
const afterDtype = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const v = m.variables().find(x => x.name === 'arrw');
  const ww = m.pages()[0].widgets.find(x => x.bindings?.variable === 'arrw' && x.props?.dispType);
  return { type: v?.type, dispType: ww?.props?.dispType, fmt: ww?.props?.fmt };
});
ok('数组变量切数据类型：变量还是数组（real[]，不是 real）', afterDtype.type === 'real[]', JSON.stringify(afterDtype));
ok('数组变量切数据类型：控件 dispType 跟着变 float', afterDtype.dispType === 'float', JSON.stringify(afterDtype));
// 复原，别影响后面的断言
await page.selectOption('#propBody [data-dtype="dispType"]', 'int');
await sleep(300);

/* ── 5. 类型不对口的绑定：候选里照样有它 + 标注，不再显示「未绑定」──
   现在是**全量候选**（变量表里有什么就列什么），所以不存在"被类型过滤掉、要补回来"这回事；
   类型对不上的改成在候选行上注明 + 输入框标红，比"悄悄消失"清楚。 */
const p5 = await panel(w.val);
ok('value 控件硬绑 arrw（类型不支持数组）：候选里照样有它（全量候选）',
  p5.rowNames?.includes('arrw') === true, JSON.stringify(p5.rowNames));
ok('value 控件硬绑 arrw：变量格里仍是 arrw（不显示「未绑定」）', p5.selValue === 'arrw', String(p5.selValue));
ok('value 控件硬绑 arrw：候选行上标了「类型不匹配」',
  p5.mismatched.includes('arrw'), JSON.stringify(p5.mismatched));
ok('value 控件硬绑 arrw：变量格当场标红（运行起来是静默失效，得看得出来）',
  await page.evaluate(() => document.querySelector('#propBody [data-bind="variable"]')?.classList.contains('bad') === true));

/* ── 6. 标量变量的正常路径不受影响 ── */
const p6 = await panel(w.scalar);
ok('普通标量变量（a:int）仍是正常候选且选中',
  p6.selValue === 'a' && !p6.mismatched.includes('a'),
  JSON.stringify([p6.selValue, p6.mismatched]));

/* ── 7. 存的住：存档往返后绑定还在 ── */
const round = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const json = JSON.parse(JSON.stringify(m.data));
  m.replaceData(json);
  return m.pages()[0].widgets.find(x => x.name === 'numA')?.bindings?.variable;
});
ok('存档往返后数组绑定还在（不会刷新就掉）', round === 'arrw', String(round));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 属性面板绑数组变量：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
