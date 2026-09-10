const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sql = fs.readFileSync('supabase/migrations/20260910113000_sync_general_inventory_locations.sql', 'utf8');

test('general inventory location synchronization is additive and source-of-truth based', () => {
  assert.match(sql, /after insert or update of session_id, product_id, location_code, sku, quantity/i);
  assert.match(sql, /on conflict \(store_id, product_id, location\) do update/i);
  assert.match(sql, /coalesce\(sum\(c\.quantity\), 0\)/i);
  assert.match(sql, /general_inventory_registered = true/i);
  assert.match(sql, /status <> 'cancelled'/i);
  assert.match(sql, /not in \('SIN_FISICO', '__SESSION_FLAG__'\)/i);
  assert.doesNotMatch(sql, /delete from public\.product_locations/i);
  assert.doesNotMatch(sql, /set is_active = false/i);
});

test('backfill selects one latest counted session per store instead of all historic sessions', () => {
  assert.match(sql, /sync_general_inventory_locations_for_store/i);
  assert.match(sql, /where gis\.store_id = p_store_id/i);
  assert.match(sql, /order by gis\.scheduled_date desc nulls last, gis\.created_at desc/i);
  assert.match(sql, /from locations_to_sync/i);
});
