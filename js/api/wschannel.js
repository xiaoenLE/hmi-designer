/**
 * wschannel.js — 后端长连接（WebSocket）客户端
 *
 * 为什么要有它
 * ------------
 * 以前前端跟后端全靠 HTTP 一问一答：设备状态每 3 秒问一次、心跳每 10 秒发一次、
 * 全量补读每 30 秒一次、**每次写变量一个 POST**。一个页面一小时一千多个请求，
 * 跑久了两边内存和 CPU 都被这些例行公事吃掉 —— 现场表现就是「越跑越卡」。
 *
 * 现在这些东西全在这一条长连接上双向走，**稳态下一个 HTTP 请求都不发**。
 *
 * 这一层只管「连接」这件事：
 *   · 连上、断了自动重连（退避 + 抖动，别在服务重启时打成一堆）；
 *   · 发消息、按 id 等应答（request/ack 配对，带超时）；
 *   · 看门狗：连接在、但很久没收到任何帧（后端每秒都推设备状态）→ 判定半死，主动重连。
 * 至于「这条连接用来干什么」由 backend.js 决定（订阅变量、写值、登记运行态…）。
 *
 * ⚠ 半死连接（TCP 还在、对端不推了）是长连接的经典坑：光靠 onclose 等不到，
 *   所以必须有看门狗 —— 它替掉了以前那个「每 30 秒全量补读一次」的兜底轮询。
 */
import { bus } from '../core/eventBus.js';

const BACKOFF_MIN = 400;          // 第一次重连等多久
const BACKOFF_MAX = 8000;         // 退避上限
const REQ_TIMEOUT = 6000;         // 一条请求多久没等到 ack 算失败
const OPEN_GRACE = 6000;          // 还没连上时，发消息前先等它握手多久（见 request 的说明）
const STALE_MS = 6000;            // 连接开着但这么久没收到任何帧 → 半死，重连
const WATCH_MS = 1500;            // 看门狗自己的巡检间隔

/** 这条连接本身出问题（断了 / 半死 / 请求超时）——**不是**后端拒绝了这次操作。
 *  调用方据此决定「要不要退回 HTTP 再试一次」：连接问题该退，后端说"地址不对"不该退。 */
export class ChannelDown extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelDown';
    this.channelDown = true;
  }
}

function wsUrl() {
  // http://host:port/... → ws://host:port/api/ws
  const base = location.protocol.startsWith('http')
    ? location.origin
    : 'http://localhost:8866';
  let url = base.replace(/^http/, 'ws') + '/api/ws';
  // 登录 token 带在 URL 上：V2 起前端不发 HTTP，所以那条会话 Cookie 平时用不上；
  // 在页面上登录成功后后端会给一个 token，存起来、重连时带上，
  // 刷新页面/断线重连之后就不用再输一次密码了（见 backend.js 的 login/session）。
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) url += '?token=' + encodeURIComponent(t);
  } catch { /* 隐私模式读不到 localStorage：那就当没登录，不影响用 */ }
  return url;
}

/** 登录 token 存哪儿（前端本地，跟后端会话表对应） */
export const TOKEN_KEY = 'hmi-ws-token';

export class WsChannel {
  constructor(opts = {}) {
    this.opts = opts;                 // {onHello,onStatus,onVar,onVars,onAlarm,onOpen,onClose}
    this.ws = null;
    this.state = 'idle';              // idle | connecting | open | closed
    this._seq = 1;
    this._pending = new Map();        // id → {resolve, reject, timer}
    this._openWaiters = [];           // 等"连上了"的那些 promise（见 whenOpen）
    this._backoff = BACKOFF_MIN;
    this._timer = null;
    this._watch = null;
    this._stopped = false;
    this._everOpen = false;
    this.lastRxAt = 0;
    this.stats = { frames: 0, sent: 0, reconnects: 0, errors: 0, openedAt: 0 };
  }

  isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** 后端支持 WebSocket 吗 */
  static supported() {
    return typeof WebSocket === 'function';
  }

  /**
   * 等这条连接连上（V2 里"后端能不能用"就等于"这条连接通不通"）。
   *
   * 为什么要有它：以前前端用 `GET /api/health` 探活，现在不发 HTTP 了，
   * 而启动时（比如客户页要先把工程读下来）必须先确定连接好了再发消息 ——
   * 不然会撞上"还没连上"的失败。给 timeoutMs 就在超时后 reject。
   */
  whenOpen(timeoutMs = 0) {
    if (this.isOpen()) return Promise.resolve(true);
    if (this._stopped) return Promise.reject(new ChannelDown('长连接已停止'));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        w.timer = setTimeout(() => {
          this._openWaiters = this._openWaiters.filter(x => x !== w);
          reject(new ChannelDown(`等长连接超时（${timeoutMs}ms）`));
        }, timeoutMs);
      }
      this._openWaiters.push(w);
    });
  }

  _resolveOpenWaiters() {
    const ws = this._openWaiters || [];
    this._openWaiters = [];
    for (const w of ws) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve(true);
    }
  }

  _rejectOpenWaiters(msg) {
    const ws = this._openWaiters || [];
    this._openWaiters = [];
    for (const w of ws) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new ChannelDown(msg));
    }
  }

  start() {
    this._stopped = false;
    if (this.ws || this._timer) return this;
    this._open();
    if (!this._watch) {
      this._watch = setInterval(() => this._checkStale(), WATCH_MS);
    }
    return this;
  }

  stop() {
    this._stopped = true;
    this._rejectOpenWaiters('长连接已关闭');
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._watch) { clearInterval(this._watch); this._watch = null; }
    this._failPending('长连接已关闭');
    if (this.ws) {
      try { this.ws.close(); } catch { /* 已经没了 */ }
      this.ws = null;
    }
    this.state = 'closed';
  }

  _open() {
    if (this._stopped) return;
    this.state = 'connecting';
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      this.stats.errors++;
      this._retry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'open';
      this._backoff = BACKOFF_MIN;
      this.lastRxAt = Date.now();
      this.stats.openedAt = Date.now();
      if (this._everOpen) this.stats.reconnects++;
      const first = !this._everOpen;
      this._everOpen = true;
      bus.emit('backend:ws', { state: 'open', first });
      this._resolveOpenWaiters();
      try { this.opts.onOpen?.({ first }); } catch (e) { console.warn('[ws] onOpen 出错', e); }
    };

    ws.onmessage = ev => {
      this.lastRxAt = Date.now();
      this.stats.frames++;
      let j;
      try { j = JSON.parse(ev.data); } catch { return; }   // 坏帧忽略
      if (!j || typeof j !== 'object') return;
      this._dispatch(j);
    };

    ws.onerror = () => { this.stats.errors++; /* 紧跟一个 onclose，重连交给它 */ };

    ws.onclose = () => {
      const wasOpen = this.state === 'open';
      this.ws = null;
      this.state = 'closed';
      this._failPending('长连接断开');
      if (wasOpen) bus.emit('backend:ws', { state: 'closed' });
      try { this.opts.onClose?.(); } catch { /* 忽略 */ }
      this._retry();
    };
  }

  _retry() {
    if (this._stopped || this._timer) return;
    const wait = Math.round(this._backoff * (0.7 + Math.random() * 0.6));   // 抖动
    this._backoff = Math.min(BACKOFF_MAX, this._backoff * 2);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._open();
    }, wait);
  }

  /** 看门狗：连接开着但很久没收到任何帧（后端每秒都推设备状态）→ 半死，主动断掉重连 */
  _checkStale() {
    if (this.state !== 'open' || !this.lastRxAt) return;
    if (Date.now() - this.lastRxAt > STALE_MS) {
      console.warn('[ws] 连接还在但一直没有数据（半死），主动重连');
      this.stats.errors++;
      try { this.ws?.close(); } catch { /* 忽略 */ }
    }
  }

  _dispatch(j) {
    // 应答：唤醒等这条 id 的请求
    if (j.t === 'ack') {
      const p = this._pending.get(j.id);
      if (p) {
        this._pending.delete(j.id);
        clearTimeout(p.timer);
        p.resolve(j);
      }
      return;
    }
    if (j.t === 'pong') {
      const p = this._pending.get(j.id);
      if (p) { this._pending.delete(j.id); clearTimeout(p.timer); p.resolve(j); }
      return;
    }
    if (j.t === 'hello') { this.hello = j; try { this.opts.onHello?.(j); } catch { /* 忽略 */ } return; }
    if (j.t === 'status') { try { this.opts.onStatus?.(j.status, j.ts); } catch { /* 忽略 */ } return; }
    // 广播帧：与 SSE 完全同格式（{name,value} / {vars:{…}} / {alarm:…}），
    // 所以两条通道共用同一套解析 —— 换通道不影响任何控件逻辑
    if (j.alarm) { try { this.opts.onAlarm?.(j.alarm); } catch { /* 忽略 */ } return; }
    if (j.vars) {
      try {
        if (this.opts.onVars) this.opts.onVars(j.vars);
        else if (this.opts.onVar) for (const n in j.vars) this.opts.onVar(n, j.vars[n]);
      } catch { /* 忽略 */ }
      return;
    }
    if (j.name !== undefined) { try { this.opts.onVar?.(j.name, j.value); } catch { /* 忽略 */ } return; }
    // 其余未知帧（AI 流式帧 {t:'ai_delta'|'ai_tool'|'ai_done'|'ai_error'} 等）交给兜底回调。
    // 没有 onEvent 的调用方行为完全不变（以前这些帧被静默丢弃）。
    try { this.opts.onEvent?.(j); } catch { /* 忽略 */ }
  }

  _failPending(msg) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new ChannelDown(msg));
    }
    this._pending.clear();
  }

  /** 发一条消息，不等应答。连不上返回 false。 */
  send(obj) {
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      this.stats.sent++;
      return true;
    } catch (e) {
      this.stats.errors++;
      return false;
    }
  }

  /**
   * 发一条消息并等它的 ack。
   *
   * ★ 还没连上时**先等握手**（最多 OPEN_GRACE），不是立刻抛错。
   *   为什么：2.0 只有这一条通道，而页面刚起来那一下（读工程、拉报警历史、下发变量表…）
   *   常常比 WebSocket 握手还早 —— 1.x 那些 HTTP 请求是无所谓的（HTTP 随时能发），
   *   2.0 就会立刻拿到"长连接没连上"，而且**调用方大多不会自己重试**，于是
   *   表现成"新开的机器报警历史是空的""刚进运行态那一下没读到数据"这种偶发怪事。
   *
   * 连不上 / 等超时 / 连接中途断了 → 抛 ChannelDown；
   * 后端明确回了 ok:false → **正常返回**那个应答对象（这是业务失败，不该重试）。
   */
  async request(obj, timeout = REQ_TIMEOUT) {
    if (!this.isOpen()) await this.whenOpen(OPEN_GRACE);      // 等不到就抛 ChannelDown
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new ChannelDown('长连接没连上'));
        return;
      }
      const id = this._seq++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new ChannelDown(`等应答超时（${timeout}ms）`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...obj, id })) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(new ChannelDown('长连接发送失败'));
      }
    });
  }

  /** 诊断用（状态栏 / 控制台 app.backend.wsStats()） */
  info() {
    return {
      state: this.state,
      open: this.isOpen(),
      frames: this.stats.frames,
      sent: this.stats.sent,
      reconnects: this.stats.reconnects,
      errors: this.stats.errors,
      pending: this._pending.size,
      idleMs: this.lastRxAt ? Date.now() - this.lastRxAt : -1,
      build: this.hello?.build || '',
    };
  }
}
