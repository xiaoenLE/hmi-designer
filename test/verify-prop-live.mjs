// verify-prop-live.mjs — 属性面板：改动立刻生效（动作增删即时可见、输入即改画布）
// 用法：先启动 8866 服务，再 node test/verify-prop-live.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
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
ok('空列表显示提示文案', emptyHint.includes('暂无动作'), emptyHint.slice(0, 20));

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
   新建按钮默认会绑定第一个变量（状态显示），那种情况下画布显示的是状态文字而不是 text，
   所以这里先解绑——本用例测的是「属性改了画布立刻变」 */
const wid2 = await page.evaluate(() => {
  const pr = window.app.project;
  const w = pr.addWidget('button', 620, 540);
  w.bindings.variable = '';                  // 解绑 → 画布按 text/bgColor 渲染
  pr.commit('测试按钮2');
  const el = document.querySelector(`#canvas .wd[data-id="${w.id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return w.id;
});
await page.waitForTimeout(250);
const selNow = () => page.evaluate(() => document.querySelector('#canvas .wd.selected')?.dataset.id);
ok('选中新按钮后面板切到它', (await selNow()) === wid2, `选中=${await selNow()}`);
const textInput = page.locator('#propBody [data-prop="text"]').first();
await textInput.click();
await textInput.press('Control+a');
await page.keyboard.type('立即生效');
await page.waitForTimeout(420);          // 故意不失焦：等 300ms 防抖落地（不失焦也要生效）
const liveText = await page.evaluate(id => ({
  canvas: document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`)?.textContent,
  prop: window.app.project.getWidget(id).props.text,
  focused: document.activeElement?.dataset?.prop,
}), wid2);
ok('输入文本时画布立刻更新（未失焦）', liveText.canvas === '立即生效' && liveText.prop === '立即生效',
  JSON.stringify(liveText));
ok('输入过程中输入框保持焦点（没有被重建顶掉）', liveText.focused === 'text', String(liveText.focused));

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

/* ══════ 8. 颜色属性：色板变化立刻反映到画布 ══════ */
const liveColor = await page.evaluate(async (id) => {
  const inp = document.querySelector('#propBody [data-prop="bgColor"]');
  inp.value = '#ff8800';
  inp.dispatchEvent(new Event('input', { bubbles: true }));   // 只派发 input（拖动色板时就是它）
  await new Promise(r => setTimeout(r, 420));                 // 等 300ms 防抖落地
  return {
    prop: window.app.project.getWidget(id).props.bgColor,
    style: document.querySelector(`#canvas .wd[data-id="${id}"] .w-btn`).getAttribute('style'),
  };
}, wid2);
ok('色板拖动/选色立刻应用到画布', liveColor.prop === '#ff8800' && liveColor.style.includes('#ff8800'),
  liveColor.style.match(/background:[^;]+/)?.[0] || liveColor.prop);

/* ══════ 9. 名称属性：清单面板同步 ══════ */
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

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 属性即时生效回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
