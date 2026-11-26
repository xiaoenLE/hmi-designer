/**
 * i18n.js — 画面文字的多语言（翻译表 + 取译文 + 全部导出/导入翻译）
 *
 * 设计口径（现场要的是"全部文字导出来翻译，导回去就能用"）：
 *   · **以「原文」作文本键**：`meta.i18n.dict[语言代码][原文] = 译文`。
 *     同一句原文全工程共用一份译文（改一个控件的文字不影响别的；同一句翻一次全用）。
 *   · 语言列表 / 默认语言存在**工程**里（`meta.i18n.langs` / `default`，跟着工程走、换台机器照样有）；
 *     「现在用哪国语言」存在**本机浏览器**（localStorage `hmi-lang`）—— 现场在一台机器上切一次即可。
 *   · 只有**画面上的文字**要翻：页面名、弹窗标题、控件上的文字（按钮/标签/表头/单元格/下拉选项/
 *     单位/前后缀/无报警提示…）、报警名称与内容。变量名 / 地址 / NodeId / 控件 ID 一律不翻。
 *   · 控件定义里**自己声明**哪些属性是"给人看的文字"：在 props 项上加
 *     `i18n: 'text' | 'csv' | 'lines' | 'options'`（不写就按 type 猜：text→text）。
 *     固定按钮、表头和提示通过 `i18nTexts` 声明，使用到该控件的工程导出这些原文。
 *     渲染时用下面的 tr / trCsv / trLines / trOptions 包一下就行。
 *   · 没配语言 / 就用默认语言时，tr() 原样返回（不增加任何行为差异）。
 */
import { project } from './project.js';
import { bus } from './eventBus.js';
import { registry } from '../widgets/registry.js';
import { parseCsv } from './csv.js';

const LANG_KEY = 'hmi-lang';

/** 常见语言的显示名（界面上给现场看；不认识的代码就显示代码本身，也照样能用） */
export const KNOWN_LANGS = {
  'zh-CN': '中文（简体）', 'zh-TW': '中文（繁體）', en: 'English', ru: 'Русский',
  es: 'Español', vi: 'Tiếng Việt', tr: 'Türkçe', ar: 'العربية', pt: 'Português',
  de: 'Deutsch', ja: '日本語', ko: '한국어', th: 'ไทย', id: 'Indonesia', fr: 'Français', it: 'Italiano',
};
export const langLabel = (code) => KNOWN_LANGS[code] || String(code || '');

/** 工程里的多语言配置（缺啥补啥；只在真的改语言表时才会写回工程） */
export function i18nState() {
  const m = project?.data?.meta;
  if (!m) return { default: 'zh-CN', langs: [], dict: {} };
  let s = m.i18n;
  if (!s || typeof s !== 'object') s = m.i18n = { default: 'zh-CN', langs: [], dict: {} };
  if (typeof s.default !== 'string' || !s.default) s.default = 'zh-CN';
  if (!Array.isArray(s.langs)) s.langs = [];
  if (!s.dict || typeof s.dict !== 'object') s.dict = {};
  s.langs = s.langs.filter(l => l && typeof l.code === 'string' && l.code && l.code !== s.default);
  s.langs.forEach(l => { if (!l.label) l.label = langLabel(l.code); });
  Object.keys(s.dict).forEach(k => { if (k === s.default) delete s.dict[k]; });
  if (!s.scale || typeof s.scale !== 'object') s.scale = {};
  // 每控件每语言的**字号覆盖**：s.wsize[语言代码]['<控件id>|<字号属性>'] = px
  // （属性面板在非默认语言下改字号只影响那一门语言；默认语言改的是控件基础字号）
  if (!s.wsize || typeof s.wsize !== 'object') s.wsize = {};
  return s;
}

/** 全部可选语言（默认语言排第一） */
export function languages() {
  const s = i18nState();
  return [{ code: s.default, label: langLabel(s.default) }, ...s.langs.map(l => ({ code: l.code, label: l.label || langLabel(l.code) }))];
}
export const defaultLang = () => i18nState().default;
export const isTranslatable = () => languages().length > 1;

/** 当前语言：本机记住的那个；不在语言表里就回到默认 */
export function getLang() {
  let v = '';
  try { v = localStorage.getItem(LANG_KEY) || ''; } catch { /* 忽略 */ }
  const codes = new Set(languages().map(l => l.code));
  return (v && codes.has(v)) ? v : defaultLang();
}

/** 切语言（存本机 + 广播；运行态/编辑画布收到 `i18n:lang` 自己重画） */
export function setLang(code) {
  const ok = languages().some(l => l.code === code);
  const next = ok ? code : defaultLang();
  try { localStorage.setItem(LANG_KEY, next); } catch { /* 忽略 */ }
  bus.emit('i18n:lang', { lang: next });
  return next;
}

/* ── 每门语言的字号比例（%）──────────────────────────────────────────
   为什么要有它：同一句话翻成英文/德文会变长、翻成日文会变短 —— 现场要"不同语言字体大小不一样"。
   比例存在**工程**里（meta.i18n.scale[语言代码]，跟着工程走、存/导出都带着），缺省 100%。
   渲染时由 widgets/registry.js 把控件里的内联 font-size 按这个比例乘一遍；
   导出翻译表 CSV 会带上每门语言的「字号%」列，Excel 里填好再导回来即可。 */
export function langScale(code) {
  const s = i18nState();
  const sc = s.scale && typeof s.scale === 'object' ? s.scale : null;
  const n = sc ? Number(sc[String(code || '')]) : NaN;
  return Number.isFinite(n) ? Math.max(50, Math.min(200, Math.round(n))) : 100;
}
/** 设某门语言的字号%（50~200；100 = 不缩放）。会广播 i18n:lang 让画面按新字号重画。 */
export function setLangScale(code, pct) {
  const c = String(code || '').trim();
  if (!c) return 100;
  const s = i18nState();
  if (!s.scale || typeof s.scale !== 'object') s.scale = {};
  const n = Math.max(50, Math.min(200, Math.round(Number(pct) || 100)));
  if (n === 100) delete s.scale[c];
  else s.scale[c] = n;
  bus.emit('i18n:lang', { lang: getLang() });
  return n;
}
/** 当前语言的字号系数（1 = 100%），registry 渲染控件时用它乘内联 font-size */
export function langFontFactor() {
  return langScale(getLang()) / 100;
}

/* ── 属性面板跟随当前语言：文本 / 字号 ──────────────────────────────
   现场问题：切到英文后属性面板里还是中文原文；改字号"一起变"（改的是基础字号，所有语言都跟着变）。
   口径：
     · 文本类属性（def 里声明了 i18n 的）在**当前语言≠默认语言**时，面板显示当前语言的译文；
       编辑时写 `dict[当前语言][原文] = 新值`，**不改编原文 prop**（原文是翻译表的键，不能动）。
     · 字号类属性（fontSize / textSize / numberSize / valueSize）在非默认语言下显示「这门语言下
       这个控件该属性的生效 px」；编辑时只记这个控件的这门语言覆盖（meta.i18n.wsize），
       切回默认语言基础字号不变。
     · 默认语言下这两个函数都不改变现有行为（改的就是原文 / 基础字号）。
   `wsize` 的键带控件 id：同一个字号覆盖只影响这一个控件（不同控件可以各调各的）。 */

/** 当前语言下显示文本：非默认语言有译文→译文，否则原文（默认语言下原样返回） */
export function textOf(raw) {
  return tr(raw);
}

/**
 * 写当前语言的译文（非默认语言才写；默认语言返回 false，由调用方走原来的「改原文」逻辑）。
 * 新值等于原文（或清空）→ 删掉这条译文；**永远不动原文 prop**。
 */
export function setTranslationFor(raw, val) {
  const s = i18nState();
  const lang = getLang();
  if (lang === s.default) return false;
  const src = String(raw === null || raw === undefined ? '' : raw);
  if (!src) return false;
  const v = String(val === null || val === undefined ? '' : val);
  if (!s.dict[lang]) s.dict[lang] = {};
  const d = s.dict[lang];
  if (!v || v === src) {
    if (Object.prototype.hasOwnProperty.call(d, src)) {
      delete d[src];
      if (!Object.keys(d).length) delete s.dict[lang];
    }
    return true;
  }
  d[src] = v;
  return true;
}

/** 控件某个字号属性的**基础 px**（控件自己填的；老工程缺键时用 def.defaults 的默认值） */
function fontBasePxOf(w, key) {
  const p = (w && w.props) || {};
  let v = p[key];
  if (v === undefined || v === null || v === '') {
    const def = w ? registry.get(w.type) : null;
    v = def && def.defaults ? def.defaults[key] : undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 当前语言下该控件该字号属性的生效 px：per-widget 覆盖优先，否则 basePx × 语言字号% */
export function widgetFontPx(w, key) {
  if (!w || !key) return 0;
  const lang = getLang();
  const s = i18nState();
  const map = (s.wsize && s.wsize[lang]) || {};
  const ov = Number(map[String(w.id) + '|' + key]);
  if (Number.isFinite(ov) && ov > 0) return Math.round(ov);
  const base = fontBasePxOf(w, key);
  if (!(base > 0)) return 0;
  return Math.round(base * langScale(lang) / 100);
}

/** 设**指定语言**下该控件该字号属性的 px（属性面板用当前语言调用；导入翻译表按 CSV 里的语言调用）。
 *  存进 meta.i18n.wsize[lang]['<控件id>|<字号属性>']；等于「该语言全局默认生效值」就删掉覆盖。
 *  默认语言返回 false（基础字号由普通属性编辑处理，行为不变）。 */
function setWidgetFontPxAt(w, key, px, lang) {
  if (!w || !key) return false;
  const s = i18nState();
  const code = String(lang || '');
  if (!code || code === s.default) return false;
  const base = fontBasePxOf(w, key);
  const defPx = base > 0 ? Math.round(base * langScale(code) / 100) : 0;
  const n = Math.round(Number(px));
  if (!s.wsize || typeof s.wsize !== 'object') s.wsize = {};
  const map = s.wsize[code] || (s.wsize[code] = {});
  const k = String(w.id) + '|' + key;
  if (!Number.isFinite(n) || n <= 0 || n === defPx) delete map[k];
  else map[k] = n;
  if (!Object.keys(map).length) delete s.wsize[code];
  return Number.isFinite(n) && n > 0 && n !== defPx;
}

/**
 * 设当前语言下该控件该字号属性的 px（只影响这一个控件、这一门语言）。
 * 存进 meta.i18n.wsize[lang]['<控件id>|<字号属性>']；等于「默认生效值」就删掉覆盖。
 * 默认语言返回 false（基础字号由普通属性编辑处理，行为不变）。
 */
export function setWidgetFontPx(w, key, px) {
  return setWidgetFontPxAt(w, key, px, getLang());
}

/** 给 registry 用：当前语言下这个控件的字号缩放系数（有 per-widget 覆盖→覆盖px/基础px，否则语言字号%）。 */
export function fontFactorForWidget(w) {
  const lang = getLang();
  const s = i18nState();
  const map = (s.wsize && s.wsize[lang]) || {};
  const prefix = (w && w.id) ? String(w.id) + '|' : '';
  if (prefix) {
    const k = Object.keys(map).find(x => x.indexOf(prefix) === 0);
    if (k) {
      const key = k.slice(prefix.length);
      const base = fontBasePxOf(w, key);
      const ov = Number(map[k]);
      if (base > 0 && Number.isFinite(ov) && ov > 0) return ov / base;
    }
  }
  return langScale(lang) / 100;
}

/** 加一门语言（code 已存在就只改显示名）；label 空则用内置名 */
export function addLanguage(code, label) {
  const c = String(code || '').trim();
  if (!c) return false;
  const s = i18nState();
  if (c === s.default) { s.defaultLabel = label || langLabel(c); return true; }
  const hit = s.langs.find(l => l.code === c);
  if (hit) { if (label) hit.label = label; }
  else s.langs.push({ code: c, label: label || langLabel(c) });
  return true;
}

/** 删一门语言（连同它的译文和每控件字号覆盖） */
export function removeLanguage(code) {
  const s = i18nState();
  s.langs = s.langs.filter(l => l.code !== code);
  delete s.dict[code];
  if (s.wsize && typeof s.wsize === 'object') delete s.wsize[code];
  if (getLang() === code) setLang(s.default);
  return true;
}

/** 设默认语言（原文所在语言）。原来默认那门会被保留成一门可翻译语言，原文不丢。 */
export function setDefaultLang(code) {
  const s = i18nState();
  const c = String(code || '').trim();
  if (!c || c === s.default) return false;
  const old = s.default;
  s.langs = s.langs.filter(l => l.code !== c);
  if (!s.langs.some(l => l.code === old)) s.langs.push({ code: old, label: langLabel(old) });
  s.default = c;
  delete s.dict[c];
  setLang(c);
  return true;
}

/* ─────────── 取译文 ─────────── */

/** 翻一段文字（原文没配译文 → 原样返回） */
export function tr(text) {
  if (text === undefined || text === null) return '';
  const src = String(text);
  if (!src) return src;
  const s = i18nState();
  const lang = getLang();
  if (lang === s.default) return src;
  const d = s.dict[lang] || {};
  if (Object.prototype.hasOwnProperty.call(d, src) && d[src] !== '') return String(d[src]);
  // 原文前后带空格的（排版用）也认一次 trim 后的键
  const t = src.trim();
  if (t !== src && Object.prototype.hasOwnProperty.call(d, t) && d[t] !== '') {
    return src.replace(t, String(d[t]));
  }
  return src;
}

/** 先翻译整句，再替换 {name} 等字段；业务数据本身原样带入。 */
export function trFormat(source, values) {
  return tr(source).replace(/\{([a-zA-Z]\w*)\}/g, (placeholder, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}

/** 逗号分列的一串（表头 / 单元格一行 / 状态色文字）：逐段翻，逗号与空格原样保留 */
export function trCsv(text) {
  return String(text ?? '').split(',').map(seg => {
    const lead = seg.match(/^\s*/)[0];
    const core = seg.trim();
    return core ? lead + tr(core) : seg;
  }).join(',');
}

/** 换行分列的一串：逐行翻 */
export function trLines(text) {
  return String(text ?? '').split('\n').map(line => tr(line)).join('\n');
}

/** 下拉框选项：「显示文字=值=状态色」每行一条 —— 只翻显示文字，= 后面原样 */
export function trOptions(text) {
  return String(text ?? '').split('\n').map(line => {
    const eq = line.indexOf('=');
    if (eq < 0) return tr(line);
    return tr(line.slice(0, eq)) + line.slice(eq);
  }).join('\n');
}

/* ─────────── 收集画面文字（导出翻译用） ─────────── */

/** 某个属性值应该怎么拆（对应控件定义里的 i18n 声明） */
function splitOf(prop, key) {
  const hint = prop?.i18n;
  if (hint === false) return '';
  if (hint === 'csv') return 'csv';
  if (hint === 'lines') return 'lines';
  if (hint === 'options') return 'options';
  if (hint) return 'text';
  // 没声明的：文本输入按单句算；多行文本（表格之类）按行
  if (prop?.type === 'textarea') return 'lines';
  return prop?.type === 'text' ? 'text' : '';
}

const SPLIT_TEXT = {
  text: (v) => [String(v)],
  csv: (v) => String(v).split(','),
  lines: (v) => String(v).split('\n'),
  options: (v) => String(v).split('\n').map(l => { const i = l.indexOf('='); return i < 0 ? l : l.slice(0, i); }),
};

/**
 * 把工程里所有"给人看的文字"收集成 [{ kind, where, field, source, size, widgetId, sizeKey }]。
 * kind = 分类（页面 / 弹窗 / 公共底 / 控件 / 报警 / 下拉选项…）；where = 位置（页名 + 控件名）；
 * field = 哪个字段（名称 / 标题 / 文本 / 表头…）；source = 原文（翻译表就拿它当键）；
 * size = 这条文字所在控件的字号（px，导出的「字号px」列；页面/报警这类没有字号给 ''）；
 * widgetId / sizeKey = 控件行的控件 id 与字号属性键（导出的「控件ID」「<语言>字号px」列靠它定位）。
 * 同一句原文只出现一次（同一句翻一次全工程共用）。
 */
export function collectEntries() {
  const rows = [];
  const seen = new Set();
  const fixedByType = new Map();
  const add = (kind, where, field, value, split, size, widgetId, sizeKey) => {
    const raw = value === undefined || value === null ? '' : String(value);
    if (!raw.trim()) return;
    (SPLIT_TEXT[split] || SPLIT_TEXT.text)(raw).forEach(part => {
      const src = String(part ?? '').trim();
      if (!src) return;
      const k = src;
      if (seen.has(k)) return;
      seen.add(k);
      rows.push({
        kind, where, field, source: src,
        size: size === undefined ? '' : size,
        widgetId: widgetId || '', sizeKey: sizeKey || '',
      });
    });
  };
  const pages = project?.data?.pages || [];
  pages.forEach(p => {
    const pKind = p.type === 'base' ? '公共底' : p.type === 'popup' ? '弹窗' : '页面';
    add(pKind, p.name, '页面名称', p.name, 'text');
    if (p.title) add(pKind, p.name, '弹窗标题', p.title, 'text');
    (p.widgets || []).forEach(w => {
      const def = registry.get(w.type);
      const title = def?.title || w.type;
      const where = `${p.name} / ${title}${w.name ? `「${w.name}」` : ''}`;
      if (Array.isArray(def?.i18nTexts) && !fixedByType.has(w.type)) {
        fixedByType.set(w.type, { texts: def.i18nTexts, where: title });
      }
      // 控件字号：优先 fontSize，其次 textSize / numberSize（每个控件可能不一样，导出时带出去）
      const keys = (def?.props || []).map(x => x && x.key).filter(Boolean);
      const fontKey = keys.indexOf('fontSize') >= 0 ? 'fontSize'
        : (keys.find(k => /^(textSize|numberSize|valueSize|fontSize)$/.test(k)) || '');
      const fsz = fontKey ? Number(w.props?.[fontKey]) : NaN;
      const size = Number.isFinite(fsz) && fsz > 0 ? fsz : '';
      (def?.props || []).forEach(prop => {
        if (!prop || !prop.key) return;
        const split = splitOf(prop, prop.key);
        if (!split) return;
        const val = w.props?.[prop.key];
        if (val === undefined || val === null || val === '') return;
        add('控件', where, prop.label || prop.key, val, split, size, w.id, fontKey);
      });
      // `text` 是旧工程里「未满文字」的兼容镜像；迁移后 offText 已包含该文字，
      // 如遇未规范化的数据，再补收旧字段并由 seen 去重。
      if (w.type === 'button' && typeof w.props?.text === 'string' && w.props.text.trim()) {
        add('控件', where, '文本', w.props.text, 'text', size, w.id, fontKey);
      }
    });
  });
  (project?.data?.alarms || []).forEach(a => {
    if (a.name) add('报警', a.name, '报警名称', a.name, 'text');
    if (a.text) add('报警', a.name, '报警内容', a.text, 'text');
  });
  project.customAlarmLevels().forEach(level => add('报警', '报警级别', '级别名称', level.t, 'text'));
  // 先收工程文字，和控件属性重名的固定文字沿用该属性所在的翻译行与字号信息。
  for (const { texts, where } of fixedByType.values()) {
    texts.forEach(text => add('控件', where, '内置文字', text, 'text'));
  }
  return rows;
}

/** 某门语言已翻译了几条 */
export function translationCount(code) {
  const d = i18nState().dict[code] || {};
  return Object.keys(d).filter(k => String(d[k] ?? '').trim() !== '').length;
}

/* ─────────── 导出 / 导入翻译（CSV，Excel 直接打开） ─────────── */

const CSV_HEAD = ['分类', '位置', '字段', '原文'];
const escCell = (s) => {
  const v = String(s ?? '');
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** 按控件 id 找控件（跨页面/公共底；导出/导入翻译表时用） */
function widgetById(id) {
  const wid = String(id || '');
  if (!wid) return null;
  const pages = (project && project.data && project.data.pages) || [];
  for (const p of pages) {
    const ws = (p && p.widgets) || [];
    const hit = ws.find(w => w && String(w.id) === wid);
    if (hit) return hit;
  }
  return null;
}
/** 控件用哪个 prop 当字号（和 collectEntries 的取法一致：优先 fontSize，其次 textSize/numberSize/valueSize） */
function fontSizeKeyOf(w) {
  const def = w ? registry.get(w.type) : null;
  const keys = ((def && def.props) || []).map(x => x && x.key).filter(Boolean);
  if (keys.indexOf('fontSize') >= 0) return 'fontSize';
  return keys.find(k => /^(textSize|numberSize|valueSize|fontSize)$/.test(k)) || '';
}
/** 某控件在某门语言下的生效字号 px（wsize 覆盖优先，否则 round(基础字号 × 该语言字号%)）；没有字号属性给 '' */
function widgetLangPx(w, key, code) {
  if (!w || !key) return '';
  const s = i18nState();
  const map = (s.wsize && s.wsize[code]) || {};
  const ov = Number(map[String(w.id) + '|' + key]);
  if (Number.isFinite(ov) && ov > 0) return Math.round(ov);
  const base = fontBasePxOf(w, key);
  if (!(base > 0)) return '';
  return Math.round(base * langScale(code) / 100);
}

/**
 * 生成一份"全部文字"的翻译表（CSV，带 UTF-8 BOM + CRLF，Excel 打开中文不乱码）。
 * 列：分类,位置,字段,原文,控件ID,字号px,<语言1>,<语言1>字号%,<语言1>字号px,<语言2>,…
 *   · 字号px = **这条文字所在控件的基础字号**（页面/报警这类没有字号就空着）。
 *   · 控件ID = 控件行的控件 id（导入时靠它把「<语言>字号px」写回 meta.i18n.wsize[语言]）。
 *   · 译文列 = 留空等现场填；字号% 列 = 这门语言的全局字体缩放比例（100 = 不缩放）；
 *     **字号px 列 = 该控件在这门语言下的生效字号**（有 per-widget 覆盖→覆盖值，否则 基础×字号%），
 *     这样导出/导入/换机器后各控件按语言设的字号也能对上。
 */
export function exportTranslationCsv(codes) {
  const s = i18nState();
  const langs = (codes && codes.length ? codes : s.langs.map(l => l.code)).filter(c => c && c !== s.default);
  const entries = collectEntries();
  const head = [...CSV_HEAD, '控件ID', '字号px'];
  langs.forEach(code => { head.push(code, langLabelOf(code) + '字号%', langLabelOf(code) + '字号px'); });
  const lines = [head.map(escCell).join(',')];
  entries.forEach(e => {
    const cells = [e.kind, e.where, e.field, e.source, e.widgetId || '', e.size === undefined ? '' : e.size];
    const w = e.widgetId ? widgetById(e.widgetId) : null;
    const sizeKey = e.sizeKey || (w ? fontSizeKeyOf(w) : '');
    langs.forEach(code => {
      const px = (w && sizeKey) ? widgetLangPx(w, sizeKey, code) : '';
      cells.push((s.dict[code] || {})[e.source] || '', langScale(code), px);
    });
    lines.push(cells.map(escCell).join(','));
  });
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** 语言代码 → 界面上用的显示名（带了工程里的自定义显示名） */
function langLabelOf(code) {
  const hit = languages().find(l => l.code === code);
  return hit ? hit.label : langLabel(code);
}

/**
 * 导入翻译表：按表头里的语言代码（第 5 列起）把译文填进对应语言。
 * 兼容：表头写语言代码（en）或显示名（English）都认；原文列必须能对上（对不上的行跳过）。
 * @returns {{ok:boolean, langs:string[], filled:number, skipped:number, reason?:string}}
 */
export function importTranslationCsv(text) {
  let rows = [];
  try { rows = parseCsv(String(text || '')); } catch (e) { return { ok: false, langs: [], filled: 0, skipped: 0, reason: `CSV 解析失败：${e.message}` }; }
  if (!rows.length) return { ok: false, langs: [], filled: 0, skipped: 0, reason: '文件是空的' };
  const head = (rows[0] || []).map(x => String(x ?? '').trim());
  const srcIdx = head.findIndex(h => h === '原文' || h === '原文（默认语言）' || h === 'source');
  if (srcIdx < 0) return { ok: false, langs: [], filled: 0, skipped: 0, reason: '表头里找不到「原文」列（请用本软件导出的翻译表模板填）' };
  const s = i18nState();
  // 语言列：第 5 列起（或者「原文」右边所有非空列），兼容代码/显示名
  const codeOf = (h) => {
    if (!h) return '';
    const byCode = languages().find(l => l.code === h);
    if (byCode) return byCode.code;
    const byLabel = languages().find(l => l.label === h);
    return byLabel ? byLabel.code : '';
  };
  // 「字号%」列（导出的翻译表里每门语言后面跟一列，表头形如 `English字号%` / `en字号%`）：
  // 去掉后缀按语言代码/显示名找语言 → 这个语言的字号比例
  const scaleOfHead = (h) => {
    const m = /^(.*?)\s*字号\s*%?$/.exec(String(h || '').trim());
    if (!m) return '';
    const name = m[1].trim();
    return name ? (codeOf(name) || '') : '';
  };
  // 「<语言>字号px」列（task-31 新增）：该控件在这门语言下的生效字号，导入时写回 meta.i18n.wsize
  const pxOfHead = (h) => {
    const m = /^(.*?)\s*字号\s*px$/i.exec(String(h || '').trim());
    if (!m) return '';
    const name = m[1].trim();
    return name ? (codeOf(name) || '') : '';
  };
  const widgetIdIdx = head.indexOf('控件ID');
  const cols = [];
  const scaleCols = [];
  const pxCols = [];
  head.forEach((h, i) => {
    if (i === srcIdx) return;
    if (i < CSV_HEAD.length - 1) return;          // 分类/位置/字段/原文 之前的元数据列
    if (['分类', '位置', '字段', '控件ID', '字号px'].includes(h)) return;
    const sc = scaleOfHead(h);
    if (sc) { scaleCols.push({ i, code: sc }); return; }   // 字号% 列不算翻译列
    const pc = pxOfHead(h);
    if (pc) { pxCols.push({ i, code: pc }); return; }      // <语言>字号px 列不算翻译列
    const code = codeOf(h);
    if (code) cols.push({ i, code });
  });
  if (!cols.length && !scaleCols.length && !pxCols.length) return { ok: false, langs: [], filled: 0, skipped: 0, reason: '表头里没有语言列（代码如 en / ru，或显示名如 English）' };
  if (!cols.length) return { ok: false, langs: [], filled: 0, skipped: 0, reason: '表头里没有语言列（代码如 en / ru，或显示名如 English）' };
  let filled = 0, skipped = 0, sizes = 0;
  // 字号列：取**第一个非空值**（导出时每行都写同一个值；现场在 Excel 里改一行就生效）
  const scaleTaken = {};
  rows.slice(1).forEach(r => {
    const src = String(r?.[srcIdx] ?? '').trim();
    scaleCols.forEach(({ i, code }) => {
      if (scaleTaken[code]) return;
      const raw = String(r?.[i] ?? '').trim();
      const n = Number(raw);
      if (raw && Number.isFinite(n)) { setLangScale(code, n); scaleTaken[code] = n; }
    });
    if (!src) return;
    // <语言>字号px：行里有 控件ID → 写到该控件的 meta.i18n.wsize[语言]（等于全局默认生效值就删）
    if (pxCols.length && widgetIdIdx >= 0) {
      const wid = String(r?.[widgetIdIdx] ?? '').trim();
      const w = wid ? widgetById(wid) : null;
      const sizeKey = w ? fontSizeKeyOf(w) : '';
      if (w && sizeKey) {
        pxCols.forEach(({ i, code }) => {
          const rawPx = String(r?.[i] ?? '').trim();
          const px = Number(rawPx);
          if (!rawPx || !Number.isFinite(px) || px <= 0) return;
          setWidgetFontPxAt(w, sizeKey, Math.round(px), code);
          sizes++;
        });
      }
    }
    let any = false;
    cols.forEach(({ i, code }) => {
      const val = String(r?.[i] ?? '').trim();
      if (!val || val === src) return;
      if (!s.dict[code]) s.dict[code] = {};
      s.dict[code][src] = val;
      filled++;
      any = true;
    });
    if (!any) skipped++;
  });
  const scales = {};
  scaleCols.forEach(c => { scales[c.code] = scaleTaken[c.code] || 100; });
  return { ok: true, langs: cols.map(c => c.code), filled, skipped, scales, sizes };
}
