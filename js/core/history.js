/**
 * history.js — 撤销/重做（快照式）
 *
 * 依赖方向：project → history（单向）。快照的获取/恢复回调
 * 由 main.js 注入，history 本身不感知 project，避免循环依赖。
 */
import { bus } from './eventBus.js';

const MAX = 60;
const MERGE_MS = 800;   // 同标签快照的合并窗口
let undoStack = [];   // [{ label, json, t }]
let redoStack = [];
let hooks = null;     // { get:()=>json, set:(json)=>void }

export const history = {
  init(h) { hooks = h; },

  /**
   * 推入一条快照。
   * @param {string} label 动作名（显示在撤销按钮 title 上）
   * @param {{merge?:boolean}} [opts] merge=true 且与栈顶同标签、间隔 < MERGE_MS 时，
   *   只更新栈顶快照而不新增条目 —— 连按方向键微移 / 连续拖动 / 反复改属性
   *   只占 1 步撤销，不会把 60 步栈冲掉（原先连按 70 次方向键能把历史全灌满）。
   */
  push(label, opts = {}) {
    if (!hooks) return;
    const now = Date.now();
    const top = undoStack[undoStack.length - 1];
    if (opts.merge && top && top.label === label && now - (top.t || 0) < MERGE_MS) {
      top.json = hooks.get();
      top.t = now;
      redoStack = [];
      this._notify();
      return;
    }
    undoStack.push({ label, json: hooks.get(), t: now });
    if (undoStack.length > MAX) undoStack.shift();
    redoStack = [];
    this._notify();
  },

  undo() {
    if (!hooks || undoStack.length <= 1) return;   // 栈底保留初始基线
    const snap = undoStack.pop();
    redoStack.push(snap);
    hooks.set(undoStack[undoStack.length - 1].json); // 恢复新栈顶
    this._notify();
  },

  redo() {
    if (!hooks || !redoStack.length) return;
    const snap = redoStack.pop();
    undoStack.push(snap);
    hooks.set(snap.json);
    this._notify();
  },

  canUndo() { return undoStack.length > 1; },
  canRedo() { return redoStack.length > 0; },
  lastLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : ''; },

  _notify() {
    bus.emit('history:changed', { canUndo: this.canUndo(), canRedo: this.canRedo() });
  },
};
