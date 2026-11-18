// verify-alarm.mjs — 报警系统：编辑栏 + 引擎（条件/延时/恢复/确认/历史）+ 三个报警控件
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';   // 隔离副本可以用别的端口跑，别打到正在用的那个服务上
installNodeFetchPatch(PORT);
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
const dialogs = [];                       // 弹过的 confirm/alert 文本（批量删只该弹一次）
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  // 报警记录现在会**落盘到服务器**（server/data/alarm_history.json），运行时也会把服务器那份读回来。
  // 本套件测的是本地这条线（判定/历史/三个控件），所以把报警记录的读写一起掐掉 ——
  // 不掐的话上一次运行留在服务器上的记录会被读回来，历史条数就不是断言里的那几条了。
  m.backend.loadAlarms = async () => [];
  m.backend.saveAlarms = async () => ({ ok: true });
  m.backend.expectsServer = () => false;
}));
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => { try { localStorage.removeItem('hmi-alarm-history'); } catch { /* 忽略 */ } });
await page.waitForTimeout(300);

/* ── A. 报警编辑栏（左侧「报警」面板） ── */
const panel = await page.evaluate(() => ({
  tab: [...document.querySelectorAll('#leftPanel .lp-tab')].map(t => t.textContent),
  hasPanel: !!document.getElementById('panel-alarms'),
  hasAdd: !!document.getElementById('btnAddAlarm'),
}));
ok('左区有「报警」标签（默认排在 变量 后面，之后还有 脚本/清单）',
  JSON.stringify(panel.tab) === JSON.stringify(['控件', '页面', '变量', '报警', '脚本', '清单']), JSON.stringify(panel.tab));
ok('报警面板结构在（＋添加报警 / 筛选 / 表格容器）',
  panel.hasPanel && panel.hasAdd, JSON.stringify(panel));

await page.click('.lp-tab[data-panel="alarms"]');
await page.waitForTimeout(250);
const emptyTip = await page.textContent('#alarmTable');
ok('空表给的是引导说明（怎么填条件/内容）', /添加报警/.test(emptyTip) && /变量/.test(emptyTip), emptyTip.replace(/\s+/g, ' ').slice(0, 60));

/* 建变量 + 三条报警（一条报警条用、一条带延时、一条字符串） */
const ids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.pages[0].widgets.length = 0;
  m.project.data.variables.length = 0;
  m.project.data.alarms.length = 0;
  ['rSpeed', 'iCount', 'sMode'].forEach((n, i) => {
    m.project.addVariable();
    m.project.updateVariable(`var${i + 1}`, { name: n, type: n === 'sMode' ? 'string' : (n === 'rSpeed' ? 'real' : 'int'), value: n === 'sMode' ? '手动' : 0 });
  });
  m.project.commit('报警测试准备');
  return { vars: m.project.variables().map(v => v.name) };
});
ok('准备 3 个变量（real/int/string）', ids.vars.length === 3, JSON.stringify(ids.vars));

const alarmIds = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const a1 = m.project.addAlarm();
  m.project.updateAlarm(a1.id, { name: '转速过高', variable: 'rSpeed', op: '>=', value: 3000, level: 'alarm', text: '主轴转速过高：{rSpeed} m/min（上限 3000）' });
  const a2 = m.project.addAlarm();
  m.project.updateAlarm(a2.id, { name: '计数到', variable: 'iCount', op: '>=', value: 5, level: 'warn', delaySec: 1, text: '加工计数到 {iCount} 件' });
  const a3 = m.project.addAlarm();
  m.project.updateAlarm(a3.id, { name: '模式异常', variable: 'sMode', op: '==', value: '自动', level: 'info', text: '模式被切到 {sMode}' });
  m.project.commit('加三条报警');
  return [a1.id, a2.id, a3.id];
});
await page.waitForTimeout(300);
const rows = await page.evaluate(() => {
  const trs = [...document.querySelectorAll('#alarmTable tr[data-alarm]')];
  return trs.map(tr => ({
    name: tr.querySelector('input[data-k="name"]')?.value,
    variable: (tr.querySelector('[data-k="variable"]') || {}).value,   // 现在是输入框（以前是 <select>）
    op: tr.querySelector('select[data-k="op"]')?.value,
    value: tr.querySelector('input[data-k="value"]')?.value,
    delay: tr.querySelector('input[data-k="delaySec"]')?.value,
    level: tr.querySelector('select[data-k="level"]')?.value,
    text: tr.querySelector('.al-text')?.textContent.trim(),
    title: tr.querySelector('.al-text')?.title,
    enabled: tr.querySelector('input[data-k="enabled"]')?.checked,
  }));
});
ok('报警编辑栏列出 3 条，条件/延时/级别/内容都回显',
  rows.length === 3 && rows[0].variable === 'rSpeed' && rows[0].op === '>=' && rows[0].value === '3000'
  && rows[1].delay === '1' && rows[2].level === 'info', JSON.stringify(rows[0]));
ok('内容格显示内容（点它开弹窗写全文），引用变量在 title 上能看出来',
  /主轴转速过高/.test(rows[0].text) && /rSpeed/.test(rows[0].title), JSON.stringify([rows[0].text, rows[0].title]));

/* 改一条：面板里改阈值 → 工程数据跟着变 */
await page.evaluate(() => {
  const inp = document.querySelector('#alarmTable tr[data-alarm] input[data-k="value"]');
  inp.value = '2800';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(250);
const changed = await page.evaluate(async () => (await import('/js/core/project.js')).project.alarms()[0].value);
ok('面板里改阈值 → 存进工程（2800）', changed === 2800, String(changed));
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.updateAlarm(m.project.alarms()[0].id, { value: 3000 });
  m.project.commit('改回');
});

/* ── A2. 多选删除（勾选 → 一次删掉；Ctrl+Z 一步撤销） ──
   为什么要有：报警表常常是 CSV 一次导进来几百条，里面几条不要的，
   以前只能一条一条点 ✕（每条还弹一次确认）。 */
const sel0 = await page.evaluate(() => {
  const tr = document.querySelector('#alarmTable tr[data-alarm]');
  return {
    head: !!document.getElementById('alarmSelAll'),
    boxes: document.querySelectorAll('#alarmTable tr[data-alarm] .al-sel').length,
    btnHidden: document.getElementById('btnDelAlarms').hidden,
    cols: tr.children.length,
    // 行尾的 ✎/✕ 都按现场要求去掉了（就地改内容走「内容」前面那个 ✎，删除走勾选框）
    noTrailBtns: !tr.querySelector('.vt-del') && tr.children[tr.children.length - 1].className === '',
    // 「内容」前面那一格是 ✎、后面那一格是内容（点开弹窗的那个按钮）
    editCol: tr.children[3].className,
    textCol: tr.children[4].className,
    heads: document.querySelectorAll('#alarmTable thead th').length,
  };
});
ok('报警表每行有勾选框、表头有全选框；没勾时「删除选中」不露面',
  sel0.head && sel0.boxes === 3 && sel0.btnHidden, JSON.stringify(sel0));
ok('10 列 = 勾选/名称/变量/✎/内容/比较/阈值/延时s/级别/启用（行尾不再有 ✎·✕，表头也是 10）',
  sel0.cols === 10 && sel0.heads === 10 && sel0.noTrailBtns
  && sel0.editCol === 'al-editcell' && sel0.textCol === 'al-textcell', JSON.stringify(sel0));

await page.evaluate(() => {
  const b = [...document.querySelectorAll('#alarmTable tr[data-alarm] .al-sel')];
  b[0].click();     // 真点一下（走 change 事件，和现场手点一致）
  b[2].click();
});
await page.waitForTimeout(200);
const sel1 = await page.evaluate(() => ({
  btn: document.getElementById('btnDelAlarms').textContent.trim(),
  hidden: document.getElementById('btnDelAlarms').hidden,
  headChecked: document.getElementById('alarmSelAll').checked,
  checked: [...document.querySelectorAll('#alarmTable tr[data-alarm] .al-sel')].map(b => b.checked),
  hl: document.querySelectorAll('#alarmTable tr[data-alarm].sel').length,
}));
ok('勾两条 → 按钮变成「删除选中 (2)」并显示，勾中的两行高亮；3 条只勾了 2 条，全选框不勾',
  sel1.btn === '删除选中 (2)' && sel1.hidden === false && sel1.headChecked === false
  && sel1.hl === 2 && JSON.stringify(sel1.checked) === '[true,false,true]', JSON.stringify(sel1));

const beforeDel = dialogs.length;
await page.click('#btnDelAlarms');
await page.waitForTimeout(350);
const afterDel = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return {
    names: m.project.alarms().map(a => a.name),
    rows: document.querySelectorAll('#alarmTable tr[data-alarm]').length,
    btnHidden: document.getElementById('btnDelAlarms').hidden,
  };
});
ok('批量删：只弹一次确认，勾的那 2 条一起没了、没勾的留着，按钮收回',
  dialogs.length - beforeDel === 1 && afterDel.names.join(',') === '计数到'
  && afterDel.rows === 1 && afterDel.btnHidden, JSON.stringify({ dlg: dialogs.length - beforeDel, ...afterDel }));

await page.evaluate(() => window.app.history.undo());
await page.waitForTimeout(350);
const undoneSel = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return {
    names: m.project.alarms().map(a => a.name),
    boxes: [...document.querySelectorAll('#alarmTable tr[data-alarm] .al-sel')].map(b => b.checked),
  };
});
ok('Ctrl+Z 一步就把这 2 条整批撤回来（一次批量删 = 一步撤销）',
  undoneSel.names.join(',') === '转速过高,计数到,模式异常' && undoneSel.boxes.every(b => !b), JSON.stringify(undoneSel));

/* 表头全选 / 全不选（只管当前筛出来的那些） */
await page.evaluate(() => {
  const b = document.getElementById('alarmSelAll');
  b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(250);
const allOn = await page.evaluate(() => ({
  all: [...document.querySelectorAll('#alarmTable tr[data-alarm] .al-sel')].every(b => b.checked),
  btn: document.getElementById('btnDelAlarms').textContent.trim(),
}));
ok('表头全选 → 3 行都勾上，按钮变 (3)', allOn.all && allOn.btn === '删除选中 (3)', JSON.stringify(allOn));
await page.evaluate(() => {
  const b = document.getElementById('alarmSelAll');
  b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(200);
const allOff = await page.evaluate(() => ({
  none: [...document.querySelectorAll('#alarmTable tr[data-alarm] .al-sel')].every(b => !b.checked),
  btnHidden: document.getElementById('btnDelAlarms').hidden,
}));
ok('再点一次 → 全不选，「删除选中」又收起来', allOff.none && allOff.btnHidden, JSON.stringify(allOff));

/* 筛选后全选：只选看得见的（藏起来的不动 —— 否则"看到 1 条却删了 3 条"）
   ⚠ 报警表里筛出来的如果一条不剩，表整个藏起来，所以这里筛「模式」正好剩 1 条 */
await page.evaluate(() => {
  const i = document.getElementById('alarmFilter');
  i.value = '模式'; i.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
await page.evaluate(() => {
  const b = document.getElementById('alarmSelAll');
  b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(200);
const filtSel = await page.evaluate(() => document.getElementById('btnDelAlarms').textContent.trim());
ok('筛选后全选 → 只勾了筛出来的那 1 条（不是全部 3 条）', filtSel === '删除选中 (1)', filtSel);
await page.evaluate(() => {
  const i = document.getElementById('alarmFilter');
  i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
  const b = document.getElementById('alarmSelAll');
  b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(250);
const cleaned = await page.evaluate(() => ({
  n: document.querySelectorAll('#alarmTable tr[data-alarm]').length,
  btnHidden: document.getElementById('btnDelAlarms').hidden,
}));
ok('清掉筛选框 → 3 条都回来了，勾选状态也清干净（不影响后面的用例）',
  cleaned.n === 3 && cleaned.btnHidden, JSON.stringify(cleaned));

/* ── A3. 内容格 = 就地改（不开弹窗）；✎ = 开弹窗 ──
   现场口径：改一两个字不该被弹窗打断 → 点内容格直接在格子里改；
   要写多行 / 插 {变量} / 看预览 → 点左边那个 ✎ 开弹窗。 */
// ⚠ 一律按报警 id 找那一行：窗口化列表重画时行节点会复用，"第一行"不能想当然
const A0 = await page.evaluate(async () => (await import('/js/core/project.js')).project.alarms()[0].id);
const R0 = `#alarmTable tr[data-alarm="${A0}"]`;
const q = (sel) => `document.querySelector(${JSON.stringify(R0 + ' ' + sel)})`;
const qAll = (sel) => `document.querySelectorAll(${JSON.stringify(R0 + ' ' + sel)})`;

await page.evaluate(`(${q('.al-text')}).click()`);
await page.waitForTimeout(250);
const inEdit = await page.evaluate(`(() => {
  const tr = document.querySelector(${JSON.stringify(R0)});
  const ta = tr.querySelector('textarea.al-inline');
  return {
    has: !!ta,
    focused: !!ta && document.activeElement === ta,
    caret: ta ? ta.selectionStart === ta.value.length : false,
    value: ta && ta.value,
    dlgHidden: document.getElementById('dlgMask').classList.contains('hidden'),
    textBtn: !!tr.querySelector('.al-text'),
  };
})()`);
ok('点「内容」格 → 这一格变成文本框（自动聚焦、光标在末尾），**没开弹窗**',
  inEdit.has && inEdit.focused && inEdit.caret && inEdit.dlgHidden && !inEdit.textBtn
  && /主轴转速过高/.test(inEdit.value || ''), JSON.stringify(inEdit));

// 打字（只派发 input，不 commit）→ Ctrl+Enter 存
await page.evaluate(`(() => {
  const ta = ${q('textarea.al-inline')};
  ta.value = '主轴转速过高：{rSpeed} m/min（上限 2800）';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(350);
const saved = await page.evaluate(`(async () => {
  const m = await import('/js/core/project.js');
  const h = await import('/js/core/history.js');
  const tr = document.querySelector(${JSON.stringify(R0)});
  return {
    text: m.project.alarms()[0].text,
    label: h.history.lastLabel(),
    isArea: !!tr.querySelector('textarea.al-inline'),
    cell: tr.querySelector('.al-text') && tr.querySelector('.al-text').textContent.trim(),
  };
})()`);
ok('Ctrl+Enter 存下 → 工程里内容变了、格子变回文字',
  saved.text === '主轴转速过高：{rSpeed} m/min（上限 2800）' && !saved.isArea && /2800/.test(saved.cell),
  JSON.stringify(saved));
ok('整段编辑只记一步撤销（标签是「修改报警内容」，不是每敲一个字一步）',
  saved.label === '修改报警内容', saved.label);

await page.evaluate(() => window.app.history.undo());
await page.waitForTimeout(400);
const back = await page.evaluate(`(async () => {
  const m = await import('/js/core/project.js');
  return { text: m.project.alarms()[0].text, cell: ${q('.al-text')} && ${q('.al-text')}.textContent.trim() };
})()`);
ok('Ctrl+Z 一步就把内容改回去（3000），表格也跟着回',
  /上限 3000/.test(back.text) && /上限 3000/.test(back.cell), JSON.stringify(back));

/* Esc 撤消：改一半按 Esc → 原文不动，撤销栈里也不留痕 */
await page.evaluate(`(${q('.al-text')}).click()`);
await page.waitForTimeout(250);
const esc = await page.evaluate(`(async () => {
  const h = await import('/js/core/history.js');
  const labelBefore = h.history.lastLabel();
  const ta = ${q('textarea.al-inline')};
  ta.value = '改了一半就不想要了';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const m = await import('/js/core/project.js');
  const tr = document.querySelector(${JSON.stringify(R0)});
  return {
    text: m.project.alarms()[0].text,
    isArea: !!tr.querySelector('textarea.al-inline'),
    cell: tr.querySelector('.al-text') && tr.querySelector('.al-text').textContent.trim(),
    labelBefore, labelAfter: h.history.lastLabel(),
  };
})()`);
ok('Esc 撤消 → 原文没变、文本框收起、撤销栈里不留痕',
  /上限 3000/.test(esc.text) && !esc.isArea && /上限 3000/.test(esc.cell)
  && esc.labelAfter === esc.labelBefore, JSON.stringify(esc));

/* 点别处也能存（不用记 Ctrl+Enter）：改完直接去点别处 */
await page.evaluate(`(${q('.al-text')}).click()`);
await page.waitForTimeout(250);
const blurSaved = await page.evaluate(`(async () => {
  const ta = ${q('textarea.al-inline')};
  ta.value = '主轴转速过高（改完直接点别处）';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.blur();                       // = 点别处
  await new Promise(r => setTimeout(r, 250));
  const m = await import('/js/core/project.js');
  return { text: m.project.alarms()[0].text, isArea: !!${q('textarea.al-inline')} };
})()`);
ok('改完点别处（失焦）同样存下', blurSaved.text === '主轴转速过高（改完直接点别处）' && !blurSaved.isArea,
  JSON.stringify(blurSaved));

/* 左边那个 ✎ 仍然是弹窗那条路（多行 / 插变量 / 预览） */
await page.click(`${R0} .al-editbtn`);
await page.waitForTimeout(350);
const dlgStill = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  text: document.getElementById('alarmTextArea')?.value,
  area: !!document.getElementById('alarmVarChips') && !!document.getElementById('alarmPrev'),
}));
ok('点 ✎ 开的是弹窗（大文本框 + 变量按钮 + 预览都在），内容带出当前那条',
  dlgStill.open && /编辑报警/.test(dlgStill.title) && dlgStill.area
  && /改完直接点别处/.test(dlgStill.text || ''), JSON.stringify(dlgStill));

/* 就地改没存完就去点 ✎：先把就地改的存下，弹窗里看到的是最新内容（不能回退成旧的） */
await page.click('#dlgCancel');
await page.waitForTimeout(250);
await page.evaluate(`(${q('.al-text')}).click()`);
await page.waitForTimeout(250);
await page.evaluate(`(() => {
  const ta = ${q('textarea.al-inline')};
  ta.value = '就地改了一半';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await page.click(`${R0} .al-editbtn`);
await page.waitForTimeout(350);
const dlgAfterInline = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { text: m.project.alarms()[0].text, area: document.getElementById('alarmTextArea')?.value };
});
ok('就地改没存完就点 ✎ → 先把就地改存下，弹窗里是最新内容',
  dlgAfterInline.text === '就地改了一半' && dlgAfterInline.area === '就地改了一半', JSON.stringify(dlgAfterInline));
await page.click('#dlgCancel');
await page.waitForTimeout(250);
// 内容改回原始值，别影响后面那些对着内容做断言的用例
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.updateAlarm(m.project.alarms()[0].id, { text: '主轴转速过高：{rSpeed} m/min（上限 3000）' });
  m.project.commit('还原内容');
});
await page.waitForTimeout(250);

/* ── 三个报警控件也能从工具箱添加 ── */
const defs = await page.evaluate(async () => {
  const r = await import('/js/widgets/registry.js');
  const types = ['alarmBar', 'alarmList', 'alarmHistory'];
  return types.map(t => {
    const d = r.registry.get(t);
    return { t, title: d?.title, hidden: !!d?.hidden, w: d?.defaults?.w, h: d?.defaults?.h };
  });
});
ok('三个报警控件已注册（报警条 / 当前报警 / 报警历史）',
  defs.every(d => d.title && !d.hidden), JSON.stringify(defs.map(d => d.title)));

/* ── 同时报警上千条：只画前 200 行 + 一行「还有 N 条」
      （全画出来 2000 行时整块重建要 31ms，帧率从 60 掉到 50 以下，实测） ── */
const manyAlarms = await page.evaluate(async () => {
  const A = await import('/js/runtime/alarms.js');
  const { registry } = await import('/js/widgets/registry.js');
  const wasRunning = A.isRunning();
  A.startAlarms();                                   // 顺带把 active 清空
  const def = registry.get('alarmList');
  const w = { type: 'alarmList', props: { ...def.defaults }, bindings: {} };
  for (let i = 0; i < 350; i++) A._pushActive({ key: 'k' + i, text: `第 ${i} 条`, level: 'alarm', at: Date.now() });
  const div = document.createElement('div');
  div.innerHTML = def.render(w, 'run', null);
  const out = {
    active: A.activeAlarms().length,
    rows: div.querySelectorAll('.at-table tbody tr').length,
    more: div.querySelector('.almore')?.textContent || '',
    // 少量报警时不该有这一行
    small: (() => {
      A.startAlarms();
      A._pushActive({ key: 'one', text: '只有一条', level: 'warn', at: Date.now() });
      const d2 = document.createElement('div');
      d2.innerHTML = def.render(w, 'run', null);
      return { rows: d2.querySelectorAll('.at-table tbody tr').length, more: !!d2.querySelector('.almore') };
    })(),
  };
  A.startAlarms();                                  // 清空 active（startAlarms 会重置）
  if (!wasRunning) A.stopAlarms();                  // 原来没在跑就别留着计时器
  return out;
});
ok('同时 350 条报警：控件只画前 200 行（+1 行提示）', manyAlarms.rows === 201, JSON.stringify(manyAlarms.rows));
ok('多出来的条数写在最后一行里', /还有 150 条/.test(manyAlarms.more), manyAlarms.more);
ok('只有 1 条报警时不出现「还有 N 条」那行（行数就是 1）',
  manyAlarms.small.rows === 1 && manyAlarms.small.more === false, JSON.stringify(manyAlarms.small));

const wids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const bar = m.project.addWidget('alarmBar', 40, 260);
  const list = m.project.addWidget('alarmList', 40, 310);
  const hist = m.project.addWidget('alarmHistory', 400, 310);
  m.project.updateWidgetField(list.id, 'w', 320); m.project.updateWidgetField(list.id, 'h', 150);
  m.project.updateWidgetField(hist.id, 'w', 340); m.project.updateWidgetField(hist.id, 'h', 170);
  m.project.commit('加报警控件');
  return { bar: bar.id, list: list.id, hist: hist.id };
});
await page.waitForTimeout(300);
const editPreview = await page.evaluate(([b, l, h]) => ({
  bar: document.querySelector(`#canvas .wd[data-id="${b}"] .w-alarmbar`)?.textContent.trim().slice(0, 30),
  listRows: document.querySelectorAll(`#canvas .wd[data-id="${l}"] .w-alarmtbl .at-table tbody tr`).length,
  listHead: [...document.querySelectorAll(`#canvas .wd[data-id="${l}"] .at-table thead td`)].map(t => t.textContent),
  histRows: document.querySelectorAll(`#canvas .wd[data-id="${h}"] .w-alarmtbl .at-table tbody tr`).length,
  histHead: [...document.querySelectorAll(`#canvas .wd[data-id="${h}"] .at-table thead td`)].map(t => t.textContent),
  histNav: [...document.querySelectorAll(`#canvas .wd[data-id="${h}"] .at-nav button`)].map(b => b.textContent.trim()),
  histDate: document.querySelector(`#canvas .wd[data-id="${h}"] .at-date`)?.value,
}), [wids.bar, wids.list, wids.hist]);
ok('编辑态显示预览内容（表格形式：表头 级别/时间/报警内容）',
  // 现在编辑态**优先用工程里真实的报警定义**（按当前语言翻好，切语言画布也会变），
  // 所以行数 = 工程里配的报警条数（本用例配了 3 条）；没配报警时才回退到写死的示例。
  editPreview.listRows === 3 && editPreview.histRows === 3
  && JSON.stringify(editPreview.listHead.slice(0, 3)) === JSON.stringify(['级别', '时间', '报警内容']),
  JSON.stringify([editPreview.listHead, editPreview.listRows]));
ok('报警历史表头多一列「恢复」，并带日期切换条（‹ › 今天 + 日期框）',
  JSON.stringify(editPreview.histHead) === JSON.stringify(['级别', '时间', '报警内容', '恢复'])
  && JSON.stringify(editPreview.histNav) === JSON.stringify(['‹', '›', '今天'])
  && /^\d{4}-\d\d-\d\d$/.test(editPreview.histDate || ''),
  JSON.stringify([editPreview.histHead, editPreview.histNav, editPreview.histDate]));

/* ── A2. 报警条背景色：「透明」要真的透明（以前清了颜色反而回落到级别色 → 变红） ── */
const barBg = await page.evaluate(async (id) => {
  const m = await import('/js/core/project.js');
  const cv = await import('/js/editor/canvas.js');
  const read = () => document.querySelector(`#canvas .wd[data-id="${id}"] .w-alarmbar`)?.getAttribute('style') || '';
  const out = {};
  out.def = read().match(/--ab-bg:[^;]+/)?.[0] || '';                 // 新控件：应该按级别色（红）
  m.project.updateWidgetProp(id, 'bgColor', '');
  m.project.commit('设成透明');
  out.cleared = read().match(/--ab-bg:[^;]+/)?.[0] || '';             // 点「透明」之后
  m.project.updateWidgetProp(id, 'bgColor', '#2563eb');
  m.project.commit('设成蓝的');
  out.blue = read().match(/--ab-bg:[^;]+/)?.[0] || '';
  // 老工程：整个键都没有 → 用级别色兜底
  const w = m.project.getWidget(id);
  delete w.props.bgColor;
  m.project.touch();
  out.missing = read().match(/--ab-bg:[^;]+/)?.[0] || '';
  m.project.updateWidgetProp(id, 'bgColor', '#ef4444');
  m.project.commit('还原');
  cv.select([id]);
  return out;
}, wids.bar);
ok('报警条默认按最高报警级别着色（红）', /--ab-bg:#ef4444/.test(barBg.def) || /--ab-bg:#[0-9a-f]{6}/.test(barBg.def), barBg.def);
ok('设成「透明」→ 真的透明（不再回落成红色）', barBg.cleared === '--ab-bg:transparent', barBg.cleared);
ok('设成别的颜色照常生效', barBg.blue === '--ab-bg:#2563eb', barBg.blue);
ok('老工程里没有这个键时才用级别色兜底', barBg.missing === '--ab-bg:#ef4444', barBg.missing);
// 走真实 UI：属性面板点「透明」按钮
await sleep(300);
await page.evaluate(() => {
  const el = document.querySelector('#propBody .clear-color[data-clear="bgColor"]');
  el?.click();
});
await sleep(350);
const uiTrans = await page.evaluate((id) => ({
  varBg: document.querySelector(`#canvas .wd[data-id="${id}"] .w-alarmbar`)?.getAttribute('style')?.match(/--ab-bg:[^;]+/)?.[0] || '',
  prop: window.app.project.getWidget(id)?.props?.bgColor,
  active: document.querySelector('#propBody .clear-color[data-clear="bgColor"]')?.classList.contains('active'),
}), wids.bar);
ok('属性面板点「透明」→ 画布上的报警条真的透明，按钮也点亮（能看出当前是透明）',
  uiTrans.prop === '' && uiTrans.varBg === '--ab-bg:transparent' && uiTrans.active === true, JSON.stringify(uiTrans));
await page.evaluate(async (id) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(id, 'bgColor', '#ef4444');
  m.project.commit('还原背景色');
}, wids.bar);
await sleep(200);

/* ── B. 运行态：条件成立 → 报警条 + 当前报警 + 历史 ── */
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(600);
const idle = await page.evaluate(([b, l, h]) => ({
  barText: document.querySelector(`#rtPage .wd[data-id="${b}"] .w-alarmbar`)?.textContent?.replace(/\s+/g, ' ').trim() || '',
  barBoxHidden: !document.querySelector(`#rtPage .wd[data-id="${b}"] .w-alarmbar`),
  barVisible: (() => {
    const el = document.querySelector(`#rtPage .wd[data-id="${b}"] .w-alarmbar`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).display !== 'none';
  })(),
  listEmpty: document.querySelector(`#rtPage .wd[data-id="${l}"] .at-table td.alempty`)?.textContent.trim(),
  histEmpty: document.querySelector(`#rtPage .wd[data-id="${h}"] .at-table td.alempty`)?.textContent.trim(),
  histCount: document.querySelector(`#rtPage .wd[data-id="${h}"] .at-count`)?.textContent.trim(),
}), [wids.bar, wids.list, wids.hist]);
ok('没报警时：报警条整条隐藏（默认「无报警时隐藏」）',
  idle.barBoxHidden && idle.barText === '', JSON.stringify([idle.barBoxHidden, idle.barText]));
ok('没报警时：两张表给出占位行',
  idle.listEmpty === '当前无报警' && /没有报警记录/.test(idle.histEmpty || ''), JSON.stringify(idle));
ok('历史表右上角显示当天条数', /0 条/.test(idle.histCount || ''), String(idle.histCount));

/* 勾掉「无报警时隐藏」→ 显示那句话 */
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'hideWhenNone', false);
  m.project.commit('不隐藏');
}, [wids.bar]);
await page.evaluate(() => (async () => { const rt = import('/js/runtime/runtime.js'); rt.then(m => { m.exitRun(); m.enterRun(); }); })());
await sleep(700);
const shown = await page.evaluate(([wid]) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-alarmbar`);
  return { has: !!el, text: el?.textContent.replace(/\s+/g, ' ').trim(), empty: el?.classList.contains('empty') };
}, [wids.bar]);
ok('勾掉「无报警时隐藏」→ 显示「无报警」那句', shown.has && shown.empty && /无报警/.test(shown.text || ''), JSON.stringify(shown));
await page.evaluate(async ([wid]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(wid, 'hideWhenNone', true);
  m.project.commit('恢复隐藏');
}, [wids.bar]);

/* 让 rSpeed 超限 → 应立刻报警 */
await page.evaluate(async () => { window.app.varStore.set('rSpeed', 3120.5, 'remote'); });
await sleep(600);
const raised = await page.evaluate(async ([b, l, h]) => {
  const A = await import('/js/runtime/alarms.js');
  const rows = [...document.querySelectorAll(`#rtPage .wd[data-id="${l}"] .at-table tbody tr`)];
  return {
    active: A.activeAlarms().map(a => ({ text: a.text, level: a.level })),
    hist: A.alarmHistory().length,
    bar: document.querySelector(`#rtPage .wd[data-id="${b}"] .w-alarmbar`)?.textContent.replace(/\s+/g, ' ').trim(),
    listRows: rows.length,
    listCells: rows[0] ? [...rows[0].querySelectorAll('td')].map(td => td.textContent.trim()) : [],
    histRows: document.querySelectorAll(`#rtPage .wd[data-id="${h}"] .at-table tbody tr`).length,
    histCells: [...(document.querySelector(`#rtPage .wd[data-id="${h}"] .at-table tbody tr`)?.querySelectorAll('td') || [])].map(td => td.textContent.trim()),
  };
}, [wids.bar, wids.list, wids.hist]);
ok('变量超限 → 触发报警，内容是填好变量的文字',
  raised.active.length === 1 && raised.active[0].text === '主轴转速过高：3120.5 m/min（上限 3000）',
  JSON.stringify(raised.active));
ok('报警条显示这条报警（带时间）', /3120\.5/.test(raised.bar), raised.bar);
ok('当前报警表格里出现 1 行：级别 / 时间 / 内容',
  raised.listRows === 1 && raised.listCells[0] === '报警' && /^\d\d:\d\d:\d\d$/.test(raised.listCells[1])
  && /主轴转速过高/.test(raised.listCells[2]), JSON.stringify(raised.listCells));
ok('历史里记了一条，表格里 级别/时间/内容/恢复 四列都在',
  raised.hist === 1 && raised.histRows === 1 && raised.histCells.length === 4
  && raised.histCells[3] === '未恢复', JSON.stringify(raised.histCells));

/* ── 报警条：所有报警拼成一串，在里面一直滚（跑马灯） ── */
await page.evaluate(async () => { window.app.varStore.set('sMode', '自动', 'remote'); });
await sleep(600);
const snapBar = () => page.evaluate(([b]) => {
  const bar = document.querySelector(`#rtPage .wd[data-id="${b}"] .w-alarmbar`);
  if (!bar) return { missing: true };
  const reel = bar.querySelector('.ab-reel');
  const copies = [...bar.querySelectorAll('.ab-copy')];
  const view = bar.querySelector('.ab-view');
  return {
    text: bar.textContent.replace(/\s+/g, ' ').trim(),
    copyText: copies[0]?.textContent.replace(/\s+/g, ' ').trim() || '',
    copies: copies.length,
    same: copies.length === 2 && copies[0].textContent === copies[1].textContent,
    copyW: Math.round(copies[0].getBoundingClientRect().width),
    viewW: Math.round(view.clientWidth),
    roll: bar.classList.contains('roll'),
    dur: reel.style.getPropertyValue('--ab-dur'),
    anim: getComputedStyle(reel).animationName,
    secondShown: copies[1] ? getComputedStyle(copies[1]).display !== 'none' : null,
  };
}, [wids.bar]);
/** 改完报警内容要等一下：报警引擎 200ms 一跳才把新文字刷进「当前报警」，
 *  再发 alarms:changed 才会重绘报警条（只发一次事件会拿到旧文字） */
const settleBar = async () => {
  await sleep(400);
  await page.evaluate(async () => (await import('/js/core/eventBus.js')).bus.emit('alarms:changed', { raised: [], cleared: [] }));
  await sleep(300);
};

const bar2 = await snapBar();
ok('两条报警拼成一串（一次就能看到全部，不用等轮播）',
  /主轴转速过高/.test(bar2.copyText) && /模式被切到/.test(bar2.copyText) && /●/.test(bar2.copyText), bar2.copyText.slice(0, 90));
ok('每条都带时间戳', (bar2.copyText.match(/\[\d\d:\d\d:\d\d\]/g) || []).length === 2, bar2.copyText.slice(0, 70));
ok('串太长 → 一直在滚（.roll + 动画 ab-ticker），按速度算出滚动时长',
  bar2.roll && bar2.anim === 'ab-ticker' && /s$/.test(bar2.dur) && bar2.copyW > bar2.viewW,
  JSON.stringify({ roll: bar2.roll, anim: bar2.anim, dur: bar2.dur, copyW: bar2.copyW, viewW: bar2.viewW }));
ok('同一份内容放两遍（滚到 -50% 正好接上第一份 → 无缝循环，不会跳回开头）',
  bar2.copies === 2 && bar2.same === true && bar2.secondShown === true, JSON.stringify({ copies: bar2.copies, same: bar2.same }));

/* 首尾对接（无缝）：判据是「两份内容首尾相接 + 一圈正好走一份」。
   ⚠ 以前 .ab-reel 是块级 flex 容器，宽度默认取可视区宽（575）而不是内容宽（1768），
   于是 translateX(-50%) 只走半个可视区 ≈ 288px，滚到后面突然跳回开头 —— 就是这个 bug。
   为什么不去采样动画时钟：paused 的动画改 animation-delay 不一定重算当前时间，
   量出来的位移不可靠；而「带子宽 = 2×一份 + 关键帧走 -50%」两条合起来在数学上等价于无缝。 */
const seam = await page.evaluate(async ([b]) => {
  const reel = document.querySelector(`#rtPage .wd[data-id="${b}"] .w-alarmbar .ab-reel`);
  const view = reel.closest('.ab-view');
  const copy = reel.querySelector('.ab-copy');
  const cs = getComputedStyle(reel);
  // 从样式表里把 @keyframes ab-ticker 的终点帧读出来
  let toFrame = '';
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }      // 跨域表读不到就跳过
    for (const r of rules) {
      if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'ab-ticker') {
        for (const kf of r.cssRules) if (kf.keyText === '100%' || kf.keyText === 'to') toFrame = kf.style.transform;
      }
    }
  }
  return {
    reelW: Math.round(reel.getBoundingClientRect().width),
    copyW: Math.round(copy.getBoundingClientRect().width),
    viewW: Math.round(view.getBoundingClientRect().width),
    anim: cs.animationName,
    iter: cs.animationIterationCount,
    timing: cs.animationTimingFunction,
    toFrame,
  };
}, [wids.bar]);
ok('滚动带宽度 = 两份内容（不是被压成可视区那么宽）',
  Math.abs(seam.reelW - seam.copyW * 2) <= 2 && seam.reelW > seam.viewW, JSON.stringify(seam));
ok('动画是 ab-ticker + linear + infinite（匀速、一直循环）',
  seam.anim === 'ab-ticker' && seam.iter === 'infinite' && seam.timing === 'linear',
  JSON.stringify({ anim: seam.anim, iter: seam.iter, timing: seam.timing }));
ok('关键帧走 -50% → 一圈正好一份内容宽，首尾对接不跳',
  /translateX\(\s*-?50%\s*\)/.test(seam.toFrame), JSON.stringify(seam.toFrame));

/* 滚起来：等一会儿看 transform 真的在变（不是在原地不动） */
const t1 = await page.evaluate(([b]) => getComputedStyle(document.querySelector(`#rtPage .wd[data-id="${b}"] .ab-reel`)).transform, [wids.bar]);
await sleep(900);
const t2 = await page.evaluate(([b]) => getComputedStyle(document.querySelector(`#rtPage .wd[data-id="${b}"] .ab-reel`)).transform, [wids.bar]);
ok('内容真的在动（两次取到的 transform 不一样）', t1 !== t2, `${String(t1).slice(0, 34)} → ${String(t2).slice(0, 34)}`);

/* 内容短到不超宽 → 不滚（短文字在条里晃来晃去很闹）
   注意：当时活着的是 alarms()[0]（rSpeed）和 alarms()[2]（sMode），改文字要改这两条 */
await page.evaluate(async ([b]) => {
  const m = await import('/js/core/project.js');
  const a = m.project.alarms();
  a[0].text = 'A';
  a[2].text = 'B';
  m.project.updateWidgetProp(b, 'sepText', '|');
  m.project.commit('缩短内容');
}, [wids.bar]);
await settleBar();
const barShort = await snapBar();
ok('短到装得下就不滚（第二份收起来，静静显示整串）',
  barShort.roll === false && barShort.anim === 'none' && barShort.secondShown === false,
  JSON.stringify({ roll: barShort.roll, anim: barShort.anim, second: barShort.secondShown, text: barShort.copyText }));
ok('分隔符可改（● → |）', /A/.test(barShort.copyText) && /B/.test(barShort.copyText)
  && /\|/.test(barShort.copyText) && !/●/.test(barShort.copyText), barShort.copyText.slice(0, 60));

/* 关掉「拼接全部」→ 只显示最严重那条 + 还有 N 条 */
await page.evaluate(async ([b]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(b, 'joinAll', false);
  m.project.commit('不拼接');
}, [wids.bar]);
await settleBar();
const bar3 = await snapBar();
ok('关掉「拼接全部」→ 只剩最严重那条 + 「还有 1 条」',
  /还有 1 条/.test(bar3.copyText) && !/跳闸/.test(bar3.copyText), bar3.copyText.slice(0, 70));

/* 关掉「超长滚动」→ 就算超长也不滚（静态截断） */
await page.evaluate(async ([b]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(b, 'joinAll', true);
  m.project.updateWidgetProp(b, 'scroll', false);
  m.project.updateAlarm(m.project.alarms()[0].id, { text: '主轴转速过高：' + '转速异常要停机检查冷却与刀具'.repeat(3) });
  m.project.commit('不滚');
}, [wids.bar]);
await settleBar();
const bar4 = await snapBar();
ok('关掉「超长滚动」→ 再长也不滚（量都不量，直接截断）',
  bar4.roll === false && bar4.copyW > bar4.viewW, JSON.stringify({ roll: bar4.roll, copyW: bar4.copyW, viewW: bar4.viewW }));

/* 恢复原样，后面的用例还指望这两条报警的文字 */
await page.evaluate(async ([b]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetProp(b, 'scroll', true);
  m.project.updateWidgetProp(b, 'sepText', '●');
  m.project.updateAlarm(m.project.alarms()[0].id, { text: '主轴转速过高：{rSpeed} m/min（上限 3000）' });
  m.project.updateAlarm(m.project.alarms()[2].id, { text: '模式被切到 {sMode}' });
  m.project.commit('复原');
}, [wids.bar]);
await settleBar();
const bar5 = await snapBar();
ok('两条报警又都在串里了（内容跟着当前报警走）',
  /主轴转速过高/.test(bar5.copyText) && /模式被切到/.test(bar5.copyText), bar5.copyText.slice(0, 70));

/* 延时：iCount 到 5 后要等 1 秒才报警 */
await page.evaluate(async () => { window.app.varStore.set('iCount', 6, 'remote'); });
await sleep(300);
const duringDelay = await page.evaluate(async () => (await import('/js/runtime/alarms.js')).activeAlarms().map(a => a.name));
ok('带延时的那条还没触发（1 秒延时内）', !duringDelay.includes('计数到'), JSON.stringify(duringDelay));
await sleep(1200);
const afterDelay = await page.evaluate(async () => (await import('/js/runtime/alarms.js')).activeAlarms().map(a => a.name));
ok('延时到了才触发', afterDelay.includes('计数到'), JSON.stringify(afterDelay));

/* 恢复：把 rSpeed 降下来 → 当前报警里消失、历史补上恢复时间 */
await page.evaluate(async () => { window.app.varStore.set('rSpeed', 1200, 'remote'); });
await sleep(600);
const cleared = await page.evaluate(async () => {
  const A = await import('/js/runtime/alarms.js');
  const h = A.alarmHistory().find(x => x.text.includes('主轴转速'));
  return { active: A.activeAlarms().map(a => a.name), histEnd: !!h?.endAt };
});
ok('条件恢复 → 从当前报警移出', !cleared.active.includes('转速过高'), JSON.stringify(cleared.active));
ok('历史那条补上了恢复时间', cleared.histEnd === true, String(cleared.histEnd));

/* 确认：点当前报警表里的「确认」→ 标记已确认（仍在表里） */
const ackBtn = await page.locator('#rtPage .w-alarmtbl .al-ack').first().boundingBox();
ok('当前报警表里每条都有「确认」按钮', !!ackBtn, JSON.stringify(ackBtn));
await page.mouse.click(ackBtn.x + ackBtn.width / 2, ackBtn.y + ackBtn.height / 2);
await sleep(400);
const acked = await page.evaluate(async () => {
  const A = await import('/js/runtime/alarms.js');
  return { acked: A.activeAlarms().map(a => ({ name: a.name, acked: a.acked })), stillListed: A.activeAlarms().length };
});
ok('点确认 → 该条标记已确认，但仍在当前报警里（等它自己恢复）',
  acked.acked.some(x => x.acked) && acked.stillListed >= 1, JSON.stringify(acked));

/* ── F. 时间格式：可设、可精确到毫秒 ──
   （运行态不会因为改属性而重绘：改完配置要重新进运行态，这也是现场的真实行为） */
const restartRun = async () => {
  await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
  await sleep(200);
  await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
  await sleep(500);
};
const setProp = async (wid, k, v) => {
  await page.evaluate(async ([id, key, val]) => {
    const m = await import('/js/core/project.js');
    m.project.updateWidgetProp(id, key, val);
    m.project.commit('改属性');
  }, [wid, k, v]);
};
const histTimeCell = () => page.evaluate(([wid]) =>
  document.querySelector(`#rtPage .wd[data-id="${wid}"] .at-table tbody tr td:nth-child(2)`)?.textContent.trim(), [wids.hist]);
const curTimeCell = () => page.evaluate(([wid]) =>
  document.querySelector(`#rtPage .wd[data-id="${wid}"] .at-table tbody tr td:nth-child(2)`)?.textContent.trim(), [wids.list]);

ok('默认格式 MM-DD hh:mm:ss', /^\d\d-\d\d \d\d:\d\d:\d\d$/.test(await histTimeCell()), await histTimeCell());
await setProp(wids.hist, 'timeFmt', 'hh:mm:ss.SSS');
await restartRun();
ok('选「时:分:秒.毫秒」→ 时间精确到 ms', /^\d\d:\d\d:\d\d\.\d{3}$/.test(await histTimeCell()), await histTimeCell());
await setProp(wids.hist, 'timeFmt', 'custom');
await setProp(wids.hist, 'timeFmtCustom', 'YYYY/MM/DD hh:mm:ss.SSS');
await restartRun();
ok('选「自定义」+ YYYY/MM/DD hh:mm:ss.SSS → 按自己的格式显示',
  /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(await histTimeCell()), await histTimeCell());
// 当前报警表也吃同一套格式（重进运行态会把变量清回初值，所以再触发一条）
await setProp(wids.list, 'timeFmt', 'hh:mm:ss.SSS');
await restartRun();
await page.evaluate(async () => { window.app.varStore.set('sMode', '自动', 'remote'); });
await sleep(500);
ok('当前报警表的时间也能精确到 ms', /^\d\d:\d\d:\d\d\.\d{3}$/.test(await curTimeCell()), await curTimeCell());
// 关掉时间列 → 表格少一列
await setProp(wids.list, 'showTime', false);
await restartRun();
await page.evaluate(async () => { window.app.varStore.set('sMode', '自动', 'remote'); });
await sleep(500);
const noTime = await page.evaluate(([wid]) => {
  const rows = [...document.querySelectorAll(`#rtPage .wd[data-id="${wid}"] .at-table tbody tr`)]
    .filter(tr => !tr.querySelector('td.alempty'));
  return {
    rows: rows.length,
    cells: rows[0] ? rows[0].querySelectorAll('td').length : 0,
    head: [...document.querySelectorAll(`#rtPage .wd[data-id="${wid}"] .at-table thead td`)].map(t => t.textContent),
  };
}, [wids.list]);
ok('关掉「显示时间列」→ 列数从 4 变 3，表头也跟着变',
  noTime.rows >= 1 && noTime.cells === 3 && !noTime.head.includes('时间'), JSON.stringify(noTime));
await setProp(wids.list, 'showTime', true);
await restartRun();

/* ── G. 按天翻看：前天/昨天/今天 各有各的记录 ── */
const dayNav = await (async () => {
  // 直接往历史里塞三天数据（走 localStorage，和真实持久化一致）
  await page.evaluate(async () => {
    const A = await import('/js/runtime/alarms.js');
    const mk = (ts, text) => ({ key: `k${ts}`, id: `k${ts}`, name: '', text, level: 'alarm', value: 1, at: ts, endAt: ts + 1000, acked: true });
    const today = new Date(); today.setHours(10, 0, 0, 0);
    const yest = new Date(today.getTime() - 86400000);
    const before = new Date(today.getTime() - 2 * 86400000);
    const list = [mk(before.getTime(), '前天那条'), mk(yest.getTime(), '昨天那条'), mk(today.getTime(), '今天那条')];
    localStorage.setItem('hmi-alarm-history', JSON.stringify(list));
    // 重新进运行态让它读进来
    const rt = await import('/js/runtime/runtime.js');
    rt.exitRun(); rt.enterRun();
  });
  await sleep(700);
  const read = () => page.evaluate(([wid]) => ({
    rows: [...document.querySelectorAll(`#rtPage .wd[data-id="${wid}"] .at-table tbody tr`)].map(tr => tr.querySelector('td:nth-child(3)')?.textContent.trim()),
    date: document.querySelector(`#rtPage .wd[data-id="${wid}"] .at-date`)?.value,
    count: document.querySelector(`#rtPage .wd[data-id="${wid}"] .at-count`)?.textContent.trim(),
  }), [wids.hist]);
  const t0 = await read();
  const clickDay = async (kind) => {
    const b = await page.locator(`#rtPage .wd[data-id="${wids.hist}"] [data-alarmday="${kind}"]`).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(350);
  };
  await clickDay('prev'); const t1 = await read();
  await clickDay('prev'); const t2 = await read();
  await clickDay('next'); const t3 = await read();
  await clickDay('today'); const t4 = await read();
  return { t0, t1, t2, t3, t4 };
})();
ok('默认显示「今天」那天的记录', JSON.stringify(t0Rows(dayNav.t0)) === JSON.stringify(['今天那条']), JSON.stringify(dayNav.t0));
function t0Rows(x) { return x.rows; }
ok('点 ‹ 前一天 → 看到昨天的记录（日期框跟着变）',
  JSON.stringify(dayNav.t1.rows) === JSON.stringify(['昨天那条']) && dayNav.t1.date !== dayNav.t0.date,
  JSON.stringify(dayNav.t1));
ok('再点 ‹ → 前天的记录', JSON.stringify(dayNav.t2.rows) === JSON.stringify(['前天那条']), JSON.stringify(dayNav.t2));
ok('点 › 后一天 → 回到昨天', JSON.stringify(dayNav.t3.rows) === JSON.stringify(['昨天那条']), JSON.stringify(dayNav.t3));
ok('点「今天」→ 直接回到今天', JSON.stringify(dayNav.t4.rows) === JSON.stringify(['今天那条']) && dayNav.t4.date === dayNav.t0.date,
  JSON.stringify(dayNav.t4));
ok('条数跟着当天走（1 条）', /1 条/.test(dayNav.t4.count || ''), String(dayNav.t4.count));

/* 直接选日期（date 框）也能跳 */
const dateJump = await (async () => {
  const yestStr = await page.evaluate(() => {
    const d = new Date(Date.now() - 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  await page.evaluate(([wid, v]) => {
    const inp = document.querySelector(`#rtPage .wd[data-id="${wid}"] .at-date`);
    inp.value = v;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, [wids.hist, yestStr]);
  await sleep(350);
  return page.evaluate(([wid]) => ({
    rows: [...document.querySelectorAll(`#rtPage .wd[data-id="${wid}"] .at-table tbody tr`)].map(tr => tr.querySelector('td:nth-child(3)')?.textContent.trim()),
    date: document.querySelector(`#rtPage .wd[data-id="${wid}"] .at-date`)?.value,
  }), [wids.hist]);
})();
ok('日期框里直接选昨天 → 跳到昨天那天的记录',
  JSON.stringify(dateJump.rows) === JSON.stringify(['昨天那条']), JSON.stringify(dateJump));

/* 历史清空 */
const clearBtn = await page.locator('#rtPage .at-clear').first().boundingBox();
ok('报警历史里有「清空记录」按钮', !!clearBtn);
await page.mouse.click(clearBtn.x + clearBtn.width / 2, clearBtn.y + clearBtn.height / 2);
await sleep(400);
const histAfter = await page.evaluate(async () => (await import('/js/runtime/alarms.js')).alarmHistory().length);
ok('点清空 → 历史清空（当前报警不受影响）', histAfter === 0, String(histAfter));

/* ── C. 退出运行态：引擎停掉 ── */
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await sleep(300);
const stopped = await page.evaluate(async () => {
  const A = await import('/js/runtime/alarms.js');
  const before = A.activeAlarms().length;
  window.app.varStore.set('rSpeed', 9999, 'remote');
  await new Promise(r => setTimeout(r, 500));
  return { running: A.isRunning(), before, after: A.activeAlarms().length };
});
ok('退出运行态后引擎停止（不再判定）', stopped.running === false, JSON.stringify(stopped));

/* ── D. 变量改名/删除时报警表跟着处理 ── */
const rename = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.alarms.length = 0;
  const a = m.project.addAlarm();
  m.project.updateAlarm(a.id, { variable: 'rSpeed', text: '转速 {rSpeed} 超限' });
  m.project.updateVariable('rSpeed', { name: 'rSpeedMain' });
  const after = { ...m.project.alarms()[0] };        // 快照！下面还要删变量，引用会被改掉
  m.project.deleteVariable('rSpeedMain');
  const afterDel = { ...m.project.alarms()[0] };
  return { renameVar: after.variable, renameText: after.text, delVar: afterDel.variable };
});
ok('变量改名 → 报警的条件和 {引用} 一起改',
  rename.renameVar === 'rSpeedMain' && rename.renameText === '转速 {rSpeedMain} 超限', JSON.stringify(rename));
ok('变量删除 → 条件里的变量清空（不会再误触发）', rename.delVar === '', JSON.stringify(rename));

/* ── E. 存档往返 ── */
const round = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const json = JSON.parse(JSON.stringify(m.project.data));
  m.project.replaceData(json);
  return { n: m.project.alarms().length, first: m.project.alarms()[0] };
});
ok('工程存档里带报警表（刷新不丢）', round.n === 1 && round.first.variable === '', JSON.stringify(round.n));

/* ── F. 中文变量名：选得中、搜得动、{引用}也认 ──
   现场反馈：报警里"选不了中文变量名" —— 两处只认 ASCII 的老毛病：
     ① 弹窗的变量格只能从下拉前 50 个里挑，中文名排在变量表后面 → 根本选不到；
     ② 内容里的 {变量名} 只匹配 ASCII → 写 {温度} 既不替换、运行时还原样显示。
   现在弹窗的变量格和属性面板同一套（varPick：输入框 + 全量候选，**只按变量名**过滤）。 */
const cnVar = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  ['温度', '中1[1]', 'GVL.中1[2]'].forEach(n => {
    if (!m.variables().some(v => v.name === n)) m.variables().push({ name: n, type: 'real', address: '', value: 25.5, len: 0 });
  });
  m.data.alarms.length = 0;
  m.commit('中文变量');
  const mod = await import('/js/editor/alarmsPanel.js');
  mod.openAlarmEditor();
  await new Promise(r => setTimeout(r, 350));
  const inp = document.getElementById('alVariable');
  // 点进变量格 → 候选表里中文名都在（全量候选，不再被截成前 50 个）。
  // ⚠ 点进去会**先按框里已有的名字过滤**（现场要求），看全量走 openVarPick({all:true})
  //   （别清 inp.value：后面还要用它接"打「中」过滤 + 点一行选中"那条路）
  if (inp) (await import('/js/editor/varPick.js')).openVarPick(inp, { all: true });
  await new Promise(r => setTimeout(r, 200));
  const allNames = [...document.querySelectorAll('.vp-list .vp-row .vp-name')].map(e => e.textContent);
  // 打字只按变量名过滤（打「中」→ 中文名那几条）
  inp.value = '中';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const hitNames = [...document.querySelectorAll('.vp-list .vp-row .vp-name')].map(e => e.textContent);
  // 真的选中（走 pick 那条路：点一行）
  const row = [...document.querySelectorAll('.vp-list .vp-row')].find(r => r.querySelector('.vp-name')?.textContent === '中1[1]');
  row?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const picked = document.getElementById('alVariable').value;
  const ta = document.getElementById('alarmTextArea');
  ta.value = '中1 过高：{中1[1]} ℃ / 温度 {温度}';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const prev = document.querySelector('.dlg-preview, .pv-tag')?.parentElement?.textContent || '';
  const bad = document.querySelector('.pv-bad')?.textContent || '';
  document.getElementById('dlgOk').click();
  await new Promise(r => setTimeout(r, 250));
  const a = m.alarms()[0];
  const A = await import('/js/runtime/alarms.js');
  return {
    allNames, hitNames, picked, bad,
    preview: prev.replace(/\s+/g, ' ').slice(0, 90),
    savedVar: a?.variable, savedText: a?.text,
    filled: A.fillAlarmText('中1 过高：{中1[1]} / 温度 {温度}'),
  };
});
ok('报警弹窗的变量格：点进去的候选里**中文变量都在**（全量候选，不再只列前 50 个）',
  cnVar.allNames.includes('温度') && cnVar.allNames.includes('中1[1]') && cnVar.allNames.includes('GVL.中1[2]'),
  JSON.stringify(cnVar.allNames.slice(-4)));
ok('在弹窗变量格里打字只按变量名过滤（打「中」→ 只剩中文名那几条）',
  cnVar.hitNames.length > 0 && cnVar.hitNames.every(n => n.includes('中')), JSON.stringify(cnVar.hitNames));
ok('点候选行就能选中（选中的中文名就是保存进报警条件的那一个）',
  cnVar.picked === '中1[1]', String(cnVar.picked));
ok('中文变量能存进报警条件', cnVar.savedVar === '中1[1]', JSON.stringify(cnVar.savedVar));
ok('内容里的 {中文变量} 编辑态就代入预览（不是原样显示、也不报"变量不存在"）',
  /25\.5/.test(cnVar.preview) && !/变量不存在/.test(cnVar.bad) && !/\{温度\}/.test(cnVar.preview),
  JSON.stringify({ preview: cnVar.preview, bad: cnVar.bad }));
ok('运行态也认中文 {引用}（触发时替换成当时的值，不再原样吐 {温度}）',
  !/\{中1\[1\]\}|\{温度\}/.test(cnVar.filled) && /--/.test(cnVar.filled), JSON.stringify(cnVar.filled));

/* ── G. 报警栏（表格行）的变量输入：中文名也能输入/搜到 ──
   以前那一格是只列「前 30 个」的 <select>：变量上千时中文名排在后面 → 一个都看不到，
   现场反馈就是"报警栏的变量输入里没有中文的"。现在改成 输入框 + 全量候选（varPick）。 */
const rowVar = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables = [];
  for (let i = 1; i <= 55; i++) m.data.variables.push({ name: `v${i}`, type: 'int', address: '', value: 0, len: 0 });
  ['中1[1]', '温度', 'GVL.中1[2]'].forEach(n =>
    m.data.variables.push({ name: n, type: 'real', address: '', value: 0, len: 0 }));
  m.data.alarms = [{
    id: 'al_cn', name: '中文报警', variable: '温度', op: '>=', value: 1,
    level: 'alarm', delaySec: 0, enabled: true, text: '{温度} 高了',
  }];
  m.commit('行变量输入');
  await new Promise(r => setTimeout(r, 400));
  const inp = document.querySelector('#alarmRows input[data-k="variable"]');
  // 候选表是 varPick.js 现画的。⚠ 现在**点进去先按框里已有的名字过滤**（现场要求），
  //   要验"全量候选里中文名都在"就走 openVarPick({all:true}) 那条路
  //   （不能把 inp.value 清掉：下面还要验那一格里的值）。
  if (inp) (await import('/js/editor/varPick.js')).openVarPick(inp, { all: true });
  await new Promise(r => setTimeout(r, 200));
  const names = [...document.querySelectorAll('.vp-list .vp-row')]
    .map(r => r.querySelector('.vp-name')?.textContent);
  document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));   // 关掉候选表
  return {
    isInput: inp?.tagName === 'INPUT',
    hasCn: ['中1[1]', '温度', 'GVL.中1[2]'].every(n => names.includes(n)),
    total: names.length, bad: !!inp?.classList.contains('bad'),
  };
});
ok('报警栏的变量格是「输入框 + 全量候选」：中文变量名都在候选里（不再只列前 30 个）',
  rowVar.isInput && rowVar.hasCn && rowVar.total === 58 && rowVar.bad === false, JSON.stringify(rowVar));

const typeVar = async (name) => {
  await page.fill('#alarmRows input[data-k="variable"]', name);
  await page.evaluate(() => document.querySelector('#alarmRows input[data-k="variable"]')
    .dispatchEvent(new Event('change', { bubbles: true })));
  await sleep(250);
  return page.evaluate(async () => {
    const m = (await import('/js/core/project.js')).project;
    const inp = document.querySelector('#alarmRows input[data-k="variable"]');
    return { saved: m.alarms()[0].variable, bad: inp.classList.contains('bad'), title: inp.title };
  });
};
const typedCn = await typeVar('中1[1]');
ok('在报警栏那一格直接输入中文变量名 → 存进报警条件，且不标红（变量表里有它）',
  typedCn.saved === '中1[1]' && typedCn.bad === false && /中1\[1\]/.test(typedCn.title),
  JSON.stringify(typedCn));
const typedBad = await typeVar('中9[9]');
ok('输入一个变量表里没有的名字 → 标红 + title 说明「这条报警永远不会触发」',
  typedBad.saved === '中9[9]' && typedBad.bad === true && /永远不会触发/.test(typedBad.title),
  JSON.stringify(typedBad));

/* ══════ 末节：**bool 变量按阈值比**（现场报的："bool 是 0 才报警"判不出来）══════
   以前 compareVal 遇到 bool 是**直接返回它自己、根本不看阈值** ——
   于是「b急停 = 0 → 报警」永远不成立（"= 1"看着对，其实是巧合）。
   现在：阈值写了 0/1（或 true/false）就按 0/1 比；阈值空着才是老口径（bool 自己就是状态）。 */
const cmp = await page.evaluate(async () => {
  const { compareVal, boolOf } = await import('/js/core/utils.js');
  return {
    t0: compareVal(false, '==', 0),        // 主诉：等于 0 时报警
    t1: compareVal(true, '==', 0),
    t2: compareVal(false, '==', '0'),
    t3: compareVal(true, '==', 1),
    t4: compareVal(false, '!=', 0),
    t5: compareVal(false, '==', false),
    t6: compareVal(true, '==', 'true'),
    t7: compareVal(true, '>=', 1),         // 新报警行的默认写法：跟老口径一致
    t8: compareVal(false, '>=', 1),
    t9: compareVal(false, '>', 0),
    t10: compareVal(true, '', ''),         // 阈值空着 → 老口径：bool 自己就是状态
    t11: compareVal(false, '', ''),
    t12: compareVal(false, '>=', 0),       // 0 >= 0：数学上成立（写这种比较的人本来就该知道）
    bools: [boolOf('真'), boolOf('假'), boolOf(''), boolOf('abc')],
  };
});
ok('★ bool 变量「= 0」判得出来（false 成立 / true 不成立）—— 现场那条 b急停 报警',
  cmp.t0 === true && cmp.t1 === false, JSON.stringify([cmp.t0, cmp.t1]));
ok('★ 阈值写 0/1 和写 false/true（含字符串）都认',
  cmp.t2 === true && cmp.t3 === true && cmp.t5 === true && cmp.t6 === true, JSON.stringify(cmp).slice(0, 120));
ok('bool 的「!= 0」= 等于真；「>= 1」「> 0」跟"等于真"一个结果（老工程默认写法行为不变）',
  cmp.t4 === false && cmp.t7 === true && cmp.t8 === false && cmp.t9 === false,
  JSON.stringify([cmp.t4, cmp.t7, cmp.t8, cmp.t9]));
ok('阈值空着 → 还是老口径（bool 自己就是状态），老工程一个字不变',
  cmp.t10 === true && cmp.t11 === false, JSON.stringify([cmp.t10, cmp.t11]));
ok('认不出来的阈值（"真"/"假"/空/乱写）不当成 0 或 1 硬比',
  JSON.stringify(cmp.bools) === '[null,null,null,null]', JSON.stringify(cmp.bools));

/* 端到端：真在运行态里让 bool 变量变 0 → 报警上来；变 1 → 报警消失 */
const boolRun = await page.evaluate(async () => {
  const P = await import('/js/core/project.js');
  const A = await import('/js/runtime/alarms.js');
  const rt = await import('/js/runtime/runtime.js');
  const names = P.project.variables().map(v => v.name);
  if (!names.includes('bStopTest')) {
    P.project.variables().push({ name: 'bStopTest', type: 'bool', address: '%MX9.9', value: false });
  }
  ['t_old', 't_bool0'].forEach(id => {                 // 清掉上次跑留下的两条
    const i = P.project.alarms().findIndex(a => a.id === id);
    if (i >= 0) P.project.alarms().splice(i, 1);
  });
  P.project.alarms().push({ id: 't_old', name: '老口径', variable: 'bStopTest', op: '>=', value: 1,
                            level: 'alarm', delaySec: 0, enabled: true, text: '老口径 {bStopTest}' });
  P.project.alarms().push({ id: 't_bool0', name: '零报警', variable: 'bStopTest', op: '==', value: 0,
                            level: 'alarm', delaySec: 0, enabled: true, text: '等于0报警 {bStopTest}' });
  P.project.commit('bool 报警测试');
  rt.exitRun();
  await rt.enterRun();
  await new Promise(r => setTimeout(r, 300));
  const hit = () => A.activeAlarms().map(a => a.name).sort().join(',');

  window.app.varStore.set('bStopTest', false, 'remote');
  await new Promise(r => setTimeout(r, 700));
  const at0 = hit();
  window.app.varStore.set('bStopTest', true, 'remote');
  await new Promise(r => setTimeout(r, 700));
  const at1 = hit();
  P.project.alarms().splice(P.project.alarms().findIndex(a => a.id === 't_bool0' || a.id === 't_old'), 2);
  P.project.commit('清掉 bool 报警测试');
  rt.exitRun();
  return { at0, at1 };
});
ok('★ 运行态真跑一遍：bStopTest=0 → 只有「等于0报警」这条响；=1 → 换成「老口径」那条响',
  boolRun.at0 === '零报警' && boolRun.at1 === '老口径', JSON.stringify(boolRun));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 报警系统回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
