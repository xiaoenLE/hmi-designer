/**
 * frpSettings.js — 「FRP 内网穿透…」（工程 ▾）：把这台机器上的画面/设备**映射到外面**
 *
 * 现场要的：HMI 在车间的局域网里，人想**在外面用手机看画面**（顺手也想连 PLC 调一下）。
 * 做法是这个软件自带一个 FRP 客户端（frpc）：填上自己的 frps 服务器 + 映射端口，开启之后：
 *   · 手机访问 `http://<服务器>:<映射端口>/run` 就是运行画面；
 *   · 另外还能加几条映射（**PLC 的 Modbus 端口**、别的设备/服务）→ 在外面用笔记本直连。
 *
 * 界面只负责"填哪几格 + 开着没 + 为什么没开"：
 *   · 本机 IP / 端口 / 手机该访问的地址 都是**后端算好**的（见 server/core/frp.py）；
 *   · 打开时每 2 秒问一次现状（运行中 / 崩了 / 日志尾巴），改完保存当场就能看出起没起来；
 *   · 「关」这个框不会停穿透（穿透继续跑），要停就按「停止」或把「启用」取消勾选。
 *
 * ⚠ 设置存**这台机器**（server/data/settings.json），不进工程、换机器不带走 ——
 *   服务器地址/token/端口都是"这台机器所在网络"的事，跟画面怎么组没关系。
 */
import { backend } from '../api/backend.js';
import { statusNote, escapeHtml as esc } from '../core/utils.js';
import { showDialog } from './toolbar.js';

let poller = null;
let extras = [];                 // 额外映射（PLC 之类）的本地副本；保存时才写回后端

const q = (id) => document.getElementById(id);
const numOr = (id, dflt = 0) => {
  const v = Number(q(id)?.value);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : dflt;
};

/** 额外映射那几行（就地重画，别把上面输入框里的字刷掉） */
function paintExtras() {
  const box = q('frpExtras');
  if (!box) return;
  box.innerHTML = extras.map((e, i) => `
    <div class="frp-map" data-i="${i}">
      <input class="f-input" data-e="name" value="${esc(e.name || '')}" placeholder="备注（如 PLC）" style="flex:0 0 92px"
             title="只用来在 frpc 里区分这几条映射（留空自动起名）">
      <input class="f-input mono" data-e="local_ip" value="${esc(e.local_ip || '')}" placeholder="本机/局域网 IP" style="flex:1"
             title="要映射的那个设备的 IP：PLC 就填 PLC 的地址（本机服务填 127.0.0.1）">
      <input class="f-input" data-e="local_port" type="number" min="1" max="65535" value="${e.local_port || ''}"
             placeholder="端口" style="flex:0 0 74px" title="设备的端口（Modbus TCP 一般是 502）">
      <span style="color:var(--text-2);font-size:11px;flex:none">→ 远程</span>
      <input class="f-input" data-e="remote_port" type="number" min="1" max="65535" value="${e.remote_port || ''}"
             placeholder="端口" style="flex:0 0 74px" title="映射到服务器上的哪个端口">
      <label style="display:flex;align-items:center;gap:3px;cursor:pointer;flex:none" title="取消勾选 = 这条不映射（配置留着）">
        <input type="checkbox" data-e="enabled" ${e.enabled === false ? '' : 'checked'}></label>
      <button type="button" class="tb-btn sm" data-edel="${i}" title="删掉这一条" style="flex:none;padding:1px 6px">✕</button>
    </div>`).join('');
  box.querySelectorAll('.frp-map').forEach(row => {
    const i = +row.dataset.i;
    row.querySelectorAll('[data-e]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.e;
        extras[i][k] = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
      });
      if (inp.type === 'checkbox') {
        inp.addEventListener('change', () => { extras[i].enabled = inp.checked; });
      }
    });
    row.querySelector('[data-edel]')?.addEventListener('click', () => {
      extras.splice(i, 1);
      paintExtras();
    });
  });
  const hint = q('frpExtraHint');
  if (hint) hint.textContent = extras.length ? '' : '没有额外映射（只映射 HMI 画面）';
}

/** 拼一下"当前该看到什么"，画进结果区 */
function paintStatus(st) {
  const box = q('frpOut');
  if (!box) return;
  // 画面映射那个本机端口是**跟着后端走的**（每次刷新顺手对齐，端口变了当场变）
  const lpEl = document.getElementById('frpLPort');
  if (lpEl && st.local_port) lpEl.textContent = String(st.local_port);
  const c = st.config || {};
  const dot = st.running ? '<span class="frp-dot on"></span>运行中'
    : (c.enabled ? '<span class="frp-dot bad"></span>没在跑' : '<span class="frp-dot off"></span>已关闭');
  const maps = (st.mappings || []).map(m => {
    const to = `${esc(m.local_ip)}:${m.local_port} → 服务器:${m.remote_port}`
      + (m.kind === 'hmi' ? '（画面）' : `（${esc(m.name)}）`);
    return `<li>${to}${m.url ? `　手机开：<code>${esc(m.url)}</code>` : ''}</li>`;
  }).join('');
  const ips = st.ips || [];
  const rows = [
    `<div class="frp-line">状态：<b>${dot}</b>`
    + (st.running ? `　pid ${st.pid}　已跑 ${st.uptime_s}s` : '')
    + (st.restarts ? `　自动重拉 ${st.restarts} 次` : '') + '</div>',
    // 本机就是这台装了 HMI 的机器自己：在这台机器上看画面一律是 127.0.0.1，
    // 不去探测（探测出来的那个是**局域网**地址，手机连同一个 WiFi 才用得上，另起一行）
    `<div class="frp-line" title="在这台机器自己身上看画面，就用这个地址">本机：<code>127.0.0.1</code>`
    + `　HMI 端口 <b>${st.local_port}</b></div>`,
    ips.length ? `<div class="frp-line" title="手机连同一个 WiFi 时用这个地址：http://这个IP:HMI端口/run">`
      + `局域网 IP：<code>${esc(ips.join(' , '))}</code></div>` : '',
    `<div class="frp-line">frpc：${st.frpc_found
      ? `<code>${esc(st.frpc)}</code>`
      : '<b style="color:var(--danger)">没找到 frpc.exe</b> —— 装出来的版本放在「&lt;安装目录&gt;\\frp\\frpc.exe」，'
        + '源码方式跑放在程序的 frp\\ 或 FRP\\ 目录下'}</div>`,
    maps ? `<div class="frp-line">当前映射：<ul style="margin:2px 0 0 18px;padding:0">${maps}</ul></div>` : '',
    st.last_error ? `<div class="frp-line" style="color:var(--danger)">⚠ ${esc(st.last_error)}</div>` : '',
    (st.log || []).length
      ? `<details class="frp-log"><summary>frpc 日志（最近 ${(st.log || []).length} 行）</summary>
           <pre>${esc((st.log || []).join('\n'))}</pre></details>`
      : '',
  ].filter(Boolean);
  box.innerHTML = rows.join('');
}

export async function openFrpSettings() {
  let st = null;
  try {
    st = await backend.rpc('/api/frp', { method: 'GET' });
  } catch (e) {
    showDialog({
      title: 'FRP 内网穿透',
      okText: '知道了',
      body: `<div class="dlg-hint">读不到 FRP 设置：<b>后端没开</b>，或者后端是<b>旧版本</b>（没有这个接口）。
        这项设置存在服务器上（server/data/settings.json），要有后端才能用。<br>
        刚升级过代码的话，重启一下后端（stop_server.bat → start_server.bat）再打开这里。</div>`,
    });
    return;
  }
  const c = st.config || {};
  extras = (c.extras || []).map(e => ({ ...e }));

  showDialog({
    title: 'FRP 内网穿透',
    okText: '保存并应用',
    wide: true,
    body: `
      <div class="f-row"><span class="f-label">启用</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"
          title="勾上保存 → 后端把 frpc 拉起来（下次开机也会自动接着开）；取消勾选保存 → 停掉。这些设置存在这台机器上，不进工程。">
          <input class="f-check" id="frpOn" type="checkbox" ${c.enabled ? 'checked' : ''}>
          <span style="font-size:12px;color:var(--text-2)">开启内网穿透（本机端口映射到 FRPS 服务器）</span></label></div>
      <div class="f-row"><span class="f-label">FRPS 服务器</span>
        <input class="f-input mono" id="frpAddr" value="${esc(c.server_addr || '')}"
               placeholder="你的 frps 地址（域名或 IP，例如 159.75.50.193）" style="flex:1"></div>
      <div class="f-row"><span class="f-label">服务器端口</span>
        <input class="f-input" id="frpSPort" type="number" min="1" max="65535" value="${c.server_port || 7000}" style="width:90px">
        <span style="font-size:12px;color:var(--text-2)">frps 的 bindPort（默认 7000）</span></div>
      <div class="f-row"><span class="f-label">认证 token</span>
        <input class="f-input mono" id="frpToken" type="text" value="${esc(c.token || '')}"
               placeholder="frps 里配的 auth.token（没设就留空）" style="flex:1"></div>

      <div class="f-row" style="margin-top:10px"><span class="f-label">画面映射</span>
        <code id="frpLPort" style="font-size:12.5px;padding:2px 6px;border-radius:4px;background:var(--bg-2)"
              title="就是你现在开着的这个页面地址上的端口（后端实际监听的那个）—— 自动跟着走，不用手填；端口变了它自己变">${st.local_port}</code>
        <span style="color:var(--text-2);font-size:12px;flex:none">→ 远程</span>
        <input class="f-input" id="frpRPort" type="number" min="1" max="65535" value="${c.remote_port || ''}"
               style="width:86px" title="映射到服务器上的端口：手机打开 http://FRPS服务器:这个端口/run 就是运行画面（不用登录、不用装东西）">
        <span style="font-size:12px;color:var(--text-2)">本机 HMI 端口 → 服务器上的映射端口（手机看画面用）</span></div>
      <div class="f-row"><span class="f-label">代理名</span>
        <input class="f-input mono" id="frpName" value="${esc(c.name || '')}"
               placeholder="留空 = hmi-<本机名>（几台机器一起用时各填一个，别撞名）" style="flex:1"></div>

      <div class="prop-group-title" style="margin-top:12px">另外还要映射的端口（PLC 之类）</div>
      <div id="frpExtras"></div>
      <div class="f-row">
        <span class="f-label"></span>
        <button type="button" class="tb-btn sm" id="frpAddExtra">＋ 添加一条</button>
        <button type="button" class="tb-btn sm" id="frpFromPlc">从 PLC 连接填入</button>
        <span id="frpExtraHint" style="font-size:11.5px;color:var(--text-2)"></span>
      </div>

      <div id="frpOut" class="frp-out"></div>
      <div class="f-row" style="margin-top:4px">
        <span class="f-label"></span>
        <button type="button" class="tb-btn sm" id="frpRestart">重新启动 frpc</button>
        <button type="button" class="tb-btn sm danger" id="frpStop">停止</button>
        <span style="font-size:11.5px;color:var(--text-2);line-height:1.6">改完点「保存并应用」；关掉这个框不会停穿透</span>
      </div>`,
    onOk: async () => {
      const patch = {
        enabled: !!q('frpOn')?.checked,
        server_addr: q('frpAddr')?.value.trim() || '',
        server_port: numOr('frpSPort', 7000),
        token: q('frpToken')?.value || '',
        remote_port: numOr('frpRPort', 0),
        name: q('frpName')?.value.trim() || '',
        extras: extras.filter(e => e.local_port && e.remote_port),
      };
      if (patch.enabled && !patch.server_addr) {
        statusNote('先填 FRPS 服务器地址（不填没法连）');
        return false;
      }
      try {
        const r = await backend.rpc('/api/frp', { body: { action: 'save', config: patch } });
        paintStatus(r);
        if (r.running) statusNote(`FRP 已启动：手机访问 ${r.url_remote || '（见对话框里那一行地址）'}`);
        else statusNote(r.last_error || 'FRP 设置已保存（未开启）');
        return true;
      } catch (e) {
        statusNote(`FRP 保存失败：${e?.message || e}`);
        return false;
      }
    },
  });

  paintExtras();
  paintStatus(st);

  q('frpAddExtra')?.addEventListener('click', () => {
    extras.push({ name: '', local_ip: '', local_port: '', remote_port: '', enabled: true });
    paintExtras();
    const rows = document.querySelectorAll('#frpExtras .frp-map');
    rows[rows.length - 1]?.querySelector('input[data-e="local_ip"]')?.focus();
  });
  q('frpFromPlc')?.addEventListener('click', () => {
    const p = st?.plc || {};
    if (!p.mode) { statusNote('现在没接 PLC（内存模拟）—— 手填设备 IP 和端口就行'); return; }
    if (p.protocol === 'opcua') {
      const m = /:(\d+)\s*$/.exec(String(p.endpoint || ''));
      extras.push({ name: 'PLC(OPC UA)', local_ip: (String(p.endpoint || '').replace(/^opc\.tcp:\/\//, '').split(':')[0] || ''),
        local_port: m ? Number(m[1]) : 4840, remote_port: '', enabled: true });
    } else {
      extras.push({ name: 'PLC', local_ip: p.ip || '', local_port: p.port || 502, remote_port: '', enabled: true });
    }
    paintExtras();
    statusNote('已把当前 PLC 的地址/端口填进来 —— 再补一个「远程端口」就行');
  });
  const act = async (action, what) => {
    try {
      const r = await backend.rpc('/api/frp', { body: { action } });
      paintStatus(r);
      statusNote(r.running ? `FRP ${what}：已运行` : (r.last_error || `FRP ${what}完成`));
    } catch (e) {
      statusNote(`FRP ${what}失败：${e?.message || e}`);
    }
  };
  q('frpRestart')?.addEventListener('click', () => act('restart', '重启'));
  q('frpStop')?.addEventListener('click', () => act('stop', '停止'));

  // 开着这个框的时候每 2 秒刷新一次现状（"起没起来、为什么没起来"当场可见）；
  // 关框就停 —— 不在后台一直轮询后端。
  clearInterval(poller);
  poller = setInterval(async () => {
    if (!q('frpOut')) { clearInterval(poller); poller = null; return; }
    try { paintStatus(await backend.rpc('/api/frp', { method: 'GET' })); } catch { /* 后端断了就算了 */ }
  }, 2000);
}
