// verify-vargroup.mjs — 变量面板的两级折叠
//   ① 前缀级：导入进来的名字是带点的符号路径（GVL.a、GVL.arrw[1]、PLC_PRG.speed），
//      按「第一个点之前那一段」收成一组 —— ⚠ 前缀**不是写死的 GVL**，可能是 GVL_1 / PLC_PRG / 任何 POU 名。
//   ② 数组级：arrw[1]…arrw[13] 收成一行（老行为，放在前缀组里面，再缩进一格）。
//   展开/收起的状态记在 localStorage，刷新后保持。
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8900';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await sleep(400);
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null; m.backend.state = 'offline';
  m.backend.writeVar = async () => {}; m.backend.readVars = async () => null;
  m.backend.plcInfo.protocol = 'modbus';
  m.backend.getPlc = async () => ({ ok: true, config: {}, status: { mode: 'memory', protocol: 'modbus' } });
}));

const setup = await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  m.data.variables.length = 0;
  const NS = 'ns=4;s=|var|PLC.Application.';
  const V = (name, type, tail) => ({ name, type, address: NS + tail, value: 0, len: 0 });
  // 前缀叫 GVL_1（故意不叫 GVL：前缀是按名字现算的，不能写死）
  V.store = null;
  ['a', 'b', 'dd'].forEach((n, i) => m.data.variables.push(V(`GVL_1.${n}`, i === 2 ? 'bool' : 'int', `GVL_1.${n}`)));
  for (let k = 1; k <= 4; k++) m.data.variables.push(V(`GVL_1.arrw[${k}]`, 'int', `GVL_1.arrw[${k}]`));
  // 另一个前缀：POU 里的变量
  m.data.variables.push(V('PLC_PRG.speed', 'real', 'PLC_PRG.speed'));
  m.data.variables.push(V('PLC_PRG.count', 'dint', 'PLC_PRG.count'));
  // 裸名（没点）不分组
  m.data.variables.push(V('lone', 'int', 'lone'));
  m.commit('折叠测试');
  const mod = await import('/js/editor/varsPanel.js');
  return { items: mod.__buildDisplayListForTest?.(m.variables()) || null, total: m.variables().length };
});
await page.evaluate(async () => { const m = await import('/js/editor/varsPanel.js'); m.initVarsPanel?.(); });
await sleep(300);
await page.evaluate(() => { try { localStorage.removeItem('hmi-vars-groups-open'); } catch { /* 忽略 */ } });
// 重新渲染一遍（清掉上次的展开状态）
await page.evaluate(async () => {
  const m = await import('/js/core/project.js');
  m.project.touch?.(); m.project.commit('重画');
});
await page.click('#leftPanel .lp-tab[data-panel="vars"]');
await sleep(400);

const rows = () => page.evaluate(() => [...document.querySelectorAll('#varTable tr')].map(tr => ({
  group: tr.classList.contains('vt-group'),
  d1: tr.classList.contains('d1'),
  pg: tr.classList.contains('pg'),
  key: tr.dataset.gkey || '',
  // 变量行的名字在 input 的 value 里（可改名），表头行的说明在 textContent 里
  name: tr.querySelector('input[data-k="name"]')?.value || '',
  text: tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
  chevron: (tr.querySelector('.vt-gtw') || {}).textContent || '',
})));
const r0 = await rows();
const groups0 = r0.filter(r => r.group);
ok('前缀按名字现算：GVL_1 和 PLC_PRG 各收成一组（没有写死 GVL）',
  groups0.some(g => g.text.startsWith('▸ GVL_1')) && groups0.some(g => g.text.startsWith('▸ PLC_PRG')),
  JSON.stringify(groups0.map(g => g.text)));
ok('裸名（lone，没有点）不进任何组', r0.some(r => !r.group && r.name === 'lone'), JSON.stringify(r0.filter(r => !r.group).map(r => r.name)));
ok('默认收起：GVL_1 组下面那 7 个成员一个都不显示（只剩表头）',
  r0.filter(r => !r.group && /^GVL_1\./.test(r.name)).length === 0, String(r0.length));
ok('组表头写明个数和首尾成员',
  /GVL_1 .*7 个（GVL_1\.a … GVL_1\.arrw\[4\]）/.test(groups0.find(g => g.text.includes('GVL_1'))?.text || ''),
  groups0.find(g => g.text.includes('GVL_1'))?.text);

/* 展开前缀组 → 组里的数组元素又合成一行（第二级，缩进一格） */
await page.click('#varTable tr.vt-group.pg');
await sleep(300);
const r1 = await rows();
const pg1 = r1.find(r => r.pg);
ok('展开 GVL_1 → 表头变成 ▾', (pg1?.chevron || '') === '▾', JSON.stringify(pg1));
ok('展开后出现成员：a / b / dd 三行',
  ['GVL_1.a', 'GVL_1.b', 'GVL_1.dd'].every(n => r1.some(r => !r.group && r.name === n)),
  JSON.stringify(r1.filter(r => !r.group).map(r => r.name)));
const sub = r1.find(r => r.group && r.d1);
ok('组里的数组元素合成第二级表头（缩进 + ▸）',
  !!sub && /▸/.test(sub.chevron) && /GVL_1\.arrw .*4（GVL_1\.arrw\[1\] … GVL_1\.arrw\[4\]）/.test(sub.text),
  JSON.stringify(sub));
ok('第二级收起时那 4 个元素不显示',
  r1.filter(r => !r.group && /arrw\[/.test(r.name)).length === 0, String(r1.length));

await page.click('#varTable tr.vt-group.d1');
await sleep(300);
const r2 = await rows();
ok('再展开第二级 → 4 个 arrw 元素逐条显示',
  ['GVL_1.arrw[1]', 'GVL_1.arrw[4]'].every(n => r2.some(r => !r.group && r.name === n)),
  JSON.stringify(r2.filter(r => !r.group).map(r => r.name)));

/* 整组勾选还在（行尾那个「删除这一整组」的 ✕ 按现场要求去掉了 —— 勾上整组再点
   底部「删除选中」就是整组删，少一个按钮少一份误碰） */
const gsel = await page.evaluate(() => {
  const tr = document.querySelector('#varTable tr.vt-group.pg');
  const cb = tr.querySelector('[data-gsel]');
  cb.click();
  return {
    hasDel: !!tr.querySelector('[data-gdel]'),
    checked: cb.checked,
    btn: document.getElementById('btnDelVars').textContent.trim(),
  };
});
await sleep(250);
ok('前缀组也能一次勾选整组（勾上后底部就是「删除选中 (N)」，行尾不再有整组 ✕）',
  gsel.checked === true && gsel.hasDel === false && /^删除选中 \(\d+\)$/.test(gsel.btn), JSON.stringify(gsel));
// 勾上是为了验按钮，验完清掉，别把后面的用例带偏
await page.evaluate(() => {
  const cb = document.querySelector('#varTable tr.vt-group.pg [data-gsel]');
  cb.click();
});
await sleep(200);

/* ⚠ 中文名数组（名字里没有点 → 走"顶层数组"那一支）：
   以前这里是逐条 members([v]) —— 每个元素各成一组（×1），看着就像"没折叠也没缩进"。
   从 OPC UA 导入的中文名数组（串1[1]…串1[8]）正好走这一支，所以现场一眼就看出来了。 */
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  for (let k = 1; k <= 8; k++) {
    m.data.variables.push({ name: `串1[${k}]`, type: 'string', address: '', value: '', len: 10 });
  }
  m.data.variables.push({ name: '温度', type: 'real', address: '', value: 0, len: 0 });
  m.commit('中文数组');
});
await sleep(350);
const rcn = await rows();
const cnGroups = rcn.filter(r => r.group && /串1/.test(r.text));
ok('中文名数组（串1[1..8]，名字里没有点）只出**一个**表头，不是每行一个 ×1',
  cnGroups.length === 1 && /×8（串1\[1\] … 串1\[8\]）/.test(cnGroups[0].text),
  JSON.stringify(cnGroups.map(g => g.text)));
ok('中文数组收起时元素不显示（跟别的组一个规矩）',
  rcn.filter(r => !r.group && /^串1\[/.test(r.name)).length === 0, String(rcn.length));
ok('中文名（温度）不进任何组', rcn.some(r => !r.group && r.name === '温度'));

/* 中文**前缀**也要能收组：设备1.速度 / 设备1.温度（以前前缀正则只认 ASCII 标识符） */
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  ['速度', '温度', '压力'].forEach(n => m.data.variables.push({ name: `设备1.${n}`, type: 'real', address: '', value: 0, len: 0 }));
  m.commit('中文前缀');
});
await sleep(350);
const rcnPre = await rows();
const cnPre = rcnPre.filter(r => r.group && /设备1/.test(r.text));
ok('中文前缀（设备1.速度…）也收成一组（前缀不认语言，只认"第一个点之前那一段"）',
  cnPre.length === 1 && /3 个（设备1\.速度 … 设备1\.压力）/.test(cnPre[0].text),
  JSON.stringify(cnPre.map(g => g.text)));

await page.locator('#varTable tr.vt-group', { hasText: '串1' }).first().click();
await sleep(350);
const rcn2 = await rows();
ok('展开中文数组 → 8 个元素逐条显示',
  ['串1[1]', '串1[8]'].every(n => rcn2.some(r => !r.group && r.name === n)),
  JSON.stringify(rcn2.filter(r => !r.group).map(r => r.name).slice(-10)));
const cnIndent = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('#varTable tr')]
    .find(t => t.querySelector('input[data-k="name"]')?.value === '串1[3]');
  const td = tr?.querySelector('td.vt-in');
  return { cls: tr?.className || '', pad: td ? getComputedStyle(td).paddingLeft : '' };
});
ok('中文数组的元素跟英文组里的一样缩进一格',
  cnIndent.pad === '14px' && /vt-ind/.test(cnIndent.cls), JSON.stringify(cnIndent));

/* ⚠ 二维数组元素（PLC 里 `ARRAY[1..3,1..6]` 那种，导入/建变量时摊平成 `X[1,1]…X[3,6]`）：
   以前下标正则只认**一个**数字（`/^(.+)\[(\d+)\]$/`），二维元素全走"不是元素"那一支 →
   18 条平铺一长串、收不起来（现场看到的"二维数值不能折叠"）。 */
await page.evaluate(async () => {
  const m = (await import('/js/core/project.js')).project;
  for (let c = 1; c <= 3; c++) {
    for (let r = 1; r <= 3; r++) {
      m.data.variables.push({
        name: `Hr断线故障数据[${r},${c}]`, type: 'real',
        address: '%MW' + (6400 + 2 * ((r - 1) + 3 * (c - 1))), value: 0, len: 0,
      });
    }
  }
  m.commit('二维数组');
});
await sleep(350);
const r2d = await rows();
const g2d = r2d.filter(r => r.group && /Hr断线故障数据/.test(r.text));
ok('二维数组元素（X[1,1]…）只出**一个**表头，不是一条一行',
  g2d.length === 1 && /×9（\[1,1\] … \[3,3\]）/.test(g2d[0].text), JSON.stringify(g2d.map(g => g.text)));
ok('二维数组收起时元素不显示（跟一维一个规矩）',
  r2d.filter(r => !r.group && /^Hr断线/.test(r.name)).length === 0, String(r2d.length));
await page.locator('#varTable tr.vt-group', { hasText: 'Hr断线故障数据' }).first().click();
await sleep(350);
const r2dOpen = await rows();
ok('展开二维数组 → 9 个元素逐条显示出来',
  ['Hr断线故障数据[1,1]', 'Hr断线故障数据[3,3]'].every(n => r2dOpen.some(r => !r.group && r.name === n)),
  JSON.stringify(r2dOpen.filter(r => !r.group).map(r => r.name).filter(n => n.startsWith('Hr断线')).slice(0, 4)));

/* 展开状态要记住（刷新页面还开着） */
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hmi-vars-groups-open') || '[]'));
ok('展开状态写进 localStorage（前缀组用 p: 前缀、数组组用 a: 前缀）',
  saved.includes('p:GVL_1') && saved.includes('a:GVL_1.arrw'), JSON.stringify(saved));

await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.app?.project?.data);
await page.click('#leftPanel .lp-tab[data-panel="vars"]');
await sleep(500);
const r3 = await rows();
ok('刷新后还是展开的样子（两级都记着）',
  (r3.find(r => r.pg)?.chevron === '▾') && r3.some(r => !r.group && r.name === 'GVL_1.arrw[4]'),
  JSON.stringify(r3.filter(r => r.group).map(r => r.text)));

/* ══════ 搜索框：按名称/地址/类型过滤，而且把折叠组摊开 ══════ */
await page.evaluate(() => { const f = document.getElementById('varFilter'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(250);
const allRows = (await rows()).length;
await page.evaluate(() => {
  const f = document.getElementById('varFilter');
  f.value = 'speed';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const rSearch = await rows();
// ⚠ rows() 把表头那一行也算进来了（`#varTable tr` 含 thead）→ 只看真正的变量行（有名字的）
const hitsSearch = rSearch.filter(r => !r.group && r.name).map(r => r.name);
ok('搜索框按**变量名**过滤：搜 speed 只剩 PLC_PRG.speed（别的组表头也没了）',
  hitsSearch.join(',') === 'PLC_PRG.speed' && rSearch.length < allRows, JSON.stringify(hitsSearch));

await page.evaluate(() => {
  const f = document.getElementById('varFilter');
  f.value = 'HR500';            // 地址
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const rAddr = await rows();
ok('按**地址**也能搜到（搜 HR500）', rAddr.some(r => !r.group), JSON.stringify(rAddr.map(r => r.name)));

await page.evaluate(() => {
  const f = document.getElementById('varFilter');
  f.value = 'arrw';             // 名称里的数组名 —— 匹配的是收在折叠组里的元素
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const rArr = await rows();
ok('★ 搜到的东西**把折叠组摊开**（搜 arrw 时元素直接列出来，不用手动点开）',
  rArr.some(r => !r.group && /^GVL_1\.arrw\[/.test(r.name)), JSON.stringify(rArr.map(r => r.text || r.name).slice(0, 6)));

const cnt = await page.evaluate(() => document.getElementById('varCount')?.textContent || '');
ok('搜索时列表右上角显示「匹配数/总数」', /\d+\/\d+/.test(cnt), cnt);

await page.evaluate(() => {
  const f = document.getElementById('varFilter');
  f.value = '这个变量根本不存在';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
const rNone = await rows();
ok('搜不到时列表是空的（不报错、也不把全部显示出来）',
  rNone.filter(r => !r.group && r.name).length === 0, JSON.stringify(rNone.length));

await page.evaluate(() => {
  const f = document.getElementById('varFilter');
  f.value = '';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
ok('清空搜索框 → 恢复全部变量', (await rows()).length === allRows, String((await rows()).length));

/* ══════ 搜索框吸顶：滚下去还在顶部，表头紧贴它下面（不留缝） ══════ */
await page.evaluate(() => {
  const f = document.getElementById('varFilter');
  f.value = '';
  f.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#panel-vars .panel-body').scrollTop = 120;
});
await sleep(350);
const stick = await page.evaluate(() => {
  const body = document.querySelector('#panel-vars .panel-body').getBoundingClientRect();
  const row = document.getElementById('varFilterRow').getBoundingClientRect();
  const th = document.querySelector('#varTable table.vartbl thead th:nth-child(2)').getBoundingClientRect();
  return {
    bodyTop: Math.round(body.top), filterTop: Math.round(row.top), filterBottom: Math.round(row.bottom),
    headTop: Math.round(th.top), 缝: Math.round(th.top - row.bottom), scrollTop: Math.round(document.querySelector('#panel-vars .panel-body').scrollTop),
  };
});
ok('★ 往下滚了之后，搜索框仍然贴在面板顶部（吸顶）',
  stick.scrollTop > 0 && Math.abs(stick.filterTop - stick.bodyTop) <= 2, JSON.stringify(stick));
ok('表头紧贴在搜索框下面（中间没有缝，不会露出半截变量行）',
  stick.缝 <= 1 && stick.缝 >= -3, JSON.stringify(stick));
await page.evaluate(() => { document.querySelector('#panel-vars .panel-body').scrollTop = 0; });
await sleep(200);

ok('全程无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== 变量面板两级折叠：${results.length - fails}/${results.length} 通过 ====`);
await browser.close();
process.exit(fails ? 1 : 0);
