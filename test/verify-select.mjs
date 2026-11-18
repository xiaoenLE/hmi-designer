// verify-select.mjs — 下拉框（组合框）控件：自绘弹层、选项行高可调、运行时选择写变量
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);
// 本套件假设后端是内存模拟：先把可能残留的 PLC/OPC UA 连接断掉（
// 否则写入会被后端按「变量未声明/设备离线」拒掉，而界面现在会如实回滚成设备的真实值）
await page.evaluate(() => fetch('/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) }).catch(() => {}));
await page.waitForTimeout(200);
await page.waitForTimeout(200);

/* ── A. 注册 / 工具箱 / 选项解析 ── */
const meta = await page.evaluate(async () => {
  const r = await import('/js/widgets/registry.js');
  const u = await import('/js/core/utils.js');
  const d = r.registry.get('select');
  return {
    has: !!d, title: d?.title, hidden: !!d?.hidden, defH: d?.defaults?.h,
    operate: d?.defaults?.operate, colorOn: d?.defaults?.stateColorOn,
    toolbox: [...document.querySelectorAll('#toolboxList .tb-item')].some(el => el.textContent?.includes('下拉框')),
    opts: u.parseOptions('手动=0\n自动=1\n点动=2'),
    opts2: u.parseOptions('启动\n停止\n\n   \n'),
    colored: u.parseOptions('手动=0=#3b82f6\n自动=1=#22c55e\n停止'),
    onlyColor: u.parseOptions('启动=#22c55e'),                    // 没写值也能接颜色（值就是文字本身）
    notColor: u.parseOptions('模式=red\n亮度=#12\n转速=12'),        // 颜色名/半截 #12 都不当颜色
    num: u.optionIndexByValue(u.parseOptions('a=1\nb=2'), 2),
    str: u.optionIndexByValue(u.parseOptions('a=1\nb=2'), '2'),
    modes: [u.comboMode({ operate: 'view' }), u.comboMode({ operate: 'type' }), u.comboMode({}),
      u.comboMode({ readonly: true }), u.comboMode({ readonly: false })],
    contrast: [u.contrastTextOn('#dc2626'), u.contrastTextOn('#ef4444'), u.contrastTextOn('#f59e0b'),
      u.contrastTextOn('#94a3b8'), u.contrastTextOn('rgb(20,20,20)'), u.contrastTextOn('hsl(1,2%,3%)'), u.contrastTextOn('')],
    sc1: u.setOptionColor('手动=0\n自动=1', 1, '#22c55e'),
    sc2: u.setOptionColor('手动=0=#3b82f6\n停止\n默认', 0, ''),
    sc3: u.setOptionColor('启动\n停止\n点动', 2, '#f59e0b'),
  };
});
ok('下拉框控件已注册、在工具箱里、默认高 44', meta.has && meta.title === '下拉框' && !meta.hidden && meta.toolbox && meta.defH === 44,
  JSON.stringify([meta.title, meta.toolbox, meta.defH]));
ok('默认操作方式=只能选、状态色用在=背景（文字自动黑/白）', meta.operate === 'pick' && meta.colorOn === 'contrast',
  JSON.stringify([meta.operate, meta.colorOn]));
ok('选项解析：显示文字=值', JSON.stringify(meta.opts) === JSON.stringify([
  { label: '手动', value: 0, color: '' }, { label: '自动', value: 1, color: '' }, { label: '点动', value: 2, color: '' }]), JSON.stringify(meta.opts));
ok('选项解析：不写值就写文字本身（空行/纯空格行忽略）',
  JSON.stringify(meta.opts2) === JSON.stringify([
    { label: '启动', value: '启动', color: '' }, { label: '停止', value: '停止', color: '' }]), JSON.stringify(meta.opts2));
ok('选项解析：第三段是状态色（文字=值=颜色）',
  JSON.stringify(meta.colored) === JSON.stringify([
    { label: '手动', value: 0, color: '#3b82f6' }, { label: '自动', value: 1, color: '#22c55e' },
    { label: '停止', value: '停止', color: '' }]), JSON.stringify(meta.colored));
ok('选项解析：不写值也能只给颜色（启动=#22c55e）',
  JSON.stringify(meta.onlyColor) === JSON.stringify([{ label: '启动', value: '启动', color: '#22c55e' }]), JSON.stringify(meta.onlyColor));
ok('颜色名 / 半截颜色码不当颜色（还按值处理，老工程选项表行为不变）',
  JSON.stringify(meta.notColor) === JSON.stringify([
    { label: '模式', value: 'red', color: '' }, { label: '亮度', value: '#12', color: '' },
    { label: '转速', value: 12, color: '' }]), JSON.stringify(meta.notColor));
ok('按值找选中项（数字/字符串都认）', meta.num === 1 && meta.str === 1, `${meta.num} / ${meta.str}`);
ok('操作方式：view/type 认，缺键回落 readonly（老工程）',
  JSON.stringify(meta.modes) === JSON.stringify(['view', 'type', 'pick', 'view', 'pick']), JSON.stringify(meta.modes));
ok('底色自动配文字：深色底配白字、浅色底配黑字、认不出的写法交回自己那份文字色',
  JSON.stringify(meta.contrast) === JSON.stringify(['#ffffff', '#1f2329', '#1f2329', '#1f2329', '#ffffff', '', '']),
  JSON.stringify(meta.contrast));
ok('设状态色：只改点名那一行，其它行原样',
  meta.sc1 === '手动=0\n自动=1=#22c55e', JSON.stringify(meta.sc1));
ok('清状态色：那一行变回「文字=值」',
  meta.sc2 === '手动=0\n停止\n默认', JSON.stringify(meta.sc2));
ok('给没写值的选项设色：补成「文字=颜色」（值本来就是文字）',
  meta.sc3 === '启动\n停止\n点动=#f59e0b', JSON.stringify(meta.sc3));

/* ── 建控件 ── */
const ids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.pages[0].widgets.length = 0;
  m.project.data.variables.length = 0;
  m.project.addVariable();
  m.project.updateVariable('var1', { name: 'iMode', type: 'int', value: 0 });
  const w = m.project.addWidget('select', 60, 60);
  m.project.updateWidgetField(w.id, 'bindings.variable', 'iMode');
  m.project.commit('下拉框测试');
  return { w: w.id };
});
await page.waitForTimeout(250);

const combo = (where) => page.evaluate(([sel, wid]) => {
  const c = document.querySelector(`${sel} .wd[data-id="${wid}"] .w-combo`);
  if (!c) return null;
  const pop = c.querySelector('.w-combo-pop');
  const items = [...c.querySelectorAll('.w-combo-item')];
  return {
    cur: c.querySelector('.w-combo-cur')?.textContent,
    open: c.classList.contains('open'),
    ro: c.classList.contains('ro'), edit: c.classList.contains('edit'),
    items: items.map(i => i.textContent),
    typerowOn: !!c.querySelector('.w-combo-typerow'),
    dots: items.map(i => {
      const d = i.querySelector('.w-combo-dot');
      return d ? getComputedStyle(d).backgroundColor : null;
    }),
    itemH: items[0] ? Math.round(items[0].getBoundingClientRect().height) : 0,
    popDisplay: getComputedStyle(pop).display,
    popMaxH: Math.round(parseFloat(getComputedStyle(pop).maxHeight)),
    popOverflow: getComputedStyle(pop).overflowY,
    hasNativeSelect: !!c.querySelector('select'),
    popTop: Math.round(pop.getBoundingClientRect().top),
    widgetBottom: Math.round(c.getBoundingClientRect().bottom),
  };
}, [where, ids.w]);

// 编辑态：不能展开（点击留给画布拖动）
let c = await combo('#canvas');
ok('编辑态渲染成自绘下拉（没有原生 select），默认 3 项',
  c && !c.hasNativeSelect && c.items.length === 3 && c.items[0] === '手动', JSON.stringify([c?.items, c?.hasNativeSelect]));
ok('编辑态带 edit 标记（点击不展开，不挡画布拖动）', c.edit === true && c.open === false, JSON.stringify([c.edit, c.open]));
ok('关闭时弹层不显示', c.popDisplay === 'none', c.popDisplay);

/* ── B. 运行态：点方框展开 → 弹层在控件下方、行高可控 ── */
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
// 运行画面会按窗口等比例缩放（适应窗口），量屏幕像素时要乘上这个比例
const pageScale = () => page.evaluate(async ([wid]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"]`);
  const w = (await import('/js/core/project.js')).project.getWidget(wid);
  return el && w ? el.getBoundingClientRect().height / w.h : 1;
}, [ids.w]);
let sc = await pageScale();
const box = await page.locator(`#rtPage .wd[data-id="${ids.w}"] .w-combo-box`).boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(250);
c = await combo('#rtPage');
ok('运行态点方框 → 展开选项列表', c.open === true && c.popDisplay === 'block', JSON.stringify([c.open, c.popDisplay]));
ok('弹层挂在控件正下方（top ≈ 控件底边）', Math.abs(c.popTop - c.widgetBottom) <= 8, `popTop=${c.popTop} widgetBottom=${c.widgetBottom}`);
ok('选项行高默认 36px（原生下拉改不了行高，自绘才行）', Math.abs(c.itemH - 36 * sc) <= 2, `${c.itemH}px（缩放 ${sc.toFixed(3)}）`);
ok('弹层可滚动（选项多时不会撑破画面）', c.popOverflow === 'auto', c.popOverflow);

/* 调高选项行高 → 运行画面按新配置重渲染后立即生效
   （运行态不会因为改属性而重绘，改了配置要重新进运行态，这也是真实现场的行为） */
const restartRun = async () => {
  await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
  await page.waitForTimeout(150);
  await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
  await page.waitForTimeout(400);
};
const setProp = async (k, v) => {
  await page.evaluate(async ([wid, key, val]) => {
    const m = await import('/js/core/project.js');
    m.project.updateWidgetProp(wid, key, val);
    m.project.commit('改属性');
  }, [ids.w, k, v]);
};
const openBox = async () => {
  closeIfOpen();
  const b = await page.locator(`#rtPage .wd[data-id="${ids.w}"] .w-combo-box`).boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(220);
};
const isOpen = () => page.evaluate(([wid]) =>
  !!document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-combo.open`), [ids.w]);
const closeIfOpen = () => page.evaluate(([wid]) => {
  const c = document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-combo.open`);
  if (c) c.classList.remove('open', 'up');
}, [ids.w]);

await setProp('optionH', 56);
await restartRun();
sc = await pageScale();
await openBox();
c = await combo('#rtPage');
ok('把「选项行高」调到 56 → 选项真的变高了', Math.abs(c.itemH - 56 * sc) <= 2, `${c.itemH}px（缩放 ${sc.toFixed(3)}）`);

await setProp('maxRows', 2);
await restartRun();
await openBox();
c = await combo('#rtPage');
// 注意：maxHeight 是 CSS 逻辑像素（transform 缩放不改它），此处 optionH 仍是 56
ok('「最多显示几项 = 2」→ 弹层高度收到 2 行、可滚动',
  Math.abs(c.popMaxH - 2 * 56) <= 4 && c.popOverflow === 'auto', `maxH=${c.popMaxH}（预期 ${2 * 56}）overflow=${c.popOverflow}`);
ok('弹层被限高时内容仍在（3 个选项，靠滚动看第 3 个）',
  await page.evaluate(([wid]) => document.querySelectorAll(`#rtPage .wd[data-id="${wid}"] .w-combo-item`).length === 3, [ids.w]));
await setProp('maxRows', 6);
await setProp('optionH', 36);
await restartRun();

/* ── C. 选一项 → 写变量（写的是选项值），弹层自动收起 ── */
const pick = async (idx) => {
  const b = await page.locator(`#rtPage .wd[data-id="${ids.w}"] .w-combo-item`).nth(idx).boundingBox();
  if (!b) throw new Error(`选项 ${idx} 不在可见区域（弹层没展开或被裁）`);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(250);
};
await openBox();
await pick(1);
let v = await page.evaluate(async () => window.app.varStore.get('iMode'));
c = await combo('#rtPage');
ok('选「自动」→ 变量写成选项值 1', v === 1, String(v));
ok('选完弹层自动收起，控件显示「自动」', c.open === false && c.cur === '自动', JSON.stringify([c.open, c.cur]));
ok('选中的那一项带 on 高亮', await page.evaluate(([wid]) => {
  const its = [...document.querySelectorAll(`#rtPage .wd[data-id="${wid}"] .w-combo-item`)];
  return its[1].classList.contains('on') && !its[0].classList.contains('on');
}, [ids.w]));
await openBox();
await pick(2);
v = await page.evaluate(async () => window.app.varStore.get('iMode'));
ok('选「点动」→ 变量写成 2', v === 2, String(v));

/* ── D. 点别处 / Esc 收起；变量外部变化跟着走 ── */
await openBox();
await page.mouse.click(900, 700);
await page.waitForTimeout(200);
c = await combo('#rtPage');
ok('点画布别处 → 弹层收起', c.open === false, String(c.open));
await openBox();
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
c = await combo('#rtPage');
ok('按 Esc 先收弹层（不退出运行）', c.open === false && await page.evaluate(() => !document.getElementById('runtimeRoot').classList.contains('hidden')), String(c.open));
await page.evaluate(async () => { window.app.varStore.set('iMode', 0, 'remote'); });
await page.waitForTimeout(250);
c = await combo('#rtPage');
ok('变量被外部改成 0 → 控件显示「手动」', c.cur === '手动', c.cur);
await page.evaluate(async () => { window.app.varStore.set('iMode', 99, 'remote'); });
await page.waitForTimeout(250);
c = await combo('#rtPage');
ok('变量值不在选项里 → 显示「--（当前 99）」', c.cur === '--（当前 99）', c.cur);
ok('值不在选项里时没有任何一项被选中',
  await page.evaluate(([wid]) => !document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-combo-item.on`), [ids.w]));

/* ── E. 写值方式：序号 0 / 序号 1 ── */
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'valueMode', 'index1');
  m.project.commit('改写值方式');
}, [ids.w]);
await page.waitForTimeout(250);
await openBox();
await pick(0);
v = await page.evaluate(async () => window.app.varStore.get('iMode'));
ok('写值方式=序号(从1)：选第 1 项 → 变量写成 1', v === 1, String(v));
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'valueMode', 'index0');
  m.project.commit('改回序号0');
}, [ids.w]);
await page.waitForTimeout(250);
await openBox();
await pick(2);
v = await page.evaluate(async () => window.app.varStore.get('iMode'));
ok('写值方式=序号(从0)：选第 3 项 → 变量写成 2', v === 2, String(v));

/* ── F. 只读：点方框不展开，但仍显示当前项 ── */
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(200);
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'valueMode', 'value');
  m.project.updateWidgetProp(wid, 'readonly', true);
  m.project.commit('只读');
}, [ids.w]);
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
await page.evaluate(async () => { window.app.varStore.set('iMode', 2, 'remote'); });
await page.waitForTimeout(250);
await openBox();
c = await combo('#rtPage');
ok('只读：显示当前项「点动」且点击不展开', c.cur === '点动' && c.open === false && c.ro === true,
  JSON.stringify([c.cur, c.open, c.ro]));

/* ── G. 字符串变量：写文字本身 ── */
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(200);
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.addVariable();
  m.project.updateVariable('var2', { name: 'sMode', type: 'string', value: '' });
  m.project.updateWidgetField(wid, 'bindings.variable', 'sMode');
  m.project.updateWidgetProp(wid, 'readonly', false);
  m.project.updateWidgetProp(wid, 'items', '启动\n停止');
  m.project.commit('字符串下拉');
}, [ids.w]);
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
await openBox();
await pick(1);
v = await page.evaluate(async () => window.app.varStore.get('sMode'));
ok('字符串变量：选「停止」→ 变量写成字符串 "停止"', v === '停止', JSON.stringify(v));

/* ── H. 属性面板 ── */
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(200);
await page.evaluate(async ([wid]) => (await import('/js/editor/canvas.js')).select([wid]), [ids.w]);
await page.waitForTimeout(250);
const panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.find(r => r.querySelector('.f-label')?.textContent.trim() === t);
  return {
    labels: ['选项', '状态颜色', '状态色用在', '操作方式', '写值方式', '选项行高', '最多显示几项', '无匹配显示'].filter(t => !!byLabel(t)),
    items: byLabel('选项')?.querySelector('textarea')?.value,
    hasBind: !!document.querySelector('#propBody [data-bind="variable"]'),
  };
});
ok('属性面板有：选项/状态颜色/状态色用在/操作方式/写值方式/选项行高/最多显示几项/无匹配显示',
  panel.labels.length === 8, JSON.stringify(panel.labels));
ok('「选项」多行框回显当前内容', panel.items === '启动\n停止', JSON.stringify(panel.items));
const areaBox = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const ta = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '选项')?.querySelector('textarea');
  const cs = ta ? getComputedStyle(ta) : null;
  return ta ? { h: Math.round(ta.getBoundingClientRect().height), cssH: cs.height } : null;
});
ok('「选项」多行框固定 200px 高', areaBox && areaBox.h === 200 && areaBox.cssH === '200px', JSON.stringify(areaBox));
ok('属性面板有数据绑定下拉', panel.hasBind === true, String(panel.hasBind));

/* ── I. 状态颜色：每个状态一个色块，写回「选项」各行（单一数据源） ── */
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'items', '手动=0\n自动=1\n点动=2');
  m.project.commit('清成无色');
}, [ids.w]);
await page.waitForTimeout(200);
await page.evaluate(async ([wid]) => (await import('/js/editor/canvas.js')).select([wid]), [ids.w]);
await page.waitForTimeout(250);
let scRows = await page.evaluate(() => [...document.querySelectorAll('#propBody .sc-row')].map(r => ({
  name: r.querySelector('.sc-name')?.textContent, has: r.classList.contains('has'), clr: !!r.querySelector('.sc-clr'),
})));
ok('「状态颜色」按选项列出每个状态（3 个状态 3 行，都没设色所以没有 ✕）',
  scRows.length === 3 && scRows.map(r => r.name).join('/') === '手动/自动/点动' && scRows.every(r => !r.has && !r.clr),
  JSON.stringify(scRows));
// 点色块选颜色（等于用户在取色器里选完）：写进「选项」那一行末尾
// input = 取色器里拖着就实时生效；change = 取色器关掉那一下（这时面板重画，✕ 才出来）
await page.evaluate(() => {
  const inp = document.querySelector('#propBody [data-statecolor="1"]');
  inp.value = '#22c55e';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(200);
let after = await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  return {
    items: m.project.getWidget(wid).props.items,
    area: document.querySelector('#propBody [data-prop="items"]')?.value,
    dot: !!document.querySelector('#propBody .sc-row.has .sc-clr'),
  };
}, [ids.w]);
ok('给「自动」选了绿色 → 写进选项行（自动=1=#22c55e）', after.items === '手动=0\n自动=1=#22c55e\n点动=2', JSON.stringify(after.items));
ok('「选项」文本框同步显示（颜色就存在这一份选项表里，不另存一张表）', after.area === after.items, JSON.stringify(after.area));
ok('设过色的那一行出现 ✕（可以清掉）', after.dot === true, String(after.dot));
// ✕ 清色
await page.evaluate(() => document.querySelector('#propBody [data-stateclear="1"]').click());
await page.waitForTimeout(200);
after = await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  return { items: m.project.getWidget(wid).props.items, clr: !!document.querySelector('#propBody [data-stateclear="1"]') };
}, [ids.w]);
ok('点 ✕ → 这个状态的颜色没了（那一行恢复原样）', after.items === '手动=0\n自动=1\n点动=2', JSON.stringify(after.items));
ok('清完 ✕ 也跟着消失', after.clr === false, String(after.clr));

/* ── J. 状态色在画布/运行画面上真的生效（背景＋自动文字 / 背景 / 文字 三种用法） ── */
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'items', '手动=0=#dc2626\n自动=1=#22c55e\n点动=2=#f59e0b');
  m.project.updateWidgetField(wid, 'bindings.variable', 'iMode');
  m.project.commit('带状态色');
}, [ids.w]);
const setColorOn = async (v) => {
  await page.evaluate(async ([wid, val]) => {
    const m = await import('/js/core/project.js');
    if (val === null) delete m.project.getWidget(wid).props.stateColorOn;   // 删掉键 = 用默认值
    else m.project.updateWidgetProp(wid, 'stateColorOn', val);
    m.project.commit('改状态色用在');
  }, [ids.w, v]);
  await page.waitForTimeout(200);
};
const setVar = async (n) => {
  await page.evaluate(async ([val]) => { window.app.varStore.set('iMode', val, 'remote'); }, [n]);
  await page.waitForTimeout(250);
};
const boxLook = () => page.evaluate(async ([sel, wid]) => {
  const c = document.querySelector(`${sel} .wd[data-id="${wid}"] .w-combo`);
  if (!c) return null;
  const cur = c.querySelector('.w-combo-cur');
  const its = [...c.querySelectorAll('.w-combo-item')];
  const dot = its[1]?.querySelector('.w-combo-dot');
  return {
    bg: getComputedStyle(c).backgroundColor,
    curColor: getComputedStyle(cur).color,
    itemColor: getComputedStyle(its[1]).color,
    dot: dot ? getComputedStyle(dot).backgroundColor : null,
    typerow: !!c.querySelector('.w-combo-typerow'),
  };
}, ['#canvas', ids.w]);
await setColorOn(null);
await setVar(0);
let look = await boxLook();
ok('状态色=背景（文字自动）：当前是「手动」→ 整块变它的深红 #dc2626', look.bg === 'rgb(220, 38, 38)', look.bg);
ok('状态色=背景（文字自动）：深色底自动配白字（要是还用自己那份深色文字色就看不见了）',
  look.curColor === 'rgb(255, 255, 255)', look.curColor);
await setVar(2);
look = await boxLook();
ok('状态色=背景（文字自动）：浅色底（黄）自动配黑字', look.bg === 'rgb(245, 158, 11)' && look.curColor === 'rgb(31, 35, 41)',
  JSON.stringify([look.bg, look.curColor]));
ok('弹层里每个状态前面有个色块（弹层恒定浅底，不铺满，只点一下颜色）', look.dot === 'rgb(34, 197, 94)', String(look.dot));
ok('「只能选」时选项列表末尾没有手动输入那一行', look.typerow === false, String(look.typerow));
await setColorOn('bg');
await setVar(0);
look = await boxLook();
ok('状态色=背景（用上面的文字色）：底色照旧变红，文字色还是自己设的那个',
  look.bg === 'rgb(220, 38, 38)' && look.curColor === 'rgb(31, 35, 41)', JSON.stringify([look.bg, look.curColor]));
await setColorOn('text');
await setVar(1);
look = await boxLook();
ok('状态色=文字：底色回到自己的背景色，文字变绿', look.bg === 'rgb(255, 255, 255)' && look.curColor === 'rgb(34, 197, 94)',
  JSON.stringify([look.bg, look.curColor]));
ok('状态色=文字：弹层里那一项的文字也是它的颜色', look.itemColor === 'rgb(34, 197, 94)', look.itemColor);
await setColorOn('bg');
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'items', '手动=0\n自动=1\n点动=2');
  m.project.commit('回到无色');
}, [ids.w]);
await page.waitForTimeout(200);

/* ── K. 操作方式：只显示状态 / 只能选 / 可选也可输入 ── */
const setOperate = async (v) => {
  await page.evaluate(async ([wid, val]) => {
    const m = await import('/js/core/project.js');
    m.project.updateWidgetProp(wid, 'operate', val);
    m.project.commit('改操作方式');
  }, [ids.w, v]);
};
// 只显示状态：不展开、没有小三角（当状态显示用）
await setOperate('view');
await restartRun();
await page.evaluate(async () => { window.app.varStore.set('iMode', 2, 'remote'); });
await page.waitForTimeout(250);
await openBox();
c = await combo('#rtPage');
ok('操作方式=只显示状态：显示当前项、点不开、连小三角都不画',
  c.cur === '点动' && c.open === false && c.ro === true
  && await page.evaluate(([wid]) => !document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-combo-car`), [ids.w]),
  JSON.stringify([c.cur, c.open, c.ro]));
// 可选也可输入：列表末尾多一行「✎ 输入…」，点了开软键盘，填的值直接写进变量
await setOperate('type');
await restartRun();
await openBox();
c = await combo('#rtPage');
ok('操作方式=可选也可输入：列表末尾多一行「✎ 输入…」', c.typerowOn === true, String(c.typerowOn));
const padShown = () => page.evaluate(() => !document.getElementById('numPad').classList.contains('hidden'));
// 行高/项数放开一点，免得输入那一行被弹层限高挡在可视区外
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'maxRows', 8);
  m.project.commit('多显示几项');
}, [ids.w]);
await restartRun();
await openBox();
const tr = await page.locator(`#rtPage .wd[data-id="${ids.w}"] .w-combo-typerow`).boundingBox();
await page.mouse.click(tr.x + tr.width / 2, tr.y + tr.height / 2);
await page.waitForTimeout(300);
ok('点「✎ 输入…」→ 打开软键盘（触摸屏没有系统输入法，只能走页面里这套）', await padShown());
ok('弹层同时收起来了（不跟键盘叠在一起）', !(await isOpen()));
await page.locator('#npKeys [data-k="clear"]').click();
await page.locator('#npKeys [data-k="7"]').click();
await page.locator('#npKeys [data-k="ok"]').click();
await page.waitForTimeout(300);
let typed = await page.evaluate(async () => ({
  v: window.app.varStore.get('iMode'), pad: !document.getElementById('numPad').classList.contains('hidden'),
}));
ok('键盘里填 7 点确定 → 变量写成 7（不在选项里也行）', typed.v === 7, JSON.stringify(typed));
ok('确定后键盘自动收起', typed.pad === false, String(typed.pad));
c = await combo('#rtPage');
ok('可输入模式下值不在选项里就直接显示这个值（不再显示「--（当前 7）」）', c.cur === '7', c.cur);
// 只能选：那一行不画，点击也不回落到键盘
await setOperate('pick');
await restartRun();
await openBox();
c = await combo('#rtPage');
ok('操作方式=只能选：没有「✎ 输入…」那一行', c.typerowOn === false, String(c.typerowOn));
await page.evaluate(async () => { window.app.varStore.set('iMode', 99, 'remote'); });
await page.waitForTimeout(250);
c = await combo('#rtPage');
ok('只能选模式下值不在选项里 → 还是显示「--（当前 99）」（老行为不变）', c.cur === '--（当前 99）', c.cur);
await page.evaluate(async () => { window.app.varStore.set('iMode', 0, 'remote'); });
await restartRun();

/* ── L. 老工程迁移：readonly 勾 → 操作方式 ── */
const migrated = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const mk = (props) => ({ id: '', type: 'select', x: 0, y: 0, w: 100, h: 40, props, bindings: {}, actions: [] });
  m.project.replaceData({
    meta: {}, variables: [], alarms: [],
    pages: [{ id: 'pg-mig', name: '迁移页', type: 'page', widgets: [
      mk({ items: 'a=0\nb=1', readonly: true }),                  // 老工程：只显示不可选
      mk({ items: 'a=0\nb=1', readonly: false }),                 // 老工程：可选
      mk({ items: 'a=0\nb=1', operate: 'type', readonly: true }), // 已经迁过的：以 operate 为准
    ] }],
  });
  const ws = m.project.data.pages[0].widgets;
  return ws.map(w => ({ operate: w.props.operate, ro: 'readonly' in w.props }));
});
ok('老工程的「只显示不可选」→ 操作方式=只显示状态（顺手删掉老键，面板上不留两处开关）',
  JSON.stringify(migrated) === JSON.stringify([
    { operate: 'view', ro: false }, { operate: 'pick', ro: false }, { operate: 'type', ro: false }]),
  JSON.stringify(migrated));
// 老脚本/老套件还在写 readonly 的情况：转成 operate（属性面板只有一处开关，但不能让它静默失效）
const shim = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const id = m.project.data.pages[0].widgets[1].id;
  m.project.updateWidgetProp(id, 'readonly', true);
  const a = { operate: m.project.getWidget(id).props.operate, ro: 'readonly' in m.project.getWidget(id).props };
  m.project.updateWidgetProp(id, 'readonly', false);
  return { a, b: m.project.getWidget(id).props.operate };
});
ok('直接写 readonly（老脚本）也照样生效：true→只显示状态，false→回到只能选',
  shim.a.operate === 'view' && shim.a.ro === false && shim.b === 'pick', JSON.stringify(shim));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 下拉框（组合框）回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
