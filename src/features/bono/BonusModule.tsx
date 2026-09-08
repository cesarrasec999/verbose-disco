"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { readStoredUser } from "@/lib/singleDeviceSession";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

type MonthlyRow = { store: Store; sales: number; target: number | null; targetPct: number | null; received: number; eligible: number; receptionPct: number | null; loss: number; lossPct: number | null; xdNow: number | null; xdBefore: number | null; xdPct: number | null };
type LossDetail = { store: string; source: string; movementDate: string; documentNo: string; reason: string; productCode: string; description: string; quantity: number; value: number };
type QuarterlyRow = { store: Store; sales: number; audit: number | null; inventory: number | null; diff: number | null; monthlySales: number | null; diffPct: number | null };
const PAGE = 1000;
const money = (v: number | null | undefined) => new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN", maximumFractionDigits: 2 }).format(Number(v || 0));
const pct = (v: number | null | undefined) => v == null ? "Sin dato" : Number(v).toFixed(2) + "%";
const start = (month: string) => month + "-01";
const end = (month: string) => { const [y, m] = month.split("-").map(Number); return month + "-" + String(new Date(y, m, 0).getDate()).padStart(2, "0"); };
const prev = (month: string) => { const [y, m] = month.split("-").map(Number); return new Date(y, m - 2, 1).toISOString().slice(0, 7); };
const next = (month: string) => { const [y, m] = month.split("-").map(Number); return new Date(y, m, 1).toISOString().slice(0, 10); };
const quarterStart = (date: string) => date.slice(0, 4) + "-" + String(Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0") + "-01";
const normal = (v: unknown) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const message = (e: unknown) => e instanceof Error ? e.message : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Error desconocido";
// Variación estándar: actual menos anterior. Una reducción queda negativa,
// igual que una salida de dinero o stock en los demás reportes.
const xdText = (value: number | null) => value === null ? "Sin dato" : value <= 0 ? "Disminuyó " + value.toFixed(2) + "%" : "Aumentó +" + value.toFixed(2) + "%";
const xdValueText = (current: number | null, previous: number | null) => current === null || previous === null
  ? "Sin dato"
  : current <= previous ? "Disminuyó " + money(previous - current) : "Aumentó " + money(current - previous);

async function paged<T>(query: (from: number, to: number) => any) {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data || []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

function eligible(store: Store) {
  const t = normal(String(store.name || "") + " " + String(store.erp_sede || ""));
  return /^GPC[0-9]+/i.test(String(store.name || "")) && !/(CD GPC|TIENDA VIRTUAL|VIRTUAL|CORPORATIVO|DISCREPANCIAS)/.test(t);
}
function isLima(store: Store) { return /\bLIM\b|CALLAO|HUACHIPA|HUAROCHIRI|LURIN|VILLA EL SALVADOR|PUENTE PIEDRA|CHORILLOS|SURQUILLO|NARANJAL|ARRIOLA|PERLA|GRUPO|SUMINISTRO/i.test(String(store.name || "") + " " + String(store.erp_sede || "")); }
// erp_movements identifica las sedes con 1000 + número ERP. Los cuatro
// cruces están confirmados contra RMS y son los mismos usados por Kardex.
const GPC_STORE_NUMBER_OVERRIDES: Record<number, number> = { 2: 4, 3: 5, 4: 2, 5: 3 };
function erpMovementStoreCode(store: Store) {
  const label = String(store.erp_sede || store.name || "");
  if (/CD-GPC|CENTRO DISTRIBUCION/i.test(label)) return "1000";
  const match = label.match(/^GPC0*(\d+)/i);
  if (!match) return null;
  const number = Number(match[1]);
  return String(1000 + (GPC_STORE_NUMBER_OVERRIDES[number] ?? number));
}
function keys(store: Store) {
  const result = new Set<string>();
  for (const source of [store.code, store.name, store.erp_sede].filter(Boolean) as string[]) {
    const text = String(source).trim();
    result.add(normal(text));
    result.add(normal(text.slice(text.lastIndexOf("-") + 1)));
  }
  const erpCode = erpMovementStoreCode(store);
  if (erpCode) result.add(normal(erpCode));
  const text = normal(store.name);
  for (const alias of ["CALLAO", "GRUPO", "LURIN", "PIURA", "TRUJILLO", "CHORILLOS", "VILLA EL SALVADOR", "SUMINISTRO", "HUANCAYO", "NARANJAL", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA", "HUACHIPA", "CAJAMARCA"]) if (text.includes(normal(alias))) result.add(normal(alias));
  return result;
}
function mapping(stores: Store[]) {
  const map = new Map<string, Store>();
  for (const store of stores) for (const key of keys(store)) map.set(key, store);
  return (value: unknown) => map.get(normal(value));
}
function tier(sales: number, monthly: boolean, percentage: number) {
  const full = sales >= 1000000 ? (monthly ? 400 : 600) : sales >= 700000 ? (monthly ? 300 : 400) : sales >= 300000 ? (monthly ? 200 : 300) : sales >= 150000 ? (monthly ? 100 : 200) : 0;
  return monthly ? percentage >= 90 ? full : percentage >= 85 ? full / 2 : 0 : percentage >= 100 ? full : 0;
}
function monthlyReward(row: MonthlyRow) {
  // La meta RMS es la puerta de entrada al bono: sin meta cargada o con
  // cumplimiento menor a 100%, no se comisiona ningún indicador mensual.
  if (row.targetPct === null || row.targetPct < 100) return 0;
  return tier(row.sales, true, row.receptionPct || 0)
    + tier(row.sales, true, row.lossPct != null && row.lossPct <= 0.5 ? 100 : 0)
    + tier(row.sales, true, row.xdPct != null && row.xdPct <= -10 ? 100 : 0);
}
function excel(name: string, sheets: { name: string; rows: Record<string, unknown>[] }[]) {
  void import("xlsx").then(XLSX => {
    const book = XLSX.utils.book_new();
    for (const source of sheets) {
      const rows = source.rows.length ? source.rows : [{ "Sin registros": "No hay movimientos para el período calculado." }];
      const sheet = XLSX.utils.json_to_sheet(rows);
      sheet["!cols"] = Object.keys(rows[0]).map((key, index) => ({ wch: Math.min(42, Math.max(index ? 15 : 26, key.length + 3)) }));
      XLSX.utils.book_append_sheet(book, sheet, source.name);
    }
    XLSX.writeFile(book, name);
  });
}

export default function BonusModule() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [month, setMonth] = useState("2026-08");
  const [quarter, setQuarter] = useState("2026-09-30");
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [lossDetails, setLossDetails] = useState<LossDetail[]>([]);
  const [quarterly, setQuarterly] = useState<QuarterlyRow[]>([]);
  const [loadingMonthly, setLoadingMonthly] = useState(false);
  const [loadingQuarterly, setLoadingQuarterly] = useState(false);

  useEffect(() => {
    const current = readStoredUser<CyclicUser>();
    if (!current || !canAccessModule(current, "analysis")) { window.location.replace("/"); return; }
    setUser(current);
    void supabase.from("stores").select("id,code,name,erp_sede,is_active").eq("is_active", true).order("name").then(({ data, error }) => error ? toast.error("No se pudieron cargar las tiendas: " + error.message) : setStores(((data || []) as Store[]).filter(eligible)));
  }, []);

  const calculateMonthly = useCallback(async () => {
    if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) { toast.error("Selecciona un mes válido."); return; }
    setLoadingMonthly(true);
    try {
      const from = start(month), until = end(month), before = prev(month), store = mapping(stores);
      const [salesRows, targetRows, receptionRows, adjustments, transfers, rotations] = await Promise.all([
        paged<any>((a, b) => supabase.from("erp_store_sales_daily").select("store_key,store_name,sales_amount").gte("sales_date", from).lte("sales_date", until).range(a, b)),
        paged<any>((a, b) => supabase.from("erp_store_sales_targets").select("store_key,target_amount").eq("target_month", from).range(a, b)),
        paged<any>((a, b) => supabase.from("reception_requests").select("destination_store_code,creation_date,erp_status").gte("creation_date", from + "T00:00:00-05:00").lt("creation_date", next(month) + "T00:00:00-05:00").range(a, b)),
        // La regla del bono usa exclusivamente los dos motivos RMS confirmados:
        // ajuste de cantidad 15. DESMEDROS y salida por transferencia DESMEDROS.
        paged<any>((a, b) => supabase.from("erp_movements").select("store_code,movement_date,document_no,reason,product_code,description,quantity,value_total").eq("source_type", "ADJUSTMENT").eq("reason", "15. DESMEDROS").gte("movement_date", from + "T00:00:00-05:00").lt("movement_date", next(month) + "T00:00:00-05:00").range(a, b)),
        paged<any>((a, b) => supabase.from("erp_movements").select("store_code,movement_date,document_no,reason,product_code,description,quantity,value_total").eq("source_type", "SLIP_OUT").eq("reason", "DESMEDROS").gte("movement_date", from + "T00:00:00-05:00").lt("movement_date", next(month) + "T00:00:00-05:00").range(a, b)),
        paged<any>((a, b) => supabase.from("product_rotation_monthly").select("store_key,product_code").lte("period_month", from).in("rotation_category", ["X", "D"]).order("period_month", { ascending: false }).range(a, b)),
      ]);
      const sales = new Map<string, number>(), targets = new Map<string, number>(), loss = new Map<string, number>(), reception = new Map<string, { received: number; eligible: number }>();
      for (const row of salesRows) { const s = store(row.store_key || row.store_name); if (s) sales.set(s.id, (sales.get(s.id) || 0) + Number(row.sales_amount || 0)); }
      for (const row of targetRows) { const s = store(row.store_key); if (s) targets.set(s.id, Number(row.target_amount || 0)); }
      for (const row of [...adjustments, ...transfers]) { const s = store(row.store_code); if (s) loss.set(s.id, (loss.get(s.id) || 0) + Math.abs(Number(row.value_total || 0))); }
      setLossDetails([
        ...adjustments.map(row => ({ row, source: "Ajuste de cantidad" })),
        ...transfers.map(row => ({ row, source: "Salida por transferencia" })),
      ].flatMap(({ row, source }) => {
        const s = store(row.store_code);
        return s ? [{ store: s.name, source, movementDate: String(row.movement_date || ""), documentNo: String(row.document_no || ""), reason: String(row.reason || ""), productCode: String(row.product_code || ""), description: String(row.description || ""), quantity: Number(row.quantity || 0), value: Math.abs(Number(row.value_total || 0)) }] : [];
      }));
      for (const row of receptionRows) {
        const s = store(row.destination_store_code); if (!s) continue;
        const age = Math.floor((new Date(until + "T23:59:59-05:00").getTime() - new Date(row.creation_date).getTime()) / 86400000);
        if (age <= (isLima(s) ? 2 : 5)) continue;
        const current = reception.get(s.id) || { eligible: 0, received: 0 };
        current.eligible += 1; if (String(row.erp_status || "").toUpperCase() === "V") current.received += 1; reception.set(s.id, current);
      }
      const xd = new Set<string>();
      for (const row of rotations) { const s = store(row.store_key); if (s) xd.add(s.id + "|" + String(row.product_code || "").trim().toUpperCase()); }
      const snapshotDate = async (cutoff: string) => { const { data, error } = await supabase.from("inventory_valuation_snapshots").select("snapshot_date").lte("snapshot_date", cutoff).order("snapshot_date", { ascending: false }).order("snapshot_time", { ascending: false }).limit(1); if (error) throw error; return data?.[0]?.snapshot_date ? String(data[0].snapshot_date) : null; };
      const valueAt = async (date: string | null) => {
        if (!date) return null;
        const rows = await paged<any>((a, b) => supabase.from("inventory_valuation_snapshot_products").select("store_id,store_key,product_code,inventory_value").eq("snapshot_date", date).gt("inventory_value", 0).range(a, b));
        const values = new Map<string, number>();
        for (const row of rows) { const s = row.store_id ? stores.find(x => x.id === String(row.store_id)) : store(row.store_key); if (s && xd.has(s.id + "|" + String(row.product_code || "").trim().toUpperCase())) values.set(s.id, (values.get(s.id) || 0) + Number(row.inventory_value || 0)); }
        return values;
      };
      const [oldDate, newDate] = await Promise.all([snapshotDate(end(before)), snapshotDate(until)]);
      const [oldValues, newValues] = await Promise.all([valueAt(oldDate), valueAt(newDate)]);
      setMonthly(stores.map(s => { const r = reception.get(s.id) || { eligible: 0, received: 0 }; const sale = sales.get(s.id) || 0, goal = targets.get(s.id) ?? null, beforeValue = oldValues?.get(s.id) ?? null, currentValue = newValues?.get(s.id) ?? null, lost = loss.get(s.id) || 0; return { store: s, sales: sale, target: goal, targetPct: goal && goal > 0 ? sale / goal * 100 : null, received: r.received, eligible: r.eligible, receptionPct: r.eligible ? r.received / r.eligible * 100 : null, loss: lost, lossPct: sale ? lost / sale * 100 : null, xdNow: currentValue, xdBefore: beforeValue, xdPct: beforeValue && beforeValue > 0 && currentValue != null ? (currentValue - beforeValue) / beforeValue * 100 : null }; }));
    } catch (error) { toast.error("No se pudo calcular Bono mensual: " + message(error)); } finally { setLoadingMonthly(false); }
  }, [month, stores]);

  const calculateQuarterly = useCallback(async () => {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(quarter)) { toast.error("Selecciona una fecha válida."); return; }
    setLoadingQuarterly(true);
    try {
      const store = mapping(stores);
      const [sessions, auditSessions, salesRows] = await Promise.all([
        paged<any>((a, b) => supabase.from("general_inventory_sessions").select("id,store_id,finished_at").eq("status", "finished").lte("finished_at", quarter + "T23:59:59-05:00").order("finished_at", { ascending: false }).range(a, b)),
        paged<any>((a, b) => supabase.from("audit_sessions").select("id,store_id,finished_at").eq("status", "finished").lte("finished_at", quarter + "T23:59:59-05:00").order("finished_at", { ascending: false }).range(a, b)),
        paged<any>((a, b) => supabase.from("erp_store_sales_daily").select("store_key,store_name,sales_amount").gte("sales_date", quarterStart(quarter)).lte("sales_date", quarter).range(a, b)),
      ]);
      const latestSession = new Map<string, any>(), latestAudit = new Map<string, string>();
      for (const row of sessions) if (!latestSession.has(String(row.store_id))) latestSession.set(String(row.store_id), row);
      for (const row of auditSessions) if (!latestAudit.has(String(row.store_id))) latestAudit.set(String(row.store_id), String(row.id));
      const inventoryRows: any[] = [];
      for (const day of [...new Set([...latestSession.values()].map(x => String(x.finished_at || "").slice(0, 10)).filter(Boolean))]) { const { data, error } = await supabase.rpc("get_finished_general_inventory_report", { p_date_from: day, p_date_to: day }); if (error) throw error; inventoryRows.push(...(data || [])); }
      const inventory = new Map<string, any>();
      for (const row of inventoryRows) { const old = inventory.get(String(row.store_id)); if (!old || String(row.finished_at || "") > String(old.finished_at || "")) inventory.set(String(row.store_id), row); }
      const ids = [...latestAudit.values()], itemRows: any[] = [], countRows: any[] = [];
      for (let i = 0; i < ids.length; i += 100) { const list = ids.slice(i, i + 100); itemRows.push(...await paged<any>((a, b) => supabase.from("audit_session_items").select("id,session_id,system_stock").in("session_id", list).range(a, b))); countRows.push(...await paged<any>((a, b) => supabase.from("audit_counts").select("item_id,quantity").in("session_id", list).range(a, b))); }
      const count = new Map<string, number>(), auditStore = new Map([...latestAudit.entries()].map(([id, sid]) => [sid, id])), audit = new Map<string, { all: number; ok: number }>();
      for (const row of countRows) count.set(String(row.item_id), (count.get(String(row.item_id)) || 0) + Number(row.quantity || 0));
      for (const row of itemRows) { const id = auditStore.get(String(row.session_id)); if (!id || !count.has(String(row.id))) continue; const value = audit.get(id) || { all: 0, ok: 0 }; value.all += 1; if (Number(count.get(String(row.id))) === Number(row.system_stock || 0)) value.ok += 1; audit.set(id, value); }
      const sales = new Map<string, number>();
      for (const row of salesRows) { const s = store(row.store_key || row.store_name); if (s) sales.set(s.id, (sales.get(s.id) || 0) + Number(row.sales_amount || 0)); }
      const periods = [...new Set([...inventory.values()].map(row => String(row.finished_at || "").slice(0, 7)).filter(Boolean))], monthlySales = new Map<string, number>();
      for (const period of periods) for (const row of await paged<any>((a, b) => supabase.from("erp_store_sales_daily").select("store_key,store_name,sales_amount").gte("sales_date", start(period)).lte("sales_date", end(period)).range(a, b))) { const s = store(row.store_key || row.store_name); if (s) monthlySales.set(s.id + "|" + period, (monthlySales.get(s.id + "|" + period) || 0) + Number(row.sales_amount || 0)); }
      setQuarterly(stores.map(s => { const inv = inventory.get(s.id), au = audit.get(s.id), saleMonth = inv ? monthlySales.get(s.id + "|" + String(inv.finished_at || "").slice(0, 7)) || 0 : null; const difference = inv ? Math.abs(Number(inv.net_value_diff || 0)) : null; return { store: s, sales: sales.get(s.id) || 0, audit: au && au.all ? au.ok / au.all * 100 : null, inventory: inv ? Number(inv.eri_pct || 0) : null, diff: difference, monthlySales: saleMonth, diffPct: difference != null && saleMonth && saleMonth > 0 ? difference / saleMonth * 100 : null }; }));
    } catch (error) { toast.error("No se pudo calcular Bono trimestral: " + message(error)); } finally { setLoadingQuarterly(false); }
  }, [quarter, stores]);

  const monthlyTotal = useMemo(() => monthly.reduce((sum, row) => sum + monthlyReward(row), 0), [monthly]);
  const quarterlyTotal = useMemo(() => quarterly.reduce((sum, row) => sum + tier(row.sales, false, row.audit != null && row.audit >= 95 ? 100 : 0) + tier(row.sales, false, row.inventory != null && row.inventory > 85 ? 100 : 0) + tier(row.sales, false, row.diffPct != null && row.diffPct < 0.5 ? 100 : 0), 0), [quarterly]);
  const exportMonthly = () => excel("bono_mensual_" + month + ".xlsx", [
    {
      name: "Resumen",
      rows: monthly.map(x => ({
        TIENDA: x.store.name,
        VENTA: x.sales,
        "META VENTAS RMS": x.target ?? "Sin dato",
        "% META RMS": x.targetPct == null ? "Sin dato" : x.targetPct / 100,
        "ESTADO META": x.targetPct == null ? "Meta pendiente RMS" : x.targetPct >= 100 ? "Habilita bono" : "No comisiona",
        "RECEPCIONES RECIBIDAS": x.received,
        "RECEPCIONES EXIGIBLES": x.eligible,
        "% RECEPCIONES": x.receptionPct == null ? "Sin dato" : x.receptionPct / 100,
        DESMEDRO: x.loss,
        "% DESMEDRO": x.lossPct == null ? "Sin dato" : x.lossPct / 100,
        "X+D MES ANTERIOR": x.xdBefore ?? "Sin dato",
        "X+D MES ACTUAL": x.xdNow ?? "Sin dato",
        "% VARIACION X+D": x.xdPct == null ? "Sin dato" : x.xdPct / 100,
        "BONO ESTIMADO": monthlyReward(x),
      })),
    },
    {
      name: "Detalle",
      rows: lossDetails.map(x => ({
        TIENDA: x.store,
        TIPO: x.source,
        "FECHA Y HORA": x.movementDate,
        DOCUMENTO: x.documentNo,
        MOTIVO: x.reason,
        CODIGO: x.productCode,
        DESCRIPCION: x.description,
        CANTIDAD: x.quantity,
        VALOR: x.value,
      })),
    },
  ]);
  if (!user) return <p className="p-8 text-center font-bold text-slate-400">Cargando...</p>;
  const state = (ok: boolean | null) => ok == null ? "text-slate-400" : ok ? "text-emerald-700" : "text-red-600";
  return <div className="p-4 md:p-8"><div className="mx-auto max-w-[1600px] space-y-6">
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><p className="text-xs font-black uppercase tracking-wide text-indigo-600">Análisis · Bono</p><h2 className="mt-1 text-2xl font-black">Bono mensual y bono trimestral</h2><p className="mt-1 text-sm text-slate-500">Son consultas independientes: calcular una no carga fuentes de la otra.</p></section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><div className="flex flex-wrap items-end gap-3"><div className="mr-auto"><p className="text-xs font-black uppercase text-emerald-700">Bono mensual</p><h3 className="text-xl font-black">Corte mensual</h3></div><label className="text-xs font-black">Mes<input className="mt-1 block rounded-xl border px-3 py-2" type="month" value={month} onChange={e => setMonth(e.target.value)} /></label><button onClick={() => void calculateMonthly()} disabled={loadingMonthly || !stores.length} className="flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 font-black text-white disabled:opacity-50"><RefreshCw size={16} className={loadingMonthly ? "animate-spin" : ""} />{loadingMonthly ? "Calculando..." : "Calcular mensual"}</button>{monthly.length > 0 && <button onClick={exportMonthly} className="flex items-center gap-2 rounded-xl border border-emerald-700 px-4 py-2.5 font-black text-emerald-700"><Download size={16} />Excel</button>}</div>
      {monthly.length > 0 && <><div className="mt-4 rounded-xl bg-emerald-700 p-4 text-white"><p className="text-xs font-black uppercase">Bono mensual estimado</p><p className="text-3xl font-black">{money(monthlyTotal)}</p><p className="text-xs text-emerald-100">La meta RMS es obligatoria: menos de 100% o sin meta cargada = S/ 0.00 de bono.</p></div><div className="mt-4 overflow-x-auto rounded-xl border"><table className="w-full min-w-[1250px] text-xs"><thead className="bg-slate-950 text-white"><tr><th className="p-3 text-left">Tienda / venta</th><th className="p-3">Meta ventas RMS<br />obligatoria</th><th className="p-3">Recepciones</th><th className="p-3">Desmedro ≤0.5%</th><th className="p-3">Variación X+D<br />meta: −10%</th><th className="p-3">Bono</th></tr></thead><tbody>{monthly.map(x => { const meta = x.targetPct != null && x.targetPct >= 100, recep = x.receptionPct != null && x.receptionPct >= 85, loss = x.lossPct != null && x.lossPct <= 0.5, xd = x.xdPct != null && x.xdPct <= -10, reward = monthlyReward(x); return <tr key={x.store.id} className="border-t"><td className="p-3 font-bold">{x.store.name}<br /><span className="font-normal text-slate-500">{money(x.sales)}</span></td><td className={"p-3 text-center font-bold " + state(x.targetPct == null ? null : meta)}>{pct(x.targetPct)}<br />{money(x.target)}<br /><span className="text-[10px]">{x.targetPct == null ? "Meta pendiente RMS" : meta ? "Habilita bono" : "No comisiona"}</span></td><td className={"p-3 text-center font-bold " + state(x.receptionPct == null ? null : recep)}>{x.received}/{x.eligible}<br />{pct(x.receptionPct)}</td><td className={"p-3 text-center font-bold " + state(x.lossPct == null ? null : loss)}>{money(x.loss)}<br />{pct(x.lossPct)}</td><td className={"p-3 text-center font-bold " + state(x.xdPct == null ? null : xd)}>{xdText(x.xdPct)}<br /><span className="font-normal">{xdValueText(x.xdNow, x.xdBefore)}</span></td><td className="p-3 text-center font-black text-emerald-700">{money(reward)}</td></tr>; })}</tbody></table></div></>}
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><div className="flex flex-wrap items-end gap-3"><div className="mr-auto"><p className="text-xs font-black uppercase text-indigo-700">Bono trimestral</p><h3 className="text-xl font-black">Corte trimestral</h3></div><label className="text-xs font-black">Fecha<input className="mt-1 block rounded-xl border px-3 py-2" type="date" value={quarter} onChange={e => setQuarter(e.target.value)} /></label><button onClick={() => void calculateQuarterly()} disabled={loadingQuarterly || !stores.length} className="flex items-center gap-2 rounded-xl bg-indigo-700 px-4 py-2.5 font-black text-white disabled:opacity-50"><RefreshCw size={16} className={loadingQuarterly ? "animate-spin" : ""} />{loadingQuarterly ? "Calculando..." : "Calcular trimestral"}</button>{quarterly.length > 0 && <button onClick={() => excel("bono_trimestral_" + quarter + ".xlsx", [{ name: "Resumen", rows: quarterly.map(x => ({ TIENDA: x.store.name, "VENTA TRIMESTRAL": x.sales, "ERI AUDITORIA": x.audit == null ? "Sin dato" : x.audit / 100, "ERI INVENTARIO": x.inventory == null ? "Sin dato" : x.inventory / 100, "DIFERENCIA NETA": x.diff ?? "Sin dato", "VENTA MENSUAL INVENTARIO": x.monthlySales ?? "Sin dato", "% DIFERENCIA": x.diffPct == null ? "Sin dato" : x.diffPct / 100 })) }])} className="flex items-center gap-2 rounded-xl border border-indigo-700 px-4 py-2.5 font-black text-indigo-700"><Download size={16} />Excel</button>}</div>
      {quarterly.length > 0 && <><div className="mt-4 rounded-xl bg-indigo-700 p-4 text-white"><p className="text-xs font-black uppercase">Bono trimestral estimado</p><p className="text-3xl font-black">{money(quarterlyTotal)}</p><p className="text-xs text-indigo-100">Auditoría ≥95%, inventario &gt;85% y diferencia &lt;0.5% de la venta mensual.</p></div><div className="mt-4 overflow-x-auto rounded-xl border"><table className="w-full min-w-[1100px] text-xs"><thead className="bg-slate-950 text-white"><tr><th className="p-3 text-left">Tienda / venta trimestre</th><th className="p-3">Auditoría ≥95%</th><th className="p-3">Inventario &gt;85%</th><th className="p-3">Dif. / venta mensual &lt;0.5%</th><th className="p-3">Bono</th></tr></thead><tbody>{quarterly.map(x => { const au = x.audit != null && x.audit >= 95, inv = x.inventory != null && x.inventory > 85, diff = x.diffPct != null && x.diffPct < 0.5, reward = tier(x.sales, false, au ? 100 : 0) + tier(x.sales, false, inv ? 100 : 0) + tier(x.sales, false, diff ? 100 : 0); return <tr key={x.store.id} className="border-t"><td className="p-3 font-bold">{x.store.name}<br /><span className="font-normal text-slate-500">{money(x.sales)}</span></td><td className={"p-3 text-center font-bold " + state(x.audit == null ? null : au)}>{pct(x.audit)}</td><td className={"p-3 text-center font-bold " + state(x.inventory == null ? null : inv)}>{pct(x.inventory)}</td><td className={"p-3 text-center font-bold " + state(x.diffPct == null ? null : diff)}>{pct(x.diffPct)}<br />{money(x.diff)} / {money(x.monthlySales)}</td><td className="p-3 text-center font-black text-indigo-700">{money(reward)}</td></tr>; })}</tbody></table></div></>}
    </section>
  </div></div>;
}
