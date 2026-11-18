// verify-popup-size.mjs — 弹窗（弹窗页）的高度：标题栏/关闭按钮**不能挤掉内容**
//   现场反馈：给弹窗开了关闭按钮之后，贴底的控件显示不全。
//   原因：卡片高度写死成「弹窗高」，而标题栏是 flex:none、会从卡片高度里分走约 37px，
//         内容区只剩 h-37，overflow:hidden 就把底部切了。
//   现在的口径：**内容区固定 = 页面属性里的「弹窗高」**（控件就是按这个坐标系画的），
//              卡片总高自动 = 标题栏（有标题/有关闭按钮时才有）+ 内容区。
// 用法：node test/verify-popup-size.mjs   （自己拉起一个独立数据目录的后端，不碰 8866 上那套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-popup-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300);
  try { await fetch(H + '/api/health'); up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ── 造一个弹窗页：300×200，底部贴边放一个控件（正好压在下边缘上） ── */
const POP = { w: 300, h: 200 };
const ids = await page.evaluate(async (POP) => {
  const { project } = await import('/js/core/project.js');
  const pg = project.addPage('popup');
  project.updatePage(pg.id, { popupW: POP.w, popupH: POP.h, title: '测试弹窗', showClose: true });
  // 贴着底边：y + h = 200（就是弹窗高）—— 少了标题栏那 30 多像素就会被切
  const bottom = project.addWidget('label', 20, POP.h - 28);
  project.updateWidgetField(bottom.id, 'w', 120);
  project.updateWidgetField(bottom.id, 'h', 28);
  const top = project.addWidget('label', 20, 10);
  project.updateWidgetField(top.id, 'w', 120);
  project.updateWidgetField(top.id, 'h', 24);
  project.commit('弹窗尺寸测试');
  return { pop: pg.id, bottom: bottom.id, top: top.id };
}, POP);
await sleep(300);

/** 弹窗现况（都用**布局像素** offset*，不受运行态缩放影响） */
const popInfo = () => page.evaluate((ids) => {
  const card = document.querySelector('#rtPopupLayer .rt-popup');
  if (!card) return null;
  const head = card.querySelector('.rt-popup-head');
  const body = card.querySelector('.rt-popup-body');
  const bel = card.querySelector(`.wd[data-id="${ids.bottom}"]`);
  const br = body.getBoundingClientRect();
  const wr = bel?.getBoundingClientRect();
  return {
    cardH: card.offsetHeight, cardW: card.offsetWidth,
    headH: head?.offsetHeight ?? 0, hasHead: !!head,
    bodyH: body.offsetHeight,
    bottomClip: wr ? Math.max(0, Math.round((wr.bottom - br.bottom) * 10) / 10) : null,   // >0 = 被切
    bottomInside: wr ? wr.bottom <= br.bottom + 0.5 && wr.top >= br.top - 0.5 : null,
  };
}, ids);

const openPopup = async () => {
  await page.evaluate(async (id) => {
    const rt = await import('/js/runtime/runtime.js');
    if (!window.app.isRun?.()) await rt.enterRun();
    rt.showPopup(id);
  }, ids.pop);
  await sleep(350);
};
const closePopup = async () => {
  await page.evaluate(async () => {
    const rt = await import('/js/runtime/runtime.js');
    rt.hideTopPopup ? rt.hideTopPopup() : document.querySelector('.rt-popup-close')?.click();
  });
  await sleep(250);
};

/* ── 1. 有标题栏（标题 + 关闭按钮）时 ── */
await openPopup();
const withHead = await popInfo();
ok('弹窗开着，标题栏在（有关闭按钮）', !!withHead?.hasHead && withHead.headH > 20, JSON.stringify(withHead));
ok('内容区高度 = 页面属性里的「弹窗高」（标题栏没有把它吃掉）',
  withHead?.bodyH === POP.h, `${withHead?.bodyH} / ${POP.h}`);
ok('卡片总高 = 标题栏 + 内容区（自动变高，而不是切内容）',
  withHead?.cardH === withHead?.headH + POP.h, JSON.stringify(withHead));
ok('贴底的控件**完整可见**（底边没被切掉）',
  withHead?.bottomInside === true && withHead?.bottomClip === 0, JSON.stringify(withHead));

/* ── 2. 关掉关闭按钮、标题也留空 → 没有标题栏 ── */
await closePopup();
await page.evaluate(async (id) => {
  const { project } = await import('/js/core/project.js');
  project.updatePage(id, { title: '', showClose: false });
  project.commit('不要标题栏');
}, ids.pop);
await sleep(250);
await openPopup();
const noHead = await popInfo();
ok('关掉关闭按钮 + 标题留空 → 没有标题栏', noHead?.hasHead === false, JSON.stringify(noHead));
ok('没有标题栏时：内容区还是「弹窗高」，卡片总高就是弹窗高',
  noHead?.bodyH === POP.h && noHead?.cardH === POP.h, JSON.stringify(noHead));
ok('没有标题栏时贴底控件照样完整可见', noHead?.bottomInside === true, JSON.stringify(noHead));

/* ── 3. 只有标题、没关闭按钮 → 标题栏还在，内容区同样不被吃 ── */
await closePopup();
await page.evaluate(async (id) => {
  const { project } = await import('/js/core/project.js');
  project.updatePage(id, { title: '只有标题', showClose: false });
  project.commit('只有标题');
}, ids.pop);
await sleep(250);
await openPopup();
const titleOnly = await popInfo();
ok('只有标题、没有关闭按钮 → 标题栏照旧在，内容区仍 = 弹窗高、贴底控件完整',
  titleOnly?.hasHead === true && titleOnly?.bodyH === POP.h && titleOnly?.bottomInside === true,
  JSON.stringify(titleOnly));

/* ── 4. 比窗口还高的弹窗：卡片自己滚，而不是把内容切掉 ── */
await closePopup();
await page.evaluate(async (id) => {
  const { project } = await import('/js/core/project.js');
  project.updatePage(id, { popupH: 4000, title: '超高弹窗', showClose: true });
  project.commit('超高');
}, ids.pop);
await sleep(250);
await openPopup();
const tall = await page.evaluate((ids) => {
  const card = document.querySelector('#rtPopupLayer .rt-popup');
  const body = card.querySelector('.rt-popup-body');
  const bel = card.querySelector(`.wd[data-id="${ids.bottom}"]`);
  return {
    canScroll: card.scrollHeight > card.clientHeight + 2,
    cardMaxH: getComputedStyle(card).maxHeight,
    cardH: card.offsetHeight,
    bodyH: body.offsetHeight,
    bottomTop: Math.round(bel.offsetTop),
  };
}, ids);
ok('弹窗比窗口还高时：卡片自己滚（内容不被切掉）',
  tall.canScroll && tall.bodyH === 4000 && tall.cardH < 4000, JSON.stringify(tall));
await closePopup();

await page.evaluate(async () => { (await import('/js/runtime/runtime.js')).exitRun(); });
ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter(r => !r.ok);
console.log(`\n==== 弹窗高度（标题栏不吃内容）回归：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length ? 1 : 0);
