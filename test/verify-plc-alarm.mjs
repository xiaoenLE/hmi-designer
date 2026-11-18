// verify-plc-alarm.mjs — 运行页面：PLC 断开每 10 秒提醒（测试里把间隔调小以便快速验证）
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const HEAD = `http://127.0.0.1:${process.argv[2] || '8866'}`;
const results = [];
const ok = (n, c, e = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  [' + e + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const api = async (p, opt) => (await fetch(HEAD + p, opt)).json();
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
// 提醒间隔调成 1.5 秒（默认 10 秒），这样几秒内就能验证"每 N 秒再提醒"
await page.evaluate(() => { window.app.plcWatch.remindMs = 1500; window.app.plcWatch.pollMs = 1000; });
await page.evaluate(() => (async () => { await (await import('/js/runtime/runtime.js')).enterRun(); })());
await sleep(1500);

const a1 = await page.evaluate(() => {
  const b = document.getElementById('rtPlcAlarm');
  return {
    hidden: b.classList.contains('hidden'), text: document.getElementById('rtPlcAlarmText').textContent,
    sub: document.getElementById('rtPlcAlarmSub').textContent, subTitle: document.getElementById('rtPlcAlarmSub').title,
    flash: b.classList.contains('flash'),
  };
});
ok('运行页面出现「PLC 已断开」红条，且带着 IP:端口',
  !a1.hidden && /PLC 已断开/.test(a1.text) && /127\.0\.0\.1:1\b/.test(a1.text), JSON.stringify(a1));
ok('红条上**只说两件事**：断开时长（不摆原因、不摆那串说明）',
  /^已断开\s*\d+\s*秒$/.test(a1.sub.trim()), JSON.stringify(a1.sub));
ok('后端给的原因没丢，挪到悬停提示里（浏览器里鼠标停一下看得到）',
  a1.subTitle.length > 0, a1.subTitle);
ok('第一次出现就闪一下（提醒）', a1.flash === true, String(a1.flash));

/* 等过一个提醒周期：应该再次闪（flash 会重播），且秒数在涨 */
await sleep(2200);
const a2 = await page.evaluate(() => {
  const b = document.getElementById('rtPlcAlarm');
  return { hidden: b.classList.contains('hidden'), sub: document.getElementById('rtPlcAlarmSub').textContent, flash: b.classList.contains('flash') };
});
const secs1 = Number((a1.sub.match(/已断开\s*(\d+)\s*秒/) || [])[1] || 0);
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

/* 退出运行 → 监听停止（不该再留着条子） */
await post('/api/plc', { action: 'connect', ip: '127.0.0.1', port: 1, unit: 1, poll_ms: 200 });
await sleep(500);
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
