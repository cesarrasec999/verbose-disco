/* Elimina exclusivamente las OC replicadas anteriores al corte operativo.
 * Requiere --apply. No toca firmas, aprobadores ni otros modulos.
 */
const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnv(path.join(__dirname, '..', '..', '.env.local'))

const cutoff = process.env.PURCHASE_ORDERS_MIN_DATE || '2026-10-03'
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('Corte invalido; use YYYY-MM-DD')
const cutoffIso = `${cutoff}T00:00:00-05:00`
const apply = process.argv.includes('--apply')
const batchSize = 250
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY,
)

async function exactCount(table, configure = query => query) {
  const result = await configure(supabase.from(table).select('*', { count: 'exact', head: true }))
  if (result.error) throw result.error
  return result.count || 0
}

async function main() {
  const before = {
    oldOrders: await exactCount('erp_purchase_orders', query => query.lt('po_date', cutoffIso)),
    keptOrders: await exactCount('erp_purchase_orders', query => query.gte('po_date', cutoffIso)),
    lines: await exactCount('erp_purchase_order_lines'),
    signatures: await exactCount('purchase_order_approval_signatures'),
    documents: await exactCount('purchase_order_pdf_documents'),
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', cutoff, before }))
  if (!apply) return

  const oldRoutes = await supabase
    .from('purchase_order_approval_routes')
    .select('id,erp_purchase_orders!inner(po_date)', { count: 'exact', head: true })
    .lt('erp_purchase_orders.po_date', cutoffIso)
  if (oldRoutes.error) throw oldRoutes.error
  if ((oldRoutes.count || 0) > 0) {
    throw new Error(`Limpieza detenida: existen ${oldRoutes.count} rutas antiguas que requieren revision`)
  }

  let deleted = 0
  while (true) {
    const page = await supabase
      .from('erp_purchase_orders')
      .select('erp_po_id')
      .lt('po_date', cutoffIso)
      .order('erp_po_id')
      .limit(batchSize)
    if (page.error) throw page.error
    const ids = (page.data || []).map(row => row.erp_po_id)
    if (!ids.length) break
    const removal = await supabase
      .from('erp_purchase_orders')
      .delete()
      .lt('po_date', cutoffIso)
      .in('erp_po_id', ids)
    if (removal.error) throw removal.error
    deleted += ids.length
    console.log(`OC antiguas eliminadas: ${deleted}/${before.oldOrders}`)
  }

  const after = {
    oldOrders: await exactCount('erp_purchase_orders', query => query.lt('po_date', cutoffIso)),
    keptOrders: await exactCount('erp_purchase_orders', query => query.gte('po_date', cutoffIso)),
    lines: await exactCount('erp_purchase_order_lines'),
    signatures: await exactCount('purchase_order_approval_signatures'),
    documents: await exactCount('purchase_order_pdf_documents'),
  }
  if (after.oldOrders !== 0) throw new Error(`Persisten ${after.oldOrders} OC anteriores al corte`)
  if (after.keptOrders !== before.keptOrders) throw new Error('Cambio inesperado en las OC que debian conservarse')
  if (after.signatures !== before.signatures) throw new Error('Cambio inesperado en las firmas digitales')
  console.log(JSON.stringify({ cutoff, deleted, after }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

