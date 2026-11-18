/**
 * recentViews.js — 编辑态顶栏的「最近打开的视图」页签条
 *
 * 现场口径：顶栏原来摆的是页名 + 类型徽标 + 缩放/适应/画布设置。那些是**偶尔调一次**的设置，
 * 一直占着最显眼的一行很浪费；现场想要的是像浏览器/编辑器那样一排标签页 —— 开过的画面都在，
 * 点一下就切过去。所以：
 *   顶栏   → 「最近打开的视图」页签条（本文件负责画）
 *   状态栏 → 缩放 / 适应 / 画布设置（index.html 里搬的，见 css/layout.css 的 .st-zoom）
 *
 * 规则（别乱改，套件 test/verify-recent-views.mjs 盯着）：
 *   · 按**第一次打开的顺序**排，新打开的画面追加到最右边；点页签只切页、不重排（重排会让页签乱跳）
 *   · **不设上限**：打开过的页都在条上（工程里删掉的页才剔掉）——
 *     以前挤掉「最久没用过的」，现场开多了会发现页签"悄悄没了"，以为打不开，反而添乱
 *   · 摆不下时两边出现 ◀ ▶ 翻页箭头（只在溢出时出现）；滚轮上下滚 = 左右滚
 *   · 页签上有个 ✕（关掉这个页签，页面本身不删），但**只有当前页签才显示**——
 *     别的页签连鼠标指上去也不露叉，要关它就先点它一下；右键还有
 *     「关闭 / 除此以外关闭所有 / 删除」（删除才是真删页面，会先问一句）
 *   · 弹窗页的页签用**橙色**、公共底用**紫色**区分（跟左侧页面栏的「弹」「底」徽标一个配色），
 *     ✕ 同色；类型只靠颜色表达，页签上不再挂「公共底」这种文字标签（挤名字）
 *   · 记住的是「工程名 → 页签」，换工程不串；刷新页面后页签还在
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { registerContextMenu } from '../core/contextMenu.js';
import { deletePageWithConfirm } from './pagesPanel.js';

const STORE_KEY = 'hmi-recent-views';

let listEl = null;
let prevBtn = null;
let nextBtn = null;
let store = {};          // { [工程名]: { order: [页id] } }
let rafId = 0;

/* ─────────── 存取 ─────────── */
const projectKey = () => {
  const name = project.data?.meta?.name;
  return typeof name === 'string' && name ? name : '默认工程';
};
const rec = () => {
  const k = projectKey();
  const o = store[k];
  if (o && Array.isArray(o.order)) return o;
  const fresh = { order: [] };
  store[k] = fresh;
  return fresh;
};
const persist = () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* 隐私模式/配额满：记不住就算了 */ }
};
const loadStore = () => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === 'object' && !Array.isArray(o)) store = o;
  } catch { store = {}; }
};

/* ─────────── 页面信息 ─────────── */
const pageLabel = (page) => (page && typeof page.name === 'string' && page.name) ? page.name : '(未命名页面)';
const isBasePage = (page) => !!page && (page.id === 'base' || page.type === 'base');
const isPopupPage = (page) => !!page && page.type === 'popup';

/** 工程里已经没有的页（被删了）从记录里剔掉 */
function prune() {
  const r = rec();
  const alive = new Set(project.pages().map(p => p.id));
  r.order = r.order.filter(id => alive.has(id));
}

/** 把当前页记进页签（不设上限：打开过的都留着，页太多靠左右箭头翻） */
function rememberCurrent() {
  const id = project.currentId;
  if (!id) return;
  const r = rec();
  if (!r.order.includes(id)) r.order.push(id);
}

/* ─────────── 画 ─────────── */
function render() {
  if (!listEl || !project.data) return;
  prune();
  rememberCurrent();

  const pages = new Map(project.pages().map(p => [p.id, p]));
  const r = rec();
  const cur = project.currentId;
  const hadFocus = listEl.contains(document.activeElement);

  listEl.textContent = '';
  for (const id of r.order) {
    const page = pages.get(id);
    if (!page) continue;
    // 用 div 而不是 button：页签里还套着一个 ✕ 按钮（按钮套按钮点不准）
    const tab = document.createElement('div');
    tab.className = 'rv-tab' + (id === cur ? ' active' : '')
      + (isPopupPage(page) ? ' rv-popup' : isBasePage(page) ? ' rv-base' : '');
    tab.dataset.pageId = id;
    tab.setAttribute('role', 'button');
    tab.tabIndex = 0;
    tab.title = pageLabel(page) + (isBasePage(page) ? '（公共底）' : isPopupPage(page) ? '（弹窗）' : '')
      + '\n右键：关闭 / 除此以外关闭所有 / 删除';

    const name = document.createElement('span');
    name.className = 'rv-name';
    name.textContent = pageLabel(page);
    tab.appendChild(name);

    // ✕ 只关页签，不删页面（删页面走右键「删除」，那边会问一句）
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rv-close';
    close.title = '关闭这个页签（页面本身不删）';
    close.setAttribute('aria-label', '关闭页签');
    close.textContent = '✕';
    tab.appendChild(close);
    listEl.appendChild(tab);
  }

  persist();
  updateArrows();
  scrollActiveIntoView();
  // 键盘在页签上时重画会丢焦点：还回当前页签，Tab 键继续能用
  if (hadFocus) {
    const act = listEl.querySelector('.rv-tab.active');
    if (act) act.focus({ preventScroll: true });
  }
}

function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; render(); });
}

function updateArrows() {
  if (!listEl || !prevBtn || !nextBtn) return;
  const over = listEl.scrollWidth - listEl.clientWidth > 2;
  prevBtn.classList.toggle('hidden', !over);
  nextBtn.classList.toggle('hidden', !over);
  if (!over) return;
  prevBtn.classList.toggle('dim', listEl.scrollLeft <= 1);
  nextBtn.classList.toggle('dim', listEl.scrollLeft >= listEl.scrollWidth - listEl.clientWidth - 1);
}

function scrollActiveIntoView() {
  const act = listEl.querySelector('.rv-tab.active');
  if (!act) return;
  const left = act.offsetLeft;
  const right = left + act.offsetWidth;
  let target = listEl.scrollLeft;
  if (left < listEl.scrollLeft) target = left;
  else if (right > listEl.scrollLeft + listEl.clientWidth) target = right - listEl.clientWidth;
  if (target === listEl.scrollLeft) return;
  // 这里要「立刻到位」：CSS 上是 scroll-behavior: smooth，连续切页时动画排队会跟不上手；
  // 用户点箭头翻页才需要平滑
  try { listEl.scrollTo({ left: target, behavior: 'instant' }); }
  catch { listEl.scrollLeft = target; }
}

/* ─────────── 关页签 / 删页面（✕ 和右键菜单） ─────────── */

/**
 * 关掉一个页签：只从条上拿掉，**页面本身不删**。
 * 关的是当前页时先切到左边那个（没有就右边）—— 编辑器总得开着一页，
 * 所以条上永远至少留一个页签。
 */
function closeTab(id) {
  const r = rec();
  const i = r.order.indexOf(id);
  if (i < 0) return;
  if (id === project.currentId) {
    const rest = r.order.filter(x => x !== id);
    const next = rest[Math.max(0, i - 1)] || rest[0];
    if (!next) return;
    project.setCurrentPage(next);
  }
  const j = r.order.indexOf(id);      // 切页会触发 render，位置重新找一次
  if (j >= 0) r.order.splice(j, 1);
  persist();
  scheduleRender();
}

/** 「除此以外关闭所有」：只留这一个页签，并切到它 */
function closeOthers(id) {
  const r = rec();
  if (!r.order.includes(id)) return;
  if (id !== project.currentId) project.setCurrentPage(id);
  r.order = [id];
  persist();
  scheduleRender();
}

/** 「删除」：真删页面（复用页面列表那套确认框，删的是工程里的页） */
function deleteTabPage(id) {
  if (!deletePageWithConfirm(id)) return;
  const r = rec();
  const i = r.order.indexOf(id);
  if (i >= 0) r.order.splice(i, 1);
  persist();
  scheduleRender();
}

/* ─────────── 初始化 ─────────── */
export function initRecentViews() {
  listEl = document.getElementById('rvList');
  prevBtn = document.getElementById('rvPrev');
  nextBtn = document.getElementById('rvNext');
  if (!listEl || !prevBtn || !nextBtn) return;      // 老页面结构没有这块：静默跳过

  loadStore();

  listEl.addEventListener('click', (e) => {
    const tab = e.target.closest?.('.rv-tab');
    if (!tab) return;
    const id = tab.dataset.pageId;
    if (!id) return;
    if (e.target.closest?.('.rv-close')) { closeTab(id); return; }
    if (id !== project.currentId) project.setCurrentPage(id);
  });
  // 页签能用键盘选中（Tab 走到它上面，回车/空格切页）；✕ 本身是按钮，回车交给它
  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tab = e.target.closest?.('.rv-tab');
    if (!tab || e.target.closest?.('.rv-close')) return;
    e.preventDefault();
    const id = tab.dataset.pageId;
    if (id && id !== project.currentId) project.setCurrentPage(id);
  });

  const page = (dir) => {
    listEl.scrollLeft += dir * Math.max(80, listEl.clientWidth * 0.7);
    updateArrows();
  };
  prevBtn.addEventListener('click', () => page(-1));
  nextBtn.addEventListener('click', () => page(1));

  // 鼠标竖滚 → 页签条横滚（触摸板/滚轮都顺手）
  listEl.addEventListener('wheel', (e) => {
    if (listEl.scrollWidth - listEl.clientWidth <= 2) return;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!d) return;
    e.preventDefault();
    listEl.scrollLeft += d;
    updateArrows();
  }, { passive: false });

  listEl.addEventListener('scroll', updateArrows, { passive: true });
  window.addEventListener('resize', updateArrows);
  // 左右面板拖动/窗口最大化也会改顶栏宽度（不一定是 window resize）→ 跟着重算箭头
  try { new ResizeObserver(updateArrows).observe(listEl); } catch { /* 老浏览器没有就靠上面两条 */ }

  bus.on('page:current', scheduleRender);
  bus.on('project:changed', scheduleRender);
  bus.on('project:replaced', scheduleRender);

  // 页签右键：关闭 / 除此以外关闭所有 / 删除（页签没有可「设置」的东西，不摆设置项）
  registerContextMenu(
    t => !!t.closest?.('#rvList .rv-tab'),
    (t) => {
      const id = t.closest?.('.rv-tab')?.dataset.pageId;
      if (!id) return [];
      return [
        { label: '关闭', onClick: () => closeTab(id) },
        { label: '除此以外关闭所有', onClick: () => closeOthers(id) },
        { sep: true },
        { label: '删除', danger: true, onClick: () => deleteTabPage(id) },
      ];
    },
  );

  scheduleRender();
}
