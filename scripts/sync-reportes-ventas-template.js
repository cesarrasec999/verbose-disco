/* eslint-disable @typescript-eslint/no-require-imports */
/*
  Copiar este archivo al servidor:
    \\192.168.5.53\Users\cesar.quispe\erp-sync\sync-reportes-ventas.js

  Requiere las mismas variables .env del sync actual:
    SQL_USER, SQL_PASSWORD, SQL_DATABASE, SQL_SERVER, SUPABASE_URL, SUPABASE_SERVICE_ROLE

  Uso sugerido:
    node sync-reportes-ventas.js --start=2026-05-01 --end=2026-05-31
*/

require("dotenv").config();

const sql = require("mssql");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
const BATCH_SIZE = Number(process.env.UPSERT_BATCH_SIZE || 1000);

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER,
  requestTimeout: 300000,
  connectionTimeout: 30000,
  options: { encrypt: false, trustServerCertificate: true },
};

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(item => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

function monthStartISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function addDaysISO(iso, days) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(6)) : 0;
}

async function syncSales() {
  const isYesterday = process.argv.includes("--yesterday");
  const start = isYesterday ? yesterdayISO() : arg("start", monthStartISO());
  const end   = isYesterday ? yesterdayISO() : arg("end",   todayISO());
  const endExclusive = addDaysISO(end, 1);
  const pool = await sql.connect(sqlConfig);

  /*
    Venta neta usa ExtRetailPriceWTax porque es el total de la linea con impuesto.
    Las notas de credito/devoluciones entran como SalesCode = 'R' y ya vienen con importes negativos.
    Costo de venta usa ExtCost del ERP.
  */
  const storeResult = await pool.request()
    .input("startDate", sql.DateTime, new Date(`${start}T00:00:00`))
    .input("endExclusive", sql.DateTime, new Date(`${endExclusive}T00:00:00`))
    .query(`
      select
        cast(s.StoreNo as varchar(30)) as store_key,
        s.StoreName as store_name,
        cast(r.SalesDate as date) as sales_date,
        sum(cast(isnull(rl.ExtRetailPriceWTax, 0) as decimal(18,6))) as sales_amount,
        sum(cast(isnull(rl.ExtCost, rl.Qty * isnull(rl.AvgCost, p.LastCost)) as decimal(18,6))) as cost_amount,
        sum(cast(rl.Qty as decimal(18,6))) as quantity,
        count(distinct r.ReceiptId) as documents
      from RECEIPT r
      join RECEIPT_LINE rl on r.ReceiptId = rl.ReceiptId
      join STORE s on r.StoreNo = s.StoreNo
      join PRODUCT p on rl.SKU = p.SKU
      where r.SalesDate >= @startDate
        and r.SalesDate < @endExclusive
        and r.SalesCode in ('S', 'R')
        and r.StatusCode = 'A'
        and rl.StatusCode = 'A'
        and rl.SalesCode in ('S', 'R')
      group by cast(s.StoreNo as varchar(30)), s.StoreName, cast(r.SalesDate as date)
    `);

  const productResult = await pool.request()
    .input("startDate", sql.DateTime, new Date(`${start}T00:00:00`))
    .input("endExclusive", sql.DateTime, new Date(`${endExclusive}T00:00:00`))
    .query(`
      select
        cast(s.StoreNo as varchar(30)) as store_key,
        s.StoreName as store_name,
        cast(r.SalesDate as date) as sales_date,
        upper(ltrim(rtrim(coalesce(nullif(p.ALU, ''), cast(p.SKU as varchar(30)))))) as product_code,
        max(coalesce(nullif(rl.LineDescription, ''), nullif(p.ALU, ''), cast(p.SKU as varchar(30)))) as description,
        max(nullif(rl.UOMCode, '')) as unit,
        sum(cast(isnull(rl.ExtRetailPriceWTax, 0) as decimal(18,6))) as sales_amount,
        sum(cast(isnull(rl.ExtCost, rl.Qty * isnull(rl.AvgCost, p.LastCost)) as decimal(18,6))) as cost_amount,
        sum(cast(rl.Qty as decimal(18,6))) as quantity,
        count(distinct r.ReceiptId) as documents
      from RECEIPT r
      join RECEIPT_LINE rl on r.ReceiptId = rl.ReceiptId
      join STORE s on r.StoreNo = s.StoreNo
      join PRODUCT p on rl.SKU = p.SKU
      where r.SalesDate >= @startDate
        and r.SalesDate < @endExclusive
        and r.SalesCode in ('S', 'R')
        and r.StatusCode = 'A'
        and rl.StatusCode = 'A'
        and rl.SalesCode in ('S', 'R')
      group by
        cast(s.StoreNo as varchar(30)),
        s.StoreName,
        cast(r.SalesDate as date),
        upper(ltrim(rtrim(coalesce(nullif(p.ALU, ''), cast(p.SKU as varchar(30))))))
    `);

  const now = new Date().toISOString();
  const rows = storeResult.recordset.map(row => ({
    sales_date: new Date(row.sales_date).toISOString().slice(0, 10),
    store_key: String(row.store_key || "").trim(),
    store_name: String(row.store_name || "").trim(),
    sales_amount: normalizeNumber(row.sales_amount),
    cost_amount: normalizeNumber(row.cost_amount),
    quantity: normalizeNumber(row.quantity),
    documents: Number(row.documents || 0),
    source_name: "\\\\192.168.5.53\\Users\\cesar.quispe\\erp-sync",
    synced_at: now,
    updated_at: now,
  })).filter(row => row.sales_date && row.store_key);

  const productRows = productResult.recordset.map(row => ({
    sales_date: new Date(row.sales_date).toISOString().slice(0, 10),
    store_key: String(row.store_key || "").trim(),
    store_name: String(row.store_name || "").trim(),
    product_code: String(row.product_code || "").trim().toUpperCase(),
    description: String(row.description || "").trim() || null,
    unit: String(row.unit || "").trim() || null,
    sales_amount: normalizeNumber(row.sales_amount),
    cost_amount: normalizeNumber(row.cost_amount),
    quantity: normalizeNumber(row.quantity),
    documents: Number(row.documents || 0),
    source_name: "\\\\192.168.5.53\\Users\\cesar.quispe\\erp-sync",
    synced_at: now,
    updated_at: now,
  })).filter(row => row.sales_date && row.store_key && row.product_code);

  await supabase.from("erp_store_sales_daily").delete().gte("sales_date", start).lte("sales_date", end);
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("erp_store_sales_daily")
      .upsert(batch, { onConflict: "sales_date,store_key" });
    if (error) throw error;
    console.log(`Ventas: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }

  await supabase.from("erp_product_sales_daily").delete().gte("sales_date", start).lte("sales_date", end);
  for (let i = 0; i < productRows.length; i += BATCH_SIZE) {
    const batch = productRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("erp_product_sales_daily")
      .upsert(batch, { onConflict: "sales_date,store_key,product_code" });
    if (error) throw error;
    console.log(`Ventas por codigo: ${Math.min(i + BATCH_SIZE, productRows.length)}/${productRows.length}`);
  }

  await supabase.from("erp_sync_status").upsert({
    id: "erp_store_sales_daily",
    source_path: "\\\\192.168.5.53\\Users\\cesar.quispe\\erp-sync",
    synced_at: now,
    updated_at: now,
  }, { onConflict: "id" });

  await supabase.from("erp_sync_status").upsert({
    id: "erp_product_sales_daily",
    source_path: "\\\\192.168.5.53\\Users\\cesar.quispe\\erp-sync",
    synced_at: now,
    updated_at: now,
  }, { onConflict: "id" });

  await pool.close();
  console.log(`Ventas sincronizadas: ${rows.length} tiendas/dia y ${productRows.length} codigos/dia (${start} a ${end})`);
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      const delay = 5000 * Math.pow(2, attempt - 1);
      console.log(`Intento ${attempt}/${retries} fallido. Reintentando en ${delay / 1000}s... (${error.message || error})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

withRetry(() => syncSales()).catch(error => {
  console.error("Error sincronizando ventas:", error);
  process.exitCode = 1;
});
