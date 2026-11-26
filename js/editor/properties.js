/**
 * properties.js — 右侧属性面板（schema 驱动自动生成）
 *
 *   无选中   → 页面/画布信息（可改尺寸背景）
 *   单选     → 几何 + 类型属性 + 数据绑定 + 动作配置
 *   多选     → 批量几何和共同属性
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { ALARM_LEVELS, alarmLevelMatcher } from '../core/alarmLevels.js';
import { initColorPicker } from './desktopColors.js';
import { backend } from '../api/backend.js';
import { registry, ACTION_DEFS } from '../widgets/registry.js';
import { keyLabel, debounce, dtypeFromFmt, decimalsFromFmt, statusNote,
  dtypeOfVarType, varTypeOfDtype, fmtOfDecimals, isIntDtype, intDecimalsOf,
  parseOptions, setOptionColor, isClickThrough } from '../core/utils.js';
import { attachVarPick } from './varPick.js';
import { PALETTE as TREND_PALETTE } from '../runtime/trend.js';
import { select } from './canvas.js';
import { toolboxGroupOf } from './toolbox.js';
import { getLang, defaultLang, textOf, setTranslationFor, widgetFontPx, setWidgetFontPx } from '../core/i18n.js';

/** 波形通道允许的变量类型（跟 defs.js 里 trend 的 binding.types 对应） */
const CHAN_TYPES = ['int', 'uint', 'dint', 'udint', 'real', 'lreal', 'bool'];

/** 字号类属性（非默认语言下，属性面板显示/编辑的是「这门语言下这个控件」的生效字号） */
const isFontPropKey = (k) => /^(fontSize|textSize|numberSize|valueSize)$/.test(String(k || ''));

/** 输入范围上下限能用的变量类型（只有数值变量能当边界；bool/string 拿来做限制是静默失效） */
const LIMIT_TYPES = ['int', 'uint', 'dint', 'udint', 'real', 'lreal'];

const commitLater = debounce(() => project.commit('修改属性', { merge: true }), 600);

/**
 * 图片导入：把选中的图缩到最长边 ≤1280 再重编码（优先 WebP，能保住透明）。
 *
 * 为什么必须缩：图片是 base64 内嵌进工程 JSON 的（全工程没有"图片文件"，只有 src 这个 dataURL），
 * 一张 1200×1200 的截图就有 6MB+，直接撞两条硬上限：
 *   · 本地缓存 localStorage ≈5MB → 状态栏报「自动保存失败：浏览器存储已满」
 *   · WS 单帧 1MB / 单条消息 4MB（server/wschannel.py）→ 工程根本存不进服务器
 * 实测一张 6.3MB 的 PNG 导进去：缓存写失败、服务器工程里连控件都没有，刷新一下就没了。
 * 画面上放的图 1280 像素 + WebP 已经足够清楚（触摸屏看的是画面，不是原图的像素级细节）。
 */
const IMG_MAX_EDGE = 1280;
const IMG_MAX_BYTES = 900 * 1024;    // 单张 dataURL 的字符数上限（base64 约是原图的 1.33 倍）
const IMG_KEEP_BYTES = 220 * 1024;   // 已经是小图就原样用，不做无谓的重编码

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('这个文件不是能显示的图片'));
    im.src = src;
  });
}

function drawScaled(img, iw, ih, scale) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(iw * scale));
  cv.height = Math.max(1, Math.round(ih * scale));
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv;
}

/** 有没有透明像素：有透明就绝不能用 JPEG（透明会被填黑/填白） */
function canvasHasAlpha(cv) {
  try {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  } catch {
    return true;   // 取不到像素就当有透明，走 PNG 更安全
  }
}

/** 内嵌图片的"体检"文本：属性面板里让用户看得见这张图占了多少工程体积 */
function imgSizeHint(src) {
  if (!src || !src.startsWith('data:')) return '';
  const kb = Math.round(src.length * 0.75 / 1024);   // base64 → 原始字节 ≈ ×0.75
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

async function fitImageDataUrl(dataUrl) {
  if (dataUrl.length <= IMG_KEEP_BYTES) return dataUrl;
  let img;
  try { img = await loadImageEl(dataUrl); } catch { return dataUrl; }
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const base = Math.min(1, IMG_MAX_EDGE / Math.max(iw, ih));
  let last = '';
  // 先按原缩放比压质量，还不够就再降尺寸 —— 最多 4×3 次，正常第一轮就够
  for (const factor of [1, 0.75, 0.55, 0.4]) {
    const cv = drawScaled(img, iw, ih, base * factor);
    const alpha = canvasHasAlpha(cv);
    for (const q of [0.9, 0.75, 0.6]) {
      const webp = cv.toDataURL('image/webp', q);
      last = webp.startsWith('data:image/webp')
        ? webp
        : (alpha ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', q));
      if (last.length <= IMG_MAX_BYTES) return last;
    }
  }
  return last || dataUrl;
}


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
    const setFolded = (folded) => {
      g.classList.toggle('folded', folded);
      title.setAttribute('aria-expanded', String(!folded));
    };
    setFolded(map[key] ?? g.hasAttribute('data-fold-default'));
    title.addEventListener('click', () => {
      const folded = !g.classList.contains('folded');
      setFolded(folded);
      const m = foldMap();
      m[key] = folded;
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(m)); } catch { /* 忽略 */ }
    });
  });
}

export function initProperties() {
  let refreshAfterColor = false;
  const choosingColor = initColorPicker(() => {
    if (!refreshAfterColor) return;
    refreshAfterColor = false;
    render();
  });
  bus.on('selection:changed', render);
  bus.on('page:current', render);
  // 换了协议（Modbus ↔ OPC UA）→「数据类型」那一行的可编辑性跟着变，得重画
  bus.on('plc:protocol', render);
  // 切语言 → 面板里的文本（显示译文）和字号（这门语言的生效值）当场跟着变
  bus.on('i18n:lang', render);
  bus.on('project:changed', () => {
    if (committingBatch) return;
    if (choosingColor()) {
      // 取色框打开时焦点在弹窗里，工程自动提交也要保留原来的颜色输入框。
      refreshAfterColor = true;
      return;
    }
    // 数据结构变化（非本面板引起）时刷新；但**正在打字的输入框**别重建（会丢焦点/丢半截输入）。
    //   ⚠ 只对"真的在打字"的元素让路：按钮 / 下拉（公共底的 ↑ ↓ ✕、「添加一层」这类）点完
    //     必须立刻重建 —— 以前按"焦点在面板里就跳过"一律让路，于是点完按钮面板不更新，
    //     要切页/重新点进来才看见（现场反馈过"加了底要重新进去才知道有几层"）。
    const el = document.activeElement;
    const typing = !!el && !!el.closest?.('#propBody') && (
      // 颜色输入框打开系统取色器后仍是当前编辑控件；颜色变化会发 project:changed，
      // 这里必须让路，否则 render() 会替换 input，系统取色器也会立刻关闭。
      (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'file'].includes(el.type))
      || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
    if (!typing) render();
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
  const layers = project.basesOf(page);                     // 这一页套的各层底（从下到上）
  const rest = bases.filter(b => !layers.some(x => x.id === b.id));
  const using = isBase ? project.pagesUsingBase(page.id) : [];
  body.innerHTML = `
    <div class="prop-group">
      <button type="button" class="prop-group-title">画布 / 页面</button>
      <div class="f-row"><span class="f-label">工程名</span>
        <input class="f-input" id="ppName" value="${esc(project.data.meta.name)}"></div>
      <div class="prop-grid">
        <label class="prop-pair"><span class="f-label">画布宽</span><input class="f-input" id="ppW" type="number" min="200" max="4000" value="${c.w}"></label>
        <label class="prop-pair"><span class="f-label">画布高</span><input class="f-input" id="ppH" type="number" min="200" max="3000" value="${c.h}"></label>
      </div>
      <div class="f-row"><span class="f-label">背景色</span>
        <input class="f-color" id="ppBg" type="color" value="${c.bg || '#f4f5f7'}"></div>
      <div class="f-row"><span class="f-label">当前${isBase ? '底' : '页面'}</span>
        <input class="f-input" disabled value="${esc(page?.name || '')}"></div>
      <div class="f-row"><span class="f-label">控件数</span>
        <input class="f-input" disabled value="${page?.widgets.length || 0}"></div>
    </div>
    ${page?.type === 'page' ? `
    <div class="prop-group">
      <button type="button" class="prop-group-title">公共底</button>
      <div class="f-row"><span class="f-label">已套用</span>
        <span style="color:var(--text-2);font-size:12px">${layers.length} 层</span></div>
      ${layers.length ? layers.map((b, i) => `
        <div class="f-row" style="gap:4px">
          <span class="f-label" style="width:auto;min-width:20px">${i + 1}.</span>
          <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${esc(b.name)}（${b.widgets.length} 控件）">${esc(b.name)}（${b.widgets.length} 控件）</span>
          <button type="button" class="tb-btn sm" data-basemove="up" data-baseid="${esc(b.id)}"
            ${i === 0 ? 'disabled' : ''} title="往下换一层（更靠底层）">↑</button>
          <button type="button" class="tb-btn sm" data-basemove="down" data-baseid="${esc(b.id)}"
            ${i === layers.length - 1 ? 'disabled' : ''} title="往上换一层（更靠上层）">↓</button>
          <button type="button" class="tb-btn sm danger" data-baseremove="${esc(b.id)}"
            title="只去掉这一页的这一层（底本身还在，别的页不受影响）">✕</button>
        </div>`).join('') : ''}
      <div class="f-row"><span class="f-label">添加一层</span>
        <select class="f-select" id="ppBaseAdd" ${rest.length ? '' : 'disabled'}>
          <option value="">${rest.length ? '选一个公共底叠上去…' : (bases.length ? '（都套上了）' : '还没有公共底')}</option>
          ${rest.map(b => `<option value="${esc(b.id)}">${esc(b.name)}（${b.widgets.length} 控件）</option>`).join('')}
        </select></div>
    </div>` : ''}
    ${isBase ? `
    <div class="prop-group">
      <button type="button" class="prop-group-title">这个公共底</button>
      <div style="color:var(--text-2);font-size:11.5px;line-height:1.7">
        ${using.length
          ? `被 <b>${using.length}</b> 个页面套用：${using.slice(0, 12).map(x => esc(x.name)).join('、')}${using.length > 12 ? ' …' : ''}`
          : '还没有页面套用它'}
      </div>
    </div>` : ''}
    ${page?.type === 'popup' ? `
    <div class="prop-group">
      <button type="button" class="prop-group-title">弹窗设置</button>
      <div class="prop-grid">
        <label class="prop-pair"><span class="f-label">弹窗宽</span><input class="f-input" id="ppPW" type="number" min="120" max="2000" value="${page.popupW || 420}"></label>
        <label class="prop-pair"><span class="f-label">弹窗高</span><input class="f-input" id="ppPH" type="number" min="80" max="1500" value="${page.popupH || 240}"></label>
      </div>
      <div class="f-row"><span class="f-label">弹窗标题</span>
        <input class="f-input" id="ppTitle" value="${esc(page.title || '')}" placeholder="留空则不显示标题文字"></div>
      <label class="f-row prop-check" title="在弹窗标题栏右上角显示关闭按钮">
        <span class="f-label">关闭按钮</span>
        <input class="f-check" id="ppClose" type="checkbox" ${page.showClose !== false ? 'checked' : ''}>
      </label>
    </div>` : ''}`;
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
  // 公共底（可多层）：上移/下移换层序、✕ 去掉一层、下拉叠一层 —— 都走 project 的整套设定
  body.querySelectorAll('[data-basemove]').forEach(btn => btn.addEventListener('click', () => {
    const ids = project.basesOf(page).map(b => b.id);
    const i = ids.indexOf(btn.dataset.baseid);
    const j = btn.dataset.basemove === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = ids.slice();
    [next[i], next[j]] = [next[j], next[i]];
    project.setPageBases(page.id, next);
  }));
  body.querySelectorAll('[data-baseremove]').forEach(btn => btn.addEventListener('click', () => {
    project.removePageBase(page.id, btn.dataset.baseremove);
  }));
  const ppBaseAdd = document.getElementById('ppBaseAdd');
  if (ppBaseAdd) ppBaseAdd.addEventListener('change', () => {
    if (ppBaseAdd.value) project.addPageBase(page.id, ppBaseAdd.value);
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

/* ═══════════ 多选 ═══════════ */
let committingBatch = false;
const BATCH_TYPES = new Set(['number', 'color', 'select', 'check', 'text', 'textarea']);
const batchColorClear = (w, key) => w.type === 'button' && key === 'borderColor' ? 'transparent' : '';
const isTransparentColor = color => !color || color === 'transparent';
const colorInputValue = color => /^#[a-f\d]{6}$/i.test(color || '') ? color : '#ffffff';

function widgetPropVisible(p, w, boundType) {
  return (!p.showIf || w.props[p.showIf])
    && (p.showVarType !== 'notBool' || (!!boundType && boundType !== 'bool'));
}

function widgetPropOptions(p, boundType) {
  return p.key === 'op' && boundType === 'string'
    ? p.options?.filter(o => o.v === '==' || o.v === '!=')
    : p.options;
}

function widgetPropValue(p, w, def) {
  return w.props[p.key] ?? (p.defFrom ? w.props[p.defFrom] : undefined)
    ?? p.defVal ?? def?.defaults?.[p.key];
}

function widgetDecimals(w, type) {
  return isIntDtype(type) ? (isIntDtype(w.props.dispType) ? intDecimalsOf(w.props) : 0)
    : (w.props.decimals ?? decimalsFromFmt(w.props.fmt));
}

function setWidgetDecimals(w, type, value) {
  project.updateWidgetProp(w.id, 'decimals', value, { notify: false });
  project.updateWidgetProp(w.id, 'fmt', fmtOfDecimals(type, value), { notify: false });
  if (type && w.props.dispType !== type) {
    project.updateWidgetProp(w.id, 'dispType', type, { notify: false });
  }
}

function commonProperties(widgets) {
  const definitions = widgets.map(w => registry.get(w.type));
  const variables = new Map(project.variables().map(v => [v.name, v.type]));
  const activeProps = definitions.map((def, i) => {
    const w = widgets[i];
    const boundType = variables.get(w.bindings?.variable);
    const fields = (def?.props || []).filter(p => widgetPropVisible(p, w, boundType)).flatMap(p => {
      if (BATCH_TYPES.has(p.type)) return [{ ...p, options: widgetPropOptions(p, boundType) }];
      if (p.type === 'varOrValue' && w.props[p.modeKey] !== 'var') {
        return [{ ...p, type: 'text', placeholder: '不限' }];
      }
      if (p.type === 'dtype') {
        const type = boundType ? dtypeOfVarType(boundType) : w.props.dispType || dtypeFromFmt(w.props.fmt);
        if (type && type !== 'string') {
          return [{ key: 'decimals', label: '小数位', type: 'number', min: 0, max: 6,
            numberType: type, value: widgetDecimals(w, type) }];
        }
      }
      return [];
    });
    return new Map(fields.map(p => [p.key, p]));
  });
  const langDiff = getLang() !== defaultLang();
  const common = [...(activeProps[0]?.values() || [])].flatMap(p => {
    const peers = activeProps.map(fields => fields.get(p.key));
    if (!peers.every(peer => peer?.type === p.type && peer.label === p.label && peer.i18n === p.i18n
      && !!peer.numberType === !!p.numberType && isIntDtype(peer.numberType) === isIntDtype(p.numberType))) return [];
    const min = Math.max(...peers.map(peer => peer.min ?? -Infinity));
    const max = Math.min(...peers.map(peer => peer.max ?? Infinity));
    const options = p.options?.filter(o => peers.every(peer => peer.options?.some(other => other.v === o.v)));
    if (min > max || (p.type === 'select' && !options?.length)) return [];
    const font = isFontPropKey(p.key);
    const translatedFont = font && langDiff;
    const translatedText = (p.type === 'text' || p.type === 'textarea') && !!p.i18n && langDiff;
    const originals = widgets.map((w, i) => widgetPropValue(peers[i], w, definitions[i]));
    const values = widgets.map((w, i) => {
      if (p.numberType) return peers[i].value;
      if (translatedFont) return widgetFontPx(w, p.key);
      return translatedText ? textOf(originals[i]) : originals[i];
    });
    const mixed = values.some(v => v !== values[0]);
    return [{ ...p, min, max, options, font, translatedFont, translatedText, mixed,
      numberTypes: p.numberType ? peers.map(peer => peer.numberType) : null,
      value: mixed ? undefined : values[0],
      disabled: translatedText && originals.some(v => v == null || v === '') }];
  });
  return common.sort((a, b) => Number(b.font) - Number(a.font));
}

function batchPropertyHtml(p) {
  const label = esc(p.label || keyLabel(p.key));
  const field = `data-prop="${esc(p.key)}" aria-label="${label}"`;
  const placeholder = p.mixed ? '不同值' : (p.placeholder || '');
  const disabled = p.disabled ? ' disabled title="请先在默认语言填写原文"' : '';
  const canClearText = (p.type === 'text' || p.type === 'textarea') && p.mixed && !p.disabled;
  let control;
  if (p.type === 'color') {
    control = `<input class="f-color" type="color" ${field} data-color-commit-only value="${colorInputValue(p.value)}">
      <button type="button" class="tb-btn sm clear-color${!p.mixed && isTransparentColor(p.value) ? ' active' : ''}" data-batch-clear="${esc(p.key)}">透明</button>`;
  } else if (p.type === 'number') {
    control = `<input class="f-input" type="number" ${field} value="${esc(p.value)}" placeholder="${p.mixed ? '不同值' : '批量设置'}"
      ${Number.isFinite(p.min) ? `min="${p.min}"` : ''} ${Number.isFinite(p.max) ? `max="${p.max}"` : ''}>`;
  } else if (p.type === 'check') {
    control = `<input class="f-check" type="checkbox" ${field}${p.value ? ' checked' : ''}>`;
  } else if (p.type === 'text') {
    control = `<input class="f-input" ${field} value="${esc(p.value)}" placeholder="${esc(placeholder)}"${disabled}>`;
  } else if (p.type === 'textarea') {
    const rows = p.rows || 5;
    control = `<textarea class="f-input f-area${rows <= 3 ? ' f-area-compact' : ''}" ${field}
      rows="${rows}" placeholder="${esc(placeholder)}"${disabled}>
${esc(p.value)}</textarea>`;
  } else {
    control = `<select class="f-select" ${field}>
      ${p.mixed || p.value == null ? '<option value="" disabled selected>不同值</option>' : ''}
      ${p.options.map(o => `<option value="${esc(o.v)}"${String(p.value) === String(o.v) ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}
    </select>`;
  }
  const mixedHint = p.mixed && (p.type === 'color' || p.type === 'check') ? '<small>不同值</small>' : '';
  const clearText = canClearText
    ? `<button type="button" class="tb-btn sm" data-batch-empty="${esc(p.key)}" aria-label="清空${label}">清空</button>` : '';
  return `<div class="f-row"><span class="f-label">${label}</span>${control}${mixedHint}${clearText}</div>`;
}
function renderMultiProps(body, ids) {
  /* 整组选中时：先给一份「组内控件」清单 —— 点一个就只选中它，
     属性面板立刻切成它自己的属性（想改组合里某一个控件时不用去猜 Alt+点击）。 */
  const wholeGroup = project.isWholeGroup(ids);
  const members = ids.map(id => project.getWidget(id)).filter(Boolean);
  const propertyMembers = members.filter(w => toolboxGroupOf(registry.get(w.type)) !== 'deco');
  const common = propertyMembers.length > 1 ? commonProperties(propertyMembers) : [];
  const memberHtml = wholeGroup ? `
    <div class="prop-group">
      <button type="button" class="prop-group-title">组内控件（${members.length} 个）</button>
      <div class="group-members">
        ${members.map(m => `<button type="button" class="gm-item" data-pick="${esc(m.id)}" title="只选中「${esc(m.name)}」，然后就能单独改它的属性">
          <span class="gm-badge">${esc(registry.get(m.type)?.title || m.type)}</span>
          <span class="gm-name">${esc(m.name)}</span></button>`).join('')}
      </div>
    </div>` : '';

  body.innerHTML = `${memberHtml}
    <div class="prop-group">
      <button type="button" class="prop-group-title">批量几何（${ids.length} 个控件）</button>
      <div class="prop-grid">
        <label class="prop-pair"><span class="f-label">X</span><input class="f-input" id="mX" type="number" placeholder="批量设置"></label>
        <label class="prop-pair"><span class="f-label">Y</span><input class="f-input" id="mY" type="number" placeholder="批量设置"></label>
        <label class="prop-pair"><span class="f-label">宽</span><input class="f-input" id="mW" type="number" placeholder="批量设置"></label>
        <label class="prop-pair"><span class="f-label">高</span><input class="f-input" id="mH" type="number" placeholder="批量设置"></label>
      </div>
    </div>
    ${common.length ? `<div class="prop-group"><button type="button" class="prop-group-title">共同属性</button>
      <div class="prop-fields">${common.map(batchPropertyHtml).join('')}</div></div>` : ''}`;
  body.querySelectorAll('[data-pick]').forEach(btn => {
    btn.addEventListener('click', () => select([btn.dataset.pick], { raw: true }));   // 只选这一个
  });
  [['mX', 'x'], ['mY', 'y'], ['mW', 'w'], ['mH', 'h']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', e => {
      if (e.target.value === '') return;
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      if (key === 'w' || key === 'h') { if (v < 8) return; }
      project.updateWidgets(ids, { [key]: v });
      project.commit('批量几何');
    });
  });
  const apply = (p, valueFor) => {
    let changed = false;
    propertyMembers.forEach((w, i) => {
      const value = valueFor(w);
      if (p.translatedFont) {
        if (widgetFontPx(w, p.key) === value) return;
        setWidgetFontPx(w, p.key, value);
        project.markDirty(w.id);
      } else if (p.translatedText) {
        const raw = widgetPropValue(p, w, registry.get(w.type));
        if (textOf(raw) === value || !setTranslationFor(raw, value)) return;
      } else if (p.numberTypes) {
        const type = p.numberTypes[i];
        if (w.props.decimals === value && w.props.dispType === type && w.props.fmt === fmtOfDecimals(type, value)) return;
        setWidgetDecimals(w, type, value);
      } else {
        if (w.props[p.key] === value) return;
        project.updateWidgetProp(w.id, p.key, value, { notify: false });
      }
      changed = true;
    });
    if (changed) {
      // 画布照常更新，属性面板保留焦点，避免失焦提交时重建下一个要点的输入框。
      committingBatch = true;
      try {
        project.commit(p.font ? '批量修改字号' : '批量修改属性', { merge: p.font });
      } finally {
        committingBatch = false;
      }
    }
    return changed;
  };
  common.forEach(p => {
    const key = CSS.escape(p.key);
    const input = body.querySelector(`[data-prop="${key}"]`);
    if (p.type === 'check') input.indeterminate = p.mixed;
    const clearText = body.querySelector(`[data-batch-empty="${key}"]`);
    const applyInput = (normalize) => {
      if (p.type === 'number' && input.value === '') return;
      let value = p.type === 'check' ? input.checked : input.value;
      if (p.type === 'number') {
        value = Math.min(p.max, Math.max(p.min, Number(value)));
        if (p.font || p.numberTypes) value = Math.round(value);
        if (normalize) input.value = value;
      }
      if (apply(p, () => value)) {
        clearText?.remove();
        input.placeholder = p.placeholder || '';
      }
    };
    if (p.font) input.addEventListener('input', () => applySoon(input, () => {
      if (input.isConnected) applyInput(false);
    }));
    input.addEventListener('change', () => {
      cancelSoon(input);
      applyInput(true);
      if (input.isConnected && (p.type === 'color' || p.type === 'check')) render();
    });
    body.querySelector(`[data-batch-clear="${key}"]`)?.addEventListener('click', () => {
      if (apply(p, w => batchColorClear(w, p.key))) render();
    });
    clearText?.addEventListener('click', () => {
      if (apply(p, () => '')) render();
    });
  });
  wireFold(body);
}

/* ═══════════ 单个控件 ═══════════ */
function renderWidgetProps(body, w) {
  if (!w) return renderPageProps(body);
  const previousLevels = body.querySelector('.alarm-level-picker');
  const sameLevels = previousLevels?.dataset.widget === w.id;
  const levelsOpen = sameLevels && previousLevels.open;
  const levelScroll = levelsOpen ? previousLevels.querySelector('.alarm-level-choices').scrollTop : 0;
  const levelFocus = sameLevels && previousLevels.contains(document.activeElement)
    ? document.activeElement.dataset.levelFocus : '';
  const def = registry.get(w.type) || {};      // || {}：类型没定义时也不能把面板渲染搞崩（见下面的提示条）
  // 当前语言 ≠ 默认语言时：i18n 文本属性显示译文、字号属性显示这门语言下的生效 px；
  // 编辑时分别写 dict / wsize（不改原文、不改基础字号）；默认语言下行为与以前完全一致。
  const langNow = getLang();
  const langDiff = langNow !== defaultLang();
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
      <button type="button" class="tb-btn sm" id="pickWholeGroup">选中整组</button>
    </div>`;
  }

  // 几何
  html += `
    <div class="prop-group">
      <button type="button" class="prop-group-title">几何 / 名称</button>
      <div class="prop-grid">
        <label class="prop-pair"><span class="f-label">X</span><input class="f-input" data-fld="x" type="number" value="${w.x}"></label>
        <label class="prop-pair"><span class="f-label">Y</span><input class="f-input" data-fld="y" type="number" value="${w.y}"></label>
        <label class="prop-pair"><span class="f-label">宽</span><input class="f-input" data-fld="w" type="number" min="1" value="${w.w}"></label>
        <label class="prop-pair"><span class="f-label">高</span><input class="f-input" data-fld="h" type="number" min="1" value="${w.h}"></label>
      </div>
      <div class="f-row prop-identity">
        <label class="f-label" for="propWidgetName">名称</label>
        <input class="f-input" id="propWidgetName" data-fld="name" value="${esc(w.name)}">
        <label class="prop-check" title="锁定后仍可选中控件，但在画布上无法拖动或缩放">
          <input class="f-check" data-lock="1" type="checkbox" ${w.locked ? 'checked' : ''}>
          <span>锁定</span>
        </label>
      </div>
    </div>`;

  // 已配置的权限、条件和穿透默认展开。手动折叠状态优先，见 wireFold。
  const levels = project.permLevels();
  const curLv = String(w.props?.permLevel || '');
  const recipeDeleteOnly = w.type === 'recipe';
  html += `
    <div class="prop-group"${curLv ? '' : ' data-fold-default'}>
      <button type="button" class="prop-group-title">操作权限</button>
      <div class="f-row"><label class="f-label" for="propPermLevel">${recipeDeleteOnly ? '删除权限等级' : '权限等级'}</label>
        <select class="f-select" id="propPermLevel" data-prop="permLevel" ${levels.length ? '' : 'disabled'}>
          <option value="">${recipeDeleteOnly ? '不限（无额外操作等级）' : '不限（谁都能操作）'}</option>
          ${levels.map(l => `<option value="${esc(l.id)}" ${curLv === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="prop-options">
        <label class="f-row prop-check" title="${recipeDeleteOnly ? '删除配方时，权限不足则弹出密码框' : '操作控件时，权限不足则弹出密码框'}">
          <input class="f-check" data-prop="permPrompt" type="checkbox" ${w.props?.permPrompt !== false ? 'checked' : ''}>
          <span class="f-label">密码框</span>
        </label>
        <label class="f-row prop-check" title="${recipeDeleteOnly ? '权限不足时在删除按钮旁显示小锁' : '权限不足时在控件角上显示小锁'}">
          <input class="f-check" data-prop="showPermBadge" type="checkbox" ${w.props?.showPermBadge !== false ? 'checked' : ''}>
          <span class="f-label">小锁标记</span>
        </label>
        <button type="button" class="tb-btn sm" id="permCfgBtn">权限管理…</button>
      </div>
    </div>`;

  html += gateGroupHtml(w);
  const ct = isClickThrough(w.props);
  html += `
    <div class="prop-group"${ct ? '' : ' data-fold-default'}>
      <button type="button" class="prop-group-title">点击穿透</button>
      <label class="f-row prop-check" title="勾选后，运行时点击此控件也会触发叠在下面的控件">
        <span class="f-label">穿透</span>
        <input class="f-check" data-prop="clickThrough" type="checkbox" ${ct ? 'checked' : ''}>
      </label>
    </div>`;

  // 类型属性（schema 驱动）
  if (def.props?.length) {
    // OPC UA：变量是从服务器**导入**的，类型以 PLC 为准 ——「数据类型」那一行只看不改。
    // 改了会把导入来的类型覆盖掉（声明类型和节点实际类型对不上，读回来/写下去都按错类型解），
    // 现场表现就是「值不对、写不进」，而且看不出是谁改的。要换类型就去 PLC 改完重新导入。
    const bindForType = w.bindings?.variable
      ? project.variables().find(x => x.name === w.bindings.variable) : null;
    const dtypeLocked = !!bindForType && backend.isOpcua();
    // 逐条属性的 HTML（下面按 group 分栏时会反复调用它）。
    // ⚠ 里面照旧写 `html += …`：靠外面那层临时清空/还原来"接住"这一条的 HTML，
    //   这样这段又长又密的渲染逻辑一行都不用改（改一处漏一处最容易出 bug）。
    const renderProp = (p) => {
      const v = w.props[p.key];
      // 非默认语言：i18n 文本属性显示译文；字号属性显示这门语言下的生效 px
      const i18nText = langDiff && !!(p.i18n);
      const i18nFont = langDiff && isFontPropKey(p.key);
      if (!widgetPropVisible(p, w, bindForType?.type)) return;
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
            <img src="${esc(src)}" alt="" title="${esc(imgSizeHint(src))}" style="max-width:150px;max-height:70px;border:1px solid var(--border);border-radius:4px">
            <button class="tb-btn sm" data-clear="${p.key}">清除</button></div>` : ''}`;
        return;
      }
      html += `<div class="f-row"${p.hint ? ` title="${esc(p.hint)}"` : ''}><span class="f-label">${p.label || keyLabel(p.key)}</span>`;
      if (p.type === 'number') {
        // defVal：控件 props 里没有该键（老工程）时按运行时真实默认值显示，别把 undefined 写进输入框
        // 字号类属性在非默认语言下显示「这门语言下这个控件的生效 px」（有 per-widget 覆盖优先）
        const shownNum = i18nFont ? widgetFontPx(w, p.key) : (v ?? p.defVal ?? '');
        html += `<input class="f-input" data-prop="${p.key}"${i18nFont ? ` data-i18nfont="${p.key}"` : ''} type="number"
          ${p.min !== undefined ? `min="${p.min}"` : ''} ${p.max !== undefined ? `max="${p.max}"` : ''} value="${shownNum}">`;
      } else if (p.type === 'color') {
        // 「透明」= 把颜色清空（全工程一个约定：空 = 透明）。已经是透明时把按钮点亮，
        // 否则色块显示 #ffffff，看着像"白色"，用户会以为透明没生效。
        const empty = isTransparentColor(v);
        html += `<input class="f-color" data-prop="${p.key}" type="color" value="${colorInputValue(v)}">
          <button class="tb-btn sm clear-color${empty ? ' active' : ''}" data-clear="${p.key}"
            title="${empty ? '当前是透明（点色块可以再选个颜色）' : '设为透明（不填底色）'}">透明</button>`;
      } else if (p.type === 'alarmLevels') {
        const levels = [...ALARM_LEVELS, ...project.customAlarmLevels()];
        const matches = alarmLevelMatcher(v);
        const selected = levels.filter(matches);
        const summary = selected.length === levels.length ? '全部级别'
          : selected.length === 0 ? '未选择' : selected.length === 1 ? selected[0].t : `已选 ${selected.length} 个级别`;
        html += `<details class="alarm-level-picker" data-widget="${esc(w.id)}" data-key="${esc(p.key)}"${levelsOpen ? ' open' : ''}>
          <summary class="f-select" data-level-focus="summary">${esc(summary)}</summary>
          <div class="alarm-level-choices" role="group" aria-label="显示级别">
            <div class="alarm-level-bulk">
              <button type="button" class="tb-btn sm" data-level-bulk="all" data-level-focus="all">全选</button>
              <button type="button" class="tb-btn sm" data-level-bulk="none" data-level-focus="none">清空</button>
            </div>
            ${levels.map(l => `<label class="alarm-level-choice">
              <input class="f-check" type="checkbox" value="${esc(l.v)}" data-level-choice data-level-focus="level:${esc(l.v)}"${matches(l) ? ' checked' : ''}>
              <span class="al-level-swatch" aria-hidden="true" style="--level-color:${l.color}"></span>
              <span title="${esc(l.t)}">${esc(l.t)}</span>
            </label>`).join('')}
          </div></details>`;
      } else if (p.type === 'select') {
        // 字符串变量的比较符只保留等值判断（> < 等对字符串无意义，compareVal 亦不响应）
        const opts = widgetPropOptions(p, bindForType?.type);
        // title：悬停说明（与 check 一致，写进属性定义里，不占面板地方）
        html += `<select class="f-select" data-prop="${p.key}"${p.title ? ` title="${esc(p.title)}"` : ''}>${
          opts.map(o => `<option value="${o.v}" ${String(v ?? p.defVal) === String(o.v) ? 'selected' : ''}>${o.t}</option>`).join('')
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
        // 整数的小数位 = 定点缩放位数（PLC 里 123、屏上 1.23），和浮点共用这一格输入框；
        // 整数读的是「fmt 里写了几位」（老工程 %d → 0，不会被残留的 decimals 带跑）。
        // ⚠ 控件自己还没切到整数（dispType 还是 float，比如老工程先绑了 int 变量、没动过属性）
        //   时按 0 显示 —— 否则会把浮点默认的 decimals=1 / fmt=%.1f 当成"1 位缩放"，
        //   现场一打开面板就看到默认 1，还以为是整数默认带小数位。
        const isIntType = isIntDtype(t);
        const dec = widgetDecimals(w, t);
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
        ${(isFloat || isIntType) && !noDtype ? `<input class="f-input" data-dtype-dec="${p.key}" type="number" min="0" max="6" step="1"
          value="${dec}" placeholder="小数位" title="${isIntType
            ? '小数位：0=无小数点（按整数显示）；1~6=定点缩放，PLC 里 123 + 小数位 2 → 屏上 1.23（读、写都按这个倍率换算）'
            : '小数位：0=无小数点，1~6=保留几位小数'}" style="width:76px;flex:none">` : ''}`;
        if (typeLocked) html += `<span class="f-lock" title="${esc(lockTip)}">已锁定</span>`;
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
          : '<span style="color:var(--text-2);font-size:11px">—</span>';
      } else if (p.type === 'textarea') {
        // 多行文本（表格的「内容」：一行一行写，逗号分列）
        // 非默认语言下显示当前语言译文（编辑时写 dict，不改编原文）
        const shownRaw = v ?? (p.defFrom ? w.props[p.defFrom] : undefined) ?? '';
        const shown = i18nText ? textOf(shownRaw) : shownRaw;
        const rows = p.rows || 5;
        html += `<textarea class="f-input f-area${rows <= 3 ? ' f-area-compact' : ''}"${i18nText ? ` data-i18ntext="${p.key}"` : ''} data-prop="${p.key}" rows="${rows}"
          placeholder="${esc(p.placeholder || '')}">
${esc(shown)}</textarea>`;
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
        // 非默认语言下 i18n 文本属性显示当前语言译文（编辑时写 dict，不改编原文）
        const shownRaw = v ?? (p.defFrom ? w.props[p.defFrom] : undefined) ?? '';
        const shown = i18nText ? textOf(shownRaw) : shownRaw;
        html += `<input class="f-input"${i18nText ? ` data-i18ntext="${p.key}"` : ''} data-prop="${p.key}" value="${esc(shown)}">`;
      }
      html += `</div>`;

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
      html += `<div class="prop-group"><button type="button" class="prop-group-title">${def.title} 属性</button>`
        + mainProps.map(propRow).join('') + '</div>';
    }
    groups.forEach(g => {
      html += `<div class="prop-group"><button type="button" class="prop-group-title">${g.name}</button>`
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
      <button type="button" class="prop-group-title">数据绑定</button>
      <div class="f-row"><span class="f-label">${b.label || '绑定变量'}</span>
        ${varInputHtml({ value: cur, kind: 'bind', bind: 'variable', issue,
          placeholder: '输入变量名（可搜，或点开下拉选）', clearTitle: '清空（不绑定变量）' })}</div>
    </div>`;
  }

  // 数据绑定（多变量）：两种面板形态 ——
  //   · simple（参数表这类"一行一个变量"的）：只给一排变量格，没有通道色/量程那套（那是波形的概念）
  //   · 默认（波形）：固定 max 个通道槽位，每路一个输入框 + 颜色；留空 = 该路停用
  if (def.binding?.variables) {
    const b = def.binding.variables;
    const max = b.max || 8;
    const raw = Array.isArray(w.bindings?.variables) ? w.bindings.variables : [];
    const used = raw.filter(Boolean);
    if (b.simple || def.bindPanel === 'simple') {
      html += `
    <div class="prop-group">
      <button type="button" class="prop-group-title">${b.label || '变量'}（${used.length}/${max}）</button>
      <div class="chan-list">
        ${Array.from({ length: max }, (_, slot) => {
          const name = raw[slot] || '';
          const issue = varIssueOf({ value: name, dataset: { chanslot: String(slot) } }, w);
          return `<div class="chan-row${name ? ' on' : ''}">
            <span class="chan-no">${slot + 1}</span>
            ${varInputHtml({ value: name, kind: 'chan', chanslot: String(slot), issue, cls: 'chan-sel',
              placeholder: '（未使用）输入变量名',
              title: '输入变量名（可搜，或点开下拉选）',
              clearTitle: '清空 = 不使用这一行' })}
          </div>`;
        }).join('')}
      </div>
    </div>`;
    } else {
      html += `
    <div class="prop-group">
      <button type="button" class="prop-group-title">${b.label || '数据通道'}（${used.length}/${max}）</button>
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
      ${used.length ? `<div class="scale-list">
        <div class="scale-head" title="显示值 = 原值 × 倍率 + 偏置">通道量程</div>
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
  }

  // 额外的**控制变量**（按 def.binding 里除 variable / variables 之外的键声明）：
  // 目前只有波形用（「启动抓取」/「清除数据」两个可选 bool）——留空就还是老行为。
  // 声明式写法：控件定义里加一个键就够了，这里不用改。
  const extras = Object.entries(def.binding || {})
    .filter(([k, v]) => k !== 'variable' && k !== 'variables' && v && typeof v === 'object');
  if (extras.length) {
    const title = extras[0][1].group || '控制变量';
    html += `
    <div class="prop-group">
      <button type="button" class="prop-group-title">${esc(title)}</button>
      ${extras.map(([k, b]) => {
        const cur = w.bindings?.[k] || '';
        const issue = varIssueOf({ value: cur, dataset: { bind: k } }, w);
        return `<div class="f-row"><span class="f-label">${esc(b.label || k)}</span>
          ${varInputHtml({ value: cur, kind: 'bind', bind: k, issue,
            placeholder: b.placeholder || '输入变量名（可搜，或点开下拉选）',
            title: b.hint || '输入变量名（可搜，或点开下拉选）',
            clearTitle: b.placeholder || '清空' })}</div>`;
      }).join('')}
    </div>`;
  }

  // 动作
  if (def.actions?.length) {
    // 有「状态显示变量」的控件（按钮/数值/输入…）才能谈「动作变量跟显示变量一致」
    const canFollow = !!def.binding?.variable;
    html += `
    <div class="prop-group">
      <button type="button" class="prop-group-title">动作（点击触发）</button>
      ${canFollow ? `<label class="act-follow" title="勾上后动作里的变量跟「状态显示」的变量一致：改显示变量，动作变量跟着改，不用改两处">
        <input type="checkbox" class="f-check" id="actFollow" ${w.followBind ? 'checked' : ''}>
        <span>变量与「状态显示」的变量一致</span></label>` : ''}
      <div id="actList"></div>
      ${(w.followBind && !w.bindings?.variable) ? `<div class="act-follow-tip">还没选显示变量，请先绑定。</div>` : ''}
      <button class="act-add" id="actAdd">＋ 添加动作</button>
    </div>`;
  }

  body.innerHTML = html;

  const levelPicker = body.querySelector('.alarm-level-picker');
  if (levelPicker) {
    levelPicker.querySelector('.alarm-level-choices').scrollTop = levelScroll;
    const saveLevels = levels => {
      project.updateWidgetProp(w.id, levelPicker.dataset.key, levels);
      commitLater();
    };
    levelPicker.addEventListener('change', () => {
      saveLevels(Array.from(levelPicker.querySelectorAll('[data-level-choice]:checked'), input => input.value));
    });
    levelPicker.addEventListener('click', e => {
      const bulk = e.target.closest('[data-level-bulk]')?.dataset.levelBulk;
      if (bulk) saveLevels(bulk === 'all' ? 'all' : []);
    });
    if (levelFocus) {
      const target = Array.from(levelPicker.querySelectorAll('[data-level-focus]'))
        .find(el => el.dataset.levelFocus === levelFocus);
      target?.focus({ preventScroll: true });
    }
  }

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
        // 宽/高下限 = 1（现场要求：画细线/窄条用得上；以前卡在 8，填 1 会被顶回 8）。
        // 注意：**画布上拖拽缩放**仍有自己的下限（canvas.js 的 MIN_SIZE），那是手感问题，不影响这里填数
        if ((k === 'w' || k === 'h') && v < 1) v = 1;
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
    const i18nTextKey = inp.dataset.i18ntext || '';   // 非默认语言下的 i18n 文本属性：写译文，不改原文
    const i18nFontKey = inp.dataset.i18nfont || '';   // 非默认语言下的字号属性：只改这个控件这门语言的 px
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
      // 非默认语言：文本属性改的是**译文**（dict），字号属性改的是**这个控件这门语言**的覆盖 px
      if (i18nTextKey) {
        const raw = w.props ? w.props[i18nTextKey] : '';
        setTranslationFor(raw, v);
        project.commit('修改译文');
        return;
      }
      if (i18nFontKey) {
        const px = Math.round(Number(v) || 0);
        setWidgetFontPx(w, i18nFontKey, px);
        if (normalize) inp.value = widgetFontPx(w, i18nFontKey);
        project.commit('修改字号');
        return;
      }
      project.updateWidgetProp(w.id, inp.dataset.prop, v);
      commitLater();
      // 状态显示勾选切换 → 满足文字/比较行需联动显隐
      // showIf 指向的那些开关（如「范围限制」）→ 它管着的行要跟着出现/收起
      if (inp.dataset.prop === 'showState'
        || (def.props || []).some(pp => pp.showIf === inp.dataset.prop)) render();
    };
    if (inp.type === 'color') {
      let original;
      inp.addEventListener('hmi:color-open', () => { original = w.props[inp.dataset.prop]; });
      inp.addEventListener('hmi:color-cancel', e => {
        e.preventDefault();
        cancelSoon(inp);
        project.updateWidgetProp(w.id, inp.dataset.prop, original);
        commitLater();
      });
    }
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
        // 未绑变量：dispType/fmt 一起写（decimals 只在浮点有意义，整数认 fmt，见 intDecimalsOf）。
        // 切进整数 = 小数位默认 0（%d，不缩放）；原本就是整数互切（int↔dint…）保留原缩放位数；
        // 从浮点/字符串切进整数也归 0 —— 浮点的小数位不是定点倍率，直接搬过来会让现场数值小 10 倍。
        const wasInt = isIntDtype(w.props.dispType);
        const nowInt = isIntDtype(t);
        const dec = nowInt ? (wasInt ? intDecimalsOf(w.props) : 0) : (w.props.decimals ?? 1);
        project.updateWidgetProp(w.id, 'dispType', t);
        project.updateWidgetProp(w.id, 'fmt', fmtOfDecimals(t, dec));
      }
      commitLater();
      render();
    });
  });
  // 小数位：浮点 = 保留几位小数；整数 = 定点缩放位数（PLC 里 123 + 2 → 屏上 1.23）。
  // 写 decimals 并同步 fmt（整数 0 位 → %d，1~6 位 → %.Nf；浮点 0 → %.0f 无小数点）
  body.querySelectorAll('[data-dtype-dec]').forEach(inp => {
    inp.addEventListener('change', () => {
      if (inp.value === '') return;
      const n = Math.max(0, Math.min(6, Math.round(+inp.value || 0)));
      inp.value = n;   // 回写规范化后的值
      const cur = project.getWidget(w.id);
      const bind = cur?.bindings?.variable || '';
      const bv = bind ? project.variables().find(v => v.name === bind) : null;
      if (bv && !dtypeOfVarType(bv.type)) return;   // bool/认不出的变量：面板上这格本来就不显示
      // 有效类型：绑了变量以变量为准，否则控件自己的 dispType（老工程回落 fmt 反推）
      const t = (bv ? dtypeOfVarType(bv.type) : '') || cur?.props?.dispType || dtypeFromFmt(cur?.props?.fmt);
      setWidgetDecimals(cur, t, n);
      project.touch();
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
      project.updateWidgetProp(w.id, btn.dataset.clear, batchColorClear(w, btn.dataset.clear));
      commitLater();
      render();
    });
  });
  // 图片选择：本地文件读为 base64 内嵌进工程（先缩到最长边 1280 并重编码，别让工程撑爆）
  body.querySelectorAll('[data-imgpick]').forEach(btn => {
    const key = btn.dataset.imgpick;
    const fi = body.querySelector(`[data-imgfile="${key}"]`);
    if (!fi) return;
    // change 挂在 input 上（不是按钮点开时才挂）：这样拖文件进来、或用脚本直接喂文件都能走同一条链路
    fi.onchange = async () => {
      const file = fi.files[0];
      fi.value = '';                       // 清空，同一个文件可以再选一次
      if (!file) return;
      btn.disabled = true;
      try {
        const raw = await readFileAsDataURL(file);
        const url = await fitImageDataUrl(raw);
        project.updateWidgetProp(w.id, key, url);   // dataURL 存入工程 JSON
        commitLater();
        render();   // 刷新预览
      } catch (err) {
        console.warn('[图片] 导入失败', err);
      } finally {
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', () => fi.click());
  });
  body.querySelectorAll('[data-bind]').forEach(sel => {
    const key = sel.dataset.bind || 'variable';            // 一般是 variable；波形还有 startVar / clearVar
    const apply = () => {
      project.updateWidgetField(w.id, `bindings.${key}`, sel.value.trim());
      // 勾了「动作变量和显示变量一致」→ 显示变量一改，动作里的变量跟着改（只对主绑定那格）
      const cur = project.getWidget(w.id);
      if (key === 'variable' && cur?.followBind && syncFollowBind(cur, sel.value.trim())) project.commit('修改绑定变量');
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

  /* ── 按条件启用：条件行的增 / 删 / 改 ──
     ⚠ 条件表存在控件 props 里（`gateConds`），**每次改都整表写回**（数组 = 一个值），
       和波形通道那套一个路子；改完 `render()` 重画面板（bool/数值的"值"控件要靠它换样式）。 */
  const readConds = () => {
    const cur = project.getWidget(w.id) || w;
    return Array.isArray(cur.props?.gateConds) ? cur.props.gateConds.map(c => ({ ...c })) : [];
  };
  const writeConds = (list, what) => {
    project.updateWidgetProp(w.id, 'gateConds', list);
    project.commit(what || '修改启用条件');
  };
  body.querySelectorAll('[data-gk]').forEach(inp => {
    const gi = +inp.closest('.gate-cond')?.dataset.gi;
    const key = inp.dataset.gk;
    const applyG = () => {
      const list = readConds();
      if (!list[gi]) return;
      const isCheck = inp.type === 'checkbox';
      list[gi][key] = isCheck ? inp.checked : inp.value.trim();
      writeConds(list, '修改启用条件');
    };
    if (inp.type === 'checkbox' || inp.tagName === 'SELECT') {
      inp.addEventListener('change', () => { applyG(); render(); });
    } else {
      // 变量格：边打字只体检（标红），写进工程等 change —— 半截变量名不该落盘
      inp.addEventListener('input', () => {
        const miss = inp.value.trim() && !gateVarType(inp.value);
        inp.classList.toggle('bad', !!miss);
        inp.title = miss ? `变量表里没有「${inp.value.trim()}」—— 运行时不生效` : '';
      });
      inp.addEventListener('change', () => { applyG(); render(); });
    }
  });
  body.querySelectorAll('[data-gdel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = readConds();
      list.splice(+btn.dataset.gdel, 1);
      writeConds(list, '删除启用条件');
      render();
    });
  });
  body.querySelector('#gateAdd')?.addEventListener('click', () => {
    const list = readConds();
    // 新行：运算符按常用给（数值 ≥ / bool =），值先空着（bool 那格是下拉，默认"真"）
    list.push({ v: '', op: '>=', val: '', not: false });
    writeConds(list, '添加启用条件');
    render();
    // 加完把焦点放到新行的变量格上（现场就是接着打字选变量）
    const rows = body.querySelectorAll('.gate-cond');
    const last = rows[rows.length - 1]?.querySelector('input[data-gk="v"]');
    last?.focus();
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
  box.replaceChildren();

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

/** 条件行里的运算符：数值/字符串用全套；bool 只留 = / ≠（拿 bool 去比大小没意义） */
const GATE_OPS = [
  { v: '>=', t: '≥' }, { v: '>', t: '>' }, { v: '<=', t: '≤' },
  { v: '<', t: '<' }, { v: '==', t: '=' }, { v: '!=', t: '≠' },
];
const GATE_OPS_BOOL = [{ v: '==', t: '=' }, { v: '!=', t: '≠' }];
const COND_TYPES = new Set(['bool']);

/** 条件里那个变量的类型（找不到 = 空串：变量可能改名/删了） */
function gateVarType(name) {
  return String(project.variables().find(v => v.name === String(name || '').trim())?.type || '').toLowerCase();
}

/**
 * 「按条件启用」那一组（控件属性面板）。
 *
 * 现场要的两件事其实是**同一套判定 + 两种表现**：
 *   · 像权限锁那样锁住控件，但开锁靠**变量条件**（不是密码）；
 *   · 条件不满足时**整个控件不显示**（那块位置也点不了）。
 * 所以面板上就是一个开关 + 一个"不满足时怎么办"的选择 + 一组条件（与/或 + 每条可取反）。
 * @param {object} w 控件
 */
function gateGroupHtml(w) {
  const on = w.props?.gateOn === true;
  const mode = String(w.props?.gateMode || '') === 'lock' ? 'lock' : 'hide';
  const logic = String(w.props?.gateLogic || '') === 'or' ? 'or' : 'and';
  const hint = w.props?.gateHint === true;      // 「不满足时弹提示」：默认关（现场要求画面干净）
  const conds = Array.isArray(w.props?.gateConds) ? w.props.gateConds : [];
  const rowHtml = (c, i) => {
    const name = String(c?.v || '');
    const t = gateVarType(name);
    const isBool = COND_TYPES.has(t);
    const ops = isBool ? GATE_OPS_BOOL : GATE_OPS;
    const op = String(c?.op || (isBool ? '==' : '>='));
    const miss = name && !t;                       // 变量表里没有这个变量 → 标红（判定永远不成立）
    const val = c?.val === undefined || c?.val === null ? '' : String(c.val);
    return `
      <div class="gate-cond" data-gi="${i}">
        <div class="gate-cond-row">
          <label class="f-label" for="gateVar${i}">条件${conds.length > 1 ? i + 1 : ''}</label>
          <input class="f-input mono${miss ? ' bad' : ''}" id="gateVar${i}" data-gk="v" data-vpick="gate" value="${esc(name)}"
                 placeholder="变量" title="${miss ? `变量表里没有「${esc(name)}」` : '输入或选择条件变量'}">
          <button type="button" class="tb-btn sm gate-cond-delete" data-gdel="${i}" title="删除条件" aria-label="删除条件${i + 1}">✕</button>
        </div>
        <div class="gate-cond-row">
          <select class="f-select" data-gk="op" aria-label="比较运算符">${ops.map(o =>
            `<option value="${o.v}" ${op === o.v ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>
          ${isBool
        ? `<select class="f-select" data-gk="val" aria-label="比较值">
               <option value="true" ${val === '' || val === 'true' || val === '1' ? 'selected' : ''}>真</option>
               <option value="false" ${val === 'false' || val === '0' ? 'selected' : ''}>假</option>
             </select>`
        : `<input class="f-input" data-gk="val" value="${esc(val)}" placeholder="比较值" aria-label="比较值">`}
          <label class="prop-check" title="取反，条件不满足时判为成立">
            <input class="f-check" type="checkbox" data-gk="not" ${c?.not ? 'checked' : ''}>非</label>
        </div>
      </div>`;
  };
  return `
    <div class="prop-group"${on || conds.length ? '' : ' data-fold-default'}>
      <button type="button" class="prop-group-title">按条件启用</button>
      <label class="f-row prop-check" title="启用后，运行时根据设置的变量条件决定是否显示或允许操作">
        <span class="f-label">启用</span>
        <input class="f-check" data-prop="gateOn" type="checkbox" ${on ? 'checked' : ''}>
      </label>
      <div class="f-row"><label class="f-label" for="propGateMode">不满足时</label>
        <select class="f-select" id="propGateMode" data-prop="gateMode" title="条件不满足时隐藏控件，或保留显示但禁止操作">
          <option value="hide" ${mode === 'hide' ? 'selected' : ''}>隐藏控件</option>
          <option value="lock" ${mode === 'lock' ? 'selected' : ''}>显示但禁用</option>
        </select></div>
      <div class="f-row"><label class="f-label" for="propGateLogic">条件之间</label>
        <select class="f-select" id="propGateLogic" data-prop="gateLogic">
          <option value="and" ${logic === 'and' ? 'selected' : ''}>全部满足（与）</option>
          <option value="or" ${logic === 'or' ? 'selected' : ''}>任一满足（或）</option>
        </select></div>
      <div class="prop-options">
        <label class="f-row prop-check" title="锁住时点击会弹出提示，不勾选就不弹">
          <input class="f-check" data-prop="gateHint" type="checkbox" ${hint ? 'checked' : ''}>
          <span class="f-label">弹提示</span>
        </label>
        <label class="f-row prop-check" title="条件不满足且控件被锁住时，显示小锁标记">
          <input class="f-check" data-prop="showGateBadge" type="checkbox" ${w.props?.showGateBadge !== false ? 'checked' : ''}>
          <span class="f-label">条件锁标记</span>
        </label>
      </div>
      ${conds.map(rowHtml).join('')}
      <button type="button" class="tb-btn sm" id="gateAdd">＋ 添加条件</button>
    </div>`;
}

/** 把候选表挂到这一批变量输入框上（照 kind 给各自的候选与备注） */
function wireVarPicks(root, w) {
  const def = registry.get(w.type) || {};
  root.querySelectorAll('[data-vpick]').forEach(inp => {
    const kind = inp.dataset.vpick;
    // bind：按这一格自己的键取类型（不填 data-bind 的是主绑定 variable）
    const bindKey = inp.dataset.bind || 'variable';
    const types = kind === 'bind' ? (def.binding?.[bindKey]?.types || null)
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
    const key = inp.dataset.bind || 'variable';
    const types = def.binding?.[key]?.types;
    const label = def.binding?.[key]?.label || '这个控件';
    const v = project.variables().find(x => x.name === name);
    if (!v) return `⚠ 变量表里没有「${name}」—— 运行时不生效（改名了就在这里重选一个）`;
    if (types && v.type && !types.includes(v.type)) {
      return `⚠「${name}」是 ${v.type} 类型，「${label}」要 ${types.join(' / ')}`;
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
