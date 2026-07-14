-- Reporte de Stock/Rotaciones (ReportesModule) calculado en la BD.
--
-- Antes el cliente traia, POR CADA tienda seleccionada, TODA la tabla
-- stock_general de esa sede (paginado de 1000 en 1000) + TODO el catalogo
-- activo de cyclic_products + las rotaciones del mes, y hacia el join /
-- suma / agrupacion en JavaScript (loadCostMap + loadReport). Con catalogos
-- grandes eso transfiere decenas de miles de filas para mostrar ~30 filas.
--
-- Esta funcion devuelve, para UNA sede, el valorizado ya agrupado por
-- categoria de rotacion (una fila por rotacion, 'SIN ROTACION' incluida).
-- El cliente llama una vez por tienda y reconstruye:
--   - la fila de "Valorizado por tienda"  = suma de los grupos devueltos
--   - la tabla "Valorizado por rotacion"  = merge de los grupos entre tiendas
--
-- Replica EXACTAMENTE la logica previa del cliente:
--   - stock por sku      = SUM(stock) de stock_general (sede = p_sede, stock > 0),
--                          sku normalizado con upper(btrim(codsap))
--   - costo por sku      = cyclic_products.cost (solo is_active = true), parseado
--                          igual que parseCost() del cliente (quita "S/", espacios
--                          y comas; si no es numerico -> 0)
--   - rotacion por sku   = rotation_category del periodo mas reciente en
--                          product_rotation_monthly con store_key en
--                          p_rotation_store_keys y period_month <= p_rotation_period
--                          (los alias de store_key los sigue calculando el cliente
--                          con rotationStoreKeysForStore, igual que antes)
--   - inventory_value    = SUM(ROUND(stock_sku * costo, 2)) por rotacion
--   - missing_cost_codes = codigos con stock cuyo costo es 0 o negativo
--
-- Indices que la soportan (ya existentes, no se crean nuevos):
--   - idx_stock_general_sede_stock_codsap  ON stock_general(sede, codsap) WHERE stock > 0
--   - idx_cyclic_products_active_sku       ON cyclic_products(is_active, sku)
--   - idx_product_rotation_monthly_store_month ON product_rotation_monthly(store_key, period_month)

CREATE OR REPLACE FUNCTION get_stock_valuation_report(
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
    -- Stock agregado por codigo normalizado (mismo criterio que el cliente:
    -- upper + trim del codsap, solo filas con stock > 0).
    SELECT
      upper(btrim(sg.codsap)) AS sku,
      ROUND(SUM(sg.stock)::numeric, 2) AS stock
    FROM stock_general sg
    WHERE sg.sede = p_sede
      AND sg.stock > 0
      AND btrim(COALESCE(sg.codsap, '')) <> ''
    GROUP BY upper(btrim(sg.codsap))
  ),
  costs AS (
    -- Catalogo activo con el costo parseado igual que parseCost() del cliente.
    -- DISTINCT ON evita duplicar filas de stock si dos productos activos
    -- normalizan al mismo sku (se prefiere el de costo mayor).
    SELECT DISTINCT ON (upper(btrim(cp.sku)))
      upper(btrim(cp.sku)) AS sku,
      CASE
        WHEN regexp_replace(COALESCE(cp.cost::text, '0'), 'S/|\s|,', '', 'gi')
             ~ '^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$'
        THEN regexp_replace(COALESCE(cp.cost::text, '0'), 'S/|\s|,', '', 'gi')::numeric
        ELSE 0
      END AS cost
    FROM cyclic_products cp
    WHERE cp.is_active = true
    ORDER BY upper(btrim(cp.sku)), 2 DESC
  ),
  rotations AS (
    -- Ultima rotacion (periodo mas reciente <= p_rotation_period) por codigo.
    -- Se compara product_code crudo contra el sku normalizado del stock,
    -- igual que hacia el .in("product_code", skusNormalizados) del cliente.
    SELECT DISTINCT ON (prm.product_code)
      prm.product_code AS sku,
      NULLIF(upper(btrim(prm.rotation_category)), '') AS rotation
    FROM product_rotation_monthly prm
    WHERE prm.store_key = ANY (COALESCE(p_rotation_store_keys, '{}'))
      AND prm.period_month <= COALESCE(p_rotation_period, date_trunc('month', now())::date)
    ORDER BY prm.product_code, prm.period_month DESC, prm.rotation_category
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

GRANT EXECUTE ON FUNCTION get_stock_valuation_report(text, text[], date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
