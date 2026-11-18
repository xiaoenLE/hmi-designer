// 复现「OPC UA 导入的变量不能在控件属性里切换」
// 造一批和 OPC UA 导入产物一模一样的变量（NodeId 地址 + 展开后的 arrw[1]），
// 再在属性面板里真的去切下拉，看工程里的绑定到底有没有变。
import { createRequire } from 'node:module';
import { installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8881';
installNodeFetchPatch(BASE);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.waitForTimeout(600);

const NS = 'ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.';
const info = await page.evaluate(async (NS) => {
  const m = window.app.project;
  m.data.variables.length = 0;
  const V = (name, type, address, value) => ({ name, type, address, value, len: 0 });
  // 工程里本来就有几个 Modbus 变量
  m.data.variables.push(V('bRunCmd', 'bool', '%MX0.0', false));
  m.data.variables.push(V('rSpeed', 'real', '%MW100', 12.5));
  // OPC UA 导进来的：标量 + 展开的数组元素
  m.data.variables.push(V('ua_bRun', 'bool', NS + 'bRun', false));
  m.data.variables.push(V('ua_rSpd', 'real', NS + 'rSpd', 0));
  m.data.variables.push(V('ua_iCnt', 'dint', NS + 'iCnt', 0));
  for (let k = 1; k <= 13; k++) m.data.variables.push(V(`arrw[${k}]`, 'int', `${NS}arrw[${k}]`, 0));
  const pg = m.pages()[0];
  pg.widgets.length = 0;
  const w = m.addWidget('number', 40, 40);
  w.name = 'numA';
  w.bindings.variable = 'ua_rSpd';
  const w2 = m.addWidget('lamp', 260, 40);
  w2.name = 'lampA';
  w2.bindings.variable = 'ua_bRun';
  m.commit('opc 绑定测试');
  return { num: w.id, lamp: w2.id, total: m.variables().length };
}, NS);
console.log('变量总数 =', info.total, ' 数值控件 =', info.num, ' 灯 =', info.lamp);

/** 变量格现状：现在是「输入框 + 候选表（varPick）」——点进去看全部，打字过滤 */
const dump = async (wid, tag) => {
  const r = await page.evaluate(async (wid) => {
    const m = (await import('/js/core/project.js')).project;
    const w = m.getWidget(wid);
    const sel = document.querySelector('#propBody [data-bind="variable"]');
    sel?.focus();
    await new Promise(r => setTimeout(r, 180));
    const names = [...document.querySelectorAll('.vp-list .vp-row')]
      .map(x => x.querySelector('.vp-name')?.textContent);
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return {
      bound: w?.bindings?.variable,
      isInput: sel?.tagName === 'INPUT',
      selValue: sel?.value,
      candCount: names.length,
      candHead: names.slice(0, 4),
      hasTarget: names.includes('ua_iCnt'),
      bad: !!sel?.classList.contains('bad'),
      searchBox: !!document.querySelector('#propBody [data-vsearch="bind"]'),
    };
  }, wid);
  console.log(`${tag}: ${JSON.stringify(r)}`);
  return r;
};

// 选中控件（真实点击：选中判定挂在 pointerdown 上）
await page.click(`#canvas .wd[data-id="${info.num}"]`);
await page.waitForTimeout(300);
await dump(info.num, '选中数值控件后');

// A. 直接在框里打字（边打边过滤），回车确认
const switchBy = async (wid, target, tag) => {
  const sel = '#propBody [data-bind="variable"]';
  await page.click(`#canvas .wd[data-id="${wid}"]`);
  await page.waitForTimeout(220);
  await page.click(sel);
  await page.fill(sel, target);
  await page.waitForTimeout(180);
  const inList = await page.evaluate((t) => [...document.querySelectorAll('.vp-list .vp-row')]
    .some(r => r.querySelector('.vp-name')?.textContent === t), target);
  let thrown = '';
  try { await page.keyboard.press('Enter'); } catch (e) { thrown = String(e).split('\n')[0]; }
  await page.waitForTimeout(400);
  const after = await page.evaluate(async (wid) => {
    const m = (await import('/js/core/project.js')).project;
    return m.getWidget(wid)?.bindings?.variable;
  }, wid);
  console.log(`${tag}: 候选里有它=${inList}  写进工程=${JSON.stringify(after)}  ${thrown ? '异常: ' + thrown : ''}`);
  return { inList, after };
};

await switchBy(info.num, 'ua_iCnt', 'A 直接切 ua_rSpd → ua_iCnt');
await switchBy(info.num, 'arrw[7]', 'A2 直接切 → arrw[7]');
await switchBy(info.num, 'rSpeed', 'A3 切回 Modbus 变量 rSpeed');

// B. 打字过滤（变量多的时候的正路）：打 ua_ 只剩 OPC UA 那批
console.log('--- B. 边打字边过滤 ---');
await page.click(`#canvas .wd[data-id="${info.num}"]`);
await page.waitForTimeout(250);
await page.click('#propBody [data-bind="variable"]');
await page.fill('#propBody [data-bind="variable"]', 'ua_');
await page.waitForTimeout(300);
await dump(info.num, '打 ua_ 之后');
await switchBy(info.num, 'ua_bRun', 'B 过滤后切 → ua_bRun（bool 变量，类型不匹配）');

// C. 灯（只允许 bool）
await page.click(`#canvas .wd[data-id="${info.lamp}"]`);
await page.waitForTimeout(300);
await dump(info.lamp, '选中指示灯后');
await switchBy(info.lamp, 'arrw[7]', 'C 灯切 → arrw[7]（int，类型不匹配）');

console.log('PAGE ERRORS:', JSON.stringify(errs));
await browser.close();
