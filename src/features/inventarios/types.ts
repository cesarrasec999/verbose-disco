export type Role = "Operario" | "Cajero" | "Validador" | "Supervisor" | "Administrador";
export type SessionStatus = "planned" | "open" | "frozen" | "finished" | "cancelled";
export type ValidatorTab = "preparacion" | "registros" | "productividad" | "reconteo" | "validacion" | "resumen" | "reportes" | "usuarios";
export type OperatorMode = "conteo" | "consulta" | "reconteo";
export type RecountManagerTab = "pendientes" | "asignados" | "manual" | "registros";
export type RecountAssignedStatusFilter = "all" | "pending" | "counted";
export type SortDirection = "asc" | "desc";
export type RecordsSortKey = "counted_at" | "operator_name" | "location_code" | "sku" | "description" | "unit" | "quantity" | "cost_snapshot" | "value";
export type SummarySortKey = "sku" | "description" | "unit" | "system_stock" | "counted" | "counted_original" | "recounted_qty" | "validation_qty" | "diff" | "cost" | "valueDiff" | "observation";
export type RecountAssignedSortKey = "status" | "recount_type" | "ticket" | "location_code" | "sku" | "description" | "system_stock" | "counted_qty" | "diff_qty" | "value_diff" | "assigned_operator_name";
export type SortState<T extends string> = { key: T; direction: SortDirection };

export type CyclicUser = {
  id: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
  module_access?: string[] | null;
  is_active: boolean;
};

export type Store = {
  id: string;
  name: string;
  erp_sede?: string | null;
  is_active: boolean;
};

export type InventorySession = {
  id: string;
  store_id: string;
  name: string;
  status: SessionStatus;
  scheduled_date: string | null;
  stock_frozen_at: string | null;
  location_lock_enabled?: boolean | null;
  manual_recount_enabled?: boolean | null;
  validation_enabled?: boolean | null;
  finished_at?: string | null;
  created_at?: string | null;
  frozen_total_value: number;
  notes?: string | null;
  store_name?: string;
};

export type InventoryOperator = {
  id: string;
  full_name: string;
  phone: string;
  password?: string;
};

export type InventoryLocation = {
  id: string;
  session_id: string;
  location_code: string;
  ticket?: string | null;
  zone?: string | null;
  zone_ref?: string | null;
  lineal?: string | null;
  reference?: string | null;
  full_location?: string | null;
  description?: string | null;
  is_active: boolean;
  is_empty?: boolean | null;
  empty_marked_by?: string | null;
  empty_marked_at?: string | null;
};

export type Product = {
  id: string;
  sku: string;
  barcode: string | null;
  description: string;
  unit: string;
  cost: number;
  is_active: boolean;
};

export type StockGeneralRow = {
  codsap: string;
  stock: number | string | null;
  costo: number | string | null;
};

export type CountRow = {
  id: string;
  session_id: string;
  operator_id: string;
  location_id: string;
  location_code: string;
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  quantity: number;
  cost_snapshot: number;
  counted_at: string;
  operator_name?: string | null;
};

export type SummaryRow = {
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  brand?: string | null;
  department?: string | null;
  class_name?: string | null;
  subclass_name?: string | null;
  rotation_category?: string | null;
  system_stock: number;
  counted: number;
  counted_original: number;
  recounted_qty: number | null;
  validation_qty: number | null;
  diff: number;
  cost: number;
  valueDiff: number;
  re_counted: boolean;
  recount_status: "no" | "assigned" | "counted";
  validation_status?: "no" | "assigned" | "counted";
  validated: boolean;
  observation?: string | null;
};

export type RecountType = "surplus" | "missing";
export type RecountFilter = RecountType | "surplus_zero_stock" | "missing_not_counted";
export type ScannerTarget = "location" | "product" | "operator_lookup_product" | "recount_location" | "recount_product" | null;
export type ProductLookupMode = "typed" | "scan";

export type RecountLocationLine = {
  id: string;
  location_id: string | null;
  location_code: string;
  full_location: string | null;
  zone: string | null;
  zone_ref: string | null;
  lineal: string | null;
  ticket: string | null;
  counted_qty: number;
};

export type RecountCandidate = {
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  location_id: string | null;
  location_code: string | null;
  full_location: string | null;
  zone: string | null;
  zone_ref: string | null;
  lineal: string | null;
  ticket: string | null;
  recount_type: RecountType;
  system_stock: number;
  counted_qty: number;
  diff_qty: number;
  cost_snapshot: number;
  value_diff: number;
  location_count: number;
  original_locations: RecountLocationLine[];
};

export type RecountItem = RecountCandidate & {
  id: string;
  status: string;
  assigned_operator_id: string | null;
  assigned_operator_name?: string | null;
  layer?: "recount" | "validation";
  source_recount_item_id?: string | null;
};

export type RecountDocumentRow = RecountItem & {
  recount_count_id: string;
  recount_operator_id: string;
  recount_operator_name: string;
  recount_quantity: number;
  recount_original_quantity: number;
  recount_counted_at: string;
  recount_updated_at: string;
};

export type OperatorRecountRecord = {
  id: string;
  recount_item_id: string;
  operator_id: string;
  operator_name?: string | null;
  location_id: string | null;
  location_code: string;
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  quantity: number;
  original_quantity?: number;
  cost_snapshot: number;
  counted_at: string;
  updated_at?: string | null;
  item: RecountItem;
};

export type ManualRecountDraft = {
  locationCode: string;
  quantity: string;
};

export type RecountDraft = {
  productCode: string;
  extraProductCode: string;
  rows: Array<{
    locationCode: string;
    quantity: string;
    isExtra?: boolean;
  }>;
};

export type InventoryOperatorDraft = {
  full_name: string;
  phone: string;
  password: string;
};

export type ManualLocationDraft = {
  location_code: string;
  zone: string;
  zone_ref: string;
  lineal: string;
  reference: string;
};
