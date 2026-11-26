// verify-widgets-input.mjs — 新增的 3 个交互类控件：滑动条 / 拨动开关 / 多档位
//
// 每个控件都要验到：
//   ① 注册成功（registry 里拿得到、props 齐全、attach 是函数、**没有一个 prop 写 hint**）
//   ② 工具箱里出现（3 个连续、顺序 = 滑动条→拨动开关→多档位）
//   ③ 属性面板能选中、按 props schema 长出输入格、改一格真的写进工程 + 画布跟着变
//   ④ 编辑态渲染出预期 DOM（滑块填充/手柄位置、开关开合、多档位高亮）
//   ⑤ **运行态真交互**：鼠标拖滑块 / 点开关 / 点多档位 → varStore 里的值真的变了、界面跟着变
//   ⑥ 链路门：设备链路断着时交互**写不进去**，值不变、画面按真值重画（不留假预览/假开关）
//   ⑦ 多语言：开关文字/档位文字/单位切语言后跟着翻
//
// 用法：node test/verify-widgets-input.mjs
//   （自己拉起一个隔离后端：随机端口 + 临时数据目录，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
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

const TYPES = ['slider', 'switch', 'multiPosition'];
const TITLES = ['滑动条', '拨动开关', '多档位'];
const KEY_PROPS = {
  slider: ['min', 'max', 'step', 'orientation', 'showValue', 'unit', 'decimals',
    'trackColor', 'fillColor', 'knobColor', 'textColor', 'trackH', 'radius'],
  switch: ['onText', 'offText', 'showText', 'onColor', 'offColor', 'knobColor', 'textColor', 'fontSize', 'radius'],
  multiPosition: ['items', 'orientation', 'optionH', 'activeBg', 'activeText', 'inactiveText', 'fontSize', 'borderColor', 'radius'],
};

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-widgets-input-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* ═══════════ 0. 造数据：变量 + 7 个控件 ═══════════ */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const target = project.pages().find(p => p.type === 'page');
  if (!target) throw new Error('演示工程里没有普通页');
  project.setCurrentPage(target.id);
  const defs = [
    ['rSlider', 'real', 20, ''],          // 内部变量：滑块正常交互
    ['bSwitch', 'bool', false, ''],       // 内部变量：开关正常交互
    ['iPos', 'int', 0, ''],               // 内部变量：多档位（带值）
    ['sPos', 'string', '', ''],           // 字符串变量：多档位写字符串
    ['iPos2', 'int', 0, ''],              // 内部变量：档位没写值 → 写序号
    ['bPlcSwitch', 'bool', false, '%MX0.0'],   // 带地址 → 链路门能挡住
    ['rPlcSlider', 'real', 0, '%MW100'],       // 带地址 → 链路门能挡住
  ];
  defs.forEach(([name, type, value, address]) => {
    const old = project.data.variables.find(v => v.name === name);
    if (old) { old.type = type; old.value = value; old.address = address; }
    else project.data.variables.push({ name, type, address, value });
  });
  project.commit('交互控件测试：变量');
  varStore.resetFrom(project.variables());
  const mk = (type, x, y, w, h, bind) => {
    const wd = project.addWidget(type, x, y);
    project.updateWidgetField(wd.id, 'w', w);
    project.updateWidgetField(wd.id, 'h', h);
    if (bind) project.updateWidgetField(wd.id, 'bindings.variable', bind);
    return wd.id;
  };
  const out = {
    slider: mk('slider', 40, 40, 260, 44, 'rSlider'),
    switch: mk('switch', 340, 40, 96, 44, 'bSwitch'),
    multiPosition: mk('multiPosition', 480, 40, 260, 44, 'iPos'),
    switchGate: mk('switch', 40, 150, 96, 44, 'bPlcSwitch'),
    mpStr: mk('multiPosition', 200, 150, 220, 44, 'sPos'),
    mpNoVal: mk('multiPosition', 460, 150, 220, 44, 'iPos2'),
    sliderGate: mk('slider', 40, 260, 260, 44, 'rPlcSlider'),
    sliderV: mk('slider', 820, 220, 44, 180, 'rSlider'),   // 垂直滑块（上下拖）
  };
  project.commit('交互控件测试：控件');
  return out;
});
await sleep(400);

/* ── 通用小工具 ── */
const propOf = (id, key) => page.evaluate(([id, key]) => window.app.project.getWidget(id)?.props?.[key], [id, key]);
async function selectWidget(id) {
  await page.evaluate(async (id) => {
    const { select } = await import('/js/editor/canvas.js');
    select([id]);
  }, id);
  await sleep(100);
}
const panelSchema = () => page.evaluate(() => {
  const body = document.getElementById('propBody');
  return {
    titles: [...body.querySelectorAll('.prop-group-title')].map(e => e.textContent.trim()),
    fields: [...body.querySelectorAll('[data-prop]')].map(e => ({ key: e.dataset.prop, tag: e.tagName, type: e.type || '' })),
  };
});
async function panelEdit(prop, value, kind = 'text') {
  const found = await page.evaluate(([key, val, kind]) => {
    const el = document.querySelector(`#propBody [data-prop="${key}"]`);
    if (!el) return false;
    if (kind === 'check') el.checked = !!val;
    else el.value = String(val);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [prop, value, kind]);
  await sleep(120);
  return found;
}
async function setProps(id, patch) {
  await page.evaluate(([id, patch]) => {
    const { project } = window.app;
    Object.entries(patch).forEach(([k, v]) => project.updateWidgetProp(id, k, v));
  }, [id, patch]);
  await sleep(100);
}
const setVar = (name, value) => page.evaluate(async ([name, value]) => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set(name, value);
}, [name, value]);
const getVar = (name) => page.evaluate(async (name) => {
  const { varStore } = await import('/js/runtime/varstore.js');
  return varStore.get(name);
}, name);
/** 取编辑态 / 运行态 7 个控件的关键 DOM 摘要 */
function domSummary(root, map) {
  return page.evaluate(([root, map]) => {
    const out = {};
    for (const [name, id] of Object.entries(map)) {
      const el = document.querySelector(`${root} .wd[data-id="${id}"]`);
      if (!el) { out[name] = { present: false }; continue; }
      const q = (s) => el.querySelector(s);
      const qa = (s) => [...el.querySelectorAll(s)];
      const cs = (e) => (e ? getComputedStyle(e) : null);
      const sl = q('.w-slider');
      const sw = q('.w-switch');
      const mp = q('.w-mp');
      const fill = q('.wsl-fill');
      const knob = q('.wsl-knob');
      const active = q('.wmp-item.on');
      const info = sl ? {
        slider: {
          orientation: sl.dataset.orientation || '',
          fillW: fill ? fill.style.width : '', fillH: fill ? fill.style.height : '',
          knobLeft: knob ? knob.style.left : '', knobBottom: knob ? knob.style.bottom : '',
          val: q('.wsl-val') ? q('.wsl-val').textContent : '',
          hasValue: !!q('.wsl-val'),
        },
      } : sw ? {
        switch: {
          on: sw.dataset.on || '',
          text: q('.wsw-text') ? q('.wsw-text').textContent : '',
          hasText: !!q('.wsw-text'),
          bg: cs(sw).backgroundColor,
        },
      } : mp ? {
        multiPosition: {
          orientation: mp.dataset.orientation || '',
          count: mp.dataset.count || '',
          labels: qa('.wmp-item').map(x => x.textContent),
          values: qa('.wmp-item').map(x => x.getAttribute('data-value')),
          activeIdx: active ? active.getAttribute('data-idx') : '',
          activeBg: active ? cs(active).backgroundColor : '',
          empty: mp.classList.contains('wmp-empty'),
        },
      } : {};
      out[name] = { present: true, ...(info.slider || info.switch || info.multiPosition || {}) };
    }
    return out;
  }, [root, map]);
}
const editDom = () => domSummary('#canvas', ids);
const runDom = () => domSummary('#rtPage', ids);
/** 运行态某控件里某个子元素的中心点（用于鼠标点/拖） */
const centerOf = (id, sub) => page.evaluate(([id, sub]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] ${sub}`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
}, [id, sub]);

/* ═══════════ 1. 注册 + 工具箱 ═══════════ */
const reg = await page.evaluate(async (types) => {
  const { registry } = await import('/js/widgets/registry.js');
  const out = {};
  types.forEach(t => {
    const d = registry.get(t);
    out[t] = d ? {
      title: d.title, sub: d.sub, icon: d.icon, hidden: !!d.hidden,
      props: (d.props || []).map(p => ({ key: p.key, hint: p.hint, i18n: p.i18n, type: p.type })),
      binding: d.binding, actions: d.actions,
      attach: typeof d.attach,
      defaults: d.defaults,
      defKeys: Object.keys(d.defaults || {}),
      renderOk: (() => {
        try {
          return typeof d.render({ props: { ...d.defaults }, bindings: {}, w: d.defaults.w, h: d.defaults.h }, 'edit', new Map()) === 'string';
        } catch (e) { return false; }
      })(),
    } : null;
  });
  out.order = registry.list().filter(d => types.includes(d.type)).map(d => d.type);
  return out;
}, TYPES);
ok('3 个交互控件都注册成功（render 能跑、attach 是函数）',
  TYPES.every(t => reg[t] && reg[t].renderOk && reg[t].attach === 'function'),
  TYPES.map(t => t + '=' + (reg[t] ? reg[t].attach : 'missing')).join(' '));
ok('每个控件都有 title/sub/icon/默认 w+h/属性行',
  TYPES.every(t => reg[t] && reg[t].title && reg[t].sub && /^<svg/.test(reg[t].icon || '')
    && Number.isFinite(reg[t].defaults.w) && Number.isFinite(reg[t].defaults.h) && reg[t].props.length > 0));
ok('★ 所有 props 都不写 hint（现场要求：面板上不摊说明文字）',
  TYPES.every(t => reg[t].props.every(p => p.hint === undefined)),
  TYPES.map(t => t + ':' + reg[t].props.filter(p => p.hint !== undefined).map(p => p.key).join('/')).join(' '));
ok('文字类 props 都声明了 i18n（开关开/关文字、档位选项、滑块单位）',
  reg.switch.props.find(p => p.key === 'onText').i18n === 'text'
  && reg.switch.props.find(p => p.key === 'offText').i18n === 'text'
  && reg.multiPosition.props.find(p => p.key === 'items').i18n === 'options'
  && reg.slider.props.find(p => p.key === 'unit').i18n === 'text');
ok('绑定声明：滑块/多档位绑数值（多档位还认字符串），开关只绑 bool；都是纯交互件（actions 空）',
  reg.slider.binding.variable.types.join() === 'int,uint,dint,udint,real,lreal'
  && reg.multiPosition.binding.variable.types.includes('string')
  && reg.switch.binding.variable.types.join() === 'bool'
  && TYPES.every(t => Array.isArray(reg[t].actions) && reg[t].actions.length === 0),
  JSON.stringify({ s: reg.slider.binding.variable.types, m: reg.multiPosition.binding.variable.types, w: reg.switch.binding.variable.types }));
ok('注册顺序里 3 个控件连续，顺序 = 滑动条→拨动开关→多档位',
  reg.order.join() === 'slider,switch,multiPosition', reg.order.join());

const toolbox = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#toolboxList .tb-item')];
  return {
    names: items.map(e => e.querySelector('.tb-item-name')?.textContent || ''),
    svgs: items.map(e => !!e.querySelector('svg')),
  };
});
const idx = TITLES.map(t => toolbox.names.findIndex(n => n === t));
ok('工具箱里 3 个条目都在（带名称和图标）',
  idx.every(i => i >= 0) && idx.every(i => toolbox.svgs[i]), JSON.stringify(idx));
ok('工具箱里 3 个条目挨在一起、顺序 = 滑动条→拨动开关→多档位',
  idx.every((v, i) => i === 0 || v === idx[i - 1] + 1), idx.map((i, k) => TITLES[k] + '@' + i).join(' '));

/* ═══════════ 2. 属性面板：能选中 / schema 长对了 / 改一格真的生效 ═══════════ */
for (const t of TYPES) {
  await selectWidget(ids[t]);
  const pane = await panelSchema();
  const got = pane.fields.map(f => f.key);
  const missing = KEY_PROPS[t].filter(k => !got.includes(k));
  ok(`属性面板能选中「${reg[t].title}」（标题 = ${reg[t].title} 属性）`,
    pane.titles.includes(`${reg[t].title} 属性`), pane.titles.join(' | ').slice(0, 120));
  ok(`「${reg[t].title}」面板按 props 长出全部属性行`, missing.length === 0,
    missing.length ? '缺：' + missing.join(',') : KEY_PROPS[t].length + ' 行');
}

await selectWidget(ids.slider);
const okStep = await panelEdit('step', 5);
ok('滑块面板改「步长」→ 写进工程（props.step=5）',
  okStep && (await propOf(ids.slider, 'step')) === 5, `step=${await propOf(ids.slider, 'step')}`);

await selectWidget(ids.switch);
const okSwColor = await panelEdit('onColor', '#123456');
ok('开关面板改「开时底色」→ 写进工程（props.onColor）',
  okSwColor && (await propOf(ids.switch, 'onColor')) === '#123456', String(await propOf(ids.switch, 'onColor')));

await selectWidget(ids.multiPosition);
const okOptH = await panelEdit('optionH', 40);
ok('多档位面板改「档高」→ 写进工程（props.optionH=40）',
  okOptH && (await propOf(ids.multiPosition, 'optionH')) === 40, `optionH=${await propOf(ids.multiPosition, 'optionH')}`);

/* 配好场景属性（编辑态 / 运行态都用这一套） */
await setProps(ids.slider, {
  min: 0, max: 100, step: 5, orientation: 'h', showValue: true, unit: ' 转/分', decimals: 0,
  trackColor: '#e5e7eb', fillColor: '#2563eb', knobColor: '#ffffff', textColor: '#1f2329',
  trackH: 10, radius: 5,
});
await setProps(ids.switch, {
  onText: '开', offText: '关', showText: true,
  onColor: '#22c55e', offColor: '#9ca3af', knobColor: '#ffffff', textColor: '#ffffff',
  fontSize: 14, radius: 22,
});
await setProps(ids.multiPosition, {
  items: '停止=0=#ef4444\n运行=1=#22c55e\n故障=2=#f59e0b',
  orientation: 'h', optionH: 36,
  activeBg: '#2563eb', activeText: '#ffffff', inactiveText: '#1f2329',
  fontSize: 14, borderColor: '#c3cbd6', radius: 6,
});
await setProps(ids.mpStr, { items: '手动=manual\n自动=auto', orientation: 'h' });
await setProps(ids.mpNoVal, { items: '低速\n中速\n高速', orientation: 'h' });
await setProps(ids.sliderGate, { min: 0, max: 50, step: 1, showValue: true, unit: '', trackH: 10 });
await setProps(ids.sliderV, { min: 0, max: 100, step: 5, orientation: 'v', showValue: true, unit: '', trackH: 10 });
await page.evaluate(() => window.app.project.commit('交互控件测试：场景属性'));
await sleep(250);

/* ═══════════ 3. 编辑态渲染 ═══════════ */
await setVar('rSlider', 20);
await setVar('bSwitch', false);
await setVar('iPos', 1);
await setVar('sPos', 'auto');
await setVar('iPos2', 0);
await sleep(200);
let ed = await editDom();

ok('滑块编辑态：填充 20% / 手柄在 20% / 数值 20 转/分',
  parseFloat(ed.slider.fillW) === 20 && parseFloat(ed.slider.knobLeft) === 20 && ed.slider.val === '20 转/分',
  JSON.stringify({ fill: ed.slider.fillW, knob: ed.slider.knobLeft, val: ed.slider.val }));
await setProps(ids.slider, { orientation: 'v' });
ed = await editDom();
ok('滑块「方向=垂直」→ 从下往上填充（高度 20%）',
  ed.slider.orientation === 'v' && parseFloat(ed.slider.fillH) === 20 && parseFloat(ed.slider.knobBottom) === 20,
  JSON.stringify({ o: ed.slider.orientation, h: ed.slider.fillH, b: ed.slider.knobBottom }));
await setProps(ids.slider, { orientation: 'h' });

ok('开关编辑态：关 → data-on=0、显示「关」、底色是关时色',
  ed.switch.on === '0' && ed.switch.text === '关' && ed.switch.bg === 'rgb(156, 163, 175)',
  JSON.stringify({ on: ed.switch.on, text: ed.switch.text, bg: ed.switch.bg }));
await setVar('bSwitch', true);
await sleep(150);
ed = await editDom();
ok('开关编辑态：变量变 true → 开、显示「开」、底色是开时色',
  ed.switch.on === '1' && ed.switch.text === '开' && ed.switch.bg === 'rgb(34, 197, 94)',
  JSON.stringify({ on: ed.switch.on, text: ed.switch.text, bg: ed.switch.bg }));
await setVar('bSwitch', false);
await sleep(120);

ok('多档位编辑态：3 档、当前值 1 高亮第 2 档（带状态色）',
  ed.multiPosition.count === '3' && ed.multiPosition.activeIdx === '1'
  && ed.multiPosition.labels.join() === '停止,运行,故障'
  && ed.multiPosition.values.join() === '0,1,2'
  && ed.multiPosition.activeBg === 'rgb(34, 197, 94)',
  JSON.stringify(ed.multiPosition));
ok('多档位（字符串变量）：当前值 auto → 高亮「自动」',
  ed.mpStr.activeIdx === '1' && ed.mpStr.labels[1] === '自动', JSON.stringify(ed.mpStr));
ok('多档位（无显式值）：items 只有文字也解析出 3 档',
  ed.mpNoVal.count === '3' && ed.mpNoVal.labels.join() === '低速,中速,高速', JSON.stringify(ed.mpNoVal));
ok('滑块（带地址变量）：编辑态也能显示', ed.sliderGate.present === true && ed.sliderGate.val === '0');
ok('滑块（垂直方向）编辑态：从下往上填充到 20%',
  ed.sliderV.orientation === 'v' && parseFloat(ed.sliderV.fillH) === 20 && ed.sliderV.val === '20',
  JSON.stringify({ o: ed.sliderV.orientation, h: ed.sliderV.fillH, val: ed.sliderV.val }));

/* ═══════════ 4. 运行态真交互 ═══════════ */
// 链路门用例要自己摆 backend.plcLink；运行态每秒的 plcWatch 每 pollMs 会去后端读一次真实状态，
// 读回来会把 plcLink 覆盖掉 → 这里把轮询周期调大（测试期间不会再有自动覆盖）。
await page.evaluate(() => { window.app.plcWatch.pollMs = 600000; });
await page.evaluate(() => window.app.enterRun());
await sleep(500);
// 进运行态前会出现：先把变量设成已知值（后端全量读可能带回编辑期预览写过的那份）
for (const [n, v] of [['rSlider', 20], ['bSwitch', false], ['iPos', 0], ['sPos', ''], ['iPos2', 0]]) await setVar(n, v);
await sleep(250);
let rd = await runDom();
ok('运行态：8 个控件都渲染出来了',
  Object.keys(ids).every(k => rd[k].present), Object.keys(ids).map(k => k + '=' + !!rd[k].present).join(' '));

/* 4.1 滑块：按下 → 拖动（实时预览、还没写）→ 松手（写入） */
const sliderTrack = await centerOf(ids.slider, '.wsl-trackwrap');
ok('运行态：滑块轨道量得到（可以真的按下去）', !!sliderTrack && sliderTrack.width > 20, JSON.stringify(sliderTrack));
const x10 = sliderTrack.left + sliderTrack.width * 0.1;
const x75 = sliderTrack.left + sliderTrack.width * 0.75;
const cy = sliderTrack.top + sliderTrack.height / 2;
await page.mouse.move(x10, cy);
await page.mouse.down();
await page.mouse.move(x75, cy, { steps: 6 });
await sleep(120);
const midDrag = await page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return { text: el.querySelector('.wsl-val').textContent, store: window.app.varStore.get('rSlider') };
}, ids.slider);
ok('★ 滑块拖动中：只改 DOM 预览，还没写变量（松手才写）',
  midDrag.store === 20 && /^7[0-9] 转\/分$/.test(midDrag.text.replace(/\s+/g, ' ')),
  JSON.stringify(midDrag));
await page.mouse.up();
await sleep(300);
const afterDrag = await page.evaluate((id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return { store: window.app.varStore.get('rSlider'), text: el.querySelector('.wsl-val').textContent };
}, ids.slider);
ok('★ 滑块松手 → varStore 真的写进 75（按步长 5 吸附）+ 界面显示 75 转/分',
  afterDrag.store === 75 && afterDrag.text === '75 转/分', JSON.stringify(afterDrag));

// 点轨道空白直接跳值：点 25% 处（按下即松手）
const x25 = sliderTrack.left + sliderTrack.width * 0.25;
await page.mouse.click(x25, cy);
await sleep(250);
ok('★ 滑块点轨道空白 → 直接跳到 25 并写入',
  (await getVar('rSlider')) === 25, String(await getVar('rSlider')));

/* 4.1b 垂直滑块：0 在下、100 在上 */
const vTrack = await centerOf(ids.sliderV, '.wsl-trackwrap');
ok('运行态：垂直滑块轨道量得到', !!vTrack && vTrack.height > 40, JSON.stringify(vTrack));
const vx = vTrack.left + vTrack.width / 2;
await page.mouse.move(vx, vTrack.top + vTrack.height * 0.9);
await page.mouse.down();
await page.mouse.move(vx, vTrack.top + vTrack.height * 0.25, { steps: 6 });   // 从下往上拖到 75% 高度
await page.mouse.up();
await sleep(300);
ok('★ 垂直滑块从下往上拖到 75% 高度 → 变量 75',
  (await getVar('rSlider')) === 75, String(await getVar('rSlider')));
await page.mouse.click(vx, vTrack.top + vTrack.height * 0.5);
await sleep(250);
ok('★ 垂直滑块点正中间 → 变量 50', (await getVar('rSlider')) === 50, String(await getVar('rSlider')));

/* 4.2 开关：点一下翻转 */
const swCenter = await centerOf(ids.switch, '.w-switch');
await page.mouse.click(swCenter.x, swCenter.y);
await sleep(250);
rd = await runDom();
ok('★ 开关点击 → 变量翻成 true，界面变「开」',
  (await getVar('bSwitch')) === true && rd.switch.on === '1' && rd.switch.text === '开',
  JSON.stringify({ v: await getVar('bSwitch'), on: rd.switch.on, text: rd.switch.text }));
await page.mouse.click(swCenter.x, swCenter.y);
await sleep(250);
rd = await runDom();
ok('★ 再点一下 → 翻回 false（不是单向）',
  (await getVar('bSwitch')) === false && rd.switch.on === '0' && rd.switch.text === '关',
  JSON.stringify({ v: await getVar('bSwitch'), on: rd.switch.on }));

/* 4.3 多档位：点第 2 档写值 */
const item1 = await centerOf(ids.multiPosition, '.wmp-item[data-idx="1"]');
await page.mouse.click(item1.x, item1.y);
await sleep(250);
rd = await runDom();
ok('★ 多档位点第 2 档 → 变量写 1，高亮跟着走',
  (await getVar('iPos')) === 1 && rd.multiPosition.activeIdx === '1',
  JSON.stringify({ v: await getVar('iPos'), active: rd.multiPosition.activeIdx }));
const item2 = await centerOf(ids.multiPosition, '.wmp-item[data-idx="2"]');
await page.mouse.click(item2.x, item2.y);
await sleep(250);
ok('★ 多档位点第 3 档 → 变量写 2', (await getVar('iPos')) === 2, String(await getVar('iPos')));

/* 4.4 多档位（字符串变量）：点「自动」写 'auto' */
const strItem1 = await centerOf(ids.mpStr, '.wmp-item[data-idx="1"]');
await page.mouse.click(strItem1.x, strItem1.y);
await sleep(250);
ok('★ 多档位绑字符串变量 → 点「自动」写字符串 auto',
  (await getVar('sPos')) === 'auto', JSON.stringify(await getVar('sPos')));

/* 4.5 多档位（档位没写值）：数字变量写档位序号（0 起） */
const nvItem2 = await centerOf(ids.mpNoVal, '.wmp-item[data-idx="2"]');
await page.mouse.click(nvItem2.x, nvItem2.y);
await sleep(250);
ok('★ 多档位档位没写值 → 数字变量写档位序号（点第 3 档 → 2）',
  (await getVar('iPos2')) === 2, String(await getVar('iPos2')));

/* ═══════════ 5. 链路门：设备断着时交互写不进去、画面不留假值 ═══════════ */
// 编辑器工具栏每 3 秒会 refreshPlcStatus() 一次，把后端真实状态写进 backend.plcLink ——
// 手工摆的 plcLink 会被它覆盖。这里把 setPlcInfo() 临时换成空操作（谁问都不改链路状态），
// 链路门的前提就稳了。验完再还原。
const oldLink = await page.evaluate(() => {
  window.__oldSetPlcInfo = window.app.backend.setPlcInfo;
  window.app.backend.setPlcInfo = function () { return this.plcInfo; };
  const old = JSON.parse(JSON.stringify(window.app.backend.plcLink || {}));
  window.app.backend.plcLink = { mode: 'plc', online: false };
  return old;
});
await sleep(100);
const gateInfo = await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  return { whySwitch: varStore.linkBlockReason('bPlcSwitch'), whySlider: varStore.linkBlockReason('rPlcSlider') };
});
ok('（前提）设备链路断着 → 两个带地址的变量都被链路门判定"不能写"',
  !!gateInfo.whySwitch && !!gateInfo.whySlider, JSON.stringify(gateInfo));

const gateSwCenter = await centerOf(ids.switchGate, '.w-switch');
await page.evaluate(() => { window.app.backend.plcLink = { mode: 'plc', online: false }; });
await page.mouse.click(gateSwCenter.x, gateSwCenter.y);
await sleep(250);
rd = await runDom();
ok('★ 链路门：点开关 → 变量不变（仍 false），界面也不会假装合上',
  (await getVar('bPlcSwitch')) === false && rd.switchGate.on === '0',
  JSON.stringify({ v: await getVar('bPlcSwitch'), on: rd.switchGate.on }));

const gateTrack = await centerOf(ids.sliderGate, '.wsl-trackwrap');
// 运行态 plcWatch 会周期性去后端读真实链路状态（读回来会覆盖手工摆的 plcLink）。
// 这里每次交互前重新摆一遍，保证"门是关着的"这个前提稳定成立（pollMs 已调大，正常情况下不会被覆盖）。
await page.evaluate(() => { window.app.backend.plcLink = { mode: 'plc', online: false }; });
const gx75 = gateTrack.left + gateTrack.width * 0.75;
const gcy = gateTrack.top + gateTrack.height / 2;
await page.mouse.move(gateTrack.left + gateTrack.width * 0.1, gcy);
await page.mouse.down();
await page.mouse.move(gx75, gcy, { steps: 5 });
await page.mouse.up();
await sleep(300);
const gateSlider = await page.evaluate(async (id) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  const { varStore } = await import('/js/runtime/varstore.js');
  return {
    store: varStore.get('rPlcSlider'),
    text: el.querySelector('.wsl-val').textContent,
    why: varStore.linkBlockReason('rPlcSlider'),
    link: JSON.parse(JSON.stringify(window.app.backend.plcLink || {})),
  };
}, ids.sliderGate);
ok('★ 链路门：拖滑块 → 变量不变（仍 0），松手后画面回到真值（不留假预览）',
  gateSlider.store === 0 && gateSlider.text === '0', JSON.stringify(gateSlider));

// 恢复链路（还原 setPlcInfo + 原来的链路状态）→ 同一个开关再点就写得进去了（证明刚才是门挡的）
await page.evaluate((link) => {
  if (window.__oldSetPlcInfo) { window.app.backend.setPlcInfo = window.__oldSetPlcInfo; delete window.__oldSetPlcInfo; }
  window.app.backend.plcLink = link;
}, oldLink);
await sleep(80);
await page.mouse.click(gateSwCenter.x, gateSwCenter.y);
await sleep(300);
ok('★ 链路恢复后再点开关 → 变量写进去了（false→true）',
  (await getVar('bPlcSwitch')) === true, String(await getVar('bPlcSwitch')));

/* ═══════════ 6. 多语言：开关文字 / 档位文字 / 滑块单位 ═══════════ */
const i18n = await page.evaluate(async () => {
  const i = await import('/js/core/i18n.js');
  i.addLanguage('en', 'English');
  const s = i.i18nState();
  if (!s.dict.en) s.dict.en = {};
  s.dict.en['开'] = 'ON';
  s.dict.en['关'] = 'OFF';
  s.dict.en['停止'] = 'Stop';
  s.dict.en['运行'] = 'Run';
  s.dict.en['故障'] = 'Fault';
  s.dict.en['转/分'] = 'rpm';
  s.dict.en['低速'] = 'Low';
  s.dict.en['中速'] = 'Mid';
  s.dict.en['高速'] = 'High';
  const entries = i.collectEntries().map(r => r.source);
  i.setLang('en');
  return { entries, lang: i.getLang() };
});
await sleep(350);
rd = await runDom();
ok('多语言：开关开/关文字、档位文字、滑块单位都被收集进翻译表（props 的 i18n 声明生效）',
  ['开', '关', '停止', '运行', '转/分'].every(k => i18n.entries.includes(k)),
  ['开', '关', '停止', '运行', '转/分'].filter(k => i18n.entries.includes(k)).join(','));
ok('多语言：切 en 后开关显示 OFF、档位显示 Stop/Run/Fault、滑块单位变 rpm',
  rd.switch.text === 'OFF' && rd.multiPosition.labels.join() === 'Stop,Run,Fault'
  && rd.slider.val.endsWith('rpm'),
  JSON.stringify({ sw: rd.switch.text, mp: rd.multiPosition.labels, sl: rd.slider.val }));
ok('多语言：切 en 后「没写值」那组档位也翻了',
  rd.mpNoVal.labels.join() === 'Low,Mid,High', rd.mpNoVal.labels.join());

// 切语言会整页重画（attach 重新绑一遍）—— 顺手验一下交互没丢
const swCenter2 = await centerOf(ids.switch, '.w-switch');
await page.mouse.click(swCenter2.x, swCenter2.y);
await sleep(250);
ok('★ 切语言重画之后交互照样能用（开关点一下翻成 ON）',
  (await getVar('bSwitch')) === true && (await runDom()).switch.text === 'ON',
  JSON.stringify({ v: await getVar('bSwitch'), text: (await runDom()).switch.text }));

await setVar('bSwitch', false);        // 切回中文前先关掉，下面验的「关」才对应得上
await page.evaluate(async () => {
  const i = await import('/js/core/i18n.js');
  i.setLang('zh-CN');
  i.removeLanguage('en');
});
await sleep(250);
rd = await runDom();
ok('多语言：切回默认语言后又变回 关/停止/转/分',
  rd.switch.text === '关' && rd.multiPosition.labels.join() === '停止,运行,故障'
  && rd.slider.val.endsWith('转/分'),
  JSON.stringify({ sw: rd.switch.text, mp: rd.multiPosition.labels, sl: rd.slider.val }));

await page.evaluate(() => window.app.exitRun());
await sleep(200);

/* ═══════════ 7. 收尾 ═══════════ */
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 交互类控件（滑动条/拨动开关/多档位）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
