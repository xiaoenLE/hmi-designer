// 看运行态的「当前报警 / 报警历史」控件：滚动时表头（说明栏）是不是吸在最上面
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-'));
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/api/health'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);

// 摆两个控件：当前报警 + 报警历史，塞够报警让它们能滚
await page.evaluate(async () => {
  const p = (await import('/js/core/project.js')).project;
  p.data.pages[0].widgets.length = 0;
  p.data.meta.canvas.w = 880; p.data.meta.canvas.h = 620;
  const mk = (type, x, y, w, h) => { const k = p.addWidget(type, x, y); p.updateWidgetField(k.id, 'w', w); p.updateWidgetField(k.id, 'h', h); return k; };
  const a = mk('alarmList', 20, 20, 620, 200);
  p.updateWidgetProp(a.id, 'maxRows', 6);
  const h = mk('alarmHistory', 20, 240, 620, 220);
  p.updateWidgetProp(h.id, 'maxRows', 7);
  p.commit('报警控件吸顶演示');
  window.__a = a.id; window.__h = h.id;
});
// 造一批"正在报警"：直接把报警表填好，运行态就会显示
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  project.data.alarms.length = 0;
  for (let i = 0; i < 12; i++) {
    const v = `bAlarm${i}`;
    if (!project.variables().some(x => x.name === v)) { project.addVariable(); project.updateVariable(`var${project.variables().length}`, { name: v, type: 'bool', value: true }); }
    project.data.alarms.push({ id: 'al' + i, enabled: true, name: '报警' + i, variable: v, op: '>=', value: '1', delaySec: 0, level: i % 4 === 3 ? 'urgent' : 'alarm', text: `第 ${i} 条：主轴转速过高（上限 ${3000 + i}）` });
    varStore.set(v, true, 'local');
  }
  project.commit('报警数据');
});
await sleep(400);
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(700);

const info = async (sel) => page.evaluate((s) => {
  const sc = document.querySelector(s + ' .at-scroll');
  const th = document.querySelector(s + ' .at-table thead td.th');
  return {
    scrollTop: Math.round(sc.scrollTop), maxScroll: Math.round(sc.scrollHeight - sc.clientHeight),
    scTop: Math.round(sc.getBoundingClientRect().top),
    thTop: Math.round(th.getBoundingClientRect().top),
    thPos: getComputedStyle(th).position,
  };
}, sel);
const A = '#rtPage .wd[data-id="' + await page.evaluate(() => window.__a) + '"] .w-alarmtbl';
const Hh = '#rtPage .wd[data-id="' + await page.evaluate(() => window.__h) + '"] .w-alarmtbl';
console.log('当前报警 未滚动:', JSON.stringify(await info(A)));
console.log('报警历史 未滚动:', JSON.stringify(await info(Hh)));
await page.screenshot({ path: 'shots/alarmtbl-sticky-before.png', clip: { x: 0, y: 0, width: 660, height: 470 } });
// 滚两个控件的内部滚动条
await page.evaluate(([a, h]) => {
  document.querySelector(a + ' .at-scroll').scrollTop = 120;
  document.querySelector(h + ' .at-scroll').scrollTop = 120;
}, [A, Hh]);
await sleep(400);
console.log('当前报警 滚 120 后:', JSON.stringify(await info(A)));
console.log('报警历史 滚 120 后:', JSON.stringify(await info(Hh)));
await page.screenshot({ path: 'shots/alarmtbl-sticky-after.png', clip: { x: 0, y: 0, width: 660, height: 470 } });
// 对比：把 will-change 去掉（怀疑它让表头单独成层、滚动时残留几个像素的"鬼影"）
await page.evaluate(([a, h]) => {
  [a, h].forEach((sel) => {
    document.querySelectorAll(sel + ' .at-table thead td.th').forEach(td => { td.style.willChange = 'auto'; });
    document.querySelector(sel + ' .at-scroll').scrollTop = 0;
  });
}, [A, Hh]);
await page.evaluate(([a, h]) => {
  document.querySelector(a + ' .at-scroll').scrollTop = 120;
  document.querySelector(h + ' .at-scroll').scrollTop = 120;
}, [A, Hh]);
await sleep(400);
await page.screenshot({ path: 'shots/alarmtbl-sticky-nowc.png', clip: { x: 0, y: 0, width: 660, height: 470 } });
// 用**真实滚轮**再滚一次（程序化改 scrollTop 会让合成层出现一帧残留，截图可能拍到鬼影）
for (const [sel, tag] of [[A, '当前报警'], [Hh, '报警历史']]) {
  const centre = await page.evaluate((a) => {
    const r = document.querySelector(a + ' .at-scroll').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, sel);
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 40); await sleep(90); }
  await sleep(500);
  const precise = await page.evaluate((a) => {
    const el = document.querySelector(a + ' .at-scroll');
    const th = document.querySelector(a + ' .at-table thead td.th').getBoundingClientRect();
    return {
      scrollTop: Math.round(el.scrollTop), scTop: +el.getBoundingClientRect().top.toFixed(2),
      thTop: +th.top.toFixed(2), 缝: +(th.top - el.getBoundingClientRect().top).toFixed(2),
    };
  }, sel);
  console.log(`真实滚轮后（${tag}）:`, JSON.stringify(precise));
}
await page.screenshot({ path: 'shots/alarmtbl-sticky-wheel.png', clip: { x: 0, y: 0, width: 660, height: 470 } });
// 两个控件的结构/层级对比：为什么当前报警干净、报警历史有鬼影
const cmp = await page.evaluate(([a, h]) => {
  const one = (sel) => {
    const sc = document.querySelector(sel + ' .at-scroll');
    const th = document.querySelector(sel + ' .at-table thead td.th');
    const cs = getComputedStyle(th);
    const r = th.getBoundingClientRect();
    const x = Math.round(r.x + 10), y = Math.round(r.y + r.height / 2);
    const stack = document.elementsFromPoint(x, y).slice(0, 3).map(e => e.tagName + (e.className ? '.' + String(e.className).split(' ').join('.') : ''));
    return {
      结构: sc.parentElement.className + ' > ' + sc.className,
      表头前的兄弟: [...sc.children[0].children[0].children].length,
      z: cs.zIndex, pos: cs.position, bg: cs.backgroundColor, wc: cs.willChange,
      hit: stack,
      nav: !!document.querySelector(sel + ' .at-nav'),
    };
  };
  return { 当前报警: one(a), 报警历史: one(h) };
}, [A, Hh]);
console.log('对比:', JSON.stringify(cmp, null, 1));
// 强制重绘一次再拍一张：如果鬼影没了 → 那是**滚动残留帧**（不是真画错）
await page.evaluate(() => {
  const p = document.getElementById('rtPage');
  p.style.opacity = '0.999'; void p.offsetHeight; p.style.opacity = '';
});
await sleep(350);
await page.screenshot({ path: 'shots/alarmtbl-sticky-wheel2.png', clip: { x: 0, y: 0, width: 660, height: 470 } });
console.log('shots/alarmtbl-sticky-wheel2.png');
// 报警历史表头上方那条"鬼影"到底是什么元素：逐像素做命中测试
const band = await page.evaluate((h) => {
  const sc = document.querySelector(h + ' .at-scroll');
  const r = sc.getBoundingClientRect();
  const out = [];
  for (let dy = -14; dy <= 8; dy += 2) {
    const y = Math.round(r.top + dy);
    const el = document.elementFromPoint(Math.round(r.left + 120), y);
    out.push(`${dy >= 0 ? '+' : ''}${dy}: ${el ? el.tagName + '.' + String(el.className).split(' ').join('.') : 'null'}`);
  }
  const rows = [...document.querySelectorAll(h + ' .at-table tbody tr')].slice(0, 4).map(tr => {
    const b = tr.getBoundingClientRect();
    return `${Math.round(b.top)}~${Math.round(b.bottom)}`;
  });
  return { scTop: Math.round(r.top), scH: Math.round(r.height), navBottom: Math.round(document.querySelector(h + ' .at-nav').getBoundingClientRect().bottom), 前几行: rows, out };
}, Hh);
console.log('报警历史 逐像素:', JSON.stringify(band, null, 1));
// 决定性实验：把 tbody 藏掉再拍 —— 鬼影还在就说明不是"行"画的
await page.evaluate((h) => { document.querySelector(h + ' .at-table tbody').style.display = 'none'; }, Hh);
await sleep(350);
await page.screenshot({ path: 'shots/alarmtbl-sticky-notbody.png', clip: { x: 0, y: 260, width: 660, height: 90 } });
await page.evaluate((h) => { document.querySelector(h + ' .at-table tbody').style.display = ''; }, Hh);
console.log('shots/alarmtbl-sticky-notbody.png（tbode 藏掉后）');
console.log('shots/alarmtbl-sticky-wheel.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
