"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, FileText, RefreshCw } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";

type Role = "Operario" | "Validador" | "Supervisor" | "Administrador";

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

function fullProductCode(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function parseCost(value: unknown) {
  const raw = String(value ?? "0").replace(/S\/|\s|,/gi, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const [valuationRows, setValuationRows] = useState<ValuationRow[]>([]);
  const [rotationRows, setRotationRows] = useState<RotationRow[]>([]);
  const [updatedAt, setUpdatedAt] = useState("");

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
    }
    void loadStores();
  }, [user]);

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

  async function loadReport() {
    if (!canView) {
      setMessage("Tu usuario no tiene acceso a reportes.");
      return;
    }
    const targetStores = stores.filter(store => store.is_active);
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
      setProgress("");
    } catch (error: unknown) {
      setMessage("Error generando reporte: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
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
      CodigosSinCosto: row.missing_cost_codes,
    }))), "Valorizado por tienda");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rotationRows.map(row => ({
      Rotacion: row.rotation,
      CodigosConStock: row.codes_with_stock,
      Unidades: row.total_units,
      Valorizado: row.inventory_value,
      CodigosSinCosto: row.missing_cost_codes,
    }))), "Valorizado por rotacion");
    XLSX.writeFile(wb, `reportes-inventario-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const totals = useMemo(() => valuationRows.reduce((acc, row) => ({
    stores: acc.stores + 1,
    codes: acc.codes + row.codes_with_stock,
    units: r2(acc.units + row.total_units),
    value: r2(acc.value + row.inventory_value),
    missingCost: acc.missingCost + row.missing_cost_codes,
  }), { stores: 0, codes: 0, units: 0, value: 0, missingCost: 0 }), [valuationRows]);

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
              <p className="truncate text-xs text-slate-500">{user?.full_name || "Usuario"} · valorizado por tienda y rotacion</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={loadReport} disabled={loading || !canView} className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-black text-white disabled:opacity-40">
              <RefreshCw className={`mr-2 inline ${loading ? "animate-spin" : ""}`} size={16} />
              {loading ? "Actualizando..." : "Actualizar"}
            </button>
            <button onClick={exportExcel} disabled={loading || (valuationRows.length === 0 && rotationRows.length === 0)} className="rounded-xl border bg-white px-4 py-2 text-sm font-black text-slate-700 disabled:opacity-40">
              <Download className="mr-2 inline" size={16} /> Excel
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl space-y-4 p-4">
        {message && <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800">{message}</div>}
        {progress && <div className="rounded-2xl border bg-white px-4 py-3 text-sm font-bold text-slate-700">{progress}</div>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Valorizado total</p><p className="mt-1 text-xl font-black">{money(totals.value)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Tiendas</p><p className="mt-1 text-xl font-black">{number2(totals.stores)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Codigos con stock</p><p className="mt-1 text-xl font-black">{number2(totals.codes)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Unidades</p><p className="mt-1 text-xl font-black">{number2(totals.units)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Sin costo</p><p className="mt-1 text-xl font-black text-amber-700">{number2(totals.missingCost)}</p></div>
        </div>

        {updatedAt && <p className="text-xs font-semibold text-slate-400">Ultima consulta: {updatedAt}</p>}

        <div className="rounded-2xl border bg-white">
          <div className="border-b bg-slate-50 px-4 py-3">
            <h2 className="font-black">Valorizado por rotacion</h2>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                <tr><th className="border p-2 text-left">Rotacion</th><th className="border p-2 text-right">Codigos</th><th className="border p-2 text-right">Unidades</th><th className="border p-2 text-right">Valorizado</th><th className="border p-2 text-right">Sin costo</th></tr>
              </thead>
              <tbody>
                {rotationRows.map(row => (
                  <tr key={row.rotation} className="hover:bg-slate-50">
                    <td className="border p-2 font-black">{row.rotation}</td>
                    <td className="border p-2 text-right font-semibold">{number2(row.codes_with_stock)}</td>
                    <td className="border p-2 text-right font-semibold">{number2(row.total_units)}</td>
                    <td className="border p-2 text-right font-black">{money(row.inventory_value)}</td>
                    <td className="border p-2 text-right font-semibold text-amber-700">{number2(row.missing_cost_codes)}</td>
                  </tr>
                ))}
                {rotationRows.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-slate-400">Actualiza para ver el valorizado por rotacion.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border bg-white">
          <div className="border-b bg-slate-50 px-4 py-3">
            <h2 className="font-black">Valorizado por tienda</h2>
          </div>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                <tr><th className="border p-2 text-left">Tienda</th><th className="border p-2 text-right">Codigos</th><th className="border p-2 text-right">Unidades</th><th className="border p-2 text-right">Valorizado</th><th className="border p-2 text-right">Sin costo</th></tr>
              </thead>
              <tbody>
                {valuationRows.map(row => (
                  <tr key={row.store_id} className="hover:bg-slate-50">
                    <td className="border p-2 font-black">{row.store_name}</td>
                    <td className="border p-2 text-right font-semibold">{number2(row.codes_with_stock)}</td>
                    <td className="border p-2 text-right font-semibold">{number2(row.total_units)}</td>
                    <td className="border p-2 text-right font-black">{money(row.inventory_value)}</td>
                    <td className="border p-2 text-right font-semibold text-amber-700">{number2(row.missing_cost_codes)}</td>
                  </tr>
                ))}
                {valuationRows.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-slate-400">Actualiza para ver el valorizado por tienda.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}
