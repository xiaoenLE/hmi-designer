/**
 * addrInput.js — 地址输入控件：**协议前缀下拉 + 编号框**（地址对不对由后端判，见 addrCatalog.validate）
 *
 * 结构（HTML 由 prefixSelectHtml() + 一个地址 input 拼起来，不自己造输入框 ——
 * 变量表的既有选择器 `input[data-k="address"]` / 新建变量框的 `#vaAddr` 必须原样保留）：
 *
 *     <select class="addr-prefix">（自由输入）| %MW | %MD | %MX | …   ← 前缀来自目录（addrCatalog.prefixes）
 *     <input  class="addr-body" data-k="address">                     ← 完整地址文本（'%MW100' / 'D100' / 'HR100'）
 *     <div    class="addr-msg"></div>                                 ← 下方灰字/红字结论
 *
 * 交互：
 *   · 选前缀 → 把「前缀 + 现有编号」写回输入框（D + 100 = D100；%MX + 0.0 = %MX0.0），再像用户手输一样派发
 *     input/change（变量表那套归一化、落盘逻辑照常跑）；输入框本来就是完整地址（HR100 / 100 / ns=4;s=…）
 *     时下拉显示「（自由输入）」，不强拼。
 *   · 校验：输入防抖 250ms + blur/change 立刻 `addrCatalog.validate()`（后端优先，老后端退回本地 addrMap）。
 *   · 结论只做展示，不改写调用方的值：
 *       valid:false + code:'invalid' → 输入框 `.addr-bad`（红边 + 红字）+ 红字 message
 *       unsupported / code:'model'    → 灰字「内部变量」结论，**不标红**（既有现场口径）
 *       writable:false 且这个变量会被写 → 灰字提示「只读地址」（红不红仍看 valid）
 *       空地址                        → 灰字「留空 = 内部变量」
 *
 * 不引用 toolbar.js / varsPanel.js（避免循环依赖）：调用方把自己的归一化逻辑留在原有 change 监听里，
 * 这里只在 input 上挂校验监听。
 */
import { escapeHtml as esc, debounce } from './utils.js';
import { prefixes, prefixOf, isNodeIdProtocol, validate, protocolInfo } from './addrCatalog.js';

/** 「自由输入」：不加强制前缀，输入框里写什么就是什么（老写法 HR100 / 数字 / NodeId / %MW 兼容写法都靠它）。
 *  ⚠ 标签用 4 个字（不带括号）：变量表那一格只有 ~70px，写「（自由输入）」会被截成「（自由」。
 *  含义放 title 里。 */
const FREE = '';
const FREE_LABEL = '自由输入';

/** 前缀选项（数组）：[{value, label, title, prefix}] */
export function prefixOptions(pid) {
  if (isNodeIdProtocol(pid)) return [];
  return prefixes(pid).map((x) => {
    const bits = [x.label || '', x.example ? `例：${x.example}` : '', x.writable === false ? '只读' : '']
      .filter(Boolean).join(' · ');
    return { value: x.prefix, label: x.prefix, title: bits, prefix: x };
  });
}

/** 前缀下拉的 HTML（OPC UA 等 NodeId 协议返回 ''，只留地址输入框） */
export function prefixSelectHtml({ proto, selected = '', cls = 'addr-prefix', dataK = 'addr-prefix', id = '' } = {}) {
  const opts = prefixOptions(proto);
  if (!opts.length) return '';
  const sel = String(selected || '');
  const head = `<option value="${FREE}"${sel ? '' : ' selected'}>${FREE_LABEL}</option>`;
  const rest = opts.map((o) => `<option value="${esc(o.value)}" title="${esc(o.title)}"${sel === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<select class="${esc(cls)}"${idAttr} data-k="${esc(dataK)}" title="地址前缀（按当前 PLC 协议；选「自由输入」可直接写整条地址）">${head}${rest}</select>`;
}

/** 用目录重填一个已存在的 select（协议切换时用） */
export function fillPrefixSelect(sel, pid, selected = '') {
  if (!sel) return;
  const opts = prefixOptions(pid);
  const wrap = sel.parentElement;
  if (!opts.length) { sel.style.display = 'none'; sel.disabled = true; return; }
  sel.style.display = '';
  sel.disabled = false;
  const keep = String(selected || '');
  sel.innerHTML = `<option value="${FREE}">${FREE_LABEL}</option>`
    + opts.map((o) => `<option value="${esc(o.value)}" title="${esc(o.title)}"${keep === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  sel.value = keep;
  void wrap;
}

/** 这个文本像是「只选了前缀、还没输编号」吗（'%MW' / 'D' / '%MX' → 不急着标红） */
function looksIncomplete(text, pid) {
  const s = String(text || '').trim().toUpperCase();
  if (!s) return false;
  if (prefixOf(pid, s)) return false;            // 目录前缀后面已经跟了数字 → 算完整
  if (/^%?[A-Z]+$/.test(s)) return true;         // 纯字母（%MW / D / QX…）
  return false;
}


/** 用在地址输入标签和表头的简短协议说明。 */
export function addressHelpFor(proto) {
  const example = {
    modbus: '位地址如 %MX0.0，字地址如 %MW100 或 %MD50，百分号可省。D100、M10 属于 TS600 写法。',
    ts600: '位地址如 M10、X17、Y10，字地址如 D100、R100、C200。TS600 不支持 %MX 字内取位。',
    opcua: '填写完整 NodeId，例如 ns=4;s=|var|设备.Application.POU.符号。',
  };
  return (example[proto] || example.modbus) + ' 地址留空为内部变量。';
}

/** 给调用方用的占位文案（按协议） */
export function placeholderFor(pid) {
  const info = protocolInfo(pid);
  const kind = info && info.kind;
  if (kind === 'nodeid') return 'ns=4;s=|var|设备.Application.POU.符号';
  if (String(pid || '') === 'ts600') return 'D100 或 100（留空 = 内部变量）';
  return '%MW96 或 100（留空 = 内部变量）';
}

/**
 * 把校验/交互挂到一个地址输入框上。
 * @param {object} opt
 * @param {string} opt.proto                     协议 id（modbus / ts600 / opcua）
 * @param {HTMLInputElement} opt.input           地址文本输入框（必须有）
 * @param {HTMLSelectElement} [opt.prefix]       前缀下拉（可空；OPC UA 不显示）
 * @param {HTMLElement} [opt.msg]                下方结论元素（可空；空则只标红/写 title）
 * @param {string} [opt.vtype]                   变量类型（校验用）
 * @param {boolean} [opt.write]                  这个变量是否会被写（只读地址写要提示）
 * @param {(value:string, res:object)=>void} [opt.onResult] 校验结论回调（调用方可据此渲染）
 * @param {number} [opt.debounceMs]              输入防抖（默认 250ms）
 * @param {boolean} [opt.titleOnValid]           valid 时把说明写进 input.title（变量表已有自己的 title，传 false）
 * @param {boolean} [opt.syncPrefix]             输入时根据文本同步前缀下拉（默认 true）
 * @returns {{getValue:Function,setValue:Function,setProto:Function,setVtype:Function,
 *            validateNow:Function,lastResult:Function,syncPrefix:Function,destroy:Function}}
 */
export function attachAddrInput(opt = {}) {
  const input = opt.input;
  if (!input) return null;
  let proto = String(opt.proto || 'modbus');
  let vtype = String(opt.vtype || '');
  let write = !!opt.write;
  let seq = 0;
  let last = null;
  let destroyed = false;
  const msgEl = opt.msg || null;
  const preEl = opt.prefix || null;
  const onResult = typeof opt.onResult === 'function' ? opt.onResult : null;
  const titleOnValid = opt.titleOnValid !== false;
  const syncPrefix = opt.syncPrefix !== false;
  // 挂上去先校验一次（对话框这种只有一行地址的地方，空地址也要立刻出「留空 = 内部变量」灰字；
  // 变量表上百行、每行都问一次后端太浪费 → 那边传 validateOnAttach:false，改动时才校验）
  const validateOnAttach = opt.validateOnAttach !== false;
  const debounceMs = Math.max(0, Number(opt.debounceMs) || 250);
  // 校验前把用户敲的写法归一化（HR100 / 100 → %MW100、mx100.0 → %MX100.0）：
  // 后端 /api/comm/validate 只认归一化之后的地址；对话框没有变量表那套 change 归一化，靠这个。
  const normalize = typeof opt.normalize === 'function' ? opt.normalize : null;

  const getValue = () => String(input.value || '').trim();

  /** 把前缀下拉摆到「跟当前地址文本一致」的位置（认不出 → 自由输入） */
  function syncPrefixNow() {
    if (!preEl || preEl.disabled) return;
    const p = prefixOf(proto, getValue());
    if (preEl.value !== p) preEl.value = p;
  }

  function clearMarks() {
    input.classList.remove('addr-bad');
    input.style.color = '';
  }

  /** 结论 → 界面（只展示，不改值） */
  function applyResult(res, value) {
    last = { ...(res || {}), value: String(value == null ? '' : value) };
    const text = last.value.trim();
    if (destroyed) {
      // 输入框已经被重渲染换掉了（变量表改地址会整行重建）：DOM 不用写了，但结论还要交给调用方，
      // 否则重渲染后那一行就丢了红边/标题（onResult 里会把结论补到新行上）。
      if (onResult) { try { onResult(last, { value: last.value, proto }); } catch { /* 调用方异常不影响控件 */ } }
      return;
    }
    if (!text) {
      clearMarks();
      if (msgEl) { msgEl.className = 'addr-msg internal'; msgEl.textContent = '留空 = 内部变量（不采集、不下发）'; }
      return;
    }
    if (last.pending) {
      clearMarks();
      if (msgEl) { msgEl.className = 'addr-msg internal'; msgEl.textContent = last.message || '继续输入编号…'; }
      return;
    }
    if (last.unsupported || last.code === 'model') {
      // 写法与协议不匹配 = 内部变量：**灰字、不标红**（后端按内部变量处理，不报错）
      clearMarks();
      if (msgEl) { msgEl.className = 'addr-msg internal'; msgEl.textContent = last.message || '内部变量（不采集、不下发）'; }
      input.title = last.message || '内部变量（不采集、不下发）';
    } else if (last.valid === false && last.code === 'invalid') {
      input.classList.add('addr-bad');
      input.style.color = 'var(--danger)';
      if (msgEl) { msgEl.className = 'addr-msg bad'; msgEl.textContent = last.message || '地址不合法'; }
      // 变量表既有口径：地址说不过去时 title 以 ⚠ 开头（现场和回归套件都按这个认）
      const m = last.message || '地址不合法';
      input.title = /^⚠/.test(m) ? m : `⚠ ${m}`;
    } else {
      clearMarks();
      const readonly = last.writable === false;
      const roMsg = `只读地址${last.message ? `：${last.message}` : ''}（能读，不能写）`;
      if (msgEl) {
        if (readonly && write) { msgEl.className = 'addr-msg internal'; msgEl.textContent = roMsg; }
        else if (last.warning) { msgEl.className = 'addr-msg internal'; msgEl.textContent = last.warning; }
        else if (last.message) { msgEl.className = 'addr-msg ok'; msgEl.textContent = last.message; }
        else { msgEl.className = 'addr-msg'; msgEl.textContent = ''; }
      }
      if (titleOnValid) input.title = last.message || '';
      else if (readonly && write) input.title = roMsg;
    }
    if (onResult) { try { onResult(last, { value: last.value, proto }); } catch { /* 调用方异常不影响控件 */ } }
  }

  /** 立刻校验（blur / change / 外部调用 / 建变量前） */
  async function validateNow() {
    const rawValue = getValue();
    const value = normalize ? (normalize(rawValue) || rawValue) : rawValue;
    const token = ++seq;
    if (!rawValue) {
      applyResult({ valid: true, unsupported: false, code: 'empty', message: '留空 = 内部变量（不采集、不下发）' }, rawValue);
      return last;
    }
    if (looksIncomplete(rawValue, proto)) {
      applyResult({ valid: true, unsupported: false, code: '', pending: true, message: '继续输入编号（例如 D100 / %MW100）' }, rawValue);
      return last;
    }
    let res = null;
    try { res = await validate(proto, value, vtype, write); } catch { res = null; }
    if (destroyed) return last;
    if (token !== seq) return last;      // 期间地址又变了，这次结论作废
    if (!res) {
      clearMarks();
      if (msgEl) { msgEl.className = 'addr-msg'; msgEl.textContent = ''; }
      return last;
    }
    applyResult(res, value);
    return last;
  }

  const schedule = debounce(() => { validateNow(); }, debounceMs);

  const onInput = () => {
    if (syncPrefix) syncPrefixNow();
    // 输入时先把「未完成」的提示放出来，防抖后再问后端
    if (!getValue()) { clearMarks(); if (msgEl) { msgEl.className = 'addr-msg internal'; msgEl.textContent = '留空 = 内部变量（不采集、不下发）'; } }
    schedule();
  };
  const onChange = () => {
    if (syncPrefix) syncPrefixNow();
    // 变量表/对话框自己的 change 归一化监听可能排在本监听之后：排到微任务里再校验，
    // 这样校验的是**归一化之后**的地址（HR100 → %MW100）
    queueMicrotask(() => { if (!destroyed) validateNow(); });
  };
  const onBlur = () => { if (syncPrefix) syncPrefixNow(); validateNow(); };

  input.addEventListener('input', onInput);
  input.addEventListener('change', onChange);
  input.addEventListener('blur', onBlur);

  const onPrefixChange = () => {
    if (!preEl) return;
    const cur = String(input.value || '').trim();
    const digits = (cur.match(/(\d+(?:\.\d+)?)\s*$/) || [])[1] || '';
    const chosen = String(preEl.value || '');
    const next = chosen ? chosen + digits : cur;
    if (next !== input.value) {
      input.value = next;
      try { const n = input.value.length; input.setSelectionRange(n, n); } catch { /* 忽略 */ }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      schedule();
    }
    input.focus();
  };
  if (preEl) preEl.addEventListener('change', onPrefixChange);
  if (validateOnAttach) validateNow();

  return {
    getValue,
    setValue(v) { input.value = String(v == null ? '' : v); syncPrefixNow(); schedule(); },
    setProto(pid) {
      proto = String(pid || 'modbus');
      if (preEl) fillPrefixSelect(preEl, proto, prefixOf(proto, getValue()));
      if (msgEl) { msgEl.className = 'addr-msg'; msgEl.textContent = ''; }
      validateNow();
    },
    setVtype(t) { vtype = String(t || ''); validateNow(); },
    setWrite(w) { write = !!w; },
    validateNow,
    lastResult() { return last; },
    syncPrefix: syncPrefixNow,
    destroy() {
      destroyed = true;
      schedule.cancel?.();
      input.removeEventListener('input', onInput);
      input.removeEventListener('change', onChange);
      input.removeEventListener('blur', onBlur);
      if (preEl) preEl.removeEventListener('change', onPrefixChange);
    },
  };
}
