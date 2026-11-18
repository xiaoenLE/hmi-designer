/**
 * dock.js — 面板停靠系统
 *
 * 五个面板（控件 / 页面 / 变量 / 清单 / 属性）可以自由摆放：
 *   · 拖到左 / 右 / 下边缘        → 停靠到该区域，同一区域多个面板自动合并成标签页
 *   · 拖到画布中间（或点标签栏的 ⧉）→ 变成浮动窗口：可拖动、可缩放、可一键停靠回去
 *   · 双击浮动窗口标题              → 停靠回原来的区域
 *
 * 面板元素是「移动」而不是重建 —— 各面板内部已有的 DOM 与事件监听原样保留，
 * 所以页面/变量清单拖出来之后照样能点、能编辑。
 *
 * 布局存**工程里**（project.data.layout.dock）：跟着「保存 / 另存为 / 存到服务器」走，
 * 换台机器、换个浏览器（客户机/PyWebView 每次都是新 profile）、发给别人打开，
 * 面板还是你摆的那个样子。老版本存在 localStorage('hmi-dock') 里，
 * 第一次打开时自动搬到工程里（见 load()）。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';

const LS_KEY = 'hmi-dock';      // 老位置：只用来"搬家"，搬完就不再看它

const PANELS = {
  toolbox:    { title: '控件' },
  pages:      { title: '页面' },
  vars:       { title: '变量' },
  alarms:     { title: '报警' },
  scripts:    { title: '脚本' },
  list:       { title: '清单' },
  properties: { title: '属性' },
};
/** 每个面板的「老家」：双击标题 / 点 ⇤ 就回去 */
const HOME = { toolbox: 'left', pages: 'left', vars: 'left', alarms: 'left', scripts: 'left', list: 'left', properties: 'right' };
const DOCKS = ['left', 'right', 'bottom'];
const DOCK_EL = { left: 'leftPanel', right: 'rightPanel', bottom: 'bottomPanel' };
const DRAG_THRESHOLD = 5;

let layout = null;
let drag = null;      // 拖拽中的临时状态
/** 面板元素引用：只用 getElementById 拿一次 —— render 里会用 appendChild 搬运它们，
 *  一旦被移到别处（或临时脱离文档）再查 id 就查不到了 */
const ELS = new Map();

const panelEl = id => ELS.get(id) || null;
const dockEl = d => document.getElementById(DOCK_EL[d]);

function defaultLayout() {
  return {
    left: ['toolbox', 'pages', 'vars', 'alarms', 'scripts', 'list'],
    right: ['properties'],
    bottom: [],
    float: [],                                  // [{ id, x, y, w, h }]
    active: { left: 'toolbox', right: 'properties', bottom: null },
    // 分屏：某个停靠区**同时显示 2~N 个面板**（左 | 中 | 右…），每两栏之间一条可拖的分隔条。
    // null = 没分屏（老样子，一个面板 + 一排标签页）。
    // { extra: [第2栏, 第3栏, …], grow: [各栏占比，和 = 1] }（第 1 栏永远是 active[dock]）
    split: { left: null, right: null, bottom: null },
  };
}

/** 补齐/清洗外部存进来的布局：每个面板有且仅有一个位置，缺的补回老家 */
function normalize(raw) {
  const out = defaultLayout();
  if (!raw || typeof raw !== 'object') return out;
  DOCKS.forEach(d => { out[d] = []; });
  out.float = [];
  const seen = new Set();
  DOCKS.forEach(d => {
    (Array.isArray(raw[d]) ? raw[d] : []).forEach(id => {
      if (PANELS[id] && !seen.has(id)) { out[d].push(id); seen.add(id); }
    });
  });
  (Array.isArray(raw.float) ? raw.float : []).forEach(f => {
    if (!f || !PANELS[f.id] || seen.has(f.id)) return;
    out.float.push({
      id: f.id,
      x: Number.isFinite(f.x) ? f.x : 320,
      y: Number.isFinite(f.y) ? f.y : 160,
      w: Number.isFinite(f.w) ? f.w : 300,
      h: Number.isFinite(f.h) ? f.h : 380,
    });
    seen.add(f.id);
  });
  Object.keys(PANELS).forEach(id => { if (!seen.has(id)) out[HOME[id]].push(id); });   // 丢了的补回老家
  out.active = { left: null, right: null, bottom: null, ...(raw.active || {}) };
  DOCKS.forEach(d => { if (!out[d].includes(out.active[d])) out.active[d] = out[d][0] || null; });
  // 分屏：第 2..N 栏都要在同一个停靠区、且跟第 1 栏（active）互不重复。
  // 兼容老形状 { second, third, ratio, ratio2 } → 新形状 { extra, grow }。
  const rawSplit = raw.split || {};
  DOCKS.forEach(d => {
    const s = rawSplit[d];
    if (!s) return;
    const cand = Array.isArray(s.extra) ? s.extra : [s.second, s.third];
    const extra = [];
    const seen = new Set([out.active[d]]);
    cand.filter(Boolean).forEach(id => {
      if (!PANELS[id] || !out[d].includes(id) || seen.has(id)) return;
      seen.add(id); extra.push(id);
    });
    if (!extra.length) return;
    const n = extra.length + 1;
    let grow = Array.isArray(s.grow) && s.grow.length === n ? s.grow.slice() : null;
    if (!grow) {
      // 老形状：ratio / ratio2 是前两栏的占比
      const r1 = Number(s.ratio);
      if (Number.isFinite(r1)) {
        grow = [Math.min(0.85, Math.max(0.15, r1))];
        if (n >= 3) {
          const r2 = Number(s.ratio2);
          grow.push(Number.isFinite(r2) ? Math.max(0.12, r2) : 0.25);
        }
        while (grow.length < n) grow.push(0.25);
        grow = grow.slice(0, n);
      } else {
        grow = new Array(n).fill(1 / n);
      }
    }
    out.split[d] = { extra, grow: normalizeGrows(grow) };
  });
  return out;
}

/** 从工程里那份布局读出来（工程里没有就试老位置 localStorage，最后才用默认布局） */
function load() {
  const stored = project.data?.layout?.dock;
  if (stored) return normalize(stored);
  // 这份工程里**没有布局**（老工程 / 新建的 / 撤销回到了老快照）：保留现在摆好的样子，
  // 别突然跳回默认（用户会觉得"我的面板自己跑了"）。顺手写进这份工程，之后跟着它存
  if (layout) { save(); return layout; }
  let old = null;
  try { old = JSON.parse(localStorage.getItem(LS_KEY)); } catch { old = null; }
  if (!old) return defaultLayout();
  // 老工程/老用户：布局还在 localStorage 里 → 搬进工程，之后就跟着工程一起存/走。
  // 搬完把老位置删掉：留着的话，将来打开一份"没有布局"的工程会把这份旧布局又套上去
  const out = normalize(old);
  layout = out;
  save();
  try { localStorage.removeItem(LS_KEY); } catch { /* 忽略 */ }
  return out;
}
/** 写回工程（project.touch 会触发自动保存；「保存/存到服务器」写的就是这份数据）
 *  ⚠ 用 touch 不用 commit：摆面板不该占用撤销栈（Ctrl+Z 是撤销画面上的操作）*/
function save() {
  if (!layout) return;
  const data = project.data;
  if (!data) return;
  if (!data.layout || typeof data.layout !== 'object') data.layout = {};
  data.layout.dock = JSON.parse(JSON.stringify(layout));
  project.touch();
}

const floatOf = id => layout.float.find(f => f.id === id);
const dockOf = id => DOCKS.find(d => layout[d].includes(id));

/* ─────────── 渲染 ─────────── */
function render() {
  DOCKS.forEach(dock => {
    const box = dockEl(dock);
    if (!box) return;
    // 只处理真实存在的面板元素：HTML 与 JS 版本不一致时（比如浏览器缓存了旧页面）
    // 缺面板也不该让整个界面启动失败
    const ids = layout[dock].filter(id => ELS.has(id));
    // 防御：active 指向的面板必须确实在这个停靠区里，否则该区会一个面板都不显示
    if (!ids.includes(layout.active[dock])) layout.active[dock] = ids[0] || null;
    const tabs = box.querySelector('.dock-tabs');
    const panes = box.querySelector('.dock-panes');
    tabs.innerHTML = '';
    // 上一轮塞进各栏标题行里的标签先清掉（上下分屏才会往那儿放），下面按现在的位置重放
    box.querySelectorAll('.panel-head .pane-tabs').forEach(st => { st.innerHTML = ''; });
    const split = layout.split[dock];
    const inPane = id => !!split
      && (id === layout.active[dock] || (split.extra || []).includes(id));
    // 只有**左右分屏**（底部区，栏是横着并排的）才用「顶上一排 = 栏标题行」；
    // 上下分屏（左/右区，栏是竖着叠的）栏名放回每栏自己顶上那一行。
    const headRow = !!split && dock === 'bottom';
    // 注意：不要用 panes.innerHTML = '' 清空 —— 那会把面板元素脱离文档，
    // 之后再 getElementById 就找不到了（面板引用统一走 ELS）
    ids.forEach(id => {
      const tab = document.createElement('button');
      tab.className = 'lp-tab' + (layout.active[dock] === id ? ' active' : '');
      tab.dataset.panel = id;
      tab.dataset.tab = id;                       // 兼容旧选择器 .lp-tab[data-tab=...]
      tab.textContent = PANELS[id].title;
      tab.title = inPane(id)
        ? '这个面板正显示在它自己的栏里'
        : '点击切换 · 按住拖动可移动 / 拖到面板两侧变分屏 / 拖到画布中间变浮动窗口';
      const head = (inPane(id) && !headRow) ? panelEl(id)?.querySelector('.panel-head') : null;
      if (head) {
        // 上下分屏：栏名进它自己那一栏的标题行
        let strip = head.querySelector('.pane-tabs');
        if (!strip) {
          strip = document.createElement('span');
          strip.className = 'pane-tabs';
          head.insertBefore(strip, head.firstChild);
        }
        strip.appendChild(tab);
      } else {
        // 其余（含左右分屏）：进「顶上一排」；renderSplit 会把分屏里那几个包成等宽格子
        tabs.appendChild(tab);
      }

      const p = panelEl(id);
      p.classList.remove('floating');
      // 清掉浮动时留下的内联定位/尺寸，否则停靠回来还保持浮窗那点高度，不撑满停靠区
      p.style.left = p.style.top = p.style.width = p.style.height = '';
      p.style.position = '';
      p.classList.add('active');
      panes.appendChild(p);
    });
    if (ids.length) {
      // 分屏按钮放前面（margin-left:auto 把它推到右边），浮动按钮紧跟其后
      // ⚠ 上下分屏（左/右区）时顶上一排整条会被省掉（空着浪费高度），
      //   ⇹/⧉ 就挂到**最后一栏的标题行**里（那里一定有位置、也看得见）
      const lastId = splitIds(dock).slice(-1)[0];
      const btnHost = (!headRow && split && lastId)
        ? (panelEl(lastId)?.querySelector('.panel-head .pane-tabs') || tabs)
        : tabs;
      if (ids.length >= 2) {
        const cur = layout.split[dock];
        const sp = document.createElement('button');
        sp.className = 'dock-splitbtn' + (cur ? ' on' : '');
        sp.dataset.splitbtn = dock;
        sp.textContent = cur ? '⧉' : '⇹';
        sp.title = !cur
          ? '分屏：把这一区的面板都摊开成栏（栏数不写死，放得下几栏就摊几栏；也可以直接把标签拖到面板上）'
          : `合起来（现在是 ${splitIds(dock).length} 栏；也可以双击分隔条一栏一栏撤）`;
        btnHost.appendChild(sp);
      }
      const f = document.createElement('button');
      f.className = 'dock-float';
      f.dataset.float = dock;
      f.textContent = '⧉';
      f.title = '把当前面板拖出为浮动窗口（也可以直接拖标签）';
      btnHost.appendChild(f);
    }
    // 只有一个面板时不需要「激活」概念，但保持 active class 便于测试/样式
    panes.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', layout.active[dock] === p.dataset.panel));
    renderSplit(dock, panes, ids);
    const empty = ids.length === 0;
    box.classList.toggle('dock-empty', empty);
  });

  // 浮动面板
  layout.float.filter(f => ELS.has(f.id)).forEach(f => {
    const p = panelEl(f.id);
    p.classList.add('floating');
    p.classList.remove('active');
    document.body.appendChild(p);            // 移出停靠区 → 独立小窗
    p.style.left = f.x + 'px';
    p.style.top = f.y + 'px';
    p.style.width = f.w + 'px';
    p.style.height = f.h + 'px';
  });

  // 底部区域 + 分隔条：空了就藏起来
  const bottomEmpty = layout.bottom.length === 0;
  const br = document.getElementById('bottomResizer');
  if (br) br.classList.toggle('hidden', bottomEmpty);
  syncResizers();
}

/* ─────────── 分屏（两栏 / 三栏 / 四栏…对着看，还能合起来）───────────
   模型：layout.split[dock] = { extra: [id2, id3, …], grow: [g1, g2, …, gN] }。
   第 1 栏永远是 layout.active[dock]，extra 是第 2..N 栏 —— **栏数不写死**（下面栏放 4 栏、
   5 栏都行，只要每栏还放得下 SPLIT_MIN）；grow 是各栏占比（和 = 1）。
   每两栏之间一条分隔条（可拖、双击撤掉它右边那一栏）。侧边栏窄 → 上下分；底部区宽 → 左右分。
   老布局里的 { second, third, ratio, ratio2 } 在 normalize() 里转成这个形状。 */
const SPLIT_MIN = 120;      // 每个窗格至少这么宽/高，再窄里面的表格就没法看了
const DIVIDER_PX = 8;       // 分隔条自身厚度（跟 CSS 里 .dock-divider 的 flex: 0 0 8px 对齐）

/** 分屏里显示的面板（按栏顺序）——没分屏返回空数组 */
function splitIds(dock) {
  const s = layout.split[dock];
  if (!s) return [];
  return [layout.active[dock], ...(s.extra || [])].filter(Boolean);
}

/** 把一组占比收敛成「每栏都不小于一个下限、和 = 1」 */
function normalizeGrows(g) {
  const n = g.length;
  if (!n) return [];
  const min = Math.min(0.35, 1 / (n * 2.4));      // 栏多了不可能每栏都留很大
  let out = g.map(x => Math.max(min, Number(x) || 0));
  let sum = out.reduce((a, b) => a + b, 0) || 1;
  out = out.map(x => x / sum);
  sum = out.reduce((a, b) => a + b, 0) || 1;
  return out.map(x => x / sum);
}

/** 分屏里各栏的占比（和 = 1，顺序跟 splitIds 一致）——没分屏返回空数组 */
function splitGrows(dock) {
  const s = layout.split[dock];
  if (!s) return [];
  const n = splitIds(dock).length;
  if (n < 2) return [];
  const raw = Array.isArray(s.grow) && s.grow.length === n ? s.grow : new Array(n).fill(1 / n);
  return normalizeGrows(raw);
}

/** 拖第 i 条分隔条（0 起：夹在第 i / i+1 栏之间）到「累计占比 = cum」的位置。
 *  只动相邻两栏，其余栏原地不动。 */
function setSplitGrow(dock, i, cum) {
  const s = layout.split[dock];
  if (!s) return;
  const g = splitGrows(dock);
  if (i < 0 || i >= g.length - 1) return;
  const head = g.slice(0, i).reduce((a, b) => a + b, 0);
  const tail = g.slice(i + 2).reduce((a, b) => a + b, 0);
  const avail = Math.max(0.05, 1 - head - tail);      // 相邻两栏能分的总量
  const minR = Math.min(avail / 3, 0.1);
  const a = Math.min(avail - minR, Math.max(minR, cum - head));
  const ng = g.slice();
  ng[i] = a; ng[i + 1] = avail - a;
  layout.split[dock] = { ...s, grow: ng };
}

function renderSplit(dock, panes, ids) {
  const s = layout.split[dock];
  panes.classList.toggle('split', !!s);
  panes.classList.toggle('split-v', !!s && dock !== 'bottom');   // 侧边栏本来就窄 → 上下分
  const box = dockEl(dock);
  const tabs = box?.querySelector('.dock-tabs');
  const headRow = !!s && dock === 'bottom';    // 只有左右分屏才把顶上一排当栏标题行
  tabs?.classList.toggle('split-head', headRow);
  box?.querySelectorAll('.dock-divider').forEach(el => el.remove());
  // 先把「在分屏里」的标记和按比例撑开的 flex 全摘掉：只有分屏里那 2~3 个面板该显示，
  // 同区其余面板必须是隐藏标签（不能被带出来一起显示）
  panes.querySelectorAll(':scope > .panel').forEach(p => {
    p.classList.remove('in-pane');
    p.style.removeProperty('flex-basis');
    p.style.removeProperty('flex-grow');
  });
  // 顶上一排的栏标题格先拆掉（把里面的标签放回顶上一排，别把标签一起丢了）
  if (tabs) {
    tabs.querySelectorAll('.pane-gap').forEach(el => el.remove());
    tabs.querySelectorAll('.pane-cell').forEach(cell => {
      const tab = cell.querySelector('.lp-tab');
      if (tab) tabs.insertBefore(tab, cell);
      cell.remove();
    });
  }
  if (!s) return;
  const list = splitIds(dock).map(panelEl);
  if (!list.length || list.some(p => !p)) { layout.split[dock] = null; panes.classList.remove('split'); return; }
  // 占比用 flex-grow 分（别用 flex-basis 的百分比：那样分隔条会被顶到容器外裁掉，鼠标点不到）
  const grow = splitGrows(dock);
  // 摆成「栏 → 分隔条 → 栏 → 分隔条 → 栏」：分隔条必须夹在两栏**中间**
  list.forEach((p, i) => {
    p.classList.add('in-pane');
    p.style.flexBasis = '0';
    p.style.flexGrow = String(grow[i]);
    panes.appendChild(p);
    if (i < list.length - 1) panes.appendChild(makeDivider(dock, i + 1, list.length));
  });
  // 顶上一排铺成「栏标题行」：每格的宽度**直接量下面那一栏**（比按 flex 估算更准），
  // 格与格之间塞一条跟分隔条同宽的占位 —— 栏名就正好压在各自那栏上面。
  // ⚠ 只在左右分屏（底部区）这么干：上下分屏的栏是竖着叠的，栏名在各自标题行里。
  if (!tabs || !headRow) return;
  list.forEach((p, i) => {
    const tab = tabs.querySelector(`.lp-tab[data-panel="${p.dataset.panel}"]`);
    if (!tab) return;
    const cell = document.createElement('span');
    cell.className = 'pane-cell';
    cell.dataset.paneCell = p.dataset.panel;
    cell.style.flex = '0 0 auto';
    cell.style.width = p.getBoundingClientRect().width + 'px';   // 跟着那一栏的实际宽度走
    tabs.appendChild(cell);
    cell.appendChild(tab);                      // 标签搬进格子里
    if (i === list.length - 1) {
      // 最后一格捎上「没进分屏的标签」和 ⇹ / ⧉ 按钮（右对齐）：
      // 它们要是留在顶上那一排的流里，会把前面几格往右顶、栏名就跟栏对不齐了
      [...tabs.children].forEach(el => {
        if (el !== cell && (el.classList.contains('lp-tab')
          || el.classList.contains('dock-splitbtn') || el.classList.contains('dock-float'))) {
          cell.appendChild(el);
          if (el.classList.contains('dock-splitbtn') || el.classList.contains('dock-float')) el.style.marginLeft = '';
        }
      });
    }
    if (i < list.length - 1) {
      const gap = document.createElement('span');
      gap.className = 'pane-gap';
      tabs.appendChild(gap);
    }
  });
}

/** 造一条分隔条：idx = 第几条（1 起），n = 一共几栏 */
function makeDivider(dock, idx, n) {
  const horizontal = dock === 'bottom';       // 底部区是左右分（分隔条竖直）
  const div = document.createElement('div');
  div.className = 'dock-divider' + (horizontal ? '' : ' v');
  div.dataset.divider = dock;
  div.dataset.idx = String(idx);
  const size = horizontal ? '宽度' : '高度';
  div.title = n > 2
    ? `拖动调第 ${idx} / ${idx + 1} 栏之间的${size} · 双击合起来（变回标签页）`
    : `拖动调${horizontal ? '左右' : '上下'}${size} · 双击合起来（变回标签页）`;
  div.innerHTML = '<span class="dock-divider-grip">⇹</span>';
  return div;
}

/** 分隔条：按住拖动改比例；双击合并 */
function bindSplitDivider() {
  document.addEventListener('pointerdown', e => {
    const div = e.target.closest('.dock-divider');
    if (!div || e.button !== 0) return;
    const dock = div.dataset.divider;
    const idx = Math.max(0, (Number(div.dataset.idx) || 1) - 1);   // 第几条分隔条（0 起：夹在第 idx / idx+1 栏之间）
    const panes = div.parentElement;
    e.preventDefault();
    const rect = panes.getBoundingClientRect();
    const vertical = dock !== 'bottom';
    const n = Math.max(2, splitIds(dock).length);                  // 现在一共几栏
    const total = Math.max(1, (vertical ? rect.height : rect.width) - (n - 1) * DIVIDER_PX);
    const move = ev => {
      const pos = vertical ? ev.clientY - rect.top : ev.clientX - rect.left;
      setSplitGrow(dock, idx, pos / total);   // 只动相邻两栏，其余栏原地不动
      render();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  document.addEventListener('dblclick', e => {
    const div = e.target.closest('.dock-divider');
    if (!div) return;
    // 传分隔条序号：双击哪条就撤它右边那一栏
    mergeSplit(div.dataset.divider, Number(div.dataset.idx) || 1);
  });
}

/** 分屏：当前面板 + 另一个面板并排（两栏）。没指定 second 就拿标签页里的下一个 */
function splitDock(dock, second) {
  const ids = layout[dock];
  const active = layout.active[dock];
  if (!active || ids.length < 2) return false;
  const other = second && second !== active && ids.includes(second)
    ? second
    : ids.find(id => id !== active);
  if (!other) return false;
  layout.active[dock] = active;
  layout.split[dock] = { extra: [other], grow: [0.5, 0.5] };
  save(); render();
  return true;
}

/** 再加一栏：拿同区里还没露出来的面板。没得加 / 加了每栏就太窄 → false */
function addSplitPane(dock, want) {
  const s = layout.split[dock];
  if (!s || !canAddPane(dock)) return false;
  const shown = new Set(splitIds(dock));
  const rest = layout[dock].filter(id => id && !shown.has(id));
  const pick = want && rest.includes(want) ? want : rest[0];
  if (!pick) return false;
  const g = splitGrows(dock);
  // 新栏拿「当前每栏的平均份额」，其余栏按原比例缩小 →
  // 原本等宽的栏再加一栏还是等宽（2 栏 → 3 栏就是各 1/3，不会出现"新栏更窄"）
  const avg = 1 / g.length;
  layout.split[dock] = {
    extra: [...(s.extra || []), pick],
    grow: normalizeGrows([...g, avg]),
  };
  save(); render();
  return true;
}

/** 还能不能再加一栏：同区还有面板 **且** 再加一栏后每栏仍不小于 SPLIT_MIN */
function canAddPane(dock) {
  const shown = new Set(splitIds(dock));
  const rest = layout[dock].filter(id => id && !shown.has(id));
  if (!rest.length) return false;
  const box = dockEl(dock);
  if (!box) return true;
  const n = shown.size;
  const size = dock === 'bottom' ? box.clientWidth : box.clientHeight;
  if (size <= 0) return true;                      // 隐藏时量不到，先按放得下算
  return (size - n * DIVIDER_PX) / (n + 1) >= SPLIT_MIN;
}

/** 双击第 idx 条分隔条：撤掉它**右边那一栏**（最后一栏就是撤最后一栏）；
 *  只剩两栏时 → 合回标签页 */
function mergeSplit(dock, idx) {
  const s = layout.split[dock];
  if (!s) return false;
  const ids = splitIds(dock);
  if (ids.length <= 2) {
    const last = ids[1];
    layout.split[dock] = null;
    if (layout[dock].includes(last)) layout.active[dock] = last;
    save(); render();
    return true;
  }
  const drop = Math.min(ids.length - 1, Math.max(1, Number(idx) || 1));   // 要撤掉的那一栏（0 起）
  const g = splitGrows(dock);
  const extra = (s.extra || []).slice();
  extra.splice(drop - 1, 1);
  const grow = g.slice();
  grow.splice(drop, 1);
  const sum = grow.reduce((a, b) => a + b, 0) || 1;
  layout.split[dock] = extra.length ? { extra, grow: grow.map(x => x / sum) } : null;
  save(); render();
  return true;
}

/** 整个合起来：直接回到「一个面板 + 一排标签页」 */
function mergeAllSplit(dock) {
  const s = layout.split[dock];
  if (!s) return false;
  const last = splitIds(dock).slice(-1)[0];
  layout.split[dock] = null;
  if (last && layout[dock].includes(last)) layout.active[dock] = last;
  save(); render();
  return true;
}

/** ⇹ 按钮：没分屏 → **一次把同区的面板都摊开成栏**（最多 3 栏）；已分屏 → 全合起来 */
export const _toggleSplit = (dock, second) => {
  const s = layout.split[dock];
  if (!s) {
    // 「上面有几个面板就直接分成几栏」：一次到位，不用点两下
    if (!splitDock(dock, second)) return false;
    while (canAddPane(dock)) addSplitPane(dock);    // 两栏 → 三栏（模型上限 3 栏）
    return true;
  }
  return mergeAllSplit(dock);
};

/** 左右分隔条：对应停靠区空（或全浮动）时隐藏 */
function syncResizers() {
  [['left', 'leftResizer'], ['right', 'rightResizer']].forEach(([dock, rzId]) => {
    const rz = document.getElementById(rzId);
    const box = dockEl(dock);
    if (!rz || !box) return;
    if (layout[dock].length === 0) rz.classList.add('hidden');
    else rz.classList.remove('hidden');
  });
}

/* ─────────── 移动面板 ─────────── */
function detach(id) {
  DOCKS.forEach(d => {
    const s = layout.split?.[d];
    const wasActive = layout.active[d] === id;      // 它就是分屏第 1 栏？
    const exIdx = s ? (s.extra || []).indexOf(id) : -1;   // 或者第 2..N 栏里的某一个
    const i = layout[d].indexOf(id);
    if (i >= 0) layout[d].splice(i, 1);
    if (wasActive) layout.active[d] = layout[d][0] || null;
    if (!s) return;
    // 走掉的是第 2..N 栏：只撤掉它那一栏，其余栏保持（只剩一栏就整个解除）；
    // 第 1 栏走（或同区已不足 2 个面板）→ 整个解除分屏（否则剩下的栏会莫名换成别的面板）
    if (exIdx >= 0) {
      const g = splitGrows(d);
      const extra = s.extra.slice();
      extra.splice(exIdx, 1);
      const grow = g.slice();
      grow.splice(exIdx + 1, 1);
      const sum = grow.reduce((a, b) => a + b, 0) || 1;
      layout.split[d] = extra.length ? { extra, grow: grow.map(x => x / sum) } : null;
    } else if (wasActive || layout[d].length < 2) {
      layout.split[d] = null;
    }
  });
  const i = layout.float.findIndex(f => f.id === id);
  if (i >= 0) layout.float.splice(i, 1);
}

function moveTo(id, dock) {
  detach(id);
  layout[dock].push(id);
  layout.active[dock] = id;
  save(); render();
}

function floatPanel(id, x, y) {
  const prev = floatOf(id);
  const p = panelEl(id);
  // 停靠中的面板和停靠区一样高 → 直接拿来当窗口尺寸会得到一个超高的小窗，这里收敛到合理默认值；
  // 之前浮动过就沿用用户自己调过的尺寸
  const w = prev ? prev.w : Math.min(420, Math.max(240, p?.offsetWidth || 300));
  const h = prev ? prev.h : Math.min(520, Math.max(220, p?.offsetHeight || 380));
  detach(id);
  const vw = window.innerWidth, vh = window.innerHeight;
  let px = Math.round((x ?? vw / 2) - w / 2);
  let py = Math.round((y ?? vh / 3) - 20);
  // 叠罗汉避免：和已有浮动窗重合就错开（⧉ 连续弹两个时不然会完全盖住）
  for (let i = 0; i < 10 && layout.float.some(f => Math.abs(f.x - px) < 28 && Math.abs(f.y - py) < 28); i++) {
    px += 30; py += 26;
  }
  layout.float.push({
    id,
    x: Math.max(8, Math.min(vw - w - 8, px)),
    y: Math.max(8, Math.min(vh - h - 8, py)),
    w, h,
  });
  save(); render();
}

/** 落点判定：
 *  · 画布下方那条灰色带（或窗口最底部 130px）→ 停靠到底部
 *  · 左右两侧边缘 → 停靠到左/右
 *  · 其余（画布中间）→ 浮动窗口
 *  只留窗口最底部一小条会让人「拖到底部却变成浮动窗」，所以把画布下方的整条灰色区都算底部。 */
function bottomBand() {
  const vh = window.innerHeight;
  const canvas = document.getElementById('canvas');
  const cb = canvas ? canvas.getBoundingClientRect() : null;
  return Math.max(130, cb ? (vh - cb.bottom) + 10 : 130);
}
function zoneRect(zone) {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (zone === 'bottom') return { left: 0, top: vh - bottomBand(), width: vw, height: bottomBand() };
  const w = Math.max(180, vw * 0.22);
  return zone === 'left'
    ? { left: 0, top: 0, width: w, height: vh }
    : { left: vw - w, top: 0, width: w, height: vh };
}
function zoneAt(x, y) {
  const vw = window.innerWidth;
  if (y > window.innerHeight - bottomBand()) return 'bottom';
  if (x < Math.min(210, vw * 0.22)) return 'left';
  if (x > vw - Math.min(210, vw * 0.22)) return 'right';
  return 'float';
}

/** 鼠标下面是不是某个停靠区的**面板区**（不是标签栏）→ 拖到这里才谈分屏/并标签 */
function dockUnder(x, y) {
  const el = document.elementFromPoint(x, y);
  const panes = el?.closest?.('.dock-panes');
  const box = panes?.closest('.dock');
  return DOCS_FIND(box);
}
function DOCS_FIND(box) { return DOCKS.find(d => DOCK_EL[d] === box?.id) || null; }

/** 落点在停靠区的哪一段：**落在面板区就是分屏**（按左半/右半决定放哪边）——
 *  现场要的是「拖进去就自动分割」，不该让人去瞄准三分之一。
 *  想并成标签页就拖到标签栏上（那一排本来就在最上面，落点很自然）；
 *  拖到空区/边缘还是老样子「停靠在那一侧」。 */
function dropZoneAt(dock, x, y) {
  const panes = dockEl(dock)?.querySelector('.dock-panes');
  if (!panes) return 'after';
  const r = panes.getBoundingClientRect();
  const vertical = dock !== 'bottom';
  const rel = vertical ? (y - r.top) / Math.max(1, r.height) : (x - r.left) / Math.max(1, r.width);
  return rel < 0.5 ? 'before' : 'after';
}

function dropAt(id, x, y) {
  const dock = dockUnder(x, y);
  if (dock && layout[dock].length) {
    const zone = dropZoneAt(dock, x, y);
    // 落在面板区 → 自动分屏：拖过来的那个放这一侧
    if (!layout[dock].includes(id)) { detach(id); layout[dock].push(id); }
    // 已经分屏了、拖过来的又没露出来 → 直接再添一栏（落在前半边就插到最前）
    const cur = layout.split[dock];
    const shown = splitIds(dock);
    if (cur && !shown.includes(id) && canAddPane(dock)) {
      const idx = zone === 'before' ? 0 : shown.length;
      const order = shown.slice();
      order.splice(idx, 0, id);
      const g = splitGrows(dock);
      const raw = g.slice();
      raw.splice(idx, 0, 1 / g.length);              // 新栏拿当前平均份额，再整体归一
      layout.active[dock] = order[0];
      layout.split[dock] = { extra: order.slice(1), grow: normalizeGrows(raw) };
      save(); render();
      return;
    }
    const host = layout[dock].find(x2 => x2 !== id) || null;
    if (host) {
      // 没分屏 → 落地就分两栏（拖过来的那个按落点放左/右）
      const first = zone === 'before' ? id : host;
      const second = zone === 'before' ? host : id;
      layout.active[dock] = first;
      const oldG = splitGrows(dock);
      const g1 = oldG.length ? oldG[0] : 0.5;
      layout.split[dock] = { extra: [second], grow: [g1, 1 - g1] };
      save(); render();
      return;
    }
  }
  const edge = zoneAt(x, y);
  if (edge === 'float') floatPanel(id, x, y);
  else moveTo(id, edge);
}

/* ─────────── 交互 ─────────── */
function makeChip(text) {
  const el = document.createElement('div');
  el.className = 'dock-chip';
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

let previewEl = null;   // 拖动时的半透明落点预览

function highlight(zone) {
  DOCKS.forEach(d => dockEl(d)?.classList.toggle('drop-target', d === zone));
  if (!previewEl) {
    previewEl = document.createElement('div');
    previewEl.className = 'dock-preview';
    document.body.appendChild(previewEl);
  }
  if (!zone) { previewEl.style.display = 'none'; return; }
  const r = zoneRect(zone);
  Object.assign(previewEl.style, {
    display: 'flex',
    left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
  });
  previewEl.textContent = zone === 'left' ? '停靠到左侧' : zone === 'right' ? '停靠到右侧' : '停靠到底部';
  return zone;
}

/** 拖到某个面板的某一侧（分屏）：高亮那个停靠区，写明「分屏：拖过来的在左/右」 */
function highlightSplit(dock, id, zone) {
  DOCKS.forEach(d => dockEl(d)?.classList.toggle('drop-target', d === dock));
  if (!previewEl) {
    previewEl = document.createElement('div');
    previewEl.className = 'dock-preview';
    document.body.appendChild(previewEl);
  }
  previewEl.classList.add('split');
  const box = dockEl(dock)?.getBoundingClientRect();
  const host = layout[dock].find(x => x !== id);
  const vertical = dock !== 'bottom';
  const side = vertical ? (zone === 'before' ? '上面' : '下面') : (zone === 'before' ? '左边' : '右边');
  Object.assign(previewEl.style, box
    ? { display: 'flex', left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' }
    : { display: 'flex' });
  previewEl.textContent = `与「${PANELS[host]?.title || ''}」分屏 · 「${PANELS[id]?.title || ''}」放${side}`;
}

/** 标签页：点击切换，按住拖动 → 移动/浮动/分屏 */
function onTabPointerDown(e) {
  const tab = e.target.closest('.lp-tab');
  if (!tab || e.button !== 0) return;
  const id = tab.dataset.panel;
  if (!PANELS[id]) return;
  const startX = e.clientX, startY = e.clientY;
  let chip = null;

  const move = ev => {
    if (!chip) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      chip = makeChip(`${PANELS[id].title} · 拖到边缘停靠 / 中间浮动 / 拖到面板上分屏`);
      tab.classList.add('dragging');
      drag = { id };
    }
    chip.style.left = ev.clientX + 'px';
    chip.style.top = ev.clientY + 'px';
    // 落在面板区 → 自动分屏（拖到标签栏上才是并成标签页）
    const dock = dockUnder(ev.clientX, ev.clientY);
    const zone = dock && layout[dock].length ? dropZoneAt(dock, ev.clientX, ev.clientY) : null;
    if (dock && zone) {
      chip.textContent = `${PANELS[id].title} · 与「${PANELS[layout[dock].find(x => x !== id)]?.title || ''}」分屏`;
      if (previewEl) previewEl.classList.add('split');
      highlightSplit(dock, id, zone);
      return;
    }
    if (previewEl) previewEl.classList.remove('split');
    const edge = zoneAt(ev.clientX, ev.clientY);
    chip.textContent = `${PANELS[id].title} · ${edge === 'float' ? '浮动窗口' : { left: '停靠到左侧', right: '停靠到右侧', bottom: '停靠到底部' }[edge]}`;
    highlight(edge === 'float' ? null : edge);
  };
  const up = ev => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    tab.classList.remove('dragging');
    highlight(null);
    if (previewEl) previewEl.classList.remove('split');
    if (chip) {
      chip.remove();
      drag = null;
      dropAt(id, ev.clientX, ev.clientY);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** 标签栏：点 ⧉ 浮动窗 / 点 ⇹ 分屏或合并 */
function onTabsClick(e) {
  const sb = e.target.closest('.dock-splitbtn');
  if (sb) { _toggleSplit(sb.dataset.splitbtn); return; }
  const fb = e.target.closest('.dock-float');
  if (fb) {
    const dock = fb.dataset.float;
    const id = layout.active[dock];
    if (id) {
      const box = dockEl(dock).getBoundingClientRect();
      floatPanel(id, box.left + box.width / 2, box.top + 80);
    }
    return;
  }
  const tab = e.target.closest('.lp-tab');
  if (!tab || !PANELS[tab.dataset.panel]) return;
  const dock = tab.closest('.dock')?.id === 'bottomPanel' ? 'bottom'
    : tab.closest('.dock')?.id === 'rightPanel' ? 'right' : 'left';
  // 拖拽结束后的那次 click 可能落在已失效的标签上 → 只接受确实属于该停靠区的面板
  if (!layout[dock].includes(tab.dataset.panel)) return;
  if (layout.active[dock] === tab.dataset.panel) return;
  layout.active[dock] = tab.dataset.panel;
  save(); render();
}

/** 浮动窗口：拖标题移动、拖右下角改大小、⇤ 停靠回去、双击标题回老家 */
function bindFloating() {
  document.addEventListener('pointerdown', e => {
    const panel = e.target.closest('.panel.floating');
    if (!panel) return;
    const id = panel.dataset.panel;
    const f = floatOf(id);
    if (!f) return;

    if (e.target.closest('[data-redock]')) {
      moveTo(id, HOME[id] || 'left');
      return;
    }
    const resizing = !!e.target.closest('.panel-resize');
    const head = e.target.closest('.panel-head');
    if (!resizing && !head) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const x0 = f.x, y0 = f.y, w0 = f.w, h0 = f.h;

    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (resizing) {
        f.w = Math.max(200, w0 + dx);
        f.h = Math.max(160, h0 + dy);
        panel.style.width = f.w + 'px';
        panel.style.height = f.h + 'px';
      } else {
        const vw = window.innerWidth, vh = window.innerHeight;
        f.x = Math.max(-f.w + 80, Math.min(vw - 60, x0 + dx));
        f.y = Math.max(0, Math.min(vh - 32, y0 + dy));
        panel.style.left = f.x + 'px';
        panel.style.top = f.y + 'px';
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // 双击浮动窗口标题 → 停靠回老家
  document.addEventListener('dblclick', e => {
    const head = e.target.closest('.panel.floating .panel-head');
    if (!head) return;
    const id = head.closest('.panel').dataset.panel;
    moveTo(id, HOME[id] || 'left');
  });
}

/* ─────────── 入口 ─────────── */
export function initDock() {
  Object.keys(PANELS).forEach(id => {
    const el = document.getElementById('panel-' + id);
    if (el) ELS.set(id, el);
  });
  const missing = Object.keys(PANELS).filter(id => !ELS.has(id));
  if (missing.length) console.warn('[dock] 页面里找不到这些面板元素，已跳过：', missing.join(', '));
  layout = load();
  // 换工程（新建/打开文件/读服务器）→ 布局也跟着换成那份工程里的（布局是工程的一部分）
  bus.on('project:replaced', () => { layout = load(); render(); });
  ['leftPanel', 'rightPanel', 'bottomPanel'].forEach(elId => {
    const box = document.getElementById(elId);
    box.addEventListener('pointerdown', onTabPointerDown);
    box.addEventListener('click', onTabsClick);
  });
  bindFloating();
  bindSplitDivider();
  // 浮动面板被拖到屏幕外（窗口变小）时拉回来
  window.addEventListener('resize', () => {
    let changed = false;
    const vw = window.innerWidth, vh = window.innerHeight;
    layout.float.forEach(f => {
      const nx = Math.min(f.x, vw - 80), ny = Math.min(f.y, vh - 40);
      if (nx !== f.x || ny !== f.y) { f.x = Math.max(0, nx); f.y = Math.max(0, ny); changed = true; }
    });
    if (changed) { save(); render(); }
  });
  render();
}

/* 测试/调试用 */
export function _getLayout() { return JSON.parse(JSON.stringify(layout)); }
export function _resetLayout() {
  layout = defaultLayout();
  save(); render();
}

/* ── 右键菜单用的小接口 ── */
/** 面板当前停在哪个区（'left' | 'right' | 'bottom' | 'float'）*/
export function panelDock(id) { return floatOf(id) ? 'float' : (dockOf(id) || null); }
/** 把面板弹成浮动窗口（菜单/⧉ 共用）*/
export function floatPanelById(id) {
  const p = panelEl(id);
  const r = p?.getBoundingClientRect();
  floatPanel(id, r ? r.left + r.width / 2 : window.innerWidth / 2, r ? r.top + 60 : window.innerHeight / 3);
}
/** 停靠到指定区 */
export function dockPanelTo(id, dock) {
  if (DOCKS.includes(dock)) moveTo(id, dock);
}
/** 停靠回它原来的区域 */
export function dockPanelHome(id) { moveTo(id, HOME[id] || 'left'); }
/** 这个面板此刻是不是占着分屏的第 2..N 栏 */
export function splitOf(id) {
  const d = DOCKS.find(x => (layout.split?.[x]?.extra || []).includes(id));
  return d ? { dock: d, host: layout.active[d], grow: splitGrows(d) } : null;
}
/** 分屏：让 A / B / C / D… 并排显示（几个面板得在同一个停靠区）——菜单/脚本用 */
export function splitPanels(...ids) {
  const list = ids.filter(Boolean);
  if (list.length < 2) return false;
  const dock = dockOf(list[0]);
  if (!dock || list.some(id => dockOf(id) !== dock)) return false;
  layout.active[dock] = list[0];
  if (!splitDock(dock, list[1])) return false;
  for (const id of list.slice(2)) addSplitPane(dock, id);
  return true;
}
/** 合并回标签页（一次合到底：不管三栏还是两栏都直接回到标签页）——菜单/脚本用 */
export function mergeSplitAt(dock) { return mergeAllSplit(dock); }
