/* Full/thumb image cache in IndexedDB with LRU size cap */
(function (global) {
  'use strict';

  const DB_NAME = 'vibechic-media-cache';
  const DB_VER = 1;
  const STORE = 'blobs';
  const META = 'meta';
  const MAX_BYTES = 80 * 1024 * 1024; // 80MB

  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('at', 'at');
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('abort'));
    });
  }

  function cacheKey(kind, id) {
    return kind + ':' + id;
  }

  async function get(kind, id) {
    if (!id) return null;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(cacheKey(kind, id));
      req.onsuccess = () => {
        const row = req.result;
        if (!row) return resolve(null);
        // touch at asynchronously
        touch(kind, id).catch(() => {});
        resolve(row.dataURL || null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function touch(kind, id) {
    const db = await open();
    const key = cacheKey(kind, id);
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const cur = await new Promise((resolve, reject) => {
      const r = store.get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (cur) {
      cur.at = Date.now();
      store.put(cur);
    }
    await txDone(tx);
  }

  async function put(kind, id, dataURL) {
    if (!id || !dataURL) return;
    const size = Math.ceil(String(dataURL).length * 0.75);
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      key: cacheKey(kind, id),
      kind,
      id,
      dataURL,
      size,
      at: Date.now()
    });
    await txDone(tx);
    await enforceCap();
  }

  async function enforceCap() {
    const db = await open();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    let total = all.reduce((s, x) => s + (x.size || 0), 0);
    if (total <= MAX_BYTES) return;
    all.sort((a, b) => (a.at || 0) - (b.at || 0)); // oldest first
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of all) {
      if (total <= MAX_BYTES * 0.85) break;
      store.delete(row.key);
      total -= row.size || 0;
    }
    await txDone(tx);
  }

  async function getThumb(id) { return get('thumb', id); }
  async function getFull(id) { return get('full', id); }
  async function putThumb(id, dataURL) { return put('thumb', id, dataURL); }
  async function putFull(id, dataURL) { return put('full', id, dataURL); }

  async function stats() {
    const db = await open();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    return {
      count: all.length,
      bytes: all.reduce((s, x) => s + (x.size || 0), 0),
      maxBytes: MAX_BYTES
    };
  }

  global.VCMediaCache = {
    getThumb, getFull, putThumb, putFull, stats, MAX_BYTES
  };
})(typeof window !== 'undefined' ? window : globalThis);
