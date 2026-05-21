/* eslint-disable @typescript-eslint/no-require-imports */
/*
  Importa la fotografia diaria de stock por codigo desde el Excel exportado.

  Uso individual:
    node scripts/import-stock-snapshot-excel.js --file="C:\ruta\STOCK.xlsx" --date=2026-05-21

  Uso por carpeta historica:
    node import-stock-snapshot-excel.js --dir="C:\RMS\CESAR\erp-sync\stock-snapshots"

  Columnas aceptadas (nombres flexibles):
    tienda/sede/almacen, codigo/codsap/sku, descripcion, unidad/um, stock/cantidad/unidades, costo, valorizado
*/

require("dotenv").config();
require("dotenv").config({ path: ".env.local" });

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRole) {
  throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL y SUPABASE_SERVICE_ROLE en el entorno.");
}

const supabase = createClient(supabaseUrl, serviceRole);
const BATCH_SIZE = Number(process.env.UPSERT_BATCH_SIZE || 1000);

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find(item => item.startsWith(prefix));
  return found ? found.slice(prefix.length).replace(/^"|"$/g, "") : fallback;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isValidProductCode(value) {
  const code = cleanCode(value);
  if (!code || code === "0" || code === "-" || code === "N/A") return false;
  return /[A-Z]/i.test(code) && /[0-9]/.test(code);
}

function parseNumber(value) {
  const raw = String(value ?? "0").replace(/S\/|\s|,/gi, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function r2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function findHeader(headers, names) {
  const wanted = names.map(normalizeText);
  const exact = headers.findIndex(header => wanted.includes(header));
  if (exact >= 0) return exact;
  return headers.findIndex(header => wanted.some(name => header.includes(name)));
}

function cell(row, headers, names) {
  const index = findHeader(headers, names);
  return index >= 0 ? row[index] : "";
}

function storeKeysForStore(store) {
  const aliases = [
    "ARBOLEDA", "CALLAO", "GRUPO", "LURIN", "PIURA", "TRUJILLO", "LEGUIA", "CHORRILLOS",
    "AREQUIPA NEW K 21", "VILLA EL SALVADOR", "SUMINISTRO", "DIAMANTE", "HUANCAYO",
    "NARANJAL", "PTE PIEDRA", "PUENTE PIEDRA", "ARRIOLA", "SURQUILLO", "PERLA",
    "HUACHIPA", "AREQUIPA MIRAFLORES", "CAJAMARCA", "CD",
  ];
  const keys = new Set();
  for (const source of [store.name, store.erp_sede, store.code, store.erp_store_no].filter(Boolean)) {
    const normalized = normalizeText(source);
    if (!normalized) continue;
    keys.add(normalized);
    for (const alias of aliases) {
      const normalizedAlias = normalizeText(alias);
      if (normalized.includes(normalizedAlias)) keys.add(normalizedAlias);
    }
    if (normalized.includes("EVITAMIENTO")) keys.add("AREQUIPA NEW K 21");
    if (normalized.includes("MIRAFLORES")) keys.add("AREQUIPA MIRAFLORES");
    if (normalized.includes("PTE PIEDRA") || normalized.includes("PUENTE PIEDRA")) keys.add("PTE PIEDRA");
    if (normalized.includes("CENTRO DISTRIBUCION") || normalized === "CD GPC") keys.add("CD");
  }
  return [...keys];
}

async function loadStores() {
  const { data, error } = await supabase.from("stores").select("*").eq("is_active", true);
  if (error) throw error;
  const stores = data || [];
  const map = new Map();
  for (const store of stores) {
    for (const key of storeKeysForStore(store)) map.set(key, store);
  }
  return { stores, map };
}

async function loadRotationMap(rows) {
  const rotations = new Map();
  const byStore = new Map();
  for (const row of rows) {
    const list = byStore.get(row.store_key) || new Set();
    list.add(row.product_code);
    byStore.set(row.store_key, list);
  }

  for (const [storeKey, skuSet] of byStore.entries()) {
    const skus = [...skuSet];
    for (let i = 0; i < skus.length; i += 500) {
      const { data, error } = await supabase
        .from("product_rotation_monthly")
        .select("product_code,rotation_category,period_month")
        .eq("store_key", storeKey)
        .in("product_code", skus.slice(i, i + 500))
        .order("period_month", { ascending: false });
      if (error) {
        console.warn(`No se pudieron leer rotaciones para ${storeKey}: ${error.message}`);
        continue;
      }
      for (const item of data || []) {
        const key = `${storeKey}|${cleanCode(item.product_code)}`;
        if (!rotations.has(key)) rotations.set(key, String(item.rotation_category || "SIN ROTACION").trim().toUpperCase());
      }
    }
  }
  return rotations;
}

async function main() {
  const file = arg("file");
  const dir = arg("dir");
  const from = arg("from");
  const to = arg("to");
  const snapshotDate = arg("date", todayISO());
  const snapshotTime = arg("time", "08:00");
  if (dir) {
    if (!fs.existsSync(dir)) throw new Error("Indica una carpeta valida con --dir=");
    const folders = fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))
      .map(item => item.name)
      .filter(date => (!from || date >= from) && (!to || date <= to))
      .sort();
    if (folders.length === 0) throw new Error("No encontre carpetas con formato YYYY-MM-DD para importar.");
    for (const folder of folders) {
      const folderPath = path.join(dir, folder);
      const files = fs.readdirSync(folderPath)
        .filter(name => /\.(xlsx|xls)$/i.test(name) && !name.startsWith("~$"))
        .sort();
      if (files.length === 0) {
        console.log(`Sin Excel en ${folder}`);
        continue;
      }
      const selectedFile = path.join(folderPath, files[0]);
      console.log(`\n=== Importando ${folder}: ${selectedFile} ===`);
      await importOne(selectedFile, folder, snapshotTime);
    }
    return;
  }
  if (!file || !fs.existsSync(file)) throw new Error("Indica un archivo valido con --file=");
  await importOne(file, snapshotDate, snapshotTime);
}

async function importOne(file, snapshotDate, snapshotTime) {
  const startedAt = Date.now();
  console.log(`Leyendo tiendas activas...`);
  const { map: storeMap } = await loadStores();
  console.log(`Abriendo Excel (${path.basename(file)})...`);
  const workbook = XLSX.readFile(file);
  const detailRows = [];
  console.log(`Hojas detectadas: ${workbook.SheetNames.join(", ")}`);

  for (const sheetName of workbook.SheetNames) {
    console.log(`Procesando hoja: ${sheetName}`);
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (rows.length < 2) continue;
    const headers = rows[0].map(normalizeText);
    const hasCode = findHeader(headers, ["cod.sap", "cod sap", "codsap", "sku", "codigo"]) >= 0;
    const hasStock = findHeader(headers, ["stock", "cantidad", "unidades", "cant disponible"]) >= 0;
    if (!hasCode || !hasStock) continue;

    for (const raw of rows.slice(1)) {
      const rawStore = String(cell(raw, headers, ["tienda", "sede", "almacen", "local", "store"]) || sheetName).trim();
      const store = storeMap.get(normalizeText(rawStore));
      const storeKey = storeKeysForStore(store || { name: rawStore })[0] || normalizeText(rawStore);
      const productCode = cleanCode(cell(raw, headers, ["cod.sap", "cod sap", "codsap", "sku", "codigo"]));
      const stock = parseNumber(cell(raw, headers, ["stock", "cantidad", "unidades", "cant disponible"]));
      if (!rawStore || normalizeText(rawStore) === "0" || !storeKey || storeKey === "0" || !isValidProductCode(productCode) || stock < 0) continue;
      const cost = parseNumber(cell(raw, headers, ["costo prom", "costo", "ult costo", "cost"]));
      const valueFromFile = parseNumber(cell(raw, headers, ["valorizado", "valor", "importe", "total valor"]));
      detailRows.push({
        snapshot_date: snapshotDate,
        snapshot_time: snapshotTime,
        store_id: store?.id || null,
        store_key: storeKey,
        store_name: store?.name || rawStore,
        sede: store?.erp_sede || rawStore,
        product_code: productCode,
        description: String(cell(raw, headers, ["descripcion", "descripcion producto", "producto"]) || "").trim() || null,
        unit: String(cell(raw, headers, ["um", "unidad", "uom"]) || "").trim() || null,
        stock,
        cost,
        inventory_value: valueFromFile > 0 ? valueFromFile : r2(stock * cost),
        source_name: path.basename(file),
      });
    }
    console.log(`Filas acumuladas: ${detailRows.length}`);
  }

  if (detailRows.length === 0) throw new Error("No se encontraron filas de detalle con codigo y stock.");
  const groupedDetail = new Map();
  for (const row of detailRows) {
    const key = `${row.store_key}|${row.product_code}`;
    const current = groupedDetail.get(key);
    if (!current) {
      groupedDetail.set(key, { ...row });
      continue;
    }
    current.stock = r2(current.stock + row.stock);
    current.inventory_value = r2(current.inventory_value + row.inventory_value);
    if (!current.description && row.description) current.description = row.description;
    if (!current.unit && row.unit) current.unit = row.unit;
    if (current.cost <= 0 && row.cost > 0) current.cost = row.cost;
  }
  detailRows.length = 0;
  detailRows.push(...groupedDetail.values());
  console.log(`Detalle listo: ${detailRows.length} filas. Calculando totales...`);

  const storeTotals = new Map();
  for (const row of detailRows) {
    const current = storeTotals.get(row.store_key) || {
      store_id: row.store_id,
      store_name: row.store_name,
      sede: row.sede,
      codes_with_stock: 0,
      total_units: 0,
      inventory_value: 0,
      missing_cost_codes: 0,
    };
    if (row.stock > 0) current.codes_with_stock += 1;
    current.total_units = r2(current.total_units + row.stock);
    current.inventory_value = r2(current.inventory_value + row.inventory_value);
    if (row.cost <= 0) current.missing_cost_codes += 1;
    storeTotals.set(row.store_key, current);
  }
  const totals = [...storeTotals.values()].reduce((acc, row) => ({
    stores: acc.stores + 1,
    codes: acc.codes + row.codes_with_stock,
    units: r2(acc.units + row.total_units),
    value: r2(acc.value + row.inventory_value),
  }), { stores: 0, codes: 0, units: 0, value: 0 });

  const { data: existing, error: existingError } = await supabase
    .from("inventory_valuation_snapshots")
    .select("id")
    .eq("snapshot_date", snapshotDate)
    .eq("snapshot_time", snapshotTime);
  if (existingError) throw existingError;
  if ((existing || []).length > 0) {
    console.log(`Reemplazando fotografia existente de ${snapshotDate} ${snapshotTime}...`);
    const { error } = await supabase.from("inventory_valuation_snapshots").delete().in("id", existing.map(row => row.id));
    if (error) throw error;
  }

  console.log(`Creando cabecera de fotografia...`);
  const { data: snapshot, error: snapshotError } = await supabase
    .from("inventory_valuation_snapshots")
    .insert({
      snapshot_date: snapshotDate,
      snapshot_time: snapshotTime,
      source_name: path.basename(file),
      total_stores: totals.stores,
      total_codes: totals.codes,
      total_units: totals.units,
      total_value: totals.value,
    })
    .select("id")
    .single();
  if (snapshotError) throw snapshotError;

  const storeRows = [...storeTotals.entries()].map(([storeKey, row]) => ({
    snapshot_id: snapshot.id,
    store_id: row.store_id,
    store_name: row.store_name,
    sede: row.sede || storeKey,
    codes_with_stock: row.codes_with_stock,
    total_units: row.total_units,
    inventory_value: row.inventory_value,
    missing_cost_codes: row.missing_cost_codes,
  }));
  console.log(`Insertando resumen por tienda: ${storeRows.length} filas...`);
  for (let i = 0; i < storeRows.length; i += BATCH_SIZE) {
    const { error } = await supabase.from("inventory_valuation_snapshot_stores").insert(storeRows.slice(i, i + BATCH_SIZE));
    if (error) throw error;
  }

  const productRows = detailRows.map(row => ({ ...row, snapshot_id: snapshot.id }));
  console.log(`Insertando detalle por codigo: ${productRows.length} filas...`);
  for (let i = 0; i < productRows.length; i += BATCH_SIZE) {
    const { error } = await supabase.from("inventory_valuation_snapshot_products").insert(productRows.slice(i, i + BATCH_SIZE));
    if (error) throw error;
    console.log(`Stock detalle: ${Math.min(i + BATCH_SIZE, productRows.length)}/${productRows.length}`);
  }

  console.log(`Calculando rotaciones para fotografia...`);
  const rotations = await loadRotationMap(detailRows);
  const rotationTotals = new Map();
  for (const row of detailRows) {
    const rotation = rotations.get(`${row.store_key}|${row.product_code}`) || "SIN ROTACION";
    const key = `${row.store_key}|${rotation}`;
    const current = rotationTotals.get(key) || {
      snapshot_date: snapshotDate,
      snapshot_time: snapshotTime,
      store_key: row.store_key,
      store_name: row.store_name,
      rotation_category: rotation,
      codes_with_stock: 0,
      total_units: 0,
      inventory_value: 0,
      calculated_at: new Date().toISOString(),
    };
    current.codes_with_stock += 1;
    current.total_units = r2(current.total_units + row.stock);
    current.inventory_value = r2(current.inventory_value + row.inventory_value);
    rotationTotals.set(key, current);
  }
  const rotationRows = [...rotationTotals.values()];
  console.log(`Guardando valorizado por rotacion: ${rotationRows.length} filas...`);
  for (let i = 0; i < rotationRows.length; i += BATCH_SIZE) {
    const { error } = await supabase
      .from("inventory_rotation_valuation_daily")
      .upsert(rotationRows.slice(i, i + BATCH_SIZE), { onConflict: "snapshot_date,store_key,rotation_category" });
    if (error) throw error;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`Fotografia importada: ${snapshotDate} ${snapshotTime} - ${detailRows.length} codigos, ${storeRows.length} tiendas, ${rotationRows.length} rotaciones. Tiempo: ${elapsed}s`);
}

main().catch(error => {
  console.error("Error importando fotografia:", error);
  process.exitCode = 1;
});
