// verify-recipe-widget.mjs — 「配方」运行态控件（范围变量 / 保存·应用·删除 / 数据表编辑）
//
// 验什么：
//   ① 注册成功（registry 里拿得到、字段齐全、attach 钩子在）；variables 不再是 bindings 32 槽，
//      而是普通多行文本属性 `varsText`（textarea / rows 6 / 无 i18n / placeholder 给写法）
//   ② MCP 静态提取器能解析 def（硬规矩：def 里不许写 ?.，写了这一步当场崩）
//   ③ 属性面板：能选中、按 props schema 长出全部输入格、**不出现 hint 说明文字**
//   ④ 「配方变量」解析（编辑态标题行右侧的「N 个变量」逐条验）：
//        单变量 / 数组名整组 / 数组名[起..止] / 起>止 交换 / 只取存在的元素 / 认不出的跳过 /
//        超过 512 个截断 / legacy bindings.variables 追加
//   ⑤ 运行态（走 runtime.js 的 attach + api.rpc / api.ensureAdmin / api.get）：
//        · 初始空态「还没有配方」、标题旁「7 个变量」
//        · 名字空点保存 → 不保存（后端列表不变）+ 消息行提示
//        · 保存当前 → 后端 GET ?full=1 落盘 values 对（7 个变量）、输入框清空
//        · 改变量后点行「应用」→ 7 个值全恢复
//        · 保存时**每次重新解析**：运行中往变量表加 rRecipe[6] 后再存同名配方 → 变 6 个
//        · 点配方行 → 选中高亮 + 数据表（变量名只读 + 值）
//        · 点数值单元格 → 内置小键盘（0-9/.\\-/⌫/确定/取消）→ 确定 → 草稿变、行标「*」
//        · 字符串值用真 <input> 行内改（Enter/失焦确认）
//        · 保存修改 → 后端 ?full=1 值真的变；还原修改 → 丢草稿重新读；空数据给人话
//        · 有未保存改动时切换配方会 confirm（取消留在原处 / 确定切过去丢草稿）
//        · legacy bindings.variables：老配置还能保存/应用
//        · allowDelete 打开时点「删除」→ 列表没了（后端也删了）
//   ⑥ 多语言：title / namePlaceholder 的 i18n 声明能被收集，切 en 后标题/占位文字变英文
//
// 用法：node test/verify-recipe-widget.mjs
//   （自己拉起一个隔离后端：随机端口 + 临时数据目录 + --no-auth，不碰 8866 上那套；
//     --no-auth 下 ensureAdmin 自动通过）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPageShim, wsApi } from './_wsfetch.mjs';
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

const PROPS = ['title', 'varsText', 'showList', 'showSave', 'showRefresh', 'allowDelete', 'namePlaceholder',
  'rowH', 'fontSize', 'textColor', 'bgColor', 'headerBg', 'lineColor', 'radius'];
const ELEM = (i) => 'rRecipe[' + i + ']';

/* ── 0. MCP 静态提取（def 里写 `?.` 会把解析器弄崩，所以先单独跑一遍） ── */
let statics = null;
try {
  const mcp = await import('file:///' + path.resolve(ROOT, '..', 'hmi-mcp', 'tools', 'extract-catalog.mjs').replace(/\\/g, '/'));
  statics = mcp.parseDefs(DEFDIR);
} catch (e) {
  statics = { error: String((e && e.message) || e) };
}
const staticRecipe = Array.isArray(statics) ? statics.find(w => w.type === 'recipe') : null;
ok('MCP 静态提取器能解析 defs/（recipe def 里没写 ?.）', Array.isArray(statics), statics.error || '');
ok('MCP 静态提取出「配方」控件', !!staticRecipe, staticRecipe ? staticRecipe.title : 'missing');

/* ── 起隔离后端（--no-auth：ensureAdmin 自动通过）+ 浏览器 ── */
const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-recipe-widget-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let browser = null;
let apiNode = null;
/** 断言抛异常（locator 超时等）时也要收尾：别把隔离后端/浏览器留在后台 */
const cleanup = () => {
  try { if (apiNode) apiNode.close(); } catch { /* ignore */ }
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
apiNode = await wsApi(PORT);                 // Node 侧直接查后端（看配方是否真落盘）

browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
// confirm 弹窗：默认确定；个别用例改成「取消」来验「有未保存改动时切换要 confirm」
let dialogMode = 'accept';
const dialogs = [];
page.on('dialog', async (d) => {
  dialogs.push(d.message());
  try { if (dialogMode === 'dismiss') await d.dismiss(); else await d.accept(); } catch { /* ignore */ }
});
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* ═══════════ 1. 造数据：数组元素变量 + 单变量 + 控件 ═══════════ */
const ids = await page.evaluate(async (base) => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const target = project.pages().find(p => p.type === 'page');
  if (!target) throw new Error('演示工程里没有普通页');
  project.setCurrentPage(target.id);
  // 地址留空 = 内部变量（不碰设备；后端内存模式按"内部变量"存）
  const defs = [];
  // 模拟「数组展开成元素变量」：rRecipe[1]…rRecipe[5]（v2 的数组规矩）
  for (let i = 1; i <= 5; i++) defs.push([base + '[' + i + ']', 'real', i + 0.5]);
  defs.push(['iSingle', 'int', 42]);                    // 单变量（混在范围配置里）
  defs.push(['sText', 'string', 'hello']);              // 字符串变量（数据表里用行内 input 改）
  defs.push(['iLegacy', 'int', 7]);                     // 老配置兼容用
  for (let i = 1; i <= 513; i++) defs.push(['manyVar[' + i + ']', 'real', i]);   // 超过 512 上限
  defs.forEach(([name, type, value]) => {
    const old = project.data.variables.find(v => v.name === name);
    if (old) { old.type = type; old.value = value; old.address = ''; }
    else project.data.variables.push({ name, type, address: '', value });
  });
  project.commit('配方控件测试：变量');
  varStore.resetFrom(project.variables());
  const r = project.addWidget('recipe', 40, 120);
  project.updateWidgetField(r.id, 'w', 420);
  project.updateWidgetField(r.id, 'h', 300);
  project.updateWidgetProp(r.id, 'varsText', base + '[1..5]\niSingle\nsText');
  project.commit('配方控件测试：控件');
  return { recipe: r.id };
}, 'rRecipe');
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
const getVar = (name) => page.evaluate(async (n) => (await import('/js/runtime/varstore.js')).varStore.get(n), name);
const setVar = (name, value) => page.evaluate(async ([n, v]) => {
  const { varStore } = await import('/js/runtime/varstore.js');
  varStore.set(n, v);
}, [name, value]);
const rtSel = () => `#rtPage .wd[data-id="${ids.recipe}"]`;
/** 编辑态画布上标题行右侧的「N 个变量」 */
const editCount = () => page.evaluate(([id]) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"] .rc-count`);
  return el ? el.textContent.trim() : null;
}, [ids.recipe]);
/** 运行态标题行右侧的「N 个变量」 */
const runCount = () => page.evaluate(([sel]) => {
  const el = document.querySelector(sel + ' .rc-count');
  return el ? el.textContent.trim() : null;
}, [rtSel()]);
/** 改 varsText 并等画布把这个控件局部重画完 */
async function setVarsTextInEdit(text) {
  await setProps(ids.recipe, { varsText: text });
  await page.evaluate(() => window.app.project.commit('改配方变量'));
  await sleep(220);
}

/** Node 侧查后端（重连重试：长连接被后端心跳收掉 / 偶发空响应时不影响断言） */
async function backendCall(pathAndQuery, init) {
  for (let i = 0; i < 3; i++) {
    try {
      if (!apiNode || (apiNode.conn && apiNode.conn.isDead())) apiNode = await wsApi(PORT);
      const r = await apiNode(pathAndQuery, init);
      if (r && typeof r === 'object' && Object.keys(r).length > 0) return r;
    } catch (e) { /* 连接断了 → 重连再试 */ }
    try { apiNode = await wsApi(PORT); } catch (e) { /* 下一轮再试 */ }
    await sleep(150);
  }
  return {};
}
const backendPost = (path, body) => backendCall(path, { method: 'POST', body: body });
const backendNames = async () => {
  const r = await backendCall('/api/recipes');
  if (!Array.isArray(r && r.names)) console.log('  （调试）GET /api/recipes 返回：' + JSON.stringify(r));
  return Array.isArray(r && r.names) ? r.names : [];
};
const backendRecipes = () => backendCall('/api/recipes?full=1');
/** 等后端某个配方的 vars 里某几个值变成想要的样子（保存修改是异步的，别用固定 sleep 赌） */
async function waitBackendVars(name, want, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await backendRecipes();
    const rec = r && r.recipes ? r.recipes[name] : null;
    const vars = rec && rec.vars ? rec.vars : null;
    if (vars && Object.keys(want).every(k => vars[k] === want[k])) return vars;
    if (Date.now() > end) return vars;
    await sleep(150);
  }
}
/** 等后端里某个配方的 vars 条数达到 n（保存是异步的，别用固定 sleep 赌） */
async function waitRecipeVars(name, n, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await backendRecipes();
    const rec = r && r.recipes ? r.recipes[name] : null;
    if (rec && rec.vars && Object.keys(rec.vars).length === n) return rec.vars;
    if (Date.now() > end) return rec && rec.vars ? rec.vars : null;
    await sleep(150);
  }
}
/** 在运行态填名字点「保存当前」 */
async function clickSave(name) {
  await page.fill(`${rtSel()} [data-rc="name"]`, name);
  await page.click(`${rtSel()} [data-rcact="save"]`);
}

/* ═══════════ 2. 注册 + 工具箱 + 声明 ═══════════ */
const reg = await page.evaluate(async (types) => {
  const { registry } = await import('/js/widgets/registry.js');
  const out = {};
  types.forEach(t => {
    const d = registry.get(t);
    out[t] = d ? {
      title: d.title, sub: d.sub, icon: d.icon, hidden: !!d.hidden,
      hasW: Number.isFinite(d.defaults.w), hasH: Number.isFinite(d.defaults.h),
      propKeys: (d.props || []).map(p => p.key),
      props: (d.props || []).map(p => ({
        key: p.key, label: p.label, type: p.type,
        rows: p.rows, i18n: p.i18n, placeholder: p.placeholder, hint: p.hint,
      })),
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
  out.order = registry.list().filter(d => ['paramTable', 'recipe'].includes(d.type)).map(d => d.type);
  return out;
}, ['recipe']);
const R = reg.recipe;
const varsProp = R.props.find(p => p.key === 'varsText');
ok('「配方」注册成功（registry 里拿得到、render 能跑出 HTML）', !!R && R.renderOk);
ok('title=配方 / sub=保存/应用整套参数 / 有 icon / 默认 w/h / 带 attach 钩子',
  !!R && R.title === '配方' && R.sub === '保存/应用整套参数' && /^<svg/.test(R.icon || '')
  && R.hasW && R.hasH && R.attach === 'function',
  JSON.stringify(R && { title: R.title, sub: R.sub, attach: R.attach }));
ok('props 齐全且顺序对（title 后面就是 varsText）', !!R && JSON.stringify(R.propKeys) === JSON.stringify(PROPS), R && JSON.stringify(R.propKeys));
ok('varsText 是普通多行文本：textarea / rows 6 / 没有 i18n / placeholder 给写法示例 / 无 hint',
  !!varsProp && varsProp.type === 'textarea' && varsProp.rows === 6
  && !varsProp.i18n && !varsProp.hint && String(varsProp.placeholder || '').includes('..'),
  JSON.stringify(varsProp));
ok('binding 改为 null（不再是 32 槽的 bindings.variables）', !!R && R.binding === null, JSON.stringify(R && R.binding));
ok('props 里一个 hint 说明文字都没有（面板不摊解释）', !!R && R.propHints.length === 0, R && R.propHints.join(','));
ok('配方没有动作（actions=[] → 属性面板不出「动作」栏）', !!R && Array.isArray(R.actions) && R.actions.length === 0);
ok('注册顺序：配方排在参数表后面（工具箱相邻）', JSON.stringify(reg.order) === JSON.stringify(['paramTable', 'recipe']),
  JSON.stringify(reg.order));

const toolbox = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#toolboxList .tb-item')];
  return {
    names: items.map(e => e.querySelector('.sub')?.previousElementSibling?.textContent || ''),
    svgs: items.map(e => !!e.querySelector('svg')),
    subs: items.map(e => e.querySelector('.sub')?.textContent || ''),
  };
});
const ti = toolbox.names.findIndex(n => n === '配方');
ok('工具箱里有「配方」条目（副标题+图标齐全）',
  ti >= 0 && toolbox.svgs[ti] && (toolbox.subs[ti] || '').length > 0,
  `index=${ti} sub=${toolbox.subs[ti] || ''}`);

/* ═══════════ 3. MCP 静态提取 == 运行中注册表（声明字段）═══════════ */
ok('MCP 静态提取的 props / defaults 与运行中一致',
  !!staticRecipe
  && JSON.stringify(staticRecipe.props.map(p => p.key)) === JSON.stringify(R.propKeys)
  && JSON.stringify(Object.keys(staticRecipe.defaults)) === JSON.stringify(R.defaultsKeys),
  staticRecipe ? JSON.stringify(staticRecipe.props.map(p => p.key)) : 'missing');
ok('MCP 静态提取的 binding 与运行中一致（都是空的 / null）',
  !!staticRecipe && !staticRecipe.binding.variables && R.binding === null,
  JSON.stringify(staticRecipe && staticRecipe.binding));

/* ═══════════ 4. 属性面板：能选中、schema 行齐全、没有 hint 行 ═══════════ */
await selectWidget(ids.recipe);
const pane = await page.evaluate(() => {
  const body = document.getElementById('propBody');
  const rows = [...body.querySelectorAll('.f-row')];
  const hintRows = rows.filter(r => {
    const lab = r.querySelector('.f-label');
    if (!lab || lab.textContent.trim() !== '') return false;
    return [...r.children].some(c => c !== lab && c.tagName === 'SPAN'
      && /font-size:11px/.test(c.getAttribute('style') || ''));
  }).length;
  const area = body.querySelector('textarea[data-prop="varsText"]');
  return {
    titles: [...body.querySelectorAll('.prop-group-title')].map(e => e.textContent.trim()),
    props: [...body.querySelectorAll('[data-prop]')].map(e => e.dataset.prop),
    hintRows,
    varsArea: !!area,
    varsRows: area ? area.getAttribute('rows') : '',
    varsPlaceholder: area ? area.getAttribute('placeholder') : '',
  };
});
const missing = PROPS.filter(k => !pane.props.includes(k));
ok('属性面板能选中「配方」（标题 = 配方 属性）', pane.titles.includes('配方 属性'), pane.titles.join(' | ').slice(0, 120));
ok('「配方」面板按 props 长出全部属性行', missing.length === 0, missing.length ? '缺：' + missing.join(',') : PROPS.length + ' 行');
ok('「配方」面板里没有 hint 说明行', pane.hintRows === 0, String(pane.hintRows));
ok('「配方变量」在面板里就是普通多行文本框（rows=6、placeholder 有写法示例）',
  pane.varsArea && pane.varsRows === '6' && String(pane.varsPlaceholder).includes('..'),
  JSON.stringify({ area: pane.varsArea, rows: pane.varsRows }));

/* ═══════════ 5. 编辑态渲染 + 「配方变量」解析逐条验 ═══════════ */
const ed = await page.evaluate(([id]) => {
  const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  if (!el) return { present: false };
  const q = (s) => el.querySelector(s);
  const inp = q('[data-rc="name"]');
  return {
    present: true,
    title: q('.rc-title') ? q('.rc-title').textContent.trim() : '',
    count: q('.rc-count') ? q('.rc-count').textContent.trim() : '',
    hasInput: !!inp,
    inputDisabled: inp ? inp.disabled : null,
    placeholder: inp ? inp.getAttribute('placeholder') : '',
    save: !!q('[data-rcact="save"]'),
    refresh: !!q('[data-rcact="refresh"]'),
    rows: [...el.querySelectorAll('.rc-row')].map(r => r.getAttribute('data-rcname')),
    dels: el.querySelectorAll('[data-rcact="del"]').length,
    empty: !!q('.rc-empty'),
  };
}, [ids.recipe]);
ok('编辑态：标题 / 变量数 / 配方名输入框（禁用）/ 保存 / 刷新 都在',
  ed.present && ed.title === '配方' && ed.count === '7 个变量' && ed.hasInput && ed.inputDisabled === true
  && ed.placeholder === '配方名…' && ed.save && ed.refresh,
  JSON.stringify(ed));
ok('编辑态：画了假列表行（所见即所得），不显示「还没有配方」',
  ed.rows.length === 2 && !ed.empty, JSON.stringify(ed.rows));
ok('编辑态：allowDelete 默认关 → 没有「删除」按钮', ed.dels === 0, String(ed.dels));

// 解析规则逐条验：标题行右侧「N 个变量」
const countCases = [
  ['rRecipe[1..5]\niSingle', '6 个变量', '范围和单变量混合'],
  ['rRecipe', '5 个变量', '数组名 = 整组（按数字排序）'],
  ['rRecipe[5..3]', '3 个变量', '起>止 自动交换'],
  ['rRecipe[1..9]', '5 个变量', '只取变量表里存在的元素（6..9 不存在）'],
  ['rRecipe[1..3]\nnosuchVar\niSingle', '4 个变量', '认不出的名字跳过'],
  ['nosuchVar', '还没有配方变量', '全都认不出 = 空配置'],
  ['manyVar[1..513]', '512 个变量', '超过 512 个截断'],
  ['rRecipe[1..5]\niSingle\nsText', '7 个变量', '还原最终配置（含字符串变量）'],
];
for (const [text, want, why] of countCases) {
  await setVarsTextInEdit(text);
  const got = await editCount();
  ok(`解析「${why}」→ ${want}`, got === want, `varsText=${JSON.stringify(text)} got=${JSON.stringify(got)}`);
}

/* 运行态要验删除：打开「允许删除」（进运行态前配置好） */
await setProps(ids.recipe, { allowDelete: true });
await page.evaluate(() => window.app.project.commit('配方控件测试：允许删除'));
await sleep(250);

/* ═══════════ 6. 运行态：初始空态 + 名字空不保存 ═══════════ */
await page.evaluate(() => window.app.enterRun());
await sleep(900);   // 等 attach 里首次 GET 列表完成
// 「写后保护窗口」（默认 1s）会把服务端 apply 后回推的值当"旧回读"丢掉 —— 测试里关掉它，
// 等价于现场"改完变量停一会儿再点应用"（否则断言的是保护窗口行为，不是控件行为）。
await page.evaluate(() => { window.app.varStore.writeHoldMs = 0; });

ok('运行态：配方控件画出来了、标题旁显示 7 个变量',
  (await page.locator(rtSel()).count()) === 1 && (await runCount()) === '7 个变量', await runCount());
const emptyNow = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  const e = el ? el.querySelector('.rc-empty') : null;
  return { empty: !!e, text: e ? e.textContent.trim() : '', rows: el ? el.querySelectorAll('.rc-row').length : -1 };
}, [rtSel()]);
ok('运行态：初始空态显示「还没有配方」（后端列表为空）',
  emptyNow.empty && emptyNow.text === '还没有配方' && emptyNow.rows === 0, JSON.stringify(emptyNow));

await page.fill(`${rtSel()} [data-rc="name"]`, '   ');
await page.click(`${rtSel()} [data-rcact="save"]`);
await sleep(350);
const msgEmptyName = (await page.textContent(`${rtSel()} .rc-msg`)).trim();
const namesAfterEmptyName = await backendNames();
ok('运行态：名字空点「保存当前」→ 不保存（后端列表仍为空）+ 消息行提示',
  namesAfterEmptyName.length === 0 && msgEmptyName.includes('配方名不能为空'),
  JSON.stringify({ names: namesAfterEmptyName, msg: msgEmptyName }));

/* ═══════════ 7. 保存当前 → 后端真的存了 7 个变量、values 对 ═══════════ */
await clickSave('配方A');
const savedVars = await waitRecipeVars('配方A', 7);
const expectVars = {
  'rRecipe[1]': 1.5, 'rRecipe[2]': 2.5, 'rRecipe[3]': 3.5, 'rRecipe[4]': 4.5, 'rRecipe[5]': 5.5,
  iSingle: 42, sText: 'hello',
};
ok('运行态：保存后列表出现「配方A」、后端 GET 列表也有它',
  (await backendNames()).includes('配方A') && (await page.locator(`${rtSel()} .rc-row[data-rcname="配方A"]`).count()) === 1,
  JSON.stringify(await backendNames()));
ok('运行态：保存的是解析出的 7 个变量当前值（范围 5 个 + 数值 + 字符串）',
  JSON.stringify(savedVars) === JSON.stringify(expectVars), JSON.stringify(savedVars));
ok('运行态：保存成功后输入框被清空、消息行说「已保存…（7 个变量）」',
  (await page.locator(`${rtSel()} [data-rc="name"]`).inputValue()) === ''
  && (await page.textContent(`${rtSel()} .rc-msg`)).includes('已保存')
  && (await page.textContent(`${rtSel()} .rc-msg`)).includes('7 个变量'),
  (await page.textContent(`${rtSel()} .rc-msg`)).trim());

/* ═══════════ 8. 改变量后点行「应用」→ 7 个值全恢复 ═══════════ */
for (let i = 1; i <= 5; i++) await setVar(ELEM(i), 900 + i);
await setVar('iSingle', 999);
await setVar('sText', 'zzz');
await sleep(250);
ok('测试前提：7 个变量已经被改乱',
  (await getVar(ELEM(1))) === 901 && (await getVar(ELEM(5))) === 905
  && (await getVar('iSingle')) === 999 && (await getVar('sText')) === 'zzz',
  JSON.stringify({ a: await getVar(ELEM(1)), b: await getVar(ELEM(5)), c: await getVar('iSingle'), d: await getVar('sText') }));

await page.click(`${rtSel()} .rc-row[data-rcname="配方A"] [data-rcact="apply"]`);
await page.waitForFunction(async (want) => {
  const { varStore } = await import('/js/runtime/varstore.js');
  return want.every(([n, v]) => varStore.get(n) === v);
}, Object.entries(expectVars), { timeout: 8000 });
ok('运行态：点行「应用」→ 7 个变量值全恢复成配方里存的那套',
  (await getVar(ELEM(1))) === 1.5 && (await getVar(ELEM(5))) === 5.5
  && (await getVar('iSingle')) === 42 && (await getVar('sText')) === 'hello',
  JSON.stringify({ a: await getVar(ELEM(1)), b: await getVar(ELEM(5)), c: await getVar('iSingle'), d: await getVar('sText') }));
ok('运行态：应用后消息行给出结果（已应用 7 个）',
  (await page.textContent(`${rtSel()} .rc-msg`)).includes('已应用 7 个'),
  (await page.textContent(`${rtSel()} .rc-msg`)).trim());

/* ═══════════ 9. 保存/应用时每次重新解析（变量表运行中被加元素）═══════════ */
// 运行中把配置改成「数组名整组」→ 保存：此时 rRecipe 只有 [1..5]，存 5 个
await page.evaluate(([id]) => {
  const { project } = window.app;
  project.updateWidgetProp(id, 'varsText', 'rRecipe');
  project.commit('改配方变量');
}, [ids.recipe]);
await sleep(200);
await clickSave('五元配方');
const fiveVars = await waitRecipeVars('五元配方', 5);
ok('运行态：把配置改成「数组名」再保存 → 解析出 5 个元素变量',
  !!fiveVars && Object.keys(fiveVars).length === 5 && Object.keys(fiveVars)[0] === 'rRecipe[1]',
  JSON.stringify(fiveVars && Object.keys(fiveVars)));

// 运行中往变量表里加第 6 个元素（现场改工程/加变量）→ 同名再保存一次：应重新解析成 6 个
await page.evaluate(async () => {
  const { project } = window.app;
  if (!project.data.variables.some(v => v.name === 'rRecipe[6]')) {
    project.data.variables.push({ name: 'rRecipe[6]', type: 'real', address: '', value: 6.5 });
  }
  project.commit('运行中加元素变量');
  window.app.varStore.set('rRecipe[6]', 6.5);
});
await sleep(300);
await clickSave('五元配方');
const sixVars = await waitRecipeVars('五元配方', 6);
ok('运行态：变量表加了 rRecipe[6] 后再保存同名配方 → 每次重新解析，变 6 个',
  !!sixVars && sixVars['rRecipe[6]'] === 6.5 && Object.keys(sixVars).length === 6,
  JSON.stringify(sixVars));

/* ═══════════ 10. 点配方行 → 数据表；内置小键盘改值 → 保存修改 / 还原 ═══════════ */
// 点「配方A」行本体（不是应用/删除按钮）→ 选中高亮 + 读该配方 vars 画数据表
await page.click(`${rtSel()} .rc-row[data-rcname="配方A"] .rc-rowname`);
await sleep(700);
const dataView = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  if (!el) return { present: false };
  const q = (s) => el.querySelector(s);
  const rows = [...el.querySelectorAll('.rc-drow')];
  const selRow = q('.rc-row.sel');
  return {
    present: !!q('.rc-data'),
    title: q('.rc-data-title') ? q('.rc-data-title').textContent.trim() : '',
    selRow: selRow ? selRow.getAttribute('data-rcname') : '',
    names: rows.map(r => r.getAttribute('data-rcvar')),
    values: rows.map(r => {
      const num = r.querySelector('[data-rcnum]');
      const inp = r.querySelector('input[data-rcstr], input[data-rcbool]');
      return num ? num.textContent.trim() : (inp ? inp.value : null);
    }),
    stars: rows.map(r => r.querySelector('.rc-star') ? r.querySelector('.rc-star').textContent.trim() : '?'),
  };
}, [rtSel()]);
ok('数据表：点配方行（行本体）→ 该行高亮 + 画出「变量名只读 + 值」的数据表',
  dataView.present && dataView.selRow === '配方A' && dataView.title === '编辑「配方A」'
  && JSON.stringify(dataView.names) === JSON.stringify(['rRecipe[1]', 'rRecipe[2]', 'rRecipe[3]', 'rRecipe[4]', 'rRecipe[5]', 'iSingle', 'sText'])
  && JSON.stringify(dataView.values) === JSON.stringify(['1.5', '2.5', '3.5', '4.5', '5.5', '42', 'hello']),
  JSON.stringify(dataView));
ok('数据表：刚选中时没有「*」（没有未保存修改）', dataView.stars.every(s => s === ''), JSON.stringify(dataView.stars));

// 点数值单元格 → 控件内置小键盘
await page.click(`${rtSel()} .rc-drow[data-rcvar="rRecipe[1]"] [data-rcnum]`);
await sleep(250);
const padView = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  const pad = el ? el.querySelector('.rc-pad') : null;
  const disp = pad ? pad.querySelector('.rc-pad-disp') : null;
  return {
    open: !!pad,
    disp: disp ? disp.textContent.trim() : '',
    keys: pad ? [...pad.querySelectorAll('[data-rcpad]')].map(b => b.getAttribute('data-rcpad')) : [],
    absolute: pad ? getComputedStyle(pad).position : '',
  };
}, [rtSel()]);
ok('小键盘：点数值单元格 → 控件内置小键盘弹出（绝对定位，0-9 / . / - / ⌫ / 确定 / 取消 齐全）',
  padView.open && padView.absolute === 'absolute' && padView.disp === '1.5'
  && ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '-', 'back', 'ok', 'cancel'].every(k => padView.keys.includes(k)),
  JSON.stringify(padView));
// ⌫ 清掉原值 1.5，再输 22 → 确定
for (let i = 0; i < 3; i++) { await page.click(`${rtSel()} [data-rcpad="back"]`); await sleep(60); }
await page.click(`${rtSel()} [data-rcpad="2"]`); await sleep(60);
await page.click(`${rtSel()} [data-rcpad="2"]`); await sleep(60);
ok('小键盘：⌫ 清掉原值后输入 22（显示区跟手）',
  (await page.textContent(`${rtSel()} .rc-pad-disp`)).trim() === '22',
  (await page.textContent(`${rtSel()} .rc-pad-disp`)).trim());
await page.click(`${rtSel()} [data-rcpad="ok"]`);
await sleep(300);
const afterPad = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  const cell = el.querySelector('.rc-drow[data-rcvar="rRecipe[1]"] [data-rcnum]');
  const star = el.querySelector('.rc-drow[data-rcvar="rRecipe[1]"] .rc-star');
  const mark = el.querySelector('[data-rcdirty]');
  return {
    val: cell ? cell.textContent.trim() : null,
    star: star ? star.textContent.trim() : '',
    dirtyShown: !!mark && mark.style.display !== 'none',
    padOpen: !!el.querySelector('.rc-pad'),
  };
}, [rtSel()]);
ok('小键盘：确定 → 草稿值变 22、行上标「*」、显示「未保存」、小键盘收起',
  afterPad.val === '22' && afterPad.star === '*' && afterPad.dirtyShown && !afterPad.padOpen,
  JSON.stringify(afterPad));

// 字符串值：真 <input> 行内编辑，回车确认
const strInp = `${rtSel()} .rc-drow[data-rcvar="sText"] input[data-rcstr]`;
ok('数据表：字符串值是真 <input> 行内编辑（不回弹小键盘）',
  (await page.locator(strInp).count()) === 1 && (await page.locator(strInp).inputValue()) === 'hello');
await page.fill(strInp, 'world');
await page.press(strInp, 'Enter');
await sleep(250);
ok('数据表：字符串行内改成 world + 回车确认 → 草稿变、行标「*」',
  (await page.locator(strInp).inputValue()) === 'world'
  && (await page.textContent(`${rtSel()} .rc-drow[data-rcvar="sText"] .rc-star`)).trim() === '*',
  await page.locator(strInp).inputValue());

// 「保存修改」：ensureAdmin('修改配方') + confirm → POST save
await page.click(`${rtSel()} [data-rcact="savedata"]`);
const editVars = await waitBackendVars('配方A', { 'rRecipe[1]': 22, sText: 'world' });
ok('保存修改：后端 ?full=1 里值真的变了（rRecipe[1]=22 / sText=world，其它不动）',
  !!editVars && editVars['rRecipe[1]'] === 22 && editVars.sText === 'world' && editVars.iSingle === 42,
  JSON.stringify(editVars));
ok('保存修改后：消息行「已保存修改」、所有「*」和「未保存」标记清掉',
  (await page.textContent(`${rtSel()} .rc-msg`)).includes('已保存修改')
  && (await page.locator(`${rtSel()} .rc-star`).evaluateAll(els => els.every(e => e.textContent.trim() === '')))
  && (await page.evaluate(([sel]) => {
    const m = document.querySelector(sel + ' [data-rcdirty]');
    return !m || m.style.display === 'none';
  }, [rtSel()])),
  (await page.textContent(`${rtSel()} .rc-msg`)).trim());

// 「还原修改」：改一下不保存 → 点还原 → 重新从后端读回原值
await page.click(`${rtSel()} .rc-drow[data-rcvar="iSingle"] [data-rcnum]`);
await sleep(220);
for (let i = 0; i < 2; i++) { await page.click(`${rtSel()} [data-rcpad="back"]`); await sleep(60); }
await page.click(`${rtSel()} [data-rcpad="9"]`); await sleep(60);
await page.click(`${rtSel()} [data-rcpad="9"]`); await sleep(60);
await page.click(`${rtSel()} [data-rcpad="ok"]`);
await sleep(300);
ok('还原前：iSingle 草稿改成 99、行标「*」',
  (await page.textContent(`${rtSel()} .rc-drow[data-rcvar="iSingle"] [data-rcnum]`)).trim() === '99'
  && (await page.textContent(`${rtSel()} .rc-drow[data-rcvar="iSingle"] .rc-star`)).trim() === '*');
await page.click(`${rtSel()} [data-rcact="revert"]`);
await sleep(900);   // 重新 GET ?full=1
const afterRevert = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  const cell = el.querySelector('.rc-drow[data-rcvar="iSingle"] [data-rcnum]');
  return {
    val: cell ? cell.textContent.trim() : null,
    star: (el.querySelector('.rc-drow[data-rcvar="iSingle"] .rc-star') || {}).textContent || '',
  };
}, [rtSel()]);
ok('还原修改：重新从后端读 → iSingle 回到 42、* 清掉、消息「已还原修改」',
  afterRevert.val === '42' && String(afterRevert.star).trim() === ''
  && (await page.textContent(`${rtSel()} .rc-msg`)).includes('已还原修改'),
  JSON.stringify(afterRevert));

// 空数据：后端造一个 vars 为空的配方 → 刷新列表 → 点它 → 数据表给人话
await backendPost('/api/recipes', { action: 'save', name: '空配方', vars: {} });
await page.click(`${rtSel()} [data-rcact="refresh"]`);
await page.waitForFunction(([sel]) => !!document.querySelector(sel + ' .rc-row[data-rcname="空配方"]'),
  [rtSel()], { timeout: 6000 });
await page.click(`${rtSel()} .rc-row[data-rcname="空配方"] .rc-rowname`);
await sleep(800);
const emptyData = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  const d = el ? el.querySelector('.rc-data-empty') : null;
  return { empty: !!d, text: d ? d.textContent.trim() : '' };
}, [rtSel()]);
ok('空数据：配方 vars 为空 → 数据表给人话「这个配方没有数据」',
  emptyData.empty && emptyData.text === '这个配方没有数据', JSON.stringify(emptyData));

// 未保存改动时切换配方：先取消（留在原配方），再确定（切过去、草稿丢弃）
await page.click(`${rtSel()} .rc-row[data-rcname="配方A"] .rc-rowname`);
await sleep(800);
await page.fill(strInp, 'temp');
await page.press(strInp, 'Enter');
await sleep(250);
const dlgBefore = dialogs.length;
dialogMode = 'dismiss';
await page.click(`${rtSel()} .rc-row[data-rcname="五元配方"] .rc-rowname`);
await sleep(500);
const stillA = await page.textContent(`${rtSel()} .rc-data-title`);
const askMsg = dialogs.length > dlgBefore ? dialogs[dialogs.length - 1] : '';
ok('未保存切换：弹出 confirm 问「还有未保存的修改」；点取消 → 仍停在原配方',
  dialogs.length > dlgBefore && askMsg.includes('未保存') && stillA.includes('配方A'),
  JSON.stringify({ askMsg: askMsg, stillA: stillA }));
dialogMode = 'accept';
await page.click(`${rtSel()} .rc-row[data-rcname="五元配方"] .rc-rowname`);
await sleep(900);
const nowB = await page.textContent(`${rtSel()} .rc-data-title`);
ok('未保存切换：确认后切到「五元配方」（旧草稿丢弃）', nowB.includes('五元配方'), nowB);

/* ═══════════ 11. legacy bindings.variables 兼容（老配置还能保存/应用）═══════════ */
await page.evaluate(([id]) => {
  const { project } = window.app;
  project.updateWidgetProp(id, 'varsText', '');
  project.updateWidgetField(id, 'bindings.variables', ['iLegacy']);
  project.commit('老配置兼容');
}, [ids.recipe]);
await sleep(200);
// 老绑定现在进了「变量→控件」索引：改一下 iLegacy 就会重画控件，标题旁能看出 legacy 变量被算进来
await setVar('iLegacy', 8);
await sleep(350);
ok('legacy：varsText 为空 + 老 bindings.variables=[iLegacy] → 标题旁显示「1 个变量」',
  (await runCount()) === '1 个变量', await runCount());
await clickSave('老配方');
const legacyVars = await waitRecipeVars('老配方', 1);
ok('legacy：老配置照样能保存（后端落盘 iLegacy=8）',
  !!legacyVars && legacyVars.iLegacy === 8, JSON.stringify(legacyVars));
await setVar('iLegacy', 99);
await sleep(200);
await page.click(`${rtSel()} .rc-row[data-rcname="老配方"] [data-rcact="apply"]`);
await page.waitForFunction(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  return varStore.get('iLegacy') === 8;
}, null, { timeout: 8000 });
ok('legacy：老配置照样能应用（iLegacy 从 99 恢复成 8）', (await getVar('iLegacy')) === 8,
  String(await getVar('iLegacy')));

/* ═══════════ 11. 删除（allowDelete 已开）═══════════ */
ok('运行态：allowDelete 打开后每行出现「删除」按钮',
  (await page.locator(`${rtSel()} .rc-row[data-rcname="配方A"] [data-rcact="del"]`).count()) === 1);
await page.click(`${rtSel()} .rc-row[data-rcname="配方A"] [data-rcact="del"]`);
await page.waitForFunction(([sel]) => !document.querySelector(sel + ' .rc-row[data-rcname="配方A"]'),
  [rtSel()], { timeout: 6000 });
await sleep(200);
const afterDelNames = await backendNames();
ok('运行态：点「删除」→ 列表里没了、后端也删了',
  !afterDelNames.includes('配方A'),
  JSON.stringify(afterDelNames));
ok('运行态：删除后消息行说「已删除」',
  (await page.textContent(`${rtSel()} .rc-msg`)).includes('已删除'),
  (await page.textContent(`${rtSel()} .rc-msg`)).trim());

/* ═══════════ 12. 多语言：title / namePlaceholder 走 tr ═══════════ */
const i18nInfo = await page.evaluate(async () => {
  const i = await import('/js/core/i18n.js');
  i.addLanguage('en', 'English');
  const s = i.i18nState();
  if (!s.dict.en) s.dict.en = {};
  Object.assign(s.dict.en, {
    '配方': 'Recipe', '配方名…': 'Recipe name…', '保存当前': 'Save current', '刷新': 'Refresh',
  });
  const srcs = i.collectEntries().map(r => r.source);
  i.setLang('en');
  return { srcs, lang: i.getLang() };
});
await sleep(700);   // i18n:lang → 运行态整页重画（attach 会再拉一次列表）
ok('多语言：title / namePlaceholder 被收进翻译表（props 的 i18n 声明生效）',
  i18nInfo.srcs.includes('配方') && i18nInfo.srcs.includes('配方名…'),
  i18nInfo.srcs.filter(x => ['配方', '配方名…'].includes(x)).join(','));
const enDom = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  if (!el) return { present: false };
  const q = (s) => el.querySelector(s);
  const inp = q('[data-rc="name"]');
  const btn = (a) => q(`[data-rcact="${a}"]`);
  return {
    present: true,
    title: q('.rc-title') ? q('.rc-title').textContent.trim() : '',
    placeholder: inp ? inp.getAttribute('placeholder') : '',
    save: btn('save') ? btn('save').textContent.trim() : '',
    refresh: btn('refresh') ? btn('refresh').textContent.trim() : '',
  };
}, [rtSel()]);
ok('多语言：切 en 后标题 / 占位文字 / 按钮都变英文（变量名/配方名是数据，不翻）',
  enDom.present && enDom.title === 'Recipe' && enDom.placeholder === 'Recipe name…'
  && enDom.save === 'Save current' && enDom.refresh === 'Refresh',
  JSON.stringify(enDom));

// 切回默认语言 → 中文回来
await page.evaluate(async () => {
  const i = await import('/js/core/i18n.js');
  i.setLang('zh-CN');
  i.removeLanguage('en');
});
await sleep(500);
const zhTitle = await page.evaluate(([sel]) => {
  const el = document.querySelector(sel);
  return el && el.querySelector('.rc-title') ? el.querySelector('.rc-title').textContent.trim() : '';
}, [rtSel()]);
ok('多语言：切回默认语言后标题/占位又变回中文',
  zhTitle === '配方'
  && (await page.locator(`${rtSel()} [data-rc="name"]`).getAttribute('placeholder')) === '配方名…',
  zhTitle);

/* ═══════════ 13. 收尾 ═══════════ */
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await page.evaluate(() => window.app.exitRun());
await sleep(200);
await browser.close();
browser = null;
apiNode.close();
apiNode = null;
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 配方控件（变量范围 / 保存 / 应用 / 删除）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
