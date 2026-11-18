// verify-widget-pack.mjs — **控件包**（导出/导入别人做好的控件）的回归护栏
//
// 两层都说清楚并且守住：
//   · 实例层（内置控件）：包里**不带代码**，导出→导入后类型/属性/绑定/动作/变量对齐，
//     变量不重复、新 id 不撞、**一步 Ctrl+Z 能整批撤销**。
//   · 定义层（自定义控件）：包里**带 render 源码**，导入 = 执行别人的 JS，所以
//     ① 不带 allowCode 一律拒绝；② 导入前先冒烟渲染一次，跑不起来的定义当场回滚（别留半成品）；
//     ③ 不许覆盖内置类型；④ 定义要跟着工程走（换机器打开那份工程仍能渲染）。
//
// 用法：node test/verify-widget-pack.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
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

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-pack-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());              // 导入完的 alert 报告直接确认掉
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(300);

const R = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { registry, renderWidgetDOM } = await import('/js/widgets/registry.js');
  const { history } = await import('/js/core/history.js');
  const pack = await import('/js/widgets/pack.js');
  const out = {};
  const cur = () => project.currentPage();

  /* ── 准备：一个按钮 + 它用的变量 + 一个动作 ── */
  project.data.variables.push({ name: 'vPack', type: 'bool', address: '%MX1.0', value: false });
  const w1 = project.addWidget('button', 40, 40);
  w1.bindings.variable = 'vPack';
  w1.props.text = '来自包';
  w1.actions = [{ trigger: 'click', type: 'toggle', params: { variable: 'vPack' } }];

  /* ── ① 导出内置控件：包里不该有代码（defs 空） ── */
  const p1 = JSON.parse(JSON.stringify(project.widgetExportPayload([w1.id])));   // 走一遍真实文件路径
  out.builtin = { kind: p1.kind, version: p1.version, widgets: p1.widgets.length, vars: p1.variables.map(v => v.name), defs: p1.defs.length, hasPageName: 'pageRefs' in p1 };

  /* ── ② 导入回来：数据对齐、变量不重复、id/z 是新的 ── */
  const nW = cur().widgets.length, nV = project.data.variables.length;
  const r1 = project.importWidgetPack(p1);
  const added = cur().widgets[cur().widgets.length - 1];
  const src = p1.widgets[0];
  out.import1 = {
    ok: r1.ok, added: r1.widgetsAdded, delta: cur().widgets.length - nW,
    typeSame: added.type === src.type,
    propsSame: JSON.stringify(added.props) === JSON.stringify(src.props),
    bindSame: added.bindings.variable === 'vPack',
    actSame: JSON.stringify(added.actions) === JSON.stringify(src.actions),
    geomMoved: added.x === src.x + 16 && added.y === src.y + 16,
    newId: added.id !== src.id && added.id !== w1.id,
    zTop: added.z > w1.z,
    varsNoDup: project.data.variables.length === nV,
    varsKept: r1.varsKept, varsAdded: r1.varsAdded,
  };

  /* ── ③ 一步 Ctrl+Z 整批撤销 ── */
  history.undo();
  out.undo = { backToOriginal: cur().widgets.length === nW, stillHasBtn: cur().widgets.some(w => w.id === w1.id) };

  /* ── ④ 包里缺变量定义 → 要提醒，但控件照样进来（绑定空着） ── */
  const p2 = JSON.parse(JSON.stringify(p1));
  p2.variables = [];
  p2.widgets[0].bindings.variable = 'vPackMissing';
  const r2 = project.importWidgetPack(p2);
  out.missingVar = { ok: r2.ok, added: r2.widgetsAdded, warned: (r2.warnings || []).some(w => w.includes('vPackMissing')) };

  /* ── ⑤ 自定义控件：注册 + 冒烟测试 ── */
  const custom = {
    type: 'packgauge', title: '包内仪表', sub: '测试自定义控件',
    icon: '<svg viewBox="0 0 36 36" width="30" height="30"></svg>',
    defaults: { w: 120, h: 40, min: 0, max: 100, fontSize: 14 },
    props: [
      { key: 'min', label: '最小', type: 'number' },
      { key: 'max', label: '最大', type: 'number' },
      { key: 'fontSize', label: '字号', type: 'number' },
    ],
    binding: { variable: { types: ['int', 'real'], label: '绑定变量' } },
    actions: [],
    // render 里用 escapeHtml / varValue（白名单注入的），故意不写 import —— 自定义控件就该这么写
    renderSrc: `render(w, mode, vars) {
  const p = w.props;
  const v = varValue(w, vars);
  const pct = Math.max(0, Math.min(100, ((Number(v) || 0) - p.min) / ((p.max - p.min) || 1) * 100));
  return '<div class="w-' + w.type + '">' + escapeHtml(String(Math.round(pct))) + '%</div>';
}`,
    css: '.w-packgauge { color: #22c55e; }',
  };
  const def = pack.registerCustomDefChecked(custom);
  out.custom = {
    registered: !!registry.get('packgauge'),
    inList: registry.list().some(d => d.type === 'packgauge'),
    isBuiltin: pack.isBuiltin('packgauge'),
    smokeOk: true,
  };
  try { pack.smokeTestDef(def); } catch (e) { out.custom.smokeOk = false; out.custom.smokeErr = e.message; }

  /* ── ⑥ 用它画一个控件 → 导出：**defs 必须带上**（含 render 源码 + css） ── */
  const w2 = project.addWidget('packgauge', 200, 200);
  w2.bindings.variable = 'vPack';
  const p3 = JSON.parse(JSON.stringify(project.widgetExportPayload([w1.id, w2.id])));
  out.exportCustom = {
    widgets: p3.widgets.length,
    defs: p3.defs.map(d => d.type),
    hasRenderSrc: /^(?:function\s+)?render\s*\(/.test(p3.defs[0]?.renderSrc || ''),
    renderSrcSample: (p3.defs[0]?.renderSrc || '').slice(0, 24),
    hasCss: /packgauge/.test(p3.defs[0]?.css || ''),
    propsCount: (p3.defs[0]?.props || []).length,
    builtinNotIncluded: !p3.defs.some(d => d.type === 'button'),
  };

  /* ── ⑦ 带代码的包：不给 allowCode 就拒绝 ── */
  const rNoCode = project.importWidgetPack(p3);
  out.needCode = { ok: rNoCode.ok, saidCode: /代码/.test(rNoCode.reason || '') };

  /* ── ⑧ 给了 allowCode：定义 + 实例 + CSS + 记进工程 ── */
  const nC = cur().widgets.length;
  const r3 = project.importWidgetPack(p3, { allowCode: true });
  const importedCustom = cur().widgets.filter(w => w.type === 'packgauge');
  out.importCustom = {
    ok: r3.ok, added: r3.widgetsAdded, defsAdded: r3.defsAdded,
    inProject: (project.data.customWidgets || []).some(d => d.type === 'packgauge'),
    instances: importedCustom.length, delta: cur().widgets.length - nC,
    // ⚠ CSS 是从 CSSOM 里取的（r.cssText），浏览器会把 #22c55e 规范化成 rgb(34, 197, 94) ——
    //    所以这里只认"选择器和属性还在"，不抠颜色字面量
    cssInjected: (() => {
      const el = document.getElementById('wd-css-packgauge');
      return !!el && /\.w-packgauge/.test(el.textContent) && /color/.test(el.textContent);
    })(),
    cssDebug: [...document.querySelectorAll('style[data-def-css]')].map(s => `${s.id}:${s.textContent.length}`),
    renders: (() => { try { return renderWidgetDOM(importedCustom[0], 'run', { get: () => 50 }).innerHTML; } catch (e) { return 'ERR:' + e.message; } })(),
  };

  /* ── ⑨ 坏定义：语法错 / 引用了不存在的 helper → 逐条报错 + 回滚（不留半成品） ── */
  const bad = pack.registerPackDefs([
    { type: 'packsyntax', renderSrc: 'render( { 这不是函数 }' },
    { type: 'packref', renderSrc: 'render(w) { return 根本没有这个helper(1); }' },
  ]);
  out.badDefs = {
    failedCount: bad.failed.length,
    syntaxReported: bad.failed.some(f => f.startsWith('packsyntax')),
    refReported: bad.failed.some(f => f.startsWith('packref')),
    rolledBackSyntax: !registry.get('packsyntax'),
    rolledBackRef: !registry.get('packref'),
  };
  // 坏定义的实例不许进画面（进去就是一块渲染不出来的空白）
  const pBad = { app: 'hmi-designer', kind: 'widgets', version: 1, widgets: [{ id: 'x1', type: 'packref', name: '坏控件', x: 0, y: 0, w: 50, h: 20, z: 1, props: {}, bindings: {}, actions: [] }], variables: [], defs: [], pageRefs: {} };
  const rBad = project.importWidgetPack(pBad);
  out.badInstance = { ok: rBad.ok, added: rBad.widgetsAdded, skipped: (rBad.widgetsSkipped || []).length, warned: (rBad.warnings || []).some(w => w.includes('跳过了')) };

  /* ── ⑩ 不许覆盖内置类型 ── */
  const rOverride = project.importWidgetPack({
    app: 'hmi-designer', kind: 'widgets', version: 1,
    widgets: [{ id: 'x2', type: 'button', name: '假按钮', x: 0, y: 0, w: 60, h: 30, z: 1, props: { text: '假的' }, bindings: {}, actions: [] }],
    variables: [], pageRefs: {},
    defs: [{ type: 'button', title: '假按钮', defaults: {}, props: [], binding: {}, actions: [], renderSrc: 'render() { return "<b>假的</b>"; }' }],
  }, { allowCode: true });
  out.override = {
    ok: rOverride.ok,
    skippedDef: (rOverride.defsSkipped || []).includes('button'),
    builtinIntact: registry.get('button').title === '按钮',
    // 实例本身是内置 button，照常能进来（只是定义没被换掉）
    instanceAdded: rOverride.widgetsAdded === 1,
  };

  /* ── ⑪ 定义跟着工程走：normalize 会把工程里的自定义控件注册回来 ── */
  const custom2 = { ...custom, type: 'packgauge2', title: '包内仪表2' };
  const dataCopy = JSON.parse(JSON.stringify(project.data));
  // 追加而不是覆盖 —— 模拟真实的"工程越用越多"，也保证刷新后 packgauge 的定义还在
  dataCopy.customWidgets = [...(dataCopy.customWidgets || []), custom2];
  dataCopy.pages[0].widgets.push({ id: 'wPG2', type: 'packgauge2', name: '自带控件', x: 5, y: 5, w: 100, h: 30, z: 99, props: { min: 0, max: 100 }, bindings: {}, actions: [] });
  const hadBefore = !!registry.get('packgauge2');
  project.replaceData(dataCopy);
  const wPG2 = project.getWidget('wPG2');
  out.projectDefs = {
    hadBefore,
    registeredByNormalize: !!registry.get('packgauge2'),
    widgetRenders: (() => { try { return renderWidgetDOM(wPG2, 'edit', { get: () => 25 }).innerHTML; } catch (e) { return 'ERR:' + e.message; } })(),
  };

  /* ── ⑫ 不是控件包的文件要给出人话原因 ── */
  out.reject = {
    projectFile: project.importWidgetPack({ pages: [{ id: 'p', name: 'x', widgets: [] }] }).reason || '',
    empty: project.importWidgetPack({ app: 'hmi-designer', kind: 'widgets' }).reason || '',
    wrongKind: project.importWidgetPack({ kind: 'page', widgets: [{ type: 'button' }] }).reason || '',
  };

  out.helperBagMissing = pack.missingHelpers();
  return out;
});

/* ══════════ 断言 ══════════ */
ok('控件包格式正确（kind/version/widgets/变量/无代码）',
  R.builtin.kind === 'widgets' && R.builtin.version === 1 && R.builtin.widgets === 1
  && R.builtin.vars.includes('vPack') && R.builtin.defs === 0 && R.builtin.hasPageName,
  JSON.stringify(R.builtin));

ok('导入内置控件：类型/属性/绑定/动作 全部一致',
  R.import1.ok && R.import1.added === 1 && R.import1.typeSame && R.import1.propsSame
  && R.import1.bindSame && R.import1.actSame, JSON.stringify(R.import1));
ok('导入的控件是新 id、z 在最上层、整体挪了 +16', R.import1.newId && R.import1.zTop && R.import1.geomMoved);
ok('同名变量不重复添加（用现有的）', R.import1.varsNoDup && R.import1.varsKept === 1 && R.import1.varsAdded === 0,
  `kept=${R.import1.varsKept} added=${R.import1.varsAdded}`);
ok('一步 Ctrl+Z 把整批导入撤销回去', R.undo.backToOriginal && R.undo.stillHasBtn);
ok('包里缺变量定义 → 提醒但控件照样进来', R.missingVar.ok && R.missingVar.added === 1 && R.missingVar.warned);

ok('自定义控件能注册、冒烟渲染通过、不算内置', R.custom.registered && R.custom.inList && !R.custom.isBuiltin && R.custom.smokeOk,
  R.custom.smokeErr || '');
ok('导出选中控件时：自定义控件的 defs 跟着走（render 源码 + css），内置的不带',
  R.exportCustom.widgets === 2 && R.exportCustom.defs.length === 1 && R.exportCustom.hasRenderSrc
  && R.exportCustom.hasCss && R.exportCustom.propsCount === 3 && R.exportCustom.builtinNotIncluded,
  JSON.stringify(R.exportCustom));
ok('带代码的包不给 allowCode 一律拒绝', R.needCode.ok === false && R.needCode.saidCode, R.needCode.ok === false ? '' : '居然放行了');
ok('给了 allowCode：定义注册 + 实例导入 + CSS 注入 + 记进工程',
  R.importCustom.ok && R.importCustom.defsAdded.includes('packgauge') && R.importCustom.inProject
  && R.importCustom.delta === 2 && R.importCustom.cssInjected, JSON.stringify(R.importCustom));
ok('重建出来的 render 真的能跑（白名单 helper 注入到位）',
  /%$|%\s*$/.test(String(R.importCustom.renders).trim()) || /\d+%/.test(String(R.importCustom.renders)),
  String(R.importCustom.renders).slice(0, 120));
ok('坏定义被拒（语法错 / 引用了不存在的 helper）且不留半成品',
  R.badDefs.failedCount === 2 && R.badDefs.syntaxReported && R.badDefs.refReported
  && R.badDefs.rolledBackSyntax && R.badDefs.rolledBackRef, JSON.stringify(R.badDefs));
ok('没有对应类型的控件实例被跳过（不会变成一块渲染不出来的空白）',
  R.badInstance.ok && R.badInstance.added === 0 && R.badInstance.skipped === 1 && R.badInstance.warned);
ok('包里想覆盖内置类型 → 忽略定义、内置控件不受影响',
  R.override.skippedDef && R.override.builtinIntact && R.override.instanceAdded, JSON.stringify(R.override));
ok('定义跟着工程走：replaceData 后注册表里就有了，控件渲染得出来',
  !R.projectDefs.hadBefore && R.projectDefs.registeredByNormalize && /\d+%/.test(R.projectDefs.widgetRenders),
  R.projectDefs.widgetRenders.slice(0, 80));
ok('不是控件包的文件给出人话原因',
  /整份工程/.test(R.reject.projectFile) && /没有控件/.test(R.reject.empty) && /不是控件包|不像控件包/.test(R.reject.wrongKind),
  JSON.stringify(R.reject));
ok('渲染白名单里的 helper 全部到位（缺一个 = 别人的控件一渲染就 ReferenceError）',
  R.helperBagMissing.length === 0, R.helperBagMissing.join(','));
ok('浏览器无页面错误', errs.length === 0, errs.slice(0, 3).join(' | '));

/* ── ⑬ 刷新页面（= 明天再打开这份工程）：自定义控件**还在控件栏里**、画布上照样渲染得出来 ──
     这条是"定义跟着工程走"最直观的后果，也是最容易只做了一半的地方：
     注册进去了但控件栏不重建（或者反过来），用户看到的就是"导入的控件找不到了"。 */
await sleep(1300);                                   // 等自动保存落盘（localStorage）
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(500);
const after = await page.evaluate(async () => {
  const items = [...document.querySelectorAll('#toolboxList .tb-item')];
  const { project } = window.app;
  const { registry } = await import('/js/widgets/registry.js');
  const { isBuiltin } = await import('/js/widgets/pack.js');
  const all = registry.list().filter(d => !d.hidden);
  return {
    count: items.length,
    labels: items.map(i => i.textContent.trim().split('\n')[0]),
    withBadge: items.filter(i => i.querySelector('.tb-badge')).map(i => i.textContent.trim().split('\n')[0]),
    onCanvas: document.querySelectorAll('#canvas .wd-packgauge, #canvas .wd-packgauge2').length,
    builtinStillThere: items.some(i => /按钮/.test(i.textContent)),
    canvasAll: document.querySelectorAll('#canvas .wd').length,
    currentId: project.currentId,
    // 控件栏条数不该写死（加控件是正常开发动作）：和注册表实时对，可见内置 + 自定义
    visibleBuiltin: all.filter(d => isBuiltin(d.type)).length,
    visibleCustom: all.filter(d => !isBuiltin(d.type)).length,
    pages: project.pages().map(p => ({ name: p.name, id: p.id, custom: p.widgets.filter(w => /packgauge/.test(w.type)).length, total: p.widgets.length })),
  };
});
ok('刷新后自定义控件仍在控件栏里（带「包」角标）',
  after.withBadge.length >= 1 && after.count > after.visibleBuiltin,
  `${after.count} 条（内置可见 ${after.visibleBuiltin}）· 带角标：${after.withBadge.join('、')}`);
ok('控件栏 = 可见内置 + 自定义（内置一个不少，自定义排在后面）',
  after.builtinStillThere && after.count === after.visibleBuiltin + after.visibleCustom,
  after.labels.join(' / ').slice(0, 160));
ok('刷新后画布上的自定义控件照样渲染得出来（不是一块空白）', after.onCanvas >= 1, String(after.onCanvas));

/* ── ⑭ 工程里混进一个"本机没有定义"的控件类型：**不许把整页渲染打断** ──
     以前 def.render 会直接抛 → 画布只画到它前面那几个就停了，后面的控件连看都看不见、更删不掉。
     现在应该：整页照样画完 + 那个控件画成看得见/选得中/删得掉的占位 + 属性面板说清原因和办法。 */
const unk = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { select } = await import('/js/editor/canvas.js');
  const p = project.currentPage();
  // 故意插在**中间**：要的就是"后面的控件不许被截断"
  p.widgets.splice(2, 0, { id: 'wUnknown1', type: 'zzz_nonexistent', name: '幽灵控件', x: 10, y: 10, w: 90, h: 30, z: 5, props: {}, bindings: {}, actions: [] });
  project.commit('测试：未知控件');
  const last = p.widgets[p.widgets.length - 1];
  const out = {
    total: p.widgets.length,
    canvasCount: document.querySelectorAll('#canvas .wd').length,
    unknownCount: document.querySelectorAll('#canvas .wd-unknown').length,
    placeholder: (document.querySelector('#canvas .wd-unknown')?.textContent || '').trim(),
    lastRendered: !!document.querySelector(`#canvas .wd[data-id="${last.id}"]`),
  };
  select(['wUnknown1']);
  await new Promise(r => setTimeout(r, 200));
  out.panel = document.getElementById('propBody')?.textContent || '';
  return out;
});
ok('没有定义的控件类型不再把整页渲染打断（插在中间也不截断）',
  unk.canvasCount === unk.total && unk.lastRendered, JSON.stringify({ total: unk.total, canvasCount: unk.canvasCount, lastRendered: unk.lastRendered }));
ok('未知控件画成看得见/选得中/删得掉的占位', unk.unknownCount === 1 && /未知控件/.test(unk.placeholder), unk.placeholder.slice(0, 40));
ok('选中未知控件时属性面板说清"为什么"和"怎么办"', /在本机没有定义/.test(unk.panel) && /导入控件包/.test(unk.panel),
  unk.panel.replace(/\s+/g, ' ').slice(0, 120));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

const bad = results.filter(r => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
