// smoke4.mjs — 面板宽度/折叠/持久化 + 类型列可见性
import { createRequire } from 'node:module';
// ESM 不认 NODE_PATH，用 createRequire 锚定到托管 node workspace 找 playwright-core
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE='C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results=[]; const check=(n,c,x='')=>{results.push({n,ok:!!c});console.log(`${c?'✅':'❌'} ${n}${x?'  — '+x:''}`);};
const b=await chromium.launch({executablePath:EXE,headless:true});
const p=await b.newPage({viewport:{width:1500,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://127.0.0.1:8866/',{waitUntil:'networkidle'});
await p.waitForFunction(()=>window.app?.project?.data);

// 1. 类型列可见（默认 250 宽下 select 宽度足够显示文字）
await p.click('.lp-tab[data-tab="vars"]');
await p.waitForTimeout(200);
const selW = await p.evaluate(()=>{
  const s=document.querySelector('#varTable select[data-k="type"]');
  return { w: s.getBoundingClientRect().width, visible: s.getBoundingClientRect().width > 40 };
});
check('类型下拉宽度可见(uint/lreal文字)', selW.visible, `w=${selW.w}`);

// 2. 拖拽左分隔条调宽
const before = await p.evaluate(()=>document.getElementById('leftPanel').getBoundingClientRect().width);
const rz = await p.locator('#leftResizer').boundingBox();
await p.mouse.move(rz.x+3, rz.y+300);
await p.mouse.down();
await p.mouse.move(rz.x+3+80, rz.y+300, {steps:3});
await p.mouse.up();
await p.waitForTimeout(150);
const after = await p.evaluate(()=>document.getElementById('leftPanel').getBoundingClientRect().width);
check('拖拽左分隔条调宽', after > before + 40, `${before} -> ${after}`);

// 3. 折叠/展开左栏
await p.click('#leftResizer .rz-toggle');
await p.waitForTimeout(100);
const collapsed = await p.evaluate(()=>getComputedStyle(document.getElementById('leftPanel')).display==='none');
await p.click('#leftResizer .rz-toggle');
await p.waitForTimeout(100);
const expanded = await p.evaluate(()=>getComputedStyle(document.getElementById('leftPanel')).display!=='none');
check('左栏折叠/展开', collapsed && expanded);

// 4. 右栏折叠
await p.click('#rightResizer .rz-toggle');
await p.waitForTimeout(100);
const rCollapsed = await p.evaluate(()=>getComputedStyle(document.getElementById('rightPanel')).display==='none');
await p.click('#rightResizer .rz-toggle');
check('右栏折叠/展开', rCollapsed);

// 5. 持久化：宽度+折叠后 reload 恢复
await p.evaluate(()=>{
  document.getElementById('leftPanel').style.width='420px';
  localStorage.setItem('hmi-panel-left','420');
  document.getElementById('rightPanel').style.width='380px';
  localStorage.setItem('hmi-panel-right','380');
});
await p.reload({waitUntil:'networkidle'});
await p.waitForFunction(()=>window.app?.project?.data);
const restored = await p.evaluate(()=>({
  l: document.getElementById('leftPanel').getBoundingClientRect().width,
  r: document.getElementById('rightPanel').getBoundingClientRect().width,
}));
check('面板宽度刷新后恢复', Math.abs(restored.l-420)<2 && Math.abs(restored.r-380)<2, JSON.stringify(restored));

// 折叠持久化
await p.click('#rightResizer .rz-toggle');
await p.waitForTimeout(100);
await p.reload({waitUntil:'networkidle'});
await p.waitForFunction(()=>window.app?.project?.data);
const rStillCollapsed = await p.evaluate(()=>document.getElementById('rightPanel').classList.contains('collapsed'));
check('折叠状态刷新后恢复', rStillCollapsed);
await p.click('#rightResizer .rz-toggle'); // 还原

check('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n==== 面板功能：${results.length-failed.length}/${results.length} 通过 ====`);
process.exit(failed.length?1:0);
