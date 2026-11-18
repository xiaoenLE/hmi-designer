// verify-run-lang-key.mjs — 运行页（客户机 /run）**用快捷键 Ctrl+Shift+Y 切语言**
//
// 现场反馈（手机 / 触摸屏）：原来想在画面里右键或长按弹语言菜单，电脑上右键好用，
// 但手机 Chrome 长按照样弹它自己的「选字 / 复制」气泡，我们的菜单出不来，长按还会把画面控件误点。
// 所以改成：运行中按 **Ctrl+Shift+Y** 弹语言列表（鼠标/手指点一项即可），再按一次、Esc、点空白处收起；
// 运行页的浏览器右键被拦掉（不再弹原生菜单），编辑器页面不受影响（编辑器自己的右键菜单保留）。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-langkey-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);

/* ── 造一个带文字的工程（标签「启动」）+ 一门英文 + 一条译文（和 verify-i18n-switch 同一份最小工程） ── */
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.replaceData({
    meta: {}, variables: [], alarms: [],
    pages: [{ id: 'pg-lang', name: '主画面', type: 'page', widgets: [
      { id: 'w-lang', type: 'label', x: 60, y: 60, w: 220, h: 60, z: 1,
        props: { text: '启动', fontSize: 24, textColor: '#1f2329', align: 'center' },
        bindings: {}, actions: [] },
    ] }],
  });
  const i18n = await import('/js/core/i18n.js');
  i18n.addLanguage('en', 'English');
  const meta = project.data.meta = project.data.meta || {};
  meta.i18n = meta.i18n || { default: 'zh', langs: [], dict: {} };
  meta.i18n.dict = meta.i18n.dict || {};
  meta.i18n.dict.en = meta.i18n.dict.en || {};
  meta.i18n.dict.en['启动'] = 'Start';
  project.commit('快捷键切语言测试：加英文');
});
await page.waitForTimeout(400);
await page.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  const { project } = await import('/js/core/project.js');
  await backend.rpc('/api/project', { body: { data: project.data } });
});
await page.waitForTimeout(300);
await page.evaluate(() => localStorage.removeItem('hmi-lang'));

const run = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await installPageShim(run);
run.on('pageerror', e => errs.push(String(e)));
run.on('dialog', d => d.accept());
await run.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await run.goto(H + '/run', { waitUntil: 'load' });
await run.waitForFunction(() => document.querySelector('#rtPage .wd'), null, { timeout: 15000 });
await sleep(800);

/* 页面里的小工具：查菜单 / 记录画面上的点击 */
await run.evaluate(() => {
  const rt = document.getElementById('rtPage');
  window.__t = {
    clicks: 0,
    menu() {
      const items = [...document.querySelectorAll('#runtimeRoot [data-lang]')];
      const r = items[0]?.getBoundingClientRect();
      return {
        n: items.length,
        codes: items.map(i => i.getAttribute('data-lang')),
        checked: items.filter(i => (i.textContent || '').includes('✓')).map(i => i.getAttribute('data-lang')),
        rect: r ? { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
      };
    },
    pressY() {
      // 和现场按键一致：keydown 到 document（Ctrl+Shift+Y）
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    },
    pressEsc() {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
      }));
    },
    // 模拟手机/触摸屏长按：先 pointerdown 再 contextmenu（Chrome 会补），看会不会弹浏览器菜单
    touchHold(x, y) {
      rt.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
      }));
      return new Promise(res => setTimeout(() => {
        const ev = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
        });
        rt.dispatchEvent(ev);
        rt.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0,
        }));
        res(ev.defaultPrevented);
      }, 700));
    },
    // 双指轻点：两根手指几乎同时按下、都不动、再抬起
    dualTap(x1, y1, x2, y2, opts = {}) {
      const pd = (id, x, y) => rt.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: id, pointerType: 'touch', isPrimary: id === 11, button: 0, buttons: 1,
      }));
      const pu = (id, x, y) => rt.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: id, pointerType: 'touch', isPrimary: id === 11, button: 0, buttons: 0,
      }));
      const pm = (id, x, y) => rt.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: id, pointerType: 'touch', isPrimary: id === 11, button: 0, buttons: 1,
      }));
      return new Promise(res => setTimeout(() => {
        const target = opts.target || rt;
        target.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: x1, clientY: y1,
          pointerId: 11, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
        }));
        target.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: x2, clientY: y2,
          pointerId: 12, pointerType: 'touch', isPrimary: false, button: 0, buttons: 1,
        }));
        const afterDown = () => {
          if (opts.move) {   // 双指按下后一起横向挪动：像拖动/捏合，不该算轻点
            pm(11, x1 + opts.move, y1); pm(12, x2 + opts.move, y2);
          }
          setTimeout(() => {
            pu(11, x1 + (opts.move || 0), y1);
            pu(12, x2 + (opts.move || 0), y2);
            res(true);
          }, 120);
        };
        afterDown();
      }, 0));
    },
    // 单指轻点（对照：不该弹菜单）
    singleTap(x, y) {
      const pd = () => rt.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: 13, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
      }));
      const pu = () => rt.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: 13, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0,
      }));
      return new Promise(res => setTimeout(() => { pd(); setTimeout(() => { pu(); res(true); }, 90); }, 0));
    },
  };
  rt.addEventListener('click', () => { window.__t.clicks++; });
});

const menuInfo = () => run.evaluate(() => window.__t.menu());
const isMenuOpen = async () => (await menuInfo()).n > 0;

/* ── 1. 进来先确认没有语言菜单（画面干净） ── */
ok('运行页打开时没有语言菜单（画面干净，不用点）', !(await isMenuOpen()), JSON.stringify(await menuInfo()));

/* ── 2. Ctrl+Shift+Y：弹语言菜单（每门语言一项，当前那门打 ✓，位置在画面中上方） ── */
await run.evaluate(() => window.__t.pressY());
await run.waitForTimeout(250);
const m1 = await menuInfo();
ok('★ 运行中按 Ctrl+Shift+Y → 弹出语言菜单（zh-CN / en 两项，当前语言打 ✓）',
  m1.n >= 2 && m1.codes.includes('zh-CN') && m1.codes.includes('en') && m1.checked.length === 1,
  JSON.stringify(m1));
ok('语言菜单显示在画面中上方（不贴边、不挡右下角提示条）',
  !!m1.rect && m1.rect.left > 200 && m1.rect.top > 40 && m1.rect.top < 400, JSON.stringify(m1.rect));

/* ── 3. 再按一次 → 收起（同一个键弹/收） ── */
await run.evaluate(() => window.__t.pressY());
await run.waitForTimeout(200);
ok('再按一次 Ctrl+Shift+Y → 语言菜单收起', !(await isMenuOpen()));

/* ── 4. Esc 只收菜单，不退出运行（Esc 本来是「退出运行」） ── */
await run.evaluate(() => window.__t.pressY());
await run.waitForTimeout(200);
await run.evaluate(() => window.__t.pressEsc());
await run.waitForTimeout(250);
const afterEsc = await run.evaluate(() => ({
  menu: document.querySelectorAll('#runtimeRoot [data-lang]').length,
  stillRun: !!document.getElementById('rtPage') && getComputedStyle(document.getElementById('rtPage')).display !== 'none',
  bodyRunOnly: document.body.classList.contains('run-only'),
}));
ok('菜单开着时按 Esc → 只收起菜单，没有退出运行',
  afterEsc.menu === 0 && afterEsc.stillRun && afterEsc.bodyRunOnly, JSON.stringify(afterEsc));

/* ── 5. 点空白处 → 菜单关掉；画面照常收到点击（没有吞点击） ── */
await run.evaluate(() => window.__t.pressY());
await run.waitForTimeout(200);
const clicksBefore = await run.evaluate(() => window.__t.clicks);
await run.evaluate(() => {
  document.getElementById('rtPage').dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, clientX: 900, clientY: 600,
  }));
});
await run.waitForTimeout(250);
const outside = await run.evaluate(() => ({ menu: document.querySelectorAll('#runtimeRoot [data-lang]').length, clicks: window.__t.clicks }));
ok('点菜单外面 → 菜单关闭，画面上的点击照常生效',
  outside.menu === 0 && outside.clicks === (await clicksBefore) + 1, JSON.stringify(outside));

/* ── 6. 快捷键弹菜单 → 选 English → 画面当场变 Start、选择记在本机、菜单收起 ── */
await run.evaluate(() => window.__t.pressY());
await run.waitForTimeout(250);
await run.click('#runtimeRoot [data-lang="en"]');
await run.waitForTimeout(500);
const afterPick = await run.evaluate(() => ({
  text: document.querySelector('#rtPage .wd')?.textContent || '',
  lang: localStorage.getItem('hmi-lang'),
  menu: document.querySelectorAll('#runtimeRoot [data-lang]').length,
}));
ok('★ Ctrl+Shift+Y 菜单里选 English → 画面当场变 Start、选择记在本机、菜单收起',
  /Start/.test(afterPick.text) && afterPick.lang === 'en' && afterPick.menu === 0,
  JSON.stringify(afterPick));

// 再切回中文（后面的断言按中文看画面）
await run.evaluate(() => window.__t.pressY());
await run.waitForTimeout(250);
await run.click('#runtimeRoot [data-lang="zh-CN"]');
await run.waitForTimeout(400);
ok('再切回中文 → 画面恢复「启动」',
  /启动/.test(await run.evaluate(() => document.querySelector('#rtPage .wd')?.textContent || '')));

/* ── 7. 运行页右键被拦掉：不弹浏览器原生菜单，也**不再**弹我们的菜单（入口只有快捷键） ── */
const ctxRun = await run.evaluate(() => {
  const el = document.getElementById('rtPage');
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 260 });
  el.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, menu: document.querySelectorAll('#runtimeRoot [data-lang]').length };
});
ok('运行页右键被拦掉（浏览器原生菜单不弹），且不弹语言菜单（语言只走 Ctrl+Shift+Y）',
  ctxRun.prevented && ctxRun.menu === 0, JSON.stringify(ctxRun));

/* ── 8. 手机/触摸屏长按：浏览器补的 contextmenu 同样被拦掉，手机会弹的「选字/复制」气泡不出现 ── */
const holdPrevented = await run.evaluate(() => window.__t.touchHold(420, 320));
await run.waitForTimeout(250);
ok('触摸屏长按 0.7 秒 → 不弹我们的菜单，浏览器补的 contextmenu 被拦掉',
  holdPrevented === true && !(await isMenuOpen()), JSON.stringify({ holdPrevented }));

/* ── 9. 手机 / 触摸屏没有键盘 → **双指轻点画面**弹语言菜单 ── */
await run.evaluate(() => window.__t.singleTap(520, 380));
await run.waitForTimeout(200);
ok('单指轻点 → 不弹语言菜单（画面按钮照常点，不误触）', !(await isMenuOpen()));
await run.evaluate(() => window.__t.dualTap(430, 300, 520, 360));
await run.waitForTimeout(250);
const mDual = await menuInfo();
ok('★ 双指轻点画面 → 弹出语言菜单（手机 / 触摸屏没有键盘也能切语言）',
  mDual.n >= 2 && mDual.codes.includes('zh-CN') && mDual.codes.includes('en'), JSON.stringify(mDual));

/* 双指按下后一起划动（像拖动 / 捏合缩放）→ 不算轻点 */
await run.evaluate(() => window.__t.pressEsc());
await run.waitForTimeout(150);
await run.evaluate(() => window.__t.dualTap(500, 320, 620, 380, { move: 120 }));
await run.waitForTimeout(250);
ok('双指按下后一起划动（拖动 / 捏合）→ 不弹菜单', !(await isMenuOpen()));

/* 输入框上双指轻点 → 不抢（留给选字 / 粘贴） */
await run.evaluate(() => {
  const inp = document.createElement('input');
  inp.id = 'dualProbeInput';
  inp.style.cssText = 'position:absolute;left:20px;top:420px;width:160px;height:30px;z-index:9';
  document.getElementById('rtPage').appendChild(inp);
});
await run.evaluate(() => window.__t.dualTap(60, 430, 150, 440, { target: document.getElementById('dualProbeInput') }));
await run.waitForTimeout(250);
ok('输入框上双指轻点 → 不弹语言菜单（留给选字 / 粘贴）', !(await isMenuOpen()));
await run.evaluate(() => document.getElementById('dualProbeInput')?.remove());

/* 双指轻点弹出的菜单里选语言 → 真能切（吞点击只吞"按下的那个元素"，不吞菜单项） */
await run.evaluate(() => window.__t.dualTap(430, 300, 520, 360));
await run.waitForTimeout(250);
const dualMenu = await menuInfo();
await run.click('#runtimeRoot [data-lang="en"]');
await run.waitForTimeout(500);
const dualPick = await run.evaluate(() => ({
  text: document.querySelector('#rtPage .wd')?.textContent || '',
  lang: localStorage.getItem('hmi-lang'),
  menu: document.querySelectorAll('#runtimeRoot [data-lang]').length,
}));
ok('★ 双指轻点菜单里选 English → 画面当场变 Start、选择记本机、菜单收起',
  dualMenu.n >= 2 && /Start/.test(dualPick.text) && dualPick.lang === 'en' && dualPick.menu === 0,
  JSON.stringify({ dualMenu, dualPick }));

// 切回中文（后面按中文看提示）
await run.evaluate(() => window.__t.pressY());
await run.waitForTimeout(250);
await run.click('#runtimeRoot [data-lang="zh-CN"]');
await run.waitForTimeout(400);

/* ── 9. 快捷键提示里写明 Ctrl+Shift+Y（现场知道怎么切） ──
   2.1.4 起客户机运行页开机**不再自动弹**提示条（现场嫌它挡画面）——
   要看得手动叫出来（编辑器右键菜单「快捷键提示」调的就是同一个函数），这里手动调一次看文案 */
const hint = await run.evaluate(async () => {
  const m = await import('/js/runtime/runtime.js');
  const el = document.getElementById('rtHint');
  const bootHidden = !el || el.classList.contains('hidden');
  m.showRuntimeHint(5000);
  await new Promise((r) => setTimeout(r, 150));
  if (!el) return { bootHidden, hidden: true, html: '' };
  return { bootHidden, hidden: el.classList.contains('hidden'), html: el.innerHTML };
});
ok('开机进运行态不自动弹提示条（2.1.4 现场口径）', hint.bootHidden === true, JSON.stringify({ bootHidden: hint.bootHidden }));
ok('快捷键提示里写明 Ctrl+Shift+Y 切换语言（手动叫出来看）',
  /Ctrl/.test(hint.html) && /Shift/.test(hint.html) && /Y/.test(hint.html) && /切换语言/.test(hint.html),
  JSON.stringify({ hidden: hint.hidden }));

/* ── 10. 编辑器页面：Ctrl+Shift+Y 不弹运行页菜单（编辑器自己的右键菜单保留，不受运行页拦截影响） ── */
const ctxEditor = await page.evaluate(() => {
  const before = document.querySelectorAll('#runtimeRoot [data-lang]').length;
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  return { before, after: document.querySelectorAll('#runtimeRoot [data-lang]').length };
});
ok('编辑器页面按 Ctrl+Shift+Y 不弹运行页语言菜单（编辑器右键菜单照旧）',
  ctxEditor.after === ctxEditor.before && ctxEditor.after === 0, JSON.stringify(ctxEditor));

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
const fails = results.filter(r => !r.ok).length;
console.log(`\n==== 运行页快捷键切语言回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
