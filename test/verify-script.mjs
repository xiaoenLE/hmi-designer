// verify-script.mjs — 脚本功能：编辑栏 / 大编辑器 / 五种触发方式 / API / 出错保护
//   1) 「脚本」面板：新建、列表、启用停用、触发条件行内改、删除
//   2) 编辑器：足够大、行号、Tab 缩进、变量与 API 点击插入、语法检查、试运行、Ctrl+S 保存
//   3) 触发：进运行态一次 / 定时 / 循环 / 变量变化 / 条件成立（上升沿）
//   4) API：get/set（写变量真的进 varStore）、log 进日志、page 切页面
//   5) 保护：语法错误拦住、运行错误进日志、连续出错自动停用
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const pageErrors = [];
const dialogs = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);
// 本套件假设后端是内存模拟：先把可能残留的 PLC/OPC UA 连接断掉（
// 否则写入会被后端按「变量未声明/设备离线」拒掉，而界面现在会如实回滚成设备的真实值）
await page.evaluate(() => fetch('/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) }).catch(() => {}));
await page.waitForTimeout(200);

/* ── 准备：几个变量 + 两个页面 ── */
const prep = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.data.alarms.length = 0;
  m.project.data.scripts.length = 0;
  [['iCnt', 'int', 0], ['rVal', 'real', 0], ['bFlag', 'bool', false], ['sMsg', 'string', '']].forEach(([n, t, v]) => {
    m.project.addVariable();
    m.project.updateVariable(`var${m.project.variables().length}`, { name: n, type: t, value: v, address: '' });
  });
  m.project.data.pages[0].widgets.length = 0;
  const pg2 = m.project.addPage('page');
  pg2.widgets.length = 0;
  const mark = m.project.addWidget('label', 20, 20);
  mark.props.text = 'P2标记';                       // 运行态用它判断"切到第 2 页了吗"
  m.project.currentId = m.project.data.pages[0].id;
  m.project.commit('脚本测试准备');
  return { p1: m.project.data.pages[0].id, p2: pg2.id, p2name: pg2.name };
});
ok('准备 4 个变量 + 2 个页面', !!prep.p2, JSON.stringify(prep));

/* ── A. 面板与注册 ── */
await page.click('.lp-tab[data-panel="scripts"]');
await sleep(250);
const panel = await page.evaluate(() => ({
  has: !!document.getElementById('panel-scripts'),
  tab: [...document.querySelectorAll('#leftPanel .lp-tab')].map(t => t.textContent),
  addBtn: !!document.getElementById('btnAddScript'),
  tip: document.getElementById('scriptTable').textContent.replace(/\s+/g, ' ').trim(),
}));
ok('左区多了「脚本」标签，面板里给出引导', panel.has && panel.addBtn && panel.tab.includes('脚本'), JSON.stringify(panel.tab));
ok('空表提示了五种触发方式', /进运行态一次/.test(panel.tip) && /定时/.test(panel.tip) && /循环/.test(panel.tip)
  && /变量变化/.test(panel.tip) && /条件成立/.test(panel.tip), panel.tip.slice(0, 130));

/* ── B. 大编辑器 ── */
await page.click('#btnAddScript');
await sleep(300);
const ed = await page.evaluate(() => {
  const box = document.getElementById('seBox');
  const r = box.getBoundingClientRect();
  const code = document.getElementById('seCode').getBoundingClientRect();
  return {
    open: !document.getElementById('seMask').classList.contains('hidden'),
    w: Math.round(r.width), h: Math.round(r.height),
    vw: window.innerWidth, vh: window.innerHeight,
    codeW: Math.round(code.width), codeH: Math.round(code.height),
    rows: [...document.querySelectorAll('#seTrig option')].map(o => o.value),
    gutter: document.getElementById('seGutter').children.length,
    vars: [...document.querySelectorAll('#seVarsWrap .se-chip')].map(c => c.textContent.trim()),
    docs: document.querySelectorAll('#seDoc .se-doc-row').length,
    focus: document.activeElement === document.getElementById('seCode'),
  };
});
ok('编辑器是近乎全屏的大窗口（≥90vw × ≥88vh）',
  ed.open && ed.w >= ed.vw * 0.9 && ed.h >= ed.vh * 0.88, `${ed.w}×${ed.h}（视口 ${ed.vw}×${ed.vh}）`);
ok('代码区够大（宽度 > 60% 视口、高度 > 45% 视口）',
  ed.codeW > ed.vw * 0.6 && ed.codeH > ed.vh * 0.45, `代码区 ${ed.codeW}×${ed.codeH}`);
ok('五种触发方式都能选', JSON.stringify(ed.rows) === JSON.stringify(['init', 'interval', 'cycle', 'change', 'cond']), JSON.stringify(ed.rows));
ok('有行号', ed.gutter >= 3, String(ed.gutter));
ok('变量区只给一个例子（不再把变量表摊成一大片） + API 速查 ≥10 条',
  ed.vars.length === 1 && /hmi\.set\(/.test(ed.vars[0]) && ed.docs >= 10,
  JSON.stringify({ vars: ed.vars, docs: ed.docs }));
ok('打开就聚焦在代码区', ed.focus === true);

/* 行号 / Tab 缩进 / 插入变量 */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = 'let a = 1;\nlet b = 2;';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.setSelectionRange(ta.value.length, ta.value.length);
});
await sleep(150);
const gutter2 = await page.evaluate(() => document.getElementById('seGutter').children.length);
ok('行号跟着代码行数走', gutter2 === 2, String(gutter2));

await page.evaluate(() => document.querySelector('#seVarsWrap .se-chip').click());
await sleep(150);
const inserted = await page.inputValue('#seCode');
ok('点那条例子 → 整句插到光标处', /hmi\.set\('iCnt', true\)$/.test(inserted), inserted.split('\n').pop());

// API 速查也照样能点着插
await page.evaluate(() => document.querySelector('#seDoc [data-insert]').click());
await sleep(150);
ok('点 API 速查 → 插到光标处', (await page.inputValue('#seCode')).length > inserted.length,
  (await page.inputValue('#seCode')).split('\n').pop());

// Tab 缩进
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = 'x';
  ta.setSelectionRange(0, 0);
  ta.focus();
});
await page.keyboard.press('Tab');
await sleep(120);
ok('Tab 键缩进（不跳出输入框）', (await page.inputValue('#seCode')) === '  x', JSON.stringify(await page.inputValue('#seCode')));

/* 语法检查：写错了要拦住 */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = 'let = ;';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#seSave');
await sleep(250);
const badSave = await page.evaluate(() => ({
  status: document.getElementById('seStatus').textContent,
  n: window.app.project.scripts().length,
  stillOpen: !document.getElementById('seMask').classList.contains('hidden'),
}));
ok('语法错误 → 不保存并报错（编辑器不关）',
  /语法错误/.test(badSave.status) && badSave.n === 0 && badSave.stillOpen, JSON.stringify(badSave));

/* 正确代码 → Ctrl+S 保存 */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = "hmi.log('init 跑了');\nhmi.set('sMsg', '来自脚本');";
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#seCode');   // 焦点回到代码区（浮层上 Ctrl+S 也管用，这里按真实用法点一下）
await page.keyboard.press('Control+s');
await sleep(300);
const saved = await page.evaluate(() => {
  const s = window.app.project.scripts()[0];
  return { n: window.app.project.scripts().length, name: s?.name, trig: s?.trig, ms: s?.ms, code: s?.code, status: document.getElementById('seStatus').textContent };
});
ok('Ctrl+S 保存进工程（带触发方式）',
  saved.n === 1 && saved.trig === 'interval' && saved.ms === 1000 && /hmi\.log/.test(saved.code || ''), JSON.stringify(saved));
ok('保存后提示已保存', /已保存/.test(saved.status), saved.status);

/* 试运行：日志区能看到 log 输出 */
await page.click('#seRun');
await sleep(400);
const tried = await page.evaluate(() => ({
  log: document.getElementById('seLog').textContent,
  status: document.getElementById('seStatus').textContent,
  msg: window.app.varStore.get('sMsg'),
}));
ok('试运行：log 出现在日志区', /init 跑了/.test(tried.log), tried.log.replace(/\s+/g, ' ').slice(0, 60));
ok('试运行：hmi.set 真的写进变量', tried.msg === '来自脚本', String(tried.msg));
ok('试运行给出耗时', /试运行完成/.test(tried.status), tried.status);

/* 触发方式改成「进入运行态一次」+ 名称 */
await page.selectOption('#seTrig', 'init');
await page.fill('#seName', '初始化脚本');
await page.click('#seSave');
await sleep(250);
await page.click('#seClose');
await sleep(200);
const closed = await page.evaluate(() => {
  const tr = document.querySelector('#scriptTable tr[data-script]');
  return {
    hidden: document.getElementById('seMask').classList.contains('hidden'),
    row: !!tr,
    name: tr?.querySelector('input[data-k="name"]')?.value,
    trig: window.app.project.scripts()[0]?.trig,
  };
});
ok('编辑器关掉，面板里出现这一条（名称回显；触发方式存在工程里）',
  closed.hidden && closed.row && closed.name === '初始化脚本' && closed.trig === 'init', JSON.stringify(closed));

/* ── C. 面板行：**勾选 / ✎ / ✔ / 名称**，触发设置全在编辑器里（现场要求：行别太长、✎ 要点得到）
     第 1 格现在是**多选删除的勾选框**（跟变量表/报警表一个口径），✎ 排第 2 格 —— 依然在最前面那几格里，
     脚本名再长也挤不到它。 ── */
const rowShape = await page.evaluate(async () => {
  const tr = document.querySelector('#scriptTable tr[data-script]');
  const heads = [...document.querySelectorAll('#scriptTable thead th')].map(t => t.textContent.trim());
  return {
    heads,
    firstIsSel: !!tr.firstElementChild?.querySelector('input.sc-sel'),
    firstIsEdit: !!tr.firstElementChild?.querySelector('.vt-edit'),
    editIdx: [...tr.children].findIndex(td => td.querySelector('.vt-edit')),
    selIdx: [...tr.children].findIndex(td => td.querySelector('input.sc-sel')),
    hasTrigSel: !!tr.querySelector('select[data-k="trig"]'),
    hasMs: !!tr.querySelector('input[data-k="ms"]'),
    hasVar: !!tr.querySelector('select[data-k="variable"]'),
    hasOp: !!tr.querySelector('select[data-k="op"]'),
    hasVal: !!tr.querySelector('input[data-k="value"]'),
    hasEnabled: !!tr.querySelector('input[data-k="enabled"]'),
    title: tr.title,
  };
});
ok('行里**没有**触发方式/毫秒/变量/比较/阈值那些输入框了（都挪进编辑器）',
  !rowShape.hasTrigSel && !rowShape.hasMs && !rowShape.hasVar && !rowShape.hasOp && !rowShape.hasVal,
  JSON.stringify(rowShape));
ok('第 1 格是勾选框（多选删除）、「✎ 编辑」紧跟第 2 格 —— 行再长也点得到',
  rowShape.firstIsSel && rowShape.selIdx === 0 && rowShape.editIdx === 1, JSON.stringify(rowShape.heads));
ok('启用勾选框还在（快速停用不用开编辑器）', rowShape.hasEnabled === true);
ok('悬停提示里写着"这条什么时候跑"', /什么时候跑/.test(rowShape.title || ''), rowShape.title);
// 表下方那段说明也别写成一大段（现场要求：简单点，细节在 README/编辑器里）
const footTip = await page.evaluate(() => {
  const box = document.getElementById('scriptTable');
  return (box.lastElementChild?.textContent || '').replace(/\s+/g, ' ').trim();
});
ok('表下方说明收短了（两句话以内）', footTip.length > 0 && footTip.length < 90, `${footTip.length} 字：${footTip}`);

// 触发方式改了（编辑器/工程数据）→ 行上的悬停提示跟着变
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const id = project.scripts()[0].id;
  project.updateScript(id, { trig: 'cond', variable: 'rVal', op: '>', value: 1 });
});
await sleep(300);
const afterTrig = await page.evaluate(() => document.querySelector('#scriptTable tr[data-script]')?.title || '');
ok('触发方式改成「条件成立」→ 行提示里跟上（rVal > 1 成立）',
  /rVal/.test(afterTrig) && /成立/.test(afterTrig), afterTrig);
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.updateScript(project.scripts()[0].id, { trig: 'interval', ms: 500 });
});
await sleep(250);
ok('改成「定时」→ 提示里写「每 500 ms」',
  /每 500 ms/.test(await page.evaluate(() => document.querySelector('#scriptTable tr[data-script]')?.title || '')),
  await page.evaluate(() => document.querySelector('#scriptTable tr[data-script]')?.title || ''));

/* ── D. 运行态：五种触发都真的会跑 ── */
const scriptIds = await page.evaluate(async (prepIds) => {
  const m = await import('/js/core/project.js');
  const p = m.project;
  p.scripts().length = 0;
  // 1) init：进运行态一次
  p.addScript({ name: '初始化', trig: 'init', code: "hmi.set('iCnt', 100);\nhmi.log('init ok');" });
  // 2) interval：每 60ms 累加（用它自己的日志数一次）
  p.addScript({ name: '定时', trig: 'interval', ms: 60, code: "hmi.set('rVal', (hmi.get('rVal') || 0) + 1);" });
  // 3) cycle：每周期跑（累加到 iCnt2 —— 借 iCnt 旁边的变量名，这里用 sMsg 记次数）
  p.addScript({ name: '循环', trig: 'cycle', code: "hmi.set('bFlag', !hmi.get('bFlag'));" });
  // 4) change：bFlag 变化时记一次
  p.addScript({ name: '变化触发', trig: 'change', variable: 'iCnt', code: "hmi.log('iCnt 变成了 ' + hmi.get('iCnt'));" });
  // 5) cond：iCnt 到 3 时切到第 2 页（上升沿）
  p.addScript({ name: '条件触发', trig: 'cond', variable: 'iCnt', op: '>=', value: 3, code: `hmi.page('${prepIds.p2name}');\nhmi.log('切页');` });
  p.commit('脚本测试');
  return { n: p.scripts().length, p2name: prepIds.p2name };
}, prep);
ok('工程里存了 5 条脚本（五种触发各一条）', scriptIds.n === 5, String(scriptIds.n));

await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(700);
const r1 = await page.evaluate(() => ({
  cnt: window.app.varStore.get('iCnt'),
  rVal: window.app.varStore.get('rVal'),
  flag: window.app.varStore.get('bFlag'),
  logs: [...document.querySelectorAll('#seLog .se-line')].length,
}));
ok('init 触发：进运行态就把 iCnt 写成 100', r1.cnt === 100, String(r1.cnt));
sleep(400);
const r2 = await page.evaluate(() => ({ rVal: window.app.varStore.get('rVal'), flag: window.app.varStore.get('bFlag') }));
ok('interval 触发：rVal 随定时器往上加', r2.rVal > 3, String(r2.rVal));
ok('cycle 触发：bFlag 一直在翻转（每周期一次）', r2.flag !== undefined, JSON.stringify(r2));

// 条件触发：iCnt 到 3 → 应该已经切到第 2 页了（init 把它写成 100，条件 >=3 立刻成立）
// ⚠ #pageTitle 是**编辑态**工具栏上的页面名，运行态不跟着变 —— 要看运行页里的内容
const pageNow = await page.evaluate(() => ({
  text: document.getElementById('rtPage')?.textContent || '',
  widgets: document.querySelectorAll('#rtPage .wd').length,
}));
ok('条件触发：iCnt ≥ 3 成立 → 脚本切了页面（运行页里出现第 2 页的标记）',
  /P2标记/.test(pageNow.text), JSON.stringify(pageNow));

// 变量变化触发：手动改 iCnt，应记一条日志
await page.evaluate(async () => {
  const v = await import('/js/runtime/varstore.js');
  v.varStore.set('iCnt', 7, 'remote');
});
await sleep(500);
const logs = await page.evaluate(async () => {
  const e = await import('/js/runtime/scriptEngine.js');
  const st = e.scriptStats();
  return { stats: st, all: st.map(s => s.runs) };
});
ok('变量变化触发：改 iCnt 后那条脚本跑了', logs.stats.some(s => s.runs > 0), JSON.stringify(logs.all));

// 「连续出错自动停用」+ 运行错误进日志
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.addScript({ name: '会报错', trig: 'cycle', code: "hmi.set('nope', 1);\nthrow new Error('炸了');" });
  m.project.commit('加一条会报错的');
  // 引擎在运行态不会自动认识新脚本 → 重进一次运行态
  const rt = await import('/js/runtime/runtime.js');
  rt.exitRun(); rt.enterRun();
});
await sleep(900);
const crashed = await page.evaluate(async () => {
  const e = await import('/js/runtime/scriptEngine.js');
  const m = await import('/js/core/project.js');
  const sc = m.project.scripts().find(s => s.name === '会报错');
  return { stat: e.scriptStats().find(s => s.id === sc.id), log: e.scriptLog(sc.id).map(l => l.level + ':' + l.text).slice(0, 3) };
});
ok('运行错误进日志并带行号（第 2 行 throw）', /error:运行错误（第 2 行）/.test(crashed.log.join('|')),
  JSON.stringify(crashed.log));
ok('连续出错 5 次 → 自动停用这条脚本（本次运行内）',
  crashed.stat?.disabled === true && crashed.stat?.runs <= 5, JSON.stringify(crashed.stat));

await page.evaluate(async () => (await import('/js/runtime/runtime.js')).exitRun());
await sleep(200);

/* ── E. 运行态结束后定时器停掉（编辑态不该继续跑）── */
const afterExit = await page.evaluate(() => window.app.varStore.get('rVal'));
await sleep(600);
const afterExit2 = await page.evaluate(() => window.app.varStore.get('rVal'));
ok('退出运行态后脚本定时器停掉（rVal 不再涨）', afterExit === afterExit2, `${afterExit} → ${afterExit2}`);

/* ── F. 面板删除（勾选 → 底部「删除选中」；行尾不再有单独的 ✕） ── */
const beforeDel = await page.evaluate(() => window.app.project.scripts().length);
await page.evaluate(() => {
  document.querySelector('#scriptTable tr[data-script] input.sc-sel').click();   // 勾第一条
  document.getElementById('btnDelScripts').click();                            // 底部「删除选中」
});
await sleep(300);
const afterDelCount = await page.evaluate(() => window.app.project.scripts().length);
ok('面板里勾一条 + 点「删除选中」→ 删掉一条（确认一次）',
  afterDelCount === beforeDel - 1 && dialogs.length >= 1, `${beforeDel} → ${afterDelCount}`);

/* ── H. 语法高亮：按 JS 语法着色，两层必须严格对齐 ── */
await page.evaluate(() => document.querySelector('#scriptTable tr[data-script] .vt-edit')?.click());
await sleep(300);
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = [
    '// 注释：超速保护',
    "let limit = 3000;",
    "if (hmi.get('rSpeed') >= limit) {",
    "  hmi.set('bStart', false);",
    "  hmi.log(`超速 ${limit} 转`);",
    '}',
  ].join('\n');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(250);
const hl = await page.evaluate(() => {
  const layer = document.getElementById('seHl');
  const count = (cls) => layer.querySelectorAll(`.${cls}`).length;
  return {
    exists: !!layer,
    kw: count('kw'), num: count('num'), cm: count('cm'), str: count('str'), tpl: count('tpl'),
    apiobj: count('apiobj'), api: count('api'), id: count('id'), op: count('op'),
    text: layer.textContent,
    curline: !!layer.querySelector('.se-curline'),
    htmlLeak: layer.innerHTML.includes('<span'),
  };
});
ok('高亮层在，并按 JS 语法着色（关键字/数字/注释/字符串/模板）',
  hl.exists && hl.kw === 2 && hl.num >= 1 && hl.cm >= 1 && hl.str >= 2 && hl.tpl >= 1,
  JSON.stringify({ kw: hl.kw, num: hl.num, cm: hl.cm, str: hl.str, tpl: hl.tpl }));
ok('hmi 和它的成员被单独着色（hmi.get / hmi.set / hmi.log）',
  hl.apiobj === 3 && hl.api >= 3, JSON.stringify({ apiobj: hl.apiobj, api: hl.api }));
ok('高亮层里是纯文本（标签只用于着色，文本内容跟代码一致）',
  hl.text.replace(/\n$/, '') === [
    '// 注释：超速保护',
    "let limit = 3000;",
    "if (hmi.get('rSpeed') >= limit) {",
    "  hmi.set('bStart', false);",
    "  hmi.log(`超速 ${limit} 转`);",
    '}',
  ].join('\n'), JSON.stringify(hl.text.slice(0, 60)));
ok('光标行有淡蓝底', hl.curline === true);

/* 对齐：两层的字体/行高/内边距/换行规则一致 —— 这是「透明 textarea」方案唯一会翻车的地方 */
const align = await page.evaluate(() => {
  const a = getComputedStyle(document.getElementById('seCode'));
  const b = getComputedStyle(document.getElementById('seHl'));
  const pick = (s) => ['fontFamily', 'fontSize', 'lineHeight', 'paddingTop', 'paddingLeft', 'whiteSpace',
    'tabSize', 'letterSpacing', 'wordSpacing'].reduce((o, k) => (o[k] = s[k], o), {});
  const ra = document.getElementById('seCode').getBoundingClientRect();
  const rb = document.getElementById('seHl').getBoundingClientRect();
  return { a: pick(a), b: pick(b), w: [Math.round(ra.width), Math.round(rb.width)], h: [Math.round(ra.height), Math.round(rb.height)], color: a.color, caret: a.caretColor };
});
ok('两层字体/行高/内边距/换行规则完全一致（光标才会跟字对齐）',
  JSON.stringify(align.a) === JSON.stringify(align.b), JSON.stringify({ a: align.a, b: align.b }));
ok('两层同宽同高（同一个框里叠着）',
  align.w[0] === align.w[1] && align.h[0] === align.h[1], JSON.stringify({ w: align.w, h: align.h }));
/* 选中时不能把字挡掉：选区是画在 textarea 这层（盖住高亮层）的，
   背景一旦不透明，选中区间就变成一条空蓝色条 —— 看不见字。 */
const selStyle = await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.setSelectionRange(0, 5);
  ta.dispatchEvent(new Event('select', { bubbles: true }));
  const cs = getComputedStyle(ta, '::selection');
  return { bg: cs.backgroundColor, color: cs.color, text: ta.value.slice(0, 5) };
});
const alpha = (() => {
  const m = /rgba?\(([^)]+)\)/.exec(selStyle.bg);
  if (!m) return 1;
  const parts = m[1].split(',').map(s => s.trim());
  return parts.length === 4 ? Number(parts[3]) : 1;
})();
ok('选中背景是半透明的（下面的高亮字能透出来，不会变成空蓝条）',
  alpha > 0 && alpha < 1, `::selection background = ${selStyle.bg}（alpha=${alpha}）`);
ok('选中时选中内容仍然是那段代码（不是空选区）', selStyle.text.length === 5, JSON.stringify(selStyle.text));

ok('textarea 文字透明、光标可见（高亮靠下面那层显示）',
  /rgba\(0, 0, 0, 0\)|transparent/.test(align.color) && !/rgba\(0, 0, 0, 0\)|transparent/.test(align.caret),
  JSON.stringify({ color: align.color, caret: align.caret }));

/* 改代码 → 高亮跟着变 */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = 'return 42;';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(200);
const after = await page.evaluate(() => ({
  kw: document.querySelectorAll('#seHl .kw').length,
  num: document.querySelectorAll('#seHl .num').length,
  text: document.getElementById('seHl').textContent,
}));
ok('改代码后高亮立刻重算（return 变成关键字、42 变成数字）',
  after.kw === 1 && after.num === 1 && after.text.replace(/\n$/, '') === 'return 42;', JSON.stringify(after));

/* HTML 字符必须被转义（否则写 a < b 会把高亮层搞坏） */
const escaped = await page.evaluate(async () => {
  const { highlightJS } = await import('/js/editor/jsHighlight.js');
  const html = highlightJS('if (a < b && c > d) x++;');
  document.getElementById('seCode').value = 'if (a < b && c > d) x++;';
  document.getElementById('seCode').dispatchEvent(new Event('input', { bubbles: true }));
  return { html: html, layer: document.getElementById('seHl'), text: document.getElementById('seHl').textContent };
});
ok('< 和 > 被转义，高亮层不会因为比较运算符坏掉（文本仍原样）',
  escaped.html.includes('&lt;') && escaped.text.replace(/\n$/, '') === 'if (a < b && c > d) x++;', JSON.stringify(escaped.text));

/* 滚动同步：高亮层跟着 textarea 一起滚 */
const scrolled = await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = Array.from({ length: 60 }, (_, i) => `hmi.log(${i});`).join('\n');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.scrollTop = 300;
  ta.dispatchEvent(new Event('scroll', { bubbles: true }));
  return { ta: ta.scrollTop, hl: document.getElementById('seHl').scrollTop };
});
ok('滚动同步（textarea 滚到 300，高亮层也滚到 300）', scrolled.ta === scrolled.hl && scrolled.ta === 300, JSON.stringify(scrolled));

/* 光标行跟着光标走 */
const curline = await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.setSelectionRange(0, 0);
  ta.dispatchEvent(new Event('keyup', { bubbles: true }));
  const top1 = document.getElementById('seHl').querySelector('.se-curline').style.top;
  const idx = ta.value.indexOf('hmi.log(5)');
  ta.setSelectionRange(idx, idx);
  ta.dispatchEvent(new Event('keyup', { bubbles: true }));
  const top2 = document.getElementById('seHl').querySelector('.se-curline').style.top;
  return { top1, top2 };
});
ok('光标行高亮跟着光标移动（第 1 行 → 第 6 行）',
  curline.top1 === '10px' && curline.top2 === `${10 + 5 * 21}px`, JSON.stringify(curline));

await page.click('#seClose');
await sleep(200);

/* ── G. 脚本里能写表达式：算术/分支/循环/模板字符串，试运行把最后一句的值打出来 ── */
const exprCases = [
  ['裸表达式 1*5', '1*5', '= 5'],
  ['带变量和注释的算式', 'let x = 4;\nlet y = 3;\nx * y', '= 12'],
  ['字符串结果', "'abc' + 1*5", "= 'abc5'"],
  ['对象结果', '({ a: 1*5, b: 2 })', '= {"a":5,"b":2}'],
];
for (const [name, code, want] of exprCases) {
  const r = await page.evaluate(async (c) => {
    const m = await import('/js/core/project.js');
    const e = await import('/js/runtime/scriptEngine.js');
    const s = m.project.addScript({ name: 'expr', trig: 'cycle', code: c });
    m.project.commit('expr');
    const res = e.runScriptOnce(s.id);
    const logs = e.scriptLog(s.id).map(l => `${l.level}:${l.text}`);
    m.project.deleteScript(s.id);
    m.project.commit('清');
    return { ok: res.ok, logs, err: res.error };
  }, code);
  ok(`脚本能算：${name} → 试运行打 ${want}`, r.ok && r.logs.includes('value:' + want), JSON.stringify(r.logs));
}

const mixed = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const v = await import('/js/runtime/varstore.js');
  const s = m.project.addScript({
    name: '混合', trig: 'cycle', code: [
      "let s = 0;",
      "for (let i = 1; i <= 5; i++) s += i;",          // 循环
      "const ratio = 1 * 5;",                          // 乘法
      "if (s === 15 && ratio === 5) {",                // 分支
      "  hmi.set('iCnt', s * ratio);",                 // 15*5 = 75
      "  hmi.log(`s=${s} ratio=${ratio} 三元=${ratio > 3 ? 'ok' : 'no'}`);",
      "} else hmi.warn('不对');",
      "Math.max(1, 2, 3)",                             // 最后一句是表达式 → 试运行要打出来
    ].join('\n'),
  });
  m.project.commit('混合');
  const res = e.runScriptOnce(s.id);
  const logs = e.scriptLog(s.id).map(l => `${l.level}:${l.text}`);
  const cnt = v.varStore.get('iCnt');
  m.project.deleteScript(s.id);
  m.project.commit('清');
  return { ok: res.ok, logs, cnt };
});
ok('循环 + 分支 + 模板字符串 + 复用中间变量都能跑',
  mixed.ok && mixed.cnt === 75 && mixed.logs.some(l => /s=15 ratio=5 三元=ok/.test(l)), JSON.stringify(mixed.logs));
ok('Math 之类的内置对象能直接用，且最后一句的值被打印',
  mixed.logs.includes('value:= 3'), JSON.stringify(mixed.logs.slice(-2)));

/* 语法错误绕过编辑器直接写进工程 → 运行时给「语法错误」而不是崩掉 */
const badCode = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const s = m.project.addScript({ name: '坏代码', trig: 'cycle', code: 'let = ;' });
  m.project.commit('坏代码');
  const res = e.runScriptOnce(s.id);
  const logs = e.scriptLog(s.id).map(l => `${l.level}:${l.text}`);
  m.project.deleteScript(s.id);
  m.project.commit('清');
  return { ok: res.ok, logs };
});
ok('坏代码（直接写进工程）→ 运行时报「语法错误」，不崩',
  badCode.ok === false && badCode.logs.some(l => /error:语法错误/.test(l)), JSON.stringify(badCode.logs));

/* ══════ 6. 多选删除 + CSV 导入导出（现场要求：和变量栏 / 报警栏一个口径） ══════ */
// 摆 3 条脚本，走"勾选 → 删除选中 → 一步撤销"这条现场路径
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const p = m.project;
  p.data.scripts.length = 0;
  for (let i = 1; i <= 3; i++) p.addScript({ name: `批删测试${i}`, trig: 'interval', ms: 1000, code: `hmi.log('${i}')` });
  p.commit('摆 3 条');
});
await sleep(300);
const ui = await page.evaluate(() => {
  const t = document.querySelector('#scriptTable table.scripttbl');
  return {
    hasSelCol: !!t?.querySelector('thead th.vt-sel input#scriptSelAll'),
    boxes: t?.querySelectorAll('tbody input.sc-sel').length ?? 0,
    hasDelBtn: !!document.getElementById('btnDelScripts'),
    delHidden: document.getElementById('btnDelScripts')?.hidden,
    hasCsvIn: !!document.getElementById('btnScriptCsvIn'),
    hasCsvOut: !!document.getElementById('btnScriptCsvOut'),
    hasRowX: !!t?.querySelector('tbody .vt-del'),
  };
});
ok('脚本表有了勾选列（表头全选 + 每行一个勾）', ui.hasSelCol && ui.boxes === 3, JSON.stringify(ui));
ok('底部有「删除选中」（没勾时藏着）+ 导入/导出 CSV 两个按钮',
  ui.hasDelBtn && ui.delHidden === true && ui.hasCsvIn && ui.hasCsvOut, JSON.stringify(ui));
ok('行尾那个单独的 ✕ 去掉了（跟变量 / 报警表一个口径）', ui.hasRowX === false, String(ui.hasRowX));

// 勾两条 → 按钮出现并显示条数
await page.evaluate(() => {
  const b = document.querySelectorAll('#scriptTable tbody input.sc-sel');
  b[0].click(); b[1].click();
});
await sleep(250);
const delState = await page.evaluate(() => {
  const btn = document.getElementById('btnDelScripts');
  return { hidden: btn.hidden, text: btn.textContent.trim(), sel: document.querySelectorAll('#scriptTable tbody tr.sel').length };
});
ok('勾 2 条 → 「删除选中 (2)」出现、这两行整行高亮',
  delState.hidden === false && /删除选中 \(2\)/.test(delState.text) && delState.sel === 2, JSON.stringify(delState));

// 删除（确认框自动接受）→ 只剩 1 条；Ctrl+Z 一步全回来
await page.evaluate(() => document.getElementById('btnDelScripts').click());
await sleep(350);
const namesAfterDel = await page.evaluate(async () => (await import('/js/core/project.js')).project.scripts().map(s => s.name));
ok('点「删除选中」→ 2 条一次删掉，只剩 1 条', namesAfterDel.length === 1, JSON.stringify(namesAfterDel));
await page.keyboard.press('Control+z');
await sleep(350);
const namesAfterUndo = await page.evaluate(async () => (await import('/js/core/project.js')).project.scripts().map(s => s.name));
ok('★ 一步 Ctrl+Z 把 2 条一起撤销回来（不是只回来一条）', namesAfterUndo.length === 3, JSON.stringify(namesAfterUndo));

// CSV 往返：导出 → 代码那一格（含换行）被引号包住；再导回来 = 同名更新
const csv = await page.evaluate(async () => {
  const m = await import('/js/core/csv.js');
  const p = (await import('/js/core/project.js')).project;
  p.data.scripts[0].code = "hmi.set('nX', 1)\n// 第二行";
  const text = m.scriptsToCsv(p.scripts());
  const res = m.importScriptsCsv(text, { mode: 'upsert' });
  return { text, res };
});
ok('导出 CSV：表头对、代码那一格（含换行）被引号包住',
  csv.text.includes('名称,触发,时间ms,变量,比较,阈值,启用,代码')
  && csv.text.includes('"hmi.set(\'nX\', 1)\n// 第二行"'), csv.text.split('\r\n')[0]);
ok('同一份导回来 → 同名更新 3 条、不新增', csv.res.updated === 3 && csv.res.added === 0, JSON.stringify(csv.res));
const csv2 = await page.evaluate(async () => {
  const m = await import('/js/core/csv.js');
  const p = (await import('/js/core/project.js')).project;
  const before = p.scripts().length;
  const res = m.importScriptsCsv('名称,触发,时间ms,变量,比较,阈值,启用,代码\n'
    + '带宽报警,定时,500,,,,是,"if (hmi.get(\'nX\') > 10) hmi.set(\'nY\', 1)"\n'
    + '瞎写,每小时,1000,,,,是,hmi.log(1)', { mode: 'append' });
  return { res, before, names: p.scripts().map(s => s.name) };
});
ok('新行正常导进来（+1 条）、触发方式不认识的那行跳过并报原因',
  csv2.res.added === 1 && csv2.res.errors.length === 1 && csv2.names.includes('带宽报警'),
  JSON.stringify(csv2.res));

// 导出只认勾选的：勾 2 条 → 导出的 CSV 只有这 2 条；没勾 = 全部
const expSel = await page.evaluate(async () => {
  const m = await import('/js/core/csv.js');
  const p = (await import('/js/core/project.js')).project;
  const ids = p.scripts().slice(0, 2).map(s => s.id);
  const picked = p.scripts().filter(s => ids.includes(s.id));
  const body = m.scriptsToCsv(picked).replace(/^\uFEFF/, '').split('\r\n').slice(1);
  const all = m.scriptsToCsv(p.scripts()).replace(/^\uFEFF/, '').split('\r\n').slice(1);
  return { pickedRows: body.length, allRows: all.length, total: p.scripts().length };
});
ok('只导出勾选的那几条（勾 2 条 → CSV 里就 2 行数据，不是全部）',
  expSel.pickedRows === 2 && expSel.allRows === expSel.total, JSON.stringify(expSel));

/* ══════ 7. API 帮助（编辑器里点「? 帮助」） ══════ */
await page.evaluate(async () => (await import('/js/editor/scriptEditor.js')).openScriptEditor());
await sleep(400);
const helpUi = await page.evaluate(() => ({
  hasBtn: !!document.getElementById('seHelp'),
  btnText: document.getElementById('seHelp')?.textContent.trim(),
}));
ok('编辑器右侧「API 速查」标题旁有「? 帮助」按钮', helpUi.hasBtn && /帮助/.test(helpUi.btnText), JSON.stringify(helpUi));

await page.evaluate(() => document.getElementById('seHelp').click());
await sleep(350);
const helpDlg = await page.evaluate(() => {
  const mask = document.getElementById('dlgMask');
  const box = document.getElementById('dlgBody');
  return {
    open: !mask.classList.contains('hidden'),
    overEditor: mask.classList.contains('over-editor'),
    z: +getComputedStyle(mask).zIndex,
    seZ: +getComputedStyle(document.getElementById('seMask')).zIndex,
    rows: box.querySelectorAll('.api-help-row').length,
    inserts: box.querySelectorAll('.api-help-ins').length,
    hasEg: !!box.querySelector('.api-help-eg')?.textContent.trim(),
    title: document.getElementById('dlgTitle').textContent,
  };
});
ok('点「? 帮助」弹出帮助框，而且是**压在脚本编辑器上面**（z 更高）',
  helpDlg.open && helpDlg.overEditor && helpDlg.z > helpDlg.seZ && /API 帮助/.test(helpDlg.title),
  JSON.stringify(helpDlg));
ok('帮助里有 10 条以上「说明 + 例子」，每条都有「插入」按钮',
  helpDlg.rows >= 10 && helpDlg.inserts === helpDlg.rows && helpDlg.hasEg, JSON.stringify(helpDlg));

// 点某条的「插入」→ 例子进到代码里，对话框自己关掉
const egText = await page.evaluate(() => document.querySelector('#dlgBody .api-help-eg').textContent);
const insRes = await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = '// 原来的代码\n';
  document.querySelectorAll('#dlgBody .api-help-ins')[0].click();
  const v = ta.value;
  return { value: v, dlgClosed: document.getElementById('dlgMask').classList.contains('hidden') };
});
ok('★ 点「插入」→ 例子那段代码插进编辑器，帮助框自动关掉',
  insRes.value.includes(egText) && insRes.dlgClosed, JSON.stringify(insRes.value.slice(0, 60)));
await page.evaluate(async () => (await import('/js/editor/scriptEditor.js')).closeScriptEditor?.());

/* ══════ 8. 当前页 API：hmi.project.pageName() / pageId() ══════ */
const pageApi = await page.evaluate(async () => {
  const e = await import('/js/runtime/scriptEngine.js');
  const m = await import('/js/core/project.js');
  const p = m.project;
  const cur = p.currentPage();
  const s = p.addScript({ name: '读当前页', trig: 'interval', ms: 60000, code: "hmi.log('页', hmi.project.pageName(), hmi.project.pageId())" });
  p.commit('当前页脚本');
  const res = e.runScriptOnce(s.id);
  const logs = e.scriptLog(s.id).map(l => l.text);
  p.deleteScript(s.id);
  p.commit('清');
  return { name: cur?.name, id: cur?.id, logs, ok: res.ok };
});
ok('★ hmi.project.pageName() 取到当前打开那一页的**名字**（跟组态里的一致）',
  pageApi.ok && pageApi.logs.some(l => String(l).includes(pageApi.name)), JSON.stringify([pageApi.name, pageApi.logs]));
ok('hmi.project.pageId() 同时给出当前页 id',
  pageApi.logs.some(l => String(l).includes(pageApi.id)), String(pageApi.id));

// 切到另一页之后，pageName 跟着变（不是只在进运行态时算一次）
const pageApi2 = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const p = m.project;
  if (p.data.pages.length < 2) p.addPage();
  const other = p.data.pages.find(x => x.id !== p.currentId);
  p.setCurrentPage(other.id);
  const s = p.addScript({ name: '读当前页2', trig: 'interval', ms: 60000, code: 'hmi.log(hmi.project.pageName())' });
  p.commit('切页后读');
  e.runScriptOnce(s.id);
  const logs = e.scriptLog(s.id).map(l => l.text);
  p.deleteScript(s.id);
  p.setCurrentPage(p.data.pages[0].id);
  p.commit('还原');
  return { expect: other?.name, logs };
});
ok('切到另一页后再跑，pageName 跟着变（读的是"现在这一页"）',
  pageApi2.logs.some(l => String(l).includes(pageApi2.expect)), JSON.stringify([pageApi2.expect, pageApi2.logs]));

ok('全程没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 脚本功能回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
