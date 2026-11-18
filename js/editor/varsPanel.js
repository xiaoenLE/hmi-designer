/**
 * varsPanel.js — 变量表（名称 / 类型 / PLC 地址 / 保持 / 初值）
 *   地址列为对接 Python 后端时定位寄存器的占位（如 %MW96、%MD48、%IX0）；
 *   **地址留空 = 内部变量**（HMI 自己算、不下发 PLC），勾上「保持」就是**掉电保持**：
 *   值由后端落盘（server/data/retain_vars.json），重启/断电后还在，控件和脚本全局可用。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { backend } from '../api/backend.js';
import { varsToCsv, importCsv, exportText, readTextFile } from '../core/csv.js';
import { isOpcAddr, normNodeId, describeNodeId, isArrayType, elemTypeOf, parseArrayText, normAddr, isBitAddr,
  arrayLenOf, statusNote } from '../core/utils.js';
import { createVList } from '../core/vlist.js';
import { initColResize } from './colResize.js';
import { showDialog } from './toolbar.js';

// 只要 9 种标量（BOOL/INT/UINT/DINT/UDINT/REAL/LREAL/STRING/WSTRING）；数组不在这里：
// **不再提供数组类型**：数组走「导入 OPC UA 时自动展开成单个元素变量」——
// （arrw(13) → arrw[1]…arrw[13]），变量表里全是普通标量 ——
// CODESYS 的数组元素本来就是独立节点，Modbus 侧元素就是连续寄存器，两端同一套规则。
// 老工程里已经写成 int[] 的变量照旧能用（下拉会把当前值补回去，不会被悄悄改成 bool），
// 也可以用「展开数组」按钮拆成元素。
// ⚠ STRING 和 WSTRING 分开：UA 侧都是字符串，但 Modbus 侧占位不同
//   （STRING 2 字符 1 个寄存器、WSTRING 1 个宽字符 1 个寄存器），混用会把字数算错。
const TYPES = [
  { v: 'bool', t: 'bool' }, { v: 'int', t: 'int' }, { v: 'uint', t: 'uint' },
  { v: 'dint', t: 'dint' }, { v: 'udint', t: 'udint' }, { v: 'real', t: 'real' },
  { v: 'lreal', t: 'lreal' }, { v: 'string', t: 'string' }, { v: 'wstring', t: 'wstring 宽字符串' },
];

/** 类型下拉的选项。老工程里已经写成 int[] 这种的，**必须把当前值补回选项里**，
 *  否则浏览器会落到第一项（bool），看着就像"类型被改掉了"。 */
function typeOptions(cur) {
  const list = (!cur || TYPES.some(t => t.v === cur))
    ? TYPES
    : [{ v: cur, t: `${cur}（老工程保留，可点「展开数组」拆开）` }, ...TYPES];
  return list.map(t2 => `<option value="${t2.v}" ${cur === t2.v ? 'selected' : ''}>${t2.t}</option>`).join('');
}
// 地址怎么解析、怎么写成人话，全在 js/core/addrMap.js（**可替换**：换控制器只改那一个文件）。
// 变量表内部照旧叫 describeAddress。
import { describeAddr as describeAddress } from '../core/addrMap.js';
export { describeAddress };

/** 地址格的 title：地址说明 + 「写法和当前协议对不上」的提醒。
 *  协议看的是**当前选的那个**（backend.isOpcua()），不看这条地址长得像什么 ——
 *  切到 Modbus 后整表就该按 Modbus 来说话。 */
function addrTitle(addr, v, auto) {
  if (!addr) {
    // 地址留空 = 内部变量：说清它是"HMI 自己算的、不下发 PLC"，以及「保持」管什么
    return '地址留空 = **内部变量**：值只存在 HMI 里（控件动作 / 脚本 hmi.set / 变量监控里手改），'
      + '不读也不写 PLC —— 拿它当计数器、班次、当前操作员这类"HMI 自己的状态"用。'
      + '\n勾上「保持」= 掉电保持（存后端，重启/断电后还在）；不勾就只在内存里，重启回初值。';
  }
  const t = describeAddress(addr, v?.type, auto);
  const uaMode = backend.isOpcua();
  const opc = isOpcAddr(addr);
  if (opc === uaMode) return t;
  return t + `\n⚠ 当前协议是 ${uaMode ? 'OPC UA' : 'Modbus'}，但这个地址是`
    + `${opc ? ' OPC UA NodeId' : ' Modbus 寄存器'} 写法 —— 这样采不到（改地址，或在「🔌 PLC」里换协议）`;
}

export function initVarsPanel() {
  loadOpenGroups();               // 折叠组的展开状态（上次开着的还开着）
  document.getElementById('btnAddVar').addEventListener('click', () => project.addVariable());
  // 搜索框：按 名称/地址/类型 过滤（变量上千时最常用的入口，和报警/脚本面板一个位置）
  document.getElementById('varFilter')?.addEventListener('input', e => {
    filterText = e.target.value.trim().toLowerCase();
    render();
  });
  document.getElementById('btnDelVars')?.addEventListener('click', () => deleteVars([...selVars]));
  document.getElementById('btnExpandArr')?.addEventListener('click', () => expandSelectedArrays());
  // 查找/替换（在哪用到）：动态 import，别让变量面板的启动路径依赖这个对话框
  document.getElementById('btnFindVar')?.addEventListener('click', () => {
    import('./varSearch.js').then(m => m.openVarSearch()).catch(e => alert('打开查找失败：' + (e?.message || e)));
  });

  // 变量表（名称/类型/地址）一变就把映射重新下发给后端。
  // 以前只在「进运行态」和「连 PLC」时下发：连着 PLC 改地址、加变量都不生效，
  // 后端照旧按老地址读写，改了像没改 —— 现场最难查的一类问题。
  bus.on('project:changed', () => {
    if (backend.expectsServer()) backend.syncVarTable(project.variables());
    // ⚠ 变量表**没变**就别整表重绘：拖控件、改属性、点选都会发 project:changed，
    //   1000 个变量时整表重绘要 70~140ms，拖一下画布就像幻灯片（实测过）。
    const fp = varFingerprint();
    if (fp === lastFp) return;
    lastFp = fp;
    render();
  });

  // 导出 CSV（带 BOM，Excel 直接打开不乱码）。桌面窗口里弹「另存为」，浏览器里是下载
  document.getElementById('btnExportVars').addEventListener('click', () => {
    exportText(`${project.data.meta.name || 'hmi-project'}-变量表.csv`, varsToCsv(project.variables()), { kind: 'csv' });
  });

  // 导入 CSV：按「名称」upsert（同名更新，不存在新增）
  const fi = document.getElementById('varCsvFile');
  fi.addEventListener('change', () => {
    const f = fi.files[0];
    if (!f) return;
    // ⚠ 不能 readAsText(f,'utf-8')：Excel 在中文 Windows 上存的是 GBK，按 UTF-8 读中文全乱。
    readTextFile(f).then(text => {
      const res = importCsv(text);
      const msg = `导入完成：新增 ${res.added} 个，更新 ${res.updated} 个`
        + (res.errors.length ? `\n跳过 ${res.errors.length} 行：\n${res.errors.slice(0, 5).join('\n')}` : '');
      alert(msg);
    }).catch(e => alert(`读文件失败：${e && e.message ? e.message : e}`));
  });
  document.getElementById('btnImportVars').addEventListener('click', () => {
    fi.value = '';   // 允许重复选同一个文件
    fi.click();
  });

  bus.on('project:changed', render);
  // 换了协议（Modbus ↔ OPC UA）→ 地址提示/占位、「从 OPC UA 导入…」按钮都要跟着换，
  // 变量表指纹没变，光靠 project:changed 是不会重画的。
  bus.on('plc:protocol', render);
  render();
}

/** 字符串默认占多少个字符（2 字符 1 个寄存器）；数组默认几个元素 */
const STR_LEN_DEFAULT = 10;
const ARR_LEN_DEFAULT = 10;
let selVars = new Set();          // 变量表里勾选了哪些（按变量名记）
let lastFp = '';                  // 上一次画出来的变量表指纹（没变就不重绘）

/** 变量表指纹：名称/类型/地址/长度/初值/保持 任一变了才需要重绘（**搜索词**变了也要重画） */
function varFingerprint() {
  return `q:${filterText}\u0003` + project.variables()
    .map(v => `${v.name}\u0001${v.type}\u0001${v.address || ''}\u0001${v.len || 0}\u0001${v.value}\u0001${v.retain ? 1 : 0}`)
    .join('\u0002');
}
function autoLen(v) {
  const t = String(v.type || '').toLowerCase();
  if (isArrayType(t)) return v.len || ARR_LEN_DEFAULT;      // 数组：元素个数
  if (t === 'string' || t === 'wstring') return v.len || STR_LEN_DEFAULT;   // 字符数
  if (t === 'lreal') return 4;
  if (t === 'real' || t === 'dint' || t === 'udint') return 2;
  return 1;
}

/* ── 变量折叠（两级）──────────────────────────────────────────────
   ① 数组级：「展开数组」「从 OPC UA 导入」会把 arrw 拆成 arrw[1]…arrw[13]，
      十几条挤在一起别的变量就找不着了 → 收成一行表头。
   ② 前缀级：从 OPC UA/XML 导入的变量名是**带点的符号路径**（GVL.a、GVL.arrw[1]、
      PLC_PRG.speed），同一个前缀下几十条 → 按「第一个点之前那一段」再收一层。
      ⚠ 前缀不是写死的 GVL：可能是 GVL_1、PLC_PRG、MyPOU…，一律按名字现算。
   两级都在同一套 openGroups 里记展开状态（'p:前缀' / 'a:数组名'），重开页面还是那个样子。 */
const GROUP_OPEN_KEY = 'hmi-vars-groups-open';
let openGroups = new Set();      // 展开了的组（key 见上）
function loadOpenGroups() {
  try { openGroups = new Set(JSON.parse(localStorage.getItem(GROUP_OPEN_KEY) || '[]')); }
  catch { openGroups = new Set(); }
}
function saveOpenGroups() {
  try { localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify([...openGroups])); } catch { /* 忽略 */ }
}
function toggleGroup(key) {
  if (openGroups.has(key)) openGroups.delete(key); else openGroups.add(key);
  saveOpenGroups();
  render();
}

/** 变量表 → 显示项列表：[{kind:'var',v,depth} | {kind:'group',key,depth,label,sub,list,open}]。
 *  组表头出现在该组**第一个成员**的位置；`arrw` 本身还在的老工程不折叠（免得看漏）。
 *  ⚠ 数组元素分组**不看名字是中文还是英文**：`arrw[1]…arrw[8]` 和 `串1[1]…串1[8]` 一样收成
 *    一行表头（`×8`），展开后元素缩进一格 —— 顶层（名字里没有点）和前缀组里都这么做。 */
function buildDisplayList(vars, forceOpen = false) {
  const names = new Set(vars.map(v => v.name));
  /** 数组元素 → 组名（'arrw[3]' → 'arrw'，二维/多维 `X[1,2]` / `X[1,1,1]` → 'X'）；不是元素返回 ''。
   *  ⚠ 二维数组（PLC 里 `ARRAY[1..3,1..6]` 那种，导入/建变量时摊平成 `X[1,1]…X[3,6]`）
   *    以前这里只认**一个**下标 `/^(.+)\[(\d+)\]$/`，所以 18 个元素平铺一长串、收不起来 ——
   *    现在按「方括号里是若干个逗号分隔的整数」认，二维/三维一样收成一行表头。 */
  const arrBase = v => {
    const m = /^(.+)\[(\d+(\s*,\s*\d+)*)\]$/.exec(String(v.name || ''));
    return m && !names.has(m[1]) ? m[1] : '';
  };
  /** 前缀组的键：第一个点之前那一段（GVL / GVL_1 / PLC_PRG…）；没有点就不分组。
   *  ⚠ **中文名也要分组**：以前这里写的是 `/^([A-Za-z_]\w*)\./`，只认 ASCII 标识符 ——
   *    从 OPC UA 导入的中文符号路径（`设备1.速度`、`主轴.转速`）永远收不成组，
   *    几十条中文变量平铺一长串。现在按"第一个点之前的那一段"取，中英文一视同仁。 */
  const prefixOf = v => {
    const m = /^([^.[\]\s]+)\./.exec(String(v.name || ''));
    return m ? m[1] : '';
  };
  const arrGroups = new Map();
  vars.forEach(v => {
    const b = arrBase(v);
    if (!b) return;
    if (!arrGroups.has(b)) arrGroups.set(b, []);
    arrGroups.get(b).push(v);
  });
  /** 折叠组的说明文字。
   *  一维：`real ×13（arrw[1] … arrw[13]）`（照旧）；
   *  二维/多维：名字太长（`Hr断线故障数据[1,1] … Hr断线故障数据[3,6]` 在窄面板里挤成一团），
   *  只留下标 —— 组名那一行已经写着数组名了：`real ×18（[1,1] … [3,6]）` */
  const arrSub = list => {
    const f = list[0] || {}, l = list[list.length - 1] || {};
    const idx = s => (String(s?.name || '').match(/\[[^\]]+\]$/) || [''])[0];   // 连方括号一起取（`[1,1]`）
    return idx(f).includes(',')
      ? `${f.type || ''} ×${list.length}（${idx(f)} … ${idx(l)}）`
      : `${f.type || ''} ×${list.length}（${f.name || ''} … ${l.name || ''}）`;
  };
  // 前缀下至少 2 条才值得收一层（只剩一条还套个表头反而碍事）
  const preCount = new Map();
  vars.forEach(v => { const p = prefixOf(v); if (p) preCount.set(p, (preCount.get(p) || 0) + 1); });
  const grouped = v => { const p = prefixOf(v); return p && preCount.get(p) >= 2 ? p : ''; };

  /** 一串变量 → 显示项：连续的同组数组元素收成一行表头，其余照原样 */
  const members = (list, depth) => {
    const out = [];
    const done = new Set();
    list.forEach(v => {
      const b = arrBase(v);
      if (!b) { out.push({ kind: 'var', v, depth }); return; }
      if (done.has(b)) return;
      done.add(b);
      const mine = (arrGroups.get(b) || [v]).filter(x => list.includes(x));
      const key = 'a:' + b;
      const open = forceOpen || openGroups.has(key);   // 搜索时全摊开（见 render）
      out.push({
        kind: 'group', key, depth, label: b, list: mine, open,
        sub: arrSub(mine),
      });
      if (open) mine.forEach(x => out.push({ kind: 'var', v: x, depth: depth + 1 }));
    });
    return out;
  };

  const out = [];
  const donePre = new Set();
  const doneTopArr = new Set();      // 顶层的数组元素组：同一个 base 只出一行表头
  vars.forEach(v => {
    const p = grouped(v);
    if (p) {
      if (donePre.has(p)) return;                    // 这一组的成员已跟着表头画过了
      donePre.add(p);
      const list = vars.filter(x => grouped(x) === p);
      const key = 'p:' + p;
      const open = forceOpen || openGroups.has(key);
      out.push({
        kind: 'group', key, depth: 0, label: p, list, open,
        sub: `${list.length} 个（${list[0]?.name || ''} … ${list[list.length - 1]?.name || ''}）`,
      });
      if (open) out.push(...members(list, 1));
      return;
    }
    const b = arrBase(v);
    if (!b) { out.push({ kind: 'var', v, depth: 0 }); return; }
    // 不在前缀组里的数组元素（名字里没有点的，比如从 OPC UA 导入的「串1[1]…串1[8]」）：
    // 同一个数组**收成一行**（×N），展开后元素缩进一格。
    // ⚠ 以前这里是逐条 members([v], 0)，每条都自己成一组 —— 表现就是**每行一个 ×1 组**，
    //   看着像"没折叠也没缩进"（中文名导入时最明显：名字里没有点，正好走这一支）。
    if (doneTopArr.has(b)) return;
    doneTopArr.add(b);
    const mine = (arrGroups.get(b) || [v]).filter(x => !grouped(x));
    const key = 'a:' + b;
    const open = forceOpen || openGroups.has(key);
    out.push({
      kind: 'group', key, depth: 0, label: b, list: mine, open,
      sub: arrSub(mine),
    });
    if (open) mine.forEach(x => out.push({ kind: 'var', v: x, depth: 1 }));
  });
  return out;
}

/* ── 树形缩进 ──
   折叠组（前缀组 / 数组元素组）里的成员要**看得出来是下一级**：每深一层往右挪一格。
   组表头那一行连折叠箭头一起挪（箭头和它的名字必须挨着），变量行挪它的名字格；
   勾选框/删除键这些列不挪 —— 列还是齐的，扫一眼就能顺着缩进看出层级。 */
const INDENT_PX = 14;
const MAX_INDENT = 4;                                   // 再深也不多挪了（面板就那么宽）
const indentOf = (depth) => Math.min(MAX_INDENT, Math.max(0, Number(depth) || 0));

/** 折叠组那一行：▸/▾ + 组名 + 说明 + （勾选框一次选整组）。
 *  ⚠ 缩进是**连折叠箭头一起**往右挪的（INDENT_PX / .vt-in）：
 *    箭头得跟它自己那一行的名字挨着 —— 只缩进名字的话，箭头会孤零零留在最左边，树就散了。 */
function buildGroupRow(it) {
  const tr = document.createElement('tr');
  const depth = indentOf(it.depth);
  tr.className = 'vt-group' + (it.open ? ' open' : '') + (depth ? ' d1' : '') + (it.key.startsWith('p:') ? ' pg' : '');
  if (depth) { tr.classList.add('vt-ind'); tr.style.setProperty('--vt-in', depth * INDENT_PX + 'px'); }
  tr.dataset.group = it.label;
  tr.dataset.gkey = it.key;
  const picked = it.list.filter(v => selVars.has(v.name)).length;
  tr.innerHTML = `
    <td class="vt-sel"><input type="checkbox" data-gsel="1"
      ${picked && picked === it.list.length ? 'checked' : ''}
      title="一次勾选/取消这一整组（${it.list.length} 个）；勾上后底部「删除选中」可以整组删掉"></td>
    <td colspan="4" class="vt-in">
      <!-- ⚠ 里面这层 .vt-ingrp 是给长组名做省略号的（省略号必须做在 span 上，不能做在 <td> 上，
           给单元格加 overflow:hidden 滚动时会出"行叠在一起"的重影，见 layout.css 那段注释） -->
      <span class="vt-ingrp"><span class="vt-gtw">${it.open ? '▾' : '▸'}</span> <b class="mono">${esc(it.label)}</b> <span class="vt-gcnt">${esc(it.sub)}${picked ? `　已选 ${picked}` : ''}</span></span>
    </td>`;
  // 组表头行尾那个「✕」（删整组）也去掉了：这一行左边那个勾选框就是"一次选整组"，
  // 勾上 → 底部「删除选中」；一个组里删几个也可以在组里逐条勾（不必先取消组勾选）。
  tr.addEventListener('click', e => {
    if (e.target.closest('[data-gsel]')) return;   // 勾选框不当展开收起
    toggleGroup(it.key);
  });
  tr.querySelector('[data-gsel]')?.addEventListener('change', e => {
    it.list.forEach(v => { if (e.target.checked) selVars.add(v.name); else selVars.delete(v.name); });
    updateSelAll(currentVars());
    updateDelBtn();
    render();
  });
  return tr;
}

let vl = null;                  // 窗口化列表（变量上万时只画可视区那几十行）
let filterText = '';            // 搜索框里的词（按 名称/地址/类型 过滤，全小写比较）

/** 当前要显示的变量：套上搜索框。
 *  ⚠ 搜索是**在渲染前过滤**（不是画出来再藏），所以折叠组也是按"过滤后剩下的成员"现算的：
 *    搜一个变量名 → 它所在的组照样成组，但组里只剩匹配的那几条（不会把没搜到的也画出来）。 */
function currentVars() {
  const all = project.variables();
  if (!filterText) return all;
  const q = filterText;
  return all.filter(v => `${v.name} ${v.address || ''} ${v.type || ''}`.toLowerCase().includes(q));
}

function render() {
  const box = document.getElementById('varTable');
  if (!box) return;
  const vars = currentVars();
  lastFp = varFingerprint();      // 记下这次画的是哪一版（下次指纹一样就跳过重绘）
  // 勾选状态按名字记（重绘后还在）；变量被删掉的从选择里剔掉
  const names = new Set(project.variables().map(v => v.name));
  [...selVars].forEach(n => { if (!names.has(n)) selVars.delete(n); });
  if (!vl) buildTable(box);
  renderTip(box);                 // 协议换了提示要跟着换（表格本身不重建）
  updateSelAll(vars);
  updateDelBtn();
  // 搜索时**把折叠组都摊开**：不然搜到的变量藏在收起来的组里，看着像"没搜到"
  vl.setItems(buildDisplayList(vars, !!filterText));
  const cnt = document.getElementById('varCount');
  if (cnt) cnt.textContent = filterText ? ` (${vars.length}/${project.variables().length})` : (project.variables().length ? ` (${project.variables().length})` : '');
}

/** 表头 + 提示只建一次；行由 vl 按窗口渲染（上万行也一样快）
 *
 *  列：勾选 / 名称 / 类型 / 地址（+ 字长提示或字符串长度）/ 保持 —— **共 5 列**。
 *  为什么这么排：面板默认只有 300px 宽，7 列时「地址」会被挤成一条缝（实测截图里只剩个 "%"）。
 *  所以把「字长」并进地址格（它本来就是"这个地址占几个字/几个字符"），
 *  并掉「初值」列（现场要求：PLC 变量的值由通讯读回来，初值填了也用不上）、
 *  并掉行尾「删除」列（现场要求：删除走最左边的勾选框 + 底部「删除选中」，见 buildRow）。
 */
function buildTable(box) {
  box.innerHTML = `
    <table class="vt vartbl">
      <!-- 列宽写在这里（见 initColResize）：用户拖过表头边界之后，这 5 个 <col> 上就有宽度了 -->
      <colgroup>${Array.from({ length: 5 }, () => '<col>').join('')}</colgroup>
      <thead><tr>
        <th class="vt-sel"><input type="checkbox" id="varSelAll" title="全选 / 全不选"></th>
        <th>名称</th><th>类型</th>
        <th title="PLC 地址（留空 = 内部变量）。右边那个灰字是「这个地址占几个字」；字符串/数组那里填字符数或元素个数">地址</th>
        <th class="vt-keep" title="掉电保持（HMI 内部）：值存在跑后端那台机器上，后端重启 / 整机断电后还在。
只有**地址留空**的内部变量能勾（有 PLC 地址的变量，保持是 PLC 的事）。">保持</th>
      </tr></thead>
      <tbody id="varRows"></tbody>
    </table>
    <div class="vt-tip" id="varTip"></div>`;
  renderTip(box);
  box.querySelector('#varSelAll').addEventListener('change', e => {
    // 全选/全不选只管**当前搜出来的这些**（搜索框里有词时，选上被藏起来的变量最让人意外）
    const all = currentVars();
    selVars = e.target.checked ? new Set(all.map(v => v.name)) : new Set();
    updateSelAll(all);
    updateDelBtn();
    vl.refresh();
  });
  vl = createVList({
    scroller: box.closest('.panel-body') || box.parentElement,
    host: box.querySelector('#varRows'),
    rowH: 28,
    keyOf: it => (it.kind === 'group' ? `g:${it.key}` : it.v.name),
    // 表格里的占位也得是 <tr>，否则撑不起来
    makePad: h => {
      const tr = document.createElement('tr');
      tr.className = 'vs-pad';
      tr.innerHTML = `<td colspan="5" style="height:${Math.round(h)}px;padding:0;border:0"></td>`;
      return tr;
    },
    renderRow: it => (it.kind === 'group' ? buildGroupRow(it) : buildRow(it.v, it.depth)),
  });
  // 列宽可拖 + **永远按面板宽度排**（现场要求：变量表最右边那列被面板切掉过）。
  // autoFit：一建表就按面板宽算好 —— 名称默认占 34%（拖过就按拖的算），
  // 剩下的全给「地址」（它是填充列，长 NodeId 就该让它占满），所以表格永远正好铺满、不切边。
  // 双面板/面板被拉宽时会自己重排（ResizeObserver）。见 js/editor/colResize.js
  initColResize(box.querySelector('table.vartbl'), {
    minWidths: [22, 56, 68, 60, 30],       // 勾选 / 名称 / 类型 / 地址 / 保持
    storageKey: 'hmi-var-colw',
    flexCol: 3,                            // 3 = 地址列（吃掉剩下的宽度）
    autoFit: true,
    defFrac: [0, 0.34, 0, 0, 0],           // 名称默认占面板宽的 34%，其余按最小宽
  });
}

/** 表下方的写法提示：跟着**当前选的协议**走。
 *  Modbus → 讲寄存器写法；OPC UA → 讲 NodeId + 「从 OPC UA 导入…」按钮。
 *  协议换了要重画（bus 上的 plc:protocol 事件会叫它）。 */
function renderTip(box) {
  const tip = box.querySelector('#varTip');
  if (!tip) return;
  tip.innerHTML = backend.isOpcua()
    ? `<b>OPC UA：</b>地址列填<b>完整 NodeId</b>（<code>ns=4;s=|var|设备.应用.POU.符号</code>）——
       手敲不现实，用右边这个：
       <button class="tb-btn sm" id="btnOpcImport" style="margin-left:4px"
        title="从 CODESYS 导出的「符号配置」XML 离线导入（不用连服务器），或连上服务器浏览节点树勾选。
名称/类型/NodeId 一次带进来，数组/结构体会列出来但不勾。">从 OPC UA 导入…</button>`
    : `<b>bool 用位地址</b> <code title="位地址都带位号：%MX0.0 内存位 / %QX0.0 线圈 / %IX0.0 只读输入；位号往后排就是 %IX0.1、%QX2.3">%MX0.0</code> / <code>%IX0.0</code>，
       <b>字类型用</b> <code>%MW100</code>／<code>%MD50</code>；数字 <code>100</code> = <code>%MW100</code>，<code>HR</code> 写法自动转。<br>
       <b>地址留空 = 内部变量</b>；勾「<b>保持</b>」= <b>掉电保持</b>。`;
  tip.querySelector('#btnOpcImport')?.addEventListener('click', () => {
    import('./opcuaImport.js')
      .then(m => m.openOpcuaImport({}))
      .catch(e => alert('打开导入对话框失败：' + (e?.message || e)));
  });
}

function updateSelAll(vars) {
  const all = document.getElementById('varSelAll');
  if (all) all.checked = !!vars.length && selVars.size === vars.length;
}
function updateDelBtn() {
  const btn = document.getElementById('btnDelVars');
  if (btn) {
    btn.hidden = selVars.size === 0;
    btn.textContent = `删除选中 (${selVars.size})`;
  }
  // 「展开数组」：选中里有数组类型的变量才露面（没有就别占地方）
  const eb = document.getElementById('btnExpandArr');
  if (eb) {
    const arrs = selectedArrayVars();
    eb.hidden = arrs.length === 0;
    eb.textContent = `展开数组 (${arrs.length})`;
  }
}
/** 当前勾选的变量里，哪些是数组类型 */
function selectedArrayVars() {
  const vars = project.variables();
  return [...selVars].filter(n => isArrayType(vars.find(v => v.name === n)?.type));
}

/** 把勾选的数组变量展开成单个标量变量（arrw → arrw[1]…arrw[N]） */
function expandSelectedArrays() { expandArrayVars(selectedArrayVars()); }

/** 展开指定的数组变量（变量面板按钮和右键菜单共用同一个入口） */
export function expandArrayVars(names) {
  const arrs = (names || []).filter(Boolean);
  if (!arrs.length) return;
  const vars = project.variables();
  const lines = arrs.map(n => {
    const v = vars.find(x => x.name === n);
    const refs = project.variableRefs(n);
    return `　${n}（${v.type}，${arrayLenOf(v, ARR_LEN_DEFAULT)} 个）${refs ? ` —— 被 ${refs} 处引用` : ''}`;
  });
  if (!confirm(`把下面这些数组展开成单个标量变量？\n\n${lines.join('\n')}\n\n`
    + '原数组变量会被删掉（Ctrl+Z 可撤销）；设了「数组元素」的控件会自动改绑到对应元素。')) return;
  let created = 0, remapped = 0, cleared = 0;
  const skipped = [];
  arrs.forEach(n => {
    const r = project.expandArrayVar(n);
    if (!r.ok) { skipped.push(`${n}：${r.reason}`); return; }
    created += r.created.length;
    remapped += r.remapped;
    cleared += r.cleared;
  });
  // 刚展开的组直接摊开（让用户立刻看见结果）；不摊开的话它们会收成一行表头
  arrs.forEach(n => openGroups.add(n));
  saveOpenGroups();
  selVars = new Set();
  updateDelBtn();
  render();
  const msg = `已展开 ${created} 个元素变量`
    + (remapped ? `，${remapped} 个控件已自动改绑到对应元素` : '')
    + (cleared ? `\n有 ${cleared} 处「整段引用」（波形通道/整段绑定/动作/报警）没法自动对应到某一个元素，已清空，请手选一下` : '');
  alert(msg + (skipped.length ? `\n跳过：${skipped.join('；')}` : ''));
}

/** 一行 = 勾选/名称/类型/地址/保持/字长 + 删除（事件也在这里挂，行被回收时一起回收）
 *
 *  ⚠ **没有「初值」列**（现场要求去掉）：表里这些变量绝大多数是 PLC 变量，
 *    值由通讯读回来，初值填了也用不上还得逐条维护 —— 新变量一律 0/false/''。
 *    真需要给某个变量一个开机值时（**内部变量**才有意义）：CSV 里填「初始值」列，
 *    或者用 MCP 的 hmi_add_vars / hmi_set_var —— 数据字段本身还在，只是不在表里露。
 *  @param {number} [depth] 在折叠组里的层级（0 = 顶层）：名字格按它缩进 */
function buildRow(v, depth = 0) {
  const name = v.name;
  const isStr = ['string', 'wstring'].includes(String(v.type || '').toLowerCase());
  const isArr = isArrayType(v.type);
  const auto = autoLen(v);
  // 地址格按「当前选的协议」给提示与占位：Modbus 是 %MW96，OPC UA 是 NodeId。
  // ⚠ 只看协议，**不看这条地址长得像什么** —— 以前是 `isOpcua() || isOpcAddr(地址)`，
  //   于是切到 Modbus 后满表还是 OPC UA 的占位符，看着像"选了没生效"。
  const ua = backend.isOpcua();
  const ph = ua ? 'ns=4;s=|var|设备.Application.POU.符号' : '%MW96 或 100';
  const ind = indentOf(depth);
  // 地址留空 = **内部变量**（HMI 自己算/自己写，不下发 PLC）；只有这种变量能勾「保持」
  const internal = !String(v.address || '').trim();
  const tr = document.createElement('tr');
  tr.dataset.name = name;
  tr.className = selVars.has(name) ? 'sel' : '';
  if (ind) { tr.classList.add('vt-ind'); tr.style.setProperty('--vt-in', ind * INDENT_PX + 'px'); }
  tr.innerHTML = `
    <td class="vt-sel"><input type="checkbox" data-k="sel" ${selVars.has(name) ? 'checked' : ''}></td>
    <td class="vt-in"><input data-k="name" class="mono" value="${esc(name)}" title="${esc(name)}"></td>
    <td><select data-k="type">${typeOptions(v.type)}</select></td>
    <td class="vt-addr">
      <input data-k="address" class="mono" placeholder="${esc(ph)}" value="${esc(v.address)}"
          data-vtype="${esc(v.type)}" data-ua="${ua ? '1' : ''}"
          title="${esc(addrTitle(v.address, v, auto))}">
      ${isStr || isArr
        // 字符串/数组：这一格还要填「字符数 / 元素个数」（占几个字由它决定）
        ? `<input data-k="len" class="vt-len" type="number" min="1" max="${isArr ? 4096 : 250}"
               value="${v.len || (isArr ? ARR_LEN_DEFAULT : STR_LEN_DEFAULT)}"
               title="${isArr
                  ? '数组有几个元素（例如 CODESYS 的 ARRAY [1..13] OF INT 就是 13）'
                  : `字符串占的字符数（${Math.ceil((v.len || STR_LEN_DEFAULT) / 2)} 个字）`}">`
        // 其它类型：占几个字由类型决定（int 1 字、real 2 字…）。
        // ⚠ 灰字只在**没地址的内部变量**上显示：它顺便当"这里没有地址"的占位；
        //   有地址的变量不显示 —— 窄面板里那 20px 得留给地址本身（`%MW5426` 刚好被挤没了），
        //   占几个字在地址的悬停提示里写着（见 addrTitle）。
        : (internal ? `<span class="vt-auto" title="由类型决定：${v.type} = ${auto} 个字">${auto} 字</span>` : '')}
    </td>
    <td class="vt-keep"><input type="checkbox" data-k="retain" ${v.retain ? 'checked' : ''}
          ${internal ? '' : 'disabled'}
          title="${internal
            ? '掉电保持：这个变量的值**存在跑后端那台机器上**（server/data/retain_vars.json），后端重启 / 整机断电后还在，开机照旧显示它；不下发 PLC。不勾 = 只在内存里，重启回初值。'
            : '这个变量有 PLC 地址 —— 掉电保持由 PLC 负责（RETAIN/PERSISTENT）。要让 HMI 自己存，请把地址清空成「内部变量」再勾。'}"></td>`;
  // 行尾那个「✕」按现场要求去掉了（和报警表一个口径）：勾上最左边的勾选框 →
  // 底部「删除选中 (N)」一次删（删一条就勾一条），或者在这一行上右键 → 「删除变量」。

  tr.querySelectorAll('input,select').forEach(inp => {
    if (inp.dataset.k === 'sel') {
      inp.addEventListener('change', () => {
        if (inp.checked) selVars.add(name); else selVars.delete(name);
        tr.classList.toggle('sel', inp.checked);
        updateSelAll(currentVars());     // 表头全选框按"当前搜出来的"算
        updateDelBtn();
      });
      return;
    }
    if (inp.dataset.k === 'retain') {
      inp.addEventListener('change', () => {
        project.updateVariableRetain(name, inp.checked);
        statusNote(inp.checked
          ? `「${name}」已设为掉电保持：值会存到后端，重启/断电后还在（不下发 PLC）`
          : `「${name}」取消掉电保持：重启后回变量表初值`);
      });
      return;
    }
    inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      let val = inp.value;
      if (k === 'name') {
        val = val.trim();
        if (!val || val === name) { inp.value = name; return; }
        if (project.variables().some(v2 => v2.name === val)) { inp.value = name; return alert('变量名已存在'); }
      }
      if (k === 'address') {
        // 归一化：Modbus 的 HR100 / 100 统一成 %MW100；OPC UA 只补 ns=，绝不动 NodeId 里的空格。
        // ⚠ 判断依据是「**打进来的内容长不像 NodeId**」，**不是「当前连的是不是 OPC UA」**——
        //   按协议判的话，OPC UA 模式下顺手打 HR100 会被加成 ns=4;s=HR100（实测踩过）。
        //   提示/占位符那几处才看协议（见 buildRow / renderTip），归一化只认内容。
        const uaCell = isOpcAddr(val);
        val = uaCell ? normNodeId(String(val || '').trim(), backend.plcInfo?.default_ns || 4)
          : normAddr(String(val || '').trim());
        inp.value = val;
        inp.dataset.ua = uaCell ? '1' : '';
        const cur = project.variables().find(x => x.name === name);
        inp.title = addrTitle(val, cur, autoLen(cur));
        inp.style.color = /^⚠/.test(inp.title) ? 'var(--danger)' : '';
      }
      if (k === 'len') {
        // 长度列：字符串 = 字符数；数组 = 元素个数
        const arr = isArrayType(project.variables().find(x => x.name === name)?.type);
        const n = Math.min(arr ? 4096 : 250, Math.max(1, parseInt(val, 10) || (arr ? ARR_LEN_DEFAULT : STR_LEN_DEFAULT)));
        inp.value = n;
        inp.title = arr ? `数组：${n} 个元素` : `字符串占 ${n} 个字（= ${Math.ceil(n / 2)} 个寄存器）`;
        project.updateVariable(name, { len: n });
        return;
      }
      if (k === 'type') {
        // 改类型时初值要跟着重算（bool true 改成 real 不该继续显示成 1/true）
        const cur = project.variables().find(x => x.name === name);
        const addrCell = tr.querySelector('input[data-k="address"]');
        const patch = { type: val, value: cast(cur?.value, val) };
        if (val === 'string' && !cur?.len) patch.len = STR_LEN_DEFAULT;      // 字符串要有长度
        if (isArrayType(val) && !cur?.len) patch.len = ARR_LEN_DEFAULT;      // 数组要有元素个数
        if (addrCell) addrCell.title = addrTitle(addrCell.value, { ...cur, type: val }, patch.len || cur?.len || 0);
        project.updateVariable(name, patch);
        return;
      }
      project.updateVariable(name, { [k]: val });
    });
  });
  return tr;
}

/* ── 删除变量（勾选框 + 底部「删除选中 (N)」，行尾的 ✕ 已按现场要求去掉）────
   没人引用的直接删（一次一个地弹确认太烦了，删错了 Ctrl+Z 就能回来）；
   还被控件/报警引用着的才拦一下，并说清楚有几处引用会被清空。 */
function deleteVars(list) {
  const names = list.filter(Boolean);
  if (!names.length) return 0;
  const refs = names.reduce((s, n) => s + project.variableRefs(n), 0);
  if (refs) {
    const what = names.length === 1 ? `变量「${names[0]}」` : `选中的 ${names.length} 个变量`;
    if (!confirm(`删除${what}？\n\n还有 ${refs} 处引用（控件绑定 / 波形通道 / 按钮动作 / 报警条件）会被清空。\n（删错了可以 Ctrl+Z 撤销）`)) return 0;
  }
  const gone = project.deleteVariables(names);
  gone && names.forEach(n => selVars.delete(n));
  flashMsg(gone ? `已删除 ${gone} 个变量（Ctrl+Z 可撤销）` : '');
  return gone;
}

/** 面板底部的一行小提示，几秒后自己消失 */
let msgTimer = null;
function flashMsg(text) {
  const el = document.getElementById('varMsg');
  if (!el) return;
  el.textContent = text;
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

function cast(raw, type) {
  if (isArrayType(type)) {
    // 数组初值：逗号/空格分隔的文本 → 元素数组（个数按「元素个数」列补 0 / 截断）
    const arr = parseArrayText(raw, elemTypeOf(type));
    return arr;
  }
  if (type === 'wstring') return String(raw ?? '');
  if (type === 'bool') return raw === 'true' || raw === '1' || raw === true;
  if (type === 'uint' || type === 'udint') return Math.max(0, parseInt(raw, 10) || 0);
  if (type === 'int' || type === 'dint') return Math.round(parseFloat(raw) || 0);
  if (type === 'real' || type === 'lreal') return parseFloat(raw) || 0;
  return String(raw ?? '');
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
