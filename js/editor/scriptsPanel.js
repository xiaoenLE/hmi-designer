/**
 * scriptsPanel.js — 脚本编辑栏（左侧「脚本」面板）
 *
 * 一行一条脚本，**只留这几样**（现场要求：行里显示太长，✎ 被挤到最右边点不着）：
 *   勾选 · ✎ 编辑（放**最前面**，永远点得到）· ✔ 启用 · 名称
 * 触发方式 / 时间(ms) / 变量 / 比较 / 阈值**全在编辑器里设**（点 ✎ 就是那个大窗口）——
 * 行里不再摆那些输入框：脚本名一长，触发条件那一格就把整行撑出面板，编辑按钮就够不着了。
 * 行的悬停提示里仍然写着"这条脚本什么时候跑"，一眼能看明白。
 *
 * 删除走**勾选 + 底部「删除选中 (N)」**（跟变量表 / 报警表一个口径：整批一次删、一步 Ctrl+Z 能撤销回来），
 * 行尾不再单独放 ✕ —— 删一条就勾一条。
 * 另外支持脚本表 CSV 导入 / 导出（代码那一格能整段进出，可以在 Excel/记事本里批量写好再导进来）。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { openScriptEditor } from './scriptEditor.js';
import { scriptsToCsv, importScriptsCsv, downloadText, readTextFile } from '../core/csv.js';
import { showDialog } from './toolbar.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let filterText = '';
/** 勾选中的脚本 id（多选删除用）。按 id 记，不按下标 —— 列表会随筛选重画 */
let selScripts = new Set();

export function initScriptsPanel() {
  document.getElementById('btnAddScript')?.addEventListener('click', () => openScriptEditor());
  document.getElementById('btnDelScripts')?.addEventListener('click', deleteSelected);
  document.getElementById('btnScriptCsvOut')?.addEventListener('click', exportCsv);
  document.getElementById('btnScriptCsvIn')?.addEventListener('click', openCsvImport);
  document.getElementById('scriptFilter')?.addEventListener('input', e => {
    filterText = e.target.value.trim().toLowerCase();
    render();
  });
  bus.on('project:changed', render);
  bus.on('scripts:changed', render);
  render();
}

/** 触发方式的中文短描述（列表里当悬停提示用，一行说清"什么时候跑"） */
function trigText(s) {
  const v = s.variable ? s.variable : '（未选变量）';
  if (s.trig === 'interval') return `每 ${Math.max(10, Math.round(+s.ms || 1000))} ms`;
  if (s.trig === 'cycle') return '每周期 50ms';
  if (s.trig === 'change') return `${v} 变化`;
  if (s.trig === 'cond') {
    const raw = s.value;
    const val = typeof raw === 'number' ? raw : `'${raw}'`;
    return `${v} ${s.op || '=='} ${val} 成立`;
  }
  return '进运行态一次';
}

/** 当前要显示的脚本（套上筛选框） */
function currentList() {
  const all = project.scripts();
  if (!filterText) return all;
  return all.filter(s => `${s.name} ${s.code} ${s.variable}`.toLowerCase().includes(filterText));
}

function render() {
  const box = document.getElementById('scriptTable');
  if (!box) return;
  const all = project.scripts();
  const list = currentList();
  const cnt = document.getElementById('scriptCount');
  if (cnt) cnt.textContent = all.length ? ` (${all.length})` : '';

  // 勾选态按 id 记：脚本不在了（删了 / CSV 整表替换 / 从服务器读回来）就从选择里剔掉
  const ids = new Set(all.map(s => s.id));
  [...selScripts].forEach(id => { if (!ids.has(id)) selScripts.delete(id); });

  if (!all.length) {
    box.innerHTML = `<div style="color:var(--text-2);font-size:12px;line-height:1.8">
      还没有脚本。点「＋ 新建脚本」开大编辑器写一段 JS（右边有变量和 API 速查）。<br>
      触发方式（进运行态一次 / 定时 / 循环 / 变量变化 / 条件成立）在编辑器里选。</div>`;
    syncSelUI();
    return;
  }

  box.innerHTML = `
    <table class="vt alarm scripttbl">
      <thead><tr>
        <th class="vt-sel"><input type="checkbox" id="scriptSelAll"
          title="全选 / 全不选（当前筛选出来的这些）；勾上几条后下面会出现「删除选中」"></th>
        <th title="编辑（打开大窗口：代码 + 触发方式 + 时间/变量/条件都在里面设）">✎</th>
        <th title="启用 / 停用">✔</th>
        <th>名称</th>
      </tr></thead>
      <tbody>
        ${list.map(s => `
        <tr data-script="${esc(s.id)}" class="${s.enabled === false ? 'off' : ''}${selScripts.has(s.id) ? ' sel' : ''}"
            title="${esc(s.name)}&#10;什么时候跑：${esc(trigText(s))}${s.enabled === false ? '&#10;（已停用）' : ''}&#10;点最前面的 ✎ 改代码和触发设置">
          <td class="vt-sel"><input type="checkbox" class="sc-sel" ${selScripts.has(s.id) ? 'checked' : ''}
            title="勾上：和别的勾一起批量删（底部「删除选中」）"></td>
          <td class="al-acts"><button class="vt-edit" title="打开编辑器：代码、触发方式、时间(ms)、变量条件都在里面设">✎</button></td>
          <td style="text-align:center"><input data-k="enabled" type="checkbox" ${s.enabled !== false ? 'checked' : ''} title="启用 / 停用（停用的脚本运行态不跑）"></td>
          <td><input data-k="name" class="mono" value="${esc(s.name)}" title="${esc(s.name)}"></td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  box.querySelector('#scriptSelAll')?.addEventListener('change', e => {
    // 全选/全不选只管**当前筛出来的这些**（筛选框里还有字时，选上被藏起来的行最让人意外）
    const shown = currentList();
    if (e.target.checked) shown.forEach(s => selScripts.add(s.id));
    else shown.forEach(s => selScripts.delete(s.id));
    render();
  });

  box.querySelectorAll('tr[data-script]').forEach(tr => {
    const id = tr.dataset.script;
    tr.querySelector('.sc-sel')?.addEventListener('change', e => {
      if (e.target.checked) selScripts.add(id); else selScripts.delete(id);
      tr.classList.toggle('sel', e.target.checked);
      syncSelUI();
    });
    tr.querySelectorAll('input[data-k]').forEach(inp => {
      inp.addEventListener('change', () => {
        if (inp.dataset.k === 'enabled') { project.updateScript(id, { enabled: inp.checked }); return; }
        project.updateScript(id, { [inp.dataset.k]: inp.value });
      });
    });
    tr.querySelector('.vt-edit').addEventListener('click', () => openScriptEditor(id));
  });
  syncSelUI();
}

/** 表头全选框 + 底部「删除选中」「导出 CSV」按钮，跟着勾选态走 */
function syncSelUI() {
  const all = document.getElementById('scriptSelAll');
  if (all) {
    const shown = currentList();
    all.checked = !!shown.length && shown.every(s => selScripts.has(s.id));
  }
  const btn = document.getElementById('btnDelScripts');
  if (btn) {
    btn.hidden = selScripts.size === 0;
    btn.textContent = `删除选中 (${selScripts.size})`;
  }
  // 导出按钮跟勾选走：勾了就只导出勾选的（按钮上写明条数，避免"以为导了全部"）
  const out = document.getElementById('btnScriptCsvOut');
  if (out) {
    const n = selScripts.size;
    out.textContent = n ? `导出选中 (${n})` : '导出 CSV';
    out.title = n
      ? `只导出表格里勾选的这 ${n} 条脚本`
      : '导出全部脚本为 CSV（含代码）。勾选几条后，这里就只导出勾选的那些';
  }
}

/** 删除勾选的脚本：整批一次提交（一步 Ctrl+Z 撤销） */
function deleteSelected() {
  const ids = [...selScripts];
  if (!ids.length) return;
  if (!confirm(`删除勾选的 ${ids.length} 条脚本？\n（删错了可以 Ctrl+Z 一次撤销回来）`)) return;
  const gone = project.deleteScripts(ids);     // 里面整批一次 commit = 一步撤销
  ids.forEach(id => selScripts.delete(id));
  bus.emit('scripts:changed', { deleted: true });   // 运行态的脚本引擎跟着停掉这些
  syncSelUI();
  if (gone) flashMsg(`已删除 ${gone} 条脚本（Ctrl+Z 可撤销）`);
}

/** 底部一行小提示，几秒后自己消失（跟变量/报警面板一个套路） */
function flashMsg(text) {
  const el = document.getElementById('scriptMsg');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(flashMsg._t);
  flashMsg._t = setTimeout(() => { el.hidden = true; }, 4000);
}

function exportCsv() {
  const all = project.scripts();
  if (!all.length) { alert('还没有脚本，先新建一条再导出。'); return; }
  // **勾了就只导出勾选的**（现场要求）；一条没勾 = 导出全部
  const pick = selScripts.size ? all.filter(s => selScripts.has(s.id)) : all;
  const tag = selScripts.size ? `选中${pick.length}条` : '全部';
  downloadText(`${project.data.meta.name || 'hmi-project'}-脚本表-${tag}.csv`, scriptsToCsv(pick));
  flashMsg(selScripts.size ? `已导出勾选的 ${pick.length} 条脚本` : `已导出全部 ${pick.length} 条脚本`);
}

/** 导入并回报结果；解析失败返回 null */
function applyImport(text, mode) {
  let res;
  try {
    res = importScriptsCsv(text, { mode });
  } catch (err) {
    alert(`CSV 解析失败：${err && err.message ? err.message : err}`);
    return null;
  }
  if (!res.total && res.errors.length) {
    alert(`一行都没读进来：\n${res.errors.slice(0, 6).join('\n')}`);
    return null;
  }
  const head = mode === 'replace' ? '整表替换完成' : '导入完成';
  const msg = `${head}：共读入 ${res.total} 行 → 新增 ${res.added} 条，更新 ${res.updated} 条`
    + (mode === 'replace' ? `\n（原来的脚本已全部清掉，现在共 ${project.scripts().length} 条）` : `\n（现在共 ${project.scripts().length} 条）`)
    + (res.errors.length ? `\n\n跳过 ${res.errors.length} 行：\n${res.errors.slice(0, 5).join('\n')}` : '')
    + (res.warnings.length ? `\n\n注意 ${res.warnings.length} 条：\n${res.warnings.slice(0, 5).join('\n')}` : '');
  bus.emit('scripts:changed', {});
  alert(msg);
  return res.total;
}

function openCsvImport() {
  showDialog({
    title: '导入脚本 CSV',
    wide: true,
    okText: '导入',
    body: `
      <textarea id="scriptCsvText" class="dlg-area fixed" spellcheck="false"
        placeholder="名称,触发,时间ms,变量,比较,阈值,启用,代码&#10;每秒加一,定时,1000,,,,是,hmi.set('nCount', hmi.get('nCount') + 1)"></textarea>
      <div class="dlg-chips">
        <button type="button" class="tb-btn sm" id="scriptCsvPickBtn">选择 CSV 文件…</button>
        <input type="file" id="scriptCsvPick" accept=".csv,text/csv" hidden>
        <span id="scriptCsvPickInfo" class="dlg-chips-label">或者直接把 Excel 里复制的内容粘到上面</span>
      </div>
      <div class="dlg-chips">
        <label class="dlg-radio"><input type="radio" name="scriptImpMode" value="upsert" checked> 同名更新，新名称追加</label>
        <label class="dlg-radio"><input type="radio" name="scriptImpMode" value="replace"> 清空后导入（替换全部）</label>
        <label class="dlg-radio"><input type="radio" name="scriptImpMode" value="append"> 全部当新脚本追加</label>
      </div>`,
    onOk: () => {
      const txt = document.getElementById('scriptCsvText').value;
      if (!txt.trim()) {
        alert('还没内容：可以粘贴 CSV 文本，或点「选择 CSV 文件…」。');
        return false;   // 不关窗，让人接着贴
      }
      const mode = document.querySelector('input[name="scriptImpMode"]:checked')?.value || 'upsert';
      if (mode === 'replace' && project.scripts().length
        && !confirm(`会先清掉现有的 ${project.scripts().length} 条脚本，再导入。继续？`)) return false;
      applyImport(txt, mode);
      return true;
    },
  });

  const pick = document.getElementById('scriptCsvPick');
  document.getElementById('scriptCsvPickBtn').addEventListener('click', () => { pick.value = ''; pick.click(); });
  pick.addEventListener('change', () => {
    const f = pick.files[0];
    if (!f) return;
    // 同样不能写死 UTF-8：Excel 存的 CSV 在中文 Windows 上是 GBK
    readTextFile(f).then(text => {
      document.getElementById('scriptCsvText').value = text;
      const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
      document.getElementById('scriptCsvPickInfo').textContent = `已读入 ${f.name}（约 ${lines} 行），点「导入」写进工程`;
    }).catch(e => alert(`读文件失败：${e && e.message ? e.message : e}`));
  });
}
