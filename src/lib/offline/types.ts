export type OfflineModule =
  | "cyclic"
  | "audit"
  | "general_inventory"
  | "stock_lookup";

export type OfflineOperation = "insert" | "update" | "upsert" | "delete";

export type OfflineQueueStatus = "pending" | "syncing" | "synced" | "failed";

export type OfflineEntity =
  | "cyclic_counts"
  | "audit_counts"
  | "general_inventory_counts"
  | "general_inventory_recount_counts";

export interface OfflineQueueItem<TPayload = unknown> {
  localId: string;
  clientUuid: string;
  deviceId: string;
  module: OfflineModule;
  entity: OfflineEntity;
  operation: OfflineOperation;
  payload: TPayload;
  status: OfflineQueueStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  syncedAt?: string;
  lastError?: string;
}

export const OFFLINE_DB_NAME = "rasecorp-offline" as const;
export const OFFLINE_DB_VERSION = 2 as const;
export const OFFLINE_QUEUE_STORE = "pending_operations" as const;
export const OFFLINE_STORES_STORE = "stores" as const;
export const OFFLINE_PRODUCTS_STORE = "products" as const;
export const OFFLINE_BARCODES_STORE = "barcodes" as const;
export const OFFLINE_STOCK_STORE = "stock" as const;
export const OFFLINE_METADATA_STORE = "metadata" as const;
