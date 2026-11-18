// verify-widgets-upgrade.mjs — 现有控件补功能回归：指示灯两态+闪烁、按钮图标/确认、
// 数值步进、表格点行写变量+跳页、时钟倒计时/累计。
//
// 每个功能都验到「属性存在 + 渲染出预期 DOM/样式 + 运行态真交互后的结果」：
//   ① lamp：只读 bool 两态（真=亮色/亮文字、假=灭色/灭文字；多状态已移除）、blink 渲染出 blink-* class（CSS 动画真的挂上）；
//   ② button：icon（emoji 与 dataURL 图片两种）渲染在文字左边；confirmText 点击先弹 confirm，
//      取消 → 动作不执行；确定 → 动作执行；
//   ③ number：± 按钮点一下按 step 改值、rangeOn 时按范围 clamp、不会弹软键盘；
//   ④ table：点第 i 行写 rowVar（bool / 数字各一例），rowJump 跳页；
//   ⑤ clock：三种模式渲染；倒计时/累计会走，timerVar 变假停住、变真继续；累计超 24h 不归零；
//   ⑥ 属性面板：新属性都在、且没有任何 hint 说明文字（现场要求）。
//
// 用法：node test/verify-widgets-upgrade.mjs
//   （自己拉起一个隔离后端：随机端口 + 临时数据目录，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
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

/* 内联小图（dataURL，不请求网络）：验按钮 icon 走 <img> 那条路 */
const ICON_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#2563eb"/></svg>');

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-widgets-upgrade-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
/* 确认框：按当前模式自动确定/取消，并把弹出的文字记下来 */
const dialogs = [];
let dialogMode = 'accept';
page.on('dialog', async (d) => {
  dialogs.push({ message: d.message(), type: d.type() });
  try { if (dialogMode === 'accept') await d.accept(); else await d.dismiss(); } catch { /* 已关 */ }
});
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* ═══════════ 0. 造数据：变量 + 9 个控件（页面1）+ 1 个跳页标记（页面2）═══════════ */
const S = await page.evaluate(() => {
  const m = window.app.project;
  const pages = m.pages().filter(p => p.type === 'page');
  const page1 = pages[0], page2 = pages[1];
  if (!page1 || !page2) throw new Error('演示工程里至少要有两个普通页');
  m.setCurrentPage(page1.id);
  // 变量：地址留空 = 内部变量（不碰设备）
  const vars = [
    ['bLamp', 'bool', false], ['bLampState', 'bool', true], ['bBtnVal', 'bool', false],
    ['rNum', 'real', 5], ['bRow', 'bool', false], ['rRow', 'real', 0], ['bClock', 'bool', false],
  ];
  vars.forEach(([name, type, value]) => {
    const old = m.data.variables.find(v => v.name === name);
    if (old) { old.type = type; old.value = value; old.address = ''; }
    else m.data.variables.push({ name, type, address: '', value });
  });
  m.commit('控件增强套件：变量');
  // ⚠ 必须在 addWidget 之前 resetFrom：画布是按变量当前值渲染的，resetFrom(name:null) 不会回头刷新已建控件
  window.app.varStore.resetFrom(m.variables());
  const mk = (type, x, y) => m.addWidget(type, x, y);
  // ① 指示灯（只读 bool 两态）：亮着 + 慢闪 / 灭着 + 快闪（闪烁只在亮时生效）
  const lampState = mk('lamp', 30, 30);
  m.updateWidgetField(lampState.id, 'bindings.variable', 'bLampState');
  m.updateWidgetProp(lampState.id, 'onText', '运行');
  m.updateWidgetProp(lampState.id, 'offText', '停机');
  m.updateWidgetProp(lampState.id, 'blink', 'slow');
  const lampBool = mk('lamp', 120, 30);
  m.updateWidgetField(lampBool.id, 'bindings.variable', 'bLamp');
  m.updateWidgetProp(lampBool.id, 'blink', 'fast');
  // ② 按钮：图标 + 确认文字 + setValue 动作
  const btn = mk('button', 30, 110);
  m.updateWidgetProp(btn.id, 'showState', false);   // 兼容旧调用；下行旧 text 会映射到未满文字
  m.updateWidgetProp(btn.id, 'text', '启动');
  m.updateWidgetProp(btn.id, 'icon', '▶');
  m.updateWidgetProp(btn.id, 'iconSize', 22);
  m.updateWidgetProp(btn.id, 'confirmText', '确认启动？');
  m.updateWidgetActions(btn.id, [{ trigger: 'click', type: 'setValue', params: { variable: 'bBtnVal', value: 'true' } }]);
  // ③ 数值：步进 ±1
  const num = mk('number', 30, 190);
  m.updateWidgetField(num.id, 'bindings.variable', 'rNum');
  m.updateWidgetProp(num.id, 'stepper', true);
  m.updateWidgetProp(num.id, 'step', 1);
  // ④ 表格：bool 行 / 数字行
  const tb = mk('table', 300, 30);
  m.updateWidgetProp(tb.id, 'rows', 2);
  m.updateWidgetProp(tb.id, 'cols', 2);
  m.updateWidgetProp(tb.id, 'rowVar', 'bRow');
  m.updateWidgetProp(tb.id, 'rowValues', 'true\nfalse');
  const tn = mk('table', 300, 200);
  m.updateWidgetProp(tn.id, 'rows', 2);
  m.updateWidgetProp(tn.id, 'cols', 2);
  m.updateWidgetProp(tn.id, 'rowVar', 'rRow');
  m.updateWidgetProp(tn.id, 'rowValues', '10\n20');
  // ⑤ 时钟：当前时间 / 倒计时(10s，bClock 为真才走) / 累计(从 25h 起，验超 24h 不归零)
  const clkCur = mk('clock', 620, 30);
  const clkCount = mk('clock', 620, 100);
  m.updateWidgetProp(clkCount.id, 'mode', 'countdown');
  m.updateWidgetProp(clkCount.id, 'timerStartSec', 10);
  m.updateWidgetProp(clkCount.id, 'timerVar', 'bClock');
  const clkCum = mk('clock', 620, 170);
  m.updateWidgetProp(clkCum.id, 'mode', 'cumulative');
  m.updateWidgetProp(clkCum.id, 'timerStartSec', 90000);   // 25 小时
  // 页面2 的标记控件（验 rowJump 真跳过去了）
  m.setCurrentPage(page2.id);
  const mark = m.addWidget('label', 40, 40);
  m.updateWidgetProp(mark.id, 'text', 'PAGE2MARK');
  m.commit('控件增强套件：标记');
  m.setCurrentPage(page1.id);
  m.commit('控件增强套件：控件');
  return {
    page1: page1.id, page2: page2.id,
    lampState: lampState.id, lampBool: lampBool.id, btn: btn.id, num: num.id,
    tb: tb.id, tn: tn.id, clkCur: clkCur.id, clkCount: clkCount.id, clkCum: clkCum.id,
  };
});
await sleep(500);

/* ── 通用小工具 ── */
async function selectWidget(id) {
  await page.evaluate(async (wid) => {
    const { select } = await import('/js/editor/canvas.js');
    select([wid]);
  }, id);
  await sleep(120);
}
const propOf = (id, key) => page.evaluate(([id, key]) => {
  const w = window.app.project.getWidget(id);
  return w ? w.props[key] : undefined;
}, [id, key]);
const setProps = async (id, patch) => {
  await page.evaluate(([id, patch]) => {
    const { project } = window.app;
    Object.keys(patch).forEach(k => project.updateWidgetProp(id, k, patch[k]));
  }, [id, patch]);
  await sleep(120);
};
const setVar = async (name, value) => {
  await page.evaluate(async ([name, value]) => {
    const { varStore } = await import('/js/runtime/varstore.js');
    varStore.set(name, value);
  }, [name, value]);
  await sleep(150);
};
const varOf = (name) => page.evaluate((name) => window.app.varStore.get(name), name);
/** 运行态某控件里的某个选择器（不存在就 null 摘要） */
const runNode = (id, sel) => page.evaluate(([id, sel]) => {
  const root = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  if (!root) return null;
  const el = root.querySelector(sel);
  if (!el) return { missing: true };
  const cs = getComputedStyle(el);
  return {
    cls: el.className, text: el.textContent.trim(), tag: el.tagName,
    bg: cs.backgroundColor, anim: cs.animationName, fontSize: cs.fontSize,
    src: el.getAttribute('src') || '', hasFmt: el.hasAttribute('data-clock-fmt'),
  };
}, [id, sel]);
const clickIn = async (id, sel) => {
  await page.click(`#rtPage .wd[data-id="${id}"] ${sel}`);
  await sleep(250);
};

/* ═══════════ 1. 编辑态：新属性的渲染（两态颜色/文字 / 闪烁 class / 图标 / ± / 时钟三模式）═══════════ */
const editLamp = await page.evaluate((id) => {
  const root = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  const el = root ? root.querySelector('.w-lamp') : null;
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { cls: el.className, bg: cs.backgroundColor, anim: cs.animationName, text: root.textContent.trim() };
}, S.lampState);
ok('★ 编辑态：指示灯只读 bool 两态 —— 变量为真 → 亮色(rgb 34,197,94) + 亮时文字「运行」+ blink=slow',
  !!editLamp && editLamp.cls.indexOf('blink-slow') >= 0
  && editLamp.bg === 'rgb(34, 197, 94)' && editLamp.text === '运行'
  && editLamp.anim === 'w-lamp-blink-slow',
  JSON.stringify(editLamp));
const editBtn = await page.evaluate((id) => {
  const root = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  if (!root) return null;
  const ic = root.querySelector('.w-btn-icon');
  return {
    text: root.querySelector('.w-btn') ? root.querySelector('.w-btn').textContent.trim() : '',
    hasIcon: !!ic, iconTag: ic ? ic.tagName : '', iconText: ic ? ic.textContent : '',
    iconFont: ic ? getComputedStyle(ic).fontSize : '',
  };
}, S.btn);
ok('★ 编辑态：按钮 icon（emoji）显示在文字左边、iconSize 生效、文字仍完整',
  !!editBtn && editBtn.hasIcon && editBtn.iconTag === 'SPAN' && editBtn.iconText === '▶'
  && editBtn.iconFont === '22px' && editBtn.text.indexOf('启动') >= 0,
  JSON.stringify(editBtn));
await setProps(S.btn, { icon: ICON_URL });
const editBtnImg = await page.evaluate((id) => {
  const root = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  const ic = root ? root.querySelector('.w-btn-icon') : null;
  return ic ? { tag: ic.tagName, src: ic.getAttribute('src') || '' } : null;
}, S.btn);
ok('★ 编辑态：按钮 icon 填图片 dataURL 时渲染成 <img>（不是当文字）',
  !!editBtnImg && editBtnImg.tag === 'IMG' && editBtnImg.src.startsWith('data:image/svg'), JSON.stringify(editBtnImg));
await setProps(S.btn, { icon: '▶' });
const editNum = await page.evaluate((id) => {
  const root = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  if (!root) return null;
  const btns = [...root.querySelectorAll('.wn-step')];
  return {
    n: btns.length, dirs: btns.map(b => b.getAttribute('data-step')),
    texts: btns.map(b => b.textContent), val: root.querySelector('.wn-val') ? root.querySelector('.wn-val').textContent : '',
  };
}, S.num);
ok('★ 编辑态：数值控件 stepper 勾上后值两侧渲染 −/+ 两个按钮',
  !!editNum && editNum.n === 2 && editNum.dirs.join(',') === '-1,1' && editNum.val === '5.0',
  JSON.stringify(editNum));
const editTable = await page.evaluate((id) => {
  const root = document.querySelector(`#canvas .wd[data-id="${id}"]`);
  if (!root) return null;
  return {
    rows: [...root.querySelectorAll('tbody tr')].map(tr => tr.getAttribute('data-row')),
    rowVar: window.app.project.getWidget(id).props.rowVar,
    rowValues: window.app.project.getWidget(id).props.rowValues,
  };
}, S.tb);
ok('★ 编辑态：表格每行带 data-row 序号，行变量/行值属性就位',
  !!editTable && editTable.rows.join(',') === '0,1'
  && editTable.rowVar === 'bRow' && editTable.rowValues === 'true\nfalse',
  JSON.stringify(editTable));
const editClocks = await page.evaluate((ids) => {
  const out = {};
  Object.keys(ids).forEach(k => {
    const root = document.querySelector(`#canvas .wd[data-id="${ids[k]}"]`);
    const t = root ? root.querySelector('.wc-time') : null;
    out[k] = t ? { text: t.textContent, hasFmt: t.hasAttribute('data-clock-fmt') } : null;
  });
  return out;
}, { cur: S.clkCur, count: S.clkCount, cum: S.clkCum });
ok('★ 编辑态：时钟三种模式都渲染 —— 当前时间走时间格式、倒计时 00:00:10、累计从 25h 起（不归零）',
  !!editClocks.cur && editClocks.cur.hasFmt
  && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(editClocks.cur.text)
  && !!editClocks.count && !editClocks.count.hasFmt && editClocks.count.text === '00:00:10'
  && !!editClocks.cum && !editClocks.cum.hasFmt && editClocks.cum.text.indexOf('25:00:') === 0,
  JSON.stringify(editClocks));

/* ═══════════ 2. 属性面板：新属性都在、且没有任何 hint 说明文字 ═══════════ */
const EXPECT = {
  [S.lampState]: ['blink'],
  [S.btn]: ['icon', 'iconSize'],
  [S.num]: ['stepper', 'step'],
  [S.tb]: ['rowVar', 'rowValues', 'rowJump'],
  [S.clkCount]: ['mode', 'timerVar', 'timerStartSec'],
};
const panelInfo = {};
for (const id of Object.keys(EXPECT)) {
  await selectWidget(id);
  panelInfo[id] = await page.evaluate(() => ({
    props: [...document.querySelectorAll('#propBody [data-prop]')].map(e => e.dataset.prop),
    text: document.getElementById('propBody').textContent || '',
  }));
}
const panelOK = Object.keys(EXPECT).every(id =>
  EXPECT[id].every(k => panelInfo[id].props.includes(k)));
ok('★ 属性面板：五类控件的新属性都长出了输入格（blink、icon/iconSize、stepper/step、rowVar/rowValues/rowJump、mode/timerVar/timerStartSec）',
  panelOK, JSON.stringify(Object.keys(EXPECT).map(id => [id.slice(0, 6), panelInfo[id].props])));
// 按钮「确认文字」属性已按现场要求从面板删掉（老工程里存过的 confirmText 仍然生效，见第 4 段运行态）
ok('★ 属性面板：按钮已经没有「确认文字」这一行',
  panelInfo[S.btn].props.indexOf('confirmText') < 0 && !/确认文字/.test(panelInfo[S.btn].text),
  JSON.stringify(panelInfo[S.btn].props));
// 指示灯：多状态已移除（属性面板里没有 states），binding 只接受 bool
const lampSchema = await page.evaluate(async () => {
  const { registry } = await import('/js/widgets/registry.js');
  const def = registry.get('lamp');
  return {
    props: (def ? def.props : []).map(p => p.key),
    types: (def && def.binding && def.binding.variable ? def.binding.variable.types : []) || [],
    defaults: def ? Object.keys(def.defaults || {}) : [],
  };
});
const lampPanelProps = panelInfo[S.lampState] ? panelInfo[S.lampState].props : [];
ok('★ 指示灯多状态已移除：没有 states 属性/默认值；binding 只接受 bool（两态）',
  lampSchema.props.indexOf('states') < 0 && lampSchema.defaults.indexOf('states') < 0
  && JSON.stringify(lampSchema.types) === JSON.stringify(['bool'])
  && lampPanelProps.indexOf('states') < 0 && lampPanelProps.indexOf('blink') >= 0,
  JSON.stringify(lampSchema));
const schemaNoHint = await page.evaluate(async (types) => {
  const { registry } = await import('/js/widgets/registry.js');
  const out = {};
  types.forEach(t => {
    const def = registry.get(t);
    const withHint = (def && def.props ? def.props : []).filter(p => p && p.hint).map(p => p.key);
    out[t] = { withHint, n: def ? (def.props || []).length : -1 };
  });
  return out;
}, ['lamp', 'button', 'number', 'table', 'clock']);
ok('★ 属性面板：这五类控件的 props 一律没有 hint（现场要求：控件属性里不摆说明文字）',
  Object.keys(schemaNoHint).every(t => schemaNoHint[t].n > 0 && schemaNoHint[t].withHint.length === 0),
  JSON.stringify(schemaNoHint));
const i18nDecl = await page.evaluate(async () => {
  const { registry } = await import('/js/widgets/registry.js');
  const lamp = registry.get('lamp'), btn = registry.get('button');
  const pick = (def, key) => {
    const hit = (def ? def.props : []).find(p => p.key === key);
    return hit ? hit.i18n || '' : '';
  };
  return { onText: pick(lamp, 'onText'), offText: pick(lamp, 'offText'),
    confirm: pick(btn, 'confirmText'),
    hasConfirm: (btn ? btn.props : []).some(p => p.key === 'confirmText'),
    btnTexts: [pick(btn, 'onText'), pick(btn, 'offText')] };
});
ok('★ 文字类属性声明了 i18n（指示灯 亮/灭文字=text、按钮 满足/未满文字=text）；「确认文字」已从 props 移除',
  i18nDecl.onText === 'text' && i18nDecl.offText === 'text'
  && i18nDecl.btnTexts[0] === 'text' && i18nDecl.btnTexts[1] === 'text'
  && i18nDecl.confirm === '' && i18nDecl.hasConfirm === false,
  JSON.stringify(i18nDecl));

/* ═══════════ 3. 运行态：指示灯只按 bool 两态（真亮/假灭）+ 闪烁开关 ═══════════ */
await page.evaluate(() => window.app.enterRun());
await sleep(500);
const runLampOn = await runNode(S.lampState, '.w-lamp');
const runLampOnTxt = await page.evaluate((id) => {
  const root = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return root ? root.textContent.trim() : '';
}, S.lampState);
ok('★ 运行态：变量为真 → 亮色 + 亮时文字「运行」，blink=slow 挂上并跑 CSS 动画',
  !!runLampOn && runLampOn.cls.indexOf('blink-slow') >= 0
  && runLampOn.bg === 'rgb(34, 197, 94)' && runLampOnTxt === '运行'
  && runLampOn.anim === 'w-lamp-blink-slow',
  JSON.stringify({ lamp: runLampOn, text: runLampOnTxt }));
await setVar('bLampState', false);
const runLampOff = await runNode(S.lampState, '.w-lamp');
const runLampOffTxt = await page.evaluate((id) => {
  const root = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return root ? root.textContent.trim() : '';
}, S.lampState);
ok('★ 运行态：变量为假 → 灭色 + 灭时文字「停机」，且**灭灯不闪**（无 blink class）',
  !!runLampOff && runLampOff.bg === 'rgb(156, 163, 175)'
  && runLampOffTxt === '停机' && runLampOff.cls.indexOf('blink') < 0,
  JSON.stringify({ lamp: runLampOff, text: runLampOffTxt }));
// 老工程残留的 props.states 一律忽略（多状态已移除，仍按 bool 两态画）
await page.evaluate(i => {
  const w = window.app.project.getWidget(i);
  w.props.states = '1=#f59e0b=报警';      // 老工程残留键（已不是 lamp 的属性）
  window.app.project.commit('残留 states');
}, S.lampState);
await setVar('bLampState', true);
const runLampCompat = await runNode(S.lampState, '.w-lamp');
const runLampCompatTxt = await page.evaluate((id) => {
  const root = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  return root ? root.textContent.trim() : '';
}, S.lampState);
ok('★ 老工程残留 props.states 被忽略：为真仍是亮色 + 亮时文字（不会映射成「报警」）',
  !!runLampCompat && runLampCompat.bg === 'rgb(34, 197, 94)' && runLampCompatTxt === '运行',
  JSON.stringify({ lamp: runLampCompat, text: runLampCompatTxt }));
const lampBoolOff = await runNode(S.lampBool, '.w-lamp');
await setVar('bLamp', true);
const lampBoolOn = await runNode(S.lampBool, '.w-lamp');
ok('★ 运行态：blink=fast 只在「亮着」时闪（灭时无 blink class，亮时挂上并跑 CSS 动画）',
  !!lampBoolOff && lampBoolOff.cls.indexOf('blink') < 0
  && !!lampBoolOn && lampBoolOn.cls.indexOf('blink-fast') >= 0 && lampBoolOn.anim === 'w-lamp-blink-fast',
  JSON.stringify({ off: lampBoolOff && lampBoolOff.cls, on: lampBoolOn && lampBoolOn.cls }));

/* ═══════════ 4. 运行态：按钮 icon + confirmText 确认框 ═══════════ */
const runBtnIcon = await runNode(S.btn, '.w-btn-icon');
const runBtnText = await page.evaluate((id) => {
  const root = document.querySelector(`#rtPage .wd[data-id="${id}"]`);
  const b = root ? root.querySelector('.w-btn') : null;
  return b ? b.textContent.trim() : '';
}, S.btn);
ok('★ 运行态：按钮图标在文字左边（▶ 启动）',
  !!runBtnIcon && runBtnIcon.text === '▶' && runBtnText === '▶启动',
  JSON.stringify({ icon: runBtnIcon, text: runBtnText }));
await setVar('bBtnVal', false);
dialogs.length = 0;
dialogMode = 'accept';
await clickIn(S.btn, '.w-btn');
await sleep(250);
ok('★ 确认文字生效：点按钮先弹 confirm（文字对），点「确定」后动作执行（变量写成 true）',
  dialogs.length === 1 && dialogs[0].message === '确认启动？'
  && (await varOf('bBtnVal')) === true,
  JSON.stringify({ dialogs, val: await varOf('bBtnVal') }));
await setVar('bBtnVal', false);
dialogs.length = 0;
dialogMode = 'dismiss';
await clickIn(S.btn, '.w-btn');
await sleep(250);
ok('★ 确认框点「取消」→ 动作不执行（变量保持 false）',
  dialogs.length === 1 && dialogs[0].message === '确认启动？'
  && (await varOf('bBtnVal')) === false,
  JSON.stringify({ dialogs, val: await varOf('bBtnVal') }));

/* ═══════════ 5. 运行态：数值 ± 步进（改值 / 范围 clamp / 不弹软键盘）═══════════ */
await setVar('rNum', 5);
await clickIn(S.num, '.wn-step[data-step="1"]');
const nPlus = await varOf('rNum');
await clickIn(S.num, '.wn-step[data-step="-1"]');
const nMinus = await varOf('rNum');
ok('★ 数值步进：点 + 按 step(+1) 变成 6，再点 − 回到 5',
  nPlus === 6 && nMinus === 5, JSON.stringify({ afterPlus: nPlus, afterMinus: nMinus }));
const padHidden = await page.evaluate(() => {
  const pad = document.getElementById('numPad');
  const mask = document.getElementById('npMask');
  return { padHidden: pad ? pad.classList.contains('hidden') : null,
    maskHidden: mask ? mask.classList.contains('hidden') : null };
});
ok('★ 数值步进：点 ± 不会弹软键盘（stopPropagation 拦住「点整块开键盘」）',
  padHidden.padHidden === true && padHidden.maskHidden === true, JSON.stringify(padHidden));
// 范围限制：0~10，越界要 clamp（固定值模式）
await setProps(S.num, { rangeOn: true, rangeMinValue: '0', rangeMaxValue: '10' });
await setVar('rNum', 10);
await clickIn(S.num, '.wn-step[data-step="1"]');
const nClampHi = await varOf('rNum');
await setVar('rNum', 9.5);
await clickIn(S.num, '.wn-step[data-step="1"]');
const nClampHi2 = await varOf('rNum');
await setVar('rNum', 0);
await clickIn(S.num, '.wn-step[data-step="-1"]');
const nClampLo = await varOf('rNum');
ok('★ 数值步进：rangeOn 时按范围 clamp（10+1→10、9.5+1→10、0−1→0）',
  nClampHi === 10 && nClampHi2 === 10 && nClampLo === 0,
  JSON.stringify({ hi: nClampHi, hi2: nClampHi2, lo: nClampLo }));
await setProps(S.num, { rangeOn: false });

/* ═══════════ 6. 运行态：表格点行写变量 + rowJump 跳页 ═══════════ */
await page.click(`#rtPage .wd[data-id="${S.tb}"] tbody tr[data-row="0"] td`);
await sleep(250);
const rowBool0 = await varOf('bRow');
await page.click(`#rtPage .wd[data-id="${S.tb}"] tbody tr[data-row="1"] td`);
await sleep(250);
const rowBool1 = await varOf('bRow');
ok('★ 表格点行写 bool 变量：第 1 行写 true、第 2 行写 false',
  rowBool0 === true && rowBool1 === false, JSON.stringify({ row0: rowBool0, row1: rowBool1 }));
await page.click(`#rtPage .wd[data-id="${S.tn}"] tbody tr[data-row="0"] td`);
await sleep(250);
const rowNum0 = await varOf('rRow');
await page.click(`#rtPage .wd[data-id="${S.tn}"] tbody tr[data-row="1"] td`);
await sleep(250);
const rowNum1 = await varOf('rRow');
ok('★ 表格点行写数字变量：第 1 行写 10、第 2 行写 20（按数字写，不是字符串）',
  rowNum0 === 10 && rowNum1 === 20, JSON.stringify({ row0: rowNum0, row1: rowNum1 }));
// rowJump：点行 → 跳页（页面2 上有 PAGE2MARK）
await setProps(S.tb, { rowJump: S.page2 });
await page.click(`#rtPage .wd[data-id="${S.tb}"] tbody tr[data-row="0"] td`);
await sleep(500);
const jumped = await page.evaluate(() => {
  const rt = document.getElementById('rtPage');
  return rt ? rt.textContent.indexOf('PAGE2MARK') >= 0 : false;
});
ok('★ 表格 rowJump：点行真的跳到目标页（运行态出现页面2 的标记控件）', jumped === true, String(jumped));
await page.evaluate((id) => window.__hmiRuntime.gotoPage(id), S.page1);
await sleep(500);

/* ═══════════ 7. 运行态：时钟三种模式 / 倒计时 / 累计 / timerVar 真假 ═══════════ */
const clkCurRun = await runNode(S.clkCur, '.wc-time');
ok('★ 时钟：当前时间模式仍走 data-clock-fmt + 时间格式（老行为不变）',
  !!clkCurRun && clkCurRun.hasFmt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(clkCurRun.text),
  JSON.stringify(clkCurRun));
const clkText = async (id) => {
  const t = await runNode(id, '.wc-time');
  return t && !t.missing ? t : null;
};
const c0 = await clkText(S.clkCount);
await sleep(800);
const c0b = await clkText(S.clkCount);
ok('★ 时钟：倒计时 timerVar 为假 → 停住不动（800ms 后仍是 00:00:10）',
  !!c0 && c0.text === '00:00:10' && !!c0b && c0b.text === '00:00:10',
  JSON.stringify({ a: c0 && c0.text, b: c0b && c0b.text }));
await setVar('bClock', true);
await sleep(1300);
const c1 = await clkText(S.clkCount);
const secLeft = (txt) => {
  const m = /^(\d+):(\d+):(\d+)$/.exec(txt || '');
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : -1;
};
ok('★ 时钟：倒计时 timerVar 为真 → 开始倒数（1.3s 后剩余 <10s 且 ≥6s）',
  !!c1 && !c1.hasFmt && secLeft(c1.text) < 10 && secLeft(c1.text) >= 6,
  JSON.stringify(c1));
await setVar('bClock', false);
const c2 = await clkText(S.clkCount);
await sleep(800);
const c2b = await clkText(S.clkCount);
ok('★ 时钟：倒计时 timerVar 变假 → 当场停住（800ms 后数字不变）',
  !!c2 && !!c2b && c2b.text === c2.text, JSON.stringify({ a: c2 && c2.text, b: c2b && c2b.text }));
const cum0 = await clkText(S.clkCum);
await sleep(1300);
const cum1 = await clkText(S.clkCum);
ok('★ 时钟：累计模式会走（无 timerVar = 一直走），且从 25h 起不回零（超 24h 照常累计）',
  !!cum0 && /^25:00:\d{2}$/.test(cum0.text) && !!cum1 && /^25:00:\d{2}$/.test(cum1.text)
  && secLeft(cum1.text) >= secLeft(cum0.text) + 1,
  JSON.stringify({ a: cum0 && cum0.text, b: cum1 && cum1.text }));
// 倒计时到 0 停住：把起始秒改小不行（attach 已按 10s），这里只验证"变假保留已走时间"已覆盖
await page.evaluate(() => window.app.exitRun());
await sleep(300);

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
try { srv.kill(); } catch { /* 忽略 */ }
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 现有控件增强回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
