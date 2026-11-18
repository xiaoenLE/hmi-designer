/**
 * varPick.js — 变量选择：**输入框本身就是搜索框**，下面挂一张候选表
 *
 * 检索**只认变量名**（用户明确要求：别拿地址/类型来凑匹配 —— 打 "HR500" 冒出一堆
 * 不相干的变量只会更乱）。类型和地址只作为候选行右边的说明显示，帮你确认"选中的是不是
 * 这一个"（速度1 / 速度2 这种长得像的，看一眼地址最保险）。
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
  const q = opts.all ? '' : String(input.value || '').trim().toLowerCase();
  const all = provider.list() || [];
  const note = provider.note || (() => '');
  // ⚠ 只看 name：地址/类型是给人看的备注，不参与匹配（打 "HR500" 不该冒出一串变量）
  const rows = q ? all.filter(v => String(v.name || '').toLowerCase().includes(q)) : all;
  ctx = { input, provider, rows, idx: -1 };

  const shown = rows.slice(0, MAX_ROWS);
  el.innerHTML = shown.length
    ? shown.map((v, i) => {
      // 行里**先看变量名**（选的就是它）；类型/地址只是右边的说明。
      // ⚠ OPC UA 的地址是长 NodeId（ns=4;s=|var|CODESYS…），整条塞进去会把变量名挤出可视区
      //   —— 现场看着就是"候选里全是地址、没有变量名"。长地址只在悬停提示里给。
      const addr = String(v.address || '');
      const meta = [v.type, addr.length <= 22 ? addr : ''].filter(Boolean).join(' · ');
      const n = note(v.name);
      const tip = addr ? `${v.name}\n${[v.type, addr].filter(Boolean).join(' · ')}` : v.name;
      return `<div class="vp-row${v.name === input.value.trim() ? ' cur' : ''}" data-i="${i}" title="${esc(tip)}">
        <span class="vp-name">${esc(v.name)}</span>
        ${n ? `<span class="vp-note">${esc(n)}</span>` : ''}
        ${meta ? `<span class="vp-meta">${esc(meta)}</span>` : ''}
      </div>`;
    }).join('') + (rows.length > MAX_ROWS
      ? `<div class="vp-more">还有 ${rows.length - MAX_ROWS} 个，接着打字缩小范围</div>` : '')
    : `<div class="vp-empty">没有匹配的变量（${esc(input.value.trim() || '变量表是空的')}）</div>`;

  // 先显示再定位：placeList 要量高度才知道下面放不放得下（隐藏时量出来是 0）
  el.hidden = false;
  placeList(input);
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

/** 选中第 i 行：写进输入框，并按「手输」的路径发 input/change（面板那边照常保存）。
 *  ⚠ 值跟框里已经写的一模一样时**也要**发 change：用户常常是先打几个字（框里有名字了），
 *    再从候选里点一下确认 —— 那一瞬间工程数据还没落，少发这个 change 就等于点了没反应。 */
function pick(i) {
  const c = ctx;
  if (!c) return;
  const v = c.rows[i];
  if (!v) return;
  const inp = c.input;
  closeVarPick();
  inp.value = v.name;
  picking = true;
  try {
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  } finally {
    picking = false;
  }
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
    pick(ctx.idx >= 0 ? ctx.idx : 0);                      // 没上下选过就取第一个匹配（老习惯）
  }
}
