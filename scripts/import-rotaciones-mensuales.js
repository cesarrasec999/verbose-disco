/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function normalizeStoreKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeCode(value) {
  return normalizeText(value).toUpperCase();
}

function parseMonth(value) {
  const month = normalizeText(value);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("El periodo debe tener formato YYYY-MM. Ejemplo: 2026-05");
  }
  return `${month}-01`;
}

async function main() {
  loadEnv(path.resolve(process.cwd(), ".env.local"));
  const [excelPathArg, periodArg] = process.argv.slice(2);
  if (!excelPathArg || !periodArg) {
    throw new Error('Uso: node scripts\\import-rotaciones-mensuales.js ".\\imports\\rotaciones\\ROT TIENDA MAY.xlsx" 2026-05');
  }

  const excelPath = path.resolve(process.cwd(), excelPathArg);
  const periodMonth = parseMonth(periodArg);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.local.");
  }
  if (!fs.existsSync(excelPath)) {
    throw new Error(`No existe el archivo: ${excelPath}`);
  }

  const workbook = XLSX.readFile(excelPath, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const headers = (rows[0] || []).map(normalizeText);
  if (headers.length < 4) {
    throw new Error("El Excel debe tener CODIGO, Descripcion, Pres. y al menos una tienda.");
  }

  const storeHeaders = headers.slice(3).filter(Boolean);
  const storeKeys = [...new Set(storeHeaders.map(normalizeStoreKey).filter(Boolean))];
  const payload = [];
  for (const row of rows.slice(1)) {
    const productCode = normalizeCode(row[0]);
    if (!productCode) continue;
    const description = normalizeText(row[1]);
    const unit = normalizeText(row[2]).toUpperCase();
    for (let index = 0; index < storeHeaders.length; index += 1) {
      const storeName = storeHeaders[index];
      const rotationCategory = normalizeText(row[index + 3]).toUpperCase();
      if (!rotationCategory) continue;
      payload.push({
        period_month: periodMonth,
        store_key: normalizeStoreKey(storeName),
        store_name: storeName,
        product_code: productCode,
        description,
        unit,
        rotation_category: rotationCategory,
        source_name: path.basename(excelPath),
        updated_at: new Date().toISOString(),
      });
    }
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  console.log(`Periodo: ${periodMonth}`);
  console.log(`Tiendas en Excel: ${storeHeaders.length}`);
  console.log(`Registros a importar: ${payload.length.toLocaleString("es-PE")}`);

  if (payload.length === 0) {
    console.log("No hay rotaciones para importar.");
    return;
  }

  for (let i = 0; i < storeKeys.length; i += 50) {
    const { error } = await supabase
      .from("product_rotation_monthly")
      .delete()
      .eq("period_month", periodMonth)
      .in("store_key", storeKeys.slice(i, i + 50));
    if (error) throw new Error(`No se pudo limpiar el periodo anterior: ${error.message}`);
  }

  for (let i = 0; i < payload.length; i += 500) {
    const batch = payload.slice(i, i + 500);
    const { error } = await supabase
      .from("product_rotation_monthly")
      .upsert(batch, { onConflict: "period_month,store_key,product_code" });
    if (error) throw new Error(`Error importando lote ${Math.floor(i / 500) + 1}: ${error.message}`);
    console.log(`Insertado ${Math.min(i + batch.length, payload.length).toLocaleString("es-PE")} / ${payload.length.toLocaleString("es-PE")}`);
  }

  console.log("Rotaciones mensuales importadas correctamente.");
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
