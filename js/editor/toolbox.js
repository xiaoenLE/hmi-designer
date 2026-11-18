/**
 * toolbox.js — 左侧控件工具箱（面板标签切换由 dock.js 负责）
 *
 * 列表从注册表生成：**谁 register 谁就出现在这里**（内置 16 种 + 导入控件包带来的自定义控件）。
 * 所以导入控件包之后要重建一次 —— 见下面的 `widgets:defs-changed` 订阅。
 */
import { registry } from '../widgets/registry.js';
import { setPendingType } from './canvas.js';
import { bus } from '../core/eventBus.js';

/**
 * 重建工具箱列表。
 * 顺序 = `registry.list()` 的插入顺序（也就是 defs/index.js 里 import 的先后，
 * 自定义控件排在所有内置控件后面）。
 */
export function refreshToolbox() {
  const list = document.getElementById('toolboxList');
  if (!list) return 0;
  list.innerHTML = '';
  // hidden 的旧控件不展示，但保留兼容渲染
  const defs = registry.list().filter(d => !d.hidden);
  defs.forEach(def => {
    const item = document.createElement('div');
    item.className = 'tb-item';
    item.draggable = true;
    // 自定义控件（导入来的）挂个角标：一眼能看出哪个不是内置的
    const badge = def._fromPack ? '<span class="tb-badge" title="导进来的自定义控件">包</span>' : '';
    item.innerHTML = `${def.icon}
      <div><div>${def.title}${badge}</div><div class="sub">${def.sub || ''}</div></div>`;
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/widget-type', def.type);
      e.dataTransfer.effectAllowed = 'copy';
      setPendingType(def.type);
    });
    item.addEventListener('dragend', () => setPendingType(null));
    // 双击 = 在画布左上角直接添加（拖拽之外的第二入口）
    item.addEventListener('dblclick', () => {
      import('../core/project.js').then(({ project }) => {
        const w = project.addWidget(def.type, 40, 40);
        bus.emit('selection:changed', { ids: [w.id] });
      });
    });
    list.appendChild(item);
  });
  return defs.length;
}

export function initToolbox() {
  refreshToolbox();
  // 控件库里多了/换了类型（导入控件包、载入带自定义控件的工程）→ 重建列表，
  // 否则新控件只能靠"手输 type"，现场根本发现不了它能用
  bus.on('widgets:defs-changed', () => refreshToolbox());
}
