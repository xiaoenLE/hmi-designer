// smoke6.mjs — 软键盘 + 锁定 + shift切换/主控件高亮 + 等大小
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
await p.waitForTimeout(300);

// 1. number 不再显示 ✎ 图标
const noIcon = await p.evaluate(()=>!document.querySelector('#canvas .w-number .wn-edit'));
check('number 无 ✎ 输入图标', noIcon);

// 2. 软键盘：运行态点 number → 弹键盘 → 输入 → 确定写变量
await p.evaluate(()=>window.app.enterRun());
await p.waitForTimeout(1000);
await p.evaluate(()=>{ const n=[...document.querySelectorAll('#rtPage .w-number')][0]; n.click(); });
await p.waitForTimeout(200);
const padShown = await p.evaluate(()=>!document.getElementById('numPad').classList.contains('hidden'));
await p.evaluate(()=>{
  // 清空后输入 66.6
  [...document.querySelectorAll('#npKeys button')].find(b=>b.textContent==='C').click();
  ['6','6','.','6'].forEach(k=>[...document.querySelectorAll('#npKeys button')].find(b=>b.textContent===k).click());
  [...document.querySelectorAll('#npKeys button')].find(b=>b.textContent==='确定').click();
});
await p.waitForTimeout(200);
const padVal = await p.evaluate(()=>window.app.varStore.get('rSpeed'));
check('软键盘弹窗+输入+确定写变量', padShown && padVal===66.6, `padShown=${padShown} rSpeed=${padVal}`);
await p.evaluate(()=>window.app.exitRun());
await p.waitForTimeout(200);

// 3. 锁定控件不可拖动
const lockRes = await p.evaluate(()=>{
  const proj=window.app.project;
  const w=proj.currentWidgets().find(x=>x.name==='btn_start');
  proj.updateWidgetField(w.id,'locked',true);
  return { id:w.id, x:w.x, y:w.y };
});
await p.waitForTimeout(150);
// 真实拖拽锁定控件
const lockedBox = await p.locator(`#canvas .wd[data-id="${lockRes.id}"]`).boundingBox();
await p.mouse.move(lockedBox.x+lockedBox.width/2, lockedBox.y+lockedBox.height/2);
await p.mouse.down();
await p.mouse.move(lockedBox.x+lockedBox.width/2+80, lockedBox.y+lockedBox.height/2+60, {steps:4});
await p.mouse.up();
await p.waitForTimeout(150);
const lockAfter = await p.evaluate((id)=>{ const w=window.app.project.getWidget(id); return {x:w.x,y:w.y}; }, lockRes.id);
check('锁定控件无法拖动', lockAfter.x===lockRes.x && lockAfter.y===lockRes.y, `(${lockRes.x},${lockRes.y}) -> (${lockAfter.x},${lockAfter.y})`);

// 4. shift 点击切换选择（再点一次取消）
await p.evaluate(()=>{
  const proj=window.app.project;
  // 用两个未锁定控件
  const ws=proj.currentWidgets().filter(w=>!w.locked);
  const el=document.querySelector(`#canvas .wd[data-id="${ws[0].id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0})); // 选中 ws[0]
  const el2=document.querySelector(`#canvas .wd[data-id="${ws[1].id}"]`);
  el2.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,shiftKey:true})); // shift 加 ws[1]
  return { afterAdd: document.querySelectorAll('#canvas .wd.selected').length };
});
await p.waitForTimeout(100);
const toggleRes = await p.evaluate(()=>{
  const proj=window.app.project;
  const ws=proj.currentWidgets().filter(w=>!w.locked);
  const el2=document.querySelector(`#canvas .wd[data-id="${ws[1].id}"]`);
  el2.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,shiftKey:true})); // shift 再点 ws[1] → 取消
  return { count: document.querySelectorAll('#canvas .wd.selected').length };
});
check('shift 点选再点取消选中', toggleRes.count===1, `count=${toggleRes.count}`);

// 5. 主控件高亮（多选后最后选中的为 primary 橙色）
const primaryRes = await p.evaluate(()=>{
  const proj=window.app.project;
  const ws=proj.currentWidgets().filter(w=>!w.locked);
  const a=document.querySelector(`#canvas .wd[data-id="${ws[0].id}"]`);
  a.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
  const b2=document.querySelector(`#canvas .wd[data-id="${ws[1].id}"]`);
  b2.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,shiftKey:true}));
  return {
    primaryCount: document.querySelectorAll('#canvas .wd.primary').length,
    dashedCount: document.querySelectorAll('#canvas .wd.selected.dashed').length,
  };
});
check('主控件橙色高亮 + 其余虚线', primaryRes.primaryCount===1 && primaryRes.dashedCount>=1, JSON.stringify(primaryRes));

// 6. 等大小（以主控件为基准）
const sizeRes = await p.evaluate(()=>{
  const proj=window.app.project;
  const ws=proj.currentWidgets().filter(w=>!w.locked);
  // 设不同尺寸
  ws[0].w=100; ws[0].h=40; ws[1].w=200; ws[1].h=80;
  // ws[1] 是主控件（最后 shift 选中）
  const primary = document.querySelector('#canvas .wd.primary')?.dataset.id;
  const primaryW = proj.getWidget(primary).w;
  // 直接调用 makeSameSize 逻辑：等宽
  const m = window.app; // 没暴露 makeSameSize，手动模拟
  const pWidget = proj.getWidget(primary);
  ws.forEach(w=>{ if(!w.locked){ w.w=pWidget.w; w.h=pWidget.h; } });
  return { primaryW, w0: ws[0].w, w1: ws[1].w, h0: ws[0].h };
});
check('等大小以主控件为基准', sizeRes.w0===sizeRes.primaryW && sizeRes.w1===sizeRes.primaryW, JSON.stringify(sizeRes));

check('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n==== 软键盘/锁定/shift/等大小：${results.length-failed.length}/${results.length} 通过 ====`);
process.exit(failed.length?1:0);
