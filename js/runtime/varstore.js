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

/** 一次**链路**失败之后，这么久之内不再往设备试（毫秒）。
 *
 *  一次失败要等一个设备超时（Modbus 1.5 秒）才回来，而这期间脚本还在按周期写：
 *  不拦的话每一笔写都会各自去等自己的超时，堆成一串失败 ——
 *  现场原话「断开时前面数据还在下发，如果变量很多，弹完全部失败的命令才停」。
 *  1.5 秒 ≈ 一个超时的时间，够把已经排上的那一批放掉，又不会把恢复正常拖太久
 *  （恢复本来就还要先"重新读一遍现场数据"才允许操作，见 linkBlockReason）。 */
const LINK_FAIL_COOLDOWN = 1500;

/** 同一时刻最多允许有多少笔「发给设备」的写在路上 —— 超了就**这一笔不发**（当作被门挡下）。
 *
 *  为什么必须有：后端处理写值是**串行**的（一条长连接一个接收线程），设备卡住时一笔写要等
 *  一个 socket 超时（Modbus 1.5 秒）。脚本一个周期写一批（几十上百个变量）时，在途的写会
 *  越堆越多，每一笔都占着一个 promise + 定时器 + 闭包；更糟的是等不到应答的写还会**各自退回
 *  HTTP 重试一次**（后端每收一个请求就新起一个线程）—— 现场表现就是
 *  「设备一断，内存暴涨一下、过一会儿才降下来」。
 *  64 是个够用的上限：正常通讯（本地几毫秒、现场几十毫秒）永远碰不到；
 *  只有"设备卡住了"才会碰到，那时本来就该少发、不该排队。
 *  ⚠ 只对**发给设备**的写设限：内部变量只到本机后端，代价小，不该被挡。 */
const DEV_INFLIGHT_MAX = 64;

class VarStore {
  constructor() {
    this.values = {};
    this.lastWriteError = null;
    this._linkKey = '';        // `${mode}|${online}`：链路状态变了才重置"读到过数据"这个标记
    this._readOnce = false;    // 这次链路状态下，**已经读到过设备数据**（读到才允许写）
    this._linkFailAt = 0;      // 上一次**链路**失败的时刻（掉线/超时；见 LINK_FAIL_COOLDOWN）
    this._devInflight = 0;     // 现在有几笔"发给设备"的写还没回来（见 DEV_INFLIGHT_MAX）
    this._warnAt = 0;          // 上一次往控制台打"未下发"的时刻（见 blocked 里的限速）
    this._undeclared = [];     // 变量表里没有的名字（按写入先后），超上限就丢最早的一批
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
      if (n !== name && !this.isDeclaredVar(n)) delete this.values[n];
    }
  }

  /** 从工程变量表加载初值（进入运行模式时调用） */
  resetFrom(variables) {
    this.values = {};
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
    // 刚有一笔下发**链路**失败 → 冷却期内不再试（见 LINK_FAIL_COOLDOWN 的说明）
    if (this._linkFailAt && Date.now() - this._linkFailAt < LINK_FAIL_COOLDOWN) {
      return '设备刚下发失败（连接已断），这次没有下发';
    }
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
   *  脚本可能每 100ms 写一次，那行日志会把 cmd 刷爆（脚本自己用 hmi.log 记录就够了）。 */
  set(name, value, source = 'local', from = '') {
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
        if (cur[idx] === value) return;
        const next = cur.slice();
        next[idx] = value;
        // 链路门：设备没连上 / 还没读到数据 → **一个字节都不发**，界面也不留这个值
        if (source === 'local') {
          const why = this.linkBlockReason(base);
          if (why) { this.blocked(name, value, cur, why); return; }
        }
        this.values[base] = next;
        bus.emit('vars:changed', { name: base, value: next, source });
        if (source === 'local' && backend.expectsServer()) this.push(name, value, from);
        return;
      }
    }
    // 值没变 → 不广播、不下发（避免后端回声成环）。
    // 变量表里没有的新变量第一次写入也必须广播，否则首次按下点动按钮界面无反应
    if ((name in this.values) && this.values[name] === value) return;
    // 链路门：设备没连上 / 还没读到数据 → **不传**（界面也不留这个值，见 blocked()）
    if (source === 'local') {
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
    if (prev !== undefined && this.values[name] !== prev) {
      this.values[name] = prev;
      bus.emit('vars:changed', { name, value: prev, source: 'remote' });
    }
    this.lastWriteError = { name, value, message, at: Date.now(), blocked: true };
    // ⚠ 这句 warn 要**限速**：设备断了/在途写满了的时候，脚本一个周期能被挡几十上百笔，
    //   每笔都打一条的话控制台（浏览器那边）会被刷爆 —— 这也是"内存涨一下"的一份来源。
    //   1 秒最多一条，够查"刚才那下怎么没生效"了。
    const now = Date.now();
    if (now - this._warnAt > 1000) {
      this._warnAt = now;
      console.warn(`[varstore] 未下发 ${name}=${value}：${message}`
        + `（设备没连上/还没读到数据/在途太多，这次没有发请求；同类提示每秒最多一条）`);
    }
  }

  /** 下发到后端/PLC；结果通过 vars:write 广播（失败必须让用户看见）*/
  push(name, value, from = '') {
    // 变量表里根本没有这个名字 = 脚本的临时量（`_lenAcc`、`_tmp` 这种累加器）。
    // 它只活在 HMI 本地：**一个请求都不发** ——
    //   · 发给 PLC 本来就没有意义（表里没有它，地址无从谈起）；
    //   · 而且会弹一条「下发失败：变量 _lenAcc 未在变量表声明」的橙条：
    //     现场一进运行态就看见它，以为哪里配错了（明明只是个临时累加器）。
    // 值已经写进本地 values，脚本之间照样能读能写；要让它进变量表/发给设备，
    // 就去变量表面板加一条（那时它就按普通变量走）。
    if (typeof this.isDeclaredVar === 'function' && !this.isDeclaredVar(name)) return Promise.resolve();
    // 内部变量（地址留空）：告诉后端「这是 HMI 自己的变量，别当 PLC 变量处理」——
    // 后端表里还没有它时按内部变量就地收下，不会回一句「未在变量表声明」。
    const internal = this.isInternalVar(name);
    // 「发给设备」的写才限在途笔数（内部变量只到本机后端，代价小，不该被挡）。
    // ⚠ 上限按**设备模式**判、不看这一下通不通：设备断了以后 linkBlockReason 已经把写挡住了，
    //   这里管的是"设备还在、但卡住了"（一笔写等一整个 socket 超时那种）——那时在途会迅速堆满。
    const device = !internal && backend.isDeviceMode();
    if (device) {
      if (this._devInflight >= DEV_INFLIGHT_MAX) {
        this.blocked(name, value, this.values[name],
          `设备响应慢（还有 ${this._devInflight} 笔没回来），这次没有下发`);
        return Promise.resolve();
      }
      this._devInflight++;
    }
    return backend.writeVar(name, value, { internal, from })
      .then(() => {
        this.lastWriteError = null;
        this._linkFailAt = 0;                     // 写通了 = 这条链路现在通
        bus.emit('vars:write', { name, value, ok: true });
      })
      .catch(e => {
        const message = (e && e.message) || String(e);
        // 后端给的失败分类（见 backend.writeFail / server 的 _err_kind）：
        //   'link' = 设备这一下不通；'var' = 地址/只读/声明问题（设备好好的）
        const kind = (e && e.kind) || '';
        // 内部变量不下发设备，失败也不是「设备没收到」——值留在本地就是对的：
        // 不弹「下发失败」、也不回读覆盖（那会把脚本刚算出来的值抹掉）。
        if (internal) {
          console.warn(`[varstore] 内部变量 ${name} 没写进后端（本地值照旧）：${message}`);
          bus.emit('vars:write', { name, value, ok: true, internal: true, note: message });
          return;
        }
        // ★ 链路失败 = 设备断了 → **当场**把链路判成断开、并进冷却期：
        //   后面的写立刻被 linkBlockReason 拦下（一个字节都不发），
        //   而不是各自再去等一个设备超时、在界面上弹成一串「下发失败」。
        if (kind === 'link') {
          this._linkFailAt = Date.now();
          backend.noteDeviceDown(message);
        }
        this.lastWriteError = { name, value, message, at: Date.now(), kind };
        bus.emit('vars:write', { name, value, ok: false, message, kind });
        console.warn(`[varstore] 下发失败 ${name}=${value}：${message}`);
        // 下发失败 = 设备没收到这个值 → 界面上不能留着它（否则看着像"已经改了"，
        // 用户接着按别的操作就会基于一个假值做判断）。把设备上的真实值读回来盖掉。
        // ⚠ 链路已断时不回读：设备不通，回读只会再等一串超时（正是要避免的那件事）。
        if (kind !== 'link') this.resync(name);
      })
      .finally(() => { if (device) this._devInflight--; });
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
          if (v === undefined || this.values[n] === v) return;
          this.values[n] = v;
          bus.emit('vars:changed', { name: n, value: v, source: 'remote' });
        };
        if (all || !names || !names.size) Object.entries(vars).forEach(([n, v]) => apply(n, v));
        else names.forEach(n => apply(n, vars[n]));
        this._readOnce = true;                             // 读回来了 = 这条链路上有数据了
      } catch { /* 后端也断了：下次重连的 resyncAfterReconnect 会兜住 */ }
    })().finally(() => { this._resync = null; });
    return this._resync;
  }

  /** 后端批量同步（连接成功/轮询时）——**收到了数据 = 这条链路上读到过数据了**，
   *  也就是"连接成功后先读一遍"这件事做到了，从此允许操作变量（见 linkBlockReason）。 */
  applyRemote(varsObj) {
    let n = 0;
    Object.entries(varsObj || {}).forEach(([name, value]) => {
      if (this.values[name] !== value) {
        this.values[name] = value;
        bus.emit('vars:changed', { name, value, source: 'remote' });
      }
      n++;
    });
    if (n) this._readOnce = true;
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
