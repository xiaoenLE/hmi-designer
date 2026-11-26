// verify-widgets-param.mjs — 新增的 2 个交互类控件：条码输入 / 参数表
//
// 每个控件都要验到：
//   ① 注册成功（registry 里拿得到定义、字段齐全、attach 钩子在）
//   ② MCP 静态提取器能解析这两个 def（硬规矩：def 里不许写 ?.，写了这一步当场崩）
//   ③ 属性面板：能选中、按 props schema 长出全部输入格、**不出现 hint 说明文字**
//   ④ 编辑态渲染出预期 DOM（条码是真 input；参数表按行画显示名/值/单位/空行/只读行）
//   ⑤ 运行态交互（重点，走 runtime.js 的 attach + api）：
//        · 条码：扫码输入 + 回车 → 变量值对；长度不够不写并恢复原值；转大写/trim；
//                输入停顿自动提交；提交后清空；点 ⌨ 开文字软键盘
//        · 参数表：点行 → 软键盘出现 → 确定 → 变量值变且表格显示更新；
//                  外部改变量表格跟着变（多变量绑定登记）；body 重画后点击仍然有效（事件委托）；
//                  只读行 / 空行 / 表头点了不开键盘；string 行走文字键盘
//   ⑥ 多语言：props 的 i18n 声明让 collectEntries 收集到；切 en 后运行态/编辑画布都显示英文
//
// 用法：node test/verify-widgets-param.mjs
//   （自己拉起一个隔离后端：随机端口 + 临时数据目录，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPageShim } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFDIR = path.join(ROOT, 'js', 'widgets', 'defs');
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

const TYPES = ['barcode', 'paramTable'];
const BARCODE_PROPS = ['placeholder', 'autoSubmitMs', 'minLen', 'clearAfterSubmit', 'uppercase', 'trim',
  'fontSize', 'textColor', 'bgColor', 'borderColor', 'borderWidth', 'radius'];
const PARAM_PROPS = ['labels', 'units', 'decimals', 'showHeader', 'readonlyRows', 'rowH', 'fontSize',
  'textColor', 'bgColor', 'headerBg', 'lineColor', 'zebra', 'radius'];

/* ── 0. MCP 静态提取（def 里写 `?.` 会把解析器弄崩，所以先单独跑一遍） ── */
let statics = null;
try {
  const mcp = await import('file:///' + path.resolve(ROOT, '..', 'hmi-mcp', 'tools', 'extract-catalog.mjs').replace(/\\/g, '/'));
  statics = mcp.parseDefs(DEFDIR);
} catch (e) {
  statics = { error: String((e && e.message) || e) };
}
const staticOf = (type) => (Array.isArray(statics) ? statics.find(w => w.type === type) : null);
ok('MCP 静态提取器能解析 defs/（新 def 里没写 ?.）', Array.isArray(statics), statics.error || '');
ok('MCP 静态提取出条码输入 / 参数表两个控件',
  TYPES.every(t => !!staticOf(t)), TYPES.map(t => t + '=' + !!staticOf(t)).join(' '));

/* ── 起隔离后端 + 浏览器 ── */
const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-widgets-param-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
/** 断言抛异常（如 locator 超时）时也要收尾：别把隔离后端/浏览器留在后台 */
const cleanup = () => {
  try { if (browser) browser.close(); } catch { /* ignore */ }
  try { srv.kill(); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

let browser = null;
browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* ═══════════ 1. 造数据：变量 + 4 个控件（3 条码 / 1 参数表，都落在当前普通页）═══════════ */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const target = project.pages().find(p => p.type === 'page');
  if (!target) throw new Error('演示工程里没有普通页');
  project.setCurrentPage(target.id);
  // 地址留空 = 内部变量（不碰设备）
  const defs = [
    ['sBarcode', 'string', 'EDIT-1'],
    ['sBarcode2', 'string', ''],
    ['sBarcode3', 'string', ''],
    ['rParam1', 'real', 12.345],
    ['iParam2', 'int', 7],
    ['sParam3', 'string', 'abc'],
  ];
  defs.forEach(([name, type, value]) => {
    const old = project.data.variables.find(v => v.name === name);
    if (old) { old.type = type; old.value = value; old.address = ''; }
    else project.data.variables.push({ name, type, address: '', value });
  });
  project.commit('交互类控件测试：变量');
  varStore.resetFrom(project.variables());     // 编辑态预览初值
  const bc = project.addWidget('barcode', 40, 40);
  const bc2 = project.addWidget('barcode', 320, 40);
  const bc3 = project.addWidget('barcode', 600, 40);
  const pt = project.addWidget('paramTable', 40, 120);
  const bind = (w, name) => project.updateWidgetField(w.id, 'bindings.variable', name);
  bind(bc, 'sBarcode');
  bind(bc2, 'sBarcode2');
  bind(bc3, 'sBarcode3');
  // 参数表：按行绑变量（中间留一个空槽 = 未绑定行；末尾空槽不画）
  project.updateWidgetField(pt.id, 'bindings.variables', ['rParam1', 'iParam2', '', 'sParam3', '', '']);
  project.updateWidgetField(pt.id, 'h', 240);
  project.updateWidgetField(pt.id, 'w', 420);
  project.commit('交互类控件测试：控件');
  return { barcode: bc.id, barcode2: bc2.id, barcode3: bc3.id, paramTable: pt.id };
});
await sleep(300);

/* ── 通用小工具 ── */
async function selectWidget(id) {
  await page.evaluate(async (id) => {
    const { select } = await import('/js/editor/canvas.js');
    select([id]);
  }, id);
  await sleep(100);
}
/** 改控件上的多个属性（一次 evaluate，减少来回） */
async function setProps(id, patch) {
  await page.evaluate(([id, patch]) => {
    const { project } = window.app;
    Object.entries(patch).forEach(([k, v]) => project.updateWidgetProp(id, k, v));
  }, [id, patch]);
  await sleep(100);
}
/** 变量读写（走 varstore，界面按变量变化刷新） */
const getVar = (name) => page.evaluate(async (n) => (await import('/js/runtime/varstore.js')).varStore.get(n), name);
const setVar = (name, value) => page.evaluate(async ([n, v]) => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set(n, v);
}, [name, value]);

const bcInput = (id) => `#rtPage .wd[data-id="${id}"] .w-barcode-inp`;
const ptRowValue = (i) => `#rtPage .wd[data-id="${ids.paramTable}"] tr[data-paramrow="${i}"] .pt-value`;
const padOpen = () => page.evaluate(() => {
  const p = document.getElementById('numPad');
  const keys = document.getElementById('npKeys');
  const text = document.getElementById('npText');
  return {
    open: !!p && !p.classList.contains('hidden'),
    numKeys: !!keys && !keys.classList.contains('hidden'),
    textKeys: !!text && !text.classList.contains('hidden'),
    label: document.getElementById('npVar')?.textContent || '',
  };
});
const closePad = async () => {
  if ((await padOpen()).open) { await page.click('#npCancel'); await sleep(150); }
};
/** 一次把参数表的关键 DOM 摘要取回来（编辑态 / 运行态同一个函数，只是 root 不同） */
const tableSummary = (root) => page.evaluate(([root, id]) => {
  const el = document.querySelector(`${root} .wd[data-id="${id}"]`);
  if (!el) return { present: false };
  const rows = [...el.querySelectorAll('tbody tr[data-paramrow]')];
  return {
    present: true,
    head: [...el.querySelectorAll('thead .pt-head')].map(e => e.textContent.trim()),
    rows: rows.length,
    labels: rows.map(r => r.querySelector('.pt-name').textContent.trim()),
    values: rows.map(r => r.querySelector('.pt-value').textContent.trim()),
    vars: rows.map(r => r.getAttribute('data-paramvar') || ''),
    ro: rows.map(r => r.getAttribute('data-paramro')),
    border: getComputedStyle(el.querySelector('.w-paramTable')).borderTopWidth,
  };
}, [root, ids.paramTable]);

/* ═══════════ 2. 注册 + 工具箱 ═══════════ */
const reg = await page.evaluate(async (types) => {
  const { registry } = await import('/js/widgets/registry.js');
  const out = {};
  types.forEach(t => {
    const d = registry.get(t);
    out[t] = d ? {
      title: d.title, sub: d.sub, icon: d.icon, hidden: !!d.hidden,
      hasW: Number.isFinite(d.defaults.w), hasH: Number.isFinite(d.defaults.h),
      propKeys: (d.props || []).map(p => p.key),
      propLabels: (d.props || []).map(p => p.label),
      propHints: (d.props || []).filter(p => p.hint).map(p => p.key),
      defaultsKeys: Object.keys(d.defaults || {}).filter(k => k !== 'w' && k !== 'h'),
      binding: d.binding, actions: d.actions,
      attach: typeof d.attach,
      renderOk: (() => {
        try {
          return typeof d.render === 'function'
            && typeof d.render({ props: { ...d.defaults }, bindings: {}, w: d.defaults.w, h: d.defaults.h }, 'edit', new Map()) === 'string';
        } catch { return false; }
      })(),
    } : null;
  });
  out.order = registry.list().filter(d => types.includes(d.type)).map(d => d.type);
  return out;
}, TYPES);

ok('两个控件都注册成功（registry 里拿得到、render 能跑出 HTML）',
  TYPES.every(t => reg[t] && reg[t].renderOk), TYPES.map(t => t + '=' + !!reg[t]).join(' '));
ok('每个控件都有 title/sub/icon/默认 w/h/props，且带 attach 钩子',
  TYPES.every(t => reg[t] && reg[t].title && reg[t].sub && /^<svg/.test(reg[t].icon || '')
    && reg[t].hasW && reg[t].hasH && reg[t].propKeys.length > 0 && reg[t].attach === 'function'),
  JSON.stringify(TYPES.map(t => [t, reg[t] && reg[t].attach])));
ok('props 里一个 hint 说明文字都没有（面板不摊解释）',
  TYPES.every(t => reg[t].propHints.length === 0),
  TYPES.map(t => t + ':' + reg[t].propHints.join(',')).join(' '));
ok('条码输入：props 齐全，绑定 string/wstring，没有动作',
  JSON.stringify(reg.barcode.propKeys) === JSON.stringify(BARCODE_PROPS)
  && JSON.stringify(reg.barcode.binding.variable.types) === JSON.stringify(['string', 'wstring'])
  && Array.isArray(reg.barcode.actions) && reg.barcode.actions.length === 0,
  JSON.stringify(reg.barcode.propKeys));
ok('参数表：props 齐全，binding.variables 最多 32 行、含数值+string，没有动作',
  JSON.stringify(reg.paramTable.propKeys) === JSON.stringify(PARAM_PROPS)
  && reg.paramTable.binding.variables.max === 32
  && ['int', 'real', 'string'].every(t => reg.paramTable.binding.variables.types.includes(t))
  && Array.isArray(reg.paramTable.actions) && reg.paramTable.actions.length === 0,
  JSON.stringify(reg.paramTable.binding.variables));
ok('注册顺序里两个控件相邻（条码输入 → 参数表）', reg.order.join() === 'barcode,paramTable', reg.order.join());

const toolbox = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#toolboxList .tb-item')];
  return {
    names: items.map(e => e.querySelector('.tb-item-name')?.textContent || ''),
    svgs: items.map(e => !!e.querySelector('svg')),
    tips: items.map(e => e.title),
  };
});
ok('条码输入保留兼容定义，工具箱里不再显示',
  reg.barcode.hidden && staticOf('barcode')?.hidden && !toolbox.names.includes('条码输入'));
const paramIdx = toolbox.names.indexOf('参数表');
ok('参数表仍显示在工具箱，副标题和图标齐全',
  paramIdx >= 0 && toolbox.svgs[paramIdx] && !!toolbox.tips[paramIdx]);

/* ═══════════ 3. MCP 静态提取 == 运行中注册表（声明字段）═══════════ */
for (const t of TYPES) {
  const s = staticOf(t);
  ok(`MCP 静态提取「${s.title}」的 props / defaults / binding 与运行中一致`,
    s && JSON.stringify(s.props.map(p => p.key)) === JSON.stringify(reg[t].propKeys)
    && JSON.stringify(Object.keys(s.defaults)) === JSON.stringify(reg[t].defaultsKeys)
    && JSON.stringify(s.binding) === JSON.stringify(reg[t].binding),
    s ? JSON.stringify(s.props.map(p => p.key)) : 'missing');
}

/* ═══════════ 4. 属性面板：能选中、schema 行齐全、没有 hint 行 ═══════════ */
const panelSchema = () => page.evaluate(() => {
  const body = document.getElementById('propBody');
  const hintRows = [...body.querySelectorAll('.f-row')].filter(r => {
    const lab = r.querySelector('.f-label');
    if (!lab || lab.textContent.trim() !== '') return false;
    return [...r.children].some(c => c !== lab && c.tagName === 'SPAN'
      && /font-size:11px/.test(c.getAttribute('style') || ''));
  }).length;
  return {
    titles: [...body.querySelectorAll('.prop-group-title')].map(e => e.textContent.trim()),
    props: [...body.querySelectorAll('[data-prop]')].map(e => e.dataset.prop),
    hintRows,
  };
});
const panelCases = [['barcode', '条码输入', BARCODE_PROPS], ['paramTable', '参数表', PARAM_PROPS]];
for (const [key, title, want] of panelCases) {
  await selectWidget(ids[key]);
  const pane = await panelSchema();
  const missing = want.filter(k => !pane.props.includes(k));
  ok(`属性面板能选中「${title}」（标题 = ${title} 属性）`, pane.titles.includes(`${title} 属性`),
    pane.titles.join(' | ').slice(0, 120));
  ok(`「${title}」面板按 props 长出全部属性行`, missing.length === 0,
    missing.length ? '缺：' + missing.join(',') : want.length + ' 行');
  ok(`「${title}」面板里没有 hint 说明行`, pane.hintRows === 0, String(pane.hintRows));
}

/* ═══════════ 5. 编辑态渲染 ═══════════ */
await setProps(ids.barcode, {
  placeholder: '扫描条码…', minLen: 3, uppercase: true, trim: true, autoSubmitMs: 0, clearAfterSubmit: false,
});
await setProps(ids.barcode2, { placeholder: '自动提交', autoSubmitMs: 200, minLen: 2, uppercase: false });
await setProps(ids.barcode3, { placeholder: '连扫', clearAfterSubmit: true, minLen: 1, uppercase: false });
await setProps(ids.paramTable, {
  labels: '速度\n数量\n\n名称', units: 'm/min\n件\n\n',
  decimals: 2, showHeader: true, readonlyRows: '2', zebra: true,
});
await page.evaluate(() => window.app.project.commit('交互类控件测试：场景属性'));
await sleep(250);

const edBc = await page.evaluate(([id]) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  const inp = el && el.querySelector('.w-barcode-inp');
  return inp ? {
    has: true, tag: inp.tagName, disabled: inp.disabled,
    value: inp.value, placeholder: inp.getAttribute('placeholder'),
    bg: getComputedStyle(inp.closest('.w-barcode')).backgroundColor,
  } : { has: false };
}, [ids.barcode]);
ok('编辑态：条码输入画的是**真的 `<input>`**（编辑态禁用、当前值/占位文字/底色都对）',
  edBc.has && edBc.tag === 'INPUT' && edBc.disabled === true
  && edBc.value === 'EDIT-1' && edBc.placeholder === '扫描条码…' && edBc.bg === 'rgb(255, 255, 255)',
  JSON.stringify(edBc));

let edPt = await tableSummary('#canvas');
ok('编辑态：参数表 4 行（含一个未绑定空行）+ 表头「参数 / 数值」',
  edPt.present && edPt.rows === 4 && edPt.head.join() === '参数,数值',
  JSON.stringify(edPt.head) + ' rows=' + edPt.rows);
ok('编辑态：显示名按行取（缺省行显示「未绑定变量」）',
  JSON.stringify(edPt.labels) === JSON.stringify(['速度', '数量', '未绑定变量', '名称']),
  JSON.stringify(edPt.labels));
ok('编辑态：值按 decimals+单位显示（12.35 m/min / 7.00 件 / 空行 -- / 字符串原样）',
  edPt.values[0] === '12.35 m/min' && edPt.values[1] === '7.00 件'
  && edPt.values[2] === '--' && edPt.values[3] === 'abc',
  JSON.stringify(edPt.values));
ok('编辑态：readonlyRows="2" 把第 2 行标成只读，并挂上行号/变量名',
  JSON.stringify(edPt.ro) === JSON.stringify([null, '1', null, null])
  && JSON.stringify(edPt.vars) === JSON.stringify(['rParam1', 'iParam2', '', 'sParam3']),
  JSON.stringify(edPt.ro) + ' ' + JSON.stringify(edPt.vars));

/* ═══════════ 6. 运行态：条码输入 ═══════════ */
await page.evaluate(() => window.app.enterRun());
await sleep(600);
ok('运行态：条码输入 / 参数表都画出来了',
  (await page.locator(bcInput(ids.barcode)).count()) === 1
  && (await page.locator(`#rtPage .wd[data-id="${ids.paramTable}"]`).count()) === 1);

ok('运行态：条码框初始显示绑定变量的当前值', (await page.locator(bcInput(ids.barcode)).inputValue()) === 'EDIT-1',
  await page.locator(bcInput(ids.barcode)).inputValue());

// 长度 < minLen（3）：不写，恢复原值
await page.fill(bcInput(ids.barcode), 'ab');
await page.press(bcInput(ids.barcode), 'Enter');
await sleep(200);
ok('条码：长度不够（ab < minLen 3）→ 不写变量、框里恢复原值',
  (await getVar('sBarcode')) === 'EDIT-1' && (await page.locator(bcInput(ids.barcode)).inputValue()) === 'EDIT-1',
  JSON.stringify({ v: await getVar('sBarcode'), shown: await page.locator(bcInput(ids.barcode)).inputValue() }));

// 扫码枪行为：带空格 + 小写 → trim + 转大写 → 回车提交
await page.fill(bcInput(ids.barcode), '  ab-12  ');
await page.press(bcInput(ids.barcode), 'Enter');
await sleep(250);
ok('条码：回车提交，trim + 转大写后写进变量（  ab-12   → AB-12）',
  (await getVar('sBarcode')) === 'AB-12' && (await page.locator(bcInput(ids.barcode)).inputValue()) === 'AB-12',
  JSON.stringify({ v: await getVar('sBarcode'), shown: await page.locator(bcInput(ids.barcode)).inputValue() }));

// body 被变量刷新重建后，绑在 el 上的监听还在 → 再扫一次仍然生效（事件委托）
await page.fill(bcInput(ids.barcode), ' xyz ');
await page.press(bcInput(ids.barcode), 'Enter');
await sleep(250);
ok('条码：控件 body 刷新重建后再扫一次照样提交（事件委托在 el 上）',
  (await getVar('sBarcode')) === 'XYZ', String(await getVar('sBarcode')));

// 自动提交：输入停顿 200ms 就写，不用回车
await page.fill(bcInput(ids.barcode2), 'auto-9');
await sleep(600);
ok('条码：autoSubmitMs=200 → 输入停顿后自动提交（不按回车）',
  (await getVar('sBarcode2')) === 'auto-9', String(await getVar('sBarcode2')));

// 提交后清空：变量写进去，框里留空（连扫多件）
await page.fill(bcInput(ids.barcode3), 'CLR-1');
await page.press(bcInput(ids.barcode3), 'Enter');
await sleep(300);
ok('条码：提交后清空 → 变量有值、输入框为空',
  (await getVar('sBarcode3')) === 'CLR-1' && (await page.locator(bcInput(ids.barcode3)).inputValue()) === '',
  JSON.stringify({ v: await getVar('sBarcode3'), shown: await page.locator(bcInput(ids.barcode3)).inputValue() }));

// 触屏：点控件右边的 ⌨ → 弹运行态软键盘；string 变量 = 文字键盘
await page.click(`#rtPage .wd[data-id="${ids.barcode}"] .w-barcode-kb`);
await sleep(250);
let pad = await padOpen();
ok('条码：点 ⌨ 开运行态软键盘（string 变量 → 文字键盘，不是数字键盘）',
  pad.open && pad.textKeys && !pad.numKeys, JSON.stringify(pad));
await closePad();

/* ═══════════ 7. 运行态：参数表点行改值 ═══════════ */
let rtPt = await tableSummary('#rtPage');
ok('运行态：参数表照编辑态画出（4 行 / 显示名 / 值 / 只读行）',
  rtPt.present && rtPt.rows === 4 && JSON.stringify(rtPt.labels) === JSON.stringify(['速度', '数量', '未绑定变量', '名称'])
  && rtPt.values[0] === '12.35 m/min' && rtPt.ro[1] === '1',
  JSON.stringify(rtPt.values));

// 点第 1 行（real 变量）→ 数字键盘，标题是变量名
await page.click(ptRowValue(0));
await sleep(250);
pad = await padOpen();
ok('参数表：点绑了 real 变量的行 → 数字软键盘弹出，标题显示变量名',
  pad.open && pad.numKeys && !pad.textKeys && pad.label.includes('rParam1'), JSON.stringify(pad));

// 改成 300.5：C → 300.5 → 确定（走统一写变量门）
// ⚠ 数字键盘的按键用 data-k 标识：C 键的 data-k 是 'clear'（不是它显示的 'C'）
await page.click('#npKeys [data-k="clear"]');
for (const k of ['3', '0', '0', '.', '5']) await page.click(`#npKeys [data-k="${k}"]`);
await page.click('#npKeys [data-k="ok"]');
await sleep(350);
ok('参数表：键盘确定 → 变量写成 300.5，表格显示当场更新成 300.50 m/min',
  (await getVar('rParam1')) === 300.5
  && (await page.textContent(ptRowValue(0))).trim() === '300.50 m/min',
  JSON.stringify({ v: await getVar('rParam1'), cell: (await page.textContent(ptRowValue(0))).trim() }));

// 外部改变量 → 表格跟着变（bindings.variables 每个变量都登记进了「变量→控件」索引）
await setVar('rParam1', 55.5);
await sleep(250);
ok('参数表：外部把 rParam1 改成 55.5 → 表格跟着变（多变量刷新）',
  (await page.textContent(ptRowValue(0))).trim() === '55.50 m/min',
  (await page.textContent(ptRowValue(0))).trim());
await setVar('iParam2', 9);
await sleep(250);
ok('参数表：外部把 iParam2 改成 9 → 第二行跟着变（9.00 件）',
  (await page.textContent(ptRowValue(1))).trim() === '9.00 件',
  (await page.textContent(ptRowValue(1))).trim());
await setVar('sParam3', 'xyz');
await sleep(250);
ok('参数表：字符串变量外部改成 xyz → 第四行原样显示（数值格式化不碰字符串）',
  (await page.textContent(ptRowValue(3))).trim() === 'xyz',
  (await page.textContent(ptRowValue(3))).trim());

// body 重画后事件委托还在：再点一次照样开键盘
await page.click(ptRowValue(0));
await sleep(250);
ok('参数表：表格 body 被变量刷新重建后再点行，照样开键盘（事件委托在 el 上）',
  (await padOpen()).open);
await closePad();

// 只读行（第 2 行）/ 空行 / 表头：点了都不开键盘
await page.click(ptRowValue(1));
await sleep(200);
ok('参数表：只读行（readonlyRows=2）点了不开键盘', !(await padOpen()).open, JSON.stringify(await padOpen()));
await page.click(ptRowValue(2));
await sleep(200);
ok('参数表：未绑定变量的空行点了不开键盘', !(await padOpen()).open);
await page.click(`#rtPage .wd[data-id="${ids.paramTable}"] thead .pt-head`);
await sleep(200);
ok('参数表：点表头不开键盘', !(await padOpen()).open);

// 字符串行走文字键盘
await page.click(ptRowValue(3));
await sleep(250);
pad = await padOpen();
ok('参数表：点 string 变量的行 → 文字软键盘（自动按变量类型选键盘）',
  pad.open && pad.textKeys && !pad.numKeys && pad.label.includes('sParam3'), JSON.stringify(pad));
await closePad();

/* ═══════════ 8. 多语言：props 的 i18n 声明 + render 时 tr/trLines ═══════════ */
const i18nInfo = await page.evaluate(async () => {
  const i = await import('/js/core/i18n.js');
  i.addLanguage('en', 'English');
  const s = i.i18nState();
  if (!s.dict.en) s.dict.en = {};
  Object.assign(s.dict.en, {
    '扫描条码…': 'Scan barcode…', '速度': 'Speed', '数量': 'Qty', '名称': 'Name',
    '件': 'pcs', '参数': 'Param', '数值': 'Value', '未绑定变量': 'Unbound',
  });
  const srcs = i.collectEntries().map(r => r.source);
  i.setLang('en');
  return { srcs, lang: i.getLang() };
});
await sleep(450);   // i18n:lang → 运行态整页重画
ok('多语言：条码 placeholder + 参数表 labels/units 被收进翻译表（props i18n 声明生效）',
  ['扫描条码…', '速度', '数量', '名称', 'm/min', '件'].every(x => i18nInfo.srcs.includes(x)),
  i18nInfo.srcs.filter(x => ['扫描条码…', '速度', '数量', '名称', 'm/min', '件'].includes(x)).join(','));

const enBc = await page.evaluate(([id]) => {
  const inp = document.querySelector(`#rtPage .wd[data-id="${id}"] .w-barcode-inp`);
  return inp ? { placeholder: inp.getAttribute('placeholder'), value: inp.value } : null;
}, [ids.barcode]);
ok('多语言：切 en 后运行态条码占位文字变英文（输入值仍是数据，不翻）',
  enBc && enBc.placeholder === 'Scan barcode…' && enBc.value === 'XYZ', JSON.stringify(enBc));

let enPt = await tableSummary('#rtPage');
ok('多语言：切 en 后运行态参数表 显示名/单位/表头/空行文案都翻了',
  JSON.stringify(enPt.labels) === JSON.stringify(['Speed', 'Qty', 'Unbound', 'Name'])
  && enPt.head.join() === 'Param,Value'
  && enPt.values[1] === '9.00 pcs' && enPt.values[3] === 'xyz',
  JSON.stringify(enPt.labels) + ' | ' + JSON.stringify(enPt.values) + ' | ' + JSON.stringify(enPt.head));

// 退出运行态：编辑画布也按当前语言显示（canvas 监听 i18n:lang）
await page.evaluate(() => window.app.exitRun());
await sleep(400);
let edEn = await tableSummary('#canvas');
ok('多语言：退出运行态后编辑画布上的参数表也是英文（画布跟着切）',
  edEn.present && edEn.labels[0] === 'Speed' && edEn.head.join() === 'Param,Value',
  JSON.stringify(edEn.labels));

// 切回默认语言 → 文字回中文
await page.evaluate(async () => {
  const i = await import('/js/core/i18n.js');
  i.setLang('zh-CN');
  i.removeLanguage('en');
});
await sleep(400);
const zhPt = await tableSummary('#canvas');
ok('多语言：切回默认语言后编辑画布又变回中文（速度 / 参数,数值）',
  zhPt.labels[0] === '速度' && zhPt.head.join() === '参数,数值',
  JSON.stringify(zhPt.labels) + ' | ' + JSON.stringify(zhPt.head));

/* ═══════════ 9. 收尾 ═══════════ */
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 交互类控件（条码输入/参数表）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
