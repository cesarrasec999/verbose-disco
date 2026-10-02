/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Sincroniza "Salidas por Transferencia EN TRÃNSITO" desde el ERP.
 * Tabla ERP: SLIP / SLIP_LINE  (StatusCode = 'T')
 * Tda destino: slp.OutToStore â†’ destination_store_code
 * Las tiendas receptoras ven sus propios slips por destination_store_code.
 */

require('dotenv').config()

const fs   = require('fs')
const path = require('path')
const sql  = require('mssql')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_TIMEOUT_MS = Number(process.env.RECEPTION_SUPABASE_TIMEOUT_MS || 75_000)

// Una solicitud que queda abierta no debe congelar todo el ciclo. El watchdog
// puede reiniciar procesos, pero este timeout permite reintentar el lote antes.
async function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS)
  try {
    return await globalThis.fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { global: { fetch: fetchWithTimeout } }
)

const SQL_BATCH_SIZE       = Number(process.env.RECEPTION_BATCH_SIZE          || 500)
const REQUEST_BATCH_SIZE   = Math.min(Math.max(Number(process.env.RECEPTION_REQUEST_BATCH_SIZE || 400), 50), 500)
const LINE_BATCH_SIZE      = Math.min(Math.max(Number(process.env.RECEPTION_LINE_BATCH_SIZE    || 400), 50), 500)
const IN_BATCH_SIZE        = 75    // IDs de slips: mantiene la URL de PostgREST muy por debajo del limite HTTP
const UPDATE_IN_BATCH_SIZE = 150
const INTERVAL_MS          = Number(process.env.RECEPTION_SYNC_INTERVAL_MS     || 5 * 60 * 1000)
const RETRY_ATTEMPTS       = Number(process.env.RETRY_ATTEMPTS                 || 3)
const LOOKBACK_DAYS        = Number(process.env.RECEPTION_LOOKBACK_DAYS        || 0)   // 0 = todos los slips en transito
const RECENT_RECEIVED_DAYS = Number(process.env.RECEPTION_RECENT_RECEIVED_DAYS || 30)  // slips recibidos en ERP en los ultimos N dias
const STATUS_FILE    = path.join(__dirname, 'reception-sync-status.txt')
const LOG_FILE       = path.join(__dirname, 'reception-sync.log')
const STATE_FILE     = path.join(__dirname, 'reception-sync-state.json')
const STATUS_AUDIT_FILE = path.join(__dirname, 'reception-status-audit-state.json')
const WATCHDOG_HB    = path.join(__dirname, 'reception-watchdog-heartbeat.txt')
const LOCK_FILE       = path.join(__dirname, 'reception-sync.lock')
const STATUS_AUDIT_INTERVAL_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.RECEPTION_STATUS_AUDIT_INTERVAL_MS || 60 * 60 * 1000)
)

function statusAuditDue() {
  try {
    const state = JSON.parse(fs.readFileSync(STATUS_AUDIT_FILE, 'utf8'))
    const lastRun = new Date(state.last_success_at).getTime()
    return !Number.isFinite(lastRun) || Date.now() - lastRun >= STATUS_AUDIT_INTERVAL_MS
  } catch {
    return true
  }
}

function markStatusAudit() {
  fs.writeFileSync(
    STATUS_AUDIT_FILE,
    JSON.stringify({ last_success_at: new Date().toISOString() }, null, 2),
    'utf8'
  )
}

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER,
  requestTimeout: 300000,
  connectionTimeout: 30000,
  options: { encrypt: false, trustServerCertificate: true }
}

function clean(v)  { return String(v ?? '').trim() }
function num(v, d=6) { const n = Number(v ?? 0); return Number.isFinite(n) ? Number(n.toFixed(d)) : 0 }
function writeStatus(text) {
  const line = `${new Date().toLocaleString('es-PE', { hour12: false })} | ${text}`
  fs.writeFileSync(STATUS_FILE, line + '\n', 'utf8')
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  fs.writeFileSync(WATCHDOG_HB, new Date().toISOString(), 'utf8')  // heartbeat para watchdog
  console.log(text)
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function acquireLock() {
  try {
    const currentPid = String(process.pid)
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8')
      const lock = JSON.parse(raw)
      const ageMs = Date.now() - Number(lock.ts || 0)
      if (lock.pid && ageMs < 30 * 60 * 1000) {
        try {
          process.kill(Number(lock.pid), 0)
          writeStatus(`Recepcion: ya hay otro sync corriendo (PID ${lock.pid}); saliendo para evitar duplicados`)
          return false
        } catch {}
      }
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: currentPid, ts: Date.now() }), 'utf8')
    return true
  } catch {
    return true
  }
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (String(lock.pid) === String(process.pid)) fs.unlinkSync(LOCK_FILE)
  } catch {}
}

async function withRetry(label, fn) {
  let lastErr = null
  for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
    try {
      const r = await fn()
      if (r?.error) throw r.error
      return r
    } catch (e) { lastErr = e }
    if (i < RETRY_ATTEMPTS) {
      const d = 1000 * i
      writeStatus(`${label}: reintento ${i}/${RETRY_ATTEMPTS} en ${d}ms`)
      await sleep(d)
    }
  }
  throw lastErr
}

async function upsert(table, rows, conflict, batchSize) {
  writeStatus(`${table}: enviando ${rows.length} filas en lotes de ${batchSize}`)
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    await withRetry(`${table}: upsert`, () => supabase.from(table).upsert(batch, { onConflict: conflict }))
    process.stdout.write(`\r${table}: ${Math.min(i + batch.length, rows.length)}/${rows.length}`)
  }
  if (rows.length) process.stdout.write('\n')
}

async function markReceptionSynced() {
  await withRetry('Supabase: actualizar estado sync', () =>
    supabase.from('erp_sync_status').upsert({
      id:           'reception_requests',
      source_path:  __dirname,
      synced_at:    new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'id' })
  )
}


// Revisa los slips pendientes (incluidos los que Rasecorp ya marco como
// completados) contra el ERP y actualiza su estado:
//   - ERP='C' (anulado) o NO encontrado en ERP → status_code='X' (ocultar)
//   - ERP='V' u otro no-T               → solo actualiza erp_status (visible con badge)
async function updateErpStatusForPending(pool, fullAudit = false) {
  // Supabase limita por defecto cada lectura a 1,000 filas. Paginar evita
  // dejar sin revisar guías antiguas (incluidas las ya completadas).
  const pendingRows = []
  for (let from = 0; ; from += 1000) {
    const { data } = await withRetry('Supabase: leer pendientes visibles', () => {
      let query = supabase.from('reception_requests')
        .select('id,erp_inv_request_id,doc_number,reception_status,status_code,erp_status')
        .neq('status_code', 'X')
      query = fullAudit ? query.eq('status_code', 'T') : query.eq('erp_status', 'T')
      return query.range(from, from + 999)
    })
    pendingRows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const rows = pendingRows.filter(row => clean(row.erp_inv_request_id))
  if (!rows.length) return { hidden: 0, statusUpdated: 0 }

  const toHide   = [] // { id, erp_status } → status_code='X'
  const toUpdate = [] // { id, erp_status } → solo erp_status, mantener visible

  for (let i = 0; i < rows.length; i += SQL_BATCH_SIZE) {
    const batch = rows.slice(i, i + SQL_BATCH_SIZE)
    const request = pool.request()
    const idParams = batch.map((row, index) => {
      const name = `slipId${i}_${index}`
      request.input(name, sql.VarChar, clean(row.erp_inv_request_id))
      return `@${name}`
    })
    const docParams = batch.map((row, index) => {
      const name = `slipDoc${i}_${index}`
      request.input(name, sql.VarChar, clean(row.doc_number))
      return `@${name}`
    })
    const { recordset } = await withRetry('SQL: verificar estado actual en ERP', () =>
      request.query(`
        SELECT
          CONVERT(varchar(36), SlipId) AS slip_id,
          NULLIF(LTRIM(RTRIM(CAST(DocNumber AS varchar(60)))), '') AS doc_number,
          CAST(StatusCode AS varchar(30)) AS status_code
        FROM SLIP
        WHERE CONVERT(varchar(36), SlipId) IN (${idParams.join(',')})
           OR NULLIF(LTRIM(RTRIM(CAST(DocNumber AS varchar(60)))), '') IN (${docParams.join(',')})
      `)
    )
    const erpById = new Map((recordset || []).map(row => [clean(row.slip_id).toUpperCase(), clean(row.status_code)]))
    const erpByDoc = new Map((recordset || []).map(row => [clean(row.doc_number).toUpperCase(), clean(row.status_code)]))
    for (const row of batch) {
      const key       = clean(row.erp_inv_request_id).toUpperCase()
      const docKey    = clean(row.doc_number).toUpperCase()
      const erpStatus = erpById.get(key) ?? erpByDoc.get(docKey) // fallback por numero fisico

      if (erpStatus === undefined) {
        // No encontrado en ERP: slip archivado/borrado → ocultar
        toHide.push({ id: row.id, erp_status: null })
      } else if (erpStatus === 'C') {
        // Anulado en ERP → ocultar
        toHide.push({ id: row.id, erp_status: 'C' })
      } else if (erpStatus !== 'T' && clean(row.erp_status).toUpperCase() !== erpStatus) {
        // Recibido ('V') u otro estado → mantener visible, actualizar badge
        // solo cuando el valor realmente cambio. Antes se repetia el mismo
        // PATCH cada cinco minutos para miles de slips ya procesados.
        toUpdate.push({ id: row.id, erp_status: erpStatus })
      }
    }
  }

  // Agrupar por estado conserva el mismo resultado que las actualizaciones
  // individuales, pero evita cientos de solicitudes HTTP por cada ciclo.
  const updateRowsByErpStatus = async (label, rowsToUpdate, extraFields) => {
    const groups = new Map()
    for (const row of rowsToUpdate) {
      const key = row.erp_status ?? '__NULL__'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row.id)
    }
    for (const [key, ids] of groups) {
      const erpStatus = key === '__NULL__' ? null : key
      for (let i = 0; i < ids.length; i += UPDATE_IN_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + UPDATE_IN_BATCH_SIZE)
        await withRetry(label, () =>
          supabase.from('reception_requests')
            .update({ ...extraFields, erp_status: erpStatus, updated_at: now })
            .in('id', batchIds)
        )
      }
    }
  }

  const now = new Date().toISOString()
  await updateRowsByErpStatus('Supabase: ocultar slips', toHide, { status_code: 'X' })
  await updateRowsByErpStatus('Supabase: actualizar estados ERP', toUpdate, {})

  return { hidden: toHide.length, statusUpdated: toUpdate.length }
}

// â”€â”€â”€ Query principal: SLIP EN TRÃNSITO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// StatusCode = 'T' â†’ En trÃ¡nsito (enviado desde CD, aÃºn no recibido por la tienda)
function bracketIdentifier(name) {
  return `[${String(name).replace(/]/g, ']]')}]`
}

function slipQuery() {
  return `
    SELECT
      CONVERT(varchar(36), slp.SlipId) AS slip_id,
      CAST(slp.SlipNo AS varchar(30)) AS slip_no,
      NULLIF(LTRIM(RTRIM(CAST(slp.DocNumber AS varchar(60)))), '') AS doc_number,
      COALESCE(
        NULLIF(LTRIM(RTRIM(CAST(ir.DocNumber AS varchar(60)))), ''),
        CAST(ir.InvRequestNo AS varchar(30)),
        CAST(slp.SlipNo AS varchar(30))
      ) AS inv_request_no_ir,
      'T' AS status_code,
      slp.StatusCode AS erp_status_code,
      slp.SlipDate AS slip_date,
      slp.CreationDate AS creation_date,

      -- Tienda ORIGEN (quien envÃ­a: CD-GPC u otra tienda)
      CAST(src.StoreNo AS varchar(20)) AS source_store_code,
      src.StoreName AS source_store_name,

      -- Tienda DESTINO (quien recibe: la tienda que debe recepcionar)
      CAST(dst.StoreNo AS varchar(20)) AS destination_store_code,
      dst.StoreName AS destination_store_name,

      COALESCE(NULLIF(irFlag.IRFlag1Description, ''), '') AS reason,
      COALESCE(NULLIF(slp.Comment1, ''), NULLIF(slp.Notes, ''), NULLIF(ir.Notes, ''), '') AS notes,

      -- Usuario que entrega/genera la guia (SLIP) en la tienda proveedora
      CAST(slp.EmployeeCode AS varchar(20)) AS dispatched_by_code,
      emp.FullName AS dispatched_by_name,

      -- LÃ­neas del slip
      sl.LineId AS line_id,
      CAST(sl.SKU AS varchar(30)) AS sku,
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, ''), CAST(sl.SKU AS varchar(30))) AS product_code,
      COALESCE(NULLIF(p.UPC, ''), '') AS barcode,
      COALESCE(NULLIF(sl.LineDescription, ''), NULLIF(fv.Desc1, '')) AS description,
      u.UDF1Description AS unit,
      CAST(sl.OutQty AS decimal(18, 6)) AS qty_requested,
      CAST(COALESCE(sl.OutQty, 0) AS decimal(18, 6)) AS qty_pending

    FROM SLIP slp
    JOIN SLIP_LINE sl ON slp.SlipId = sl.SlipId
    JOIN STORE src ON slp.StoreNo = src.StoreNo
    JOIN STORE dst ON slp.OutToStore = dst.StoreNo
    JOIN PRODUCT p ON sl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON sl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    LEFT JOIN INVENTORY_REQUEST ir ON slp.TDId = ir.InvRequestId
    LEFT JOIN INVENTORY_REQUEST_FLAG1 irFlag ON ir.IRFlag1 = irFlag.IRFlag1
    LEFT JOIN EMPLOYEE emp ON slp.EmployeeCode = emp.EmployeeCode

    WHERE NULLIF(LTRIM(RTRIM(CAST(slp.DocNumber AS varchar(60)))), '') IS NOT NULL
      AND (
        (slp.StatusCode = 'T'
         AND (@sinceDate IS NULL OR slp.SlipDate >= CONVERT(date, @sinceDate)))
        OR
        (slp.StatusCode = 'V'
         AND slp.SlipDate >= CONVERT(date, @recentDate))
      )
  `
}

function mapRequests(rows) {
  const now = new Date().toISOString()
  const grouped = new Map()
  for (const row of rows) {
    const key = clean(row.slip_id)
    if (!key) continue
    const cur = grouped.get(key) || {
      erp_inv_request_id:    key,
      inv_request_no:        clean(row.inv_request_no_ir) || clean(row.slip_no) || null,
      doc_number:            clean(row.doc_number) || null,
      status_code:           'T',
      status_name:           'En trÃ¡nsito',
      erp_status:            clean(row.erp_status_code) || 'T',
      request_date:          row.slip_date || null,
      creation_date:         row.creation_date || null,
      destination_store_code: clean(row.destination_store_code),
      destination_store_name: clean(row.destination_store_name) || null,
      source_store_code:     clean(row.source_store_code),
      source_store_name:     clean(row.source_store_name) || null,
      reason:                clean(row.reason) || null,
      notes:                 clean(row.notes) || null,
      dispatched_by_code:    clean(row.dispatched_by_code) || null,
      dispatched_by_name:    clean(row.dispatched_by_name) || null,
      line_count:            0,
      qty_requested_total:   0,
      qty_pending_total:     0,
      source_updated_at:     now,
      updated_at:            now,
    }
    cur.line_count++
    cur.qty_requested_total = num(cur.qty_requested_total + num(row.qty_requested))
    cur.qty_pending_total   = num(cur.qty_pending_total   + num(row.qty_pending))
    grouped.set(key, cur)
  }
  return [...grouped.values()].filter(r => r.destination_store_code && r.source_store_code)
}

function mapLines(rows) {
  const now = new Date().toISOString()
  return rows.map(row => ({
    id:                  `${clean(row.slip_id)}|${clean(row.line_id)}`,
    erp_inv_request_id:  clean(row.slip_id),
    line_id:             Number(row.line_id),
    sku:                 clean(row.sku) || null,
    product_code:        clean(row.product_code),
    barcode:             clean(row.barcode) || null,
    description:         clean(row.description) || null,
    unit:                clean(row.unit) || null,
    qty_requested:       num(row.qty_requested),
    qty_pending:         num(row.qty_pending),
    source_updated_at:   now,
    updated_at:          now,
  })).filter(r => r.erp_inv_request_id && r.line_id && r.product_code)
}

async function syncOnce() {
  if (!acquireLock()) return
  const sinceDateStr = LOOKBACK_DAYS > 0
    ? (() => {
        const sinceDate = new Date()
        sinceDate.setDate(sinceDate.getDate() - LOOKBACK_DAYS)
        return sinceDate.toISOString().slice(0, 10)
      })()
    : null
  const recentDate = (() => {
    const d = new Date()
    d.setDate(d.getDate() - RECENT_RECEIVED_DAYS)
    return d.toISOString().slice(0, 10)
  })()
  writeStatus(sinceDateStr
    ? `Recepcion: sincronizando slips T desde ${sinceDateStr}, recibidos recientes desde ${recentDate}`
    : `Recepcion: sincronizando slips T (todos) + recibidos recientes desde ${recentDate}`)

  let pool
  try {
    pool = await withRetry('SQL: conectar', () => new sql.ConnectionPool(sqlConfig).connect())
    const result = await withRetry('SQL: leer slips', () =>
      pool.request()
        .input('sinceDate',   sql.VarChar, sinceDateStr)
        .input('recentDate',  sql.VarChar, recentDate)
        .query(slipQuery())
    )

    const requests = mapRequests(result.recordset)
    const lines    = mapLines(result.recordset)
    const transitCount  = requests.filter(r => r.erp_status === 'T').length
    const receivedCount = requests.filter(r => r.erp_status !== 'T').length
    writeStatus(`Slips encontrados: ${transitCount} en transito, ${receivedCount} recibidos en ERP, ${lines.length} lineas`)

    if (requests.length) {
      // Upsert: NO toca reception_status ni completed_at si ya existe
      await upsert('reception_requests', requests, 'erp_inv_request_id', REQUEST_BATCH_SIZE)
    }

    if (lines.length) {
      const uniqueErpIds = [...new Set(lines.map(r => r.erp_inv_request_id))]
      const allReqRows = []
      for (let i = 0; i < uniqueErpIds.length; i += IN_BATCH_SIZE) {
        const chunk = uniqueErpIds.slice(i, i + IN_BATCH_SIZE)
        const res = await withRetry('Supabase: leer IDs', () =>
          supabase.from('reception_requests')
            .select('id,erp_inv_request_id')
            .in('erp_inv_request_id', chunk)
        )
        allReqRows.push(...(res.data || []))
      }
      const idMap = new Map(allReqRows.map(r => [r.erp_inv_request_id, r.id]))
      const linesWithId = lines
        .map(r => ({ ...r, request_id: idMap.get(r.erp_inv_request_id) || null }))
        .filter(r => r.request_id)
      await upsert('reception_request_lines', linesWithId, 'id', LINE_BATCH_SIZE)
    }

    // La carga principal ya esta completa. El chequeo de anulados/recibidos es
    // complementario y no debe provocar una alerta falsa de ERP detenido.
    await markReceptionSynced()
    writeStatus('Recepcion: datos principales sincronizados; verificando estados pendientes')

    // Revisar slips pendientes: ocultar anulados/archivados, actualizar badge de recibidos
    const runFullStatusAudit = statusAuditDue()
    const { hidden, statusUpdated } = await updateErpStatusForPending(pool, runFullStatusAudit)
    if (runFullStatusAudit) markStatusAudit()

    await markReceptionSynced()

    writeStatus(`Sync recepcion OK: ${requests.length} slips (${transitCount} T / ${receivedCount} V), ${lines.length} lineas | pendientes: ${hidden} ocultados, ${statusUpdated} badge actualizados`)
  } finally {
    if (pool) await pool.close()
    releaseLock()
  }
}

async function loop() {
  while (true) {
    try { await syncOnce() }
    catch (e) { writeStatus(`ERROR recepcion: ${e.message || e}`); console.error(e) }
    await sleep(INTERVAL_MS)
  }
}

const args = process.argv.slice(2)
if (args.includes('--once')) {
  syncOnce().catch(e => { writeStatus(`ERROR: ${e.message || e}`); process.exit(1) })
} else {
  loop()
}
