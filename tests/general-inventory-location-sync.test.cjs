const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sql = fs.readFileSync('supabase/migrations/20260913110000_general_inventory_locations_only_finished.sql', 'utf8');
const restoreSql = fs.readFileSync('supabase/migrations/20260913113000_restore_open_inventory_location_state.sql', 'utf8');
const blockOpenSql = fs.readFileSync('supabase/migrations/20260913114500_block_open_inventory_location_publish.sql', 'utf8');
const unverifiedSql = fs.readFileSync('supabase/migrations/20260913120500_mark_unverified_inventory_locations.sql', 'utf8');
const inventoryPage = fs.readFileSync('src/app/inventarios/page.tsx', 'utf8');

test('general inventory location synchronization is additive and source-of-truth based', () => {
  assert.match(sql, /on conflict \(store_id, product_id, location\) do update/i);
  assert.match(sql, /coalesce\(sum\(c\.quantity\), 0\)/i);
  assert.match(sql, /general_inventory_registered = true/i);
  assert.match(sql, /status = 'finished'/i);
  assert.match(sql, /finished_at is not null/i);
  assert.match(sql, /not in \('SIN_FISICO', '__SESSION_FLAG__'\)/i);
  assert.doesNotMatch(sql, /delete from public\.product_locations/i);
  assert.doesNotMatch(sql, /set is_active = false/i);
});

test('sync is triggered when a general inventory is finalized or its final date is corrected', () => {
  assert.match(sql, /after update of status on public\.general_inventory_sessions/i);
  assert.match(sql, /new\.status = 'finished' and old\.status is distinct from 'finished'/i);
  assert.match(restoreSql, /after update of status, finished_at on public\.general_inventory_sessions/i);
  assert.match(restoreSql, /old\.finished_at is distinct from new\.finished_at/i);
});

test('backfill selects the latest finished session and repairs only matching historical rows', () => {
  assert.match(sql, /sync_general_inventory_locations_for_store/i);
  assert.match(sql, /where gis\.store_id = p_store_id/i);
  assert.match(sql, /order by gis\.finished_at desc/i);
  assert.match(sql, /from locations_to_sync/i);
  assert.match(sql, /reconcile_general_inventory_location_dates_for_store/i);
  assert.match(sql, /and pl\.last_source = 'inventario general'/i);
});

test('open inventory sessions cannot publish locations and historical state is restored without deletes', () => {
  assert.match(restoreSql, /where gis\.status = 'open'/i);
  assert.match(restoreSql, /product_location_history conserva el estado exacto previo/i);
  assert.match(restoreSql, /perform public\.sync_general_inventory_locations_for_store/i);
  assert.doesNotMatch(restoreSql, /delete from public\.product_locations/i);
  assert.doesNotMatch(inventoryPage, /upsertKnownProductLocation/);
  assert.doesNotMatch(inventoryPage, /replaceKnownInventoryLocations/);
});

test('server blocks old clients from publishing an open session and keeps unverified rows explicit', () => {
  assert.match(blockOpenSql, /where gis\.store_id = new\.store_id/i);
  assert.match(blockOpenSql, /gis\.status = 'open'/i);
  assert.match(blockOpenSql, /if tg_op = 'INSERT' then\s+return null/i);
  assert.match(unverifiedSql, /last_source = 'ubicación sin conteo final'/i);
  assert.match(unverifiedSql, /not exists \(\s*select 1\s*from public\.general_inventory_counts/i);
  assert.doesNotMatch(unverifiedSql, /delete from public\.product_locations/i);
});
