// Thumbnails live in IndexedDB, shared by the background worker and Nook's pages.
const DB_NAME = 'nook';
const STORE = 'thumbs';
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export function putThumb(key, blob, url) {
  return tx('readwrite', (s) => { s.put({ blob, url, at: Date.now() }, key); });
}

export async function getThumb(key) {
  if (!key) return null;
  const d = await db();
  const row = await req2p(d.transaction(STORE).objectStore(STORE).get(key));
  return row ? row.blob : null;
}

export function deleteThumbs(keys) {
  const list = [...keys].filter(Boolean);
  if (!list.length) return Promise.resolve();
  return tx('readwrite', (s) => { list.forEach((k) => s.delete(k)); });
}

export async function clearThumbs() {
  return tx('readwrite', (s) => { s.clear(); });
}

// Remove thumbnails nothing points at any more (deleted items, closed tabs).
export async function collectGarbage(keepKeys, minAgeMs = 60 * 60 * 1000) {
  const d = await db();
  const store = d.transaction(STORE).objectStore(STORE);
  const keys = await req2p(store.getAllKeys());
  const now = Date.now();
  const doomed = [];
  for (const k of keys) {
    if (keepKeys.has(k)) continue;
    const row = await req2p(d.transaction(STORE).objectStore(STORE).get(k));
    if (!row || now - row.at > minAgeMs) doomed.push(k);
  }
  await deleteThumbs(doomed);
  return doomed.length;
}
