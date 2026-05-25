"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { Download, Home, RefreshCw, Search, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { useIsMobileAccess } from "@/lib/mobileAccess";
import { readSafeSheetObjects } from "@/lib/safeExcel";
import { fullProductCode } from "@/features/ciclicos/utils";

type Role = "Operario" | "Validador" | "Administrador";

type CyclicUser = {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  is_active: boolean;
};

type RotationRow = {
  id: number;
  store_code: string;
  store_name: string | null;
  store_profile: "old" | "young" | "cd" | string;
  product_code: string;
  description: string | null;
  first_movement_date: string | null;
  first_sale_date: string | null;
  last_sale_date: string | null;
  sales_qty_total: number;
  sales_months: number;
  avg_sales_month: number;
  rotation_category: "A" | "B" | "C" | "D" | "Nuevo" | "X" | "H" | string;
  calculated_at: string;
};

type SummaryRow = {
  store_code: string;
  store_name: string | null;
  store_profile: string;
  total_codes: number;
  category_a: number;
  category_b: number;
  category_c: number;
  category_d: number;
  category_nuevo: number;
  category_x: number;
  category_h: number;
  calculated_at: string;
};

type StoreRow = {
  id: string;
  code: string | null;
  name: string | null;
  erp_sede: string | null;
  erp_store_no?: string | null;
  is_active: boolean;
};

type MonthlyRotationUpload = {
  period_month: string;
  store_key: string;
  store_name: string;
  product_code: string;
  description: string | null;
  unit: string | null;
  rotation_category: string;
  source_name: string | null;
  updated_at: string;
};

const PAGE_SIZE = 200;
const CATEGORY_OPTIONS = ["Todas", "A", "B", "C", "D", "Nuevo", "X", "H"] as const;

type FilterableQuery<T> = {
  eq(column: string, value: unknown): T;
  or(filters: string): T;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return String(error);
}

function categoryClass(category: string) {
  if (category === "A") return "bg-emerald-100 text-emerald-700";
  if (category === "B") return "bg-blue-100 text-blue-700";
  if (category === "C") return "bg-amber-100 text-amber-700";
  if (category === "D") return "bg-slate-100 text-slate-700";
  if (category === "Nuevo") return "bg-purple-100 text-purple-700";
  if (category === "X") return "bg-orange-100 text-orange-700";
  if (category === "H") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function profileLabel(profile: string) {
  if (profile === "young") return "Tienda -6 meses";
  if (profile === "cd") return "CD-GPC";
  return "Tienda +6 meses";
}

function numberFmt(value: number | null | undefined, digits = 2) {
  return Number(value || 0).toLocaleString("es-PE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function normalizeHeader(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function pickUploadCell(row: Record<string, unknown>, aliases: string[]) {
  const wanted = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(key))) return String(value ?? "").trim();
  }
  return "";
}

function normalizeRotationCategory(value: string) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  const upper = clean.toUpperCase();
  if (upper === "NUEVO") return "Nuevo";
  return upper;
}

export default function RotacionesPage() {
  const isMobileAccess = useIsMobileAccess();
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [rows, setRows] = useState<RotationRow[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [uploadingMonthly, setUploadingMonthly] = useState(false);
  const [rotationPeriod, setRotationPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [rotationFile, setRotationFile] = useState<File | null>(null);
  const [rotationFileName, setRotationFileName] = useState("");
  const [message, setMessage] = useState("");
  const rotationInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isMobileAccess) window.location.replace("/dashboard");
  }, [isMobileAccess]);
  const [search, setSearch] = useState("");
  const [storeFilter, setStoreFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<(typeof CATEGORY_OPTIONS)[number]>("Todas");
  const [page, setPage] = useState(0);
  const [totalRows, setTotalRows] = useState(0);

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) {
      window.location.replace("/");
      return;
    }

    const parsed = JSON.parse(raw) as CyclicUser;
    if (parsed.role !== "Administrador") {
      window.location.replace("/dashboard");
      return;
    }

    const timer = window.setTimeout(() => {
      setUser(parsed);
      setAuthChecked(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!authChecked || !user) return;
    loadStores();
    loadSummary();
  }, [authChecked, user]);

  useEffect(() => {
    if (!authChecked || !user) return;
    loadRows(0);
  }, [authChecked, user, storeFilter, categoryFilter]);

  const totalSummary = useMemo(() => {
    const scopedSummary = storeFilter
      ? summary.filter(row => row.store_code === storeFilter)
      : summary;

    return scopedSummary.reduce((acc, row) => ({
      total: acc.total + Number(row.total_codes || 0),
      a: acc.a + Number(row.category_a || 0),
      b: acc.b + Number(row.category_b || 0),
      c: acc.c + Number(row.category_c || 0),
      d: acc.d + Number(row.category_d || 0),
      nuevo: acc.nuevo + Number(row.category_nuevo || 0),
      x: acc.x + Number(row.category_x || 0),
      h: acc.h + Number(row.category_h || 0)
    }), { total: 0, a: 0, b: 0, c: 0, d: 0, nuevo: 0, x: 0, h: 0 });
  }, [storeFilter, summary]);

  const storeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    const addKey = (key: unknown, label: string) => {
      const value = String(key || "").trim();
      if (!value) return;
      map.set(value, label);

      const prefix = value.match(/^(\d+)\s+/)?.[1];
      if (prefix) map.set(prefix, label);

      const numeric = Number(value);
      if (/^\d+$/.test(value) && Number.isFinite(numeric) && numeric > 0 && numeric < 1000) {
        map.set(String(1000 + numeric), label);
      }
    };

    for (const store of stores) {
      const label = store.name || store.erp_sede || store.code || store.id;
      const keys = [
        store.id,
        store.code,
        store.erp_store_no,
        store.erp_sede,
        store.name
      ];
      for (const key of keys) {
        addKey(key, label);
      }
    }

    for (const store of stores) {
      const label = store.name || store.erp_sede || store.code || store.id;
      const gpcMatch = label.match(/^GPC0*(\d+)/i);
      if (gpcMatch) map.set(String(1000 + Number(gpcMatch[1])), label);
    }

    return map;
  }, [stores]);

  function displayStoreName(storeCode: string | null | undefined, fallback?: string | null) {
    const code = String(storeCode || "").trim();
    if (code === "1000") {
      const cdName = storeNameMap.get("CD-GPC") || storeNameMap.get("100") || storeNameMap.get("1000");
      if (cdName) return cdName;
    }

    const byCode = code ? storeNameMap.get(code) : "";
    if (byCode) return byCode;

    const numeric = Number(code);
    if (/^10\d{2}$/.test(code) && Number.isFinite(numeric)) {
      const byLegacyStoreNo = storeNameMap.get(String(numeric - 1000));
      if (byLegacyStoreNo) return byLegacyStoreNo;
    }

    const cleanFallback = String(fallback || "").trim();
    if (cleanFallback && cleanFallback !== code) return cleanFallback;
    return code || "Sin tienda";
  }

  async function loadStores() {
    const { data, error } = await supabase
      .from("stores")
      .select("id,code,name,erp_sede,erp_store_no,is_active")
      .order("name", { ascending: true });

    if (!error) setStores((data || []) as StoreRow[]);
  }

  async function loadSummary() {
    const { data, error } = await supabase
      .from("product_rotation_summary")
      .select("*")
      .order("store_name", { ascending: true });

    if (error) {
      setMessage("No se pudo cargar el resumen: " + error.message);
      return;
    }

    setSummary((data || []) as SummaryRow[]);
  }

  function applyFilters<T extends FilterableQuery<T>>(query: T) {
    let q = query;
    if (storeFilter) q = q.eq("store_code", storeFilter);
    if (categoryFilter !== "Todas") q = q.eq("rotation_category", categoryFilter);
    const clean = search.trim();
    if (clean) {
      q = q.or(`product_code.ilike.%${clean}%,description.ilike.%${clean}%,store_name.ilike.%${clean}%`);
    }
    return q;
  }

  async function loadRows(nextPage = page) {
    setLoading(true);
    setMessage("");
    try {
      const from = nextPage * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const query = applyFilters(
        supabase
          .from("product_rotation_store")
          .select("*", { count: "exact" })
          .order("store_name", { ascending: true })
          .order("product_code", { ascending: true })
          .range(from, to)
      );

      const { data, error, count } = await query;
      if (error) throw error;
      setRows((data || []) as RotationRow[]);
      setTotalRows(count || 0);
      setPage(nextPage);
    } catch (error: unknown) {
      setMessage("No se pudo cargar rotaciones: " + errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function exportExcel() {
    setExporting(true);
    setMessage("");
    try {
      const query = applyFilters(
        supabase
          .from("product_rotation_store")
          .select("*")
          .order("store_name", { ascending: true })
          .order("product_code", { ascending: true })
          .limit(5000)
      );
      const { data, error } = await query;
      if (error) throw error;

      const exportRows = ((data || []) as RotationRow[]).map(row => ({
        Tienda: displayStoreName(row.store_code, row.store_name),
        "Tipo tienda": profileLabel(row.store_profile),
        Codigo: row.product_code,
        Descripcion: row.description || "",
        Categoria: row.rotation_category,
        "Docs venta ult. año": Number(row.sales_qty_total || 0),
        "Meses base": Number(row.sales_months || 0),
        "Docs venta/mes": Number(row.avg_sales_month || 0),
        "Primera venta": row.first_sale_date || "",
        "Ultima venta": row.last_sale_date || "",
        "Calculado": row.calculated_at
      }));

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows), "Rotaciones");
      XLSX.writeFile(workbook, `rotaciones_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (error: unknown) {
      setMessage("No se pudo exportar: " + errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  async function uploadMonthlyRotationExcel() {
    if (!rotationFile) {
      setMessage("Selecciona el Excel de rotaciones.");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(rotationPeriod)) {
      setMessage("Selecciona el mes del historico.");
      return;
    }

    setUploadingMonthly(true);
    setMessage("");
    try {
      const rows = await readSafeSheetObjects<Record<string, unknown>>(rotationFile, {
        maxRows: 100000,
        maxCols: 60,
        raw: false,
      });
      const periodMonth = `${rotationPeriod}-01`;
      const now = new Date().toISOString();
      const normalized = new Map<string, MonthlyRotationUpload>();

      for (const row of rows) {
        const storeKey = pickUploadCell(row, ["tienda", "store", "store_key", "codigo tienda", "sede", "local"]);
        const storeName = pickUploadCell(row, ["nombre tienda", "store_name", "tienda nombre", "name"]) || displayStoreName(storeKey, storeKey);
        const productCode = fullProductCode(pickUploadCell(row, ["codigo", "código", "codsap", "sku", "producto", "product_code"]));
        const rotationCategory = normalizeRotationCategory(pickUploadCell(row, ["rotacion", "rotación", "categoria", "categoría", "rotation", "rotation_category"]));
        if (!storeKey || !productCode || !rotationCategory) continue;

        const key = `${periodMonth}|${storeKey}|${productCode}`;
        normalized.set(key, {
          period_month: periodMonth,
          store_key: storeKey,
          store_name: storeName || storeKey,
          product_code: productCode,
          description: pickUploadCell(row, ["descripcion", "descripción", "description", "detalle"]) || null,
          unit: pickUploadCell(row, ["um", "unidad", "unit"]) || null,
          rotation_category: rotationCategory,
          source_name: rotationFile.name,
          updated_at: now,
        });
      }

      const payload = [...normalized.values()];
      if (payload.length === 0) {
        throw new Error("No se encontraron filas validas. Revisa columnas de tienda, codigo y rotacion.");
      }

      for (let i = 0; i < payload.length; i += 500) {
        const { error } = await supabase
          .from("product_rotation_monthly")
          .upsert(payload.slice(i, i + 500), { onConflict: "period_month,store_key,product_code" });
        if (error) throw error;
      }

      setRotationFile(null);
      setRotationFileName("");
      if (rotationInputRef.current) rotationInputRef.current.value = "";
      setMessage(`${payload.length.toLocaleString("es-PE")} rotaciones guardadas para ${rotationPeriod}.`);
      await loadSummary();
      await loadRows(0);
    } catch (error: unknown) {
      setMessage("No se pudo cargar historico mensual: " + errorMessage(error));
    } finally {
      setUploadingMonthly(false);
    }
  }

  if (!authChecked || !user) {
    return <main className="min-h-screen bg-slate-100 p-6 text-slate-700">Validando acceso...</main>;
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.location.href = "/"}
              className="rounded-xl border px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              title="Menu principal"
            >
              <Home size={16} />
            </button>
            <div>
              <h1 className="text-lg font-bold">Rotaciones por codigo - tienda</h1>
              <p className="text-xs text-slate-500">Vista administrativa desde ventas diarias pre-calculadas.</p>
            </div>
          </div>
          <button
            onClick={() => { loadSummary(); loadRows(0); }}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            <RefreshCw size={16} />
            Actualizar
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-4 p-4">
        {message && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">{message}</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Total codigos", totalSummary.total, "bg-slate-900 text-white"],
            ["Rotacion A", totalSummary.a, "bg-emerald-600 text-white"],
            ["Rotacion B", totalSummary.b, "bg-blue-600 text-white"],
            ["Rotacion C", totalSummary.c, "bg-amber-500 text-white"],
            ["Rotacion D", totalSummary.d, "bg-slate-600 text-white"],
            ["Nuevo", totalSummary.nuevo, "bg-purple-600 text-white"],
            ["X sin venta 3m+", totalSummary.x, "bg-orange-500 text-white"],
            ["H sin venta 1a+", totalSummary.h, "bg-red-600 text-white"]
          ].map(([label, value, cls]) => (
            <div key={String(label)} className={`rounded-2xl p-4 shadow ${cls}`}>
              <p className="text-xs font-semibold opacity-80">{label}</p>
              <p className="mt-1 text-2xl font-black">{Number(value).toLocaleString("es-PE")}</p>
            </div>
          ))}
        </section>

        <section className="rounded-2xl bg-white p-4 shadow">
          <div className="grid gap-3 md:grid-cols-[1fr_220px_160px_auto_auto] md:items-end">
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-500">Buscar</span>
              <div className="flex items-center gap-2 rounded-xl border px-3 py-2">
                <Search size={16} className="text-slate-400" />
                <input
                  className="w-full bg-transparent text-sm outline-none"
                  placeholder="Codigo, descripcion o tienda"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") loadRows(0); }}
                />
              </div>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-500">Tienda</span>
              <select className="w-full rounded-xl border px-3 py-2 text-sm" value={storeFilter} onChange={event => setStoreFilter(event.target.value)}>
                <option value="">Todas</option>
                {summary.map(row => <option key={row.store_code} value={row.store_code}>{displayStoreName(row.store_code, row.store_name)}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-500">Categoria</span>
              <select className="w-full rounded-xl border px-3 py-2 text-sm" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value as (typeof CATEGORY_OPTIONS)[number])}>
                {CATEGORY_OPTIONS.map(category => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <button
              onClick={() => loadRows(0)}
              disabled={loading}
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              Consultar
            </button>
            <button
              onClick={exportExcel}
              disabled={exporting}
              className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold text-slate-700 disabled:opacity-50"
            >
              <Download size={16} />
              Excel
            </button>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-4 shadow">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-black">Historico mensual de rotaciones</h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                Carga el Excel del mes para conservar historial por mes, tienda y codigo.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="text-xs font-bold text-slate-500">Mes</span>
                <input
                  type="month"
                  className="w-40 rounded-xl border px-3 py-2 text-sm font-semibold"
                  value={rotationPeriod}
                  onChange={event => setRotationPeriod(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold text-slate-700"
                onClick={() => rotationInputRef.current?.click()}
              >
                <Upload size={16} />
                {rotationFileName || "Seleccionar Excel"}
              </button>
              <input
                ref={rotationInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0] || null;
                  setRotationFile(file);
                  setRotationFileName(file?.name || "");
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={uploadMonthlyRotationExcel}
                disabled={uploadingMonthly || !rotationFile}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                {uploadingMonthly ? "Cargando..." : "Subir rotaciones"}
              </button>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl bg-white shadow">
          <div className="border-b px-4 py-3">
            <p className="text-sm font-bold">Resultados: {totalRows.toLocaleString("es-PE")}</p>
          </div>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Tienda</th>
                  <th className="px-3 py-2 text-left">Tipo</th>
                  <th className="px-3 py-2 text-left">Codigo</th>
                  <th className="px-3 py-2 text-left">Descripcion</th>
                  <th className="px-3 py-2 text-center">Rot.</th>
                  <th className="px-3 py-2 text-right">Docs año</th>
                  <th className="px-3 py-2 text-right">Docs/mes</th>
                  <th className="px-3 py-2 text-center">Ult. venta</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center font-semibold text-slate-500">Cargando...</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center font-semibold text-slate-500">Sin resultados.</td></tr>
                ) : rows.map(row => (
                  <tr key={row.id} className="border-t">
                    <td className="px-3 py-2 font-bold">{displayStoreName(row.store_code, row.store_name)}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{profileLabel(row.store_profile)}</td>
                    <td className="px-3 py-2 font-mono font-bold">{row.product_code}</td>
                    <td className="max-w-[340px] px-3 py-2 text-slate-700">{row.description || ""}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded-full px-2 py-1 text-xs font-black ${categoryClass(row.rotation_category)}`}>{row.rotation_category}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{numberFmt(row.sales_qty_total)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{numberFmt(row.avg_sales_month)}</td>
                    <td className="px-3 py-2 text-center text-xs">{row.last_sale_date || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <button className="rounded-xl border px-3 py-2 font-semibold disabled:opacity-40" disabled={page === 0 || loading} onClick={() => loadRows(page - 1)}>Anterior</button>
            <span className="font-semibold text-slate-500">Pagina {page + 1} de {Math.max(1, Math.ceil(totalRows / PAGE_SIZE))}</span>
            <button className="rounded-xl border px-3 py-2 font-semibold disabled:opacity-40" disabled={(page + 1) * PAGE_SIZE >= totalRows || loading} onClick={() => loadRows(page + 1)}>Siguiente</button>
          </div>
        </section>
      </div>
    </main>
  );
}
