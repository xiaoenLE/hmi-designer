/**
 * xyplot.js — XY 波形 控件定义（独立控件，不挤在「波形」的模式里）
 *
 * 现场要的：X 轴自己选变量、至少 2 对 X/Y 两两组合、还要支持**数组描点**
 * （PLC 一次下发一整条轨迹数组时，按 index 配对整条画，不靠逐拍累加，所以不丢帧、不变形）。
 *
 *   · 标量对：每 sampleMs 读一次 api.get(X)/api.get(Y)，把 (x,y) 追加进该对缓冲（只留最近 points 个）画折线；
 *   · 数组对：X、Y 当前值**都是数组**时进数组模式 —— 每帧按 index 配对画整条曲线
 *     （min(lenX,lenY)，超 20000 点按步长抽样），**不累加**（数组一变整条刷新）。
 *   · 自绘控件（selfDrawn）：render 只给 canvas 容器 + 编辑态的静态网格示意；
 *     运行态画图全在 attach(el,w,api) 里用 rAF 逐帧画，元素不在文档里就自己停。
 *
 * ⚠ def 里**禁止 `?.`**（MCP 静态提取器会崩）；属性面板**不写 hint**（现场要求）。
 */
import { register } from '../registry.js';

/** 每对一色（按 pair 序号取） */
const XY_PALETTE = ['#38bdf8', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb7185', '#a3e635'];
const MAX_PAIRS = 8;
/** 数组模式单对最多按这么多点画（超了按步长抽样；画布就几百像素，再细也看不出来） */
const MAX_ARRAY_POINTS = 20000;

/** 采样值转数字：bool → 0/1；空/非法 → NaN */
function numOf(raw) {
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (raw === null || raw === undefined || raw === '') return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}
/** 数字属性收敛到 [lo,hi]；非法/缺省用 dflt */
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
/** 解析「一行一对 X变量,Y变量」：逗号/中文逗号/分号/空格都认；空行、不是正好两个名字的行跳过；最多 8 对 */
function parsePairs(raw) {
  const out = [];
  const lines = String(raw == null ? '' : raw).split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < MAX_PAIRS; i++) {
    const line = String(lines[i] == null ? '' : lines[i]).trim();
    if (!line) continue;
    const tok = line.split(/[,，;；\s]+/).filter(function (t) { return t !== ''; });
    if (tok.length !== 2) continue;
    out.push({ x: tok[0], y: tok[1] });
  }
  return out;
}
/** 运行态采集范围：pairs 里出现的 X/Y 变量名（见 register 里的 scopeVars） */
function scopeVarsOf(w) {
  const p = w && w.props;
  const pairs = parsePairs(p && p.pairs);
  const names = [];
  for (let i = 0; i < pairs.length; i++) { names.push(pairs[i].x, pairs[i].y); }
  return names;
}
/** 新的一对（标量缓冲从空开始） */
function newPair(pr) {
  return {
    x: pr.x, y: pr.y, kind: 'scalar',
    buf: [],            // 标量模式：最近 points 个 {x, y}
    arrX: [], arrY: [], // 数组模式：当前这一拍的整条数组（不累加）
    n: 0, lastX: NaN, lastY: NaN,
  };
}

/** 所有对在某个轴上的数据 min/max（数组按抽样后算；空 = null） */
function dataMinMax(state, axis) {
  let mn = Infinity, mx = -Infinity;
  const take = function (v) {
    if (!Number.isFinite(v)) return;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  };
  state.pairs.forEach(function (pair) {
    if (pair.kind === 'array') {
      const n = pair.n;
      if (n <= 0) return;
      const step = n > MAX_ARRAY_POINTS ? Math.ceil(n / MAX_ARRAY_POINTS) : 1;
      for (let i = 0; i < n; i += step) take(numOf(axis === 'x' ? pair.arrX[i] : pair.arrY[i]));
      // 抽样可能跳过最后一点：补上（最新值一定要参与范围）
      take(numOf(axis === 'x' ? pair.arrX[n - 1] : pair.arrY[n - 1]));
    } else {
      pair.buf.forEach(function (pt) { take(axis === 'x' ? pt.x : pt.y); });
    }
  });
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null;
  return [mn, mx];
}
/** 自动范围：数据 min/max 留 5% 余量；没数据给 0~1 */
function autoRange(state, axis) {
  const mm = dataMinMax(state, axis);
  if (!mm) return [0, 1];
  let mn = mm[0], mx = mm[1];
  if (mn === mx) { mn -= 1; mx += 1; }
  const pad = (mx - mn) * 0.05;
  return [mn - pad, mx + pad];
}
/** 某个轴最终用的范围：自动 或 props 固定值 */
function axisRange(p, state, axis, autoKey, minKey, maxKey) {
  if (p[autoKey] !== false) return autoRange(state, axis);
  let lo = Number(p[minKey]);
  let hi = Number(p[maxKey]);
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  return [lo, hi];
}
/** 刻度/图例数字格式化 */
function fmtNum(v, decimals) {
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(Math.max(0, Math.min(6, decimals)));
}
/** 圆角矩形路径（不用 ctx.roundRect，老 Chromium / 控件包里也稳） */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * 画一帧（canvas 尺寸按 CSS 像素 × dpr 跟着控件走）。
 * 范围算完写回 state（el.__xyState() 每帧拿到最新范围）。
 */
function drawPlot(canvas, ctx, w, state) {
  const p = w.props || {};
  const host = canvas.parentElement;
  let cw = host ? host.clientWidth : 0;
  let ch = host ? host.clientHeight : 0;
  if (!cw) cw = w.w;
  if (!ch) ch = w.h;
  const cssW = Math.max(20, cw);
  const cssH = Math.max(20, ch);
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const radius = clampNum(p.radius, 0, 60, 6);
  const bg = p.bgColor || '#0f172a';
  // 背景（带圆角）
  roundRectPath(ctx, 0, 0, cssW, cssH, radius);
  ctx.fillStyle = bg;
  ctx.fill();
  const bdW = clampNum(p.borderWidth, 0, 12, 0);
  if (bdW > 0) {
    ctx.lineWidth = bdW;
    ctx.strokeStyle = p.borderColor || '#334155';
    ctx.stroke();
  }

  const showLegend = p.showLegend !== false;
  const padL = 46, padR = 12, padB = 18;
  const padT = showLegend ? 22 : 8;
  const plotW = Math.max(10, cssW - padL - padR);
  const plotH = Math.max(10, cssH - padT - padB);

  const xr = axisRange(p, state, 'x', 'autoX', 'xMin', 'xMax');
  const yr = axisRange(p, state, 'y', 'autoY', 'yMin', 'yMax');
  state.xMin = xr[0]; state.xMax = xr[1];
  state.yMin = yr[0]; state.yMax = yr[1];
  const X = function (v) { return padL + ((v - xr[0]) / (xr[1] - xr[0])) * plotW; };
  const Y = function (v) { return padT + (1 - (v - yr[0]) / (yr[1] - yr[0])) * plotH; };
  const decimals = clampNum(p.decimals, 0, 6, 1);

  // 网格 + 刻度（左右各 5 档，共用网格线）
  if (p.showGrid !== false) {
    const grid = p.gridColor || '#1e3a5f';
    const text = p.textColor || '#cbd5e1';
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = text;
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillText(fmtNum(yr[1] - ((yr[1] - yr[0]) * i) / 4, decimals), padL - 5, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const x = padL + (plotW * i) / 4;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillText(fmtNum(xr[0] + ((xr[1] - xr[0]) * i) / 4, decimals), x, padT + plotH + 3);
    }
  }

  // 曲线 + 圆点（每对一色）
  const lineW = clampNum(p.lineWidth, 1, 12, 2);
  const pointSize = clampNum(p.pointSize, 0, 12, 2);
  state.pairs.forEach(function (pair, idx) {
    const color = XY_PALETTE[idx % XY_PALETTE.length];
    const arrMode = pair.kind === 'array';
    let count = 0;
    const each = function (fn) {
      if (arrMode) {
        const n = pair.n;
        if (n <= 0) return;
        const step = n > MAX_ARRAY_POINTS ? Math.ceil(n / MAX_ARRAY_POINTS) : 1;
        let last = -1;
        for (let i = 0; i < n; i += step) { last = i; fn(i); }
        if (last !== n - 1) fn(n - 1);
      } else {
        for (let i = 0; i < pair.buf.length; i++) fn(i);
      }
    };
    const px = function (i) {
      if (arrMode) return numOf(pair.arrX[i]);
      const pt = pair.buf[i];
      return pt ? pt.x : NaN;
    };
    const py = function (i) {
      if (arrMode) return numOf(pair.arrY[i]);
      const pt = pair.buf[i];
      return pt ? pt.y : NaN;
    };
    // 折线
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    each(function (i) {
      const x = px(i), y = py(i);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { started = false; return; }
      const sx = X(x), sy = Y(y);
      if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
      count++;
    });
    ctx.stroke();
    // 圆点（pointSize=0 只画线；数组描点尤其需要点）
    if (pointSize > 0) {
      ctx.fillStyle = color;
      each(function (i) {
        const x = px(i), y = py(i);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        ctx.beginPath();
        ctx.arc(X(x), Y(y), pointSize, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    pair.n = count;
  });

  // 图例：X名→Y名，数组对后面标「数组」
  if (showLegend) {
    const fs = 11;
    ctx.font = fs + 'px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let lx = padL;
    const ly = Math.max(10, padT / 2 + 1);
    state.pairs.forEach(function (pair, idx) {
      const txt = pair.x + '→' + pair.y + (pair.kind === 'array' ? ' 数组' : '');
      const tw = ctx.measureText(txt).width;
      if (lx + tw + 18 > cssW - padR) return;
      ctx.fillStyle = XY_PALETTE[idx % XY_PALETTE.length];
      ctx.fillRect(lx, ly - 3, 6, 6);
      ctx.fillStyle = p.textColor || '#cbd5e1';
      ctx.fillText(txt, lx + 10, ly);
      lx += tw + 22;
    });
  }
}

register({
  type: 'xyplot',
  title: 'XY 波形',
  sub: '多对 X/Y 两两组合 · 可数组描点',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="5" width="28" height="26" rx="3" fill="#0f172a" stroke="#334155"/><path d="M8 27h24M8 27V7" stroke="#475569" stroke-width="1"/><path d="M10 24c4-1 5-8 8-9s4 6 7 4 4-7 7-9" fill="none" stroke="#38bdf8" stroke-width="2"/><circle cx="18" cy="15" r="1.6" fill="#fbbf24"/><circle cx="25" cy="19" r="1.6" fill="#4ade80"/></svg>',
  // 自绘：运行态不重建 DOM（attach 里自己逐帧画 canvas）
  selfDrawn: true,
  defaults: {
    w: 420, h: 280,
    pairs: '',
    sampleMs: 100, points: 2000,
    autoX: true, xMin: 0, xMax: 100,
    autoY: true, yMin: 0, yMax: 100,
    showGrid: true, showLegend: true,
    lineWidth: 2, pointSize: 2, decimals: 1,
    bgColor: '#0f172a', gridColor: '#1e3a5f', textColor: '#cbd5e1',
    borderColor: '#334155', borderWidth: 1, radius: 6,
  },
  props: [
    // 一行一对：X变量,Y变量（逗号/中文逗号/空格都认；空行、不是两个名字的行跳过；最多 8 对）
    { key: 'pairs', label: 'X/Y 变量对', type: 'textarea', rows: 5,
      placeholder: '一行一对：X变量,Y变量\n例如：\nrX,rY\nrX2,rY2' },
    { key: 'sampleMs', label: '刷新间隔ms', type: 'number', min: 33, max: 2000, defVal: 100 },
    { key: 'points', label: '标量点数', type: 'number', min: 100, max: 50000, defVal: 2000 },
    // 坐标范围（单独一栏）
    { key: 'autoX', label: 'X 轴自动', type: 'check', defVal: true, group: '坐标范围' },
    { key: 'xMin', label: 'X 最小', type: 'number', group: '坐标范围' },
    { key: 'xMax', label: 'X 最大', type: 'number', group: '坐标范围' },
    { key: 'autoY', label: 'Y 轴自动', type: 'check', defVal: true, group: '坐标范围' },
    { key: 'yMin', label: 'Y 最小', type: 'number', group: '坐标范围' },
    { key: 'yMax', label: 'Y 最大', type: 'number', group: '坐标范围' },
    { key: 'showGrid', label: '显示网格', type: 'check', defVal: true },
    { key: 'showLegend', label: '显示图例', type: 'check', defVal: true },
    { key: 'lineWidth', label: '线宽', type: 'number', min: 1, max: 12 },
    { key: 'pointSize', label: '圆点大小', type: 'number', min: 0, max: 12, defVal: 2 },
    { key: 'decimals', label: '小数位', type: 'number', min: 0, max: 6 },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'gridColor', label: '网格色', type: 'color' },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 12 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 60 },
  ],
  binding: null,
  actions: [],
  /**
   * 运行态「本页采集范围」要收进来的变量（runtime.js 的 collectPageVars 会问每个控件要）。
   * X/Y 变量都写在**文本属性 pairs** 里，不占 bindings —— 不收进来的话接真 PLC 时这些变量
   * 不在轮询范围，`api.get` 永远拿不到值（标量/数组都画不出数据）。
   * ⚠ 实现放在 register 外面的模块级函数：hmi-mcp 的静态提取器扫 register({...}) 时，
   *   方法体里的 `try/catch`/多余写法会把后面的 props 整块吃掉（props 变空）。放外面就没事。
   */
  scopeVars: scopeVarsOf,
  /**
   * render 只给 canvas 容器；编辑态用**内联 CSS 网格**画个静态示意（不靠 JS，选中/拖动都不影响）。
   * 运行态由 attach 逐帧画，会把这块 CSS 背景盖掉。
   */
  render(w, mode) {
    const p = (w && w.props) || {};
    const bg = p.bgColor || '#0f172a';
    const grid = p.gridColor || '#1e3a5f';
    const bdColor = p.borderColor || '#334155';
    const bdW = clampNum(p.borderWidth, 0, 12, 1);
    const r = clampNum(p.radius, 0, 60, 6);
    const canvasStyle = 'display:block;width:100%;height:100%;'
      + 'background-color:' + bg + ';'
      + 'background-image:linear-gradient(to right,' + grid + ' 1px,transparent 1px),'
      + 'linear-gradient(to bottom,' + grid + ' 1px,transparent 1px);'
      + 'background-size:32px 32px;';
    return '<div class="wxy" style="position:relative;width:100%;height:100%;box-sizing:border-box;'
      + 'border:' + bdW + 'px solid ' + bdColor + ';border-radius:' + r + 'px;overflow:hidden">'
      + '<canvas class="wxy-cv" style="' + canvasStyle + '"></canvas></div>';
  },
  /**
   * 运行态：rAF 逐帧读值 + 画图。
   *  · 标量对：每 sampleMs 追加 (x,y)，留最近 points 个；
   *  · 数组对：每帧按 index 配对画整条（min(lenX,lenY)，>20000 点抽样），不累加；
   *  · el.__xyState()：给回归套件/现场调试看的快照（每帧更新范围）；
   *  · 元素不在文档里（退出运行/换页）→ 下一帧自己停。
   */
  attach(el, w, api) {
    const canvas = el.querySelector('canvas.wxy-cv');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const state = {
      pairs: [], raw: '\u0000',
      xMin: 0, xMax: 1, yMin: 0, yMax: 1,
      lastAt: 0,
    };
    // 测试/调试钩子：pairs 的 kind/n/lastX/lastY + 当前四边范围
    el.__xyState = function () {
      return {
        pairs: state.pairs.map(function (pair) {
          return { x: pair.x, y: pair.y, kind: pair.kind, n: pair.n, lastX: pair.lastX, lastY: pair.lastY };
        }),
        xMin: state.xMin, xMax: state.xMax, yMin: state.yMin, yMax: state.yMax,
      };
    };
    let raf = 0;
    const frame = function () {
      if (!el.isConnected) { raf = 0; return; }          // 退出运行/换页：停掉自己
      const p = w.props || {};
      const now = performance.now();
      // pairs 改了才重解析（同名对复用旧缓冲，改一个名字不会把别的对清空）
      const raw = String(p.pairs == null ? '' : p.pairs);
      if (raw !== state.raw) {
        state.raw = raw;
        const old = {};
        state.pairs.forEach(function (pair) { old[pair.x + '\u0000' + pair.y] = pair; });
        state.pairs = parsePairs(raw).map(function (pr) {
          const hit = old[pr.x + '\u0000' + pr.y];
          return hit || newPair(pr);
        });
      }
      const sampleMs = clampNum(p.sampleMs, 33, 2000, 100);
      const doSample = now - state.lastAt >= sampleMs;
      if (doSample) state.lastAt = now;
      const points = Math.round(clampNum(p.points, 100, 50000, 2000));
      state.pairs.forEach(function (pair) {
        const vx = api.get(pair.x);
        const vy = api.get(pair.y);
        if (Array.isArray(vx) && Array.isArray(vy)) {
          // 数组描点：整条数组就是当前这一帧的曲线，不累加（数组一变整条刷新，不会丢帧变形）
          pair.kind = 'array';
          pair.arrX = vx;
          pair.arrY = vy;
          if (pair.buf.length) pair.buf.length = 0;
          const n = Math.min(vx.length, vy.length);
          pair.n = n;
          pair.lastX = n > 0 ? numOf(vx[n - 1]) : NaN;
          pair.lastY = n > 0 ? numOf(vy[n - 1]) : NaN;
        } else {
          pair.arrX = [];
          pair.arrY = [];
          if (pair.kind !== 'scalar') { pair.kind = 'scalar'; pair.buf.length = 0; }
          const x = numOf(vx), y = numOf(vy);
          pair.lastX = x;
          pair.lastY = y;
          if (doSample && Number.isFinite(x) && Number.isFinite(y)) {
            pair.buf.push({ x: x, y: y });
            if (pair.buf.length > points) pair.buf.splice(0, pair.buf.length - points);
          }
          pair.n = pair.buf.length;
        }
      });
      drawPlot(canvas, ctx, w, state);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  },
});
