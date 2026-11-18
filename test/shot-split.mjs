// 截图：底部「变量 | 报警」分屏 + 变量表列宽（改样式时用来自检）
import { createRequire } from 'node:module';
import { installPageShim } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${process.argv[2] || '8904'}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(500);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null; m.backend.state = 'offline';
  m.backend.writeVar = async () => {}; m.backend.readVars = async () => null;
  m.backend.plcInfo.protocol = 'opcua';
  m.backend.getPlc = async () => ({ ok: true, config: {}, status: { mode: 'opcua', protocol: 'opcua' } });
}));
await page.evaluate(async () => {
  localStorage.removeItem('hmi-dock');
  const m = (await import('/js/core/project.js')).project;
  const d = await import('/js/editor/dock.js');
  d._resetLayout();
  m.data.variables.length = 0;
  const NS = 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.';
  [['GVL.a', 'int'], ['GVL.b', 'uint'], ['GVL.dd', 'bool'], ['GVL.s1', 'string'], ['GVL.arrw[1]', 'int'], ['GVL.arrw[2]', 'int']]
    .forEach(([n, t]) => m.data.variables.push({ name: n, type: t, address: NS + n, value: 0, len: t === 'string' ? 20 : 0 }));
  const al = m.addAlarm();
  m.updateAlarm(al.id, { name: '转速过高', variable: 'GVL.a', op: '>=', value: 3000, level: 'alarm', text: '主轴转速过高：{GVL.a}（上限 3000）' });
  m.commit('截图');
  // 两级折叠都展开，看清列宽
  localStorage.setItem('hmi-vars-groups-open', JSON.stringify(['p:GVL']));
  d.dockPanelTo('vars', 'bottom');
  d.dockPanelTo('alarms', 'bottom');
});
await sleep(400);
await page.click('#bottomPanel .dock-splitbtn');
await sleep(500);
const clip = await page.locator('#bottomPanel').boundingBox();
await page.screenshot({ path: 'out/split-1-bottom.png', clip });
// 变量面板单独来一张（列宽）
await page.evaluate(async () => {
  const d = await import('/js/editor/dock.js');
  d.mergeSplitAt('bottom');
  d.dockPanelTo('alarms', 'left');
});
await sleep(400);
const clip2 = await page.locator('#bottomPanel').boundingBox();
await page.screenshot({ path: 'out/split-2-vars.png', clip: clip2 });
console.log('截图完成');
await browser.close();
