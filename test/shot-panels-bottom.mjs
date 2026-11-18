// 看两个面板都停靠在底部（左右分栏）时，横向滚动条各在什么位置 —— 用户截图就是这个布局
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-shot-'));
const srv = spawn('C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe',
  ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2', stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }
const b = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe', headless: true });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await installPageShim(page);
await page.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);

// 变量 / 报警 都塞够，让两张表都有横竖滚动条
await page.evaluate(async () => {
  const p = (await import('/js/core/project.js')).project;
  p.data.variables.length = 0;
  // 仿用户工程：数字后缀成组的变量（Hr轴状态0…6）+ 长 NodeId；**数量过 200** 才会走"窗口化只画可见行"
  const pref = ['Hr回零位置值', 'Hr驱动器报警代码', 'Hr驱动器温度', 'Hr轴额定转矩', 'Hr摆杆长度', 'Hr设备维护周期', 'Hr设备已用时间', 'Hr设备剩余时间', 'Hr保养清零', 'Hr断线故障数据', 'Hr应用配方', 'Hr补偿值'];
  pref.forEach(pre => {
    for (let i = 0; i < 12; i++) {
      p.data.variables.push({
        name: `${pre}${i}`, type: pre.includes('代码') ? 'dint' : 'real',
        address: `ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.${pre}[${i}]`, value: 0, len: 0,
      });
    }
  });
  for (let i = 0; i < 160; i++) {
    p.data.variables.push({ name: `r轴实际转矩[${i}]_长名字测试`, type: 'real', address: `%MW${200 + i * 2}`, value: 0, len: 0 });
  }
  p.alarms().length = 0;
  for (let i = 0; i < 18; i++) {
    p.alarms().push({
      id: 'al' + i, enabled: true, name: '报警' + i, variable: 'r轴实际转矩[0]_长名字测试',
      op: '>=', value: String(100 + i), delaySec: 1, level: 'alarm',
      text: `第 ${i} 条报警的内容比较长，用来看内容列到底占多宽（上限 ${100 + i}）`,
    });
  }
  // 面板布局：报警 + 变量 都停靠在**底部**，左右分两栏（跟用户截图一致）
  // ⚠ 布局存在 project.data.layout.dock 里（dock.js 的 load/save）
  p.data.layout = {
    dock: {
      left: ['toolbox', 'pages', 'scripts', 'list'],
      right: ['properties'],
      bottom: ['alarms', 'vars'],
      float: [],
      active: { left: 'toolbox', right: 'properties', bottom: 'alarms' },
      split: { left: null, right: null, bottom: { extra: ['vars'], grow: [0.4, 0.6] } },
    },
  };
  p.commit('截图布局');
});
await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.replaceData(JSON.parse(JSON.stringify(project.data)));   // 让 dock 重新按 layout 排
});
await sleep(900);

const info = await page.evaluate(() => {
  const out = {};
  for (const [name, tblSel, scSel] of [['vars', '#varTable table.vartbl', '#panel-vars .panel-body'], ['alarms', '#alarmTable table.vt.alarm', '#panel-alarms .panel-body']]) {
    const t = document.querySelector(tblSel);
    const sc = document.querySelector(scSel);
    const row = t.querySelector('tbody tr');
    out[name] = {
      tableW: Math.round(t.getBoundingClientRect().width),
      scrollerW: sc.clientWidth,
      表格比容器宽: t.getBoundingClientRect().width - sc.clientWidth,
      各列: row ? [...row.cells].map(c => Math.round(c.getBoundingClientRect().width)) : null,
      表头: [...t.querySelectorAll('thead th')].map(th => `${th.textContent.trim().slice(0, 4)}:${Math.round(th.getBoundingClientRect().width)}`),
      横滚: sc.scrollWidth > sc.clientWidth,
      colsFfixed: t.classList.contains('cols-fixed'),
      inline: [...t.querySelectorAll('col')].map(c => c.style.width || 'auto'),
    };
  }
  return out;
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'shots/panels-dock-bottom.png' });
// 变量表顶部放大（看有没有行重叠/串行）
await page.screenshot({ path: 'shots/panels-vars-top.png', clip: { x: 720, y: 640, width: 700, height: 150 } });
console.log('shots/panels-dock-bottom.png  shots/panels-vars-top.png');
await b.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
