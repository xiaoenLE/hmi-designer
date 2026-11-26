// 操作记录控件和后端共用一条长连接，配合 tools/run-suites.mjs 运行。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const exe = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const base = `http://127.0.0.1:${process.argv[2] || '8866'}`;
const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let releaseWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  let markWriteQueued;
  const writeQueued = new Promise(resolve => { markWriteQueued = resolve; });
  await page.routeWebSocket('**/api/ws*', route => {
    const server = route.connectToServer();
    let blocked = false;
    route.onMessage(message => {
      const body = JSON.parse(message);
      if (body.t === 'write' && body.name === '等待发送') {
        blocked = true;
        markWriteQueued();
      }
      if (blocked) writeGate.then(() => server.send(message));
      else server.send(message);
    });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project);
  await page.evaluate(() => {
    const { project } = window.app;
    project.currentPage().widgets.length = 0;
    const log = project.addWidget('operations', 20, 20);
    log.props.maxRows = 50; // 老工程依然可以翻看全部记录
    const button = project.addWidget('button', 20, 340);
    button.name = '无写入按钮';
    button.actions = [];
    project.commit('操作记录回归');
  });
  assert.equal(await page.locator('#canvas .w-operations tbody tr').count(), 2);
  assert.equal(await page.locator('#canvas [data-op=filter]').isDisabled(), true);
  await page.evaluate(() => window.app.enterRun());
  const widget = page.locator('#rtPage .w-operations');
  await widget.waitFor();
  await page.locator('#rtPage .w-btn').click();
  await widget.getByRole('row').filter({ hasText: '无写入按钮' }).waitFor();
  assert.match(await widget.getByRole('row').filter({ hasText: '无写入按钮' }).innerText(), /按钮触发.*已触发/s);
  await page.evaluate(() => { window.app.backend.writeVar('等待发送', 1).catch(() => {}); });
  await Promise.race([writeQueued, page.waitForTimeout(2000).then(() => { throw new Error('未收到模拟写入'); })]);
  await page.locator('#rtPage .w-btn').click();
  await widget.getByRole('row').filter({ hasText: '无写入按钮' }).nth(1).waitFor({ timeout: 1500 });
  assert.equal(await widget.getByRole('row').filter({ hasText: '等待发送' }).count(), 0);
  releaseWrite();
  await widget.getByRole('row').filter({ hasText: '等待发送' }).waitFor({ timeout: 1500 });

  const target = `目标<速度>${Date.now()}`;
  const recipe = `操作记录配方${Date.now()}`;
  await page.evaluate(async ([target, recipe]) => {
    const { backend } = window.app;
    await backend.writeVar(target, 123);
    await backend.writeVar('后台脚本值', 1, { from: 'script' });
    await backend.rpc('/api/recipes', { body: { action: 'save', name: recipe, vars: { [target]: 321, '': 1 } } });
    await backend.rpc('/api/recipes', { body: { action: 'apply', name: recipe } }).catch(e => {
      if (!e.data?.failed?.length) throw e;
    });
  }, [target, recipe]);
  await widget.getByRole('button', { name: '刷新' }).click();
  const row = text => widget.getByRole('row').filter({ hasText: text });
  await row(target).waitFor();
  assert.match(await row(target).innerText(), /写入变量.*成功.*123/s);
  assert.equal(await row('后台脚本值').count(), 0);
  await row(recipe).filter({ hasText: '应用配方' }).waitFor();
  assert.match(await row(recipe).filter({ hasText: '应用配方' }).innerText(), /失败.*成功 1 项，失败 1 项/s);
  assert.equal(await row(recipe).filter({ hasText: '保存配方' }).count(), 1);

  // 画面切换也要留痕：切到第二页（控件所在的页会被换掉）→ 返回 → 刷新，记录里出现「切换画面」
  await page.waitForTimeout(550);
  const page2 = await page.evaluate(() => {
    const pr = window.app.project;
    const name = pr.pages().filter(p => p.type === 'page')[1]?.name || '';
    window.app.gotoPage(name);
    return name;
  });
  await page.waitForTimeout(600);
  await page.evaluate(async () => (await import('/js/runtime/runtime.js')).goBack());
  await page.waitForTimeout(600);
  await widget.getByRole('button', { name: '刷新' }).click();
  const pageRow = row(page2).filter({ hasText: '切换画面' });
  await pageRow.waitFor();
  assert.match(await pageRow.innerText(), new RegExp(`切换画面.*${page2}.*成功`, 's'));

  const filter = widget.getByRole('searchbox');
  await filter.fill('不存在的操作记录');
  await widget.getByRole('status').filter({ hasText: '没有匹配的记录' }).waitFor();
  assert.equal(await widget.locator('tbody tr').count(), 0);
  await filter.fill(recipe);
  await row(recipe).filter({ hasText: '应用配方' }).waitFor();
  assert.equal(await widget.locator('tbody tr').count(), 2);
  await filter.fill('');

  await page.evaluate(() => window.app.backend.writeVar('自动刷新的记录', true));
  await row('自动刷新的记录').waitFor({ timeout: 1500 });
  await page.evaluate(async () => {
    for (let i = 1; i <= 205; i++) {
      await window.app.backend.rpc('/api/operations/button', { body: { name: `批量按钮${String(i).padStart(3, '0')}` } });
    }
  });
  await row('批量按钮205').waitFor();
  assert.equal(await widget.locator('tbody tr').count(), 200);
  await widget.getByRole('button', { name: '下一页' }).click();
  await row('批量按钮001').waitFor();
  await row('无写入按钮').first().waitFor();
  await filter.fill('批量按钮001');
  await row('批量按钮001').waitFor();
  await widget.getByText('1 条', { exact: true }).waitFor();
  assert.equal(await widget.locator('tbody tr').count(), 1);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project);
  await page.evaluate(() => window.app.enterRun());
  await filter.fill(target);
  await row(target).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS  操作记录编辑态、运行态、人工写值与配方结果、筛选、自动刷新、重新打开后读回');
} finally {
  await browser.close();
}
