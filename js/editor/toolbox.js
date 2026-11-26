/**
 * toolbox.js — 左侧控件工具箱（面板标签切换由 dock.js 负责）
 *
 * 列表从注册表生成：**谁 register 谁就出现在这里**（内置控件 + 导入控件包带来的自定义控件）。
 * 所以导入控件包之后要重建一次 —— 见下面的 `widgets:defs-changed` 订阅。
 *
 * 分组：控件一多（内置 31 个 + 自定义包）平铺一长条，现场找东西全靠滚。
 * 现在按用途分组（输入与操作 / 显示 / 图表 / 数据与配方 / 报警 / 装饰），组头点一下能收起。
 * 分组用于工具箱布局，并供属性面板识别装饰控件。
 */
import { registry } from '../widgets/registry.js';
import { setPendingType } from './canvas.js';
import { bus } from '../core/eventBus.js';

/**
 * 分组表：顺序 = 工具箱里从上到下的顺序（常用的放前面）。
 * 组内顺序也按这里 `types` 的先后 —— 想调某组的摆放就改这个数组。
 * 没写进任何组的控件（以后新加的、导入包里没归类的）自动落到「其他」，
 * 自定义控件（`_fromPack`）统一进「自定义控件」组并带「包」角标。
 */
const GROUPS = [
  { id: 'input', title: '输入与操作', types: ['button', 'number', 'slider', 'switch', 'multiPosition', 'select', 'barcode'] },
  { id: 'display', title: '显示', types: ['label', 'lamp', 'stateImage', 'image', 'bar', 'gauge', 'clock', 'timer'] },
  { id: 'chart', title: '图表', types: ['trend', 'xyplot', 'table'] },
  { id: 'data', title: '数据与配方', types: ['paramTable', 'recipe', 'recipeEditor', 'shift', 'operations'] },
  { id: 'alarm', title: '报警', types: ['alarmBar', 'alarmList', 'alarmHistory'] },
  { id: 'deco', title: '装饰', types: ['rect', 'circle', 'line', 'arrow', 'pipe'] },
];
const TAIL_GROUPS = [
  { id: 'custom', title: '自定义控件' },   // 导入控件包带来的
  { id: 'other', title: '其他' },          // 还没归类的（新加的控件、老工程里的兼容控件）
];
const ALL_GROUPS = [...GROUPS, ...TAIL_GROUPS];
const GROUP_TITLE = new Map(ALL_GROUPS.map(g => [g.id, g.title]));
const TYPE_GROUP = new Map();
GROUPS.forEach(g => g.types.forEach(t => TYPE_GROUP.set(t, g.id)));
const TYPE_ORDER = new Map();
GROUPS.forEach(g => g.types.forEach((t, i) => TYPE_ORDER.set(t, i)));

/** 收起状态记本机（跟列宽、排序一样是使用习惯，不进工程文件） */
const COLLAPSE_KEY = 'hmi-toolbox-collapsed';
function loadCollapsed() {
  try {
    const a = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(a) ? a.filter(x => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* 无痕模式：存不了就算了 */ }
}

export function toolboxGroupOf(def) {
  if (def?._fromPack) return 'custom';
  return TYPE_GROUP.get(def?.type) || 'other';
}

/** 一个工具箱条目。拖拽摆放，双击或按 Enter 添加。 */
function buildItem(def) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'tb-item';
  item.dataset.type = def.type;
  item.dataset.group = toolboxGroupOf(def);
  item.draggable = true;
  item.title = def.sub ? def.title + ' · ' + def.sub : def.title;
  item.innerHTML = def.icon || '';
  item.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'tb-item-name';
  name.textContent = def.title;
  item.appendChild(name);
  if (def._fromPack) {
    const badge = document.createElement('span');
    badge.className = 'tb-badge';
    badge.textContent = '包';
    badge.title = '自定义控件';
    item.appendChild(badge);
  }
  item.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/widget-type', def.type);
    e.dataTransfer.effectAllowed = 'copy';
    setPendingType(def.type);
  });
  item.addEventListener('dragend', () => setPendingType(null));
  const add = () => import('../core/project.js').then(({ project }) => {
    const w = project.addWidget(def.type, 40, 40);
    if (w) bus.emit('selection:changed', { ids: [w.id] });
  });
  item.addEventListener('dblclick', add);
  item.addEventListener('click', e => { if (e.detail === 0) add(); });
  return item;
}

/** 组头：点一下收起 / 展开（整条长列表，靠它把不用的组折起来） */
function buildGroupHead(gid, count, collapsed) {
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tb-group-head';
  head.dataset.group = gid;
  head.setAttribute('aria-expanded', String(!collapsed));
  head.setAttribute('aria-controls', 'toolbox-group-' + gid);
  head.innerHTML = `<span class="tb-group-caret">${collapsed ? '▸' : '▾'}</span>
    <span class="tb-group-title">${GROUP_TITLE.get(gid) || gid}</span>
    <span class="tb-group-n">${count}</span>`;
  return head;
}

/**
 * 重建工具箱列表。
 * 组内顺序 = GROUPS[].types 的先后（没列进去的按注册表插入顺序排在组尾）。
 */
export function refreshToolbox() {
  const list = document.getElementById('toolboxList');
  if (!list) return 0;
  list.innerHTML = '';
  // hidden 的旧控件不展示，但保留兼容渲染
  const defs = registry.list().filter(d => !d.hidden);

  // 先按组归堆，组内再按 GROUP.types 的顺序排（注册表顺序作为兜底，别丢控件）
  const buckets = new Map();
  defs.forEach((def, regIdx) => {
    const gid = toolboxGroupOf(def);
    if (!buckets.has(gid)) buckets.set(gid, []);
    buckets.get(gid).push({ def, regIdx });
  });

  const collapsed = loadCollapsed();
  const order = ALL_GROUPS.map(g => g.id);
  for (const gid of order) {
    const bucket = buckets.get(gid);
    if (!bucket?.length) continue;          // 空组不画（比如没导入过控件包时的「自定义控件」）
    bucket.sort((a, b) => {
      const oa = TYPE_ORDER.has(a.def.type) ? TYPE_ORDER.get(a.def.type) : 1e6;
      const ob = TYPE_ORDER.has(b.def.type) ? TYPE_ORDER.get(b.def.type) : 1e6;
      return (oa - ob) || (a.regIdx - b.regIdx);
    });
    const isCollapsed = collapsed.has(gid);
    const body = document.createElement('div');
    body.className = 'tb-group-body';
    body.dataset.group = gid;
    body.id = 'toolbox-group-' + gid;
    body.hidden = isCollapsed;
    bucket.forEach(({ def }) => body.appendChild(buildItem(def)));

    const head = buildGroupHead(gid, bucket.length, isCollapsed);
    head.addEventListener('click', () => {
      const nowCollapsed = !body.hidden;
      body.hidden = nowCollapsed;
      head.setAttribute('aria-expanded', String(!nowCollapsed));
      head.querySelector('.tb-group-caret').textContent = nowCollapsed ? '▸' : '▾';
      const set = loadCollapsed();
      if (nowCollapsed) set.add(gid); else set.delete(gid);
      saveCollapsed(set);
    });
    list.appendChild(head);
    list.appendChild(body);
  }
  return defs.length;
}

export function initToolbox() {
  refreshToolbox();
  // 控件库里多了/换了类型（导入控件包、载入带自定义控件的工程）→ 重建列表，
  // 否则新控件只能靠"手输 type"，现场根本发现不了它能用
  bus.on('widgets:defs-changed', () => refreshToolbox());
}
