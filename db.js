const DB_NAME = "offering_db";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("tx")) {
        const store = db.createObjectStore("tx", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_date", "date");
        store.createIndex("by_person", "person");
        store.createIndex("by_type", "type");
        store.createIndex("by_year", "year");
      }

      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains("types")) {
        const s = db.createObjectStore("types", { keyPath: "name" });
        // 기본 헌금종류
        ["십일조", "감사헌금", "비전씨앗헌금", "건축헌금"].forEach(name => s.add({ name }));
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const res = fn(store);
    t.oncomplete = () => resolve(res);
    t.onerror = () => reject(t.error);
  });
}

export async function dbGetMeta(key) {
  const db = await openDB();
  return tx(db, "meta", "readonly", (s) => new Promise((resolve) => {
    const r = s.get(key);
    r.onsuccess = () => resolve(r.result ? r.result.value : null);
    r.onerror = () => resolve(null);
  }));
}

export async function dbSetMeta(key, value) {
  const db = await openDB();
  return tx(db, "meta", "readwrite", (s) => s.put({ key, value }));
}

export async function dbAddType(name) {
  const db = await openDB();
  return tx(db, "types", "readwrite", (s) => s.put({ name }));
}

export async function dbGetTypes() {
  const db = await openDB();
  return tx(db, "types", "readonly", (s) => new Promise((resolve) => {
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  }));
}

export async function dbAddTransactions(items) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction("tx", "readwrite");
    const store = t.objectStore("tx");
    for (const it of items) store.add(it);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

export async function dbGetAllTx() {
  const db = await openDB();
  return tx(db, "tx", "readonly", (s) => new Promise((resolve) => {
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  }));
}
