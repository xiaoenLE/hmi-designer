/**
 * eventBus.js — 全局事件总线（模块间解耦的唯一通道）
 *
 * 事件目录（集中约定，避免散乱）：
 *   project:changed   工程数据任何变化（→ storage 自动保存）
 *   page:current      当前编辑页切换 {pageId}
 *   selection:changed 画布选中集变化 {ids:[...]}
 *   history:changed   撤销栈变化 {canUndo, canRedo}
 *   mode:changed      编辑/运行模式切换 {mode:'edit'|'run'}
 *   vars:changed      变量运行值变化 {name, value, source:'local'|'remote'|'init'}
 *   backend:status    Python 后端连接状态 {state:'online'|'offline'}
 *   plc:protocol      当前 PLC 协议换了 {protocol:'modbus'|'opcua'}
 *                     （变量表的地址提示/占位、「从 OPC UA 导入…」按钮都只认当前协议）
 */
const listeners = new Map();

export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => bus.off(evt, fn);
  },
  off(evt, fn) {
    const s = listeners.get(evt);
    if (s) s.delete(fn);
  },
  emit(evt, data) {
    const s = listeners.get(evt);
    if (s) [...s].forEach(fn => { try { fn(data); } catch (e) { console.error(`[bus:${evt}]`, e); } });
  },
};
