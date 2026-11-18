/**
 * runUpdate.js — 运行画面（客户机 /run）右下角的「有新版本」提示 + 一键更新
 *
 * 现场要求：运行画面平时保持干净，**只有真的有新版本时**才在右下角出现一个小徽标
 *   「⬆ 新版本 V2.2.0」；点它弹出本次更新说明和「立即更新」按钮，点一下就地更新
 *   （下载代码包 → 覆盖 → 后端自己重启 → 本页自动刷新）。
 *   · 没有新版本 / 更新检查被关掉 / 连不上更新服务器 → **什么都不显示**（绝不打扰现场）。
 *   · 只在只读运行页（body.run-only）挂；编辑器页面有自己的状态栏更新提示（updateCheck.js）。
 *
 * 为什么复用 editor/updateCheck.js 那一套之外再写一遍：
 *   /run 页面**不加载 editor/* 模块**（客户机摸不到改东西的入口），所以不能 import 它；
 *   这里只用 backend 的 checkUpdate/applyUpdate 两个接口，逻辑比编辑器那版精简。
 */
import { backend } from '../api/backend.js';
import { bus } from '../core/eventBus.js';
import { tr } from '../core/i18n.js';

const INIT_DELAY_MS = 3000;       // 启动后等等再查（别和工程加载抢启动那几秒）
const RECHECK_MS = 6 * 3600e3;    // 之后这么久再查一次（后端自己有 6 小时缓存，不会给更新服务器添乱）

let badge = null;
let panel = null;
let lastResult = null;
let started = false;
let checking = false;

// 「忽略此版本」：记在本机（localStorage）—— 这一版就不再提示；出了更新的版本还会提示。
// 现场口径（m02900）：不想升的那一版，点「忽略」之后别再来烦；版本号变了说明有新内容，照旧提示。
const IGNORE_KEY = 'hmi.run.updateIgnored';
function ignoredVer() {
  try { return localStorage.getItem(IGNORE_KEY) || ''; } catch { return ''; }
}
function setIgnoredVer(v) {
  try {
    if (v) localStorage.setItem(IGNORE_KEY, String(v));
    else localStorage.removeItem(IGNORE_KEY);
  } catch { /* 隐私模式：记不住就算了 */ }
}

function verShort(v) {
  return v && v.version ? `V${v.version}` : '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badgeText(r) {
  return '⬆ ' + tr('新版本') + ' ' + verShort(r.remote) + ' ' + tr('点此更新');
}

function ensureBadge() {
  if (badge && badge.isConnected) return badge;
  badge = document.createElement('button');
  badge.id = 'rtUpdBadge';
  badge.type = 'button';
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:60002;display:none;'
    + 'height:30px;padding:0 12px;border:1px solid rgba(217,119,6,.6);border-radius:6px;cursor:pointer;'
    + 'background:rgba(180,83,9,.9);color:#fff;font-size:12.5px;font-weight:600;'
    + 'box-shadow:0 4px 14px rgba(0,0,0,.35);backdrop-filter:blur(4px)';
  badge.addEventListener('click', () => { if (panel) closePanel(); else openPanel(); });
  // ★ 挂进 #runtimeRoot（z-index 100000 的层）而不是 body：运行页的提示条/软键盘都在这个层里，
  //   挂 body 会被它们整层压住（徽标看得见但点不到）。层内 z 60002 > 右下角提示条 60000。
  (document.getElementById('runtimeRoot') || document.body).appendChild(badge);
  return badge;
}

/** 徽标显示在右下角；那个角要是被「服务器上还没有工程」提示条占着，就往上让一让（别互相压） */
function badgeBottomPx() {
  let bottom = 12;
  const notice = document.getElementById('rtNotice');
  if (notice && !notice.classList.contains('hidden')) {
    const r = notice.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) bottom = Math.round(window.innerHeight - r.top + 8);
  }
  return bottom;
}

function closePanel() {
  if (panel) {
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }
}

function closeAll() {
  closePanel();
  if (badge) badge.style.display = 'none';
}

/** 更新进度（面板里一行） */
function progress(html, replace) {
  const box = panel && panel.querySelector('[data-upd-progress]');
  if (!box) return;
  if (replace) box.innerHTML = html;
  else box.insertAdjacentHTML('beforeend', `<div style="margin:3px 0">${html}</div>`);
}

function paintBadge(r) {
  lastResult = r || null;
  const show = !!(r && r.available && r.remote && verShort(r.remote));
  if (!show) { closeAll(); return; }   // 没有新版本就**连元素都不建**（画面保持干净）
  // 这一版已经点过「忽略此版本」→ 不显示（换更新的版本号时会重新提示）
  if (ignoredVer() === String(r.remote.version)) { closeAll(); return; }
  ensureBadge();
  badge.textContent = badgeText(r);
  badge.title = (r.remote.notes || '') + '\n' + tr('点击查看更新说明并更新');
  badge.style.bottom = badgeBottomPx() + 'px';
  badge.style.display = 'block';
}

function openPanel() {
  const r = lastResult;
  if (!r || !r.available || !r.remote) return;
  closePanel();
  const rv = r.remote;
  const lv = r.local || backend.version || {};
  const panelEl = document.createElement('div');
  panelEl.id = 'rtUpdPanel';
  const bRect = badge ? badge.getBoundingClientRect() : null;
  const pBottom = bRect && bRect.top > 40 ? Math.round(window.innerHeight - bRect.top + 8) : 50;
  panelEl.style.cssText = 'position:fixed;right:12px;bottom:' + pBottom + 'px;z-index:60003;'
    + 'width:min(420px,calc(100vw - 24px));'
    + 'max-height:min(68vh,560px);overflow:auto;background:#232831;border:1px solid rgba(255,255,255,.18);'
    + 'border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.5);color:#e5e7eb;font-size:13px;padding:12px 14px';
  const canApply = backend.supports && backend.supports('update_apply');
  panelEl.innerHTML = `<div style="font-weight:600;font-size:14px;margin-bottom:6px">`
    + `${esc(tr('发现新版本'))} <span style="color:#fbbf24">${esc(verShort(rv))}</span>`
    + `${rv.date ? ` <span style="color:#9ca3af;font-weight:400">${esc(rv.date)}</span>` : ''}</div>`
    + `<div style="color:#9ca3af;margin-bottom:8px">${esc(tr('当前版本'))} ${esc(verShort(lv) || tr('未知'))}</div>`
    + `<div style="white-space:pre-wrap;line-height:1.55;margin:6px 0 10px">${rv.notes ? esc(rv.notes) : esc(tr('（这一版没有写更新说明）'))}</div>`
    + `<div data-upd-progress style="margin:8px 0 0"></div>`
    + `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">`
    + `<button type="button" data-upd-later style="height:30px;padding:0 12px;border-radius:6px;cursor:pointer;`
    + `border:1px solid rgba(255,255,255,.22);background:transparent;color:#e5e7eb">${esc(tr('稍后'))}</button>`
    + `<button type="button" data-upd-ignore title="${esc(tr('这一版不再提示；出了更新的版本会再提示'))}" `
    + `style="height:30px;padding:0 12px;border-radius:6px;cursor:pointer;`
    + `border:1px solid rgba(255,255,255,.22);background:transparent;color:#9ca3af">${esc(tr('忽略此版本'))}</button>`
    + `<button type="button" data-upd-go ${canApply ? '' : 'disabled'} style="height:30px;padding:0 14px;border-radius:6px;`
    + `cursor:pointer;border:none;background:${canApply ? '#d97706' : '#4b5563'};color:#fff;font-weight:600">`
    + `${esc(canApply ? tr('立即更新') : tr('后端需重启后才能更新'))}</button></div>`;
  (document.getElementById('runtimeRoot') || document.body).appendChild(panelEl);
  panel = panelEl;  panelEl.querySelector('[data-upd-later]').addEventListener('click', closePanel);
  // 「忽略此版本」：记住版本号、收起徽标；下一版发布后自动再提示（paintBadge 里按版本号比对）
  panelEl.querySelector('[data-upd-ignore]').addEventListener('click', () => {
    const v = lastResult && lastResult.remote && lastResult.remote.version;
    if (v) setIgnoredVer(v);
    closeAll();
  });
  const go = panelEl.querySelector('[data-upd-go]');
  if (canApply) go.addEventListener('click', () => applyUpdate(r, go));
  // 点面板/徽标以外的地方关掉面板
  setTimeout(() => {
    document.addEventListener('click', (e) => {
      if (!panel) return;
      if (panel.contains(e.target) || (badge && badge.contains(e.target))) return;
      closePanel();
    }, true);
  }, 0);
}

async function waitBackendNew(toVersion, fromVersion) {
  // 后端更新完会自己退出再重启；这期间连 HTTP 都没有，只能等**长连接自己重连上**
  // （和编辑器 updateCheck.js 的 waitBackendBack 同一套逻辑，这里只是不 import editor/*）。
  const t0 = Date.now();
  const deadline = t0 + 90000;
  const grace = t0 + 12000;   // 前 12 秒看到旧版本号是正常的（进程还在重启）
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    if (!backend.isOnline || !backend.isOnline()) {
      if (backend.probe) backend.probe(1500).catch(() => null);
      continue;
    }
    const v = (backend.version && (backend.version.version || backend.version)) || backend.build || '';
    if (toVersion && v === toVersion) return { kind: 'new', version: v };
    if (fromVersion && v === fromVersion && Date.now() > grace) return { kind: 'old', version: v };
  }
  return { kind: 'timeout', version: '' };
}

async function applyUpdate(r, btn) {
  const toV = (r.remote && r.remote.version) || '';
  const fromV = (r.local && r.local.version) || (backend.version && backend.version.version) || '';
  if (btn) { btn.disabled = true; btn.textContent = tr('正在更新…'); }
  progress(esc(tr('正在让后端下载新版本代码包…（看网络，通常几秒到十几秒）')), true);
  let res;
  try {
    res = await backend.applyUpdate();
  } catch (e) {
    progress(`<b style="color:#f87171">${esc(tr('请求没成功'))}：${esc(e && e.message || e)}</b> `
      + esc(tr('（服务可能正在重启，稍等一会儿刷新页面看看）')), true);
    if (btn) { btn.disabled = false; btn.textContent = tr('再试一次'); }
    return;
  }
  if (!res || !res.ok) {
    const msg = (res && res.error) || '';
    // 后端发完响应就退出：连接被掐（"后端正在重启（更新已开始）"）不是失败，继续等它回来
    if (!/重启/.test(msg)) {
      progress(`<b style="color:#f87171">${esc(msg || tr('没有更新'))}</b>`, true);
      if (btn) { btn.disabled = false; btn.textContent = tr('再试一次'); }
      return;
    }
  }
  progress(`${esc(tr('已更新到'))} <b>${esc(verShort({ version: res.to_version || toV }))}</b>`
    + (res.copied ? `（${esc(String(res.copied))} ${esc(tr('个文件'))}）` : ''), true);
  progress(esc(tr('正在重启服务…')), false);
  const back = await waitBackendNew(res.to_version || toV, res.from_version || fromV);
  if (back.kind === 'new') {
    progress(`<b style="color:#4ade80">${esc(tr('更新成功'))}</b>，${esc(tr('正在刷新页面…'))}`, false);
    try { sessionStorage.setItem('hmi.update.done', back.version); } catch { /* 隐私模式 */ }
    setTimeout(() => { try { location.reload(); } catch { /* 忽略 */ } }, 1500);
  } else if (back.kind === 'old') {
    progress(`<b style="color:#fbbf24">${esc(tr('更新失败，已自动回滚'))}</b>：${esc(tr('现在还是'))} `
      + `${esc(verShort({ version: back.version }))}，${esc(tr('画面照常能用。'))}`, false);
    if (btn) { btn.disabled = false; btn.textContent = tr('再试一次'); }
  } else {
    progress(`<b style="color:#f87171">${esc(tr('更新之后服务没能起来'))}</b>`
      + `${esc(tr('（等了 90 秒没应答）请在这台机器上重新启动服务。'))}`, false);
    if (btn) { btn.disabled = false; btn.textContent = tr('再试一次'); }
  }
}

/** 查一次更新并刷新右上角的徽标；失败静默（现场没外网是常态） */
export async function refreshRunUpdate(force) {
  if (checking) return lastResult;
  if (!backend.supports || !backend.supports('update_check')) return null;
  checking = true;
  try {
    const r = await backend.checkUpdate(!!force);
    paintBadge(r);
    return r;
  } catch {
    return lastResult;
  } finally {
    checking = false;
  }
}

/** 只读运行页启动时挂上：先等一会儿再查，之后定时查；切回前台时若太久没查也补一次 */
export function initRunUpdateBadge() {
  if (started) return;
  if (!document.body.classList.contains('run-only')) return;   // 编辑器预览不挂（编辑器有自己的状态栏提示）
  started = true;
  setTimeout(() => { refreshRunUpdate(false); }, INIT_DELAY_MS);
  setInterval(() => { refreshRunUpdate(false); }, RECHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshRunUpdate(false);
  });
  // 切语言时徽标文字跟着变（徽标一直是同一份，不重建）
  bus.on('i18n:lang', () => { if (lastResult && lastResult.available && lastResult.remote) paintBadge(lastResult); });
}
