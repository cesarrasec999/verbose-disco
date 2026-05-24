"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, FileText, RefreshCw } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";
import { readSafeSheetMatrix } from "@/lib/safeExcel";

type Role = "Operario" | "Validador" | "Supervisor" | "Administrador";
type ReportTab = "stock" | "rotaciones" | "ventas" | "presupuesto";

type CyclicUser = {
  id: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
};

type Store = {
  id: string;
  code?: string | null;
  name: string;
  erp_sede?: string | null;
  erp_store_no?: string | null;
  is_active: boolean;
};

type ValuationRow = {
  store_id: string;
  store_name: string;
  sede: string;
  codes_with_stock: number;
  total_units: number;
  inventory_value: number;
  missing_cost_codes: number;
};

type RotationRow = {
  rotation: string;
  codes_with_stock: number;
  total_units: number;
  inventory_value: number;
  missing_cost_codes: number;
};

type RotationHistoryRow = {
  snapshot_date: string;
  store_key: string;
  store_name: string;
  rotation_category: string;
  codes_with_stock: number;
  total_units: number;
  inventory_value: number;
};

type RotationBreakRow = {
  store_id: string;
  store_name: string;
  rotation: string;
  sku: string;
  description: string;
  unit: string;
  stock: number;
  cost: number;
};

type InventorySnapshot = {
  id: string;
  snapshot_date: string;
  snapshot_time: string;
  source_name: string | null;
  total_stores: number;
  total_codes: number;
  total_units: number;
  total_value: number;
  created_at: string;
};

type SalesDailyRow = {
  store_id: string;
  store_name: string;
  sales_amount: number;
  cost_amount: number;
  quantity: number;
  documents: number;
};

type SalesReportRow = SalesDailyRow & {
  day_sales_amount: number;
  day_cost_amount: number;
  day_quantity: number;
  day_documents: number;
  margin: number;
  projected_sales: number;
  projected_cost: number;
  inventory_budget: number;
  inventory_value: number;
  inventory_vs_budget: number;
};

const USER_KEY = "cyclic_user";

function r2(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function money(value: number) {
  return `S/ ${Number(value || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function number2(value: number) {
  return Number(value || 0).toLocaleString("es-PE", { maximumFractionDigits: 2 });
}

function percent(value: number) {
  return `${Number(value || 0).toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function Formula({ children }: { children: string }) {
  return <p className="mt-1 text-xs font-semibold text-slate-500">Formula: {children}</p>;
}

function fullProductCode(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function parseCost(value: unknown) {
  const raw = String(value ?? "0").replace(/S\/|\s|,/gi, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartISO(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthEndISO(value = new Date()) {
  return new Date(value.getFullYear(), value.getMonth() + 1, 0).toISOString().slice(0, 10);
}

function businessDays(startISO: string, endISO: string, holidays: Set<string>) {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  let days = 0;
  while (start <= end) {
    const iso = start.toISOString().slice(0, 10);
    if (start.getDay() !== 0 && !holidays.has(iso)) days += 1;
    start.setDate(start.getDate() + 1);
  }
  return days;
}

function cellByHeaders(row: unknown[], headers: string[], names: string[]) {
  const wanted = names.map(name => name.toLowerCase());
  const idx = headers.findIndex(header => wanted.some(name => header.includes(name)));
  return idx >= 0 ? row[idx] : null;
}

function storeNameFromSnapshotRow(row: unknown[], headers: string[]) {
  const normalized = headers.map(header => header.trim().toLowerCase());
  const exactStoreIdx = normalized.findIndex(header => ["tienda", "store", "almacen", "almacén", "local", "sede"].includes(header));
  if (exactStoreIdx >= 0) return String(row[exactStoreIdx] || "").trim();
  const nameIdx = normalized.findIndex(header =>
    ["tienda", "store", "almacen", "almacén", "local", "sede"].some(name => header.includes(name)) &&
    !["codigo", "código", "serie", "cod", "id", "nro", "no"].some(blocked => header.includes(blocked))
  );
  return nameIdx >= 0 ? String(row[nameIdx] || "").trim() : "";
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

function rotationStoreKeysForStore(store: Store) {
  const aliases = [
    "ARBOLEDA", "CALLAO", "GRUPO", "LURIN", "PIURA", "TRUJILLO", "LEGUIA", "CHORRILLOS",
    "AREQUIPA NEW K 21", "VILLA EL SALVADOR", "SUMINISTRO", "DIAMANTE", "HUANCAYO",
    "NARANJAL", "PTE PIEDRA", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA",
    "HUACHIPA", "AREQUIPA MIRAFLORES", "CAJAMARCA", "CD",
  ];
  const keys = new Set<string>();
  const sources = [store.name, store.erp_sede, store.code].filter(Boolean) as string[];
  for (const source of sources) {
    const normalized = normalizeRotationStoreKey(source);
    if (!normalized) continue;
    keys.add(normalized);
    for (const alias of aliases) {
      const normalizedAlias = normalizeRotationStoreKey(alias);
      if (normalized.includes(normalizedAlias)) keys.add(normalizedAlias);
    }
    if (normalized.includes("EVITAMIENTO")) keys.add("AREQUIPA NEW K 21");
    if (normalized.includes("ARE MIRAFLORES") || normalized.includes("MIRAFLORES")) keys.add("AREQUIPA MIRAFLORES");
    if (normalized.includes("CHORILLOS") || normalized.includes("CHORRILLOS")) keys.add("CHORRILLOS");
    if (normalized.includes("PTE PIEDRA") || normalized.includes("PUENTE PIEDRA")) keys.add("PTE PIEDRA");
    if (normalized.includes("CENTRO DISTRIBUCION") || normalized === "CD GPC" || normalized.endsWith(" CD")) keys.add("CD");
  }
  return [...keys];
}

function currentRotationPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function ReportesPage() {
  const [user] = useState<CyclicUser | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CyclicUser;
    } catch {
      return null;
    }
  });
  const [activeTab, setActiveTab] = useState<ReportTab>("stock");
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const [valuationRows, setValuationRows] = useState<ValuationRow[]>([]);
  const [rotationRows, setRotationRows] = useState<RotationRow[]>([]);
  const [rotationHistoryRows, setRotationHistoryRows] = useState<RotationHistoryRow[]>([]);
  const [rotationBreakRows, setRotationBreakRows] = useState<RotationBreakRow[]>([]);
  const [salesRows, setSalesRows] = useState<SalesReportRow[]>([]);
  const [updatedAt, setUpdatedAt] = useState("");
  const [salesUpdatedAt, setSalesUpdatedAt] = useState("");
  const [selectedStoreId, setSelectedStoreId] = useState("all");
  const [reportDate, setReportDate] = useState(todayISO());
  const [snapshotDate, setSnapshotDate] = useState(todayISO());
  const [snapshotFile, setSnapshotFile] = useState<File | null>(null);
  const [snapshotFileName, setSnapshotFileName] = useState("");
  const [snapshots, setSnapshots] = useState<InventorySnapshot[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [selectedSnapshotRows, setSelectedSnapshotRows] = useState<ValuationRow[]>([]);
  const snapshotInputRef = useRef<HTMLInputElement | null>(null);

  const canView = user?.role === "Administrador" || user?.role === "Supervisor" || user?.role === "Validador";

  useEffect(() => {
    if (!user) return;
    async function loadStores() {
      const { data, error } = await supabase.from("stores").select("*").eq("is_active", true).order("name");
      if (error) {
        setMessage("No se pudieron cargar tiendas: " + error.message);
        return;
      }
      const rows = (data || []) as Store[];
      setStores(user?.can_access_all_stores ? rows : rows.filter(store => store.id === user?.store_id));
      if (!user?.can_access_all_stores && user?.store_id) setSelectedStoreId(user.store_id);
    }
    void loadStores();
  }, [user]);

  useEffect(() => {
    if (!canView) return;
    async function loadSnapshots() {
      const { data, error } = await supabase
        .from("inventory_valuation_snapshots")
        .select("*")
        .order("snapshot_date", { ascending: false })
        .order("snapshot_time", { ascending: false })
        .limit(80);
      if (error) {
        setMessage("Falta crear las tablas de historial de valorizado.");
        return;
      }
      setSnapshots((data || []) as InventorySnapshot[]);
    }
    void loadSnapshots();
  }, [canView]);

  useEffect(() => {
    if (selectedSnapshotId) void loadSnapshotRows(selectedSnapshotId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStoreId]);

  const selectedStore = useMemo(() => stores.find(store => store.id === selectedStoreId) || null, [stores, selectedStoreId]);

  async function loadCostMap() {
    const costBySku = new Map<string, number>();
    const PAGE = 1000;
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from("cyclic_products")
        .select("sku,cost")
        .eq("is_active", true)
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (error) throw error;
      for (const product of data || []) costBySku.set(fullProductCode(product.sku), parseCost(product.cost));
      if (!data || data.length < PAGE) break;
      page += 1;
    }
    return costBySku;
  }

  async function loadRotationMapForStore(store: Store, skus: string[]) {
    const rotations = new Map<string, string>();
    const cleanSkus = [...new Set(skus.map(fullProductCode).filter(Boolean))];
    const storeKeys = rotationStoreKeysForStore(store);
    if (cleanSkus.length === 0 || storeKeys.length === 0) return rotations;

    for (let i = 0; i < cleanSkus.length; i += 500) {
      const { data, error } = await supabase
        .from("product_rotation_monthly")
        .select("product_code,rotation_category,period_month")
        .in("store_key", storeKeys)
        .in("product_code", cleanSkus.slice(i, i + 500))
        .lte("period_month", currentRotationPeriod())
        .order("period_month", { ascending: false });
      if (error) {
        console.warn("No se pudieron cargar rotaciones:", error.message);
        return rotations;
      }
      for (const row of data || []) {
        const sku = fullProductCode(row.product_code);
        if (sku && !rotations.has(sku)) rotations.set(sku, String(row.rotation_category || "").trim().toUpperCase());
      }
    }
    return rotations;
  }

  async function loadRotationBreaks(targetStores: Store[]) {
    const breakRows: RotationBreakRow[] = [];
    const PAGE = 1000;
    const productCache = new Map<string, { description: string; unit: string; cost: number }>();

    async function loadProducts(skus: string[]) {
      const missing = [...new Set(skus.map(fullProductCode).filter(sku => sku && !productCache.has(sku)))];
      for (let i = 0; i < missing.length; i += 500) {
        const { data, error } = await supabase
          .from("cyclic_products")
          .select("sku,description,unit,cost")
          .in("sku", missing.slice(i, i + 500))
          .eq("is_active", true);
        if (error) throw error;
        for (const row of data || []) {
          productCache.set(fullProductCode(row.sku), {
            description: String(row.description || ""),
            unit: String(row.unit || ""),
            cost: parseCost(row.cost),
          });
        }
      }
    }

    for (const store of targetStores) {
      const storeKeys = rotationStoreKeysForStore(store);
      const sede = String(store.erp_sede || store.name || "").trim();
      if (storeKeys.length === 0 || !sede) continue;
      setProgress(`Buscando quiebres A/B/C: ${store.name}`);

      const latestRotationBySku = new Map<string, string>();
      let page = 0;
      while (true) {
        const { data, error } = await supabase
          .from("product_rotation_monthly")
          .select("product_code,rotation_category,period_month")
          .in("store_key", storeKeys)
          .in("rotation_category", ["A", "B", "C"])
          .lte("period_month", currentRotationPeriod())
          .order("period_month", { ascending: false })
          .range(page * PAGE, (page + 1) * PAGE - 1);
        if (error) throw error;
        for (const row of data || []) {
          const sku = fullProductCode(row.product_code);
          const rotation = String(row.rotation_category || "").trim().toUpperCase();
          if (sku && ["A", "B", "C"].includes(rotation) && !latestRotationBySku.has(sku)) latestRotationBySku.set(sku, rotation);
        }
        if (!data || data.length < PAGE) break;
        page += 1;
      }

      const skus = [...latestRotationBySku.keys()];
      if (skus.length === 0) continue;
      await loadProducts(skus);

      const stockBySku = new Map<string, number>();
      for (let i = 0; i < skus.length; i += 500) {
        const { data, error } = await supabase
          .from("stock_general")
          .select("codsap,stock")
          .eq("sede", sede)
          .in("codsap", skus.slice(i, i + 500));
        if (error) throw error;
        for (const row of data || []) {
          const sku = fullProductCode(row.codsap);
          stockBySku.set(sku, r2((stockBySku.get(sku) || 0) + Number(row.stock || 0)));
        }
      }

      for (const [sku, rotation] of latestRotationBySku.entries()) {
        const stock = stockBySku.get(sku) || 0;
        if (stock > 0) continue;
        const product = productCache.get(sku);
        breakRows.push({
          store_id: store.id,
          store_name: store.name,
          rotation,
          sku,
          description: product?.description || "",
          unit: product?.unit || "",
          stock,
          cost: product?.cost || 0,
        });
      }
    }

    setRotationBreakRows(breakRows.sort((a, b) =>
      a.store_name.localeCompare(b.store_name) ||
      a.rotation.localeCompare(b.rotation) ||
      b.cost - a.cost ||
      a.sku.localeCompare(b.sku, "es", { numeric: true, sensitivity: "base" })
    ));
  }

  function parseSnapshotRows(rows: unknown[][]): ValuationRow[] {
    if (rows.length < 2) return [];
    const headers = rows[0].map(cell => String(cell || "").trim().toLowerCase());
    const grouped = new Map<string, ValuationRow>();
    const knownStores = new Map<string, Store>();
    for (const store of stores) {
      knownStores.set(String(store.name || "").trim().toLowerCase(), store);
      knownStores.set(String(store.code || "").trim().toLowerCase(), store);
      if (store.erp_sede) knownStores.set(String(store.erp_sede).trim().toLowerCase(), store);
    }

    for (const row of rows.slice(1)) {
      const rawStore = storeNameFromSnapshotRow(row, headers);
      if (!rawStore) continue;
      const store = knownStores.get(rawStore.toLowerCase());
      const storeName = store?.name || rawStore;
      if (/^\d+$/.test(storeName)) continue;
      const key = store?.id || storeName.toLowerCase();
      const code = String(cellByHeaders(row, headers, ["codigosconstock", "codigos con stock", "codigo", "código", "cod.sap", "codsap", "sku"]) || "").trim();
      const stock = parseCost(cellByHeaders(row, headers, ["unidades", "stock", "cantidad", "cant.disponible", "cant disponible"]));
      const cost = parseCost(cellByHeaders(row, headers, ["costo prom", "costo", "ult costo", "cost"]));
      const valueFromFile = parseCost(cellByHeaders(row, headers, ["valorizado", "valor", "total valor", "importe"]));
      const isSummary = headers.some(header => header.includes("valorizado")) && headers.some(header => header.includes("codigos"));
      const rowValue = valueFromFile > 0 ? valueFromFile : r2(stock * cost);
      const existing = grouped.get(key) || {
        store_id: store?.id || key,
        store_name: storeName,
        sede: store?.erp_sede || rawStore,
        codes_with_stock: 0,
        total_units: 0,
        inventory_value: 0,
        missing_cost_codes: 0,
      };
      existing.total_units = r2(existing.total_units + stock);
      existing.inventory_value = r2(existing.inventory_value + rowValue);
      if (isSummary) {
        existing.codes_with_stock = Math.max(existing.codes_with_stock, Math.round(parseCost(cellByHeaders(row, headers, ["codigosconstock", "codigos con stock", "codigos"]))));
      } else if (code) {
        existing.codes_with_stock += 1;
      }
      grouped.set(key, existing);
    }
    return [...grouped.values()].sort((a, b) => b.inventory_value - a.inventory_value || a.store_name.localeCompare(b.store_name));
  }

  async function reloadSnapshots(selectId?: string) {
    const { data, error } = await supabase
      .from("inventory_valuation_snapshots")
      .select("*")
      .order("snapshot_date", { ascending: false })
      .order("snapshot_time", { ascending: false })
      .limit(80);
    if (error) throw error;
    setSnapshots((data || []) as InventorySnapshot[]);
    if (selectId) await loadSnapshotRows(selectId);
  }

  async function loadSnapshotRows(snapshotId: string) {
    setSelectedSnapshotId(snapshotId);
    if (!snapshotId) {
      setSelectedSnapshotRows([]);
      return;
    }
    const query = supabase
      .from("inventory_valuation_snapshot_stores")
      .select("*")
      .eq("snapshot_id", snapshotId)
      .order("inventory_value", { ascending: false });
    const { data, error } = await query;
    if (error) {
      setMessage("No se pudo cargar el historial: " + error.message);
      return;
    }
    const rows = (data || [])
      .filter(row => {
        if (selectedStoreId === "all") return true;
        const store = stores.find(item => item.id === selectedStoreId);
        if (!store) return false;
        const candidates = [row.store_id, row.store_name, row.sede].map(value => normalizeRotationStoreKey(String(value || "")));
        const storeKeys = [store.id, store.name, store.erp_sede, store.code].map(value => normalizeRotationStoreKey(String(value || "")));
        return candidates.some(candidate => storeKeys.includes(candidate));
      })
      .map(row => ({
      store_id: row.store_id || row.store_name,
      store_name: row.store_name,
      sede: row.sede || row.store_name,
      codes_with_stock: Number(row.codes_with_stock || 0),
      total_units: Number(row.total_units || 0),
      inventory_value: Number(row.inventory_value || 0),
      missing_cost_codes: Number(row.missing_cost_codes || 0),
    }));
    setSelectedSnapshotRows(rows);
  }

  async function deleteSnapshot(snapshot: InventorySnapshot) {
    const label = `${snapshot.snapshot_date} ${String(snapshot.snapshot_time || "").slice(0, 5)}`;
    if (!confirm(`Eliminar la fotografía ${label}?`)) return;
    setLoading(true);
    try {
      const { error } = await supabase.from("inventory_valuation_snapshots").delete().eq("id", snapshot.id);
      if (error) throw error;
      if (selectedSnapshotId === snapshot.id) {
        setSelectedSnapshotId("");
        setSelectedSnapshotRows([]);
      }
      await reloadSnapshots();
      setMessage("Fotografía eliminada.");
    } catch (error: unknown) {
      setMessage("Error eliminando fotografía: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  }

  async function uploadSnapshotExcel() {
    if (!snapshotFile) {
      setMessage("Selecciona el Excel de valorizado.");
      return;
    }
    setLoading(true);
    setProgress("Leyendo fotografía...");
    try {
      const rows = await readSafeSheetMatrix(snapshotFile, { maxRows: 50000, maxCols: 60, raw: false });
      const parsed = parseSnapshotRows(rows);
      if (parsed.length === 0) {
        setMessage("No pude leer tiendas/valorizado del Excel.");
        return;
      }
      const totals = parsed.reduce((acc, row) => ({
        stores: acc.stores + 1,
        codes: acc.codes + row.codes_with_stock,
        units: r2(acc.units + row.total_units),
        value: r2(acc.value + row.inventory_value),
      }), { stores: 0, codes: 0, units: 0, value: 0 });
      const { data: existing, error: existingError } = await supabase
        .from("inventory_valuation_snapshots")
        .select("id")
        .eq("snapshot_date", snapshotDate)
        .eq("snapshot_time", "08:00");
      if (existingError) throw existingError;
      if ((existing || []).length > 0) {
        const { error } = await supabase.from("inventory_valuation_snapshots").delete().in("id", (existing || []).map(row => row.id));
        if (error) throw error;
      }
      const { data: snapshot, error: snapshotError } = await supabase
        .from("inventory_valuation_snapshots")
        .insert({
          snapshot_date: snapshotDate,
          snapshot_time: "08:00",
          source_name: snapshotFileName,
          total_stores: totals.stores,
          total_codes: totals.codes,
          total_units: totals.units,
          total_value: totals.value,
          uploaded_by: user?.id || null,
        })
        .select("id")
        .single();
      if (snapshotError) throw snapshotError;
      const insertRows = parsed.map(row => ({
        snapshot_id: snapshot.id,
        store_id: stores.find(store => store.id === row.store_id)?.id || null,
        store_name: row.store_name,
        sede: row.sede,
        codes_with_stock: row.codes_with_stock,
        total_units: row.total_units,
        inventory_value: row.inventory_value,
        missing_cost_codes: row.missing_cost_codes,
      }));
      for (let i = 0; i < insertRows.length; i += 500) {
        const { error } = await supabase.from("inventory_valuation_snapshot_stores").insert(insertRows.slice(i, i + 500));
        if (error) throw error;
      }
      setSnapshotFile(null);
      setSnapshotFileName("");
      if (snapshotInputRef.current) snapshotInputRef.current.value = "";
      setMessage(`Fotografía guardada: ${parsed.length} tienda(s).`);
      await reloadSnapshots(snapshot.id);
    } catch (error: unknown) {
      setMessage("Error guardando fotografía: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
      setProgress("");
    }
  }

  async function loadReport() {
    if (!canView) {
      setMessage("Tu usuario no tiene acceso a reportes.");
      return;
    }
    const targetStores = stores.filter(store => store.is_active && (selectedStoreId === "all" || store.id === selectedStoreId));
    if (targetStores.length === 0) {
      setMessage("No hay tiendas activas para reportar.");
      return;
    }

    setLoading(true);
    setMessage("");
    setProgress("Preparando costos...");
    try {
      const costBySku = await loadCostMap();
      const valuation: ValuationRow[] = [];
      const rotationTotals = new Map<string, RotationRow>();
      const PAGE = 1000;

      for (let storeIndex = 0; storeIndex < targetStores.length; storeIndex += 1) {
        const store = targetStores[storeIndex];
        const sede = String(store.erp_sede || store.name || "").trim();
        if (!sede) continue;
        setProgress(`Calculando ${storeIndex + 1}/${targetStores.length}: ${store.name}`);

        const stockBySku = new Map<string, number>();
        let page = 0;
        while (true) {
          const { data, error } = await supabase
            .from("stock_general")
            .select("codsap,stock")
            .eq("sede", sede)
            .gt("stock", 0)
            .range(page * PAGE, (page + 1) * PAGE - 1);
          if (error) throw error;
          for (const row of data || []) {
            const sku = fullProductCode(row.codsap);
            if (!sku) continue;
            stockBySku.set(sku, r2((stockBySku.get(sku) || 0) + Number(row.stock || 0)));
          }
          if (!data || data.length < PAGE) break;
          page += 1;
        }

        const rotationBySku = await loadRotationMapForStore(store, [...stockBySku.keys()]);
        let totalUnits = 0;
        let inventoryValue = 0;
        let missingCostCodes = 0;

        for (const [sku, stock] of stockBySku.entries()) {
          const cost = costBySku.get(sku) || 0;
          const rowValue = r2(stock * cost);
          totalUnits = r2(totalUnits + stock);
          inventoryValue = r2(inventoryValue + rowValue);
          if (cost <= 0) missingCostCodes += 1;

          const rotation = rotationBySku.get(sku) || "SIN ROTACION";
          const current = rotationTotals.get(rotation) || {
            rotation,
            codes_with_stock: 0,
            total_units: 0,
            inventory_value: 0,
            missing_cost_codes: 0,
          };
          current.codes_with_stock += 1;
          current.total_units = r2(current.total_units + stock);
          current.inventory_value = r2(current.inventory_value + rowValue);
          if (cost <= 0) current.missing_cost_codes += 1;
          rotationTotals.set(rotation, current);
        }

        valuation.push({
          store_id: store.id,
          store_name: store.name,
          sede,
          codes_with_stock: stockBySku.size,
          total_units: totalUnits,
          inventory_value: inventoryValue,
          missing_cost_codes: missingCostCodes,
        });
      }

      setValuationRows(valuation.sort((a, b) => b.inventory_value - a.inventory_value || a.store_name.localeCompare(b.store_name)));
      setRotationRows([...rotationTotals.values()].sort((a, b) => b.inventory_value - a.inventory_value || a.rotation.localeCompare(b.rotation)));
      setUpdatedAt(new Date().toLocaleString("es-PE", { hour12: false }));
      await loadRotationBreaks(targetStores);
      await loadRotationHistory();
      setProgress("");
    } catch (error: unknown) {
      setMessage("Error generando reporte: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  }

  async function loadInventoryValueByStoreForDate(date: string) {
    const { data: snapshotData, error: snapshotError } = await supabase
      .from("inventory_valuation_snapshots")
      .select("id")
      .eq("snapshot_date", date)
      .order("snapshot_time", { ascending: false })
      .limit(1);
    if (snapshotError) throw snapshotError;
    const snapshotId = snapshotData?.[0]?.id;
    if (!snapshotId) return new Map(valuationRows.map(row => [row.store_id, row.inventory_value]));

    const { data, error } = await supabase
      .from("inventory_valuation_snapshot_stores")
      .select("store_id,store_name,sede,inventory_value")
      .eq("snapshot_id", snapshotId);
    if (error) throw error;

    const byStore = new Map<string, number>();
    for (const row of data || []) {
      const candidates = [row.store_id, row.store_name, row.sede].map(value => normalizeRotationStoreKey(String(value || "")));
      const store = stores.find(item => {
        const storeKeys = [item.id, item.name, item.erp_sede, item.code].map(value => normalizeRotationStoreKey(String(value || "")));
        return candidates.some(candidate => storeKeys.includes(candidate));
      });
      if (store) byStore.set(store.id, Number(row.inventory_value || 0));
    }
    return byStore;
  }

  async function loadRotationHistory() {
    try {
      const periodDate = new Date(`${reportDate}T00:00:00`);
      const from = monthStartISO(periodDate);
      let query = supabase
        .from("inventory_rotation_valuation_daily")
        .select("snapshot_date,store_key,store_name,rotation_category,codes_with_stock,total_units,inventory_value")
        .gte("snapshot_date", from)
        .lte("snapshot_date", reportDate)
        .order("snapshot_date", { ascending: false })
        .order("inventory_value", { ascending: false })
        .limit(800);
      if (selectedStore) query = query.in("store_key", rotationStoreKeysForStore(selectedStore));
      const { data, error } = await query;
      if (error) {
        console.warn("No se pudo cargar historico por rotacion:", error.message);
        setRotationHistoryRows([]);
        return;
      }
      setRotationHistoryRows((data || []).map(row => ({
        snapshot_date: String(row.snapshot_date),
        store_key: String(row.store_key || ""),
        store_name: String(row.store_name || ""),
        rotation_category: String(row.rotation_category || "SIN ROTACION"),
        codes_with_stock: Number(row.codes_with_stock || 0),
        total_units: Number(row.total_units || 0),
        inventory_value: Number(row.inventory_value || 0),
      })));
    } catch (error) {
      console.warn("No se pudo cargar historico por rotacion:", error);
      setRotationHistoryRows([]);
    }
  }

  async function loadSalesReport() {
    if (!canView) {
      setMessage("Tu usuario no tiene acceso a reportes.");
      return;
    }
    setLoading(true);
    setMessage("");
    setProgress("Leyendo ventas sincronizadas...");
    try {
      if (valuationRows.length === 0) await loadReport();
      const salesStartDate = monthStartISO(new Date(`${reportDate}T00:00:00`));
      const salesEndDate = reportDate;
      const periodDate = new Date(`${reportDate}T00:00:00`);
      const monthStart = monthStartISO(periodDate);
      const monthEnd = monthEndISO(periodDate);
      const elapsedEnd = salesEndDate;
      const holidayRes = await supabase
        .from("business_holidays")
        .select("holiday_date")
        .gte("holiday_date", monthStart)
        .lte("holiday_date", monthEnd);
      const holidays = new Set((holidayRes.data || []).map(row => String(row.holiday_date)));
      const totalBusinessDays = Math.max(1, businessDays(monthStart, monthEnd, holidays));
      const elapsedBusinessDays = Math.max(1, businessDays(monthStart, elapsedEnd, holidays));

      let query = supabase
        .from("erp_store_sales_daily")
        .select("sales_date,store_key,store_name,sales_amount,cost_amount,quantity,documents")
        .gte("sales_date", salesStartDate)
        .lte("sales_date", salesEndDate);
      if (selectedStore) query = query.in("store_key", rotationStoreKeysForStore(selectedStore));
      const { data, error } = await query;
      if (error) throw error;

      const storeByKey = new Map<string, Store>();
      for (const store of stores) {
        for (const key of rotationStoreKeysForStore(store)) storeByKey.set(normalizeRotationStoreKey(key), store);
      }
      const grouped = new Map<string, SalesDailyRow>();
      const dayGrouped = new Map<string, SalesDailyRow>();
      for (const row of data || []) {
        const key = normalizeRotationStoreKey(String(row.store_key || row.store_name || ""));
        const store = storeByKey.get(key);
        const groupKey = store?.id || key;
        const current = grouped.get(groupKey) || {
          store_id: store?.id || groupKey,
          store_name: store?.name || String(row.store_name || row.store_key || ""),
          sales_amount: 0,
          cost_amount: 0,
          quantity: 0,
          documents: 0,
        };
        current.sales_amount = r2(current.sales_amount + Number(row.sales_amount || 0));
        current.cost_amount = r2(current.cost_amount + Number(row.cost_amount || 0));
        current.quantity = r2(current.quantity + Number(row.quantity || 0));
        current.documents += Number(row.documents || 0);
        grouped.set(groupKey, current);

        if (String(row.sales_date || "") === salesEndDate) {
          const dayCurrent = dayGrouped.get(groupKey) || {
            store_id: store?.id || groupKey,
            store_name: store?.name || String(row.store_name || row.store_key || ""),
            sales_amount: 0,
            cost_amount: 0,
            quantity: 0,
            documents: 0,
          };
          dayCurrent.sales_amount = r2(dayCurrent.sales_amount + Number(row.sales_amount || 0));
          dayCurrent.cost_amount = r2(dayCurrent.cost_amount + Number(row.cost_amount || 0));
          dayCurrent.quantity = r2(dayCurrent.quantity + Number(row.quantity || 0));
          dayCurrent.documents += Number(row.documents || 0);
          dayGrouped.set(groupKey, dayCurrent);
        }
      }
      const valuationByStore = await loadInventoryValueByStoreForDate(reportDate);
      const rows = [...grouped.values()].map(row => {
        const day = dayGrouped.get(row.store_id);
        const margin = row.sales_amount > 0 ? (row.sales_amount - row.cost_amount) / row.sales_amount : 0;
        const projectedSales = r2(row.sales_amount * totalBusinessDays / elapsedBusinessDays);
        const projectedCost = r2(projectedSales * (1 - margin));
        const inventoryBudget = r2(projectedCost * 1.2);
        const inventoryValue = valuationByStore.get(row.store_id) || 0;
        return {
          ...row,
          day_sales_amount: day?.sales_amount || 0,
          day_cost_amount: day?.cost_amount || 0,
          day_quantity: day?.quantity || 0,
          day_documents: day?.documents || 0,
          margin,
          projected_sales: projectedSales,
          projected_cost: projectedCost,
          inventory_budget: inventoryBudget,
          inventory_value: inventoryValue,
          inventory_vs_budget: r2(inventoryValue - inventoryBudget),
        };
      }).sort((a, b) => b.sales_amount - a.sales_amount || a.store_name.localeCompare(b.store_name));
      setSalesRows(rows);
      setSalesUpdatedAt(`Dias habiles: ${elapsedBusinessDays}/${totalBusinessDays}`);
      setProgress("");
    } catch (error: unknown) {
      setMessage("No se pudo leer ventas. Primero ejecuta el SQL y alimenta erp_store_sales_daily desde el sync del servidor. Detalle: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  }

  function refreshActiveTab() {
    if (activeTab === "ventas" || activeTab === "presupuesto") void loadSalesReport();
    else void loadReport();
  }

  function exportExcel() {
    if (valuationRows.length === 0 && rotationRows.length === 0) {
      setMessage("Primero actualiza el reporte.");
      return;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(valuationRows.map(row => ({
      Tienda: row.store_name,
      CodigosConStock: row.codes_with_stock,
      Unidades: row.total_units,
      Valorizado: row.inventory_value,
    }))), "Valorizado por tienda");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rotationRows.map(row => ({
      Rotacion: row.rotation,
      CodigosConStock: row.codes_with_stock,
      Unidades: row.total_units,
      Valorizado: row.inventory_value,
    }))), "Valorizado por rotacion");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesRows.map(row => ({
      Tienda: row.store_name,
      VentaDia: row.day_sales_amount,
      VentaAcumulada: row.sales_amount,
      CostoVentaDia: row.day_cost_amount,
      CostoVentaAcumulado: row.cost_amount,
      Margen: row.margin,
      VentaProyectada: row.projected_sales,
      CostoVentaProyectado: row.projected_cost,
      PresupuestoInventario: row.inventory_budget,
      ValorizadoInventario: row.inventory_value,
      InventarioVsPresupuesto: row.inventory_vs_budget,
    }))), "Ventas presupuesto");
    XLSX.writeFile(wb, `reportes-inventario-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const totals = useMemo(() => valuationRows.reduce((acc, row) => ({
    stores: acc.stores + 1,
    codes: acc.codes + row.codes_with_stock,
    units: r2(acc.units + row.total_units),
    value: r2(acc.value + row.inventory_value),
  }), { stores: 0, codes: 0, units: 0, value: 0 }), [valuationRows]);

  const salesTotals = useMemo(() => salesRows.reduce((acc, row) => ({
    daySales: r2(acc.daySales + row.day_sales_amount),
    dayCost: r2(acc.dayCost + row.day_cost_amount),
    sales: r2(acc.sales + row.sales_amount),
    cost: r2(acc.cost + row.cost_amount),
    projectedSales: r2(acc.projectedSales + row.projected_sales),
    projectedCost: r2(acc.projectedCost + row.projected_cost),
    budget: r2(acc.budget + row.inventory_budget),
    inventory: r2(acc.inventory + row.inventory_value),
  }), { daySales: 0, dayCost: 0, sales: 0, cost: 0, projectedSales: 0, projectedCost: 0, budget: 0, inventory: 0 }), [salesRows]);

  const salesMargin = salesTotals.sales > 0 ? ((salesTotals.sales - salesTotals.cost) / salesTotals.sales) * 100 : 0;
  const inventoryBudgetDiff = r2(salesTotals.inventory - salesTotals.budget);
  const budgetCompliance = salesTotals.budget > 0 ? (salesTotals.inventory / salesTotals.budget) * 100 : 0;
  const breakTotals = useMemo(() => rotationBreakRows.reduce((acc, row) => {
    if (row.rotation === "A") acc.a += 1;
    if (row.rotation === "B") acc.b += 1;
    if (row.rotation === "C") acc.c += 1;
    acc.value = r2(acc.value + row.cost);
    return acc;
  }, { a: 0, b: 0, c: 0, value: 0 }), [rotationBreakRows]);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => { window.location.href = "/dashboard"; }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Volver">
              <ArrowLeft size={20} />
            </button>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white">
              <FileText size={22} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-black">Reportes de inventario</h1>
              <p className="truncate text-xs text-slate-500">{user?.full_name || "Usuario"} - stock, rotaciones, ventas y presupuesto</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={refreshActiveTab} disabled={loading || !canView} className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-black text-white disabled:opacity-40">
              <RefreshCw className={`mr-2 inline ${loading ? "animate-spin" : ""}`} size={16} />
              {loading ? "Actualizando..." : "Actualizar"}
            </button>
            <button onClick={exportExcel} disabled={loading} className="rounded-xl border bg-white px-4 py-2 text-sm font-black text-slate-700 disabled:opacity-40">
              <Download className="mr-2 inline" size={16} /> Excel
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl space-y-4 p-4">
        <div className="grid overflow-hidden rounded-2xl border bg-white p-1 shadow-sm md:grid-cols-4">
          {[
            ["stock", "Valorizado stock"],
            ["rotaciones", "Valorizado por rotaciones"],
            ["ventas", "Ventas y margen"],
            ["presupuesto", "Presupuesto de inventario"],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key as ReportTab)}
              className={`rounded-xl px-4 py-3 text-sm font-black ${activeTab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
            <div>
              <p className="text-sm font-black text-slate-900">Filtro de tienda</p>
              <p className="text-xs text-slate-500">El reporte y el historial se calculan con la tienda seleccionada.</p>
            </div>
            <select
              value={selectedStoreId}
              onChange={e => {
                setSelectedStoreId(e.target.value);
                setValuationRows([]);
                setRotationRows([]);
                setUpdatedAt("");
              }}
              className="min-w-72 rounded-xl border px-3 py-2 text-sm font-bold text-slate-900"
              disabled={!user?.can_access_all_stores || loading}
            >
              {user?.can_access_all_stores && <option value="all">Todas las tiendas</option>}
              {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
            {(activeTab === "ventas" || activeTab === "presupuesto") && (
              <div className="grid gap-1">
                <span className="text-xs font-black text-slate-500">Fecha de corte</span>
                <input type="date" value={reportDate} onChange={event => setReportDate(event.target.value)} className="rounded-xl border px-3 py-2 text-sm font-bold text-slate-900" />
              </div>
            )}
          </div>
        </div>

        {message && <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800">{message}</div>}
        {progress && <div className="rounded-2xl border bg-white px-4 py-3 text-sm font-bold text-slate-700">{progress}</div>}

        {(activeTab === "stock" || activeTab === "rotaciones") && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Valorizado total</p><p className="mt-1 text-xl font-black">{money(totals.value)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Tiendas</p><p className="mt-1 text-xl font-black">{number2(totals.stores)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Codigos con stock</p><p className="mt-1 text-xl font-black">{number2(totals.codes)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Unidades</p><p className="mt-1 text-xl font-black">{number2(totals.units)}</p></div>
        </div>}

        {updatedAt && (activeTab === "stock" || activeTab === "rotaciones") && <p className="text-xs font-semibold text-slate-400">Ultima consulta: {updatedAt}</p>}

        {activeTab === "stock" && <div className="rounded-2xl border bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-black text-slate-900">Historial de valorizados</h2>
              <Formula>fotografia diaria = valorizado guardado a las 8:00 a. m. para comparar el stock historico.</Formula>
              <p className="text-xs text-slate-500">Fotografías guardadas para revisar valorizados anteriores.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900"
                type="date"
                value={snapshotDate}
                onChange={e => setSnapshotDate(e.target.value)}
              />
              <button className="rounded-xl border bg-white px-4 py-2 text-sm font-black text-slate-700" onClick={() => snapshotInputRef.current?.click()}>
                {snapshotFileName || "Seleccionar Excel"}
              </button>
              <input
                ref={snapshotInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0] || null;
                  setSnapshotFile(file);
                  setSnapshotFileName(file?.name || "");
                  e.target.value = "";
                }}
              />
              <button className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-black text-white disabled:opacity-40" disabled={loading || !snapshotFile} onClick={uploadSnapshotExcel}>
                Guardar fotografía
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[330px_1fr]">
            <div className="overflow-hidden rounded-2xl border bg-white">
              <div className="max-h-72 overflow-auto">
                {snapshots.map(snapshot => (
                  <div
                    key={snapshot.id}
                    className={`flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm ${selectedSnapshotId === snapshot.id ? "bg-blue-50 text-blue-900" : "hover:bg-slate-50"}`}
                    onClick={() => loadSnapshotRows(snapshot.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block font-black">{snapshot.snapshot_date} {String(snapshot.snapshot_time || "").slice(0, 5)}</span>
                      <span className="block text-xs text-slate-500">{money(Number(snapshot.total_value || 0))} · {number2(snapshot.total_stores)} tiendas</span>
                    </div>
                    <button
                      className="rounded-lg border border-red-200 px-2 py-1 text-xs font-black text-red-600 hover:bg-red-50 disabled:opacity-40"
                      disabled={loading}
                      onClick={e => { e.stopPropagation(); void deleteSnapshot(snapshot); }}
                    >
                      Quitar
                    </button>
                  </div>
                ))}
                {snapshots.length === 0 && <div className="p-4 text-sm text-slate-400">Sin fotografías guardadas.</div>}
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border bg-white">
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100">
                    <tr>
                      <th className="border p-2 text-left">Tienda</th>
                      <th className="border p-2 text-right">Codigos</th>
                      <th className="border p-2 text-right">Unidades</th>
                      <th className="border p-2 text-right">Valorizado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedSnapshotRows.map(row => (
                      <tr key={row.store_id}>
                        <td className="border p-2 font-bold">{row.store_name}</td>
                        <td className="border p-2 text-right">{number2(row.codes_with_stock)}</td>
                        <td className="border p-2 text-right">{number2(row.total_units)}</td>
                        <td className="border p-2 text-right font-black">{money(row.inventory_value)}</td>
                      </tr>
                    ))}
                    {selectedSnapshotRows.length === 0 && (
                      <tr><td colSpan={4} className="p-6 text-center text-slate-400">{selectedStore ? "Selecciona una fotografía para ver esa tienda." : "Selecciona una fotografía para ver el resumen."}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>}

        {activeTab === "rotaciones" && (
          <>
            <div className="rounded-2xl border bg-white">
              <div className="border-b bg-slate-50 px-4 py-3">
                <h2 className="font-black">Valorizado por rotacion</h2>
                <Formula>valorizado por rotacion = sumatoria del stock actual x costo ERP, agrupado por rotacion mensual.</Formula>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                    <tr><th className="border p-2 text-left">Rotacion</th><th className="border p-2 text-right">Codigos</th><th className="border p-2 text-right">Unidades</th><th className="border p-2 text-right">Valorizado</th></tr>
                  </thead>
                  <tbody>
                    {rotationRows.map(row => (
                      <tr key={row.rotation} className="hover:bg-slate-50">
                        <td className="border p-2 font-black">{row.rotation}</td>
                        <td className="border p-2 text-right font-semibold">{number2(row.codes_with_stock)}</td>
                        <td className="border p-2 text-right font-semibold">{number2(row.total_units)}</td>
                        <td className="border p-2 text-right font-black">{money(row.inventory_value)}</td>
                      </tr>
                    ))}
                    {rotationRows.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-slate-400">Actualiza para ver el valorizado por rotacion.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl border bg-white">
              <div className="border-b bg-slate-50 px-4 py-3">
                <h2 className="font-black">Quiebres A/B/C sin stock</h2>
                <Formula>quiebres = productos con rotacion A, B o C cuyo stock actual en tienda es 0.</Formula>
              </div>
              <div className="grid grid-cols-2 gap-3 border-b p-4 lg:grid-cols-4">
                <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Total quiebres</p><p className="mt-1 text-xl font-black">{number2(rotationBreakRows.length)}</p></div>
                <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Rotacion A</p><p className="mt-1 text-xl font-black text-red-600">{number2(breakTotals.a)}</p></div>
                <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Rotacion B</p><p className="mt-1 text-xl font-black text-orange-600">{number2(breakTotals.b)}</p></div>
                <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Rotacion C</p><p className="mt-1 text-xl font-black text-blue-700">{number2(breakTotals.c)}</p></div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                    <tr>
                      <th className="border p-2 text-left">Tienda</th>
                      <th className="border p-2 text-left">Rotacion</th>
                      <th className="border p-2 text-left">Codigo</th>
                      <th className="border p-2 text-left">Descripcion</th>
                      <th className="border p-2 text-center">UM</th>
                      <th className="border p-2 text-right">Stock</th>
                      <th className="border p-2 text-right">Costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rotationBreakRows.map(row => (
                      <tr key={`${row.store_id}-${row.sku}`} className="hover:bg-red-50/50">
                        <td className="border p-2 font-bold">{row.store_name}</td>
                        <td className={`border p-2 font-black ${row.rotation === "A" ? "text-red-600" : row.rotation === "B" ? "text-orange-600" : "text-blue-700"}`}>{row.rotation}</td>
                        <td className="border p-2 font-black">{row.sku}</td>
                        <td className="border p-2">{row.description || "-"}</td>
                        <td className="border p-2 text-center font-semibold">{row.unit || "-"}</td>
                        <td className="border p-2 text-right font-black text-red-600">{number2(row.stock)}</td>
                        <td className="border p-2 text-right">{money(row.cost)}</td>
                      </tr>
                    ))}
                    {rotationBreakRows.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-slate-400">Actualiza para ver quiebres A/B/C sin stock.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl border bg-white">
              <div className="border-b bg-slate-50 px-4 py-3">
                <h2 className="font-black">Historico de valorizado por rotacion</h2>
                <Formula>historico = fotografias diarias de stock por codigo agrupadas por rotacion y fecha.</Formula>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                    <tr><th className="border p-2 text-left">Fecha</th><th className="border p-2 text-left">Tienda</th><th className="border p-2 text-left">Rotacion</th><th className="border p-2 text-right">Codigos</th><th className="border p-2 text-right">Unidades</th><th className="border p-2 text-right">Valorizado</th></tr>
                  </thead>
                  <tbody>
                    {rotationHistoryRows.slice(0, 80).map(row => (
                      <tr key={`${row.snapshot_date}-${row.store_key}-${row.rotation_category}`} className="hover:bg-slate-50">
                        <td className="border p-2 font-bold">{row.snapshot_date}</td>
                        <td className="border p-2">{row.store_name}</td>
                        <td className="border p-2 font-black">{row.rotation_category}</td>
                        <td className="border p-2 text-right">{number2(row.codes_with_stock)}</td>
                        <td className="border p-2 text-right">{number2(row.total_units)}</td>
                        <td className="border p-2 text-right font-black">{money(row.inventory_value)}</td>
                      </tr>
                    ))}
                    {rotationHistoryRows.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Sin historico cargado. Importa fotografias diarias por codigo para ver esta tabla.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {activeTab === "stock" && <div className="rounded-2xl border bg-white">
          <div className="border-b bg-slate-50 px-4 py-3">
            <h2 className="font-black">Valorizado por tienda</h2>
            <Formula>valorizado por tienda = sumatoria del stock actual x costo ERP por tienda.</Formula>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                <tr><th className="border p-2 text-left">Tienda</th><th className="border p-2 text-right">Codigos</th><th className="border p-2 text-right">Unidades</th><th className="border p-2 text-right">Valorizado</th></tr>
              </thead>
              <tbody>
                {valuationRows.map(row => (
                  <tr key={row.store_id} className="hover:bg-slate-50">
                    <td className="border p-2 font-black">{row.store_name}</td>
                    <td className="border p-2 text-right font-semibold">{number2(row.codes_with_stock)}</td>
                    <td className="border p-2 text-right font-semibold">{number2(row.total_units)}</td>
                    <td className="border p-2 text-right font-black">{money(row.inventory_value)}</td>
                  </tr>
                ))}
                {valuationRows.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-slate-400">Actualiza para ver el valorizado por tienda.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>}

        {activeTab === "ventas" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Venta acumulada</p><p className="mt-1 text-xl font-black">{money(salesTotals.sales)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Costo de venta</p><p className="mt-1 text-xl font-black">{money(salesTotals.cost)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Margen</p><p className="mt-1 text-xl font-black text-green-700">{percent(salesMargin)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Venta proyectada</p><p className="mt-1 text-xl font-black">{money(salesTotals.projectedSales)}</p></div>
            </div>
            {salesUpdatedAt && <p className="text-xs font-semibold text-slate-400">{salesUpdatedAt}</p>}
            <div className="rounded-2xl border bg-white">
              <div className="border-b bg-slate-50 px-4 py-3">
                <h2 className="font-black">Ventas totales por tienda</h2>
                <Formula>venta neta = ventas - notas de credito. Venta proyectada = venta neta acumulada x dias habiles del mes / dias habiles transcurridos. Margen = (venta neta - costo venta) / venta neta.</Formula>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600">
                    <tr><th className="border p-2 text-left">Tienda</th><th className="border p-2 text-right">Venta</th><th className="border p-2 text-right">Costo venta</th><th className="border p-2 text-right">Margen</th><th className="border p-2 text-right">Venta proyectada</th><th className="border p-2 text-right">Costo proyectado</th></tr>
                  </thead>
                  <tbody>
                    {salesRows.map(row => (
                      <tr key={row.store_id}>
                        <td className="border p-2 font-black">{row.store_name}</td>
                        <td className="border p-2 text-right font-black">{money(row.sales_amount)}</td>
                        <td className="border p-2 text-right">{money(row.cost_amount)}</td>
                        <td className="border p-2 text-right font-black text-green-700">{percent(row.margin * 100)}</td>
                        <td className="border p-2 text-right font-black">{money(row.projected_sales)}</td>
                        <td className="border p-2 text-right font-black">{money(row.projected_cost)}</td>
                      </tr>
                    ))}
                    {salesRows.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Actualiza para ver ventas sincronizadas.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {activeTab === "presupuesto" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Valorizado inventario</p><p className="mt-1 text-xl font-black">{money(salesTotals.inventory || totals.value)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Presupuesto inventario</p><p className="mt-1 text-xl font-black">{money(salesTotals.budget)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Cumplimiento</p><p className={`mt-1 text-xl font-black ${budgetCompliance >= 100 ? "text-blue-700" : "text-red-600"}`}>{percent(budgetCompliance)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Inventario vs presupuesto</p><p className={`mt-1 text-xl font-black ${inventoryBudgetDiff >= 0 ? "text-blue-700" : "text-red-600"}`}>{money(inventoryBudgetDiff)}</p></div>
            </div>
            {salesUpdatedAt && <p className="text-xs font-semibold text-slate-400">{salesUpdatedAt}</p>}
            <div className="rounded-2xl border bg-white">
              <div className="border-b bg-slate-50 px-4 py-3">
                <h2 className="font-black">Presupuesto de inventario por tienda</h2>
                <Formula>presupuesto de inventario = costo venta proyectado x 1.2. Cumplimiento = valorizado inventario / presupuesto inventario x 100.</Formula>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600">
                    <tr><th className="border p-2 text-left">Tienda</th><th className="border p-2 text-right">Valorizado actual</th><th className="border p-2 text-right">Costo venta proyectado</th><th className="border p-2 text-right">Presupuesto inv.</th><th className="border p-2 text-right">Cumplimiento</th><th className="border p-2 text-right">Diferencia</th></tr>
                  </thead>
                  <tbody>
                    {salesRows.map(row => (
                      <tr key={row.store_id}>
                        <td className="border p-2 font-black">{row.store_name}</td>
                        <td className="border p-2 text-right font-black">{money(row.inventory_value)}</td>
                        <td className="border p-2 text-right font-black">{money(row.projected_cost)}</td>
                        <td className="border p-2 text-right font-black">{money(row.inventory_budget)}</td>
                        <td className={`border p-2 text-right font-black ${row.inventory_budget > 0 && row.inventory_value / row.inventory_budget >= 1 ? "text-blue-700" : "text-red-600"}`}>{percent(row.inventory_budget > 0 ? (row.inventory_value / row.inventory_budget) * 100 : 0)}</td>
                        <td className={`border p-2 text-right font-black ${row.inventory_vs_budget >= 0 ? "text-blue-700" : "text-red-600"}`}>{money(row.inventory_vs_budget)}</td>
                      </tr>
                    ))}
                    {salesRows.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Actualiza para calcular presupuesto.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
