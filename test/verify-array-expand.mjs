// verify-array-expand.mjs — 「展开成单个变量」+ 老工程「数组元素」下标的迁移
//
// 背景：数组一律走 `[]` 变量名（arrw[1]…arrw[N]，和 PLC 的 NodeId/ARRAY[1..N] 对齐），
//   「数组元素」这个下标属性已经删掉。删了之后必须保证老工程不受伤：
//     · 老控件设过「数组元素=2」→ 展开时自动改绑到 arrw[3]（老下标 0 起，变量名 1 起）
//     · 没下标的（绑整段）→ 自动清空并报数，让用户知道有几处要重配
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8891';
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
await sleep(400);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null; m.backend.state = 'offline';
  m.backend.writeVar = async () => {}; m.backend.readVars = async () => null;
}));

/* 老工程：一个 int[] 数组 + 三个控件（有下标 / 无下标 / 波形通道） */
const before = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const NS = 'ns=4;s=|var|Device.Application.GVL.';
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'arrw', type: 'int[]', address: NS + 'arrw', len: 13, value: 0 });
  m.data.variables.push({ name: 'rSpd', type: 'real', address: '%MW100', value: 1 });
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const withIdx = m.addWidget('number', 20, 20);        // 老写法：绑整段 + 下标 2（0 起 = 第 3 个）
  withIdx.name = '有下标'; withIdx.bindings.variable = 'arrw'; withIdx.props.arrIdx = 2;
  const whole = m.addWidget('number', 20, 90);          // 绑整段、没下标 → 展开后只能清空
  whole.name = '整段'; whole.bindings.variable = 'arrw';
  const tr = m.addWidget('trend', 20, 160);
  tr.name = '波形'; tr.bindings.variables = ['rSpd', 'arrw', '', '', '', '', '', ''];
  m.commit('老工程');
  return { a: withIdx.id, b: whole.id, t: tr.id };
});
await sleep(250);

const res = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  return m.expandArrayVar('arrw');
});
ok('展开产出 13 个元素变量', res.ok === true && res.created?.length === 13, JSON.stringify(res).slice(0, 160));
ok('1 个老控件按「数组元素」下标改绑（0 起的 2 → arrw[3]）', res.remapped === 1, String(res.remapped));
ok('绑整段的都清掉并计数（1 个控件 + 1 个波形通道 = 2，让用户知道有几处要重配）',
  res.cleared === 2, String(res.cleared));

const after = await page.evaluate(async (ids) => {
  const m = (await import('/js/core/project.js')).project;
  const g = id => m.getWidget(id);
  const names = m.variables().map(v => v.name);
  return {
    names,
    aBind: g(ids.a)?.bindings?.variable, aIdx: g(ids.a)?.props?.arrIdx,
    bBind: g(ids.b)?.bindings?.variable,
    tChans: g(ids.t)?.bindings?.variables,
    arrwType: m.variables().find(v => v.name === 'arrw[3]')?.type,
    arrwAddr: m.variables().find(v => v.name === 'arrw[3]')?.address,
  };
}, before);

ok('变量表里 13 个 arrw[1]…arrw[13]，原数组变量没了',
  after.names.length === 14 && after.names.includes('arrw[1]') && after.names.includes('arrw[13]') && !after.names.includes('arrw'),
  JSON.stringify(after.names));
ok('元素类型从 int[] 拆成 int', after.arrwType === 'int', String(after.arrwType));
ok('元素地址按 PLC 的 1 起写法拼（…GVL.arrw[3]）', /GVL\.arrw\[3\]$/.test(after.arrwAddr || ''), String(after.arrwAddr));
ok('老控件改绑到 arrw[3] 且下标属性被清掉', after.aBind === 'arrw[3]' && after.aIdx === undefined,
  JSON.stringify([after.aBind, after.aIdx]));
ok('绑整段的控件变成未绑定（等用户重配）', after.bBind === '', JSON.stringify(after.bBind));
ok('波形通道里的数组引用被清成空槽（后面的通道不前移）',
  after.tChans[0] === 'rSpd' && after.tChans[1] === '' && after.tChans.length === 8, JSON.stringify(after.tChans));

/* 元素变量能当普通标量绑/写（这就是删掉「数组元素」的意义：写元素 = 写独立变量） */
const writeOk = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const st = (await import('/js/runtime/varstore.js')).varStore;
  st.resetFrom(m.variables());
  st.set('arrw[3]', 4321, 'local');
  return { got: st.get('arrw[3]'), plain: st.get('arrw') };
});
ok('写 arrw[3] 就是写普通变量（不再走「整段读改写回」那条路）',
  writeOk.got === 4321 && writeOk.plain === undefined, JSON.stringify(writeOk));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 数组展开 + 老工程下标迁移：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
