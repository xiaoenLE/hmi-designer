/** AI 会话只存在浏览器的站点数据库。会话索引和消息分开读取。 */
const DB = 'hmi-ai-history';
const SESSIONS = 'sessions';
const TURNS = 'turns';
let connection;

function openDatabase() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(SESSIONS, { keyPath: 'id' });
        db.createObjectStore(TURNS, { keyPath: 'id' }).createIndex('session', 'sessionId');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
    }).catch(error => {
      connection = null;
      throw error;
    });
  }
  return connection;
}

async function transaction(stores, mode, work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('浏览器取消了历史记录操作'));
    work(tx, value => { result = value; });
  });
}

export function listSessions() {
  return transaction(SESSIONS, 'readonly', (tx, done) => {
    const request = tx.objectStore(SESSIONS).getAll();
    request.onsuccess = () => done(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
  });
}

export function readSession(id) {
  return transaction([SESSIONS, TURNS], 'readonly', (tx, done) => {
    const session = tx.objectStore(SESSIONS).get(id);
    const turns = tx.objectStore(TURNS).index('session').getAll(id);
    turns.onsuccess = () => done(session.result ? {
      session: session.result,
      turns: turns.result.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
    } : null);
  });
}

/** 同一事务中更新会话和单条消息。已删除的会话只会在显式新建时产生新 ID。 */
export function saveTurn(session, turn, create) {
  return transaction([SESSIONS, TURNS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(SESSIONS);
    const request = store.get(session.id);
    request.onsuccess = () => {
      const current = request.result || (create ? session : null);
      if (!current) { done(false); return; }
      store.put({ ...current, updatedAt: Date.now() });
      tx.objectStore(TURNS).put({ ...turn, sessionId: session.id });
      done(true);
    };
  });
}

export function deleteSession(id) {
  return transaction([SESSIONS, TURNS], 'readwrite', tx => {
    tx.objectStore(SESSIONS).delete(id);
    const turns = tx.objectStore(TURNS);
    const request = turns.index('session').getAllKeys(id);
    request.onsuccess = () => { for (const key of request.result) turns.delete(key); };
  });
}

/** getRandomValues 在本机地址和局域网 HTTP 页面上都可用。 */
export function newHistoryId() {
  return [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, '0')).join('');
}
