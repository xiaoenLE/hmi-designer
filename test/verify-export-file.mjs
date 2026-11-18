// verify-export-file.mjs — 导出文件：**桌面窗口里弹「另存为」自己选目录**，浏览器里还是下载
//
// 为什么要有这个套件：exe（PyWebView + WebView2）窗口里点「导出 CSV」以前**什么都不落盘** ——
//   页面那套 <a download> 没人接（宿主不处理 WebView2 的 DownloadStarting），下载被就地取消：
//   不弹框、不报错、文件一个字节都没有（实测 exe 的 webview profile 下载库里 state=2「已取消」、路径全空）。
//   而 WebView2 里也没有 File System Access 的 showSaveFilePicker（实测 undefined），
//   所以桌面版只能由 Python 那边弹框（server/hmi_desktop.py 的 DesktopApi.save_text）。
//
// 这个套件两半：
//   ① Python：用**假窗口**把 save_text 的三条路跑一遍（选路径 / 取消 / 弹不出来兜底），
//      真弹框是 Windows 原生框，自动化点不了，所以按"逻辑正确 + 写盘字节正确"来验；
//   ② 浏览器：用假 window.pywebview 驱动真实的导出按钮，验"桌面走弹框、浏览器走下载、取消不打扰"。
//
// 用法：node tools/run-suites.mjs verify-export-file
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ══════ ① Python 侧：save_text 的三条路（假窗口，不弹真框） ══════ */
let probe = {};
try {
  const out = execFileSync(PY, [path.join(ROOT, 'test', '_export_save.py'), ROOT],
    { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const line = out.split('\n').find(l => l.startsWith('EXPORT_PROBE ')) || '';
  probe = JSON.parse(line.slice('EXPORT_PROBE '.length) || '{}');
} catch (e) {
  probe = { ok: false, error: String(e.message || e) };
}
ok('Python 探针跑通', probe.ok === true, JSON.stringify(probe).slice(0, 200));
ok('① 用户在保存框里选了路径 → 按选中的路径写盘',
  probe.pick?.ret?.ok === true && probe.pick?.wrote === true && /选中的\.csv$/.test(probe.pick?.ret?.path || ''),
  JSON.stringify(probe.pick?.ret));
ok('① 写下去的就是页面给的那段文本（中文/逗号一个不差）',
  probe.pick?.text === '\ufeff名称,值\r\nA,1\r\n', JSON.stringify(probe.pick?.text));
ok('① CSV 的 UTF-8 BOM 与 CRLF 都保住了（Excel 双击不乱码）',
  probe.pick?.bom === true && probe.pick?.crlf === true);
ok('① 保存框里预填的是导出按钮给的文件名，默认目录不是空的',
  probe.pick?.asked_name === '脚本表-全部.csv' && probe.pick?.asked_dir_nonempty === true,
  JSON.stringify({ n: probe.pick?.asked_name, d: probe.pick?.asked_dir_nonempty }));
ok('② 用户点取消 → 不写文件，回 cancelled（页面据此不弹任何提示）',
  probe.cancel?.ret?.ok === false && probe.cancel?.ret?.cancelled === true && probe.cancel?.wrote === false,
  JSON.stringify(probe.cancel));
ok('③ 两条弹框路都失败 → 兜底写进用户的「下载」文件夹并回 fallback',
  probe.fallback?.ret?.ok === true && probe.fallback?.ret?.fallback === true && probe.fallback?.in_downloads === true
  && probe.fallback?.wrote === true, JSON.stringify(probe.fallback?.ret));
ok('③ 兜底写下去的内容也对（JSON 原样）',
  probe.fallback?.text === '{"app": "hmi-designer"}', String(probe.fallback?.text));
ok('文件名里的非法字符被换成下划线（* ? 之类不许进文件名）',
  probe.safe?.safe === '报表_表_.csv' && probe.safe?.empty === 'export.txt', JSON.stringify(probe.safe));
ok('保存框的过滤器按类型给（csv 一套；工程文件 = .LE + 老 .json 两套都列）',
  JSON.stringify(probe.safe?.types_csv) === JSON.stringify(['CSV 表格 (*.csv)', '所有文件 (*.*)'])
  && JSON.stringify(probe.safe?.types_json) === JSON.stringify(['HMI 工程文件 (*.LE)', '老工程文件 (*.json)', '所有文件 (*.*)']),
  JSON.stringify([probe.safe?.types_csv, probe.safe?.types_json]));
ok('④ 页面回传了完整路径（工程「保存 = 写回上次那个文件」）→ 直接写盘、**不弹框**',
  probe.writeback?.ret?.ok === true && probe.writeback?.wrote === true && probe.writeback?.dialog_calls === 0,
  JSON.stringify(probe.writeback));

/* ══════ ② 浏览器侧：真按钮 + 假 window.pywebview ══════ */
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, acceptDownloads: true });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.writeVar = async () => {};
  m.backend.readVars = async () => null;
}));

// 造两条脚本 + 切到「脚本」面板（导出按钮在那一栏）
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.scripts.length = 0;
  m.addScript({ name: '离线演示模型', trig: 'interval', ms: 500, code: 'hmi.set("rSpeed", 1)' });
  m.addScript({ name: '报表2', trig: 'init', code: 'hmi.log("hi, 逗号")' });
  m.commit('导出测试');
});
const switchPanel = async (id) => {
  await page.evaluate(async (pid) => {
    const btn = document.querySelector(`.lp-tab[data-panel="${pid}"]`);
    if (btn) btn.click();
  }, id);
  await sleep(300);
};
await switchPanel('scripts');

/** 把 window.pywebview 换成假的（模拟桌面窗口 / 模拟出错 / 模拟没有它） */
const stubDesktop = (mode) => page.evaluate((m) => {
  window.__exports = [];
  if (m === 'none') { delete window.pywebview; return; }
  window.pywebview = {
    api: {
      save_text: async (name, text, kind, path) => {
        window.__exports.push({ name, text, kind, path });
        if (m === 'boom') throw new Error('假的：桌面接口炸了');
        if (m === 'cancel') return { ok: false, cancelled: true };
        return { ok: true, path: path || 'D:\\现场\\' + name };   // 给了 path = 不弹框直接写回
      },
    },
  };
}, mode);

const clickExport = async (sel) => {
  // 导出是异步的（await save_text 之后才提示）：点完等一小会儿
  const p = page.click(sel);
  await p;
  await sleep(400);
};

/* ── A. 桌面窗口（假 pywebview）：走弹框，不下载 ── */
await stubDesktop('ok');
let dl = 0;
const onDl = () => { dl++; };
page.on('download', onDl);
await clickExport('#btnScriptCsvOut');
let got = await page.evaluate(() => window.__exports || []);
ok('A 桌面窗口：导出按钮把内容交给了桌面保存接口（弹「另存为」）',
  got.length === 1 && got[0].name === '工程演示-脚本表-全部.csv', JSON.stringify(got.map(g => g.name)));
ok('A 交给桌面接口的是真 CSV（带 BOM + 表头 + 两条脚本的代码，代码里的引号按 CSV 规则转义）',
  /^\ufeff名称,触发/.test(got[0]?.text || '') && /离线演示模型/.test(got[0]?.text || '')
  && /hmi\.log\(""hi, 逗号""\)/.test(got[0]?.text || ''), JSON.stringify((got[0]?.text || '').slice(0, 60)));
ok('A 类型提示传过去了（csv）', got[0]?.kind === 'csv', String(got[0]?.kind));
ok('A 桌面窗口里**不再**走浏览器下载（不然还是那个"点了没反应"）', dl === 0, `download=${dl}`);
const noteA = await page.evaluate(() => document.getElementById('stNote')?.textContent || '');
ok('A 状态栏把导到哪儿了说清楚（完整路径）', /已导出：D:\\现场\\工程演示-脚本表-全部\.csv/.test(noteA), noteA);
const flashA = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#panel-scripts *')].find(x => /已导出/.test(x.textContent || '') && x.children.length === 0);
  return el ? el.textContent.trim() : '';
});
ok('A 面板上那句「已导出…」也带上路径', /已导出全部 2 条脚本/.test(flashA) && /D:\\现场/.test(flashA), flashA);

/* ── B. 桌面上用户点了取消：什么都不做、不刷提示 ── */
await stubDesktop('cancel');
await page.evaluate(() => { const n = document.getElementById('stNote'); if (n) n.textContent = ''; });
await clickExport('#btnScriptCsvOut');
const afterCancel = await page.evaluate(() => ({
  exports: (window.__exports || []).length,
  note: document.getElementById('stNote')?.textContent || '',
}));
ok('B 取消：接口被调用了、但一个文件都不写、也不弹任何提示',
  afterCancel.exports === 1 && afterCancel.note === '' && dl === 0, JSON.stringify(afterCancel));

/* ── C. 桌面接口炸了 → 退回浏览器下载（至少不静默什么都不做） ── */
await stubDesktop('boom');
await page.evaluate(() => { delete window.showSaveFilePicker; });   // 这条验的是"退回下载"
const [dlC] = await Promise.all([page.waitForEvent('download'), clickExport('#btnScriptCsvOut')]);
ok('C 桌面接口出错 → 退回浏览器下载（文件名照旧）',
  /脚本表-全部\.csv$/.test(dlC.suggestedFilename()), dlC.suggestedFilename());
const dlCountAfterC = dl;      // 到这儿已经下载过 1 次（C 那条）；下面 D/E 用它比"没再多下载"

/* ── D. 浏览器：**也弹系统保存框**（File System Access），用户选哪儿就存哪儿 ── */
// 真弹框自动化点不了 → 装一个假 handle，把"写进去的内容"抓下来
const stubPicker = (mode) => page.evaluate((m) => {
  window.__picked = null; window.__written = null; window.__closed = false;
  if (m === 'none') { delete window.showSaveFilePicker; return; }
  window.showSaveFilePicker = async (opts) => {
    window.__picked = opts;
    if (m === 'abort') { const e = new Error('用户取消'); e.name = 'AbortError'; throw e; }
    if (m === 'boom') { const e = new Error('浏览器不让弹'); e.name = 'NotAllowedError'; throw e; }
    return {
      name: '我选的位置.csv',
      createWritable: async () => ({
        write: async (t) => { window.__written = t; },
        close: async () => { window.__closed = true; },
      }),
    };
  };
}, mode);

await stubDesktop('none');            // 普通浏览器（没有 pywebview）
await page.evaluate(() => { const n = document.getElementById('stNote'); if (n) n.textContent = ''; });
await stubPicker('ok');
await clickExport('#btnScriptCsvOut');
let pick = await page.evaluate(() => ({
  picked: window.__picked, written: window.__written, closed: window.__closed,
  note: document.getElementById('stNote')?.textContent || '',
}));
ok('D 浏览器：点导出弹系统保存框，预填的是导出按钮给的文件名',
  pick.picked?.suggestedName === '工程演示-脚本表-全部.csv', JSON.stringify(pick.picked?.suggestedName));
ok('D 保存框按类型给了过滤器（csv）',
  JSON.stringify(pick.picked?.types) === JSON.stringify([{ description: 'CSV 表格', accept: { 'text/csv': ['.csv'] } }]),
  JSON.stringify(pick.picked?.types));
ok('D 写进用户选的那个文件里的就是真 CSV（BOM + 表头 + 代码）',
  /^\ufeff名称,触发/.test(pick.written || '') && /离线演示模型/.test(pick.written || '') && pick.closed === true,
  JSON.stringify((pick.written || '').slice(0, 40)));
ok('D 浏览器里弹了框就**不再**下载（不然会多出一份到「下载」文件夹）', dl === dlCountAfterC, `download=${dl}`);
ok('D 状态栏说清存到"你选的位置"（浏览器拿不到完整路径，只有文件名）',
  /已导出：我选的位置\.csv（存到你选的位置）/.test(pick.note), pick.note);

/* ── E. 浏览器里用户在保存框点取消 → 什么都不做（也不下载） ── */
await page.evaluate(() => { const n = document.getElementById('stNote'); if (n) n.textContent = ''; });
await stubPicker('abort');
await clickExport('#btnScriptCsvOut');
const afterAbort = await page.evaluate(() => ({
  written: window.__written, note: document.getElementById('stNote')?.textContent || '',
}));
ok('E 保存框点取消：不写文件、不下载、也不弹提示',
  afterAbort.written === null && afterAbort.note === '' && dl === dlCountAfterC, JSON.stringify(afterAbort));

/* ── F. 保存框弹不出来（NotAllowedError / 局域网 IP / Firefox）→ 退回下载 ── */
await stubPicker('boom');
const [dlF] = await Promise.all([page.waitForEvent('download'), clickExport('#btnScriptCsvOut')]);
ok('F 保存框弹不出来时退回浏览器下载（不让"导出"变成点了没反应）',
  /脚本表-全部\.csv$/.test(dlF.suggestedFilename()), dlF.suggestedFilename());
await page.evaluate(() => { const n = document.getElementById('stNote'); if (n) n.textContent = ''; });

/* ── G. 老浏览器 / 局域网 IP（没有 showSaveFilePicker）→ 老行为：下载 ── */
await stubPicker('none');
const [dlD] = await Promise.all([page.waitForEvent('download'), clickExport('#btnScriptCsvOut')]);
ok('G 没有保存框接口时：还是下载到「下载」文件夹（老行为不变）', /脚本表-全部\.csv$/.test(dlD.suggestedFilename()),
  dlD.suggestedFilename());
const noteD = await page.evaluate(() => document.getElementById('stNote')?.textContent || '');
ok('G 这种情况状态栏说清是"下载文件夹"', /已导出（浏览器「下载」文件夹）/.test(noteD), noteD);

/* ── H. 变量表 / 报警表 / 单页 / 控件包 都走同一套（桌面弹框） ── */
await stubDesktop('ok');
await switchPanel('vars');
await clickExport('#btnExportVars');
got = await page.evaluate(() => window.__exports || []);
ok('H 变量表导出也走桌面保存框', got.length === 1 && /-变量表\.csv$/.test(got[0].name) && /^\ufeff名称,类型/.test(got[0].text),
  JSON.stringify({ n: got[0]?.name, head: (got[0]?.text || '').slice(0, 12) }));

const pageId = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const mod = await import('/js/editor/pageIO.js');
  const pi = m.pages()[0].id;
  window.__exports = [];
  mod.exportPage(pi);
  return pi;
});
await sleep(400);
got = await page.evaluate(() => window.__exports || []);
ok('H 单页导出（.page.json）也走桌面保存框', got.length === 1 && /\.page\.json$/.test(got[0].name),
  JSON.stringify(got.map(g => g.name)));

const wid = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  const mod = await import('/js/editor/widgetIO.js');
  const w = m.addWidget('bar', 60, 480);
  m.commit('导出用的控件');
  window.__exports = [];
  mod.exportSelection([w.id]);
  return w.id;
});
await sleep(400);
got = await page.evaluate(() => window.__exports || []);
ok('H 控件包导出（.hmiw.json）也走桌面保存框', got.length === 1 && /\.hmiw\.json$/.test(got[0].name),
  JSON.stringify(got.map(g => g.name)));

/* ── I. 桌面窗口里的**工程保存**：另存为弹框、之后「保存」写回同一个文件（不再弹框） ── */
await stubDesktop('ok');
const st = await page.evaluate(async () => {
  const s = (await import('/js/core/storage.js')).storage;
  s.forgetFile();
  window.__exports = [];
  const r1 = await s.saveAs();                       // 第一次：弹「另存为」
  const afterFirst = { r1, cur: s.currentFile(), calls: (window.__exports || []).slice() };
  window.__exports = [];
  const r2 = await s.save();                         // 第二次：按记住的路径写回，不再弹框
  return { afterFirst, r2, calls2: (window.__exports || []).slice(), cur: s.currentFile() };
});
ok('I 桌面窗口「另存为」：弹保存框并把工程交过去（后缀是 .LE）',
  st.afterFirst.r1?.picked === true && /\.LE$/.test(st.afterFirst.calls[0]?.name || '')
  && st.afterFirst.calls[0]?.kind === 'json' && /"app": "hmi-designer"|"meta"/.test(st.afterFirst.calls[0]?.text || ''),
  JSON.stringify({ r1: st.afterFirst.r1, call: st.afterFirst.calls[0]?.name }));
ok('I 存过之后记住文件名（状态栏/标题要显示它）',
  st.afterFirst.cur === st.afterFirst.calls[0]?.name, JSON.stringify({ cur: st.afterFirst.cur }));
ok('I 之后再点「保存」：**带路径**直接写回，不再弹框（桌面窗口没有文件句柄，只能靠回传路径）',
  st.calls2.length === 1 && /现场[\\/].*\.LE$/.test(st.calls2[0].path || '') && st.r2?.inPlace === true,
  JSON.stringify({ r2: st.r2, path: st.calls2[0]?.path }));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 导出文件（桌面弹框 / 浏览器下载）：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);

