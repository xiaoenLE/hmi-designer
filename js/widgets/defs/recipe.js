/**
 * recipe.js — 配方 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 用途：现场把一整套参数（温度/速度/时间…）存成「配方」，换产品时一键应用。
 *   · 「配方变量」是一个多行文本属性 `varsText`（不占 bindings）：现场参数常常是一整段数组
 *     （v2 里数组是展开成 `rRecipe[1]…rRecipe[N]` 这些元素变量），一行一条：
 *       变量名              → 单个变量
 *       数组名              → 变量表里该数组的全部元素（按数字自然排序）
 *       数组名[起..止]      → 闭区间（只取变量表里存在的元素；起>止 自动交换）
 *     解析以 project.variables() 为准；认不出的行跳过并计数；最多 512 个（防手滑）。
 *     兼容老配置：widget 上已有的 `bindings.variables` 里非空变量追加到解析结果末尾
 *     （老工程打开不丢）。保存/应用时**每次重新解析**（变量表可能被改）。
 *   · 运行态 UI：配方名输入框 + 「保存当前」/「刷新」+ 配方列表（每行「应用」，可选的「删除」）+ 消息行；
 *     标题行右侧显示「N 个变量」（没配变量时显示「还没有配方变量」）。
 *   · 点某个配方行（行本体/名字，不是「应用」「删除」按钮）→ 选中高亮 + GET `/api/recipes?full=1`
 *     读出该配方存的 vars，下方画「数据表」：变量名只读 + 值（数值点开**控件内置小键盘**改，
 *     字符串/bool 用真 `<input>` 行内改，Enter/失焦确认）。改过的行进草稿并在旁边标「*」，
 *     数据表头有「保存修改」（ensureAdmin + confirm + POST save）和「还原修改」（重新从后端读）；
 *     有未保存改动时切换配方会 confirm。草稿/选中状态放模块级 Map，不写进 w.props。
 *   · 数据在后端（`/api/recipes`，见 server/core/recipe.py）：
 *       GET              → {ok, names, count}
 *       POST {action:'save',   name, vars} → {ok, name, count}
 *       POST {action:'apply',  name}       → {ok, applied:[..], failed:[{name,error}]}
 *       POST {action:'delete', name}       → {ok, deleted}
 *     读不用登录；存/删/应用要管理员（客户机运行页平时只读）→ 写操作前 `api.ensureAdmin(...)`；
 *     后端 401 时 rpc 抛的错带 `e.needLogin`，这里翻成人话显示在消息行（不静默）。
 *   · 列表/消息/忙碌状态放**模块级 Map**（widgetId → {names,msg,busy,...}）：不能塞进 w.props
 *     —— w 是要存进工程 JSON 的，运行态的临时状态不能跟着工程走。render 从这份状态画。
 *   · 运行态交互全部挂在 el（控件根 .wd）上做委托：refreshWidgetBody 只重建里面的 .body，
 *     绑在子元素上的监听会跟着 DOM 一起没（见 runtime.js 的 buildWidget / attach）。
 *   · 样式全部内联，不改公共 CSS；标题/占位等文字 props 声明 i18n 并用 tr 翻译。
 */
import { register, rutil } from '../registry.js';
const { escapeHtml } = rutil;
import { tr } from '../../core/i18n.js';
import { project } from '../../core/project.js';

/** 取整并夹在 [lo, hi]；认不出/缺键用 dflt（老工程缺键兜底） */
function intIn(v, dflt, lo, hi) {
  const n = Math.round(+v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 运行态状态：widgetId → { names, msg, busy, name, loaded }
 *   names  = 后端返回的配方名列表
 *   msg    = 消息行文字（成功/失败都给人话；'' = 不显示）
 *   busy   = 正在跟后端交互（按钮禁用，防连点）
 *   name   = 输入框里正在打的配方名（body 重画时保住已输入内容，不丢）
 *   loaded = 是否已经拉过一次列表
 * ⚠ 不挂到 w 上：w 存进工程 JSON，运行态临时状态不能跟着工程走。
 */
const STATES = new Map();
function stateOf(w) {
  let s = STATES.get(w.id);
  if (!s) {
    s = {
      names: [], msg: '', busy: false, name: '', loaded: false,
      // 选中配方后的「数据表」草稿（点配方行 → 读 /api/recipes?full=1 取这个配方存的 vars）
      sel: null,      // 当前选中的配方名
      keys: [],       // 数据表的变量名（= 该配方 vars 的键，保序）
      orig: null,     // 后端读回来的原值（还原用）
      draft: null,    // 正在编辑的草稿（保存修改用）
      dirty: false,   // 是否有未保存修改
      pad: null,      // 数值单元格的内置小键盘：{ i: 行号, buffer: '12.' }
    };
    STATES.set(w.id, s);
  }
  // 兼容老的运行态状态对象（同一个控件 id 在极端情况下可能先被旧版本建过）
  if (!Array.isArray(s.keys)) s.keys = [];
  if (s.orig === undefined) s.orig = null;
  if (s.draft === undefined) s.draft = null;
  if (s.sel === undefined) s.sel = null;
  if (s.pad === undefined) s.pad = null;
  if (s.dirty === undefined) s.dirty = false;
  return s;
}

/** 编辑态预览用的假配方名（只在组态画布上看结构，不参与运行） */
const PREVIEW_NAMES = ['配方 1', '配方 2'];

/** 配方变量上限（防手滑：一行写错范围也不至于把工程拖死） */
const VARS_MAX = 512;

/** 当前变量表里的变量名（project 还没载入时按空表算） */
function variableNames() {
  try {
    const list = project.variables();
    return Array.isArray(list) ? list.map(v => v.name) : [];
  } catch (e) {
    return [];
  }
}

/**
 * 解析「配方变量」文本（`varsText`）→ { names, skipped }
 *
 * 规则（一行一条，空行忽略）：
 *   ① `变量名`           → 单个变量（以变量表为准）
 *   ② `数组名`           → 变量表里 `^数组名\[数字\]$` 的全部元素，按数字自然排序
 *   ③ `数组名[起..止]`   → 闭区间（只取变量表里存在的元素；起>止 自动交换；按数字排序）
 * 认不出的行跳过并计数；结果按出现顺序去重；最多 VARS_MAX 个（超出截断）。
 * 老配置兼容：widget 上残留的 `bindings.variables` 非空变量追加到末尾。
 * @returns {{names: string[], skipped: number}}
 */
function parseRecipeVars(w) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name) || names.length >= VARS_MAX) return;
    seen.add(name);
    names.push(name);
  };
  const table = variableNames();
  const known = new Set(table);
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** 变量表里某个「数组名」的全部元素（^数组名[数字]$），数字自然排序 */
  const elementsOf = (base) => {
    const re = new RegExp('^' + esc(base) + '\\[(\\d+)\\]$');
    const hit = [];
    table.forEach((n) => {
      const m = re.exec(n);
      if (m) hit.push({ n: n, i: +m[1] });
    });
    hit.sort((a, b) => a.i - b.i);
    return hit.map(x => x.n);
  };
  const raw = String((w.props && w.props.varsText) || '');
  let skipped = 0;
  raw.split(/\r?\n/).forEach((line) => {
    if (names.length >= VARS_MAX) return;
    const s = line.trim();
    if (!s) return;
    const before = names.length;
    const range = /^(.+?)\[(\d+)\s*\.\.\s*(\d+)\]$/.exec(s);
    if (range) {
      let a = +range[2];
      let b = +range[3];
      if (a > b) { const t = a; a = b; b = t; }         // 起>止 自动交换
      const base = range[1].trim();
      // 闭区间只取**变量表里存在的元素**（数组可能只展开了一部分）
      for (let i = a; i <= b; i++) {
        const n = base + '[' + i + ']';
        if (known.has(n)) add(n);
      }
    } else if (known.has(s)) {
      add(s);                                            // ① 单个变量
    } else {
      elementsOf(s).forEach(add);                        // ② 整组数组名
    }
    // 这一行一个都没解析出来（名字不存在 / 区间里没有元素）→ 跳过并计数
    if (names.length === before) skipped++;
  });
  // 兼容老配置：老工程/老编辑面板配的 bindings.variables（非空）追加到末尾
  const legacy = (w.bindings && Array.isArray(w.bindings.variables)) ? w.bindings.variables : [];
  legacy.forEach(n => add(n));
  return { names: names, skipped: skipped };
}

/** 渲染时用的一小段：变量名列表 + 认不出的行数 */
function recipeVarInfo(w) {
  return parseRecipeVars(w);
}

register({
  type: 'recipe',                  // ⚠ 永久 id：存进工程 JSON，定了别再改
  title: '配方',
  sub: '保存/应用整套参数',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="4" width="26" height="28" rx="3" fill="#fff" stroke="#94a3b8"/><rect x="9" y="8" width="18" height="4" rx="1" fill="#2563eb"/><path d="M9 17h13M9 22h13M9 27h9" stroke="#c3cbd6" stroke-width="2" stroke-linecap="round"/><circle cx="27" cy="24" r="6" fill="#22c55e"/><path d="M24.6 24l1.7 1.7 3.2-3.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  defaults: {
    w: 360, h: 280,
    title: '配方',
    varsText: '',                  // 配方变量：一行一条（变量名 / 数组名 / 数组名[起..止]）
    showList: true,                // 显示配方列表
    showSave: true,                // 显示「保存当前」按钮
    showRefresh: true,             // 显示「刷新」按钮
    allowDelete: false,            // 允许删除配方（默认关：现场误删一整套参数代价很大）
    namePlaceholder: '配方名…',
    rowH: 30, fontSize: 14,
    textColor: '#1f2329', bgColor: '#ffffff', headerBg: '#eef2f7', lineColor: '#c3cbd6',
    radius: 4,
  },
  props: [
    { key: 'title', label: '标题', type: 'text', i18n: 'text' },
    // 配方变量：普通多行文本（不写 hint；写法示例放 placeholder）——一行一条，支持数组名与 [起..止]
    { key: 'varsText', label: '配方变量', type: 'textarea', rows: 6,
      placeholder: '一行一条：\n变量名\n数组名（整组）\n数组名[起..止]（如 调速参数[1..20]）' },
    { key: 'showList', label: '显示配方列表', type: 'check', defVal: true },
    { key: 'showSave', label: '显示保存当前', type: 'check', defVal: true },
    { key: 'showRefresh', label: '显示刷新', type: 'check', defVal: true },
    { key: 'allowDelete', label: '允许删除', type: 'check', defVal: false },
    { key: 'namePlaceholder', label: '配方名占位', type: 'text', i18n: 'text' },
    { key: 'rowH', label: '行高', type: 'number', min: 18, max: 80 },
    { key: 'fontSize', label: '字号', type: 'number', min: 9, max: 30 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'headerBg', label: '表头底色', type: 'color' },
    { key: 'lineColor', label: '线色', type: 'color' },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  // 变量不再走 bindings 的逐槽选择：现场参数常常是一整段数组，用 varsText 一行写「范围」更省事。
  // （老工程里残留的 bindings.variables 会在解析时追加兼容，见 parseRecipeVars）
  binding: null,
  actions: [],
  /**
   * 运行态「本页采集范围」要收进来的变量（runtime.js 的 collectPageVars 会问每个控件要）。
   * 配方的变量是**文本属性里写的**（varsText），不占 bindings —— 不收进来的话接真 PLC 时
   * 这些变量不在轮询范围，`api.get` 只能拿到进运行态时的旧值，「保存当前」就存了旧值。
   */
  scopeVars(w) {
    try { return parseRecipeVars(w).names; } catch (e) { return []; }
  },
  render(w, mode, vars) {
    const p = w.props || {};
    const fs = intIn(p.fontSize, 14, 9, 30);
    const rowH = intIn(p.rowH, 30, 18, 80);
    const radius = intIn(p.radius, 4, 0, 30);
    const fg = p.textColor || '#1f2329';
    const bg = p.bgColor || '#ffffff';
    const headBg = p.headerBg || '#eef2f7';
    const line = p.lineColor || '#c3cbd6';
    // 运行态从模块级状态画；编辑态用假数据画静态预览（所见即所得，不写 hint 说明）
    const st = mode === 'run'
      ? stateOf(w)
      : { names: PREVIEW_NAMES, msg: '', busy: false, name: '', loaded: true, sel: null, keys: [], orig: null, draft: null, pad: null };
    const busy = !!st.busy;
    const dis = busy ? ' disabled' : '';
    const disabledCursor = busy ? 'cursor:default;opacity:.6;' : 'cursor:pointer;';
    // 配方变量：按当前变量表重新解析（标题行右侧显示个数；没配 = 「还没有配方变量」）
    const varInfo = recipeVarInfo(w);
    const varCount = varInfo.names.length;
    const countTxt = varCount > 0 ? (varCount + ' 个变量') : tr('还没有配方变量');
    const title = tr(p.title || '配方');
    const ph = tr(p.namePlaceholder || '');
    // 选中的配方（运行态）：数据表草稿 / 未保存标记
    const sel = (mode === 'run') ? st.sel : null;
    const selActive = !!sel;
    const dataKeys = Array.isArray(st.keys) ? st.keys : [];
    const draft = st.draft || null;
    const orig = st.orig || null;
    const rowDirty = (k) => !!(draft && orig && draft[k] !== orig[k]);
    const anyDirty = !!selActive && dataKeys.some(rowDirty);
    const btnStyle = `flex:none;height:${Math.max(20, rowH - 4)}px;padding:0 10px;box-sizing:border-box;`
      + `border:1px solid ${line};border-radius:${Math.max(0, radius)}px;background:#f7f8fa;color:${fg};`
      + `font-size:${fs}px;line-height:1;cursor:pointer;`;
    const smallBtnStyle = `flex:none;height:${Math.max(18, rowH - 8)}px;padding:0 8px;box-sizing:border-box;`
      + `border:1px solid ${line};border-radius:${Math.max(0, radius)}px;background:#f7f8fa;color:${fg};`
      + `font-size:${Math.max(9, fs - 2)}px;line-height:1;cursor:pointer;`;
    const rowBtn = (act, text) => `<button type="button" class="rc-btn rc-btn-row" data-rcact="${act}"${dis}
      style="${smallBtnStyle}${disabledCursor}">${escapeHtml(text)}</button>`;

    // ── 头部：标题 + 变量个数 + 刷新 ──
    const head = `<div class="rc-head" style="display:flex;align-items:center;gap:6px;padding:6px 8px;box-sizing:border-box;background:${headBg};border-bottom:1px solid ${line};flex:none">
      <span class="rc-title" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${fs + 1}px;font-weight:600;color:${fg}">${escapeHtml(title)}</span>
      <span class="rc-count" style="flex:none;white-space:nowrap;font-size:${Math.max(10, fs - 2)}px;color:#6b7280">${escapeHtml(countTxt)}</span>
      ${p.showRefresh !== false ? `<button type="button" class="rc-btn" data-rcact="refresh"${dis} style="${btnStyle}${disabledCursor}">${escapeHtml(tr('刷新'))}</button>` : ''}
    </div>`;

    // ── 配方名 + 保存当前 ──
    const inputStyle = `flex:1;min-width:0;height:${Math.max(20, rowH - 4)}px;box-sizing:border-box;`
      + `border:1px solid ${line};border-radius:${Math.max(0, radius)}px;background:#ffffff;color:${fg};`
      + `font-size:${fs}px;padding:0 8px;outline:none;`;
    const form = `<div class="rc-form" style="display:flex;align-items:center;gap:6px;padding:8px;box-sizing:border-box;border-bottom:1px solid ${line};flex:none">
      <input class="rc-name" data-rc="name" type="text" value="${escapeHtml(st.name)}" placeholder="${escapeHtml(ph)}"${mode === 'edit' ? ' disabled' : ''}
        style="${inputStyle}${mode === 'edit' ? 'opacity:.7;' : ''}">
      ${p.showSave !== false ? `<button type="button" class="rc-btn" data-rcact="save"${dis} style="${btnStyle}${disabledCursor}">${escapeHtml(tr('保存当前'))}</button>` : ''}
    </div>`;

    // ── 配方列表（每行：名字 + 应用 + 可选删除）；点行本体 = 选中它看/改数据 ──
    let list = '';
    if (p.showList !== false) {
      const names = Array.isArray(st.names) ? st.names : [];
      let body = '';
      if (!names.length) {
        body = `<div class="rc-empty" style="padding:12px 8px;color:#8a94a6;font-size:${fs}px;text-align:center">${escapeHtml(tr('还没有配方'))}</div>`;
      } else {
        body = names.map((name, i) => {
          const on = sel === name;
          return `<div class="rc-row${on ? ' sel' : ''}" data-rcrow="${i}" data-rcname="${escapeHtml(name)}"
          style="display:flex;align-items:center;gap:6px;height:${rowH}px;padding:0 8px;box-sizing:border-box;border-bottom:1px solid ${line};cursor:pointer;${on ? 'background:#eef4ff;box-shadow:inset 3px 0 0 #2563eb;' : ''}">
          <span class="rc-rowname" title="${escapeHtml(name)}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${fs}px;color:${fg}">${escapeHtml(name)}</span>
          ${rowBtn('apply', tr('应用'))}
          ${p.allowDelete === true ? rowBtn('del', tr('删除')) : ''}
        </div>`;
        }).join('');
      }
      // 选中时列表让位给下面的数据表（列表仍可点，用来切换配方）
      const listStyle = selActive
        ? `flex:none;max-height:${Math.min(180, Math.max(rowH * 3, 90))}px;`
        : 'flex:1;';
      list = `<div class="rc-list" style="${listStyle}min-height:0;overflow:auto;background:${bg}">${body}</div>`;
    }

    // ── 选中配方后的「数据表」：变量名只读 + 值（数值点开内置小键盘 / 字符串·bool 行内 input）──
    let data = '';
    let padHtml = '';
    if (selActive) {
      const dataRowH = Math.max(20, rowH - 4);
      const dInputStyle = `flex:1;min-width:0;height:${dataRowH}px;box-sizing:border-box;border:1px solid ${line};`
        + `border-radius:${Math.max(0, radius)}px;background:#ffffff;color:${fg};font-size:${Math.max(9, fs - 1)}px;padding:0 6px;outline:none;`;
      const dValStyle = `flex:1;min-width:0;text-align:right;font-size:${Math.max(9, fs - 1)}px;color:${fg};`
        + `cursor:pointer;padding:0 6px;line-height:${Math.max(16, dataRowH - 2)}px;background:#fbfcfe;border:1px solid ${line};`
        + `border-radius:${Math.max(0, radius)}px;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      const valCell = (k, i) => {
        const v = draft ? draft[k] : '';
        // 数值 → 点开控件内置小键盘；字符串 / bool / 空 → 真 input 行内改
        if (typeof v === 'number') {
          return `<span class="rc-dval" data-rcnum="${i}" style="${dValStyle}">${escapeHtml(String(v))}</span>`;
        }
        const isBool = typeof v === 'boolean';
        const attr = isBool ? `data-rcbool="${i}"` : `data-rcstr="${i}"`;
        return `<input class="rc-dinp" type="text" ${attr} value="${escapeHtml(v === null || v === undefined ? '' : String(v))}" style="${dInputStyle}">`;
      };
      const rowsHtml = (draft && dataKeys.length)
        ? dataKeys.map((k, i) => `<div class="rc-drow" data-rcidx="${i}" data-rcvar="${escapeHtml(k)}"
            style="display:flex;align-items:center;gap:4px;min-height:${dataRowH}px;padding:1px 8px;box-sizing:border-box;border-bottom:1px solid ${line}">
            <span class="rc-dname" title="${escapeHtml(k)}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${Math.max(9, fs - 1)}px;color:${fg}">${escapeHtml(k)}</span>
            ${valCell(k, i)}
            <span class="rc-star" data-rcstar="${i}" style="flex:none;width:10px;text-align:center;color:#d97706;font-weight:700">${rowDirty(k) ? '*' : ''}</span>
          </div>`).join('')
        : `<div class="rc-data-empty" style="padding:12px 8px;color:#8a94a6;font-size:${fs}px;text-align:center">${escapeHtml(!draft ? (busy ? tr('读取中…') : tr('读不到这个配方的数据')) : tr('这个配方没有数据'))}</div>`;
      data = `<div class="rc-data" style="flex:1;min-height:0;display:flex;flex-direction:column;border-top:1px solid ${line}">
        <div class="rc-data-head" style="display:flex;align-items:center;gap:6px;padding:4px 8px;box-sizing:border-box;flex:none;background:${headBg};border-bottom:1px solid ${line}">
          <span class="rc-data-title" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${Math.max(10, fs - 1)}px;font-weight:600;color:${fg}">${escapeHtml('编辑「' + sel + '」')}</span>
          <span data-rcdirty style="flex:none;white-space:nowrap;color:#d97706;font-size:${Math.max(9, fs - 2)}px;display:${anyDirty ? '' : 'none'}">${escapeHtml(tr('● 未保存'))}</span>
          <button type="button" class="rc-btn" data-rcact="savedata"${dis} style="${smallBtnStyle}${disabledCursor}">${escapeHtml(tr('保存修改'))}</button>
          <button type="button" class="rc-btn" data-rcact="revert"${dis} style="${smallBtnStyle}${disabledCursor}">${escapeHtml(tr('还原修改'))}</button>
        </div>
        <div class="rc-data-list" style="flex:1;min-height:0;overflow:auto;background:${bg}">${rowsHtml}</div>
      </div>`;
      // 内置小键盘：绝对定位在控件内，样式全内联，不引第三方（触摸屏/输入法都能用）
      if (st.pad) {
        const buf = String(st.pad.buffer === null || st.pad.buffer === undefined ? '' : st.pad.buffer);
        const padKey = (k, label, okStyle) => `<button type="button" data-rcpad="${k}" style="height:28px;box-sizing:border-box;border:1px solid ${line};border-radius:${Math.max(0, radius)}px;background:${okStyle ? '#2563eb' : '#f7f8fa'};color:${okStyle ? '#ffffff' : fg};font-size:${Math.max(11, fs - 1)}px;line-height:1;cursor:pointer;padding:0">${escapeHtml(label)}</button>`;
        const keysHtml = [
          padKey('7', '7'), padKey('8', '8'), padKey('9', '9'),
          padKey('4', '4'), padKey('5', '5'), padKey('6', '6'),
          padKey('1', '1'), padKey('2', '2'), padKey('3', '3'),
          padKey('-', '-'), padKey('0', '0'), padKey('.', '.'),
          padKey('back', '⌫'), padKey('cancel', tr('取消')), padKey('ok', tr('确定'), true),
        ].join('');
        padHtml = `<div class="rc-pad" style="position:absolute;right:6px;bottom:24px;width:186px;z-index:30;background:#ffffff;border:1px solid ${line};border-radius:${radius}px;box-shadow:0 8px 22px rgba(0,0,0,.22);padding:6px;box-sizing:border-box">
          <div class="rc-pad-disp" style="height:26px;box-sizing:border-box;padding:0 8px;line-height:26px;text-align:right;font-size:${fs}px;font-family:Consolas,monospace;background:#f7f8fa;border:1px solid ${line};border-radius:${Math.max(0, radius)}px;overflow:hidden;white-space:nowrap">${escapeHtml(buf === '' ? '0' : buf)}</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:6px">${keysHtml}</div>
        </div>`;
      }
    }

    // ── 消息行（成功/失败都显示人话；空串 = 不占地方）──
    const msg = `<div class="rc-msg" style="flex:none;padding:4px 8px;min-height:18px;box-sizing:border-box;color:#6b7280;font-size:${Math.max(10, fs - 2)}px;line-height:1.4;white-space:pre-wrap">${escapeHtml(st.msg)}</div>`;

    return `<div class="w-recipe" style="position:relative;display:flex;flex-direction:column;width:100%;height:100%;box-sizing:border-box;overflow:hidden;background:${bg};border:1px solid ${line};border-radius:${radius}px">
      ${head}${form}${list}${data}${padHtml}${msg}
    </div>`;
  },
  /**
   * 运行态交互（runtime.js 建好控件后调用；事件全挂 el 上做委托，body 重画后照样有效）
   * @param {Element} el 控件根 .wd（刷新只换里面的 .wd-body，这层不动）
   * @param {object} w 控件数据
   * @param {object} api { get, set, blockReason, allowed, refresh, editNumber, rpc, ensureAdmin, gotoPage }
   */
  attach(el, w, api) {
    const p = w.props || {};
    const st = stateOf(w);

    /** 后端/网络错误 → 给人看的一句话（不静默） */
    const errText = (e) => {
      if (!e) return '操作失败';
      if (e.needLogin) return '需要管理员登录';
      return String(e.message || e);
    };
    const refresh = () => { try { api.refresh(); } catch (e) { /* 控件已离开画面就算了 */ } };
    const nameInput = () => el.querySelector('[data-rc="name"]');

    /** 拉一次配方名列表 */
    const fetchNames = async () => {
      const res = await api.rpc('/api/recipes', { method: 'GET' });
      return (res && Array.isArray(res.names)) ? res.names.slice() : [];
    };

    /** ① 首次进入 / 点「刷新」：GET 列表 */
    const load = async () => {
      if (st.busy) return;
      st.busy = true;
      refresh();
      try {
        st.names = await fetchNames();
        st.msg = '';
        // 选中的配方被删了/改名了 → 收起数据表（别让草稿挂在一个不存在的配方上）
        if (st.sel && st.names.indexOf(st.sel) < 0) clearSel();
      } catch (e) {
        st.msg = errText(e);
      } finally {
        st.busy = false;
        st.loaded = true;
        refresh();
      }
    };

    /** 参与配方的变量名（每次现解析：变量表/范围可能被改；老 bindings.variables 也在这里兼容） */
    const recipeVars = () => parseRecipeVars(w);

    /* ─────────── 选中配方 → 数据表 / 草稿 / 内置小键盘 ─────────── */

    /** 复制一份 vars（草稿和原件不共享引用） */
    const copyVars = (o) => {
      const out = {};
      if (o && typeof o === 'object') Object.keys(o).forEach(k => { out[k] = o[k]; });
      return out;
    };
    /** 草稿有没有改动（和后端读回来的原件逐键比） */
    const isDirtyNow = () => {
      if (!st.draft || !st.orig) return false;
      const keys = st.keys || [];
      if (keys.some(k => st.draft[k] !== st.orig[k])) return true;
      const dk = Object.keys(st.draft);
      const ok = Object.keys(st.orig);
      return dk.length !== ok.length || dk.some(k => !ok.includes(k));
    };
    /** 只刷新「*」和「未保存」标记（字符串输入时不整体重画，避免丢焦点/光标） */
    const paintDirty = () => {
      st.dirty = isDirtyNow();
      const mark = el.querySelector('[data-rcdirty]');
      if (mark) mark.style.display = st.dirty ? '' : 'none';
      (st.keys || []).forEach((k, i) => {
        const star = el.querySelector('[data-rcstar="' + i + '"]');
        if (star) star.textContent = (st.draft && st.orig && st.draft[k] !== st.orig[k]) ? '*' : '';
      });
    };
    /** 收起数据表（切走 / 配方被删时） */
    const clearSel = () => {
      st.sel = null; st.keys = []; st.orig = null; st.draft = null; st.pad = null; st.dirty = false;
    };
    /** 从后端读某个配方的 vars → 原值 + 草稿 */
    const loadRecipeData = async (name, okMsg) => {
      st.busy = true;
      st.msg = '';
      refresh();
      try {
        // ⚠ 必须显式 method:'GET'（backend.rpc 默认是 POST）
        const r = await api.rpc('/api/recipes?full=1', { method: 'GET' });
        const rec = (r && r.recipes) ? r.recipes[name] : null;
        const vars = (rec && rec.vars && typeof rec.vars === 'object') ? rec.vars : null;
        if (!vars) {
          st.keys = []; st.orig = null; st.draft = null; st.pad = null; st.dirty = false;
          st.msg = '读不到这个配方的数据（可能刚被删除）';
        } else {
          st.keys = Object.keys(vars);
          st.orig = copyVars(vars);
          st.draft = copyVars(vars);
          st.pad = null;
          st.dirty = false;
          if (okMsg) st.msg = okMsg;
        }
      } catch (e) {
        st.keys = []; st.orig = null; st.draft = null; st.pad = null; st.dirty = false;
        st.msg = errText(e);
      } finally {
        st.busy = false;
        refresh();
      }
    };
    /** 点配方行 → 选中（有未保存修改时先 confirm）并读数据 */
    const selectRecipe = (name) => {
      if (!name || st.busy) return;
      if (st.sel === name) return;                       // 点自己：不重读（别把草稿冲掉）
      if (isDirtyNow() && !confirm(`配方「${st.sel}」还有未保存的修改，确定切换吗？`)) return;
      st.sel = name;
      loadRecipeData(name, '');
    };
    /** 「保存修改」：ensureAdmin('修改配方') + confirm → POST save（draft） */
    const saveData = async () => {
      if (st.busy || !st.sel || !st.draft) return;
      if (!isDirtyNow()) { st.msg = '没有修改'; refresh(); return; }
      if (!api.allowed()) return;
      let ok = false;
      try { ok = await api.ensureAdmin('修改配方'); } catch (e) { ok = false; }
      if (!ok) return;
      if (!confirm(`确定保存对配方「${st.sel}」的修改吗？`)) return;
      const name = st.sel;
      const vars = copyVars(st.draft);
      st.busy = true;
      st.msg = '';
      refresh();
      try {
        await api.rpc('/api/recipes', { body: { action: 'save', name: name, vars: vars } });
        st.orig = copyVars(vars);
        st.draft = copyVars(vars);
        st.pad = null;
        st.dirty = false;
        st.msg = `已保存修改「${name}」（${Object.keys(vars).length} 个变量）`;
      } catch (e) {
        st.msg = errText(e);
      } finally {
        st.busy = false;
        refresh();
      }
    };
    /** 「还原修改」：丢掉草稿，重新从后端读 */
    const revertData = () => {
      if (st.busy || !st.sel) return;
      loadRecipeData(st.sel, '已还原修改');
    };
    /** 点数值单元格 → 打开内置小键盘（字符串/bool 是行内 input，不走这里） */
    const openPad = (i) => {
      if (!st.draft) return;
      const k = st.keys[i];
      if (!k) return;
      const v = st.draft[k];
      if (typeof v !== 'number') return;
      st.pad = { i: i, buffer: String(v) };
      refresh();
    };
    /** 内置小键盘按键 */
    const handlePad = (key) => {
      const pad = st.pad;
      if (!pad || !st.draft) return;
      const k = st.keys[pad.i];
      if (!k) { st.pad = null; refresh(); return; }
      let b = String(pad.buffer === null || pad.buffer === undefined ? '' : pad.buffer);
      if (key === 'cancel') { st.pad = null; refresh(); return; }
      if (key === 'back') { st.pad.buffer = b.slice(0, -1); refresh(); return; }
      if (key === 'ok') {
        const s = b.trim();
        const num = Number(s);
        if (s === '' || s === '-' || s === '.' || !Number.isFinite(num)) {
          st.msg = '请输入一个数字';
          st.pad = null;
          refresh();
          return;
        }
        st.draft[k] = num;
        st.pad = null;
        st.dirty = isDirtyNow();
        st.msg = '';
        refresh();
        return;
      }
      if (key === '-') {
        b = b.charAt(0) === '-' ? b.slice(1) : ('-' + b);
      } else if (key === '.') {
        if (b.indexOf('.') < 0) b = (b === '' ? '0' : b) + '.';
      } else if (/^[0-9]$/.test(key)) {
        b = b + key;
      }
      st.pad.buffer = b;
      refresh();
    };
    /** 行内 input（字符串 / bool）确认：bool 收敛成真假，字符串原样 */
    const commitDataInput = (inp) => {
      if (!inp || !st.draft) return;
      const bi = inp.getAttribute('data-rcbool');
      if (bi !== null && bi !== undefined) {
        const k = st.keys[+bi];
        if (!k) return;
        const s = String(inp.value).trim().toLowerCase();
        st.draft[k] = (s === 'true' || s === '1' || s === '是' || s === '真');
        st.dirty = isDirtyNow();
        refresh();
        return;
      }
      paintDirty();
    };

    /** ② 保存当前：读输入框 → 非空 → ensureAdmin → 收集当前值 → POST save */
    const save = async () => {
      if (st.busy) return;
      const inp = nameInput();
      const name = String(inp ? inp.value : (st.name || '')).trim();
      st.name = name;
      // 名字空：不保存、不弹登录（现场最常见就是没填名字就点了）
      if (!name) { st.msg = '配方名不能为空'; refresh(); return; }
      if (!api.allowed()) return;
      let ok = false;
      try { ok = await api.ensureAdmin('保存配方'); } catch (e) { ok = false; }
      if (!ok) return;                                   // 取消登录 / 密码不对：这次不算数
      // 现解析一次（变量表可能刚改过），收集这一套变量的**当前值**（api.get 走运行值表）
      const info = recipeVars();
      const vars = {};
      info.names.forEach(n => { vars[n] = api.get(n); });
      st.busy = true;
      st.msg = '';
      refresh();
      try {
        const res = await api.rpc('/api/recipes', { body: { action: 'save', name: name, vars: vars } });
        st.name = '';                                    // 清空输入框（下一套重新起名）
        st.names = await fetchNames();                   // 刷新列表
        const n = (res && typeof res.count === 'number') ? res.count : Object.keys(vars).length;
        const skipTxt = info.skipped > 0 ? `，跳过 ${info.skipped} 行认不出的配置` : '';
        st.msg = `已保存「${name}」（${n} 个变量${skipTxt}）`;
      } catch (e) {
        st.msg = errText(e);
      } finally {
        st.busy = false;
        st.loaded = true;
        refresh();
      }
    };

    /** ③ 应用：ensureAdmin → confirm → POST apply → 按 applied/failed 显示结果 */
    const apply = async (name) => {
      if (st.busy || !name) return;
      if (!api.allowed()) return;
      let ok = false;
      try { ok = await api.ensureAdmin('应用配方'); } catch (e) { ok = false; }
      if (!ok) return;
      if (!confirm(`确定应用配方「${name}」？`)) return;
      // 跟保存同一个口径：应用前也现解析一次（配置行删了/改范围了，标题旁的计数要跟着变）
      const info = recipeVars();
      st.busy = true;
      st.msg = '';
      refresh();
      try {
        const res = await api.rpc('/api/recipes', { body: { action: 'apply', name: name } });
        const applied = (res && Array.isArray(res.applied)) ? res.applied.length : 0;
        const failed = (res && Array.isArray(res.failed)) ? res.failed : [];
        const skipTxt = info.skipped > 0 ? `（配置里有 ${info.skipped} 行认不出，已跳过）` : '';
        st.msg = failed.length
          ? `已应用 ${applied} 个，失败 ${failed.length} 个（${(failed[0] && failed[0].error) || '未知原因'}）${skipTxt}`
          : `已应用 ${applied} 个${skipTxt}`;
      } catch (e) {
        // 后端把「部分变量没写成功」也回成 ok:false（rpc 会抛）—— 那句 error 就是人话总结
        st.msg = errText(e);
      } finally {
        st.busy = false;
        refresh();
      }
    };

    /** ④ 删除（allowDelete 才给按钮）：confirm → ensureAdmin → POST delete → 刷新 */
    const del = async (name) => {
      if (st.busy || !name) return;
      if (p.allowDelete !== true) return;
      if (!api.allowed()) return;
      if (!confirm(`确定删除配方「${name}」？`)) return;
      let ok = false;
      try { ok = await api.ensureAdmin('删除配方'); } catch (e) { ok = false; }
      if (!ok) return;
      st.busy = true;
      st.msg = '';
      refresh();
      try {
        await api.rpc('/api/recipes', { body: { action: 'delete', name: name } });
        st.names = await fetchNames();
        if (st.sel === name) clearSel();                 // 删的就是正在看的那个 → 收起数据表
        st.msg = `已删除「${name}」`;
      } catch (e) {
        st.msg = errText(e);
      } finally {
        st.busy = false;
        refresh();
      }
    };

    // ── 事件委托：全挂 el 上（refreshWidgetBody 只换 .body，这层监听不受影响）──
    el.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      // 内置小键盘的键
      const padEl = t.closest('[data-rcpad]');
      if (padEl) { handlePad(padEl.getAttribute('data-rcpad')); return; }
      // 数值单元格 → 打开控件内置小键盘
      const numEl = t.closest('[data-rcnum]');
      if (numEl) { openPad(+numEl.getAttribute('data-rcnum')); return; }
      // 按钮动作（应用/删除/保存当前/刷新/保存修改/还原修改）
      const actEl = t.closest('[data-rcact]');
      if (actEl) {
        const act = actEl.getAttribute('data-rcact');
        if (act === 'refresh') { load(); return; }
        if (act === 'save') { save(); return; }
        if (act === 'savedata') { saveData(); return; }
        if (act === 'revert') { revertData(); return; }
        const row = actEl.closest('[data-rcname]');
        const name = row ? row.getAttribute('data-rcname') : '';
        if (!name) return;
        if (act === 'apply') apply(name);
        else if (act === 'del') del(name);
        return;
      }
      // 点配方行本体/名字 → 选中并读它的数据（不和应用/删除按钮混）
      const rrow = t.closest('[data-rcrow]');
      if (rrow) { selectRecipe(rrow.getAttribute('data-rcname') || ''); return; }
    });
    el.addEventListener('input', (e) => {
      const i = e.target;
      if (!i || !i.getAttribute) return;
      // 配方名输入框：记进状态（body 被变量刷新重建时不丢已输入内容）
      if (i.getAttribute('data-rc') === 'name') { st.name = i.value; return; }
      // 数据表的行内输入（字符串 / bool）：立即进草稿，只刷新「*」和未保存标记（不整体重画）
      const si = i.getAttribute('data-rcstr');
      const bi = i.getAttribute('data-rcbool');
      const idxs = si !== null && si !== undefined ? si : bi;
      if (idxs === null || idxs === undefined || !st.draft) return;
      const k = st.keys[+idxs];
      if (!k) return;
      st.draft[k] = i.value;                            // bool 在回车/失焦时再收敛真假
      paintDirty();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const i = e.target;
      if (!i || !i.getAttribute) return;
      // 配方名输入框回车 = 保存当前
      if (i.getAttribute('data-rc') === 'name') { e.preventDefault(); save(); return; }
      // 数据表行内输入回车 = 确认这一格
      const si = i.getAttribute('data-rcstr');
      const bi = i.getAttribute('data-rcbool');
      if ((si !== null && si !== undefined) || (bi !== null && bi !== undefined)) {
        e.preventDefault();
        commitDataInput(i);
      }
    });
    // 失焦 = 确认这一格（字符串原样进草稿；bool 收敛成真假）
    el.addEventListener('focusout', (e) => {
      const i = e.target;
      if (!i || !i.getAttribute) return;
      const si = i.getAttribute('data-rcstr');
      const bi = i.getAttribute('data-rcbool');
      if (si !== null && si !== undefined) { paintDirty(); return; }
      if (bi !== null && bi !== undefined) commitDataInput(i);
    });

    // 首次进入运行态（以及切语言重画后 attach 再跑一次）→ 拉一次列表
    load();
  },
});
