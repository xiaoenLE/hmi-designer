/**
 * colResize.js — 表格「列宽可拖 + 一列自动填充（表格永远铺满面板）」（报警表 / 变量表共用）
 *
 * 用法：表里先写一个 `<colgroup>`（列数 = 表头列数），建完表之后调一次
 *   `initColResize(table, { minWidths, storageKey, flexCol, autoFit, defFrac })`
 * 表头每列右边缘长出一个把手：按住左右拖 = 调这一列的宽度；双击 = 恢复默认。
 *
 * ── 现场两句话就说明白 ──
 *   ① 拖过的列：**拖多少就是多少**（别的列不动）
 *   ② flexCol 那一列（变量表=地址、报警表=内容）：**自动吃掉剩下的宽度**，所以它没把手 ——
 *      想让地址宽一点，就把名称拖宽/拖窄，它自己让位。
 *
 * ── 为什么要切 table-layout: fixed ──
 *   原来的 auto 布局（列宽按内容定）有两个毛病：
 *     · 给列写 width 只是"建议值" —— 内容比它宽就把列顶回去，**拖不动**；
 *     · 有一列内容特别长（OPC UA 的长 NodeId、变量名）时，整张表被顶得比面板还宽 ——
 *       现场表现就是**最右边那列（保持）被面板边界切掉**，得横向滚动才看得见。
 *   切成 fixed 之后列宽由我们说了算，长内容在格子里省略号（输入框和内容格本来就有省略号）。
 *
 * ── autoFit：表格永远等于面板宽度 ──
 *   autoFit=true（变量表）：**一建表就按面板宽度排好** —— 没拖过的列用默认宽
 *     （minWidths 或 defFrac 给的百分比，如名称占 34%），剩下的全给填充列；
 *     面板拉宽/收窄时用 ResizeObserver 重算，所以"它自己会填、永远不切边"。
 *   autoFit=false（报警表）：没拖过之前保持原来的 auto 布局（那张表列多，
 *     本来就靠横向滚动看，默认长相不动），第一次拖才切成 fixed。
 *
 * ── 填充列为什么用 JS 算，而不是留个 <col> 不写宽度 ──
 *   实测（Chromium）：fixed 布局下留一列不写宽度时，
 *     · 其它列总宽 < 面板宽 → 那一列吃掉剩余（想要的效果）
 *     · 其它列总宽 > 面板宽 → 那一列被压成 **0 宽**（整列凭空消失）
 *   所以这里自己算：填充列 = max(它的最小宽, 面板宽 - 其它列之和)，并给表格写死总宽。
 *   （表格总宽也不能靠 CSS 的 `width: max-content`：fixed 布局下它仍会去量内容，
 *     内容长的那列会把整表白撑大 —— 实测踩过。）
 *
 * 宽度存 localStorage：**本机的编辑习惯**（跟面板折叠状态、画布缩放倍率一样），
 * 不写进工程文件 —— 换台机器打开同一个工程，列宽回到默认。
 */

/** @param {HTMLTableElement} table
 *  @param {{
 *    minWidths?: number[],     每列的最小宽度（拖到底也不会比这更窄）
 *    storageKey?: string,      存哪儿（localStorage）
 *    flexCol?: number,         自动填充列下标（-1 = 不设）
 *    autoFit?: boolean,        一建表就按面板宽度排（默认 false = 等第一次拖）
 *    defFrac?: number[],       没拖过的列按"面板宽的百分之几"给默认宽（0 = 用 minWidths）
 *    noGrip?: number[],        额外不给把手的列
 *  }} opts */
export function initColResize(table, opts = {}) {
  if (!table) return;
  const { minWidths = [], storageKey = 'hmi-colw', flexCol = -1, autoFit = false, defFrac = [], noGrip = [] } = opts;
  const cols = [...table.querySelectorAll('colgroup col')];
  const ths = [...table.querySelectorAll('thead th')];
  // 没写 colgroup 或列数对不上 → 不动它（结构对不上的表，硬塞宽度只会更乱）
  if (!cols.length || cols.length !== ths.length) return;
  if (flexCol >= cols.length) return;

  const minOf = (i) => Math.max(16, Math.round(+minWidths[i] || 24));
  const no = new Set([0, flexCol, ...noGrip]);
  let w = null;                    // **用户拖过的宽度**（0 = 没拖过）；实际渲染宽度每次现算

  /* ── 存 / 取（只存用户拖过的，填充列不存：它由面板宽度算出来） ── */
  const load = () => {
    try {
      const a = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return Array.isArray(a) && a.length === cols.length ? a.map(n => Math.max(0, Math.round(+n || 0))) : null;
    } catch { return null; }
  };
  const save = () => {
    try {
      const out = (w || []).map((n, i) => (i === flexCol ? 0 : n));
      if (out.some(n => n > 0)) localStorage.setItem(storageKey, JSON.stringify(out));
      else localStorage.removeItem(storageKey);      // 全还原了就把记录删掉
    } catch { /* 无痕模式之类：存不了就算了，不影响这次拖 */ }
  };

  /** 表格该占多宽 = 最近的那个可滚动祖先的**内容区**宽度（减掉它自己的左右内边距和表格左右边框）。
   *  ⚠ 内边距一定要减：面板 body 有 10px 左右内边距，不减的话表格比可见区宽 20px ——
   *    正好把最右边那列切掉、还多出一条横向滚动条（现场就是这么报的）。 */
  const availWidth = () => {
    for (let el = table.parentElement; el; el = el.parentElement) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        return Math.max(0, Math.round(el.clientWidth - pad - 2));
      }
    }
    return Math.max(0, (table.parentElement?.clientWidth || 0) - 2);
  };
  const scroller = () => {
    for (let el = table.parentElement; el; el = el.parentElement) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return el;
    }
    return table.parentElement;
  };
  /** 这一列没被拖过时的默认宽：给了百分比就按面板宽算（如名称=34%），否则用最小宽 */
  const defOf = (i, avail) => {
    const f = +defFrac[i] || 0;
    return f > 0 ? Math.max(minOf(i), Math.round(avail * f)) : minOf(i);
  };

  /** 排一次：算各列宽度 → 写进 <colgroup> → 给表格写死总宽。
   *  ⚠ **算出来跟上次一样就一个字节都不写**：ResizeObserver 会在面板尺寸变化时回调，
   *    每次都重写一遍样式会让表格反复失效重排（滚动时看着像"行叠在一起"的重影）。 */
  let lastSig = '';
  const layout = () => {
    if (!w) return;
    const managed = autoFit || table.classList.contains('cols-fixed');
    if (!managed) return;                        // 没拖过、又不开 autoFit：布局交给原来的 auto
    const avail = availWidth();
    if (!avail) return;                          // 面板这会儿不可见（量出来是 0）：等 ResizeObserver 再算
    const cur = cols.map((_, i) => (i === flexCol ? 0 : (w[i] > 0 ? w[i] : defOf(i, avail))));
    let others = 0;
    cur.forEach((n, i) => { if (i !== flexCol) others += n; });
    if (flexCol >= 0) cur[flexCol] = Math.max(minOf(flexCol), Math.round(avail - others));
    const total = cur.reduce((a, b) => a + b, 0);
    const sig = cur.join(',') + '|' + total;
    if (sig === lastSig) return cur;             // 没变化：不碰 DOM
    lastSig = sig;
    cols.forEach((c, i) => { c.style.width = cur[i] + 'px'; });
    table.classList.add('cols-fixed');
    table.style.width = total + 'px';            // 总宽写死：内容再长也只是省略号
    return cur;
  };

  /** 还原默认（双击把手）：清掉拖过的宽度，按默认重排 */
  const reset = () => {
    w = cols.map(() => 0);
    lastSig = '';
    if (!autoFit) {
      table.classList.remove('cols-fixed');
      table.style.width = '';
      cols.forEach(c => { c.style.width = ''; });
    } else {
      layout();
    }
    save();
  };

  w = load() || cols.map(() => 0);
  if (autoFit) layout();                          // 变量表：一建表就按面板宽度排好
  else cols.forEach((c, i) => { c.style.width = w[i] > 0 ? w[i] + 'px' : ''; });

  /* ── 表头上的拖拽把手 ── */
  ths.forEach((th, i) => {
    if (no.has(i)) return;
    const g = document.createElement('span');
    g.className = 'col-grip';
    g.title = '拖动调整这一列的宽度；双击 = 恢复默认宽度';
    g.addEventListener('pointerdown', e => startDrag(e, g, i));
    g.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); reset(); });
    th.appendChild(g);
  });

  /* 面板宽度变了（停靠切换、窗口缩放、面板被拉宽）→ 重排一次，永远铺满、不切边 */
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => layout());
    ro.observe(scroller());
  }

  /** 拖第 i 列的右边界：只动这一列，别的列一点不变（填充列跟着让位） */
  function startDrag(e, grip, i) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    // 第一次拖（而且没开 autoFit）：把每列当前的真实宽度量下来当基准（auto → fixed 视觉上不跳）；
    // 量到 0 说明表当时不可见，用最小宽兜底
    if (!w.some(n => n > 0)) {
      w = ths.map((t, k) => {
        const n = Math.round(t.getBoundingClientRect().width);
        return k === flexCol ? 0 : (n > 0 ? n : minOf(k));
      });
    }
    const cur = layout() || cols.map((_, k) => w[k] || minOf(k));
    const x0 = e.clientX, w0 = cur[i];
    grip.classList.add('on');
    document.body.classList.add('col-resizing');
    const move = ev => {
      w[i] = Math.max(minOf(i), Math.round(w0 + (ev.clientX - x0)));
      layout();                                   // 填充列实时跟着让位
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      grip.classList.remove('on');
      document.body.classList.remove('col-resizing');
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
}
