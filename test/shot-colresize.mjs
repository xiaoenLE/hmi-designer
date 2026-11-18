// 看一眼变量表 / 报警表的列宽：拖过之后是"拖多少算多少"，没拖的列（地址 / 内容）自动铺满面板
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
const page = await b.newPage({ viewport: { width: 1500, height: 940 } });
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);

// 变量表：塞几条名字很长的 + OPC UA 那种长 NodeId，看填充列（地址）是不是吃满
await page.evaluate(async () => {
  const p = (await import('/js/core/project.js')).project;
  p.data.variables.length = 0;
  const add = (name, type, address) => p.data.variables.push({ name, type, address, value: 0, len: 0 });
  add('r线速度设定值_主牵引', 'real', '%MW100');
  add('b主轴使能_总控', 'bool', '%MX0.0');
  add('i计米长度累计', 'int', '%MW20');
  add('GVL.中1[1]', 'int', 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.中1[1]');
  add('s报警文本_当前', 'string', '');
  add('r摆杆张力反馈', 'real', '%MW120');
  p.commit('列宽演示');
});
const tabVars = await page.$('.lp-tab[data-panel="vars"]');
await tabVars.click();
await sleep(500);
const boxOf = (sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: Math.round(r.x) - 4, y: Math.round(r.y) - 4, width: Math.round(r.width) + 8, height: Math.round(r.height) + 8 };
}, sel);
await page.screenshot({ path: 'shots/vars-colw-before.png', clip: await boxOf('#panel-vars') });

// 拖「名称」列右边界：名称变宽 → 地址（填充列）自己让位，表格仍然铺满面板
const gripBox = async (n) => page.evaluate((k) => {
  const g = document.querySelectorAll('#varTable table.vartbl thead th .col-grip')[k];
  const r = g.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, n);
let g = await gripBox(0);                        // 第 0 个把手 = 名称列（第一列是勾选框，没把手）
await page.mouse.move(g.x, g.y);
await page.mouse.down();
await page.mouse.move(g.x + 90, g.y, { steps: 8 });
await page.mouse.up();
await sleep(400);
const widths = await page.evaluate(() => {
  const t = document.querySelector('#varTable table.vartbl');
  return {
    table: Math.round(t.getBoundingClientRect().width),
    box: document.querySelector('#panel-vars .panel-body').clientWidth,
    cols: [...t.querySelectorAll('col')].map((c, i) => Math.round(t.querySelector('tbody tr').cells[i].getBoundingClientRect().width)),
  };
});
console.log('变量表：表格宽=', widths.table, ' 面板宽=', widths.box, ' 各列=', JSON.stringify(widths.cols));
await page.screenshot({ path: 'shots/vars-colw-after.png', clip: await boxOf('#panel-vars') });

// 报警表：加两条报警，看「内容」列（填充列）铺满
await page.evaluate(async () => {
  const p = (await import('/js/core/project.js')).project;
  p.alarms().push({ id: 'al1', enabled: true, name: '转速过高', variable: 'r线速度设定值_主牵引', op: '>=', value: '3000', delaySec: 1, level: 'alarm', text: '主轴转速过高：{r线速度设定值_主牵引} m/min（上限 3000）' });
  p.alarms().push({ id: 'al2', enabled: true, name: '油温偏高', variable: 'r摆杆张力反馈', op: '>=', value: '60', delaySec: 3, level: 'warn', text: '液压油温偏高：{r摆杆张力反馈} ℃' });
  p.commit('报警列宽演示');
});
const tabAlarms = await page.$('.lp-tab[data-panel="alarms"]');
await tabAlarms.click();
await sleep(500);
await page.screenshot({ path: 'shots/alarm-colw-before.png', clip: await boxOf('#panel-alarms') });
const g2 = await page.evaluate(() => {
  const g = document.querySelectorAll('#alarmTable table.vt.alarm thead th .col-grip')[0];   // 名称列
  const r = g.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
});
console.log('报警表 名称列把手位置:', JSON.stringify(g2.rect), '→ 点', g2.x.toFixed(0), g2.y.toFixed(0));
await page.mouse.move(g2.x, g2.y);
await page.mouse.down();
await page.mouse.move(g2.x + 60, g2.y, { steps: 8 });
await page.mouse.up();
await sleep(400);
const w2 = await page.evaluate(() => {
  const t = document.querySelector('#alarmTable table.vt.alarm');
  return {
    table: Math.round(t.getBoundingClientRect().width),
    box: document.getElementById('alarmTable').clientWidth,
    fixed: t.classList.contains('cols-fixed'),
    inline: [...t.querySelectorAll('col')].map(c => c.style.width || 'auto'),
    cols: [...t.querySelectorAll('col')].map((c, i) => Math.round(t.querySelector('tbody tr').cells[i].getBoundingClientRect().width)),
  };
});
console.log('报警表：fixd=', w2.fixed, ' 表格宽=', w2.table, ' 可视宽=', w2.box);
console.log('  各列=', JSON.stringify(w2.cols), '\n  col 内联宽=', JSON.stringify(w2.inline));
await page.screenshot({ path: 'shots/alarm-colw-after.png', clip: await boxOf('#panel-alarms') });
console.log('shots/vars-colw-before.png  shots/vars-colw-after.png\nshots/alarm-colw-before.png  shots/alarm-colw-after.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
