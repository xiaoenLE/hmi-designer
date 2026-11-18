// smoke8.mjs — 工具栏锁定 + 弹窗尺寸进属性 + 遮罩不关弹窗 + 键盘居中可拖
import { createRequire } from 'node:module';
import { installPageShim } from './_wsfetch.mjs';
// ESM 不认 NODE_PATH，用 createRequire 锚定到托管 node workspace 找 playwright-core
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE='C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results=[]; const check=(n,c,x='')=>{results.push({n,ok:!!c});console.log(`${c?'✅':'❌'} ${n}${x?'  — '+x:''}`);};
const b=await chromium.launch({executablePath:EXE,headless:true});
const p=await b.newPage({viewport:{width:1500,height:900}});
await installPageShim(p);
const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://127.0.0.1:8866/',{waitUntil:'networkidle'});
await p.waitForFunction(()=>window.app?.project?.data);
await p.waitForTimeout(300);

// 1. 工具栏锁定按钮：批量锁定
await p.evaluate(()=>{
  const proj=window.app.project;
  const ws=proj.currentWidgets().filter(w=>!w.locked).slice(0,2);
  // 选中两个
  ws[0].x=10; // 触发 touch
});
// 用 Ctrl+A 全选再点锁定
await p.keyboard.down('Control'); await p.keyboard.press('a'); await p.keyboard.up('Control');
await p.waitForTimeout(150);
const selCount = await p.evaluate(()=>document.querySelectorAll('#canvas .wd.selected').length);
await p.click('#btnLock');
await p.waitForTimeout(150);
const lockedCount = await p.evaluate(()=>window.app.project.currentWidgets().filter(w=>w.locked).length);
check('工具栏锁定按钮批量锁定', selCount>0 && lockedCount===selCount, `sel=${selCount} locked=${lockedCount}`);
// 再点一次全解锁
await p.click('#btnLock');
await p.waitForTimeout(150);
const unlocked = await p.evaluate(()=>window.app.project.currentWidgets().filter(w=>w.locked).length);
check('再点锁定按钮全解锁', unlocked===0, `locked=${unlocked}`);

// 2. 弹窗尺寸在属性面板
await p.evaluate(()=>window.app.project.setCurrentPage('pg_alarm'));
await p.waitForTimeout(200);
const dims = await p.evaluate(()=>{
  const w=document.getElementById('ppPW'), h=document.getElementById('ppPH');
  return { w: !!w, h: !!h, wVal: w?.value };
});
check('弹窗宽高字段在属性面板', dims.w && dims.h, JSON.stringify(dims));
// 修改尺寸
await p.evaluate(()=>{
  document.getElementById('ppPW').value='500';
  document.getElementById('ppPW').dispatchEvent(new Event('change',{bubbles:true}));
});
const dimChanged = await p.evaluate(()=>window.app.project.getPage('pg_alarm').popupW);
check('属性面板修改弹窗尺寸生效', dimChanged===500, `popupW=${dimChanged}`);

// 3. 弹窗点遮罩不关闭（只能按钮关）
await p.evaluate(()=>window.app.project.setCurrentPage('pg_main'));
await p.waitForTimeout(150);
await p.evaluate(()=>window.app.enterRun());
await p.waitForTimeout(1200);
await p.locator('#rtPage .wd-button', { hasText: '报警详情' }).click();
await p.waitForTimeout(400);
// 点遮罩（弹窗外区域）
await p.evaluate(()=>{
  const mask=document.querySelector('#rtPopupLayer .rt-popup-mask');
  // 遮罩点击不应关闭
  mask.dispatchEvent(new MouseEvent('click',{bubbles:true}));
});
await p.waitForTimeout(200);
const stillOpen = await p.evaluate(()=>!!document.querySelector('#rtPopupLayer .rt-popup'));
check('点遮罩不关闭弹窗（只能按钮关）', stillOpen===true);
// 点 ✕ 关闭
await p.evaluate(()=>document.querySelector('#rtPopupLayer .rt-popup-close').click());
await p.waitForTimeout(200);
const closed = await p.evaluate(()=>!document.querySelector('#rtPopupLayer .rt-popup'));
check('点 ✕ 正常关闭', closed===true);

// 4. 键盘居中 + 拖拽
await p.evaluate(()=>{ const n=document.querySelector('#rtPage .w-number'); n.click(); });
await p.waitForTimeout(300);
const padPos = await p.evaluate(()=>{
  const r=document.getElementById('numPad').getBoundingClientRect();
  return { cx: Math.abs((r.left+r.width/2) - window.innerWidth/2) < 80, cy: Math.abs((r.top+r.height/2) - window.innerHeight/2) < 80 };
});
check('软键盘默认居中', padPos.cx && padPos.cy, JSON.stringify(padPos));
// 拖拽标题栏
const head = await p.locator('#numPad .np-head').boundingBox();
await p.mouse.move(head.x+40, head.y+10);
await p.mouse.down();
await p.mouse.move(head.x+40+120, head.y+10+80, {steps:4});
await p.mouse.up();
await p.waitForTimeout(200);
const moved = await p.evaluate(()=>{
  const r=document.getElementById('numPad').getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), saved: !!localStorage.getItem('hmi-numpad-pos') };
});
check('软键盘可拖拽+位置保存', moved.saved===true, JSON.stringify(moved));

check('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n==== 工具栏锁定/弹窗尺寸/遮罩/键盘：${results.length-failed.length}/${results.length} 通过 ====`);
process.exit(failed.length?1:0);
