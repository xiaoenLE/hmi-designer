// verify-runtime-chrome.mjs — 运行界面（干净 + 组合键快捷键 + 三档缩放 + 提示条 + 导入改设备名 + 连接确认）
//   ① 运行主页面**一个按钮都不摆**（退出/适应窗口/PLC 设置全收起），键位靠一条自动收起的提示 + 右键菜单；
//      内部变量（内存模拟）运行时左下角常显提示；变量监控进运行态整个收起
//   ② 快捷键一律两个键一起按（Ctrl+Shift+字母），单字母不再生效 —— 防误触
//      Ctrl+Shift+E 退出 · Ctrl+Shift+L PLC 设置 · Ctrl+Shift+V 变量监控 · Ctrl+Shift+Z 缩放
//   ③ 画面三档缩放：原始 1:1 / 适应窗口 / 填满窗口，选中的记进 localStorage
//   ④ 写 PLC 失败 → 运行页面挂琥珀色「下发失败（变量）」提示条，6 秒自动收起
//   ⑤ 「从 OPC UA 导入」里改设备名 → NodeId 立刻按新设备名重算且保留勾选（不用重选文件）
//   ⑥ 点「确定」前必须真连上：连不上 → 报「连接没有成功」、对话框不关、不写进工程配置
// 用法：先启动新版后端，再 node test/verify-runtime-chrome.mjs [端口]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const out = [];
const ok = (n, c, e = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const UA = await freePort(), WEB = await freePort();
const sim = spawn(PY, ['server/opcua_sim.py', '--port', String(UA), '--web-port', String(WEB), '--no-browser'], { cwd: ROOT, stdio: 'ignore' });
for (let i = 0; i < 40; i++) { await sleep(400); try { await fetch(`http://127.0.0.1:${WEB}/api/state`); break; } catch { /* 等 */ } }

const PORT = process.argv[2] || '8866';
const H = 'http://127.0.0.1:' + PORT;

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('dialog', d => d.accept());
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.goto(H + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

const enterRun = () => page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
const rt = (fn) => page.evaluate(async (src) => {
  const m = await import('/js/runtime/runtime.js');
  return (0, eval)(`(${src})`)(m);           // eslint-disable-line no-eval
}, fn.toString());
const geo = () => page.evaluate(() => {
  const c = window.app.project.data.meta.canvas;
  const r = document.getElementById('rtPage').getBoundingClientRect();
  return { cw: c.w, ch: c.h, rw: r.width, rh: r.height, x: r.x, y: r.y, vw: innerWidth, vh: innerHeight };
});

/* ── 1. 运行界面：一个按钮都不摆 ── */
await enterRun();
await sleep(1200);
const ui = await page.evaluate(() => {
  const vis = (id) => {
    const el = document.getElementById(id);
    if (!el) return 'missing';
    // ⚠ 「看得见吗」不能只看自己的 computed display（父节点 display:none 时子元素还是 inline-block），
    //   也不能用 offsetParent（position:fixed 的元素 offsetParent 恒为 null）——
    //   按「有没有布局盒子」判：自己或祖先 display:none 时 getClientRects() 就是空的
    const r = el.getBoundingClientRect();
    return (el.getClientRects().length > 0 && r.width > 0 && r.height > 0) ? 'shown' : 'hidden';
  };
  const panel = document.getElementById('rtVarsPanel');
  return {
    exit: vis('rtExit'), fit: vis('rtFit'), bar: vis('rtBar'), plc: vis('rtPlcBtn'),
    panel: vis('rtVarsPanel'), panelHidden: panel.classList.contains('rt-hidden'),
    internal: vis('rtInternalTip'), internalText: document.getElementById('rtInternalTip')?.textContent,
    hint: vis('rtHint'), hintText: document.getElementById('rtHint')?.textContent,
  };
});
ok('运行主页面不摆按钮（退出 / 适应窗口 / PLC 设置 / 工具条全部收起）',
  ui.exit === 'hidden' && ui.fit === 'hidden' && ui.bar === 'hidden' && ui.plc === 'hidden',
  JSON.stringify([ui.exit, ui.fit, ui.bar, ui.plc]));
ok('变量监控进运行态整个收起（右上角也不留东西）', ui.panelHidden === true && ui.panel === 'hidden',
  JSON.stringify([ui.panel, ui.panelHidden]));
ok('内部变量运行时左下角常显提示', ui.internal === 'shown' && /内部变量运行中/.test(ui.internalText || ''), ui.internalText);
ok('进运行态飘一条快捷键说明（四个组合键都写到）',
  ui.hint === 'shown' && /退出运行/.test(ui.hintText || '') && /PLC 连接设置/.test(ui.hintText || '')
  && /变量监控/.test(ui.hintText || '') && /切换视图/.test(ui.hintText || ''), ui.hintText);

/* ── 2. 快捷键：两个键一起按才算数（防误触） ── */
await page.keyboard.press('v');
await page.keyboard.press('f');
await sleep(400);
const afterSingle = await page.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  return { vis: m.isVarsVisible(), zoom: m.getZoomMode() };
});
ok('单字母 V/F 不再生效（现场误触不动画面）', afterSingle.vis === false && afterSingle.zoom === 'fit',
  JSON.stringify(afterSingle));

await page.keyboard.press('Control+Shift+V');
await sleep(400);
const shownVars = await page.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  const p = document.getElementById('rtVarsPanel');
  return { vis: m.isVarsVisible(), folded: m.isVarsFolded(), rows: document.querySelectorAll('.rtv-row').length };
});
const geoWithPanel = await geo();
ok('Ctrl+Shift+V 显示变量监控（直接是列表，不是只露标题栏）',
  shownVars.vis === true && shownVars.folded === false && shownVars.rows > 0, JSON.stringify(shownVars));
ok('展开变量监控后画面自动避让（不被面板压住）', geoWithPanel.x + geoWithPanel.rw <= geoWithPanel.vw - 260 + 1,
  `画面右边界 ${(geoWithPanel.x + geoWithPanel.rw).toFixed(0)} / 窗口 ${geoWithPanel.vw}`);
await page.keyboard.press('Control+Shift+V');
await sleep(400);
ok('再按 Ctrl+Shift+V 收起变量监控（画面吃满整窗）',
  (await rt(m => !m.isVarsVisible())) === true && (await geo()).rw > geoWithPanel.rw + 20,
  `${geoWithPanel.rw.toFixed(0)} → ${(await geo()).rw.toFixed(0)}`);

/* ── 3. 三档视图：原始 / 适应 / 填满，模式记住 ── */
const z0 = await rt(m => m.getZoomMode());
const cycle = {};
for (const step of [1, 2, 3]) {
  await page.keyboard.press('Control+Shift+F');
  await sleep(350);
  const g = await geo();
  cycle[await rt(m => m.getZoomMode())] = g;
}
const order = ['orig', 'fit', 'fill'];
const expectOrder = [1, 2, 3].map(i => order[(order.indexOf(z0) + i) % 3]);
ok('Ctrl+Shift+F 依次切三档视图（原始 → 适应 → 填满 循环）',
  JSON.stringify(Object.keys(cycle)) === JSON.stringify(expectOrder),
  JSON.stringify({ 起点: z0, 顺序: Object.keys(cycle) }));
const gOrig = cycle.orig, gFit = cycle.fit, gFill = cycle.fill;
ok('「原始」= 1:1 尺寸', !!gOrig && Math.abs(gOrig.rw - gOrig.cw) <= 1 && Math.abs(gOrig.rh - gOrig.ch) <= 1,
  gOrig ? `${gOrig.rw.toFixed(0)}x${gOrig.rh.toFixed(0)} vs 画布 ${gOrig.cw}x${gOrig.ch}` : 'missing');
ok('「适应」= 整幅都在窗口内（长边贴满，不裁不拉）',
  !!gFit && gFit.rw <= gFit.vw + 1 && gFit.rh <= gFit.vh + 1
  && (Math.abs(gFit.rw - (gFit.vw - 24)) <= 2 || Math.abs(gFit.rh - (gFit.vh - 24)) <= 2)
  && Math.abs((gFit.rw / gFit.rh) - (gFit.cw / gFit.ch)) < 0.01,
  gFit ? `${gFit.rw.toFixed(0)}x${gFit.rh.toFixed(0)} / 窗口 ${gFit.vw}x${gFit.vh}` : 'missing');
// 填满 = 拉伸铺满整窗：横竖都贴边（不留黑边），**而且页面整个都在窗内（控件不能被切掉）**
ok('「填满」= 铺满整窗且页面完整落在窗内（控件一个不少，不裁不超出）',
  !!gFill && Math.abs(gFill.rw - gFill.vw) <= 2 && Math.abs(gFill.rh - gFill.vh) <= 2
  && gFill.x >= -1 && gFill.y >= -1
  && gFill.x + gFill.rw <= gFill.vw + 2 && gFill.y + gFill.rh <= gFill.vh + 2,
  gFill ? `${gFill.rw.toFixed(0)}x${gFill.rh.toFixed(0)} @ ${gFill.x.toFixed(0)},${gFill.y.toFixed(0)} / 窗口 ${gFill.vw}x${gFill.vh}` : 'missing');
// 填满时页面里的控件必须都在窗内（抽查四角 + 全部控件）
const insideFill = await page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight;
  const ws = [...document.querySelectorAll('#rtPage .wd')].map(el => el.getBoundingClientRect());
  const bad = ws.filter(r => r.x < -1 || r.y < -1 || r.right > vw + 1 || r.bottom > vh + 1);
  return { total: ws.length, bad: bad.length,
    sample: bad.slice(0, 3).map(r => `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`) };
});
ok('填满档下页面内所有控件都在窗内（没有一个被切到窗口外）',
  insideFill.total > 0 && insideFill.bad === 0, JSON.stringify(insideFill));
// 填满 + 打开变量监控：画面缩到左边继续铺满，不能被抽屉压住
await rt(m => m.setZoomMode('fill'));
await sleep(400);
await page.keyboard.press('Control+Shift+V');
await sleep(450);
const fillPanel = await page.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  const r = document.getElementById('rtPage').getBoundingClientRect();
  const pr = document.getElementById('rtVarsPanel').getBoundingClientRect();
  const ws = [...document.querySelectorAll('#rtPage .wd')].map(e => e.getBoundingClientRect());
  const bad = ws.filter(x => x.x < -1 || x.y < -1 || x.right > innerWidth + 1 || x.bottom > innerHeight + 1).length;
  return { zoom: m.getZoomMode(), rw: r.width, rh: r.height, right: r.right, panelLeft: pr.left,
    overlaps: r.right > pr.left + 1, bad, vw: innerWidth, vh: innerHeight };
});
ok('填满 + 变量监控打开：画面缩到左边继续铺满（不被抽屉压住、控件也没跑出窗口）',
  fillPanel.zoom === 'fill' && fillPanel.overlaps === false && fillPanel.bad === 0,
  JSON.stringify(fillPanel));
await page.keyboard.press('Control+Shift+V');
await sleep(400);
const savedZoom = await page.evaluate(() => localStorage.getItem('hmi-rt-zoom'));
ok('缩放模式记进 localStorage', savedZoom === (await rt(m => m.getZoomMode())), `${savedZoom}`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await enterRun();
await sleep(900);
ok('刷新（重开）后进运行态仍是上次那档缩放', (await rt(m => m.getZoomMode())) === savedZoom,
  `${savedZoom} → ${await rt(m => m.getZoomMode())}`);

/* ── 4. Ctrl+Shift+L：PLC 设置要真能弹出来（且压在运行画面上面） ── */
await page.keyboard.press('Control+Shift+L');
await sleep(1000);
const dlg = await page.evaluate(() => {
  const mask = document.getElementById('dlgMask');
  const box = document.getElementById('dlgBox').getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + 22);
  return {
    open: !mask.classList.contains('hidden'), overRt: mask.classList.contains('over-runtime'),
    z: getComputedStyle(mask).zIndex, hitInside: !!hit && !!hit.closest('#dlgBox'),
    title: document.getElementById('dlgTitle').textContent,
  };
});
ok('Ctrl+Shift+L 打开 PLC 连接设置，并且压在运行画面上面（不再是「点了没反应」）',
  dlg.open === true && dlg.overRt === true && dlg.hitInside === true && /PLC 连接/.test(dlg.title),
  JSON.stringify(dlg));
await page.evaluate(() => document.getElementById('dlgCancel').click());
await sleep(200);

/* ── 5. Ctrl+Shift+E：退出运行 ── */
await page.keyboard.press('Control+Shift+E');
await sleep(400);
ok('Ctrl+Shift+E 退出运行',
  (await rt(m => !m.isRunning())) === true
  && (await page.evaluate(() => getComputedStyle(document.getElementById('runtimeRoot')).display)) === 'none');
ok('退出后快捷键提示也收掉（不漏到编辑态）',
  (await page.evaluate(() => document.getElementById('rtHint').classList.contains('hidden'))) === true);

/* ── 6. 下发失败提示条 ── */
await enterRun();
await sleep(600);
await fetch(H + '/api/plc', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'connect', protocol: 'opcua', endpoint: `opc.tcp://127.0.0.1:${UA}`, poll_ms: 300,
    variables: [{ name: 'bRun', type: 'bool', address: 'ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun' }, { name: 'iSerial', type: 'dint', address: 'ns=4;s=|var|CODESYS Control Win V3.Application.GVL.iSerial' }] }),
});
await sleep(1800);
const writeFail = await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.set('iSerial', 123, 'local');             // 只读节点 → 服务器拒绝写入
  await new Promise(r => setTimeout(r, 1500));
  const box = document.getElementById('rtWriteAlarm');
  return { hidden: box?.classList.contains('hidden'), text: document.getElementById('rtWriteAlarmText')?.textContent,
    sub: document.getElementById('rtWriteAlarmSub')?.textContent?.slice(0, 40) };
});
ok('写失败 → 运行页面挂出「下发失败」提示条（带原因）',
  writeFail.hidden === false && /下发失败/.test(writeFail.text || ''), JSON.stringify(writeFail));
const writeSelf = await page.evaluate(async () => {
  await new Promise(r => setTimeout(r, 7000));   // 6 秒后应自动收起（别一直挂在画面上）
  return { bar: document.getElementById('rtWriteAlarm')?.classList.contains('hidden'),
    hint: document.getElementById('rtHint')?.classList.contains('hidden') };
});
ok('提示条 6 秒后自动收起（不会一直挂着）', writeSelf.bar === true, String(writeSelf.bar));
ok('快捷键提示几秒后也自动收起（不常驻挡画面）', writeSelf.hint === true, String(writeSelf.hint));
await fetch(H + '/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) });
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await sleep(300);

/* ── 7. 导入对话框里改设备名 ── */
await page.evaluate(() => document.querySelector('.lp-tab[data-panel="vars"]')?.click());
await sleep(300);
await page.click('#btnOpcImport');
await sleep(400);
await page.setInputFiles('#oiXmlFile', ROOT + '/test/data/OPCUA.Device.Application.xml');
await sleep(2000);
const before = await page.evaluate(() => ({
  device: document.getElementById('oiDevice').value,
  first: document.querySelector('#oiList tbody tr input[data-pick]')?.dataset.pick,
  checked: document.querySelectorAll('#oiList input[data-pick]:checked').length,
}));
await page.fill('#oiDevice', 'CODESYS Control Win V3 x64');
await sleep(1800);
const after = await page.evaluate(() => ({
  first: document.querySelector('#oiList tbody tr input[data-pick]')?.dataset.pick,
  checked: document.querySelectorAll('#oiList input[data-pick]:checked').length,
  msg: document.getElementById('oiXmlMsg').textContent.slice(0, 80),
}));
ok('XML 里的设备名会先回填进输入框', before.device === 'Device', before.device);
ok('改设备名 → NodeId 立刻按新设备名重算（不用重选文件）',
  /Device\.Application/.test(before.first || '') && /CODESYS Control Win V3 x64\.Application/.test(after.first || ''),
  JSON.stringify([before.first, after.first]));
ok('重算时保留原来的勾选', after.checked === before.checked && after.checked > 0,
  JSON.stringify([before.checked, after.checked]));
ok('① ～ ⑦ 全程无未捕获 JS 异常（导入这段为止）', errs.length === 0, errs.slice(0, 2).join(' | '));

/* ── 8. 「确定」前必须真连上（不能没连上也报成功） ── */
await page.evaluate(() => document.getElementById('dlgCancel')?.click());
const clickOkPlc = async (endpoint, waitMs) => page.evaluate(async ([ep, w]) => {
  const seen = [];
  const real = window.alert;
  window.alert = (m) => seen.push(String(m));
  try {
    const tb = await import('/js/editor/toolbar.js');
    tb.openPlcDialog();
    await new Promise(r => setTimeout(r, 300));
    const proto = document.getElementById('plcProto');
    proto.value = 'opcua';
    proto.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('plcEndpoint').value = ep;
    document.getElementById('dlgOk').click();
    await new Promise(r => setTimeout(r, w));
    return {
      alerts: seen,
      dlgOpen: !document.getElementById('dlgMask').classList.contains('hidden'),
      meta: window.app?.project?.data?.meta?.plc?.endpoint || '',
    };
  } finally { window.alert = real; }
}, [endpoint, waitMs]);

const deadPort = await freePort();
const dead = await clickOkPlc('opc.tcp://127.0.0.1:' + deadPort, 7000);
ok('端点连不上时点「确定」→ 明说「没连上」，不谎报成功、对话框不关',
  dead.dlgOpen === true && dead.alerts.some(m => /连接没有成功|连接失败/.test(m)) && !dead.meta,
  JSON.stringify({ open: dead.dlgOpen, alerts: dead.alerts.map(m => m.slice(0, 24)), meta: dead.meta }));
await page.evaluate(() => document.getElementById('dlgCancel')?.click());

const good = await clickOkPlc(`opc.tcp://127.0.0.1:${UA}`, 7000);
ok('真连得上时正常报「已连接」并关掉对话框（没有误判成失败）',
  good.dlgOpen === false && good.alerts.some(m => /已连接 OPC UA/.test(m)) && good.meta.includes(String(UA)),
  JSON.stringify({ open: good.dlgOpen, alerts: good.alerts.map(m => m.slice(0, 24)), meta: good.meta }));
await fetch(H + '/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) });
// ⚠ 收尾要把后端的**协议**也还原成 modbus（不只是断开）。
//   为什么：`disconnect` 只把 mode 变回 memory，`plc.json` 里的 protocol 仍然是 opcua
//   （后端是有意保留的 —— 连接对话框靠它记住上次选的协议）。而前端判断「数据类型那一格能不能改」
//   看的是当前协议，于是**断开之后它还是锁着的**。一套件共用一个后端（见 tools/run-suites.mjs），
//   后面那些要改数据类型的套件（verify-arrbind / verify-btn-hold）打开编辑器就发现那一格点不动 ——
//   实测长序列里就是这么报错的（单跑全过、连跑失败）。
//   这里"连一次 modbus 再断开"把协议摆回 modbus（端口给 1，连不上无所谓，目的只是把配置写成 modbus）。
//   ⚠ 这属于**测试收尾**，不是改产品行为：真机上"断开之后协议仍记着 opcua"是另一个待定的产品问题。
await fetch(H + '/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'connect', protocol: 'modbus', ip: '127.0.0.1', port: 1, unit: 1, poll_ms: 200 }) });
await sleep(600);
await fetch(H + '/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) });
await sleep(300);
ok('全程无未捕获 JS 异常（连接确认那段也没有）', errs.length === 0, errs.slice(0, 2).join(' | '));

const pass = out.filter(l => l.startsWith('PASS')).length;
console.log(out.join('\n'));
console.log(`\n==== 运行界面 / 快捷键 / 缩放 / 提示条 / 改设备名 / 连接确认：${pass}/${out.length} 通过 ====`);
try { sim.kill(); } catch { /* 忽略 */ }
await browser.close();
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
