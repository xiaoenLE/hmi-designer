/**
 * storage.js — 工程持久化
 *   1. localStorage 自动保存（防丢）
 *   2. 保存/打开 .json 文件（跨机器交付）
 *   3. 新建/打开工程前先把当前工程备份一份，误操作能找回来
 *   4. 交给 server.js 调用：保存到 Python 后端
 */
import { bus } from './eventBus.js';
import { project, LS_KEY } from './project.js';
import { debounce } from './utils.js';

/** 新建/打开工程前的那一份（「恢复上一个工程」用） */
const BACKUP_KEY = 'hmi-designer-prev-project-v1';

/* ── 「保存」写回同一个文件（File System Access API） ──────────────
   浏览器下载是没法覆盖原文件的（同名会变成「名字 (1).json」），所以：
     · 支持 showSaveFilePicker（Chrome/Edge + http://127.0.0.1 或 https）：
       「保存」写回上次打开/另存为的那个文件，只有「另存为」才另选文件；
     · 不支持（Firefox / 用局域网 IP 访问 / file:// 直开）：退回下载，
       并且提示用户这次是"下载了一份"，不会假装是覆盖。 */
let fileHandle = null;                       // 当前工程对应的文件句柄
const JSON_TYPES = [{ description: 'HMI 工程文件', accept: { 'application/json': ['.json'] } }];
const canPick = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

/** 文件名里不能有的字符换掉（工程名是随手输入的，别把下载/选择器搞崩） */
function safeName(n) {
  return String(n || 'hmi-project').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'hmi-project';
}
function plainFileName() { return `${safeName(project.data?.meta?.name)}.json`; }
function datedFileName() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${safeName(project.data?.meta?.name)}-${d}.json`;
}

/** 写进一个文件句柄（权限被回收时再要一次；拿不到就抛错让上层退回「另存为」） */
async function writeHandle(h) {
  if (h.queryPermission) {
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted') p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') throw new Error('没拿到写这个文件的权限');
  }
  const w = await h.createWritable();
  await w.write(JSON.stringify(project.data, null, 2));
  await w.close();
}

/** 立刻把当前工程写进本地缓存（状态栏那句「已自动保存 …」就是它） */
function writeCache() {
  try {
    const json = JSON.stringify(project.data);
    localStorage.setItem(LS_KEY, json);
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    lastSaveAt = Date.now();
    lastBytes = json.length;
    // 内嵌图片是 base64，工程一大就容易撞 localStorage 5MB 上限 → 明确提示别以为存上了
    const mb = (json.length / 1048576).toFixed(1);
    const el = document.getElementById('stSave');
    if (el) el.textContent = `已自动保存 ${t}（${mb}MB）`;
    return true;
  } catch (e) {
    const el = document.getElementById('stSave');
    if (el) el.textContent = '自动保存失败：浏览器存储已满，请导出工程 JSON';
    console.error('[storage]', e);
    return false;
  }
}

const autoSave = debounce(writeCache, 800);

/** 有改动还没落盘（防抖 800ms 还没到）。关窗口/刷新前用它决定要不要抢写一次 */
let dirty = false;
function markDirty() { dirty = true; autoSave(); }

/** 上次自动保存的时间/体积（状态栏那句「已自动保存 …」点开看详情用） */
let lastSaveAt = 0;
let lastBytes = 0;

export const storage = {
  init() {
    bus.on('project:changed', markDirty);
    bus.on('mode:changed', ({ mode }) => { if (mode === 'edit') markDirty(); });
    // 防抖那 800ms 还没到就刷新 / 关窗口（现场最常见的动作：拖完面板顺手按 F5）
    // → 走之前把改动写下去。不补这一步，那一下改动就白做了
    // （以前面板布局是同步写 localStorage 的，所以只有它会丢；现在布局也在工程数据里）
    const flushOnLeave = () => { if (dirty) { dirty = false; writeCache(); } };
    window.addEventListener('pagehide', flushOnLeave);
    window.addEventListener('beforeunload', flushOnLeave);
  },

  /** 立刻写一份本地缓存（不等 800ms 防抖）：
   *  启动时「从服务器自动读回来」的那份要当场落进浏览器，免得后端一断线手里什么都没有 */
  cacheNow() { dirty = false; return writeCache(); },

  /**
   * 自动保存到底存在哪（状态栏那句「已自动保存…」点开就是这些）。
   * 一句话：**存在这台设备的浏览器里**（localStorage 的站点数据），不是文件、也不在服务器上；
   * 换浏览器 / 换端口 / 换 IP 访问都是各自一份。
   */
  saveInfo() {
    let bytes = lastBytes;
    try { bytes = (localStorage.getItem(LS_KEY) || '').length || bytes; } catch { /* 忽略 */ }
    const backup = this.backupInfo();
    return {
      origin: (typeof location !== 'undefined' ? location.origin : ''),
      key: LS_KEY,
      bytes,
      mb: (bytes / 1048576).toFixed(2),
      limitMb: 5,
      lastAt: lastSaveAt,
      backupKey: BACKUP_KEY,
      backup,
    };
  },

  /** 下载一份工程文件（fileName 不给就带日期）。返回文件名。 */
  exportFile(fileName) {
    const name = fileName || datedFileName();
    const blob = new Blob([JSON.stringify(project.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);   // 必须在 DOM 内，游离锚点的下载在 Chromium 不可靠
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    return name;
  },

  /* ── 保存 / 另存为 / 打开（能写回同一个文件就写回） ── */
  canSaveInPlace() { return canPick(); },
  currentFile() { return fileHandle ? fileHandle.name : ''; },
  /** 换工程/退出当前文件时忘掉句柄（新建、读服务器之后「保存」要重新问存哪） */
  forgetFile() { fileHandle = null; },

  /**
   * 保存：有当前文件就写回它；没有（新工程/不支持）就当「另存为」。
   * @returns {Promise<{name:string, inPlace?:boolean, download?:boolean}>}
   */
  async save() {
    if (fileHandle) {
      try {
        await writeHandle(fileHandle);
        return { name: fileHandle.name, inPlace: true };
      } catch (e) {
        fileHandle = null;          // 句柄失效（权限没了/文件被挪走）→ 退回另存为
      }
    }
    return this.saveAs();
  },

  /** 另存为：选一个新的文件（浏览器不支持选择器就退回下载） */
  async saveAs() {
    if (canPick()) {
      const h = await window.showSaveFilePicker({ suggestedName: datedFileName(), types: JSON_TYPES });
      await writeHandle(h);
      fileHandle = h;
      return { name: h.name, picked: true };
    }
    return { name: this.exportFile(plainFileName()), download: true };
  },

  /** 用系统文件选择器打开工程（顺便记住句柄，之后「保存」就写回这个文件） */
  async pickAndOpen() {
    const [h] = await window.showOpenFilePicker({ multiple: false, types: JSON_TYPES });
    const file = await h.getFile();
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.pages) || !data.meta) throw new Error('不是有效的工程文件');
    this.replaceProject(data, '打开工程');
    fileHandle = h;
    return { data, name: h.name };
  },

  /* ── 换工程时的「后悔药」：新建/打开都会先把当前工程备份一份 ── */
  backupCurrent() {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(project.data));
      return true;
    } catch (e) {
      console.warn('[storage] 备份上一个工程失败（可能存储已满）', e);
      return false;
    }
  },
  /** 备份的概况（没有备份返回 null） */
  backupInfo() {
    try {
      const d = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
      if (!d || !Array.isArray(d.pages)) return null;
      return { name: d.meta?.name || '未命名', pages: d.pages.length, vars: (d.variables || []).length };
    } catch { return null; }
  },
  hasBackup() { return !!this.backupInfo(); },
  /** 恢复上一个被替换掉的工程（恢复前也把当前这份备份，来回切不丢） */
  restoreBackup() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null'); } catch { data = null; }
    if (!data || !Array.isArray(data.pages)) return null;
    this.backupCurrent();
    project.replaceData(data);
    project.commit('恢复上一个工程');
    return data;
  },

  /**
   * 替换整个工程（新建 / 打开都走这里）：**先备份当前工程**再换，
   * 不然新建一个空工程就把原来那份覆盖没了（localStorage 也被自动保存刷掉）。
   * @param {{backup?:boolean}} [opts] backup:false = 别备份（当前这份只是"没动过的默认演示工程"时，
   *   存下来只会把「恢复上一个工程」里真正有用的那份顶掉）
   */
  replaceProject(data, label = '打开工程', opts = {}) {
    if (opts.backup !== false) this.backupCurrent();
    fileHandle = null;                  // 换工程了：保存要重新问存哪个文件（打开时由 pickAndOpen 再设回来）
    project.replaceData(data);
    project.commit(label);
    return data;
  },

  /** 打开工程文件 */
  importFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const data = JSON.parse(fr.result);
          if (!Array.isArray(data.pages) || !data.meta) throw new Error('不是有效的工程文件');
          this.replaceProject(data, '打开工程');
          resolve(data);
        } catch (e) { reject(e); }
      };
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file, 'utf-8');
    });
  },
};
