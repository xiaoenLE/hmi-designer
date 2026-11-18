// verify-plc-alarm.mjs — 运行页面：PLC 断开每 10 秒提醒（测试里把间隔调小以便快速验证）
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const HEAD = `http://127.0.0.1:${process.argv[2] || '8866'}`;
installNodeFetchPatch(HEAD);
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const api = async (p, opt) => (await fetch(HEAD + p, opt)).json();
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());

/* 让后端连一个「死」端口：TCP 一定连不上 → mode=plc 且 online=false */
await post('/api/plc', { action: 'connect', ip: '127.0.0.1', port: 1, unit: 1, poll_ms: 200, word_order: 'cdab' });
await sleep(800);
const st = (await api('/api/plc')).status;
ok('后端已切到 PLC 数据源但连不上（mode=plc / online=false）',
  st.mode === 'plc' && st.online === false, JSON.stringify({ mode: st.mode, online: st.online, err: st.last_error }));

await page.goto(HEAD + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.app?.project?.data);
// 提醒间隔调成 1.5 秒（默认 10 秒），这样几秒内就能验证"每 N 秒再提醒"。
// ⚠ offlineDelayMs 这里**故意用默认的 5 秒**（下面两段就是验它）——
//   所以不能再靠固定 sleep 去取"红条已经挂出来"那一帧，得轮询等它出现。
await page.evaluate(() => { window.app.plcWatch.remindMs = 1500; window.app.plcWatch.pollMs = 1000; });
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(1500);

/* ══════ 「连不上要连续 5 秒才喊」══════
   现场反馈：一断就报太快了 —— 后端一轮读超时就把 online 置 false（Modbus 读超时 /
   OPC UA 一次请求没回来都算），界面要是跟着挂红条，抖两三秒又变绿，看着像设备在反复掉线。
   所以：进运行态 1.5 秒时**红条必须还没出来**，等它出来时挂的是「已断开 5 秒」（或更多）。 */
const early = await page.evaluate(() => {
  const b = document.getElementById('rtPlcAlarm');
  return { hidden: b.classList.contains('hidden'), text: document.getElementById('rtPlcAlarmText').textContent };
});
ok('刚发现连不上（约 1.5 秒）**还不报警**（默认观察期 5 秒）', early.hidden === true, JSON.stringify(early));

const t0 = Date.now();
let a1 = null;
for (let i = 0; i < 30 && !a1; i++) {
  await sleep(300);
  const b = await page.evaluate(() => {
    const el = document.getElementById('rtPlcAlarm');
    return {
      hidden: el.classList.contains('hidden'), text: document.getElementById('rtPlcAlarmText').textContent,
      sub: document.getElementById('rtPlcAlarmSub').textContent, subTitle: document.getElementById('rtPlcAlarmSub').title,
      flash: el.classList.contains('flash'),
    };
  });
  if (!b.hidden && /已断开/.test(b.text)) a1 = { ...b, waited: Date.now() - t0 };
}
const secs1 = Number(((a1?.sub || '').match(/已断开\s*(\d+)\s*秒/) || [])[1] || 0);
ok('连不上**连续到 5 秒才挂红条**（不是一断就报：等出来的那一下已经过了观察期）',
  !!a1 && a1.waited >= 2500, JSON.stringify({ waited: a1?.waited, sub: a1?.sub }));
ok('红条一出来写的就是真实断开时长（≥5 秒，从"第一次发现连不上"起算）',
  secs1 >= 5, String(a1?.sub));

ok('运行页面出现「PLC 已断开」红条，且带着 IP:端口',
  !a1?.hidden && /PLC 已断开/.test(a1?.text || '') && /127\.0\.0\.1:1\b/.test(a1?.text || ''), JSON.stringify(a1));
ok('红条上**只说两件事**：断开时长（不摆原因、不摆那串说明）',
  /^已断开\s*\d+\s*秒$/.test((a1?.sub || '').trim()), JSON.stringify(a1?.sub));
ok('后端给的原因没丢，挪到悬停提示里（浏览器里鼠标停一下看得到）',
  (a1?.subTitle || '').length > 0, a1?.subTitle);
ok('第一次出现就闪一下（提醒）', a1?.flash === true, String(a1?.flash));

/* 等过一个提醒周期：应该再次闪（flash 会重播），且秒数在涨 */
await sleep(2200);
const a2 = await page.evaluate(() => {
  const b = document.getElementById('rtPlcAlarm');
  return { hidden: b.classList.contains('hidden'), sub: document.getElementById('rtPlcAlarmSub').textContent, flash: b.classList.contains('flash') };
});
const secs2 = Number((a2.sub.match(/已断开\s*(\d+)\s*秒/) || [])[1] || 0);
ok('断开时长在往上走（红条一直挂着，不是弹一下就没了）', secs2 > secs1, `${secs1}s → ${secs2}s`);
ok('过了提醒周期又闪了一次', a2.flash === true && !a2.hidden, JSON.stringify(a2));

/* 红条不能挡住画面上的按钮（pointer-events: none） */
const pe = await page.evaluate(() => getComputedStyle(document.getElementById('rtPlcAlarm')).pointerEvents);
ok('红条不吃点击（pointer-events:none）', pe === 'none', pe);

/* 恢复连接 → 绿条「已恢复」，随后自动收起。
   ⚠ 绿条只显示 okShowMs（默认 4 秒）就自己收起：这里**轮询等它出现**，
   不能固定 sleep 完再取一次 —— 全量回归时机器一忙就会正好取到"已经收起"的那一帧（误报过）。 */
await post('/api/plc', { action: 'disconnect' });          // 回到内存模拟 = 不再算断开
let a3 = { hidden: true, text: '', cls: '' };
for (let i = 0; i < 25; i++) {
  await sleep(200);
  a3 = await page.evaluate(() => {
    const b = document.getElementById('rtPlcAlarm');
    return { hidden: b.classList.contains('hidden'), text: document.getElementById('rtPlcAlarmText').textContent, cls: b.className };
  });
  if (!a3.hidden && /已恢复/.test(a3.text)) break;
}
ok('恢复后先显示「PLC 已恢复连接」', /已恢复/.test(a3.text) && a3.cls.includes('ok') && a3.hidden === false, JSON.stringify(a3));
// 绿条显示 okShowMs（默认 4 秒）后收起；轮询等它（固定 sleep 容易卡在边界上误报）
let hidden4 = false;
for (let i = 0; i < 20 && !hidden4; i++) {
  await sleep(400);
  hidden4 = await page.evaluate(() => document.getElementById('rtPlcAlarm').classList.contains('hidden'));
}
ok('绿条显示几秒后自动收起', hidden4 === true, String(hidden4));

/* ══════ 「重新读取现场数据（N 个变量）」里的 N：**内部变量不算** ══════
   现场反馈：绿条老说"其中 2 个和界面上不一样"，那两台其实是**触摸屏自己的内部变量**
   （地址留空、脚本写/掉电保持那种）—— 它们根本不从设备读，没得比，不该出现在这句话里。
   数数那条规则单独导出了（countResync），这里直接喂两份值表验，比"跑两遍比总数"稳
   （跑两遍那种写法会被"变量是陆续读进来的"影响，数字天然会漂）。 */
const cnt = await page.evaluate(async () => {
  const m = window.app.project;
  if (!m.variables().some(v => v.name === 'nQaInner')) {
    m.variables().push({ name: 'nQaInner', type: 'int', address: '', value: 5 });   // 地址留空 = 内部变量
  }
  const rt = await import('/js/runtime/runtime.js');
  const dev = { rQaA: 1, rQaB: 20, bQaC: false };          // 三个设备变量（其中两个变了）
  const inner = { nQaInner: 5 };
  const A = { ...dev, ...inner };
  const B = { ...dev, rQaB: 21, bQaC: true, ...inner, nQaInner: 7 };   // 内部变量也"不一样"
  const both = rt.countResync(A, B);
  const devOnly = rt.countResync(dev, { ...dev, rQaB: 21, bQaC: true });
  return { both, devOnly, hasInner: m.variables().some(v => v.name === 'nQaInner' && !String(v.address || '').trim()) };
});
ok('测试前提：表里有个地址留空的内部变量', cnt.hasInner === true, String(cnt.hasInner));
ok('★ 数「重新读取了 N 个变量」时**内部变量一个都不算**（只数设备变量）',
  cnt.both.total === 3 && cnt.devOnly.total === 3, JSON.stringify(cnt));
ok('★ 「其中 M 个和界面上不一样」同样只数设备变量（内部变量变了也不进这个数）',
  cnt.both.changed === 2 && cnt.devOnly.changed === 2, JSON.stringify(cnt));

await page.evaluate(() => (async () => { (await import('/js/runtime/runtime.js')).exitRun(); })());
await sleep(1500);
const a5 = await page.evaluate(() => document.getElementById('rtPlcAlarm').classList.contains('hidden'));
ok('退出运行后不再提醒（监听已停）', a5 === true, String(a5));

ok('全程无未捕获 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await post('/api/plc', { action: 'disconnect' });
console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== PLC 断开提醒回归：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
