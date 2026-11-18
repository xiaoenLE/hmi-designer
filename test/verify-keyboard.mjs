// verify-keyboard.mjs — 触摸屏软键盘：string / wstring 要能打英文、数字、符号、中文
//   现场是触摸屏，没有实体键盘也没有系统输入法：
//     · 数值变量 → 数字键盘（老行为，不能变）
//     · string/wstring → 全键盘（大小写英文 + 数字 + 符号 + 中文拼音候选）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8887';
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
await sleep(500);

/* 后端隔离（本套件只管键盘交互） */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
}));

const ids = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  // 本套件只管键盘布局/按键能不能打，跟「起手方式」无关 —— 固定成「接着原值改」，
  // 免得默认值（replace）一变，这里"打字往后接"的断言就跟着变（起手方式由 verify-keypad-mode 管）
  m.setKeypad({ mode: 'edit', label: 'var' });
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'sName', type: 'string', len: 20, address: '%MW200', value: '' });
  m.data.variables.push({ name: 'wName', type: 'wstring', len: 12, address: '%MW220', value: '' });
  m.data.variables.push({ name: 'sShort', type: 'string', len: 5, address: '%MW240', value: '' });
  m.data.variables.push({ name: 'rNum', type: 'real', address: '%MW100', value: 1.5 });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const mk = (x, y, v) => { const w = m.addWidget('number', x, y); w.bindings.variable = v; w.props.useKeyboard = true; return w.id; };
  const out = { str: mk(20, 20, 'sName'), wstr: mk(20, 90, 'wName'), short: mk(20, 160, 'sShort'), num: mk(20, 230, 'rNum') };
  m.commit('软键盘测试');
  return out;
});
await page.waitForTimeout(300);
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(600);

const pad = () => page.evaluate(() => {
  const p = document.getElementById('numPad');
  const txt = document.getElementById('npText');
  const keys = document.getElementById('npKeys');
  const cand = document.getElementById('npCand');
  return {
    open: !p.classList.contains('hidden'),
    wide: p.classList.contains('wide'),
    textVisible: !txt.classList.contains('hidden'),
    numVisible: !keys.classList.contains('hidden'),
    candVisible: !cand.classList.contains('hidden'),
    display: document.getElementById('npDisplay').textContent,
    varLabel: document.getElementById('npVar').textContent,
    textKeys: [...txt.querySelectorAll('button')].map(b => b.dataset.k),
    candChars: [...cand.querySelectorAll('button')].filter(b => !b.classList.contains('hint')).map(b => b.textContent),
    candHints: [...cand.querySelectorAll('button.hint')].map(b => b.textContent),
  };
});
const openPad = async (id) => {
  await page.click(`#rtPage .wd[data-id="${id}"]`);
  await sleep(350);
  return pad();
};
const tap = async (selOrKey, kind) => {
  const sel = kind ? `#npText button[data-kind="${kind}"][data-k="${selOrKey}"]`
                   : `#npText button[data-k="${selOrKey}"]`;
  await page.click(sel);
  await sleep(90);
};
const tapStr = async (s) => { for (const ch of s) await tap(ch); };
const store = (n) => page.evaluate((n) => window.app.varStore.get(n), n);
const typeIn = async (s) => { for (const c of s) await page.click(`#npText button[data-k="${c}"]`); await sleep(120); };

/* ── 1. string 变量 → 全键盘 ── */
const p1 = await openPad(ids.str);
ok('string 变量弹出的是**全键盘**（不是数字键盘）',
  p1.open && p1.textVisible && !p1.numVisible, JSON.stringify([p1.open, p1.textVisible, p1.numVisible]));
ok('全键盘面板加宽了（10 列放得下）', p1.wide === true);
ok('标题栏写清变量名 + 类型 + 字符数上限',
  /sName/.test(p1.varLabel) && /string/.test(p1.varLabel) && /20/.test(p1.varLabel), p1.varLabel);
ok('键盘里有 26 个字母', 'abcdefghijklmnopqrstuvwxyz'.split('').every(c => p1.textKeys.includes(c)));
ok('键盘里有数字 0-9', '0123456789'.split('').every(c => p1.textKeys.includes(c)));
ok('键盘里有 空格/退格/清空/取消/确定/大小写/中英/符号页',
  ['空格', '⌫', '清空', '取消', '确定', '⇧', '中/英', '#+='].every(k => p1.textKeys.includes(k)),
  JSON.stringify(p1.textKeys.filter(k => !/^[a-z0-9]$/.test(k))));

/* ── 2. 英文 / 数字 / 大小写 / 退格 / 符号 ── */
await tapStr('abc123');
ok('点字母+数字 → 显示区跟着走', (await pad()).display.startsWith('abc123'), (await pad()).display);
await tap('⇧', 'shift');
await tap('a');
ok('⇧ 之后打的是大写 A', (await pad()).display.startsWith('abc123A'), (await pad()).display);
await tap('⇧', 'shift');                       // 关掉大写
await tap('z');
ok('再点一次 ⇧ 回到小写', (await pad()).display.startsWith('abc123Az'), (await pad()).display);
await tap('⌫', 'back');
ok('⌫ 删掉最后一个字符', (await pad()).display.startsWith('abc123A'), (await pad()).display);
await tap('#+=', 'page');
const pSym = await pad();
ok('切到符号页 → 有 ! @ # $ % ^ & * ( )', ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'].every(c => pSym.textKeys.includes(c)));
await tap('@');
ok('符号页点的 @ 进了显示区', (await pad()).display.startsWith('abc123A@'), (await pad()).display);
await tap('abc', 'page');
ok('切回字母页', (await pad()).textKeys.includes('q'));
await tap('清空', 'clear');
ok('清空 → 显示区回到空态', /（空）/.test((await pad()).display), (await pad()).display);

/* ── 3. 确定 → 写进变量 ── */
// 注意：字母键的 data-k 是小写（大小写由 ⇧ 决定），'-' 在符号页（上面 @ 已经验过符号）
await tapStr('line01');
await tap('确定', 'ok');
ok('确定 → 键盘收起', (await pad()).open === false);
ok('确定 → 字符串按输入内容写进变量', (await store('sName')) === 'line01', String(await store('sName')));

/* ── 4. 取消不写 ── */
await openPad(ids.str);
await tap('清空', 'clear');
await tapStr('xyz');
await tap('取消', 'cancel');
ok('取消 → 变量保持原值（没被写脏）', (await store('sName')) === 'line01', String(await store('sName')));

/* ── 5. 中文拼音 ── */
await openPad(ids.str);
await tap('中/英', 'lang');
const pZh = await pad();
ok('中/英 → 按钮变高亮', pZh.textKeys.includes('中/英'));
await typeIn('ni');
const cNi = await pad();
ok('打 ni → 候选条出现，且有「你」', cNi.candVisible && cNi.candChars.includes('你'), JSON.stringify(cNi.candChars.slice(0, 8)));
await page.click('#npCand button:has-text("你")');
await sleep(150);
ok('点候选字「你」→ 上屏到显示区', (await pad()).display.includes('你'), (await pad()).display);
await typeIn('zhong');
const cZh = await pad();
ok('打 zhong → 候选里有「中」', cZh.candChars.includes('中'), JSON.stringify(cZh.candChars.slice(0, 8)));
await page.click('#npCand button:has-text("中")');
await sleep(150);
ok('「你中」都在显示区了', /你中/.test((await pad()).display), (await pad()).display);
ok('选字后拼音缓冲清空（候选行回到提示态、没有候选按钮）',
  (await pad()).candVisible === true && (await pad()).candChars.length === 0,
  JSON.stringify([(await pad()).candVisible, (await pad()).candChars.length]));

// 打一半（zh）→ 给补全提示
await typeIn('zh');
const cHint = await pad();
ok('打一半 zh → 给出能接下去的音节（提示项）', cHint.candHints.length > 0, JSON.stringify(cHint.candHints.slice(0, 6)));
await page.click('#npCand button.hint');
await sleep(150);
ok('点提示 → 音节补全，候选字出来了', (await pad()).candChars.length > 0, JSON.stringify((await pad()).candChars.slice(0, 6)));
await tap('⌫', 'back');
ok('中文模式下 ⌫ 先删拼音字母（不动已上屏的字）',
  (await pad()).display.includes('你中'), (await pad()).display);

// 中文标点
const pPunct = await pad();
ok('中文模式多出一行中文标点（，。？！等）', ['，', '。', '？', '！'].every(c => pPunct.textKeys.includes(c)),
  JSON.stringify(pPunct.textKeys.filter(k => /[，。？！]/.test(k))));
await tap('，');
ok('点中文标点直接上屏', (await pad()).display.includes('，'), (await pad()).display);
await tap('确定', 'ok');
const zhVal = await store('sName');
ok('中文确定 → 变量里是中文（你中…）', /你中/.test(String(zhVal)) && /，/.test(String(zhVal)), String(zhVal));

/* ── 6. wstring 一样能打中文 ── */
await openPad(ids.wstr);
ok('wstring 变量也是全键盘 + 标题写着 wstring',
  (await pad()).textVisible && /wstring/.test((await pad()).varLabel), (await pad()).varLabel);
await tap('中/英', 'lang');
await typeIn('zhong');
await page.click('#npCand button:has-text("中")');
await sleep(150);
await tap('确定', 'ok');
ok('wstring 也写进了中文', (await store('wName')) === '中', JSON.stringify(await store('wName')));

/* ── 7. 字符数上限（CODESYS STRING(5)）── */
await openPad(ids.short);
await tapStr('abcdefgh');
const pShort = await pad();
const shown7 = pShort.display.replace(/[│（空）已满\s]/g, '');
ok('超过变量声明的字符数就不再进去（STRING(5) → 只收 5 个）', shown7 === 'abcde', `${shown7} / ${pShort.display}`);
ok('到上限时提示「已满」', /已满/.test(pShort.display), pShort.display);
await tap('确定', 'ok');
ok('上限内正常写入', (await store('sShort')) === 'abcde', String(await store('sShort')));

/* ── 8. 数字变量仍然是数字键盘（老行为不能变）── */
const p8 = await openPad(ids.num);
ok('数值变量弹的还是数字键盘（没被文本键盘顶掉）',
  p8.numVisible && !p8.textVisible, JSON.stringify([p8.numVisible, p8.textVisible]));
ok('数值变量不带拼音候选条', p8.candVisible === false);
await page.click('#npKeys button[data-k="clear"]');   // 数字键盘也是从当前值开始编辑的，先清掉
await sleep(80);
await page.click('#npKeys button[data-k="7"]');
await page.click('#npKeys button[data-k="ok"]');
await sleep(250);
ok('数字键盘照常写值', Number(await store('rNum')) === 7, String(await store('rNum')));

/* ── 9. 候选行固定占位 + 一行不滚动 + 末尾翻页（现场反馈：高度不能忽高忽低、别用滑动）── */
const metrics = () => page.evaluate(() => {
  const p = document.getElementById('numPad');
  const c = document.getElementById('npCand');
  const bs = [...c.querySelectorAll('button')];
  const cands = bs.filter(b => !b.classList.contains('hint') && !b.classList.contains('np-page'));
  return {
    padH: p.offsetHeight,
    candVisible: !c.classList.contains('hidden'),
    candH: c.offsetHeight,
    buttons: cands.length,
    rows: new Set(cands.map(b => b.offsetTop)).size,      // 1 = 确实只有一行（没换行）
    scrollW: c.scrollWidth, clientW: c.clientWidth,
    overflowX: getComputedStyle(c).overflowX,
    tip: (c.querySelector('.np-cand-tip') || {}).textContent || '',
    pageLabel: (c.querySelector('button.np-next') || {}).textContent || '',
    pagePrev: (c.querySelector('button.np-prev') || {}).textContent || '',
    pageCount: c.querySelectorAll('button.np-page').length,
    texts: cands.map(b => b.textContent),
  };
});
await openPad(ids.str);
const mEn = await metrics();
ok('英文模式下候选行也占着位（不是整块键盘少一行）', mEn.candVisible === true, JSON.stringify(mEn));
ok('英文模式下这一行是空白（不再显示那句提示）', mEn.tip === '' && mEn.buttons === 0, JSON.stringify([mEn.tip, mEn.buttons]));
await tap('中/英', 'lang');
const mZh0 = await metrics();
ok('中文模式、一个拼音都没打时：候选行照样在，但不显示提示文字',
  mZh0.candVisible === true && mZh0.tip === '' && mZh0.buttons === 0, JSON.stringify([mZh0.tip, mZh0.buttons]));
ok('英文 ↔ 中文切换不改键盘高度', mZh0.padH === mEn.padH, `${mEn.padH} → ${mZh0.padH}`);
await tap('#+=', 'page');
const mSymZh = await metrics();
ok('切符号页也不改键盘高度', mSymZh.padH === mZh0.padH, `${mZh0.padH} → ${mSymZh.padH}`);
await tap('abc', 'page');
await sleep(120);
await typeIn('ji');                                   // ji 的字最多（130 个），最能考验翻页
const mJi = await metrics();
ok('打 ji → 这一页排满候选（>8 个）', mJi.buttons > 8, String(mJi.buttons));
ok('候选再多也只有一行（不换行、不撑高）', mJi.rows === 1, `${mJi.rows} 行`);
ok('候选行不横向滚动（overflow-x 不是 auto/scroll）',
  !['auto', 'scroll'].includes(mJi.overflowX), mJi.overflowX);
ok('候选没横向溢出（一页就排满，不用滑）', mJi.scrollW <= mJi.clientW + 1, `${mJi.scrollW} / ${mJi.clientW}`);
ok('末尾有翻页按钮：上一页「‹」+ 下一页「1/N ›」',
  mJi.pagePrev === '‹' && /^1\/\d+ ›$/.test(mJi.pageLabel), JSON.stringify([mJi.pagePrev, mJi.pageLabel]));
ok('候选行高度不变（不管有没有字、有几个字）', mJi.candH === mZh0.candH, `${mZh0.candH} → ${mJi.candH}`);
ok('整块键盘高度不变（打字时不跳）', mJi.padH === mZh0.padH, `${mZh0.padH} → ${mJi.padH}`);
// 翻页：往后翻一页、再翻回来，高度都不变
await page.click('#npCand button.np-next');
await sleep(180);
const mJi2 = await metrics();
ok('点「›」→ 到第 2 页（按钮变「2/N」，候选换了）',
  /^2\//.test(mJi2.pageLabel) && mJi2.texts.join('') !== mJi.texts.join(''), mJi2.pageLabel);
ok('翻页不改键盘高度', mJi2.padH === mJi.padH && mJi2.candH === mJi.candH, `${mJi.padH} → ${mJi2.padH}`);
ok('第 2 页也还是一行、不溢出', mJi2.rows === 1 && mJi2.scrollW <= mJi2.clientW + 1,
  JSON.stringify([mJi2.rows, mJi2.scrollW, mJi2.clientW]));
// ★ 往回翻
await page.click('#npCand button.np-prev');
await sleep(180);
const mBack = await metrics();
ok('点「‹」→ 能翻回第 1 页，候选和刚才第 1 页一样',
  /^1\//.test(mBack.pageLabel) && mBack.texts.join('') === mJi.texts.join(''), mBack.pageLabel);
ok('往回翻也不改键盘高度', mBack.padH === mJi.padH, `${mJi.padH} → ${mBack.padH}`);
// 从第 1 页往回翻 → 绕到最后一页
await page.click('#npCand button.np-prev');
await sleep(180);
const mWrap = await metrics();
ok('第 1 页再往回翻 → 绕到最后一页（不会卡在死按钮上）',
  /^(\d+)\/\1 ›$/.test(mWrap.pageLabel), mWrap.pageLabel);
await page.click('#npCand button.np-next');   // 绕回第 1 页
await sleep(180);
ok('再往后翻一圈回到第 1 页', /^1\//.test((await metrics()).pageLabel), (await metrics()).pageLabel);
await page.click('#npCand button:not(.hint):not(.np-page)');   // 挑一个字上屏
await sleep(200);
const mAfter = await metrics();
ok('第 2 页选字也能上屏', (await pad()).display.length > (await store('sName')).length, (await pad()).display);
ok('选完字候选行回到空白、高度还是不变', mAfter.candH === mZh0.candH && mAfter.padH === mZh0.padH && mAfter.buttons === 0,
  JSON.stringify([mAfter.candH, mAfter.padH, mAfter.buttons]));
await typeIn('zhong');
const mAgain = await metrics();
ok('重新打拼音 → 翻页状态复位（回到第 1 页）', /^1\//.test(mAgain.pageLabel) || mAgain.pageLabel === '', mAgain.pageLabel);
await tap('取消', 'cancel');

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 触摸屏软键盘（英文/数字/符号/中文）：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
