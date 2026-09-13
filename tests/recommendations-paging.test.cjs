const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sql = fs.readFileSync('supabase/migrations/20260913130000_audit_recommendations_paged.sql', 'utf8');
const audit = fs.readFileSync('src/features/auditoria/AuditoriaModule.tsx', 'utf8');
const cyclic = fs.readFileSync('src/features/conteos-ciclicos/CiclicosShell.tsx', 'utf8');

test('audit recommendations are sourced server-side, indexed and paged in batches of 50', () => {
  assert.match(sql, /idx_erp_movements_recommendation_store_type_status_date_product/i);
  assert.match(sql, /idx_erp_sales_daily_recommendation_store_date_product/i);
  assert.match(sql, /get_audit_assignment_recommendations_page/i);
  assert.match(sql, /RECEIPT_RETURN/i);
  assert.match(sql, /RECEIPT_SALE/i);
  assert.match(sql, /limit least\(greatest\(coalesce\(p_limit, 51\), 1\), 101\)/i);
  assert.match(sql, /offset greatest\(coalesce\(p_offset, 0\), 0\)/i);
  assert.match(audit, /get_audit_assignment_recommendations_page/);
  assert.match(audit, /p_limit: 51/);
  assert.match(audit, /p_offset: page \* 50/);
  assert.match(audit, /Recomendar 50 retornos/);
  assert.match(audit, /ReadPagination/);
});

test('cyclic sales recommendations no longer load hundreds of rows or client-side history', () => {
  assert.match(sql, /get_cyclic_sales_assignment_recommendations_page/i);
  assert.match(cyclic, /get_cyclic_sales_assignment_recommendations_page/);
  assert.match(cyclic, /p_offset: page \* 50/);
  assert.match(cyclic, /rawRows\.slice\(0, 50\)/);
  assert.match(cyclic, /Recomendar 50 más vendidos/);
  assert.doesNotMatch(cyclic, /p_limit: 200/);
});
