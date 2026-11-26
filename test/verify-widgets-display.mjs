// verify-widgets-display.mjs — 新增的 5 个纯显示类控件：仪表盘 / 多状态图片 / 计时 / 管道 / 箭头
//
// 每个控件都要验到：
//   ① 注册成功（registry 里拿得到定义、字段齐全）
//   ② 工具箱里出现（顺序 = 仪表盘→多状态图片→计时→管道→箭头）
//   ③ 属性面板能选中它、按 props schema 长出对应的输入格，并且改一下真的写进工程 + 画布跟着变
//   ④ 编辑态渲染出预期 DOM（结构 / 关键属性 / 样式）
//   ⑤ 绑变量的控件：运行态变量值一变就刷新（仪表盘超限变色、多状态图片切图、计时格式化）
//
// 用法：node test/verify-widgets-display.mjs
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

/* 三张内联小图（不请求网络、不产生 404）：红 / 绿 / 蓝 各 8×8，用来验「按值切图」 */
const imgOf = (color) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`);
const IMG_OFF = imgOf('#ef4444');
const IMG_ON = imgOf('#22c55e');
const IMG_FALLBACK = imgOf('#2563eb');
const TYPES = ['gauge', 'stateImage', 'timer', 'pipe', 'arrow'];
const TITLES = ['仪表盘', '多状态图片', '计时', '管道', '箭头'];

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-widgets-display-'));
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

/* ═══════════ 0. 造数据：5 个变量 + 9 个控件（都落在当前普通页上）═══════════ */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const target = project.pages().find(p => p.type === 'page');
  if (!target) throw new Error('演示工程里没有普通页');
  project.setCurrentPage(target.id);
  // 变量：仪表盘/计时/多状态图片的绑定值；iDirNum / sDir 是 pipe/arrow 的「方向变量」
  const defs = [
    ['rGaugeVal', 'real', 25],
    ['iStateVal', 'int', 0],
    ['rTimerVal', 'dint', 3661],
    ['iDirNum', 'int', 0],
    ['sDir', 'string', ''],
    ['bDir', 'bool', false],
  ];
  defs.forEach(([name, type, value]) => {
    const old = project.data.variables.find(v => v.name === name);
    if (old) { old.type = type; old.value = value; old.address = ''; }
    else project.data.variables.push({ name, type, address: '', value });
  });
  project.commit('显示类控件测试：变量');
  varStore.resetFrom(project.variables());     // 编辑态预览初值（进画布前先备好）
  const g = project.addWidget('gauge', 40, 40);
  const si = project.addWidget('stateImage', 300, 40);
  const tm = project.addWidget('timer', 40, 280);
  const pp = project.addWidget('pipe', 300, 280);
  const ar = project.addWidget('arrow', 640, 40);
  // 方向变量用例：数值 / 字符串各一个（一个控件只绑一个变量，方便分别验两种取值约定）
  const pv = project.addWidget('pipe', 40, 360);
  const ps = project.addWidget('pipe', 40, 400);
  const pb = project.addWidget('pipe', 40, 440);
  const av = project.addWidget('arrow', 640, 180);
  const as = project.addWidget('arrow', 640, 280);
  const bind = (w, name) => project.updateWidgetField(w.id, 'bindings.variable', name);
  bind(g, 'rGaugeVal');
  bind(si, 'iStateVal');
  bind(tm, 'rTimerVal');
  bind(pv, 'iDirNum');
  bind(ps, 'sDir');
  bind(pb, 'bDir');
  bind(av, 'iDirNum');
  bind(as, 'sDir');
  project.commit('显示类控件测试：控件');
  return {
    gauge: g.id, stateImage: si.id, timer: tm.id, pipe: pp.id, arrow: ar.id,
    pipeVar: pv.id, pipeStr: ps.id, pipeBool: pb.id, arrowVar: av.id, arrowStr: as.id,
  };
});
await sleep(400);

/* ── 通用小工具 ── */
/** 选中一个控件（走编辑器真正的选中入口，属性面板会跟着重画） */
async function selectWidget(id) {
  await page.evaluate(async (id) => {
    const { select } = await import('/js/editor/canvas.js');
    select([id]);
  }, id);
  await sleep(100);
}
/** 属性面板当前长什么样：分组标题 + 所有 data-prop 输入格 */
const panelSchema = () => page.evaluate(() => {
  const body = document.getElementById('propBody');
  const fields = [...body.querySelectorAll('[data-prop]')].map(e => ({
    key: e.dataset.prop, tag: e.tagName, type: e.type || '',
  }));
  return {
    titles: [...body.querySelectorAll('.prop-group-title')].map(e => e.textContent.trim()),
    fields,
  };
});
/** 直接操作属性面板里的输入格（change = 实时落地，和用户改完失焦一个路径） */
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
const propOf = (id, key) => page.evaluate(([id, key]) => window.app.project.getWidget(id)?.props?.[key], [id, key]);
/** 改一个属性并等画布局部重画画完（project.updateWidgetProp 是同步 markDirty + touch） */
async function setProp(id, key, value) {
  await page.evaluate(([id, key, value]) => {
    window.app.project.updateWidgetProp(id, key, value);
  }, [id, key, value]);
  await sleep(80);
}
/** 改控件上的多个属性（一次 evaluate，减少来回） */
async function setProps(id, patch) {
  await page.evaluate(([id, patch]) => {
    const { project } = window.app;
    Object.entries(patch).forEach(([k, v]) => project.updateWidgetProp(id, k, v));
  }, [id, patch]);
  await sleep(100);
}
/** 编辑态 / 运行态的变量写入（走 varstore，界面按变量变化刷新） */
const setVar = (name, value) => page.evaluate(async ([name, value]) => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set(name, value);
}, [name, value]);
/** 一次性把 5 个控件的关键 DOM 摘要取回来（编辑态 / 运行态同一个函数，只是 root 不同）
 *  @returns {Promise<Object<string, object>>} 键 = gauge/stateImage/timer/pipe/arrow，值 = 该类型的关键字段（含 present） */
function domSummary(root, map) {
  return page.evaluate(([root, map]) => {
    const out = {};
    for (const [name, id] of Object.entries(map)) {
      const el = document.querySelector(`${root} .wd[data-id="${id}"]`);
      if (!el) { out[name] = { present: false }; continue; }
      const q = (s) => el.querySelector(s);
      const cs = (e) => (e ? getComputedStyle(e) : null);
      const g = q('.w-gauge');
      const si = q('.w-stateImage');
      const tm = q('.w-timer');
      const pp = q('.w-pipe');
      const ar = q('.w-arrow');
      const track = q('.wp-track');
      const inner = q('.wp-inner');
      const flow = q('.w-pipe-flow');
      const poly = q('.wa-shape');
      const txt = q('.wg-value');
      const needle = q('.wg-needle');
      const info = {
        gauge: g ? {
          state: g.dataset.gaugeState || '', value: g.dataset.gaugeValue || '',
          start: g.dataset.startAngle || '', sweep: g.dataset.sweepAngle || '',
          text: txt ? txt.textContent : '', fill: txt ? txt.getAttribute('fill') : '',
          arc: q('.wg-arc')?.getAttribute('d') || '',
          nx: needle?.getAttribute('x2') || '', ny: needle?.getAttribute('y2') || '',
          hasValue: !!txt,
        } : null,
        stateImage: si ? {
          src: q('.si-img')?.getAttribute('src') || '',
          fit: q('.si-img')?.style.objectFit || '',
          dataFit: si.dataset.fit || '',
          value: si.dataset.stateValue || '',
          radius: si.style.borderRadius || '',
          borderW: cs(si).borderTopWidth,
          borderC: cs(si).borderTopColor,
          empty: si.classList.contains('si-empty'),
        } : null,
        timer: tm ? {
          text: q('.wt-val')?.textContent ?? '',
          pre: q('.wt-pre')?.textContent ?? '',
          suf: q('.wt-suf')?.textContent ?? '',
          fmt: tm.dataset.fmt || '', sec: tm.dataset.sec || '',
          weight: cs(tm).fontWeight,
          align: cs(tm).justifyContent,
        } : null,
        pipe: pp ? {
          vertical: pp.dataset.vertical || '', flow: pp.dataset.flow || '', speed: pp.dataset.flowSpeed || '',
          flowDir: pp.dataset.flowDir || '',
          trackH: track ? cs(track).height : '', trackW: track ? cs(track).width : '',
          trackBg: track ? cs(track).backgroundColor : '',
          innerBg: inner ? cs(inner).backgroundColor : '',
          radius: track ? cs(track).borderRadius : '',
          hasFlow: !!flow,
          animName: flow ? cs(flow).animationName : '',
          animDur: flow ? cs(flow).animationDuration : '',
          animDir: flow ? cs(flow).animationDirection : '',
        } : null,
        arrow: ar ? {
          dir: ar.dataset.dir || '', size: ar.dataset.size || '', thickness: ar.dataset.thickness || '',
          outline: ar.dataset.outline || '',
          transform: q('.wa-svg g')?.getAttribute('transform') || '',
          points: poly?.getAttribute('points') || '',
          fill: poly?.getAttribute('fill') || '',
          stroke: poly?.getAttribute('stroke') || '',
          strokeWidth: poly?.getAttribute('stroke-width') || '',
        } : null,
      };
      // 同一个控件类型可能有多个实例（方向变量用例），按 DOM 里实际是哪种类型取摘要，不能按 key 取
      const one = g ? info.gauge : si ? info.stateImage : tm ? info.timer : pp ? info.pipe : ar ? info.arrow : null;
      out[name] = { present: true, ...(one || {}) };
    }
    return out;
  }, [root, map]);
}
const editDom = () => domSummary('#canvas', ids);
const runDom = () => domSummary('#rtPage', ids);

/* ═══════════ 1. 注册 + 工具箱（5 个成组、顺序固定）═══════════ */
const reg = await page.evaluate(async (types) => {
  const { registry } = await import('/js/widgets/registry.js');
  const out = {};
  types.forEach(t => {
    const d = registry.get(t);
    out[t] = d ? {
      title: d.title, sub: d.sub, icon: d.icon, hidden: !!d.hidden,
      hasW: Number.isFinite(d.defaults?.w), hasH: Number.isFinite(d.defaults?.h),
      props: (d.props || []).map(p => p.key),
      hints: (d.props || []).filter(p => p.hint !== undefined).map(p => p.key),
      binding: d.binding, actions: d.actions,
      defKeys: Object.keys(d.defaults || {}),
      renderOk: (() => { try { return typeof d.render === 'function' && typeof d.render({ props: { ...d.defaults }, bindings: {}, w: d.defaults.w, h: d.defaults.h }, 'edit', new Map()) === 'string'; } catch { return false; } })(),
    } : null;
  });
  out.order = registry.list().filter(d => types.includes(d.type)).map(d => d.type);
  out.listLen = registry.list().length;
  return out;
}, TYPES);
ok('5 个控件都注册成功（registry 里拿得到、render 能跑出 HTML）',
  TYPES.every(t => reg[t] && reg[t].renderOk),
  TYPES.map(t => t + '=' + !!reg[t]).join(' '));
ok('每个控件都有 title/sub/icon/默认 w/h/props',
  TYPES.every(t => reg[t] && reg[t].title && reg[t].sub && /^<svg/.test(reg[t].icon || '')
    && reg[t].hasW && reg[t].hasH && reg[t].props.length > 0),
  JSON.stringify(TYPES.map(t => [t, reg[t]?.props?.length])));
ok('绑定声明：5 个控件都能绑变量；pipe/arrow 多了「方向变量（可选）」',
  !!reg.gauge.binding?.variable && !!reg.stateImage.binding?.variable && !!reg.timer.binding?.variable
  && !!reg.pipe.binding?.variable && !!reg.arrow.binding?.variable
  && reg.pipe.binding.variable.label === '方向变量（可选）'
  && reg.arrow.binding.variable.label === '方向变量（可选）'
  && reg.pipe.binding.variable.types.includes('string')
  && reg.arrow.binding.variable.types.includes('string'),
  JSON.stringify({ pipe: reg.pipe.binding, arrow: reg.arrow.binding }));
ok('5 个控件的 props 都没有 hint（面板上不摊说明文字）',
  TYPES.every(t => reg[t] && Array.isArray(reg[t].hints) && reg[t].hints.length === 0),
  TYPES.map(t => t + ':' + (reg[t] ? reg[t].hints.join('/') : '')).join(' '));
ok('纯显示控件都没有动作（actions=[] → 属性面板不出「动作」栏）',
  TYPES.every(t => Array.isArray(reg[t].actions) && reg[t].actions.length === 0));
ok('注册顺序里 5 个控件连续，且顺序 = 仪表盘→多状态图片→计时→管道→箭头',
  reg.order.join() === TYPES.join(), reg.order.join());

const toolbox = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#toolboxList .tb-item')];
  return {
    names: items.map(e => e.querySelector('.tb-item-name')?.textContent || ''),
    svgs: items.map(e => !!e.querySelector('svg')),
    tips: items.map(e => e.title),
    groups: items.map(e => e.dataset.group || ''),
    heads: [...document.querySelectorAll('#toolboxList .tb-group-head')].map(e => e.dataset.group),
  };
});
const idx = TITLES.map(t => toolbox.names.findIndex(n => n === t));
ok('工具箱里 5 个条目都在（名称和图标齐全，说明在悬停提示里）',
  idx.every(i => i >= 0) && idx.every(i => toolbox.svgs[i] && (toolbox.tips[i] || '').length > 0),
  JSON.stringify(idx));
const density = await page.evaluate(() => {
  const list = document.getElementById('toolboxList');
  const group = list.querySelector('.tb-group-body[data-group="input"]');
  const oldWidth = list.style.width;
  const columns = [];
  for (const width of ['178px', '280px']) {
    list.style.width = width;
    columns.push(getComputedStyle(group).gridTemplateColumns.split(' ').length);
  }
  const height = group.querySelector('.tb-item').getBoundingClientRect().height;
  list.style.width = oldWidth;
  return { columns, height, inputItems: group.querySelectorAll('.tb-item').length, subtitles: list.querySelectorAll('.tb-item .sub').length };
});
ok('窄栏单列，常用宽度双列，卡片无常显说明',
  density.columns.join() === '1,2' && density.height <= 32 && density.subtitles === 0,
  JSON.stringify(density));
// 工具箱按用途分组了（2.1.20）：不再要求这几条挨在一起，改按"落在哪个组"验。
// 显示类的在 display 组，管道/箭头是装饰件，在 deco 组。
const groupOfTitle = t => toolbox.groups[toolbox.names.indexOf(t)];
ok('工具箱分组正确：仪表盘/多状态图片/计时 →「显示」，管道/箭头 →「装饰」',
  JSON.stringify(TITLES.map(groupOfTitle)) === JSON.stringify(['display', 'display', 'display', 'deco', 'deco'])
    && toolbox.heads.includes('display') && toolbox.heads.includes('deco'),
  TITLES.map(t => `${t}@${groupOfTitle(t)}`).join(' '));

// 组头点一下收起、再点展开，状态记本机（localStorage['hmi-toolbox-collapsed']）
const collapse = await page.evaluate(() => {
  const head = document.querySelector('#toolboxList .tb-group-head[data-group="input"]');
  const body = document.querySelector('#toolboxList .tb-group-body[data-group="input"]');
  head.click();
  return {
    hidden: body.hidden,
    caret: head.querySelector('.tb-group-caret')?.textContent,
    saved: localStorage.getItem('hmi-toolbox-collapsed') || '',
    expanded: head.getAttribute('aria-expanded'),
  };
});
ok('工具箱组头点一下收起：条目藏起来、箭头变 ▸、状态记进 localStorage',
  collapse.hidden === true && collapse.caret === '▸' && /"input"/.test(collapse.saved) && collapse.expanded === 'false',
  JSON.stringify(collapse));
const expand = await page.evaluate(() => {
  const head = document.querySelector('#toolboxList .tb-group-head[data-group="input"]');
  const body = document.querySelector('#toolboxList .tb-group-body[data-group="input"]');
  head.click();
  return { hidden: body.hidden, expanded: head.getAttribute('aria-expanded'),
    saved: localStorage.getItem('hmi-toolbox-collapsed') || '', items: body.querySelectorAll('.tb-item').length };
});
ok('再点一下展开：条目回来、localStorage 里不再记着它',
  expand.hidden === false && expand.expanded === 'true' && !/"input"/.test(expand.saved) && expand.items === density.inputItems,
  JSON.stringify(expand));

/* ═══════════ 2. 属性面板：能选中、schema 长对了、改一下真的生效 ═══════════ */
const schemaCases = [
  ['gauge', '仪表盘', ['min', 'max', 'decimals', 'unit', 'warnAt', 'warnColor', 'criticalAt', 'criticalColor', 'showValue', 'needleColor', 'bgColor', 'tickColor', 'fontSize', 'startAngle', 'sweepAngle']],
  ['stateImage', '多状态图片', ['images', 'fallback', 'fit', 'radius', 'borderColor', 'borderWidth']],
  ['timer', '计时', ['fmt', 'prefix', 'suffix', 'fontSize', 'textColor', 'bold', 'align', 'bgColor', 'borderColor', 'borderWidth', 'radius']],
  ['pipe', '管道', ['vertical', 'thickness', 'color', 'innerColor', 'flow', 'flowDir', 'flowSpeed', 'radius']],
  ['arrow', '箭头', ['dir', 'size', 'color', 'outline', 'thickness']],
];
for (const [key, title, wantKeys] of schemaCases) {
  await selectWidget(ids[key]);
  const pane = await panelSchema();
  const got = pane.fields.map(f => f.key);
  const missing = wantKeys.filter(k => !got.includes(k));
  ok(`属性面板能选中「${title}」（标题 = ${title} 属性）`, pane.titles.includes(`${title} 属性`),
    pane.titles.join(' | ').slice(0, 120));
  ok(`「${title}」面板按 props 长出全部属性行`, missing.length === 0,
    missing.length ? '缺：' + missing.join(',') : wantKeys.length + ' 行');
}

// 面板不是摆设：每个控件真的改一格 → 工程数据 + 画布都要跟着变
await selectWidget(ids.gauge);
const okGaugeDec = await panelEdit('decimals', 1);
await sleep(120);
ok('仪表盘面板改「小数位」→ 写进工程 + 画布数值多一位小数',
  okGaugeDec && (await propOf(ids.gauge, 'decimals')) === 1,
  `props.decimals=${await propOf(ids.gauge, 'decimals')}`);

await selectWidget(ids.stateImage);
const okSiImgs = await panelEdit('images', `0=${IMG_OFF}\n1=${IMG_ON}`);
await sleep(120);
const okSiFit = await panelEdit('fit', 'cover', 'select');
await sleep(120);
ok('多状态图片面板填「状态图」+ 改「显示方式」→ props 写进工程 + 图片 object-fit 跟着变',
  okSiImgs && okSiFit && (await propOf(ids.stateImage, 'fit')) === 'cover'
  && (await editDom()).stateImage.src === IMG_OFF
  && (await editDom()).stateImage.fit === 'cover',
  `fit=${await propOf(ids.stateImage, 'fit')} domFit=${(await editDom()).stateImage.fit}`);

await selectWidget(ids.timer);
const okTimerBold = await panelEdit('bold', true, 'check');
await sleep(120);
ok('计时面板勾「加粗」→ props.bold=true + 画布 font-weight 700',
  okTimerBold && (await propOf(ids.timer, 'bold')) === true
  && (await editDom()).timer.weight === '700',
  `weight=${(await editDom()).timer.weight}`);

await selectWidget(ids.pipe);
const okPipeTh = await panelEdit('thickness', 30);
await sleep(120);
ok('管道面板改「粗细」→ props.thickness=30 + 画布轨道高 30px',
  okPipeTh && (await propOf(ids.pipe, 'thickness')) === 30
  && (await editDom()).pipe.trackH === '30px',
  `thickness=${await propOf(ids.pipe, 'thickness')} trackH=${(await editDom()).pipe.trackH}`);

await selectWidget(ids.arrow);
const okArrowDir = await panelEdit('dir', 'up', 'select');
await sleep(120);
ok('箭头面板改「方向」→ props.dir=up + 画布旋转 270°',
  okArrowDir && (await propOf(ids.arrow, 'dir')) === 'up'
  && /rotate\(270 /.test((await editDom()).arrow.transform),
  (await editDom()).arrow.transform);

// 真·鼠标点击选中（不只是脚本调 select）：画布上点一下仪表盘，面板切到它
await page.evaluate(() => {
  const el = document.querySelector(`#canvas .wd[data-id]`);
  el?.scrollIntoView({ block: 'center', inline: 'center' });
});
await sleep(100);
const gaugeBox = await page.locator(`#canvas .wd[data-id="${ids.gauge}"]`).boundingBox();
if (gaugeBox) await page.mouse.click(gaugeBox.x + gaugeBox.width / 2, gaugeBox.y + gaugeBox.height / 2);
await sleep(150);
const clickedSel = await page.evaluate((id) => ({
  selected: document.querySelector(`#canvas .wd[data-id="${id}"]`)?.classList.contains('selected') || false,
  title: [...document.querySelectorAll('#propBody .prop-group-title')].map(e => e.textContent.trim()).join(' | '),
}), ids.gauge);
ok('在画布上真点一下仪表盘 → 选中 + 属性面板切到「仪表盘 属性」',
  clickedSel.selected && clickedSel.title.includes('仪表盘 属性'), JSON.stringify(clickedSel).slice(0, 160));

/* ═══════════ 3. 配好场景属性（之后编辑态 / 运行态都用这一套）═══════════ */
await setProps(ids.gauge, {
  min: 0, max: 100, decimals: 1, unit: '℃',
  warnAt: 80, warnColor: '#f59e0b', criticalAt: 90, criticalColor: '#ef4444',
  showValue: true, arcColor: '#2563eb', needleColor: '#1f2329',
  bgColor: '', tickColor: '#64748b', fontSize: 22, startAngle: 135, sweepAngle: 270,
});
await setProps(ids.stateImage, {
  images: `0=${IMG_OFF}\n1=${IMG_ON}`,
  fallback: IMG_FALLBACK,
  fit: 'cover', radius: 10, borderColor: '#123456', borderWidth: 2,
});
await setProps(ids.timer, {
  fmt: 'hms', prefix: '运行中', suffix: '秒',
  fontSize: 24, textColor: '#0f172a', bold: true, align: 'center',
  bgColor: '#ffffff', borderColor: '#94a3b8', borderWidth: 1, radius: 6,
});
await setProps(ids.pipe, {
  vertical: false, thickness: 30, color: '#ff0000', innerColor: '#00ff00',
  flow: true, flowDir: 'fwd', flowSpeed: 1.5, radius: 10,
});
await setProps(ids.arrow, {
  dir: 'right', size: 60, color: '#52606d', outline: false, thickness: 8,
});
// 方向变量用例：数值变量那组静态 flowDir 故意设成反向（好验"0 = 按静态"）；字符串那组同样
await setProps(ids.pipeVar, { vertical: false, thickness: 16, color: '#94a3b8', innerColor: '#e2e8f0', flow: true, flowDir: 'rev', flowSpeed: 1.2, radius: 6 });
await setProps(ids.pipeStr, { vertical: false, thickness: 16, color: '#94a3b8', innerColor: '#e2e8f0', flow: true, flowDir: 'rev', flowSpeed: 1.2, radius: 6 });
// bool 方向变量那组：静态 flowDir 设成**正向**（bool false 必须给出 rev 才能证明是变量说了算）
await setProps(ids.pipeBool, { vertical: false, thickness: 16, color: '#94a3b8', innerColor: '#e2e8f0', flow: true, flowDir: 'fwd', flowSpeed: 1.2, radius: 6 });
await setProps(ids.arrowVar, { dir: 'down', size: 60, color: '#52606d', outline: false, thickness: 8 });
await setProps(ids.arrowStr, { dir: 'left', size: 60, color: '#52606d', outline: false, thickness: 8 });
await page.evaluate(() => window.app.project.commit('显示类控件测试：场景属性'));
await sleep(250);

/* ═══════════ 4. 编辑态渲染 ═══════════ */
await setVar('rGaugeVal', 25);
await setVar('iStateVal', 0);
await setVar('rTimerVal', 3661);
await setVar('iDirNum', 0);
await setVar('sDir', '');
await sleep(200);
let ed = await editDom();

/* 4.1 仪表盘 */
ok('仪表盘编辑态画出内联 SVG 圆弧+指针+数值（25 → 25.0℃ / 正常色）',
  ed.gauge && ed.gauge.hasValue && ed.gauge.text === '25.0℃' && ed.gauge.state === 'normal'
  && /^M /.test(ed.gauge.arc) && ed.gauge.nx !== '',
  JSON.stringify(ed.gauge && { text: ed.gauge.text, state: ed.gauge.state, nx: ed.gauge.nx }));
const gaugeNormalFill = ed.gauge.fill;
ok('仪表盘数值颜色：正常状态用「数值色」',
  gaugeNormalFill === '#1f2329', gaugeNormalFill);
// 指针角度 = 135 + 270*0.25 = 202.5（用属性面板的起始/扫过角度算出来的）
ok('仪表盘指针角度按 min~max 折算（25/100 → 202.5°）',
  Math.abs(Number(ed.gauge.nx) - 100 - Math.cos(202.5 * Math.PI / 180) * 64) < 0.6
  && Math.abs(Number(ed.gauge.ny) - 100 - Math.sin(202.5 * Math.PI / 180) * 64) < 0.6,
  JSON.stringify({ nx: ed.gauge.nx, ny: ed.gauge.ny }));

await setVar('rGaugeVal', 85);
await sleep(150);
ed = await editDom();
const warnState = ed.gauge;
ok('仪表盘超过警告阈值（85 ≥ warnAt 80）→ 超限变色（warn）',
  warnState.state === 'warn' && warnState.fill === '#f59e0b' && warnState.text === '85.0℃',
  JSON.stringify({ state: warnState.state, fill: warnState.fill, text: warnState.text }));

await setVar('rGaugeVal', 95);
await sleep(150);
ed = await editDom();
const critState = ed.gauge;
ok('仪表盘超过严重阈值（95 ≥ criticalAt 90）→ 严重色（critical 优先于 warn）',
  critState.state === 'critical' && critState.fill === '#ef4444',
  JSON.stringify({ state: critState.state, fill: critState.fill }));

await setProp(ids.gauge, 'showValue', false);
ed = await editDom();
ok('仪表盘「显示数值」关掉 → 画布上不再有数值文字', ed.gauge.hasValue === false);
await setProp(ids.gauge, 'showValue', true);
const d0 = (await editDom()).gauge.arc;
await setProp(ids.gauge, 'startAngle', 90);
await setProp(ids.gauge, 'sweepAngle', 180);
ed = await editDom();
ok('仪表盘起始角度/扫过角度可调（圆弧路径跟着变、缺省 135°/270°）',
  ed.gauge.start === '90' && ed.gauge.sweep === '180' && ed.gauge.arc !== d0,
  JSON.stringify({ start: ed.gauge.start, sweep: ed.gauge.sweep, changed: ed.gauge.arc !== d0 }));
await setProps(ids.gauge, { startAngle: 135, sweepAngle: 270 });
await setVar('rGaugeVal', 25);
await sleep(150);

/* 4.2 多状态图片 */
ed = await editDom();
ok('多状态图片编辑态：变量值 0 → 显示第一张状态图（dataURL 原样进 DOM）',
  ed.stateImage.src === IMG_OFF && ed.stateImage.value === '0' && ed.stateImage.empty === false,
  JSON.stringify({ src: ed.stateImage.src.slice(0, 28), value: ed.stateImage.value }));
ok('多状态图片：fit/圆角/边框都写进内联样式',
  ed.stateImage.fit === 'cover' && ed.stateImage.dataFit === 'cover'
  && ed.stateImage.radius === '10px' && ed.stateImage.borderW === '2px'
  && /rgb\(18, 52, 86\)/.test(ed.stateImage.borderC),
  JSON.stringify({ fit: ed.stateImage.fit, radius: ed.stateImage.radius, bw: ed.stateImage.borderW, bc: ed.stateImage.borderC }));
await setVar('iStateVal', 1);
await sleep(150);
ed = await editDom();
ok('多状态图片：变量值变 1 → 切到第二张图', ed.stateImage.src === IMG_ON, ed.stateImage.src.slice(0, 28));

/* 4.3 计时 */
ok('计时编辑态：3661 秒 → 01:01:01（前缀/后缀 + 加粗）',
  ed.timer.text === '01:01:01' && ed.timer.pre === '运行中' && ed.timer.suf === '秒'
  && ed.timer.weight === '700' && ed.timer.fmt === 'hms',
  JSON.stringify({ text: ed.timer.text, pre: ed.timer.pre, suf: ed.timer.suf, w: ed.timer.weight }));
await setProp(ids.timer, 'fmt', 'dhms');
await setVar('rTimerVal', 90061);
await sleep(120);
ed = await editDom();
ok('计时「天 时:分:秒」格式：90061 → 1天 01:01:01', ed.timer.text === '1天 01:01:01', ed.timer.text);
await setProp(ids.timer, 'fmt', 'hm');
await setVar('rTimerVal', 3661);
await sleep(120);
ed = await editDom();
ok('计时「时:分」格式：3661 → 01:01', ed.timer.text === '01:01', ed.timer.text);
await setProp(ids.timer, 'fmt', 's');
ed = await editDom();
ok('计时「秒」格式：3661 → 3661', ed.timer.text === '3661', ed.timer.text);
await setProp(ids.timer, 'fmt', 'hms');
await setVar('rTimerVal', -5);
await sleep(120);
ed = await editDom();
ok('计时负值 → 00:00:00（不显示负数）', ed.timer.text === '00:00:00', ed.timer.text);
await setVar('rTimerVal', 0);
await sleep(120);
ed = await editDom();
ok('计时 0 → 00:00:00', ed.timer.text === '00:00:00', ed.timer.text);
await setVar('rTimerVal', 3661);
await sleep(120);

/* 4.4 管道 */
ed = await editDom();
ok('管道编辑态：横管（粗 30px / 外壁红 / 内壁绿 / 圆角 10）',
  ed.pipe.vertical === '0' && ed.pipe.trackH === '30px' && ed.pipe.trackBg === 'rgb(255, 0, 0)'
  && ed.pipe.innerBg === 'rgb(0, 255, 0)' && ed.pipe.radius === '10px',
  JSON.stringify({ v: ed.pipe.vertical, h: ed.pipe.trackH, bg: ed.pipe.trackBg, inner: ed.pipe.innerBg }));
ok('管道流动动画：有流动层、1.5s 一圈、横向动画名（-x）',
  ed.pipe.hasFlow && /^wp.+?-x$/.test(ed.pipe.animName) && ed.pipe.animDur === '1.5s',
  JSON.stringify({ anim: ed.pipe.animName, dur: ed.pipe.animDur }));
await setProp(ids.pipe, 'vertical', true);
ed = await editDom();
ok('管道竖着画：轨道宽 = 粗细、流动方向变上下（动画名 -y）',
  ed.pipe.vertical === '1' && ed.pipe.trackW === '30px' && /-y$/.test(ed.pipe.animName),
  JSON.stringify({ v: ed.pipe.vertical, w: ed.pipe.trackW, anim: ed.pipe.animName }));
await setProp(ids.pipe, 'flow', false);
ed = await editDom();
ok('管道关掉流动 → 没有流动层（静态管道）', ed.pipe.hasFlow === false);
await setProps(ids.pipe, { vertical: false, flow: true });

/* 4.5 箭头 */
ed = await editDom();
ok('箭头编辑态：向右实心（rotate 0° + fill 颜色 + 7 点多边形）',
  ed.arrow.dir === 'right' && /rotate\(0 /.test(ed.arrow.transform)
  && ed.arrow.fill === '#52606d' && ed.arrow.stroke === 'none'
  && ed.arrow.points.split(' ').length === 7,
  JSON.stringify({ dir: ed.arrow.dir, t: ed.arrow.transform, fill: ed.arrow.fill, pts: ed.arrow.points.split(' ').length }));
const pts60 = ed.arrow.points;
const dirAngles = [];
for (const [dir, deg] of [['down', 90], ['left', 180], ['up', 270], ['right', 0]]) {
  await setProp(ids.arrow, 'dir', dir);
  const now = (await editDom()).arrow;
  dirAngles.push(`${dir}:${now.transform}`);
  ok(`箭头方向「${dir}」→ 旋转 ${deg}°`,
    now.dir === dir && now.transform === `rotate(${deg} 50 50)`, now.transform);
}
await setProp(ids.arrow, 'size', 120);
ed = await editDom();
const firstX = (pts) => Number(pts.split(' ')[0].split(',')[0]);
ok('箭头「大小」变了 → 箭头变长（同一个控件框里按 px 换算）',
  ed.arrow.size === '120' && firstX(ed.arrow.points) < firstX(pts60),
  JSON.stringify({ size: ed.arrow.size, x60: firstX(pts60), x120: firstX(ed.arrow.points) }));
await setProps(ids.arrow, { outline: true, thickness: 12, color: '#123456' });
ed = await editDom();
ok('箭头勾「空心」→ 只描边（fill=none + stroke-width 跟着粗细变）',
  ed.arrow.fill === 'none' && ed.arrow.stroke === '#123456' && ed.arrow.strokeWidth === '15'
  && ed.arrow.thickness === '12',
  JSON.stringify({ fill: ed.arrow.fill, stroke: ed.arrow.stroke, sw: ed.arrow.strokeWidth }));
await setProps(ids.arrow, { dir: 'right', size: 60, outline: false, thickness: 8, color: '#52606d' });

/* 4.6 管道：流动方向由变量控制（绑定是可选的） */
ed = await editDom();
ok('管道没绑方向变量 = 老行为（data-flow-dir=fwd、动画正放）',
  ed.pipe.flowDir === 'fwd' && ed.pipe.animDir === 'normal',
  JSON.stringify({ dir: ed.pipe.flowDir, anim: ed.pipe.animDir }));

await setVar('iDirNum', 1);
await sleep(150);
ed = await editDom();
ok('管道：数值方向变量 = 1（>0）→ 正向 fwd、动画正放',
  ed.pipeVar.flowDir === 'fwd' && ed.pipeVar.animDir === 'normal',
  JSON.stringify({ dir: ed.pipeVar.flowDir, anim: ed.pipeVar.animDir }));
await setVar('iDirNum', -1);
await sleep(150);
ed = await editDom();
ok('管道：数值方向变量 = -1（<0）→ 反向 rev、animation-direction:reverse',
  ed.pipeVar.flowDir === 'rev' && ed.pipeVar.animDir === 'reverse',
  JSON.stringify({ dir: ed.pipeVar.flowDir, anim: ed.pipeVar.animDir }));
await setVar('iDirNum', 0);
await sleep(150);
ed = await editDom();
ok('管道：数值方向变量 = 0 → 按属性里的静态 flowDir（这组静态是 rev）',
  ed.pipeVar.flowDir === 'rev', JSON.stringify({ dir: ed.pipeVar.flowDir }));

// 字符串方向变量的取值约定（capital / 空格都不敏感）
const pipeStrCases = [
  ['right', 'fwd'], ['down', 'fwd'], ['正', 'fwd'], ['正转', 'fwd'], ['forward', 'fwd'],
  ['left', 'rev'], ['up', 'rev'], ['反', 'rev'], ['反转', 'rev'], ['reverse', 'rev'],
  ['  LEFT  ', 'rev'], ['DOWN', 'fwd'],
];
const gotPipeStr = [];
for (const [s, want] of pipeStrCases) {
  await setVar('sDir', s);
  await sleep(110);
  gotPipeStr.push({ s, got: (await editDom()).pipeStr.flowDir, want });
}
const badPipeStr = gotPipeStr.filter(x => x.got !== x.want);
ok('管道：字符串 right/down/正/正转/forward → 正向；left/up/反/反转/reverse → 反向（大小写/空格不敏感）',
  badPipeStr.length === 0, JSON.stringify(badPipeStr));
await setVar('sDir', 'xyz');
await sleep(150);
ed = await editDom();
ok('管道：认不出的字符串 → 按静态 flowDir（这组静态是 rev）',
  ed.pipeStr.flowDir === 'rev', JSON.stringify({ dir: ed.pipeStr.flowDir }));
await setVar('sDir', '');
await sleep(150);

/* 4.6b 管道：bool 方向变量按 1/0 判断（现场要"bool 量 0 和 1 判断方向"）—— 1=正向、0=反向 */
await setVar('bDir', true);
await sleep(150);
ed = await editDom();
ok('管道：bool 方向变量 = true（1）→ 正向 fwd、动画正放',
  ed.pipeBool.flowDir === 'fwd' && ed.pipeBool.animDir === 'normal',
  JSON.stringify({ dir: ed.pipeBool.flowDir, anim: ed.pipeBool.animDir }));
await setVar('bDir', false);
await sleep(150);
ed = await editDom();
ok('管道：bool 方向变量 = false（0）→ 反向 rev（**不再当成"没给方向"**）、动画倒放',
  ed.pipeBool.flowDir === 'rev' && ed.pipeBool.animDir === 'reverse',
  JSON.stringify({ dir: ed.pipeBool.flowDir, anim: ed.pipeBool.animDir }));
await setVar('bDir', true);
await sleep(150);

/* 4.7 箭头：方向由变量控制（绑定是可选的） */
ed = await editDom();
ok('箭头没绑方向变量 = 老行为（data-dir=right、rotate 0°）',
  ed.arrow.dir === 'right' && /rotate\(0 /.test(ed.arrow.transform),
  JSON.stringify({ dir: ed.arrow.dir, t: ed.arrow.transform }));
for (const [n, dir, deg] of [[1, 'up', 270], [2, 'right', 0], [3, 'down', 90], [4, 'left', 180]]) {
  await setVar('iDirNum', n);
  await sleep(140);
  const a = (await editDom()).arrowVar;
  ok(`箭头：数值方向变量 ${n} → ${dir}（rotate ${deg}°）`,
    a.dir === dir && a.transform === `rotate(${deg} 50 50)`,
    JSON.stringify({ dir: a.dir, t: a.transform }));
}
await setVar('iDirNum', 0);
await sleep(140);
ed = await editDom();
ok('箭头：数值方向变量 = 0 → 按静态 dir（这组静态是 down、rotate 90°）',
  ed.arrowVar.dir === 'down' && ed.arrowVar.transform === 'rotate(90 50 50)',
  JSON.stringify({ dir: ed.arrowVar.dir, t: ed.arrowVar.transform }));
await setVar('iDirNum', 5);
await sleep(140);
ed = await editDom();
ok('箭头：数值方向变量 = 5（认不出）→ 也按静态 dir（down）',
  ed.arrowVar.dir === 'down', JSON.stringify({ dir: ed.arrowVar.dir }));

const arrowStrCases = [
  ['up', 'up', 270], ['上', 'up', 270], ['RIGHT', 'right', 0], ['down', 'down', 90],
  ['左', 'left', 180], ['3', 'down', 90], [' 2 ', 'right', 0],
];
const gotArrowStr = [];
for (const [s, dir, deg] of arrowStrCases) {
  await setVar('sDir', s);
  await sleep(110);
  const a = (await editDom()).arrowStr;
  gotArrowStr.push({ s, dir: a.dir, t: a.transform, wantDir: dir, wantDeg: deg });
}
const badArrowStr = gotArrowStr.filter(x => x.dir !== x.wantDir || x.t !== `rotate(${x.wantDeg} 50 50)`);
ok('箭头：字符串 up/上/RIGHT/down/左/3/2 → 对应方向（大小写/空格不敏感，数字字符串也认）',
  badArrowStr.length === 0, JSON.stringify(badArrowStr));
await setVar('sDir', 'blah');
await sleep(140);
ed = await editDom();
ok('箭头：认不出的字符串 → 按静态 dir（这组静态是 left、rotate 180°）',
  ed.arrowStr.dir === 'left' && ed.arrowStr.transform === 'rotate(180 50 50)',
  JSON.stringify({ dir: ed.arrowStr.dir, t: ed.arrowStr.transform }));
await setVar('sDir', '');
await sleep(140);

/* ═══════════ 5. 多语言：单位/前后缀走 tr()（props 里的 i18n 声明 + 渲染时翻译）═══════════ */
const i18n = await page.evaluate(async ([gaugeId, timerId]) => {
  const i = await import('/js/core/i18n.js');
  i.addLanguage('en', 'English');
  const s = i.i18nState();
  if (!s.dict.en) s.dict.en = {};
  s.dict.en['℃'] = '°C';
  s.dict.en['运行中'] = 'Running';
  s.dict.en['秒'] = 's';
  const entries = i.collectEntries().map(r => r.source);
  i.setLang('en');
  return { entries, lang: i.getLang() };
}, [ids.gauge, ids.timer]);
await sleep(200);
ed = await editDom();
ok('多语言：gauge 单位 / timer 前缀后缀在翻译表里被收集（props 的 i18n 声明生效）',
  i18n.entries.includes('℃') && i18n.entries.includes('运行中') && i18n.entries.includes('秒'),
  i18n.entries.filter(x => ['℃', '运行中', '秒'].includes(x)).join(','));
ok('多语言：切到 en 后仪表盘单位 = °C、计时前后缀 = Running/s',
  ed.gauge.text.endsWith('°C') && ed.timer.pre === 'Running' && ed.timer.suf === 's',
  JSON.stringify({ gauge: ed.gauge.text, pre: ed.timer.pre, suf: ed.timer.suf }));
await page.evaluate(async () => {
  const i = await import('/js/core/i18n.js');
  i.setLang('zh-CN');
  i.removeLanguage('en');
});
await sleep(150);
ed = await editDom();
ok('多语言：切回默认语言后又变回 ℃/运行中/秒',
  ed.gauge.text.endsWith('℃') && ed.timer.pre === '运行中' && ed.timer.suf === '秒',
  JSON.stringify({ gauge: ed.gauge.text, pre: ed.timer.pre }));
// 切语言时画布会整块重画（canvas.js 监听 i18n:lang），控件一个都不能少
ok('切语言重画后 5 个控件都还在画布上',
  TYPES.every(t => ed[t]?.present === true),
  TYPES.map(t => t + '=' + !!ed[t]?.present).join(' '));

/* ═══════════ 6. 运行态：所有控件画出来 + 绑变量的值一变就刷新 ═══════════ */
await page.evaluate(() => window.app.enterRun());
await sleep(500);
let rd = await runDom();
ok('运行态：5 个控件都渲染出来了（gauge/stateImage/timer/pipe/arrow）',
  TYPES.every(t => rd[t].present), TYPES.map(t => t + '=' + !!rd[t].present).join(' '));

await setVar('rGaugeVal', 10);
await sleep(200);
rd = await runDom();
ok('运行态：仪表盘随变量刷新（10 → 10.0℃，正常色）',
  rd.gauge.text === '10.0℃' && rd.gauge.state === 'normal',
  JSON.stringify({ text: rd.gauge.text, state: rd.gauge.state }));
await setVar('rGaugeVal', 95);
await sleep(200);
rd = await runDom();
ok('运行态：变量变 95 → 仪表盘当场刷新成 critical 红色',
  rd.gauge.state === 'critical' && rd.gauge.fill === '#ef4444' && rd.gauge.text === '95.0℃',
  JSON.stringify({ state: rd.gauge.state, text: rd.gauge.text, fill: rd.gauge.fill }));

await setVar('iStateVal', 0);
await sleep(200);
rd = await runDom();
ok('运行态：多状态图片值 0 → 第一张图（src 跟着变量走）', rd.stateImage.src === IMG_OFF,
  rd.stateImage.src.slice(0, 28));
await setVar('iStateVal', 1);
await sleep(200);
rd = await runDom();
ok('运行态：变量变 1 → 多状态图片切到第二张', rd.stateImage.src === IMG_ON, rd.stateImage.src.slice(0, 28));
await setVar('iStateVal', 2);
await sleep(200);
rd = await runDom();
ok('运行态：值 2 没有对应图 → 用兜底图', rd.stateImage.src === IMG_FALLBACK, rd.stateImage.src.slice(0, 28));
ok('运行态：值 2 时 data-state-value 记录的是真实变量值', rd.stateImage.value === '2', rd.stateImage.value);

await setVar('rTimerVal', 3661);
await sleep(200);
rd = await runDom();
ok('运行态：计时 3661 → 01:01:01', rd.timer.text === '01:01:01', rd.timer.text);
await setVar('rTimerVal', 90061);
await sleep(200);
rd = await runDom();
ok('运行态：变量变 90061 → 计时刷新成 25:01:01（小时不按 24 取模）',
  rd.timer.text === '25:01:01', rd.timer.text);

ok('运行态：没绑方向变量时 pipe/arrow 保持老行为（管道 fwd、箭头 right）',
  rd.pipe.present && rd.arrow.present && rd.pipe.hasFlow
  && rd.pipe.flowDir === 'fwd' && rd.arrow.dir === 'right',
  JSON.stringify({ dir: rd.pipe.flowDir, arrow: rd.arrow.dir, anim: rd.pipe.animName }));

// 运行态：变量一变，DOM 上的方向 / 旋转角真的跟着变（绑了变量就自动进「变量→控件」索引）
await setVar('iDirNum', -1);
await sleep(220);
rd = await runDom();
ok('运行态：管道方向变量 = -1 → data-flow-dir 变 rev（动画倒放）',
  rd.pipeVar.flowDir === 'rev' && rd.pipeVar.animDir === 'reverse',
  JSON.stringify({ dir: rd.pipeVar.flowDir, anim: rd.pipeVar.animDir }));
await setVar('iDirNum', 1);
await sleep(220);
rd = await runDom();
ok('运行态：管道方向变量 = 1 → data-flow-dir 变回 fwd（动画正放）',
  rd.pipeVar.flowDir === 'fwd' && rd.pipeVar.animDir === 'normal',
  JSON.stringify({ dir: rd.pipeVar.flowDir, anim: rd.pipeVar.animDir }));
await setVar('sDir', 'left');
await sleep(220);
rd = await runDom();
ok('运行态：管道字符串方向 = left → rev', rd.pipeStr.flowDir === 'rev', rd.pipeStr.flowDir);
await setVar('sDir', '正');
await sleep(220);
rd = await runDom();
ok('运行态：管道字符串方向 = 正 → fwd', rd.pipeStr.flowDir === 'fwd', rd.pipeStr.flowDir);

await setVar('iDirNum', 1);
await sleep(220);
rd = await runDom();
ok('运行态：箭头数值变量 = 1 → data-dir=up、rotate 270°',
  rd.arrowVar.dir === 'up' && rd.arrowVar.transform === 'rotate(270 50 50)',
  JSON.stringify({ dir: rd.arrowVar.dir, t: rd.arrowVar.transform }));
await setVar('iDirNum', 4);
await sleep(220);
rd = await runDom();
ok('运行态：箭头数值变量 = 4 → data-dir=left、rotate 180°',
  rd.arrowVar.dir === 'left' && rd.arrowVar.transform === 'rotate(180 50 50)',
  JSON.stringify({ dir: rd.arrowVar.dir, t: rd.arrowVar.transform }));
await setVar('iDirNum', 0);
await sleep(220);
rd = await runDom();
ok('运行态：箭头数值变量 = 0 → 回到静态 dir（down、rotate 90°）',
  rd.arrowVar.dir === 'down' && rd.arrowVar.transform === 'rotate(90 50 50)',
  JSON.stringify({ dir: rd.arrowVar.dir, t: rd.arrowVar.transform }));
await setVar('sDir', 'DOWN');
await sleep(220);
rd = await runDom();
ok('运行态：箭头字符串方向 = DOWN → down、rotate 90°',
  rd.arrowStr.dir === 'down' && rd.arrowStr.transform === 'rotate(90 50 50)',
  JSON.stringify({ dir: rd.arrowStr.dir, t: rd.arrowStr.transform }));
await setVar('sDir', '上');
await sleep(220);
rd = await runDom();
ok('运行态：箭头字符串方向 = 上 → up、rotate 270°',
  rd.arrowStr.dir === 'up' && rd.arrowStr.transform === 'rotate(270 50 50)',
  JSON.stringify({ dir: rd.arrowStr.dir, t: rd.arrowStr.transform }));

await page.evaluate(() => window.app.exitRun());
await sleep(200);

/* ═══════════ 7. 收尾 ═══════════ */
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 显示类控件（仪表盘/多状态图片/计时/管道/箭头）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
