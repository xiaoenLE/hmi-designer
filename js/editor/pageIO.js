/**
 * pageIO.js — **单页导出 / 导入**（把一页画面搬到别的工程里）
 *
 * 现场要的：某一个工程里调好的一页（比如"排线"），想搬到另一个工程接着用 ——
 * 不用整份工程拷来拷去（那会把 PLC 地址、报警、脚本全带过去，反而更麻烦）。
 *
 * 导出文件里有什么（`xxx-排线.page.json`）：
 *   · **这一页的控件**（几何 / 属性 / 绑定 / 动作 / 组合 全带）
 *   · **它用到的变量**（控件绑定、波形通道、通道配色量程、动作里的变量）
 *   · **它套的公共底**（连同底上的控件与它用到的变量）—— 底是"每页共用"的那层，
 *     不带过去的话导进来页面就少一条导航栏
 *   · 跳转/弹窗动作的**目标页名字**（导进别的工程时按名字重新对上，对不上就清空并提示）
 * 不带报警和脚本：那两样是"整机"的（报警条件挂在变量上、脚本是全局的），
 * 跟着一页搬很容易搬出重复报警/重复脚本 —— 变量必须带，不带页面就是一堆空绑定。
 *
 * 导入时：新页面正正经经生成新 id（不会和现有控件撞）、页名重了自动加序号、
 * 变量缺的补上/同名的留着现有的（地址不同只提醒不静默改）、一步 Ctrl+Z 撤销。
 */
import { project } from '../core/project.js';
import { escapeHtml as esc, statusNote } from '../core/utils.js';
import { showDialog } from './toolbar.js';
import { exportText, readTextFile } from '../core/csv.js';

/** 文件名里不能有的字符换掉（页名/工程名里可能带 / 或 :） */
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

/** 导出某一页（不传 = 当前页） */
export function exportPage(pageId) {
  const p = project.getPage(pageId || project.currentId);
  if (!p) return null;
  const payload = project.pageExportPayload(p.id);
  if (!payload) return null;
  const file = `${safeName(project.data.meta?.name || 'HMI工程')}-${safeName(p.name)}.page.json`;
  // 桌面窗口里弹「另存为」（自己选目录），浏览器里落到「下载」文件夹
  exportText(file, JSON.stringify(payload, null, 2), { kind: 'json' }).then(r => {
    if (r.cancelled) return;
    statusNote(`已导出「${p.name}」：${p.widgets.length} 个控件 · ${payload.variables.length} 个变量`
      + (payload.base ? ` · 公共底「${payload.base.name}」` : '') + (r.path ? ` → ${r.path}` : ` → ${file}`));
  });
  return payload;
}

/** 导入一个文件（<input type=file> 或拖进来的 File） */
export async function importPageFile(file) {
  if (!file) return null;
  let data = null;
  try {
    data = JSON.parse(await readTextFile(file));
  } catch (e) {
    alert(`「${file.name}」读不出来：${e.message}\n\n（单页导出文件和整份工程 JSON 都能导）`);
    return null;
  }
  // 整份工程 → 先让用户挑一页（"把那个工程里的排线页搬过来"这条最常用）
  if (Array.isArray(data.pages) && !data.page) return pickPageFromProject(data, file.name);
  const r = project.importPage(data);
  if (!r.ok) { alert(`导入失败：${r.reason}`); return null; }
  project.setCurrentPage(r.pageId);
  reportImport(r, file.name);
  return r;
}

/** 从一整份工程 JSON 里挑一页导进来 */
function pickPageFromProject(data, filename) {
  const pages = data.pages.filter(p => p && p.type !== 'base');   // 底不单独导（跟着页面走）
  if (!pages.length) { alert(`「${filename}」里没有可导入的页面`); return null; }
  showDialog({
    title: `从「${data.meta?.name || filename}」导入一页`,
    okText: '导入',
    body: `
      <div class="f-row"><span class="f-label">选哪一页</span>
        <select class="f-select" id="piPick">
          ${pages.map((p, i) => `<option value="${i}">${p.type === 'popup' ? '[弹窗] ' : '[页面] '}${esc(p.name)}（${p.widgets.length} 控件）</option>`).join('')}
        </select></div>
      <div class="dlg-hint">
        导进来的是**新的一页**（页名重了会自动加序号），它用到的变量会一起补进变量表（同名的保留现有的）；
        这一页套的公共底也会一起带过来。报警和脚本不跟着搬（它们是整机的）。
      </div>`,
    onOk: () => {
      const i = Number(document.getElementById('piPick').value) || 0;
      const r = project.importPage(data, { pageRef: pages[i].id });
      if (!r.ok) { alert(`导入失败：${r.reason}`); return false; }
      project.setCurrentPage(r.pageId);
      reportImport(r, filename);
      return true;
    },
  });
  return null;
}

/** 导完说清楚：建了哪一页、补了哪些变量、有没有对不上的跳转 */
function reportImport(r, srcName) {
  const lines = [`已导入「${r.pageName}」（来自 ${srcName}）`];
  if (r.varsAdded) lines.push(`· 变量表新增 ${r.varsAdded} 个变量`);
  if (r.varsKept) lines.push(`· ${r.varsKept} 个变量工程里已经有了，用现有的`);
  if (r.varsKeptDiff?.length) {
    lines.push(`  ⚠ 其中这些**地址和导出文件里不一样**（保留你工程里的地址）：${r.varsKeptDiff.slice(0, 6).join('、')}${r.varsKeptDiff.length > 6 ? '…' : ''}`);
  }
  if (r.baseCreated) lines.push(`· 一并建了公共底「${r.baseName}」并给这一页套上`);
  else if (r.baseName) lines.push(`· 套用了工程里已有的公共底「${r.baseName}」`);
  if (r.unlinked?.length) {
    lines.push(`· ⚠ 这些跳转/弹窗的目标页这里没有，已清空，请在属性面板重新指一下：`);
    lines.push('  ' + r.unlinked.slice(0, 5).join('；'));
  }
  (r.warnings || []).forEach(w => lines.push(`· ⚠ ${w}`));
  lines.push('\n（导错了 Ctrl+Z 一步撤销）');
  alert(lines.join('\n'));
}

/** 绑上隐藏的文件输入框 + 拖放（面板里点「导入页面…」走这里） */
export function initPageIO() {
  const input = document.getElementById('pageImportFile');
  if (input) {
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.value = '';                     // 同一个文件连着导两次也要能触发 change
      await importPageFile(f);
    });
  }
  // 直接把 .json 拖到页面列表上也能导（现场多半是从 U 盘/桌面拖过来）
  const list = document.getElementById('pageList');
  if (list) {
    ['dragenter', 'dragover'].forEach(ev => list.addEventListener(ev, e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      list.classList.add('pg-drop');
    }));
    ['dragleave', 'drop'].forEach(ev => list.addEventListener(ev, e => {
      if (ev === 'dragleave' && list.contains(e.relatedTarget)) return;
      list.classList.remove('pg-drop');
    }));
    list.addEventListener('drop', async e => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      await importPageFile(f);
    });
  }
}

/** 打开文件选择框（「导入页面…」菜单项调用） */
export function pickPageFile() {
  const input = document.getElementById('pageImportFile');
  if (input) input.click();
  else alert('页面导入入口没准备好（index.html 里的 #pageImportFile 不见了）');
}
