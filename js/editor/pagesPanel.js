/**
 * pagesPanel.js — 页面管理（普通页 / 弹窗页 / 公共底）
 *   · 列表渲染、点击切换当前编辑页；双击重命名、删除
 *   · 弹窗页可编辑尺寸（popupW / popupH）
 *   · 公共底（type:'base'）：套在普通页下面的那一层，写一次多页共用；
 *     列表里给「底」角标，普通页上标出它套的是哪个底
 *   · **按类型分组 + 可展开收起**（现场要求）：画面和画面在一起、弹窗和弹窗在一起、公共底单独一组，
 *     每组一行表头（▸/▾ + 组名 + 个数），收起状态记在本机；当前页所在的那组切页时自动展开，
 *     免得"切过去了却看不见自己在哪里"。右上角那个小按钮可以整体切成平铺（按建立顺序）。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { escapeHtml } from '../core/utils.js';
import { showDialog } from './toolbar.js';
import { openAt } from '../core/contextMenu.js';

/* ── 分组 / 收起 状态（本机记住，和变量面板的折叠组一个路子） ── */
const FOLD_KEY = 'hmi-pages-fold-v1';      // { page:true, popup:true, base:true } → true = 收起
const GROUP_KEY = 'hmi-pages-group';       // '0' = 平铺（按建立顺序）；其余 = 分组（默认）
const TYPES = [
  { type: 'page', name: '页面', icon: '页' },
  { type: 'popup', name: '弹窗', icon: '弹' },
  { type: 'base', name: '公共底', icon: '底' },
];
function foldState() {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch { return {}; }
}
function setFold(type, collapsed) {
  const s = foldState();
  s[type] = !!collapsed;
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
}
function groupOn() {
  try { return localStorage.getItem(GROUP_KEY) !== '0'; } catch { return true; }
}
function setGroupOn(on) {
  try { localStorage.setItem(GROUP_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

export function initPagesPanel() {
  // 「＋ 新建 ▾」：新建页面/弹窗/公共底 + 复制这一页 都收进一个下拉菜单 ——
  // 面板窄的时候四个按钮并排会挤出面板边界（现场反馈），收进下拉就不会超出。
  document.getElementById('btnAddPage')?.addEventListener('click', openNewMenu);
  document.getElementById('btnPgGroup')?.addEventListener('click', () => {
    setGroupOn(!groupOn());
    paintGroupBtn();
    render();
  });
  import('./pageIO.js').then(m => m.initPageIO()).catch(() => { /* 单页导入不可用时不影响面板 */ });
  bus.on('project:changed', render);
  bus.on('page:current', () => {
    // 切到某一页时，把它所在的那一组撑开（不然收起状态下"切过去了却看不见在哪一页"）
    const p = project.currentPage();
    if (p && groupOn() && foldState()[p.type]) { setFold(p.type, false); }
    render();
  });
  paintGroupBtn();
  render();
}

/** 「＋ 新建 ▾」下拉：和工程菜单同一套（openAt 是右键菜单那套样式/键盘/点别处关闭） */
function openNewMenu() {
  const btn = document.getElementById('btnAddPage');
  const r = btn.getBoundingClientRect();
  const cur = project.currentPage();
  openAt(r.left, r.bottom + 4, [
    { header: '新建 / 复制 / 导入' },
    { label: '新建页面', onClick: () => project.addPage('page') },
    { label: '新建弹窗', onClick: () => project.addPage('popup') },
    { label: '新建公共底', onClick: () => project.addPage('base') },
    { sep: true },
    // 复制当前这一页（公共底也能复制 —— 右键菜单里也有同一项）
    { label: `复制这一页（${cur?.name || '当前页'}）`, onClick: () => duplicatePageOnce(project.currentId) },
    { label: '多重复制页…', onClick: () => openPageDupDialog(project.currentId) },
    { sep: true },
    { label: '导入页面…（从 .json 文件）', onClick: () => import('./pageIO.js').then(m => m.pickPageFile()) },
    { label: `导出这一页…（${cur?.name || '当前页'}）`, onClick: () => import('./pageIO.js').then(m => m.exportPage(project.currentId)) },
  ]);
}

/** 分组开关那个小按钮：分组 ▤ / 平铺 ☰（当前状态用高亮 + 文字说清） */
function paintGroupBtn() {
  const btn = document.getElementById('btnPgGroup');
  if (!btn) return;
  const on = groupOn();
  btn.classList.toggle('active', on);
  btn.textContent = on ? '▤ 分组' : '☰ 平铺';
  btn.title = on
    ? '现在按类型**分组**显示（页面 / 弹窗 / 公共底 各自一组，点组表头展开收起）。点一下切成平铺（按建立顺序一列到底）'
    : '现在是**平铺**（按建立顺序一列到底）。点一下切成按类型分组（页面 / 弹窗 / 公共底 各一组）';
}

/* ── 多重复制页面 ──────────────────────────────────────────────────
   和「控件多重复制」同一套口径（份数/名称编号/变量名递增/地址间隔/自动建变量），
   只是复制单位是一整页。页面的位置/排列没意义，所以对话里不放「排列方式/间距」。 */
const PAGEDUP_KEY = 'hmi-designer-pagedup-v1';
const PAGEDUP_DEF = { count: 2, seqStep: 1, nameSeq: true, varSeq: true, addrStep: 0, autoVar: true, varMode: 'always' };
function loadPageDup() {
  try { return { ...PAGEDUP_DEF, ...(JSON.parse(localStorage.getItem(PAGEDUP_KEY) || '{}')) }; }
  catch { return { ...PAGEDUP_DEF }; }
}

/** 快速复制当前这一页（按上次的参数，**只复制一份**） */
export function duplicatePageOnce(pageId) {
  const s = loadPageDup();
  // ⚠ 展开顺序不能反：`{...s, count: 1}` —— 上次在对话框里填过"份数 5"的话，
  //   `{count: 1, ...s}` 会被 s.count 盖掉，点一下 ⧉ 直接冒出 5 页（实测踩过）。
  const res = project.duplicatePages([pageId], { ...s, count: 1 });
  if (!res.pageIds.length) return 0;
  reportPageDup(res);
  return res.pageIds.length;
}

/** 多重复制页面对话框 */
export function openPageDupDialog(pageId) {
  const pg = project.getPage(pageId);
  if (!pg) { alert('先选中一个页面'); return; }
  const s = loadPageDup();
  showDialog({
    title: `多重复制页面（「${pg.name}」· ${pg.widgets.length} 个控件）`,
    body: `
      <div class="f-row"><span class="f-label">复制份数</span>
        <input class="f-input" id="pdupCount" type="number" min="1" max="50" value="${s.count}">
        <span style="color:var(--text-2);font-size:11px;flex:none">份（新生成几页）</span></div>
      <div class="f-row"><span class="f-label">页面名编号</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input class="f-check" id="pdupNameSeq" type="checkbox" ${s.nameSeq ? 'checked' : ''}>
          <span style="color:var(--text-2);font-size:12px">页名/控件名末尾数字递增（主画面 → 主画面2、主画面3）</span></label></div>
      <div class="f-row"><span class="f-label">序号步长</span>
        <input class="f-input" id="pdupSeqStep" type="number" min="-999" max="999" value="${s.seqStep}"
               title="每复制一份，名称/变量名末尾的数字加多少">
        <span style="color:var(--text-2);font-size:11px;flex:none">可填负数（-1 = 倒着排）</span></div>
      <div class="f-row"><span class="f-label">变量递增</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input class="f-check" id="pdupVarSeq" type="checkbox" ${s.varSeq ? 'checked' : ''}>
          <span style="color:var(--text-2);font-size:12px">每页用各自的变量（rSpeed1 → rSpeed2…）</span></label></div>
      <div class="f-row"><span class="f-label">名字没数字</span>
        <select class="f-select" id="pdupVarMode">
          <option value="always">也自动加序号（rSpeed → rSpeed1/rSpeed2…）</option>
          <option value="digit">保持同一个变量（只给带数字的名字递增）</option>
        </select></div>
      <div class="f-row"><span class="f-label">地址间隔</span>
        <input class="f-input" id="pdupAddrStep" type="number" min="-1000" max="1000" value="${s.addrStep}"
               title="每个新变量的地址往后挪几个寄存器（负数 = 往前挪）">
        <span style="color:var(--text-2);font-size:11px;flex:none">字（0 = 按类型自动）</span></div>
      <div class="f-row"><span class="f-label">自动建变量</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input class="f-check" id="pdupAutoVar" type="checkbox" ${s.autoVar ? 'checked' : ''}>
          <span style="color:var(--text-2);font-size:12px">新变量直接写进变量表（类型/初值照抄，地址按上面间隔往后排）</span></label></div>
      <div style="color:var(--text-2);font-size:11px;line-height:1.7;border-top:1px dashed var(--border);padding-top:7px">
        整页复制：页内所有控件、组、绑定、跳转动作都会跟着复制；<br>
        页内「跳转/弹窗」如果指向的是被复制的页之一，会跟着指到这一份对应的副本。
      </div>`,
    onOk: () => {
      const opts = {
        count: Math.max(1, Math.min(50, +document.getElementById('pdupCount').value || 1)),
        nameSeq: document.getElementById('pdupNameSeq').checked,
        varSeq: document.getElementById('pdupVarSeq').checked,
        varMode: document.getElementById('pdupVarMode').value,
        seqStep: Math.round(+document.getElementById('pdupSeqStep').value || 0),
        addrStep: Math.round(+document.getElementById('pdupAddrStep').value || 0),
        autoVar: document.getElementById('pdupAutoVar').checked,
      };
      try { localStorage.setItem(PAGEDUP_KEY, JSON.stringify({ ...opts, count: Math.max(2, opts.count) })); } catch { /* 忽略 */ }
      const res = project.duplicatePages([pageId], opts);
      reportPageDup(res);
      return true;
    },
  });
}

/** 复制结果说清楚：建了哪些变量、哪些没建上（别等运行了才发现绑定是空的） */
function reportPageDup(res) {
  const lines = [`已复制 ${res.pageIds.length} 页。`];
  if (res.createdVars?.length) {
    lines.push(`\n自动创建了 ${res.createdVars.length} 个变量（地址按类型往后排）：`);
    lines.push(res.createdVars.slice(0, 10)
      .map(v => `  ${v.name}  ${v.type}  ${v.address || '(地址待填)'}   ← ${v.from}`).join('\n'));
    if (res.createdVars.length > 10) lines.push(`  …共 ${res.createdVars.length} 个`);
    if (res.noAddrVars?.length) {
      lines.push('\n其中这些的地址没算出来（写法不是 %MW/HR/数字），请在变量表里手填：');
      lines.push('  ' + res.noAddrVars.slice(0, 8).join('、'));
    }
  }
  if (res.missingVars?.length) {
    lines.push('\n这些变量还没在变量表里，请在左侧「变量」面板补上（或导入 CSV）：');
    lines.push(res.missingVars.slice(0, 8).join('、')
      + (res.missingVars.length > 8 ? ` …共 ${res.missingVars.length} 个` : ''));
  }
  alert(lines.join('\n'));
}

function render() {
  const list = document.getElementById('pageList');
  list.innerHTML = '';
  const pages = project.pages();
  // 平铺：按建立顺序一列到底（老样子）
  if (!groupOn()) { pages.forEach(p => list.appendChild(pageRow(p))); return; }
  // 分组：页面 / 弹窗 / 公共底 各一组，同类的排在一起；空组不显示
  const fold = foldState();
  TYPES.forEach(t => {
    const mine = pages.filter(p => p.type === t.type);
    if (!mine.length) return;
    const collapsed = !!fold[t.type];
    list.appendChild(groupRow(t, mine, collapsed));
    if (!collapsed) mine.forEach(p => list.appendChild(pageRow(p)));
  });
}

/** 组表头：▸/▾ + 组名 + 个数（收起时把"当前在哪一页"也写出来，别让人找不着自己） */
function groupRow(t, mine, collapsed) {
  const row = document.createElement('div');
  row.className = 'pg-group' + (collapsed ? '' : ' open') + ' pg-group-' + t.type;
  row.dataset.gtype = t.type;
  const cur = mine.find(p => p.id === project.currentId);
  row.innerHTML = `
    <span class="pg-gtw">${collapsed ? '▸' : '▾'}</span>
    <b>${t.name}</b>
    <span class="pg-gcnt">${mine.length} 个</span>
    ${collapsed && cur ? `<span class="pg-gcur" title="当前编辑的就是这一页">当前：${escapeHtml(cur.name)}</span>` : ''}`;
  row.title = collapsed ? '点一下展开这一组' : '点一下收起这一组（收起状态会记住）';
  row.addEventListener('click', () => {
    setFold(t.type, !collapsed);
    render();
  });
  return row;
}

/** 一行页面 */
function pageRow(p) {
  const isBase = p.type === 'base';
  const isPopup = p.type === 'popup';
  const item = document.createElement('div');
  item.className = 'pg-item' + (p.id === project.currentId ? ' current' : '')
    + (isBase ? ' pg-base' : '');
  item.dataset.pageId = p.id;   // 右键菜单按 id 取页面，不靠名字匹配
  // 普通页套了公共底（可叠多层）→ 名字后面挂一个小标签，一眼看出这一页底下垫的是哪几层
  const bases = project.basesOf(p);
  const baseNames = bases.map(b => b.name);
  const baseTag = bases.length
    ? `<span class="pg-basetag" title="这一页套用了 ${bases.length} 层公共底（从下到上）：${escapeHtml(baseNames.join(' → '))}；底上的控件画在本页内容的下面，改底=所有套用它的页面一起变">垫：${escapeHtml(baseNames.join('、'))}</span>`
    : '';
  const typeBadge = isPopup ? '弹' : isBase ? '底' : '页';
  const typeCls = isPopup ? 'orange' : isBase ? 'purple' : 'blue';
  const count = isBase
    ? `${p.widgets.length} 控件 · 被 ${project.pagesUsingBase(p.id).length} 页套用`
    : `${p.widgets.length} 控件`;
  // 页面名必须转义：工程 JSON 会在机器之间来回传，名称里的 HTML 不该被执行。
  // 行上**一个按钮都不摆**（现场要求）：复制 / 删除 / 导出 全在**右键菜单**里，
  // 行就留「角标 + 名字 + 垫：xxx」—— 名字那一栏能多显示几个字，也不容易点错。
  item.innerHTML = `
    <span class="badge ${typeCls}">${typeBadge}</span>
    <span class="pg-name" title="双击重命名 · 右键：复制 / 导出 / 删除&#10;${count}">${escapeHtml(p.name)}</span>
    ${baseTag}`;
  item.addEventListener('click', () => project.setCurrentPage(p.id));
  item.querySelector('.pg-name').addEventListener('dblclick', () => rename(p.id));
  // 组里的行缩进一格（看得出它属于上面那个组）
  if (groupOn()) item.classList.add('pg-in');
  return item;
}

/**
 * 删除一页/一个底（右键菜单里的「删除此页」走这里；行里已经不摆 ✕ 按钮了）。
 * 删底之前先说清楚会影响哪几页 —— 底一删，那些页面就少了底下那一层。
 */
export function deletePageWithConfirm(id) {
  const p = project.getPage(id);
  if (!p) return false;
  const isBase = p.type === 'base';
  const used = isBase ? project.pagesUsingBase(p.id) : [];
  const extra = used.length
    ? `\n\n有 ${used.length} 个页面套着它（${used.slice(0, 6).map(x => x.name).join('、')}${used.length > 6 ? '…' : ''}），`
      + '删掉后这些页面会回到「不套底」（页面自己的控件不受影响）。'
    : '';
  if (!confirm(`确定删除${isBase ? '公共底' : '页面'}「${p.name}」吗？${isBase ? '底上的控件' : '页面上的控件'}将一并删除。${extra}`)) return false;
  project.deletePage(p.id);
  return true;
}

/** 重命名页面（右键菜单也用它）*/
export function renamePage(id) { rename(id); }

function rename(id) {
  const p = project.getPage(id);
  showDialog({
    title: '重命名页面',
    body: `<div class="f-row"><span class="f-label">页面名称</span>
      <input class="f-input" id="dlgInput" value="${escapeHtml(p.name)}"></div>`,
    onOk: () => {
      const v = document.getElementById('dlgInput').value.trim();
      if (v) project.updatePage(id, { name: v });
      return true;
    },
  });
  setTimeout(() => document.getElementById('dlgInput')?.select(), 30);
}
