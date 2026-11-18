#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
opcua_sim.py — 模拟 OPC UA 服务器 + 网页调试台（现场联调用）
========================================================================
和 plc_sim.py 是一对：那个模拟 Modbus 从站，这个模拟 OPC UA 服务器。
没有真 PLC / 真 CODESYS 的时候，用它把「变量表 → NodeId → 读写 → 界面刷新」整条链路跑通。

节点是按 **CODESYS / Invtmatic 内置 OPC UA Server 的样子**造的：

    ns=4;s=|var|CODESYS Control Win V3.Application.PLC_PRG.bRun
    ns=4;s=|var|CODESYS Control Win V3.Application.GVL.rTemp

（`|var|<设备名>.Application.<POU>.<符号>` 就是 CODESYS 发布符号的写法；命名空间
故意注册成 ns=4，和真机一致，好把「默认命名空间 4」这条路一起验掉。）

一条命令启动：
    python server/opcua_sim.py                       # 端点 opc.tcp://127.0.0.1:4841/hmi/，网页 :8898
    python server/opcua_sim.py --port 4840           # 真机默认端口（本机 4840 常被 OPC UA 发现服务占着）
    python server/opcua_sim.py --user ua --password ua   # 打开用户名密码（测「带身份」的连接）
    python server/opcua_sim.py --import-csv 变量表.csv    # 按变量表建节点（第 3 列写 NodeId 或符号名）

⚠ 依赖 asyncua（**1.x**，见 server/opcua.py 顶部说明）：
    python -m pip install "asyncua<2"
"""
import argparse
import asyncio
import csv
import json
import math
import os
import random
import socket
import sys
import threading
import time
import types
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 兼容补丁：Python 3.10.0b1 没有 types.UnionType（详见 server/opcua.py 顶部）
if not hasattr(types, "UnionType"):
    types.UnionType = getattr(types, "Union", None) or type(int | str)   # noqa: UP007

try:
    from asyncua import Server, ua
    from asyncua.server.users import User, UserRole
    from asyncua.server.user_managers import UserManager
except Exception as _e:                              # noqa: BLE001
    print(f"[X] 没装 asyncua 或版本不对（{type(_e).__name__}: {_e}）")
    print('    装：python -m pip install "asyncua<2"')
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from opcua import hmi_type_of_variant, norm_endpoint, parse_symbol_config_xml   # noqa: E402

DEFAULT_DEVICE = "CODESYS Control Win V3"
# 变量表类型 → UA VariantType（wstring 在 OPC UA 侧就是 String；数组由 array_len 决定）
HMI2VT = {
    "bool": (ua.VariantType.Boolean, False),
    "int": (ua.VariantType.Int16, 0),
    "uint": (ua.VariantType.UInt16, 0),
    "dint": (ua.VariantType.Int32, 0),
    "udint": (ua.VariantType.UInt32, 0),
    "real": (ua.VariantType.Float, 0.0),
    "lreal": (ua.VariantType.Double, 0.0),
    "string": (ua.VariantType.String, ""),
    "wstring": (ua.VariantType.String, ""),      # CODESYS 的 WSTRING 在 UA 里也是 String
}


def _cast_one(hmi, value):
    """按变量表类型把一个值收敛好（网页调试台改值和数组元素都用它）
    —— 数组的每个元素也要按**元素类型**走，不能一律 float（否则 int[] 会被写成浮点，
    数组整体类型对不上，真机那样严格的服务器会直接拒）。"""
    t = str(hmi or "real").lower()
    if t == "bool":
        return str(value).strip().lower() in ("1", "true", "on", "yes", "是")
    if t in ("int", "uint", "dint", "udint"):
        return int(round(float(value)))
    if t in ("real", "lreal"):
        return float(value)
    return str(value)


class StaticUserManager(UserManager):
    """简易用户名密码（默认不开：不传就是匿名，和 CODESYS 默认一致）"""

    def __init__(self, users):
        self.users = dict(users)

    def get_user(self, iserver, username=None, password=None, certificate=None):   # noqa: A003
        if not username:
            return None                       # 匿名
        if self.users.get(username) == password:
            return User(role=UserRole.User)
        return None                           # 密码不对 → 服务器回 BadUserAccessDenied


class OpcSim:
    """模拟 OPC UA 服务器：节点表 + 值缓存 + 日志，全部线程安全。

    线程模型：UA 服务器在后台线程的 asyncio 循环里跑，网页调试台在主线程；
    网页要改值就用 run_coroutine_threadsafe 投进循环（和 server/opcua.py 一个套路）。
    """

    def __init__(self, host="127.0.0.1", port=4841, device=DEFAULT_DEVICE,
                 username="", password="", ns_dummies=2):
        self.host = host
        self.port = int(port)
        self.device = device
        self.endpoint = f"opc.tcp://{host}:{self.port}/hmi/"
        self.users = {username: password} if username else {}
        self.ns_dummies = max(0, int(ns_dummies))      # 注册几个占位命名空间，让真名的 ns 落到 4
        self.lock = threading.RLock()
        self.rows = {}                # key -> {name,pou,nodeid,hmi,vt,value,writable,node,auto}
        self.order = []               # key 顺序（网页表格顺序）
        self.log = []
        self.stats = {"clients": 0, "reads": 0, "writes": 0}
        self._loop = None
        self._server = None
        self._started = threading.Event()
        self._thread = None

    # ── 节点定义 ──
    def define(self, name, hmi="real", pou="PLC_PRG", value=None, writable=True,
               nodeid="", auto=None, array_len=0):
        """登记一个节点（nodeid 不给就按 CODESYS 符号写法造）"""
        hmi = (hmi or "real").lower()
        vt, dflt = HMI2VT.get(hmi, HMI2VT["real"])
        if not nodeid:
            nodeid = f"|var|{self.device}.Application.{pou}.{name}"
        key = nodeid
        # auto：补全参数并钉上起始时刻 t0 —— 少 t0 的话正弦相位永远是 0，
        # 波形就"卡"在一个固定值上（看着像采集坏了，其实是仿真没跑起来）
        auto_cfg = None
        if auto:
            auto_cfg = {"kind": "sine", "period": 5.0, "amp": 1000.0, "mid": 0.0, **auto,
                        "t0": time.time()}
        with self.lock:
            if key in self.rows:
                return key
            self.rows[key] = {
                "key": key, "name": name, "pou": pou, "nodeid": nodeid, "ns": 4,
                "hmi": hmi, "vt": vt, "array_len": int(array_len or 0),
                "value": dflt if value is None else value,
                "writable": bool(writable), "node": None, "auto": auto_cfg,
                "client_value": None,
            }
            self.order.append(key)
        return key

    def define_defaults(self):
        """默认节点集：和「演示工程」的变量名对得上，装好就能连"""
        self.define("bRun", "bool", "PLC_PRG", False)
        self.define("bAlarm", "bool", "PLC_PRG", False)
        self.define("iCount", "int", "PLC_PRG", 0)
        self.define("iSet", "int", "PLC_PRG", 100)
        self.define("rSpeed", "real", "PLC_PRG", 0.0, auto={"kind": "sine", "period": 6.0, "amp": 1200.0, "mid": 1500.0})
        self.define("rSet", "real", "PLC_PRG", 3000.0)
        self.define("sMode", "string", "PLC_PRG", "手动")
        self.define("bAuto", "bool", "GVL", True)
        self.define("rTemp", "lreal", "GVL", 26.5)
        self.define("iSerial", "dint", "GVL", 20261002, writable=False)    # 只读：验「写只读节点要报错」
        self.define("rArr", "real", "PLC_PRG", [0.0] * 5, array_len=5)     # 数组：验「数组节点」的提示

    # ── 日志 ──
    def add_log(self, text):
        with self.lock:
            self.log.append(f"{time.strftime('%H:%M:%S')}  {text}")
            if len(self.log) > 300:
                del self.log[:150]

    # ── 起服务器 ──
    def start(self):
        self._thread = threading.Thread(target=self._thread_main, daemon=True)
        self._thread.start()
        self._started.wait(20)

    def _thread_main(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._main())
        except Exception as e:                        # noqa: BLE001
            self.add_log(f"[错误] OPC UA 服务器退出：{type(e).__name__}: {e}")
            print(f"[X] OPC UA 服务器退出：{type(e).__name__}: {e}")
        finally:
            self._started.set()
            try:
                self._loop.close()
            except Exception:                         # noqa: BLE001
                pass

    async def _main(self):
        srv = Server(user_manager=StaticUserManager(self.users) if self.users else None)
        await srv.init()
        # 占位命名空间：真名落到 ns=4，和 CODESYS 真机一致
        for i in range(self.ns_dummies):
            await srv.register_namespace(f"urn:invtmatic:reserved:{i}")
        idx = await srv.register_namespace("urn:invtmatic:demo:application")
        srv.set_endpoint(self.endpoint)
        # 按 POU 分组挂成对象：Objects → PLC_PRG / GVL
        groups = {}
        publish = {}
        for key in list(self.order):
            with self.lock:
                row = dict(self.rows[key])
            pou = row["pou"]
            if pou not in groups:
                groups[pou] = await srv.nodes.objects.add_object(idx, pou)
            if row["array_len"]:
                val = list(row["value"]) if isinstance(row["value"], (list, tuple)) else [0.0] * row["array_len"]
                node = await groups[pou].add_variable(
                    ua.NodeId(row["nodeid"], idx, ua.NodeIdType.String), row["name"],
                    ua.Variant(val, row["vt"]), row["vt"])
            else:
                node = await groups[pou].add_variable(
                    ua.NodeId(row["nodeid"], idx, ua.NodeIdType.String), row["name"],
                    row["value"], row["vt"])
            if row["writable"]:
                await node.set_writable()
            else:
                # 只读节点：AccessLevel 只留 CurrentRead（不显式设的话 asyncua 默认给的是可读可写，
                # 界面上「只读」就验不出来了）
                await node.write_attribute(
                    ua.AttributeIds.AccessLevel,
                    ua.DataValue(ua.Variant(ua.AccessLevel.CurrentRead, ua.VariantType.Byte)))
            publish[key] = (node, node.nodeid.to_string())
        # 建完节点把表格换成「以发布出去的 NodeId 为键」：网页调试台/自动化脚本拿到的是
        # ns=4;s=… 这种全名，按键找回同一个节点才对得上（以前键是 |var|… 短名，两套名字并存，
        # 按全名改值会「没有这个节点」）
        with self.lock:
            old_order = list(self.order)
            for old_key, (node, nid_str) in publish.items():
                row = self.rows.pop(old_key, None)
                if row is None:
                    continue
                row["node"] = node
                row["ns"] = node.nodeid.NamespaceIndex
                row["nodeid"] = nid_str
                row["key"] = nid_str
                row["old_key"] = old_key
                self.rows[nid_str] = row
            # ⚠ order 里存的还是旧键，得按 publish 换成新键（直接用旧键下标会 KeyError，
            #   异常一抛服务器线程就没了 —— 表现是「网页还能开、UA 端口没人听」）
            self.order = [self.rows[publish[k][1]]["key"] for k in old_order if k in publish]
        await srv.start()
        self._server = srv
        self.add_log(f"服务器已启动：{self.endpoint}（{len(self.order)} 个节点，"
                     f"匿名{' + 用户名密码' if self.users else ''}）")
        print(f"[opcua-sim] 已启动 {self.endpoint}  命名空间 ns={idx}")
        self._started.set()
        try:
            await self._monitor()
        finally:
            try:
                await srv.stop()
            except Exception:                         # noqa: BLE001
                pass

    async def _monitor(self):
        """每 0.25 秒扫一遍节点：跑自动仿真 + 发现「客户端写入」并记日志。

        为什么要扫：OPC UA 服务器这边收不到「谁改了这个节点」的回调（要挂内部订阅才行），
        而现场最想知道的就是「界面按了按钮，到底写进来没有、写成多少」——
        拿缓存对比一下就能看见，简单可靠。

        ⚠ 这一圈里任何异常都不能让循环退出：它一死，网页上的值就不再刷新、
        自动仿真也停了（看着像「服务器卡住」，其实是这里抛了异常）。
        所以逐个节点 try/except + 整圈兜底，出错只记日志。"""
        with self.lock:
            cache = {k: self.rows[k]["value"] for k in self.order}
        while True:
            await asyncio.sleep(0.25)
            now = time.time()
            for key in list(self.order):
                try:
                    await self._tick_one(key, cache, now)
                except Exception as e:                # noqa: BLE001
                    self.add_log(f"[警告] 节点 {key} 巡检出错：{type(e).__name__}: {e}")

    async def _tick_one(self, key, cache, now):
        with self.lock:
            row = self.rows.get(key)
        if not row or row.get("node") is None:
            return
        # 1) 自动仿真
        cfg = row.get("auto")
        if cfg:
            cfg.setdefault("t0", now)                 # 兜底：老配置/手工塞进来的没有 t0
            t = now - cfg["t0"]
            period = max(0.2, float(cfg.get("period", 5)))
            amp = float(cfg.get("amp", 1000))
            mid = float(cfg.get("mid", 0))
            kind = cfg.get("kind", "sine")
            if kind == "sine":
                v = mid + amp * math.sin(2 * math.pi * t / period)
            elif kind == "ramp":
                v = mid + amp * ((t % period) / period)
            else:
                v = mid + amp * random.random()
            if row["hmi"] in ("int", "uint", "dint", "udint"):
                v = int(round(v))
            await row["node"].write_value(ua.Variant(v, row["vt"]))
            with self.lock:
                self.rows[key]["value"] = v
            cache[key] = v
            return
        # 2) 读回当前值：客户端写进来的会在这儿露出来
        cur = await row["node"].read_value()
        if isinstance(cur, list):
            cur = list(cur)
        if cur != cache.get(key):
            self.add_log(f"[写入] {row['name']} = {cur!r}（来自客户端）")
            self.stats["writes"] += 1
            with self.lock:
                if key in self.rows:
                    self.rows[key]["value"] = cur
            cache[key] = cur

    def stop(self):
        if self._loop and self._server:
            try:
                asyncio.run_coroutine_threadsafe(self._server.stop(), self._loop).result(timeout=5)
            except Exception:                         # noqa: BLE001
                pass

    # ── 网页调试台用的同步接口 ──
    def _row(self, key):
        """按键找节点：全名（ns=4;s=…）、短名（|var|…）、节点名都认
        —— 网页给的是全名，测试脚本可能给短名或名字，都别让人猜"""
        with self.lock:
            if key in self.rows:
                return self.rows[key]
            for r in self.rows.values():
                if r.get("old_key") == key or r.get("name") == key or r.get("nodeid") == key:
                    return r
        return None

    def snapshot(self):
        with self.lock:
            out = []
            for key in self.order:
                r = self.rows[key]
                out.append({
                    "key": key, "name": r["name"], "pou": r["pou"],
                    "nodeid": r["nodeid"], "ns": r["ns"], "hmi": r["hmi"],
                    "ua_type": getattr(r["vt"], "name", str(r["vt"])),
                    "value": r["value"], "writable": r["writable"],
                    "array_len": r["array_len"],
                    "auto": (r.get("auto") or {}).get("kind", "") if r.get("auto") else "",
                    "auto_period": (r.get("auto") or {}).get("period", 5) if r.get("auto") else "",
                })
            return {"endpoint": self.endpoint, "device": self.device,
                    "vars": out, "log": list(self.log[-120:]),
                    "stats": dict(self.stats), "users": list(self.users.keys())}

    def set_value(self, key, value):
        row = self._row(key)
        if not row:
            raise ValueError("没有这个节点")
        key = row["key"]
        if not row["writable"]:
            raise ValueError("这个节点是只读的")
        elem = row["hmi"]                     # 数组元素类型（define 时传的就是元素类型）
        if row["array_len"]:
            parts = value if isinstance(value, (list, tuple)) else \
                [v for v in str(value).replace("[", "").replace("]", "").split(",") if str(v).strip() != ""]
            cast = [_cast_one(elem, v) for v in parts]
            if len(cast) != row["array_len"]:
                raise ValueError(f"数组要 {row['array_len']} 个数（逗号分隔），给的是 {len(cast)} 个")
        else:
            cast = _cast_one(elem, value)
        fut = asyncio.run_coroutine_threadsafe(
            row["node"].write_value(ua.Variant(cast, row["vt"])), self._loop)
        fut.result(timeout=5)
        with self.lock:
            self.rows[key]["value"] = cast
        self.add_log(f"[网页] {row['name']} = {cast!r}")
        return cast

    def set_auto(self, key, kind="", period=5.0, amp=1000.0, mid=0.0):
        row = self._row(key)
        if not row:
            raise ValueError("没有这个节点")
        key = row["key"]
        with self.lock:
            if not kind:
                row["auto"] = None
                self.add_log(f"[网页] {row['name']} 关闭自动仿真")
            else:
                row["auto"] = {"kind": kind, "period": float(period or 5), "amp": float(amp),
                               "mid": float(mid), "t0": time.time()}
                self.add_log(f"[网页] {row['name']} 自动仿真：{kind}（周期 {period}s）")
        return True


# ─────────────────────────────────────────────
#  网页调试台
# ─────────────────────────────────────────────
PAGE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>模拟 OPC UA 服务器 · 调试台</title>
<style>
 body{margin:0;background:#0f172a;color:#e2e8f0;font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif}
 header{padding:12px 18px;background:#111c33;border-bottom:1px solid #1e3a5f}
 h1{margin:0;font-size:15px;font-weight:600}
 .sub{color:#94a3b8;font-size:12px;margin-top:4px}
 .wrap{display:flex;gap:14px;padding:14px 18px;align-items:flex-start;flex-wrap:wrap}
 .card{background:#152238;border:1px solid #1e3a5f;border-radius:8px;padding:12px 14px}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #1e3a5f;font-size:12px;white-space:nowrap}
 th{color:#93c5fd;font-weight:600}
 td.mono,code{font-family:Consolas,monospace}
 input[type=text]{background:#0b1526;border:1px solid #2b4a75;color:#e2e8f0;border-radius:4px;padding:3px 6px;width:110px;font-family:Consolas,monospace}
 button{background:#2563eb;border:0;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px}
 button.ghost{background:#334155}
 #log{width:520px;height:430px;overflow:auto;background:#0b1526;border:1px solid #2b4a75;border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap}
 .ro{color:#94a3b8}
 .tag{display:inline-block;background:#1e3a5f;border-radius:3px;padding:0 5px;font-size:11px;color:#93c5fd}
 .ok{color:#4ade80}.warn{color:#fbbf24}
</style></head><body>
<header>
  <h1>模拟 OPC UA 服务器 <span class="tag" id="ep">…</span></h1>
  <div class="sub">节点按 CODESYS 符号写法（<code>ns=4;s=|var|设备名.Application.POU.符号</code>）·
    直接改值 / 开自动仿真 · 右边是通讯日志（客户端写进来的值会标出来）</div>
</header>
<div class="wrap">
  <div class="card">
    <table id="tbl"><thead><tr>
      <th>节点名</th><th>POU</th><th>类型</th><th>当前值</th><th>改值</th><th>写入</th><th>自动仿真</th><th>NodeId</th>
    </tr></thead><tbody></tbody></table>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <b>通讯日志</b>
      <span><span id="stats" class="sub"></span>
      <button class="ghost" onclick="clearLog()">清空</button></span>
    </div>
    <div id="log"></div>
  </div>
</div>
<script>
let last = '';
async function tick(){
  const r = await fetch('/api/state').then(r=>r.json());
  document.getElementById('ep').textContent = r.endpoint;
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = r.vars.map(v=>{
    const ro = !v.writable;
    const val = Array.isArray(v.value) ? v.value.join(', ') : String(v.value);
    return `<tr>
      <td class="mono">${v.name}</td>
      <td>${v.pou}</td>
      <td>${v.ua_type}${v.hmi?' / '+v.hmi:''}${v.array_len?' <span class="tag">数组'+v.array_len+'</span>':''}</td>
      <td class="mono ${ro?'ro':''}">${val}</td>
      <td><input type="text" id="v_${encodeURIComponent(v.key)}" value="${val.replace(/"/g,'&quot;')}" ${ro?'disabled':''}></td>
      <td><button ${ro?'disabled':''} onclick="setv('${v.key.replace(/'/g,"\\'")}')">写入</button>
          ${ro?'<span class="ro">只读</span>':''}</td>
      <td>
        <select id="a_${encodeURIComponent(v.key)}" onchange="setauto('${v.key.replace(/'/g,"\\'")}')">
          <option value="">关</option>
          <option value="sine" ${v.auto==='sine'?'selected':''}>正弦</option>
          <option value="ramp" ${v.auto==='ramp'?'selected':''}>斜坡</option>
          <option value="random" ${v.auto==='random'?'selected':''}>随机</option>
        </select>
        <input type="text" style="width:52px" id="p_${encodeURIComponent(v.key)}" value="${v.auto_period||5}" title="周期(秒)">
      </td>
      <td class="mono ro" style="max-width:330px;overflow:hidden;text-overflow:ellipsis" title="${v.nodeid}">${v.nodeid}</td>
    </tr>`;
  }).join('');
  const txt = r.log.join('\\n');
  if (txt !== last){ last = txt; const el = document.getElementById('log'); el.textContent = txt; el.scrollTop = el.scrollHeight; }
  document.getElementById('stats').textContent = r.users && r.users.length ? ('身份：'+r.users.join(',')+' · ') : '匿名 · ';
}
async function setv(key){
  const el = document.getElementById('v_'+encodeURIComponent(key));
  const r = await fetch('/api/set',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({key, value: el.value})}).then(r=>r.json());
  if (!r.ok) alert('写失败：'+r.error);
  tick();
}
async function setauto(key){
  const kind = document.getElementById('a_'+encodeURIComponent(key)).value;
  const period = document.getElementById('p_'+encodeURIComponent(key)).value;
  await fetch('/api/auto',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({key, kind, period})});
  tick();
}
async function clearLog(){ await fetch('/api/clear-log',{method:'POST'}); last=''; tick(); }
tick(); setInterval(tick, 1000);
</script></body></html>
"""


class WebHandler(BaseHTTPRequestHandler):
    sim = None

    def log_message(self, fmt, *a):                   # noqa: A003
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:                             # noqa: BLE001
            return {}

    def do_GET(self):                                 # noqa: N802
        if self.path in ("/", "/index.html"):
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/state":
            self._json(self.sim.snapshot())
        else:
            self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):                                # noqa: N802
        b = self._body()
        try:
            if self.path == "/api/set":
                v = self.sim.set_value(b.get("key"), b.get("value"))
                return self._json({"ok": True, "value": v})
            if self.path == "/api/auto":
                self.sim.set_auto(b.get("key"), b.get("kind") or "", b.get("period") or 5,
                                  b.get("amp") or 1000, b.get("mid") or 0)
                return self._json({"ok": True})
            if self.path == "/api/clear-log":
                with self.sim.lock:
                    self.sim.log.clear()
                return self._json({"ok": True})
        except Exception as e:                        # noqa: BLE001
            return self._json({"ok": False, "error": str(e)}, 400)
        self._json({"ok": False, "error": "not found"}, 404)


def import_symbol_xml(sim, path, ns=4):
    """按 CODESYS/Invtmatic 导出的「符号配置」XML 建节点 —— 和真机同一个文件。

    现场流程是「CODESYS 里导出符号配置 XML → 设计器里导入这份 XML 生成变量表」，
    模拟器也吃同一个文件，地址（NodeId）才会跟真机一字不差：
        ns=4;s=|var|<设备名>.<应用名>.<POU>.<符号>
    """
    with open(path, "r", encoding="utf-8-sig") as f:
        text = f.read()
    res = parse_symbol_config_xml(text, ns=ns, include_complex=True)
    if not res.get("ok"):
        print(f"[warn] 符号配置 XML 解析失败：{res.get('message')}")
        return 0
    n = 0
    xml_device = res.get("device") or ""
    for node in res["nodes"]:
        pou = node["path"].rsplit(".", 1)[0] if "." in node["path"] else "PLC_PRG"
        # 设备名按模拟器自己的 --device 走：真机上「XML 来自 A 工程、运行时跑的是 B 工程」
        # 恰恰是变量全部读不到的头号原因，模拟器要能重现这种情况（用 --device 换名字即可）
        symbol = node["symbol"]
        if xml_device and sim.device and xml_device != sim.device:
            symbol = symbol.replace(f"|var|{xml_device}.", f"|var|{sim.device}.")
        # 数组：变量表类型是 `int[]`，UA 侧要建成「元素类型 + 一段」；字符串/宽字符串都是 String
        hmi = node.get("hmi_type") or "real"
        is_arr = hmi.endswith("[]")
        elem = (node.get("elem_type") or hmi[:-2]) if is_arr else hmi
        elems = int(node.get("elements") or 0) if is_arr else 0
        vt, dflt = HMI2VT.get(elem, HMI2VT["real"])
        val = dflt
        if elems:
            val = [dflt] * elems
        sim.define(node["name"], elem, pou, val,
                   nodeid=symbol, writable=node["writable"], array_len=elems)
        n += 1
    print(f"[import] 已按符号配置 XML 建了 {n} 个节点"
          f"（设备 {res.get('device')}，应用 {res.get('app')}，ns={ns}）")
    if res.get("skipped"):
        for s in res["skipped"][:5]:
            print(f"        跳过 {s['path']}：{s['why']}")
    return n


def import_csv(sim, path):
    """按变量表 CSV 建节点：名称,类型,地址,初值
    地址列可以写 NodeId（ns=4;s=…）也可以写 CODESYS 符号名（没带 ns= 就当 PLC_PRG 里的符号）"""
    n = 0
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if len(row) < 4 or not row[0].strip() or row[0].strip() == "名称":
                continue
            name, vtype, addr, val = (row[0].strip(), row[1].strip(), row[2].strip(), row[3].strip())
            nodeid, pou = "", "PLC_PRG"
            if addr.startswith("ns="):
                nodeid = addr
                if ".GVL." in addr:
                    pou = "GVL"
            elif addr:
                pou = "GVL" if addr.upper().startswith("GVL.") else "PLC_PRG"
                nodeid = f"|var|{sim.device}.Application.{addr}"
            raw = val
            if vtype.lower() == "bool":
                raw = str(val).strip().lower() in ("1", "true", "on", "yes", "是")
            elif vtype.lower() in ("real", "lreal"):
                raw = float(val or 0)
            elif vtype.lower() in ("int", "uint", "dint", "udint"):
                raw = int(float(val or 0))
            sim.define(name, vtype, pou, raw, nodeid=nodeid)
            n += 1
    print(f"[import] 已按变量表建了 {n} 个节点")
    return n


def port_in_use(port, host="127.0.0.1"):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(0.4)
        s.connect((host, int(port)))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="模拟 OPC UA 服务器 + 网页调试台")
    ap.add_argument("--port", type=int, default=4841,
                    help="OPC UA 端口（默认 4841；真机/CODESYS 默认 4840，本机 4840 常被 OPC UA 发现服务占着）")
    ap.add_argument("--web-port", type=int, default=8898, help="网页调试台端口（默认 8898）")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（局域网联调用 0.0.0.0）")
    ap.add_argument("--device", default=DEFAULT_DEVICE, help="符号里的设备名（|var|<设备名>.Application.…）")
    ap.add_argument("--user", default="", help="打开用户名密码认证（不给就是匿名）")
    ap.add_argument("--password", default="")
    ap.add_argument("--import-csv", default="", help="按变量表 CSV 建节点")
    ap.add_argument("--import-symbol-xml", default="",
                    help="按 CODESYS/Invtmatic 导出的「符号配置」XML 建节点（和真机同一个文件）")
    ap.add_argument("--xml-ns", type=int, default=4, help="XML 导入时用的命名空间序号（CODESYS 一般 4）")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--force", action="store_true", help="端口被占也照常启动（不推荐）")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:                                 # noqa: BLE001
        pass

    busy = [p for p in (args.port, args.web_port) if port_in_use(p)]
    if busy and not args.force:
        print("=" * 60)
        print(f"  [启动失败] 端口已被占用：{', '.join(str(p) for p in busy)}")
        print(f"  · 很可能已经有一个模拟 OPC UA 服务器在跑（调试台 http://127.0.0.1:{args.web_port}/）")
        print("  · 换端口   : python server/opcua_sim.py --port 4842 --web-port 8897")
        print(f"  · 看占用   : netstat -ano | findstr :{busy[0]}")
        print("=" * 60)
        sys.exit(2)

    sim = OpcSim(args.host, args.port, args.device, args.user, args.password)
    # 给了导入文件就按文件建节点（真机那套符号），不再塞默认演示节点 ——
    # 否则「导进来的符号」和「演示节点」混在一起，测地址对不对就看不清了
    imported = 0
    if args.import_symbol_xml:
        try:
            imported = import_symbol_xml(sim, args.import_symbol_xml, args.xml_ns)
        except Exception as e:                        # noqa: BLE001
            print(f"[warn] 导入符号配置 XML 失败：{e}")
    if args.import_csv:
        try:
            imported += import_csv(sim, args.import_csv)
        except Exception as e:                        # noqa: BLE001
            print(f"[warn] 导入 CSV 失败：{e}")
    if not imported:
        sim.define_defaults()
    sim.start()

    WebHandler.sim = sim
    web = ThreadingHTTPServer(("127.0.0.1", args.web_port), WebHandler)
    print("=" * 60)
    print("  模拟 OPC UA 服务器（CODESYS 符号风格）")
    print(f"  端点    : {sim.endpoint}")
    print(f"  身份    : {'用户名密码 ' + args.user if args.user else '匿名'}")
    print(f"  网页调试: http://127.0.0.1:{args.web_port}/   改值 / 自动仿真 / 看通讯日志")
    print(f"  示例    : ns=4;s=|var|{args.device}.Application.PLC_PRG.rSpeed")
    print("  停止    : Ctrl+C")
    print("=" * 60)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{args.web_port}/")).start()
    try:
        web.serve_forever()
    except KeyboardInterrupt:
        print("\n再见。")
    finally:
        sim.stop()


if __name__ == "__main__":
    main()
