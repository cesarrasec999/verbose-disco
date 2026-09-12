const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickingPage, PickingSubmission, isPickingTransactionRejected } = require('../src/lib/picking/transport.ts');

test('50 visible rows and lookahead cursor never consumes row 51', () => {
  const rows = Array.from({length:51},(_,i)=>({id:String(i),created_at:'2026-09-08T12:00:00Z'}));
  const page = pickingPage(rows, row=>row);
  assert.equal(page.items.length,50); assert.equal(page.next.id,'49'); assert.equal(page.hasNext,true);
  assert.equal(pickingPage(rows.slice(0,50),row=>row).hasNext,false);
  assert.equal(pickingPage([],row=>row).next,null);
});
test('double tap and uncertain retry share one operation, legitimate second scan gets another', () => {
  let count=0;
  const submit=new PickingSubmission(()=>`operation-${++count}`);
  const payload={assignment:'A',rows:[{location:'L1',qty:2}]};
  const id=submit.begin(payload);
  assert.throws(()=>submit.begin(payload),/proceso/);
  submit.uncertain();
  assert.throws(()=>submit.begin({...payload,assignment:'B'}),/anterior/);
  assert.equal(submit.begin(payload),id);
  submit.confirmed();
  assert.notEqual(submit.begin(payload),id);
});
test('a database rejection allows correction; network timeout never discards retry identity', () => {
  assert.equal(isPickingTransactionRejected({code:'P0001'}),true);
  assert.equal(isPickingTransactionRejected({code:'57014'}),true);
  assert.equal(isPickingTransactionRejected({message:'fetch failed'}),false);
  assert.equal(isPickingTransactionRejected({code:'504'}),false);
});

test('50-user load harness refuses production and requires explicit staging acknowledgment', () => {
  const {validateTarget,quantile}=require('../scripts/picking-load-test.cjs');
  assert.throws(()=>validateTarget('https://ejrttyzvvhaumdocxpei.supabase.co','ISOLATED_PICKING_STAGING'),/prohibida/);
  assert.throws(()=>validateTarget('https://isolated.supabase.co',''),/prohibida/);
  assert.equal(validateTarget('http://127.0.0.1:54321','ISOLATED_PICKING_STAGING'),'http://127.0.0.1:54321');
  assert.equal(quantile([4,1,2,3],.95),4);
});
