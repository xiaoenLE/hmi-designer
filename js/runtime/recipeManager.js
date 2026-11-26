/** 运行菜单中的配方查看与应用页面。 */
import { escapeHtml } from '../core/utils.js';
import { tr } from '../core/i18n.js';
import { recipeUrl, viewValue } from '../core/recipeValues.js';

const fs = value => escapeHtml(tr(value));
function trapTab(e, host) {
  if (e.key !== 'Tab') return;
  const focusable = [...host.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled)')]
    .filter(el => !el.closest('[inert]') && el.getClientRects().length);
  const first = focusable[0], last = focusable[focusable.length - 1];
  if ((e.shiftKey && e.target === first) || (!e.shiftKey && e.target === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

export function openRecipeManager(api) {
  const active = document.getElementById('recipeManager');
  if (active) { active.querySelector('[data-rm="close"]').focus(); return; }
  const under = document.getElementById('runtimeRoot');
  const previousFocus = document.activeElement;
  const wasInert = under.inert;
  const element = document.createElement('section');
  element.id = 'recipeManager';
  element.innerHTML = `
    <div class="rm-shell" role="dialog" aria-modal="true" aria-labelledby="rm-heading">
      <header class="rm-header">
        <h1 id="rm-heading">${fs('配方管理')}</h1>
        <button type="button" class="tb-btn" data-rm="close">${fs('返回运行画面')}</button>
      </header>
      <main class="rm-page">
        <div class="rm-tools">
          <button type="button" class="tb-btn" data-rm="reload">${fs('刷新列表')}</button>
          <input type="search" data-rm-search aria-label="${fs('搜索配方')}" placeholder="${fs('搜索配方名称')}">
        </div>
        <div class="rm-scroll">
          <table class="rm-table" aria-label="${fs('已保存配方')}">
            <thead><tr><th>${fs('配方名称')}</th><th>${fs('参数数量')}</th><th>${fs('更新时间')}</th><th>${fs('操作')}</th></tr></thead>
            <tbody data-rm-list></tbody>
          </table>
        </div>
        <section class="rm-preview" hidden>
          <header><strong data-rm-preview-title></strong><button type="button" class="tb-btn sm" data-rm="hide-preview">${fs('收起参数')}</button></header>
          <div class="rm-scroll">
            <table class="rm-table" aria-label="${fs('配方参数')}">
              <thead><tr><th>${fs('变量名')}</th><th>${fs('保存值')}</th></tr></thead><tbody data-rm-preview></tbody>
            </table>
          </div>
        </section>
        <div class="rm-status" role="status"></div>
      </main>
    </div>`;
  const shell = element.querySelector('.rm-shell');
  const q = sel => shell.querySelector(sel);
  const search = q('[data-rm-search]');
  let rows = [];
  let busy = false;
  let previewName = '';

  const show = (message, error = false) => {
    const status = q('.rm-status');
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  const close = (force = false) => {
    if (!force && busy) return;
    under.inert = wasInert;
    element.remove();
    previousFocus?.focus();
  };
  const rowAction = (key, label, name) =>
    `<button type="button" class="tb-btn sm" data-rm="${key}" data-name="${escapeHtml(name)}">${fs(label)}</button>`;

  function paintList() {
    const needle = search.value.trim().toLowerCase();
    const filtered = rows.filter(r => r.name.toLowerCase().includes(needle));
    q('[data-rm-list]').innerHTML = filtered.length ? filtered.map(({ name, count, updated }) =>
      `<tr data-rm-recipe="${escapeHtml(name)}">
        <th scope="row">${escapeHtml(name)}</th><td>${Number(count) || 0}</td><td>${escapeHtml(updated || '—')}</td>
        <td><div class="rm-row-actions">
          ${rowAction('view', '查看', name)}
          ${rowAction('apply', '应用到设备', name)}
        </div></td>
      </tr>`).join('') : `<tr><td colspan="4" class="rm-empty">${fs(needle ? '没有匹配的配方' : '还没有配方')}</td></tr>`;
  }

  async function refresh() {
    const result = await api.rpc('/api/recipes?summary=1', { method: 'GET' });
    rows = Array.isArray(result.rows) ? result.rows : [];
    paintList();
    if (previewName && rows.some(r => r.name === previewName)) await preview(previewName);
    else hidePreview();
  }

  function hidePreview() {
    previewName = '';
    q('.rm-preview').hidden = true;
  }

  async function preview(name) {
    const { recipe } = await api.rpc(recipeUrl(name), { method: 'GET' });
    const entries = Object.entries(recipe.vars);
    previewName = name;
    q('[data-rm-preview-title]').textContent = name;
    q('[data-rm-preview]').innerHTML = entries.map(([n, v]) =>
      `<tr><th scope="row">${escapeHtml(n)}</th><td>${escapeHtml(viewValue(v))}</td></tr>`).join('')
      || `<tr><td colspan="2" class="rm-empty">${fs('这套配方没有参数')}</td></tr>`;
    q('.rm-preview').hidden = false;
  }

  async function task(fn) {
    if (busy) return;
    busy = true;
    shell.setAttribute('aria-busy', 'true');
    show('');
    try { await fn(); } catch (error) { show(error.message || String(error), true); }
    finally { busy = false; shell.removeAttribute('aria-busy'); }
  }

  async function apply(name) {
    if (!await api.ensureAdmin('应用配方') || !element.isConnected) return;
    const { recipe } = await api.rpc(recipeUrl(name), { method: 'GET' });
    if (!element.isConnected || !confirm(`确定将配方「${name}」应用到设备？`)) return;
    try {
      const res = await api.rpc('/api/recipes', { body: { action: 'apply', name, revision: recipe.revision } });
      show(`已应用 ${res.applied.length} 项`);
    } catch (error) {
      if (!error.data?.failed?.length) throw error;
      const { applied, failed } = error.data;
      show(`已应用 ${applied.length} 项，失败 ${failed.length} 项。\n` +
        failed.slice(0, 20).map(v => `${v.name || '空变量名'}：${v.error}`).join('\n'), true);
    }
  }

  search.addEventListener('input', paintList);
  shell.addEventListener('click', e => {
    const btn = e.target.closest('button[data-rm]');
    if (!btn || busy) return;
    const name = btn.dataset.name;
    switch (btn.dataset.rm) {
      case 'close': close(); break;
      case 'reload': task(refresh); break;
      case 'view': task(() => preview(name)); break;
      case 'hide-preview': hidePreview(); break;
      case 'apply': task(() => apply(name)); break;
    }
  });
  element.addEventListener('keydown', e => e.stopPropagation());
  element.addEventListener('recipes:close', () => close(true));
  shell.addEventListener('keydown', e => {
    trapTab(e, shell);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  under.inert = true;
  document.body.appendChild(element);
  api.attachActivity(element);
  q('[data-rm="close"]').focus();
  task(refresh);
}
