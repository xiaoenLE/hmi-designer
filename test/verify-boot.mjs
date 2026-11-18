// verify-boot.mjs — 启动自检：不得出现「外壳在、面板全空」的白屏
//   1) 双击 index.html（file://）→ 明确提示改用 start_server.bat
//   2) 正常服务访问 → 无提示且各面板都有内容
//   3) 模块加载失败（缓存旧页面等）→ 4 秒后给 Ctrl+F5 提示
//   4) HTML 与 JS 版本不匹配（少一个面板元素）→ 仍能启动，不整体崩
// 用法：先启动 8866 服务，再 node test/verify-boot.mjs [端口]
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = `http://127.0.0.1:${process.argv[2] || '8866'}/`;
const FILE_URL = 'file:///C:/Users/Administrator/Desktop/hmi/hmi-designer/index.html';

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });

/* ══════ 1. 双击打开（file://）══════ */
{
  const p = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await p.goto(FILE_URL, { waitUntil: 'load' });
  await p.waitForTimeout(600);
  const hint = await p.evaluate(() => {
    const el = document.getElementById('bootHint');
    return { hidden: el.classList.contains('hidden'), text: el.textContent, visible: el.getBoundingClientRect().height > 0 };
  });
  ok('file:// 直接打开 → 立刻给出提示（不是白屏）', !hint.hidden && hint.visible, hint.hidden ? '提示未出现' : '');
  ok('提示里写明要用 start_server.bat / 服务地址',
    hint.text.includes('start_server.bat') && /127\.0\.0\.1:\d+/.test(hint.text), hint.text.slice(0, 60));
  ok('提示不是空白界面（画布确实没渲染出来）', await p.evaluate(() => document.querySelectorAll('#canvas .wd').length) === 0);
  await p.close();
}

/* ══════ 2. 正常服务访问：无提示 + 各面板都有内容 ══════ */
{
  const p = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route(u => u.pathname.startsWith('/api/'), r => r.abort());
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.app?.project?.data);
  await p.waitForTimeout(600);
  const state = await p.evaluate(() => ({
    hintHidden: document.getElementById('bootHint').classList.contains('hidden'),
    toolbox: document.querySelectorAll('#toolboxList .tb-item').length,
    canvas: document.querySelectorAll('#canvas .wd').length,
    pages: document.querySelectorAll('#pageList .pg-item').length,
    vars: document.querySelectorAll('#varTable tr').length,
    dockTabs: [...document.querySelectorAll('#leftPanel .lp-tab')].map(t => t.textContent),
    propPanel: !!document.getElementById('propBody'),
  }));
  ok('正常访问 → 不弹启动提示', state.hintHidden);
  ok('控件库 / 画布 / 页面 / 变量 全都有内容',
    state.toolbox > 0 && state.canvas > 0 && state.pages > 0 && state.vars > 0, JSON.stringify(state));
  ok('左侧停靠区标签齐全', JSON.stringify(state.dockTabs) === JSON.stringify(['控件', '页面', '变量', '报警', '脚本', '清单']), JSON.stringify(state.dockTabs));
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  await p.close();
}

/* ══════ 3. 模块加载失败（模拟缓存了旧页面/JS 加载被拦）→ 4 秒后提示 ══════ */
{
  const p = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await p.route('**/js/main.js', r => r.abort());     // 让入口模块加载失败
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(700);
  const early = await p.evaluate(() => document.getElementById('bootHint').classList.contains('hidden'));
  await p.waitForTimeout(4000);
  const late = await p.evaluate(() => {
    const el = document.getElementById('bootHint');
    return { hidden: el.classList.contains('hidden'), text: el.textContent };
  });
  ok('入口模块没加载时不立刻误报（4 秒内不弹）', early === true);
  ok('模块加载失败 → 4 秒后给出 Ctrl+F5 提示', !late.hidden && late.text.includes('Ctrl+F5'), late.text.slice(0, 80));
  await p.close();
}

/* ══════ 4. HTML/JS 版本不匹配（页面里少一个面板）→ 仍能启动 ══════ */
{
  const p = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route(u => u.pathname.startsWith('/api/'), r => r.abort());
  // 拦下 index.html，去掉「变量」面板元素，模拟旧页面 + 新 JS
  await p.route(URL, async route => {
    const resp = await route.fetch();
    let html = await resp.text();
    html = html.replace(/<section class="panel" id="panel-vars"[\s\S]*?<\/section>/, '');
    await route.fulfill({ response: resp, body: html, headers: { ...resp.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
  await p.goto(URL, { waitUntil: 'networkidle' });
  const booted = await p.waitForFunction(() => window.app?.project?.data, { timeout: 8000 }).then(() => true).catch(() => false);
  await p.waitForTimeout(300);
  const state = await p.evaluate(() => ({
    toolbox: document.querySelectorAll('#toolboxList .tb-item').length,
    canvas: document.querySelectorAll('#canvas .wd').length,
    tabs: [...document.querySelectorAll('#leftPanel .lp-tab')].map(t => t.textContent),
  }));
  ok('少一个面板时界面仍能启动（不再整体崩）', booted && state.toolbox > 0 && state.canvas > 0, JSON.stringify(state));
  ok('其余面板标签正常（缺的那个自动跳过）', !state.tabs.includes('变量') && state.tabs.includes('控件'), JSON.stringify(state.tabs));
  ok('这种情况没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  await p.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n==== 启动自检回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
