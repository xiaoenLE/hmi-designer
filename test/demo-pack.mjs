// demo-pack.mjs — 生成一个**能直接导入**的示例控件包（.hmiw.json），并在"干净环境"里导一遍验证
//
// 关键：这个包是**用设计器自己生成的**（调真实的 project.addWidget + widgetExportPayload），
// 不是手拼 JSON —— 所以它和"你自己在编辑器里导出"得到的包**一模一样**（属性齐全、变量齐全）。
// （手拼的包踩过坑：实例 props 空着 → 自定义控件的 render 拿不到 unit/max，显示成默认值。）
//
// 验证阶段特意**开一个全新的浏览器上下文**（localStorage 干净 = 只有种子演示工程）：
// 那时的工程里**没有** gauge 这个控件类型，正好证明"自定义控件的定义真的跟着包走"。
//
// 用法：
//   node test/demo-pack.mjs                                   # 写到桌面 + 干净环境里导一遍 + 截图
//   node test/demo-pack.mjs --out D:\x\demo.hmiw.json
//   node test/demo-pack.mjs --no-verify                       # 只生成文件
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNodeFetchPatch } from './_wsfetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argOf = (name, def = null) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def;
};
const OUT = path.resolve(String(argOf('out', path.join(os.homedir(), 'Desktop', '示例控件包-工位A.hmiw.json'))));
const VERIFY = !process.argv.includes('--no-verify');

/* ══════════ 1. 自定义控件的定义（包里带的就是这个：属性 schema + render 源码 + CSS） ══════════ */
const GAUGE_DEF = {
  type: 'gauge',
  title: '仪表盘',
  sub: '半圆表盘（别人做好的控件）',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><path d="M6 26a12 12 0 0 1 24 0" fill="none" stroke="#e5e7eb" stroke-width="4" stroke-linecap="round"/><path d="M6 26a12 12 0 0 1 15-11" fill="none" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/><text x="18" y="27" font-size="8" fill="#1f2329" text-anchor="middle">表</text></svg>',
  defaults: {
    w: 200, h: 120,
    min: 0, max: 3000, decimals: 0, unit: ' m/min', caption: '主轴转速',
    warnAt: 90, barColor: '#22c55e', warnColor: '#ef4444',
    bgColor: '#e5e7eb', textColor: '#1f2329',
  },
  props: [
    { key: 'min', label: '最小', type: 'number' },
    { key: 'max', label: '最大', type: 'number' },
    { key: 'decimals', label: '小数位', type: 'number', min: 0, max: 6, defVal: 0 },
    { key: 'unit', label: '单位', type: 'text', hint: '显示在数值后面，如 m/min、℃、%' },
    { key: 'caption', label: '表盘标题', type: 'text', hint: '数值下面那行小字' },
    { key: 'warnAt', label: '超限阈值%', type: 'number', min: 0, max: 100, defVal: 90,
      hint: '填 0 = 不启用；填 90 = 指针超过 90% 时整条弧变「超限色」' },
    { key: 'barColor', label: '弧色', type: 'color' },
    { key: 'warnColor', label: '超限色', type: 'color' },
    { key: 'bgColor', label: '底弧色', type: 'color' },
    { key: 'textColor', label: '文字色', type: 'color' },
  ],
  binding: { variable: { types: ['int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: '绑定变量' } },
  actions: [],
  // render 里直接写 escapeHtml / varValue 就行（控件包机制会把白名单 helper 注入进去，不用 import）
  renderSrc: `render(w, mode, vars) {
  const p = w.props;
  const v = varValue(w, vars);
  const num = (v === null || v === undefined || v === '') ? null : Number(v);
  const min = Number.isFinite(+p.min) ? +p.min : 0;
  const max = Number.isFinite(+p.max) ? +p.max : 100;
  const span = (max - min) || 1;
  const pct = num === null ? 0 : Math.max(0, Math.min(1, (num - min) / span));
  const dec = Math.max(0, Math.min(6, +p.decimals || 0));
  const txt = num === null ? (mode === 'edit' ? '未绑定' : '--') : num.toFixed(dec) + (p.unit || '');
  const warnAt = Math.max(0, Math.min(100, +p.warnAt || 0));
  const over = warnAt > 0 && pct * 100 >= warnAt;
  const color = over ? (p.warnColor || '#ef4444') : (p.barColor || '#22c55e');
  const R = 46, CX = 60, CY = 60;
  const ang = Math.PI * (1 - pct);
  const x = (CX + R * Math.cos(ang)).toFixed(2);
  const y = (CY - R * Math.sin(ang)).toFixed(2);
  return '<svg class="w-gauge" viewBox="0 0 120 78" preserveAspectRatio="xMidYMid meet">'
    + '<path d="M ' + (CX - R) + ' ' + CY + ' A ' + R + ' ' + R + ' 0 0 1 ' + (CX + R) + ' ' + CY + '" fill="none" stroke="' + (p.bgColor || '#e5e7eb') + '" stroke-width="9" stroke-linecap="round"/>'
    + '<path d="M ' + (CX - R) + ' ' + CY + ' A ' + R + ' ' + R + ' 0 0 1 ' + x + ' ' + y + '" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round"/>'
    + '<text x="' + CX + '" y="' + (CY - 4) + '" text-anchor="middle" style="font-size:17px;font-weight:600" fill="' + (p.textColor || '#1f2329') + '">' + escapeHtml(txt) + '</text>'
    + '<text x="' + CX + '" y="' + (CY + 12) + '" text-anchor="middle" style="font-size:9px" fill="#94a3b8">' + escapeHtml(p.caption || '') + '</text>'
    + '</svg>';
}`,
  css: '.w-gauge { display: block; width: 100%; height: 100%; }',
};

/* ══════════ 2. 要放进去的东西 ══════════ */
// 变量：**地址留空 = 内部变量**，不接 PLC 也能看见效果。
// ⚠ 名字特意避开种子演示工程里的 rSpeed / iCount —— 同名变量按规矩"保留你现有的"，
//   那样演示值就用不上包里这份了（实测踩过：仪表盘显示的是种子里的 12.5→13）。
const VARS = [
  { name: 'rSpindle', type: 'real', address: '', value: 1680 },
  { name: 'bMachineRun', type: 'bool', address: '', value: false },
  { name: 'nParts', type: 'dint', address: '', value: 8600 },
];
// 控件：几何 / 属性（只列要覆盖默认值的）/ 绑定 / 动作
const SPEC = [
  ['rect', '底板', 60, 40, 600, 250, { bgColor: '#ffffff', borderColor: '#c3cbd6', borderWidth: 1, radius: 10 }, '', []],
  ['label', '标题', 84, 56, 560, 30, { text: '工位A · 示例控件包', fontSize: 18, bold: true, color: '#1f2329', align: 'left' }, '', []],
  ['gauge', '主轴转速', 84, 100, 210, 140, {}, 'rSpindle', []],
  ['lamp', '运行指示灯', 330, 112, 50, 50, { onColor: '#22c55e' }, 'bMachineRun', []],
  ['label', '运行状态文字', 388, 130, 130, 24, { text: '运行状态（看这个灯）', fontSize: 13, color: '#6b7280', align: 'left' }, '', []],
  ['number', '加工计数', 330, 196, 150, 34, { unit: ' 件', decimals: 0 }, 'nParts', []],
  ['button', '启停按钮', 500, 190, 130, 46, { text: '启动 / 停止', fontSize: 15, bgColor: '#2563eb' }, 'bMachineRun',
    [{ trigger: 'click', type: 'toggle', params: { variable: 'bMachineRun' } }]],
];

/* ══════════ 3. 起设计器，用它生成包（= 和你自己导出得到的包一模一样） ══════════ */
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-demo-'));
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA } });
for (let i = 0; i < 40; i++) { await sleep(300); try { await fetch(H + '/'); break; } catch { /* 等 */ } }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const errs = [];
const hook = (pg) => { pg.on('pageerror', e => errs.push(String(e))); pg.on('dialog', d => d.accept()); };

/* — 3a. 干净上下文：注册自定义控件 → 画 7 个控件 → 导出 — */
const ctxBuild = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page1 = await ctxBuild.newPage(); hook(page1);
await page1.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page1.goto(H + '/', { waitUntil: 'load' });
await page1.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(300);

const built = await page1.evaluate(async ({ def, vars, spec }) => {
  const { project } = await import('/js/core/project.js');
  const pack = await import('/js/widgets/pack.js');
  pack.registerCustomDefChecked(def);                       // 先让设计器"认识"这个新控件
  vars.forEach(v => project.data.variables.push({ ...v, len: 0 }));
  const ids = [];
  for (const [type, name, x, y, w, h, props, variable, actions] of spec) {
    const it = project.addWidget(type, x, y);
    it.name = name;
    Object.assign(it, { x, y, w, h });
    Object.assign(it.props, props);
    if (variable) it.bindings.variable = variable;
    if (actions.length) it.actions = JSON.parse(JSON.stringify(actions));
    ids.push(it.id);
  }
  const payload = project.widgetExportPayload(ids);          // ← 就是"导出选中控件"走的那条路
  return { payload, ids };
}, { def: GAUGE_DEF, vars: VARS, spec: SPEC });

const pack = built.payload;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(pack, null, 2), 'utf8');
console.log(`已生成：${OUT}`);
console.log(`  ${pack.widgets.length} 个控件（${[...new Set(pack.widgets.map(w => w.type))].join('、')}）`);
console.log(`  ${pack.variables.length} 个变量（内部变量，不用接 PLC）：${pack.variables.map(v => `${v.name}=${v.value}`).join('、')}`);
console.log(`  ${pack.defs.length} 个自定义控件定义（带代码）：${pack.defs.map(d => d.type).join('、')} · render ${pack.defs[0].renderSrc.length} 字符 · CSS ${pack.defs[0].css.length} 字符`);

if (!VERIFY) { await browser.close(); srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* */ } process.exit(0); }

/* — 3b. **另一个全新的上下文**（localStorage 干净 = 只有种子演示工程，里面没有 gauge）导一遍 — */
const ctxImport = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page2 = await ctxImport.newPage(); hook(page2);
await page2.route(u => u.pathname.startsWith('/api/'), r => r.abort());
await page2.goto(H + '/', { waitUntil: 'load' });
await page2.waitForFunction(() => window.app?.project?.data, null, { timeout: 20000 });
await sleep(300);

const r = await page2.evaluate(async (text) => {
  const { project } = await import('/js/core/project.js');
  const { registry } = await import('/js/widgets/registry.js');
  const before = {
    gaugeKnown: !!registry.get('gauge'),                     // 干净环境里应该是 false
    w: project.currentPage().widgets.length,
    varNames: project.data.variables.map(v => v.name),
  };
  const res = project.importWidgetPack(JSON.parse(text), { allowCode: true });
  await new Promise(x => setTimeout(x, 500));
  const cur = project.currentPage();
  const want = ['rSpindle', 'bMachineRun', 'nParts'];
  return {
    before, ok: res.ok, added: res.widgetsAdded, defsAdded: res.defsAdded, warnings: res.warnings,
    deltaW: cur.widgets.length - before.w,
    varsPresent: want.filter(n => project.data.variables.some(v => v.name === n)).length,
    varValues: want.map(n => `${n}=${project.data.variables.find(v => v.name === n)?.value}`),
    gaugeOnCanvas: document.querySelectorAll('#canvas .w-gauge').length,
    gaugeText: [...document.querySelectorAll('#canvas .w-gauge text')].map(t => t.textContent.trim()),
    barOnCanvas: document.querySelectorAll('#canvas .wd-bar, #canvas .w-bar').length,
    lampOnCanvas: document.querySelectorAll('#canvas .wd-lamp').length,
    cssInjected: !!document.getElementById('wd-css-gauge'),
    inToolbox: [...document.querySelectorAll('#toolboxList .tb-item')].some(i => /仪表盘/.test(i.textContent)),
  };
}, fs.readFileSync(OUT, 'utf8'));

const bad = [];
const ok = (name, cond, extra = '') => { if (!cond) bad.push(name); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`); };
console.log('\n在"干净环境"里导入验证：');
ok('导之前这份工程里确实没有 gauge 这个控件类型', r.before.gaugeKnown === false);
ok('文件能被导入，7 个控件全进来了', r.ok && r.added === 7 && r.deltaW === 7, `加了 ${r.added} 个`);
ok('自定义控件定义跟着包进来（注册 + CSS 注入 + 进控件栏）',
  r.defsAdded?.includes('gauge') && r.cssInjected && r.inToolbox);
ok('三个变量都进了变量表（内部变量，值也在）', r.varsPresent === 3, r.varValues.join(' '));
ok('画布上真的画出了仪表盘，且数值带单位（不是"未绑定"）',
  r.gaugeOnCanvas === 1 && /1680/.test(r.gaugeText.join(' ')) && /m\/min/.test(r.gaugeText.join(' ')),
  r.gaugeText.join(' | '));
ok('内置控件也都在（指示灯画出来了）', r.lampOnCanvas >= 1, `lamp=${r.lampOnCanvas}（种子工程自己也有几个）`);

await page2.screenshot({ path: path.join(ROOT, 'docs', 'screenshot-demo-pack-imported.png') });
console.log('→ docs/screenshot-demo-pack-imported.png');
ok('浏览器无页面错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close(); srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(bad.length ? `\n❌ ${bad.length} 项没过：${bad.join('、')}` : '\n✅ 全过 —— 这个文件可以直接导');
process.exit(bad.length ? 1 : 0);
