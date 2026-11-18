#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""loginpage.py — 登录页 HTML

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

客户机上 /run 是开放的（看画面不用登录）、改东西才要登录；这是那个登录页的样子。
"""

from .paths import RUN_PATH


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
  .err { margin-top:12px; padding:8px 10px; border-radius:6px; font-size:12.5px; line-height:1.6;
         background:rgba(220,38,38,.16); border:1px solid rgba(220,38,38,.5); color:#fca5a5; }
  .foot { margin-top:16px; font-size:12px; color:#9aa4b2; line-height:1.7; }
  .foot a { color:#60a5fa; }
</style></head>
<body>
  <form class="card" method="POST" action="/login" id="f">
    <h1>管理员登录</h1>
    <p class="sub">现场运行画面在 <b>/run</b>，不用登录也能看。<br>要改画面、变量、PLC 连接才需要登录。</p>
    <label for="pw">密码</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
    <input type="hidden" name="next" value="/">
    <button type="submit">登录</button>
    __ERR__
    <div class="foot">
      忘了密码？在服务器上双击 <b>set_password.bat 新密码</b> 重设。<br>
      <a href="__RUN__">← 回到运行画面</a>
    </div>
  </form>
</body></html>
"""



def login_page_html(err: str = "") -> str:
    """登录页（__RUN__ = 运行页地址、__ERR__ = 错误提示，按当前路由模式填）"""
    return (LOGIN_PAGE.replace("__RUN__", RUN_PATH)
            .replace("__ERR__", f'<div class="err">{err}</div>' if err else ""))
