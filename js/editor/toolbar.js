/**
 * toolbar.js — 顶部工具栏 + 通用对话框
 */
import { addressHelpFor } from '../core/addrInput.js';
import { bus } from '../core/eventBus.js';
import { project, PAD_EDIT, PAD_REPLACE, PAD_LABELS, PAD_LABEL_VAR, PAD_LABEL_WIDGET, PAD_LABEL_NONE } from '../core/project.js';
import { history } from '../core/history.js';
import { storage } from '../core/storage.js';
import { alignWidgets, makeSameSize, toggleGrid, setGrid, getGrid, toggleLock, getSelection, setZoom, getZoom, zoomFit, groupSelection, ungroupSelection } from './canvas.js';
import { backend } from '../api/backend.js';
import { varStore } from '../runtime/varstore.js';
import { escapeHtml, statusNote, PROTOCOLS, getProfile, setProfile, profileCn, normAddr,
  protocolId, protocolCn, protocolOfConfig, protocolForProfile, profileForProtocol } from '../core/utils.js';
import { protocols as catalogProtocols, defaultAddress, probeAddress,
  loadCatalog } from '../core/addrCatalog.js';
import { obfuscate, deobfuscate } from '../core/sha256.js';
import { openAt } from '../core/contextMenu.js';

const esc = escapeHtml;  // 对话框里拼 HTML 一律转义（工程名/页名都是用户随手输入的）

/** 换工程后把运行态变量值重置成新工程的初值（否则画布上预览的还是上一个工程的值） */
function resetVarStore() {
  try { varStore.resetFrom(project.variables()); } catch (e) { console.warn('[project] 重置变量值失败', e); }
}

/**
 * 保存工程为文件（工具栏「保存」和 Ctrl+S 共用）。
 * 有当前文件就**写回同一个文件**，没有（新工程/浏览器不支持）就先问存哪。
 * 弹窗只在「第一次保存 / 另存为 / 不支持覆盖只能下载」时出现 —— 之后直接写文件，
 * 只在状态栏给一行「已保存：xxx.LE（时间）」，不再每次都弹（用户要求）。
 */
let downloadTold = false;      // 「这台浏览器只能下载」这件事只说一次
export async function saveToFile(asNew = false) {
  let res;
  try {
    res = asNew ? await storage.saveAs() : await storage.save();
  } catch (e) {
    if (e && e.name === 'AbortError') return null;      // 用户在系统「另存为」里点了取消
    showDialog({ title: '保存失败', okText: '好', body: `<div class="dlg-hint">${esc(e?.message || String(e))}</div>` });
    return null;
  }
  // 桌面窗口（exe）走的是 Python 那个原生保存框：用户点取消时回的是 cancelled，不是异常
  if (res?.cancelled) return null;
  const st = document.getElementById('stSave');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  if (st) st.textContent = `已保存：${res.name}（${time}）`;

  // 写回原文件 → 静默（状态栏已经给了反馈）；「另存为」和第一次保存/退回下载才弹窗说清楚
  const quiet = res.inPlace || (res.download && downloadTold && !asNew);
  if (res.download) downloadTold = true;
  if (quiet) return res;

  const meta = project.data.meta || {};
  const widgets = project.pages().reduce((n, p) => n + (p.widgets?.length || 0), 0);
  const kb = Math.max(1, Math.round(JSON.stringify(project.data).length / 1024));
  const where = res.path
    ? `<b style="font-family:var(--mono)">${esc(res.path)}</b>`       // 桌面窗口：Python 保存框给了完整路径
    : res.download
      ? '浏览器不支持直接覆盖原文件，这次是<b>下载</b>了一份（在下载目录里；想做到「保存=覆盖同一个文件」，请用 Chrome/Edge 访问 http://127.0.0.1:8866 或 https）'
      : '你刚选的文件';
  const plc = projectPlc();
  showDialog({
    title: asNew ? '已另存为' : '已保存工程',
    okText: '好',
    body: `
      <div class="f-row"><span class="f-label">文件名</span><b style="font-family:var(--mono)">${esc(res.name)}</b></div>
      <div class="f-row"><span class="f-label">位置</span><span style="font-size:12px">${where}</span></div>
      <div class="f-row"><span class="f-label">内容</span><span style="font-size:12px">「${esc(meta.name || '未命名工程')}」 · ${project.pages().length} 个页面 · ${project.variables().length} 个变量 · ${widgets} 个控件 · 约 ${kb} KB</span></div>
      <div class="f-row"><span class="f-label">PLC</span><span style="font-size:12px">${plc ? `已带上：${esc(plcText(plc))}` : '这份工程里没记 PLC 配置（在工具栏 🔌 PLC 里连一次就会记进来）'}</span></div>
      <div class="f-row"><span class="f-label">时间</span><span style="font-size:12px">${time}</span></div>`,
  });
  return res;
}

/**
 * 「自动保存存在哪」——状态栏那句「已自动保存 12:00:00（0.3MB）」点开就是这个。
 * 用户最常问的一句，所以直接把 origin、键名、体积、上限、以及"换浏览器/换 IP 就是另一份"
 * 讲清楚，并告诉他真要留档该点哪个按钮。
 */
export function showSaveInfo() {
  const i = storage.saveInfo();
  const at = i.lastAt ? new Date(i.lastAt).toLocaleTimeString('zh-CN', { hour12: false }) : '（本次还没写过）';
  showDialog({
    title: '自动保存存在哪？',
    okText: '知道了',
    body: `
      <div class="dlg-hint">自动保存是<b>存在你这台设备的浏览器里</b>（网页的「站点数据」localStorage），
      不是磁盘上的一个文件，也不在服务器上。</div>
      <div class="f-row"><span class="f-label">站点</span><span style="font-size:12px;font-family:var(--mono)">${esc(i.origin)}</span></div>
      <div class="f-row"><span class="f-label">存储键</span><span style="font-size:12px;font-family:var(--mono)">${esc(i.key)}</span></div>
      <div class="f-row"><span class="f-label">当前体积</span><span style="font-size:12px">${i.mb} MB（浏览器上限约 ${i.limitMb} MB，图片多的工程要留意）</span></div>
      <div class="f-row"><span class="f-label">上次写入</span><span style="font-size:12px">${at}</span></div>
      <div class="f-row"><span class="f-label">上一份备份</span><span style="font-size:12px">${i.backup ? `「${esc(i.backup.name)}」（${i.backup.pages} 页 · ${i.backup.vars} 个变量），键 ${esc(i.backupKey)}` : '暂时没有'}</span></div>
      <div class="dlg-hint" style="margin-top:8px;line-height:1.8">
        ⚠ 它只属于<b>这台设备的这个浏览器</b>：换浏览器（Chrome↔Edge）、换端口、
        用 <code>127.0.0.1</code> 和用局域网 IP 打开，都是各自一份；
        清浏览数据 / 无痕窗口打开就没有了。<br>
        要真正留档、发给别人、或者换台机器接着编：用「工程 ▾ → 保存」（写 .LE 文件；老工程 .json 也照样打得开）
        或「工程 ▾ → 存到服务器」（写到 server/data/hmi_project.LE）。<br>
        ✅ 另外两样<b>不看浏览器</b>：<b>面板布局</b>存在<b>工程里</b>（跟「保存 / 存到服务器」一起走）；
        <b>报警记录</b>存在<b>服务器</b>上（<code>server/data/alarm_history.json</code>，环形上限 5MB）——
        换个地址、换个浏览器（客户机每次都是新 profile）打开都还是同一份。
      </div>`,
  });
}

/**
 * 权限管理对话框（「工程 ▾ → 权限管理…」或属性面板里的「权限管理…」按钮）：
 *   · 开关：启用后运行态才会按控件上配的「权限等级」拦人；
 *   · 自动上锁：解锁后**没操作** N 分钟自动退出权限（0 = 解锁后一直有效）；
 *   · 等级表：名字 + 密码，可增删、可上下调高低（越靠下等级越高，解锁高的 = 低的也能操作）。
 * 密码只存「盐 + 迭代哈希」（core/sha256.js），工程里不留明文；等级表跟着工程走。
 */
export function openPermDialog() {
  const pwdEsc = (s) => esc(s || '');
  const paint = () => {
    const pm = project.permissions();
    const levels = project.permLevels();
    document.getElementById('dlgBody').innerHTML = `
      <div class="f-row"><span class="f-label">权限管理</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="pmEnabled" ${pm.enabled ? 'checked' : ''}>
          <span style="font-size:12px">启用（运行态开始拦人）</span></label></div>
      <div class="f-row"><span class="f-label">自动上锁</span>
        <input class="f-input" id="pmLockAfter" type="number" min="0" max="600" step="1"
          value="${Math.max(0, Math.round(+pm.lockAfterMin || 0))}" style="width:70px;flex:none"
          title="解锁后**多久没操作**就自动退出权限（分钟）。0 = 不自动锁：解锁后一直有效，只有刷新 / 关窗口 / 退出运行态，或手动「退出权限」才回到未解锁。">
        <span style="font-size:12px;color:var(--text-2)">分钟没操作自动退出权限（<b>0 = 不自动锁</b>）</span></div>
      <div class="prop-group-title" style="margin-top:12px">等级表（越靠下等级越高，解锁高的 = 低的也都能操作）</div>
      <div id="pmRows">${levels.length ? '' : '<div class="dlg-hint">还没有等级 —— 点下面的「＋ 添加等级」。</div>'}</div>
      <div class="f-row" style="margin-top:8px"><span class="f-label"></span>
        <button type="button" class="tb-btn sm" id="pmAdd">＋ 添加等级</button></div>`;
    // 等级表就在上面：说明文字不再往对话框里堆（现场嫌长；要看口径去 README）
    // 等级行：改名 / 改密码（**密码直接显示出来**，进来看得见上次设的是什么）/ 上下移 / 删除
    levels.forEach(l => {
      const row = document.createElement('div');
      row.className = 'f-row pm-row';
      row.dataset.pmid = l.id;
      const curPw = l.pw ? deobfuscate(l.pw, l.id) : '';
      row.innerHTML = `
        <input class="f-input" data-pmname style="flex:1" value="${pwdEsc(l.name)}" placeholder="等级名（如 操作员 / 工程师）">
        <input class="f-input" data-pmpw style="flex:1" autocomplete="off"
          value="${pwdEsc(curPw)}"
          placeholder="${l.hash && !l.pw ? '旧密码看不出来，重填一次就能显示' : '密码（清空 = 不设密码）'}"
          title="运行态解锁这一级要输的密码。工程里存的是混淆串（不是明文，但能还原出来）；清空这一格 = 这一级不设密码（那就谁都解不开）。">
        <button type="button" class="tb-btn sm" data-pmup title="往上（降一级）">▲</button>
        <button type="button" class="tb-btn sm" data-pmdn title="往下（升一级）">▼</button>
        <button type="button" class="tb-btn sm danger" data-pmdel title="删除这一级（引用它的控件会自动改回「不限」）">✕</button>
        ${(curPw || l.hash) ? '' : '<span style="color:var(--danger);font-size:11px">未设密码（这一级谁都解不开）</span>'}`;
      document.getElementById('pmRows').appendChild(row);
    });
    const rows = () => [...document.querySelectorAll('#pmRows .pm-row')];
    document.getElementById('pmAdd').addEventListener('click', () => {
      // 先把当前输入落到工程里再重画（不然刚打的字会被刷掉）
      applyRows();
      project.addPermLevel({ name: `等级${project.permLevels().length + 1}` });
      paint();
    });
    rows().forEach(row => {
      const id = row.dataset.pmid;
      row.querySelector('[data-pmup]').addEventListener('click', () => { applyRows(); project.movePermLevel(id, -1); paint(); });
      row.querySelector('[data-pmdn]').addEventListener('click', () => { applyRows(); project.movePermLevel(id, 1); paint(); });
      row.querySelector('[data-pmdel]').addEventListener('click', () => {
        const name = project.permLevelName(id);
        const used = usedBy(project.permLevels(), id);
        if (!confirm(`删除权限等级「${name}」？${used ? `\n\n有 ${used} 个控件配了这一级，它们会改回「不限」（谁都能操作）。` : ''}`)) return;
        applyRows();
        project.deletePermLevel(id);
        paint();
      });
    });
  };

  /** 有几个控件配了这一级（删除前提醒 —— 改回"不限"= 变成谁都能动，这件事要说清楚） */
  function usedBy(_levels, id) {
    let n = 0;
    project.pages().forEach(p => p.widgets.forEach(w => { if (w.props?.permLevel === id) n++; }));
    return n;
  }

  /** 把对话框里当前输入（等级名 / 新密码）落进工程 */
  function applyRows() {
    const en = document.getElementById('pmEnabled');
    const la = document.getElementById('pmLockAfter');
    const pm = project.permissions();
    pm.enabled = !!en?.checked;
    pm.lockAfterMin = Math.max(0, Math.min(600, Math.round(Number(la?.value) || 0)));
    document.querySelectorAll('#pmRows .pm-row').forEach(row => {
      const l = project.permLevel(row.dataset.pmid);
      if (!l) return;
      const name = row.querySelector('[data-pmname]').value.trim();
      if (name) l.name = name;
      // 密码框里是**看得见的当前密码**：原样留着 = 不改；改了 = 存新的；清空 = 这一级不设密码
      const pw = row.querySelector('[data-pmpw]').value;
      const old = l.pw ? deobfuscate(l.pw, l.id) : '';
      if (pw !== old) {
        l.pw = pw ? obfuscate(pw, l.id) : '';
        l.salt = ''; l.hash = ''; l.iter = 0;        // 老的哈希写法一并清掉（同一个密码只留一份）
      }
    });
    project.commit('权限设置');
  }

  showDialog({
    title: '权限管理',
    okText: '保存',
    body: '',
    onOk: () => {
      // 没设密码的等级**保存时不再拦一下**（现场嫌烦）：那种等级运行态谁都解不开，
      // 真要提醒也放在运行态密码框上 —— 用到哪一级、那一级没密码，那时说才有用。
      applyRows();
      return true;
    },
  });
  paint();
}

/**
 * 软键盘设置对话框（「工程 ▾ → 软键盘设置…」）：**一处设置，所有输入控件都按它走**
 *   · 起手方式 —— 按键清空重输（replace，**默认**）：打开时照样显示现在是多少，但按下的
 *     **第一个「字符键」**会先把原值让掉，直接开始输新值 —— 点开就能直接输新的。
 *     接着原值改（edit，老行为）：打开键盘显示当前值，按的键接在原值后面，想重输先按 C。
 *     ⌫ / C 算「我要改原值」（按了就取消这次起手，不会把原值吞掉）；⇧ / 中英 / 符号页
 *     这些**不出字符**的键也不清。
 *   · 标题显示 —— 键盘顶上那一行写**变量名**（var，默认）还是**控件名**（widget）：
 *     现场认"线速度设定"比认 Hr_LineSpd 快，就切成控件名。
 * 两样都跟着工程走（存文件 / 存到服务器都带走）。
 */
export function openKeypadDialog() {
  const kp = project.keypad();
  const mode = kp.mode === PAD_EDIT ? PAD_EDIT : PAD_REPLACE;
  const label = PAD_LABELS.includes(kp.label) ? kp.label : PAD_LABEL_VAR;
  showDialog({
    title: '软键盘设置',
    okText: '保存',
    body: `
      <div class="f-row"><span class="f-label">起手方式</span>
        <select class="f-input" id="kpMode" style="flex:1" title="按键清空重输：第一个字符键替换原值。接着原值改：按键追加，退格可修改。两种模式均可直接用退格或清除键。">
          <option value="${PAD_REPLACE}" ${mode === PAD_REPLACE ? 'selected' : ''}>按键清空重输（默认）</option>
          <option value="${PAD_EDIT}" ${mode === PAD_EDIT ? 'selected' : ''}>接着原值改（老行为）</option>
        </select></div>
      <div class="f-row"><span class="f-label">标题显示</span>
        <select class="f-input" id="kpLabel" style="flex:1" title="都不显示：隐藏标题，保留关闭按钮（✕）。">
          <option value="${PAD_LABEL_VAR}" ${label === PAD_LABEL_VAR ? 'selected' : ''}>变量名</option>
          <option value="${PAD_LABEL_WIDGET}" ${label === PAD_LABEL_WIDGET ? 'selected' : ''}>控件名</option>
          <option value="${PAD_LABEL_NONE}" ${label === PAD_LABEL_NONE ? 'selected' : ''}>都不显示</option>
        </select></div>`,
    onOk: () => {
      const v = document.getElementById('kpMode')?.value === PAD_EDIT ? PAD_EDIT : PAD_REPLACE;
      const picked = document.getElementById('kpLabel')?.value;
      const l = PAD_LABELS.includes(picked) ? picked : PAD_LABEL_VAR;
      const cur = project.keypad();
      if (v === cur.mode && l === cur.label) return true;    // 没改就别往撤销栈里塞一步
      project.setKeypad({ mode: v, label: l });
      return true;
    },
  });
}

/** 工程里带的 PLC 配置（保存时一起存；打开时问要不要按它连）
 *  三项协议：opcua 认端点；modbus / ts600 认 IP（ts600 落盘是 protocol:"modbus" + addr_profile） */
function projectPlc() {
  const p = project.data?.meta?.plc;
  if (!p) return null;
  if (protocolId(p.protocol) === 'opcua') return p.endpoint ? p : null;
  return p.ip ? p : null;
}
/** 「192.168.1.10:502 · 站号1 · 20ms · CDAB」/「OPC UA opc.tcp://…:4840 · 匿名 · 200ms」这种一行摘要 */
function plcText(p) {
  if (!p) return '';
  if (protocolId(p.protocol) === 'opcua') {
    return `OPC UA ${p.endpoint}（${p.username ? '用户 ' + p.username : '匿名'} · ${p.poll_ms}ms）`;
  }
  const tag = protocolOfConfig(p) === 'ts600' ? 'TS600 TCP ' : '';
  return `${tag}${p.ip}:${p.port}（站号 ${p.unit} · ${p.poll_ms}ms · 字序 ${String(p.word_order || '').toUpperCase()}）`;
}
/** 两份配置算不算「同一台」（协议 + 地址 + 站号 + 字序） */
function samePlc(a, b) {
  if (!a || !b) return false;
  const pa = protocolOfConfig(a) || protocolId(a.protocol);
  const pb = protocolOfConfig(b) || protocolId(b.protocol);
  if (pa !== pb) return false;
  if (pa === 'opcua') return String(a.endpoint || '').toLowerCase() === String(b.endpoint || '').toLowerCase();
  return a.ip === b.ip && +a.port === +b.port && +a.unit === +b.unit
    && String(a.word_order || '').toLowerCase() === String(b.word_order || '').toLowerCase();
}

/**
 * 打开/新建/恢复工程后：如果这份工程自带 PLC 配置、又和这台机器现在连的不一样，
 * 就问一句要不要照它的连 —— 不然「把工程拷到另一台机器」最容易踩的坑就是
 * 界面看着一样、数据却连到别的 PLC（配置存在服务器那台机器的 plc.json 里）。
 */
async function offerProjectPlc(data) {
  const p = data?.meta?.plc;
  if (!p || (!p.ip && !p.endpoint)) return;
  let now = null;
  try { now = (await backend.getPlc())?.config || null; } catch { return; }   // 后端没开就算了
  if (samePlc(now, p)) return;
  if (!confirm(`这份工程里带着 PLC 配置：\n  ${plcText(p)}\n\n`
    + `这台机器（后端）现在连的是：\n  ${(now && (now.endpoint || now.ip)) ? plcText(now) : '内存模拟（没连 PLC）'}\n\n`
    + `要按工程里的配置去连吗？（点「取消」就保持现在的）`)) return;
  try {
    // 工程里不存密码（见保存那处的说明）：用本机上次填过的密码接着用
    let pwd = '';
    try { pwd = (JSON.parse(localStorage.getItem(PLC_KEY)) || {}).password || ''; } catch { /* 忽略 */ }
    await backend.connectPlc({ ...p, password: p.password || pwd, variables: currentVarTable() });
    await refreshPlcStatus();
    try { localStorage.setItem(PLC_KEY, JSON.stringify(p)); } catch { /* 忽略 */ }
    alert(`已按工程里的配置连接：${plcText(p)}`);
  } catch (e) { alert('按工程里的配置连接失败：' + (e?.message || e) + '\n（可在工具栏 🔌 PLC 里手动改）'); }
}

/**
 * 工程菜单（工具栏 ▾）：新建 / 打开 / 保存 / 另存为 / 存到服务器 / 从服务器读。
 * 用右键菜单那套（样式、键盘、点别处关闭都现成的）。
 */
export function openProjectMenu() {
  const btn = document.getElementById('btnProjMenu');
  const r = btn.getBoundingClientRect();
  const info = storage.backupInfo();
  openAt(r.left, r.bottom + 4, [
    { header: '工程文件' },
    { label: '新建工程…', icon: 'add', onClick: openNewProjectDialog },
    { label: '打开本地工程…', icon: 'folder', onClick: openProjectFile },
    { label: '保存到本地', icon: 'save', key: 'Ctrl+S', description: '写入当前工程文件，首次保存时选择位置。', onClick: () => saveToFile() },
    { label: '另存为…', icon: 'save', description: '将当前工程保存为新的文件。', onClick: () => saveToFile(true) },
    { label: '保存到服务器', icon: 'server', description: '更新服务器上的工程，供运行画面读取。', onClick: serverSave },
    { label: '读取服务器工程…', icon: 'server', description: '将服务器保存的工程载入编辑器。', onClick: serverLoad },
    ...(info ? [{ label: '恢复上一个工程', icon: 'history', description: '恢复本机保留的上一份工程。', onClick: restorePrevProject }] : []),
    { sep: true },
    { header: '设置' },
    { label: '配方地址配置…', icon: 'settings', description: '设置配方字段与 PLC 地址的对应关系。',
      onClick: () => import('./recipeConfig.js').then(m => m.openRecipeConfig())
        .catch(e => alert('打不开配方地址配置：' + (e?.message || e))) },
    { label: '操作权限…', icon: 'lock', description: '配置运行画面的权限等级与自动锁定。', onClick: openPermDialog },
    { label: '用户与角色…', icon: 'group', description: '管理登录账号及其角色。',
      onClick: () => import('./usersPanel.js').then(m => m.openUsersPanel()).catch(e => alert('打不开用户与角色：' + (e?.message || e))) },
    { label: '软键盘设置…', icon: 'settings', description: '设置数值输入时软键盘如何处理原值。', onClick: openKeypadDialog },
    { label: '多语言与翻译…', icon: 'page', description: '管理工程语言、翻译表和预览语言。',
      onClick: () => import('./i18nPanel.js').then(m => m.openI18nPanel()).catch(e => alert('打不开多语言设置：' + (e?.message || e))) },
    { label: '日志设置…', icon: 'settings', description: '调整本机日志的保留时间与大小上限。',
      onClick: () => import('./logSettings.js').then(m => m.openLogSettings()) },
    { sep: true },
    { header: '工具' },
    { label: 'AI 助手…', icon: 'ai', description: '显示或收起通过对话编辑工程的侧栏。',
      check: document.getElementById('aiSide')?.classList.contains('hidden') === false,
      onClick: () => import('./aiPanel.js').then(m => m.toggleAiSide()).catch(e => alert('打不开 AI 助手：' + (e?.message || e))) },
    { label: '历史数据…', icon: 'history', description: '设置变量采样并导出历史数据。',
      onClick: () => import('./historyPanel.js').then(m => m.openHistoryPanel()).catch(e => alert('打不开历史数据：' + (e?.message || e))) },
    { label: 'FRP 内网穿透…', icon: 'network', description: '管理用于远程访问运行画面的端口映射。',
      onClick: () => import('./frpSettings.js').then(m => m.openFrpSettings()) },
    { label: '检查更新…', icon: 'refresh', onClick: () => import('./updateCheck.js').then(m => m.checkUpdateNow()) },
    ...(backend.auth?.enabled ? [
      { sep: true },
      { header: '运行与登录' },
      { label: '打开运行画面', icon: 'play', onClick: gotoRuntimePage },
      { label: '退出登录', icon: 'logout', onClick: logout },
    ] : []),
  ], { anchor: btn, align: 'end' });
}

/** 打开工程：能用系统文件选择器就用（这样「保存」才知道往哪个文件写回） */
export async function openProjectFile() {
  const cur = project.data?.meta?.name || '当前工程';
  if (!confirm(`打开工程会替换现在的「${cur}」。\n（当前这份会自动留一份备份，可以随时用「恢复上一个工程」找回来）\n\n继续？`)) return;
  if (storage.canSaveInPlace()) {
    try {
      const { data, name } = await storage.pickAndOpen();
      resetVarStore();
      alert(`已打开「${data.meta?.name || name}」（文件：${name}）\n${(data.pages || []).length} 个页面 · ${(data.variables || []).length} 个变量 · ${(data.alarms || []).length} 条报警\n\n之后点「保存」就写回这个文件。`);
    } catch (e) {
      if (e && e.name === 'AbortError') return;            // 取消选择
      alert('打开失败：' + (e?.message || e));
    }
    return;
  }
  document.getElementById('fileImport').click();           // 老浏览器：退回 <input type=file>
}

/** 从本机文件读入（没有文件选择器的浏览器走这条；读进来后「保存」会问另存为） */
async function importViaInput(file) {
  try {
    const data = await storage.importFile(file);
    resetVarStore();
    alert(`已打开「${data.meta?.name || file.name}」\n${(data.pages || []).length} 个页面 · ${(data.variables || []).length} 个变量 · ${(data.alarms || []).length} 条报警`);
  } catch (e) { alert('打开失败：' + (e?.message || e)); }
}

/** 运行页地址：`/run` 永远是运行页（登录了也能看运行画面）。后端会注入，缺省也用 /run */
function runPath() { return globalThis.__HMI_RUN_PATH__ || '/run'; }

/** 去现场运行页：**PyWebView 窗口客户端里同一个窗口换页**（它没有标签页，window.open 是白开）；
 *  普通浏览器里另开一个标签，编辑器不丢 */
function gotoRuntimePage() {
  if (globalThis.pywebview) { location.href = runPath(); return; }
  window.open(runPath(), '_blank');
}

/** 退出登录：清掉会话 cookie → **回到现场运行页**（这个窗口就只剩 run 了，跟客户看到的一样；
 *  要再进编辑器按 Ctrl+Shift+E 输密码）。同一个窗口换页，不开新窗口 */
async function logout() {
  if (!confirm('退出登录？\n（退出后这个页面回到现场运行页，要改东西得重新输管理员密码）')) return;
  try { await backend.logout(); } catch { /* 后端没了也照样把界面切回去 */ }
  location.href = runPath();
}

/** 存到服务器：写到跑 server.py 那台机器的 server/data/hmi_project.LE */
async function serverSave() {
  try {
    await backend.saveProject(project.data);
    alert('已存到服务器：server/data/hmi_project.LE\n（在跑 server.py 的那台机器上，就这一个槽位、下次覆盖）\n\n'
      + '想留版本 / 发给别人 / 换机器用，请用「保存 / 另存为」存成 .LE 文件。');
  } catch (e) { alert('存服务器失败：' + (e?.message || e) + '\n（需先启动 server/server.py；只想留文件请用「保存」）'); }
}

/** 从服务器读：把那个槽位里的工程读回来替换当前工程 */
async function serverLoad() {
  try {
    const data = await backend.loadProject();
    if (!data || !data.pages) return alert('服务器上还没有存过工程：先在另一台/另一个浏览器点「存到服务器」，或直接用「打开工程」选本机的 .LE / .json 文件。');
    const cur = project.data?.meta?.name || '当前工程';
    if (!confirm(`用服务器上那份「${data.meta?.name || '未命名工程'}」替换当前的「${cur}」？\n`
      + '（在跑 server.py 那台机器上的 server/data/hmi_project.LE；当前这份会自动留备份，可用「恢复上一个工程」找回）')) return;
    storage.replaceProject(data, '读取服务器工程');
    resetVarStore();
    alert(`已读入服务器的工程「${data.meta?.name || '未命名工程'}」\n${(data.pages || []).length} 个页面 · ${(data.variables || []).length} 个变量`);
  } catch (e) { alert('读服务器失败：' + (e?.message || e) + '\n（需先启动 server/server.py）'); }
}

/** 恢复上一个被替换掉的工程 */
function restorePrevProject() {
  if (!confirm('用备份把当前工程换掉？（当前这份也会留一份备份）')) return;
  const data = storage.restoreBackup();
  if (!data) return alert('没有可恢复的备份');
  resetVarStore();
  alert(`已恢复「${data.meta?.name || '未命名工程'}」`);
}

/**
 * 新建工程：空白 / 带示例。
 * 关键：换之前先把当前工程备份一份（storage.replaceProject），
 * 并在窗口里给「恢复上一个工程」，避免「点错新建 → 原来的工程没了」。
 */
export function openNewProjectDialog() {
  const info = storage.backupInfo();
  showDialog({
    title: '新建工程',
    okText: '新建',
    body: `
      <div class="dlg-hint">当前工程「${esc(project.data?.meta?.name || '未命名工程')}」会被替换（换之前自动留一份备份）。</div>
      <label class="dlg-radio"><input type="radio" name="newKind" value="blank" checked> 空白工程（1 个空白页，变量表是空的）</label>
      <label class="dlg-radio"><input type="radio" name="newKind" value="demo"> 带示例的演示工程（单线切割机：7 个页面 / 46 个变量 / 报警 + 仿真脚本，照着改就行）</label>
      ${info ? `<div class="dlg-hint" style="margin-top:10px">上一个被替换的工程：「${esc(info.name)}」（${info.pages} 页 · ${info.vars} 个变量）
        <button type="button" class="tb-btn sm" id="btnRestorePrev" style="margin-left:6px">恢复上一个工程</button></div>` : ''}`,
    onOk: () => {
      const kind = document.querySelector('input[name="newKind"]:checked')?.value || 'blank';
      storage.backupCurrent();
      project.newProject(kind);
      project.commit('新建工程');
      storage.forgetFile();          // 新工程还没落过文件：下次「保存」问存哪
      resetVarStore();
      return true;
    },
  });
  const restore = document.getElementById('btnRestorePrev');
  if (restore) restore.addEventListener('click', () => {
    document.getElementById('dlgCancel')?.click();
    restorePrevProject();
  });
}

/** 画布设置对话框（工具栏按钮与画布右键菜单共用）*/
export function openCanvasSetting() {
  const c = project.data.meta.canvas;
  showDialog({
    title: '画布设置',
    body: `
      <div class="f-row"><span class="f-label">画布宽</span>
        <input class="f-input" id="csW" type="number" min="200" max="4000" value="${c.w}"> px</div>
      <div class="f-row"><span class="f-label">画布高</span>
        <input class="f-input" id="csH" type="number" min="200" max="3000" value="${c.h}"> px</div>
      <div class="f-row"><span class="f-label">背景色</span>
        <input class="f-color" id="csBg" type="color" value="${c.bg || '#f4f5f7'}"></div>
      <div class="f-row"><span class="f-label">显示网格</span>
        <input class="f-check" id="csGrid" type="checkbox" ${getGrid() ? 'checked' : ''}>
        <span style="color:var(--text-2);font-size:12px">（勾选同时开启 5px 吸附）</span></div>`,
    onOk: () => {
      const w = +document.getElementById('csW').value || 1024;
      const h = +document.getElementById('csH').value || 600;
      const bg = document.getElementById('csBg').value;
      const grid = document.getElementById('csGrid').checked;
      project.updateCanvas({ w, h, bg });
      setGrid(grid);
      return true;
    },
  });
}

/* ── PLC 连接对话框：三项协议（Modbus TCP / TS600 TCP / OPC UA）── */
const PLC_KEY = 'hmi-plc-cfg';
/** 协议目录（后端 GET /api/comm/protocols 优先；老后端没有 comm_api → 本地 FALLBACK 兜底，
 *  内容就是这三项协议）。⚠ 顺序必须是 modbus / ts600 / opcua —— verify-opcua.mjs:343 断言
 *  下拉的 option 值顺序；catalog 里只补不删，也不改顺序。 */
function protoList() {
  const list = catalogProtocols();
  if (!list || !list.length) return PROTOCOLS;
  // 下拉里只放短名（Modbus TCP / TS600 TCP / OPC UA）：带地址写法说明的长名会把下拉挤成「M」，
  // 地址写法改在紧挨着的那行小字里说（见 PROTO_ADDR_HINT）。
  return list.map(p => ({ id: p.id, cn: protocolCn(p.id) || p.name || p.id }));
}
/** 「测试连接 / 字序体检」的默认地址：按目录的探测地址（modbus %MW0 / ts600 D0 / opcua 无） */
const probeAddrFor = (proto) => {
  const id = protocolId(proto) || 'modbus';
  if (id === 'opcua') return '';
  return probeAddress(id) || defaultAddress(id) || (id === 'ts600' ? 'D0' : '%MW0');
};
/** 下拉的值 → 三项协议 id（认不出按 modbus） */
const protoOf = (v) => protocolId(v) || 'modbus';
/** 配置里的协议：兼容落盘口径 protocol:"modbus" + addr_profile:"ts600-modbus-tcp" → 'ts600' */
const cfgProto = (cfg) => protocolOfConfig(cfg) || 'modbus';

function loadPlcCfg() {
  const def = { protocol: protocolForProfile(getProfile()), ip: '127.0.0.1', port: 502, unit: 1,
    poll_ms: 200, word_order: 'low',
    endpoint: 'opc.tcp://127.0.0.1:4840', security: 'none', username: '', password: '', default_ns: 4 };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PLC_KEY)) || {}; } catch { saved = {}; }
  const merged = { ...def, ...saved };
  const proto = cfgProto(merged);
  // 三项协议是唯一入口：addr_profile 由协议推导（ts600 → ts600-modbus-tcp；opcua 不用）
  return { ...merged, protocol: proto, addr_profile: profileForProtocol(proto) };
}

/** 变量表里所有 OPC UA 地址（NodeId），以及它的「符号尾巴」
 *  ns=4;s=|var|CODESYS Control Win V3 x64.Application.GVL.a → GVL.a
 *  尾巴就是真正能对上号的东西：设备名/命名空间写错了，尾巴还是对的 */
function opcSymbolTail(addr) {
  const s = String(addr || '');
  const i = s.indexOf('|var|');
  if (i < 0) return '';
  const parts = s.slice(i + 5).split('.');
  return parts.length > 2 ? parts.slice(2).join('.') : parts.join('.');
}

/**
 * 按服务器**实际发布**的符号纠正变量表地址。
 *
 * 为什么需要它：CODESYS 的符号 NodeId 里带着**设备名**（`|var|<设备名>.Application.POU.符号`），
 * 而导出的符号配置 XML 里那个设备名是「导出那份工程」的设备名 —— 运行时上跑的应用
 * 可能来自另一个工程（设备名不同），于是整张变量表全部 BadNodeIdUnknown，
 * 界面上表现为「连是连上了，变量就是不动」，而报错只有一个协议级的节点不存在。
 * 这里直接从服务器把真实 `|var|` 节点全捞回来，按符号尾巴对号入座，一键改地址。
 */
export async function fixOpcAddresses(opt) {
  const r = await backend.opcuaBrowse({
    endpoint: opt.endpoint, security: opt.security, username: opt.username,
    password: opt.password, default_ns: opt.defaultNs,
    depth: 8, max_nodes: 5000, only_app_symbols: true,
  });
  if (r.ok === false) return { ok: false, message: r.message || r.error || '浏览失败' };
  const real = (r.nodes || []).filter(n => n.nodeid.includes('|var|'));
  if (!real.length) {
    return { ok: false, message: '服务器上一个 |var| 应用符号都没看到 —— 确认 CODESYS 里符号配置勾了「支持 OPC UA」并已下载。' };
  }
  const byTail = new Map();
  real.forEach(n => {
    const t = opcSymbolTail(n.nodeid);
    if (t && !byTail.has(t)) byTail.set(t, n);
    if (!byTail.has('@name:' + n.name)) byTail.set('@name:' + n.name, n);   // 尾巴对不上时按符号名兜底
  });
  const vars = project.variables();
  const changed = [], unmatched = [];
  vars.forEach(v => {
    const a = String(v.address || '');
    if (!a || !a.includes('|var|')) return;                  // 不是 OPC UA 应用符号，不动
    const tail = opcSymbolTail(a);
    const hit = byTail.get(tail) || byTail.get('@name:' + v.name);
    if (!hit) { unmatched.push(`${v.name}（${a}）`); return; }
    if (hit.nodeid !== a) { changed.push({ name: v.name, from: a, to: hit.nodeid }); v.address = hit.nodeid; }
  });
  if (changed.length) project.commit(`按服务器实际符号纠正地址（${changed.length} 个）`);
  return { ok: true, total: real.length, changed, unmatched, sample: real[0].nodeid };
}

/** 状态栏上的 PLC 指示（三项协议：Modbus TCP / TS600 TCP / OPC UA，状态栏直接说协议名） */
export async function refreshPlcStatus() {
  const el = document.getElementById('stPlc');
  if (!el) return null;
  try {
    const j = await backend.getPlc();
    const st = j.status || {};
    // 链路状态喂给变量存储：「没连上不许传、连上了先读到数据才许操作」靠它判断
    // （编辑器这边也要喂：变量监控抽屉里改值同样要走这道门）
    varStore.noteLink(st.mode, !!st.online);
    // 设备在线、可这条链路上还没读到过数据 → 补读一遍（编辑器没有 SSE，"先读一遍"得自己来）
    if (varStore.needsFirstRead()) {
      backend.readVars().then(v => varStore.applyRemote(v, { full: true })).catch(() => { /* 读不到就等下次轮询 */ });
    }
    if (st.mode === 'plc' || st.mode === 'opcua') {
      const on = st.online;
      // 三项协议：TS600 落盘是 protocol:"modbus" + addr_profile:"ts600-modbus-tcp"，光看 protocol 分不出来
      const proto = protocolOfConfig({ ...(j.config || {}), ...st })
        || protocolId(st.protocol) || protocolForProfile(st.addr_profile || getProfile());
      const link = protocolCn(proto) || 'Modbus TCP';
      const isUa = proto === 'opcua';
      const isTs = proto === 'ts600';
      const where = isUa ? (st.endpoint || '') : `${st.host}:${st.port}`;
      const ord = isUa ? '' : String(st.word_order || '').toUpperCase();
      // 地址模型（INVT 的 %MW 写法 / TS600 的元件写法）—— 两套地址含义完全不同，title 里说清是哪套
      const pid = st.addr_profile || getProfile();
      const profTitle = isUa ? '' : `\n地址模型：${profileCn(pid)}`;
      // 「不在运行态就不通讯」：没人打开运行画面时后端压根不连设备 —— 这时说「离线」会误导，
      // 明明设备好好的、只是我们没在采（按 ▶ 运行 / 打开 /run 就开始采）。
      const idle = !!st.paused;
      el.textContent = idle
        ? `${link}：未运行 ${where}（${st.vars} 变量）`
        : `${link}：${on ? '在线' : '离线'} ${where}（${st.vars} 变量`
          + (st.cycle_ms ? `，实测 ${st.cycle_ms}ms/轮` : '')
          + (ord ? `，字序 ${ord}` : '') + (st.errors ? `，错 ${st.errors}` : '') + '）';
      el.className = 'st-dot ' + (idle ? 'idle' : (on ? 'online' : 'offline'));
      el.title = idle
        ? `编辑态不采设备（现场要求：改画面时别占用设备通讯口）。\n`
          + `按工具栏 ▶ 运行（或打开运行页 /run）就开始采；连接信息：${where}`
          + `${profTitle}（在 PLC 对话框里改）`
        : (on
          ? (isUa
            ? `OPC UA 已连接：读 ${st.reads} 次 / 写 ${st.writes} 次\n`
              + `身份：${st.username ? '用户名 ' + st.username : '匿名'}　安全策略：${st.security || 'none'}\n`
              + `命名空间：${(st.namespaces || []).map((u, i) => `ns${i}`).filter((_, i) => i > 0).join(' ')}`
            : `${link} 已连接：读 ${st.reads} 次 / 写 ${st.writes} 次\n`
              + `轮询：目标 ${st.poll_ms}ms，实测 ${st.cycle_ms || '—'}ms/轮（每轮 ${st.blocks} 块读）\n`
              + `双字/浮点字序：${st.word_order_cn || ord}（改字序：工具栏 🔌 PLC）`
              + `${profTitle}\n`
              + (isTs
                ? '地址按 TS600 元件写法解析：D100 数据寄存器、M10/S10/X17/Y10 位、T5/C200 定时器计数器'
                : '地址按 Invtmatic/INVT 写法解析：%MW 保持寄存器、%QX/%IX 位'))
          : `${link} 离线：${st.last_error || '未连接'}`);
    } else {
      const proto = protocolForProfile(getProfile());
      el.textContent = `PLC：未连接（内存模拟 · ${protocolCn(proto)}）`;
      el.className = 'st-dot offline';
      el.title = `当前用内存模拟数据源；点工具栏「🔌 PLC」连接真实 PLC / OPC UA 服务器 / 模拟器\n`
        + `地址模型：${profileCn(getProfile())}（在 PLC 对话框里改）`;
    }
    return st;
  } catch {
    el.textContent = 'PLC：后端离线';
    el.className = 'st-dot offline';
    return null;
  }
}

/** 读出当前变量表（带类型/地址/字符串长度/掉电保持）给后端，连上就能按地址轮询 */
function currentVarTable() {
  return project.variables().map(v => ({
    name: v.name, type: v.type, address: v.address || '',
    len: v.type === 'string' ? (v.len || 10) : 0,
    ...(v.retain ? { retain: true } : {}),      // 内部变量的掉电保持标记不能丢
  }));
}

export async function openPlcDialog() {
  // 本机 localStorage 那份 + **后端存的那份**（server/data/plc.json）。
  // 后端那份是「这台机器最近一次配好并连上的」，换浏览器、或换 pywebview 窗口（全新 profile）
  // 时 localStorage 是空的 —— 不合并的话每次都要重新敲一遍 OPC UA 的账号密码。
  // 规则：本机填过的优先；本机空着（或没有）的字段用后端那份补，口令登录后才拿得到。
  let s = loadPlcCfg();
  // 顺手把协议地址目录刷新一下（后端通了就换成后端那份；老后端 / 连不上保持本地 FALLBACK，不报错）。
  // 不 await：对话框不能因为后端慢就卡住 —— 下拉先按现有目录（= 本地兜底，三项协议）渲染。
  loadCatalog().catch(() => {});
  let cfg = {};
  try {
    const j = await backend.getPlc();
    cfg = (j && j.config) || {};
  } catch { /* 后端没开就用本机那份 */ }
  if (cfg.username && !s.username) s.username = cfg.username;
  if (cfg.password && !s.password) s.password = cfg.password;
  if (!localStorage.getItem(PLC_KEY)) {
    // 这台浏览器从来没配过 → 直接照着后端那份填（现场换机器就是这个场景）
    for (const k of ['protocol', 'ip', 'port', 'unit', 'poll_ms', 'word_order',
      'endpoint', 'security', 'username', 'password', 'default_ns', 'addr_profile']) {
      if (cfg[k] !== undefined && cfg[k] !== '') s[k] = cfg[k];
    }
  }
  // 三项协议是唯一入口：从 protocol + addr_profile 恢复选择（ts600 落盘是 modbus + ts600-modbus-tcp）。
  // 这样「下拉 / 地址提示 / 变量表 title」三处说的是同一件事（以前是独立地址模型下拉，容易不同步）。
  s.protocol = cfgProto(s);
  {
    const wantProf = profileForProtocol(s.protocol);
    // 对话框初值来自「后端记的那份配置」：先按它对齐地址提示，但**不算用户自己选过**（不写 localStorage）
    if (wantProf && wantProf !== getProfile()) setProfile(wantProf, false);
  }
  const missing = backend.missingFeatures(['word_order4', 'words_by_type', 'string_range', 'orders_probe']);
  // 后端没重启就还是老代码：新参数会被静默当默认值用掉，比报错难查得多 —— 当场说清楚
  const staleWarn = missing.length ? `
      <div style="border:1px solid var(--danger);background:#fdeaea;color:#8a1f1f;border-radius:6px;
                  padding:8px 10px;font-size:12px;line-height:1.7;margin-bottom:8px">
        ⚠ <b>后端是旧版本，这里的设置不会生效</b>（缺功能：${missing.join('、')}）。<br>
        关掉后端重新运行 <code>start_server.bat</code>（前端刷新一下页面即可）。
        旧后端会把「字序 / 字长 / 字符串长度」这些新参数当默认值静默用掉 —— 这就是「int 能传、real 传不对」的常见原因。
      </div>` : '';
  const uaNoLib = backend.supports('opcua') && backend.opcua?.available === false;
  const uaLibWarn = uaNoLib ? `
      <div style="border:1px solid var(--danger);background:#fdeaea;color:#8a1f1f;border-radius:6px;
                  padding:8px 10px;font-size:12px;line-height:1.7;margin-bottom:8px">
        ⚠ <b>后端没有可用的 asyncua，OPC UA 连不上</b>${backend.opcua?.import_error ? `（${esc(backend.opcua.import_error)}）` : ''}。<br>
        装：<code>${esc(backend.opcua?.install || '')}</code>，装完重启后端。Modbus 那条路不受影响。
      </div>` : '';
  // 「断开（回到内存模拟）」是**当场生效**的动作：点它就连同这个对话框一起收掉。
  // ⚠ 以前只弹个 alert、对话框留在原地 —— 用户接下来很自然会去点「确定」，
  //   而「确定」的语义是"按上面这些参数去连"，于是刚断开又连回去了（看着像断开没生效）。
  //   所以：断开 → 立刻关对话框（`disconnected` 也顺手兜一道：万一没关掉，「确定」也不再连）。
  let disconnected = false;
  const dlg = showDialog({
    title: 'PLC 连接（Modbus TCP / TS600 TCP / OPC UA）',
    wide: true,
    body: `${staleWarn}${uaLibWarn}
      <div class="f-row"><span class="f-label">协议</span>
        <select class="f-select" id="plcProto" style="flex:0 0 200px;max-width:200px">
          ${protoList().map(p => `<option value="${esc(p.id)}" ${s.protocol === p.id ? 'selected' : ''}>${esc(p.cn)}</option>`).join('')}
        </select>
        </div>
      <div id="plcModbus">
      <div class="f-row"><span class="f-label">IP 地址</span>
        <input class="f-input" id="plcIp" value="${s.ip}" placeholder="192.168.1.10"></div>
      <div class="f-row"><span class="f-label">端口</span>
        <input class="f-input" id="plcPort" type="number" min="1" max="65535" value="${s.port}" title="PLC 从站端口，模拟器默认 502"></div>
      <div class="f-row"><span class="f-label">站号</span>
        <input class="f-input" id="plcUnit" type="number" min="1" max="255" value="${s.unit}"></div>
      <div class="f-row"><span class="f-label">双字字序</span>
        <select class="f-select" id="plcOrder"
          title="REAL 占 2 个寄存器（DINT 也一样，LREAL 占 4 个）—— 字长按类型算，地址只决定起始寄存器（%MW100 和 %MD50 都是 100 起）。
同一段数据按 4 种字序读出来不一样，认不准就点下面「按 4 种字序各读一次」（只读，不改 PLC）。">
          <option value="cdab">低字在前 CDAB（%MD48 = MW96低 + MW97高）★默认</option>
          <option value="abcd">高字在前 ABCD（大端：MW96高 + MW97低）</option>
          <option value="badc">高字在前 + 字节交换 BADC</option>
          <option value="dcba">低字在前 + 字节交换 DCBA</option>
        </select></div>
      <div id="plcMsg" style="color:var(--text-2);font-size:12px;line-height:1.7;margin:8px 0 0"></div></div>
      <div id="plcOpcua" style="display:none">
        <div class="f-row"><span class="f-label">端点</span>
          <input class="f-input" id="plcEndpoint" value="${esc(s.endpoint || 'opc.tcp://127.0.0.1:4840')}"
                 placeholder="opc.tcp://192.168.1.10:4840" title="CODESYS OPC UA 服务器默认端口 4840"></div>
        <div class="f-row"><span class="f-label" title="当前仅支持 None。加密连接需配置证书。">安全策略</span>
          <select class="f-select" id="plcSecurity">
            <option value="none">None（不加密 + 匿名，CODESYS 默认）</option>
          </select>
        </div>
        <div class="f-row"><span class="f-label">用户名</span>
          <input class="f-input" id="plcUser" value="${esc(s.username || '')}" placeholder="留空 = 匿名">
        </div>
        <div class="f-row"><span class="f-label">密码</span>
          <input class="f-input" id="plcPass" type="password" value="${esc(s.password || '')}" placeholder="留空 = 匿名"></div>
        <div class="f-row"><span class="f-label">默认命名空间</span>
          <input class="f-input" id="plcNs" type="number" min="1" max="65535" value="${s.default_ns || 4}" style="width:80px" title="NodeId 省略 ns= 时使用此值。CODESYS 应用符号通常为 4。"></div>
        <div id="plcMsgUa" class="pane-msg"></div>
      </div>
      <div class="f-row"><span class="f-label" title="1 ms 表示尽快轮询，实际周期仍受通信往返耗时限制。">轮询（ms）</span>
        <input class="f-input" id="plcPoll" type="number" min="1" max="5000" value="${s.poll_ms}">
      </div>
      <div class="f-row" style="margin-top:10px">
        <span class="f-label"></span>
        <button class="tb-btn" id="plcTest">测试连接</button>
        <button class="tb-btn" id="plcEndpoints">端点诊断</button>
        <button class="tb-btn" id="plcOrders">按 4 种字序各读一次</button>
        <button class="tb-btn" id="plcImport">从服务器导入变量…</button>
        <button class="tb-btn" id="plcDisc">断开（回到内存模拟）</button>
      </div>
      <div id="plcDiagOut" style="font-size:12px;line-height:1.8;margin:6px 0 0;white-space:pre-wrap"></div>
      <div id="plcBadAddrRow" style="display:none;border:1px solid var(--warn,#f59e0b);background:#fffbeb;
           border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.8;margin:8px 0 0">
        <div id="plcBadAddr" style="white-space:pre-wrap"></div>
        <div style="margin-top:4px">
          <button class="tb-btn sm" id="plcFixAddr" title="按服务器上的设备名和命名空间纠正。找不到符号时请重新导入。">纠正变量地址</button>
        </div>
      </div>
      <div class="f-row" id="plcOrderRow"><span class="f-label">字序体检</span>
        <input class="f-input" id="plcOrderAddr" value="${probeAddrFor(s.protocol)}" placeholder="${probeAddrFor(s.protocol)}">
        <select class="f-select" id="plcOrderType" style="flex:none;width:96px">
          <option value="real">real</option><option value="dint">dint</option>
          <option value="lreal">lreal</option><option value="uint">uint</option>
        </select></div>
      <div id="plcOrderOut" style="font-size:12px;line-height:1.8;margin:6px 0 0"></div>`,
    onOk: async () => {
      // 已经点过「断开」了 → 「确定」不再把人连回去（对话框正常是已经被关掉了，这里兜底）
      if (disconnected) return true;
      const cfg = readCfg();
      try { localStorage.setItem(PLC_KEY, JSON.stringify(cfg)); } catch { /* 忽略 */ }
      try {
        const j = await backend.connectPlc({ ...cfg, variables: currentVarTable() });
        await refreshPlcStatus();
        // 后端在 connect 里**当场探过一次**（和「测试连接」同一条路）——这一下才准：
        // 编辑器里后端本来不轮询设备（没人看运行画面就不采，见 poll_gate），
        // 只等状态的话永远等不到"在线"，现象就是"测试连接明明通、按确定却说设备没有响应"（现场踩过）。
        const probe = j && j.probe;
        if (probe && probe.ok === false) {
          alert(`连接没有成功：${probe.message || '设备没有响应'}\n\n`
            + '（对话框先留着，可以改完端点/地址再试一次；「端点诊断」能看出服务器接受哪种身份）');
          return false;                                 // 不关对话框、不报成功
        }
        // 探针过了就直接算成功；只有后端是旧版本（没有 probe 这个字段）才退回"轮着看状态，最多 4 秒"
        if (!probe && (cfg.protocol === 'opcua' || cfg.ip)) {
          let stNow = null;
          for (let i = 0; i < 14; i++) {
            await new Promise(r => setTimeout(r, 300));
            stNow = await backend.getPlc().then(r => r.status).catch(() => null);
            if (stNow && (stNow.online || stNow.mode === 'memory')) break;
          }
          if (stNow && stNow.mode !== 'memory' && !stNow.online) {
            alert(`连接没有成功：${stNow.last_error || '设备没有响应'}\n\n`
              + '（对话框先留着，可以改完端点/地址再试一次；「端点诊断」能看出服务器接受哪种身份）');
            return false;                                 // 不关对话框、不报成功
          }
        }
        // 连上了就把这份配置记进工程：保存/导出工程时一起带走，换台机器打开能照着重连
        // ⚠ 但**不把密码写进工程**：工程文件是要拷给别人/存档的，密码跟着跑等于把凭据散出去
        //   （密码只留在本机浏览器的 localStorage 里，本机下次连接照样能填回来）
        project.data.meta.plc = { ...cfg, password: '' };
        project.commit('记录 PLC 配置');
        const st = j.status || {};
        const bad = (st.bad_address || []);
        // 三项协议名都说出来（TS600 落盘是 protocol:"modbus" + addr_profile，按模型才认得出）
        const linked = cfgProto(st) || cfgProto(cfg);
        const head = linked === 'opcua'
          ? `已连接 OPC UA：${cfg.endpoint}${cfg.username ? `（用户 ${cfg.username}）` : '（匿名）'}\n`
            + `变量 ${st.vars} 个，轮询周期 ${st.poll_ms}ms（实测 ${st.cycle_ms || '—'}ms/轮，每轮 ${st.blocks} 次读）\n`
            + '\nNodeId 没规律，加变量建议用「从服务器导入变量…」；变量表一变就自动生效，不用重连。\n'
            + '类型由服务器给（Float/Double/Int16…），没有字序这回事。'
          : `已连接 ${linked === 'ts600' ? 'TS600 TCP' : 'Modbus TCP'} ${cfg.ip}:${cfg.port}（站号 ${cfg.unit}）\n`
            + `变量 ${st.vars} 个，轮询周期 ${st.poll_ms}ms（实测 ${st.cycle_ms || '—'}ms/轮），字序 ${(st.word_order || cfg.word_order).toUpperCase()}\n`
            + (linked === 'ts600'
              ? '地址模型：TS600 系列（D/M/X/Y/S/T/C/R/Z 元件写法）'
              : '地址模型：Invtmatic/INVT Modbus_TCP_Slave（%MW/%MD/%QX 写法）');
        setTimeout(() => alert(head + (bad.length ? `\n\n⚠ 这些变量地址用不了，不会被采集：\n${bad.join('、')}` : '')), 80);
        // 连上了但有读不到的地址（OPC UA 最常见的「设备名写错」）→ 主动提示 + 一键纠正
        if (linked === 'opcua') showBadAddrHint(readCfg(), st);
      } catch (e) {
        alert('连接失败：' + e.message
          + (readCfg().protocol === 'opcua'
            ? '\n（确认 OPC UA 服务器已开、端点端口对；CODESYS 要在工程里启用 OPC UA Server 并发布符号）'
            : '\n（确认 PLC/模拟器已启动、IP 端口正确）'));
        return false;                                   // 失败就不关对话框
      }
      return true;
    },
  });
  const $ = (id) => document.getElementById(id);
  /** 下拉当前协议（归一成三项之一） */
  const curProto = () => protoOf($('plcProto').value);
  const isUa = () => curProto() === 'opcua';
  /** 连上后「有地址读不到」的提示行 + 一键纠正按钮 */
  const showBadAddrHint = (cfg, st) => {
    const bad = st?.bad_address || [];
    const row = $('plcBadAddrRow');
    if (!bad.length) { row.style.display = 'none'; return; }
    row.style.display = '';
    $('plcBadAddr').style.color = 'var(--warn,#b45309)';
    $('plcBadAddr').textContent = `⚠ 有 ${bad.length} 个变量的 NodeId 在服务器上读不到（不会被采集）：`
      + `${bad.slice(0, 6).join('、')}${bad.length > 6 ? ' …' : ''}\n`
      + '最常见的原因是**设备名对不上**：NodeId 里的 |var|<设备名>. 要和运行时上跑的那个应用一致。';
  };
  const uaVal2 = () => ({
    endpoint: $('plcEndpoint').value.trim(),
    security: $('plcSecurity').value,
    username: $('plcUser').value.trim(),
    password: $('plcPass').value,
    defaultNs: +$('plcNs').value || 4,
  });
  const val = () => ({
    ip: $('plcIp').value.trim(),
    port: +$('plcPort').value || 502,
    unit: +$('plcUnit').value || 1,
  });
  const uaVal = () => ({
    endpoint: $('plcEndpoint').value.trim(),
    security: $('plcSecurity').value,
    username: $('plcUser').value.trim(),
    password: $('plcPass').value,
    default_ns: +$('plcNs').value || 4,
  });
  /** 对话框里当前填的完整连接配置（三项协议：Modbus / TS600 共用一套网络字段，OPC UA 另一套） */
  const readCfg = () => {
    const proto = curProto();
    const base = { protocol: proto, poll_ms: +$('plcPoll').value || 200 };
    if (proto === 'opcua') return { ...base, ...uaVal() };
    // Modbus TCP 与 TS600 TCP 是同一个链路：差别只在地址模型（由协议推导，不再单独选）
    return { ...base, ...val(), word_order: $('plcOrder').value,
      addr_profile: profileForProtocol(proto), ...uaValWithoutEndpoint() };
  };
  // OPC UA 的端点/命名空间也留着（切回 Modbus 再切回来不用重填）
  const uaValWithoutEndpoint = () => ({
    endpoint: $('plcEndpoint')?.value.trim() || s.endpoint,
    security: $('plcSecurity')?.value || 'none',
    username: $('plcUser')?.value.trim() || '',
    password: $('plcPass')?.value || '',
    default_ns: +$('plcNs')?.value || 4,
  });
  /** 按协议显隐两组字段 + 两个按钮（字序体检是 Modbus/TS600 专属，导入变量是 OPC UA 专属） */
  const applyProto = () => {
    const proto = curProto();
    const ua = proto === 'opcua';
    $('plcProto').title = addressHelpFor(proto);
    $('plcModbus').style.display = ua ? 'none' : '';
    $('plcOpcua').style.display = ua ? '' : 'none';
    $('plcOrderRow').style.display = ua ? 'none' : '';
    $('plcOrders').style.display = ua ? 'none' : '';
    // 端点诊断要后端支持 opcua_endpoints 才敢点：
    // 旧后端不认识这个 action，会把它当「连接」用掉（当场连上去了，看着像诊断成功）
    const diagOk = backend.supports('opcua_endpoints');
    $('plcEndpoints').style.display = ua && diagOk ? '' : 'none';
    if (!diagOk) $('plcEndpoints').title = '后端是旧版本，没有这个接口 —— 重启后端（start_server.bat）后可用';
    $('plcImport').style.display = ua ? '' : 'none';
    if (ua && backend.opcua?.available === false) $('plcImport').disabled = true;
    // 切换协议 = 整套地址规则换掉（变量表地址提示、新建变量写成什么、bool/数值校验），当场生效
    const prof = profileForProtocol(proto);
    if (prof && prof !== getProfile()) setProfile(prof);
    // 「字序体检」的默认地址跟着协议走（TS600 → D0 / Modbus TCP → %MW0）；用户手填过就别动
    const a = $('plcOrderAddr');
    if (a && !ua) {
      const def = probeAddrFor(proto);
      const cur = a.value.trim();
      if (!cur || cur === '%MW0' || cur === 'D0') { a.value = def; a.placeholder = def; }
    }
  };
  $('plcProto').addEventListener('change', applyProto);
  applyProto();
  $('plcOrder').value = s.word_order || 'cdab';
  $('plcSecurity').value = s.security || 'none';
  $('plcTest').addEventListener('click', async () => {
    const ua = isUa();
    const box = ua ? $('plcMsgUa') : $('plcMsg');
    box.insertAdjacentHTML('afterbegin', '<div id="plcTestMsg" style="color:var(--primary)">正在测试…</div>');
    const proto = curProto();
    const r = await backend.testPlc(proto === 'opcua' ? { protocol: 'opcua', ...uaVal() }
      : { protocol: proto, ...val(), address: probeAddrFor(proto) });
    const el = $('plcTestMsg');
    el.textContent = (r.ok ? '✔ ' : '✘ ') + r.message;
    el.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
    el.style.whiteSpace = 'pre-wrap';
  });
  // 端点诊断：只问「你是谁 / 开了哪些端点 / 接受哪种身份」——不需要建会话，
  // 所以「匿名被拒 / 密码不对 / 只给加密端点」这几种连不上的情况照样能查出原因
  $('plcEndpoints').addEventListener('click', async () => {
    const out = $('plcDiagOut');
    out.style.color = 'var(--text-2)';
    out.textContent = '正在问端点…（这一步不建会话，匿名被拒也能问到）';
    let r;
    try {
      r = await backend.plcEndpoints({ endpoint: $('plcEndpoint').value.trim() });
    } catch (e) {
      out.style.color = 'var(--danger)';
      out.textContent = '诊断失败：' + (e?.message || e);
      return;
    }
    if (r.ok === false) {
      out.style.color = 'var(--danger)';
      out.textContent = '诊断失败：' + (r.message || r.error || '未知原因');
      return;
    }
    const srv = r.server || {};
    const lines = [];
    lines.push(`服务器：${srv.name || '(没报名字)'}${srv.uri ? '　' + srv.uri : ''}`);
    (r.endpoints || []).forEach((e, i) => {
      lines.push(`端点 ${i + 1}：${e.url}`);
      lines.push(`　　安全策略 ${e.policy || '?'} · 安全模式 ${e.mode}`
        + ` · 身份方式 ${e.tokens.length ? e.tokens.map(t => t.type + (t.policy_id ? `(${t.policy_id})` : '')).join('、') : '（无）'}`);
    });
    out.textContent = lines.join('\n');
    const advice = document.createElement('div');
    advice.style.marginTop = '6px';
    advice.style.color = /→ 端点声明了匿名/.test(r.advice || '') ? 'var(--ok)' : 'var(--warn)';
    advice.textContent = r.advice || '';
    out.appendChild(advice);
  });
  // 从服务器导入变量（离线 XML / 在线浏览 → 勾选 → 生成变量表）
  $('plcImport').addEventListener('click', () => {
    import('./opcuaImport.js').then(m => m.openOpcuaImport({
      endpoint: $('plcEndpoint').value.trim(),
      security: $('plcSecurity').value,
      username: $('plcUser').value.trim(),
      password: $('plcPass').value,
      defaultNs: +$('plcNs').value || 4,
    })).catch(e => alert('打开导入对话框失败：' + (e?.message || e)));
  });
  // 连上后发现「有地址读不到」→ 一键按服务器实际符号纠正（设备名/命名空间写错都能救）
  $('plcFixAddr').addEventListener('click', async () => {
    const out = $('plcBadAddr');
    out.textContent = '正在从服务器捞真实符号并对号入座…';
    out.style.color = 'var(--text-2)';
    let r;
    try {
      r = await fixOpcAddresses(uaVal2());
    } catch (e) {
      out.style.color = 'var(--danger)';
      out.textContent = '纠正失败：' + (e?.message || e);
      return;
    }
    if (r.ok === false) {
      out.style.color = 'var(--danger)';
      out.textContent = '纠正失败：' + r.message;
      return;
    }
    out.style.color = r.changed.length ? 'var(--ok)' : 'var(--warn)';
    out.textContent = `服务器上共 ${r.total} 个应用符号，已纠正 ${r.changed.length} 个地址`
      + (r.changed.length ? `（例：${r.changed[0].from} → ${r.changed[0].to}）` : '')
      + (r.unmatched.length ? `\n对不上的 ${r.unmatched.length} 个：${r.unmatched.slice(0, 5).join('、')}`
        + '\n（这些符号服务器上确实没有 —— 用「从服务器导入变量…」按实际节点重新导一次）' : '');
    refreshPlcStatus();
  });
  // 同一个地址按 4 种字序各读一次（只读，不写 PLC）：哪个值看着正常，字序就选哪个
  document.getElementById('plcOrders').addEventListener('click', async () => {
    const out = document.getElementById('plcOrderOut');
    const proto = curProto();
    // 地址归一化跟变量表同一套（HR100→%MW100、百分号可省：MX100.0→%MX100.0）
    const address = normAddr(document.getElementById('plcOrderAddr').value.trim()) || probeAddrFor(proto);
    const vtype = document.getElementById('plcOrderType').value;
    out.innerHTML = '<span style="color:var(--primary)">正在读…</span>';
    let r;
    try {
      r = await backend.plcOrders({ protocol: proto, ...val(), address, vtype });
    } catch (e) {
      out.innerHTML = `<span style="color:var(--danger)">读失败：${e.message}</span>`;
      return;
    }
    if (r.ok === false) {
      out.innerHTML = `<span style="color:var(--danger)">读失败：${r.message || r.error}</span>`;
      return;
    }
    const cur = document.getElementById('plcOrder').value;
    // 显示 6 位有效数字：33.29999923706055 这种浮点尾巴在现场没意义，看着还以为是错的
    const fmt = v => (typeof v === 'number'
      ? (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : String(v))
      : v);
    out.innerHTML = `<div>${address} 的原始寄存器：<code>${(r.words || []).join(' ')}</code></div>`
      + (r.candidates || []).map(c => {
        const num = typeof c.value === 'number';
        // 数值合理（有限、量级正常）的候选标绿，非规格化/无穷/超大值标灰
        const sane = num && Number.isFinite(c.value) && (c.value === 0 || Math.abs(c.value) > 1e-30) && Math.abs(c.value) < 1e30;
        const color = sane ? 'var(--ok)' : 'var(--text-2)';
        return `<div style="color:${color}">${c.order === cur ? '● ' : '　'}${c.order.toUpperCase()}：`
          + `<b>${fmt(c.value)}</b> <span style="color:var(--text-2)">${c.cn}</span></div>`;
      }).join('')
      + '<div style="color:var(--text-2);margin-top:4px">看着正常（不是 1e-320 / 1e38 这种）的那个就是对的，选好点「确定」。</div>';
  });
  document.getElementById('plcDisc').addEventListener('click', async () => {
    const btn = document.getElementById('plcDisc');
    if (btn) btn.disabled = true;
    try {
      await backend.disconnectPlc();
      await refreshPlcStatus();
      disconnected = true;
      dlg.close();                                     // 断开 = 这个对话框的事办完了，直接收掉
      // 用状态栏说一句（不是 alert：弹窗还得再点一次"确定"，跟"断开"这件事容易混）
      statusNote('已断开，回到内存模拟数据源（内部变量）', 6000);
    } catch (e) {
      if (btn) btn.disabled = false;
      alert('断开失败：' + (e?.message || e));
    }
  });
  refreshPlcStatus();
}

/* ── 通用对话框（供各模块调用） ── */
const DUP_KEY = 'hmi-dup';
const DUP_DEF = { count: 3, mode: 'right', cols: 3, gapX: 8, gapY: 8, nameSeq: true, varSeq: true,
  seqStep: 1, addrStep: 0, autoVar: true, varMode: 'always' };
function loadDup() {
  try { return { ...DUP_DEF, ...(JSON.parse(localStorage.getItem(DUP_KEY)) || {}) }; }
  catch { return { ...DUP_DEF }; }
}

/** 快速再复制一份（右下堆叠 +16）：Ctrl+D */
export function duplicateOnce() {
  const ids = getSelection();
  if (!ids.length) return 0;
  const s = loadDup();
  const res = project.duplicateWidgets(ids, { count: 1, mode: 'cascade', nameSeq: true, varSeq: true,
    seqStep: s.seqStep, addrStep: s.addrStep, autoVar: s.autoVar, varMode: s.varMode });
  if (res.missingVars.length) console.warn('[多重复制] 这些变量还没在变量表里：', res.missingVars.join(', '));
  return res.ids.length;
}

/** 多重复制对话框：份数 / 排列方式 / 间距 / 名称·变量名递增 / 地址间隔 / 自动建变量 */
export function openDuplicateDialog() {
  const ids = getSelection();
  if (!ids.length) { alert('先选中要复制的控件（可框选多个）'); return; }
  const s = loadDup();
  showDialog({
    title: `多重复制（已选 ${ids.length} 个控件）`,
    body: `
      <div class="f-row"><span class="f-label">复制份数</span>
        <input class="f-input" id="dupCount" type="number" min="1" max="100" value="${s.count}">
        </div>
      <div class="f-row"><span class="f-label">排列方式</span>
        <select class="f-select" id="dupMode">
          <option value="right">向右排列</option>
          <option value="down">向下排列</option>
          <option value="grid">网格排列</option>
          <option value="cascade">右下堆叠</option>
        </select></div>
      <div class="f-row" id="dupColsRow"><span class="f-label">网格列数</span>
        <input class="f-input" id="dupCols" type="number" min="1" max="20" value="${s.cols}"></div>
      <div class="f-row"><span class="f-label">间距 X / Y</span>
        <input class="f-input" id="dupGapX" type="number" value="${s.gapX}" title="水平间距(px)">
        <input class="f-input" id="dupGapY" type="number" value="${s.gapY}" title="垂直间距(px)"></div>
      <div class="f-row"><span class="f-label">名称递增</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input class="f-check" id="dupNameSeq" type="checkbox" ${s.nameSeq ? 'checked' : ''}>
          <span style="color:var(--text-2);font-size:12px">递增末尾序号</span></label></div>
      <div class="f-row"><span class="f-label">序号步长</span>
        <input class="f-input" id="dupSeqStep" type="number" min="-999" max="999" value="${s.seqStep}"
               title="每份增加的序号。可填负数，0 表示不递增。"></div>
      <div class="f-row"><span class="f-label">变量递增</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input class="f-check" id="dupVarSeq" type="checkbox" ${s.varSeq ? 'checked' : ''}>
          <span style="color:var(--text-2);font-size:12px">每份使用递增的变量名</span></label></div>
      <div class="f-row" id="dupVarModeRow"><span class="f-label">名字没数字</span>
        <select class="f-select" id="dupVarMode">
          <option value="always">也自动加序号（rSpeed → rSpeed1/rSpeed2…）</option>
          <option value="digit">保持同一个变量（只给带数字的名字递增）</option>
        </select></div>
      <div class="f-row" id="dupAddrRow"><span class="f-label">间隔（字）</span>
        <input class="f-input" id="dupAddrStep" type="number" min="-1000" max="1000" value="${s.addrStep}"
               title="地址间隔按寄存器计。0 按变量类型自动计算，负数向前分配。"></div>
      <div class="f-row" id="dupAutoVarRow"><span class="f-label">自动建变量</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input class="f-check" id="dupAutoVar" type="checkbox" ${s.autoVar ? 'checked' : ''}>
          <span style="color:var(--text-2);font-size:12px">创建缺少的变量</span></label></div>`,
    onOk: () => {
      const opts = {
        count: Math.max(1, Math.min(100, +document.getElementById('dupCount').value || 1)),
        mode: document.getElementById('dupMode').value,
        cols: Math.max(1, Math.min(20, +document.getElementById('dupCols').value || 1)),
        gapX: +document.getElementById('dupGapX').value || 0,
        gapY: +document.getElementById('dupGapY').value || 0,
        nameSeq: document.getElementById('dupNameSeq').checked,
        varSeq: document.getElementById('dupVarSeq').checked,
        varMode: document.getElementById('dupVarMode').value,
        seqStep: Math.max(-999, Math.min(999, Math.round(+document.getElementById('dupSeqStep').value || 0)) || 0),
        addrStep: Math.max(-1000, Math.min(1000, Math.round(+document.getElementById('dupAddrStep').value || 0))),
        autoVar: document.getElementById('dupAutoVar').checked,
      };
      try { localStorage.setItem(DUP_KEY, JSON.stringify(opts)); } catch { /* 忽略 */ }
      const res = project.duplicateWidgets(ids, opts);
      // 建了哪些变量、哪些没建上，都要说清楚，别让他运行了才发现绑定是空的
      const lines = [`已复制 ${res.ids.length} 个控件。`];
      if (res.createdVars.length) {
        lines.push(`\n自动创建了 ${res.createdVars.length} 个变量（地址按类型往后排）：`);
        lines.push(res.createdVars.slice(0, 10)
          .map(v => `  ${v.name}  ${v.type}  ${v.address || '(地址待填)'}   ← ${v.from}`).join('\n'));
        if (res.createdVars.length > 10) lines.push(`  …共 ${res.createdVars.length} 个`);
        if (res.noAddrVars.length) {
          lines.push(`\n其中这些的地址没算出来（写法不是 %MW/HR/数字），请在变量表里手填：`);
          lines.push('  ' + res.noAddrVars.slice(0, 8).join('、'));
        }
      }
      if (res.missingVars.length) {
        lines.push(`\n这些变量还没在变量表里，请在左侧「变量」面板补上（或导入 CSV）：`);
        lines.push(res.missingVars.slice(0, 8).join('、')
          + (res.missingVars.length > 8 ? ` …共 ${res.missingVars.length} 个` : ''));
      }
      if (res.createdVars.length || res.missingVars.length) setTimeout(() => alert(lines.join('\n')), 60);
      return true;
    },
  });
  // 只有「网格排列」才需要列数；不递增变量的话，后面几项也没意义
  const modeSel = document.getElementById('dupMode');
  const colsRow = document.getElementById('dupColsRow');
  const sync = () => { colsRow.style.display = modeSel.value === 'grid' ? '' : 'none'; };
  modeSel.value = s.mode;
  modeSel.addEventListener('change', sync);
  sync();
  const varSeq = document.getElementById('dupVarSeq');
  const varMode = document.getElementById('dupVarMode');
  const addrStep = document.getElementById('dupAddrStep');
  const autoVar = document.getElementById('dupAutoVar');
  varMode.value = s.varMode === 'digit' ? 'digit' : 'always';
  const syncVar = () => {
    const on = varSeq.checked;
    document.getElementById('dupVarModeRow').style.display = on ? '' : 'none';
    document.getElementById('dupAddrRow').style.display = on ? '' : 'none';
    document.getElementById('dupAutoVarRow').style.display = on ? '' : 'none';
    // 地址递增是「建出来那些新变量」的地址，所以是勾了自动建变量才可填（以前写反了：勾上反而禁用）
    addrStep.disabled = !autoVar.checked;
  };
  varSeq.addEventListener('change', syncVar);
  autoVar.addEventListener('change', syncVar);
  syncVar();
}

/* ── 通用对话框（供各模块调用） ── */
export function showDialog({ title, body, onOk, wide = false, okText, aboveEditor = false }) {
  const mask = document.getElementById('dlgMask');
  document.getElementById('dlgTitle').textContent = title;
  document.getElementById('dlgBody').innerHTML = body;
  document.getElementById('dlgBox').classList.toggle('wide', !!wide);   // 写大段文字用的宽对话框
  // 从**脚本编辑器**（z 9200）里开的对话框要压过它，否则对话框弹在编辑器背后，看着就是"点了没反应"
  mask.classList.toggle('over-editor', !!aboveEditor);
  // 运行态里弹对话框（比如运行页面按 Ctrl+Shift+L 开 PLC 设置）：得压过运行层，
  // 否则对话框在运行画面底下，看着就是「点了没反应」
  const rtRoot = document.getElementById('runtimeRoot');
  mask.classList.toggle('over-runtime', !!rtRoot && getComputedStyle(rtRoot).display !== 'none');
  mask.classList.remove('hidden');
  const ok = document.getElementById('dlgOk');
  const cancel = document.getElementById('dlgCancel');
  const xBtn = document.getElementById('dlgX');       // 右上角那个 ✕（所有对话框共用）
  ok.textContent = okText || '确定';
  ok.disabled = false;
  // ⚠ onOk 可能是 async（连接 PLC、导入 XML 都要等后端），**必须 await 它的结果**：
  //   以前写成 `onOk() !== false` —— async 函数返回的是 Promise，永远不等于 false，
  //   于是「连不上就别关对话框、让用户改」这条根本不起作用，对话框照样当场关掉。
  const seq = (showDialog._seq = (showDialog._seq || 0) + 1);
  const close = () => {
    if (showDialog._seq !== seq) return;      // 等待期间又开了别的对话框 → 别越权去关它
    mask.classList.add('hidden');
    ok.onclick = cancel.onclick = null;
    if (xBtn) xBtn.onclick = null;
  };
  ok.onclick = async () => {
    if (ok.disabled) return;                  // 等待期间重复点不作数
    ok.disabled = true;
    try {
      if (!onOk || (await onOk()) !== false) close();
    } finally {
      if (showDialog._seq === seq) ok.disabled = false;
    }
  };
  cancel.onclick = close;
  // 右上角的 ✕ = 跟「取消」同一件事（关掉、不提交）。
  // 大弹窗（PLC 设置、API 帮助、报警编辑）内容长，底部的按钮要滚下去才看得见，
  // 右上角有个 ✕ 才好关（Esc 也照样关）。
  if (xBtn) {
    xBtn.style.display = '';
    xBtn.onclick = close;
  }
  return { close };
}


function initAlignGroupLayout() {
  const alignGroup = document.getElementById('alignGroup');
  const toolbar = alignGroup.parentElement;
  const mainGroups = [...toolbar.children].filter(group => group !== alignGroup);
  const clusters = [...alignGroup.children];
  const widthOf = groups => groups.reduce((sum, group) => sum + group.getBoundingClientRect().width, 0);

  const update = () => {
    const style = getComputedStyle(toolbar);
    const available = toolbar.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const selectionWidth = widthOf(clusters) + (clusters.length - 1) * parseFloat(getComputedStyle(alignGroup).columnGap);
    const required = widthOf(mainGroups) + selectionWidth + mainGroups.length * parseFloat(style.columnGap);
    toolbar.classList.toggle('align-inline', required <= available);
  };

  const observer = new ResizeObserver(update);
  [toolbar, ...mainGroups, ...clusters].forEach(el => observer.observe(el));
  update();
}

export function initToolbar() {
  initAlignGroupLayout();
  /* 运行 / 退出 */
  document.getElementById('btnRun').addEventListener('click', async () => {
    const { enterRun } = await import('../runtime/runtime.js');
    enterRun();
  });

  /* 撤销 / 重做 */
  const undoBtn = document.getElementById('btnUndo');
  const redoBtn = document.getElementById('btnRedo');
  undoBtn.addEventListener('click', () => history.undo());
  redoBtn.addEventListener('click', () => history.redo());
  bus.on('history:changed', ({ canUndo, canRedo }) => {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
    undoBtn.title = `撤销 (Ctrl+Z)${history.lastLabel() ? ' — ' + history.lastLabel() : ''}`;
  });

  /* 对齐 */
  document.querySelectorAll('#alignGroup [data-align]').forEach(btn => {
    btn.addEventListener('click', () => alignWidgets(btn.dataset.align));
  });

  /* 等大小 */
  document.querySelectorAll('#alignGroup [data-size]').forEach(btn => {
    btn.addEventListener('click', () => makeSameSize(btn.dataset.size));
  });

  /* 组合 / 取消组合 */
  document.getElementById('btnGroup')?.addEventListener('click', () => {
    if (!groupSelection()) alert('至少选两个控件才能组合（按住 Shift 点选，或框选）');
  });
  document.getElementById('btnUngroup')?.addEventListener('click', () => ungroupSelection());

  /* 层级 */
  const layerButtons = {
    top: document.getElementById('btnZTop'),
    up: document.getElementById('btnZUp'),
    down: document.getElementById('btnZDown'),
    bottom: document.getElementById('btnZBottom'),
  };
  for (const [where, button] of Object.entries(layerButtons)) {
    button.addEventListener('click', () => {
      const ids = getSelection();
      if (ids.length) project.setZ(ids, where);
    });
  }

  /* 锁定 / 解锁 */
  const lockBtn = document.getElementById('btnLock');
  const updateLayerAndLockButtons = () => {
    const ids = getSelection();
    const hasSelection = ids.length > 0;
    const allLocked = hasSelection && ids.every(id => project.getWidget(id)?.locked);
    const step = project.zStepAvailability(ids);
    layerButtons.top.disabled = !hasSelection;
    layerButtons.bottom.disabled = !hasSelection;
    layerButtons.up.disabled = !step.up;
    layerButtons.down.disabled = !step.down;
    lockBtn.disabled = !hasSelection;
    lockBtn.classList.toggle('active', allLocked);
    lockBtn.setAttribute('aria-pressed', String(allLocked));
    lockBtn.setAttribute('aria-label', allLocked ? '解锁' : '锁定');
    lockBtn.querySelector('use').setAttribute('href', allLocked ? '#ui-unlock' : '#ui-lock');
    lockBtn.title = allLocked ? '解锁选中控件' : '锁定选中控件';
  };
  lockBtn.addEventListener('click', () => { toggleLock(); updateLayerAndLockButtons(); });
  bus.on('selection:changed', updateLayerAndLockButtons);
  bus.on('project:changed', updateLayerAndLockButtons);

  /* 网格 */
  document.getElementById('btnGrid').addEventListener('click', toggleGrid);

  /* 画布缩放的快捷键（按钮/滚轮在 canvas.js 里接线） */
  document.getElementById('zoomLabel').addEventListener('click', () => setZoom(1));
  document.addEventListener('keydown', e => {
    if (document.getElementById('runtimeRoot').classList.contains('hidden') === false) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(getZoom() * 1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(getZoom() / 1.25); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    else if (e.key === '9') { e.preventDefault(); zoomFit(); }
  });

  /* 画布设置（尺寸 / 背景 / 网格）—— 按钮和右键菜单都用这个函数 */
  document.getElementById('btnCanvasSetting').addEventListener('click', () => openCanvasSetting());

  /* 工程名 / 新建 / 打开 / 保存 */
  const fileInput = document.getElementById('fileImport');
  document.getElementById('btnPlc').addEventListener('click', () => {
    openPlcDialog().catch(e => alert('打不开 PLC 连接设置：' + (e?.message || e)));
  });
  // PLC 状态指示灯：进页面看一次，之后每 3 秒刷一次（后端离线时静默）
  refreshPlcStatus();
  setInterval(refreshPlcStatus, 3000);

  const nameInput = document.getElementById('projName');
  /** 工程名同时反映到输入框和浏览器标签（一堆标签页时能分清） */
  const refreshProjName = () => {
    const n = project.data?.meta?.name || '未命名工程';
    if (nameInput && document.activeElement !== nameInput) nameInput.value = n;
    document.title = `${n} · WebHMI_设计器`;
  };
  nameInput.addEventListener('change', () => {
    const n = nameInput.value.trim() || '未命名工程';
    nameInput.value = n;
    project.data.meta.name = n;
    project.commit('改工程名');
    refreshProjName();
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });
  bus.on('project:changed', refreshProjName);
  refreshProjName();
  // 工程整份换掉（打开/新建/读服务器/恢复备份）→ 如果它自带 PLC 配置就问一句要不要照它连
  bus.on('project:replaced', ({ data }) => { offerProjectPlc(data); });

  // 工具栏上**不再摆「保存」按钮**（现场要求：那个位置太挤，保存走「▾ → 保存」或 Ctrl+S）
  document.getElementById('btnProjMenu').addEventListener('click', openProjectMenu);
  // 状态栏那句「已自动保存 …」点一下 → 说明自动保存到底存在哪（用户最常问的一句）
  document.getElementById('stSave')?.addEventListener('click', showSaveInfo);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (f) importViaInput(f);
  });

  /* 全局快捷键 */
  document.addEventListener('keydown', e => {
    if (document.getElementById('runtimeRoot').classList.contains('hidden') === false) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); history.undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveToFile(); }
    // Ctrl+D 直接再复制一份；Ctrl+Shift+D 打开「多重复制」对话框
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();                       // 否则 Chrome 会弹"添加书签"
      if (e.shiftKey) openDuplicateDialog();
      else if (!duplicateOnce()) alert('先选中要复制的控件（可框选多个）');
    }
  });
}
