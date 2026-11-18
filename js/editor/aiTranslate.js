/**
 * aiTranslate.js — AI 批量翻译（多语言）
 *
 * 为什么不用 CSV 那条老链路：CSV 是"人拿着 Excel 翻译"，一次几百上千行；
 * 这里要的是"点一下、等十几秒、工程就翻好了"，所以：
 *   ① 待翻译文本直接取 i18n.collectEntries()（和 CSV 导出用的是同一份收集逻辑）；
 *   ② 按 ~30 条一批丢给模型，只要求它返回 {"1":"译文","2":"译文"} 这种朴素 JSON；
 *   ③ 写回只认 collectEntries() 里真实存在的原文（模型幻觉出来的键一律丢弃）；
 *   ④ 全部写完后**一次 commit** → 一步撤销，然后 setLang 切过去立刻看效果。
 *
 * 对外：
 *   pendingStats()            面板顶部/翻译对话框用：每门语言还差多少条
 *   pendingFor(lang, scope)   待翻条目（scope: all | page）
 *   applyPairs(lang, pairs)   把译文写回工程（可直接给测试或"手工翻译"复用）
 *   runTranslate({lang, scope, handlers}) → {cancel}
 *
 * handlers: onProgress({done,total,lang}) onDone({lang,total,filled,...}) onError(msg, code)
 */

import { project } from '../core/project.js';
import { bus } from '../core/eventBus.js';
import {
  collectEntries, i18nState, languages, addLanguage, setLang, langLabel, defaultLang, langScale,
} from '../core/i18n.js';
import { registry } from '../widgets/registry.js';
import { aiClient } from '../api/ai.js';

/** 一批多少条：太小往返多、太大容易超时/丢条目。40 条中文短句 ≈ 输出 1.5~2.5k tokens，很稳 */
const BATCH = 40;
/** 单批最长等多久（毫秒）—— 40 条短句正常 3~12 秒 */
const BATCH_TIMEOUT = 120000;
/** 译文输出的 token 预算（40 条远远用不到，留足防截断） */
const BATCH_MAX_TOKENS = 8000;
/** 一批里成功解析出的条数低于这个比例，就拆成两半重试一次（防截断/丢条） */
const BATCH_MIN_RATE = 0.8;

/** 常见语言 → 给模型看的语言名（不在表里也可以，直接用 code） */
const LANG_NAMES = {
  en: 'English', ja: '日本語', ko: '한국어', 'zh-TW': '繁體中文', de: 'Deutsch', fr: 'Français',
  es: 'Español', pt: 'Português', ru: 'Русский', it: 'Italiano', vi: 'Tiếng Việt', th: 'ไทย',
  id: 'Bahasa Indonesia', tr: 'Türkçe', pl: 'Polski', ar: 'العربية', nl: 'Nederlands', sv: 'Svenska',
};

export function langName(code) {
  return LANG_NAMES[code] || langLabel(code) || code;
}

/** 面板"加语言"下拉里给的候选（用户要别的也能手输） */
export function commonLangs() {
  return Object.keys(LANG_NAMES).map(code => ({ code, name: LANG_NAMES[code] }));
}

/** 全部待翻原文集合（用于过滤模型幻觉） */
function sourceSet() {
  const set = new Set();
  collectEntries().forEach(e => { if (e && e.source) set.add(String(e.source)); });
  return set;
}

/**
 * 某门语言还差多少条没翻。
 * @param {string} lang
 * @param {'all'|'page'} [scope]
 * @returns {Array<{kind:string,where:string,field:string,source:string}>}
 */
export function pendingFor(lang, scope = 'all') {
  const s = i18nState();
  const code = String(lang || '');
  if (!code || code === s.default) return [];
  const dict = (s.dict && s.dict[code]) || {};
  const cur = project.currentPage();
  const curIds = new Set(((cur && cur.widgets) || []).map(w => w.id));
  const curName = cur ? cur.name : '';
  return collectEntries().filter(e => {
    const src = String(e.source || '');
    if (!src.trim()) return false;
    if (dict[src]) return false;
    if (scope === 'page') {
      if (e.widgetId) return curIds.has(e.widgetId);
      return String(e.where || '') === curName;   // 页面名/标题这类行：where 就是页名
    }
    return true;
  });
}

/** 每门语言（不含默认语言）的待翻条数 —— 翻译对话框列表用 */
export function pendingStats() {
  const s = i18nState();
  const langs = (s.langs || []).map(l => {
    const n = pendingFor(l.code, 'all').length;
    return { code: l.code, label: l.label || langName(l.code), pending: n };
  });
  return { default: s.default, langs, total: collectEntries().length };
}

/** pendingStats 的别名（老接口名，测试/面板都用得到） */
export function pendingByLang() {
  return pendingStats();
}

/** 面板上的"翻译整个工程"按钮：选哪门语言？没有别的语言就先加 en */
export function defaultTargetLang() {
  const s = i18nState();
  const cur = (s.langs || [])[0];
  if (cur) return cur.code;
  return 'en';
}

/* ── 解析模型返回的 { "1": "译文", ... } ─────────────────────── */

function parsePairs(content, batch) {
  const out = [];
  const txt = String(content || '').trim();
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/) || txt.match(/\[[\s\S]*\]/);
    if (m) { try { data = JSON.parse(m[0]); } catch { data = null; } }
  }
  const takeItem = (item) => {
    if (!item || typeof item !== 'object') return;
    const idx = Number(item.i ?? item.index ?? item.id);
    if (Number.isFinite(idx) && idx >= 1 && idx <= batch.length) {
      out.push([batch[idx - 1].source, String(item.t ?? item.text ?? item.translation ?? item.v ?? '')]);
      return;
    }
    if (item.source !== undefined || item.s !== undefined) {
      const src = String(item.source ?? item.s);
      const hit = batch.find(e => e.source === src);
      if (hit) out.push([hit.source, String(item.translation ?? item.t ?? item.v ?? '')]);
      return;
    }
    // {k:"原文", v:"译文"}：另一种常见的"键值对"返回形态
    if (item.k !== undefined || item.key !== undefined) {
      const src = String(item.k ?? item.key);
      const hit = batch.find(e => e.source === src);
      if (hit) out.push([hit.source, String(item.v ?? item.value ?? item.translation ?? '')]);
    }
  };
  if (Array.isArray(data)) {
    data.forEach(takeItem);
  } else if (data && typeof data === 'object') {
    const items = data.items || data.translations || data.list || data.pairs;
    if (Array.isArray(items)) {
      items.forEach(takeItem);
    } else {
      Object.keys(data).forEach(k => {
        const idx = Number(k);
        if (Number.isFinite(idx) && idx >= 1 && idx <= batch.length) {
          out.push([batch[idx - 1].source, String(data[k] ?? '')]);
        }
      });
    }
  }
  return out;
}

/* ── 写回工程 ────────────────────────────────────────────────── */

/**
 * 把 [原文, 译文] 数组写进工程（只写真实存在的原文；一次 commit）。
 * @param {string} lang
 * @param {Array<[string,string]>} pairs
 * @param {{label?:string, switchTo?:boolean}} [opt]
 * @returns {{ok:boolean,lang:string,filled:number,same:number,skipped:number,unknown:number,total:number}}
 */
export function applyPairs(lang, pairs, opt = {}) {
  const code = String(lang || '').trim();
  const list = Array.isArray(pairs) ? pairs : [];
  const result = { ok: false, lang: code, filled: 0, same: 0, skipped: 0, unknown: 0, total: list.length };
  if (!code) return result;
  const s = i18nState();
  if (code === s.default) return result;

  // 语言不存在就先加上（"用户说要翻成日文"时 lang 可能还没在语言表里）
  if (!languages().some(l => l.code === code)) addLanguage(code, langName(code));
  if (!s.dict) s.dict = {};
  if (!s.dict[code]) s.dict[code] = {};

  const known = sourceSet();
  const dict = s.dict[code];
  list.forEach(pair => {
    const src = String(pair?.[0] ?? '');
    const val = String(pair?.[1] ?? '').trim();
    if (!src || !val) { result.skipped++; return; }
    if (!known.has(src)) { result.unknown++; return; }         // 模型幻觉 / 已删掉的文字
    if (src === val) { result.same++; return; }                // 和原文一样 = 不用存
    if (dict[src] === val) { result.skipped++; return; }       // 已经是这句
    dict[src] = val;
    result.filled++;
  });
  if (!result.filled) {
    // 一条都没写进去也要把"新加的语言"落到工程里（否则语言表下次刷新就没了）
    if (!(s.langs || []).some(l => l.code === code)) { /* addLanguage 已 push */ }
    result.ok = result.total === 0;
    return result;
  }
  result.ok = true;
  // 译文比原文长时自动缩字号（和译文写回压进同一个 commit → 一步撤销）
  let fit = null;
  if (opt.autofit !== false) {
    try { fit = autofitLang(code); } catch (e) { console.warn('[aiTranslate] 字号自适应失败', e); }
  }
  if (fit) result.autofit = fit;
  project.commit(opt.label ? `AI 翻译（${opt.label}）` : `AI 翻译（${langName(code)}）`);
  if (opt.switchTo !== false) {
    try { setLang(code); } catch { /* 语言表异常时别把翻译结果也搞丢 */ }
  }
  bus.emit('i18n:changed', { lang: code, filled: result.filled });   // 额外通知（面板刷新用；重画靠 setLang 的 i18n:lang）
  return result;
}

/* ── 译文长度自适应（自动缩小控件字号，避免英文/德文把框撑爆） ───────── */

/** 最小字号：再小现场就看不清了；比它还需要缩的，只能建议用户改文案或加宽控件 */
const MIN_FONT = 8;
const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif';

let _measureCtx = null;
function measureCtx() {
  if (_measureCtx === null) {
    try { _measureCtx = document.createElement('canvas').getContext('2d'); } catch { _measureCtx = false; }
  }
  return _measureCtx || null;
}

function textWidth(text, px) {
  const ctx = measureCtx();
  if (!ctx) return String(text || '').length * px * 0.62;   // 没有 canvas 就按经验估（中文≈1em，西文≈0.6em）
  ctx.font = `${px}px ${FONT_STACK}`;
  return ctx.measureText(String(text || '')).width;
}

/** 按字符逐个折行，数出这段文字在 maxW 宽、px 字号下要占几行 */
function countLines(text, px, maxW) {
  const s = String(text || '');
  if (!s) return 0;
  let lines = 0;
  s.split('\n').forEach(para => {
    if (!para) { lines++; return; }
    let cur = '';
    for (const ch of para) {
      const next = cur + ch;
      if (cur && textWidth(next, px) > maxW) { lines++; cur = ch; }
      else cur = next;
    }
    if (cur) lines++;
  });
  return lines;
}

/** 某控件在 px 字号下、放不放得进它的框（文本按框宽折行，行高按 1.35 估） */
function fitsBox(texts, px, availW, availH) {
  let total = 0;
  for (const t of texts) {
    const n = countLines(t, px, availW);
    total += n;
    if (total * px * 1.35 > availH + 0.5) return false;   // 已经超了就提前退出
  }
  return total * px * 1.35 <= availH + 0.5;
}

/**
 * 让某门语言的译文自动适配控件大小：逐个控件算出"能放下译文的最大字号"，
 * 需要缩就写进 meta.i18n.wsize[lang]['<控件id>|<字号属性>']（等于该语言默认值就删掉覆盖）。
 * 只动字号，不动控件几何 —— 版面不会被翻译搞乱。
 * @param {string} lang
 * @param {{commit?:boolean,label?:string}} [opt] commit=true 时把改动一并压进撤销栈
 * @returns {{checked:number,shrunk:number,tooLong:number,minPx:number}}
 */
export function autofitLang(lang, opt = {}) {
  const code = String(lang || '').trim();
  const out = { checked: 0, shrunk: 0, tooLong: 0, minPx: MIN_FONT };
  const s = i18nState();
  if (!code || code === s.default) return out;
  const dict = (s.dict && s.dict[code]) || {};
  if (!dict || !Object.keys(dict).length) return out;
  const byWidget = new Map();       // widgetId → { sizeKey, base, texts: [] }
  collectEntries().forEach(e => {
    if (!e || !e.widgetId || !e.sizeKey) return;
    const val = dict[String(e.source || '')];
    if (!val) return;               // 这句没译文（还是原文）→ 不参与适配
    const base = Number(e.size);
    if (!(base > 0)) return;
    let rec = byWidget.get(e.widgetId);
    if (!rec) { rec = { sizeKey: e.sizeKey, base, texts: [] }; byWidget.set(e.widgetId, rec); }
    rec.texts.push(String(val));
  });
  if (!byWidget.size) return out;

  const scale = langScale(code) / 100 || 1;
  if (!s.wsize || typeof s.wsize !== 'object') s.wsize = {};
  const map = s.wsize[code] || (s.wsize[code] = {});
  const pages = project?.data?.pages || [];
  pages.forEach(p => (p.widgets || []).forEach(w => {
    const rec = byWidget.get(w.id);
    if (!rec || !rec.texts.length) return;
    out.checked++;
    const eff = Math.max(MIN_FONT, Math.round(rec.base * scale));
    const availW = Math.max(8, Number(w.w) - 10);
    const availH = Math.max(8, Number(w.h) - 6);
    const key = String(w.id) + '|' + rec.sizeKey;
    if (fitsBox(rec.texts, eff, availW, availH)) {
      if (Object.prototype.hasOwnProperty.call(map, key)) delete map[key];   // 放得下就清掉旧覆盖
      return;
    }
    let best = 0;
    for (let px = eff - 1; px >= MIN_FONT; px--) {
      if (fitsBox(rec.texts, px, availW, availH)) { best = px; break; }
    }
    if (!best) {                       // 缩到最小还是放不下：缩到最小 + 记一笔
      best = MIN_FONT;
      out.tooLong++;
    }
    map[key] = best;
    out.shrunk++;
  }));
  if (!Object.keys(map).length) delete s.wsize[code];
  if (opt.commit && out.shrunk) {
    project.commit(opt.label || `AI 翻译字号适配（${out.shrunk} 个控件）`);
  }
  return out;
}

/* ── 提示词 ──────────────────────────────────────────────────── */

function translatorPrompt(lang) {
  return [
    '你是工业 HMI（人机界面）组态软件的专业界面翻译。用户会给你一个 JSON：{"lang":"en","items":[{"i":1,"t":"中文原文"},...]}。',
    `你要把每一条 t 翻译成 ${langName(lang)}（语言代码 ${lang}）。`,
    '规则：',
    '1. 只要译文，不要解释、不要注音、不要加引号；界面用词尽量短（按钮 1~3 个词，标签更短），不要句末句号。',
    '2. 原样保留：花括号占位符（如 {温度}）、数字、单位、型号/协议名（如 Modbus、TS600）、变量名、英文缩写。',
    '3. 这是工控现场用词，要符合行业习惯（如「启动/停止/急停/报警/配方/参数/班次产量/公共底」）。',
    '4. 同一批里相同原文只出现一次，不要漏条也不要多编。',
    '5. 严格返回 JSON 对象，键 = 输入的编号（字符串），值 = 译文。例：{"1":"Start","2":"Stop"}。',
    '除了这个 JSON 对象，不要输出任何其它字符。',
  ].join('\n');
}

/* ── 批量翻译主流程 ──────────────────────────────────────────── */

/**
 * 跑一次整站/整页翻译。
 * @param {object} opt
 * @param {string} [opt.lang] 目标语言（省略 = defaultTargetLang()）
 * @param {'all'|'page'} [opt.scope]
 * @param {object} [opt.handlers] onProgress / onDone / onError
 * @returns {{cancel:()=>void}}
 */
export function runTranslate(opt = {}) {
  const handlers = opt.handlers || {};
  const ctl = { cancelled: false, chat: null };
  const h = (name, ...args) => {
    const fn = handlers[name];
    if (typeof fn === 'function') { try { fn(...args); } catch (e) { console.warn('[aiTranslate] handler 出错：' + name, e); } }
  };

  const cancel = () => {
    ctl.cancelled = true;
    try { ctl.chat?.cancel(); } catch { /* 已结束 */ }
  };

  (async () => {
    try {
      const lang = String(opt.lang || defaultTargetLang());
      const scope = opt.scope === 'page' ? 'page' : 'all';
      if (lang === defaultLang()) {
        h('onError', '目标语言不能是默认语言（原文那门）。请先加一门语言再翻译。', 'bad_request');
        return;
      }
      let entries = pendingFor(lang, scope);
      const totalAll = collectEntries().length;
      if (!entries.length) {
        h('onDone', { lang, scope, total: 0, totalAll, filled: 0, note: '没有待翻译的文本（都翻过了，或工程里没有可翻文字）' });
        return;
      }
      const total = entries.length;
      let done = 0;
      const pairs = [];
      let errMsg = '';

      // 一次模型调用翻一批；解析出来的条数不够就拆两半重试（防截断丢条）
      const callBatch = batch => new Promise(resolve => {
        const body = {
          messages: [
            { role: 'system', content: translatorPrompt(lang) },
            { role: 'user', content: JSON.stringify({ lang, items: batch.map((e, idx) => ({ i: idx + 1, t: e.source })) }) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: BATCH_MAX_TOKENS,
        };
        ctl.chat = aiClient.chat(body, {
          onDone: info => resolve({ ok: true, content: info?.content || '' }),
          onError: (msg, code) => resolve({ ok: false, message: String(msg || '翻译失败'), code: String(code || '') }),
        });
        if (ctl.cancelled) {
          try { ctl.chat?.cancel(); } catch { /* ignore */ }
          resolve({ ok: false, message: '已取消', code: 'cancel' });
        }
      });

      const doBatch = async batch => {
        const res = await callBatch(batch);
        ctl.chat = null;
        if (ctl.cancelled) return { ok: false, got: [], code: 'cancel', message: '已取消' };
        if (!res.ok) return { ok: false, got: [], code: res.code, message: res.message };
        const got = parsePairs(res.content, batch);
        if (got.length >= Math.ceil(batch.length * BATCH_MIN_RATE) || batch.length <= 5) return { ok: true, got };
        const mid = Math.ceil(batch.length / 2);
        const first = await doBatch(batch.slice(0, mid));
        if (!first.ok) return first;
        const second = await doBatch(batch.slice(mid));
        if (!second.ok) return { ok: first.ok, got: first.got, code: second.code, message: second.message };
        return { ok: true, got: [...first.got, ...second.got] };
      };

      for (let i = 0; i < entries.length; i += BATCH) {
        if (ctl.cancelled) break;
        const batch = entries.slice(i, i + BATCH);
        h('onProgress', { lang, done, total, batch: batch.length });
        const res = await doBatch(batch);
        if (ctl.cancelled) break;
        if (!res.ok) {
          if (res.code === 'cancel') break;
          errMsg = res.message;
          break;
        }
        if (!res.got.length) {
          errMsg = '模型返回里没有可用的 JSON 译文（可能被截断了，重试一次通常就好）';
          break;
        }
        res.got.forEach(([src, val]) => pairs.push([src, val]));
        done += batch.length;
        h('onProgress', { lang, done, total, batch: 0 });
      }

      const applied = applyPairs(lang, pairs, {
        label: langName(lang),
        autofit: opt.autofit !== false,
      });
      const payload = {
        lang, scope, total, totalAll, done,
        filled: applied.filled, same: applied.same, skipped: applied.skipped, unknown: applied.unknown,
        autofit: applied.autofit || null,
        cancelled: ctl.cancelled, error: errMsg || '',
      };
      if (errMsg && !applied.filled) { h('onError', errMsg, 'http'); return; }
      h('onDone', payload);
    } catch (e) {
      if (ctl.cancelled) return;
      h('onError', `翻译出错：${e && e.message ? e.message : e}`, 'http');
    } finally {
      ctl.chat = null;
    }
  })();

  return { cancel };
}

/** 单测/自检用：把一批 [原文,译文] 直接算成"能写进去的"（不落盘） */
export function previewPairs(lang, pairs) {
  const known = sourceSet();
  const s = i18nState();
  const dict = (s.dict && s.dict[String(lang || '')]) || {};
  const out = { filled: [], same: [], skipped: [], unknown: [] };
  (Array.isArray(pairs) ? pairs : []).forEach(([src, val]) => {
    const a = String(src ?? '');
    const b = String(val ?? '').trim();
    if (!a || !b) out.skipped.push([a, b]);
    else if (!known.has(a)) out.unknown.push([a, b]);
    else if (a === b) out.same.push([a, b]);
    else if (dict[a] === b) out.skipped.push([a, b]);
    else out.filled.push([a, b]);
  });
  return out;
}
