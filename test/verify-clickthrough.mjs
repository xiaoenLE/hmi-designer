// verify-clickthrough.mjs — 点击穿透：叠着的两个控件，点一下两个都触发
//
// 现场场景：把两个控件叠着放（方框压在按钮上、或者两个透明按钮压在一起），
// 希望点一下**两个都生效**。浏览器默认只把点击给最上面那个，这里验证两个状态：
//   不穿透（默认）→ 只有上面那个触发
//   穿透         → 我自己的动作照做，**同时继续往下传**（压在下面的也一起触发）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => fetch('/api/plc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) }).catch(() => {}));
await page.waitForTimeout(300);

/* ── 造两个叠在一起的按钮：上面那个「大框」压在下面那个按钮上，各写一个变量 ── */
const ids = await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  const p = m.project;
  p.data.pages[0].widgets.length = 0;
  p.data.variables.length = 0;
  p.addVariable(); p.updateVariable('var1', { name: 'nTop', type: 'int', value: 0 });
  p.addVariable(); p.updateVariable('var2', { name: 'nUnder', type: 'int', value: 0 });
  // 下面那个：小按钮，z 低
  const under = p.addWidget('button', 100, 100);
  p.updateWidgetField(under.id, 'w', 200); p.updateWidgetField(under.id, 'h', 80);
  p.updateWidgetProp(under.id, 'text', '下面的按钮');
  p.updateWidgetActions(under.id, [{ type: 'setValue', trigger: 'click', params: { variable: 'nUnder', value: '1' } }]);
  // 上面那个：同样大小的大方框（透明矩形），z 高 —— 正好压住下面那个
  const top = p.addWidget('rect', 100, 100);
  p.updateWidgetField(top.id, 'w', 200); p.updateWidgetField(top.id, 'h', 80);
  p.updateWidgetProp(top.id, 'bgColor', '');
  p.updateWidgetProp(top.id, 'borderColor', '#2563eb'); p.updateWidgetProp(top.id, 'borderWidth', 2);
  p.updateWidgetActions(top.id, [{ type: 'setValue', trigger: 'click', params: { variable: 'nTop', value: '1' } }]);
  p.commit('点击穿透测试');
  return { top: top.id, under: under.id };
});
await page.waitForTimeout(300);

const setMode = async (which, mode) => {
  await page.evaluate(async ([id, v]) => {
    const m = await import('/js/core/project.js');
    m.project.updateWidgetProp(id, 'clickThrough', v);
    m.project.commit('点击穿透');
  }, [which === 'top' ? ids.top : which === 'mid' ? ids.mid : ids.under, mode]);
  await page.waitForTimeout(150);
};
/** 改完属性要重进一次运行态：运行态的 DOM/监听是进运行态那一刻建的，
 *  「改了属性当场重绘」不是它的行为（真实现场也是改完再进运行态看效果） */
const restartRun = async () => {
  await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
  await page.waitForTimeout(150);
  await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
  await page.waitForTimeout(400);
};
const vals = () => page.evaluate(() => ({ top: window.app.varStore.get('nTop'), under: window.app.varStore.get('nUnder') }));
const reset = () => page.evaluate(() => {
  window.app.varStore.set('nTop', 0, 'local');
  window.app.varStore.set('nUnder', 0, 'local');
});
/** 点两个控件重叠的那一块（取上面那个的几何中心） */
const clickOverlap = async () => {
  const b = await page.locator(`#rtPage .wd[data-id="${ids.top}"]`).boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(250);
};

await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await page.waitForTimeout(450);

/* ── A. 默认（不穿透）：点一下只有上面那个触发 ── */
await clickOverlap();
let v = await vals();
ok('默认不穿透：上面那个触发，下面那个收不到（老行为，一点没变）', v.top === 1 && v.under === 0, JSON.stringify(v));

/* ── B. 上面那个设「穿透」：点一下两个都触发 ── */
await reset();
await setMode('top', true);
await restartRun();
await clickOverlap();
v = await vals();
ok('上面设「穿透」→ 点一下两个都触发（一次点击，叠着的都有效）', v.top === 1 && v.under === 1, JSON.stringify(v));
ok('再点一下 → 两个又都被触发一次（不是只第一次管用）', await (async () => {
  // 置变量值动作写的是固定值 1（点两次结果一样），所以先手工把下面那个改成 5：
  // 再点一下，它要是又变回 1，就说明这一下**又是两个都触发**
  await page.evaluate(() => window.app.varStore.set('nUnder', 5, 'local'));
  await clickOverlap(); const r = await vals(); return r.top === 1 && r.under === 1;
})(), JSON.stringify(await vals()));

/* ── C. 方框自己没动作时，「穿透」就等于"透过方框点到下面的按钮" ── */
await reset();
await page.evaluate(async ([id]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetActions(id, []);        // 方框不配任何动作
  m.project.commit('方框去掉动作');
}, [ids.top]);
await restartRun();
await clickOverlap();
v = await vals();
ok('方框没配动作 + 勾了穿透 → 点下去等于点到下面的按钮（透过方框点按钮）',
  v.top === 0 && v.under === 1, JSON.stringify(v));
ok('穿透只作用于运行态：组态画布上照样能点中、能拖（画布的 DOM 不受影响）',
  await page.evaluate(async ([id]) => {
    const el = document.querySelector(`#canvas .wd[data-id="${id}"]`);
    return el ? getComputedStyle(el).pointerEvents !== 'none' : null;
  }, [ids.top]), '');
await page.evaluate(async ([id]) => {
  const m = await import('/js/core/project.js');
  m.project.updateWidgetActions(id, [{ type: 'setValue', trigger: 'click', params: { variable: 'nTop', value: '1' } }]);
  m.project.commit('方框动作加回来');
}, [ids.top]);
await restartRun();

/* ── D. 三个叠着：一路传下去，碰到"不穿透"就停 ── */
const three = await page.evaluate(async ([underId, topId]) => {
  const p = (await import('/js/core/project.js')).project;
  p.addVariable(); p.updateVariable('var3', { name: 'nMid', type: 'int', value: 0 });
  // 插一层在中间：z 比下面那个高、比上面那个低
  const under = p.getWidget(underId), top = p.getWidget(topId);
  const mid = p.addWidget('button', 100, 100);
  p.updateWidgetField(mid.id, 'w', 200); p.updateWidgetField(mid.id, 'h', 80);
  p.updateWidgetProp(mid.id, 'text', '中间那个');
  p.updateWidgetActions(mid.id, [{ type: 'setValue', trigger: 'click', params: { variable: 'nMid', value: '1' } }]);
  p.updateWidgetField(mid.id, 'z', under.z + 1);
  p.updateWidgetField(top.id, 'z', under.z + 2);
  p.commit('三层叠加');
  return { mid: mid.id };
}, [ids.under, ids.top]);
ids.mid = three.mid;
await restartRun();
const reset3 = async () => {
  await reset();
  await page.evaluate(() => { window.app.varStore.set('nMid', 0, 'local'); });
};
const vals3 = () => page.evaluate(() => ({
  top: window.app.varStore.get('nTop'), mid: window.app.varStore.get('nMid'), under: window.app.varStore.get('nUnder'),
}));
await setMode('top', true);            // 最上面：穿透
await setMode('mid', true);            // 中间：也穿透 → 一路传到最下面
await restartRun();
await reset3();
await clickOverlap();
let v3 = await vals3();
ok('三层叠着、上两层都勾了穿透 → 点一下三个都触发',
  v3.top === 1 && v3.mid === 1 && v3.under === 1, JSON.stringify(v3));
await reset3();
await setMode('mid', false);              // 中间改成"不穿透" → 传到它为止
await restartRun();
await reset3();
await clickOverlap();
v3 = await vals3();
ok('中间那层设回「不穿透」→ 传到它就停（最下面那个不再被触发）',
  v3.top === 1 && v3.mid === 1 && v3.under === 0, JSON.stringify(v3));

/* ── E. 属性面板 ── */
await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await page.waitForTimeout(200);
await page.evaluate(async ([id]) => (await import('/js/editor/canvas.js')).select([id]), [ids.top]);
await page.waitForTimeout(250);
const panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#propBody .f-row')];
  const row = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '穿透');
  const chk = row?.querySelector('input[data-prop="clickThrough"]');
  return {
    has: !!chk, type: chk?.type, checked: chk?.checked,
    title: (chk?.closest('label')?.title || '').split('\n')[0],
    group: [...document.querySelectorAll('#propBody .prop-group-title')].map(t => t.textContent.trim()),
  };
});
ok('属性面板有「点击穿透」那一栏，就是一个勾选框（不是一大串下拉文字）',
  panel.has && panel.type === 'checkbox' && panel.group.includes('点击穿透'), JSON.stringify(panel));
ok('勾选框回显当前状态（这个是勾上的）', panel.checked === true, String(panel.checked));
ok('说明收在悬停提示里（面板上不摊一大段字）', panel.title.length > 20, panel.title);
await page.uncheck('#propBody input[data-prop="clickThrough"]');
await page.waitForTimeout(300);
const after = await page.evaluate(async ([id]) => {
  const m = await import('/js/core/project.js');
  return m.project.getWidget(id).props.clickThrough;
}, [ids.top]);
ok('取消勾选 → 真的写进工程（不穿透）', after === false, JSON.stringify(after));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 点击穿透回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
