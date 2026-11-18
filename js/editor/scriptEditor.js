/**
 * scriptEditor.js — 脚本编辑器（近乎全屏的浮层）
 *
 * 为什么不做成小对话框：写脚本要看得见上下文，小框里滚来滚去很难用。
 * 这里占 94vw × 92vh：
 *   · 左边是代码区（行号 + Tab 缩进 + Ctrl+S 保存 + Ctrl+Enter 保存）
 *   · 右边是「变量」和「API 速查」，点变量名/函数名直接插到光标处
 *   · 下面一条日志区：保存前的语法检查结果、试运行的 log()/错误都在这里
 * 触发方式（初始化一次 / 定时 / 循环 / 变量变化 / 条件成立）在顶上直接选。
 */
import { bus } from '../core/eventBus.js';
import { project, SCRIPT_TRIG_CN } from '../core/project.js';
import { attachVarPick } from './varPick.js';import { runScriptOnce, scriptLog } from '../runtime/scriptEngine.js';
import { highlightJS } from './jsHighlight.js';
import { showDialog } from './toolbar.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OPS = ['==', '!=', '>', '>=', '<', '<='];
const LINE_H = 21;            // 与 css/script.css 里 .se-hl/.se-area 的 line-height 一致
const PAD_TOP = 10;           // 也与那边一致（光标行高亮要按这个算位置）
const HL_MAX = 60000;         // 代码超长就不高亮（否则每敲一个字都要重扫一遍，卡）
const API_DOC = [
  ['hmi.get(名)', '读变量当前值'],
  ['hmi.set(名, 值)', '写变量（会下发给 PLC）'],
  ['hmi.has(名)', '变量表里有没有这个名字'],
  ['hmi.vars()', '全部变量的当前值'],
  ['hmi.log(…)', '往下面日志里写一行'],
  ['hmi.warn(…)', '写一行黄色警告'],
  ['hmi.page(页)', '切页面（id 或页面名）'],
  ['hmi.popup(页)', '打开弹窗（id 或弹窗名）'],
  ['hmi.hidePopup()', '关掉最上面的弹窗'],
  ['hmi.back()', '返回上一页'],
  ['hmi.alarms()', '当前报警列表'],
  ['hmi.permLevel()', '当前解锁到的操作权限等级名（空 = 没解锁）'],
  ['hmi.can(等级)', "当前权限够不够那一级，如 if (hmi.can('工程师')) …"],
  ['hmi.lock()', '退出操作权限（交回去）'],
  ['hmi.project.pageName()', '当前打开那一页的名字（如 报警记录）'],
  ['hmi.project.pageId()', '当前页的 id'],
  ['hmi.time(fmt)', "当前时间文本，如 hmi.time('hh:mm:ss')"],
  ['hmi.now()', '时间戳（毫秒）'],
];

let mask, box, ta, gutter, statusEl, logEl, nameEl, trigEl, paramEl;
let hl, wrap, curLine;
let curId = null;      // 正在编辑哪条（null = 新建）
let dirty = false;

export function initScriptEditor() {
  mask = document.getElementById('seMask');
  if (!mask) return;
  box = document.getElementById('seBox');
  ta = document.getElementById('seCode');
  gutter = document.getElementById('seGutter');
  hl = document.getElementById('seHl');
  wrap = ta.closest('.se-editwrap');
  curLine = document.createElement('div');
  curLine.className = 'se-curline';
  statusEl = document.getElementById('seStatus');
  logEl = document.getElementById('seLog');
  nameEl = document.getElementById('seName');
  trigEl = document.getElementById('seTrig');
  paramEl = document.getElementById('seParams');

  trigEl.innerHTML = Object.entries(SCRIPT_TRIG_CN)
    .map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  // 变量区由 renderVars() 填（打开时按当前变量表刷）
  document.getElementById('seDoc').innerHTML = API_DOC.map(([sig, d]) =>
    `<div class="se-doc-row" data-insert="${esc(sig.replace('…', ''))}" title="点一下插到光标处">
      <code>${esc(sig)}</code><span>${esc(d)}</span></div>`).join('');

  document.getElementById('seClose').addEventListener('click', closeScriptEditor);
  document.getElementById('seSave').addEventListener('click', save);
  document.getElementById('seRun').addEventListener('click', tryRun);
  document.getElementById('seClearLog').addEventListener('click', () => { logEl.innerHTML = ''; setStatus(''); });
  mask.addEventListener('pointerdown', e => { if (e.target === mask) closeScriptEditor(); });
  trigEl.addEventListener('change', () => { renderParams(); syncTrigPatch(); });
  paramEl.addEventListener('change', syncTrigPatch);
  paramEl.addEventListener('input', () => { dirty = true; });

  // 代码区：高亮层、行号、Tab 缩进、Esc 关闭（Ctrl+S / Ctrl+Enter 绑在浮层上，焦点在哪都管用）
  ta.addEventListener('input', () => { dirty = true; renderHl(); renderGutter(); });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keyup', updateCaretLine);
  ta.addEventListener('click', updateCaretLine);
  ta.addEventListener('select', updateCaretLine);
  // 输入法（中文注释）组字期间：把 textarea 的字显出来，不然候选框里的字看不见
  ta.addEventListener('compositionstart', () => wrap.classList.add('composing'));
  ta.addEventListener('compositionend', () => { wrap.classList.remove('composing'); renderHl(); });
  mask.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      save();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeScriptEditor(); }
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') {                       // Tab 缩进而不是跳走
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.setRangeText('  ', s, en, 'end');
      renderGutter();
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {   // 回车自动带上当前缩进
      const s = ta.selectionStart;
      const line = ta.value.slice(0, s).split('\n').pop();
      const indent = (/^\s*/.exec(line) || [''])[0];
      const extra = /[{[(]\s*$/.test(line) ? '  ' : '';
      if (indent || extra) {
        e.preventDefault();
        const ins = '\n' + indent + extra;
        ta.setRangeText(ins, s, ta.selectionEnd, 'end');
        renderGutter();
      }
    }
  });

  // 变量例子 / API 点一下插到光标处
  document.getElementById('seVarsWrap').addEventListener('click', e => {
    const el = e.target.closest('[data-insert]');
    if (el) insert(el.dataset.insert);
  });
  document.getElementById('seDoc').addEventListener('click', e => {
    const el = e.target.closest('[data-insert]');
    if (!el) return;
    insert(el.dataset.insert.endsWith('(') ? el.dataset.insert : el.dataset.insert);
  });
  document.getElementById('seHelp')?.addEventListener('click', openApiHelp);
  bus.on('script:log', () => { if (!mask.classList.contains('hidden')) renderLog(); });
}

/* ─────────── API 帮助（点「? 帮助」开） ───────────
   和右边那栏「API 速查」的区别：速查是**一行一条、点一下插入**；
   帮助是**能照着用的例子**（一条例子就是一段能跑的脚本，点了直接插进代码里）。 */
const API_HELP = [
  {
    name: '读变量：hmi.get(名)',
    d: '返回变量当前值（没这个变量名返回 undefined，所以可以用 === undefined 判断"变量表里有没有"）。内部变量和 PLC 变量都一样读。',
    eg: "const v = hmi.get('rSpeed')\nhmi.log('当前转速', v)",
  },
  {
    name: '写变量：hmi.set(名, 值)',
    d: '写进变量表，**会按变量类型收敛后下发给 PLC**（跟控件写值走同一条路）。bool 传真假、数值传数字、字符串传文本，类型不用自己转。',
    eg: "hmi.set('bAlarmLamp', true)\nhmi.set('rSpeedSet', 1200)\nhmi.set('sMsg', '已复位')",
  },
  {
    name: '判断变量在不在：hmi.has(名)',
    d: '变量表里有没有这个名字（true/false）。脚本里防手滑用。',
    eg: "if (hmi.has('nCount')) hmi.set('nCount', 0)",
  },
  {
    name: '看全部变量：hmi.vars()',
    d: '返回一张"变量名 → 当前值"的表（快照），调试时打一行就能看一片。',
    eg: "const all = hmi.vars()\nhmi.log('nCount =', all.nCount, ' rSpeed =', all.rSpeed)",
  },
  {
    name: '写日志：hmi.log(…) / hmi.warn(…)',
    d: 'log 是普通一行（编辑器下面的日志区），warn 是黄色警告。参数个数随便，字符串/数字/对象都能打。',
    eg: "hmi.log('第', hmi.get('nCount'), '次')\nif (hmi.get('rTemp') > 70) hmi.warn('油温偏高：', hmi.get('rTemp'))",
  },
  {
    name: '算术与流程：普通 JS 都能写',
    d: '加减乘除、if/else、for/while、模板字符串、数组对象都行；写变量才能看到结果。',
    eg: "let s = 0\nfor (let i = 1; i <= 10; i++) s += i\nhmi.set('nSum', s)          // 1+…+10 = 55",
  },
  {
    name: '按条件做事（带防抖/边沿判断）',
    d: '定时脚本里最常见：变量过了阈值就做一次。用自己记的标记防止每 100ms 都触发一遍。',
    eg: "// 触发方式=定时 100ms\nlet last = hmi.get('nLastState') || 0\nconst now = hmi.get('rSpeed') > 3000 ? 1 : 0\nif (now !== last) {\n  hmi.log('状态变了：', now)\n  hmi.set('bOverSpeed', now === 1)\n  hmi.set('nLastState', now)\n}",
  },
  {
    name: '切页面 / 开弹窗：hmi.page / hmi.popup / hmi.back / hmi.hidePopup',
    d: '页面或弹窗都能按**名字**或 id 找（就是我们组态里给页面起的名字）。',
    eg: "hmi.page('报警记录')      // 切到那一页\nhmi.popup('报警详情')      // 打开弹窗\nhmi.hidePopup()           // 关掉最上面那个弹窗\nhmi.back()                // 回上一页",
  },
  {
    name: '看当前报警：hmi.alarms()',
    d: '返回正在报警的列表（只读），每条有 级别/内容/时间。可以用来做"有紧急报警就切页/闪灯"。',
    eg: "const list = hmi.alarms()\nif (list.length) hmi.set('sAlarmText', list[0].text)\nif (list.some(a => a.level === 'urgent')) hmi.warn('有紧急报警：', list[0].text)",
  },
  {
    name: '操作权限：hmi.can / hmi.permLevel / hmi.lock',
    d: '现场解锁到哪一级了、够不够某一级。可以做"有权限才让写值"，或者干完活把权限交回去。',
    eg: "if (hmi.can('工程师')) {\n  hmi.set('rSpeedSet', 1500)      // 有权限才写\n} else {\n  hmi.warn('权限不够（现在是 ' + (hmi.permLevel() || '未解锁') + '）')\n}\n// hmi.lock()   // 干完活交回权限",
  },
  {
    name: '时间：hmi.time(格式) / hmi.now()',
    d: 'time 返回格式化后的时间文本（跟时钟控件同一套格式串），now 是毫秒时间戳。',
    eg: "hmi.log('现在是', hmi.time('YYYY-MM-DD hh:mm:ss'))\nhmi.set('sStamp', hmi.time('hh:mm:ss'))\nconst ms = hmi.now()",
  },
  {
    name: '当前是哪一页：hmi.project.pageName()（还有 pageId）',
    d: '**运行态正在显示的那一页**的名字（就是组态里给页面起的名字，切页也是用这个名字）。页面 id、工程名也都有。',
    eg: "hmi.log('现在在：', hmi.project.pageName())\nif (hmi.project.pageName() === '报警记录') {\n  hmi.set('nAlarmPageSeen', 1)      // 只在这一页才做的事\n}\n// hmi.project.pageId()   → 当前页 id\n// hmi.project.name()     → 工程名",
  },
  {
    name: '工程信息：hmi.project',
    d: '工程名 / 当前页名字 / 当前页 id（都只读）。',
    eg: "hmi.log('工程：', hmi.project.name(), ' 当前页：', hmi.project.pageName())",
  },
];

/** 打开帮助对话框：每条 = 一句话说明 + 一段能直接抄的例子（旁边有「插入」） */
function openApiHelp() {
  const body = `
    <div class="api-help">
      <div class="api-help-top">
        <b>脚本里能用的东西</b>：都能直接抄。点每条右边的「插入」→ 例子进到代码光标处（对话框自己关掉）。
        <br>触发方式（什么时候跑）：<code>进运行态一次</code> / <code>定时</code> / <code>循环(50ms)</code> /
        <code>变量变化</code> / <code>条件成立</code> —— 在编辑器顶上那排选。
      </div>
      ${API_HELP.map((h, i) => `
        <div class="api-help-row">
          <div class="api-help-head"><code>${esc(h.name)}</code>
            <button type="button" class="tb-btn sm api-help-ins" data-eg="${i}">插入</button></div>
          <div class="api-help-desc">${h.d.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</div>
          <pre class="api-help-eg">${esc(h.eg)}</pre>
        </div>`).join('')}
      <div class="api-help-top" style="margin-top:10px">
        <b>几个坑</b>：<br>
        · 写变量会**下发 PLC**，别在循环脚本里每个周期都写一堆（通讯会被占满）；<br>
        · 出错会记进日志并带行号，**同一条脚本连错 5 次自动停用**（本次运行内）；<br>
        · 别写死循环 / 长时间等待（单次执行超过 200ms 会记一条警告）；<br>
        · 光写一个表达式不会有输出，要看得见就 <code>hmi.log(…)</code>，或点「▶ 试运行」看最后一句话的值。
      </div>
    </div>`;
  const dlg = showDialog({ title: '脚本 API 帮助', wide: true, body, okText: '知道了', aboveEditor: true });
  document.querySelectorAll('#dlgBody .api-help-ins').forEach(btn => {
    btn.addEventListener('click', () => {
      const eg = API_HELP[+btn.dataset.eg]?.eg || '';
      dlg.close();          // 先关对话框（不然焦点还在它上面，插不进去）
      insert(eg);
    });
  });
}

/** 打开编辑器：传 id = 编辑已有，不传 = 新建 */
export function openScriptEditor(id) {
  const sc = id ? project.getScript(id) : null;
  curId = sc ? sc.id : null;
  mask.classList.remove('hidden');
  nameEl.value = sc ? sc.name : `脚本${project.scripts().length + 1}`;
  trigEl.value = sc ? sc.trig : 'interval';
  ta.value = sc ? (sc.code || '') : "// 运行态按上面的触发方式执行\n// 右边是变量写法和 API 速查，点一下插到光标处\n\n";
  if (sc) {
    box.dataset.ms = sc.ms ?? 1000;
    box.dataset.variable = sc.variable || '';
    box.dataset.op = sc.op || '==';
    box.dataset.value = sc.value ?? 1;
  } else {
    box.dataset.ms = 1000;
    box.dataset.variable = project.variables()[0]?.name || '';
    box.dataset.op = '==';
    box.dataset.value = 1;
  }
  renderParams();
  renderVars();
  renderHl();
  renderGutter();
  renderLog();
  setStatus(sc ? `编辑「${sc.name}」` : '新建脚本', '');
  dirty = false;
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
}

export function closeScriptEditor() {
  mask.classList.add('hidden');
  curId = null;
  dirty = false;
}

/* ── 触发方式那一行的参数区 ── */
function renderParams() {
  const t = trigEl.value;
  const vars = project.variables();
  // 变量候选：**全量**（含中文名），输入框本身就是搜索框，边打字边过滤
  // （老的下拉只列得下前几十个，排在后面的中文名根本选不到）
  const varPick = `<span class="vf se-var"><input id="seVar" class="f-input vf-inp"
    value="${esc(box.dataset.variable || '')}"
    placeholder="输入变量名（可搜）" title="输入变量名（可搜），或点开下拉选">
    <button type="button" class="vf-clear" tabindex="-1" title="清空"
      ${box.dataset.variable ? '' : 'hidden'}>✕</button></span>`;
  if (t === 'interval') {
    paramEl.innerHTML = `<span class="se-lab">每</span>
      <input id="seMs" class="f-input se-num" type="number" min="10" max="600000" step="10" value="${+box.dataset.ms || 1000}">
      <span class="se-lab">毫秒执行一次</span>`;
  } else if (t === 'cycle') {
    paramEl.innerHTML = `<span class="se-lab">每个运行周期（50ms）执行一次</span>`;
  } else if (t === 'change') {
    paramEl.innerHTML = `<span class="se-lab">变量</span>${varPick}
      <span class="se-lab">的值变化时执行</span>`;
  } else if (t === 'cond') {
    paramEl.innerHTML = `<span class="se-lab">变量</span>${varPick}
      <select id="seOp" class="f-input se-op">${OPS.map(o =>
        `<option value="${o}" ${box.dataset.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
      <input id="seVal" class="f-input se-val" value="${esc(box.dataset.value ?? 1)}">
      <span class="se-lab">成立时执行（只在从「不成立」变「成立」时触发一次）</span>`;
  } else {
    paramEl.innerHTML = `<span class="se-lab">进入运行态时执行一次（做初始化）</span>`;
  }
  // ✕ 清空 / 标红：名字不在变量表里当场提示（脚本靠变量名跑，打错一个字就是永不触发）
  const vi = document.getElementById('seVar');
  if (vi) {
    attachVarPick(vi, { list: () => project.variables() });
    const mark = () => {
      const nm = vi.value.trim();
      const bad = !!nm && !project.variables().some(v => v.name === nm);
      vi.classList.toggle('bad', bad);
      vi.title = !nm ? '输入变量名（按名称搜），或点开下拉选'
        : bad ? `⚠ 变量表里没有「${nm}」—— 这个触发条件永远不会成立` : `变量表里有「${nm}」`;
      const btn = vi.parentElement?.querySelector('.vf-clear');
      if (btn) btn.hidden = !nm;
    };
    vi.addEventListener('input', mark);
    vi.parentElement?.querySelector('.vf-clear')?.addEventListener('click', () => {
      vi.value = '';
      mark();
      syncTrigPatch();          // 清空也要落到 box.dataset 上（保存时读的是它）
      vi.focus();
    });
    mark();
  }
}

function syncTrigPatch() {
  const t = trigEl.value;
  const g = (id) => document.getElementById(id);
  if (g('seMs')) box.dataset.ms = g('seMs').value;
  if (g('seVar')) box.dataset.variable = g('seVar').value;
  if (g('seOp')) box.dataset.op = g('seOp').value;
  if (g('seVal')) box.dataset.value = g('seVal').value;
  dirty = true;
  if (t === 'change' || t === 'cond') { /* 变量列表已高亮 */ }
}

function insert(text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.setRangeText(text, s, e, 'end');
  ta.focus();
  renderHl();
  renderGutter();
  dirty = true;
}

/* ── 行号 + 语法高亮 + 光标行 ── */
function renderGutter() {
  const n = ta.value.split('\n').length;
  if (gutter.dataset.n !== String(n)) {
    gutter.dataset.n = String(n);
    gutter.innerHTML = Array.from({ length: n }, (_, i) => `<div>${i + 1}</div>`).join('');
  }
  gutter.scrollTop = ta.scrollTop;
}

/** 高亮层：内容 = 语法高亮 HTML + 一个「光标行」淡蓝底（放在同一个滚动内容里，跟着一起滚） */
function renderHl() {
  if (!hl) return;
  const code = ta.value;
  hl.innerHTML = (code.length <= HL_MAX ? highlightJS(code) : esc(code)) + '\n';
  hl.appendChild(curLine);
  updateCaretLine();
  syncScroll();
}
function syncScroll() {
  if (!hl) return;
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  gutter.scrollTop = ta.scrollTop;
}
function updateCaretLine() {
  if (!curLine) return;
  const upto = ta.value.slice(0, ta.selectionStart ?? 0);
  const line = upto.split('\n').length;
  curLine.style.top = `${PAD_TOP + (line - 1) * LINE_H}px`;
}

/** 变量区只放**一个例子**（点一下插到光标处）：
 *  原来把变量表全列成按钮，变量一多就摊成一大片、还得自己找；变量名本来就是写字符串，
 *  给一条能直接用的例子 + 右边的 API 速查就够了。 */
function renderVars() {
  const name = project.variables()[0]?.name || 'bRunCmd';
  const snip = `hmi.set('${name}', true)`;
  document.getElementById('seVarsWrap').innerHTML =
    `<button type="button" class="se-chip" data-insert="${esc(snip)}"
      title="点一下插到光标处：把变量名写成字符串就行（如 '${esc(name)}'）">${esc(snip)}</button>`;
}

/* ── 保存（先做语法检查，错了不保存）── */
function syntaxCheck(code) {
  try {
    new Function('hmi', `"use strict";\n${code}\n`);
    return '';
  } catch (e) {
    return e.message;
  }
}

function save() {
  const code = ta.value;
  const bad = syntaxCheck(code);
  if (bad) {
    setStatus(`语法错误：${bad}`, 'error');
    appendLog('error', `语法错误：${bad}`);
    return false;
  }
  const t = trigEl.value;
  syncTrigPatch();
  const patch = {
    name: nameEl.value.trim() || '脚本',
    trig: t,
    code,
    ms: Math.max(10, Math.round(+box.dataset.ms || 1000)),
    variable: box.dataset.variable || '',
    op: box.dataset.op || '==',
    value: (() => {
      const raw = String(box.dataset.value ?? '').trim();
      return raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    })(),
  };
  if (curId) project.updateScript(curId, patch);
  else curId = project.addScript(patch).id;
  dirty = false;
  setStatus(`已保存（${SCRIPT_TRIG_CN[t]}）`, 'ok');
  bus.emit('scripts:changed', { id: curId });
  return true;
}

/* ── 试运行 ── */
function tryRun() {
  const code = ta.value;
  const bad = syntaxCheck(code);
  if (bad) { setStatus(`语法错误：${bad}`, 'error'); appendLog('error', `语法错误：${bad}`); return; }
  // 试运行跑的是「编辑器里当前这份代码」：先临时存进工程再跑（不然跑的是旧代码）
  const before = curId ? { ...project.getScript(curId) } : null;
  if (!save()) return;
  logEl.innerHTML = '';
  const res = runScriptOnce(curId);
  renderLog();
  setStatus(res.ok
    ? `试运行完成（${res.ms.toFixed(1)}ms）`
    : `试运行失败：${res.error}`, res.ok ? 'ok' : 'error');
  // 新建的脚本试运行后保留；已有脚本把「代码/触发」留在工程里（这就是保存过的内容）
  if (!before) bus.emit('scripts:changed', { id: curId });
}

function renderLog() {
  const lines = curId ? scriptLog(curId) : [];
  logEl.innerHTML = lines.map(l =>
    `<div class="se-line ${l.level}">${esc(l.text)}</div>`).join('');
  logEl.scrollTop = logEl.scrollHeight;
}

function appendLog(level, text) {
  const div = document.createElement('div');
  div.className = `se-line ${level}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `se-status ${kind || ''}`;
}
