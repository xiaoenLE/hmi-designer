// verify-project.mjs — 工程管理（工程名 / 新建 / 打开 / 保存 / 另存为 / 服务器）+ 按钮动作变量不被清
//   1) 切换按钮动作模式（点动→切换→置值）不能把变量清掉；「变量与显示的变量一致」勾选后跟着显示变量走
//   2) 「保存」写回同一个文件（File System Access API），只有「另存为」才另选文件；存完要弹窗说清存哪了
//   3) 工程名、新建（空白/演示）、打开 .LE（老 .json 也认）、坏文件不破坏当前工程、换工程前自动备份 + 能恢复
//   4) PLC 配置跟着工程走：连 PLC 记进工程、保存弹窗里能看到、打开带配置的工程会问要不要按它连
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const results = [];
const ok = (n, c, e = '') => {
  results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
await installPageShim(page);
const pageErrors = [];
const dialogs = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
// 系统「保存/打开」文件对话框在无头浏览器里点不了 → 用桩句柄替掉（逻辑照跑：写回同一个文件、另存为换文件）
// 第 5 节会把 stub 删掉模拟"浏览器不支持"，之后要能装回来，所以写成一段可复用的脚本
const PICKER_STUB = `
  window.__files = window.__files || [];        // 每次真正写入的文件内容
  window.__picks = window.__picks || [];        // 每次弹「另存为」时建议的文件名
  window.__nextName = window.__nextName || null; // 让下一次保存用这个名字（模拟用户改文件名）
  const mk = (name) => ({
    name,
    async createWritable() {
      return { async write(t) { window.__files.push({ name, text: t }); }, async close() {} };
    },
    async queryPermission() { return 'granted'; },
  });
  window.showSaveFilePicker = async (opts) => {
    window.__picks.push(opts?.suggestedName || '');
    const n = window.__nextName || opts?.suggestedName || 'untitled.LE';
    window.__nextName = null;
    return mk(n);
  };
`;
await page.addInitScript({ content: PICKER_STUB });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);

/** 关掉可能开着的应用内对话框 */
const closeDlg = async () => {
  await page.evaluate(() => document.getElementById('dlgOk')?.click());
  await sleep(150);
};
const dlgText = () => page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  body: document.getElementById('dlgBody').textContent.replace(/\s+/g, ' '),
}));
/** 工具栏 ▾ 菜单：按条目文字点 */
const menuClick = async (label) => {
  await page.click('#btnProjMenu');
  await sleep(200);
  const hit = await page.evaluate((l) => {
    const items = [...document.querySelectorAll('#ctxMenu .ctx-item')];
    const b = items.find(el => el.querySelector('.ctx-label')?.textContent === l)
      || items.find(el => (el.querySelector('.ctx-label')?.textContent || '').startsWith(l));
    if (!b) return [...document.querySelectorAll('#ctxMenu .ctx-label')].map(e => e.textContent);
    b.click();
    return true;
  }, label);
  if (hit !== true) throw new Error(`菜单里没有「${label}」，现有：${JSON.stringify(hit)}`);
  await sleep(400);
};
/** 「保存」：工具栏上那个按钮**去掉了**（现场要求），现在走 ▾ 菜单里的「保存」（= Ctrl+S 同一条路） */
const clickSave = async () => {
  await page.click('#btnProjMenu');
  await sleep(200);
  const hit = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#ctxMenu .ctx-item')]
      .find(x => x.querySelector('.ctx-label')?.textContent === '保存');
    if (!b) return false;
    b.click();
    return true;
  });
  if (hit !== true) throw new Error('▾ 菜单里没有「保存」这一项');
};

/* ══════ 菜单本身 ══════ */
await page.click('#btnProjMenu');
await sleep(250);
const menuItems = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-label')].map(e => e.textContent));
await page.keyboard.press('Escape');
await sleep(150);
ok('工具栏「工程 ▾」是一个下拉菜单，六件事都在里面（不再是排一长排按钮）',
  menuItems.includes('新建工程…') && menuItems.some(t => t.startsWith('打开工程')) && menuItems.includes('保存')
  && menuItems.some(t => t.startsWith('另存为')) && menuItems.includes('存到服务器') && menuItems.some(t => t.startsWith('从服务器读取')),
  JSON.stringify(menuItems));
ok('工具栏上**不摆**「保存」按钮了（现场要求：那个位置太挤），保存走 ▾ 菜单 / Ctrl+S',
  !(await page.$('#btnSave')) && !!(await page.$('#btnProjMenu'))
  && !(await page.$('#btnNew')) && !(await page.$('#btnExport')), '');

/* ══════ 1. 按钮动作：切换模式不清变量 + 「和显示变量一致」 ══════ */
const wid = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const cv = await import('/js/editor/canvas.js');
  const p = m.project.currentPage();
  p.widgets.length = 0;
  const w = m.project.addWidget('button', 60, 60);
  m.project.updateWidgetField(w.id, 'bindings.variable', 'bRunStatus');   // 显示变量
  m.project.updateWidgetActions(w.id, [
    { trigger: 'click', type: 'tap', params: { variable: 'iCount' } },     // 动作变量（故意不同）
  ]);
  m.project.commit('准备按钮');
  cv.select([w.id]);
  return w.id;
});
await sleep(400);

const acts = () => page.evaluate(id => (window.app.project.getWidget(id)?.actions || [])
  .map(a => ({ type: a.type, v: a.params?.variable ?? null })), wid);
const switchTo = async (type) => {
  await page.evaluate((t) => {
    const sel = document.querySelector('#actList .act-item [data-atype]');
    sel.value = t;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, type);
  await sleep(250);
};
await switchTo('toggle');
let a = await acts();
ok('点动 → 切换：动作变量还在（不被清成空）', a[0].type === 'toggle' && a[0].v === 'iCount', JSON.stringify(a));
await switchTo('setValue');
a = await acts();
ok('切换 → 置变量值：变量还是原来那个', a[0].type === 'setValue' && a[0].v === 'iCount', JSON.stringify(a));
await switchTo('tap');
a = await acts();
ok('切回点动：变量一路没丢', a[0].type === 'tap' && a[0].v === 'iCount', JSON.stringify(a));
await switchTo('gotoPage');
a = await acts();
ok('切到「跳转页面」：动作里没有变量参数了（这一类型用不上）', a[0].type === 'gotoPage' && !a[0].v, JSON.stringify(a));
await switchTo('tap');
a = await acts();
ok('再切回点动：没配变量时默认跟「状态显示」的变量同源', a[0].type === 'tap' && a[0].v === 'bRunStatus', JSON.stringify(a));

const hasFollowBox = await page.evaluate(() => !!document.getElementById('actFollow'));
ok('按钮属性里有「变量与「状态显示」的变量一致」勾选框', hasFollowBox === true);
await page.evaluate(() => {
  const el = document.getElementById('actFollow');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(300);
a = await acts();
const dis = await page.evaluate(() => document.querySelector('#actList .act-item [data-ap="variable"]')?.readOnly);
ok('勾上 → 动作变量跟着显示变量，且那一格变成只读（改一处即可）',
  a[0].v === 'bRunStatus' && dis === true, JSON.stringify({ a, dis }));
await page.evaluate(() => {
  const sel = document.querySelector('#propBody [data-bind="variable"]');
  sel.value = 'rSpeed';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(350);
a = await acts();
ok('改「状态显示」变量 → 动作变量跟着变（rSpeed）', a[0].v === 'rSpeed', JSON.stringify(a));
await page.evaluate(() => {
  const el = document.getElementById('actFollow');
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(300);

const wid2 = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const cv = await import('/js/editor/canvas.js');
  const w = m.project.addWidget('button', 300, 300);
  m.project.updateWidgetField(w.id, 'bindings.variable', '');
  m.project.updateWidgetActions(w.id, [{ trigger: 'click', type: 'tap', params: { variable: 'iCount' } }]);
  m.project.commit('造一个没绑显示变量的按钮');
  cv.select([w.id]);
  return w.id;
});
await sleep(450);
await page.evaluate(() => {
  const el = document.getElementById('actFollow');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(350);
const noBind = await page.evaluate(id => ({
  v: window.app.project.getWidget(id)?.actions?.[0]?.params?.variable,
  dis: document.querySelector('#actList .act-item [data-ap="variable"]')?.readOnly,
  tip: document.querySelector('.act-follow-tip')?.textContent || '',
}), wid2);
ok('没选显示变量时勾上：动作变量保持不动（不被清空）+ 那一格不锁死 + 明确提示下一步',
  noBind.v === 'iCount' && noBind.dis === false && /还没选显示变量/.test(noBind.tip), JSON.stringify(noBind));

/* ══════ 2. 工程名 ══════ */
await page.fill('#projName', '切割机-上位机');
await page.evaluate(() => document.getElementById('projName').dispatchEvent(new Event('change', { bubbles: true })));
await sleep(250);
const renamed = await page.evaluate(() => ({ name: window.app.project.data.meta.name, title: document.title }));
ok('改工具栏工程名 → 写进工程 + 浏览器标签也跟着变',
  renamed.name === '切割机-上位机' && /切割机-上位机/.test(renamed.title), JSON.stringify(renamed));

/* ══════ 3. 保存：写回同一个文件 + 弹窗提示 ══════ */
await clickSave();
await sleep(500);
const saveDlg = await dlgText();
ok('第一次「保存」先问你存哪（系统另存为，建议文件名带工程名与日期）',
  (await page.evaluate(() => window.__picks)).length === 1
  && /^切割机-上位机-\d{8}\.LE$/.test(await page.evaluate(() => window.__picks[0])),
  JSON.stringify(await page.evaluate(() => window.__picks)));
ok('存完弹窗提示：文件名 + 位置 + 内容 + 时间',
  saveDlg.open && saveDlg.title === '已保存工程'
  && /切割机-上位机-\d{8}\.LE/.test(saveDlg.body) && /个页面/.test(saveDlg.body) && /时间/.test(saveDlg.body),
  saveDlg.body.slice(0, 120));
ok('弹窗里说明这份工程带没带 PLC 配置',
  /PLC/.test(saveDlg.body), saveDlg.body.match(/PLC[^时]*/)?.[0]?.slice(0, 80));
await closeDlg();
const saved1 = await page.evaluate(() => ({ files: window.__files, picks: window.__picks.length }));
const savedJson = JSON.parse(saved1.files[0].text);
ok('写出来的就是当前工程（工程名/页面/变量都在）',
  savedJson.meta.name === '切割机-上位机' && savedJson.pages.length === (await page.evaluate(() => window.app.project.pages().length)),
  JSON.stringify({ name: savedJson.meta.name, pages: savedJson.pages.length }));

// 改点东西再存一次 → 必须写回**同一个文件**，且**不再弹窗**（用户要求：只有第一次提示）
await page.evaluate(() => {
  const m = window.app.project;
  m.addWidget('lamp', 500, 400);
  m.commit('加个灯');
});
await sleep(1200);      // ⚠ 先让"自动保存"（800ms 防抖）那一拍过去：它会往状态栏写「已自动保存…」，
                        //    把手工保存那句盖掉（保存现在走 ▾ 菜单，多花两百毫秒，正好撞上这一拍）
await clickSave();
await sleep(400);
const saveDlg2 = await dlgText();
const s2 = await page.evaluate(() => ({ files: window.__files, picks: window.__picks.length }));
ok('再点「保存」：写回同一个文件（没有再弹选择框）',
  s2.picks === saved1.picks && s2.files.length === 2 && s2.files[1].name === s2.files[0].name,
  JSON.stringify({ picks: s2.picks, names: s2.files.map(f => f.name) }));
ok('第二次保存不再弹窗（直接存进文件）', saveDlg2.open === false, saveDlg2.title);
ok('但要给一行状态栏反馈：存到哪个文件 + 时间',
  /已保存：切割机-上位机-\d{8}\.LE（\d\d:\d\d:\d\d）/.test(await page.textContent('#stSave')),
  await page.textContent('#stSave'));
ok('第二次写入的内容是改过之后的（新控件在里面）',
  JSON.parse(s2.files[1].text).pages[0].widgets.length > JSON.parse(s2.files[0].text).pages[0].widgets.length,
  `${JSON.parse(s2.files[0].text).pages[0].widgets.length} → ${JSON.parse(s2.files[1].text).pages[0].widgets.length}`);
await closeDlg();

/* ══════ 4. 另存为：换一个文件 ══════ */
await page.evaluate(() => { window.__nextName = '切割机-上位机-v2.json'; });   // 老后缀：另存为照样能写 .json
await menuClick('另存为');
const asDlg = await dlgText();
const s3 = await page.evaluate(() => ({ files: window.__files, picks: window.__picks }));
ok('「另存为」才另选文件（建议名可改，写到新名字上）',
  s3.picks.length === saved1.picks + 1 && s3.files[2].name === '切割机-上位机-v2.json',
  JSON.stringify(s3.files.map(f => f.name)));
ok('另存为的提示标题是「已另存为」', asDlg.title === '已另存为', asDlg.title);
await closeDlg();
// 之后的「保存」写的是新文件
await clickSave();
await sleep(400);
await closeDlg();
const s4 = await page.evaluate(() => window.__files.map(f => f.name));
ok('另存为之后，「保存」跟着写到新文件上',
  s4[3] === '切割机-上位机-v2.json', JSON.stringify(s4));

/* ══════ 5. 不支持覆盖的浏览器：退回下载，并说清楚（这件事只说一次） ══════ */
await page.evaluate(async () => {
  const st = (await import('/js/core/storage.js')).storage;
  st.forgetFile();                       // 忘掉句柄，模拟"没有当前文件"
  delete window.showSaveFilePicker;      // 模拟 Firefox / 局域网 IP 访问
});
const [dl] = await Promise.all([page.waitForEvent('download'), clickSave()]);
await sleep(400);
const dlDlg = await dlgText();
ok('拿不到文件权限时退回「下载一份」，文件名是 工程名.LE（不再带日期，方便手动覆盖同名文件）',
  dl.suggestedFilename() === '切割机-上位机.LE', dl.suggestedFilename());
ok('这种情况弹窗里明确说明是下载、以及怎么才能做到「保存=覆盖同一个文件」',
  /下载/.test(dlDlg.body) && /127\.0\.0\.1/.test(dlDlg.body), dlDlg.body.slice(0, 140));
await closeDlg();
// 再说一次就不弹了（只在第一次解释）
const [dl2] = await Promise.all([page.waitForEvent('download'), clickSave()]);
await sleep(400);
ok('这种浏览器下，第二次保存也不再弹窗（只状态栏提示）',
  (await dlgText()).open === false && /已保存：/.test(await page.textContent('#stSave')),
  `${dl2.suggestedFilename()} / ${await page.textContent('#stSave')}`);

/* ══════ 6. PLC 配置跟着工程走 ══════ */
// 上一步把文件选择器删掉了（模拟不支持的浏览器）→ 这里装回来，继续测"保存/另存为"的正常路径
await page.evaluate(PICKER_STUB);
await page.evaluate(async () => {
  const b = await import('/js/api/backend.js');
  b.backend.connectPlc = async () => ({ ok: true, status: { vars: 6, poll_ms: 20, word_order: 'cdab', bad_address: [] } });
  b.backend.getPlc = async () => ({
    config: { ip: '127.0.0.1', port: 502, unit: 1, poll_ms: 20, word_order: 'cdab' },
    status: { mode: 'plc', online: true, host: '127.0.0.1', port: 502, vars: 6, word_order: 'cdab' },
  });
  const t = await import('/js/editor/toolbar.js');
  t.openPlcDialog();
});
await sleep(400);
ok('PLC 对话框打开（连一次就会把配置记进工程）', (await dlgText()).title.includes('PLC'));
await page.fill('#plcIp', '192.168.1.10');
await page.fill('#plcPort', '502');
await page.selectOption('#plcOrder', 'abcd');
await page.click('#dlgOk');
await sleep(700);
const plcRec = await page.evaluate(() => window.app.project.data.meta.plc);
ok('连上 PLC 后，配置记进工程（保存/导出就能一起带走）',
  plcRec?.ip === '192.168.1.10' && plcRec?.word_order === 'abcd', JSON.stringify(plcRec));
// 静默保存也会把 PLC 配置写进文件（上一节把文件句柄忘了，所以这次会重新问一次存哪 → 顺手关掉提示）
await clickSave();
await sleep(500);
await closeDlg();
const writtenPlc = await page.evaluate(() => JSON.parse(window.__files[window.__files.length - 1].text).meta.plc);
ok('静默保存时 PLC 配置也一起写进文件了', writtenPlc?.ip === '192.168.1.10', JSON.stringify(writtenPlc));
// 「另存为」的弹窗里能看见这份配置
await page.evaluate(() => { window.__nextName = '带PLC配置.json'; });        // 同上：老后缀照样支持
await menuClick('另存为');
await sleep(300);
const plcDlg = await dlgText();
ok('「另存为」弹窗里能看见 PLC 配置也存进去了',
  /192\.168\.1\.10:502/.test(plcDlg.body) && /ABCD/.test(plcDlg.body), plcDlg.body.match(/PLC[^时]*/)?.[0]?.slice(0, 90));
await closeDlg();

/* ══════ 7. 打开带 PLC 配置的工程：问一句要不要按它连 ══════ */
dialogs.length = 0;
const otherProj = {
  meta: {
    name: '别人的工程', canvas: { w: 800, h: 480, bg: '#ffffff' },
    plc: { ip: '10.0.0.5', port: 503, unit: 2, poll_ms: 100, word_order: 'dcba' },
  },
  variables: [{ name: 'x', type: 'int', address: '%MW10', value: 3 }],
  pages: [{ id: 'pgX', name: '唯一页', type: 'page', widgets: [] }],
  alarms: [{ id: 'alX', name: '测试报警', variable: 'x', op: '>', value: 1, level: 'warn', text: 'x 超了', enabled: true }],
};
await page.setInputFiles('#fileImport', {
  name: '别人的工程.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(otherProj), 'utf8'),
});
await sleep(1200);
const opened = await page.evaluate(() => ({
  name: window.app.project.data.meta.name,
  pages: window.app.project.pages().map(p => p.name),
  vars: window.app.project.variables().map(v => v.name),
  alarms: window.app.project.alarms().length,
  nameInput: document.getElementById('projName').value,
  plc: window.app.project.data.meta.plc,
  backup: (() => { try { return JSON.parse(localStorage.getItem('hmi-designer-prev-project-v1'))?.meta?.name || ''; } catch { return ''; } })(),
}));
ok('打开 json：工程被整份替换（页面/变量/报警/PLC 配置都按文件来）',
  opened.name === '别人的工程' && JSON.stringify(opened.pages) === JSON.stringify(['唯一页'])
  && JSON.stringify(opened.vars) === JSON.stringify(['x']) && opened.alarms === 1
  && opened.plc?.ip === '10.0.0.5', JSON.stringify(opened));
ok('工程里带 PLC 配置时，会问一句要不要按它连（不静默改设备）',
  dialogs.some(m => /这份工程里带着 PLC 配置/.test(m) && /10\.0\.0\.5:503/.test(m)),
  dialogs.find(m => /PLC 配置/.test(m))?.split('\n')[0] || '');
ok('确认后按工程里的配置连上了（并提示连的是哪台）',
  dialogs.some(m => /已按工程里的配置连接/.test(m) && /10\.0\.0\.5/.test(m)),
  dialogs.find(m => /已按工程里的配置连接/.test(m))?.split('\n')[0] || '');
ok('打开前的工程也备份了（能恢复）', opened.backup === '切割机-上位机', opened.backup);

const curBefore = await page.evaluate(() => window.app.project.data.meta.name);
await page.setInputFiles('#fileImport', {
  name: '坏文件.json', mimeType: 'application/json', buffer: Buffer.from('{ 这不是 json', 'utf8'),
});
await sleep(800);
ok('打开坏文件只报错，不会把当前工程弄没',
  (await page.evaluate(() => window.app.project.data.meta.name)) === curBefore,
  String(curBefore));

/* ══════ 8. 新建工程（菜单）+ 备份 + 恢复 ══════ */
const before = await page.evaluate(() => ({
  name: window.app.project.data.meta.name,
  pages: window.app.project.pages().length,
  vars: window.app.project.variables().length,
}));
await menuClick('新建工程');
const dlg = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  kinds: [...document.querySelectorAll('input[name="newKind"]')].map(i => i.value),
}));
ok('「新建工程…」开对话框（空白 / 演示 二选一 + 说明会替换当前工程）',
  dlg.open && /新建工程/.test(dlg.title) && JSON.stringify(dlg.kinds) === JSON.stringify(['blank', 'demo']),
  JSON.stringify(dlg));
await page.click('#dlgOk');
await sleep(500);
const blank = await page.evaluate(() => ({
  name: window.app.project.data.meta.name,
  pages: window.app.project.pages().length,
  vars: window.app.project.variables().length,
  canvasWidgets: document.querySelectorAll('#canvas .wd').length,
  nameInput: document.getElementById('projName').value,
  backup: (() => { try { return JSON.parse(localStorage.getItem('hmi-designer-prev-project-v1'))?.meta?.name || ''; } catch { return ''; } })(),
}));
ok('空白工程：1 个空白页 + 变量表空的 + 画布上没控件',
  blank.pages === 1 && blank.vars === 0 && blank.canvasWidgets === 0, JSON.stringify(blank));
ok('新建后工具栏工程名换成「新建工程」，且上一个工程已备份',
  blank.nameInput === '新建工程' && blank.backup === before.name, JSON.stringify(blank));

await menuClick('恢复上一个工程');
await sleep(700);
const restored = await page.evaluate(() => ({
  name: window.app.project.data.meta.name,
  pages: window.app.project.pages().length,
  vars: window.app.project.variables().length,
}));
ok('「恢复上一个工程」（菜单里）把替换掉的那份找回来',
  restored.name === before.name && restored.pages === before.pages && restored.vars === before.vars,
  JSON.stringify({ before, restored }));

/* ══════ 9. 演示工程 ══════ */
await menuClick('新建工程');
await sleep(150);
await page.evaluate(() => { document.querySelector('input[name="newKind"][value="demo"]').checked = true; });
await page.click('#dlgOk');
await sleep(700);
const demo = await page.evaluate(() => ({
  name: window.app.project.data.meta.name,
  vars: window.app.project.variables().length,
  pages: window.app.project.pages().length,
  widgets: document.querySelectorAll('#canvas .wd').length,
  markers: { template: window.app.project.data.meta.template, seedVersion: window.app.project.data.meta.seedVersion },
}));
ok('「带示例的演示工程」：内置模板真的装进来了（多页 + 成规模的变量与控件，不是空壳）',
  demo.pages >= 5 && demo.vars >= 20 && demo.widgets > 10
  && demo.markers.template === 'demo' && demo.markers.seedVersion >= 3,
  JSON.stringify(demo));

/* ══════ 9.5 「自动保存存在哪」：状态栏那行能点开 ══════ */
const autoInfo = await page.evaluate(async () => (await import('/js/core/storage.js')).storage.saveInfo());
ok('saveInfo 报的是浏览器本地那份（键名 / 站点 / 体积都对得上）',
  autoInfo.key === 'hmi-designer-project-v1' && autoInfo.origin === `http://127.0.0.1:${PORT}`
  && autoInfo.bytes > 0 && autoInfo.limitMb === 5,
  JSON.stringify({ key: autoInfo.key, origin: autoInfo.origin, mb: autoInfo.mb }));
await page.click('#stSave');
await sleep(300);
const saveInfoDlg = await dlgText();
ok('点状态栏「已自动保存…」→ 弹出「存在哪」的说明（站点 + 键名 + 上限 + 只属于这个浏览器）',
  saveInfoDlg.open && saveInfoDlg.title === '自动保存存在哪？'
  && saveInfoDlg.body.includes(`http://127.0.0.1:${PORT}`) && /hmi-designer-project-v1/.test(saveInfoDlg.body)
  && /5 MB/.test(saveInfoDlg.body) && /换浏览器/.test(saveInfoDlg.body),
  saveInfoDlg.body.slice(0, 140));
await closeDlg();
await page.click('#btnProjMenu');
await sleep(200);
const hasAutoItem = await page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-label')].map(e => e.textContent).includes('自动保存存在哪？'));
await page.keyboard.press('Escape');
await sleep(150);
ok('「工程 ▾」菜单里不再有「自动保存存在哪？」这条（说明看状态栏那句点开就行）', hasAutoItem === false);

/* ══════ 10. 存服务器 / 读服务器（和「保存文件」不是一回事）
     ⚠ 这一节会**写服务器上的存档**，所以只在隔离实例（端口不是 8866）上跑 */
if (PORT === '8866') {
  console.log('SKIP  「存到服务器/从服务器读取」用例已跳过：这次跑在 8866 上，写了会覆盖你自己的服务器存档');
} else {
  await page.evaluate(async () => {
    const m = await import('/js/core/project.js');
    m.project.data.meta.name = '服务器存档测试';
    m.project.commit('改个能认出来的名字');
  });
  await sleep(250);
  await menuClick('存到服务器');
  await sleep(700);
  const savedMsg = dialogs.filter(m => /已存到服务器/.test(m)).pop() || '';
  ok('「存到服务器」存的是服务器上的 hmi_project.LE（提示里写清位置 + 只有一个槽位会覆盖）',
    /server\/data\/hmi_project\.LE/.test(savedMsg) && /就这一个槽位/.test(savedMsg), savedMsg.split('\n')[0]);
  const onServer = await page.evaluate(async () => (await (await fetch('/api/project')).json()).data?.meta?.name || '');
  ok('服务器上那份内容 = 当前工程', onServer === '服务器存档测试', onServer);

  await page.evaluate(async () => {
    const m = await import('/js/core/project.js');
    m.project.newProject('blank');
    m.project.data.meta.name = '本地另起的工程';
    m.project.commit('换个工程');
  });
  await sleep(400);
  await menuClick('从服务器读取');
  await sleep(900);
  const readBack = await page.evaluate(() => ({
    name: window.app.project.data.meta.name,
    input: document.getElementById('projName').value,
  }));
  ok('「从服务器读取」把服务器那份读回来、替换掉本地这份（工具栏名字也跟着换）',
    readBack.name === '服务器存档测试' && readBack.input === '服务器存档测试', JSON.stringify(readBack));
  ok('读之前先确认、并说明那份在哪（不是静默覆盖）',
    dialogs.some(m => /hmi_project\.LE/.test(m)), dialogs.filter(m => /hmi_project/.test(m)).pop()?.split('\n')[0] || '');
}

ok('全程没有未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 工程管理回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
