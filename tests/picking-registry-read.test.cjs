// Isolated PostgreSQL; no credentials/network/production data.
// Setup: npm install --prefix tmp/picking-validation --no-package-lock @electric-sql/pglite
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('../tmp/picking-validation/node_modules/@electric-sql/pglite');
test('read release preserves rows and progress, and traverses every filtered record exactly once',async()=>{
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table cyclic_users(id uuid primary key,full_name text);
    create table erp_sync_status(id text primary key,source_path text,synced_at timestamptz,updated_at timestamptz);
    insert into cyclic_users values('00000000-0000-0000-0000-000000000001','Prueba');`);
  await db.exec(fs.readFileSync('supabase_picking.sql','utf8'));
  const request=(await db.query(`insert into picking_requests(erp_inv_request_id,source_store_code,destination_store_code,reason)
    values('T','0','1','ABASTECIMIENTO') returning id`)).rows[0].id;
  await db.query(`insert into picking_request_lines(id,request_id,erp_inv_request_id,line_id,product_code,qty_requested)
    values('L1',$1,'T',1,'AU12345',200)`,[request]);
  const assignment=(await db.query(`insert into picking_assignments(request_id,line_id,picker_id,picker_name,assigned_qty,picked_qty,status)
    values($1,'L1','00000000-0000-0000-0000-000000000001','Prueba',200,123,'en_proceso') returning id`,[request])).rows[0].id;
  await db.query(`insert into picking_scans(assignment_id,request_id,line_id,picker_id,picker_name,location_code,qty,is_match,created_at)
    select $1,$2,'L1','00000000-0000-0000-0000-000000000001','Prueba','RACK-'||n,1,true,'2026-09-08T10:00:00Z'
    from generate_series(1,123) n`,[assignment,request]);
  const snapshot=async()=>(await db.query(`select jsonb_build_object(
    'scans',(select jsonb_agg(to_jsonb(s) order by id) from picking_scans s),
    'assignments',(select jsonb_agg(to_jsonb(a) order by id) from picking_assignments a),
    'lines',(select jsonb_agg(to_jsonb(l) order by id) from picking_request_lines l),
    'requests',(select jsonb_agg(to_jsonb(r) order by id) from picking_requests r)) as snapshot`)).rows[0].snapshot;
  const before=await snapshot();
  await db.exec(fs.readFileSync('supabase/migrations/20260909100000_picking_registry_read_page.sql','utf8'));
  await db.exec(fs.readFileSync('scripts/sql/picking-registry-indexes.sql','utf8').replaceAll('concurrently',''));
  assert.deepEqual(await snapshot(),before);
  const ids=[];let cursor=null;let pages=0;
  do {
    const rows=(await db.query('select * from get_picking_registry_page_v2($1,$1,null,null,null,null,null,$2,$3,51)',
      ['2026-09-08',cursor?.created_at||null,cursor?.id||null])).rows;
    const page=rows.slice(0,50); ids.push(...page.map(r=>r.scan.id));pages++;
    cursor=rows.length>50?page.at(-1).scan:null;
  }while(cursor);
  assert.equal(ids.length,123);assert.equal(new Set(ids).size,123);assert.equal(pages,3);
  assert.equal((await db.query("select * from get_picking_registry_page_v2('2026-09-09','2026-09-09')")).rows.length,0);
  const exact=(await db.query("select * from get_picking_registry_page_v2(null,null,null,null,null,null,'RACK-123')")).rows;
  assert.equal(exact.length,1);assert.equal(exact[0].scan.location_code,'RACK-123');
  const options=(await db.query('select get_picking_registry_filters_v2() as options')).rows[0].options;
  assert.equal(options.pickers[0].label,'Prueba');assert.equal(options.reasons[0].key,'ABASTECIMIENTO');
  assert.deepEqual(await snapshot(),before);
  await db.close();
});
