#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""core — WebHMI 后端的实现（入口是上一级的 server.py）

**改功能先看下面的表，找到文件再动手。** 入口 `server/server.py` 只有 200 行左右
（命令行 + 启动 + 兼容再导出），实现全在这儿 —— 拆之前是一个 3500 行的 server.py，
"改一个功能要在几千行里翻"。

──────────────────────────── 想改什么 → 看哪个文件 ────────────────────────────
  某个 HTTP 接口（比如 /api/plc、/api/project 的存取）    routes.py
  变量读写的行为（内部变量、写失败的原因、下发采集范围）     varapi.py
  设备状态 / 连接管理 / 内存模拟                          datasource.py
  Modbus / OPC UA 的轮询与读写、字序、按页采集的块规划      plcsource.py
  数据源抽象基类                                         sourcebase.py
  推送（SSE / 长连接发什么、发给谁）                       broadcast.py
  长连接收什么、回什么（写值 / 设备状态 / 在线登记）         wsbridge.py
  WebSocket 帧协议（RFC 6455，收发帧本身）                 ../wschannel.py
  HTTP 工具方法 / 来源校验 / 静态页 / SSE / WS 入口          handler.py
  报警记录存档（环形 5MB、去重规则）                       alarmstore.py
  掉电保持变量落盘                                       retain.py
  数据目录 / 存档文件路径                                 paths.py
  这台机器的设置（日志保留天数 / 脚本日志上限）              settings.py
  运行日志（按天轮转、自动清理、控制台同时落盘）              applog.py
  脚本日志（hmi.log 落盘那份）                            scriptlog.py
  登录 / 口令 / 会话 / 登录限流                           auth.py, loginpage.py
  版本清单与「检查更新」                                  versioninfo.py
  「立即更新」（下载 → 覆盖代码 → 自己重启）                updateapply.py
  host 判定 / 端口占用探测                                hostutil.py
  可选依赖 asyncua（OPC UA）的加载                       opcualib.py
──────────────────────────────────────────────────────────────────────────────

依赖方向（**单向，自下而上**；反向依赖会 import 成环，起服务时直接 ImportError）：

    paths / hostutil / settings                      谁都能用
      ↑
    retain / broadcast / opcualib / alarmstore        不依赖业务
      ↑
    applog / scriptlog / auth / loginpage / versioninfo / updateapply
      ↑
    plcsource                      PlcSource + PLC 配置（_plc_cfg）
      ↑
    datasource                     内存模拟 + 当前数据源 + 连接管理 + 设备状态
      ↑
    varapi / wsbridge              变量读写 API / 长连接胶水
      ↑
    handler / routes               HTTP 处理器与路由表（最上层）

两条铁律（拆开之后才有的约束，踩过坑，改之前先看一眼）
──────────────────────────────────────────────────────────
① **会被"换掉"的变量不许直接 import**，必须走访问器。
   `from .datasource import _source` 拿到的是**导入那一刻指向的那个对象**；
   而连/断设备时 `_source` 会被换成另一个对象（MemorySource ↔ PlcSource ↔ OpcUaSource），
   于是换完之后你还指着一个旧对象 —— 表现是"连上 PLC 了但读到的还是内存里那份"，极难查。

     _source          （连/断设备时换对象） → `datasource.get_source()`
     AUTH_ENABLED     （--no-auth 会改）     → `auth.AUTH_ENABLED`
     _apply_running   （更新时置 True）      → `updateapply.is_applying()`
     ALLOW_ANY_ORIGIN （命令行会改）         → `handler.ALLOW_ANY_ORIGIN`

② **只有"往里加/改"的容器可以直接 import** —— dict / list / Lock 本身不会被换对象，
   共享的是同一个对象，改了对谁都可见：
     `_extra_internal`、`_err_seen`、`_clients`、`_ws_clients`、`_source_lock`、`_alarm_lock`

搬家时的三个坑（以后要是再分文件，先看这三条）
──────────────────────────────────────────────
· **`__file__` 的层数会变**：`paths.py` 从 server/ 挪到 core/ 之后，
  `Path(__file__).parent.parent` 指的是 server/ 而不是工程根 —— 前端会全 404、存档也找错地方。
· **模块级"就地调用"要跟着走**：`_load_plc_cfg()` 这种开机就要跑的一句，
  落在哪个文件里就在哪个文件里执行；搬漏了就是"开机不自动连 PLC"。
· **测试会直接改内部全局**：`server._source = FakeSource()` 这类写法在拆分后会**静默失效**
  （只是给 server 模块挂个没人读的影子属性），改用 `datasource.set_source()`。
"""
