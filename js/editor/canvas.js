/**
 * canvas.js — 编辑画布
 *
 * 职责：
 *   · 当前页控件渲染（全量重绘 + 变量变化局部刷新）
 *   · 交互：点选 / Shift 多选 / 框选 / 拖动 / 8 柄缩放 / 方向键微移
 *   · 接收工具箱拖放创建控件（含 ghost 预览）
 *   · 网格吸附（5px，Ctrl 临时关闭）、多选对齐
 *
 * 公共底（project.baseOf）：套了底的普通页面，画布上**底那一层也照画**（所见即所得），
 * 但它属于底、不属于这一页 —— 画布上点不动，双击跳到底页去改（见 bindPointer / bindBaseJump）。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { clamp, deepClone, statusNote } from '../core/utils.js';
import { renderWidgetDOM, refreshWidgetBody, registry, rutil } from '../widgets/registry.js';
import { layoutAlarmBars } from '../widgets/alarmBar.js';
import { tickClocksNow } from '../widgets/clock.js';
import { varStore } from '../runtime/varstore.js';

const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_SIZE = 8;
const DRAG_THRESHOLD = 2;

/* 画布缩放：Ctrl+滚轮 / Ctrl+± / 工具条按钮。用 CSS zoom 让布局盒一起放大，
   滚动条自动跟随；指针坐标一律除以 zoom 换算回设计坐标。 */
const ZOOM_KEY = 'hmi-canvas-zoom';
const ZOOM_MIN = 0.25, ZOOM_MAX = 4;
let zoom = 1;

let canvasEl, overlayEl, wrapEl;
let selectedIds = new Set();
let gridOn = true;
const GRID = 5;
let clipboard = [];

/* ─────────── 初始化 ─────────── */
export function initCanvas() {
  canvasEl = document.getElementById('canvas');
  overlayEl = document.getElementById('selOverlay');
  wrapEl = document.getElementById('canvasWrap');

  bus.on('project:changed', () => {
    // 只改了属性/绑定这类「局部变化」时，别把上千个控件整块拆了重建：
    // 1000 个控件整块重建要 20ms 以上（真机上还要加上重排重绘），只重画改动的那几个才跟得上手速。
    if (!patchDirty()) renderAll();
    refreshOverlay();
  });
  bus.on('page:current', () => renderAll());
  // 切语言（多语言工程的「预览语言」/运行态右键换语言）→ 画布上控件文字跟着换
  bus.on('i18n:lang', () => renderAll());
  bus.on('selection:changed', d => applySelection(d.ids || []));
  bus.on('vars:changed', ({ name }) => refreshBound(name));
  bus.on('mode:changed', ({ mode }) => {
    if (mode === 'edit') renderAll();   // 运行结束回来重绘
  });

  bindPointer();
  bindBaseJump();
  bindDnD();
  bindKeys();
  bindMousePos();
  bindZoom();
  renderAll();
  let savedZoom = 1;
  try { savedZoom = Number(localStorage.getItem(ZOOM_KEY)) || 1; } catch { /* 忽略 */ }
  setZoom(savedZoom);
}

/* ─────────── 缩放 ─────────── */
export function getZoom() { return zoom; }

function bindZoom() {
  // Ctrl/Cmd + 滚轮：以鼠标位置为锚点缩放（普通滚轮保持滚动）
  wrapEl.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }, { passive: false });
  document.getElementById('btnZoomIn')?.addEventListener('click', () => zoomStep(1.25));
  document.getElementById('btnZoomOut')?.addEventListener('click', () => zoomStep(0.8));
  document.getElementById('btnZoomReset')?.addEventListener('click', () => setZoom(1));
  document.getElementById('btnZoomFit')?.addEventListener('click', () => zoomFit());
}

/**
 * 设置缩放（0.25~4）。给了 cx/cy 就把该屏幕点下的画布位置钉住不动。
 * @param {number} next 目标倍率
 * @param {number} [cx] 锚点屏幕坐标 X
 * @param {number} [cy] 锚点屏幕坐标 Y
 */
export function setZoom(next, cx, cy) {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 100) / 100));
  // 先算出锚点对应的设计坐标（要在改 zoom 之前量）
  let px = null, py = null;
  if (cx != null && cy != null) {
    const r = canvasEl.getBoundingClientRect();
    px = (cx - r.left) / zoom;
    py = (cy - r.top) / zoom;
  }
  zoom = z;
  canvasEl.style.zoom = zoom === 1 ? '' : String(zoom);
  // 选中框手柄反向缩放，保证任何倍率下手柄都是 9px 好抓
  canvasEl.style.setProperty('--cv-zinv', String(1 / zoom));
  if (px != null) {
    const r2 = canvasEl.getBoundingClientRect();
    wrapEl.scrollLeft += (r2.left + px * zoom) - cx;
    wrapEl.scrollTop += (r2.top + py * zoom) - cy;
  }
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = Math.round(zoom * 100) + '%';
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* 忽略 */ }
}

/** 以画布区中心为锚点缩放（按钮/快捷键用） */
function zoomStep(factor) {
  const r = wrapEl.getBoundingClientRect();
  setZoom(zoom * factor, r.left + r.width / 2, r.top + r.height / 2);
}

/** 适应窗口：整页画布缩放到可见区域（留 32px 余量） */
export function zoomFit() {
  const { w, h } = canvasSize();
  const availW = Math.max(80, wrapEl.clientWidth - 32);
  const availH = Math.max(80, wrapEl.clientHeight - 32);
  setZoom(Math.min(availW / w, availH / h));
  wrapEl.scrollLeft = (wrapEl.scrollWidth - wrapEl.clientWidth) / 2;
  wrapEl.scrollTop = (wrapEl.scrollHeight - wrapEl.clientHeight) / 2;
}

/* ─────────── 渲染 ─────────── */
function canvasSize() {
  const page = project.currentPage();
  if (page?.type === 'popup') return { w: page.popupW || 420, h: page.popupH || 240 };
  return { w: project.data.meta.canvas.w, h: project.data.meta.canvas.h };
}

/**
 * 建一个画布上的控件元素。
 * @param {object} w 控件数据
 * @param {object|null} base 公共底（这个控件是底上的才有）→ 挂 wd-base 标记 + 记 baseId
 * @param {number} zOff 这一层的 z 基准（底的第 1 层是 0、往上逐层加；页面的那层最在上面，见 project.pageLayers）
 */
function makeCanvasEl(w, base, zOff) {
  const el = renderWidgetDOM(w, 'edit', varStore);
  el.style.zIndex = (w.z || 0) + (zOff || 0);
  if (base) {
    el.classList.add('wd-base');
    el.dataset.baseId = base.id;
    el.title = `公共底「${base.name}」上的控件 —— 这一层属于公共底，双击跳到底页去改（改一次，套用它的页面全变）`;
  }
  return el;
}

/** 当前画布上按顺序应该有的控件 id（各层公共底在前、页面自己的在后）—— patchDirty 靠它判断"能不能局部重画" */
function renderIds(page) {
  const { bases } = project.pageLayers(page);
  const ids = [];
  bases.forEach(l => l.base.widgets.forEach(w => ids.push(w.id)));
  page.widgets.forEach(w => ids.push(w.id));
  return ids;
}

/**
 * 局部重画：只重建被标脏的那几个控件，其余保持原样。
 *
 * 什么时候能走这条路：DOM 里现在挂着的控件，跟工程里的当前页**一一对应**
 * （同一页、同一批 id、同样顺序）。加/删/粘贴/换页/撤销都会让这个前提不成立，
 * 那时返回 false，交给 renderAll 整块重建。
 * 顺序不能变：控件 DOM 的先后就是叠放次序（z 序）。
 */
let lastPage = null;
let lastIds = [];

function patchDirty() {
  const page = project.currentPage();
  const dirty = project.takeDirty();
  const synced = project.takeSynced();
  if (!dirty.size && !synced.size) return false;   // 不认识的改动（换页、加删、改画布底色…）→ 老实整块重建
  if (!page || page !== lastPage) return false;
  const ids = renderIds(page);
  if (ids.length !== lastIds.length || ids.some((id, i) => id !== lastIds[i])) return false;

  const { bases, off } = project.pageLayers(page);   // 底上的控件重画时也要带同样的分层 z
  let hit = false;
  const els = wdEls();                         // 一次扫出 id → 元素，别按 id 反复 querySelector
  dirty.forEach(id => {
    if (synced.has(id)) return;                // 拖动过的：位置已经直接写在元素样式上了
    const w = project.getWidget(id);
    const el = els.get(id);
    if (!w || !el) return;                     // 已经被删掉的控件：交给下一次 renderAll 收尾
    // 这个控件属于哪一层？（底的第 i 层 → 该层的 z 基准；页面自己的 → 最上面那层）
    const layer = bases.find(l => l.base.widgets.includes(w));
    el.replaceWith(makeCanvasEl(w, layer?.base || null, layer ? layer.off : off));
    hit = true;
  });
  if (hit) applySelection([...selectedIds]);   // 换过 DOM 了：选中框/手柄要重新量
  if (hit) tickClocksNow();                    // 时钟控件：新 DOM 立刻显示"现在"，并按新格式定节奏
  layoutAlarmBars(canvasEl);
  return true;
}

export function renderAll() {
  const page = project.currentPage();
  if (!page) return;
  const { w, h } = canvasSize();
  canvasEl.style.width = w + 'px';
  canvasEl.style.height = h + 'px';
  // 注意：必须用 backgroundColor，不能用 background（shorthand 会覆盖 CSS 里的网格 background-image）
  canvasEl.style.backgroundColor = project.data.meta.canvas.bg || '#fff';

  // 重建控件层（overlay 保持最上，先移除再添加）
  canvasEl.querySelectorAll('.wd').forEach(el => el.remove());
  // 公共底按层从下往上先画（DOM 在前 = 先画 = 在下面），页面自己的控件盖在最上面
  const { bases, off } = project.pageLayers(page);
  bases.forEach(l => l.base.widgets.forEach(x => canvasEl.appendChild(makeCanvasEl(x, l.base, l.off))));
  page.widgets.forEach(w => canvasEl.appendChild(makeCanvasEl(w, null, off)));
  lastPage = page;
  lastIds = renderIds(page);
  project.takeDirty();          // 整块重建过了，脏标记一起清掉
  // 重建 DOM 会丢失选中态 class —— 必须恢复，否则改一次属性后面板就跳回画布属性
  applySelection([...selectedIds]);
  layoutAlarmBars(canvasEl);   // 报警条：量一下要不要滚（画布上也照样滚）
  tickClocksNow();             // 时钟：新画出来的元素立刻显示"现在"

  // 顶部工具条信息
  document.getElementById('pageTitle').textContent = page.name;
  const badge = document.getElementById('pageTypeBadge');
  badge.textContent = page.type === 'popup' ? '弹窗' : page.type === 'base' ? '公共底' : '页面';
  badge.className = 'badge ' + (page.type === 'popup' ? 'orange' : page.type === 'base' ? 'purple' : 'blue');

  // 弹窗页给画布加圆角提示
  canvasEl.style.borderRadius = page.type === 'popup' ? '10px' : '0';
  refreshOverlay();
}

/** 变量值变化 → 局部刷新编辑画布上绑定该变量的控件（含这一页套的公共底上的控件） */
function refreshBound(varName) {
  const page = project.currentPage();
  if (!page) return;
  project.renderWidgets(page).forEach(w => {
    // 和运行态一个口径：没绑状态、只有动作变量的按钮，编辑态预览也要跟着变
    if (rutil.stateVarOf(w) !== varName) return;
    const el = canvasEl.querySelector(`.wd[data-id="${w.id}"]`);
    if (el) refreshWidgetBody(el, w, 'edit', varStore);
  });
}

/* ─────────── 选中状态 ─────────── */
let primaryId = null;   // 多选时最后点选的"主控件"（对齐/等大小的基准，高亮区别）

/** 仅更新 UI（class/选中框/状态栏），不广播 —— 供 selection:changed 监听回调使用 */
function applySelection(ids) {
  selectedIds = new Set(ids);
  if (!selectedIds.size) primaryId = null;   // 清空选择时主控件标记要一起清掉
  const multi = selectedIds.size > 1;
  canvasEl.querySelectorAll('.wd').forEach(el => {
    const id = el.dataset.id;
    const sel = selectedIds.has(id);
    const w = project.getWidget(id);
    el.classList.toggle('selected', sel);
    // 主控件（最后选中）橙色实线，其余选中蓝色虚线，单选实线
    el.classList.toggle('primary', multi && sel && id === primaryId);
    el.classList.toggle('dashed', multi && sel && id !== primaryId);
    // 编组成员：没被选中时也给一点点虚线提示，点一下就知道它们是一组的
    el.classList.toggle('grouped', !!w?.group && !sel);
  });
  refreshOverlay();
  const n = selectedIds.size;
  const grouped = project.isWholeGroup([...selectedIds]);
  document.getElementById('stSel').textContent = n === 0 ? '未选中'
    : (grouped ? `已选中 1 组（${n} 个控件）` : `已选中 ${n} 个控件`);
  document.getElementById('alignGroup').style.display = n >= 2 ? 'flex' : 'none';
  const gb = document.getElementById('btnGroup');
  const ub = document.getElementById('btnUngroup');
  if (gb) gb.disabled = n < 2;
  if (ub) ub.disabled = ![...selectedIds].some(id => project.getWidget(id)?.group);
}

/** 用户主动改变选择：更新 UI + 广播（触发属性面板实时刷新）
 *  opts.raw = true 时不做"整组扩展"（Alt+点击 用来单独选组里的某一个）*/
export function select(ids, opts = {}) {
  const list = opts.raw ? [...ids] : project.expandGroups(ids);
  primaryId = list.length ? list[list.length - 1] : null;   // 最后选中者为主控件
  applySelection(list);
  bus.emit('selection:changed', { ids: [...list] });
}

export function getSelection() { return [...selectedIds]; }

/* ── 右键菜单/快捷键共用的操作（保证两条入口行为一致）── */
export function selectAll() {
  const all = project.currentWidgets().map(w => w.id);
  select(all);
  return all.length;
}

/* ── 编组：组合 / 取消组合（快捷键、右键菜单、对齐栏按钮都走这两个）── */
export function groupSelection() {
  const ids = [...selectedIds].filter(id => !project.getWidget(id)?.locked);
  if (ids.length < 2) return null;
  const gid = project.groupWidgets(ids);
  if (gid) applySelection([...selectedIds]);     // 状态栏/角标跟着更新
  return gid;
}
export function ungroupSelection() {
  const ids = [...selectedIds].filter(id => !project.getWidget(id)?.locked);
  if (!ids.length) return 0;
  const n = project.ungroupWidgets(ids);
  if (n) applySelection([...selectedIds]);
  return n;
}
/** 复制选中控件到剪贴板（存数据快照，可跨页粘贴） */
export function copySelection() {
  clipboard = [...selectedIds].map(id => project.getWidget(id)).filter(Boolean).map(w => deepClone(w));
  return clipboard.length;
}
/** 剪切：复制进剪贴板 + 删除（锁定的控件既不入剪贴板也不删，和 Delete / Ctrl+C 一个口径） */
export function cutSelection() {
  const ids = [...selectedIds].filter(id => !project.getWidget(id)?.locked);
  if (!ids.length) return 0;
  clipboard = ids.map(id => project.getWidget(id)).filter(Boolean).map(w => deepClone(w));
  project.deleteWidgets(ids);
  return ids.length;
}
export function canPaste() { return clipboard.length > 0; }
export function pasteClipboard() {
  if (!clipboard.length) return 0;
  return project.pasteWidgets(clipboard).length;
}
/** 删除选中（自动跳过锁定控件，与方向键微移口径一致） */
export function deleteSelection() {
  const del = [...selectedIds].filter(id => !project.getWidget(id)?.locked);
  if (!del.length) return 0;
  project.deleteWidgets(del);
  return del.length;
}

/**
 * 把控件的位置/尺寸直接写到 DOM 样式上（移动类操作专用）。
 *
 * 为什么要这样做：整块重建 1000 个控件的 DOM 要 15ms（实测，真机上还要加重排重绘），
 * 而纯移动只要改几个 style —— 拖动、方向键微移、对齐/均布都走这条路，
 * 改完标一下「DOM 已同步」，提交时就不用再重画。
 */
function wdEls() {
  const m = new Map();
  canvasEl.querySelectorAll('.wd').forEach(el => m.set(el.dataset.id, el));
  return m;
}
function syncGeom(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return;
  const els = wdEls();
  list.forEach(id => {
    const w = project.getWidget(id);
    const el = els.get(id);
    if (!w || !el) return;
    el.style.left = w.x + 'px';
    el.style.top = w.y + 'px';
    el.style.width = w.w + 'px';
    el.style.height = w.h + 'px';
  });
  project.markSynced(list);
}

function refreshOverlay() {
  overlayEl.innerHTML = '';
  overlayEl.style.pointerEvents = 'none';
  if (!selectedIds.size) return;
  const page = project.currentPage();
  if (!page) return;
  const ws = page.widgets.filter(w => selectedIds.has(w.id));
  const box = ws.reduce((b, w) => ({
    x1: Math.min(b.x1, w.x), y1: Math.min(b.y1, w.y),
    x2: Math.max(b.x2, w.x + w.w), y2: Math.max(b.y2, w.y + w.h),
  }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
  const boxEl = document.createElement('div');
  boxEl.className = 'sel-box';
  Object.assign(boxEl.style, {
    left: box.x1 - 1 + 'px', top: box.y1 - 1 + 'px',
    width: box.x2 - box.x1 + 2 + 'px', height: box.y2 - box.y1 + 2 + 'px',
  });
  // 单选且未锁定 → 显示 8 个缩放柄（手柄靠 CSS .sel-h 的 pointer-events:auto 接收事件；
  // selOverlay 容器保持 pointer-events:none，绝不遮挡控件本身的拖动）
  // 多选/整组 → 也在外框上给缩放柄（按组整体缩放，组内相对布局不变）
  const lockedAll = ws.every(x => x.locked);
  if (!lockedAll && (ws.length === 1 || ws.length > 1)) {
    HANDLES.forEach(h => {
      const el = document.createElement('div');
      el.className = 'sel-h sel-h-' + h;
      el.dataset.handle = h;
      boxEl.appendChild(el);
    });
  }
  // 整组选中：外框上标一个「组」角标，跟普通多选区分开
  if (ws.length > 1 && project.isWholeGroup(ws.map(x => x.id))) {
    const tag = document.createElement('div');
    tag.className = 'group-tag';
    tag.textContent = `组 ${ws.length}`;
    boxEl.appendChild(tag);
  }
  // 单选且锁定 → 锁标记
  if (ws.length === 1 && ws[0].locked) {
    const lock = document.createElement('div');
    lock.className = 'lock-badge';
    lock.textContent = '🔒';
    boxEl.appendChild(lock);
  }
  overlayEl.appendChild(boxEl);
}

/* ─────────── 指针交互（选择/拖动/缩放/框选） ─────────── */
/** 网格吸附：off=true（按住 Ctrl/Cmd）时按 1px 取整 */
function snap(v, off = false) { return (gridOn && !off) ? Math.round(v / GRID) * GRID : Math.round(v); }

function bindPointer() {
  canvasEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const handle = e.target.closest('.sel-h')?.dataset.handle;
    if (handle) return startResize(e, handle);
    const wdEl = e.target.closest('.wd');
    if (wdEl) {
      // 公共底那一层：在 **别的页面** 上点不动（一改就是所有套用它的页面一起变，
      // 太容易在普通页里误改）→ 提示一句，想改就双击跳到底页去改
      if (wdEl.classList.contains('wd-base')) return noteBaseLayer(wdEl);
      // Alt+点击 = 只选组里的这一个（想单独调组内某个控件时用）
      return startWidgetDrag(e, wdEl.dataset.id, { raw: e.altKey });
    }
    return startBoxSelect(e);
  });
  /* 画布**外面那一圈灰色区域**也能起框选（现场要求：从画布外往里框，一样要把画布里的控件框进去）。
     不绑这个的话，只能在画布内部按下才能拉框 —— 想框右上角那几个控件，得先精确点在画布里的空白处。
     画布内的按下走上一条（那里还要先判控件/缩放柄），所以这里把画布内的排除掉。 */
  wrapEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('#canvas')) return;
    if (onScrollbar(e)) return;          // 压在滚动条上的一下别当成框选（不然滚一下就把选择清了）
    return startBoxSelect(e);
  });
}

/** 这一下是不是按在画布容器自己的**滚动条**上（clientWidth/Height 不含滚动条，比一下就知道） */
function onScrollbar(e) {
  const r = wrapEl.getBoundingClientRect();
  return (e.clientX - r.left) >= wrapEl.clientWidth || (e.clientY - r.top) >= wrapEl.clientHeight;
}

/** 点到公共底那一层时的提示（不选中、不拖动） */
function noteBaseLayer(el) {
  const b = project.getPage(el.dataset.baseId);
  statusNote(b
    ? `这是公共底「${b.name}」上的控件 —— 双击跳到它去改（改一次，套用它的页面全变）`
    : '这是公共底上的控件 —— 双击跳到底页去改');
}

/** 双击底上的控件 = 跳到那个公共底去编辑（在普通页上也能一键到位） */
function bindBaseJump() {
  canvasEl.addEventListener('dblclick', e => {
    const el = e.target.closest('.wd.wd-base');
    if (!el?.dataset.baseId) return;
    const b = project.getPage(el.dataset.baseId);
    if (!b) return;
    project.setCurrentPage(b.id);
    statusNote(`已跳到公共底「${b.name}」—— 这里改一次，套用它的页面全都跟着变`);
  });
}

function startWidgetDrag(e, id, opts = {}) {
  e.preventDefault();
  const page = project.currentPage();
  const target = project.getWidget(id);

  // Shift+点击 = 切换选择（已选中的再点一次取消选中），只选择、不拖动
  if (e.shiftKey && !opts.raw) {
    const next = selectedIds.has(id)
      ? [...selectedIds].filter(x => x !== id)
      : [...selectedIds, id];
    select(next);
    return;
  }

  if (!selectedIds.has(id) || (opts.raw && selectedIds.size !== 1)) select([id], opts);
  // 锁定控件：可选中（查看属性），但不能拖动
  if (target?.locked) return;

  const ids = [...selectedIds];
  const startX = e.clientX, startY = e.clientY;
  const orig = page.widgets.filter(w => ids.includes(w.id) && !w.locked)
    .map(w => ({ id: w.id, x: w.x, y: w.y }));
  let moved = false;

  const move = ev => {
    // 位移按缩放换算回设计坐标（画布 zoom ≠ 1 时指针走的屏幕像素更多）
    const dx = (ev.clientX - startX) / zoom, dy = (ev.clientY - startY) / zoom;
    if (!moved && Math.hypot(dx, dy) * zoom < DRAG_THRESHOLD) return;
    moved = true;
    document.body.classList.add('dragging');
    const off = ev.ctrlKey || ev.metaKey;   // 按住 Ctrl 临时关吸附（用事件自带修饰键，比全局标志可靠）
    orig.forEach(o => {
      const w = project.getWidget(o.id);
      const nx = snap(o.x + dx, off), ny = snap(o.y + dy, off);
      w.x = nx; w.y = ny;
      const el = canvasEl.querySelector(`.wd[data-id="${o.id}"]`);
      if (el) { el.style.left = nx + 'px'; el.style.top = ny + 'px'; }
    });
    refreshOverlay();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('dragging');
    if (moved) {
      project.markSynced(orig.map(o => o.id));   // 位置是直接改样式的，DOM 已经是最新
      project.commit('移动控件', { merge: true });
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startResize(e, handle) {
  e.preventDefault();
  const sel = [...selectedIds];
  const w = project.getWidget(primaryId) || project.getWidget(sel[0]);
  if (!w || w.locked) return;   // 锁定控件不可缩放

  // 多选/整组缩放：按外框比例缩放组内每个控件（保持相对布局）
  const groupMode = sel.length > 1;
  if (groupMode) {
    const ws = project.currentWidgets().filter(x => sel.includes(x.id));
    if (ws.some(x => x.locked)) return;
    const bx1 = Math.min(...ws.map(x => x.x)), by1 = Math.min(...ws.map(x => x.y));
    const bx2 = Math.max(...ws.map(x => x.x + x.w)), by2 = Math.max(...ws.map(x => x.y + x.h));
    const b0 = { x: bx1, y: by1, w: bx2 - bx1, h: by2 - by1 };
    const orig = ws.map(x => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h }));
    const sx0 = e.clientX, sy0 = e.clientY;

    const moveG = ev => {
      document.body.classList.add('resizing');
      const dx = (ev.clientX - sx0) / zoom, dy = (ev.clientY - sy0) / zoom;
      const off = ev.ctrlKey || ev.metaKey;
      let nx = b0.x, ny = b0.y, nw = b0.w, nh = b0.h;
      if (handle.includes('e')) nw = b0.w + dx;
      if (handle.includes('s')) nh = b0.h + dy;
      if (handle.includes('w')) { nx = b0.x + dx; nw = b0.w - dx; }
      if (handle.includes('n')) { ny = b0.y + dy; nh = b0.h - dy; }
      if (nw < MIN_SIZE * 2) { if (handle.includes('w')) nx = b0.x + b0.w - MIN_SIZE * 2; nw = MIN_SIZE * 2; }
      if (nh < MIN_SIZE * 2) { if (handle.includes('n')) ny = b0.y + b0.h - MIN_SIZE * 2; nh = MIN_SIZE * 2; }
      nx = snap(nx, off); ny = snap(ny, off);
      nw = Math.max(MIN_SIZE * 2, Math.round(nw)); nh = Math.max(MIN_SIZE * 2, Math.round(nh));
      const kx = nw / b0.w, ky = nh / b0.h;
      orig.forEach(o => {
        const it = project.getWidget(o.id);
        if (!it) return;
        it.x = Math.round(nx + (o.x - b0.x) * kx);
        it.y = Math.round(ny + (o.y - b0.y) * ky);
        it.w = Math.max(MIN_SIZE, Math.round(o.w * kx));
        it.h = Math.max(MIN_SIZE, Math.round(o.h * ky));
        const el = canvasEl.querySelector(`.wd[data-id="${o.id}"]`);
        if (el) {
          el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
          el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
          // 内容跟着重排（表格/文本等按尺寸渲染的控件）
          refreshWidgetBody(el, it, 'edit', varStore);
        }
      });
      refreshOverlay();
    };
    const upG = () => {
      window.removeEventListener('pointermove', moveG);
      window.removeEventListener('pointerup', upG);
      document.body.classList.remove('resizing');
      // 宽高变了：内容要按新尺寸重排 → 标脏，让画布只重画这几个控件
      project.markDirty(orig.map(o => o.id));
      project.commit('缩放组合', { merge: true });
    };
    window.addEventListener('pointermove', moveG);
    window.addEventListener('pointerup', upG);
    return;
  }

  const x0 = w.x, y0 = w.y, w0 = w.w, h0 = w.h;
  const sx = e.clientX, sy = e.clientY;

  const move = ev => {
    document.body.classList.add('resizing');
    const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
    const off = ev.ctrlKey || ev.metaKey;
    let nx = x0, ny = y0, nw = w0, nh = h0;
    if (handle.includes('e')) nw = w0 + dx;
    if (handle.includes('s')) nh = h0 + dy;
    if (handle.includes('w')) { nx = x0 + dx; nw = w0 - dx; }
    if (handle.includes('n')) { ny = y0 + dy; nh = h0 - dy; }
    // 收敛到最小尺寸时，必须把左/上边界贴回去（对边钉住不动）；
    // 否则西/北手柄拖过头会让控件瞬移到原右/下边界之外
    if (nw < MIN_SIZE) { if (handle.includes('w')) nx = x0 + w0 - MIN_SIZE; nw = MIN_SIZE; }
    if (nh < MIN_SIZE) { if (handle.includes('n')) ny = y0 + h0 - MIN_SIZE; nh = MIN_SIZE; }
    w.x = snap(nx, off); w.y = snap(ny, off);
    w.w = Math.max(MIN_SIZE, Math.round(nw)); w.h = Math.max(MIN_SIZE, Math.round(nh));
    const el = canvasEl.querySelector(`.wd[data-id="${w.id}"]`);
    if (el) {
      el.style.left = w.x + 'px'; el.style.top = w.y + 'px';
      el.style.width = w.w + 'px'; el.style.height = w.h + 'px';
    }
    refreshOverlay();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('resizing');
    // 宽高变了：内容要按新尺寸重排 → 标脏，让画布只重画这一个控件（不是整块重建）
    project.markDirty(w.id);
    project.commit('调整大小', { merge: true });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startBoxSelect(e) {
  e.preventDefault();
  const rect = canvasEl.getBoundingClientRect();
  const toLocal = (cx, cy) => ({ x: (cx - rect.left) / zoom, y: (cy - rect.top) / zoom });
  const start = toLocal(e.clientX, e.clientY);
  const sx = start.x, sy = start.y;
  const boxEl = document.createElement('div');
  boxEl.className = 'box-select';
  canvasEl.appendChild(boxEl);

  const move = ev => {
    const p = toLocal(ev.clientX, ev.clientY);
    Object.assign(boxEl.style, {
      left: Math.min(sx, p.x) + 'px', top: Math.min(sy, p.y) + 'px',
      width: Math.abs(p.x - sx) + 'px', height: Math.abs(p.y - sy) + 'px',
    });
  };
  const up = ev => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    boxEl.remove();
    const p = toLocal(ev.clientX, ev.clientY);
    if (Math.abs(p.x - sx) * zoom < DRAG_THRESHOLD && Math.abs(p.y - sy) * zoom < DRAG_THRESHOLD) {
      select([]);   // 空白单击 → 取消选择
      return;
    }
    const sel = { x1: Math.min(sx, p.x), y1: Math.min(sy, p.y), x2: Math.max(sx, p.x), y2: Math.max(sy, p.y) };
    const hits = project.currentWidgets().filter(w =>
      w.x < sel.x2 && w.x + w.w > sel.x1 && w.y < sel.y2 && w.y + w.h > sel.y1).map(w => w.id);
    select(hits);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ─────────── 拖放创建（工具箱 → 画布） ─────────── */
function bindDnD() {
  let ghostEl = null, ghostType = null;

  function showGhost(type, clientX, clientY) {
    if (!ghostEl) {
      ghostEl = document.createElement('div');
      ghostEl.className = 'drop-ghost';
      canvasEl.appendChild(ghostEl);
    }
    const def = registry.get(type);
    const rect = canvasEl.getBoundingClientRect();
    ghostType = type;
    ghostEl.style.display = 'block';
    ghostEl.style.width = def.defaults.w + 'px';
    ghostEl.style.height = def.defaults.h + 'px';
    ghostEl.style.left = (clientX - rect.left) / zoom - def.defaults.w / 2 + 'px';
    ghostEl.style.top = (clientY - rect.top) / zoom - def.defaults.h / 2 + 'px';
    ghostEl.textContent = def.title;
  }
  function hideGhost() { if (ghostEl) ghostEl.style.display = 'none'; }

  canvasEl.addEventListener('dragover', e => {
    e.preventDefault();
    // 只对「从控件库拖出来的控件」显示 ghost；拖文件进来时不再显示一个写着「矩形」的假预览
    if (!pendingType || !registry.get(pendingType)) return hideGhost();
    showGhost(pendingType, e.clientX, e.clientY);
  });
  canvasEl.addEventListener('dragleave', hideGhost);
  canvasEl.addEventListener('drop', e => {
    e.preventDefault();
    hideGhost();
    const type = e.dataTransfer.getData('text/widget-type') || pendingType;
    if (!type || !registry.get(type)) return;
    const rect = canvasEl.getBoundingClientRect();
    const def = registry.get(type);
    const off = e.ctrlKey || e.metaKey;
    const size = canvasSize();
    const x = clamp((e.clientX - rect.left) / zoom - def.defaults.w / 2, 0, size.w - def.defaults.w);
    const y = clamp((e.clientY - rect.top) / zoom - def.defaults.h / 2, 0, size.h - def.defaults.h);
    const w = project.addWidget(type, snap(x, off), snap(y, off));
    select([w.id]);
    pendingType = null;
  });
}

// toolbox.js 会调用：dragstart 时记录类型（dragover 里读不到 data 的兜底）
export let pendingType = null;
export function setPendingType(t) { pendingType = t; }

/* ─────────── 键盘 ─────────── */
function bindKeys() {
  document.addEventListener('keydown', e => {
    if (document.getElementById('runtimeRoot').classList.contains('hidden') === false) return; // 运行模式不响应
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    // 全选 / 粘贴不依赖已有选中（跨页粘贴时新页面本来就是空选择）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (canPaste()) { e.preventDefault(); pasteClipboard(); }
      return;
    }
    const ids = [...selectedIds];
    if (!ids.length) return;

    // Ctrl+G 组合 / Ctrl+Shift+G 取消组合（和大多数编辑器一致）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      if (e.shiftKey) ungroupSelection(); else groupSelection();
      return;
    }

    // Delete：跳过锁定控件（与方向键微移/对齐的口径一致，锁定后不会被误删）
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (deleteSelection()) e.preventDefault();
      return;
    }
    // 剪切：复制 + 删除（Ctrl+X，和 Ctrl+C / Delete 同一套口径）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      cutSelection();
      return;
    }
    // 剪贴板存控件数据快照（不是 id）→ 换页面粘贴也有效
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      copySelection();
      return;
    }
    // 方向键微移
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault();
    const idSet = new Set(ids);
    const moved = [];
    project.currentWidgets().forEach(w => {
      if (!idSet.has(w.id) || w.locked) return;   // 锁定控件不微移
      w.x += dx; w.y += dy;
      moved.push(w.id);
    });
    syncGeom(moved);            // 位置直接改样式：上千个控件时别整块重建
    // merge：连按方向键只占 1 步撤销（否则 60 步历史瞬间被微移冲掉）
    project.commit('微移控件', { merge: true });
  });
}

/* ─────────── 状态栏坐标显示 ─────────── */
function bindMousePos() {
  canvasEl.addEventListener('pointermove', e => {
    const rect = canvasEl.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) / zoom);
    const y = Math.round((e.clientY - rect.top) / zoom);
    document.getElementById('stPos').textContent = `x: ${x}, y: ${y}`;
  });
  canvasEl.addEventListener('pointerleave', () => {
    document.getElementById('stPos').textContent = 'x: -, y: -';
  });
}

/* ─────────── 多选对齐 / 均布（工具栏调用） ───────────
   ⚠ 关键：编组过的控件要当成「一个整体」参与对齐 ——
   对齐时整组一起挪，组内相对位置一动不动（不能像普通多选那样把每个成员各自对齐） */
function selectionUnits() {
  const ws = project.currentWidgets().filter(w => selectedIds.has(w.id));
  const units = [], byGroup = new Map();
  ws.forEach(w => {
    if (!w.group) { units.push({ ids: [w.id], members: [w] }); return; }
    let u = byGroup.get(w.group);
    if (!u) { u = { ids: [], group: w.group, members: [] }; byGroup.set(w.group, u); units.push(u); }
    u.ids.push(w.id); u.members.push(w);
  });
  units.forEach(u => {
    u.locked = u.members.length > 0 && u.members.every(m => m.locked);
    u.x = Math.min(...u.members.map(m => m.x));
    u.y = Math.min(...u.members.map(m => m.y));
    u.w = Math.max(...u.members.map(m => m.x + m.w)) - u.x;
    u.h = Math.max(...u.members.map(m => m.y + m.h)) - u.y;
  });
  return units;
}
/** 把一个「单位」搬到 (x,y)：整组一起平移，组内相对布局不变 */
function moveUnitTo(u, x, y) {
  const dx = Math.round(x - u.x), dy = Math.round(y - u.y);
  if (!dx && !dy) return false;
  u.members.forEach(m => { if (!m.locked) { m.x += dx; m.y += dy; } });
  return true;
}
/** 把一个「单位」缩放到目标宽高：整组按比例缩放，组内相对布局不变 */
function resizeUnitTo(u, w, h) {
  const kx = u.w > 0 ? Math.max(0.05, w / u.w) : 1;
  const ky = u.h > 0 ? Math.max(0.05, h / u.h) : 1;
  u.members.forEach(m => {
    if (m.locked) return;
    m.x = Math.round(u.x + (m.x - u.x) * kx);
    m.y = Math.round(u.y + (m.y - u.y) * ky);
    m.w = Math.max(MIN_SIZE, Math.round(m.w * kx));
    m.h = Math.max(MIN_SIZE, Math.round(m.h * ky));
  });
}

export function alignWidgets(type) {
  const units = selectionUnits();
  if (units.length < 2) return;
  // 基准 = 主控件所在的那个单位（组就按组外框算）
  const primaryUnit = units.find(u => u.ids.includes(primaryId)) || units[units.length - 1];

  // 水平/垂直均布：首尾中心不动，中间按等间距排列（≥3 个单位）
  if (type === 'hdist' || type === 'vdist') {
    if (units.length < 3) return;
    const cx = (u) => (type === 'hdist' ? u.x + u.w / 2 : u.y + u.h / 2);
    const sorted = [...units].sort((a, b) => cx(a) - cx(b));
    const first = cx(sorted[0]);
    const last = cx(sorted[sorted.length - 1]);
    sorted.forEach((u, i) => {
      if (u.locked || u === sorted[0] || u === sorted[sorted.length - 1]) return;
      const c = first + (last - first) * i / (sorted.length - 1);
      if (type === 'hdist') moveUnitTo(u, c - u.w / 2, u.y);
      else moveUnitTo(u, u.x, c - u.h / 2);
    });
    // 位置直接改样式，再提交 —— 顺序不能反：提交会广播 project:changed，画布据此决定重画范围
    syncGeom(units.flatMap(u => u.ids));
    project.commit(type === 'hdist' ? '水平均布' : '垂直均布');
    return;
  }

  // 对齐 / 居中：以主控件（高亮）所在单位为基准，整单位平移
  units.forEach(u => {
    if (u.locked) return;
    if (type === 'left') moveUnitTo(u, primaryUnit.x, u.y);
    else if (type === 'right') moveUnitTo(u, primaryUnit.x + primaryUnit.w - u.w, u.y);
    else if (type === 'top') moveUnitTo(u, u.x, primaryUnit.y);
    else if (type === 'bottom') moveUnitTo(u, u.x, primaryUnit.y + primaryUnit.h - u.h);
    else if (type === 'hcenter') moveUnitTo(u, Math.round(primaryUnit.x + primaryUnit.w / 2 - u.w / 2), u.y);
    else if (type === 'vcenter') moveUnitTo(u, u.x, Math.round(primaryUnit.y + primaryUnit.h / 2 - u.h / 2));
  });
  syncGeom(units.flatMap(u => u.ids));
  project.commit('对齐');
}

/** 等大小：以主控件（高亮）所在单位为基准
 *  组 → 按比例缩放到目标尺寸（组内布局不变形）；单个控件 → 直接改宽高 */
export function makeSameSize(type) {
  const units = selectionUnits();
  if (units.length < 2) return;
  const primaryUnit = units.find(u => u.ids.includes(primaryId));
  if (!primaryUnit) return;
  const tw = type === 'height' ? null : primaryUnit.w;
  const th = type === 'width' ? null : primaryUnit.h;
  units.forEach(u => {
    if (u.locked || u === primaryUnit) return;
    if (u.ids.length === 1) {
      const m = u.members[0];
      if (tw !== null) m.w = tw;
      if (th !== null) m.h = th;
    } else {
      resizeUnitTo(u, tw === null ? u.w : tw, th === null ? u.h : th);
    }
  });
  // 改了宽高：内容要按新尺寸重排，所以标脏让画布只重画这几个（不是整块重建）
  project.markDirty(units.flatMap(u => u.ids));
  project.commit(type === 'both' ? '等大小' : type === 'width' ? '等宽' : '等高');
}

export function getGrid() { return gridOn; }

export function setGrid(on) {
  gridOn = !!on;
  canvasEl.classList.toggle('nogrid', !gridOn);
  return gridOn;
}

export function toggleGrid() { return setGrid(!gridOn); }

/** 批量锁定/解锁选中控件（工具栏「锁定」按钮） */
export function toggleLock() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const allLocked = ids.every(id => project.getWidget(id)?.locked);
  const idSet = new Set(ids);
  project.currentWidgets().forEach(w => {
    if (idSet.has(w.id)) w.locked = !allLocked;
  });
  project.markDirty(ids);
  project.commit(allLocked ? '解锁控件' : '锁定控件');
  return !allLocked;   // 返回新锁定状态
}

/** 定位到某个控件：选中 + 滚动居中 + 闪烁高亮（供控件清单跳转用）
 *  opts.raw = true 时不做整组扩展（清单里 Alt+点击 = 只要组里的这一个） */
export function focusWidget(id, opts = {}) {
  const el = canvasEl.querySelector(`.wd[data-id="${id}"]`);
  if (!el) return;
  select([id], opts);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;            // 强制重排，重启闪烁动画
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}
