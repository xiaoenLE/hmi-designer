/**
 * permissions.js — 运行态**操作权限**（现场分级密码）
 *
 * 现场要的东西：画面上的按钮/输入框不是谁都能动 —— 关键的（启停、参数设定、清记录）
 * 得先"有权限"。做法：
 *   · 组态时在「工程 ▾ → 权限管理…」里配**等级表**（等级名 + 密码，可增删、可调高低）；
 *   · 每个控件属性里有「权限等级」（所有控件都能配）：'' = 不限，其余 = 要那一级；
 *   · 运行态点到权限不够的控件 → 弹密码框 → 输对该等级的密码 → 解锁，
 *     之后**同级别和更低级别**的控件都能操作（高级别天然包含低级别）；
 *   · 退出：① 按钮动作里配「退出权限（锁定）」；② 解锁后画面顶部有个小胶囊，
 *     点它一下就退出；③ Ctrl+Shift+Q；④ 关窗口/刷新天然回到未解锁。
 *   · 自动上锁：工程里可配「解锁后无操作 N 分钟自动锁」（0 = 解锁后一直有效）。
 *
 * 密码不存明文：工程里只放 `盐 + 迭代哈希`（core/sha256.js）。工程文件本身是可被
 * 任何能访问服务器的人读到的（运行页要拿它画画面），所以别把"能拿到工程文件的人"
 * 当成威胁模型的一部分 —— 这里挡的是"现场操作工随手改参数"。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { verifyPassword } from '../core/sha256.js';

let curId = '';              // 当前解锁到的等级 id（'' = 没解锁）
let idleTimer = null;        // 自动上锁计时器
let dialogEl = null;         // 密码框（懒建）
let chipEl = null;           // 顶部"已解锁"小胶囊（懒建）
let toastEl = null;
let pending = null;          // 正在等的那个 Promise 的 resolve

/* ─────────── 只读状态 ─────────── */
const levels = () => project.permLevels();
const levelOf = (id) => project.permLevel(id);

/** 权限管理开了没（开关开了、并且至少配了一级才算数 —— 没等级就没得管） */
export function isPermEnabled() {
  return !!project.permissions().enabled && levels().length > 0;
}
/** 解锁后无操作多久自动锁（毫秒）；0 = 一直有效 */
export function lockAfterMs() {
  const m = +project.permissions().lockAfterMin || 0;
  return m > 0 ? m * 60000 : 0;
}
export const currentLevelId = () => curId;
export const currentLevelName = () => levelOf(curId)?.name || '';
/** 某个控件要求的等级 id（'' = 不限） */
export const requiredOf = (w) => String(w?.props?.permLevel || '');
/** 当前解锁的等级够不够 levelId（不限 = 永远够；高级别包含低级别） */
export function can(levelId) {
  if (!levelId) return true;
  if (!isPermEnabled()) return true;       // 没开权限管理 → 谁都能动（现场老工程行为不变）
  const need = project.permRank(levelId);
  if (need < 0) return true;               // 这个等级已经不存在了（被删）→ 不挡
  const cur = project.permRank(curId);
  return cur >= need;
}
/** 这个控件现在能不能操作 */
export const allowedFor = (w) => can(requiredOf(w));
/** 权限不够时要不要**自动弹密码框**（控件属性「操作权限 → 密码框 → 权限不够时自动弹出」）。
 *  关掉之后：权限不够就是"点不动"，不弹框也不提示 —— 现场不想把密码入口摆给操作工时用。 */
export const autoPromptOf = (w) => w?.props?.permPrompt !== false;

/* ─────────── 解锁 / 上锁 ─────────── */
/** 状态变了：刷新顶部胶囊 + 通知各处（runtime 用它重画控件上的小锁）*/
function notify(reason) {
  refreshChip();
  bus.emit('perm:changed', { level: curId, name: currentLevelName(), reason: reason || '' });
}

/** 用密码解锁某一级。成功返回 true（并重置自动上锁计时） */
export function unlock(levelId, password) {
  const lv = levelOf(levelId);
  // 没设密码的等级谁都解不开（父 pw=混淆串 / hash=老工程的哈希写法，两者有一个就行）
  if (!lv || !(lv.pw || lv.hash)) return false;
  if (!verifyPassword(password, lv)) return false;
  curId = levelId;
  touchActivity();
  // 解锁的同时把还开着的密码框收掉（脚本/别的入口解锁时也一样）——
  // 否则那层遮罩会一直盖在画面上，点哪儿都没反应
  if (pending) closeDialog(true);
  notify('unlock');
  return true;
}

/** 上锁（退出权限）。reason = 给用户看的一句话（可省） */
export function lock(reason) {
  const had = curId;
  curId = '';
  stopIdleTimer();
  if (had) {
    notify('lock');
    showToast(reason || '已退出权限');
  }
  return had !== '';
}
/** 退出运行态时清干净（别把解锁状态带到下一次运行/下一个工程） */
export function resetPerm() {
  const had = curId;
  curId = '';
  stopIdleTimer();
  closeDialog(false);
  if (had) notify('reset');
}

/**
 * 要让这个控件能操作吗？能 → true；不能 → 弹密码框，输了密码才 true（异步）。
 * 调用方拿 false 就先别执行动作（用户输完密码再按一次 —— 不做"自动补执行"：
 * 点动/长按那类动作自动补执行很容易出意外）。
 * @param {object} w 控件（用它自己的「权限等级」）
 * @param {string} [extraLevelId] 额外要求的一级（两个里取高的）——比如"清空报警记录"这一档
 */
export function ensure(w, extraLevelId) {
  const need = higherOf(requiredOf(w), extraLevelId);
  if (can(need)) { touchActivity(); return Promise.resolve(true); }
  return ensureLevel(need);
}

/** 直接对某一级要权限（没有控件的那种入口，比如报警历史控件里的「清空记录」按钮） */
export function ensureLevel(levelId, host) {
  if (can(levelId)) { touchActivity(); return Promise.resolve(true); }
  const lv = levelOf(levelId);
  if (!lv) return Promise.resolve(true);
  return openDialog(lv, host);
}

/** 两个等级取高的那个（空的那个不算数；都空 = 不限） */
export function higherOf(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return project.permRank(a) >= project.permRank(b) ? a : b;
}

/** 「清空报警记录」不再单独配一档权限：**按控件自己的「权限等级」**走。
 *  （报警历史控件里那个「清空记录」按钮 = 这个控件的一部分 —— 想保护历史记录就给那个控件配一级，
 *    跟别的控件一个口径；没配等级 = 谁都能清。） */
export const needOf = (w) => requiredOf(w);

/* ─────────── 自动上锁 ─────────── */
function stopIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}
function armIdleTimer() {
  stopIdleTimer();
  const ms = lockAfterMs();
  if (!curId || !ms) return;
  idleTimer = setTimeout(() => lock(`超过 ${Math.round(ms / 60000)} 分钟没操作，已自动退出权限`), ms);
}
/** 现场有操作（点画面/按键）就重新计时：不是"解锁后 N 分钟"，而是"N 分钟没动"才锁 */
export function touchActivity() { if (curId) armIdleTimer(); }
/** 运行态把画面上的 pointerdown/keydown 接到这里 */
export function attachActivity(el) {
  if (!el) return;
  const wake = () => touchActivity();
  el.addEventListener('pointerdown', wake, true);
  el.addEventListener('keydown', wake, true);
}

/* ─────────── 画面上的小标识 ─────────── */
/** 控件角上的 🔒 小标记（**等级不够才挂**）。
 *  **默认就显示**：不用逐个控件去"打开标记"，现场一眼就知道哪些点不动；
 *  个别控件不想显示，属性面板里把「小锁标记」取消勾选即可（`showPermBadge === false`）。
 *  **只在"要权限而且当前等级不够"时显示** —— 解锁之后标记消失（也不挂个"开着的锁"，画面更干净）。
 *  取消标记只是不显示，运行态照样拦，功能一点不受影响。
 *
 *  ⚠ **角标跟着控件大小缩放**（现场反馈：小按钮上 `🔒 等级1` 太占地方）：
 *    · 字号/内边距/圆角按控件的**短边**等比缩（0.55~1 倍）；
 *    · 只画一个 🔒，等级名放进悬停提示（点下去弹的密码框上也会写明是哪一级）；
 *    · 角标本身绝不超出控件（css/runtime.css 里还有一层 max-width + 截断保护）。 */
export function decorate(el, w) {
  if (!el) return;
  const old = el.querySelector(':scope > .rt-perm-lock');
  const need = requiredOf(w);
  // **默认就挂**（等级不够时，一个 🔒 就够让人明白为什么点不动 —— 不用逐个控件去"打开标记"）；
  // 个别不想显示的控件在属性面板把「小锁标记」取消勾选即可（showPermBadge === false）。
  const show = w?.props?.showPermBadge !== false;
  // 没开权限管理 / 没配等级 / 等级已删 / 已经解锁 → 都不画
  const locked = show && !!need && !can(need);
  if (w?.type === 'recipe') {
    old?.remove();
    el.classList.toggle('rc-delete-locked', locked && w.props?.allowDelete === true && w.props?.showList !== false);
    return;
  }
  if (!locked) { old?.remove(); return; }
  const name = project.permLevelName(need);
  const span = old || document.createElement('span');
  const short = Math.min(Math.abs(+w?.w || 0), Math.abs(+w?.h || 0)) || 40;   // 控件短边（设计像素）
  const k = Math.max(0.55, Math.min(1, short / 60));                          // 越小越缩，最多缩到 0.55
  span.className = 'rt-perm-lock locked';
  span.textContent = '🔒';                                                    // 只一个锁（等级名在悬停提示/密码框里）
  span.style.fontSize = `${(11 * k).toFixed(1)}px`;
  span.style.lineHeight = `${(16 * k).toFixed(1)}px`;
  span.style.padding = `0 ${Math.max(3, 5 * k).toFixed(1)}px`;
  span.style.borderRadius = `${(9 * k).toFixed(1)}px`;
  // 悬停说清"要哪一级"和"点下去会怎样"（勾了自动弹密码框 / 没勾就是点不动）
  span.title = autoPromptOf(w)
    ? `要「${name}」权限：点它会弹密码框（解锁后这个标记会消失）`
    : `要「${name}」权限：这个控件现在点不动（属性里没勾「权限不够时自动弹出」）`;
  if (!old) el.appendChild(span);
}

/* ─────────── 顶部「已解锁」小胶囊（退出权限的入口）─────────── */
function ensureChip() {
  if (chipEl) return chipEl;
  chipEl = document.getElementById('rtPermChip');
  if (!chipEl) {
    chipEl = document.createElement('button');
    chipEl.id = 'rtPermChip';
    chipEl.className = 'rt-perm-chip hidden';
    (document.getElementById('runtimeRoot') || document.body).appendChild(chipEl);
  }
  chipEl.addEventListener('click', () => lock('已退出权限'));
  return chipEl;
}
export function refreshChip() {
  const el = ensureChip();
  const name = currentLevelName();
  const show = !!name && isPermEnabled();
  el.classList.toggle('hidden', !show);
  if (!show) return;
  el.innerHTML = `🔓 <b>${esc(name)}</b><span class="rt-perm-chip-x">点这里退出权限</span>`;
  const until = lockAfterMs();
  el.title = until
    ? `当前权限「${name}」；${Math.round(until / 60000)} 分钟没操作会自动退出`
    : `当前权限「${name}」；解锁后一直有效，直到点这里退出`;
}

/* ─────────── 密码框 ─────────── */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function buildDialog() {
  const mask = document.createElement('div');
  mask.id = 'permMask';
  mask.className = 'rt-perm-mask hidden';
  mask.innerHTML = `
    <div class="rt-perm-card" role="dialog" aria-modal="true">
      <div class="rt-perm-head"><span>🔒 需要权限：<b id="permLevelName"></b></span>
        <button type="button" class="rt-perm-x" id="permX" title="取消（Esc）">✕</button></div>
      <label class="rt-perm-pick">
        <span>解锁哪一级</span>
        <select id="permLevelSel"></select>
      </label>
      <input id="permPw" class="rt-perm-input" type="password" inputmode="numeric" autocomplete="off" placeholder="密码">
      <div id="permErr" class="rt-perm-err hidden">密码不对，再试一次</div>
      <div class="rt-perm-pad" id="permPad">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']
    .map(k => `<button type="button" class="rt-perm-key" data-permk="${k}">${k}</button>`).join('')}
      </div>
      <div class="rt-perm-btns">
        <button type="button" class="rt-perm-btn" id="permCancel">取消</button>
        <button type="button" class="rt-perm-btn primary" id="permOk">确定</button>
      </div>
    </div>`;
  (document.getElementById('runtimeRoot') || document.body).appendChild(mask);
  const input = mask.querySelector('#permPw');
  const sel = mask.querySelector('#permLevelSel');
  const errEl = mask.querySelector('#permErr');
  const fail = (text) => {
    errEl.textContent = text;
    errEl.classList.remove('hidden');
  };
  const submit = () => {
    const target = sel.value || mask.dataset.level;
    if (unlock(target, input.value)) {
      errEl.classList.add('hidden');
      closeDialog(true);
      showToast(`已解锁：${project.permLevelName(target)}`);
      // 解开的这一级**还不够**（比如控件要"工程师"、只解了"操作员"）→ 明说一句
      const need = mask.dataset.need || '';
      if (need && !can(need)) {
        showToast(`已解锁「${project.permLevelName(target)}」，但这个控件要「${project.permLevelName(need)}」`);
      }
    } else {
      fail('密码不对，再试一次');
      input.value = '';
      input.focus();
    }
  };
  mask.querySelector('#permOk').addEventListener('click', submit);
  mask.querySelector('#permCancel').addEventListener('click', () => closeDialog(false));
  // 右上角的 ✕：跟「取消」一件事（密码框这种小卡片也统一有这个习惯）
  mask.querySelector('#permX')?.addEventListener('click', () => closeDialog(false));
  // 换一级：标题/说明跟着换，密码框清空重来
  sel.addEventListener('change', () => {
    const lv = levelOf(sel.value);
    mask.querySelector('#permLevelName').textContent = lv?.name || '';
    input.value = '';
    errEl.classList.add('hidden');
    input.focus();
  });
  mask.querySelector('#permPad').addEventListener('click', e => {
    const b = e.target.closest('[data-permk]');
    if (!b) return;
    const k = b.dataset.permk;
    if (k === 'C') input.value = '';
    else if (k === '⌫') input.value = input.value.slice(0, -1);
    else input.value += k;
    errEl.classList.add('hidden');
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(false); }
    errEl.classList.add('hidden');
  });
  return mask;
}
function openDialog(level, host) {
  dialogEl = dialogEl || buildDialog();
  const parent = host || document.getElementById('runtimeRoot') || document.body;
  if (dialogEl.parentElement !== parent) parent.appendChild(dialogEl);
  dialogEl.dataset.level = level.id;
  dialogEl.dataset.need = level.id;          // 触发这个弹窗时"实际需要"的那一级
  dialogEl.querySelector('#permLevelName').textContent = level.name || '';
  // 下拉列出所有等级（跟权限管理里的等级表同序），默认选中**这次需要的那一级** ——
  // 现场也可以改选别的一级（比如手里只有"班组长"的密码），解开它照样按包含关系放行。
  const sel = dialogEl.querySelector('#permLevelSel');
  const list = levels();
  sel.innerHTML = list.map(l =>
    `<option value="${esc(l.id)}"${l.id === level.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
  if (!list.some(l => l.id === level.id)) {   // 需要的等级刚好被删了：兜个底，别让下拉空着
    sel.innerHTML = `<option value="${esc(level.id)}" selected>${esc(level.name || '')}</option>`;
  }
  const input = dialogEl.querySelector('#permPw');
  input.value = '';
  const errEl = dialogEl.querySelector('#permErr');
  errEl.textContent = '密码不对，再试一次';
  errEl.classList.add('hidden');
  dialogEl.classList.remove('hidden');
  // 触摸屏多数只有软键盘：给个数字键盘，插上实体键盘也能直接打
  setTimeout(() => { try { input.focus(); } catch { /* 触摸屏可能不给焦点 */ } }, 30);
  return new Promise(resolve => {
    if (pending) pending(false);       // 上一个还没答就先当他放弃
    pending = resolve;
  });
}
function closeDialog(ok) {
  if (dialogEl) {
    dialogEl.classList.add('hidden');
    // ⚠ 一定要把焦点从密码框上摘掉：焦点留在隐藏的 input 里，运行态的快捷键判定
    //   （tag === 'INPUT' 就当"在打字"）会把 Ctrl+Shift+Q / Esc 全部吞掉，现场表现就是
    //   "解完锁快捷键全不管用了，点一下画面才好"
    try { dialogEl.querySelector('#permPw')?.blur(); } catch { /* 忽略 */ }
    const parent = document.getElementById('runtimeRoot') || document.body;
    if (dialogEl.parentElement !== parent) parent.appendChild(dialogEl);
  }
  const p = pending;
  pending = null;
  if (p) p(!!ok);
}

/* ─────────── 解锁后的一句提示 ─────────── */
function showToast(text) {
  if (!text) return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'rt-perm-toast hidden';
    (document.getElementById('runtimeRoot') || document.body).appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

/** 权限状态变了：刷新胶囊 + 通知各处（runtime 用它重画控件上的小锁）*/

/* 权限配置被改（组态时改的、或换个工程）→ 现在这个解锁等级可能已经不存在了；
   另外"小锁标记 / 启用"这些开关也可能刚被改掉，得让画面上的小锁跟着重画 */
bus.on('project:changed', () => {
  if (curId && project.permRank(curId) < 0) { resetPerm(); return; }
  if (!isPermEnabled() && curId) { resetPerm(); return; }
  refreshChip();
  bus.emit('perm:changed', { level: curId, name: currentLevelName(), reason: 'config' });
});

export const _state = () => ({
  level: curId, name: currentLevelName(), enabled: isPermEnabled(),
  lockAfterMs: lockAfterMs(), idleArmed: !!idleTimer,
});
