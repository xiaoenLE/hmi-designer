// verify-addr-form.mjs — 地址输入框的「协议/前缀下拉 + 编号框 + 后端校验」
//
//   现场口径（task-8 + lead 拍板 m00177/m00340）：
//     · 地址格 = 前缀下拉（目录来自 backend GET /api/comm/protocols，老后端/无 comm_api 时用本地 FALLBACK）
//       + 编号输入框；前缀 change 会把「前缀 + 末尾数字」拼成地址（D + 100 = D100）。
//     · 校验走后端 POST /api/comm/validate（阻塞在 250ms 防抖 / blur / change / 点「新建」前）；
//       后端调不到时退回 js/core/addrMap.js 本地规则，行为一致、不许炸。
//     · valid:false + code:'model'（写法与协议不匹配）= **灰字「内部变量」、不标红**（既有现场口径）；
//       code:'invalid'（语法/范围/类型错）= 红边 + 红字 message；空地址 = 「留空 = 内部变量」正常灰字。
//     · TS600 的 %MW100 / %W100 / %MD50、HR100 / 4X0100 / 纯数字 = **兼容有效写法（valid）**，
//       不是内部变量（server/addr_model.py 与 docs/ts600-modbus-tcp.md 同口径）。
//     · T/C 是双身份元件：vtype=bool → 触点（线圈），vtype=int/real → 当前值（保持寄存器）；
//       校验必须把变量的数据类型一起送后端，不能按地址字面猜。
//
// 用法：node test/verify-addr-form.mjs <port>       （或 node tools/run-suites.mjs verify-addr-form）
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(300);

/** 切协议（前端「当前模型」= localStorage profile + backend.plcInfo；两者都改才稳） */
const useProto = (proto) => page.evaluate(async (pid) => {
  const u = await import('/js/core/utils.js');
  u.setProfile(pid === 'ts600' ? 'ts600-modbus-tcp' : (pid === 'opcua' ? 'invt-modbus-slave' : 'invt-modbus-slave'), false);
  const { backend } = await import('/js/api/backend.js');
  backend.setPlcInfo({ protocol: pid });
}, proto);

const openAddDlg = async () => {
  await page.evaluate(async () => { const m = await import('/js/editor/varAdd.js'); m.openAddVarDialog({}); });
  await page.waitForSelector('#vaAddr', { state: 'visible' });
  await sleep(200);
};
const closeDlg = async () => { await page.evaluate(() => document.getElementById('dlgCancel')?.click()); await sleep(150); };

const addrSt = () => page.evaluate(() => {
  const i = document.getElementById('vaAddr');
  const m = document.getElementById('vaAddrMsg');
  return {
    value: i?.value ?? '',
    cls: i?.className ?? '',
    color: i ? i.style.color : '',
    title: i?.title ?? '',
    msg: m?.textContent ?? '',
    msgCls: m?.className ?? '',
    bad: !!i && i.classList.contains('addr-bad'),
  };
});
/** 写地址 + 触发 change + 等后端结论（250ms 防抖 / 微任务后校验） */
const typeAddr = async (v, { change = true, wait = 800 } = {}) => {
  await page.fill('#vaAddr', '');
  if (v) await page.fill('#vaAddr', v);
  if (change) await page.$eval('#vaAddr', el => el.dispatchEvent(new Event('change', { bubbles: true })));
  await sleep(wait);
  return addrSt();
};
const lastRes = () => page.evaluate(async () => null);   // （占位：控制器不挂 DOM，结论看界面 / 直调 catalog）
const catValidate = (proto, address, vtype, write = false) => page.evaluate(async (a) => {
  const cat = await import('/js/core/addrCatalog.js');
  const r = await cat.validate(a.proto, a.address, a.vtype, a.write);
  return { valid: r?.valid, unsupported: r?.unsupported, code: r?.code, message: r?.message, writable: r?.writable, source: r?.source };
}, { proto, address, vtype, write });

/* ══════ A. TS600：前缀下拉 + D100 有效 ══════ */
await useProto('ts600');
await openAddDlg();
const dlgA = await page.evaluate(() => {
  const sel = document.getElementById('vaPrefix');
  const m = document.getElementById('vaAddrMsg');
  return {
    hasSel: !!sel,
    values: [...(sel?.options || [])].map(o => o.value),
    labels: [...(sel?.options || [])].map(o => o.textContent),
    ph: document.getElementById('vaAddr')?.placeholder || '',
    msg: m?.textContent || '',
    msgCls: m?.className || '',
  };
});
ok('A TS600 下地址格有前缀下拉（select.addr-prefix / #vaPrefix）', dlgA.hasSel, JSON.stringify(dlgA));
ok('A TS600 前缀下拉含 D/M/X/Y/T/C/R/Z（元件写法）',
  ['D', 'M', 'X', 'Y', 'T', 'C', 'R', 'Z'].every(p => dlgA.values.includes(p)),
  dlgA.values.join(','));
ok('A TS600 占位符是 D100 写法（不是 %MW）', /D100/.test(dlgA.ph) && !/%MW/.test(dlgA.ph), dlgA.ph);
ok('A 空地址 = 「留空 = 内部变量」灰字、不标红',
  /留空/.test(dlgA.msg) && !/bad/.test(dlgA.msgCls), JSON.stringify({ msg: dlgA.msg, cls: dlgA.msgCls }));

/* 前缀下拉 + 编号框拼地址：选 D 再打 100 → D100（D 是字元件，先把类型切 real） */
await page.selectOption('#vaType', 'real');
await sleep(150);
await page.fill('#vaAddr', '');
await page.selectOption('#vaPrefix', 'D');
await sleep(250);
await page.fill('#vaAddr', 'D100');
await page.$eval('#vaAddr', el => el.dispatchEvent(new Event('change', { bubbles: true })));
await sleep(800);
const stD = await addrSt();
ok('A D100（TS600 数据寄存器）有效：无红边、灰字说明',
  !stD.bad && !/bad/.test(stD.msgCls) && stD.color !== 'var(--danger)' && /D100|数据寄存器|保持寄存器|寄存器/.test(stD.msg),
  JSON.stringify(stD));
const resD = await catValidate('ts600', 'D100', 'real');
ok('A D100 + real 后端结论 valid=true', resD.valid === true && resD.code !== 'invalid', JSON.stringify(resD));
ok('A 前缀下拉跟着地址文本走（D100 → 选中 D）',
  await page.evaluate(() => document.getElementById('vaPrefix')?.value) === 'D',
  await page.evaluate(() => document.getElementById('vaPrefix')?.value));

/* ══════ B. TS600：Y18 是 8 进制写错 → 红边红字 ══════ */
await page.selectOption('#vaType', 'bool');
await sleep(100);
const stY = await typeAddr('Y18');
ok('B Y18（8 进制元件里出现 8/9）→ 红边 + 红字提示',
  stY.bad && /bad/.test(stY.msgCls) && /8\s*进制|8\/9/.test(stY.msg) && stY.color === 'var(--danger)',
  JSON.stringify(stY));
ok('B 不合法时 title 以 ⚠ 开头（变量表既有口径）', /^⚠/.test(stY.title), stY.title);
ok('B 后端也判 Y18 不合法（code=invalid）', (await catValidate('ts600', 'Y18', 'bool')).code === 'invalid',
  JSON.stringify(await catValidate('ts600', 'Y18', 'bool')));

/* ══════ C. TS600：X17 只读（能读不能写）→ 合法但不红，提示只读 ══════ */
const stX = await typeAddr('X17');
ok('C X17（输入继电器，只读）算合法：无红边',
  !stX.bad && stX.color !== 'var(--danger)', JSON.stringify(stX));
ok('C 写只读地址要提示「只读…能读，不能写」', /只读/.test(stX.msg) && /不能写/.test(stX.msg), stX.msg);
ok('C 后端 writable=false', (await catValidate('ts600', 'X17', 'bool')).writable === false, JSON.stringify(await catValidate('ts600', 'X17', 'bool')));

/* ══════ D. TS600：%MX0.0 写法与协议不匹配 → 灰「内部变量」不标红 ══════ */
const stMx = await typeAddr('%MX0.0');
ok('D %MX0.0 在 TS600 下 = 内部变量（灰字、不标红）',
  !stMx.bad && !/bad/.test(stMx.msgCls) && /内部变量/.test(stMx.msg) && stMx.color !== 'var(--danger)',
  JSON.stringify(stMx));
const resMx = await catValidate('ts600', '%MX0.0', 'bool');
ok('D 后端判 unsupported/code=model（不是 invalid）',
  resMx.unsupported === true && resMx.code === 'model' && resMx.valid === false, JSON.stringify(resMx));

/* ══════ E. TS600：%MW100 是兼容有效写法（lead m00177 的 B 口径）══════ */
await page.selectOption('#vaType', 'real');
await sleep(100);
const stMw = await typeAddr('%MW100');
ok('E %MW100 在 TS600 下 valid（兼容 INVT 写法），不是内部变量',
  !stMw.bad && !/内部变量/.test(stMw.msg) && !/bad/.test(stMw.msgCls), JSON.stringify(stMw));
const resMw = await catValidate('ts600', '%MW100', 'real');
ok('E 后端也判 %MW100@ts600 valid=true', resMw.valid === true, JSON.stringify(resMw));

/* ══════ F. T/C 双身份：vtype 必须透传（bool=触点，数值=当前值）══════ */
const tBool = await catValidate('ts600', 'T5', 'bool');
const tInt = await catValidate('ts600', 'T5', 'int');
ok('F T5+bool / T5+int 都是 valid（双身份元件按数据类型解释）', tBool.valid === true && tInt.valid === true,
  JSON.stringify({ tBool, tInt }));
ok('F 选 bool 时 T5 说明写「触点」，选 int 时写「当前值/保持寄存器」',
  /触点|线圈/.test(tBool.message || '') && /当前值|保持寄存器|字/.test(tInt.message || ''),
  JSON.stringify({ b: tBool.message, i: tInt.message }));

/* ══════ G. 变量表地址格：前缀下拉 + 红/灰口径 ══════ */
await closeDlg();
// 后端 status 轮询会把 plcInfo 拉回落盘的 modbus，变量表按它推协议；这里钉住 ts600 再建行
await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  window.__origProtocol = backend.protocol;
  backend.protocol = () => 'ts600';
  const pr = window.app.project;
  pr.data.variables.length = 0;
  pr.data.variables.push({ name: 'tY18', type: 'bool', address: 'Y18', value: false, len: 0 });
  pr.data.variables.push({ name: 'tX17', type: 'bool', address: 'X17', value: false, len: 0 });
  pr.data.variables.push({ name: 'tMx', type: 'bool', address: '%MX0.0', value: false, len: 0 });
  pr.commit('测试变量');
  const { bus } = await import('/js/core/eventBus.js');
  bus.emit('plc:protocol', { protocol: 'ts600' });
});
await sleep(500);
const cellHas = (name) => page.evaluate((n) => {
  const tr = document.querySelector(`#varTable tr[data-name="${n}"]`);
  const i = tr?.querySelector('input[data-k="address"]');
  const s = tr?.querySelector('select.addr-prefix');
  return { has: !!i, sel: !!s, selVal: s?.value || '', cls: i?.className || '', title: i?.title || '', value: i?.value || '' };
}, name);
const cY = await cellHas('tY18');
ok('G 变量表地址格也有前缀下拉（select.addr-prefix）', cY.has && cY.sel, JSON.stringify(cY));
const fireAddrChange = (name, v) => page.evaluate((a) => {
  const i = document.querySelector(`#varTable tr[data-name="${a.name}"] input[data-k="address"]`);
  if (!i) return;
  i.value = a.v;
  i.dispatchEvent(new Event('change', { bubbles: true }));
}, { name, v });
await fireAddrChange('tY18', 'Y18');
await sleep(800);
const cY2 = await cellHas('tY18');
ok('G 变量表里 Y18 也标红（addr-bad + 红色）',
  /addr-bad/.test(cY2.cls) && cY2.title.startsWith('⚠'), JSON.stringify(cY2));
await fireAddrChange('tX17', 'X17');
await sleep(800);
const cX2 = await cellHas('tX17');
ok('G 变量表里 X17 不标红，title 提示只读',
  !/addr-bad/.test(cX2.cls) && /只读/.test(cX2.title), JSON.stringify(cX2));
await fireAddrChange('tMx', '%MX0.0');
await sleep(800);
const cMx2 = await cellHas('tMx');
ok('G 变量表里 %MX0.0（TS600）不标红（内部变量灰字口径）',
  !/addr-bad/.test(cMx2.cls) && /内部变量/.test(cMx2.title), JSON.stringify(cMx2));
await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  if (window.__origProtocol) backend.protocol = window.__origProtocol;
});

/* ══════ H. 后端没有 comm_api / 接口调不到 → 本地 FALLBACK 不炸 ══════ */
const fallback = await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const cat = await import('/js/core/addrCatalog.js');
  const saved = { va: backend.validateAddr, cp: backend.commProtocols };
  backend.validateAddr = async () => null;      // 模拟老后端：没有 /api/comm/validate
  backend.commProtocols = async () => null;     // 模拟老后端：没有 /api/comm/protocols
  try {
    await cat.loadCatalog({ force: true });
    const src = cat.catalogSource();
    const d100 = await cat.validate('ts600', 'D100', 'real');
    const y18 = await cat.validate('ts600', 'Y18', 'bool');
    const mx = await cat.validate('ts600', '%MX0.0', 'bool');
    const d100modbus = await cat.validate('modbus', 'D100', 'real');
    const empty = await cat.validate('modbus', '', 'real');
    return {
      src, hasCommApi: backend.hasCommApi(),
      d100: { valid: d100.valid, code: d100.code, source: d100.source },
      y18: { valid: y18.valid, code: y18.code, source: y18.source },
      mx: { valid: mx.valid, unsupported: mx.unsupported, code: mx.code },
      d100modbus: { valid: d100modbus.valid, unsupported: d100modbus.unsupported, code: d100modbus.code },
      empty: { valid: empty.valid, code: empty.code },
    };
  } finally {
    backend.validateAddr = saved.va;
    backend.commProtocols = saved.cp;
    try { await cat.loadCatalog({ force: true }); } catch { /* 恢复真实目录 */ }
  }
});
ok('H 后端无 comm_api 时目录退回本地 FALLBACK（仍有三项协议）', fallback.src === 'fallback', JSON.stringify(fallback));
ok('H FALLBACK 下 D100@ts600 仍判 valid（本地 addrMap 规则）', fallback.d100.valid === true, JSON.stringify(fallback.d100));
ok('H FALLBACK 下 Y18@ts600 仍判 invalid', fallback.y18.valid === false && fallback.y18.code === 'invalid', JSON.stringify(fallback.y18));
ok('H FALLBACK 下 %MX0.0@ts600 仍判 model（灰内部变量）',
  fallback.mx.unsupported === true && fallback.mx.code === 'model', JSON.stringify(fallback.mx));
ok('H FALLBACK 下 D100@modbus 判 model', fallback.d100modbus.unsupported === true, JSON.stringify(fallback.d100modbus));
ok('H FALLBACK 下空地址 = 正常（code=empty, valid）', fallback.empty.code === 'empty', JSON.stringify(fallback.empty));

/* ══════ I. Modbus：D100 = 内部变量灰字；HR100 有效；占位符 %MW ══════ */
await useProto('modbus');
await openAddDlg();
const phM = await page.evaluate(() => document.getElementById('vaAddr')?.placeholder || '');
ok('I Modbus 占位符是 %MW（老现场口径没变）', /%MW/.test(phM), phM);
const stDm = await typeAddr('D100');
ok('I Modbus 下 D100 写法不匹配 = 灰内部变量、不标红',
  !stDm.bad && !/bad/.test(stDm.msgCls) && /内部变量/.test(stDm.msg), JSON.stringify(stDm));
const stHr = await typeAddr('HR100');
ok('I HR100 归一化后有效（无红）', !stHr.bad, JSON.stringify(stHr));
await closeDlg();

/* ══════ J. OPC UA：没有前缀下拉，NodeId 直接写 ══════ */
await useProto('opcua');
await openAddDlg();
const ua = await page.evaluate(() => ({
  hasSel: !!document.getElementById('vaPrefix'),
  ph: document.getElementById('vaAddr')?.placeholder || '',
}));
ok('J OPC UA 下隐藏前缀下拉（NodeId 不是「前缀+编号」）', ua.hasSel === false, JSON.stringify(ua));
ok('J OPC UA 占位符是 NodeId 写法', /ns=4;s=/.test(ua.ph), ua.ph);
const stUa = await typeAddr('ns=4;s=|var|PLC.Application.POU.x');
ok('J NodeId 有效、不标红', !stUa.bad && stUa.msgCls !== 'addr-msg bad', JSON.stringify(stUa));
await closeDlg();

/* ══════ 收尾 ══════ */
const errs = pageErrors.filter(e => !/Failed to load resource|503/.test(e));
ok('K 全程没有未捕获的页面异常', errs.length === 0, errs.slice(0, 3).join(' | '));

const fails = results.filter(r => r.startsWith('FAIL'));
console.log(results.join('\n'));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length) console.log('\nFAILED:\n' + fails.join('\n'));
await browser.close();
process.exit(fails.length ? 1 : 0);
