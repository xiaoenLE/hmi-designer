/**
 * varPick.js — 变量选择：**输入框本身就是搜索框**，下面挂一张候选表
 *
 * 检索**以变量名为主，地址也算命中**：
 *   · 名字命中的排在**前面**（选变量九成是照着名字找）；
 *   · 光地址命中的跟在后面，行里打个「按地址」的小标记 ——
 *     现场常常是**拿着 PLC 上的点位来找变量**（"MW100 是哪个变量"），
 *     以前只认名字，这种就一个都搜不到（现场反馈）。
 *   · 类型不参与匹配（打 real 不该冒出一堆 real 变量）。
 * 类型和地址照旧显示在候选行右边，帮你确认"选中的是不是这一个"。
 *
 * 为什么不用原生 `<datalist>`（试过，放弃了）：
 *   ① 候选弹层是浏览器自己的原生素件 —— 长相控制不了，自动化里也**测不到**
 *      （page.screenshot() 拍不到它，只能靠肉眼），回归用例写不出来；
 *   ② 过滤规则由浏览器定，我们说了不算（按名称搜是底线，不该赌浏览器行为）；
 *   ③ 变量上千时，能把「类型 / 地址 / 已在通道N」直接排在候选行右边，一眼分得清。
 *
 * 交互：点进框里（或打字）就出候选；**点进去先按框里已有的名字过滤**（现场要求：
 *       点回来就是想找同名/近名的那个，先看到 300 个变量还得先删一个字符才检索，太绕）；
 *       **边打字边过滤**；↑↓ 选，回车确认，Esc 关掉；想浏览全部就把框清空（右侧 ✕ 一键清）；
 *       鼠标点一行即选中（mousedown 里 preventDefault，免得输入框先失焦把表关掉）。
 *
 * ★ 顺手新建变量：框里打的名字**变量表里没有**时，候选表底下多一行
 *   「＋ 新建变量「xxx」…」—— 点它（或一个匹配都没有时直接回车）弹出「新建变量」
 *   （名称/数据类型/地址/长度/保持，见 varAdd.js），建完自动填回这个框。
 *   现场就是这么用的：名字是从 PLC 程序里抄来的点位，打完就想建，不该再跑去变量表面板新建一遍。
 */
import { escapeHtml } from '../core/utils.js';

const MAX_ROWS = 300;      // 一次最多画这么多行：再多也没人翻，接着打字缩小范围更快
let listEl = null;
let ctx = null;            // { input, provider, rows, idx }
let picking = false;       // 正在"选定"（此时 input 事件是 pick 自己发的，不能再把表弹开）

function esc(s) { return escapeHtml(String(s ?? '')); }

/** 候选表容器（全应用共用一个，挂在 body 上：面板/对话框都是反复重建的） */
function ensureList() {
  if (listEl) return listEl;
  listEl = document.createElement('div');
  listEl.className = 'vp-list';
  listEl.hidden = true;
  document.body.appendChild(listEl);
  // 用 pointerdown（不是 mousedown）：触摸屏/触控笔上 tapping 也走这条（现场是工业面板）
  listEl.addEventListener('pointerdown', e => {
    const row = e.target.closest('.vp-row');
    if (!row) return;
    e.preventDefault();              // 别让输入框先失焦（失焦就把表关了，点不着）
    if (row.dataset.new === '1') { createNew(row.dataset.nm || ''); return; }   // 「＋ 新建变量」那一行
    pick(+row.dataset.i);
  });
  // 点别处 → 关掉
  document.addEventListener('pointerdown', e => {
    if (!ctx) return;
    if (e.target === ctx.input || listEl.contains(e.target)) return;
    closeVarPick();
  }, true);
  // 面板/窗口滚动 → 候选表是 fixed 定位的，**跟着输入框挪**（不能一滚就关，见下面那段）
  // ⚠ 列表自己滚动不算：滚轮翻候选、方向键翻页都会让 .vp-list 发 scroll 事件，
  //   捕获阶段照样能收到 —— 以前一律 close，结果"一滚就没了、选不了"（现场反馈过）。
  window.addEventListener('scroll', e => {
    if (!ctx) return;
    if (listEl.contains(e.target)) return;
    // ⚠⚠ 不能"一滚就关"：**聚焦本身就会让浏览器把输入框滚进视野**（输入框在面板靠下位置时必然发生），
    //   那一下 scroll 会把刚弹出来的候选表当场关掉 —— 现场表现就是"点了变量框，候选表一闪就没了 / 根本没出来"。
    //   面板每多一栏就更矮，这个坑就更容易踩（点击穿透那一栏加进来时就踩到了）。
    //   所以：输入框还在视野里 → 只是挪一下位置；滚出视野了 → 才关。
    const r = ctx.input.getBoundingClientRect();
    if (r.bottom > 0 && r.top < window.innerHeight) placeList(ctx.input);
    else closeVarPick();
  }, true);
  window.addEventListener('resize', () => { if (ctx) closeVarPick(); });
  return listEl;
}

/** 候选表定位：贴着输入框下方；下面放不下就翻到输入框上方（属性面板靠底部时经常遇到）。
 *  ⚠ 调用前候选表必须是**显示**状态：隐藏时 offsetHeight 是 0，翻不翻上就算错了。 */
function placeList(input) {
  const el = ensureList();
  const r = input.getBoundingClientRect();
  const w = Math.max(r.width, 260);
  el.style.width = `${Math.min(w, window.innerWidth - 16)}px`;
  el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 8))}px`;
  const h = el.offsetHeight;
  const below = r.bottom + 2;
  el.style.top = (below + h > window.innerHeight - 6 && r.top - h - 2 > 4)
    ? `${r.top - h - 2}px` : `${below}px`;
}

/**
 * 给一个变量输入框挂上候选表。
 * @param {HTMLInputElement} input
 * @param {{list:()=>Array<{name,type,address}>, note?:(name:string)=>string}} provider
 *        list 每次打开/打字时**现查**（变量表随时会变）；note 是候选行右边的灰色备注
 *        （如「已在通道2」「类型不匹配」——只提示，不隐藏：为什么不能用得让人看得见）
 */
export function attachVarPick(input, provider) {
  if (!input || input._vpBound) return;
  input._vpBound = true;
  input._provider = provider;
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  input.addEventListener('focus', () => openVarPick(input));   // 点进来就按框里的名字先过滤一遍
  input.addEventListener('input', () => {
    if (picking) return;             // 自己发的 input（选定那一下）别再弹表
    if (ctx?.input === input || document.activeElement === input) openVarPick(input);
  });
  input.addEventListener('keydown', onKey);
  // 失焦关表：留一点点延迟，让候选行上的 mousedown 先跑完
  input.addEventListener('blur', () => setTimeout(() => { if (ctx && ctx.input === input) closeVarPick(); }, 140));
}

/** 检索命中：**名字命中的排前面**，光地址命中的跟在后面（两组都保留，行里各自有标记）。
 *  为什么要分两组而不是混着过滤：混着的话，打 "Motor1" 时地址里含 motor1 的会把
 *  真正叫 bMotor1 的挤到下面去（甚至被 MAX_ROWS 截掉）—— 而选变量九成是找名字。 */
function matchRows(all, q) {
  const byName = [], byAddr = [];
  all.forEach(v => {
    if (String(v.name || '').toLowerCase().includes(q)) byName.push({ v, byAddr: false });
    else if (String(v.address || '').toLowerCase().includes(q)) byAddr.push({ v, byAddr: true });
  });
  return byName.concat(byAddr);
}

/**
 * 打开/刷新候选表。
 *
 * **框里有名字时也先按它过滤**（现场要求）：以前点进框里一律列全量，看着"我明明有名字，
 * 怎么一进去就是几百个变量、还得先删一个字符才开始检索"。现在点进去就是对当前名字的检索结果
 * （通常就是那一个，或名字相近的几个），想换别的直接接着打字覆盖即可；
 * 想浏览全部就把框清空（右侧 ✕ 一键清空，或全选删掉）。
 *
 * @param {HTMLInputElement} input
 * @param {{all?:boolean}} [opts] all=true = 忽略框里的值、把**全部**候选列出来
 *        （留给"就是想浏览一遍变量表"的入口用，目前没有调用方）
 */
export function openVarPick(input, opts = {}) {
  const provider = input?._provider;
  if (!provider) return;
  const el = ensureList();
  const typed = String(input.value || '').trim();
  const q = opts.all ? '' : typed.toLowerCase();
  const all = provider.list() || [];
  const note = provider.note || (() => '');
  const rows = q ? matchRows(all, q) : all.map(v => ({ v, byAddr: false }));
  /* 「＋ 新建变量」那一行：框里打了字、而且**变量表里没有同名的**才给。
     （同名时用户要的是"就是它"，再给个"新建同名变量"只会让人误点。）
     地址命中的那种不算同名 —— 名字确实还不存在，也让他能建。 */
  const offerNew = !!typed && !all.some(v => String(v.name) === typed);
  ctx = { input, provider, rows, idx: -1, offerNew, typed };

  const shown = rows.slice(0, MAX_ROWS);
  const listHtml = shown.map((r, i) => {
    const v = r.v;
    // 行里**先看变量名**（选的就是它）；类型/地址只是右边的说明。
    // ⚠ OPC UA 的地址是长 NodeId（ns=4;s=|var|CODESYS…），整条塞进去会把变量名挤出可视区
    //   —— 现场看着就是"候选里全是地址、没有变量名"。长地址只在悬停提示里给。
    const addr = String(v.address || '');
    const meta = [v.type, addr.length <= 22 ? addr : ''].filter(Boolean).join(' · ');
    const n = note(v.name);
    const tip = addr ? `${v.name}\n${[v.type, addr].filter(Boolean).join(' · ')}` : v.name;
    return `<div class="vp-row${v.name === typed ? ' cur' : ''}" data-i="${i}"
        ${r.byAddr ? 'data-byaddr="1"' : ''} title="${esc(tip)}">
      <span class="vp-name">${esc(v.name)}</span>
      ${n ? `<span class="vp-note">${esc(n)}</span>` : ''}
      ${r.byAddr ? '<span class="vp-tag" title="这条是按**地址**匹配上的（名字里没有这几个字）">按地址</span>' : ''}
      ${meta ? `<span class="vp-meta">${esc(meta)}</span>` : ''}
    </div>`;
  }).join('') + (rows.length > MAX_ROWS
    ? `<div class="vp-more">还有 ${rows.length - MAX_ROWS} 个，接着打字缩小范围</div>` : '');
  // 新建那一行：查不到任何匹配时它就是唯一一条（这时空提示就不画了）
  const newHtml = offerNew
    ? `<div class="vp-row vp-new" data-new="1" data-nm="${esc(typed)}"
         title="变量表里没有「${esc(typed)}」—— 点这里新建一条（填数据类型 / PLC 地址），建完自动填回这个框">
        <span class="vp-plus">＋</span><span class="vp-name">新建变量「${esc(typed)}」</span>
        <span class="vp-meta">填地址/类型</span>
      </div>`
    : '';
  el.innerHTML = (listHtml + newHtml)
    || `<div class="vp-empty">没有匹配的变量（${esc(typed || '变量表是空的')}）</div>`;

  // 先显示再定位：placeList 要量高度才知道下面放不放得下（隐藏时量出来是 0）
  el.hidden = false;
  placeList(input);
}

/** 「＋ 新建变量」→ 弹新建对话框；建完把名字填回输入框（走 pick 那条路，面板照常保存）。 */
function createNew(name) {
  const c = ctx;
  if (!c) return;
  const inp = c.input;
  closeVarPick();                       // 先收候选表，免得压着对话框
  // 动态 import：变量选择器是热路径（每个变量框都要挂），别让它启动就拖着对话框模块
  import('./varAdd.js')
    .then(m => m.openAddVarDialog({ name, onDone: (nm) => fillInput(inp, nm) }))
    .catch(e => alert('打开「新建变量」失败：' + (e?.message || e)));
}

export function closeVarPick() {
  if (listEl) listEl.hidden = true;
  ctx = null;
}

function setIdx(next) {
  if (!ctx) return;
  const n = Math.min(ctx.rows.length, MAX_ROWS);
  if (!n) return;
  ctx.idx = (next + n) % n;
  const el = listEl.querySelector('.vp-row.on');
  if (el) el.classList.remove('on');
  const row = listEl.querySelector(`.vp-row[data-i="${ctx.idx}"]`);
  if (row) { row.classList.add('on'); row.scrollIntoView({ block: 'nearest' }); }
}

/** 把一个变量名写进输入框，并按「手输」的路径发 input/change（面板那边照常保存）。
 *  ⚠ 值跟框里已经写的一模一样时**也要**发 change：用户常常是先打几个字（框里有名字了），
 *    再从候选里点一下确认 —— 那一瞬间工程数据还没落，少发这个 change 就等于点了没反应。 */
function fillInput(inp, name) {
  if (!inp) return;
  inp.value = name;
  picking = true;
  try {
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  } finally {
    picking = false;
  }
}

/** 选中第 i 行：写进输入框（见 fillInput） */
function pick(i) {
  const c = ctx;
  if (!c) return;
  const row = c.rows[i];
  const v = row && row.v;
  if (!v) return;
  const inp = c.input;
  closeVarPick();
  fillInput(inp, v.name);
}

function onKey(e) {
  const inp = e.currentTarget;
  const open = ctx && ctx.input === inp;
  if (e.key === 'Escape') {
    if (open) { e.stopPropagation(); closeVarPick(); }     // 别把 Esc 传给对话框（顺手关了脚本编辑器）
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) { openVarPick(inp); return; }
    e.preventDefault();
    setIdx(ctx.idx + (e.key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (e.key === 'Enter') {
    if (!open) return;
    e.preventDefault();
    // 一个匹配都没有、而且框里那个名字变量表里没有 → 直接弹「新建变量」（现场：名字是从
    // PLC 程序里抄的，打完就想建；让他再拿鼠标去点那一行太绕）。有匹配就照老习惯取第一个。
    if (!ctx.rows.length && ctx.offerNew) { createNew(ctx.typed); return; }
    pick(ctx.idx >= 0 ? ctx.idx : 0);
  }
}
