const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sql = fs.readFileSync('supabase/migrations/20260913130000_audit_recommendations_paged.sql', 'utf8');
const cyclicSql = fs.readFileSync('supabase/migrations/20260913133000_cyclic_recommendations_all_paged.sql', 'utf8');
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

test('cyclic sales recommendations use pages of 30 without client-side history', () => {
  assert.match(sql, /get_cyclic_sales_assignment_recommendations_page/i);
  assert.match(cyclic, /get_cyclic_sales_assignment_recommendations_page/);
  assert.match(cyclic, /const CYCLIC_RECOMMENDATION_PAGE_SIZE = 30/);
  assert.match(cyclic, /p_offset: page \* CYCLIC_RECOMMENDATION_PAGE_SIZE/);
  assert.match(cyclic, /rawRows\.slice\(0, CYCLIC_RECOMMENDATION_PAGE_SIZE\)/);
  assert.match(cyclic, /Recomendar 30 más vendidos/);
  assert.doesNotMatch(cyclic, /p_limit: 200/);
});

test('all cyclic recommendation types use indexed server pagination', () => {
  assert.match(cyclicSql, /get_cyclic_assignment_recommendations_page/i);
  assert.match(sql, /idx_cyclic_assignments_recommendation_store_date_product/i);
  assert.match(cyclicSql, /limit least\(greatest\(coalesce\(p_limit, 51\), 1\), 101\)/i);
  assert.match(cyclic, /p_kind: "MIXTA"/);
  assert.match(cyclic, /p_kind: "NO_ABC_VALORIZADO"/);
  assert.match(cyclic, /setBaseRecommendationHasNext\(rawRows\.length > CYCLIC_RECOMMENDATION_PAGE_SIZE\)/);
  assert.match(cyclic, /Recomendar 30 códigos/);
  assert.match(cyclic, /Recomendar 30 valorizados no ABC/);
});
