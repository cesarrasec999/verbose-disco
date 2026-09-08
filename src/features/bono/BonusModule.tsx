"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { readStoredUser } from "@/lib/singleDeviceSession";
import type { CyclicUser, Store } from "@/features/ciclicos/types";
import { bonusSqlMapping, createBonusStoreResolver as mapping } from "./storeMapping";
import { mapBounded } from "@/lib/boundedReads";

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
type TrafficLight = "green" | "yellow" | "red" | "gray" | null;
function trafficLight(header: string, row: Record<string, unknown>): TrafficLight {
  const number = (key: string) => typeof row[key] === "number" ? Number(row[key]) : null;
  const target = number("% META RMS"), reception = number("% RECEPCIONES"), loss = number("% DESMEDRO"), xd = number("% VARIACION X+D"), reward = number("BONO ESTIMADO");
  if (header === "% META RMS" || header === "META VENTAS RMS" || header === "VENTA" || header === "ESTADO META") return target == null ? "gray" : target >= 1 ? "green" : target >= 0.85 ? "yellow" : "red";
  if (header === "% RECEPCIONES" || header === "RECEPCIONES RECIBIDAS") return reception == null ? "gray" : reception >= 0.9 ? "green" : reception >= 0.85 ? "yellow" : "red";
  if (header === "% DESMEDRO" || header === "DESMEDRO") return loss == null ? "gray" : loss <= 0.005 ? "green" : loss <= 0.01 ? "yellow" : "red";
  if (header === "% VARIACION X+D" || header === "X+D MES ACTUAL" || header === "X+D MES ANTERIOR") return xd == null ? "gray" : xd <= -0.1 ? "green" : xd < 0 ? "yellow" : "red";
  if (header === "BONO ESTIMADO") return reward == null ? "gray" : reward > 0 ? "green" : "red";
  return null;
}
const trafficStyle: Record<Exclude<TrafficLight, null>, object> = {
  green: { fill: { patternType: "solid", fgColor: { rgb: "C6EFCE" } }, font: { color: { rgb: "006100" } } },
  yellow: { fill: { patternType: "solid", fgColor: { rgb: "FFEB9C" } }, font: { color: { rgb: "9C6500" } } },
  red: { fill: { patternType: "solid", fgColor: { rgb: "FFC7CE" } }, font: { color: { rgb: "9C0006" } } },
  gray: { fill: { patternType: "solid", fgColor: { rgb: "E2E8F0" } }, font: { color: { rgb: "475569" } } },
};
async function excel(name: string, sheets: { name: string; rows: Record<string, unknown>[] }[]) {
  // xlsx-js-style conserva rellenos y colores en el archivo descargado.
  const XLSX = await import("xlsx-js-style");
    const book = XLSX.utils.book_new();
    for (const source of sheets) {
      const rows = source.rows.length ? source.rows : [{ "Sin registros": "No hay movimientos para el período calculado." }];
      const sheet = XLSX.utils.json_to_sheet(rows);
      // Los porcentajes permanecen como números para que Excel pueda operar
      // con ellos, pero se muestran con dos decimales (ej. 90.00%).
      const headers = Object.keys(rows[0]);
      headers.forEach((header, column) => {
        for (let row = 2; row <= rows.length + 1; row += 1) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row - 1, c: column })];
          if (!cell) continue;
          if ((header.includes("%") || header.startsWith("ERI ")) && typeof cell.v === "number") cell.z = "0.00%";
          const status = source.name === "Resumen" ? trafficLight(header, rows[row - 2]) : null;
          if (status) cell.s = trafficStyle[status];
        }
      });
      sheet["!cols"] = Object.keys(rows[0]).map((key, index) => ({ wch: Math.min(42, Math.max(index ? 15 : 26, key.length + 3)) }));
      XLSX.utils.book_append_sheet(book, sheet, source.name);
    }
    XLSX.writeFile(book, name);
}

export default function BonusModule() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [month, setMonth] = useState("2026-08");
  const [quarter, setQuarter] = useState("2026-09-30");
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [monthlySource, setMonthlySource] = useState<{ month: string; oldDate: string | null; newDate: string | null; rotation: string | null; calculatedAt: string } | null>(null);
  const [quarterlyDate, setQuarterlyDate] = useState("");
  const [exporting, setExporting] = useState(false);
  const monthlyBusy = useRef(false), quarterlyBusy = useRef(false);
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
    if (monthlyBusy.current) return;
    monthlyBusy.current = true; setLoadingMonthly(true);
    try {
      const from = start(month), until = end(month), before = prev(month), store = mapping(stores);
      const [{ data: source, error }, rotation] = await Promise.all([
        supabase.rpc("get_bonus_period_sources_v2", { p_month: from }),
        supabase.from("product_rotation_monthly").select("period_month").order("period_month", { ascending: false }).limit(1),
      ]);
      if (error) throw error;
      if (rotation.error) throw rotation.error;
      const sales = new Map<string, number>(), targets = new Map<string, number>(), loss = new Map<string, number>(), reception = new Map<string, { received: number; eligible: number }>();
      for (const row of source.sales) { const s = store(row.store_key) || store(row.store_name); if (s) sales.set(s.id, (sales.get(s.id) || 0) + Number(row.sales_amount || 0)); }
      for (const row of source.targets) { const s = store(row.store_key); if (s) targets.set(s.id, Number(row.target_amount || 0)); }
      for (const row of source.losses) { const s = store(row.store_code); if (s) loss.set(s.id, (loss.get(s.id) || 0) + Number(row.value_total || 0)); }
      for (const row of source.receipts) {
        const s = store(row.destination_store_code); if (!s) continue;
        const age = Math.round((Date.parse(until + "T00:00:00-05:00") - Date.parse(row.creation_date + "T00:00:00-05:00")) / 86400000);
        if (age <= (isLima(s) ? 2 : 5)) continue;
        const current = reception.get(s.id) || { eligible: 0, received: 0 };
        current.eligible += Number(row.records); if (String(row.erp_status || "").toUpperCase() === "V") current.received += Number(row.records); reception.set(s.id, current);
      }
      const snapshotDate = async (cutoff: string) => { const { data, error } = await supabase.from("inventory_valuation_snapshots").select("snapshot_date").lte("snapshot_date", cutoff).order("snapshot_date", { ascending: false }).order("snapshot_time", { ascending: false }).limit(1); if (error) throw error; return data?.[0]?.snapshot_date ? String(data[0].snapshot_date) : null; };
      const basis = rotation.data?.[0]?.period_month || null;
      const valueAt = async (date: string | null) => {
        if (!date || !basis) return null;
        const results = await mapBounded(stores, async store => {
          const { data, error } = await supabase.rpc("get_bonus_xd_value_v2", { p_date: date, p_rotation_month: basis, p_stores: bonusSqlMapping([store]) });
          if (error) throw error;
          return data || [];
        }, 2);
        return new Map<string, number>(results.flat().map((row: any) => [String(row.store_id), Number(row.inventory_value)]));
      };
      const [oldDate, newDate] = await Promise.all([snapshotDate(end(before)), snapshotDate(until)]);
      // Large database work is sequential; only compact totals reach the browser.
      const oldValues = await valueAt(oldDate), newValues = await valueAt(newDate);
      setMonthly(stores.map(s => { const r = reception.get(s.id) || { eligible: 0, received: 0 }; const sale = sales.get(s.id) || 0, goal = targets.get(s.id) ?? null, beforeValue = oldValues?.get(s.id) ?? null, currentValue = newValues?.get(s.id) ?? null, lost = loss.get(s.id) || 0; return { store: s, sales: sale, target: goal, targetPct: goal && goal > 0 ? sale / goal * 100 : null, received: r.received, eligible: r.eligible, receptionPct: r.eligible ? r.received / r.eligible * 100 : null, loss: lost, lossPct: sale ? lost / sale * 100 : null, xdNow: currentValue, xdBefore: beforeValue, xdPct: beforeValue && beforeValue > 0 && currentValue != null ? (currentValue - beforeValue) / beforeValue * 100 : null }; }));
      setMonthlySource({ month, oldDate, newDate, rotation: basis, calculatedAt: new Date().toISOString() });
    } catch (error) { toast.error("No se pudo calcular Bono mensual: " + message(error)); } finally { monthlyBusy.current = false; setLoadingMonthly(false); }
  }, [month, stores]);

  const calculateQuarterly = useCallback(async () => {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(quarter)) { toast.error("Selecciona una fecha válida."); return; }
    if (quarterlyBusy.current) return;
    quarterlyBusy.current = true;
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
      const auditStore = new Map([...latestAudit.entries()].map(([id, sid]) => [sid, id])), audit = new Map<string, { all: number; ok: number }>();
      const { data: auditSummary, error: auditError } = await supabase.rpc("get_audit_admin_summary", { p_session_ids: [...latestAudit.values()] });
      if (auditError) throw auditError;
      for (const row of auditSummary || []) { const id = auditStore.get(String(row.session_id)); if (id) audit.set(id, { all: Number(row.audited_items), ok: Number(row.ok_items) }); }
      const sales = new Map<string, number>();
      for (const row of salesRows) { const s = store(row.store_key || row.store_name); if (s) sales.set(s.id, (sales.get(s.id) || 0) + Number(row.sales_amount || 0)); }
      const periods = [...new Set([...inventory.values()].map(row => String(row.finished_at || "").slice(0, 7)).filter(Boolean))], monthlySales = new Map<string, number>();
      for (const period of periods) for (const row of await paged<any>((a, b) => supabase.from("erp_store_sales_daily").select("store_key,store_name,sales_amount").gte("sales_date", start(period)).lte("sales_date", end(period)).range(a, b))) { const s = store(row.store_key || row.store_name); if (s) monthlySales.set(s.id + "|" + period, (monthlySales.get(s.id + "|" + period) || 0) + Number(row.sales_amount || 0)); }
      setQuarterly(stores.map(s => { const inv = inventory.get(s.id), au = audit.get(s.id), saleMonth = inv ? monthlySales.get(s.id + "|" + String(inv.finished_at || "").slice(0, 7)) || 0 : null; const difference = inv ? Math.abs(Number(inv.net_value_diff || 0)) : null; return { store: s, sales: sales.get(s.id) || 0, audit: au && au.all ? au.ok / au.all * 100 : null, inventory: inv ? Number(inv.eri_pct || 0) : null, diff: difference, monthlySales: saleMonth, diffPct: difference != null && saleMonth && saleMonth > 0 ? difference / saleMonth * 100 : null }; }));
      setQuarterlyDate(quarter);
    } catch (error) { toast.error("No se pudo calcular Bono trimestral: " + message(error)); } finally { quarterlyBusy.current = false; setLoadingQuarterly(false); }
  }, [quarter, stores]);

  const monthlyTotal = useMemo(() => monthly.reduce((sum, row) => sum + monthlyReward(row), 0), [monthly]);
  const quarterlyTotal = useMemo(() => quarterly.reduce((sum, row) => sum + tier(row.sales, false, row.audit != null && row.audit >= 95 ? 100 : 0) + tier(row.sales, false, row.inventory != null && row.inventory > 85 ? 100 : 0) + tier(row.sales, false, row.diffPct != null && row.diffPct < 0.5 ? 100 : 0), 0), [quarterly]);
  const exportMonthly = async () => {
    if (!monthlySource || exporting) return;
    setExporting(true);
    try {
      const store = mapping(stores), period = monthlySource.month;
      const parts = await mapBounded(["ADJUSTMENT", "SLIP_OUT"], type => paged<any>((a, b) => supabase.from("erp_movements")
        .select("movement_key,store_code,movement_date,document_no,reason,product_code,description,quantity,value_total")
        .eq("source_type", type).eq("reason", type === "ADJUSTMENT" ? "15. DESMEDROS" : "DESMEDROS")
        .gte("movement_date", start(period) + "T00:00:00-05:00").lt("movement_date", next(period) + "T00:00:00-05:00")
        .order("movement_date").order("movement_key").range(a, b)), 2);
      const lossDetails: LossDetail[] = parts.flatMap((rows, index) => rows.flatMap(row => {
        const s = store(row.store_code);
        return s ? [{ store: s.name, source: index === 0 ? "Ajuste de cantidad" : "Salida por transferencia", movementDate: String(row.movement_date), documentNo: String(row.document_no || ""), reason: String(row.reason), productCode: String(row.product_code), description: String(row.description || ""), quantity: Number(row.quantity), value: Math.abs(Number(row.value_total || 0)) }] : [];
      }));
      for (const row of monthly) {
        const detailValue = lossDetails.filter(x => x.store === row.store.name).reduce((sum, x) => sum + x.value, 0);
        if (Math.abs(detailValue - row.loss) > 0.01) throw new Error("Los movimientos cambiaron desde el cálculo. Vuelve a calcular antes de exportar para mantener Resumen y Detalle iguales.");
      }
      await excel("bono_mensual_" + period + ".xlsx", [
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
        "MES CALCULADO": period,
        "FECHA VALORIZADO ANTERIOR": monthlySource.oldDate || "Sin dato",
        "FECHA VALORIZADO ACTUAL": monthlySource.newDate || "Sin dato",
        "ROTACION BASE": monthlySource.rotation || "Sin dato",
        "CONSULTADO EN": monthlySource.calculatedAt,
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
    } catch (error) { toast.error("No se pudo exportar: " + message(error)); }
    finally { setExporting(false); }
  };
  if (!user) return <p className="p-8 text-center font-bold text-slate-400">Cargando...</p>;
  const state = (ok: boolean | null) => ok == null ? "text-slate-400" : ok ? "text-emerald-700" : "text-red-600";
  return <div className="p-4 md:p-8"><div className="mx-auto max-w-[1600px] space-y-6">
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><p className="text-xs font-black uppercase tracking-wide text-indigo-600">Análisis · Bono</p><h2 className="mt-1 text-2xl font-black">Bono mensual y bono trimestral</h2><p className="mt-1 text-sm text-slate-500">Son consultas independientes: calcular una no carga fuentes de la otra.</p></section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><div className="flex flex-wrap items-end gap-3"><div className="mr-auto"><p className="text-xs font-black uppercase text-emerald-700">Bono mensual</p><h3 className="text-xl font-black">Corte mensual</h3></div><label className="text-xs font-black">Mes<input className="mt-1 block rounded-xl border px-3 py-2" type="month" value={month} disabled={loadingMonthly || exporting} onChange={e => { setMonth(e.target.value); setMonthly([]); setMonthlySource(null); }} /></label><button onClick={() => void calculateMonthly()} disabled={loadingMonthly || !stores.length} className="flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 font-black text-white disabled:opacity-50"><RefreshCw size={16} className={loadingMonthly ? "animate-spin" : ""} />{loadingMonthly ? "Calculando..." : "Calcular mensual"}</button>{monthly.length > 0 && <button onClick={() => void exportMonthly()} disabled={exporting || loadingMonthly} className="flex items-center gap-2 rounded-xl border border-emerald-700 px-4 py-2.5 font-black text-emerald-700"><Download size={16} />{exporting ? "Preparando..." : "Excel"}</button>}</div>
      {monthlySource && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">Mes calculado: {monthlySource.month}. Valorizado anterior: {monthlySource.oldDate || "Sin dato"}; actual: {monthlySource.newDate || "Sin dato"}. Rotación base común: {monthlySource.rotation || "Sin dato"}. Consulta: {new Date(monthlySource.calculatedAt).toLocaleString("es-PE")}. Recepciones: estado RMS disponible al consultar; no es una reconstrucción del estado histórico al cierre.</p>}
      {monthly.length > 0 && <><div className="mt-4 rounded-xl bg-emerald-700 p-4 text-white"><p className="text-xs font-black uppercase">Bono mensual estimado</p><p className="text-3xl font-black">{money(monthlyTotal)}</p><p className="text-xs text-emerald-100">La meta RMS es obligatoria: menos de 100% o sin meta cargada = S/ 0.00 de bono.</p></div><div className="mt-4 overflow-x-auto rounded-xl border"><table className="w-full min-w-[1250px] text-xs"><thead className="bg-slate-950 text-white"><tr><th className="p-3 text-left">Tienda / venta</th><th className="p-3">Meta ventas RMS<br />obligatoria</th><th className="p-3">Recepciones</th><th className="p-3">Desmedro ≤0.5%</th><th className="p-3">Variación X+D<br />meta: −10%</th><th className="p-3">Bono</th></tr></thead><tbody>{monthly.map(x => { const meta = x.targetPct != null && x.targetPct >= 100, recep = x.receptionPct != null && x.receptionPct >= 85, loss = x.lossPct != null && x.lossPct <= 0.5, xd = x.xdPct != null && x.xdPct <= -10, reward = monthlyReward(x); return <tr key={x.store.id} className="border-t"><td className="p-3 font-bold">{x.store.name}<br /><span className="font-normal text-slate-500">{money(x.sales)}</span></td><td className={"p-3 text-center font-bold " + state(x.targetPct == null ? null : meta)}>{pct(x.targetPct)}<br />{money(x.target)}<br /><span className="text-[10px]">{x.targetPct == null ? "Meta pendiente RMS" : meta ? "Habilita bono" : "No comisiona"}</span></td><td className={"p-3 text-center font-bold " + state(x.receptionPct == null ? null : recep)}>{x.received}/{x.eligible}<br />{pct(x.receptionPct)}</td><td className={"p-3 text-center font-bold " + state(x.lossPct == null ? null : loss)}>{money(x.loss)}<br />{pct(x.lossPct)}</td><td className={"p-3 text-center font-bold " + state(x.xdPct == null ? null : xd)}>{xdText(x.xdPct)}<br /><span className="font-normal">{xdValueText(x.xdNow, x.xdBefore)}</span></td><td className="p-3 text-center font-black text-emerald-700">{money(reward)}</td></tr>; })}</tbody></table></div></>}
    </section>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><div className="flex flex-wrap items-end gap-3"><div className="mr-auto"><p className="text-xs font-black uppercase text-indigo-700">Bono trimestral</p><h3 className="text-xl font-black">Corte trimestral</h3></div><label className="text-xs font-black">Fecha<input className="mt-1 block rounded-xl border px-3 py-2" type="date" value={quarter} disabled={loadingQuarterly} onChange={e => { setQuarter(e.target.value); setQuarterly([]); }} /></label><button onClick={() => void calculateQuarterly()} disabled={loadingQuarterly || !stores.length} className="flex items-center gap-2 rounded-xl bg-indigo-700 px-4 py-2.5 font-black text-white disabled:opacity-50"><RefreshCw size={16} className={loadingQuarterly ? "animate-spin" : ""} />{loadingQuarterly ? "Calculando..." : "Calcular trimestral"}</button>{quarterly.length > 0 && <button onClick={() => excel("bono_trimestral_" + quarterlyDate + ".xlsx", [{ name: "Resumen", rows: quarterly.map(x => ({ TIENDA: x.store.name, CORTE: quarterlyDate, "VENTA TRIMESTRAL": x.sales, "% ERI AUDITORIA": x.audit == null ? "Sin dato" : x.audit / 100, "% ERI INVENTARIO": x.inventory == null ? "Sin dato" : x.inventory / 100, "DIFERENCIA NETA": x.diff ?? "Sin dato", "VENTA MENSUAL INVENTARIO": x.monthlySales ?? "Sin dato", "% DIFERENCIA": x.diffPct == null ? "Sin dato" : x.diffPct / 100 })) }])} className="flex items-center gap-2 rounded-xl border border-indigo-700 px-4 py-2.5 font-black text-indigo-700"><Download size={16} />Excel</button>}</div>
      {quarterly.length > 0 && <><div className="mt-4 rounded-xl bg-indigo-700 p-4 text-white"><p className="text-xs font-black uppercase">Bono trimestral estimado</p><p className="text-3xl font-black">{money(quarterlyTotal)}</p><p className="text-xs text-indigo-100">Auditoría ≥95%, inventario &gt;85% y diferencia &lt;0.5% de la venta mensual.</p></div><div className="mt-4 overflow-x-auto rounded-xl border"><table className="w-full min-w-[1100px] text-xs"><thead className="bg-slate-950 text-white"><tr><th className="p-3 text-left">Tienda / venta trimestre</th><th className="p-3">Auditoría ≥95%</th><th className="p-3">Inventario &gt;85%</th><th className="p-3">Dif. / venta mensual &lt;0.5%</th><th className="p-3">Bono</th></tr></thead><tbody>{quarterly.map(x => { const au = x.audit != null && x.audit >= 95, inv = x.inventory != null && x.inventory > 85, diff = x.diffPct != null && x.diffPct < 0.5, reward = tier(x.sales, false, au ? 100 : 0) + tier(x.sales, false, inv ? 100 : 0) + tier(x.sales, false, diff ? 100 : 0); return <tr key={x.store.id} className="border-t"><td className="p-3 font-bold">{x.store.name}<br /><span className="font-normal text-slate-500">{money(x.sales)}</span></td><td className={"p-3 text-center font-bold " + state(x.audit == null ? null : au)}>{pct(x.audit)}</td><td className={"p-3 text-center font-bold " + state(x.inventory == null ? null : inv)}>{pct(x.inventory)}</td><td className={"p-3 text-center font-bold " + state(x.diffPct == null ? null : diff)}>{pct(x.diffPct)}<br />{money(x.diff)} / {money(x.monthlySales)}</td><td className="p-3 text-center font-black text-indigo-700">{money(reward)}</td></tr>; })}</tbody></table></div></>}
    </section>
  </div></div>;
}
