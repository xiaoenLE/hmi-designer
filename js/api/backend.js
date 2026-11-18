/**
 * backend.js — Python 后端对接层
 *
 * 协议（与 server/server.py 对齐）：
 *   **首选：一条 WebSocket 长连接（见 api/wschannel.js）**
 *     变量推送、变量写入、设备状态、在线登记全在这一条连接上双向走 ——
 *     稳态下**一个 HTTP 轮询都不发**。后端没有这个能力（旧版本）时自动退回下面的 HTTP + SSE。
 *   GET  /api/health            {ok, name, build, features:[…], version:{…}, vars, clients, ws:{…}}
 *   GET  /api/update/check      检查有没有新版本（?force=1 忽略缓存）；拉不到远端不报错，见结果里的 error
 *   GET  /api/vars              {vars:{name:value,...}, meta:{name:{address,type}}}
 *   POST /api/vars              {name, value, internal?}  写变量（广播出去）
 *   POST /api/poll              {on, client}         登记「有人在看运行画面」（没人看就不采设备）
 *   GET  /api/events            SSE 流 data:{"name":..,"value":..}     ← 仅在退回模式下用
 *   GET  /api/ws                WebSocket 升级（首选通道）
 *   GET  /api/project           工程JSON（服务器存档）
 *   POST /api/project           {data: 工程JSON}     保存工程
 *   GET  /api/alarms            报警历史（服务器存档；运行页读它，不用登录）
 *   POST /api/alarms            {clear|add|patch}    报警记录落盘（同写变量，不用登录）
 *
 * 写接口有来源校验：带外部网页 Origin 的 POST 会被拒（403），局域网/本机来源放行。
 *
 * 未连接时一切照常（本地模拟模式），连接成功自动切换。
 * 后续接 Modbus/PLC：只需在 server.py 的 DataSource 实现读写，前端零改动。
 */
import { bus } from '../core/eventBus.js';
import { WsChannel, ChannelDown, RequestTimeout } from './wschannel.js';

/** 前端用到的后端能力：少任何一个都说明「后端没重启」，必须提示 */
export const REQUIRED_FEATURES = ['word_order4', 'words_by_type', 'string_range', 'orders_probe', 'page_scope',
  'protocol', 'opcua', 'opcua_browse', 'opcua_xml', 'opcua_endpoints', 'alarm_store', 'update_check',
  // keepalive：后端开了 HTTP/1.1 连接复用。列在这里是**故意的** —— 老后端不改代码的话，
  // 写变量（脚本每秒十几发）会一个请求新建一条 TCP + 一个后端线程 + 一个 TIME_WAIT，
  // 跑一晚上能把两边的内存拖爆（现场就是"跑一晚 6 个 G"）。所以必须让"没重启后端"当场可见。
  'keepalive'];

/** 后端最好有、缺了也能跑的能力（会自动退回 HTTP/SSE，只是请求多一点，所以要提示但不拦） */
export const NICE_FEATURES = ['websocket'];

/** 这个页面的身份（每次打开随机一个）：用来向后端登记「我在看运行画面」。
 *  后端按 client 记账 —— 多个页面同时开着时，一个页面退出运行态不会把别人的采集关掉。 */
const CLIENT_ID = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const POLL_BEAT_MS = 10000;        // 心跳间隔（后端 30 秒没收到就当这个页面没了）

function baseUrl() {
  if (location.protocol.startsWith('http')) return location.origin;
  return 'http://localhost:8866';   // file:// 直开时尝试本机后端
}

/**
 * 把后端回的写失败包成一个 Error，并**带上 kind**。
 *
 * kind：`'link'` = 设备这一下不通（掉线 / socket 超时 / 连不上 / OPC UA 没连上）；
 *       `'var'`  = 地址无效 / 只读区 / 节点被拒 / 变量没在变量表声明。
 *
 * ⚠ 为什么不让前端去猜错误文本（"timed out"、"连不上"…）：文本是给现场看的人话，
 *   措辞一改，判断就**悄悄**失效了 —— 而这条判断决定"设备断了之后要不要继续下发"，
 *   猜错的代价是一串超时排队（现场表现就是"断开时前面数据还在下发，弹完才停"）。
 *   所以这个区分由后端算好一起送过来（见 server/core/varapi.py 的 _err_kind）。
 */
function writeFail(j, fallback) {
  const e = new Error((j && (j.error || j.message)) || fallback);
  e.kind = (j && j.kind) || '';
  return e;
}

export const backend = {
  state: 'offline',   // 'online' | 'offline'
  _es: null,
  _channel: null,      // WebSocket 长连接（api/wschannel.js）；后端不支持时一直是 null
  _varFp: null,        // 已下发给后端的变量表指纹
  _declarePromise: null,   // 正在下发的地址映射（写变量前要等它，避免用到旧地址）
  _onVar: null,        // 推送回调（startEvents 注册；两条通道共用）
  _onVars: null,
  _plcStatus: null,    // 长连接推来的最新设备状态（getPlc 直接拿它，不再 HTTP 问）
  _plcStatusAt: 0,     // 上面那份是什么时候到的（太旧就别用，免得界面停在过去）
  _plcCfg: null,       // 长连接 hello 里带来的连接配置
  _pollWanted: false,  // 这个页面想不想让后端采设备（重连之后要重报）
  build: '',           // 后端 build 标记（/api/health）
  features: [],        // 后端能力表：用来发现「后端忘了重启」
  version: null,       // 当前版本 {version,date,notes,build,url}（/api/health 里的 version，见 version.json）
  update: null,        // 最近一次更新检查结果（/api/update/check，见 editor/updateCheck.js）
  lastUpdate: null,    // 上一次「立即更新」的落地结果（/api/health 的 update.last：ok / rolled_back / failed）
  opcua: { available: false, import_error: '', install: '', default_ns: 4 },   // /api/health 里的 OPC UA 可用性
  plcInfo: { protocol: 'modbus', endpoint: '', security: 'none', username: '', default_ns: 4 },  // 当前连接方式
  /** 当前**设备链路**状态：{ mode:'memory'|'plc'|'opcua', online:bool }
   *  谁问到了后端状态就顺手更新它（setPlcInfo）。变量存储拿它当"链路门"的依据：
   *  接真设备时**没连上不发写请求**、**连上后先读到数据才允许操作**（见 runtime/varstore.js）。 */
  plcLink: { mode: '', online: false },

  isOnline() { return this.state === 'online'; },

  /** 现在连的是哪种协议（变量表地址该按 NodeId 还是按 %MW 校验/提示，全看它） */
  protocol() { return this.plcInfo?.protocol === 'opcua' ? 'opcua' : 'modbus'; },
  isOpcua() { return this.protocol() === 'opcua'; },

  /* ── WebSocket 长连接 ──
     这一层是「稳态零轮询」的关键：连上之后设备状态由后端每秒推、写变量走这条连接、
     「我在看运行画面」的登记也绑在连接上（断线自动注销，不用前端发心跳）。
     ⚠ 所有对外的方法（getPlc / writeVar / setPolling …）都保持原样：
       能用长连接就用，不能就用 HTTP —— 调用方一行都不用改，也就不会出现
       「有的地方忘了改所以还在轮询」。 */
  _ensureChannel() {
    if (this._channel || !WsChannel.supported()) return this._channel;
    if (!this.supports('websocket')) return null;      // 旧后端：老实走 HTTP + SSE
    this._channel = new WsChannel({
      onHello: h => {
        if (h.build) this.build = h.build;
        if (Array.isArray(h.features)) this.features = h.features;
        if (h.cfg) this._plcCfg = h.cfg;
        if (h.status) this._onStatus(h.status);
      },
      onStatus: st => this._onStatus(st),
      onVar: (n, v) => { try { this._onVar?.(n, v); } catch { /* 忽略 */ } },
      onVars: v => { try { this._onVars?.(v); } catch { /* 忽略 */ } },
      onAlarm: a => bus.emit('alarms:remote', a),
      onOpen: ({ first }) => {
        // 重连之后必须补三件事，否则界面会停在断线前的状态：
        //   ① 全量补读（断线期间变过的变量不会补发）② 重报采集范围 ③ 重报「我在看运行画面」
        this._stopSse();                              // 长连接起来了，SSE 兜底可以撤了
        this._stopBeat();                             // 也把 HTTP 心跳停掉（登记改由连接续命）
        if (this._onVar || this._onVars) this.resyncAll(this._onVar);
        this._replayDeclare();
        this._replayPoll();
        if (!first) bus.emit('backend:reconnect', { first });
        this.paintStatusBar();
      },
      onClose: () => {
        this._plcStatus = null;
        this._startSse();                      // 长连接没了：先退回 SSE，别让界面停摆（没订阅就自动跳过）
        this.paintStatusBar();
      },
    });
    this._channel.start();
    bus.emit('backend:ws', { state: 'connecting' });
    return this._channel;
  },

  /** 后端推来的设备状态：更新链路状态 + 通知等着的人（原来这些信息靠每 3 秒 GET /api/plc） */
  _onStatus(st) {
    if (!st || typeof st !== 'object') return;
    this._plcStatus = st;
    this._plcStatusAt = Date.now();
    this.setPlcInfo(st);
    bus.emit('plc:status', st);
  },

  /** 这台机器上的长连接状态（诊断：`app.backend.wsStats()`） */
  wsStats() { return this._channel ? this._channel.info() : { state: 'unsupported' }; },

  /** 长连接通着没（写值/登记走它） */
  _wsLive() { return !!(this._channel && this._channel.isOpen()); },


  /** 从一份 PLC 配置/状态里更新「当前连接方式」（状态栏、变量表、连接对话框都用它） */
  setPlcInfo(src) {
    if (!src) return this.plcInfo;
    // 设备链路状态（模式 + 在线）也在这儿更新：调用方拿到 /api/plc 的状态就算喂过了
    if (src.mode) this.plcLink = { mode: String(src.mode), online: !!src.online };
    const prev = this.plcInfo.protocol;
    const proto = String(src.protocol || (src.mode === 'opcua' ? 'opcua' : '') || '').toLowerCase();
    if (proto) this.plcInfo.protocol = proto === 'opcua' ? 'opcua' : 'modbus';
    for (const k of ['endpoint', 'security', 'username', 'default_ns']) {
      if (src[k] !== undefined && src[k] !== '') this.plcInfo[k] = src[k];
    }
    // 协议换了要喊一声：变量表的地址提示/占位、「从 OPC UA 导入…」按钮都只认当前协议，
    // 不喊的话换了协议变量表还是老样子（看着像"选了没生效"）
    if (this.plcInfo.protocol !== prev) bus.emit('plc:protocol', { protocol: this.plcInfo.protocol });
    return this.plcInfo;
  },

  /** 现在这条链路是不是**接了真设备**（Modbus PLC / OPC UA）——内存模拟、后端离线都不算。
   *
   *  ⚠ 判据是 **mode**（后端配置说了算：mode='plc'/'opcua'），**不是 online**：
   *    设备暂时断了仍然是"接设备"模式 —— 这一条是"接 PLC 的模式下不许悄悄退化成
   *    内部变量/仿真模式"的执行点（见 runtime 的 dataMode / scriptEngine 的 hmi.sim()）。 */
  isDeviceMode() {
    const m = (this.plcLink || {}).mode;
    return m === 'plc' || m === 'opcua';
  },

  /** 设备名字（提示语里用）：`PLC` / `OPC UA` */
  deviceName() {
    const m = (this.plcLink || {}).mode;
    return m === 'opcua' || this.plcInfo?.protocol === 'opcua' ? 'OPC UA' : 'PLC';
  },

  /** 设备在哪（IP:端口 / OPC UA 端点）——左下角提示和掉线条都用它 */
  deviceWhere() {
    const st = this._plcStatus || {};
    if ((this.plcLink || {}).mode === 'opcua' || st.mode === 'opcua') {
      return st.endpoint || this.plcInfo?.endpoint || '（OPC UA）';
    }
    return st.host ? `${st.host}:${st.port}` : (this.plcInfo?.endpoint || '');
  },

  /**
   * 一次下发**链路**失败（掉线 / 超时）→ 当场把这条链路判成断开。
   *
   * 为什么不等着下一次状态推送：设备状态是后端每秒推一次（退回 HTTP 时运行态每 3 秒问一次），
   * 在还没收到那条推送的窗口里，前端仍然以为"还连着" —— 这期间**每一笔写**都会各自去等一个
   * socket 超时（Modbus 1.5 秒）。脚本一个周期写十几个量时，这些超时叠起来就是现场看到的
   * 「断开之后前面数据还在下发，一条条弹失败弹完才停」。
   * 写不通 = 现在不通，直接按事实改状态，链路门（varStore.linkBlockReason）立刻生效。
   */
  noteDeviceDown(message) {
    const l = this.plcLink || {};
    if (!(l.mode === 'plc' || l.mode === 'opcua')) return;   // 内存模拟跟设备没关系，别乱改
    if (this._plcStatus) {
      this._plcStatus = { ...this._plcStatus, online: false, last_error: message || this._plcStatus.last_error };
      this._plcStatusAt = Date.now();
    }
    if (!l.online) return;
    this.plcLink = { mode: l.mode, online: false };
    bus.emit('plc:status', this._plcStatus || { mode: l.mode, online: false });
  },

  /** 页面是后端（http/https）给的 → 应该能写；file:// 直开属于纯本地模拟，不用瞎发写请求 */
  expectsServer() { return location.protocol.startsWith('http'); },

  async probe(timeout = 1500) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const r = await fetch(baseUrl() + '/api/health', { signal: ctrl.signal });
      clearTimeout(t);
      const j = await r.json();
      this.build = j.build || '';                    // 后端构建标记
      this.features = Array.isArray(j.features) ? j.features : [];   // 后端能力表
      if (j.version) this.version = j.version;       // 当前版本（version.json）——状态栏要显示它
      if (j.update) this.lastUpdate = j.update.last || null;   // 上次更新成没成（回滚了要能说出来）
      if (j.opcua) this.opcua = { ...this.opcua, ...j.opcua };       // OPC UA 靠 asyncua，缺了要能说清楚
      if (j.auth) this.auth = j.auth;                                // 登录闸门开着没、现在登录着没
      if (j.plc) this.setPlcInfo(j.plc);
      if (j.plc) { this._plcStatus = j.plc; this._plcStatusAt = Date.now(); }
      this._setState(j.ok ? 'online' : 'offline');
      // 探测成功就顺手把长连接拉起来：**编辑器也要连**（它的 PLC 状态灯、变量表改值
      // 都指着这条连接免掉轮询），不是只有运行页才连。
      if (j.ok) this._ensureChannel();
      return j;
    } catch {
      this._setState('offline');
      return null;
    }
  },

  /** 后端是否具备某个能力。旧后端会把新参数静默当默认值用掉 —— 必须能当场发现 */
  supports(feature) {
    return this.features.includes(feature);
  },

  /** 缺少的能力（用来提示「后端是旧版本，请重启服务」）*/
  missingFeatures(need = []) {
    return need.filter(f => !this.supports(f));
  },

  /** 状态栏那颗「后端」小灯。⚠ 后端是旧版本时要显眼提示重启：
   *  旧后端把字序/字长/字符串长度这些新参数静默当默认值用掉，
   *  现场表现就是「int 能传、real 传不对」，极难自己查出来。*/
  paintStatusBar() {
    const st = document.getElementById('stBackend');
    if (!st) return;
    if (!this.isOnline()) {
      st.textContent = '后端：离线(模拟)';
      st.className = 'st-dot offline';
      st.title = 'Python 后端连接状态（离线时用本地模拟数据）';
      return;
    }
    const missing = this.missingFeatures(REQUIRED_FEATURES);
    if (missing.length) {
      st.textContent = '后端：旧版本(需重启)';
      st.className = 'st-dot offline';
      st.title = `后端还是旧版本，缺功能：${missing.join('、')}\n`
        + '关掉后端重新运行 start_server.bat（前端刷新页面即可）。\n'
        + '旧后端会把字序 / 字长 / 字符串长度这些新参数静默当默认值用掉 —— '
        + '「int 能传、real 传不对」多半就是这个原因。';
    } else {
      const sc = this.scope;
      const running = this._pollOn === true;      // 这个页面向后端登记过「在看运行画面」
      const idle = !running || this.pollPaused === true;
      const n = sc && sc.scoped ? `${sc.active} 变量/${sc.blocks} 块` : '';
      if (idle) {
        // 编辑态：后端不采设备（现场要求）。数字是**预览**（编辑器把这一页的采集范围下发给后端算出来的），
        // 意思是"运行起来会采这么多"。状态栏不再挂「未通讯」字样（现场要求：那句话说一次就够，
        // 一直挂着反而像出故障），点这颗灯能切「编辑态也一直采」。
        st.textContent = '后端：在线' + (n ? ` · 该页 ${n}` : '');
        st.className = 'st-dot ' + (this._alwaysPoll === true ? 'online' : 'idle');
      } else {
        st.textContent = '后端：在线' + (n ? ` · 本页 ${n}` : '');
        st.className = 'st-dot online';
      }
      st.title = `Python 后端连接状态（build ${this.build || '?'}）`
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
    }
  },

  /** 状态栏提示里关于「通讯方式」的那段 ——
   *  现场排查「怎么还在刷请求」时，这一行直接给出答案：走的是长连接还是退回轮询了。*/
  _channelTip() {
    const ch = this._channel;
    if (!ch) {
      return this.supports('websocket')
        ? '\n（长连接正在建立…）'
        : '\n通讯：HTTP + SSE 轮询（这个后端没有 WebSocket 能力 —— '
          + '重启后端用上 build 2026-10-07 起的版本就没有轮询了）';
    }
    const i = ch.info();
    if (i.open) {
      return `\n通讯：长连接（WebSocket）· 收到 ${i.frames} 帧 / 发出 ${i.sent} 帧`
        + (i.reconnects ? ` · 重连过 ${i.reconnects} 次` : '');
    }
    return `\n通讯：长连接 ${i.state === 'connecting' ? '正在重连' : '已断开'}`
      + `（后端推不出数据时会自动降级到 HTTP + SSE，不会停摆）`;
  },

  /** 告诉后端「有人在看运行画面 / 没人看了」。
   *
   *  现场要求：**不在运行态就别跟设备通讯**。后端只对「登记过、并且心跳还新鲜」的页面轮询设备；
   *  进运行态登记，退出运行态 / 关页面就注销 —— 一个都不剩时后端停采，连都不连。
   *  所以编辑器里改画面不会占着 PLC 通讯口。
   *
   *  ⚠ **走长连接时不用心跳**：连接本身就是登记（后端按连接续命，断开自动注销）。
   *    以前是每 10 秒一个 POST /api/poll，一个页面一小时 360 个请求 —— 现在一个都没有。
   *    只有退回 HTTP 模式（旧后端 / 长连接没连上）才保留那套心跳。 */
  setPolling(on) {
    this._pollWanted = !!on;
    this._pollOn = !!on;
    const ch = this._channel;
    if (this._wsLive()) {
      this._stopBeat();                       // 长连接在：把 HTTP 心跳停掉
      const req = ch.request({ t: 'poll', on: !!on }).then(j => {
        this._alwaysPoll = !!j.always;
        this.pollPaused = !!j.paused;
        this.paintStatusBar();
        return j;
      }).catch(() => this._pollViaHttp(on));  // 长连接刚断：退回 HTTP，别把登记丢了
      this._pollReq = req;
      return req;
    }
    return this._pollViaHttp(on);
  },

  /** HTTP 版的登记（含 10 秒心跳）——只在没有长连接时用 */
  _pollViaHttp(on) {
    const body = { on: !!on, client: CLIENT_ID };
    if (on) {
      if (!this._pollTimer) {
        this._pollTimer = setInterval(() => this._pollViaHttp(true), POLL_BEAT_MS);
        this._pollVis = () => { if (this._pollOn) this._pollViaHttp(true); };
        document.addEventListener('visibilitychange', this._pollVis);
        window.addEventListener('focus', this._pollVis);
      }
    } else {
      this._stopBeat();
    }
    const send = () => fetch(baseUrl() + '/api/poll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json())
      .then(j => { this._alwaysPoll = !!j.always; this.pollPaused = !!j.paused; this.paintStatusBar(); return j; })
      .catch(() => null);
    this._pollReq = send();
    return this._pollReq;
  },

  _stopBeat() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._pollVis) {
      document.removeEventListener('visibilitychange', this._pollVis);
      window.removeEventListener('focus', this._pollVis);
      this._pollVis = null;
    }
  },

  /** 长连接重连之后把「我在看运行画面」重报一次（新手连接什么都不知道） */
  _replayPoll() {
    if (!this._wsLive()) return;
    this._channel.request({ t: 'poll', on: this._pollWanted === true })
      .then(j => { this._alwaysPoll = !!j.always; this.pollPaused = !!j.paused; this.paintStatusBar(); })
      .catch(() => { /* 下次重连还会再报 */ });
  },

  /** 长连接重连之后把采集范围重报一次（后端这份注册只活在连接上） */
  _replayDeclare() {
    if (!this._wsLive() || !this._lastDeclare) return;
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

  /** 状态栏那颗灯点一下：切「编辑态也一直采设备」（改画面时也想看 PLC 上的值就用它）。
   *  后端是个全局开关：开了之后不管有没有人在运行态都轮询设备。 */
  toggleAlwaysPoll() {
    const on = !this._alwaysPoll;
    const done = j => {
      this._alwaysPoll = !!j.always;
      this.pollPaused = !!j.paused;
      this.paintStatusBar();
      return j;
    };
    if (this._wsLive()) {
      return this._channel.request({ t: 'poll', on: this._pollWanted === true, always: on })
        .then(done).catch(() => this._alwaysViaHttp(on).then(done));
    }
    return this._alwaysViaHttp(on).then(done);
  },

  _alwaysViaHttp(on) {
    return fetch(baseUrl() + '/api/poll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ always: on }),
    }).then(r => r.json()).catch(() => ({}));
  },

  /** 页面要关了：注销一下，别让后端白采 30 秒。
   *
   *  ⚠ 走长连接时**什么都不用做**：浏览器关页面会自动关掉 WebSocket，
   *    后端收到断开就把这条登记注销了（见 server.py 的 _ws_on_close）。
   *    以前这里要发一个 sendBeacon —— 而且页面被强杀时它还发不出去，后端要白采 30 秒。 */
  leavePolling() {
    this._pollWanted = false;
    if (this._wsLive()) return;
    try {
      const blob = new Blob([JSON.stringify({ on: false, client: CLIENT_ID })],
        { type: 'application/json' });
      navigator.sendBeacon?.(baseUrl() + '/api/poll', blob);
    } catch { /* 忽略 */ }
  },

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    bus.emit('backend:status', { state: s });
  },

  async readVars() {
    // 长连接优先：全量读也走它（重连补账、链路恢复补读都用得上）——少一个 HTTP 请求
    if (this._wsLive()) {
      try {
        const j = await this._channel.request({ t: 'vars' });
        if (j && j.ok !== false) return j.vars || {};
      } catch { /* 长连接出问题 → 退回 HTTP */ }
    }
    const r = await fetch(baseUrl() + '/api/vars');
    const j = await r.json();
    return j.vars || {};
  },

  /** 连接成功后同步变量表（名称/类型/地址）到后端，供其映射寄存器
   *  active：本页要采集的变量名（按页采集，不传 = 全部） */
  async declareVariables(variables, active) {
    // 记下来：长连接断了重连之后要重报一次（后端那份注册只活在连接上）
    this._lastDeclare = { variables, active: Array.isArray(active) ? active : null };
    const apply = j => {
      if (j && j.ok !== false) {
        // 状态栏要显示「本页采几个变量 / 合并成几次读」
        this.scope = { active: j.active, blocks: j.blocks, scoped: !!j.scoped };
        this.paintStatusBar();
      }
      return true;
    };
    if (this._wsLive()) {
      try {
        const body = { t: 'declare', variables };
        if (Array.isArray(active)) body.active = active;
        return apply(await this._channel.request(body));
      } catch { /* 长连接出问题 → 退回 HTTP */ }
    }
    try {
      const body = { variables };
      if (Array.isArray(active)) body.active = active;
      const r = await fetch(baseUrl() + '/api/vars/declare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) return false;
      return apply(await r.json().catch(() => null));
    } catch { return false; }        // 非致命：后端没开也要能继续本地模拟
  },

  /** 只问「这一页会采几个变量 / 几块」——**不动后端的变量表**（编辑器切页面预览用）。
   *
   *  ⚠ 这里不能用 syncVarTable：那会把编辑器这份变量表整个推给后端，可能覆盖掉
   *  别的标签页 / 现场运行页正在用的那份（后端的表只能由真正在运行的那份工程说了算）。 */
  async previewScope(active) {
    const names = Array.isArray(active) ? active : [];
    const apply = j => {
      if (j && j.ok !== false) {
        this.scope = { active: j.active, blocks: j.blocks, scoped: !!j.scoped };
        this.paintStatusBar();
      }
      return true;
    };
    if (this._wsLive()) {
      try {
        return apply(await this._channel.request({ t: 'declare', active: names }));
      } catch { /* 长连接出问题 → 退回 HTTP */ }
    }
    try {
      const r = await fetch(baseUrl() + '/api/vars/declare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: names }),
      });
      if (!r.ok) return false;
      return apply(await r.json().catch(() => null));
    } catch { return false; }
  },

  /** 变量表「名称|类型|地址|保持」指纹 + 本页采集范围，用来判断要不要重新下发 */
  _varFingerprint(variables, active) {
    const scope = Array.isArray(active) ? [...active].sort().join(',') : '*';
    return (variables || []).map(v => `${v.name}|${v.type}|${v.address || ''}|${v.retain ? 1 : 0}`).join(';') + '#' + scope;
  },

  /** 变量表一变、或切了页面（采集范围变了）就重新下发地址映射（指纹相同则跳过）
   *  ⚠ 以前只有「进入运行态」和「连接 PLC」时下发：连着 PLC 时改地址、加变量，
   *    后端还在按旧映射读写 —— 改了像没改，必须断开重连才生效。*/
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

  /** 写变量值。opts.internal=true 表示「这是 HMI 自己的内部变量（地址留空）」——
   *  后端据此就不把它当 PLC 变量：表里还没这个名字时按内部变量就地收下，不报「未在变量表声明」。
   *  opts.from='script' 表示这次写是**脚本**发起的：后端不往控制台打 `[var] …`
   *  （脚本可能每 100ms 写一次，那行日志会刷爆 cmd；控制台只留人在触摸屏上的操作记录）。
   *
   *  ⚠ 这是以前请求量最大的地方（**一次写一个 POST**，脚本一秒钟十几发）。
   *    走长连接之后它在既有的那条 TCP 上发一个几十字节的帧就完事，不新建请求。 */
  async writeVar(name, value, opts = {}) {
    // 变量表刚改过 → 先等地址映射下发落地，再写值：
    // 「改完地址马上点按钮」必须写新地址，不能因为两个请求谁先到而写错地方
    if (this._declarePromise) {
      try { await this._declarePromise; } catch { /* 下发失败也照写，让错误在写的时候暴露 */ }
    }
    const body = { name, value };
    if (opts.internal) body.internal = true;
    if (opts.from) body.from = opts.from;
    if (this._wsLive()) {
      let j = null;
      try {
        j = await this._channel.request({ t: 'write', ...body });
      } catch (e) {
        // ⚠ 只有「连接本身出问题」才退回 HTTP 重试一次。
        //   后端明确回了 ok:false（地址无效 / 从站异常 / 没在变量表声明）是业务失败 ——
        //   退回去重试只会把同一条错再犯一遍，还会让现场看到两次报错。
        //   ⚠ **等应答超时**（RequestTimeout）也**绝不能**退：那说明后端正卡在设备 I/O 上，
        //     再灌一堆 HTTP 过去只会让后端每个请求新起一个线程、越堆越多
        //     （实测：设备一断，退化成每秒 200 多个 HTTP 请求，内存跟着涨一下）。
        //     超时本身就是"设备这一下不通"，直接抛给 varstore 去判掉线（它带 kind='link'）。
        if (e instanceof RequestTimeout) throw e;
        if (!(e instanceof ChannelDown)) throw e;
        j = null;
      }
      if (j) {
        if (j.ok === false) throw writeFail(j, '写入失败');
        return j;
      }
    }
    const r = await fetch(baseUrl() + '/api/vars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 后端把「地址无效 / 从站异常 / 站号不匹配」这类原因放在 error 里，
    // 只抛 HTTP 400 会把最有用的信息丢掉，用户就查不出为什么 PLC 没变
    let j2 = null;
    try { j2 = await r.json(); } catch { /* 非 JSON 响应 */ }
    if (!r.ok || (j2 && j2.ok === false)) {
      throw writeFail(j2, `HTTP ${r.status}`);
    }
    return j2;
  },

  /** 批量写（脚本一个周期写一堆变量时用）：**一次**往返写多个。
   *  以前是 N 个 POST，现在是一个帧。返回结果数组（与入参同序）。 */
  async writeVarsBatch(items, from = 'script') {
    if (!Array.isArray(items) || !items.length) return [];
    if (this._declarePromise) {
      try { await this._declarePromise; } catch { /* 忽略 */ }
    }
    if (this._wsLive()) {
      try {
        const j = await this._channel.request(
          { t: 'writes', items: items.map(it => ({ ...it, from })) }, 8000);
        if (j && Array.isArray(j.results)) {
          return j.results.map(r => (r && r.ok === false
            ? { ok: false, error: r.error || '写入失败', kind: r.kind || '' }
            : { ok: true }));
        }
      } catch (e) {
        // 同上：等应答超时**不要**退回逐个 HTTP 写（那会把一次批量放大成 N 个请求 + N 个线程）
        if (e instanceof RequestTimeout) throw e;
        /* 长连接真断了 → 退回逐个 HTTP 写 */
      }
    }
    const out = [];
    for (const it of items) {
      try {
        await this.writeVar(it.name, it.value, { internal: it.internal, from });
        out.push({ ok: true });
      } catch (e) {
        out.push({ ok: false, error: (e && e.message) || String(e), kind: (e && e.kind) || '' });
      }
    }
    return out;
  },

  /** 内部变量（内存模拟）恢复成变量表初值 —— 联调时把模拟值改乱了、或上一轮留下的值看着像"改了没反应" */
  async resetVars() {
    const r = await fetch(baseUrl() + '/api/vars/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let j = null;
    try { j = await r.json(); } catch { /* 非 JSON 响应 */ }
    if (!r.ok || (j && j.ok === false)) throw new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
    return (j && j.vars) || {};
  },

  /**
   * 脚本日志落盘（运行态把 hmi.log/warn/错误按批送过来，后端写 logs/script-YYYY-MM-DD.log）。
   * ⚠ 调用方（scriptEngine）已经限速、限批、限总量了，这里就一个 POST；失败**不上抛**
   *   —— 日志送不出去绝不能影响脚本本身和界面（后端没开、断网、旧版后端都当"这批发丢了"）。
   */
  async sendScriptLog(lines) {
    if (!Array.isArray(lines) || !lines.length) return null;
    try {
      const r = await fetch(baseUrl() + '/api/scriptlog', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      });
      const j = await r.json().catch(() => null);
      return (j && j.ok) ? j : null;
    } catch { return null; }              // 后端没开/旧版后端（404）都走这儿
  },

  /** 读服务器上落盘的脚本日志（?date= 看哪天、?limit= 最多几行）。读不到就返回 null（界面上说一句"没读到"） */
  async readScriptLog(date = '', limit = 300) {
    try {
      const q = new URLSearchParams();
      if (date) q.set('date', date);
      q.set('limit', String(limit));
      const r = await fetch(baseUrl() + '/api/scriptlog?' + q.toString(), { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      return (j && j.ok) ? j : null;
    } catch { return null; }
  },

  /**
   * 日志设置（**这台机器**的：日志保留天数 / 脚本日志每天上限）——「工程 ▾ → 日志设置…」用。
   * 存在服务器的 `settings.json` 里，后端读它决定清哪些日志、脚本日志写到多大就停；要管理员权限。
   * 读不到（后端没开 / 旧版后端没这个接口 / 没登录）返回 null，由调用方说明白。
   */
  async logSettings() {
    try {
      const r = await fetch(baseUrl() + '/api/logsettings', { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      return (j && j.ok) ? j : null;
    } catch { return null; }
  },

  /** 存日志设置（后端会把值夹到合法范围，改完立刻生效、不用重启） */
  async saveLogSettings(patch) {
    const r = await fetch(baseUrl() + '/api/logsettings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || (j && j.ok === false)) {
      throw new Error((j && (j.error || (j.need_login ? '要管理员登录才能改日志设置' : ''))) || `HTTP ${r.status}`);
    }
    return j;
  },

  /** 检查有没有新版本（后端去拉远端 version.json 跟本地的比）。
   *  force=true = 忽略缓存当场再拉一次（「检查更新」按钮走这条）。
   *  ⚠ **拉不到不算失败**：现场机常常没外网 —— 返回里的 state:'error' + error 说明原因，
   *    调用方据此显示「这次没查到」，不要当异常抛、更不要弹错误框。*/
  async checkUpdate(force = false) {
    const r = await fetch(baseUrl() + '/api/update/check' + (force ? '?force=1' : ''), { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`HTTP ${r.status}`);
    this.update = j;
    if (j.local) this.version = { ...(this.version || {}), ...j.local, build: this.build || j.local.build };
    return j;
  },

  /** 「立即更新」：让后端下载新版代码、只覆盖代码、然后自己重启（要管理员登录）。
   *  ⚠ 后端**发完这个响应就会退出**：调用方收到 ok 之后要开始等它回来
   *    （见 editor/updateCheck.js 的 waitBackendBack），别以为是自己断线了。
   *  ⚠ 失败时返回 {ok:false, error}（不抛）：连不上更新源、已经是最新、正在更新中… 都要说清楚。*/
  async applyUpdate() {
    const r = await fetch(baseUrl() + '/api/update/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    let j = null;
    try { j = await r.json(); } catch { /* 后端已经退出：连接被断开也是有可能的 */ }
    if (!j) throw new Error(r.status === 401 ? '需要管理员登录' : `HTTP ${r.status}`);
    return j;
  },

  /** 现在登录着没（现场运行页要改 PLC 连接前先问这一句） */
  async session() {
    const r = await fetch(baseUrl() + '/api/session');
    const j = await r.json().catch(() => null);
    if (j) this.auth = { ...(this.auth || {}), enabled: !!j.auth_enabled, logged_in: !!j.logged_in };
    return j || { auth_enabled: false, logged_in: true };
  },

  /** 管理员登录（成功后就带着会话 cookie 了：改连接/改配置的请求才放行） */
  async login(password) {
    const r = await fetch(baseUrl() + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    let j = null;
    try { j = await r.json(); } catch { /* 非 JSON 响应 */ }
    if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || `HTTP ${r.status}`);
    if (this.auth) this.auth.logged_in = true;
    // ⚠ 长连接是**登录之前**建立的，它那份配置里没有口令（后端只把口令发给登录过的连接，
    //   见 server.py 的 _plc_cfg_for）。所以登录成功之后要把缓存丢掉，
    //   下一次 getPlc() 走 HTTP —— 那时请求已经带着会话 cookie，才能把口令带回来
    //   （连接对话框靠它把上次配好的账号密码填回去，不然现场每次重连都得重新敲一遍）。
    this._plcCfg = null;
    this._plcStatus = null;
    return true;
  },

  /** 注销（共用一台机器时别把编辑权限留在浏览器里） */
  async logout() {
    await fetch(baseUrl() + '/api/logout', { method: 'POST' }).catch(() => { /* 后端没了也无所谓 */ });
    if (this.auth) this.auth.logged_in = false;
    this._plcCfg = null;      // 同上：这份缓存里刚才还带着口令，注销后不能再留着
    return true;
  },

  /** 全量读一遍，逐个回调 —— 推送链（重）连上后「补账」用。
   *  为什么必须有：推送只推**变化**，断线那段时间里变过的变量**不会补发**，
   *  不补读界面就永远停在旧值上 —— 现场看着就是「只读了一次，后面就不动了」。
   *  后端一直在轮询、值也一直在涨，但前端这条推送链断了就再也收不到。 */
  resyncAll(onVar) {
    return this.readVars()
      .then(v => { for (const [n, val] of Object.entries(v || {})) onVar(n, val); })
      .catch(() => { /* 后端没开就算了，下次重连还会补 */ });
  },

  /** 订阅变量推送。
   *
   *  **首选长连接**：后端支持（有 websocket 能力）就什么都不用做 —— 通道早就起来了，
   *  这里只是把回调交给它。连接断了它会自动重连，重连时由 onOpen 补一次全量。
   *  **退回 SSE**：旧后端没有 WebSocket 时用老路子（浏览器 EventSource + 30 秒兜底轮询）。
   *
   *  ⚠ 两条路都不通也不能不订阅：后端连不上时前端照旧本地模拟跑。 */
  startEvents(onVar, onVars) {
    this.stopEvents();                   // 会清掉回调，所以先 stop 再设
    this._onVar = onVar || null;
    this._onVars = onVars || null;
    const ch = this._ensureChannel();
    if (ch) {
      if (ch.isOpen()) return;           // 已经连上了：直接用，onOpen 会把 SSE 关掉
      // 正在建立：给它 2.5 秒。连上了 onOpen 会关掉 SSE；一直连不上（被代理拦了 /
      // 端口不通 / 浏览器禁了 ws）就退回 SSE —— 画面不能因为长连接起不来就停在旧值。
      clearTimeout(this._sseFallbackTimer);
      this._sseFallbackTimer = setTimeout(() => {
        if (!this._wsLive()) this._startSse();
      }, 2500);
      return;
    }
    // 后端根本没这个能力（旧后端）→ 直接退回 SSE
    this._startSse();
  },

  /** 退回 SSE（长连接不可用、或长连接断了先兜着） */
  _startSse() {
    if (this._es || (!this._onVar && !this._onVars)) return;
    if (typeof EventSource !== 'function') return;
    const onVar = this._onVar, onVars = this._onVars;
    try {
      this._es = new EventSource(baseUrl() + '/api/events');
      this._esOpened = false;
      this._es.onopen = () => {
        if (this._esOpened) this.resyncAll(onVar);   // 首次由 enterRun 的 readVars 负责
        this._esOpened = true;
      };
      this._es.onmessage = ev => {
        try {
          const j = JSON.parse(ev.data);
          if (!j) return;
          // 报警记录变更（另一个地址/浏览器上刚记了一条、补了恢复时间、或清了记录）：
          // 转成事件让报警引擎把本地这份也跟着更新，不用刷新页面
          if (j.alarm) { bus.emit('alarms:remote', j.alarm); return; }
          // 后端一次轮询里变了多个变量时会发一条 {"vars": {...}}（500 个变量一起变也只发一条）
          if (j.vars) { if (onVars) onVars(j.vars); else for (const n in j.vars) onVar(n, j.vars[n]); return; }
          if (j.name) onVar(j.name, j.value);
        } catch { /* 忽略心跳/坏帧 */ }
      };
      this._es.onerror = () => { /* 断线由浏览器自动重连，重连后 onopen 会补读 */ };
      // 兜底：每 30 秒拉一次全量。SSE 正常时是空转，但一旦推送链半死
      //（连接在、不推数据）30 秒内界面也能自己纠正回来。
      // ⚠ 长连接模式下**不需要**这个：通道自带看门狗（6 秒没收到帧就重连 + 补全量），
      //   比"30 秒盲补一次"又快又省。所以这个定时器只在退回模式里起。
      this._resyncTimer = setInterval(() => this.resyncAll(onVar), 30000);
    } catch { /* file:// 等不支持 SSE 的环境 */ }
  },

  _stopSse() {
    if (this._resyncTimer) { clearInterval(this._resyncTimer); this._resyncTimer = null; }
    if (this._es) { this._es.close(); this._es = null; }
    this._esOpened = false;
  },

  /** 退订（不动长连接本身 —— 编辑器之后可能还要用它读状态/写值） */
  stopEvents() {
    this._stopSse();
    this._onVar = null;
    this._onVars = null;
  },

  async saveProject(data) {
    const r = await fetch(baseUrl() + '/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
  async loadProject() {
    const r = await fetch(baseUrl() + '/api/project');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return j.data || null;
  },

  /* ── 报警历史（运行记录）──
     存服务器（server/data/alarm_history.json）而不是只放 localStorage：
     客户机上每次打开都是**新的浏览器 profile**（PyWebView 尤其明显），
     换地址（127.0.0.1 ↔ 局域网 IP）、换浏览器也都是各自一份 —— 报警记录会"消失"。
     读不用登录（运行页要显示它），写也不用（报警是运行页产生的，同写变量）。 */
  async loadAlarms() {
    const r = await fetch(baseUrl() + '/api/alarms', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j.history) ? j.history : [];
  },
  /** payload: {clear?:true, add?:[记录], patch?:[{key,at,endAt,acked}]} */
  async saveAlarms(payload) {
    const r = await fetch(baseUrl() + '/api/alarms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || (j && j.ok === false)) throw new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
    return j || {};
  },

  /* ── PLC（Modbus TCP / OPC UA）配置与状态 ── */
  /** 读设备连接配置 + 状态。
   *
   *  ⚠ **长连接在的时候这个方法一个请求都不发**：设备状态后端每秒推一次
   *    （见 server.py 的 _ws_beat_loop），直接拿缓存那份返回。
   *    这一条替掉了运行页每 3 秒、编辑器每 3 秒的 `GET /api/plc` ——
   *    调用方（runtime.js 的 plcWatchTick、toolbar.js 的 refreshPlcStatus）
   *    一行都不用改，还是照旧每 3 秒「问」一次，只是这次问的是内存。 */
  async getPlc() {
    if (this._plcStatus && this._wsLive()) {
      // 拿到推送状态后 5 秒内直接用（后端 1 秒推一次，这个窗口足够新鲜）
      if (Date.now() - this._plcStatusAt < 5000) {
        return { ok: true, config: this._plcCfg || {}, status: this._plcStatus, cached: true };
      }
    }
    const r = await fetch(baseUrl() + '/api/plc');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.config || j.status) this.setPlcInfo({ ...(j.config || {}), ...(j.status || {}) });
    // HTTP 拿到的也算缓存：中间断一下不至于让状态栏空着
    if (j.status) { this._plcStatus = j.status; this._plcStatusAt = Date.now(); }
    if (j.config) this._plcCfg = j.config;
    return j;
  },
  /** 连接：Modbus 给 {ip,port,unit,word_order}；OPC UA 给 {protocol:'opcua',endpoint,...} */
  async connectPlc(cfg) {
    const r = await fetch(baseUrl() + '/api/plc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'connect', ...cfg }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || j.message || `HTTP ${r.status}`);
    this.setPlcInfo(j.status || cfg);
    return j;
  },
  async disconnectPlc() {
    const r = await fetch(baseUrl() + '/api/plc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disconnect' }),
    });
    return r.json();
  },
  async testPlc(cfg) {
    const r = await fetch(baseUrl() + '/api/plc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test', ...cfg }),
    });
    return r.json();
  },

  /** 只读：把某个地址按 4 种字序各解一遍（现场判断对方 PLC 用哪种，不写 PLC）*/
  async plcOrders(cfg) {
    const r = await fetch(baseUrl() + '/api/plc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'orders', ...cfg }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.message) j.message = `HTTP ${r.status}`;
    return j;
  },

  /** OPC UA：端点诊断（不需要建会话）——「你是谁 / 开了哪些端点 / 接受哪种身份」 */
  async plcEndpoints(cfg) {
    const r = await fetch(baseUrl() + '/api/plc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'endpoints', protocol: 'opcua', ...cfg }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.message) j.message = j.error || `HTTP ${r.status}`;
    return j;
  },

  /** OPC UA：浏览节点树（「从服务器导入变量」用）。只读，不写任何节点 */
  async opcuaBrowse(cfg) {
    const r = await fetch(baseUrl() + '/api/opcua/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.message) j.message = j.error || `HTTP ${r.status}`;
    return j;
  },

  /** OPC UA：解析 CODESYS/Invtmatic 导出的「符号配置」XML（离线，不连服务器） */
  async opcuaParseXml(cfg) {
    const r = await fetch(baseUrl() + '/api/opcua/parse-xml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.message) j.message = j.error || `HTTP ${r.status}`;
    return j;
  },
};
