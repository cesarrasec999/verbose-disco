// Staging-only end-to-end RPC load harness. Creates no fixtures and never targets
// production. Provide 50 isolated actors/assignments with enough remaining qty.
// Sample fixtures JSON: [{pickerId, assignmentId, requestId, product, date}]
// Credentials come from process environment and are never printed.
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');

function validateTarget(raw,ack) {
  const url=new URL(raw);
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (ack!=='ISOLATED_PICKING_STAGING' || url.hostname==='ejrttyzvvhaumdocxpei.supabase.co'
    || !['http:','https:'].includes(url.protocol) || (!local && !url.hostname.endsWith('.supabase.co'))
    || url.username || url.password || url.pathname!=='/' || url.search || url.hash) {
    throw Error('Solo se permite un Supabase de pruebas aislado; produccion esta prohibida.');
  }
  return url.origin;
}
const quantile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;

async function main() {
  const origin=validateTarget(process.env.PICKING_STAGING_URL,process.env.PICKING_STAGING_ACK);
  const key=process.env.PICKING_STAGING_KEY;
  if(!key)throw Error('Falta clave exclusiva de staging.');
  const fixtures=JSON.parse(fs.readFileSync(process.env.PICKING_LOAD_FIXTURES_JSON,'utf8'));
  if(fixtures.length<50 || new Set(fixtures.map(f=>f.pickerId)).size<50
    || fixtures.some(f=>!f.assignmentId||!f.product||!f.requestId||!f.date))throw Error('Se requieren 50 actores de prueba y asignaciones separadas.');
  const samples={read:[],write:[],technicalErrors:0,businessConflicts:0,completed:0};
  async function rpc(name,args,kind) {
    const started=performance.now();
    try {
      const response=await fetch(`${origin}/rest/v1/rpc/${name}`,{method:'POST',
        headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
        body:JSON.stringify(args),signal:AbortSignal.timeout(15000)});
      const body=await response.json();
      samples[kind].push(performance.now()-started);
      if(!response.ok) {
        if(body.code==='P0001')samples.businessConflicts++;
        else samples.technicalErrors++;
      } else samples.completed++;
    } catch {samples.technicalErrors++;samples[kind].push(performance.now()-started);}
  }
  const report=users=>({users,requests:samples.read.length+samples.write.length,
    readP95ms:quantile(samples.read,.95),writeP95ms:quantile(samples.write,.95),
    technicalErrors:samples.technicalErrors,businessConflicts:samples.businessConflicts,completed:samples.completed});
  // Ramp stages followed by a 30-minute hold at 50 users. Each user has one
  // in-flight request; UI think time and write cadence are explicit, not 50x N
  // unrestricted Promise.all calls against the database.
  for(const [users,seconds] of [[5,60],[15,60],[30,60],[50,1800]]) {
    const end=Date.now()+seconds*1000;
    const reporter=setInterval(()=>console.log(JSON.stringify(report(users))),60000);
    await Promise.all(fixtures.slice(0,users).map(async(f,index)=>{
      await pause(index*20);let cycle=0;
      while(Date.now()<end) {
        await rpc('get_picking_tasks_page_v2',{p_picker_id:f.pickerId,p_date:f.date,
          p_request_id:f.requestId,p_limit:51},'read');
        if(++cycle%3===0)await rpc('save_picking_scan_v2',{
          p_operation_id:`load-${randomUUID()}`,p_actor_id:f.pickerId,p_assignment_id:f.assignmentId,
          p_product:f.product,p_rows:[{location:'TEST-ONLY',qty:1}]},'write');
        await pause(3000+Math.random()*4000);
      }
    }));
    clearInterval(reporter);console.log(JSON.stringify(report(users)));
  }
  console.log('Falta conciliar IDs, recibos y totales en staging y revisar CPU/bloqueos; latencia sola no certifica capacidad.');
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={validateTarget,quantile};
