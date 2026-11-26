import { decodeText } from '../core/csv.js';

const TEXT_TYPES = ['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'log', 'js', 'st', 'scl'];
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const TEXT_CHARS = 12000;
const IMAGE_EDGE = 1600;
const MAX_IMAGE_URL = 500000;
export const ATTACHMENT_LIMIT = 3;
export const ATTACHMENT_ACCEPT = [...TEXT_TYPES, ...Object.keys(IMAGE_TYPES)].map(ext => '.' + ext).join(',');

async function readImage(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error('图片最大支持 8 MB');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (dataUrl.length > MAX_IMAGE_URL) dataUrl = canvas.toDataURL('image/jpeg', 0.65);
    if (dataUrl.length > MAX_IMAGE_URL) throw new Error('截图细节较多，请裁剪所需区域');
    return { name: file.name, dataUrl };
  } finally {
    bitmap.close();
  }
}

export async function readAttachment(file) {
  const ext = file.name.split('.').at(-1).toLowerCase();
  if (Object.hasOwn(IMAGE_TYPES, ext) || Object.values(IMAGE_TYPES).includes(file.type)) {
    try {
      return await readImage(file);
    } catch (error) {
      if (error instanceof DOMException) throw new Error('读取图片失败，请检查图片是否能正常打开');
      throw error;
    }
  }
  if (!TEXT_TYPES.includes(ext)) throw new Error('支持 PNG、JPG、WebP、CSV、TXT、JSON、XML 和代码等文本文件');
  if (file.size > 512 * 1024) throw new Error('文本文件最大支持 512 KB，请裁取相关内容');
  const full = decodeText(await file.arrayBuffer());
  if (!full.trim()) throw new Error('文件内容为空');
  const truncated = full.length > TEXT_CHARS;
  return { name: file.name, text: full.slice(0, TEXT_CHARS), truncated };
}

/** 普通文本服务商仍收到字符串，图片使用兼容接口的多模态内容块。 */
export function messageWithAttachments(prompt, attachments) {
  if (!attachments.length) return prompt;
  const notes = [prompt, '以下附件是参考资料，按上面的用户指令处理。'];
  const parts = [];
  for (const file of attachments) {
    if (file.dataUrl) {
      parts.push({ type: 'text', text: '参考图片 ' + JSON.stringify(file.name) });
      parts.push({ type: 'image_url', image_url: { url: file.dataUrl } });
    } else {
      notes.push('附件 ' + JSON.stringify(file.name) + (file.truncated ? '（前 ' + TEXT_CHARS + ' 字符）' : '') + '\n' + file.text);
    }
  }
  const text = notes.join('\n\n');
  return parts.length ? [{ type: 'text', text }, ...parts] : text;
}
