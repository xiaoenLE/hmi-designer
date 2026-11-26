/** 工程编辑器里的配方地址配置。变量地址和类型沿用工程变量表。 */
import { project } from '../core/project.js';
import { escapeHtml } from '../core/utils.js';
import { showDialog } from './toolbar.js';

const PAGE_SIZE = 60;
const MAX_VARIABLES = 5000;

export function openRecipeConfig() {
  const variables = project.variables().map(v => ({
    ...v, search: (v.name + ' ' + (v.address || '')).toLowerCase(),
  }));
  const selected = new Set(project.recipeVariables().map(v => v.name));
  let page = 0;
  let visible = [];
  showDialog({
    title: '配方地址配置',
    wide: true,
    okText: '保存配置',
    body: `
      <div class="recipe-config">
        <p class="dlg-hint">勾选需要写入配方存档的变量。PLC 地址和类型取自工程变量表。</p>
        <div class="rm-tools">
          <label>搜索 <input class="f-input" type="search" data-rcfg="search" placeholder="变量名或 PLC 地址"></label>
          <label><input type="checkbox" data-rcfg="selected"> 只看已选</label>
          <span role="status" data-rcfg="count"></span>
        </div>
        <div class="rm-scroll">
          <table class="rm-table" aria-label="配方地址">
            <thead><tr><th scope="col"><input type="checkbox" data-rcfg="check-page" aria-label="勾选本页"></th>
              <th scope="col">变量名</th><th scope="col">数据类型</th><th scope="col">PLC 地址</th></tr></thead>
            <tbody data-rcfg="rows"></tbody>
          </table>
        </div>
        <div class="rm-pagination" data-rcfg="pagination">
          <button type="button" class="tb-btn" data-rcfg="prev">上一页</button>
          <span data-rcfg="page"></span>
          <button type="button" class="tb-btn" data-rcfg="next">下一页</button>
        </div>
      </div>`,
    onOk: () => { project.setRecipeVariables(selected); },
  });
  const box = document.querySelector('.recipe-config');
  const el = key => box.querySelector('[data-rcfg="' + key + '"]');
  const checkPage = el('check-page');
  const search = el('search');
  const onlySelected = el('selected');

  function updateCount() {
    const count = visible.filter(v => selected.has(v.name)).length;
    checkPage.disabled = !visible.length;
    checkPage.checked = !!count && count === visible.length;
    checkPage.indeterminate = count > 0 && count < visible.length;
    el('count').textContent = `已选 ${selected.size} 项`;
  }

  function paint() {
    const needle = search.value.trim().toLowerCase();
    const matches = variables.filter(v => v.search.includes(needle) && (!onlySelected.checked || selected.has(v.name)));
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    visible = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    el('rows').innerHTML = visible.map(v => `<tr>
      <td><input type="checkbox" data-name="${escapeHtml(v.name)}" aria-label="${escapeHtml(v.name)}"${selected.has(v.name) ? ' checked' : ''}></td>
      <th scope="row">${escapeHtml(v.name)}</th><td>${escapeHtml(v.type)}</td>
      <td>${escapeHtml(v.address || '内部变量')}</td>
    </tr>`).join('') || '<tr><td class="rm-empty" colspan="4">没有符合条件的变量</td></tr>';
    el('page').textContent = `${page + 1} / ${pages}`;
    el('prev').disabled = page === 0;
    el('next').disabled = page === pages - 1;
    el('pagination').hidden = pages === 1;
    box.querySelector('.rm-scroll').scrollTop = 0;
    updateCount();
  }

  function update(names, checked) {
    if (checked && selected.size + names.filter(name => !selected.has(name)).length > MAX_VARIABLES) {
      alert(`最多可配置 ${MAX_VARIABLES} 个配方变量`);
      paint();
      return;
    }
    names.forEach(name => checked ? selected.add(name) : selected.delete(name));
    if (onlySelected.checked || names.length !== 1) paint();
    else updateCount();
  }

  search.addEventListener('input', () => { page = 0; paint(); });
  onlySelected.addEventListener('change', () => { page = 0; paint(); });
  checkPage.addEventListener('change', () => {
    const checked = checkPage.checked;
    update(visible.map(v => v.name), checked);
    el('rows').querySelectorAll('input').forEach(input => { input.checked = selected.has(input.dataset.name); });
  });
  el('rows').addEventListener('change', e => update([e.target.dataset.name], e.target.checked));
  el('prev').addEventListener('click', () => { page--; paint(); });
  el('next').addEventListener('click', () => { page++; paint(); });
  paint();
  search.focus();
}
