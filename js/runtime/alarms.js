/**
 * alarms.js — 报警引擎（运行态）
 *
 * 一条报警 = 触发条件（变量 + 比较符 + 阈值）+ 内容文字。
 *   内容里可以写 {变量名} 关联变量，触发时替换成当时的值：
 *     主轴转速过高：{rSpeed} m/min（上限 3000）
 *
 * 判定：运行态每 200ms 跑一遍（变量变化时也立刻跑一次）
 *   · 条件成立并持续 delaySec 秒 → 触发（进当前报警 + 记一条历史）
 *   · 条件恢复 → 从当前报警里移除，历史那条补上恢复时间
 *   · 确认（ack）只标记，不参与「是否还在报警」的判定
 *
 * ── 历史记录存哪：**服务器**（server/data/alarm_history.json）──
 *   以前只存 localStorage，结果是：
 *     · 客户机上一体机/PyWebView **每次打开都是新的浏览器 profile** → 记录全没了；
 *     · 换地址（127.0.0.1 ↔ 局域网 IP）、换浏览器打开，都是各自一份 localStorage；
 *   报警记录是现场凭据，所以改成**服务器存档**：任何地址/任何浏览器打开都看到同一份，
 *   后端没开时退回 localStorage 兜底（本地模拟模式），后端回来再把本地那份补传上去。
 *   **环形存储**：两边上限都是 5MB（本文件 MAX_BYTES / 后端 ALARM_CAP_BYTES），
 *   超了就从最早那条开始丢 —— 记录不能无限长把盘占满，但最近的一定留得住。
 *
 *   多客户端（两个页面同时开着）的两条规则，前后端**完全一致**：
 *     1) 同一条报警（key 相同）还没恢复、且起始时间在 DUP_WINDOW_MS 内 → 算同一次触发，
 *        不再记一条（否则两个页面各判一次就是两条重复记录）；
 *     2) 真的新触发一次时，同一条报警还挂着的旧记录补上结束时间。
 *   记录一变就 POST 落盘；写失败先攒在队列里重试（断网/后端重启也不能丢），
 *   同时后端会把它广播给其它打开着的页面（那边按同一套规则去重，不会成环）。
 */
import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { compareVal } from '../core/utils.js';
import { backend } from '../api/backend.js';
import { varStore } from './varstore.js';
import { onTick } from './ticker.js';
import { tr } from '../core/i18n.js';

/** 报警级别：颜色 + 中文名（控件和编辑栏都用它） */
export const ALARM_LEVELS = [
  { v: 'info', t: '提示', color: '#0ea5e9', bg: '#e0f2fe' },
  { v: 'warn', t: '警告', color: '#f59e0b', bg: '#fef3c7' },
  { v: 'alarm', t: '报警', color: '#ef4444', bg: '#fee2e2' },
  { v: 'urgent', t: '紧急', color: '#b91c1c', bg: '#fecaca' },
];
export const levelOf = (v) => ALARM_LEVELS.find(l => l.v === (v || 'alarm')) || ALARM_LEVELS[2];

const LS_KEY = 'hmi-alarm-history';       // 本地兜底（后端没开时用）
const MAX_BYTES = 5 * 1024 * 1024;        // 内存里这份的上限：与后端 ALARM_CAP_BYTES 一致，
                                          // 超了就从最早那条开始丢（环形，现场记录也不能无限长）
const LS_MAX_BYTES = 1024 * 1024;         // localStorage 只缓存最近 ~1MB：5MB 配额还要留给工程
                                          // （工程里嵌 base64 图片很容易到 MB 级，不能让它写不进去）
const TICK_MS = 200;
const DUP_WINDOW_MS = 60000;              // 同一条报警在这个窗口内"还没恢复"的那些算同一次（与后端一致）
const RETRY_MS = 5000;                    // 落盘失败后隔多久重试
const OUTBOX_MAX = 2000;                  // 待落盘队列的上限（后端一直不回来时也不至于吃内存）

let active = [];          // 当前报警：[{key, id, name, text, level, value, at, acked}]
let history = [];         // 历史：[{key, id, name, text, level, value, at, endAt, acked}]
let stopBeat = null;           // 停止节拍的回调（ticker.js 的 onTick）
let running = false;
const pending = new Map();  // key -> 条件首次成立的时间（延时触发用）

/* ── 落盘（服务器为主，localStorage 兜底） ── */
const SIG = r => `${r.key}@${r.at}`;
let outbox = { clear: false, add: [], patch: [] };   // 还没写进后端的那些
let flushing = false;                                 // 正在发（防止并发重入）
let retryAt = 0;                                      // 下次重试时刻（失败后才有值）
let syncOff = false;                                  // 后端明确说不认识这个接口（旧后端）→ 不再试

/* ── 文本里的 {变量名} → 当前值 ──
   ⚠ 变量名**中英文都认**：以前这里只匹配 ASCII（`[A-Za-z_][\w.]*`），
     内容里写 `{温度}`、`{中1[1]}` 的报警触发时会把 `{温度}` 原样显示出来。
     变量名不能含花括号/空白，所以按"不是花括号、不是空白"取。 */
export function fillAlarmText(tpl, fallbackName) {
  // 多语言：先按当前语言翻**模板**（翻译表里存带 {变量} 的整句），再替换 {变量}
  const s = tr(String(tpl ?? '').trim());
  if (!s) return tr(fallbackName || '') || '(未填内容)';
  return s.replace(/\{([^{}\s]+)\}/g, (m, name) => {
    const v = varStore.get(name);
    if (v === undefined || v === null) return '--';
    return typeof v === 'number' ? String(Number(v.toPrecision(6))) : String(v);
  });
}

/**
 * 切语言后：把「当前报警 / 历史」里显示的文字按工程里的报警定义**重填一遍**。
 * 只改界面显示，不往回写服务器（历史记录里存的是记下那一刻的文字，各客户端一致）。
 */
export function retranslateAlarms() {
  const defs = new Map((project.alarms() || []).map(a => [a.id, a]));
  const refill = (r) => {
    if (!r) return;
    const a = defs.get(r.key) || defs.get(r.id);
    if (a) {
      r.name = tr(a.name || '');
      r.text = fillAlarmText(a.text, a.name);
      return;
    }
    // 报警定义已经不在了（被删/改了 id，或历史是另一份工程记的）：
    // **直接按翻译表翻记下来的那句** —— 不翻的话，切语言后历史里永远是中文。
    r.name = tr(r.name || '');
    r.text = tr(r.text || '');
  };
  active.forEach(refill);
  history.forEach(refill);
  bus.emit('alarms:changed', { raised: [], cleared: [], i18n: true });
}

/** 条件是否成立 */
export function alarmTriggered(a) {
  if (!a || a.enabled === false) return false;
  const name = a.variable;
  if (!name) return false;
  const v = varStore.get(name);
  if (v === undefined || v === null) return false;
  return compareVal(v, a.op || '>=', a.value);
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    history = Array.isArray(raw) ? ringTrim(raw, MAX_BYTES) : [];
  } catch { history = []; }
}

/* ── 落盘到 localStorage（离线兜底）：只留最近一份，别把配额吃光 ──
 *
 * ⚠ 这里分成「立刻写」和「合并写」两条路，是因为一次落盘在历史攒大之后**非常贵**：
 *   整个数组排序(ringTrim) + 最多 1MB 的 JSON.stringify + 一次**同步**的
 *   localStorage.setItem —— 全在 UI 线程上。历史 3 万条时一次就是几十毫秒。
 *   · 用户明确动一下（清空 / 确认）→ 立刻写，低频，写完就不用管了；
 *   · 每条报警都要走的那个热路径（evalAlarms）→ 合并写：一秒半之内的几十条并成一次。
 *   现场一片报警密集的时候，以前是"每条报警都卡一下、而且历史越长卡得越久"，
 *   这正是「跑几天以后越来越卡」的一大来源。
 *   localStorage 这份只是**后端没开时的兜底**：真正按时间顺序落盘的是服务器那份
 *   （见 queueAdd → flush），所以晚一秒半写进去不影响任何功能；
 *   关页面时还有下面的 pagehide 兜一次。 */
const SAVE_SOON_MS = 1500;
let saveSoonTimer = null;

function writeHistoryNow() {
  if (saveSoonTimer) { clearTimeout(saveSoonTimer); saveSoonTimer = null; }
  try { localStorage.setItem(LS_KEY, JSON.stringify(ringTrim(history, LS_MAX_BYTES))); } catch { /* 忽略 */ }
}
/** 立刻落盘：**只给低频的用户动作**（清空 / 确认）用 */
function saveHistory() { writeHistoryNow(); }
/** 合并落盘：给「每条报警都要走一遍」的热路径用 */
function saveHistorySoon() {
  if (saveSoonTimer) return;                 // 已经排上队了 → 这一次并进去
  saveSoonTimer = setTimeout(() => { saveSoonTimer = null; writeHistoryNow(); }, SAVE_SOON_MS);
}
// 关页面/刷新前补一次，别把合并窗口里那几条丢掉
if (typeof window !== 'undefined') window.addEventListener('pagehide', writeHistoryNow);

/** 一条记录大约占多少字节（缓存住：记录只会在 endAt/acked 上小改，够用）*/
const _lenCache = new WeakMap();
function recLen(r) {
  let n = _lenCache.get(r);
  if (n === undefined) {
    try { n = JSON.stringify(r).length; } catch { n = 200; }
    _lenCache.set(r, n);
  }
  return n;
}
/** 环形截断：按时间排序后，超过 maxBytes 就从**最早**那条开始丢（服务器的 _alarms_save 同一套规则）*/
function ringTrim(list, maxBytes) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return [];
  // ⚠ 快路径：已经按时间升序就不排序。记录本来就是"往后追加"的，绝大多数调用都命中这里；
  //   而几万条时这个 sort 本身要好几毫秒，它却是**每条新报警**都要走一次的（见 evalAlarms）。
  let sorted = true;
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i - 1].at || 0) > (arr[i].at || 0)) { sorted = false; break; }
  }
  const out = sorted ? arr.slice() : arr.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  let bytes = 0;
  for (const r of out) bytes += recLen(r);
  let cut = 0;
  while (bytes > maxBytes && cut < out.length - 1) { bytes -= recLen(out[cut]); cut++; }
  return cut ? out.slice(cut) : out;
}

/** 同一条报警"还没恢复、且算同一次"的那条历史（DUP 窗口内） */
function openRecordOf(key, at) {
  const t = Number(at) || Date.now();
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.key !== key || r.endAt) continue;
    if (Math.abs((r.at || 0) - t) <= DUP_WINDOW_MS) return r;
  }
  return null;
}

/* ─────────── 与服务器同步 ─────────── */

/** 两条记录是不是"同一次报警"：key 相同、都还没恢复、起始时间在 DUP 窗口内 */
function sameOccurrence(a, b) {
  return !!a && !!b && a.key === b.key && !a.endAt && !b.endAt
    && Math.abs((a.at || 0) - (b.at || 0)) <= DUP_WINDOW_MS;
}

/** 服务器上那条记录换掉本地"同一次"的那条：两个页面同时判定时不会各留一条 */
function adoptRecords(list) {
  if (!Array.isArray(list) || !list.length) return false;
  let touched = false;
  list.forEach(srv => {
    if (!srv || !srv.key) return;
    const sig = SIG(srv);
    const mine = history.find(r => SIG(r) === sig);
    if (mine) {
      // 同一条（key + 起始时间都一样）：把服务器上的恢复时间/确认状态补过来
      if (srv.endAt && !mine.endAt) { mine.endAt = srv.endAt; touched = true; }
      if (srv.acked && !mine.acked) { mine.acked = true; touched = true; }
      return;
    }
    // 本地那条"同一次报警"→ 扔掉，用服务器上那条（服务器是准的）
    // ⚠ sameOccurrence 要求"srv 还没恢复"，所以已经恢复的记录不可能匹配上任何一条 ——
    //   这种（补丁类）直接跳过，别白白把整个 history 扫一遍（历史几万条时那不是小钱）。
    if (srv.endAt) {
      history.push({ ...srv });
      touched = true;
      return;
    }
    const before = history.length;
    history = history.filter(r => !sameOccurrence(r, srv));
    if (history.length !== before) touched = true;
    history.push({ ...srv });
    touched = true;
  });
  if (touched) { history = ringTrim(history, MAX_BYTES); saveHistory(); }
  return touched;
}

/** 把服务器回的补丁（恢复时间/确认）落到本地那份上 */
function applyPatches(list) {
  if (!Array.isArray(list) || !list.length) return false;
  let touched = false;
  list.forEach(p => {
    if (!p || !p.key) return;
    const same = history.filter(r => r.key === p.key);
    if (!same.length) return;
    // 优先找同一条（at 对得上），其次找还没恢复的那条，最后退到最新一条
    const tgt = (p.at && same.find(r => (r.at || 0) === p.at))
      || same.filter(r => !r.endAt).slice(-1)[0]
      || same[same.length - 1];
    if (!tgt) return;
    if (p.endAt && !tgt.endAt) { tgt.endAt = p.endAt; touched = true; }
    if (p.acked && !tgt.acked) { tgt.acked = true; touched = true; }
  });
  if (touched) saveHistory();
  return touched;
}

/** 收到后端广播（别的页面记了/补了/清了记录）：本地这份跟着更新，不用刷新页面 */
function onRemote(delta) {
  if (!delta) return;
  let touched = false;
  if (delta.clear) { history = []; touched = true; }
  if (adoptRecords(delta.add)) touched = true;
  if (applyPatches(delta.patch)) touched = true;
  if (touched) bus.emit('alarms:changed', { raised: [], cleared: [] });
}

/** 把队列里的东西写进后端。失败就攒着下次再试（报警记录不能因为一次 POST 失败就丢） */
async function flush() {
  if (syncOff || flushing || !backend.expectsServer()) return;
  if (!outbox.clear && !outbox.add.length && !outbox.patch.length) return;
  flushing = true;
  const payload = { clear: outbox.clear, add: outbox.add.splice(0), patch: outbox.patch.splice(0) };
  try {
    const res = await backend.saveAlarms(payload);
    retryAt = 0;
    outbox.clear = false;      // ⚠ 发成功了必须清掉这个标记：留着的话下一次 flush 会再带一次
                               //   {clear:true}，把刚记的记录又清空（服务器先清再加，等于白记）
    // 服务器说「这次触发已经记过了」→ 拿服务器上那条换掉本地刚记的，两边就一致了
    if (res && res.skipped && res.skipped.length && adoptRecords(res.skipped)) {
      bus.emit('alarms:changed', { raised: [], cleared: [] });
    }
  } catch (e) {
    outbox.clear = outbox.clear || payload.clear;
    outbox.add.unshift(...payload.add);
    outbox.patch.unshift(...payload.patch);
    outbox.add = outbox.add.slice(-OUTBOX_MAX);
    outbox.patch = outbox.patch.slice(-OUTBOX_MAX);
    retryAt = Date.now() + RETRY_MS;
    if (/\b404\b/.test(String(e && e.message))) {
      syncOff = true;      // 后端是旧版本（没这个接口）：说一次就别再打了，本地照常记
      console.warn('[alarm] 后端不认识 /api/alarms（旧版本，重启 server 即可）——报警记录暂时只存本机浏览器');
    }
  } finally {
    flushing = false;
  }
}

function queueAdd(records) {
  if (syncOff || !records?.length) return;
  outbox.add.push(...records.map(r => ({ ...r })));
  outbox.add = outbox.add.slice(-OUTBOX_MAX);
  fire(flush());
}
function queuePatch(patches) {
  if (syncOff || !patches?.length) return;
  outbox.patch.push(...patches);
  outbox.patch = outbox.patch.slice(-OUTBOX_MAX);
  fire(flush());
}
function queueClear() {
  if (syncOff) return;
  outbox.clear = true;
  outbox.add = [];
  outbox.patch = [];
  fire(flush());
}
/** 后台跑的落盘请求：出错只记一条日志，绝不把异常抛到调用方（定时器里抛会变成未捕获异常）*/
function fire(p) { if (p && typeof p.catch === 'function') p.catch(e => console.warn('[alarm] 记录落盘出错', e)); }

/**
 * 进运行态时把服务器那份读回来：换地址/换浏览器/新开的窗口都能看到以前的记录。
 * 本地多出来的那些（上次后端没开时记的）顺手补传上去，两边合成一份。
 */
async function pullFromServer() {
  if (syncOff || !backend.expectsServer()) return false;
  let remote = null;
  try { remote = await backend.loadAlarms(); } catch (e) {
    // ⚠ 以前**只有 404 会吭声**，别的错（长连接断了、后端忙、500）全静默返回 false ——
    //   现场表现就是"换台机器打开，报警历史是空的"，却一点线索都没有。现在一律往控制台说一句。
    const msg = String((e && e.message) || e);
    if (/\b404\b/.test(msg)) {
      syncOff = true;
      console.warn('[alarm] 后端不认识 /api/alarms（旧版本，重启 server 即可）——报警记录暂时只存本机浏览器');
    } else {
      console.warn('[alarm] 读服务器报警记录失败（这次没读到，本地照旧记录）：' + msg);
    }
    return false;
  }
  if (!Array.isArray(remote)) {
    console.warn('[alarm] 服务器上的报警记录不是数组，这次跳过：' + JSON.stringify(remote).slice(0, 120));
    return false;
  }
  // 服务器那份是准的：先摆上它，再把本地多出来的（上次后端没开时记的）并进来 ——
  // 「多出来」= 服务器上没有同一条（key@at 都一样），也不是"同一次报警"的另一条
  //
  // ⚠ 原来这里是 `!remote.some(s => sameOccurrence(s, r))` —— 对每一条本地记录都要把整个
  //   远端数组扫一遍，历史几万条 + 服务器上几万条时就是**上亿次比较**，进运行态直接冻住几秒。
  //   sameOccurrence 要求两边的 key 相同，所以只有"同 key 且还没恢复"的远端记录才可能匹配：
  //   先按 key 建个索引，比较范围就从"全部远端记录"缩到"同一个报警的那几条"，语义完全一样。
  const seen = new Set(remote.map(SIG));
  const openByKey = new Map();
  for (const s of remote) {
    if (!s || !s.key || s.endAt) continue;
    const arr = openByKey.get(s.key);
    if (arr) arr.push(s); else openByKey.set(s.key, [s]);
  }
  const extra = history.filter(r => {
    if (!r.key || seen.has(SIG(r))) return false;
    const cands = openByKey.get(r.key);
    return !cands || !cands.some(s => sameOccurrence(s, r));
  });
  history = ringTrim([...remote.map(r => ({ ...r })), ...extra], MAX_BYTES);
  saveHistory();
  if (extra.length) queueAdd(extra);      // 本地攒下的补上去（迁移/离线期间记的）
  bus.emit('alarms:changed', { raised: [], cleared: [] });
  return true;
}

/** 测试/排查用：现在和后端同步得怎么样 */
export function syncState() {
  return {
    offline: syncOff, queued: outbox.add.length + outbox.patch.length,
    pendingClear: outbox.clear, history: history.length,
  };
}

bus.on('alarms:remote', onRemote);

/* ─────────── 判定 ─────────── */
/** 跑一遍判定。now 可注入（测试用） */
export function evalAlarms(now = Date.now()) {
  if (!running) return { raised: [], cleared: [] };
  const raised = [], cleared = [];
  const list = project.alarms();
  const seen = new Set();
  list.forEach(a => {
    const key = a.id;
    if (!key) return;
    seen.add(key);
    const on = alarmTriggered(a);
    const cur = active.find(x => x.key === key);
    const delayMs = Math.max(0, (+a.delaySec || 0) * 1000);
    if (on) {
      if (cur) { cur.value = varStore.get(a.variable); cur.text = fillAlarmText(a.text, a.name); return; }
      if (delayMs > 0) {
        const since = pending.get(key);
        if (!since) { pending.set(key, now); return; }          // 刚开始计时，再等等
        if (now - since < delayMs) return;
      }
      pending.delete(key);
      const item = {
        key, id: key, name: a.name || '', text: fillAlarmText(a.text, a.name),
        level: a.level || 'alarm', value: varStore.get(a.variable), at: now, acked: false,
      };
      active.push(item);
      // 历史：**同一次报警只记一条**。已经有一条"还没恢复且算同一次"的（服务器上来的、
      // 或另一个页面刚记的）就在它上面更新当时的值，不再追一条重复记录。
      const open = openRecordOf(key, now);
      if (open) {
        open.value = item.value;
        open.text = item.text;
      } else {
        const h = { ...item, endAt: 0 };
        history.push(h);
        history = ringTrim(history, MAX_BYTES);    // 环形：超 5MB 丢最早的（与服务器一致）
        queueAdd([h]);
      }
      raised.push(item);
    } else {
      pending.delete(key);
      if (cur) {
        active = active.filter(x => x.key !== key);
        // 历史里同一 key 尚未恢复的那条补上结束时间
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].key === key && !history[i].endAt) {
            history[i].endAt = now;
            queuePatch([{ key, at: history[i].at, endAt: now }]);
            break;
          }
        }
        cleared.push(cur);
      }
    }
  });
  // 报警表里被删掉的那些：当前报警里也一并清掉
  active = active.filter(x => seen.has(x.key));
  if (raised.length || cleared.length) {
    // ⚠ 这是**每条报警都要走一遍**的热路径 → 走合并落盘（见 saveHistorySoon 的说明）。
    //   用户主动的「清空 / 确认」走 saveHistory()，那两种低频、要立刻落盘。
    saveHistorySoon();
    bus.emit('alarms:changed', { raised, cleared });
  }
  return { raised, cleared };
}

/** 进入运行态时启动 */
export function startAlarms() {
  loadHistory();              // 本地那份先摆上（离线/后端慢也不至于空屏）
  active = [];
  pending.clear();
  days.clear();               // 每次进运行态都从「今天」开始看
  running = true;
  evalAlarms();
  if (stopBeat) { stopBeat(); stopBeat = null; }
  // 走统一节拍器（ticker.js）：延时到点、条件恢复、写服务器失败重试都靠这一拍。
  // 裸 setInterval 在页面被切到后台时会被浏览器降频到 1 秒一次 → 延时报警会晚好几秒。
  stopBeat = onTick(() => {
    try { evalAlarms(); } catch (e) { console.warn('[alarm]', e); }
    if (retryAt && Date.now() >= retryAt) { retryAt = 0; fire(flush()); }   // 上次没写进去：重试
  });
  bus.emit('alarms:changed', { raised: [], cleared: [] });
  pullFromServer().catch(e => console.warn('[alarm] 读服务器记录失败', e));   // 异步：不挡运行态启动
}
export function stopAlarms() {
  running = false;
  if (stopBeat) { stopBeat(); stopBeat = null; }
  pending.clear();
  fire(flush());              // 退出前把还没落盘的记录再推一次
}
export const isRunning = () => running;

/* ── 供控件/测试读取 ── */
export const activeAlarms = () => active.slice();
export const alarmHistory = () => history.slice();
/** 某一天的记录（[from, from+24h)，from = 当天 0 点）。报警历史控件翻页用 */
export function historyOfDay(dayTs) {
  const d = new Date(dayTs || Date.now());
  d.setHours(0, 0, 0, 0);
  const from = d.getTime(), to = from + 86400000;
  return history.filter(x => x.at >= from && x.at < to);
}

/* ── 报警历史控件「正在看哪一天」：按控件 id 记在内存里（不进工程） ── */
const days = new Map();          // widgetId -> 当天 0 点时间戳
function startOfDay(ts) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export const alarmHistoryDay = (id) => days.get(id) || startOfDay(Date.now());
export function setAlarmHistoryDay(id, ts) {
  days.set(id, startOfDay(ts));
  bus.emit('alarms:changed', { raised: [], cleared: [], day: true });
}
export function shiftAlarmHistoryDay(id, deltaDays) {
  setAlarmHistoryDay(id, alarmHistoryDay(id) + deltaDays * 86400000);
}
export const activeCount = () => active.length;
/** 最严重的一条（报警条用）：按级别 urgent > alarm > warn > info，同级取最早的 */
export function worstActive() {
  if (!active.length) return null;
  const rank = { urgent: 3, alarm: 2, warn: 1, info: 0 };
  return active.slice().sort((a, b) =>
    (rank[b.level] ?? 2) - (rank[a.level] ?? 2) || a.at - b.at)[0];
}
export function ackAlarm(key) {
  const a = active.find(x => x.key === key);
  if (a) a.acked = true;
  const h = history.slice().reverse().find(x => x.key === key && !x.acked);
  if (h) {
    h.acked = true;
    queuePatch([{ key, at: h.at, acked: true }]);
  }
  saveHistory();
  bus.emit('alarms:changed', { raised: [], cleared: [] });
}
export function clearHistory() {
  history = [];
  saveHistory();
  queueClear();              // 服务器那份也一起清（否则刷新/换个地址又回来了）
  bus.emit('alarms:changed', { raised: [], cleared: [] });
}
/** 测试/调试用：直接塞一条当前报警 */
export function _pushActive(item) {
  active.push({ key: item.key || `t${active.length + 1}`, acked: false, at: Date.now(), level: 'alarm', ...item });
  bus.emit('alarms:changed', { raised: [], cleared: [] });
}
/** 测试用：等落盘队列发完（离线时立刻返回，不会卡住） */
export async function _waitSync() {
  for (let i = 0; i < 40; i++) {
    if (!flushing && !outbox.add.length && !outbox.patch.length && !outbox.clear) return true;
    retryAt = 0;
    await flush();
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
