import type { SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { parseCost, r2, isSessionFlagLocation, formatMoney } from "@/features/ciclicos/utils";

/**
 * Reporte diario de conteo ciclico para envio automatico por correo.
 * Replica la logica de la vista "dia" de loadDashboard() y de
 * generateEmailHTML() en CiclicosShell.tsx, pero corriendo en servidor
 * (sin canvas/SVG->PNG, que son APIs de navegador). Los graficos de barra
 * se arman con tablas HTML de ancho proporcional en vez de imagenes.
 */

type DayStoreRow = {
  store_id: string;
  store_name: string;
  total_asignados: number;
  total_ok: number;
  total_sobrantes: number;
  total_faltantes: number;
  dif_valorizada: number;
  eri: number;
  cumplio: boolean;
};

type SkuAgg = { store_name: string; sku: string; description: string; totalDif: number; totalDifVal: number };

type AssignmentRow = { id: string; store_id: string; product_id: string; system_stock: number; assigned_date: string };
type EnrichedAssignmentRow = AssignmentRow & { stores: { name: string }; cyclic_products: { cost: number } };
type CountRow = { assignment_id: string; counted_quantity: number; location: string; status?: string };
type NameRow = { id: string; name: string };
type ProductCostRow = { id: string; cost: unknown };
type ProductSkuRow = { id: string; sku: string | null; description: string | null; cost: unknown };

async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[] | null> | PromiseLike<T[] | null>,
  pageSize = 1000
): Promise<T[]> {
  let all: T[] = [];
  let page = 0;
  while (true) {
    const chunk = await fetchPage(page * pageSize, (page + 1) * pageSize - 1);
    if (!chunk || chunk.length === 0) break;
    all = all.concat(chunk);
    if (chunk.length < pageSize) break;
    page++;
  }
  return all;
}

async function loadDayStoreRows(supabase: SupabaseClient, date: string): Promise<DayStoreRow[]> {
  const asgnRaw = await fetchAllPages<AssignmentRow>((from, to) =>
    supabase
      .from("cyclic_assignments")
      .select("id, store_id, product_id, system_stock, assigned_date")
      .eq("assigned_date", date)
      .order("id")
      .range(from, to)
      .then(r => r.data)
  );
  if (asgnRaw.length === 0) return [];

  const uniqueStoreIds = [...new Set(asgnRaw.map(a => a.store_id))];
  const uniqueProdIds = [...new Set(asgnRaw.map(a => a.product_id))];

  let storesList: NameRow[] = [];
  for (let i = 0; i < uniqueStoreIds.length; i += 500) {
    const { data } = await supabase.from("stores").select("id, name").in("id", uniqueStoreIds.slice(i, i + 500));
    storesList = storesList.concat((data as NameRow[]) || []);
  }
  const storeMap = new Map(storesList.map(s => [s.id, s.name]));

  let prodsList: ProductCostRow[] = [];
  for (let i = 0; i < uniqueProdIds.length; i += 500) {
    const { data } = await supabase.from("cyclic_products").select("id, cost").in("id", uniqueProdIds.slice(i, i + 500));
    prodsList = prodsList.concat((data as ProductCostRow[]) || []);
  }
  const prodCostMap = new Map(prodsList.map(p => [p.id, parseCost(p.cost)]));

  const asgnData: EnrichedAssignmentRow[] = asgnRaw.map(a => ({
    ...a,
    stores: { name: storeMap.get(a.store_id) || a.store_id },
    cyclic_products: { cost: prodCostMap.get(a.product_id) || 0 },
  }));

  const asgnIds = asgnData.map(a => a.id);
  const asgnIdSet = new Set<string>(asgnIds);
  let cntAll: CountRow[] = [];
  for (let i = 0; i < asgnIds.length; i += 500) {
    const chunk = asgnIds.slice(i, i + 500);
    const chunkCounts = await fetchAllPages<CountRow>((from, to) =>
      supabase.from("cyclic_counts").select("assignment_id, counted_quantity, location, status").in("assignment_id", chunk).range(from, to).then(r => r.data)
    );
    cntAll = cntAll.concat(chunkCounts);
  }

  const SESSION_FLAG_VALUES = new Set(["__session_counting__", "__session_finished__", "__recount_started__", "__recount_done__"]);
  const anchorToMeta = new Map<string, { store_id: string; date: string }>();
  for (const a of asgnData) anchorToMeta.set(a.id, { store_id: a.store_id, date: a.assigned_date });

  const storeDateFlags = new Map<string, Set<string>>();
  for (const c of cntAll) {
    if (!SESSION_FLAG_VALUES.has(c.location)) continue;
    const meta = anchorToMeta.get(c.assignment_id);
    if (!meta) continue;
    const k = `${meta.store_id}__${meta.date}`;
    if (!storeDateFlags.has(k)) storeDateFlags.set(k, new Set());
    storeDateFlags.get(k)!.add(c.location);
  }

  const counts = cntAll.filter(c => !SESSION_FLAG_VALUES.has(c.location) && asgnIdSet.has(c.assignment_id));

  const dayGroups = new Map<string, { store_id: string; store_name: string; asgns: EnrichedAssignmentRow[]; cnts: CountRow[] }>();
  for (const a of asgnData) {
    const k = a.store_id;
    if (!dayGroups.has(k)) {
      dayGroups.set(k, { store_id: a.store_id, store_name: a.stores?.name || a.store_id, asgns: [], cnts: [] });
    }
    dayGroups.get(k)!.asgns.push(a);
  }
  const asgnById = new Map(asgnData.map(a => [a.id, a]));
  for (const c of counts) {
    const asgn = asgnById.get(c.assignment_id);
    if (!asgn) continue;
    dayGroups.get(asgn.store_id)?.cnts.push(c);
  }

  const rows: DayStoreRow[] = [];
  for (const [, g] of dayGroups) {
    const groupKey = `${g.store_id}__${date}`;
    const flagsForGroup = storeDateFlags.get(groupKey) || new Set<string>();
    const countedAsgIds = new Set(g.cnts.map(c => c.assignment_id));

    const prodMap = new Map<string, { system_stock: number; total_counted: number; contado: boolean }>();
    for (const a of g.asgns) {
      if (!prodMap.has(a.product_id)) prodMap.set(a.product_id, { system_stock: a.system_stock, total_counted: 0, contado: false });
      if (countedAsgIds.has(a.id)) prodMap.get(a.product_id)!.contado = true;
    }
    for (const c of g.cnts) {
      const asgn = asgnById.get(c.assignment_id);
      if (!asgn) continue;
      const entry = prodMap.get(asgn.product_id);
      if (entry) entry.total_counted += Number(c.counted_quantity);
    }

    let ok = 0, sobrantes = 0, faltantes = 0, noContados = 0;
    for (const [, entry] of prodMap) {
      if (!entry.contado) { noContados++; continue; }
      const diff = entry.total_counted - entry.system_stock;
      if (diff === 0) ok++;
      else if (diff > 0) sobrantes++;
      else faltantes++;
    }
    const total = prodMap.size;
    const totalContados = ok + sobrantes + faltantes;
    const eri = totalContados > 0 ? Math.round((ok / totalContados) * 100) : 0;

    let difVal = 0;
    for (const [pid, entry] of prodMap) {
      if (entry.contado) {
        const asgForPid = g.asgns.find(a => a.product_id === pid);
        const costo = parseCost(asgForPid?.cyclic_products?.cost);
        const diff = r2(entry.total_counted - entry.system_stock);
        difVal = r2(difVal + r2(diff * costo));
      }
    }

    const cumplioPorReconteo = flagsForGroup.has("__recount_done__");
    const cumplio = cumplioPorReconteo || (noContados === 0 && total > 0);

    rows.push({
      store_id: g.store_id,
      store_name: g.store_name,
      total_asignados: total,
      total_ok: ok,
      total_sobrantes: sobrantes,
      total_faltantes: faltantes,
      dif_valorizada: difVal,
      eri,
      cumplio,
    });
  }
  return rows;
}

async function loadTopSkuDiffs(supabase: SupabaseClient, date: string, storeNameById: Map<string, string>) {
  const skuFaltMap = new Map<string, SkuAgg>();
  const skuSobMap = new Map<string, SkuAgg>();

  const asgnRows = await fetchAllPages<AssignmentRow>((from, to) =>
    supabase
      .from("cyclic_assignments")
      .select("id, store_id, product_id, system_stock, assigned_date")
      .eq("assigned_date", date)
      .range(from, to)
      .then(r => r.data)
  );
  if (asgnRows.length === 0) return { topFaltantes: [] as SkuAgg[], topSobrantes: [] as SkuAgg[] };

  const prodIds = [...new Set(asgnRows.map(a => a.product_id))];
  let prodRows: ProductSkuRow[] = [];
  for (let i = 0; i < prodIds.length; i += 500) {
    const { data } = await supabase.from("cyclic_products").select("id, sku, description, cost").in("id", prodIds.slice(i, i + 500));
    if (data) prodRows = prodRows.concat(data as ProductSkuRow[]);
  }
  const prodMap = new Map(prodRows.map(p => [p.id, p]));
  const asgnById = new Map(asgnRows.map(a => [a.id, a]));

  const asgnIds = asgnRows.map(a => a.id);
  let cntRows: CountRow[] = [];
  for (let i = 0; i < asgnIds.length; i += 500) {
    const chunk = asgnIds.slice(i, i + 500);
    const chunkCounts = await fetchAllPages<CountRow>((from, to) =>
      supabase.from("cyclic_counts").select("assignment_id, counted_quantity, location, status").in("assignment_id", chunk).range(from, to).then(r => r.data)
    );
    cntRows = cntRows.concat(chunkCounts);
  }
  cntRows = cntRows.filter(c => !isSessionFlagLocation(c.location));

  const cntByAsgn = new Map<string, number>();
  for (const c of cntRows) {
    cntByAsgn.set(c.assignment_id, r2((cntByAsgn.get(c.assignment_id) || 0) + Number(c.counted_quantity)));
  }

  const asgnsByStore = new Map<string, AssignmentRow[]>();
  for (const asgn of asgnRows) {
    if (!asgnsByStore.has(asgn.store_id)) asgnsByStore.set(asgn.store_id, []);
    asgnsByStore.get(asgn.store_id)!.push(asgn);
  }

  const fulfilledStoreIds = new Set<string>();
  for (const [storeId, storeAsgns] of asgnsByStore) {
    const countedProductIds = new Set<string>();
    for (const asgn of storeAsgns) {
      if (cntByAsgn.has(asgn.id)) countedProductIds.add(asgn.product_id);
    }
    const assignedProductIds = new Set(storeAsgns.map(a => a.product_id));
    const hasCorrected = cntRows.some(c => {
      const asgn = asgnById.get(c.assignment_id);
      return asgn && asgn.store_id === storeId && c.status === "Corregido";
    });
    const completed = hasCorrected || [...assignedProductIds].every(pid => countedProductIds.has(pid));
    if (completed) fulfilledStoreIds.add(storeId);
  }

  const prodAgg = new Map<string, { store_id: string; store_name: string; sku: string; description: string; cost: number; systemStock: number; counted: number }>();
  for (const asgn of asgnRows) {
    const prod = prodMap.get(asgn.product_id);
    if (!prod) continue;
    if (!fulfilledStoreIds.has(asgn.store_id)) continue;
    const aggKey = `${asgn.store_id}__${asgn.product_id}`;
    const prev = prodAgg.get(aggKey) ?? {
      store_id: asgn.store_id,
      store_name: storeNameById.get(asgn.store_id) || asgn.store_id,
      sku: prod.sku || "",
      description: prod.description || "",
      cost: parseCost(prod.cost),
      systemStock: 0,
      counted: 0,
    };
    prev.systemStock = r2(prev.systemStock + Number(asgn.system_stock || 0));
    prev.counted = r2(prev.counted + (cntByAsgn.get(asgn.id) || 0));
    prodAgg.set(aggKey, prev);
  }

  for (const [, entry] of prodAgg) {
    const diff = r2(entry.counted - entry.systemStock);
    const difVal = r2(diff * entry.cost);
    if (diff < 0) {
      const key = `${entry.store_id}__${entry.sku}`;
      const prev = skuFaltMap.get(key) ?? { store_name: entry.store_name, sku: entry.sku, description: entry.description, totalDif: 0, totalDifVal: 0 };
      skuFaltMap.set(key, { ...prev, totalDif: r2(prev.totalDif + diff), totalDifVal: r2(prev.totalDifVal + difVal) });
    } else if (diff > 0) {
      const key = `${entry.store_id}__${entry.sku}`;
      const prev = skuSobMap.get(key) ?? { store_name: entry.store_name, sku: entry.sku, description: entry.description, totalDif: 0, totalDifVal: 0 };
      skuSobMap.set(key, { ...prev, totalDif: r2(prev.totalDif + diff), totalDifVal: r2(prev.totalDifVal + difVal) });
    }
  }

  const topFaltantes = [...skuFaltMap.values()].sort((a, b) => a.totalDifVal - b.totalDifVal).slice(0, 10);
  const topSobrantes = [...skuSobMap.values()].sort((a, b) => b.totalDifVal - a.totalDifVal).slice(0, 10);
  return { topFaltantes, topSobrantes };
}

const eriColor = (v: number) => (v >= 90 ? "#16a34a" : v >= 70 ? "#d97706" : "#dc2626");
const pctColor = eriColor;
const difColor = (v: number) => (v < 0 ? "#dc2626" : v > 0 ? "#2563eb" : "#16a34a");

/** Barra horizontal 0-100% con tabla HTML (ancho por atributo, compatible Gmail/Outlook) */
function htmlBarRow(name: string, pct: number, color: string, valueLabel: string) {
  const filled = Math.max(1, Math.round(Math.max(0, Math.min(100, pct))));
  const empty = 100 - filled;
  return `
    <tr>
      <td style="padding:3px 8px 3px 0;font-size:11px;font-weight:600;color:#1e293b;width:220px;white-space:nowrap;">${name}</td>
      <td style="padding:3px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr style="height:16px;">
            <td width="${filled}%" bgcolor="${color}" style="background:${color};border-radius:3px 0 0 3px;font-size:0;line-height:0;">&nbsp;</td>
            ${empty > 0 ? `<td width="${empty}%" bgcolor="#e2e8f0" style="background:#e2e8f0;border-radius:0 3px 3px 0;font-size:0;line-height:0;">&nbsp;</td>` : ""}
          </tr>
        </table>
      </td>
      <td style="padding:3px 0 3px 8px;font-size:11px;font-weight:800;color:${color};text-align:right;white-space:nowrap;">${valueLabel}</td>
    </tr>`;
}

function barChartTable(rows: { name: string; pct: number; color: string; valueLabel: string }[]) {
  if (rows.length === 0) return "<p style='color:#94a3b8;font-size:12px;margin:0;'>Sin datos</p>";
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows.map(r => htmlBarRow(r.name, r.pct, r.color, r.valueLabel)).join("")}</table>`;
}

export async function buildDailyCyclicReportHTML(
  supabase: SupabaseClient,
  date: string
): Promise<{ html: string; subject: string; hasData: boolean }> {
  const rows = await loadDayStoreRows(supabase, date);
  const storeNameById = new Map(rows.map(r => [r.store_id, r.store_name]));
  const { topFaltantes, topSobrantes } = rows.length > 0 ? await loadTopSkuDiffs(supabase, date, storeNameById) : { topFaltantes: [] as SkuAgg[], topSobrantes: [] as SkuAgg[] };

  const cumplidos = rows.filter(r => r.cumplio).length;
  const totalCumplimiento = rows.length;
  const pctCumplimiento = totalCumplimiento > 0 ? Math.round((cumplidos / totalCumplimiento) * 100) : 0;

  const filasQueComplieron = rows.filter(r => r.cumplio && r.total_asignados > 0);
  const okTotal = filasQueComplieron.reduce((s, r) => s + r.total_ok, 0);
  const sobTotal = filasQueComplieron.reduce((s, r) => s + r.total_sobrantes, 0);
  const faltTotal = filasQueComplieron.reduce((s, r) => s + r.total_faltantes, 0);
  const contadosTotal = okTotal + sobTotal + faltTotal;
  const eriGlobal = contadosTotal > 0 ? Math.round((okTotal / contadosTotal) * 100) : 0;
  const totalDifVal = filasQueComplieron.reduce((s, r) => s + (r.dif_valorizada || 0), 0);

  const storesERI = [...filasQueComplieron].sort((a, b) => a.eri - b.eri);
  const eriBars = barChartTable(storesERI.map(r => ({ name: r.store_name, pct: r.eri, color: eriColor(r.eri), valueLabel: `${r.eri}%` })));

  const complianceStores = [...rows].sort((a, b) => (a.cumplio ? 100 : 0) - (b.cumplio ? 100 : 0));
  const cumplBars = barChartTable(complianceStores.map(r => ({ name: r.store_name, pct: r.cumplio ? 100 : 0, color: pctColor(r.cumplio ? 100 : 0), valueLabel: r.cumplio ? "✓ Sí" : "✗ No" })));

  const storesDif = [...filasQueComplieron].filter(r => (r.dif_valorizada || 0) !== 0).sort((a, b) => Math.abs(b.dif_valorizada) - Math.abs(a.dif_valorizada));
  const maxAbsDif = Math.max(...storesDif.map(r => Math.abs(r.dif_valorizada || 0)), 1);
  const difBars = barChartTable(
    storesDif.map(r => ({
      name: r.store_name,
      pct: (Math.abs(r.dif_valorizada) / maxAbsDif) * 100,
      color: difColor(r.dif_valorizada),
      valueLabel: `S/${r.dif_valorizada >= 0 ? "+" : ""}${formatMoney(r.dif_valorizada).replace("S/ ", "")}`,
    }))
  );

  const storeRows = [...filasQueComplieron]
    .sort((a, b) => a.eri - b.eri)
    .map(r => `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:6px 10px;font-size:11px;font-weight:600;color:#1e293b;">${r.store_name}</td>
        <td style="padding:6px;text-align:center;font-size:11px;color:#475569;">${r.total_asignados}</td>
        <td style="padding:6px;text-align:center;font-size:11px;color:#16a34a;font-weight:700;">${r.total_ok}</td>
        <td style="padding:6px;text-align:center;font-size:11px;color:#2563eb;font-weight:600;">${r.total_sobrantes}</td>
        <td style="padding:6px;text-align:center;font-size:11px;color:#dc2626;font-weight:600;">${r.total_faltantes}</td>
        <td style="padding:6px;text-align:center;font-size:11px;color:${difColor(r.dif_valorizada)};font-weight:700;">${formatMoney(r.dif_valorizada)}</td>
        <td style="padding:6px;text-align:center;"><span style="background:${eriColor(r.eri)}22;color:${eriColor(r.eri)};font-weight:800;font-size:11px;padding:2px 7px;border-radius:20px;">${r.eri}%</span></td>
        <td style="padding:6px;text-align:center;font-size:11px;font-weight:700;color:#16a34a;">✓ Sí</td>
      </tr>`)
    .join("");

  const noCumplieronRows = rows
    .filter(r => !r.cumplio)
    .map(r => `
      <tr style="border-bottom:1px solid #fef2f2;">
        <td style="padding:6px 10px;font-size:11px;font-weight:600;color:#1e293b;">${r.store_name}</td>
        <td style="padding:6px;text-align:center;font-size:11px;color:#475569;">${r.total_asignados}</td>
        <td style="padding:6px;text-align:center;font-size:11px;font-weight:700;color:#dc2626;">✗ No</td>
      </tr>`)
    .join("");

  const faltantesRows = topFaltantes.length === 0
    ? `<tr><td colspan="5" style="padding:12px;text-align:center;color:#94a3b8;font-size:13px;">Sin diferencias negativas registradas</td></tr>`
    : topFaltantes.map(r => `
        <tr style="border-bottom:1px solid #fef2f2;">
          <td style="padding:5px 8px;font-size:10px;font-weight:700;color:#1e293b;">${r.store_name}</td>
          <td style="padding:5px;font-size:10px;font-weight:700;color:#1e293b;">${r.sku}</td>
          <td style="padding:5px;font-size:10px;color:#475569;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.description}</td>
          <td style="padding:5px;text-align:center;font-size:10px;color:#dc2626;font-weight:700;">${Number(r.totalDif).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="padding:5px;text-align:center;font-size:10px;color:#dc2626;font-weight:800;">${formatMoney(r.totalDifVal)}</td>
        </tr>`).join("");

  const sobrantesRows = topSobrantes.length === 0
    ? `<tr><td colspan="5" style="padding:12px;text-align:center;color:#94a3b8;font-size:13px;">Sin diferencias positivas registradas</td></tr>`
    : topSobrantes.map(r => `
        <tr style="border-bottom:1px solid #eff6ff;">
          <td style="padding:5px 8px;font-size:10px;font-weight:700;color:#1e293b;">${r.store_name}</td>
          <td style="padding:5px;font-size:10px;font-weight:700;color:#1e293b;">${r.sku}</td>
          <td style="padding:5px;font-size:10px;color:#475569;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.description}</td>
          <td style="padding:5px;text-align:center;font-size:10px;color:#2563eb;font-weight:700;">+${Number(r.totalDif).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="padding:5px;text-align:center;font-size:10px;color:#2563eb;font-weight:800;">${formatMoney(r.totalDifVal)}</td>
        </tr>`).join("");

  const periodoLabel = new Date(`${date}T12:00:00`).toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" });
  const hoyLabel = new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" });
  const hasData = rows.length > 0;

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Informe Conteo Cíclico — ${periodoLabel}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:900px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.10);">

  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#1d4ed8 100%);padding:28px 32px 22px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <div style="background:rgba(255,255,255,0.12);border-radius:10px;width:38px;height:38px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="color:white;font-size:20px;line-height:1;">📦</span>
      </div>
      <div>
        <p style="margin:0;color:#93c5fd;font-weight:900;font-size:13px;letter-spacing:1.5px;">AUDITORÍA Y CONTROL DE INVENTARIOS</p>
        <p style="margin:2px 0 0;color:#64748b;font-size:10px;letter-spacing:1px;">SISTEMA DE CONTEO CÍCLICO</p>
      </div>
    </div>
    <h1 style="margin:0 0 4px;color:#ffffff;font-size:20px;font-weight:800;line-height:1.2;">Informe de Conteo Cíclico</h1>
    <p style="margin:0;color:#93c5fd;font-size:13px;">Fecha: <strong style="color:#ffffff;">${periodoLabel}</strong></p>
    <p style="margin:5px 0 0;color:#475569;font-size:11px;">Generado automáticamente el ${hoyLabel} · Área de Auditoría y Control de Inventarios</p>
  </div>

  <div style="padding:24px 32px;">

    <p style="margin:0 0 20px;font-size:13px;color:#334155;line-height:1.6;">
      Estimado equipo,<br>
      A continuación el <strong>resumen ejecutivo del conteo cíclico</strong> del día <strong>${periodoLabel}</strong>.
      Revisar los resultados con los equipos de tienda y tomar acciones correctivas ante las diferencias identificadas.
    </p>

    ${!hasData ? `
    <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:20px;text-align:center;">
      <p style="margin:0;font-size:13px;color:#64748b;">No se registraron asignaciones de conteo cíclico para esta fecha.</p>
    </div>` : `

    <h2 style="margin:0 0 10px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #1d4ed8;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Resumen General</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:3px;width:33%;">
          <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:26px;font-weight:900;color:${eriColor(eriGlobal)};line-height:1;">${eriGlobal}%</div>
            <div style="font-size:10px;color:#64748b;font-weight:700;margin-top:3px;">ERI GLOBAL</div>
            <div style="font-size:9px;color:#94a3b8;">Exactitud inventario</div>
          </div>
        </td>
        <td style="padding:3px;width:33%;">
          <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:26px;font-weight:900;color:${pctColor(pctCumplimiento)};line-height:1;">${pctCumplimiento}%</div>
            <div style="font-size:10px;color:#64748b;font-weight:700;margin-top:3px;">CUMPLIMIENTO</div>
            <div style="font-size:9px;color:#94a3b8;">${cumplidos} de ${totalCumplimiento} tiendas</div>
          </div>
        </td>
        <td style="padding:3px;width:34%;">
          <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:17px;font-weight:900;color:${difColor(totalDifVal)};line-height:1;">${formatMoney(totalDifVal)}</div>
            <div style="font-size:10px;color:#64748b;font-weight:700;margin-top:3px;">DIF. VALORIZADA</div>
            <div style="font-size:9px;color:#94a3b8;">${faltTotal} falt. · ${sobTotal} sob.</div>
          </div>
        </td>
      </tr>
    </table>

    <div style="break-inside:avoid;page-break-inside:avoid;">
      <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #16a34a;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">ERI por Tienda (%)</h2>
      <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:20px;overflow:hidden;">${eriBars}</div>
    </div>

    <div style="break-inside:avoid;page-break-inside:avoid;">
      <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #7c3aed;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Cumplimiento por Tienda</h2>
      <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:20px;overflow:hidden;">${cumplBars}</div>
    </div>

    ${storesDif.length > 0 ? `
    <div style="break-inside:avoid;page-break-inside:avoid;">
      <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #dc2626;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Diferencia Valorizada por Tienda (S/)</h2>
      <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:20px;overflow:hidden;">${difBars}</div>
    </div>` : ""}

    <h2 style="margin:0 0 8px;font-size:12px;color:#0f172a;font-weight:800;border-left:3px solid #0f172a;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Detalle por Tienda que Cumplió</h2>
    <div style="border:1.5px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:8px 10px;text-align:left;color:#475569;font-size:10px;font-weight:700;letter-spacing:.5px;">TIENDA</th>
            <th style="padding:8px 6px;text-align:center;color:#475569;font-size:10px;font-weight:700;">ASIG.</th>
            <th style="padding:8px 6px;text-align:center;color:#16a34a;font-size:10px;font-weight:700;">OK</th>
            <th style="padding:8px 6px;text-align:center;color:#2563eb;font-size:10px;font-weight:700;">SOB.</th>
            <th style="padding:8px 6px;text-align:center;color:#dc2626;font-size:10px;font-weight:700;">FALT.</th>
            <th style="padding:8px 6px;text-align:center;color:#7c3aed;font-size:10px;font-weight:700;">DIF. VAL.</th>
            <th style="padding:8px 6px;text-align:center;color:#475569;font-size:10px;font-weight:700;">ERI%</th>
            <th style="padding:8px 6px;text-align:center;color:#475569;font-size:10px;font-weight:700;">CUMPL.</th>
          </tr>
        </thead>
        <tbody>${storeRows || `<tr><td colspan="8" style="padding:12px;text-align:center;color:#94a3b8;font-size:12px;">Ninguna tienda cumplió el conteo</td></tr>`}</tbody>
      </table>
    </div>

    ${noCumplieronRows ? `
    <h2 style="margin:0 0 8px;font-size:12px;color:#dc2626;font-weight:800;border-left:3px solid #dc2626;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">Tiendas que NO Cumplieron</h2>
    <div style="border:1.5px solid #fee2e2;border-radius:10px;overflow:hidden;margin-bottom:20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:#fef2f2;">
            <th style="padding:8px 10px;text-align:left;color:#dc2626;font-size:10px;font-weight:700;">TIENDA</th>
            <th style="padding:8px 6px;text-align:center;color:#dc2626;font-size:10px;font-weight:700;">ASIG.</th>
            <th style="padding:8px 6px;text-align:center;color:#dc2626;font-size:10px;font-weight:700;">CUMPL.</th>
          </tr>
        </thead>
        <tbody>${noCumplieronRows}</tbody>
      </table>
    </div>` : ""}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding-right:6px;vertical-align:top;width:50%;">
          <h2 style="margin:0 0 8px;font-size:12px;color:#dc2626;font-weight:800;border-left:3px solid #dc2626;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">🔴 Top 10 Faltantes</h2>
          <div style="border:1.5px solid #fee2e2;border-radius:10px;overflow:hidden;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:10px;">
              <thead><tr style="background:#fef2f2;">
                <th style="padding:6px 8px;text-align:left;color:#dc2626;font-size:9px;font-weight:700;">TIENDA</th>
                <th style="padding:6px;text-align:left;color:#dc2626;font-size:9px;font-weight:700;">SKU</th>
                <th style="padding:6px;text-align:left;color:#dc2626;font-size:9px;font-weight:700;">DESCRIPCIÓN</th>
                <th style="padding:6px;text-align:center;color:#dc2626;font-size:9px;font-weight:700;">DIF.</th>
                <th style="padding:6px;text-align:center;color:#dc2626;font-size:9px;font-weight:700;">S/</th>
              </tr></thead>
              <tbody>${faltantesRows}</tbody>
            </table>
          </div>
        </td>
        <td style="padding-left:6px;vertical-align:top;width:50%;">
          <h2 style="margin:0 0 8px;font-size:12px;color:#2563eb;font-weight:800;border-left:3px solid #2563eb;padding-left:10px;text-transform:uppercase;letter-spacing:.5px;">🔵 Top 10 Sobrantes</h2>
          <div style="border:1.5px solid #dbeafe;border-radius:10px;overflow:hidden;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:10px;">
              <thead><tr style="background:#eff6ff;">
                <th style="padding:6px 8px;text-align:left;color:#2563eb;font-size:9px;font-weight:700;">TIENDA</th>
                <th style="padding:6px;text-align:left;color:#2563eb;font-size:9px;font-weight:700;">SKU</th>
                <th style="padding:6px;text-align:left;color:#2563eb;font-size:9px;font-weight:700;">DESCRIPCIÓN</th>
                <th style="padding:6px;text-align:center;color:#2563eb;font-size:9px;font-weight:700;">DIF.</th>
                <th style="padding:6px;text-align:center;color:#2563eb;font-size:9px;font-weight:700;">S/</th>
              </tr></thead>
              <tbody>${sobrantesRows}</tbody>
            </table>
          </div>
        </td>
      </tr>
    </table>

    <div style="background:#fffbeb;border:1.5px solid #fcd34d;border-radius:10px;padding:12px 16px;margin-bottom:20px;">
      <p style="margin:0;font-size:11px;color:#92400e;line-height:1.7;">
        <strong>📋 Acciones requeridas:</strong><br>
        • Revisar con los jefes de tienda las diferencias de faltantes más significativas.<br>
        • Verificar ubicaciones en tiendas con ERI menor al 80%.<br>
        • Tiendas que no cumplieron deben reprogramar el conteo a la brevedad.
      </p>
    </div>
    `}

    <div style="border-top:1.5px solid #e2e8f0;padding-top:16px;">
      <p style="margin:0;font-size:12px;color:#475569;line-height:1.7;">
        Atentamente,<br>
        <strong style="color:#0f172a;">Analista de Inventarios</strong><br>
        <span style="color:#94a3b8;font-size:11px;">Área de Auditoría y Control de Inventarios · ${hoyLabel}</span>
      </p>
    </div>

  </div>

  <div style="background:#f8fafc;border-top:1.5px solid #e2e8f0;padding:12px 32px;text-align:center;">
    <p style="margin:0;font-size:10px;color:#94a3b8;">
      Generado automáticamente por el Sistema de Conteo Cíclico · Área de Auditoría y Control de Inventarios
    </p>
  </div>

</div>
</body></html>`;

  const [yyyy, mm, dd] = date.split("-");
  const subject = `Resumen Conteo Ciclico ${dd}.${mm}.${yyyy}`;

  return { html, subject, hasData };
}

type ProductDetailRow = { id: string; sku: string | null; description: string | null; unit: string | null; cost: unknown };

/**
 * Replica exportGlobal() (boton "Excel global" del dashboard) para un solo dia,
 * generando el .xlsx en memoria (sin canvas ni filesystem) para adjuntar al correo.
 */
export async function buildDailyDetailXlsxBuffer(supabase: SupabaseClient, date: string): Promise<Buffer | null> {
  const asgnRows = await fetchAllPages<AssignmentRow>((from, to) =>
    supabase
      .from("cyclic_assignments")
      .select("id, store_id, product_id, system_stock, assigned_date")
      .eq("assigned_date", date)
      .order("id")
      .range(from, to)
      .then(r => r.data)
  );
  if (asgnRows.length === 0) return null;

  const storeIds = [...new Set(asgnRows.map(a => a.store_id))];
  const prodIds = [...new Set(asgnRows.map(a => a.product_id))];

  let storesList: NameRow[] = [];
  for (let i = 0; i < storeIds.length; i += 500) {
    const { data } = await supabase.from("stores").select("id, name").in("id", storeIds.slice(i, i + 500));
    storesList = storesList.concat((data as NameRow[]) || []);
  }
  const storeMap = new Map(storesList.map(s => [s.id, s.name]));

  let prodsList: ProductDetailRow[] = [];
  for (let i = 0; i < prodIds.length; i += 500) {
    const { data } = await supabase.from("cyclic_products").select("id, sku, description, unit, cost").in("id", prodIds.slice(i, i + 500));
    prodsList = prodsList.concat((data as ProductDetailRow[]) || []);
  }
  const prodMap = new Map(prodsList.map(p => [p.id, p]));

  const asgnIds = asgnRows.map(a => a.id);
  let cntAll: CountRow[] = [];
  for (let i = 0; i < asgnIds.length; i += 500) {
    const chunk = asgnIds.slice(i, i + 500);
    const chunkCounts = await fetchAllPages<CountRow>((from, to) =>
      supabase.from("cyclic_counts").select("assignment_id, counted_quantity, location, status").in("assignment_id", chunk).range(from, to).then(r => r.data)
    );
    cntAll = cntAll.concat(chunkCounts);
  }

  const countMap = new Map<string, CountRow[]>();
  for (const c of cntAll.filter(c => !isSessionFlagLocation(c.location))) {
    if (!countMap.has(c.assignment_id)) countMap.set(c.assignment_id, []);
    countMap.get(c.assignment_id)!.push(c);
  }

  const asgnById = new Map(asgnRows.map(a => [a.id, a]));
  const recountDoneDayKeys = new Set<string>();
  const sessionFinishedDayKeys = new Set<string>();
  for (const c of cntAll) {
    if (c.location !== "__recount_done__" && c.location !== "__session_finished__") continue;
    const asg = asgnById.get(c.assignment_id);
    if (!asg) continue;
    const dayKey = `${asg.store_id}__${asg.assigned_date}`;
    if (c.location === "__recount_done__") recountDoneDayKeys.add(dayKey);
    if (c.location === "__session_finished__") sessionFinishedDayKeys.add(dayKey);
  }

  const dayProdsSet = new Map<string, Set<string>>();
  const dayProdsCountedSet = new Map<string, Set<string>>();
  for (const asg of asgnRows) {
    const dayKey = `${asg.store_id}__${asg.assigned_date}`;
    if (!dayProdsSet.has(dayKey)) { dayProdsSet.set(dayKey, new Set()); dayProdsCountedSet.set(dayKey, new Set()); }
    dayProdsSet.get(dayKey)!.add(asg.product_id);
    if ((countMap.get(asg.id) || []).length > 0) dayProdsCountedSet.get(dayKey)!.add(asg.product_id);
  }
  const cumplioByDayKey = new Set<string>();
  for (const [dayKey, prods] of dayProdsSet) {
    const counted = dayProdsCountedSet.get(dayKey)!;
    const allCounted = prods.size > 0 && counted.size === prods.size;
    if (recountDoneDayKeys.has(dayKey) || (sessionFinishedDayKeys.has(dayKey) && allCounted) || allCounted) {
      cumplioByDayKey.add(dayKey);
    }
  }

  type ExportRowAgg = {
    tienda: string; fecha: string; sku: string; descripcion: string; unidad: string;
    costo: number; stock_sistema: number; total_contado: number; cumplio: string;
  };
  const resMap = new Map<string, ExportRowAgg>();

  for (const asg of asgnRows) {
    const key = `${asg.store_id}__${asg.assigned_date}__${asg.product_id}`;
    const dayKey = `${asg.store_id}__${asg.assigned_date}`;
    const prod = prodMap.get(asg.product_id);
    const tienda = storeMap.get(asg.store_id) || asg.store_id;
    const costo = parseCost(prod?.cost);
    const stock = Number(asg.system_stock || 0);
    const cnts = countMap.get(asg.id) || [];
    const totalContado = cnts.reduce((s, c) => s + Number(c.counted_quantity), 0);
    const cumplioStr = cumplioByDayKey.has(dayKey) ? "SI" : "NO";

    if (!resMap.has(key)) {
      resMap.set(key, {
        tienda, fecha: asg.assigned_date,
        sku: prod?.sku || asg.product_id,
        descripcion: prod?.description || "",
        unidad: prod?.unit || "",
        costo, stock_sistema: stock, total_contado: 0, cumplio: cumplioStr,
      });
    }
    const row = resMap.get(key)!;
    row.total_contado += totalContado;
    if (costo > 0 && row.costo === 0) row.costo = costo;
  }

  const exportRows = [...resMap.values()].map(r => {
    const diferencia = r2(r.total_contado - r.stock_sistema);
    const dif_valorizada = r2(diferencia * r.costo);
    const estado = r.cumplio === "NO" ? "NO CONTADO" : diferencia === 0 ? "OK" : diferencia > 0 ? "SOBRANTE" : "FALTANTE";
    return {
      TIENDA: r.tienda,
      FECHA_ASIGNACION: r.fecha,
      SKU: r.sku,
      DESCRIPCION: r.descripcion,
      UNIDAD: r.unidad,
      COSTO: r.costo,
      STOCK: r.stock_sistema,
      CONTEO: r.total_contado,
      DIFERENCIA: diferencia,
      ESTADO: estado,
      DIF_VALORIZADA: dif_valorizada,
      CUMPLIO: r.cumplio,
    };
  }).sort((a, b) => (a.TIENDA + a.FECHA_ASIGNACION + a.SKU).localeCompare(b.TIENDA + b.FECHA_ASIGNACION + b.SKU));

  const ws = XLSX.utils.json_to_sheet(exportRows);
  const wbk = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbk, ws, "Detalle Códigos");
  const buffer = XLSX.write(wbk, { type: "buffer", bookType: "xlsx" });
  return buffer as Buffer;
}
