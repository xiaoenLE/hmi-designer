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


# 「变量表里没有、但前端说是内部变量」的名字最多留多少个（见 var_write 里的说明）。
# 正常工程就那么几个（脚本临时量），给 2000 是"再怎么乱写也不会把内存吃掉"的余量。
EXTRA_INTERNAL_CAP = 2000


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
    """写一个变量 → (ok, extra)。extra 里带 error 或 internal。

    内部变量（地址留空）：前端写值时带 internal=true 说明它只活在 HMI 里。
    后端表里还没有这个名字时按「HMI 自己的变量」就地收下 —— 不报「未在变量表声明」，
    也永远不碰 PLC：那是给"要发给 PLC 的变量"用的报错，内部变量根本不需要 PLC。
    """
    if not isinstance(name, str) or not name:
        return False, {"error": "missing name"}
    if is_internal and name not in (datasource.get_source().meta() or {}):
        with _source_lock:
            _extra_internal[name] = value
            # ★ V2：给这张表加个上限。
            #   它是"变量表里没有、但前端说是内部变量"的名字 —— 正常就那么几个；
            #   但脚本要是用**算出来的名字**写（hmi.set('_h'+i, v)），这里就会只涨不落。
            #   满了丢最早写入的那批（dict 保持插入顺序），只丢"当前确实不在变量表里"的，
            #   免得把后来加进变量表的名字误删。
            if len(_extra_internal) > EXTRA_INTERNAL_CAP:
                meta = datasource.get_source().meta() or {}
                for dead in [k for k in list(_extra_internal)
                             if k not in meta][:len(_extra_internal) - EXTRA_INTERNAL_CAP]:
                    _extra_internal.pop(dead, None)
        broadcast({"name": name, "value": value})
        return True, {"internal": True}
    try:
        datasource.get_source().write(name, value)
    except Exception as e:                                         # noqa: BLE001
        # 接真设备后地址写错/通信失败要能看见原因，而不是丢一个 500 栈给前端。
        _note_write_error(name, value, e)
        return False, {"error": str(e)}
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
