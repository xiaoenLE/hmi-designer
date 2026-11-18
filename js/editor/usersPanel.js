/**
 * usersPanel.js — 「用户与角色…」（工程 ▾）：**账号表**管理（后端 server/core/users.py）
 *
 * 现场口径：
 *   · 内置「管理员密码」那条路永远在（老现场不用改习惯）；这里建的是**账号**：
 *       - admin   管理员：全部权限（改画面/PLC/日志/用户/配方…）
 *       - operator 操作员：能操作运行画面（写变量、应用配方），不能改配置/存工程/管用户
 *       - viewer  观察员：只能看（运行画面、报警、变量监控），一个变量都写不进去
 *   · 账号表存在**服务器**（数据目录 users.json），密码只存「盐 + 哈希」，列表接口不回密码。
 *   · 最后一个启用中的 admin 不许删/降级/禁用（防止把自己锁在外面）。
 *
 * 改动立即生效（每步都一次 POST /api/users）；这个对话框不跟工程走、不需要 project.commit。
 */
import { showDialog } from './toolbar.js';
import { backend } from '../api/backend.js';
import { escapeHtml as esc } from '../core/utils.js';

const ROLE_CN = { admin: '管理员', operator: '操作员', viewer: '观察员（旧）' };
const ROLE_TIP = {
  admin: '全部权限：画面/变量/PLC/日志/用户/配方都能改',
  operator: '只能改设备连接（PLC / OPC UA 的连接与参数）；画面、变量、配方、用户、存工程都不能改',
  viewer: '（旧的只读账号，仍按只读处理；新建账号不再提供这个角色）',
};

export function openUsersPanel() {
  const state = { users: [], roles: ['admin', 'operator'], roleCn: ROLE_CN, msg: '', msgCls: '', busy: false, pwdFor: '' };

  const body = `
    <style>
      #usrList { border:1px solid var(--border); border-radius:6px; overflow:hidden; }
      #usrList .usr-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid var(--border);
        font-size:13px; }
      #usrList .usr-row:last-child { border-bottom:0; }
      #usrList .usr-name { flex:0 0 132px; font-family:var(--mono); font-size:12.5px; }
      #usrList .usr-created { flex:1; font-size:11.5px; color:var(--text-2); text-align:right; white-space:nowrap; }
      #usrList .usr-row.dis { opacity:.55; }
      #usrMsg.ok { color:#15803d; }
      #usrMsg.warn { color:var(--danger); }
    </style>
    <div class="dlg-hint">内置<b>管理员密码</b>登录永远可用（登录页「账号」留空）。下面是**账号**：
      管理员 / 操作员（能操作运行画面，不能改配置）/ 观察员（只能看）。密码只存哈希，改完立即生效。</div>
    <div class="prop-group-title">账号</div>
    <div id="usrList"></div>
    <div class="f-row" style="margin-top:10px;gap:6px;flex-wrap:wrap">
      <span class="f-label" style="min-width:auto">新账号</span>
      <input class="f-input" id="usrName" style="flex:0 0 140px" placeholder="账号名" spellcheck="false" autocomplete="off">
      <input class="f-input" id="usrPwd" style="flex:0 0 140px" type="password" placeholder="密码（≥4 位）" autocomplete="new-password">
      <select class="f-select" id="usrRole" style="flex:0 0 120px"></select>
      <button type="button" class="tb-btn sm" id="usrAdd">＋ 添加</button>
    </div>
    <div class="f-row">
      <span class="f-label"></span>
      <span id="usrMsg" style="font-size:12px;line-height:1.6;min-height:18px"></span>
      <button type="button" class="tb-btn sm" id="usrReload" style="margin-left:auto">刷新</button>
    </div>
    <div class="dlg-hint" id="usrRoleTip" style="margin-top:4px"></div>
  `;

  showDialog({ title: '用户与角色', wide: true, okText: '关闭', body, onOk: () => true });

  const $ = (id) => document.getElementById(id);
  const setMsg = (text, cls) => {
    state.msg = text || '';
    state.msgCls = cls || '';
    const el = $('usrMsg');
    if (el) { el.className = state.msgCls; el.textContent = state.msg; }
  };
  const roleOptions = (sel) => state.roles
    .map(r => `<option value="${esc(r)}"${r === sel ? ' selected' : ''}>${esc(state.roleCn[r] || r)}</option>`)
    .join('');

  /** 画账号列表（state 变了就整块重画：行里有输入框，重画不影响别处） */
  const renderList = () => {
    const box = $('usrList');
    if (!box) return;
    if (!state.users.length) {
      box.innerHTML = '<div class="usr-row" style="color:var(--text-2);font-size:12px">还没有账号（内置管理员密码照样能登录）</div>';
      return;
    }
    box.innerHTML = state.users.map(u => {
      const dis = u.enabled === false;
      const pwdRow = state.pwdFor === u.name
        ? `<span class="f-row" style="gap:4px;margin:0">
             <input class="f-input" id="usrNewPwd" type="password" style="flex:0 0 130px" placeholder="新密码（≥4 位）" autocomplete="new-password">
             <button type="button" class="tb-btn sm" data-pwdok="${esc(u.name)}">确定</button>
             <button type="button" class="tb-btn sm" data-pwdcancel="1">取消</button>
           </span>`
        : `<button type="button" class="tb-btn sm" data-pwd="${esc(u.name)}">改密码…</button>`;
      return `<div class="usr-row${dis ? ' dis' : ''}">
        <span class="usr-name" title="账号名">${esc(u.name)}</span>
        <select class="f-select" style="flex:0 0 110px" data-role="${esc(u.name)}" ${dis ? 'disabled' : ''}>
          ${roleOptions(u.role)}
        </select>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px">
          <input type="checkbox" class="f-check" data-enable="${esc(u.name)}" ${u.enabled === false ? '' : 'checked'}>
          启用
        </label>
        ${pwdRow}
        <span class="usr-created">${esc(u.created || '')}</span>
        <button type="button" class="tb-btn sm" data-del="${esc(u.name)}" style="color:var(--danger)">删除</button>
      </div>`;
    }).join('');
  };

  const roleTip = () => {
    const sel = $('usrRole');
    const box = $('usrRoleTip');
    if (!sel || !box) return;
    box.textContent = `${sel.value}：${ROLE_TIP[sel.value] || ''}`;
  };
  $('usrRole').innerHTML = roleOptions('operator');
  $('usrRole').addEventListener('change', roleTip);
  roleTip();

  /** 调接口并把结果变成人话（needLogin / 403 / 400 都翻出来） */
  const call = async (payload) => {
    try {
      return await backend.rpc('/api/users', { body: payload });
    } catch (e) {
      const m = (e && e.needLogin) ? '需要管理员登录（先到 /login 用管理员密码登录）'
        : ((e && e.message) || String(e));
      throw new Error(m);
    }
  };

  const reload = async () => {
    try {
      const r = await backend.rpc('/api/users', { method: 'GET' });
      state.users = Array.isArray(r.users) ? r.users : [];
      if (Array.isArray(r.roles) && r.roles.length) state.roles = r.roles;
      if (r.role_cn && typeof r.role_cn === 'object') state.roleCn = r.role_cn;
      $('usrRole').innerHTML = roleOptions($('usrRole').value || 'operator');
      renderList();
      roleTip();
      setMsg(`共 ${state.users.length} 个账号`, '');
    } catch (e) {
      setMsg('读取账号失败：' + ((e && e.message) || e), 'warn');
    }
  };

  $('usrAdd').addEventListener('click', async () => {
    const name = String($('usrName').value || '').trim();
    const password = String($('usrPwd').value || '');
    const role = $('usrRole').value;
    if (!name) { setMsg('账号名不能为空', 'warn'); return; }
    if (password.length < 4) { setMsg('密码至少 4 位', 'warn'); return; }
    $('usrAdd').disabled = true;
    try {
      await call({ action: 'add', user: name, password, role });
      $('usrName').value = '';
      $('usrPwd').value = '';
      setMsg(`已添加账号「${name}」（${state.roleCn[role] || role}）`, 'ok');
      await reload();
    } catch (e) {
      setMsg('添加失败：' + ((e && e.message) || e), 'warn');
    } finally { $('usrAdd').disabled = false; }
  });

  // 行内所有操作走事件委托（列表整块重画，绑在容器上不会丢）
  $('usrList').addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const del = t.getAttribute('data-del');
    if (del && del !== '') {
      if (!confirm(`删除账号「${del}」？这个账号立刻不能再登录（已登录的会话下次请求就失效）。`)) return;
      try {
        await call({ action: 'delete', user: del });
        setMsg(`已删除账号「${del}」`, 'ok');
        await reload();
      } catch (err) { setMsg('删除失败：' + ((err && err.message) || err), 'warn'); }
      return;
    }
    const pwd = t.getAttribute('data-pwd');
    if (pwd !== null) { state.pwdFor = pwd; renderList(); return; }
    if (t.getAttribute('data-pwdcancel') !== null) { state.pwdFor = ''; renderList(); return; }
    const pwdok = t.getAttribute('data-pwdok');
    if (pwdok !== null) {
      const np = String($('usrNewPwd')?.value || '');
      if (np.length < 4) { setMsg('新密码至少 4 位', 'warn'); return; }
      try {
        await call({ action: 'passwd', user: pwdok, password: np });
        state.pwdFor = '';
        setMsg(`已重设「${pwdok}」的密码`, 'ok');
        renderList();
      } catch (err) { setMsg('改密码失败：' + ((err && err.message) || err), 'warn'); }
    }
  });
  $('usrList').addEventListener('change', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const roleFor = t.getAttribute('data-role');
    if (roleFor) {
      try {
        await call({ action: 'role', user: roleFor, role: t.value });
        setMsg(`「${roleFor}」的角色改成 ${state.roleCn[t.value] || t.value}`, 'ok');
        await reload();
      } catch (err) {
        setMsg('改角色失败：' + ((err && err.message) || err), 'warn');
        await reload();            // 失败就把界面拉回真实值，别停在假状态
      }
      return;
    }
    const enableFor = t.getAttribute('data-enable');
    if (enableFor) {
      const on = t.checked;
      try {
        await call({ action: 'enable', user: enableFor, enabled: on });
        setMsg(`已${on ? '启用' : '禁用'}「${enableFor}」`, 'ok');
        await reload();
      } catch (err) {
        setMsg('改启用状态失败：' + ((err && err.message) || err), 'warn');
        await reload();
      }
    }
  });
  $('usrReload').addEventListener('click', reload);

  reload();
}
