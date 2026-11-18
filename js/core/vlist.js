/**
 * vlist.js — 长列表「窗口化」渲染（变量表 / 变量监控 / 控件清单共用）
 *
 * 为什么需要：变量能到上万个，一次把 1 万行 DOM 建出来要 9 秒（实测），
 * 之后每敲一个字符再重建一次 → 完全没法用。这里只渲染**可视区那几十行**，
 * 上下各放一块撑高的占位，滚动时按 scrollTop 换窗口 —— 列表长度从几十到几万开销基本一样。
 *
 * 用法：
 *   const vl = createVList({
 *     scroller,                    // 滚动容器（.panel-body 之类）
 *     host,                        // 行挂在哪（tbody 或某个 div）
 *     rowH: 28,                    // 行高（固定；第一次渲染后会按实测校准）
 *     makePad: h => 占位元素,       // 表格给 <tr>，div 列表给 <div>
 *     renderRow: (item, i) => element,
 *     keyOf: item => string,       // 用来在重绘后找回「正在编辑的那一行」
 *   });
 *   vl.setItems(list);             // 换数据（内部会重算窗口）
 *   vl.refresh();                  // 数据没换、但行内容要重画（重绘当前窗口）
 *   vl.destroy();
 *
 * 两个坑（都踩过）：
 *   · 行高必须固定：滚动位置 = 行号 × 行高，行高一变窗口就会跳；
 *   · 正在输入的那一行不能被回收：否则打字打到一半 DOM 被换掉，光标和没提交的内容就没了。
 */
const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

export function createVList({ scroller, host, rowH = 28, buffer = 5, makePad, renderRow, keyOf, minForWindow = 200 }) {
  let items = [];
  let measured = rowH;
  let start = 0;
  let end = 0;
  let scheduled = false;

  const focusedKey = () => {
    const el = document.activeElement;
    if (!el || !host.contains(el)) return null;
    const row = el.closest('[data-vrow]');
    return row ? row.dataset.vrow : null;
  };

  /** host 在滚动内容里的纵向位置（host 上方还有筛选框之类的东西） */
  function hostTop() {
    const r = host.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return r.top - s.top + scroller.scrollTop;
  }

  function windowRange() {
    const top = Math.max(0, scroller.scrollTop - hostTop());
    const viewH = scroller.clientHeight;
    let i0 = Math.max(0, Math.floor(top / measured) - buffer);
    let i1 = Math.min(items.length, Math.ceil((top + viewH) / measured) + buffer);
    // 正在编辑的行必须在窗口里（顺手把它包进来）
    const key = focusedKey();
    if (key) {
      const idx = items.findIndex(it => keyOf(it) === key);
      if (idx >= 0) { i0 = Math.min(i0, idx); i1 = Math.max(i1, idx + 1); }
    }
    return [i0, Math.max(i1, i0)];
  }

  function paint() {
    scheduled = false;
    if (items.length <= minForWindow) {          // 短列表直接全画，省得折腾占位
      start = 0; end = items.length;
    } else {
      [start, end] = windowRange();
    }
    const frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(makePad(start * measured));
    const probe = [];                            // 先量一行真实高度再决定后面
    for (let i = start; i < end; i++) {
      const el = renderRow(items[i], i);
      el.dataset.vrow = keyOf(items[i]);
      frag.appendChild(el);
      if (probe.length < 1) probe.push(el);
    }
    if (end < items.length) frag.appendChild(makePad((items.length - end) * measured));
    host.innerHTML = '';
    host.appendChild(frag);
    // 校准行高：行高跟假设差得多的话，滚动窗口会越滚越偏
    if (items.length > minForWindow && probe[0]) {
      const h = probe[0].getBoundingClientRect().height;
      if (h > 4 && Math.abs(h - measured) > 0.5) measured = h;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    raf(paint);
  }

  const onScroll = () => {
    if (items.length <= minForWindow) return;
    const [i0, i1] = windowRange();
    if (i0 === start && i1 === end) return;      // 窗口没变就别重建（滚动平滑）
    schedule();
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', schedule);

  // 面板切到别的页签时是 display:none —— 那时量出来的高度是 0，窗口会算成「只有头几行」，
  // 再切回来又不滚动 → 表里只剩几行（像丢了数据）。高度一变就重算窗口。
  let lastH = -1;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    const h = entries[0].contentRect.height;
    if (Math.abs(h - lastH) < 0.5) return;
    lastH = h;
    schedule();
  }) : null;
  try { ro?.observe(host); } catch (e) { /* 老浏览器没有就算了，不影响滚动换窗口 */ }

  return {
    setItems(list) { items = list || []; schedule(); },
    refresh() { schedule(); },
    get count() { return items.length; },
    get window() { return [start, end]; },
    destroy() {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', schedule);
      try { ro?.disconnect(); } catch (e) { /* ignore */ }
      host.innerHTML = '';
    },
  };
}
