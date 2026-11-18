/**
 * panels.js — 面板停靠区尺寸 / 折叠 / 状态持久化
 *   · 拖动左/右分隔条调宽、拖底部横向分隔条调高，双击恢复默认
 *   · 点分隔条上的 ‹› 按钮折叠/展开（底部是 ▾）
 *   · 尺寸与折叠状态存 localStorage，下次打开自动恢复
 * 注意：分隔条本身按「列」和「行」两种方向工作，逻辑分开写更好读。
 */
// 左停靠区默认宽一点：变量表要放 勾选框/名称/类型/地址/长度/初值/删除，250px 会把
// %MW102 这种地址截成 %MW1…（拖过分隔条的按用户自己存的宽度，双击分隔条恢复这个默认值）
const DEFAULTS = { left: 300, right: 272, bottom: 220 };
const MIN = { left: 170, right: 210, bottom: 120 };
const MAX = 560;

function load(key, def) {
  try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); }
  catch { return def; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

const panelId = s => (s === 'left' ? 'leftPanel' : s === 'right' ? 'rightPanel' : 'bottomPanel');
const rzId = s => (s === 'left' ? 'leftResizer' : s === 'right' ? 'rightResizer' : 'bottomResizer');

function setWidth(side, w) {
  document.getElementById(panelId(side)).style.width = w + 'px';
}
function setHeight(h) {
  document.getElementById('bottomPanel').style.height = h + 'px';
}

function setCollapsed(side, collapsed) {
  document.getElementById(panelId(side)).classList.toggle('collapsed', collapsed);
  const rz = document.getElementById(rzId(side));
  rz.classList.toggle('collapsed', collapsed);
  rz.querySelector('.rz-toggle').textContent = collapsed
    ? (side === 'left' ? '›' : '‹')     // 折叠后箭头指向展开方向
    : (side === 'left' ? '‹' : '›');
  save(`hmi-panel-${side}-collapsed`, collapsed);
}

function bindResizer(side) {
  const rz = document.getElementById(rzId(side));
  const panel = document.getElementById(panelId(side));

  rz.querySelector('.rz-toggle').addEventListener('click', e => {
    e.stopPropagation();
    setCollapsed(side, !panel.classList.contains('collapsed'));
  });

  rz.addEventListener('pointerdown', e => {
    if (e.target.closest('.rz-toggle')) return;
    if (panel.classList.contains('collapsed')) return;   // 折叠时点箭头展开
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    rz.classList.add('active');
    document.body.classList.add('resizing');

    const move = ev => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.max(MIN[side], Math.min(MAX, startW + delta));
      setWidth(side, w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rz.classList.remove('active');
      document.body.classList.remove('resizing');
      save(`hmi-panel-${side}`, Math.round(panel.getBoundingClientRect().width));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // 双击恢复默认宽度
  rz.addEventListener('dblclick', () => {
    setWidth(side, DEFAULTS[side]);
    save(`hmi-panel-${side}`, DEFAULTS[side]);
  });
}

/** 底部横向分隔条：拖动调高 / 双击恢复 / 点 ▾ 折叠 */
function bindBottomResizer() {
  const rz = document.getElementById('bottomResizer');
  const panel = document.getElementById('bottomPanel');
  const toggle = rz.querySelector('.rz-toggle-h');

  toggle.addEventListener('click', e => {
    e.stopPropagation();
    const collapsed = !panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed', collapsed);
    rz.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '▴' : '▾';
    save('hmi-panel-bottom-collapsed', collapsed);
  });

  rz.addEventListener('pointerdown', e => {
    if (e.target.closest('.rz-toggle-h')) return;
    if (panel.classList.contains('collapsed')) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    rz.classList.add('active');
    document.body.classList.add('resizing');
    const move = ev => {
      const h = Math.max(MIN.bottom, Math.min(window.innerHeight * 0.7, startH - (ev.clientY - startY)));
      setHeight(h);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rz.classList.remove('active');
      document.body.classList.remove('resizing');
      save('hmi-panel-bottom', Math.round(panel.getBoundingClientRect().height));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  rz.addEventListener('dblclick', () => {
    setHeight(DEFAULTS.bottom);
    save('hmi-panel-bottom', DEFAULTS.bottom);
  });
}

export function initPanels() {
  ['left', 'right'].forEach(side => {
    setWidth(side, load(`hmi-panel-${side}`, DEFAULTS[side]));
    if (load(`hmi-panel-${side}-collapsed`, false)) setCollapsed(side, true);
    bindResizer(side);
  });
  // 底部停靠区
  setHeight(load('hmi-panel-bottom', DEFAULTS.bottom));
  if (load('hmi-panel-bottom-collapsed', false)) {
    document.getElementById('bottomPanel').classList.add('collapsed');
    document.getElementById('bottomResizer').classList.add('collapsed');
    document.querySelector('#bottomResizer .rz-toggle-h').textContent = '▴';
  }
  bindBottomResizer();
}
