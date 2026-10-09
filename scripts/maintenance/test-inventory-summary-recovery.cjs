const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const source = fs.readFileSync('src/features/inventarios/api.ts', 'utf8')
const parsed = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fetchSummaryRowsFromRpc')
const js = ts.transpileModule(fn.getText(parsed), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const context = { exports: {}, normalizeCode: value => String(value).trim() }
vm.createContext(context)
vm.runInContext(js, context)
const load = context.exports.fetchSummaryRowsFromRpc
const params = { sessionId: 'session-a', stores: [], session: null, loadRotations: async () => new Map([['SKU1', 'A']]) }
const mock = result => ({ rpc: () => ({ range: async () => result }) })
;(async () => {
  for (const code of ['57014', '25P02']) {
    const error = { code, message: 'Error in get_general_inventory_summary' }
    await assert.rejects(load(mock({ error }), params), received => received === error)
  }
  assert.equal(await load(mock({ error: { code: 'PGRST202', message: 'missing function' } }), params), null)
  let calls = 0
  let rotationCalls = 0
  const rows = await load({ rpc: (_name, args) => {
    assert.equal(args.p_session_id, 'session-a')
    return { range: async (from, to) => {
      calls++
      assert.equal(from, (calls - 1) * 1000)
      assert.equal(to, from + 999)
      return { data: Array.from({ length: calls === 1 ? 1000 : 1 }, (_, i) => ({ product_id: String(from + i), sku: 'SKU1', system_stock: 5, counted: 3, cost: 2 })), error: null }
    } }
  } }, { ...params, loadRotations: async skus => { rotationCalls++; assert.equal(skus.length, 1001); return new Map([['SKU1', 'A']]) } })
  assert.equal(rows.length, 1001)
  assert.equal(rows[0].valueDiff, -4)
  assert.equal(rows[0].rotation_category, 'A')
  assert.equal(rotationCalls, 1)
  console.log('PASS: timeout propagation, missing RPC, complete pagination, session scope, cached rotation loader')
})().catch(error => { console.error(error); process.exitCode = 1 })
