#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""datasource.py — 内存模拟 + **当前数据源（_source）的家** + 连接管理 + 设备状态

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

⚠ `_source` 会被换成另一个对象（连/断设备时）：别的模块一律用 `get_source()` 读，
   **不要** `from .datasource import _source` —— 那样拿到的是导入那一刻指向的那个对象，
   换完之后还指着旧的（表现是「连上 PLC 了还读内存那份」）。
   测试里要换数据源用 `set_source()`。
"""

from .paths import FLUSH_INTERVAL
from .paths import VARS_FILE
from .plcsource import OpcUaSource
from .plcsource import PlcSource
from .plcsource import _REMOTE_SRC
from .plcsource import _on_plc_change
from .plcsource import _on_plc_changes
from .plcsource import _plc_cfg
from .plcsource import _protocol_of
from .plcsource import _save_plc_cfg
from .retain import _retain
from .sourcebase import DataSource

from .opcualib import opcua
import json
import modbus                     # 同目录：Modbus TCP 主站 + %MW/%MD 地址解析
import poll_gate                  # 同目录：有没有人在看运行画面（没人看就不跟设备通讯）
import threading
import time


class MemorySource(DataSource):
    """内存模拟数据源（当前默认）。
    变量表持久化到 server/data/vars.json，重启后保留。
    落盘合并：写入只标脏，由后台线程每 FLUSH_INTERVAL 秒写一次
    （点动一次 = 按下+松开两次写，逐次全量重写文件在真机上会拖慢响应）。"""

    def __init__(self):
        self._lock = threading.Lock()
        # {name: {"value": ..., "type": ..., "address": ...}}
        self._vars = {}
        self._active = None          # 跟 PlcSource 对齐（内存模式不轮询，只是别让属性缺失）
        self._dirty = False
        if VARS_FILE.exists():
            try:
                self._vars = json.loads(VARS_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass
        # 老档案补齐 internal 标记：**按地址算**（地址留空 = 内部变量）。
        # 不补的话，从旧档案起来的内部变量写值会报「地址 '' 无效：未填写」。
        for rec in self._vars.values():
            if isinstance(rec, dict):
                rec["internal"] = not (rec.get("address") or "").strip()
        threading.Thread(target=self._flush_loop, daemon=True).start()

    def read_all(self):
        with self._lock:
            return {k: v["value"] for k, v in self._vars.items()}

    def read(self, name):
        with self._lock:
            v = self._vars.get(name)
            return None if v is None else v["value"]

    def write(self, name, value):
        with self._lock:
            if name in self._vars:
                self._vars[name]["value"] = value
                keep = bool(self._vars[name].get("retain"))
            else:  # 前端新变量自动建档
                self._vars[name] = {"value": value, "type": type(value).__name__, "address": ""}
                keep = False
            self._dirty = True
        if keep:
            _retain.set(name, value)      # 勾了「保持」的：同时进掉电保持存档
        return True

    def set_active(self, active):
        """只改「本页采集范围」，**不动变量表**（编辑器切页面时问「这一页会采几个变量/几块」用）

        内存模式不轮询，所以这里只是把范围记下来让状态/规划算得出来，不影响任何通讯。
        """
        with self._lock:
            self._active = None if active is None else (set(active) & set(self._vars.keys()))

    def declare(self, variables, active=None):
        """前端连接成功后同步变量表（保留当前值，补齐元数据）

        active 参数这里**用不上**（内存模式不轮询），但签名必须跟 PlcSource 一致：
        以前只收一个参数，前端改成传 (variables, active) 之后，只要没连 PLC（内存模式），
        每次变量表下发都会 TypeError → 连接被直接掐断（浏览器里只看到 ERR_EMPTY_RESPONSE），
        表现就是"改了变量不生效"。签名对齐后这个坑就没了。
        """
        with self._lock:
            for v in variables:
                if not isinstance(v, dict):
                    continue
                name = v.get("name")
                if not name or not isinstance(name, str):
                    continue
                # 「保持」只对**无地址的内部变量**有意义（有地址的变量，保持是 PLC 的事）
                retain = bool(v.get("retain")) and not (v.get("address") or "").strip()
                # 地址留空 = 内部变量：这个标记**必须写进档案**（要和 PlcSource/OpcUaSource 一个口径）。
                # 以前内存模式不写这个键，落盘的 vars.json 里就没有它 —— 之后任何按 internal 判断的
                # 地方（写值、恢复初值）都会把内部变量当成"地址没填好的 PLC 变量"。
                internal = not (v.get("address") or "").strip()
                old = self._vars.get(name) or {}
                if not old:
                    # 第一次见这个变量：勾了保持就用**存档里的值**（上次运行/上次断电前的值），
                    # 没有才回变量表初值 —— 否则重启后每下发一次变量表就把保持值冲掉
                    value = _retain.get(name, v.get("value")) if retain else v.get("value")
                    self._vars[name] = {
                        "value": value,
                        "type": v.get("type", "real"),
                        "address": v.get("address", ""),
                        "internal": internal,
                        # default = 变量表里的初值：运行中把模拟值改乱了，
                        # 「恢复初值」按它还原（见 reset()）
                        "default": v.get("value"),
                        "retain": retain,
                    }
                else:
                    self._vars[name]["type"] = v.get("type", old.get("type"))
                    self._vars[name]["address"] = v.get("address", old.get("address", ""))
                    self._vars[name]["internal"] = internal      # 地址改空/改回来时跟着更新
                    # 变量表里改了初值 → 跟着走（前端每次下发变量表都带着 value 初值）
                    self._vars[name]["default"] = v.get("value")
                    was = bool(old.get("retain"))
                    self._vars[name]["retain"] = retain
                    if was and not retain:
                        # 取消勾选「保持」→ 存盘那份丢掉（不然下次重启它又冒出来）
                        _retain.forget(name)
                    elif retain and not _retain.has(name):
                        _retain.set(name, self._vars[name]["value"])
            self._dirty = True
            if active is not None:
                self._active = set(active) & set(self._vars.keys())

    def reset(self, clear=False):
        """把所有变量恢复成**变量表里的初值**（内存模拟专用）。

        场景：内部变量跑联调时手改了一堆值，或者上一次留下的值（true / 12 之类）
        让这次「改了没反应」—— 一键回到干净状态。接真设备时没有这个方法（不能拿它去盖 PLC）。

        clear=True 更进一步：**整份清空**（变量档案一起丢掉，下次下发变量表按表里的初值重建）。
        自动化测试每跑一个用例前用它，免得上一个用例留下的值让下一个用例的判断失真。
        """
        with self._lock:
            if clear:
                self._vars = {}
                _retain.forget(*list(_retain.all().keys()))
            else:
                for name, rec in self._vars.items():
                    if "default" in rec:
                        rec["value"] = rec["default"]
                        # 勾了「保持」的：重置后的值也写回存档，否则重启又把它带回来
                        if rec.get("retain"):
                            _retain.set(name, rec["value"])
            self._dirty = True
            return {k: v["value"] for k, v in self._vars.items()}

    def meta(self):
        with self._lock:
            return {k: {"address": v.get("address", ""), "type": v.get("type", "")}
                    for k, v in self._vars.items()}

    def flush(self):
        """把脏数据落盘（原子写：先写临时文件再替换，避免断电写坏存档）"""
        with self._lock:
            if not self._dirty:
                return False
            self._dirty = False
            payload = json.dumps(self._vars, ensure_ascii=False, indent=2)
        try:
            tmp = VARS_FILE.with_suffix(".json.tmp")
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(VARS_FILE)
            return True
        except Exception as e:
            print(f"[warn] 变量持久化失败: {e}")
            with self._lock:
                self._dirty = True
            return False

    def _flush_loop(self):
        while True:
            time.sleep(FLUSH_INTERVAL)
            try:
                self.flush()
            except Exception as e:
                print(f"[warn] 落盘线程异常: {e}")



# ─────────────────────────────────────────────
#  真实设备接入预留（示例模板，未启用）
# ─────────────────────────────────────────────
# class ModbusSource(DataSource):
#     """Modbus TCP 数据源（需 pip install pymodbus，然后替换下方 _source）
#
#     变量 → 寄存器地址来自前端变量表的 address 列。写失败要抛异常并把原因带上：
#     HMIServer.do_POST 会把它变成 400 + 文字回给前端（而不是丢一个 500 栈）。
#     """
#     def __init__(self, host="192.168.1.10", port=502):
#         from pymodbus.client import ModbusTcpClient
#         self._cli = ModbusTcpClient(host, port)
#         self._meta = {}          # name -> {"address": "HR100", "type": "real"}
#
#     @staticmethod
#     def parse_address(name, raw):
#         """支持 HR100 / 4x0100 / 40101 三种写法；其它写法直接报错，
#         免得写错地址时静默写到 0 号寄存器上。"""
#         a = (raw or "").strip().upper()
#         if a.startswith("HR"):
#             a = a[2:]
#         elif a.startswith("4X"):
#             a = a[2:]
#         elif a.startswith("4") and a.isdigit() and len(a) > 1:
#             a = a[1:]
#         if not a.isdigit():
#             raise ValueError(f"变量 {name} 的地址 {raw!r} 无法解析（约定 HR100 / 4x0100）")
#         return int(a)
#
#     def write(self, name, value):
#         m = self._meta.get(name)
#         if not m:
#             raise ValueError(f"变量 {name} 未在变量表声明")
#         addr = self.parse_address(name, m.get("address"))
#         if m.get("type") == "bool":
#             r = self._cli.write_coil(addr, bool(value))
#         else:
#             r = self._cli.write_register(addr, int(value))
#         if r.isError():
#             raise IOError(f"Modbus 写 {name}@{m.get('address')} 失败: {r}")
#
#     def read_all(self):
#         ...  # 按地址块轮询保持寄存器/线圈 → 返回 {name: value}
# _source = ModbusSource("192.168.1.10")
_source = MemorySource()          # ← 换成真实数据源只需改这一行

_source_lock = threading.RLock()


# 「内部变量」（地址留空的 HMI 自己的变量）：前端写值时带 internal=true 说明它只活在 HMI 里。
# 如果后端这张表里还没有这个名字（刚新建、或这份后端上正挂着**另一个工程**），
# 就地存下、照常回成功 —— 不该回一句「未在变量表声明」：那是给"要发给 PLC 的变量"用的报错，
# 内部变量根本不需要 PLC，报这个错只会让人以为哪里配错了（现场实测踩过）。
_extra_internal = {}


# 同一个变量 10 秒内只往控制台报一次写失败（脚本每 100ms 写一个坏地址时，
# 不然控制台会被同一句话刷满，真正的问题反而看不见）
#
# ⚠ 键只按**变量名**算，绝不把异常文本掺进来（以前是 f"{name}|{e}"）：
#   异常文本里带**每次都变**的东西 —— Modbus 的「事务号不匹配（发 12 收 13）」、
#   带端口/时间的通信失败文本 —— 于是设备一断，每次写失败都算"新的一条"，
#   这张表只加不减，跑一晚上就是几十万条键（现场"断开时内存涨得更快"就有它一份）。
_err_seen = {}          # {变量名: 上次打印时刻}

ERR_SEEN_CAP = 500      # 表的上限：变量表再大也不该让这张表无限长



def plc_connect(cfg, variables=None):
    """切到真实数据源（先断开旧的）。protocol = modbus / opcua。返回状态字典。"""
    global _source
    proto = _protocol_of(cfg)
    with _source_lock:
        old = _source
        if isinstance(old, _REMOTE_SRC):
            old.stop()
        if proto == "opcua":
            if opcua is None or not opcua.AVAILABLE:
                why = (opcua.IMPORT_ERROR if opcua is not None else "模块加载失败")
                raise ValueError(f"后端没有可用的 asyncua（{why}）—— 装："
                                 f"{opcua.INSTALL_HINT if opcua is not None else ''}")
            src = OpcUaSource(cfg.get("endpoint") or opcua.DEFAULT_ENDPOINT,
                              cfg.get("security", "none"), cfg.get("username", ""),
                              cfg.get("password", ""), cfg.get("poll_ms", 200),
                              default_ns=cfg.get("default_ns", opcua.DEFAULT_NS),
                              on_change=_on_plc_change, on_changes=_on_plc_changes,
                              retain=_retain)   # 内部变量的掉电保持（HMI 自己的，跟 PLC 无关）
        else:
            src = PlcSource(cfg.get("ip"), cfg.get("port", 502), cfg.get("unit", 1),
                            cfg.get("poll_ms", 200), cfg.get("word_order", "cdab"),
                            on_change=_on_plc_change, on_changes=_on_plc_changes)
        if variables:
            src.declare(variables)
        _source = src
        src.start()
        keep = ("protocol", "ip", "port", "unit", "poll_ms", "word_order",
                "endpoint", "security", "username", "password", "default_ns")
        _plc_cfg.update({"mode": "plc", **{k: cfg.get(k, _plc_cfg.get(k)) for k in keep}})
        _plc_cfg["protocol"] = proto
        _save_plc_cfg()
        return src.status()



def _autoconnect_saved_plc():
    """启动时按上次保存的配置自动连设备。

    客户机就是这个用法：管理员配好一次（点确定时配置会存进 server/data/plc.json），
    之后开机只要跑起后端，现场打开 /run 就是连着的真实数据 —— 不用谁去点「连接 PLC」。
    """
    if _protocol_of() == "opcua" or _plc_cfg.get("ip"):
        if str(_plc_cfg.get("mode") or "") != "plc":
            return
        try:
            st = plc_connect(dict(_plc_cfg))
            print(f"[plc] 已按上次的配置自动连接：{_protocol_of()} "
                  f"{_plc_cfg.get('endpoint') if _protocol_of() == 'opcua' else str(_plc_cfg.get('ip')) + ':' + str(_plc_cfg.get('port'))}"
                  f"（在线={st.get('online')}）")
        except Exception as e:                                  # noqa: BLE001
            print(f"[warn] 自动连接设备失败：{e}（现场还能手动登录后在「PLC」里重连）")



def plc_disconnect():
    """切回内存模拟数据源"""
    global _source
    with _source_lock:
        if isinstance(_source, _REMOTE_SRC):
            _source.stop()
        _source = MemorySource()
        _plc_cfg["mode"] = "memory"
        _save_plc_cfg()
        return _source_status()



def _source_status_raw():
    with _source_lock:
        if isinstance(_source, _REMOTE_SRC):
            st = _source.status()
            st.setdefault("protocol", "opcua" if isinstance(_source, OpcUaSource) else "modbus")
            return st
    order = modbus.normalize_order(_plc_cfg.get("word_order"))
    return {"mode": "memory", "protocol": _protocol_of(), "online": True, "vars": len(_source.read_all()),
            "host": "", "port": 0, "unit": 0,
            "poll_ms": _plc_cfg.get("poll_ms", 200),
            "word_order": order, "word_order_cn": modbus.WORD_ORDER_CN.get(order, ""),
            "endpoint": _plc_cfg.get("endpoint", ""), "security": _plc_cfg.get("security", "none"),
            "reads": 0, "writes": 0, "errors": 0, "last_error": "",
            # 内存模式不轮询：这几个键保持和 PLC 模式一致，前端状态栏不用分支处理
            "scoped": False, "active": len(_source.read_all()), "blocks": 0,
            "bad_address": []}



def _source_status():
    """数据源状态 + **现在到底在不在跟设备通讯**（poll_gate：没人看运行画面就不通讯）"""
    st = dict(_source_status_raw())
    st.update(poll_gate.status())          # paused / running_clients / always / idle_s
    return st

# ─────────────────────────────────────────────
#  访问器（拆分时新增，见 core/__init__.py 铁律①）
# ─────────────────────────────────────────────
def get_source():
    """当前数据源（内存模拟 / Modbus PLC / OPC UA）。

    ⚠ **别的模块一律用这个读，不要 `from .datasource import _source`**：
    连/断设备时 `_source` 会被换成**另一个对象**（MemorySource ↔ PlcSource ↔ OpcUaSource），
    直接 import 拿到的是导入那一刻指向的对象，换完就指错了 ——
    表现是"连上 PLC 了但读到的还是内存里那份"，极难查。
    （原来这些代码在同一个文件里，不存在这个问题；拆开之后必须有这道口子。）
    """
    with _source_lock:
        return _source


def set_source(src):
    """换数据源（连/断设备、以及**测试里塞一个假数据源**）。

    本模块内部（plc_connect / plc_disconnect）直接用模块级 `_source` 就行；
    这个函数是给**模块外**用的 —— 尤其是自动化测试：
    以前测试写 `server._source = FakeSource()` 就能替换数据源，拆开之后那么写只会给
    server 模块挂个没人读的影子属性（真正的数据源还在 core.datasource 里），
    测试会静默地"替换失败"（表现是死活拿不到预期的报错）。
    """
    global _source
    with _source_lock:
        _source = src
    return _source
