/**
 * aiPanel.js — AI 助手（窗口最右边的固定侧栏 #aiSide > #panel-ai）
 *
 * ⚠ 它不是停靠面板：不参与拖拽 / 停靠 / 分屏（dock.js 里没有 ai）。
 *   开：工程菜单 →「AI 助手…」；关：标题栏 ✕（openAiSide/closeAiSide）。
 *
 * 这个文件只干"看得见"的活：
 *   ① 把 aiTools.runAssistant() 的多轮回调画成聊天气泡（正文流式 / 思考过程 / 工具卡片）；
 *   ② 设置对话框（接口地址 / 模型 / API Key，只写不读回）；
 *   ③ 翻译对话框（选语言、看进度、跑 aiTranslate）；
 *   ④ 状态点：后端支不支持 AI、连没连上、有没有 key。
 *
 * 为什么正文要自己渲染 markdown：工程里没有引入 markdown 库（也不想为它加依赖），
 * 模型回答里真正需要的只有 **粗体** / `行内代码` / ```围栏代码``` / 列表 / 标题，
 * 五十行足够，而且所有文本都先过 escapeHtml，不会把模型说的话当 HTML 执行。
 */

import { bus } from '../core/eventBus.js';
import { project } from '../core/project.js';
import { escapeHtml, statusNote } from '../core/utils.js';
import { aiClient, AI_DEFAULTS } from '../api/ai.js';
import {
  runAssistant, restoreConversation, conversationLength, assistantMode,
  setAllowDestructive, getAllowDestructive,
} from './aiTools.js';
import { ATTACHMENT_ACCEPT, ATTACHMENT_LIMIT, readAttachment } from './aiAttachments.js';
import { deleteSession, listSessions, newHistoryId, readSession, saveTurn } from './aiHistory.js';
import {
  runTranslate, pendingStats, defaultTargetLang, langName, commonLangs,
} from './aiTranslate.js';
import { languages, addLanguage, i18nState } from '../core/i18n.js';
import { showDialog } from './toolbar.js';

const els = {};
let _inited = false;
let _busy = false;          // 正在对话（含工具执行）
let _ctl = null;            // 当前对话 {cancel}
let _mode = 'auto';
let runningScope = '';
let draftFiles = [];
let readingFiles = false;
let attachmentRevision = 0;
let followLog = true;
let currentSession = null;
let historyWrites = Promise.resolve();
let historyRequest = 0;
let _trCtl = null;          // 当前翻译 {cancel}

/* ─────────────────────────── 小工具 ─────────────────────────── */

const t = (s) => document.createTextNode(String(s ?? ''));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function scrollLog() {
  const box = els.log;
  if (!box) return;
  if (followLog) box.scrollTop = box.scrollHeight;
}

function clearEmptyHint() {
  const hint = els.log?.querySelector('.ai-empty');
  if (hint) hint.remove();
}

/** 行内格式：**粗体** / `代码` / [文字](链接)；输入先转义，安全第一 */
function inlineHtml(raw) {
  let s = escapeHtml(String(raw ?? ''));
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

const CODE_FENCE = /^\s*```(.*)$/;
const HEADING = /^\s*#{1,4}\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.+)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/;

/**
 * 把模型正文画进容器（最小 markdown）。
 * 支持：```围栏（带语言名）、# 标题、- / * 列表、1. 有序列表、空行分段、行内格式。
 */
function renderMarkdown(container, text) {
  container.innerHTML = '';
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  const flushList = () => { list = null; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(CODE_FENCE);
    if (fence) {
      flushList();
      const lang = String(fence[1] || '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      const block = el('div', 'ai-code');
      if (lang) block.appendChild(el('div', 'ai-code-lang', lang));
      const pre = document.createElement('pre');
      pre.textContent = buf.join('\n');
      block.appendChild(pre);
      container.appendChild(block);
      continue;
    }

    if (!line.trim()) { flushList(); continue; }

    const h = line.match(HEADING);
    if (h) {
      flushList();
      const row = el('div', 'ai-line');
      row.appendChild(el('b', '', h[1]));
      container.appendChild(row);
      continue;
    }

    const li = line.match(BULLET) || line.match(NUMBERED);
    if (li) {
      if (!list) {
        list = document.createElement(/^\s*\d+[.)]/.test(line) ? 'ol' : 'ul');
        list.className = 'ai-list';
        container.appendChild(list);
      }
      const item = document.createElement('li');
      item.innerHTML = inlineHtml(li[1]);
      list.appendChild(item);
      continue;
    }

    flushList();
    const row = el('div', 'ai-line');
    row.innerHTML = inlineHtml(line);
    container.appendChild(row);
  }
}

/* ───────────────────────── 消息骨架 ───────────────────────── */

function addUserMessage(text, attachments) {
  clearEmptyHint();
  const wrap = el('div', 'ai-msg user');
  const bubble = el('div', 'ai-bubble');
  bubble.textContent = String(text);
  if (attachments.length) {
    const list = el('ul', 'ai-message-files');
    for (const file of attachments) list.appendChild(el('li', '', '附件 · ' + file.name));
    bubble.appendChild(list);
  }
  wrap.appendChild(bubble);
  els.log.appendChild(wrap);
  scrollLog();
}

/** 新建一条助手消息（返回可继续往里画的控制块） */
function newAssistantMessage() {
  clearEmptyHint();
  const wrap = el('div', 'ai-msg assistant');
  const bubble = el('div', 'ai-bubble');
  wrap.appendChild(bubble);
  els.log.appendChild(wrap);
  const msg = {
    wrap, bubble,
    think: null, thinkBody: null,
    live: null, textBox: null,
    toolBox: null, tools: new Map(),
  };
  scrollLog();
  return msg;
}

function ensureTextBox(msg) {
  if (!msg.textBox) {
    msg.textBox = el('div', 'ai-text');
    msg.bubble.appendChild(msg.textBox);
  }
  return msg.textBox;
}

function ensureToolBox(msg) {
  if (!msg.toolBox) {
    msg.toolBox = el('div', 'ai-toolbox');
    msg.bubble.appendChild(msg.toolBox);
  }
  return msg.toolBox;
}

/** 时长显示：1.8s / 12s / 1m03s */
function fmtSec(ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < 60000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 's';
  const m = Math.floor(v / 60000);
  const s = Math.round((v % 60000) / 1000);
  return m + 'm' + String(s).padStart(2, '0') + 's';
}

/** token 数显示：856 / 2.4k / 1.25M */
function fmtTok(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(v);
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'k';
  return (v / 1e6).toFixed(2) + 'M';
}

/** 「 · ↑输入(缓存 x) ↓输出 tok」；没有用量数据就不显示。缓存命中是"之前发过的前缀这次按缓存价计费"的部分 */
function usageSuffix(u) {
  if (!u) return '';
  const p = Number(u.prompt_tokens) || 0;
  const c = Number(u.completion_tokens) || 0;
  const hit = Number(u.cached_tokens) || 0;
  if (!p && !c) return '';
  return ' · ↑' + fmtTok(p) + (hit > 0 ? '(缓存 ' + fmtTok(hit) + ')' : '') + ' ↓' + fmtTok(c) + ' tok';
}

function clearRoundTimer(msg) {
  if (msg && msg.roundTimer) { clearInterval(msg.roundTimer); msg.roundTimer = null; }
}

/** 这一轮一开始就先挂一行「第 N 轮 · 用时 0.0s」，每 200ms 实时刷新，结束再定格成最终用时 + token 用量 */
function startRoundLine(msg, round) {
  clearRoundTimer(msg);
  const line = el('div', 'ai-round', '第 ' + round + ' 轮 · 用时 0.0s');
  msg.bubble.appendChild(line);
  const t0 = Date.now();
  msg.roundLine = line;
  msg.roundT0 = t0;
  msg.roundTimer = setInterval(() => {
    if (!line.isConnected) { clearRoundTimer(msg); return; }
    line.textContent = '第 ' + round + ' 轮 · 用时 ' + fmtSec(Date.now() - t0);

  }, 200);
  scrollLog();
}

function endRoundLine(msg, round, ms, usage) {
  clearRoundTimer(msg);
  const line = msg.roundLine && msg.roundLine.isConnected ? msg.roundLine : null;
  const used = Number(ms) || (msg.roundT0 ? Date.now() - msg.roundT0 : 0);
  const text = '第 ' + round + ' 轮 · 用时 ' + fmtSec(used) + usageSuffix(usage);
  if (line) { line.textContent = text; msg.bubble.appendChild(line); }
  else msg.bubble.appendChild(el('div', 'ai-round', text));
  msg.roundLine = null;
  if (usage) {
    msg.tokIn = (msg.tokIn || 0) + (Number(usage.prompt_tokens) || 0);
    msg.tokOut = (msg.tokOut || 0) + (Number(usage.completion_tokens) || 0);
    msg.tokHit = (msg.tokHit || 0) + (Number(usage.cached_tokens) || 0);
  }
  scrollLog();
}

function appendThinking(msg, text) {
  if (!text) return;
  if (!msg.think) {
    const det = document.createElement('details');
    det.className = 'ai-think';
    const sum = document.createElement('summary');
    sum.textContent = '思考过程';
    const body = el('div', 'ai-think-body');
    det.appendChild(sum);
    det.appendChild(body);
    msg.bubble.insertBefore(det, msg.bubble.firstChild);
    msg.think = det;
    msg.thinkBody = body;
  }
  msg.thinkBody.textContent += text;
  scrollLog();
}

/** 流式正文：先纯文本贴着写（快），整段说完后再换成一版渲染好的 markdown */
function appendLiveText(msg, text) {
  if (!text) return;
  const box = ensureTextBox(msg);
  if (!msg.live) {
    msg.live = el('div', 'ai-line');
    msg.live.style.whiteSpace = 'pre-wrap';
    box.appendChild(msg.live);
  }
  msg.live.textContent += text;
  scrollLog();
}

function setFinalText(msg, text) {
  const box = ensureTextBox(msg);
  msg.live = null;
  box.innerHTML = '';
  const holder = el('div', '');
  renderMarkdown(holder, text);
  while (holder.firstChild) box.appendChild(holder.firstChild);
  scrollLog();
}

/** 一轮里调了 ≥2 个工具时，把它们收进一个可折叠的组：默认收起，只留一行"调了哪些工具 + 状态"。
 *  adopt=true 时把 toolBox 里已有的散卡片也一起收进来（模型爱一轮调一个工具，攒到第 3 个就收拢）。 */
function makeToolGroup(msg, calls, adopt) {
  const box = ensureToolBox(msg);
  const det = document.createElement('details');
  det.className = 'ai-tool-group';
  const sum = document.createElement('summary');
  sum.className = 'ai-tool-group-head';
  sum.appendChild(el('span', 'ai-tool-group-ico', '🔧'));
  sum.appendChild(el('span', 'ai-tool-group-title', '调用 ' + (calls || []).length + ' 个工具'));
  sum.appendChild(el('span', 'ai-tool-group-sum', ''));
  const state = el('span', 'ai-tool-group-state', '执行中…');
  sum.appendChild(state);
  const body = el('div', 'ai-tool-group-body');
  det.appendChild(sum);
  det.appendChild(body);
  if (adopt) {
    Array.from(box.children).filter(n => n.classList && n.classList.contains('ai-tool')).forEach(n => body.appendChild(n));
  }
  box.appendChild(det);
  return { det, sum, state, body };
}

/** 组头（"调用 N 个工具" + 工具名×次数 + 状态）按组内实际卡片重新算。 */
function refreshToolGroup(group) {
  if (!group) return;
  const cards = Array.from(group.body.querySelectorAll('.ai-tool'));
  const counts = new Map();
  let done = 0;
  let failed = 0;
  cards.forEach(c => {
    const name = (c.querySelector('.ai-tool-name') || {}).textContent || 'tool';
    counts.set(name, (counts.get(name) || 0) + 1);
    if (c.classList.contains('ok')) done += 1;
    else if (c.classList.contains('bad')) failed += 1;
  });
  group.sum.querySelector('.ai-tool-group-title').textContent = '调用 ' + cards.length + ' 个工具';
  group.sum.querySelector('.ai-tool-group-sum').textContent = [...counts.entries()].map(([n, k]) => n + (k > 1 ? ' ×' + k : '')).join(' · ');
  if (done + failed < cards.length) {
    group.state.textContent = '执行中 ' + (done + failed) + '/' + cards.length;
  } else if (failed) {
    group.state.textContent = '✖ ' + failed + ' 个失败';
    group.det.open = true;
    group.det.classList.add('bad');
  } else {
    group.state.textContent = '✔ 全部成功';
    group.det.classList.add('ok');
  }
}

function addToolCard(msg, call, group) {
  const host = group ? group.body : ensureToolBox(msg);
  const card = el('div', 'ai-tool run');
  const head = el('div', 'ai-tool-head');
  head.appendChild(el('span', 'ai-tool-ico', '🔧'));
  head.appendChild(el('span', 'ai-tool-name', call.name || 'tool'));
  const sum = el('span', 'ai-tool-sum', '运行中…');
  head.appendChild(sum);
  card.appendChild(head);

  const det = document.createElement('details');
  det.className = 'ai-tool-args';
  const s = document.createElement('summary');
  s.textContent = '参数';
  const pre = document.createElement('pre');
  let argsText = '';
  try { argsText = JSON.stringify(call.args ?? {}, null, 1); } catch { argsText = String(call.args); }
  pre.textContent = argsText.length > 1200 ? argsText.slice(0, 1200) + '\n…' : argsText;
  det.appendChild(s);
  det.appendChild(pre);
  card.appendChild(det);
  host.appendChild(card);
  scrollLog();
  return { card, sum, det, group };
}

function finishToolCard(msg, res) {
  const ref = msg.tools.get(res.id);
  if (!ref) return;
  const r = res.result || {};
  if (r.ok) {
    ref.card.className = 'ai-tool ok';
    ref.sum.textContent = String(r.summary || '完成');
  } else {
    ref.card.className = 'ai-tool bad';
    ref.sum.textContent = String(r.error || '失败');
    ref.det.open = true;                 // 失败了就把参数摊开，省得用户再点两层
  }
  // 把 warnings 也摊开给用户看（比如"变量不存在，已跳过"）
  const warns = Array.isArray(r.warnings) ? r.warnings : [];
  if (warns.length) {
    const note = el('div', 'ai-note', '⚠ ' + warns.join('；'));
    ref.card.appendChild(note);
  }
  // 失败时把"真实可用的清单"也摊给用户看：这就是模型下一轮要用的信息，用户能一眼看出是名字对不上还是别的问题
  if (!r.ok && typeof r.hint === 'string' && r.hint.trim()) {
    const tip = r.hint.trim();
    ref.card.appendChild(el('div', 'ai-note', '可用：' + (tip.length > 260 ? tip.slice(0, 260) + '…' : tip)));
  }
  // 组状态：执行中 n/m → 全部成功 / 几个失败；有失败就把组也展开
  if (ref.group) refreshToolGroup(ref.group);
  scrollLog();
}

function addErrorNote(msg, text) {
  const box = msg.bubble;
  box.appendChild(el('div', 'ai-err', String(text || '出错了')));
  scrollLog();
}

/* ───────────────────────── 状态点 ───────────────────────── */


function refreshStatus() {
  if (!els.dot) return;
  const st = aiClient.status;
  let cls = 'ok';
  let label = '就绪';
  let title = st.model;
  if (!st.online) {
    cls = 'off';
    label = '连接中';
    title = '正在连接设计器后端';
  } else if (!st.enabled || !st.available) {
    cls = 'bad';
    label = st.enabled ? '后端不支持' : '已停用';
    title = st.enabled ? '当前后端不支持 AI' : '在设置中启用 AI 助手';
  } else if (!st.has_key) {
    cls = 'wait';
    label = '待配置';
    title = '在设置中填写 API Key';
  }
  els.dot.className = 'ai-dot ' + cls;
  els.dot.title = title;
  els.statusText.textContent = label;
  els.statusText.title = title;
}

function refreshScope() {
  if (!els.scope) return;
  const draft = els.input.value.trim();
  const scope = runningScope || (_mode === 'auto' && !draft ? 'auto' : assistantMode(draft, _mode));
  const page = project.currentPage();
  els.scope.dataset.scope = scope;
  els.scopeTag.textContent = { auto: '自动', chat: '聊天', project: '工程' }[scope];
  const label = scope === 'project'
    ? (page ? '当前页 · ' + page.name : '当前工程')
    : (scope === 'chat' ? '仅发送聊天消息和本条附件' : '按提问选择聊天或工程');
  els.scopeText.textContent = label;
  els.scopeText.title = label;
}

function setBusyUI(busy) {
  _busy = busy;
  if (!busy) runningScope = '';
  els.send.disabled = busy || readingFiles;
  els.historyBtn.disabled = busy;
  els.attach.disabled = readingFiles;
  els.send.classList.toggle('hidden', busy);
  els.stop.classList.toggle('hidden', !busy);
  els.mode.forEach(button => { button.disabled = busy; });
  refreshScope();
}

function taskStatus(text = '', state = '') {
  els.taskStatus.dataset.state = state;
  els.taskStatus.textContent = text;
}

function finishStatus(info) {
  if (info?.budget_limit) return '已停止 · 输入预算用完';
  if (info?.batch_limit) return '已停止 · 达到工具批次上限';
  if (info?.truncated) return '已停止 · 任务未完成';
  if (info?.finish_reason === 'length') return '已停止 · 达到回复长度上限';
  return '已完成';
}

function configMissingHint() {
  const st = aiClient.status;
  if (!st.online) return '设计器后端未连接，连接后可重新发送。';
  if (st.enabled === false) return '在 AI 设置中启用助手后再发送。';
  if (!st.available) return '当前设计器后端不支持 AI。';
  if (!st.has_key) return '在 AI 设置中填写 API Key 后再发送。';
  return '';
}

function send(text, attachments = []) {
  const msgText = String(text ?? '').trim() || (attachments.length ? '请概述附件内容。' : '');
  if (!msgText || _busy) return false;
  const hint = configMissingHint();
  if (hint) {
    statusNote(hint, 6000);
    if (aiClient.status.online && aiClient.status.available) openSettingsDialog();
    return false;
  }
  setHistoryVisible(false);
  runningScope = assistantMode(msgText, _mode);
  setBusyUI(true);
  taskStatus('正在处理…', 'running');
  const at = Date.now();
  const create = !currentSession;
  if (create) {
    currentSession = {
      id: newHistoryId(),
      title: msgText.replace(/\s+/g, ' ').slice(0, 55),
      projectName: String(project.data?.meta?.name || '').slice(0, 80),
      updatedAt: at,
    };
  }
  const session = currentSession;
  const turn = {
    id: newHistoryId(), at, text: msgText, pending: true, reasoning: '',
    attachments: attachments.map(file => ({ name: file.name })),
    rounds: [], notes: [],
    context: { mode: runningScope, text: msgText.slice(0, 1350), intent: msgText.slice(0, 900) },
  };
  persistTurn(session, turn, create);
  let msg = null;
  let round = null;
  const note = (kind, text) => {
    turn.notes.push({ kind, text });
    if (kind === 'ai-err') addErrorNote(msg, text);
    else msg.bubble.appendChild(el('div', kind, text));
  };
  const finish = (status, state) => {
    taskStatus(status, state);
    statusNote('AI 助手：' + status, 6500);
    turn.pending = false;
    persistTurn(session, turn);
    _ctl = null;
    setBusyUI(false);
    refreshStatus();
  };
  _ctl = runAssistant({
    text: msgText,
    mode: _mode,
    attachments,
    handlers: {
      onUser: (tx) => { followLog = true; addUserMessage(tx, turn.attachments); msg = newAssistantMessage(); },
      onTurn: context => { turn.context = context; },
      onRound: (n) => {
        round = { text: '' };
        turn.rounds.push(round);
        if (!msg) msg = newAssistantMessage();
        // 每轮单独用一个文本容器：这样上一轮的工具卡片不会被下一轮的正文顶到后面去
        msg.textBox = null;
        msg.live = null;
        startRoundLine(msg, n);
      },
      onRoundEnd: (info) => {
        if (!msg || !info) return;
        round.info = info;
        endRoundLine(msg, info.round, info.elapsed_ms, info.usage);
      },
      onDelta: (d) => {
        if (!msg) msg = newAssistantMessage();
        if (d?.reasoning) {
          turn.reasoning += d.reasoning;
          appendThinking(msg, d.reasoning);
        }
        if (d?.text) {
          round.text += d.text;
          appendLiveText(msg, d.text);
        }
      },
      onToolStart: (calls) => {
        if (!msg) msg = newAssistantMessage();
        const list = (calls || []).filter(c => c && c.name);
        if (!list.length) return;
        // 一轮调了多个工具就收进可折叠的组（默认收起：只显示「调了哪些工具 + 成功/失败」）；
        // 模型要是爱一轮只调一个，散卡片攒到第 3 个也一并收拢，别让聊天区越滚越长。
        const loose = msg.toolBox ? Array.from(msg.toolBox.children).filter(n => n.classList && n.classList.contains('ai-tool')).length : 0;
        const group = (list.length >= 2 || loose >= 2) ? makeToolGroup(msg, list, loose > 0) : null;
        list.forEach(c => {
          const ref = addToolCard(msg, c, group);
          msg.tools.set(String(c.id || ''), ref);
        });
        if (group) refreshToolGroup(group);
      },
      onToolEnd: (results) => {
        if (!msg) return;
        round.tools = (results || []).map(r => ({
          name: r.name, ok: !!r.result?.ok,
          summary: r.result?.summary || r.result?.error || (r.result?.ok ? '完成' : '失败'),
        }));
        (results || []).forEach(r => finishToolCard(msg, r));
        persistTurn(session, turn);
      },
      onCompact: () => {
        taskStatus('上下文已压缩，正在继续…', 'running');
        note('ai-note', '模型上下文超限，已压缩历史并重新请求。');
      },
      onContent: (content) => {
        if (!msg) msg = newAssistantMessage();
        round.text = content;
        setFinalText(msg, content);
      },
      onDone: (info) => {
        if (msg) {
          clearRoundTimer(msg);
          if (info?.truncated) {
            const lim = Number(info?.batch_limit) || 0;
            const bud = Number(info?.budget_limit) || 0;
            note('ai-note', bud > 0
              ? '（本次提问的输入已到预算上限 ' + fmtTok(bud) + ' token，我先停下 —— 再发一句「继续」会重新给一份预算）'
              : (lim > 0
                ? '（工具调用批次到你设的上限 ' + lim + ' 了，我先停下 —— 再发一句「继续」就能接着做）'
                : '（这次没做完 —— 可以再发一句「继续」让我接着做）'));
          }
          if (info?.finish_reason === 'length') {
            note('ai-note', '已达到回复长度上限。可发「继续」接着回答。');
          }
          if (Number(info?.rounds) > 1) {
            const u = info?.usage || null;
            const tok = usageSuffix(u) || (msg.tokIn || msg.tokOut
              ? ' · ↑' + fmtTok(msg.tokIn) + (msg.tokHit > 0 ? '(缓存 ' + fmtTok(msg.tokHit) + ')' : '') + ' ↓' + fmtTok(msg.tokOut) + ' tok'
              : '');
            note('ai-round-total', '⏱ 共 ' + info.rounds + ' 轮 · 总用时 ' + fmtSec(info.elapsed_ms) + tok);
            scrollLog();
          }
        }
        const status = finishStatus(info);
        finish(status, status === '已完成' ? 'done' : 'stopped');
      },
      onError: (message, code) => {
        if (msg) clearRoundTimer(msg);
        if (!msg) msg = newAssistantMessage();
        if (code === 'cancel') {
          note('ai-note', '（已停止）');
          finish('已停止', 'stopped');
          return;
        }
        note('ai-err', message);
        const reason = {
          context_limit: '模型上下文超限', timeout: '请求超时', network: '连接中断',
          offline: '连接中断', tool: '工具任务中断',
        }[code] || '请求失败';
        finish('已停止 · ' + reason, 'error');
      },
    },
  });
  return true;
}

function stop() {
  try { _ctl?.cancel(); } catch { /* 已经结束 */ }
  try { _trCtl?.cancel(); } catch { /* 已经结束 */ }
  setBusyUI(false);
}

/* ───────────────────────── 设置对话框 ───────────────────────── */

const PROVIDER_PRESETS = [
  { id: 'xiaomi', name: '小米 MiMo', base_url: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', thinking: 'disabled' },
  { id: 'lmstudio', name: 'LM Studio（本机/局域网）', base_url: 'http://127.0.0.1:1234/v1', model: '', thinking: 'auto' },
  { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', thinking: 'disabled' },
  { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', thinking: 'disabled' },
  { id: 'custom', name: '自定义 / 其它', base_url: '', model: '', thinking: 'disabled' },
];

const THINKING_OPTS = [
  { v: 'disabled', t: '关闭（推荐：快，不显示思考过程）' },
  { v: 'auto', t: '交给模型（会慢一些，但复杂任务更稳）' },
];

async function openSettingsDialog() {
  let cfg = { ...AI_DEFAULTS, has_key: false, api_key_masked: '', profiles: [], active: '' };
  try {
    const got = await aiClient.getConfig();
    if (got && typeof got === 'object') cfg = { ...cfg, ...got };
  } catch (e) {
    statusNote('读 AI 配置失败：' + (e && e.message ? e.message : e), 8000);
  }
  const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  const state = {
    profileId: String(cfg.active || (profiles[0] && profiles[0].id) || ''),
    newMode: !profiles.length,
  };

  const row = (label, inner) => `<div style="display:grid;grid-template-columns:96px 1fr;gap:8px;align-items:center;margin:7px 0">`
    + `<div style="color:var(--text-2)">${escapeHtml(label)}</div><div>${inner}</div></div>`;
  const inputCss = 'width:100%;box-sizing:border-box;padding:4px 6px';
  const thinkingSel = (cur) => THINKING_OPTS.map(o => `<option value="${o.v}"${(cur || 'disabled') === o.v ? ' selected' : ''}>${escapeHtml(o.t)}</option>`).join('');

  const provOpts = profiles.map(p => {
    const nm = String(p.name || '');
    const md = String(p.model || '');
    const label = nm && md && nm.includes(md) ? nm : `${nm || md || p.id}（${md || '未填模型'}）`;
    return `<option value="${escapeHtml(p.id)}"${p.id === state.profileId && !state.newMode ? ' selected' : ''}>`
      + `${escapeHtml(label)}</option>`;
  }).join('')
    + `<option value="__new__"${state.newMode ? ' selected' : ''}>＋ 新增 / 换服务商</option>`;

  const presetBtns = PROVIDER_PRESETS.map(p =>
    `<button type="button" class="tb-btn sm" data-preset="${p.id}">${escapeHtml(p.name)}</button>`).join('');

  const body = `
    ${row('服务商', `<select id="aiCfgProvider" style="${inputCss}">${provOpts}</select>`)}
    <div id="aiCfgPresets" class="ai-cfg-presets"${state.newMode ? '' : ' style="display:none"'}>${presetBtns}</div>
    ${row('启用', `<label class="ai-chk" style="margin:0"><input type="checkbox" id="aiCfgEnabled"${cfg.enabled ? ' checked' : ''}> 启用 AI 助手</label>`)}
    ${row('接口地址', `<input id="aiCfgBase" style="${inputCss}" value="${escapeHtml(cfg.base_url || '')}" placeholder="https://api.xiaomimimo.com/v1">`)}
    ${row('模型', `<input id="aiCfgModel" style="${inputCss}" value="${escapeHtml(cfg.model || '')}" placeholder="mimo-v2.6-flash">`)}
    ${row('API Key', `<input id="aiCfgKey" type="password" style="${inputCss}" value="" placeholder="${cfg.has_key ? '已保存（' + escapeHtml(cfg.api_key_masked || '') + '），留空不改' : '在这里填 API Key'}">`)}
    ${row('温度', `<input id="aiCfgTemp" type="number" step="0.1" min="0" max="2" style="${inputCss};width:90px" value="${Number(cfg.temperature ?? 0.2)}">`)}
    ${row('最大 tokens', `<span style="display:inline-flex;align-items:center;gap:6px"><input id="aiCfgTokens" type="number" step="1" min="0.1" max="200" style="${inputCss};width:90px" value="${Math.round(Number(cfg.max_tokens ?? 4000) / 100) / 10}"><span style="color:var(--text-2)">k token</span></span>`)}
    ${row('思考过程', `<select id="aiCfgThinking" style="${inputCss}">${thinkingSel(cfg.thinking)}</select>`)}
    ${row('单次超时', `<span style="display:inline-flex;align-items:center;gap:6px"><input id="aiCfgTimeout" type="number" step="5" min="10" max="3600" style="${inputCss};width:90px" value="${Number(cfg.timeout ?? 90)}"><span style="color:var(--text-2)">秒</span></span>`)}
    ${row('工具批次上限', `<span style="display:inline-flex;align-items:center;gap:6px"><input id="aiCfgRounds" type="number" step="1" min="0" max="9999" style="${inputCss};width:80px" value="${Number(cfg.max_rounds ?? 0)}"><span style="color:var(--text-2)">批（<b>0 = 不限制</b>）</span></span>`)}
    ${row('输入预算', `<span style="display:inline-flex;align-items:center;gap:6px"><input id="aiCfgBudget" type="number" step="5" min="0" max="2000" style="${inputCss};width:90px" value="${Math.round(Number(cfg.budget_tokens ?? 60000) / 1000)}"><span style="color:var(--text-2)">k token（<b>0 = 不限制</b>）</span></span>`)}
    <div class="ai-cfg-foot">
      <button type="button" class="tb-btn sm" id="aiCfgTest">测试连接</button>
      <div id="aiTestOut" class="ai-test-out"></div>
    </div>`;

  showDialog({
    title: 'AI 设置',
    body,
    wide: true,
    okText: '保存',
    onOk: async () => {
      const g = (id) => document.getElementById(id);
      const base = (g('aiCfgBase')?.value || '').trim();
      const model = (g('aiCfgModel')?.value || '').trim();
      const key = (g('aiCfgKey')?.value || '').trim();
      const out = g('aiTestOut');
      const badText = (s2) => { if (out) { out.className = 'ai-test-out bad'; out.textContent = s2; } };
      if (!/^https?:\/\//i.test(base)) { badText('接口地址要以 http:// 或 https:// 开头'); return false; }
      if (!model) { badText('模型名不能为空（LM Studio 里点开模型列表复制名字）'); return false; }
      const patch = {
        enabled: !!g('aiCfgEnabled')?.checked,
        base_url: base,
        model,
        temperature: Number(g('aiCfgTemp')?.value || 0.2),
        max_tokens: Math.round(Number(g('aiCfgTokens')?.value || 4) * 1000),
        thinking: g('aiCfgThinking')?.value || 'disabled',
        timeout: Number(g('aiCfgTimeout')?.value || 90),
        max_rounds: Number(g('aiCfgRounds')?.value || 0),
        budget_tokens: Math.round(Number(g('aiCfgBudget')?.value ?? 60) * 1000),
        api_key: key || '__keep__',
      };
      if (!state.newMode && state.profileId) patch.profile_id = state.profileId;
      try {
        const saved = await aiClient.saveConfig(patch);
        refreshStatus();
        // 后端只夹"明显非法"的值；万一被夹了，明确告诉用户，别让他以为设置没生效
        const fixed = [];
        if (Number(saved?.max_tokens) !== patch.max_tokens) fixed.push('最大 tokens');
        if (Number(saved?.timeout) !== patch.timeout) fixed.push('单次超时');
        if (Number(saved?.max_rounds) !== patch.max_rounds) fixed.push('工具批次上限');
        if (Number(saved?.budget_tokens) !== patch.budget_tokens) fixed.push('输入预算');
        if (Number(saved?.temperature) !== patch.temperature) fixed.push('温度');
        statusNote(fixed.length
          ? 'AI 配置已保存（' + fixed.join('、') + ' 超出允许范围，后端按边界值修正了）'
          : 'AI 配置已保存' + (key ? '（Key 已更新）' : ''), 6000);
        return true;
      } catch (e) {
        badText('保存失败：' + (e && e.message ? e.message : e) + '（AI 设置只有管理员能改）');
        return false;
      }
    },
  });

  // showDialog 把 body 塞进 #dlgBody 之后才拿得到元素
  const fill = (p) => {
    const g = (id) => document.getElementById(id);
    if (!g('aiCfgBase')) return;
    g('aiCfgBase').value = String(p.base_url || '');
    g('aiCfgModel').value = String(p.model || '');
    g('aiCfgKey').value = '';
    g('aiCfgKey').placeholder = p.has_key
      ? '已保存（' + (p.api_key_masked || '') + '），留空不改'
      : '在这里填 API Key';
    g('aiCfgTemp').value = Number(p.temperature ?? 0.2);
    g('aiCfgTokens').value = Math.round(Number(p.max_tokens ?? 4000) / 100) / 10;
    g('aiCfgThinking').value = p.thinking === 'auto' ? 'auto' : 'disabled';
    g('aiCfgTimeout').value = Number(p.timeout ?? 90);
    g('aiCfgRounds').value = Number(p.max_rounds ?? 0);
    g('aiCfgBudget').value = Math.round(Number(p.budget_tokens ?? 60000) / 1000);
    const out = document.getElementById('aiTestOut');
    if (out) { out.className = 'ai-test-out'; out.textContent = ''; }
  };
  const syncPresets = () => {
    const box = document.getElementById('aiCfgPresets');
    if (box) box.style.display = state.newMode ? '' : 'none';
  };
  const provSel = document.getElementById('aiCfgProvider');
  if (provSel) {
    provSel.onchange = () => {
      const v = provSel.value;
      if (v === '__new__') {
        state.newMode = true;
        state.profileId = '';
        syncPresets();
        const baseEl = document.getElementById('aiCfgBase');
        if (baseEl) baseEl.focus();
        return;
      }
      const p = profiles.find(x => x.id === v);
      if (!p) return;
      state.newMode = false;
      state.profileId = p.id;
      syncPresets();
      fill(p);
    };
  }
  const presetBox = document.getElementById('aiCfgPresets');
  if (presetBox) {
    presetBox.onclick = (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-preset]') : null;
      if (!btn) return;
      const p = PROVIDER_PRESETS.find(x => x.id === btn.dataset.preset);
      if (!p) return;
      // 预设 = 一份还没保存的新配置；保存时才真正落库
      state.newMode = true;
      state.profileId = '';
      fill({ ...p, has_key: false, api_key_masked: '', max_tokens: 4000, temperature: 0.2,
             timeout: 90, max_rounds: 0, budget_tokens: 60000 });
      const keyEl = document.getElementById('aiCfgKey');
      const baseEl = document.getElementById('aiCfgBase');
      if (baseEl && !baseEl.value) baseEl.focus();
      else if (keyEl && !keyEl.value) keyEl.focus();
    };
  }

  const testBtn = document.getElementById('aiCfgTest');
  if (testBtn) {
    testBtn.onclick = async () => {
      const out = document.getElementById('aiTestOut');
      if (out) { out.className = 'ai-test-out wait'; out.textContent = '正在用已保存的配置问模型一句…'; }
      testBtn.disabled = true;
      try {
        const r = await aiClient.test();
        if (out) {
          if (r && r.ok) { out.className = 'ai-test-out ok'; out.textContent = `连接正常：${r.model || ''} ${r.latency_ms}ms` + (r.note ? `（${r.note}）` : ''); }
          else { out.className = 'ai-test-out bad'; out.textContent = '连接失败：' + ((r && (r.error || r.code)) || '未知原因'); }
        }
      } catch (e) {
        if (out) { out.className = 'ai-test-out bad'; out.textContent = '测试失败：' + (e && e.message ? e.message : e); }
      } finally {
        testBtn.disabled = false;
      }
    };
  }
}

/* ───────────────────────── 翻译对话框 ───────────────────────── */

function langOptionsHtml(selected) {
  const list = languages();
  const def = list[0]?.code || '';
  const others = list.filter(l => l.code !== def);
  if (!others.length) return `<option value="">（还没有第二语言，先在下面加一门）</option>`;
  const want = selected || defaultTargetLang();
  return others.map(l => `<option value="${escapeHtml(l.code)}"${l.code === want ? ' selected' : ''}>`
    + `${escapeHtml(l.label || langName(l.code))}（${escapeHtml(l.code)}）</option>`).join('');
}

async function openTranslateDialog() {
  let stats = { total: 0, langs: [] };
  try { stats = pendingStats(); } catch { stats = { total: 0, langs: [] }; }
  const cur = project.currentPage();
  const curName = cur ? (cur.name || '') : '';

  const body = `
    <div class="ai-tr-stat">
      工程里可翻译文字 <b>${stats.total}</b> 条；目标语言：
      <select id="aiTrLang" style="padding:3px 6px">${langOptionsHtml('')}</select>
      范围：
      <select id="aiTrScope" style="padding:3px 6px">
        <option value="all">整个工程</option>
        <option value="page">当前页（${escapeHtml(curName || '无')}）</option>
      </select>
    </div>
    <div style="margin:8px 0;display:flex;gap:6px;align-items:center">
      <span style="color:var(--text-2)">加一门语言：</span>
      <select id="aiTrPick" style="padding:3px 6px">
        ${commonLangs().map(l => `<option value="${l.code}">${escapeHtml(l.name)}（${l.code}）</option>`).join('')}
      </select>
      <button type="button" class="tb-btn sm" id="aiTrAdd">添加</button>
    </div>
    <div class="ai-tr-prog" id="aiTrProg" style="display:none"><div class="ai-tr-bar" id="aiTrBar"></div></div>
    <div class="ai-tr-out" id="aiTrOut"></div>
    <div class="ai-cfg-foot">
      <label class="ai-chk" style="margin-right:8px" title="英文/德文通常比中文长，翻完自动把放不下的控件字号缩小（只改字号，不动控件位置和大小）"><input type="checkbox" id="aiTrAutofit" checked> 自动缩放字号适配</label>
      <button type="button" class="tb-btn primary sm" id="aiTrStart">开始翻译</button>
      <span style="color:var(--text-2);font-size:12px">每批 40 条（自动分批）；只翻"还没有译文"的条目；翻完一次提交，Ctrl+Z 可整体撤销。</span>
    </div>`;

  showDialog({ title: 'AI 翻译', body, wide: true, okText: '关闭', onOk: null });

  const g = (id) => document.getElementById(id);
  const selLang = g('aiTrLang');
  const selScope = g('aiTrScope');
  const prog = g('aiTrProg');
  const bar = g('aiTrBar');
  const out = g('aiTrOut');
  const startBtn = g('aiTrStart');

  const refreshLangSelect = (keep) => {
    if (!selLang) return;
    const want = keep || selLang.value;
    selLang.innerHTML = langOptionsHtml(want);
  };

  const addBtn = g('aiTrAdd');
  if (addBtn) {
    addBtn.onclick = () => {
      const code = String(g('aiTrPick')?.value || '').trim();
      if (!code) return;
      try {
        addLanguage(code, langName(code));
        project.commit('AI 添加语言（' + code + '）');
        refreshLangSelect(code);
        if (out) { out.className = 'ai-tr-out'; out.textContent = ''; }
        statusNote('已添加语言：' + (langName(code) || code), 4000);
      } catch (e) {
        if (out) { out.className = 'ai-tr-out bad'; out.textContent = '添加语言失败：' + (e && e.message ? e.message : e); }
      }
    };
  }

  if (startBtn) {
    startBtn.onclick = () => {
      const lang = String(selLang?.value || '');
      const scope = String(selScope?.value || 'all');
      if (!lang) {
        if (out) { out.className = 'ai-tr-out bad'; out.textContent = '先选一门目标语言（没有就点上面的「添加」）。'; }
        return;
      }
      startBtn.disabled = true;
      if (prog) { prog.style.display = ''; }
      if (bar) bar.style.width = '0%';
      if (out) { out.className = 'ai-tr-out'; out.textContent = '正在翻译…'; }
      _trCtl = runTranslate({
        lang,
        scope,
        autofit: !!g('aiTrAutofit')?.checked,
        handlers: {
          onProgress: (p) => {
            const done = Number(p?.done) || 0;
            const total = Math.max(1, Number(p?.total) || 1);
            if (bar) bar.style.width = Math.round((done / total) * 100) + '%';
            if (out) {
              out.className = 'ai-tr-out';
              out.textContent = `正在翻译（${done}/${total}）…`;
            }
          },
          onDone: (info) => {
            _trCtl = null;
            startBtn.disabled = false;
            if (bar) bar.style.width = '100%';
            const filled = Number(info?.filled) || 0;
            const unknown = Number(info?.unknown) || 0;
            const same = Number(info?.same) || 0;
            const parts = [];
            if (info?.note) parts.push(info.note);
            else {
              parts.push(`写入 ${filled} 条译文`);
              if (unknown) parts.push(`丢弃 ${unknown} 条（模型编的原句）`);
              if (same) parts.push(`${same} 条与原文相同已跳过`);
              const fit = info?.autofit;
              if (fit && Number(fit.shrunk) > 0) parts.push(`自动缩小 ${fit.shrunk} 个控件的字号以适配`);
              if (fit && Number(fit.tooLong) > 0) parts.push(`${fit.tooLong} 个控件缩到 ${fit.minPx}px 仍放不下（建议加宽控件或缩短文案）`);
              if (info?.error) parts.push('翻译中断：' + info.error);
              if (info?.cancelled) parts.push('已取消');
            }
            if (out) {
              out.className = 'ai-tr-out ' + (filled > 0 ? 'ok' : (info?.error ? 'bad' : ''));
              out.textContent = parts.join('；') + (filled > 0 ? '。已切到目标语言预览，Ctrl+Z 可整体撤销。' : '');
            }
            refreshLangSelect(lang);
            const status = info?.error || info?.cancelled ? 'AI 翻译已停止' : 'AI 翻译完成';
            statusNote(status + '：' + parts.join('；'), 6000);
          },
          onError: (message) => {
            _trCtl = null;
            startBtn.disabled = false;
            if (out) { out.className = 'ai-tr-out bad'; out.textContent = '翻译失败：' + message; }
            statusNote('AI 翻译已停止 · 翻译失败', 6500);
          },
        },
      });
    };
  }
}

/* ───────────────────────── 入口 ───────────────────────── */



function renderAttachments(message = '') {
  els.files.replaceChildren();
  els.files.hidden = !draftFiles.length;
  draftFiles.forEach((file, index) => {
    const chip = el('div', 'ai-file-chip');
    if (file.dataUrl) {
      const image = el('img');
      image.src = file.dataUrl;
      image.alt = '';
      chip.appendChild(image);
    }
    const label = el('span', '', file.name + (file.truncated ? '（前 ' + file.text.length + ' 字符）' : ''));
    label.title = label.textContent;
    const remove = el('button', 'ai-file-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', '移除附件 ' + file.name);
    remove.onclick = () => {
      draftFiles.splice(index, 1);
      renderAttachments();
      els.attach.focus();
    };
    chip.append(label, remove);
    els.files.appendChild(chip);
  });
  const hint = draftFiles.some(file => file.dataUrl) ? '图片需要模型支持识图' : '';
  els.fileInfo.textContent = message || (readingFiles ? '正在读取附件…' : hint);
  els.fileInfo.hidden = !els.fileInfo.textContent;
  setBusyUI(_busy);
}

function clearAttachments() {
  attachmentRevision++;
  readingFiles = false;
  draftFiles = [];
  renderAttachments();
}

async function attachFiles(files) {
  if (!files.length || readingFiles) return;
  const remaining = ATTACHMENT_LIMIT - draftFiles.length;
  if (!remaining) {
    renderAttachments('每条消息最多附加 ' + ATTACHMENT_LIMIT + ' 个文件。');
    return;
  }
  const revision = ++attachmentRevision;
  readingFiles = true;
  renderAttachments();
  const notes = [];
  for (const file of files.slice(0, remaining)) {
    if (revision !== attachmentRevision) return;
    try {
      const result = await readAttachment(file);
      if (revision === attachmentRevision) draftFiles.push(result);
    } catch (error) {
      notes.push(file.name + '：' + error.message);
    }
  }
  if (revision !== attachmentRevision) return;
  if (files.length > remaining) notes.push('每条消息最多附加 ' + ATTACHMENT_LIMIT + ' 个文件。');
  readingFiles = false;
  renderAttachments(notes.join('\n'));
}


/* ───────────────────────── 会话记录 ───────────────────────── */

function persistTurn(session, turn, create = false) {
  const entry = structuredClone(turn);
  historyWrites = historyWrites.then(async () => {
    if (!await saveTurn(session, entry, create)) {
      statusNote('这条会话已被删除，请新建会话后继续。', 6000);
    }
  }).catch(() => statusNote('浏览器未能保存这条会话。', 8000));
}

function historyStatus(message = '') {
  els.historyStatus.textContent = message;
  els.historyStatus.hidden = !message;
}

function setHistoryVisible(open) {
  historyRequest++;
  els.history.hidden = !open;
  els.scope.hidden = open;
  els.log.hidden = open;
  els.form.hidden = open;
  els.historyBtn.setAttribute('aria-expanded', String(open));
}

async function showHistory() {
  setHistoryVisible(true);
  const request = historyRequest;
  els.historyBack.focus();
  els.historyList.replaceChildren();
  historyStatus('正在读取会话…');
  try {
    await historyWrites;
    const sessions = await listSessions();
    if (request !== historyRequest) return;
    historyStatus(sessions.length ? '' : '还没有历史会话。');
    for (const session of sessions) {
      const row = el('li', 'ai-history-row');
      const open = el('button', 'ai-history-open');
      open.type = 'button';
      open.title = session.title;
      if (session.id === currentSession?.id) open.setAttribute('aria-current', 'true');
      open.append(el('strong', '', session.title));
      const date = new Date(session.updatedAt).toLocaleString();
      open.append(el('small', '', session.projectName ? session.projectName + ' · ' + date : date));
      open.onclick = () => void openHistorySession(session.id);
      const remove = el('button', 'ai-history-remove', '删除');
      remove.type = 'button';
      remove.setAttribute('aria-label', '删除会话 ' + session.title);
      remove.onclick = () => confirmDeleteSession(session);
      row.append(open, remove);
      els.historyList.appendChild(row);
    }
  } catch {
    if (request === historyRequest) historyStatus('无法读取浏览器中的历史会话。');
  }
}

async function openHistorySession(id) {
  const request = ++historyRequest;
  historyStatus('正在打开会话…');
  try {
    await historyWrites;
    const stored = await readSession(id);
    if (request !== historyRequest) return;
    if (!stored) { await showHistory(); return; }
    switchConversation(stored.session, stored.turns);
    els.input.focus();
  } catch {
    if (request === historyRequest) historyStatus('无法打开这条会话。');
  }
}

function confirmDeleteSession(session) {
  showDialog({
    title: '删除历史会话',
    body: '<p>确定删除「' + escapeHtml(session.title) + '」？</p><p id="aiDeleteError" role="alert"></p>',
    okText: '删除',
    onOk: async () => {
      try {
        await historyWrites;
        await deleteSession(session.id);
        if (currentSession?.id === session.id) switchConversation();
        await showHistory();
        return true;
      } catch {
        document.getElementById('aiDeleteError').textContent = '无法删除这条会话，请重试。';
        return false;
      }
    },
  });
}

function renderSavedTurn(turn) {
  addUserMessage(turn.text, turn.attachments);
  const msg = newAssistantMessage();
  if (turn.reasoning) appendThinking(msg, turn.reasoning);
  for (const round of turn.rounds) {
    msg.textBox = null;
    if (round.text) setFinalText(msg, round.text);
    if (round.info) endRoundLine(msg, round.info.round, round.info.elapsed_ms, round.info.usage);
    if (round.tools?.length) {
      const details = el('details', 'ai-history-tools');
      details.append(el('summary', '', '执行记录 · ' + round.tools.length + ' 项'));
      const list = el('ul', '');
      for (const tool of round.tools) {
        const line = el('li', '', tool.name + ' · ' + tool.summary);
        if (!tool.ok) line.className = 'failed';
        list.appendChild(line);
      }
      details.appendChild(list);
      msg.bubble.appendChild(details);
    }
  }
  for (const note of turn.notes) {
    if (note.kind === 'ai-err') addErrorNote(msg, note.text);
    else msg.bubble.appendChild(el('div', note.kind, note.text));
  }
  if (turn.pending) msg.bubble.appendChild(el('div', 'ai-note', '这条回复未保存完整。'));
}

function switchConversation(session = null, savedTurns = []) {
  restoreConversation(savedTurns.map(turn => turn.context).filter(Boolean));
  currentSession = session;
  setHistoryVisible(false);
  taskStatus();
  els.input.value = '';
  clearAttachments();
  autoGrow();
  followLog = false;
  if (savedTurns.length) {
    els.log.replaceChildren();
    for (const turn of savedTurns) renderSavedTurn(turn);
  } else {
    els.log.replaceChildren(els.welcome.content.cloneNode(true));
  }
  followLog = true;
  scrollLog();
}

function autoGrow() {
  const box = els.input;
  box.style.height = 'auto';
  box.style.height = Math.min(128, Math.max(54, box.scrollHeight)) + 'px';
  refreshScope();
}

function submitMessage() {
  if (readingFiles || !send(els.input.value, draftFiles.slice())) return;
  els.input.value = '';
  clearAttachments();
  autoGrow();
}

/* ─────────── 固定侧栏：开 / 关（窗口最右边那块，不参与拖拽）───────────
   位置：index.html 的 #aiSide（#dockRow 里 #rightPanel 之后）→ 不归 dock.js 管。
   开：工程菜单 →「AI 助手…」；关：面板标题栏 ✕。
   开/关状态记在 localStorage['hmi-ai-open']（跟工程无关，换工程也保持）。 */
const AI_OPEN_KEY = 'hmi-ai-open';

function sideEl() { return document.getElementById('aiSide'); }

/** 面板当前是否打开。 */
export function aiSideOpen() {
  const side = sideEl();
  return !!side && !side.classList.contains('hidden');
}

/** 打开固定侧栏（可选 focus：打开后把光标放进输入框） */
export function openAiSide(focus = true) {
  if (!_inited) initAiPanel();
  const side = sideEl();
  if (!side) { statusNote('AI 面板没找到（页面可能是旧缓存，Ctrl+F5 刷新一下）', 6000); return false; }
  side.classList.remove('hidden');
  try { localStorage.setItem(AI_OPEN_KEY, '1'); } catch { /* 无痕模式等不让写，忽略 */ }
  refreshStatus();
  aiClient.getConfig().then(refreshStatus).catch(() => {});
  if (focus) requestAnimationFrame(() => (els.history.hidden ? els.input : els.historyBack).focus());
  return true;
}

/** 关闭固定侧栏（正在回复就顺手停掉：面板都藏了，继续跑只会白烧 token） */
export function closeAiSide() {
  const side = sideEl();
  if (!side || side.classList.contains('hidden')) return false;
  if (_busy) stop();
  side.classList.add('hidden');
  try { localStorage.setItem(AI_OPEN_KEY, '0'); } catch { /* 忽略 */ }
  return true;
}

export function toggleAiSide() { return aiSideOpen() ? closeAiSide() : openAiSide(); }

export function initAiPanel() {
  if (_inited) return;
  els.log = document.getElementById('aiLog');
  if (!els.log) { console.warn('[aiPanel] 页面里没有 #aiLog，跳过 AI 面板初始化'); return; }
  _inited = true;

  els.dot = document.getElementById('aiStatusDot');
  els.input = document.getElementById('aiInput');
  els.send = document.getElementById('aiSendBtn');
  els.stop = document.getElementById('aiStopBtn');
  els.allow = document.getElementById('aiAllowDestructive');
  els.statusText = document.getElementById('aiStatusText');
  els.scope = document.getElementById('aiScope');
  els.scopeTag = document.getElementById('aiScopeTag');
  els.scopeText = document.getElementById('aiScopeText');
  els.mode = Array.from(document.querySelectorAll('#aiSide [data-mode]'));
  els.form = document.getElementById('aiComposer');
  els.taskStatus = document.getElementById('aiTaskStatus');
  els.welcome = document.getElementById('aiWelcome');
  els.files = document.getElementById('aiAttachments');
  els.fileInfo = document.getElementById('aiAttachmentInfo');
  els.picker = document.getElementById('aiAttachmentPicker');
  els.attach = document.getElementById('aiAttachBtn');
  els.history = document.getElementById('aiHistory');
  els.historyBtn = document.getElementById('aiHistoryBtn');
  els.historyBack = document.getElementById('aiHistoryBack');
  els.historyList = document.getElementById('aiHistoryList');
  els.historyStatus = document.getElementById('aiHistoryStatus');
  switchConversation();
  els.translate = document.getElementById('aiTranslateBtn');
  els.settings = document.getElementById('aiSettingsBtn');
  els.clear = document.getElementById('aiClearBtn');
  els.closeBtn = document.getElementById('aiCloseBtn');
  if (els.closeBtn) els.closeBtn.onclick = () => closeAiSide();

  // 破坏性操作开关：默认关（AI 想删东西时会被工具层拒绝，并提示用户来勾）
  if (els.allow) {
    els.allow.checked = !!getAllowDestructive();
    els.allow.onchange = () => {
      setAllowDestructive(!!els.allow.checked);
      statusNote(els.allow.checked ? 'AI 现在可以执行删除类操作了' : 'AI 的删除类操作已关闭', 4000);
    };
  }
  setAllowDestructive(!!getAllowDestructive());


  els.picker.accept = ATTACHMENT_ACCEPT;
  els.attach.onclick = () => els.picker.click();
  els.picker.onchange = () => {
    const files = [...els.picker.files];
    els.picker.value = '';
    void attachFiles(files);
  };
  els.input.addEventListener('paste', ev => {
    const images = [...(ev.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    ev.preventDefault();
    void attachFiles(images);
  });

  els.form.addEventListener('submit', ev => { ev.preventDefault(); submitMessage(); });
  if (els.stop) els.stop.onclick = () => stop();
  if (els.translate) els.translate.onclick = () => openTranslateDialog();
  if (els.settings) els.settings.onclick = () => openSettingsDialog();
  if (els.clear) els.clear.onclick = () => { switchConversation(); els.input.focus(); };
  els.historyBtn.onclick = () => {
    if (els.history.hidden) void showHistory();
    else { setHistoryVisible(false); els.input.focus(); }
  };
  els.historyBack.onclick = () => { setHistoryVisible(false); els.historyBtn.focus(); };


  for (const button of els.mode) {
    button.addEventListener('click', () => {
      _mode = button.dataset.mode;
      els.mode.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      refreshScope();
    });
  }
  els.log.addEventListener('scroll', () => {
    const box = els.log;
    followLog = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  });
  els.log.addEventListener('click', ev => {
    const example = ev.target.closest('[data-prompt]');
    if (!example) return;
    els.input.value = example.dataset.prompt;
    autoGrow();
    els.input.focus();
  });
  els.input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      submitMessage();
    }
  });
  els.input.addEventListener('input', autoGrow);

  autoGrow();

  // 状态点随连接/配置变化刷新
  bus.on('ai:config', () => refreshStatus());
  bus.on('backend:status', () => refreshStatus());
  bus.on('backend:reconnect', () => {
    refreshStatus();
    if (aiSideOpen()) aiClient.getConfig().then(refreshStatus).catch(() => {});
  });
  bus.on('page:current', refreshScope);
  bus.on('project:changed', refreshScope);
  bus.on('project:replaced', event => {
    if (!event?.fromHistory) switchConversation();
    else if (_busy) stop();
  });
  refreshStatus();

  // 上次关着就继续保持关着（默认关）；开着就恢复（焦点不抢 —— 启动时别打断用户）
  let savedOpen = false;
  try { savedOpen = localStorage.getItem(AI_OPEN_KEY) === '1'; } catch { /* 忽略 */ }
  if (savedOpen) openAiSide(false);
}

/** 供别处（工具菜单/测试）叫出对话框 */
export function openAiSettings() { return openSettingsDialog(); }
export function openAiTranslate() { return openTranslateDialog(); }
export function aiConversationLength() { return conversationLength(); }
export function aiIsBusy() { return _busy; }
export function aiSend(text) { return send(text); }
