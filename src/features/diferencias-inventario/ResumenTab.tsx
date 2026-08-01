"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import type { CyclicUser, Store } from "@/features/ciclicos/types";
import { formatDateTime, formatNumber } from "@/features/ciclicos/utils";
import { fetchDifferenceReports, regularizeReport, rejectReport } from "./api";
import type { DifferenceReport, DifferenceStatus } from "./types";
import { TabNav } from "./TabNav";

const PAGE_SIZE = 30;

const STATUS_LABEL: Record<DifferenceStatus, string> = {
  pendiente: "Pendiente",
  regularizado: "Regularizado",
  rechazado: "Rechazado",
};

const STATUS_BADGE: Record<DifferenceStatus, string> = {
  pendiente: "bg-slate-200 text-slate-700",
  regularizado: "bg-green-100 text-green-700",
  rechazado: "bg-red-100 text-red-700",
};

export default function ResumenTab() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);

  const [rows, setRows] = useState<DifferenceReport[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [storeFilter, setStoreFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<DifferenceStatus | "all">("all");

  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustmentNumberDraft, setAdjustmentNumberDraft] = useState("");
  const [savingActionId, setSavingActionId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cyclic_user");
      if (raw) setUser(JSON.parse(raw) as CyclicUser);
    } catch { setUser(null); }
    setUserLoaded(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    fetchDisabledModules().then(disabled => {
      if (isModuleBlockedForUser(disabled, "inventory_differences", user)) setModuleDisabled(true);
    });
  }, [user]);

  useEffect(() => {
    supabase.from("stores").select("id, code, name, is_active, erp_sede").eq("is_active", true).order("name")
      .then(({ data }) => setStores((data || []) as Store[]));
  }, []);

  const canValidate = user?.role === "Validador" || user?.role === "Supervisor" || user?.role === "Administrador";
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const loadReports = useMemo(() => async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { rows: fetchedRows, total: fetchedTotal } = await fetchDifferenceReports({
        scope: canValidate ? "all" : "own",
        operatorId: user.id,
        storeId: canValidate ? (storeFilter || null) : null,
        status: statusFilter,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(fetchedRows);
      setTotal(fetchedTotal);
    } catch (error) {
      toast.error("No se pudo cargar el resumen: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, canValidate, storeFilter, statusFilter, page]);

  useEffect(() => { void loadReports(); }, [loadReports]);

  useEffect(() => { setPage(1); }, [storeFilter, statusFilter]);

  function openAdjustmentPrompt(reportId: string) {
    setAdjustingId(reportId);
    setAdjustmentNumberDraft("");
  }

  async function confirmRegularize(report: DifferenceReport) {
    const adjustmentNumber = adjustmentNumberDraft.trim();
    if (!adjustmentNumber) { toast.error("El # de ajuste es obligatorio para regularizar."); return; }
    const confirmed = window.confirm(
      `Vas a marcar ${report.sku} como REGULARIZADO con el ajuste "${adjustmentNumber}".\n\n¿Confirmas?`
    );
    if (!confirmed || !user) return;
    setSavingActionId(report.id);
    try {
      await regularizeReport(report.id, adjustmentNumber, { id: user.id, name: user.full_name });
      setAdjustingId(null);
      toast.success(`${report.sku} regularizado.`);
      await loadReports();
    } catch (error) {
      toast.error("No se pudo regularizar: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSavingActionId(null);
    }
  }

  async function handleReject(report: DifferenceReport) {
    const confirmed = window.confirm(`Vas a marcar ${report.sku} como RECHAZADO.\n\n¿Confirmas?`);
    if (!confirmed || !user) return;
    setSavingActionId(report.id);
    try {
      await rejectReport(report.id, { id: user.id, name: user.full_name });
      toast.success(`${report.sku} rechazado.`);
      await loadReports();
    } catch (error) {
      toast.error("No se pudo rechazar: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSavingActionId(null);
    }
  }

  if (!userLoaded) return null;
  if (!user || !canAccessModule(user, "inventory_differences")) {
    return <ModuleDisabledScreen moduleLabel="Diferencias de Inventario" reason="Tu usuario no tiene acceso a este módulo." />;
  }
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Diferencias de Inventario" />;

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 pb-24">
      <TabNav active="resumen" />

      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-black">
            {canValidate ? "Reportes de todas las tiendas" : "Mis reportes"} ({total})
          </h2>
          <div className="flex flex-wrap gap-2">
            {canValidate && (
              <select value={storeFilter} onChange={event => setStoreFilter(event.target.value)} className="rounded-xl border px-3 py-2 text-xs font-bold">
                <option value="">Todas las tiendas</option>
                {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            )}
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as DifferenceStatus | "all")} className="rounded-xl border px-3 py-2 text-xs font-bold">
              <option value="all">Todos los estados</option>
              <option value="pendiente">Pendiente</option>
              <option value="regularizado">Regularizado</option>
              <option value="rechazado">Rechazado</option>
            </select>
            <button onClick={() => void loadReports()} className="rounded-xl border p-2 text-slate-600" title="Actualizar">
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-slate-100 text-xs text-slate-600">
              <tr>
                <th className="p-2 text-left">Código</th>
                <th className="p-2 text-left">Descripción</th>
                {canValidate && <th className="p-2 text-left">Tienda</th>}
                <th className="p-2">Stock al reportar</th>
                <th className="p-2">Cant. física</th>
                <th className="p-2">Dif.</th>
                <th className="p-2">Foto</th>
                <th className="p-2 text-left">Observación</th>
                <th className="p-2 text-left">Operador</th>
                <th className="p-2">Fecha</th>
                <th className="p-2">Estado</th>
                <th className="p-2"># Ajuste</th>
                {canValidate && <th className="p-2">Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(report => {
                const diff = report.physical_qty - report.system_stock_at_report;
                return (
                  <tr key={report.id} className="border-b hover:bg-slate-50">
                    <td className="p-2 font-black">{report.sku}</td>
                    <td className="max-w-xs truncate p-2">{report.description}</td>
                    {canValidate && <td className="p-2">{report.store_name}</td>}
                    <td className="p-2 text-center">{formatNumber(report.system_stock_at_report)}</td>
                    <td className="p-2 text-center font-bold">{formatNumber(report.physical_qty)}</td>
                    <td className={`p-2 text-center font-black ${diff < 0 ? "text-red-600" : diff > 0 ? "text-blue-700" : "text-green-700"}`}>
                      {diff > 0 ? "+" : ""}{formatNumber(diff)}
                    </td>
                    <td className="p-2 text-center">
                      <a href={report.photo_url} target="_blank" rel="noreferrer" className="text-blue-700 underline">Ver</a>
                    </td>
                    <td className="max-w-xs truncate p-2 text-xs">{report.notes || "-"}</td>
                    <td className="p-2 text-xs">{report.operator_name}</td>
                    <td className="p-2 text-xs">{formatDateTime(report.created_at)}</td>
                    <td className="p-2 text-center">
                      <span className={`rounded-full px-2 py-1 text-[11px] font-black ${STATUS_BADGE[report.status]}`}>
                        {STATUS_LABEL[report.status]}
                      </span>
                    </td>
                    <td className="p-2 text-center text-xs font-bold">{report.adjustment_number || "-"}</td>
                    {canValidate && (
                      <td className="p-2">
                        {report.status === "pendiente" ? (
                          <div className="flex flex-col gap-1">
                            {adjustingId === report.id ? (
                              <div className="flex gap-1">
                                <input
                                  value={adjustmentNumberDraft}
                                  onChange={event => setAdjustmentNumberDraft(event.target.value)}
                                  placeholder="# ajuste"
                                  className="w-24 rounded-lg border px-2 py-1 text-xs"
                                />
                                <button
                                  onClick={() => void confirmRegularize(report)}
                                  disabled={savingActionId === report.id}
                                  className="rounded-lg bg-green-700 px-2 py-1 text-xs font-black text-white disabled:opacity-40"
                                >
                                  OK
                                </button>
                                <button onClick={() => setAdjustingId(null)} className="rounded-lg border px-2 py-1 text-xs font-black">X</button>
                              </div>
                            ) : (
                              <button
                                onClick={() => openAdjustmentPrompt(report.id)}
                                disabled={savingActionId === report.id}
                                className="rounded-lg border border-green-300 px-2 py-1 text-xs font-black text-green-700 disabled:opacity-40"
                              >
                                Regularizar
                              </button>
                            )}
                            <button
                              onClick={() => void handleReject(report)}
                              disabled={savingActionId === report.id}
                              className="rounded-lg border border-red-300 px-2 py-1 text-xs font-black text-red-700 disabled:opacity-40"
                            >
                              Rechazar
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">
                            {report.validated_by_name ? `Por ${report.validated_by_name}` : "-"}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canValidate ? 13 : 11} className="p-8 text-center text-sm text-slate-400">
                    {loading ? "Cargando..." : "Sin reportes."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-black text-slate-600">
            {total === 0 ? "Sin filas" : `Página ${page} de ${totalPages}`}
          </span>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40">
            Anterior
          </button>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="rounded-xl border px-3 py-2 text-xs font-black text-slate-700 disabled:opacity-40">
            Siguiente
          </button>
        </div>
      </div>
    </main>
  );
}
