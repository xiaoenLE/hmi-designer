/** 配方值输入和存档请求共用的格式处理。 */
import { escapeHtml } from './utils.js';
import { tr, trFormat } from './i18n.js';
import { bus } from './eventBus.js';

export const recipeUrl = name => '/api/recipes?name=' + encodeURIComponent(name);
export const viewValue = value => value == null ? '—' : (Array.isArray(value) ? JSON.stringify(value) : String(value));

bus.on('recipes:changed', () => {
  document.querySelectorAll('#runtimeRoot :is(.wd-recipe, .wd-recipeEditor)').forEach(el =>
    el.dispatchEvent(new Event('recipes:refresh')));
});

export function recipesChanged() {
  bus.emit('recipes:changed');
}

export const recipeCaptureError = '未读到 {count} 项当前值：{variables}。请检查变量或设备连接后重试。';
export const recipeValueTexts = [
  recipeCaptureError, '请选择', '开', '关', '请填写 JSON 数组，例如 [1, 2, 3]', '请填写数组',
  'BOOL 数组只能填 true、false、0 或 1', '整数数组只能填有效整数', '无符号数组不能填负数',
  '数值数组只能填有效数字', '文本数组的每项都要加双引号',
  '请选择开或关', '请填写有效数字', '请填写整数', '无符号变量不能小于 0',
];

export async function captureRecipeValues(rpc, names) {
  const { values } = await rpc('/api/recipes/current', { body: { names } });
  const missing = names.filter(name => !Object.hasOwn(values, name) || values[name] == null);
  if (missing.length) {
    throw new Error(trFormat(recipeCaptureError, { count: missing.length, variables: missing.slice(0, 5).join('、') }));
  }
  return Object.fromEntries(names.map(name => [name, values[name]]));
}
const INT_TYPES = new Set(['int', 'uint', 'dint', 'udint']);
const fs = (value) => escapeHtml(tr(value));

function recipeBool(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (normalized === true || normalized === 1 || normalized === '1' || normalized === 'true') return true;
  if (normalized === false || normalized === 0 || normalized === '0' || normalized === 'false') return false;
}

export function field(type, value) {
  type = type || (Array.isArray(value) ? 'array' : typeof value === 'boolean' ? 'bool'
    : typeof value === 'number' ? 'real' : 'string');
  const array = type === 'array' || type.endsWith('[]');
  if (type === 'bool') value = recipeBool(value);
  if (type === 'bool[]' && Array.isArray(value)) value = value.map(item => recipeBool(item) ?? item);
  return { type, array, text: value == null ? '' : (array ? JSON.stringify(value) : String(value)) };
}

export function parseField(name, { type, array, text }) {
  const wrong = (hint) => { throw new Error(`${name}：${tr(hint)}`); };
  if (array) {
    let values;
    try { values = JSON.parse(text); } catch { wrong('请填写 JSON 数组，例如 [1, 2, 3]'); }
    if (!Array.isArray(values)) wrong('请填写数组');
    const elem = type.slice(0, -2);
    if (elem === 'bool') {
      values = values.map(recipeBool);
      if (values.some(v => v === undefined)) wrong('BOOL 数组只能填 true、false、0 或 1');
    }
    if (INT_TYPES.has(elem) && values.some(v => !Number.isSafeInteger(v))) wrong('整数数组只能填有效整数');
    if ((elem === 'uint' || elem === 'udint') && values.some(v => v < 0)) wrong('无符号数组不能填负数');
    if (['real', 'lreal'].includes(elem) && values.some(v => !Number.isFinite(v))) wrong('数值数组只能填有效数字');
    if (['string', 'wstring'].includes(elem) && values.some(v => typeof v !== 'string')) wrong('文本数组的每项都要加双引号');
    return values;
  }
  if (type === 'bool') {
    const value = recipeBool(text);
    if (value === undefined) wrong('请选择开或关');
    return value;
  }
  if (INT_TYPES.has(type) || type === 'real' || type === 'lreal') {
    const number = Number(text);
    if (!text.trim() || !Number.isFinite(number)) wrong('请填写有效数字');
    if (INT_TYPES.has(type) && !Number.isSafeInteger(number)) wrong('请填写整数');
    if ((type === 'uint' || type === 'udint') && number < 0) wrong('无符号变量不能小于 0');
    return number;
  }
  return text;
}

export function inputFor(name, entry, label = name, useKeyboard = false) {
  const attr = `data-rg-value="${escapeHtml(name)}" aria-label="${escapeHtml(label)}"`;
  const inputMode = useKeyboard ? ' inputmode="none"' : '';
  const text = escapeHtml(entry.text);
  if (entry.type === 'bool') return `<select ${attr}>
    <option value=""${entry.text === '' ? ' selected' : ''}>${fs('请选择')}</option>
    <option value="true"${entry.text === 'true' ? ' selected' : ''}>${fs('开')} (TRUE)</option>
    <option value="false"${entry.text === 'false' ? ' selected' : ''}>${fs('关')} (FALSE)</option>
  </select>`;
  if (entry.array) return `<textarea rows="2" ${attr}${inputMode} placeholder="[1, 2, 3]">${text}</textarea>`;
  const numeric = INT_TYPES.has(entry.type) || ['real', 'lreal'].includes(entry.type);
  return `<input ${attr}${inputMode} type="${numeric ? 'number' : 'text'}" ${numeric ? 'step="any"' : ''} value="${text}">`;
}

