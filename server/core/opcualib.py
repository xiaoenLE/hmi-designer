#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""opcualib.py — 可选依赖 asyncua 的唯一入口。

OPC UA 靠第三方库 asyncua，**没装也要能让整个后端起得来**（现场机器上不一定装）。
所以「导入成功没有」这件事只在这里判断一次，别的模块一律 `from .opcualib import opcua`：
  · opcua is None      → 没这个模块，前端据此在连接对话框里说清楚「后端没有可用的 asyncua」
  · opcua.AVAILABLE    → 模块在、但内部装配失败（见 opcua.py 自己的 AVAILABLE）
这样"缺包"就只有一个判断点，不会出现某个接口说能用、另一个说不能用。
"""
try:
    import opcua                    # 同目录：OPC UA 客户端（可选依赖 asyncua，见 opcua.py）
except Exception as _e:             # noqa: BLE001  —— 缺包也不能让整个后端起不来
    opcua = None
    print(f"[warn] OPC UA 模块加载失败：{_e}")
