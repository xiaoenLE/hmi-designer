// smoke7.mjs — 弹窗顶层/模态 + 弹窗标题栏 + 图片内嵌
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

// ══ 1. 弹窗在顶层（盖住后面控件）══
await p.evaluate(()=>window.app.enterRun());
await p.waitForTimeout(1200);
await p.locator('#rtPage .wd-button', { hasText: '报警详情' }).click();
await p.waitForTimeout(500);
const top = await p.evaluate(()=>{
  const sw = [...document.querySelectorAll('#rtPage .wd')].find(e=>e.textContent.includes('速度设定'));
  const r = sw.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
  return { hitClass: hit?.className?.toString().slice(0,30), inPopup: !!hit?.closest('.rt-popup') };
});
check('弹窗盖住后面控件（elementFromPoint 命中弹窗）', top.inPopup===true, JSON.stringify(top));

// ══ 2. 模态：点弹窗外的页面控件位置 → 遮罩拦截，控件不响应 ══
const modal = await p.evaluate(()=>{
  // 主画面"启停切换"按钮在 (700,100)，弹窗打开时点它应该被遮罩拦截
  const btn = [...document.querySelectorAll('#rtPage .wd-button')].find(e=>e.textContent.includes('启停切换'));
  const r = btn.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
  const before = window.app.varStore.get('bRunCmd');
  hit.click();   // 点到的是遮罩，toggle 不应执行
  return { hitMask: hit.classList.contains('rt-popup-mask'), before, after: window.app.varStore.get('bRunCmd') };
});
check('模态拦截：后方按钮点击不生效', modal.hitMask===true && modal.before===modal.after, JSON.stringify(modal));

// 遮罩点击不再关闭弹窗，弹窗仍开着，直接测标题栏
// ══ 3. 弹窗标题栏 + 关闭按钮 ══
const head = await p.evaluate(()=>{
  const h = document.querySelector('#rtPopupLayer .rt-popup-head');
  return { text: h?.querySelector('span')?.textContent, hasClose: !!h?.querySelector('.rt-popup-close') };
});
check('弹窗标题栏+关闭按钮渲染', head.text==='报警详情' && head.hasClose===true, JSON.stringify(head));
// 点 ✕ 关闭
await p.evaluate(()=>document.querySelector('#rtPopupLayer .rt-popup-close').click());
await p.waitForTimeout(200);
const closedByX = await p.evaluate(()=>!document.querySelector('#rtPopupLayer .rt-popup'));
check('点标题栏 ✕ 关闭弹窗', closedByX===true);

// 页面属性里改标题
await p.evaluate(()=>window.app.exitRun());
await p.waitForTimeout(200);
await p.evaluate(()=>{
  const proj=window.app.project;
  proj.setCurrentPage('pg_alarm');
});
await p.waitForTimeout(200);
const popupProps = await p.evaluate(()=>{
  document.getElementById('ppTitle').value='自定义标题';
  document.getElementById('ppTitle').dispatchEvent(new Event('change',{bubbles:true}));
  return window.app.project.getPage('pg_alarm').title;
});
check('页面属性修改弹窗标题', popupProps==='自定义标题', popupProps);
await p.evaluate(()=>window.app.enterRun());
await p.waitForTimeout(1000);
await p.locator('#rtPage .wd-button', { hasText: '报警详情' }).click();
await p.waitForTimeout(400);
const headText = await p.evaluate(()=>document.querySelector('#rtPopupLayer .rt-popup-head span')?.textContent);
check('运行态标题栏显示自定义标题', headText==='自定义标题', headText);
await p.evaluate(()=>window.app.exitRun());
await p.waitForTimeout(200);

// ══ 4. 图片选图 → base64 内嵌 ══
await p.evaluate(()=>{
  const proj=window.app.project;
  proj.setCurrentPage('pg_main');          // 先回主画面再添加
  proj.addWidget('image', 10, 380);
});
await p.waitForTimeout(200);
// 选中 image 控件显示属性
await p.evaluate(()=>{
  const proj=window.app.project;
  const img = proj.currentWidgets().find(w=>w.type==='image');
  const el=document.querySelector(`#canvas .wd[data-id="${img.id}"]`);
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
});
await p.waitForTimeout(200);
// 用 1x1 红色 PNG 的 dataURL 模拟"选图"后的写入
const imgSet = await p.evaluate(()=>{
  const proj=window.app.project;
  const img = proj.currentWidgets().find(w=>w.type==='image');
  const tiny='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  proj.updateWidgetProp(img.id,'src',tiny);
  proj.commit('选图');
  const el=document.querySelector(`#canvas .wd[data-id="${img.id}"] .w-image img`);
  const saved=JSON.stringify(proj.data).includes(tiny);
  return { rendered: !!el, srcOk: el?.src===tiny, inProject: saved };
});
check('图片 base64 内嵌进工程且渲染', imgSet.rendered && imgSet.srcOk && imgSet.inProject, JSON.stringify({rendered:imgSet.rendered, inProject:imgSet.inProject}));

// 属性面板显示"已内嵌" + 预览
await p.waitForTimeout(200);
const propShown = await p.evaluate(()=>{
  const body=document.getElementById('propBody');
  return { hasTag: body.innerHTML.includes('已内嵌到工程'), hasPreview: !!body.querySelector('img[src^="data:"]') };
});
check('属性面板显示内嵌状态+缩略图', propShown.hasTag && propShown.hasPreview, JSON.stringify(propShown));

check('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n==== 弹窗顶层/模态/标题/图片：${results.length-failed.length}/${results.length} 通过 ====`);
process.exit(failed.length?1:0);
