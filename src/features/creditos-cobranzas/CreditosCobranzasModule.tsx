"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Home, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

type VentaCredito = {
  id: string;
  receipt_id: string;
  store_code: string;
  store_name: string | null;
  doc_number: string | null;
  document_type: string | null;
  serie: string | null;
  numero_documento: string | null;
  sales_code: string | null;
  ruc: string | null;
  razon_social: string | null;
  fecha_emision: string | null;
  importe_total: number;
  credito_dias: number | null;
  condicion: string | null;
  asesora_nombre: string | null;
  asesora_dni: string | null;
  status_code: string | null;
  status_label: string | null;
  registro: string[] | null;
  legajo: string | null;
  observacion: string | null;
  fecha_recepcion: string | null;
  cumple_documentacion: boolean;
  nc_documento_referencia: string | null;
};

export type SubTab = "ventas" | "notas_credito";

type ColumnFilterKey =
  | "document_type"
  | "nc_documento_referencia"
  | "store_name"
  | "serie"
  | "numero_documento"
  | "ruc"
  | "razon_social"
  | "fecha_emision"
  | "condicion"
  | "asesora_nombre"
  | "asesora_dni"
  | "registro"
  | "legajo"
  | "status_label"
  | "observacion"
  | "fecha_recepcion";

const REGISTRO_OPTIONS = ["Plataforma", "Virtual", "Presencial"];
const PAGE_SIZE = 50;

// Columnas que necesitan un cast explicito para poder filtrarse con ilike
// (fechas y el arreglo "registro" no son texto nativo en la base).
const FILTER_EXPR: Record<ColumnFilterKey, string> = {
  document_type: "document_type",
  nc_documento_referencia: "nc_documento_referencia",
  store_name: "store_name",
  serie: "serie",
  numero_documento: "numero_documento",
  ruc: "ruc",
  razon_social: "razon_social",
  fecha_emision: "fecha_emision::text",
  condicion: "condicion",
  asesora_nombre: "asesora_nombre",
  asesora_dni: "asesora_dni",
  registro: "registro::text",
  legajo: "legajo",
  status_label: "status_label",
  observacion: "observacion",
  fecha_recepcion: "fecha_recepcion::text",
};

function applyBaseFilters(query: any, opts: { dateFrom: string; dateTo: string; storeFilter: string; statusFilter: string; subTab: SubTab }) {
  let q = query.gte("fecha_emision", opts.dateFrom).lte("fecha_emision", opts.dateTo);
  if (opts.storeFilter) q = q.eq("store_code", opts.storeFilter);
  if (opts.statusFilter !== "all") q = q.eq("status_code", opts.statusFilter);
  q = opts.subTab === "notas_credito" ? q.eq("sales_code", "R") : q.neq("sales_code", "R");
  return q;
}

function applyColumnFilters(query: any, filters: Partial<Record<ColumnFilterKey, string>>) {
  let q = query;
  for (const [key, value] of Object.entries(filters) as [ColumnFilterKey, string][]) {
    if (!value?.trim()) continue;
    q = q.filter(FILTER_EXPR[key], "ilike", `%${value.trim()}%`);
  }
  return q;
}

// Trae TODAS las filas que matchean paginando de a 1000 (el default de
// PostgREST corta en 1000 y ya nos mordio una vez). Se usa solo para
// consultas livianas (pocas columnas), nunca para llenar la tabla visible.
async function fetchAllPages<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const chunk = (data || []) as T[];
    all.push(...chunk);
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(n);
}

function monthStartISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatSync(iso: string | null) {
  if (!iso) return "Sin sincronizacion registrada";
  return new Date(iso).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "medium" });
}

function ColumnFilterCell({
  filterKey,
  columnFilters,
  setColumnFilter,
}: {
  filterKey: ColumnFilterKey;
  columnFilters: Partial<Record<ColumnFilterKey, string>>;
  setColumnFilter: (key: ColumnFilterKey, value: string) => void;
}) {
  return (
    <th className="p-1">
      <input
        value={columnFilters[filterKey] || ""}
        onChange={e => setColumnFilter(filterKey, e.target.value)}
        placeholder="Buscar..."
        className="w-full rounded-md border border-slate-200 px-1.5 py-1 text-[10px] font-semibold text-slate-700 placeholder:text-slate-300"
      />
    </th>
  );
}

function RegistroCell({
  row,
  disabled,
  onToggle,
}: {
  row: VentaCredito;
  disabled: boolean;
  onToggle: (opt: string, checked: boolean) => void;
}) {
  const selected = row.registro || [];
  return (
    <div className="flex flex-col gap-0.5">
      {REGISTRO_OPTIONS.map(opt => (
        <label key={opt} className="flex items-center gap-1 text-[10px] font-bold text-slate-600">
          <input
            type="checkbox"
            checked={selected.includes(opt)}
            disabled={disabled}
            onChange={e => onToggle(opt, e.target.checked)}
          />
          {opt}
        </label>
      ))}
    </div>
  );
}

export default function CreditosCobranzasModule({ subTab }: { subTab: SubTab }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [rows, setRows] = useState<VentaCredito[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [legajoMap, setLegajoMap] = useState<Map<string, string>>(new Map());

  // Filtros compartidos entre las dos pestañas: viven en la URL (?store=&status=&desde=&hasta=)
  // para que se conserven al navegar entre /creditos-cobranzas y /notas-credito.
  const storeFilter = searchParams.get("store") || "";
  const statusFilter = (searchParams.get("status") as "all" | "A" | "C") || "all";
  const dateFrom = searchParams.get("desde") || monthStartISO();
  const dateTo = searchParams.get("hasta") || todayISO();

  const [savingId, setSavingId] = useState<string | null>(null);
  const [columnFilters, setColumnFilters] = useState<Partial<Record<ColumnFilterKey, string>>>({});
  const [debouncedColumnFilters, setDebouncedColumnFilters] = useState<Partial<Record<ColumnFilterKey, string>>>({});

  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [aggregates, setAggregates] = useState({ importeTotal: 0, cumplen: 0 });
  const [tabCounts, setTabCounts] = useState({ ventas: 0, notas: 0 });

  function setColumnFilter(key: ColumnFilterKey, value: string) {
    setColumnFilters(prev => ({ ...prev, [key]: value }));
  }

  function updateQuery(patch: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function tabHref(tab: SubTab) {
    const base = tab === "ventas" ? "/creditos-cobranzas" : "/creditos-cobranzas/notas-credito";
    const qs = searchParams.toString();
    return qs ? `${base}?${qs}` : base;
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cyclic_user");
      if (raw) setUser(JSON.parse(raw) as CyclicUser);
    } catch { setUser(null); }
  }, []);

  useEffect(() => {
    supabase.from("stores").select("id,code,name,is_active,erp_sede,erp_store_no").order("name")
      .then(({ data }) => setStores((data || []) as Store[]));
  }, []);

  useEffect(() => {
    fetchAllPages<{ ruc: string; legajo_abreviatura: string | null }>((from, to) =>
      supabase.from("credito_clientes_legajo").select("ruc,legajo_abreviatura").range(from, to)
    ).then(data => {
      const m = new Map<string, string>();
      for (const r of data) if (r.legajo_abreviatura) m.set(r.ruc, r.legajo_abreviatura);
      setLegajoMap(m);
    }).catch(() => setLegajoMap(new Map()));
  }, []);

  // Debounce de los filtros de columna: evita disparar un query por cada
  // tecla escrita. Al asentarse, resetea la pagina a 0.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedColumnFilters(columnFilters);
      setPage(0);
    }, 400);
    return () => clearTimeout(t);
  }, [columnFilters]);

  const canAccess = Boolean(user && canAccessModule(user, "credit_sales"));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const base = { dateFrom, dateTo, storeFilter, statusFilter, subTab };

      let mainQuery = supabase.from("ventas_credito").select("*", { count: "exact" }).order("fecha_emision", { ascending: false });
      mainQuery = applyBaseFilters(mainQuery, base);
      mainQuery = applyColumnFilters(mainQuery, debouncedColumnFilters);
      mainQuery = mainQuery.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      // Totales exactos calculados en la base (RPC get_ventas_credito_totales):
      // 1 request que devuelve 1 fila con SUM/COUNT, en vez de traer todas las
      // filas filtradas (miles, paginadas de a 1000) para sumar/contar en JS.
      // La funcion SQL replica los mismos filtros de applyBaseFilters/
      // applyColumnFilters; los filtros de columna van trimmeados en un jsonb.
      const filterPayload: Record<string, string> = {};
      for (const [key, value] of Object.entries(debouncedColumnFilters)) {
        if (value?.trim()) filterPayload[key] = value.trim();
      }
      const aggQuery = supabase.rpc("get_ventas_credito_totales", {
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_store: storeFilter || null,
        p_status: statusFilter === "all" ? null : statusFilter,
        p_sub_tab: subTab,
        p_filters: filterPayload,
      });

      const syncQuery = supabase.from("erp_sync_status").select("synced_at").eq("id", "ventas_credito").maybeSingle();

      const [{ data, error, count }, aggRes, syncRes] = await Promise.all([mainQuery, aggQuery, syncQuery]);
      if (error) throw error;
      if (aggRes.error) throw aggRes.error;
      const agg = (aggRes.data as { importe_total: number | string; cumplen: number | string }[] | null)?.[0];
      const importeTotal = Number(agg?.importe_total ?? 0);
      const cumplen = Number(agg?.cumplen ?? 0);

      setRows((data || []) as VentaCredito[]);
      setTotalCount(count ?? 0);
      setAggregates({ importeTotal, cumplen });
      setLastSync(syncRes.data?.synced_at || null);
      setLoaded(true);
    } catch (err: any) {
      toast.error(`Error al cargar: ${err?.message || "desconocido"}`);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, storeFilter, statusFilter, subTab, debouncedColumnFilters, page]);

  const loadTabCounts = useCallback(async () => {
    try {
      const base = { dateFrom, dateTo, storeFilter, statusFilter };
      const [ventasRes, notasRes] = await Promise.all([
        applyBaseFilters(supabase.from("ventas_credito").select("id", { count: "exact", head: true }), { ...base, subTab: "ventas" as SubTab }),
        applyBaseFilters(supabase.from("ventas_credito").select("id", { count: "exact", head: true }), { ...base, subTab: "notas_credito" as SubTab }),
      ]);
      setTabCounts({ ventas: ventasRes.count || 0, notas: notasRes.count || 0 });
    } catch {
      // Solo afecta el contador de las pestañas, no es critico.
    }
  }, [dateFrom, dateTo, storeFilter, statusFilter]);

  useEffect(() => {
    if (canAccess) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccess, dateFrom, dateTo, storeFilter, statusFilter, subTab, debouncedColumnFilters, page]);

  useEffect(() => {
    if (canAccess) void loadTabCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAccess, dateFrom, dateTo, storeFilter, statusFilter]);

  async function saveField(row: VentaCredito, patch: Partial<VentaCredito>) {
    setSavingId(row.id);
    try {
      const { error } = await supabase
        .from("ventas_credito")
        .update({ ...patch, updated_by: user?.id || null, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) throw error;
      setRows(prev => prev.map(item => item.id === row.id ? { ...item, ...patch } : item));
    } catch (err: any) {
      toast.error("Error al guardar: " + (err?.message || "desconocido"));
    } finally {
      setSavingId(null);
    }
  }

  const totals = useMemo(() => ({
    count: totalCount,
    importeTotal: aggregates.importeTotal,
    cumplen: aggregates.cumplen,
    pendientes: totalCount - aggregates.cumplen,
  }), [totalCount, aggregates]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Cargando sesión...</p>
      </div>
    );
  }

  if (!canAccess) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center space-y-2">
          <p className="font-bold text-slate-800">Sin acceso a este módulo</p>
          <Link href="/" className="text-sm text-blue-600 underline">Volver al inicio</Link>
        </div>
      </div>
    );
  }

  const syncStale = !lastSync || Date.now() - new Date(lastSync).getTime() > 15 * 60 * 1000;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <Link href="/" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200">
          <Home size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-black leading-tight text-slate-900">Créditos y Cobranzas</h1>
          <p className="text-xs text-slate-500">Control de documentación de ventas a crédito · {user.full_name}</p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> {loading ? "Cargando..." : "Actualizar"}
        </button>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 p-4">
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-slate-100 bg-white p-1 shadow-md sm:inline-flex sm:w-auto">
          <a
            href={tabHref("ventas")}
            className={`rounded-xl px-4 py-2 text-center text-sm font-black ${subTab === "ventas" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}
          >
            Ventas a Crédito {tabCounts.ventas > 0 ? `(${tabCounts.ventas})` : ""}
          </a>
          <a
            href={tabHref("notas_credito")}
            className={`rounded-xl px-4 py-2 text-center text-sm font-black ${subTab === "notas_credito" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}
          >
            Notas de Crédito {tabCounts.notas > 0 ? `(${tabCounts.notas})` : ""}
          </a>
        </div>

        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-md">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[180px] flex-1">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Tienda</label>
              <select value={storeFilter} onChange={e => { updateQuery({ store: e.target.value || null }); setPage(0); }} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900">
                <option value="">Todas las tiendas</option>
                {stores.filter(s => s.is_active && s.erp_store_no).map(s => (
                  <option key={s.id} value={s.erp_store_no!}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[150px]">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Estado</label>
              <select value={statusFilter} onChange={e => { updateQuery({ status: e.target.value === "all" ? null : e.target.value }); setPage(0); }} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900">
                <option value="all">Todos</option>
                <option value="A">Activo</option>
                <option value="C">Anulado</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Desde</label>
              <input type="date" value={dateFrom} onChange={e => { updateQuery({ desde: e.target.value }); setPage(0); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900" />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Hasta</label>
              <input type="date" value={dateTo} onChange={e => { updateQuery({ hasta: e.target.value }); setPage(0); }} className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900" />
            </div>
          </div>
        </div>

        <div className={`rounded-2xl border px-4 py-3 shadow-sm ${syncStale ? "border-red-300 bg-red-50" : "bg-white"}`}>
          <p className={`text-xs font-black uppercase ${syncStale ? "text-red-600" : "text-slate-500"}`}>
            {syncStale ? "⚠ Sincronización ERP Créditos y Cobranzas detenida" : "Última sincronización ERP Créditos y Cobranzas"}
          </p>
          <p className={`text-sm font-black ${syncStale ? "text-red-700" : "text-slate-900"}`}>{formatSync(lastSync)}</p>
        </div>

        {loaded && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-md">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">Documentos</div>
              <div className="text-2xl font-black text-slate-900">{totals.count}</div>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-md">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">Importe total</div>
              <div className="text-lg font-black text-slate-900">{fmtMoney(totals.importeTotal)}</div>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-md">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">Cumplen doc.</div>
              <div className="text-2xl font-black text-emerald-700">{totals.cumplen}</div>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-md">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">Pendientes</div>
              <div className="text-2xl font-black text-amber-600">{totals.pendientes}</div>
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-2xl border border-slate-100 bg-white shadow-md">
          <table className="w-full min-w-[1800px] text-left text-[11px]">
            <thead>
              <tr className="border-b bg-slate-50 text-[10px] font-black uppercase text-slate-500">
                <th className="p-2">Documento</th>
                {subTab === "notas_credito" && <th className="p-2">Documento de Referencia</th>}
                <th className="p-2">Tienda</th>
                <th className="p-2">Serie</th>
                <th className="p-2">N° Factura</th>
                <th className="p-2">RUC</th>
                <th className="p-2">Razón Social</th>
                <th className="p-2">Fecha Emisión</th>
                <th className="p-2 text-right">Importe Total</th>
                <th className="p-2">Condición</th>
                <th className="p-2">Asesora</th>
                <th className="p-2">DNI</th>
                <th className="p-2">Registro</th>
                <th className="p-2">Legajo</th>
                <th className="p-2">Estado</th>
                <th className="p-2">Observación</th>
                <th className="p-2">Fecha de Recepción</th>
                <th className="p-2 text-center">Cumple Doc.</th>
              </tr>
              <tr className="border-b bg-white">
                <ColumnFilterCell filterKey="document_type" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                {subTab === "notas_credito" && (
                  <ColumnFilterCell filterKey="nc_documento_referencia" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                )}
                <ColumnFilterCell filterKey="store_name" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="serie" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="numero_documento" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="ruc" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="razon_social" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="fecha_emision" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <th className="p-1"></th>
                <ColumnFilterCell filterKey="condicion" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="asesora_nombre" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="asesora_dni" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="registro" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="legajo" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="status_label" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="observacion" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <ColumnFilterCell filterKey="fecha_recepcion" columnFilters={columnFilters} setColumnFilter={setColumnFilter} />
                <th className="p-1"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const legajoFallback = row.ruc ? legajoMap.get(row.ruc) || null : null;
                return (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-slate-50/80">
                    <td className="p-2 font-black text-slate-900">{row.document_type || "-"}</td>
                    {subTab === "notas_credito" && (
                      <td className="p-2 font-bold text-blue-700">{row.nc_documento_referencia || "-"}</td>
                    )}
                    <td className="p-2 max-w-[160px] truncate text-slate-700" title={row.store_name || ""}>{row.store_name || "-"}</td>
                    <td className="p-2 font-bold text-slate-700">{row.serie || "-"}</td>
                    <td className="p-2 font-bold text-slate-700">{row.numero_documento || "-"}</td>
                    <td className="p-2 font-bold text-slate-700">{row.ruc || "-"}</td>
                    <td className="p-2 max-w-[220px] truncate text-slate-700" title={row.razon_social || ""}>{row.razon_social || "-"}</td>
                    <td className="p-2 text-slate-700">{row.fecha_emision || "-"}</td>
                    <td className={`p-2 text-right font-black tabular-nums ${Number(row.importe_total) < 0 ? "text-red-600" : "text-slate-900"}`}>
                      {fmtMoney(Number(row.importe_total || 0))}
                    </td>
                    <td className="p-2 text-slate-700">{row.condicion || "-"}</td>
                    <td className="p-2 max-w-[180px] truncate text-slate-700" title={row.asesora_nombre || ""}>{row.asesora_nombre || "-"}</td>
                    <td className="p-2 text-slate-700">{row.asesora_dni || "-"}</td>
                    <td className="p-2">
                      <RegistroCell
                        row={row}
                        disabled={savingId === row.id}
                        onToggle={(opt, checked) => {
                          const current = row.registro || [];
                          const next = checked ? Array.from(new Set([...current, opt])) : current.filter(o => o !== opt);
                          void saveField(row, { registro: next.length ? next : null });
                        }}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        defaultValue={row.legajo || legajoFallback || ""}
                        onBlur={e => { if (e.target.value !== (row.legajo || "")) void saveField(row, { legajo: e.target.value.trim() || null }); }}
                        disabled={savingId === row.id}
                        title={!row.legajo && legajoFallback ? "Sugerido desde el legajo de clientes" : undefined}
                        className={`w-24 rounded-lg border px-2 py-1 text-[11px] font-bold ${!row.legajo && legajoFallback ? "italic text-slate-400" : ""}`}
                      />
                    </td>
                    <td className="p-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${row.status_code === "A" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                        {row.status_label || row.status_code || "-"}
                      </span>
                    </td>
                    <td className="p-2">
                      <input
                        defaultValue={row.observacion || ""}
                        onBlur={e => { if (e.target.value !== (row.observacion || "")) void saveField(row, { observacion: e.target.value.trim() || null }); }}
                        disabled={savingId === row.id}
                        className="w-32 rounded-lg border px-2 py-1 text-[11px] font-semibold"
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="date"
                        defaultValue={row.fecha_recepcion || ""}
                        onBlur={e => { if (e.target.value !== (row.fecha_recepcion || "")) void saveField(row, { fecha_recepcion: e.target.value || null }); }}
                        disabled={savingId === row.id}
                        className="rounded-lg border px-2 py-1 text-[11px] font-bold"
                      />
                    </td>
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        checked={row.cumple_documentacion}
                        onChange={e => void saveField(row, { cumple_documentacion: e.target.checked })}
                        disabled={savingId === row.id}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loaded && rows.length === 0 && (
            <p className="p-8 text-center text-sm font-bold text-slate-400">
              {subTab === "notas_credito" ? "Sin notas de crédito para estos filtros." : "Sin ventas a crédito para estos filtros."}
            </p>
          )}
          {loaded && totalCount > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
              <p className="text-[11px] font-bold text-slate-500">
                Mostrando {Math.min(page * PAGE_SIZE + 1, totalCount)}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} de {totalCount}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                  className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  <ChevronLeft size={14} /> Anterior
                </button>
                <span className="text-[11px] font-bold text-slate-500">Página {page + 1} de {totalPages}</span>
                <button
                  type="button"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page + 1 >= totalPages || loading}
                  className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-black text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  Siguiente <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
