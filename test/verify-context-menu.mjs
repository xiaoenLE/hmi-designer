// verify-context-menu.mjs — 右键菜单：屏蔽浏览器菜单 + 按目标给出对应功能
// 用法：先启动 8866 服务，再 node test/verify-context-menu.mjs [端口]
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
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());        // confirm 一律确认

const menuOpen = () => page.evaluate(() => !document.getElementById('ctxMenu').classList.contains('hidden'));
const menuItems = () => page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
  .map(b => b.querySelector('.ctx-label').textContent));
const menuDisabled = () => page.evaluate(() => [...document.querySelectorAll('#ctxMenu .ctx-item')]
  .filter(b => b.disabled).map(b => b.querySelector('.ctx-label').textContent));
/** 点菜单里文字等于 label 的那一项 */
async function clickMenu(label) {
  await page.evaluate(l => {
    const b = [...document.querySelectorAll('#ctxMenu .ctx-item')]
      .find(x => x.querySelector('.ctx-label').textContent === l);
    if (b) b.click();
  }, label);
  await page.waitForTimeout(220);
}
async function rightClick(locator, pos) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + (pos?.x ?? box.width / 2), box.y + (pos?.y ?? box.height / 2), { button: 'right' });
  await page.waitForTimeout(220);
}
async function boot() {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.waitForTimeout(250);
}

/* ══════ 1. 浏览器右键被屏蔽（合成可取消事件，dispatchEvent 返回 false 即已 preventDefault）══════ */
await boot();
const prevented = await page.evaluate(() => {
  const el = document.querySelector('#canvas .wd');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 });
  return el.dispatchEvent(ev) === false;
});
ok('画布上右键 → 浏览器菜单被屏蔽', prevented && (await menuOpen()), `prevented=${prevented} 菜单开=${await menuOpen()}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok('Esc 关闭菜单', !(await menuOpen()));

/* ══════ 2. 控件菜单：右键即选中 + 功能齐全 ══════ */
const info = await page.evaluate(() => {
  const ws = window.app.project.currentWidgets();
  const w = ws[3];
  return { id: w.id, name: w.name, z: w.z, types: ws.length };
});
await page.evaluate(() => window.app.project.setCurrentPage(window.app.project.currentId));
await rightClick(page.locator(`#canvas .wd[data-id="${info.id}"]`));
const wItems = await menuItems();
ok('右键控件 → 自动选中它', await page.evaluate(id => window.app.getZoom && document.querySelector(`#canvas .wd[data-id="${id}"]`).classList.contains('selected'), info.id));
ok('控件菜单含剪切/复制/粘贴/层级/锁定/删除',
  ['剪切', '复制', '粘贴', '置于顶层', '置于底层', '锁定', '删除'].every(l => wItems.includes(l)), JSON.stringify(wItems));
ok('剪贴板为空时控件菜单的「粘贴」是禁用态', (await menuDisabled()).includes('粘贴'), JSON.stringify(await menuDisabled()));
ok('菜单标题显示控件名', (await page.evaluate(() => document.querySelector('#ctxMenu .ctx-head')?.textContent)) === info.name);

/* 置于顶层 */
await clickMenu('置于顶层');
const zTop = await page.evaluate(id => window.app.project.getWidget(id).z, info.id);
const maxZ = await page.evaluate(() => Math.max(...window.app.project.currentWidgets().map(w => w.z)));
ok('菜单「置于顶层」生效', zTop === maxZ, `z=${zTop} 最大=${maxZ}`);
ok('操作后菜单自动关闭', !(await menuOpen()));

/* 锁定 */
await rightClick(page.locator(`#canvas .wd[data-id="${info.id}"]`));
await clickMenu('锁定');
ok('菜单「锁定」生效', await page.evaluate(id => window.app.project.getWidget(id).locked === true, info.id));
await rightClick(page.locator(`#canvas .wd[data-id="${info.id}"]`));
ok('已锁定的控件菜单显示「解锁」', (await menuItems()).includes('解锁'), JSON.stringify(await menuItems()));
await clickMenu('解锁');

/* ══════ 3. 删除（跳过锁定）══════ */
await rightClick(page.locator(`#canvas .wd[data-id="${info.id}"]`));
await clickMenu('删除');
ok('菜单「删除」生效', await page.evaluate(id => !window.app.project.getWidget(id), info.id));

/* ══════ 4. 空白菜单：粘贴（剪贴板空时禁用）══════ */
await page.mouse.click(760, 700, { button: 'right' });
await page.waitForTimeout(220);
const blank1 = await menuItems();
ok('空白菜单：剪贴板为空时「粘贴」禁用', (await menuDisabled()).includes('粘贴'), JSON.stringify(blank1));
await page.keyboard.press('Escape');
// 复制一个控件后再看
await page.evaluate(() => {
  const el = document.querySelector('#canvas .wd');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await page.keyboard.press('Control+c');
await page.waitForTimeout(150);
const n0 = await page.evaluate(() => window.app.project.currentWidgets().length);
await page.mouse.click(760, 700, { button: 'right' });
await page.waitForTimeout(220);
const blank2 = await menuItems();
ok('复制后「粘贴」可用', blank2.includes('粘贴'), JSON.stringify(blank2));
await clickMenu('粘贴');
const n1 = await page.evaluate(() => window.app.project.currentWidgets().length);
ok('菜单「粘贴」新增控件', n1 === n0 + 1, `${n0} → ${n1}`);

/* ══════ 4b. Ctrl+X 剪切：复制进剪贴板 + 删掉；锁定控件不动 ══════ */
const pick = () => page.evaluate(() => {
  const ws = window.app.project.currentWidgets();
  return { id: ws[2].id, n: ws.length };
});
const selectWd = id => page.evaluate(i => {
  const el = document.querySelector(`#canvas .wd[data-id="${i}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}, id);
const cut = await pick();
await selectWd(cut.id);
await page.keyboard.press('Control+x');
await page.waitForTimeout(200);
const afterCut = await page.evaluate(() => window.app.project.currentWidgets().length);
const cutGone = await page.evaluate(id => !window.app.project.getWidget(id), cut.id);
ok('Ctrl+X 剪切：控件从页面上消失', afterCut === cut.n - 1 && cutGone, `${cut.n} → ${afterCut}，已消失=${cutGone}`);
await page.keyboard.press('Control+v');
await page.waitForTimeout(200);
const afterPaste = await page.evaluate(() => window.app.project.currentWidgets().length);
ok('Ctrl+X 之后还能 Ctrl+V 粘回来', afterPaste === cut.n, `${afterCut} → ${afterPaste}`);

/* 锁定的控件：Ctrl+X 不动它（测完解锁，别把状态留给后面的套件段落） */
const lock = await pick();
await rightClick(page.locator(`#canvas .wd[data-id="${lock.id}"]`));
await clickMenu('锁定');
await page.keyboard.press('Control+x');
await page.waitForTimeout(200);
const lockStill = await page.evaluate(id => !!window.app.project.getWidget(id), lock.id);
const lockN = await page.evaluate(() => window.app.project.currentWidgets().length);
ok('锁定控件 Ctrl+X 不动它', lockStill && lockN === lock.n, `仍在=${lockStill}，${lock.n} → ${lockN}`);
await rightClick(page.locator(`#canvas .wd[data-id="${lock.id}"]`));
await clickMenu('解锁');
ok('（收尾）锁定已解除', await page.evaluate(id => window.app.project.getWidget(id).locked !== true, lock.id));

/* ══════ 5. 空白菜单：网格 / 适应窗口 ══════ */
// ⚠ 别写死坐标（内置模板的页面控件多，写死 (760,700) 会点到控件上 → 弹出的是控件菜单）。
//   这里在 #canvas 里扫一个**没被任何控件压住**的点（空白菜单的判定是"在 #canvas 里且不在 .wd 里"）。
const blankPoint = () => page.evaluate(() => {
  const c = document.getElementById('canvas').getBoundingClientRect();
  for (let y = c.top + 4; y < c.bottom - 4; y += 6) {
    for (let x = c.left + 4; x < c.right - 4; x += 6) {
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('#canvas') && !el.closest('.wd')) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
});
const blank = await blankPoint();
ok('页面上找得到一块画布空白（右键菜单要用）', !!blank, JSON.stringify(blank));
const gridBefore = await page.evaluate(() => !document.getElementById('canvas').classList.contains('nogrid'));
await page.mouse.click(blank.x, blank.y, { button: 'right' });
await page.waitForTimeout(200);
await clickMenu('网格吸附（5px）');
const gridAfter = await page.evaluate(() => !document.getElementById('canvas').classList.contains('nogrid'));
ok('菜单切换网格吸附', gridBefore !== gridAfter, `${gridBefore} → ${gridAfter}`);
await page.mouse.click(blank.x, blank.y, { button: 'right' });
await page.waitForTimeout(200);
await clickMenu('适应窗口');
ok('菜单「适应窗口」生效', await page.evaluate(() => window.app.getZoom() < 1), String(await page.evaluate(() => window.app.getZoom())));

/* ══════ 6. 多选 → 对齐项 ══════ */
await page.keyboard.press('Control+0');
await page.keyboard.press('Control+a');
await page.waitForTimeout(200);
await rightClick(page.locator('#canvas .wd').first());
const multiItems = await menuItems();
ok('多选右键 → 出现对齐/等间距项',
  ['左对齐', '右对齐', '顶对齐', '底对齐', '水平等间距', '垂直等间距'].every(l => multiItems.includes(l)), JSON.stringify(multiItems));
ok('多选标题显示数量', /已选中 \d+ 个控件/.test(await page.evaluate(() => document.querySelector('#ctxMenu .ctx-head')?.textContent || '')),
  await page.evaluate(() => document.querySelector('#ctxMenu .ctx-head')?.textContent));
await clickMenu('左对齐');
const alignedX = await page.evaluate(() => {
  const xs = window.app.project.currentWidgets().map(w => w.x);
  return new Set(xs).size;
});
ok('菜单「左对齐」生效（所有 x 相同）', alignedX === 1, `不同 x 个数=${alignedX}`);

/* ══════ 7. 面板标签右键：浮动 / 停靠 ══════ */
await page.mouse.click(760, 700, { button: 'right' });   // 关掉可能残留的菜单
await rightClick(page.locator('#leftPanel .lp-tab[data-panel="vars"]'));
const tabItems = await menuItems();
ok('标签菜单含浮动/停靠项',
  ['浮动为窗口', '停靠到左侧', '停靠到右侧', '停靠到底部', '停靠回原来的区域'].every(l => tabItems.includes(l)), JSON.stringify(tabItems));
await clickMenu('浮动为窗口');
const floatState = await page.evaluate(() => {
  const pv = document.getElementById('panel-vars');
  const head = pv.querySelector('.panel-head');
  return {
    cls: pv.className, parent: pv.parentElement.tagName,
    headDisplay: head ? getComputedStyle(head).display : 'NO-HEAD',
    headW: head ? Math.round(head.getBoundingClientRect().width) : 0,
  };
});
ok('菜单「浮动为窗口」生效（独立小窗且标题栏可见）',
  floatState.cls.includes('floating') && floatState.headDisplay === 'flex' && floatState.headW > 0,
  JSON.stringify(floatState));
await rightClick(page.locator('#panel-vars .panel-head'));
ok('浮动小窗标题栏右键也能出菜单', await menuOpen() && (await menuItems()).includes('停靠到底部'),
  JSON.stringify(await menuItems()));
await clickMenu('停靠到底部');
ok('浮动窗右键「停靠到底部」生效',
  await page.evaluate(() => document.getElementById('panel-vars').closest('.dock')?.id === 'bottomPanel'));

/* ══════ 8. 清单行右键 ══════ */
await page.click('.lp-tab[data-panel="list"]').catch(() => {});
await page.waitForTimeout(150);
const wl = page.locator('#widgetList .wl-item').first();
const wlName = await wl.locator('.wl-name').textContent();
const before2 = await page.evaluate(() => window.app.project.currentWidgets().length);
await rightClick(wl);
ok('清单行菜单含定位/删除', (await menuItems()).some(x => x.includes('在画布中定位')) && (await menuItems()).includes('删除控件'),
  JSON.stringify(await menuItems()));
await clickMenu('删除控件');
const after2 = await page.evaluate(() => window.app.project.currentWidgets().length);
ok('清单行「删除控件」生效', after2 === before2 - 1, `${before2} → ${after2}`);

/* ══════ 9. 页面行右键 ══════ */
await page.click('.lp-tab[data-panel="pages"]');
await page.waitForTimeout(150);
await rightClick(page.locator('#pageList .pg-item').first());
const pgItems = await menuItems();
ok('页面行菜单含重命名/新建/删除',
  pgItems.includes('重命名…') && pgItems.includes('新建页面') && pgItems.includes('删除此页'), JSON.stringify(pgItems));
// ⚠ 页数别写死（内置模板有几页是会变的）：只要求"+1"
const pagesBefore = await page.evaluate(() => window.app.project.pages().length);
await clickMenu('新建页面');
const pageCount = await page.evaluate(() => window.app.project.pages().length);
ok('页面行「新建页面」生效', pageCount === pagesBefore + 1, `页面数=${pagesBefore} → ${pageCount}`);

/* ══════ 10. 变量行右键 ══════ */
await page.click('.lp-tab[data-panel="vars"]');
await page.waitForTimeout(150);
const varCount0 = await page.evaluate(() => window.app.project.variables().length);
await rightClick(page.locator('#varTable tr[data-name]').first());
const varItems = await menuItems();
ok('变量行菜单含复制变量名/添加/删除',
  varItems.includes('复制变量名') && varItems.includes('添加变量') && varItems.includes('删除变量'), JSON.stringify(varItems));
await clickMenu('添加变量');
ok('变量行「添加变量」生效', await page.evaluate(() => window.app.project.variables().length) === varCount0 + 1);
// ⚠ 变量表是**窗口化**渲染的：DOM 里第一行不一定是 variables()[0]，而且新建变量后列表可能滚动。
//   要删的是"右键的那一行"：先把那一行滚进可视区，再从**同一个 locator** 取名字。
const row1 = page.locator('#varTable tr[data-name]').first();
await row1.scrollIntoViewIfNeeded();
await page.waitForTimeout(120);
const name1 = await row1.getAttribute('data-name') || '';
await rightClick(row1);
await clickMenu('删除变量');
ok('变量行「删除变量」生效（confirm 后）',
  !!name1 && await page.evaluate(n => !window.app.project.variables().some(v => v.name === n), name1), name1);

/* ══════ 11. 输入框里保留浏览器原生菜单 ══════ */
// 前面「新建页面」把当前页切到了新空页 → 先回到第一页并选中一个控件
await page.evaluate(() => window.app.project.setCurrentPage(window.app.project.pages()[0].id));
await page.waitForTimeout(200);
await page.evaluate(() => {
  const el = document.querySelector('#canvas .wd');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await page.waitForTimeout(250);
const inputNative = await page.evaluate(() => {
  const inp = document.querySelector('#propBody [data-fld="x"]');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  return { notPrevented: inp.dispatchEvent(ev) === true, menuOpen: !document.getElementById('ctxMenu').classList.contains('hidden') };
});
ok('输入框里不屏蔽浏览器菜单（复制/粘贴要用）', inputNative.notPrevented && !inputNative.menuOpen, JSON.stringify(inputNative));

/* ══════ 12. 贴边不出屏 + 点别处关闭 ══════ */
await page.mouse.click(1490, 880, { button: 'right' });
await page.waitForTimeout(220);
const clamped = await page.evaluate(() => {
  const r = document.getElementById('ctxMenu').getBoundingClientRect();
  return { right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight };
});
ok('右下角右键菜单不出屏', clamped.right <= clamped.vw && clamped.bottom <= clamped.vh, JSON.stringify(clamped));
await page.mouse.click(400, 400);
await page.waitForTimeout(180);
ok('点别处关闭菜单', !(await menuOpen()));

/* ══════ 13. 运行态右键 ══════ */
await page.evaluate(() => window.app.enterRun());
await page.waitForTimeout(500);
const rtPrevented = await page.evaluate(() => {
  const el = document.querySelector('#rtPage');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 });
  return el.dispatchEvent(ev) === false;
});
const rtItems = await menuItems();
ok('运行态右键：屏蔽浏览器菜单 + 给出运行相关项',
  rtPrevented && rtItems.length >= 3 && rtItems.some(x => x.includes('变量监控')) && rtItems.some(x => x.includes('退出运行')),
  JSON.stringify(rtItems));
// 进运行态变量监控整个收起（运行主页面一个按钮都不摆），菜单项这里是「显示变量监控」——
// 断言按「点一下状态翻转」写，别钉死成 folded
const varsBefore = await page.evaluate(async () => (await import('/js/runtime/runtime.js')).isVarsVisible());
await clickMenu(rtItems.find(x => x.includes('变量监控')));
const varsAfter = await page.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  return { vis: m.isVarsVisible(), folded: m.isVarsFolded(), rows: document.querySelectorAll('.rtv-row').length };
});
ok('运行态菜单能开关变量监控（点一下状态翻转、直接给列表）',
  varsBefore === false && varsAfter.vis === true && varsAfter.folded === false && varsAfter.rows > 0,
  JSON.stringify({ varsBefore, ...varsAfter }));
await page.evaluate(() => window.app.exitRun());

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 右键菜单回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
