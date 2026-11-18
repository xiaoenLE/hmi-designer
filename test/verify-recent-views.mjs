// verify-recent-views.mjs — 编辑态顶栏「最近打开的视图」页签条 + 缩放/画布设置搬到状态栏
// 用法：先启动 8866 服务（推荐 node tools/run-suites.mjs verify-recent-views，会自己起隔离后端），
//       再 node test/verify-recent-views.mjs [端口]
//
// 盯的行为（现场口径，2.1.5）：
//   ① 顶栏不再摆「页名 + 缩放/适应/画布设置」，改成最近打开的视图页签（像浏览器标签页）；
//   ② 缩放 / 适应 / 画布设置搬到最下面状态栏；
//   ③ 点页签就切页；页签按打开顺序排、新打开追加到右边；刷新后还记得；
//   ④ 页签**不设上限**（打开过的都在，工程删页才剔掉）；摆不下时两边出 ◀ ▶；
//   ⑤ 页签尾巴有 ✕（只关页签、页面不删）；右键 = 关闭 / 除此以外关闭所有 / 删除（删除会先问一句）。
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

async function boot() {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project?.data);
  await page.waitForTimeout(300);      // 等 rAF 里那次 render
}
const tabsInfo = () => page.evaluate(() => {
  const list = document.getElementById('rvList');
  return {
    count: list.querySelectorAll('.rv-tab').length,
    active: list.querySelector('.rv-tab.active')?.dataset.pageId || null,
    ids: [...list.querySelectorAll('.rv-tab')].map(t => t.dataset.pageId),
    names: [...list.querySelectorAll('.rv-tab')].map(t => t.querySelector('.rv-name')?.textContent || ''),
    scrollW: list.scrollWidth,
    clientW: list.clientWidth,
    scrollLeft: list.scrollLeft,
    prevHidden: document.getElementById('rvPrev').classList.contains('hidden'),
    nextHidden: document.getElementById('rvNext').classList.contains('hidden'),
  };
});

/* ══════ 0. 结构：顶栏是页签条，缩放/画布设置在状态栏 ══════ */
await boot();
ok('#recentViews 在顶栏里', await page.evaluate(() => !!document.querySelector('#canvasToolbar #recentViews')));
ok('缩放/适应/画布设置搬到了状态栏', await page.evaluate(() => {
  const inStatus = ['btnZoomOut', 'zoomLabel', 'btnZoomIn', 'btnZoomFit', 'btnCanvasSetting']
    .every(id => document.getElementById(id)?.closest('#statusbar'));
  const oldTop = ['btnZoomOut', 'zoomLabel', 'btnZoomIn', 'btnZoomFit', 'btnCanvasSetting']
    .some(id => document.getElementById(id)?.closest('#canvasToolbar'));
  return inStatus && !oldTop;
}));
ok('顶栏不再显示页名/类型徽标', await page.evaluate(() =>
  getComputedStyle(document.getElementById('pageTitle')).display === 'none'
  && getComputedStyle(document.getElementById('pageTypeBadge')).display === 'none'));
const cur0 = await page.evaluate(() => window.app.project.currentId);
let t0 = await tabsInfo();
ok('当前页有高亮页签', t0.active === cur0, `${t0.active} vs ${cur0}`);
ok('页签名 = 当前页名', await page.evaluate((id) => {
  const p = window.app.project.getPage(id);
  const tab = document.querySelector(`#rvList .rv-tab[data-page-id="${id}"] .rv-name`);
  return !!p && !!tab && tab.textContent === p.name;
}, cur0));

/* ══════ 1. 切页 → 新页签追加并高亮；点旧页签切回 ══════ */
const pages = await page.evaluate(() => window.app.project.pages().map(p => ({ id: p.id, name: p.name })));
const pageTooFew = pages.length < 2;
if (pageTooFew) ok('工程里至少有两个页面（才测得了页签切换）', false, `${pages.length} 个页面`);
const other = pages.find(p => p.id !== cur0);
if (other) {
  await page.evaluate((id) => window.app.project.setCurrentPage(id), other.id);
  await page.waitForTimeout(250);
  const t1 = await tabsInfo();
  ok('切到另一个页面 → 多一个页签', t1.count === t0.count + 1, `${t0.count} → ${t1.count}`);
  ok('新页签高亮的是刚打开的页', t1.active === other.id, t1.active || '(无)');
  ok('新页签排在最后（打开顺序）', t1.ids[t1.ids.length - 1] === other.id, t1.ids.join(','));
  ok('原来的页签还在、不再高亮', t1.ids.includes(cur0), t1.ids.join(','));

  await page.click(`#rvList .rv-tab[data-page-id="${cur0}"]`);
  await page.waitForTimeout(250);
  const t2 = await tabsInfo();
  const nowId = await page.evaluate(() => window.app.project.currentId);
  ok('点页签就切过去', nowId === cur0, `${nowId}`);
  ok('点过之后高亮跟着走', t2.active === cur0, t2.active || '(无)');
  ok('页签条不会因为点击而重排', t2.ids.join(',') === t1.ids.join(','), t2.ids.join(','));
}

/* ══════ 2. 刷新后页签还记得（localStorage，按工程名分） ══════ */
await boot();
const t3 = await tabsInfo();
const curAfterReload = await page.evaluate(() => window.app.project.currentId);
ok('刷新后页签还在', t3.count >= 2, `${t3.count} 个`);
ok('刷新后高亮的是当前页', t3.active === curAfterReload, `${t3.active} vs ${curAfterReload}`);

/* ══════ 3. 不设上限（开多少都在）+ 摆不下时出左右箭头 ══════
   往工程里临时塞 20 个假页（只动内存、不发 project:changed，所以不会存档），逐个打开。
   现场口径（2.1.5 改）：以前超过 16 个会挤掉最久没用过的 —— 现场开多了发现"页签悄悄没了"，
   所以现在不设上限，摆不下的靠 ◀ ▶ 翻。 */
const fakeIds = await page.evaluate(() => {
  const p = window.app.project;
  const ids = [];
  for (let i = 1; i <= 20; i++) {
    const id = 'tmp-rv-' + i;
    // 名字故意长一点，保证 20 个页签在 1500px 宽的窗口里一定溢出
    p.data.pages.push({ id, name: `临时视图 ${String(i).padStart(2, '0')}：这是一条很长的页签名`, widgets: [] });
    ids.push(id);
  }
  return ids;
});
const beforeFakes = (await tabsInfo()).count;      // 前面几个用例已经开了几个真页签
for (const id of fakeIds) {
  await page.evaluate((x) => window.app.project.setCurrentPage(x), id);
  await page.waitForTimeout(35);
}
await page.waitForTimeout(250);
const t4 = await tabsInfo();
ok('打开 20 个都在条上（不设上限、不挤掉）', t4.count === beforeFakes + fakeIds.length, `${t4.count} / ${beforeFakes + fakeIds.length}`);
ok('每个打开过的页都有页签', fakeIds.every(id => t4.ids.includes(id)), t4.ids.join(','));
ok('高亮的是最后打开的页', t4.active === fakeIds[fakeIds.length - 1], `${t4.active}`);
ok('摆不下时两边出现翻页箭头', !t4.prevHidden && !t4.nextHidden, `prev=${t4.prevHidden} next=${t4.nextHidden}`);
ok('当前页签滚进可视区（不用手找）', await page.evaluate(() => {
  const list = document.getElementById('rvList');
  const act = list.querySelector('.rv-tab.active');
  if (!act) return false;
  const ar = act.getBoundingClientRect(), lr = list.getBoundingClientRect();
  return ar.left >= lr.left - 1 && ar.right <= lr.right + 1;
}));

await page.evaluate(() => { document.getElementById('rvList').scrollLeft = 0; });
await page.click('#rvNext');
await page.waitForTimeout(500);      // scroll-behavior: smooth
const scrolled = await page.evaluate(() => document.getElementById('rvList').scrollLeft);
ok('点 ▶ 往右翻', scrolled > 5, `scrollLeft=${scrolled}`);

/* ══════ 3b. 页签尾巴的 ✕ + 右键菜单 ══════
   现场口径：当前页签后面要有个 ✕ 直接关掉（只关页签、页面不删），
   右键是「关闭 / 除此以外关闭所有 / 删除」三项，不要「设置」。 */
const realIds = await page.evaluate(() => window.app.project.pages()
  .filter(p => !String(p.id).startsWith('tmp-rv-')).map(p => p.id));
if (realIds.length < 2) {
  ok('工程里至少有两个页面（才测得了关闭/右键菜单）', false, `${realIds.length} 个页面`);
} else {
  const [pgA, pgB] = realIds;
  const clickMenu = (label) => page.evaluate((text) => {
    const b = [...document.querySelectorAll('#ctxMenu .ctx-item')]
      .find(x => x.querySelector('.ctx-label')?.textContent.trim() === text);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  const menuOpen = () => page.evaluate(() => {
    const m = document.querySelector('#ctxMenu');
    return !!m && !m.classList.contains('hidden');
  });
  const tabIds = () => page.evaluate(() =>
    [...document.querySelectorAll('#rvList .rv-tab')].map(t => t.dataset.pageId));
  const pageIds = () => page.evaluate(() => window.app.project.pages().map(p => String(p.id)));

  // 先切到 A，右键 A →「除此以外关闭所有」，把页签收成确定的 [A]
  await page.evaluate(id => window.app.project.setCurrentPage(id), pgA);
  await page.waitForTimeout(220);
  ok('每个页签都带 ✕ 按钮', await page.evaluate(() =>
    [...document.querySelectorAll('#rvList .rv-tab')].every(t => !!t.querySelector('.rv-close'))));

  await page.click(`#rvList .rv-tab[data-page-id="${pgA}"]`, { button: 'right' });
  await page.waitForTimeout(120);
  ok('右键页签弹出菜单', await menuOpen());
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('#ctxMenu .ctx-item .ctx-label')].map(e => e.textContent.trim()));
  ok('菜单三项：关闭 / 除此以外关闭所有 / 删除（没有设置）',
    labels.join('|') === '关闭|除此以外关闭所有|删除', labels.join('|'));

  await clickMenu('除此以外关闭所有');
  await page.waitForTimeout(220);
  let ids = await tabIds();
  ok('「除此以外关闭所有」只留右键那个页签', ids.length === 1 && ids[0] === pgA, ids.join(','));
  ok('「除此以外关闭所有」后当前页就是它',
    await page.evaluate(id => window.app.project.currentId === id, pgA));

  // 开 B → 页签 [A,B]，当前 B
  await page.evaluate(id => window.app.project.setCurrentPage(id), pgB);
  await page.waitForTimeout(220);

  // ✕ 只长在当前页签上：别的页签那个叉是 opacity:0 + pointer-events:none，
  // 鼠标滑到它身上也不会冒出来（现场反馈：指到叉的位置它就显形了）
  await page.mouse.move(0, 0);      // 先让鼠标离开页签条（上一段右键点过页签，鼠标还停在那）
  await page.waitForTimeout(150);
  const closeInfo = (id) => page.evaluate(sel => {
    const el = document.querySelector(`#rvList .rv-tab[data-page-id="${sel}"] .rv-close`);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { opacity: s.opacity, pe: s.pointerEvents };
  }, id);
  const curClose = await closeInfo(pgB);
  const otherClose = await closeInfo(pgA);
  ok('当前页签的 ✕ 一直显示', curClose?.opacity === '0.55', JSON.stringify(curClose));
  ok('当前页签的 ✕ 能点', curClose?.pe === 'auto', JSON.stringify(curClose));
  ok('非当前页签不显示 ✕', otherClose?.opacity === '0', JSON.stringify(otherClose));
  ok('非当前页签的 ✕ 不接收鼠标（不会误关）', otherClose?.pe === 'none', JSON.stringify(otherClose));
  await page.hover(`#rvList .rv-tab[data-page-id="${pgA}"]`);
  await page.waitForTimeout(150);
  ok('鼠标指到非当前页签也不显示 ✕', (await closeInfo(pgA))?.opacity === '0');

  // 鼠标精确停到那个（看不见的）叉上 —— 以前它会自己显形
  const aCloseBox = await page.evaluate(sel => {
    const el = document.querySelector(`#rvList .rv-tab[data-page-id="${sel}"] .rv-close`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, pgA);
  await page.mouse.move(aCloseBox.x, aCloseBox.y);
  await page.waitForTimeout(150);
  ok('鼠标停在非当前页签的 ✕ 位置上也不显形', (await closeInfo(pgA))?.opacity === '0');
  // 在那个位置点一下：不会关页签，只会把该页签切成当前页
  await page.mouse.click(aCloseBox.x, aCloseBox.y);
  await page.waitForTimeout(200);
  ok('点非当前页签的 ✕ 位置不会关页签，只切过去',
    (await tabIds()).includes(pgA) && await page.evaluate(id => window.app.project.currentId === id, pgA));

  // 现在 A 是当前页签 → 它的 ✕ 显形；点它只关页签、不删页面，当前落到相邻页签
  await page.click(`#rvList .rv-tab[data-page-id="${pgA}"] .rv-close`);
  await page.waitForTimeout(240);
  ids = await tabIds();
  ok('点当前页签的 ✕ 只关掉那个页签', !ids.includes(pgA) && ids.includes(pgB), ids.join(','));
  ok('✕ 不删页面（A 页还在工程里）', (await pageIds()).includes(String(pgA)));
  ok('关掉当前页签 → 当前落到相邻页签',
    await page.evaluate(id => window.app.project.currentId === id, pgB));

  // 再开 A → 页签 [B,A]，当前 A；右键 B →「关闭」（B 不是当前页，当前页不变）
  await page.evaluate(id => window.app.project.setCurrentPage(id), pgA);
  await page.waitForTimeout(220);
  await page.click(`#rvList .rv-tab[data-page-id="${pgB}"]`, { button: 'right' });
  await page.waitForTimeout(120);
  await clickMenu('关闭');
  await page.waitForTimeout(220);
  ids = await tabIds();
  ok('右键「关闭」关掉页签', !ids.includes(pgB) && ids.includes(pgA), ids.join(','));
  ok('右键关的不是当前页签 → 当前页不变',
    await page.evaluate(id => window.app.project.currentId === id, pgA));

  // 「删除」= 真删页面：拿个假页试（带原生确认框，自动点「确定」）
  const delId = await page.evaluate(() => {
    const p = window.app.project;
    const id = 'tmp-rv-del';
    p.data.pages.push({ id, name: '假页-待删', type: 'page', widgets: [] });
    p.setCurrentPage(id);
    p.touch();
    return id;
  });
  await page.waitForTimeout(260);
  ok('假页切过去也有页签', (await tabIds()).includes(delId));
  const acceptOnce = (d) => d.accept();
  page.on('dialog', acceptOnce);
  await page.click(`#rvList .rv-tab[data-page-id="${delId}"]`, { button: 'right' });
  await page.waitForTimeout(120);
  ok('删除项在菜单里', await page.evaluate(() =>
    [...document.querySelectorAll('#ctxMenu .ctx-item .ctx-label')].some(e => e.textContent.trim() === '删除')));
  await clickMenu('删除');
  await page.waitForTimeout(300);
  page.off('dialog', acceptOnce);
  ok('右键「删除」真把页面删了', !(await pageIds()).includes(delId));
  ok('删掉的页页签也没了', !(await tabIds()).includes(delId));
  await page.evaluate(id => window.app.project.setCurrentPage(id), pgA);
  await page.waitForTimeout(200);
}

/* ══════ 3b. 弹窗页签靠颜色区分（跟左侧页面栏一个路子：那边弹窗是橙色「弹」徽标） ══════ */
const popId = await page.evaluate(() => {
  const p = window.app.project;
  const id = 'tmp-rv-pop1';
  p.data.pages.push({ id, name: '假弹窗页', type: 'popup', popupW: 420, popupH: 240, widgets: [] });
  p.setCurrentPage(id);
  p.touch();               // 发 project:changed → 页签重画
  return id;
});
await page.waitForTimeout(280);
const popInfo = await page.evaluate((id) => {
  const tab = document.querySelector(`#rvList .rv-tab[data-page-id="${id}"]`);
  if (!tab) return null;
  const name = tab.querySelector('.rv-name');
  const normal = document.querySelector('#rvList .rv-tab:not(.rv-popup)');
  return {
    cls: tab.className,
    color: getComputedStyle(name).color,
    normalColor: normal ? getComputedStyle(normal.querySelector('.rv-name')).color : '',
    shadow: getComputedStyle(tab).boxShadow,
    closeColor: getComputedStyle(tab.querySelector('.rv-close')).color,
    title: tab.title,
  };
}, popId);
ok('弹窗页的页签挂了 rv-popup 类', !!popInfo && /\brv-popup\b/.test(popInfo.cls), popInfo?.cls || '没页签');
ok('弹窗页签用橙色区分（#b45309）', !!popInfo && popInfo.color === 'rgb(180, 83, 9)', popInfo?.color);
ok('普通页签没被染色', !!popInfo && popInfo.normalColor !== 'rgb(180, 83, 9)', popInfo?.normalColor);
ok('弹窗页签当前页顶边也是橙色', !!popInfo && /245, 158, 11/.test(popInfo.shadow), popInfo?.shadow);
ok('弹窗页签的 ✕ 跟着是橙色', !!popInfo && popInfo.closeColor === 'rgb(180, 83, 9)', popInfo?.closeColor);
ok('弹窗页签 title 标了（弹窗）', !!popInfo && /（弹窗）/.test(popInfo.title), popInfo?.title);

const baseId = await page.evaluate(() => {
  const p = window.app.project;
  const id = 'tmp-rv-base1';
  p.data.pages.push({ id, name: '假底页', type: 'base', widgets: [] });
  p.setCurrentPage(id);
  p.touch();
  return id;
});
await page.waitForTimeout(280);
const baseInfo = await page.evaluate((id) => {
  const tab = document.querySelector(`#rvList .rv-tab[data-page-id="${id}"]`);
  if (!tab) return null;
  return {
    cls: tab.className,
    color: getComputedStyle(tab.querySelector('.rv-name')).color,
    shadow: getComputedStyle(tab).boxShadow,
    closeColor: getComputedStyle(tab.querySelector('.rv-close')).color,
    tags: tab.querySelectorAll('.rv-tag').length,
    text: tab.textContent,
    title: tab.title,
  };
}, baseId);
ok('公共底页签挂了 rv-base 类', !!baseInfo && /\brv-base\b/.test(baseInfo.cls), baseInfo?.cls || '没页签');
ok('公共底页签是紫色（#6d28d9）', !!baseInfo && baseInfo.color === 'rgb(109, 40, 217)', baseInfo?.color);
ok('公共底页签不再挂「公共底」文字标签', !!baseInfo && baseInfo.tags === 0, `${baseInfo?.tags} 个标签`);
ok('公共底页签当前页顶边也是紫色', !!baseInfo && /139, 92, 246/.test(baseInfo.shadow), baseInfo?.shadow);
ok('公共底页签的 ✕ 跟着是紫色', !!baseInfo && baseInfo.closeColor === 'rgb(109, 40, 217)', baseInfo?.closeColor);
ok('公共底页签 title 仍标（公共底）', !!baseInfo && /（公共底）/.test(baseInfo.title), baseInfo?.title);

/* ══════ 4. 假页清掉后页签自己收干净 ══════
   假页只活在内存里；但编辑器「自动保存」会在 800ms 防抖后把当前工程写进浏览器缓存，
   所以先清掉再等它写一次干净的，然后刷新验证「页签不残留、存档里也没假页」 */
await page.evaluate(() => {
  const p = window.app.project;
  p.data.pages = p.data.pages.filter(x => !String(x.id).startsWith('tmp-rv-'));
  p.setCurrentPage(p.data.pages[0].id);
  p.touch();                     // 发 project:changed → 页签重画 + 自动保存写回干净数据
});
await page.waitForTimeout(1200);   // 等自动保存的 800ms 防抖落地
const t5 = await tabsInfo();
ok('删掉的页不会留页签', !t5.ids.some(id => id.startsWith('tmp-rv-')), t5.ids.join(','));
ok('当前页仍然高亮', t5.active === (await page.evaluate(() => window.app.project.currentId)));

await boot();
const t6 = await tabsInfo();
ok('刷新后假页页签也不残留', !t6.ids.some(id => id.startsWith('tmp-rv-')), t6.ids.join(','));

/* ══════ 5. 没有未捕获的 JS 异常 ══════ */
ok('没有未捕获的 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

const pass = results.filter(r => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
