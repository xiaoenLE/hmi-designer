// shot-fit-narrow.mjs — 窄窗口（手机竖屏）运行画面整幅缩放的截图：改动前后对着看
//   node tools/run-suites.mjs shot-fit-narrow        （out/ 下出图，顺便打印每张图的量测）
// 用的是服务器上那份工程（server/data/hmi_project.LE，只读注入，不碰服务器）
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PORT = process.argv[2] || '8866';
installNodeFetchPatch(PORT);
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 工程文件现在是 .LE；老机器上还是 .json —— 两个都试（本地开发目录里可能只有老的）
const _pLE = path.join(ROOT, 'server', 'data', 'hmi_project.LE');
const projFile = fs.existsSync(_pLE) ? _pLE : path.join(ROOT, 'server', 'data', 'hmi_project.json');
const proj = fs.existsSync(projFile) ? JSON.parse(fs.readFileSync(projFile, 'utf8')) : null;
console.log(proj ? `用服务器上那份工程：${proj?.meta?.name || '(无名)'} 画布 ${proj?.meta?.canvas?.w}×${proj?.meta?.canvas?.h}`
  : '服务器上没有工程 → 用页面自带的演示工程');

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 785, height: 970 }, hasTouch: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await installPageShim(page);
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.evaluate(() => import('/js/api/backend.js').then(m => {
  m.backend.probe = async () => null;
  m.backend.state = 'offline';
  m.backend.expectsServer = () => false;
  m.backend.readVars = async () => null;
  m.backend.syncVarTable = async () => false;
  m.backend.setPolling = async () => null;
  m.backend.startEvents = () => {};
  m.backend.loadAlarms = async () => [];
}));
await page.waitForFunction(() => window.app?.project?.data);
if (proj) {
  await page.evaluate(d => { window.app.project.replaceData(d); }, proj);
  await sleep(300);
}
await page.evaluate(async () => {
  const rt = await import('/js/runtime/runtime.js');
  await rt.enterRun();
  rt.hideRuntimeHint();
  rt.setZoomMode('fit');
});
await sleep(900);

const shots = [];
for (const [w, h, tag] of [[785, 970, '785x970'], [360, 640, '360x640'], [1024, 700, '1024x700']]) {
  await page.setViewportSize({ width: w, height: h });
  await sleep(700);
  const info = await page.evaluate(() => {
    const rt = document.getElementById('rtPage');
    const r = rt.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(rt).transform === 'none' ? '' : getComputedStyle(rt).transform);
    // 画面上"最右下"的那个控件，用来判有没有被切
    let far = null;
    document.querySelectorAll('#rtPage .wd').forEach(el => {
      const b = el.getBoundingClientRect();
      if (!far || b.right > far.right || b.bottom > far.bottom) far = { right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) };
    });
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      box: `${rt.offsetWidth}×${rt.offsetHeight}`,
      scale: `${m.a.toFixed(3)}/${m.d.toFixed(3)}`,
      page: `${r.left.toFixed(1)},${r.top.toFixed(1)} → ${r.right.toFixed(1)},${r.bottom.toFixed(1)}`,
      farRightBottom: far, fits: r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
    };
  });
  const file = path.join(OUT, `fit-narrow-${tag}.png`);
  await page.screenshot({ path: file });
  shots.push([tag, file, info]);
}

for (const [tag, file, info] of shots) {
  console.log(`\n[${tag}] → ${file}`);
  console.log(`  画布盒子=${info.box}（必须等于工程画布尺寸）  缩放=${info.scale}  画面位置=${info.page}  整幅在窗内=${info.fits}`);
  console.log(`  最右下控件 right/bottom=${JSON.stringify(info.farRightBottom)}  窗口=${info.vw}×${info.vh}`);
}
console.log(errs.length ? `\n页面异常：${errs.join(' | ')}` : '\n无页面异常');
await browser.close();
