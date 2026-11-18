// verify-script-vars.mjs — 脚本里"变量怎么写更省事"那一套（hmi.v / hmi.g）
//
// 两件事：
//   ① `hmi.v.变量名` —— 变量表的**属性写法**（读、写都像普通属性），内部就是调 hmi.get/set/has，
//      所以类型收敛、下发、链路门这些行为和函数写法**完全一样**；只多一条"打错字当场报错"。
//   ② `hmi.g.xxx` —— 脚本自己的全局暂存：跨执行、跨脚本记得住，不占变量表；退出/进运行态清空。
//
// 顺带把「改名会不会漏」也验了：变量改名/替换必须连 `hmi.v.名字`、`hmi.v['名字']` 一起改，
// 而且新名字不是合法标识符（数字开头/带横线）时要自动退成方括号（`hmi.v.1号泵` 是语法错）。
//
// 用法：node test/verify-script-vars.mjs   （自己拉起独立数据目录的后端，不碰 8866/8901 那两套）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PY = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = 'C:/Users/Administrator/Desktop/hmi/hmi-designer-v2';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const PORT = await freePort();
installNodeFetchPatch(PORT);
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-scrvars-'));
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-scrvars-logs-'));
// ⚠ 日志目录也指到临时目录：脚本日志现在会落盘（logs/script-*.log），别往仓库的 logs/ 里写测试噪音
const srv = spawn(PY, ['server/server.py', '--port', String(PORT), '--no-browser', '--no-auth'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, HMI_DATA_DIR: DATA, HMI_LOG_DIR: LOGS } });
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(250);
  try { if ((await fetch(H + '/')).ok) up = true; } catch { /* 等 */ }
}
if (!up) { console.log('FAIL  后端没起来'); srv.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('dialog', d => d.accept());
await page.goto(H + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);

/* ── 造变量：普通英文名 / 中文名 / 数字开头名（写不了点写法）/ bool / 数组 ── */
const prep = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  project.newProject('blank');
  project.data.variables.length = 0;
  [['rSpeed', 'real', 10], ['bRun', 'bool', false], ['nCount', 'int', 0],
    ['转速', 'int', 0], ['1号泵', 'bool', false], ['sMsg', 'string', ''],
  ].forEach(([name, type, value]) => project.data.variables.push({ name, type, address: '', value, len: 0 }));
  project.data.variables.push({ name: 'arrw', type: 'int[]', address: '', value: [1, 2, 3, 4], len: 4 });
  varStore.resetFrom(project.variables());      // 编辑态要手工把初值灌进运行值表（进运行态时 runtime 会做）
  project.commit('脚本变量写法测试');
  return project.variables().map(v => v.name);
});
ok('准备变量：英文名 / 中文名 / 数字开头 / bool / 数组', prep.includes('转速') && prep.includes('1号泵') && prep.includes('arrw'),
  JSON.stringify(prep));

/** 跑一段代码（走真实的 runScriptOnce 那条路），返回 {ok, logs, value} */
const runCode = (code) => page.evaluate(async (c) => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const s = project.addScript({ name: 'test', trig: 'cycle', code: c });
  project.commit('t');
  const res = e.runScriptOnce(s.id);
  const logs = e.scriptLog(s.id).map(l => `${l.level}:${l.text}`);
  project.deleteScript(s.id);
  project.commit('清');
  return { ok: res.ok, logs, error: res.error };
}, code);

/* ═══════════ 1. hmi.v 读写 ═══════════ */
const readWrite = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const v = await import('/js/runtime/varstore.js');
  const s = project.addScript({
    name: 'v读写', trig: 'cycle',
    code: [
      'hmi.v.rSpeed = 12.5',                 // 写
      'hmi.v.nCount = hmi.v.nCount + 7',     // 读 + 写
      'hmi.v.bRun = 1',                      // bool 用 1 写 → 应该收敛成 true
      'hmi.v.sMsg = 123',                    // string 写数字 → 应该变字符串
      'hmi.v.转速 = 88',                      // 中文名直接点出来
      "hmi.v['1号泵'] = true",                // 数字开头 → 方括号
      "hmi.v['arrw[3]'] = 999",              // 数组元素
      'hmi.log("ok", hmi.v.rSpeed, hmi.v.bRun, hmi.v.转速)',
    ].join('\n'),
  });
  project.commit('v读写');
  const res = e.runScriptOnce(s.id);
  const out = {
    ok: res.ok, error: res.error,
    rSpeed: v.varStore.get('rSpeed'), nCount: v.varStore.get('nCount'),
    bRun: v.varStore.get('bRun'), sMsg: v.varStore.get('sMsg'),
    cn: v.varStore.get('转速'), pump: v.varStore.get('1号泵'), arr: v.varStore.get('arrw'),
    logs: e.scriptLog(s.id).map(l => `${l.level}:${l.text}`),
  };
  project.deleteScript(s.id);
  project.commit('清');
  return out;
});
ok('hmi.v.名字 = 值 → 真的写进变量（跟 hmi.set 一样）', readWrite.ok && readWrite.rSpeed === 12.5 && readWrite.nCount === 7,
  JSON.stringify({ ok: readWrite.ok, error: readWrite.error, rSpeed: readWrite.rSpeed, nCount: readWrite.nCount }));
ok('hmi.v.名字 读得回来（读 + 写混在一句里也算得对）', readWrite.nCount === 7, String(readWrite.nCount));
ok('bool 变量写 1 → 收敛成 true（类型收敛没丢）', readWrite.bRun === true, JSON.stringify(readWrite.bRun));
ok("string 变量写数字 → 变字符串（跟 hmi.set 一个口径）", readWrite.sMsg === '123', JSON.stringify(readWrite.sMsg));
ok('★ 中文变量名能直接点出来（hmi.v.转速 = 88）', readWrite.cn === 88, String(readWrite.cn));
ok("★ 数字开头的名字用方括号（hmi.v['1号泵'] = true）", readWrite.pump === true, JSON.stringify(readWrite.pump));
ok("★ 数组元素也照旧（hmi.v['arrw[3]'] = 999）",
  Array.isArray(readWrite.arr) && readWrite.arr[3] === 999 && readWrite.arr[0] === 1, JSON.stringify(readWrite.arr));
ok('hmi.v 读出来的值能直接进日志', readWrite.logs.some(l => /log:ok 12\.5 true 88/.test(l)),
  JSON.stringify(readWrite.logs.slice(-2)));

/* 数组元素**读**也要能读（hmi.get('arrw[3]') 以前给 undefined） */
const arrRead = await runCode("hmi.log('elem', hmi.v['arrw[3]'])");
ok("hmi.v['arrw[3]'] 读得出那一个元素", arrRead.ok && arrRead.logs.some(l => /elem 999/.test(l)),
  JSON.stringify(arrRead.logs.slice(-2)));

/* ═══════════ 2. 打错字：读/写都要当场报错（不能静默） ═══════════ */
const typoWrite = await runCode('hmi.v.rSeed = 100');       // 少打一个 d
ok('★ 写一个变量表里没有的名字 → 当场报错（不会静默写进本地值）',
  typoWrite.ok === false && /变量表里没有/.test(typoWrite.logs.join('|')),
  JSON.stringify(typoWrite.logs.slice(-1)));
const typoRead = await runCode('if (hmi.v.rSeed > 1) hmi.log(1)');
ok('★ 读一个变量表里没有的名字 → 也当场报错（打错字不会变成"脚本永不生效"）',
  typoRead.ok === false && /变量表里没有/.test(typoRead.logs.join('|')),
  JSON.stringify(typoRead.logs.slice(-1)));
const typoNotWritten = await page.evaluate(async () => {
  const v = await import('/js/runtime/varstore.js');
  return v.varStore.get('rSeed');
});
ok('报错之后那个名字**没有**被塞进变量值表（不留垃圾键）', typoNotWritten === undefined, JSON.stringify(typoNotWritten));
const hasCheck = await runCode("hmi.log('has', hmi.has('rSpeed'), hmi.has('rSeed'))");
ok('想先判断在不在 → hmi.has 照旧（报错信息里也这么提示）',
  hasCheck.ok && hasCheck.logs.some(l => /has true false/.test(l)), JSON.stringify(hasCheck.logs.slice(-2)));

/* 用不到的边角：Object.keys / in / String() / JSON 都不该炸 */
const meta = await runCode([
  "hmi.log('keys', Object.keys(hmi.v).includes('rSpeed'))",
  "hmi.log('in', 'bRun' in hmi.v)",
  "hmi.log('str', String(hmi.v))",
  "hmi.log('json', JSON.stringify(hmi.v).includes('rSpeed'))",
].join('\n'));
ok('Object.keys(hmi.v) / in / String(hmi.v) / JSON.stringify 都不炸（代理的边角行为正常）',
  meta.ok && meta.logs.some(l => /keys true/.test(l)) && meta.logs.some(l => /in true/.test(l))
  && meta.logs.some(l => /str \[hmi\.v/.test(l)) && meta.logs.some(l => /json true/.test(l)),
  JSON.stringify(meta.logs.slice(-4)));

/* 变量真叫 toString 这种名字时，也得以变量为准（兜底不能把变量吃掉） */
const weird = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const { varStore } = await import('/js/runtime/varstore.js');
  const e = await import('/js/runtime/scriptEngine.js');
  project.data.variables.push({ name: 'toString', type: 'int', address: '', value: 7, len: 0 });
  varStore.resetFrom(project.variables());
  const s = project.addScript({ name: 'w', trig: 'cycle', code: "hmi.log('weird', hmi.v.toString)" });
  project.commit('w');
  const r = e.runScriptOnce(s.id);
  const logs = e.scriptLog(s.id).map(l => l.text);
  project.deleteScript(s.id); project.commit('清');
  return { ok: r.ok, logs };
});
ok('变量真叫 toString 时也读得到（兜底顺序没把变量吃掉）',
  weird.ok && weird.logs.some(l => /weird 7/.test(l)), JSON.stringify(weird.logs.slice(-2)));

/* ═══════════ 3. hmi.g：跨执行、跨脚本、退出运行态清空 ═══════════ */
const gState = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const mk = (name, code) => {
    const s = project.addScript({ name, trig: 'cycle', code });
    project.commit('g');
    return s.id;
  };
  const a = mk('累加', "hmi.g.count = (hmi.g.count || 0) + 1;\nhmi.log('count', hmi.g.count);");
  const b = mk('读别人的', "hmi.log('看到', String(hmi.g.count));");
  const logs = [];
  /** 最后一条**脚本自己打的**日志（"执行（试运行）"那行是引擎加的，不算） */
  const lastLog = (id) => e.scriptLog(id).map(l => l.text).filter(t => !/^执行（/.test(t)).slice(-1)[0];
  const grab = (id) => logs.push(...e.scriptLog(id).map(l => l.text).filter(t => /^count /.test(t)));
  e.runScriptOnce(a); grab(a);
  e.runScriptOnce(a); grab(a);
  e.runScriptOnce(a); grab(a);
  const crossRun = logs.slice(-3);                                  // 三次执行：1 → 2 → 3
  e.runScriptOnce(b);
  const crossScript = lastLog(b);
  // 退出运行态（stopScripts）→ 暂存清空
  e.stopScripts();
  e.runScriptOnce(b);
  const afterStop = lastLog(b);
  project.deleteScript(a); project.deleteScript(b); project.commit('清');
  return { crossRun, crossScript, afterStop };
});
ok('★ hmi.g 跨执行记得住（连续跑三次：1 → 2 → 3）',
  JSON.stringify(gState.crossRun) === JSON.stringify(['count 1', 'count 2', 'count 3']),
  JSON.stringify(gState.crossRun));
ok('★ hmi.g 跨脚本共享（另一个脚本看得到同一个 count）', gState.crossScript === '看到 3', gState.crossScript);
ok('退出运行态 → hmi.g 清空（不落盘，别指望下次还在）', gState.afterStop === '看到 undefined', gState.afterStop);

/* 进运行态也会拿到一个全新的 hmi.g（跟"这次运行"对齐） */
const gFresh = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  // trig 用 interval + 很大的间隔：startScripts 只负责"重置暂存"，别让它自己跑起来干扰计数
  const s = project.addScript({ name: 'g', trig: 'interval', ms: 600000, variable: '', code: "hmi.g.n = (hmi.g.n || 0) + 1;\nhmi.log('n', hmi.g.n);" });
  project.commit('g');
  const last = () => {
    e.runScriptOnce(s.id);
    return e.scriptLog(s.id).map(l => l.text).filter(t => /^n /.test(t)).slice(-1)[0];
  };
  last(); last();
  const before = last();                        // 3
  e.startScripts();                             // 进运行态 = 全新暂存
  const after = last();                         // 应该重新从 1 开始
  e.stopScripts();
  project.deleteScript(s.id); project.commit('清');
  return { before, after };
});
ok('进运行态 → hmi.g 从零开始（3 → 重新 1）', gFresh.before === 'n 3' && gFresh.after === 'n 1',
  JSON.stringify(gFresh));

/* ═══════════ 4. 改名 / 替换：属性写法也要跟着改 ═══════════ */
const rename = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  project.data.scripts.length = 0;                 // 只留这一条，改了几处才是确定的数
  const s = project.addScript({
    name: '两种写法', trig: 'interval', ms: 1000, variable: '',
    code: "hmi.v.rSpeed = hmi.v.rSpeed + 1;\nhmi.set('rSpeed', 0);\nhmi.log(hmi.v['rSpeed']);",
  });
  project.commit('摆脚本');
  const r1 = project.remapScriptRefs('rSpeed', 'vSpd');       // ⚠ 新名字别包含旧名字，否则"还出现旧名"的提醒会误报
  const code1 = project.getScript(s.id).code;
  // 新名字不是合法标识符 → 点写法必须自动退成方括号（hmi.v.1号泵 是语法错）
  const r2 = project.remapScriptRefs('vSpd', '1号泵');
  const code2 = project.getScript(s.id).code;
  project.deleteScript(s.id); project.commit('清');
  return { r1, code1, r2, code2 };
});
ok('★ 改名：点写法照旧点、方括号照旧方括号，函数写法也一起改',
  rename.code1 === "hmi.v.vSpd = hmi.v.vSpd + 1;\nhmi.set('vSpd', 0);\nhmi.log(hmi.v['vSpd']);",
  JSON.stringify(rename.code1));
ok('改了几处也算得对（4 处：点写法 2 + 函数写法 1 + 方括号 1；没有"没改到"的提醒）',
  rename.r1.code === 4 && rename.r1.suspicious === 0 && rename.r1.trig === 0, JSON.stringify(rename.r1));
ok('★ 新名字不是合法标识符（1号泵）→ 点写法自动退成方括号，不会留下语法错',
  rename.code2 === "hmi.v['1号泵'] = hmi.v['1号泵'] + 1;\nhmi.set('1号泵', 0);\nhmi.log(hmi.v['1号泵']);",
  JSON.stringify(rename.code2));

/* 改名后能跑（结构没被改坏）——顺带验一下中文名的运行链路 */
const afterRename = await page.evaluate(async () => {
  const { project } = await import('/js/core/project.js');
  const e = await import('/js/runtime/scriptEngine.js');
  const v = await import('/js/runtime/varstore.js');
  project.data.variables.push({ name: '本班产量', type: 'int', address: '', value: 0, len: 0 });
  v.varStore.resetFrom(project.variables());   // 编辑态手工补初值（面板里加变量时 project 会自己广播 vars:new-defs）
  const s = project.addScript({ name: '产量', trig: 'interval', ms: 1000, variable: '', code: "hmi.v.本班产量 = hmi.v.本班产量 + 5;\nhmi.log('产量', hmi.v.本班产量);" });
  project.commit('产量');
  e.runScriptOnce(s.id); e.runScriptOnce(s.id);
  const out = { val: v.varStore.get('本班产量'), logs: e.scriptLog(s.id).map(l => l.text).slice(-2) };
  project.deleteScript(s.id); project.commit('清');
  return out;
});
ok('★ 中文变量名从"写"到"跑"整条链路通（本班产量 = 10）',
  afterRename.val === 10, JSON.stringify(afterRename));

/* ═══════════ 5. 编辑器里能看见、点得到 ═══════════ */
const doc = await page.evaluate(async () => {
  const m = await import('/js/editor/scriptEditor.js');
  m.initScriptEditor();
  m.openScriptEditor();
  await new Promise(r => setTimeout(r, 200));
  const rows = [...document.querySelectorAll('#seDoc .se-doc-row')].map(r => r.dataset.insert);
  const chip = document.querySelector('#seVarsWrap .se-chip')?.textContent.trim();
  document.getElementById('seHelp').click();
  await new Promise(r => setTimeout(r, 250));
  const help = [...document.querySelectorAll('#dlgBody .api-help-row')]
    .map(r => r.querySelector('code')?.textContent || '');
  const gEg = [...document.querySelectorAll('#dlgBody .api-help-row')]
    .filter(r => /hmi\.g（/.test(r.querySelector('code')?.textContent || ''))   // ⚠ 别用 /hmi\.g/：hmi.get 也匹配
    .map(r => r.querySelector('.api-help-eg')?.textContent || '')[0] || '';
  document.getElementById('dlgX').click();
  return { rows, chip, help, gEg };
});
ok('API 速查里有 hmi.v / hmi.g 两条（点一下能插到光标处）',
  doc.rows.some(r => /hmi\.v/.test(r)) && doc.rows.some(r => /hmi\.g\./.test(r)), JSON.stringify(doc.rows.filter(r => /hmi\.(v|g)/.test(r))));
ok('右侧「变量怎么写」那条例子换成了属性写法（点一下插入 hmi.v.名字 = true）',
  /^hmi\.v\.\S+ = true$/.test(doc.chip || ''), JSON.stringify(doc.chip));
ok('「? 帮助」里有 hmi.v 与 hmi.g 的说明 + 能直接抄的例子',
  doc.help.some(h => /hmi\.v\.变量名/.test(h)) && doc.help.some(h => /hmi\.g（/.test(h)) && /hmi\.g\./.test(doc.gEg),
  JSON.stringify({ help: doc.help.filter(h => /hmi\.(v|g)/.test(h)), eg: doc.gEg.slice(0, 40) }));

/* 例子插进代码区后能过语法检查 / 能跑（例子自己不能是坏代码） */
const insertCheck = await page.evaluate(async () => {
  const ta = document.getElementById('seCode');
  const setCode = (text) => { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); ta.setSelectionRange(0, 0); };
  // ① 点「API 速查」里那条 → 插到光标处
  setCode('');
  document.querySelector('#seDoc [data-insert="hmi.v.名字"]').click();
  const afterDocClick = ta.value;
  // ② 点「? 帮助」里 hmi.g 那条的「插入」→ 例子进代码区，试运行要跑得通
  setCode('');
  document.getElementById('seHelp').click();
  await new Promise(r => setTimeout(r, 250));
  const gRow = [...document.querySelectorAll('#dlgBody .api-help-row')]
    .filter(r => /hmi\.g（/.test(r.querySelector('code')?.textContent || ''))[0];   // 精确挑 hmi.g 那条（别挑到 hmi.get）
  const eg = gRow.querySelector('.api-help-eg').textContent;
  gRow.querySelector('.api-help-ins').click();
  await new Promise(r => setTimeout(r, 250));
  const inserted = ta.value;
  document.getElementById('seRun').click();
  await new Promise(r => setTimeout(r, 400));
  return {
    afterDocClick, eg, inserted, same: inserted.trim() === eg.trim(),
    status: document.getElementById('seStatus').textContent,
    log: document.getElementById('seLog').textContent,
  };
});
ok('点「API 速查」里的 hmi.v.名字 → 插到光标处', /hmi\.v\.名字/.test(insertCheck.afterDocClick),
  JSON.stringify(insertCheck.afterDocClick));
ok('★ 点帮助里 hmi.g 那条的「插入」→ 那段例子原样进代码区',
  insertCheck.same, JSON.stringify({ inserted: insertCheck.inserted.slice(0, 50), eg: insertCheck.eg.slice(0, 50) }));
ok('★ 那段例子在本工程的变量名下**真的能跑**（不是抄了就报错的示例）',
  /试运行完成/.test(insertCheck.status), `${insertCheck.status} | ${insertCheck.log.replace(/\s+/g, ' ').slice(0, 90)}`);

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(`\n==== 脚本变量写法（hmi.v / hmi.g）：${results.filter(r => r.ok).length}/${results.length} 通过 ====`);
await browser.close();
srv.kill();
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(LOGS, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.some(r => !r.ok) ? 1 : 0);
