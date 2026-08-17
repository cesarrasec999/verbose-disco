"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import type { CyclicUser, Store } from "@/features/ciclicos/types";
import * as XLSX from "xlsx";
import { Download, Home, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type AggRow = {
  store_code: string;
  store_name: string;
  product_code: string;
  description: string;
  unit: string;
  qty_ajuste: number;
  qty_regulariz: number;
  total_qty: number;
  total_value: number;
  record_count: number;
  last_date: string;
  last_user: string | null;
  total_rows?: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("es-PE", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(n);
}

function formatSync(iso: string) {
  return new Date(iso).toLocaleString("es-PE", {
    hour12: false, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// erp_movements.store_code (lo que usa get_ajustes_provisionales) es
// "1000 + numero real de tienda del ERP". Para casi todas las tiendas ese
// numero coincide con el de la etiqueta "GPCxxx", excepto 4 que estan
// cruzadas (confirmado contra el maestro de tiendas del ERP, no contra
// erp_store_no: ese campo lo repuebla un sync externo y ya se vio que puede
// volver a quedar mal sin avisar, asi que no se usa aqui).
const GPC_STORE_NUMBER_OVERRIDES: Record<number, number> = {
  2: 4, // GPC002 LIM-SUMINISTRO
  3: 5, // GPC003 LIM-GRUPO
  4: 2, // GPC004 LIM-TIENDA VIRTUAL
  5: 3, // GPC005 LIM-CORPORATIVO
};
function ajusteStoreCode(store: Store): string | null {
  const label = String(store.erp_sede || store.name || "");
  if (/CD-GPC|CENTRO DISTRIBUCION/i.test(label)) return "1000";
  const match = label.match(/^GPC0*(\d+)/i);
  if (!match) return null;
  const labelNumber = Number(match[1]);
  const realNumber = GPC_STORE_NUMBER_OVERRIDES[labelNumber] ?? labelNumber;
  return String(1000 + realNumber);
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function AjustesProvisionalesPage() {
  const [user, setUser]       = useState<CyclicUser | null>(null);
  const [stores, setStores]   = useState<Store[]>([]);
  const [storeFilter, setStoreFilter] = useState("");
  const [codeSearch, setCodeSearch]   = useState("");
  const [rows, setRows]     = useState<AggRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded]   = useState(false);
  const [expandedStores, setExpandedStores] = useState<Set<string>>(new Set());
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [moduleDisabled, setModuleDisabled] = useState(false);

  // Cargar usuario desde localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem("cyclic_user");
      if (raw) setUser(JSON.parse(raw) as CyclicUser);
    } catch { setUser(null); }
  }, []);

  useEffect(() => {
    if (!user) return;
    fetchDisabledModules().then(disabled => {
      if (isModuleBlockedForUser(disabled, "ajustes_provisionales", user)) setModuleDisabled(true);
    });
  }, [user]);

  // Cargar tiendas
  useEffect(() => {
    supabase
      .from("stores")
      .select("id, code, name, is_active, erp_sede, erp_store_no")
      .order("name")
      .then(({ data }) => setStores((data || []) as Store[]));
  }, []);

  const canAccess = Boolean(user && canAccessModule(user, "ajustes_provisionales"));

  const canViewAllStores = useMemo(() =>
    user?.role === "Administrador" || user?.role === "Supervisor" || user?.role === "Validador" || Boolean(user?.can_access_all_stores),
    [user]
  );

  const userErpStoreCode = useMemo(() => {
    if (canViewAllStores || !user?.store_id || stores.length === 0) return null;
    const userStore = stores.find(s => s.id === user.store_id);
    if (!userStore) return null;
    return ajusteStoreCode(userStore) ?? userStore.code;
  }, [canViewAllStores, user, stores]);

  // ─── Carga de datos ──────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const effectiveStore = canViewAllStores ? (storeFilter || null) : (userErpStoreCode || null);
    setLoading(true);
    try {
      const [{ data, error }, syncRes] = await Promise.all([
        supabase.rpc("get_ajustes_provisionales", {
          year_start: yearStart,
          p_store:    effectiveStore,
          p_limit:    500,
          p_offset:   0,
        }),
        supabase.from("erp_sync_status").select("synced_at").eq("id", "ajustes_provisionales").maybeSingle(),
      ]);

      if (syncRes.data?.synced_at) setLastSync(syncRes.data.synced_at as string);

      if (error) throw error;

      const aggRows = (data || []) as AggRow[];
      setRows(aggRows);
      setLoaded(true);

      const storeCodes = new Set(aggRows.map((r: AggRow) => r.store_code));
      setExpandedStores(storeCodes);

      if (aggRows.length === 0) {
        toast.info("Sin ajustes provisionales en lo que va del año");
      }
    } catch (err: any) {
      toast.error(`Error al cargar: ${err?.message || "desconocido"}`);
    } finally {
      setLoading(false);
    }
  }, [storeFilter, canViewAllStores, userErpStoreCode]);

  // Auto-carga al tener acceso y tiendas listas
  useEffect(() => {
    if (canAccess && stores.length > 0 && !loaded && !loading) {
      load();
    }
  }, [canAccess, stores.length, loaded, loading, load]);

  // Recargar cuando cambia el filtro de tienda (el RPC filtra en el servidor)
  useEffect(() => {
    if (loaded) {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeFilter]);

  // ─── Filtros locales (solo búsqueda de código/descripción; tienda ya va al servidor) ───

  const visibleAggregated = useMemo((): AggRow[] => {
    let result = rows;
    if (codeSearch.trim()) {
      const q = codeSearch.trim().toLowerCase();
      result = result.filter(r =>
        r.product_code.toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q)
      );
    }
    return result.map(r => ({
      ...r,
      store_name: stores.find(s => ajusteStoreCode(s) === r.store_code)?.name || r.store_code,
      description: r.description || r.product_code,
      unit: r.unit || "",
    })).sort((a, b) =>
      a.store_name.localeCompare(b.store_name, "es") ||
      b.last_date.localeCompare(a.last_date)
    );
  }, [rows, codeSearch, stores]);

  // ─── Totales globales (solo sobre filas visibles) ─────────────────────────────

  const totalAjuste = useMemo(() =>
    visibleAggregated.reduce((s, r) => s + r.qty_ajuste, 0), [visibleAggregated]);

  const totalRegulariz = useMemo(() =>
    visibleAggregated.reduce((s, r) => s + r.qty_regulariz, 0), [visibleAggregated]);

  const totalNeto = useMemo(() =>
    visibleAggregated.reduce((s, r) => s + r.total_qty, 0), [visibleAggregated]);

  // ─── Agrupado por tienda ─────────────────────────────────────────────────────

  const byStore = useMemo(() => {
    const map = new Map<string, AggRow[]>();
    for (const row of visibleAggregated) {
      if (!map.has(row.store_code)) map.set(row.store_code, []);
      map.get(row.store_code)!.push(row);
    }
    return map;
  }, [visibleAggregated]);

  // ─── Exportar Excel ──────────────────────────────────────────────────────────

  function exportExcel() {
    const sheetData = visibleAggregated.map(r => ({
      Tienda:                   r.store_name,
      Codigo:                   r.product_code,
      Descripcion:              r.description,
      Unidad:                   r.unit || "",
      "Ajuste Provisional":     r.qty_ajuste,
      "Regulariz. Provisional": r.qty_regulariz,
      Suma:                     r.total_qty,
      "Valor Total":            Number(r.total_value.toFixed(2)),
      "Ultimo Ajuste":          formatSync(r.last_date),
      "Usuario ultimo ingreso provisional": r.last_user || "No informado",
      Documentos:               r.record_count,
    }));
    const ws = XLSX.utils.json_to_sheet(sheetData);
    ws["!cols"] = [
      { wch: 22 }, { wch: 18 }, { wch: 40 }, { wch: 10 },
      { wch: 22 }, { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 34 }, { wch: 10 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ajustes Provisionales");
    XLSX.writeFile(wb, `ajustes-provisionales-${new Date().getFullYear()}.xlsx`);
  }

  // ─── Render: sin acceso / cargando ───────────────────────────────────────────

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">Cargando sesión...</p>
      </div>
    );
  }

  if (!canAccess) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center space-y-2">
          <p className="text-slate-800 font-bold">Sin acceso a este módulo</p>
          <Link href="/" className="text-blue-600 text-sm underline">Volver al inicio</Link>
        </div>
      </div>
    );
  }
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Ajustes Provisionales" />;

  // ─── Render principal ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Header ── */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 shadow-sm">
        <Link
          href="/"
          className="shrink-0 flex items-center justify-center w-8 h-8 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
        >
          <Home size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-black text-slate-900 leading-tight">Ajustes Provisionales</h1>
          <p className="text-xs text-slate-500">Motivos 06 y 07 · {new Date().getFullYear()} · {user.full_name}</p>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">

        {/* ── Filtros ── */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-4">
          <div className="flex flex-wrap gap-3 items-end">
            {canViewAllStores && (
              <div className="flex-1 min-w-[160px]">
                <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Tienda</label>
                <select
                  value={storeFilter}
                  onChange={e => setStoreFilter(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 bg-white focus:border-slate-500 focus:outline-none"
                >
                  <option value="">Todas las tiendas</option>
                  {stores
                    .filter(s => s.is_active && !!ajusteStoreCode(s))
                    .map(s => (
                      <option key={s.id} value={ajusteStoreCode(s)!}>{s.name}</option>
                    ))}
                </select>
              </div>
            )}
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Código / Descripción</label>
              <input
                type="text"
                value={codeSearch}
                onChange={e => setCodeSearch(e.target.value)}
                placeholder="Buscar..."
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-900 bg-white focus:border-slate-500 focus:outline-none"
              />
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-2 px-6 py-2.5 rounded-2xl bg-slate-900 text-white text-sm font-bold disabled:opacity-50 active:scale-[0.97] transition-transform"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              {loading ? "Cargando..." : "Actualizar"}
            </button>
            {loaded && rows.length > 0 && (
              <button
                onClick={exportExcel}
                className="flex items-center gap-2 px-5 py-2.5 rounded-2xl border border-slate-200 text-sm font-bold text-slate-700 active:scale-[0.97] transition-transform"
              >
                <Download size={14} />
                Excel
              </button>
            )}
          </div>
        </div>

        {/* ── Sincronizacion ERP ── */}
        {(() => {
          const syncStale = !lastSync || (Date.now() - new Date(lastSync).getTime()) > 15 * 60 * 1000;
          return (
            <div className={`rounded-2xl border px-4 py-3 shadow-sm ${syncStale ? "border-red-300 bg-red-50" : "bg-white"}`}>
              <p className={`text-xs font-black uppercase ${syncStale ? "text-red-600" : "text-slate-500"}`}>
                {syncStale ? "⚠ Sincronizacion ERP Ajustes detenida" : "Ultima sincronizacion ERP Ajustes"}
              </p>
              <p className={`text-sm font-black ${syncStale ? "text-red-700" : "text-slate-900"}`}>
                {lastSync ? formatSync(lastSync) : "Sin sincronizacion registrada"}
              </p>
            </div>
          );
        })()}

        {/* ── KPI cards ── */}
        {loaded && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-4 text-center">
              <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1">Productos</div>
              <div className="text-3xl font-black text-slate-900">{visibleAggregated.length}</div>
              {rows[0]?.total_rows !== undefined && rows[0].total_rows > visibleAggregated.length && (
                <div className="text-[10px] text-slate-400 mt-0.5">de {rows[0].total_rows} total</div>
              )}
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-4 text-center">
              <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1">Ajuste Prov. 06</div>
              <div className={`text-2xl font-black ${totalAjuste >= 0 ? "text-green-700" : "text-red-600"}`}>
                {totalAjuste >= 0 ? "+" : ""}{fmt(totalAjuste)}
              </div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-4 text-center">
              <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1">Regulariz. Prov. 07</div>
              <div className={`text-2xl font-black ${totalRegulariz >= 0 ? "text-green-700" : "text-amber-600"}`}>
                {totalRegulariz >= 0 ? "+" : ""}{fmt(totalRegulariz)}
              </div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-4 text-center">
              <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1">Suma</div>
              <div className={`text-2xl font-black ${totalNeto >= 0 ? "text-blue-700" : "text-red-600"}`}>
                {totalNeto >= 0 ? "+" : ""}{fmt(totalNeto)}
              </div>
            </div>
          </div>
        )}

        {/* ── Tabla por tienda ── */}
        {loaded && byStore.size > 0 && (
          <div className="space-y-3">
            {Array.from(byStore.entries()).map(([storeCode, storeRows]) => {
              const storeName    = storeRows[0]?.store_name || storeCode;
              const storeTotal   = storeRows.reduce((s, r) => s + r.total_qty, 0);
              const storeValue   = storeRows.reduce((s, r) => s + r.total_value, 0);
              const isExpanded   = expandedStores.has(storeCode);

              return (
                <div key={storeCode} className="bg-white rounded-2xl border border-slate-100 shadow-md overflow-hidden">

                  {/* Cabecera de tienda */}
                  <button
                    className="w-full flex items-center justify-between px-5 py-3.5 bg-slate-800 text-white active:bg-slate-700 transition-colors text-left"
                    onClick={() => setExpandedStores(prev => {
                      const next = new Set(prev);
                      if (next.has(storeCode)) next.delete(storeCode); else next.add(storeCode);
                      return next;
                    })}
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded
                        ? <ChevronDown size={16} className="shrink-0 opacity-60" />
                        : <ChevronRight size={16} className="shrink-0 opacity-60" />
                      }
                      <span className="font-black text-sm">{storeName}</span>
                      <span className="text-[11px] bg-white/20 rounded-full px-2 py-0.5 font-semibold">
                        {storeRows.length} {storeRows.length === 1 ? "producto" : "productos"}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right hidden sm:block">
                        <div className="text-[11px] text-slate-400 font-semibold">Total</div>
                        <div className="text-sm font-black text-slate-300">{fmtMoney(storeValue)}</div>
                      </div>
                      <div className={`text-sm font-black px-3 py-1 rounded-xl ${
                        storeTotal >= 0
                          ? "bg-green-500/20 text-green-300"
                          : "bg-red-500/20 text-red-300"
                      }`}>
                        {storeTotal >= 0 ? "+" : ""}{fmt(storeTotal)}
                      </div>
                    </div>
                  </button>

                  {/* Tabla de productos */}
                  {isExpanded && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50">
                            <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-slate-400 whitespace-nowrap">Código</th>
                            <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-slate-400">Descripción</th>
                            <th className="px-4 py-2.5 text-center text-[11px] font-bold uppercase tracking-wider text-slate-400 whitespace-nowrap">Unidad</th>
                            <th className="px-4 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider text-green-600 whitespace-nowrap">Ajuste Prov.</th>
                            <th className="px-4 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider text-amber-600 whitespace-nowrap">Regulariz. Prov.</th>
                            <th className="px-4 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider text-blue-600 whitespace-nowrap">Suma</th>
                            <th className="px-4 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider text-slate-400 whitespace-nowrap">Valor</th>
                            <th className="px-4 py-2.5 text-center text-[11px] font-bold uppercase tracking-wider text-slate-400 whitespace-nowrap">Último ajuste</th>
                            <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-slate-400 whitespace-nowrap">Usuario último ingreso</th>
                             <th className="px-4 py-2.5 text-center text-[11px] font-bold uppercase tracking-wider text-slate-400">Docs</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {storeRows.map((row, i) => (
                            <tr key={i} className="hover:bg-slate-50/80 transition-colors">
                              <td className="px-4 py-3 font-mono text-xs font-bold text-slate-700 whitespace-nowrap">
                                {row.product_code}
                              </td>
                              <td className="px-4 py-3 text-slate-600 max-w-[240px]">
                                <span className="line-clamp-2 leading-snug">{row.description}</span>
                              </td>
                              <td className="px-4 py-3 text-center text-slate-500 text-xs font-semibold whitespace-nowrap">
                                {row.unit || <span className="text-slate-300">—</span>}
                              </td>
                              <td className={`px-4 py-3 text-right font-black tabular-nums whitespace-nowrap ${
                                row.qty_ajuste > 0 ? "text-green-700" : row.qty_ajuste < 0 ? "text-red-600" : "text-slate-300"
                              }`}>
                                {row.qty_ajuste !== 0 ? `${row.qty_ajuste > 0 ? "+" : ""}${fmt(row.qty_ajuste)}` : "—"}
                              </td>
                              <td className={`px-4 py-3 text-right font-black tabular-nums whitespace-nowrap ${
                                row.qty_regulariz > 0 ? "text-green-700" : row.qty_regulariz < 0 ? "text-amber-700" : "text-slate-300"
                              }`}>
                                {row.qty_regulariz !== 0 ? `${row.qty_regulariz > 0 ? "+" : ""}${fmt(row.qty_regulariz)}` : "—"}
                              </td>
                              <td className="px-4 py-3 text-right font-black tabular-nums text-blue-700 whitespace-nowrap">
                                +{fmt(row.total_qty)}
                              </td>
                              <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-500 whitespace-nowrap">
                                {fmtMoney(row.total_value)}
                              </td>
                              <td className="px-4 py-3 text-center text-slate-500 text-xs font-semibold whitespace-nowrap">
                                {formatSync(row.last_date)}
                              </td>
                              <td className="px-4 py-3 text-left text-slate-500 text-xs font-semibold max-w-[220px]">
                                <span className="line-clamp-2 leading-snug">{row.last_user || "No informado"}</span>
                              </td>
                              <td className="px-4 py-3 text-center text-slate-400 text-xs font-bold">
                                {row.record_count}
                              </td>
                            </tr>
                          ))}
                        </tbody>

                        {/* Subtotal tienda */}
                        <tfoot>
                          <tr className="border-t-2 border-slate-200 bg-slate-50">
                            <td colSpan={3} className="px-4 py-2.5 text-xs font-black text-slate-500 uppercase tracking-wide">
                              Total {storeName}
                            </td>
                            {(() => {
                              const tAj = storeRows.reduce((s, r) => s + r.qty_ajuste, 0);
                              const tRe = storeRows.reduce((s, r) => s + r.qty_regulariz, 0);
                              return (<>
                                <td className={`px-4 py-2.5 text-right font-black tabular-nums text-sm whitespace-nowrap ${tAj >= 0 ? "text-green-700" : "text-red-600"}`}>
                                  {tAj >= 0 ? "+" : ""}{fmt(tAj)}
                                </td>
                                <td className={`px-4 py-2.5 text-right font-black tabular-nums text-sm whitespace-nowrap ${tRe >= 0 ? "text-green-700" : "text-amber-700"}`}>
                                  {tRe >= 0 ? "+" : ""}{fmt(tRe)}
                                </td>
                              </>);
                            })()}
                            <td className="px-4 py-2.5 text-right font-black tabular-nums text-sm text-blue-700 whitespace-nowrap">
                              +{fmt(storeTotal)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-black text-slate-700 tabular-nums text-sm whitespace-nowrap">
                              {fmtMoney(storeValue)}
                            </td>
                            <td />
                            <td />
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Gran total */}
            <div className="bg-slate-900 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">Gran total</p>
                <p className="text-xs text-slate-500">{visibleAggregated.length} productos · {byStore.size} tiendas</p>
              </div>
              <div className="flex items-center gap-6">
                <div className="text-center">
                  <p className="text-[11px] text-slate-400 font-semibold mb-0.5">Ajuste Prov.</p>
                  <p className={`text-xl font-black ${totalAjuste >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {totalAjuste >= 0 ? "+" : ""}{fmt(totalAjuste)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[11px] text-slate-400 font-semibold mb-0.5">Regulariz. Prov.</p>
                  <p className={`text-xl font-black ${totalRegulariz >= 0 ? "text-green-400" : "text-amber-400"}`}>
                    {totalRegulariz >= 0 ? "+" : ""}{fmt(totalRegulariz)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-[11px] text-slate-400 font-semibold mb-0.5">Suma</p>
                  <p className="text-2xl font-black text-blue-400">
                    +{fmt(totalNeto)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Sin datos ── */}
        {loaded && byStore.size === 0 && (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-md p-12 text-center">
            <p className="text-slate-600 font-semibold">Sin ajustes provisionales en lo que va del {new Date().getFullYear()}</p>
            <p className="text-xs text-slate-400 mt-1">Ajusta los filtros de tienda o código</p>
          </div>
        )}

      </main>
    </div>
  );
}
