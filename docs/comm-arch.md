# 通讯协议架构与「加一种协议」指南

> 面向维护者：这里说明 HMI 设计器 v2 的通讯协议是怎么串起来的、后端给前端的契约长什么样，
> 以及**新增一种通讯协议只改哪几个文件**。地址写法的现场细节见
> [ts600-modbus-tcp.md](ts600-modbus-tcp.md)（TS600）与本文第 5 章（前缀对照）。

## 0. 一句话

**协议 = 一个 `server/comm/` 里的对象；前端只展示后端给的目录与校验结果，不写死协议。**

- 目录（有哪些协议、每个协议的前缀/示例/默认地址）：`GET /api/comm/protocols`
- 单个地址（这个写法在当前协议下是什么意思、能不能写）：`POST /api/comm/validate`
- 两个接口都在 `server/core/api.py` 的 `dispatch` 里注册，并且进了 `DEVICE_PATHS`（设备类接口，**免登录**）。
- 老接口 `/api/plc`（`action=parse/profiles/connect/test/orders`）的 JSON 形状不变，内部改为调用新注册表。

## 1. 一条链看全

```
┌──────────────────────────── 前端（只读目录 + 展示结果） ────────────────────────────┐
│ js/editor/toolbar.js            协议下拉（选项来自 /api/comm/protocols）            │
│ js/editor/varAdd.js             新增变量：地址输入 + 红/灰提示                       │
│ js/editor/varsPanel.js          变量表：地址格合成控件                              │
│ js/core/addrCatalog.js          目录缓存（60s）+ 本地 FALLBACK + validate 封装       │
│ js/core/addrInput.js            前缀下拉 + 地址正文 + 提示行（.addr-bad / .addr-msg）│
│ js/api/backend.js               commProtocols() / validateAddr() → RPC              │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │  ws {t:"call"}（同源 RPC，backend.rpc）
┌───────────────────────────────────────▼─────────────────────────────────────────────┐
│ server/core/wsbridge.py           拆 {t:"call"}，转 api.dispatch(method,path,…)      │
│ server/core/api.py                DEVICE_PATHS 免登录；/api/comm/* 两个 handler        │
│        │                                                                             │
│        ├─ server/comm/__init__.py    协议注册表：protocols()/normalize()/get()/…     │
│        │        │                                                                    │
│        │        ├─ modbus_protocol.py   id=modbus  （INVT / Invtmatic 写法）          │
│        │        ├─ ts600_protocol.py    id=ts600   （TS600 元件写法）                │
│        │        └─ opcua_protocol.py    id=opcua   （NodeId 写法）                   │
│        │                                                                             │
│        ├─ server/addr_model.py     地址引擎：parse_address(addr, vtype, write, profile)│
│        │                            PROFILES / _TS_*_ZONES / UnsupportedAddress       │
│        └─ server/core/plcsource.py 采集 source（Modbus 轮询）                         │
│           server/opcua.py          OPC UA source（NodeId 浏览/读写）                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

三层职责，别串位：

| 层 | 文件 | 只干这些 | 不干这些 |
|---|---|---|---|
| 协议对象 | `server/comm/*.py` | 声明 id/名字/comm/地址模型/前缀/示例/默认地址；把 `validate` 转给地址引擎；`make_source` 造采集对象 | 不解析页面、不轮询、不碰 WS |
| 地址引擎 | `server/addr_model.py` | 纯函数解析地址与类型：区域、偏移、字数、位、只读、是否「不属于本模型」 | 不发网络请求，不知道协议名 |
| 源头/链路 | `server/core/plcsource.py`、`server/opcua.py`、`server/core/datasource.py` | 连接、轮询、读写、落盘 `plc.json` | 不判断地址写法对不对（那是地址引擎的事） |

数据流三句话：

1. **目录**：页面加载 → `backend.commProtocols()` → `GET /api/comm/protocols` → 缓存 60s；失败（老后端）→ 前端本地 `FALLBACK` 常量，界面照样能用。
2. **校验**：地址输入框防抖 250ms / blur → `backend.validateAddr({protocol,address,vtype,write})` → `POST /api/comm/validate` → 前端只按返回的 `valid/unsupported/code/writable/message` 上色（红/灰）。
3. **采集**：保存变量 → 后端按 `plc.json` 的 `protocol`+`addr_profile` 取协议对象 → `make_source()` 造 source → 轮询时按 `addr_model` 解出的区域/偏移/字数读寄存器。

> 校验接口是**纯函数**：不连接 PLC、不轮询、无副作用；`protocols` 的 `current` 只反映当前生效链路。

## 2. 新增一种通讯协议：五步

> 目标：**只动 `server/comm/` + 地址引擎注册，外加一份回归测试**；前端一行不改
> （前端菜单/提示/红灰判定全部来自后端目录与校验；唯一的例外是"兼容老后端"的
> `js/core/addrCatalog.js` 里的 `FALLBACK` 常量，仅当新协议也要在没有新接口的老后端上显示时才需要补）。

### 第 1 步：在地址引擎里注册地址模型

`server/addr_model.py`：

1. 在 `PROFILES` 字典里加一行（这是「地址模型」的注册表，和协议名是两回事）：

```python
PROFILES = {
    "invt-modbus-slave": "Invtmatic/INVT Modbus_TCP_Slave（%MW/%MD/%QX/%QW… 写法）",
    "ts600-modbus-tcp": "TS600 系列（D/M/X/Y/S/T/C/R/Z 元件写法）",
    "mymod-v1": "MyMod 系列（A/B 元件写法）",          # ← 新增
}
```

2. 给 `PROFILE_ALIASES` 加上现场可能的别名（`mymod`、`my-mod`…），保证老工程/手写配置也能落到同一个 profile。

3. 在 `parse_address(addr, vtype="", write=None, profile=None)` 的分派处接上新的
   `_parse_mymod(...)`，返回统一的 `Address`：
   `area`（`coil` / `discrete` / `input_reg` / `holding`）、`offset`、`words`、`bit`、`byte`、
   `readonly`、`kind`（元件字母/前缀）。

4. 两种「失败」要分清楚（这是红提示 vs 灰字的分界线）：
   - **`UnsupportedAddress`**（`ValueError` 子类）：写法**不属于**这个模型，比如当前是 TS600 却写 `%MX0.0`。
     → 上层当「内部变量」：不采集、不下发、**不报错、不标红**，只写灰字原因。
   - **普通 `ValueError`**：真错误（认不出的写法、编号越界、类型放不下、X/Y 出现 8/9…）。
     → 红色提示，拦住保存。

### 第 2 步：写 `server/comm/mymod_protocol.py`

继承 `server/comm/base.py` 的 `Protocol`。**走 Modbus TCP 的协议直接继承 `ModbusTcpProtocol`**，
`parse()` / `make_source()` 基类已经写好（持 `_addr_model_lock` 临时切模型 → 解析 → 切回），
新协议只需要填类属性；只有全新传输层才自己实现这两个方法。

```python
from .base import ModbusTcpProtocol     # 全新传输层才继承 Protocol

class MyModProtocol(ModbusTcpProtocol):
    id = "mymod"                    # 对外唯一 id（plc.json 的 protocol 用它）
    name = "MyMod TCP"              # 界面显示名
    comm = "modbus-tcp"             # 传输层：modbus-tcp / opcua / …
    addr_profile = "mymod-v1"       # 指向上一步的地址模型
    kind = "element"                # element（元件写法）| nodeid（OPC UA 那种）
    default_address = "A0"          # 默认/测试地址
    probe_address = "A0"            # 连接测试先读它（留空 = 同 default_address）
    help = "MyMod 元件写法：A 区字元件、B 区位元件；例如 A100 / B10。"
    examples = ("A100", "B10")
    prefixes = (
        {"prefix": "A", "label": "A 区（字元件）", "kind": "word",
         "example": "A100", "types": ["int", "uint", "real", "dint"],
         "writable": True, "note": "16 位元件；32 位类型占 2 个寄存器"},
        {"prefix": "B", "label": "B 区（位元件）", "kind": "bit",
         "example": "B10", "types": ["bool"], "writable": True, "note": ""},
    )
    note = ""                       # 兼容写法补充说明；空串 = info() 不吐这个键
    force_profile = False           # True = 不管配置里的 addr_profile，一律按本协议模型解析

    # 只有全新传输层才需要这两个方法：
    # def parse(self, address, vtype=""): ...        # 地址 → Address；认不出抛 ValueError
    # def make_source(self, cfg, **callbacks): ...   # 返回 PlcSource / OpcUaSource 兼容对象


PROTOCOL = MyModProtocol()          # 注册表 import 时取这个单例
```

约定（照抄现有三个协议即可）：

- **`validate()` 不要覆写**：`base.Protocol.validate()` 已经统一把 `parse()` 的结果翻成冻结契约——
  空 → `empty`、`UnsupportedAddress` → `model`、`ValueError` → `invalid`，合法时
  `writable = Address.writable`（= 非只读）、`prefix = Address.kind`、`address = address_dict(...)`。
  只有 OPC UA 这种「地址根本不是元件写法」的协议才覆写 `validate()`（见 `opcua_protocol.py`）。
  `info()` / `address_dict()` 同样由基类提供。
- `prefixes` 里 `kind` 取值：`word`（字元件）、`bit`（位元件）、`bitword`（位/字双身份，如 T/C）、
  `bits`（位打包，如 `%QW`）、`nodeid`（OPC UA，`prefixes` 直接给 `[]`）。
- `writable: False` 的前缀（如 TS600 的 `X`）只影响 `write=true` 时的 `writable` 字段与前端提示，
  **不影响** `valid`：只读地址仍然合法，只是不能写。
- 编号范围、类型限制、区域偏移全部写进 `addr_model`，协议对象里不要再出现数字表。

### 第 3 步：在注册表里登记

`server/comm/__init__.py`：

```python
from .mymod_protocol import MyModProtocol
from .ts600_protocol import Ts600Protocol
from .modbus_protocol import ModbusProtocol
from .opcua_protocol import OpcUaProtocol

_REGISTRY = [ModbusProtocol(), Ts600Protocol(), OpcUaProtocol(), MyModProtocol()]
_BY_ID = {p.id: p for p in _REGISTRY}
```

- **`_REGISTRY` 的顺序就是协议下拉的顺序**，也是 `protocols()` 的返回顺序。
  （现在固定是 `[modbus, ts600, opcua]`，新增的排最后，别插队打乱用户肌肉记忆。）
- `normalize(raw)` 负责把 `""`/`invt`/`invt-modbus-slave`/`modbus` 归一到 `modbus`，
  `ts`/`ts600`/`ts600_tcp`/`ts600-modbus-tcp`/`modbus_ts` 归一到 `ts600`，`opcua`/`ua`/`opc-ua` 归一到 `opcua`；
  新协议在这里加别名，**不认识就抛 `ValueError`**（`/api/comm/validate` 会把它翻成 HTTP 400）。
- `get(pid)` / `info(pid)` / `validate(pid, address, vtype, write)` / `make_source(pid, cfg, **callbacks)` /
  `default_address(pid)` 这几个函数由 `__init__.py` 统一暴露，`api.py` 与 `datasource.py` 只调这些。

### 第 4 步：接链路（只有需要新传输层时才动）

- 传输层还是 Modbus TCP（只是写法不同）→ **只加协议对象 + 地址模型**，`datasource.py` 的
  `plc_connect` 已经走 `comm.make_source(...)`，落盘键仍是 `protocol` + `addr_profile`。
- 全新传输层（比如串口、EtherNet/IP）→ 还要在 `server/comm/` 里给出 `make_source` 的 source 实现，
  并在 `server/core/datasource.py` 里按 `protocol.comm` 选择轮询器；切换当前生效地址模型时必须持
  `api.py` 里已有的 `_addr_model_lock`（从 `server/core/plcsource.py` 导入），别再起第二把锁。
- **不要**把新协议写进 `api.py` 的 if/else 链，也不要在前端 `switch(protocol)`。

### 第 5 步：补测试与文档

1. `test/_comm_selftest.py` 里加该协议的 validate 矩阵（合法/越界/类型不配/只读各几条）。
2. `test/verify-comm-api.mjs` 是走 HTTP/WS 的黑盒矩阵，新协议至少加「目录里有它」+「合法地址 valid」+「越界 invalid」三条。
3. `tools/suite-map.json` 里给新文件加映射（改的是 `server/comm/**` 就沿用现有规则即可）。
4. 文档：`docs/comm-arch.md` 第 5 章加一行前缀对照；有独立现场文档的（如 TS600）在文末「变更记录」补一行。
5. 跑：`node tools/run-suites.mjs verify-comm-api verify-plc verify-ts600`。

#### 检查清单（照着勾）

- [ ] `addr_model.PROFILES` 有新 profile，`PROFILE_ALIASES` 有常见别名
- [ ] 协议对象 id/name/comm/addr_profile/kind/default_address/probe_address/help/examples/prefixes 都有
- [ ] 写法与模型不匹配 → `UnsupportedAddress`（灰字/内部变量），真错误 → 普通 `ValueError`（红字）
- [ ] `_REGISTRY` 顺序 = 下拉顺序；`normalize` 别名齐；未知 id 抛 `ValueError`
- [ ] `prefixes` 的 `kind`/`writable`/`example` 与实测一致（编号范围、八进制、双字元件要写清楚）
- [ ] 新增传输层才动 `datasource.py`，切模型持 `_addr_model_lock`
- [ ] 自测 + `verify-comm-api` 有该协议的矩阵；文档补前缀对照与变更记录

## 3. 接口一：`GET /api/comm/protocols`（目录）

- 路径：`/api/comm/protocols`，方法 `GET`（`rpc()` 走 WS 的 `{t:"call"}` 同一套）。
- 免登录：在 `api.py` 的 `DEVICE_PATHS` 里（和 `/api/plc` 一样）。
- 无参数。返回：

```json
{
  "ok": true,
  "protocols": [
    {
      "id": "ts600",
      "name": "TS600 TCP",
      "comm": "modbus-tcp",
      "addr_profile": "ts600-modbus-tcp",
      "default_address": "D0",
      "probe_address": "D0",
      "kind": "element",
      "help": "TS600 元件写法：D/R 字元件，M/S/X/Y 位元件，T/C 位字双身份；例如 D100 / M10 / X17。",
      "prefixes": [
        {"prefix": "D", "label": "D 数据寄存器", "kind": "word", "example": "D100",
         "types": ["int", "uint", "real", "dint", "udint", "lreal"], "writable": true,
         "note": "16 位元件；32/64 位类型占连续寄存器"}
      ],
      "examples": ["D100", "M10", "X17", "T5", "C200"]
    }
  ],
  "current": {"protocol": "ts600", "addr_profile": "ts600-modbus-tcp"}
}
```

字段表：

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | bool | 固定 `true` |
| `protocols[]` | array | **顺序固定**：`modbus` → `ts600` → `opcua`（新增的排最后） |
| `protocols[].id` | string | 唯一 id，也是 `plc.json` 里 `protocol` 的取值、`validate` 的入参 |
| `protocols[].name` | string | 界面显示名（下拉文本） |
| `protocols[].comm` | string | 传输层：`modbus-tcp` / `opcua` |
| `protocols[].addr_profile` | string | 地址模型 id（`addr_model.PROFILES` 的键），落盘到 `plc.json` |
| `protocols[].default_address` | string | 默认地址（新建变量/测试地址用它） |
| `protocols[].probe_address` | string | 连接测试先读的地址 |
| `protocols[].kind` | string | `element`（元件写法）\| `nodeid`（OPC UA） |
| `protocols[].help` | string | 一行说明，界面地址提示直接用 |
| `protocols[].prefixes[]` | array | 前缀目录；`kind:"nodeid"` 的协议给 `[]` |
| `prefixes[].prefix` | string | 前缀原文（`D`、`%MW`、`S`） |
| `prefixes[].label` | string | 中文名 |
| `prefixes[].kind` | string | `word` / `bit` / `bitword` / `bits` / `nodeid` |
| `prefixes[].example` | string | 示例地址（前缀下拉拼提示用） |
| `prefixes[].types` | array | 该前缀可配的变量类型（展示用，真校验仍以后端为准） |
| `prefixes[].writable` | bool | 是否可写；`false` = 只读（如 TS600 的 `X`） |
| `prefixes[].note` | string | 补充说明（编号范围、八进制、双字…），可为 `""` |
| `protocols[].examples` | array | 3~5 个典型地址 |
| `protocols[].note` | string | 可选键：兼容写法补充说明（如 TS600 也认 `%MW`/`HR`/纯数字）；没有就不吐这个键 |
| `current.protocol` | string | 当前生效协议 id |
| `current.addr_profile` | string | 当前生效地址模型 |

> TS600 的 `plc.json` 里其实是 `protocol:"modbus"` + `addr_profile:"ts600-modbus-tcp"`；
> 目录里用 `id:"ts600"` 只是「给用户选的三选一」，两者在 `normalize()` 里互认。

## 4. 接口二：`POST /api/comm/validate`（单地址校验）

- 路径：`/api/comm/validate`，方法 `POST`；同样在 `DEVICE_PATHS`（免登录）。
- 请求体（字段都可缺省，缺省即 `""` / 不校验写）：

```json
{"protocol": "ts600", "address": "D100", "vtype": "real", "write": null}
```

| 请求字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `protocol` | string | 是 | 协议 id 或别名（`ts`、`ts600`、`invt`、`opcua`…）；不认识 → HTTP 400 |
| `address` | string | 是 | 地址原文；空串/纯空白 → `valid:false, code:"empty"` |
| `vtype` | string | 否 | 变量类型：`bool`、`int`、`uint`、`real`、`dint`… 影响「这个地址放不放得下」 |
| `write` | bool\|null | 否 | `true` = 这次是要写；`null/false` = 只校验/读 |

### 4.1 合法（含只读地址）

`{"protocol":"ts600","address":"D100","vtype":"real"}` →

```json
{
  "ok": true,
  "valid": true,
  "unsupported": false,
  "code": "",
  "message": "",
  "warning": "",
  "writable": true,
  "protocol": "ts600",
  "addr_profile": "ts600-modbus-tcp",
  "prefix": "D",
  "address": {
    "raw": "D100",
    "area": "holding",
    "area_cn": "保持寄存器",
    "offset": 100,
    "words": 2,
    "words_parsed": 1,
    "bit": null,
    "byte": null,
    "kind": "D",
    "readonly": false
  }
}
```

只读地址（写动作）——`{"protocol":"ts600","address":"X17","vtype":"bool","write":true}`：

```json
{
  "ok": true, "valid": true, "unsupported": false,
  "code": "", "message": "", "warning": "X 是输入元件，只能读，不能写",
  "writable": false, "protocol": "ts600", "addr_profile": "ts600-modbus-tcp",
  "prefix": "X",
  "address": {"raw": "X17", "area": "discrete", "area_cn": "离散输入",
              "offset": 40975, "words": 1, "words_parsed": 1,
              "bit": null, "byte": null, "kind": "X", "readonly": true}
}
```

> 只读 ≠ 非法：`valid` 仍是 `true`，只是 `writable:false` + `warning`。
> 前端据此显示「只能读不能写」，**不标红**。

### 4.2 写法与协议不匹配（内部变量，灰字）

`{"protocol":"ts600","address":"%MX0.0"}` →

```json
{
  "ok": true,
  "valid": false,
  "unsupported": true,
  "code": "model",
  "message": "TS600 没有「%MX0.0」这种写法（没有 %MX/%QX/%QW/%QB/%IX/%IW 字内取位、位打包、输入区地址）；位直接写元件位地址 M10/X17/Y10，寄存器写 D100 或 %MW100。这种变量按内部变量处理，不通讯",
  "warning": "",
  "writable": false,
  "protocol": "ts600",
  "addr_profile": "ts600-modbus-tcp",
  "prefix": "",
  "address": null
}
```

语义（**和报错严格区分**）：

- 变量**允许创建**，只是当「内部变量」：不采集、不下发、不报错、**不标红**。
- 变量表/编辑器显示灰字原因；界面来源文案：`内部变量：<message>`。
- 换回正确协议后自动恢复通讯（地址原文不变）。
- 与「地址留空」的区别：留空是**有意**当内部变量（`code:"empty"`，灰字「留空 = 内部变量（不采集、不下发）」）；
  `model` 是**写错了协议/写法**，提示里带原因和正确写法。

### 4.3 真错误（红色提示）

`{"protocol":"ts600","address":"Y18","vtype":"bool"}`（Y 是八进制，18 合法，`18` 里的 `8`…）→ 看 `code:"invalid"`：

```json
{
  "ok": true, "valid": false, "unsupported": false, "code": "invalid",
  "message": "Y 是 8 进制编码的元件（手册：8 进制编码 BOOL 类型），编号里不能出现 8/9：Y18",
  "warning": "", "writable": false, "protocol": "ts600",
  "addr_profile": "ts600-modbus-tcp", "prefix": "", "address": null
}
```

> `message` 是地址引擎的原始文案（会带地址原文），只给人看；代码/测试按 `code` 判断。

### 4.4 留空

`{"protocol":"ts600","address":""}` →

```json
{
  "ok": true, "valid": false, "unsupported": false, "code": "empty",
  "message": "留空 = 内部变量（不采集、不下发）",
  "warning": "", "writable": false, "protocol": "ts600",
  "addr_profile": "ts600-modbus-tcp", "prefix": "", "address": null
}
```

### 4.5 未知协议（HTTP 400）

`{"protocol":"modbus-rtu","address":"100"}` → **HTTP 400** + `ok:false`：

```json
{
  "ok": false,
  "error": "协议「modbus-rtu」不认识。可选：modbus（Modbus TCP / INVT）、ts600（TS600 TCP）、opcua（OPC UA）"
}
```

> 在页面里走 `backend.rpc()` 时，400 表现为 Promise reject，`err.status === 400`，
> `err.message` 是该 `error` 文案；套件里按状态码断言，不要按文案断言（文案会改）。

### 4.6 响应字段表

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | bool | 业务层是否成功（HTTP 200 时为 `true`；HTTP 400 时为 `false`） |
| `valid` | bool | 地址是否合法（含只读地址，见 4.1；`empty`/`model`/`invalid` 都是 `false`） |
| `unsupported` | bool | `true` = 写法不属于当前协议（内部变量，灰字） |
| `code` | string | `""` \| `"empty"` \| `"model"` \| `"invalid"` |
| `message` | string | 给用户看的说明；`valid:true` 时通常为 `""` |
| `warning` | string | 合法但有提醒（只读地址）；没有则 `""` |
| `writable` | bool | 该地址能不能写；`address:null`（空/`model`/`invalid`）时为 `false` |
| `protocol` | string | 归一后的协议 id（`modbus`/`ts600`/`opcua`） |
| `addr_profile` | string | 归一后的地址模型 id |
| `prefix` | string | 命中的前缀（`D`、`%MW`…）；不合法/无法识别时 `""` |
| `address` | object\|null | 解析结果；不合法时为 `null` |

`address` 子对象：

| 字段 | 类型 | 含义 |
|---|---|---|
| `raw` | string | 地址原文（去首尾空白） |
| `area` | string | `holding` / `coil` / `discrete` / `input_reg` |
| `area_cn` | string | 中文区域名，**短名**：`保持寄存器` / `线圈` / `离散输入` / `输入寄存器`（老接口 `/api/plc` 仍是带括号的长名 `保持寄存器（%MW）`，两套文案别混用） |
| `offset` | int | 协议偏移（0 起；TS600 已加各区基址，如 `R100` → 32868） |
| `words` | int | 这个变量实际占几个寄存器（按 `vtype` 算：`real` 2 个，`lreal` 4 个） |
| `words_parsed` | int | 地址写法本身带的字数（`D100[10]` → 10，`%MW100` → 1）；**后端内部字段，前端别依赖** |
| `bit` | int\|null | 字内位号（`%MX195.0` → 8），整字为 `null` |
| `byte` | int\|null | 字内字节号（`%MB194` → 0） |
| `kind` | string | 命中的元件/前缀类型（`D`/`%MW`） |
| `readonly` | bool | 协议层只读（TS600 的 `X`、INVT 的 `%IX/%IW…`） |

### 4.7 错误码表

| `code` | 颜色 | 变量能建吗 | 含义 | 典型例子 |
|---|---|---|---|---|
| （空） | 正常 | 能 | 合法；看 `writable`/`warning` | `D100`@ts600、`%MW100`@modbus |
| `""` + `writable:false` | 正常（黄/灰提示） | 能 | 地址合法但只读，写动作被拦 | `X17`@ts600 |
| `empty` | 灰 | 能 | 留空 = 内部变量 | `""` |
| `model` | 灰 | 能 | 写法与协议不匹配 = 内部变量 | `%MX0.0`@ts600、`D100`@modbus、`M10`@modbus |
| `invalid` | **红** | **不能**（拦保存） | 真语法/范围/类型错误 | `Y18`、`R20000`@ts600、`D32767`+real、`C200`+int |
| （HTTP 400 `ok:false`） | 红 | 不能 | 协议名不认识 | `modbus-rtu` |

> 判定口诀：**能通讯吗？** 不能 → 是「写错协议」（`model`，灰）还是「地址写错」（`invalid`，红）。
> 灰字永远不拦保存，红字永远拦保存。

### 4.8 老接口兼容

`/api/plc` 的 `action=parse` 形状**保持不变**（`area`/`area_cn`/`offset`/`words`/`bit`/`byte`/
`readonly`/`kind`/`profile`/`words_for_type`/`unsupported`/`message`），内部改为调用
`comm.validate(...)` 后拼回旧字段。老的编辑器代码、外部脚本、`test/verify-plc.mjs` 都不用改。

## 5. TS600 / INVT 前缀对照（实测值）

> 下表由 `server/addr_model.py` 实跑得到，**改了地址引擎请同步这张表**。
> 写法细节、报文样例、现场排错见 [ts600-modbus-tcp.md](ts600-modbus-tcp.md)。

### 5.1 TS600（`protocol:"ts600"` / `addr_profile:"ts600-modbus-tcp"`）

| 前缀 | 元件 | 类别 | 协议区 | 协议偏移 | 编号范围 | 读写 | 可用类型 |
|---|---|---|---|---|---|---|---|
| `D` | 数据寄存器 | 字 | `holding` | `0x0000 + n` | D0~D32767 | 读/写 | 16 位（int/uint）、32 位（real/dint/udint…）、64 位（lreal/lint…）、string[n] |
| `R` | 扩展寄存器 | 字 | `holding` | `0x8000 + n` | R0~R16383 | 读/写 | 同上（R16384 以上未映射 → invalid） |
| `Z` | 变址寄存器 | 字 | `holding` | `0xE400 + n` | Z0~Z15 | 读/写 | 16 位（int/uint） |
| `M` | 辅助继电器 | 位 | `coil` | `0x0000 + n` | M0~M32767 | 读/写 | bool |
| `S` | 特殊继电器 | 位 | `coil` | `0x8000 + n` | S0~S4095 | 读/写 | bool |
| `X` | 输入 | 位 | `discrete` | `0xA000 + n` | X0~X1777（**八进制**） | **只读** | bool |
| `Y` | 输出 | 位 | `coil` | `0xB000 + n` | Y0~Y1777（**八进制**） | 读/写 | bool |
| `T` | 定时器 | 位/字 | `coil` / `holding` | bool：触点 `0xC000 + n`；数值：当前值 `0xE000 + n` | T0~T399 | 读/写 | **bool = 触点（位元件，可写）；int/uint = 16 位当前值（字元件）**；不能放 real |
| `C` | 计数器 | 位/字 | `coil` / `holding` | bool：触点 `0xC200 + n`；16 位当前值 `0xE200 + n`；32 位当前值 `0xE2C8 + (n-200)×2` | C0~C255 | 读/写 | **bool = 触点（位元件，C200~C255 也在位元件区）；C0~C199 的数值 = int/uint；C200~C255 的数值 = 双字（dint/udint/real）** |

要点：

- **`+0x8000` 等基址是协议规定的"区号"**，不是页偏移；`R100` 的 `offset` 是 32868 而不是 100。
- `X` 只读：`write=true` 时返回 `valid:true, writable:false, warning:"X 是输入元件，只能读，不能写"`。
- `X`/`Y` **八进制**：编号里出现 `8`/`9` 直接 `invalid`（`X17` = 八进制 15 → `0xA000+15`）。
- `T`/`C` 是**位字双身份**：同一编号配 bool 是触点（线圈区），配数值是当前值（寄存器区）；
  `C200` 配 `int` 会 `invalid`（32 位双字计数器只能用 dint/udint/real）。
- TS600 下仍可用兼容写法：`%MWn`/`%Wn`（= holding n）、`%MDn`（= holding 2n 起 2 字）、
  `HRn`/`4xn`/纯数字（= holding n）。其它 `%…`（`%MX`/`%QX`/`%QW`/`%QB`/`%QD`/`%IX`/`%IW`/`%IB`/`%ID`/`%Mnnn`/`%MBnnn`）
  → `model`（内部变量，灰字）。

> **同一地址 `Tx`/`Cx` 的含义由变量类型决定，不由地址字面决定**（实测矩阵，`/api/comm/validate` 同一地址换 `vtype` 结果就变）：
> `T5` 配 `bool` → 触点线圈 `coil 49157`（`0xC000+5`，可写），配 `int` → 16 位当前值 `holding 57349`（`0xE000+5`）；
> `C5` 配 `bool` → 触点线圈 `coil 49669`（`0xC200+5`，可写），配 `int` → 16 位当前值 `holding 57861`（`0xE200+5`）；
> `C200` 配 `bool` → 触点线圈 `coil 49864`（`0xC200+200`，可写），配 `real` → 双字当前值 `holding 58056`（`words:2`）。
> 所以变量类型一改就要重新校验地址（`validate` 必须带 `vtype`），前端也是按这个做的。

### 5.2 INVT / Invtmatic（`protocol:"modbus"` / `addr_profile:"invt-modbus-slave"`）

| 前缀 | 含义 | 协议区 | 协议偏移 | 读写 | 可用类型 |
|---|---|---|---|---|---|
| `%MWn` / `%Wn` / `%Mn` | 保持寄存器 n（`%M` 是 `%MW` 的缩写，**不是位**） | `holding` | `n` | 读/写 | 整字/多字类型 |
| `%MDn` | 保持寄存器双字（`2n` 起 2 个字） | `holding` | `2n`，`words:2` | 读/写 | real/dint/udint… |
| `%MBn` | 保持寄存器字节（`n//2` 起，第 `n%2` 字节） | `holding` | `n//2`，`byte:n%2` | 读/写 | int/uint 的低字节 |
| `%MXn.b` | 保持寄存器字内取位（读改写） | `holding` | `n//2`，`bit:(n%2)*8+b` | 读/写 | bool |
| `%QXn.b` | 输出位 | `coil` | `8n+b` | 读/写 | bool |
| `%QWn` | 输出字拼位（16 位打包） | `coil` | `16n` | 读/写 | int/uint（位打包） |
| `%QBn` | 输出字节拼位（8 位） | `coil` | `8n` | 读/写 | int/uint |
| `%QDn` | 输出双字拼位（32 位） | `coil` | `32n`，`words:2` | 读/写 | dint/udint |
| `%IXn.b` / `%IXn` | 输入位 | `discrete` | `8n+b` | **只读** | bool |
| `%IWn` | 输入寄存器 | `input_reg` | `n` | **只读** | int/uint |
| `%IBn` | 输入寄存器字节 | `input_reg` | `n//2`，`byte:n%2` | **只读** | int/uint |
| `%IDn` | 输入寄存器双字 | `input_reg` | `2n`，`words:2` | **只读** | dint/udint |
| `HRn` / `4xn` / 纯数字 | 保持寄存器 n | `holding` | `n`（`4x0100`→100、`40101`→100） | 读/写 | 整字/多字类型 |

> 目录（`GET /api/comm/protocols`）里 modbus 的 `prefixes` 只列 12 个：`%MW`/`%MD`/`%MB`/`%MX`/`%QW`/`%QB`/`%QD`/`%QX`/`%IX`/`%IW`/`%IB`/`%ID`；
> `%W`/`%M`/`HR`/`4x`/纯数字是**兼容写法**（`info().note` 里说明），不单独摆进目录，但解析器照样认。

> 注意：`%M100` 在 INVT 下是**保持寄存器 100**（`%M` 是 `%MW` 的缩写），老文档里写「内存位」是错的；
> 真正的「位」用 `%MX100.0` 或 `%QXn.b`。TS600 下 `%M` 则完全不可用（`M` 是位元件字母，`%M100` 会被当内部变量）。

### 5.3 同一意图，两种写法

| 意图 | TS600 | INVT / Invtmatic |
|---|---|---|
| 16 位整数 | `D100`（或 `%MW100`） | `%MW100`（或 `100`/`HR100`） |
| 32 位浮点 | `D100`（2 字）/ `C200`（双字计数器） | `%MD100`（`%MW200`+`%MW201`） |
| 位（内部继电器） | `M10` | `%MX10.0`（字内取位）或 `%QX10.0`（输出位） |
| 输入点（只读） | `X17`（八进制） | `%IX0` / `%IX2.1` |
| 输出点 | `Y10`（八进制） | `%QX10.0` / `%QW3`（按字） |
| 定时器当前值 | `T5` 配 int/uint | 由 PLC 程序决定（HMI 侧一般给 `%MW…`） |
| 计数器当前值 | `C150`（16 位）/ `C200`（32 位） | `%MD…` / `%MW…` |

## 6. 兼容性

| 场景 | 行为 |
|---|---|
| **老接口** `/api/plc` | 形状不变；`action=parse/profiles/connect/test/orders` 都还能用，内部改调新注册表 |
| **老工程 `plc.json`** | 只有 `protocol` 没有 `addr_profile` → 按 `normalize(protocol)` 补默认 `addr_profile`；`modbus` → `invt-modbus-slave`，`ts600` → `ts600-modbus-tcp`，`opcua` → 空 |
| **TS600 落盘口径** | `protocol:"modbus"` + `addr_profile:"ts600-modbus-tcp"`；前端三选一里显示成 `ts600`，`normalize()` 两者互认 |
| **工程 `meta.plc`** | 仍写 `protocol:"ts600"`（工程文件语义），后端落盘再归一 |
| **老后端 + 新前端** | `GET /api/comm/protocols` 404/超时 → `backend.commProtocols()` 返回 `null` → 前端用本地 `FALLBACK` 目录；校验退回 `addrMap.parseAddr` 本地判定。界面不白屏，协议下拉仍是老三项 |
| **新后端 + 老前端** | 老前端不调新接口，一切照旧（`/api/plc` 兼容） |
| **OPC UA** | 不受影响：`prefixes: []`、`kind:"nodeid"`；`validate` 对 NodeId 一律给 `valid`（`address` 里 `area` 无意义） |
| **未跑完的两个路径** | `/api/comm/protocols`、`/api/comm/validate` 都进 `DEVICE_PATHS` 免登录；WS 的 `{t:"call"}` 与浏览器同源 fetch 两条路径行为一致 |

## 7. 测试与验收

| 命令 | 覆盖 |
|---|---|
| `python test/_comm_selftest.py` | 后端自测：注册表（3 项顺序/别名/未知协议）、validate 矩阵、老 `action=parse` 兼容、`make_source` 返回 `PlcSource` 且 `addr_profile` 生效 |
| `node tools/run-suites.mjs verify-comm-api` | 黑盒：`/api/comm/protocols` 目录与 `X` 只读；`/api/comm/validate` 的 valid/empty/model/invalid/只读/未知协议 400 |
| `node tools/run-suites.mjs verify-plc verify-ts600` | 老接口回归（`/api/plc` 形状、TS600 运算） |
| `python tools/check-syntax.py` | 全仓语法体检 |

`tools/suite-map.json` 里已登记：`server/comm/**` → `verify-comm-api` + `verify-plc` + `verify-ts600`；
`js/core/addrCatalog.js`、`js/core/addrInput.js` → `verify-addr-form`。

## 8. 常见问题

**Q：为什么校验接口不直接返回「内部变量」布尔值，而用 `unsupported`/`code`？**
A：要区分三种"不通讯"：留空（`empty`）、写错协议（`model`，可改对）、地址真错（`invalid`）。
前端据此上不同颜色，`unsupported` 只是 `model` 的兼容别名，新代码按 `code` 判断。

**Q：地址写法与协议不匹配，是不是「地址错了」？**
A：不是报错。写法与当前协议不匹配（如 TS600 下写 `%MX0.0`、INVT 下写 `D100`）是**内部变量**：
`valid:false, unsupported:true, code:"model"`，前端显示灰字「内部变量：<message>」，**不标红、不拦保存**，
变量照建、不采集不下发，换对协议后自动恢复。只有真正的**语法/范围/类型**错误（`code:"invalid"`，
如 `Y18`、`R20000`、`D32767`+real、`C200`+int）才标红并拦保存。
一句话：**`model` = 灰色内部变量（写法选错协议），`invalid` = 红色真错误（地址本身不成立）**，
别把这两套语义混成一套。

**Q：新增协议要改前端下拉吗？**
A：不用。下拉选项、前缀列表、默认地址全来自 `/api/comm/protocols`；只有"新协议也要在**老后端**上显示"时，
才需要在 `js/core/addrCatalog.js` 的 `FALLBACK` 里补一条（缓存失败兜底用）。

**Q：能同时连两种协议的设备吗？**
A：可以，按 PLC 实例各存各的 `protocol`+`addr_profile`；但**当前生效地址模型**是进程级的一个值，
切换时必须持 `api.py` 的 `_addr_model_lock`（见 `server/core/plcsource.py`），别并发切。

**Q：只读地址为什么 `valid:true`？**
A：只读不是错。`valid` 回答"这个地址存在吗、类型放得下吗"，`writable` 回答"能写吗"。
写只读地址时前端拦在保存/下发前，用 `warning` 提示。
