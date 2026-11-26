// verify-keypad-mode.mjs — 软键盘「起手方式」（工程级一处设置：工程 ▾ → 软键盘设置…）
//   默认是**按键清空重输**（打开时照样显示现在是多少，但第一个"字符键"一按就先把原值让掉 ——
//   点开就能直接输新的）；另一种是**接着原值改**（老行为：按的键接在原值后面，想重输先按 C）。
//   这一套验：默认值/老工程兼容、设置入口（菜单 + 对话框 + 存进工程 + 一步撤销）、
//   两种模式在**数字键盘和全键盘**上的实际行为、以及切回「接着原值改」以后老行为一个字不变。
// 用法：node tools/run-suites.mjs verify-keypad-mode   （或先起服务再 node test/verify-keypad-mode.mjs [端口]）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* 后端隔离（本套件只管键盘交互） */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
}));

/* ── 1. 默认值 + 老工程兼容 ──
   默认现在就是「按键清空重输」；老工程 JSON 里根本没有 keypad 这个键 —— 读进来也落到
   按键清空重输（现场要的就是"点开直接输新的"）；老行为得在对话框里显式选一次。 */
const compat = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const before = { ...project.keypad() };
  const old = JSON.parse(JSON.stringify(project.data));
  delete old.keypad;                                   // 模拟"老工程存档"
  project.replaceData(old);
  const afterOld = { mode: project.keypad().mode, label: project.keypad().label, keyInData: project.data.keypad?.mode };
  const junk = JSON.parse(JSON.stringify(project.data));
  junk.keypad = { mode: '随便写的', label: '也乱写' };    // 认不出的写法
  project.replaceData(junk);
  return { before, afterOld, junk: { ...project.keypad() } };
});
ok('没配过的工程 → 起手方式默认「按键清空重输」(replace)、标题显示变量名',
  compat.before.mode === 'replace' && compat.before.label === 'var', JSON.stringify(compat.before));
ok('老工程（存档里没有 keypad 键）读进来 → replace + 变量名（也按新默认走）',
  compat.afterOld.mode === 'replace' && compat.afterOld.label === 'var' && compat.afterOld.keyInData === 'replace',
  JSON.stringify(compat.afterOld));
ok('认不出的写法也收敛成 replace + 变量名（不认的写法不当"控件名"用）',
  compat.junk.mode === 'replace' && compat.junk.label === 'var', JSON.stringify(compat.junk));

/* ── 2. 造两个输入控件（数值 real + 文本 string）—— 控件名故意和变量名不一样 ── */
const ids = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.setKeypad({ mode: 'edit', label: 'var' });           // 起点特意设成「接着原值改」（与默认不同）—— 好验撤销/重做
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'rNum', type: 'real', address: '%MW100', value: 12.5 });
  m.data.variables.push({ name: 'sName', type: 'string', len: 20, address: '%MW200', value: 'abc' });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const mk = (x, y, v, name) => {
    const w = m.addWidget('number', x, y);
    w.bindings.variable = v; w.props.useKeyboard = true; w.name = name;
    return w.id;
  };
  const out = { num: mk(20, 20, 'rNum', '线速度设定'), str: mk(20, 90, 'sName', '配方名') };
  m.commit('起手方式测试');
  return out;
});
await sleep(300);

/* ── 3. 设置入口：工程 ▾ → 软键盘设置…（走真实菜单 + 对话框）── */
const menuLabels = async () => {
  const trigger = page.locator('#btnProjMenu');
  if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
  await sleep(200);
  return page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
    .map(b => b.querySelector('.ctx-label').textContent));
};
const clickMenuStartsWith = async (prefix) => {
  await page.evaluate(p => {
    const b = [...document.querySelectorAll('#ctxMenu .ctx-item')]
      .find(x => x.querySelector('.ctx-label').textContent.startsWith(p));
    if (b) b.click();
  }, prefix);
  await sleep(250);
};
let labels = await menuLabels();
ok('工程菜单里有「软键盘设置…」入口', labels.some(l => l.startsWith('软键盘设置…')), JSON.stringify(labels.filter(l => /软键盘/.test(l))));
ok('菜单里就是「软键盘设置…」这一条，后面不挂任何说明文字', labels.find(l => l.startsWith('软键盘设置…')) === '软键盘设置…',
  labels.find(l => l.startsWith('软键盘设置…')));

await clickMenuStartsWith('软键盘设置…');
const dlg1 = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  mode: document.getElementById('kpMode')?.value,
  options: [...document.querySelectorAll('#kpMode option')].map(o => o.value),
  label: document.getElementById('kpLabel')?.value,
  labelOptions: [...document.querySelectorAll('#kpLabel option')].map(o => o.value),
  hint: document.getElementById('dlgBody').textContent.replace(/\s+/g, ' ').trim(),
}));
ok('设置对话框打开了，标题「软键盘设置」', dlg1.open && dlg1.title === '软键盘设置', dlg1.title);
ok('对话框里是「起手方式」两选一，当前停在 edit（老行为）', dlg1.mode === 'edit' && dlg1.options.join(',') === 'replace,edit',
  JSON.stringify([dlg1.mode, dlg1.options]));
ok('还有「标题显示」三选一（变量名 / 控件名 / 都不显示），当前停在变量名',
  dlg1.label === 'var' && dlg1.labelOptions.join(',') === 'var,widget,none', JSON.stringify([dlg1.label, dlg1.labelOptions]));
const help = await page.evaluate(() => ({
  mode: document.getElementById('kpMode').title,
  title: document.getElementById('kpLabel').title,
}));
ok('两种起手方式在对应下拉框悬停说明',
  /接着原值改/.test(help.mode) && /按键清空重输/.test(help.mode) && /第一个字符键/.test(help.mode), help.mode);
ok('标题选项悬停可查看关闭按钮的规则',
  /都不显示/.test(help.title) && /✕/.test(help.title), help.title);

await page.selectOption('#kpMode', 'replace');
await page.selectOption('#kpLabel', 'widget');
await page.click('#dlgOk');
await sleep(250);
const afterSave = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  return {
    mode: m.keypad().mode,
    label: m.keypad().label,
    dlgClosed: document.getElementById('dlgMask').classList.contains('hidden'),
    saved: JSON.parse(JSON.stringify(m.data)).keypad,          // 存文件/存服务器都走这条
  };
});
ok('在对话框里选「按键清空重输」→ 存进工程', afterSave.mode === 'replace', afterSave.mode);
ok('选「标题显示 = 控件名」→ 也存进工程', afterSave.label === 'widget', afterSave.label);
ok('对话框保存后自己关掉', afterSave.dlgClosed === true);
ok('两项设置跟着工程存档走（JSON 里有 keypad.mode / keypad.label）',
  afterSave.saved.mode === 'replace' && afterSave.saved.label === 'widget', JSON.stringify(afterSave.saved));

labels = await menuLabels();
ok('切到「按键清空重输」后菜单项文字不变（状态不挂在菜单上，进对话框才看得到）',
  labels.find(l => l.startsWith('软键盘设置…')) === '软键盘设置…',
  labels.find(l => l.startsWith('软键盘设置…')));
await page.keyboard.press('Escape');
await sleep(150);

const undone = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  window.app.history.undo();
  return { ...m.keypad() };
});
ok('改软键盘设置是**一步撤销**（Ctrl+Z 把两项一起退回来）',
  undone.mode === 'edit' && undone.label === 'var', JSON.stringify(undone));
// 撤销之后再重做：能回到 replace 才说明这一步**真的进了撤销栈**
//（起点是 edit、默认是 replace：撤销回 edit 本身是真变化，再重做回 replace 才证明在栈里）
const redone = await page.evaluate(async () => {
  window.app.history.redo();
  return { ...(await import('/js/core/project.js')).project.keypad() };
});
ok('撤销后重做 → 又回到「按键清空重输 + 控件名」（这一步确实在栈里）',
  redone.mode === 'replace' && redone.label === 'widget', JSON.stringify(redone));

/* ── 运行态 ── */
const enterRun = async () => { await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun()); await sleep(600); };
const pad = () => page.evaluate(() => ({
  open: !document.getElementById('numPad').classList.contains('hidden'),
  display: document.getElementById('npDisplay').textContent,
  fresh: document.getElementById('npDisplay').classList.contains('fresh'),
  label: document.getElementById('npVar').textContent,
  numVisible: !document.getElementById('npKeys').classList.contains('hidden'),
  textVisible: !document.getElementById('npText').classList.contains('hidden'),
}));
const openPad = async (id) => { await page.click(`#rtPage .wd[data-id="${id}"]`); await sleep(320); return pad(); };
const tapNum = async (k) => { await page.click(`#npKeys button[data-k="${k}"]`); await sleep(90); };
const tapStr = async (s) => { for (const c of s) { await page.click(`#npText button[data-k="${c}"]`); await sleep(70); } };
const tap = async (k, kind) => {
  await page.click(kind ? `#npText button[data-kind="${kind}"][data-k="${k}"]` : `#npText button[data-k="${k}"]`);
  await sleep(110);
};
const store = (n) => page.evaluate((n) => window.app.varStore.get(n), n);
const setVar = async (n, v) => { await page.evaluate(([n, v]) => window.app.varStore.set(n, v, 'local'), [n, v]); await sleep(160); };

await enterRun();

/* ── 4. 首键清空重输：数字键盘 ── */
let p = await openPad(ids.num);
ok('replace：打开键盘**照样显示原值**（12.5）', p.numVisible && p.display === '12.5', p.display);
ok('replace：标题栏显示的是**控件名**（线速度设定），不是变量名 rNum',
  p.label.startsWith('线速度设定') && !p.label.includes('rNum'), p.label);
ok('标题栏不再挂「按键清空重输」这类文字（现场嫌长）',
  !/按键清空重输/.test(p.label), p.label);
ok('标题栏照旧带着类型（real）', /\(real\)/.test(p.label), p.label);
ok('replace：显示区标出"这条还是原值"（.fresh）', p.fresh === true);
await tapNum('7');
p = await pad();
ok('replace：第一个字符键把原值让掉（12.5 → 7，不是 12.57）', p.display === '7', p.display);
ok('replace：开始输新值后收回"原值"标记', p.fresh === false);
await tapNum('ok');
ok('replace：确定 → 变量写成新值 7', Number(await store('rNum')) === 7, String(await store('rNum')));

// ⌫ 算「我要改原值」，不算起手
await setVar('rNum', 12.5);
p = await openPad(ids.num);
await tapNum('back');
ok('replace：按 ⌫ 是改原值（12.5 → 12.），不是清空重输', (await pad()).display === '12.', (await pad()).display);
ok('replace：按过 ⌫ 之后"原值"标记收掉（后面的键接在后面）', (await pad()).fresh === false);
await tapNum('3');
ok('replace：⌫ 之后按 3 → 12.3（没被清成 3）', (await pad()).display === '12.3', (await pad()).display);
await tapNum('ok');
ok('replace：⌫ 改完的值写进了变量', Number(await store('rNum')) === 12.3, String(await store('rNum')));

// C 清空
await setVar('rNum', 12.5);
await openPad(ids.num);
await tapNum('clear');
await tapNum('3');
ok('replace：按 C 清空后输 3 → 3', (await pad()).display === '3', (await pad()).display);
await tapNum('ok');

// ± 作为第一个键 = 输一个负数
await setVar('rNum', 12.5);
await openPad(ids.num);
await tapNum('+/-');
ok('replace：第一个键按 ± → 从 - 打起（不是把 12.5 变成 -12.5）', (await pad()).display === '-', (await pad()).display);
await tapNum('2');
await tapNum('ok');
ok('replace：± 2 确定 → -2', Number(await store('rNum')) === -2, String(await store('rNum')));

// ± 不是第一个键 = 老行为（翻正负号）
await setVar('rNum', 12.5);
await openPad(ids.num);
await tapNum('5');
await tapNum('+/-');
ok('replace：输过东西之后按 ± 还是翻符号（5 → -5）', (await pad()).display === '-5', (await pad()).display);
await tapNum('ok');

// 小数点
await setVar('rNum', 12.5);
await openPad(ids.num);
await tapNum('.');
ok('replace：第一个键按小数点 → 只有一个 .（原值已让位）', (await pad()).display === '.', (await pad()).display);
await tapNum('5');
await tapNum('ok');
ok('replace：.5 确定 → 0.5', Number(await store('rNum')) === 0.5, String(await store('rNum')));

// 什么都不按 = 不动原值
await setVar('rNum', 12.5);
await openPad(ids.num);
await tapNum('ok');
ok('replace：一个键都不按就确定 → 原值原样不动（不白写一次）', Number(await store('rNum')) === 12.5, String(await store('rNum')));
await setVar('rNum', 12.5);
await openPad(ids.num);
await tapNum('9');
await tapNum('cancel');
ok('replace：取消 → 变量保持原值', Number(await store('rNum')) === 12.5, String(await store('rNum')));

/* ── 5. 首键清空重输：全键盘（文本变量）── */
await setVar('sName', 'abc');
p = await openPad(ids.str);
ok('replace：文本变量打开的是全键盘，显示区照样是原值 abc',
  p.textVisible && p.display.startsWith('abc') && p.fresh === true, p.display);
ok('replace：全键盘的标题栏也是控件名（配方名）', p.label.startsWith('配方名'), p.label);
await tapStr('x');
ok('replace：打第一个字母 → abc 让位，显示 x（不是 abcx）', (await pad()).display.startsWith('x'), (await pad()).display);
await tap('确定', 'ok');
ok('replace：全键盘确定 → 变量写成 x', (await store('sName')) === 'x', String(await store('sName')));

await setVar('sName', 'abc');
await openPad(ids.str);
await tap('⌫', 'back');
await tapStr('z');
ok('replace：⌫ 改原值（abc → ab）后接 z → abz', (await pad()).display.startsWith('abz'), (await pad()).display);
await tap('确定', 'ok');
ok('replace：⌫ 改出来的 abz 写进变量', (await store('sName')) === 'abz', String(await store('sName')));

await setVar('sName', 'abc');
await openPad(ids.str);
await tap('⇧', 'shift');
ok('replace：⇧ 不算起手（原值还在，标记也还在）',
  (await pad()).display.startsWith('abc') && (await pad()).fresh === true, (await pad()).display);
await tap('a');
ok('replace：⇧ 之后打 a（键位 a）→ 大写 A 起手（不是 abcA）', (await pad()).display.startsWith('A'), (await pad()).display);
await tap('取消', 'cancel');

await setVar('sName', 'abc');
await openPad(ids.str);
await tap('清空', 'clear');
await tapStr('q');
ok('replace：文本键盘按「清空」再打 q → q', (await pad()).display.startsWith('q'), (await pad()).display);
await tap('取消', 'cancel');

// 中文拼音：头一个拼音字母就该让原值
await setVar('sName', 'abc');
await openPad(ids.str);
await tap('中/英', 'lang');
await tapStr('ni');
p = await pad();
ok('replace：中文模式打拼音 → 显示区只剩拼音，原值 abc 已让位',
  !p.display.includes('abc') && /ni/.test(p.display), p.display);
await page.click('#npCand button:has-text("你")');
await sleep(160);
ok('replace：选字上屏 → 显示区只有「你」', (await pad()).display.includes('你') && !(await pad()).display.includes('abc'),
  (await pad()).display);
await tap('确定', 'ok');
ok('replace：中文确定 → 变量是「你」', (await store('sName')) === '你', String(await store('sName')));

// 控件没名字（没改过名的自动名被清空）→ 回落变量名，不能显示成空白
await page.evaluate(async (id) => {
  const m = (await import('/js/core/project.js')).project;
  m.findWidget(id).name = '';
}, ids.num);
await sleep(150);
p = await openPad(ids.num);
ok('控件名为空时回落显示变量名（标题不会是空白）', p.label.startsWith('rNum'), p.label);
await tapNum('cancel');

/* ── 6. 切回「接着原值改 + 变量名」：老行为一个字不变 ── */
await page.keyboard.press('Escape');       // 退出运行态（没有别的层要关）
await sleep(500);
await page.click('#btnProjMenu');
await sleep(200);
const backLabel = (await menuLabels()).find(l => l.startsWith('软键盘设置…'));
ok('退出运行态后菜单项还是那一条（设置跟着工程走，但不再往菜单上挂字）',
  backLabel === '软键盘设置…', backLabel);
await page.keyboard.press('Escape');
await sleep(120);
await page.click('#btnProjMenu');
await sleep(180);
await clickMenuStartsWith('软键盘设置…');
const dlg2 = await page.evaluate(() => ({
  mode: document.getElementById('kpMode')?.value, label: document.getElementById('kpLabel')?.value,
}));
ok('再打开对话框时停在当前选的那两项（replace + 控件名）',
  dlg2.mode === 'replace' && dlg2.label === 'widget', JSON.stringify(dlg2));
await page.selectOption('#kpMode', 'edit');
await page.selectOption('#kpLabel', 'var');
await page.click('#dlgOk');
await sleep(250);
const backKp = await page.evaluate(async () => ({ ...(await import('/js/core/project.js')).project.keypad() }));
ok('切回「接着原值改 + 变量名」', backKp.mode === 'edit' && backKp.label === 'var', JSON.stringify(backKp));

await enterRun();
await setVar('rNum', 12.5);
p = await openPad(ids.num);
ok('edit：打开键盘显示原值 12.5 且没有"原值"标记', p.display === '12.5' && p.fresh === false, p.display);
ok('edit：标题栏回到变量名（rNum，不是控件名）', p.label.startsWith('rNum'), p.label);
await tapNum('7');
ok('edit（老行为）：按 7 接在原值后面 → 12.57', (await pad()).display === '12.57', (await pad()).display);
await tapNum('ok');
ok('edit（老行为）：确定后变量是 12.57', Number(await store('rNum')) === 12.57, String(await store('rNum')));

await setVar('sName', 'abc');
await openPad(ids.str);
await tapStr('x');
ok('edit（老行为）：文本也是接在后面（abc → abcx）', (await pad()).display.startsWith('abcx'), (await pad()).display);
await tap('确定', 'ok');
ok('edit（老行为）：文本确定后是 abcx', (await store('sName')) === 'abcx', String(await store('sName')));

/* ── 7. 标题显示选「都不显示」：顶上那条只剩 ✕，别的功能照旧 ── */
await page.keyboard.press('Escape');
await sleep(400);
await page.click('#btnProjMenu');
await sleep(200);
await clickMenuStartsWith('软键盘设置…');
await page.selectOption('#kpLabel', 'none');
await page.click('#dlgOk');
await sleep(250);
const noneSaved = await page.evaluate(async () => ({ ...(await import('/js/core/project.js')).project.keypad() }));
ok('选「都不显示」→ 存进工程（keypad.label = none）', noneSaved.label === 'none', JSON.stringify(noneSaved));

await enterRun();
await setVar('rNum', 12.5);
p = await openPad(ids.num);
ok('★ 标题显示「都不显示」：顶上那一行**是空的**（没有变量名也没有「变量」这种占位）',
  p.label === '', JSON.stringify(p.label));
const headBox = await page.evaluate(() => {
  const v = document.getElementById('npVar');
  const padEl = document.getElementById('numPad');
  const x = document.getElementById('npCancel').getBoundingClientRect();
  const pad = padEl.getBoundingClientRect();
  const keys = document.getElementById('npKeys').getBoundingClientRect();   // 按键区（右边界的对齐基准）
  return {
    varHidden: getComputedStyle(v).display === 'none',
    xVisible: x.width > 1 && x.height > 1 && x.top >= pad.top - 1,
    xText: document.getElementById('npCancel').textContent.trim(),
    plain: padEl.classList.contains('np-plain'),
    xFromRight: Math.round(pad.right - x.right),      // ✕ 右边缘离键盘右边缘多远
    keysFromRight: Math.round(pad.right - keys.right), // 按键区右边缘离键盘右边缘多远
    xHalf: x.left + x.width / 2 > pad.left + pad.width / 2,   // 在右半边吗
  };
});
ok('★ 空标题不占位（那一行只剩 ✕，还是点得着的）',
  headBox.varHidden && headBox.xVisible && headBox.xText === '✕', JSON.stringify(headBox));
ok('★ 没了标题，✕ 仍在**最右边**（跟有标题时一个位置，不跳到左边去）',
  headBox.plain === true && headBox.xHalf === true
  && Math.abs(headBox.xFromRight - headBox.keysFromRight) <= 3,
  JSON.stringify([headBox.xFromRight, headBox.keysFromRight, headBox.xHalf]));
await tapNum('7');
ok('「都不显示」只影响标题：起手方式/输入照旧（edit 下 12.5 → 7 = 12.57）',
  (await pad()).display === '12.57', (await pad()).display);
await tapNum('ok');
ok('「都不显示」下确定照旧写进变量', Number(await store('rNum')) === 12.57, String(await store('rNum')));
// 点 ✕ 照样能关掉键盘（标题没了，关键盘的路不能少）
await openPad(ids.num);
await page.click('#npCancel');
await sleep(250);
ok('标题没了也关得掉键盘（右上角 ✕）', (await pad()).open === false);

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 软键盘起手方式（接着原值改 / 首键清空重输）：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
