/**
 * verify-csv-encoding.mjs — CSV 导入的编码识别（中文乱码问题）
 *
 * 现场最常见的一类：Excel 在中文 Windows 上「另存为 CSV」存的是 **GBK/ANSI**，
 * 以前按 UTF-8 读出来全是「寮犱笁」这种乱码。现在按 BOM → UTF-8 → GB18030/GBK/Big5 顺序试。
 * 这里用真实文件（真的 GBK 字节 / UTF-16 字节）走一遍「选择 CSV 文件…」，不是只调函数。
 *
 * 运行：node test/verify-csv-encoding.mjs <port>
 */
import { createRequire } from 'node:module';

const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';

/* 三种编码的样本文件：字节是算好的（GBK 用 Python 的 gbk 试出来写死，测试不引编码库） */
const FIX = {
  alarmGbk: 'c3fbb3c62cb1e4c1bf2cb1c8bdcf2ce3d0d6b52cd1d3cab1732cbcb6b1f02cc4dac8dd2cc6f4d3c30d0ad7aacbd9b9fdb8df2c7253706565642c3e3d2c333030302c302cb1a8beaf2cd6f7d6e1d7aacbd9b9fdb8dfa3ba7b7253706565647d206d2f6d696e2ccac70d0abcc6cafdb5bd2c69436f756e742c3d3d2c372c322cbeafb8e62cbcc6cafdb5bd207b69436f756e747d20bcfe2cb7f10d0a',
  varsGbk: 'c3fbb3c62cc0e0d0cd2cb5d8d6b72cd7d6b3a42cb3f5d6b50d0ad6d0cec4b1e4c1bf2c7265616c2c254d573230302c302c312e350d0ababad7d6b2bcb6fb2c626f6f6c2c254d58392e392c302c747275650d0a',
  alarmUtf16: 'fffe0d54f0792c00d853cf912c00d46b838f2c0008963c502c00f65ef66573002c00a77e2b522c008551b95b2c002f5428750d000a006c8f1f90c78fd89a2c007200530070006500650064002c003e003d002c0033003000300030002c0030002c00a562668b2c003b4e748f6c8f1f90c78fd89a1aff7b007200530070006500650064007d0020006d002f006d0069006e002c002f660d000a00a18b706530522c00690043006f0075006e0074002c003d003d002c0037002c0032002c00668b4a542c00a18b7065305220007b00690043006f0075006e0074007d002000f64e2c0026540d000a00',
  alarmUtf8Bom: 'efbbbfe5908de7a7b02ce58f98e9878f2ce6af94e8be832ce99888e580bc2ce5bbb6e697b6732ce7baa7e588ab2ce58685e5aeb92ce590afe794a80d0ae8bdace9809fe8bf87e9ab982c7253706565642c3e3d2c333030302c302ce68aa5e8ada62ce4b8bbe8bdb4e8bdace9809fe8bf87e9ab98efbc9a7b7253706565647d206d2f6d696e2ce698af0d0ae8aea1e695b0e588b02c69436f756e742c3d3d2c372c322ce8ada6e5918a2ce8aea1e695b0e588b0207b69436f756e747d20e4bbb62ce590a60d0a',
  alarmUtf8: 'e5908de7a7b02ce58f98e9878f2ce6af94e8be832ce99888e580bc2ce5bbb6e697b6732ce7baa7e588ab2ce58685e5aeb92ce590afe794a80d0ae8bdace9809fe8bf87e9ab982c7253706565642c3e3d2c333030302c302ce68aa5e8ada62ce4b8bbe8bdb4e8bdace9809fe8bf87e9ab98efbc9a7b7253706565647d206d2f6d696e2ce698af0d0ae8aea1e695b0e588b02c69436f756e742c3d3d2c372c322ce8ada6e5918a2ce8aea1e695b0e588b0207b69436f756e747d20e4bbb62ce590a60d0a',
};
const buf = (hex) => Buffer.from(hex, 'hex');

const results = [];
const ok = (name, pass, extra = '') => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', d => d.accept());          // 导入完成后的 alert 直接确认

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => { m.backend.probe = async () => null; m.backend.state = 'offline'; }));
await page.waitForFunction(() => window.app?.project?.data);

const L = (t) => t;   // 占位，保持可读

/* ── 1. 纯函数：decodeText 认三种编码 ── */
const dec = await page.evaluate(async (fx) => {
  const { decodeText } = await import('/js/core/csv.js');
  const mk = (hex) => {
    const u8 = new Uint8Array(hex.length / 2);
    for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hex.substr(i * 2, 2), 16);
    return u8.buffer;
  };
  const one = (hex) => decodeText(mk(hex)).split('\r\n')[1];
  return {
    gbk: one(fx.alarmGbk), utf16: one(fx.alarmUtf16),
    utf8bom: one(fx.alarmUtf8Bom), utf8: one(fx.alarmUtf8),
  };
}, FIX);
const wantLine = L('转速过高,rSpeed,>=,3000,0,报警,主轴转速过高：{rSpeed} m/min,是');
ok('decodeText：GBK 中文不乱码', dec.gbk === wantLine, dec.gbk.slice(0, 60));
ok('decodeText：UTF-16LE（带 BOM）不乱码', dec.utf16.trim() === wantLine, dec.utf16.trim().slice(0, 60));
ok('decodeText：UTF-8 带 BOM 不乱码', dec.utf8bom === wantLine, dec.utf8bom.slice(0, 60));
ok('decodeText：UTF-8 无 BOM 不乱码', dec.utf8 === wantLine, dec.utf8.slice(0, 60));

/* ── 2. 报警 CSV：真实文件选择器 → GBK 文件 ── */
await page.click('.lp-tab[data-panel="alarms"]');   // 报警面板要可见（文件选择按钮在里面）
await page.waitForTimeout(300);
await page.click('#btnAlarmCsvIn');
await page.waitForTimeout(200);
await page.setInputFiles('#alarmCsvPick', {
  name: '报警表-gbk.csv', mimeType: 'text/csv', buffer: buf(FIX.alarmGbk),
});
await page.waitForTimeout(300);
const gbkArea = await page.inputValue('#alarmCsvText');
ok('报警 CSV：选 GBK 文件后文本框里就是中文（不是乱码）',
  gbkArea.includes('转速过高') && gbkArea.includes('主轴转速过高') && !/锟|寮|鏂/.test(gbkArea),
  JSON.stringify(gbkArea.split('\n')[1] || '').slice(0, 80));
const pickInfo = await page.textContent('#alarmCsvPickInfo');
ok('选择文件后有回执（读入几行）', /已读入 报警表-gbk\.csv/.test(pickInfo), pickInfo);
await page.click('#dlgOk');
await page.waitForTimeout(400);
const imported = await page.evaluate(() => window.app.project.alarms().map(a => ({ n: a.name, v: a.variable, t: a.text, lv: a.level })));
ok('GBK 报警表导入成功：名称/变量/内容/级别都对',
  imported.length === 2 && imported[0].n === '转速过高' && imported[0].v === 'rSpeed'
  && imported[0].t === '主轴转速过高：{rSpeed} m/min' && imported[0].lv === 'alarm'
  && imported[1].n === '计数到' && imported[1].lv === 'warn',
  JSON.stringify(imported));

/* ── 3. 报警 CSV：UTF-16（Excel「Unicode 文本」另存） ── */
await page.click('#btnAlarmCsvIn');
await page.waitForTimeout(200);
await page.setInputFiles('#alarmCsvPick', {
  name: '报警表-unicode.csv', mimeType: 'text/csv', buffer: buf(FIX.alarmUtf16),
});
await page.waitForTimeout(300);
const u16Area = await page.inputValue('#alarmCsvText');
ok('报警 CSV：UTF-16 文件也认（同样不乱码）', u16Area.includes('转速过高'), JSON.stringify(u16Area.split('\n')[1] || '').slice(0, 60));
await page.click('#dlgCancel');
await page.waitForTimeout(200);

/* ── 4. 变量 CSV：GBK 文件（走变量面板的文件选择器） ── */
await page.click('.lp-tab[data-tab="vars"]');      // 切到「变量」面板
await page.waitForTimeout(250);
await page.setInputFiles('#varCsvFile', {
  name: '变量表-gbk.csv', mimeType: 'text/csv', buffer: buf(FIX.varsGbk),
});
await page.waitForTimeout(600);
const vars = await page.evaluate(() => window.app.project.variables()
  .filter(v => v.type === 'real' || v.type === 'bool')
  .slice(-2).map(v => ({ n: v.name, t: v.type, a: v.address })));
ok('变量 CSV：GBK 文件导入后变量名是中文（不乱码）',
  vars.some(v => v.n === '中文变量' && v.a === '%MW200') && vars.some(v => v.n === '汉字布尔'),
  JSON.stringify(vars));

/* ── 5. 导出仍然是 UTF-8 BOM（Excel 双击打开不乱码） ── */
const csvOut = await page.evaluate(async () => {
  const { varsToCsv, alarmsToCsv } = await import('/js/core/csv.js');
  const A = await import('/js/runtime/alarms.js');
  return {
    vars: varsToCsv(window.app.project.variables()).slice(0, 40),
    alarms: alarmsToCsv(window.app.project.alarms(), A.ALARM_LEVELS).slice(0, 30),
  };
});
ok('导出的 CSV 仍带 UTF-8 BOM（Excel 打开不乱码）',
  csvOut.vars.charCodeAt(0) === 0xFEFF && csvOut.alarms.charCodeAt(0) === 0xFEFF,
  JSON.stringify([csvOut.vars.slice(0, 12), csvOut.alarms.slice(0, 12)]));

ok('全程没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n==== CSV 编码识别回归：${results.length - fails}/${results.length} 通过 ====`);
process.exit(fails ? 1 : 0);
