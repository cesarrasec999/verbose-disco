const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mapBounded,cachedRead}=require('../src/lib/boundedReads.ts');
const {createBonusStoreResolver,bonusSqlMapping}=require('../src/features/bono/storeMapping.ts');
test('bounded readers preserve order and cap concurrent work',async()=>{
 let active=0,max=0;
 const result=await mapBounded(Array.from({length:50},(_,i)=>i),async i=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,i%3));active--;return i*2},3);
 assert.equal(max,3);assert.deepEqual(result,Array.from({length:50},(_,i)=>i*2));
});
test('cache coalesces overlapping requests and retries after errors',async()=>{
 let reads=0;const load=async()=>{reads++;await new Promise(r=>setTimeout(r,5));return 42};
 const values=await Promise.all(Array.from({length:25},()=>cachedRead('test:session1',load)));
 assert.equal(reads,1);assert.ok(values.every(x=>x===42));
 await cachedRead('test:session1',load,1000,true);assert.equal(reads,2);
 await assert.rejects(cachedRead('test:bad',async()=>{throw Error('offline')}));
 assert.equal(await cachedRead('test:bad',async()=>7),7);
});
test('RMS codes use the directory, not the GPC prefix',()=>{
 const stores=[{id:'a',code:'19',name:'GPC025 APU - ABANCAY'},{id:'b',code:'25',name:'GPC026 ICA - ICA'},{id:'c',code:'4',name:'GPC002 LIM - SUMINISTRO'}];
 const resolve=createBonusStoreResolver(stores);
 assert.equal(resolve('1019').id,'a');assert.equal(resolve('1025').id,'b');assert.equal(resolve('1004').id,'c');
 assert.equal(resolve('GPC026 ICA - ICA').id,'b');assert.equal(resolve('ABANCAY').id,'a');
 assert.ok(bonusSqlMapping(stores)[0].keys.includes('GPC025 APU - ABANCAY'));
 assert.equal(resolve('desconocido'),undefined);
});
test('ambiguous store aliases fail rather than attributing sales to a guess',()=>{
 assert.throws(()=>createBonusStoreResolver([{id:'a',name:'GPC001 - CENTRO'},{id:'b',name:'GPC002 - CENTRO'}]),/ambiguo/);
});
