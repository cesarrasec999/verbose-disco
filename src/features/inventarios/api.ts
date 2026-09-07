/* eslint-disable @typescript-eslint/no-explicit-any */

import type { CountRow, InventorySession, StockGeneralRow, Store, SummaryRow } from "./types";
import { normalizeCode, normalizeLocationCode, normalizeRecordSearch, OPERATOR_RECORDS_PAGE_SIZE } from "./utils";

type SupabaseLike = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
};

export async function fetchPagedSessionRows(
  supabase: SupabaseLike,
  params: {
    table: string;
    select: string;
    sessionId: string;
    orderColumn?: string;
    pageSize?: number;
  }
): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = params.pageSize || 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(params.table)
      .select(params.select)
      .eq("session_id", params.sessionId)
      .order(params.orderColumn || "id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchAllActiveNonInventorySkus(supabase: SupabaseLike): Promise<Array<{ sku: string }>> {
  const rows: Array<{ sku: string }> = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("cyclic_non_inventory_products")
      .select("sku")
      .eq("is_active", true)
      .order("sku", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

export async function fetchAllInventoryCounts(
  supabase: SupabaseLike,
  params: {
    sessionId: string;
    operatorId?: string | null;
    pageSize?: number;
  }
): Promise<CountRow[]> {
  const rows: CountRow[] = [];
  const pageSize = params.pageSize || 1000;
  let from = 0;
  while (true) {
    let request = supabase
      .from("general_inventory_counts")
      .select("*, general_inventory_operators(full_name)")
      .eq("session_id", params.sessionId)
      .order("counted_at", { ascending: false })
      .order("id", { ascending: false });
    if (params.operatorId) request = request.eq("operator_id", params.operatorId);
    const { data, error } = await request.range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...((data || []).map((row: any) => ({
      ...row,
      location_code: normalizeLocationCode(row.location_code),
      operator_name: row.general_inventory_operators?.full_name || null,
    })) as CountRow[]));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

export async function fetchOperatorCountsPage(
  supabase: SupabaseLike,
  params: {
    sessionId: string;
    operatorId: string;
    page: number;
    query: string;
  }
): Promise<{ rows: CountRow[]; total: number }> {
  const from = Math.max(0, (params.page - 1) * OPERATOR_RECORDS_PAGE_SIZE);
  const to = from + OPERATOR_RECORDS_PAGE_SIZE - 1;
  const queryText = normalizeRecordSearch(params.query).replace(/[,%()]/g, " ").trim();

  let request = supabase
    .from("general_inventory_counts")
    .select("*, general_inventory_operators(full_name)", { count: "exact" })
    .eq("session_id", params.sessionId)
    .eq("operator_id", params.operatorId)
    .order("counted_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (queryText) {
    const term = `%${queryText}%`;
    if (/^\d+$/.test(queryText)) {
      const barcodeSkus = await fetchProductSkusByBarcode(supabase, queryText);
      request = barcodeSkus.length > 0
        ? request.in("sku", [...new Set([queryText, ...barcodeSkus])])
        : request.or(`sku.ilike.${term}`);
    } else {
      request = request.or(`sku.ilike.${term},description.ilike.${term},location_code.ilike.${term}`);
    }
  }

  const { data, error, count } = await request;
  if (error) throw error;

  const rows = ((data || []).map((row: any) => ({
    ...row,
    location_code: normalizeLocationCode(row.location_code),
    operator_name: row.general_inventory_operators?.full_name || null,
  })) as CountRow[]);

  return { rows, total: Number(count || 0) };
}

/** Resolves UPC/ALU/product-barcode input to the product SKU used by count rows. */
export async function fetchProductSkusByBarcode(supabase: SupabaseLike, rawQuery: string): Promise<string[]> {
  const raw = normalizeCode(rawQuery).toUpperCase();
  if (!/^\d+$/.test(raw)) return [];
  const withoutLeadingZeros = raw.replace(/^0+(?=\d)/, "");
  const variants = [...new Set([raw, withoutLeadingZeros])];
  const [byUpc, byAlu, byProductBarcode] = await Promise.all([
    supabase.from("codigos_barra").select("codsap").in("upc", variants).not("codsap", "is", null).limit(100),
    supabase.from("codigos_barra").select("codsap").in("alu", variants).not("codsap", "is", null).limit(100),
    supabase.from("cyclic_products").select("sku").in("barcode", variants).eq("is_active", true).limit(100),
  ]);
  return [...new Set([
    ...(byUpc.data || []).map((row: any) => String(row.codsap || "").trim().toUpperCase()),
    ...(byAlu.data || []).map((row: any) => String(row.codsap || "").trim().toUpperCase()),
    ...(byProductBarcode.data || []).map((row: any) => String(row.sku || "").trim().toUpperCase()),
  ].filter(Boolean))];
}

export async function fetchInventoryNonInventoryRows(
  supabase: SupabaseLike,
  sessionId: string
): Promise<Array<{ sku: string }>> {
  const [sessionRows, globalRows] = await Promise.all([
    fetchPagedSessionRows(supabase, {
      table: "general_inventory_non_inventory_products",
      select: "sku",
      sessionId,
      orderColumn: "sku",
    }),
    fetchAllActiveNonInventorySkus(supabase),
  ]);

  const skus = new Set<string>();
  for (const row of sessionRows) {
    const sku = normalizeCode(row.sku).toUpperCase();
    if (sku) skus.add(sku);
  }
  for (const row of globalRows) {
    const sku = normalizeCode(row.sku).toUpperCase();
    if (sku) skus.add(sku);
  }
  return [...skus].map(sku => ({ sku }));
}

export async function fetchNonInventorySkuSetForProducts(
  supabase: SupabaseLike,
  params: {
    sessionId: string;
    skus: string[];
  }
): Promise<Set<string>> {
  const cleanSkus = [...new Set(params.skus.map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
  if (cleanSkus.length === 0) return new Set();

  const rows: Array<{ sku: string }> = [];
  for (let i = 0; i < cleanSkus.length; i += 500) {
    const chunk = cleanSkus.slice(i, i + 500);
    const [sessionRows, globalRows] = await Promise.all([
      supabase.from("general_inventory_non_inventory_products").select("sku").eq("session_id", params.sessionId).in("sku", chunk),
      supabase.from("cyclic_non_inventory_products").select("sku").eq("is_active", true).in("sku", chunk),
    ]);
    if (sessionRows.error) throw sessionRows.error;
    if (globalRows.error) throw globalRows.error;
    rows.push(...(sessionRows.data || []), ...(globalRows.data || []));
  }
  return new Set(rows.map(row => normalizeCode(row.sku).toUpperCase()).filter(Boolean));
}

export async function fetchStockGeneralBySkuForSession(
  supabase: SupabaseLike,
  params: {
    session: InventorySession | null | undefined;
    stores: Store[];
    skus: string[];
  }
): Promise<Map<string, StockGeneralRow>> {
  const store = params.session?.store_id ? params.stores.find(row => row.id === params.session?.store_id) : null;
  const sede = store?.erp_sede || params.session?.store_erp_sede || store?.name || params.session?.store_name || "";
  const cleanSkus = [...new Set(params.skus.map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
  const stockBySku = new Map<string, StockGeneralRow>();
  if (!sede || cleanSkus.length === 0) return stockBySku;

  for (let i = 0; i < cleanSkus.length; i += 100) {
    const chunk = cleanSkus.slice(i, i + 100);
    const { data, error } = await supabase
      .from("stock_general")
      .select("codsap,stock,costo")
      .eq("sede", sede)
      .in("codsap", chunk);
    if (error) throw error;
    for (const row of (data || []) as StockGeneralRow[]) {
      const sku = normalizeCode(row.codsap).toUpperCase();
      if (sku) stockBySku.set(sku, row);
    }
  }

  return stockBySku;
}

export async function fetchProductCategories(
  supabase: SupabaseLike,
  productIds: string[]
): Promise<Map<string, Pick<SummaryRow, "brand" | "department" | "class_name" | "subclass_name">>> {
  const categories = new Map<string, Pick<SummaryRow, "brand" | "department" | "class_name" | "subclass_name">>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return categories;

  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase
      .from("cyclic_products")
      .select("id,brand,department,class_name,subclass_name")
      .in("id", ids.slice(i, i + 500));
    if (error) throw error;
    for (const row of data || []) {
      categories.set(String(row.id), {
        brand: row.brand || null,
        department: row.department || null,
        class_name: row.class_name || null,
        subclass_name: row.subclass_name || null,
      });
    }
  }

  return categories;
}

function normalizeRotationStoreKey(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rotationStoreKeysForSession(session: InventorySession | null | undefined, stores: Store[]) {
  const aliases = [
    "ARBOLEDA", "CALLAO", "GRUPO", "LURIN", "PIURA", "TRUJILLO", "LEGUIA", "CHORILLOS",
    "AREQUIPA NEW K 21", "VILLA EL SALVADOR", "SUMINISTRO", "DIAMANTE", "HUANCAYO",
    "NARANJAL", "PTE PIEDRA", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA",
    "HUACHIPA", "AREQUIPA MIRAFLORES", "CAJAMARCA", "ABANCAY", "CORPORATIVO",
    "CUSCO", "ICA", "HUAROCHIRI", "TIENDA VIRTUAL", "CD",
  ];
  const keys = new Set<string>();
  const store = session?.store_id ? stores.find(item => item.id === session.store_id) : null;
  const sources = [session?.store_name, store?.name, store?.erp_sede, session?.store_id].filter(Boolean) as string[];
  for (const source of sources) {
    const normalized = normalizeRotationStoreKey(source);
    if (!normalized) continue;
    keys.add(normalized);
    for (const alias of aliases) {
      const normalizedAlias = normalizeRotationStoreKey(alias);
      if (normalized.includes(normalizedAlias)) keys.add(normalizedAlias);
    }
    if (normalized.includes("DIAMANTE")) keys.add("CHI. DIAMANTE");
    if (normalized.includes("LEGUIA")) keys.add("CHI. LEGUIA");
    // Las claves usadas en product_rotation_monthly son EVITAMIENTO y
    // MIRAFLORES. Conservamos las claves históricas por compatibilidad,
    // pero siempre agregamos la clave real para que Reporte IG encuentre
    // las rotaciones de Arequipa.
    if (normalized.includes("EVITAMIENTO")) {
      keys.add("EVITAMIENTO");
      keys.add("AREQUIPA NEW K 21");
    }
    if (normalized.includes("ARE MIRAFLORES") || normalized.includes("MIRAFLORES")) {
      keys.add("MIRAFLORES");
      keys.add("AREQUIPA MIRAFLORES");
    }
    if (normalized.includes("CHORILLOS") || normalized.includes("CHORRILLOS")) keys.add("CHORILLOS");
    if (normalized.includes("PTE PIEDRA") || normalized.includes("PUENTE PIEDRA")) keys.add("PTE PIEDRA");
    if (normalized.includes("CENTRO DISTRIBUCION") || normalized === "CD GPC" || normalized.endsWith(" CD")) keys.add("CD");
    if (normalized.includes("CD GPC") || normalized === "CD") keys.add("CD-GPC");
  }
  return [...keys];
}

function sessionRotationPeriod(session: InventorySession | null | undefined) {
  // La rotacion debe ser historica respecto al inventario programado. No
  // usamos finished_at porque una sesion puede cerrarse dias despues.
  const rawDate = session?.scheduled_date || session?.created_at || session?.finished_at || new Date().toISOString();
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7) + "-01";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

export async function fetchProductRotationsForSession(
  supabase: SupabaseLike,
  params: {
    session: InventorySession | null | undefined;
    stores: Store[];
    skus: string[];
  }
): Promise<Map<string, string>> {
  const rotations = new Map<string, string>();
  const cleanSkus = [...new Set(params.skus.map(sku => normalizeCode(sku).toUpperCase()).filter(Boolean))];
  const storeKeys = rotationStoreKeysForSession(params.session, params.stores);
  if (cleanSkus.length === 0 || storeKeys.length === 0) return rotations;

  // El mes en curso todavía está incompleto. Para reportes de inventario se
  // debe usar el último período mensual cerrado, sin mezclar categorías
  // parciales que aún están recalculándose en ERP.
  const sessionPeriod = sessionRotationPeriod(params.session);
  const { data: periodRows, error: periodError } = await supabase
    .from("product_rotation_monthly")
    .select("period_month")
    .in("store_key", storeKeys)
    .lt("period_month", sessionPeriod)
    .order("period_month", { ascending: false })
    .limit(1);
  if (periodError) throw periodError;
  const completePeriod = periodRows?.[0]?.period_month ? String(periodRows[0].period_month) : null;
  if (!completePeriod) return rotations;

  for (let i = 0; i < cleanSkus.length; i += 500) {
    const { data, error } = await supabase
      .from("product_rotation_monthly")
      .select("product_code,rotation_category,period_month,store_key")
      .in("store_key", storeKeys)
      .in("product_code", cleanSkus.slice(i, i + 500))
      .eq("period_month", completePeriod)
      .order("product_code", { ascending: true });
    if (error) throw error;
    for (const row of data || []) {
      const sku = normalizeCode(row.product_code).toUpperCase();
      if (sku && !rotations.has(sku)) rotations.set(sku, String(row.rotation_category || "").trim().toUpperCase());
    }
  }

  return rotations;
}

export async function fetchSummaryRowsFromRpc(
  supabase: SupabaseLike,
  params: {
    sessionId: string;
    session: InventorySession | null | undefined;
    stores: Store[];
  }
): Promise<SummaryRow[] | null> {
  const rows: any[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .rpc("get_general_inventory_summary", { p_session_id: params.sessionId })
      .range(from, from + pageSize - 1);
    if (error) {
      const message = String(error.message || "").toLowerCase();
      if (message.includes("get_general_inventory_summary") || message.includes("could not find") || message.includes("schema cache")) return null;
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  const productRotations = await fetchProductRotationsForSession(supabase, {
    session: params.session,
    stores: params.stores,
    skus: rows.map(row => row.sku),
  });

  return rows.map(row => {
    const sku = String(row.sku || "");
    const systemStock = Number(row.system_stock || 0);
    const counted = Number(row.counted || 0);
    const cost = Number(row.cost || 0);
    const diff = Number(row.diff ?? counted - systemStock);
    return {
      product_id: String(row.product_id || ""),
      sku,
      description: String(row.description || ""),
      unit: String(row.unit || ""),
      brand: row.brand || null,
      department: row.department || null,
      class_name: row.class_name || null,
      subclass_name: row.subclass_name || null,
      rotation_category: productRotations.get(normalizeCode(sku).toUpperCase()) || null,
      system_stock: systemStock,
      counted,
      counted_original: Number(row.counted_original || 0),
      recounted_qty: row.recounted_qty === null || row.recounted_qty === undefined ? null : Number(row.recounted_qty || 0),
      validation_qty: row.validation_qty === null || row.validation_qty === undefined ? null : Number(row.validation_qty || 0),
      diff,
      cost,
      valueDiff: Number(row.value_diff ?? diff * cost),
      re_counted: Boolean(row.re_counted),
      recount_status: (row.recount_status === "counted" || row.recount_status === "assigned") ? row.recount_status : "no",
      validation_status: (row.validation_status === "counted" || row.validation_status === "assigned") ? row.validation_status : "no",
      validated: Boolean(row.validated),
      observation: row.observation || "",
    } as SummaryRow;
  });
}
