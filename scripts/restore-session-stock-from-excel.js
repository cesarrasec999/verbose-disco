/* eslint-disable @typescript-eslint/no-require-imports */
/*
 * Restaura exclusivamente la foto de STOCK_SISTEMA de una sesión de inventario
 * desde su Excel de cierre. No escribe en conteos, reconteos ni validaciones.
 *
 * Uso:
 *   node scripts/restore-session-stock-from-excel.js --session=<uuid> --file="C:\\archivo.xlsx" --apply
 * Sin --apply solo valida y muestra el resultado esperado.
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
  }
}
loadEnv(path.join(process.cwd(), ".env"));
loadEnv(path.join(process.cwd(), ".env.local"));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRole) throw new Error("Faltan credenciales de Supabase en .env.local.");
const supabase = createClient(supabaseUrl, serviceRole);
const BATCH_SIZE = 300;

function arg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find(item => item.startsWith(prefix));
  return value ? value.slice(prefix.length).replace(/^"|"$/g, "") : "";
}
function code(value) { return String(value || "").trim().toUpperCase(); }
function number(value) {
  const parsed = Number(String(value ?? "0").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function loadExcel(file) {
  const workbook = XLSX.readFile(file);
  const sheet = workbook.Sheets.Resumen || workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const bySku = new Map();
  for (const row of rows) {
    const sku = code(row.CODIGO);
    // RMS también maneja algunos códigos numéricos puros (por ejemplo 000035966).
    if (!sku || sku === "-" || sku === "TOTAL") continue;
    if (bySku.has(sku)) throw new Error(`El Excel contiene más de una fila para ${sku}.`);
    bySku.set(sku, {
      sku,
      system_stock: number(row.STOCK_SISTEMA),
      description: String(row.DESCRIPCION || "").trim(),
      unit: String(row.UM || "").trim(),
      cost: number(row.COSTO),
    });
  }
  if (!bySku.size) throw new Error("No se encontraron filas válidas con CODIGO y STOCK_SISTEMA en la hoja Resumen.");
  return [...bySku.values()];
}

async function paged(table, select, sessionId) {
  const result = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).eq("session_id", sessionId).range(from, from + 999);
    if (error) throw error;
    result.push(...(data || []));
    if ((data || []).length < 1000) return result;
  }
}

async function main() {
  const sessionId = arg("session");
  const file = arg("file");
  const apply = process.argv.includes("--apply");
  if (!sessionId) throw new Error("Indica --session=<uuid>.");
  if (!file || !fs.existsSync(file)) throw new Error("Indica un Excel existente con --file=.");

  const excelRows = loadExcel(file);
  const [{ data: session, error: sessionError }, snapshotRows, countInfo] = await Promise.all([
    supabase.from("general_inventory_sessions").select("id,status,stock_frozen_at,stores(name)").eq("id", sessionId).single(),
    paged("general_inventory_stock_snapshot", "id,product_id,sku,system_stock", sessionId),
    supabase.from("general_inventory_counts").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
  ]);
  if (sessionError) throw sessionError;
  if (countInfo.error) throw countInfo.error;

  const existingBySku = new Map(snapshotRows.map(row => [code(row.sku), row]));
  const missingSkus = excelRows.filter(row => !existingBySku.has(row.sku)).map(row => row.sku);
  const productsBySku = new Map();
  for (const group of chunks(missingSkus, 500)) {
    if (!group.length) continue;
    const { data, error } = await supabase
      .from("cyclic_products")
      .select("id,sku,description,unit,cost,is_active")
      .in("sku", group);
    if (error) throw error;
    for (const product of data || []) {
      const key = code(product.sku);
      const prior = productsBySku.get(key);
      if (!prior || (product.is_active && !prior.is_active)) productsBySku.set(key, product);
    }
  }
  const unresolved = missingSkus.filter(sku => !productsBySku.has(sku));
  if (unresolved.length) throw new Error(`No se pudo vincular ${unresolved.length} códigos del Excel al maestro: ${unresolved.slice(0, 10).join(", ")}`);

  const changes = excelRows.filter(row => Number(existingBySku.get(row.sku)?.system_stock ?? NaN) !== row.system_stock);
  const extras = snapshotRows.filter(row => !excelRows.some(excel => excel.sku === code(row.sku)));
  console.log(JSON.stringify({
    session: { id: session.id, store: session.stores?.name || "", status: session.status },
    excel_codes: excelRows.length,
    snapshot_codes_before: snapshotRows.length,
    stock_changes_needed: changes.length,
    snapshot_rows_to_add: missingSkus.length,
    extra_snapshot_rows_untouched: extras.length,
    count_records_before: countInfo.count || 0,
    mode: apply ? "APPLY" : "DRY_RUN",
  }, null, 2));
  if (!apply) return;

  const now = new Date().toISOString();
  const updateRows = changes
    .filter(row => existingBySku.has(row.sku))
    .map(row => ({ id: existingBySku.get(row.sku).id, system_stock: row.system_stock, frozen_at: now }));
  for (const group of chunks(updateRows, BATCH_SIZE)) {
    // update individual rows to guarantee this script changes only system_stock/frozen_at.
    for (const row of group) {
      const { error } = await supabase
        .from("general_inventory_stock_snapshot")
        .update({ system_stock: row.system_stock, frozen_at: row.frozen_at })
        .eq("id", row.id)
        .eq("session_id", sessionId);
      if (error) throw error;
    }
  }

  const insertRows = excelRows
    .filter(row => !existingBySku.has(row.sku))
    .map(row => {
      const product = productsBySku.get(row.sku);
      return {
        session_id: sessionId,
        product_id: product.id,
        sku: row.sku,
        description: row.description || product.description || "",
        unit: row.unit || product.unit || "",
        system_stock: row.system_stock,
        cost: row.cost || product.cost || 0,
        frozen_at: now,
      };
    });
  for (const group of chunks(insertRows, BATCH_SIZE)) {
    const { error } = await supabase.from("general_inventory_stock_snapshot").upsert(group, { onConflict: "session_id,product_id" });
    if (error) throw error;
  }

  const [afterSnapshot, afterCounts] = await Promise.all([
    paged("general_inventory_stock_snapshot", "sku,system_stock", sessionId),
    supabase.from("general_inventory_counts").select("id", { count: "exact", head: true }).eq("session_id", sessionId),
  ]);
  if (afterCounts.error) throw afterCounts.error;
  const afterBySku = new Map(afterSnapshot.map(row => [code(row.sku), Number(row.system_stock || 0)]));
  const discrepancies = excelRows.filter(row => afterBySku.get(row.sku) !== row.system_stock);
  if (discrepancies.length || afterCounts.count !== countInfo.count) {
    throw new Error(`Verificación falló: ${discrepancies.length} stocks distintos; conteos antes/después ${countInfo.count}/${afterCounts.count}.`);
  }
  console.log(JSON.stringify({
    result: "OK",
    snapshot_codes_after: afterSnapshot.length,
    excel_rows_verified: excelRows.length,
    count_records_before: countInfo.count || 0,
    count_records_after: afterCounts.count || 0,
    modified_stock_rows: updateRows.length,
    added_snapshot_rows: insertRows.length,
  }, null, 2));
}

main().catch(error => { console.error("RESTORE_FAILED:", error.message || error); process.exitCode = 1; });
