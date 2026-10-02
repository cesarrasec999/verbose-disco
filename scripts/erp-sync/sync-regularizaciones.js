/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Verifica los N° de requerimiento de regularizacion que la tienda proveedora
 * anota manualmente en el modulo de Diferencias (reception_difference_regularizations,
 * status='atendido'). Busca ese requerimiento directo en RMS (INVENTORY_REQUEST +
 * SLIP por TDId, SIN exigir guia/DocNumber - a diferencia de sync-recepcion.js,
 * que si la exige para el modulo de Recepcion). Solo el SLIP mas reciente del
 * requerimiento decide el estado: StatusCode='V' (recibido) regulariza y
 * cualquier otro estado (incluido 'T', en transito) mantiene la diferencia
 * como "atendido". Asi una regularizacion nunca queda congelada si RMS vuelve
 * a mostrar el requerimiento en transito.
 *
 * NO toca reception_requests, reception_request_lines, ni ninguna tabla del
 * modulo de Recepcion. Solo lee/actualiza reception_difference_regularizations
 * (nunca borra filas, solo actualiza status/regularized_at/updated_at).
 */

require('dotenv').config()

const fs   = require('fs')
const path = require('path')
const sql  = require('mssql')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
)

const STATUS_FILE = path.join(__dirname, 'regularizaciones-sync-status.txt')
const LOG_FILE     = path.join(__dirname, 'regularizaciones-sync.log')
const LOCK_FILE     = path.join(__dirname, 'regularizaciones-sync.lock')
const SQL_BATCH_SIZE = 200
const UPDATE_BATCH_SIZE = 100

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER,
  requestTimeout: 300000,
  connectionTimeout: 30000,
  options: { encrypt: false, trustServerCertificate: true }
}

function clean(v) { return String(v ?? '').trim() }

function writeStatus(text) {
  const line = `${new Date().toLocaleString('es-PE', { hour12: false })} | ${text}`
  fs.writeFileSync(STATUS_FILE, line + '\n', 'utf8')
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  console.log(text)
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr = null
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fn()
      if (r?.error) throw r.error
      return r
    } catch (e) { lastErr = e }
    if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i))
  }
  throw lastErr
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs
      if (ageMs < 10 * 60 * 1000) return false // otro run en progreso (<10 min)
    }
    fs.writeFileSync(LOCK_FILE, new Date().toISOString(), 'utf8')
    return true
  } catch { return true }
}

function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE) } catch {}
}

// "1000-1489" → { storeNo: 0, reqNo: 1489 }  (1000 = offset de tienda usado en el #RQ)
function parseRequirementRef(ref) {
  const parts = clean(ref).split('-')
  if (parts.length < 2) return null
  const storeCode = Number(parts[0])
  const reqNo     = Number(parts.slice(1).join('-'))
  if (!Number.isFinite(storeCode) || !Number.isFinite(reqNo)) return null
  return { storeNo: storeCode - 1000, reqNo }
}

function requirementKey(storeNo, reqNo) {
  return `${storeNo}|${reqNo}`
}

async function readRequirementStatuses(pool, rows) {
  const unique = new Map()
  for (const row of rows) {
    if (!row.parsed) continue
    unique.set(requirementKey(row.parsed.storeNo, row.parsed.reqNo), row.parsed)
  }

  const requested = [...unique.values()]
  const statuses = new Map()
  for (let offset = 0; offset < requested.length; offset += SQL_BATCH_SIZE) {
    const batch = requested.slice(offset, offset + SQL_BATCH_SIZE)
    const request = pool.request()
    const values = batch.map((item, index) => {
      request.input(`store_${index}`, sql.Int, item.storeNo)
      request.input(`req_${index}`, sql.Int, item.reqNo)
      return `(@store_${index}, @req_${index})`
    })
    const { recordset } = await withRetry('SQL: verificar requerimientos por lote', () =>
      request.query(`
        WITH requested(store_no, req_no) AS (
          SELECT store_no, req_no
          FROM (VALUES ${values.join(',')}) AS values_list(store_no, req_no)
        )
        SELECT
          requested.store_no,
          requested.req_no,
          latest.slip_status
        FROM requested
        OUTER APPLY (
          SELECT TOP 1 CAST(s.StatusCode AS varchar(30)) AS slip_status
          FROM INVENTORY_REQUEST ir
          JOIN SLIP s ON s.TDId = ir.InvRequestId
          WHERE ir.StoreNo = requested.store_no
            AND ir.InvRequestNo = requested.req_no
          ORDER BY COALESCE(s.CreationDate, s.SlipDate) DESC, s.TDId DESC
        ) latest
      `)
    )
    for (const item of recordset || []) {
      statuses.set(
        requirementKey(Number(item.store_no), Number(item.req_no)),
        clean(item.slip_status).toUpperCase(),
      )
    }
  }
  return statuses
}

async function updateRowsByIds(label, ids, values) {
  for (let offset = 0; offset < ids.length; offset += UPDATE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + UPDATE_BATCH_SIZE)
    await withRetry(label, () =>
      supabase.from('reception_difference_regularizations')
        .update(values)
        .in('id', batch)
    )
  }
}

async function syncOnce() {
  if (!acquireLock()) { writeStatus('Regularizaciones: ya hay otro run en progreso; saliendo'); return }
  let pool
  try {
    const { data, error } = await withRetry('Supabase: leer diferencias pendientes de verificar', () =>
      supabase.from('reception_difference_regularizations')
        .select('id,diff_key,requirement_ref,status')
        .in('status', ['atendido', 'regularizado'])
    )
    if (error) throw error
    const pending = (data || [])
      .filter(row => clean(row.requirement_ref))
      .map(row => ({ ...row, parsed: parseRequirementRef(row.requirement_ref) }))

    if (!pending.length) {
      writeStatus('Regularizaciones: sin diferencias atendidas pendientes de verificar')
      return
    }

    pool = await withRetry('SQL: conectar', () => new sql.ConnectionPool(sqlConfig).connect())

    const statuses = await readRequirementStatuses(pool, pending)
    const regularizeIds = []
    const revertIds = []
    let sinMatch = 0
    for (const row of pending) {
      if (!row.parsed) { sinMatch++; continue }
      const latestStatus = statuses.get(requirementKey(row.parsed.storeNo, row.parsed.reqNo)) || ''
      const received = latestStatus === 'V'

      // Si RMS no confirma recepcion (incluido T/en transito), no permitir
      // ni conservar "regularizado". Se conserva el requerimiento para
      // seguirlo verificando en el siguiente ciclo.
      if (!received) {
        sinMatch++
        if (row.status === 'regularizado') {
          revertIds.push(row.id)
        }
        continue
      }
      if (row.status !== 'regularizado') regularizeIds.push(row.id)
    }

    const now = new Date().toISOString()
    await updateRowsByIds(
      'Supabase: marcar regularizaciones por lote',
      regularizeIds,
      { status: 'regularizado', regularized_at: now, updated_at: now },
    )
    await updateRowsByIds(
      'Supabase: revertir regularizaciones por lote',
      revertIds,
      { status: 'atendido', regularized_at: null, updated_at: now },
    )

    writeStatus(`Regularizaciones OK: ${pending.length} revisadas, ${regularizeIds.length} regularizadas, ${revertIds.length} revertidas a atendido, ${sinMatch} aun no recibidas en RMS`)
  } catch (e) {
    writeStatus(`ERROR regularizaciones: ${e.message || e}`)
  } finally {
    if (pool) await pool.close()
    releaseLock()
  }
}

const args = process.argv.slice(2)
if (args.includes('--once')) {
  syncOnce().then(() => process.exit(0)).catch(e => { writeStatus(`ERROR: ${e.message || e}`); process.exit(1) })
} else {
  module.exports = { syncOnce }
}
