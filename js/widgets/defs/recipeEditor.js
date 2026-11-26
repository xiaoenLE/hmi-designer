/** 画面内的配方表格。参数按行排列，草稿与保存按配方列处理。 */
import { register } from '../registry.js';
import { project } from '../../core/project.js';
import { bus } from '../../core/eventBus.js';
import { escapeHtml } from '../../core/utils.js';
import { tr, trFormat } from '../../core/i18n.js';
import { captureRecipeValues, field, inputFor, parseField, recipeUrl, recipesChanged, recipeValueTexts } from '../../core/recipeValues.js';

const COLS = 6;
const ROWS = 40;
const pending = new WeakMap();
const label = text => escapeHtml(tr(text));

bus.on('perm:changed', () => {
  document.querySelectorAll('#runtimeRoot .wd-recipeEditor').forEach(el =>
    el.dispatchEvent(new Event('recipes:permission')));
});

function renderRecipeEditor(w, mode) {
  const size = Math.max(9, Math.min(30, Number(w.props.fontSize) || 14));
  const preview = mode === 'edit';
  const inputMode = w.props.useKeyboard === false ? '' : ' inputmode="none"';
  const rows = project.data ? project.recipeVariables().slice(0, 4) : [];
  const definitions = rows.length ? rows : [{ name: '目标速度' }, { name: '温度设定' }];
  return `<section class="w-recipe-editor" style="font-size:${size}px">
    <header class="rg-toolbar">
      <strong>${label(w.props.title || '配方数据编辑')}</strong>
      <button type="button" class="rg-primary" data-rg="new"${preview ? ' disabled' : ''}>${label('新建配方')}</button>
      <button type="button" data-rg="refresh"${preview ? ' disabled' : ''}>${label('刷新')}</button>
      <input type="search" data-rg-filter aria-label="${label('筛选配方变量')}" placeholder="${label('变量名或地址')}"${inputMode}${preview ? ' disabled' : ''}>
    </header>
    <div class="rg-scroll" tabindex="0" aria-label="${label('配方表格滚动区')}">
      <table class="rg-table" aria-label="${label('配方数据')}">
        <thead><tr><th scope="col">${label('变量')}</th>${preview ? `<th scope="col">${label('配方 A')}</th><th scope="col">${label('配方 B')}</th>` : ''}</tr></thead>
        <tbody>${preview ? definitions.map((v, i) => `<tr><th scope="row">${escapeHtml(v.name)}</th><td>${i + 10}</td><td>${i + 20}</td></tr>`).join('') : ''}</tbody>
      </table>
    </div>
    <footer class="rg-footer">
      <span data-rg-pages="columns" hidden>
        <button type="button" data-rg="prev-col" aria-label="${label('上一组配方')}">‹</button>
        <span data-rg-count="columns"></span>
        <button type="button" data-rg="next-col" aria-label="${label('下一组配方')}">›</button>
      </span>
      <span data-rg-pages="rows" hidden>
        <button type="button" data-rg="prev-row" aria-label="${label('上一页变量')}">‹</button>
        <span data-rg-count="rows"></span>
        <button type="button" data-rg="next-row" aria-label="${label('下一页变量')}">›</button>
      </span>
      <span role="status" data-rg-status></span>
    </footer>
  </section>`;
}

function attachRecipeEditor(el, widget, api) {
  const root = el.querySelector('.w-recipe-editor');
  const q = s => root.querySelector(s);
  const filter = q('[data-rg-filter]');
  const scroller = q('.rg-scroll');
  const status = q('[data-rg-status]');
  const definitions = project.recipeVariables();
  const useKeyboard = widget.props.useKeyboard !== false;
  const configured = new Set(definitions.map(v => v.name));
  const byName = new Map(definitions.map(v => [v.name, v]));
  const names = definitions.map(v => v.name);
  if (!pending.has(widget)) pending.set(widget, { drafts: new Map(), fresh: null });
  const local = pending.get(widget);
  const drafts = local.drafts;
  let storedNames = [], columns = [];
  let columnPage = 0, rowPage = 0, rowPages = 1, colPages = 1;
  let busy = false, queued = false, reveal = '', attempted = null;
  const isCurrent = () => el.isConnected && !el.closest('#runtimeRoot')?.classList.contains('hidden');
  const control = (action, text, title) => `<button type="button" data-rg="${action}"${title ? ` aria-label="${escapeHtml(title)}"` : ''}>${label(text)}</button>`;
  const show = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  const entry = (col, v) => col.edits.get(v.name) ?? field(v.type, Object.hasOwn(col.recipe.vars, v.name) ? col.recipe.vars[v.name] : undefined).text;
  const column = name => drafts.get(name) || columns.find(col => col.recipe.name === name);

  function paint() {
    const allowed = api.canOperate();
    const visible = local.fresh ? [local.fresh, ...columns] : columns;
    const needle = filter.value.trim().toLowerCase();
    const found = definitions.filter(v => (v.name + ' ' + (v.address || '')).toLowerCase().includes(needle));
    rowPages = Math.max(1, Math.ceil(found.length / ROWS));
    rowPage = Math.max(0, Math.min(rowPage, rowPages - 1));
    const vars = found.slice(rowPage * ROWS, (rowPage + 1) * ROWS);
    q('[data-rg="new"]').disabled = !definitions.length || !!local.fresh;
    q('thead tr').innerHTML = `<th scope="col" class="rg-variable">${label('变量')}</th>` + visible.map(col => {
      const isNew = col === local.fresh;
      const name = col.recipe.name;
      const heading = isNew ? `<input data-rg-name type="text" maxlength="100" aria-label="${label('新配方名称')}"
        placeholder="${label('配方名称')}" value="${escapeHtml(col.title)}"${useKeyboard ? ' inputmode="none"' : ''}${allowed ? '' : ' readonly'}>` : `<strong>${escapeHtml(name)}</strong>`;
      return `<th scope="col" data-rg-col="${escapeHtml(name)}">${heading}
        <span class="rg-dirty" data-rg-dirty hidden>${label('未保存')}</span>
        <div class="rg-actions">
          ${definitions.length ? control('save', '保存', isNew ? tr('保存新配方') : trFormat('保存 {name}', { name })) : ''}
          ${definitions.length ? control('read', '读当前值', trFormat('读取当前值 {name}', { name: name || tr('新配方') })) : ''}
          ${!isNew && definitions.length && !local.fresh ? control('copy', '另存', trFormat('另存 {name}', { name })) : ''}
          ${isNew ? control('discard', '取消', tr('取消新配方')) : control('discard', '重读', trFormat('重读 {name}', { name }))}
          ${!isNew && widget.props.allowDelete === true ? control('delete', '删除', trFormat('删除 {name}', { name })) : ''}
        </div></th>`;
    }).join('');
    const empty = !names.length ? '请在工程 → 配方地址配置中勾选要保存的变量。'
      : !visible.length ? '还没有配方，点「新建配方」添加一列。' : '没有匹配的变量';
    q('tbody').innerHTML = vars.length && visible.length ? vars.map(v =>
      `<tr><th scope="row" class="rg-variable" title="${escapeHtml(v.address || '')}">${escapeHtml(v.name)}</th>${visible.map(col => {
        const name = col.recipe.name;
        const inputLabel = v.name + ' · ' + (name || tr('新配方'));
        const text = entry(col, v);
        const value = field(v.type, undefined);
        value.text = text;
        return `<td data-rg-col="${escapeHtml(name)}">${allowed ? inputFor(v.name, value, inputLabel, useKeyboard)
          : `<button type="button" class="rg-locked-cell" data-rg="unlock" data-rg-var="${escapeHtml(v.name)}"
            aria-label="${escapeHtml(inputLabel)}">${escapeHtml(text === '' ? '—' : text)}</button>`}</td>`;
      }).join('')}</tr>`).join('') : `<tr><td class="rg-empty" colspan="${visible.length + 1}">${label(empty)}</td></tr>`;
    for (const [key, index, total, suffix, text] of [
      ['columns', columnPage, colPages, 'col', '{page} / {total} 组配方'],
      ['rows', rowPage, rowPages, 'row', '{page} / {total} 页变量'],
    ]) {
      q(`[data-rg-pages="${key}"]`).hidden = total === 1;
      q(`[data-rg-count="${key}"]`).textContent = trFormat(text, { page: index + 1, total });
      q(`[data-rg="prev-${suffix}"]`).disabled = index === 0;
      q(`[data-rg="next-${suffix}"]`).disabled = index === total - 1;
    }
    q('.rg-footer').hidden = !status.textContent && colPages === 1 && rowPages === 1;
    updateHeaders();
  }

  function updateHeaders() {
    for (const head of root.querySelectorAll('thead [data-rg-col]')) {
      const name = head.dataset.rgCol;
      const col = name ? column(name) : local.fresh;
      head.querySelector('[data-rg-dirty]').hidden = !!name && !drafts.has(name);
      const save = head.querySelector('[data-rg="save"]');
      if (save) save.disabled = name ? !drafts.has(name) && names.length === Object.keys(col.recipe.vars).length
        && names.every(key => Object.hasOwn(col.recipe.vars, key)) : !col.title.trim();
      head.querySelector('[data-rg="discard"]').hidden = !!name && !drafts.has(name);
    }
  }

  async function load() {
    const result = await api.rpc('/api/recipes', { method: 'GET' });
    storedNames = [...new Set([...result.names, ...drafts.keys()])];
    colPages = Math.max(1, Math.ceil(storedNames.length / COLS));
    if (reveal && storedNames.includes(reveal)) columnPage = Math.floor(storedNames.indexOf(reveal) / COLS);
    reveal = '';
    columnPage = Math.max(0, Math.min(columnPage, colPages - 1));
    const display = storedNames.slice(columnPage * COLS, (columnPage + 1) * COLS);
    columns = (await Promise.all(display.map(async name => {
      if (drafts.has(name)) return drafts.get(name);
      try {
        const { recipe } = await api.rpc(recipeUrl(name), { method: 'GET' });
        return { recipe, edits: new Map() };
      } catch (e) {
        if (e.status !== 404) throw e;
        return null;
      }
    }))).filter(Boolean);
  }

  async function task(fn, clear = true) {
    if (busy || !isCurrent()) return;
    busy = true;
    scroller.inert = true;
    if (clear) show('');
    try { await fn(); }
    catch (error) { show(tr(error.message || String(error)), true); }
    finally {
      busy = false;
      scroller.inert = false;
      if (isCurrent()) {
        paint();
        if (queued) { queued = false; refreshFromChange(); }
      }
    }
  }

  function refreshFromChange() {
    if (!isCurrent()) return;
    if (busy || api.fieldPadOpen() || scroller.contains(document.activeElement)) { queued = true; return; }
    queued = false;
    task(load, false);
  }

  function begin(col) {
    if (local.fresh || !definitions.length || !api.allowed()) return;
    local.fresh = {
      recipe: { name: '', vars: {} },
      edits: col ? new Map(definitions.map(v => [v.name, entry(col, v)])) : new Map(),
      title: col ? col.recipe.name.slice(0, 96) + ' 副本' : '',
    };
    show('');
    paint();
    scroller.scrollLeft = 0;
    q('[data-rg-name]').focus();
  }

  async function save(col) {
    const existing = col.recipe.name;
    const name = existing || col.title.trim();
    if (!name) throw new Error('请填写配方名称');
    const vars = Object.fromEntries(definitions.map(v => [v.name, parseField(v.name, {
      ...field(v.type, undefined), text: entry(col, v),
    })]));
    if (existing) {
      const excluded = Object.keys(col.recipe.vars).filter(key => !configured.has(key));
      if (excluded.length && !confirm(trFormat('保存后将移除不在工程配置中的参数：{variables}。确定保存？', {
        variables: excluded.slice(0, 8).join('、') + (excluded.length > 8 ? tr('等') : ''),
      }))) return;
    }
    if (!await api.authorizeRecipe('保存配方')) return;
    await api.rpc('/api/recipes', { body: { action: 'save', name, vars, revision: col.recipe.revision, create_only: !existing } });
    if (existing) drafts.delete(existing);
    else { local.fresh = null; reveal = name; }
    show(trFormat('已保存「{name}」', { name }));
    recipesChanged();
  }

  async function readCurrent(col) {
    const name = col.recipe.name;
    if ((name || col.edits.size) && !confirm(tr('将当前变量值填入这一列？'))) return;
    if (!await api.authorizeRecipe('读取配方当前值')) return;
    const values = await captureRecipeValues(api.rpc, names);
    col.edits = new Map(definitions.map(v => [v.name, field(v.type, values[v.name]).text]));
    if (name) drafts.set(name, col);
    show(trFormat('已读取 {count} 项当前值', { count: names.length }));
  }

  async function discard(col) {
    const name = col.recipe.name;
    if ((name || col.title || col.edits.size) && !confirm(tr('放弃这一列未保存的修改？'))) return;
    if (name) { drafts.delete(name); await load(); }
    else local.fresh = null;
  }

  async function remove(col) {
    const { name, revision } = col.recipe;
    if (!confirm(trFormat('确定删除配方「{name}」？', { name })) || !await api.authorizeRecipe('删除配方')) return;
    await api.rpc('/api/recipes', { body: { action: 'delete', name, revision } });
    drafts.delete(name);
    show(trFormat('已删除「{name}」', { name }));
    recipesChanged();
  }

  el.addEventListener('recipes:refresh', refreshFromChange);
  el.addEventListener('runtime:fieldpadclose', () => { if (queued) refreshFromChange(); });
  el.addEventListener('focusout', () => { if (queued) queueMicrotask(refreshFromChange); });
  el.addEventListener('recipes:permission', () => {
    if (!isCurrent()) return;
    paint();
    if (attempted && api.canOperate()) {
      const { name, variable } = attempted;
      const cell = [...q('tbody').querySelectorAll('[data-rg-value]')].find(input =>
        input.dataset.rgValue === variable && input.closest('[data-rg-col]').dataset.rgCol === name);
      cell?.focus();
    }
    attempted = null;
  });
  filter.addEventListener('input', () => { rowPage = 0; scroller.scrollTop = 0; paint(); });
  el.addEventListener('input', e => {
    if (!e.target.matches('[data-rg-value], [data-rg-name]')) return;
    if (!api.canOperate()) { paint(); return; }
    const name = e.target.closest('[data-rg-col]').dataset.rgCol;
    const col = name ? column(name) : local.fresh;
    if (e.target.matches('[data-rg-name]')) col.title = e.target.value;
    else {
      const key = e.target.dataset.rgValue;
      const base = field(byName.get(key).type, Object.hasOwn(col.recipe.vars, key) ? col.recipe.vars[key] : undefined).text;
      if (base === e.target.value) col.edits.delete(key);
      else col.edits.set(key, e.target.value);
      if (name && col.edits.size) drafts.set(name, col);
      else if (name) drafts.delete(name);
    }
    updateHeaders();
  });
  el.addEventListener('click', e => {
    const input = e.target.closest('input[data-rg-filter], input[data-rg-name], input[data-rg-value], textarea[data-rg-value]');
    if (input && !busy) api.editField(input, { filter: input === filter });
    const btn = e.target.closest('[data-rg]');
    if (!btn || busy || btn.disabled) return;
    const name = btn.closest('[data-rg-col]')?.dataset.rgCol;
    const col = name ? column(name) : local.fresh;
    switch (btn.dataset.rg) {
      case 'new': begin(null); break;
      case 'copy': if (col) begin(col); break;
      case 'unlock':
        attempted = { name, variable: btn.dataset.rgVar };
        if (api.allowed()) el.dispatchEvent(new Event('recipes:permission'));
        break;
      case 'save': if (col && api.allowed()) task(() => save(col)); break;
      case 'read': if (col && api.allowed()) task(() => readCurrent(col)); break;
      case 'delete': if (name && api.allowed()) task(() => remove(col)); break;
      case 'discard': if (col && api.allowed()) task(() => discard(col)); break;
      case 'refresh': task(load); break;
      case 'prev-col': columnPage--; scroller.scrollLeft = 0; task(load); break;
      case 'next-col': columnPage++; scroller.scrollLeft = 0; task(load); break;
      case 'prev-row': rowPage--; scroller.scrollTop = 0; paint(); break;
      case 'next-row': rowPage++; scroller.scrollTop = 0; paint(); break;
    }
  });
  show(tr('正在读取配方…'));
  queueMicrotask(() => task(async () => { await load(); show(''); }, false));
}

register({
  type: 'recipeEditor',
  title: '配方数据编辑',
  sub: '每列一套配方，直接修改保存值',
  i18nTexts: [
    '配方数据编辑', '新建配方', '刷新', '筛选配方变量', '变量名或地址', '配方表格滚动区',
    '配方数据', '变量', '配方 A', '配方 B', '上一组配方', '下一组配方', '上一页变量', '下一页变量',
    '新配方名称', '配方名称', '未保存', '保存', '保存新配方', '保存 {name}', '读当前值',
    '读取当前值 {name}', '新配方', '另存', '另存 {name}', '取消', '取消新配方',
    '重读', '重读 {name}', '删除', '删除 {name}', '{page} / {total} 组配方', '{page} / {total} 页变量',
    '请在工程 → 配方地址配置中勾选要保存的变量。', '还没有配方，点「新建配方」添加一列。',
    '没有匹配的变量', '请填写配方名称', '保存后将移除不在工程配置中的参数：{variables}。确定保存？',
    '等', '已保存「{name}」', '将当前变量值填入这一列？', '已读取 {count} 项当前值',
    '放弃这一列未保存的修改？', '确定删除配方「{name}」？', '已删除「{name}」',
    '正在读取配方…', ...recipeValueTexts,
  ],
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="6" width="26" height="24" rx="3" fill="#fff" stroke="#94a3b8"/><path d="M6 13h24M6 21h24M15 7v22M23 7v22" stroke="#9bb2cd" stroke-width="1.5"/><path d="m23 28 1-4 6-6 3 3-6 6z" fill="#2563eb"/></svg>',
  defaults: { w: 680, h: 310, title: '配方数据编辑', fontSize: 14, allowDelete: false, useKeyboard: true },
  props: [
    { key: 'title', label: '标题', type: 'text', i18n: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 9, max: 30 },
    { key: 'useKeyboard', label: '软键盘输入', type: 'check', defVal: true },
    { key: 'allowDelete', label: '允许删除配方', type: 'check', defVal: false },
  ],
  binding: null,
  actions: [],
  selfDrawn: true,
  render: renderRecipeEditor,
  attach: attachRecipeEditor,
});
