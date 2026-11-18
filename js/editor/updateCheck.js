/**
 * updateCheck.js — 当前版本显示 + 「有新版本」提示（**只在编辑器页面初始化**）
 *
 * 只做两件事，**不下载、不覆盖、不重启**：
 *   1. 状态栏常显当前版本号（现场报问题第一句就是「你那是哪个版本」）
 *   2. 有新版本时在状态栏挂一个琥珀色徽标「⬆ 有新版本 Vx.y.z」＋ 启动时飘一句话
 *
 * 为什么刻意不做自动更新（见 server.py 里的同一段说明）：
 *   · 现场机器上可能正跑着画面；server/data 里是**现场数据**（工程/变量/报警记录），
 *     自动 git pull 会连它一起冲掉；
 *   · 客户机常常没有外网、没装 git —— 自动更新在那种机器上只会变成一堆失败弹窗。
 *   所以这里到「提示」为止，更新动作交给人（管理员拉新版代码后重启服务）。
 *
 * 失败策略（重要）：**自动检查失败就彻底安静** —— 只把原因写进版本号的鼠标提示里。
 *   现场没外网是常态，每次开编辑器弹一句「检查更新失败」纯属添乱。
 *   只有人主动点「检查更新…」时才把失败原因弹出来说清楚。
 */
import { backend } from '../api/backend.js';
import { bus } from '../core/eventBus.js';
import { statusNote } from '../core/utils.js';

const SEEN_KEY = 'hmi.update.seenVersion';   // 已经提醒过的远端版本号：同一个版本不再飘提示
const BOOT_DELAY_MS = 3000;                  // 启动后多久查（别和工程加载、后端探测抢启动那几秒）

let _started = false;

/** 远端来的文字要转义：更新说明是**远端内容**，不能当 HTML 直接塞进对话框 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 版本号：徽标/提示条上只写 V1.0.3（短），日期和说明留给鼠标提示与对话框 ——
 *  状态栏就那么宽，一行里塞「版本+日期+说明+一句引导」会挤成一团看不清 */
function verShort(v) {
  return v ? `V${v.version || '?'}` : '未知';
}

function verText(v) {
  return v ? `V${v.version || '?'}${v.date ? `（${v.date}）` : ''}` : '未知';
}

/** 当前版本信息：/api/health 那份（带 build）和检查结果里那份（带更新源）合起来用 ——
 *  两边字段不完全一样，只认一边就会「鼠标提示里有时有 build、有时没有」*/
function localVersion(r) {
  return { ...(backend.version || {}), ...((r && r.local) || {}) };
}

/** 版本号的鼠标提示：把「本地/远端/检查结果」一次说清 —— 界面上不占地方，鼠标停上去全都有 */
function versionTitle(r) {
  const v = localVersion(r);
  const lines = [`当前版本：${verText(v)}`];
  if (v?.notes) lines.push(`本版说明：${v.notes}`);
  if (v?.build) lines.push(`build ${v.build}`);
  if (r) {
    if (r.state === 'disabled') lines.push('更新检查：已关闭（HMI_UPDATE_URL 为空）');
    else if (r.available) lines.push(`发现新版本：${verText(r.remote)}`, r.remote?.notes ? `新版说明：${r.remote.notes}` : '');
    else if (r.state === 'local_newer') lines.push(`远端还是 ${verText(r.remote)}（本地更新，没推送 / 或远端回滚过）`);
    else if (r.state === 'same') lines.push('已是最新版本');
    else lines.push(`检查更新失败：${r.error || '未知原因'}（现场没外网就会这样，不影响使用）`);
    if (r.stale) lines.push('⚠ 这是上次成功检查的结果（这次没连上更新服务器）');
    // 更新源地址不在这儿显示（维护者要看就调 /api/update/check，那里的 source 字段有）
  } else {
    lines.push('（更新检查结果还没回来）');
  }
  lines.push('点这里 = 检查更新');
  return lines.filter(Boolean).join('\n');
}

/** 画状态栏上的两个元素（版本号 + 「有新版本」徽标）。任何一步 DOM 不在都不报错（页面缓存旧 HTML 时）*/
function paint(r) {
  const verEl = document.getElementById('stVersion');
  if (verEl) {
    const v = localVersion(r);
    if (v && v.version) {
      verEl.textContent = `V${v.version}`;
      verEl.title = versionTitle(r);
      verEl.classList.remove('hidden');
    }
    // 拿不到版本（后端是旧版本 / 后端没起）→ 整个元素不显示，别在状态栏挂一个「V?」
  }
  const upEl = document.getElementById('stUpdate');
  if (!upEl) return;
  const show = !!(r && r.available && r.remote);
  upEl.classList.toggle('hidden', !show);
  if (!show) { upEl.textContent = ''; return; }
  upEl.textContent = `⬆ 有新版本 ${verShort(r.remote)}`;
  upEl.title = `有新版本：${esc(r.remote.notes || '（无说明）')}\n`
    + `当前 ${verText(r.local)} → 最新 ${verText(r.remote)}`
    + (r.stale ? '\n⚠ 这是上次成功检查的结果（这次没连上更新服务器）' : '')
    + '\n点一下看更新说明，可以直接在这台机器上更新（服务会自动重启）';
  upEl.classList.toggle('stale', !!r.stale);
}

/** 启动时那一句提示：同一个远端版本只飘一次（飘过就记下来，别每次开编辑器都念一遍）*/
function announceOnce(r) {
  if (!r?.available || !r.remote?.version) return;
  let seen = '';
  try { seen = localStorage.getItem(SEEN_KEY) || ''; } catch { /* 隐私模式/禁用存储：那就每次都飘 */ }
  if (seen === r.remote.version) return;
  try { localStorage.setItem(SEEN_KEY, r.remote.version); } catch { /* 忽略 */ }
  statusNote(`发现新版本 ${verShort(r.remote)}（当前 ${verShort(r.local)}）· 点状态栏上的「⬆ 有新版本」看说明`, 15000);
}

/** 对话框：**只讲这次更新了什么** —— 当前版本、新版本号与日期、更新说明、以及「立即更新」按钮。
 *  流程细节（下载→覆盖→重启→回滚）、更新源地址、仓库链接都不摆在这儿：
 *  混在更新说明里只会让人看不清"到底改了什么"（维护者要看这些就调 /api/update/check）。 */
function showUpdateDialog(r, manual) {
  import('./toolbar.js').then(({ showDialog }) => {
    const lv = localVersion(r);
    const rv = (r && r.remote) || null;
    const rows = [];
    rows.push(`<div class="dlg-hint">当前版本：<b>${esc(verText(lv))}</b></div>`);

    if (!r) {
      rows.push('<div>还没查到更新检查的结果（后端可能没启动 / 是旧版本）。稍后再点一次。</div>');
    } else if (r.state === 'disabled') {
      rows.push('<div>更新检查是关掉的。</div>');
    } else if (r.available && rv) {
      rows.push(`<div style="margin:10px 0 4px"><b style="color:#d97706;font-size:15px">新版本 ${esc(verShort(rv))}</b>`
        + (rv.date ? ` <span style="color:#6b7280">${esc(rv.date)}</span>` : '')
        + (r.stale ? ' <span style="color:#6b7280">（上次成功检查的结果）</span>' : '') + '</div>');
      // 对话框里**只讲这次更新了什么** —— 流程细节、更新源地址、仓库链接都不摆在这儿
      // （那些是维护者的事，混在更新说明里只会让人看不清"到底改了什么"）
      rows.push(rv.notes
        ? `<div style="margin:6px 0;white-space:pre-wrap">${esc(rv.notes)}</div>`
        : '<div style="margin:6px 0;color:#6b7280">（这一版没有写更新说明）</div>');
    } else if (r.state === 'local_newer') {
      rows.push(`<div>已经是最新的（远端 ${esc(verText(rv))}）—— 本机这套更新。</div>`);
    } else if (r.state === 'same') {
      rows.push('<div>已经是最新版本。</div>');
    } else {
      rows.push(`<div style="color:#dc2626">没查到：${esc(r.error || '未知原因')}</div>`
        + '<div style="margin-top:4px">现场机器没有外网时就会这样 —— <b>不影响使用</b>。</div>');
    }

    // 「立即更新」按钮：只在这一版后端支持时才给（老后端没这个接口 → 让它先重启后端）
    const canApply = r?.available && backend.supports('update_apply');
    if (r?.available && !canApply) {
      rows.push('<div style="margin-top:8px;color:#dc2626">这台机器的后端是旧版本，'
        + '请先重启一次服务，之后「立即更新」就能用了。</div>');
    }
    rows.push('<div id="updPanel" style="margin-top:12px"></div>');
    if (canApply) {
      rows.push('<div style="margin-top:12px">'
        + '<button type="button" id="updGo" class="tb-btn" '
        + 'style="padding:6px 14px;font-weight:600">立即更新到 ' + esc(verShort(rv)) + '</button>'
        + '</div>');
    }

    const dlg = showDialog({
      title: manual ? '检查更新' : '有新版本可用',
      body: rows.join(''),
      okText: '关闭',
      wide: true,
    });
    if (canApply) {
      const btn = document.getElementById('updGo');
      if (btn) btn.addEventListener('click', () => runApply(r, dlg));
    }
  }).catch(e => alert('打不开对话框：' + (e?.message || e)));
}

/** 更新进度往对话框里追加一行（用户看得见每一步，而不是干等一个转圈）*/
function progress(html, append = true) {
  const box = document.getElementById('updPanel');
  if (!box) return;
  const line = document.createElement('div');
  line.style.margin = '3px 0';
  line.innerHTML = html;
  if (append) box.appendChild(line);
  else box.innerHTML = html;
}

/** 点「立即更新」之后的整个流程：下载 → 覆盖 → 重启 → 等回来 → 刷新页面。
 *  ⚠ 后端发完响应就退出了：这里必须"等它回来"，不能把断线当失败 */
async function runApply(r, dlg) {
  const btn = document.getElementById('updGo');
  const to = r.remote?.version || '';
  const from = r.local?.version || '';
  if (btn) { btn.disabled = true; btn.textContent = '正在更新…'; }
  progress('正在让后端下载新版本代码包…（约 5MB，看网络）', false);

  let res;
  try {
    res = await backend.applyUpdate();
  } catch (e) {
    progress(`<b style="color:#dc2626">请求没成功：${esc(e?.message || e)}</b>（服务可能已经在自己重启，稍等一下刷新页面看看）`);
    if (btn) { btn.disabled = false; btn.textContent = '再试一次'; }
    return;
  }
  if (!res.ok) {
    progress(`<b style="color:#dc2626">没有更新：${esc(res.error || '未知原因')}</b>`);
    if (btn) { btn.disabled = false; btn.textContent = '再试一次'; }
    return;
  }
  progress(`已更新到 <b>V${esc(res.to_version)}</b>（${res.copied} 个文件）`);
  progress('正在重启服务…');
  const back = await waitBackendBack(res.to_version, res.from_version);
  if (back.kind === 'new') {
    progress(`<b style="color:#16a34a">更新成功</b>，正在刷新页面…`);
    try { sessionStorage.setItem('hmi.update.done', back.version); } catch { /* 隐私模式 */ }
    setTimeout(() => location.reload(), 1500);
  } else if (back.kind === 'old') {
    progress(`<b style="color:#d97706">更新失败，已自动回滚</b>：现在是 V${esc(back.version)}，画面照常能用。`
      + `<br>详情见 <code>logs\\update-${todayStr()}.log</code>`);
    if (btn) { btn.disabled = false; btn.textContent = '再试一次'; }
  } else {
    progress(`<b style="color:#dc2626">更新之后服务没能起来</b>（等了 ${Math.round(WAIT_RESTART_MS / 1000)} 秒没应答）`
      + `<br>请在这台机器上：① 看 <code>logs\\update-${todayStr()}.log</code> 的原因；`
      + `② 重新双击 <code>start_server.bat</code> 或 <code>start_hmi_window.bat</code>`);
    if (btn) { btn.disabled = false; btn.textContent = '再试一次'; }
  }
}

/** 真去查一次。force=true 忽略后端缓存（人主动点的时候用）*/
async function refresh(force) {
  const r = await backend.checkUpdate(force);
  paint(r);
  return r;
}

/** 「检查更新…」菜单入口：人主动点的 → 不管成没成都要弹出来交代清楚 */
export async function checkUpdateNow() {
  const verEl = document.getElementById('stVersion');
  const upEl = document.getElementById('stUpdate');
  const old = upEl?.textContent;
  if (upEl) upEl.textContent = '正在检查…';
  try {
    const r = await refresh(true);
    if (r.available) announceOnce(r);
    showUpdateDialog(r, true);
    return r;
  } catch (e) {
    showUpdateDialog({
      state: 'error', error: (e?.message || String(e)), local: backend.version,
      remote: null, available: false, source: '',
    }, true);
    return null;
  } finally {
    if (upEl && !upEl.classList.contains('hidden') && old && upEl.textContent === '正在检查…') upEl.textContent = old;
    paint(backend.update);
    if (verEl) verEl.classList.remove('hidden');
  }
}

/** 等后端重启回来。三种结果：
 *    new     = 已经是新版本（更新成功）
 *    old     = 还是旧版本（助手自动回滚了，或重启没换成新代码）
 *    timeout = 一直没有应答（服务没起来 —— 要人工介入，界面给出手把手指令）
 *  ⚠ 这段期间后端**本来就不在**，请求失败是正常的，不能当错误报出来 */
const WAIT_RESTART_MS = 90000;
const OLD_GRACE_MS = 12000;      // 刚更新完头 10 来秒里看到旧版本号是正常的（助手还在重启），别急着判回滚

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function waitBackendBack(toVersion, fromVersion) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_RESTART_MS) {
    await new Promise(r => setTimeout(r, 1000));
    // ★ V2：后端重启期间 HTTP 接口也不在了（连 /api/health 都没有），
    //   所以这里等的是**长连接自己重连上**：连通了就说明进程回来了。
    //   build/channel 会在重连的 hello 里刷新，版本号从 backend.version 读。
    if (!backend.isOnline()) {
      backend.probe(1500).catch(() => null);      // 探一下（probe 不发 HTTP：连长连接拿 hello）
      continue;
    }
    const v = backend.version?.version || backend.build || '';
    if (toVersion && v === toVersion) return { kind: 'new', version: v };
    if (fromVersion && v === fromVersion && Date.now() - t0 > OLD_GRACE_MS) {
      return { kind: 'old', version: v };
    }
  }
  return { kind: 'timeout', version: '' };
}

export function initUpdateCheck() {
  if (_started) return;
  _started = true;

  const verEl = document.getElementById('stVersion');
  if (verEl) {
    verEl.classList.remove('hidden');
    verEl.addEventListener('click', () => checkUpdateNow());
  }
  const upEl = document.getElementById('stUpdate');
  if (upEl) upEl.addEventListener('click', () => showUpdateDialog(backend.update, false));

  paint(null);                                    // 先画版本号（后端探测回来后还有一次）
  bus.on('backend:status', () => paint(backend.update));   // 后端上线/掉线 → 版本号跟着变
  // 刚更新完刷新回来的那次：说一句"更新成功"，别让人觉得是自己看错了版本号
  let done = '';
  try { done = sessionStorage.getItem('hmi.update.done') || ''; sessionStorage.removeItem('hmi.update.done'); } catch { /* 忽略 */ }
  if (done) statusNote(`已更新到 V${done}，服务重启完成`, 12000);
  // 后端报告"上次更新失败已回滚"时也说一句（人可能已经离开那个页面了，回来要能看到）
  const last = backend.lastUpdate;
  if (last && last.state === 'rolled_back' && Date.now() - 0) {
    setTimeout(() => {
      if (backend.lastUpdate?.state === 'rolled_back') {
        statusNote(`上次更新失败，已自动回滚到 V${last.from_version || '?'}（详情：logs\\update-*.log）`, 15000);
      }
    }, BOOT_DELAY_MS);
  }
  setTimeout(() => {
    // 后端没起来就不用查了（查也是白拉一次）；起来了才查
    if (backend.isOnline()) refresh(false).then(announceOnce).catch(() => { /* 安静 */ });
    else paint(null);
  }, BOOT_DELAY_MS);
}
