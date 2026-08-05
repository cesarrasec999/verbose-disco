import { supabase } from "@/lib/supabase/client";
import type { Product, Store } from "@/features/ciclicos/types";
import { fullProductCode, mappedProductCodeCandidates, preferFullCodsapProducts } from "@/features/ciclicos/utils";
import type { DifferenceReason, DifferenceReport, DifferenceRequestData, DifferenceStatus } from "./types";

const PHOTO_BUCKET = "inventory-difference-photos";

// Resuelve un codigo escaneado/digitado a 0, 1 o varios productos candidatos.
// A diferencia de Picking/Auditoria, aca NO se filtra por "tiene stock > 0"
// -- el punto de este modulo es justo reportar cuando el stock del sistema
// no coincide con lo fisico, incluyendo el caso de un codigo que el sistema
// muestra en 0.
export async function resolveProductCandidates(code: string): Promise<Product[]> {
  const raw = code.trim();
  if (!raw) return [];
  const full = fullProductCode(raw);

  const [{ data: byUpc }, { data: byAlu }] = await Promise.all([
    supabase.from("codigos_barra").select("codsap,upc,alu").eq("upc", raw).not("codsap", "is", null).limit(20),
    supabase.from("codigos_barra").select("codsap,upc,alu").eq("alu", raw).not("codsap", "is", null).limit(20),
  ]);
  const mappedCodes = [...new Set(
    [...(byUpc || []), ...(byAlu || [])].flatMap(row => mappedProductCodeCandidates(row as Record<string, unknown>))
  )];

  const orParts: string[] = [`barcode.eq.${raw}`, `erp_sku.eq.${raw}`];
  if (full) orParts.push(`sku.eq.${full}`);
  for (const mappedCode of mappedCodes) orParts.push(`sku.eq.${mappedCode}`);

  const { data, error } = await supabase
    .from("cyclic_products")
    .select("*")
    .eq("is_active", true)
    .or(orParts.join(","));
  if (error) throw error;

  return preferFullCodsapProducts((data || []) as Product[]);
}

// Stock vivo de la tienda del operador -- solo se usa para MOSTRAR la
// ficha antes de guardar. Una vez guardado el reporte, el valor queda
// congelado en system_stock_at_report y esta funcion no se vuelve a llamar
// para ese reporte.
export async function fetchStockForStore(store: Pick<Store, "erp_sede" | "name">, product: Pick<Product, "sku">): Promise<number> {
  const sede = store.erp_sede || store.name;
  if (!sede) return 0;
  const { data, error } = await supabase
    .from("stock_general")
    .select("stock")
    .eq("sede", sede)
    .eq("codsap", fullProductCode(product.sku))
    .maybeSingle();
  if (error) throw error;
  return Number(data?.stock || 0);
}

function provisionalStoreCode(store: Pick<Store, "erp_sede" | "name">): string | null {
  const label = String(store.erp_sede || store.name || "");
  if (/CD-GPC|CENTRO DISTRIBUCION/i.test(label)) return "1000";
  const match = label.match(/^GPC0*(\d+)/i);
  if (!match) return null;
  const number = Number(match[1]);
  const overrides: Record<number, number> = { 2: 4, 3: 5, 4: 2, 5: 3 };
  return String(1000 + (overrides[number] ?? number));
}

export async function fetchProvisionalPending(store: Pick<Store, "erp_sede" | "name">, product: Pick<Product, "sku">): Promise<number> {
  const storeCode = provisionalStoreCode(store);
  if (!storeCode) return 0;
  const { data, error } = await supabase.rpc("get_ajustes_provisionales", {
    year_start: `${new Date().getFullYear()}-01-01`, p_store: storeCode, p_limit: 500, p_offset: 0,
  });
  if (error) throw error;
  const code = fullProductCode(product.sku);
  const row = (data || []).find((item: { product_code?: string }) => String(item.product_code || "") === code) as { total_qty?: number } | undefined;
  return Number(row?.total_qty || 0);
}

export async function uploadDifferencePhoto(file: File): Promise<string> {
  const path = `${crypto.randomUUID()}.jpg`;
  const { error: uploadError } = await supabase.storage.from(PHOTO_BUCKET).upload(path, file);
  if (uploadError) throw uploadError;
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export type NewDifferenceReport = {
  store_id: string | null;
  store_name: string | null;
  product_id: string | null;
  sku: string;
  description: string | null;
  unit: string | null;
  system_stock_at_report: number;
  physical_qty: number | null;
  photo_url: string | null;
  notes: string | null;
  reason: DifferenceReason;
  request_data: DifferenceRequestData;
  operator_id: string;
  operator_name: string;
};

export async function insertDifferenceReport(payload: NewDifferenceReport): Promise<void> {
  const { error } = await supabase.from("inventory_difference_reports").insert(payload);
  if (error) throw error;
}

export async function insertDifferenceReports(payloads: NewDifferenceReport[]): Promise<void> {
  const { error } = await supabase.from("inventory_difference_reports").insert(payloads);
  if (error) throw error;
}

export type FetchReportsParams = {
  scope: "own" | "all";
  operatorId?: string;
  storeId?: string | null;
  status?: DifferenceStatus | "all";
  page: number;
  pageSize: number;
};

export async function fetchDifferenceReports(params: FetchReportsParams): Promise<{ rows: DifferenceReport[]; total: number }> {
  let query = supabase
    .from("inventory_difference_reports")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (params.scope === "own" && params.operatorId) query = query.eq("operator_id", params.operatorId);
  if (params.storeId) query = query.eq("store_id", params.storeId);
  if (params.status && params.status !== "all") query = query.eq("status", params.status);

  const from = (params.page - 1) * params.pageSize;
  const { data, error, count } = await query.range(from, from + params.pageSize - 1);
  if (error) throw error;
  const rawRows = (data || []) as DifferenceReport[];
  const productIds = [...new Set(rawRows.map(row => row.product_id).filter(Boolean))] as string[];
  const costByProductId = new Map<string, number>();
  if (productIds.length > 0) {
    const { data: products } = await supabase.from("cyclic_products").select("id,cost").in("id", productIds);
    for (const product of products || []) costByProductId.set(String(product.id), Number(product.cost || 0));
  }
  const rows = rawRows.map(row => {
    const products = row.request_data?.products || [];
    const role = row.request_data?.cross_line_role;
    const detail = (role ? products.find(product => product.role === role) : null)
      || products.find(product => product.sku === row.sku);
    const storedCost = detail?.cost;
    return {
      ...row,
      // Los reportes nuevos llevan el costo dentro de request_data. Para los
      // históricos se usa el costo actual del catálogo como respaldo.
      cost: storedCost === undefined ? (row.product_id ? costByProductId.get(row.product_id) ?? 0 : 0) : Number(storedCost || 0),
    };
  });
  return { rows, total: count || 0 };
}

export async function updateDifferenceReport(
  id: string,
  payload: { reason: DifferenceReason; physical_qty: number | null; cross_physical_qty?: number | null },
  groupId?: string,
  linkedId?: string,
): Promise<void> {
  if (groupId) {
    const { error: groupError } = await supabase
      .from("inventory_difference_reports")
      .update({ reason: payload.reason })
      .eq("request_data->>cross_group_id", groupId);
    if (groupError) throw groupError;
  }
  const { error } = await supabase
    .from("inventory_difference_reports")
    .update({ reason: payload.reason, physical_qty: payload.physical_qty })
    .eq("id", id)
    .eq("status", "pendiente");
  if (error) throw error;
  if (groupId && linkedId && payload.cross_physical_qty !== undefined) {
    const { error: linkedError } = await supabase
      .from("inventory_difference_reports")
      .update({ reason: payload.reason, physical_qty: payload.cross_physical_qty })
      .eq("id", linkedId)
      .eq("status", "pendiente");
    if (linkedError) throw linkedError;
  }
}

export async function regularizeReport(id: string, adjustmentNumber: string, validator: { id: string; name: string }, groupId?: string): Promise<void> {
  let query = supabase
    .from("inventory_difference_reports")
    .update({
      status: "regularizado",
      adjustment_number: adjustmentNumber,
      validated_by: validator.id,
      validated_by_name: validator.name,
      validated_at: new Date().toISOString(),
    });
  query = groupId ? query.eq("request_data->>cross_group_id", groupId) : query.eq("id", id);
  const { error } = await query;
  if (error) throw error;
}

export async function rejectReport(id: string, validator: { id: string; name: string }, groupId?: string): Promise<void> {
  let query = supabase
    .from("inventory_difference_reports")
    .update({
      status: "rechazado",
      adjustment_number: null,
      validated_by: validator.id,
      validated_by_name: validator.name,
      validated_at: new Date().toISOString(),
    });
  query = groupId ? query.eq("request_data->>cross_group_id", groupId) : query.eq("id", id);
  const { error } = await query;
  if (error) throw error;
}

export async function deleteDifferenceReport(id: string, groupId?: string): Promise<void> {
  let query = supabase.from("inventory_difference_reports").delete();
  query = groupId ? query.eq("request_data->>cross_group_id", groupId) : query.eq("id", id);
  const { error } = await query;
  if (error) throw error;
}
