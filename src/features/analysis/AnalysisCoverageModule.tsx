"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";

type Store = { id: string; name: string; erp_sede?: string | null; code?: string | null; is_active: boolean };
type Product = { id: string; sku: string; description: string; unit: string; cost: number };
type MasterRow = { store: string; store_id: string; sku: string; description: string; unit: string; rotation: string; stock: number; cost: number; value: number; sampled_cyclic: string; sampled_audit: string; sampled: string };
type CoverageRow = { store_id: string; store: string; rotation: string; total: number; sampled: number; unsampled: number; pct: number };

const FLAGS = new Set(["__session_counting__", "__session_finished__", "__recount_started__", "__recount_done__"]);
const norm = (value: unknown) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const skuOf = (value: unknown) => { const raw = String(value || "").trim().toUpperCase(); return raw.startsWith("AU") || raw.startsWith("FE") || raw.startsWith("SI") || raw.startsWith("BA") || raw.startsWith("LU") || raw.startsWith("SV") ? raw : raw; };

export default function AnalysisCoverageModule() {
  const [stores, setStores] = useState<Store[]>([]);
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [summaryRows, setSummaryRows] = useState<CoverageRow[]>([]);
  const [rows, setRows] = useState<MasterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const raw = typeof window !== "undefined" ? localStorage.getItem("cyclic_user") : null;
    if (!raw) { window.location.replace("/"); return; }
    const user = JSON.parse(raw);
    if (!canAccessModule(user, "reports") && !canAccessModule(user, "analysis") && !["Administrador", "Supervisor", "Validador"].includes(user.role)) { window.location.replace("/"); return; }
    supabase.from("stores").select("id,name,erp_sede,code,is_active").eq("is_active", true).order("name").then(({ data, error }) => {
      if (error) setMessage(error.message);
      setStores((data || []) as Store[]);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready || stores.length === 0) return;
    void loadCoverageOnly();
    const timer = window.setInterval(() => void loadCoverageOnly(), 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stores.length]);

  async function pages<T>(factory: (from: number, to: number) => any) {
    const result: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await factory(from, from + 999);
      if (error) throw error;
      result.push(...((data || []) as T[]));
      if (!data || data.length < 1000) return result;
    }
  }

  async function loadCoverageOnly() {
    if (!stores.length) return;
    setLoading(true);
    try {
      const totalByStore = new Map<string, Set<string>>();
      await Promise.all(stores.map(async store => {
        const sede = String(store.erp_sede || store.name || "");
        const stockRows = await pages<any>((from, to) => supabase.from("stock_general").select("codsap").eq("sede", sede).range(from, to));
        totalByStore.set(store.id, new Set(stockRows.map(row => norm(row.codsap)).filter(Boolean)));
      }));

      const assignments = await pages<any>((from, to) => supabase.from("cyclic_assignments").select("id,store_id,product_id").range(from, to));
      const assignmentIds = assignments.map(row => String(row.id)).filter(Boolean);
      const cyclicCounts: any[] = [];
      for (let i = 0; i < assignmentIds.length; i += 100) cyclicCounts.push(...await pages<any>((from, to) => supabase.from("cyclic_counts").select("assignment_id,location").in("assignment_id", assignmentIds.slice(i, i + 100)).range(from, to)));
      const countedAssignments = new Set(cyclicCounts.filter(row => !FLAGS.has(String(row.location || ""))).map(row => String(row.assignment_id)));
      const sampledByStore = new Map<string, Set<string>>();
      for (const assignment of assignments) if (countedAssignments.has(String(assignment.id))) { const set = sampledByStore.get(String(assignment.store_id)) || new Set<string>(); set.add(String(assignment.product_id)); sampledByStore.set(String(assignment.store_id), set); }

      const sessions = await pages<any>((from, to) => supabase.from("audit_sessions").select("id,store_id").eq("status", "finished").range(from, to));
      const sessionIds = sessions.map(row => String(row.id)).filter(Boolean);
      const sessionStore = new Map(sessions.map(row => [String(row.id), String(row.store_id)]));
      const auditItems: any[] = []; const auditCounts: any[] = [];
      for (let i = 0; i < sessionIds.length; i += 100) { const chunk = sessionIds.slice(i, i + 100); auditItems.push(...await pages<any>((from, to) => supabase.from("audit_session_items").select("id,session_id,product_id").in("session_id", chunk).range(from, to))); auditCounts.push(...await pages<any>((from, to) => supabase.from("audit_counts").select("item_id").in("session_id", chunk).range(from, to))); }
      const countedAuditItems = new Set(auditCounts.map(row => String(row.item_id)));
      for (const item of auditItems) if (countedAuditItems.has(String(item.id))) { const storeId = sessionStore.get(String(item.session_id)); if (!storeId) continue; const set = sampledByStore.get(storeId) || new Set<string>(); set.add(String(item.product_id)); sampledByStore.set(storeId, set); }

      setCoverage(stores.map(store => { const total = totalByStore.get(store.id)?.size || 0; const sampled = Math.min(total, sampledByStore.get(store.id)?.size || 0); return { store_id: store.id, store: store.name, rotation: "Todas", total, sampled, unsampled: Math.max(0, total - sampled), pct: total ? sampled / total * 100 : 0 }; }).sort((a, b) => b.pct - a.pct));
      setMessage("Cobertura actualizada.");
    } catch (error: any) { setMessage(`Error actualizando cobertura: ${error.message || error}`); } finally { setLoading(false); }
  }

  async function generate() {
    if (!stores.length) return;
    setLoading(true); setMessage("");
    try {
      const products = await pages<Product>((from, to) => supabase.from("cyclic_products").select("id,sku,description,unit,cost").eq("is_active", true).range(from, to));
      const productById = new Map(products.map(product => [String(product.id), { ...product, sku: skuOf(product.sku), cost: Number(product.cost || 0) }]));
      const productBySku = new Map([...productById.values()].map(product => [norm(product.sku), product]));
      const assignments = await pages<any>((from, to) => supabase.from("cyclic_assignments").select("id,store_id,product_id").range(from, to));
      const assignmentIds = assignments.map(row => String(row.id)).filter(Boolean);
      const cyclicCounts: any[] = [];
      for (let i = 0; i < assignmentIds.length; i += 100) cyclicCounts.push(...await pages<any>((from, to) => supabase.from("cyclic_counts").select("assignment_id,location").in("assignment_id", assignmentIds.slice(i, i + 100)).range(from, to)));
      const countedAssignments = new Set(cyclicCounts.filter(row => !FLAGS.has(String(row.location || ""))).map(row => String(row.assignment_id)));
      const cyclicSampled = new Set<string>();
      for (const assignment of assignments) if (countedAssignments.has(String(assignment.id))) cyclicSampled.add(`${assignment.store_id}|${assignment.product_id}`);

      const sessions = await pages<any>((from, to) => supabase.from("audit_sessions").select("id,store_id").eq("status", "finished").range(from, to));
      const sessionIds = sessions.map(row => String(row.id)).filter(Boolean);
      const sessionStore = new Map(sessions.map(row => [String(row.id), String(row.store_id)]));
      const auditItems: any[] = []; const auditCounts: any[] = [];
      for (let i = 0; i < sessionIds.length; i += 100) {
        const chunk = sessionIds.slice(i, i + 100);
        auditItems.push(...await pages<any>((from, to) => supabase.from("audit_session_items").select("id,session_id,product_id").in("session_id", chunk).range(from, to)));
        auditCounts.push(...await pages<any>((from, to) => supabase.from("audit_counts").select("item_id").in("session_id", chunk).range(from, to)));
      }
      const countedAuditItems = new Set(auditCounts.map(row => String(row.item_id)));
      const auditSampled = new Set<string>();
      for (const item of auditItems) if (countedAuditItems.has(String(item.id))) auditSampled.add(`${sessionStore.get(String(item.session_id))}|${item.product_id}`);

      const master: MasterRow[] = [];
      for (const store of stores) {
        const sede = String(store.erp_sede || store.name || "");
        const stockRows = await pages<any>((from, to) => supabase.from("stock_general").select("codsap,stock").eq("sede", sede).range(from, to));
        const aliases = ["ARBOLEDA", "CALLAO", "GRUPO", "LURIN", "PIURA", "TRUJILLO", "LEGUIA", "CHORRILLOS", "AREQUIPA NEW K 21", "VILLA EL SALVADOR", "SUMINISTRO", "DIAMANTE", "HUANCAYO", "NARANJAL", "PTE PIEDRA", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA", "HUACHIPA", "AREQUIPA MIRAFLORES", "CAJAMARCA", "CD"];
        const sourceNames = [store.name, store.code, store.erp_sede].filter(Boolean).map(norm);
        const keys = [...new Set([...sourceNames, ...aliases.filter(alias => sourceNames.some(source => source.includes(norm(alias))))])];
        const rotationRows = await pages<any>((from, to) => supabase.from("product_rotation_monthly").select("product_code,rotation_category,period_month,store_key").in("store_key", keys).order("period_month", { ascending: false }).range(from, to));
        const rotationBySku = new Map<string, string>();
        for (const row of rotationRows) { const sku = norm(row.product_code); if (!rotationBySku.has(sku)) rotationBySku.set(sku, String(row.rotation_category || "SIN ROTACION")); }
        for (const stockRow of stockRows) {
          const sku = skuOf(stockRow.codsap); const product = productBySku.get(norm(sku));
          if (!product) continue;
          const productId = String(product.id); const stock = Number(stockRow.stock || 0); const value = stock * Number(product.cost || 0);
          const cyclic = cyclicSampled.has(`${store.id}|${productId}`); const audit = auditSampled.has(`${store.id}|${productId}`);
          master.push({ store: store.name, store_id: store.id, sku, description: product.description, unit: product.unit, rotation: rotationBySku.get(norm(sku)) || "SIN ROTACION", stock, cost: Number(product.cost || 0), value, sampled_cyclic: cyclic ? "SI" : "NO", sampled_audit: audit ? "SI" : "NO", sampled: cyclic || audit ? "SI" : "NO" });
        }
      }
      master.sort((a, b) => b.value - a.value || a.store.localeCompare(b.store));
      const summaryMap = new Map<string, CoverageRow>();
      for (const row of master) { const key = `${row.store_id}|${row.rotation}`; const current = summaryMap.get(key) || { store_id: row.store_id, store: row.store, rotation: row.rotation, total: 0, sampled: 0, unsampled: 0, pct: 0 }; current.total += 1; if (row.sampled === "SI") current.sampled += 1; else current.unsampled += 1; current.pct = current.total ? current.sampled / current.total * 100 : 0; summaryMap.set(key, current); }
      const detailSummary = [...summaryMap.values()];
      const storeMap = new Map<string, CoverageRow>();
      for (const row of detailSummary) { const current = storeMap.get(row.store_id) || { store_id: row.store_id, store: row.store, rotation: "Todas", total: 0, sampled: 0, unsampled: 0, pct: 0 }; current.total += row.total; current.sampled += row.sampled; current.unsampled += row.unsampled; current.pct = current.total ? current.sampled / current.total * 100 : 0; storeMap.set(row.store_id, current); }
      setRows(master); setSummaryRows(detailSummary); setCoverage([...storeMap.values()].sort((a, b) => b.pct - a.pct));
      setMessage(`${master.length.toLocaleString("es-PE")} productos analizados.`);
    } catch (error: any) { setMessage(`Error generando análisis: ${error.message || error}`); } finally { setLoading(false); }
  }

  async function downloadExcel() {
    setLoading(true); setMessage("Preparando Excel en el servidor...");
    try {
      const response = await fetch("/api/analisis/maestro-excel", { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || `Error ${response.status}`);
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `maestro_muestreo_${new Date().toISOString().slice(0, 10)}.xlsx`; link.click(); URL.revokeObjectURL(url); setMessage("Excel descargado.");
    } catch (error: any) { setMessage(`Error descargando Excel: ${error.message || error}`); } finally { setLoading(false); }
  }

  if (!ready) return <div className="p-8 text-center font-bold text-slate-400">Cargando...</div>;
  return <div className="p-4 md:p-8"><div className="mx-auto max-w-7xl space-y-4"><div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-white p-4"><div><h2 className="text-2xl font-black">Cobertura y maestro de muestreo</h2><p className="text-sm font-semibold text-slate-500">La cobertura se actualiza automáticamente; el Excel se prepara en el servidor.</p></div><div className="flex flex-wrap gap-2"><button onClick={() => void loadCoverageOnly()} disabled={loading} className="flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-3 text-sm font-black text-white disabled:opacity-40">{loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />} Actualizar cobertura</button><button onClick={() => void downloadExcel()} disabled={loading} className="flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40"><Download size={16} /> Descargar Excel</button></div></div>{message && <p className="rounded-xl bg-blue-50 p-3 text-sm font-bold text-blue-800">{message}</p>}<div className="rounded-2xl border bg-white p-4"><h3 className="mb-3 font-black">% de códigos muestreados por tienda</h3><div className="space-y-3">{coverage.map(row => <div key={`${row.store_id}-${row.total}`} className="grid grid-cols-[minmax(180px,260px)_1fr_90px] items-center gap-3 text-sm"><span className="truncate font-black">{row.store}</span><div className="h-7 overflow-hidden rounded-lg bg-slate-100"><div className="h-full rounded-lg bg-blue-600" style={{ width: `${Math.min(100, row.pct)}%` }} /></div><span className="text-right font-black">{row.pct.toFixed(2)}%</span></div>)}{!coverage.length && <p className="py-10 text-center font-bold text-slate-400">Calculando cobertura...</p>}</div></div></div></div>;
}
