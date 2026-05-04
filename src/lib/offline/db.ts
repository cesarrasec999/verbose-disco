import {
  OFFLINE_BARCODES_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_METADATA_STORE,
  OFFLINE_PRODUCTS_STORE,
  OFFLINE_QUEUE_STORE,
  OFFLINE_STOCK_STORE,
  OFFLINE_STORES_STORE,
} from "./types";

export function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB no esta disponible en este navegador."));
      return;
    }

    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) {
        const store = db.createObjectStore(OFFLINE_QUEUE_STORE, { keyPath: "localId" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("entity", "entity", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(OFFLINE_STORES_STORE)) {
        const store = db.createObjectStore(OFFLINE_STORES_STORE, { keyPath: "id" });
        store.createIndex("code", "code", { unique: false });
        store.createIndex("erp_sede", "erp_sede", { unique: false });
      }

      if (!db.objectStoreNames.contains(OFFLINE_PRODUCTS_STORE)) {
        const store = db.createObjectStore(OFFLINE_PRODUCTS_STORE, { keyPath: "sku" });
        store.createIndex("id", "id", { unique: true });
        store.createIndex("description", "description", { unique: false });
      }

      if (!db.objectStoreNames.contains(OFFLINE_BARCODES_STORE)) {
        const store = db.createObjectStore(OFFLINE_BARCODES_STORE, { keyPath: "cache_key" });
        store.createIndex("codsap", "codsap", { unique: false });
        store.createIndex("upc", "upc", { unique: false });
        store.createIndex("alu", "alu", { unique: false });
      }

      if (!db.objectStoreNames.contains(OFFLINE_STOCK_STORE)) {
        const store = db.createObjectStore(OFFLINE_STOCK_STORE, { keyPath: "cache_key" });
        store.createIndex("sede", "sede", { unique: false });
        store.createIndex("codsap", "codsap", { unique: false });
      }

      if (!db.objectStoreNames.contains(OFFLINE_METADATA_STORE)) {
        db.createObjectStore(OFFLINE_METADATA_STORE, { keyPath: "key" });
      }
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export function runOfflineTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openOfflineDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = callback(store);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      })
  );
}
