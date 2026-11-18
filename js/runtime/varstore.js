/**
 * varstore.js — 变量运行值存储（编辑态预览 + 运行态数据流核心）
 *
 * 数据流：
 *   本地写（控件动作/变量面板）→ set(name, v, 'local')
 *       → emit vars:changed → 各视图刷新绑定控件
 *       → backend.expectsServer() → backend.writeVar() 下发，成败发 vars:write
 *   远端推送（SSE）→ set(name, v, 'remote') → 仅刷新视图，不回写
 */
import { bus } from '../core/eventBus.js';
import { backend } from '../api/backend.js';

class VarStore {
  constructor() { this.values = {}; this.lastWriteError = null; }

  /** 从工程变量表加载初值（进入运行模式时调用） */
  resetFrom(variables) {
    this.values = {};
    variables.forEach(v => { this.values[v.name] = v.value; });
    bus.emit('vars:changed', { source: 'init', name: null });
  }

  get(name) { return this.values[name]; }
  getAll() { return { ...this.values }; }

  /** source: 'local' | 'remote' | 'init' */
  set(name, value, source = 'local') {
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
        this.values[base] = next;
        bus.emit('vars:changed', { name: base, value: next, source });
        if (source === 'local' && backend.expectsServer()) this.push(name, value);
        return;
      }
    }
    // 值没变 → 不广播、不下发（避免后端回声成环）。
    // 变量表里没有的新变量第一次写入也必须广播，否则首次按下点动按钮界面无反应
    if ((name in this.values) && this.values[name] === value) return;
    this.values[name] = value;
    bus.emit('vars:changed', { name, value, source });
    // 本地写 → 下发。⚠ 以前这里挂了 backend.isOnline()：只要开机那次探测超时过一次，
    // 之后所有写都不再下发，界面照样显示新值、PLC 一点没变，而且没有任何提示。
    // 现在照发，成败都发 vars:write 事件让状态栏显示出来（失败会自动把真实值读回来）。
    if (source === 'local' && backend.expectsServer()) this.push(name, value);
  }

  /** 下发到后端/PLC；结果通过 vars:write 广播（失败必须让用户看见）*/
  push(name, value) {
    return backend.writeVar(name, value)
      .then(() => {
        this.lastWriteError = null;
        bus.emit('vars:write', { name, value, ok: true });
      })
      .catch(e => {
        const message = (e && e.message) || String(e);
        this.lastWriteError = { name, value, message, at: Date.now() };
        bus.emit('vars:write', { name, value, ok: false, message });
        console.warn(`[varstore] 下发失败 ${name}=${value}：${message}`);
        // 下发失败 = 设备没收到这个值 → 界面上不能留着它（否则看着像"已经改了"，
        // 用户接着按别的操作就会基于一个假值做判断）。把设备上的真实值读回来盖掉。
        this.resync(name);
      });
  }

  /** 下发失败/重新连上之后：把某个变量（或全部）按设备上的真实值恢复 */
  async resync(name) {
    try {
      const vars = await backend.readVars();
      if (!vars) return;
      const apply = (n, v) => {
        if (v === undefined || this.values[n] === v) return;
        this.values[n] = v;
        bus.emit('vars:changed', { name: n, value: v, source: 'remote' });
      };
      if (name) apply(name, vars[name]);
      else Object.entries(vars).forEach(([n, v]) => apply(n, v));
    } catch { /* 后端也断了：下次重连的 resyncAfterReconnect 会兜住 */ }
  }

  /** 后端批量同步（连接成功/轮询时） */
  applyRemote(varsObj) {
    Object.entries(varsObj).forEach(([name, value]) => {
      if (this.values[name] !== value) {
        this.values[name] = value;
        bus.emit('vars:changed', { name, value, source: 'remote' });
      }
    });
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
