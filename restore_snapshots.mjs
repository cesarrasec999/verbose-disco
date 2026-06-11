import { readFileSync, readdirSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx";
import { join } from "path";

const SUPABASE_URL = "https://ejrttyzvvhaumdocxpei.supabase.co";
const SERVICE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqcnR0eXp2dmhhdW1kb2N4cGVpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njc5MDY5MywiZXhwIjoyMDkyMzY2NjkzfQ.NOYBMl97Y9JUtLYuRdm1GwY6MUf1lCwliNeo-m6Nl54";
const SNAPSHOTS_DIR = "\\\\192.168.5.53\\Users\\cesar.quispe\\erp-sync\\stock-snapshots";
const BATCH_SIZE = 500;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// Solo fechas eliminadas
const MISSING_DATES = [
  "2026-05-04","2026-05-05","2026-05-06","2026-05-07","2026-05-08",
  "2026-05-09","2026-05-10","2026-05-11","2026-05-12","2026-05-13",
  "2026-05-14","2026-05-15","2026-05-16","2026-05-17","2026-05-18",
  "2026-05-19","2026-05-20","2026-05-21","2026-05-22","2026-05-23",
  "2026-05-24",
];

async function processDate(dateStr) {
  const dateDir = join(SNAPSHOTS_DIR, dateStr);
  const files = readdirSync(dateDir);
  const xlsxFile = files.find(f => f.endsWith(".xlsx"));
  if (!xlsxFile) { console.log(`  [SKIP] Sin xlsx en ${dateStr}`); return; }

  const filePath = join(dateDir, xlsxFile);
  console.log(`  Leyendo ${xlsxFile}...`);

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  if (rows.length === 0) { console.log(`  [SKIP] Sin filas`); return; }

  // Extraer hora del nombre del archivo (ej: _0800)
  const timeMatch = xlsxFile.match(/_(\d{4})\.xlsx$/);
  const snapshotTime = timeMatch
    ? `${timeMatch[1].slice(0,2)}:${timeMatch[1].slice(2)}:00`
    : "08:00:00";

  // Calcular totales para el padre
  const totalStores = new Set(rows.map(r => r["Tienda codigo"])).size;
  const totalCodes  = new Set(rows.map(r => r["Cod.Sap"])).size;
  const totalUnits  = rows.reduce((s, r) => s + Number(r["Stock"] || 0), 0);
  const totalValue  = rows.reduce((s, r) => s + Number(r["Valor sistema"] || 0), 0);

  // 1. Crear snapshot padre
  const { data: snap, error: snapErr } = await supabase
    .from("inventory_valuation_snapshots")
    .insert({
      snapshot_date: dateStr,
      snapshot_time: snapshotTime,
      source_name: xlsxFile,
      total_stores: totalStores,
      total_codes: totalCodes,
      total_units: totalUnits,
      total_value: totalValue,
    })
    .select("id")
    .single();

  if (snapErr) {
    console.error(`  [ERROR] Snapshot padre: ${snapErr.message}`);
    return;
  }

  const snapshotId = snap.id;
  console.log(`  Snapshot creado: ${snapshotId} — ${rows.length} filas`);

  // 2. Insertar productos en lotes
  const products = rows.map(r => ({
    snapshot_id:     snapshotId,
    snapshot_date:   dateStr,
    snapshot_time:   snapshotTime,
    store_key:       String(r["Tienda codigo"] || ""),
    store_name:      String(r["Tienda"] || ""),
    sede:            String(r["Tienda codigo"] || ""),
    product_code:    String(r["Cod.Sap"] || ""),
    description:     String(r["Descripcion"] || ""),
    unit:            String(r["UM"] || ""),
    stock:           Number(r["Stock"] || 0),
    cost:            Number(r["Costo"] || 0),
    inventory_value: Number(r["Valor sistema"] || 0),
    source_name:     xlsxFile,
  }));

  let inserted = 0;
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from("inventory_valuation_snapshot_products").insert(batch);
    if (error) {
      console.error(`  [ERROR] Lote ${i}-${i+BATCH_SIZE}: ${error.message}`);
      return;
    }
    inserted += batch.length;
    process.stdout.write(`\r  Insertando... ${inserted}/${products.length}`);
  }
  console.log(`\r  ✓ ${inserted} filas insertadas`);
}

async function main() {
  console.log(`Restaurando ${MISSING_DATES.length} snapshots eliminados...\n`);
  for (const date of MISSING_DATES) {
    console.log(`[${date}]`);
    await processDate(date);
  }
  console.log("\n✓ Restauración completada.");
}

main().catch(console.error);
