"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Home, RefreshCw } from "lucide-react";
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
  registro: string | null;
  legajo: string | null;
  observacion: string | null;
  fecha_recepcion: string | null;
  cumple_documentacion: boolean;
};

const REGISTRO_OPTIONS = ["Plataforma", "Virtual", "Presencial"];

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

export default function VentasCreditoPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [rows, setRows] = useState<VentaCredito[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const [storeFilter, setStoreFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "A" | "C">("all");
  const [dateFrom, setDateFrom] = useState(monthStartISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [savingId, setSavingId] = useState<string | null>(null);

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

  const canAccess = Boolean(user && canAccessModule(user, "credit_sales"));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("ventas_credito")
        .select("*")
        .gte("fecha_emision", dateFrom)
        .lte("fecha_emision", dateTo)
        .order("fecha_emision", { ascending: false })
        .limit(1000);
      if (storeFilter) query = query.eq("store_code", storeFilter);
      if (statusFilter !== "all") query = query.eq("status_code", statusFilter);

      const [{ data, error }, syncRes] = await Promise.all([
        query,
        supabase.from("erp_sync_status").select("synced_at").eq("id", "ventas_credito").maybeSingle(),
      ]);
      if (error) throw error;
      setRows((data || []) as VentaCredito[]);
      setLastSync(syncRes.data?.synced_at || null);
      setLoaded(true);
    } catch (err: any) {
      toast.error(`Error al cargar: ${err?.message || "desconocido"}`);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, storeFilter, statusFilter]);

  useEffect(() => {
    if (canAccess) void load();
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

  const totals = useMemo(() => {
    const importeTotal = rows.reduce((s, r) => s + Number(r.importe_total || 0), 0);
    const cumplen = rows.filter(r => r.cumple_documentacion).length;
    return { count: rows.length, importeTotal, cumplen, pendientes: rows.length - cumplen };
  }, [rows]);

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
          <a href="/" className="text-sm text-blue-600 underline">Volver al inicio</a>
        </div>
      </div>
    );
  }

  const syncStale = !lastSync || Date.now() - new Date(lastSync).getTime() > 15 * 60 * 1000;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <a href="/" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200">
          <Home size={16} />
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-black leading-tight text-slate-900">Ventas a Crédito</h1>
          <p className="text-xs text-slate-500">Control de documentación · {user.full_name}</p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> {loading ? "Cargando..." : "Actualizar"}
        </button>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 p-4">
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-md">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[180px] flex-1">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Tienda</label>
              <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900">
                <option value="">Todas las tiendas</option>
                {stores.filter(s => s.is_active && s.erp_store_no).map(s => (
                  <option key={s.id} value={s.erp_store_no!}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[150px]">
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Estado</label>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900">
                <option value="all">Todos</option>
                <option value="A">Activo</option>
                <option value="C">Anulado</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Desde</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900" />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Hasta</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900" />
            </div>
          </div>
        </div>

        <div className={`rounded-2xl border px-4 py-3 shadow-sm ${syncStale ? "border-red-300 bg-red-50" : "bg-white"}`}>
          <p className={`text-xs font-black uppercase ${syncStale ? "text-red-600" : "text-slate-500"}`}>
            {syncStale ? "⚠ Sincronización ERP Ventas a Crédito detenida" : "Última sincronización ERP Ventas a Crédito"}
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
          <table className="w-full min-w-[1700px] text-left text-[11px]">
            <thead>
              <tr className="border-b bg-slate-50 text-[10px] font-black uppercase text-slate-500">
                <th className="p-2">Documento</th>
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
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-b last:border-0 hover:bg-slate-50/80">
                  <td className="p-2 font-black text-slate-900">{row.document_type || "-"}</td>
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
                    <select
                      value={row.registro || ""}
                      onChange={e => void saveField(row, { registro: e.target.value || null })}
                      disabled={savingId === row.id}
                      className="rounded-lg border px-2 py-1 text-[11px] font-bold"
                    >
                      <option value="">-</option>
                      {REGISTRO_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </td>
                  <td className="p-2">
                    <input
                      defaultValue={row.legajo || ""}
                      onBlur={e => { if (e.target.value !== (row.legajo || "")) void saveField(row, { legajo: e.target.value.trim() || null }); }}
                      disabled={savingId === row.id}
                      className="w-24 rounded-lg border px-2 py-1 text-[11px] font-bold"
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
              ))}
            </tbody>
          </table>
          {loaded && rows.length === 0 && (
            <p className="p-8 text-center text-sm font-bold text-slate-400">Sin ventas a crédito para estos filtros.</p>
          )}
        </div>
      </main>
    </div>
  );
}
