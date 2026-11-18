// smoke5.mjs — 清单选中高亮 + 网格开关 + 画布设置
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

// ══ 网格开关生效 ══
const gridOn = await p.evaluate(()=>{
  const c=document.getElementById('canvas');
  return { hasGridImg: getComputedStyle(c).backgroundImage.includes('linear-gradient'), nogrid: c.classList.contains('nogrid') };
});
check('默认网格线显示', gridOn.hasGridImg && !gridOn.nogrid, JSON.stringify(gridOn));
await p.click('#btnGrid');
await p.waitForTimeout(150);
const gridOff = await p.evaluate(()=>{
  const c=document.getElementById('canvas');
  return { hasGridImg: getComputedStyle(c).backgroundImage.includes('linear-gradient'), nogrid: c.classList.contains('nogrid') };
});
check('点击网格按钮 → 关闭网格线', !gridOff.hasGridImg && gridOff.nogrid, JSON.stringify(gridOff));
await p.click('#btnGrid'); // 恢复

// ══ 画布设置弹窗生效 ══
await p.click('#btnCanvasSetting');
await p.waitForTimeout(200);
const dlgShown = await p.evaluate(()=>!document.getElementById('dlgMask').classList.contains('hidden'));
await p.evaluate(()=>{ document.getElementById('csW').value='1200'; document.getElementById('csH').value='700'; });
await p.click('#dlgOk');
await p.waitForTimeout(300);
const cs = await p.evaluate(()=>({ w: document.getElementById('canvas').style.width, h: document.getElementById('canvas').style.height }));
check('画布设置弹窗改尺寸生效', dlgShown && cs.w==='1200px' && cs.h==='700px', JSON.stringify(cs));

// ══ 清单选中高亮 ══
await p.click('.lp-tab[data-tab="list"]');
await p.waitForTimeout(200);
// 点画布某控件 → 清单行高亮
const firstWid = await p.evaluate(()=>window.app.project.currentWidgets()[0].id);
await p.evaluate((id)=>{ const el=document.querySelector(`#canvas .wd[data-id="${id}"]`); el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0})); }, firstWid);
await p.waitForTimeout(200);
const hlFromCanvas = await p.evaluate((id)=>document.querySelector(`#widgetList .wl-item[data-id="${id}"]`)?.classList.contains('active'), firstWid);
check('画布选中 → 清单行高亮', hlFromCanvas===true);

// 点清单另一行 → 该行高亮 + 画布选中
const secondWid = await p.evaluate(()=>window.app.project.currentWidgets()[1].id);
await p.evaluate((id)=>document.querySelector(`#widgetList .wl-item[data-id="${id}"]`).click(), secondWid);
await p.waitForTimeout(300);
const hlFromList = await p.evaluate((id)=>({
  rowActive: document.querySelector(`#widgetList .wl-item[data-id="${id}"]`)?.classList.contains('active'),
  canvasSelected: document.querySelector(`#canvas .wd[data-id="${id}"]`)?.classList.contains('selected'),
}), secondWid);
check('点清单行 → 行高亮 + 画布选中', hlFromList.rowActive===true && hlFromList.canvasSelected===true, JSON.stringify(hlFromList));

check('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const failed=results.filter(r=>!r.ok);
console.log(`\n==== 网格/画布设置/清单高亮：${results.length-failed.length}/${results.length} 通过 ====`);
process.exit(failed.length?1:0);
