/**
 * jsHighlight.js — 极简 JS 语法高亮（给脚本编辑器用，零依赖）
 *
 * 为什么不引第三方编辑器（CodeMirror/Monaco）：
 *   这是个零依赖的本地工具，为了高亮塞一个几百 KB 的编辑器不划算，
 *   而且它自带的主题/快捷键/滚动容器都得跟现有界面再对齐一遍。
 *
 * 做法：单遍字符扫描（不用正则，正则很容易在字符串/注释里翻车）→ 包成带 class 的 span，
 * 输出交给编辑器里 textarea **下面那一层** <pre> 显示；textarea 文字设成透明、光标自己可见，
 * 于是既有原生的输入/选择/撤销/输入法，又有高亮。
 *
 * 扫出来的类别（跟 css/script.css 里的 .se-hl 配色对应）：
 *   cm 注释 · str 字符串 · tpl 模板字符串 · num 数字 · kw 关键字 · bool 字面量
 *   bi 内置对象 · fn 函数调用 · api hmi.xxx 的成员 · id 普通标识符 · op 运算符/标点
 */
const KEYWORDS = new Set([
  'let', 'const', 'var', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'return',
  'function', 'new', 'typeof', 'instanceof', 'in', 'of', 'switch', 'case', 'default', 'try',
  'catch', 'finally', 'throw', 'class', 'extends', 'super', 'this', 'delete', 'void', 'yield',
  'await', 'async', 'static', 'get', 'set', 'import', 'export', 'from', 'as',
]);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const BUILTINS = new Set([
  'Math', 'JSON', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'RegExp', 'Map',
  'Set', 'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'console', 'window', 'document',
]);
/** 脚本 API 的对象名：hmi.get / hmi.set … 高亮成一组 */
const API_OBJ = 'hmi';

const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;
const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdent = (c) => isIdentStart(c) || isDigit(c);

/**
 * @param {string} code
 * @returns {string} HTML（已转义）
 */
export function highlightJS(code) {
  const src = String(code ?? '');
  let out = '';
  let i = 0;
  const n = src.length;
  let prevWord = '';        // 上一个标识符（用来判断 hmi.xxx）
  let expectMember = false; // 上一个有效字符是 '.' 且它的对象是 hmi

  while (i < n) {
    const c = src[i];

    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out += span('cm', src.slice(i, end));
      i = end;
      continue;
    }
    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out += span('cm', src.slice(i, end));
      i = end;
      prevWord = '';
      expectMember = false;
      continue;
    }
    // 字符串（单双引号，带转义）
    if (c === '"' || c === '\'') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(n, j + 1);
      out += span('str', src.slice(i, j));
      i = j;
      prevWord = '';
      expectMember = false;
      continue;
    }
    // 模板字符串：整段高亮（里面的 ${} 也一并当模板内容，够用且不会翻车）
    if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(n, j + 1);
      out += span('tpl', src.slice(i, j));
      i = j;
      prevWord = '';
      expectMember = false;
      continue;
    }
    // 数字（含 0x / 小数 / 指数 / 下划线分隔）
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB._eE+-]/.test(src[j])) {
        // 指数后的正负号只吃一次，避免把 "1+2" 里的 + 吞掉
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1] || '')) break;
        j++;
      }
      out += span('num', src.slice(i, j));
      i = j;
      prevWord = '';
      expectMember = false;
      continue;
    }
    // 标识符 / 关键字
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      const after = src.slice(j).match(/^\s*\(/);           // 后面紧跟 ( → 当函数调用
      let cls;
      if (word === API_OBJ) cls = 'apiobj';
      else if (expectMember && prevWord === API_OBJ) cls = 'api';
      else if (KEYWORDS.has(word)) cls = 'kw';
      else if (LITERALS.has(word)) cls = 'bool';
      else if (BUILTINS.has(word)) cls = 'bi';
      else if (after) cls = 'fn';
      else cls = 'id';
      out += span(cls, word);
      prevWord = word;
      i = j;
      expectMember = false;
      continue;
    }
    // 点号：记住「前面是 hmi」→ 下一个标识符是 API 成员
    if (c === '.') {
      expectMember = prevWord === API_OBJ;
      out += span('op', c);
      i++;
      continue;
    }
    // 其它：运算符/标点（连续的同色，少几个标签）
    {
      let j = i;
      while (j < n && !isIdentStart(src[j]) && !isDigit(src[j])
             && !'`\'"/'.includes(src[j]) && !(src[j] === '/' && (src[j + 1] === '/' || src[j + 1] === '*'))) j++;
      if (src[j] === '.' || isIdentStart(src[j])) { /* 交给下一轮 */ }
      out += span('op', src.slice(i, Math.max(j, i + 1)));
      i = Math.max(j, i + 1);
      expectMember = false;
    }
  }
  return out;
}
