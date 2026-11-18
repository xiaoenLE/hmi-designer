// verify-opcua-refresh.mjs — 重新导入 OPC UA 时的匹配规则
//
// 现场踩到的坑：换 PLC / 设备改名之后，变量表里旧 NodeId 在服务器上已经不存在
//   （写下去就是 BadNodeIdUnknown：「节点不存在」），但名字是对的。
//   以前这种「同名、地址不同」会被当成重名 → 改名成 `arrw[1]_2`，旧地址还留着继续报错；
//   现在：同名且这次导入里没被别的节点占用 → **直接刷新地址**（并报出刷新了几个）。
//   只有同名符号在不同 POU 里各有一份（一次导入里两个节点同名）才加序号。
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8895';
installNodeFetchPatch(PORT);
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

const GOOD = 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.';
const BAD = 'ns=4;s=|var|Device.Application.GVL.';        // 旧设备名（服务器上已经不存在）

const res = await page.evaluate(async ([GOOD, BAD]) => {
  const m = (await import('/js/core/project.js')).project;
  const mod = await import('/js/editor/opcuaImport.js');
  m.data.variables.length = 0;
  const V = (name, type, address) => ({ name, type, address, value: 0, len: 0 });
  V.store = null;
  m.data.variables.push({ name: 'a', type: 'int', address: GOOD + 'a', value: 0, len: 0 });
  // 数组元素：名字对、地址是旧设备名（就是现场那个 arrw[1] 写不了的情况）
  m.data.variables.push({ name: 'arrw[1]', type: 'int', address: BAD + 'arrw[1]', value: 0, len: 0 });
  // 同名符号在不同 POU 里各有一份：变量表里已有一个 dup
  m.data.variables.push({ name: 'dup', type: 'int', address: GOOD + 'dup', value: 0, len: 0 });
  m.commit('准备');

  const nodes = [
    { name: 'a', nodeid: GOOD + 'a', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
    { name: 'arrw[1]', nodeid: GOOD + 'arrw[1]', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
    // 两个同名节点（不同 POU 里的 dup）→ 第一个刷新已有的，第二个才加序号
    { name: 'dup', nodeid: GOOD + 'POU1.dup', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
    { name: 'dup', nodeid: GOOD + 'POU2.dup', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
    { name: 'brandNew', nodeid: GOOD + 'brandNew', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
    // 数组节点：仍然按「展开成 arrw2[1]…arrw2[3]」
    { name: 'arrw2', nodeid: GOOD + 'arrw2', hmi_type: 'int[]', ua_type: 'Int16', is_array: true, complex: false, elements: 3, elem_type: 'int' },
  ];
  const out = mod.importNodes(nodes);
  const find = n => m.variables().find(v => v.name === n);
  return {
    out,
    names: m.variables().map(v => v.name),
    aAddr: find('a')?.address,
    arrw1Addr: find('arrw[1]')?.address,
    dupAddr: find('dup')?.address,
    dup2: !!find('dup_2'),
    dup2Addr: find('dup_2')?.address,
    newAddr: find('brandNew')?.address,
    e2: find('arrw2[2]')?.address,
  };
}, [GOOD, BAD]);

ok('名字对、地址是旧设备名（arrw[1]）→ 地址被刷新，不是改名成 _2',
  res.arrw1Addr === GOOD + 'arrw[1]' && !res.names.includes('arrw[1]_2'), JSON.stringify([res.arrw1Addr, res.names]));
ok('地址刷新的个数报出来了（arrw[1] 换设备名 + dup 换了 POU 路径 = 2 个）',
  res.out.readdressed === 2, String(res.out.readdressed));
ok('地址没变的（a）算更新、不算刷新',
  res.out.updated >= 1 && res.aAddr === GOOD + 'a', JSON.stringify([res.out.updated, res.aAddr]));
ok('同名的两个节点：第一个刷新已有的 dup（不是新建 _2）', res.dupAddr === GOOD + 'POU1.dup', String(res.dupAddr));
ok('同名的第二个节点才加序号 dup_2（不同 POU 的同名符号仍然区分开）',
  res.dup2 === true && res.dup2Addr === GOOD + 'POU2.dup', JSON.stringify([res.dup2, res.dup2Addr]));
ok('重名提示里写清了原因', res.out.renamed.length === 1 && /不同 POU/.test(res.out.renamed[0]), JSON.stringify(res.out.renamed));
ok('新变量照常新增（brandNew + dup_2 + arrw2 展开的 3 个元素 = 5）',
  res.out.added === 5 && res.newAddr === GOOD + 'brandNew',
  JSON.stringify([res.out.added, res.newAddr]));
ok('数组节点仍然展开成 arrw2[1]…arrw2[3]（地址按 1 起拼）',
  res.out.expandedFrom === 1 && res.out.expandedTo === 3 && res.e2 === GOOD + 'arrw2[2]',
  JSON.stringify([res.out.expandedFrom, res.out.expandedTo, res.e2]));

/* 第二次导入（幂等）：地址都一样了 → 不该再报刷新 */
const again = await page.evaluate(async ([GOOD]) => {
  const m = (await import('/js/core/project.js')).project;
  const mod = await import('/js/editor/opcuaImport.js');
  const nodes = [
    { name: 'a', nodeid: GOOD + 'a', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
    { name: 'arrw[1]', nodeid: GOOD + 'arrw[1]', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
  ];
  return mod.importNodes(nodes);
}, [GOOD]);
ok('再导一次：地址已经一致 → 刷新数为 0（幂等，不会反复报）',
  again.readdressed === 0 && again.added === 0, JSON.stringify(again));

/* ── 生成的名字用**带点的符号路径**（GVL.a），老工程会跟着改名 ── */
const named = await page.evaluate(async ([GOOD, BAD]) => {
  const m = (await import('/js/core/project.js')).project;
  const mod = await import('/js/editor/opcuaImport.js');
  m.data.variables.length = 0;
  // 老工程的裸名 + 旧设备名地址（就是现场那 13 个 arrw[k] 的情况）
  m.data.variables.push({ name: 'a', type: 'int', address: GOOD + 'a', value: 0, len: 0 });
  m.data.variables.push({ name: 'arrw[1]', type: 'int', address: `${BAD}GVL.arrw[1]`, value: 0, len: 0 });
  m.data.variables.push({ name: 'arrw[2]', type: 'int', address: `${BAD}GVL.arrw[2]`, value: 0, len: 0 });
  m.commit('准备改名');
  // 控件绑着老名字（导入改名后必须跟着改，不然界面就断了）
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const w = m.addWidget('number', 20, 20);
  w.bindings.variable = 'arrw[1]';
  m.commit('绑老名字');

  // 模拟 XML 解析出来的节点：带 path（符号路径）
  const nodes = [
    { name: 'a', path: 'GVL.a', nodeid: GOOD + 'a', hmi_type: 'int', ua_type: 'Int16', is_array: false, complex: false },
    { name: 'arrw', path: 'GVL.arrw', nodeid: GOOD + 'arrw', hmi_type: 'int[]', ua_type: 'Int16',
      is_array: true, complex: false, elements: 2, elem_type: 'int' },
  ];
  const out = mod.importNodes(nodes);
  const names = m.variables().map(v => v.name);
  const g = n => m.variables().find(v => v.name === n);
  return {
    out, names,
    aAddr: g('GVL.a')?.address,
    arr1Addr: g('GVL.arrw[1]')?.address,
    bind: m.getWidget(w.id)?.bindings?.variable,
    bare: names.filter(n => n === 'a' || n === 'arrw[1]' || n === 'arrw[2]'),
  };
}, [GOOD, BAD]);
ok('生成的变量名是带点的符号路径（a → GVL.a、arrw[k] → GVL.arrw[k]）',
  named.names.includes('GVL.a') && named.names.includes('GVL.arrw[1]') && named.names.includes('GVL.arrw[2]'),
  JSON.stringify(named.names));
ok('老名字不再留着（不会多出一份同地址的重名变量）', named.bare.length === 0, JSON.stringify(named.bare));
ok('按符号路径认变量：名字变了也认得出是同一个 → 顺便把地址也修正了',
  named.aAddr === GOOD + 'a' && named.arr1Addr === GOOD + 'arrw[1]',
  JSON.stringify([named.aAddr, named.arr1Addr]));
ok('改名时控件绑定跟着改（arrw[1] → GVL.arrw[1]，界面不断）',
  named.bind === 'GVL.arrw[1]', String(named.bind));
ok('改名个数报出来了', named.out.renameByPath === 3, JSON.stringify(named.out.renameByPath));
ok('改名原因写清楚了', named.out.renamed.some(r => /符号路径/.test(r)), JSON.stringify(named.out.renamed.slice(0, 2)));

/* 符号路径认不出（数值型 NodeId / 浏览那边的斜杠路径）→ 名字回落用原名，不乱改 */
const fallback = await page.evaluate(async () => {
  const mod = await import('/js/editor/opcuaImport.js');
  return {
    numeric: mod.genVarName({ name: 'x1', nodeid: 'ns=2;i=1001' }),
    slash: mod.genVarName({ name: 'rSpd', path: 'DeviceSet/设备/Resources/Application/GlobalVars/GVL/rSpd' }),
    dotted: mod.genVarName({ name: 'rSpd', path: 'GVL.rSpd' }),
    poud: mod.genVarName({ name: 'speed', path: 'PLC_PRG.speed' }),
    // ⚠ 中文符号名：以前这里的正则只认 ASCII，`GVL.中1[1]` 被判成"认不出" →
    //    变量名回落成裸名 `中1[1]`（少了 GVL 这一段，变量面板里也就没有前缀/缩进）
    cn: mod.genVarName({ name: '中1[1]', path: 'GVL.中1[1]' }),
    cnPoud: mod.genVarName({ name: '速度', path: '设备1.速度' }),
  };
});
ok('认不出符号路径就用原名（数值型 / 浏览斜杠路径不会被当成名字）',
  fallback.numeric === 'x1' && fallback.slash === 'rSpd' && fallback.dotted === 'GVL.rSpd' && fallback.poud === 'PLC_PRG.speed',
  JSON.stringify(fallback));
ok('中文符号路径照样认（GVL.中1[1] 就是变量名，不是裸名 中1[1]）',
  fallback.cn === 'GVL.中1[1]' && fallback.cnPoud === '设备1.速度', JSON.stringify(fallback));

/* 中文数组导入：名字带前缀、元素按 GVL.中1[k] 展开 */
const cnImport = await page.evaluate(async ([GOOD]) => {
  const m = (await import('/js/core/project.js')).project;
  const mod = await import('/js/editor/opcuaImport.js');
  m.data.variables.length = 0;
  const out = mod.importNodes([
    { name: '中1', path: 'GVL.中1', nodeid: `${GOOD}中1`, hmi_type: 'int[]', ua_type: 'Int16',
      is_array: true, complex: false, elements: 3, elem_type: 'int' },
    { name: '速度', path: 'GVL.速度', nodeid: `${GOOD}速度`, hmi_type: 'real', ua_type: 'Real',
      is_array: false, complex: false },
  ]);
  return { names: m.variables().map(v => v.name), addr: m.variables()[0]?.address || '' };
}, [GOOD]);
ok('中文数组导入：元素变量叫 GVL.中1[1..3]（带 GVL 前缀，地址也是完整 NodeId）',
  ['GVL.中1[1]', 'GVL.中1[2]', 'GVL.中1[3]'].every(n => cnImport.names.includes(n))
  && cnImport.names.includes('GVL.速度')
  && cnImport.addr === `${GOOD}中1[1]`,
  JSON.stringify(cnImport));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== OPC UA 重新导入（地址刷新）：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
