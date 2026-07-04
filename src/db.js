// Minimal promise wrapper over one IndexedDB key-value store.
let db;

export function dbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('endustrie-tracker', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const store = mode => db.transaction('kv', mode).objectStore('kv');
const wrap = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });

export const dbGet = k => wrap(store('readonly').get(k));
export const dbSet = (k, v) => wrap(store('readwrite').put(v, k));
export const dbDel = k => wrap(store('readwrite').delete(k));
export async function dbKeys(prefix) {
  const all = await wrap(store('readonly').getAllKeys());
  return all.filter(k => typeof k === 'string' && k.startsWith(prefix));
}
