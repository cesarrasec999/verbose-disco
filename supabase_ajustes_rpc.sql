CREATE OR REPLACE FUNCTION get_ajustes_provisionales(year_start text DEFAULT NULL)
RETURNS TABLE(
  store_code  text,
  product_code text,
  description  text,
  unit         text,
  qty_ajuste   float8,
  qty_regulariz float8,
  total_qty    float8,
  total_value  float8,
  record_count int,
  last_date    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    em.store_code::text,
    em.product_code::text,
    MAX(em.description)::text,
    MAX(em.unit)::text,
    SUM(CASE WHEN em.reason ILIKE '%REGULARIZ%' THEN 0 ELSE em.quantity END)::float8,
    SUM(CASE WHEN em.reason ILIKE '%REGULARIZ%' THEN em.quantity ELSE 0 END)::float8,
    SUM(em.quantity)::float8,
    SUM(COALESCE(em.value_total, 0))::float8,
    COUNT(*)::int,
    MAX(em.movement_date)
  FROM erp_movements em
  WHERE em.source_type = 'ADJUSTMENT'
    AND em.movement_date >= COALESCE(year_start::date, date_trunc('year', CURRENT_DATE)::date)
    AND (em.reason ILIKE '%PROVIS%' OR em.reason ILIKE '%REGULARIZ%')
  GROUP BY em.store_code, em.product_code
  HAVING SUM(em.quantity) > 0
  ORDER BY em.store_code, MAX(em.movement_date) DESC;
$$;

GRANT EXECUTE ON FUNCTION get_ajustes_provisionales(text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
