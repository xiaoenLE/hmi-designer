import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8878';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(600);

// 造一个数组变量 + 展开，模拟"导入 OPC UA 后一堆 arrw[k]"
await page.evaluate(() => {
  const m = window.app.project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'keep1', type: 'int', address: '%MW10', value: 0, len: 0 });
  m.data.variables.push({ name: 'arrw', type: 'int[]', address: '%MW100', value: [0], len: 13 });
  m.data.variables.push({ name: 'keep2', type: 'bool', address: '%MX0.0', value: false, len: 0 });
  m.commit('test');
});
await page.waitForTimeout(300);

const rows = () => page.evaluate(() => [...document.querySelectorAll('#varRows tr')].map(tr => {
  if (tr.classList.contains('vt-group')) return `[组] ${tr.dataset.group}  ${tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 46)}`;
  if (tr.classList.contains('vs-pad')) return '(占位)';
  return `    ${tr.dataset.name}`;
}));

console.log('① 展开前:'); (await rows()).forEach(r => console.log('   ' + r));

// 走 UI：勾上 arrw → 点「展开数组」（新组应该自动摊开）
page.on('dialog', d => d.accept());
await page.evaluate(async () => {
  const m = await import('/js/editor/varsPanel.js');
  m.expandArrayVars(['arrw']);
});
await page.waitForTimeout(700);
console.log('\n② 走 UI「展开数组」后（新组自动摊开）:'); (await rows()).forEach(r => console.log('   ' + r));

const clickGroup = () => page.evaluate(() => {
  document.querySelector('#varRows tr.vt-group td:nth-child(2)').click();
});

// 点组表头 → 收起
await clickGroup();
await page.waitForTimeout(400);
console.log('\n③ 点一下组表头 → 收起:'); (await rows()).forEach(r => console.log('   ' + r));

// 再点 → 展开（顺带验 localStorage 记状态）
await clickGroup();
await page.waitForTimeout(400);
console.log('\n④ 再点一下 → 展开:'); (await rows()).forEach(r => console.log('   ' + r));
const stored = await page.evaluate(() => localStorage.getItem('hmi-vars-groups-open'));
console.log('   localStorage 记的展开组 =', stored);

// 刷新页面，展开状态应该还在
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(800);
const stored2 = await page.evaluate(() => localStorage.getItem('hmi-vars-groups-open'));
console.log('\n⑤ 刷新后 localStorage =', stored2);

console.log('\nPAGE ERRORS:', JSON.stringify(errs));
await browser.close();
