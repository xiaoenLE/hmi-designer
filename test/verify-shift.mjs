// verify-shift.mjs — 新增的「班次产量」控件（总产量 / OK / NG / 每小时计数）
//
// 验什么：
//   ① 注册成功（registry 里拿得到、字段齐全、attach + scopeVars 钩子在）、工具箱里有
//   ② MCP 静态提取器能解析 def（`scopeVars: scopeVarsOf` 写法 + def 里不许写 ?.）
//   ③ 属性面板：能选中、按 props schema 长出全部输入格、**不出现 hint 说明文字**
//   ④ 编辑态渲染（标题/班次时间段/**主数据行只有总产量、OK、NG 三格**/每小时表/历史条）
//   ⑤ 纯函数：shiftWindowOf / hourKeyOf 单测（班次窗口、跨天、跨午夜、24 小时、非法值兜底）
//   ⑥ 运行态（attach 每秒采样 + api.refresh）：
//        · 总产量 100 → 显示 100；界面上**没有「本班产量」那一格**（.sh-shift 不存在）
//        · 总产量 +25 → 界面总产量 125；本班产量只在内部维护（__shiftState().shiftTotal === 25）
//        · OK / NG 绑了显示真实值（本班增量做小字）、没绑显示「—」
//        · resetVar 0→1 上升沿：本班基线归零（shiftTotal 0）、每小时表清空（不动总产量）
//        · 定期刷新：改总产量后不手动刷新，等 1.5s 界面自己跟到
//        · scopeVars：OK/NG/重置变量进了本页采集范围
//   ⑦ 历史班次（本地按天）：
//        · 运行几拍后 readShiftHistory(w) 有当前班记录（total = 本班累计增量）
//        · 历史条/日期输入在（showHistory 关时不显示）；日期默认今天
//        · 注入"昨天某班"记录 → 选昨天 → 列表有那班（产量/OK/NG 对）→ 点它主数据行=历史值
//          view='past'、不随实时变量变化；「回到本班」→ view='live' 恢复实时
//        · 当前班在历史列表里也算一行（标「进行中」）
//        · historyDays 清理：注入 40 天旧记录 → 只剩 30 天（删最老）
//   ⑧ 每小时计数持久化（localStorage 同一份 JSON 的顶层 hourly）：
//        · 每小时条目带 产量/OK/NG（按小时增量；OK/NG 没绑变量或老存档缺字段 → null / 显示「—」）
//        · 采样累加会落盘（readShiftHourly / localStorage.hourly，顶层与当前班记录都带 ok/ng）
//        · 预落盘 hourly 的控件进运行后读回（等价刷新页面读回）；老存档缺 ok/ng 不崩、显示「—」
//        · 退出运行再进运行，小时表还是之前的小时和 产量/OK/NG（不清零）
//        · 只有 resetVar 上升沿（手动清）才清空，且 localStorage 里也清
//        · 看历史班次时小时表 = 那班记录的 hourly（产量/OK/NG）；回到本班 = 实时/持久化 hourly（钩子 hourly 跟随视图）
//   ⑨ 防重复累计（现场 bug：重进运行态/刷新页面后产量没增加、班次记录却又加一遍）：
//        · 存档带 raw:{total,ok,ng}（上次采样的原始计数）
//        · 进运行后前 2 拍只更新显示、不累加；稳定期结束那拍再对齐 last*（也不累加）
//        · 刷新页面（清内存+存档保留）/老存档缺 raw/直接 exitRun→enterRun 都不重复加；
//          之后正常生产增量照记
//   ⑩ 全程无未捕获 JS 异常
//
// 用法：node test/verify-shift.mjs
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

const PROPS = ['title', 'shiftStart', 'shiftHours', 'showShiftTime',
  'showHourly', 'hourlyRows', 'refreshMs', 'showHistory', 'historyDays',
  'fontSize', 'numberSize', 'textColor', 'okColor', 'ngColor',
  'bgColor', 'borderColor', 'borderWidth', 'radius'];

/* ── 0. MCP 静态提取（def 里写 `?.` / scopeVars 方法体太复杂都会把解析器弄崩） ── */
let statics = null;
try {
  const mcp = await import('file:///' + path.resolve(ROOT, '..', 'hmi-mcp', 'tools', 'extract-catalog.mjs').replace(/\\/g, '/'));
  statics = mcp.parseDefs(DEFDIR);
} catch (e) {
  statics = { error: String((e && e.message) || e) };
}
const staticShift = Array.isArray(statics) ? statics.find(w => w.type === 'shift') : null;
ok('MCP 静态提取器能解析 defs/（shift def 里没写 ?.）', Array.isArray(statics), statics.error || '');
ok('MCP 静态提取出「班次产量」控件', !!staticShift, staticShift ? staticShift.title : 'missing');

/* ── 起隔离后端 + 浏览器 ── */
const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shift-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let browser = null;
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

/* ═══════════ 1. 造变量 + 控件 ═══════════ */
const ids = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const target = project.pages().find(p => p.type === 'page');
  if (!target) throw new Error('演示工程里没有普通页');
  project.setCurrentPage(target.id);
  const defs = [
    ['rTotal', 'real', 100],      // 总产量计数（binding.variable）
    ['rOk', 'int', 90],           // OK 计数（okVar）
    ['rNg', 'int', 10],           // NG 计数（ngVar）
    ['bReset', 'bool', false],    // 重置（resetVar，上升沿）
    // 第 4 个班次控件专用：模拟"刷新页面后 varStore 退回工程初值(500/400/5)、
    // 后端实际累计值是旧的(525/490/15)"的现场 bug 场景（不影响其它控件的变量）
    ['rTotal2', 'real', 500],
    ['rOk2', 'int', 400],
    ['rNg2', 'int', 5],
  ];
  defs.forEach(([name, type, value]) => {
    const old = project.data.variables.find(v => v.name === name);
    if (old) { old.type = type; old.value = value; old.address = ''; }
    else project.data.variables.push({ name, type, address: '', value });
  });
  project.commit('班次产量测试：变量');
  varStore.resetFrom(project.variables());
  const w = project.addWidget('shift', 40, 60);
  project.updateWidgetField(w.id, 'w', 430);
  project.updateWidgetField(w.id, 'h', 330);
  project.updateWidgetField(w.id, 'bindings.variable', 'rTotal');
  // 统计变量走**绑定扩展**（属性面板里是变量选择框）：bindings.ok / ng / reset
  project.updateWidgetField(w.id, 'bindings.ok', 'rOk');
  project.updateWidgetField(w.id, 'bindings.ng', 'rNg');
  project.updateWidgetField(w.id, 'bindings.reset', 'bReset');
  project.updateWidgetProp(w.id, 'shiftStart', '08:00');
  project.updateWidgetProp(w.id, 'shiftHours', 8);
  // 第二个班次控件：专门验 historyDays 清理（40 天旧记录 → 只留 30）
  const w2 = project.addWidget('shift', 500, 60);
  project.updateWidgetField(w2.id, 'w', 300);
  project.updateWidgetField(w2.id, 'h', 240);
  project.updateWidgetField(w2.id, 'bindings.variable', 'rTotal');
  project.updateWidgetProp(w2.id, 'historyDays', 30);
  // 第三个班次控件：预落盘一份 hourly（等价"刷新页面前磁盘里已有小时计数"）
  const w3 = project.addWidget('shift', 40, 420);
  project.updateWidgetField(w3.id, 'w', 300);
  project.updateWidgetField(w3.id, 'h', 200);
  project.updateWidgetField(w3.id, 'bindings.variable', 'rTotal');
  // 第四个班次控件：专验"重进运行态/刷新页面不重复累计"（存档里有 25、raw=525/490/15）
  const w4 = project.addWidget('shift', 700, 60);
  project.updateWidgetField(w4.id, 'w', 300);
  project.updateWidgetField(w4.id, 'h', 240);
  project.updateWidgetField(w4.id, 'bindings.variable', 'rTotal2');
  project.updateWidgetField(w4.id, 'bindings.ok', 'rOk2');
  project.updateWidgetField(w4.id, 'bindings.ng', 'rNg2');
  project.commit('班次产量测试：控件');
  // ── 往 localStorage 注入历史：①昨天某班（验按日期查看）②第二个控件 40 天旧记录 ──
  const m = await import('/js/widgets/defs/shift.js');
  const dayStr = (ms) => {
    const d = new Date(ms);
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = dayStr(y.getTime());
  const curWin = m.shiftWindowOf(Date.now(), '08:00', 8);
  localStorage.setItem(m.shiftHistoryKey(w), JSON.stringify({
    days: {
      [yesterday]: {
        '09:00': {
          startLabel: '09:00', endLabel: '17:00', total: 123, ok: 120, ng: 3,
          hourly: [{ h: '09:00', count: 123, ok: 120, ng: 3 }],
        },
      },
    },
  }));
  const oldDays = {};
  for (let i = 0; i < 40; i++) {
    const d = new Date(2025, 0, 1, 12, 0, 0, 0);
    d.setDate(d.getDate() + i);
    oldDays[dayStr(d.getTime())] = {
      '08:00': { startLabel: '08:00', endLabel: '16:00', total: i + 1, ok: i + 1, ng: 0, hourly: [] },
    };
  }
  localStorage.setItem(m.shiftHistoryKey(w2), JSON.stringify({ days: oldDays }));
  // 第三个控件：只有顶层 hourly（没有 days / 没有 ok/ng 字段）→ 读回后 09:00 · 42，OK/NG 显示「—」
  localStorage.setItem(m.shiftHistoryKey(w3), JSON.stringify({
    days: {},
    hourly: [{ key: '2026-10-18 09:00', hh: '09:00', day: '2026-10-18', count: 42 }],
  }));
  // 第四个控件：存档里已经有"本班累计 25"，raw 记着上次采样的原始计数 525/490/15；
  // 进运行后 varStore 先从工程初值 500/400/5 起步，稍后跳回真实累计 525/490/15（现场 bug 场景）
  const curHour = m.hourKeyOf(Date.now());
  const rec25 = {
    startLabel: curWin.startLabel, endLabel: curWin.endLabel, total: 25, ok: 3, ng: 2,
    hourly: [{ key: curHour.key, hh: curHour.hh, day: curHour.day, count: 25, ok: 3, ng: 2 }],
  };
  localStorage.setItem(m.shiftHistoryKey(w4), JSON.stringify({
    days: { [dayStr(Date.now())]: { [curWin.startLabel]: rec25 } },
    hourly: [{ key: curHour.key, hh: curHour.hh, day: curHour.day, count: 25, ok: 3, ng: 2 }],
    raw: { total: 525, ok: 490, ng: 15 },
  }));
  return { shift: w.id, shift2: w2.id, shift3: w3.id, shift4: w4.id, yesterday: yesterday, curStart: curWin.startLabel };
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
async function setProps(id, patch) {
  await page.evaluate(([id, patch]) => {
    const { project } = window.app;
    Object.entries(patch).forEach(([k, v]) => project.updateWidgetProp(id, k, v));
    project.commit('改班次产量属性');
  }, [id, patch]);
  await sleep(120);
}
const setVar = (name, value) => page.evaluate(async ([n, v]) => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set(n, v);
}, [name, value]);
const rtSel = () => `#rtPage .wd[data-id="${ids.shift}"]`;
const rtText = (sel) => page.evaluate(([root, sel]) => {
  const el = document.querySelector(root);
  const n = el ? el.querySelector(sel) : null;
  return n ? n.textContent.trim() : null;
}, [rtSel(), sel]);
const rtState = () => page.evaluate(([root]) => {
  const el = document.querySelector(root);
  return (el && el.__shiftState) ? el.__shiftState() : null;
}, [rtSel()]);
const waitState = (pred, timeout = 8000) => page.waitForFunction(([root, src]) => {
  const el = document.querySelector(root);
  if (!el || !el.__shiftState) return false;
  try {
    // eslint-disable-next-line no-new-func
    return !!(new Function('s', 'return (' + src + ')'))(el.__shiftState());
  } catch (e) {
    return false;
  }
}, [rtSel(), pred], { timeout });

/** 读某个班次控件写入 localStorage 的历史（用 def 导出的 key/readShiftHistory） */
const readHist = (id) => page.evaluate(async (id) => {
  const m = await import('/js/widgets/defs/shift.js');
  const w = window.app.project.getWidget(id);
  return { key: m.shiftHistoryKey(w), days: m.readShiftHistory(w) };
}, id);
/** 读持久化的每小时计数（def 导出的 readShiftHourly）+ localStorage 原始 JSON */
const readHourly = (id) => page.evaluate(async (id) => {
  const m = await import('/js/widgets/defs/shift.js');
  const w = window.app.project.getWidget(id);
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(m.shiftHistoryKey(w)) || 'null'); } catch (e) { raw = null; }
  return { key: m.shiftHistoryKey(w), list: m.readShiftHourly(w), raw: raw };
}, id);
const dayStrOf = (ms) => {
  const d = new Date(ms);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const TODAY = dayStrOf(Date.now());
/** 测试侧的数字/null 归一（localStorage 里 ok/ng 可能是 null） */
const numOrNullT = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(+v) ? +v : null));

/** 某个班次控件（任意 id）的运行态钩子 */
const stateById = (id) => page.evaluate(([id]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return el && el.__shiftState ? el.__shiftState() : null;
}, [id]);
/** 删掉某个控件存档里的 raw 字段（模拟"老存档没有 raw"） */
const stripRawFor = (id) => page.evaluate(async (id) => {
  const m = await import('/js/widgets/defs/shift.js');
  const w = window.app.project.getWidget(id);
  const key = m.shiftHistoryKey(w);
  let j = {};
  try { j = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { j = {}; }
  delete j.raw;
  localStorage.setItem(key, JSON.stringify(j));
  return !('raw' in j);
}, id);
/** 仅测试用：清模块级运行态（模拟"刷新页面"，localStorage 存档保留） */
const resetShiftMemory = () => page.evaluate(async () => {
  const m = await import('/js/widgets/defs/shift.js');
  return m.__resetShiftMemoryForTest();
});

/* ═══════════ 2. 注册 + 工具箱 + 声明 ═══════════ */
const reg = await page.evaluate(async () => {
  const { registry } = await import('/js/widgets/registry.js');
  const d = registry.get('shift');
  if (!d) return null;
  const scope = d.scopeVars({ bindings: { ok: ' rOk ', ng: 'rNg', reset: '' } });
  return {
    title: d.title, sub: d.sub, icon: d.icon, selfDrawn: !!d.selfDrawn,
    hasW: Number.isFinite(d.defaults.w), hasH: Number.isFinite(d.defaults.h),
    propKeys: (d.props || []).map(p => p.key),
    propHints: (d.props || []).filter(p => p.hint).map(p => p.key),
    defaultsKeys: Object.keys(d.defaults || {}).filter(k => k !== 'w' && k !== 'h'),
    binding: d.binding, actions: d.actions,
    attach: typeof d.attach, scopeVars: typeof d.scopeVars,
    scopeSample: scope,
    renderOk: (() => {
      try {
        return typeof d.render === 'function'
          && typeof d.render({ props: { ...d.defaults }, bindings: { variable: 'rTotal' }, w: d.defaults.w, h: d.defaults.h }, 'edit', new Map()) === 'string';
      } catch { return false; }
    })(),
    order: registry.list().map(x => x.type),
  };
});
ok('「班次产量」注册成功（registry 里拿得到、render 能跑出 HTML）', !!reg && reg.renderOk);
ok('title=班次产量 / sub=总产量 / OK / NG / 每小时计数 / 有 icon / 默认 w/h / selfDrawn=false',
  !!reg && reg.title === '班次产量' && reg.sub === '总产量 / OK / NG / 每小时计数'
  && /^<svg/.test(reg.icon || '') && reg.hasW && reg.hasH && reg.selfDrawn === false,
  JSON.stringify(reg && { title: reg.title, sub: reg.sub }));
ok('props 齐全且顺序对', !!reg && JSON.stringify(reg.propKeys) === JSON.stringify(PROPS), reg && JSON.stringify(reg.propKeys));
ok('props 里一个 hint 说明文字都没有（面板不摊解释）', !!reg && reg.propHints.length === 0, reg && reg.propHints.join(','));
ok('binding.variable = 总产量计数（数值类型）',
  !!reg && !!reg.binding.variable && reg.binding.variable.label === '总产量计数'
  && ['int', 'real'].every(t => reg.binding.variable.types.includes(t)),
  JSON.stringify(reg && reg.binding));
ok('attach / scopeVars 钩子都在；scopeVars 返回 OK/NG/重置变量（去空格、空串跳过）',
  !!reg && reg.attach === 'function' && reg.scopeVars === 'function'
  && JSON.stringify(reg.scopeSample) === JSON.stringify(['rOk', 'rNg']),
  JSON.stringify(reg && reg.scopeSample));
ok('没有动作（actions=[] → 属性面板不出「动作」栏）', !!reg && Array.isArray(reg.actions) && reg.actions.length === 0);

const toolbox = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#toolboxList .tb-item')];
  return {
    names: items.map(e => e.querySelector('.tb-item-name')?.textContent || ''),
    svgs: items.map(e => !!e.querySelector('svg')),
    tips: items.map(e => e.title),
  };
});
const ti = toolbox.names.findIndex(n => n === '班次产量');
ok('工具箱里有「班次产量」条目（名称和图标齐全，说明在悬停提示里）',
  ti >= 0 && toolbox.svgs[ti] && (toolbox.tips[ti] || '').length > 0,
  `index=${ti} sub=${toolbox.tips[ti] || ''}`);

/* ═══════════ 3. MCP 静态提取 == 运行中注册表 ═══════════ */
ok('MCP 静态提取的 props / defaults / binding 与运行中一致',
  !!staticShift
  && JSON.stringify(staticShift.props.map(p => p.key)) === JSON.stringify(reg.propKeys)
  && JSON.stringify(Object.keys(staticShift.defaults)) === JSON.stringify(reg.defaultsKeys)
  && JSON.stringify(staticShift.binding) === JSON.stringify({
    variable: { types: reg.binding.variable.types, label: reg.binding.variable.label },
  }),
  staticShift ? JSON.stringify(staticShift.props.map(p => p.key)) : 'missing');

/* ═══════════ 4. 属性面板：能选中、schema 行齐全、没有 hint 行 ═══════════ */
await selectWidget(ids.shift);
const pane = await page.evaluate(() => {
  const body = document.getElementById('propBody');
  const rows = [...body.querySelectorAll('.f-row')];
  const hintRows = rows.filter(r => {
    const lab = r.querySelector('.f-label');
    if (!lab || lab.textContent.trim() !== '') return false;
    return [...r.children].some(c => c !== lab && c.tagName === 'SPAN'
      && /font-size:11px/.test(c.getAttribute('style') || ''));
  }).length;
  return {
    titles: [...body.querySelectorAll('.prop-group-title')].map(e => e.textContent.trim()),
    props: [...body.querySelectorAll('[data-prop]')].map(e => e.dataset.prop),
    hintRows,
    // 统计变量是**绑定扩展**：面板里应该是变量选择框（data-bind + 可点开候选表），不是手打文本框
    binds: [...body.querySelectorAll('[data-bind]')].map(e => e.dataset.bind),
    bindTitles: [...body.querySelectorAll('[data-bind]')].map(e => e.getAttribute('title') || ''),
  };
});
const missing = PROPS.filter(k => !pane.props.includes(k));
ok('属性面板能选中「班次产量」（标题 = 班次产量 属性）', pane.titles.includes('班次产量 属性'), pane.titles.join(' | ').slice(0, 120));
ok('「班次产量」面板按 props 长出全部属性行', missing.length === 0, missing.length ? '缺：' + missing.join(',') : PROPS.length + ' 行');
ok('「班次产量」面板里没有 hint 说明行', pane.hintRows === 0, String(pane.hintRows));
ok('★ 统计变量（OK / NG / 重置）在面板里是**变量选择框**（不是手打变量名的文本框）',
  ['ok', 'ng', 'reset'].every(k => pane.binds.includes(k))
  && pane.bindTitles.length === pane.binds.length
  && pane.bindTitles.every(t => /输入变量名|可搜|点开下拉/.test(t)),
  JSON.stringify({ binds: pane.binds, titles: pane.bindTitles }));

/* 4b. 用**面板真实输入框**绑 OK/NG/重置：必须写进 bindings.ok / ng / reset，
   而且**不能**串到总产量那格（现场报过"改 OK 总产量也跟着变"）。 */
const uiBound = await page.evaluate(async (id) => {
  const { project } = await import('/js/core/project.js');
  const put = (key, value) => {
    const inp = document.querySelector(`#propBody [data-bind="${key}"]`);
    if (!inp) return false;
    inp.value = value;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const ok1 = put('ok', 'rOk');
  const ok2 = put('ng', 'rNg');
  const ok3 = put('reset', 'bReset');
  await new Promise(r => setTimeout(r, 300));
  const b = project.getWidget(id).bindings || {};
  return {
    found: [ok1, ok2, ok3],
    b: JSON.parse(JSON.stringify(b)),
  };
}, ids.shift);
ok('★ 面板里绑 OK/NG/重置 → 分别写进 bindings.ok / ng / reset（总产量那格不变）',
  uiBound.found.every(Boolean)
  && uiBound.b.variable === 'rTotal'
  && uiBound.b.ok === 'rOk' && uiBound.b.ng === 'rNg' && uiBound.b.reset === 'bReset',
  JSON.stringify(uiBound));

/* ═══════════ 5. 纯函数单测：班次窗口 / 小时 key ═══════════ */
const fn = await page.evaluate(async () => {
  const m = await import('/js/widgets/defs/shift.js');
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  return {
    w1: m.shiftWindowOf(at(2026, 1, 15, 10, 30), '08:00', 8),
    w2: m.shiftWindowOf(at(2026, 1, 15, 7, 0), '08:00', 8),
    w3: m.shiftWindowOf(at(2026, 1, 16, 3, 0), '22:00', 8),
    w4: m.shiftWindowOf(at(2026, 1, 15, 10, 0), '08:00', 24),
    w5: m.shiftWindowOf(at(2026, 1, 15, 10, 0), 'abc', 0),
    shortShift: m.shiftWindowOf(at(2026, 1, 15, 7, 0), '08:00', 10),
    at8: at(2026, 1, 15, 8, 0),
    at10: at(2026, 1, 15, 10, 0),
    at16: at(2026, 1, 15, 16, 0),
    at0: at(2026, 1, 15, 0, 0),
    at22: at(2026, 1, 15, 22, 0),
    at26_6: at(2026, 1, 16, 6, 0),
    at26_8: at(2026, 1, 16, 8, 0),
    at11: at(2026, 1, 15, 11, 0),
    k1: m.hourKeyOf(at(2026, 1, 15, 10, 34)),
    k2: m.hourKeyOf(at(2026, 1, 15, 23, 59)),
  };
});
ok('纯函数：10:30 / 08:00 / 8h → 本班 08:00–16:00（key=01-15 08:00）',
  fn.w1.start === fn.at8 && fn.w1.end === fn.at16 && fn.w1.hours === 8
  && fn.w1.startLabel === '08:00' && fn.w1.endLabel === '16:00' && fn.w1.key === '01-15 08:00',
  JSON.stringify(fn.w1));
ok('纯函数：07:00（班次还没开始）→ 落在 00:00–08:00 这一班（起止正确）',
  fn.w2.start === fn.at0 && fn.w2.end === fn.at8 && fn.w2.startLabel === '00:00' && fn.w2.endLabel === '08:00',
  JSON.stringify(fn.w2));
ok('纯函数：跨午夜（22:00 / 8h，次日 03:00）→ 22:00–06:00',
  fn.w3.start === fn.at22 && fn.w3.end === fn.at26_6 && fn.w3.startLabel === '22:00' && fn.w3.endLabel === '06:00',
  JSON.stringify(fn.w3));
ok('纯函数：24 小时一班 → 08:00 到次日 08:00',
  fn.w4.start === fn.at8 && fn.w4.end === fn.at26_8 && fn.w4.hours === 24,
  JSON.stringify(fn.w4));
ok('纯函数：非法班次开始（abc）/ 每班小时 0 → 兜底 08:00 + 夹到 1 小时',
  fn.w5.start === fn.at10 && fn.w5.end === fn.at11 && fn.w5.hours === 1,
  JSON.stringify(fn.w5));
ok('班长不能整除一天时，末班在次日第一班开始时结束',
  fn.shortShift.startLabel === '04:00' && fn.shortShift.endLabel === '08:00', JSON.stringify(fn.shortShift));
ok('纯函数：小时 key（10:34 → 10:00 / 23:59 → 23:00）',
  fn.k1.key === '2026-01-15 10:00' && fn.k1.hh === '10:00'
  && fn.k2.key === '2026-01-15 23:00' && fn.k2.hh === '23:00',
  JSON.stringify({ k1: fn.k1, k2: fn.k2 }));

/* ═══════════ 6. 编辑态渲染（主数据行只有总产量 / OK / NG 三格） ═══════════ */
const ed = await page.evaluate(([id]) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  if (!el) return { present: false };
  const txt = (s) => { const n = el.querySelector(s); return n ? n.textContent.trim() : null; };
  const cells = [...el.querySelectorAll('.sh-main .sh-cell')];
  return {
    present: true,
    title: txt('.sh-title'),
    window: txt('.sh-window'),
    total: txt('.sh-total .sh-num'),
    ok: txt('.sh-ok .sh-num'),
    ng: txt('.sh-ng .sh-num'),
    labels: [...el.querySelectorAll('.sh-label')].map(n => n.textContent.trim()),
    cells: cells.map(c => c.className),
    cellFlex: cells.map(c => getComputedStyle(c).flexGrow),
    shiftCell: !!el.querySelector('.sh-shift'),
    hasShiftText: el.textContent.includes('本班产量'),
    hourlyRows: el.querySelectorAll('.sh-hrow').length,
    cur: txt('.sh-cur'),
    bar: !!el.querySelector('.sh-bar'),
    histbar: !!el.querySelector('.sh-histbar'),
    histDate: el.querySelector('.sh-hdate') ? el.querySelector('.sh-hdate').value : '',
    histLiveBtn: el.querySelectorAll('[data-shact="histLive"]').length,
    histMark: !!el.querySelector('.sh-histmark'),
  };
}, [ids.shift]);
ok('编辑态：标题 / 班次时间段（含已过时间）/ 进度条都在',
  ed.present && ed.title === '班次产量' && /^\d\d:\d\d–\d\d:\d\d · 已过 \d+:\d\d$/.test(ed.window || '') && ed.bar,
  JSON.stringify({ title: ed.title, window: ed.window, bar: ed.bar }));
ok('编辑态：主数据行只有「总产量 / OK / NG」三格（等宽），**没有本班产量那一格**',
  ed.labels.length === 3 && JSON.stringify(ed.labels) === JSON.stringify(['总产量', 'OK', 'NG'])
  && ed.cells.length === 3 && ed.cells.every(c => /sh-(total|ok|ng)/.test(c))
  && ed.cellFlex.every(f => f === '1')
  && !ed.shiftCell && !ed.hasShiftText,
  JSON.stringify({ labels: ed.labels, cells: ed.cells, flex: ed.cellFlex, shiftCell: ed.shiftCell }));
ok('编辑态：总产量 100 / OK 90 / NG 10（预览按当前值算基线）',
  ed.total === '100' && ed.ok === '90' && ed.ng === '10',
  JSON.stringify({ total: ed.total, ok: ed.ok, ng: ed.ng }));
ok('★ 编辑态：每小时表（当前小时一行）还在，但**不再显示「本小时 产量/OK/NG」那行汇总**',
  ed.hourlyRows >= 1 && ed.cur === null,
  JSON.stringify({ hourlyRows: ed.hourlyRows, cur: ed.cur }));
ok('编辑态：历史条在（‹ 日期 ›，日期默认今天；实时状态下没有「回到本班」）',
  ed.histbar && ed.histDate === TODAY && ed.histLiveBtn === 0 && !ed.histMark,
  JSON.stringify({ histbar: ed.histbar, date: ed.histDate, liveBtn: ed.histLiveBtn }));
// showHistory 关掉 → 历史条隐藏（默认开）
await setProps(ids.shift, { showHistory: false });
const edNoHist = await page.evaluate(([id]) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  return { bar: !!el.querySelector('.sh-histbar') };
}, [ids.shift]);
ok('showHistory=关 → 编辑画布上没有历史条', edNoHist.bar === false, JSON.stringify(edNoHist));
await setProps(ids.shift, { showHistory: true });

/* ═══════════ 7. 运行态：采样 / 三格 / 每小时 / OK·NG ═══════════ */
await page.evaluate(() => window.app.enterRun());
await sleep(600);
await waitState('s.total === 100 && s.shiftTotal === 0', 10000);
ok('运行态：首帧（基线=100）→ 总产量 100；界面没有「本班产量」格',
  (await rtText('.sh-total .sh-num')) === '100'
  && (await page.locator(`${rtSel()} .sh-shift`).count()) === 0,
  JSON.stringify({ total: await rtText('.sh-total .sh-num'), shiftCells: await page.locator(`${rtSel()} .sh-shift`).count() }));
let st = await rtState();
ok('运行态钩子 el.__shiftState() 字段齐全（shiftKey/start/hours/total/shiftTotal/ok/ng/hourly/baseline）',
  !!st && typeof st.shiftKey === 'string' && typeof st.start === 'number' && st.hours === 8
  && st.total === 100 && st.shiftTotal === 0 && st.ok === 90 && st.ng === 10
  && Array.isArray(st.hourly) && typeof st.baseline === 'number',
  JSON.stringify(st && { shiftKey: st.shiftKey, total: st.total, shiftTotal: st.shiftTotal, ok: st.ok, ng: st.ng }));
ok('运行态：主数据行同样只有三格（总产量 / OK / NG）',
  (await page.locator(`${rtSel()} .sh-main .sh-cell`).count()) === 3
  && (await page.locator(`${rtSel()} .sh-shift`).count()) === 0);
// 防重复累计：进运行后前 ~3 秒是稳定期（只更新显示、不累加），等它过去再让产量上涨
await sleep(2800);

// 每小时持久化：磁盘里预先有 hourly 的控件，进运行后应读回（等价"刷新页面后读回"）
// attach 后第一拍才刷新 DOM，等它把 42 显示出来
await page.waitForFunction(([id]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .sh-hrow .sh-hcount`);
  return !!(el && el.textContent.trim() === '42');
}, [ids.shift3], { timeout: 6000 }).catch(() => {});
const h3 = await readHourly(ids.shift3);
const h3row = await page.evaluate(([id]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .sh-hrow`);
  return el ? {
    count: (el.querySelector('.sh-hcount') || {}).textContent || '',
    ok: (el.querySelector('.sh-hok') || {}).textContent || '',
    ng: (el.querySelector('.sh-hng') || {}).textContent || '',
  } : null;
}, [ids.shift3]);
ok('每小时持久化：预落盘的 hourly 进运行后被读回（刷新页面场景：小时表显示 09:00 · 42）',
  h3.list.length === 1 && h3.list[0].h === '09:00' && h3.list[0].count === 42
  && !!h3row && String(h3row.count).trim() === '42',
  JSON.stringify({ list: h3.list, row: h3row }));
ok('每小时 OK/NG：老存档缺 ok/ng 字段 → 读回按 null（不报错、界面显示「—」）',
  h3.list[0].ok === null && h3.list[0].ng === null
  && !!h3row && String(h3row.ok).trim() === '—' && String(h3row.ng).trim() === '—',
  JSON.stringify({ list: h3.list, row: h3row }));

// 总产量 +25：界面只更新总产量，本班产量只在内部（shiftTotal）维护
await setVar('rTotal', 125);
await waitState('s.total === 125 && s.shiftTotal === 25', 8000);
st = await rtState();
ok('运行态：总产量 +25 → 界面总产量 125，本班显示 25',
  (await rtText('.sh-total .sh-num')) === '125'
  && (await rtText('.sh-total .sh-sub')) === '本班 25'
  && st && st.shiftTotal === 25 && st.total === 125
  && (await page.locator(`${rtSel()} .sh-shift`).count()) === 0,
  JSON.stringify({ total: await rtText('.sh-total .sh-num'), st: st && { total: st.total, shiftTotal: st.shiftTotal } }));
ok('运行态：每小时表当前小时那一行计数 = 增量 25（并标「进行中」）',
  st && st.hourly.length >= 1 && st.hourly[0].count === 25
  && (await rtText('.sh-hrow .sh-hcount')) === '25'
  && (await page.locator(`${rtSel()} .sh-hrow .sh-hcur`).count()) >= 1,
  JSON.stringify({ hourly0: st && st.hourly[0], row: await rtText('.sh-hrow .sh-hcount') }));
// 每小时计数落盘：readShiftHourly 和 localStorage 原始 JSON 里都有当前小时 25
let hDisk = await readHourly(ids.shift);
for (let i = 0; i < 15 && !(hDisk.list[0] && Number(hDisk.list[0].count) === 25); i++) { await sleep(250); hDisk = await readHourly(ids.shift); }  // 写盘有 ≤1s 节流：轮询等它落
ok('每小时持久化：采样累加已按节流落盘（readShiftHourly / localStorage.hourly 都有当前小时 25）',
  Array.isArray(hDisk.raw && hDisk.raw.hourly) && hDisk.list.some(h => h.count === 25)
  && hDisk.raw.hourly.some(r => Number(r.count) === 25),
  JSON.stringify({ list: hDisk.list, rawHourly: hDisk.raw && hDisk.raw.hourly }));

// OK / NG：绑了显示真实值（本班增量做小字提示）
await setVar('rOk', 93);
await setVar('rNg', 12);
await waitState('s.ok === 93 && s.ng === 12', 8000);
ok('运行态：OK/NG 绑了变量 → 显示真实值 93 / 12，本班增量小字 +3 / +2',
  (await rtText('.sh-ok .sh-num')) === '93' && (await rtText('.sh-ok .sh-sub')) === '+3'
  && (await rtText('.sh-ng .sh-num')) === '12' && (await rtText('.sh-ng .sh-sub')) === '+2',
  JSON.stringify({ ok: await rtText('.sh-ok .sh-num'), okSub: await rtText('.sh-ok .sh-sub'), ng: await rtText('.sh-ng .sh-num'), ngSub: await rtText('.sh-ng .sh-sub') }));

// 每小时条目带 OK/NG：本小时 产量 25 / OK +3 / NG +2；表头小字列出 小时|产量|OK|NG
st = await rtState();
const hourlyCols = await page.evaluate(([root]) => {
  const el = document.querySelector(root);
  const txt = (s) => { const n = el.querySelector(s); return n ? n.textContent.trim() : ''; };
  return {
    ok: txt('.sh-hrow .sh-hok'), ng: txt('.sh-hrow .sh-hng'),
    cur: txt('.sh-cur'), cols: txt('.sh-hcols'),
  };
}, [rtSel()]);
ok('运行态：每小时表按小时记录 产量/OK/NG（本小时 count 25 / ok 3 / ng 2），表头小字四列齐；不再显示「本小时…」汇总行',
  !!st && st.hourly[0].count === 25 && st.hourly[0].ok === 3 && st.hourly[0].ng === 2
  && hourlyCols.ok === '3' && hourlyCols.ng === '2'
  && hourlyCols.cur === ''
  && ['小时', '产量', 'OK', 'NG'].every(w => hourlyCols.cols.includes(w)),
  JSON.stringify({ hourly0: st && st.hourly[0], cols: hourlyCols }));
// 每小时的 OK/NG 也落盘：顶层 hourly 与当前班记录 hourly 都带 ok/ng（写盘有 ≤1s 节流，轮询等它落）
let hOkDisk = await readHourly(ids.shift);
let hRec = {};
for (let i = 0; i < 15; i++) {
  const hDays = (await readHist(ids.shift)).days;
  const hDayBucket = (hDays && hDays[TODAY]) || {};
  hRec = hDayBucket[Object.keys(hDayBucket)[0]] || {};
  const rawOk = hOkDisk.raw && Array.isArray(hOkDisk.raw.hourly) && hOkDisk.raw.hourly[0] ? Number(hOkDisk.raw.hourly[0].ok) : null;
  const listOk = hOkDisk.list[0] ? hOkDisk.list[0].ok : null;
  if (rawOk === 3 && listOk === 3 && Array.isArray(hRec.hourly) && Number(hRec.hourly[0].ok) === 3) break;
  await sleep(250);
  hOkDisk = await readHourly(ids.shift);
}
ok('每小时 OK/NG 持久化：顶层 hourly 与当前班记录 hourly 都带 ok/ng（3 / 2）',
  Array.isArray(hOkDisk.raw && hOkDisk.raw.hourly)
  && Number(hOkDisk.raw.hourly[0].ok) === 3 && Number(hOkDisk.raw.hourly[0].ng) === 2
  && hOkDisk.list[0].ok === 3 && hOkDisk.list[0].ng === 2
  && Array.isArray(hRec.hourly) && Number(hRec.hourly[0].ok) === 3 && Number(hRec.hourly[0].ng) === 2,
  JSON.stringify({ raw: hOkDisk.raw && hOkDisk.raw.hourly, list: hOkDisk.list, recHourly: hRec.hourly }));

// 没绑 OK/NG → 显示「—」（统计变量走 bindings.ok / bindings.ng，和属性面板的变量选择框是同一份）
const setStatVars = async (ok, ng) => {
  await page.evaluate(([id, o, n]) => {
    const m = window.app.project;
    m.updateWidgetField(id, 'bindings.ok', o);
    m.updateWidgetField(id, 'bindings.ng', n);
    m.commit('班次产量测试：统计变量');
  }, [ids.shift, ok, ng]);
};
await setStatVars('', '');
await page.waitForFunction(([root]) => {
  const el = document.querySelector(root);
  const n = el ? el.querySelector('.sh-ok .sh-num') : null;
  return n && n.textContent.trim() === '—';
}, [rtSel()], { timeout: 6000 });
ok('运行态：OK/NG 没绑变量 → 显示「—」',
  (await rtText('.sh-ok .sh-num')) === '—' && (await rtText('.sh-ng .sh-num')) === '—');
await setStatVars('rOk', 'rNg');   // 还原，后面的用例继续用

// scopeVars：OK/NG/重置变量进了本页采集范围
const scope = await page.evaluate(async () => (await import('/js/runtime/runtime.js')).pageVarScope());
ok('scopeVars：OK / NG / 重置变量都进了运行态「本页采集范围」',
  scope.includes('rOk') && scope.includes('rNg') && scope.includes('bReset') && scope.includes('rTotal'),
  JSON.stringify(scope.filter(n => ['rTotal', 'rOk', 'rNg', 'bReset'].includes(n))));

/* ═══════════ 8. resetVar 上升沿：本班统计归零、每小时表清空（不动总产量） ═══════════ */
ok('测试前提：重置前内部本班产量（shiftTotal）25、总产量 125', (await rtState()).shiftTotal === 25 && (await rtState()).total === 125,
  JSON.stringify(await rtState()));
await setVar('bReset', true);
await waitState('s.baseline === 125 && s.shiftTotal === 0', 8000);
st = await rtState();
ok('resetVar 0→1 上升沿：基线改成当前值（125）→ 内部本班产量归 0、总产量不变、界面仍无本班格',
  st && st.baseline === 125 && st.shiftTotal === 0 && st.total === 125
  && (await rtText('.sh-total .sh-num')) === '125'
  && (await page.locator(`${rtSel()} .sh-shift`).count()) === 0,
  JSON.stringify({ baseline: st && st.baseline, shiftTotal: st && st.shiftTotal, total: st && st.total }));
ok('resetVar 上升沿：每小时表被清空（只剩当前小时一行、计数 0、OK/NG 也归 0）',
  st && st.hourly.length === 1 && st.hourly[0].count === 0
  && st.hourly[0].ok === 0 && st.hourly[0].ng === 0
  && (await page.locator(`${rtSel()} .sh-hrow`).count()) === 1
  && (await rtText('.sh-hrow .sh-hcount')) === '0',
  JSON.stringify({ hourly: st && st.hourly, rows: await page.locator(`${rtSel()} .sh-hrow`).count() }));
// 手动清：内存 + localStorage 一起清（force 写盘，不等节流）
const hReset = await readHourly(ids.shift);
ok('resetVar 上升沿 =「手动清」：**localStorage 里的 hourly 也清了**（产量/OK/NG 都没有正数）',
  Array.isArray(hReset.raw && hReset.raw.hourly) && hReset.raw.hourly.every(r => !Number(r.count) && !Number(r.ok) && !Number(r.ng))
  && hReset.list.every(h => !h.count && !h.ok && !h.ng),
  JSON.stringify({ rawHourly: hReset.raw && hReset.raw.hourly, list: hReset.list }));
// 一直是 1 不会反复清；回 0 再来一次才是新上升沿
await sleep(1200);                       // 至少过一个采样周期
ok('resetVar 保持 1 不会反复触发（基线不再往后跑）',
  (await rtState()).baseline === 125, String((await rtState()).baseline));
await setVar('bReset', false);
await sleep(300);

/* ═══════════ 9. 定期刷新：改总产量后不手动刷新，1.5s 内界面自己跟到 ═══════════ */
await setVar('rTotal', 130);
await sleep(1500);                       // refreshMs 默认 1000：靠控件自己的定时器刷新
st = await rtState();
ok('定期刷新：改总产量 130 后等 1.5s → 界面自动变 130（内部 shiftTotal=5）',
  (await rtText('.sh-total .sh-num')) === '130'
  && st && st.total === 130 && st.shiftTotal === 5
  && (await page.locator(`${rtSel()} .sh-shift`).count()) === 0,
  JSON.stringify({ total: await rtText('.sh-total .sh-num'), st: st && { total: st.total, shiftTotal: st.shiftTotal } }));
ok('定期刷新：本小时计数也跟着累加（0 + 5 = 5）',
  (await rtText('.sh-hrow .sh-hcount')) === '5' && st && st.hourly[0].count === 5,
  JSON.stringify({ row: await rtText('.sh-hrow .sh-hcount'), hourly0: st && st.hourly[0] }));

/* ═══════════ 10. 历史班次：本地记录 / 按日期查看 / 回到本班 / historyDays 清理 ═══════════ */
// ① 运行几拍后 readShiftHistory(w) 里有"当天当前班"记录（total = 本班累计增量：reset 后 0 + 5）
let curHist = null;
for (let i = 0; i < 20; i++) {
  const h = await readHist(ids.shift);
  const bucket = (h.days && h.days[TODAY]) || {};
  const keys = Object.keys(bucket);
  if (keys.length && Number(bucket[keys[0]].total) === 5) { curHist = h; break; }
  await sleep(200);
}
const curBucket = (curHist && curHist.days && curHist.days[TODAY]) || {};
const curRec = curBucket[Object.keys(curBucket)[0]] || null;
ok('历史记录：运行几拍后本地有「当天当前班」记录（total=本班累计 5，带起止/每小时）',
  !!curHist && !!curRec && Number(curRec.total) === 5 && !!curRec.startLabel && !!curRec.endLabel
  && Array.isArray(curRec.hourly),
  JSON.stringify(curRec));
// ② 第二个控件：注入 40 天旧记录 → attach 后只留 historyDays=30 天（删最老）
const h2 = await readHist(ids.shift2);
const d2 = Object.keys(h2.days || {});
ok('historyDays 清理：注入的 40 天旧记录只剩 30 天，且删的是最老的（2025-01-01 没了）',
  d2.length === 30 && !d2.includes('2025-01-01') && d2.includes('2025-02-09') && d2.includes(TODAY),
  JSON.stringify({ n: d2.length, first: d2[0], last: d2[d2.length - 1] }));

// ③ 日期选昨天 → 列出那天开始的班次（注入的 09:00–17:00 · 产量 123 · OK 120 · NG 3）
await page.evaluate(([id, date]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .sh-hdate`);
  el.value = date;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [ids.shift, ids.yesterday]);
await sleep(500);
const pastView = await page.evaluate(([id]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  const txt = (s) => { const n = el.querySelector(s); return n ? n.textContent.trim() : ''; };
  return {
    rows: [...el.querySelectorAll('.sh-pastrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    empty: !!el.querySelector('.sh-pastempty'),
    mark: !!el.querySelector('.sh-histmark'),
    liveBtn: !!el.querySelector('[data-shact="histLive"]'),
    date: el.querySelector('.sh-hdate') ? el.querySelector('.sh-hdate').value : '',
    total: txt('.sh-total .sh-num'),
    ok: txt('.sh-ok .sh-num'),
    ng: txt('.sh-ng .sh-num'),
  };
}, [ids.shift]);
ok('历史：日期选昨天 → 列出那天开始的班次（09:00–17:00 · 产量 123 · OK 120 · NG 3）',
  pastView.rows.length === 1 && pastView.rows[0].includes('09:00–17:00')
  && pastView.rows[0].includes('产量 123') && pastView.rows[0].includes('OK 120') && pastView.rows[0].includes('NG 3')
  && !pastView.empty && pastView.date === ids.yesterday,
  JSON.stringify(pastView.rows));
ok('历史：看历史时标题旁标「历史」+ 出现「回到本班」按钮，主数据行=那班的值',
  pastView.mark && pastView.liveBtn
  && pastView.total === '123' && pastView.ok === '120' && pastView.ng === '3',
  JSON.stringify({ mark: pastView.mark, liveBtn: pastView.liveBtn, total: pastView.total, ok: pastView.ok, ng: pastView.ng }));
let pastHook = await rtState();
ok('历史：el.__shiftState() view=past、histDate=昨天、histShifts 有那班（total/ok/ng 对）',
  pastHook && pastHook.view === 'past' && pastHook.histDate === ids.yesterday
  && Array.isArray(pastHook.histShifts) && pastHook.histShifts.length >= 1
  && pastHook.histShifts[0].total === 123 && pastHook.histShifts[0].ok === 120 && pastHook.histShifts[0].ng === 3,
  JSON.stringify(pastHook && { view: pastHook.view, histDate: pastHook.histDate, histShifts: pastHook.histShifts }));
// 看历史时小时表 = 那班当时记录的 hourly（注入的 09:00 · 123，带 OK 120 / NG 3），__shiftState().hourly 也跟视图
const pastHourRow = await page.evaluate(([id]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .sh-hrow`);
  if (!el) return null;
  const t = (s) => { const n = el.querySelector(s); return n ? n.textContent.trim() : ''; };
  return { key: t('.sh-hkey'), count: t('.sh-hcount'), ok: t('.sh-hok'), ng: t('.sh-hng') };
}, [ids.shift]);
ok('历史：看历史时每小时表 = 那班记录的 产量/OK/NG（09:00 · 123 / 120 / 3）；__shiftState().hourly 跟视图',
  !!pastHourRow && String(pastHourRow.key).trim() === '09:00' && String(pastHourRow.count).trim() === '123'
  && String(pastHourRow.ok).trim() === '120' && String(pastHourRow.ng).trim() === '3'
  && pastHook.hourly.length === 1 && pastHook.hourly[0].h === '09:00' && pastHook.hourly[0].count === 123
  && pastHook.hourly[0].ok === 120 && pastHook.hourly[0].ng === 3,
  JSON.stringify({ row: pastHourRow, hookHourly: pastHook.hourly }));

// ④ 点那班 → 主数据行切成历史值，且不跟随实时变量变化
await page.click(`#rtPage .wd[data-id="${ids.shift}"] .sh-pastrow[data-shpast="09:00"]`);
await sleep(400);
ok('历史：点某班 → 主数据行显示那班的累计值（总产量 123 / OK 120 / NG 3）',
  (await rtText('.sh-total .sh-num')) === '123' && (await rtText('.sh-ok .sh-num')) === '120'
  && (await rtText('.sh-ng .sh-num')) === '3',
  JSON.stringify({ total: await rtText('.sh-total .sh-num'), ok: await rtText('.sh-ok .sh-num'), ng: await rtText('.sh-ng .sh-num') }));
await setVar('rTotal', 400);
await sleep(1600);   // 过两个采样周期：实时总产量变了，但历史视图不该动
pastHook = await rtState();
ok('历史：看历史时**不跟随实时刷新**（实时总产量变 400，主数据行仍停在 123）',
  pastHook.view === 'past' && (await rtText('.sh-total .sh-num')) === '123'
  && (await page.locator(`#rtPage .wd[data-id="${ids.shift}"] .sh-histmark`).count()) === 1,
  JSON.stringify({ view: pastHook.view, total: await rtText('.sh-total .sh-num') }));

// ⑤ 当前班在历史列表里也算一行（切到今天：列表里有当前班、标「进行中」）
const historyDate = page.locator(`#rtPage .wd[data-id="${ids.shift}"] .sh-hdate`);
const historyWidths = await historyDate.evaluate(input => {
  const bar = input.parentElement;
  bar.style.width = '480px';
  const standard = input.getBoundingClientRect().width;
  bar.style.width = '740px';
  const wide = input.getBoundingClientRect().width;
  bar.style.removeProperty('width');
  return { standard, wide };
});
ok('历史日期框按内容定宽，不随班次控件拉长', historyWidths.standard > 100
  && historyWidths.standard < 220 && historyWidths.wide === historyWidths.standard, JSON.stringify(historyWidths));
await historyDate.fill('2000-01-01');
await page.locator(`#rtPage .wd[data-id="${ids.shift}"] .sh-pastempty`).waitFor();
ok('没有历史记录的日期显示空值和空小时表',
  (await rtText('.sh-total .sh-num')) === '—' && (await rtState()).hourly.length === 0);
await page.evaluate(([id, date]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .sh-hdate`);
  el.value = date;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [ids.shift, TODAY]);
await sleep(500);
const todayList = await page.evaluate(([id]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return {
    rows: [...el.querySelectorAll('.sh-pastrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    curMarks: el.querySelectorAll('.sh-pastrow .sh-pastcur').length,
  };
}, [ids.shift]);
ok('历史：当前班在历史列表里也算一行（今天列表里有「进行中」那行）',
  todayList.rows.length >= 1 && todayList.curMarks === 1 && todayList.rows.some(t => t.includes('进行中')),
  JSON.stringify(todayList));

// ⑥ 回到本班 → 回实时
await page.click(`#rtPage .wd[data-id="${ids.shift}"] [data-shact="histLive"]`);
await waitState('s.total === 400', 8000);
pastHook = await rtState();
ok('历史：点「回到本班」→ view=live，主数据行回到实时值（总产量 400）、「历史」标记消失',
  pastHook.view === 'live' && (await rtText('.sh-total .sh-num')) === '400'
  && (await page.locator(`#rtPage .wd[data-id="${ids.shift}"] .sh-histmark`).count()) === 0,
  JSON.stringify({ view: pastHook.view, total: await rtText('.sh-total .sh-num') }));
const hLive = await readHourly(ids.shift);
ok('历史：回到本班后小时表回到实时/持久化的 hourly（不是历史那班的 123）',
  pastHook.hourly.length >= 1 && pastHook.hourly[0].count === hLive.list[0].count
  && !pastHook.hourly.some(h => h.count === 123 && h.h === '09:00'),
  JSON.stringify({ hookHourly: pastHook.hourly, disk: hLive.list.slice(0, 2) }));

/* ═══════════ 11. 每小时计数持久化：退出运行再进运行不清零（等价刷新页面读回） ═══════════ */
const hBeforeExit = await readHourly(ids.shift);
await page.evaluate(() => window.app.exitRun());
await sleep(500);                                   // 退出时 tick 会 force 补写一次
await page.evaluate(() => window.app.enterRun());
await page.waitForFunction(([root]) => {
  const el = document.querySelector(root);
  return !!(el && el.__shiftState);
}, [rtSel()], { timeout: 10000 });
await sleep(900);
const hAfterRe = await readHourly(ids.shift);
const liveAfterRe = await rtState();
ok('每小时持久化：exitRun 再 enterRun 后小时表还在（之前的小时和 产量/OK/NG，不清零）',
  hAfterRe.list.length >= 1 && JSON.stringify(hAfterRe.list) === JSON.stringify(hBeforeExit.list)
  && (await rtText('.sh-hrow .sh-hcount')) === String(hBeforeExit.list[0].count)
  && hBeforeExit.list[0].ok !== undefined && hBeforeExit.list[0].ng !== undefined
  && liveAfterRe.hourly.some(h => h.count === hBeforeExit.list[0].count),
  JSON.stringify({ before: hBeforeExit.list.slice(0, 2), after: hAfterRe.list.slice(0, 2), row: await rtText('.sh-hrow .sh-hcount') }));
ok('每小时持久化：重新进运行后 localStorage.hourly 与退出前一致（count/ok/ng 都在）',
  Array.isArray(hAfterRe.raw && hAfterRe.raw.hourly)
  && JSON.stringify(hAfterRe.raw.hourly.map(r => [Number(r.count), numOrNullT(r.ok), numOrNullT(r.ng)]))
    === JSON.stringify(hBeforeExit.list.map(h => [h.count, h.ok, h.ng])),
  JSON.stringify({ raw: hAfterRe.raw && hAfterRe.raw.hourly, before: hBeforeExit.list }));

/* ═══════════ 12. 修 bug：重进运行态/刷新页面不重复累计 ═══════════ */
const w4sel = `#rtPage .wd[data-id="${ids.shift4}"]`;
const w4record = async () => {
  const h = await readHist(ids.shift4);
  const bucket = (h.days && h.days[TODAY]) || {};
  return bucket[Object.keys(bucket)[0]] || null;
};
const w4hourly = async () => (await readHourly(ids.shift4)).list;
const waitRec4 = async (want, timeout = 8000) => {
  const t0 = Date.now();
  let rec = null;
  while (Date.now() - t0 < timeout) {
    rec = await w4record();
    if (rec && Number(rec.total) === want) return rec;
    await sleep(250);
  }
  return rec;
};

// 前提：w4 从进入运行态起就按存档恢复了本班 25（本次运行里 rTotal2 没变过，不该被累加）
const r0 = await w4record();
const h0 = await w4hourly();
const s0 = await stateById(ids.shift4);
ok('（前提）w4 进运行后从存档恢复本班 25，没有被重复累计（记录/小时表都是 25）',
  r0 && Number(r0.total) === 25 && h0[0] && Number(h0[0].count) === 25,
  JSON.stringify({ rec: r0 && r0.total, hourly: h0[0] && h0[0].count }));

// a) 模拟"刷新页面"：exitRun → 清模块级内存状态（localStorage 存档保留）→ enterRun；
//    进运行后 varStore 先退回工程初值(500)，稍后跳回真实累计(525) —— 这 25 的跳变不能再累加一遍
await page.evaluate(() => window.app.exitRun());
await sleep(400);
await resetShiftMemory();
await page.evaluate(() => window.app.enterRun());
await page.waitForFunction(([root]) => {
  const el = document.querySelector(root);
  return !!(el && el.__shiftState);
}, [w4sel], { timeout: 10000 });
await sleep(300);
await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('rTotal2', 525);   // 后端回读真实累计值（跳变 500 → 525）
  varStore.set('rOk2', 490);
  varStore.set('rNg2', 15);
});
await sleep(3500);               // 过稳定期 + 对齐拍
const rA = await w4record();
const hA = await w4hourly();
const sA = await stateById(ids.shift4);
ok('★ 修复 a：刷新页面（清内存+存档保留）后重进运行，产量没增 → 记录/小时表仍是 25（不翻倍）',
  rA && Number(rA.total) === 25 && hA[0] && Number(hA[0].count) === 25
  && sA && sA.shiftTotal === 25 && Number(rA.ok) === 3 && Number(rA.ng) === 2,
  JSON.stringify({ rec: rA && rA.total, hourly: hA[0] && hA[0].count, shiftTotal: sA && sA.shiftTotal }));

// b) 稳定期过后正常生产 +10 → 记录/小时表变 35（正常增量照记）
await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('rTotal2', 535);
});
const rB = await waitRec4(35, 6000);
const hB = await w4hourly();
ok('★ 修复 b：稳定期后产量 +10 → 本班记录 35、小时表 35（正常增量照记）',
  rB && Number(rB.total) === 35 && hB[0] && Number(hB[0].count) === 35,
  JSON.stringify({ rec: rB && rB.total, hourly: hB[0] && hB[0].count }));

// c) 老存档缺 raw（删掉 raw 字段）→ 同样不能重复累计
await page.evaluate(() => window.app.exitRun());
await sleep(400);
const stripped = await stripRawFor(ids.shift4);
await resetShiftMemory();
await page.evaluate(() => window.app.enterRun());
await page.waitForFunction(([root]) => {
  const el = document.querySelector(root);
  return !!(el && el.__shiftState);
}, [w4sel], { timeout: 10000 });
await sleep(300);
await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('rTotal2', 535);   // 后端回读旧值
});
await sleep(3500);
const rC = await w4record();
const hC = await w4hourly();
ok('★ 修复 c：老存档缺 raw → 重进运行也不重复加（记录仍 35、小时表仍 35）',
  stripped && rC && Number(rC.total) === 35 && hC[0] && Number(hC[0].count) === 35,
  JSON.stringify({ stripped, rec: rC && rC.total, hourly: hC[0] && hC[0].count }));

// d) 直接 exitRun → enterRun（不清内存）也不重复加；之后正常增量照记
await page.evaluate(() => window.app.exitRun());
await sleep(400);
await page.evaluate(() => window.app.enterRun());
await page.waitForFunction(([root]) => {
  const el = document.querySelector(root);
  return !!(el && el.__shiftState);
}, [w4sel], { timeout: 10000 });
await sleep(300);
await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('rTotal2', 535);
});
await sleep(3600);
const rD = await w4record();
ok('★ 修复 d：直接 exitRun→enterRun（不清内存）不重复加（记录仍 35）',
  rD && Number(rD.total) === 35, JSON.stringify({ rec: rD && rD.total }));
await page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set('rTotal2', 540);   // 再正常生产 +5
});
const rD2 = await waitRec4(40, 6000);
ok('修复 d（续）：重进运行后正常增量照记（35 + 5 = 40）', rD2 && Number(rD2.total) === 40,
  JSON.stringify({ rec: rD2 && rD2.total }));

/* ═══════════ 13. 退出运行态：定时器停掉（采样时间不再前进） ═══════════ */
const beforeCounterReset = (await rtState()).shiftTotal;
await setVar('rTotal', 0);
await waitState('s.total === 0', 5000);
ok('PLC 累计计数清零后，本班产量保持已经累计的数量',
  (await rtState()).shiftTotal === beforeCounterReset && beforeCounterReset > 0);
const beforeExit = await rtState();
await page.evaluate(() => window.app.exitRun());
await sleep(1700);
const afterExit = await rtState();
ok('退出运行态后采样定时器停掉（sampledAt 不再前进，不空转）',
  !!beforeExit && !!afterExit && afterExit.sampledAt === beforeExit.sampledAt,
  JSON.stringify({ before: beforeExit && beforeExit.sampledAt, after: afterExit && afterExit.sampledAt }));
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

/* ═══════════ 14. 收尾 ═══════════ */
await browser.close();
browser = null;
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 班次产量控件回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
