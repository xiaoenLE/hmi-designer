/**
 * ai.js — AI 助手的**前端传输层**（只干一件事：把 `{t:'ai'}` 帧收发包装成会话）
 *
 * 为什么单独一层
 * --------------
 * AI 的流式帧（ai_delta / ai_tool / ai_done / ai_error）跟变量、报警、设备状态那些
 * **广播帧**完全是两回事：它们是"点对点回答某一次请求"的，而且只有 AI 面板关心。
 * 所以不塞进 backend 的固定回调里，而是走 backend.onEvent 这条通用订阅通道
 * （`wsChannel._dispatch` 末尾兜底 → `backend.onEvent`），本模块按 `j.id` 路由到
 * 各自的会话。backend / wsChannel 都不需要知道 AI 的事。
 *
 * 约定（见 docs/ai-assistant.md §3 / §5.3）
 * ----------------------------------------
 *   发：{t:'ai', op:'chat', id, body:{messages, tools?, tool_choice?, temperature?, max_tokens?, response_format?, thinking?}}
 *   发：{t:'ai', op:'cancel', id}
 *   收：{t:'ai_delta', id, text?, reasoning?} / {t:'ai_tool', id, calls:[{id,name,arguments}]}
 *       {t:'ai_done', id, finish_reason, content, usage, elapsed_ms} / {t:'ai_error', id, message, code?}
 *
 * ⚠ 三个"必须在这里兜住"的点：
 *   ① **看门狗**：后端在跑模型时连接上什么都不会推（变量帧照旧有，但那不代表这次请求活着）。
 *      所以每个会话自己掐表，超过 `timeout*1000 + 15000` 就让上层收场 —— 否则面板会永远转圈。
 *   ② **断线**：backend 重连后旧会话在后端早就没了，前端必须把这批会话判死，
 *      不然要等看门狗才恢复（客户看到的是"卡住两分钟"）。
 *   ③ **不抛异常**：面板是"用户点一下"触发的，往上抛只会变成控制台红字 + 面板没反应；
 *      一律走 handlers.onError(消息, code)，UI 只管显示。
 */
import { backend } from './backend.js';
import { bus } from '../core/eventBus.js';
import { genId } from '../core/utils.js';

/** 后端配置的默认值（拿不到 /api/ai/config 时兜底；与 server/core/ai.py 的 DEFAULTS 对齐） */
export const AI_DEFAULTS = {
  enabled: true,
  base_url: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.6-flash',
  temperature: 0.2,
  max_tokens: 4000,
  thinking: 'disabled',
  timeout: 90,
  max_rounds: 0,          // 0 = 不限制轮数（一直跑到模型不再调工具）
  budget_tokens: 60000,   // 单次提问累计输入 token 预算（0 = 不限制；到量就停）
};

/** 看门狗在「模型请求超时」之上多给的时间：后端自己会先超时，前端只是最后一道保险 */
const WATCHDOG_EXTRA = 15000;

/** 正在进行的会话：id → { id, handlers, timer, calls, cfg } */
const _sessions = new Map();
/** 只挂一次 backend.onEvent（多个模块 import 这份模块也只挂一次） */
let _stopEvents = null;
/** 后端配置缓存（getConfig 之后才有；UI 也读它显示模型名） */
let _cfg = null;

/** AI 帧的类型（其余帧不归我们管，直接忽略） */
const AI_FRAMES = new Set(['ai_delta', 'ai_tool', 'ai_done', 'ai_error']);

function _safeFn(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (e) { console.error('[ai] 回调出错', e); }
}

/** 收尾一个会话（从表里摘掉 + 停表），返回会话对象或 null */
function _take(id) {
  const s = _sessions.get(id);
  if (!s) return null;
  _sessions.delete(id);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  return s;
}

/** 让一个会话以错误收场（会话不存在就什么都不做） */
function _fail(id, message, code, extra) {
  const s = _take(id);
  if (!s) return false;
  _safeFn(s.handlers.onError, message, code, extra);
  return true;
}

/** 会话收到帧 → 重置看门狗（有数据就说明这次请求还活着） */
function _touch(s) {
  if (s.timer) clearTimeout(s.timer);
  const timeoutMs = Number(s.timeout) > 0 ? Number(s.timeout) : AI_DEFAULTS.timeout;
  s.timer = setTimeout(() => {
    s.timer = null;
    _fail(s.id, '模型长时间无响应（已超过 ' + Math.round(timeoutMs + WATCHDOG_EXTRA / 1000) + ' 秒）', 'timeout');
  }, timeoutMs * 1000 + WATCHDOG_EXTRA);
}

/** 一帧 AI 流式帧 → 路由到对应会话 */
function _onFrame(j) {
  if (!j || typeof j !== 'object' || !AI_FRAMES.has(j.t)) return;
  const s = _sessions.get(j.id);
  if (!s) return;                 // 已被取消/收尾的会话：迟到的帧直接丢
  _touch(s);
  switch (j.t) {
    case 'ai_delta':
      _safeFn(s.handlers.onDelta, { text: j.text || '', reasoning: j.reasoning || '' });
      break;
    case 'ai_tool': {
      // 后端把一轮里的工具调用**收齐后一次发**（arguments 是 JSON 字符串，前端自己 parse）
      const calls = Array.isArray(j.calls) ? j.calls : [];
      s.calls = calls;
      _safeFn(s.handlers.onTool, calls);
      break;
    }
    case 'ai_done': {
      const info = {
        id: j.id,
        content: j.content || '',
        finish_reason: j.finish_reason || '',
        usage: j.usage || null,
        elapsed_ms: Number.isFinite(j.elapsed_ms) ? j.elapsed_ms : 0,
        tool_calls: s.calls || [],     // 方便上层的"一轮"直接拿到本轮工具调用
      };
      _take(j.id);
      _safeFn(s.handlers.onDone, info);
      break;
    }
    case 'ai_error':
      _fail(j.id, j.message || 'AI 请求失败', j.code || 'error', { usage: j.usage || null });
      break;
    default: break;
  }
}

/** 确保"帧 → 会话"那一路只挂一次（backend 建通道之后才能收帧，这里早挂不影响） */
function _bindOnce() {
  if (_stopEvents) return;
  _stopEvents = backend.onEvent(_onFrame);
  // 断线：后端那边这个会话已经没了，旧会话必须当场判死（不然要等看门狗）
  bus.on('backend:reconnect', () => {
    for (const id of [..._sessions.keys()]) _fail(id, '连接已断开，请重试', 'network');
  });
}

/**
 * AI 传输客户端。
 *
 * handlers（一次 chat 一份）：
 *   onDelta({text, reasoning}) · onTool(calls) · onDone(info) · onError(message, code)
 *   —— code: 'forbidden' | 'no_key' | 'http' | 'timeout' | 'network' | 'cancel' | 'busy'
 *      | 'unsupported'（后端不支持 AI）| 'offline'（长连接没通）
 */
export const aiClient = {
  /** 最近一次拿到的后端 AI 配置（没拿过是 null；UI 用它显示模型名/是否配了 key） */
  get config() { return _cfg; },

  /** 后端能不能用 AI：有 "ai" 特性 + hello.ai.enabled（老后端没有 hello.ai 就当开着） */
  available() {
    if (!backend.supports('ai')) return false;
    const ai = backend._hello?.ai;
    if (!ai || typeof ai !== 'object') return true;   // 后端支持但没报现状：按开着处理
    return ai.enabled !== false;
  },

  /** hello 里那份 AI 现状 {enabled, model, has_key}（可能没有） */
  hello() { return backend._hello?.ai || null; },

  /** 就绪 = 长连接通了 + 后端支持 AI（面板状态点用） */
  async ready() {
    if (!backend.supports('ai')) {
      try { await backend.whenReady(6000); } catch { return false; }
      if (!backend.supports('ai')) return false;
    }
    try { await backend.whenReady(4000); } catch { return false; }
    return this.available();
  },

  /** 面板状态点 / 标题用的汇总（不联网，纯本地状态） */
  get status() {
    const ai = backend._hello?.ai || {};
    return {
      available: this.available(),
      online: backend.isOnline(),
      enabled: ai.enabled !== false,
      model: ai.model || _cfg?.model || AI_DEFAULTS.model,
      has_key: !!(ai.has_key ?? _cfg?.has_key),
      configured: ai.has_key ?? _cfg?.has_key ? true : false,
    };
  },

  /* ── 配置（走后端 /api/ai/config，key 只写不读回）── */

  /** 读后端配置（掩码后的 api_key） */
  async getConfig() {
    const d = await backend.rpc('/api/ai/config', { method: 'GET' });
    _cfg = { ...(_cfg || {}), ...((d && d.cfg) || d || {}) };
    return _cfg;
  },

  /** 写后端配置（patch 里的 api_key 为明文才改；空/`__keep__` = 不改） */
  async saveConfig(patch) {
    const d = await backend.rpc('/api/ai/config', { body: patch || {} });
    _cfg = { ...(_cfg || {}), ...((d && d.cfg) || d || {}) };
    bus.emit('ai:config', { cfg: _cfg });
    return _cfg;
  },

  /** 测试连接（后端用已存配置发一条极短 chat）→ {ok, latency_ms, model, error?} */
  async test() {
    return await backend.rpc('/api/ai/test', { body: {}, timeout: 60000 });
  },

  /**
   * 发起一次模型请求。
   * @param {object} body {messages, tools?, tool_choice?, temperature?, max_tokens?, response_format?, thinking?}
   * @param {object} handlers {onDelta,onTool,onDone,onError}
   * @returns {{id:string, cancel:()=>boolean}} 同步返回（面板要能立刻拿到 id 去"停止"）
   */
  chat(body, handlers = {}) {
    _bindOnce();
    const id = genId('ai_');
    const s = { id, handlers: handlers || {}, timer: null, calls: null, timeout: _cfg?.timeout || AI_DEFAULTS.timeout };
    _sessions.set(id, s);

    // 不支持 / 没连上：不抛异常，异步把错误交给上层（让调用方先把 handlers 装好）
    if (!this.available()) {
      _sessions.delete(id);
      queueMicrotask(() => _safeFn(s.handlers.onError,
        backend.supports('ai') ? 'AI 已在后端关闭（见 server/data/ai.json）' : '后端不支持 AI（请更新后端）',
        'unsupported'));
      return { id, cancel: () => false };
    }

    const ch = (() => { try { return backend._ensureChannel(); } catch { return null; } })();
    if (!ch) {
      _sessions.delete(id);
      queueMicrotask(() => _safeFn(s.handlers.onError, '这个浏览器不支持 WebSocket', 'network'));
      return { id, cancel: () => false };
    }

    const send = () => {
      if (!_sessions.has(id)) return;                        // 等待期间被取消了
      _touch(s);
      if (!ch.send({ t: 'ai', op: 'chat', id, body: body || {} })) {
        _fail(id, '连不上后端（长连接已断开）', 'offline');
      }
    };
    if (ch.isOpen()) send();
    else ch.whenOpen(8000).then(send).catch(() => _fail(id, '连不上后端（长连接未建立）', 'offline'));

    return {
      id,
      cancel: () => this.cancel(id),
    };
  },

  /** 取消一个会话：通知后端停掉线程 + 本地立刻判"已取消"（不再有帧进来） */
  cancel(id) {
    const s = _sessions.get(id);
    if (!s) return false;
    _take(id);
    try {
      const ch = backend._ensureChannel();
      ch?.send({ t: 'ai', op: 'cancel', id });
    } catch { /* 连接没了就没什么可取消的 */ }
    // code:'cancel' 是"用户自己按的停止"，UI 据此静默收场（不弹错误条）
    _safeFn(s.handlers.onError, '已取消', 'cancel');
    return true;
  },

  /** 当前还有几个会话在跑（面板"执行中"判断用） */
  get running() { return _sessions.size; },
};
