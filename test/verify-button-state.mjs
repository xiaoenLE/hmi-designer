// 一次性验证：按钮状态显示（bool 开关 / 数值比较 / 运行时联动）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });

/* 后端隔离：stub 掉 probe 强制「本地模拟」，防止 Python 后端残留变量
   （上次运行 writeVar 写入的 rSpd=12 会被 readVars 拉回，令 varStore.set 同值短路）
   ⚠ 只 stub probe 不够：后端若在 plc 模式而地址不通，写会失败 → varStore.push 里那条
   「写失败就按设备真实值 resync」把刚置上的值改回去（rSpd 永远读成 0）。
   本套件只管界面联动，把读写通道一起掐掉。 */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
  m.backend.readVar = async () => undefined;
}));

/* ── 准备：bool 变量 + 数值变量 + 两个状态按钮 ── */
const ids = await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.addVariable(); m.project.updateVariable('var1', { name: 'bRun', type: 'bool', value: false });
  m.project.addVariable(); m.project.updateVariable('var2', { name: 'rSpd', type: 'real', value: 0 });
  const mk = (patch, pos) => {
    const w = m.project.addWidget('button', pos, 40);
    m.project.updateWidgetField(w.id, 'bindings.variable', patch.bind);
    Object.entries(patch.props).forEach(([k, v]) => m.project.updateWidgetProp(w.id, k, v));
    return w.id;
  };
  const btnB = mk({ bind: 'bRun', props: {} }, 40);                        // bool：开/关
  const btnN = mk({ bind: 'rSpd', props: { op: '>=', threshold: '10' } }, 170); // 数值比较
  const btnP = mk({ bind: '', props: {} }, 300);                              // 未绑定
  const btnQ = mk({ bind: 'bRun', props: { showState: false, text: '静态文字' } }, 430);  // 旧字段映射到未满文字
  m.project.commit('测试按钮');
  return { btnB, btnN, btnP, btnQ };
})());
await page.waitForTimeout(200);

/** 用真实 def.render 取按钮文字与底色 */
const renderBtn = (wid, val) => page.evaluate(async ([wid, val]) => {
  const m = await import('/js/core/project.js');
  const r = await import('/js/widgets/registry.js');
  const w = m.project.getWidget(wid);
  const html = r.registry.get('button').render(w, 'run', { get: () => val });
  return { text: html.match(/>([^<]*)<\/button>/)?.[1], html };
}, [wid, val]);

/* ── A. bool 变量：开/关 ── */
let s = await renderBtn(ids.btnB, true);
ok('bool=true → 显示「开」', s.text === '开', s.text);
ok('bool=true → 底色为满足色(绿)', s.html.includes('#22c55e'), s.html.slice(0, 120));
s = await renderBtn(ids.btnB, false);
ok('bool=false → 显示「关」+ 未满足色', s.text === '关' && s.html.includes('#9ca3af'), s.text);

/* ── B. 数值比较 ── */
s = await renderBtn(ids.btnN, 12);
ok('数值 12 >= 10 → 开', s.text === '开', s.text);
s = await renderBtn(ids.btnN, 9);
ok('数值 9 >= 10 → 关', s.text === '关', s.text);

// 其余比较符
const cmp = async (op, thr, val) => {
  await page.evaluate(async ([wid, op, thr]) => {
    const m = await import('/js/core/project.js');
    const w = m.project.getWidget(wid);
    m.project.updateWidgetProp(wid, 'op', op);
    m.project.updateWidgetProp(wid, 'threshold', thr);
  }, [ids.btnN, op, thr]);
  return (await renderBtn(ids.btnN, val)).text;
};
ok('op== ：5==5 → 开', await cmp('==', '5', 5) === '开');
ok('op== ：6==5 → 关', await cmp('==', '5', 6) === '关');
ok('op!= ：6!=5 → 开', await cmp('!=', '5', 6) === '开');
ok('op> ：6>5 → 开', await cmp('>', '5', 6) === '开');
ok('op< ：4<5 → 开', await cmp('<', '5', 4) === '开');
ok('op<= ：6<=5 → 关', await cmp('<=', '5', 6) === '关');

// 字符串等值（把比较值设为非数字字符串）
ok('字符串 ==：AB==AB → 开', await cmp('==', 'AB', 'AB') === '开');
ok('字符串 ==：CD==AB → 关', await cmp('==', 'AB', 'CD') === '关');

/* ── C. 未绑定 / 旧字段兼容 ── */
s = await renderBtn(ids.btnP, null);
ok('未绑定变量 → 显示「未满文字」（默认 关）', s.text === '关', s.text);
s = await renderBtn(ids.btnQ, true);
ok('旧 showState:false 不再关闭条件显示（满足时显示满足文字）', s.text === '开', s.text);
s = await renderBtn(ids.btnQ, false);
ok('旧 text 映射到未满文字（未满足时显示旧文字）', s.text === '静态文字', s.text);

/* ── D. 属性面板结构 ── */
// bool 绑定：状态显示勾选 + 无比较行（bool 直接开/关，无需比较——第 16 轮新语义）
await page.click(`#canvas .wd[data-id="${ids.btnB}"]`);
await page.waitForTimeout(150);
const panelB = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.filter(r => r.querySelector('.f-label')?.textContent.trim() === t);
  return {
    stateRow: byLabel('状态显示').length,
    hasOn: byLabel('满足文字').length,
    hasOff: byLabel('未满文字').length,
    hasOp: byLabel('比较').length > 0,
    bindGroup: !!document.querySelector('#propBody [data-bind="variable"]'),
    bindVal: document.querySelector('#propBody [data-bind="variable"]')?.value,
  };
});
ok('面板：没有「状态显示」勾（常开，没得选）', panelB.stateRow === 0, `行数=${panelB.stateRow}`);
ok('面板：有「满足文字 / 未满文字」两行', panelB.hasOn === 1 && panelB.hasOff === 1, `${panelB.hasOn}/${panelB.hasOff}`);
ok('面板：绑 bool → 无比较行', panelB.hasOp === false, `hasOp=${panelB.hasOp}`);
ok('面板：按钮出现数据绑定组且已绑 bRun', panelB.bindGroup && panelB.bindVal === 'bRun', panelB.bindVal);
// 数值绑定：比较行出现，op 默认 >=、比较值 10
// （先恢复 B 段 cmp() 遗留的 ==/AB，D 段读的是数据真实状态）
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'op', '>=');
  m.project.updateWidgetProp(wid, 'threshold', '10');
}, ids.btnN);
await page.click(`#canvas .wd[data-id="${ids.btnN}"]`);
await page.waitForTimeout(150);
const panelN = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.filter(r => r.querySelector('.f-label')?.textContent.trim() === t);
  const val = (t) => {
    const row = byLabel(t)[0];
    const sel = row?.querySelector('select');
    return sel ? sel.value : row?.querySelector('input')?.value;
  };
  return { op: val('比较'), thr: val('比较值') };
});
ok('面板：绑数值 → 比较下拉 = >=', panelN.op === '>=', panelN.op);
ok('面板：绑数值 → 比较值输入存在', panelN.thr !== undefined && panelN.thr !== null, panelN.thr);

/* ── E. 运行时变量联动 ── */
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
const btnText = (wid) => page.evaluate((wid) =>
  document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-btn`)?.textContent, wid);
ok('运行初值 false → 关', await btnText(ids.btnB) === '关', await btnText(ids.btnB));
await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.set('bRun', true, 'local');
});
await page.waitForTimeout(200);
ok('变量置 true → 按钮实时变「开」', await btnText(ids.btnB) === '开', await btnText(ids.btnB));
await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.set('bRun', false, 'local');
});
await page.waitForTimeout(200);
ok('变量置 false → 实时回「关」', await btnText(ids.btnB) === '关', await btnText(ids.btnB));
// 数值联动：先恢复 B 段被 cmp() 改掉的比较条件，再测 rSpd
await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'op', '>=');
  m.project.updateWidgetProp(wid, 'threshold', '10');
}, ids.btnN);
await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.set('rSpd', 0, 'local');   // 先归零，保证后续 set(12) 必然触发广播
});
await page.waitForTimeout(200);
await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.set('rSpd', 12, 'local');
});
await page.waitForTimeout(200);
const diagN = await page.evaluate(async (wid) => {
  const m = await import('/js/core/project.js');
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  const w = m.project.getWidget(wid);
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"]`);
  return {
    varVal: vs.get('rSpd'), varType: typeof vs.get('rSpd'),
    props: { op: w.props.op, threshold: w.props.threshold, showState: w.props.showState },
    bind: w.bindings?.variable, domText: el?.querySelector('.w-btn')?.textContent,
  };
}, ids.btnN);
ok('数值联动：rSpd=12 → 「速度」按钮变「开」',
  diagN.domText === '开',
  JSON.stringify(diagN));
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(150);

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
await browser.close();
process.exit(fails ? 1 : 0);
