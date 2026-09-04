"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { readStoredUser } from "@/lib/singleDeviceSession";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

type BonusRow = {
  store: Store;
  sales: number;
  quarterSales: number;
  auditEri: number | null;
  generalEri: number | null;
  netDiff: number | null;
  inventorySales: number | null;
  inventoryDeviation: number | null;
  receptionEligible: number;
  receptionReceived: number;
  receptionPct: number | null;
  lossValue: number;
  lossLimit: number;
  lossPct: number | null;
  xdCurrent: number | null;
  xdPrevious: number | null;
  xdReduction: number | null;
};

const monthEnd = (month: string) => `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()}`;
const monthStart = (month: string) => `${month}-01`;
const previousMonth = (month: string) => {
  const date = new Date(`${month}-01T12:00:00`);
  date.setMonth(date.getMonth() - 1);
  return date.toISOString().slice(0, 7);
};
const quarterStart = (date: string) => {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
};
const nextMonthStart = (month: string) => {
  const date = new Date(`${month}-01T12:00:00`);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
};
const money = (value: number | null | undefined) => new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 }).format(Number(value || 0));
const pct = (value: number | null | undefined) => value === null || value === undefined ? "Sin dato" : `${Number(value).toFixed(2)}%`;

function isLima(store: Store) {
  return /\bLIM\b|CALLAO|HUACHIPA|HUAROCHIRI|LURIN|VILLA EL SALVADOR|PUENTE PIEDRA|CHORILLOS|SURQUILLO|NARANJAL|ARRIOLA|PERLA|GRUPO|SUMINISTRO|CORPORATIVO/i.test(`${store.name} ${store.erp_sede || ""}`);
}

function paymentTier(sales: number, monthly: boolean, compliance: number) {
  const full = sales >= 1_000_000 ? (monthly ? 400 : 600)
    : sales >= 700_000 ? (monthly ? 300 : 400)
      : sales >= 300_000 ? (monthly ? 200 : 300)
        : sales >= 150_000 ? (monthly ? 100 : 200) : 0;
  if (!monthly) return compliance >= 100 ? full : 0;
  return compliance >= 90 ? full : compliance >= 85 ? full / 2 : 0;
}

function normalizeRotationStoreKey(value: string | null | undefined) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function rotationStoreKeysForStore(store: Store) {
  const aliases = ["ARBOLEDA", "CALLAO", "GRUPO", "LURIN", "PIURA", "TRUJILLO", "LEGUIA", "CHORILLOS", "AREQUIPA NEW K 21", "VILLA EL SALVADOR", "SUMINISTRO", "DIAMANTE", "HUANCAYO", "NARANJAL", "PTE PIEDRA", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA", "HUAROCHIRI", "HUACHIPA", "AREQUIPA MIRAFLORES", "CAJAMARCA", "CD"];
  const keys = new Set<string>();
  for (const source of [store.name, store.erp_sede, store.code].filter(Boolean) as string[]) {
    const raw = String(source).trim().toUpperCase();
    const lastHyphen = raw.lastIndexOf("-");
    const erpKey = (lastHyphen >= 0 ? raw.slice(lastHyphen + 1) : raw).trim();
    if (erpKey) keys.add(erpKey);
    const normalized = normalizeRotationStoreKey(source);
    if (!normalized) continue;
    keys.add(normalized);
    for (const alias of aliases) if (normalized.includes(normalizeRotationStoreKey(alias))) keys.add(normalizeRotationStoreKey(alias));
    if (normalized.includes("EVITAMIENTO")) keys.add("AREQUIPA NEW K 21");
    if (normalized.includes("ARE MIRAFLORES") || normalized.includes("MIRAFLORES")) keys.add("AREQUIPA MIRAFLORES");
    if (normalized.includes("CHORILLOS") || normalized.includes("CHORRILLOS")) keys.add("CHORILLOS");
    if (normalized.includes("PTE PIEDRA") || normalized.includes("PUENTE PIEDRA")) keys.add("PTE PIEDRA");
    if (normalized.includes("CENTRO DISTRIBUCION") || normalized === "CD GPC" || normalized.endsWith(" CD")) keys.add("CD");
  }
  return [...keys];
}

async function pages<T>(factory: (from: number, to: number) => any) {
  const output: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await factory(from, from + 999);
    if (error) throw error;
    const batch = (data || []) as T[];
    output.push(...batch);
    if (batch.length < 1000) return output;
  }
}

async function pagesIn<T>(table: string, select: string, column: string, values: string[]) {
  const output: T[] = [];
  for (let index = 0; index < values.length; index += 100) {
    const chunk = values.slice(index, index + 100);
    output.push(...await pages<T>((from, to) => supabase.from(table).select(select).in(column, chunk).range(from, to)));
  }
  return output;
}

export default function BonusModule() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [monthlyCut, setMonthlyCut] = useState("2026-08");
  const [quarterCut, setQuarterCut] = useState("2026-09-30");
  const [rows, setRows] = useState<BonusRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const current = readStoredUser<CyclicUser>();
    if (!current || !canAccessModule(current, "analysis")) { window.location.replace("/"); return; }
    setUser(current);
    void supabase.from("stores").select("id,code,name,erp_sede,is_active").eq("is_active", true).order("name")
      .then(({ data, error }) => {
        if (error) return toast.error(`No se pudieron cargar las tiendas: ${error.message}`);
        setStores(((data || []) as Store[]).filter(store => /^GPC\d+/i.test(store.name)));
      });
  }, []);

  const load = useCallback(async () => {
    if (!monthlyCut || !/^\d{4}-\d{2}$/.test(monthlyCut) || !/^\d{4}-\d{2}-\d{2}$/.test(quarterCut)) {
      toast.error("Selecciona cortes válidos."); return;
    }
    setLoading(true);
    try {
      const monthlyFrom = monthStart(monthlyCut);
      const monthlyTo = monthEnd(monthlyCut);
      const quarterlyFrom = quarterStart(quarterCut);
      const previous = previousMonth(monthlyCut);
      const previousTo = monthEnd(previous);
      const storeById = new Map(stores.map(store => [store.id, store]));
      const storeByCode = new Map(stores.map(store => [String(store.code || "").trim(), store]));

      const [salesRows, receptionRows, diffRows, rotationRows, auditSessions, generalResponse] = await Promise.all([
        pages<any>((from, to) => supabase.from("erp_store_sales_daily").select("store_name,sales_amount,sales_date").gte("sales_date", quarterlyFrom).lte("sales_date", quarterCut).range(from, to)),
        pages<any>((from, to) => supabase.from("reception_requests").select("id,destination_store_code,creation_date,erp_status").gte("creation_date", `${monthlyFrom}T00:00:00-05:00`).lt("creation_date", `${nextMonthStart(monthlyCut)}T00:00:00-05:00`).range(from, to)),
        pages<any>((from, to) => supabase.from("reception_difference_reports").select("request_id,product_code,qty,kind,created_at").gte("created_at", `${monthlyFrom}T00:00:00-05:00`).lt("created_at", `${nextMonthStart(monthlyCut)}T00:00:00-05:00`).range(from, to)),
        pages<any>((from, to) => supabase.from("inventory_rotation_valuation_daily").select("snapshot_date,store_key,rotation_category,inventory_value").gte("snapshot_date", previous).lte("snapshot_date", monthlyTo).in("rotation_category", ["X", "D"]).range(from, to)),
        pages<any>((from, to) => supabase.from("audit_sessions").select("id,store_id,finished_at").eq("status", "finished").lte("finished_at", `${quarterCut}T23:59:59-05:00`).order("finished_at", { ascending: false }).range(from, to)),
        supabase.rpc("get_finished_general_inventory_report", { p_date_from: "2026-01-01", p_date_to: quarterCut }),
      ]);
      if (generalResponse.error) throw generalResponse.error;

      const salesByStore = new Map<string, number>();
      const quarterSalesByStore = new Map<string, number>();
      for (const row of salesRows) {
        const key = String(row.store_name || "");
        quarterSalesByStore.set(key, (quarterSalesByStore.get(key) || 0) + Number(row.sales_amount || 0));
        if (String(row.sales_date || "") >= monthlyFrom && String(row.sales_date || "") <= monthlyTo) salesByStore.set(key, (salesByStore.get(key) || 0) + Number(row.sales_amount || 0));
      }

      const latestAuditByStore = new Map<string, string>();
      for (const session of auditSessions) if (!latestAuditByStore.has(String(session.store_id))) latestAuditByStore.set(String(session.store_id), String(session.id));
      const auditIds = [...latestAuditByStore.values()];
      const [auditItems, auditCounts] = await Promise.all([
        pagesIn<any>("audit_session_items", "id,session_id,system_stock", "session_id", auditIds),
        pagesIn<any>("audit_counts", "item_id,quantity", "session_id", auditIds),
      ]);
      const auditCountByItem = new Map<string, number>();
      for (const row of auditCounts) auditCountByItem.set(String(row.item_id), (auditCountByItem.get(String(row.item_id)) || 0) + Number(row.quantity || 0));
      const auditStoreBySession = new Map([...latestAuditByStore.entries()].map(([storeId, sessionId]) => [sessionId, storeId]));
      const auditStats = new Map<string, { counted: number; ok: number }>();
      for (const item of auditItems) {
        const storeId = auditStoreBySession.get(String(item.session_id));
        if (!storeId || !auditCountByItem.has(String(item.id))) continue;
        const current = auditStats.get(storeId) || { counted: 0, ok: 0 };
        current.counted += 1;
        if (Number(auditCountByItem.get(String(item.id))) === Number(item.system_stock || 0)) current.ok += 1;
        auditStats.set(storeId, current);
      }

      const latestGeneral = new Map<string, any>();
      for (const row of (generalResponse.data || []) as any[]) {
        const current = latestGeneral.get(String(row.store_id));
        if (!current || String(row.finished_at || "") > String(current.finished_at || "")) latestGeneral.set(String(row.store_id), row);
      }

      const requestStore = new Map<string, string>();
      for (const row of receptionRows) requestStore.set(String(row.id || ""), String(row.destination_store_code || ""));
      const reception = new Map<string, { eligible: number; received: number }>();
      for (const row of receptionRows) {
        const store = storeByCode.get(String(row.destination_store_code || ""));
        if (!store) continue;
        const age = Math.floor((new Date(`${monthlyTo}T23:59:59-05:00`).getTime() - new Date(row.creation_date).getTime()) / 86_400_000);
        if (age <= (isLima(store) ? 2 : 5)) continue;
        const current = reception.get(store.id) || { eligible: 0, received: 0 };
        current.eligible += 1;
        if (String(row.erp_status || "").toUpperCase() === "V") current.received += 1;
        reception.set(store.id, current);
      }
      const lossCodes = [...new Set(diffRows.filter(row => ["merma", "desmedro"].includes(String(row.kind || "").toLowerCase())).map(row => String(row.product_code || "").trim().toUpperCase()).filter(Boolean))];
      const costs = await pagesIn<any>("cyclic_products", "sku,cost", "sku", lossCodes);
      const costBySku = new Map(costs.map(row => [String(row.sku || "").trim().toUpperCase(), Number(String(row.cost || 0).replace(/[^0-9.-]/g, "")) || 0]));
      const losses = new Map<string, number>();
      for (const row of diffRows) {
        if (!["merma", "desmedro"].includes(String(row.kind || "").toLowerCase())) continue;
        const store = storeByCode.get(requestStore.get(String(row.request_id)) || "");
        if (!store) continue;
        const value = Math.abs(Number(row.qty || 0)) * (costBySku.get(String(row.product_code || "").trim().toUpperCase()) || 0);
        losses.set(store.id, (losses.get(store.id) || 0) + value);
      }

      const rotationByStoreMonth = new Map<string, Map<string, number>>();
      for (const row of rotationRows) {
        const key = `${normalizeRotationStoreKey(String(row.store_key))}|${String(row.snapshot_date)}`;
        const current = rotationByStoreMonth.get(key) || new Map<string, number>();
        current.set(String(row.rotation_category), (current.get(String(row.rotation_category)) || 0) + Number(row.inventory_value || 0));
        rotationByStoreMonth.set(key, current);
      }
      const closestRotation = (store: Store, cutoff: string) => {
        const storeKeys = new Set(rotationStoreKeysForStore(store).map(normalizeRotationStoreKey));
        const candidates = [...rotationByStoreMonth.entries()].filter(([key]) => {
          const splitAt = key.lastIndexOf("|");
          return storeKeys.has(key.slice(0, splitAt)) && key.slice(splitAt + 1) <= cutoff;
        }).sort(([a], [b]) => b.localeCompare(a));
        const values = candidates[0]?.[1]; return values ? (values.get("X") || 0) + (values.get("D") || 0) : null;
      };

      setRows(stores.map(store => {
        const audit = auditStats.get(store.id);
        const general = latestGeneral.get(store.id);
        const sales = salesByStore.get(store.name) || 0;
        const quarterSales = quarterSalesByStore.get(store.name) || 0;
        const r = reception.get(store.id) || { eligible: 0, received: 0 };
        const lossValue = losses.get(store.id) || 0;
        const xdCurrent = closestRotation(store, monthlyTo);
        const xdPrevious = closestRotation(store, previousTo);
        return {
          store, sales, quarterSales,
          auditEri: audit && audit.counted > 0 ? (audit.ok / audit.counted) * 100 : null,
          generalEri: general ? Number(general.eri_pct || 0) : null,
          netDiff: general ? Math.abs(Number(general.net_value_diff || 0)) : null,
          inventorySales: general?.sales_in_period == null ? null : Number(general.sales_in_period),
          inventoryDeviation: general?.sales_in_period > 0 ? (Math.abs(Number(general.net_value_diff || 0)) / Number(general.sales_in_period)) * 100 : null,
          receptionEligible: r.eligible, receptionReceived: r.received, receptionPct: r.eligible > 0 ? (r.received / r.eligible) * 100 : null,
          lossValue, lossLimit: sales * 0.005, lossPct: sales > 0 ? (lossValue / sales) * 100 : null,
          xdCurrent, xdPrevious, xdReduction: xdPrevious && xdPrevious > 0 && xdCurrent !== null ? ((xdPrevious - xdCurrent) / xdPrevious) * 100 : null,
        };
      }));
      setLoaded(true);
    } catch (error) {
      toast.error(`No se pudo calcular Bono: ${error instanceof Error ? error.message : "error desconocido"}`);
    } finally { setLoading(false); }
  }, [monthlyCut, quarterCut, stores]);

  const totals = useMemo(() => rows.reduce((acc, row) => {
    const quarterly = paymentTier(row.quarterSales, false, row.auditEri !== null && row.auditEri >= 95 ? 100 : 0)
      + paymentTier(row.quarterSales, false, row.generalEri !== null && row.generalEri > 85 ? 100 : 0)
      + paymentTier(row.quarterSales, false, row.inventoryDeviation !== null && row.inventoryDeviation < 0.5 ? 100 : 0);
    const monthly = paymentTier(row.sales, true, row.receptionPct || 0)
      + paymentTier(row.sales, true, row.lossPct !== null && row.lossPct <= 0.5 ? 100 : 0)
      + paymentTier(row.sales, true, row.xdReduction !== null && row.xdReduction >= 10 ? 100 : 0);
    return { quarterly: acc.quarterly + quarterly, monthly: acc.monthly + monthly };
  }, { quarterly: 0, monthly: 0 }), [rows]);

  async function exportExcel() {
    const XLSX = await import("xlsx");
    const data = rows.map(row => ({
      TIENDA: row.store.name, "VENTA MENSUAL": row.sales, "VENTA TRIMESTRAL": row.quarterSales,
      "ERI ÚLTIMA AUDITORÍA": row.auditEri === null ? "Sin dato" : row.auditEri / 100,
      "ERI ÚLTIMO INVENTARIO": row.generalEri === null ? "Sin dato" : row.generalEri / 100,
      "DIF. NETA INVENTARIO": row.netDiff ?? "Sin dato", "VENTA ENTRE INVENTARIOS": row.inventorySales ?? "Sin dato", "% DIF. / VENTA": row.inventoryDeviation === null ? "Sin dato" : row.inventoryDeviation / 100,
      "RECEPCIONES ELEGIBLES": row.receptionEligible, "RECIBIDAS RMS": row.receptionReceived, "% RECEPCIONES": row.receptionPct === null ? "Sin dato" : row.receptionPct / 100,
      "MERMA Y DESMEDRO": row.lossValue, "LÍMITE 0.5% VENTA": row.lossLimit, "% MERMA / VENTA": row.lossPct === null ? "Sin dato" : row.lossPct / 100,
      "X+D MES ACTUAL": row.xdCurrent ?? "Sin dato", "X+D MES PREVIO": row.xdPrevious ?? "Sin dato", "% REDUCCIÓN X+D": row.xdReduction === null ? "Sin dato" : row.xdReduction / 100,
    }));
    const sheet = XLSX.utils.json_to_sheet(data); sheet["!cols"] = Array.from({ length: 18 }, (_, index) => ({ wch: index === 0 ? 32 : 20 }));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "Bono"); XLSX.writeFile(book, `bono_${monthlyCut}_${quarterCut}.xlsx`);
  }

  if (!user) return <p className="p-8 text-center font-bold text-slate-400">Cargando...</p>;
  return <div className="p-4 md:p-8"><div className="mx-auto max-w-[1600px] space-y-4">
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><p className="text-xs font-black uppercase tracking-wide text-indigo-600">Análisis · Bono</p><h2 className="mt-1 text-2xl font-black">Bono mensual y trimestral</h2><p className="mt-1 text-sm text-slate-500">Los indicadores se calculan desde ventas, Recepción RMS, Auditorías, Inventarios Generales y el histórico de valorizado X/D.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-xs font-black text-slate-600">Corte mensual<input className="mt-1 block rounded-xl border px-3 py-2 text-sm" type="month" value={monthlyCut} onChange={event => setMonthlyCut(event.target.value)} /></label><label className="text-xs font-black text-slate-600">Corte trimestral<input className="mt-1 block rounded-xl border px-3 py-2 text-sm" type="date" value={quarterCut} onChange={event => setQuarterCut(event.target.value)} /></label><button onClick={() => void load()} disabled={loading || stores.length === 0} className="flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-black text-white disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""} />{loading ? "Calculando..." : "Calcular bono"}</button><button onClick={() => void exportExcel()} disabled={!loaded} className="flex items-center gap-2 rounded-xl border border-emerald-600 px-4 py-2.5 text-sm font-black text-emerald-700 disabled:opacity-50"><Download size={16} />Excel</button></div></section>
    {loaded && <><section className="grid gap-3 md:grid-cols-2"><div className="rounded-2xl bg-indigo-700 p-4 text-white"><p className="text-xs font-black uppercase">Bono trimestral estimado</p><p className="mt-1 text-3xl font-black">{money(totals.quarterly)}</p><p className="mt-1 text-xs text-indigo-100">ERI auditoría ≥95%, ERI inventario &gt;85% y diferencia neta &lt;0.5% de ventas entre inventarios.</p></div><div className="rounded-2xl bg-emerald-700 p-4 text-white"><p className="text-xs font-black uppercase">Bono mensual estimado</p><p className="mt-1 text-3xl font-black">{money(totals.monthly)}</p><p className="mt-1 text-xs text-emerald-100">Recepciones RMS, merma/desmedro ≤0.5% de venta y reducción X+D ≥10%.</p></div></section>
    <section className="overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full min-w-[1800px] text-xs"><thead className="bg-slate-950 text-white"><tr><th className="p-3 text-left">Tienda / ventas</th><th className="p-3">Auditoría<br />≥95%</th><th className="p-3">Inv. general<br />&gt;85%</th><th className="p-3">Dif. neta / venta<br />&lt;0.5%</th><th className="p-3">Recepciones RMS<br />2d Lima · 5d provincia</th><th className="p-3">Merma + desmedro<br />≤0.5% venta</th><th className="p-3">Reducción X+D<br />≥10%</th><th className="p-3">Bono trimestral</th><th className="p-3">Bono mensual</th></tr></thead><tbody>{rows.map(row => { const auditOk = row.auditEri !== null && row.auditEri >= 95; const inventoryOk = row.generalEri !== null && row.generalEri > 85; const diffOk = row.inventoryDeviation !== null && row.inventoryDeviation < 0.5; const lossOk = row.lossPct !== null && row.lossPct <= 0.5; const xdOk = row.xdReduction !== null && row.xdReduction >= 10; const quarterly = paymentTier(row.quarterSales, false, auditOk ? 100 : 0) + paymentTier(row.quarterSales, false, inventoryOk ? 100 : 0) + paymentTier(row.quarterSales, false, diffOk ? 100 : 0); const monthly = paymentTier(row.sales, true, row.receptionPct || 0) + paymentTier(row.sales, true, lossOk ? 100 : 0) + paymentTier(row.sales, true, xdOk ? 100 : 0); const cell = (ok: boolean | null, text: string) => <td className={`p-3 text-center font-bold ${ok === null ? "text-slate-400" : ok ? "text-emerald-700" : "text-red-600"}`}>{text}<br /><span className="text-[10px]">{ok === null ? "Sin dato" : ok ? "Cumple" : "No cumple"}</span></td>; return <tr key={row.store.id} className="border-t"><td className="p-3 font-bold">{row.store.name}<br /><span className="font-normal text-slate-500">Mes: {money(row.sales)} · Trimestre: {money(row.quarterSales)}</span></td>{cell(row.auditEri === null ? null : auditOk, pct(row.auditEri))}{cell(row.generalEri === null ? null : inventoryOk, pct(row.generalEri))}{cell(row.inventoryDeviation === null ? null : diffOk, `${pct(row.inventoryDeviation)} · ${money(row.netDiff)}`)}{cell(row.receptionPct === null ? null : row.receptionPct >= 85, `${row.receptionReceived}/${row.receptionEligible} · ${pct(row.receptionPct)}`)}{cell(row.lossPct === null ? null : lossOk, `${money(row.lossValue)} / ${money(row.lossLimit)}`)}{cell(row.xdReduction === null ? null : xdOk, `${pct(row.xdReduction)} · ${money(row.xdCurrent)}`)}<td className="p-3 text-center font-black text-indigo-700">{money(quarterly)}</td><td className="p-3 text-center font-black text-emerald-700">{money(monthly)}</td></tr>; })}</tbody></table></section></>}
  </div></div>;
}
