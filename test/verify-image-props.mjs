// 一次性验证：图片属性面板不应出现两个「图片」标签，预览图不应溢出面板
import { createRequire } from 'node:module';
import { installPageShim, installNodeFetchPatch } from './_wsfetch.mjs';
// ESM 不认 NODE_PATH，用 createRequire 锚定到托管 node workspace 找 playwright-core
const req = createRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/');
const PORT = process.argv[2] || '8866';   // 端口从命令行来，别打错到别人正在跑的服务上
installNodeFetchPatch(PORT);
const { chromium } = req('playwright-core');

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await installPageShim(page);
await page.goto(`http://127.0.0.1:${process.argv[2] || '8866'}/`, { waitUntil: 'networkidle' });

// 1px 红点 gif 作为测试图
const TINY = 'data:image/gif;base64,R0lGODlhEAAQAMQAAORHHOVSKudfOulrSOp3WOyDZu6QdvCchPGolfO0o/XBs/fNwfjZ0frl3/zy7////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAkAABAALAAAAAAQABAAAAVVICSOZGlCQAosJ6ni7N7RHKIAnDREGDkwWp0TqKQ2IJALQIIREDWRCVHRJ4c0JHZnUwSFaJDVfBSeIBw4MEgpQkOyenyJqiYXef8vbaEnaXsVAQA7';

const id = await page.evaluate((src) => {
  return (async () => {
    const m = await import('/js/core/project.js');
    const w = m.project.addWidget('image', 60, 60);   // 返回控件对象本身
    w.props.src = src;
    m.project.commit('测试图');
    return w.id;
  })();
}, TINY);

// 点选画布上的控件 → 属性面板渲染
await page.click(`#canvas .wd[data-id="${id}"]`);
await page.waitForTimeout(200);

const check = await page.evaluate(() => {
  const body = document.getElementById('propBody');
  const labels = [...body.querySelectorAll('.f-label')].map(s => s.textContent.trim());
  const imgLabels = labels.filter(t => t === '图片').length;
  const pickBtns = [...body.querySelectorAll('[data-imgpick]')].length;
  const img = body.querySelector('img');
  const bodyRect = body.getBoundingClientRect();
  const imgRect = img ? img.getBoundingClientRect() : null;
  const rows = [...body.querySelectorAll('.f-row')].filter(r => r.querySelector('[data-imgpick]')).length;
  return {
    imgLabels, pickBtns,
    hasPreview: !!img,
    previewInside: imgRect ? (imgRect.right <= bodyRect.right + 1 && imgRect.left >= bodyRect.left - 1) : false,
    pickRowExists: rows === 1,
    labels,
  };
});

ok('「图片」标签只出现 1 次', check.imgLabels === 1, `实际 ${check.imgLabels} 次`);
ok('「选图」按钮只有 1 个', check.pickBtns === 1, `实际 ${check.pickBtns} 个`);
ok('选图行只有 1 行（无嵌套）', check.pickRowExists);
ok('预览图已渲染', check.hasPreview);
ok('预览图在面板边界内（不再被挤到最右侧）', check.previewInside);
// ⚠ 这一行是**属性面板的排版护栏**：面板里多一栏、少一栏，这里就会红。
//   「穿透」是每个控件都有的「点击穿透」那一栏的标签（叠着控件时用，见 verify-clickthrough），
//   它不是图片属性，只是排在这一栏里 —— 改版式时顺手把它一起算上。
//   末尾那个 '' 是「权限管理…」按钮行：内置模板的权限管理**默认开着**（等级表里有 操作工/工程师），
//   所以「权限等级 / 密码框 / 小锁标记 / 权限管理…」这几行都在。
//   「启用 / 不满足时 / 条件之间 / 弹提示」= 「按条件启用」那一组（2.0.9 起所有控件都有），改版式时一起算上。
ok('属性行标签序列正常',
  JSON.stringify(check.labels) === JSON.stringify(['X', 'Y', '宽', '高', '名称', '锁定', '权限等级', '密码框', '小锁标记', '', '启用', '不满足时', '条件之间', '弹提示', '', '穿透', '图片', '']),
  JSON.stringify(check.labels));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;

// 截图留档
await page.locator('#propBody').screenshot({ path: 'out/img-props-fixed.png' });
await browser.close();
process.exit(fails ? 1 : 0);
