#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""varapi.py — 变量读写的**唯一实现**（HTTP 接口与长连接共用）

（本模块从 server/server.py 拆出来；模块总索引见 core/__init__.py。）

⚠ 两个入口的语义必须完全一致：现场同一条画面上，按钮可能走 HTTP、脚本可能走长连接。
   两边各写一套的话，迟早出现「点按钮能写、脚本写不进」这种查无可查的差异。
"""

from . import datasource
from .broadcast import broadcast
from .datasource import ERR_SEEN_CAP
from .datasource import _err_seen
from .datasource import _extra_internal
from .datasource import _source_lock
from .datasource import _source_status

import time


# ─────────────────────────────────────────────
#  变量读写的**唯一实现**（HTTP 接口与 WebSocket 通道共用）
#  ⚠ 这两个入口的语义必须完全一致：现场同一条画面上，按钮可能走 +HTTP、
#    脚本可能走 WebSocket —— 要是两边各写一套，迟早出现「点按钮能写、脚本写不进」
#    这种查无可查的差异。所以 do_POST 只是薄薄一层包装，逻辑都在这儿。
# ─────────────────────────────────────────────
def read_all_vars() -> dict:
    """全量读一遍（含只活在 HMI 里的内部变量）"""
    vals = datasource.get_source().read_all()
    if _extra_internal:
        for k, v in _extra_internal.items():
            vals.setdefault(k, v)
    return vals



def _err_kind(e):
    """这次写失败是**链路问题**还是**变量/地址问题** —— 回给前端的 `kind` 字段。

    · `'link'` = 设备这一下不通（掉线、socket 超时、连不上、OPC UA 没连上、
      等应答超时）→ 前端立刻把这条链路判成断开，**停止继续下发**，
      并把界面上那条「下发失败」提示压成一条（不再一个变量弹一次）。
    · `'var'`  = 地址无效 / 写到只读区 / 节点被服务器拒 / 变量没在变量表声明
      → 换个写法就好，设备本身好好的，不影响后面的下发。

    ⚠ **必须由后端给**，不能让前端去猜异常文本（"timed out"、"连不上"…）：
      文本是给现场看的人话，措辞一改前端的判断就悄悄失效了 —— 而这条判断决定了
      "断开之后要不要继续往设备发"，猜错的代价是一串超时排队（现场踩过）。

    ⚠ 顺序要紧：**先问异常自己**（`kind` 属性）。ModbusError 自己知道这次是链路还是
      请求本身有问题（`transport` 标记）—— 漏掉它的话，"写到只读输入区 %IX" 这种
      纯业务错误会掉到最后的兜底分支，被判成"链路断了"：前端于是把设备标掉线、
      顶部挂出「PLC 已断开」、后面 1.5 秒的正经写全被挡（实测踩过）。
    """
    k = getattr(e, "kind", None)                 # ModbusError 自带（'link' / 'var'）
    if k in ("link", "var"):
        return k
    if getattr(e, "transport", False) or getattr(e, "device_offline", False):
        return "link"
    if isinstance(e, ValueError):
        return "var"                             # 地址无效 / 没在变量表声明 / OPC UA 拒写
    # 认不出来的：按链路处理 —— 未知故障连着重发只会把队列越堆越长，先停下来更安全
    return "link"


def _note_write_error(name, value, e):
    """写失败往控制台报一句 —— 同一个变量 10 秒内只报一次。

    ⚠ 键只按**变量名**算，绝不把异常文本掺进来（以前是 f"{name}|{e}"）：
      异常文本里带**每次都变**的东西 —— Modbus 的「事务号不匹配（发 12 收 13）」、
      带端口/时间的通信失败文本 —— 于是设备一断，每次写失败都算"新的一条"，
      这张表只加不减，跑一晚上就是几十万条键（现场"断开时内存涨得更快"就有它一份）。
    """
    now = time.time()
    if now - _err_seen.get(name, 0) <= 10:
        return
    if len(_err_seen) >= ERR_SEEN_CAP:
        cut = now - 600
        for k in [k for k, t in _err_seen.items() if t < cut][:ERR_SEEN_CAP // 2]:
            _err_seen.pop(k, None)
        if len(_err_seen) >= ERR_SEEN_CAP:       # 都很新（一堆变量一起坏）：丢最早的一半
            for k in list(_err_seen)[:ERR_SEEN_CAP // 2]:
                _err_seen.pop(k, None)
    _err_seen[name] = now
    print(f"[error] 写变量失败 {name}={value!r}: {e}")



def var_write(name, value, is_internal=False, from_script=False):
    """写一个变量 → (ok, extra)。extra 里带 error / internal / kind。

    内部变量（地址留空）：前端写值时带 internal=true 说明它只活在 HMI 里。
    后端表里还没有这个名字时按「HMI 自己的变量」就地收下 —— 不报「未在变量表声明」，
    也永远不碰 PLC：那是给"要发给 PLC 的变量"用的报错，内部变量根本不需要 PLC。

    ⚠ **内部变量一个字节都不往设备发**（Modbus TCP / OPC UA 都不发），值只存在后端内存
      （勾了「保持」的落盘）。这是"地址留空 = 内部变量"这条口径的执行点，
      两侧数据源（PlcSource / OpcUaSource）里也各有一道同样按**地址**判的兜底。
    """
    if not isinstance(name, str) or not name:
        return False, {"error": "missing name"}
    if is_internal and name not in (datasource.get_source().meta() or {}):
        with _source_lock:
            _extra_internal[name] = value
        broadcast({"name": name, "value": value})
        return True, {"internal": True}
    try:
        datasource.get_source().write(name, value)
    except Exception as e:                                         # noqa: BLE001
        # 接真设备后地址写错/通信失败要能看见原因，而不是丢一个 500 栈给前端。
        _note_write_error(name, value, e)
        return False, {"error": str(e), "kind": _err_kind(e)}
    broadcast({"name": name, "value": value})
    if not from_script:
        print(f"[var] {name} = {value!r}")
    return True, {}



def var_declare(variables, active):
    """下发变量表 / 只改采集范围 → (ok, extra)。

    · variables 给了 = 整表下发（含地址映射）；
    · variables 为 None = **只改采集范围、不动变量表**：编辑器切页面时只想问一句
      「这一页会采几个变量/几块」，这时绝不能拿编辑器那份变量表去覆盖后端 ——
      后端这份表可能是另一份工程（另一个标签页/现场运行页）正在用的。
    """
    if variables is not None and not isinstance(variables, list):
        return False, {"error": "variables must be a list"}
    if active is not None and not isinstance(active, list):
        return False, {"error": "active must be a list"}
    if variables is None:
        if hasattr(datasource.get_source(), "set_active"):
            datasource.get_source().set_active(active)
    elif hasattr(datasource.get_source(), "declare"):
        datasource.get_source().declare(variables, active)
    st = _source_status()
    # blocks 要用「刚规划出来的」数：status 里那份是上一轮轮询留下的，会差一拍
    blocks = datasource.get_source().plan_count() if hasattr(datasource.get_source(), "plan_count") else st.get("blocks")
    return True, {"vars": datasource.get_source().read_all(), "active": st.get("active"),
                  "blocks": blocks, "scoped": st.get("scoped")}
