// 工程配方地址、查看入口和独立编辑控件的端到端回归。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const port = process.argv[2];
assert.ok(port, '请用 tools/run-suites.mjs 启动隔离后端');
const { chromium } = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/')('playwright-core');
const exe = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let keepOld = false;
  page.on('dialog', dialog => keepOld && dialog.message().includes('将移除') ? dialog.dismiss() : dialog.accept());
  await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.project);
  await page.evaluate(async () => {
    const { project } = window.app;
    const { obfuscate } = await import('/js/core/sha256.js');
    const { select } = await import('/js/editor/canvas.js');
    project.currentPage().widgets.length = 0;
    project.data.variables = [
      { name: '目标速度', address: '', type: 'int', value: 10 },
      { name: '自动模式', address: '', type: 'bool', value: false },
      { name: '规格名称', address: '', type: 'string', value: '初始规格' },
      { name: '不保存此项', address: '%MW118', type: 'int', value: 11 },
    ];
    project.addWidget('recipe', 30, 30);
    const opener = project.addWidget('button', 480, 35);
    opener.props.onText = opener.props.offText = '外部入口';
    opener.bindings = {};
    opener.actions = [{ trigger: 'click', type: 'openRecipeManager', params: {} }];
    const editor = project.addWidget('recipeEditor', 425, 105);
    editor.w = 540;
    project.setPermissions({ enabled: true, levels: [{ id: 'pm_recipe', name: '配方维修', pw: obfuscate('6688', 'pm_recipe') }] });
    select([editor.id]);
  });
  await page.getByRole('button', { name: '操作权限', exact: true }).click();
  await page.locator('[data-prop="permLevel"]').selectOption('pm_recipe');
  await page.locator('[data-prop="allowDelete"]').check();
  assert.equal(await page.locator('[data-prop="useKeyboard"]').isChecked(), true);
  const config = page.locator('.recipe-config');
  const openConfig = async () => {
    await page.locator('#btnProjMenu').click();
    await page.locator('#ctxMenu').getByRole('menuitem', { name: /配方地址配置/ }).click();
    await config.waitFor();
  };
  await openConfig();
  const search = config.getByRole('searchbox');
  await search.fill('%MW118');
  await config.getByRole('cell', { name: '%MW118', exact: true }).waitFor();
  await search.clear();
  for (const variable of ['目标速度', '自动模式', '规格名称']) {
    await config.getByRole('checkbox', { name: variable, exact: true }).check();
  }
  await config.getByRole('checkbox', { name: '只看已选' }).check();
  assert.equal(await config.getByRole('checkbox', { name: '不保存此项' }).count(), 0);
  await page.locator('#dlgOk').click();
  await config.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.app.project.data.recipeVariables), ['目标速度', '自动模式', '规格名称']);
  await openConfig();
  assert.equal(await config.getByRole('checkbox', { name: '目标速度' }).isChecked(), true);
  await page.locator('#dlgCancel').click();
  await page.evaluate(async () => {
    await window.app.enterRun();
    await window.app.backend.syncVarTable(window.app.project.variables(), []);
  });

  const name = '配方 A';
  const other = '配方 B';
  const first = { 目标速度: 12, 自动模式: false, 规格名称: '初始 A', 不保存此项: 77 };
  const second = { 目标速度: 22, 自动模式: true, 规格名称: '初始 B' };
  const put = (name, vars) => page.evaluate(({ name, vars }) =>
    window.app.backend.rpc('/api/recipes', { body: { action: 'save', name, vars } }), { name, vars });
  const read = async name => (await page.evaluate(name => window.app.backend.rpc('/api/recipes?name=' + encodeURIComponent(name), { method: 'GET' }), name)).recipe.vars;
  await put(name, first);
  await put(other, second);

  const grid = page.locator('#rtPage .w-recipe-editor');
  await grid.getByRole('button', { name: '刷新', exact: true }).click();
  const table = grid.getByRole('table', { name: '配方数据' });
  await table.getByRole('columnheader').filter({ hasText: name }).waitFor();
  assert.equal(await table.getByRole('columnheader').count(), 3);
  assert.equal(await table.getByRole('rowheader', { name: '目标速度', exact: true }).count(), 1);
  assert.equal(await table.getByRole('rowheader', { name: '不保存此项', exact: true }).count(), 0);
  const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '目标速度', exact: true }) });
  assert.deepEqual(await row.getByRole('cell').allTextContents(), ['12', '22']);
  assert.equal(await page.locator('#recipeManager').count(), 0);
  const lockedCell = table.getByRole('button', { name: '目标速度 · ' + name, exact: true });
  await lockedCell.click();
  await page.locator('#permMask').waitFor();
  await page.locator('#permCancel').click();
  assert.equal(await table.getByRole('spinbutton').count(), 0);
  async function unlock() {
    await page.locator('#permPw').fill('6688');
    await page.locator('#permOk').click();
  }
  await lockedCell.click();
  await unlock();
  const value = name => table.getByRole('spinbutton', { name: '目标速度 · ' + name, exact: true });
  const button = name => grid.getByRole('button', { name, exact: true });
  await value(name).click();
  await page.locator('#npKeys').waitFor();
  for (const key of '150') await page.locator('#npKeys button[data-k="' + key + '"]').click();
  // 有其他控件刷新配方列表时，正在用软键盘编辑的单元格应保留。
  await page.evaluate(async () => (await import('/js/core/recipeValues.js')).recipesChanged());
  await page.locator('#npKeys button[data-k="ok"]').click();
  assert.equal(await value(name).inputValue(), '150');
  assert.deepEqual(await read(name), first);
  const description = table.getByRole('textbox', { name: '规格名称 · ' + name, exact: true });
  await description.click();
  await page.locator('#npText [data-k="z"]').click();
  await page.locator('#npCancel').click();
  assert.equal(await description.inputValue(), '初始 A');
  await value(other).fill('250');
  keepOld = true;
  await button('保存 ' + name).click();
  await value(name).waitFor();
  assert.deepEqual(await read(name), first);
  keepOld = false;

  await page.evaluate(async () => (await import('/js/runtime/permissions.js')).lock());
  await button('保存 ' + name).click();
  await page.locator('#permMask').waitFor();
  assert.deepEqual(await read(name), first);
  await unlock();
  await button('保存 ' + name).click();
  await grid.getByRole('status').filter({ hasText: '已保存「配方 A」' }).waitFor();
  assert.deepEqual(await read(name), { 目标速度: 150, 自动模式: false, 规格名称: '初始 A' });
  assert.deepEqual(await read(other), second);
  await button('刷新').click();
  assert.equal(await value(other).inputValue(), '250');
  assert.equal(await page.evaluate(async () => (await window.app.backend.readVars()).目标速度), 10);

  await put(other, { ...second, 目标速度: 175 });
  await button('保存 ' + other).click();
  await grid.getByRole('status').filter({ hasText: '其它窗口修改' }).waitFor();
  await button('重读 ' + other).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="目标速度 · 配方 B"]')?.value === '175');
  await button('另存 ' + other).click();
  await table.getByRole('textbox', { name: '新配方名称' }).fill('配方 C');
  await button('保存新配方').click();
  await table.getByRole('columnheader').filter({ hasText: '配方 C' }).waitFor();
  assert.deepEqual(await read('配方 C'), { ...second, 目标速度: 175 });
  await button('删除 配方 C').click();
  await table.getByRole('columnheader').filter({ hasText: '配方 C' }).waitFor({ state: 'detached' });

  await button('新建配方').click();
  await table.getByRole('textbox', { name: '新配方名称' }).fill('当前参数');
  for (const value of [1, 0]) {
    await page.evaluate(v => window.app.backend.writeVar('自动模式', v, { internal: true }), value);
    await button('读取当前值 新配方').click();
    await grid.getByRole('status').filter({ hasText: '已读取 3 项当前值' }).waitFor();
    await page.waitForFunction(v =>
      document.querySelector('select[aria-label="自动模式 · 新配方"]')?.value === String(Boolean(v)), value);
  }
  await button('保存新配方').click();
  await table.getByRole('columnheader').filter({ hasText: '当前参数' }).waitFor();
  assert.equal((await read('当前参数')).目标速度, 10);
  assert.equal((await read('当前参数')).自动模式, false);

  await page.locator('#rtPage .wd-button').getByText('外部入口').click();
  const manager = page.getByRole('dialog', { name: '配方管理' });
  const selected = manager.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  await selected.getByRole('button', { name: '查看' }).click();
  await manager.getByRole('table', { name: '配方参数' }).getByRole('cell', { name: '150', exact: true }).waitFor();
  assert.equal(await manager.getByRole('button', { name: /新建|保存|编辑/ }).count(), 0);
  await manager.getByRole('button', { name: '返回运行画面' }).click();
  await value(other).fill('176');
  await page.evaluate(async () => {
    const i18n = await import('/js/core/i18n.js');
    i18n.addLanguage('en', 'English');
    const entries = i18n.collectEntries();
    if (entries.filter(e => e.source === '刷新').length !== 1) throw new Error('相同内置文字应只出现在翻译表一次');
    if (!entries.some(e => e.source === '保存 {name}')) throw new Error('翻译表缺少配方表格内置文字');
    const result = i18n.importTranslationCsv([
      '分类,位置,字段,原文,en',
      '控件,配方数据编辑,内置文字,变量,Parameter',
      '控件,配方数据编辑,内置文字,配方数据,Recipe data',
      '控件,配方数据编辑,内置文字,刷新,Refresh',
      '控件,配方数据编辑,内置文字,保存 {name},Save {name}',
    ].join('\r\n'));
    if (result.filled !== 4) throw new Error('没有导入全部表格译文');
    i18n.setLang('en');
  });
  await grid.getByRole('table', { name: 'Recipe data' }).getByRole('columnheader', { name: 'Parameter' }).waitFor();
  await grid.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
  await grid.getByRole('button', { name: 'Save 配方 B', exact: true }).waitFor();
  assert.equal(await grid.getByRole('spinbutton', { name: '目标速度 · 配方 B', exact: true }).inputValue(), '176');
  assert.deepEqual(errors, []);
  console.log('PASS  配方同表列展示、控件权限、独立保存、并发冲突、新建另存和删除');
} finally {
  await browser.close();
}

