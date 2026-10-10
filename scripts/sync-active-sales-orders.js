/* Sincroniza exclusivamente órdenes de venta RMS abiertas (SO.StatusCode=A).
 * La tabla destino es aditiva; las líneas que dejan de estar activas se marcan
 * inactivas después de completar el lote, sin borrar historial.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const envPath = fs.existsSync(path.join(__dirname, '.env'))
  ? path.join(__dirname, '.env')
  : path.join(__dirname, '..', '.env.local')
require('dotenv').config({ path: envPath, quiet: true })
const sql = require('mssql')
const { createClient } = require('@supabase/supabase-js')
const purchaseOrdersModule = fs.existsSync(path.join(__dirname, 'sync-purchase-orders.js'))
  ? './sync-purchase-orders'
  : './erp-sync/sync-purchase-orders'
const { syncOnce: syncPurchaseOrdersOnce } = require(purchaseOrdersModule)

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY
)
const BATCH_SIZE = Number(process.env.SALES_ORDERS_BATCH_SIZE || 500)
const INTERVAL_MS = Number(process.env.SALES_ORDERS_INTERVAL_MS || 5 * 60 * 1000)
const DRY_RUN = process.argv.includes('--dry-run')
const READ_PAGE_SIZE = 1000
const CURRENT_COLUMNS = 'order_id,line_id,store_code,order_no,order_date,status,product_code,sku,description,quantity,order_value,source_changed_at'
const STATUS_FILE = path.join(__dirname, 'sales-orders-sync-status.txt')
const LOG_FILE = path.join(__dirname, 'sales-orders-sync.log')
const HEARTBEAT_FILE = path.join(__dirname, 'sales-orders-watchdog-heartbeat.txt')

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER,
  requestTimeout: 300000,
  connectionTimeout: 30000,
  options: { encrypt: false, trustServerCertificate: true },
}

function clean(value) {
  return String(value ?? '').trim()
}

function numberValue(value) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? Number(number.toFixed(6)) : 0
}

function writeStatus(message) {
  const line = `${new Date().toLocaleString('es-PE', { hour12: false })} | ${message}`
  if (!DRY_RUN) {
    fs.writeFileSync(STATUS_FILE, `${line}\n`, 'utf8')
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
    fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), 'utf8')
  }
  console.log(message)
}

function orderKey(row) { return `${row.order_id}|${row.line_id}` }

function comparableOrder(row) {
  return JSON.stringify([
    clean(row.store_code), clean(row.order_no), clean(row.order_date).slice(0, 10),
    clean(row.status), clean(row.product_code), clean(row.sku), clean(row.description),
    numberValue(row.quantity), numberValue(row.order_value),
    row.source_changed_at ? new Date(row.source_changed_at).toISOString() : null,
  ])
}

async function readCurrentRows(periodStartIso) {
  const rows = []
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    const { data, error } = await supabase.from('erp_sales_order_lines')
      .select(CURRENT_COLUMNS)
      .gte('order_date', periodStartIso)
      .eq('is_active', true)
      .order('order_id', { ascending: true })
      .order('line_id', { ascending: true })
      .range(from, from + READ_PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < READ_PAGE_SIZE) break
  }
  return rows
}

async function deactivateRows(stale, incomingOrderIds, now, periodStartIso) {
  const closedOrderIds = [...new Set(stale.map(row => row.order_id))]
    .filter(orderId => !incomingOrderIds.has(orderId))
  const closedSet = new Set(closedOrderIds)
  for (let i = 0; i < closedOrderIds.length; i += 200) {
    const { error } = await supabase.from('erp_sales_order_lines')
      .update({ is_active: false, synced_at: now })
      .gte('order_date', periodStartIso)
      .eq('is_active', true)
      .in('order_id', closedOrderIds.slice(i, i + 200))
    if (error) throw error
  }
  for (const row of stale.filter(row => !closedSet.has(row.order_id))) {
    const { error } = await supabase.from('erp_sales_order_lines')
      .update({ is_active: false, synced_at: now })
      .eq('order_id', row.order_id).eq('line_id', row.line_id).eq('is_active', true)
    if (error) throw error
  }
}

function activeOrdersQuery() {
  return `
    DECLARE @period_start date = DATEADD(month, -1, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1));
    SELECT
      CONVERT(varchar(36), so.SOId) AS order_id,
      CAST(sol.LineId AS int) AS line_id,
      CAST(so.StoreNo AS varchar(20)) AS store_code,
      COALESCE(NULLIF(LTRIM(RTRIM(so.SONumber)), ''), CAST(so.SONo AS varchar(30))) AS order_no,
      CONVERT(char(10), so.OrderDate, 23) AS order_date,
      'ACTIVO' AS status,
      COALESCE(NULLIF(LTRIM(RTRIM(p.ProductReference)), ''), CAST(sol.SKU AS varchar(30))) AS product_code,
      CAST(sol.SKU AS varchar(30)) AS sku,
      COALESCE(NULLIF(LTRIM(RTRIM(sol.LineDescription)), ''), NULLIF(LTRIM(RTRIM(fv.Desc1)), '')) AS description,
      CAST(ABS(COALESCE(sol.Qty, 0)) AS decimal(18, 6)) AS quantity,
      CAST(ABS(CASE
        WHEN COALESCE(sol.ExtRetailPrice, 0) <> 0 THEN sol.ExtRetailPrice
        ELSE COALESCE(sol.Qty, 0) * COALESCE(sol.RetailPrice, 0)
      END) AS decimal(18, 6)) AS order_value,
      COALESCE(so.ChangeDate, so.CreationDate) AS source_changed_at
    FROM SO so
    JOIN SO_LINE sol ON sol.StoreNo = so.StoreNo AND sol.SOId = so.SOId
    LEFT JOIN PRODUCT p ON p.SKU = sol.SKU
    LEFT JOIN FILTER_VIEW fv ON fv.SKU = sol.SKU
    WHERE so.StatusCode = 'A'
      AND so.OrderDate >= @period_start
      AND COALESCE(sol.Qty, 0) <> 0;
  `
}

async function upsertRows(rows) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE)
    const { error } = await supabase.from('erp_sales_order_lines').upsert(batch, {
      onConflict: 'order_id,line_id',
    })
    if (error) throw error
    process.stdout.write(`\rÓrdenes activas: ${Math.min(offset + batch.length, rows.length)}/${rows.length}`)
  }
  if (rows.length) process.stdout.write('\n')
}

async function syncOnce() {
  const syncRunId = crypto.randomUUID()
  const now = new Date().toISOString()
  const periodStart = new Date()
  periodStart.setDate(1)
  periodStart.setMonth(periodStart.getMonth() - 1)
  // Construir la fecha civil local: toISOString() puede mover el día 1 al 2
  // después de las 19:00 en Perú y deja fuera órdenes del primer día.
  const periodStartIso = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}-01`
  let pool

  writeStatus('Leyendo órdenes de venta RMS activas del mes actual y anterior')
  try {
    pool = await new sql.ConnectionPool(sqlConfig).connect()
    const result = await pool.request().query(activeOrdersQuery())
    const rows = result.recordset.map(row => ({
      order_id: clean(row.order_id),
      line_id: Number(row.line_id),
      store_code: clean(row.store_code),
      order_no: clean(row.order_no) || null,
      order_date: clean(row.order_date),
      status: 'ACTIVO',
      product_code: clean(row.product_code).toUpperCase(),
      sku: clean(row.sku) || null,
      description: clean(row.description) || null,
      quantity: numberValue(row.quantity),
      order_value: numberValue(row.order_value),
      source_changed_at: row.source_changed_at ? new Date(row.source_changed_at).toISOString() : null,
      sync_run_id: syncRunId,
      is_active: true,
      synced_at: now,
    })).filter(row => row.order_id && row.line_id > 0 && row.store_code && row.order_date && row.product_code)

    const currentRows = await readCurrentRows(periodStartIso)
    const currentByKey = new Map(currentRows.map(row => [orderKey(row), row]))
    const incomingKeys = new Set(rows.map(orderKey))
    const incomingOrderIds = new Set(rows.map(row => row.order_id))
    const changed = rows.filter(row => {
      const current = currentByKey.get(orderKey(row))
      return !current || comparableOrder(current) !== comparableOrder(row)
    })
    const stale = currentRows.filter(row => !incomingKeys.has(orderKey(row)))
    // Nunca ocultar miles de órdenes por una lectura RMS incompleta.
    if (currentRows.length > 0 && rows.length === 0) throw new Error('RMS devolvió cero órdenes; no se desactivará el histórico activo')
    if (stale.length > Math.max(1000, currentRows.length * 0.2)) throw new Error(`Demasiadas líneas desaparecidas (${stale.length}); se requiere revisión antes de desactivar`)
    writeStatus(`Comparación: ${rows.length} RMS, ${currentRows.length} activas, ${changed.length} cambios, ${stale.length} desactivaciones`)
    if (DRY_RUN) return { rows: rows.length, changed: changed.length, stale: stale.length }

    await upsertRows(changed)
    await deactivateRows(stale, incomingOrderIds, now, periodStartIso)

    const { error: statusError } = await supabase.from('erp_sync_status').upsert({
      id: 'sales_orders_active',
      source_path: __dirname,
      synced_at: now,
      updated_at: now,
    }, { onConflict: 'id' })
    if (statusError) throw statusError

    writeStatus(`Sincronización terminada: ${rows.length} líneas activas, ${changed.length} cambios, ${stale.length} desactivaciones`)
  } finally {
    if (pool) await pool.close()
  }
}

async function wasSyncedRecently() {
  const { data, error } = await supabase
    .from('erp_sync_status')
    .select('synced_at')
    .eq('id', 'sales_orders_active')
    .maybeSingle()
  if (error || !data?.synced_at) return false
  return Date.now() - new Date(data.synced_at).getTime() < 10 * 60 * 1000
}

async function main() {
  const once = process.argv.includes('--once') || DRY_RUN
  do {
    try {
      if (!once && await wasSyncedRecently()) {
        fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), 'utf8')
      } else {
        await syncOnce()
      }
      // Las OC comparten este proceso supervisado para no crear otra tarea
      // huérfana en Windows. Su propia sincronización es incremental y paginada.
      if (!DRY_RUN) await syncPurchaseOrdersOnce()
    } catch (error) {
      writeStatus(`ERROR: ${error.message || error}`)
      if (once) process.exitCode = 1
    }
    if (!once) await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
  } while (!once)
}

void main()
