/* eslint-disable @typescript-eslint/no-explicit-any */

import type { SupabaseClient } from "@supabase/supabase-js";
import { openOfflineDb, runOfflineTransaction } from "./db";
import {
  OFFLINE_BARCODES_STORE,
  OFFLINE_METADATA_STORE,
  OFFLINE_PRODUCTS_STORE,
  OFFLINE_STOCK_STORE,
  OFFLINE_STORES_STORE,
} from "./types";

export type OfflineCatalogStage = "stores" | "products" | "barcodes" | "stock" | "done";

export type OfflineCatalogProgress = {
  stage: OfflineCatalogStage;
  label: string;
  loaded: number;
  total?: number;
};

type ProgressCallback = (progress: OfflineCatalogProgress) => void;

export type CachedProduct = {
  id: string;
  sku: string;
  description: string;
  unit: string;
  cost: number;
  is_active: boolean;
};

type CachedBarcode = {
  cache_key: string;
  codsap?: string | null;
  upc?: string | null;
  alu?: string | null;
};

const PAGE_SIZE = 1000;
const METADATA_KEY = "catalog_sync";

function cleanText(value: unknown): string {
  return String(value || "").trim();
}

function cleanCode(value: unknown): string {
  return cleanText(value).toUpperCase();
}

async function clearStore(storeName: string): Promise<void> {
  await runOfflineTransaction(storeName, "readwrite", (store) => store.clear());
}

async function putRows(storeName: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openOfflineDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);

    for (const row of rows) store.put(row);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function saveMetadata(value: Record<string, unknown>): Promise<void> {
  await runOfflineTransaction(OFFLINE_METADATA_STORE, "readwrite", (store) =>
    store.put({ key: METADATA_KEY, ...value, updated_at: new Date().toISOString() })
  );
}

async function fetchPaged(
  supabase: SupabaseClient,
  table: string,
  select: string,
  storeName: string,
  stage: OfflineCatalogStage,
  label: string,
  progress?: ProgressCallback,
  mapRow: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row,
  applyFilters?: (query: any) => any
): Promise<number> {
  await clearStore(storeName);

  let loaded = 0;
  let from = 0;
  let total: number | undefined;

  while (true) {
    let query = supabase
      .from(table)
      .select(select, { count: from === 0 ? "exact" : undefined });

    if (applyFilters) query = applyFilters(query);
    query = query.range(from, from + PAGE_SIZE - 1);

    const { data, error, count } = await query;
    if (error) throw new Error(`${label}: ${error.message}`);
    if (from === 0 && typeof count === "number") total = count;

    const rows = (data || []).map((row) => mapRow(row as unknown as Record<string, unknown>));
    await putRows(storeName, rows);

    loaded += rows.length;
    progress?.({ stage, label, loaded, total });

    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return loaded;
}

export async function syncOfflineCatalog(
  supabase: SupabaseClient,
  progress?: ProgressCallback
): Promise<Record<OfflineCatalogStage, number>> {
  const stores = await fetchPaged(
    supabase,
    "stores",
    "id,code,name,erp_sede,is_active",
    OFFLINE_STORES_STORE,
    "stores",
    "Tiendas",
    progress,
    (row) => ({ ...row, cache_key: row.id }),
    (query) => query.eq("is_active", true)
  );

  const products = await fetchPaged(
    supabase,
    "cyclic_products",
    "id,sku,description,unit,cost,is_active",
    OFFLINE_PRODUCTS_STORE,
    "products",
    "Productos",
    progress,
    (row) => ({
      ...row,
      id: cleanText(row.id),
      sku: cleanCode(row.sku),
      description: cleanText(row.description),
      unit: cleanText(row.unit),
      cost: Number(row.cost || 0),
      is_active: row.is_active === true,
    }),
    (query) => query.eq("is_active", true)
  );

  const barcodes = await fetchPaged(
    supabase,
    "codigos_barra",
    "codsap,upc,alu",
    OFFLINE_BARCODES_STORE,
    "barcodes",
    "Codigos de barra",
    progress,
    (row) => ({
      codsap: cleanCode(row.codsap),
      upc: cleanCode(row.upc),
      alu: cleanCode(row.alu),
      cache_key: `${cleanCode(row.codsap)}|${cleanCode(row.upc)}|${cleanCode(row.alu)}`,
    }),
    (query) => query.not("codsap", "is", null)
  );

  const stock = await fetchPaged(
    supabase,
    "stock_general",
    "sede,codsap,stock,costo",
    OFFLINE_STOCK_STORE,
    "stock",
    "Stock",
    progress,
    (row) => ({
      sede: cleanText(row.sede),
      codsap: cleanCode(row.codsap),
      stock: Number(row.stock || 0),
      costo: Number(row.costo || 0),
      cache_key: `${cleanText(row.sede)}|${cleanCode(row.codsap)}`,
    })
  );

  const result = { stores, products, barcodes, stock, done: stores + products + barcodes + stock };
  await saveMetadata(result);
  progress?.({ stage: "done", label: "Catalogo offline listo", loaded: result.done, total: result.done });
  return result;
}

function getFromStore<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return runOfflineTransaction(storeName, "readonly", (store) => store.get(key)).then((row) => row as T | undefined);
}

function getAllFromIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
  return openOfflineDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const index = transaction.objectStore(storeName).index(indexName);
        const request = index.getAll(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as T[]);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      })
  );
}

function getAllFromStore<T>(storeName: string): Promise<T[]> {
  return runOfflineTransaction(storeName, "readonly", (store) => store.getAll()).then((rows) => rows as T[]);
}

export async function findCachedProductsByCode(code: string): Promise<CachedProduct[]> {
  const raw = code.trim().toUpperCase();
  if (!raw) return [];

  const [byUpc, byAlu, exactProduct] = await Promise.all([
    getAllFromIndex<CachedBarcode>(OFFLINE_BARCODES_STORE, "upc", raw).catch(() => []),
    getAllFromIndex<CachedBarcode>(OFFLINE_BARCODES_STORE, "alu", raw).catch(() => []),
    getFromStore<CachedProduct>(OFFLINE_PRODUCTS_STORE, raw).catch(() => undefined),
  ]);

  const candidateSkus = new Set<string>([raw]);
  if (exactProduct?.sku) candidateSkus.add(exactProduct.sku);
  for (const row of [...byUpc, ...byAlu]) {
    if (row.codsap) candidateSkus.add(String(row.codsap).toUpperCase());
  }

  const exactRows = await Promise.all(
    [...candidateSkus].map((sku) => getFromStore<CachedProduct>(OFFLINE_PRODUCTS_STORE, sku).catch(() => undefined))
  );
  const productMap = new Map<string, CachedProduct>();
  for (const product of exactRows) {
    if (product?.is_active) productMap.set(product.sku, product);
  }

  if (raw.length >= 4) {
    const allProducts = await getAllFromStore<CachedProduct>(OFFLINE_PRODUCTS_STORE).catch(() => []);
    for (const product of allProducts) {
      if (product.is_active && product.sku.toUpperCase().includes(raw)) {
        productMap.set(product.sku, product);
        if (productMap.size >= 20) break;
      }
    }
  }

  return [...productMap.values()].sort((a, b) => a.sku.localeCompare(b.sku, "es", { numeric: true }));
}
