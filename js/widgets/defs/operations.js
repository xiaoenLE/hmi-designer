/** 操作记录：实时查看按钮触发、变量写入与配方操作，可按日翻页或筛选。 */
import { register, rutil } from '../registry.js';
import { tr } from '../../core/i18n.js';
import { fmtDate, dayStart } from '../../core/utils.js';

const { escapeHtml } = rutil;
const PAGE_SIZE = 200;
const ACTIONS = {
  button: '按钮触发',
  write: '写入变量',
  page: '切换画面',
  recipe_save: '保存配方',
  recipe_apply: '应用配方',
  recipe_delete: '删除配方',
  clear: '清空记录',
};
const CELL = 'padding:5px 7px;text-align:left;border-bottom:1px solid #e2e8f0;vertical-align:top;';
const CONTROL = 'height:26px;min-width:0;border:1px solid #c3cbd6;border-radius:4px;background:#fff;color:#1f2329;padding:0 6px;';
const PREVIEW = [
  { at: 0, actor: '管理员', action: 'recipe_apply', target: '产品 A', ok: true, detail: '成功 8 项' },
  { at: 0, actor: '未登录', action: 'write', target: '目标速度', ok: false, detail: '设备未连接' },
];
const stamp = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/* 每个控件在看哪一天：放模块作用域，重绘/刷新都不会把它丢了（0 = 还没选过）。 */
const WATCH_DAY = new Map();
const dayLabel = (day) => {
  const diff = Math.round((dayStart() - dayStart(day)) / 86400000);
  if (diff === 0) return tr('今天');
  if (diff === 1) return tr('昨天');
  if (diff === 2) return tr('前天');
  const d = new Date(dayStart(day));
  return tr('{y}年{m}月{d}日').replace('{y}', d.getFullYear())
    .replace('{m}', d.getMonth() + 1).replace('{d}', d.getDate());
};

function tableRows(rows) {
  return rows.map((row) => {
    const date = new Date(row.at);
    const time = row.at === 0 ? '08:30:00' : Number.isFinite(date.getTime()) ? stamp.format(date) : '—';
    const result = tr(row.action === 'button' ? '已触发' : row.ok ? '成功' : '失败');
    const stateStyle = row.ok ? 'color:#166534;background:#dcfce7' : 'color:#991b1b;background:#fee2e2';
    const values = [time, row.actor, tr(ACTIONS[row.action] || row.action), row.target];
    const cells = values.map((value, i) =>
      `<td style="${CELL}${i === 0 ? 'white-space:nowrap;font-variant-numeric:tabular-nums' : 'overflow-wrap:anywhere'}">${escapeHtml(value || '—')}</td>`).join('');
    return `<tr>${cells}<td style="${CELL}white-space:nowrap"><span style="padding:2px 5px;border-radius:4px;${stateStyle}">${escapeHtml(result)}</span></td>
      <td style="${CELL}overflow-wrap:anywhere">${escapeHtml(row.detail || '—')}</td></tr>`;
  }).join('');
}

register({
  type: 'operations',
  title: '操作记录',
  sub: '按钮触发 / 人工写值 / 配方操作',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="6" y="5" width="24" height="27" rx="3" fill="#fff" stroke="#94a3b8"/><path d="M16 12h9m-9 7h9m-9 7h9" stroke="#94a3b8" stroke-width="1.6"/><path d="m10 12 1.5 1.5 2.5-3m-4 9 1.5 1.5 2.5-3" fill="none" stroke="#2563eb" stroke-width="1.6" stroke-linecap="round"/><circle cx="11.5" cy="26" r="1.2" fill="#2563eb"/></svg>',
  defaults: {
    w: 620, h: 300,
    title: '操作记录',
    fontSize: 13,
    dayNav: true,
    clearable: true,
    clearText: '清空记录',
    todayText: '今天',
    clearPerm: 'widget',          // widget = 按控件权限（再验管理员）；admin = 仅管理员
    emptyText: '这一天没有操作记录',
  },
  props: [
    { key: 'title', label: '标题', type: 'text', i18n: 'text' },
    { key: 'fontSize', label: '字号', type: 'number', min: 9, max: 24 },
    { key: 'dayNav', label: '按天翻看', type: 'check', defVal: true },
    { key: 'clearable', label: '可清空', type: 'check', defVal: true },
    { key: 'clearText', label: '清空按钮文字', type: 'text', i18n: 'text' },
    { key: 'todayText', label: '今天按钮文字', type: 'text', i18n: 'text' },
    { key: 'clearPerm', label: '清空权限', type: 'select', defVal: 'widget', title: '按控件权限：先过本控件的「操作权限」，再验管理员；仅管理员：只验管理员',
      options: [{ v: 'widget', t: '按控件权限' }, { v: 'admin', t: '仅管理员' }] },
    { key: 'emptyText', label: '无记录时', type: 'text', i18n: 'text' },
  ],
  binding: null,
  actions: [],
  render(w, mode) {
    const p = w.props || {};
    const edit = mode === 'edit';
    const disabled = edit ? ' disabled' : '';
    const fs = Math.max(9, Math.min(24, Number(p.fontSize) || 13));
    const day = edit ? dayStart() : (WATCH_DAY.get(w.id) ?? dayStart());
    const isToday = dayStart(day) === dayStart();
    const headers = ['时间', '操作者', '操作', '目标', '结果', '详情'].map(text =>
      `<th scope="col" style="${CELL}position:sticky;top:0;background:#eef2f7;white-space:nowrap">${escapeHtml(tr(text))}</th>`).join('');
    // 日期切换条：和「报警历史」一个手感 —— ‹ 日期 › 今天 + 今天/昨天/前天 + 条数 + 清空
    const nav = p.dayNav === false ? '' : `
      <div class="at-nav">
        <button class="at-btn" type="button" data-op="day" data-kind="prev"${disabled} title="${escapeHtml(tr('前一天'))}">‹</button>
        <input class="at-date" type="date" data-op="daydate" value="${fmtDate(day)}"${disabled} title="${escapeHtml(tr('选任意一天'))}">
        <button class="at-btn" type="button" data-op="day" data-kind="next"${disabled} title="${escapeHtml(tr('后一天'))}">›</button>
        <button class="at-btn at-today${isToday ? ' on' : ''}" type="button" data-op="day" data-kind="today"${disabled}>${escapeHtml(tr(p.todayText || '今天'))}</button>
        <span class="at-dayname" data-op="dayname"${isToday ? ' hidden' : ''}>${escapeHtml(isToday ? '' : dayLabel(day))}</span>
        <span class="at-count"></span>
        ${p.clearable !== false && !edit
          ? `<button class="at-btn at-clear" type="button" data-op="clear" title="${escapeHtml(tr('清空这一天的操作记录'))}">${escapeHtml(tr(p.clearText || '清空记录'))}</button>` : ''}
      </div>`;
    return `<div class="w-operations" style="width:100%;height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;border:1px solid #c3cbd6;border-radius:6px;overflow:hidden;background:#fff;color:#1f2329;font-size:${fs}px">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 8px;background:#eef2f7;border-bottom:1px solid #c3cbd6">
        <strong style="flex:1;min-width:4em">${escapeHtml(tr(p.title || '操作记录'))}</strong>
        <input type="search" data-op="filter" aria-label="${escapeHtml(tr('筛选操作记录'))}" placeholder="${escapeHtml(tr('筛选操作记录'))}"${disabled} style="${CONTROL}width:8em;flex:0 1 8em">
        <button type="button" data-op="login" hidden style="${CONTROL}">${escapeHtml(tr('登录查看'))}</button>
        <button type="button" data-op="refresh"${disabled} style="${CONTROL}">${escapeHtml(tr('刷新'))}</button>
      </div>
      ${nav}
      <div data-op="status" role="status" style="padding:5px 8px;color:#526279" ${edit ? 'hidden' : ''}>${escapeHtml(tr('正在读取操作记录…'))}</div>
      <div style="flex:1;min-height:0;overflow:auto">
        <table aria-label="${escapeHtml(tr('操作记录'))}" style="border-spacing:0;width:100%;min-width:510px;font-size:inherit">
          <thead><tr>${headers}</tr></thead><tbody data-op="rows">${edit ? tableRows(PREVIEW) : ''}</tbody>
        </table>
      </div>
      <div class="at-nav" data-op="paging"${edit ? ' hidden' : ''}>
        <button class="at-btn" type="button" data-op="previous" aria-label="${escapeHtml(tr('上一页'))}" disabled>‹</button>
        <button class="at-btn" type="button" data-op="next" aria-label="${escapeHtml(tr('下一页'))}" disabled>›</button>
        <span class="at-count" data-op="count">0 条</span>
      </div>
    </div>`;
  },
  attach(el, w, api) {
    const root = document.getElementById('runtimeRoot');
    const current = () => el.isConnected && root && !root.classList.contains('hidden');
    const get = (key) => el.querySelector(`[data-op="${key}"]`);
    const clearPerm = String(w.props.clearPerm || 'widget');
    let busy = false;
    let pending = false;
    let refreshTimer;
    let filterTimer;
    let page = 0;
    let query = '';
    let total = 0;
    let revision = -1;
    let rows = [];
    let drawn = '';
    let note = '';
    let needLogin = false;
    let mayRefresh = true;
    let day = WATCH_DAY.get(w.id) ?? dayStart();

    function matches(row) {
      return !query || [row.actor, row.target, row.detail, row.action,
        tr(ACTIONS[row.action] || row.action), tr(row.action === 'button' ? '已触发' : row.ok ? '成功' : '失败')]
        .some(value => String(value || '').toLowerCase().includes(query.toLowerCase()));
    }

    function paint() {
      const body = get('rows');
      const signature = JSON.stringify(rows) + '|' + day;
      if (signature !== drawn) {
        body.innerHTML = tableRows(rows);
        drawn = signature;
      }
      const status = get('status');
      status.textContent = note || (!rows.length ? tr(query ? '没有匹配的记录' : (w.props.emptyText || '这一天没有操作记录')) : '');
      status.hidden = !status.textContent;
      get('login').hidden = !needLogin;
      const nameEl = get('dayname');
      if (nameEl) {
        // 今天由「今天」按钮亮蓝表示，这里就不再重复写一遍「今天」
        const isToday = dayStart(day) === dayStart();
        nameEl.textContent = isToday ? '' : dayLabel(day);
        nameEl.hidden = isToday;
      }
      const first = page * PAGE_SIZE;
      const last = Math.min(first + rows.length, total);
      get('count').textContent = total > PAGE_SIZE
        ? `${first + 1}–${last} / ${total} 条` : `${total} 条`;
      get('previous').disabled = page <= 0;
      get('next').disabled = last >= total;
      get('paging').hidden = !mayRefresh;
    }

    function scheduleRead() {
      if (!refreshTimer) refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (mayRefresh) read();
      }, 150);
    }

    async function read() {
      if (!current()) return;
      if (busy) { pending = true; return; }
      busy = true;
      const date = fmtDate(day);
      const search = query;
      const offset = page * PAGE_SIZE;
      const sameView = () => date === fmtDate(day) && search === query && offset === page * PAGE_SIZE;
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset, date, q: search });
      if (search) {
        const lower = search.toLowerCase();
        for (const [key, label] of Object.entries(ACTIONS)) {
          if (tr(label).toLowerCase().includes(lower)) params.append('action', key);
        }
        if (tr('已触发').toLowerCase().includes(lower)) params.append('action', 'button');
        if (tr('成功').toLowerCase().includes(lower)) params.append('result', '1');
        if (tr('失败').toLowerCase().includes(lower)) params.append('result', '0');
      }
      try {
        const r = await api.rpc(`/api/operations?${params}`, { method: 'GET' });
        if (!sameView() || (r.revision != null && r.revision < revision)) return;
        rows = Array.isArray(r.rows) ? r.rows : [];
        total = Number(r.total ?? rows.length);
        if (page > 0 && offset >= total) {
          page = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
          pending = true;
          return;
        }
        note = '';
        needLogin = false;
        mayRefresh = true;
      } catch (e) {
        if (!sameView()) return;
        const denied = e.status === 401 || e.status === 403;
        if (denied) { rows = []; total = 0; }
        needLogin = e.needLogin === true;
        mayRefresh = !denied && e.status !== 404;
        note = needLogin ? tr('请登录管理员账号查看操作记录') : (e.message || tr('读取操作记录失败'));
      } finally {
        busy = false;
        if (current()) {
          if (sameView()) paint();
          if (pending) { pending = false; read(); }
        }
      }
    }

    const unsubscribe = api.onBackendEvent(event => {
      if (!current() || event.t !== 'operations_changed' || !mayRefresh) return;
      revision = event.revision;
      const row = event.row;
      if (row && fmtDate(row.at) === fmtDate(day) && matches(row) && page === 0) {
        rows = [row, ...rows].slice(0, PAGE_SIZE);
        total++;
        note = '';
        paint();
      }
      scheduleRead();
    });

    /** 切到某一天（统一收口：记到 WATCH_DAY、重读、重画） */
    function gotoDay(next) {
      const t = dayStart(next);
      if (!Number.isFinite(t)) return;
      if (dayStart(t) === dayStart(day)) return;
      day = t;
      WATCH_DAY.set(w.id, t);
      page = 0;
      total = 0;
      rows = [];
      drawn = '';
      note = '';
      get('rows').innerHTML = '';
      const dateInput = get('daydate');
      if (dateInput) dateInput.value = fmtDate(day);
      const todayBtn = el.querySelector('[data-op="day"][data-kind="today"]');
      todayBtn?.classList.toggle('on', dayStart(day) === dayStart());
      note = tr('正在读取操作记录…');
      paint();
      read();
    }

    /** 清空这一天的记录：先过权限（按控件权限 / 仅管理员），再确认 */
    async function clearDay() {
      if (clearPerm === 'admin') {
        if (!(await api.requireAdmin(tr('清空操作记录')))) return;
      } else {
        if (!api.allowed('clear')) return;                        // 本控件的「操作权限」
        if (!(await api.requireAdmin(tr('清空操作记录')))) return;  // 后端这个接口本身要管理员
      }
      if (!confirm(tr('确定清空 {day} 的操作记录吗？').replace('{day}', dayLabel(day)))) return;
      try {
        const r = await api.rpc('/api/operations/clear', { method: 'POST', body: { date: fmtDate(day) } });
        note = tr('已清空 {n} 条记录').replace('{n}', r?.removed ?? 0);
      } catch (e) {
        note = e?.message || tr('清空操作记录失败');
      }
      rows = [];
      drawn = '';
      await read();
      if (current()) paint();
    }

    el.addEventListener('input', e => {
      if (e.target.dataset.op !== 'filter') return;
      query = e.target.value.trim();
      page = 0;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(read, 120);
    });
    el.addEventListener('change', e => {
      if (e.target.dataset.op !== 'daydate' || !e.target.value) return;
      const t = new Date(`${e.target.value}T00:00:00`).getTime();
      if (Number.isFinite(t)) gotoDay(t);
    });
    el.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-op]');
      const action = btn?.dataset.op;
      if (action === 'day') {
        const kind = btn.dataset.kind;
        if (kind === 'prev') gotoDay(day - 86400000);
        else if (kind === 'next') gotoDay(day + 86400000);
        else gotoDay(Date.now());
        return;
      }
      if (action === 'previous' || action === 'next') {
        page += action === 'previous' ? -1 : 1;
        await read();
        get('rows').closest('div').scrollTop = 0;
        return;
      }
      if (action === 'clear') { await clearDay(); return; }
      if (action === 'refresh') await read();
      if (action === 'login' && await api.ensureAdmin(tr('查看操作记录'))) await read();
    });
    setTimeout(read, 0);
    const timer = setInterval(() => {
      if (!current()) {
        clearInterval(timer);
        clearTimeout(refreshTimer);
        clearTimeout(filterTimer);
        unsubscribe();
      } else if (mayRefresh && document.visibilityState === 'visible') {
        revision = -1; // 断线期间后端可能重启，定期校准最新快照。
        read();
      }
    }, 5000);
  },
});
