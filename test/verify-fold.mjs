// 一次性验证：属性面板分组可折叠 + localStorage 记住状态
import { createRequire } from 'node:module';
// ESM 不认 NODE_PATH，用 createRequire 锚定到托管 node workspace 找 playwright-core
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/* ── A. 页面属性组（无选中时的「画布 / 页面」） ── */
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });
const pageTitle = page.locator('#propBody .prop-group-title', { hasText: '画布 / 页面' }).first();
const pageGroup = page.locator('#propBody .prop-group').first();
const ppWVisibleBefore = await page.locator('#ppW').isVisible();
await pageTitle.click();
const pageFolded = await pageGroup.evaluate(el => el.classList.contains('folded'));
const ppWVisibleAfterFold = await page.locator('#ppW').isVisible();
ok('页面组：折叠前 画布宽 可见', ppWVisibleBefore);
ok('页面组：点击标题后带 folded 类', pageFolded);
ok('页面组：折叠后 画布宽 隐藏', !ppWVisibleAfterFold);
const storedPage = await page.evaluate(() => JSON.parse(localStorage.getItem('hmi-prop-fold') || '{}'));
ok('页面组：localStorage 已记录', storedPage['画布 / 页面'] === true, JSON.stringify(storedPage));

await page.waitForTimeout(1200);
await page.reload({ waitUntil: 'networkidle' });
const pageFoldedAfterReload = await page.locator('#propBody .prop-group').first()
  .evaluate(el => el.classList.contains('folded'));
ok('页面组：刷新后折叠状态恢复', pageFoldedAfterReload);
await page.locator('#propBody .prop-group-title', { hasText: '画布 / 页面' }).first().click(); // 还原

/* ── B. 控件属性组（几何 / 名称） ── */
const id = await page.evaluate(() => (async () => {
  const m = await import('/js/core/project.js');
  const w = m.project.addWidget('button', 40, 40);
  return w.id;
})());
await page.waitForTimeout(150);
await page.click(`#canvas .wd[data-id="${id}"]`);
await page.waitForTimeout(150);

const geoTitle = page.locator('#propBody .prop-group-title', { hasText: '几何 / 名称' }).first();
const geoGroup = page.locator('#propBody .prop-group', { has: page.locator('.prop-group-title', { hasText: '几何 / 名称' }) }).first();
const xVisibleBefore = await page.locator('#propBody [data-fld="x"]').isVisible();
await geoTitle.click();
const geoFolded = await geoGroup.evaluate(el => el.classList.contains('folded'));
const xVisibleAfterFold = await page.locator('#propBody [data-fld="x"]').isVisible();
ok('几何组：折叠前 X 输入框可见', xVisibleBefore);
ok('几何组：点击标题后带 folded 类', geoFolded);
ok('几何组：折叠后 X 输入框隐藏', !xVisibleAfterFold);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hmi-prop-fold') || '{}'));
ok('几何组：localStorage 已记录', stored['几何 / 名称'] === true, JSON.stringify(stored));

// 截图留档（折叠态）
await page.screenshot({ path: 'test/fold-state.png', clip: { x: 1160, y: 0, width: 280, height: 500 } });

/* ── C. 刷新后恢复 ── */
await page.waitForTimeout(1200);
await page.reload({ waitUntil: 'networkidle' });
await page.click('#canvas .wd');   // 任意选一个控件
await page.waitForTimeout(150);
const geoFoldedAfterReload = await geoGroup.evaluate(el => el.classList.contains('folded'));
ok('几何组：刷新后折叠状态恢复', geoFoldedAfterReload);
await geoTitle.click();   // 展开
const geoUnfolded = await geoGroup.evaluate(el => !el.classList.contains('folded'));
ok('几何组：再次点击可展开', geoUnfolded);
await page.waitForTimeout(1200);
await page.reload({ waitUntil: 'networkidle' });
await page.click('#canvas .wd');
await page.waitForTimeout(150);
const geoUnfoldedAfterReload = await geoGroup.evaluate(el => !el.classList.contains('folded'));
ok('几何组：刷新后展开状态也记住', geoUnfoldedAfterReload);

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
await browser.close();
process.exit(fails ? 1 : 0);
