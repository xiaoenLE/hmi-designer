#!/usr/bin/env node
/**
 * _md-insert.mjs — 往 markdown 里插一段（**字节级**，给 README 这种"有历史损坏字节"的文件用）
 *
 * 为什么不用普通文本编辑：README.md 里有 1500 多处**非法 UTF-8 字节**（历史上被错误编码伤过）。
 * 按 utf8 读进来再写回去，这些字节会被永久替换成 U+FFFD —— 等于把文档毁了。
 * 所以这里全程 Buffer 操作：锚点和插入内容都按字节找/拼，**没碰到的部分逐字节原样保留**。
 * 天然幂等：插入内容里的小节标题已经存在就直接跳过。
 *
 * 用法：node test/_md-insert.mjs <目标.md> "<锚点文字>" <片段.md> [before|after]
 */
import fs from 'node:fs';

const [file, anchorText, snippetFile, where = 'before'] = process.argv.slice(2);
if (!file || !anchorText || !snippetFile) {
  console.error('用法：node test/_md-insert.mjs <目标.md> "<锚点文字>" <片段.md> [before|after]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const snip = fs.readFileSync(snippetFile, 'utf8');

// 幂等：片段里第一个 '## ' 标题已经在目标里 → 什么都不做
const head = (snip.match(/^##\s+(.+)$/m) || [])[1];
if (head) {
  const headBytes = Buffer.from(`## ${head}`, 'utf8');
  if (buf.indexOf(headBytes) >= 0) {
    console.log(`跳过：目标里已经有「## ${head}」这一节`);
    process.exit(0);
  }
}

const anchor = Buffer.from(anchorText, 'utf8');
const at = buf.indexOf(anchor);
if (at < 0) { console.error(`找不到锚点：${anchorText}`); process.exit(1); }
// 锚点要落在**行首**（否则会插到某一行中间）
if (at > 0 && buf[at - 1] !== 0x0A) {
  console.error('锚点不在行首（往前找找，锚点左边应该是换行）');
  process.exit(1);
}

const text = Buffer.from(snip.endsWith('\n') ? snip : snip + '\n', 'utf8');
const pos = where === 'after' ? at + anchor.length : at;
// 前面补一个空行，后面留一个空行（markdown 小节之间要空行）
const out = Buffer.concat([buf.subarray(0, pos), Buffer.from('\n', 'utf8'), text, Buffer.from('\n', 'utf8'), buf.subarray(pos)]);
fs.writeFileSync(file, out);
console.log(`已插入 ${text.length} 字节（${where} 「${anchorText}」）· 文件 ${buf.length} → ${out.length} 字节`);
