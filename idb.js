// Minimal IndexedDB key/value store for the offline copy of your data.
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('prospect-mailer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
export async function idbGet(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  } catch { return undefined; }
}
export async function idbSet(key, val) {
  try {
    const d = await db();
    await new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch { /* private mode etc. — the app still works online */ }
}
export async function idbClear() {
  try {
    const d = await db();
    await new Promise((res) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').clear(); tx.oncomplete = res; tx.onerror = res; });
  } catch { /* ignore */ }
}
