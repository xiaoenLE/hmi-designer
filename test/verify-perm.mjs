// verify-perm.mjs — 操作权限（运行态分级密码）
//   ① 组态：权限管理对话框（开关 / 自动上锁 / 等级表增删改排序）、每个控件的「权限等级」
//   ② 运行态：权限不够 → 动作**不执行** + 弹密码框；密码错有提示；对了就解锁，之后能操作
//   ③ 高级别包含低级别；解锁低级别时高级别控件照样拦
//   ④ 退出权限三条路：顶部小胶囊 / Ctrl+Shift+Q / 按钮动作「退出权限（锁定）」
//   ⑤ 关掉权限管理 = 不拦（老工程行为不变）；删掉某一级 → 引用它的控件自动改回「不限」
//
// 用法：node test/verify-perm.mjs   （自己拉起一个独立数据目录的后端，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
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
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-perm-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());   // 纯本地，不碰后端
await page.goto(H + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);

/* ══════ 1. 组态：等级表 + 控件上的权限等级 ══════ */
const setup = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { hashPassword, newSalt, PERM_HASH_ITER } = await import('/js/core/sha256.js');
  const cur = project.currentPage();
  cur.widgets.length = 0;
  // 用真实变量（变量表里没有的名字 → setValue 会按 string 落值，测"动作有没有执行"就不准了）
  [['bPermA', 'bool', false], ['bPermB', 'bool', false], ['iPerm', 'int', 0]].forEach(([n, t, val]) => {
    const ex = project.variables().find(v => v.name === n);
    if (ex) { ex.type = t; ex.value = val; return; }
    project.variables().push({ name: n, type: t, address: '', value: val, len: 0 });
  });
  project.data.permissions = { enabled: true, lockAfterMin: 0, levels: [] };
  const op = project.addPermLevel({ name: '操作员' });
  const en = project.addPermLevel({ name: '工程师' });
  for (const [lv, pw] of [[op, '1111'], [en, '2222']]) {
    lv.salt = newSalt();
    lv.iter = PERM_HASH_ITER;
    lv.hash = hashPassword(pw, lv.salt, lv.iter);
  }
  const mk = (name, x, actions, permLevel) => {
    const w = project.addWidget('button', x, 40);
    project.updateWidgetProp(w.id, 'text', name);
    project.updateWidgetProp(w.id, 'permLevel', permLevel || '');
    project.updateWidgetActions(w.id, actions);
    return w.id;
  };
  const ids = {
    op: mk('操作员按钮', 40, [{ trigger: 'click', type: 'setValue', params: { variable: 'bPermA', value: 'true' } }], op.id),
    en: mk('工程师按钮', 200, [{ trigger: 'click', type: 'toggle', params: { variable: 'bPermB' } }], en.id),
    free: mk('不限按钮', 360, [{ trigger: 'click', type: 'setValue', params: { variable: 'iPerm', value: '7' } }], ''),
    exit: mk('退出权限', 520, [{ trigger: 'click', type: 'exitPerm', params: {} }], ''),
  };
  project.commit('测试权限控件');
  const permJson = JSON.stringify(project.permissions());
  return {
    ids, levels: project.permLevels().map(l => ({ id: l.id, name: l.name, hashLen: (l.hash || '').length })),
    enabled: project.permissions().enabled,
    // ⚠ 只看**权限那一块**（口令就存在这儿）：拿整份工程 JSON 去 includes('1111') 会误报 ——
    //   内置模板里就有一条"操作工 1111 / 工程师 8888"的说明文字（给人看的），跟口令存哪没关系。
    plainInProject: permJson.includes('1111') || permJson.includes('2222')
      || project.permLevels().some(l => /1111|2222/.test(String(l.pw || ''))),
  };
});
ok('等级表：能自己配（名字 + 密码），密码不在 JSON 里露明文（老工程的哈希写法也照样能验）',
  setup.levels.length === 2 && setup.levels.every(l => l.hashLen === 64) && !setup.plainInProject,
  JSON.stringify(setup.levels) + ` 明文泄露=${setup.plainInProject}`);
await page.evaluate(ids => { window.__ids = ids; }, setup.ids);   // 后面用例用控件 id 点按钮

/* 权限管理对话框 */
await page.evaluate(() => import('/js/editor/toolbar.js').then(m => m.openPermDialog()));
await sleep(300);
// 右上角的 ✕：**所有用 showDialog 的弹窗都有**（现场要求：大弹窗内容长，
// 底部「取消」要滚下去才看得见；跟脚本编辑器那个 ✕ 一个习惯）
const dlgX = await page.evaluate(() => {
  const x = document.getElementById('dlgX'), box = document.getElementById('dlgBox');
  if (!x || !box) return null;
  const r = x.getBoundingClientRect(), b = box.getBoundingClientRect();
  return { visible: r.width > 0 && r.height > 0, title: x.title || '',
    topRight: r.top < b.top + 60 && r.right > b.right - 60 };
});
ok('对话框右上角有关闭 ✕（在右上角、可见）', dlgX?.visible === true && dlgX.topRight === true, JSON.stringify(dlgX));
const dlg = await page.evaluate(() => ({
  open: !document.getElementById('dlgMask').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  rows: document.querySelectorAll('#pmRows .pm-row').length,
  hasEnable: !!document.getElementById('pmEnabled'),
  hasLock: !!document.getElementById('pmLockAfter'),
  hasAdd: !!document.getElementById('pmAdd'),
  // 「清空报警记录」那一档已经去掉（现场嫌多余：按控件自己的等级拦就行）
  hasClearRow: !!document.getElementById('pmClearLevel'),
  hints: document.querySelectorAll('#dlgBody .dlg-hint').length,
  names: [...document.querySelectorAll('#pmRows [data-pmname]')].map(i => i.value),
  pwPlaceholders: [...document.querySelectorAll('#pmRows [data-pmpw]')].map(i => i.placeholder),
}));
ok('「权限管理…」对话框：开关 + 自动上锁 + 等级表（改名/改密码/上下移/删除）都在',
  dlg.open && dlg.title === '权限管理' && dlg.rows === 2 && dlg.hasEnable && dlg.hasLock && dlg.hasAdd
  && JSON.stringify(dlg.names) === JSON.stringify(['操作员', '工程师'])
  && dlg.pwPlaceholders.every(p => /密码/.test(p)),
  JSON.stringify(dlg));
ok('对话框里**没有**「清空报警记录」那一档设置（清空按控件自己的权限等级拦）',
  dlg.hasClearRow === false, String(dlg.hasClearRow));
ok('对话框里那一大段说明文字已经删掉（只留必要的提示）', dlg.hints === 0, String(dlg.hints));

/* 点右上角的 ✕ = 关掉（跟「取消」一件事），再打开继续后面的用例 */
await page.click('#dlgX');
await sleep(250);
ok('点右上角 ✕ → 对话框关掉（= 取消）',
  await page.evaluate(() => document.getElementById('dlgMask').classList.contains('hidden')));
await page.evaluate(() => import('/js/editor/toolbar.js').then(m => m.openPermDialog()));
await sleep(250);

/* 在对话框里加一级 + 调顺序 + 删除 */
const dlgOps = await page.evaluate(async () => {
  document.getElementById('pmAdd').click();
  await new Promise(r => setTimeout(r, 120));
  const afterAdd = [...document.querySelectorAll('#pmRows [data-pmname]')].map(i => i.value);
  // 把新加的（第 3 行）往上挪一格
  document.querySelectorAll('#pmRows .pm-row')[2].querySelector('[data-pmup]').click();
  await new Promise(r => setTimeout(r, 120));
  const afterUp = [...document.querySelectorAll('#pmRows [data-pmname]')].map(i => i.value);
  // 删掉中间那一行（第 2 行 = 刚挪上来的那个）
  document.querySelectorAll('#pmRows .pm-row')[1].querySelector('[data-pmdel]').click();
  await new Promise(r => setTimeout(r, 150));
  const afterDel = [...document.querySelectorAll('#pmRows [data-pmname]')].map(i => i.value);
  return { afterAdd, afterUp, afterDel, levels: window.app.project.permLevels().map(l => l.name) };
});
ok('等级表能加一级 / 上下调高低 / 删一级（改的就是工程里的等级顺序）',
  dlgOps.afterAdd.length === 3 && dlgOps.afterUp[1] === '等级3' && dlgOps.afterDel.length === 2
  && JSON.stringify(dlgOps.levels) === JSON.stringify(dlgOps.afterDel),
  JSON.stringify(dlgOps));

/* 改名 + 设密码：密码**直接显示在框里**（回来看得见上次设的是什么） */
const renamed = await page.evaluate(async () => {
  const row = document.querySelectorAll('#pmRows .pm-row')[1];
  row.querySelector('[data-pmname]').value = '班组长';
  row.querySelector('[data-pmpw]').value = '2222';   // 后面的运行态用例按 2222 解锁
  document.getElementById('dlgOk').click();
  await new Promise(r => setTimeout(r, 250));
  const l = window.app.project.permLevels()[1];
  const saved = {
    name: l.name, pwLen: (l.pw || '').length, hashCleared: !l.hash,
    plain: JSON.stringify(window.app.project.permissions()).includes('2222'),
    dlgClosed: document.getElementById('dlgMask').classList.contains('hidden'),
  };
  // 再打开一次：密码框里应该**看得见**刚设的密码
  await import('/js/editor/toolbar.js').then(m => m.openPermDialog());
  await new Promise(r => setTimeout(r, 200));
  const shown = [...document.querySelectorAll('#pmRows [data-pmpw]')].map(i => i.value);
  const type = document.querySelector('#pmRows [data-pmpw]')?.type;
  const ph = [...document.querySelectorAll('#pmRows [data-pmpw]')].map(i => i.placeholder);
  document.getElementById('dlgCancel').click();
  return { ...saved, shown, type, ph };
});
ok('对话框里改名 + 设密码 → 落进工程；再打开**看得见**刚设的密码',
  renamed.name === '班组长' && renamed.pwLen > 0 && renamed.hashCleared && !renamed.plain
  && renamed.dlgClosed && renamed.shown[1] === '2222' && renamed.type === 'text',
  JSON.stringify(renamed));
ok('老工程里用哈希存的密码看不出来：那一格空着并写明「重填一次就能显示」',
  renamed.shown[0] === '' && /重填/.test(renamed.ph[0] || ''), JSON.stringify(renamed.ph));

/* 原样保存 = 不改密码（框里就是当前密码，不动它就不会变） */
const pwKeep = await page.evaluate(async () => {
  const p = window.app.project;
  const before = p.permLevels()[1].pw;
  await import('/js/editor/toolbar.js').then(m => m.openPermDialog());
  await new Promise(r => setTimeout(r, 200));
  document.getElementById('dlgOk').click();                 // 什么都不动 → 直接保存
  await new Promise(r => setTimeout(r, 200));
  return { kept: p.permLevels()[1].pw === before };
});
ok('密码不动、直接保存 = 密码不变', pwKeep.kept === true, JSON.stringify(pwKeep));

/* 属性面板上的三行：权限等级 / 密码框 / 小锁标记 —— **不管有没有选等级都一直显示** */
const propRows = await page.evaluate(async () => {
  const cv = await import('/js/editor/canvas.js');
  const { project } = await import('/js/core/project.js');
  const rowsOf = () => [...document.querySelectorAll('#propBody .f-row')]
    .filter(r => ['权限等级', '密码框', '小锁标记'].includes(r.querySelector('.f-label')?.textContent.trim()))
    .map(r => ({
      label: r.querySelector('.f-label').textContent.trim(),
      hasCheck: !!r.querySelector('[data-prop="permPrompt"], [data-prop="showPermBadge"]'),
      checked: r.querySelector('[data-prop="showPermBadge"]')?.checked ?? null,
      text: r.querySelector('label > span')?.textContent || '',
    }));
  cv.select([window.__ids.op]);            // 配了等级的控件
  await new Promise(r => setTimeout(r, 350));
  const withLevel = rowsOf();
  cv.select([window.__ids.free]);          // 不限的控件（没选等级）
  await new Promise(r => setTimeout(r, 350));
  const noLevel = rowsOf();
  project.setPermissions({ enabled: false });   // 连权限管理都关掉
  await new Promise(r => setTimeout(r, 300));
  const off = rowsOf();
  project.setPermissions({ enabled: true });
  return { withLevel, noLevel, off };
});
// 「密码框」那一行的**文字去掉了**（现场要求只删文字、留开关）→ 和「小锁标记」一样是个裸勾选框，
// 意思在标签「密码框」+ 悬停提示里。这里同时守着"别哪天又把长说明加回来"。
ok('属性面板「操作权限」三行：权限等级 + 密码框 + 小锁标记（后两个都是裸勾选框、不带长说明）',
  JSON.stringify(propRows.withLevel.map(r => r.label)) === JSON.stringify(['权限等级', '密码框', '小锁标记'])
  && propRows.withLevel[1].hasCheck && propRows.withLevel[2].hasCheck
  && propRows.withLevel[1].text.trim() === ''
  && propRows.withLevel[2].text.trim() === '',
  JSON.stringify(propRows.withLevel));
ok('「小锁标记」**默认是勾上的**（不用逐个控件去打开）',
  propRows.withLevel[2].checked === true && propRows.noLevel[2].checked === true
  && propRows.off[2].checked === true,
  JSON.stringify([propRows.withLevel[2].checked, propRows.noLevel[2].checked, propRows.off[2].checked]));
ok('「密码框 / 小锁标记」一直显示：**没选等级（不限）**、甚至**权限管理关着**时也照样三行都在',
  JSON.stringify(propRows.noLevel.map(r => r.label)) === JSON.stringify(['权限等级', '密码框', '小锁标记'])
  && JSON.stringify(propRows.off.map(r => r.label)) === JSON.stringify(['权限等级', '密码框', '小锁标记'])
  && propRows.noLevel[1].hasCheck && propRows.off[2].hasCheck,
  JSON.stringify({ noLevel: propRows.noLevel.map(r => r.label), off: propRows.off.map(r => r.label) }));

/* ══════ 2. 运行态：拦截 + 解锁 ══════ */
await page.evaluate(() => window.app.enterRun());
await sleep(400);
const badges = await page.evaluate(() => ({
  any: document.querySelectorAll('#rtPage .wd .rt-perm-lock').length,
  texts: [...document.querySelectorAll('#rtPage .wd .rt-perm-lock')].map(e => e.textContent),
  free: !!document.querySelector(`#rtPage .wd[data-id="${window.__ids.free}"] .rt-perm-lock`),
  chipHidden: document.getElementById('rtPermChip')?.classList.contains('hidden') ?? true,
}));
ok('运行态：**默认就挂小锁**（没解锁 + 要权限的控件，不用手动打开标记）',
  badges.any === 2 && !badges.free && badges.chipHidden && badges.texts.every(t => t === '🔒'),
  JSON.stringify(badges));
ok('小锁上**只画一个 🔒**（等级名不挤在控件上）', badges.texts.every(t => t === '🔒'), JSON.stringify(badges.texts));
const badgeTitles = await page.evaluate(() => ({
  op: document.querySelector(`#rtPage .wd[data-id="${window.__ids.op}"] .rt-perm-lock`)?.title || '',
}));
ok('等级名挪到悬停提示里（还写明点下去会弹密码框）',
  /操作员/.test(badgeTitles.op) && /密码框/.test(badgeTitles.op), badgeTitles.op);

const clickWd = async (id) => {
  // locator.click：被别的东西盖住会当场报错（mouse.click 是"闭着眼睛点"，盖住了也看不出来）
  await page.locator(`#rtPage .wd[data-id="${id}"]`).click({ timeout: 5000 });
  await sleep(250);
};
const vals = () => page.evaluate(async () => {
  const { varStore } = await import('/js/runtime/varstore.js');
  return { a: varStore.get('bPermA'), b: varStore.get('bPermB'), i: varStore.get('iPerm') };
});
await clickWd(setup.ids.op);
const afterDenied = await page.evaluate(async () => ({
  pw: !document.getElementById('permMask').classList.contains('hidden'),
  levelName: document.getElementById('permLevelName')?.textContent || '',
  keys: document.querySelectorAll('#permPad .rt-perm-key').length,
}));
const v1 = await vals();
ok('权限不够：动作**没执行**，弹出密码框（写着要哪一级，带数字键盘给触摸屏）',
  v1.a === false && afterDenied.pw && afterDenied.levelName === '操作员' && afterDenied.keys === 12,
  JSON.stringify({ v1, afterDenied }));

await page.fill('#permPw', '9999');
await page.click('#permOk');
await sleep(250);
const wrong = await page.evaluate(() => ({
  err: !document.getElementById('permErr').classList.contains('hidden'),
  stillOpen: !document.getElementById('permMask').classList.contains('hidden'),
  level: document.getElementById('permLevelName').textContent,
}));
ok('密码输错：留在框里提示「密码不对」，不会解锁', wrong.err && wrong.stillOpen, JSON.stringify(wrong));

await page.fill('#permPw', '1111');
await page.click('#permOk');
await sleep(300);
const unlocked = await page.evaluate(() => ({
  maskHidden: document.getElementById('permMask').classList.contains('hidden'),
  chip: document.getElementById('rtPermChip')?.textContent || '',
  opBadge: !!document.querySelector(`#rtPage .wd[data-id="${window.__ids.op}"] .rt-perm-lock`),
  enBadge: document.querySelector(`#rtPage .wd[data-id="${window.__ids.en}"] .rt-perm-lock`)?.textContent || '',
}));
ok('密码对 → 解锁：密码框收起、顶部出现「已解锁」小胶囊；**解锁的那个控件角标直接消失**（不再显示 🔓），还没解锁的照样是 🔒',
  unlocked.maskHidden && /操作员/.test(unlocked.chip) && unlocked.opBadge === false && /🔒/.test(unlocked.enBadge),
  JSON.stringify(unlocked));

await clickWd(setup.ids.op);
const v2 = await vals();
ok('解锁后再点同一个按钮 → 动作正常执行（写进变量了）', v2.a === true, JSON.stringify(v2));

/* 高级别包含低级别；解锁低级别时高级别照样拦 */
const hier = await page.evaluate(async () => {
  const P = await import('/js/runtime/permissions.js');
  const ids = window.__ids;
  const wOp = window.app.project.findWidget(ids.op);
  const wEn = window.app.project.findWidget(ids.en);
  return { opOk: P.allowedFor(wOp), enOk: P.allowedFor(wEn), state: P._state() };
});
ok('等级高低关系：解锁「操作员」→ 操作员的控件放行，工程师的控件仍然拦',
  hier.opOk === true && hier.enOk === false && hier.state.level && hier.state.idleArmed === false,
  JSON.stringify(hier));

await clickWd(setup.ids.en);
const enPrompt = await page.evaluate(() => ({
  level: document.getElementById('permLevelName')?.textContent || '',
  open: !document.getElementById('permMask').classList.contains('hidden'),
}));
ok('点工程师的控件：仍然弹密码框（要的是「班组长」这一级）',
  enPrompt.open && enPrompt.level === '班组长', JSON.stringify(enPrompt));
await page.fill('#permPw', '2222');
await page.click('#permOk');
await sleep(250);
await clickWd(setup.ids.en);
const v3 = await vals();
ok('解锁更高级别后 → 高级别控件也能操作了（toggle 翻转）', v3.b === true, JSON.stringify(v3));

/* ══════ 3. 退出权限（三条路）══════ */
await page.click('#rtPermChip');
await sleep(250);
const afterChip = await page.evaluate(() => ({
  chipHidden: document.getElementById('rtPermChip').classList.contains('hidden'),
  opBadge: document.querySelector(`#rtPage .wd[data-id="${window.__ids.op}"] .rt-perm-lock`)?.textContent || '',
}));
// 先把变量清回 false：这样"点了没执行"和"执行了"才分得出来（它上一步已经被点成 true 了）
await page.evaluate(async () => {
  (await import('/js/runtime/varstore.js')).varStore.set('bPermA', false, 'remote');
});
await clickWd(setup.ids.op);
const v4 = await vals();
ok('点顶部「已解锁」胶囊 = 退出权限：胶囊收起、小锁回到 🔒、再点控件又被拦',
  afterChip.chipHidden && afterChip.opBadge === '🔒' && v4.a === false,
  JSON.stringify({ afterChip, v4 }));

await page.evaluate(async () => {
  const P = await import('/js/runtime/permissions.js');
  P.unlock(window.app.project.permLevels()[0].id, '1111');
});
await sleep(200);
await page.keyboard.press('Control+Shift+KeyQ');
await sleep(250);
const afterKey = await page.evaluate(() => ({
  chipHidden: document.getElementById('rtPermChip').classList.contains('hidden'),
  level: document.querySelector('#rtPage .wd .rt-perm-lock')?.textContent || '',
}));
ok('Ctrl+Shift+Q 也能退出权限（现场不用去翻那个按钮）',
  afterKey.chipHidden && /🔒/.test(afterKey.level), JSON.stringify(afterKey));

await page.evaluate(async () => {
  const P = await import('/js/runtime/permissions.js');
  P.unlock(window.app.project.permLevels()[0].id, '1111');
});
await sleep(200);
await clickWd(setup.ids.exit);
await sleep(250);
const afterBtn = await page.evaluate(async () => {
  const P = await import('/js/runtime/permissions.js');
  return {
    chipHidden: document.getElementById('rtPermChip').classList.contains('hidden'),
    state: P._state(),
    action: !!document.querySelector(`#rtPage .wd[data-id="${window.__ids.exit}"]`),
  };
});
ok('按钮动作「退出权限（锁定）」：按一下就交回权限',
  afterBtn.action && afterBtn.chipHidden && afterBtn.state.level === '', JSON.stringify(afterBtn));

/* ══════ 4. 自动上锁（按配置武装计时器）══════ */
const idle = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  project.setPermissions({ lockAfterMin: 5 });
  P.unlock(project.permLevels()[0].id, '1111');
  await new Promise(r => setTimeout(r, 100));
  const armed = P._state();
  project.setPermissions({ lockAfterMin: 0 });
  P.unlock(project.permLevels()[0].id, '1111');
  await new Promise(r => setTimeout(r, 100));
  const notArmed = P._state();
  project.setPermissions({ lockAfterMin: 5 });     // 恢复默认
  return { armed, notArmed };
});
ok('「自动上锁」按配置生效：配了 5 分钟就武装计时器，配 0（一直有效）就不装',
  idle.armed.idleArmed === true && idle.armed.lockAfterMs === 300000 && idle.notArmed.idleArmed === false
  && idle.notArmed.lockAfterMs === 0,
  JSON.stringify(idle));

/* ══════ 4b. 小锁是**逐控件可关**的：关一个不影响别人，功能照样拦 ══════ */
const badgePerW = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  P.lock();
  // 只把「操作员按钮」这一个控件的小锁关掉（工程师那个不动，保持默认显示）
  project.updateWidgetProp(window.__ids.op, 'showPermBadge', false);
  await new Promise(r => setTimeout(r, 250));
  const opBadge = !!document.querySelector(`#rtPage .wd[data-id="${window.__ids.op}"] .rt-perm-lock`);
  const enBadge = !!document.querySelector(`#rtPage .wd[data-id="${window.__ids.en}"] .rt-perm-lock`);
  return { opBadge, enBadge, prop: project.findWidget(window.__ids.op).props.showPermBadge };
});
await clickWd(setup.ids.op);
const badgePerWPrompt = await page.evaluate(() => ({
  open: !document.getElementById('permMask').classList.contains('hidden'),
  level: document.getElementById('permLevelName')?.textContent || '',
}));
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  document.getElementById('permCancel')?.click();
  project.updateWidgetProp(window.__ids.op, 'showPermBadge', true);   // 收尾：小锁恢复
  (await import('/js/runtime/permissions.js')).lock();
});
await sleep(200);
ok('小锁可以逐控件关掉：关掉那个不显示、别的照旧显示，而且该控件依然拦（点一下还是弹密码框）',
  badgePerW.opBadge === false && badgePerW.enBadge === true && badgePerW.prop === false
  && badgePerWPrompt.open && badgePerWPrompt.level === '操作员',
  JSON.stringify({ badgePerW, badgePerWPrompt }));

/* ══════ 4c. 默认就挂：新控件的 props 里**没有**这个键 = 照样挂 🔒 ══════ */
const freshWidget = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const rt = await import('/js/runtime/runtime.js');
  const w = project.addWidget('button', 700, 200);
  project.updateWidgetProp(w.id, 'permLevel', project.permLevels()[0].id);   // 配了等级，没碰过小锁开关
  project.commit('默认挂小锁');
  // 运行态不会因为工程数据变了就重建控件 DOM → 手动重画一次，
  // 否则"没挂角标"是假的（元素根本不存在）
  await rt.exitRun(); await rt.enterRun();
  await new Promise(r => setTimeout(r, 500));
  const el = document.querySelector(`#rtPage .wd[data-id="${w.id}"]`);
  const badge = el?.querySelector('.rt-perm-lock')?.textContent || '';
  const propUndefined = project.findWidget(w.id).props.showPermBadge === undefined;
  project.deleteWidgets([w.id]);
  return { rendered: !!el, badge, propUndefined };
});
ok('默认就挂小锁：配了权限等级、没动过开关的控件，运行态直接显示 🔒（不用逐个打开）',
  freshWidget.rendered === true && freshWidget.badge === '🔒' && freshWidget.propUndefined === true,
  JSON.stringify(freshWidget));

/* ══════ 4d. 「权限不够时自动弹出」不勾 = 点不动、也不弹框、不提示 ══════ */
const silent = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  P.lock();
  const opId = window.__ids.op;
  project.updateWidgetProp(opId, 'permPrompt', false);      // 关掉自动弹密码框
  await new Promise(r => setTimeout(r, 250));
  return {
    prop: project.findWidget(opId).props.permPrompt,
    // 变量清干净，方便看这次点击到底有没有执行
    reset: (await import('/js/runtime/varstore.js')).varStore.set('bPermA', false, 'remote'),
  };
});
await clickWd(setup.ids.op);
const silentAfter = await page.evaluate(async () => ({
  dlgOpen: !document.getElementById('permMask').classList.contains('hidden'),
  chipHidden: document.getElementById('rtPermChip')?.classList.contains('hidden') ?? true,
  a: (await import('/js/runtime/varstore.js')).varStore.get('bPermA'),
}));
ok('「密码框」不勾时：权限不够就点不动 —— 不弹密码框、不提示、动作也不执行',
  silent.prop === false && silentAfter.dlgOpen === false && silentAfter.a === false && silentAfter.chipHidden,
  JSON.stringify({ silent, silentAfter }));

// 勾回来 → 又能弹了（解锁后能正常操作，把这一条路收尾）
const backPrompt = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.updateWidgetProp(window.__ids.op, 'permPrompt', true);
  await new Promise(r => setTimeout(r, 200));
  return { prop: project.findWidget(window.__ids.op).props.permPrompt };
});
await clickWd(setup.ids.op);
const backPromptAfter = await page.evaluate(async () => ({
  dlgOpen: !document.getElementById('permMask').classList.contains('hidden'),
  level: document.getElementById('permLevelName')?.textContent || '',
  hasX: (() => {                                   // 密码卡片右上角也该有个 ✕（跟组态弹窗一个习惯）
    const x = document.getElementById('permX');
    if (!x) return null;
    const r = x.getBoundingClientRect(), c = document.querySelector('.rt-perm-card')?.getBoundingClientRect();
    return { visible: r.width > 0, topRight: !!c && r.top < c.top + 60 && r.right > c.right - 60 };
  })(),
}));
ok('密码框右上角也有 ✕（可见、在右上角）',
  backPromptAfter.hasX?.visible === true && backPromptAfter.hasX?.topRight === true, JSON.stringify(backPromptAfter.hasX));
await page.evaluate(() => document.getElementById('permX')?.click());
await sleep(200);
ok('点密码框的 ✕ → 关掉（= 取消，不解锁）',
  await page.evaluate(() => document.getElementById('permMask').classList.contains('hidden')));
await page.evaluate(() => document.getElementById('permCancel')?.click());
await sleep(150);
ok('把「密码框」勾回来 → 又恢复弹密码框',
  backPrompt.prop === true && backPromptAfter.dlgOpen && backPromptAfter.level === '操作员',
  JSON.stringify({ backPrompt, backPromptAfter }));

/* ══════ 4e. 「清空报警记录」按**控件自己的权限等级**拦（没有单独的那一档设置了）══════ */
const clearPerm = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  const A = await import('/js/runtime/alarms.js');
  const rt = await import('/js/runtime/runtime.js');
  P.lock();
  const levels = project.permLevels();
  // 造两条历史 + 一个「报警历史」控件（它自带「清空记录」按钮），给它配上「操作员」这一级
  // ⚠ 不清空页面：后面的用例还要点前面那几个按钮
  const hist = project.addWidget('alarmHistory', 40, 200);
  project.updateWidgetProp(hist.id, 'permLevel', levels[0].id);
  project.commit('报警历史控件');
  // 直接往历史里塞两条（走引擎的公开接口：_pushActive 只影响当前报警，这里手动造历史）
  A.alarmHistory();                                   // 确保模块已加载
  const list = [
    { key: 'k1', id: 'k1', name: '', text: '第一条', level: 'alarm', value: 1, at: Date.now() - 1000, endAt: Date.now(), acked: true },
    { key: 'k2', id: 'k2', name: '', text: '第二条', level: 'warn', value: 2, at: Date.now(), endAt: 0, acked: false },
  ];
  localStorage.setItem('hmi-alarm-history', JSON.stringify(list));
  await rt.enterRun();
  await new Promise(r => setTimeout(r, 500));
  const before = A.alarmHistory().length;
  window.__clearWidgetId = hist.id;      // 下面几步要用（页面 evaluate 之间共享 window）
  return {
    widgetId: hist.id, before,
    need: P.needOf(project.getWidget(hist.id)),
    own: levels[0].id, ownName: levels[0].name,
    // 那一档老设置已经删掉了（老工程里留的键也会在 normalize 时清掉）
    oldKey: 'clearAlarmLevel' in project.permissions(),
    btn: !!document.querySelector(`#rtPage .wd[data-id="${hist.id}"] .at-clear`),
  };
});
ok('清空按钮按**控件自己的权限等级**拦（不再有单独那一档设置）',
  clearPerm.need === clearPerm.own && clearPerm.oldKey === false && clearPerm.btn && clearPerm.before >= 2,
  JSON.stringify(clearPerm));

// 未解锁：点清空按钮 → 弹密码框、历史**没被清**
await page.locator(`#rtPage .wd[data-id="${clearPerm.widgetId}"] .at-clear`).click({ timeout: 5000 });
await sleep(300);
const clearDenied = await page.evaluate(async () => ({
  dlgOpen: !document.getElementById('permMask').classList.contains('hidden'),
  level: document.getElementById('permLevelName')?.textContent || '',
  hist: (await import('/js/runtime/alarms.js')).alarmHistory().length,
}));
ok('没权限时点「清空记录」：弹密码框、历史**一条都没少**',
  clearDenied.dlgOpen && clearDenied.level === clearPerm.ownName && clearDenied.hist >= 2,
  JSON.stringify(clearDenied));

// 输对那一级的密码 → 再点才清掉
await page.fill('#permPw', '1111');            // 「操作员」的密码
await page.click('#permOk');
await sleep(300);
await page.locator(`#rtPage .wd[data-id="${clearPerm.widgetId}"] .at-clear`).click({ timeout: 5000 });
await sleep(300);
const cleared = await page.evaluate(async () => ({
  hist: (await import('/js/runtime/alarms.js')).alarmHistory().length,
  chip: document.getElementById('rtPermChip')?.textContent || '',
}));
ok('解锁那一级后点「清空记录」→ 历史才真的清掉', cleared.hist === 0 && /操作员/.test(cleared.chip),
  JSON.stringify(cleared));

// 同一个控件改回「不限」→ 谁都能清（不再有一档全局设置管着它）
const noNeed = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  const A = await import('/js/runtime/alarms.js');
  const rt = await import('/js/runtime/runtime.js');
  P.lock();
  project.updateWidgetProp(window.__clearWidgetId, 'permLevel', '');
  project.commit('改回不限');
  localStorage.setItem('hmi-alarm-history', JSON.stringify([
    { key: 'k9', id: 'k9', name: '', text: '又一条', level: 'alarm', value: 1, at: Date.now(), endAt: 0, acked: false },
  ]));
  await rt.exitRun(); await rt.enterRun();
  await new Promise(r => setTimeout(r, 500));
  const w = project.getWidget(window.__clearWidgetId);
  return { need: P.needOf(w), before: A.alarmHistory().length };
});
await page.locator(`#rtPage .wd[data-id="${clearPerm.widgetId}"] .at-clear`).click({ timeout: 5000 });
await sleep(300);
const freeCleared = await page.evaluate(async () => ({
  dlgOpen: !document.getElementById('permMask').classList.contains('hidden'),
  hist: (await import('/js/runtime/alarms.js')).alarmHistory().length,
}));
ok('控件改回「不限」→ 点清空直接清掉，不再弹密码框',
  noNeed.need === '' && freeCleared.dlgOpen === false && freeCleared.hist === 0,
  JSON.stringify({ noNeed, freeCleared }));

/* ══════ 4g. 密码框：能改选解锁哪一级；没设密码的那一级当场说清 ══════ */
const lvNames = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  P.lock();
  await new Promise(r => setTimeout(r, 150));
  const lv = project.permLevels();
  return { op: lv[0].id, opName: lv[0].name, en: lv[1].id, enName: lv[1].name };
});
await clickWd(setup.ids.en);                    // 工程师那一级的按钮 → 弹密码框
await sleep(300);
const pwDlg = await page.evaluate(() => ({
  open: !document.getElementById('permMask').classList.contains('hidden'),
  head: document.getElementById('permLevelName')?.textContent || '',
  sel: document.getElementById('permLevelSel')?.value || '',
  opts: [...document.querySelectorAll('#permLevelSel option')].map(o => o.textContent),
}));
ok('密码框里可以选「解锁哪一级」（列出全部等级，默认就是这次需要的那一级）',
  pwDlg.open && JSON.stringify(pwDlg.opts) === JSON.stringify([lvNames.opName, lvNames.enName])
  && pwDlg.sel === lvNames.en && pwDlg.head === lvNames.enName,
  JSON.stringify(pwDlg));

await page.selectOption('#permLevelSel', lvNames.op);   // 手里只有「操作员」的密码
await sleep(150);
ok('改选之后标题跟着换成选的那一级',
  (await page.textContent('#permLevelName')) === lvNames.opName, await page.textContent('#permLevelName'));
await page.fill('#permPw', '1111');
await page.click('#permOk');
await sleep(350);
const pickedLow = await page.evaluate(async () => {
  const P = await import('/js/runtime/permissions.js');
  // ⚠ 提示条是按 class 找的（`.rt-perm-toast`），没有 id
  const toast = document.querySelector('.rt-perm-toast');
  return {
    level: P.currentLevelName(),
    chip: document.getElementById('rtPermChip')?.textContent || '',
    toastEl: toast ? toast.outerHTML.slice(0, 120) : '(还没有提示条元素)',
    toast: (toast && !toast.classList.contains('hidden')) ? toast.textContent : '',
    need: document.getElementById('permMask')?.dataset.need || '',
  };
});
ok('用另一级的密码也能解锁（解锁的就是选中的那一级）',
  pickedLow.level === lvNames.opName && new RegExp(lvNames.opName).test(pickedLow.chip), JSON.stringify(pickedLow));
ok('解锁的等级**还不够**时明说一句（不再让人以为点了没反应）',
  /还不够|要/.test(pickedLow.toast) && new RegExp(lvNames.enName).test(pickedLow.toast),
  JSON.stringify(pickedLow));

// 没设密码的那一级：点确定要说清原因（不是笼统的"密码不对"）
const noPwLv = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  const rt = await import('/js/runtime/runtime.js');
  P.lock();
  const lv = project.addPermLevel({ name: '临时级' });     // 故意不设密码
  const w = project.addWidget('button', 700, 520);
  project.updateWidgetProp(w.id, 'permLevel', lv.id);
  project.updateWidgetProp(w.id, 'text', '临时按钮');
  // ⚠ 必须给它配个动作：权限门禁挂在"动作执行"那一步，没动作的按钮点了根本不进那段代码
  project.updateWidgetActions(w.id, [{ trigger: 'click', type: 'tap', params: { variable: 'bPermA' } }]);
  project.commit('没密码的等级');
  await rt.exitRun(); await rt.enterRun();
  await new Promise(r => setTimeout(r, 550));
  return { id: w.id, lv: lv.id, name: lv.name };
});
await clickWd(noPwLv.id);
await sleep(250);
await page.click('#permOk');
await sleep(250);
const noPwMsg = await page.evaluate(() => ({
  err: document.getElementById('permErr')?.textContent || '',
  shown: !document.getElementById('permErr').classList.contains('hidden'),
  open: !document.getElementById('permMask').classList.contains('hidden'),
}));
ok('选到没设密码的那一级：只按"密码不对"处理（不弹"没设密码"这类提示）',
  noPwMsg.shown && noPwMsg.err === '密码不对，再试一次' && noPwMsg.open
  && !/没设密码|解不开/.test(noPwMsg.err),
  JSON.stringify(noPwMsg));
await page.click('#permCancel');
await sleep(200);
// 收尾：把临时控件和临时等级都删掉（deleteWidgets 只吃控件 id，等级要用 deletePermLevel）
await page.evaluate(async (ids) => {
  const { project } = await import('/js/core/project.js');
  const rt = await import('/js/runtime/runtime.js');
  project.deleteWidgets([ids.w]);
  project.deletePermLevel(ids.lv);
  await rt.exitRun(); await rt.enterRun();
  await new Promise(r => setTimeout(r, 400));
}, { w: noPwLv.id, lv: noPwLv.lv });


const badgeSize = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const P = await import('/js/runtime/permissions.js');
  P.lock();
  const lvId = project.permLevels()[0].id;
  const mk = (w0, h0) => {
    const w = project.addWidget('button', 40, 40);
    project.updateWidgetProp(w.id, 'permLevel', lvId);
    project.updateWidgetField(w.id, 'w', w0);
    project.updateWidgetField(w.id, 'h', h0);
    return w.id;
  };
  const ids = { tiny: mk(34, 34), small: mk(110, 46), big: mk(450, 300) };
  project.commit('角标尺寸');
  // ⚠ 必须真的重画一遍运行画面：运行态不会因为工程数据变了就自动重建控件 DOM
  //   （不重画的话新控件压根没 DOM，读到的是 null —— 那种"通过"是假的）
  const rt = await import('/js/runtime/runtime.js');
  await rt.exitRun(); await rt.enterRun();
  await new Promise(r => setTimeout(r, 600));
  const read = (id) => {
    const el = document.querySelector(`#rtPage .wd[data-id="${id}"] .rt-perm-lock`);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { text: el.textContent, font: parseFloat(cs.fontSize), pad: parseFloat(cs.paddingLeft) };
  };
  const out = { tiny: read(ids.tiny), small: read(ids.small), big: read(ids.big) };
  project.deleteWidgets([ids.tiny, ids.small, ids.big]);
  // 删完还得再重画一次：否则这三个临时控件仍留在运行画面的 DOM 里，
  // 会盖住后面要点的其它控件（曾把第 5 段拖成点击超时）
  await rt.exitRun(); await rt.enterRun();
  await new Promise(r => setTimeout(r, 300));
  return out;
});
ok('权限角标按控件大小缩放：大控件 11px、小控件更小、很小的控件更小（都是同一个 🔒）',
  badgeSize.big && badgeSize.small && badgeSize.tiny
  && badgeSize.big.font === 11 && badgeSize.big.text === '🔒'
  && badgeSize.small.text === '🔒'
  && badgeSize.small.font < badgeSize.big.font && badgeSize.small.font > badgeSize.tiny.font
  && badgeSize.tiny.text === '🔒' && badgeSize.tiny.font < 8,
  JSON.stringify(badgeSize));

/* ══════ 5. 关掉权限管理 = 不拦；删掉等级 = 控件改回不限 ══════ */
const off = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.setPermissions({ enabled: false });
  await new Promise(r => setTimeout(r, 200));
  return {
    anyBadge: !!document.querySelector('#rtPage .wd .rt-perm-lock'),
    bRun: null,
  };
});
await clickWd(setup.ids.free);           // 「不限」按钮：关掉权限管理后应该直接执行
const v5 = await vals();
ok('关掉权限管理 → 运行态不拦（老工程行为不变）：小锁标记也没了、按钮直接执行',
  off.anyBadge === false && v5.i === 7, JSON.stringify({ off, v5 }));

const delLv = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.setPermissions({ enabled: true });
  const id = project.permLevels()[0].id;
  const cleared = project.deletePermLevel(id);
  await new Promise(r => setTimeout(r, 200));
  return {
    cleared,
    left: project.permLevels().map(l => l.name),
    opPerm: project.findWidget(window.__ids.op).props.permLevel,
    enPerm: project.findWidget(window.__ids.en).props.permLevel,
  };
});
ok('删掉某一级 → 引用它的控件属性自动改回「不限」（不会卡在不存在的等级上）',
  delLv.cleared === 1 && delLv.opPerm === '' && delLv.left.length === 1, JSON.stringify(delLv));

/* ══════ 6. 默认不自动上锁（只有刷新/关窗口 or 手动退出权限才回到未解锁）══════ */
const fresh = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { storage } = await import('/js/core/storage.js');
  storage.replaceProject({
    meta: { name: '默认值检查', canvas: { w: 800, h: 480, bg: '#fff' } },
    variables: [], pages: [{ id: 'pg_x', name: '主画面', type: 'page', widgets: [] }],
  }, '默认值检查');
  const pm = project.permissions();
  return { enabled: pm.enabled, lockAfterMin: pm.lockAfterMin };
});
ok('新工程的默认：权限管理关着、**不自动上锁**（解锁后一直有效，直到刷新/关窗口/手动退出）',
  fresh.enabled === false && fresh.lockAfterMin === 0, JSON.stringify(fresh));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 操作权限回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
