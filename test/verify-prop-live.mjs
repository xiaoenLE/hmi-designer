// verify-prop-live.mjs — 属性面板：改动立刻生效（动作增删即时可见、输入即改画布）
// 用法：先启动 8866 服务，再 node test/verify-prop-live.mjs [端口]
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;
installNodeFetchPatch(URL);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());   // 隔离后端
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => window.app.exitRun?.());

/* 准备：新建一个按钮并选中它（模拟"添加了多个功能"的场景） */
const wid = await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('button', 620, 420);
  w.bindings.variable = 'bRunCmd';
  pr.commit('测试按钮');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return w.id;
});
await page.waitForTimeout(200);
const rowCount = () => page.evaluate(() => document.querySelectorAll('#actList .act-item').length);
const actCount = () => page.evaluate(id => (window.app.project.getWidget(id)?.actions || []).length, wid);

ok('初始：按钮已有 0 个动作', (await rowCount()) === 0 && (await actCount()) === 0, `rows=${await rowCount()}`);

/* ══════ 1. 连续添加 3 个动作：面板立刻出现 3 行 ══════ */
for (let i = 0; i < 3; i++) { await page.click('#actAdd'); await page.waitForTimeout(80); }
ok('连点「添加动作」3 次 → 立刻出现 3 行（无需切页）', (await rowCount()) === 3 && (await actCount()) === 3,
  `rows=${await rowCount()} actions=${await actCount()}`);

/* ══════ 2. 删中间那个：立刻消失（本次报的 bug）══════ */
await page.evaluate(() => {
  const items = [...document.querySelectorAll('#actList .act-item')];
  items[1].querySelector('.act-del').click();
});
await page.waitForTimeout(120);
ok('点 ✕ 删除中间动作 → 行立刻消失（不用切页/重选）', (await rowCount()) === 2, `rows=${await rowCount()}`);
ok('数据同步删掉（actions 从 3 → 2）', (await actCount()) === 2, `actions=${await actCount()}`);

/* ══════ 3. 删完所有行 → 回到"暂无动作"提示（一次点一行，模拟真实操作）══════ */
for (let i = 0; i < 4; i++) {
  const n = await rowCount();
  if (!n) break;
  await page.evaluate(() => document.querySelector('#actList .act-del')?.click());
  await page.waitForTimeout(120);
}
const emptyHint = await page.evaluate(() => document.querySelector('#actList')?.textContent || '');
ok('全部删除后行数与数据都归零', (await rowCount()) === 0 && (await actCount()) === 0,
  `rows=${await rowCount()} actions=${await actCount()}`);
ok('空动作组只显示添加入口', !emptyHint.trim() && await page.locator('#actAdd').isVisible());

/* ══════ 4. 删除后残留行不能把已删动作写回去（旧下标错位）══════ */
await page.click('#actAdd'); await page.waitForTimeout(80);
await page.click('#actAdd'); await page.waitForTimeout(80);
await page.click('#actAdd'); await page.waitForTimeout(80);
ok('重新连点 3 次 → 恰好 3 个动作（监听器不叠加）', (await actCount()) === 3 && (await rowCount()) === 3,
  `rows=${await rowCount()} actions=${await actCount()}`);
await page.evaluate(() => document.querySelector('#actList .act-del').click());   // 删第 1 行，剩 2 行
await page.waitForTimeout(120);
// 改剩下最后一行的「变量」→ 若还用旧的闭包/下标，会把已删动作补回来
await page.evaluate(() => {
  const items = [...document.querySelectorAll('#actList .act-item')];
  const sel = items[items.length - 1].querySelector('[data-ap="variable"]');
  sel.value = 'bAlarm';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(300);
const afterEdit = await page.evaluate(id => (window.app.project.getWidget(id)?.actions || [])
  .map(a => ({ type: a.type, v: a.params?.variable ?? null })), wid);
ok('删除后编辑剩余行 → 动作数仍是 2（不会把删掉的补回来）', afterEdit.length === 2, JSON.stringify(afterEdit));
ok('编辑生效在正确的行上（最后一行变量 = bAlarm）', afterEdit[1]?.v === 'bAlarm', JSON.stringify(afterEdit));

/* ══════ 5. 切换动作类型立刻刷新参数区 ══════ */
await page.evaluate(() => {
  const sel = document.querySelector('#actList .act-item [data-atype]');
  sel.value = 'setValue';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(150);
const typeSwitched = await page.evaluate(id => ({
  types: (window.app.project.getWidget(id)?.actions || []).map(a => a.type),
  hasValueInput: !!document.querySelector('#actList .act-item [data-ap="value"]'),
}), wid);
ok('切换动作类型 → 立刻出现「值」参数行', typeSwitched.types[0] === 'setValue' && typeSwitched.hasValueInput,
  JSON.stringify(typeSwitched));

/* ══════ 6. 文本属性：边打字画布边变（不用等失焦）══════
   新建按钮默认会绑定第一个变量（状态显示），那种情况下画布显示的是状态文字而不是文本属性，
   所以这里先解绑——本用例测的是「属性改了画布立刻变」。
   按钮的「文本 / 背景色」两行已并入「未满文字 / 未满底色」，没绑变量时画的就是未满态。 */
const wid2 = await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('button', 620, 540);
  w.bindings.variable = '';                  // 解绑 → 画布按「未满文字/未满底色」渲染
  pr.commit('测试按钮2');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return w.id;
});
await page.waitForTimeout(250);
const selNow = () => page.evaluate(() => document.querySelector('#canvas .wd.selected')?.dataset.id);
ok('选中新按钮后面板切到它', (await selNow()) === wid2, `选中=${await selNow()}`);
const textInput = page.locator('#propBody [data-prop="offText"]').first();
await textInput.click();
await textInput.press('Control+a');
await page.keyboard.type('立即生效');
await page.waitForTimeout(420);          // 故意不失焦：等 300ms 防抖落地（不失焦也要生效）
const liveText = await page.evaluate(id => ({
  canvas: document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`)?.textContent,
  prop: window.app.project.getWidget(id).props.offText,
  legacyText: window.app.project.getWidget(id).props.text,
  focused: document.activeElement?.dataset?.prop,
}), wid2);
ok('输入未满文字时画布立刻更新（未失焦）', liveText.canvas === '立即生效' && liveText.prop === '立即生效',
  JSON.stringify(liveText));
ok('未满文字修改同步覆盖旧 text 字段', liveText.legacyText === '立即生效', liveText.legacyText);
ok('输入过程中输入框保持焦点（没有被重建顶掉）', liveText.focused === 'offText', String(liveText.focused));

const onTextInput = page.locator('#propBody [data-prop="onText"]').first();
await onTextInput.click();
await onTextInput.press('Control+a');
await page.keyboard.type('满足后');
await onTextInput.press('Enter');
await page.keyboard.type('显示');
await page.waitForTimeout(420);
const bothStates = await page.evaluate(async id => {
  const { project } = await import('/js/core/project.js');
  const { registry } = await import('/js/widgets/registry.js');
  const w = project.getWidget(id);
  w.bindings.variable = 'testBoolean';
  const read = (active) => {
    const html = registry.get('button').render(w, 'run', { get: () => active });
    return new DOMParser().parseFromString(html, 'text/html').querySelector('.w-btn-text')?.textContent;
  };
  return { on: read(true), off: read(false), onProp: w.props.onText };
}, wid2);
ok('满足文字属性修改后满足态立即使用新文字',
  bothStates.on === '满足后\n显示' && bothStates.onProp === '满足后\n显示', JSON.stringify(bothStates));
ok('同一按钮未满足态仍显示已修改的未满文字', bothStates.off === '立即生效', bothStates.off);

/* ══════ 7. 数值属性：输入即改，且不会回写顶掉正在输入的内容 ══════ */
const sizeInput = page.locator('#propBody [data-fld="w"]');
await sizeInput.click();
await sizeInput.press('Control+a');
await page.keyboard.type('150');
await page.waitForTimeout(150);
const liveSize = await page.evaluate(id => ({
  w: window.app.project.getWidget(id).w,
  boxW: Math.round(document.querySelector(`#canvas .wd[data-id="${id}"]`).getBoundingClientRect().width),
  inputVal: document.querySelector('#propBody [data-fld="w"]').value,
}), wid2);
ok('输入宽度时画布尺寸立刻更新', liveSize.w === 150 && liveSize.boxW === 150, JSON.stringify(liveSize));
ok('数值输入框没被中途回写（仍是 150）', liveSize.inputVal === '150', liveSize.inputVal);

/* 宽/高的下限：1（现场要求：细线、窄条要用；以前卡在 8，填 1 会被顶回 8） */
const one = await page.evaluate(async (id) => {
  const set = async (fld, val) => {
    const inp = document.querySelector(`#propBody [data-fld="${fld}"]`);
    inp.value = String(val);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 420));
    return { saved: window.app.project.getWidget(id)[fld], shown: Number(inp.value), min: inp.getAttribute('min') };
  };
  return { w1: await set('w', 1), h1: await set('h', 1), w0: await set('w', 0), back: await set('w', 120) };
}, wid2);
ok('★ 宽/高 能填 1（存进工程的就是 1，输入框也没被顶回 8）',
  one.w1.saved === 1 && one.w1.shown === 1 && one.h1.saved === 1 && one.h1.shown === 1,
  JSON.stringify([one.w1, one.h1]));
ok('输入框的 min 就是 1（不是 8）', one.w1.min === '1' && one.h1.min === '1',
  JSON.stringify([one.w1.min, one.h1.min]));
ok('填 0 收敛到下限 1（不会存成 0 那种看不见的控件）', one.w0.saved === 1 && one.w0.shown === 1,
  JSON.stringify(one.w0));

/* ══════ 8. 颜色属性：色板变化立刻反映到画布 ══════
   「背景色」已并入「未满底色」：没绑变量的按钮画的就是未满态，改它就立刻变。 */
const liveColor = await page.evaluate(async (id) => {
  const inp = document.querySelector('#propBody [data-prop="offColor"]');
  inp.value = '#ff8800';
  inp.dispatchEvent(new Event('input', { bubbles: true }));   // 只派发 input（拖动色板时就是它）
  await new Promise(r => setTimeout(r, 420));                 // 等 300ms 防抖落地
  return {
    prop: window.app.project.getWidget(id).props.offColor,
    style: document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`).getAttribute('style'),
  };
}, wid2);
ok('色板拖动/选色立刻应用到画布', liveColor.prop === '#ff8800' && liveColor.style.includes('#ff8800'),
  liveColor.style.match(/background:[^;]+/)?.[0] || liveColor.prop);

await page.evaluate(() => { globalThis.pywebview = { api: {} }; });
const desktopPicker = page.locator('.desktop-colors');
const colorInput = page.locator('#propBody [data-prop="offColor"]');
await colorInput.focus();
await page.waitForTimeout(650);   // 前面的属性测试排队提交完毕，再测试桌面取色。
await colorInput.click();
await desktopPicker.locator('[data-hex]').fill('bad');
await desktopPicker.getByRole('button', { name: '应用', exact: true }).click();
ok('桌面取色器可打开并检查颜色代码', await desktopPicker.locator('[data-error]').isVisible());
await desktopPicker.getByRole('button', { name: '取消', exact: true }).click();
ok('取消取色保留已有颜色', await colorInput.inputValue() === '#ff8800');
await colorInput.click();
await page.evaluate(() => window.app.project.touch());
await desktopPicker.getByRole('button', { name: '#2563eb' }).click();
await desktopPicker.getByRole('button', { name: '应用', exact: true }).click();
const desktopColor = await page.evaluate(id => ({
  value: window.app.project.getWidget(id).props.offColor,
  style: document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`).getAttribute('style'),
}), wid2);
ok('桌面取色器应用后更新控件及画布', desktopColor.value === '#2563eb' && desktopColor.style.includes('#2563eb'),
  JSON.stringify(desktopColor));
await page.evaluate(() => { delete globalThis.pywebview; });

/* ══════ 8b. 桌面吸管：WebView2 里 EyeDropper「有函数、吸不到色」，改走后端采屏 ══════ */
await page.evaluate(() => {
  globalThis.__pick = { reads: 0, stopped: 0 };
  globalThis.pywebview = { api: {
    pick_color_start() { return { ok: true, state: 'active', hex: '' }; },
    pick_color_read() {
      const p = globalThis.__pick;
      p.reads += 1;
      return p.reads < 2
        ? { ok: true, state: 'active', hex: '#123456' }   // 第一轮：还在采，先给实时颜色
        : { ok: true, state: 'done', hex: '#abcdef' };    // 第二轮：用户按了左键
    },
    pick_color_stop() { globalThis.__pick.stopped += 1; return { ok: true, state: 'cancelled', hex: '' }; },
  } };
});
await colorInput.click();
const sampleBtn = desktopPicker.locator('[data-sample]');
ok('桌面吸管按钮出现（后端有采色接口）', await sampleBtn.isVisible());
await sampleBtn.click();
ok('吸管采样时让出画布并移除暗色遮罩', await desktopPicker.evaluate(el =>
  getComputedStyle(el).visibility === 'hidden' && getComputedStyle(el, '::backdrop').backgroundColor === 'rgba(0, 0, 0, 0)'));
await page.waitForTimeout(400);
ok('采到的颜色实时写回颜色框', await desktopPicker.locator('[data-hex]').inputValue() === '#abcdef');
ok('取色完成后收起提示', !(await desktopPicker.locator('[data-hint]').isVisible()));
await desktopPicker.getByRole('button', { name: '应用', exact: true }).click();
const sampled = await page.evaluate(id => window.app.project.getWidget(id).props.offColor, wid2);
ok('吸管取色应用后更新控件属性', sampled === '#abcdef', String(sampled));

// 采色中途取消：既要通知后端停，也要把提示收掉
await colorInput.click();
await sampleBtn.click();
await page.waitForTimeout(120);
await desktopPicker.getByRole('button', { name: '取消', exact: true }).click();
const stopped = await page.evaluate(() => globalThis.__pick.stopped);
ok('取消取色会通知后端停止采屏', stopped > 0, String(stopped));
await page.evaluate(() => { delete globalThis.pywebview; });

/* ══════ 8c. 网页取色器直接使用同样的最近颜色 ══════ */
await page.evaluate(() => {
  localStorage.removeItem('hmi-recent-colors');
});
await colorInput.click();
ok('没有桌面桥接时，网页点击色块也打开同一套取色框', await desktopPicker.isVisible());
ok('网页没有记录时不显示「最近用过」', !(await desktopPicker.locator('[data-recent-box]').isVisible()));
await desktopPicker.locator('[data-hex]').fill('#0ea5e9');
await desktopPicker.getByRole('button', { name: '应用', exact: true }).click();
const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('hmi-recent-colors') || '[]'));
ok('网页应用的颜色保存在浏览器的「最近用过」', Array.isArray(recent) && recent[0] === '#0ea5e9', JSON.stringify(recent));
await colorInput.click();
ok('再打开时「最近用过」出现', await desktopPicker.locator('[data-recent-box]').isVisible());
const recentBtn = desktopPicker.locator('[data-recent]').first();
ok('最近用过里第一个就是刚用的颜色', await recentBtn.getAttribute('data-recent') === '#0ea5e9',
  await recentBtn.getAttribute('data-recent'));
await recentBtn.click();
ok('网页点最近用过直接选中那个颜色', await desktopPicker.locator('[data-hex]').inputValue() === '#0ea5e9');
await desktopPicker.locator('[data-hex]').fill('#aabbcc');
await desktopPicker.getByRole('button', { name: '取消', exact: true }).click();
await page.waitForFunction(() => document.querySelector('#propBody [data-prop="offColor"]')?.value === '#0ea5e9');
ok('网页取消时恢复原色且不把预览记进历史', await colorInput.inputValue() === '#0ea5e9'
  && await page.evaluate(() => localStorage.getItem('hmi-recent-colors')) === '["#0ea5e9"]');
const liveName = await page.evaluate(async () => {
  const sel = document.querySelector('#canvas .wd.selected')?.dataset.id;
  const inp = document.querySelector('#propBody [data-fld="name"]');
  inp.value = '启动按钮A';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // 控件清单是按帧重画的
  return {
    sel,
    name: window.app.project.getWidget(sel)?.name,
    listHas: [...document.querySelectorAll('#widgetList .wl-name')].some(e => e.textContent === '启动按钮A'),
  };
});
ok('改名称立刻同步到控件清单', liveName.name === '启动按钮A' && liveName.listHas, JSON.stringify(liveName));

const multi = await page.evaluate(async buttonId => {
  const { select } = await import('/js/editor/canvas.js');
  const { project } = window.app;
  const number = project.addWidget('number', 620, 420);
  const button = project.getWidget(buttonId);
  select([button.id, number.id]);
  return [button.id, number.id];
}, wid2);
const batch = key => page.locator(`#propBody [data-prop="${key}"]`);
ok('混合选中按钮和数值时显示共同属性', await batch('fontSize').isVisible() && await batch('textColor').isVisible()
  && await batch('offColor').count() === 0);
await batch('fontSize').fill('24');
await batch('fontSize').press('Tab');
await batch('align').selectOption('right');
await batch('textColor').evaluate(input => {
  input.value = '#123456';
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
const combined = await page.evaluate(ids => ids.map(id => {
  const w = window.app.project.getWidget(id);
  const el = document.querySelector(`#canvas [data-id="${id}"] .w-btn, #canvas [data-id="${id}"] .wn-val`);
  const style = getComputedStyle(el);
  return [w.props.fontSize, w.props.textColor, w.props.align, style.fontSize, style.color, style.textAlign];
}), multi);
ok('字号、文字色和右对齐同时应用到两个控件和画布', combined.every(row =>
  JSON.stringify(row) === JSON.stringify([24, '#123456', 'right', '24px', 'rgb(18, 52, 86)', 'right'])), JSON.stringify(combined));

const sameButtons = await page.evaluate(async ([id]) => {
  const { select } = await import('/js/editor/canvas.js');
  const { project } = window.app;
  const first = project.getWidget(id);
  const second = project.addWidget('button', 520, 380);
  project.addVariable();
  const bound = project.variables().at(-1);
  project.updateVariable(bound.name, { type: 'int' });
  for (const w of [first, second]) project.updateWidgetField(w.id, 'bindings.variable', bound.name);
  select([first.id, second.id]);
  return [first.id, second.id];
}, multi);
ok('同类型按钮显示两态文字和底色、不一致文字显示不同值',
  await batch('onText').getAttribute('placeholder') === '不同值' && await batch('offText').isVisible()
    && await batch('onColor').isVisible() && await batch('offColor').isVisible());
ok('共同字号显示在两态属性之前', await batch('fontSize').evaluate(el =>
  !!(el.compareDocumentPosition(document.querySelector('#propBody [data-prop="onText"]')) & Node.DOCUMENT_POSITION_FOLLOWING)));
await batch('fontSize').fill('33');
await page.waitForFunction(ids => ids.every(id => (
  window.app.project.getWidget(id).props.fontSize === 33
  && getComputedStyle(document.querySelector(`#canvas [data-id="${id}"] .w-btn`)).fontSize === '33px'
)), sameButtons, { timeout: 2000 });
ok('输入字号后不必失焦，两只按钮画布同时更新', await batch('fontSize').evaluate(el => document.activeElement === el));
await batch('onText').fill('启动\n运行中');
await batch('offText').fill('停止\n待机');
await batch('threshold').fill('5');
await batch('op').selectOption('>');
await batch('onColor').evaluate(el => {
  el.value = '#147a52';
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.evaluate(() => { globalThis.pywebview = { api: {} }; });
const beforeOffColors = await page.evaluate(ids => ids.map(id => window.app.project.getWidget(id).props.offColor), sameButtons);
await batch('offColor').click();
await desktopPicker.locator('[data-hex]').fill('#364152');
await desktopPicker.getByRole('button', { name: '取消', exact: true }).click();
const cancelledOffColors = await page.evaluate(ids => ids.map(id => window.app.project.getWidget(id).props.offColor), sameButtons);
ok('桌面取色取消后保留每只按钮原来的未满底色', JSON.stringify(beforeOffColors) === JSON.stringify(cancelledOffColors));
await batch('offColor').click();
await desktopPicker.locator('[data-hex]').fill('#364152');
await desktopPicker.getByRole('button', { name: '应用', exact: true }).click();
await page.evaluate(() => { delete globalThis.pywebview; });
const buttonProps = await page.evaluate(ids => ids.map(id => {
  const p = window.app.project.getWidget(id).props;
  return [p.onText, p.offText, p.text, p.onColor, p.offColor, p.op, p.threshold];
}), sameButtons);
ok('两态文字、颜色和比较条件分别批量更新，并保留未满文字兼容字段',
  buttonProps.every(row => JSON.stringify(row) === JSON.stringify(
    ['启动\n运行中', '停止\n待机', '停止\n待机', '#147a52', '#364152', '>', '5'])), JSON.stringify(buttonProps));
await page.evaluate(async ([a, b]) => {
  const { select } = await import('/js/editor/canvas.js');
  const { project } = window.app;
  project.updateWidgetField(a, 'bindings.variable', '');
  select([a, b]);
}, sameButtons);
ok('选中不满足比较条件显示规则的按钮时，不出现批量比较配置',
  await batch('op').count() === 0 && await batch('threshold').count() === 0);

const decimals = await page.evaluate(async () => {
  const { select } = await import('/js/editor/canvas.js');
  const { project } = window.app;
  const widgets = [project.addWidget('number', 520, 450), project.addWidget('number', 690, 450)];
  for (const w of widgets) {
    project.updateWidgetField(w.id, 'bindings.variable', '');
    project.updateWidgetProp(w.id, 'dispType', 'float');
  }
  const ids = widgets.map(w => w.id);
  select(ids);
  return ids;
});
await batch('decimals').fill('3');
await batch('decimals').press('Tab');
const formats = await page.evaluate(ids => ids.map(id => {
  const p = window.app.project.getWidget(id).props;
  return [p.decimals, p.fmt];
}), decimals);
ok('相同数值控件的批量小数位同步更新显示格式', formats.every(row => row[0] === 3 && row[1] === '%.3f'),
  JSON.stringify(formats));
await batch('rangeOn').check();
await batch('rangeMinValue').fill('10');
await batch('rangeMaxValue').fill('80');
await batch('rangeMaxValue').press('Tab');
const ranges = await page.evaluate(ids => ids.map(id => {
  const p = window.app.project.getWidget(id).props;
  return [p.rangeOn, p.rangeMinMode, p.rangeMinValue, p.rangeMaxMode, p.rangeMaxValue];
}), decimals);
ok('批量启用范围后可共同设置固定上下限', ranges.every(row =>
  JSON.stringify(row) === JSON.stringify([true, 'fixed', '10', 'fixed', '80'])), JSON.stringify(ranges));

const decorations = await page.evaluate(async () => {
  const { select } = await import('/js/editor/canvas.js');
  const { project } = window.app;
  const ids = [project.addWidget('rect', 310, 450).id, project.addWidget('circle', 310, 560).id];
  select(ids);
  return ids;
});
const commonGroup = page.locator('#propBody .prop-group-title').filter({ hasText: /^共同属性$/ });
ok('仅选装饰控件时显示批量几何', await commonGroup.count() === 0 && await page.locator('#mW').isVisible());

const selectWidgets = ids => page.evaluate(async selected => {
  (await import('/js/editor/canvas.js')).select(selected);
}, ids);
await selectWidgets([sameButtons[0], ...decorations]);
ok('只有一个非装饰控件时不生成共同属性', await commonGroup.count() === 0);
await selectWidgets([sameButtons[0], ...decorations, sameButtons[1]]);
ok('混选仍可编辑两个按钮的字号与两态属性',
  await batch('fontSize').isVisible() && await batch('onText').isVisible());
const decorationWidthBefore = await page.evaluate(ids =>
  ids.map(id => window.app.project.getWidget(id).props.borderWidth), decorations);
await batch('borderWidth').fill('4');
await batch('borderWidth').press('Tab');
const borderWidths = await page.evaluate(ids =>
  ids.map(id => window.app.project.getWidget(id).props.borderWidth), [...sameButtons, ...decorations]);
ok('应用共同的边框宽度时仅修改按钮',
  JSON.stringify(borderWidths) === JSON.stringify([4, 4, ...decorationWidthBefore]), JSON.stringify(borderWidths));
await page.locator('#mW').fill('140');
await page.locator('#mW').press('Tab');
const geometry = await page.evaluate(ids =>
  ids.map(id => window.app.project.getWidget(id).w), [...sameButtons, ...decorations]);
ok('混选时批量几何包含按钮和装饰控件', geometry.every(w => w === 140), JSON.stringify(geometry));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 属性即时生效回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
