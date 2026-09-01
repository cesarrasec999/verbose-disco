-- Consultas de Análisis: el reporte de valorizado se invoca por sede. La
-- versión anterior obtenía toda la historia de rotaciones de cada sede y el
-- catálogo completo antes de cruzarlos con el stock. Con varias sedes eso
-- superaba el statement_timeout de la API.
--
-- Esta versión parte siempre del stock positivo de la sede y busca, para cada
-- SKU resultante, únicamente su costo activo y su rotación del ciclo cerrado
-- solicitado. Los índices ya existentes de SKU normalizado cubren ambas
-- búsquedas. No modifica datos ni categorías.

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
  WITH stock AS MATERIALIZED (
    SELECT
      upper(btrim(sg.codsap)) AS sku,
      round(sum(sg.stock)::numeric, 2) AS stock
    FROM public.stock_general sg
    WHERE sg.sede = p_sede
      AND sg.stock > 0
      AND btrim(coalesce(sg.codsap, '')) <> ''
    GROUP BY upper(btrim(sg.codsap))
  ),
  valued_stock AS (
    SELECT
      s.sku,
      s.stock,
      coalesce(cost_row.cost, 0) AS cost,
      rotation_row.rotation
    FROM stock s
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN regexp_replace(coalesce(cp.cost::text, '0'), 'S/|\s|,', '', 'gi')
             ~ '^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$'
          THEN regexp_replace(coalesce(cp.cost::text, '0'), 'S/|\s|,', '', 'gi')::numeric
        ELSE 0
      END AS cost
      FROM public.cyclic_products cp
      WHERE cp.is_active = true
        AND upper(btrim(cp.sku)) = s.sku
      ORDER BY 1 DESC
      LIMIT 1
    ) AS cost_row ON true
    LEFT JOIN LATERAL (
      SELECT nullif(upper(btrim(prm.rotation_category)), '') AS rotation
      FROM public.product_rotation_monthly prm
      WHERE prm.store_key = ANY (coalesce(p_rotation_store_keys, '{}'))
        AND upper(btrim(prm.product_code)) = s.sku
        AND prm.period_month = coalesce(p_rotation_period, date_trunc('month', current_date - interval '1 month')::date)
      ORDER BY prm.rotation_category
      LIMIT 1
    ) AS rotation_row ON true
  )
  SELECT
    coalesce(vs.rotation, 'SIN ROTACION') AS rotation,
    count(*)::integer AS codes_with_stock,
    round(sum(vs.stock), 2) AS total_units,
    round(sum(round(vs.stock * vs.cost, 2)), 2) AS inventory_value,
    (count(*) FILTER (WHERE vs.cost <= 0))::integer AS missing_cost_codes
  FROM valued_stock vs
  GROUP BY coalesce(vs.rotation, 'SIN ROTACION')
  ORDER BY inventory_value DESC, rotation;
$$;

-- Cubre la búsqueda exacta por sede de rotación, SKU y mes cerrado que usa
-- la función anterior. INCLUDE permite resolver la categoría desde el índice.
CREATE INDEX IF NOT EXISTS idx_product_rotation_monthly_store_period_sku
  ON public.product_rotation_monthly (
    store_key,
    period_month,
    upper(btrim(product_code))
  ) INCLUDE (rotation_category);

-- Historial del gráfico: filtra primero fecha y opcionalmente la sede, luego
-- ordena por valorizado sin necesitar ordenar toda la tabla en memoria.
CREATE INDEX IF NOT EXISTS idx_inventory_rotation_daily_date_store_value
  ON public.inventory_rotation_valuation_daily (
    snapshot_date DESC,
    store_key,
    inventory_value DESC
  ) INCLUDE (store_name, rotation_category, codes_with_stock, total_units);

GRANT EXECUTE ON FUNCTION public.get_stock_valuation_report(text, text[], date)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
