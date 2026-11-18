#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""loginpage.py — 登录页 HTML

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

客户机上 /run 是开放的（看画面不用登录）、改东西才要登录；这是那个登录页的样子。

★ V2 起这个页面**不用表单提交**：它自己开一条长连接、发 {t:'login', password}，
  成功后把后端给的 token 存进 localStorage 再跳到编辑器。
  为什么不用表单：HTTP 接口已经全删了（连 POST /login 也没有），登录也是长连接上的一条消息。
  token 存 localStorage 是为了"刷新页面/断线重连不用再输一次密码"。
"""

from .paths import EDITOR_PATH
from .paths import RUN_PATH

# 页内脚本：连上 /api/ws → 发 {t:'login'} → 存 token → 跳编辑器。
# 用原生 WebSocket、不引任何库（这个页面要在"什么都没加载"的状态下就能跑）。
# 两种登录：**账号留空 = 内置管理员密码**（老现场照旧）；填了账号 = 账号表里的用户（角色见「用户与角色…」）。
_LOGIN_JS = """
<script>
(function () {
  var f = document.getElementById('f'), pw = document.getElementById('pw'),
      u = document.getElementById('user'),
      btn = document.getElementById('go'), err = document.getElementById('err');
  function show(msg) { err.textContent = msg; err.style.display = 'block'; }
  function done(ok, data) {
    btn.disabled = false; btn.textContent = '登录';
    if (!ok) { show((data && data.error) || '登录失败'); pw.select(); return; }
    try { if (data && data.token) localStorage.setItem('hmi-ws-token', data.token); } catch (e) {}
    // 操作员 / 观察员没有改配置的权限，进了编辑器也只能看 —— 直接给运行画面（现场就这么用）
    var role = (data && data.role) || 'admin';
    location.replace(role === 'admin' ? '__EDITOR__' : '__RUN__');
  }
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.style.display = 'none';
    btn.disabled = true; btn.textContent = '登录中…';
    var base = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws;
    try { ws = new WebSocket(base + location.host + '/api/ws'); }
    catch (e) { return done(false, { error: '这个浏览器不支持 WebSocket' }); }
    var timer = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      done(false, { error: '连不上后端（长连接超时）' });
    }, 8000);
    ws.onopen = function () {
      var msg = { t: 'login', id: 1, password: pw.value };
      var name = u ? String(u.value || '').trim() : '';
      if (name) msg.user = name;              // 留空 = 内置管理员密码登录（老现场不用改习惯）
      ws.send(JSON.stringify(msg));
    };
    ws.onmessage = function (ev) {
      var j; try { j = JSON.parse(ev.data); } catch (e) { return; }
      if (!j || j.t !== 'ack' || j.id !== 1) return;   // hello / 状态帧跳过
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      done(j.ok !== false, j);
    };
    ws.onerror = function () { /* 紧跟 onclose，交给它报 */ };
    ws.onclose = function () {
      clearTimeout(timer);
      if (btn.disabled) done(false, { error: '和后端的连接断了，再试一次' });
    };
  });
})();
</script>
"""


# ─────────────────────────────────────────────
#  登录页（客户机上只有 /run 是开放的；改东西要先在这登录）
# ─────────────────────────────────────────────
LOGIN_PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:,">
<title>登录 · WebHMI_设计器</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#1b1f26; color:#e5e7eb;
         font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif; }
  .card { width:340px; background:#232831; border:1px solid rgba(255,255,255,.1);
          border-radius:12px; padding:26px 24px 22px; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  h1 { margin:0 0 4px; font-size:17px; }
  p.sub { margin:0 0 18px; color:#9aa4b2; font-size:12.5px; line-height:1.7; }
  label { display:block; font-size:12.5px; color:#9aa4b2; margin-bottom:6px; }
  input { width:100%; height:38px; padding:0 11px; border-radius:7px; font-size:14px;
          border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.07); color:#fff; outline:none; }
  input:focus { border-color:#60a5fa; }
  button { width:100%; height:38px; margin-top:14px; border:none; border-radius:7px; cursor:pointer;
           background:#2563eb; color:#fff; font-size:14px; font-weight:600; }
  button:hover { background:#1d4ed8; }
  button[disabled] { background:#3b4a63; opacity:.75; cursor:default; }
  .err { margin-top:12px; padding:8px 10px; border-radius:6px; font-size:12.5px; line-height:1.6;
         display:none; background:rgba(220,38,38,.16); border:1px solid rgba(220,38,38,.5); color:#fca5a5; }
  .foot { margin-top:16px; font-size:12px; color:#9aa4b2; line-height:1.7; }
  .foot a { color:#60a5fa; }
</style></head>
<body>
  <form class="card" id="f" autocomplete="on">
    <h1>登录</h1>
    <p class="sub">现场运行画面在 <b>/run</b>，不用登录也能看。<br>
      要改画面、变量、PLC 连接，或给操作员/观察员用账号登录，才需要这一步。</p>
    <label for="user">账号（留空 = 管理员密码）</label>
    <input id="user" name="username" type="text" autocomplete="username" spellcheck="false"
           placeholder="管理员密码登录：这格留空">
    <label for="pw">密码</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
    <button type="submit" id="go">登录</button>
    <div class="err" id="err"></div>
    <div class="foot">
      账号由管理员在「工程 ▾ → 用户与角色…」里建；内置管理员密码忘了：在服务器上双击 <b>set_password.bat 新密码</b> 重设。<br>
      <a href="__RUN__">← 回到运行画面</a>
    </div>
  </form>
  __SCRIPT__
</body></html>
"""


def login_page_html(err: str = "") -> str:
    """登录页。__RUN__ = 运行页地址、__EDITOR__ = 登录成功后去哪儿、__SCRIPT__ = 页内登录脚本

    ⚠ **必须先塞脚本、再替换 __RUN__ / __EDITOR__**：页内脚本自己也用
    `location.replace('__EDITOR__')` 这个占位符，先替换页面骨架的话，脚本里那个
    就漏掉了 —— 登录成功会跳到字面量 `/__EDITOR__`（404），现场表现是"密码对了却进不去"。
    """
    return (LOGIN_PAGE.replace("__SCRIPT__", _LOGIN_JS)
            .replace("__RUN__", RUN_PATH)
            .replace("__EDITOR__", EDITOR_PATH))
