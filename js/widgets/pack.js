/**
 * pack.js — **控件包**：把控件导出去给别人用，别人导进来就能用
 *
 * 分两层，一个文件格式装下：
 *   ① **实例层**（永远带）：控件本身的数据 —— 类型、几何、属性、绑定、动作、组合、用到的变量。
 *      对方工程里有这个控件类型（内置 16 种就是），导进来直接就能用，**不含任何代码**。
 *   ② **定义层**（只有"自定义控件"才带）：这个控件类型本身的定义 —— 属性 schema + 渲染函数。
 *      内置控件的定义在对方代码里就有，不用带；**别人自己写的新控件**，定义必须跟着包走，
 *      否则对方 registry.get() 拿不到 → 那个控件渲染不出来（def.render 会抛）。
 *
 * ⚠ 定义里的 render 是**真的 JavaScript**（不是数据），所以：
 *   · 导出 = 把 render 的源码文本存进包里（String(def.render)）
 *   · 导入 = 用 new Function(白名单 helper..., ...形参, 函数体) 重建
 *   · **导入别人的控件包 = 在你机器上执行别人的代码**，性质和「脚本」面板一样。
 *     所以导入前界面会把源码摊开给你看，要你点头（见 editor/widgetIO.js）——不静默执行。
 *   · render 里能用的东西只有 HELPER_NAMES 里那批（内置控件用的就是这批）：
 *     想在自定义控件里用别的东西，得先把它加进白名单，否则导入后一渲染就是 ReferenceError。
 *
 * 自定义定义还会**存进工程**（data.customWidgets）：换台机器、换个浏览器打开这份工程，
 * 控件照样渲染得出来（和 PLC 配置、面板布局、权限表、脚本一个待遇）。
 */
import { register, unregister, registry, rutil } from './registry.js';
import {
  deepClone, fmtValue, escapeHtml, numberFmtOf, compareVal, parseOptions,
  optionIndexByValue, comboMode, contrastTextOn, fmtTime, fmtDate, dayStart,
  isArrayType, TIME_PRESETS,
} from '../core/utils.js';
import { ARR_TYPES, SCALAR_NUM, splitLines, splitRow, pickTimeFmt } from './shared.js';

export const PACK_KIND = 'widgets';
export const PACK_VERSION = 1;

/* ══════════ 内置控件类型快照 ══════════
   defs/index.js 加载完会调 markBuiltins()。规矩：**控件包不许覆盖内置类型** ——
   包里带一个 type:'button' 的定义，那就是有人想用假按钮顶掉真按钮，一律拒绝并说明。 */
const BUILTIN = new Set();
export function markBuiltins() { registry.list().forEach(d => BUILTIN.add(d.type)); }
export function isBuiltin(type) { return BUILTIN.has(type); }
export function builtinTypes() { return [...BUILTIN]; }

/* ══════════ 渲染函数能用的 helper 白名单 ══════════
   就是内置控件文件里 import 的那一批。名字必须和 defs/*.js 里的写法一致。 */
export const HELPER_NAMES = [
  'rutil', 'fmtValue', 'escapeHtml', 'varValue', 'stateVarOf',
  'numberFmtOf', 'compareVal', 'parseOptions', 'optionIndexByValue', 'comboMode',
  'contrastTextOn', 'fmtTime', 'fmtDate', 'dayStart', 'isArrayType', 'TIME_PRESETS',
  'ARR_TYPES', 'SCALAR_NUM', 'splitLines', 'splitRow', 'pickTimeFmt',
  // 报警类：由 defs/alarmShared.js 加载时补进来（那边已经 import 了 runtime/alarms.js，
  // 这里**不能**直接 import —— project.js → pack.js → alarms.js → project.js 会绕成环）
  'activeAlarms', 'alarmHistory', 'historyOfDay', 'alarmHistoryDay', 'levelOf', 'esc',
];

const HOLDER = {
  rutil, fmtValue, escapeHtml, numberFmtOf, compareVal, parseOptions, optionIndexByValue,
  comboMode, contrastTextOn, fmtTime, fmtDate, dayStart, isArrayType, TIME_PRESETS,
  ARR_TYPES, SCALAR_NUM, splitLines, splitRow, pickTimeFmt,
  // rutil 上挂着的两个（内置控件是 `const { varValue, stateVarOf } = rutil;` 解构出来的）
  varValue: rutil.varValue, stateVarOf: rutil.stateVarOf,
};
/** 别的模块补 helper 进白名单（见 defs/alarmShared.js 末尾） */
export function setExtraHelpers(obj) { Object.assign(HOLDER, obj); }
export function missingHelpers() { return HELPER_NAMES.filter(n => typeof HOLDER[n] === 'undefined'); }

/* ══════════ 定义 ⇄ 包 ══════════ */

/** 打包一个控件定义的 CSS：从已加载的样式表里挑**选择器里带 .wd-<type> / .w-<type>** 的规则。
 *  约定：控件自己的类名用 `.wd-<type>`（注册表自动加）或 `.w-<type>`（自己写的），
 *  这样导出时不用作者额外声明，样式就跟着包走。 */
export function cssOfType(type) {
  const hit = new RegExp(`\\.(?:wd|w)-${type.replace(/[^\w-]/g, '')}\\b`);
  const out = [];
  let sheets = [];
  try { sheets = [...document.styleSheets]; } catch { return ''; }
  for (const sh of sheets) {
    let rules = null;
    try { rules = sh.cssRules; } catch { continue; }        // 跨域表读不了就跳过
    if (!rules) continue;
    for (const r of rules) {
      try {
        if (r.selectorText && hit.test(r.selectorText)) out.push(r.cssText);
        else if (r.cssRules) {                              // @media 这类，进去再找一层
          for (const inner of r.cssRules) {
            if (inner.selectorText && hit.test(inner.selectorText)) out.push(`${r.conditionText ? `@media ${r.conditionText}` : ''}{${inner.cssText}}`);
          }
        }
      } catch { /* 个别规则读不动就跳 */ }
    }
  }
  return out.join('\n');
}

/** 控件定义 → 包里的 defs 条目（render 存源码文本） */
export function defToPack(def, { withCss = true } = {}) {
  const jsonable = (v) => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return null; } };
  return {
    type: def.type,
    title: def.title || def.type,
    sub: def.sub || '',
    icon: def.icon || '',
    hidden: !!def.hidden,
    defaultBind: !!def.defaultBind,
    selfDrawn: !!def.selfDrawn,
    defaults: jsonable(def.defaults) || {},
    props: jsonable(def.props) || [],
    binding: jsonable(def.binding) || {},
    actions: Array.isArray(def.actions) ? def.actions.slice() : [],
    // render 源码：**重建出来的函数优先用存下来的原文**（_packSrc），
    // 否则 `String(fn)` 会变成 `function render(...)` —— 再存一轮就多一层前缀，往返不收敛。
    renderSrc: def.render?._packSrc || String(def.render || ''),
    ...(withCss ? { css: cssOfType(def.type) } : {}),
  };
}

/**
 * 把 render 源码文本重建成函数。
 * 支持 `render(w, mode, vars) { ... }` 这种**方法简写**（Function.prototype.toString 的原样输出），
 * 也支持 `function (w) {...}` / 箭头函数。形参个数超过 6 个或语法有问题 → 抛错（由调用方报给人看）。
 */
export function reviveRender(renderSrc, type = '?') {
  const src = String(renderSrc || '').trim();
  if (!src) throw new Error(`「${type}」没有 render 源码`);
  // 方法简写 / 普通函数：抓第一对括号（形参）和后面那对大括号（函数体）
  const m = /^\s*(?:function\s*)?[A-Za-z_$]*\s*\(([^)]*)\)\s*\{([\s\S]*)\}\s*$/.exec(src);
  if (!m) throw new Error(`「${type}」的 render 源码认不出来（不是函数写法？）`);
  const params = m[1].split(',').map(s => s.trim()).filter(Boolean);
  if (params.length > 6) throw new Error(`「${type}」的 render 形参太多（${params.length} 个）`);
  const bad = params.find(p => !/^[A-Za-z_$][\w$]*$/.test(p));
  if (bad) throw new Error(`「${type}」的 render 形参不合法：${bad}`);
  const names = HELPER_NAMES.filter(n => typeof HOLDER[n] !== 'undefined');
  const args = names.map(n => HOLDER[n]);
  try {
    // ⚠ 正确写法是"**工厂**"：用 helper 当工厂的形参，工厂返回一个闭包（render 本体）。
    //   写成 `new Function(...names, ...params, body)(...args)` 是错的 —— 那样等于
    //   当场把 render 执行了，而 w/mode/vars 还没传进来（渲染时读 w.props 直接抛）。
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, `return function render(${params.join(', ')}) {\n${m[2]}\n};`);
    const fn = factory(...args);
    fn._packSrc = src;                 // 留着给"导出时再存一份源码"用（不用再 toString 兜底）
    return fn;
  } catch (e) {
    throw new Error(`「${type}」的 render 重建失败：${e.message}`);
  }
}

/** 包里的 defs 条目 → 可注册的 def（会校验必需字段） */
export function packToDef(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('定义条目不是对象');
  const type = String(entry.type || '').trim();
  if (!/^[A-Za-z_$][\w$-]*$/.test(type)) throw new Error(`控件类型名不合法：${JSON.stringify(entry.type)}`);
  if (isBuiltin(type)) throw new Error(`「${type}」和内置控件重名 —— 控件包不许覆盖内置控件`);
  const render = reviveRender(entry.renderSrc, type);
  return {
    type,
    title: String(entry.title || type),
    sub: String(entry.sub || ''),
    icon: String(entry.icon || ''),
    hidden: !!entry.hidden,
    defaultBind: !!entry.defaultBind,
    selfDrawn: !!entry.selfDrawn,
    defaults: (entry.defaults && typeof entry.defaults === 'object') ? deepClone(entry.defaults) : {},
    props: Array.isArray(entry.props) ? deepClone(entry.props) : [],
    binding: (entry.binding && typeof entry.binding === 'object') ? deepClone(entry.binding) : {},
    actions: Array.isArray(entry.actions) ? entry.actions.slice() : [],
    render,
    // 记一下这个控件是"导进来的"，界面上可以标出来
    _fromPack: true,
  };
}

/** 注入一个自定义控件的 CSS（同 type 重复导入就替换） */
export function injectDefCss(type, css) {
  const id = `wd-css-${type}`;
  let el = document.getElementById(id);
  if (!css || !String(css).trim()) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    el.dataset.defCss = type;
    document.head.appendChild(el);
  }
  el.textContent = String(css);
}

/** 注册一个自定义控件定义（含 CSS）。重复导入同 type 视为"升级"，直接覆盖。 */
export function registerCustomDef(entry) {
  const def = packToDef(entry);
  register(def);
  injectDefCss(def.type, entry.css);
  return def;
}

/**
 * 给一个定义做**渲染冒烟测试**：用默认属性 + 假变量值把 render 跑一遍。
 *
 * 为什么必须有：`new Function` 只检查语法，**不检查里面引用的名字存不存在** ——
 * 别人 render 里写了我们没注入的 helper（或者打错字），语法完全合法，
 * 注册也"成功"，等现场把控件画到画布上才发现那块是空白，还看不出为什么。
 * 所以导入时先自己渲染一次：跑不起来当场拒掉，并把人话原因报出来。
 */
export function smokeTestDef(def) {
  const { w: dw, h: dh, ...propDefs } = def.defaults || {};
  const vals = new Map([['vDummy', 12], ['vDummy2', 3.5], ['vDummy3', true], ['sDummy', 'abc']]);
  const vars = { get: (n) => vals.get(n), has: (n) => vals.has(n) };
  for (const mode of ['edit', 'run']) {
    const w = {
      id: 'wSmoke', type: def.type, name: 'smoke',
      x: 0, y: 0, w: dw ?? 100, h: dh ?? 40, z: 1,
      props: deepClone(propDefs),
      bindings: { variable: 'vDummy', variables: ['vDummy', 'vDummy2'] },
      actions: [],
    };
    try {
      const html = def.render(w, mode, vars);
      if (typeof html !== 'string') throw new Error(`render 返回的不是字符串（${typeof html}）`);
    } catch (e) {
      throw new Error(`${mode === 'edit' ? '编辑态' : '运行态'}渲染跑不起来：${e.message}`);
    }
  }
}

/** 注册一个自定义控件定义并冒烟测试；不过关就抛错（注册表回滚成"没这个控件"） */
export function registerCustomDefChecked(entry) {
  const before = registry.get(entry?.type);
  const def = registerCustomDef(entry);
  try {
    smokeTestDef(def);
  } catch (e) {
    // 跑不起来就别留着这个半成品定义（留着的话画布上是一块渲染异常的空白）
    if (before) register(before); else unregister(def.type);
    throw e;
  }
  return def;
}

/** 把一个包里的 defs 全部注册（含渲染冒烟测试）；逐条报错，不因为一条坏的就整包失败 */
export function registerPackDefs(defs) {
  const added = [], failed = [], skipped = [];
  for (const entry of (defs || [])) {
    try {
      if (isBuiltin(entry?.type)) { skipped.push(entry.type); continue; }
      registerCustomDefChecked(entry);
      added.push(entry.type);
    } catch (e) {
      failed.push(`${entry?.type || '?'}：${e.message}`);
    }
  }
  return { added, failed, skipped };
}

/** 启动/读工程时，把工程里带的自定义控件定义恢复进注册表
 *  （normalize 调用；**任何一条坏掉都不能让整份工程打不开**，所以逐条 try）*/
export function registerProjectDefs(list) {
  const out = { added: [], failed: [] };
  for (const entry of (Array.isArray(list) ? list : [])) {
    try {
      if (isBuiltin(entry?.type)) continue;
      if (registry.get(entry?.type)) continue;         // 已经注册过（同一次会话里换了份工程）
      registerCustomDef(entry);
      out.added.push(entry.type);
    } catch (e) {
      out.failed.push(`${entry?.type || '?'}：${e.message}`);
    }
  }
  return out;
}

/** 这个工程里有哪些"非内置"的控件定义（= 要跟着工程/包一起走的那些） */
export function customTypesInProject(customWidgets) {
  return (Array.isArray(customWidgets) ? customWidgets : []).map(d => d?.type).filter(Boolean);
}
