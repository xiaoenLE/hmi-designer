/**
 * i18nPanel.js — 「多语言 / 翻译…」（工程 ▾）：语言表 + 翻译表导入导出 + 预览语言
 *
 * 现场口径（都在 js/core/i18n.js 里，这里只是界面）：
 *   · **默认语言 = 原文语言**（不翻译）；其它语言每句原文一份译文（同一句全工程共用一份）。
 *   · 语言表 / 译文跟着**工程**走（meta.i18n）；「现在用哪国语言」只记在**这台机器**上（localStorage）。
 *   · 翻译表是 CSV：列 = 分类,位置,字段,原文,<语言…>，Excel 打开填完再导回来（Excel 直接开不乱码）。
 *
 * 界面三块：
 *   ① 语言：列表（默认那行标「原文」、不能删；每行「已翻译 N 条」）、添加（代码 + 显示名，留空用内置名）、
 *      删除（确认框）、设为默认语言。
 *   ② 翻译表：导出 CSV（工程名-翻译表.csv）/ 导入 CSV（报告填了多少条、跳过多少条）、当前总条数。
 *   ③ 预览：语言下拉 —— 选中就 setLang，编辑画布（运行中则运行画面）当场按这门语言重画。
 *
 * 对话框关掉时（确定 / 取消 / ✕ 都算）：只要改过语言表或译文，就 project.commit('多语言设置') **一次**，
 * 让工程变脏（自动保存会落盘）并且能用 Ctrl+Z 一整步撤销。
 */
import { showDialog } from './toolbar.js';
import { project } from '../core/project.js';
import { exportText, readTextFile } from '../core/csv.js';
import { statusNote, escapeHtml as esc } from '../core/utils.js';
import {
  languages, defaultLang, getLang, setLang, addLanguage, removeLanguage, setDefaultLang,
  translationCount, exportTranslationCsv, importTranslationCsv, collectEntries,
  langScale, setLangScale,
} from '../core/i18n.js';

/** 语言代码的宽松校验：字母开头，后面字母/数字/下划线/短横（en、zh-TW、pt-BR 都认） */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;

export function openI18nPanel() {
  let dirty = false;          // 语言表 / 译文改过没有（关对话框时决定要不要 commit 一次）
  const totalCount = () => collectEntries().length;

  const body = `
    <style>
      #i18nLangs .i18n-lang-row { display:flex; align-items:center; gap:8px; padding:5px 2px;
        border-bottom:1px dashed var(--border); }
      #i18nLangs .i18n-lang-row:last-child { border-bottom:0; }
      #i18nLangs .i18n-lang-code { font-family:var(--mono); font-size:12px; color:var(--text-2); min-width:46px; }
      #i18nLangs .i18n-lang-label { font-size:13px; }
      #i18nLangs .i18n-lang-scale { display:flex; align-items:center; gap:3px; font-size:11.5px; color:var(--text-2); white-space:nowrap; }
      #i18nLangs .i18n-scale-inp { width:62px; height:22px; padding:0 4px; font-size:12px; }
      #i18nLangs .i18n-lang-count { margin-left:auto; font-size:12px; color:var(--text-2); white-space:nowrap; }
      #i18nStatus.warn { color:var(--danger); }
      #i18nStatus.ok { color:#15803d; }
      #i18nPreviewRow .f-select { flex:0 0 240px; }
    </style>
    <div class="dlg-hint">默认语言那一行就是<b>原文</b>（不用翻译，也不能删）；其它语言按「原文 → 译文」一句一句配。
      翻译表导出成 CSV，用 Excel 打开、把译文列填好，再导入回来即可。</div>

    <div class="prop-group-title">语言</div>
    <div id="i18nLangs"></div>
    <div class="f-row" style="margin-top:8px">
      <span class="f-label">添加语言</span>
      <input class="f-input" id="i18nLangCode" style="width:84px;flex:none" placeholder="代码，如 en" spellcheck="false" autocomplete="off">
      <input class="f-input" id="i18nLangLabel" style="flex:1" placeholder="显示名（留空 = 内置名，如 English）" spellcheck="false">
      <button type="button" class="tb-btn sm" id="i18nAddLang">＋ 添加</button>
    </div>
    <div id="i18nStatus" class="dlg-hint" style="min-height:18px;margin:2px 0 6px"></div>

    <div class="prop-group-title">翻译表</div>
    <div class="f-row">
      <span class="f-label">可翻译文字</span>
      <b id="i18nTotal">0</b><span style="font-size:12px">条</span>
      <span class="dlg-hint" style="margin:0">（控件文字 / 页面名 / 报警文字；同一句原文全工程共用一份译文）</span>
    </div>
    <div class="f-row">
      <span class="f-label">翻译表</span>
      <button type="button" class="tb-btn sm" id="i18nExport"
        title="导出全部文字 + 每门语言一列译文（CSV，Excel 直接打开，中文不乱码）">导出翻译表 CSV…</button>
      <button type="button" class="tb-btn sm" id="i18nImport"
        title="导入填好的翻译表：按「原文」列把各语言译文填回来（表头写语言代码如 en，或显示名如 English）">导入翻译表 CSV…</button>
      <input type="file" id="i18nCsvFile" accept=".csv,text/csv" hidden>
    </div>
    <div class="dlg-hint" style="margin-top:2px">
      导出的文件名是「&lt;工程名&gt;-翻译表.csv」；每门语言一列，<b>译文留空 = 没翻</b>（运行/预览时照旧显示原文）。
    </div>

    <div class="prop-group-title">预览</div>
    <div class="f-row" id="i18nPreviewRow">
      <span class="f-label">预览语言</span>
      <select class="f-select" id="i18nLangPreview" title="切一下看看译文对不对（编辑画布当场重画；运行中则运行画面重画）"></select>
      <span class="dlg-hint" style="margin:0">只影响<b>这台机器</b>（工程里的语言表和译文不受影响）。</span>
    </div>`;

  const dlg = showDialog({
    title: '多语言 / 翻译',
    wide: true,
    okText: '关闭',
    body,
    onOk: () => {
      finish();            // 确定 = 关掉（改过的照旧提交一次，能撤销）
      return true;
    },
  });

  const $ = (id) => document.getElementById(id);

  /** 状态行（对话框底部一条人话；对话框已经关掉时静默） */
  function status(msg, kind) {
    const el = $('i18nStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'dlg-hint' + (kind ? ' ' + kind : '');
  }

  /** 重画语言列表 + 预览下拉 + 总条数（语言表/译文一变就调） */
  function paint() {
    const list = languages();
    const def = defaultLang();
    const total = totalCount();
    const box = $('i18nLangs');
    if (box) {
      box.innerHTML = list.map((l) => {
        const isDef = l.code === def;
        return `<div class="i18n-lang-row" data-lang="${esc(l.code)}">
          <span class="i18n-lang-code">${esc(l.code)}</span>
          <b class="i18n-lang-label">${esc(l.label)}</b>
          ${isDef ? '<span class="badge blue">原文</span>' : ''}
          <label class="i18n-lang-scale" title="这门语言的字体缩放比例：100 = 不缩放；翻成英文/德文嫌长就调到 85~95，嫌小就调大（50~200）">
            字号
            <input type="number" class="i18n-scale-inp" data-lang-scale="${esc(l.code)}"
              min="50" max="200" step="5" value="${langScale(l.code)}">%
          </label>
          <span class="i18n-lang-count">${isDef ? `原文共 ${total} 条` : `已翻译 ${translationCount(l.code)} 条`}</span>
          ${isDef ? '' : `
            <button type="button" class="tb-btn sm" data-lang-default="${esc(l.code)}"
              title="把「${esc(l.label)}」设为默认语言（原文所在语言；原文文字不变）">设为默认</button>
            <button type="button" class="tb-btn sm danger" data-lang-del="${esc(l.code)}"
              title="删除「${esc(l.label)}」（连同它的译文）">✕</button>`}
        </div>`;
      }).join('');
    }
    const sel = $('i18nLangPreview');
    if (sel) {
      const cur = getLang();
      sel.innerHTML = list.map(l =>
        `<option value="${esc(l.code)}" ${l.code === cur ? 'selected' : ''}>${esc(l.label)}（${esc(l.code)}）</option>`
      ).join('');
    }
    const tot = $('i18nTotal');
    if (tot) tot.textContent = String(total);
  }

  /* ── ① 语言：添加 / 设为默认 / 删除 ── */
  $('i18nAddLang')?.addEventListener('click', () => {
    const codeEl = $('i18nLangCode');
    const labelEl = $('i18nLangLabel');
    const code = String(codeEl?.value || '').trim();
    const label = String(labelEl?.value || '').trim();
    if (!code) { status('先填语言代码（比如 en / ru / ja）', 'warn'); codeEl?.focus(); return; }
    if (!CODE_RE.test(code)) { status(`语言代码「${code}」不合法：用字母开头（如 en、zh-TW、pt-BR）`, 'warn'); codeEl?.focus(); return; }
    const existed = languages().some(l => l.code === code);
    addLanguage(code, label);
    dirty = true;
    if (codeEl) codeEl.value = '';
    if (labelEl) { labelEl.value = ''; labelEl.focus(); }
    paint();
    const now = languages().find(l => l.code === code);
    status(existed
      ? `「${code}」原来就有，显示名已改为「${now?.label || label || code}」`
      : `已添加语言 ${code}（${now?.label || label || code}）`, 'ok');
  });
  // 两个输入框里敲回车 = 点「添加」
  ['i18nLangCode', 'i18nLangLabel'].forEach((id) => {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      $('i18nAddLang')?.click();
    });
  });

  $('i18nLangs')?.addEventListener('click', (e) => {
    const delBtn = e.target.closest?.('[data-lang-del]');
    if (delBtn) {
      const code = delBtn.dataset.langDel;
      const hit = languages().find(l => l.code === code);
      if (!confirm(`删除语言「${hit ? hit.label : code}」（${code}）？\n\n它的译文会一起删掉；原文不动。`)) return;
      const wasPreviewing = getLang() === code;   // 删之前先记：正预览着这门语言的话，画布得重画回原文
      removeLanguage(code);
      dirty = true;
      // ⚠ removeLanguage 内部判「当前语言是不是被删的」时，getLang() 已经先回退到默认语言了，
      //   所以它不一定广播 i18n:lang —— 预览着被删语言时画布会一直停在旧译文上。这里补一次。
      if (wasPreviewing) setLang(getLang());
      paint();
      status(`已删除语言 ${code}（连同它的译文）`, 'ok');
      return;
    }
    const defBtn = e.target.closest?.('[data-lang-default]');
    if (defBtn) {
      const code = defBtn.dataset.langDefault;
      const hit = languages().find(l => l.code === code);
      if (!confirm(`把「${hit ? hit.label : code}」设为默认语言（原文语言）？\n\n`
        + `现在的默认语言会变成一门可翻译语言；原文文字不变，只是"原文列"换成了 ${code}。`)) return;
      setDefaultLang(code);
      dirty = true;
      paint();
      status(`默认语言已改为 ${code}；预览也切到这门语言了`, 'ok');
    }
  });

  // 每门语言的「字号%」：改完立刻按新字号重画画布（存在工程里，关对话框时随 dirty 一起提交）
  $('i18nLangs')?.addEventListener('change', (e) => {
    const inp = e.target.closest?.('[data-lang-scale]');
    if (!inp) return;
    const code = inp.dataset.langScale;
    const n = setLangScale(code, inp.value);
    inp.value = String(n);
    dirty = true;
    const hit = languages().find(l => l.code === code);
    status(`「${hit ? hit.label : code}」字号设为 ${n}%（100% = 不缩放；画布已按这门语言重画）`, 'ok');
  });

  /* ── ② 翻译表：导出 / 导入 ── */
  $('i18nExport')?.addEventListener('click', () => {
    const total = totalCount();
    if (!total) { status('这个工程里还没有可翻译的文字（先放几个控件 / 页面 / 报警）', 'warn'); return; }
    const csv = exportTranslationCsv();
    const name = `${project.data?.meta?.name || 'hmi-project'}-翻译表.csv`;
    // ⚠ 必须**同步**调 exportText：保存框要在这次点击的手势里弹出来（见 core/csv.js 的说明）
    exportText(name, csv, { kind: 'csv' }).then((r) => {
      if (!r || r.cancelled) return;
      if (r.ok) status(`已导出 ${total} 条文字的翻译表：${r.path || name}`, 'ok');
      else if (r.error) status(`导出失败：${r.error}`, 'warn');
    }).catch(e => status(`导出失败：${e?.message || e}`, 'warn'));
    status(`正在导出 ${total} 条文字（${name}）…`);
  });

  const fileInput = $('i18nCsvFile');
  $('i18nImport')?.addEventListener('click', () => {
    if (!fileInput) return;
    fileInput.value = '';            // 允许重复选同一个文件
    fileInput.click();
  });
  fileInput?.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    // ⚠ 不能 readAsText(utf-8)：Excel 在中文 Windows 上存的是 GBK，读中文会乱（csv.js 里自动认编码）
    readTextFile(f).then((text) => {
      const res = importTranslationCsv(text);
      if (!res.ok) { status(`导入失败：${res.reason || '文件格式不对'}`, 'warn'); return; }
      if (res.filled) {
        dirty = true;
        // 译文变了：让编辑画布/运行画面按**当前预览语言**重画一遍（不然导入完看不到效果）
        setLang(getLang());
      }
      paint();
      status(`导入完成：填了 ${res.filled} 条 / 跳过 ${res.skipped} 条`
        + (res.langs.length ? `（语言：${res.langs.join('、')}）` : ''), res.filled ? 'ok' : 'warn');
    }).catch(e => status(`读文件失败：${e?.message || e}`, 'warn'))
      .finally(() => { fileInput.value = ''; });
  });

  /* ── ③ 预览：切语言（画布/运行画面收到 i18n:lang 自己重画） ── */
  $('i18nLangPreview')?.addEventListener('change', (e) => {
    const code = e.target.value;
    const got = setLang(code);       // 不在语言表里会自动回退到默认语言
    const hit = languages().find(l => l.code === got);
    status(`预览语言：${hit ? hit.label : got}（${got}）—— 画布已按这门语言重画`, 'ok');
    paint();                          // 选中项跟着实际语言走（回退时也对）
  });

  /** 关对话框：改过就提交一次（让工程变脏、能一整步撤销） */
  function finish() {
    if (!dirty) return;
    dirty = false;
    project.commit('多语言设置');
    statusNote('多语言设置已保存（Ctrl+Z 可撤销）', 5000);
  }

  // 取消 / 右上角 ✕ 也要走 finish()（showDialog 内部那两个处理函数换掉，自己再调 close）
  const close = dlg.close;
  const onClose = () => { finish(); close(); };
  const cancelBtn = $('dlgCancel');
  if (cancelBtn) cancelBtn.onclick = onClose;
  const xBtn = $('dlgX');
  if (xBtn) xBtn.onclick = onClose;

  paint();
  status(languages().length > 1
    ? '改完直接关掉这个对话框就会存进工程（可用 Ctrl+Z 撤销）。'
    : '还没有别的语言 —— 先添加一门（比如 en），再导出翻译表去填译文。');
}
