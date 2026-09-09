const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadInventoryModule } = require('./inventory-rotation-loader.cjs');
const { fetchProductRotationsForSession } = loadInventoryModule('api');
const session = { store_id:'abancay',store_name:'GPC025 APU - ABANCAY',scheduled_date:'2026-09-04' };
const row = (key, month, code, category) => ({store_key:key,period_month:month,product_code:code,rotation_category:category});
function fakeClient(source) {
  const calls = [];
  return { calls, from(table) {
    assert.equal(table, 'product_rotation_monthly');
    let rows = [...source]; const call = { keys:[],skus:[] }; calls.push(call);
    const query = {
      select() { return this; },
      in(field, values) {
        if (field === 'store_key') call.keys = values;
        if (field === 'product_code') call.skus = values;
        rows = rows.filter(r => values.includes(r[field])); return this;
      },
      lt(field, value) { rows = rows.filter(r => r[field]<value); return this; },
      eq(field, value) { rows = rows.filter(r => r[field]===value); return this; },
      order(field, {ascending}) { rows.sort((a,b)=>String(a[field]).localeCompare(String(b[field]))*(ascending?1:-1)); return this; },
      limit(n) { rows=rows.slice(0,n); return this; },
      then(resolve,reject) { return Promise.resolve({data:rows.slice(0,1000),error:null}).then(resolve,reject); },
    };
    return query;
  }};
}

test('Abancay: chooses August full store name, not the old H/Nuevo alias from May', async()=>{
  const client=fakeClient([
    row('ABANCAY','2026-05-01','AU1','H'),row('ABANCAY','2026-05-01','AU2','Nuevo'),
    row(session.store_name,'2026-08-01','AU1','A'),row(session.store_name,'2026-08-01','AU2','D'),
    row(session.store_name,'2026-09-01','AU1','B'), // Current month is excluded.
  ]);
  const result=await fetchProductRotationsForSession(client,{session,stores:[],skus:['AU1','AU2']});
  assert.deepEqual([...result],[['AU1','A'],['AU2','D']]);
  assert(client.calls[0].keys.includes(session.store_name));
  assert(client.calls[0].keys.includes('ABANCAY'));
});
test('ERP sede on the session works even without a loaded store directory',async()=>{
  const client=fakeClient([row(session.store_name,'2026-08-01','AU1','B')]);
  const result=await fetchProductRotationsForSession(client,{session:{...session,store_name:undefined,store_erp_sede:session.store_name},stores:[],skus:['AU1']});
  assert.equal(result.get('AU1'),'B');
});
test('existing short aliases for historical inventories still work',async()=>{
  const client=fakeClient([row('ABANCAY','2026-05-01','AU1','D')]);
  const result=await fetchProductRotationsForSession(client,{session:{...session,scheduled_date:'2026-06-04'},stores:[],skus:['AU1']});
  assert.equal(result.get('AU1'),'D');
});
test('does not borrow a classification from a different store or older month for missing SKU',async()=>{
  const client=fakeClient([row(session.store_name,'2026-08-01','AU1','B'),row('ABANCAY','2026-05-01','AU2','H'),row('GPC026 ICA - ICA','2026-08-01','AU2','A')]);
  const result=await fetchProductRotationsForSession(client,{session,stores:[],skus:['AU1','AU2']});
  assert.equal(result.get('AU1'),'B'); assert.equal(result.has('AU2'),false);
});
test('2,323 SKUs are read in bounded batches without losing classifications',async()=>{
  const rows=Array.from({length:2323},(_,i)=>row(session.store_name,'2026-08-01',`AU${String(i).padStart(5,'0')}`,'X'));
  const client=fakeClient(rows);
  const result=await fetchProductRotationsForSession(client,{session,stores:[],skus:rows.map(r=>r.product_code)});
  assert.equal(result.size,2323);
  assert.equal(client.calls.length,6);
  assert(client.calls.slice(1).every(call=>call.skus.length<=500));
});
test('no invented rotation when no preceding period exists',async()=>{
  const result=await fetchProductRotationsForSession(fakeClient([]),{session,stores:[],skus:['AU1']});
  assert.equal(result.size,0);
});
