-- Ajustes Provisionales: la consulta anterior agregaba todo el año y hacía un
-- DISTINCT ON sobre todos los ajustes para hallar el último usuario. En una
-- réplica grande de erp_movements podía agotar statement_timeout aun pidiendo
-- solo una página. Los índices parciales aíslan los motivos 06/07 y el LATERAL
-- busca el último usuario únicamente para las filas agregadas de la página.

CREATE INDEX IF NOT EXISTS idx_erp_movements_provisional_aggregate_date_store_product
  ON public.erp_movements (movement_date DESC, store_code, product_code)
  INCLUDE (quantity, value_total, reason, description, unit)
  WHERE source_type = 'ADJUSTMENT'
    AND (reason ILIKE '%PROVIS%' OR reason ILIKE '%REGULARIZ%');

CREATE INDEX IF NOT EXISTS idx_erp_movements_provisional_latest_user
  ON public.erp_movements (store_code, product_code, movement_date DESC, updated_at DESC, movement_key DESC)
  INCLUDE (adjustment_user)
  WHERE source_type = 'ADJUSTMENT'
    AND reason ILIKE '%PROVIS%'
    AND reason NOT ILIKE '%REGULARIZ%'
    AND quantity > 0;

CREATE OR REPLACE FUNCTION public.get_ajustes_provisionales(
  year_start text DEFAULT NULL,
  p_store text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  store_code text,
  product_code text,
  description text,
  unit text,
  qty_ajuste double precision,
  qty_regulariz double precision,
  total_qty double precision,
  total_value double precision,
  record_count integer,
  last_date timestamp with time zone,
  last_user text,
  total_rows bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      em.store_code::text,
      em.product_code::text,
      MAX(em.description)::text AS description,
      MAX(em.unit)::text AS unit,
      SUM(CASE WHEN em.reason ILIKE '%REGULARIZ%' THEN 0 ELSE em.quantity END)::double precision AS qty_ajuste,
      SUM(CASE WHEN em.reason ILIKE '%REGULARIZ%' THEN em.quantity ELSE 0 END)::double precision AS qty_regulariz,
      SUM(em.quantity)::double precision AS total_qty,
      SUM(COALESCE(em.value_total, 0))::double precision AS total_value,
      COUNT(*)::integer AS record_count,
      MAX(em.movement_date) AS last_date
    FROM public.erp_movements em
    WHERE em.source_type = 'ADJUSTMENT'
      AND em.movement_date >= COALESCE(year_start::date, date_trunc('year', CURRENT_DATE)::date)
      AND (em.reason ILIKE '%PROVIS%' OR em.reason ILIKE '%REGULARIZ%')
      AND (p_store IS NULL OR em.store_code = p_store)
    GROUP BY em.store_code, em.product_code
    HAVING SUM(em.quantity) > 0
  )
  SELECT
    b.store_code, b.product_code, b.description, b.unit,
    b.qty_ajuste, b.qty_regulariz, b.total_qty, b.total_value,
    b.record_count, b.last_date, lp.last_user,
    NULL::bigint AS total_rows
  FROM base b
  LEFT JOIN LATERAL (
    SELECT NULLIF(em.adjustment_user, '')::text AS last_user
    FROM public.erp_movements em
    WHERE em.source_type = 'ADJUSTMENT'
      AND em.store_code = b.store_code
      AND em.product_code = b.product_code
      AND em.movement_date >= COALESCE(year_start::date, date_trunc('year', CURRENT_DATE)::date)
      AND em.reason ILIKE '%PROVIS%'
      AND em.reason NOT ILIKE '%REGULARIZ%'
      AND em.quantity > 0
    ORDER BY em.movement_date DESC, em.updated_at DESC, em.movement_key DESC
    LIMIT 1
  ) lp ON true
  ORDER BY b.store_code, b.last_date DESC, b.product_code
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 101)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

GRANT EXECUTE ON FUNCTION public.get_ajustes_provisionales(text, text, integer, integer)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
