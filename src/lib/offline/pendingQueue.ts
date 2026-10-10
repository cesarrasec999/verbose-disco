import {
  OFFLINE_QUEUE_STORE,
  type OfflineQueueItem,
} from "./types";
import { openOfflineDb, runOfflineTransaction } from "./db";

function runTransaction<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return runOfflineTransaction(OFFLINE_QUEUE_STORE, mode, callback);
}

export function enqueueOfflineItem<TPayload>(
  item: OfflineQueueItem<TPayload>
): Promise<IDBValidKey> {
  return runTransaction("readwrite", (store) => store.put(item));
}

export function getOfflineItem(localId: string): Promise<OfflineQueueItem | undefined> {
  return runTransaction("readonly", (store) => store.get(localId)).then((row) => row as OfflineQueueItem | undefined);
}

export function removeOfflineItem(localId: string): Promise<undefined> {
  return runTransaction("readwrite", (store) => store.delete(localId));
}

// A background sync must not erase an edit saved while its request was in flight.
export async function removeOfflineItemIfUnchanged(localId: string, updatedAt: string, payload?: unknown): Promise<boolean> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    let removed = false;
    const transaction = db.transaction(OFFLINE_QUEUE_STORE, "readwrite");
    const store = transaction.objectStore(OFFLINE_QUEUE_STORE);
    const request = store.get(localId);
    request.onsuccess = () => {
      const current = request.result as OfflineQueueItem | undefined;
      if (current?.updatedAt === updatedAt && (payload === undefined || JSON.stringify(current.payload) === JSON.stringify(payload))) {
        store.delete(localId);
        removed = true;
      }
    };
    transaction.oncomplete = () => { db.close(); resolve(removed); };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export function listPendingOfflineItems(): Promise<OfflineQueueItem[]> {
  return openOfflineDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(OFFLINE_QUEUE_STORE, "readonly");
        const store = transaction.objectStore(OFFLINE_QUEUE_STORE);
        const index = store.index("status");
        const request = index.getAll("pending");

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as OfflineQueueItem[]);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      })
  );
}

export function countPendingOfflineItems(): Promise<number> {
  return openOfflineDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(OFFLINE_QUEUE_STORE, "readonly");
        const store = transaction.objectStore(OFFLINE_QUEUE_STORE);
        const index = store.index("status");
        const request = index.count("pending");

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
