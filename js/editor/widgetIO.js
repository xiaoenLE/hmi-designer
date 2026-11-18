/**
 * widgetIO.js — **控件包**（`.hmiw.json`）的导出 / 导入界面
 *
 * 现场要的：「别人做好的控件我能不能也用」。
 *   · 导出：选中一个或几个控件 → 一个 .hmiw.json 文件（含控件数据 + 用到的变量）。
 *   · 导入：读文件 → 导到**当前页**上，用到的变量缺的自动补进变量表，一步 Ctrl+Z 可整体撤销。
 *
 * 两层的区分（数据在 js/widgets/pack.js，这里只管界面）：
 *   · 内置控件（16 种）：包里**不带**定义，对方工程本来就有 → 全程只是数据搬运，零风险。
 *   · 自定义控件（别人自己写的类型）：包里**带定义**（属性 schema + render 源码 + CSS）。
 *     导入等于在你这台机器上执行别人的 JS，性质同「脚本」面板 ——
 *     所以这里**先把源码摊开给你看、要你点确认**才注册（不静默执行）。
 */
import { project } from '../core/project.js';
import { escapeHtml as esc, statusNote } from '../core/utils.js';
import { showDialog } from './toolbar.js';
import { exportText, readTextFile } from '../core/csv.js';
import { getSelection } from './canvas.js';
import { isBuiltin } from '../widgets/pack.js';

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

/** 导出选中的控件（ids 不传就用当前选择） */
export function exportSelection(ids) {
  const list = (ids && ids.length) ? ids.slice() : getSelection();
  if (!list.length) { alert('先在画布上选一个（或几个）控件，再导出。'); return null; }
  const payload = project.widgetExportPayload(list);
  if (!payload) { alert('没找到要导出的控件（可能已经被删了）。'); return null; }
  const one = payload.widgets.length === 1 ? payload.widgets[0] : null;
  const label = one ? (one.name || one.type) : `${payload.widgets.length}个控件`;
  const file = `${safeName(project.data.meta?.name || 'HMI工程')}-${safeName(label)}.hmiw.json`;
  // 桌面窗口里弹「另存为」（自己选目录），浏览器里落到「下载」文件夹
  exportText(file, JSON.stringify(payload, null, 2), { kind: 'json' }).then(r => {
    if (r.cancelled) return;
    const nDefs = payload.defs.length;
    statusNote(`已导出「${label}」：${payload.widgets.length} 个控件 · ${payload.variables.length} 个变量`
      + (nDefs ? ` · ${nDefs} 个自定义控件定义（带代码）` : ' · 全部是内置控件（不带代码）')
      + (r.path ? ` → ${r.path}` : ` → ${file}`), 12000);
  });
  return payload;
}

/** 导入一个控件包文件（<input type=file> 走这里） */
export function importPackFile(file) {
  if (!file) return null;
  return readTextFile(file).then(text => {
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      alert(`「${file.name}」读不出来：${e.message}`);
      return null;
    }
    const defs = Array.isArray(data?.defs) ? data.defs.filter(d => d && d.type && !isBuiltin(d.type)) : [];
    // 带自定义控件定义 → 先把"要执行什么代码"摊开让人确认，点头了才导
    if (defs.length) { confirmCode(defs, file.name, data); return null; }
    return doImport(data, file.name, {});
  }).catch(e => { alert(`「${file.name}」读不出来：${e.message}`); return null; });
}

/** 真正导进去 + 报告（带代码的包由对话框确认后也会走这里） */
function doImport(data, filename, opt) {
  const r = project.importWidgetPack(data, opt);
  if (!r.ok) { alert(`导入失败：${r.reason}`); return null; }
  report(r, filename);
  return r;
}

/**
 * 带代码的包：把要注册的自定义控件定义摊开（属性 + render 源码）让人确认。
 * ⚠ 用 showDialog 的**回调**式写法（不是 await Promise）—— showDialog 没有 onCancel，
 *   Promise 版本在用户点「取消」时会永远挂着。取消 = 什么都不做，正合适。
 */
function confirmCode(defs, filename, data) {
  const rows = defs.map(d => `
    <div style="margin-bottom:10px">
      <div style="font-size:12px;color:var(--text-2);margin-bottom:4px">
        <b>${esc(d.type)}</b> · ${esc(d.title || d.type)}${d.sub ? ` · ${esc(d.sub)}` : ''} ·
        ${(d.props || []).length} 个属性${d.hidden ? ' · 隐藏' : ''}${d.css ? ` · 带样式（${String(d.css).length} 字符）` : ''}
      </div>
      <pre style="max-height:180px;overflow:auto;background:#0f172a;color:#cbd5e1;font-size:11px;
        line-height:1.5;padding:8px;border-radius:4px;margin:0;white-space:pre-wrap">${esc(truncate(d.renderSrc))}</pre>
    </div>`).join('');
  showDialog({
    title: `导入控件包：${filename}`,
    okText: '知道了，导入',
    wide: true,
    body: `
      <div class="dlg-hint" style="border-left:3px solid #f59e0b;padding-left:8px">
        这个包里带了 <b>${defs.length} 个自定义控件定义</b>（${esc(defs.map(d => d.type).join('、'))}）。<br>
        控件的<strong>渲染函数是 JavaScript</strong> —— 导进来就等于在你这台机器上执行它，
        性质和「脚本」面板一样。<b>只导入你信得过的来源。</b>先看下面的源码，不确定就点「取消」。
      </div>
      ${rows}
      <div class="dlg-hint">
        确认后会做三件事：① 注册这些控件类型（跟着工程走，换台机器打开也能渲染）；
        ② 把 ${(data.widgets || []).length} 个控件放到当前页；③ 缺的变量补进变量表。导错了 Ctrl+Z 一步撤销。
      </div>`,
    onOk: () => { doImport(data, filename, { allowCode: true }); return true; },
  });
  return null;
}

const truncate = (src, maxLines = 24) => {
  const s = String(src || '').split('\n');
  return s.length > maxLines ? s.slice(0, maxLines).join('\n') + `\n…（还有 ${s.length - maxLines} 行，导入后可在「控件 ▸ 导出」里看到全文）` : s.join('\n');
};

/** 导完说清楚：加了几个控件、补了哪些变量、有没有对不上的跳转 */
function report(r, srcName) {
  const lines = [`已导入 ${r.widgetsAdded} 个控件（来自 ${srcName}）→ 当前页`];
  if (r.defsAdded?.length) lines.push(`· 新增自定义控件类型 ${r.defsAdded.length} 个：${r.defsAdded.join('、')}`);
  if (r.varsAdded) lines.push(`· 变量表新增 ${r.varsAdded} 个变量`);
  if (r.varsKept) lines.push(`· ${r.varsKept} 个变量工程里已经有了，用现有的`);
  if (r.varsKeptDiff?.length) lines.push(`  ⚠ 其中这些**地址和包里不一样**（保留你工程里的地址）：${r.varsKeptDiff.slice(0, 6).join('、')}${r.varsKeptDiff.length > 6 ? '…' : ''}`);
  (r.warnings || []).forEach(w => lines.push(`· ⚠ ${w}`));
  lines.push('\n（导错了 Ctrl+Z 一步撤销）');
  alert(lines.join('\n'));
}

/** 点「导入控件包…」时打开文件选择框 */
export function pickWidgetPackFile() {
  const input = document.getElementById('widgetPackFile');
  if (input) input.click();
  else alert('控件包导入入口没准备好（index.html 里的 #widgetPackFile 不见了）');
}

export function initWidgetIO() {
  const input = document.getElementById('widgetPackFile');
  if (!input) return;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.value = '';                  // 同一个文件连着导两次也要能触发 change
    await importPackFile(f);
  });
}
