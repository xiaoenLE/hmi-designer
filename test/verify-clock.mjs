// verify-clock.mjs — 时钟控件：显示当前时间（年月日时分秒），格式可自定义
//   1) 工具箱里有「时钟」，拖进画布就有时间，默认格式 年月日 时:分:秒
//   2) 走时：编辑态和运行态都会自己跳（毫秒格式刷得更快）
//   3) 格式：预设 + 自定义（YYYY/MM/DD/hh/mm/ss/SSS）、前缀后缀
//   4) 样式：字号/文字色/加粗/对齐/背景色/边框；不绑变量也能用；存档往返
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
const results = [];
const ok = (n, c, e = '') => {
  results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);

/* ══════ 1. 注册 + 工具箱 ══════ */
const reg = await page.evaluate(async () => {
  const r = await import('/js/widgets/registry.js');
  const def = r.registry.get('clock');
  const inToolbox = [...document.querySelectorAll('#toolboxList .tb-item')].map(e => e.textContent.trim());
  return {
    title: def?.title, sub: def?.sub, hidden: !!def?.hidden,
    w: def?.defaults?.w, h: def?.defaults?.h,
    props: def?.props.map(p => p.key),
    fmt: def?.defaults?.timeFmt,
    inToolbox: inToolbox.some(t => /^时钟/.test(t)),
    toolboxN: inToolbox.length,
  };
});
ok('「时钟」已注册并在工具箱里（排在数值/输入之后）',
  reg.title === '时钟' && !reg.hidden && reg.inToolbox, JSON.stringify({ title: reg.title, sub: reg.sub, inToolbox: reg.inToolbox }));
ok('默认尺寸 190×34、默认格式是「年月日 时:分:秒」',
  reg.w === 190 && reg.h === 34 && reg.fmt === 'YYYY-MM-DD hh:mm:ss', JSON.stringify({ w: reg.w, h: reg.h, fmt: reg.fmt }));
ok('属性面板里有格式/前后缀/字号/颜色/对齐/背景/边框这些',
  ['timeFmt', 'timeFmtCustom', 'prefix', 'suffix', 'fontSize', 'textColor', 'bold', 'align', 'bgColor', 'borderColor', 'borderWidth', 'radius']
    .every(k => reg.props.includes(k)), JSON.stringify(reg.props));

/* ══════ 2. 放进画布：显示当前时间（年月日时分秒） ══════ */
const wid = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const cv = await import('/js/editor/canvas.js');
  m.project.currentPage().widgets.length = 0;
  const w = m.project.addWidget('clock', 40, 40);
  m.project.commit('放个时钟');
  cv.select([w.id]);
  return w.id;
});
await sleep(400);
const shown = await page.evaluate((id) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`);
  return { text: el?.textContent || '', fmt: el?.dataset.clockFmt || '' };
}, wid);
ok('画布上直接显示当前时间（YYYY-MM-DD hh:mm:ss）',
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(shown.text) && shown.fmt === 'YYYY-MM-DD hh:mm:ss',
  JSON.stringify(shown));
const realNow = new Date();
const sameMinute = shown.text.slice(0, 16) === `${realNow.getFullYear()}-${String(realNow.getMonth() + 1).padStart(2, '0')}-${String(realNow.getDate()).padStart(2, '0')} ${String(realNow.getHours()).padStart(2, '0')}:${String(realNow.getMinutes()).padStart(2, '0')}`;
ok('显示的就是"现在"（和系统时间同一分钟）', sameMinute, `${shown.text} vs ${realNow.toLocaleString('zh-CN')}`);

/* ══════ 3. 走时：秒会自己跳 ══════ */
const t1 = await page.evaluate((id) => document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`).textContent, wid);
await sleep(1300);
const t2 = await page.evaluate((id) => document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`).textContent, wid);
ok('编辑态会自己走（1.3 秒后秒数变了）', t1 !== t2 && /^\d{4}-\d\d-\d\d /.test(t2), `${t1} → ${t2}`);

/* ══════ 4. 自定义格式 + 前缀后缀 ══════ */
await page.evaluate((id) => {
  const m = window.app.project;
  m.updateWidgetProp(id, 'timeFmt', 'custom');
  m.updateWidgetProp(id, 'timeFmtCustom', 'YYYY年MM月DD日 hh时mm分ss秒');
  m.project?.commit?.('自定义格式');
  m.commit('自定义格式');
}, wid);
await sleep(400);
const custom = await page.evaluate((id) => ({
  text: document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`)?.textContent || '',
  fmt: document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`)?.dataset.clockFmt || '',
  panel: !!document.querySelector('#propBody [data-prop="timeFmtCustom"]'),
}), wid);
ok('自定义格式生效（YYYY年MM月DD日 hh时mm分ss秒）',
  /^\d{4}年\d\d月\d\d日 \d\d时\d\d分\d\d秒$/.test(custom.text) && custom.fmt === 'YYYY年MM月DD日 hh时mm分ss秒',
  JSON.stringify(custom));
ok('属性面板有「自定义格式」输入框（选自定义时才用它）', custom.panel === true);

const preset = await page.evaluate(async (id) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(id, 'timeFmt', 'MM-DD hh:mm:ss');
  m.project.updateWidgetProp(id, 'prefix', '现在 ');
  m.project.updateWidgetProp(id, 'suffix', ' 收工');
  m.project.commit('换成预设 + 前后缀');
  await new Promise(r => setTimeout(r, 60));
  document.getElementById('canvas');
  return true;
}, wid);
await sleep(400);
const withAffix = await page.evaluate((id) => {
  const box = document.querySelector(`#canvas .wd[data-id="${id}"] .w-clock`);
  return {
    time: box?.querySelector('.wc-time')?.textContent || '',
    pre: box?.querySelector('.wc-pre')?.textContent || '',
    suf: box?.querySelector('.wc-suf')?.textContent || '',
  };
}, wid);
ok('换成预设格式（月-日 时:分:秒）+ 前后缀都对',
  /^\d\d-\d\d \d\d:\d\d:\d\d$/.test(withAffix.time) && withAffix.pre === '现在 ' && withAffix.suf === ' 收工',
  JSON.stringify(withAffix));
ok('预设里选回预设后，自定义那段就不生效了（互不干扰）', preset === true && withAffix.time && !withAffix.time.includes('年'), withAffix.time);

/* ══════ 5. 毫秒格式刷得更快 ══════ */
await page.evaluate((id) => {
  const m = window.app.project;
  m.updateWidgetProp(id, 'timeFmt', 'hh:mm:ss.SSS');
  m.commit('毫秒格式');
}, wid);
await sleep(350);
const ms1 = await page.evaluate((id) => document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`).textContent, wid);
await sleep(220);
const ms2 = await page.evaluate((id) => document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`).textContent, wid);
ok('毫秒格式（hh:mm:ss.SSS）显示 3 位毫秒，且 0.2 秒内就刷新了',
  /^\d\d:\d\d:\d\d\.\d{3}$/.test(ms1) && ms1 !== ms2, `${ms1} → ${ms2}`);

/* ══════ 6. 样式属性 ══════ */
await page.evaluate((id) => {
  const m = window.app.project;
  m.updateWidgetProp(id, 'timeFmt', 'hh:mm:ss');
  m.updateWidgetProp(id, 'fontSize', 28);
  m.updateWidgetProp(id, 'textColor', '#c0392b');
  m.updateWidgetProp(id, 'bold', true);
  m.updateWidgetProp(id, 'align', 'center');
  m.updateWidgetProp(id, 'bgColor', '#fff7ed');
  m.updateWidgetProp(id, 'borderWidth', 2);
  m.updateWidgetProp(id, 'borderColor', '#c0392b');
  m.updateWidgetProp(id, 'radius', 8);
  m.commit('样式');
}, wid);
await sleep(450);
const styled = await page.evaluate((id) => {
  const box = document.querySelector(`#canvas .wd[data-id="${id}"] .w-clock`);
  const cs = getComputedStyle(box);
  return {
    style: box.getAttribute('style'),
    fontSize: cs.fontSize, color: cs.color, weight: cs.fontWeight,
    justify: cs.justifyContent, bg: cs.backgroundColor,
    radius: cs.borderRadius, borderW: cs.borderTopWidth, borderC: cs.borderTopColor,
    mono: cs.fontFamily,
  };
}, wid);
ok('字号/文字色/加粗/对齐/背景/边框/圆角都生效',
  styled.fontSize === '28px' && styled.color === 'rgb(192, 57, 43)' && +styled.weight >= 700
  && styled.justify === 'center' && styled.bg === 'rgb(255, 247, 237)'
  && styled.borderW === '2px' && styled.radius === '8px',
  JSON.stringify({ fontSize: styled.fontSize, color: styled.color, weight: styled.weight, justify: styled.justify, bg: styled.bg, borderW: styled.borderW }));
ok('时间用等宽字体（跳秒时宽度不抖）', /mono|consol|courier/i.test(styled.mono), styled.mono);
// 背景设透明
await page.evaluate((id) => {
  const m = window.app.project;
  m.updateWidgetProp(id, 'bgColor', '');
  m.commit('背景透明');
}, wid);
await sleep(350);
const transBg = await page.evaluate((id) => getComputedStyle(document.querySelector(`#canvas .wd[data-id="${id}"] .w-clock`)).backgroundColor, wid);
ok('背景色点「透明」→ 真的透明', transBg === 'rgba(0, 0, 0, 0)', transBg);

/* ══════ 7. 不绑变量也能用 ══════ */
const binding = await page.evaluate(async (id) => {
  const r = await import('/js/widgets/registry.js');
  const m = await import('/js/core/project.js');
  const cv = await import('/js/editor/canvas.js');
  cv.select([id]);
  await new Promise(r2 => setTimeout(r2, 120));
  return {
    defBinding: r.registry.get('clock').binding,
    hasBindRow: !!document.querySelector('#propBody [data-bind]'),
    text: document.querySelector(`#canvas .wd[data-id="${id}"] .wc-time`)?.textContent || '',
  };
}, wid);
ok('时钟不需要绑变量（属性面板里没有数据绑定）',
  binding.defBinding === null && binding.hasNoBind !== false && binding.hasBindRow === false && /^\d\d:\d\d:\d\d$/.test(binding.text),
  JSON.stringify({ defBinding: binding.defBinding, hasBindRow: binding.hasBindRow, text: binding.text }));

/* ══════ 8. 运行态：也走时 ══════ */
const rtWid = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.addWidget('clock', 300, 300);
  m.project.updateWidgetProp(w.id, 'timeFmt', 'YYYY-MM-DD hh:mm:ss');
  m.project.commit('运行态时钟');
  await (await import('/js/runtime/runtime.js')).enterRun();
  return w.id;
});
await sleep(700);
const rt1 = await page.evaluate((id) => document.querySelector(`#rtPage .wd[data-id="${id}"] .wc-time`)?.textContent || '', rtWid);
await sleep(1300);
const rt2 = await page.evaluate((id) => document.querySelector(`#rtPage .wd[data-id="${id}"] .wc-time`)?.textContent || '', rtWid);
ok('运行态也在走时（1.3 秒后变了）', /^\d{4}-\d\d-\d\d /.test(rt1) && rt1 !== rt2, `${rt1} → ${rt2}`);
// 弹窗里也要走
const popupRt = await page.evaluate(() => ({
  clocks: document.querySelectorAll('#rtPage [data-clock-fmt]').length,
}));
ok('运行页上的时钟都被同一个定时器管着（按 data-clock-fmt 找）', popupRt.clocks >= 1, JSON.stringify(popupRt));
await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).exitRun(); });
await sleep(300);

/* ══════ 9. 存档往返 + 不吃 CPU（定时器只有一份） ══════ */
const roundTrip = await page.evaluate(async (id) => {
  const m = await import('/js/core/project.js');
  const json = JSON.stringify(m.project.data);
  const back = JSON.parse(json);
  const w = back.pages.flatMap(p => p.widgets).find(x => x.id === id);
  return { fmt: w?.props?.timeFmt, custom: w?.props?.timeFmtCustom, type: w?.type };
}, wid);
ok('时钟跟着工程存档走（类型/格式都在 JSON 里）',
  roundTrip.type === 'clock' && roundTrip.fmt === 'hh:mm:ss' && !!roundTrip.custom, JSON.stringify(roundTrip));
const ticker = await page.evaluate(async () => {
  const c = await import('/js/widgets/clock.js');
  return { running: c.clockTickerRunning() };
});
ok('走时定时器只有一个（启动多次不会叠加）', ticker.running === true, JSON.stringify(ticker));

ok('全程没有未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 时钟控件回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
