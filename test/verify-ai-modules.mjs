// verify-ai-modules.mjs — AI 模块**单元级**回归：不调用任何模型，直接在页面里调 runTool()/aiTranslate 辅助函数
//
// 为什么要单独一套：e2e 那套要有假模型、跑得慢、只覆盖"happy path"；
// 真正的边界（变量不存在 / props 白名单 / 删除闸门 / 脚本语法 / 翻译幻觉过滤）在这里逐条钉死。
//
// 覆盖：
//   1. 工具契约：24 个名字、schema 形状、必填参数、提示词内容
//   2. 控件目录：30 个控件、按 type 查完整属性
//   3. 页面工具：add/update/delete/set_current/list/get_project
//   4. 变量工具：add/update/delete + 名字校验 + 改名重映射
//   5. 控件工具：props 白名单、变量存在性、批量摆放、改/选/删（含破坏性闸门）
//   6. 脚本工具：语法检查、await/import 拒绝、trigger 必填变量、改/删
//   7. 报警工具：级别/比较符校验、增改删
//   8. 翻译辅助：pendingStats/pendingFor/applyPairs（幻觉原文被丢弃）/langName
//
// 跑法：node test/verify-ai-modules.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installNodeFetchPatch } from './_wsfetch.mjs';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`); }
};
const section = t => console.log(`\n== ${t} ==`);

const EXPECTED_TOOLS = [
  'get_project', 'get_widget_catalog', 'list_pages',
  'add_page', 'update_page', 'delete_page', 'set_current_page',
  'add_widget', 'update_widget', 'delete_widgets', 'select_widgets',
  'list_vars', 'add_vars', 'update_var', 'delete_vars',
  'list_scripts', 'add_script', 'update_script', 'delete_script', 'check_script',
  'list_alarms', 'add_alarm', 'update_alarm', 'delete_alarm',
  'apply_layout_recipe', 'tidy_layout', 'inspect_layout',
];

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-ai-mod-'));
// 故意**不**写 ai.json：这套测试不碰模型，后端只提供 /api/ai/config 的默认值即可
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA },
});
installNodeFetchPatch(PORT);

const errors = [];
let browser = null;
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { await fetch(H + '/'); up = true; break; } catch { /* 还没起来 */ }
  }
  if (!up) throw new Error('后端 30s 内没起来：' + H);

  browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(H + '/', { waitUntil: 'load' });
  await sleep(2200);

  // 每个 section 一个 evaluate，后面的引用前面的副作用（工具都是真改工程）
  const ev = fn => page.evaluate(fn);

  // ── 1. 工具契约 + 提示词 ────────────────────────────────────────────────
  section('1. 工具契约（27 个名字 / schema / 提示词）');
  const surface = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const names = T.toolNames();
    const defs = T.TOOL_DEFS.map(d => ({
      type: d.type,
      name: d.function?.name,
      desc: String(d.function?.description || ''),
      paramsType: d.function?.parameters?.type,
      requiredArr: Array.isArray(d.function?.parameters?.required),
      propsObj: !!d.function?.parameters?.properties,
    }));
    const byName = Object.fromEntries(T.TOOL_DEFS.map(d => [d.function.name, d.function.parameters]));
    const cat = t => T.pickTools(t).map(d => d.function.name);
    const auto = T.pickTools('帮我把这个页面整理一下');
    return {
      names,
      uniq: new Set(names).size,
      defs,
      requiredPage: byName.update_page?.required || [],
      requiredType: byName.add_widget?.required || [],
      prompt: T.buildSystemPrompt(),
      brief: T.projectBrief(),
      unknown: T.runTool('不存在的工具', {}),
      badJson: T.runTool('list_pages', '{这不是 JSON'),
      pick: {
        base: cat(''),
        alarm: cat('加一个报警'),
        script: cat('写个脚本'),
        layout: cat('帮我排版好看点'),
        full: T.pickTools('x', 'full').map(d => d.function.name),
        autoChars: JSON.stringify(auto).length,
        fullChars: JSON.stringify(T.TOOL_DEFS).length,
      },
    };
  });
  ok(Array.isArray(surface.names) && surface.names.length === 27, '工具数量 = 27', surface.names?.length);
  ok(surface.uniq === 27, '工具名不重复');
  ok(EXPECTED_TOOLS.every(n => surface.names.includes(n)), '27 个名字与契约一致', EXPECTED_TOOLS.filter(n => !surface.names.includes(n)));
  ok(surface.defs.every(d => d.type === 'function' && d.name && d.desc.length > 8), '每个工具都有 type=function/name/description');
  ok(surface.defs.every(d => d.paramsType === 'object' && d.requiredArr && d.propsObj), 'parameters 都是 {type:object, properties, required}');
  ok(surface.defs.every(d => d.desc.startsWith('') && d.desc.length >= 8), '工具描述非空');
  ok(surface.requiredPage.includes('page'), 'update_page 必填 page', surface.requiredPage);
  ok(surface.requiredType.includes('type'), 'add_widget 必填 type', surface.requiredType);
  ok(surface.prompt.length > 2000, 'system prompt 有内容', surface.prompt.length);
  ok(surface.prompt.includes('【工作方式】') && surface.prompt.includes('【控件速查】') && surface.prompt.includes('【脚本可用 API】'), 'prompt 有工作方式/控件速查/脚本 API 三段');
  ok(surface.prompt.includes('【视觉规范】') && surface.prompt.includes('【布局配方】'), 'prompt 有视觉规范 + 布局配方两段（审美靠这个）');
  ok(surface.prompt.includes('apply_layout_recipe') && surface.prompt.includes('inspect_layout') && surface.prompt.includes('tidy_layout'), 'prompt 引导先铺配方、交付前自检');
  ok(/视觉风格/.test(surface.brief), 'projectBrief 带视觉风格（颜色/字号）');
  ok(surface.prompt.includes('hmi.v') && surface.prompt.includes('button=按钮'), 'prompt 含 hmi.v 与控件速查表');
  ok(surface.brief.includes('工程：') && surface.brief.includes('页面(') && surface.brief.includes('危险操作闸门'), 'projectBrief 含工程/页面/闸门状态');
  ok(surface.brief.includes('已关闭'), '默认状态：破坏性闸门关着');
  ok(!surface.unknown.ok && /没有工具/.test(surface.unknown.error || ''), '未知工具名 → ok:false');
  ok(!surface.badJson.ok && /JSON/.test(surface.badJson.error || ''), '参数不是合法 JSON → ok:false');
  // 按需下发工具（省 token）：一句话只带相关工具组，full 模式才是 27 个
  ok(surface.pick.base.includes('get_project') && surface.pick.base.includes('add_widget'), '基础工具集含 get_project/add_widget', surface.pick.base.length);
  ok(!surface.pick.base.includes('add_alarm') && !surface.pick.base.includes('add_script'), '基础工具集不含报警/脚本工具（按需再加）', surface.pick.base.filter(n => n === 'add_alarm' || n === 'add_script'));
  ok(surface.pick.alarm.includes('add_alarm') && surface.pick.alarm.includes('update_alarm'), '说"报警"时下发报警工具组', surface.pick.alarm.filter(n => /alarm/.test(n)));
  ok(surface.pick.script.includes('add_script') && surface.pick.layout.includes('apply_layout_recipe'), '说"脚本"/"排版"时下发对应工具组');
  ok(surface.pick.full.length === 27, 'full 模式下发全部 27 个', surface.pick.full.length);
  ok(surface.pick.autoChars < surface.pick.fullChars * 0.75, '按需下发后 schema 字符数至少省 25%', { auto: surface.pick.autoChars, full: surface.pick.fullChars });

  // ── 2. 控件目录 ────────────────────────────────────────────────────────
  section('2. 控件目录（get_widget_catalog 从注册表实时生成）');
  const cat = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const R = await import('/js/widgets/registry.js');
    const all = T.runTool('get_widget_catalog', {});
    const btn = T.runTool('get_widget_catalog', { type: 'button' });
    const nan = T.runTool('get_widget_catalog', { type: '不存在的控件' });
    return {
      regCount: R.registry.list().length,
      all,
      btn,
      nan,
    };
  });
  ok(cat.all.ok && Array.isArray(cat.all.data?.widgets), 'get_widget_catalog() 返回 widgets 数组');
  ok(cat.all.data.widgets.length === cat.regCount, '目录条数 = 注册表条数', { dir: cat.all.data.widgets.length, reg: cat.regCount });
  ok(cat.all.data.widgets.length === 30, '控件总数 30（README 里写的 29 是旧数）', cat.all.data.widgets.length);
  ok(cat.all.data.widgets.every(w => w.type && w.title && typeof w.w === 'number'), '简表每项有 type/title/默认尺寸');
  ok(cat.btn.ok && cat.btn.data?.type === 'button' && cat.btn.data?.title === '按钮', '按 type 查返回完整属性', cat.btn.data?.type);
  ok(Array.isArray(cat.btn.data?.props) && cat.btn.data.props.some(p => p.key === 'offText'), 'button 属性里有 offText', cat.btn.data?.props?.map(p => p.key).slice(0, 6));
  ok(Array.isArray(cat.btn.data?.actions) && cat.btn.data.actions.length === 9, 'button 支持 9 种动作', cat.btn.data?.actions?.length);
  ok(cat.btn.data.props.every(p => !p.key || p.key !== 'render'), '目录不带 render 函数');
  ok(!cat.nan.ok && /没有/.test(cat.nan.error || ''), '查不存在的控件 → ok:false');

  // ── 3. 页面工具 ────────────────────────────────────────────────────────
  section('3. 页面工具');
  const pages = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const P = window.app.project;
    const add1 = T.runTool('add_page', { name: '工具页', title: '工具页标题' });
    const add2 = T.runTool('add_page', { name: '工具页' });          // 重名 → 工具页2
    const addPopup = T.runTool('add_page', { name: '工具弹窗', type: 'popup', popupW: 300, popupH: 180 });
    const upd = T.runTool('update_page', { page: '工具页', title: '改后的标题' });
    const setCur = T.runTool('set_current_page', { page: '工具页' });
    const list = T.runTool('list_pages', {});
    const get = T.runTool('get_project', { page: '工具页' });
    // 整页一次读全：画两个控件（带属性值），看一次调用能不能把整页 + 属性值都拿到
    T.runTool('add_widget', { page: '工具页', items: [
      { type: 'label', x: 24, y: 24, w: 160, h: 32, props: { text: '整页一次读', fontSize: 18 } },
      { type: 'button', x: 24, y: 80, w: 110, h: 46, props: { offText: '启动', onText: '运行' } },
    ] });
    const whole = T.runTool('get_project', { page: '工具页' });
    const brief = T.runTool('get_project', { page: '工具页', detail: 'brief' });
    const wholePack = T.compactToolMessage('get_project', whole);
    const badPage = T.runTool('update_page', { page: '没有这个页面啊', title: 'x' });
    const empty = T.runTool('update_page', { page: '工具页' });
    return {
      add1, add2, addPopup, upd, setCur, list, get, badPage, empty,
      whole, brief, wholePack,
      names: P.pages().map(p => p.name),
      curName: P.currentPage()?.name || '',
      popup: P.pages().find(p => p.name === '工具弹窗') || null,
      toolPage: P.pages().find(p => p.name === '工具页') || null,
    };
  });
  ok(pages.add1.ok && pages.add1.data?.name === '工具页', 'add_page 建出「工具页」', pages.add1.data);
  ok(pages.names.includes('工具页') && pages.curName === '工具页', '新页面进了工程且成为当前页', { names: pages.names, cur: pages.curName });
  ok(pages.add2.ok && pages.add2.data?.name === '工具页2', '重名自动变「工具页2」', pages.add2.data?.name);
  ok(pages.addPopup.ok && pages.popup?.type === 'popup' && pages.popup?.popupW === 300, 'popup 尺寸生效', pages.popup && { w: pages.popup.popupW, h: pages.popup.popupH });
  ok(pages.toolPage?.title === '改后的标题', 'update_page 改了标题', pages.toolPage?.title);
  ok(pages.setCur.ok && pages.curName === '工具页', 'set_current_page 切回「工具页」');
  ok(pages.list.ok && pages.list.data.pages.length === pages.names.length, 'list_pages 条数对', pages.list.data?.pages?.length);
  ok(pages.list.data.pages.some(p => p.typeCn === '弹窗'), 'list_pages 带中文类型');
  ok(pages.get.ok && pages.get.data.page?.name === '工具页' && Array.isArray(pages.get.data.page.widgets), 'get_project(page) 返回该页控件');
  ok(!pages.badPage.ok && /找不到页面/.test(pages.badPage.error || ''), '页面不存在 → ok:false');
  ok(!pages.empty.ok && /没有任何要改/.test(pages.empty.error || ''), 'update_page 空改动 → ok:false');
  // 整页一次读全（用户反馈：以前按控件逐个 get_project，一轮一轮烧 token）
  const allW = pages.whole?.data?.page?.widgets || [];
  ok(pages.whole.ok && allW.length === pages.toolPage.widgets.length, 'get_project(page) 一次返回整页所有控件', { got: allW.length, real: pages.toolPage.widgets.length });
  const lbl = allW.find(x => x.type === 'label');
  ok(!!lbl && lbl.props && typeof lbl.props === 'object' && lbl.props.text === '整页一次读', '整页结果里带属性值（不用再按控件逐个查）', lbl && lbl.props);
  ok(pages.wholePack.length > 0 && pages.wholePack.includes('整页一次读'), '整页结果进历史后仍保留属性值', pages.wholePack.slice(0, 160));
  ok(pages.brief.ok && (pages.brief.data.page.widgets || []).every(x => Array.isArray(x.props) || !x.props), 'detail=brief 时属性只给键名', (pages.brief.data.page.widgets || []).slice(0, 2));

  // ── 4. 变量工具 ────────────────────────────────────────────────────────
  section('4. 变量工具');
  const vars = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const P = window.app.project;
    const add = T.runTool('add_vars', { vars: [{ name: 'aiVarA', type: 'bool' }, { name: 'aiVarB', type: 'int', value: 3 }] });
    const dup = T.runTool('add_vars', { vars: [{ name: 'aiVarA', type: 'bool' }] });
    const badName = T.runTool('add_vars', { vars: [{ name: '有 空格 的名字', type: 'bool' }] });
    const noArgs = T.runTool('add_vars', {});
    const ren = T.runTool('update_var', { name: 'aiVarB', newName: 'aiVarC' });
    const badType = T.runTool('update_var', { name: 'aiVarA', type: 'float' });
    const list = T.runTool('list_vars', {});
    return {
      add, dup, badName, noArgs, ren, badType, list,
      names: P.variables().map(v => v.name),
      vC: P.variables().find(v => v.name === 'aiVarC') || null,
      vA: P.variables().find(v => v.name === 'aiVarA') || null,
    };
  });
  ok(vars.add.ok && Array.isArray(vars.add.data?.variables) && vars.add.data.variables.length === 2, 'add_vars 一次建两个变量', vars.add.data);
  ok(vars.vC && vars.vC.type === 'int' && vars.vC.value === 3, '变量值/类型写进去了（aiVarB→aiVarC）', vars.vC && { type: vars.vC.type, v: vars.vC.value });
  ok(!vars.dup.ok && /一个都没建成/.test(vars.dup.error || ''), '重复变量 → ok:false 且提示跳过', vars.dup.error);
  ok(!vars.badName.ok && /非法字符/.test(vars.badName.error || ''), '非法变量名 → ok:false', vars.badName.error);
  ok(!vars.noArgs.ok, 'add_vars 不给 vars → ok:false');
  ok(vars.ren.ok && !vars.names.includes('aiVarB') && vars.names.includes('aiVarC'), 'update_var 改名生效');
  ok(!vars.badType.ok && /类型只能是/.test(vars.badType.error || ''), '非法变量类型 → ok:false');
  ok(vars.list.ok && vars.list.data.variables.some(v => v.name === 'aiVarA'), 'list_vars 能看到新变量');

  // ── 5. 控件工具 ────────────────────────────────────────────────────────
  section('5. 控件工具（白名单 / 变量存在性 / 摆放 / 闸门）');
  const wg = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const P = window.app.project;
    const canvas = await import('/js/editor/canvas.js');
    T.runTool('set_current_page', { page: '工具页' });
    const before = (P.currentPage()?.widgets || []).length;

    const one = T.runTool('add_widget', {
      page: '工具页', type: 'button', name: 'AI按钮',
      props: { offText: '启动', bogusProp: 1 }, variable: 'aiVarA',
    });
    const wid = one.data?.widgets?.[0]?.id || '';
    const wNow = P.getWidget(wid);
    const snap = wNow ? { props: JSON.parse(JSON.stringify(wNow.props || {})), bindings: JSON.parse(JSON.stringify(wNow.bindings || {})) } : { props: {}, bindings: {} };

    const noVar = T.runTool('add_widget', { page: '工具页', type: 'lamp', variable: '不存在的变量' });
    const badType = T.runTool('add_widget', { page: '工具页', type: '不存在的控件' });
    const batch = T.runTool('add_widget', { page: '工具页', type: 'switch', count: 3, layout: 'row', x: 100, y: 300, gap: 20 });
    const ids = (batch.data?.widgets || []).map(x => x.id);
    const moved = T.runTool('update_widget', { page: '工具页', ids: [wid], x: 520, y: 60, props: { offText: '停止' } });
    const w2 = P.getWidget(wid);
    const sel = T.runTool('select_widgets', { ids: [wid] });
    const selected = canvas.getSelection();
    // 模型经常把控件「名称」当 widgetId 传：要能按名称解析；查不到时错误里必须带"名称 = id"清单
    const wName = (wNow && wNow.name) || '';
    const byName = T.runTool('get_project', { page: '工具页', widgetId: wName });
    const byBad = T.runTool('get_project', { page: '工具页', widgetId: '这控件不存在' });
    const delDeny = T.runTool('delete_widgets', { page: '工具页', ids: [wid] });
    T.setAllowDestructive(true);
    const delOk = T.runTool('delete_widgets', { page: '工具页', ids: [wid] });
    // delete_widgets / select_widgets 的 ids 也接受控件名称（模型两种混用是常态）
    const tmpAdd = T.runTool('add_widget', { page: '工具页', type: 'label', name: '待删标签' });
    const delByName = T.runTool('delete_widgets', { page: '工具页', ids: ['待删标签'] });
    const selByName = T.runTool('select_widgets', { ids: ['待删标签'] });
    const after = (P.currentPage()?.widgets || []).length;

    return {
      before, one, wid, props: snap.props, bind: snap.bindings,
      warnings: one.warnings || [], noVar, badType, batch, ids: ids.length,
      xs: (batch.data?.widgets || []).map(x => x.x),
      moved, w2: w2 && { x: w2.x, y: w2.y, offText: w2.props?.offText },
      sel, selected, delDeny, delOk, after,
      byName, byBad, wName, delByName, selByName, tmpAddOk: tmpAdd.ok,
      names: (P.currentPage()?.widgets || []).map(x => x.name),
    };
  });
  ok(wg.one.ok, 'add_widget 成功', wg.one.error || wg.one.warnings);
  ok(wg.props.offText === '启动', 'props.offText 写进控件', wg.props);
  ok(Array.isArray(wg.warnings) && wg.warnings.some(t => /bogusProp/.test(String(t))), '白名单外属性 → warnings 提示', wg.warnings);
  ok(wg.bind.variable === 'aiVarA', '绑定变量写进 bindings.variable', wg.bind);
  ok(!wg.noVar.ok && /不在变量表/.test(wg.noVar.error || ''), '绑定不存在的变量 → ok:false', wg.noVar.error);
  ok(!wg.badType.ok && /没有/.test(wg.badType.error || ''), '不存在的控件类型 → ok:false');
  ok(wg.batch.ok && wg.ids === 3, 'count=3 批量加控件', wg.batch.error);
  ok(wg.xs.length === 3 && wg.xs[0] < wg.xs[1] && wg.xs[1] < wg.xs[2], 'row 布局 x 递增', wg.xs);
  ok(wg.moved.ok && wg.w2.x === 520 && wg.w2.y === 60, 'update_widget 改了位置', wg.w2);
  ok(wg.w2.offText === '停止', 'update_widget 改了属性', wg.w2);
  ok(wg.sel.ok && wg.selected.includes(wg.wid), 'select_widgets 让画布选中', wg.selected);
  ok(wg.byName.ok && wg.byName.data?.widget?.id === wg.wid, 'get_project 的 widgetId 支持填控件名称', { name: wg.wName, got: wg.byName.data?.widget?.id });
  ok(!wg.byBad.ok && /没有控件/.test(wg.byBad.error || '') && /「.+」= /.test(wg.byBad.hint || ''), '查不到控件时错误带「名称 => id」清单', { err: wg.byBad.error, hint: wg.byBad.hint });
  // 关键回归：失败结果进历史前会被 compactToolMessage 压缩，但"真实清单/hint"必须留着，否则模型只能继续瞎猜
  const compact = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const bad = T.runTool('get_project', { page: '工具页', widgetId: '猜的控件id' });
    const msg = T.compactToolMessage('get_project', bad);
    return { len: msg.length, hasHint: /「.+」= /.test(msg), parsed: JSON.parse(msg) };
  });
  ok(compact.hasHint, '失败结果瘦身后仍保留「名称 = id」清单（不然模型只能瞎猜）', { len: compact.len, parsed: compact.parsed });
  // get_project 查页面时必须带上控件 id（以前超 1200 字被整包砍掉，模型看不到 id 只能猜 "rect_标题条"）
  const packPage = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const got = T.runTool('get_project', { page: '工具页' });
    const msg = T.compactToolMessage('get_project', got);
    const j = JSON.parse(msg);
    return { len: msg.length, rows: (j.data && j.data.widgets) || [] };
  });
  ok(packPage.rows.some(x => /\|w_[^|]*\|/.test(String(x))), 'get_project 页面结果压缩后仍带控件 id', packPage.rows.slice(0, 2));
  ok(!wg.delDeny.ok && /破坏性操作/.test(wg.delDeny.error || ''), '没开闸门时删控件被拒', wg.delDeny.error);
  ok(wg.delOk.ok, '开闸门后删控件成功', wg.delOk.error);
  ok(wg.delByName.ok, 'delete_widgets 的 ids 支持填控件名称', wg.delByName.error);
  ok(!wg.selByName.ok && /都没找到/.test(wg.selByName.error || ''), '选已删掉的控件会明确说没找到', wg.selByName.error);
  ok(wg.after === wg.before + 3, '删完之后控件数 = 原来 +1按钮 +3开关 -1删除', { before: wg.before, after: wg.after });

  // ── 6. 脚本工具 ────────────────────────────────────────────────────────
  section('6. 脚本工具');
  const sc = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const P = window.app.project;
    const good = T.runTool('check_script', { code: 'let n = hmi.get("aiVarC") || 0;\nhmi.set("aiVarC", n + 1);' });
    const awaitBad = T.runTool('check_script', { code: 'await Promise.resolve();' });
    const domWarn = T.runTool('check_script', { code: 'window.alert(1);' });
    const loopWarn = T.runTool('check_script', { code: 'while (true) { }' });
    const add = T.runTool('add_script', { name: 'AI脚本', trig: 'interval', ms: 500, code: 'hmi.log("tick");' });
    const sid = add.data?.id || '';
    const created = P.getScript(sid);
    const createdSnap = created ? JSON.parse(JSON.stringify({ name: created.name, trig: created.trig, ms: created.ms, code: created.code })) : null;
    const addChangeNoVar = T.runTool('add_script', { trig: 'change', code: 'hmi.log(1);' });
    const addBadCode = T.runTool('add_script', { code: 'if (' });
    const upd = T.runTool('update_script', { id: sid, name: 'AI脚本改', trig: 'cycle' });
    const s = P.getScript(sid);
    T.setAllowDestructive(false);                     // 闸门先关上，验一次"被拒"
    const delDeny = T.runTool('delete_script', { id: sid });
    T.setAllowDestructive(true);
    const delOk = T.runTool('delete_script', { id: sid });
    const noId = T.runTool('update_script', { id: 'nope', name: 'x' });
    return {
      good, awaitBad, domWarn, loopWarn, add, sid, createdSnap, addChangeNoVar, addBadCode, upd, s,
      delDeny, delOk, noId, scripts: P.scripts().map(x => x.name),
    };
  });
  ok(sc.good.ok, 'check_script 合法代码 → ok', sc.good.error);
  ok(!sc.awaitBad.ok && /await/.test(sc.awaitBad.error || ''), 'check_script 拦住 await', sc.awaitBad.error);
  ok(sc.domWarn.ok && (sc.domWarn.warnings || []).some(t => /DOM/.test(String(t))), 'DOM 用法 → 提醒', sc.domWarn.warnings);
  ok(sc.loopWarn.ok && (sc.loopWarn.warnings || []).some(t => /死循环/.test(String(t))), 'while(true) → 死循环提醒', sc.loopWarn.warnings);
  ok(sc.add.ok && sc.createdSnap?.name === 'AI脚本', 'add_script 建脚本成功', sc.add.error);
  ok(sc.createdSnap && sc.createdSnap.trig === 'interval' && sc.createdSnap.ms === 500 && sc.createdSnap.code.includes('tick'), '脚本字段写对了', sc.createdSnap);
  ok(!sc.addChangeNoVar.ok && /variable/.test(sc.addChangeNoVar.error || ''), 'change 触发必须给 variable', sc.addChangeNoVar.error);
  ok(!sc.addBadCode.ok && /语法错误/.test(sc.addBadCode.error || ''), '语法错代码存不进去', sc.addBadCode.error);
  ok(sc.upd.ok && sc.s.name === 'AI脚本改' && sc.s.trig === 'cycle', 'update_script 改名/改触发', sc.s && { name: sc.s.name, trig: sc.s.trig });
  ok(!sc.noId.ok && /没有脚本/.test(sc.noId.error || ''), '改不存在的脚本 → ok:false');
  ok(!sc.delDeny.ok && /破坏性操作/.test(sc.delDeny.error || ''), '闸门关上时删脚本被拒', sc.delDeny.error);
  ok(sc.delOk.ok && !sc.scripts.includes('AI脚本改'), '闸门打开后删脚本成功', sc.delOk.error);

  // ── 7. 报警工具 ────────────────────────────────────────────────────────
  section('7. 报警工具');
  const al = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const P = window.app.project;
    const add = T.runTool('add_alarm', { name: 'AI报警', variable: 'aiVarC', op: '>', value: 10, level: 'warn', text: '超限' });
    const aid = add.data?.id || '';
    const a0 = P.getAlarm(aid);
    const aSnap = a0 ? JSON.parse(JSON.stringify({ name: a0.name, level: a0.level, op: a0.op, value: a0.value, text: a0.text })) : null;
    const badVar = T.runTool('add_alarm', { variable: '不存在变量', op: '>', value: 1 });
    const badOp = T.runTool('add_alarm', { variable: 'aiVarC', op: '<=>', value: 1 });
    const badLevel = T.runTool('add_alarm', { variable: 'aiVarC', op: '>', value: 1, level: 'fatal' });
    const upd = T.runTool('update_alarm', { id: aid, level: 'alarm', value: 20 });
    const a = P.getAlarm(aid);
    const list = T.runTool('list_alarms', {});
    T.setAllowDestructive(true);                          // 上一节已开，这里显式保证
    const del = T.runTool('delete_alarm', { id: aid });   // 应该能删
    const gone = P.getAlarm(aid);
    return { add, aid, aSnap, badVar, badOp, badLevel, upd, a, list, del, gone: !!gone, alarms: P.alarms().map(x => x.name) };
  });
  ok(al.add.ok && !!al.aid, 'add_alarm 成功', al.add.error);
  ok(al.aSnap && al.aSnap.level === 'warn' && al.aSnap.op === '>' && al.aSnap.value === 10, '报警字段写对', al.aSnap);
  ok(!al.badVar.ok && /不在变量表/.test(al.badVar.error || ''), '报警变量不存在 → ok:false');
  ok(!al.badOp.ok && /比较符只能是/.test(al.badOp.error || ''), '非法比较符 → ok:false');
  ok(!al.badLevel.ok && /级别只能是/.test(al.badLevel.error || ''), '非法级别 → ok:false');
  ok(al.upd.ok && al.a.level === 'alarm' && al.a.value === 20, 'update_alarm 改了级别/阈值', al.a && { lv: al.a.level, v: al.a.value });
  ok(al.list.ok && al.list.data.alarms.some(x => x.id === al.aid), 'list_alarms 能看到');
  ok(al.del.ok && !al.gone, 'delete_alarm 成功（闸门已开）', al.del.error);

  // ── 8. 翻译辅助 ────────────────────────────────────────────────────────
  section('8. 翻译辅助（pending / applyPairs 幻觉过滤）');
  const tr = await ev(async () => {
    const T = await import('/js/editor/aiTranslate.js');
    const I = await import('/js/core/i18n.js');
    const P = window.app.project;
    const p = P.pages().find(x => x.name === '工具页');
    P.updatePage(p.id, { title: '启动画面' });
    const stats = T.pendingStats();
    const byLang = T.pendingByLang();
    const forEn = T.pendingFor('en');
    const langs = T.commonLangs();
    // 只写两条：一条真实原文、一条模型幻觉
    const wrote = T.applyPairs('ja', [
      ['启动画面', '起動画面'],
      ['这句原文根本不存在', '存在しない'],
      ['启动画面', '启动画面'],   // 和原文相同 → same
    ], { label: 'AI 翻译（ja）' });
    const s = I.i18nState();
    return {
      stats, byLang, forEn, langs,
      jaName: T.langName('ja'),
      enName: T.langName('en'),
      unknownCode: T.langName('xx-zz'),
      defTarget: T.defaultTargetLang(),
      wrote,
      dictJa: (s.dict && s.dict.ja) || {},
      langList: (s.langs || []).map(l => l.code),
      getLang: I.getLang(),
      hasPage: !!P.pages().find(x => x.name === '工具页'),
    };
  });
  ok(tr.stats.total >= 2, 'pendingStats.total = 可翻译条数', tr.stats.total);
  ok(Array.isArray(tr.forEn) && tr.forEn.length > 0, 'pendingFor(en) 有待翻条目');
  ok(tr.forEn.every(e => e.source), '待翻条目都带 source');
  ok(tr.langs.length >= 8 && tr.langs.some(l => l.code === 'en'), 'commonLangs 有常见语言', tr.langs.length);
  ok(tr.jaName === '日本語' || /日/.test(tr.jaName), 'langName(ja) 有名字', tr.jaName);
  ok(/英|English/i.test(tr.enName), 'langName(en) = English', tr.enName);
  ok(tr.unknownCode === 'xx-zz', '未知语言码原样返回', tr.unknownCode);
  ok(typeof tr.defTarget === 'string' && tr.defTarget.length >= 2, 'defaultTargetLang 返回语言码', tr.defTarget);
  ok(tr.wrote.ok && tr.wrote.filled === 1, 'applyPairs 只写了真实原文 1 条', tr.wrote);
  ok(tr.wrote.unknown === 1, '幻觉原文被丢弃（unknown=1）', tr.wrote);
  ok(tr.wrote.same === 1, '与原文相同被跳过（same=1）', tr.wrote);
  ok(tr.dictJa['启动画面'] === '起動画面', '译文写进 meta.i18n.dict.ja', tr.dictJa);
  ok(!tr.dictJa['这句原文根本不存在'], '幻觉原文没写进字典');
  ok(tr.langList.includes('ja'), '语言表里多了 ja', tr.langList);
  ok(tr.getLang === 'ja', 'applyPairs 顺带切到目标语言预览', tr.getLang);

  // 8.5 译文长度自适应字号
  section('8.5 译文长度自适应字号（autofitLang）');
  const fit = await ev(async () => {
    const T = await import('/js/editor/aiTranslate.js');
    const I = await import('/js/core/i18n.js');
    const { project } = await import('/js/core/project.js');
    const pg = project.pages().find(p => p.name === '工具页');
    project.setCurrentPage(pg.id);
    const mk = (text, y) => {
      const w = project.addWidget('label', 40, y);
      project.updateWidgetProp(w.id, 'text', text);
      return w.id;
    };
    const idleId = mk('运行状态', 240);   // 译文短：不需要缩
    const fitId = mk('转速', 300);        // 译文长：需要缩一点
    const hugeId = mk('预警', 360);       // 译文超长：缩到最小仍放不下
    I.addLanguage('en', 'English');
    const s = I.i18nState();
    s.dict.en = Object.assign(s.dict.en || {}, {
      '运行状态': 'Run',
      '转速': 'Spindle speed actual value',
      '预警': 'Machine operation status and current production line information',
    });
    I.setLang('en');
    const before = I.fontFactorForWidget(project.getWidget(fitId));
    const r = T.autofitLang('en');
    const map = (I.i18nState().wsize && I.i18nState().wsize.en) || {};
    const after = I.fontFactorForWidget(project.getWidget(fitId));
    const key = id => String(id) + '|fontSize';
    const pxIdle = Number(map[key(idleId)]) || 0;
    const pxFit = Number(map[key(fitId)]) || 0;
    const pxHuge = Number(map[key(hugeId)]) || 0;
    // 译文改短 → 旧覆盖应被清掉
    I.i18nState().dict.en['转速'] = 'Speed';
    T.autofitLang('en');
    const map2 = (I.i18nState().wsize && I.i18nState().wsize.en) || {};
    return {
      before, after, r, pxIdle, pxFit, pxHuge,
      cleared: map2[key(fitId)] === undefined,
      effFit: I.fontFactorForWidget(project.getWidget(fitId)),
    };
  });
  ok(fit.r.shrunk >= 1, 'autofitLang 缩小了放不下的控件字号', fit.r);
  ok(fit.after < fit.before, '缩放系数变小了（渲染真的会变小）', { before: fit.before, after: fit.after });
  ok(fit.pxFit > 0 && fit.pxFit < 14, '放不下的控件写了 per-widget 小字号', fit.pxFit);
  ok(fit.pxIdle === 0, '本来放得下的控件不写覆盖', fit.pxIdle);
  ok(fit.pxHuge > 0, '超长译文控件也写了覆盖（已到最小字号）', fit.pxHuge);
  ok(fit.r.tooLong >= 1, '缩到最小仍放不下的控件会被计数', fit.r.tooLong);
  ok(fit.cleared, '译文变短后旧的字号覆盖被自动清掉');

  // ── 9. 视觉/排版（配方骨架 / 对齐 / 自检） ───────────────────────────────
  section('9. 视觉与排版（apply_layout_recipe / tidy_layout / inspect_layout）');
  const lay = await ev(async () => {
    const T = await import('/js/editor/aiTools.js');
    const { project } = await import('/js/core/project.js');
    const { history } = await import('/js/core/history.js');
    const out = {};
    const pg = T.runTool('add_page', { name: '排版页' });
    out.pageOk = pg.ok;
    const rec = T.runTool('apply_layout_recipe', {
      recipe: 'dashboard', page: '排版页',
      title: '运行看板', subtitle: '实时数据 · 2026-11-01', tag: '运行中',
      kpis: ['产量', '良率', 'OEE'], values: ['1200', '98%', '86%'], units: ['件', '', '%'],
    });
    const page = project.pages().find(p => p.name === '排版页');
    const ws = (page?.widgets || []);
    out.rec = {
      ok: rec.ok, count: rec.data?.count, label: history.lastLabel(),
      coords: ws.map(w => ({ x: w.x, y: w.y, w: w.w, h: w.h })),
      inCanvas: ws.every(w => w.x >= 0 && w.y >= 0 && w.x + w.w <= 1024 && w.y + w.h <= 600),
      multiGrid: ws.every(w => w.x % 8 === 0 && w.y % 8 === 0),
    };
    // 故意摆歪 + 重叠
    T.runTool('add_widget', { page: '排版页', type: 'button', x: 101, y: 77 });
    T.runTool('add_widget', { page: '排版页', type: 'label', x: 103, y: 79 });
    const before = T.runTool('inspect_layout', { page: '排版页' });
    const tidy = T.runTool('tidy_layout', { page: '排版页' });
    const after = T.runTool('inspect_layout', { page: '排版页' });
    out.beforeErr = (before.data?.issues || []).filter(i => i.level === 'error').length;
    out.beforeWarn = (before.data?.issues || []).filter(i => i.level === 'warn').map(i => i.message);
    out.tidy = { ok: tidy.ok, changed: tidy.data?.changed, summary: tidy.summary };
    out.afterErr = (after.data?.issues || []).filter(i => i.level === 'error').length;
    // 出界 → 自检报错 → 整理修复
    const r1 = T.runTool('add_widget', { page: '排版页', type: 'rect', x: 40, y: 40 });
    const wid = r1.data?.widgets?.[0]?.id;
    T.runTool('update_widget', { page: '排版页', ids: [wid], x: 5000 });
    const oob = T.runTool('inspect_layout', { page: '排版页' });
    out.oobErr = (oob.data?.issues || []).filter(i => i.level === 'error').map(i => i.message);
    const tidy2 = T.runTool('tidy_layout', { page: '排版页' });
    const oob2 = T.runTool('inspect_layout', { page: '排版页' });
    out.oobFixed = { changed: tidy2.data?.changed, errs: (oob2.data?.issues || []).filter(i => i.level === 'error').length };
    // 干净页（工具页先整理一遍，确保没有重叠/出界）
    T.runTool('tidy_layout', { page: '工具页' });
    const clean = T.runTool('inspect_layout', { page: '工具页' });
    out.clean = { ok: clean.ok, summary: clean.summary };
    // 未知配方
    out.badRecipe = T.runTool('apply_layout_recipe', { recipe: '不存在' });
    return out;
  });
  ok(lay.pageOk && lay.rec.ok, 'add_page + apply_layout_recipe(dashboard) 成功', lay.rec.ok);
  ok(lay.rec.count > 10, '配方铺出 >10 个控件', lay.rec.count);
  ok(lay.rec.coords.every(c => c.w > 0 && c.h > 0), '配方控件都有尺寸');
  ok(lay.rec.inCanvas, '配方控件全部在 1024×600 画布内');
  ok(lay.rec.multiGrid, '配方控件坐标都是 8 的倍数');
  ok(/AI 套用布局配方/.test(lay.rec.label || ''), '配方只压 1 步撤销（标签=AI 套用布局配方）', lay.rec.label);
  ok(lay.beforeErr > 0, '故意摆歪/重叠 → inspect_layout 报必改问题', lay.beforeErr);
  ok(lay.beforeWarn.some(m => /栅格/.test(m)), 'inspect_layout 提到没对齐 8px 栅格', lay.beforeWarn);
  ok(lay.tidy.ok && lay.tidy.changed > 0, 'tidy_layout 真的挪了控件', lay.tidy);
  ok(lay.afterErr === 0, 'tidy_layout 之后没有重叠/出界', lay.afterErr);
  ok(lay.oobErr.some(m => /超出画布/.test(m)), 'inspect_layout 报出界', lay.oobErr.slice(0, 2));
  ok(lay.oobFixed.errs === 0, 'tidy_layout 把出界控件收回画布', lay.oobFixed);
  ok(lay.clean.ok && /检查通过/.test(lay.clean.summary || ''), '干净的页面 inspect_layout 返回「检查通过」', lay.clean.summary);
  ok(!lay.badRecipe.ok && /没有配方/.test(lay.badRecipe.error || ''), '未知配方 → ok:false');

  // ── 10. 收尾 ───────────────────────────────────────────────────────────
  section('10. 收尾检查');
  const final = await ev(() => ({ appErrs: window.__appErrors || [], hasApp: !!window.app }));
  ok(final.hasApp, 'window.app 正常');
  ok(final.appErrs.length === 0, 'window.__appErrors 为空', final.appErrs);
  ok(errors.length === 0, '没有 pageerror / console.error / 4xx', errors.slice(0, 5));

  console.log(`\n===== AI 模块单测：${pass} 通过 / ${fail} 失败 =====`);
} catch (e) {
  fail++;
  console.error('\n✘ 测试崩了：', e && e.stack ? e.stack : e);
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { srv.kill(); } catch { /* ignore */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0);

