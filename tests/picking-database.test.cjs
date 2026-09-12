// Isolated PostgreSQL (PGlite). NO production credentials or production writes.
// npm install --prefix tmp/picking-validation --no-package-lock @electric-sql/pglite
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('../tmp/picking-validation/node_modules/@electric-sql/pglite');

test('Picking SQL: atomicity, retries, permissions, totals and cursor completeness',async t=>{
  const db=new PGlite();
  const actor='00000000-0000-0000-0000-000000000001';
  const picker='00000000-0000-0000-0000-000000000002';
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table cyclic_users(id uuid primary key,full_name text,role text,is_active bool);
    create table cyclic_products(id uuid,sku text,erp_sku text,is_active bool);
    create table codigos_barra(codsap text,upc text,alu text);
    create table erp_sync_status(id text primary key,source_path text,synced_at timestamptz,updated_at timestamptz);
    insert into cyclic_users values('${actor}','Validador prueba','Validador',true),('${picker}','Picador prueba','Operario',true);`);
  await db.exec(fs.readFileSync('supabase_picking.sql','utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/20260908210000_picking_v2_foundation.sql','utf8'));
  await db.exec(fs.readFileSync('scripts/sql/picking-v2-indexes.sql','utf8').replaceAll('concurrently',''));
  const request=(await db.query(`insert into picking_requests(erp_inv_request_id,source_store_code,destination_store_code)
    values('TEST','0','1') returning id`)).rows[0].id;
  await db.query(`insert into picking_request_lines(id,request_id,erp_inv_request_id,line_id,product_code,qty_requested)
    select 'L'||n,$1,'TEST',n,'AU'||n,1000 from generate_series(1,160) n`,[request]);
  const assign=async(id,ids,user=actor)=> (await db.query('select assign_picking_lines_v2($1,$2,$3,$4,$5) as result',
    [id,user,picker,'2026-09-08',ids])).rows[0].result;
  const scan=async(id,assignment,qty,product='AU1',user=picker)=> (await db.query('select save_picking_scan_v2($1,$2,$3,$4,$5) as result',
    [id,user,assignment,product,JSON.stringify([{location:'RACK-1',qty}])])).rows[0].result;
  let assignment;
  await t.test('assignment retries do not reserve twice, new operation only reserves remaining',async()=>{
    const first=await assign('assignment-operation-1',['L1']); assignment=first[0].id;
    assert.deepEqual(await assign('assignment-operation-1',['L1']),first);
    assert.deepEqual(await assign('assignment-operation-2',['L1']),[]);
    assert.equal((await db.query('select count(*)::int as n from picking_assignments')).rows[0].n,1);
    await assert.rejects(assign('assignment-operation-1',['L2']),/otro envio/);
    await assert.rejects(assign('assignment-no-role-1',['L2'],picker),/habilitado/);
  });
  await t.test('retry returns original saved scan; repeated legitimate scan stays unique',async()=>{
    const first=await scan('scan-operation-first',assignment,2);
    assert.deepEqual(await scan('scan-operation-first',assignment,2),first);
    const second=await scan('scan-operation-second',assignment,2);
    assert.equal(Number(second.pickedQty),4);
    assert.notEqual(first.insertedScans[0].id,second.insertedScans[0].id);
    await assert.rejects(scan('scan-operation-first',assignment,3),/otro envio/);
    await assert.rejects(scan('scan-wrong-code-01',assignment,2,'WRONG'),/no coincide/);
    await assert.rejects(scan('scan-wrong-user-01',assignment,2,'AU1',actor),/no esta asignado/);
    await assert.rejects(scan('scan-too-many-0001',assignment,1000),/superior/);
    await assert.rejects(scan('scan-invalid-00001',assignment,-1),/positiva/);
    await assert.rejects(scan('scan-precision-001',assignment,0.0000001),/positiva/);
    assert.equal((await db.query('select count(*)::int as n from picking_scans')).rows[0].n,2);
  });
  await t.test('failure after scan insertion rolls back scans, progress and receipt together',async()=>{
    await db.exec(`create function test_fail_progress() returns trigger language plpgsql as $$ begin
      if new.picked_qty=13 then raise exception 'simulated progress failure'; end if; return new; end $$;
      create trigger test_fail before update on picking_assignments for each row execute function test_fail_progress();`);
    await assert.rejects(scan('scan-progress-fail-1',assignment,9),/simulated/);
    assert.equal((await db.query('select count(*)::int as n from picking_scans')).rows[0].n,2);
    assert.equal(Number((await db.query('select picked_qty from picking_assignments where id=$1',[assignment])).rows[0].picked_qty),4);
    assert.equal((await db.query('select count(*)::int as n from picking_write_receipts where operation_id=$1',['scan-progress-fail-1'])).rows[0].n,0);
  });
  await t.test('cursor visits all 160 assignments even with identical timestamps',async()=>{
    await assign('assignment-large-01',Array.from({length:99},(_,i)=>`L${i+2}`));
    await assign('assignment-large-02',Array.from({length:60},(_,i)=>`L${i+101}`));
    await db.exec("update picking_assignments set created_at='2026-09-08T12:00:00Z'");
    const ids=[];let cursor=null;
    do {
      const {rows}=await db.query('select * from get_picking_tasks_page_v2($1,$2,$3,$4,$5,51)',
        [picker,'2026-09-08',request,cursor?.created_at||null,cursor?.id||null]);
      const page=rows.slice(0,50); ids.push(...page.map(r=>r.assignment.id));
      cursor=rows.length>50?page.at(-1).assignment:null;
    } while(cursor);
    assert.equal(ids.length,160);assert.equal(new Set(ids).size,160);
    const totals=(await db.query('select * from get_picking_task_totals_v2($1,$2,$3)',[picker,'2026-09-08',request])).rows[0];
    assert.equal(Number(totals.codes),160);assert.equal(Number(totals.picked_qty),4);
    assert.equal((await db.query('select * from get_picking_tasks_page_v2($1,$2,$3,null,null,99999)',[picker,'2026-09-08',request])).rows.length,51);
  });
  await t.test('pre-existing discrepancy is reported and never silently rewritten',async()=>{
    await db.query('update picking_assignments set picked_qty=5 where id=$1',[assignment]);
    await assert.rejects(scan('scan-discrepancy-01',assignment,1),/no coinciden/);
    assert.equal(Number((await db.query('select picked_qty from picking_assignments where id=$1',[assignment])).rows[0].picked_qty),5);
    assert.equal((await db.query('select count(*)::int as n from picking_scans')).rows[0].n,2);
  });
  await t.test('request totals are complete while line details stay bounded',async()=>{
    const queue=(await db.query('select * from get_picking_requests_page_v2($1,$2)', ['2026-09-08',picker])).rows;
    assert.equal(queue.length,1);assert.equal(Number(queue[0].tasks),160);
    const page=(await db.query('select * from get_picking_lines_page_v2($1)',[request])).rows;
    assert.equal(page.length,50);
    const last=(await db.query('select * from get_picking_lines_page_v2($1,null,$2)',[request,'AU160'])).rows;
    assert.equal(last.length,1);assert.equal(last[0].product_code,'AU160');
    const filtered=(await db.query('select * from get_picking_requests_page_v2($1,$2,null,$3)', ['2026-09-08',picker,'OTHER'])).rows;
    assert.equal(filtered.length,0);
  });
  await t.test('production read release leaves all history and progress identical; filters work before limit',async()=>{
    const fingerprint=async()=>(await db.query(`select jsonb_build_object(
      'scans',(select jsonb_agg(to_jsonb(s) order by id) from picking_scans s),
      'assignments',(select jsonb_agg(to_jsonb(a) order by id) from picking_assignments a),
      'lines',(select jsonb_agg(to_jsonb(l) order by id) from picking_request_lines l)) as snapshot`)).rows[0].snapshot;
    const before=await fingerprint();
    await db.exec(fs.readFileSync('supabase/migrations/20260909100000_picking_registry_read_page.sql','utf8'));
    await db.exec(fs.readFileSync('scripts/sql/picking-registry-indexes.sql','utf8').replaceAll('concurrently',''));
    assert.deepEqual(await fingerprint(),before);
    const all=(await db.query('select * from get_picking_registry_page_v2()')).rows;
    assert.equal(all.length,2);assert.equal(all[0].picker_name,'Picador prueba');
    const tail=(await db.query('select * from get_picking_registry_page_v2(null,null,null,null,null,null,null,$1,$2)',[all[0].scan.created_at,all[0].scan.id])).rows;
    assert.equal(tail.length,1);assert.equal(tail[0].scan.id,all[1].scan.id);
    assert.equal((await db.query('select * from get_picking_registry_page_v2(null,null,null,null,$1)',[actor])).rows.length,0);
    assert.equal((await db.query('select * from get_picking_registry_page_v2(null,null,null,null,$1)',[picker])).rows.length,2);
    assert.equal((await db.query('select * from get_picking_registry_page_v2(null,null,null,null,null,null,$1)',['RACK'])).rows.length,2);
    const options=(await db.query('select get_picking_registry_filters_v2() as options')).rows[0].options;
    assert.equal(options.pickers.length,1);assert.equal(options.sources[0].key,'0');
  });
  await db.close();
});
