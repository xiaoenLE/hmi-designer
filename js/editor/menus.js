/**
 * menus.js — 各处右键菜单的定义（内容集中在这里，方便一眼看全）
 *
 * 覆盖：画布控件 / 画布空白 / 面板标签 / 控件清单行 / 页面行 / 变量行 / 运行态
 * 菜单项字段：{label, key?, check?, disabled?, danger?, onClick} | {sep:true} | {header:'…'}
 */
import { project } from '../core/project.js';
import { isArrayType } from '../core/utils.js';
import { registerContextMenu } from '../core/contextMenu.js';
import {
  getSelection, select, selectAll, copySelection, cutSelection, pasteClipboard, canPaste,
  deleteSelection, toggleLock, toggleGrid, getGrid, alignWidgets, focusWidget, setZoom, getZoom, zoomFit,
  groupSelection, ungroupSelection,
} from './canvas.js';
import { openCanvasSetting, openDuplicateDialog, duplicateOnce } from './toolbar.js';
import { renamePage, duplicatePageOnce, openPageDupDialog } from './pagesPanel.js';
import { expandArrayVars } from './varsPanel.js';
import { panelDock, floatPanelById, dockPanelTo, dockPanelHome } from './dock.js';
import * as rt from '../runtime/runtime.js';
import { languages as i18nLangs, getLang, setLang } from '../core/i18n.js';
import { clearTrend, isPaused as trendPaused, setPaused as setTrendPaused } from '../runtime/trend.js';

const PANEL_TITLE = { toolbox: '控件', pages: '页面', vars: '变量', list: '清单', properties: '属性' };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // 兜底：老浏览器/无权限时用临时 textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
    return false;
  }
}

/** 控件所在的页面（清单里可能在看别的页）*/
function pageOfWidget(id) {
  return project.pages().find(p => p.widgets.some(w => w.id === id)) || null;
}

/* ══════════ 画布空白处 ══════════ */
function blankMenu() {
  return [
    { label: '粘贴', key: 'Ctrl+V', disabled: !canPaste(), onClick: () => pasteClipboard() },
    { label: '全选', key: 'Ctrl+A', onClick: () => selectAll() },
    { sep: true },
    // 别人做好的控件：一个 .hmiw.json（控件数据 + 用到的变量；自定义控件还带它的定义/代码）
    { label: '导入控件包…（.hmiw.json）', onClick: () => import('./widgetIO.js').then(m => m.pickWidgetPackFile()) },
    { sep: true },
    { label: '网格吸附（5px）', check: getGrid(), onClick: () => toggleGrid() },
    { label: '画布设置…', onClick: () => openCanvasSetting() },
    { sep: true },
    { label: '缩小', key: 'Ctrl+-', onClick: () => setZoom(getZoom() / 1.25) },
    { label: '100%', key: 'Ctrl+0', onClick: () => setZoom(1) },
    { label: '放大', key: 'Ctrl+=', onClick: () => setZoom(getZoom() * 1.25) },
    { label: '适应窗口', key: 'Ctrl+9', onClick: () => zoomFit() },
  ];
}

/* ══════════ 画布上的控件 ══════════ */
function widgetMenu() {
  const ids = getSelection();
  if (!ids.length) return blankMenu();
  const multi = ids.length > 1;
  const one = multi ? null : project.getWidget(ids[0]);
  const allLocked = ids.every(id => project.getWidget(id)?.locked);
  const items = [];

  if (multi) {
    const grouped = project.isWholeGroup(ids);
    items.push({ header: grouped ? `已选中 1 组（${ids.length} 个控件）` : `已选中 ${ids.length} 个控件` });
    // 整组选中时：把组内控件列出来，点一个就"只选中它"——改组里某一个控件时最直接的路子
    if (grouped) {
      const members = ids.map(id => project.getWidget(id)).filter(Boolean);
      items.push({ header: '单独选中组内某个控件' });
      members.slice(0, 12).forEach(m => {
        items.push({ label: m.name, onClick: () => select([m.id], { raw: true }) });
      });
      if (members.length > 12) items.push({ label: `…还有 ${members.length - 12} 个（用属性面板里的组内列表）`, disabled: true });
      items.push({ sep: true });
    }
    items.push(
      { label: '组合（Ctrl+G）', onClick: () => groupSelection() },
      { label: '取消组合（Ctrl+Shift+G）', disabled: !ids.some(id => project.getWidget(id)?.group), onClick: () => ungroupSelection() },
      { sep: true },
      { label: '左对齐', onClick: () => alignWidgets('left') },
      { label: '水平居中', onClick: () => alignWidgets('hcenter') },
      { label: '右对齐', onClick: () => alignWidgets('right') },
      { label: '顶对齐', onClick: () => alignWidgets('top') },
      { label: '垂直居中', onClick: () => alignWidgets('vcenter') },
      { label: '底对齐', onClick: () => alignWidgets('bottom') },
      { label: '水平等间距', onClick: () => alignWidgets('hdist') },
      { label: '垂直等间距', onClick: () => alignWidgets('vdist') },
      { sep: true },
    );
  } else if (one) {
    items.push({ header: one.name });
    // 这个控件用的变量在哪儿还被用到（顺手把 Ctrl+F 讲出来）
    const vn = one.bindings?.variable
      || (one.bindings?.variables || []).find(Boolean)
      || (one.actions || []).map(a => a.params?.variable).find(Boolean);
    if (vn) {
      items.push(
        { label: `查找变量「${vn}」在哪用到`, key: 'Ctrl+F', onClick: () => import('./varSearch.js').then(m => m.openVarSearch(vn)) },
        { sep: true },
      );
    }
  }

  items.push(
    { label: '剪切', key: 'Ctrl+X', onClick: () => cutSelection() },
    { label: '复制', key: 'Ctrl+C', onClick: () => copySelection() },
    { label: '粘贴', key: 'Ctrl+V', disabled: !canPaste(), onClick: () => pasteClipboard() },
    { label: '再复制一份', key: 'Ctrl+D', onClick: () => duplicateOnce() },
    { label: '多重复制…', key: 'Ctrl+Shift+D', onClick: () => openDuplicateDialog() },
    { sep: true },
    // 导出成控件包：别人拿到这个 .hmiw.json 就能导进他的工程用（自定义控件会连定义/代码一起带）
    {
      label: multi ? `导出这 ${ids.length} 个控件（控件包）…` : '导出为控件包…（给别人用）',
      onClick: () => import('./widgetIO.js').then(m => m.exportSelection(ids)),
    },
    { sep: true },
    { label: '置于顶层', onClick: () => project.setZ(ids, 'top') },
    { label: '置于底层', onClick: () => project.setZ(ids, 'bottom') },
    { label: allLocked ? '解锁' : '锁定', onClick: () => toggleLock() },
    { sep: true },
    {
      label: multi ? `删除 ${ids.length} 个控件` : '删除',
      key: 'Delete', danger: true,
      onClick: () => deleteSelection(),
    },
  );
  return items;
}

/* ══════════ 面板标签（停靠 / 浮动）══════════ */
function tabMenu(target) {
  const id = target.dataset.panel;
  if (!PANEL_TITLE[id]) return [];
  const at = panelDock(id);
  return [
    { header: `${PANEL_TITLE[id]} 面板` },
    { label: '浮动为窗口', disabled: at === 'float', onClick: () => floatPanelById(id) },
    { sep: true },
    { label: '停靠到左侧', check: at === 'left', onClick: () => dockPanelTo(id, 'left') },
    { label: '停靠到右侧', check: at === 'right', onClick: () => dockPanelTo(id, 'right') },
    { label: '停靠到底部', check: at === 'bottom', onClick: () => dockPanelTo(id, 'bottom') },
    { sep: true },
    { label: '停靠回原来的区域', onClick: () => dockPanelHome(id) },
  ];
}

/* ══════════ 浮动小窗的标题栏 ══════════ */
function floatMenu(id) {
  if (!PANEL_TITLE[id]) return [];
  return [
    { header: `${PANEL_TITLE[id]} 面板（浮动中）` },
    { label: '停靠到左侧', onClick: () => dockPanelTo(id, 'left') },
    { label: '停靠到右侧', onClick: () => dockPanelTo(id, 'right') },
    { label: '停靠到底部', onClick: () => dockPanelTo(id, 'bottom') },
    { sep: true },
    { label: '停靠回原来的区域', onClick: () => dockPanelHome(id) },
  ];
}

/* ══════════ 控件清单行 ══════════ */
function listRowMenu(target) {
  const id = target.dataset.id;
  const w = project.pages().flatMap(p => p.widgets).find(x => x.id === id);
  if (!w) return [];
  const goThere = () => {
    const pg = pageOfWidget(id);
    if (pg && project.currentId !== pg.id) project.setCurrentPage(pg.id);
  };
  return [
    { header: w.name },
    { label: '在画布中定位', onClick: () => { goThere(); focusWidget(id); } },
    { label: '复制', onClick: () => { goThere(); select([id]); copySelection(); } },
    { label: w.locked ? '解锁' : '锁定', onClick: () => { goThere(); select([id]); toggleLock(); } },
    { sep: true },
    // 单个控件也能单独导成一个控件包（现场最常用：把调好的一块发给别人）
    { label: '导出为控件包…（给别人用）', onClick: () => import('./widgetIO.js').then(m => m.exportSelection([id])) },
    { sep: true },
    {
      label: '删除控件', danger: true,
      onClick: () => { goThere(); project.deleteWidgets([id]); },
    },
  ];
}

/* ══════════ 页面行 ══════════ */
function pageRowMenu(target) {
  const pg = project.getPage(target.dataset.pageId);
  if (!pg) return [];
  const isBase = pg.type === 'base';
  const appliedBases = project.basesOf(pg);
  const bases = project.bases();
  return [
    { header: `${isBase ? '公共底' : pg.type === 'popup' ? '弹窗' : '页面'}：${pg.name}` },
    { label: '切换到此页', disabled: pg.id === project.currentId, onClick: () => project.setCurrentPage(pg.id) },
    { label: '重命名…', onClick: () => renamePage(pg.id) },
    { sep: true },
    // 普通页：右键直接叠/去掉公共底（可多层；属性面板里也能上移下移）
    ...(pg.type === 'page' && bases.length ? [
      ...appliedBases.map((b, i) => ({
        label: `✕ 去掉第 ${i + 1} 层公共底：${b.name}`,
        onClick: () => project.removePageBase(pg.id, b.id),
      })),
      ...bases.filter(b => !appliedBases.some(x => x.id === b.id)).map(b => ({
        label: `＋ 叠一层公共底：${b.name}`,
        onClick: () => project.addPageBase(pg.id, b.id),
      })),
      { sep: true },
    ] : []),
    // 复制/多重复制：**公共底也能复制**（现场要的：底一行上没有按钮了，但右键要能复制出「底2」）
    { label: '复制此页', onClick: () => duplicatePageOnce(pg.id) },
    { label: '多重复制此页…', onClick: () => openPageDupDialog(pg.id) },
    { sep: true },
    // 单页搬到别的工程：导出一个 .json（这一页 + 它用到的变量 + 它套的公共底）
    { label: `导出这一页…（${pg.name}）`, onClick: () => import('./pageIO.js').then(m => m.exportPage(pg.id)) },
    { label: '导入页面…（从 .json 文件）', onClick: () => import('./pageIO.js').then(m => m.pickPageFile()) },
    { sep: true },
    { label: '新建页面', onClick: () => project.addPage('page') },
    { label: '新建弹窗', onClick: () => project.addPage('popup') },
    { label: '新建公共底', onClick: () => project.addPage('base') },
    { sep: true },
    {
      label: isBase ? '删除这个公共底' : '删除此页', danger: true,
      // 行的 ✕ 按钮去掉了（现场要求：行上留干净，删除走右键）→ 确认逻辑统一在 pagesPanel 里
      onClick: () => import('./pagesPanel.js').then(m => m.deletePageWithConfirm(pg.id)),
    },
  ];
}

/* ══════════ 变量行 ══════════ */
function varRowMenu(target) {
  const name = target.dataset.name;
  const v = project.variables().find(x => x.name === name);
  if (!v) return [];
  return [
    { header: `${v.name}（${v.type}）` },
    { label: '复制变量名', onClick: () => copyText(v.name) },
    { label: '复制名称和地址', disabled: !v.address, onClick: () => copyText(`${v.name}\t${v.address}`) },
    ...(isArrayType(v.type) ? [
      { sep: true },
      { label: '展开成单个变量（arrw → arrw[1]…）', onClick: () => expandArrayVars([v.name]) },
    ] : []),
    { sep: true },
    // 这个变量在哪儿用到 / 换成别的变量（面板上「🔍 查找/替换…」是同一个对话框）
    {
      label: '查找引用（在哪些地方用到…）',
      onClick: () => import('./varSearch.js').then(m => m.openVarSearch(v.name)),
    },
    {
      label: '替换成别的变量…',
      onClick: () => import('./varSearch.js').then(m => m.openVarSearch(v.name, { focusReplace: true })),
    },
    { sep: true },
    { label: '添加变量', onClick: () => project.addVariable() },
    { sep: true },
    {
      label: '删除变量', danger: true,
      onClick: () => { if (confirm(`确定删除变量「${v.name}」？所有绑定引用将被清理。`)) project.deleteVariable(v.name); },
    },
  ];
}

/* ══════════ 运行态：波形控件上（外加运行态公共项）══════ */
function trendRuntimeMenu(widgetId) {
  const paused = trendPaused();
  return [
    { header: '波形抓取' },
    { label: '清空波形记录', onClick: () => clearTrend(widgetId) },
    { label: paused ? '继续采样（全部波形）' : '暂停采样（全部波形）', check: paused, onClick: () => setTrendPaused(!paused) },
    { sep: true },
    ...runtimeMenu(),
  ];
}

/* ══════════ 运行态 ══════════
   运行主页面一个按钮都不摆（现场全屏看画面），所以菜单是这些功能的「看得见」的入口 ——
   每项都标上快捷键，用户照着按就记住了 */
function runtimeMenu() {
  const z = rt.getZoomMode();
  return [
    { header: '切换视图（Ctrl+Shift+F 依次切换）' },
    { label: '原始尺寸 1:1', check: z === 'orig', onClick: () => rt.setZoomMode('orig') },
    { label: '适应窗口（整幅都在窗内）', check: z === 'fit', onClick: () => rt.setZoomMode('fit') },
    { label: '填满窗口（铺满整窗，控件全在窗内）', check: z === 'fill', onClick: () => rt.setZoomMode('fill') },
    { sep: true },
    { label: 'PLC 连接设置…', key: 'Ctrl+Shift+L', onClick: () => rt.openRuntimePlcDialog() },
    // 操作权限：解锁着的时候给一个"交回权限"的看得见的入口（运行页面板都不摆按钮）
    ...(rt.permLevelName && rt.permLevelName() ? [{
      label: `退出权限（当前：${rt.permLevelName()}）`, key: 'Ctrl+Shift+Q', onClick: () => rt.lockPerm(),
    }] : []),
    { label: rt.isVarsVisible() ? '隐藏变量监控' : '显示变量监控', key: 'Ctrl+Shift+V', onClick: () => rt.toggleVarsPanel() },
    { label: rt.isLogVisible && rt.isLogVisible() ? '隐藏脚本日志' : '显示脚本日志', key: 'Ctrl+Shift+J', onClick: () => rt.toggleLogPanel() },
    { label: '快捷键提示', onClick: () => rt.showRuntimeHint() },
    // 语言（配了多语言的工程才有）：现场在自己这台机器上换，只影响本机浏览器
    ...(i18nLangs().length > 1 ? [
      { sep: true },
      { header: '语言 / Language' },
      ...i18nLangs().map(l => ({
        label: `${l.label}（${l.code}）`, check: getLang() === l.code,
        onClick: () => setLang(l.code),
      })),
    ] : []),
    // 内部变量（**地址留空**的那些）才有「恢复初值」：
    //   · 内存模式（没接 PLC）：所有变量都是内部的 → 老行为不变
    //   · 接了真 PLC：**只重置无地址的内部变量**（含勾了「保持」的），一个字节都不碰 PLC；
    //     变量表里一个内部变量都没有时不显示这一项（免得让人以为能"恢复 PLC 的值"）
    ...((rt.isInternalVars() || project.variables().some(v => !String(v.address || '').trim())) ? [{
      label: rt.isInternalVars() ? '内部变量：恢复初值' : '内部变量：恢复初值（只重置无地址的那些）',
      onClick: async () => {
        try {
          const n = await rt.resetInternalVars();
          alert(`已把 ${n} 个内部变量恢复成变量表初值`);
        } catch (e) { alert('恢复初值失败：' + e.message); }
      },
    }] : []),
    { sep: true },
    { label: '退出运行', key: 'Esc / Ctrl+Shift+E', onClick: () => rt.exitRun() },
  ];
}

/* ══════════ 注册 ══════════ */
export function initMenus() {
  // 顺序 = 优先级（先注册的先匹配）
  // 运行态里的波形控件：先给它专属菜单（清空/暂停），其余地方再走运行态公共菜单
  registerContextMenu(t => !!t.closest('#runtimeRoot .wd-trend'),
    t => trendRuntimeMenu(t.closest('.wd')?.dataset.id));
  registerContextMenu(t => !!t.closest('#runtimeRoot'), () => runtimeMenu());
  // 浮动小窗的标题栏（只匹配标题栏 —— 面板内容里各行有自己的菜单，别被抢走）
  registerContextMenu(t => !!t.closest('.panel.floating .panel-head'),
    t => floatMenu(t.closest('.panel.floating').dataset.panel));
  registerContextMenu(t => !!t.closest('#canvas .wd'), t => {
    const id = t.closest('#canvas .wd').dataset.id;
    if (!getSelection().includes(id)) select([id]);    // 右键即选中，菜单作用于它
    return widgetMenu();
  });
  registerContextMenu(t => !!t.closest('#canvas'), () => blankMenu());
  // 下面几个都要先找回「行」本身：右键点到的往往是行里的文字/单元格（它们没有 dataset）
  registerContextMenu(t => !!t.closest('.dock-tabs .lp-tab'), t => tabMenu(t.closest('.dock-tabs .lp-tab')));
  registerContextMenu(t => !!t.closest('#widgetList .wl-item'), t => listRowMenu(t.closest('#widgetList .wl-item')));
  registerContextMenu(t => !!t.closest('#pageList .pg-item'), t => pageRowMenu(t.closest('#pageList .pg-item')));
  registerContextMenu(t => !!t.closest('#varTable tr[data-name]'), t => varRowMenu(t.closest('#varTable tr[data-name]')),
    { inInputs: true });   // 变量表整行都是输入框，不在输入框里弹就等于没有菜单
}
