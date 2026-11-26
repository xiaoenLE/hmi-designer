/**
 * backend.js — Python 后端对接层（★V2：**只走一条 WebSocket 长连接**）
 *
 * 为什么改成"只有一条路"
 * ----------------------
 * 1.x 是「HTTP + SSE + 长连接」三条路混着走：变量推送有 SSE、写变量一个 POST 一个、
 * 设备状态每 3 秒 GET 一次、另有 10 秒心跳和 30 秒全量补读，还得留一套"连不上就退回
 * HTTP 轮询"的兜底。结果是：一个页面一小时一千多个 HTTP 请求，**而且每个功能都有两条
 * 实现路径**（走长连接的、走 HTTP 的），现场出问题时得先判断"这次走的是哪条"。
 *
 * 2.0 起只保留长连接这一条：
 *   · 变量读写、设备状态、在线登记 —— 专有的消息类型（帧小、往返快）；
 *   · 其余所有接口 —— `{t:'call'}` 转发（后端只有**一套**实现，见 server/core/rpc.py）；
 *   · **没有 SSE、没有轮询、没有兜底**：连接断了就自动重连，重连时补一次全量。
 *   稳态下前端一个 HTTP 请求都不发（页面本身的静态文件是 HTTP 拿的，那是浏览器的事）。
 *
 * ⚠ 这个决定的前提：2.0 只通过安装包（exe）分发，不要求前后端版本能混搭 ——
 *   所以不必再为"旧后端"保留第二条路。配错版本时状态栏当场说清「后端不是 2.0」，
 *   而不是让人对着一堆"某个按钮失灵"猜。
 *
 * 与 server/core/wsbridge.py 对齐的消息：
 *   发 {t:'write'|'writes'|'vars'|'declare'|'poll'|'status'|'ping'}   热路径
 *   发 {t:'call', path, method?, body?}                              其余接口（见 rpc.py）
 *   发 {t:'login'|'logout'|'session'}                                登录态
 *   收 {t:'hello'|'status'|'ack'|'pong'} + 广播帧 {name,value} / {vars:{…}} / {alarm:…}
 */
import { bus } from '../core/eventBus.js';
import { WsChannel, ChannelDown, TOKEN_KEY } from './wschannel.js';
// 地址规则（INVT / TS600）与「协议三项」：连上哪台 PLC，前端解析地址就用哪套。
// 规则在 core/addrMap.js；协议由用户选的（modbus / ts600 / opcua）。
import { PROFILE_INVT, PROFILE_TS600, PROFILES, getProfile, setProfile, profileId, isTs600,
  profileCn, hasStoredProfile, protocolOfConfig, protocolId, profileForProtocol } from '../core/utils.js';

/** 前端要求后端必须具备的能力。
 *  少任何一个都说明「后端不是 2.0」—— 2.0 的前端只走长连接，旧后端既没有 {t:'call'}
 *  也没有 ws_only 那套，硬用会大片功能失灵；所以要能当场看出来，而不是逐个按钮去试。 */
export const REQUIRED_FEATURES = ['word_order4', 'words_by_type', 'string_range', 'orders_probe',
  'page_scope', 'protocol', 'opcua', 'opcua_browse', 'opcua_xml', 'opcua_endpoints',
  'alarm_store', 'keepalive', 'websocket',
  // ★ 2.0 的标记：ws_only = 前端只走这条长连接；rpc = 长连接上能调接口
  'ws_only', 'rpc'];

/** 可选能力：有则用，没有就退回前端本地实现（**不进 REQUIRED_FEATURES**）。
 *  · comm_api = 后端有 /api/comm/protocols + /api/comm/validate（协议目录 + 地址校验）。
 *  为什么不放进 REQUIRED_FEATURES：现网还有一批「2.0 但还没加 comm_api」的后端，
 *  放进去会让状态栏误报「后端版本不匹配」（而那批后端其实什么都能用，只是地址校验走本地）。
 *  前端用 `backend.hasCommApi()` / `supports('comm_api')` 判断，拿不到就用 core/addrCatalog.js
 *  里的本地目录 + addrMap 本地判定兜底。 */
export const COMM_FEATURES = ['comm_api'];

const HELLO_WAIT_MS = 3000;      // 连上之后等 hello 多久（正常是紧接着就到）
const RPC_TIMEOUT = 15000;       // 一次接口调用的默认超时
const RPC_TIMEOUT_SLOW = 40000;  // 慢接口（连设备 / OPC UA 探测 / 端点诊断 / 导入）给宽一点

/** 这个页面的 id：只用于日志和诊断（在线登记现在绑在连接上，不需要它） */
const PAGE_ID = 'p' + Math.random().toString(36).slice(2, 8);

/**
 * 后端配置 / 状态里带的地址模型（原始值，可能空）。
 * 字段名兼容：addr_profile（标准）/ profile / addr_model（历史写法）。
 * 旧后端没有这个字段 → 返回 ''，调用方保持前端当前选的（localStorage 里那份），不报错。
 */
function profileValueOf(cfg, st) {
  cfg = cfg || {}; st = st || {};
  return cfg.addr_profile ?? cfg.addr_model ?? cfg.profile
    ?? st.addr_profile ?? st.addr_model ?? st.profile ?? '';
}

/**
 * 载荷归一：把前端选的三项协议（modbus / ts600 / opcua）翻成后端认的字段组合。
 *   · ts600 → protocol:'ts600' + addr_profile:'ts600-modbus-tcp'（后端兼容，落盘成 modbus+ts600）
 *   · modbus → protocol:'modbus' + addr_profile:'invt-modbus-slave'
 *   · opcua → protocol:'opcua'（不带 addr_profile：NodeId 没有地址模型）
 * 不传/认不出协议时原样返回（兼容老前端只传 addr_profile 的调用）。
 */
function protocolPayload(cfg) {
  const out = { ...(cfg || {}) };
  const proto = protocolOfConfig(out) || protocolId(out.protocol);
  if (!proto) return out;
  if (proto === 'opcua') {
    out.protocol = 'opcua';
    delete out.addr_profile;
  } else if (proto === 'ts600') {
    out.protocol = 'ts600';
    out.addr_profile = PROFILE_TS600;
  } else {
    out.protocol = 'modbus';
    out.addr_profile = PROFILE_INVT;
  }
  return out;
}

/** 「测试连接 / 按 4 种字序各读一次」这类探测接口的默认地址：按协议给一个一定存在的字 */
function defaultProbeAddr(proto) {
  const p = protocolId(proto) || (isTs600() ? 'ts600' : 'modbus');
  return p === 'ts600' ? 'D0' : '%MW0';
}

export const backend = {
  state: 'offline',        // 'online' | 'offline'（= 长连接通没通）
  _channel: null,          // WsChannel
  _hello: null,            // 连上时后端给的现状（顶掉以前的 GET /api/health）
  _helloWaiters: [],
  /** 「没人认领」的帧的订阅者（见 onEvent）：AI 流式帧 {t:'ai_delta'|'ai_tool'|'ai_done'|'ai_error'} */
  _eventFns: new Set(),
  _varFp: null,            // 已下发的变量表指纹
  _declarePromise: null,   // 正在下发的地址映射（写变量前要等它，避免写到旧地址）
  _plcStatus: null,        // 后端推来的最新设备状态
  _plcStatusAt: 0,
  _plcCfg: null,           // hello / getPlc 带来的连接配置
  _commCache: null,        // GET /api/comm/protocols 的成功结果（协议/地址目录，见 commProtocols()）
  _commAt: 0,              // 上面那份缓存的时间戳（成功缓存 60s）
  _commFailAt: 0,          // 上次失败的时间戳（失败 10s 内不再重试，避免每个地址格都撞超时）
  _pollWanted: false,      // 这个页面想不想让后端采设备（重连之后要重报）
  _alwaysPoll: false,      // 后端那个「编辑态也一直采」的全局开关
  pollPaused: false,
  _onVar: null,            // 推送回调（runtime 注册）
  _onVars: null,
  _lastDeclare: null,      // 上次下发的采集范围（重连之后要重报）
  build: '',
  features: [],
  version: null,           // 当前版本 {version,date,notes,build,url}
  update: null,            // 最近一次更新检查结果
  lastUpdate: null,        // 上一次「立即更新」的落地结果（ok / rolled_back / failed）
  opcua: { available: false, import_error: '', install: '', default_ns: 4 },
  auth: { enabled: true, logged_in: false },
  plcInfo: { protocol: 'modbus', endpoint: '', security: 'none', username: '', default_ns: 4 },
  /** 当前**设备链路**状态：{ mode:'memory'|'plc'|'opcua', online:bool }
   *  变量存储拿它当"链路门"的依据：接真设备时没连上不发写、连上后先读到数据才允许操作 */
  plcLink: { mode: '', online: false },
  scope: null,             // 本页采集范围（{active, blocks, scoped}）

  isOnline() { return this.state === 'online'; },

  /** 现在接的是哪种 PLC（三项：'modbus' / 'ts600' / 'opcua'）。
   *  变量表地址该按 NodeId、%MW 还是 D/M/S… 写法提示，全看它。
   *  · opcua：后端明说了
   *  · 已连着 Modbus 设备：以设备侧地址模型为准（后端 status.addr_profile；落盘形如
   *    protocol:"modbus" + addr_profile:"ts600-modbus-tcp"）
   *  · 内存模拟 / 还没连：按前端当前选的地址模型推（用户在对话框里选过 TS600 就算 TS600） */
  protocol() {
    const p = String(this.plcInfo?.protocol || '').toLowerCase();
    if (p === 'opcua') return 'opcua';
    if (p === 'ts600') return 'ts600';
    const mode = String(this.plcLink?.mode || '');
    if ((mode === 'plc' || mode === 'opcua') && p === 'modbus') {
      const prof = this.plcInfo?.addr_profile;
      if (prof) return isTs600(prof) ? 'ts600' : 'modbus';
    }
    return isTs600() ? 'ts600' : 'modbus';
  },
  isOpcua() { return this.protocol() === 'opcua'; },
  /** 是不是 TS600 那支（Modbus TCP + 元件地址） */
  isTs600() { return this.protocol() === 'ts600'; },

  /** 从一份 PLC 配置/状态里更新「当前连接方式」（状态栏、变量表、连接对话框都用它） */
  setPlcInfo(src) {
    if (!src) return this.plcInfo;
    if (src.mode) this.plcLink = { mode: String(src.mode), online: !!src.online };
    const prev = this.protocol();
    const proto = String(src.protocol || (src.mode === 'opcua' ? 'opcua' : '') || '').toLowerCase();
    if (proto) this.plcInfo.protocol = proto === 'opcua' ? 'opcua' : (proto === 'ts600' ? 'ts600' : 'modbus');
    // 地址模型：后端落盘是 protocol:"modbus" + addr_profile:"ts600-modbus-tcp"，
    // 光看 protocol 分不出 INVT / TS600，所以这份要跟着存（protocol() 会用它）
    const prof = profileValueOf(src, null);
    if (prof) this.plcInfo.addr_profile = prof;
    if (this.plcInfo.protocol === 'opcua') delete this.plcInfo.addr_profile;
    for (const k of ['endpoint', 'security', 'username', 'default_ns']) {
      if (src[k] !== undefined && src[k] !== '') this.plcInfo[k] = src[k];
    }
    // 协议换了要喊一声：变量表的地址提示/占位、「从 OPC UA 导入…」按钮都只认当前协议
    if (this.protocol() !== prev) bus.emit('plc:protocol', { protocol: this.protocol() });
    return this.plcInfo;
  },

  /** 页面是后端（http/https）给的 → 应该能写；file:// 直开属于纯本地模拟 */
  expectsServer() { return location.protocol.startsWith('http'); },

  /* ════════════════════════ 长连接 ════════════════════════ */

  /** 把长连接建起来（幂等）。V2 里"连后端"就是这一件事。 */
  _ensureChannel() {
    if (this._channel) return this._channel;
    if (!WsChannel.supported()) return null;
    this._channel = new WsChannel({
      // 长连接上「没有专门处理函数」的帧（目前只有 AI 流式帧）交给订阅者。
      // 每个订阅者单独 try/catch：一个订阅者炸了不能影响其他订阅者，更不能影响长连接。
      onEvent: j => { for (const fn of this._eventFns) { try { fn(j); } catch { /* 忽略 */ } } },
      onHello: h => this._onHello(h),
      onStatus: st => this._onStatus(st),
      onVar: (n, v) => { try { this._onVar?.(n, v); } catch { /* 忽略 */ } },
      onVars: v => { try { this._onVars?.(v); } catch { /* 忽略 */ } },
      onAlarm: a => bus.emit('alarms:remote', a),
      onOpen: ({ first }) => {
        // 重连之后必须补三件事，否则界面会停在断线前的状态：
        //   ① 全量补读（断线期间变过的变量不会补发）
        //   ② 重报采集范围（后端那份注册只活在连接上）
        //   ③ 重报「我在看运行画面」（同上）
        if (this._onVar || this._onVars) this.resyncAll(this._onVar);
        this._replayDeclare();
        this._replayPoll();
        if (!first) bus.emit('backend:reconnect', { first });
        this.paintStatusBar();
      },
      onClose: () => {
        this._plcStatus = null;
        this._hello = null;
        this._setState('offline');
      },
    });
    this._channel.start();
    bus.emit('backend:ws', { state: 'connecting' });
    return this._channel;
  },

  /** 等长连接就绪（"先把工程读下来"那种地方要用；超时抛 ChannelDown） */
  async whenReady(timeoutMs = 8000) {
    const ch = this._ensureChannel();
    if (!ch) throw new Error('这个浏览器不支持 WebSocket');
    await ch.whenOpen(timeoutMs);
    return true;
  },

  /** 连上时后端给的现状（这一帧顶掉了以前的 GET /api/health） */
  _onHello(h) {
    this._hello = h;
    if (h.build) this.build = h.build;
    if (Array.isArray(h.features)) this.features = h.features;
    if (h.version) this.version = h.version;
    if (h.update) this.lastUpdate = h.update.last || null;
    if (h.opcua) this.opcua = { ...this.opcua, ...h.opcua };
    if (h.auth) this.auth = { ...(this.auth || {}), ...h.auth };
    if (h.cfg) this._plcCfg = h.cfg;
    if (h.status) this._onStatus(h.status);
    this._setState('online');
    const ws = this._helloWaiters;
    this._helloWaiters = [];
    for (const r of ws) r(h);
  },

  /** 等 hello 到（probe 用；正常它紧接着 onopen 就到） */
  _waitHello(timeoutMs = HELLO_WAIT_MS) {
    if (this._hello) return Promise.resolve(this._hello);
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(this._hello || null), timeoutMs);
      this._helloWaiters.push(h => { clearTimeout(t); resolve(h); });
    });
  },

  /**
   * 探活 = 把长连接连上并拿到 hello。**不发任何 HTTP 请求**。
   *
   * 返回值与以前的 /api/health 形状一致（build/features/version/plc/auth…），
   * 所以调用方（runtime.js 的 enterRun、main.js 的启动流程）不用改。
   * 连不上返回 null（照旧走本地模拟）。
   */
  async probe(timeout = 8000) {
    try {
      const ch = this._ensureChannel();
      if (!ch) { this._setState('offline'); return null; }
      await ch.whenOpen(timeout);
      const h = await this._waitHello(Math.min(HELLO_WAIT_MS, Math.max(800, timeout)));
      if (h) this._setState('online');
      return h || null;
    } catch {
      this._setState('offline');
      return null;
    }
  },

  /** 后端推来的设备状态：更新链路状态 + 通知等着的人（以前靠每 3 秒 GET /api/plc） */
  _onStatus(st) {
    if (!st || typeof st !== 'object') return;
    this._plcStatus = st;
    this._plcStatusAt = Date.now();
    this.setPlcInfo(st);
    bus.emit('plc:status', st);
  },

  /** 后端是否具备某个能力 */
  supports(feature) { return this.features.includes(feature); },

  /**
   * 订阅「没有专门处理函数」的帧（目前是 AI 流式帧 `{t:'ai_delta'|'ai_tool'|'ai_done'|'ai_error'}`）。
   *
   * 为什么要有它：那些帧是**点对点**回答某一次请求的，载荷形状跟变量/报警/状态这些
   * 广播帧完全不同，塞进 wsChannel 的固定回调里不合适；而且只有 AI 模块关心。
   * 所以走这条通用订阅通道（wsChannel 的 `_dispatch` 末尾兜底调 `opts.onEvent`）。
   *
   * @param {(frame:object)=>void} fn 每帧一次；**抛错会被忽略**，不影响其他订阅者
   * @returns {()=>void} 取消订阅
   */
  onEvent(fn) {
    if (typeof fn !== 'function') return () => {};
    this._eventFns.add(fn);
    return () => { this._eventFns.delete(fn); };
  },

  /** 缺少的能力（用来提示「后端不是 2.0」） */
  missingFeatures(need = []) { return need.filter(f => !this.supports(f)); },

  /** 诊断：这个页面的长连接状态（控制台 `app.backend.wsStats()`） */
  wsStats() {
    return this._channel
      ? { ...this._channel.info(), pageId: PAGE_ID, hello: !!this._hello }
      : { state: 'unsupported', pageId: PAGE_ID };
  },

  /** 单独发送按钮触发，PLC 写入阻塞时也能及时留痕。 */
  startButtonAudit() {
    if (!this.expectsServer() || !WsChannel.supported()) return null;
    let token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* 会话 Cookie 仍然可用 */ }
    if (!this._buttonAudit || this._buttonAuditToken !== token) {
      this.stopButtonAudit();
      this._buttonAuditToken = token;
      this._buttonAudit = new WsChannel({ quiet: true }).start();
    }
    return this._buttonAudit;
  },

  stopButtonAudit() {
    this._buttonAudit?.stop();
    this._buttonAudit = null;
  },

  async recordButton(name, text) {
    const ch = this.startButtonAudit();
    if (!ch) return;
    const reply = await ch.request({
      t: 'call', path: '/api/operations/button', method: 'POST', body: { name, text },
    });
    if (!reply.ok && reply.status !== 404) throw new Error(reply.data?.error || '保存操作记录失败');
  },

  /** 调用后端接口。失败时区分服务端拒绝与长连接故障。 */
  async rpc(path, { method = 'POST', body = null, timeout = RPC_TIMEOUT } = {}) {
    const ch = this._ensureChannel();
    if (!ch) throw new Error('这个浏览器不支持 WebSocket');
    const j = await ch.request({ t: 'call', path, method, body }, timeout);
    const d = (j && j.data) || {};
    const ok = j && j.status >= 200 && j.status < 300 && d.ok !== false;
    if (!ok) {
      const e = new Error((d && (d.error || d.message)) || `HTTP ${j ? j.status : '?'}`);
      e.status = j ? j.status : 0;
      e.needLogin = !!(d && d.need_login);
      e.data = d;
      throw e;
    }
    return d;
  },

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    bus.emit('backend:status', { state: s });
    this.paintStatusBar();
  },

  /* ════════════════════════ 状态栏 ════════════════════════ */

  /** 状态栏那颗「后端」小灯 */
  paintStatusBar() {
    const st = document.getElementById('stBackend');
    if (!st) return;
    if (!this.isOnline()) {
      st.textContent = '后端：离线(模拟)';
      st.className = 'st-dot offline';
      st.title = '后端长连接没通（离线时用本地模拟数据）';
      return;
    }
    const missing = this.missingFeatures(REQUIRED_FEATURES);
    if (missing.length) {
      st.textContent = '后端：版本不匹配';
      st.className = 'st-dot offline';
      st.title = `这个后端不是 2.0（缺：${missing.join('、')}）。\n`
        + '2.0 的前端**只走长连接**，必须配 2.0 的后端 —— 请用新的安装包重装'
        + '（关掉旧后端再启动即可）。';
      return;
    }
    const sc = this.scope;
    const running = this._pollWanted === true;
    const idle = !running || this.pollPaused === true;
    const n = sc && sc.scoped ? `${sc.active} 变量/${sc.blocks} 块` : '';
    if (idle) {
      st.textContent = '后端：在线' + (n ? ` · 该页 ${n}` : '');
      st.className = 'st-dot ' + (this._alwaysPoll === true ? 'online' : 'idle');
    } else {
      st.textContent = '后端：在线' + (n ? ` · 本页 ${n}` : '');
      st.className = 'st-dot online';
    }
    st.title = `后端连接状态（build ${this.build || '?'}）`
      + this._channelTip()
      + (idle
        ? (this._alwaysPoll === true
          ? '\n编辑态也一直采设备（点这颗灯关掉）'
          : '\n编辑态不采设备（按 ▶ 运行 / 打开 /run 就开始采；点这颗灯 = 编辑态也一直采）')
          + (n ? `\n该页运行起来会采：${sc.active} 个变量，地址合并成 ${sc.blocks} 次读。` : '')
        : (sc && sc.scoped
          ? `\n按页采集：本页在采 ${sc.active} 个变量，地址合并成 ${sc.blocks} 次读`
            + '\n（切页面会重新下发采集范围；进运行态之后采集跟浏览器在不在前台无关）'
          : ''));
  },

  /** 状态栏提示里关于「通讯方式」那段（现场排查"到底走的哪条路"直接看这一行） */
  _channelTip() {
    const ch = this._channel;
    if (!ch) return '\n通讯：长连接正在建立…';
    const i = ch.info();
    if (i.open) {
      return `\n通讯：长连接（唯一通道）· 收到 ${i.frames} 帧 / 发出 ${i.sent} 帧`
        + (i.reconnects ? ` · 重连过 ${i.reconnects} 次` : '');
    }
    return `\n通讯：长连接${i.state === 'connecting' ? '正在重连' : '已断开'}`
      + '（断了会自动重连并补一次全量；2.0 没有 HTTP 轮询兜底）';
  },

  /* ════════════════════════ 变量：读 / 采集范围 ════════════════════════ */

  async readVars() {
    const ch = this._ensureChannel();
    if (!ch) return {};
    const j = await ch.request({ t: 'vars' });
    return (j && j.vars) || {};
  },

  /** 下发变量表（名称/类型/地址）+ 本页采集范围（active） */
  async declareVariables(variables, active) {
    this._lastDeclare = { variables, active: Array.isArray(active) ? active : null };
    try {
      const ch = this._ensureChannel();
      if (!ch) return false;
      const body = { t: 'declare', variables };
      if (Array.isArray(active)) body.active = active;
      const j = await ch.request(body);
      if (j && j.ok !== false) {
        this.scope = { active: j.active, blocks: j.blocks, scoped: !!j.scoped };
        this.paintStatusBar();
      }
      return true;
    } catch { return false; }        // 非致命：后端不在也要能继续本地模拟
  },

  /** 只问「这一页会采几个变量 / 几块」——**不动后端的变量表**（编辑器切页面预览用）。
   *  ⚠ 不能用 syncVarTable：那会把编辑器这份变量表推给后端，可能覆盖掉另一个标签页 /
   *  现场运行页正在用的那份（后端的表只能由真正在运行的那份工程说了算）。 */
  async previewScope(active) {
    try {
      const ch = this._ensureChannel();
      if (!ch) return false;
      const j = await ch.request({ t: 'declare', active: Array.isArray(active) ? active : [] });
      if (j && j.ok !== false) {
        this.scope = { active: j.active, blocks: j.blocks, scoped: !!j.scoped };
        this.paintStatusBar();
      }
      return true;
    } catch { return false; }
  },

  /** 变量表「名称|类型|地址|保持」指纹 + 本页采集范围，用来判断要不要重新下发 */
  _varFingerprint(variables, active) {
    const scope = Array.isArray(active) ? [...active].sort().join(',') : '*';
    return (variables || []).map(v => `${v.name}|${v.type}|${v.address || ''}|${v.retain ? 1 : 0}`).join(';') + '#' + scope;
  },

  /** 变量表一变、或切了页面（采集范围变了）就重新下发地址映射（指纹相同则跳过）。
   *  ⚠ 以前只有「进入运行态」和「连接 PLC」时下发：连着 PLC 时改地址、加变量，后端还在按
   *  旧映射读写 —— 改了像没改，必须断开重连才生效。 */
  async syncVarTable(variables, active) {
    const fp = this._varFingerprint(variables, active);
    if (fp === this._varFp) return false;
    // 记下这次下发，写变量时要等它落地：否则「改完地址马上按按钮」会写到旧地址上
    const p = this.declareVariables(variables, active).then(ok => {
      if (ok) this._varFp = fp;
      if (this._declarePromise === p) this._declarePromise = null;
      return ok;
    });
    this._declarePromise = p;
    return p;
  },

  /** 重连之后把采集范围重报一次（后端那份注册只活在连接上） */
  _replayDeclare() {
    if (!this._channel?.isOpen() || !this._lastDeclare) return;
    const d = this._lastDeclare;
    this._channel.request({ t: 'declare', variables: d.variables, active: d.active })
      .then(j => {
        if (j && j.ok !== false) {
          this.scope = { active: j.active, blocks: j.blocks, scoped: !!j.scoped };
          this.paintStatusBar();
        }
      })
      .catch(() => { /* 下次重连还会再报 */ });
  },

  /* ════════════════════════ 写变量 ════════════════════════ */

  /** 写变量值（走长连接）。
   *  opts.internal=true → HMI 自己的内部变量（地址留空）：后端不当 PLC 变量处理，
   *  表里没这个名字也不算「未在变量表声明」。
   *  opts.from='script' → 脚本发起的写：后端不往控制台打 `[var] …`
   *  （脚本一秒钟十几发，那行日志会把 cmd 刷爆；控制台只留人在触摸屏上的操作）。 */
  async writeVar(name, value, opts = {}) {
    if (this._declarePromise) {          // 「改完地址马上点按钮」必须写新地址
      try { await this._declarePromise; } catch { /* 下发失败也照写，让错误在写的时候暴露 */ }
    }
    const ch = this._ensureChannel();
    if (!ch) throw new Error('后端未连接（长连接没建起来）');
    const body = { t: 'write', name, value };
    if (opts.internal) body.internal = true;
    if (opts.from) body.from = opts.from;
    const j = await ch.request(body);
    if (j && j.ok === false) throw new Error(j.error || '写入失败');
    return j;
  },

  /** 批量写（脚本一个周期写一堆变量）：**一次往返**写完多个，比一个个发省得多 */
  async writeVarsBatch(items, from = 'script') {
    if (!Array.isArray(items) || !items.length) return [];
    if (this._declarePromise) {
      try { await this._declarePromise; } catch { /* 忽略 */ }
    }
    const ch = this._ensureChannel();
    if (!ch) throw new Error('后端未连接（长连接没建起来）');
    const j = await ch.request({ t: 'writes', items: items.map(it => ({ ...it, from })) }, 20000);
    if (j && Array.isArray(j.results)) {
      return j.results.map(r => (r && r.ok === false
        ? { ok: false, error: r.error || '写入失败' }
        : { ok: true }));
    }
    return items.map(() => ({ ok: true }));
  },

  /** 内部变量（内存模拟）恢复成变量表初值 —— 联调时把模拟值改乱了用 */
  async resetVars() {
    const d = await this.rpc('/api/vars/reset', { body: {} });
    return (d && d.vars) || {};
  },

  /* ════════════════ 在线登记（谁在看运行画面） ════════════════ */

  /**
   * 告诉后端「有人在看运行画面 / 没人看了」。
   *
   * ★ 走长连接时**不需要心跳**：连接本身就是登记（后端按连接续命、断开自动注销）。
   *   1.x 那套「每 10 秒 POST /api/poll + 关页面 sendBeacon 注销」整个没了 ——
   *   顺带修掉一个老毛病：页面被强杀时 sendBeacon 发不出去，后端要白采 30 秒。
   */
  setPolling(on) {
    this._pollWanted = !!on;
    const ch = this._ensureChannel();
    if (!ch || !ch.isOpen()) return Promise.resolve(null);   // 连上时 onOpen 会重报
    return ch.request({ t: 'poll', on: !!on }).then(j => {
      this._alwaysPoll = !!j.always;
      this.pollPaused = !!j.paused;
      this.paintStatusBar();
      return j;
    }).catch(() => null);
  },

  /** 重连之后把「我在看运行画面」重报一次 */
  _replayPoll() {
    const ch = this._channel;
    if (!ch?.isOpen()) return;
    ch.request({ t: 'poll', on: this._pollWanted === true })
      .then(j => { this._alwaysPoll = !!j.always; this.pollPaused = !!j.paused; this.paintStatusBar(); })
      .catch(() => { /* 下次重连还会再报 */ });
  },

  /** 状态栏那颗灯点一下：切「编辑态也一直采设备」（改画面时也想看 PLC 上的值就用它）。
   *  后端是个全局开关：开了之后不管有没有人在运行态都轮询设备。 */
  toggleAlwaysPoll() {
    const on = !this._alwaysPoll;
    const done = j => {
      if (j) { this._alwaysPoll = !!j.always; this.pollPaused = !!j.paused; }
      this.paintStatusBar();
      return j;
    };
    const ch = this._ensureChannel();
    if (!ch || !ch.isOpen()) return Promise.resolve(done(null));
    return ch.request({ t: 'poll', on: this._pollWanted === true, always: on })
      .then(done).catch(() => done(null));
  },

  /** 页面要关了：长连接一断后端就注销了，**什么都不用做**（以前要发一个 sendBeacon） */
  leavePolling() { this._pollWanted = false; },

  /* ════════════════════════ 推送订阅 ════════════════════════ */

  /** 全量读一遍逐个回调 —— 推送链重连后「补账」用。
   *  为什么必须有：推送只推**变化**，断线那段时间里变过的变量不会补发，
   *  不补读界面就永远停在旧值上（现场看着就是"只读了一次，后面就不动了"）。 */
  resyncAll(onVar) {
    return this.readVars()
      .then(v => { for (const [n, val] of Object.entries(v || {})) onVar(n, val); })
      .catch(() => { /* 连接没通就算了，下次重连还会补 */ });
  },

  /** 订阅变量推送：V2 里就是"把回调交给这条长连接"（没有 SSE、也没有第二种通道） */
  startEvents(onVar, onVars) {
    this._onVar = onVar || null;
    this._onVars = onVars || null;
    this._ensureChannel();
  },

  stopEvents() {
    this._onVar = null;
    this._onVars = null;
  },

  /* ════════════ 工程存档 / 报警 / 日志（都走长连接） ════════════ */

  async saveProject(data) {
    await this.rpc('/api/project', { body: { data }, timeout: RPC_TIMEOUT_SLOW });
  },
  async loadProject() {
    const d = await this.rpc('/api/project', { method: 'GET' });
    return (d && d.data) || null;
  },

  async loadAlarms() {
    const d = await this.rpc('/api/alarms', { method: 'GET' });
    return Array.isArray(d && d.history) ? d.history : [];
  },
  /** payload: {clear?:true, add?:[记录], patch?:[{key,at,endAt,acked}]} */
  async saveAlarms(payload) {
    return (await this.rpc('/api/alarms', { body: payload || {} })) || {};
  },

  /** 脚本日志落盘（后端写 logs/script-YYYY-MM-DD.log）。
   *  ⚠ 失败**不上抛** —— 日志送不出去绝不能影响脚本本身和界面
   *  （调用方 scriptEngine 已经限速/限批/限总量了，后端不在就当"这批发丢了"）。 */
  async sendScriptLog(lines) {
    if (!Array.isArray(lines) || !lines.length) return null;
    try {
      const d = await this.rpc('/api/scriptlog', { body: { lines } });
      return (d && d.ok) ? d : null;
    } catch { return null; }
  },

  /** 读服务器上落盘的脚本日志（读不到返回 null，界面上说一句"没读到"） */
  async readScriptLog(date = '', limit = 300) {
    try {
      const q = new URLSearchParams();
      if (date) q.set('date', date);
      q.set('limit', String(limit));
      const d = await this.rpc('/api/scriptlog?' + q.toString(), { method: 'GET' });
      return (d && d.ok) ? d : null;
    } catch { return null; }
  },

  /** 日志设置（**这台机器**的：保留天数 / 脚本日志每天上限）。要管理员 */
  async logSettings() {
    try {
      const d = await this.rpc('/api/logsettings', { method: 'GET' });
      return (d && d.ok) ? d : null;
    } catch { return null; }
  },
  async saveLogSettings(patch) {
    return await this.rpc('/api/logsettings', { body: patch || {} });
  },

  /* ════════════════════════ 版本 / 更新 ════════════════════════ */

  /** 检查有没有新版本（force=true 忽略缓存当场再拉一次）。
   *  ⚠ 2.0 默认**关掉了更新检查**（更新走安装包，见 server/core/versioninfo.py）→
   *    后端回 state:'disabled'，前端据此不挂「有新版本」徽标。
   *  ⚠ 拉不到远端**不算失败**：现场机常常没外网 —— 结果里给 error 说明原因，不当异常抛。 */
  async checkUpdate(force = false) {
    const d = await this.rpc('/api/update/check' + (force ? '?force=1' : ''), { method: 'GET' });
    this.update = d;
    if (d && d.local) this.version = { ...(this.version || {}), ...d.local, build: this.build || d.local.build };
    return d;
  },

  /** 「立即更新」：后端下载新版代码、只覆盖代码、然后自己重启（要管理员）。
   *  ⚠ 后端**发完这个响应就会退出** —— 这条连接会断，那是正常的；调用方收到后开始等它回来
   *  （见 editor/updateCheck.js 的 waitBackendBack），别以为是自己断线了。 */
  async applyUpdate() {
    try {
      return await this.rpc('/api/update/apply', { body: {}, timeout: RPC_TIMEOUT_SLOW });
    } catch (e) {
      // 后端正在退出时连接被掐属于正常：当成"已开始更新"往上给一句人话
      if (e instanceof ChannelDown) return { ok: false, error: '后端正在重启（更新已开始）' };
      throw e;
    }
  },

  /* ════════════════════════ 登录 / 会话 ════════════════════════ */

  canEdit(session = this.auth) {
    return (session?.auth_enabled ?? session?.enabled) === false
      || (session?.logged_in === true && (session.role || 'admin') === 'admin');
  },

  /** 现在登录着没（2.0 的登录态绑在这条长连接上） */
  async session() {
    try {
      const ch = this._ensureChannel();
      if (!ch || !ch.isOpen()) return { auth_enabled: !!this.auth?.enabled, logged_in: false };
      const j = await ch.request({ t: 'session' });
      this.auth = { ...(this.auth || {}), enabled: !!j.auth_enabled, logged_in: !!j.logged_in,
        role: j.role || '', user: j.user || '' };
      return j;
    } catch {
      return { auth_enabled: !!this.auth?.enabled, logged_in: false };
    }
  },

  /** 管理员登录。
   *  走长连接上的登录消息 → 这条连接立刻算登录了；同时拿到一个 token 存本地，
   *  下次连的时候带在 URL 上（刷新页面 / 断线重连不用再输一次密码）。
   *  （/login 页面那条 Cookie 老路照旧能用，两条并存、互不影响。） */
  async login(password) {
    const ch = this._ensureChannel();
    if (!ch) throw new Error('这个浏览器不支持 WebSocket');
    await ch.whenOpen(8000);
    const j = await ch.request({ t: 'login', password }, 10000);
    if (!j || j.ok === false) throw new Error((j && j.error) || '登录失败');
    this.auth = { ...(this.auth || {}), logged_in: true, role: j.role || 'admin', user: j.user || '' };
    if (j.token) {
      try { localStorage.setItem(TOKEN_KEY, j.token); } catch { /* 隐私模式：那就下次重输 */ }
    }
    // 登录前后「口令」这类字段的可见性不同（配置里带不带 password），缓存丢掉重新问
    this._plcCfg = null;
    this._plcStatus = null;
    return true;
  },

  /** 注销（共用一台机器时别把编辑权限留在浏览器里） */
  async logout() {
    const ch = this._channel;
    let tok = '';
    try { tok = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* 忽略 */ }
    if (ch && ch.isOpen()) {
      try { await ch.request({ t: 'logout', token: tok }, 5000); } catch { /* 连接没了也无所谓 */ }
    }
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
    this.auth = { ...(this.auth || {}), logged_in: false, role: '', user: '' };
    this._plcCfg = null;
    this._plcStatus = null;
    return true;
  },

  /* ════════════════════ 设备（PLC / OPC UA） ════════════════════ */

  /** 读设备连接配置 + 状态。
   *  ★ 长连接在的时候**一个请求都不发**：设备状态后端每秒推一次，直接拿缓存那份。
   *    （1.x 是运行页每 3 秒、编辑器每 3 秒 GET /api/plc。）
   *    调用方（runtime.js 的 plcWatchTick、toolbar.js 的 refreshPlcStatus）一行都没改，
   *    还是照旧每 3 秒"问"一次，只是这次问的是内存。 */
  async getPlc() {
    if (this._plcStatus && Date.now() - this._plcStatusAt < 5000) {
      // 缓存分支也要恢复协议/地址模型：刷新页面后第一次问到的是缓存，别把选择丢了
      // 采纳后端协议的条件见 _adoptServerProtocol（连上设备 / 本机没显式选过）
      this._adoptServerProtocol(this._plcCfg || {}, this._plcStatus || {});
      return { ok: true, config: this._plcCfg || {}, status: this._plcStatus, cached: true };
    }
    const d = await this.rpc('/api/plc', { method: 'GET' });
    if (d.config || d.status) this.setPlcInfo({ ...(d.config || {}), ...(d.status || {}) });
    if (d.status) { this._plcStatus = d.status; this._plcStatusAt = Date.now(); }
    if (d.config) this._plcCfg = d.config;
    // 连着 Modbus/OPC UA 设备 → 后端说了算（它按哪套解析，前端就显示/校验哪套）；
    // 内存模拟时后端也会报一个默认协议：只在「本机还没选过」时才采纳，
    // 否则用户在对话框里选的 TS600 会被每 3 秒一次的轮询冲回 Modbus。
    this._adoptServerProtocol(d.config || {}, d.status || {});
    return d;
  },

  /** 后端报的协议（+地址模型）要不要采纳：连着设备就采纳；内存模拟只在本机没显式选过时采纳。
   *  采纳 = 按后端落盘口径恢复三项协议选择（protocol:"modbus"+addr_profile:"ts600-modbus-tcp" → TS600 TCP），
   *  返回 '' / 'modbus' / 'ts600' / 'opcua'。旧后端没有这些字段 → 返回 ''，保持前端当前选择。 */
  _adoptServerProtocol(cfg, st) {
    cfg = cfg || {}; st = st || {};
    const proto = protocolOfConfig({ ...cfg, ...st });
    if (!proto) return '';                                  // 旧后端压根没给
    const connected = !!(st && (st.mode === 'plc' || st.mode === 'opcua'));
    if (!connected && hasStoredProfile()) return '';        // 内存模拟 + 本机选过 → 别覆盖
    const prof = profileForProtocol(proto);
    if (prof && prof !== getProfile()) {
      const prev = this.protocol();
      setProfile(prof, false);      // 后端说的 ≠ 用户选的：只改内存模型，别写 localStorage（hasStoredProfile 要干净）
      if (this.protocol() !== prev) bus.emit('plc:protocol', { protocol: this.protocol() });
    }
    return proto;
  },

  /** 连接：三项协议统一入口 —— {protocol:'modbus'|'ts600'|'opcua', …}。
   *  ts600 会同时带 addr_profile:'ts600-modbus-tcp'（后端兼容，落盘成 modbus+ts600）。
   *  Modbus/TS600 给 {ip,port,unit,word_order(,addr_profile)}；OPC UA 给 {endpoint,security,…} */
  async connectPlc(cfg) {
    const payload = protocolPayload(cfg);
    const d = await this.rpc('/api/plc',
      { body: { action: 'connect', ...payload }, timeout: RPC_TIMEOUT_SLOW });
    this.setPlcInfo(d.status || payload);
    this._plcCfg = { ...(this._plcCfg || {}), ...payload };
    // 以后端实际生效的协议/模型为准（TS600 的落盘口径是 modbus+ts600-modbus-tcp，要按模型认回 TS600）
    const st = d.status || {};
    const proto = protocolOfConfig({ ...(d.config || {}), ...st })
      || protocolOfConfig(payload) || protocolId(payload.protocol);
    const prof = profileForProtocol(proto);
    if (prof) setProfile(prof);
    return d;
  },
  async disconnectPlc() {
    const d = await this.rpc('/api/plc', { body: { action: 'disconnect' } });
    this._plcCfg = null;
    return d;
  },
  async testPlc(cfg) {
    const c = protocolPayload(cfg);
    const proto = protocolOfConfig(c) || protocolId(c.protocol);
    if (!c.address && (proto === 'modbus' || proto === 'ts600')) c.address = defaultProbeAddr(proto);
    return await this.rpc('/api/plc', { body: { action: 'test', ...c }, timeout: RPC_TIMEOUT_SLOW });
  },
  /** 只读：把某个地址按 4 种字序各解一遍（现场判断对方 PLC 用哪种，不写 PLC） */
  async plcOrders(cfg) {
    const c = protocolPayload(cfg);
    const proto = protocolOfConfig(c) || protocolId(c.protocol);
    if (!c.address) c.address = defaultProbeAddr(proto);
    return await this.rpc('/api/plc', { body: { action: 'orders', ...c }, timeout: RPC_TIMEOUT_SLOW });
  },
  /** 后端支持哪些地址模型：[{id,cn}]。优先问后端（GET /api/plc 或 action profiles），
   *  旧后端两者都没有 → 回退前端本地 PROFILES（界面照样能选，只是后端可能只认默认那套）。
   *  这条永远不抛错：拿不到列表不该阻断「连 PLC」对话框。 */
  async plcProfiles() {
    const pick = (src) => {
      if (!src) return null;
      if (Array.isArray(src)) {
        const out = src.map(x => {
          if (typeof x === 'string') return { id: profileId(x), cn: profileCn(x) };
          if (!x || !x.id) return null;
          return { id: profileId(x.id), cn: String(x.cn || x.name || profileCn(x.id) || x.id) };
        }).filter(Boolean);
        return out.length ? out : null;
      }
      if (typeof src === 'object') {
        const out = Object.entries(src).map(([id, cn]) => ({ id: profileId(id), cn: String(cn || profileCn(id) || id) }));
        return out.length ? out : null;
      }
      return null;
    };
    const local = () => PROFILES.map(p => ({ id: p.id, cn: p.cn }));
    try {
      const d = await this.rpc('/api/plc', { method: 'GET' });
      const got = pick(d.profiles) || pick(d.config && d.config.profiles) || pick(d.status && d.status.profiles);
      if (got) return got;
    } catch { /* 离线 / 旧后端：继续试下一个口子 */ }
    try {
      const d = await this.rpc('/api/plc', { body: { action: 'profiles' }, timeout: RPC_TIMEOUT_SLOW });
      const got = pick(d.profiles) || pick(d.config && d.config.profiles);
      if (got) return got;
    } catch { /* 没有这个 action（旧后端）→ 回退本地 */ }
    return local();
  },
  /** 当前地址模型（诊断/状态栏用）：{id, cn} */
  addrProfile() { const id = getProfile(); return { id, cn: profileCn(id) }; },
  /** OPC UA：端点诊断（不需要建会话）——「你是谁 / 开了哪些端点 / 接受哪种身份」 */
  async plcEndpoints(cfg) {
    return await this.rpc('/api/plc',
      { body: { action: 'endpoints', protocol: 'opcua', ...cfg }, timeout: RPC_TIMEOUT_SLOW });
  },
  /** OPC UA：浏览节点树（「从服务器导入变量」用）。只读，不写任何节点 */
  async opcuaBrowse(cfg) {
    return await this.rpc('/api/opcua/browse', { body: cfg || {}, timeout: RPC_TIMEOUT_SLOW });
  },
  /** OPC UA：解析 CODESYS/Invtmatic 导出的「符号配置」XML（离线，不连服务器） */
  async opcuaParseXml(cfg) {
    return await this.rpc('/api/opcua/parse-xml', { body: cfg || {}, timeout: RPC_TIMEOUT_SLOW });
  },

  /* ════════════════ 通讯协议目录 / 地址校验（/api/comm，可选能力） ════════════════ */
  // 这两个口子回答的是同一个问题：「**这台 PLC** 的地址该写成什么样」。
  // 目录（有哪些协议、每种协议认哪些前缀、默认/探测地址）放后端，新增协议时前端不用改代码；
  // 对不对最终由后端判（后端拿着 server/addr_model.py 那套规则，比前端预判更权威）。
  // ⚠ 老后端没有 /api/comm（features 里没有 comm_api）→ 一律返回 null，调用方用本地兜底。

  /** 后端有没有 /api/comm 这套接口（老后端 → false） */
  hasCommApi() { return this.supports('comm_api'); },

  /**
   * 后端支持哪些通讯协议 / 每种协议的地址前缀（GET /api/comm/protocols）。
   * @returns {Promise<{protocols:Array, current?:object}|null>} 拿不到（老后端 / 连不上）返回 null。
   * 成功缓存 60s（切换协议时调用方可传 force:true 强刷）；失败 10s 内直接返回 null。
   */
  async commProtocols({ force = false } = {}) {
    const now = Date.now();
    if (!force) {
      if (this._commCache && now - this._commAt < 60000) return this._commCache;
      if (this._commFailAt && now - this._commFailAt < 10000) return null;
    }
    try {
      const d = await this.rpc('/api/comm/protocols', { method: 'GET', timeout: RPC_TIMEOUT });
      const list = Array.isArray(d && d.protocols) ? d.protocols : null;
      if (!list || !list.length) { this._commFailAt = Date.now(); return null; }
      this._commCache = d;
      this._commAt = Date.now();
      this._commFailAt = 0;
      return d;
    } catch {
      this._commFailAt = Date.now();
      return null;
    }
  },

  /**
   * 这个地址在当前协议下对不对（POST /api/comm/validate，**只校验不通讯**）。
   * body: {protocol, address, vtype, write}；返回：
   *   {valid, unsupported, code:'empty'|'model'|'invalid', message, warning,
   *    writable, protocol, addr_profile, prefix, address:{raw,area,area_cn,offset,words,bit,byte,kind,readonly}}
   * 拿不到结论（老后端 / 超时）返回 null —— 调用方退回 core/addrMap.js 本地判定。
   * 注意：`unsupported:true`（写法与协议不匹配）**不是错**，是「按内部变量处理」，界面不标红。
   */
  async validateAddr({ protocol = '', address = '', vtype = '', write = false } = {}) {
    try {
      const d = await this.rpc('/api/comm/validate',
        { body: { protocol, address, vtype, write }, timeout: 8000 });
      return d && typeof d.valid === 'boolean' ? d : null;
    } catch {
      return null;
    }
  },
};
