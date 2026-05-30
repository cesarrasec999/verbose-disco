/* eslint-disable @typescript-eslint/no-require-imports */

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const sql = require('mssql')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
)

const BATCH_SIZE = Number(process.env.PICKING_BATCH_SIZE || 500)
const INTERVAL_MS = Number(process.env.PICKING_SYNC_INTERVAL_MS || 5 * 60 * 1000)
const STATUS_FILE = path.join(__dirname, 'picking-sync-status.txt')
const LOG_FILE = path.join(__dirname, 'picking-sync.log')
const STATE_FILE = path.join(__dirname, 'picking-sync-state.json')

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER,
  requestTimeout: 300000,
  connectionTimeout: 30000,
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const [key, inlineValue] = arg.slice(2).split('=')
    const nextArg = argv[i + 1]
    const value = inlineValue ?? (nextArg && !nextArg.startsWith('--') ? nextArg : true)
    args[key] = value
    if (inlineValue === undefined && typeof value === 'string') i += 1
  }
  return args
}

function clean(value) {
  return String(value ?? '').trim()
}

function numberValue(value) {
  const num = Number(value ?? 0)
  return Number.isFinite(num) ? Number(num.toFixed(6)) : 0
}

function statusName(code) {
  const value = clean(code).toUpperCase()
  if (value === 'A') return 'Activo'
  if (value === 'D') return 'Aprobado'
  if (value === 'C') return 'Cerrado'
  if (value === 'X') return 'Cerrado'
  if (value === 'Y') return 'Recepcionado'
  return value || 'Sin estado'
}

function writeStatus(text) {
  const line = `${new Date().toLocaleString('es-PE', { hour12: false })} | ${text}`
  fs.writeFileSync(STATUS_FILE, line + '\n', 'utf8')
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  console.log(text)
}

function localDateTime(value) {
  return new Date(value).toLocaleString('es-PE', { hour12: false })
}

function sqlLocalDateTime(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(value)).reduce((acc, part) => {
    acc[part.type] = part.value
    return acc
  }, {})
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

async function upsert(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from(table).upsert(batch, { onConflict: conflict })
    if (error) throw error
    process.stdout.write(`\r${table}: ${Math.min(i + batch.length, rows.length)}/${rows.length}`)
  }
  if (rows.length) process.stdout.write('\n')
}

function requestLinesQuery() {
  return `
    SELECT
      CONVERT(varchar(36), ir.InvRequestId) AS inv_request_id,
      CAST(ir.InvRequestNo AS varchar(30)) AS inv_request_no,
      COALESCE(NULLIF(ir.DocNumber, ''), CONCAT(CAST(ir.OutToStore AS varchar(20)), '-', CAST(ir.InvRequestNo AS varchar(30)))) AS doc_number,
      ir.StatusCode AS status_code,
      ir.InvRequestDate AS request_date,
      ir.CreationDate AS creation_date,
      CAST(ir.StoreNo AS varchar(20)) AS destination_store_code,
      dst.StoreName AS destination_store_name,
      CAST(ir.OutToStore AS varchar(20)) AS source_store_code,
      src.StoreName AS source_store_name,
      COALESCE(NULLIF(flag.IRFlag1Description, ''), NULLIF(reason.Description, ''), '') AS reason,
      ir.Notes AS notes,
      irl.LineId AS line_id,
      CAST(irl.SKU AS varchar(30)) AS sku,
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, ''), CAST(irl.SKU AS varchar(30))) AS product_code,
      COALESCE(NULLIF(irl.UPC, ''), NULLIF(p.UPC, '')) AS barcode,
      COALESCE(NULLIF(irl.LineDescription, ''), NULLIF(fv.Desc1, '')) AS description,
      u.UDF1Description AS unit,
      CAST(COALESCE(irl.QtyRequest, 0) AS decimal(18, 6)) AS qty_requested,
      CAST(COALESCE(irl.QtyDue, irl.QtyRequest, 0) AS decimal(18, 6)) AS qty_pending
    FROM INVENTORY_REQUEST ir
    JOIN INVENTORY_REQUEST_LINE irl
      ON ir.StoreNo = irl.StoreNo
     AND ir.InvRequestId = irl.InvRequestId
    LEFT JOIN INVENTORY_REQUEST_REASON reason ON ir.ReasonCode = reason.ReasonCode
    LEFT JOIN INVENTORY_REQUEST_FLAG1 flag ON ir.IRFlag1 = flag.IRFlag1
    LEFT JOIN STORE dst ON ir.StoreNo = dst.StoreNo
    LEFT JOIN STORE src ON ir.OutToStore = src.StoreNo
    LEFT JOIN PRODUCT p ON irl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON irl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    WHERE ir.ReasonCode = 'T'
      AND ir.StatusCode = 'A'
      AND (
        ir.IRFlag1 IN (2, 6)
        OR UPPER(COALESCE(flag.IRFlag1Description, '')) IN ('ABASTECIMIENTO', 'ABASTECIMIENTO URGENTE')
      )
      AND ir.CreationDate >= CONVERT(datetime2, @since)
      AND ir.CreationDate < CONVERT(datetime2, @until)
  `
}

function mapLines(rows) {
  const now = new Date().toISOString()
  return rows.map(row => ({
    id: `${clean(row.inv_request_id)}|${clean(row.line_id)}`,
    erp_inv_request_id: clean(row.inv_request_id),
    line_id: Number(row.line_id),
    sku: clean(row.sku) || null,
    product_code: clean(row.product_code),
    barcode: clean(row.barcode) || null,
    description: clean(row.description) || null,
    unit: clean(row.unit) || null,
    qty_requested: numberValue(row.qty_requested),
    qty_pending: numberValue(row.qty_pending),
    source_updated_at: now,
    updated_at: now
  })).filter(row => row.erp_inv_request_id && row.line_id && row.product_code)
}

function mapRequests(rows) {
  const now = new Date().toISOString()
  const grouped = new Map()
  for (const row of rows) {
    const key = clean(row.inv_request_id)
    if (!key) continue
    const current = grouped.get(key) || {
      erp_inv_request_id: key,
      inv_request_no: clean(row.inv_request_no) || null,
      doc_number: clean(row.doc_number) || null,
      status_code: clean(row.status_code) || null,
      status_name: statusName(row.status_code),
      request_date: row.request_date || null,
      creation_date: row.creation_date || null,
      destination_store_code: clean(row.destination_store_code),
      destination_store_name: clean(row.destination_store_name) || null,
      source_store_code: clean(row.source_store_code),
      source_store_name: clean(row.source_store_name) || null,
      reason: clean(row.reason) || null,
      notes: clean(row.notes) || null,
      line_count: 0,
      qty_requested_total: 0,
      qty_pending_total: 0,
      source_updated_at: now,
      updated_at: now
    }
    current.line_count += 1
    current.qty_requested_total = numberValue(current.qty_requested_total + numberValue(row.qty_requested))
    current.qty_pending_total = numberValue(current.qty_pending_total + numberValue(row.qty_pending))
    grouped.set(key, current)
  }
  return [...grouped.values()].filter(row => row.destination_store_code && row.source_store_code)
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt === retries) throw error
      const delay = 5000 * Math.pow(2, attempt - 1)
      writeStatus(`Intento ${attempt}/${retries} fallido. Reintentando en ${delay / 1000}s... (${error.message || error})`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

async function syncOnce({ since, until }) {
  let pool
  writeStatus(`Revisando requerimientos nuevos desde ${localDateTime(since)} hasta ${localDateTime(until)} hora local`)
  try {
    pool = await new sql.ConnectionPool(sqlConfig).connect()
    const result = await pool.request()
      .input('since', sql.VarChar, sqlLocalDateTime(since))
      .input('until', sql.VarChar, sqlLocalDateTime(until))
      .query(requestLinesQuery())

    const requests = mapRequests(result.recordset)
    const lines = mapLines(result.recordset)
    writeStatus(`Requerimientos activos leidos: ${requests.length}; lineas: ${lines.length}`)

    await upsert('picking_requests', requests, 'erp_inv_request_id')

    if (lines.length) {
      const { data: requestRows, error } = await supabase
        .from('picking_requests')
        .select('id,erp_inv_request_id')
        .in('erp_inv_request_id', [...new Set(lines.map(row => row.erp_inv_request_id))])
      if (error) throw error
      const requestIdByErp = new Map((requestRows || []).map(row => [row.erp_inv_request_id, row.id]))
      const linesWithRequest = lines
        .map(row => ({ ...row, request_id: requestIdByErp.get(row.erp_inv_request_id) || null }))
        .filter(row => row.request_id)
      await upsert('picking_request_lines', linesWithRequest, 'id')
    }

    await supabase.from('erp_sync_status').upsert({
      id: 'picking_requests',
      source_path: __dirname,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' })

    writeStatus(`Sincronizacion picking terminada: requerimientos=${requests.length}, lineas=${lines.length}`)
  } finally {
    if (pool) await pool.close()
  }
}

async function main() {
  const args = parseArgs(process.argv)
  let state = readState()
  const now = new Date()

  if (!state) {
    const startedAt = args.since ? new Date(String(args.since)) : now
    state = { startedAt: startedAt.toISOString(), lastSyncAt: startedAt.toISOString() }
    writeState(state)
    writeStatus(`Estado inicial creado. No se importo historial anterior a ${localDateTime(state.startedAt)} hora local`)
  }

  const since = args.since ? new Date(String(args.since)) : new Date(state.lastSyncAt || state.startedAt)
  const until = args.until ? new Date(String(args.until)) : addMinutes(now, 2)
  await withRetry(() => syncOnce({ since, until }))
  state.lastSyncAt = until.toISOString()
  writeState(state)
}

async function loop() {
  while (true) {
    try {
      await main()
    } catch (error) {
      writeStatus(`ERROR: ${error.message || error}`)
      console.error(error)
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
  }
}

const args = parseArgs(process.argv)
if (args.once) {
  main().catch(error => {
    writeStatus(`ERROR: ${error.message || error}`)
    console.error(error)
    process.exit(1)
  })
} else {
  loop()
}
