/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

function loadEnv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (!process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

const text = (value) => String(value ?? "").trim();
const upper = (value) => text(value).toUpperCase();
const allowedCategories = new Set(["A", "B", "C", "D", "E", "X", "P", "SR", "NUEVO"]);

function parseMonth(value) {
  const month = text(value);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("El periodo debe tener formato YYYY-MM.");
  return `${month}-01`;
}

async function readAll(supabase, table, columns, orderColumn) {
  const result = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (orderColumn) query = query.order(orderColumn, { ascending: true });
    const { data, error } = await query;
    if (error) throw error;
    result.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return result;
}

async function insertBatches(supabase, table, batches, concurrency = 4) {
  let next = 0;
  let inserted = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= batches.length) return;
      const batch = batches[index];
      const { error } = await supabase.from(table).insert(batch);
      if (error) throw new Error(`Error en lote ${index + 1}: ${error.message}`);
      inserted += batch.length;
      if (inserted % 20000 < batch.length) console.log(`Staging: ${inserted.toLocaleString("es-PE")} filas`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  return inserted;
}

async function managementQuery(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    const response = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Management API ${response.status}: ${body}`);
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const excelArg = args.find((arg) => !arg.startsWith("--"));
  const periodArg = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
  const apply = args.includes("--apply");
  const envArg = args.find((arg) => arg.startsWith("--env="));
  const envPath = envArg ? envArg.slice("--env=".length) : "//192.168.5.53/Users/cesar.quispe/erp-sync/.env";
  if (!excelArg || !periodArg) {
    throw new Error('Uso: node scripts/import-rotaciones-mensuales-seguro.js "archivo.xlsx" YYYY-MM [--apply] [--env=ruta]');
  }

  loadEnv(path.resolve(process.cwd(), ".env.local"));
  loadEnv(envPath);
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE", "SUPABASE_PROJECT_REF", "SUPABASE_MANAGEMENT_TOKEN"];
  for (const key of required) if (!process.env[key]) throw new Error(`Falta ${key}`);

  const excelPath = path.resolve(excelArg);
  const periodMonth = parseMonth(periodArg);
  const sourceName = path.basename(excelPath);
  const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(excelPath)).digest("hex");
  const workbook = XLSX.readFile(excelPath, { cellDates: false });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "", raw: false });
  const headers = (rows[0] || []).map(text);
  const storeHeaders = headers.slice(3).filter(Boolean);
  const dataRows = rows.slice(1).filter((row) => text(row[0]));
  if (!dataRows.length || !storeHeaders.length) throw new Error("El Excel no contiene productos o tiendas.");

  const codeCounts = new Map();
  for (const row of dataRows) codeCounts.set(upper(row[0]), (codeCounts.get(upper(row[0])) || 0) + 1);
  const duplicates = [...codeCounts].filter(([, count]) => count > 1).map(([code]) => code);
  if (duplicates.length) throw new Error(`Códigos duplicados en Excel: ${duplicates.slice(0, 20).join(", ")}`);
  if (new Set(storeHeaders.map(upper)).size !== storeHeaders.length) throw new Error("Hay tiendas duplicadas en el encabezado.");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const [products, stores] = await Promise.all([
    readAll(supabase, "cyclic_products", "sku,erp_sku,description,unit,is_active", "sku"),
    readAll(supabase, "stores", "name,erp_sede,is_active", "name"),
  ]);
  const productsByCode = new Map();
  for (const product of products) {
    for (const key of [product.sku, product.erp_sku].map(upper).filter(Boolean)) {
      if (!productsByCode.has(key)) productsByCode.set(key, product);
    }
  }
  const activeStores = new Set(stores.filter((store) => store.is_active).flatMap((store) => [store.name, store.erp_sede].map(upper).filter(Boolean)));
  const missingCodes = [...codeCounts.keys()].filter((code) => !productsByCode.has(code));
  const inactiveCodes = [...codeCounts.keys()].filter((code) => productsByCode.has(code) && !productsByCode.get(code).is_active);
  const missingStores = storeHeaders.filter((store) => !activeStores.has(upper(store)));
  if (missingCodes.length) throw new Error(`Códigos fuera del maestro: ${missingCodes.slice(0, 20).join(", ")}`);
  if (inactiveCodes.length) throw new Error(`Códigos inactivos: ${inactiveCodes.slice(0, 20).join(", ")}`);
  if (missingStores.length) throw new Error(`Tiendas no reconocidas: ${missingStores.join(", ")}`);

  const categoryCounts = {};
  const batches = [];
  let batch = [];
  for (let storeIndex = 0; storeIndex < storeHeaders.length; storeIndex += 1) {
    const storeName = storeHeaders[storeIndex];
    for (const row of dataRows) {
      const productCode = upper(row[0]);
      const product = productsByCode.get(productCode);
      const category = upper(row[storeIndex + 3]);
      if (!allowedCategories.has(category)) throw new Error(`Categoría inválida ${category || "(vacía)"} para ${productCode} / ${storeName}`);
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      batch.push({
        store_key: storeName,
        store_name: storeName,
        product_code: upper(product.sku || product.erp_sku || productCode),
        description: text(row[1]) || text(product.description),
        unit: upper(row[2]) || upper(product.unit),
        rotation_category: category,
      });
      if (batch.length === 1000) {
        batches.push(batch);
        batch = [];
      }
    }
  }
  if (batch.length) batches.push(batch);
  const expectedRows = dataRows.length * storeHeaders.length;
  const summary = { periodMonth, sourceName, sourceSha256, products: dataRows.length, stores: storeHeaders.length, expectedRows, categoryCounts };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log("Validación terminada. Agrega --apply para cargar y aplicar la importación.");
    return;
  }

  const { data: existing, error: existingError } = await supabase
    .from("product_rotation_import_runs")
    .select("id,status,applied_at")
    .eq("period_month", periodMonth)
    .eq("source_sha256", sourceSha256)
    .eq("status", "applied")
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.length) {
    console.log(`Este archivo ya fue aplicado en la importación ${existing[0].id}.`);
    return;
  }

  const { data: run, error: runError } = await supabase.from("product_rotation_import_runs").insert({
    period_month: periodMonth,
    source_name: sourceName,
    source_sha256: sourceSha256,
    expected_rows: expectedRows,
    metadata: { products: dataRows.length, stores: storeHeaders, categoryCounts },
  }).select("id").single();
  if (runError) throw runError;

  try {
    for (const rows of batches) for (const row of rows) row.run_id = run.id;
    const inserted = await insertBatches(supabase, "product_rotation_import_staging", batches, 4);
    await supabase.from("product_rotation_import_runs").update({ staged_rows: inserted }).eq("id", run.id);
    const applied = await managementQuery(`set statement_timeout = '10min'; select public.apply_product_rotation_import('${run.id}'::uuid) as result;`);
    console.log("Aplicación atómica:", JSON.stringify(applied));

    const verification = await managementQuery(`
      select jsonb_build_object(
        'run', (select to_jsonb(r) from public.product_rotation_import_runs r where r.id='${run.id}'::uuid),
        'period', (select jsonb_build_object(
          'rows', count(*),
          'stores', count(distinct store_key),
          'products', count(distinct product_code),
          'sources', jsonb_agg(distinct source_name)
        ) from public.product_rotation_monthly
          where period_month='${periodMonth}'::date and store_key=any(array[${storeHeaders.map((name) => `'${name.replaceAll("'", "''")}'`).join(",")}]))
      );
    `);
    console.log("Verificación:", JSON.stringify(verification));
  } catch (error) {
    await supabase.from("product_rotation_import_runs").update({ status: "failed", error_message: String(error.message || error).slice(0, 2000) }).eq("id", run.id);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
