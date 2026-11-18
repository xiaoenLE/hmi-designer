// verify-alarm-csv.mjs — 报警内容弹窗编辑 + 报警表 CSV 导入/导出
//   1) 内容格不再被挤成 16px，点一下开弹窗（大文本框 + 插入变量 + 预览）
//   2) CSV 导出（BOM/表头/引号转义/换行）→ 原样导入回来必须一模一样
//   3) 级别中文/英文、启用 是/否、延时夹取、非法行跳过并报错
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
await installPageShim(page);
const pageErrors = [];
const dialogs = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);

/* ── 准备：3 个变量 + 2 条报警 ── */
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.data.pages[0].widgets.length = 0;
  m.project.data.variables.length = 0;
  m.project.data.alarms.length = 0;
  [['rSpeed', 'real', 3120.5], ['iCount', 'int', 7], ['sMode', 'string', '手动']].forEach(([n, t, v]) => {
    m.project.addVariable();
    m.project.updateVariable(`var${m.project.variables().length}`, { name: n, type: t, value: v });
  });
  const a1 = m.project.addAlarm();
  m.project.updateAlarm(a1.id, { name: '转速过高', variable: 'rSpeed', op: '>=', value: 3000, level: 'alarm', text: '主轴转速过高：{rSpeed} m/min（上限 3000）' });
  const a2 = m.project.addAlarm();
  m.project.updateAlarm(a2.id, { name: '计数到', variable: 'iCount', op: '==', value: 7, level: 'warn', delaySec: 2, text: '计数到 {iCount} 件' });
  m.project.commit('CSV 测试准备');
});
await page.click('.lp-tab[data-panel="alarms"]');
await page.waitForTimeout(350);

/* ── A. 面板按钮 + 内容格宽度 ── */
const head = await page.evaluate(() => ({
  imp: !!document.getElementById('btnAlarmCsvIn'),
  exp: !!document.getElementById('btnAlarmCsvOut'),
  oldInput: !!document.querySelector('#alarmTable input[data-k="text"]'),
  cell: (() => {
    const el = document.querySelector('#alarmTable tr[data-alarm] .al-text');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height),
      // 内容格宽度按**按钮所在的 td** 量，别写死第几列（列序调过：内容现在是第 3 列）
      contentTdW: Math.round(el.closest('td').getBoundingClientRect().width),
      text: el.textContent.trim().slice(0, 30),
      refs: el.querySelectorAll('.al-ref').length,
      scrollW: document.getElementById('alarmTable').scrollWidth,
      wrapW: Math.round(document.getElementById('alarmTable').getBoundingClientRect().width),
    };
  })(),
}));
ok('报警面板有「导入 CSV / 导出 CSV」按钮', head.imp && head.exp, JSON.stringify({ imp: head.imp, exp: head.exp }));
ok('内容格不再是小输入框（换成可点的按钮）', !head.oldInput && head.cell?.tag === 'BUTTON', JSON.stringify({ old: head.oldInput, tag: head.cell?.tag }));
ok('内容格宽度 ≥ 200px（原来只有 20px / 输入框 16px）', (head.cell?.contentTdW || 0) >= 200 && (head.cell?.w || 0) >= 200,
  `td=${head.cell?.contentTdW}px 按钮=${head.cell?.w}px 面板宽=${head.cell?.wrapW}px 表宽=${head.cell?.scrollW}px`);
ok('内容里 {变量} 在格子里高亮显示', head.cell?.refs >= 1, `高亮 ${head.cell?.refs} 处：${head.cell?.text}`);
ok('表格宽于面板时横向可滚动（不会再压缩各列）', head.cell?.scrollW >= head.cell?.wrapW, `表 ${head.cell?.scrollW} / 容器 ${head.cell?.wrapW}`);

/* ── B. 点「内容」前面那个 ✎ → 弹窗（编辑这条报警：条件 + 内容一次改完） ── */
await page.click('#alarmTable tr[data-alarm] .al-editbtn');
await page.waitForTimeout(250);
const dlg = await page.evaluate(() => {
  const mask = document.getElementById('dlgMask');
  const ta = document.getElementById('alarmTextArea');
  const box = document.getElementById('dlgBox');
  const chips = [...document.querySelectorAll('#alarmVarChips .dlg-chip')].map(c => c.dataset.var);
  if (!ta) return { open: !mask.classList.contains('hidden'), missing: true };
  const r = ta.getBoundingClientRect();
  return {
    open: !mask.classList.contains('hidden'),
    title: document.getElementById('dlgTitle').textContent,
    val: ta.value, w: Math.round(r.width), h: Math.round(r.height),
    wide: box.classList.contains('wide'), boxW: Math.round(box.getBoundingClientRect().width),
    chips, okText: document.getElementById('dlgOk').textContent,
    prev: document.getElementById('alarmPrev').textContent, cond: document.getElementById('alarmCond').textContent,
    focus: document.activeElement === ta,
    form: {
      name: document.getElementById('alName')?.value,
      variable: document.getElementById('alVariable')?.value,
      op: document.getElementById('alOp')?.value,
      value: document.getElementById('alValue')?.value,
      delay: document.getElementById('alDelaySec')?.value,
      level: document.getElementById('alLevel')?.value,
      enabled: document.getElementById('alEnabled')?.checked,
    },
  };
});
ok('点内容格弹出编辑窗（标题带报警名）', dlg.open && /编辑报警/.test(dlg.title) && /转速过高/.test(dlg.title), JSON.stringify(dlg.title));
ok('弹窗是大文本框（宽 ≥ 500px、高 ≥ 180px）', dlg.w >= 500 && dlg.h >= 180, `${dlg.w}×${dlg.h}（对话框 ${dlg.boxW}px wide=${dlg.wide}）`);
ok('弹窗里把这条报警的条件/级别都带出来了',
  dlg.form.name === '转速过高' && dlg.form.variable === 'rSpeed' && dlg.form.op === '>=' && dlg.form.value === '3000'
  && dlg.form.level === 'alarm' && dlg.form.enabled === true, JSON.stringify(dlg.form));
ok('文本框里带出原来的内容', /主轴转速过高：\{rSpeed\}/.test(dlg.val || ''), (dlg.val || '').slice(0, 40));
ok('变量按钮列全了（3 个）', JSON.stringify(dlg.chips) === JSON.stringify(['rSpeed', 'iCount', 'sMode']), JSON.stringify(dlg.chips));
ok('预览把 {变量} 换成初值了', /3120\.5/.test(dlg.prev || ''), (dlg.prev || '').replace(/\s+/g, ' ').slice(0, 70));
ok('顶上一句「条件：变量 ≥ 阈值」跟着表单走', /rSpeed ≥ 3000/.test(dlg.cond || ''), (dlg.cond || '').slice(0, 60));
ok('打开就聚焦在文本框（不用再点一下）', dlg.focus === true, String(dlg.focus));

/* ── C. 弹窗里改条件也一起保存 + 插入变量 + Ctrl+Enter ── */
await page.fill('#alValue', '2800');
await page.selectOption('#alLevel', 'urgent');
await page.fill('#alDelaySec', '3');
await page.waitForTimeout(150);
const condLive = await page.textContent('#alarmCond');
ok('改阈值/级别/延时，条件那行实时更新', /rSpeed ≥ 2800/.test(condLive) && /3s/.test(condLive) && /紧急/.test(condLive), condLive);

await page.evaluate(() => {
  const ta = document.getElementById('alarmTextArea');
  ta.value = '转速 {rSpeed} 超限，模式 {sMode}';
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#alarmVarChips .dlg-chip[data-var="iCount"]');
await page.waitForTimeout(150);
const afterInsert = await page.inputValue('#alarmTextArea');
ok('点变量按钮 → 在光标处插入 {iCount}', afterInsert === '转速 {rSpeed} 超限，模式 {sMode}{iCount}', afterInsert);

await page.evaluate(() => {
  const ta = document.getElementById('alarmTextArea');
  ta.value = '转速 {rSpeed} 超限\n第二行：模式 {sMode}';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.keyboard.press('Control+Enter');   // 焦点在文本框里 → 快捷键保存
await page.waitForTimeout(300);
const saved = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const a = m.project.alarms()[0];
  return {
    hidden: document.getElementById('dlgMask').classList.contains('hidden'),
    text: a.text, value: a.value, level: a.level, delay: a.delaySec,
    cell: document.querySelector('#alarmTable tr[data-alarm] .al-text')?.textContent.trim(),
  };
});
ok('Ctrl+Enter 保存并关窗', saved.hidden === true, JSON.stringify({ hidden: saved.hidden }));
ok('多行内容原样存进工程（换行保留）', saved.text === '转速 {rSpeed} 超限\n第二行：模式 {sMode}', JSON.stringify(saved.text));
ok('弹窗里改的条件也一起保存（阈值 2800 / 紧急 / 延时 3s）',
  saved.value === 2800 && saved.level === 'urgent' && saved.delay === 3, JSON.stringify({ v: saved.value, lv: saved.level, d: saved.delay }));
ok('保存后表格里的内容格跟着更新', /第二行/.test(saved.cell || ''), (saved.cell || '').slice(0, 50));

/* ── D. 取消不改 + 不存在变量的 ⚠（✎ 开弹窗；点内容格是就地改，见 verify-alarm 的 A3） ── */
await page.click('#alarmTable tr[data-alarm] .al-editbtn');
await page.waitForTimeout(200);
await page.fill('#alarmTextArea', '这段不要保存');
await page.fill('#alName', '改个名字也不要保存');
await page.click('#dlgCancel');
await page.waitForTimeout(200);
const cancelled = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { text: m.project.alarms()[0].text, name: m.project.alarms()[0].name };
});
ok('点取消整条都不改（内容 + 名称）',
  /第二行/.test(cancelled.text) && !/不要保存/.test(cancelled.text) && cancelled.name === '转速过高',
  JSON.stringify(cancelled));

await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.updateAlarm(m.project.alarms()[0].id, { text: '转速 {meiyou} 超限' });
});
await page.waitForTimeout(300);
const warn = await page.evaluate(() => {
  const cell = document.querySelector('#alarmTable tr[data-alarm] .al-text');
  return { flag: !!cell?.querySelector('.al-flag'), title: cell?.title || '' };
});
ok('内容里引用了不存在的变量 → 格子上有 ⚠ 和提示', warn.flag && /meiyou/.test(warn.title), warn.title.replace(/\n/g, ' | ').slice(0, 60));

/* ── D2. 「＋ 添加报警」开弹窗，填完点「添加」 ── */
await page.click('#btnAddAlarm');
await page.waitForTimeout(250);
const addDlg = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  okText: document.getElementById('dlgOk').textContent,
  name: document.getElementById('alName')?.value,
  text: document.getElementById('alarmTextArea')?.value,
  variable: document.getElementById('alVariable')?.value,
  focusName: document.activeElement === document.getElementById('alName'),
  n: document.querySelectorAll('#alarmTable tr[data-alarm]').length,
}));
ok('点「＋ 添加报警」开的是弹窗（不是直接插一行空报警）',
  addDlg.open && addDlg.title === '添加报警' && addDlg.n === 2, JSON.stringify(addDlg));
// 右上角的 ✕：所有用 showDialog 的弹窗都有（现场要求；报警弹窗内容长，底下的按钮要滚才看得见）
const alarmX = await page.evaluate(() => {
  const x = document.getElementById('dlgX'), box = document.getElementById('dlgBox');
  if (!x || !box) return null;
  const r = x.getBoundingClientRect(), b = box.getBoundingClientRect();
  return { visible: r.width > 0, topRight: r.top < b.top + 60 && r.right > b.right - 60 };
});
ok('添加报警弹窗右上角也有关闭 ✕', alarmX?.visible === true && alarmX.topRight === true, JSON.stringify(alarmX));
ok('新报警表单：名称预填、内容空、光标在名称上',
  /^报警\d+$/.test(addDlg.name) && addDlg.text === '' && addDlg.variable === 'rSpeed' && addDlg.focusName === true,
  JSON.stringify({ name: addDlg.name, text: addDlg.text, focus: addDlg.focusName }));

await page.fill('#alName', '温度过高');
await page.fill('#alValue', '85.5');
await page.selectOption('#alOp', '>');
await page.selectOption('#alLevel', 'warn');
await page.fill('#alDelaySec', '5');
await page.fill('#alarmTextArea', '主轴温度 {rSpeed}℃ 超过上限');
await page.waitForTimeout(150);
await page.click('#dlgOk');
await page.waitForTimeout(400);
const added = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const a = m.project.alarms().find(x => x.name === '温度过高');
  return {
    n: m.project.alarms().length, hidden: document.getElementById('dlgMask').classList.contains('hidden'),
    a: a ? { variable: a.variable, op: a.op, value: a.value, level: a.level, delaySec: a.delaySec, text: a.text, enabled: a.enabled } : null,
    rows: [...document.querySelectorAll('#alarmTable tr[data-alarm]')].map(tr => tr.querySelector('input[data-k="name"]')?.value),
  };
});
ok('填完点「添加」→ 工程里多一条，表格多一行',
  added.n === 3 && added.hidden && added.rows.includes('温度过高'), JSON.stringify(added.rows));
ok('添加时填的条件/级别/延时/内容都存对了',
  added.a?.variable === 'rSpeed' && added.a?.op === '>' && added.a?.value === 85.5
  && added.a?.level === 'warn' && added.a?.delaySec === 5 && added.a?.text === '主轴温度 {rSpeed}℃ 超过上限',
  JSON.stringify(added.a));

/* ── D3. 点「内容」格编辑已有报警（行尾那个 ✎ 已按现场要求去掉，内容格自己就是入口） ── */
await page.click('#alarmTable tr[data-alarm]:nth-child(3) .al-editbtn');
await page.waitForTimeout(250);
const editDlg = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  name: document.getElementById('alName')?.value,
  delay: document.getElementById('alDelaySec')?.value,
  cond: document.getElementById('alarmCond').textContent,
}));
ok('点「内容」格打开的是那条报警的编辑窗', editDlg.open && /编辑报警/.test(editDlg.title) && editDlg.name === '温度过高',
  JSON.stringify({ title: editDlg.title, name: editDlg.name }));
ok('编辑窗条件行显示的是这条的条件（含延时）', /rSpeed > 85\.5/.test(editDlg.cond) && /5s/.test(editDlg.cond), editDlg.cond);
await page.fill('#alDelaySec', '0');
await page.fill('#alarmTextArea', '温度超限（已改）');
await page.click('#dlgOk');
await page.waitForTimeout(350);
const edited = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const a = m.project.alarms().find(x => x.name === '温度过高');
  return { delay: a.delaySec, text: a.text, n: m.project.alarms().length };
});
ok('编辑保存后只改这一条（条数不变）', edited.n === 3 && edited.delay === 0 && edited.text === '温度超限（已改）', JSON.stringify(edited));

/* ── D4. 弹窗里的变量格：输入框 + 候选表（**只按变量名**过滤，和属性面板同一套） ── */
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.variables().forEach((v, i) => m.project.updateVariable(v.name, { address: `HR${100 + i * 2}` }));
  m.project.commit('补地址');
});
await page.waitForTimeout(250);
await page.click('#alarmTable tr[data-alarm] .al-editbtn');
await page.waitForTimeout(250);
const vpRows = () => page.evaluate(() => [...document.querySelectorAll('.vp-list .vp-row')].map(r => ({
  name: r.querySelector('.vp-name')?.textContent || '',
  meta: r.querySelector('.vp-meta')?.textContent || '',
  isNew: r.classList.contains('vp-new'),                       // 底部那行「＋ 新建变量…」
  byAddr: !!r.querySelector('.vp-tag'),                        // 「按地址」命中标记
})));
/** 点进变量格 → 候选表内容（框里有字时就按那个字过滤） */
const vpNow = async () => {
  await page.evaluate(() => document.getElementById('alVariable').focus());
  await page.waitForTimeout(180);
  return vpRows();
};
const vAll = await vpNow();
ok('候选行带出 类型/地址（知道该选哪个）',
  vAll.some(r => r.name === 'rSpeed' && /real · HR100/.test(r.meta)), JSON.stringify(vAll));
// ⚠ 这一格原本带着已选的变量，而**点进去会先按框里已有的名字过滤**（现场要求）→
//   要看"全量候选"就先把框清空，并用 openVarPick 当场重画一次
//   （focus 不会二次触发：输入框本来就是焦点）
await page.evaluate(async () => {
  const inp = document.getElementById('alVariable');
  inp.value = '';
  (await import('/js/editor/varPick.js')).openVarPick(inp);
});
await page.waitForTimeout(180);
const vAllFull = await vpRows();
ok('框里清空后：候选就是变量表里的全部（没有多余的「（未选）」项）',
  vAllFull.length === 3, JSON.stringify(vAllFull.map(r => r.name)));

const vPre = await page.evaluate(async () => {
  const inp = document.getElementById('alVariable');
  inp.value = 'rSpeed';
  (await import('/js/editor/varPick.js')).openVarPick(inp);      // 不传 all = 按框里名字检索
  return [...document.querySelectorAll('.vp-list .vp-row .vp-name')].map(e => e.textContent);
});
ok('框里已有变量名时点进去 = 先按它检索（不再一进去就甩全量）',
  vPre.length >= 1 && vPre.every(n => n.includes('rSpeed')), JSON.stringify(vPre));

await page.fill('#alVariable', 'count');
await page.waitForTimeout(180);
const vName = await vpRows();
// ⚠ 现在候选表底部还会挂一行「＋ 新建变量「count」」（名字不在变量表里时就有它）——
//   判断"按名字筛出来了哪些"要把那一行排除掉（它带 vp-new 类）。
const vNameReal = vName.filter(r => !r.isNew);
ok('按名称筛：只剩 iCount（当前已选的那条本来就不在候选里时也不影响）',
  vNameReal.length === 1 && vNameReal[0].name === 'iCount', JSON.stringify(vName));

await page.fill('#alVariable', '104');
await page.waitForTimeout(180);
const vAddrAll = await vpRows();
const vAddr = vAddrAll.filter(r => !r.isNew);
// 现场要求（后来加的）：**地址也算命中** —— 拿着 PLC 点位找变量是常事（打 104 出 sMode，挂「按地址」标记）
ok('地址**也参与**匹配（打 104 → 出 sMode 并打「按地址」标记；新建变量那行不算）',
  vAddr.length === 1 && vAddr[0].name === 'sMode' && vAddr[0].byAddr === true, JSON.stringify(vAddrAll));

await page.fill('#alVariable', 'speed');
await page.waitForTimeout(150);
await page.press('#alVariable', 'Enter');
await page.waitForTimeout(220);
const vPick = await page.evaluate(() => document.getElementById('alVariable').value);
ok('打字后按 Enter → 选中第一个匹配项（rSpeed）', vPick === 'rSpeed', String(vPick));

await page.press('#alVariable', 'Escape');
await page.waitForTimeout(200);
const vEsc = await page.evaluate(() => ({
  list: !!document.querySelector('.vp-list:not([hidden])'),
  val: document.getElementById('alVariable').value,
}));
ok('Esc 收起候选表（输入框里的值不动，免得手一抖把选好的变量抹了）',
  vEsc.list === false && vEsc.val === 'rSpeed', JSON.stringify(vEsc));

const vCond = await page.textContent('#alarmCond');
ok('选中变量后条件行跟着换', /rSpeed/.test(vCond), vCond);

/* 变量很多时：候选照样**全量现画**（点进去才画，不存在"一次建上万个 option"） */
await page.click('#dlgCancel');
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  for (let i = 1; i <= 20; i++) {
    m.project.addVariable();
    m.project.updateVariable(`var${m.project.variables().length}`, { name: `iAxis${i}`, type: 'int', value: 0, address: `HR${500 + i}` });
  }
  m.project.commit('加到 23 个变量');
});
await page.waitForTimeout(300);
await page.click('#alarmTable tr[data-alarm] .al-editbtn');
await page.waitForTimeout(250);
await page.evaluate(() => { document.getElementById('alVariable').value = ''; });
await page.evaluate(async () => (await import('/js/editor/varPick.js')).openVarPick(document.getElementById('alVariable')));
await page.waitForTimeout(200);
const vMany = await vpRows();
ok('变量 23 个：候选全量列出（23 条一条不少）',
  vMany.length === 23 && vMany.some(r => r.name === 'rSpeed'), String(vMany.length));await page.fill('#alVariable', 'axis1');
await page.waitForTimeout(200);
const vMany2 = await vpRows();
ok('此时一打就筛出来（iAxis1 / iAxis10…iAxis19）',
  vMany2.filter(r => /^iAxis1/.test(r.name)).length >= 2 && !vMany2.some(r => r.name === 'iCount'),
  JSON.stringify(vMany2.map(r => r.name)));

/* ── D5. 「插入变量」按钮也不能摊一大片（多出来的收进「还有 N 个」） ── */
const chipBox = () => page.evaluate(() => {
  const box = document.getElementById('alarmVarChips');
  const chips = [...box.querySelectorAll('.dlg-chip[data-var]')];
  return {
    n: chips.length, names: chips.map(c => c.dataset.var),
    more: box.querySelector('#alChipMore')?.textContent.trim() || '',
    less: !!box.querySelector('#alChipLess'),
    h: Math.round(box.getBoundingClientRect().height),
    maxH: getComputedStyle(box).maxHeight,
    taH: Math.round(document.getElementById('alarmTextArea').getBoundingClientRect().height),
    boxH: Math.round(document.getElementById('dlgBox').getBoundingClientRect().height),
  };
});
await page.fill('#alVariable', '');
await page.waitForTimeout(200);
const cMany = await chipBox();
ok('变量 23 个时，插入按钮最多只摆 6 个（正好一行，不摊成一大片）',
  cMany.n === 6 && /还有 17 个/.test(cMany.more), JSON.stringify([cMany.n, cMany.more]));
ok('按钮区高度就是一行（≤ 40px，超长也最多 112px 后滚动）',
  cMany.h <= 40 && cMany.maxH === '112px', JSON.stringify([cMany.h, cMany.maxH]));
ok('内容文本框仍然是完整的大框（没被变量按钮挤小）', cMany.taH >= 180, String(cMany.taH));

await page.click('#alChipMore');
await page.waitForTimeout(200);
const cOpen = await chipBox();
ok('点「还有 17 个…」→ 全展开，并给「收起」',
  cOpen.n === 23 && cOpen.less === true && cOpen.h <= 115, JSON.stringify([cOpen.n, cOpen.h]));

// 一个搜索框就够：变量格里打的字同时筛候选和下面的插入按钮
await page.fill('#alVariable', 'axis1');
await page.waitForTimeout(200);
const cFiltered = await chipBox();
ok('变量格里打字同时筛「插入变量」按钮（只留匹配的，不再要手动翻）',
  cFiltered.n >= 2 && cFiltered.names.every(n => /^iAxis1/.test(n)) && !cFiltered.more && !cFiltered.less,
  JSON.stringify(cFiltered.names));

await page.fill('#alVariable', '');
await page.waitForTimeout(200);
await page.click('#alChipLess');
await page.waitForTimeout(200);
const cFolded = await chipBox();
ok('清空搜索 → 回到展开态 → 点「收起」收回到 6 个',
  cFolded.n === 6 && /还有 17 个/.test(cFolded.more), JSON.stringify([cFolded.n, cFolded.more]));

const insRes = await page.evaluate(() => {
  const ta = document.getElementById('alarmTextArea');
  ta.value = '温度 ';
  ta.setSelectionRange(ta.value.length, ta.value.length);
  return true;
});
await page.click('#alarmVarChips .dlg-chip[data-var="iAxis1"]');
await page.waitForTimeout(150);
const insText = await page.inputValue('#alarmTextArea');
ok('收起状态下插入按钮照样好使（{iAxis1} 插到光标处）', insText === '温度 {iAxis1}', insText);
await page.click('#dlgCancel');
await page.waitForTimeout(200);

/* ── E. 导出 CSV ── */
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const [a1, a2] = m.project.alarms();
  m.project.updateAlarm(a1.id, {
    name: '转速过高', text: '转速过高,超 3000 "紧急"\n第二行：模式 {sMode}', level: 'alarm', value: 3000,
  });
  m.project.updateAlarm(a2.id, { name: '计数到', text: '计数到 {iCount} 件', level: 'warn', delaySec: 2, enabled: false });
  m.project.commit('导出前准备');
});
await page.waitForTimeout(300);
// ⚠ 浏览器里点导出默认弹系统「另存为」框（js/core/csv.js 的 saveTextFile → showSaveFilePicker），
//   自动化点不了那个原生框 —— 这里先摘掉保存框接口，验的是**退回浏览器下载**那条路
//   （弹框那条路在 verify-export-file.mjs 里用假 handle 验）
await page.evaluate(() => { delete window.showSaveFilePicker; });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnAlarmCsvOut')]);
const csvPath = await dl.path();
const fs = await import('node:fs');
const csv = fs.readFileSync(csvPath, 'utf8');
const fname = dl.suggestedFilename();
ok('导出按钮真的下载了 CSV 文件', /报警表\.csv$/.test(fname), fname);
ok('CSV 带 UTF-8 BOM（Excel 打开不乱码）', csv.charCodeAt(0) === 0xFEFF, '首字符 U+' + csv.charCodeAt(0).toString(16).toUpperCase());
const headerLine = csv.replace(/^\uFEFF/, '').split(/\r\n/)[0];
ok('表头就是那 8 列', headerLine === '名称,变量,比较,阈值,延时s,级别,内容,启用', headerLine);
ok('内容里有逗号/引号 → 自动加引号转义', csv.includes('"转速过高,超 3000 ""紧急""'), csv.split(/\r\n/)[1]);
ok('级别导成中文、启用导成 是/否', /,报警,/.test(csv) && /,警告,/.test(csv) && /,否$/.test(csv.split(/\r\n/)[2]), csv.split(/\r\n/)[2]);

/* ── F. 往返：清空后把导出的 CSV 原样导入回来 ── */
const roundTrip = await page.evaluate(async (text) => {
  const m = await import('/js/core/project.js');
  const csvMod = await import('/js/core/csv.js');
  const alarmMod = await import('/js/runtime/alarms.js');
  const before = JSON.parse(JSON.stringify(m.project.alarms()));
  const beforeIds = before.map(a => a.id);
  m.project.alarms().length = 0;
  m.project.commit('清空');
  const res = csvMod.importAlarmsCsv(text, { mode: 'replace', levels: alarmMod.ALARM_LEVELS });
  const after = JSON.parse(JSON.stringify(m.project.alarms()));
  const pick = (a) => ({ name: a.name, variable: a.variable, op: a.op, value: a.value, delaySec: a.delaySec, level: a.level, text: a.text, enabled: a.enabled });
  return {
    res, same: JSON.stringify(before.map(pick)) === JSON.stringify(after.map(pick)),
    before: before.map(pick), after: after.map(pick),
    ids: after.map(a => a.id), idsFresh: after.every(a => a.id && !beforeIds.includes(a.id)),
  };
}, csv);
ok('导出→清空→导入，两条报警逐字段还原（含多行/逗号/引号内容）', roundTrip.same,
  roundTrip.same ? '' : JSON.stringify(roundTrip.after));
ok('往返后「启用=否」还原成 false', roundTrip.after[1]?.enabled === false, JSON.stringify(roundTrip.after[1]?.enabled));
ok('往返后 id 是新的（不会跟历史里的旧 id 撞）', roundTrip.idsFresh === true, JSON.stringify(roundTrip.ids));

/* ── G. 对话框导入：中英文级别 / 延时夹取 / 缺变量警告 / 非法行跳过 ── */
await page.click('#btnAlarmCsvIn');
await page.waitForTimeout(250);
const impDlg = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  hasArea: !!document.getElementById('alarmCsvText'),
  modes: [...document.querySelectorAll('input[name="alarmImpMode"]')].map(i => i.value),
  hasPick: !!document.getElementById('alarmCsvPick'),
  areaH: Math.round(document.getElementById('alarmCsvText')?.getBoundingClientRect().height || 0),
}));
ok('「导入 CSV」开的是弹窗（带粘贴框/文件选择/三种模式）',
  impDlg.open && impDlg.hasArea && impDlg.modes.length === 3 && impDlg.hasPick, JSON.stringify(impDlg));

const csvText = [
  '名称,变量,比较,阈值,延时s,级别,内容,启用',
  '中文级别,rSpeed,≥,2500,0,紧急,转速 {rSpeed} 太高,是',
  '英文级别,iCount,==,3,0,warn,计数 {iCount},否',
  '延时超范围,iCount,>,1,9999,提示,夹取测试,',
  '缺变量,nonexist,>,1,0,报警,没有这个变量,是',
  '全角比较,sMode,＝,自动,0,报警,模式 {sMode},是',
  '坏比较符,iCount,><,1,0,报警,这行要跳过,是',
  '坏级别,iCount,>,1,0,乱七八糟,这行也要跳过,是',
].join('\n');
await page.fill('#alarmCsvText', csvText);
await page.click('input[name="alarmImpMode"][value="replace"]');
await page.waitForTimeout(120);
await page.click('#dlgOk');
await page.waitForTimeout(500);
const impRes = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { n: m.project.alarms().length, list: m.project.alarms().map(a => ({ name: a.name, level: a.level, enabled: a.enabled, delay: a.delaySec, op: a.op, value: a.value, text: a.text })) };
});
const byName = Object.fromEntries(impRes.list.map(a => [a.name, a]));
ok('替换模式：旧的清掉，5 条合法行进来（2 条非法行被跳过）', impRes.n === 5, JSON.stringify(impRes.list.map(a => a.name)));
ok('级别中英文都认（紧急/警告/提示/报警）',
  byName['中文级别']?.level === 'urgent' && byName['英文级别']?.level === 'warn' && byName['延时超范围']?.level === 'info', JSON.stringify(impRes.list.map(a => [a.name, a.level])));
ok('启用列：否 → false，空 → true',
  byName['英文级别']?.enabled === false && byName['中文级别']?.enabled === true && byName['缺变量']?.enabled === true, JSON.stringify(impRes.list.map(a => [a.name, a.enabled])));
ok('比较符 ≥ / ＝ 归一化成 >= / ==', byName['中文级别']?.op === '>=' && byName['全角比较']?.op === '==', JSON.stringify(impRes.list.map(a => [a.name, a.op])));
ok('延时 9999 夹到 600', byName['延时超范围']?.delay === 600, JSON.stringify(impRes.list.map(a => [a.name, a.delay])));
ok('阈值为数字时按数字存', byName['中文级别']?.value === 2500, JSON.stringify(byName['中文级别']?.value));
const msg = dialogs.join('\n');
ok('导入结果回执里有「新增/更新」计数和跳过原因',
  /新增 5 条/.test(msg) && /跳过 2 行/.test(msg) && /比较符/.test(msg) && /级别/.test(msg), msg.split('\n').slice(-6).join(' | ').slice(0, 150));
ok('缺变量 / 阈值不合法会给警告但不拦着导入', /变量 nonexist 不在变量表里/.test(msg), msg.split('\n').filter(l => /注意/.test(l)).join('') || msg.slice(-120));

/* ── H. 导入弹窗里选文件（FileReader → 文本区 → 导入） ── */
await page.click('#btnAlarmCsvIn');
await page.waitForTimeout(250);
await page.setInputFiles('#alarmCsvPick', {
  name: 'alarms.csv', mimeType: 'text/csv',
  buffer: Buffer.from('\uFEFF名称,变量,比较,阈值,延时s,级别,内容,启用\r\n文件导入,rSpeed,>=,100,0,报警,来自文件 {rSpeed},是\r\n', 'utf8'),
});
await page.waitForTimeout(400);
const pickInfo = await page.evaluate(() => ({
  val: document.getElementById('alarmCsvText').value,
  info: document.getElementById('alarmCsvPickInfo').textContent,
}));
ok('选文件后内容读进文本框并提示行数', /文件导入/.test(pickInfo.val) && /alarms\.csv/.test(pickInfo.info), pickInfo.info);
await page.click('input[name="alarmImpMode"][value="upsert"]');
await page.click('#dlgOk');
await page.waitForTimeout(400);
const upRes = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  return { n: m.project.alarms().length, names: m.project.alarms().map(a => a.name), first: m.project.alarms()[0].text };
});
ok('追加模式：新名称进来，条数 5 → 6', upRes.n === 6 && upRes.names.includes('文件导入'), JSON.stringify(upRes.names));

/* ── I. 空内容 + 取消/回归 ── */
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const a = m.project.addAlarm();
  m.project.updateAlarm(a.id, { name: '空内容', text: '' });
});
await page.waitForTimeout(300);
const emptyCell = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#alarmTable tr[data-alarm] .al-text')].pop();
  return { cls: el.className, text: el.textContent.trim() };
});
ok('没写内容时格子里显示「点此填写内容」', /empty/.test(emptyCell.cls) && /填写内容/.test(emptyCell.text), JSON.stringify(emptyCell));

const filt = await page.evaluate(async () => {
  const inp = document.getElementById('alarmFilter');
  inp.value = '文件导入';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // 窗口化列表按帧重画
  return document.querySelectorAll('#alarmTable tr[data-alarm]').length;
});
ok('筛选框仍然能用（只留 1 行）', filt === 1, String(filt));

/* ══════ 变量下拉的容错：数量很大时只放前 50 个（不放会一次建上万个 option，卡 1.4 秒） ══════ */
await page.evaluate(() => {
  const inp = document.getElementById('alarmFilter');
  inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
/* 变量再多也**全量**给（不再截成前 50 个）：候选是现画的，点进去才画，不存在"一次建上万个 option"的问题 */
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  for (let i = 21; i <= 60; i++) {
    m.project.addVariable();
    m.project.updateVariable(`var${m.project.variables().length}`, { name: `iMore${i}`, type: 'int', value: 0, address: `HR${600 + i}` });
  }
  m.project.commit('加到 63 个变量');
});
await page.waitForTimeout(300);
await page.click('#alarmTable tr[data-alarm] .al-editbtn');
await page.waitForTimeout(250);
const vCap = await page.evaluate(async () => {
  const inp = document.getElementById('alVariable');
  inp.value = '';                       // 清空 = 浏览全部（点进去默认按框里已有的名字检索）
  (await import('/js/editor/varPick.js')).openVarPick(inp);
  await new Promise(r => setTimeout(r, 250));
  const names = [...document.querySelectorAll('.vp-list .vp-row .vp-name')].map(e => e.textContent);
  return { n: names.length, last: names[names.length - 1], names };
});
ok('变量 63 个：候选**全量都在**（不再截成前 50 个，排在最后的 iMore60 也在）',
  vCap.n === 63 && vCap.names.includes('iMore60'), JSON.stringify([vCap.n, vCap.last]));
await page.fill('#alVariable', 'iMore60');
await page.waitForTimeout(220);
const vCap2 = await page.evaluate(() =>
  [...document.querySelectorAll('.vp-list .vp-row .vp-name')].map(e => e.textContent));
ok('打字就筛到那一个（iMore60）', JSON.stringify(vCap2) === JSON.stringify(['iMore60']), JSON.stringify(vCap2));
await page.click('#dlgCancel');


ok('全程没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n合计 ${results.length} 项，失败 ${fails} 项`);
await browser.close();
process.exit(fails ? 1 : 0);
