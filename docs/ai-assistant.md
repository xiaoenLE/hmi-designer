# AI 助手（对话式组态）设计与接口契约

> 网页设计器的 AI 助手支持组态问答、工程操作和批量翻译。模型接口兼容 OpenAI Chat Completions。

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
                  └─ /v1/chat/completions (stream=true，工程请求带 tools)
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
- **缓存命中数**：`usage.prompt_tokens_details.cached_tokens`（OpenAI/小米格式）或 `usage.prompt_cache_hit_tokens`（DeepSeek 格式）→ 汇总成 `usage.cached_tokens` 一起下发。同次工程任务保持提示词和工具定义稳定，缓存和计费由服务商决定。面板据此把用量显示成 `↑8.4k(缓存 7.1k) ↓39 tok`，用户能直接看到"这轮有多少是缓存价"。`cached_tokens` 缺失时面板退回旧样式（`↑ ↓ tok`），不影响任何逻辑。
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

### 5.4 `js/editor/aiTools.js`

- `assistantMode(text, mode)` 在「自动」下识别组态指令和问答。手动选择「聊天」或「工程」覆盖自动判断。
- 聊天请求发送简短提示词、本轮问题和最近的聊天记录。请求省略 `tools` 和 `tool_choice`，工程快照和工程模式的历史留在本地。手动添加的附件可以随本条消息发送。
- 工程请求使用 `pickTools(text)` 按页面、控件、变量、脚本、报警和布局选择工具。未能定位任务对象时，工程模式可使用全部工具。`buildSystemPrompt(tools)` 按需附控件索引和脚本 API。`projectBrief()` 在发送时读取工程名、画布、当前页、选中控件和删除开关。
- `runAssistant({text, mode, handlers})` 返回 `{cancel}`。仅执行本轮公布的工具。按模型给出的顺序执行，工具修改通过工程 API 进入撤销栈。删除仍由用户开关控制。
- 两种模式的上下文各自取最近会话，从最近六次提问中按 3600 字符预算选取。工程历史沿用最近的任务和简短执行摘要。工具调用与返回值仅用于当前任务，保留最近六个完整批次并按约 9000 字符裁剪，始终保留最新批次和本次用户指令。
- 当前任务的工具结果通过 `compactToolMessage()` 精简后发送，面板使用原始执行结果。删除整批旧消息时保留简短摘要和 `assistant.tool_calls` 与 `tool` 消息的一一对应。重复读取使用仍在上下文里的结果，工程修改后可重新查询。
- 模型在输出前明确返回上下文超限时，助手会尝试进一步压缩旧对话和本次已执行的工具记录。若请求变小，保留当前指令和附件，自动重试一次。重试仍超限时停止并提示缩短指令或附件。
- 同类失败或全批重复读取连续三轮时停止。`budget_tokens` 按模型返回的 `prompt_tokens` 累加，`max_rounds` 限制每次提问的工具批次。停止、新会话、替换工程和撤销会取消进行中的任务。打开新工程时转到新会话，撤销和重做保留当前会话。

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

### 5.6 `js/editor/aiPanel.js`

- 从「工程」菜单打开 AI 助手。宽窗口固定在最右侧，窄窗口显示右侧抽屉。开关状态保存在 `localStorage['hmi-ai-open']`。
- 顶栏显示连接状态和设置入口。模式选择与范围条提示当前草稿会走聊天还是工程。首屏示例填入草稿后可编辑。翻译有独立对话框。「新会话」另开空白聊天。「历史」可查看、继续或删除已发送的会话。
- 输入框支持 Enter 发送、Shift+Enter 换行和输入法选字。发送期间可编辑下一条草稿，可停止当前任务。结束时输入区保留完成或停止状态，设计器状态栏也短暂显示。达到输入预算、工具批次或回复长度上限时显示具体原因。工程修改按工具批次记录用时和模型用量，点击折叠组查看执行明细。
- 输入区可选文件或粘贴截图。每条消息最多三件附件。CSV、TXT、JSON、XML、日志和代码等文本使用现有编码检测，每件最多发送前 12000 字符。PNG、JPG、WebP 在浏览器压缩后以图文请求发送，需要服务商模型支持识图。下一次提问不会自动携带原附件。
- 历史写入当前浏览器的 IndexedDB，保存正文、附件文件名、用量和工具执行摘要。会话不会由应用自动清理。打开历史会话后只恢复近期上下文，阅读历史不请求模型。打开其它工程后可从历史列表查看先前会话。

## 6. 提示词规范

聊天提示用一句话描述组态问答用途。工程提示强调集中查询、按依赖顺序执行、通过真实 ID 或名称引用、批量添加控件和检查整页排版。工具启用时附对应的控件索引或脚本 API。

### 6.1 翻译提示词

按请求条目编号返回 JSON 对象。
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
- `channels`（trend/xyplot 多通道）→ `project.updateWidgetProp(id,'variables',arr)` 或按 def 的变量槽属性。`actions` 按点击顺序替换。跳转使用 `{type:"gotoPage",params:{page:"页面名或ID"}}`，赋值使用 `{type:"setValue",params:{variable:"变量名",value:0}}`。参数无效时保留原动作。
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
| `index.html` | Lead | `#dockRow` 末尾 `<aside id="aiSide">` + `#panel-ai` 搬入（标题栏 `#aiCloseBtn` ✕）|
| `css/ai.css` | 前端 UI | 新建，`js/main.js` 里 `<link>`？→ 直接 `<link rel="stylesheet" href="css/ai.css">` 加进 index.html |
| `js/editor/dock.js` | 无改动 | AI 不是 dock 面板（`PANELS`/`HOME`/`showPanel` 均不涉及 AI） |
| `js/editor/main.js` | Lead | import + MODULES 加 `aiPanel`；`import('./editor/aiPanel.js')` |
| `js/editor/menus.js` | Lead | `PANEL_TITLE.ai='AI 助手'` |
| `js/editor/toolbar.js` | Lead | 工程菜单加「AI 助手…」→ `import('./aiPanel.js').then(m=>m.toggleAiSide())` |
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
3. **前端工具层单测**（`test/verify-ai-modules.mjs`，playwright，不开模型）：`page.evaluate` 直接 `import('/js/editor/aiTools.js')` 调 `runTool()` 逐条验组态工具的参数校验/破坏性闸门/变量存在性/props 白名单/脚本语法检查/数量守恒；`aiTranslate` 验 `pendingStats/pendingFor/applyPairs`（幻觉 source 丢弃、与原文相同跳过）。
4. **面板 UI**（`test/verify-ai-panel.mjs`，playwright + 假模型）：固定侧栏默认收起 → 在工程菜单开关、`#panel-ai` 在 `#aiSide` 内且不在 `.dock-panes`（不可拖）、聊天/markdown/思考折叠、工具调用折叠组（一轮 5 个工具 / 散卡片攒到第 3 个自动收拢 / 默认收起 / 点开看明细 / 组状态全部成功）、每轮实时用时 + token 用量、停止、**设置对话框：服务商下拉 + 预设按钮（点「小米 MiMo」自动填地址/模型）**、测试连接、翻译对话框写入 `dict.en`、破坏性开关、重复读取保护、历史压缩，以及聊天请求省略工具和工程上下文。
5. **后端单测**（`test/verify-ai-backend.py`，66 项）：含 **profiles 保存/切换（切换后 key 沿用）**、**地址少 `/v1` 时测试连接不再误报**、**非小米地址带 `stream_options.include_usage`**。
5. **回归**：`node tools/run-suites.mjs`（按 `tools/suite-map.json`）；本机 8866 若是**运行态实例**（`document.body.className==='run-only'`）需另起编辑器实例，套件带端口跑，例如 `python server.py --port 8899 --no-browser --no-auth` + `node test/verify-dock.mjs 8899`。

## 10. 后续（不在本期）

- 语音输入（MiMo ASR/TTS 模型已存在）；
- 公共底（baseIds）批量编排、配方/参数表数据填充；
- 截图给模型看（`--mcp-live` 的 CDP 截图能力已有）。
