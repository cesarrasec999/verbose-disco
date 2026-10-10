const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('../tmp/picking-validation/node_modules/@electric-sql/pglite');

test('inventory item replacement is atomic, retryable and isolated by item', async () => {
  const db = new PGlite();
  const session = '00000000-0000-0000-0000-000000000001';
  const otherSession = '00000000-0000-0000-0000-000000000002';
  const product = '00000000-0000-0000-0000-000000000003';
  const operator = '00000000-0000-0000-0000-000000000004';
  const location = '00000000-0000-0000-0000-000000000005';
  const wrongLocation = '00000000-0000-0000-0000-000000000006';
  const item = '00000000-0000-0000-0000-000000000007';
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create table general_inventory_sessions(id uuid primary key,status text);
      create table general_inventory_locations(id uuid primary key,session_id uuid);
      create table general_inventory_recount_items(id uuid primary key,session_id uuid,product_id uuid,assigned_operator_id uuid,status text,updated_at timestamptz);
      create table general_inventory_validation_items(id uuid primary key,session_id uuid,product_id uuid,assigned_operator_id uuid,status text,updated_at timestamptz);
      create table general_inventory_recount_counts(
        id uuid primary key default gen_random_uuid(),recount_item_id uuid,session_id uuid,operator_id uuid,
        location_id uuid,location_code text,product_id uuid,sku text,description text,unit text,
        quantity numeric not null,cost_snapshot numeric not null default 0,counted_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),client_uuid text,client_device_id text,sync_origin text);
      create table general_inventory_validation_counts(
        id uuid primary key default gen_random_uuid(),validation_item_id uuid,session_id uuid,operator_id uuid,
        location_id uuid,location_code text,product_id uuid,sku text,description text,unit text,
        quantity numeric not null,cost_snapshot numeric not null default 0,counted_at timestamptz not null default now(),
        updated_at timestamptz not null default now());
    `);
    await db.exec(fs.readFileSync('supabase/migrations/20261010100000_atomic_inventory_item_counts.sql', 'utf8'));
    await db.query('insert into general_inventory_sessions values ($1,$2),($3,$2)', [session, 'open', otherSession]);
    await db.query('insert into general_inventory_locations values ($1,$2),($3,$4)', [location, session, wrongLocation, otherSession]);
    await db.query('insert into general_inventory_recount_items values ($1,$2,$3,$4,$5,now())', [item, session, product, operator, 'assigned']);
    await db.query('insert into general_inventory_recount_counts(recount_item_id,session_id,operator_id,location_id,product_id,quantity) values($1,$2,$3,$4,$5,9)', [item, session, operator, location, product]);

    const line = (itemId, loc, qty, uuid) => ({
      recount_item_id: itemId, validation_item_id: itemId, session_id: session, operator_id: operator,
      location_id: loc, location_code: 'A1', product_id: product, sku: 'TEST', description: 'Test',
      unit: 'UND', quantity: qty, cost_snapshot: 1, client_uuid: uuid,
      client_device_id: 'device-test', sync_origin: 'test'
    });
    const replace = async (layer, itemId, operationId, rows) =>
      (await db.query('select replace_general_inventory_item_counts($1,$2,$3,$4::jsonb) as result',
        [layer, itemId, operationId, JSON.stringify(rows)])).rows[0].result;
    const countRows = async (table, column, itemId) =>
      (await db.query(`select quantity::float as quantity from ${table} where ${column}=$1 order by quantity`, [itemId])).rows;

    await assert.rejects(replace('recount', item, 'bad-location', [line(item, wrongLocation, 2, 'bad')]));
    assert.deepEqual(await countRows('general_inventory_recount_counts', 'recount_item_id', item), [{ quantity: 9 }]);
    assert.equal((await db.query('select count(*)::int as n from general_inventory_item_count_receipts')).rows[0].n, 0);

    const firstRows = [line(item, location, 2, 'r-1'), line(item, location, 3, 'r-2')];
    assert.equal(await replace('recount', item, 'operation-1', firstRows), 'applied');
    assert.deepEqual(await countRows('general_inventory_recount_counts', 'recount_item_id', item), [{ quantity: 2 }, { quantity: 3 }]);
    assert.equal(await replace('recount', item, 'operation-1', firstRows), 'already_applied');
    await assert.rejects(replace('recount', item, 'operation-1', [line(item, location, 99, 'r-1')]));
    assert.equal(await replace('recount', item, 'operation-2', [line(item, location, 4, 'r-3')]), 'applied');
    assert.equal(await replace('recount', item, 'operation-1', firstRows), 'already_applied');
    assert.deepEqual(await countRows('general_inventory_recount_counts', 'recount_item_id', item), [{ quantity: 4 }]);

    const validationItem = '00000000-0000-0000-0000-000000000008';
    await db.query('insert into general_inventory_validation_items values ($1,$2,$3,$4,$5,now())', [validationItem, session, product, operator, 'assigned']);
    assert.equal(await replace('validation', validationItem, 'validation-1', [line(validationItem, location, 6, 'v-1')]), 'applied');
    assert.deepEqual(await countRows('general_inventory_validation_counts', 'validation_item_id', validationItem), [{ quantity: 6 }]);
    assert.equal(await replace('validation', validationItem, 'validation-1', [line(validationItem, location, 6, 'v-1')]), 'already_applied');

    const ids = Array.from({ length: 200 }, (_, n) => `10000000-0000-0000-0000-${String(n + 1).padStart(12, '0')}`);
    for (const id of ids) await db.query('insert into general_inventory_recount_items values($1,$2,$3,$4,$5,now())', [id, session, product, operator, 'assigned']);
    const results = await Promise.all(ids.map((id, n) => replace('recount', id, `concurrent-${n}`, [line(id, location, n + 1, `c-${n}`)])));
    assert.equal(results.filter(value => value === 'applied').length, 200);
    assert.equal((await db.query('select count(*)::int as n from general_inventory_recount_counts where recount_item_id=any($1::uuid[])', [ids])).rows[0].n, 200);
  } finally {
    await db.close();
  }
});
