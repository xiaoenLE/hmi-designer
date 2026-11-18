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

/**
 * 这条请求**等应答超时**了：连接还开着，只是对端没在超时时间内回话。
 *
 * ⚠ 它**故意**不是 ChannelDown —— 两者要分开对待，这是踩出来的：
 *   后端处理写值是**串行**的（一条连接一个接收线程），设备卡住时一笔写要等一个
 *   socket 超时（Modbus 1.5 秒），排在后面的写就得等 1.5 秒 × 队列长度。
 *   这时候如果按"连接断了"处理 → **每一笔超时的写都退回 HTTP 再试一次** →
 *   后端每收一个请求就新起一个线程 → 请求越堆越多、线程越起越多，
 *   现场表现就是「设备一断，内存暴涨一下、过一会儿才降下来」
 *   （实测：300 个变量 × 每 50ms 全写一遍时，断开 16 秒里冒出 **3374 个 HTTP 请求**）。
 *
 *  正确做法：超时就算**这次下发失败**（带上 kind='link'，前端据此当场把链路判成断开、
 *  停止继续下发），**不退 HTTP**。连接真的断了才退。
 */
export class RequestTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestTimeout';
    this.requestTimeout = true;
    this.kind = 'link';          // 对写值来说：这就是"设备这一下不通"
  }
}

function wsUrl() {
  // http://host:port/... → ws://host:port/api/ws
  const base = location.protocol.startsWith('http')
    ? location.origin
    : 'http://localhost:8866';
  return base.replace(/^http/, 'ws') + '/api/ws';
}

export class WsChannel {
  constructor(opts = {}) {
    this.opts = opts;                 // {onHello,onStatus,onVar,onVars,onAlarm,onOpen,onClose}
    this.ws = null;
    this.state = 'idle';              // idle | connecting | open | closed
    this._seq = 1;
    this._pending = new Map();        // id → {resolve, reject, timer}
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

  /** 后端支持 WebSocket 吗（前端先看 /api/health 的能力表再决定要不要连） */
  static supported() {
    return typeof WebSocket === 'function';
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
   * 连不上 / 等超时 / 连接中途断了 → 抛 ChannelDown（调用方可以退回 HTTP 再试）；
   * 后端明确回了 ok:false → **正常返回**那个应答对象（这是业务失败，不该重试）。
   */
  request(obj, timeout = REQ_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new ChannelDown('长连接没连上'));
        return;
      }
      const id = this._seq++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // ⚠ 用 RequestTimeout（**不是** ChannelDown）：连接还开着，只是后端忙/设备卡住。
        //   调用方据此**不要**退回 HTTP 重试（见 RequestTimeout 的说明）。
        reject(new RequestTimeout(`等应答超时（${timeout}ms）`));
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
