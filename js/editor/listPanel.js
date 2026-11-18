/**
 * listPanel.js — 控件清单（对象导航）
 *   列出当前页所有控件：类型 / 名称 / 绑定地址或动作摘要
 *   点击任意一行 → 跳转到该页并定位高亮该控件（同时属性面板展示其配置）
 *
 * 两个显示口径（现场提的）：
 *   · **类型徽章按"家族"配色**：一眼分得清操作类/数值类/文本表格/报警/波形/图形（纯灰白一列太费眼）
 *   · **配置那一列**：OPC UA 的地址是长 NodeId、跟变量名基本重复 → 只显示变量名；
 *     Modbus/TCP 的地址短且有用（`%MW100`）→ 显示「变量名 @地址」；NodeId 式/超长地址一律不显示。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { backend } from '../api/backend.js';
import { registry, ACTION_DEFS } from '../widgets/registry.js';
import { createVList } from '../core/vlist.js';
import { shortAddr } from '../core/utils.js';
import { focusWidget } from './canvas.js';

/** 清单里要不要显示控件名称（名字多半是自动生成的「数值4」，配置才是要看的）——记住这个选择 */
const HIDE_NAME_KEY = 'hmi-list-hidename';
let hideName = false;
try { hideName = localStorage.getItem(HIDE_NAME_KEY) === '1'; } catch { /* 忽略 */ }

/** 清单里要不要显示**公共底那一层**的控件（底上的控件画在本页下面，但它们是公共底的东西）——同样记住 */
const HIDE_BASE_KEY = 'hmi-list-hidebase';
let hideBase = false;
try { hideBase = localStorage.getItem(HIDE_BASE_KEY) === '1'; } catch { /* 忽略 */ }

/** 控件类型 → 配色家族（CSS 里 .badge.t-xxx）。没登记的类型按"其它"灰 */
const TYPE_FAMILY = {
  button: 'op', select: 'op2', lamp: 'lamp',
  number: 'num', value: 'num', input: 'num',
  label: 'txt', table: 'txt',
  clock: 'time', trend: 'trend',
  alarmBar: 'alarmBar', alarmList: 'alarm', alarmHistory: 'alarmHis',
  rect: 'shape', circle: 'shape', image: 'shape',
};

let viewingPageId = null;
let selectedIds = new Set();
let viewingBase = null;          // 当前查看的这一页套的公共底（清单里把它那一层也列出来）
let viewingBaseIds = new Set();  // 那一层的控件 id（点行 → 跳到底页去改）

export function initListPanel() {
  document.getElementById('listPageSel').addEventListener('change', e => {
    viewingPageId = e.target.value;
    render();
  });
  // 「隐藏名称」：清单里只留 类型徽章 + 配置，行更短、扫得更快（名字鼠标悬停还有）
  const hnBtn = document.getElementById('listHideName');
  if (hnBtn) {
    const paint = () => {
      hnBtn.classList.toggle('active', hideName);
      hnBtn.title = hideName ? '显示控件名称' : '隐藏控件名称（只留类型 + 配置，列表更紧凑）';
      document.getElementById('widgetList')?.classList.toggle('wl-noname', hideName);
    };
    hnBtn.addEventListener('click', () => {
      hideName = !hideName;
      try { localStorage.setItem(HIDE_NAME_KEY, hideName ? '1' : '0'); } catch { /* 忽略 */ }
      paint();
    });
    paint();
  }
  // 「隐藏底那一层」：只列这一页自己的控件（底上的控件改要去底页改，看清单时未必想看见它们）
  const hbBtn = document.getElementById('listHideBase');
  if (hbBtn) {
    const paintBase = () => {
      hbBtn.classList.toggle('active', hideBase);
      hbBtn.title = hideBase
        ? '显示公共底那一层的控件（它们画在这一页下面，点一下能跳到底页去改）'
        : '隐藏公共底那一层的控件：清单只列**这一页自己的**控件（底上的控件是公共底的东西）';
    };
    hbBtn.addEventListener('click', () => {
      hideBase = !hideBase;
      try { localStorage.setItem(HIDE_BASE_KEY, hideBase ? '1' : '0'); } catch { /* 忽略 */ }
      paintBase();
      render();
    });
    paintBase();
  }
  bus.on('project:changed', render);
  bus.on('page:current', () => { viewingPageId = project.currentId; render(); });
  // 画布选中变化 → 清单里对应行高亮（标记"我之前点了哪个"）
  bus.on('selection:changed', d => {
    selectedIds = new Set(d.ids || []);
    updateHighlight();
  });
  viewingPageId = project.currentId;
  render();
}

function updateHighlight() {
  document.querySelectorAll('#widgetList .wl-item').forEach(el => {
    el.classList.toggle('active', selectedIds.has(el.dataset.id));
  });
}

function render() {
  const sel = document.getElementById('listPageSel');
  if (!sel) return;
  // 下拉（保序，标注页/弹/底）：页面也可能很多，超过 200 页就不逐页列了（换成定位提示）
  const pages = project.pages();
  const tag = p => (p.type === 'popup' ? '[弹]' : p.type === 'base' ? '[底]' : '[页]');
  sel.innerHTML = (pages.length > 200 ? pages.slice(0, 200) : pages).map(p =>
    `<option value="${p.id}" ${p.id === viewingPageId ? 'selected' : ''}>${tag(p)} ${esc(p.name)}（${p.widgets.length}）</option>`
  ).join('');
  if (!project.getPage(viewingPageId)) viewingPageId = project.currentId;

  const page = project.getPage(viewingPageId);
  const list = document.getElementById('widgetList');
  if (!page) return;

  // 套了公共底 → 清单里把它那一层也列出来（带「底」标记，点一下跳到底页去改）；
  // 顶上「底」那个开关按下去就只列这一页自己的控件（底是公共的东西，改要去底页改）
  viewingBase = hideBase ? null : project.baseOf(page);
  viewingBaseIds = new Set(viewingBase ? viewingBase.widgets.map(w => w.id) : []);
  const items = hideBase ? page.widgets : project.renderWidgets(page);

  if (!items.length) {
    if (vl) { vl.destroy(); vl = null; }
    list.innerHTML = '<div class="list-empty">此页面暂无控件</div>';
    return;
  }

  if (!vl) buildList(list);
  vl.setItems(items);
}

/** 控件也可能上千个（大画面），所以清单同样只画可视区 */
let vl = null;
function buildList(list) {
  list.innerHTML = '<div id="wlRows"></div>';
  vl = createVList({
    scroller: list.closest('.panel-body') || list,
    host: list.querySelector('#wlRows'),
    rowH: 26,
    keyOf: w => w.id,
    makePad: h => {
      const d = document.createElement('div');
      d.style.height = Math.round(h) + 'px';
      return d;
    },
    renderRow: w => buildItem(w),
  });
}

function buildItem(w) {
  const def = registry.get(w.type);
  const info = widgetInfo(w);
  const fromBase = viewingBaseIds.has(w.id);   // 这一行是公共底那一层上的
  // 配了操作权限的控件：清单里挂个小锁标记（一眼看出哪些要权限，不用一个个点开属性）
  const lvName = w.props?.permLevel ? project.permLevelName(w.props.permLevel) : '';
  const row = document.createElement('div');
  row.className = 'wl-item' + (fromBase ? ' wl-base' : '');
  row.dataset.id = w.id;
  row.title = `类型：${def?.title || w.type}\n名称：${w.name}\n${info ? '配置：' + info : '未绑定/未配置动作'}`
    + (fromBase ? `\n（公共底「${viewingBase?.name || ''}」上的控件：点一下跳到底页去改，改一次所有套用它的页面都变）` : '')
    + (lvName ? `\n操作权限：需要「${lvName}」` : '')
    + (w.group ? '\n（在组合里：点一下选中整组；Alt+点击只选中它自己）' : '');
  row.innerHTML = `
    <span class="badge t-${TYPE_FAMILY[w.type] || 'other'}">${esc(def?.title || w.type)}</span>
    <span class="wl-name">${esc(w.name)}</span>
    ${fromBase ? '<span class="wl-basetag" title="这一行属于公共底（画在本页下面那一层）">底</span>' : ''}
    ${lvName ? `<span class="wl-perm" title="运行态要「${esc(lvName)}」权限才能操作">🔒 ${esc(lvName)}</span>` : ''}
    <span class="wl-info">${esc(info)}</span>`;
  // Alt+点击 → 只选这一个（组里的某个控件想单独改属性时；普通点击仍是"选中整组"）
  row.addEventListener('click', e => locate(w.id, { raw: e.altKey, fromBase }));
  row.classList.toggle('active', selectedIds.has(w.id));
  return row;
}

/**
 * 控件配置摘要：绑定变量@地址，或动作列表。
 * ⚠ 地址只在**它有用**的时候显示：OPC UA 的地址是长 NodeId（`ns=4;s=|var|CODESYS…`），
 *   跟变量名基本是同一段符号路径、又长得塞不下，看着就是一团乱码 —— 那种只给变量名；
 *   Modbus/TCP 的 `%MW100` 短且是现场干活要用的（对着表查点位），照旧显示。
 */
function widgetInfo(w) {
  if (w.bindings?.variable) {
    const v = project.variables().find(x => x.name === w.bindings.variable);
    // 协议是 OPC UA 时一律不给地址（哪怕它碰巧不长）；其它情况让 shortAddr 判断长短/是否 NodeId
    const addr = backend.isOpcua() ? '' : shortAddr(v?.address);
    return `${w.bindings.variable}${addr ? ' @' + addr : ''}`;
  }
  if (w.bindings?.variables?.filter(Boolean).length) {   // 波形：多通道（数组里空串 = 该路未使用）
    const names = w.bindings.variables.filter(Boolean);
    return `${names.length} 通道：${names.join(', ')}`;
  }
  if (w.actions?.length) {
    return w.actions.map(a => {
      const d = ACTION_DEFS[a.type];
      const short = d ? d.label.split('（')[0] : a.type;
      const target = a.params?.variable || (a.params?.page ? project.getPage(a.params.page)?.name : '');
      return short + (target ? ' ' + target : '');
    }).join(' | ');
  }
  return '';
}

/**
 * 点一行 → 跳到该控件所在的那一页并定位高亮。
 * 公共底那一层上的控件不在本页数据里：先切到底页再定位（编辑口径和画布上"双击跳过去"一致）。
 */
function locate(widgetId, opts = {}) {
  const fromBase = opts.fromBase;
  if (fromBase && viewingBase) {
    project.setCurrentPage(viewingBase.id);
  } else if (project.currentId !== viewingPageId) {
    project.setCurrentPage(viewingPageId);
  }
  // 等画布重绘后定位（raw = 只选这一个，不扩展到整组）
  requestAnimationFrame(() => focusWidget(widgetId, { raw: opts.raw }));
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
