/* Sincroniza Órdenes de Compra RMS (PO / PO_LINE) hacia Supabase.
 * - Incremental por ChangeDate con solapamiento de 15 minutos.
 * - Lotes acotados: nunca carga todo RMS ni todo Supabase en memoria.
 * - No modifica RMS. Las líneas derivadas se reemplazan lógicamente por lote
 *   usando un sync_run_id, sin tocar registros de otros módulos.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const localEnv = path.join(__dirname, '.env')
const parentEnv = path.join(__dirname, '..', '..', '.env.local')
require('dotenv').config({ path: fs.existsSync(localEnv) ? localEnv : parentEnv, quiet: true })

const sql = require('mssql')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const SQL_PAGE_SIZE = Math.min(Math.max(Number(process.env.PURCHASE_ORDERS_SQL_PAGE_SIZE || 300), 50), 750)
const UPSERT_BATCH_SIZE = Math.min(Math.max(Number(process.env.PURCHASE_ORDERS_UPSERT_BATCH_SIZE || 300), 50), 500)
const INTERVAL_MS = Number(process.env.PURCHASE_ORDERS_INTERVAL_MS || 5 * 60 * 1000)
const STATUS_FILE = path.join(__dirname, 'purchase-orders-sync-status.txt')
const LOG_FILE = path.join(__dirname, 'purchase-orders-sync.log')
const HEARTBEAT_FILE = path.join(__dirname, 'purchase-orders-watchdog-heartbeat.txt')

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER,
  requestTimeout: 300000,
  connectionTimeout: 120000,
  options: { encrypt: false, trustServerCertificate: true },
}

function clean(value) {
  return String(value ?? '').trim()
}

function numberValue(value) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0
}

function iso(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function businessStatus(rawStatus) {
  const status = clean(rawStatus).toUpperCase()
  if (status === 'X') return 'closed'
  if (status === 'C' || status === 'V') return 'cancelled'
  return 'pending'
}

function writeStatus(message) {
  const line = `${new Date().toLocaleString('es-PE', { hour12: false })} | ${message}`
  fs.writeFileSync(STATUS_FILE, `${line}\n`, 'utf8')
  fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8')
  fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), 'utf8')
  console.log(message)
}

function touchHeartbeat() {
  fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), 'utf8')
}

function headerPageQuery() {
  return `
    SELECT TOP (@page_size)
      CONVERT(varchar(36), p.POId) AS po_id,
      COALESCE(NULLIF(LTRIM(RTRIM(p.PONumber)), ''), CAST(p.PONo AS varchar(30))) AS po_number,
      p.PONo AS po_no,
      p.StatusCode AS status_code,
      p.POTypeCode AS po_type_code,
      p.POSourceCode AS source_code,
      CAST(p.StoreNo AS varchar(20)) AS store_no,
      s.StoreCode AS store_code,
      s.StoreName AS store_name,
      p.VendorCode AS vendor_code,
      v.VendorName AS vendor_name,
      p.Buyer AS buyer,
      p.PODate AS po_date,
      p.ShipDate AS ship_date,
      p.CancelDate AS cancel_date,
      p.CreationDate AS source_created_at,
      COALESCE(p.ChangeDate, p.CreationDate, p.PODate, CONVERT(datetime, '19000101')) AS source_changed_at,
      p.LineCount AS source_line_count,
      p.CostTotal AS cost_total,
      p.RetailTotal AS retail_total,
      p.Total AS total,
      p.CurrencyId AS currency_id,
      COALESCE(NULLIF(LTRIM(RTRIM(p.Notes)), ''), NULLIF(LTRIM(RTRIM(p.Comment1)), '')) AS notes
    FROM PO p WITH (NOLOCK)
    LEFT JOIN STORE s WITH (NOLOCK) ON s.StoreNo = p.StoreNo
    LEFT JOIN VENDOR v WITH (NOLOCK) ON v.VendorCode = p.VendorCode
    WHERE (
      @since IS NULL
      OR COALESCE(p.ChangeDate, p.CreationDate, p.PODate) >= @since
      -- Algunas instalaciones RMS cambian StatusCode sin actualizar ChangeDate.
      -- Releer una ventana operativa evita dejar una OC recién cerrada como
      -- pendiente, sin convertir cada ciclo de 5 minutos en una carga total.
      OR p.PODate >= DATEADD(day, -14, GETDATE())
    )
      AND (
        @cursor_changed IS NULL
        OR COALESCE(p.ChangeDate, p.CreationDate, p.PODate, CONVERT(datetime, '19000101')) > @cursor_changed
        OR (
          COALESCE(p.ChangeDate, p.CreationDate, p.PODate, CONVERT(datetime, '19000101')) = @cursor_changed
          AND CONVERT(varchar(36), p.POId) > @cursor_id
        )
      )
    ORDER BY source_changed_at, po_id;
  `
}

function linesQuery(ids) {
  const placeholders = ids.map((_, index) => `@po_${index}`).join(',')
  return `
    SELECT
      CONVERT(varchar(36), line.POId) AS po_id,
      CAST(line.LineId AS int) AS line_id,
      CAST(line.SKU AS varchar(30)) AS sku,
      COALESCE(NULLIF(LTRIM(RTRIM(p.ProductReference)), ''), NULLIF(LTRIM(RTRIM(fv.StyleName)), ''), CAST(line.SKU AS varchar(30))) AS product_code,
      COALESCE(NULLIF(LTRIM(RTRIM(p.UPC)), ''), NULLIF(LTRIM(RTRIM(line.UPC)), '')) AS barcode,
      COALESCE(NULLIF(LTRIM(RTRIM(line.LineDescription)), ''), NULLIF(LTRIM(RTRIM(fv.Desc1)), '')) AS description,
      COALESCE(NULLIF(LTRIM(RTRIM(u.UDF1Description)), ''), NULLIF(LTRIM(RTRIM(line.UOMCode)), '')) AS unit,
      line.StatusCode AS status_code,
      line.QtyOrder AS qty_ordered,
      line.QtyReceived AS qty_received,
      line.QtyDue AS qty_due,
      line.Cost AS cost,
      line.ExtCost AS ext_cost,
      line.Price AS price,
      line.ExtPrice AS ext_price,
      line.EstimatedDate AS estimated_date,
      line.LineNotes AS notes
    FROM PO_LINE line WITH (NOLOCK)
    LEFT JOIN PRODUCT p WITH (NOLOCK) ON p.SKU = line.SKU
    LEFT JOIN FILTER_VIEW fv WITH (NOLOCK) ON fv.SKU = line.SKU
    LEFT JOIN PRODUCT_UDF1 u WITH (NOLOCK) ON u.UDF1 = fv.UDF1
    WHERE line.POId IN (${placeholders})
    ORDER BY line.POId, line.LineId;
  `
}

async function upsertInBatches(table, rows, onConflict) {
  for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + UPSERT_BATCH_SIZE)
    const { error } = await supabase.from(table).upsert(batch, { onConflict })
    if (error) throw error
  }
}

async function lastSuccessfulSync() {
  const { data, error } = await supabase
    .from('erp_sync_status')
    .select('synced_at')
    .eq('id', 'purchase_orders')
    .maybeSingle()
  if (error || !data?.synced_at) return null
  const date = new Date(data.synced_at)
  if (!Number.isFinite(date.getTime())) return null
  date.setMinutes(date.getMinutes() - 15)
  return date
}

async function lastImportedCursor() {
  const { data, error } = await supabase
    .from('erp_purchase_orders')
    .select('erp_po_id,source_changed_at')
    .not('source_changed_at', 'is', null)
    .order('source_changed_at', { ascending: false })
    .order('erp_po_id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data?.source_changed_at || !data?.erp_po_id) return null
  return { changedAt: new Date(data.source_changed_at), id: clean(data.erp_po_id) }
}

async function retrySql(operation, label, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= attempts) break
      writeStatus(`${label}: RMS ocupado, reintento ${attempt}/${attempts - 1}`)
      await new Promise(resolve => setTimeout(resolve, attempt * 2500))
    }
  }
  throw lastError
}

async function readHeaderPage(pool, since, cursorChanged, cursorId) {
  return retrySql(async () => {
    const request = pool.request()
    request.input('page_size', sql.Int, SQL_PAGE_SIZE)
    request.input('since', sql.DateTime2, since)
    request.input('cursor_changed', sql.DateTime2, cursorChanged)
    request.input('cursor_id', sql.VarChar(36), cursorId || '')
    const result = await request.query(headerPageQuery())
    return result.recordset || []
  }, 'Cabeceras OC')
}

async function readLines(pool, ids) {
  if (!ids.length) return []
  return retrySql(async () => {
    const request = pool.request()
    ids.forEach((id, index) => request.input(`po_${index}`, sql.UniqueIdentifier, id))
    const result = await request.query(linesQuery(ids))
    return result.recordset || []
  }, 'Detalle OC')
}

async function removeStaleLines(poIds, syncRunId) {
  // UUIDs acotados por lote para reducir solicitudes DELETE y conservar una
  // URL segura para PostgREST. Solo elimina lineas antiguas de las OC leidas.
  const cleanupBatchSize = 150
  for (let offset = 0; offset < poIds.length; offset += cleanupBatchSize) {
    const ids = poIds.slice(offset, offset + cleanupBatchSize)
    const { error } = await supabase
      .from('erp_purchase_order_lines')
      .delete()
      .in('erp_po_id', ids)
      .neq('source_sync_run_id', syncRunId)
    if (error) throw error
  }
}

async function syncOnce(options = {}) {
  const forceFull = Boolean(options.full)
  const resume = Boolean(options.resume)
  const syncRunId = crypto.randomUUID()
  const now = new Date().toISOString()
  const since = forceFull ? null : await lastSuccessfulSync()
  let pool
  const resumeCursor = forceFull && resume ? await lastImportedCursor() : null
  let cursorChanged = resumeCursor?.changedAt || null
  let cursorId = resumeCursor?.id || ''
  let processedOrders = 0
  let processedLines = 0

  writeStatus(resumeCursor
    ? `Reanudando historial OC RMS desde ${resumeCursor.changedAt.toISOString()} / ${resumeCursor.id}`
    : since
    ? `Leyendo OC RMS modificadas desde ${since.toISOString()}`
    : 'Leyendo historial completo de OC RMS por lotes')

  try {
    pool = await new sql.ConnectionPool(sqlConfig).connect()

    while (true) {
      const headerRows = await readHeaderPage(pool, since, cursorChanged, cursorId)
      if (!headerRows.length) break

      const poIds = headerRows.map(row => clean(row.po_id)).filter(Boolean)
      const sourceLines = await readLines(pool, poIds)
      const linesByOrder = new Map()
      for (const line of sourceLines) {
        const id = clean(line.po_id)
        const current = linesByOrder.get(id) || []
        current.push(line)
        linesByOrder.set(id, current)
      }

      const headers = headerRows.map(row => {
        const id = clean(row.po_id)
        const orderLines = linesByOrder.get(id) || []
        const rawStatus = clean(row.status_code).toUpperCase()
        return {
          erp_po_id: id,
          po_number: clean(row.po_number) || clean(row.po_no) || id,
          po_no: row.po_no == null ? null : Number(row.po_no),
          raw_status_code: rawStatus,
          business_status: businessStatus(rawStatus),
          po_type_code: clean(row.po_type_code) || null,
          source_code: clean(row.source_code) || null,
          store_no: clean(row.store_no),
          store_code: clean(row.store_code) || null,
          store_name: clean(row.store_name) || clean(row.store_no),
          vendor_code: clean(row.vendor_code) || null,
          vendor_name: clean(row.vendor_name) || null,
          buyer: clean(row.buyer) || null,
          po_date: iso(row.po_date),
          ship_date: iso(row.ship_date),
          cancel_date: iso(row.cancel_date),
          closed_at: rawStatus === 'X' ? iso(row.source_changed_at) : null,
          source_created_at: iso(row.source_created_at),
          source_changed_at: iso(row.source_changed_at),
          line_count: orderLines.length || Number(row.source_line_count || 0),
          qty_ordered: numberValue(orderLines.reduce((sum, line) => sum + Number(line.qty_ordered || 0), 0)),
          qty_received: numberValue(orderLines.reduce((sum, line) => sum + Number(line.qty_received || 0), 0)),
          qty_due: numberValue(orderLines.reduce((sum, line) => sum + Number(line.qty_due || 0), 0)),
          cost_total: numberValue(row.cost_total),
          retail_total: numberValue(row.retail_total),
          total: numberValue(row.total),
          currency_id: row.currency_id == null ? null : Number(row.currency_id),
          notes: clean(row.notes) || null,
          source_sync_run_id: syncRunId,
          synced_at: now,
        }
      }).filter(row => row.erp_po_id && row.po_number && row.store_no && row.po_date)

      const lines = sourceLines.map(row => ({
        erp_po_id: clean(row.po_id),
        line_id: Number(row.line_id),
        sku: clean(row.sku) || null,
        product_code: clean(row.product_code).toUpperCase() || clean(row.sku),
        barcode: clean(row.barcode) || null,
        description: clean(row.description) || null,
        unit: clean(row.unit) || null,
        raw_status_code: clean(row.status_code) || null,
        qty_ordered: numberValue(row.qty_ordered),
        qty_received: numberValue(row.qty_received),
        qty_due: numberValue(row.qty_due),
        cost: numberValue(row.cost),
        ext_cost: numberValue(row.ext_cost),
        price: numberValue(row.price),
        ext_price: numberValue(row.ext_price),
        estimated_date: iso(row.estimated_date),
        notes: clean(row.notes) || null,
        source_sync_run_id: syncRunId,
        synced_at: now,
      })).filter(row => row.erp_po_id && row.line_id > 0 && row.product_code)

      await upsertInBatches('erp_purchase_orders', headers, 'erp_po_id')
      await upsertInBatches('erp_purchase_order_lines', lines, 'erp_po_id,line_id')
      await removeStaleLines(poIds, syncRunId)

      processedOrders += headers.length
      processedLines += lines.length
      const last = headerRows[headerRows.length - 1]
      cursorChanged = new Date(last.source_changed_at)
      cursorId = clean(last.po_id)
      touchHeartbeat()
      writeStatus(`OC RMS: ${processedOrders} órdenes / ${processedLines} líneas procesadas`)

      if (headerRows.length < SQL_PAGE_SIZE) break
    }

    const { error: statusError } = await supabase.from('erp_sync_status').upsert({
      id: 'purchase_orders',
      source_path: __dirname,
      synced_at: now,
      updated_at: now,
    }, { onConflict: 'id' })
    if (statusError) throw statusError

    writeStatus(`Sincronización OC terminada: ${processedOrders} órdenes / ${processedLines} líneas`)
    return { processedOrders, processedLines }
  } finally {
    if (pool) await pool.close()
  }
}

async function main() {
  const once = process.argv.includes('--once')
  const full = process.argv.includes('--full')
  const resume = process.argv.includes('--resume')
  do {
    try {
      await syncOnce({ full, resume })
    } catch (error) {
      writeStatus(`ERROR: ${error.message || error}`)
      if (once) process.exitCode = 1
    }
    if (!once) await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
  } while (!once)
}

module.exports = { syncOnce }

if (require.main === module) void main()
