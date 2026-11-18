/**
 * contextMenu.js — 应用内右键菜单
 *
 *   · 在应用里（编辑态 + 运行态）屏蔽浏览器右键菜单，换成我们自己的
 *   · 菜单内容按「右键点在哪」决定：谁注册的 provider 先匹配上就用谁
 *   · 输入框里保留浏览器原生菜单 —— 那里真的需要"复制/粘贴/拼写检查"
 *
 * 用法：
 *   initContextMenu()                      // main.js 里调一次
 *   registerContextMenu(matchFn, buildFn)   // 各模块注册自己的菜单
 *     matchFn(target, e) → boolean
 *     buildFn(target, e) → [{label,key,check,disabled,danger,onClick} | {sep:true} | {header:'…'}]
 */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

const providers = [];
let el = null;
let items = [];
let active = -1;
let isOpen = false;
let allowNativeInInputs = true;

/** 注册一个菜单来源（先注册的先匹配）
 *  @param {Function} match (target, e) => boolean
 *  @param {Function} build (target, e) => items
 *  @param {{inInputs?:boolean}} [opts] inInputs=true 表示「输入框里也用这个菜单」
 *         （变量表整行都是输入框，不在里面弹就等于没菜单；默认输入框保留浏览器原生菜单）*/
export function registerContextMenu(match, build, opts = {}) {
  providers.push({ match, build, inInputs: !!opts.inInputs });
}

export function isContextMenuOpen() { return isOpen; }

/**
 * 在指定坐标弹一个菜单（工具栏下拉用同一套样式/键盘操作，别再写一套）。
 * @param {number} x @param {number} y
 * @param {Array} list 同 registerContextMenu 的 items 结构
 */
export function openAt(x, y, list) {
  if (!el || !Array.isArray(list) || !list.length) return;
  openMenu(x, y, list);
}

export function initContextMenu(opts = {}) {
  allowNativeInInputs = opts.allowNativeInInputs !== false;
  el = document.getElementById('ctxMenu');
  if (!el) return;

  document.addEventListener('contextmenu', onContextMenu);
  // 点别处/按 Esc/滚动/窗口变化都关掉（capture 阶段先关，菜单内部的点击不受影响）
  document.addEventListener('pointerdown', e => {
    if (isOpen && !e.target.closest('#ctxMenu')) closeMenu();
  }, true);
  document.addEventListener('keydown', e => {
    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(); }
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('wheel', () => { if (isOpen) closeMenu(); }, { passive: true, capture: true });
}

function onContextMenu(e) {
  const target = e.target;
  const inEditable = !!target.closest?.(EDITABLE);
  const hit = providers.find(p => {
    if (inEditable && !p.inInputs) return false;   // 输入框里默认让位给浏览器菜单
    try { return p.match(target, e); } catch { return false; }
  });
  if (inEditable && allowNativeInInputs && !hit) { closeMenu(); return; }   // 输入框放行
  e.preventDefault();                                                      // 其余一律禁用浏览器菜单
  closeMenu();
  if (!hit) return;
  let list = [];
  try { list = hit.build(target, e) || []; } catch (err) { console.error('[ctx] build', err); return; }
  if (!list.length) return;
  openMenu(e.clientX, e.clientY, list);
}

function openMenu(x, y, list) {
  items = list;
  el.innerHTML = '';
  items.forEach((it, i) => {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      el.appendChild(s);
      return;
    }
    if (it.header) {
      const h = document.createElement('div');
      h.className = 'ctx-head';
      h.textContent = it.header;
      h.title = it.header;
      el.appendChild(h);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    b.dataset.idx = i;
    b.disabled = !!it.disabled;
    const check = document.createElement('span');
    check.className = 'ctx-check';
    check.textContent = it.check ? '✓' : '';
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = it.label;               // textContent：控件名/变量名都可能是任意字符
    b.appendChild(check);
    b.appendChild(label);
    if (it.key) {
      const k = document.createElement('span');
      k.className = 'ctx-key';
      k.textContent = it.key;
      b.appendChild(k);
    }
    if (!it.disabled) b.addEventListener('click', () => runItem(it));
    el.appendChild(b);
  });

  el.classList.remove('hidden');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  // 贴边时往里收，别跑出屏幕
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  el.style.left = Math.max(6, Math.min(x, vw - r.width - 6)) + 'px';
  el.style.top = Math.max(6, Math.min(y, vh - r.height - 6)) + 'px';
  isOpen = true;
  active = nextEnabled(-1, 1);
  paintActive();
}

export function closeMenu() {
  if (!el || !isOpen) return;
  isOpen = false;
  active = -1;
  el.classList.add('hidden');
  el.innerHTML = '';
}

function runItem(it) {
  closeMenu();
  try { it.onClick?.(); } catch (e) { console.error('[ctx]', e); }
}

function entryAt(i) { return items[i]; }
function selectable(i) {
  const it = entryAt(i);
  return !!it && !it.sep && !it.header && !it.disabled;
}
function nextEnabled(from, step) {
  for (let i = from + step; i >= 0 && i < items.length; i += step) {
    if (selectable(i)) return i;
  }
  return -1;
}
function move(step) {
  const n = nextEnabled(active, step);
  if (n >= 0) { active = n; paintActive(); }
}
function paintActive() {
  el.querySelectorAll('.ctx-item').forEach(b => {
    b.classList.toggle('active', +b.dataset.idx === active);
  });
}
function activate() {
  const it = entryAt(active);
  if (it && !it.disabled) runItem(it);
}
