// verify-lamp-text.mjs — 指示灯双状态文字 + 可见宽度 + 运行态无输入光标（弹窗层也要覆盖）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });

/* 后端隔离：stub probe 强制本地模拟（8866 在线时 readVars 残留值会污染测试）
   ⚠ 只 stub probe 不够：后端配置成 plc 模式时 expectsServer() 仍为 true，
     写一个「没地址的变量」会失败 → varStore.push 的 resync 把值读回来盖掉，
     看着就像「变量置 true 没反应」。所以读写四个口子一起 stub（同 verify-button-state）。 */
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
  m.backend.readVar = async () => undefined;
  m.backend.expectsServer = () => false;
}));

/* ── 准备：
   lampOld    无任何文字键（老工程）→ 纯灯
   lampLegacy 仅 text 键（第14轮控件）→ 两态回落同文
   lampDual   offText/onText 双状态文字
   lampFix    固化空串（offText=''+onText='' 但有旧 text）→ 不回落
   lampB      下方布局（足够高度）                                     ── */
const ids = await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  m.project.data.variables.length = 0;
  m.project.addVariable(); m.project.updateVariable('var1', { name: 'bRun', type: 'bool', value: false });
  const mk = (patch, pos, size) => {
    const w = m.project.addWidget('lamp', pos, size);
    if (size) { m.project.updateWidgetField(w.id, 'w', size.w); m.project.updateWidgetField(w.id, 'h', size.h); }
    m.project.updateWidgetField(w.id, 'bindings.variable', patch.bind ?? '');
    Object.entries(patch.props || {}).forEach(([k, v]) => m.project.updateWidgetProp(w.id, k, v));
    (patch.del || []).forEach(k => delete w.props[k]);   // 模拟旧版本控件（缺新键）
    return w.id;
  };
  const lampOld = mk({ del: ['offText', 'onText'] }, 40);
  const lampLegacy = mk({ bind: 'bRun', props: { text: '运行' }, del: ['offText', 'onText'] }, 180);
  const lampDual = mk({ bind: 'bRun', props: { offText: '停止', onText: '运行' } }, 340);
  const lampFix = mk({ props: { text: '旧', offText: '', onText: '' }, del: [] }, 500);
  const lampB = mk({ props: { offText: '报警', textPos: 'bottom' } }, 640, { w: 110, h: 76 });
  const lampL = mk({ bind: 'bRun', props: { offText: '左字', textPos: 'left' } }, 800, { w: 110, h: 50 });   // left 布局需宽度空间
  const lampIn = mk({ bind: 'bRun', props: { offText: '停', onText: '行', textPos: 'inside' } }, 950);
  const inp = m.project.addWidget('input', 1100, 40).id;   // 数据输入控件（光标例外验证）
  m.project.commit('测试指示灯');
  return { lampOld, lampLegacy, lampDual, lampFix, lampB, lampL, lampIn, inp };
})());
await page.waitForTimeout(150);

/* 隔离渲染：直接调 def.render */
const renderLamp = (wid, val) => page.evaluate(async ([wid, val]) => {
  const m = await import('/js/core/project.js');
  const r = await import('/js/widgets/registry.js');
  const w = m.project.getWidget(wid);
  return r.registry.get('lamp').render(w, 'run', { get: () => val });
}, [wid, val]);

/* ── A0. 新建默认值：50×50 + 文字默认「里面」 ── */
const dft = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.addWidget('lamp', 1250, 50);
  m.project.deleteWidgets([w.id]);
  // 几何字段取 w.w / w.h（props 里不再冗余存一份 w/h）
  return { w: w.w, h: w.h, pos: w.props.textPos };
});
ok('默认：尺寸 50×50', dft.w === 50 && dft.h === 50, JSON.stringify(dft));
ok('默认：文字位置 = 里面', dft.pos === 'inside', dft.pos);

/* ── A. 渲染层：双状态文字 ── */
let h = await renderLamp(ids.lampOld, true);
ok('老工程无文字键 → 纯灯无标签', h.includes('w-lamp') && !h.includes('lamp-text'), h.slice(0, 60));
h = await renderLamp(ids.lampDual, false);
ok('双状态：灭 → 显示灭时文字「停止」', h.includes('lamp-text') && h.includes('停止') && !h.includes('运行'));
ok('双状态默认文字位置 = 里面（lamp-in）', h.includes('lamp-in'));
h = await renderLamp(ids.lampDual, true);
ok('双状态：亮 → 显示亮时文字「运行」', h.includes('lamp-text') && h.includes('运行') && !h.includes('停止'));
ok('灯亮 → 点亮色生效', h.includes('#22c55e'), h.match(/background:[^;]+/)?.[0]);
h = await renderLamp(ids.lampLegacy, false);
ok('第14轮控件（仅 text 键）：灭 → 回落旧 text', h.includes('lamp-text') && h.includes('运行'));
h = await renderLamp(ids.lampLegacy, true);
ok('第14轮控件：亮 → 同样回落旧 text', h.includes('lamp-text') && h.includes('运行'));
h = await renderLamp(ids.lampFix, false);
ok('固化空串：灭态不回落旧 text → 纯灯', !h.includes('lamp-text'));
h = await renderLamp(ids.lampFix, true);
ok('固化空串：亮态也不回落 → 纯灯', !h.includes('lamp-text'));
h = await renderLamp(ids.lampB, false);
ok('下方文字 → lamp-v 布局类', h.includes('lamp-v'));
ok('灯灭 → 熄灭色生效', h.includes('#9ca3af'));
h = await renderLamp(ids.lampL, false);
ok('左侧文字 → lamp-l 布局类', h.includes('lamp-l') && !h.includes('lamp-v'));
h = await renderLamp(ids.lampIn, true);
ok('里面文字 → lamp-in 布局类', h.includes('lamp-in'));

/* ── B. 编辑器画布：文字必须真的可见（本轮 bug 核心）+ 灯正圆 ── */
const canvasGeom = await page.evaluate((ids) => {
  const g = (id) => {
    const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
    if (!el) return null;
    const lamp = el.querySelector('.w-lamp');
    const txt = el.querySelector('.lamp-text');
    return {
      lamp: lamp ? [lamp.offsetWidth, lamp.offsetHeight, lamp.offsetLeft] : null,
      textW: txt ? txt.offsetWidth : null,
      textX: txt ? txt.offsetLeft : null,
      wdW: el.offsetWidth,
    };
  };
  return { dual: g(ids.lampDual), legacy: g(ids.lampLegacy), bottom: g(ids.lampB), left: g(ids.lampL), inside: g(ids.lampIn) };
}, ids);
ok('画布：双状态灯文字可见宽度 > 0', canvasGeom.dual.textW > 0, `textW=${canvasGeom.dual.textW}`);
ok('画布：双状态默认 50×50 且灯占满（里面模式）', canvasGeom.dual.lamp &&
  canvasGeom.dual.wdW === 50 && Math.abs(canvasGeom.dual.lamp[0] - 50) <= 2, `wdW=${canvasGeom.dual.wdW} lamp=${canvasGeom.dual.lamp}`);
ok('画布：50×50 里灯是正圆', canvasGeom.dual.lamp && Math.abs(canvasGeom.dual.lamp[0] - canvasGeom.dual.lamp[1]) <= 2,
  `lamp=${canvasGeom.dual.lamp}`);
ok('画布：灯是正圆（宽=高）', canvasGeom.dual.lamp && Math.abs(canvasGeom.dual.lamp[0] - canvasGeom.dual.lamp[1]) <= 2,
  `lamp=${canvasGeom.dual.lamp}`);
ok('画布：第14轮控件文字也可见', canvasGeom.legacy.textW > 0, `textW=${canvasGeom.legacy.textW}`);
ok('画布：下方布局文字可见 + 灯近正圆', canvasGeom.bottom.textW > 0 && canvasGeom.bottom.lamp &&
  Math.abs(canvasGeom.bottom.lamp[0] - canvasGeom.bottom.lamp[1]) <= 3, `textW=${canvasGeom.bottom.textW} lamp=${canvasGeom.bottom.lamp}`);
ok('画布：左侧布局文字可见且灯贴右（textX < lampX）', canvasGeom.left.textW > 0 &&
  canvasGeom.left.textX < canvasGeom.left.lamp[2], `textX=${canvasGeom.left.textX} lampX=${canvasGeom.left.lamp?.[2]}`);
ok('画布：里面布局灯占满控件宽', canvasGeom.inside.lamp &&
  Math.abs(canvasGeom.inside.lamp[0] - canvasGeom.inside.wdW) <= 2, `lampW=${canvasGeom.inside.lamp?.[0]} wdW=${canvasGeom.inside.wdW}`);
ok('画布：里面布局文字可见且居中叠在灯上', canvasGeom.inside.textW > 0 &&
  canvasGeom.inside.textX > canvasGeom.inside.lamp[2] &&
  canvasGeom.inside.textX + canvasGeom.inside.textW < canvasGeom.inside.lamp[2] + canvasGeom.inside.lamp[0],
  `textX=${canvasGeom.inside.textX} textW=${canvasGeom.inside.textW}`);

/* ── B2. 点亮时的光晕不能被裁成方块（像素级验证，不看样式名）──
   成因：.wd-body{overflow:hidden} 把画在圆外面的 box-shadow 裁掉了，
   圆灯四角于是各透出一小块淡色 —— 看着就是「圆灯后面有个微弱的正方形」。
   判据：灯亮时，控件框**外面**必须看得到光；老实现该处与关灯时完全一样。 */
const lampBox = await page.locator(`#canvas .wd[data-id="${ids.lampDual}"]`).boundingBox();
const PAD = 8;
const clip = {
  x: Math.round(lampBox.x - PAD), y: Math.round(lampBox.y - PAD),
  width: Math.round(lampBox.width + PAD * 2 + 26), height: Math.round(lampBox.height + PAD * 2),
};
const setRun = (v) => page.evaluate(async (val) => {
  (await import('/js/runtime/varstore.js')).varStore.set('bRun', val, 'remote');
}, v);
await setRun(false);
await page.waitForTimeout(200);
const shotOff = (await page.screenshot({ clip })).toString('base64');
await setRun(true);
await page.waitForTimeout(200);
const shotOn = (await page.screenshot({ clip })).toString('base64');
const halo = await page.evaluate(async ([a, b, box, pad]) => {
  const load = async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx;
  };
  const ca = await load(a), cb = await load(b);
  const at = (ctx, x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
  const midX = pad + box.width / 2, midY = pad + box.height / 2;
  const out = 4;                       // 控件框外 4px（光晕 12px，这里一定该被染到）
  const probe = (x, y) => ({ off: at(ca, x, y), on: at(cb, x, y) });
  return {
    right: probe(pad + box.width + out, midY),
    left: probe(pad - out, midY),
    top: probe(midX, pad - out),
    bottom: probe(midX, pad + box.height + out),
    // 对照：框外 22px 已超出光晕范围，必须还是背景
    far: probe(pad + box.width + 22, midY),
  };
}, [shotOff, shotOn, { width: lampBox.width, height: lampBox.height }, PAD]);
const sum = (c) => c[0] + c[1] + c[2];
const escaped = ['right', 'left', 'top', 'bottom'].filter(k => sum(halo[k].on) !== sum(halo[k].off));
ok('点亮的光晕四边都能跑到控件框外面（没被 overflow:hidden 裁成方块）',
  escaped.length === 4, `溢出边数 ${escaped.length}/4：` +
  ['right', 'left', 'top', 'bottom'].map(k => `${k} 关${sum(halo[k].off)}→开${sum(halo[k].on)}`).join(' '));
ok('光晕是有限范围（框外 22px 仍是背景，不是整块变色）',
  sum(halo.far.on) === sum(halo.far.off), `框外22px 关灯=${halo.far.off} 开灯=${halo.far.on}`);

/* ── C. 属性面板：双输入框 + defFrom 回落显示 ── */
await page.click(`#canvas .wd[data-id="${ids.lampLegacy}"]`);
await page.waitForTimeout(150);
const panelLegacy = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.find(r => r.querySelector('.f-label')?.textContent.trim() === t);
  return {
    off: byLabel('灭时文字')?.querySelector('input')?.value,
    on: byLabel('亮时文字')?.querySelector('input')?.value,
    oldGone: !byLabel('标签文字'),
  };
});
ok('面板：旧控件「灭时文字」回落显示旧 text', panelLegacy.off === '运行', panelLegacy.off);
ok('面板：旧控件「亮时文字」回落显示旧 text', panelLegacy.on === '运行', panelLegacy.on);
ok('面板：旧「标签文字」单框已移除', panelLegacy.oldGone === true);
await page.click(`#canvas .wd[data-id="${ids.lampDual}"]`);
await page.waitForTimeout(150);
const panelDual = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const byLabel = (t) => rows.find(r => r.querySelector('.f-label')?.textContent.trim() === t);
  return { off: byLabel('灭时文字')?.querySelector('input')?.value, on: byLabel('亮时文字')?.querySelector('input')?.value };
});
ok('面板：双状态控件各自回显', panelDual.off === '停止' && panelDual.on === '运行', JSON.stringify(panelDual));
await page.click(`#canvas .wd[data-id="${ids.lampIn}"]`);
await page.waitForTimeout(150);
const posSel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const row = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '文字位置');
  const sel = row?.querySelector('select');
  return { value: sel?.value, count: sel?.options.length };
});
ok('面板：文字位置 4 选项且回显 inside', posSel.count === 4 && posSel.value === 'inside', JSON.stringify(posSel));

/* ── D. 运行态：状态联动 + 可见宽度 + 光标 ── */
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(400);
const lampDom = await page.evaluate(async (wid) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"]`);
  return {
    hasInput: !!el.querySelector('input'),           // 灯内绝不允许 input（光标来源）
    text: el.querySelector('.lamp-text')?.textContent,
    textW: el.querySelector('.lamp-text')?.offsetWidth,
  };
}, ids.lampDual);
ok('运行态：灯内无 input 元素', lampDom.hasInput === false);
ok('运行态：灭态文字「停止」且可见宽度 > 0', lampDom.text === '停止' && lampDom.textW > 0, `text=${lampDom.text} w=${lampDom.textW}`);
const inDom = await page.evaluate((wid) => {
  const el = document.querySelector(`#rtPage .wd[data-id="${wid}"]`);
  return { text: el.querySelector('.lamp-text')?.textContent, textW: el.querySelector('.lamp-text')?.offsetWidth };
}, ids.lampIn);
ok('运行态：里面布局文字「停」可见', inDom.text === '停' && inDom.textW > 0, `text=${inDom.text} w=${inDom.textW}`);
await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.set('bRun', true, 'local');
});
await page.waitForTimeout(200);
const onText = await page.evaluate((wid) =>
  document.querySelector(`#rtPage .wd[data-id="${wid}"] .lamp-text`)?.textContent, ids.lampDual);
const onBg = await page.evaluate((wid) =>
  document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-lamp`)?.style.background, ids.lampDual);
ok('变量置 true → 亮灯 + 文字切「运行」', (onBg.includes('rgb(34, 197, 94)') || onBg.includes('22c55e')) && onText === '运行', `bg=${onBg} text=${onText}`);
await page.evaluate(async () => {
  const vs = (await import('/js/runtime/varstore.js')).varStore;
  vs.set('bRun', false, 'local');
});
await page.waitForTimeout(200);
const offText2 = await page.evaluate((wid) =>
  document.querySelector(`#rtPage .wd[data-id="${wid}"] .lamp-text`)?.textContent, ids.lampDual);
ok('变量置 false → 文字切回「停止」', offText2 === '停止', offText2);

/* 光标验证：主页面 + 弹窗层 + input 例外 */
const cursors = await page.evaluate(() => {
  const el = document.querySelector('#rtPage .wd');
  return {
    found: !!el,
    pageWd: el ? getComputedStyle(el).cursor : null,
    pageSel: el ? getComputedStyle(el).userSelect : null,
  };
});
ok('运行主页：显示控件光标 default', cursors.pageWd === 'default', cursors.pageWd);
ok('运行主页：文字禁选中', cursors.pageSel === 'none', cursors.pageSel);

// 数据输入 input 控件：运行态必须保留 text 光标
const inpCursor = await page.evaluate((wid) =>
  getComputedStyle(document.querySelector(`#rtPage .wd[data-id="${wid}"] .w-input`)).cursor, ids.inp);
ok('数据输入 input：光标仍是 text（例外保留）', inpCursor === 'text', inpCursor);

await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(150);

/* 弹窗层光标（原漏洞点）：编辑态建弹窗页 + 主页 showPopup 按钮，再进运行点击验证 */
await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  const main = m.project.currentId;
  const pg = m.project.addPage('popup');            // 切到弹窗页
  m.project.addWidget('label', 40, 40);
  m.project.setCurrentPage(main);                   // 切回主页
  m.project.addWidget('button', 520, 40);
  const btn = m.project.currentWidgets().slice(-1)[0];
  m.project.updateWidgetActions(btn.id, [{ type: 'showPopup', trigger: 'click', params: { page: pg.id } }]);
  m.project.commit('弹窗测试');
})());
await page.waitForTimeout(150);
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(300);
const btnId = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const pg = m.project.pages().find(p => p.type === 'page');
  return pg.widgets.filter(w => w.type === 'button').slice(-1)[0]?.id;
});
await page.click(`#rtPage .wd[data-id="${btnId}"]`);
await page.waitForTimeout(300);
const popCursor = await page.evaluate(() => ({
  wd: getComputedStyle(document.querySelector('.rt-popup .wd'))?.cursor,
  visible: !!document.querySelector('.rt-popup'),
}));
ok('弹窗已打开', popCursor.visible === true);
ok('弹窗层：显示控件光标也是 default（原漏洞已补）', popCursor.wd === 'default', popCursor.wd);

await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
await browser.close();
process.exit(fails ? 1 : 0);
