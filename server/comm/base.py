#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""base.py — 通讯协议的**基类**（server/comm/ 的最底层）

这一层是干什么的
----------------
以前「一条通讯协议」是散在几处的：地址写法在 addr_model.py、链路在 modbus.py /
plcua.py、建数据源在 core/datasource.py。加一种通讯要改 4 个文件，还容易漏。

现在把「一条协议」收成一个对象：
    · 目录（下拉框/前缀提示）：id/name/comm/addr_profile/default_address/prefixes…
    · 地址解析与校验：parse() / validate()
    · 建数据源：make_source()（**薄适配**，返回 core/plcsource.py 里现成的
      PlcSource / OpcUaSource，不把类搬过来 —— 先解耦入口，链路一行没动）

⚠ 冻结契约：info()/validate() 的字段名是前后端共用的，**改之前先看 task-7 契约**。

地址模型是**进程级全局量**（addr_model.PROFILE）：连接设备、地址校验都要临时切模型，
所以凡「切模型 → 解析 → 切回」的代码必须持有 core/plcsource.py 的 _addr_model_lock
（api._ep_plc 的 test/orders/parse、datasource.plc_connect 共用那一把）。
"""
import os
import sys

# 让 server/ 在 sys.path 上：core/*.py 里 `import modbus` 就是靠这个既有约定。
# comm 既可能被当成顶层包 `comm` 导入（server/ 在 sys.path），也可能被当成
# `server.comm` 导入（工程根在 sys.path），这里补一次，两种写法都能拿到
# **同一个** addr_model / modbus（不会出现两份地址模型全局量）。
_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)

import addr_model                                                    # noqa: E402
import modbus                                                        # noqa: E402
from core.plcsource import PlcSource, _addr_model_lock               # noqa: E402

# 区域中文名（**短名**）：新接口 /api/comm/validate 用。
# 老接口 /api/plc action=parse 仍然返回 addr_model.AREA_CN（"保持寄存器（%MW）"）——
# 现场前端套件依赖那个形状，所以两套文案分开，别混用（改老形状等于改契约）。
AREA_CN = {
    addr_model.COIL: "线圈",
    addr_model.DISCRETE: "离散输入",
    addr_model.INPUT_REG: "输入寄存器",
    addr_model.HOLDING: "保持寄存器",
}


def as_bool(v):
    """请求体里的 write 可能是 true / 1 / "true" / "0" / None —— 统一成 bool"""
    if isinstance(v, str):
        return v.strip().lower() not in ("", "0", "false", "no", "off", "none", "null")
    return bool(v)


def profile_id(raw):
    """地址模型别名 → 正式 id（"ts"/"invt"/"" → "ts600-modbus-tcp"/"invt-modbus-slave"）。

    认不出抛 ValueError（沿用 addr_model 那句「不认识的地址模型 …」）。
    addr_model 没有暴露"只归一、不切换"的公开函数，这里借 set_profile 归一后立刻切回去；
    全程持 _addr_model_lock，不会和「临时切模型解析地址」交叉。
    """
    with _addr_model_lock:
        cur = modbus.get_profile()
        key = modbus.set_profile(raw)
        if key != cur:
            modbus.set_profile(cur)
        return key


class Protocol:
    """一条通讯协议（注册表里的一项）。子类只填类属性 + 实现 parse/make_source。"""

    # ── 目录字段（info() 原样给前端；字段名是前后端冻结的）──
    id = ""               # 协议 id：modbus / ts600 / opcua
    name = ""             # 下拉框显示名
    comm = ""             # 实际链路：modbus-tcp / opcua（前端据此决定填 IP+端口 还是端点）
    addr_profile = ""     # addr_model.PROFILES 的 id；"" = 不用地址模型（OPC UA）
    default_address = ""  # 新变量默认地址 /「测试连接」探活用
    probe_address = ""    # 探活地址（多数协议同 default_address；OPC UA 探端点，留空）
    kind = ""             # 地址类型：element（元件写法）/ nodeid（NodeId）
    help = ""             # 一行中文说明（变量表地址格下面那句提示）
    prefixes = ()         # 地址前缀目录（每项见目录 schema；OPC UA 是空列表）
    examples = ()         # 示例地址
    note = ""             # 兼容写法的补充说明（schema 之外的附加键；空 = 不吐这个键）

    # ── 目录 ──
    def info(self):
        """目录项（/api/comm/protocols 的 protocols[] 就是它的列表）。

        每次调用都新建 dict/list：调用方改一改也不会污染注册表（协议对象是单例）。
        """
        out = {
            "id": self.id,
            "name": self.name,
            "comm": self.comm,
            "addr_profile": self.addr_profile,
            "default_address": str(self.default_address),
            "probe_address": str(self.probe_address or self.default_address),
            "kind": self.kind,
            "help": self.help,
            "prefixes": [dict(p) for p in self.prefixes],
            "examples": [str(x) for x in self.examples],
        }
        if self.note:
            out["note"] = self.note
        return out

    # ── 解析 ──
    def parse(self, address, vtype=""):
        """地址 → 解析结果对象；认不出抛 ValueError。

        写法**不属于本协议**（TS600 下写 %MW100、INVT 下写 D100）抛
        addr_model.UnsupportedAddress（调用方按「内部变量」处理，不报错）。
        """
        raise NotImplementedError

    # ── 校验（/api/comm/validate 的返回形状，冻结契约）──
    def validate(self, address, vtype="", write=None):
        """地址校验：**不抛异常**，把「能不能用 / 为什么不能用 / 能不能写」装进 dict。

        返回（字段名冻结）：
            ok          请求本身成功（协议认识）；恒 True（协议不认识由调用方回 400）
            valid       地址能不能用
            unsupported 写法不属于本协议（前端标灰「内部变量」，不标红）
            code        "" / empty / model / invalid
            message     人话原因
            warning     能用但要注意（例如给只读输入元件配了写）
            writable    这个地址能不能写
            protocol    协议 id
            addr_profile 地址模型 id
            prefix      命中的地址前缀（元件字母 / %MW…；OPC UA 为空）
            address     解析明细（raw/area/area_cn/offset/words/bit/byte/kind/readonly…）
        """
        raw = "" if address is None else str(address)
        text = raw.strip()
        out = {
            "ok": True, "valid": False, "unsupported": False, "code": "", "message": "",
            "warning": "", "writable": False, "protocol": self.id,
            "addr_profile": self.addr_profile, "prefix": "", "address": None,
        }
        if not text:
            # 留空 = 内部变量（HMI 自己维护的值）：前端**不当错误标红**
            out.update(code="empty", message="留空 = 内部变量（不采集、不下发）")
            return out
        try:
            parsed = self.parse(text, vtype=vtype)
        except addr_model.UnsupportedAddress as e:
            out.update(unsupported=True, code="model",
                       message=str(e) or "地址写法不属于这个协议")
            return out
        except ValueError as e:
            out.update(code="invalid", message=str(e) or "地址认不出")
            return out
        out["valid"] = True
        area = str(getattr(parsed, "area", "") or "")
        # 只读：地址模型标的（TS600 的 X）+ **区域本身就是只读的**（离散输入 %IX / 输入寄存器
        # %IW/%IB/%ID 在 Modbus 里只有读功能码 FC02/FC04，写不进去）。
        # ⚠ 只影响 validate 的 writable/warning；老 /api/plc parse 的 readonly 字段仍按
        #   Address.readonly 原样给（那个形状是冻结的，不能拿这个去改）。
        out["writable"] = not (bool(getattr(parsed, "readonly", False))
                               or area in (addr_model.DISCRETE, addr_model.INPUT_REG))
        out["prefix"] = str(getattr(parsed, "kind", "") or "")
        out["address"] = self.address_dict(parsed, text, vtype)
        if as_bool(write) and not out["writable"]:
            out["warning"] = f"{out['prefix'] or '这个元件'} 是输入元件，只能读，不能写"
        return out

    def address_dict(self, parsed, raw="", vtype=""):
        """解析结果 → validate 的 address 子对象（区域/偏移/字数/位/只读…）

        words = **这个变量实际占几个寄存器**（按 vtype 算：real/dint=2、lreal=4…）；
        words_parsed = 地址写法本身带的字数（D100[10] → 10，%MW100 → 1）。
        位/字节/位拼字地址不套 vtype（它们本来就是 1 个字里的东西）。
        """
        area = str(getattr(parsed, "area", "") or "")
        words = int(getattr(parsed, "words", 1) or 1)
        eff = words
        is_bits = bool(getattr(parsed, "bits", 0)) or getattr(parsed, "bit", None) is not None \
            or getattr(parsed, "byte", None) is not None
        if vtype and not is_bits:
            eff = modbus.words_for(vtype, words)
        return {
            "raw": str(getattr(parsed, "raw", "") or raw),
            "area": area,
            "area_cn": AREA_CN.get(area, area),
            "offset": getattr(parsed, "offset", None),
            "words": eff,
            "words_parsed": words,
            "bit": getattr(parsed, "bit", None),
            "byte": getattr(parsed, "byte", None),
            "kind": str(getattr(parsed, "kind", "") or ""),
            "readonly": bool(getattr(parsed, "readonly", False)),
        }

    # ── 建数据源 ──
    def make_source(self, cfg, **callbacks):
        """按这份配置建一个数据源（**薄适配**：返回已有的 PlcSource / OpcUaSource）。"""
        raise NotImplementedError


class ModbusTcpProtocol(Protocol):
    """走 Modbus TCP 链路的协议（modbus / ts600 共用）。

    两者**只有地址模型不同**（INVT 的 %MW/%QX 写法 vs TS600 的元件写法 D100/M10），
    链路、字序、轮询、块合并全是同一套 —— 所以解析/建源放这里，子类只填参数和目录。
    """

    comm = "modbus-tcp"
    kind = "element"

    # 子类置 True = 不管配置里 addr_profile 写什么，一律用本协议的模型。
    # TS600 要 True：协议下拉选「TS600 TCP」就是必须按 TS600 解析（老前端可能还带
    # 着上次的 addr_profile=invt，不能因此把 D100 解析错）。
    force_profile = False

    def parse(self, address, vtype=""):
        # 切到本协议的地址模型再解析、解析完切回：模型是进程级全局量，必须和
        # api 里「临时切模型」共用同一把锁，否则两个请求交叉会拿错模型解析地址
        # （ThreadingHTTPServer 是多线程的）。
        with _addr_model_lock:
            cur = modbus.get_profile()
            switched = cur != self.addr_profile
            if switched:
                modbus.set_profile(self.addr_profile)
            try:
                return modbus.parse_address(address, vtype=vtype)
            finally:
                if switched:
                    modbus.set_profile(cur)

    def make_source(self, cfg, **callbacks):
        cfg = dict(cfg or {})
        with _addr_model_lock:
            raw = (self.addr_profile if self.force_profile
                   else (cfg.get("addr_profile") or self.addr_profile))
            prof = profile_id(raw)         # 不认识的模型 → ValueError（和以前一样给 400）
            if prof != self.addr_profile:
                raise ValueError(
                    f"地址模型 {prof!r} 不属于协议 {self.id!r}（{self.id} 固定用 "
                    f"{self.addr_profile!r}）；要用 {prof} 请把协议改成对应的那一项")
            # 建好源之后调用方**马上** declare(variables)，那一刻 parse_address 必须按
            # 这个模型解析 —— 所以切了就保持，不切回去（连接即定义"当前生效模型"）。
            modbus.set_profile(self.addr_profile)
            return PlcSource(cfg.get("ip"), cfg.get("port", 502), cfg.get("unit", 1),
                             cfg.get("poll_ms", 200), cfg.get("word_order", "cdab"),
                             on_change=callbacks.get("on_change"),
                             on_changes=callbacks.get("on_changes"))
