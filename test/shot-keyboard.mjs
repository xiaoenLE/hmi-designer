// 截图看软键盘长什么样（英文页 / 符号页 / 中文候选）——改样式时用来自检
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8889';
installNodeFetchPatch(PORT);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null; m.backend.state = 'offline';
  m.backend.writeVar = async () => {}; m.backend.readVars = async () => null;
}));
const id = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  m.data.variables.push({ name: 'sName', type: 'string', len: 20, address: '%MW200', value: 'Line-01' });
  const pg = m.pages()[0]; pg.widgets.length = 0;
  const w = m.addWidget('number', 40, 40); w.bindings.variable = 'sName';
  m.commit('键盘截图');
  return w.id;
});
await page.evaluate(async () => (await import('/js/runtime/runtime.js')).enterRun());
await sleep(600);
await page.click(`#rtPage .wd[data-id="${id}"]`);
await sleep(400);

await page.screenshot({ path: 'out/kb-1-abc.png', clip: await box() });
await page.click('#npText button[data-kind="page"]'); await sleep(200);
await page.screenshot({ path: 'out/kb-2-sym.png', clip: await box() });
await page.click('#npText button[data-kind="page"]'); await sleep(150);
await page.click('#npText button[data-kind="lang"]'); await sleep(200);
for (const c of ['z', 'h', 'o', 'n', 'g']) { await page.click(`#npText button[data-k="${c}"]`); await sleep(60); }
await sleep(250);
await page.screenshot({ path: 'out/kb-3-zhong.png', clip: await box() });
await page.click('#npCand button:has-text("中")'); await sleep(200);
for (const c of ['g', 'u', 'o']) { await page.click(`#npText button[data-k="${c}"]`); await sleep(60); }
await sleep(250);
await page.screenshot({ path: 'out/kb-4-guocand.png', clip: await box() });
console.log('截图完成');
await browser.close();

async function box() {
  const b = await page.locator('#numPad').boundingBox();
  return { x: Math.max(0, b.x - 12), y: Math.max(0, b.y - 12), width: Math.min(1500, b.width + 24), height: Math.min(940, b.height + 24) };
}
