// verify-script-enter.mjs — 脚本编辑器「回车换行」专项
//
// 现场反馈：「打一对 {} 然后在里面回车，换不了行」。
// 根因：代码区是「透明 textarea + 下面一层 <pre> 显示高亮」两层结构（css/script.css 里
// .se-area{color:transparent}，用户看见的字其实来自 #seHl）。回车/Tab 走的是 keydown 里
// preventDefault + setRangeText()，而 setRangeText **不会触发 input 事件** →
// 只调了 renderGutter()、没调 renderHl() → 高亮层还停在旧内容上，
// 看着就是「回车按了没反应、换不了行」（再敲一个字符才突然冒出来）。
//
// 这个套件只盯一件事：**每一次让代码变长的键（回车 / Tab），两层必须当场同步**。
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 编辑器要管理员登录过才给（没登录时 / 发的是运行页）——测试里不走登录，见下面注释 */

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

/* 编辑器页要管理员登录过才给（没登录时 / 发的是运行页）。测试里不去碰密码：
   发的就是同一份 index.html / CSS / JS，只是 main.js 在运行页不加载编辑器模块、body 上多个
   .run-only（那个类只负责把编辑器外壳藏起来，见 runtime.css）。所以这里摘掉那个类 +
   手工把编辑器模块叫起来，测的还是**用户真用的那份代码**。 */
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app?.project?.data);
await page.evaluate(() => document.body.classList.remove('run-only'));
// 运行页进来就自动进了运行态（画面盖在最上面，点不到编辑器）→ 退出运行态并收掉那层画面
await page.evaluate(async () => {
  try { await (await import('/js/runtime/runtime.js')).exitRun(); } catch { /* 没在跑就算了 */ }
  const rt = document.getElementById('runtimeRoot');
  if (rt) rt.style.display = 'none';
});
await sleep(200);

const editor = await page.evaluate(async () => {
  const m = await import('/js/editor/scriptEditor.js');
  m.initScriptEditor();          // 编辑态启动时本来就会 init 一次
  m.openScriptEditor();
  return !document.getElementById('seMask').classList.contains('hidden')
    && getComputedStyle(document.getElementById('seMask')).display !== 'none';
});
ok('编辑器浮层能打开（并且真的显示出来了）', editor === true);

await sleep(250);
await page.click('#seCode');     // 真实点击拿焦点（跟用户一样）
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(0, 0);
});
await sleep(150);
ok('打字真的进得去（焦点在代码区）', (await page.evaluate(() => document.activeElement.id)) === 'seCode');

/** 读「用户眼睛看到的东西」：高亮层的文本（textarea 那层字是透明的） */
const snap = () => page.evaluate(() => {
  const ta = document.getElementById('seCode');
  const hl = document.getElementById('seHl');
  const hlText = hl.textContent.replace(/\n$/, '');        // renderHl 末尾补的那个 \n 不算
  return {
    value: ta.value, hl: hlText, same: hlText === ta.value,
    caret: ta.selectionStart,
    gutter: document.getElementById('seGutter').children.length,
  };
});

/* ── 1. 打一对 {} → 光标停在中间，回车 ── */
await page.keyboard.type('{');
await sleep(80);
await page.keyboard.type('}');
await sleep(80);
await page.keyboard.press('ArrowLeft');        // 光标回到 {} 中间
await sleep(80);
await page.keyboard.press('Enter');
await sleep(150);
let s = await snap();
ok('★ 在 {} 中间回车：眼睛看到的那一层（高亮层）当场换行',
  s.value.includes('\n') && s.same, JSON.stringify(s));
ok('★ 回车后光标落在缩进好的空行上，} 自己在最后一行',
  s.value === '{\n  \n}' && s.caret === 4, JSON.stringify({ v: s.value, caret: s.caret }));
ok('行号跟着变成 3 行', s.gutter === 3, String(s.gutter));

/* ── 2. 连着回车：每一下都要看得见新行 ── */
await page.keyboard.press('Enter');
await sleep(120);
await page.keyboard.press('Enter');
await sleep(120);
s = await snap();
ok('★ 连按回车，行数每一下都往上走（不是"按了没反应"）', s.gutter === 5 && s.same,
  JSON.stringify({ gutter: s.gutter, v: s.value }));

/* ── 3. 行尾是 { 时回车：自动缩进一级，高亮层同步 ── */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = "if (hmi.get('bRun')) {";
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
});
await sleep(120);
await page.keyboard.press('Enter');
await sleep(150);
s = await snap();
ok('★ 行尾是 { 时回车：自动缩进一级，且当场看得见',
  s.value === "if (hmi.get('bRun')) {\n  " && s.same && s.caret === s.value.length, JSON.stringify(s));

/* ── 4. 缩进行里回车：缩进跟着走 ── */
await page.keyboard.type("hmi.set('bX', 1)");
await sleep(80);
await page.keyboard.press('Enter');
await sleep(150);
s = await snap();
ok('缩进行回车：新行保持同样缩进', s.value.endsWith('\n  ') && s.same, JSON.stringify({ v: s.value }));

/* ── 5. 空白行上回车：不该越缩越深（缩进清掉） ── */
await page.keyboard.press('Enter');
await sleep(120);
await page.keyboard.press('Enter');
await sleep(120);
s = await snap();
ok('空白行上连着回车：不越缩越深（缩进清掉）', s.value.endsWith('\n\n') && s.same,
  JSON.stringify({ v: s.value }));

/* ── 6. Tab 缩进：同一个坑，也要当场同步 ── */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = 'x';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(0, 0);
});
await sleep(120);
await page.keyboard.press('Tab');
await sleep(150);
s = await snap();
ok('★ Tab 缩进：值是 "  x" 且当场看得见那两个空格', s.value === '  x' && s.same, JSON.stringify(s));

/* ── 7. 原生键（退格）之后两层依旧一致 ── */
await page.keyboard.press('Backspace');
await sleep(120);
s = await snap();
ok('退格（原生键）之后两层依旧一致', s.same, JSON.stringify(s));

/* ── 8. 走一遍现场的真实路径：{ + } → 中间回车 → 在中间那行写代码 → 试运行 ── */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(0, 0);
});
await sleep(120);
await page.keyboard.type('if (true) {}');
await page.keyboard.press('ArrowLeft');        // 光标回到 {} 中间
await page.keyboard.press('Enter');            // ← 就是现场那一下：应该展开成三行
await sleep(150);
s = await snap();
ok('★ 打完 if (true) {} 后在括号里回车：当场展开成三行，光标在中间那行',
  s.value === 'if (true) {\n  \n}' && s.same && s.caret === 14,
  JSON.stringify({ v: s.value, caret: s.caret }));
await page.keyboard.type("hmi.log('ok')");
await sleep(150);
s = await snap();
ok('在中间那行直接写代码，缩进是对的、两层同步',
  s.value === "if (true) {\n  hmi.log('ok')\n}" && s.same, JSON.stringify({ v: s.value }));
await page.evaluate(() => document.getElementById('seRun').click());
await sleep(500);
const runRes = await page.evaluate(() => ({
  code: document.getElementById('seCode').value,
  status: document.getElementById('seStatus').textContent,
  log: document.getElementById('seLog').textContent,
}));
ok('★ 手敲出来的多行代码能过语法检查并试运行（结构没被回车搞坏）',
  /试运行完成/.test(runRes.status) && /ok/.test(runRes.log),
  JSON.stringify({ code: runRes.code, status: runRes.status }));

/* ── 9. 同一个 keydown 里挨着的两件事没被弄坏：Tab 有选中 / Ctrl+S 保存 ── */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = 'ab';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(0, 2);            // 全选
});
await sleep(120);
await page.keyboard.press('Tab');
await sleep(150);
s = await snap();
ok('选中一段按 Tab：替换成缩进（不是被回车分支吃掉）', s.value === '  ' && s.same, JSON.stringify(s));

await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = "hmi.log('c');";
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
});
await sleep(120);
await page.keyboard.press('Control+s');
await sleep(300);
const saveStatus = await page.evaluate(() => document.getElementById('seStatus').textContent);
ok('Ctrl+S 照旧能保存（回车分支没把快捷键吃掉）', /已保存/.test(saveStatus), saveStatus);

/* ── 10. 点右侧 API 速查插入：走的是同一个 afterEdit，两层也要同步 ── */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(0, 0);
  document.querySelector('#seDoc [data-insert]').click();
});
await sleep(200);
s = await snap();
ok('点 API 速查插到光标处：两层同步（插进去的当场看得见）', s.same && s.value.length > 0, JSON.stringify(s));

/* 留一张图，人眼复核一下排版（高亮层真的画成了三行） */
await page.evaluate(() => {
  const ta = document.getElementById('seCode');
  ta.value = "if (true) {\n  hmi.log('ok')\n}";
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(200);
await page.locator('.se-code').screenshot({ path: 'out/enter-fix.png' });

ok('全程没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 脚本编辑器回车/缩进：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
