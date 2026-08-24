-- Las rotaciones usadas por reportes e inventarios deben pertenecer siempre
-- a un ciclo mensual cerrado. El período recibido es el mes de referencia
-- (por ejemplo, agosto); por eso se toma el último mes estrictamente anterior.

CREATE OR REPLACE FUNCTION public.calculate_product_rotation(p_target_month date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
BEGIN
  PERFORM public.calculate_product_rotation_net_documents(
    COALESCE(
      p_target_month,
      date_trunc('month', current_date - interval '1 month')::date
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_stock_valuation_report(
  p_sede text,
  p_rotation_store_keys text[] DEFAULT '{}',
  p_rotation_period date DEFAULT NULL
)
RETURNS TABLE (
  rotation text,
  codes_with_stock integer,
  total_units numeric,
  inventory_value numeric,
  missing_cost_codes integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH stock AS (
    SELECT
      upper(btrim(sg.codsap)) AS sku,
      ROUND(SUM(sg.stock)::numeric, 2) AS stock
    FROM public.stock_general sg
    WHERE sg.sede = p_sede
      AND sg.stock > 0
      AND btrim(COALESCE(sg.codsap, '')) <> ''
    GROUP BY upper(btrim(sg.codsap))
  ),
  costs AS (
    SELECT DISTINCT ON (upper(btrim(cp.sku)))
      upper(btrim(cp.sku)) AS sku,
      CASE
        WHEN regexp_replace(COALESCE(cp.cost::text, '0'), 'S/|\s|,', '', 'gi')
             ~ '^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$'
        THEN regexp_replace(COALESCE(cp.cost::text, '0'), 'S/|\s|,', '', 'gi')::numeric
        ELSE 0
      END AS cost
    FROM public.cyclic_products cp
    WHERE cp.is_active = true
    ORDER BY upper(btrim(cp.sku)), 2 DESC
  ),
  rotations AS (
    SELECT DISTINCT ON (upper(btrim(prm.product_code)))
      upper(btrim(prm.product_code)) AS sku,
      NULLIF(upper(btrim(prm.rotation_category)), '') AS rotation
    FROM public.product_rotation_monthly prm
    WHERE prm.store_key = ANY (COALESCE(p_rotation_store_keys, '{}'))
      -- Nunca incluir el mes de referencia: puede estar todavía incompleto.
      AND prm.period_month < COALESCE(p_rotation_period, date_trunc('month', now())::date)
    ORDER BY upper(btrim(prm.product_code)), prm.period_month DESC, prm.rotation_category
  )
  SELECT
    COALESCE(r.rotation, 'SIN ROTACION') AS rotation,
    COUNT(*)::integer AS codes_with_stock,
    ROUND(SUM(s.stock), 2) AS total_units,
    ROUND(SUM(ROUND(s.stock * COALESCE(c.cost, 0), 2)), 2) AS inventory_value,
    (COUNT(*) FILTER (WHERE COALESCE(c.cost, 0) <= 0))::integer AS missing_cost_codes
  FROM stock s
  LEFT JOIN costs c ON c.sku = s.sku
  LEFT JOIN rotations r ON r.sku = s.sku
  GROUP BY COALESCE(r.rotation, 'SIN ROTACION')
  ORDER BY inventory_value DESC, rotation;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_product_rotation(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_stock_valuation_report(text, text[], date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
