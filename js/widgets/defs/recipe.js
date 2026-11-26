/** 运行画面里的配方控件。捕获当前值、查看和应用整套参数。 */
import { register, rutil } from '../registry.js';
import { tr, trFormat } from '../../core/i18n.js';
import { project } from '../../core/project.js';
import { captureRecipeValues, recipeCaptureError, recipeUrl, recipesChanged, viewValue } from '../../core/recipeValues.js';

const { escapeHtml } = rutil;
const esc = text => escapeHtml(tr(text));
const states = new WeakMap();
function stateOf(w) {
  if (!states.has(w)) states.set(w, { names: [], recipe: null, query: '', busy: false, msg: '', saving: false, name: '' });
  return states.get(w);
}

function intIn(value, fallback, lo, hi) {
  const n = Math.round(+value);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

function recipeDetails(recipe, query) {
  const needle = query.trim().toLowerCase();
  const variables = Object.entries(recipe.vars);
  const rows = variables.map(([name, value]) => [name, viewValue(value)]).filter(([name, value]) =>
    !needle || name.toLowerCase().includes(needle) || value.toLowerCase().includes(needle));
  return {
    html: rows.map(([name, value]) =>
      `<tr><th scope="row">${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`).join('')
      || `<tr><td class="rc-detail-empty" colspan="2">${esc(variables.length ? '没有匹配的参数' : '这个配方没有数据')}</td></tr>`,
    count: needle ? `${rows.length} / ${variables.length}` : '',
  };
}

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
    return hit;
  };
  const raw = String((w.props && w.props.varsText) || '');
  let skipped = 0;
  raw.split(/\r?\n/).forEach((line) => {
    if (names.length >= VARS_MAX) return;
    const s = line.trim();
    if (!s) return;
    const range = /^(.+?)\[(\d+)\s*\.\.\s*(\d+)\]$/.exec(s);
    let matches;
    if (range) {
      let a = +range[2];
      let b = +range[3];
      if (a > b) { const t = a; a = b; b = t; }         // 起>止 自动交换
      const base = range[1].trim();
      // 闭区间只取**变量表里存在的元素**（数组可能只展开了一部分）
      matches = elementsOf(base).filter(x => x.i >= a && x.i <= b).map(x => x.n);
    } else if (known.has(s)) {
      matches = [s];
    } else {
      matches = elementsOf(s).map(x => x.n);
    }
    // 这一行一个都没解析出来（名字不存在 / 区间里没有元素）→ 跳过并计数
    if (!matches.length) skipped++;
    matches.forEach(add);
  });
  // 兼容老配置：老工程/老编辑面板配的 bindings.variables（非空）追加到末尾
  const legacy = (w.bindings && Array.isArray(w.bindings.variables)) ? w.bindings.variables : [];
  legacy.forEach(n => add(n));
  return { names: names, skipped: skipped };
}

register({
  type: 'recipe',
  title: '配方',
  sub: '保存当前值、查看、应用和删除配方',
  i18nTexts: [
    '配方', '保存当前值', '刷新', '查看', '应用', '收起', '保存', '取消', '删除',
    '配方名称', '操作', '配方详情', '查看配方', '配方参数', '变量名', '保存值',
    '搜索配方参数', '变量名或保存值', '新配方名或已有配方名', '读取中…', '还没有配方',
    '没有匹配的参数', '这个配方没有数据', '请填写配方名称',
    '请在工程 → 配方地址配置中勾选要保存的变量',
    '用当前值覆盖配方「{name}」？', '将移除 {count} 个不在本次保存范围内的旧参数。',
    '确定应用配方「{name}」？', '已保存「{name}」', '已应用 {count} 个',
    '确定删除配方「{name}」？', '已删除「{name}」',
    '已应用 {applied} 个，失败 {failed} 个。', '空变量名', recipeCaptureError,
  ],
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="4" width="26" height="28" rx="3" fill="#fff" stroke="#94a3b8"/><rect x="9" y="8" width="18" height="4" rx="1" fill="#2563eb"/><path d="M9 17h13M9 22h13M9 27h9" stroke="#c3cbd6" stroke-width="2" stroke-linecap="round"/><circle cx="27" cy="24" r="6" fill="#22c55e"/><path d="M24.6 24l1.7 1.7 3.2-3.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
  defaults: {
    w: 360, h: 280, title: '配方', varsText: '', showList: true, showRefresh: true, showSave: true, allowDelete: false, useKeyboard: true,
    rowH: 30, fontSize: 14, textColor: '#1f2329', bgColor: '#ffffff',
    headerBg: '#eef2f7', lineColor: '#c3cbd6', radius: 4,
  },
  props: [
    { key: 'title', label: '标题', type: 'text', i18n: 'text' },
    { key: 'varsText', label: '补充采集变量', type: 'textarea', rows: 6, i18n: false,
      placeholder: '每行一个需要加入画面采集范围的变量或数组范围' },
    { key: 'showList', label: '显示配方列表', type: 'check', defVal: true },
    { key: 'showRefresh', label: '显示刷新', type: 'check', defVal: true },
    { key: 'showSave', label: '显示保存当前值', type: 'check', defVal: true },
    { key: 'allowDelete', label: '允许删除配方', type: 'check', defVal: false },
    { key: 'useKeyboard', label: '软键盘输入', type: 'check', defVal: true },
    { key: 'rowH', label: '行高', type: 'number', min: 18, max: 80 },
    { key: 'fontSize', label: '字号', type: 'number', min: 9, max: 30 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'headerBg', label: '表头底色', type: 'color' },
    { key: 'lineColor', label: '线色', type: 'color' },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 100 },
  ],
  binding: null,
  actions: [],
  scopeVars(w) { return parseRecipeVars(w).names; },
  render(w, mode) {
    const p = w.props || {};
    const edit = mode === 'edit';
    const inputMode = p.useKeyboard === false ? '' : ' inputmode="none"';
    const st = edit ? { names: ['配方 1', '配方 2'], recipe: null, busy: false, msg: '' } : stateOf(w);
    const head = p.headerBg || '#eef2f7';
    const line = p.lineColor || '#c3cbd6';
    const radius = intIn(p.radius, 4, 0, 100);
    const rowH = intIn(p.rowH, 30, 18, 80);
    const style = `height:${Math.max(20, rowH - 6)}px;padding:0 7px;background:#f8fafc;border:1px solid ${line};border-radius:${radius}px;font:inherit;white-space:nowrap;cursor:pointer;`;
    const btn = (action, label, name = '') => `<button type="button" data-rcact="${action}"
      data-rcname="${escapeHtml(name)}"${edit || st.busy ? ' disabled' : ''} style="${style}">${esc(label)}${action === 'delete'
        ? '<span class="rc-delete-lock" aria-hidden="true"> 🔒</span>' : ''}</button>`;
    const cell = `padding:4px 8px;border-bottom:1px solid ${line};text-align:left;overflow-wrap:anywhere;`;
    const headerCell = `style="${cell}background:${head};position:sticky;top:0;white-space:nowrap"`;
    const rows = st.names.map(name => `<tr class="rc-row" data-rcname="${escapeHtml(name)}">
      <th scope="row" style="${cell}">${escapeHtml(name)}</th>
      <td style="${cell}white-space:nowrap;width:1%">${btn('view', '查看', name)} ${btn('apply', '应用', name)}${p.allowDelete === true
        ? ' ' + btn('delete', '删除', name) : ''}</td>
      </tr>`).join('') || `<tr><td colspan="2" style="${cell}text-align:center">${esc(st.busy ? '读取中…' : '还没有配方')}</td></tr>`;
    const list = p.showList === false ? '' : `<div class="rc-list" style="min-height:0;overflow:auto;${st.recipe ? 'max-height:40%;' : 'flex:1;'}">
      <table style="width:100%;border-spacing:0"><thead><tr><th ${headerCell}>${esc('配方名称')}</th><th ${headerCell}>${esc('操作')}</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    const data = st.recipe && recipeDetails(st.recipe, st.query);
    const detail = data ? `<section class="rc-detail" aria-label="${esc('配方详情')}">
      <header class="rc-detail-toolbar">
        <strong class="rc-detail-title">${esc('查看配方')} · ${escapeHtml(st.recipe.name)}</strong>
        <div class="rc-detail-find">
          <input type="search" class="rc-detail-query" aria-label="${esc('搜索配方参数')}"
            placeholder="${esc('变量名或保存值')}" value="${escapeHtml(st.query)}"${inputMode}>
          <span class="rc-detail-count" role="status">${data.count}</span>
        </div>
        ${btn('close', '收起')}
      </header>
      <div class="rc-data-list"><table aria-label="${esc('配方参数')}"><thead><tr>
        <th scope="col">${esc('变量名')}</th><th scope="col">${esc('保存值')}</th></tr></thead><tbody>${data.html}</tbody></table></div>
    </section>` : '';
    return `<div class="w-recipe" style="width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:${p.bgColor || '#fff'};color:${p.textColor || '#1f2329'};font-size:${intIn(p.fontSize, 14, 9, 30)}px;border:1px solid ${line};border-radius:${radius}px;">
      <header class="rc-toolbar" style="background:${head};border-bottom:1px solid ${line}">
        <strong class="rc-title">${esc(p.title || '配方')}</strong>
        ${p.showSave === false ? '' : btn('open-save', '保存当前值')}${p.showRefresh === false ? '' : btn('refresh', '刷新')}</header>
      ${st.saving ? `<form class="rc-save-form">
        <input type="text" maxlength="100" aria-label="${esc('配方名称')}" placeholder="${esc('新配方名或已有配方名')}" value="${escapeHtml(st.name)}"${inputMode}${st.busy ? ' disabled' : ''}>
        <button type="submit" style="${style}"${st.busy ? ' disabled' : ''}>${esc('保存')}</button>
        ${btn('cancel-save', '取消')}</form>` : ''}
      ${list}${detail}${st.msg ? `<div class="rc-msg" role="status" style="max-height:33%;overflow:auto;padding:4px 8px;border-top:1px solid ${line}">${escapeHtml(
        trFormat(st.msg.text, st.msg.values) + (st.msg.detail || ''))}</div>` : ''}</div>`;
  },
  attach(el, w, api) {
    const st = stateOf(w);
    const report = (text, values = {}, detail = '') => { st.msg = { text, values, detail }; };
    const readRecipe = async name => (await api.rpc(recipeUrl(name), { method: 'GET' })).recipe;
    let pendingRefresh = false;
    const current = () => el.isConnected && !el.closest('#runtimeRoot')?.classList.contains('hidden');
    const refresh = () => {
      const selectors = ['.rc-list', '.rc-data-list'];
      const tops = selectors.map(sel => el.querySelector(sel)?.scrollTop || 0);
      const focusedQuery = el.querySelector('.rc-detail-query:focus');
      api.refresh();
      selectors.forEach((sel, i) => {
        const list = el.querySelector(sel);
        if (list) list.scrollTop = tops[i];
      });
      if (focusedQuery) {
        const query = el.querySelector('.rc-detail-query');
        query?.focus({ preventScroll: true });
        query?.setSelectionRange(focusedQuery.selectionStart, focusedQuery.selectionEnd);
      }
    };
    const task = async fn => {
      if (st.busy) return;
      st.busy = true;
      st.msg = '';
      refresh();
      try { await fn(); } catch (error) { report(error.message || String(error)); }
      finally {
        st.busy = false;
        if (current()) {
          refresh();
          if (pendingRefresh && !st.saving) { pendingRefresh = false; load(false); }
        }
      }
    };
    const readList = async () => {
      const result = await api.rpc('/api/recipes', { method: 'GET' });
      st.names = Array.isArray(result.names) ? result.names : [];
      if (st.recipe) st.recipe = st.names.includes(st.recipe.name) ? await readRecipe(st.recipe.name) : null;
    };
    const load = (clear = true) => {
      const message = clear ? '' : st.msg;
      return task(async () => { await readList(); st.msg = message; });
    };

    async function saveCurrent() {
      const name = st.name.trim();
      if (!name) throw new Error('请填写配方名称');
      const names = Array.isArray(project.data.recipeVariables)
        ? project.recipeVariables().map(v => v.name) : parseRecipeVars(w).names;
      if (!names.length) throw new Error('请在工程 → 配方地址配置中勾选要保存的变量');
      if (!await api.authorizeRecipe('保存配方')) return;
      let previous;
      try { previous = await readRecipe(name); }
      catch (e) { if (e.status !== 404) throw e; }
      if (previous) {
        const configured = new Set(names);
        const excluded = Object.keys(previous.vars).filter(key => !configured.has(key));
        const notice = excluded.length ? '\n' + trFormat('将移除 {count} 个不在本次保存范围内的旧参数。', { count: excluded.length }) : '';
        if (!confirm(trFormat('用当前值覆盖配方「{name}」？', { name }) + notice)) return;
      }
      const vars = await captureRecipeValues(api.rpc, names);
      if (!current() || !api.allowed()) return;
      await api.rpc('/api/recipes', {
        body: { action: 'save', name, vars, revision: previous?.revision, create_only: !previous },
      });
      st.saving = false;
      st.name = '';
      report('已保存「{name}」', { name });
      recipesChanged();
    }

    async function deleteRecipe(name) {
      if (!await api.authorizeRecipe('删除配方', 'delete')) return;
      const recipe = st.recipe?.name === name ? st.recipe : await readRecipe(name);
      if (!current() || !confirm(trFormat('确定删除配方「{name}」？', { name })) || !api.allowed('delete')) return;
      await api.rpc('/api/recipes', { body: { action: 'delete', name, revision: recipe.revision } });
      st.names = st.names.filter(item => item !== name);
      if (st.recipe?.name === name) {
        st.recipe = null;
        st.query = '';
      }
      report('已删除「{name}」', { name });
      recipesChanged();
    }

    el.addEventListener('recipes:refresh', () => {
      if (!current()) return;
      if (st.busy || st.saving || api.fieldPadOpen()) pendingRefresh = true;
      else load(false);
    });
    el.addEventListener('runtime:fieldpadclose', () => {
      if (pendingRefresh && !st.busy && !st.saving) { pendingRefresh = false; load(false); }
    });
    el.addEventListener('input', e => {
      if (e.target.closest('.rc-save-form')) st.name = e.target.value;
      if (e.target.matches('.rc-detail-query') && st.recipe) {
        st.query = e.target.value;
        const data = recipeDetails(st.recipe, st.query);
        const list = el.querySelector('.rc-data-list');
        list.querySelector('tbody').innerHTML = data.html;
        list.scrollTop = 0;
        el.querySelector('.rc-detail-count').textContent = data.count;
      }
    });
    el.addEventListener('submit', e => {
      if (!e.target.matches('.rc-save-form')) return;
      e.preventDefault();
      if (w.props.showSave !== false && api.allowed()) task(saveCurrent);
    });
    el.addEventListener('click', e => {
      const input = e.target.closest('.rc-detail-query, .rc-save-form input');
      if (input && !st.busy) api.editField(input, { filter: input.matches('.rc-detail-query') });
      const btn = e.target.closest('button[data-rcact]');
      if (!btn || st.busy) return;
      const name = btn.dataset.rcname;
      switch (btn.dataset.rcact) {
        case 'refresh': load(); break;
        case 'open-save':
          if (w.props.showSave !== false && api.allowed()) {
            st.saving = true;
            refresh();
            el.querySelector('.rc-save-form input').focus();
          }
          break;
        case 'cancel-save':
          st.saving = false;
          st.name = '';
          if (pendingRefresh) { pendingRefresh = false; load(false); }
          else refresh();
          break;
        case 'close':
          st.recipe = null;
          st.query = '';
          refresh();
          break;
        case 'view': task(async () => {
          const recipe = await readRecipe(name);
          if (st.recipe?.name !== recipe.name) st.query = '';
          st.recipe = recipe;
        }); break;
        case 'delete':
          if (w.props.allowDelete === true && w.props.showList !== false) task(() => deleteRecipe(name));
          break;
        case 'apply': task(async () => {
          if (!await api.authorizeRecipe('应用配方')) return;
          const recipe = st.recipe?.name === name ? st.recipe : await readRecipe(name);
          if (!current() || !confirm(trFormat('确定应用配方「{name}」？', { name })) || !api.allowed()) return;
          try {
            const res = await api.rpc('/api/recipes', {
              body: { action: 'apply', name, revision: recipe.revision },
            });
            report('已应用 {count} 个', { count: res.applied.length });
          } catch (error) {
            if (!error.data?.failed?.length) throw error;
            const { applied, failed } = error.data;
            const reasons = failed.slice(0, 3).map(v => `${v.name || tr('空变量名')}：${tr(v.error)}`).join('；');
            report('已应用 {applied} 个，失败 {failed} 个。', { applied: applied.length, failed: failed.length }, reasons);
          }
        }); break;
      }
    });
    load();
  },
});
