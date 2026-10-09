require('dotenv').config()

const fs = require('fs')
const path = require('path')
const sql = require('mssql')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
)

// Este proceso es la fuente central de movimientos ERP. Las rotaciones se
// recalculan en su cierre diario, nunca en el ciclo incremental de 5 minutos.
const BATCH_SIZE = Math.min(Math.max(Number(process.env.MOVEMENTS_BATCH_SIZE || 500), 50), 750)
const HOT_LOOKBACK_DAYS = Math.max(1, Number(process.env.MOVEMENTS_HOT_LOOKBACK_DAYS || 1))
const RECONCILE_LOOKBACK_DAYS = Math.max(
  HOT_LOOKBACK_DAYS,
  Number(process.env.MOVEMENTS_RECONCILE_LOOKBACK_DAYS || 7),
)
const RECONCILE_INTERVAL_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.MOVEMENTS_RECONCILE_INTERVAL_MS || 60 * 60 * 1000),
)
const RECONCILE_STATE_FILE = path.join(__dirname, 'movements-reconcile-state.json')

function periodicReconciliationDue() {
  try {
    const state = JSON.parse(fs.readFileSync(RECONCILE_STATE_FILE, 'utf8'))
    const lastRun = new Date(state.last_success_at).getTime()
    return !Number.isFinite(lastRun) || Date.now() - lastRun >= RECONCILE_INTERVAL_MS
  } catch {
    return true
  }
}

function markPeriodicReconciliation() {
  fs.writeFileSync(
    RECONCILE_STATE_FILE,
    JSON.stringify({ last_success_at: new Date().toISOString() }, null, 2),
    'utf8',
  )
}

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

function assertDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`${label} debe tener formato YYYY-MM-DD`)
  }
  return value
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function numberValue(value) {
  const num = Number(value ?? 0)
  return Number.isFinite(num) ? Number(num.toFixed(6)) : 0
}

function clean(value) {
  return String(value ?? '').trim()
}

// RMS entrega AdjustmentDate como una hora local sin zona. mssql la materializa
// como UTC; reconstruimos la hora de Perú para no desplazarla cinco horas.
function rmsPeruDateToIso(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value
  const pad = number => String(number).padStart(2, '0')
  const wallClock = [
    value.getUTCFullYear(),
    pad(value.getUTCMonth() + 1),
    pad(value.getUTCDate())
  ].join('-') + 'T' + [
    pad(value.getUTCHours()),
    pad(value.getUTCMinutes()),
    pad(value.getUTCSeconds())
  ].join(':') + '-05:00'
  return new Date(wallClock).toISOString()
}

function makeUniqueMovementKeys(rows) {
  const seen = new Map()
  let duplicates = 0

  return rows.map(row => {
    const baseKey = row.movement_key
    const count = (seen.get(baseKey) || 0) + 1
    seen.set(baseKey, count)

    if (count === 1) return row
    duplicates += 1
    return {
      ...row,
      movement_key: `${baseKey}|${count}`
    }
  }).map((row, index) => {
    if (row.movement_key) return row
    return {
      ...row,
      movement_key: `FALLBACK|${row.source_type}|${row.store_code}|${row.product_code}|${row.movement_date}|${index + 1}`
    }
  }).map((row, index, all) => {
    if (index === all.length - 1 && duplicates > 0) {
      console.log('Llaves duplicadas normalizadas:', duplicates)
    }
    return row
  })
}

function safeSqlIdentifier(value) {
  return `[${String(value).replace(/]/g, ']]')}]`
}

async function resolveReceiptBalanceExpression(pool) {
  const result = await pool.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'RECEIPT_LINE'
  `)
  const available = new Map((result.recordset || []).map(row => [String(row.COLUMN_NAME).toUpperCase(), row.COLUMN_NAME]))
  const candidates = ['SALDO', 'BALANCE_AFTER', 'QTY_BALANCE', 'BALANCE_QTY', 'STOCK_BALANCE', 'BALANCE', 'QTY_ON_HAND', 'ON_HAND']
  const column = candidates.map(name => available.get(name)).find(Boolean)

  if (!column) {
    const related = [...available.values()].filter(name => /saldo|balance|stock|on.?hand/i.test(name))
    console.warn(`Saldo RMS no encontrado en RECEIPT_LINE. Campos relacionados: ${related.join(', ') || 'ninguno'}`)
    return 'NULL'
  }

  console.log(`Saldo RMS para ventas: RECEIPT_LINE.${column}`)
  return `CAST(rl.${safeSqlIdentifier(column)} AS decimal(18, 6))`
}

function movementQuery(receiptBalanceExpression = 'NULL') {
  return `
    SELECT
      CONCAT('ADJUSTMENT|', CONVERT(varchar(36), a.AdjustmentId), '|', CAST(al.SKU AS varchar(30)), '|', CONVERT(varchar(30), al.QtyDiff)) AS movement_key,
      'ADJUSTMENT' AS source_type,
      CONVERT(varchar(36), a.AdjustmentId) AS source_id,
      COALESCE(NULLIF(s.StoreCode, ''), CAST(a.StoreNo AS varchar(20))) AS store_code,
      a.AdjustmentDate AS movement_date,
      'Ajuste por Cantidad' AS operation,
      COALESCE(NULLIF(a.DocNumber, ''), CAST(a.AdjustmentNo AS varchar(30)), '') AS document_no,
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, ''), CAST(al.SKU AS varchar(30))) AS product_code,
      NULLIF(fv.Desc1, '') AS description,
      u.UDF1Description AS unit,
      CAST(al.Cost AS decimal(18, 6)) AS cost,
      CAST(al.QtyDiff AS decimal(18, 6)) AS quantity,
      COALESCE(NULLIF(ar.ReasonDescription, ''), NULLIF(a.Notes, ''), NULLIF(a.DocReference, ''), '') AS reason,
      COALESCE(NULLIF(e.FullName, ''), NULLIF(a.EmployeeCode, ''), NULLIF(a.CreatedBy, '')) AS adjustment_user,
      COALESCE(NULLIF(e.FullName, ''), NULLIF(a.EmployeeCode, ''), NULLIF(a.CreatedBy, '')) AS movement_employee,
      NULL AS reception_employee,
      NULL AS transfer_store_code,
      CASE WHEN a.ReverseDocNo IS NOT NULL AND a.ReverseDocNo <> '' AND a.StatusCode = 'I' THEN 'REVERSANDO'
           WHEN a.ReverseDocNo IS NOT NULL AND a.ReverseDocNo <> '' THEN 'REVERSADO'
           WHEN a.StatusCode = 'A' THEN 'ACTIVO'
           WHEN a.StatusCode IN ('E', 'R') THEN 'RECIBIDO'
           WHEN a.StatusCode = 'T' THEN 'EN TRANSITO'
           WHEN a.StatusCode = 'C' THEN 'REVERSADO'
           WHEN a.StatusCode = 'I' THEN 'REVERSANDO'
           ELSE ISNULL(a.StatusCode, 'SIN ESTADO') END AS status,
      NULL AS balance_after
    FROM ADJUSTMENT a
    JOIN ADJUSTMENT_LINE al ON al.AdjustmentId = a.AdjustmentId
    JOIN STORE s ON a.StoreNo = s.StoreNo
    LEFT JOIN ADJUSTMENT_REASON ar ON a.ReasonCode = ar.ReasonCode
    LEFT JOIN EMPLOYEE e ON e.EmployeeCode = a.EmployeeCode
    JOIN PRODUCT p ON al.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON al.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    WHERE a.AdjustmentDate >= @startDate
      AND a.AdjustmentDate < @endExclusive
      AND al.QtyDiff <> 0

    UNION ALL

    SELECT
      CONCAT('VOUCHER|P|', CONVERT(varchar(36), v.VoucherId), '|', vl.SKU, '|', CONVERT(varchar(30), vl.Qty), '|', CONVERT(varchar(30), vl.Cost)),
      'VOUCHER_PURCHASE',
      CONVERT(varchar(36), v.VoucherId),
      s.StoreCode,
      v.ReceiveDate,
      'Compra',
      COALESCE(NULLIF(v.DocNumber, ''), NULLIF(v.InvoiceNumber, ''), CAST(v.VoucherNo AS varchar(30)), ''),
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, '')),
      vl.LineDescription,
      u.UDF1Description,
      CAST(vl.Cost AS decimal(18, 6)),
      CAST(vl.Qty AS decimal(18, 6)),
      COALESCE(NULLIF(v.Comment1, ''), NULLIF(v.Notes, ''), 'NACIONAL'),
      COALESCE(NULLIF(ve.FullName, ''), NULLIF(vc.FullName, ''), NULLIF(v.Clerk, ''), NULLIF(v.CreatedBy, '')) AS adjustment_user,
      COALESCE(NULLIF(ve.FullName, ''), NULLIF(vc.FullName, ''), NULLIF(v.Clerk, ''), NULLIF(v.CreatedBy, '')) AS movement_employee,
      NULL AS reception_employee,
      NULL AS transfer_store_code,
      'ACTIVO',
      NULL AS balance_after
    FROM VOUCHER v
    JOIN VOUCHER_LINE vl ON v.VoucherId = vl.VoucherId
    JOIN STORE s ON v.StoreNo = s.StoreNo
    JOIN PRODUCT p ON vl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON vl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    LEFT JOIN EMPLOYEE ve ON CAST(ve.EmployeeCode AS varchar(50)) = CAST(v.Clerk AS varchar(50))
    LEFT JOIN EMPLOYEE vc ON CAST(vc.EmployeeCode AS varchar(50)) = CAST(v.CreatedBy AS varchar(50))
    WHERE v.ReceiveDate >= @startDate AND v.ReceiveDate < @endExclusive AND v.TypeCode = 'P' AND v.StatusCode = 'A'

    UNION ALL

    SELECT
      CONCAT('VOUCHER|R|', CONVERT(varchar(36), v.VoucherId), '|', vl.SKU, '|', CONVERT(varchar(30), vl.Qty), '|', CONVERT(varchar(30), vl.Cost)),
      'VOUCHER_RETURN',
      CONVERT(varchar(36), v.VoucherId),
      s.StoreCode,
      v.ReceiveDate,
      'Retorno proveedor',
      COALESCE(NULLIF(v.DocNumber, ''), NULLIF(v.InvoiceNumber, ''), CAST(v.VoucherNo AS varchar(30)), ''),
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, '')),
      vl.LineDescription,
      u.UDF1Description,
      CAST(vl.Cost AS decimal(18, 6)),
      CAST(vl.Qty * -1 AS decimal(18, 6)),
      COALESCE(NULLIF(v.Comment1, ''), NULLIF(v.Notes, ''), 'RETORNO PROVEEDOR'),
      COALESCE(NULLIF(ve.FullName, ''), NULLIF(vc.FullName, ''), NULLIF(v.Clerk, ''), NULLIF(v.CreatedBy, '')) AS adjustment_user,
      COALESCE(NULLIF(ve.FullName, ''), NULLIF(vc.FullName, ''), NULLIF(v.Clerk, ''), NULLIF(v.CreatedBy, '')) AS movement_employee,
      NULL AS reception_employee,
      NULL AS transfer_store_code,
      'ACTIVO',
      NULL AS balance_after
    FROM VOUCHER v
    JOIN VOUCHER_LINE vl ON v.VoucherId = vl.VoucherId
    JOIN STORE s ON v.StoreNo = s.StoreNo
    JOIN PRODUCT p ON vl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON vl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    LEFT JOIN EMPLOYEE ve ON CAST(ve.EmployeeCode AS varchar(50)) = CAST(v.Clerk AS varchar(50))
    LEFT JOIN EMPLOYEE vc ON CAST(vc.EmployeeCode AS varchar(50)) = CAST(v.CreatedBy AS varchar(50))
    WHERE v.ReceiveDate >= @startDate AND v.ReceiveDate < @endExclusive AND v.TypeCode = 'R' AND v.StatusCode = 'A'

    UNION ALL

    SELECT
      CONCAT('SLIP|OUT|', CONVERT(varchar(36), slp.SlipId), '|', sl.SKU, '|', CONVERT(varchar(30), sl.OutQty)),
      'SLIP_OUT',
      CONVERT(varchar(36), slp.SlipId),
      src.StoreCode,
      slp.SlipDate,
      'Salida por Transferencia',
      COALESCE(NULLIF(slp.DocNumber, ''), CAST(slp.SlipNo AS varchar(30)), ''),
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, '')),
      sl.LineDescription,
      u.UDF1Description,
      CAST(sl.AvgCost AS decimal(18, 6)),
      CAST(sl.OutQty * -1 AS decimal(18, 6)),
      COALESCE(NULLIF(irFlag.IRFlag1Description, ''), NULLIF(slp.Comment1, ''), NULLIF(slp.Notes, ''), ''),
      COALESCE(NULLIF(ire.FullName, ''), NULLIF(ir.EmployeeCode, ''), NULLIF(se.FullName, ''), NULLIF(sc.FullName, ''), NULLIF(slp.EmployeeCode, ''), NULLIF(slp.CreatedBy, '')) AS adjustment_user,
      COALESCE(NULLIF(ire.FullName, ''), NULLIF(ir.EmployeeCode, ''), NULLIF(se.FullName, ''), NULLIF(sc.FullName, ''), NULLIF(slp.EmployeeCode, ''), NULLIF(slp.CreatedBy, '')) AS movement_employee,
      COALESCE(NULLIF(re.FullName, ''), NULLIF(slp.ReceivedBy, '')) AS reception_employee,
      CASE WHEN slp.OutToStore = 0 THEN 'CD-GPC' ELSE COALESCE(NULLIF(dst.StoreCode, ''), CAST(slp.OutToStore AS varchar(20))) END AS transfer_store_code,
      CASE WHEN slp.StatusCode = 'V' AND slp.ReceivedDate < @endExclusive THEN 'RECIBIDO' ELSE 'EN TRANSITO' END,
      NULL AS balance_after
    FROM SLIP slp
    JOIN SLIP_LINE sl ON slp.SlipId = sl.SlipId
    LEFT JOIN STORE src ON slp.StoreNo = src.StoreNo
    LEFT JOIN STORE dst ON slp.OutToStore = dst.StoreNo
    JOIN PRODUCT p ON sl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON sl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    LEFT JOIN INVENTORY_REQUEST ir ON slp.TDId = ir.InvRequestId
    LEFT JOIN INVENTORY_REQUEST_FLAG1 irFlag ON ir.IRFlag1 = irFlag.IRFlag1
    LEFT JOIN EMPLOYEE ire ON CAST(ire.EmployeeCode AS varchar(50)) = CAST(ir.EmployeeCode AS varchar(50))
    LEFT JOIN EMPLOYEE se ON CAST(se.EmployeeCode AS varchar(50)) = CAST(slp.EmployeeCode AS varchar(50))
    LEFT JOIN EMPLOYEE sc ON CAST(sc.EmployeeCode AS varchar(50)) = CAST(slp.CreatedBy AS varchar(50))
    LEFT JOIN EMPLOYEE re ON CAST(re.EmployeeCode AS varchar(50)) = CAST(slp.ReceivedBy AS varchar(50))
    WHERE slp.StatusCode IN ('T', 'V')
      AND (
        (slp.SlipDate >= @startDate AND slp.SlipDate < @endExclusive)
        OR slp.StatusCode = 'T'
        OR (slp.ReceivedDate >= @startDate AND slp.ReceivedDate < @endExclusive)
      )

    UNION ALL

    SELECT
      CONCAT('SLIP|IN|', CONVERT(varchar(36), slp.SlipId), '|', sl.SKU, '|', CONVERT(varchar(30), sl.InQty)),
      'SLIP_IN',
      CONVERT(varchar(36), slp.SlipId),
      CASE WHEN slp.OutToStore = 0 THEN 'CD-GPC' ELSE COALESCE(NULLIF(dst.StoreCode, ''), CAST(slp.OutToStore AS varchar(20))) END,
      slp.SlipDate,
      'Ingreso por Transferencia',
      COALESCE(NULLIF(slp.DocNumber, ''), CAST(slp.SlipNo AS varchar(30)), ''),
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, '')),
      sl.LineDescription,
      u.UDF1Description,
      CAST(sl.AvgCost AS decimal(18, 6)),
      CAST(CASE WHEN slp.StatusCode = 'V' AND slp.ReceivedDate < @endExclusive THEN sl.InQty ELSE 0 END AS decimal(18, 6)),
      COALESCE(NULLIF(irFlag.IRFlag1Description, ''), NULLIF(slp.Comment1, ''), NULLIF(slp.Notes, ''), ''),
      COALESCE(NULLIF(ire.FullName, ''), NULLIF(ir.EmployeeCode, ''), NULLIF(se.FullName, ''), NULLIF(sc.FullName, ''), NULLIF(slp.EmployeeCode, ''), NULLIF(slp.CreatedBy, '')) AS adjustment_user,
      COALESCE(NULLIF(ire.FullName, ''), NULLIF(ir.EmployeeCode, ''), NULLIF(se.FullName, ''), NULLIF(sc.FullName, ''), NULLIF(slp.EmployeeCode, ''), NULLIF(slp.CreatedBy, '')) AS movement_employee,
      COALESCE(NULLIF(re.FullName, ''), NULLIF(slp.ReceivedBy, '')) AS reception_employee,
      CASE WHEN slp.StoreNo = 0 THEN 'CD-GPC' ELSE COALESCE(NULLIF(src.StoreCode, ''), CAST(slp.StoreNo AS varchar(20))) END AS transfer_store_code,
      CASE WHEN slp.StatusCode = 'V' AND slp.ReceivedDate < @endExclusive THEN 'RECIBIDO' ELSE 'EN TRANSITO' END,
      NULL AS balance_after
    FROM SLIP slp
    JOIN SLIP_LINE sl ON slp.SlipId = sl.SlipId
    LEFT JOIN STORE dst ON slp.OutToStore = dst.StoreNo
    LEFT JOIN STORE src ON slp.StoreNo = src.StoreNo
    JOIN PRODUCT p ON sl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON sl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    LEFT JOIN INVENTORY_REQUEST ir ON slp.TDId = ir.InvRequestId
    LEFT JOIN INVENTORY_REQUEST_FLAG1 irFlag ON ir.IRFlag1 = irFlag.IRFlag1
    LEFT JOIN EMPLOYEE ire ON CAST(ire.EmployeeCode AS varchar(50)) = CAST(ir.EmployeeCode AS varchar(50))
    LEFT JOIN EMPLOYEE se ON CAST(se.EmployeeCode AS varchar(50)) = CAST(slp.EmployeeCode AS varchar(50))
    LEFT JOIN EMPLOYEE sc ON CAST(sc.EmployeeCode AS varchar(50)) = CAST(slp.CreatedBy AS varchar(50))
    LEFT JOIN EMPLOYEE re ON CAST(re.EmployeeCode AS varchar(50)) = CAST(slp.ReceivedBy AS varchar(50))
    WHERE slp.StatusCode IN ('T', 'V')
      AND (
        (slp.SlipDate >= @startDate AND slp.SlipDate < @endExclusive)
        OR slp.StatusCode = 'T'
        OR (slp.ReceivedDate >= @startDate AND slp.ReceivedDate < @endExclusive)
      )

    UNION ALL

    SELECT
      CONCAT('RECEIPT|R|', CONVERT(varchar(36), r.ReceiptId), '|', rl.SKU, '|', CONVERT(varchar(30), rl.Qty), '|', CONVERT(varchar(30), rl.AvgCost)),
      'RECEIPT_RETURN',
      CONVERT(varchar(36), r.ReceiptId),
      s.StoreCode,
      r.SalesDate,
      'Retorno',
      COALESCE(NULLIF(r.DocNumber, ''), CAST(r.ReceiptNo AS varchar(30)), ''),
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, '')),
      rl.LineDescription,
      u.UDF1Description,
      CAST(rl.AvgCost AS decimal(18, 6)),
      CAST(rl.Qty * -1 AS decimal(18, 6)),
      'NOTA CREDITO ELECTRONICA',
      COALESCE(NULLIF(ce.FullName, ''), NULLIF(cr.FullName, ''), NULLIF(r.Cashier, ''), NULLIF(r.CreatedBy, '')) AS adjustment_user,
      COALESCE(NULLIF(ce.FullName, ''), NULLIF(cr.FullName, ''), NULLIF(r.Cashier, ''), NULLIF(r.CreatedBy, '')) AS movement_employee,
      NULL AS reception_employee,
      NULL AS transfer_store_code,
      'ACTIVO',
      NULL AS balance_after
    FROM RECEIPT r
    JOIN RECEIPT_LINE rl ON r.ReceiptId = rl.ReceiptId
    JOIN STORE s ON r.StoreNo = s.StoreNo
    JOIN PRODUCT p ON rl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON rl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    LEFT JOIN EMPLOYEE ce ON CAST(ce.EmployeeCode AS varchar(50)) = CAST(r.Cashier AS varchar(50))
    LEFT JOIN EMPLOYEE cr ON CAST(cr.EmployeeCode AS varchar(50)) = CAST(r.CreatedBy AS varchar(50))
    WHERE r.SalesDate >= @startDate AND r.SalesDate < @endExclusive AND r.SalesCode = 'R' AND r.StatusCode = 'A' AND rl.StatusCode = 'A'

    UNION ALL

    SELECT
      CONCAT('RECEIPT|S|', CONVERT(varchar(36), r.ReceiptId), '|', rl.SKU, '|', CONVERT(varchar(30), rl.Qty), '|', CONVERT(varchar(30), rl.AvgCost)),
      'RECEIPT_SALE',
      CONVERT(varchar(36), r.ReceiptId),
      s.StoreCode,
      r.SalesDate,
      'Venta',
      COALESCE(NULLIF(r.DocNumber, ''), CAST(r.ReceiptNo AS varchar(30)), ''),
      COALESCE(NULLIF(p.ProductReference, ''), NULLIF(fv.StyleName, '')),
      rl.LineDescription,
      u.UDF1Description,
      CAST(rl.AvgCost AS decimal(18, 6)),
      CAST(rl.Qty * -1 AS decimal(18, 6)),
      COALESCE(NULLIF(c.CompanyName, ''), 'GENÉRICO'),
      COALESCE(NULLIF(ce.FullName, ''), NULLIF(cr.FullName, ''), NULLIF(r.Cashier, ''), NULLIF(r.CreatedBy, '')) AS adjustment_user,
      COALESCE(NULLIF(ce.FullName, ''), NULLIF(cr.FullName, ''), NULLIF(r.Cashier, ''), NULLIF(r.CreatedBy, '')) AS movement_employee,
      NULL AS reception_employee,
      NULL AS transfer_store_code,
      'ACTIVO',
      ${receiptBalanceExpression} AS balance_after
    FROM RECEIPT r
    JOIN RECEIPT_LINE rl ON r.ReceiptId = rl.ReceiptId
    JOIN STORE s ON r.StoreNo = s.StoreNo
    JOIN PRODUCT p ON rl.SKU = p.SKU
    LEFT JOIN FILTER_VIEW fv ON rl.SKU = fv.SKU
    LEFT JOIN PRODUCT_UDF1 u ON fv.UDF1 = u.UDF1
    LEFT JOIN CUSTOMER c ON r.CustomerNo = c.CustomerNo
    LEFT JOIN EMPLOYEE ce ON CAST(ce.EmployeeCode AS varchar(50)) = CAST(r.Cashier AS varchar(50))
    LEFT JOIN EMPLOYEE cr ON CAST(cr.EmployeeCode AS varchar(50)) = CAST(r.CreatedBy AS varchar(50))
    WHERE r.SalesDate >= @startDate AND r.SalesDate < @endExclusive AND r.SalesCode = 'S' AND r.StatusCode = 'A' AND rl.StatusCode = 'A'
  `
}

async function upsertBatch(batch) {
  try {
    // La conciliacion se ejecuta dentro de Postgres en una sola transaccion.
    // Evita un DELETE con cientos de claves seguido de un POST por cada lote,
    // conserva la deduplicacion por movement_key y reduce drasticamente logs.
    const { error } = await supabase.rpc('sync_erp_movements_batch', { p_rows: batch })
    if (error) throw error
  } catch (error) {
    const code = error?.code || ''
    const message = error?.message || ''
    if (batch.length > 25 && (code === '57014' || message.includes('timeout'))) {
      const middle = Math.ceil(batch.length / 2)
      await upsertBatch(batch.slice(0, middle))
      await upsertBatch(batch.slice(middle))
      return
    }
    throw error
  }
}

async function upsertRows(rows) {
  let synced = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await upsertBatch(batch)
    synced += batch.length
    process.stdout.write(`\rMovimientos subidos: ${synced}/${rows.length}`)
  }
  if (rows.length) process.stdout.write('\n')
}

async function main() {
  const args = parseArgs(process.argv)
  const now = new Date()
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000)
  const todayIso = localDate.toISOString().slice(0, 10)
  const yesterdayIso = addDays(todayIso, -1)
  let start
  let end
  const requestedRecent = args.recent === true || args.recent === 'true'
  const requestedReconcile = args.reconcile === true || args.reconcile === 'true'
  const periodicReconcile = requestedRecent && periodicReconciliationDue()

  if (requestedReconcile || periodicReconcile) {
    // La conciliacion amplia se ejecuta periodicamente, no cada cinco minutos.
    start = addDays(todayIso, -(RECONCILE_LOOKBACK_DAYS - 1))
    end = todayIso
  } else if (requestedRecent) {
    // La ventana caliente mantiene el dia operativo actualizado. Las
    // transferencias aún en tránsito se incluyen sin límite de antigüedad
    // dentro de la consulta, así no se pierde un documento abierto antiguo.
    start = addDays(todayIso, -(HOT_LOOKBACK_DAYS - 1))
    end = todayIso
  } else if (args.yesterday === true || args.yesterday === 'true') {
    start = yesterdayIso
    end = yesterdayIso
  } else {
    start = assertDate(args.start, '--start')
    end = assertDate(args.end, '--end')
  }
  const shouldRecalculate = args.recalculate !== false && args.recalculate !== 'false'
  const endExclusive = addDays(end, 1)
  let pool

  console.log(`Cargando movimientos centralizados: ${start} a ${end}`)
  try {
    pool = await new sql.ConnectionPool(sqlConfig).connect()
    const result = await pool.request()
      .input('startDate', sql.Date, start)
      .input('endExclusive', sql.Date, endExclusive)
      .query(movementQuery(await resolveReceiptBalanceExpression(pool)))

    const now = new Date().toISOString()
    const rows = makeUniqueMovementKeys(result.recordset
      .map(row => {
        const quantity = numberValue(row.quantity)
        const cost = row.cost === null || row.cost === undefined ? null : numberValue(row.cost)
        return {
          movement_key: clean(row.movement_key),
          source_type: clean(row.source_type),
          source_id: clean(row.source_id) || null,
          store_code: clean(row.store_code),
          // Todas las fechas datetime de RMS son hora local de Perú. mssql
          // las entrega como UTC, por lo que se reconstruye la zona en todos
          // los tipos para no desplazar compras, ventas ni transferencias.
          movement_date: rmsPeruDateToIso(row.movement_date),
          operation: clean(row.operation),
          document_no: clean(row.document_no) || null,
          product_code: clean(row.product_code),
          description: clean(row.description) || null,
          unit: clean(row.unit) || null,
          cost,
          quantity,
          value_total: cost === null ? null : numberValue(cost * quantity),
          reason: clean(row.reason) || null,
          balance_after: row.balance_after === null || row.balance_after === undefined ? null : numberValue(row.balance_after),
          adjustment_user: clean(row.adjustment_user) || null,
          movement_employee: clean(row.movement_employee) || clean(row.adjustment_user) || null,
          reception_employee: clean(row.reception_employee) || null,
          transfer_store_code: clean(row.transfer_store_code) || null,
          status: clean(row.status) || null,
          updated_at: now
        }
      })
      .filter(row => row.store_code && row.product_code))

    console.log('Filas ERP leidas:', rows.length)
    await upsertRows(rows)

    // Ajustes Provisionales consulta un read model pequeno para que la pantalla
    // y el Excel no compitan con las escrituras masivas de erp_movements. El
    // watchdog ejecuta este script, por lo que el cache se actualiza en el
    // mismo ciclo sin depender del navegador ni de tareas duplicadas.
    const { data: provisionalRows, error: provisionalRefreshError } = await supabase
      .rpc('refresh_erp_provisional_adjustments_cache')
    if (provisionalRefreshError) throw provisionalRefreshError
    console.log('Ajustes provisionales actualizados:', provisionalRows)

    const syncedAt = new Date().toISOString()
    const { error: syncStatusError } = await supabase
      .from('erp_sync_status')
      .upsert({
        id: 'erp_movements',
        source_path: __filename,
        synced_at: syncedAt,
        updated_at: syncedAt
      }, { onConflict: 'id' })
    if (syncStatusError) throw syncStatusError

    if (shouldRecalculate) {
      const { data, error } = await supabase.rpc('refresh_product_rotations', { p_as_of: end })
      if (error) throw error
      console.log('Rotaciones recalculadas:', JSON.stringify(data))
    } else {
      console.log('Recalculo omitido por parametro --recalculate false')
    }
    if (requestedReconcile || periodicReconcile) markPeriodicReconciliation()
  } finally {
    if (pool) await pool.close()
  }
}

main().catch(error => {
  console.error('Error cargando rotaciones:', error)
  process.exit(1)
})
