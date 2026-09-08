/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { mapBounded } from "@/lib/boundedReads";
import { bonusSqlMapping } from "@/features/bono/storeMapping";

export const maxDuration = 300;

const latestClosedRotationPeriod = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

async function readPages<T>(factory: (from: number, to: number) => any) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await factory(from, from + 999);
    if (error) throw error;
    rows.push(...((data || []) as T[]));
    if (!data || data.length < 1000) return rows;
  }
}

export async function GET() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  try {
    const stores = await readPages<any>((from, to) => supabase.from("stores").select("id,name,erp_sede,code,is_active").eq("is_active", true).order("name").range(from, to));
    const rotationCutoff = latestClosedRotationPeriod();
    const perStore = await mapBounded(stores, async store => {
      const stockRows = await readPages<any>((from) => supabase.rpc("get_analysis_coverage_products_v2", { p_store_id: store.id, p_limit: 1000, p_offset: from }));
      const sqlKeys = bonusSqlMapping([store])[0].keys;
      const { data: lastPeriod, error } = await supabase.from("product_rotation_monthly").select("period_month").in("store_key", sqlKeys).lt("period_month", rotationCutoff).order("period_month", { ascending: false }).limit(1);
      if (error) throw error;
      const rotations = lastPeriod?.[0] ? await readPages<any>((from, to) => supabase.from("product_rotation_monthly").select("product_code,rotation_category").in("store_key", sqlKeys).eq("period_month", lastPeriod[0].period_month).order("store_key").order("product_code").range(from, to)) : [];
      const rotation = new Map(rotations.map(row => [String(row.product_code), String(row.rotation_category)]));
      return stockRows.map(row => ({
        TIENDA: store.name, CODIGO: row.sku, DESCRIPCION: row.description, UNIDAD: row.unit,
        ROTACION: rotation.get(row.sku) || "SIN ROTACION", STOCK: Number(row.stock),
        COSTO: row.cost == null ? "Sin costo ERP" : Number(row.cost),
        VALORIZADO: row.cost == null ? null : Number(row.stock) * Number(row.cost),
        "MUESTREADO CICLICO": row.cyclic_sampled ? "SI" : "NO",
        "MUESTREADO AUDITORIA": row.audit_sampled ? "SI" : "NO",
        MUESTREADO: row.cyclic_sampled || row.audit_sampled ? "SI" : "NO", _store_id: store.id,
      }));
    }, 2);
    const detail: any[] = perStore.flat();
    detail.sort((a, b) => Number(b.VALORIZADO) - Number(a.VALORIZADO) || String(a.TIENDA).localeCompare(String(b.TIENDA)));
    const totalValue = detail.reduce((sum, row) => sum + Number(row.VALORIZADO || 0), 0); let cumulative = 0;
    const exportDetail = detail.map(row => { const pct = totalValue ? Number(row.VALORIZADO) / totalValue * 100 : 0; cumulative += pct; const clean = { ...row }; delete clean._store_id; return { ...clean, "% TOTAL": `${pct.toFixed(2)}%`, "% ACUMULADO": `${cumulative.toFixed(2)}%` }; });
    const summary = new Map<string, any>();
    for (const row of detail) { const key = `${row._store_id}|${row.ROTACION}`; const current = summary.get(key) || { TIENDA: row.TIENDA, ROTACION: row.ROTACION, "CODIGOS TOTALES": 0, MUESTREADOS: 0, "NO MUESTREADOS": 0 }; current["CODIGOS TOTALES"] += 1; if (row.MUESTREADO === "SI") current.MUESTREADOS += 1; else current["NO MUESTREADOS"] += 1; summary.set(key, current); }
    const summaryRows = [...summary.values()].map(row => ({ ...row, "% MUESTREADO": row["CODIGOS TOTALES"] ? `${(row.MUESTREADOS / row["CODIGOS TOTALES"] * 100).toFixed(2)}%` : "0.00%" }));
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportDetail), "Maestro productos"); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "Resumen cobertura");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    return new Response(buffer, { status: 200, headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="maestro_muestreo_${new Date().toISOString().slice(0, 10)}.xlsx"`, "Cache-Control": "no-store" } });
  } catch (error: any) { return Response.json({ error: error.message || String(error) }, { status: 500 }); }
}
