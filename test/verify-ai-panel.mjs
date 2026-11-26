/**
 * verify-ai-panel.mjs —— AI 助手面板 UI 全流程（真浏览器 + 假模型 SSE）
 *
 * 覆盖：面板装配 / 状态点 / 输入发送（Enter）/ 工具卡片 / 新建会话 /
 *       设置对话框（测试连接）/ 翻译对话框（加语言→翻译）/ markdown 渲染 /
 *       停止按钮（取消） / 控制台无报错。
 *
 * 跑法：node test/verify-ai-panel.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installNodeFetchPatch } from './_wsfetch.mjs';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra))); }
};
const section = t => console.log(`\n== ${t} ==`);

// ── 假小米模型（OpenAI 兼容 SSE，按 fake.mode 切换剧本） ──────────────────────
const fake = { mode: 'tool', calls: [], pageName: 'AI测试页' };

function fakeModel() {
  const srv = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', c => { raw += c; });
    rq.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
      if (!String(rq.url).includes('/chat/completions')) { rs.writeHead(404); rs.end(); return; }
      fake.calls.push({ url: rq.url, body });
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const mode = fake.mode;
      const contextCase = mode === 'context' || mode === 'context-stop';
      if (contextCase && msgs.some(m => m.role === 'tool')) {
        rs.writeHead(400, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Maximum context length exceeded' } }));
      }
      rs.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const chunk = o => rs.write('data: ' + JSON.stringify(o) + '\n\n');
      const delta = d => chunk({ choices: [{ index: 0, delta: d, finish_reason: null }] });
      const finish = (fr, usage) => {
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });
        if (usage) chunk({ choices: [], usage });
        rs.write('data: [DONE]\n\n');
        rs.end();
      };
      const lastRole = msgs.length ? msgs[msgs.length - 1].role : '';
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const jsonMode = body.response_format?.type === 'json_object';
      if (contextCase && msgs.some(m => m.role === 'assistant' && String(m.content).startsWith('本次任务前面已处理'))) {
        if (mode === 'context-stop') {
          chunk({ error: { message: 'Maximum context length exceeded' } });
          return rs.end();
        }
        delta({ content: '已根据压缩后的上下文完成检查。' });
        return finish('stop', { prompt_tokens: 150, completion_tokens: 12 });
      }
      if (mode === 'output-limit') {
        delta({ content: '回复只生成了一部分。' });
        return finish('length', { prompt_tokens: 20, completion_tokens: 10 });
      }

      // 慢响应：先吐一点正文，然后挂着不结束 —— 给「停止」按钮留时间
      if (mode === 'slow') {
        delta({ role: 'assistant' });
        delta({ content: '正在慢慢想…' });
        setTimeout(() => { try { finish('stop', { prompt_tokens: 11, completion_tokens: 3 }); } catch { /* 忽略 */ } }, 9000);
        return;
      }
      // markdown 渲染：粗体 / 列表 / 代码围栏
      if (mode === 'md') {
        const text = '**结论**：加好了。\n\n- 第一项\n- 第二项\n\n```js\nlet a = 1;\n```\n';
        for (let i = 0; i < text.length; i += 12) delta({ content: text.slice(i, i + 12) });
        return finish('stop', { prompt_tokens: 20, completion_tokens: 10 });
      }
      // single 剧本：模型一轮只调一个工具 —— 散卡片攒到第 3 个应被自动收拢成折叠组
      if (mode === 'single' && hasTools) {
        const rounds = msgs.filter(m => m.role === 'tool').length;
        if (rounds < 3) {
          const types = ['alarmBar', 'trend', 'gauge'];
          const args = JSON.stringify({ type: types[rounds] });
          chunk({
            choices: [{
              index: 0,
              delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_s' + rounds, type: 'function', function: { name: 'get_widget_catalog', arguments: '' } }] },
              finish_reason: null,
            }],
          });
          for (let i = 0; i < args.length; i += 9) {
            chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 9) } }] }, finish_reason: null }] });
          }
          return finish('tool_calls', { prompt_tokens: 60, completion_tokens: 8 });
        }
      }
      // 第二轮（工具结果回灌）→ 说人话收尾
      if (mode === 'fail' && hasTools) {
        // 失败剧本：一直调用一个不存在的工具 —— 验"连续失败会纠偏、到第 5 次停手"
        const n = msgs.filter(m => m.role === 'tool').length;
        const args = JSON.stringify({ ids: ['x' + n] });
        chunk({
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_x' + n, type: 'function', function: { name: 'no_such_tool', arguments: '' } }] },
            finish_reason: null,
          }],
        });
        for (let i = 0; i < args.length; i += 9) chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 9) } }] }, finish_reason: null }] });
        return finish('tool_calls', { prompt_tokens: 50, completion_tokens: 5 });
      }
      // repeat 剧本：每轮都发同一个 get_project —— 验"不思考时原地打转会被去重、连续 3 轮停手"
      if (mode === 'repeat' && hasTools) {
        fake.repeatTimes = (fake.repeatTimes || 0) + 1;
        const n = fake.repeatTimes;
        chunk({
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_r' + n, type: 'function', function: { name: 'get_project', arguments: '' } }] },
            finish_reason: null,
          }],
        });
        const args = '{}';
        for (let i = 0; i < args.length; i += 9) chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 9) } }] }, finish_reason: null }] });
        return finish('tool_calls', { prompt_tokens: 50, completion_tokens: 5 });
      }
      // many 剧本：每轮并行查 2 个控件目录，攒到 20 条工具结果才收尾 —— 用来验"历史超预算会自动压缩成前情提要"
      if (mode === 'many' && hasTools) {
        fake.manyTimes = (fake.manyTimes || 0) + 1;
        const done = fake.manyTimes;
        if (done <= 16) {
          const types = ['button', 'lamp', 'label', 'rect', 'trend', 'gauge', 'bar', 'pipe', 'table', 'select'];
          const a = types[done % types.length];
          const b = types[(done + 1) % types.length];
          chunk({
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_m' + done + 'a', type: 'function', function: { name: 'get_widget_catalog', arguments: '' } },
                  { index: 1, id: 'call_m' + done + 'b', type: 'function', function: { name: 'get_widget_catalog', arguments: '' } },
                ],
              },
              finish_reason: null,
            }],
          });
          // 带唯一 _r：否则同样的 {type} 会被重复读取保护判成"重复查询"，历史就压不起来了
          const argsA = JSON.stringify({ type: a, _r: done });
          const argsB = JSON.stringify({ type: b, _r: done });
          for (let i = 0; i < Math.max(argsA.length, argsB.length); i += 9) {
            const tc = [];
            if (i < argsA.length) tc.push({ index: 0, function: { arguments: argsA.slice(i, i + 9) } });
            if (i < argsB.length) tc.push({ index: 1, function: { arguments: argsB.slice(i, i + 9) } });
            if (tc.length) chunk({ choices: [{ index: 0, delta: { tool_calls: tc }, finish_reason: null }] });
          }
          return finish('tool_calls', { prompt_tokens: 320, completion_tokens: 12 });
        }
      }
      if (lastRole === 'tool') {
        for (const t of ['已', '建好页面「', fake.pageName, '」。']) delta({ content: t });
        return finish('stop', { prompt_tokens: 120, completion_tokens: 12 });
      }
      // 翻译（JSON 模式）：按请求里的条目编号返回
      if (jsonMode) {
        let items = [];
        try {
          const last = msgs[msgs.length - 1] || {};
          const payload = JSON.parse(String(last.content || '{}'));
          items = Array.isArray(payload.items) ? payload.items : [];
        } catch { /* 忽略 */ }
        const map = {};
        items.forEach(it => { map[String(it.i)] = 'EN:' + String(it.t || ''); });
        const txt = JSON.stringify(map);
        for (let i = 0; i < txt.length; i += 40) delta({ content: txt.slice(i, i + 40) });
        return finish('stop', { prompt_tokens: 90, completion_tokens: 20 });
      }
      if (hasTools) {
        // multi 剧本：一轮并行 5 个 get_widget_catalog —— 用来验"多个工具调用会折成一行"
        const calls = mode === 'multi'
          ? ['alarmBar', 'alarmList', 'alarmHistory', 'trend', 'value'].map((t, i) => ({
            index: i, id: 'call_m' + i, name: 'get_widget_catalog', args: JSON.stringify({ type: t }),
          }))
          : [{ index: 0, id: 'call_fake1', name: 'add_page', args: JSON.stringify({ name: fake.pageName }) }];
        if (contextCase) calls.push({ index: 1, id: 'call_catalog', name: 'get_widget_catalog', args: '{"type":"button"}' });
        chunk({
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: calls.map(c => ({ index: c.index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } })) },
            finish_reason: null,
          }],
        });
        const maxLen = Math.max(...calls.map(c => c.args.length));
        for (let i = 0; i < maxLen; i += 9) {
          chunk({
            choices: [{
              index: 0,
              delta: { tool_calls: calls.filter(c => i < c.args.length).map(c => ({ index: c.index, function: { arguments: c.args.slice(i, i + 9) } })) },
              finish_reason: null,
            }],
          });
        }
        // 带 prompt_tokens_details.cached_tokens：验"缓存命中"会显示在每轮用量里
        return finish('tool_calls', { prompt_tokens: 200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 } });
      }
      delta({ content: '（没有工具可用的普通回答）' });
      finish('stop', { prompt_tokens: 5, completion_tokens: 5 });
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}

const MODEL = await fakeModel();
const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-ai-panel-'));
fs.writeFileSync(path.join(DATA, 'ai.json'), JSON.stringify({
  enabled: true, base_url: `http://127.0.0.1:${MODEL.port}/v1`, model: 'mimo-v2.6-flash',
  api_key: 'sk-test-1234567890abcd', temperature: 0.2, max_tokens: 4000,
  thinking: 'disabled', timeout: 30, max_rounds: 0,
}, null, 2), 'utf8');

const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage();
const bad = [];
page.on('pageerror', e => bad.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') bad.push('console.error: ' + m.text()); });
page.on('response', r => { if (r.status() >= 400) bad.push(`http ${r.status()} ${r.url()}`); });
await page.goto(H + '/', { waitUntil: 'load' });
await sleep(2500);

const visible = sel => page.$eval(sel, el => {
  const r = el.getBoundingClientRect();
  return !!(el.offsetParent !== null && r.width > 0 && r.height > 0);
}).catch(() => false);

try {
  // ── 1. 面板装配 ───────────────────────────────────────────────────────────
  // AI 是**固定在最右边的常驻侧栏**（不是停靠面板）：默认收起，开关控制显示/隐藏，不可拖拽。
  section('1. 固定侧栏（默认收起 → 工程菜单打开 → ✕ 关 → 工程菜单开/关）');
  ok(!(await visible('#aiSide')), '默认收起（最右边侧栏先不显示）');
  ok(await page.$eval('#aiSide', el => el.classList.contains('hidden')), '#aiSide 默认带 hidden 类');
  // 真从工具栏「工程 ▾」菜单点开（验证入口真的通）
  await page.click('#btnProjMenu');
  await sleep(150);
  const menuHasAi = await page.$$eval('.ctx-item .ctx-label', els => els.map(e => e.textContent.trim()));
  ok(menuHasAi.some(t => t.includes('AI 助手')), '工程 ▾ 菜单里有「AI 助手…」', menuHasAi);
  await page.locator('.ctx-item', { hasText: 'AI 助手' }).first().click();
  await sleep(250);
  ok(await visible('#aiSide'), '菜单打开后侧栏可见');
  // 归属：必须在 #aiSide 里，且不在任何 .dock-panes 里（所以不会被 dock 拖来拖去）
  const sideInfo = await page.evaluate(() => {
    const side = document.getElementById('aiSide');
    const panel = document.getElementById('panel-ai');
    return {
      inSide: !!(side && panel && side.contains(panel)),
      inDock: !!(panel && panel.closest('.dock-panes')),
      parent: panel && panel.parentElement ? panel.parentElement.id : '(无)',
      sideLeft: side ? Math.round(side.getBoundingClientRect().left) : -1,
      winW: window.innerWidth,
    };
  });
  ok(sideInfo.inSide && !sideInfo.inDock, 'AI 面板在固定侧栏里、不在停靠区（因此不能拖拽）', sideInfo);
  ok(sideInfo.parent === 'aiSide', 'AI 面板的父元素就是 #aiSide', sideInfo);
  ok(sideInfo.sideLeft > sideInfo.winW * 0.5, '侧栏贴在窗口右边', sideInfo);
  ok(await visible('#panel-ai'), '#panel-ai 打开后可见');
  ok(await visible('#aiInput'), '#aiInput 可见');
  ok(await visible('#aiLog'), '#aiLog 可见');
  await page.click('#aiCloseBtn');
  await sleep(150);
  ok(!(await visible('#aiSide')), '点 ✕ 后侧栏隐藏');
  ok(await page.locator('#btnAi').count() === 0, '主工具栏无独立的 AI 按钮');
  const aiEntry = page.locator('#ctxMenu').getByRole('menuitemcheckbox', { name: 'AI 助手…' });
  await page.click('#btnProjMenu');
  ok(await aiEntry.getAttribute('aria-checked') === 'false', '收起时菜单项为未选中');
  await aiEntry.click();
  await sleep(200);
  ok(await visible('#aiSide'), '工程菜单能重新打开 AI 侧栏');
  await page.click('#btnProjMenu');
  ok(await aiEntry.getAttribute('aria-checked') === 'true', '打开时菜单项显示选中状态');
  await aiEntry.click();
  await sleep(150);
  ok(!(await visible('#aiSide')), '再次通过菜单项收起侧栏');
  await page.click('#btnProjMenu');
  await aiEntry.click();
  await sleep(200);
  ok(await visible('#aiSide'), '为后续用例重新打开侧栏');
  const chips = await page.$$eval('#aiQuick .ai-chip', els => els.map(e => e.dataset.prompt));
  ok(chips.length === 3, '三个快捷示例', chips);
  await page.locator('#aiQuick .ai-chip').first().click();
  ok(await page.inputValue('#aiInput') === chips[0], '快捷示例填入草稿，等用户发送');
  ok(await page.locator('#aiScope').getAttribute('data-scope') === 'chat', '说明类示例进入聊天模式');
  const dot = await page.$eval('#aiStatusDot', el => ({ cls: el.className, title: el.title })).catch(() => null);
  ok(!!dot && /(^|\s)ai-dot(\s|$)/.test(dot.cls) && /(^|\s)ok(\s|$)/.test(dot.cls), '状态点 = 就绪（ok）', dot);
  ok(await page.evaluate(() => !document.getElementById('aiModel')), '面板不显示模型名 / Key 状态（只留状态点）');
  ok(await visible('.ai-empty'), '首屏 .ai-empty 提示在');
  ok(await page.$eval('#aiSendBtn', el => !el.disabled), '发送按钮可用');

  // ── 2. 输入发送（Enter）→ 工具卡片 → 页面进工程 ─────────────────────────
  section('2. 打字 + Enter → add_page 工具卡 → 页面进工程');
  const projectStart = fake.calls.length;
  await page.fill('#aiInput', '新建一个页面');
  ok(await page.locator('#aiScope').getAttribute('data-scope') === 'project', '自动识别新建页面任务');
  await page.press('#aiInput', 'Enter');
  await page.waitForSelector('.ai-msg.user', { timeout: 10000 }).catch(() => {});
  ok(await visible('.ai-msg.user'), '用户消息气泡出现');
  ok(await page.$eval('#aiInput', el => el.value === ''), '发送后输入框已清空');
  await page.waitForSelector('.ai-tool.ok', { timeout: 40000 }).catch(() => {});
  ok(await visible('.ai-tool'), '工具调用卡片出现');
  ok(await visible('.ai-tool.ok'), '工具卡片变成 ok（执行成功）');
  const toolName = await page.$eval('.ai-tool-name', el => el.textContent.trim()).catch(() => '');
  ok(/add_page/.test(toolName), '工具卡显示 add_page', toolName);
  await page.waitForFunction(() => {
    const b = document.querySelector('.ai-msg.assistant .ai-bubble');
    return b && b.textContent.includes('已建好页面');
  }, null, { timeout: 40000 }).catch(() => {});
  const bubble = await page.$eval('.ai-msg.assistant .ai-bubble', el => el.textContent).catch(() => '');
  ok(bubble.includes('已建好页面'), '助手流式收尾语渲染出来了', bubble.slice(0, 120));
  const pagesNow = await page.evaluate(() => window.app.project.pages().map(p => p.name));
  ok(pagesNow.includes('AI测试页'), '页面「AI测试页」已进工程', pagesNow);
  await page.waitForFunction(() => document.querySelector('#aiStopBtn')?.classList.contains('hidden'), null, { timeout: 1000 }).catch(() => {});
  ok(await page.$eval('#aiStopBtn', el => el.classList.contains('hidden')), '结束后「停止」按钮已隐藏');
  ok(await page.$eval('#aiSendBtn', el => !el.disabled), '结束后发送按钮恢复');
  ok(await page.locator('#aiTaskStatus').textContent() === '已完成', '正常完成后输入区显示状态');
  const roundTxt = await page.$eval('.ai-msg.assistant .ai-round', el => el.textContent.trim()).catch(() => '');
  ok(/第 1 轮 · 用时 [\d.]+m?s/.test(roundTxt), '消息里显示本轮用时', roundTxt);
  ok(/↑\d/.test(roundTxt) && /↓\d/.test(roundTxt) && /tok/.test(roundTxt), '本轮显示 token 用量（↑输入 ↓输出）', roundTxt);
  ok(/\(缓存 40\)/.test(roundTxt), '本轮显示缓存命中（↑输入(缓存 40)）', roundTxt);


  const projectCalls = fake.calls.slice(projectStart);
  const defs = projectCalls[0]?.body.tools?.map(tool => tool.function.name) || [];
  ok(projectCalls.length === 2 && defs.length <= 6 && defs.includes('add_page'), '建页走两次模型请求，仅下发页面工具', defs);
  fake.mode = 'md';
  const chatStart = fake.calls.length;
  await page.fill('#aiInput', '你好，怎么选择数值控件？');
  await page.press('#aiInput', 'Enter');
  await page.waitForFunction(() => document.querySelector('#aiStopBtn').classList.contains('hidden'));
  const chatCalls = fake.calls.slice(chatStart);
  const chatBody = chatCalls[0]?.body || {};
  ok(chatCalls.length === 1 && !('tools' in chatBody) && !('tool_choice' in chatBody), '普通对话只有一个模型请求且没有工具字段', Object.keys(chatBody));
  ok(chatBody.messages?.length === 2 && !JSON.stringify(chatBody).includes('AI测试页'), '聊天请求不带工程快照或上一条工程任务', chatBody.messages?.map(m => m.role));

  await page.click('[data-mode="chat"]');
  await page.fill('#aiInput', '新建一个页面');
  ok(await page.locator('#aiScope').getAttribute('data-scope') === 'chat', '手动聊天覆盖自动识别');
  await page.press('#aiInput', 'Enter');
  await page.waitForFunction(() => document.querySelector('#aiStopBtn').classList.contains('hidden'));
  const explicit = fake.calls.at(-1).body;
  ok(!explicit.tools && !explicit.tool_choice && explicit.messages.some(m => m.content.includes('数值控件')), '聊天模式保留最近聊天且仍不带工具');
  await page.click('[data-mode="auto"]');
  fake.mode = 'tool';

  await page.click('[data-mode="project"]');
  await page.fill('#aiInput', '新建一个页面');
  fake.pageName = '第二个测试页';
  const nextStart = fake.calls.length;
  await page.press('#aiInput', 'Enter');
  await page.waitForFunction(() => document.querySelector('#aiStopBtn').classList.contains('hidden'));
  const follow = fake.calls[nextStart]?.body;
  ok(follow?.tools?.some(tool => tool.function.name === 'add_page'), '手动工程模式启用工具');
  ok(follow && !follow.messages.some(m => m.role === 'tool' || m.tool_calls), '新工程任务只带对话和执行摘要，旧工具调用不会回灌');
  await page.click('[data-mode="auto"]');

  // ── 3. 新建会话 ───────────────────────────────────────────────────────────
  section('3. 新建会话');
  const lenBefore = await page.evaluate(async () => (await import('/js/editor/aiPanel.js')).aiConversationLength());
  ok(lenBefore > 0, '新建前会话有上下文', lenBefore);
  await page.click('#aiClearBtn');
  await sleep(400);
  ok(await visible('.ai-empty'), '新建后回到首屏提示');
  const lenAfter = await page.evaluate(async () => (await import('/js/editor/aiPanel.js')).aiConversationLength());
  ok(lenAfter === 0, '新建后会话长度 = 0', lenAfter);
  const pagesAfterClear = await page.evaluate(() => window.app.project.pages().map(p => p.name));
  ok(pagesAfterClear.includes('AI测试页'), '新建会话不动工程内容', pagesAfterClear);

  // ── 4. 设置对话框：回填 + 测试连接 ────────────────────────────────────────
  section('4. AI 设置对话框（掩码 / 测试连接）');
  await page.click('#aiSettingsBtn');
  await page.waitForSelector('#dlgMask', { timeout: 5000 }).catch(() => {});
  ok(await page.$eval('#dlgBox', el => el.textContent).then(t => t.includes('AI 设置')).catch(() => false), '设置对话框打开');
  const cfgUi = await page.evaluate(() => ({
    base: document.getElementById('aiCfgBase')?.value || '',
    model: document.getElementById('aiCfgModel')?.value || '',
    keyType: document.getElementById('aiCfgKey')?.type || '',
    keyVal: document.getElementById('aiCfgKey')?.value || '',
    keyPh: document.getElementById('aiCfgKey')?.placeholder || '',
    hasRounds: !!document.getElementById('aiCfgRounds'),
    roundsVal: Number(document.getElementById('aiCfgRounds')?.value),
    roundsHint: document.getElementById('aiCfgRounds')?.parentElement?.textContent || '',
    tokVal: Number(document.getElementById('aiCfgTokens')?.value),
    tokHint: document.getElementById('aiCfgTokens')?.parentElement?.textContent || '',
    budgetVal: Number(document.getElementById('aiCfgBudget')?.value),
    budgetHint: document.getElementById('aiCfgBudget')?.parentElement?.textContent || '',
  }));
  ok(cfgUi.base === `http://127.0.0.1:${MODEL.port}/v1`, '接口地址回填正确', cfgUi.base);
  ok(cfgUi.model === 'mimo-v2.6-flash', '模型回填正确', cfgUi.model);
  ok(cfgUi.keyType === 'password' && cfgUi.keyVal === '' && /已保存/.test(cfgUi.keyPh), 'API Key 不回显明文（password + 已保存占位）', cfgUi);
  ok(cfgUi.hasRounds, '有「最多轮数」字段');
  ok(cfgUi.roundsVal === 0, '轮数默认 0 = 不限制', cfgUi.roundsVal);
  ok(/不限制/.test(cfgUi.roundsHint), '轮数输入框旁写明「0 = 不限制」', cfgUi.roundsHint);
  ok(cfgUi.tokVal === 4 && /k token/.test(cfgUi.tokHint), '最大 tokens 用 k token 单位（4000 → 4k）', { v: cfgUi.tokVal, hint: cfgUi.tokHint });
  ok(cfgUi.budgetVal === 60 && /k token/.test(cfgUi.budgetHint), '输入预算用 k token 单位（60000 → 60k）', { v: cfgUi.budgetVal, hint: cfgUi.budgetHint });
  await page.click('#aiCfgTest');
  await page.waitForFunction(() => {
    const o = document.getElementById('aiTestOut');
    return o && /连接正常|连接失败|测试失败/.test(o.textContent);
  }, null, { timeout: 30000 }).catch(() => {});
  const testOut = await page.$eval('#aiTestOut', el => ({ cls: el.className, txt: el.textContent })).catch(() => null);
  ok(!!testOut && /连接正常/.test(testOut.txt), '「测试连接」成功', testOut);
  // 服务商下拉：没保存过时默认是「＋ 新增」，能点预设快速填地址/模型
  const prov = await page.evaluate(() => ({
    hasSel: !!document.getElementById('aiCfgProvider'),
    opts: Array.from(document.getElementById('aiCfgProvider')?.options || []).map(o => o.value),
    presetVisible: (() => { const b = document.getElementById('aiCfgPresets'); return b ? getComputedStyle(b).display !== 'none' : false; })(),
    presets: Array.from(document.querySelectorAll('#aiCfgPresets [data-preset]')).map(b => (b.textContent || '').trim()),
  }));
  ok(prov.hasSel, '设置里有「服务商」下拉');
  ok(prov.opts.includes('__new__'), '下拉里有「＋ 新增 / 换服务商」', prov.opts);
  ok(prov.presetVisible && prov.presets.length >= 4, '新增模式下显示服务商预设按钮', prov.presets);
  ok(prov.presets.some(t => /小米/.test(t)) && prov.presets.some(t => /LM Studio/.test(t)), '预设里有小米 MiMo 和 LM Studio', prov.presets);
  await page.click('#aiCfgPresets [data-preset="xiaomi"]');
  const presetFill = await page.evaluate(() => ({
    base: document.getElementById('aiCfgBase')?.value || '',
    model: document.getElementById('aiCfgModel')?.value || '',
    keyPh: document.getElementById('aiCfgKey')?.placeholder || '',
  }));
  ok(presetFill.base === 'https://api.xiaomimimo.com/v1', '点「小米 MiMo」预设自动填接口地址', presetFill.base);
  ok(/mimo/.test(presetFill.model), '预设还填了默认模型', presetFill.model);
  await page.click('#dlgX');
  await sleep(300);
  ok(!(await visible('#dlgMask')), '对话框已关闭');

  // ── 5. 翻译对话框：加语言 → 翻译 → 写 dict ───────────────────────────────
  section('5. 翻译对话框（加语言 → 翻译 → meta.i18n.dict）');
  // 先造两句可翻译文字
  await page.evaluate(() => {
    const project = window.app.project;
    const p = project.pages()[0];
    project.updatePage(p.id, { title: '启动画面' });
    const w = project.addWidget('label', 40, 40);
    const id = w?.id || w?.widget?.id;
    if (id) project.updateWidgetProp(id, 'text', '启动');
    project.commit('seed 翻译用例');
  });
  await page.click('#aiTranslateBtn');
  await page.waitForSelector('#aiTrLang', { timeout: 5000 }).catch(() => {});
  ok(!!(await page.$('#aiTrStart')), '翻译对话框打开');
  ok(!!(await page.$('#aiTrAutofit')), '翻译对话框有「自动缩放字号适配」开关');
  const autofitOn = await page.$eval('#aiTrAutofit', el => !!el.checked);
  ok(autofitOn, '自动适配字号默认打开');
  await page.selectOption('#aiTrPick', 'en');
  await page.click('#aiTrAdd');
  await page.waitForFunction(() => {
    const sel = document.getElementById('aiTrLang');
    return !!(sel && Array.from(sel.options).some(o => o.value === 'en'));
  }, null, { timeout: 5000 }).catch(() => {});
  const langOpts = await page.$$eval('#aiTrLang option', els => els.map(e => e.value));
  ok(langOpts.includes('en'), '添加语言后出现在下拉里', langOpts);
  await page.selectOption('#aiTrLang', 'en');
  await page.click('#aiTrStart');
  await page.waitForFunction(() => {
    const o = document.getElementById('aiTrOut');
    return o && /写入|翻译失败|翻译中断/.test(o.textContent);
  }, null, { timeout: 40000 }).catch(() => {});
  const trOut = await page.$eval('#aiTrOut', el => ({ cls: el.className, txt: el.textContent })).catch(() => null);
  ok(!!trOut && /写入/.test(trOut.txt), '翻译完成并写入', trOut);
  const trState = await page.evaluate(async () => {
    const i18n = await import('/js/core/i18n.js');
    const dict = i18n.i18nState().dict.en || {};
    return { vals: Object.values(dict), lang: i18n.getLang(), n: Object.keys(dict).length };
  });
  ok(trState.n >= 1, 'meta.i18n.dict.en 有译文', trState.n);
  ok(trState.vals.every(v => String(v).startsWith('EN:')), '译文来自模型返回（EN: 前缀）', trState.vals.slice(0, 3));
  ok(trState.lang === 'en', '翻完切到目标语言预览', trState.lang);
  await page.click('#dlgOk');
  await sleep(300);

  // ── 6. markdown 渲染（粗体 / 列表 / 代码块） ─────────────────────────────
  section('6. markdown 渲染');
  fake.mode = 'md';
  await page.fill('#aiInput', '随便说两句');
  await page.press('#aiInput', 'Enter');
  await page.waitForFunction(() => {
    const b = document.querySelectorAll('.ai-msg.assistant .ai-bubble');
    const last = b[b.length - 1];
    return !!(last && last.querySelector('strong, b') && last.querySelector('.ai-code'));
  }, null, { timeout: 40000 }).catch(() => {});
  const md = await page.evaluate(() => {
    const list = document.querySelectorAll('.ai-msg.assistant .ai-bubble');
    const last = list[list.length - 1];
    return {
      strong: !!(last?.querySelector('strong') || last?.querySelector('b')),
      ul: !!last?.querySelector('ul.ai-list'),
      code: !!last?.querySelector('.ai-code'),
      codeLang: last?.querySelector('.ai-code-lang')?.textContent || '',
    };
  });
  ok(md.strong, '**粗体** 渲染成 <b>/<strong>');
  ok(md.ul, '- 列表 渲染成 <ul class="ai-list">');
  ok(md.code && /js/i.test(md.codeLang), '```js 代码块渲染成 .ai-code + 语言标签', md);

  // ── 7. 停止按钮（取消正在跑的请求） ──────────────────────────────────────
  section('7. 停止按钮 → 取消');
  fake.mode = 'slow';
  await page.fill('#aiInput', '慢一点回答');
  await page.press('#aiInput', 'Enter');
  await page.waitForFunction(() => {
    const b = document.getElementById('aiStopBtn');
    return b && !b.classList.contains('hidden');
  }, null, { timeout: 15000 }).catch(() => {});
  ok(await page.$eval('#aiStopBtn', el => !el.classList.contains('hidden')), '请求中「停止」按钮可见');
  ok(await page.$eval('#aiSendBtn', el => el.disabled), '请求中发送按钮禁用');
  // 实时计时：慢响应期间「第 1 轮 · 用时」应该自己在走（不是等这一轮结束才冒出来）
  const roundNow = () => page.$$eval('.ai-msg.assistant .ai-round', els => els.length ? els[els.length - 1].textContent.trim() : '').catch(() => '');
  await sleep(900);
  const live1 = await roundNow();
  await sleep(700);
  const live2 = await roundNow();
  ok(/第 1 轮 · 用时/.test(live1), '请求中就已经显示本轮计时行', live1);
  ok(!!live1 && live1 !== live2, '计时是实时的（两次采样数值在变）', [live1, live2]);
  await page.click('#aiStopBtn');
  await page.waitForFunction(() => {
    const bubbles = document.querySelectorAll('.ai-msg.assistant .ai-bubble');
    return Array.from(bubbles).some(b => /（已停止）/.test(b.textContent));
  }, null, { timeout: 15000 }).catch(() => {});
  const stopped = await page.evaluate(() => {
    const bubbles = document.querySelectorAll('.ai-msg.assistant .ai-bubble');
    return Array.from(bubbles).map(b => b.textContent).join('\n');
  });
  ok(/（已停止）/.test(stopped), '面板显示「（已停止）」', stopped.slice(-80));
  await page.waitForFunction(() => document.getElementById('aiStopBtn')?.classList.contains('hidden'), null, { timeout: 10000 }).catch(() => {});
  ok(await page.$eval('#aiStopBtn', el => el.classList.contains('hidden')), '停止后按钮隐藏');
  ok(await page.$eval('#aiSendBtn', el => !el.disabled), '停止后发送按钮恢复');
  ok(await page.locator('#aiTaskStatus').textContent() === '已停止', '手动停止后输入区显示状态');
  ok(await page.locator('#stNote').textContent() === 'AI 助手：已停止', '手动停止后状态栏也显示提示');

  // ── 8. 破坏性操作开关 ────────────────────────────────────────────────────
  section('8. 「允许破坏性操作」开关');
  const gate0 = await page.evaluate(async () => (await import('/js/editor/aiTools.js')).getAllowDestructive());
  ok(gate0 === false, '默认不允许删除类操作', gate0);
  await page.check('#aiAllowDestructive');
  const gate1 = await page.evaluate(async () => (await import('/js/editor/aiTools.js')).getAllowDestructive());
  ok(gate1 === true, '勾上后允许', gate1);
  await page.uncheck('#aiAllowDestructive');

  // ── 9. 工具调用折叠（一轮多个工具 → 收成一行，点开才看明细） ──────────────
  section('9. 工具调用折叠（一轮 5 个工具 → 一行摘要，点开看明细）');
  await page.click('#aiClearBtn');
  await sleep(250);
  fake.mode = 'multi';
  await page.fill('#aiInput', '看看报警和波形类控件都有哪些');
  await page.press('#aiInput', 'Enter');
  await page.waitForSelector('.ai-tool-group', { timeout: 40000 }).catch(() => {});
  await page.waitForFunction(() => {
    const s = document.querySelector('.ai-tool-group-state');
    return s && /全部成功|个失败/.test(s.textContent);
  }, { timeout: 40000 }).catch(() => {});
  ok(await visible('.ai-tool-group'), '多个工具调用被收成一个折叠组');
  const ghead = await page.$eval('.ai-tool-group-head', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  ok(/调用 5 个工具/.test(ghead), '组标题写「调用 5 个工具」', ghead);
  ok(/get_widget_catalog ×5/.test(ghead), '组摘要列出 工具名 × 次数', ghead);
  const visCard = await page.$$eval('.ai-tool', els => els.filter(el => el.offsetParent !== null).map(el => ({ cls: el.className, txt: el.textContent.replace(/\s+/g, ' ').slice(0, 24) }))).catch(() => []);
  ok(visCard.length === 0, '默认收起：明细卡片不占版面（不刷屏）', visCard);
  await page.click('.ai-tool-group-head');
  await sleep(250);
  ok(await visible('.ai-tool'), '点开后明细卡片才出现');
  const okCards = await page.$$eval('.ai-tool.ok', els => els.filter(el => el.offsetParent !== null).length).catch(() => 0);
  ok(okCards === 5, '5 个工具卡片都成功', okCards);
  const gstate = await page.$eval('.ai-tool-group-state', el => el.textContent.trim()).catch(() => '');
  ok(gstate.includes('全部成功'), '组状态显示「全部成功」', gstate);
  const rounds = await page.$$eval('.ai-msg.assistant .ai-round', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(rounds.length === 2, '两轮各有一行用时', rounds);
  ok(/第 1 轮 · 用时 [\d.]+s/.test(rounds[0] || '') && /第 2 轮 · 用时 [\d.]+s/.test(rounds[1] || ''), '每轮用时逐行累加显示', rounds);
  ok(/↑\d/.test(rounds[0] || '') && /↓\d/.test(rounds[0] || ''), '第 1 轮带 token 用量', rounds[0]);
  ok(/↑\d/.test(rounds[1] || '') && /↓\d/.test(rounds[1] || ''), '第 2 轮带 token 用量', rounds[1]);
  const totalTxt = await page.$eval('.ai-round-total', el => el.textContent.trim()).catch(() => '');
  ok(/共 2 轮 · 总用时 [\d.]+s/.test(totalTxt), '多轮时末尾有总用时', totalTxt);
  // 两轮假模型的用量：第 1 轮 ↑200 ↓30，第 2 轮 ↑120 ↓12 → 累计 ↑320 ↓42
  ok(/↑320/.test(totalTxt) && /↓42/.test(totalTxt), '总用时行带累计 token 用量（↑320 ↓42）', totalTxt);
  // 省 token：第 2 次请求里回灌的工具结果应该是"瘦身版"（否则每轮重发、重复付费）
  const toolMsgs = (fake.calls[fake.calls.length - 1]?.body?.messages || []).filter(m => m.role === 'tool');
  ok(toolMsgs.length === 5, '第 2 次请求里回灌了 5 条工具结果', toolMsgs.length);
  ok(toolMsgs.every(m => String(m.content).length < 1200), '工具结果进历史前被瘦身（每条 < 1200 字）', toolMsgs.map(m => String(m.content).length));
  // 属性键名列表只关心"是数组、里面是键名"，别绑定具体第一个键：2.1.17 起 alarmBar 的第一项
  // 从 joinAll 变成了 levelFilter（报警等级筛选），写死 joinAll 的话每次加属性都会红。
  ok(toolMsgs.some(m => /alarmBar/.test(String(m.content)) && /"props":\["/.test(String(m.content))), '控件目录只留 type/尺寸/属性键名，去掉 label/options', String(toolMsgs[0]?.content || '').slice(0, 160));
  ok(!toolMsgs.some(m => /"label"/.test(String(m.content))), '控件目录里冗长的 label/options 没进历史', '');
  fake.mode = 'tool';
  fake.pageName = 'AI测试页2';

  // ── 10. 一轮只调一个工具：散卡片攒到第 3 个自动收拢 ──────────────────────
  section('10. 一轮一个工具 → 散卡片攒到第 3 个自动收拢成一个折叠组');
  await page.click('#aiClearBtn');
  await sleep(250);
  fake.mode = 'single';
  await page.fill('#aiInput', '帮我看看这几个控件的属性');
  await page.press('#aiInput', 'Enter');
  await page.waitForSelector('.ai-tool-group', { timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => {
    const s = document.querySelector('.ai-tool-group-state');
    return s && /全部成功|个失败/.test(s.textContent);
  }, { timeout: 60000 }).catch(() => {});
  ok(await visible('.ai-tool-group'), '散卡片攒到第 3 个时被收拢成一组');
  const g2 = await page.$eval('.ai-tool-group-head', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  ok(/调用 3 个工具/.test(g2), '组标题写「调用 3 个工具」', g2);
  ok(/get_widget_catalog ×3/.test(g2), '组摘要列出 get_widget_catalog ×3', g2);
  const loose2 = await page.$$eval('.ai-toolbox > .ai-tool', els => els.filter(el => el.offsetParent !== null).length).catch(() => 0);
  ok(loose2 === 0, '散卡片已经全部收进组里，外面不再堆卡片', loose2);
  fake.mode = 'tool';

  // ── 11. 工具连续失败 → 自动纠偏 → 同类错误第 3 批停手并给修改建议 ──────────
  section('11. 工具连续失败 → 自动纠偏 → 第 3 次停手并给修改建议');
  await page.click('#aiClearBtn');
  await sleep(250);
  fake.mode = 'fail';
  await page.click('[data-mode="project"]');
  await page.fill('#aiInput', '随便调个工具试试');
  await page.press('#aiInput', 'Enter');
  let gotErr = '';
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    gotErr = await page.$eval('.ai-msg.assistant .ai-err', el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    if (/连续 \d+ 次工具调用都失败/.test(gotErr)) break;
  }
  ok(/连续 3 次工具调用都失败了/.test(gotErr), '同类错误连续 3 批后停手并说明原因', gotErr.slice(0, 120));
  ok(/换个说法|指定要处理/.test(gotErr), '停下时给出可操作的修改建议', gotErr.slice(0, 200));
  const sendEnabled = await page.evaluate(() => !(document.getElementById('aiSendBtn') || {}).disabled);
  ok(sendEnabled, '停手后发送按钮恢复可用（不是卡死状态）', sendEnabled);
  const badCards = await page.$$eval('.ai-tool.bad', els => els.filter(el => el.offsetParent !== null).length);
  ok(badCards >= 3, '失败的工具调用卡片标红可查', badCards);
  fake.mode = 'tool';
  await page.click('[data-mode="auto"]');

  // ── 12. 输入预算：到量自动停手（防长任务无声烧钱） ────────────────────────
  section('12. 输入预算到量自动停手');
  await page.click('#aiClearBtn');
  await sleep(250);
  await page.evaluate(async () => {
    const m = await import('/js/api/ai.js');
    await m.aiClient.saveConfig({ budget_tokens: 50 });
  });
  fake.mode = 'tool';
  fake.pageName = '预算测试页';
  await page.fill('#aiInput', '建一个页面');
  await page.press('#aiInput', 'Enter');
  let budNote = '';
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    budNote = await page.$eval('.ai-msg.assistant .ai-note', el => el.textContent.trim()).catch(() => '');
    if (/预算/.test(budNote)) break;
  }
  ok(/预算上限/.test(budNote), '输入 token 到预算就停手并说明', budNote.slice(0, 140));
  const allNotes = await page.$$eval('.ai-msg.assistant .ai-note', els => els.map(e => e.textContent.trim()));
  ok(allNotes.some(t => /再发一句「继续」会重新给一份预算/.test(t)), '预算停下时提示可以继续（新预算）', allNotes.join(' | ').slice(0, 160));
  const sendOk = await page.evaluate(() => !(document.getElementById('aiSendBtn') || {}).disabled);
  ok(sendOk, '预算停手后发送按钮恢复可用');
  ok(await page.locator('#aiTaskStatus').textContent() === '已停止 · 输入预算用完', '预算停手显示具体原因');
  await page.evaluate(async () => {
    const m = await import('/js/api/ai.js');
    await m.aiClient.saveConfig({ budget_tokens: 60000 });
  });
  fake.mode = 'tool';

  // ── 13. 历史超预算 → 自动压成「前情提要」 ────────────────────────────────
  section('13. 长任务滚动保留工具批次');
  await page.click('#aiClearBtn');
  await sleep(250);
  fake.mode = 'many';
  fake.manyTimes = 0;
  await page.fill('#aiInput', '把这些控件的属性都看一遍');
  await page.press('#aiInput', 'Enter');
  let totalLine = '';
  for (let i = 0; i < 200; i++) {
    await sleep(700);
    totalLine = await page.$eval('.ai-round-total', el => el.textContent.trim()).catch(() => '');
    if (/总用时/.test(totalLine)) break;
  }
  ok(/总用时/.test(totalLine), '长任务跑完（多轮）', totalLine.slice(0, 80));

  const lastMsgs = fake.calls.at(-1)?.body.messages || [];
  ok(lastMsgs.some(m => m.role === 'assistant' && String(m.content).startsWith('本次任务前面已处理')), '旧批次压成简短执行摘要');
  const unmatched = [];
  for (const m of lastMsgs) {
    if (m.tool_calls?.length) unmatched.push(...m.tool_calls.map(c => c.id));
    if (m.role === 'tool' && unmatched.shift() !== m.tool_call_id) unmatched.push('不匹配');
  }
  const toolAfter = lastMsgs.filter(m => m.role === 'tool');
  ok(toolAfter.length <= 12 && unmatched.length === 0, '裁剪保留最多六批且工具协议完整', { tools: toolAfter.length, unmatched });
  ok(lastMsgs.some(m => m.role === 'user' && m.content.includes('把这些控件')), '长任务仍保留当前用户指令');
  const bytes = Buffer.byteLength(JSON.stringify(lastMsgs));
  ok(bytes < 40000, '模型长任务上下文体积有界', bytes);

  fake.mode = 'tool';

  section('13b. 模型返回上下文超限后压缩重试');
  for (const mode of ['context', 'context-stop']) {
    await page.click('#aiClearBtn');
    fake.mode = mode;
    fake.pageName = mode === 'context' ? '压缩后继续测试页' : '压缩后停止测试页';
    const from = fake.calls.length;
    await page.locator('#aiAttachmentPicker').setInputFiles({
      name: '设计说明.txt', mimeType: 'text/plain', buffer: Buffer.from('HMI_CONTEXT_RETRY_ATTACHMENT'),
    });
    await page.locator('#aiAttachments .ai-file-chip').waitFor();
    await page.fill('#aiInput', '新建一个页面并检查按钮控件布局');
    await page.press('#aiInput', 'Enter');
    await page.locator('#aiStopBtn').waitFor({ state: 'hidden', timeout: 10000 });
    const requests = fake.calls.slice(from).map(c => c.body.messages);
    const rejected = requests[1] || [];
    const compacted = requests[2] || [];
    ok(requests.length === 3, mode + ' 只压缩重试一次', requests.length);
    const source = rejected.findLast(m => m.role === 'user')?.content;
    const retained = compacted.findLast(m => m.role === 'user')?.content;
    ok(String(source).includes('HMI_CONTEXT_RETRY_ATTACHMENT') && JSON.stringify(retained) === JSON.stringify(source), mode + ' 保留本条指令和附件');
    ok(JSON.stringify(compacted).length < JSON.stringify(rejected).length && !compacted.some(m => m.role === 'tool'), mode + ' 用更短的摘要替换已执行工具的明细');
    const pageCount = await page.evaluate(name => window.app.project.pages().filter(p => p.name === name).length, fake.pageName);
    ok(pageCount === 1, mode + ' 已执行的创建页面只发生一次', pageCount);
    const taskState = await page.locator('#aiTaskStatus').textContent();
    const bubble = await page.locator('.ai-msg.assistant .ai-bubble').textContent();
    ok(bubble.includes('已压缩历史并重新请求'), mode + ' 会话显示压缩重试');
    ok(mode === 'context'
      ? taskState === '已完成' && bubble.includes('完成检查')
      : taskState === '已停止 · 模型上下文超限' && bubble.includes('压缩历史后仍超过模型上下文'), mode + ' 显示最终状态', taskState);
  }
  await page.click('#aiClearBtn');
  fake.mode = 'output-limit';
  await page.fill('#aiInput', '介绍一下组态助手');
  await page.press('#aiInput', 'Enter');
  await page.locator('#aiStopBtn').waitFor({ state: 'hidden', timeout: 10000 });
  ok(await page.locator('#aiTaskStatus').textContent() === '已停止 · 达到回复长度上限', '模型截断回复时显示长度上限');
  fake.mode = 'tool';

  // ── 14. 不思考时原地打转：重复查询被去重、连续 3 轮停手并建议开思考 ───────
  section('14. 重复读取保护（thinking=disabled 反复读同一内容）');
  fake.mode = 'repeat';
  fake.repeatTimes = 0;
  await page.click('#aiClearBtn');
  await sleep(300);
  await page.fill('#aiInput', '把首页做得好看一点');
  await page.press('#aiInput', 'Enter');
  let errText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(600);
    errText = await page.$eval('.ai-msg.assistant:last-of-type .ai-err, .ai-err', el => el.textContent.trim()).catch(() => '');
    if (/重复/.test(errText)) break;
  }
  ok(/重复查同一批内容/.test(errText), '连续重复读取 → 停手并说明原因', errText.slice(0, 120));
  ok(/思考过程/.test(errText) && /auto|交给模型/.test(errText), '停手时建议打开思考过程(auto)', errText.slice(-120));
  ok(fake.repeatTimes <= 4, '没有无限打转（≤4 轮就停）', fake.repeatTimes);
  const dupSums = await page.$$eval('.ai-tool-sum', els => els.map(e => e.textContent.trim()).filter(s => s));
  ok(dupSums.some(s => /已经执行过|重复/.test(s)) || dupSums.length >= 2, '重复查询的卡片能看到"已执行过"', dupSums.slice(0, 4));
  const sendBack = await page.$eval('#aiSendBtn', el => !el.disabled).catch(() => false);
  ok(sendBack, '停手后发送按钮恢复可用');
  fake.mode = 'tool';


  // ── 历史保留全部消息，续聊仍使用固定大小的上下文 ──
  section('15. 新会话、刷新、查看、续聊、删除');
  const title = '历史记录第1条';
  fake.mode = 'md';
  await page.click('#aiClearBtn');
  await page.locator('#aiAttachmentPicker').setInputFiles({
    name: '历史附件.txt', mimeType: 'text/plain', buffer: Buffer.from('HMI_RAW_ATTACHMENT_TEST'),
  });
  await page.locator('#aiAttachments .ai-file-chip').waitFor();
  for (let i = 1; i <= 7; i++) {
    await page.fill('#aiInput', '历史记录第' + i + '条');
    await page.press('#aiInput', 'Enter');
    await page.locator('#aiStopBtn').waitFor({ state: 'hidden' });
  }
  await page.click('#aiClearBtn');
  ok(await page.locator('.ai-empty').isVisible(), '新会话显示空白聊天');
  const history = page.locator('#aiHistory');
  await page.click('#aiHistoryBtn');
  const saved = history.locator('.ai-history-open').filter({ has: page.getByText(title, { exact: true }) });
  await saved.waitFor();
  ok(await history.locator('.ai-history-row').count() > 1, '旧会话和其它会话都留在历史列表');
  const stored = await page.evaluate(async title => {
    const db = await import('/js/editor/aiHistory.js');
    const session = (await db.listSessions()).find(item => item.title === title);
    return JSON.stringify(await db.readSession(session.id));
  }, title);
  ok(stored.includes('历史附件.txt') && !stored.includes('HMI_RAW_ATTACHMENT_TEST'), '历史只保存附件文件名');

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.ai-dot.ok');
  await page.click('#aiHistoryBtn');
  const queryCount = fake.calls.length;
  await saved.click();
  await page.waitForSelector('#aiLog .ai-msg.user');
  ok(await page.locator('#aiLog .ai-msg.user').count() === 7, '刷新后可打开并查看全部七条历史消息');
  ok(await page.locator('#aiLog .ai-code').count() === 7 && fake.calls.length === queryCount,
    '查看历史保留 Markdown，且不调用模型');

  await page.fill('#aiInput', '历史追问');
  await page.press('#aiInput', 'Enter');
  await page.locator('#aiStopBtn').waitFor({ state: 'hidden' });
  const continued = fake.calls.at(-1)?.body?.messages?.map(m => m.content) || [];
  ok(continued.includes('历史记录第7条') && !continued.includes(title) && !continued.includes('你好，怎么选择数值控件？'),
    '续聊只发当前会话的近期上下文');

  await page.click('#aiHistoryBtn');
  const remove = history.getByRole('button', { name: '删除会话 ' + title, exact: true });
  await remove.click();
  await page.click('#dlgCancel');
  ok(await saved.isVisible(), '取消删除后会话仍可打开');
  await remove.click();
  await page.click('#dlgOk');
  await page.locator('#dlgMask').waitFor({ state: 'hidden' });
  ok(await saved.count() === 0 && await history.locator('.ai-history-row').count() > 0, '删除仅移除选中的会话');
  await page.click('#aiHistoryBack');
  ok(await page.locator('.ai-empty').isVisible(), '删除当前会话后回到空白聊天');
  await page.reload({ waitUntil: 'load' });
  await page.click('#aiHistoryBtn');
  await history.locator('.ai-history-row').first().waitFor();
  ok(await saved.count() === 0, '刷新后已删除的会话没有恢复');

  // ── 16. 收尾：控制台 / 网络 ──────────────────────────────────────────────
  section('16. 收尾检查（控制台 / 网络）');
  const errs = await page.evaluate(() => (window.__appErrors || []).slice());
  ok(errs.length === 0, 'window.__appErrors 为空', errs);
  const realBad = bad.filter(b => !/favicon|net::ERR_ABORTED|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(b));
  ok(realBad.length === 0, '无 pageerror / console.error / 4xx', realBad.slice(0, 6));
} finally {
  await browser.close().catch(() => {});
  srv.kill();
  MODEL.srv.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n===== AI 面板 UI：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
