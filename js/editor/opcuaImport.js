/**
 * opcuaImport.js — 「从 OPC UA 服务器导入变量」
 *
 * 为什么需要它：Modbus 的地址能手写（%MW100 有规律），OPC UA 的 NodeId 没有规律
 *   ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun
 * 手敲既慢又容易错，所以让用户「连上服务器 → 浏览节点树 → 勾几个 → 一键生成变量」：
 *   变量名 = 节点名（重名自动加序号）· 类型 = UA 类型翻成变量表类型 · 地址 = 完整 NodeId
 *
 * 只读操作：浏览和导入都不写 PLC，导入只改本地变量表（改完变量表会自动下发给后端）。
 */
import { project } from '../core/project.js';
import { backend } from '../api/backend.js';
import { showDialog } from './toolbar.js';
import { normNodeId } from '../core/utils.js';
import { readTextFile } from '../core/csv.js';

const IMP_KEY = 'hmi-opcua-import';

function loadCfg() {
  try { return { depth: 4, maxNodes: 3000, includeArrays: true, ...(JSON.parse(localStorage.getItem(IMP_KEY)) || {}) }; }
  catch { return { depth: 4, maxNodes: 3000, includeArrays: true }; }
}
function saveCfg(c) { try { localStorage.setItem(IMP_KEY, JSON.stringify(c)); } catch { /* 忽略 */ } }

/** UA 类型 → 变量表类型（后端也有一份，这边是导入预览用；以后端为准）
 *  ⚠ 两边都是 UA String，但变量表里 string/wstring 分开：Modbus 侧占位不同 */
const UA2HMI = {
  Boolean: 'bool', SByte: 'int', Int16: 'int', Byte: 'uint', UInt16: 'uint',
  Int32: 'dint', UInt32: 'udint', Int64: 'dint', UInt64: 'udint',
  Float: 'real', Double: 'lreal', String: 'string',
};

/**
 * 打开导入对话框。
 * @param {{endpoint?:string, security?:string, username?:string, password?:string, defaultNs?:number}} opt
 */
export async function openOpcuaImport(opt = {}) {
  const cfg = loadCfg();
  // 端点/身份从哪儿来（优先级：调用方 > 本机上次连接填的 > **后端存的那份** > 后端状态 > 默认）
  //   ⚠ 后端那份（server/data/plc.json）是必须的：换了浏览器 / pywebview 窗口是全新 profile 时
  //     localStorage 里什么都没有，不带上它就得每次重敲账号密码。
  let local = {};
  try { local = JSON.parse(localStorage.getItem('hmi-plc-cfg')) || {}; } catch { /* 忽略 */ }
  let srv = {};
  try { srv = ((await backend.getPlc()) || {}).config || {}; } catch { /* 后端没开就用本机的 */ }
  const info = backend.plcInfo || {};
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '') ?? '';
  const ep = pick(opt.endpoint, local.endpoint, srv.endpoint, info.endpoint, 'opc.tcp://127.0.0.1:4840');
  const security = pick(opt.security, local.security, srv.security, info.security, 'none');
  const username = pick(opt.username, local.username, srv.username, info.username);
  // 密码只有本机 localStorage 或「登录后后端给的那份」里有
  const password = pick(opt.password, local.password, srv.password);
  const defaultNs = opt.defaultNs ?? local.default_ns ?? srv.default_ns ?? info.default_ns ?? 4;
  const uaOk = backend.opcua?.available !== false && backend.supports('opcua');
  const noLib = !uaOk || backend.opcua?.available === false;
  const libWarn = noLib ? `
    <div style="border:1px solid var(--danger);background:#fdeaea;color:#8a1f1f;border-radius:6px;
                padding:8px 10px;font-size:12px;line-height:1.7;margin-bottom:8px">
      ⚠ <b>后端还没有可用的 asyncua，OPC UA 功能用不了</b>
      ${backend.opcua?.import_error ? `（${esc(backend.opcua.import_error)}）` : ''}<br>
      装：<code>${esc(backend.opcua?.install || 'python -m pip install "asyncua&lt;2"')}</code>，装完重启后端。
    </div>` : '';

  let nodes = [];                 // 浏览结果
  let picked = new Set();         // 勾选的 nodeid
  let xmlText = '';               // 已选中的符号配置 XML 原文（改设备名时拿它重新解析）
  let lastNameFilter = '';

  showDialog({
    title: '从 OPC UA 导入变量',
    wide: true,
    body: `${libWarn}
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
        <b style="font-size:12px">导入方式</b>
        <label style="font-size:12px;display:flex;align-items:center;gap:4px">
          <input type="radio" name="oiMode" value="xml" checked> CODESYS 导出的符号配置 XML（离线，不用连服务器）</label>
        <label style="font-size:12px;display:flex;align-items:center;gap:4px">
          <input type="radio" name="oiMode" value="live"> 连上服务器浏览节点</label>
      </div>
      <div id="oiXmlBox">
        <div class="f-row"><span class="f-label">符号配置文件</span>
          <input class="f-input" id="oiXmlName" readonly placeholder="（未选择）">
          <button class="tb-btn" id="oiXmlPick">选择 XML…</button>
          <input type="file" id="oiXmlFile" accept=".xml" hidden></div>
        <div class="f-row"><span class="f-label">设备/应用</span>
          <input class="f-input" id="oiDevice" placeholder="设备名（XML 里带的，一般不用改）" style="max-width:210px">
          <input class="f-input" id="oiApp" placeholder="应用名" style="max-width:150px">
          <span style="color:var(--text-2);font-size:11px;flex:none">NodeId = ns=…;s=|var|<b>设备名.应用名</b>.POU.符号</span></div>
        <div id="oiXmlMsg" style="font-size:12px;color:var(--text-2);margin:4px 0 0">
          在 Invtmatic/CODESYS 里：右键「符号配置」对象 → 导出符号配置 → 得到 <code>OPCUA.设备.应用.xml</code>，选它就行。
        </div>
      </div>
      <div id="oiLiveBox" style="display:none">
      <div class="f-row"><span class="f-label">端点</span>
        <input class="f-input" id="oiEp" value="${esc(ep)}" placeholder="opc.tcp://192.168.1.10:4840">
        <span style="color:var(--text-2);font-size:11px;flex:none">CODESYS 内置 OPC UA Server 默认 4840</span></div>
      <div class="f-row"><span class="f-label">用户名</span>
        <input class="f-input" id="oiUser" value="${esc(username)}" placeholder="留空 = 匿名">
        <span style="color:var(--text-2);font-size:11px;flex:none">密码</span>
        <input class="f-input" id="oiPass" type="password" value="${esc(password)}" placeholder="留空 = 匿名">
        <span style="color:var(--text-2);font-size:11px;flex:none">服务器不许匿名时填这里</span></div>
      <div class="f-row"><span class="f-label">起始节点</span>
        <input class="f-input" id="oiRoot" value="" placeholder="留空 = 整个服务器（Objects）">
        <span style="color:var(--text-2);font-size:11px;flex:none">只想要某个 POU，就填它的 NodeId</span></div>
      <div class="f-row"><span class="f-label">浏览深度</span>
        <input class="f-input" id="oiDepth" type="number" min="0" max="10" value="${cfg.depth}" style="width:70px">
        <label style="font-size:12px;display:flex;align-items:center;gap:4px">
          <input type="checkbox" id="oiArrays" ${cfg.includeArrays ? 'checked' : ''}> 包含数组节点</label>
        <span style="color:var(--text-2);font-size:11px;flex:none">看着像 CODESYS 的 Objects → POU → 符号，深度 3~5 够</span></div>
      <div class="f-row"><span class="f-label">过滤</span>
        <input class="f-input" id="oiFilter" placeholder="按 名称 / 路径 / NodeId 过滤（选中项不会被过滤掉）">
        <button class="tb-btn" id="oiBrowse">浏览节点</button></div>
      <div id="oiMsg" style="font-size:12px;color:var(--text-2);margin:6px 0 0;white-space:pre-wrap;line-height:1.7">点「浏览节点」拉取服务器上的变量清单（只读，不写 PLC）。</div>
      </div>
      <div class="f-row" style="margin-top:6px">
        <span class="f-label"></span>
        <button class="tb-btn sm" id="oiAll">全选匹配项</button>
        <button class="tb-btn sm" id="oiNone">清空勾选</button>
        <span id="oiCount" style="color:var(--text-2);font-size:12px"></span>
      </div>
      <div id="oiList" style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:6px;margin-top:6px">
        <div style="padding:14px;color:var(--text-2);font-size:12px">（还没浏览）</div>
      </div>`,
    okText: '导入勾选的变量',
    onOk: async () => {
      if (!picked.size) { alert('还没勾选任何节点'); return false; }
      const chosen = nodes.filter(n => picked.has(n.nodeid));
      const res = importNodes(chosen);
      alert(`导入完成：新增 ${res.added} 个，更新 ${res.updated} 个`
        + (res.expandedFrom
          ? `\n其中 ${res.expandedFrom} 个数组已自动展开成 ${res.expandedTo} 个元素变量（arrw → arrw[1]…arrw[N]）`
          : '')
        + (res.readdressed
          ? `\n其中 ${res.readdressed} 个变量的**地址被刷新了**（旧 NodeId 指向的设备已经不在了，比如换了 PLC 或设备改名；`
            + `旧地址在服务器上不存在，写下去就是 BadNodeIdUnknown）`
          : '')
        + (res.renameByPath
          ? `\n其中 ${res.renameByPath} 个变量**按符号路径改了名**（比如 a → GVL.a）：`
            + `同一个符号换了 PLC / 改了设备名之后名字还是同一个，控件绑定也跟着改好了`
          : '')
        + (res.renamed.length ? `\n有 ${res.renamed.length} 个重名自动改了名字：\n${res.renamed.slice(0, 5).join('\n')}` : '')
        + '\n\n变量表一变会自动下发给后端；连上这台服务器（连接对话框里选 OPC UA）就能采到值。');
      return true;
    },
  });

  const $ = (id) => document.getElementById(id);
  const curCfg = () => ({
    endpoint: $('oiEp').value.trim(), node_id: $('oiRoot').value.trim(),
    depth: +$('oiDepth').value || 4, include_arrays: $('oiArrays').checked,
    filter_text: $('oiFilter').value.trim(), security, default_ns: defaultNs,
    // ⚠ 用户名/密码要**从框里现读**（以前是拿对话框打开那一刻的旧值、而且压根没带密码：
    //   服务器不许匿名时就只会回一句 BadSessionNotActivated）
    username: $('oiUser').value.trim(), password: $('oiPass').value,
  });
  /** 现在用的是哪种导入方式：xml（离线，不用连服务器）/ live（连上浏览） */
  const modeOf = () => document.querySelector('input[name="oiMode"]:checked')?.value || 'xml';
  const syncMode = () => {
    const xml = modeOf() === 'xml';
    $('oiXmlBox').style.display = xml ? '' : 'none';
    $('oiLiveBox').style.display = xml ? 'none' : '';
    nodes = [];
    picked.clear();
    renderList();
  };
  document.querySelectorAll('input[name="oiMode"]').forEach(r => r.addEventListener('change', syncMode));

  // ── XML 离线导入：解析 CODESYS/Invtmatic 导出的「符号配置」文件 ──
  $('oiXmlPick').addEventListener('click', () => { $('oiXmlFile').value = ''; $('oiXmlFile').click(); });
  $('oiXmlFile').addEventListener('change', async () => {
    const f = $('oiXmlFile').files[0];
    if (!f) return;
    $('oiXmlName').value = f.name;
    const msg = $('oiXmlMsg');
    msg.textContent = '正在解析…';
    msg.style.color = 'var(--text-2)';
    let text = '';
    try {
      text = await readTextFile(f);          // 自动认 UTF-8 / GBK / UTF-16
    } catch (e) {
      msg.textContent = '读文件失败：' + (e?.message || e);
      msg.style.color = 'var(--danger)';
      return;
    }
    xmlText = text;
    // XML 里带的设备名/应用名回填成**初始值**（之后用户可以改，改了就按他改的拼 NodeId）
    try {
      const head = /<ProjectInfo[^>]*>/i.exec(text)?.[0] || '';
      const dv = /devicename="([^"]*)"/i.exec(head)?.[1];
      const ap = /appname="([^"]*)"/i.exec(head)?.[1];
      if (dv) $('oiDevice').value = dv;
      if (ap) $('oiApp').value = ap;
    } catch { /* 老文件没有这行就保持手填 */ }
    await parseXmlNow();
  });

  /** 拿当前 XML + 当前填的设备名/应用名重新解析（改名字后调它，NodeId 立刻跟着变） */
  async function parseXmlNow() {
    if (!xmlText) return;
    const msg = $('oiXmlMsg');
    const body = {
      xml: xmlText,
      device: $('oiDevice').value.trim(),
      app: $('oiApp').value.trim(),
      ns: defaultNs,
      // 结构体/多维数组也列出来（标出来但不勾）—— 让用户看见"有这个符号、没导"。
      // 一维数组不在此列：导入时会**自动展开成单个元素变量**（arrw → arrw[1]…arrw[N]）。
      include_complex: true,
    };
    let r;
    try {
      r = await backend.opcuaParseXml(body);
    } catch (e) {
      msg.textContent = '解析失败：' + (e?.message || e);
      msg.style.color = 'var(--danger)';
      return;
    }
    if (r.ok === false) {
      msg.textContent = '解析失败：' + (r.message || r.error || '未知原因');
      msg.style.color = 'var(--danger)';
      nodes = [];
      renderList();
      return;
    }
    // 改设备名重新解析时，保留用户已经勾掉/勾上的选择。
    // ⚠ 不能按 nodeid 对（nodeid 里就含设备名，改完名字全变了）—— 要按**POU.符号 路径**对，
    //   那条路径和「用哪个设备名」无关。
    const prevPaths = new Set([...picked]
      .map(id => (nodes.find(x => x.nodeid === id) || {}).path || '')
      .filter(Boolean));
    const keepOld = prevPaths.size > 0;
    nodes = r.nodes || [];
    picked = new Set(nodes.filter(n => !n.complex && (!keepOld || prevPaths.has(n.path))).map(n => n.nodeid));
    const complexN = nodes.filter(n => n.complex).length;
    const dev = $('oiDevice').value.trim() || r.device;
    const app = $('oiApp').value.trim() || r.app;
    msg.innerHTML = `${esc(r.message)}<br>NodeId 按 <code>ns=${r.ns};s=|var|${esc(dev)}.${esc(app)}.POU.符号</code> 拼出来`
      + `<br><span style="color:var(--text-2)">「设备名/应用名」改成运行时上那台设备的名字即可（比如 CODESYS 设备树里显示的名字），改完这里会立刻重算 NodeId。</span>`
      + (complexN ? `<br>其中 ${complexN} 个是多维数组/结构体（已列出、默认不勾）—— 展不开，<br>`
        + '要用的话得在 CODESYS 里把它们拆成单元素/单字段符号再导出。' : '')
      + `<br><span style="color:var(--text-2)">一维数组勾上后<b>会自动展开</b>：arrw(13) → arrw[1]…arrw[13] 十三条普通变量。</span>`
      + (r.skipped?.length ? `<br>跳过的：${esc(r.skipped.slice(0, 3).map(s => s.path + '（' + s.why + '）').join('；'))}` : '');
    msg.style.color = 'var(--ok)';
    renderList();
  }

  // 设备名/应用名可以随时改：改完重新拼 NodeId（防抖 400ms，别边打字边请求）
  let nameTimer = null;
  ['oiDevice', 'oiApp'].forEach(id => $(id).addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => { parseXmlNow().catch(() => {}); }, 400);
  }));

  $('oiBrowse').addEventListener('click', async () => {
    const msg = $('oiMsg');
    msg.textContent = '正在连接并浏览…（服务器上节点多时可能要几秒）';
    msg.style.color = 'var(--text-2)';
    let r;
    try {
      r = await backend.opcuaBrowse(curCfg());
    } catch (e) {
      msg.textContent = '浏览失败：' + (e?.message || e);
      msg.style.color = 'var(--danger)';
      return;
    }
    if (r.ok === false) {
      // 服务器不许匿名 / 身份不对时，后端会在 message 里附一段「怎么办」（含填用户名密码）
      msg.textContent = '浏览失败：' + (r.message || r.error || '未知原因');
      msg.style.color = 'var(--danger)';
      return;
    }
    nodes = r.nodes || [];
    saveCfg({ ...loadCfg(), depth: curCfg().depth, includeArrays: $('oiArrays').checked });
    msg.textContent = r.message || `找到 ${nodes.length} 个节点`;
    msg.style.color = nodes.length ? 'var(--ok)' : 'var(--warn)';
    if (!nodes.length) {
      msg.textContent += '　—— 换个「起始节点」或加大深度试试（有些服务器要从 Application 节点往下才看得到符号）';
    }
    renderList();
  });

  $('oiAll').addEventListener('click', () => {
    visibleNodes().forEach(n => picked.add(n.nodeid));
    renderList();
  });
  $('oiNone').addEventListener('click', () => { picked.clear(); renderList(); });
  $('oiFilter').addEventListener('input', () => { renderList(); });

  function visibleNodes() {
    const q = $('oiFilter').value.trim().toLowerCase();
    if (!q) return nodes;
    // 已勾选的始终显示：过滤只是为了找，不是为了把已选的藏起来
    return nodes.filter(n => picked.has(n.nodeid)
      || n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
      || n.nodeid.toLowerCase().includes(q));
  }

  function renderList() {
    const box = $('oiList');
    const list = visibleNodes();
    $('oiCount').textContent = `已勾选 ${picked.size} / 共 ${nodes.length} 个节点${list.length !== nodes.length ? `（显示 ${list.length}）` : ''}`;
    if (!nodes.length) {
      box.innerHTML = '<div style="padding:14px;color:var(--text-2);font-size:12px">（还没浏览）</div>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div style="padding:14px;color:var(--text-2);font-size:12px">没有匹配的节点</div>';
      return;
    }
    box.innerHTML = `<table class="vt" style="width:100%">
      <thead><tr><th style="width:28px"></th><th>变量名</th><th>路径</th><th>类型</th><th>变量表类型</th><th>写</th></tr></thead>
      <tbody>${list.map(n => `<tr data-nid="${esc(n.nodeid)}">
        <td><input type="checkbox" data-pick="${esc(n.nodeid)}" ${picked.has(n.nodeid) ? 'checked' : ''}></td>
        <td class="mono">${esc(genVarName(n))}</td>
        <td style="color:var(--text-2);font-size:11px">${esc(n.path)}</td>
        <td>${esc(n.ua_type || '?')}${n.complex
          ? ` <span class="badge">${n.is_array ? '多维数组' : '结构体'}</span>`
          : (n.is_array && n.elements ? ` <span class="badge">数组 ×${n.elements} → 展开</span>` : '')}</td>
        <td style="font-size:11px">${esc(importHint(n))}</td>
        <td>${n.writable ? '可写' : '<span style="color:var(--text-2)">只读</span>'}</td>
      </tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('[data-pick]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) picked.add(cb.dataset.pick); else picked.delete(cb.dataset.pick);
        $('oiCount').textContent = `已勾选 ${picked.size} / 共 ${nodes.length} 个节点`;
      });
    });
  }
  lastNameFilter = '';
  void lastNameFilter;
}

/** 把勾选的节点写进变量表：同名同地址更新，重名自动加序号（不静默覆盖已有的）。
 *  和 CSV 导入一个套路：直接在变量表上批量改，最后只 commit 一次 —— 一次导入 = 一步撤销。
 *
 *  ⚠ **数组一律展开成单个元素变量**：CODESYS 的 OPC UA 里数组元素本身就是独立节点
 *  （实测 `ns=4;s=|var|…GVL.arrw[1]` 能单独读、单独写），所以 `arrw`(13) 直接建成
 *  `arrw[1]` … `arrw[13]` 十三条标量 —— 控件不用管「数组元素」，写元素也不用整段读改写回，
 *  Modbus 侧元素就是连续寄存器，一套规则通吃。下标按 PLC 的写法（CODESYS 是 1 起）。
 *  多维数组/结构体仍然列出来但不勾（展不开）。
 *
 *  导出是为了能单独测（不连服务器、喂一份假的节点表进去就行）—— 匹配规则很容易改错。 */
export function importNodes(chosen) {
  const vars = project.variables();
  const byName = new Map(vars.map(v => [v.name, v]));
  const used = new Set(vars.map(v => v.name));
  const claimed = new Set();          // 本次导入里已经被某个节点用掉的名字
  let added = 0, updated = 0, readdressed = 0, renameByPath = 0, expandedFrom = 0, expandedTo = 0;
  const renamed = [];

  /** 按 NodeId 的**尾巴**找已有变量（忽略设备名前缀）：同一个 PLC 符号，换了 PLC / 改了设备名
   *  之后整段 NodeId 都变了，只有符号路径这部分是稳的 —— 靠它才认得出「就是它」。 */
  const byTail = (path) => {
    const p = String(path || '').trim();
    if (!p) return null;
    return vars.find(v => {
      if (claimed.has(v.name)) return false;
      const a = String(v.address || '').trim();
      return a === p || a.endsWith('.' + p);
    }) || null;
  };

  /** 写一条：名字对得上 → 更新（地址变了也要更新）；
   *  名字对不上但**符号路径对得上**（同一个符号，只是名字旧了）→ 改名 + 刷新地址；
   *  同名但这次导入里已被别的节点占用 → 加序号。
   *  name0 用带点的符号路径（GVL.a 这种），path 是同一份路径（用于按尾巴认变量）。 */
  const put = (name0, type, address, len, value, path = '') => {
    let name = name0;
    const existing = byName.get(name);
    if (existing && !claimed.has(name)) {
      // ⚠ 地址不同也要更新：换 PLC、设备改名、上次是从别的工程导的 ——
      //   旧 NodeId 在服务器上根本不存在，写下去就是 BadNodeIdUnknown。
      //   以前这种会改名成 `xxx_2`，现场看到一堆 _2 只会更乱（而且旧地址还留着继续报错）。
      if ((existing.address || '').trim() !== String(address).trim()) readdressed++;
      existing.type = type;
      existing.address = address;
      if (len) existing.len = len;
      claimed.add(name);
      return 'updated';
    }
    // 名字变了但符号路径没变：就是同一个变量（老工程里叫裸名 `a`，现在按符号路径叫 `GVL.a`）
    if (!existing) {
      const same = byTail(path);
      if (same) {
        const oldName = same.name;
        project.remapVarRefs(oldName, name);        // 控件绑定/动作/报警里的引用一起改
        same.name = name;
        same.type = type;
        same.address = address;
        if (len) same.len = len;
        byName.delete(oldName);
        byName.set(name, same);
        used.add(name);
        claimed.add(name);
        renameByPath++;
        renamed.push(`${oldName} → ${name}（同一个符号，按符号路径取名）`);
        return 'updated';
      }
    }
    if (existing) {
      // 同名但这次导入里已经有节点用了它（不同 POU 里的同名符号各有一份）→ 加序号区分
      let i = 2, cand = `${name}_${i}`;
      while (used.has(cand)) { i++; cand = `${name}_${i}`; }
      renamed.push(`${name} → ${cand}（同名符号在不同 POU 里各有一份）`);
      name = cand;
    }
    used.add(name);
    claimed.add(name);
    const v = { name, type, address, value, len };
    vars.push(v);
    byName.set(name, v);
    return 'added';
  };
  const tally = r => { if (r === 'added') added++; else updated++; };

  chosen.forEach(n => {
    const base = genVarName(n);
    const nodeid = normNodeId(n.nodeid, 4);
    const path = symPathOf(n);
    const nelem = +n.elements || 0;
    // 一维数组 → 展开成元素变量。只对 CODESYS 符号型 NodeId（…;s=|var|…）展开：
    // 数值型 NodeId（ns=2;i=1001）后面接 [k] 服务器不认。
    if (n.is_array && !n.complex && nelem > 0 && /;s=/i.test(nodeid)) {
      const elem = n.elem_type || String(n.hmi_type || '').replace(/\[\]$/, '') || 'real';
      const isStr = elem === 'string' || elem === 'wstring';
      const elLen = isStr ? Math.max(1, Math.min(250, +n.len || 10)) : 0;
      for (let k = 1; k <= Math.max(1, Math.min(4096, nelem)); k++) {
        tally(put(`${base}[${k}]`, elem, `${nodeid}[${k}]`, elLen, isStr ? '' : defaultOf(elem), `${path}[${k}]`));
      }
      expandedFrom++; expandedTo += Math.max(1, Math.min(4096, nelem));
      return;
    }
    // 标量（多维数组/结构体 complex=true，默认不勾，走不到这儿）
    const hmi = n.hmi_type || UA2HMI[n.ua_type] || 'real';
    const isStr = hmi === 'string' || hmi === 'wstring';
    // 长度列：字符串 = 声明的字符数（CODESYS STRING(80) 的 size=81 → 80 字符）
    const len = isStr ? Math.max(1, Math.min(250, +n.len || 10)) : 0;
    tally(put(base, hmi, nodeid, len, defaultOf(hmi), path));
  });
  if (added || updated) project.commit(`导入 OPC UA 变量（${added + updated} 个）`);
  return { added, updated, readdressed, renameByPath, renamed, expandedFrom, expandedTo };
}

/** 节点的**符号路径**（点分，如 `GVL.a`、`PLC_PRG.speed`、`GVL.中1[1]`）：
 *  XML 那边后端算好了（`path`）；浏览那边是 `DeviceSet/设备/…/GVL/a` 这种斜杠路径，认不出就返回 ''。
 *
 *  ⚠ **中文（非 ASCII）符号名也要认**：以前这里的正则写成
 *    `/^[A-Za-z_][\w[\]]*(\.[A-Za-z_][\w[\]]*)*$/`，只认 ASCII 标识符 ——
 *    CODESYS 里叫 `GVL.中1[1]` 的符号整条路径被判成"认不出"，
 *    于是变量名回落成裸名 `中1[1]`（少了 GVL 这一段），变量面板里也就看不到前缀/缩进。
 *    现在按「一段一段都不含点/斜杠/空白」来判断：中英文一样，斜杠路径照样不算。 */
export function symPathOf(n) {
  const p = String(n?.path || '').trim();
  return /^[^\s./\\]+(\.[^\s./\\]+)*$/.test(p) ? p : '';
}

/** 生成变量名：**用带点的符号路径**（`GVL.a`），不是裸名（`a`）。
 *
 *  为什么：一个工程里同名符号很常见（GVL 里一个 `a`、某个 POU 里也有一个 `a`），
 *  裸名会撞车被改成 `a_2`，回头根本看不出哪个是哪个；带上 GVL/POU 这一段就一目了然，
 *  和 PLC 里的符号路径也对得上。认不出符号路径（数值型 NodeId、斜杠路径）就回落用原名。 */
export function genVarName(n) {
  return symPathOf(n) || String(n?.name || '').trim() || 'var';
}

/** 「变量表类型」列显示什么：一维数组导入时会展开，就直接写展开后的样子 */
function importHint(n) {
  const base = n.hmi_type || UA2HMI[n.ua_type] || 'real';
  if (!n.is_array || n.complex || !(+n.elements > 0)) return base;
  const elem = n.elem_type || String(base).replace(/\[\]$/, '') || 'real';
  const nm = String(n.name || 'x');
  return `${elem} ×${n.elements}（${nm}[1]…${nm}[${n.elements}]）`;
}

function defaultOf(hmi) {
  if (hmi === 'bool') return false;
  if (hmi === 'string' || hmi === 'wstring') return '';
  return 0;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
