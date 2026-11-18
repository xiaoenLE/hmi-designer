# AI 助手（对话式组态）设计与接口契约

> 状态：v2.2 **已实现**（后端 `server/core/ai.py` + 前端 `ai.js`/`aiTools.js`/`aiTranslate.js`/`aiPanel.js`；四套回归：backend 66 / e2e 26 / modules 135 / panel 115）。目标：编辑器窗口**最右边**一条固定侧栏，用自然语言完成
> **新建页面 / 画控件 / 加变量 / 写脚本 / 全工程翻译**，改动可 Ctrl+Z 撤销。
> 模型：小米 MiMo（OpenAI 兼容），`mimo-v2.6-flash`，`https://api.xiaomimimo.com/v1`。

## 0. 硬约束

- 只做实现 + 测试：**不打包、不发版、不产生产物**；不 `git commit/push`。
- 后端纯标准库（不得引入第三方依赖）。
- API Key 只存后端 `server/data/ai.json`，前端只拿掩码（`sk-…abcd`）。
- 模型返回的一切文本在写进 DOM 前必须过 `escapeHtml()`。
- AI 的所有工程改动走 `project.*` API（内部 `commit()`），保证一步撤销。

## 1. 架构

```
aiPanel.js (UI, 窗口最右侧固定侧栏 #aiSide)
   ├─ aiTools.js     工具定义 / system prompt / 多轮工具循环（agent loop）
   ├─ aiTranslate.js 全工程翻译（collectEntries → 分批 JSON → 写 dict → 重画）
   └─ ai.js          WS 传输（ai 帧路由 / 流式回调 / 取消）
        └─ backend.js → wsChannel.js → /api/ws
             └─ server/core/ai.py（线程池 + SSE 解析 + 配置读写 + /api/ai/*）
                  └─ MiMo /v1/chat/completions (stream=true, tools)
```

- **agent loop 在前端**（`aiTools.runAssistant`），后端只是"带流式的模型代理"，因此后端代码量小、可用假模型服务端到端测。
- AI 请求跑在**后端工作线程**，绝不占用 WS 读线程（`{t:'call'}` 是同步的，不能用于 AI）。
- `features` 增加 `"ai"`：前端 `backend.supports('ai')` 判断后端是否支持，不支持时面板显示提示。

## 2. 配置

文件 `server/data/ai.json`（`paths.DATA_DIR` 下，由 `ai.py` 自管，不进 settings.json、不进工程）：

```jsonc
{
  "enabled": true,
  "active": "p_1a2b3c4d5e",          // 当前用哪个服务商（profiles 里的 id）
  "profiles": [                       // 已保存的服务商（下拉切换；api_key 明文只在这里，接口永远只给掩码）
    { "id": "p_1a2b3c4d5e", "name": "小米 MiMo",
      "base_url": "https://api.xiaomimimo.com/v1", "model": "mimo-v2.6-flash",
      "api_key": "sk-...", "temperature": 0.2, "max_tokens": 4000,
      "thinking": "disabled", "timeout": 90, "max_rounds": 0, "budget_tokens": 60000 }
  ],
  // 顶层字段 = 当前服务商的镜像（老代码/老配置只看顶层，保持兼容）
  "base_url": "https://api.xiaomimimo.com/v1", "model": "mimo-v2.6-flash", "api_key": "sk-..."
}
```

- **服务商（profiles）**：`_profiles_of / _active_profile / _profile_id`（`"p_" + sha1(base_url|model)[:10]`，同地址同模型视为同一个服务商，重复保存只更新不新增）/ `_sync_top(raw, prof)`（把命中的那条镜像回顶层）/ `_profile_label`（已知厂商给中文名：小米 MiMo / OpenAI / DeepSeek / 智谱 GLM / 通义千问 / Kimi，本机给「本机 LM Studio / Ollama」，其它 `host · model`）。
- POST `/api/ai/config` 的三种特殊 body：`{"select_profile": id}` = 切换（只把它的字段镜像回顶层，**Key 沿用，不用重填**）；`{"profile_id": id, ...字段}` = 改指定那条；`{"delete_profile": id}` = 删一条（删的是当前就回退到剩下第一条）。都不带 = 按 `base_url+model` 更新当前那条（没有就新建）。
- GET 返回的 `cfg` 里多了 `active` 和 `profiles:[{id,name,base_url,model,temperature,max_tokens,thinking,timeout,max_rounds,budget_tokens,api_key_masked,has_key}]`（**没有任何明文 key**）。

- 环境变量兜底（读优先：文件 > 环境变量 > 默认）：`HMI_AI_KEY`、`HMI_AI_BASE_URL`、`HMI_AI_MODEL`、`HMI_AI_ENABLED`。
- `api_key` 写入接口是**只写**：POST 时 `api_key` 为空/`"__keep__"` 表示不改；读取时一律掩码 `sk-****abcd`（保留前 3 后 4）。
- `thinking`：`"disabled"`（默认，实测最快）/ `"auto"`（不传 thinking 参数）。
- 设置对话框里 `最大 tokens` / `输入预算` 两个字段**按 k token 填**（1k = 1000 token）：显示时 `max_tokens/1000`（4000 → `4`）、`budget_tokens/1000`（60000 → `60`），保存时 `Math.round(值*1000)`；`输入预算` 填 `0` 仍是"不限制"。
- 数值夹取（尽量不限制，只有明显非法的值才夹）：`temperature` 0~2、`max_tokens` 64~200000、`timeout` 10~3600、`max_rounds` 0~9999 —— **`max_rounds: 0` = 不限制工具批次**（默认 0）。注意语义：**工具调用不算对话轮次**，对话轮次本来就不限；这个值只当"一次提问里工具批次"的保险，防模型一直反复调工具。
- ⚠ 改了 `server/core/ai.py` 的夹取范围/默认值后必须**重启设计器服务**才生效（前端只 Ctrl+F5 不够）；否则保存时仍按旧边界夹（典型现象：填 0 变 1、填 100 变 20）。面板会把后端返回的 cfg 和提交值比对，不一致时状态栏提示"超出允许范围，后端按边界值修正"。

### HTTP 接口（走 WS `{t:'call'}`，管理员）

| 路径 | 方法 | body | 返回 |
|---|---|---|---|
| `/api/ai/config` | GET | — | `{ok, cfg:{enabled,base_url,model,api_key_masked,temperature,max_tokens,thinking,timeout,max_rounds,has_key}}` |
| `/api/ai/config` | POST | 上面 cfg 的子集（可含 `api_key` 明文），或 `{select_profile}` / `{profile_id,…}` / `{delete_profile}` | 同 GET（含 profiles/active） |
| `/api/ai/test` | POST | — （用已存配置发一条极短 chat，`max_tokens:64`） | `{ok, latency_ms, model, reply_chars?, code?, error?}` —— 地址少 `/v1`（服务端 200 回 error JSON）或模型没吐字时 `ok:false` 并给可执行提示 |

三个路径加进 `api.py` 的 `ADMIN_PATHS`。实现写在 `ai.py`：`ep_config(method, body) -> (status, dict)`、`ep_test(body) -> (status, dict)`，`api.dispatch` 里转调。

## 3. WS 协议（新增帧，写进 README 协议段）

客户端 → 服务端：

```js
{ t:'ai', op:'chat', id:'ai_7', body:{ messages:[{role,content}], tools?, tool_choice?, temperature?, max_tokens?, response_format?, thinking? } }
{ t:'ai', op:'cancel', id:'ai_7' }
```

服务端 → 客户端（都带 `t` 与 `id`；帧不进 `ack` 通道）：

```js
{ t:'ai_delta', id, text?, reasoning? }              // 流式增量，content / reasoning_content 分开
{ t:'ai_tool',  id, calls:[{ id, name, arguments }] } // 工具调用（arguments 是 JSON 字符串），全部收齐后发一次
{ t:'ai_done',  id, finish_reason, content, usage:{prompt_tokens,cached_tokens,completion_tokens}, elapsed_ms }
{ t:'ai_error', id, message, code? }                  // code: 'forbidden'|'no_key'|'http'|'timeout'|'network'|'cancel'
```

- `hello` 增加 `ai:{enabled, model, has_key}`（仅在 `"ai" in SERVER_FEATURES` 时）。
- 权限：只有 `conn_role(conn)==='admin'` 能用 ai 帧与 `/api/ai/*`；否则 `ai_error` + `code:'forbidden'`。
- 并发：单连接同时最多 2 个会话、全局最多 8 个；超了 `ai_error code:'busy'`。
- 后端 `wsbridge._ws_dispatch`：在 `t=='call'` 分支之前加 `if t == 'ai': ai.handle(conn, msg); return`（`ai.handle` 内部起线程立即返回）。
- 广播事件走 `broadcast` 模块？不需要：流式帧点对点发给发起连接。

## 4. 后端 `server/core/ai.py`

依赖只允许：`json os re threading time urllib.request urllib.error uuid` + `core.paths`（+ `core.versioninfo` 不需要）。
不 import wsbridge（避免环）：wsbridge 调 `ai.handle(conn, msg)`，ai 只用 `conn.send(dict)` / `conn.role`。

公开函数：

```python
AI_FILE = paths.DATA_DIR / "ai.json"
DEFAULTS = {...}                       # 同 §2
def load_cfg() -> dict                 # 合并默认值 + 文件 + 环境变量；文件坏不抛
def save_cfg(patch: dict) -> (dict, str|None)   # 白名单 + 夹取 + 原子写(.tmp→os.replace) + 锁
def public_cfg() -> dict               # 掩码后的
def brief() -> dict                    # hello 用 {enabled, model, has_key}
def ep_config(method: str, body: dict) -> (int, dict)
def ep_test(body: dict) -> (int, dict)
def handle(conn, msg) -> bool          # 处理 {t:'ai'}；True=已处理
```

调用模型（`_post_chat(cfg, body, on_event, cancel)`）：

**两个兼容性修（2.2）**：
- **非 SSE 的 error JSON 要当失败**：有些服务（LM Studio 地址少 `/v1`）会回 **HTTP 200 + 一行 `{"error":"Unexpected endpoint or method…"}`**。`_read_stream` 现在统计 `saw_data`，一行 SSE `data:` 都没收到且非 data 行里有 error → 抛 `_AiErr("http", "模型服务返回了错误而不是流式回复：… ｜接口地址可能不对：多数 OpenAI 兼容服务要以 /v1 结尾")`。以前会把这种响应当成"空回复"报成功，`/api/ai/test` 因此误报。
- **流式用量参数**：`payload["stream_options"] = {"include_usage": True}`，但**只在 base_url 不含 `xiaomimimo.com` 时加**（小米实测不需要、多传可能 400；LM Studio / OpenAI / DeepSeek 不加就一直 `↑0 ↓0 tok`）。
- **Qwen3 这类"只认 /no_think"的本机/自建模型**：实测 `thinking:{type:"disabled"}` 会被忽略（1.7B 甚至把 256 token 全花在思考上、正文为空）。`_is_local_thinking_model(cfg)`（非小米地址 且 model 含 `qwen3`/`qwen-3`）命中时，`_post_chat` 会在**请求体里**（不动会话历史）给最后一条 user 消息追加 `\n/no_think`，只在 `thinking != "auto"` 时加；`ep_test` 在 auto 模式下也会给 ping 加 `/no_think`。测试连接另外放宽：只要模型吐过 token（`usage.completion_tokens > 0`）就算连接成功，返回 `note` 解释"只回了思考内容"，不再误报失败。


- `POST {base_url}/chat/completions`，头 `Authorization: Bearer <key>`、`Content-Type: application/json`。
- 请求体：`{model, messages, stream:True, temperature, max_tokens}` + 可选 `tools/tool_choice/response_format`；`thinking=='disabled'` 时加 `"thinking":{"type":"disabled"}`（实测这样才能真关掉思维链）。
- 读 SSE：逐行 `line.decode('utf-8')`，跳过空行/`:` 注释，`data: [DONE]` 结束；`json.loads` 失败的行忽略。
  每块 `choices[0].delta`：`content` 非空 → `on_event(('text', s))`；`reasoning_content` → `('reason', s)`；
  `tool_calls` 按 `index` 累积 `{id,name,arguments}`（id/name 只在首块出现，arguments 分片拼接）。
  `finish_reason` 取最后一次非空值；`usage` 块（`choices:[]`）拿 token 数。
- **缓存命中数**：`usage.prompt_tokens_details.cached_tokens`（OpenAI/小米格式）或 `usage.prompt_cache_hit_tokens`（DeepSeek 格式）→ 汇总成 `usage.cached_tokens` 一起下发。系统提示 + 工具定义是每轮完全相同的前缀，服务商会按 prompt cache 命中价计费；面板据此把用量显示成 `↑8.4k(缓存 7.1k) ↓39 tok`，用户能直接看到"这轮有多少是缓存价"。`cached_tokens` 缺失时面板退回旧样式（`↑ ↓ tok`），不影响任何逻辑。
- 结束后：有工具调用 → 发 `ai_tool`（一次）；再发 `ai_done`（含拼接好的 content）。
- 错误映射：未配 key → `no_key`「未配置 API Key，请在 AI 设置里填写」；HTTP 401/403 → `http`「API Key 无效或无权限」；429 → 「模型服务限流，请稍后再试」；`socket.timeout`/`TimeoutError` → `timeout`「模型服务超时（{timeout}s）」；其他网络错误 → `network` + 原因。
- 取消：`op:'cancel'` 找到同 id 的会话 → `threading.Event.set()`；读循环每次检查，必要时 `resp.close()` 让阻塞读立刻返回；发 `ai_error code:'cancel'`（前端静默）。
- 日志：只在出错时 `print('[ai] ...')`；**不要打印 key、prompt、回复正文**；成功时打 `[ai] model=%s tokens=%s/%s %.1fs`。

## 5. 前端模块

### 5.1 `js/api/wsChannel.js`（已在共享改动里）
`_dispatch` 末尾兜底：未知帧 → `try { this.opts.onEvent?.(j) } catch {}`。`send(obj)` 已存在。

### 5.2 `js/api/backend.js`（小改）
`_ensureChannel()` 里传 `onEvent: (j) => { for (const fn of this._eventFns) try { fn(j); } catch {} }`；新增：

```js
_eventFns: new Set(),
onEvent(fn) { this._eventFns.add(fn); return () => this._eventFns.delete(fn); },
```

### 5.3 `js/api/ai.js`（新）

```js
export const aiClient = {
  available(),                       // backend.supports('ai') && hello.ai?.enabled
  async getConfig(), async saveConfig(patch), async test(),   // → backend.rpc('/api/ai/...')
  chat(body, handlers) -> { id, cancel() },   // handlers: {onDelta({text,reasoning}), onTool(calls), onDone(info), onError(msg)}
  ready(), status,
};
```

- 用 `backend._ensureChannel()` 拿到通道（必要时 `await backend.whenReady()`），**只挂一次** `backend.onEvent`；按 `j.id` 路由到 `_sessions: Map`。
- 发送：`ch.send({t:'ai', op:'chat', id, body})`；取消：`ch.send({t:'ai', op:'cancel', id})`。
- 自设看门狗（`timeout*1000+15000`）→ 超时 `onError('模型长时间无响应')` 并清会话；连接断开（`backend.onEvent` 收不到）靠 wsChannel 重连后会话自然废弃，`chat` 也要在 `bus.on('backend:reconnect')` 时给出 `onError('连接已断开')`。

### 5.4 `js/editor/aiTools.js`（新）

- `export const TOOL_DEFS` — OpenAI `tools` 数组（`[{type:'function', function:{name, description, parameters}}]`）。
- `export function buildSystemPrompt()` — 静态提示词（§6）。
- `export function projectBrief()` — 每轮动态拼：工程名、画布尺寸、页面清单（名称/类型/控件数）、当前页+控件数、选中控件（id/type/名称/位置）、变量数与前 40 个名字、报警数、脚本数、语言表+各语言待翻译条数。
- `export async function runTool(name, args) -> {ok, summary, data?, error?}`。
- `export function runAssistant({text, handlers}) -> {cancel}`：`handlers = {onUser?, onRound, onRoundEnd, onDelta, onToolStart, onToolEnd, onDone, onError}`（`onRoundEnd({round,elapsed_ms,finish_reason,usage})` 每轮结束时回调一次，用于面板显示「第 N 轮 · 用时」）。
  循环：把 `messages[0].content = buildSystemPrompt() + '\n\n' + projectBrief()` 后调 `aiClient.chat({messages, tools:TOOL_DEFS, tool_choice:'auto'})`；
  收到工具调用 → 依次 `runTool` → push `{role:'assistant', tool_calls}` + 每条 `{role:'tool', tool_call_id, content: compactToolMessage(name,result)}` → 下一轮；**对话轮次与工具往返都不受轮次限制**（`cfg.max_rounds <= 0` 就一直循环到模型不再调工具，默认 0）；填正数时只限制"工具批次"，到上限会 `onDone({truncated:true, batch_limit})` 并提示可以再发「继续」。**失败保护**：第一批有工具 `ok:false` 就向 `_conv` 注入 system 纠偏提示（别重复同样参数、**别再猜 id**、先查真实名字、读 error/warnings、换做法），**同类错误连续 3 批**（`FAIL_HINT_AT=1`、`FAIL_STOP_AT=3`）则 `onError(code:"tool")` 停手并给修改建议；错误签名会先归一化（`[0-9a-f]{6,}`、`*_8`/`*_9` 这类 id、`「…」`、数字 → `#`/`「X」`/`N`）再比较，避免"报错里 id 不同 → 每次都当新错误 → 永远不停"的死循环。任意一批全部成功就清零。另：**失败结果不被瘦身砍掉关键信息** —— `compactToolMessage()` 对 `ok:false` 上限放宽到 2200 字且保留 `FAIL_KEEP = [hint,widgets,ids,pages,variables,types,recipes,props,actions,…]`，`get_project` 查页面压成紧凑行 `名称|id|类型|x,y|w×h|p:属性键名`（上限 2400，超了先丢属性键名再限量 16 个）；纠偏 system 提示和停手提示里都会带 `failedFixText()` 抠出来的真实清单。**控件引用 id 与名称都接受**（`findWidgetOn()` 先按 id、再按名称/类型做「去空格+大小写不敏感」匹配；`resolveWidgetRefs()` 供 `update_widget`/`delete_widgets`/`select_widgets` 共用）——模型常把「文本5」这种名称当 id 传，以前会白跑一轮并反复报错；真查不到时错误载荷带这一页**「名称」= id（类型）**的完整清单（`widgets` + `hint`），不用逐个猜。

**省 token（2.2，成本控制）**：接口是无状态的，每轮都要把历史重发一遍，所以历史越胖每轮越贵。三条措施：

1. `compactToolMessage(name, result)`：工具结果进历史前瘦身 —— `get_widget_catalog` 只留 `{type,title,w,h,props:[键名],actions}`（去掉 label/options/defaults/defVal），其它工具超 `TOOL_MSG_MAX=1200` 字只留 `{ok,summary,error,warnings,note:'结果太长已截断'}`；面板显示仍用 `onToolEnd` 的完整结果。
   工具返回值本身也过一道 `slimData()`：字符串 > `SLIM_STR=200` 字截断（图片 dataURL 这类必然超长的直接掐掉）、数组 > `SLIM_ARR=150` 项截断；`t_get_project` 查页面时不再回整页 `props/bindings/actions`，只回控件几何 + `props` 键名数组 + 非空 `bindings`（要看单个控件的属性值传 `widgetId` 单独查），大查询连工程简报也换成轻量版（只留页名/计数，不回 48 个变量明细）。
2. `trimHistory()` 两级压缩：第一级滑动窗口 —— 最近 `KEEP_FULL=8` 条保持原文，更早的 `tool` 内容换成 `OLD_TOOL_STUB` 占位、`assistant` 正文截到 `OLD_TEXT_MAX=500` 字、`system` 截到 400 字；`MAX_HISTORY=400` 仍是硬上限。第二级会话压缩 —— 估算历史字符数 `convChars() > CONV_CHAR_BUDGET=9000` 或消息数 `> CONV_MSG_MAX=40` 时，把更早的整段对话用 `summarizeOlder()` 压成一段「【前情提要】…」文本（用户先后要求 / 已经做过 / 工具调用次数），存进模块变量 `_convSummary`（上限 `SUMMARY_MAX=2600` 字），随下一轮以 `{role:'system', content:_convSummary}` 插在工程简报之后一起发；原文只保留最近 `AGGR_KEEP=6` 条，且裁剪边界会跳过 `role:'tool'` 保证 `assistant(tool_calls)` 与工具结果不被切开。`conversationStats()` 返回 `{messages,chars,summarized}` 便于诊断（面板测试 13 节用它断言压缩确实触发）。
- 重复读取保护（2.2，针对 thinking=disabled 原地打转）：`READ_TOOLS = Set(get_project,get_widget_catalog,list_pages,list_vars,list_scripts,list_alarms,check_script)`；`callSig(name,args) = name + '|' + stableJson(args)`（键排序的稳定序列化）；`runAssistant` 里 `seenReads` 记录本回合已执行过的只读签名，**同参数第二次直接不执行**，回 `{ok:true,duplicate:true,summary:'这个查询本回合已经执行过…'}`（省一次执行 + 省一份大结果进历史）；一整轮全是重复查询则 `dupStreak++` 并注入 system 纠偏（"别再读同样的内容，直接动手改"），`dupStreak >= DUP_STOP_AT(3)` 就 `onError('连续 N 轮都在重复查同一批内容…建议把「思考过程」改成「交给模型(auto）」…', 'tool')` 停手。系统提示【工作方式】第 10 条与【一轮干完】末条都写了"同样参数的查询一次就够"。
3. 输入预算：`cfg.budget_tokens`（默认 60000，0 = 不限）—— 每轮累加 `usage.prompt_tokens`（就是真实输入花费），到量就不再发下一轮，`onDone({truncated:true, budget_limit})`，面板提示"再发一句「继续」会重新给一份预算"。
7. **一轮干完（2.2 追加，省轮数 > 省字符）**：每多一轮 = 整套上下文再付一次钱，所以关键不是"压字符"而是"少轮"。三个机制配合：
   - `t_get_project({page})` 一次返回整页（每个控件的 `{id,type,name,x,y,w,h,z,props:{值},bindings,actions}`），整包上限 12000 字符，超了才把尾部控件降级成属性键名并提示；`detail:"brief"` 强制只给键名。`compactToolMessage` 对页面结果保留属性值，上限 6000 字符（超了先丢属性值再限 30 行）—— 以前是 `名称|id|类型|坐标|尺寸|p:键名`，模型看不到属性值只能逐个控件再查。
   - `t_add_widget({page, items:[{type,x,y,w,h,props,variable,channels,actions,name}]})`：一个调用画完整页（任意类型混合、任意数量、1 步撤销，内部走 `batchCommit`）；`variable`/`channels` 接受字符串（必须已存在）或 `{name,type}` / `[name,type]`（不存在自动 `addVariable()` + `updateVariable()` 并给 warning）。
   - system prompt 的【一轮干完】段给两条模板：新建整页 = `[add_page, add_widget(items:[…]), tidy_layout, inspect_layout]` 同一轮；改造现有页 = `[get_project(page), update_widget×N]` 同一轮；只有"必须先看到真实数据"才分两轮。
   - 回归：`test/verify-ai-modules.mjs` 有"整页一次返回所有控件""整页结果带属性值""整页结果进历史仍保留属性值""detail=brief 只给键名""items 批量画""variable 自动建"等断言（modules 135）。5. **工具按需下发（2.2 追加）**：`pickTools(text, mode)` 按用户这句话的关键词挑工具组（`TOOL_GROUP` = page/widget/vars/scripts/alarms/layout，`BASE_TOOLS` 12 个常驻）；整轮对话内工具集保持不变（放请求最前面，厂商前缀缓存才可能命中）；`cfg.tool_mode === "full"` 时才发全部 27 个。实测：基础集 schema 3.9k 字符、带报警 5.1k、带脚本 5.4k（全量 8.5k）；`buildSystemPrompt()` 2.6k（控件速查只留 `type=中文名`）、`projectBrief()` 0.9k（变量不带地址、只列前 24 个）→ 每轮固定 ≈7.9k 字符 ≈5.9k token（此前 ≈13.4k 字符 ≈10k token，省约 41%）。
6. **注意**：`projectBrief()` / `buildSystemPrompt()` / `TOOL_DEFS` 的体积要回归看（`test/verify-ai-modules.mjs` 第 1 节有 `pick.autoChars < pick.fullChars * 0.75` 断言）；以后加工具或加提示词段落，先想"这是每轮都要付的钱"。4. 工具 schema 瘦身（2.2 追加）：`TOOL_DEFS` 里 27 个工具的参数说明只保留"猜不到的"（枚举值/格式），`x/y/w/h/page/ids` 这类用裸 schema 常量 `S={type:'string'}`、`N={type:'number'}`、`B={type:'boolean'}`、`O={type:'object',additionalProperties:true}`、`STR`、`ANY`，不再每个参数写中文说明。实测（`out/_measure_prompt.mjs` 量 `buildSystemPrompt().length` / `projectBrief().length` / `JSON.stringify(TOOL_DEFS).length`）：工具定义从 **11728 → 8371 字符**；每轮固定开销（系统提示 3361 + 工程简报 339 + 工具定义）从约 15400 → 约 12100 字符（≈ 8.4k → ≈ 6.6k token，省两成多）。注意：改 schema 后 `test/verify-ai-modules.mjs` 会校验每个工具 `description.length > 8`，描述别写太短。

另：`resetConversation()`（面板「清空」）会把历史清零，下一轮输入立刻回到 2k 量级，是最直接的省钱手段。会话历史保存在模块内。
- 工具结果必须**短**：`{ok, summary, data?}`，`data` 里不要塞整页控件（除非 `get_project{page}` 明确要求）。

### 5.5 `js/editor/aiTranslate.js`（新）

```js
export function pendingByLang()               // {langs:[...], counts:{lang:n}, default}
export async function runTranslate({lang, scope:'all'|'page', handlers}) -> {cancel}
export function applyPairs(lang, pairs) -> {filled, skipped, unknown}
```

- 源串：`i18n.collectEntries()`（`js/core/i18n.js`），按 `source` 去重，过滤掉当前语言 `dict[lang]` 里已有非空译文的；`scope:'page'` 只留 `where` 属于当前页的条目。
- 分批（**默认 40 条/批**，`BATCH=40`）调 `aiClient.chat`：system=翻译规范（§6 翻译段），user=`JSON.stringify({lang, items:[{i:1,t:'原文'},…]})`，`response_format:{type:'json_object'}`，temperature 0.2，`max_tokens:8000`（`BATCH_MAX_TOKENS`），不开 tools。**解析出来的条数 < 80% 且这批 >5 条时自动拆两半重试**（`doBatch` 递归），防截断丢条。
- 模型返回支持 `{"1":"译文"}` / `{"items":[{i,t}]}` / `[{i,t}]` / `[{source,translation}]`：按编号映射回 source；未知 key/空值丢弃。
- `applyPairs`：`i18n.addLanguage(code,label)`（不存在才加）→ 直接写 `i18nState().dict[code][src]=val` → **`autofitLang(code)`** → `project.commit('AI 翻译（' + label + '）')` → `i18n.setLang(code)`（触发 `i18n:lang` 重画）。字号调整和译文压进同一个 commit，一次 Ctrl+Z 全撤。
- **译文自适应字号**：`autofitLang(lang,{commit?,label?}) → {checked,shrunk,tooLong,minPx}`。按控件聚合有译文的文本（`collectEntries()` 的 `widgetId`/`sizeKey`），用 off-screen canvas 量宽（`textWidth`/`countLines`/`fitsBox`，行高 1.35、可用宽 `w-10`、高 `h-6`），从该语言当前生效字号往下找**能放下的最大 px**（最小 `MIN_FONT=8`），写 `meta.i18n.wsize[lang]['<控件id>|<字号属性>']`（字号属性优先 `fontSize`，其次 `textSize`/`numberSize`/`valueSize`；译文改短后自动清掉该覆盖）。只改字号，不动控件位置/大小。
- 实测量级（真模型）：21 条 = 1 批 ≈12s；100 条约 3 批 ≈35~40s（看模型排队/速度）。
- 只接受真实存在的 source（防模型幻觉），报告 `unknown` 条数。

### 5.6 `js/editor/aiPanel.js`（新，窗口最右侧固定侧栏 UI）

`export function initAiPanel()`，DOM id 前缀 `ai*`。DOM：`#dockRow` 末尾 `<aside id="aiSide" class="ai-side hidden"><section class="panel" id="panel-ai">…</section></aside>`（**不是 dock 面板**：不进 `PANELS`/`layout.dock`、不进 `.dock-panes`，所以不能被拖拽/停靠/分屏）；侧栏 380px（`min-width:300px; max-width:46vw`），`.ai-side.hidden{display:none}`，`@media(max-width:1024px)` 变右侧抽屉浮层。开关 API：`openAiSide(focus=true)` / `closeAiSide()` / `toggleAiSide()` / `aiSideOpen()`；状态存 `localStorage['hmi-ai-open']`；入口＝工具栏 `#btnAi`（🤖 AI）与「工程 ▾ → AI 助手…」，标题栏 `#aiCloseBtn`（✕）关闭。组成：

1. 头部：**只有一个状态点**（灰=未配置/绿=就绪，悬停看原因）+ `🌐 翻译`、`⚙ 设置`、`🗑 清空`。**不显示模型名、不显示 API Key 状态**（Key 只存后端，前端拿不到明文）。
2. 会话区 `#aiLog`：用户气泡、助手气泡（markdown-lite：`**粗**`、`` `代码` ``、``` 围栏```、`- ` 列表、换行；**先 escapeHtml 再替换**）、工具调用卡片、错误条。
   - **工具调用默认折叠**：一轮 ≥2 个工具（或模型一轮一个、散卡片攒到第 3 个）收成一个 `<details class="ai-tool-group">` 一行摘要「🔧 调用 N 个工具 · 工具名 × 次数 · ✔ 全部成功 / ✖ n 个失败」，点开才看明细；失败自动展开。收起态必须 `.ai-tool-group:not([open]) > .ai-tool-group-body{display:none}`（自带 `display:flex` 会盖掉 `<details>` 的默认隐藏）。
   - **每轮用时（实时）+ token 用量**：`onRound` 时先挂一行「第 N 轮 · 用时 0.0s」并 `setInterval` 200ms 实时刷新（每 tick 把它 `appendChild` 到气泡末尾，跟着流式正文往下走）；`onRoundEnd({round,elapsed_ms,finish_reason,usage})` 时清定时器、定格成「第 N 轮 · 用时 x.xs · ↑输入 ↓输出 tok」（`usage` 来自后端 `ai_done.usage`，`fmtTok` 压缩成 `856 / 2.4k / 1.25M`）；`onDone` 时多轮（rounds>1）追加「⏱ 共 N 轮 · 总用时 x.xs · ↑累计 ↓累计 tok」（面板自己按轮累加，后端 `onDone.usage` 也有累计值可兜底）。每轮另起一个文本容器，保证「上一轮工具卡片 → 下一轮正文」按时间顺序排。
3. 快捷指令条：`翻译整个工程`、`新建一个页面`、`给当前页加一个按钮`、`检查我的脚本`（点击填入输入框）。
4. 输入区：textarea（Enter 发送 / Shift+Enter 换行）+ 发送/停止按钮 + 勾选「允许删除类操作」（默认关）。
5. 设置对话框：`showDialog`（from `js/editor/toolbar.js`）—— 顶部 **服务商下拉 `#aiCfgProvider`**（选项 = `cfg.profiles` 里每条 `名字（模型）` + 「＋ 新增 / 换服务商」）；选中已保存的服务商 → 用它的字段回填表单（**Key 只显示「已保存（掩码），留空不改」，不用重填**），保存时带 `profile_id` 只更新这一条。选「＋ 新增」时出现 `#aiCfgPresets` 预设按钮行（`PROVIDER_PRESETS`：小米 MiMo / LM Studio（本机/局域网）/ OpenAI / DeepSeek / 自定义），点一下把地址和默认模型填好（LM Studio 预设默认 `thinking:'auto'`，因为 Qwen3 这类本机模型常要 `/no_think` 才好使，且地址要自己改成 `http://IP:端口/v1`）。其余字段：base_url、model、api_key（password，占位显示掩码）、temperature、max_tokens(k)、thinking 下拉、timeout、工具批次上限、输入预算(k)、`测试连接`（显示延迟/错误）、保存。保存后 `aiClient.saveConfig` 并 `bus.emit` 刷新状态。
6. 翻译对话框：目标语言（已有语言下拉 + 「新建语言」输入 code/label）、范围（全工程/当前页）、**「自动缩放字号适配」勾选框（`#aiTrAutofit`，默认开）**、`开始翻译`、进度条（`已翻译 n/m`）、`取消`、完成后汇总（写入条数 / 丢弃幻觉 / **自动缩小 N 个控件** / 缩到 8px 仍放不下 M 个）+ `撤销这次翻译` 提示（Ctrl+Z 即可）。

行为约定：发送时若未配置 key → 直接弹设置对话框；执行中禁用发送；工具执行后依赖已有 bus 事件自动刷新（`project.commit` → `project:changed`）；结束 `statusNote('AI 已完成')`；错误 `statusNote(err, 12000)` + 气泡。

## 6. 提示词规范

### 6.1 system prompt 骨架（中文）

1. 身份：你是「HMI 组态设计器」的 AI 助手，帮用户改工程：建页面、画控件、加变量、写脚本、翻译。回答中文、简短、直接办事。
2. 工程模型要点：画布 `meta.canvas` 1024×600；页面类型 `page`（可套公共底 `baseIds`）/`popup`（弹窗）/`base`；控件 `{id,type,name,x,y,w,h,z,props,bindings,actions}`；变量 `{name,type:bool|int|real|string,address}`；报警 `{name,variable,op,value,level}`；脚本 `{name,trig,ms,variable,op,value,code}`；i18n 按原文整句共享译文。
3. **一切改动必须通过工具**完成，不要只说"你可以…"；每次改完用一两句话汇报改了什么。
4. 先查后改：不确定控件类型/属性先 `get_widget_catalog`，改之前 `get_project`/`list_*`。
5. **视觉规范**（2.2 新增，审美靠这段）：8px 栅格；页面安全边距 16；卡片 gap 16 / 内边距 16；字号层级 24/16/14/12（最小 10，同页 ≤4 种）；一页 ≤15 控件；一页 ≤3 类色、总颜色 ≤6；工控色板 `#11283f`（深色条）/`#f7fbff`（条上字）/`#35c8d2`（强调）/`#ffffff`（卡片）/`#d8e2eb`（描边）/`#eaf1f6`（浅底）/`#24518f`（主按钮）/`#173550`（标题）/`#4b657a`（正文）/`#718497`（次要）。
6. **布局配方**（首选路径）：新做一页先 `apply_layout_recipe`（`overview` 总览 / `dashboard` 看板 / `control` 操作，一次铺几十个控件只占 1 步撤销），再改文字/绑变量；局部小改动别硬套整页。
7. **交付前自检**：`tidy_layout` 对齐收边 → `inspect_layout` 自检；报 error（出界/重叠）必须修掉才能说完成，warn 尽量修。
8. 变量纪律：控件绑定的变量必须已在变量表（否则先 `add_vars`）。
9. 脚本纪律：strict、用 `let/const`、**无 async/await/import**、只能用 `hmi.*`；`hmi.set` 会下发 PLC；别写死循环；触发方式选择给建议。
10. 批量：一次画 3~15 个控件；超过 20 个分多次。
11. 删除/覆盖类操作（delete_*）走后端**安全闸门**：面板上「允许删除类操作」没勾时工具会返回 `ok:false`，不要反复重试，直接请用户勾选。
12. 不要编造控件类型；不确定就先查目录。

### 6.2 脚本 prompt 要点（内置在 system prompt）

- `trig`：`init`（进运行态一次）/`interval`（每 ms）/`cycle`（50ms 周期）/`change`（变量变化）/`cond`（条件上升沿）。
- API 清单：`hmi.get/set/has/vars/log/warn/logNo/page/popup/hidePopup/back/alarms/permLevel/can/lock/now/time/sim/fmtTime/project.*` + `hmi.v`（属性写法，打错名字抛错）+ `hmi.g`（跨次暂存，进/退运行态清空）。
- 变量类型收敛按变量表；内部变量地址留空；数组元素 `hmi.set('arrw[3]', v)`。
- 示例给 1~2 条真实写法（interval 正弦、change 边沿）。

### 6.3 翻译 prompt 要点

- 只输出 JSON `{"pairs":[{"k":"…","v":"…"}]}`；
- 保留 `{0}`、`{name}`、`%s`、数字、单位、英文缩写（PLC/HMI/OPC UA）；品牌名不译；界面用词精简（按钮文字不超原文长度 +30%）；
- 同一原文只出现一次；不确定的保留原文；不输出解释。

## 7. 工具清单（最终版，27 个）

| # | 工具 | 参数（必填加粗） | 说明 |
|---|---|---|---|
| 1 | `get_project` | `page?` | 概览；给 page 时附该页完整控件 |
| 2 | `get_widget_catalog` | `type?` | 30 个控件目录（无参=概览，给 type=全属性） |
| 3 | `list_pages` | — | 页面清单 |
| 4 | `add_page` | **name** `type?` `title?` `popupW?` `popupH?` `baseIds?` | 新建页面 |
| 5 | `update_page` | **page** `name?` `title?` `showClose?` `popupW?` `popupH?` `baseIds?` | 改页面 |
| 6 | `delete_page` | **page** **confirm** | 删除页面 |
| 7 | `set_current_page` | **page** | 切到该页编辑 |
| 8 | `add_widget` | **type** `page?` `x?` `y?` `w?` `h?` `name?` `props?` `variable?` `channels?` `actions?` `count?` `layout?` `gap?` | 画控件（count>1 时按 layout=row/col/grid 排） |
| 9 | `update_widget` | `page?` `ids?` `name?` `props?` `x?` `y?` `w?` `h?` `locked?` `variable?` `channels?` `actions?` `all?` | 改控件（选择器：ids / name / all） |
| 10 | `delete_widgets` | `page?` `ids` **confirm** | 删控件 |
| 11 | `select_widgets` | `ids` | 在画布上选中（高亮反馈） |
| 12 | `list_vars` | — | 变量表 |
| 13 | `add_vars` | **vars** `overwrite?` | 批量加变量 |
| 14 | `update_var` | **name** `type?` `address?` `value?` `len?` `retain?` | 改变量 |
| 15 | `delete_vars` | **names** **confirm** | 删变量 |
| 16 | `list_scripts` | — | 脚本清单（不含 code？含 code 前 400 字） |
| 17 | `add_script` | **name** **trig** **code** `ms?` `variable?` `op?` `value?` `enabled?` | 新建脚本 |
| 18 | `update_script` | **id** `…同上任意` | 改脚本 |
| 19 | `delete_script` | **id** **confirm** | 删脚本 |
| 20 | `check_script` | **code** | 语法检查（`new Function('hmi', code)` 只编译不执行）→ `{ok, error?}` |

补充：`list_alarms/add_alarm/update_alarm/delete_alarm` 是第 21~24 个工具（报警也是"全部功能"的一部分），schema 同 `project.addAlarm(patch)`。

视觉/排版三件套（2.2 新增，第 25~27 个工具）：

| # | 工具 | 参数（必填加粗） | 说明 |
|---|---|---|---|
| 25 | `apply_layout_recipe` | **recipe** `page?` `title?` `subtitle?` `tag?` `kpis?` `values?` `units?` | 套版式骨架：`overview` 总览（标题条+左大卡+右入口卡+底部条）/ `dashboard` 看板（标题条+3 KPI 卡+趋势卡+报警卡）/ `control` 操作（标题条+左设备区+右四大按钮+底部状态条）。坐标已按 8px 栅格排好；实现里用 `batchCommit` 把 `project.addWidget` 的多次 commit 合成 **1 步撤销** |
| 26 | `tidy_layout` | `page?` | 全部控件 snap 到 8px、clamp 进画布、同行（y 差 ≤6）对齐、重叠按「下→右→上→左→左上扫描空位」推开；只 `touch`，最后 commit 一次 |
| 27 | `inspect_layout` | `page?` | 只读自检：出界/重叠 = error，没对齐栅格/字号越界/颜色>6/字号>4/控件>18 = warn；**永远 `ok:true`**（信息性工具，模型读 issues 自己修） |

实现注意：`rectHit` 把「完全包含」（卡片底框 vs 卡内控件）判为**不撞**，只有部分相交才算重叠；否则每个卡片都会和卡内控件互相报错。

执行器要点：

- 页面/控件/变量/脚本/报警的查找统一支持 **id 或名字**（`project.pages()` 里按 `name` 或 `id` 匹配；重名取第一个并 warn）。
- `add_widget`：`project.addWidget(type,x,y)` → 再 `project.updateWidgetProp(id,'w',w)` 等；props 合并前用 def 的 `props` 白名单 + `defaults` 过滤未知键（未知键写 warning 返回给模型）。
- `channels`（trend/xyplot 多通道）→ `project.updateWidgetProp(id,'variables',arr)` 或按 def 的变量槽属性；`actions` 原样写 `w.actions` 并补 `trigger:'click'`。
- 每个执行器返回 `{ok, summary, data?, warnings?}`；失败返回 `{ok:false, error}`（不要抛异常，模型要能看到错误并重试）。
- 所有 mutating 工具统一：执行前 `history.begin?` 不需要 —— `project.*` 内部已 commit。
- `delete_*` 与 `update_page{baseIds}` 等破坏性操作先检查面板的「允许删除类操作」开关（`aiTools.setAllowDestructive(bool)`），未开则返回 `{ok:false, error:'已拦截：请让用户勾选「允许删除类操作」'}`。

## 8. 文件改动清单

| 文件 | 谁改 | 内容 |
|---|---|---|
| `server/core/ai.py` | 后端 | 新建，§4 |
| `server/core/wsbridge.py` | 后端 | `_ws_dispatch` 加 `t=='ai'` 分支；`_ws_hello` 加 `ai: ai.brief()` |
| `server/core/api.py` | 后端 | `ADMIN_PATHS` 加 `/api/ai/config`、`/api/ai/test`；`dispatch` 加两条分支 |
| `server/core/versioninfo.py` | 后端 | `SERVER_FEATURES` 加 `"ai"` |
| `js/api/wsChannel.js` | Lead | `_dispatch` 兜底 `onEvent` |
| `js/api/backend.js` | 前端工具 | `onEvent` 注册表 |
| `js/api/ai.js` | 前端工具 | 新建，§5.3 |
| `js/editor/aiTools.js` | 前端工具 | 新建，工具 + prompt + agent loop |
| `js/editor/aiTranslate.js` | 前端工具 | 新建，翻译 |
| `js/editor/aiPanel.js` | 前端 UI | 新建，§5.6 |
| `index.html` | Lead | `#dockRow` 末尾 `<aside id="aiSide">` + `#panel-ai` 搬入（标题栏 `#aiCloseBtn` ✕）+ 工具栏 `#btnAi`（🤖 AI） |
| `css/ai.css` | 前端 UI | 新建，`js/main.js` 里 `<link>`？→ 直接 `<link rel="stylesheet" href="css/ai.css">` 加进 index.html |
| `js/editor/dock.js` | 无改动 | AI 不是 dock 面板（`PANELS`/`HOME`/`showPanel` 均不涉及 AI） |
| `js/editor/main.js` | Lead | import + MODULES 加 `aiPanel`；`import('./editor/aiPanel.js')` |
| `js/editor/menus.js` | Lead | `PANEL_TITLE.ai='AI 助手'` |
| `js/editor/toolbar.js` | Lead | 工程菜单加「AI 助手…」→ `import('./aiPanel.js').then(m=>m.openAiSide())`；工具栏 `#btnAi` 开关 |
| `README.md` | Lead | 帧文档、features、AI 段使用说明 |
| `docs/ai-assistant.md` | Lead | 本文 |

## 9. 测试计划

1. **后端假模型单测**（`test/verify-ai-backend.py`，python + `_wspy.py`）：
   起一个本地假 OpenAI 服务（`test/_fakemimo.py`，`http.server` 输出 SSE），把 `ai.json` 指向它，验证：
   - 流式 text 帧拼装、`ai_done` 内容/usage；tool_calls 分片拼装 → `ai_tool`；
   - 取消（发 chat 后立刻 cancel）→ 不再有新帧、收到 `ai_error code:'cancel'`；
   - 未配 key / 401 / 超时 → 对应 `code`；
   - 非 admin 连接被拒；`/api/ai/config` 读回掩码、写 key 后 `has_key=true`；
   - `GET /api/ai/test` 打到假服务返回 ok。
2. **前端 e2e**（`test/verify-ai-e2e.mjs`，playwright + 假模型）：
   假模型脚本化两轮：第 1 轮返回 `add_page{name:'AI测试页'}` 工具调用，第 2 轮返回文本 "已建好"；
   浏览器里打开 AI 面板 → 输入「建一个测试页」→ 断言：页面出现在 `project.pages()`、聊天区有工具卡片和回复、Ctrl+Z 能撤销、控制台无报错。
3. **前端工具层单测**（`test/verify-ai-modules.mjs`，playwright，不开模型）：`page.evaluate` 直接 `import('/js/editor/aiTools.js')` 调 `runTool()` 逐条验 24 工具的参数校验/破坏性闸门/变量存在性/props 白名单/脚本语法检查/数量守恒；`aiTranslate` 验 `pendingStats/pendingFor/applyPairs`（幻觉 source 丢弃、与原文相同跳过）。
4. **面板 UI**（`test/verify-ai-panel.mjs`，playwright + 假模型，115 项）：固定侧栏默认收起 → 工程菜单 / 工具栏 🤖 AI 开关、`#panel-ai` 在 `#aiSide` 内且不在 `.dock-panes`（不可拖）、聊天/markdown/思考折叠、工具调用折叠组（一轮 5 个工具 / 散卡片攒到第 3 个自动收拢 / 默认收起 / 点开看明细 / 组状态全部成功）、每轮实时用时 + token 用量、停止、**设置对话框：服务商下拉 + 预设按钮（点「小米 MiMo」自动填地址/模型）**、测试连接、翻译对话框写入 `dict.en`、破坏性开关、重复读取保护、历史压缩。
5. **后端单测**（`test/verify-ai-backend.py`，66 项）：含 **profiles 保存/切换（切换后 key 沿用）**、**地址少 `/v1` 时测试连接不再误报**、**非小米地址带 `stream_options.include_usage`**。
5. **回归**：`node tools/run-suites.mjs`（按 `tools/suite-map.json`）；本机 8866 若是**运行态实例**（`document.body.className==='run-only'`）需另起编辑器实例，套件带端口跑，例如 `python server.py --port 8899 --no-browser --no-auth` + `node test/verify-dock.mjs 8899`。

## 10. 后续（不在本期）

- 语音输入（MiMo ASR/TTS 模型已存在）；
- 多会话历史持久化；
- 公共底（baseIds）批量编排、配方/参数表数据填充；
- 截图给模型看（`--mcp-live` 的 CDP 截图能力已有）。
