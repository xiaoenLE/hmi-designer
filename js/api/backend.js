/**
 * backend.js — Python 后端对接层
 *
 * 协议（与 server/server.py 对齐，零依赖 HTTP + SSE）：
 *   GET  /api/health            {ok, name, build, features:[…], version:{…}, vars:<变量数>, clients:<SSE 连接数>}
 *   GET  /api/update/check      检查有没有新版本（?force=1 忽略缓存）；拉不到远端不报错，见结果里的 error
 *   GET  /api/vars              {vars:{name:value,...}, meta:{name:{address,type}}}
 *   POST /api/vars              {name, value}        写变量（SSE 广播）
 *   GET  /api/events            SSE 流 data:{"name":..,"value":..}
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

/** 前端用到的后端能力：少任何一个都说明「后端没重启」，必须提示 */
export const REQUIRED_FEATURES = ['word_order4', 'words_by_type', 'string_range', 'orders_probe', 'page_scope',
  'protocol', 'opcua', 'opcua_browse', 'opcua_xml', 'opcua_endpoints', 'alarm_store', 'update_check'];

function baseUrl() {
  if (location.protocol.startsWith('http')) return location.origin;
  return 'http://localhost:8866';   // file:// 直开时尝试本机后端
}

export const backend = {
  state: 'offline',   // 'online' | 'offline'
  _es: null,
  _varFp: null,        // 已下发给后端的变量表指纹
  _declarePromise: null,   // 正在下发的地址映射（写变量前要等它，避免用到旧地址）
  build: '',           // 后端 build 标记（/api/health）
  features: [],        // 后端能力表：用来发现「后端忘了重启」
  version: null,       // 当前版本 {version,date,notes,build,url}（/api/health 里的 version，见 version.json）
  update: null,        // 最近一次更新检查结果（/api/update/check，见 editor/updateCheck.js）
  lastUpdate: null,    // 上一次「立即更新」的落地结果（/api/health 的 update.last：ok / rolled_back / failed）
  opcua: { available: false, import_error: '', install: '', default_ns: 4 },   // /api/health 里的 OPC UA 可用性
  plcInfo: { protocol: 'modbus', endpoint: '', security: 'none', username: '', default_ns: 4 },  // 当前连接方式

  isOnline() { return this.state === 'online'; },

  /** 现在连的是哪种协议（变量表地址该按 NodeId 还是按 %MW 校验/提示，全看它） */
  protocol() { return this.plcInfo?.protocol === 'opcua' ? 'opcua' : 'modbus'; },
  isOpcua() { return this.protocol() === 'opcua'; },

  /** 从一份 PLC 配置/状态里更新「当前连接方式」（状态栏、变量表、连接对话框都用它） */
  setPlcInfo(src) {
    if (!src) return this.plcInfo;
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
      this._setState(j.ok ? 'online' : 'offline');
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
      const scopeTxt = sc && sc.scoped ? ` · 本页 ${sc.active} 变量/${sc.blocks} 块` : '';
      st.textContent = '后端：在线' + scopeTxt;
      st.className = 'st-dot online';
      st.title = `Python 后端连接状态（build ${this.build || '?'}）`
        + (sc && sc.scoped
          ? `\n按页采集：本页在采 ${sc.active} 个变量，地址合并成 ${sc.blocks} 次读`
            + '\n（切页面会重新下发采集范围；实际轮询在后端跑，浏览器切到后台也不停）'
          : '');
    }
  },

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    bus.emit('backend:status', { state: s });
  },

  async readVars() {
    const r = await fetch(baseUrl() + '/api/vars');
    const j = await r.json();
    return j.vars || {};
  },

  /** 连接成功后同步变量表（名称/类型/地址）到后端，供其映射寄存器
   *  active：本页要采集的变量名（按页采集，不传 = 全部） */
  async declareVariables(variables, active) {
    try {
      const body = { variables };
      if (Array.isArray(active)) body.active = active;
      const r = await fetch(baseUrl() + '/api/vars/declare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) return false;
      const j = await r.json().catch(() => null);
      if (j && j.ok !== false) {
        // 状态栏要显示「本页采几个变量 / 合并成几次读」
        this.scope = { active: j.active, blocks: j.blocks, scoped: !!j.scoped };
        this.paintStatusBar();
      }
      return true;
    } catch { return false; }        // 非致命：后端没开也要能继续本地模拟
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

  async writeVar(name, value) {
    // 变量表刚改过 → 先等地址映射下发落地，再写值：
    // 「改完地址马上点按钮」必须写新地址，不能因为两个请求谁先到而写错地方
    if (this._declarePromise) {
      try { await this._declarePromise; } catch { /* 下发失败也照写，让错误在写的时候暴露 */ }
    }
    const r = await fetch(baseUrl() + '/api/vars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value }),
    });
    // 后端把「地址无效 / 从站异常 / 站号不匹配」这类原因放在 error 里，
    // 只抛 HTTP 400 会把最有用的信息丢掉，用户就查不出为什么 PLC 没变
    let j = null;
    try { j = await r.json(); } catch { /* 非 JSON 响应 */ }
    if (!r.ok || (j && j.ok === false)) {
      throw new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
    }
    return j;
  },

  /** 内部变量（内存模拟）恢复成变量表初值 —— 联调时把模拟值改乱了、或上一轮留下的值看着像"改了没反应" */
  async resetVars() {
    const r = await fetch(baseUrl() + '/api/vars/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let j = null;
    try { j = await r.json(); } catch { /* 非 JSON 响应 */ }
    if (!r.ok || (j && j.ok === false)) throw new Error((j && (j.error || j.message)) || `HTTP ${r.status}`);
    return (j && j.vars) || {};
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
    return true;
  },

  /** 注销（共用一台机器时别把编辑权限留在浏览器里） */
  async logout() {
    await fetch(baseUrl() + '/api/logout', { method: 'POST' }).catch(() => { /* 后端没了也无所谓 */ });
    if (this.auth) this.auth.logged_in = false;
    return true;
  },

  /** 全量读一遍，逐个回调 —— SSE（重）连上后「补账」用。
   *  为什么必须有：SSE 只推**变化**，断线那段时间里变过的变量**不会补发**，
   *  不补读界面就永远停在旧值上 —— 现场看着就是「只读了一次，后面就不动了」。
   *  后端一直在轮询、值也一直在涨，但前端这条推送链断了就再也收不到。 */
  resyncAll(onVar) {
    return this.readVars()
      .then(v => { for (const [n, val] of Object.entries(v || {})) onVar(n, val); })
      .catch(() => { /* 后端没开就算了，下次重连还会补 */ });
  },

  /** 订阅 SSE 推送，收到即回调。
   *  · onopen：每次（首次+每次重连）都补一次全量读取，断线期间的变化不会丢
   *  · 另加一个低频兜底轮询：SSE 半死（连接还在但不推了）时也能把值拉回来 */
  startEvents(onVar, onVars) {
    this.stopEvents();
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
      // 兜底：每 30 秒拉一次全量（本地 GET，开销很小）。SSE 正常时是空转，
      // 但一旦推送链半死（连接在、不推数据），30 秒内界面也能自己纠正回来。
      this._resyncTimer = setInterval(() => this.resyncAll(onVar), 30000);
    } catch { /* file:// 等不支持 SSE 的环境 */ }
  },
  stopEvents() {
    if (this._resyncTimer) { clearInterval(this._resyncTimer); this._resyncTimer = null; }
    if (this._es) { this._es.close(); this._es = null; }
    this._esOpened = false;
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
  async getPlc() {
    const r = await fetch(baseUrl() + '/api/plc');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.config || j.status) this.setPlcInfo({ ...(j.config || {}), ...(j.status || {}) });
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
