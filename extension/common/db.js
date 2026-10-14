// IndexedDB wrapper: task records and Blob hand-over. Shared by the background, the engine and the UI (same origin).

const DB_NAME = 'shuttle-dm';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('[db] open blocked');
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(store, mode, fn) {
  const db = await open();
  const tx = db.transaction(store, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
  const result = await fn(tx.objectStore(store));
  await done;
  return result;
}

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => reqP(s.get(key))),
  getAll: (store) => run(store, 'readonly', (s) => reqP(s.getAll())),
  put: (store, value) => run(store, 'readwrite', (s) => reqP(s.put(value))),
  putMany: (store, values) => run(store, 'readwrite', (s) => Promise.all(values.map((v) => reqP(s.put(v))))),
  delete: (store, key) => run(store, 'readwrite', (s) => reqP(s.delete(key))),
  clear: (store) => run(store, 'readwrite', (s) => reqP(s.clear())),
};
