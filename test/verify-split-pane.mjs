// verify-split-pane.mjs — 停靠区分屏（变量 / 报警 / 清单 对着看）+ 变量表列宽
//   现场诉求：变量和报警对着看是常态（报警条件里引用的变量名），来回切标签页太难受；
//   所以支持：点 ⇹ 一次把同区面板都摊开成栏（最多 3 栏）/ 拖标签到面板上分屏、
//   每两栏之间一条可拖的分隔条、双击分隔条一级一级撤（3 栏 → 2 栏 → 标签页）。
//   分屏时**顶上一排就是「栏标题行」**：每格宽度跟下面那一栏对齐，栏名正好压在各自栏上。
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8903';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null; m.backend.state = 'offline';
  m.backend.writeVar = async () => {}; m.backend.readVars = async () => null;
  m.backend.plcInfo.protocol = 'modbus';
  m.backend.getPlc = async () => ({ ok: true, config: {}, status: { mode: 'memory', protocol: 'modbus' } });
}));
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  const NS = 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.';
  ['a', 'b', 'c'].forEach(n => m.data.variables.push({ name: n, type: 'int', address: NS + 'GVL.' + n, value: 0, len: 0 }));
  m.data.variables.push({ name: 's1', type: 'string', address: NS + 'GVL.s1', value: '', len: 20 });
  const al = m.addAlarm();
  m.updateAlarm(al.id, { name: '报警1', variable: 'a', op: '>=', value: 1, level: 'alarm', text: 'a 超限' });
  m.commit('分屏测试');
});

/* 把三个面板都放到**底部**停靠区（分屏要有面板可摊开） */
const toBottom = async (id) => {
  await page.evaluate(async (id) => {
    const d = await import('/js/editor/dock.js');
    d.dockPanelTo(id, 'bottom');
  }, id);
  await sleep(250);
};
await toBottom('vars');
await toBottom('alarms');
await toBottom('list');
const layout1 = await page.evaluate(async () => (await import('/js/editor/dock.js'))._getLayout());
ok('三个面板都在底部停靠区（准备摊开成栏）',
  ['vars', 'alarms', 'list'].every(x => layout1.bottom.includes(x)), JSON.stringify(layout1.bottom));
ok('没分屏时：底部只有一个面板可见、分隔条不存在',
  (await page.evaluate(() => document.querySelectorAll('#bottomPanel .panel.active').length)) === 1
  && (await page.evaluate(() => !document.querySelector('#bottomPanel .dock-divider'))));

/* ── 点一次 ⇹：直接把同区面板都摊开成栏（3 个面板 → 3 栏）── */
await toBottom('vars');
await page.click('#bottomPanel .dock-splitbtn');
await sleep(400);
const st = await page.evaluate(() => {
  const box = document.getElementById('bottomPanel');
  const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  return {
    split: box.querySelector('.dock-panes').classList.contains('split'),
    shown: shown.map(p => p.dataset.panel),
    widths: shown.map(p => Math.round(p.getBoundingClientRect().width)),
    divs: [...box.querySelectorAll('.dock-divider')].length,
    btnOn: box.querySelector('.dock-splitbtn')?.classList.contains('on'),
    total: box.querySelector('.dock-panes').getBoundingClientRect().width,
  };
});
ok('点一次 ⇹ → 同区面板一次摊开成三栏（变量 + 报警 + 清单）',
  st.split === true && st.shown.length === 3
  && ['vars', 'alarms', 'list'].every(x => st.shown.includes(x)), JSON.stringify(st.shown));
ok('三栏大致等宽（每栏约 1/3，且都还够宽）',
  st.widths.every(w => Math.abs(w - st.total / 3) < st.total * 0.08) && st.widths.every(w => w > 120),
  JSON.stringify([st.widths, st.total]));
ok('三栏之间两条可拖的分隔条，⇹ 按钮变成「已分屏」态', st.divs === 2 && st.btnOn === true, JSON.stringify([st.divs, st.btnOn]));

/* 分屏时顶上一排 = 「栏标题行」：每栏一个格，格宽跟下面那一栏严丝合缝；栏自己的标题栏藏起来 */
const heads = await page.evaluate(() => {
  const box = document.getElementById('bottomPanel');
  const tabs = box.querySelector('.dock-tabs');
  const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  const cells = [...tabs.querySelectorAll('.pane-cell')].map(c => {
    const r = c.getBoundingClientRect();
    return { pane: c.dataset.paneCell, tab: c.querySelector('.lp-tab')?.textContent || '', x: Math.round(r.x), w: Math.round(r.width) };
  });
  return {
    isHeadRow: tabs.classList.contains('split-head'),
    cells,
    panes: shown.map(p => {
      const r = p.getBoundingClientRect();
      const head = p.querySelector('.panel-head');
      return {
        id: p.dataset.panel, x: Math.round(r.x), w: Math.round(r.width),
        headHidden: head ? getComputedStyle(head).display === 'none' : true,
      };
    }),
    topTabs: [...tabs.querySelectorAll(':scope > .lp-tab')].map(t => t.dataset.panel),
    gaps: [...tabs.querySelectorAll('.pane-gap')].map(g => Math.round(g.getBoundingClientRect().width)),
  };
});
ok('分屏时顶上一排变成「栏标题行」，每栏一个格子（栏名只出现这一处）',
  heads.isHeadRow === true && heads.cells.length === 3 && heads.cells.every(c => c.tab) && heads.topTabs.length === 0,
  JSON.stringify({ cells: heads.cells, topTabs: heads.topTabs }));
ok('每个栏标题格的左右边界跟它下面那一栏对齐（位置对得上）',
  heads.cells.length === 3
  && heads.cells.every((c, i) => Math.abs(c.x - heads.panes[i].x) <= 2 && Math.abs(c.w - heads.panes[i].w) <= 2),
  JSON.stringify({ cells: heads.cells.map(c => [c.x, c.w]), panes: heads.panes.map(p => [p.x, p.w]) }));
ok('栏自己的标题栏藏起来（省下的高度全给内容）',
  heads.panes.every(p => p.headHidden), JSON.stringify(heads.panes.map(p => p.headHidden)));
ok('格与格之间留了跟分隔条同宽的占位（8px）',
  heads.gaps.length === 2 && heads.gaps.every(g => g === 8), JSON.stringify(heads.gaps));
ok('同一区里没进分屏的面板**不会**跟着显示出来（只显示摊开的那几栏）',
  (await page.evaluate(() => [...document.querySelectorAll('#bottomPanel .dock-panes > .panel')]
    .filter(p => getComputedStyle(p).display !== 'none').length)) === 3,
  await page.evaluate(() => [...document.querySelectorAll('#bottomPanel .dock-panes > .panel')]
    .filter(p => getComputedStyle(p).display !== 'none').map(p => p.dataset.panel).join(',')));
ok('分割栏看得见：有宽度、有抓手',
  (await page.evaluate(() => {
    const d = document.querySelector('#bottomPanel .dock-divider');
    return Math.round(d.getBoundingClientRect().width);
  })) >= 6
  && (await page.evaluate(() => !!document.querySelector('#bottomPanel .dock-divider .dock-divider-grip'))));

/* ── 拖第 1 条分隔条：只动第 1、2 栏，第 3 栏原地不动 ── */
const div1 = await page.locator('#bottomPanel .dock-divider[data-idx="1"]').boundingBox();
await page.mouse.move(div1.x + div1.width / 2, div1.y + div1.height / 2);
await page.mouse.down();
await page.mouse.move(div1.x + div1.width / 2 - 220, div1.y + div1.height / 2, { steps: 6 });
await page.mouse.up();
await sleep(350);
const st2 = await page.evaluate(async () => {
  const box = document.getElementById('bottomPanel');
  const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  const tabs = box.querySelector('.dock-tabs');
  return {
    widths: shown.map(p => Math.round(p.getBoundingClientRect().width)),
    xs: shown.map(p => Math.round(p.getBoundingClientRect().x)),
    cellXs: [...tabs.querySelectorAll('.pane-cell')].map(c => Math.round(c.getBoundingClientRect().x)),
    grow: (await import('/js/editor/dock.js'))._getLayout().split.bottom?.grow,
  };
});
ok('拖第 1 条分隔条 → 第 1 栏变窄、第 3 栏原地不动，比例记进布局',
  st2.widths[0] < st.widths[0] - 80 && Math.abs(st2.widths[2] - st.widths[2]) <= 3 && st2.grow?.[0] < 0.3,
  JSON.stringify([st.widths, st2.widths, st2.grow]));
ok('拖完之后栏标题格仍然跟各栏对齐',
  st2.cellXs.length === 3 && st2.cellXs.every((x, i) => Math.abs(x - st2.xs[i]) <= 2),
  JSON.stringify([st2.cellXs, st2.xs]));

/* ── 双击分隔条：三栏 → 两栏 ── */
await page.evaluate(() => {
  const d = document.querySelector('#bottomPanel .dock-divider[data-idx="1"]');
  const r = d.getBoundingClientRect();
  d.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.x + 4, clientY: r.y + 4 }));
});
await sleep(350);
let st3 = await page.evaluate(async () => {
  const box = document.getElementById('bottomPanel');
  return {
    split: box.querySelector('.dock-panes').classList.contains('split'),
    shown: [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none').length,
    divs: [...box.querySelectorAll('.dock-divider')].length,
    cells: [...box.querySelectorAll('.dock-tabs .pane-cell')].length,
  };
});
ok('双击分隔条 → 三栏退回两栏（还剩 1 条分隔条、2 个栏标题格）',
  st3.split === true && st3.shown === 2 && st3.divs === 1 && st3.cells === 2, JSON.stringify(st3));

/* ── 再双击：两栏 → 合回标签页 ── */
const secondPane = await page.evaluate(async () => (await import('/js/editor/dock.js'))._getLayout().split.bottom.extra[0]);
await page.evaluate(() => {
  const d = document.querySelector('#bottomPanel .dock-divider');
  const r = d.getBoundingClientRect();
  d.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.x + 4, clientY: r.y + 4 }));
});
await sleep(350);
st3 = await page.evaluate(async () => {
  const box = document.getElementById('bottomPanel');
  return {
    split: box.querySelector('.dock-panes').classList.contains('split'),
    shown: [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none').length,
    divs: [...box.querySelectorAll('.dock-divider')].length,
    cells: [...box.querySelectorAll('.dock-tabs .pane-cell')].length,
    active: (await import('/js/editor/dock.js'))._getLayout().active.bottom,
    tabs: [...box.querySelectorAll('.lp-tab')].map(t => t.dataset.panel),
  };
});
ok('再双击 → 合回标签页（1 栏、没分隔条、顶上一排回到普通标签）',
  st3.split === false && st3.shown === 1 && st3.divs === 0 && st3.cells === 0, JSON.stringify(st3));
ok('合并后那一栏成为当前页，另外两个都还是标签',
  st3.active === secondPane && st3.tabs.length === 3, JSON.stringify([st3.active, secondPane, st3.tabs]));

/* ── 拖标签分屏（两栏那条路）：同区里把「另一个面板」的标签拖到当前面板上 ── */
const otherTab = await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  const l = d._getLayout();
  return l.bottom.find(id => id !== l.active.bottom);
});
const tab = await page.locator(`#bottomPanel .lp-tab[data-panel="${otherTab}"]`).boundingBox();
const pane = await page.locator('#bottomPanel .panel.active').boundingBox();
await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
await page.mouse.down();
await page.mouse.move(tab.x + tab.width / 2 + 20, tab.y + tab.height / 2 + 8, { steps: 3 });
// 落点落在**面板区**就是分屏（两侧 1/2 决定放哪边）
await page.mouse.move(pane.x + pane.width * 0.85, pane.y + pane.height / 2, { steps: 8 });
const hint = await page.evaluate(() => {
  const p = document.querySelector('.dock-preview.split');
  return p && getComputedStyle(p).display !== 'none' ? p.textContent : '';
});
await page.mouse.up();
await sleep(400);
const st4 = await page.evaluate(async () => {
  const box = document.getElementById('bottomPanel');
  const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  return {
    shown: shown.map(p => p.dataset.panel),
    split: (await import('/js/editor/dock.js'))._getLayout().split.bottom,
  };
});
ok('拖标签到面板上时给出「与…分屏」提示', /分屏/.test(hint), hint);
ok('松手即分屏：拖过来的那个在右边',
  st4.shown.length === 2 && st4.shown[1] === otherTab, JSON.stringify(st4.shown));
ok('分屏关系记进布局（刷新后还在）', st4.split?.extra?.[0] === otherTab, JSON.stringify(st4.split));

/* 已有两栏时，把第三个标签拖进分屏 → 直接加成三栏 */
const third = await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  const l = d._getLayout();
  const shown = [l.active.bottom, ...(l.split.bottom.extra || [])];
  return l.bottom.find(id => !shown.includes(id));
});
if (third) {
  const t3 = await page.locator(`#bottomPanel .lp-tab[data-panel="${third}"]`).boundingBox();
  const p3 = await page.locator('#bottomPanel .panel.active').boundingBox();
  await page.mouse.move(t3.x + t3.width / 2, t3.y + t3.height / 2);
  await page.mouse.down();
  await page.mouse.move(t3.x + t3.width / 2 + 20, t3.y + t3.height / 2 + 8, { steps: 3 });
  await page.mouse.move(p3.x + p3.width * 0.85, p3.y + p3.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const st5b = await page.evaluate(() => {
    const box = document.getElementById('bottomPanel');
    const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
    return { shown: shown.map(p => p.dataset.panel), divs: box.querySelectorAll('.dock-divider').length };
  });
  ok('两栏时把第三个标签拖进分屏 → 直接变成三栏',
    st5b.shown.length === 3 && st5b.shown.includes(third) && st5b.divs === 2, JSON.stringify(st5b));
} else {
  ok('两栏时把第三个标签拖进分屏 → 直接变成三栏', false, '（同区没有第三个面板可拖）');
}

/* 从**别的停靠区**拖进来也算分屏，落点在哪半边就放哪边 */
const leftDrop = await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  d.mergeSplitAt('bottom');                     // 先合起来，重新演一遍
  d.dockPanelTo('scripts', 'left');
  return d._getLayout().bottom;
});
await sleep(400);
const sTab = await page.locator('#leftPanel .lp-tab[data-panel="scripts"]').boundingBox();
const sPane = await page.locator('#bottomPanel .panel.active').boundingBox();
await page.mouse.move(sTab.x + sTab.width / 2, sTab.y + sTab.height / 2);
await page.mouse.down();
await page.mouse.move(sTab.x + 20, sTab.y + 10, { steps: 2 });
// 落在**左半边**（< 50%）→ 拖过来的那个应该放到左边
await page.mouse.move(sPane.x + sPane.width * 0.2, sPane.y + sPane.height / 2, { steps: 8 });
await page.mouse.up();
await sleep(400);
const st6 = await page.evaluate(async () => {
  const box = document.getElementById('bottomPanel');
  const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  return {
    shown: shown.map(p => p.dataset.panel),
    split: (await import('/js/editor/dock.js'))._getLayout().split.bottom,
  };
});
ok('从别的区拖进面板区 → 自动分屏，落在左半边就放左边',
  st6.shown.length === 2 && st6.shown[0] === 'scripts' && !(st6.split?.extra || []).includes('scripts'),
  JSON.stringify([leftDrop, st6]));

/* 刷新之后还是分屏的样子 */
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(600);
const st7 = await page.evaluate(() => {
  const box = document.getElementById('bottomPanel');
  const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  return {
    shown: shown.map(p => p.dataset.panel),
    divs: box.querySelectorAll('.dock-divider').length,
    cells: box.querySelectorAll('.dock-tabs .pane-cell').length,
  };
});
ok('刷新后仍是分屏（布局持久化，栏标题行也回来了）',
  st7.shown.length === 2 && st7.divs === 1 && st7.cells === 2, JSON.stringify(st7));

/* 三栏也能持久化 */
await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  d.dockPanelTo('list', 'bottom');
  d.splitPanels('vars', 'alarms', 'list');
});
await sleep(450);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(700);
const st8 = await page.evaluate(() => {
  const box = document.getElementById('bottomPanel');
  const shown = [...box.querySelectorAll('.dock-panes > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  const panes = shown.map(p => Math.round(p.getBoundingClientRect().x));
  const cells = [...box.querySelectorAll('.dock-tabs .pane-cell')].map(c => Math.round(c.getBoundingClientRect().x));
  return { shown: shown.map(p => p.dataset.panel), divs: box.querySelectorAll('.dock-divider').length, panes, cells };
});
ok('刷新后三栏分屏仍在，且栏标题格仍与各栏对齐',
  st8.shown.length === 3 && st8.divs === 2 && st8.cells.length === 3
  && st8.cells.every((x, i) => Math.abs(x - st8.panes[i]) <= 2), JSON.stringify(st8));

/* 分屏里的面板被拖走 → 三栏退两栏、再拖走 → 分屏解除（不留空窗格） */
const removed = await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  const l1 = d._getLayout();
  const thirdId = l1.split.bottom.extra[1];      // 第 3 栏（extra 里的第 2 个）
  d.dockPanelTo(thirdId, 'left');                // 第 3 栏走掉
  const l2 = d._getLayout();
  const moving = l2.active.bottom;               // 再拖走第 1 栏
  d.dockPanelTo(moving, 'left');
  const l3 = d._getLayout();
  return { thirdId, afterThird: l2.split.bottom, moved: moving, split: l3.split.bottom, bottom: l3.bottom };
});
ok('拖走第 3 栏 → 三栏自动退回两栏',
  removed.afterThird && removed.afterThird.extra.length === 1, JSON.stringify(removed.afterThird));
ok('再拖走分屏里的栏 → 分屏自动解除（不留空窗格）',
  removed.split === null && !removed.bottom.includes(removed.moving), JSON.stringify(removed));

/* ── 四栏：栏数不写死（底部区 4 个面板 → 4 栏）── */
await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  d._resetLayout();
  await new Promise(r => setTimeout(r, 150));
  ['vars', 'alarms', 'list', 'scripts'].forEach(id => d.dockPanelTo(id, 'bottom'));
});
await sleep(400);
const four = () => page.evaluate(() => {
  const box = document.getElementById('bottomPanel');
  const tabs = box.querySelector('.dock-tabs');
  const panes = box.querySelector('.dock-panes');
  const shown = [...panes.querySelectorAll(':scope > .panel')].filter(p => getComputedStyle(p).display !== 'none');
  return {
    ids: shown.map(p => p.dataset.panel),
    ws: shown.map(p => Math.round(p.getBoundingClientRect().width)),
    xs: shown.map(p => Math.round(p.getBoundingClientRect().x)),
    divs: panes.querySelectorAll('.dock-divider').length,
    cells: [...tabs.querySelectorAll('.pane-cell')].map(c => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width) };
    }),
  };
});
await page.click('#bottomPanel .dock-splitbtn');
await sleep(450);
let s4 = await four();
ok('点一次 ⇹ → 同区 4 个面板全摊开成 4 栏', s4.ids.length === 4, JSON.stringify(s4.ids));
ok('4 栏之间有 3 条分隔条，且每栏都还够宽（>=120px）',
  s4.divs === 3 && s4.ws.every(w => w >= 120), JSON.stringify([s4.divs, s4.ws]));
ok('4 栏大致等宽（每栏约 1/4）',
  s4.ws.every(w => Math.abs(w - s4.ws.reduce((a, b) => a + b, 0) / 4) < 40), JSON.stringify(s4.ws));
ok('顶上一排 4 个栏标题格，跟各栏左右边界一一对齐',
  s4.cells.length === 4 && s4.cells.every((c, i) => Math.abs(c.x - s4.xs[i]) <= 2 && Math.abs(c.w - s4.ws[i]) <= 2),
  JSON.stringify({ cells: s4.cells.map(c => [c.x, c.w]), panes: s4.xs.map((x, i) => [x, s4.ws[i]]) }));

// 双击第 2 条分隔条 → 撤掉它右边那一栏（4 → 3）
await page.evaluate(() => {
  const d = document.querySelector('#bottomPanel .dock-divider[data-idx="2"]');
  const r = d.getBoundingClientRect();
  d.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.x + 4, clientY: r.y + 4 }));
});
await sleep(400);
s4 = await four();
ok('双击第 2 条分隔条 → 撤掉它右边那一栏（4 栏 → 3 栏）',
  s4.ids.length === 3 && s4.divs === 2, JSON.stringify([s4.ids, s4.divs]));

/* ── 变量表列宽：名称/类型不再占一大片，地址拿到剩余宽度 ── */
await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  d.dockPanelTo('vars', 'bottom');
});
await sleep(300);
const widths = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('#varTable tr')].find(r => r.dataset.name === 's1');
  if (!tr) return null;
  const tds = [...tr.children].map(td => Math.round(td.getBoundingClientRect().width));
  const inputs = [...tr.querySelectorAll('input')].map(i => i.dataset.k);
  return { tds, inputs, lenCell: tr.children[4].textContent.trim(), lenInput: !!tr.querySelector('input[data-k="len"]') };
});
ok('列宽重排：地址列最宽（吃掉剩余空间），名称/类型列不再浪费',
  widths && widths.tds[3] > widths.tds[1] && widths.tds[3] > widths.tds[2] && widths.tds[1] <= widths.tds[3],
  JSON.stringify(widths));
ok('字符串变量才有「字长」输入框（1 字/2 字那种由类型推出来的不再算数据）',
  widths.lenInput === true, JSON.stringify([widths.lenCell, widths.lenInput]));
const intRow = await page.evaluate(async () => {
  // 「字长」并进地址格之后：整数变量**只有内部变量（没地址）**才显示灰字「N 字」——
  // 有地址的变量把那 20px 留给地址本身（300px 面板里 `%MW5426` 刚好被挤没），
  // 占几个字改在地址的悬停提示里说明（见 addrTitle）。这里补一个内部变量来验那一支。
  const { project } = await import('/js/core/project.js');
  if (!project.variables().some(v => !String(v.address || '').trim())) {
    project.data.variables.push({ name: '内测_内部', type: 'uint', address: '', value: 0, len: 0 });
    project.commit('列宽检查');
    await new Promise(r => setTimeout(r, 300));
  }
  const trOf = (n) => [...document.querySelectorAll('#varTable tr')].find(r => r.dataset.name === n);
  const withAddr = trOf('a');
  const internal = project.variables().find(v => !String(v.address || '').trim());
  const cell = internal ? trOf(internal.name)?.children[3] : null;
  return {
    hasLenInput: !!withAddr?.querySelector('input[data-k="len"]'),
    addrTitle: (withAddr?.querySelector('input[data-k="address"]')?.title || '').slice(0, 30),
    internalAuto: cell?.querySelector('.vt-auto')?.className || '',
    internalText: cell?.querySelector('.vt-auto')?.textContent?.trim() || '',
  };
});
ok('整数变量没有「字长」输入框；内部变量那条显示灰提示 .vt-auto（有地址的看地址悬停提示）',
  intRow.hasLenInput === false && intRow.addrTitle.length > 0 && intRow.internalAuto === 'vt-auto',
  JSON.stringify(intRow));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 分屏 + 变量表列宽：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
