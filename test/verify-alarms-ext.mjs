// verify-alarms-ext.mjs — 报警控件扩展：报警声 + 点行/点条跳页（+ 确认/清空/翻页不回归）
//
// 覆盖：
//   ① 三个报警控件属性面板里有新属性（alarmList: 报警声/点行跳转；alarmBar: 报警声/点条跳转；
//      alarmHistory: 点行跳转），且这些 props **没有 hint**；
//   ② 报警声：勾「报警声」的控件在画面上时，**有新报警触发**才响（beepAlarm → 2 个振荡器）；
//      没勾就完全安静；确认一条（raised 为空）不会再响；
//   ③ 点「当前报警」一行 → 跳到 jumpPage 配的页面（按页面名）；
//   ④ 点报警条 → 跳到 clickJump 配的页面（按页面 id）；点「报警历史」一行 → 跳到 jumpPage；
//   ⑤ 确认按钮：该条 acked（原有行为不回归），且**不会顺手跳页**；
//   ⑥ 报警历史的翻页（‹ › 今天）/ 清空按钮不会误触发跳页。
//
// 用法：node test/verify-alarms-ext.mjs   （自己起隔离数据目录的后端，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';

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

const PORT = await freePort();
installNodeFetchPatch(PORT);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-alarms-ext-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await sleep(300);
  try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

try {
  // 报警记录/后端同步掐掉：本套件只验控件行为，别让服务器那份历史掺进来
  await page.evaluate(() => import('/js/api/backend.js').then(m => {
    m.backend.probe = async () => null;
    m.backend.state = 'offline';
    m.backend.loadAlarms = async () => [];
    m.backend.saveAlarms = async () => ({ ok: true });
    m.backend.expectsServer = () => false;
  }));
  await page.waitForFunction(() => window.app?.project?.data);
  await page.evaluate(() => { try { localStorage.removeItem('hmi-alarm-history'); } catch { /* 忽略 */ } });
  await sleep(300);

  /* ═══════════ 准备：2 个变量 / 2 条报警 / 2 个页面 / 3 个报警控件 ═══════════ */
  const ids = await page.evaluate(async () => {
    const { project } = await import('/js/core/project.js');
    project.currentPage().widgets.length = 0;         // 源页先清空（编辑态画布干净、好点选）
    project.data.variables.length = 0;
    project.data.alarms.length = 0;
    ['rSpeed', 'iCount'].forEach((n, i) => {
      project.addVariable();
      project.updateVariable(`var${i + 1}`, { name: n, type: n === 'rSpeed' ? 'real' : 'int', value: 0 });
    });
    const a1 = project.addAlarm();
    project.updateAlarm(a1.id, { name: '转速过高', variable: 'rSpeed', op: '>=', value: 3000,
      level: 'alarm', text: '主轴转速过高：{rSpeed}' });
    const a2 = project.addAlarm();
    project.updateAlarm(a2.id, { name: '计数到', variable: 'iCount', op: '>=', value: 5,
      level: 'warn', text: '加工计数到 {iCount} 件' });

    // 目标页：跳过去应该看到「详情页标记」
    const target = project.addPage('page');
    project.updatePage(target.id, { name: '报警详情页' });
    const mark = project.addWidget('label', 40, 40);
    project.updateWidgetProp(mark.id, 'text', '详情页标记');

    // 回到源页摆三个报警控件
    const src = project.pages().filter(p => p.type === 'page' && p.id !== target.id)[0];
    project.setCurrentPage(src.id);
    const list = project.addWidget('alarmList', 20, 60);
    project.updateWidgetField(list.id, 'w', 430);
    project.updateWidgetProp(list.id, 'jumpPage', '报警详情页');       // 按**页面名**
    const bar = project.addWidget('alarmBar', 20, 10);
    project.updateWidgetField(bar.id, 'w', 430);
    project.updateWidgetProp(bar.id, 'hideWhenNone', false);
    delete bar.props.showIcon; // 模拟旧工程没有「显示图标」字段
    project.updateWidgetProp(bar.id, 'clickJump', target.id);          // 按**页面 id**
    const hist = project.addWidget('alarmHistory', 20, 250);
    project.updateWidgetField(hist.id, 'w', 470);
    project.updateWidgetProp(hist.id, 'jumpPage', '报警详情页');
    project.commit('报警控件扩展测试准备');
    return { list: list.id, bar: bar.id, hist: hist.id, target: target.id, src: src.id, mark: mark.id };
  });
  await sleep(400);

  /* ═══════════ ① 属性：三个控件都有新属性、且没有 hint ═══════════ */
  const propDefs = await page.evaluate(async () => {
    const { registry } = await import('/js/widgets/registry.js');
    const read = (t) => {
      const d = registry.get(t);
      return {
        defaults: { sound: d.defaults.sound, jumpPage: d.defaults.jumpPage, clickJump: d.defaults.clickJump },
        props: (d.props || []).map(p => ({ key: p.key, label: p.label, type: p.type, hint: p.hint })),
      };
    };
    return { list: read('alarmList'), bar: read('alarmBar'), hist: read('alarmHistory') };
  });
  const propOf = (defs, key) => defs.props.find(p => p.key === key);
  ok('alarmList 有「报警声」(check) 与「点行跳转」(text) 两个属性',
    propOf(propDefs.list, 'sound')?.type === 'check' && propOf(propDefs.list, 'jumpPage')?.type === 'text'
    && propDefs.list.defaults.sound === false && propDefs.list.defaults.jumpPage === '',
    JSON.stringify([propOf(propDefs.list, 'sound'), propOf(propDefs.list, 'jumpPage')]));
  ok('alarmBar 有「报警声」(check) 与「点条跳转」clickJump (text) 两个属性',
    propOf(propDefs.bar, 'sound')?.type === 'check' && propOf(propDefs.bar, 'clickJump')?.type === 'text'
    && propDefs.bar.defaults.sound === false && propDefs.bar.defaults.clickJump === '',
    JSON.stringify([propOf(propDefs.bar, 'sound'), propOf(propDefs.bar, 'clickJump')]));
  ok('alarmHistory 有「点行跳转」(text) 属性，默认留空（不跳）',
    propOf(propDefs.hist, 'jumpPage')?.type === 'text' && propDefs.hist.defaults.jumpPage === '',
    JSON.stringify(propOf(propDefs.hist, 'jumpPage')));
  const newKeys = ['sound', 'jumpPage', 'clickJump'];
  const withHint = [
    ...propDefs.list.props, ...propDefs.bar.props, ...propDefs.hist.props,
  ].filter(p => newKeys.includes(p.key) && p.hint !== undefined);
  ok('新属性一律不带 hint（现场要求：属性面板不堆说明文字）', withHint.length === 0,
    JSON.stringify(withHint));

  const propPanel = await page.evaluate(async (ids) => {
    // 属性面板是真 UI：点选每个控件，读面板上画出来的名字
    const cv = await import('/js/editor/canvas.js');
    const read = async (id) => {
      cv.select([id]);
      await new Promise(r => setTimeout(r, 180));
      const body = document.getElementById('propBody');
      const txt = body ? body.textContent.replace(/\s+/g, ' ') : '';
      const labels = [...(body ? body.querySelectorAll('.f-label') : [])].map(x => x.textContent.trim());
      return { txt, labels };
    };
    return { list: await read(ids.list), bar: await read(ids.bar), hist: await read(ids.hist) };
  }, ids);
  ok('当前报警的属性面板上能看到「报警声」「点行跳转」',
    propPanel.list.labels.includes('报警声') && propPanel.list.labels.includes('点行跳转'),
    JSON.stringify(propPanel.list.labels.slice(0, 20)));
  ok('报警条的属性面板上能看到「报警声」「点条跳转」',
    propPanel.bar.labels.includes('报警声') && propPanel.bar.labels.includes('点条跳转'),
    JSON.stringify(propPanel.bar.labels.slice(0, 20)));
  ok('报警历史的属性面板上能看到「点行跳转」',
    propPanel.hist.labels.includes('点行跳转'), JSON.stringify(propPanel.hist.labels.slice(0, 20)));

  await page.evaluate(async (id) => (await import('/js/editor/canvas.js')).select([id]), ids.bar);
  const showIcon = page.locator('#propBody [data-prop="showIcon"]');
  const editBar = page.locator('#canvas .w-alarmbar');
  ok('旧工程默认勾选「显示图标」，编辑画布显示警告图标',
    propPanel.bar.labels.includes('显示图标') && await showIcon.isChecked()
    && await editBar.locator('.ab-ico').isVisible());
  await showIcon.uncheck();
  const iconLayout = await editBar.evaluate(bar => {
    const style = getComputedStyle(bar);
    const view = bar.querySelector('.ab-view');
    const bounds = bar.getBoundingClientRect();
    const scale = bounds.width / bar.offsetWidth;
    return {
      hasIcon: !!bar.querySelector('.ab-ico'),
      leftGap: view.getBoundingClientRect().left - bounds.left - parseFloat(style.paddingLeft) * scale,
    };
  });
  ok('取消勾选后编辑画布即时隐藏图标并让文字补齐空位',
    !iconLayout.hasIcon && Math.abs(iconLayout.leftGap) < 1, JSON.stringify(iconLayout));

  /* ═══════════ ② 运行态：报警声 ═══════════ */
  // 换掉 AudioContext 做 spy：beepAlarm 每次响会 createOscillator ×2（两声短促方波）
  await page.evaluate(() => {
    window.__osc = 0;
    function FakeGain() { this.gain = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
    FakeGain.prototype.connect = function () {};
    function FakeOsc() { this.frequency = { value: 0 }; this.type = ''; window.__osc++; }
    FakeOsc.prototype.connect = function () {};
    FakeOsc.prototype.start = function () {};
    FakeOsc.prototype.stop = function () {};
    function FakeCtx() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    FakeCtx.prototype.resume = function () { return Promise.resolve(); };
    FakeCtx.prototype.createOscillator = function () { return new FakeOsc(); };
    FakeCtx.prototype.createGain = function () { return new FakeGain(); };
    window.AudioContext = FakeCtx;
    window.webkitAudioContext = FakeCtx;
  });
  await page.evaluate(async () => { await (await import('/js/runtime/runtime.js')).enterRun(); });
  await sleep(700);
  const runBar = page.locator('#runtimeRoot .w-alarmbar');
  ok('运行态无报警时显示文字并隐藏勾号',
    await runBar.locator('.ab-copy').textContent() === '无报警' && await runBar.locator('.ab-ico').count() === 0);
  ok('可见的无报警文字也按持续滚动开关播放',
    await runBar.locator('.ab-reel').evaluate(reel => getComputedStyle(reel).animationName === 'ab-ticker'));

  // 1) 还没勾「报警声」→ 触发第一条报警：不响
  await page.evaluate(async () => { window.app.varStore.set('rSpeed', 3120.5, 'remote'); });
  await sleep(700);
  const quiet = await page.evaluate(async () => {
    const A = await import('/js/runtime/alarms.js');
    return { active: A.activeAlarms().length, osc: window.__osc };
  });
  ok('（前提）新报警触发了一条', quiet.active === 1, JSON.stringify(quiet));
  ok('运行态有报警时显示报警文字并隐藏警告图标',
    (await runBar.locator('.ab-copy').textContent()).includes('主轴转速过高')
    && await runBar.locator('.ab-ico').count() === 0);
  ok('没勾「报警声」→ 完全安静（一个音都不放）', quiet.osc === 0, String(quiet.osc));

  // 2) 勾上「报警声」→ 再触发一条新报警：响（2 个振荡器）
  await page.evaluate(async (ids) => {
    const m = await import('/js/core/project.js');
    m.project.updateWidgetProp(ids.list, 'sound', true);
    m.project.updateWidgetProp(ids.bar, 'sound', true);
    m.project.commit('开报警声');
  }, ids);
  await sleep(300);
  await page.evaluate(async () => { window.app.varStore.set('iCount', 6, 'remote'); });
  await sleep(800);
  const beeped = await page.evaluate(async () => {
    const A = await import('/js/runtime/alarms.js');
    return { active: A.activeAlarms().length, osc: window.__osc };
  });
  ok('勾了「报警声」后，新报警触发 → 响了（2 个振荡器 = 两声短促提醒）',
    beeped.active === 2 && beeped.osc === 2, JSON.stringify(beeped));

  // 3) 确认（raised 为空）不该再响
  await page.evaluate(async () => {
    const A = await import('/js/runtime/alarms.js');
    const first = A.activeAlarms()[0];
    A.ackAlarm(first.key);
  });
  await sleep(400);
  const afterAckTone = await page.evaluate(() => window.__osc);
  ok('确认一条报警（没有新报警触发）不会再响一声', afterAckTone === 2, String(afterAckTone));

  /* ═══════════ ③ 点「当前报警」一行 → 跳页 ═══════════ */
  const onPage = (wid, markId) => page.evaluate(([w, mk]) => ({
    here: !!document.querySelector(`#rtPage .wd[data-id="${w}"]`),
    marker: !!document.querySelector(`#rtPage .wd[data-id="${mk}"]`),
    text: (document.getElementById('rtPage')?.textContent || '').includes('详情页标记'),
  }), [wid, markId]);
  const backToSrc = async () => {
    await page.evaluate(async (src) => { await window.app.gotoPage(src); }, ids.src);
    await sleep(450);
  };

  const rowCss = await page.evaluate((ids) => {
    const tr = document.querySelector(`#rtPage .wd[data-id="${ids.list}"] tr[data-alarm]`);
    const htr = document.querySelector(`#rtPage .wd[data-id="${ids.hist}"] tr[data-hist]`);
    return {
      listData: tr ? tr.dataset.alarm : '',
      listCursor: tr ? tr.style.cursor : '',
      histData: htr ? htr.dataset.hist : '',
      histCursor: htr ? htr.style.cursor : '',
    };
  }, ids);
  ok('当前报警的行带 data-alarm（运行态点行有据可查），配了跳转时是手型光标',
    !!rowCss.listData && rowCss.listCursor === 'pointer', JSON.stringify(rowCss));
  ok('报警历史的行带 data-hist，配了跳转时是手型光标',
    !!rowCss.histData && rowCss.histCursor === 'pointer', JSON.stringify({ h: rowCss.histData, c: rowCss.histCursor }));

  await page.locator(`#rtPage .wd[data-id="${ids.list}"] tr[data-alarm]`).first().click();
  await sleep(500);
  const afterListClick = await onPage(ids.list, ids.mark);
  ok('点当前报警一行 → 跳到「报警详情页」（按页面名）',
    afterListClick.marker === true && afterListClick.here === false, JSON.stringify(afterListClick));
  await backToSrc();

  /* ═══════════ ④ 点报警条 → 跳页 ═══════════ */
  await page.locator(`#rtPage .wd[data-id="${ids.bar}"] .w-alarmbar`).first().click();
  await sleep(500);
  const afterBarClick = await onPage(ids.bar, ids.mark);
  ok('点报警条 → 跳到「报警详情页」（按页面 id）',
    afterBarClick.marker === true && afterBarClick.here === false, JSON.stringify(afterBarClick));
  await backToSrc();

  /* ═══════════ ⑤ 点报警历史一行 → 跳页 ═══════════ */
  await page.locator(`#rtPage .wd[data-id="${ids.hist}"] tr[data-hist]`).first().click();
  await sleep(500);
  const afterHistClick = await onPage(ids.hist, ids.mark);
  ok('点报警历史一行 → 跳到「报警详情页」',
    afterHistClick.marker === true && afterHistClick.here === false, JSON.stringify(afterHistClick));
  await backToSrc();

  /* ═══════════ ④b 「点行跳转」留空 → 点行原地不动 ═══════════ */
  await page.evaluate(async (id) => {
    const m = await import('/js/core/project.js');
    m.project.updateWidgetProp(id, 'jumpPage', '');
    m.project.commit('清空跳转');
  }, ids.list);
  await sleep(250);
  await page.locator(`#rtPage .wd[data-id="${ids.list}"] tr[data-alarm]`).first().click();
  await sleep(450);
  const noJump = await page.evaluate((ids) => ({
    here: !!document.querySelector(`#rtPage .wd[data-id="${ids.list}"]`),
    marker: !!document.querySelector(`#rtPage .wd[data-id="${ids.mark}"]`),
  }), ids);
  ok('「点行跳转」留空 → 点行原地不动（不跳页）',
    noJump.here === true && noJump.marker === false, JSON.stringify(noJump));
  await page.evaluate(async (id) => {
    const m = await import('/js/core/project.js');
    m.project.updateWidgetProp(id, 'jumpPage', '报警详情页');
    m.project.commit('恢复跳转');
  }, ids.list);
  await sleep(250);

  /* ═══════════ ⑥ 确认按钮：原有 ack 行为不回归、也不误跳页 ═══════════ */
  const ackedBefore = await page.evaluate(async () => {
    const A = await import('/js/runtime/alarms.js');
    return A.activeAlarms().filter(a => a.acked).length;
  });
  await page.locator(`#rtPage .wd[data-id="${ids.list}"] .al-ack`).first().click();
  await sleep(450);
  const ack = await page.evaluate(async (ids) => {
    const A = await import('/js/runtime/alarms.js');
    const w = await import('/js/core/project.js').then(m => m.project.getWidget(ids.list));
    const rows = [...document.querySelectorAll(`#rtPage .wd[data-id="${ids.list}"] .at-table tbody tr`)];
    return {
      here: !!document.querySelector(`#rtPage .wd[data-id="${ids.list}"]`),
      acked: A.activeAlarms().filter(a => a.acked).length,
      total: A.activeAlarms().length,
      ackedRows: rows.filter(tr => /已确认/.test(tr.textContent)).length,
      nowSound: w ? w.props.sound : null,
    };
  }, ids);
  ok('点「确认」→ 该条 acked（原行为不回归），仍在本页（没有误跳页）',
    ack.acked === ackedBefore + 1 && ack.total === 2 && ack.here === true,
    JSON.stringify({ ...ack, ackedBefore }));
  ok('确认后表格里对应的行显示「已确认」', ack.ackedRows >= 2, String(ack.ackedRows));

  /* ═══════════ ⑦ 翻页 / 清空按钮不会误触发跳页 ═══════════ */
  const clickHist = async (sel) => { await page.locator(`#rtPage .wd[data-id="${ids.hist}"] ${sel}`).first().click(); await sleep(450); };
  await clickHist('[data-alarmday="prev"]');
  const afterPrev = await page.evaluate((ids) => ({
    here: !!document.querySelector(`#rtPage .wd[data-id="${ids.hist}"]`),
    date: (document.querySelector(`#rtPage .wd[data-id="${ids.hist}"] .at-date`) || {}).value,
  }), ids);
  ok('点「前一天 ‹」→ 只是翻页，不跳走（控件还在本页）', afterPrev.here === true, JSON.stringify(afterPrev));
  await clickHist('[data-alarmday="today"]');
  const afterToday = await page.evaluate((ids) => ({
    here: !!document.querySelector(`#rtPage .wd[data-id="${ids.hist}"]`),
    todayOn: !!document.querySelector(`#rtPage .wd[data-id="${ids.hist}"] .at-today.on`),
  }), ids);
  ok('点「今天」→ 回到今天，不跳走', afterToday.here === true && afterToday.todayOn === true, JSON.stringify(afterToday));
  await clickHist('[data-alarmclear]');
  const afterClear = await page.evaluate(async (ids) => {
    const A = await import('/js/runtime/alarms.js');
    return {
      here: !!document.querySelector(`#rtPage .wd[data-id="${ids.hist}"]`),
      history: A.historyOfDay(Date.now()).length,
      empty: (document.querySelector(`#rtPage .wd[data-id="${ids.hist}"] td.alempty`) || {}).textContent || '',
    };
  }, ids);
  ok('点「清空记录」→ 历史清了、不跳走，表格显示空占位',
    afterClear.here === true && afterClear.history === 0 && /没有报警记录/.test(afterClear.empty),
    JSON.stringify(afterClear));

  /* 从实际报警弹窗新增自定义级别，三个控件各自选级别。 */
  await page.evaluate(async id => {
    (await import('/js/runtime/runtime.js')).exitRun();
    window.app.project.updateWidgetProp(id, 'hideWhenNone', true);
  }, ids.bar);
  await page.click('.lp-tab[data-panel="alarms"]');
  await page.click('#btnAddAlarm');
  await page.fill('#alName', '换刀报警');
  await page.fill('#alValue', '2500');
  await page.fill('#alarmTextArea', '换刀提醒专用');
  await page.selectOption('#alLevel', { label: '＋ 新增级别…' });
  const inline = page.locator('#alarmLevelInline');
  await inline.locator('[data-level-name]').fill('警告');
  await page.click('#btnUseAlarmLevel');
  ok('报警弹窗拒绝与内置级别重名', (await page.textContent('#alarmLevelInlineError')) === '级别名称已存在');
  await inline.locator('[data-level-name]').fill('维护提醒');
  await inline.locator('[data-level-color]').fill('#7c3aed');
  await inline.locator('[data-level-rank]').selectOption('1');
  await page.click('#btnUseAlarmLevel');
  const customId = await page.inputValue('#alLevel');
  ok('新增级别自动选中，报警内容和阈值继续保留',
    customId.startsWith('alv_') && await page.inputValue('#alValue') === '2500'
    && await page.inputValue('#alarmTextArea') === '换刀提醒专用');
  await page.click('#dlgOk');
  await page.locator('#dlgMask').waitFor({ state: 'hidden' });

  const setDisplayLevels = async (id, labels) => {
    await page.evaluate(async id => (await import('/js/editor/canvas.js')).select([id]), id);
    const picker = page.locator('#propBody .alarm-level-picker');
    await picker.locator('summary').click();
    await picker.getByRole('button', { name: '清空', exact: true }).click();
    for (const name of labels) await picker.getByRole('checkbox', { name, exact: true }).check();
  };
  await setDisplayLevels(ids.list, ['维护提醒', '紧急']);
  await setDisplayLevels(ids.hist, ['警告']);
  await setDisplayLevels(ids.bar, ['报警']);
  const reloaded = await page.evaluate(async ({ ids, customId }) => {
    const { project } = await import('/js/core/project.js');
    const { collectEntries } = await import('/js/core/i18n.js');
    const { alarmsToCsv } = await import('/js/core/csv.js');
    const { alarmLevels } = await import('/js/runtime/alarms.js');
    project.addAlarm({ name: '急停测试', variable: 'rSpeed', op: '>=', value: 3100, level: 'urgent', text: '急停测试专用' });
    project.replaceData(JSON.parse(JSON.stringify(project.data)));
    project.setCurrentPage(ids.src);
    const filters = [ids.list, ids.hist, ids.bar].map(id => project.getWidget(id).props.levelFilter);
    return {
      filters,
      showIcon: project.getWidget(ids.bar).props.showIcon,
      level: project.customAlarmLevels().find(l => l.v === customId),
      rule: project.alarms().find(a => a.name === '换刀报警')?.level,
      translation: collectEntries().some(e => e.source === '维护提醒'),
      csv: alarmsToCsv(project.alarms(), alarmLevels()).includes(',维护提醒,'),
    };
  }, { ids, customId });
  ok('工程重载保留级别、报警规则和三个控件的独立筛选',
    reloaded.level?.rank === 1 && reloaded.level?.color === '#7c3aed' && reloaded.rule === customId
    && JSON.stringify(reloaded.filters) === JSON.stringify([['urgent', customId], ['warn'], ['alarm']])
    && reloaded.translation && reloaded.csv, JSON.stringify(reloaded));
  ok('工程重载保留报警条的图标隐藏设置', reloaded.showIcon === false);

  await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
  await page.evaluate(async () => {
    const { evalAlarms } = await import('/js/runtime/alarms.js');
    window.app.varStore.set('rSpeed', 3120.5, 'remote');
    window.app.varStore.set('iCount', 6, 'remote');
    evalAlarms();
  });
  await page.locator(`#rtPage .wd[data-id="${ids.list}"] tr[data-alarm]`).first().waitFor({ state: 'visible' });
  const visible = await page.evaluate(async ids => {
    const { registry } = await import('/js/widgets/registry.js');
    const { project } = await import('/js/core/project.js');
    const { activeAlarms, historyOfDay } = await import('/js/runtime/alarms.js');
    const body = id => document.querySelector(`#rtPage .wd[data-id="${id}"]`);
    const bar = project.getWidget(ids.bar);
    const drawBar = levelFilter => registry.get('alarmBar').render({ ...bar, props: { ...bar.props, levelFilter } }, 'run');
    return {
      list: Array.from(body(ids.list).querySelectorAll('tr[data-alarm]'), row => row.textContent.trim()),
      hist: Array.from(body(ids.hist).querySelectorAll('tr[data-hist]'), row => row.textContent.trim()),
      count: body(ids.hist).querySelector('.at-count').textContent,
      bar: body(ids.bar).querySelector('.ab-copy')?.textContent,
      legacy: drawBar('warn').includes('急停测试专用') && drawBar('warn').includes('换刀提醒专用'),
      hiddenWithNoLevels: drawBar([]) === '',
      total: [activeAlarms().length, historyOfDay(Date.now()).length],
    };
  }, ids);
  ok('运行态支持跳级多选，三个控件分别筛选，历史计数正确且全部记录仍保留',
    visible.list.length === 2 && visible.list.some(r => r.includes('维护提醒') && r.includes('换刀提醒专用'))
    && visible.list.some(r => r.includes('急停测试专用'))
    && visible.hist.length === 1 && visible.hist[0].includes('加工计数到') && visible.count === '1 条'
    && visible.bar?.includes('主轴转速过高') && !visible.bar.includes('急停测试专用')
    && visible.legacy && visible.hiddenWithNoLevels && visible.total.every(n => n === 4), JSON.stringify(visible));

  ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 报警控件扩展（声光/跳转）：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
