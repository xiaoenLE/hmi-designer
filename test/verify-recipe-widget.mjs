// 配方控件捕获当前值并应用，数据表格编辑单独验证。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const port = process.argv[2];
assert.ok(port, '请用 tools/run-suites.mjs 启动隔离后端');
const { chromium } = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/')('playwright-core');
const exe = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let cancelOverwrite = false;
  let cancelDelete = false;
  const deleteDialogs = [];
  page.on('dialog', dialog => {
    const message = dialog.message();
    if (message.includes('确定删除配方')) {
      deleteDialogs.push(message);
      return cancelDelete ? dialog.dismiss() : dialog.accept();
    }
    return cancelOverwrite && message.includes('覆盖') ? dialog.dismiss() : dialog.accept();
  });
  await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
  const scoped = await page.evaluate(async () => {
    const { project } = window.app;
    const { registry } = await import('/js/widgets/defs.js');
    project.currentPage().widgets.length = 0;
    project.data.variables = [
      { name: '参数[2]', type: 'int', value: 2, address: '' },
      { name: '参数[1]', type: 'int', value: 1, address: '' },
      { name: '备份值', type: 'int', value: 4, address: '' },
      { name: '速度', type: 'int', value: 10, address: '' },
    ];
    const widget = project.addWidget('recipe', 30, 30);
    widget.props.varsText = '参数[0..999999999999]\n参数[1]\n备份值';
    project.setRecipeVariables(['速度', '备份值']);
    const { obfuscate } = await import('/js/core/sha256.js');
    project.setPermissions({ enabled: true, levels: [
      { id: 'pm_recipe_delete', name: '配方删除', pw: obfuscate('6688', 'pm_recipe_delete') },
    ] });
    const i18n = await import('/js/core/i18n.js');
    i18n.addLanguage('en', 'English');
    const keys = ['刷新', '收起', '搜索配方参数', '变量名或保存值', '没有匹配的参数', '已应用 {count} 个'];
    const labels = ['Refresh', 'Collapse', 'Search recipe parameters', 'Variable or saved value',
      'No matching parameters', 'Applied {count} parameter(s)'];
    const csv = i18n.exportTranslationCsv();
    if (keys.some(key => !csv.includes(',' + key + ','))) throw new Error('导出翻译表缺少配方内置文字');
    if (i18n.collectEntries().some(entry => entry.source === '参数[1]')) throw new Error('采集变量名不应导出为译文');
    const { parseCsv } = await import('/js/core/csv.js');
    const [head, ...rows] = parseCsv(csv);
    for (const row of rows) {
      const index = keys.indexOf(row[head.indexOf('原文')]);
      if (index >= 0) row[head.indexOf('en')] = labels[index];
    }
    const translated = [head, ...rows].map(row => row.map(cell => '"' + cell.replaceAll('"', '""') + '"').join(',')).join('\r\n');
    const result = i18n.importTranslationCsv(translated);
    if (result.filled !== keys.length) throw new Error('没有导入全部配方译文：' + JSON.stringify(result));
    const { select } = await import('/js/editor/canvas.js');
    select([widget.id]);
    return registry.get('recipe').scopeVars(widget);
  });
  assert.deepEqual(scoped, ['参数[1]', '参数[2]', '备份值']);
  const keyboardProperty = page.locator('[data-prop="useKeyboard"]');
  assert.equal(await keyboardProperty.isChecked(), true);
  assert.equal(await page.locator('#canvas .w-recipe button:enabled').count(), 0);
  const deleteProperty = page.locator('[data-prop="allowDelete"]');
  assert.equal(await deleteProperty.isChecked(), false);
  await deleteProperty.check();
  await page.getByRole('button', { name: '操作权限', exact: true }).click();
  await page.getByText('删除权限等级', { exact: true }).waitFor();
  await page.locator('[data-prop="permLevel"]').selectOption('pm_recipe_delete');
  await page.evaluate(async () => {
    const { project, backend } = window.app;
    await window.app.enterRun();
    await backend.syncVarTable(project.variables(), []);
  });
  const name = '运行配方 ' + Date.now();
  await page.evaluate(name => window.app.backend.rpc('/api/recipes', {
    body: { action: 'save', name, vars: { 速度: 25 } },
  }), name);
  const sample = '查找样例';
  await page.evaluate(name => window.app.backend.rpc('/api/recipes', {
    body: { action: 'save', name, vars: { ac1_station: 1, ac1_state: 25, 故障参数: [3, 8], 说明: 'READY' } },
  }), sample);
  const widget = page.locator('#rtPage .w-recipe');
  await widget.getByRole('button', { name: '刷新' }).click();
  const recipeRow = title => widget.getByRole('row').filter({
    has: page.getByRole('rowheader', { name: title, exact: true }),
  });
  const search = widget.getByRole('searchbox', { name: '搜索配方参数' });
  const parameters = widget.getByRole('table', { name: '配方参数' });
  await recipeRow(sample).getByRole('button', { name: '查看' }).click();
  assert.equal(await search.getAttribute('inputmode'), 'none');
  await page.setViewportSize({ width: 390, height: 750 });
  await search.click();
  const textKey = key => page.locator('#npText button[data-k="' + key + '"]');
  await page.locator('#npText').waitFor();
  assert.equal(await page.locator('#numPad').evaluate(el => el.getBoundingClientRect().left >= 0
    && el.getBoundingClientRect().right <= window.innerWidth), true);
  for (const key of 'ready') await textKey(key).click();
  await page.locator('#npText [data-kind="ok"]').click();
  assert.equal(await search.inputValue(), 'ready');
  assert.deepEqual(await parameters.getByRole('rowheader').allTextContents(), ['说明']);
  await page.setViewportSize({ width: 1400, height: 850 });
  await search.fill(' AC1_ST ');
  assert.deepEqual(await parameters.getByRole('rowheader').allTextContents(), ['ac1_station', 'ac1_state']);
  assert.equal(await widget.locator('.rc-detail-count').textContent(), '2 / 4');
  await search.fill('READY');
  assert.deepEqual(await parameters.getByRole('rowheader').allTextContents(), ['说明']);
  await widget.getByRole('button', { name: '刷新' }).click();
  await widget.locator('button[data-rcact="refresh"]:enabled').waitFor();
  assert.equal(await search.inputValue(), 'READY');
  assert.deepEqual(await parameters.getByRole('rowheader').allTextContents(), ['说明']);
  const setLanguage = code => page.evaluate(async code => (await import('/js/core/i18n.js')).setLang(code), code);
  await setLanguage('en');
  await widget.getByRole('button', { name: 'Refresh' }).waitFor();
  await widget.getByRole('button', { name: 'Collapse' }).waitFor();
  const englishSearch = widget.getByRole('searchbox', { name: 'Search recipe parameters' });
  assert.equal(await englishSearch.inputValue(), 'READY');
  assert.equal(await englishSearch.getAttribute('placeholder'), 'Variable or saved value');
  await englishSearch.fill('NO RESULT');
  await parameters.getByText('No matching parameters', { exact: true }).waitFor();
  await setLanguage('zh-CN');
  assert.equal(await search.inputValue(), 'NO RESULT');
  await search.fill('不匹配');
  await parameters.getByText('没有匹配的参数', { exact: true }).waitFor();
  await search.clear();
  assert.equal(await parameters.getByRole('rowheader').count(), 4);
  await search.fill('故障');
  const row = recipeRow(name);
  await row.getByRole('button', { name: '查看' }).click();
  await widget.getByRole('cell', { name: '25', exact: true }).waitFor();
  assert.equal(await search.inputValue(), '');
  assert.equal(await widget.locator('input:not([type="search"]), select, textarea').count(), 0);
  assert.equal(await widget.getByRole('button', { name: /编辑|管理/ }).count(), 0);
  await row.locator('.rc-delete-lock').waitFor();
  await row.getByRole('button', { name: '应用' }).click();
  await widget.getByRole('status').filter({ hasText: '已应用 1 个' }).waitFor();
  assert.equal(await page.locator('#permMask').isVisible(), false);
  assert.equal(await page.evaluate(async () => (await window.app.backend.readVars()).速度), 25);
  await setLanguage('en');
  await widget.getByRole('status').filter({ hasText: 'Applied 1 parameter(s)' }).waitFor();
  await setLanguage('zh-CN');
  await widget.getByRole('button', { name: '收起' }).click();
  assert.equal(await widget.getByRole('cell', { name: '25', exact: true }).count(), 0);
  await widget.getByRole('button', { name: '保存当前值' }).click();
  const recipeName = widget.locator('.rc-save-form input');
  await recipeName.click();
  await textKey('b').click();
  await page.locator('#npText [data-kind="ok"]').click();
  assert.equal(await recipeName.inputValue(), 'b');
  await widget.locator('.rc-save-form').getByRole('button', { name: '取消' }).click();
  const saveAs = async (title) => {
    const form = widget.locator('.rc-save-form');
    if (!await form.isVisible()) await widget.getByRole('button', { name: '保存当前值' }).click();
    await form.getByRole('textbox', { name: '配方名称' }).fill(title);
    await form.getByRole('button', { name: '保存', exact: true }).click();
  };
  const read = title => page.evaluate(name => window.app.backend.rpc('/api/recipes?name=' + encodeURIComponent(name), { method: 'GET' }), title);
  const copy = name + ' 当前值';
  await saveAs(copy);
  await widget.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await widget.getByRole('row').filter({ has: page.getByRole('rowheader', { name: copy, exact: true }) }).waitFor();
  assert.deepEqual((await read(copy)).recipe.vars, { 备份值: 4, 速度: 25 });
  cancelOverwrite = true;
  await saveAs(name);
  await widget.locator('.rc-save-form button:enabled[type="submit"]').waitFor();
  assert.deepEqual((await read(name)).recipe.vars, { 速度: 25 });
  cancelOverwrite = false;
  await saveAs(name);
  await widget.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.deepEqual((await read(name)).recipe.vars, { 备份值: 4, 速度: 25 });
  await page.evaluate(() => {
    const real = window.app.backend.rpc.bind(window.app.backend);
    window.app.backend.rpc = (path, options) => path === '/api/recipes/current'
      ? Promise.resolve({ values: { 速度: 40 } }) : real(path, options);
  });
  await saveAs(name);
  await widget.getByRole('status').filter({ hasText: '未读到 1 项当前值' }).waitFor();
  assert.deepEqual((await read(name)).recipe.vars, { 备份值: 4, 速度: 25 });
  await widget.locator('.rc-save-form').getByRole('button', { name: '取消' }).click();
  const deleteRow = recipeRow(copy);
  const deleteButton = deleteRow.getByRole('button', { name: '删除', exact: true });
  await deleteRow.getByRole('button', { name: '查看', exact: true }).click();
  await deleteButton.click();
  await page.locator('#permMask').waitFor();
  assert.deepEqual(deleteDialogs, []);
  assert.equal(await page.locator('#permLevelName').textContent(), '配方删除');
  await page.locator('#permCancel').click();
  assert.deepEqual((await read(copy)).recipe.vars, { 备份值: 4, 速度: 25 });
  await deleteButton.click();
  await page.locator('#permPw').fill('6688');
  await page.locator('#permOk').click();
  await deleteRow.locator('.rc-delete-lock').waitFor({ state: 'hidden' });
  cancelDelete = true;
  await deleteButton.click();
  await deleteRow.locator('button[data-rcact="delete"]:enabled').waitFor();
  assert.deepEqual((await read(copy)).recipe.vars, { 备份值: 4, 速度: 25 });
  assert.equal(deleteDialogs[0], `确定删除配方「${copy}」？`);
  cancelDelete = false;
  await page.evaluate(name => window.app.backend.rpc('/api/recipes', {
    body: { action: 'save', name, vars: { 速度: 31 } },
  }), copy);
  await deleteButton.click();
  await widget.getByRole('status').filter({ hasText: '其它窗口修改' }).waitFor();
  assert.deepEqual((await read(copy)).recipe.vars, { 速度: 31 });
  await widget.getByRole('button', { name: '刷新' }).click();
  await parameters.getByRole('cell', { name: '31', exact: true }).waitFor();
  await deleteButton.click();
  await widget.getByRole('status').filter({ hasText: '已删除' }).waitFor();
  assert.equal(await deleteRow.count(), 0);
  assert.equal(await parameters.count(), 0);
  await page.evaluate(async () => {
    await window.app.exitRun();
    const { select } = await import('/js/editor/canvas.js');
    select([window.app.project.currentPage().widgets.find(w => w.type === 'recipe').id]);
  });
  await keyboardProperty.uncheck();
  await page.evaluate(() => window.app.enterRun());
  await recipeRow(sample).getByRole('button', { name: '查看' }).click();
  assert.equal(await search.getAttribute('inputmode'), null);
  await search.click();
  await page.locator('#numPad').waitFor({ state: 'hidden' });
  await search.pressSequentially('ac1_State');
  assert.deepEqual(await parameters.getByRole('rowheader').allTextContents(), ['ac1_state']);
  assert.deepEqual(errors, []);
  console.log('PASS  配方控件删除确认、删除权限、并发保护、保存和应用');
} finally {
  await browser.close();
}
