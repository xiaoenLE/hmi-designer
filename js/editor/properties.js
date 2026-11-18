/**
 * properties.js — 右侧属性面板（schema 驱动自动生成）
 *
 *   无选中   → 页面/画布信息（可改尺寸背景）
 *   单选     → 几何 + 类型属性 + 数据绑定 + 动作配置
 *   多选     → 批量几何
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { backend } from '../api/backend.js';
import { registry, ACTION_DEFS } from '../widgets/registry.js';
import { keyLabel, debounce, dtypeFromFmt, decimalsFromFmt, statusNote,
  dtypeOfVarType, varTypeOfDtype, fmtOfDtype, parseOptions, setOptionColor, isClickThrough } from '../core/utils.js';
import { attachVarPick } from './varPick.js';
import { PALETTE as TREND_PALETTE } from '../runtime/trend.js';
import { select } from './canvas.js';

/** 波形通道允许的变量类型（跟 defs.js 里 trend 的 binding.types 对应） */
const CHAN_TYPES = ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'bool'];

/** 输入范围上下限能用的变量类型（只有数值变量能当边界；bool/string 拿来做限制是静默失效） */
const LIMIT_TYPES = ['int', 'uint', 'dint', 'udint', 'real', 'lreal'];

const commitLater = debounce(() => project.commit('修改属性', { merge: true }), 600);

/**
 * 属性编辑的「延迟生效」：停下来 300ms 才真的写进工程（用户要求）。
 * 以前每敲一个字符就 updateWidgetProp → 画布重绘 + 各面板重画，变量一多就一顿一顿的
 * （10000 个变量时实测一次 380ms）。改完失焦/回车/松手（change 事件）会立刻落地，不用等。
 */
const PROP_DEBOUNCE_MS = 300;
const propTimers = new WeakMap();
function applySoon(inp, fn) {
  const t = propTimers.get(inp);
  if (t) clearTimeout(t);
  propTimers.set(inp, setTimeout(() => { propTimers.delete(inp); fn(); }, PROP_DEBOUNCE_MS));
}
function cancelSoon(inp) {
  const t = propTimers.get(inp);
  if (t) { clearTimeout(t); propTimers.delete(inp); }
}

/* ── 分组折叠（localStorage 记住每个分组的状态） ── */
const FOLD_KEY = 'hmi-prop-fold';
function foldMap() {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; } catch { return {}; }
}
function wireFold(body) {
  const map = foldMap();
  body.querySelectorAll('.prop-group').forEach(g => {
    const title = g.querySelector('.prop-group-title');
    if (!title) return;
    // 去掉动态计数等括号内容，得到稳定存储键（如「批量几何（3 个控件）」→「批量几何」）
    const key = title.textContent.replace(/（.*?）/g, '').trim();
    if (map[key]) g.classList.add('folded');
    title.addEventListener('click', () => {
      g.classList.toggle('folded');
      const m = foldMap();
      m[key] = g.classList.contains('folded');
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(m)); } catch { /* 忽略 */ }
    });
  });
}

export function initProperties() {
  bus.on('selection:changed', render);
  bus.on('page:current', render);
  // 换了协议（Modbus ↔ OPC UA）→「数据类型」那一行的可编辑性跟着变，得重画
  bus.on('plc:protocol', render);
  bus.on('project:changed', () => {
    // 数据结构变化（非本面板引起）时刷新，避免输入中被重建
    if (!document.activeElement?.closest('#propBody')) render();
  });
  render();
}

function render() {
  const body = document.getElementById('propBody');
  const sel = getSel();
  if (sel.length === 0) return renderPageProps(body);
  if (sel.length > 1) return renderMultiProps(body, sel);
  renderWidgetProps(body, project.getWidget(sel[0]));
}

function getSel() {
  return [...document.querySelectorAll('#canvas .wd.selected')].map(el => el.dataset.id);
}

/* ═══════════ 页面属性 ═══════════ */
function renderPageProps(body) {
  const page = project.currentPage();
  const c = project.data.meta.canvas;
  const isBase = page?.type === 'base';
  const bases = project.bases();
  const curBase = project.baseOf(page);                     // 这一页套的底
  const using = isBase ? project.pagesUsingBase(page.id) : [];
  body.innerHTML = `
    <div class="prop-group">
      <div class="prop-group-title">画布 / 页面</div>
      <div class="f-row"><span class="f-label">工程名</span>
        <input class="f-input" id="ppName" value="${esc(project.data.meta.name)}"></div>
      <div class="f-row"><span class="f-label">画布宽</span>
        <input class="f-input" id="ppW" type="number" min="200" max="4000" value="${c.w}"></div>
      <div class="f-row"><span class="f-label">画布高</span>
        <input class="f-input" id="ppH" type="number" min="200" max="3000" value="${c.h}"></div>
      <div class="f-row"><span class="f-label">背景色</span>
        <input class="f-color" id="ppBg" type="color" value="${c.bg || '#f4f5f7'}"></div>
      <div class="f-row"><span class="f-label">当前${isBase ? '底' : '页面'}</span>
        <input class="f-input" disabled value="${esc(page?.name || '')}"></div>
      <div class="f-row"><span class="f-label">控件数</span>
        <input class="f-input" disabled value="${page?.widgets.length || 0}"></div>
    </div>
    ${page?.type === 'page' ? `
    <div class="prop-group">
      <div class="prop-group-title">公共底（写一次，多页共用）</div>
      <div class="f-row"><span class="f-label">套用公共底</span>
        <select class="f-select" id="ppBase" ${bases.length ? '' : 'disabled'}>
          <option value="">不套用</option>
          ${bases.map(b => `<option value="${esc(b.id)}" ${b.id === curBase?.id ? 'selected' : ''}>${esc(b.name)}（${b.widgets.length} 控件）</option>`).join('')}
        </select></div>
      <div style="color:var(--text-2);font-size:11px;line-height:1.65">
        ${bases.length
          ? `底上的控件画在**本页控件的下面**（底部导航条 / 标题栏 / 报警条这类每页都一样的，画在底上就只维护一份）；<br>
             运行态底上的按钮照常能点。改底请到左区「页面」面板点开那个底 —— 画布上底那一层**点不动**，双击可以直接跳过去。`
          : '还没有公共底：左区「页面」面板点「＋ 新建公共底」，在里面画一次，再回来选它。'}
      </div>
    </div>` : ''}
    ${isBase ? `
    <div class="prop-group">
      <div class="prop-group-title">这个公共底</div>
      <div style="color:var(--text-2);font-size:11.5px;line-height:1.7">
        ${using.length
          ? `被 <b>${using.length}</b> 个页面套用：${using.slice(0, 12).map(x => esc(x.name)).join('、')}${using.length > 12 ? ' …' : ''}<br>
             在这里（以及画布上）改一次，上面这些页面**一起变**。`
          : '还没有页面套用它 —— 到普通页面的属性面板「公共底 → 套用公共底」里选它。'}
      </div>
    </div>` : ''}
    ${page?.type === 'popup' ? `
    <div class="prop-group">
      <div class="prop-group-title">弹窗设置</div>
      <div class="prop-grid">
        <span class="f-label">弹窗宽</span><input class="f-input" id="ppPW" type="number" min="120" max="2000" value="${page.popupW || 420}"><span></span>
        <span class="f-label">弹窗高</span><input class="f-input" id="ppPH" type="number" min="80" max="1500" value="${page.popupH || 240}"><span></span>
      </div>
      <div class="f-row"><span class="f-label">弹窗标题</span>
        <input class="f-input" id="ppTitle" value="${esc(page.title || '')}" placeholder="留空则不显示标题文字"></div>
      <div class="f-row"><span class="f-label">关闭按钮</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input class="f-check" id="ppClose" type="checkbox" ${page.showClose !== false ? 'checked' : ''}>
          <span style="color:var(--text-2);font-size:12px">标题栏右上角显示 ✕</span>
        </label></div>
      <div style="color:var(--text-2);font-size:11px;line-height:1.6">
        弹窗为模态：打开期间遮罩拦截后方页面的一切点击，只能通过关闭按钮或动作关闭。<br>
        运行态里标题栏（和那个 ✕）是**额外**加在内容区之上的 —— 不会挤掉你设的「弹窗高」，
        贴底的控件照样完整显示。<br>
        弹窗有自己的尺寸和标题栏，所以**不套公共底**（要复用就把控件直接复制进弹窗）。
      </div>
    </div>` : ''}
    <div style="color:var(--text-2);font-size:11px;line-height:1.7">
      点击画布中的控件查看其属性；从左侧控件库拖拽控件到画布。<br>
      弹窗页面尺寸在左侧「页面」面板底部编辑。
    </div>`;
  const upd = () => project.updateCanvas({
    w: +document.getElementById('ppW').value || 1024,
    h: +document.getElementById('ppH').value || 600,
    bg: document.getElementById('ppBg').value,
  });
  ['ppW', 'ppH', 'ppBg'].forEach(id =>
    document.getElementById(id).addEventListener('change', upd));
  document.getElementById('ppName').addEventListener('change', e => {
    project.data.meta.name = e.target.value;
    project.commit('改工程名');
  });
  // 公共底：选一个就套上（'' = 取消）
  const ppBase = document.getElementById('ppBase');
  if (ppBase) ppBase.addEventListener('change', () => {
    if (!project.setPageBase(page.id, ppBase.value)) {
      statusNote('套用公共底失败（目标不是普通页面）');
    }
  });
  // 弹窗设置
  const ppTitle = document.getElementById('ppTitle');
  const ppClose = document.getElementById('ppClose');
  const ppPW = document.getElementById('ppPW');
  const ppPH = document.getElementById('ppPH');
  if (ppTitle) ppTitle.addEventListener('change', () => {
    project.updatePage(page.id, { title: ppTitle.value });
  });
  if (ppClose) ppClose.addEventListener('change', () => {
    project.updatePage(page.id, { showClose: ppClose.checked });
  });
  if (ppPW) ppPW.addEventListener('change', () => {
    project.updatePage(page.id, { popupW: +ppPW.value || 420 });
  });
  if (ppPH) ppPH.addEventListener('change', () => {
    project.updatePage(page.id, { popupH: +ppPH.value || 240 });
  });
  wireFold(body);
}

/* ═══════════ 多选（批量几何） ═══════════ */
function renderMultiProps(body, ids) {
  /* 整组选中时：先给一份「组内控件」清单 —— 点一个就只选中它，
     属性面板立刻切成它自己的属性（想改组合里某一个控件时不用去猜 Alt+点击）。 */
  const wholeGroup = project.isWholeGroup(ids);
  const members = wholeGroup ? ids.map(id => project.getWidget(id)).filter(Boolean) : [];
  const memberHtml = wholeGroup ? `
    <div class="prop-group">
      <div class="prop-group-title">组内控件（${members.length} 个）· 点一个只选它</div>
      <div class="group-members">
        ${members.map(m => `<button type="button" class="gm-item" data-pick="${esc(m.id)}" title="只选中「${esc(m.name)}」，然后就能单独改它的属性">
          <span class="gm-badge">${esc(registry.get(m.type)?.title || m.type)}</span>
          <span class="gm-name">${esc(m.name)}</span></button>`).join('')}
      </div>
      <div class="group-hint">画布上 <b>Alt + 点击</b>某个控件、或右键选「单独选中」也是同样效果。</div>
    </div>` : '';

  body.innerHTML = `${memberHtml}
    <div class="prop-group">
      <div class="prop-group-title">批量几何（${ids.length} 个控件）</div>
      <div class="prop-grid">
        <span class="f-label">X</span><input class="f-input" id="mX" type="number" placeholder="批量设置">
        <span></span>
        <span class="f-label">Y</span><input class="f-input" id="mY" type="number" placeholder="批量设置">
        <span></span>
        <span class="f-label">宽</span><input class="f-input" id="mW" type="number" placeholder="批量设置">
        <span></span>
        <span class="f-label">高</span><input class="f-input" id="mH" type="number" placeholder="批量设置">
        <span></span>
      </div>
    </div>
    <div style="color:var(--text-2);font-size:12px">
      使用顶部工具栏的「对齐」按钮排列多个控件；Delete 删除所选；Ctrl+C / Ctrl+V 复制粘贴。
    </div>`;
  body.querySelectorAll('[data-pick]').forEach(btn => {
    btn.addEventListener('click', () => select([btn.dataset.pick], { raw: true }));   // 只选这一个
  });
  [['mX', 'x'], ['mY', 'y'], ['mW', 'w'], ['mH', 'h']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', e => {
      const v = +e.target.value;
      if (!v && v !== 0) return;
      if (key === 'w' || key === 'h') { if (v < 8) return; }
      project.updateWidgets(ids, { [key]: v });
      project.commit('批量几何');
    });
  });
  wireFold(body);
}

/* ═══════════ 单个控件 ═══════════ */
function renderWidgetProps(body, w) {
  if (!w) return renderPageProps(body);
  const def = registry.get(w.type) || {};      // || {}：类型没定义时也不能把面板渲染搞崩（见下面的提示条）
  let html = '';

  // 类型在本机没有定义（工程/控件包里的自定义控件定义丢了，或这个类型被删/改名了）
  // → 画布上它显示成「未知控件」，面板上得说清楚**为什么**、以及**怎么办**
  if (!registry.get(w.type)) {
    html += `
    <div class="group-hint" style="border-left:3px solid #f59e0b">
      <span>⚠ 这个控件的类型 <b>${esc(w.type)}</b> <b>在本机没有定义</b> —— 画布上显示成「未知控件」，
      它的属性也改不了（按谁的定义改？）。<br>
      办法：① 删掉它（它已经没用了）；② 或者导入带这个控件的控件包
      （画布空白处右键 → 导入控件包…），导进来它就恢复正常。</span>
    </div>`;
  }

  // 这个控件在组合里（说明"现在只选中了它自己"）→ 给一条返回整组的入口，别让人以为组散了
  if (w.group) {
    const n = project.groupMembers(w.id).length;
    html += `
    <div class="group-hint">
      <span>在组合里（"组 ${n}" 共 ${n} 个控件）—— 现在<b>只选中了这一个</b>，改的是它自己。</span>
      <button type="button" class="tb-btn sm" id="pickWholeGroup">选中整组</button>
    </div>`;
  }

  // 几何
  html += `
    <div class="prop-group">
      <div class="prop-group-title">几何 / 名称</div>
      <div class="prop-grid">
        <span class="f-label">X</span><input class="f-input" data-fld="x" type="number" value="${w.x}"><span></span>
        <span class="f-label">Y</span><input class="f-input" data-fld="y" type="number" value="${w.y}"><span></span>
        <span class="f-label">宽</span><input class="f-input" data-fld="w" type="number" min="8" value="${w.w}"><span></span>
        <span class="f-label">高</span><input class="f-input" data-fld="h" type="number" min="8" value="${w.h}"><span></span>
      </div>
      <div class="f-row"><span class="f-label">名称</span>
        <input class="f-input" data-fld="name" value="${esc(w.name)}"></div>
      <div class="f-row"><span class="f-label">锁定</span>
        <!-- 勾选框右边的「锁定后无法移动/缩放」文字**去掉了**（现场要求只删文字、留勾选框）：
             意思在「锁定」这个标签上，工具栏也有「🔒 锁定」按钮 -->
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"
          title="勾上：这个控件在画布上不能拖动/缩放（还能选中看属性）。锁定/解锁也可以点工具栏的「🔒 锁定」。">
          <input class="f-check" data-lock="1" type="checkbox" ${w.locked ? 'checked' : ''}>
        </label></div>
    </div>`;

  // 操作权限（所有控件都能配）：运行态点到它时先查权限，不够就弹密码框。
  // 等级表在「工程 ▾ → 权限管理…」里配（名字 + 密码，跟着工程走）。
  // ⚠ 三行（权限等级 / 密码框 / 小锁标记）**一直显示**，不管有没有选等级、权限管理开没开 ——
  //   现场不想为了改一下设置还要先选个等级（"一直显示"比"按状态显隐"更省事）。
  // ⚠ 这里以前还有一行「⚠ 权限管理现在是关的…」的提示：现场要求去掉（面板上少一句废话），
  //   权限管理开关本身在「工程 ▾ → 权限管理…」里，按钮就在这一栏下面。
  const levels = project.permLevels();
  const curLv = String(w.props?.permLevel || '');
  const showBadge = w.props?.showPermBadge !== false;     // 默认显示（不喜欢可以单独关掉）
  html += `
    <div class="prop-group">
      <div class="prop-group-title">操作权限</div>
      <div class="f-row"><span class="f-label">权限等级</span>
        <select class="f-select" data-prop="permLevel" style="flex:1" ${levels.length ? '' : 'disabled'}>
          <option value="">不限（谁都能操作）</option>
          ${levels.map(l => `<option value="${esc(l.id)}" ${curLv === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="f-row"><span class="f-label">密码框</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"
          title="勾上（默认）：权限不够时点这个控件 → 弹出密码框，输对了才能操作。
不勾：权限不够就**点不动**，也不弹密码框、不给任何提示（不想让现场看到密码入口时用；这时建议留着下面的「小锁标记」勾选，好让人知道为什么点不动）。">
          <input class="f-check" data-prop="permPrompt" type="checkbox" ${w.props?.permPrompt !== false ? 'checked' : ''}>
          <!-- 勾选框右边的「权限不够时自动弹出」文字**去掉了**（现场要求只删文字、留开关）：
               意思在「密码框」这个标签 + 悬停提示里，勾选框自己说话 -->
        </label></div>
      <div class="f-row"><span class="f-label">小锁标记</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"
          title="勾上（默认）：等级不够时，这个控件角上挂一个 🔒 —— 一眼看出为什么点不动；解锁后标记自动消失。
不勾：这个控件不挂标记（运行态照样拦），画面想更干净时用。">
          <input class="f-check" data-prop="showPermBadge" type="checkbox" ${showBadge ? 'checked' : ''}>
        </label></div>
      ${levels.length ? '' : `<div class="f-row"><span class="f-label"></span>
        <span style="color:var(--text-2);font-size:11px;line-height:1.6">还没配权限等级。</span></div>`}
      <div class="f-row"><span class="f-label"></span>
        <button type="button" class="tb-btn sm" id="permCfgBtn">权限管理…</button>
      </div>
    </div>`;

  // 点击穿透（所有控件都能配）：叠着放的时候，点一下要不要把**压在下面的控件**也一起点到。
  // 现场场景：一个大方框压在按钮上（或者两个透明按钮叠在一起），希望点一下两个都生效。
  // ⚠ 默认不勾 = 现在的行为（点谁就只算谁），老画面一点不变；
  //   勾上「穿透」= 我自己的动作照做，**同时继续往下传**（下面的也一起做）。
  //   见 js/runtime/runtime.js 的 fireBelowWidgets / isClickThrough。
  const ct = isClickThrough(w.props);
  html += `
    <div class="prop-group">
      <div class="prop-group-title">点击穿透</div>
      <div class="f-row"><span class="f-label">穿透</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"
          title="勾上（穿透）：运行态点我，我自己的动作照做，压在下面的控件的动作也一起做 —— 两个控件叠着放，点一下两个都触发；方框没配动作时，就等于透过方框点到下面的按钮。
不勾（默认，不穿透）：点谁算谁，和以前完全一样。
只作用于运行态：组态画布上照样能点中、能拖（不然被压住的框就选不中了）。">
          <input class="f-check" data-prop="clickThrough" type="checkbox" ${ct ? 'checked' : ''}>
        </label></div>
    </div>`;

  // 类型属性（schema 驱动）
  if (def.props?.length) {
    // OPC UA：变量是从服务器**导入**的，类型以 PLC 为准 ——「数据类型」那一行只看不改。
    // 改了会把导入来的类型覆盖掉（声明类型和节点实际类型对不上，读回来/写下去都按错类型解），
    // 现场表现就是「值不对、写不进」，而且看不出是谁改的。要换类型就去 PLC 改完重新导入。
    const bindForType = w.bindings?.variable
      ? project.variables().find(x => x.name === w.bindings.variable) : null;
    const dtypeLocked = !!bindForType && backend.isOpcua();
    let dtypeLockMsg = '';      // 「数据类型」被锁住时下面那行说明（说清为什么不能改）
    // 逐条属性的 HTML（下面按 group 分栏时会反复调用它）。
    // ⚠ 里面照旧写 `html += …`：靠外面那层临时清空/还原来"接住"这一条的 HTML，
    //   这样这段又长又密的渲染逻辑一行都不用改（改一处漏一处最容易出 bug）。
    const renderProp = (p) => {
      const v = w.props[p.key];
      // showVarType='notBool'：仅当绑定的变量存在且类型非 bool 时显示该行
      // （bool 直接开/关无需比较；未绑定时不显示空转的比较条件）
      if (p.showVarType === 'notBool') {
        const vt = project.variables().find(x => x.name === w.bindings?.variable)?.type;
        if (!vt || vt === 'bool') return;
      }
      // showIf：这一行只在某个勾选属性为真时才出现（如数值控件的「下限/上限」只在勾了
      // 「范围限制」后才有意义）。勾选框变化时外面会重画面板，所以这里直接跳过就行。
      if (p.showIf && !w.props[p.showIf]) return;
      if (p.type === 'image') {
        // 图片属性自成两行（选图行 + 预览行），不走下方统一外壳，
        // 否则外层已输出一次 label、内层再输出一次，「图片」会显示两遍
        const src = v || '';
        const isData = src.startsWith('data:');
        html += `<div class="f-row"><span class="f-label">${p.label || keyLabel(p.key)}</span>
          <input class="f-input" data-prop="${p.key}" ${isData ? 'readonly title="已内嵌到工程"' : ''} value="${isData ? '(已内嵌到工程)' : esc(src)}" placeholder="URL 或点「选图」">
          <button class="tb-btn sm" data-imgpick="${p.key}">选图</button></div>
          <input type="file" accept="image/*" hidden data-imgfile="${p.key}">
          ${src ? `<div class="f-row"><span class="f-label"></span>
            <img src="${src}" style="max-width:150px;max-height:70px;border:1px solid var(--border);border-radius:4px">
            <button class="tb-btn sm" data-clear="${p.key}">清除</button></div>` : ''}`;
        return;
      }
      html += `<div class="f-row"><span class="f-label">${p.label || keyLabel(p.key)}</span>`;
      if (p.type === 'number') {
        // defVal：控件 props 里没有该键（老工程）时按运行时真实默认值显示，别把 undefined 写进输入框
        html += `<input class="f-input" data-prop="${p.key}" type="number"
          ${p.min !== undefined ? `min="${p.min}"` : ''} ${p.max !== undefined ? `max="${p.max}"` : ''} value="${v ?? p.defVal ?? ''}">`;
      } else if (p.type === 'color') {
        // 「透明」= 把颜色清空（全工程一个约定：空 = 透明）。已经是透明时把按钮点亮，
        // 否则色块显示 #ffffff，看着像"白色"，用户会以为透明没生效。
        const empty = !v;
        html += `<input class="f-color" data-prop="${p.key}" type="color" value="${v || '#ffffff'}">
          <button class="tb-btn sm clear-color${empty ? ' active' : ''}" data-clear="${p.key}"
            title="${empty ? '当前是透明（点色块可以再选个颜色）' : '设为透明（不填底色）'}">透明</button>`;
      } else if (p.type === 'select') {
        // 字符串变量的比较符只保留等值判断（> < 等对字符串无意义，compareVal 亦不响应）
        let opts = p.options;
        if (p.key === 'op') {
          const vt = project.variables().find(x => x.name === w.bindings?.variable)?.type;
          if (vt === 'string') opts = opts.filter(o => o.v === '==' || o.v === '!=');
        }
        html += `<select class="f-select" data-prop="${p.key}">${
          opts.map(o => `<option value="${o.v}" ${String(v) === String(o.v) ? 'selected' : ''}>${o.t}</option>`).join('')
        }</select>`;
      } else if (p.type === 'check') {
        // defVal：控件 props 里没有该键（旧工程）时，按运行时的真实默认值显示勾选态
        // title：悬停说明（**不占面板地方**的写法 —— 面板上不摊解释文字，见 docs/add-widget.md）
        html += `<input class="f-check" data-prop="${p.key}" type="checkbox" ${(v ?? p.defVal) ? 'checked' : ''}${
          p.title ? ` title="${esc(p.title)}"` : ''}>`;
      } else if (p.type === 'dtype') {
        // 数据类型组合控件：**绑了变量就以变量的类型为准**（下拉显示变量那份）。谁能改：
        //   · OPC UA            → 只读（类型是导入时从服务器读到的，以 PLC 为准）
        //   · bool / 认不出的类型 → 只读（没有对应的数值格式，见下）
        //   · Modbus TCP（含没配 PLC 的老工程，本来就是 Modbus 地址）→ 可以改，改的是**变量表里**的类型
        // 没绑变量时这一格只决定控件自己的显示格式。
        // + 浮点的小数位（0=无小数点），改了同步写 dispType/decimals/fmt
        const bindVar = w.bindings?.variable
          ? project.variables().find(x => x.name === w.bindings.variable) : null;
        const rawVarType = String(bindVar?.type || '');
        let fromVar = bindVar ? dtypeOfVarType(rawVarType) : '';
        // ⚠ bool（以及认不出的类型）没有对应的数值格式：以前这里会**掉回控件自己那份 dispType**，
        //   面板上就出现「变量是 bool、控件却写着 dint」这种对不上的组合 ——
        //   现场看到的就是"类型没跟着变量自动切换"。数值控件读 bool 本来就是按 0/1 走，
        //   所以统一显示成 int 并锁住，真实类型写在提示里。
        const noDtype = !!bindVar && !fromVar;
        if (noDtype) fromVar = 'int';
        const typeCn = rawVarType || '未填类型';       // 老工程/手改过的变量可能压根没写类型
        const isArray = /\[\]$/.test(rawVarType);   // 绑的是数组变量（如 OPC UA 导进来的 int[]）
        const typeLocked = !!bindVar && (dtypeLocked || noDtype);   // dtypeLocked = OPC UA + 绑了变量
        const t = fromVar || v || dtypeFromFmt(w.props.fmt);
        const dec = w.props.decimals ?? decimalsFromFmt(w.props.fmt);
        const isInt = t === 'int' || t === 'uint';
        const isFloat = t === 'float' || t === 'real' || t === 'lreal' || !['int', 'uint', 'dint', 'udint', 'string'].includes(t);
        // ⚠ 这两句必须**先判 bindVar 再取字段**：没绑变量时 bindVar 是 null，
        //   拼模板串时无脑取 .name 会当场抛异常 → 整个属性面板渲染中断，
        //   面板停在上一屏内容（看着就像"点了控件没反应"）。踩过。
        const lockTip = !bindVar ? ''
          : dtypeLocked
            ? `OPC UA：变量「${bindVar.name}」的类型（${rawVarType}）是导入时从服务器读到的，以 PLC 为准，这里不能改；要换类型请在 PLC 那边改完重新导入`
            : `变量「${bindVar.name}」是 ${typeCn} —— 没有对应的数值格式，数值控件按 0/1 显示，这一格固定按 int 走。类型以变量为准，要改去左侧「变量」面板改`;
        html += `<select class="f-select" data-dtype="${p.key}" style="flex:1"${typeLocked ? ' disabled' : ''}
          title="${esc(typeLocked ? lockTip
            : (bindVar
              ? (isArray
                ? `跟变量「${bindVar.name}」的元素类型一致（${rawVarType}）；改这里换的是数组元素类型，数组本身不变`
                : `跟变量「${bindVar.name}」的类型一致（${rawVarType}）；改这里就是改变量表里的类型`)
              : '控件没绑变量 → 这里只决定显示格式'))}">
          <option value="int" ${isInt && t === 'int' ? 'selected' : ''}>int 整数（16 位）</option>
          <option value="uint" ${t === 'uint' ? 'selected' : ''}>uint 无符号（16 位）</option>
          <option value="dint" ${t === 'dint' ? 'selected' : ''}>dint 双整数（32 位）</option>
          <option value="udint" ${t === 'udint' ? 'selected' : ''}>udint 无符号双整数</option>
          <option value="float" ${isFloat ? 'selected' : ''}>float/real 浮点</option>
          <option value="lreal" ${t === 'lreal' ? 'selected' : ''}>lreal 双精度浮点</option>
          <option value="string" ${t === 'string' ? 'selected' : ''}>string 字符串</option>
        </select>
        ${isFloat ? `<input class="f-input" data-dtype-dec="${p.key}" type="number" min="0" max="6" step="1"
          value="${dec}" placeholder="小数位" title="小数位：0=无小数点，1~6=保留几位小数" style="width:76px;flex:none">` : ''}`;
        if (typeLocked) {
          dtypeLockMsg = dtypeLocked
            ? '🔒 OPC UA 变量是导入的：类型以 PLC 为准，这里只看不改（要换类型去 PLC 改完重新导入）'
            : `🔒 变量「${esc(bindVar.name)}」是 <b>${esc(typeCn)}</b>：没有对应的数值格式，按 0/1 显示，这里固定 int（类型以变量为准，要改去「变量」面板改）`;
        }
      } else if (p.type === 'stateColors') {
        // 下拉框：每个状态一个颜色块。颜色**不另存一张表**，写回的就是「选项」里那一行末尾的
        // `=#颜色`（单一数据源）—— 两处各存一份，早晚有一天对不上，现场就成了"颜色没跟着改"。
        const opts = parseOptions(w.props.items);
        html += opts.length
          ? `<div class="sc-list">${opts.map((o, i) => `<div class="sc-row${o.color ? ' has' : ''}">
              <input type="color" class="sc-color" data-statecolor="${i}" value="${o.color || '#94a3b8'}"
                title="${esc(o.label)}：${o.color ? esc(o.color) : '未设色（点色块选一个）'}">
              <span class="sc-name" title="${esc(o.label)}">${esc(o.label)}</span>
              ${o.color ? `<button class="tb-btn sm sc-clr" data-stateclear="${i}" title="清掉「${esc(o.label)}」的颜色">✕</button>` : ''}
            </div>`).join('')}</div>`
          : '<span style="color:var(--text-2);font-size:11px">先在「选项」里填上状态（一行一个），这里就会列出每个状态的色块</span>';
      } else if (p.type === 'textarea') {
        // 多行文本（表格的「内容」：一行一行写，逗号分列）
        const shown = v ?? (p.defFrom ? w.props[p.defFrom] : undefined) ?? '';
        html += `<textarea class="f-input f-area" data-prop="${p.key}" rows="${p.rows || 5}"
          placeholder="${esc(p.placeholder || '')}">${esc(shown)}</textarea>`;
      } else if (p.type === 'varOrValue') {
        /* 「固定值 / 变量」二选一的一格（数值控件的输入范围上下限用）。
           两种模式的输入框**都画出来**，切模式只切显隐 —— 不整面板重建，
           正在打字的框不会被换掉、焦点也不会丢。
           固定值存字符串（空 = 这一端不限，见 core/utils.js 那段说明）；
           变量格跟别处的变量格一样挂候选表（data-vpick=limit，只对数值变量友好）。 */
        const mode = w.props[p.modeKey] === 'var' ? 'var' : 'fixed';
        const varName = String(w.props[p.varKey] ?? '');
        html += `<span class="vv">
          <select class="f-select vv-mode" data-vvmode="${p.modeKey}"
            title="这一端从哪来：写死一个数，还是跟一个变量的运行值走（如 PLC 下发的配方上下限）">
            <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>固定值</option>
            <option value="var" ${mode === 'var' ? 'selected' : ''}>变量</option>
          </select>
          <input class="f-input vv-val${mode === 'fixed' ? '' : ' hidden'}" data-prop="${p.key}"
            inputmode="decimal" value="${esc(v ?? '')}" placeholder="不限"
            title="这一端的固定值；留空 = 这一端不限">
          <span class="vf vv-var${mode === 'var' ? '' : ' hidden'}">
            <input class="f-input vf-inp" data-prop="${p.varKey}" data-vpick="limit"
              value="${esc(varName)}" placeholder="点开选变量"
              title="选一个数值变量，用它的运行值当这一端的限制">
            <button type="button" class="vf-clear" tabindex="-1" title="清空 = 这一端不限"
              ${varName ? '' : 'hidden'}>✕</button>
          </span>
        </span>`;
      } else {
        // defFrom：老控件缺键时显示回落属性的值（如 lamp 双状态文字回落旧 text），一经编辑即固化新键
        const shown = v ?? (p.defFrom ? w.props[p.defFrom] : undefined) ?? '';
        html += `<input class="f-input" data-prop="${p.key}" value="${esc(shown)}">`;
      }
      html += `</div>`;
      if (p.hint) {
        html += `<div class="f-row"><span class="f-label"></span>
          <span style="color:var(--text-2);font-size:11px;line-height:1.5">${esc(p.hint)}</span></div>`;
      }
      // 锁住的那一行要把「为什么不能改」明说出来 —— disabled 控件的 title 不一定有人去悬停
      if (p.type === 'dtype' && dtypeLockMsg) {
        html += `<div class="f-row"><span class="f-label"></span>
          <span style="color:var(--text-2);font-size:11px;line-height:1.5">${dtypeLockMsg}</span></div>`;
      }
    };
    /** 渲染一条属性并把它单独取出来（见 renderProp 上面那段说明） */
    const propRow = (p) => {
      const saved = html;
      html = '';
      renderProp(p);
      const out = html;
      html = saved;
      return out;
    };
    /**
     * **按 group 分栏**：schema 里写了 `p.group` 的属性单独成一组（各自可折叠、折叠状态各自记）。
     * 现场要的就是这个：按钮的「状态显示」（满足/未满文字、比较、底色）从一大串"按钮属性"里
     * 分出来一栏，不看的时候收起来 —— 不用在几十行里往下翻。
     * 没写 group 的照旧放在「<控件名> 属性」那一栏里，顺序不变。
     */
    const mainProps = def.props.filter(p => !p.group);
    const groups = [];
    def.props.filter(p => p.group).forEach(p => {
      let g = groups.find(x => x.name === p.group);
      if (!g) { g = { name: p.group, list: [] }; groups.push(g); }
      g.list.push(p);
    });
    if (mainProps.length) {
      html += `<div class="prop-group"><div class="prop-group-title">${def.title} 属性</div>`
        + mainProps.map(propRow).join('') + '</div>';
    }
    groups.forEach(g => {
      html += `<div class="prop-group"><div class="prop-group-title">${g.name}</div>`
        + g.list.map(propRow).join('') + '</div>';
    });
  }

  // 数据绑定（单变量）：**输入框本身就是搜索框**，点开是全量候选（datalist）
  if (def.binding?.variable) {
    const b = def.binding.variable;
    const cur = w.bindings?.variable || '';
    const issue = varIssueOf({ value: cur, dataset: { bind: 'variable' } }, w);
    html += `
    <div class="prop-group">
      <div class="prop-group-title">数据绑定</div>
      <div class="f-row"><span class="f-label">${b.label || '绑定变量'}</span>
        ${varInputHtml({ value: cur, kind: 'bind', bind: 'variable', issue,
          placeholder: '输入变量名（可搜，或点开下拉选）', clearTitle: '清空（不绑定变量）' })}</div>
    </div>`;
  }

  // 数据绑定（多通道，波形控件）：固定 8 个槽位，每路一个输入框；留空 = 该路停用
  if (def.binding?.variables) {
    const b = def.binding.variables;
    const max = b.max || 8;
    const raw = Array.isArray(w.bindings?.variables) ? w.bindings.variables : [];
    const used = raw.filter(Boolean);
    html += `
    <div class="prop-group">
      <div class="prop-group-title">${b.label || '数据通道'}（${used.length}/${max}）</div>
      <div class="chan-list">
        ${Array.from({ length: max }, (_, slot) => {
          const name = raw[slot] || '';
          const color = w.props.colors?.[name] || TREND_PALETTE[slot % TREND_PALETTE.length];
          const dupAt = name ? raw.findIndex((n, i) => n === name && i !== slot) : -1;
          const issue = varIssueOf({ value: name, dataset: { chanslot: String(slot) } }, w);
          return `<div class="chan-row${name ? ' on' : ''}">
            <span class="chan-no">${slot + 1}</span>
            <input type="color" class="chan-color" data-chancolor="${esc(name)}" value="${color}" ${name ? '' : 'disabled'} title="该通道颜色">
            ${varInputHtml({ value: name, kind: 'chan', chanslot: String(slot), issue, cls: 'chan-sel',
              placeholder: '（未使用）输入变量名',
              title: dupAt >= 0 ? `⚠「${name}」已在通道${dupAt + 1}用了` : '输入变量名（可搜，或点开下拉选）',
              clearTitle: '清空 = 停用这一路' })}
          </div>`;
        }).join('')}
      </div>
      <div style="color:var(--text-2);font-size:11px;margin-top:4px">
        最多 ${max} 路，某一路留空即停用该通道；同一变量只能选一次（重复的会标红）。
        运行时按「采样周期」记录，「时间窗口」决定屏幕显示多长时间。
      </div>
      ${used.length ? `<div class="scale-list">
        <div class="scale-head">通道量程：显示值 = 原值 × 倍率 + 偏置（多路信号量级差很多时用它对齐，如 ×0.001）</div>
        ${used.map(name => {
          const s = w.props.scales?.[name] || {};
          return `<div class="scale-row">
            <span class="chan-name">${esc(name)}</span>
            <span class="scale-lbl">×</span>
            <input class="f-input scale-inp" type="number" step="any" data-scalek="${esc(name)}" value="${s.k ?? 1}" title="倍率">
            <span class="scale-lbl">+</span>
            <input class="f-input scale-inp" type="number" step="any" data-scaleb="${esc(name)}" value="${s.b ?? 0}" title="偏置">
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>`;
  }

  // 动作
  if (def.actions?.length) {
    // 有「状态显示变量」的控件（按钮/数值/输入…）才能谈「动作变量跟显示变量一致」
    const canFollow = !!def.binding?.variable;
    html += `
    <div class="prop-group">
      <div class="prop-group-title">动作（点击触发）</div>
      ${canFollow ? `<label class="act-follow" title="勾上后动作里的变量跟「状态显示」的变量一致：改显示变量，动作变量跟着改，不用改两处">
        <input type="checkbox" class="f-check" id="actFollow" ${w.followBind ? 'checked' : ''}>
        <span>变量与「状态显示」的变量一致</span></label>` : ''}
      <div id="actList"></div>
      ${(w.followBind && !w.bindings?.variable) ? `<div class="act-follow-tip">已勾选「变量与显示的变量一致」，但上面「数据绑定」里还没选显示变量 —— 选一个，动作变量就跟着它。</div>` : ''}
      <button class="act-add" id="actAdd">＋ 添加动作</button>
    </div>`;
  }

  body.innerHTML = html;

  // 「在组合里」那条提示上的「选中整组」按钮
  document.getElementById('pickWholeGroup')?.addEventListener('click', () => {
    select(project.groupMembers(w.id));
  });

  // 「权限管理…」：等级表（名字 + 密码）在那里配 —— 就在属性面板里点得到，不用去翻菜单
  document.getElementById('permCfgBtn')?.addEventListener('click', () => {
    import('./toolbar.js').then(m => m.openPermDialog()).catch(e => alert('打不开权限管理：' + (e?.message || e)));
  });

  /* ── 事件绑定 ── */
  // 输入即生效：文本/数字/色板在 input 时就写进工程 → 画布立刻跟着变（原来要等失焦才好）
  // number 只在 change（失焦/回车）时把钳位后的值回写输入框，否则边打字边回写会把输入顶掉
  body.querySelectorAll('[data-fld]').forEach(inp => {
    const apply = normalize => {
      const k = inp.dataset.fld;
      let v = inp.value;
      if (k !== 'name') {
        v = +v || 0;
        if ((k === 'w' || k === 'h') && v < 8) v = 8;
        if (normalize) inp.value = v;
      }
      project.updateWidgetField(w.id, k, v);
      commitLater();
    };
    inp.addEventListener('input', () => apply(false));
    inp.addEventListener('change', () => apply(true));
  });
  body.querySelectorAll('[data-lock]').forEach(inp => {
    inp.addEventListener('change', () => {
      project.updateWidgetField(w.id, 'locked', inp.checked);
      commitLater();
    });
  });
  body.querySelectorAll('[data-prop]').forEach(inp => {
    const isCheck = inp.type === 'checkbox';
    const isSelect = inp.tagName === 'SELECT';
    const apply = normalize => {
      let v;
      if (isCheck) v = inp.checked;
      else if (inp.type === 'number') {
        // 数值属性存成 number（原来存字符串，清空还会变成 NaN/0）——超出 min/max 按边界收敛
        const min = inp.min === '' ? -Infinity : Number(inp.min);
        const max = inp.max === '' ? Infinity : Number(inp.max);
        const n = Number(inp.value);
        v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : (Number.isFinite(min) ? min : 0);
        if (normalize) inp.value = v;
      } else v = inp.value;
      project.updateWidgetProp(w.id, inp.dataset.prop, v);
      commitLater();
      // 状态显示勾选切换 → 满足文字/比较行需联动显隐
      // showIf 指向的那些开关（如「范围限制」）→ 它管着的行要跟着出现/收起
      if (inp.dataset.prop === 'showState'
        || (def.props || []).some(pp => pp.showIf === inp.dataset.prop)) render();
    };
    // 图片地址不跟着每个字符变（会一路闪裂图），等 change
    if (!isCheck && !isSelect && inp.dataset.prop !== 'src') inp.addEventListener('input', () => applySoon(inp, () => apply(false)));
    // 改完（失焦/回车/松开色板）立刻落地，不用再等那 300ms
    inp.addEventListener('change', () => { cancelSoon(inp); apply(true); });
  });
  // 数据类型（dtype）：切换写 dispType 并同步 fmt；浮点要重渲染以显隐小数位输入。
  // ⚠ 控件绑了变量时，这一格显示的是**变量的类型**（控件和变量必须一致），
  //   改它 = 改**变量表里的类型** —— 只改控件自己的 dispType 会出现"显示对了、通讯按老类型解"。
  body.querySelectorAll('[data-dtype]').forEach(sel => {
    sel.addEventListener('change', () => {
      const t = sel.value;
      // 空值/认不出的值（脚本或测试直接把 value 设成了没有的选项）→ 当没这回事：
      // 顺着它写回变量表会把类型写成空串，变量就成了"没有类型"，比不改坏得多。踩过。
      if (!varTypeOfDtype(t)) return;
      const bind = project.getWidget(w.id)?.bindings?.variable || '';
      const bv = bind ? project.variables().find(v => v.name === bind) : null;
      if (bv) {
        // OPC UA：导入来的类型不许在控件属性里改（disabled 的 select 本来也点不动，
        // 这里是双保险：脚本改 value + dispatchEvent 也拦住）
        if (backend.isOpcua()) return;
        // bool / 认不出的类型（没有对应的数值格式）：**也不许改** ——
        // 这一格显示的是"按 int 走"的兜底值，真要顺着它写回变量表，就把 bool 变量
        // 改成了 int（地址还指着原来的位，读写全乱）。类型以变量为准，去变量面板改。
        if (!dtypeOfVarType(bv.type)) return;
        // 绑着变量 → 改变量表（updateVariable 自己会 commit；变量类型一变，
        // project.syncWidgetDispType 会把所有绑它的数值控件一起同步）
        // ⚠ 数组变量（OPC UA 导进来的 int[] 这种）要**保住 []**：
        //   直接写 'real' 会把数组变量改成标量 —— 地址还指着数组节点，
        //   类型却成了标量，读写都对不上，等于点一下下拉把变量弄坏了。
        const arr = /\[\]$/.test(String(bv.type || '')) ? '[]' : '';
        project.updateVariable(bv.name, { type: varTypeOfDtype(t) + arr });
      } else {
        project.updateWidgetProp(w.id, 'dispType', t);
        project.updateWidgetProp(w.id, 'fmt',
          fmtOfDtype(t, w.props.decimals ?? 1));
      }
      commitLater();
      render();
    });
  });
  // float 的小数位：写 decimals 并同步 fmt（0=%.0f 无小数点）
  body.querySelectorAll('[data-dtype-dec]').forEach(inp => {
    inp.addEventListener('change', () => {
      if (inp.value === '') return;
      const n = Math.max(0, Math.min(6, Math.round(+inp.value || 0)));
      inp.value = n;   // 回写规范化后的值
      project.updateWidgetProp(w.id, 'decimals', n);
      project.updateWidgetProp(w.id, 'fmt', '%.' + n + 'f');
      commitLater();
    });
  });
  /* ── 下拉框的「状态颜色」：每个状态一个色块，写回「选项」各行末尾（单一数据源） ──
     用 input 事件（取色器拖着就实时变，画布当场跟着变）而不是等 change；
     ⚠ 不调 render()：重画面板会把正在用的取色器连同 input 元素一起换掉，颜色就选不下去了。
     只把「选项」那个文本框的值同步过去，肉眼能看见颜色写在哪一行。 */
  const applyStateColor = (idx, color) => {
    const cur = project.getWidget(w.id);
    if (!cur) return;
    const next = setOptionColor(cur.props.items, idx, color);
    if (next === cur.props.items) return;
    project.updateWidgetProp(w.id, 'items', next);
    commitLater();
    const ta = body.querySelector('[data-prop="items"]');
    if (ta) ta.value = next;
  };
  body.querySelectorAll('[data-statecolor]').forEach(inp => {
    inp.addEventListener('input', () => applyStateColor(Number(inp.dataset.statecolor), inp.value));
    inp.addEventListener('change', () => { applyStateColor(Number(inp.dataset.statecolor), inp.value); render(); });
  });
  body.querySelectorAll('[data-stateclear]').forEach(btn => {
    btn.addEventListener('click', () => {
      applyStateColor(Number(btn.dataset.stateclear), '');
      render();                                  // 清掉色块后那行的 ✕ 也要跟着消失
    });
  });

  body.querySelectorAll('[data-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      project.updateWidgetProp(w.id, btn.dataset.clear, '');
      commitLater();
      render();
    });
  });
  // 图片选择：本地文件读为 base64 内嵌进工程
  body.querySelectorAll('[data-imgpick]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.imgpick;
      const fi = body.querySelector(`[data-imgfile="${key}"]`);
      if (!fi) return;
      fi.onchange = () => {
        const file = fi.files[0];
        if (!file) return;
        const fr = new FileReader();
        fr.onload = () => {
          project.updateWidgetProp(w.id, key, fr.result);   // dataURL 存入工程 JSON
          commitLater();
          render();   // 刷新预览
        };
        fr.readAsDataURL(file);
      };
      fi.click();
    });
  });
  body.querySelectorAll('[data-bind]').forEach(sel => {
    const apply = () => {
      project.updateWidgetField(w.id, 'bindings.variable', sel.value.trim());
      // 勾了「动作变量和显示变量一致」→ 显示变量一改，动作里的变量跟着改
      const cur = project.getWidget(w.id);
      if (cur?.followBind && syncFollowBind(cur, sel.value.trim())) project.commit('修改绑定变量');
      commitLater();
    };
    // 边打字边体检（标红 + 说明）；写进工程还是等 change —— 边打字边写会把
    // 半截变量名（"bMot"）也当成绑定值存进去，撤销里还留一串中间态
    sel.addEventListener('input', () => markVarInput(sel, w));
    sel.addEventListener('change', () => {
      apply();
      render();   // 绑定变量类型变化 → 比较行显隐联动刷新
    });
  });

  /* ── 多通道（波形）：填变量 = 启用该路；就地更新，不整面板重建 ── */
  const chanMax = def.binding?.variables?.max || 8;
  const applyChan = (inp) => {
    const cur = project.getWidget(w.id) || w;
    const slot = +inp.dataset.chanslot;
    const arr = Array.from({ length: chanMax }, (_, i) => (cur.bindings?.variables || [])[i] || '');
    const name = inp.value.trim();
    // 同一变量占两路 = 画面上两条一模一样的线（颜色还不一样），现场只会更迷惑：
    // 占用了就退回去（保留原来那一路的值）并说清是哪一路占了，别默默写进去。
    const dupAt = name ? arr.findIndex((n, i) => n === name && i !== slot) : -1;
    if (dupAt >= 0) {
      inp.value = arr[slot];
      inp.classList.remove('bad');
      statusNote(`「${name}」已经在通道${dupAt + 1}用了 —— 同一变量只能占一路`);
      return;
    }
    arr[slot] = name;
    project.updateWidgetField(w.id, 'bindings.variables', arr);
    project.commit('修改数据通道');
  };
  body.querySelectorAll('[data-chanslot]').forEach(inp => {
    inp.addEventListener('input', () => markVarInput(inp, w));
    inp.addEventListener('change', () => { applyChan(inp); render(); });
  });
  /* ── 通道量程（倍率/偏置）：输入即生效 ── */
  const setScale = (name, key, val) => {
    const cur = project.getWidget(w.id);
    if (!cur) return;
    const scales = { ...(cur.props.scales || {}) };
    const one = { k: 1, b: 0, ...(scales[name] || {}) };
    one[key] = val;
    scales[name] = one;
    cur.props.scales = scales;
    project.touch();
    commitLater();
  };
  body.querySelectorAll('[data-scalek]').forEach(inp => {
    inp.addEventListener('input', () => {
      const n = Number(inp.value);
      setScale(inp.dataset.scalek, 'k', Number.isFinite(n) ? n : 1);
    });
  });
  body.querySelectorAll('[data-scaleb]').forEach(inp => {
    inp.addEventListener('input', () => {
      const n = Number(inp.value);
      setScale(inp.dataset.scaleb, 'b', Number.isFinite(n) ? n : 0);
    });
  });

  /* ── 通道颜色 ── */
  body.querySelectorAll('[data-chancolor]').forEach(inp => {
    inp.addEventListener('input', () => {
      if (!inp.dataset.chancolor) return;          // 未使用的槽位
      const cur = project.getWidget(w.id);
      if (!cur) return;
      cur.props.colors = { ...(cur.props.colors || {}), [inp.dataset.chancolor]: inp.value };
      project.touch();
      commitLater();
    });
  });

  /* ── 「固定值 / 变量」二选一那一格（数值控件的范围上下限）──
     切模式只切两个输入框的显隐 + 把模式写进工程（值都留着：切回固定值时
     刚才那个数还在，不会"切一下模式就把配好的东西弄没了"）。 */
  body.querySelectorAll('[data-vvmode]').forEach(sel => {
    sel.addEventListener('change', () => {
      const isVar = sel.value === 'var';
      project.updateWidgetProp(w.id, sel.dataset.vvmode, isVar ? 'var' : 'fixed');
      const box = sel.closest('.vv');
      box?.querySelector('.vv-val')?.classList.toggle('hidden', isVar);
      box?.querySelector('.vv-var')?.classList.toggle('hidden', !isVar);
      commitLater();
    });
  });
  /* 范围上下限里的变量格：跟别处的变量格一样当场体检（变量表里没有 / 类型不是数值 → 标红） */
  body.querySelectorAll('[data-vpick="limit"]').forEach(inp => {
    inp.addEventListener('input', () => markVarInput(inp, w));
  });

  /* ── 变量输入框右侧的 ✕：清空（= 不绑定 / 停用这一路） ── */
  body.querySelectorAll('.vf-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = btn.parentElement?.querySelector('.vf-inp');
      if (!inp) return;
      inp.value = '';
      // 走 change：清空也要真的写进工程（和手输了再删空是一样的路径）
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.focus();
    });
  });

  // 动作编辑器
  const actList = body.querySelector('#actList');
  if (actList) renderActions(actList, w);
  // 变量候选表：绑定格 / 8 路通道格（动作里的在 renderActions 里各挂各的）
  wireVarPicks(body, w);
  /* ── 「变量与显示的变量一致」：勾上就把状态显示变量写进所有要变量的动作；
        以后改显示变量，动作变量自动跟着走（改一处即可） ── */
  const followEl = document.getElementById('actFollow');
  if (followEl) followEl.addEventListener('change', () => {
    const cur = project.getWidget(w.id);
    if (!cur) return;
    cur.followBind = followEl.checked;
    // ⚠ 只在这时**确实有显示变量**才把动作变量改掉：没有显示变量还把动作变量清空，
    //   等于勾一下勾选框把用户配好的变量弄没了（踩过）—— 那种情况只提示去选显示变量
    if (followEl.checked && cur.bindings?.variable) syncFollowBind(cur, cur.bindings.variable);
    project.touch();
    commitLater();
    render();                                  // 只读/可编辑要跟着切换
  });
  wireFold(body);
}

/**
 * 把「状态显示」的变量写进所有需要变量的动作（返回是否真的改了）。
 * 只在 followBind 勾上时调用：用户不想两处各改一遍还改不一致。
 */
function syncFollowBind(w, name) {
  let changed = false;
  const next = (w.actions || []).map(a => {
    if (!ACTION_DEFS[a.type]?.params?.variable) return a;
    if ((a.params?.variable || '') === (name || '')) return a;
    changed = true;
    return { ...a, params: { ...(a.params || {}), variable: name || '' } };
  });
  if (changed) project.updateWidgetActions(w.id, next);
  return changed;
}

/* ═══════════ 动作编辑器 ═══════════ */
function renderActions(box, w) {
  const def = registry.get(w.type);
  const acts = w.actions || [];
  box.innerHTML = acts.length ? '' : '<div style="color:var(--text-2);font-size:11px;margin-bottom:6px">暂无动作。点击按钮时将执行以下动作序列：</div>';

  /** 结构变化后立即就地重绘动作列表。
   *  ⚠️ 必须显式重绘：点 ✕ / 「添加动作」时焦点还在属性面板里，project:changed 的
   *  「正在输入不重建」保护会跳过整面板刷新 —— 不重绘就会出现「删了还在」、
   *  以及残留行按旧下标把已删动作写回去的问题。 */
  const refresh = () => {
    const cur = project.getWidget(w.id) || w;
    renderActions(box, cur);
  };  const fresh = () => project.getWidget(w.id) || w;

  acts.forEach((act, i) => {
    const adef = ACTION_DEFS[act.type] || { label: `未知动作（${act.type}）`, params: {} };   // 未知类型不再让整个面板渲染崩掉
    const item = document.createElement('div');
    item.className = 'act-item';
    // 需要变量/页面却没配 → 标红提示：这类动作运行时会静默失效（以前完全无感知）
    const needVar = ACTION_DEFS[act.type]?.params?.variable && !act.params?.variable;
    const needPage = ACTION_DEFS[act.type]?.params?.page && !act.params?.page;
    if (needVar || needPage) item.classList.add('act-invalid');
    let paramsHtml = '';
    if (adef.params.variable) {
      // 勾了「和显示变量一致」且确实有显示变量 → 这里只读（改上面的显示变量即可），省得两处各改一遍还改不一致
      const follow = !!w.followBind && !!w.bindings?.variable;
      const curVar = act.params?.variable || '';
      const issue = follow ? '' : varIssueOf({ value: curVar, dataset: { ap: 'variable' } }, w);
      paramsHtml += `<div class="f-row"><span class="f-label">变量</span>
        ${follow
    ? `<span class="vf"><input class="f-input vf-inp" data-ai="${i}" data-ap="variable" readonly
          value="${esc(curVar)}" title="已勾选「变量与显示的变量一致」，改上面「数据绑定」里的显示变量就行"></span>`
    : varInputHtml({ value: curVar, kind: 'act', ap: 'variable', ai: String(i), issue,
      placeholder: '输入变量名（可搜，或点开下拉选）', clearTitle: '清空变量' })}</div>`;
    }
    if (adef.params.page) {
      const pages = project.pages().filter(p => p.type === (act.type === 'showPopup' ? 'popup' : 'page'));
      paramsHtml += `<div class="f-row"><span class="f-label">目标页</span>
        <select class="f-select" data-ai="${i}" data-ap="page">
          <option value="">（选择页面）</option>
          ${pages.map(p =>
            `<option value="${p.id}" ${act.params?.page === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>`;
    }
    if (adef.params.value) {
      paramsHtml += `<div class="f-row"><span class="f-label">值</span>
        <input class="f-input" data-ai="${i}" data-ap="value" value="${esc(act.params?.value ?? '')}" placeholder="true / 12.5 / 文本"></div>`;
    }
    item.innerHTML = `
      <div class="act-head">
        <select class="f-select" data-ai="${i}" data-atype="1">
          ${def.actions.includes(act.type) ? '' : `<option value="${esc(act.type)}" selected>${esc(adef.label)}</option>`}
          ${def.actions.map(t => `<option value="${t}" ${act.type === t ? 'selected' : ''}>${ACTION_DEFS[t].label}</option>`).join('')}
        </select>
        <button class="act-del" title="删除动作">✕</button>
      </div>
      ${(needVar || needPage) ? `<div class="act-warn">⚠ 未选择${needVar ? '变量' : '目标页'}，运行时不生效</div>` : ''}
      ${paramsHtml}`;
    item.querySelector('.act-del').addEventListener('click', () => {
      const cur = fresh();
      const next = [...(cur.actions || [])];
      // 渲染后被别处改过（行数对不上）→ 旧下标会删错行：先重绘再让用户点一次
      if (next.length !== acts.length) return refresh();
      next.splice(i, 1);
      project.updateWidgetActions(w.id, next);
      project.commit('删除动作');
      refresh();     // 立即重绘：否则行会留在面板上，直到切页/重选控件才消失
    });
    item.querySelectorAll('[data-ap]').forEach(inp => {
      // 变量格：边打字边标红（变量表里没有/类型不匹配），写进工程还是等 change
      if (inp.dataset.ap === 'variable') inp.addEventListener('input', () => markVarInput(inp, fresh()));      inp.addEventListener('change', () => {
        // 从控件当前值取（不用渲染时的闭包副本）：行数变化后旧下标会把已删动作写回去
        const cur = fresh();
        const next = [...(cur.actions || [])];
        const idx = +inp.dataset.ai;
        if (idx >= next.length) return refresh();
        next[idx] = { ...next[idx], params: { ...(next[idx].params || {}), [inp.dataset.ap]: inp.value } };
        project.updateWidgetActions(w.id, next);
        commitLater();
      });
    });
    wireVarPicks(item, w);     // 每个动作的变量格也得挂候选表（这块 DOM 是这里现建的）
    box.appendChild(item);
  });

  // 类型切换：**保留新类型用得上的参数**（用户只是换个动作模式，变量不该被清掉 —— 反馈过）
  box.querySelectorAll('[data-atype]').forEach(sel => {
    sel.addEventListener('change', () => {
      const cur = fresh();
      const next = [...(cur.actions || [])];
      const idx = +sel.dataset.ai;
      if (idx >= next.length) return refresh();
      const old = next[idx].params || {};
      const keep = {};
      Object.keys(ACTION_DEFS[sel.value]?.params || {}).forEach(k => { if (old[k] !== undefined) keep[k] = old[k]; });
      // 原来就没配变量：按「添加动作」的老口径默认跟状态显示变量同源
      if (ACTION_DEFS[sel.value]?.params?.variable && !keep.variable && cur.bindings?.variable) {
        keep.variable = cur.bindings.variable;
      }
      next[idx] = { trigger: 'click', type: sel.value, params: keep };
      project.updateWidgetActions(w.id, next);
      project.commit('切换动作类型');
      refresh();
    });
  });

  // 添加（按钮在同一个 prop-group 里，不在 box 内）
  // ⚠️ 必须用 onclick 赋值而不是 addEventListener：#actAdd 是常驻元素（box 只重建 #actList），
  // 每次重绘都 addEventListener 会叠加监听器 —— 点到第 N 次会一次添加 N 个动作
  const addBtn = document.getElementById('actAdd');
  if (addBtn) addBtn.onclick = () => {
    const cur = fresh();
    // 动作变量默认与控件绑定的状态显示变量同源（用户约定：操作和显示默认同一个变量）
    const act = { trigger: 'click', type: def.actions[0],
      params: ACTION_DEFS[def.actions[0]].params.variable && cur.bindings?.variable
        ? { variable: cur.bindings.variable } : {} };
    const next = [...(cur.actions || []), act];
    project.updateWidgetActions(w.id, next);
    project.commit('添加动作');
    refresh();
  };
}

/* ═══════════ 变量输入框（输入即检索 + 当场体检） ═══════════ */

/**
 * 变量输入框的 HTML：`<span class="vf">` 里一个输入框（挂 varPick 候选表）+ 一个 ✕ 清空。
 * 为什么自己包一层而不是直接 <input>：✕ 要**压在输入框右端**（不占布局宽度），
 * 且只在有值时出现 —— 通道那 8 行本来就窄，多一个按钮就把变量名挤没了。
 * data-vpick：这个框是哪一种变量格（bind/chan/act），候选表的备注按它来算。
 */
function varInputHtml(o) {
  const attrs = [
    o.bind ? ` data-bind="${esc(o.bind)}"` : '',
    o.chanslot !== undefined ? ` data-chanslot="${esc(o.chanslot)}"` : '',
    o.ap ? ` data-ap="${esc(o.ap)}" data-ai="${esc(o.ai)}"` : '',
    o.kind ? ` data-vpick="${esc(o.kind)}"` : '',
  ].join('');
  const title = o.issue || o.title || '输入变量名（按名称搜），或点开下拉选';
  return `<span class="vf">
    <input class="f-input vf-inp${o.cls ? ` ${o.cls}` : ''}${o.issue ? ' bad' : ''}"${attrs}
      value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}"
      title="${esc(title)}">
    <button type="button" class="vf-clear" tabindex="-1" title="${esc(o.clearTitle || '清空')}"
      ${o.value ? '' : 'hidden'}>✕</button>
  </span>`;
}

/**
 * 候选表里某一行的备注（只提示，不隐藏 —— 为什么不能用得让人看得见）：
 *   chan：这个变量已经被**别的**通道占了（同一变量占两路 = 画面上两条一样的线）
 *   limit：输入范围上下限必须是数值变量（拿字符串变量去做限制 = 静默失效）
 *   任何格：类型跟这个控件对不上（拿 string 变量去做数值显示，运行起来是静默失效）
 */
function varNoteFn(kind, w, types, slot) {
  return (name) => {
    if (kind === 'chan') {
      const used = project.getWidget(w.id)?.bindings?.variables || [];
      const at = used.findIndex((n, i) => n === name && i !== slot);
      if (at >= 0) return `已在通道${at + 1}`;
    }
    const v = project.variables().find(x => x.name === name);
    if (types && v?.type && !types.includes(v.type)) return `类型不匹配（${v.type}）`;
    return '';
  };
}

/** 把候选表挂到这一批变量输入框上（照 kind 给各自的候选与备注） */
function wireVarPicks(root, w) {
  const def = registry.get(w.type) || {};
  root.querySelectorAll('[data-vpick]').forEach(inp => {
    const kind = inp.dataset.vpick;
    const types = kind === 'bind' ? (def.binding?.variable?.types || null)
      : kind === 'chan' ? (def.binding?.variables?.types || CHAN_TYPES)
      : kind === 'limit' ? LIMIT_TYPES : null;
    // 全量候选（**不按类型过滤**）：类型不对的在行里注明，用户才知道为什么这个变量标红
    attachVarPick(inp, {
      list: () => project.variables(),
      note: varNoteFn(kind, w, types, kind === 'chan' ? +inp.dataset.chanslot : -1),
    });
  });
}

/**
 * 这个变量名有什么问题（没问题返回空串）。
 * 为什么要当场说：变量改名/删掉之后，控件里那个名字**看着还好好的**，
 * 运行起来却毫无反应；类型对不上（拿 string 变量去显示数值）也是同样"静默失效"。
 * 名字对了还查「是不是被别的通道占了」——同一变量重复占两路，波形会画成两条一样的线。
 */
function varIssueOf(inp, w) {
  const name = String(inp?.value ?? '').trim();
  if (!name || !w) return '';
  const def = registry.get(w.type) || {};
  if (inp.dataset.bind) {
    const types = def.binding?.variable?.types;
    const v = project.variables().find(x => x.name === name);
    if (!v) return `⚠ 变量表里没有「${name}」—— 运行时不生效（改名了就在这里重选一个）`;
    if (types && v.type && !types.includes(v.type)) {
      return `⚠「${name}」是 ${v.type} 类型，这个控件要 ${types.join(' / ')}`;
    }
    return '';
  }
  if (inp.dataset.chanslot !== undefined) {
    const types = def.binding?.variables?.types || CHAN_TYPES;
    const v = project.variables().find(x => x.name === name);
    const slot = +inp.dataset.chanslot;
    const dupAt = (w.bindings?.variables || []).findIndex((n, i) => n === name && i !== slot);
    if (dupAt >= 0) return `⚠「${name}」已经在通道${dupAt + 1}用了 —— 同一变量只能占一路`;
    if (!v) return `⚠ 变量表里没有「${name}」—— 这一路运行时不画线`;
    if (types && v.type && !types.includes(v.type)) {
      return `⚠「${name}」是 ${v.type} 类型，波形通道要 ${types.join(' / ')}`;
    }
    return '';
  }
  // 范围上下限的变量格：名字得在变量表里，而且必须是数值变量（bool/string 当边界 = 静默失效）
  if (inp.dataset.vpick === 'limit') {
    const v = project.variables().find(x => x.name === name);
    if (!v) return `⚠ 变量表里没有「${name}」—— 这一端运行时不限制`;
    if (v.type && !LIMIT_TYPES.includes(v.type)) {
      return `⚠「${name}」是 ${v.type}，范围上下限要数值变量（${LIMIT_TYPES.join(' / ')}）`;
    }
    return '';
  }
  // 动作里的变量：不限类型，但名字得在变量表里
  if (inp.dataset.ap) {
    if (!project.variables().some(x => x.name === name)) {
      return `⚠ 变量表里没有「${name}」—— 点这个动作不会写进去`;
    }
  }
  return '';
}

/** 把体检结果画到输入框上（标红 + 悬停说明 + ✕ 的显隐） */
function markVarInput(inp, w) {
  const issue = varIssueOf(inp, w);
  inp.classList.toggle('bad', !!issue);
  inp.title = issue || '输入变量名（按名称搜），或点开下拉选';
  const btn = inp.parentElement?.querySelector('.vf-clear');
  if (btn) btn.hidden = !String(inp.value || '').trim();
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
