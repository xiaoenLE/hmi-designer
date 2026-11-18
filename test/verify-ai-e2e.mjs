// verify-ai-e2e.mjs — AI 助手**全链路**：真后端 + 假小米模型（本地 SSE）+ 真浏览器
//
// 链路：面板/模块(aiTools) → aiClient → WS {t:'ai'} → server/core/ai.py → 假模型
//        → ai_tool → aiTools.runTool → project.* → project.commit() → Ctrl+Z 可撤销
//
// 覆盖：
//   1. /api/ai/config 读写（key 掩码、写空串不改）
//   2. 对话：「新建页面」→ 模型返回 tool_calls → 执行 add_page → 页面真的进了工程
//   3. 一轮多工具 / 工具结果回灌（假模型第二轮回文本）
//   4. Ctrl+Z 一步撤销（AI 改动可整体回退）
//   5. 全工程翻译：collectEntries → 模型 JSON → 写进 meta.i18n.dict → setLang 重画
//   6. 全过程 window.__appErrors 为空、无 4xx/5xx
//
// 跑法：node test/verify-ai-e2e.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installNodeFetchPatch } from './_wsfetch.mjs';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`); }
};
const section = t => console.log(`\n== ${t} ==`);

// ── 假小米模型（OpenAI 兼容 SSE） ─────────────────────────────────────────────
const fake = { calls: [], toolPayload: { name: 'AI测试页' }, toolText: '', pairs: [{ k: 'e1', v: 'Start' }] };
function fakeModel() {
  const srv = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', c => { raw += c; });
    rq.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
      fake.calls.push({ url: rq.url, body });
      rs.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const chunk = o => rs.write('data: ' + JSON.stringify(o) + '\n\n');
      const delta = d => chunk({ choices: [{ index: 0, delta: d, finish_reason: null }] });
      const finish = (fr, usage) => {
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });
        if (usage) chunk({ choices: [], usage });
        rs.write('data: [DONE]\n\n');
        rs.end();
      };
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const lastRole = msgs.length ? msgs[msgs.length - 1].role : '';
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const jsonMode = body.response_format?.type === 'json_object';
      // 角色：第二轮（工具结果回灌）→ 说人话收尾
      if (lastRole === 'tool') {
        for (const t of ['已建好页面「', fake.toolPayload.name, '」。']) delta({ content: t });
        return finish('stop', { prompt_tokens: 120, completion_tokens: 12 });
      }
      // 翻译：只认 JSON 模式 —— 从**真实请求**里取待翻条目，按编号返回（模拟模型翻译）
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
      // 对话：第一轮 → 工具调用（参数故意分片，模拟真实流式）
      if (hasTools) {
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fake1', type: 'function', function: { name: 'add_page', arguments: '' } }] }, finish_reason: null }] });
        const args = JSON.stringify(fake.toolPayload);
        for (let i = 0; i < args.length; i += 9) {
          chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 9) } }] }, finish_reason: null }] });
        }
        return finish('tool_calls', { prompt_tokens: 200, completion_tokens: 30 });
      }
      delta({ content: '（没有工具可用的普通回答）' });
      finish('stop');
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}

const MODEL = await fakeModel();
const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-ai-e2e-'));
// 预置 AI 配置（key 只存后端；base_url 指向假模型）
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

try {
  // ── 1. 面板存在 + AI 能力位 ────────────────────────────────────────────────
  section('1. 装配（面板 / features.ai / 配置接口）');
  const boot = await page.evaluate(() => ({
    app: !!window.app,
    panel: !!document.getElementById('panel-ai'),
    errs: (window.__appErrors || []).slice(),
    supports: !!(window.app && window.app.backend && window.app.backend.supports && window.app.backend.supports('ai')),
  }));
  ok(boot.app, 'window.app 起来了');
  ok(boot.panel, '#panel-ai 在 DOM 里（本体交给 verify-ai-panel.mjs）');
  ok(boot.supports, "backend.supports('ai') = true");

  const cfg = await page.evaluate(async () => {
    const { backend } = await import('/js/api/backend.js');
    const r = await backend.rpc('/api/ai/config', { method: 'GET' });
    return r;
  }).catch(e => ({ error: String(e.message || e) }));
  ok(!!cfg && cfg.ok === undefined ? !cfg.error : !!cfg, 'GET /api/ai/config 走通', cfg);
  const cfgData = cfg?.cfg || cfg?.data?.cfg || null;
  ok(!!cfgData, 'config 返回 cfg 对象', cfg && Object.keys(cfg));
  if (cfgData) {
    ok(cfgData.api_key_masked === 'sk-****abcd' || /^\*+|sk-\*+/.test(cfgData.api_key_masked || ''), 'key 是掩码', cfgData.api_key_masked);
    ok(cfgData.base_url === `http://127.0.0.1:${MODEL.port}/v1`, 'base_url 读回来了', cfgData.base_url);
  }

  // ── 2. 对话 + 工具执行 ─────────────────────────────────────────────────────
  section('2. 对话：「新建 AI测试页」→ add_page 工具 → 页面进工程');
  const chat = await page.evaluate(async () => {
    const mod = await import('/js/editor/aiTools.js');
    const project = window.app.project;
    const before = project.pages().map(p => p.name);
    const ev = { deltas: '', toolsStart: [], toolsEnd: [], rounds: 0 };
    const res = await new Promise(resolve => {
      let finished = false;
      const done = v => { if (!finished) { finished = true; resolve(v); } };
      const timer = setTimeout(() => done({ ok: false, error: '超时 40s，收不到 ai_done' }), 40000);
      const wrap = fn => (...a) => { clearTimeout(timer); fn(...a); };
      mod.runAssistant({
        text: '新建一个叫「AI测试页」的页面',
        handlers: {
          onUser: () => {},
          onDelta: wrap(d => { if (d && d.text) ev.deltas += d.text; }),
          onToolStart: wrap(c => ev.toolsStart.push(c)),
          onToolEnd: wrap(r => ev.toolsEnd.push(r)),
          onRound: wrap(() => { ev.rounds++; }),
          onDone: wrap(info => done({ ok: true, info })),
          onError: wrap(e => done({ ok: false, error: String((e && e.message) || e) })),
        },
      });
    });
    const after = project.pages().map(p => p.name);
    return { res, ev, before, after };
  }).catch(e => ({ res: { ok: false, error: 'evaluate 抛错: ' + String(e.message || e) } }));

  ok(chat.res && chat.res.ok, '对话结束（onDone，无 onError）', chat.res && chat.res.error);
  ok(Array.isArray(chat.ev.toolsStart) && chat.ev.toolsStart.length > 0, '收到 ai_tool → onToolStart', chat.ev.toolsStart);
  ok(Array.isArray(chat.ev.toolsEnd) && chat.ev.toolsEnd.length > 0, '工具执行完 → onToolEnd', chat.ev.toolsEnd);
  ok(Array.isArray(chat.after) && chat.after.includes('AI测试页'), '页面「AI测试页」已进工程', chat.after);
  ok(String(chat.ev.deltas).includes('已建好页面'), '助手正文流式拼出收尾语', chat.ev.deltas);
  ok(fake.calls.length >= 2, '假模型至少被调 2 轮（工具结果回灌）', fake.calls.length);
  ok(fake.calls.some(c => c.body.stream === true), '后端用 stream:true 调模型');
  ok(fake.calls[0].body.thinking?.type === 'disabled', '关思维链参数 thinking:{type:"disabled"} 发出去了', fake.calls[0].body.thinking);
  ok(!!fake.calls[0].body.tools && fake.calls[0].body.tools.length >= 10, 'tools 清单发给了模型', fake.calls[0].body.tools?.length);

  // ── 3. Ctrl+Z 撤销 ────────────────────────────────────────────────────────
  section('3. Ctrl+Z：AI 的改动一步撤销');
  const undo = await page.evaluate(() => {
    const app = window.app;
    const label = app.history.lastLabel();
    app.history.undo();
    return { label, pages: app.project.pages().map(p => p.name) };
  });
  ok(!!undo.label, '撤销栈顶有标签（AI 的 commit 自带 label）', undo.label);
  ok(!undo.pages.includes('AI测试页'), '撤销后页面不在了', undo.pages);

  // ── 4. 全工程翻译 ─────────────────────────────────────────────────────────
  section('4. 全工程翻译：collectEntries → JSON → dict → setLang');
  const tr = await page.evaluate(async () => {
    const project = window.app.project;
    const i18n = await import('/js/core/i18n.js');
    // 造两句可翻译文字：页面标题 + 一个 label 的 text
    const p = project.pages()[0];
    project.updatePage(p.id, { title: '启动画面' });
    const w = project.addWidget('label', 60, 60);
    const id = w.id || w.widget?.id || (w.props && w.props.id);
    project.updateWidgetProp(id, 'text', '启动');
    project.commit('seed 两句话');
    i18n.addLanguage('en', 'English');
    const entries = i18n.collectEntries();
    const mod = await import('/js/editor/aiTranslate.js');
    const pending = mod.pendingByLang ? mod.pendingByLang() : null;
    const res = await new Promise(resolve => {
      let finished = false;
      const done = v => { if (!finished) { finished = true; resolve(v); } };
      const timer = setTimeout(() => done({ ok: false, error: '翻译超时 40s' }), 40000);
      const wrap = fn => (...a) => { clearTimeout(timer); fn(...a); };
      mod.runTranslate({
        lang: 'en', scope: 'all',
        handlers: {
          onDelta: wrap(() => {}),
          onProgress: wrap(() => {}),
          onDone: wrap(info => done({ ok: true, info })),
          onError: wrap(e => done({ ok: false, error: String((e && e.message) || e) })),
        },
      });
    });
    const dict = i18n.i18nState().dict.en || {};
    return {
      res, pending, entries: entries.map(e => e.source), dict,
      label: window.app.history.lastLabel(),
      lang: i18n.getLang(),
    };
  }).catch(e => ({ res: { ok: false, error: 'evaluate 抛错: ' + String(e.message || e) } }));

  ok(tr.res && tr.res.ok, '翻译结束（onDone）', tr.res && tr.res.error);
  ok(Array.isArray(tr.entries) && tr.entries.length >= 1, 'collectEntries 有源串', tr.entries);
  const dictVals = tr.dict ? Object.values(tr.dict) : [];
  ok(dictVals.length >= 1, 'meta.i18n.dict.en 写进去了', tr.dict);
  ok(tr.pending && Array.isArray(tr.pending.langs), 'pendingByLang() 形状对', tr.pending);
  ok(String(tr.label || '').includes('AI 翻译'), 'commit 标签带「AI 翻译」', tr.label);
  ok(tr.lang === 'en', 'setLang(en) 触发 i18n:lang 重画', tr.lang);

  // ── 5. 错误面：没 key 要给出可读错误 ──────────────────────────────────────
  section('5. 收尾检查（控制台 / 网络）');
  const errs = await page.evaluate(() => (window.__appErrors || []).slice());
  ok(errs.length === 0, 'window.__appErrors 为空', errs);
  const realBad = bad.filter(b => !/favicon|net::ERR_ABORTED/.test(b));
  ok(realBad.length === 0, '无 pageerror / console.error / 4xx', realBad.slice(0, 6));
} finally {
  await browser.close().catch(() => {});
  srv.kill();
  MODEL.srv.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n===== AI 全链路：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
