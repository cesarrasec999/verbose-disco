"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { cachedRead, mapBounded } from "@/lib/boundedReads";

type Store = { id: string; name: string };
type CoverageRow = { store_id: string; store: string; total: number; sampled: number; unsampled: number; pct: number };

export default function AnalysisCoverageModule() {
  const [stores, setStores] = useState<Store[]>([]);
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const scope = useRef("");
  const inFlight = useRef(false);

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) { window.location.replace("/"); return; }
    const user = JSON.parse(raw);
    if (!canAccessModule(user, "reports") && !canAccessModule(user, "analysis") && !["Administrador", "Supervisor", "Validador"].includes(user.role)) { window.location.replace("/"); return; }
    scope.current = user.id;
    void supabase.from("stores").select("id,name").eq("is_active", true).order("name").then(({ data, error }) => {
      if (error) setMessage(error.message);
      else setStores(data || []);
      setReady(true);
    });
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (!stores.length || inFlight.current) return;
    inFlight.current = true; setLoading(true);
    try {
      const result = await cachedRead("coverage:" + scope.current + ":" + stores.map(s => s.id).join(","), () => mapBounded(stores, async store => {
        const { data, error } = await supabase.rpc("get_analysis_coverage_v2", { p_store_id: store.id });
        if (error) throw error;
        if (!data?.[0]) throw new Error("No se obtuvo cobertura para " + store.name);
        return data[0] as CoverageRow;
      }), 60000, force);
      setCoverage(result.map(r => ({ ...r, pct: Number(r.pct) })).sort((a, b) => b.pct - a.pct));
      setUpdatedAt(new Date().toLocaleString("es-PE")); setMessage("");
    } catch (error) {
      setMessage("No se pudo actualizar cobertura: " + (error instanceof Error ? error.message : (error as { message?: string })?.message || String(error)) + ". Se mantiene el último resultado consultado.");
    } finally { setLoading(false); inFlight.current = false; }
  }, [stores]);

  useEffect(() => {
    if (!ready) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60000);
    return () => window.clearInterval(timer);
  }, [ready, refresh]);

  async function downloadExcel() {
    setExporting(true);
    try {
      const response = await fetch("/api/analisis/maestro-excel", { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || "Error " + response.status);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = "maestro_muestreo_" + new Date().toISOString().slice(0, 10) + ".xlsx"; link.click(); URL.revokeObjectURL(url);
    } catch (error) { setMessage("Error descargando Excel: " + (error instanceof Error ? error.message : String(error))); }
    finally { setExporting(false); }
  }

  if (!ready) return <div className="p-8 text-center font-bold text-slate-400">Cargando...</div>;
  return <div className="p-4 md:p-8"><div className="mx-auto max-w-7xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white p-4">
      <div><h2 className="text-2xl font-black">Cobertura y maestro de muestreo</h2><p className="text-sm text-slate-500">Códigos con stock positivo que cuentan con muestreo cíclico o auditoría finalizada.</p>{updatedAt && <p className="text-xs text-slate-500">Última consulta: {updatedAt}</p>}</div>
      <div className="flex flex-wrap gap-2"><button onClick={() => void refresh(true)} disabled={loading} className="flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-black text-white disabled:opacity-40">{loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />} Actualizar cobertura</button><button onClick={() => void downloadExcel()} disabled={exporting} className="flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40"><Download size={16} />{exporting ? "Preparando Excel..." : "Descargar Excel"}</button></div>
    </div>
    {message && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{message}</p>}
    <div className="rounded-2xl border bg-white p-4"><h3 className="mb-3 font-black">% de códigos muestreados por tienda</h3><div className="space-y-3">{coverage.map(row => <div key={row.store_id} className="grid grid-cols-[minmax(140px,260px)_1fr_90px] items-center gap-3 text-sm"><span className="font-bold">{row.store}<small className="block font-normal text-slate-500">{row.sampled} de {row.total} códigos</small></span><div className="h-7 overflow-hidden rounded-lg bg-slate-100"><div className="h-full rounded-lg bg-blue-600" style={{ width: Math.min(100, row.pct) + "%" }} /></div><span className="text-right font-black">{row.pct.toFixed(2)}%</span></div>)}{!coverage.length && <p className="py-10 text-center text-slate-400">{loading ? "Calculando cobertura..." : "Sin resultados consultados."}</p>}</div></div>
  </div></div>;
}
