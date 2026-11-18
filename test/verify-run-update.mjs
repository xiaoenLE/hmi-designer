// verify-run-update.mjs — 运行画面（客户机 /run）右下角的「有新版本」提示
//   现场要求（用户原话）：「如果有新版本可以在运行页面右下角显示最新版本，点击可以进行更新」
//   ① 没有新版本 / 没开更新检查 / 连不上更新服务器 → **什么都不显示**（画面保持干净）
//   ② 有新版本 → 右下角出现小徽标，写清「新版本 V2.2.0」，钉在 right/bottom 12px
//   ③ 点徽标 → 弹出更新面板：当前版本 → 新版本、更新说明、「稍后」/「立即更新」
//   ④ 「稍后」→ 面板关掉，徽标还在（下次还能点）
//   ⑤ 「立即更新」→ 调 backend.applyUpdate；更新失败给提示 + 按钮可重试；
//      成功 → 等后端重启回来 → 写 sessionStorage 标记 → 自动刷新页面，刷新后徽标消失
//   ⑥ 编辑器页面不挂这个徽标（编辑器有自己的状态栏更新提示）
// 用法：node test/verify-run-update.mjs（自己拉起一个隔离后端 + 临时数据目录）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch, wsHealth } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const out = [];
const ok = (n, c, e = '') => out.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-runupd-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40; i++) { await sleep(300); try { await wsHealth(PORT); up = true; break; } catch { /* 等 */ } }
if (!up) { console.log('FAIL  后端没起来'); try { srv.kill(); } catch { /* 忽略 */ } process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await installPageShim(ctx);
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());

/** 在页面里把「更新」相关的后端接口换成可控假货：
 *  fake.available=true → 有新版；applyUpdate 第一次抛异常、之后按 phase 成功并让 isOnline 变 true */
const stubUpdate = async (p, opts = {}) => p.evaluate(async (o) => {
  const { backend } = await import('/js/api/backend.js');
  const U = window.__upd = {
    calls: { check: 0, apply: 0 },
    fake: { available: false, state: 'uptodate', local: { version: '2.1.0' }, remote: null },
    toVersion: o.toVersion || '2.2.0',
    phase: 'idle',
    failOnce: o.failOnce !== false,
    supported: o.supported !== false,
  };
  backend.supports = (f) => U.supported && (f === 'update_check' || f === 'update_apply');
  backend.checkUpdate = async () => { U.calls.check++; return U.fake; };
  backend.applyUpdate = async () => {
    U.calls.apply++;
    if (U.failOnce) { U.failOnce = false; U.phase = 'failed'; throw new Error('模拟网络中断'); }
    U.phase = 'applied';
    U.fake = { available: false, state: 'uptodate', local: { version: U.toVersion }, remote: null };
    backend.version = { version: U.toVersion };
    return { ok: true, from_version: '2.1.0', to_version: U.toVersion, copied: 12 };
  };
  backend.isOnline = () => U.phase === 'applied';
  backend.probe = async () => ({ version: { version: U.toVersion } });
  return true;
}, opts);

const refresh = async (p) => p.evaluate(async () => {
  const m = await import('/js/runtime/runUpdate.js');
  await m.refreshRunUpdate(false);
});

const openRun = async (p) => {
  await p.goto(H + '/run', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelectorAll('#rtPage .wd').length > 0, null, { timeout: 15000 });
  await sleep(200);
};

/* ══════ 1. 没有新版本 → 干净，什么都不挂 ══════ */
await openRun(page);
await stubUpdate(page, {});          // 默认 available:false
await refresh(page);
await sleep(250);
const noBadge = await page.evaluate(() => {
  const b = document.getElementById('rtUpdBadge');
  return { exists: !!b, shown: !!b && getComputedStyle(b).display !== 'none',
    panel: !!document.getElementById('rtUpdPanel') };
});
ok('没有新版本时：右下角什么都不出现（画面保持干净）',
  noBadge.exists === false || noBadge.shown === false, JSON.stringify(noBadge));
ok('没有新版本时：也不弹更新面板', noBadge.panel === false, String(noBadge.panel));

/* ══════ 2. 有新版本 → 右下角徽标 ══════ */
await page.evaluate(() => {
  window.__upd.fake = { available: true, state: 'available', local: { version: '2.1.0' },
    remote: { version: '2.2.0', date: '2025-08-01', notes: '修复了若干问题\n新增 XY 波形模式与双 Y 轴' } };
});
await refresh(page);
await sleep(300);
const badge = await page.evaluate(() => {
  const b = document.getElementById('rtUpdBadge');
  if (!b) return { exists: false };
  const r = b.getBoundingClientRect();
  const notice = document.getElementById('rtNotice');
  const nv = notice && !notice.classList.contains('hidden') && notice.getBoundingClientRect().width > 0
    ? notice.getBoundingClientRect() : null;
  return { exists: true, shown: getComputedStyle(b).display !== 'none' && r.width > 0 && r.height > 0,
    text: b.textContent, position: getComputedStyle(b).position,
    rightGap: Math.round(window.innerWidth - r.right), bottomGap: Math.round(window.innerHeight - r.bottom),
    overlapsNotice: !!(nv && !(r.bottom <= nv.top + 1)), noticeShown: !!nv,
    panel: !!document.getElementById('rtUpdPanel') };
});
ok('有新版本时：右下角出现徽标（fixed 定位、贴右边 12px；被提示条占着时自动往上让开）',
  badge.shown === true && badge.position === 'fixed'
  && Math.abs(badge.rightGap - 12) <= 6 && badge.bottomGap >= 8 && badge.overlapsNotice === false,
  JSON.stringify({ shown: badge.shown, position: badge.position, rightGap: badge.rightGap,
    bottomGap: badge.bottomGap, noticeShown: badge.noticeShown, overlapsNotice: badge.overlapsNotice }));
ok('徽标上直接写明「新版本 V2.2.0」（现场一眼看到最新版本号）',
  /新版本/.test(badge.text || '') && /V2\.2\.0/.test(badge.text || '') && /更新/.test(badge.text || ''),
  badge.text);
ok('刚出现时只有徽标，不弹面板（不挡画面）', badge.panel === false, String(badge.panel));

/* ══════ 3. 点徽标 → 更新面板（说明 + 稍后/立即更新） ══════ */
await page.click('#rtUpdBadge');
await sleep(300);
const panel = await page.evaluate(() => {
  const p = document.getElementById('rtUpdPanel');
  if (!p) return { exists: false };
  const r = p.getBoundingClientRect(), b = document.getElementById('rtUpdBadge').getBoundingClientRect();
  return { exists: true, text: p.textContent, notes: /修复了若干问题/.test(p.textContent),
    hasLater: !!p.querySelector('[data-upd-later]'), hasIgnore: !!p.querySelector('[data-upd-ignore]'),
    hasGo: !!p.querySelector('[data-upd-go]'),
    hasVersions: /V2\.1\.0/.test(p.textContent) && /V2\.2\.0/.test(p.textContent),
    aboveBadge: r.bottom <= b.top + 1 };
});
ok('点徽标 → 打开更新面板（当前版本 → 新版本号都在）',
  panel.exists === true && panel.hasVersions === true, JSON.stringify({ exists: panel.exists, versions: panel.hasVersions }));
ok('面板里带本次更新说明（notes 原样显示，换行保留）', panel.notes === true);
ok('面板里有「稍后」「忽略此版本」和「立即更新」三个按钮',
  panel.hasLater && panel.hasIgnore && panel.hasGo, JSON.stringify([panel.hasLater, panel.hasIgnore, panel.hasGo]));
ok('面板开在徽标上方（不把徽标挡住）', panel.aboveBadge === true, String(panel.aboveBadge));

/* ══════ 4. 「稍后」→ 面板关掉，徽标还在 ══════ */
await page.click('#rtUpdPanel [data-upd-later]');
await sleep(250);
const later = await page.evaluate(() => ({
  panel: !!document.getElementById('rtUpdPanel'),
  badge: (() => { const b = document.getElementById('rtUpdBadge');
    return !!b && getComputedStyle(b).display !== 'none'; })(),
}));
ok('点「稍后」→ 面板关掉、徽标留着（下次还能点）',
  later.panel === false && later.badge === true, JSON.stringify(later));

/* ══════ 4b. 「忽略此版本」→ 这一版不再提示；出了更新的版本号还会提示 ══════ */
await page.click('#rtUpdBadge');
await sleep(250);
await page.click('#rtUpdPanel [data-upd-ignore]');
await sleep(250);
const ignored = await page.evaluate(() => ({
  panel: !!document.getElementById('rtUpdPanel'),
  badge: (() => { const b = document.getElementById('rtUpdBadge');
    return !!b && getComputedStyle(b).display !== 'none'; })(),
  saved: localStorage.getItem('hmi.run.updateIgnored') || '',
}));
ok('点「忽略此版本」→ 面板收起、右下角徽标消失，并且把这一版记在本机',
  ignored.panel === false && ignored.badge === false && ignored.saved === '2.2.0', JSON.stringify(ignored));
// 同一版再查一次（模拟重启后 /run 又检查了一遍）→ 仍然不提示
await refresh(page);
await sleep(250);
const ignoredAgain = await page.evaluate(() => {
  const b = document.getElementById('rtUpdBadge');
  return { badge: !!b && getComputedStyle(b).display !== 'none', saved: localStorage.getItem('hmi.run.updateIgnored') || '' };
});
ok('忽略之后同一版再查还是不提示（记在 localStorage，刷新/重开浏览器都记得）',
  ignoredAgain.badge === false && ignoredAgain.saved === '2.2.0', JSON.stringify(ignoredAgain));
// 下一版（2.2.1）发布 → 照旧提示（忽略只针对那一版）
await page.evaluate(() => { window.__upd.fake.remote.version = '2.2.1'; });
await refresh(page);
await sleep(300);
const newerVer = await page.evaluate(() => {
  const b = document.getElementById('rtUpdBadge');
  return { badge: !!b && getComputedStyle(b).display !== 'none', text: b ? b.textContent : '' };
});
ok('又出了更新的版本（V2.2.1）→ 右下角照旧提示（忽略只管点过的那一版）',
  newerVer.badge === true && /V2\.2\.1/.test(newerVer.text || ''), JSON.stringify(newerVer));
// 复原：清掉忽略记录、版本号回到 2.2.0，继续验「立即更新」
await page.evaluate(() => {
  localStorage.removeItem('hmi.run.updateIgnored');
  window.__upd.fake.remote.version = '2.2.0';
});
await refresh(page);
await sleep(250);
const restored = await page.evaluate(() => {
  const b = document.getElementById('rtUpdBadge');
  return { badge: !!b && getComputedStyle(b).display !== 'none' };
});
ok('清掉忽略记录后，同一版又提示（本机记录可恢复）', restored.badge === true, JSON.stringify(restored));

/* ══════ 5. 立即更新：先失败（可重试），再成功（刷新页面） ══════ */
await page.click('#rtUpdBadge');
await sleep(250);
const loadP = page.waitForEvent('load', { timeout: 25000 });
await page.click('#rtUpdPanel [data-upd-go]');
await page.waitForFunction(() => window.__upd && window.__upd.calls.apply === 1, null, { timeout: 8000 });
await page.waitForFunction(() => {
  const p = document.getElementById('rtUpdPanel');
  return p && /请求没成功/.test(p.textContent);
}, null, { timeout: 10000 });
const failPanel = await page.evaluate(() => {
  const p = document.getElementById('rtUpdPanel');
  const go = p.querySelector('[data-upd-go]');
  return { text: p.textContent, btn: go.textContent, disabled: go.disabled };
});
ok('更新请求失败 → 面板给出失败原因，按钮变「再试一次」且可点（不卡死）',
  /请求没成功/.test(failPanel.text) && failPanel.btn === '再试一次' && failPanel.disabled === false,
  JSON.stringify({ btn: failPanel.btn, disabled: failPanel.disabled }));

await page.click('#rtUpdPanel [data-upd-go]');          // 第二次：成功
await page.waitForFunction(() => window.__upd && window.__upd.calls.apply === 2, null, { timeout: 15000 });
// 成功后：面板先写「更新成功」，再过 1.5 秒自动刷新页面 —— 机器忙 / 并行跑套件的时候，
// 可能刚好卡在两次采样之间页面就刷掉了（文案来不及看到）。所以「看到文案」和
// 「看到刷新标记 sessionStorage」有一个就够（标记就是刷新前写进去的那个）。
await page.waitForFunction(() => {
  const p = document.getElementById('rtUpdPanel');
  return (p && /更新成功/.test(p.textContent))
    || sessionStorage.getItem('hmi.update.done') === '2.2.0';
}, null, { timeout: 30000 });
const okPanel = await page.evaluate(() => {
  const p = document.getElementById('rtUpdPanel');
  return { text: (p && p.textContent) || '', marker: sessionStorage.getItem('hmi.update.done') || '' };
});
ok('更新成功 → 面板说「更新成功」并写上 sessionStorage 标记（刷新回来知道刚更新过）',
  okPanel.marker === '2.2.0' && (okPanel.text === '' || /更新成功/.test(okPanel.text)),
  JSON.stringify({ text: okPanel.text, marker: okPanel.marker }));
await loadP;                                            // 等自动刷新那一下
await page.waitForFunction(() => document.querySelectorAll('#rtPage .wd').length > 0, null, { timeout: 15000 });
await sleep(3600);                                      // 越过启动后 3s 的更新检查
const afterReload = await page.evaluate(() => {
  const b = document.getElementById('rtUpdBadge');
  return { badge: !!b && getComputedStyle(b).display !== 'none',
    panel: !!document.getElementById('rtUpdPanel'),
    marker: sessionStorage.getItem('hmi.update.done') || '' };
});
ok('更新完自动刷新；新版本起来后徽标消失（不再提示更新）',
  afterReload.badge === false && afterReload.panel === false, JSON.stringify(afterReload));

/* ══════ 6. 后端不支持更新检查 / 更新被关掉 → 不显示、也不发请求 ══════ */
const page2 = await ctx.newPage();
await page2.on('pageerror', e => errs.push(String(e)));
await openRun(page2);
await page2.evaluate(async () => {
  const { backend } = await import('/js/api/backend.js');
  window.__updCalls = 0;
  backend.supports = () => false;                       // 老版本后端 / 检查被关
  backend.checkUpdate = async () => { window.__updCalls++; return { available: true,
    local: { version: '2.1.0' }, remote: { version: '9.9.9', notes: 'x' } }; };
  const m = await import('/js/runtime/runUpdate.js');
  await m.refreshRunUpdate(true);
});
await sleep(300);
const unsup = await page2.evaluate(() => { const b = document.getElementById('rtUpdBadge');
  return { badge: !!b && getComputedStyle(b).display !== 'none', calls: window.__updCalls }; });
ok('后端不支持更新（supports=false）→ 不显示徽标，也不去请求更新检查',
  unsup.badge === false && unsup.calls === 0, JSON.stringify(unsup));
await page2.close();

/* ══════ 7. 编辑器页面不挂运行页徽标 ══════ */
const ed = await ctx.newPage();
await ed.on('pageerror', e => errs.push(String(e)));
await ed.goto(H + '/', { waitUntil: 'domcontentloaded' });
await ed.waitForFunction(() => window.app && window.app.project && window.app.project.data, null, { timeout: 15000 });
await sleep(3600);                                       // 越过 3s 那次检查
const editorBadge = await ed.evaluate(() => ({
  badge: !!document.getElementById('rtUpdBadge'),
  editor: !document.body.classList.contains('run-only') && !!document.getElementById('workspace'),
}));
ok('编辑器页面不挂运行页右下角徽标（编辑器有自己的状态栏更新提示）',
  editorBadge.badge === false && editorBadge.editor === true, JSON.stringify(editorBadge));
await ed.close();

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

const pass = out.filter(l => l.startsWith('PASS')).length;
console.log(out.join('\n'));
console.log(`\n==== 运行页「有新版本」右下角提示 + 一键更新：${pass}/${out.length} 通过 ====`);
try { await browser.close(); } catch { /* 忽略 */ }
try { srv.kill(); } catch { /* 忽略 */ }
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
