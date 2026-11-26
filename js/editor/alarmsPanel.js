/**
 * alarmsPanel.js — 报警编辑栏（左侧「报警」面板）
 *
 * 每条报警 = 触发条件 + 内容：
 *   变量 + 比较符 + 阈值   → 条件成立就报警
 *   内容里可以写 {变量名}，触发时替换成当时的值：主轴转速过高：{rSpeed} m/min（上限 3000）
 *
 * 内容不在表格那一格里硬写（列多、格子窄，写两行都看不见）：
 *   点内容格 → 弹窗（大文本框 + 「插入变量」按钮 + 实时预览），整段写好再保存。
 * 另外支持报警表 CSV 导入/导出，内容可以在 Excel 里批量写好（逗号/换行/引号都能原样进出）。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { genId } from '../core/utils.js';
import { createVList } from '../core/vlist.js';
import { alarmsToCsv, importAlarmsCsv, exportText, readTextFile } from '../core/csv.js';
import { attachVarPick } from './varPick.js';
import { initColResize } from './colResize.js';
import { ALARM_LEVELS, alarmLevels, levelOf } from '../runtime/alarms.js';
import { showDialog } from './toolbar.js';

const OPS = [
  { v: '>=', t: '≥' }, { v: '>', t: '>' }, { v: '<=', t: '≤' },
  { v: '<', t: '<' }, { v: '==', t: '=' }, { v: '!=', t: '≠' },
];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 内容里的变量引用 {变量名}。
 *  ⚠ **中文名也得认**：以前写的是 `/\{([A-Za-z_][\w.]*)\}/`，只认 ASCII ——
 *    内容里写 `{温度}`、`{中1[1]}` 时既不高亮、也不替换、运行时还**原样显示 {温度}**，
 *    现场看着就是"中文变量选了也没用"。变量名里可以有点和方括号（GVL.中1[1]），
 *    但不能有花括号/空白，所以按"不是花括号、不是空白"来取最稳。 */
const RE_REF = /\{([^{}\s]+)\}/g;

export function initAlarmsPanel() {
  loadSort();                     // 上次点表头的排序（升/降/取消）也接着用
  document.getElementById('btnAddAlarm')?.addEventListener('click', () => openAlarmEditor());
  document.getElementById('btnAlarmLevels')?.addEventListener('click', openAlarmLevels);
  document.getElementById('btnDelAlarms')?.addEventListener('click', deleteSelected);
  document.getElementById('alarmFilter')?.addEventListener('input', e => {
    filterText = e.target.value.trim().toLowerCase();
    applyFilter();
  });
  document.getElementById('btnAlarmCsvOut')?.addEventListener('click', exportCsv);
  document.getElementById('btnAlarmCsvIn')?.addEventListener('click', openCsvImport);
  bus.on('project:changed', render);
  bus.on('page:current', render);
  render();
}

let filterText = '';
let vl = null;              // 报警表的窗口化列表（只画可视区那几十行）
let lastFp = '';            // 上次画出来的那版指纹（没变就不重画）
let varMap = new Map();     // 变量名 → 变量（内容格里查 {变量名} 引用，别每行 some/find 扫一遍）
let skipPaint = false;      // 表格里自己改的那一格：数据变了但 DOM 已经是最新的，别重画
/** 勾选中的报警 id（多选删除用）。
 *  **按 id 记、不按下标**：行是窗口化反复回收的，下标一滚动就串位；
 *  报警被删掉（单条 ✕ / CSV 整表替换 / 从服务器读）后在 render 里自动剔掉。 */
let selAlarms = new Set();

/* ── 报警排序（点表头：名称 / 变量 / 级别）────────────────────────────────────
   和变量面板（varsPanel.js 的 sortVars）同一套手感：点第 1 下升序、第 2 下降序、
   第 3 下取消（回到工程里的报警顺序）。只改**显示顺序**，不动工程里的报警表 ——
   CSV 导出、下发给后端、运行态的采集顺序都还是工程顺序。
   排序状态记本机 localStorage（跟列宽一样是使用习惯，不进工程文件）。 */
const SORT_KEY = 'hmi-alarm-sort';
const SORTABLE = { name: '名称', variable: '变量', level: '级别' };
let sortKey = '';               // '' = 不排序（工程原始顺序）
let sortDir = 1;                // 1 升序 / -1 降序
// 中文按拼音、数字按大小（Alarm2 排在 Alarm10 前面）
const zhColl = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function loadSort() {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (s && SORTABLE[s.key]) { sortKey = s.key; sortDir = s.dir < 0 ? -1 : 1; }
  } catch { sortKey = ''; }
}
function saveSort() {
  try {
    if (sortKey) localStorage.setItem(SORT_KEY, JSON.stringify({ key: sortKey, dir: sortDir }));
    else localStorage.removeItem(SORT_KEY);
  } catch { /* 无痕模式之类：存不了就算了，不影响这次排序 */ }
}
/** 级别排序的“大小”：按级别自己的优先级（提示 0 → 紧急 3），同档再按级别名。
 *  级别 id 可能是工程自定义的，所以统一走 levelOf() 拿 rank/t，别按字符串排。 */
function sortAlarms(list) {
  if (!sortKey) return list;
  const cmp = (x, y) => {
    if (sortKey === 'name') return zhColl.compare(String(x.name || ''), String(y.name || ''));
    if (sortKey === 'variable') return zhColl.compare(String(x.variable || ''), String(y.variable || ''));
    const lx = levelOf(x.level), ly = levelOf(y.level);
    return (lx.rank - ly.rank) || zhColl.compare(String(lx.t || ''), String(ly.t || ''));
  };
  // 稳定排序：同键按原顺序；降序只反转比较结果，同键的相对顺序不变
  return list.map((a, i) => [a, i]).sort((p, q) => {
    const c = cmp(p[0], q[0]);
    return c ? c * sortDir : p[1] - q[1];
  }).map(p => p[0]);
}
/** 点了表头：升序 → 降序 → 取消 */
function toggleSort(key) {
  if (!SORTABLE[key]) return;
  if (sortKey !== key) { sortKey = key; sortDir = 1; }
  else if (sortDir === 1) sortDir = -1;
  else { sortKey = ''; sortDir = 1; }
  saveSort();
  // 不重建表（指纹没变、行是窗口化的）：只把数据按新顺序塞回去
  if (!vl) { lastFp = ''; render(); return; }
  vl.setItems(currentList());
  syncSortHead();
  const scroller = document.getElementById('alarmTable');
  if (scroller) scroller.scrollTop = 0;
}
/** 表头上的箭头（▲/▼）跟着当前排序状态走；列宽拖拽把手不受影响 */
function syncSortHead(box = document.getElementById('alarmTable')) {
  box?.querySelectorAll('th.vt-sort').forEach(th => {
    const on = !!sortKey && th.dataset.sort === sortKey;
    th.dataset.dir = on ? (sortDir > 0 ? 'asc' : 'desc') : '';
    th.setAttribute('aria-sort', on ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
  });
}

/**
 * 报警表指纹：任一列变了才需要重画表。
 * 为什么：拖控件、改属性、点选都会发 project:changed，而 2000 条报警整表重建要 2.7 秒（实测），
 * 不认指纹的话改一个字都要等 3 秒。
 */
function alarmFingerprint(all, vars) {
  return `#${vars.length}:${vars.map(v => v.name).join(',')}\u0003`
    + JSON.stringify(project.customAlarmLevels()) + '\u0003'
    + all.map(a => [a.id, a.name, a.variable, a.op, a.value, a.delaySec, a.level, a.enabled !== false, a.text]
      .join('\u0001')).join('\u0002');
}

/** 当前要显示的报警（套上筛选框，再按表头排序） */
function currentList() {
  const all = project.alarms();
  if (!filterText) return sortAlarms(all);
  const hit = all.filter(a => `${a.name} ${a.text} ${a.variable}`.toLowerCase().includes(filterText));
  return sortAlarms(hit);
}

function render() {
  const box = document.getElementById('alarmTable');
  if (!box) return;
  const all = project.alarms();
  const vars = project.variables();
  const count = document.getElementById('alarmCount');
  if (count) count.textContent = all.length ? ` (${all.length})` : '';

  const fp = alarmFingerprint(all, vars);
  if (fp === lastFp) { syncSelUI(); return; }   // 没变化不重画表，但勾选态还是要跟着（比如刚删完）
  lastFp = fp;
  if (skipPaint) { skipPaint = false; return; }   // 自己改的那一格已经是对的了

  // 勾选态按 id 记：报警不在了（单条 ✕ / CSV 整表替换 / 从服务器读回来）就从选择里剔掉
  const ids = new Set(all.map(a => a.id));
  [...selAlarms].forEach(id => { if (!ids.has(id)) selAlarms.delete(id); });
  syncSelUI();

  varMap = new Map(vars.map(v => [v.name, v]));
  if (!vl) buildTable(box);
  syncSortHead(box);          // 表头 ▲/▼ 跟当前排序状态对齐（新建表格后也要对一次）
  const empty = document.getElementById('alarmEmpty');
  const wrap = document.getElementById('alarmWrap');
  if (!all.length) {
    if (empty) empty.hidden = false;
    if (wrap) wrap.hidden = true;
    vl.setItems([]);
    return;
  }
  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;
  vl.setItems(currentList());
}

/** 筛选框：只换数据、不重建表（指纹没变，走 render 会被当成「没变化」直接返回） */
function applyFilter() {
  if (!vl) { lastFp = ''; render(); return; }
  vl.setItems(currentList());
  syncSelUI();          // 表头那个全选框算的是「当前筛出来的」，筛完要重算
  const scroller = document.getElementById('alarmTable');   // 表格框自己滚（见 buildTable）
  if (scroller) scroller.scrollTop = 0;    // 筛完回到顶部，不然停在老位置像没筛
}

/** 变量名的候选表：和属性面板/脚本面板同一套（varPick.js）——
 *  **输入框本身就是搜索框**，按**变量名**过滤（地址/类型只作行内备注），中文名照样能输能搜。
 *  ⚠ 只挂到输入框上、不预建任何候选 DOM：行是窗口化反复重建的，预建一份会跟着重建 N 次。 */
function attachRowVarPick(inp) {
  attachVarPick(inp, {
    list: () => project.variables(),
    note: (name) => (varMap.has(name) ? '' : '变量表里没有'),
  });
}

/** 表头 + 提示只建一次；行交给 vl 按窗口渲染（2000 条也只画几十行） */
function buildTable(box) {
  box.innerHTML = `
    <div id="alarmEmpty" hidden style="color:var(--text-2);font-size:12px;line-height:1.8">
      还没有报警。点「＋ 添加报警」开弹窗，填 <b>变量 + 比较 + 阈值</b>，内容里可写 <code>{变量名}</code>。<br>
      内容多的话，用「导出 CSV」在 Excel 里写好再导回来。</div>
    <div id="alarmWrap">
      <table class="vt alarm">
        <!-- 列宽写在这里（见 initColResize）：用户拖过表头边界之后，这 10 个 <col> 上就有宽度了 -->
        <colgroup>${Array.from({ length: 10 }, () => '<col>').join('')}</colgroup>
        <thead><tr>
          <th class="vt-sel"><input type="checkbox" id="alarmSelAll"
            title="全选 / 全不选（当前筛选出来的这些）；勾上几条后下面会出现「删除选中」"></th>
          <th class="vt-sort" data-sort="name" title="报警名（列表里区分用）。
点一下按名称升序排；再点一下降序；第三下取消（回到工程里的报警顺序）">名称</th>
          <th class="vt-sort" data-sort="variable" title="变量名：直接输入，或点开下拉选（按变量名搜，中文名也行；地址/类型只作行内备注）。
点这一格的表头可以按变量名排序（升序 → 降序 → 取消）">变量</th>
          <th title="点这一格开弹窗编辑内容：写多行、插 {变量名}、实时预览都在弹窗里">✎</th>
          <th title="点这一格**直接在里面改**（就地改，不开弹窗）；要写多行 / 插变量 / 看预览就点左边的 ✎">内容</th>
          <th>比较</th><th>阈值</th><th title="条件要持续多久才算报警">延时s</th>
          <th class="vt-sort" data-sort="level" title="点一下按级别排：提示 → 警告 → 报警 → 紧急（自定义级别按它的优先级）；
再点降序；第三下取消">级别</th><th>启用</th>
        </tr></thead>
        <tbody id="alarmRows"></tbody>
      </table>
      <!-- 变量名的候选表由 varPick.js 现画（浮在输入框下面，见 attachRowVarPick）：
           以前是原生 datalist，只按框里的字过滤、长相也控制不了；自己画能按
           按**变量名**搜（地址/类型只作行内备注），中文名照样输得进、搜得到。 -->
    </div>`;
  const rows = box.querySelector('#alarmRows');
  // 行是反复回收的，事件挂在 tbody 上一份就够（挂到行上会被一起回收掉）
  rows.addEventListener('change', onRowSelect);   // 勾选框（多选删除）
  rows.addEventListener('change', onRowChange);
  rows.addEventListener('click', onRowClick);
  rows.addEventListener('mousedown', onRowMouseDown);
  box.querySelector('#alarmSelAll').addEventListener('change', e => {
    // 全选/全不选只管**当前筛出来的这些**（筛选框里还有字的时候，选上被藏起来的行最让人意外）
    const shown = currentList();
    if (e.target.checked) shown.forEach(a => selAlarms.add(a.id));
    else shown.forEach(a => selAlarms.delete(a.id));
    syncSelUI();
    vl.refresh();          // 让可视区的勾选框立刻跟上（只重画看得见的那几十行）
  });
  vl = createVList({
    // ⚠ 滚动容器是 `.panel-body`（**跟变量面板同一套**）：表格框自己不再滚，
    //   横向滚动条才会落在按钮条下面 = 面板最底下（现场要求，见 layout.css 那段注释）。
    //   vlist 的 hostTop() 会把「筛选框占掉的高度」算进去，窗口化不会错位。
    scroller: box.closest('.panel-body') || box,
    host: rows,
    rowH: 28,
    keyOf: a => a.id,
    makePad: h => {                      // 表格里的占位也得是 <tr>，否则撑不起来
      const tr = document.createElement('tr');
      tr.className = 'vs-pad';
      tr.innerHTML = `<td colspan="10" style="height:${Math.round(h)}px;padding:0;border:0"></td>`;
      return tr;
    },
    renderRow: a => buildRow(a),
  });
  // 列宽可拖（现场要求：报警表列多，窄的列想窄一点、宽的就让它自己铺满）。
  // 「内容」列是**自动填充列**：它吃掉面板剩下的宽度（所以没把手）；其余列拖多少就是多少。
  // 这里不开 autoFit：这张表列多，本来就靠横向滚动看，没拖过时保持原来的 auto 布局。
  // 宽度存本机，见 js/editor/colResize.js
  initColResize(box.querySelector('table.vt.alarm'), {
    minWidths: [24, 60, 60, 22, 120, 44, 40, 34, 50, 30],
    storageKey: 'hmi-alarm-colw',
    flexCol: 4,                              // 4 = 内容列（勾选/名称/变量/✎/内容…）
  });
  // 表头点一下 = 排序（升序 → 降序 → 取消）；拖列宽的把手不算点表头（见 colResize 的 .col-grip）
  box.querySelectorAll('th.vt-sort').forEach(th => {
    th.addEventListener('click', e => {
      if (e.target.closest('.col-grip')) return;
      toggleSort(th.dataset.sort);
    });
  });
  syncSortHead(box);
}

function buildRow(a) {
  const known = varMap.has(a.variable || '');
  const editing = editingId === a.id;      // 这一条正在行内改内容（见 startInlineEdit）
  const tr = document.createElement('tr');
  tr.dataset.alarm = a.id;
  tr.className = selAlarms.has(a.id) ? 'sel' : '';   // 勾选的行整行淡蓝（和变量表一致）
  tr.innerHTML = `
    <td class="vt-sel"><input type="checkbox" class="al-sel" ${selAlarms.has(a.id) ? 'checked' : ''}
      title="勾上：和别的勾一起批量删（底部「删除选中」）"></td>
    <td><input data-k="name" class="mono" value="${esc(a.name)}"></td>
    <td><input data-k="variable" class="mono al-var${a.variable && !known ? ' bad' : ''}"
      value="${esc(a.variable || '')}" placeholder="（未选）"
      title="${a.variable && !known
    ? `⚠ 变量表里没有「${esc(a.variable)}」—— 这条报警永远不会触发（改名了就重选一个）`
    : '变量名：直接输入（中文也行），或点开下拉按变量名搜'}"></td>
    <td class="al-editcell"><button class="vt-edit al-editbtn"
      title="开弹窗编辑这条报警的内容：写多行、插 {变量名}、实时预览都在里面。
只改几个字的话不用点这里 —— 直接在右边的「内容」格里改就行。">✎</button></td>
    <td class="al-textcell">${editing ? inlineArea(a) : textCell(a)}</td>
    <td><select data-k="op">${OPS.map(o =>
      `<option value="${o.v}" ${a.op === o.v ? 'selected' : ''}>${o.t}</option>`).join('')}</select></td>
    <td><input data-k="value" class="mono" style="width:64px" value="${esc(a.value)}"></td>
    <td><input data-k="delaySec" type="number" min="0" max="600" step="1" style="width:52px" value="${Number(a.delaySec) || 0}"></td>
    <td><select data-k="level">${levelOptions(a.level)}</select></td>
    <td style="text-align:center"><input data-k="enabled" type="checkbox" ${a.enabled !== false ? 'checked' : ''}></td>`;
  // 「内容」前面那个 ✎ = 开弹窗（多行 / 插变量 / 预览）；**点内容格本身 = 就地改**（不开弹窗）。
  // 行尾不再摆 ✎/✕：编辑走这两条路，删除走最左边的勾选框 + 底部「删除选中」。
  attachRowVarPick(tr.querySelector('input[data-k="variable"]'));
  const ta = tr.querySelector('textarea.al-inline');
  if (ta) bindInlineArea(ta, a.id);
  return tr;
}

/** 行内文本框的事件（buildRow 建行时挂一次；startInlineEdit 手工换格子时也用它 —— 一处代码两条路） */
function bindInlineArea(ta, id) {
  // 边打边写进模型（**先不 commit**：每敲一个字记一步撤销，Ctrl+Z 就成摆设了），
  // 结束编辑时再一次性 commit = 一步撤销。
  ta.addEventListener('input', () => {
    const cur = project.getAlarm(id);
    if (cur) cur.text = ta.value;
  });
  ta.addEventListener('blur', () => { if (editingId === id) commitInlineEdit(); });
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); cancelInlineEdit(); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commitInlineEdit(); }
  });
}

/** 按报警 id 找那一行（**别用"第一行"**：窗口化列表重画后行节点会复用，顺序不能想当然） */
const rowOfAlarm = (id) => document.querySelector(`#alarmTable tr[data-alarm="${CSS.escape(id)}"]`);

/* ── 行内改「内容」（点内容格，不开弹窗）──────────────────────────────
   为什么要有：内容里改一两个字（错别字、上限值）走弹窗太绕；
   但弹窗不能被替代 —— 多行、插 {变量}、实时预览都在那边，所以两个入口：
   **点内容格 = 就地改**，点左边那个 ✎ = 开弹窗。 */
let editingId = null;      // 正在行内编辑内容的那条报警 id（行是窗口化回收的，状态不能放 DOM 上）
let editBackup = '';       // 进来时的原文（Esc 撤消用）

/** 「内容」格里的行内文本框：多行内容原样带进来（textarea 不会像 input 那样把换行吞掉） */
function inlineArea(a) {
  return `<textarea class="al-inline" spellcheck="false" rows="1"
    title="就地改内容：{变量名} 照旧会在报警时替换成当时的值，换行也在。Ctrl+Enter 或点别处保存，Esc 撤消。">${esc(a.text ?? '')}</textarea>`;
}

function startInlineEdit(id) {
  const a = project.getAlarm(id);
  if (!a) return;
  if (editingId && editingId !== id) commitInlineEdit();   // 另一条还没存 → 先存掉，一次只改一条
  editingId = id;
  editBackup = String(a.text ?? '');
  // ⚠ 直接换这一行的格子，**不要只 vl.refresh()**：窗口化列表是 requestAnimationFrame 才重画的，
  //   那时去抓 textarea 抓到的是 null（焦点也没了）—— 现场表现就是"点一下出来了但光标不在里面、
  //   按 Ctrl+Enter 没反应"（踩过）。
  const cell = rowOfAlarm(id)?.querySelector('.al-textcell');
  if (!cell) { vl?.refresh(); return; }      // 行不在可视区（正常点不到）
  cell.innerHTML = inlineArea(a);
  const ta = cell.querySelector('textarea.al-inline');
  if (!ta) return;
  bindInlineArea(ta, id);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);   // 光标落末尾：接着往后写最常见
}

/** 结束编辑并重画那一行；没改动就不记撤销步骤 */
function finishInlineEdit(commitIt) {
  const id = editingId;
  editingId = null;
  const a = id ? project.getAlarm(id) : null;
  const changed = !!a && String(a.text ?? '') !== editBackup;
  if (commitIt && a && changed) {
    skipPaint = true;                       // 这次 project:changed 不用重画表（下面自己把那一格换回去）
    try { project.commit('修改报警内容'); } finally { skipPaint = false; }
    bus.emit('alarms:changed', { raised: [], cleared: [] });   // 运行态/画布上的报警控件跟着换
  }
  // 同步把那一格换回文字（等 rAF 也行，但点完就想立刻看见它变回去）
  const cell = id ? rowOfAlarm(id)?.querySelector('.al-textcell') : null;
  if (a && cell) cell.innerHTML = textCell(a);
  else vl?.refresh();
}

function commitInlineEdit() { finishInlineEdit(true); }

/** Esc：把原文写回去（直接写、不 commit —— 等于没改过，撤销栈里不留痕） */
function cancelInlineEdit() {
  const a = editingId ? project.getAlarm(editingId) : null;
  if (a) a.text = editBackup;
  finishInlineEdit(false);
}

/** 表格里改了某个字段：写进工程，然后只重算这一行的「内容」格（⚠ 引用检查会跟着变） */
function onRowChange(e) {
  const inp = e.target.closest('input[data-k],select[data-k]');
  const tr = e.target.closest('tr[data-alarm]');
  if (!inp || !tr) return;
  const id = tr.dataset.alarm;
  const k = inp.dataset.k;
  let patch;
  if (k === 'enabled') patch = { enabled: inp.checked };
  else if (k === 'delaySec') {
    const n = Math.max(0, Math.min(600, Math.round(+inp.value || 0)));
    inp.value = n;
    patch = { delaySec: n };
  } else if (k === 'value') {
    // 阈值：能当数字就当数字存（比较时按数值走），否则存字符串
    const raw = String(inp.value || '').trim();
    patch = { value: raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw };
  } else patch = { [k]: inp.value };

  skipPaint = true;              // 这次 project:changed 不用重画表（DOM 已经改好了）
  try { project.updateAlarm(id, patch); } finally { skipPaint = false; }
  const a = project.getAlarm(id);
  // 「内容」格：直接用类名拿，别数下标 —— 前面加一列（勾选框 / ✎）这里就得跟着改一次，早晚忘
  const cell = tr.querySelector('.al-textcell');
  // 这一行正在行内改内容时不换成按钮（否则文本框被抽走，光标也跟着没了）
  if (a && cell) cell.innerHTML = editingId === id ? inlineArea(a) : textCell(a);
  // 变量格：名字对不对得上变量表，当场标出来（对不上 = 这条报警永远不会触发，
  // 光看格子里那几个字看不出来 —— 中文名手打错一个字就是这种）
  if (k === 'variable') {
    const nm = String(inp.value || '').trim();
    const known = varMap.has(nm);
    inp.classList.toggle('bad', !!nm && !known);
    inp.title = !nm ? '变量名：直接输入（中文也行），或点开下拉按关键字选'
      : known ? `变量表里有「${nm}」（${varMap.get(nm)?.type || ''}）`
        : `⚠ 变量表里没有「${nm}」—— 这条报警永远不会触发（改名了就重选一个）`;
  }
}

function onRowClick(e) {
  const tr = e.target.closest('tr[data-alarm]');
  if (!tr) return;
  const id = tr.dataset.alarm;
  // 内容前面那个 ✎：**开弹窗**（多行 / 插变量 / 预览）。手里还有没存完的就地改 → 先存下，
  // 否则弹窗里看到的是旧内容，回来一存就把就地改的那几个字盖掉了。
  if (e.target.closest('.al-editbtn')) {
    if (editingId) commitInlineEdit();
    openAlarmEditor(id);
    return;
  }
  // 点内容格：**就地改**（不开弹窗，改一两个字不用来回弹）
  if (e.target.closest('.al-text')) startInlineEdit(id);
}

/** ✎ 按下时别把焦点从行内文本框抢走（抢走就先触发 blur 保存 → 表格重画 → 按钮被换掉，click 可能落空）。
 *  只挡 mousedown 的默认行为（不移动焦点），click 照旧触发。 */
function onRowMouseDown(e) {
  if (editingId && e.target.closest('.al-editbtn')) e.preventDefault();
}

/* ── 多选（勾选 → 批量删）────────────────────────────────────────────
   为什么要有：报警表常常是 CSV 一次导进来几百条，里面几条不要的，
   以前只能一条一条点 ✕（还每条弹一次确认）。勾选态只活在 **id 集合** 里，
   行是窗口化回收的，勾选状态不能挂在 DOM 上。 */
function onRowSelect(e) {
  const cb = e.target.closest('input.al-sel');
  if (!cb) return;
  const tr = e.target.closest('tr[data-alarm]');
  if (!tr) return;
  if (cb.checked) selAlarms.add(tr.dataset.alarm);
  else selAlarms.delete(tr.dataset.alarm);
  tr.classList.toggle('sel', cb.checked);
  syncSelUI();
}

/** 表头全选框 + 底部「删除选中」按钮，跟着勾选态走 */
function syncSelUI() {
  const all = document.getElementById('alarmSelAll');
  if (all) {
    const shown = currentList();
    all.checked = !!shown.length && shown.every(a => selAlarms.has(a.id));
  }
  const btn = document.getElementById('btnDelAlarms');
  if (btn) {
    btn.hidden = selAlarms.size === 0;
    btn.textContent = `删除选中 (${selAlarms.size})`;
  }
}

/** 删除勾选的报警：整批一次提交（一步 Ctrl+Z 撤销） */
function deleteSelected() {
  const ids = [...selAlarms];
  if (!ids.length) return;
  if (!confirm(`删除勾选的 ${ids.length} 条报警？\n（删错了可以 Ctrl+Z 一次撤销回来）`)) return;
  const gone = project.deleteAlarms(ids);
  ids.forEach(id => selAlarms.delete(id));
  bus.emit('alarms:changed', { raised: [], cleared: [] });   // 运行态/画布上的报警控件立刻反映
  syncSelUI();
  if (gone) flashMsg(`已删除 ${gone} 条报警（Ctrl+Z 可撤销）`);
}

/** 面板底部一行小提示，几秒后自己消失（和变量面板一个套路） */
let msgTimer = null;
function flashMsg(text) {
  const el = document.getElementById('alarmMsg');
  if (!el) return;
  el.textContent = text;
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

/** 表格里的「内容」格：只显示开头。**点一下就地改**（那一格变成文本框，不开弹窗）；
 *  要写多行 / 插变量 / 看预览，点左边那个 ✎ 开弹窗。 */
function textCell(a) {
  const t = String(a.text ?? '');
  const bad = missingRefs(t);
  const flag = bad.length ? `<span class="al-flag" title="⚠ 这些变量不存在：${esc(bad.join('、'))}">⚠</span>` : '';
  const tip = bad.length ? `⚠ 这些变量不存在：${bad.join('、')}` : describeRefs(t);
  if (!t.trim()) {
    return `<button type="button" class="al-text empty"
      title="点一下就地写内容（就在这一格里写）；要写多行 / 插变量 / 看预览就点左边的 ✎ 开弹窗">（点此填写内容）</button>`;
  }
  // {变量名} 高亮成蓝色，其余原样显示（表格里不做转义显示，避免 \n 之类看不清）
  const html = esc(t).replace(RE_REF, '<span class="al-ref">{$1}</span>').replace(/\r?\n/g, ' ⏎ ');
  return `<button type="button" class="al-text"
    title="${esc(tip)}\n—— 点一下就地改（要写多行 / 插变量 / 看预览就点左边的 ✎）">${flag}${html}</button>`;
}

/** 内容里引用的变量中，不存在的那些 */
function missingRefs(text) {
  const names = [...new Set([...String(text || '').matchAll(RE_REF)].map(m => m[1]))];
  return names.filter(n => !varMap.has(n));
}
function describeRefs(text) {
  const names = [...new Set([...String(text || '').matchAll(RE_REF)].map(m => m[1]))];
  if (!names.length) return '内容里可以写 {变量名}，触发时替换成当时的值';
  const missing = names.filter(n => !varMap.has(n));
  return missing.length ? `⚠ 这些变量不存在：${missing.join('、')}` : `引用了：${names.join('、')}（触发时替换成当时的值）`;
}

/* ══ 内容弹窗编辑 ══════════════════════════════════════════════════ */

/** 预览：变量按变量表里的初值代入（编辑态没有实时值，这里只是让人看清写出来长什么样） */
function previewOf(tpl) {
  const vars = project.variables();
  return String(tpl ?? '').replace(RE_REF, (m, name) => {
    const v = vars.find(x => x.name === name);
    if (!v) return m;
    const n = Number(v.value);
    return v.type === 'string' ? String(v.value ?? '') : (Number.isFinite(n) ? String(Number(n.toPrecision(6))) : String(v.value ?? '--'));
  });
}

function levelOptions(selected) {
  const id = levelOf(selected).v;
  return alarmLevels().map(l => `<option value="${esc(l.v)}"${id === l.v ? ' selected' : ''}>${esc(l.t)}</option>`).join('');
}

const ADD_LEVEL = '__addLevel';
const editorLevelOptions = selected => levelOptions(selected) + `<option value="${ADD_LEVEL}">＋ 新增级别…</option>`;
const newLevel = () => ({ v: genId('alv'), t: '', color: '#7c3aed', rank: 2 });

function levelFields(level) {
  return {
    name: `<input class="f-input" data-level-name value="${esc(level.t)}" maxlength="40" aria-label="级别名称">`,
    color: `<input class="f-color" data-level-color type="color" value="${esc(level.color)}" aria-label="级别颜色">`,
    rank: `<select class="f-select" data-level-rank aria-label="优先级">${ALARM_LEVELS.map(l =>
      `<option value="${l.rank}"${l.rank === level.rank ? ' selected' : ''}>${l.t}</option>`).join('')}</select>`,
  };
}

function readLevelFields(el, id, names, error) {
  const input = el.querySelector('[data-level-name]');
  const t = input.value.trim();
  const name = t.toLowerCase();
  if (!name || names.has(name)) {
    error.textContent = name ? '级别名称已存在' : '请输入级别名称';
    input.focus();
    return null;
  }
  names.add(name);
  return {
    v: id, t, color: el.querySelector('[data-level-color]').value,
    rank: Number(el.querySelector('[data-level-rank]').value),
  };
}

const levelNames = levels => new Set(levels.flatMap(l => [l.v.toLowerCase(), l.t.toLowerCase()]));

function openAlarmLevels() {
  const row = level => {
    const fields = levelFields(level);
    return `<tr data-level-id="${esc(level.v)}"><td>${fields.name}</td><td>${fields.color}</td><td>${fields.rank}</td></tr>`;
  };
  showDialog({
    title: '报警级别管理',
    okText: '保存',
    body: `<table class="al-levels">
      <thead><tr><th scope="col">级别名称</th><th scope="col">颜色</th><th scope="col">优先级</th></tr></thead>
      <tbody>${ALARM_LEVELS.map(level =>
        `<tr><td>${level.t}</td><td><span class="al-level-swatch" style="--level-color:${level.color}"></span></td><td>${level.t}</td></tr>`).join('')}</tbody>
      <tbody id="alarmLevelDraft">${project.customAlarmLevels().map(row).join('')}</tbody>
    </table>
    <div class="al-level-actions">
      <button type="button" class="tb-btn" id="btnAddAlarmLevel">＋ 添加级别</button>
      <span id="alarmLevelError" class="al-level-error" role="status"></span>
    </div>`,
    onOk: () => {
      const names = levelNames(ALARM_LEVELS);
      const levels = [];
      const error = document.getElementById('alarmLevelError');
      for (const tr of document.querySelectorAll('#alarmLevelDraft tr')) {
        const level = readLevelFields(tr, tr.dataset.levelId, names, error);
        if (!level) return false;
        levels.push(level);
      }
      project.setCustomAlarmLevels(levels);
      return true;
    },
  });
  const draft = document.getElementById('alarmLevelDraft');
  document.getElementById('btnAddAlarmLevel').onclick = () => {
    draft.insertAdjacentHTML('beforeend', row(newLevel()));
    draft.lastElementChild.querySelector('[data-level-name]').focus();
  };
}

/** 添加或编辑一条报警，条件和内容在同一个弹窗中保存。 */
export function openAlarmEditor(id) {
  const editing = !!id;
  const a = editing ? project.getAlarm(id) : null;
  if (editing && !a) return;
  const vars = project.variables();
  const cur = a ? { ...a } : {
    name: `报警${project.alarms().length + 1}`, variable: vars[0]?.name || '',
    op: '>=', value: 1, level: 'alarm', delaySec: 0, enabled: true, text: '',
  };
  const fields = levelFields(newLevel());
  const chipHTML = (v) => `<button type="button" class="dlg-chip" data-var="${esc(v.name)}"
    title="${esc(v.name)}（${esc(v.type)}${v.address ? ' · ' + esc(v.address) : ''}）${v.type === 'string' ? '' : ' 初值 ' + esc(v.value)}">{${esc(v.name)}}</button>`;
  showDialog({
    title: editing ? `编辑报警 — ${a.name || '未命名'}` : '添加报警',
    wide: true,
    okText: editing ? '保存' : '添加',
    body: `
      <div class="al-form">
        <label class="al-f"><span>名称</span>
          <input id="alName" class="f-input" value="${esc(cur.name)}" placeholder="如 转速过高"></label>
        <label class="al-f"><span>级别</span>
          <select id="alLevel" class="f-input">${editorLevelOptions(cur.level)}</select></label>
        <label class="al-f"><span>变量</span>
          <span class="vf"><input id="alVariable" class="f-input vf-inp" value="${esc(cur.variable || '')}"
            placeholder="输入变量名（可搜），或点开下拉选"
            title="输入变量名（按名称搜），或点开下拉选">
            <button type="button" class="vf-clear" tabindex="-1" title="清空"
              ${cur.variable ? '' : 'hidden'}>✕</button></span></label>
        <label class="al-f"><span>比较</span>
          <select id="alOp" class="f-input">${OPS.map(o =>
            `<option value="${o.v}" ${cur.op === o.v ? 'selected' : ''}>${o.t}</option>`).join('')}</select></label>
        <label class="al-f"><span>阈值</span>
          <input id="alValue" class="f-input" value="${esc(cur.value)}" placeholder="数值或文字"></label>
        <label class="al-f"><span>延时（秒）</span>
          <input id="alDelaySec" type="number" min="0" max="600" step="1" class="f-input" value="${Number(cur.delaySec) || 0}"></label>
        <label class="al-f chk">
          <input id="alEnabled" type="checkbox" class="f-check" ${cur.enabled !== false ? 'checked' : ''}><span>启用这条报警</span></label>
      </div>
      <div id="alarmLevelInline" class="al-level-inline" hidden>
        <div class="al-level-fields">
          <label class="al-f"><span>级别名称</span>${fields.name}</label>
          <label class="al-f"><span>颜色</span>${fields.color}</label>
          <label class="al-f"><span>优先级</span>${fields.rank}</label>
        </div>
        <div class="al-level-actions">
          <button id="btnUseAlarmLevel" class="tb-btn" type="button">添加并选用</button>
          <button id="btnCancelAlarmLevel" class="tb-btn" type="button">取消新增</button>
          <span id="alarmLevelInlineError" class="al-level-error" role="status"></span>
        </div>
      </div>
      <div class="al-cond" id="alarmCond"></div>
      <textarea id="alarmTextArea" class="dlg-area" spellcheck="false"
        placeholder="报警内容，如：主轴转速过高：{rSpeed} m/min（上限 3000）">${esc(cur.text)}</textarea>
      <div class="dlg-chips" id="alarmVarChips"></div>
      <div class="dlg-prev" id="alarmPrev"></div>`,
    onOk: () => {
      if (!document.getElementById('alarmLevelInline').hidden) {
        document.getElementById('alarmLevelInlineError').textContent = '请先添加级别或取消新增';
        return false;
      }
      const val = (elId) => document.getElementById(elId).value;
      const rawVal = val('alValue').trim();
      const patch = {
        name: val('alName').trim() || `报警${project.alarms().length + (editing ? 0 : 1)}`,
        variable: val('alVariable'),
        op: val('alOp'),
        // 阈值：能当数字就当数字存（比较时按数值走），否则按字符串存
        value: rawVal !== '' && !Number.isNaN(Number(rawVal)) ? Number(rawVal) : rawVal,
        delaySec: Math.max(0, Math.min(600, Math.round(Number(val('alDelaySec')) || 0))),
        level: val('alLevel'),
        enabled: document.getElementById('alEnabled').checked,
        text: document.getElementById('alarmTextArea').value,
      };
      if (!patch.variable && !confirm('没选变量，这条报警永远不会触发。还是要保存吗？')) return false;
      // 名字不在变量表里也拦一下：这种报警永远不会触发，光看框里那两个字看不出来（改名/打错都常见）
      if (patch.variable && !project.variables().some(v => v.name === patch.variable)
        && !confirm(`变量表里没有「${patch.variable}」，这条报警永远不会触发。还是要保存吗？`)) return false;
      if (editing) project.updateAlarm(id, patch);
      else project.addAlarm(patch);
      bus.emit('alarms:changed', { raised: [], cleared: [] });   // 运行态/画布上的报警控件立刻反映
      return true;
    },
  });

  const ta = document.getElementById('alarmTextArea');
  const prev = document.getElementById('alarmPrev');
  const cond = document.getElementById('alarmCond');
  const $ = (elId) => document.getElementById(elId);

  /** 条件那行 + 内容预览：改哪个字段都跟着变 */
  const sync = () => {
    const varName = $('alVariable').value;
    const op = opText($('alOp').value);
    const v = $('alValue').value.trim();
    const delay = Number($('alDelaySec').value) || 0;
    const lv = levelOf($('alLevel').value).t;
    cond.innerHTML = varName
      ? `条件：<b>${esc(varName)} ${esc(op)} ${esc(v === '' ? '(空)' : v)}</b> 成立`
        + (delay ? ` 并持续 <b>${delay}s</b>` : '') + ` 时报这条（${esc(lv)}级）`
      : '<span class="bad">⚠ 还没选变量 —— 这条报警永远不会触发</span>';

    const t = ta.value;
    const bad = missingRefs(t, vars);
    const out = previewOf(t);
    prev.innerHTML = `<span class="pv-tag">预览（变量按初值代入）：</span>${t.trim()
      ? esc(out).replace(/\r?\n/g, '<br>')
      : '<span class="pv-tag">（还没写内容，报警时会显示报警名）</span>'}`
      + (bad.length ? `<div class="pv-bad">⚠ 这些变量不存在：${esc(bad.join('、'))} —— 报警时会原样显示 {…}</div>` : '');
  };
  const levelSelect = $('alLevel');
  const inline = $('alarmLevelInline');
  const newName = inline.querySelector('[data-level-name]');
  const levelError = $('alarmLevelInlineError');
  let selectedLevel = levelSelect.value;
  const closeLevelDraft = () => {
    inline.hidden = true;
    newName.value = '';
    levelError.textContent = '';
  };
  levelSelect.addEventListener('change', () => {
    if (levelSelect.value === ADD_LEVEL) {
      levelSelect.value = selectedLevel;
      inline.hidden = false;
      newName.focus();
    } else {
      selectedLevel = levelSelect.value;
      closeLevelDraft();
    }
  });
  $('btnUseAlarmLevel').onclick = () => {
    const level = readLevelFields(inline, genId('alv'), levelNames(alarmLevels()), levelError);
    if (!level) return;
    project.setCustomAlarmLevels([...project.customAlarmLevels(), level]);
    selectedLevel = level.v;
    levelSelect.innerHTML = editorLevelOptions(selectedLevel);
    closeLevelDraft();
    levelSelect.focus();
    sync();
  };
  $('btnCancelAlarmLevel').onclick = () => {
    closeLevelDraft();
    levelSelect.focus();
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.getElementById('dlgOk').click(); }
  });
  ['alVariable', 'alOp', 'alValue', 'alDelaySec', 'alLevel', 'alName'].forEach(elId => {
    $(elId).addEventListener('input', sync);
    $(elId).addEventListener('change', sync);
  });
  prev.addEventListener('click', e => e.stopPropagation());

  /* ── 变量格：和属性面板/报警表行同一套（varPick.js）——
        框本身就是搜索框：点进去看**全量**候选、打字**只按变量名**过滤（中文名照样输得进、搜得到），
        ↑↓ 选、回车或点一行确认、Esc 收起。以前这里是「下拉 + 单独一个搜索框」，
        变量一多就被截成前 50 个（排后面的中文名根本选不到）。 ── */
  const varInput = $('alVariable');
  const markVar = () => {
    const nm = varInput.value.trim();
    const known = !nm || project.variables().some(v => v.name === nm);
    varInput.classList.toggle('bad', !known);
    varInput.title = !nm ? '输入变量名（按名称搜），或点开下拉选'
      : known ? `变量表里有「${nm}」`
        : `⚠ 变量表里没有「${nm}」—— 这条报警永远不会触发（改名了就重选一个）`;
    const btn = varInput.parentElement?.querySelector('.vf-clear');
    if (btn) btn.hidden = !nm;
  };
  attachVarPick(varInput, {
    // 现查：变量表随时会变（导入、改名、删除），别把打开弹窗那一刻的快照用到底
    list: () => project.variables(),
    note: (n) => (project.variables().some(v => v.name === n) ? '' : '变量表里没有'),
  });
  varInput.addEventListener('input', () => { markVar(); renderChips(); });
  varInput.parentElement?.querySelector('.vf-clear')?.addEventListener('click', () => {
    varInput.value = '';
    markVar();
    sync();
    varInput.focus();
  });
  markVar();

  /* ── 「插入变量」按钮：变量一多这里会摊成好几行，把弹窗顶得老高 ──
     所以默认只放 CHIP_MAX 个（正好一行；上面变量格里打了字就只放匹配的），
     剩下的收进「＋还有 N 个…」，点开还能「收起」。 */
  const CHIP_MAX = 6;
  const chipBox = $('alarmVarChips');
  let chipsOpen = false;
  const chipMatches = () => {
    // 跟着上面变量格里的字过滤（一个搜索框就够，不用两个）——
    // ⚠ 但只在"还没打成完整变量名"时才过滤：否则编辑一条绑着 rSpeed 的报警时，
    //   变量格里天生就写着 rSpeed，一点开就把其它插入按钮全筛没了（踩过）。
    const q = varInput.value.trim();
    const isFullName = !!q && vars.some(v => v.name === q);
    if (!q || isFullName) return vars;
    return vars.filter(v => String(v.name || '').toLowerCase().includes(q.toLowerCase()));
  };
  function renderChips() {
    const hit = chipMatches();
    // 只有"正在筛"（格子里是半截名字）才收起多余按钮；格子写着完整变量名时按没筛处理
    const q = varInput.value.trim();
    const filtering = !!q && hit.length !== vars.length;
    const folded = !filtering && !chipsOpen && hit.length > CHIP_MAX;   // 多出来的收起来
    const show = folded ? hit.slice(0, CHIP_MAX) : hit;
    chipBox.innerHTML = '<span class="dlg-chips-label">点一下插入变量：</span>'
      + (show.length ? show.map(chipHTML).join('') : '<span class="dlg-chips-label">（没有匹配的变量）</span>')
      + (folded ? `<button type="button" class="dlg-chip more" id="alChipMore">＋ 还有 ${hit.length - CHIP_MAX} 个…</button>` : '')
      + (chipsOpen && hit.length > CHIP_MAX && !filtering ? '<button type="button" class="dlg-chip more" id="alChipLess">收起</button>' : '');
  }
  chipBox.addEventListener('click', e => {
    const more = e.target.closest('#alChipMore');
    if (more) { chipsOpen = true; renderChips(); return; }
    if (e.target.closest('#alChipLess')) { chipsOpen = false; renderChips(); return; }
    const chip = e.target.closest('.dlg-chip[data-var]');
    if (!chip) return;
    const snip = `{${chip.dataset.var}}`;
    const s = ta.selectionStart ?? ta.value.length;
    const e2 = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + snip + ta.value.slice(e2);
    ta.selectionStart = ta.selectionEnd = s + snip.length;
    ta.focus();
    sync();
  });
  renderChips();
  sync();
  // 新添加：光标落在名称上直接开打；编辑已有：跳到内容末尾（改内容是最常见的操作）
  setTimeout(() => {
    if (editing) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    else { $('alName').focus(); $('alName').select(); }
  }, 30);
}

const opText = (op) => (OPS.find(o => o.v === op) || { t: '≥' }).t;

/* ══ CSV 导入 / 导出 ══════════════════════════════════════════════ */

function exportCsv() {
  const list = project.alarms();
  if (!list.length) { alert('还没有报警，先加一条（或在运行页面画面上放个报警控件）再导出。'); return; }
  // 桌面窗口里弹「另存为」（自己选目录），浏览器里还是落到「下载」文件夹 —— 见 csv.js 的 saveTextFile
  exportText(`${project.data.meta.name || 'hmi-project'}-报警表.csv`, alarmsToCsv(list, alarmLevels()), { kind: 'csv' });
}

/** 导入并回报结果；解析失败返回 null */
function applyImport(text, mode) {
  let res;
  try {
    res = importAlarmsCsv(text, { mode, levels: alarmLevels() });
  } catch (err) {
    alert(`CSV 解析失败：${err && err.message ? err.message : err}`);
    return null;
  }
  if (!res.total && res.errors.length) {
    alert(`一行都没读进来：\n${res.errors.slice(0, 6).join('\n')}`);
    return null;
  }
  const head = mode === 'replace' ? '整表替换完成' : '导入完成';
  const msg = `${head}：共读入 ${res.total} 行 → 新增 ${res.added} 条，更新 ${res.updated} 条`
    + (mode === 'replace' ? `\n（原来的报警已全部清掉，现在共 ${project.alarms().length} 条）` : `\n（现在共 ${project.alarms().length} 条）`)
    + (res.errors.length ? `\n\n跳过 ${res.errors.length} 行：\n${res.errors.slice(0, 5).join('\n')}` : '')
    + (res.warnings.length ? `\n\n注意 ${res.warnings.length} 条：\n${res.warnings.slice(0, 5).join('\n')}` : '');
  bus.emit('alarms:changed', { raised: [], cleared: [] });
  alert(msg);
  return res.total;
}

function openCsvImport() {
  showDialog({
    title: '导入报警 CSV',
    wide: true,
    okText: '导入',
    body: `
      <textarea id="alarmCsvText" class="dlg-area fixed" spellcheck="false" title="可粘贴 CSV。表头可省略，级别可用英文，启用可填 1 或 0。"
        placeholder="名称,变量,比较,阈值,延时s,级别,内容,启用&#10;转速过高,rSpeed,>=,3000,0,报警,主轴转速过高：{rSpeed} m/min（上限 3000）,是"></textarea>
      <div class="dlg-chips">
        <button type="button" class="tb-btn sm" id="alarmCsvPickBtn">选择 CSV 文件…</button>
        <input type="file" id="alarmCsvPick" accept=".csv,text/csv" hidden>
        <span id="alarmCsvPickInfo" class="dlg-chips-label"></span>
      </div>
      <div class="dlg-chips">
        <label class="dlg-radio"><input type="radio" name="alarmImpMode" value="upsert" checked> 同名更新，新名称追加</label>
        <label class="dlg-radio"><input type="radio" name="alarmImpMode" value="replace"> 清空后导入（替换全部）</label>
        <label class="dlg-radio"><input type="radio" name="alarmImpMode" value="append"> 全部当新报警追加</label>
      </div>`,
    onOk: () => {
      const txt = document.getElementById('alarmCsvText').value;
      if (!txt.trim()) {
        alert('还没内容：可以粘贴 CSV 文本，或点「选择 CSV 文件…」。');
        return false;   // 不关窗，让人接着贴
      }
      const mode = document.querySelector('input[name="alarmImpMode"]:checked')?.value || 'upsert';
      if (mode === 'replace' && project.alarms().length
        && !confirm(`会先清掉现有的 ${project.alarms().length} 条报警，再导入。继续？`)) return false;
      applyImport(txt, mode);
      return true;
    },
  });

  const pick = document.getElementById('alarmCsvPick');
  document.getElementById('alarmCsvPickBtn').addEventListener('click', () => { pick.value = ''; pick.click(); });
  pick.addEventListener('change', () => {
    const f = pick.files[0];
    if (!f) return;
    // 同样不能写死 UTF-8：Excel 存的 CSV 在中文 Windows 上是 GBK
    readTextFile(f).then(text => {
      document.getElementById('alarmCsvText').value = text;
      const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
      document.getElementById('alarmCsvPickInfo').textContent = `已读入 ${f.name}（约 ${lines} 行），点「导入」写进工程`;
    }).catch(e => alert(`读文件失败：${e && e.message ? e.message : e}`));
  });
}
