/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

export const maxDuration = 300;

const norm = (value: unknown) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const skuOf = (value: unknown) => String(value || "").trim().toUpperCase();
const FLAGS = new Set(["__session_counting__", "__session_finished__", "__recount_started__", "__recount_done__"]);
const aliases = ["ARBOLEDA", "CALLAO", "GRUPO", "LURIN", "PIURA", "TRUJILLO", "LEGUIA", "CHORRILLOS", "AREQUIPA NEW K 21", "VILLA EL SALVADOR", "SUMINISTRO", "DIAMANTE", "HUANCAYO", "NARANJAL", "PTE PIEDRA", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA", "HUACHIPA", "AREQUIPA MIRAFLORES", "CAJAMARCA", "CD"];

async function readPages<T>(factory: (from: number, to: number) => any) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await factory(from, from + 999);
    if (error) throw error;
    rows.push(...((data || []) as T[]));
    if (!data || data.length < 1000) return rows;
  }
}

async function readInChunks<T>(values: string[], loader: (chunk: string[]) => Promise<T[]>) {
  const result: T[] = [];
  for (let i = 0; i < values.length; i += 100) {
    const batch = values.slice(i, i + 100);
    result.push(...await loader(batch));
  }
  return result;
}

export async function GET() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  try {
    const stores = await readPages<any>((from, to) => supabase.from("stores").select("id,name,erp_sede,code,is_active").eq("is_active", true).order("name").range(from, to));
    const products = await readPages<any>((from, to) => supabase.from("cyclic_products").select("id,sku,description,unit,cost").eq("is_active", true).range(from, to));
    const productBySku = new Map(products.map(product => [norm(product.sku), product]));

    const assignments = await readPages<any>((from, to) => supabase.from("cyclic_assignments").select("id,store_id,product_id").range(from, to));
    const assignmentIds = assignments.map(row => String(row.id)).filter(Boolean);
    const cyclicCounts = await readInChunks<any>(assignmentIds, chunk => readPages<any>((from, to) => supabase.from("cyclic_counts").select("assignment_id,location").in("assignment_id", chunk).range(from, to)));
    const countedAssignments = new Set(cyclicCounts.filter(row => !FLAGS.has(String(row.location || ""))).map(row => String(row.assignment_id)));
    const cyclicSampled = new Set(assignments.filter(row => countedAssignments.has(String(row.id))).map(row => `${row.store_id}|${row.product_id}`));

    const sessions = await readPages<any>((from, to) => supabase.from("audit_sessions").select("id,store_id").eq("status", "finished").range(from, to));
    const sessionIds = sessions.map(row => String(row.id)).filter(Boolean); const sessionStore = new Map(sessions.map(row => [String(row.id), String(row.store_id)]));
    const auditChunks = await readInChunks<any>(sessionIds, async chunk => (await readPages<any>((from, to) => supabase.from("audit_session_items").select("id,session_id,product_id").in("session_id", chunk).range(from, to))).concat(await readPages<any>((from, to) => supabase.from("audit_counts").select("item_id").in("session_id", chunk).range(from, to))));
    const auditItems = auditChunks.filter(row => row.product_id !== undefined); const auditCounts = auditChunks.filter(row => row.item_id !== undefined);
    const countedAuditItems = new Set(auditCounts.map(row => String(row.item_id)));
    const auditSampled = new Set(auditItems.filter(row => countedAuditItems.has(String(row.id))).map(row => `${sessionStore.get(String(row.session_id))}|${row.product_id}`));

    const detail: any[] = [];
    for (const store of stores) {
      const sede = String(store.erp_sede || store.name || "");
      const stockRows = await readPages<any>((from, to) => supabase.from("stock_general").select("codsap,stock").eq("sede", sede).range(from, to));
      const sourceNames = [store.name, store.code, store.erp_sede].filter(Boolean).map(norm);
      const keys = [...new Set([...sourceNames, ...aliases.filter(alias => sourceNames.some(source => source.includes(norm(alias))))])];
      const rotations = await readPages<any>((from, to) => supabase.from("product_rotation_monthly").select("product_code,rotation_category,period_month,store_key").in("store_key", keys).order("period_month", { ascending: false }).range(from, to));
      const rotationBySku = new Map<string, string>();
      for (const row of rotations) if (!rotationBySku.has(norm(row.product_code))) rotationBySku.set(norm(row.product_code), String(row.rotation_category || "SIN ROTACION"));
      for (const stock of stockRows) {
        const sku = skuOf(stock.codsap); const product = productBySku.get(norm(sku)); if (!product) continue;
        const productId = String(product.id); const value = Number(stock.stock || 0) * Number(product.cost || 0); const cyclic = cyclicSampled.has(`${store.id}|${productId}`); const audit = auditSampled.has(`${store.id}|${productId}`);
        detail.push({ TIENDA: store.name, CODIGO: sku, DESCRIPCION: product.description || "", UNIDAD: product.unit || "", ROTACION: rotationBySku.get(norm(sku)) || "SIN ROTACION", STOCK: Number(stock.stock || 0), COSTO: Number(product.cost || 0), VALORIZADO: value, "MUESTREADO CICLICO": cyclic ? "SI" : "NO", "MUESTREADO AUDITORIA": audit ? "SI" : "NO", MUESTREADO: cyclic || audit ? "SI" : "NO", _store_id: store.id });
      }
    }
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
