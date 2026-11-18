/**
 * historyPanel.js — 「历史记录…」（工程 ▾）：**服务器侧**历史采样设置 + 导出 CSV 报表
 *
 * 现场要的「历史数据报表」：让后端按固定周期把一组变量的值记下来（存服务器数据目录），
 * 事后挑一个时间段导出 CSV（Excel 直接打开），拿去做报表/追溯。
 *
 * 口径（都在 server/core/history.py，这里只是界面）：
 *   · 采样设置是**这台服务器**的（不跟工程走）：开关 / 周期(500~60000ms) / 保留天数(1~90) / 变量表。
 *   · 采样必须设备在轮询（有人看画面，或后端开了 --poll-always）；内存模拟不受影响。
 *   · 查询/导出**不用登录**；改设置要管理员（编辑器本来就是登录后才进得来）。
 *   · CSV：UTF-8 BOM + CRLF，表头「时间,变量…」，时间 YYYY-MM-DD hh:mm:ss.mmm。
 *   · 单次查询/导出上限 20000 行（后端 truncated=true 时这里提示缩小时间范围）。
 */
import { showDialog } from './toolbar.js';
import { backend } from '../api/backend.js';
import { exportText } from '../core/csv.js';
import { escapeHtml as esc } from '../core/utils.js';

/** 导出时间段预设（today/custom 单独算） */
const RANGES = [
  { v: '1h', t: '最近 1 小时', ms: 3600e3 },
  { v: '24h', t: '最近 24 小时', ms: 24 * 3600e3 },
  { v: '7d', t: '最近 7 天', ms: 7 * 24 * 3600e3 },
  { v: 'today', t: '今天（0 点到现在）', ms: 0 },
  { v: 'custom', t: '自定义时间…', ms: 0 },
];

/** 变量表文本 → 去重后的数组（一行一个；逗号/分号/空格也认，现场常常从 Excel 粘过来） */
function parseVars(text) {
  return [...new Set(String(text || '')
    .split(/[\n\r,，;；\t ]+/).map(s => s.trim()).filter(Boolean))];
}

/** `datetime-local` 的值（本机时区）→ 时间戳；空就回退到默认 */
function localToMs(v, fallback) {
  if (!v) return fallback;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : fallback;
}

/** 时间戳 → `datetime-local` 用的本地字符串 */
function msToLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return String(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 统计那一行：N 天 / M 条 / 最近一条时间 */
function statsText(st) {
  const s = st || {};
  const parts = [];
  parts.push(`已有 <b>${Number(s.days) || 0}</b> 天数据`);
  parts.push(`<b>${Number(s.records) || 0}</b> 条记录`);
  if (s.bytes) parts.push(`${(Number(s.bytes) / 1024 / 1024).toFixed(2)} MB`);
  parts.push(s.lastTs ? `最近一条 ${esc(fmtTime(s.lastTs))}` : '还没有记录');
  return parts.join('　·　');
}

export async function openHistoryPanel() {
  let info = null;
  let loadErr = '';
  try { info = await backend.rpc('/api/history', { method: 'GET' }); }
  catch (e) { loadErr = (e && e.message) || String(e); }
  const s = (info && info.settings) || { on: false, intervalMs: 1000, vars: [], keepDays: 7 };
  const st = (info && info.stats) || {};
  const now = Date.now();
  const varList = Array.isArray(s.vars) ? s.vars.join('\n') : '';

  const body = `
    <style>
      #hstMsg.ok { color:#15803d; }
      #hstMsg.warn { color:var(--danger); }
      #hstStats { font-size:12px; color:var(--text-2); line-height:1.8; min-height:20px; }
      #hstVars { min-height:96px; font-family:var(--mono); font-size:12px; }
    </style>
    <div class="prop-group-title">采样设置（这台服务器）</div>
    <div class="f-row" style="gap:14px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input class="f-check" id="hstOn" type="checkbox" ${s.on ? 'checked' : ''}>
        <span style="font-size:13px">开启历史记录</span>
      </label>
      <span class="f-label" style="min-width:auto">采样周期</span>
      <input class="f-input" id="hstInterval" type="number" min="500" max="60000" step="100"
        value="${Number(s.intervalMs) || 1000}" style="width:104px"> <span style="font-size:12px">ms</span>
      <span class="f-label" style="min-width:auto">保留</span>
      <input class="f-input" id="hstKeep" type="number" min="1" max="90" step="1"
        value="${Number(s.keepDays) || 7}" style="width:76px"> <span style="font-size:12px">天</span>
    </div>
    <div class="f-row" style="align-items:flex-start">
      <span class="f-label">变量</span>
      <textarea class="f-input" id="hstVars" spellcheck="false"
        placeholder="一行一个变量名（最多 256 个）：&#10;rSpeed&#10;rTemp">${esc(varList)}</textarea>
    </div>
    <div class="f-row">
      <span class="f-label"></span>
      <button type="button" class="tb-btn sm" id="hstSave">保存设置</button>
      <button type="button" class="tb-btn sm" id="hstReload">刷新统计</button>
      <span id="hstMsg" style="font-size:12px;line-height:1.6"></span>
    </div>

    <div class="prop-group-title" style="margin-top:14px">数据概况</div>
    <div id="hstStats">${statsText(st)}</div>

    <div class="prop-group-title" style="margin-top:14px">导出 CSV 报表</div>
    <div class="f-row" style="gap:10px;flex-wrap:wrap">
      <span class="f-label" style="min-width:auto">时间段</span>
      <select class="f-select" id="hstRange" style="flex:0 0 200px">
        ${RANGES.map(r => `<option value="${r.v}">${esc(r.t)}</option>`).join('')}
      </select>
      <span style="font-size:12px;color:var(--text-2)">（单次最多 20000 行，超了请缩小时间范围）</span>
    </div>
    <div class="f-row" id="hstCustomRow" style="display:none;gap:8px;flex-wrap:wrap">
      <span class="f-label" style="min-width:auto">起</span>
      <input class="f-input" id="hstFrom" type="datetime-local" value="${msToLocal(now - 3600e3)}" style="flex:0 0 210px">
      <span class="f-label" style="min-width:auto">止</span>
      <input class="f-input" id="hstTo" type="datetime-local" value="${msToLocal(now)}" style="flex:0 0 210px">
    </div>
    <div class="f-row" style="align-items:flex-start">
      <span class="f-label">导出变量</span>
      <textarea class="f-input" id="hstExportVars" spellcheck="false" rows="3"
        placeholder="留空 = 用上面「采样设置」里的变量；也可以只写想导出的那几个（一行一个）"></textarea>
    </div>
    <div class="f-row">
      <span class="f-label"></span>
      <button type="button" class="tb-btn sm" id="hstExport">导出 CSV…</button>
      <span id="hstExpMsg" style="font-size:12px;line-height:1.6"></span>
    </div>
    ${loadErr ? `<div class="dlg-hint" style="color:var(--danger)">读当前设置失败：${esc(loadErr)}</div>` : ''}
  `;

  showDialog({ title: '历史记录', wide: true, okText: '关闭', body, onOk: () => true });

  const $ = (id) => document.getElementById(id);
  const setMsg = (el, text, cls) => {
    if (!el) return;
    el.className = cls || '';
    el.textContent = text || '';
  };

  /** 时间范围（毫秒） */
  const pickRange = () => {
    const kind = $('hstRange').value;
    const nowMs = Date.now();
    if (kind === 'custom') {
      const f = localToMs($('hstFrom').value, nowMs - 3600e3);
      const t = localToMs($('hstTo').value, nowMs);
      return { from: Math.min(f, t), to: Math.max(f, t) };
    }
    if (kind === 'today') {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      return { from: d.getTime(), to: nowMs };
    }
    const r = RANGES.find(x => x.v === kind) || RANGES[0];
    return { from: nowMs - r.ms, to: nowMs };
  };

  $('hstRange').addEventListener('change', () => {
    $('hstCustomRow').style.display = $('hstRange').value === 'custom' ? '' : 'none';
  });

  /** 拉一次设置 + 统计，更新统计行（保存/刷新后调用） */
  const reloadInfo = async () => {
    try {
      const r = await backend.rpc('/api/history', { method: 'GET' });
      if (r && r.stats) $('hstStats').innerHTML = statsText(r.stats);
      return r;
    } catch (e) {
      setMsg($('hstMsg'), '刷新失败：' + ((e && e.message) || e), 'warn');
      return null;
    }
  };

  $('hstSave').addEventListener('click', async () => {
    const okBtn = $('hstSave');
    okBtn.disabled = true;
    try {
      const vars = parseVars($('hstVars').value);
      const intervalMs = Math.round(Number($('hstInterval').value) || 1000);
      const keepDays = Math.round(Number($('hstKeep').value) || 7);
      const r = await backend.rpc('/api/history', {
        body: { action: 'settings', on: $('hstOn').checked, intervalMs, keepDays, vars },
      });
      if (r && r.settings) {
        // 后端会把越界的值夹回合法范围：把夹回后的值写回输入框，免得界面和真实设置不一致
        $('hstInterval').value = r.settings.intervalMs;
        $('hstKeep').value = r.settings.keepDays;
        $('hstOn').checked = !!r.settings.on;
      }
      if (r && r.stats) $('hstStats').innerHTML = statsText(r.stats);
      setMsg($('hstMsg'), `已保存：${$('hstOn').checked ? '正在记录' : '已关闭'}，${vars.length} 个变量，周期 ${$('hstInterval').value}ms，保留 ${$('hstKeep').value} 天`, 'ok');
    } catch (e) {
      const m = (e && e.needLogin) ? '需要管理员登录（先到登录页登录再回来）' : ((e && e.message) || String(e));
      setMsg($('hstMsg'), '保存失败：' + m, 'warn');
    } finally {
      okBtn.disabled = false;
    }
  });

  $('hstReload').addEventListener('click', reloadInfo);

  $('hstExport').addEventListener('click', async () => {
    const okBtn = $('hstExport');
    okBtn.disabled = true;
    try {
      const { from, to } = pickRange();
      const vars = parseVars($('hstExportVars').value);
      const r = await backend.rpc('/api/history', {
        body: { action: 'export', from, to, vars },
      });
      if (!r || r.ok === false || typeof r.csv !== 'string') {
        throw new Error((r && r.error) || '后端没给 CSV');
      }
      // ⚠ 必须同步调 exportText：保存框要在这只点击的手势里弹出来（桌面窗口走原生保存框）
      exportText(r.filename || 'history.csv', r.csv, { kind: 'csv' }).then((res) => {
        if (res && res.ok) {
          setMsg($('hstExpMsg'), `已导出 ${r.count || 0} 行 → ${res.path || r.filename || 'history.csv'}`, 'ok');
        } else if (res && res.cancelled) {
          setMsg($('hstExpMsg'), '已取消导出', '');
        } else {
          setMsg($('hstExpMsg'), '导出失败：' + ((res && res.error) || '文件没保存'), 'warn');
        }
      });
      setMsg($('hstExpMsg'), `正在导出（${r.count || 0} 行）…${r.truncated ? ' 行数超上限，已截断到 20000 行' : ''}`, '');
    } catch (e) {
      setMsg($('hstExpMsg'), '导出失败：' + ((e && e.message) || String(e)), 'warn');
    } finally {
      okBtn.disabled = false;
    }
  });

  // 打开就顺手刷一次统计（对话框开着的时候后端可能正在记数据）
  reloadInfo();
}
