"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, Download, FileText, RefreshCw } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";
import { useIsMobileAccess } from "@/lib/mobileAccess";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";

type Role = "Operario" | "Validador" | "Supervisor" | "Administrador";
type ReportTab = "stock" | "rotaciones" | "ventas" | "presupuesto";
type HistoryFilter = "day" | "month" | "range";

type CyclicUser = {
  id: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
  can_access_audit?: boolean | null;
  module_access?: string[] | null;
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
  inventory_budget_cost: number;
  inventory_budget: number;
  inventory_value: number;
  inventory_value_cutoff: number;
  inventory_vs_budget: number;
  inventory_cutoff_vs_budget: number;
};

const USER_KEY = "cyclic_user";

function r2(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function isoDatePart(value: unknown) {
  return String(value || "").slice(0, 10);
}

function shortDateLabel(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}` : value;
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

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
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
    "NARANJAL", "PTE PIEDRA", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA", "HUAROCHIRI",
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

function storeMatchKeys(store: Store) {
  return [
    store.id,
    store.name,
    store.erp_sede,
    store.erp_store_no,
    store.code,
    ...rotationStoreKeysForStore(store),
  ]
    .map(value => normalizeRotationStoreKey(String(value || "")))
    .filter(Boolean);
}

function isCdGpcStoreName(value: string) {
  const normalized = normalizeRotationStoreKey(value);
  return normalized === "CD GPC" || normalized === "CD-GPC" || normalized === "CD" || normalized.includes("CD GPC");
}

function currentRotationPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function ReportesModule({ activeTab, basePath = "/reportes", embedded = false }: { activeTab: ReportTab; basePath?: string; embedded?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const isMobileAccess = useIsMobileAccess();
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
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const [valuationRows, setValuationRows] = useState<ValuationRow[]>([]);
  const [rotationRows, setRotationRows] = useState<RotationRow[]>([]);
  const [rotationHistoryRows, setRotationHistoryRows] = useState<RotationHistoryRow[]>([]);
  const [rotationBreakRows, setRotationBreakRows] = useState<RotationBreakRow[]>([]);
  const [salesRows, setSalesRows] = useState<SalesReportRow[]>([]);
  const [salesSort, setSalesSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");
  const [salesUpdatedAt, setSalesUpdatedAt] = useState("");
  const [budgetReportOpen, setBudgetReportOpen] = useState(false);
  const [budgetReportText, setBudgetReportText] = useState("");

  // Filtros compartidos entre las 4 pestañas: viven en la URL
  // (?stores=id1,id2&fecha=yyyy-mm-dd) para que se conserven al navegar.
  const storesParam = searchParams.get("stores") || "";
  const selectedStoreIds = useMemo(
    () => (storesParam ? storesParam.split(",").filter(Boolean) : []),
    [storesParam]
  );
  const reportDate = searchParams.get("fecha") || todayISO();

  const [storeDropdownOpen, setStoreDropdownOpen] = useState(false);
  const [rotationPeriod, setRotationPeriod] = useState(currentRotationPeriod().slice(0, 7));
  const [downloadingDetail, setDownloadingDetail] = useState(false);
  const [rotationCoverage, setRotationCoverage] = useState<{ stores: number; checked: boolean }>({ stores: 0, checked: false });
  const [recalculating, setRecalculating] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("month");
  const [historyDate, setHistoryDate] = useState(reportDate);
  const [historyMonth, setHistoryMonth] = useState(reportDate.slice(0, 7));
  const [historyFrom, setHistoryFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [historyTo, setHistoryTo] = useState(reportDate);
  const [evolutionFilter, setEvolutionFilter] = useState<HistoryFilter>("month");
  const [evolutionDate, setEvolutionDate] = useState(reportDate);
  const [evolutionMonth, setEvolutionMonth] = useState(reportDate.slice(0, 7));
  const [evolutionFrom, setEvolutionFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [evolutionTo, setEvolutionTo] = useState(reportDate);
  const [barStoreIds, setBarStoreIds] = useState<string[]>([]);
  const [evolutionStoreIds, setEvolutionStoreIds] = useState<string[]>([]);
  const [barStoreOpen, setBarStoreOpen] = useState(false);
  const [evolutionStoreOpen, setEvolutionStoreOpen] = useState(false);

  const historyRange = useMemo(() => {
    if (historyFilter === "day") return { from: historyDate, to: historyDate };
    if (historyFilter === "month") {
      const start = new Date(`${historyMonth}-01T00:00:00`);
      return { from: `${historyMonth}-01`, to: monthEndISO(start) };
    }
    return { from: historyFrom || historyTo, to: historyTo || historyFrom };
  }, [historyFilter, historyDate, historyMonth, historyFrom, historyTo]);
  const evolutionRange = useMemo(() => {
    if (evolutionFilter === "day") return { from: evolutionDate, to: evolutionDate };
    if (evolutionFilter === "month") {
      const start = new Date(`${evolutionMonth}-01T00:00:00`);
      return { from: `${evolutionMonth}-01`, to: monthEndISO(start) };
    }
    return { from: evolutionFrom || evolutionTo, to: evolutionTo || evolutionFrom };
  }, [evolutionFilter, evolutionDate, evolutionMonth, evolutionFrom, evolutionTo]);
  const historyQueryRange = useMemo(() => ({
    from: historyRange.from < evolutionRange.from ? historyRange.from : evolutionRange.from,
    to: historyRange.to > evolutionRange.to ? historyRange.to : evolutionRange.to,
  }), [historyRange.from, historyRange.to, evolutionRange.from, evolutionRange.to]);

  function updateQuery(patch: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function tabHref(tab: ReportTab) {
    const base = `${basePath}/${tab}`;
    const qs = searchParams.toString();
    return qs ? `${base}?${qs}` : base;
  }

  useEffect(() => {
    if (isMobileAccess) window.location.replace("/dashboard");
  }, [isMobileAccess]);

  useEffect(() => {
    if (!user) return;
    fetchDisabledModules().then(disabled => {
      if (isModuleBlockedForUser(disabled, "reports", user)) setModuleDisabled(true);
    });
  }, [user]);

  const canView = Boolean(
    user && (
      canAccessModule(user, "reports") ||
      canAccessModule(user, "reports_non_inventory") ||
      canAccessModule(user, "reports_results") ||
      user.role === "Administrador" ||
      user.role === "Supervisor" ||
      user.role === "Validador"
    )
  );
  // En Análisis, el selector de tiendas es una segmentación de consulta. El
  // acceso al módulo ya se valida arriba; no debe quedar bloqueado por el
  // alcance operativo de la sesión.
  const canSelectAllStores = Boolean(user && (embedded || user.can_access_all_stores || canView));

  useEffect(() => {
    if (!user) return;
    async function loadStores() {
      const { data, error } = await supabase.from("stores").select("*").eq("is_active", true).order("name");
      if (error) {
        setMessage("No se pudieron cargar tiendas: " + error.message);
        return;
      }
      const rows = (data || []) as Store[];
      setStores(canSelectAllStores ? rows : rows.filter(store => store.id === user?.store_id));
      if (!canSelectAllStores && user?.store_id && !storesParam) updateQuery({ stores: user.store_id });
    }
    void loadStores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, canSelectAllStores]);

  useEffect(() => {
    if (activeTab !== "rotaciones" || !canView) return;
    void checkRotationCoverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, canView, rotationPeriod]);

  const selectedStores = useMemo(
    () => selectedStoreIds.length === 0 ? [] : stores.filter(store => selectedStoreIds.includes(store.id)),
    [stores, selectedStoreIds]
  );
  useEffect(() => {
    if ((activeTab !== "stock" && activeTab !== "rotaciones") || !canView || !stores.length) return;
    void loadRotationHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, canView, stores.length, historyQueryRange.from, historyQueryRange.to, selectedStoreIds.join(",")]);

  const sortedSalesRows = useMemo(() => {
    if (!salesSort) return salesRows;
    return [...salesRows].sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;
      switch (salesSort.col) {
        case "store_name": aVal = a.store_name; bVal = b.store_name; break;
        case "day_sales": aVal = a.day_sales_amount; bVal = b.day_sales_amount; break;
        case "day_cost": aVal = a.day_cost_amount; bVal = b.day_cost_amount; break;
        case "day_margin": aVal = a.day_sales_amount > 0 ? (a.day_sales_amount - a.day_cost_amount) / a.day_sales_amount : 0; bVal = b.day_sales_amount > 0 ? (b.day_sales_amount - b.day_cost_amount) / b.day_sales_amount : 0; break;
        case "sales": aVal = a.sales_amount; bVal = b.sales_amount; break;
        case "cost_accumulated": aVal = a.cost_amount; bVal = b.cost_amount; break;
        case "proj_sales": aVal = a.projected_sales; bVal = b.projected_sales; break;
        case "proj_cost": aVal = a.projected_cost; bVal = b.projected_cost; break;
        case "proj_margin": aVal = a.projected_sales > 0 ? (a.projected_sales - a.projected_cost) / a.projected_sales : 0; bVal = b.projected_sales > 0 ? (b.projected_sales - b.projected_cost) / b.projected_sales : 0; break;
        case "inventory_value": aVal = a.inventory_value; bVal = b.inventory_value; break;
        case "inventory_value_cutoff": aVal = a.inventory_value_cutoff; bVal = b.inventory_value_cutoff; break;
        case "budget_cost": aVal = a.inventory_budget_cost; bVal = b.inventory_budget_cost; break;
        case "budget": aVal = a.inventory_budget; bVal = b.inventory_budget; break;
        case "compliance": aVal = a.inventory_budget > 0 ? a.inventory_value / a.inventory_budget : 0; bVal = b.inventory_budget > 0 ? b.inventory_value / b.inventory_budget : 0; break;
        case "diff": aVal = a.inventory_vs_budget; bVal = b.inventory_vs_budget; break;
        case "cutoff_diff": aVal = a.inventory_cutoff_vs_budget; bVal = b.inventory_cutoff_vs_budget; break;
        case "cutoff_compliance": aVal = a.inventory_budget > 0 ? a.inventory_value_cutoff / a.inventory_budget : 0; bVal = b.inventory_budget > 0 ? b.inventory_value_cutoff / b.inventory_budget : 0; break;
        case "current_compliance": aVal = a.inventory_budget > 0 ? a.inventory_value / a.inventory_budget : 0; bVal = b.inventory_budget > 0 ? b.inventory_value / b.inventory_budget : 0; break;
      }
      if (typeof aVal === "string") return salesSort.dir === "asc" ? aVal.localeCompare(bVal as string, "es") : (bVal as string).localeCompare(aVal, "es");
      return salesSort.dir === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  }, [salesRows, salesSort]);

  function toggleSort(col: string) {
    setSalesSort(prev => prev?.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  }

  function sortIcon(col: string) {
    if (salesSort?.col !== col) return <span className="ml-1 opacity-30">⇅</span>;
    return <span className="ml-1">{salesSort.dir === "asc" ? "▲" : "▼"}</span>;
  }

  // Fila que devuelve la funcion SQL get_stock_valuation_report:
  // valorizado de UNA sede ya agrupado por categoria de rotacion.
  type StockValuationRpcRow = {
    rotation: string;
    codes_with_stock: number;
    total_units: number;
    inventory_value: number;
    missing_cost_codes: number;
  };

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

  async function checkRotationCoverage() {
    if (!rotationPeriod) return;
    const periodMonth = `${rotationPeriod}-01`;
    const keys = new Set<string>();
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("product_rotation_monthly")
        .select("store_key")
        .eq("period_month", periodMonth)
        .range(from, from + PAGE - 1);
      if (error) break;
      for (const row of data || []) keys.add(row.store_key);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    setRotationCoverage({ stores: keys.size, checked: true });
  }

  async function recalculateRotationNow() {
    if (!rotationPeriod) return;
    setRecalculating(true);
    setMessage("");
    try {
      const periodMonth = `${rotationPeriod}-01`;
      const res = await fetch("/api/admin/recalcular-rotaciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period_month: periodMonth }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Error ${res.status}`);
      setMessage(`Rotaciones recalculadas para ${rotationPeriod}.`);
      await checkRotationCoverage();
    } catch (error: unknown) {
      setMessage("Error recalculando rotaciones: " + errorMessage(error));
    } finally {
      setRecalculating(false);
    }
  }

  async function loadReport() {
    if (!canView) {
      setMessage("Tu usuario no tiene acceso a reportes.");
      return;
    }
    const targetStores = stores.filter(store => store.is_active && (selectedStoreIds.length === 0 || selectedStoreIds.includes(store.id)));
    if (targetStores.length === 0) {
      setMessage("No hay tiendas activas para reportar.");
      return;
    }

    setLoading(true);
    setMessage("");
    setProgress("Generando reporte...");
    try {
      const valuation: ValuationRow[] = [];
      const rotationTotals = new Map<string, RotationRow>();

      for (let storeIndex = 0; storeIndex < targetStores.length; storeIndex += 1) {
        const store = targetStores[storeIndex];
        const sede = String(store.erp_sede || store.name || "").trim();
        if (!sede) continue;
        setProgress(`Calculando ${storeIndex + 1}/${targetStores.length}: ${store.name}`);

        // El join stock x costo x rotacion y el GROUP BY se hacen en la BD
        // (funcion get_stock_valuation_report); llega ~1 fila por rotacion
        // en vez de todo stock_general + todo el catalogo activo.
        const { data, error } = await supabase.rpc("get_stock_valuation_report", {
          p_sede: sede,
          p_rotation_store_keys: rotationStoreKeysForStore(store),
          p_rotation_period: currentRotationPeriod(),
        });
        if (error) throw error;
        const groups = (data || []) as StockValuationRpcRow[];

        let codesWithStock = 0;
        let totalUnits = 0;
        let inventoryValue = 0;
        let missingCostCodes = 0;

        for (const group of groups) {
          const rotation = String(group.rotation || "SIN ROTACION");
          const codes = Number(group.codes_with_stock || 0);
          const units = Number(group.total_units || 0);
          const value = Number(group.inventory_value || 0);
          const missing = Number(group.missing_cost_codes || 0);

          codesWithStock += codes;
          totalUnits = r2(totalUnits + units);
          inventoryValue = r2(inventoryValue + value);
          missingCostCodes += missing;

          const current = rotationTotals.get(rotation) || {
            rotation,
            codes_with_stock: 0,
            total_units: 0,
            inventory_value: 0,
            missing_cost_codes: 0,
          };
          current.codes_with_stock += codes;
          current.total_units = r2(current.total_units + units);
          current.inventory_value = r2(current.inventory_value + value);
          current.missing_cost_codes += missing;
          rotationTotals.set(rotation, current);
        }

        valuation.push({
          store_id: store.id,
          store_name: store.name,
          sede,
          codes_with_stock: codesWithStock,
          total_units: totalUnits,
          inventory_value: inventoryValue,
          missing_cost_codes: missingCostCodes,
        });
      }

      const sortedValuation = valuation.sort((a, b) => b.inventory_value - a.inventory_value || a.store_name.localeCompare(b.store_name));
      setValuationRows(sortedValuation);
      setRotationRows([...rotationTotals.values()].sort((a, b) => b.inventory_value - a.inventory_value || a.rotation.localeCompare(b.rotation)));
      setUpdatedAt(new Date().toLocaleString("es-PE", { hour12: false }));
      // Los quiebres A/B/C son exclusivos de la pestaña de rotaciones.
      // El histórico de valorizados alimenta los gráficos de stock y se carga
      // de forma independiente según el filtro de fecha seleccionado.
      if (activeTab === "rotaciones") {
        await loadRotationBreaks(targetStores);
      } else {
        setRotationBreakRows([]);
      }
      setProgress("");
      return sortedValuation;
    } catch (error: unknown) {
      setMessage("Error generando reporte: " + errorMessage(error));
      return [];
    } finally {
      setLoading(false);
    }
  }

  async function loadInventoryValueByStoreForDate(date: string, fallbackRows = valuationRows) {
    const { data: snapshotData, error: snapshotError } = await supabase
      .from("inventory_valuation_snapshots")
      .select("id")
      .eq("snapshot_date", date)
      .order("snapshot_time", { ascending: false })
      .limit(1);
    if (snapshotError) throw snapshotError;
    const snapshotId = snapshotData?.[0]?.id;
    if (!snapshotId) return new Map(fallbackRows.map(row => [row.store_id, row.inventory_value]));

    const { data, error } = await supabase
      .from("inventory_valuation_snapshot_stores")
      .select("store_id,store_name,sede,inventory_value")
      .eq("snapshot_id", snapshotId);
    if (error) throw error;

    const byStore = new Map<string, number>();
    for (const row of data || []) {
      const candidates = [row.store_id, row.store_name, row.sede].map(value => normalizeRotationStoreKey(String(value || "")));
      const store = stores.find(item => {
        const storeKeys = storeMatchKeys(item);
        return candidates.some(candidate => storeKeys.includes(candidate));
      });
      if (store) byStore.set(store.id, Number(row.inventory_value || 0));
    }
    return byStore;
  }

  async function loadRotationHistory() {
    try {
      const { from, to } = historyQueryRange;
      if (!from || !to || from > to) {
        setRotationHistoryRows([]);
        return;
      }
      let query = supabase
        .from("inventory_rotation_valuation_daily")
        .select("snapshot_date,store_key,store_name,rotation_category,codes_with_stock,total_units,inventory_value")
        .gte("snapshot_date", from)
        .lte("snapshot_date", to)
        .order("snapshot_date", { ascending: false })
        .order("inventory_value", { ascending: false })
        .limit(10000);
      if (selectedStores.length > 0 && activeTab !== "stock") {
        const allKeys = selectedStores.flatMap(s => rotationStoreKeysForStore(s));
        query = query.in("store_key", allKeys);
      }
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
      const targetStores = stores.filter(store => store.is_active && (selectedStoreIds.length === 0 || selectedStoreIds.includes(store.id)));
      if (targetStores.length === 0) {
        setMessage("No hay tiendas activas para reportar.");
        return;
      }
      const selectedIsCdGpc = selectedStores.length > 0 && selectedStores.some(s => isCdGpcStoreName(s.name));
      const calculationStores = selectedIsCdGpc ? stores.filter(store => store.is_active) : targetStores;
      const valuationFallback = (valuationRows.length === 0 ? await loadReport() : valuationRows) || [];
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
      if (selectedStores.length > 0 && !selectedIsCdGpc) {
        const allKeys = selectedStores.flatMap(s => rotationStoreKeysForStore(s));
        query = query.in("store_key", allKeys);
      }
      const { data, error } = await query;
      if (error) throw error;
      const loadedSalesDates = [...new Set((data || []).map(row => isoDatePart(row.sales_date)).filter(Boolean))].sort();
      const latestLoadedSalesDate = loadedSalesDates[loadedSalesDates.length - 1] || "";

      const storeByKey = new Map<string, Store>();
      for (const store of calculationStores) {
        for (const key of rotationStoreKeysForStore(store)) storeByKey.set(normalizeRotationStoreKey(key), store);
      }
      const grouped = new Map<string, SalesDailyRow>();
      const dayGrouped = new Map<string, SalesDailyRow>();
      for (const store of calculationStores) {
        grouped.set(store.id, {
          store_id: store.id,
          store_name: store.name,
          sales_amount: 0,
          cost_amount: 0,
          quantity: 0,
          documents: 0,
        });
      }
      let selectedDayRows = 0;
      for (const row of data || []) {
        const key = normalizeRotationStoreKey(String(row.store_key || row.store_name || ""));
        const store = storeByKey.get(key);
        if (!store) continue;
        const groupKey = store.id;
        const current = grouped.get(groupKey) || {
          store_id: store.id,
          store_name: store.name,
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

        if (isoDatePart(row.sales_date) === salesEndDate) {
          selectedDayRows += 1;
          const dayCurrent = dayGrouped.get(groupKey) || {
            store_id: store.id,
            store_name: store.name,
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
      const currentValuationByStore = new Map(valuationFallback.map(row => [row.store_id, Number(row.inventory_value || 0)]));
      const cutoffValuationByStore = await loadInventoryValueByStoreForDate(reportDate, valuationFallback);
      const rows = [...grouped.values()].map(row => {
        const day = dayGrouped.get(row.store_id);
        const margin = row.sales_amount > 0 ? (row.sales_amount - row.cost_amount) / row.sales_amount : 0;
        const projectedSales = r2(row.sales_amount * totalBusinessDays / elapsedBusinessDays);
        const projectedCost = r2(projectedSales * (1 - margin));
        const inventoryBudget = r2(projectedCost * 1.2);
        const inventoryValue = currentValuationByStore.get(row.store_id) || 0;
        const inventoryValueCutoff = cutoffValuationByStore.get(row.store_id) ?? inventoryValue;
        return {
          ...row,
          day_sales_amount: day?.sales_amount || 0,
          day_cost_amount: day?.cost_amount || 0,
          day_quantity: day?.quantity || 0,
          day_documents: day?.documents || 0,
          margin,
          projected_sales: projectedSales,
          projected_cost: projectedCost,
          inventory_budget_cost: projectedCost,
          inventory_budget: inventoryBudget,
          inventory_value: inventoryValue,
          inventory_value_cutoff: inventoryValueCutoff,
          inventory_vs_budget: r2(inventoryValue - inventoryBudget),
          inventory_cutoff_vs_budget: r2(inventoryValueCutoff - inventoryBudget),
        };
      });

      const otherRows = rows.filter(row => !isCdGpcStoreName(row.store_name));
      const cdProjectedCost = r2(otherRows.reduce((sum, row) => sum + row.projected_cost, 0));
      const cdInventoryBudget = r2(otherRows.reduce((sum, row) => sum + row.inventory_budget, 0));
      for (const row of rows) {
        if (!isCdGpcStoreName(row.store_name)) continue;
        row.inventory_budget_cost = cdProjectedCost;
        row.inventory_budget = cdInventoryBudget;
        row.inventory_vs_budget = r2(row.inventory_value - row.inventory_budget);
        row.inventory_cutoff_vs_budget = r2(row.inventory_value_cutoff - row.inventory_budget);
      }

      const visibleRows = selectedStoreIds.length === 0 ? rows : rows.filter(row => selectedStoreIds.includes(row.store_id));
      visibleRows.sort((a, b) => b.sales_amount - a.sales_amount || a.store_name.localeCompare(b.store_name));
      setSalesRows(visibleRows);
      setSalesUpdatedAt(`Fecha seleccionada: ${salesEndDate} | Filas del dia: ${selectedDayRows} | Ultima venta sincronizada: ${latestLoadedSalesDate || "sin datos"} | Dias habiles: ${elapsedBusinessDays}/${totalBusinessDays}`);
      if (selectedDayRows === 0 && latestLoadedSalesDate && latestLoadedSalesDate < salesEndDate) {
        setMessage(`No hay ventas sincronizadas para ${salesEndDate}. Ultima fecha disponible en ventas: ${latestLoadedSalesDate}.`);
      }
      setProgress("");
    } catch (error: unknown) {
      setMessage("No se pudo leer ventas. Primero ejecuta el SQL y alimenta erp_store_sales_daily desde el sync del servidor. Detalle: " + errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function refreshActiveTab() {
    if (activeTab === "ventas" || activeTab === "presupuesto") void loadSalesReport();
    else void loadReport();
  }

  async function downloadRotationDetail() {
    if (!rotationPeriod) { setMessage("Selecciona un periodo."); return; }
    setDownloadingDetail(true);
    setMessage("Generando detalle de rotaciones...");
    try {
      const periodDate = `${rotationPeriod}-01`;
      const res = await fetch("/api/admin/rotacion-detalle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period_month: periodDate }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Error ${res.status}`);
      const rows = (json.rows || []) as {
        report_store_name: string;
        report_product_code: string;
        report_description: string;
        report_unit: string;
        report_rotation_category: string;
        report_avg_sales_3m: number;
        report_stock: number;
        report_cost: number;
        report_inventory_value: number;
        report_last_sale_month: string | null;
        report_sales_qty_total: number;
        report_period_month: string;
      }[];
      if (rows.length === 0) { setMessage("Sin datos de rotación para ese periodo."); return; }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.map(r => ({
        Tienda: r.report_store_name,
        Codigo: r.report_product_code,
        Descripcion: r.report_description || "",
        UM: r.report_unit || "",
        Rotacion: r.report_rotation_category,
        "Prom Ventas 3m": r.report_avg_sales_3m ?? 0,
        "Stock Actual": r.report_stock ?? 0,
        Costo: r.report_cost ?? 0,
        Valorizado: r.report_inventory_value ?? 0,
        "Ultimo Mes Venta": r.report_last_sale_month ?? "",
        "Total Ventas": r.report_sales_qty_total ?? 0,
        Periodo: r.report_period_month,
      }))), "Detalle Rotaciones");
      XLSX.writeFile(wb, `rotaciones-detalle-${rotationPeriod}.xlsx`);
      setMessage(`${rows.length.toLocaleString("es-PE")} registros exportados.`);
    } catch (e) {
      setMessage("Error: " + errorMessage(e));
    } finally {
      setDownloadingDetail(false);
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
    }))), "Valorizado por tienda");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rotationRows.map(row => ({
      Rotacion: row.rotation,
      CodigosConStock: row.codes_with_stock,
      Unidades: row.total_units,
      Valorizado: row.inventory_value,
    }))), "Valorizado por rotacion");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesRows.map(row => ({
      Tienda: row.store_name,
      VentaAcumulada: row.sales_amount,
      CostoVentaAcumulado: row.cost_amount,
      PresupuestoInventario: row.inventory_budget,
      ValorizadoInventarioFechaCorte: row.inventory_value_cutoff,
      CumplimientoFechaCorte: row.inventory_budget > 0 ? (row.inventory_value_cutoff / row.inventory_budget) * 100 : 0,
      InventarioFechaCorteVsPresupuesto: row.inventory_cutoff_vs_budget,
      ValorizadoInventarioActual: row.inventory_value,
      CumplimientoActual: row.inventory_budget > 0 ? (row.inventory_value / row.inventory_budget) * 100 : 0,
      InventarioActualVsPresupuesto: row.inventory_vs_budget,
    }))), "Ventas presupuesto");
    XLSX.writeFile(wb, `reportes-inventario-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function openBudgetReport() {
    const isExcludedFromWhatsApp = (row: SalesReportRow) => {
      const storeName = row.store_name.toLowerCase();
      const compactStoreName = storeName.replace(/\s+/g, "");
      return compactStoreName.includes("cd-gpc") || storeName.includes("corporativo") || storeName.includes("td virtual");
    };
    const whatsappRows = salesRows.filter(row => !isExcludedFromWhatsApp(row));
    const whatsappTotals = whatsappRows.reduce((acc, row) => ({
      budget: r2(acc.budget + row.inventory_budget),
      inventoryCutoff: r2(acc.inventoryCutoff + row.inventory_value_cutoff),
      inventoryCurrent: r2(acc.inventoryCurrent + row.inventory_value),
    }), { budget: 0, inventoryCutoff: 0, inventoryCurrent: 0 });
    const whatsappCutoffDiff = r2(whatsappTotals.inventoryCutoff - whatsappTotals.budget);
    const whatsappCurrentDiff = r2(whatsappTotals.inventoryCurrent - whatsappTotals.budget);
    const topRows = [...whatsappRows]
      .sort((a, b) => Math.abs(b.inventory_cutoff_vs_budget) - Math.abs(a.inventory_cutoff_vs_budget))
      .slice(0, 5);
    const selectedLabel = String(whatsappRows.length) + " tienda" + (whatsappRows.length === 1 ? "" : "s") + " consideradas";
    const currentDateLabel = new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
    const signedMoney = (value: number) => (value >= 0 ? "+" : "") + money(value);
    const lines = [
      "*REPORTE DE PRESUPUESTO DE INVENTARIO*",
      selectedLabel,
      "",
      "*CIERRE DE MES (" + shortDateLabel(reportDate) + ")*",
      "Valorizado: " + money(whatsappTotals.inventoryCutoff) + " | Presupuesto: " + money(whatsappTotals.budget),
      "Desviación al cierre: *" + signedMoney(whatsappCutoffDiff) + "*",
      "",
      "*ACTUALIDAD (" + currentDateLabel + ")*",
      "Valorizado actual: " + money(whatsappTotals.inventoryCurrent) + " | Presupuesto: " + money(whatsappTotals.budget),
      "Desviación actual: *" + signedMoney(whatsappCurrentDiff) + "*",
      "",
      "*Top 5 tiendas con mayor desviación:*",
      ...topRows.map((row, index) => {
        const cutoffPct = row.inventory_budget > 0 ? (row.inventory_cutoff_vs_budget / row.inventory_budget) * 100 : 0;
        const currentDiff = r2(row.inventory_vs_budget);
        const currentPct = row.inventory_budget > 0 ? (currentDiff / row.inventory_budget) * 100 : 0;
        return String(index + 1) + ". " + row.store_name + " | Cierre: " + signedMoney(row.inventory_cutoff_vs_budget) + " (" + (cutoffPct >= 0 ? "+" : "") + percent(cutoffPct) + ") | Actual: " + signedMoney(currentDiff) + " (" + (currentPct >= 0 ? "+" : "") + percent(currentPct) + ")";
      }),
      "",
      "Las desviaciones comparan el valorizado con el presupuesto y pueden ser positivas o negativas; se muestran al cierre y a la actualidad.",
      "",
      "*ACCIONES SUGERIDAS*",
      "Priorizar las tiendas con mayor desviación para recuperar ventas, reducir quiebres y ajustar el inventario al presupuesto.",
      "Coordinar la logística inversa para redistribuir mercadería de productos con menor rotación hacia tiendas donde sí puedan venderse.",
    ];
    setBudgetReportText(lines.join("\n"));
    setBudgetReportOpen(true);
  }

  async function copyBudgetReport() {
    try {
      await navigator.clipboard.writeText(budgetReportText);
      setMessage("Mensaje de presupuesto copiado.");
    } catch {
      setMessage("No se pudo copiar automáticamente; selecciona el texto del cuadro.");
    }
  }

  function sendBudgetReportWhatsApp() {
    window.open("https://wa.me/?text=" + encodeURIComponent(budgetReportText), "_blank", "noopener,noreferrer");
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
    inventoryCutoff: r2(acc.inventoryCutoff + row.inventory_value_cutoff),
  }), { daySales: 0, dayCost: 0, sales: 0, cost: 0, projectedSales: 0, projectedCost: 0, budget: 0, inventory: 0, inventoryCutoff: 0 }), [salesRows]);

  const salesDayMargin = salesTotals.daySales > 0 ? ((salesTotals.daySales - salesTotals.dayCost) / salesTotals.daySales) * 100 : 0;
  const projectedMargin = salesTotals.projectedSales > 0 ? ((salesTotals.projectedSales - salesTotals.projectedCost) / salesTotals.projectedSales) * 100 : 0;
  const inventoryBudgetDiff = r2(salesTotals.inventory - salesTotals.budget);
  const inventoryCutoffBudgetDiff = r2(salesTotals.inventoryCutoff - salesTotals.budget);
  const budgetCompliance = salesTotals.budget > 0 ? (salesTotals.inventory / salesTotals.budget) * 100 : 0;
  const breakTotals = useMemo(() => rotationBreakRows.reduce((acc, row) => {
    if (row.rotation === "A") acc.a += 1;
    if (row.rotation === "B") acc.b += 1;
    if (row.rotation === "C") acc.c += 1;
    acc.value = r2(acc.value + row.cost);
    return acc;
  }, { a: 0, b: 0, c: 0, value: 0 }), [rotationBreakRows]);

  const valuationChart = useMemo(() => {
    const barKeys = new Set(stores.filter(store => barStoreIds.includes(store.id)).flatMap(rotationStoreKeysForStore).map(normalizeRotationStoreKey));
    const lineKeys = new Set(stores.filter(store => evolutionStoreIds.includes(store.id)).flatMap(rotationStoreKeysForStore).map(normalizeRotationStoreKey));
    const matches = (row: RotationHistoryRow, ids: string[], keys: Set<string>) => ids.length === 0 || keys.has(normalizeRotationStoreKey(row.store_key)) || ids.some(id => id === row.store_key);
    const barRowsSource = rotationHistoryRows.filter(row => row.snapshot_date >= historyRange.from && row.snapshot_date <= historyRange.to && matches(row, barStoreIds, barKeys));
    const lineRowsSource = rotationHistoryRows.filter(row => row.snapshot_date >= evolutionRange.from && row.snapshot_date <= evolutionRange.to && matches(row, evolutionStoreIds, lineKeys));
    const byDate = new Map<string, Map<string, { name: string; value: number }>>();
    for (const row of lineRowsSource) {
      if (!byDate.has(row.snapshot_date)) byDate.set(row.snapshot_date, new Map());
      const storesForDate = byDate.get(row.snapshot_date)!;
      const key = row.store_key || row.store_name;
      const current = storesForDate.get(key);
      storesForDate.set(key, {
        name: row.store_name,
        value: (current?.value || 0) + row.inventory_value,
      });
    }
    const dates = [...byDate.keys()].sort();
    const periodKeys = evolutionFilter === "month" ? dates : [...new Set(dates.map(date => date.slice(0, 7)))].sort();
    const periodStoreRows = new Map<string, Map<string, { name: string; value: number }>>();
    for (const period of periodKeys) {
      const date = evolutionFilter === "month" ? period : dates.filter(item => item.startsWith(period)).at(-1);
      if (date) periodStoreRows.set(period, byDate.get(date) || new Map());
    }
    const barDates = [...new Set(barRowsSource.map(row => row.snapshot_date))].sort();
    const latestDate = barDates.at(-1) || "";
    const latestRows = new Map<string, { name: string; value: number }>();
    for (const row of barRowsSource.filter(item => item.snapshot_date === latestDate)) {
      const key = row.store_key || row.store_name;
      const current = latestRows.get(key);
      latestRows.set(key, { name: row.store_name, value: (current?.value || 0) + row.inventory_value });
    }
    const bars = [...latestRows.entries()]
      .map(([key, row]) => ({ key, ...row }))
      .sort((a, b) => b.value - a.value);
    const storeKeys = [...new Set(periodKeys.flatMap(period => [...(periodStoreRows.get(period)?.keys() || [])]))];
    const lines = storeKeys.map(key => ({
      key,
      name: periodKeys.map(period => periodStoreRows.get(period)?.get(key)?.name).find(Boolean) || key,
      values: periodKeys.map(period => periodStoreRows.get(period)?.get(key)?.value || 0),
    })).sort((a, b) => (b.values.at(-1) || 0) - (a.values.at(-1) || 0));
    return { latestDate, bars, periods: periodKeys, lines };
  }, [rotationHistoryRows, stores, barStoreIds, evolutionStoreIds, historyRange.from, historyRange.to, evolutionRange.from, evolutionRange.to, evolutionFilter]);

  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Reportes" />;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      {!embedded && <header className="sticky top-0 z-20 border-b bg-white px-4 py-3">
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
            {activeTab === "presupuesto" && <button onClick={openBudgetReport} disabled={loading || salesRows.length === 0} className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-black text-white disabled:opacity-40">Reporte</button>}
            <button onClick={exportExcel} disabled={loading} className="rounded-xl border bg-white px-4 py-2 text-sm font-black text-slate-700 disabled:opacity-40">
              <Download className="mr-2 inline" size={16} /> Excel
            </button>
          </div>
        </div>
      </header>}

      {embedded && <div className="mx-auto flex max-w-7xl justify-end gap-2 px-4 pt-4">
        <button onClick={refreshActiveTab} disabled={loading || !canView} className="rounded-xl bg-blue-700 px-4 py-2 text-sm font-black text-white disabled:opacity-40">
          <RefreshCw className={`mr-2 inline ${loading ? "animate-spin" : ""}`} size={16} />
          {loading ? "Actualizando..." : "Actualizar"}
        </button>
        {activeTab === "presupuesto" && <button onClick={openBudgetReport} disabled={loading || salesRows.length === 0} className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-black text-white disabled:opacity-40">Reporte</button>}
        <button onClick={exportExcel} disabled={loading} className="rounded-xl border bg-white px-4 py-2 text-sm font-black text-slate-700 disabled:opacity-40"><Download className="mr-2 inline" size={16} /> Excel</button>
      </div>}

      <section className="mx-auto max-w-7xl space-y-4 p-4">
        {!embedded && <div className="grid overflow-hidden rounded-2xl border bg-white p-1 shadow-sm md:grid-cols-4">
          {[
            ["stock", "Valorizado stock"],
            ["rotaciones", "Valorizado por rotaciones"],
            ["ventas", "Ventas y margen"],
            ["presupuesto", "Presupuesto de inventario"],
          ].map(([key, label]) => (
            <Link
              key={key}
              href={tabHref(key as ReportTab)}
              className={`rounded-xl px-4 py-3 text-center text-sm font-black ${activeTab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {label}
            </Link>
          ))}
        </div>}

        {activeTab !== "stock" && <div className="rounded-2xl border bg-white p-4">
          <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
            <div>
              <p className="text-sm font-black text-slate-900">Filtro de tienda</p>
              <p className="text-xs text-slate-500">Selecciona una o varias tiendas. Sin selección muestra todas.</p>
            </div>
            <div className="relative min-w-72">
              <button
                type="button"
                disabled={!canSelectAllStores || loading}
                onClick={() => setStoreDropdownOpen(prev => !prev)}
                className="w-full rounded-xl border px-3 py-2 text-left text-sm font-bold text-slate-900 bg-white disabled:opacity-50 flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  {selectedStoreIds.length === 0
                    ? "Todas las tiendas"
                    : selectedStoreIds.length === 1
                    ? (stores.find(s => s.id === selectedStoreIds[0])?.name ?? "1 tienda")
                    : `${selectedStoreIds.length} tiendas seleccionadas`}
                </span>
                <span className="text-slate-400 shrink-0">{storeDropdownOpen ? "▲" : "▼"}</span>
              </button>
              {storeDropdownOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setStoreDropdownOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-full min-w-72 max-h-72 overflow-y-auto rounded-xl border bg-white shadow-lg">
                    {canSelectAllStores && (
                      <label className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={selectedStoreIds.length === 0}
                          onChange={() => { updateQuery({ stores: null }); setValuationRows([]); setRotationRows([]); setUpdatedAt(""); }}
                        />
                        <span className="text-sm font-black text-slate-700">Todas las tiendas</span>
                      </label>
                    )}
                    {stores.filter(s => !!s.erp_sede).map(store => (
                      <label key={store.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={selectedStoreIds.includes(store.id)}
                          onChange={() => {
                            const next = selectedStoreIds.includes(store.id)
                              ? selectedStoreIds.filter(id => id !== store.id)
                              : [...selectedStoreIds, store.id];
                            updateQuery({ stores: next.length ? next.join(",") : null });
                            setValuationRows([]);
                            setRotationRows([]);
                            setUpdatedAt("");
                          }}
                        />
                        <span className="text-sm text-slate-700">{store.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
            {(activeTab === "ventas" || activeTab === "presupuesto") && (
              <div className="grid gap-1">
                <span className="text-xs font-black text-slate-500">Fecha de corte</span>
                <input type="date" value={reportDate} onChange={event => updateQuery({ fecha: event.target.value })} className="rounded-xl border px-3 py-2 text-sm font-bold text-slate-900" />
              </div>
            )}
          </div>
        </div>}

        {message && <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800">{message}</div>}
        {progress && <div className="rounded-2xl border bg-white px-4 py-3 text-sm font-bold text-slate-700">{progress}</div>}

        {(activeTab === "stock" || activeTab === "rotaciones") && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Valorizado total</p><p className="mt-1 text-xl font-black">{money(totals.value)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Tiendas</p><p className="mt-1 text-xl font-black">{number2(totals.stores)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Codigos con stock</p><p className="mt-1 text-xl font-black">{number2(totals.codes)}</p></div>
          <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Unidades</p><p className="mt-1 text-xl font-black">{number2(totals.units)}</p></div>
        </div>}

        {updatedAt && (activeTab === "stock" || activeTab === "rotaciones") && <p className="text-xs font-semibold text-slate-400">Ultima consulta: {updatedAt}</p>}

        {activeTab === "stock" && <div className="space-y-4 rounded-2xl border bg-white p-4">
          <div>
            <h2 className="font-black text-slate-900">Evolución del valorizado</h2>
            <p className="text-xs font-semibold text-slate-500">Consulta las fotografías disponibles y compara el valorizado de las tiendas en el tiempo.</p>
          </div>
          <h3 className="mt-4 text-sm font-black text-slate-800">Filtro del gráfico de barras</h3>
          <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-slate-50 p-3">
            <div className="flex rounded-xl border bg-white p-1 text-xs font-black">
              {([["day", "Día"], ["month", "Mes"], ["range", "Rango"]] as [HistoryFilter, string][]).map(([key, label]) => (
                <button key={key} onClick={() => setHistoryFilter(key)} className={`rounded-lg px-3 py-2 ${historyFilter === key ? "bg-slate-950 text-white" : "text-slate-600"}`}>{label}</button>
              ))}
            </div>
            {historyFilter === "day" && <label className="text-xs font-black text-slate-600">Fecha<input type="date" value={historyDate} onChange={e => setHistoryDate(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label>}
            {historyFilter === "month" && <label className="text-xs font-black text-slate-600">Mes<input type="month" value={historyMonth} onChange={e => setHistoryMonth(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label>}
            {historyFilter === "range" && <><label className="text-xs font-black text-slate-600">Desde<input type="date" value={historyFrom} onChange={e => setHistoryFrom(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label><label className="text-xs font-black text-slate-600">Hasta<input type="date" value={historyTo} onChange={e => setHistoryTo(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label></>}
            <div className="relative text-xs font-black text-slate-600"><span>Tiendas</span><button type="button" onClick={() => setBarStoreOpen(prev => !prev)} className="mt-1 flex min-w-64 items-center justify-between rounded-xl border bg-white px-3 py-2 text-left text-sm font-bold text-slate-900"><span className="truncate">{barStoreIds.length === 0 ? "Todas las tiendas" : `${barStoreIds.length} tienda(s)`}</span><span className="ml-3 text-slate-400">{barStoreOpen ? "▲" : "▼"}</span></button>{barStoreOpen && <><div className="fixed inset-0 z-10" onClick={() => setBarStoreOpen(false)} /><div className="absolute left-0 z-20 mt-1 max-h-64 min-w-72 overflow-y-auto rounded-xl border bg-white p-2 shadow-xl"><label className="flex cursor-pointer items-center gap-2 border-b px-2 py-2 text-sm"><input type="checkbox" checked={barStoreIds.length === 0} onChange={() => setBarStoreIds([])} />Todas las tiendas</label>{stores.map(store => <label key={store.id} className="flex cursor-pointer items-center gap-2 px-2 py-2 text-sm hover:bg-slate-50"><input type="checkbox" checked={barStoreIds.includes(store.id)} onChange={() => setBarStoreIds(prev => prev.includes(store.id) ? prev.filter(id => id !== store.id) : [...prev, store.id])} />{store.name}</label>)}</div></>}</div>
            <span className="text-xs font-bold text-slate-500">Disponible: {historyRange.from} al {historyRange.to}</span>
          </div>

          <div className="rounded-2xl border p-4">
            <h3 className="mb-3 font-black">Valorizado disponible — {valuationChart.latestDate || "sin datos"}</h3>
            <div className="space-y-2">
              {valuationChart.bars.map(row => {
                const max = valuationChart.bars[0]?.value || 1;
                return <div key={row.key} className="grid grid-cols-[minmax(140px,240px)_1fr_auto] items-center gap-3 text-xs"><span className="truncate font-black text-slate-700">{row.name}</span><div className="h-6 overflow-hidden rounded-lg bg-slate-100"><div className="h-full rounded-lg bg-blue-600" style={{ width: `${Math.max(1, (row.value / max) * 100)}%` }} /></div><span className="w-28 text-right font-black">{money(row.value)}</span></div>;
              })}
              {valuationChart.bars.length === 0 && <p className="py-8 text-center text-sm font-bold text-slate-400">No hay valorizados disponibles para el filtro seleccionado.</p>}
            </div>
          </div>

          <div className="rounded-2xl border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-black">Evolución por tienda</h3><p className="text-xs font-semibold text-slate-500">En modo mes se muestra cada día disponible; en rango se toma el último día disponible de cada mes.</p></div><span className="text-xs font-bold text-slate-500">{valuationChart.lines.length} tiendas</span></div>
            <h4 className="mb-2 text-sm font-black text-slate-800">Filtro del gráfico evolutivo</h4>
            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl bg-slate-50 p-3">
              <div className="flex rounded-xl border bg-white p-1 text-xs font-black">{([["day", "Día"], ["month", "Mes"], ["range", "Rango"]] as [HistoryFilter, string][]).map(([key, label]) => <button key={key} onClick={() => setEvolutionFilter(key)} className={`rounded-lg px-3 py-2 ${evolutionFilter === key ? "bg-slate-950 text-white" : "text-slate-600"}`}>{label}</button>)}</div>
              {evolutionFilter === "day" && <label className="text-xs font-black text-slate-600">Fecha<input type="date" value={evolutionDate} onChange={e => setEvolutionDate(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label>}
              {evolutionFilter === "month" && <label className="text-xs font-black text-slate-600">Mes<input type="month" value={evolutionMonth} onChange={e => setEvolutionMonth(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label>}
              {evolutionFilter === "range" && <><label className="text-xs font-black text-slate-600">Desde<input type="date" value={evolutionFrom} onChange={e => setEvolutionFrom(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label><label className="text-xs font-black text-slate-600">Hasta<input type="date" value={evolutionTo} onChange={e => setEvolutionTo(e.target.value)} className="mt-1 block rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900" /></label></>}
              <div className="relative text-xs font-black text-slate-600"><span>Tiendas</span><button type="button" onClick={() => setEvolutionStoreOpen(prev => !prev)} className="mt-1 flex min-w-64 items-center justify-between rounded-xl border bg-white px-3 py-2 text-left text-sm font-bold text-slate-900"><span className="truncate">{evolutionStoreIds.length === 0 ? "Todas las tiendas" : `${evolutionStoreIds.length} tienda(s)`}</span><span className="ml-3 text-slate-400">{evolutionStoreOpen ? "▲" : "▼"}</span></button>{evolutionStoreOpen && <><div className="fixed inset-0 z-10" onClick={() => setEvolutionStoreOpen(false)} /><div className="absolute left-0 z-20 mt-1 max-h-64 min-w-72 overflow-y-auto rounded-xl border bg-white p-2 shadow-xl"><label className="flex cursor-pointer items-center gap-2 border-b px-2 py-2 text-sm"><input type="checkbox" checked={evolutionStoreIds.length === 0} onChange={() => setEvolutionStoreIds([])} />Todas las tiendas</label>{stores.map(store => <label key={store.id} className="flex cursor-pointer items-center gap-2 px-2 py-2 text-sm hover:bg-slate-50"><input type="checkbox" checked={evolutionStoreIds.includes(store.id)} onChange={() => setEvolutionStoreIds(prev => prev.includes(store.id) ? prev.filter(id => id !== store.id) : [...prev, store.id])} />{store.name}</label>)}</div></>}</div>
              <span className="text-xs font-bold text-slate-500">Disponible: {evolutionRange.from} al {evolutionRange.to}</span>
            </div>
            {valuationChart.periods.length > 0 ? <div className="overflow-x-auto"><svg viewBox="0 0 900 320" className="min-w-[720px] w-full" role="img" aria-label="Evolución del valorizado por tienda"><line x1="50" y1="20" x2="50" y2="270" stroke="#cbd5e1" /><line x1="50" y1="270" x2="880" y2="270" stroke="#cbd5e1" />{[0, 1, 2, 3, 4].map(i => <line key={i} x1="50" y1={20 + i * 62.5} x2="880" y2={20 + i * 62.5} stroke="#e2e8f0" strokeDasharray="4 4" />)}{valuationChart.lines.slice(0, 12).map((line, index) => { const max = Math.max(...valuationChart.lines.flatMap(item => item.values), 1); const points = line.values.map((value, i) => `${50 + (valuationChart.periods.length === 1 ? 0 : i * (830 / (valuationChart.periods.length - 1)))},${270 - (value / max) * 240}`).join(" "); const colors = ["#2563eb", "#0f766e", "#dc2626", "#ca8a04", "#7c3aed", "#0891b2", "#db2777", "#ea580c", "#16a34a", "#4f46e5", "#be123c", "#475569"]; return <g key={line.key}><polyline points={points} fill="none" stroke={colors[index % colors.length]} strokeWidth="3" />{line.values.map((value, i) => <circle key={`${line.key}-${i}`} cx={50 + (valuationChart.periods.length === 1 ? 0 : i * (830 / (valuationChart.periods.length - 1)))} cy={270 - (value / max) * 240} r="4" fill={colors[index % colors.length]}><title>{`${line.name} · ${valuationChart.periods[i]}: ${money(value)}`}</title></circle>)}</g>; })}{valuationChart.periods.map((period, i) => <text key={period} x={50 + (valuationChart.periods.length === 1 ? 0 : i * (830 / (valuationChart.periods.length - 1)))} y="294" textAnchor="middle" fontSize="11" fill="#475569">{period}</text>)}</svg></div> : <p className="py-12 text-center text-sm font-bold text-slate-400">No hay datos históricos para graficar.</p>}
            <div className="mt-3 flex flex-wrap gap-3">{valuationChart.lines.slice(0, 12).map((line, index) => <span key={line.key} className="text-xs font-bold text-slate-600"><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: ["#2563eb", "#0f766e", "#dc2626", "#ca8a04", "#7c3aed", "#0891b2", "#db2777", "#ea580c", "#16a34a", "#4f46e5", "#be123c", "#475569"][index % 12] }} />{line.name}</span>)}</div>
          </div>
        </div>}

        {activeTab === "rotaciones" && (
          <>
            <div className="rounded-2xl border bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-black text-slate-900">Rotaciones mensuales</h2>
                  <Formula>rotaciones del mes = calculadas automaticamente cada dia desde ventas y notas de credito (erp_movements); ya no se sube Excel.</Formula>
                  {rotationCoverage.checked && (
                    <p className={`mt-1 text-xs font-bold ${rotationCoverage.stores >= 20 ? "text-emerald-700" : "text-amber-700"}`}>
                      {rotationCoverage.stores >= 20
                        ? `Periodo ${rotationPeriod}: ${rotationCoverage.stores} tiendas calculadas.`
                        : `Periodo ${rotationPeriod}: solo ${rotationCoverage.stores} tienda(s) calculadas. Falta el calculo automatico de este mes (corre diariamente en el servidor).`}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="rounded-xl border bg-white px-3 py-2 text-sm font-bold text-slate-900"
                    type="month"
                    value={rotationPeriod}
                    onChange={e => setRotationPeriod(e.target.value)}
                  />
                  {user?.role === "Administrador" && (
                    <button
                      className="rounded-xl border bg-amber-50 px-4 py-2 text-sm font-black text-amber-700 disabled:opacity-40 hover:bg-amber-100"
                      disabled={recalculating || !rotationPeriod}
                      onClick={recalculateRotationNow}
                      title="Forzar el calculo ahora en vez de esperar la revision automatica diaria del servidor"
                    >
                      {recalculating ? "Calculando..." : "Calcular ahora"}
                    </button>
                  )}
                  <button
                    className="rounded-xl border bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-700 disabled:opacity-40 hover:bg-emerald-100"
                    disabled={downloadingDetail || !rotationPeriod}
                    onClick={downloadRotationDetail}
                  >
                    <Download className="mr-2 inline" size={16} />
                    {downloadingDetail ? "Generando..." : "Detalle Excel"}
                  </button>
                </div>
              </div>
            </div>

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

        {activeTab === "ventas" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
              <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Venta del dia</p><p className="mt-1 text-xl font-black">{money(salesTotals.daySales)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Venta total</p><p className="mt-1 text-xl font-black">{money(salesTotals.sales)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Costo del dia</p><p className="mt-1 text-xl font-black">{money(salesTotals.dayCost)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Margen del dia</p><p className="mt-1 text-xl font-black text-green-700">{percent(salesDayMargin)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Venta proyectada</p><p className="mt-1 text-xl font-black">{money(salesTotals.projectedSales)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Margen proyectado</p><p className="mt-1 text-xl font-black text-green-700">{percent(projectedMargin)}</p></div>
            </div>
            {salesUpdatedAt && <p className="text-xs font-semibold text-slate-400">{salesUpdatedAt}</p>}
            <div className="rounded-2xl border bg-white">
              <div className="border-b bg-slate-50 px-4 py-3">
                <h2 className="font-black">Ventas del dia por tienda</h2>
                <Formula>venta del dia = venta neta sincronizada para la fecha seleccionada. Venta proyectada = venta neta acumulada x dias habiles del mes / dias habiles transcurridos.</Formula>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1220px] text-sm">
                  <thead className="bg-slate-100 text-xs text-slate-600">
                    <tr>
                      <th onClick={() => toggleSort("store_name")} className="cursor-pointer select-none border p-2 text-left hover:bg-slate-200">Tienda{sortIcon("store_name")}</th>
                      <th onClick={() => toggleSort("day_sales")} className="cursor-pointer select-none border p-2 text-right hover:bg-slate-200">Venta dia{sortIcon("day_sales")}</th>
                      <th onClick={() => toggleSort("day_cost")} className="cursor-pointer select-none border p-2 text-right hover:bg-slate-200">Costo dia{sortIcon("day_cost")}</th>
                      <th onClick={() => toggleSort("day_margin")} className="cursor-pointer select-none border p-2 text-right hover:bg-slate-200">Margen dia{sortIcon("day_margin")}</th>
                      <th onClick={() => toggleSort("sales")} className="cursor-pointer select-none border p-2 text-right hover:bg-slate-200">Venta acumulada{sortIcon("sales")}</th>
                      <th onClick={() => toggleSort("proj_sales")} className="cursor-pointer select-none border p-2 text-right hover:bg-slate-200">Venta proyectada{sortIcon("proj_sales")}</th>
                      <th onClick={() => toggleSort("proj_cost")} className="cursor-pointer select-none border p-2 text-right hover:bg-slate-200">Costo proyectado{sortIcon("proj_cost")}</th>
                      <th onClick={() => toggleSort("proj_margin")} className="cursor-pointer select-none border p-2 text-right hover:bg-slate-200">Margen proyectado{sortIcon("proj_margin")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSalesRows.map(row => (
                      <tr key={row.store_id}>
                        <td className="border p-2 font-black">{row.store_name}</td>
                        <td className="border p-2 text-right font-black">{money(row.day_sales_amount)}</td>
                        <td className="border p-2 text-right">{money(row.day_cost_amount)}</td>
                        <td className="border p-2 text-right font-black text-green-700">{percent(row.day_sales_amount > 0 ? ((row.day_sales_amount - row.day_cost_amount) / row.day_sales_amount) * 100 : 0)}</td>
                        <td className="border p-2 text-right">{money(row.sales_amount)}</td>
                        <td className="border p-2 text-right font-black">{money(row.projected_sales)}</td>
                        <td className="border p-2 text-right font-black">{money(row.projected_cost)}</td>
                        <td className="border p-2 text-right font-black text-green-700">{percent(row.projected_sales > 0 ? ((row.projected_sales - row.projected_cost) / row.projected_sales) * 100 : 0)}</td>
                      </tr>
                    ))}
                    {salesRows.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-slate-400">Actualiza para ver ventas sincronizadas.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {activeTab === "presupuesto" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
              <div className="rounded-2xl bg-emerald-700 p-4 text-white"><p className="text-xs font-bold text-emerald-100">Venta total seleccionada</p><p className="mt-1 text-xl font-black">{money(salesTotals.sales)}</p></div>
              <div className="rounded-2xl bg-slate-900 p-4 text-white"><p className="text-xs font-bold text-slate-300">Valorizado actual</p><p className="mt-1 text-xl font-black">{money(salesTotals.inventory || totals.value)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Valorizado fecha corte</p><p className="mt-1 text-xl font-black">{money(salesTotals.inventoryCutoff)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Presupuesto inventario</p><p className="mt-1 text-xl font-black">{money(salesTotals.budget)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Cumplimiento actual</p><p className={`mt-1 text-xl font-black ${budgetCompliance >= 100 ? "text-blue-700" : "text-red-600"}`}>{percent(budgetCompliance)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Desv. actual vs presupuesto</p><p className={`mt-1 text-xl font-black ${inventoryBudgetDiff >= 0 ? "text-blue-700" : "text-red-600"}`}>{money(inventoryBudgetDiff)}</p></div>
              <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">Desv. corte vs presupuesto</p><p className={`mt-1 text-xl font-black ${inventoryCutoffBudgetDiff >= 0 ? "text-blue-700" : "text-red-600"}`}>{money(inventoryCutoffBudgetDiff)}</p></div>
            </div>
            {salesUpdatedAt && <p className="text-xs font-semibold text-slate-400">{salesUpdatedAt}</p>}
            <div className="rounded-2xl border bg-white">
              <div className="border-b bg-slate-50 px-4 py-3">
                <h2 className="font-black">Presupuesto de inventario por tienda</h2>
                <Formula>Presupuesto = costo venta proyectado x 1.2. La primera parte compara el presupuesto con la fecha de corte; la segunda compara el inventario actual.</Formula>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-0 table-fixed text-[11px]">
                  <thead className="bg-slate-100 text-[10px] text-slate-600">
                    <tr>
                      <th onClick={() => toggleSort("store_name")} className="w-[15%] cursor-pointer select-none whitespace-normal break-words border p-1 text-left leading-tight hover:bg-slate-200">Tienda{sortIcon("store_name")}</th>
                      <th onClick={() => toggleSort("sales")} className="w-[9%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Venta acumulada{sortIcon("sales")}</th>
                      <th onClick={() => toggleSort("cost_accumulated")} className="w-[10%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Costo venta acumulada{sortIcon("cost_accumulated")}</th>
                      <th onClick={() => toggleSort("budget")} className="w-[10%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Presupuesto inventarios{sortIcon("budget")}</th>
                      <th onClick={() => toggleSort("inventory_value_cutoff")} className="w-[10%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Inv. Valorizado {shortDateLabel(reportDate)}{sortIcon("inventory_value_cutoff")}</th>
                      <th onClick={() => toggleSort("cutoff_compliance")} className="w-[7%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Cumplimiento %{sortIcon("cutoff_compliance")}</th>
                      <th onClick={() => toggleSort("cutoff_diff")} className="w-[10%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Desviación sobre ppto{sortIcon("cutoff_diff")}</th>
                      <th onClick={() => toggleSort("inventory_value")} className="w-[10%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Inv. Valorizado actual{sortIcon("inventory_value")}</th>
                      <th onClick={() => toggleSort("current_compliance")} className="w-[7%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Cumplimiento % actual{sortIcon("current_compliance")}</th>
                      <th onClick={() => toggleSort("diff")} className="w-[12%] cursor-pointer select-none whitespace-normal break-words border p-1 text-right leading-tight hover:bg-slate-200">Desviación sobre ppto actual{sortIcon("diff")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSalesRows.map(row => (
                      <tr key={row.store_id}>
                        <td className="break-words border p-1 font-black leading-tight">{row.store_name}</td>
                        <td className="whitespace-nowrap border p-1 text-right font-black">{money(row.sales_amount)}</td>
                        <td className="whitespace-nowrap border p-1 text-right font-black">{money(row.cost_amount)}</td>
                        <td className="whitespace-nowrap border p-1 text-right font-black">{money(row.inventory_budget)}</td>
                        <td className="whitespace-nowrap border p-1 text-right font-black">{money(row.inventory_value_cutoff)}</td>
                        <td className={`whitespace-nowrap border p-1 text-right font-black ${row.inventory_budget > 0 && row.inventory_value_cutoff / row.inventory_budget >= 1 ? "text-blue-700" : "text-red-600"}`}>{percent(row.inventory_budget > 0 ? (row.inventory_value_cutoff / row.inventory_budget) * 100 : 0)}</td>
                        <td className={`whitespace-nowrap border p-1 text-right font-black ${row.inventory_cutoff_vs_budget >= 0 ? "text-blue-700" : "text-red-600"}`}>{money(row.inventory_cutoff_vs_budget)}</td>
                        <td className="whitespace-nowrap border p-1 text-right font-black">{money(row.inventory_value)}</td>
                        <td className={`whitespace-nowrap border p-1 text-right font-black ${row.inventory_budget > 0 && row.inventory_value / row.inventory_budget >= 1 ? "text-blue-700" : "text-red-600"}`}>{percent(row.inventory_budget > 0 ? (row.inventory_value / row.inventory_budget) * 100 : 0)}</td>
                        <td className={`whitespace-nowrap border p-1 text-right font-black ${row.inventory_vs_budget >= 0 ? "text-blue-700" : "text-red-600"}`}>{money(row.inventory_vs_budget)}</td>
                      </tr>
                    ))}
                    {salesRows.length === 0 && <tr><td colSpan={10} className="p-8 text-center text-slate-400">Actualiza para calcular presupuesto.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      {budgetReportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onClick={() => setBudgetReportOpen(false)}>
          <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-black">Reporte para WhatsApp</h2>
                <p className="text-xs text-slate-500">Top 5 tiendas por desviación absoluta a la fecha de corte.</p>
              </div>
              <button onClick={() => setBudgetReportOpen(false)} className="rounded-xl border px-3 py-1 text-sm font-black text-slate-600">Cerrar</button>
            </div>
            <textarea value={budgetReportText} readOnly className="mt-4 h-72 w-full resize-none rounded-xl border bg-slate-50 p-3 text-sm leading-relaxed text-slate-800" />
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button onClick={() => void copyBudgetReport()} className="rounded-xl border px-4 py-2 text-sm font-black text-slate-700">Copiar mensaje</button>
              <button onClick={sendBudgetReportWhatsApp} className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-black text-white">Enviar por WhatsApp</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
