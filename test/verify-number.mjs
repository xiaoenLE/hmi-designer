// 一次性验证：数值控件两个 bug（dtype 版）
//   bug1: 新控件未勾选「软键盘输入」但运行时却启用软键盘（属性显示与运行时语义不一致）
//   bug2: 数据类型 int/uint/float/string 下拉 + float 小数位自设（0=无小数点），老工程从 fmt 反推
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

/* ── 后端隔离 ──
   本套件只验证「显示/格式化」，不该受 PLC 连通性影响。
   后端若是 plc 模式而地址不通：本地写会下发失败 → 自动 resync 把值改回设备值
   （产品行为正确：没写进去就不能在界面上留着），但显示类断言会被它搅成 0。
   这里把读写通道整个掐掉：写不发、读不回，纯本地跑。
   ⚠ 协议也要钉死成 Modbus：OPC UA 模式下「数据类型」那一行是只读的
   （导入来的类型以 PLC 为准），而本套件测的是可编辑那条路。
   （同一个后端被 verify-opcua 连过之后会留在 OPC UA，所以 getPlc 状态轮询也要 stub。） */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
  m.backend.readVar = async () => undefined;
  m.backend.plcInfo.protocol = 'modbus';
  m.backend.getPlc = async () => ({ ok: true, config: {}, status: { mode: 'memory', protocol: 'modbus' } });
}));
await page.waitForFunction(() => window.app?.project?.data);

/* ── 准备：真实变量 + 数值控件 ── */
const id = await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  const v = m.project.addVariable();
  m.project.updateVariable(v.name, { type: 'real', value: 12.345 });
  const w = m.project.addWidget('number', 40, 40);
  m.project.updateWidgetField(w.id, 'bindings.variable', v.name);
  return w.id;
})());
await page.waitForTimeout(150);

/** 取控件当前 props + 指定值/格式的渲染输出 */
const snap = (wid, val) => page.evaluate(async ([wid, val]) => {
  const m = await import('/js/core/project.js');
  const w = m.project.getWidget(wid);
  const r = await import('/js/widgets/registry.js');
  const html = r.registry.get('number').render(w, 'run', { get: () => val });
  return {
    props: { fmt: w.props.fmt, dispType: w.props.dispType, decimals: w.props.decimals },
    shown: html.match(/wn-val[^>]*>([^<]*)</)?.[1],
  };
}, [wid, val]);

/* ── bug1-A：新控件默认值显式化 ── */
const defFlags = await page.evaluate(async (wid) => {
  const w = (await import('/js/core/project.js')).project.getWidget(wid);
  return { editable: w.props.editable, useKeyboard: w.props.useKeyboard };
}, id);
ok('新控件 defaults 显式 editable/useKeyboard=true', defFlags.editable === true && defFlags.useKeyboard === true, JSON.stringify(defFlags));

await page.click(`#canvas .wd[data-id="${id}"]`);
await page.waitForTimeout(150);
const panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.filter(r => r.querySelector('.f-label')?.textContent.trim() === t);
  const cb = (t) => byLabel(t)[0]?.querySelector('input[type=checkbox]')?.checked ?? null;
  return {
    kbChecked: cb('软键盘输入'),
    edChecked: cb('可输入'),
    dtype: document.querySelector('#propBody [data-dtype="dispType"]')?.value ?? null,
    dec: document.querySelector('#propBody [data-dtype-dec="dispType"]')?.value ?? null,
    decVisible: !!document.querySelector('#propBody [data-dtype-dec="dispType"]'),
    fmtSelectGone: !document.querySelector('#propBody select[data-prop="fmt"]'),
  };
});
ok('属性面板：软键盘输入 显示勾选（与运行时一致）', panel.kbChecked === true);
ok('属性面板：可输入 显示勾选', panel.edChecked === true);
ok('属性面板：数据类型下拉出现且=float', panel.dtype === 'float', panel.dtype);
ok('属性面板：float 时小数位输入可见=1', panel.decVisible && panel.dec === '1', `dec=${panel.dec}`);
ok('旧格式下拉已移除', panel.fmtSelectGone);

/* ── bug2：float 小数位自设 ── */
const setDec = async (val) => {
  if (!(await page.$('#propBody [data-dtype-dec="dispType"]'))) {
    console.log('!! 找不到小数位输入框，面板现状：', await page.evaluate(() => ({
      groups: [...document.querySelectorAll('#propBody .prop-group-title')].map(e => e.textContent),
      dtype: document.querySelector('#propBody [data-dtype="dispType"]')?.value ?? null,
      selId: [...document.querySelectorAll('#canvas .wd.selected')].map(e => e.dataset.id),
      html: document.getElementById('propBody').innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    })));
  }
  await page.fill('#propBody [data-dtype-dec="dispType"]', val);
  await page.dispatchEvent('#propBody [data-dtype-dec="dispType"]', 'change');
  await page.waitForTimeout(120);
};
const setType = async (t) => {
  await page.selectOption('#propBody [data-dtype="dispType"]', t);
  await page.waitForTimeout(150);
};

await setDec('3');
let s = await snap(id, 12.3456);
ok('小数位=3 → fmt=%.3f', s.props.fmt === '%.3f' && s.props.decimals === 3, JSON.stringify(s.props));
ok('显示三位小数（12.3456→12.346）', s.shown === '12.346', s.shown);

await setDec('0');
s = await snap(id, 12.345);
ok('小数位=0 → fmt=%.0f', s.props.fmt === '%.0f', s.props.fmt);
ok('0 就没有小数点（12.345→12）', s.shown === '12', s.shown);

await setDec('99');
s = await snap(id, 12.345);
ok('超界 99 → 钳位 6（%.6f）', s.props.fmt === '%.6f', s.props.fmt);

await setDec('');
s = await snap(id, 12.345);
ok('清空不误写（保持 %.6f）', s.props.fmt === '%.6f', s.props.fmt);

/* ── bug2：类型切换 int/uint/string ── */
await setType('int');
s = await snap(id, 12.345);
ok('切 int → fmt=%d，显示整数', s.props.dispType === 'int' && s.props.fmt === '%d' && s.shown === '12', JSON.stringify(s.props) + ' shown=' + s.shown);
const decHidden = await page.evaluate(() => !document.querySelector('#propBody [data-dtype-dec="dispType"]'));
ok('int 时小数位输入隐藏', decHidden);

await setType('uint');
s = await snap(id, 12.345);
ok('切 uint → fmt=%d', s.props.dispType === 'uint' && s.props.fmt === '%d', JSON.stringify(s.props));

await setType('string');
s = await snap(id, 12.345);
ok('切 string → fmt=%s 原样显示', s.props.dispType === 'string' && s.props.fmt === '%s' && s.shown === '12.345', 'shown=' + s.shown);

await setType('float');
const decBack = await page.evaluate(() => document.querySelector('#propBody [data-dtype-dec="dispType"]')?.value ?? null);
s = await snap(id, 12.345);
ok('切回 float：小数位输入回归（记住 6）', decBack === '6' && s.props.fmt === '%.6f', `dec=${decBack} fmt=${s.props.fmt}`);

/* ── bug1-B + bug2：老工程兼容（无 dispType/decimals，从 fmt 反推） ── */
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const w = m.project.getWidget(wid);
  delete w.props.dispType; delete w.props.decimals;
  delete w.props.editable; delete w.props.useKeyboard;   // 模拟旧工程控件
  w.props.fmt = '%.2f';
  m.project.commit('模拟旧工程');
}, id);
await page.waitForTimeout(250);
const oldPanel = await page.evaluate(() => ({
  dtype: document.querySelector('#propBody [data-dtype="dispType"]')?.value ?? null,
  dec: document.querySelector('#propBody [data-dtype-dec="dispType"]')?.value ?? null,
  kb: [...document.querySelectorAll('#propBody .f-row')]
    .filter(r => r.querySelector('.f-label')?.textContent.trim() === '软键盘输入')[0]
    ?.querySelector('input[type=checkbox]')?.checked ?? null,
}));
const oldRender = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const w = m.project.getWidget(wid);
  const r = await import('/js/widgets/registry.js');
  return r.registry.get('number').render(w, 'run', { get: () => 12.346 }).match(/wn-val[^>]*>([^<]*)</)?.[1];
}, id);
ok('老控件 fmt=%.2f：面板反推 float + 小数位2', oldPanel.dtype === 'float' && oldPanel.dec === '2', JSON.stringify(oldPanel));
ok('老控件渲染仍按 fmt（12.346→12.35）', oldRender === '12.35', oldRender);
ok('老控件（缺键）：软键盘勾选态显示 true（=运行时行为）', oldPanel.kb === true);

// 老 %d。⚠ 这个控件**绑着 real 变量**：按「控件的类型跟着变量走」这条新规矩，
//   面板显示的是**变量的类型**（real → float），控件里那个老 fmt 不再说话
//   —— 否则会出现「变量是 real、面板写着 int」，通讯按 real 解、界面却显示整数。
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const w = m.project.getWidget(wid);
  delete w.props.dispType; delete w.props.decimals;
  w.props.fmt = '%d';
  m.project.commit('模拟旧工程2');
}, id);
await page.waitForTimeout(250);
const oldInt = await page.evaluate(() => ({
  dtype: document.querySelector('#propBody [data-dtype="dispType"]')?.value ?? null,
  decVisible: !!document.querySelector('#propBody [data-dtype-dec="dispType"]'),
}));
ok('绑着变量时「数据类型」以变量为准（变量 real → 面板 float），控件里那个老 fmt 不生效',
  oldInt.dtype === 'float', JSON.stringify(oldInt));

// 解绑 → 回到「没有 dispType 就按 fmt 反推」的老路（老工程单独一个控件的场景）
const boundName = await page.evaluate(async (wid) =>
  (await import('/js/core/project.js')).project.getWidget(wid).bindings.variable, id);
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetField(wid, 'bindings.variable', '');
  m.project.commit('解绑');
}, id);
await page.waitForTimeout(250);
const oldIntFree = await page.evaluate(() => ({
  dtype: document.querySelector('#propBody [data-dtype="dispType"]')?.value ?? null,
  decVisible: !!document.querySelector('#propBody [data-dtype-dec="dispType"]'),
}));
ok('没绑变量时仍按老 fmt 反推（%d → int，无小数位输入）',
  oldIntFree.dtype === 'int' && !oldIntFree.decVisible, JSON.stringify(oldIntFree));
await page.evaluate(async ([wid, n]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetField(wid, 'bindings.variable', n);   // 绑回去，后面运行态还要用
  m.project.commit('绑回');
}, [id, boundName]);
await page.waitForTimeout(250);

/* ── bug1-C：运行时软键盘一致性实测 ── */
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
await page.click(`#rtPage .wd[data-id="${id}"]`);
await page.waitForTimeout(200);
const padOpen = await page.evaluate(() => !document.getElementById('numPad').classList.contains('hidden'));
ok('运行时：软键盘默认开启，点击弹出数字键盘', padOpen);
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(200);

await page.evaluate(async (wid) => {
  (await import('/js/core/project.js')).project.updateWidgetProp(wid, 'useKeyboard', false);
}, id);
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
await page.click(`#rtPage .wd[data-id="${id}"]`);
await page.waitForTimeout(200);
const inline = await page.evaluate((wid) => ({
  padHidden: document.getElementById('numPad').classList.contains('hidden'),
  hasInput: !!document.querySelector(`#rtPage .wd[data-id="${wid}"] input`),
}), id);
ok('运行时：仅取消勾选即切内联输入（无需再勾再取消修复）', inline.padHidden && inline.hasInput, JSON.stringify(inline));

/* ── bug3：读回来的值也要按「小数位」显示（不只是渲染那一刻）──
   现场症状：PLC 读回 REAL 12.34567928314209，
   数据输入控件和变量监控把整条浮点尾巴都显示出来（数值控件是对的） */
const id2 = await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  const v = m.project.addVariable();
  m.project.updateVariable(v.name, { name: 'rTail', type: 'real', value: 0 });
  const inp = m.project.addWidget('input', 320, 40);          // 旧「数据输入」控件
  m.project.updateWidgetField(inp.id, 'bindings.variable', 'rTail');
  m.project.updateWidgetProp(inp.id, 'fmt', '%.1f');
  const val = m.project.addWidget('value', 560, 40);          // 旧「数值显示」控件
  m.project.updateWidgetField(val.id, 'bindings.variable', 'rTail');
  // 老工程那种只有 fmt 的写法（没有 dispType/decimals）→ 按 fmt 显示
  delete m.project.getWidget(val.id).props.dispType;
  delete m.project.getWidget(val.id).props.decimals;
  m.project.updateWidgetProp(val.id, 'fmt', '%.2f');
  m.project.commit('小数位显示测试');
  return { inp: inp.id, val: val.id, vname: 'rTail' };
})());
await page.waitForTimeout(200);
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);

// 模拟「从 PLC 读回」一个带长尾巴的 REAL（走 remote 路径，和 SSE 推送一致）
await page.evaluate(async (n) => {
  (await import('/js/runtime/varstore.js')).varStore.set(n, 12.34567928314209, 'remote');
}, id2.vname);
await page.waitForTimeout(300);
const shownTail = await page.evaluate((s) => ({
  inputW: document.querySelector(`#rtPage .wd[data-id="${s.inp}"] .w-input`)?.value,
  valueW: document.querySelector(`#rtPage .wd[data-id="${s.val}"] .w-value .v`)?.textContent,
  monitor: [...document.querySelectorAll('#rtvList .rtv-row')].find(r => r.dataset.vname === s.vname)?.querySelector('input')?.value,
}), id2);
ok('读回的 REAL：数据输入控件按 %.1f 显示（不再是 12.34567928314209）',
  shownTail.inputW === '12.3', `值=${shownTail.inputW}`);
ok('读回的 REAL：数值显示（老工程只写 fmt=%.2f）按 %.2f 显示', shownTail.valueW === '12.35', `值=${shownTail.valueW}`);
ok('读回的 REAL：变量监控只留 6 位有效数字', shownTail.monitor === '12.3457', `值=${shownTail.monitor}`);

// 只聚焦不改 → 不能把四舍五入后的值当输入写回
const before = await page.evaluate(async (n) => (await import('/js/runtime/varstore.js')).varStore.get(n), id2.vname);
await page.evaluate((wid) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-input`);
  el.focus(); el.blur();
}, id2.inp);
await page.waitForTimeout(200);
const afterFocus = await page.evaluate(async (n) => (await import('/js/runtime/varstore.js')).varStore.get(n), id2.vname);
ok('点进来又点出去（没改内容）不会把舍入值写回变量',
  before === afterFocus && afterFocus === 12.34567928314209, `${before} → ${afterFocus}`);

// 真改 → 按输入值下发
await page.evaluate((wid) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-input`);
  el.focus(); el.value = '7.25'; el.blur();
}, id2.inp);
await page.waitForTimeout(200);
const afterEdit = await page.evaluate(async (n) => (await import('/js/runtime/varstore.js')).varStore.get(n), id2.vname);
ok('真的改了（7.25）→ 变量按输入值更新', afterEdit === 7.25, String(afterEdit));
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(150);

// 属性面板：数据输入控件也要有「数据类型/小数位」（老工程按 fmt 回显）
await page.evaluate(() => (async () => {
  (await import('/js/runtime/runtime.js')).exitRun();
})());
await page.waitForTimeout(150);
await page.click(`#canvas .wd[data-id="${id2.val}"]`);
await page.waitForTimeout(200);
// 数值显示（旧控件）：以前只有一个「格式」下拉（%d / %.1f / %.2f / %.3f / %s），现在和「数值」一样
// 能选数据类型 + 自己填小数位
const valPanel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const row = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '数据类型');
  const sel = row?.querySelector('select');
  const dec = row?.querySelector('input[type=number]');
  return {
    hasFmtSelect: !!document.querySelector('#propBody select[data-prop="fmt"]'),
    hasDtype: !!row, type: sel?.value, dec: dec?.value,
    opts: sel ? [...sel.options].map(o => o.value) : [],
  };
});
ok('数值显示（旧控件）属性面板换成了「数据类型」下拉（不再只有 3 个浮点格式）',
  valPanel.hasDtype && !valPanel.hasFmtSelect && valPanel.type === 'float', JSON.stringify(valPanel));
ok('数据类型里有 int/uint/dint/udint/float/lreal/string（跟变量类型对得上）',
  JSON.stringify(valPanel.opts) === JSON.stringify(['int', 'uint', 'dint', 'udint', 'float', 'lreal', 'string']),
  JSON.stringify(valPanel.opts));

const valDtype = await page.evaluate(async (wid) => {
  const setDtype = async (t) => {
    const sel = document.querySelector('#propBody [data-dtype="dispType"]');
    sel.value = t;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 260));
  };
  const shown = async (v) => {
    const m = await import('/js/core/project.js');
    const r = await import('/js/widgets/registry.js');
    return r.registry.get('value').render(m.project.getWidget(wid), 'run', { get: () => v }).match(/class="v"[^>]*>([^<]*)</)?.[1];
  };
  const out = {};
  // ⚠ 下拉里浮点那一项的值是 'float'（real 是变量表里的叫法）：
  //   给 select.value 设一个不存在的值 = 变空串，那一路以前会把变量类型写成空的
  await setDtype('float');
  const dec = document.querySelector('#propBody [data-dtype-dec="dispType"]');
  dec.value = '3';
  dec.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 260));
  out.float3 = await shown(12.34567);
  await setDtype('dint');
  out.dint = await shown(12.34567);
  await setDtype('lreal');
  out.lrealHasDec = !!document.querySelector('#propBody [data-dtype-dec="dispType"]');
  out.after = (await import('/js/core/project.js')).project.getWidget(wid).props;
  return out;
}, id2.val);
ok('数值显示：选 real/float + 小数位 3 → 显示 12.346', valDtype.float3 === '12.346', String(valDtype.float3));
ok('数值显示：选 dint → 显示整数 12', valDtype.dint === '12', String(valDtype.dint));
ok('数值显示：选 lreal 也能填小数位（浮点类都给小数位输入）', valDtype.lrealHasDec === true, JSON.stringify(valDtype.after));
// 老工程没有 dispType/decimals，只有 fmt → 仍按 fmt 显示（不能因为这次改动把老工程显示改了）
const legacyFmt = await page.evaluate(async () => {
  const r = await import('/js/widgets/registry.js');
  const t = await import('/js/core/utils.js');
  const w = { props: { fmt: '%.2f', unit: '', fontSize: 16, textColor: '#000', bgColor: '#fff', borderColor: '#000' },
    bindings: { variable: 'x' } };
  return {
    fmt: t.numberFmtOf(w.props),
    out: r.registry.get('value').render(w, 'run', { get: () => 12.34567 }).match(/class="v"[^>]*>([^<]*)</)?.[1],
  };
});
ok('老工程只有 fmt（没有 dispType）→ 照旧按 fmt 显示 12.35', legacyFmt.out === '12.35', JSON.stringify(legacyFmt));

// 数据输入（旧 input）控件：属性面板也能设数据类型/小数位（以前连「格式」都没有，读回值直接漏尾巴）
await page.click(`#canvas .wd[data-id="${id2.inp}"]`);
await page.waitForTimeout(200);
const inpPanel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const row = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '数据类型');
  const sel = row?.querySelector('select');
  const dec = row?.querySelector('input[type=number]');
  return { hasRow: !!row, type: sel?.value, dec: dec?.value };
});
// 绑着变量 rTail：面板显示的是**变量的类型**（上面几步已经把 rTail 改成了 lreal），
// 小数位仍是控件自己那个 1
ok('数据输入控件属性面板有「数据类型=变量类型(lreal) + 小数位=1」',
  inpPanel.hasRow && inpPanel.type === 'lreal' && inpPanel.dec === '1', JSON.stringify(inpPanel));
const decChange = await page.evaluate(async (wid) => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const row = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '数据类型');
  const dec = row.querySelector('input[type=number]');
  dec.value = '3';
  dec.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const m = await import('/js/core/project.js');
  const w = m.project.getWidget(wid);
  const r = await import('/js/widgets/registry.js');
  const html = r.registry.get('input').render(w, 'edit', { get: () => 12.34567928314209 });
  return { decimals: w.props.decimals, fmt: w.props.fmt, shown: html.match(/value="([^"]*)"/)?.[1] };
}, id2.inp);
ok('数据输入控件：小数位改 3 → 显示立刻变 12.346',
  decChange.decimals === 3 && decChange.fmt === '%.3f' && decChange.shown === '12.346', JSON.stringify(decChange));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
await browser.close();
process.exit(fails ? 1 : 0);
