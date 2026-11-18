/**
 * varSearch.js — 变量「在哪里用到 / 替换」（查找引用）
 *
 * 现场要解决的问题："这个变量到底有没有用？都在哪儿用？" —— 变量表几百条，
 * 光靠控件清单一个个翻是翻不出来的。这里把引用**一处一处列出来**：
 *
 *   · 控件绑定（含公共底上的控件：会写明是哪个底）      → 点一下跳到那页并选中那个控件
 *   · 波形多通道（第几路）、通道配色/量程键             → 同上
 *   · 按钮/控件动作（点动·切换·置值、跳页动作里的变量）  → 同上
 *   · 报警触发条件、报警内容里的 {变量}                 → 点一下打开那条报警的编辑框
 *   · 脚本触发变量、脚本代码里的 hmi.get/set/has('名字') 与 hmi.v.名字（属性写法） → 点一下打开那个脚本
 *
 * 另外两件事（现场一起提的）：
 *   · **记住上次的搜索**：只留最后一次查的词（不是攒一堆历史），下次打开对话框把它填回去、
 *     并立刻把结果重跑一遍 —— 就是"上次查的那个还在这儿"。
 *   · **替换**：把「某个变量的所有引用」整体换成另一个变量（含脚本里 hmi.get/set 的字符串），
 *     一次 commit = 一步撤销；可选"替换完把旧变量删掉（它已经没人用了）"。
 *   · 入口：变量面板「🔍 查找/替换…」· 变量行右键 · 控件右键（查它绑的那个变量）· **Ctrl+F**。
 *
 * 为什么不做"正则搜索/全工程文本替换"：变量引用在工程里是**结构化**的（绑定/动作/条件各是一处字段），
 * 按结构扫才既准又能定位；自由文本只出现在报警内容和脚本里，那两处单独处理。
 */
import { project } from '../core/project.js';
import { registry, ACTION_DEFS } from '../widgets/registry.js';
import { escapeHtml as esc, statusNote, scriptVarPropRe, normAddr } from '../core/utils.js';
import { showDialog } from './toolbar.js';
import { attachVarPick } from './varPick.js';
import { focusWidget, getSelection } from './canvas.js';

const LS_KEY = 'hmi-varsearch-v1';

/** 报警内容里的 {变量} 引用（和 alarmsPanel 同一套取法：不是花括号、不是空白） */
const RE_REF = /\{([^{}\s]+)\}/g;

/** 地址比较用的归一化：HR2000 / 2000 / %mw2000 都归到同一串（前缀 % 与大小写不计较）。
 *  归一化交给 normAddr（和变量表里"地址写法自动统一"是同一个函数），认不出的原样返回。 */
function addrKey(s) {
  return normAddr(String(s ?? '')).toLowerCase().replace(/^%/, '');
}

function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
  return s;
}
/**
 * 记住这次搜索的词（**只留最后一次**：现场要的是"打开就是上次那个"，
 * 不是攒一串历史 —— 变量名本来就长，堆一列反而碍事）。
 */
export function rememberSearch(q) {
  const term = String(q || '').trim();
  if (!term) return;
  saveState({ q: term, at: new Date().toISOString() });
}
/** 上次查的词（+ 上次的匹配方式、上次的替换目标）—— 对话框打开时用 */
export function lastSearch() {
  const s = loadState();
  return { q: s.q || '', fuzzy: s.fuzzy !== false, to: s.to || '' };
}

/**
 * 绑定快捷键：**Ctrl+F / Cmd+F = 查找变量**（编辑态）。
 *   有选中的控件而且它绑了变量 → 直接查那个变量（"这个控件用的是哪个变量、还在哪儿用"最顺）；
 *   否则查上次那个词。
 * ⚠ 运行态不响应（`/run` 是给现场看的，没有编辑功能）；焦点在输入框里也照常响应
 *   —— 用户多半正停在变量面板的搜索框/地址格里按这个键。
 */
export function initVarSearch() {
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (String(e.key).toLowerCase() !== 'f') return;
    // 运行态：不响应（Ctrl+Shift+F 那套是运行态自己的视图切换）
    const rt = document.getElementById('runtimeRoot');
    if (rt && !rt.classList.contains('hidden')) return;
    const searchOpen = document.querySelector('#dlgMask:not(.hidden) #vsQ');
    e.preventDefault();
    if (searchOpen) { searchOpen.focus(); searchOpen.select(); return; }   // 已经开着 → 聚焦到搜索框
    // 别的对话框开着（权限管理/PLC 设置…）就别插队，先让用户处理完
    const otherDlg = document.querySelector('#dlgMask:not(.hidden)');
    if (otherDlg) return;
    openVarSearch(selectedVarName() || '');
  });
}

/** 当前选中控件的变量（绑定优先，其次动作里那个）—— Ctrl+F 用它预填 */
function selectedVarName() {
  const id = getSelection()[0];
  const w = id ? project.getWidget(id) : null;
  if (!w) return '';
  return w.bindings?.variable
    || (w.bindings?.variables || []).find(Boolean)
    || (w.actions || []).map(a => a.params?.variable).find(Boolean)
    || '';
}

/**
 * 扫一遍工程：这些变量用在哪些地方。
 * @param {string} query 变量名（或名字的一部分）**也可以直接打地址**（MW2000 / %MW2000 / HR2000）
 * @param {{fuzzy?:boolean}} [opt] fuzzy（默认 true）= 按"包含"匹配，false = 精确匹配整个名字/地址
 * @returns {{q:string, fuzzy:boolean, vars:Array<{name,type,address,retain,byAddr,hits:Array}>, totalHits:number}}
 *          vars 里**包含没被用到的变量**（hits 为空数组）—— "有没有用"本身就是答案
 *          `byAddr` = 这条是**按地址**匹配上的（名字里没有这几个字），界面上打「按地址」标记
 */
export function scanVarUsage(query, opt = {}) {
  const q = String(query || '').trim();
  const fuzzy = opt.fuzzy !== false;
  const lc = q.toLowerCase();
  /* 命中：**名字优先，地址也算**（现场：拿着 PLC 上的点位找变量 ——
     "MW2000 是哪个变量？用在哪？"）。以前只按名字，这种就一个都搜不出来。
     · 名字命中的排前面，光地址命中的跟在后面（标 byAddr，界面上打「按地址」）；
     · 地址不走字符串直比：先用 normAddr 归一化再比，于是 HR2000 / 2000 / %mw2000
       都能对上变量表里的 %MW2000（跟变量表里"地址写法自动统一"是同一套规矩）。 */
  const hitName = (v) => (fuzzy ? String(v.name).toLowerCase().includes(lc) : v.name === q);
  const hitAddr = (v) => {
    const a = addrKey(v.address);
    if (!a) return false;
    const k = addrKey(q);
    return k ? (fuzzy ? a.includes(k) : a === k) : false;
  };
  const all = project.variables();
  const matched = [
    ...all.filter(hitName).map(v => ({ v, byAddr: false })),
    ...all.filter(v => !hitName(v) && hitAddr(v)).map(v => ({ v, byAddr: true })),
  ];
  const vars = matched.map(({ v, byAddr }) => ({
    name: v.name, type: v.type, address: v.address || '', retain: !!v.retain, byAddr, hits: [],
  }));
  const byName = new Map(vars.map(o => [o.name, o]));
  const has = (name) => byName.has(name);
  /** 只有"精确等于某个匹配到的变量名"才算引用（部分匹配不会把别人的引用算进来） */
  const add = (name, kind, label, jump) => {
    const o = byName.get(name);
    if (o) o.hits.push({ kind, label, jump });
  };
  const wtName = (w) => `${registry.get(w.type)?.title || w.type}「${w.name}」`;

  /* ── 页面控件（含公共底：底上的控件是"套用它的页面"共用的那一层，标注清楚） ── */
  project.pages().forEach(p => {
    const where = p.type === 'base' ? `公共底「${p.name}」` : `页面「${p.name}」`;
    p.widgets.forEach(w => {
      const jump = { pageId: p.id, widgetId: w.id };
      add(w.bindings?.variable, 'bind', `${where} · ${wtName(w)} 的绑定变量`, jump);
      (w.bindings?.variables || []).forEach((n, i) => {
        add(n, 'wave', `${where} · ${wtName(w)} 第 ${i + 1} 通道`, jump);
      });
      Object.keys(w.props?.colors || {}).forEach(n => add(n, 'wave', `${where} · ${wtName(w)} 通道配色`, jump));
      Object.keys(w.props?.scales || {}).forEach(n => add(n, 'wave', `${where} · ${wtName(w)} 通道量程`, jump));
      (w.actions || []).forEach(a => {
        const cn = ACTION_DEFS[a.type]?.label?.split('（')[0] || a.type;
        add(a.params?.variable, 'action', `${where} · ${wtName(w)} 的动作「${cn}」`, jump);
      });
    });
  });

  /* ── 报警：触发条件 + 内容里的 {变量} ── */
  project.alarms().forEach(a => {
    const jump = { alarmId: a.id };
    add(a.variable, 'alarm', `报警「${a.name}」的触发条件`, jump);
    const text = String(a.text || '');
    RE_REF.lastIndex = 0;
    let m;
    while ((m = RE_REF.exec(text))) add(m[1], 'alarmText', `报警「${a.name}」内容里的 {${m[1]}}`, jump);
  });

  /* ── 脚本：触发变量 + 代码里的**两种写法** ──
     · 函数写法：hmi.get('名字') / hmi.set('名字', v) / hmi.has('名字')
     · 属性写法：hmi.v.名字 / hmi.v['名字']（较新的省字写法）
     两种都要扫到：属性写法漏了，"这个变量没人用"就会误判（改名也跟着漏，脚本静默失效）。 */
  // 组：1 = 方法名（get/set/has）· 2 = 引号 · 3 = 变量名字符串
  const apiRe = () => /\bhmi\s*\.\s*(get|set|has)\s*\(\s*(['"])([^'"]+)\2/g;
  project.scripts().forEach(s => {
    const jump = { scriptId: s.id };
    add(s.variable, 'scriptTrig', `脚本「${s.name}」的触发变量`, jump);
    const code = String(s.code || '');
    const seenApi = new Set();      // 一个脚本里同一个变量只算一处（两种写法合起来算一处）
    let m;
    const re = apiRe();
    while ((m = re.exec(code))) {
      const n = m[3];
      if (!has(n) || seenApi.has(n)) continue;
      seenApi.add(n);
      add(n, 'scriptCode', `脚本「${s.name}」代码里 hmi.${m[1]}('${n}')`, jump);
    }
    const pre = scriptVarPropRe();
    while ((m = pre.exec(code))) {
      const n = m[1] || m[3];
      if (!has(n) || seenApi.has(n)) continue;
      seenApi.add(n);
      add(n, 'scriptCode', `脚本「${s.name}」代码里 hmi.v.${n}（属性写法）`, jump);
    }
    // 代码里以字符串出现、但不是上面两种写法的（自由文本/别的写法）→ 值提示
    if (q) {
      vars.forEach(o => {
        if (code.includes(o.name) && !seenApi.has(o.name)) {
          o.hits.push({
            kind: 'scriptText',
            label: `脚本「${s.name}」里还出现过字符串 "${o.name}"（不是 hmi.get/set 或 hmi.v 的写法，自己看一眼）`,
            jump,
          });
        }
      });
    }
  });

  const totalHits = vars.reduce((n, o) => n + o.hits.length, 0);
  return { q, fuzzy, vars, totalHits };
}

/** 引用的中文标签（结果行左边那个小色块） */
const KIND_CN = {
  bind: '绑定', wave: '波形', action: '动作', alarm: '报警条件',
  alarmText: '报警内容', scriptTrig: '脚本触发', scriptCode: '脚本代码', scriptText: '脚本(文本)',
};

/* ─────────── 对话框 ─────────── */

let cur = null;        // { scan, picked } —— 当前这次搜索 / 选中的替换来源

/** 打开「查找变量 / 替换」对话框。传了 name 就先查它（变量行右键、"用在哪"入口用） */
export function openVarSearch(name, opts = {}) {
  const st = lastSearch();
  const q0 = String(name || st.q || '');
  cur = { scan: null, picked: '' };
  showDialog({
    title: '查找变量 · 在哪用到 / 替换',
    okText: '关闭',
    wide: true,
    body: `
      <div class="f-row">
        <span class="f-label">查找变量</span>
        <input class="f-input mono" id="vsQ" spellcheck="false"
               placeholder="变量名**或地址**（都能只打一部分：rSpeed / 速度 / MW2000 / %MW2000）；快捷键 Ctrl+F 打开这个框">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;flex:none">
          <input type="checkbox" id="vsFuzzy" ${st.fuzzy ? 'checked' : ''}><span style="font-size:12px">包含匹配</span></label>
      </div>
      <div id="vsOut" class="vs-out"></div>
      <div class="vs-replace">
        <span class="f-label">替换为</span>
        <input class="f-input mono" id="vsTo" spellcheck="false" value="${esc(st.to)}"
               placeholder="点开选一个变量（把上面选中的那条变量的引用全换掉）">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;flex:none"
               title="替换完如果旧变量已经没有任何引用了，就顺手删掉它（变量表更干净；删错了 Ctrl+Z 一起回来）">
          <input type="checkbox" id="vsDel"><span style="font-size:12px">删掉旧变量</span></label>
        <button type="button" class="tb-btn danger" id="vsGo" style="flex:none">全部替换</button>
      </div>`,
    onOk: () => true,
  });

  const $ = (id) => document.getElementById(id);
  const input = $('vsQ');
  input.focus();
  input.select();

  /* 替换目标：复用变量选择器（点开看全部候选，打字按名字过滤） */
  attachVarPick($('vsTo'), {
    list: () => project.variables().map(v => ({ name: v.name, type: v.type, address: v.address })),
    note: (n) => (n === cur?.picked ? '就是它（同一个变量）' : ''),
  });

  /* 边打边查（250ms 防抖），回车立刻查 */
  const note = () => rememberSearch(input.value);
  let timer = null;
  const run = () => { cur.scan = scanVarUsage(input.value, { fuzzy: $('vsFuzzy').checked }); paint(); };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); note(); run(); }
  });
  input.addEventListener('change', () => note());
  $('vsFuzzy').addEventListener('change', () => { saveState({ fuzzy: $('vsFuzzy').checked }); run(); });
  $('vsGo').addEventListener('click', doReplace);
  $('vsTo').addEventListener('change', () => saveState({ to: $('vsTo').value.trim() }));

  if (q0) { input.value = q0; run(); }
  else paint();
  if (opts.focusReplace) setTimeout(() => $('vsTo')?.focus(), 60);
}

/** 画结果区（一次搜索的结果 + 替换来源选择） */
function paint() {
  const box = document.getElementById('vsOut');
  if (!box) return;
  const s = cur?.scan;
  if (!s) {
    box.innerHTML = '<div class="vs-empty">打一个变量名（或名字的一部分）开始查 —— <b>直接打地址也行</b>'
      + '（MW2000 / %MW2000 / HR2000）—— 会列出它在控件、波形、动作、报警、脚本里的每一处引用。</div>';
    return;
  }
  if (!s.vars.length) {
    box.innerHTML = `<div class="vs-empty">变量表里没有匹配「${esc(s.q)}」的变量`
      + `（按**名称和地址**都没找到${s.fuzzy ? '' : '；当前是精确匹配'}）。</div>`;
    return;
  }
  if (!cur.picked || !s.vars.some(v => v.name === cur.picked)) cur.picked = s.vars[0].name;
  const html = s.vars.map(v => {
    const picked = v.name === cur.picked;
    const hits = v.hits.length
      ? v.hits.map((h, i) => `
          <div class="vs-hit" data-v="${esc(v.name)}" data-i="${i}">
            <span class="vs-tag vs-${h.kind}">${esc(KIND_CN[h.kind] || h.kind)}</span>
            <span class="vs-where">${esc(h.label)}</span>
            <button type="button" class="tb-btn sm vs-jump" data-v="${esc(v.name)}" data-i="${i}">定位</button>
          </div>`).join('')
      : '<div class="vs-hit vs-none"><span class="vs-tag vs-none">没用</span><span class="vs-where">这个变量没有任何地方引用它（可以先留着，也可以删掉）</span></div>';
    return `
      <div class="vs-var${picked ? ' picked' : ''}" data-v="${esc(v.name)}">
        <div class="vs-head">
          <input type="radio" name="vsPick" ${picked ? 'checked' : ''} title="选中它 → 下面「替换为」就是把它换掉">
          <b class="mono">${esc(v.name)}</b>
          <span class="badge blue">${esc(v.type)}</span>
          ${v.byAddr ? '<span class="badge addr" title="这条是**按地址**匹配上的（名字里没有你打的这几个字）">按地址</span>' : ''}
          ${v.address ? `<span class="vs-addr mono" title="${esc(v.address)}">${esc(v.address)}</span>`
            : '<span class="vs-addr">内部变量</span>'}
          ${v.retain ? '<span class="badge purple" title="掉电保持（HMI 内部）">保持</span>' : ''}
          <span class="vs-count">${v.hits.length ? `${v.hits.length} 处引用` : '没被引用'}</span>
        </div>
        <div class="vs-hits">${hits}</div>
      </div>`;
  }).join('');
  box.innerHTML = `
    <div class="vs-sum">匹配 <b>${s.vars.length}</b> 个变量 · 共 <b>${s.totalHits}</b> 处引用
      <span style="color:var(--text-2)">（点「定位」跳过去；圆点选中哪个，右边「全部替换」就换哪个）</span></div>
    ${html}`;

  box.querySelectorAll('.vs-var').forEach(el => {
    el.querySelector('input[name="vsPick"]')?.addEventListener('change', () => {
      cur.picked = el.dataset.v;
      paint();
    });
  });
  box.querySelectorAll('.vs-jump, .vs-hit').forEach(el => {
    if (el.classList.contains('vs-hit') && el.classList.contains('vs-none')) return;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = s.vars.find(x => x.name === (el.dataset.v || ''));
      const h = v?.hits[Number(el.dataset.i)];
      if (h) jumpTo(h);
    });
  });
}

/** 点「定位」：控件 → 跳到那页并选中它；报警 → 打开那条报警；脚本 → 打开那个脚本 */
function jumpTo(hit) {
  const j = hit.jump || {};
  closeDialog();
  // 先关对话框再跳（对话框是 #dlgMask，打开报警编辑框会把它顶掉；关了更干净）
  setTimeout(() => {
    if (j.widgetId) {
      project.setCurrentPage(j.pageId);
      requestAnimationFrame(() => focusWidget(j.widgetId));
      statusNote(hit.label);
      return;
    }
    if (j.alarmId) {
      import('./alarmsPanel.js').then(m => m.openAlarmEditor(j.alarmId));
      return;
    }
    if (j.scriptId) {
      import('./scriptEditor.js').then(m => m.openScriptEditor(j.scriptId));
    }
  }, 30);
}

function closeDialog() {
  document.getElementById('dlgMask')?.classList.add('hidden');
}

/** 全部替换：把选中变量的引用换成「替换为」里那个（一步撤销） */
function doReplace() {
  const from = cur?.picked;
  const to = document.getElementById('vsTo')?.value.trim();
  if (!from) return alert('先在上面选一个要替换的变量');
  if (!to) return document.getElementById('vsTo')?.focus();
  if (from === to) return alert('旧变量和新变量是同一个，不用替换');
  const toVar = project.variables().find(v => v.name === to);
  if (!toVar) return alert(`变量表里没有「${to}」—— 先在变量表里把它建好（或从候选里选一个现有的）`);
  const scan = cur.scan || scanVarUsage(from, { fuzzy: false });
  const hits = scan.vars.find(v => v.name === from)?.hits.length || 0;
  const del = !!document.getElementById('vsDel')?.checked;
  if (!confirm(`把「${from}」的 ${hits} 处引用全部替换成「${to}」？`
    + (del ? '\n（替换完旧变量没有任何引用了，会一起删掉）' : '')
    + '\n\n引用包括：控件绑定 / 波形通道 / 动作 / 报警条件与内容 / 脚本里的 hmi.get·set 与 hmi.v.名字。\n改错了 Ctrl+Z 一步撤销。')) return;

  // 一次改完、一次 commit（= 一步撤销）。
  // 脚本**先单独调一次**：remapScriptRefs 会回一份"改了几处"的统计（触发变量 / 代码里的字符串），
  // remapVarRefs 内部再调它时已经没东西可改（幂等），所以不会重复改。
  const sc = project.remapScriptRefs(from, to);
  project.remapVarRefs(from, to);
  let removed = false;
  if (del && !project.variableRefs(from)) {
    project.data.variables = project.data.variables.filter(v => v.name !== from);
    removed = true;
  }
  project.commit(`替换变量 ${from} → ${to}`);
  saveState({ to, q: from });
  const extra = [
    sc.trig ? `脚本触发变量 ${sc.trig} 处` : '',
    sc.code ? `脚本代码 ${sc.code} 处` : '',
    removed ? '旧变量已删除' : '',
  ].filter(Boolean).join('、');
  statusNote(`已把「${from}」的引用替换成「${to}」${extra ? `（${extra}）` : ''}（Ctrl+Z 可撤销）`);
  if (sc.suspicious) {
    console.warn('[varSearch] 有脚本里还出现旧名字，但不是 hmi.get/set 或 hmi.v 的写法，没自动改：', from);
  }
  // 换完再扫一遍，结果立刻反映新状态
  const input = document.getElementById('vsQ');
  if (input) { input.value = to; cur.scan = scanVarUsage(to, { fuzzy: document.getElementById('vsFuzzy').checked }); paint(); }
}
