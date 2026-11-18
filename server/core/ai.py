#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ai.py — AI 助手后端代理（配置读写 + 流式调 MiMo + WS ai 帧）

（模块总索引见 core/__init__.py；设计契约见 docs/ai-assistant.md §2/§3/§4。）

这个模块只干四件事，**不碰业务**：
  1. 读写 <数据目录>/ai.json（API Key 只存在这儿，前端只拿掩码）；
  2. 用 urllib 发 `stream:true` 的 OpenAI 兼容请求，按行解析 SSE；
  3. 把模型流翻译成 `ai_delta / ai_tool / ai_done / ai_error` 帧，点对点发回发起连接；
  4. 给 `/api/ai/config`、`/api/ai/test` 两个接口的实现（由 core/api.py 转调）。

⚠ 三条铁律（踩过就白干）：
  · **AI 请求必须跑在工作线程里**。`{t:'call'}`/`{t:'ai'}` 都是 WS **读线程**上的同步调用，
    在这里同步发网络请求 = 整条连接不再收帧（前端表现为"整个编辑器卡住"）。
    所以 `handle()` 只做校验 + 占坑 + 起线程，立即返回。
  · **不要 import core.wsbridge**（会成环）：wsbridge 调 `ai.handle(conn, msg)`，
    这里只认 `conn.send(dict)` / `conn.authed` / `conn.role` / `conn.cid` / `conn.alive`。
  · **日志不许出现 key / prompt / 回复正文**：出错只打 code + 人话，成功只打模型名 + token 数 + 耗时。

关思维链只有 `"thinking":{"type":"disabled"}` 有效（只传 enable_thinking 无效，实测）；
`thinking:"auto"` 时**不传**这个参数。
"""

from . import auth
from .paths import DATA_DIR

import hashlib
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request


# ─────────────────────────────────────────────────────────
#  配置（server/data/ai.json；不进 settings.json、不进工程）
# ─────────────────────────────────────────────────────────
AI_FILE = DATA_DIR / "ai.json"

# 已保存的服务商配置（下拉切换；存 ai.json 的 profiles/active，key 只在后端）
PROFILE_FIELDS = ("base_url", "model", "api_key", "temperature", "max_tokens",
                  "thinking", "timeout", "max_rounds", "budget_tokens")

# 常见服务商名字（只影响下拉里显示的名字，不影响调用）
PRESET_NAMES = {
    "api.xiaomimimo.com": "小米 MiMo",
    "api.openai.com": "OpenAI",
    "api.deepseek.com": "DeepSeek",
    "open.bigmodel.cn": "智谱 GLM",
    "dashscope.aliyuncs.com": "通义千问",
    "api.moonshot.cn": "Kimi",
}

DEFAULTS = {
    "enabled": True,
    "base_url": "https://api.xiaomimimo.com/v1",
    "model": "mimo-v2.6-flash",
    "api_key": "",
    "temperature": 0.2,
    "max_tokens": 4000,
    "thinking": "disabled",          # "disabled"（默认，最快）/ "auto"（不传 thinking 参数）
    "timeout": 90,
    "max_rounds": 0,                 # 0 = 不限制（一直跑到模型不再调工具）
    "budget_tokens": 60000,          # 单次提问累计输入 token 预算（0 = 不限制；到量就停，防长任务无声烧钱）
}

# 环境变量兜底：读优先 = 文件 > 环境变量 > 默认（见 load_cfg）
_ENV_KEYS = {
    "api_key": "HMI_AI_KEY",
    "base_url": "HMI_AI_BASE_URL",
    "model": "HMI_AI_MODEL",
    "enabled": "HMI_AI_ENABLED",
}

# 数值夹取范围（§2）：尽量宽松，只有明显非法的值才夹
_LIMITS = {
    "temperature": (0.0, 2.0),
    "max_tokens": (64, 200000),
    "timeout": (10, 3600),
    "max_rounds": (0, 9999),          # 0 = 不限制轮数
    "budget_tokens": (0, 2000000),    # 0 = 不限制；单次提问累计输入 token 预算
}

_CFG_LOCK = threading.Lock()

# 并发上限（§3）：单连接同时最多 2 个会话、全局最多 8 个，超了 ai_error code:'busy'
CONN_MAX = 2
GLOBAL_MAX = 8

_SESS_LOCK = threading.Lock()

_SESS = {}                 # {(conn.cid, str(msg id)): _Session} —— 正在跑的会话


# ── 小工具（纯函数，别引第三方）──
def _clamp_int(v, lo, hi, dflt):
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return dflt


def _clamp_float(v, lo, hi, dflt):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return dflt


def _as_bool(v, dflt=True):
    if isinstance(v, bool):
        return v
    if v is None:
        return dflt
    return str(v).strip().lower() not in ("0", "false", "no", "off", "")


def _as_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _norm_base_url(u):
    """统一成不带尾部斜杠的 base_url（空 → 默认值）"""
    s = str(u or "").strip().rstrip("/")
    return s or str(DEFAULTS["base_url"])


def _coerce_one(key, raw, dflt):
    """把外部给的一个值按字段语义归一（坏值退回 dflt；数值一律夹取）"""
    if key == "enabled":
        return _as_bool(raw, bool(dflt))
    if key == "thinking":
        return "auto" if str(raw or "").strip().lower() == "auto" else "disabled"
    if key in ("api_key", "base_url", "model"):
        return str(raw if raw is not None else "").strip()
    lo, hi = _LIMITS[key]
    if key == "temperature":
        return _clamp_float(raw, lo, hi, dflt)
    return _clamp_int(raw, lo, hi, dflt)


def _read_file():
    """读 ai.json（不在 / 坏了都当空 dict —— 配置文件不能把服务搞起不来）"""
    try:
        if AI_FILE.exists():
            d = json.loads(AI_FILE.read_text(encoding="utf-8-sig"))
            return d if isinstance(d, dict) else {}
    except Exception:                                              # noqa: BLE001
        pass
    return {}


def _profiles_of(raw):
    """ai.json 里的 profiles（脏数据直接跳过，别让配置把服务搞挂）"""
    out = []
    for p in (raw.get("profiles") or []):
        if isinstance(p, dict) and str(p.get("id") or "").strip():
            out.append(p)
    return out


def _profile_label(prof):
    """给服务商起个人能看懂的名字：已知厂商用中文名，其它用 host · model"""
    url = str(prof.get("base_url") or "")
    host = url.split("://")[-1].split("/")[0].strip()
    model = str(prof.get("model") or "").strip()
    name = PRESET_NAMES.get(host)
    if not name:
        name = host or "自定义"
        if host.startswith("127.0.0.1") or host.startswith("localhost") or host.startswith("192.168"):
            name = "本机 LM Studio / Ollama"
    return f"{name}" + (f" · {model}" if model else "")


def _profile_id(base_url, model):
    """同一地址+模型 = 同一个服务商（重复保存就更新，不会堆一堆重复项）"""
    h = hashlib.sha1(f"{_norm_base_url(base_url)}|{str(model or '').strip()}".encode()).hexdigest()[:10]
    return "p_" + h


def _active_profile(raw):
    ps = _profiles_of(raw)
    aid = str(raw.get("active") or "")
    for p in ps:
        if str(p.get("id")) == aid:
            return p
    return ps[0] if ps else None


def _sync_top(raw, prof):
    """把某个服务商的配置镜像回顶层字段（load_cfg / 老接口只看顶层，保持兼容）"""
    for k in PROFILE_FIELDS:
        if k in prof and prof[k] is not None:
            raw[k] = prof[k]
    raw["active"] = str(prof.get("id") or "")


def load_cfg():
    """合并默认值 + 环境变量 + 文件（优先级：文件 > 环境变量 > 默认），数值一律夹取。"""
    cfg = dict(DEFAULTS)
    for key, env in _ENV_KEYS.items():
        raw = os.environ.get(env)
        if raw is None or str(raw).strip() == "":
            continue
        cfg[key] = _coerce_one(key, raw, cfg[key])
    raw = _read_file()
    for key in DEFAULTS:
        if key not in raw:
            continue
        v = raw[key]
        # 空串 = "没设"：别让环境变量兜底被一个空字段静默盖掉（尤其 api_key）
        if key in ("api_key", "base_url", "model") and not str(v if v is not None else "").strip():
            continue
        cfg[key] = _coerce_one(key, v, cfg[key])
    prof = _active_profile(raw)
    if prof:
        for key in PROFILE_FIELDS:
            v = prof.get(key)
            if v is None:
                continue
            if key in ("api_key", "base_url", "model") and not str(v).strip():
                continue
            cfg[key] = _coerce_one(key, v, cfg[key])
    cfg["base_url"] = _norm_base_url(cfg["base_url"])
    return cfg


def save_cfg(patch):
    """把 patch 白名单合并写回 ai.json（锁 + 原子写 .tmp → os.replace）。

    返回 (合并后的完整配置, 错误文本|None)。
    `api_key` 是**只写**的：空 / "__keep__" = 不改；其它字段白名单外的一概忽略。
    `select_profile` = 切到已保存的某个服务商；`profile_id` = 改写指定那条；
    `delete_profile` = 删一条；都没有则按 base_url+model 更新当前那条（没有就新建）。
    """
    if not isinstance(patch, dict):
        return load_cfg(), "配置必须是 JSON 对象"
    with _CFG_LOCK:
        now = load_cfg()
        raw = _read_file()
        profs = _profiles_of(raw)

        # ① 删除一条
        drop = str(patch.get("delete_profile") or "").strip()
        if drop:
            profs = [p for p in profs if str(p.get("id")) != drop]
            raw["profiles"] = profs
            if str(raw.get("active") or "") == drop:
                raw["active"] = ""
                if profs:
                    _sync_top(raw, profs[0])

        # ② 切换（只切不改，key 沿用后端存的）
        sel = str(patch.get("select_profile") or "").strip()
        if sel:
            hit = None
            for p in profs:
                if str(p.get("id")) == sel:
                    hit = p
                    break
            if hit is None:
                return load_cfg(), "没找到这个服务商配置（可能已经被删掉了）"
            _sync_top(raw, hit)

        # ③ 保存字段（改写指定那条 / 更新当前 / 新建一条）
        if not drop and not sel:
            for key, v in patch.items():
                if key not in DEFAULTS:
                    continue
                if key == "api_key":
                    key_s = str(v if v is not None else "").strip()
                    if not key_s or key_s == "__keep__":
                        continue
                    raw["api_key"] = key_s
                    continue
                if key in ("base_url", "model"):
                    strv = str(v if v is not None else "").strip()
                    if not strv:
                        continue
                    raw[key] = strv
                    continue
                raw[key] = _coerce_one(key, v, now[key])

            merged = {}
            for k in PROFILE_FIELDS:
                merged[k] = raw.get(k, now.get(k))
            merged["base_url"] = _norm_base_url(merged.get("base_url"))
            if not str(merged.get("api_key") or "").strip():
                merged["api_key"] = str(now.get("api_key") or "")   # 换字段别把 key 弄丢
            want = str(patch.get("profile_id") or "").strip()
            pid = want or _profile_id(merged["base_url"], merged.get("model"))
            old = None
            for p in profs:
                if str(p.get("id")) == pid:
                    old = p
                    break
            merged["id"] = pid
            merged["name"] = str(patch.get("name") or (old or {}).get("name")
                                 or _profile_label(merged)).strip()
            profs = [p for p in profs if str(p.get("id")) != pid] + [merged]
            raw["profiles"] = profs
            raw["active"] = pid
            _sync_top(raw, merged)

        try:
            AI_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = AI_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, AI_FILE)
        except Exception as e:                                     # noqa: BLE001
            print(f"[ai] 写配置失败：{e}")
            return load_cfg(), f"写 AI 配置失败：{e}"
    return load_cfg(), None


def _mask(key):
    """掩码：保留前 3 后 4（sk-****abcd）；太短就全遮"""
    s = str(key or "")
    if not s:
        return ""
    if len(s) < 8:
        return "****"
    return s[:3] + "****" + s[-4:]


def public_cfg():
    """给前端看的配置（api_key 一律掩码，永不回明文）"""
    cfg = load_cfg()
    return {
        "enabled": bool(cfg["enabled"]),
        "base_url": cfg["base_url"],
        "model": cfg["model"],
        "api_key_masked": _mask(cfg["api_key"]),
        "temperature": cfg["temperature"],
        "max_tokens": cfg["max_tokens"],
        "thinking": cfg["thinking"],
        "timeout": cfg["timeout"],
        "max_rounds": cfg["max_rounds"],
        "budget_tokens": cfg["budget_tokens"],
        "has_key": bool(cfg["api_key"]),
        "active": str((_active_profile(_read_file()) or {}).get("id") or ""),
        "profiles": [{
            "id": str(p.get("id")),
            "name": str(p.get("name") or _profile_label(p)),
            "base_url": str(p.get("base_url") or ""),
            "model": str(p.get("model") or ""),
            "temperature": _clamp_float(p.get("temperature"), 0.0, 2.0, DEFAULTS["temperature"]),
            "max_tokens": _clamp_int(p.get("max_tokens"), 64, 200000, DEFAULTS["max_tokens"]),
            "thinking": "auto" if str(p.get("thinking") or "").lower() == "auto" else "disabled",
            "timeout": _clamp_int(p.get("timeout"), 10, 3600, DEFAULTS["timeout"]),
            "max_rounds": _clamp_int(p.get("max_rounds"), 0, 9999, DEFAULTS["max_rounds"]),
            "budget_tokens": _clamp_int(p.get("budget_tokens"), 0, 2000000, DEFAULTS["budget_tokens"]),
            "api_key_masked": _mask(p.get("api_key")),
            "has_key": bool(str(p.get("api_key") or "").strip()),
        } for p in _profiles_of(_read_file())],
    }


def brief():
    """hello 帧里的 ai 段：只给"能不能用 + 什么模型"，不给地址和 key"""
    cfg = load_cfg()
    return {"enabled": bool(cfg["enabled"]), "model": cfg["model"],
            "has_key": bool(cfg["api_key"])}


# ─────────────────────────────────────────────────────────
#  调模型：POST {base_url}/chat/completions（stream=true）
# ─────────────────────────────────────────────────────────
class _AiErr(Exception):
    """带 code 的失败（code ∈ forbidden/no_key/http/timeout/network/cancel/busy）"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code or "network")
        self.message = str(message or "")


def _abort_resp(resp):
    """打断阻塞在 recv 上的读。

    只 close 不够：http.client 的响应包着 BufferedReader，读线程调 readline() 时
    一直占着这个缓冲区的锁；从别的线程 close() 会**卡在等锁上**（要等到读返回），
    取消按钮就变成"点了没反应、卡 30~90 秒"。所以先 shutdown 底层 socket 把 recv
    唤醒，再 close 才不会卡。
    """
    if resp is None:
        return
    sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    try:
        resp.close()
    except Exception:                                          # noqa: BLE001
        pass


class _Cancel:
    """取消信号：一个 Event + 当前响应对象（打断它让阻塞读立刻返回）。

    对外鸭子类型（is_set()）跟 threading.Event 一样，只是多挂着 resp ——
    因为 HTTP 读阻塞在 socket 上，光 set 一个 Event 是叫不醒它的。
    """

    __slots__ = ("_ev", "_resp", "_lock")

    def __init__(self):
        self._ev = threading.Event()
        self._resp = None
        self._lock = threading.Lock()

    def is_set(self):
        return self._ev.is_set()

    def set(self):
        self._ev.set()
        with self._lock:
            resp = self._resp
        _abort_resp(resp)

    def attach(self, resp):
        with self._lock:
            self._resp = resp
            early = self._ev.is_set()
        if early:                          # 已经在取消之后才拿到响应：立刻打断
            _abort_resp(resp)

    def detach(self):
        with self._lock:
            self._resp = None


def _map_http_error(e):
    """HTTP 错误 → (code, 人话)。401/403/429 有专门文案。"""
    status = int(getattr(e, "code", 0) or 0)
    if status in (401, 403):
        return "http", "API Key 无效或无权限"
    if status == 429:
        return "http", "模型服务限流，请稍后再试"
    detail = ""
    try:
        raw = e.read(1024)
        if raw:
            obj = json.loads(raw.decode("utf-8", "replace"))
            if isinstance(obj, dict):
                err = obj.get("error")
                if isinstance(err, dict):
                    detail = str(err.get("message") or "")
                elif err:
                    detail = str(err)
                detail = detail or str(obj.get("message") or "")
    except Exception:                                              # noqa: BLE001
        detail = ""
    detail = detail.strip()[:200]
    return "http", f"模型服务返回 HTTP {status}" + (f"：{detail}" if detail else "")


def _is_local_thinking_model(cfg):
    """本机/自建的 Qwen3 这类模型不认 thinking 开关，只认正文里的 /no_think。"""
    url = _norm_base_url((cfg or {}).get("base_url"))
    if "xiaomimimo.com" in url:
        return False
    model = str((cfg or {}).get("model") or "").lower()
    return "qwen3" in model or "qwen-3" in model


def _post_chat(cfg, body, on_event=None, cancel=None):
    """发一条流式 chat 请求，边读边回调 —— 返回收尾信息 dict。

    返回 {finish_reason, content, tool_calls:[{id,name,arguments}], usage:{prompt_tokens,completion_tokens}}
    失败抛 _AiErr（code 已映射好，调用方只负责转成 ai_error 帧 / 错误文本）。
    on_event(('text', s)) / on_event(('reason', s)) 是流式增量回调。
    cancel：_Cancel（或任何有 is_set() 的对象）—— 每读一行检查一次。
    """
    key = str(cfg.get("api_key") or "")
    if not key:
        raise _AiErr("no_key", "未配置 API Key，请在 AI 设置里填写")
    url = _norm_base_url(cfg.get("base_url")) + "/chat/completions"
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        raise _AiErr("bad_request", "messages 必须是非空数组")
    # 本机/自建的 Qwen3 这类模型不认 {"type":"disabled"}，只认正文里的 /no_think；
    # 只在"关思维链"时补（auto 模式尊重用户选择），且只改请求体、不动会话历史。
    _think = str(body.get("thinking") or cfg.get("thinking") or "disabled").strip().lower()
    if _think != "auto" and _is_local_thinking_model(cfg):
        msgs = [dict(m) for m in msgs]
        for _m in reversed(msgs):
            if _m.get("role") == "user":
                _m["content"] = str(_m.get("content") or "") + "\n/no_think"
                break
    payload = {
        "model": str(body.get("model") or cfg.get("model") or DEFAULTS["model"]),
        "messages": msgs,
        "stream": True,
        "temperature": _clamp_float(body.get("temperature"), 0.0, 2.0,
                                    _clamp_float(cfg.get("temperature"), 0.0, 2.0, 0.2)),
        "max_tokens": _clamp_int(body.get("max_tokens"), 64, 200000,
                                 _clamp_int(cfg.get("max_tokens"), 64, 200000, 4000)),
    }
    if isinstance(body.get("tools"), list) and body["tools"]:
        payload["tools"] = body["tools"]
    if body.get("tool_choice") is not None:
        payload["tool_choice"] = body["tool_choice"]
    if isinstance(body.get("response_format"), dict):
        payload["response_format"] = body["response_format"]
    # 关思维链：只有这个参数有效（实测）；"auto" 时一个字段都不传
    thinking = str(body.get("thinking") or cfg.get("thinking") or "disabled").strip().lower()
    if thinking != "auto":
        payload["thinking"] = {"type": "disabled"}
    # 流式用量：LM Studio / OpenAI / DeepSeek 需要 stream_options 才在最后回 usage；
    # 小米 MiMo 实测不需要（多传可能 400），所以只对非小米地址加。
    if "xiaomimimo.com" not in _norm_base_url(cfg.get("base_url")):
        payload["stream_options"] = {"include_usage": True}
    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as e:
        raise _AiErr("bad_request", f"messages 不是合法 JSON：{e}")

    timeout = _clamp_int(cfg.get("timeout"), 10, 3600, 90)
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "hmi-designer-ai/2.2",
    })
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        code, msg = _map_http_error(e)
        raise _AiErr(code, msg)
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), TimeoutError):
            raise _AiErr("timeout", f"模型服务超时（{timeout}s）")
        raise _AiErr("network", f"连不上模型服务：{e.reason}")
    except TimeoutError:
        raise _AiErr("timeout", f"模型服务超时（{timeout}s）")
    except OSError as e:
        raise _AiErr("network", f"连不上模型服务：{e}")

    if cancel is not None and hasattr(cancel, "attach"):
        cancel.attach(resp)
    try:
        return _read_stream(resp, timeout, on_event, cancel)
    finally:
        if cancel is not None and hasattr(cancel, "detach"):
            cancel.detach()
        try:
            resp.close()
        except Exception:                                          # noqa: BLE001
            pass


def _read_stream(resp, timeout, on_event, cancel):
    """逐行解析 SSE → 累积 content / reasoning / tool_calls / usage / finish_reason"""
    content = []
    tools = {}                      # index → {id, name, arguments}
    order = []                      # 工具 index 首次出现顺序（保住模型给的顺序）
    finish = ""
    usage = {}
    saw_data = False
    other_lines = []            # 非 data: 的行（有些服务 200 回一行 error JSON，要识别出来）

    def _cb(kind, s):
        if on_event is not None and s:
            on_event((kind, s))

    while True:
        if cancel is not None and cancel.is_set():
            raise _AiErr("cancel", "已取消")
        try:
            raw = resp.readline()
        except Exception as e:                                     # noqa: BLE001
            # cancel 时另一线程 close 了 resp：这里一定抛 —— 按取消处理，别报成网络错误
            if cancel is not None and cancel.is_set():
                raise _AiErr("cancel", "已取消")
            if isinstance(e, TimeoutError):
                raise _AiErr("timeout", f"模型服务超时（{timeout}s）")
            raise _AiErr("network", f"读模型响应失败：{e}")
        if not raw:
            if cancel is not None and cancel.is_set():
                raise _AiErr("cancel", "已取消")
            break
        line = raw.decode("utf-8", "replace").strip()
        if not line or line.startswith(":"):
            continue
        if not line.startswith("data:"):
            if len(other_lines) < 4:
                other_lines.append(line[:400])
            continue
        saw_data = True
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except Exception:                                          # noqa: BLE001
            continue                    # 坏行忽略（有些服务会漏半行/注释行）
        if not isinstance(chunk, dict):
            continue
        u = chunk.get("usage")
        if isinstance(u, dict) and u:
            usage = u                   # usage 块通常在最后（choices:[]），先收着
        choices = chunk.get("choices") or []
        if not isinstance(choices, list) or not choices:
            continue
        ch = choices[0] if isinstance(choices[0], dict) else {}
        if ch.get("finish_reason"):
            finish = str(ch["finish_reason"])      # 取最后一次非空
        delta = ch.get("delta")
        if not isinstance(delta, dict):
            delta = {}
        piece = delta.get("content")
        if piece:
            content.append(str(piece))
            _cb("text", str(piece))
        reason = delta.get("reasoning_content")
        if reason is None:
            reason = delta.get("reasoning")
        if reason:
            _cb("reason", str(reason))
        for tc in delta.get("tool_calls") or []:
            if not isinstance(tc, dict):
                continue
            idx = tc.get("index")
            if not isinstance(idx, int):
                idx = order[-1] if order else 0
            if idx not in tools:
                tools[idx] = {"id": "", "name": "", "arguments": ""}
                order.append(idx)
            slot = tools[idx]
            if tc.get("id") and not slot["id"]:
                slot["id"] = str(tc["id"])
            fn = tc.get("function")
            if isinstance(fn, dict):
                nm = fn.get("name")
                if nm:
                    nm = str(nm)
                    if not slot["name"]:
                        slot["name"] = nm
                    elif not slot["name"].endswith(nm):
                        slot["name"] += nm       # 名字也可能分片（实测只首块给，两种都兼容）
                args = fn.get("arguments")
                if args:
                    slot["arguments"] += str(args)   # 参数**一定**是分片字符串，按 index 拼完再解析

    if not saw_data:
        blob = " ".join(other_lines)
        if "error" in blob.lower():
            msg = blob
            try:
                obj = json.loads(blob) if blob.lstrip().startswith("{") else None
                if isinstance(obj, dict) and obj.get("error") is not None:
                    err = obj["error"]
                    msg = err if isinstance(err, str) else json.dumps(err, ensure_ascii=False)
            except Exception:                                      # noqa: BLE001
                pass
            raise _AiErr("http", "模型服务返回了错误而不是流式回复：" + str(msg)[:300]
                         + "｜接口地址可能不对：多数 OpenAI 兼容服务要以 /v1 结尾"
                           "（LM Studio 填 http://IP:1234/v1，小米填 https://api.xiaomimimo.com/v1）")

    calls = []
    for idx in order:
        slot = tools[idx]
        if not slot["name"]:
            continue
        calls.append({"id": slot["id"] or f"call_{idx}", "name": slot["name"],
                      "arguments": slot["arguments"] or "{}"})
    # 缓存命中数：OpenAI/小米用 prompt_tokens_details.cached_tokens，DeepSeek 用 prompt_cache_hit_tokens。
    # 拿到它，前端才能显示"这轮 8.4k 输入里有 7.1k 是缓存价"，也让用户看清钱花在哪。
    _det = usage.get("prompt_tokens_details") or {}
    cached = _as_int(_det.get("cached_tokens") if isinstance(_det, dict) else 0) or \
        _as_int(usage.get("prompt_cache_hit_tokens"))
    return {"finish_reason": finish or ("tool_calls" if calls else "stop"),
            "content": "".join(content),
            "tool_calls": calls,
            "usage": {"prompt_tokens": _as_int(usage.get("prompt_tokens")),
                      "cached_tokens": cached,
                      "completion_tokens": _as_int(usage.get("completion_tokens"))}}


# ─────────────────────────────────────────────────────────
#  /api/ai/config、/api/ai/test（由 core/api.py 转调；管理员闸门在 api.dispatch）
# ─────────────────────────────────────────────────────────
def ep_config(method, body):
    """GET = 读（掩码）；POST = 合并写（api_key 只写）。返回 (status, payload)。"""
    method = str(method or "GET").upper()
    if method == "GET":
        return 200, {"ok": True, "cfg": public_cfg()}
    if method == "POST":
        cfg, err = save_cfg(body if isinstance(body, dict) else {})
        if err:
            return 500, {"ok": False, "error": err}
        pub = public_cfg()
        print(f"[ai] 配置已更新：model={pub['model']} base_url={pub['base_url']} "
              f"has_key={pub['has_key']} thinking={pub['thinking']}")
        return 200, {"ok": True, "cfg": pub}
    return 405, {"ok": False, "error": f"AI 配置只认 GET / POST（收到 {method}）"}


def ep_test(body):
    """用**已存配置**发一条极短 chat，量一下延迟。返回 {ok, latency_ms, model, error?}"""
    cfg = load_cfg()
    model = cfg["model"]
    if not cfg.get("api_key"):
        return 200, {"ok": False, "latency_ms": 0, "model": model, "code": "no_key",
                     "error": "未配置 API Key，请在 AI 设置里填写"}
    t0 = time.time()
    prompt = "ping"
    if _is_local_thinking_model(cfg) and str(cfg.get("thinking") or "") != "auto":
        prompt += "\n/no_think"
    try:
        res = _post_chat(cfg, {"messages": [{"role": "user", "content": prompt}],
                               "max_tokens": 256, "temperature": 0})
    except _AiErr as e:
        print(f"[ai] 测试连接失败（{e.code}）：{e.message}")
        return 200, {"ok": False, "latency_ms": int((time.time() - t0) * 1000),
                     "model": model, "code": e.code, "error": e.message}
    elapsed = int((time.time() - t0) * 1000)
    reply = str(res.get("content") or "")
    used = _as_int((res.get("usage") or {}).get("completion_tokens"))
    if not reply.strip() and not res.get("tool_calls"):
        if used > 0:
            # 出过 token 但正文为空 → 模型把额度全花在思考上了。连接本身是通的，别误报失败。
            print(f"[ai] 测试连接成功（只出了思考内容）：model={model} {elapsed}ms tokens={used}")
            return 200, {"ok": True, "latency_ms": elapsed, "model": model, "reply_chars": 0,
                         "note": "连接正常，但这个模型默认开思考、这次只回了思考内容（没有正文）。"
                                 "真跑任务建议换 4B 以上模型，或在指令里加 /no_think；"
                                 "设置里把「思考过程」改成「关闭」也会自动帮你加 /no_think。"}
        # 200 + 空回复很常见于"地址少 /v1"（LM Studio 会回 error JSON，被上面拦掉后到这里就是真空回）
        print(f"[ai] 测试连接拿到空回复：model={model} {elapsed}ms")
        return 200, {"ok": False, "latency_ms": elapsed, "model": model, "code": "empty_reply",
                     "error": "连上了但模型没返回任何文字：① 接口地址多半少了 /v1"
                              "（LM Studio 这类要填 http://IP:端口/v1）；② 或者模型在思考而 "
                              "max_tokens 太小 —— 换大一点的模型，或在消息里加 /no_think。"}
    print(f"[ai] 测试连接成功：model={model} {elapsed}ms chars={len(reply)}")
    return 200, {"ok": True, "latency_ms": elapsed, "model": model,
                 "reply_chars": len(reply)}


# ─────────────────────────────────────────────────────────
#  WS `{t:'ai'}` 帧
# ─────────────────────────────────────────────────────────
def _is_admin(conn):
    """只有管理员能用 AI（口径与 wsbridge.conn_role 一致：没开闸门 = 都是管理员）"""
    if not auth.AUTH_ENABLED:
        return True
    if not getattr(conn, "authed", False):
        return False
    role = str(getattr(conn, "role", "") or "").lower()
    return role in ("", "admin")           # 空角色 + 已登录 = 管理员（升级兼容）


def _mkey(conn, mid):
    """会话键：连接 + 帧 id（不同客户端的 id 会重复，必须带 cid）"""
    return (str(getattr(conn, "cid", "") or ""), str(mid))


def _prune_locked():
    """把连接已经断了的会话清掉（槽位不能因为断线永远占着）"""
    for k in [k for k, s in _SESS.items() if not getattr(s.conn, "alive", True)]:
        _SESS.pop(k, None)


def _conn_active_locked(conn):
    return sum(1 for s in _SESS.values() if s.conn is conn)


class _Session:
    """一次对话：取消信号 + 收尾幂等（ai_done / ai_error 只发一次）"""

    __slots__ = ("conn", "mid", "cfg", "cancel", "t0", "_done", "_lock")

    def __init__(self, conn, mid, cfg):
        self.conn = conn
        self.mid = mid
        self.cfg = cfg
        self.cancel = _Cancel()
        self.t0 = time.time()
        self._done = False
        self._lock = threading.Lock()

    @property
    def cancelled(self):
        return self.cancel.is_set()

    def emit(self, payload):
        """发流式帧（已取消 / 已收尾 → 静默丢弃，保证 cancel 之后不再有新帧）"""
        with self._lock:
            if self._done or self.cancel.is_set():
                return False
            self.conn.send(payload)
            return True

    def fail(self, code, message):
        with self._lock:
            if self._done:
                return False
            self._done = True
            self.conn.send({"t": "ai_error", "id": self.mid,
                            "code": code, "message": message})
            return True

    def finish(self, payload):
        with self._lock:
            if self._done or self.cancel.is_set():
                return False
            self._done = True
            self.conn.send(payload)
            return True


def _on_event(sess, ev):
    kind, s = ev
    if kind == "text":
        sess.emit({"t": "ai_delta", "id": sess.mid, "text": s})
    elif kind == "reason":
        sess.emit({"t": "ai_delta", "id": sess.mid, "reasoning": s})


def _run_chat(key, sess, body):
    """工作线程：调模型 → 发 ai_tool（一次）/ ai_done；失败发 ai_error。"""
    try:
        res = _post_chat(sess.cfg, body, lambda ev: _on_event(sess, ev), sess.cancel)
        if sess.cancelled:
            return
        if res["tool_calls"]:
            sess.emit({"t": "ai_tool", "id": sess.mid, "calls": res["tool_calls"]})
        elapsed = (time.time() - sess.t0) * 1000.0
        usage = res["usage"]
        sent = sess.finish({"t": "ai_done", "id": sess.mid,
                            "finish_reason": res["finish_reason"],
                            "content": res["content"], "usage": usage,
                            "elapsed_ms": int(elapsed)})
        if sent:
            print(f"[ai] model={sess.cfg.get('model')} "
                  f"tokens={usage['prompt_tokens']}/{usage['completion_tokens']} "
                  f"{elapsed / 1000.0:.1f}s")
    except _AiErr as e:
        if sess.cancelled:             # 取消路径自己已经发过 ai_error cancel
            return
        sess.fail(e.code, e.message)
        print(f"[ai] 失败（{e.code}）：{e.message}")
    except Exception as e:                                         # noqa: BLE001
        if sess.cancelled:
            return
        sess.fail("network", f"AI 请求异常：{type(e).__name__}: {e}")
        print(f"[ai] 异常（{type(e).__name__}）：{e}")
    finally:
        with _SESS_LOCK:
            if _SESS.get(key) is sess:
                _SESS.pop(key, None)


def _do_cancel(conn, mid):
    """op:'cancel' → set 取消信号 + 立刻回 ai_error code:'cancel'（前端静默）"""
    with _SESS_LOCK:
        sess = _SESS.get(_mkey(conn, mid))
    if sess is None:
        return                         # 会话已结束：取消是幂等的，不再回帧（免得噪音）
    # 先回帧（send 只是入队，微秒级），再去打断模型请求：
    # 打断要 shutdown socket，极端情况下仍可能等一小会儿，绝不能卡住 WS 读线程
    # —— 卡住的话这条连接上的取消/其它帧全跟着堵（前端表现就是"停止按钮点了没反应"）。
    sess.fail("cancel", "已取消")
    threading.Thread(target=sess.cancel.set, name=f"ai-cancel-{mid}",
                     daemon=True).start()


def handle(conn, msg):
    """处理一条 `{t:'ai'}` 帧 —— **立即返回**（真正的网络请求在工作线程里）。

    返回 True = 已处理（wsbridge 直接 return，别再往下走到 ack 兜底）。
    """
    op = str(msg.get("op") or "").strip().lower()
    mid = msg.get("id")
    if not _is_admin(conn):
        conn.send({"t": "ai_error", "id": mid, "code": "forbidden",
                   "message": "只有管理员能用 AI 助手（请在页面上按 Ctrl+Shift+E 登录）"})
        return True
    if op not in ("chat", "cancel"):
        conn.send({"t": "ai_error", "id": mid, "code": "bad_request",
                   "message": f"不认识的 AI 操作：{op!r}（只认 chat / cancel）"})
        return True
    if op == "cancel":
        _do_cancel(conn, mid)
        return True

    body = msg.get("body")
    if not isinstance(body, dict):
        body = {}
    cfg = load_cfg()
    if not cfg["enabled"]:
        conn.send({"t": "ai_error", "id": mid, "code": "disabled",
                   "message": "AI 助手已关闭（在 AI 设置里打开）"})
        return True
    if not cfg["api_key"]:
        conn.send({"t": "ai_error", "id": mid, "code": "no_key",
                   "message": "未配置 API Key，请在 AI 设置里填写"})
        return True
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        conn.send({"t": "ai_error", "id": mid, "code": "bad_request",
                   "message": "messages 必须是非空数组"})
        return True
    if not getattr(conn, "alive", True):
        return True

    sess = _Session(conn, mid, cfg)
    key = _mkey(conn, mid)
    with _SESS_LOCK:
        _prune_locked()
        if key in _SESS:
            busy = "id 重复"
        elif len(_SESS) >= GLOBAL_MAX:
            busy = "全局并发已满"
        elif _conn_active_locked(conn) >= CONN_MAX:
            busy = "单连接并发已满"
        else:
            _SESS[key] = sess
            busy = ""
    if busy:
        conn.send({"t": "ai_error", "id": mid, "code": "busy",
                   "message": f"AI 正忙（{busy}：单连接最多 {CONN_MAX} 个、全局最多 "
                              f"{GLOBAL_MAX} 个），请稍后再试"})
        return True
    threading.Thread(target=_run_chat, args=(key, sess, body),
                     name=f"ai-{getattr(conn, 'cid', '')}-{mid}", daemon=True).start()
    return True


def active_sessions():
    """诊断用：现在跑着几个会话（测试/排查"卡住了"时看）"""
    with _SESS_LOCK:
        return len(_SESS)

