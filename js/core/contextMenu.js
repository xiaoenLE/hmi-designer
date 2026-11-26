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
let anchor = null;

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
 * @param {Array} list 同 registerContextMenu 的 items 结构，可为条目指定图标
 * @param {{anchor?: HTMLElement, align?: 'start'|'end'}} opts 下拉菜单的触发按钮与对齐方向
 */
export function openAt(x, y, list, { anchor: trigger = null, align = 'start' } = {}) {
  if (!el || !Array.isArray(list) || !list.length) return;
  if (anchor && anchor === trigger) { closeMenu(true); return; }
  openMenu(x, y, list, trigger, align);
}

export function initContextMenu(opts = {}) {
  allowNativeInInputs = opts.allowNativeInInputs !== false;
  el = document.getElementById('ctxMenu');
  if (!el) return;

  document.addEventListener('contextmenu', onContextMenu);
  // 点别处/按 Esc/滚动/窗口变化都关掉（capture 阶段先关，菜单内部的点击不受影响）
  document.addEventListener('pointerdown', e => {
    if (isOpen && !el.contains(e.target) && !anchor?.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', e => {
    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(true);
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' || (anchor && e.key === ' ')) { e.preventDefault(); activate(); }
  }, true);
  window.addEventListener('blur', () => closeMenu());
  window.addEventListener('resize', () => closeMenu());
  window.addEventListener('wheel', e => {
    if (isOpen && !e.target.closest?.('#ctxMenu')) closeMenu();
  }, { passive: true, capture: true });
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

function openMenu(x, y, list, trigger = null, align = 'start') {
  closeMenu();
  anchor = trigger;
  el.dataset.kind = anchor ? 'dropdown' : 'context';
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'true');
    el.setAttribute('aria-labelledby', anchor.id);
  }
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
    b.id = `ctxItem${i}`;
    b.tabIndex = -1;
    const checkable = typeof it.check === 'boolean';
    b.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
    if (checkable) b.setAttribute('aria-checked', String(it.check));
    if (it.description) {
      b.title = it.description;
      b.setAttribute('aria-description', it.description);
    }
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = it.label;               // textContent：控件名/变量名都可能是任意字符
    if (it.icon) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      const use = document.createElementNS(ns, 'use');
      svg.setAttribute('class', 'ui-icon ctx-icon');
      svg.setAttribute('aria-hidden', 'true');
      use.setAttribute('href', `#ui-${it.icon}`);
      svg.appendChild(use);
      b.appendChild(svg);
    } else {
      b.appendChild(menuCheck(it.check));
    }
    b.appendChild(label);
    if (it.icon && checkable) b.appendChild(menuCheck(it.check));
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
  const edge = 6;
  const vw = window.innerWidth, vh = window.innerHeight;
  el.style.maxHeight = `${Math.max(0, vh - edge * 2)}px`;
  if (anchor) {
    const bounds = anchor.getBoundingClientRect();
    const above = bounds.top - edge - 4;
    const below = vh - y - edge;
    const openDown = el.offsetHeight <= below || below >= above;
    el.style.maxHeight = `${Math.max(0, openDown ? below : above)}px`;
    if (!openDown) y = bounds.top - 4 - el.offsetHeight;
    if (align === 'end') x = bounds.right - el.offsetWidth;
  }
  el.style.left = `${Math.max(edge, Math.min(x, vw - el.offsetWidth - edge))}px`;
  el.style.top = `${Math.max(edge, Math.min(y, vh - el.offsetHeight - edge))}px`;
  el.scrollTop = 0;
  isOpen = true;
  active = anchor ? -1 : nextEnabled(-1, 1);
  paintActive();
  if (anchor) el.focus({ preventScroll: true });
}

function menuCheck(checked) {
  const mark = document.createElement('span');
  mark.className = 'ctx-check';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = checked ? '✓' : '';
  return mark;
}

export function closeMenu(restoreFocus = false) {
  if (!el || !isOpen) return;
  const trigger = anchor;
  anchor = null;
  isOpen = false;
  active = -1;
  trigger?.setAttribute('aria-expanded', 'false');
  el.removeAttribute('aria-labelledby');
  el.removeAttribute('aria-activedescendant');
  el.classList.add('hidden');
  el.innerHTML = '';
  if (restoreFocus === true) trigger?.focus({ preventScroll: true });
}

function runItem(it) {
  closeMenu(true);
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
  const start = active === -1 && step < 0 ? items.length : active;
  const n = nextEnabled(start, step);
  if (n >= 0) {
    active = n;
    paintActive();
    document.getElementById(`ctxItem${active}`)?.scrollIntoView({ block: 'nearest' });
  }
}
function paintActive() {
  el.querySelectorAll('.ctx-item').forEach(b => {
    b.classList.toggle('active', +b.dataset.idx === active);
  });
  if (active !== -1) el.setAttribute('aria-activedescendant', `ctxItem${active}`);
}
function activate() {
  const it = entryAt(active);
  if (it && !it.disabled) runItem(it);
}
