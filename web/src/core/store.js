// What the page keeps between visits, in the browser (IndexedDB): the space's keys (CryptoKeys that
// can't be taken out of the browser), the token, how far it has read, and the records — sealed with
// the space's key, so nothing of hers sits in the clear on the computer's disk. Forgotten whole when
// the computer is unlinked.

const DB = 'novelo-web';
const VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class Store {
  async open() {
    if (this.db) return this;
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    this.db = await req(r);
    return this;
  }

  tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  get(key) {
    return req(this.tx('meta').get(key));
  }

  set(key, value) {
    return req(this.tx('meta', 'readwrite').put(value, key));
  }

  async records() {
    return req(this.tx('records').getAll());
  }

  /** Several records at once ([{k, …}]); a null value removes that key. */
  putRecords(list) {
    if (!list.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = this.db.transaction('records', 'readwrite');
      const s = t.objectStore('records');
      for (const r of list) {
        if (r.remove) s.delete(r.k);
        else s.put(r);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  /** Files made here waiting to go up (sealed). */
  pendingFiles() {
    return req(this.tx('files').getAll());
  }

  putFile(f) {
    return req(this.tx('files', 'readwrite').put(f));
  }

  dropFile(id) {
    return req(this.tx('files', 'readwrite').delete(id));
  }

  /** Everything gone (unlinked). */
  async wipe() {
    this.db?.close();
    this.db = null;
    await req(indexedDB.deleteDatabase(DB)).catch(() => {});
  }
}
