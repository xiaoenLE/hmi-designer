/**
 * varstore.js — 变量运行值存储（编辑态预览 + 运行态数据流核心）
 *
 * 数据流：
 *   本地写（控件动作/变量面板）→ set(name, v, 'local')
 *       → emit vars:changed → 各视图刷新绑定控件
 *       → backend.expectsServer() → backend.writeVar() 下发，成败发 vars:write
 *   远端推送（SSE）→ set(name, v, 'remote') → 仅刷新视图，不回写
 *
 * ─────────── 链路门（没连上不许传、连上了先读到数据才许操作）───────────
 * 接真设备（PLC / OPC UA）时的两条硬规矩（现场要求）：
 *   ① **没连上就不传**：不发写请求、也不装作写成功 —— 界面直接把值恢复成上一次读到的那份，
 *      并给一句「未下发（…）：设备没连上」；连"试一下"的请求都不发（省得刷屏 + 折腾设备）。
 *   ② **连上了也要先读到数据**：刚连上那一瞬间界面上的值还是旧的（上一次的 / 空的），
 *      这时让人去操作等于基于假值下命令 —— 所以链路一变化就重新"等一次读到数据"，
 *      读到之前写操作同样被挡，理由写明"正在把设备上的数据读下来"。
 *   内存模拟（没接设备）不受门限制：那时值本来就由 HMI 自己产生。
 *   ⚠ 内部变量（地址留空）也不受限制：它不碰设备，值就存在后端（见 server.py 的 write）。
 */
import { bus } from '../core/eventBus.js';
import { backend } from '../api/backend.js';

/** 「变量表里没有的名字」最多在 values 里留多少个（见 _noteUndeclared 的说明）。
 *  脚本临时量（`_lenAcc`、`_h1`…）只活在本地、不发请求，所以没人拦着它们往 values 里加 ——
 *  脚本要是用**算出来的名字**（`hmi.set('_h'+i, v)`）循环写，这个 map 就只涨不落。 */
const UNDECLARED_MAX = 500;

/** 「写后保护窗口」默认多少毫秒（见 set 上面那段说明）。
 *  现场要调：控制台 `app.varStore.writeHoldMs = 2000`（设备慢 / 网络远时加长）。 */
const WRITE_HOLD_MS = 1000;
/** 写后保护窗口当前是多少（现场可用 app.varStore.writeHoldMs 覆盖成别的毫秒数） */
function writeHoldMs() {
  const v = globalThis.app?.varStore?.writeHoldMs;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : WRITE_HOLD_MS;
}

class VarStore {
  constructor() {
    this.values = {};
    this.lastWriteError = null;
    this._linkKey = '';        // `${mode}|${online}`：链路状态变了才重置"读到过数据"这个标记
    this._readOnce = false;    // 这次链路状态下，**已经读到过设备数据**（读到才允许写）
    this._undeclared = [];     // 变量表里没有的名字（按写入先后），超上限就丢最早的一批
    /* ── 「本地写过什么」的账（见 set 上面那段说明）──
       _localTarget：最近一次**本地写下去的目标值**（不过期：用来判断"这次本地写到底算不算变"）
       _localAt    ：那一刻的时间戳（只用来划「写后保护窗口」，过期就作废） */
    this._localTarget = {};
    this._localAt = {};
    /* ── 回读仲裁（写后保护窗口的另一半，现场「界面亮着、设备不亮」就出在这里）──
       _pending      ：保护窗口内被丢掉的回读值先记账（读不到设备时的兜底）
       _holdTimers   ：每个变量一个"窗口到点 / 写后回读结账"定时器
       lastWriteOverridden：最近一次"写下去的值设备没保持"（PLC 程序覆盖 / 双线圈 / 不在 RUN） */
    this._pending = {};
    this._holdTimers = {};
    /* 写下去**直接被后端拒了**（只读节点、地址不支持…）：这笔已经在"下发失败"里报过了，
       回读仲裁就别再补一条「设备没保持」—— 否则兜底提示条会把「下发失败」的标题顶掉，
       测试里就抓到过：明明写被拒，画面却显示"写下去 123、设备回读 20261002"。 */
    this._localFailed = {};
    /* 还在路上的写：写请求没出结果之前不能宣布「设备没保持」——
       有的从站（OPC UA 写只读节点）响应要 1 秒多，先按回读判定会把「下发失败」
       顶成「设备没保持」（测试 verify-runtime-chrome 的写失败用例就是抓这个）。 */
    this._writes = {};
    this.lastWriteOverridden = null;
    // 内部变量判定：谁在初始化时注入（main.js 一行）—— 避免 varstore 反向依赖 project
    this.isInternalVar = () => false;
    // 「这个名字在变量表里吗」：同样由 main.js 注入。变量表里**没有**的名字 = 脚本临时量
    // （`_lenAcc` 这种），只活在 HMI 本地，一个请求都不发（见 push）。
    this.isDeclaredVar = () => true;
  }

  /**
   * 记一笔「这是个变量表里没有的名字」，并在攒太多时丢掉最早的一批。
   *
   * ⚠ 为什么不能不管：`set()` 对没声明的名字**故意**照样落地 + 广播
   *   （变量表里没有的新变量第一次写入也必须广播，否则首次按下点动按钮界面没反应）。
   *   正常脚本用的都是固定几个临时量，没问题；但脚本要是用算出来的名字循环写
   *   （`hmi.set('_h'+i, v)`），`values` 就越来越大 —— 面板机一开就是几个月不重启，
   *   这就是那种"内存一点点涨上去"的来源。
   *   **只删变量表里确实没有的**：期间被加进变量表的，一律留着。
   */
  _noteUndeclared(name) {
    if (this.isDeclaredVar(name)) return;
    this._undeclared.push(name);
    if (this._undeclared.length <= UNDECLARED_MAX) return;
    const half = UNDECLARED_MAX >> 1;
    const drop = this._undeclared.slice(0, this._undeclared.length - half);
    this._undeclared = this._undeclared.slice(-half);
    for (const n of drop) {
      if (n !== name && !this.isDeclaredVar(n)) {
        delete this.values[n];
        this._forgetTarget(n);        // "本地写过什么"的账跟着一起清（面板机一开几个月，不能只涨不落）
      }
    }
  }

  /** 从工程变量表加载初值（进入运行模式时调用） */
  resetFrom(variables) {
    this.values = {};
    this._localTarget = {};          // 换工程/重进运行态：本地写的账一笔都不留
    this._localAt = {};
    this._dropAllHolds();            // 排队中的回读结账也一起作废（否则新工程会被旧工程的值"结账"）
    variables.forEach(v => { this.values[v.name] = v.value; });
    bus.emit('vars:changed', { source: 'init', name: null });
  }

  get(name) { return this.values[name]; }
  getAll() { return { ...this.values }; }

  /**
   * 链路状态变化（谁探到谁喊一声：runtime 的 plcWatch、工具栏的 refreshPlcStatus）。
   * 状态一变（连上/断开/换设备）就**重新等一次"读到数据"** —— 这正是"连接成功后必须先读一遍"。
   */
  noteLink(mode, online) {
    const key = `${mode || ''}|${online ? 1 : 0}`;
    if (key === this._linkKey) return;
    this._linkKey = key;
    this._readOnce = false;
    // 换链路/换数据源：上一链路上排队的"回读结账"全部作废。
    // 否则内存模式写下的那笔会在切到真设备后 ~1s 到点，拿新链路的值去结账 ——
    // 新链路还没采到数据时会把界面值改成 null（verify-link-gate §2 就是这么炸的）。
    this._dropAllHolds();
  }

  /** 作废所有排队的回读结账 + 窗口记账（换链路 / 换工程时用；不动"本地写过什么"的账） */
  _dropAllHolds() {
    for (const n of Object.keys(this._holdTimers)) clearTimeout(this._holdTimers[n]);
    this._holdTimers = {};
    this._pending = {};
  }

  /** 当前让不让往设备写。返回 '' = 允许；否则是人话的原因 */
  linkBlockReason(name) {
    const dev = this._linkModeIsDevice();
    if (!dev) return '';                                  // 内存模拟：不拦
    if (this.isInternalVar(name)) return '';              // 内部变量（地址留空）：不碰设备，不拦
    // 表里没有的名字 = 脚本临时量：只在本地，跟设备一点关系都没有 → 同样不拦
    // （不这样的话，进运行态第一个周期脚本写 `_lenAcc` 就会被这道门挡下、值还被回滚成 0）
    if (typeof this.isDeclaredVar === 'function' && !this.isDeclaredVar(name)) return '';
    const l = backend.plcLink || {};
    if (!l.online) return '设备连不上（PLC / OPC UA 未连接），这次没有下发';
    if (!this._readOnce) return '刚连上，正在把设备上的数据读下来 —— 读到之后才能操作';
    return '';
  }
  /** 这条链路（真设备、在线）上还没读到过数据？→ 调用方该去读一遍（"连上先读一遍"） */
  needsFirstRead() {
    const l = backend.plcLink || {};
    return this._linkModeIsDevice() && !!l.online && !this._readOnce;
  }
  _linkModeIsDevice() {
    const m = (backend.plcLink || {}).mode;
    return m === 'plc' || m === 'opcua';
  }

  /** source: 'local' | 'remote' | 'init'；from: ''（人操作）| 'script'（脚本写的）
   *  `from='script'` 只是**告诉后端这条是脚本写的** —— 后端就不往控制台打 `[var] …` 了：
   *  脚本可能每 100ms 写一次，那行日志会把 cmd 刷爆（脚本自己用 hmi.log 记录就够了）。
   *  `opts.force`：**这条写必须发出去**（点动"松手"那种停止命令）。见下面那段说明。
   *
   *  ───────── 「本地写」的两条规矩（第 19 轮，现场：手机/触摸屏上点动偶尔松手了还在走）─────────
   *  现场现象：点动按住 → 松手 → 输出**保持**在 ON（不是每次都复现）。事件一个都没丢，
   *  丢的是**松手那笔写**：按住期间后端轮询回读到的还是写之前的旧值（写还没落到 PLC），
   *  那条旧值把界面值盖回 FALSE；松手时按老规矩一看"值没变"→ 直接 return，一个字节都不发，
   *  PLC 上那个 TRUE 就再也没人收了（界面上还亮着，因为设备上真的还是 TRUE）。
   *
   *  ① **要不要发**，看"上一次本地写下去的目标值"（_localTarget），不看当前界面值
   *     —— 界面值可能被回读的旧值盖过，目标值不会。这样松手那笔照样发得出去。
   *     重复写同一个值仍然不发（脚本定时写不会变成刷屏），这条和以前一样。
   *  ② **force**（停止/放开类命令）：跳过链路门、也不做"值没变"的早退，**一定发**。
   *     链路门（"设备没连上""刚连上还没读到数据"）是为了别拿假值去下命令；
   *     但"松手 = 停"不是基于数据下的命令，把它静默吞掉 = 机器一直走 —— 宁可发出去让后端
   *     报错（运行页那条「下发失败」会说话），也不能什么都不做。 */
  set(name, value, source = 'local', from = '', opts = {}) {
    const force = opts.force === true;
    // 未配置变量的动作（params 为空）会传来 ''/undefined/''. 直接忽略：
    // 否则 values 里会塞进 "" / "undefined" 垃圾键，还会往后端发无效写请求
    if (typeof name !== 'string' || !name) return;
    // 数组元素写法 `arrw[3]`：本地先把那个元素改掉（界面立刻对），后端按读改写处理整段；
    // 广播仍用整个数组名，绑在 arrw 上的控件（表格/文本）会一起刷新
    const m = /^(.+)\[(\d+)\]$/.exec(name);
    if (m) {
      const base = m[1], idx = Number(m[2]);
      const cur = this.values[base];
      // ⚠ 只有 base **确实是数组**时才走「写数组元素」这条路。
      //   数组被「展开成单个变量」之后，变量名本身就长这样（arrw[1]），
      //   那时 base（arrw）已经不存在了 —— 不判断就会早退：local 值不落地、
      //   也不广播 vars:changed，界面就是「按了没反应」。落到下面按普通变量名走。
      if (Array.isArray(cur)) {
        const mustSend = source === 'local' && this._markLocal(name, value, force);
        if (cur[idx] === value && !mustSend) return;
        const next = cur.slice();
        next[idx] = value;
        // 链路门：设备没连上 / 还没读到数据 → **一个字节都不发**，界面也不留这个值（force 除外）
        if (source === 'local' && !force) {
          const why = this.linkBlockReason(base);
          if (why) { this.blocked(name, value, cur, why); return; }
        }
        this.values[base] = next;
        bus.emit('vars:changed', { name: base, value: next, source });
        if (source === 'local' && backend.expectsServer()) {
          // 内存/内部数组在后端是一个变量；设备数组则让后端按元素写。
          if (!this._linkModeIsDevice() || this.isInternalVar(base)) this.push(base, next, from);
          else this.push(name, value, from, base);
        }
        return;
      }
    }
    // 值没变 → 不广播、不下发（避免后端回声成环）。
    // 变量表里没有的新变量第一次写入也必须广播，否则首次按下点动按钮界面无反应
    const mustSend = source === 'local' && this._markLocal(name, value, force);
    if ((name in this.values) && this.values[name] === value && !mustSend) return;
    // 链路门：设备没连上 / 还没读到数据 → **不传**（界面也不留这个值，见 blocked()）
    if (source === 'local' && !force) {
      const why = this.linkBlockReason(name);
      if (why) { this.blocked(name, value, this.values[name], why); return; }
    }
    this.values[name] = value;
    this._noteUndeclared(name);          // 临时量记账（攒太多会丢最早的，见那里的说明）
    bus.emit('vars:changed', { name, value, source });
    // 本地写 → 下发。⚠ 以前这里挂了 backend.isOnline()：只要开机那次探测超时过一次，
    // 之后所有写都不再下发，界面照样显示新值、PLC 一点没变，而且没有任何提示。
    // 现在照发，成败都发 vars:write 事件让状态栏显示出来（失败会自动把真实值读回来）。
    if (source === 'local' && backend.expectsServer()) this.push(name, value, from);
  }

  /** 记一笔本地写：返回"这次必须发出去吗"（见 set 上面那两条规矩）。
   *  顺带把「写后保护窗口」的起点刷新一下 —— 每次本地写都重新保护这么久。 */
  _markLocal(name, value, force) {
    const prev = this._localTarget[name];
    this._localTarget[name] = value;
    this._localAt[name] = Date.now();
    delete this._pending[name];          // 又写了一笔：上一笔记的回读账作废
    delete this._localFailed[name];      // 新写的这笔还没失败过
    return force || (prev !== undefined && prev !== value);
  }
  /** 这笔本地账作废（下发被链路门挡下 / 下发失败回读）：以后回读什么就是什么 */
  _forgetTarget(name) {
    delete this._localTarget[name];
    delete this._localAt[name];
    delete this._pending[name];
    delete this._localFailed[name];
  }
  /** 写后保护窗口：刚写下去还没多久，回读到的**跟目标值不一样**的值一律当"写之前的旧回读"先扣住。
   *
   *  ⚠ **扣住 ≠ 丢掉**（现场踩得很惨）：以前是直接丢，可后端只在"值变了"时才推一条 ——
   *    写 TRUE → PLC 下一个扫描周期就把它改回 FALSE → 只来这**一条** FALSE 推送，
   *    正好落在窗口里被丢掉；之后再没有变化，界面就永远停在 TRUE。
   *    表现：按钮和指示灯都亮着，PLC 上的输出早灭了（「界面亮着、设备不亮」）。
   *    现在改成：窗口内的回读**记账**（_pending），窗口一到就**重新读一次设备**再结账；
   *    设备的值跟写下去的不一样 → 界面跟着设备改回来，并报 vars:overridden（运行时弹「设备没保持」）。
   *
   *  @returns true = 这条回读值先扣住（窗口内）；false = 正常收下 */
  _holdOff(name, value) {
    const at = this._localAt[name];
    if (at === undefined) return false;
    const left = writeHoldMs() - (Date.now() - at);
    if (left <= 0) { this._armResolve(name, 0); return false; }
    if (this._localTarget[name] === value) {   // 回读确认了 → 保护结束，正常收下
      delete this._localAt[name];
      delete this._pending[name];
      return false;
    }
    this._pending[name] = value;               // 先记账，等窗口过了再收
    this._armResolve(name, left);
    return true;
  }

  /** 安排「保护窗口到点后按设备真值结账」的那一下（已经排过就不重复排；期间又写过就重新等） */
  _armResolve(name, delay) {
    if (!backend.expectsServer || !backend.expectsServer()) return;   // 内存模拟：本地值就是真值
    if (this._holdTimers[name]) return;
    this._holdTimers[name] = setTimeout(() => {
      delete this._holdTimers[name];
      const at = this._localAt[name];
      if (at !== undefined) {
        const left = writeHoldMs() - (Date.now() - at);
        if (left > 0) { this._armResolve(name, left + 10); return; }   // 期间又写过 → 重新等
      }
      this._resolveHold(name);
    }, Math.max(0, delay) + 10);
  }

  /**
   * 保护窗口到点：**以设备为准结账**（写成功也走这里，等于"写后回读校验"）。
   *
   *   ① 重新读一次（后端手里就是轮询采到的真值，不用再等 PLC 一个来回）；
   *   ② 跟写下去的目标值不一样 → 界面跟着设备改回来，并报 vars:overridden（运行时弹「设备没保持」）；
   *   ③ 读不到（后端刚断）→ 退回窗口里记账的那份推送值。
   *
   * ⚠ 为什么不能只把窗口里记账的那份收回来：那份可能是**写下去之前的旧回读**（轮询比写慢半拍），
   *   按它收会把界面改回旧值；真正的答案只有"现在再读一次"。
   */
  async _resolveHold(name) {
    const target = this._localTarget[name];
    const hadLocal = this._localAt[name] !== undefined;
    // 写请求还没回来 → 先别结账（等它出结果；失败会走 resync 撤账，成功再按回读判）
    if (this._writes[name]) { this._armResolve(name, 200); return; }
    const failed = hadLocal && this._localFailed[name] === target;   // 后端已经拒过这笔（已报下发失败）
    delete this._localAt[name];
    delete this._localTarget[name];
    delete this._localFailed[name];
    let dev = this._pending[name];
    try {
      const vars = await backend.readVars();
      if (vars && Object.prototype.hasOwnProperty.call(vars, name)) dev = vars[name];
    } catch { /* 读不到就用窗口里记账的那份 */ }
    delete this._pending[name];
    if (dev === undefined || dev === null) return;   // 设备上没采到这个变量（还没读到数据）→ 不动界面
    this._setRemote(name, dev);
    if (!failed && hadLocal && target !== undefined && target !== dev) this._reportOverridden(name, target, dev);
  }

  /** 收一条"设备上的值"（界面跟着变；值没变就不广播） */
  _setRemote(name, value) {
    if (this.values[name] === value) return false;
    this.values[name] = value;
    bus.emit('vars:changed', { name, value, source: 'remote' });
    return true;
  }

  /** 写下去的值设备没保持：记账 + 广播（运行时弹「设备没保持」） */
  _reportOverridden(name, written, device) {
    this.lastWriteOverridden = { name, written, device, at: Date.now() };
    bus.emit('vars:overridden', this.lastWriteOverridden);
    console.warn(`[varstore] 设备没保持 ${name} = ${written}（回读 ${device}）`
      + '：可能被 PLC 程序/双线圈覆盖，或 PLC 不在 RUN（STOP 时输出不动作）');
  }

  /** 读一次设备上的值（"先读取再写入"用；读不到返回 undefined，由调用方退回本地值） */
  async readDevice(name) {
    try {
      const vars = await backend.readVars();
      if (vars && Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    } catch { /* 后端没开/设备离线 */ }
    return undefined;
  }

  /**
   * 切换（toggle 动作）：**先读设备、再写反值**（现场口径：一定要先读取再写入）。
   *
   * 为什么不能拿界面上的值取反：界面值可能正处在写后保护窗口里（刚写下去、还没回读确认），
   *   也可能被上面的回读仲裁刚改过 —— 拿它取反可能把**设备上已经是 F 的点又写成 F**，
   *   看着就是"按了没反应"。以设备回读为准才是稳的。
   * 连点保护：上一笔还没读完就再点，直接忽略（否则两笔基于同一个旧值取反 = 只写了一次）。
   */
  async toggle(name) {
    if (typeof name !== 'string' || !name) return;
    if (this.linkBlockReason && this.linkBlockReason(name)) {   // 链路门挡着：按老规矩（本地值取反，写会被挡下并恢复）
      this.set(name, !this.get(name), 'local');
      return;
    }
    this._toggling = this._toggling || {};
    if (this._toggling[name]) return;
    this._toggling[name] = true;
    try {
      const dev = await this.readDevice(name);
      const cur = dev === undefined ? this.get(name) : dev;
      // ⚠ 以**设备读到的值**算出来的那一下必须真发出去（force）：
      //   界面缓存可能正好已经是这个值（旧值/别处回读），不 force 会被 set() 的
      //   「值没变就不发」早退掉 —— 点了切换却什么都没下发。
      this.set(name, !cur, 'local', '', { force: dev !== undefined });
    } finally {
      this._toggling[name] = false;
    }
  }

  /**
   * 链路门挡下了这次写：**不发请求**，把界面上的值恢复成上一次读到的那份。
   *
   * ⚠ **界面上不提示**（现场要求：设备没连上时操作就是没反应，别再弹一条"未下发"——
   *   运行画面顶上那条「PLC 已断开」红条已经把话说清楚了，编辑器的状态栏也不用再挂）。
   *   原因仍然记在 `lastWriteError` 里并往控制台 warn 一句：查"刚才那下怎么没生效"时有据可查。
   *
   * 「值恢复」还是要做的：不然界面显示的是刚敲进去的数、设备上还是老值，
   * 用户接着按别的按钮就会基于一个假值做判断。
   */
  blocked(name, value, prev, message) {
    // 没发出去的写不算"本地账"：以后回读什么就是什么（否则松手那笔会被窗口挡住）
    this._forgetTarget(name);
    if (prev !== undefined && this.values[name] !== prev) {
      this.values[name] = prev;
      bus.emit('vars:changed', { name, value: prev, source: 'remote' });
    }
    this.lastWriteError = { name, value, message, at: Date.now(), blocked: true };
    console.warn(`[varstore] 未下发 ${name}=${value}：${message}（设备没连上/还没读到数据，这次没有发请求）`);
  }

  /** 下发到后端/PLC；结果通过 vars:write 广播（失败必须让用户看见）*/
  push(name, value, from = '', declaredName = name) {
    // 变量表里根本没有这个名字 = 脚本的临时量（`_lenAcc`、`_tmp` 这种累加器）。
    // 它只活在 HMI 本地：**一个请求都不发** ——
    //   · 发给 PLC 本来就没有意义（表里没有它，地址无从谈起）；
    //   · 而且会弹一条「下发失败：变量 _lenAcc 未在变量表声明」的橙条：
    //     现场一进运行态就看见它，以为哪里配错了（明明只是个临时累加器）。
    // 值已经写进本地 values，脚本之间照样能读能写；要让它进变量表/发给设备，
    // 就去变量表面板加一条（那时它就按普通变量走）。
    if (typeof this.isDeclaredVar === 'function' && !this.isDeclaredVar(declaredName)) {
      // 脚本临时量：本来就不该发请求 → 这一笔也不算"本地账"。
      // 不撤账的话，轮询回来的同名设备值会被写后保护窗口扣住、到点还报「设备没保持」
      // （纯误报：我们压根没写；verify-runtime-chrome 的写失败用例抓到过这个）。
      this._forgetTarget(name);
      return Promise.resolve();
    }
    // 内部变量（地址留空）：告诉后端「这是 HMI 自己的变量，别当 PLC 变量处理」——
    // 后端表里还没有它时按内部变量就地收下，不会回一句「未在变量表声明」。
    const internal = this.isInternalVar(declaredName);
    this._writes[name] = (this._writes[name] || 0) + 1;
    const done = () => { if (this._writes[name] && --this._writes[name] <= 0) delete this._writes[name]; };
    return backend.writeVar(name, value, { internal, from })
      .then(() => {
        this.lastWriteError = null;
        bus.emit('vars:write', { name, value, ok: true });
        // 写成功 ≠ 设备保持住了：到点回读一次（见 _resolveHold 的说明）。
        // 内部变量不碰设备、也不发这条；内存模拟模式里 backend.expectsServer() 为假同样跳过。
        this._armResolve(name, Math.max(120, writeHoldMs() + 80));
      })
      .catch(e => {
        const message = (e && e.message) || String(e);
        // 内部变量不下发设备，失败也不是「设备没收到」——值留在本地就是对的：
        // 不弹「下发失败」、也不回读覆盖（那会把脚本刚算出来的值抹掉）。
        if (internal) {
          console.warn(`[varstore] 内部变量 ${name} 没写进后端（本地值照旧）：${message}`);
          bus.emit('vars:write', { name, value, ok: true, internal: true, note: message });
          return;
        }
        this.lastWriteError = { name, value, message, at: Date.now() };
        this._localFailed[name] = value;   // 已报「下发失败」：回读仲裁别再补「设备没保持」
        bus.emit('vars:write', { name, value, ok: false, message });
        console.warn(`[varstore] 下发失败 ${name}=${value}：${message}`);
        // 下发失败 = 设备没收到这个值 → 界面上不能留着它（否则看着像"已经改了"，
        // 用户接着按别的操作就会基于一个假值做判断）。把设备上的真实值读回来盖掉。
        this.resync(name);
      })
      .finally(done);
  }

  /**
   * 下发失败/重新连上之后：把某个变量（或全部）按设备上的真实值恢复。
   *
   * ⚠ **合并**（现场踩过）：一连串失败（脚本连着写十几个量、或设备刚断）如果每次失败都
   *   整套读回来，后端和 PLC 会被自己的回读打满 —— 表现就是"下发失败"刷屏 + 页面越来越卡。
   *   这里把短时间内来的失败**并成一次回读**：等 120ms 攒一下，一次读回、按名字逐个盖掉。
   */
  async resync(name) {
    if (name) (this._resyncNames || (this._resyncNames = new Set())).add(name);
    else this._resyncAll = true;
    if (this._resync) return this._resync;                 // 已经在回读了 → 并进去
    this._resync = (async () => {
      await new Promise(r => setTimeout(r, 120));          // 攒窗口：一起来的失败合成一次
      const names = this._resyncNames;
      const all = this._resyncAll;
      this._resyncNames = null;
      this._resyncAll = false;
      try {
        const vars = await backend.readVars();
        if (!vars) return;
        const apply = (n, v) => {
          // 回读是"下发失败/重连"之后的**以设备为准**：这次本地账作废，
          // 否则写后保护窗口还会把设备上的真值挡在外面（界面停在"我以为写下去了"的那个值上）
          this._forgetTarget(n);
          if (v === undefined || this.values[n] === v) return;
          this.values[n] = v;
          bus.emit('vars:changed', { name: n, value: v, source: 'remote' });
        };
        if (all || !names || !names.size) Object.entries(vars).forEach(([n, v]) => apply(n, v));
        else names.forEach(n => apply(n, vars[n]));
        this.confirmFullRead();                            // 全量读回来了 = 这条链路上有数据了
      } catch { /* 后端也断了：下次重连的 resyncAfterReconnect 会兜住 */ }
    })().finally(() => { this._resync = null; });
    return this._resync;
  }

  /**
   * 把「这条链路上读到过数据」作废 → 在全量读完成之前**不许往设备写**。
   *
   * 什么时候必须作废：链路刚接上（noteLink 自动做）、长连接断线重连（前端手里的值是断线前那份）、
   * 设备掉线恢复。作废之后只有一次**全量读**（readVars / resync 回填）能把门打开。
   */
  invalidateRead() { this._readOnce = false; }

  /** 一次**全量读**完成：这条链路上确实读到过设备数据了 → 允许操作（见 linkBlockReason） */
  confirmFullRead() { this._readOnce = true; }

  /**
   * 后端批量同步（连接成功/轮询时）。
   *
   * ⚠ **只有全量读能开门**（opts.full = true）：单条增量推送（后端推来某个变量的变化、
   *   另一个客户端写值回显…）**不算**「读到过数据」——
   *   否则刚连上/刚恢复时后端只要推来一个变化值，整页还停在旧值上就被当成"读完了"，
   *   操作工在旧值控件上一点，就把基于旧值算出来的命令写进 PLC 了。
   *   全量读的入口只有三处：进运行态的 readVars、plcWatch 的"先读一遍"、写失败/重连后的 resync。
   */
  applyRemote(varsObj, opts = {}) {
    let n = 0;
    Object.entries(varsObj || {}).forEach(([name, value]) => {
      if (this._holdOff(name, value)) return;   // 写后保护窗口内的旧回读 → 丢（见 set 上面的说明）
      if (this.values[name] !== value) {
        this.values[name] = value;
        bus.emit('vars:changed', { name, value, source: 'remote' });
      }
      n++;
    });
    if (opts.full) this.confirmFullRead();
    return n;
  }

  /**
   * 变量表里**新加了变量**（导入控件包 / 导入页面 / CSV / OPC UA / 手动添加）→
   * 把"还没有值"的那些按变量表里的初值补上，然后广播刷新。
   *
   * 为什么需要：运行值表只在**开机**（main.js）和**进运行态**（runtime.js）从变量表 resetFrom 一次。
   * 中途往变量表里加的变量，运行值表压根不知道 → 控件绑上去显示「未绑定 / 空」，
   * 用户看着就像"导进来的控件是坏的"。
   *
   * ⚠ 只补 `undefined` 的：已经有值的（后端推来的实时值、用户刚改的）**绝不能被变量表初值盖掉**。
   */
  initMissing(list) {
    let n = 0;
    (list || []).forEach(v => {
      const name = v && v.name;
      if (!name || this.values[name] !== undefined) return;
      this.values[name] = v.value;
      n++;
      // ⚠ 必须**逐个变量名**广播（不能学 resetFrom 发 name:null）：
      //   画布那边是 `bus.on('vars:changed', ({name}) => refreshBound(name))` —— 只按名字找绑定它的控件。
      //   发 null 就等于谁都不刷新，画布上还是「未绑定」（实测踩过）。
      bus.emit('vars:changed', { name, value: v.value, source: 'init' });
    });
    return n;
  }
}

export const varStore = new VarStore();

// 谁往变量表里加了变量，喊一声就行（project.js 导入控件包/页面时 emit）—— 
// 这样运行值表不用被 project 反向依赖（varstore ← bus ← project，单向）
bus.on('vars:new-defs', (list) => { try { varStore.initMissing(list); } catch (e) { console.warn('[varstore] 补初值失败', e); } });
