export type Role = "Operario" | "Validador" | "Supervisor" | "Administrador";
export type TabKey = "operario" | "validador" | "ubicaciones" | "admin";
export type ValTabKey = "asignar" | "no_inventariables" | "registros" | "resumen" | "progreso" | "dashboard" | "resultados";

export type CyclicUser = {
  id: string;
  username: string;
  password?: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
  can_access_audit?: boolean;
  module_access?: string[] | null;
  is_active: boolean;
  whatsapp?: string | null;
};

export type Store = {
  id: string;
  code: string;
  name: string;
  erp_sede?: string | null;
  is_active: boolean;
};

export type Product = {
  id: string;
  sku: string;
  barcode: string | null;
  description: string;
  unit: string;
  cost: number;
  is_active: boolean;
  system_stock?: number;
};

export type StockGeneralRow = {
  sede: string | null;
  codsap: string | null;
  stock: number | string | null;
  updated_at?: string | null;
};

export type NonInventoryProduct = {
  id: string;
  product_id: string | null;
  sku: string;
  description: string | null;
  is_active: boolean;
  barcode?: string | null;
  unit?: string | null;
  cost?: number | null;
  product_description?: string | null;
};

export type Assignment = {
  id: string;
  store_id: string;
  product_id: string;
  system_stock: number;
  assigned_date: string;
  assigned_by: string | null;
  sku?: string;
  barcode?: string | null;
  description?: string;
  unit?: string;
  cost?: number;
  store_name?: string;
  counted?: boolean;
  count_id?: string;
};

export type CountRecord = {
  id: string;
  assignment_id: string;
  store_id: string;
  product_id: string;
  counted_quantity: number;
  location: string;
  user_id: string | null;
  user_name: string | null;
  validator_id: string | null;
  validator_name: string | null;
  status: "Pendiente" | "Diferencia" | "Validado" | "Corregido";
  note: string | null;
  stock_snapshot?: number | null;
  counted_at: string;
  updated_at: string;
  sku?: string;
  barcode?: string | null;
  description?: string;
  unit?: string;
  cost?: number;
  system_stock?: number;
  difference?: number;
  store_name?: string;
};

export type ResumenRow = {
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  cost: number;
  system_stock: number;
  total_counted: number;
  difference: number;
  dif_valorizada: number;
};

export type DashboardRow = {
  store_id: string;
  store_name: string;
  date: string;
  total_asignados: number;
  total_asignados_periodo?: number;
  total_ok: number;
  total_sobrantes: number;
  total_faltantes: number;
  total_no_contados: number;
  dif_valorizada: number;
  eri: number;
  cumplio: boolean;
  cumplimiento_pct: number;
  dias_cumplidos: number;
  dias_totales: number;
  hora_inicio: string | null;
  hora_fin: string | null;
  duracion_min: number | null;
};

export type StoreProgress = {
  store_id: string;
  store_name: string;
  total_asignados: number;
  total_contados: number;
  pct: number;
};

export type GlobalStockProgress = {
  total_stock_codes: number;
  completed_codes: number;
  pending_codes: number;
  pct: number;
};

export type AllStoreAssignmentSummary = {
  assignment_id: string;
  store_id: string;
  store_name: string;
  product_id: string;
  sku: string;
  description: string;
  unit: string;
  system_stock: number;
};

export type ProductCountHistoryRow = {
  assignment_id: string;
  source: "ciclico" | "auditoria" | "inventario general";
  source_label: string;
  store_name: string;
  assigned_date: string;
  sku: string;
  description: string;
  unit: string;
  system_stock: number;
  counted_quantity: number;
  difference: number;
  ok: number;
  faltante: number;
  sobrante: number;
  result: string;
  motive: string;
};

export type LocationRow = { location: string; qty: string };

export type LocationEntryProductRow = {
  code: string;
  quantity: string;
  product: Product | null;
  status: "" | "ok" | "error";
  message: string;
};

export type ProductLocation = {
  id: string;
  store_id: string | null;
  product_id: string;
  sku: string;
  location: string;
  stored_quantity?: number | null;
  is_active: boolean;
  last_source?: string | null;
  last_seen_at?: string | null;
  updated_at?: string | null;
  cyclic_registered?: boolean | null;
  audit_registered?: boolean | null;
  general_inventory_registered?: boolean | null;
  cyclic_products?: Pick<Product, "sku" | "description" | "unit" | "cost"> | null;
};
