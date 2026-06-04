-- =============================================================================
-- supabase_rotation_calculation.sql
-- Cálculo mensual de rotación de productos por tienda
--
-- Tablas involucradas:
--   erp_movements           — movimientos del ERP (ventas y devoluciones)
--   cyclic_products         — catálogo maestro de productos cíclicos
--   stores                  — tiendas activas con mapeo ERP
--   stock_general           — stock actual por sede/producto
--   product_rotation_monthly  — resultado mensual por tienda-producto
--   product_rotation_store    — acumulado histórico por tienda-producto
--   product_rotation_summary  — resumen por tienda (conteo por categoría)
--
-- Mapeo erp_movements.store_code ← stores.erp_sede:
--   erp_sede "GPC006 LIM - CALLAO"  →  store_code "1006"
--   erp_sede "GPC001 LIM - PERLA"   →  store_code "1001"
--   Formula: (1000 + substring(erp_sede FROM 'GPC0*([0-9]+)')::integer)::text
--   CD-GPC  →  store_code "0"  (agrega TODAS las tiendas)
--
-- Umbrales GPC (tiendas normales):   A≥10, B≥6, C≥2, D resto
-- Umbrales CD-GPC (central):         A≥30, B≥20, C≥10, D resto
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Índices de rendimiento necesarios para los JOINs y filtros pesados
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_erp_movements_type_date
  ON public.erp_movements (source_type, movement_date, store_code, product_code);

CREATE INDEX IF NOT EXISTS idx_erp_movements_store_product
  ON public.erp_movements (store_code, product_code, movement_date);

-- =============================================================================
-- FUNCIÓN 1: calculate_product_rotation
-- Calcula rotación mensual y actualiza las tres tablas de resultado.
-- Parámetro: p_target_month  — si NULL usa el mes del día de ayer
--            (permite recalcular meses anteriores pasando una fecha explícita)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.calculate_product_rotation(
  p_target_month date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_month        date;   -- primer día del mes objetivo
  v_lookback_3m  date;   -- inicio ventana 3 meses para avg
  v_lookback_12m date;   -- inicio ventana 12 meses para X/H
BEGIN
  -- Largo timeout: la operación puede manejar miles de combinaciones tienda-producto
  SET LOCAL statement_timeout = '120s';

  -- -------------------------------------------------------------------------
  -- Determinar mes objetivo
  -- -------------------------------------------------------------------------
  v_month        := date_trunc('month',
                      COALESCE(p_target_month, current_date - interval '1 day')
                    )::date;
  v_lookback_3m  := v_month - interval '3 months';
  v_lookback_12m := v_month - interval '12 months';

  RAISE NOTICE 'calculate_product_rotation: mes=%, ventana_3m=%, ventana_12m=%',
    v_month, v_lookback_3m, v_lookback_12m;

  -- =========================================================================
  -- PASO 1 — Borrar registros existentes para el mes objetivo
  -- =========================================================================

  DELETE FROM public.product_rotation_monthly prm
  WHERE prm.period_month = v_month;

  -- =========================================================================
  -- PASO 2-6 — Calcular y poblar product_rotation_monthly para tiendas GPC
  --            (excluye CD-GPC, que se procesa por separado en el paso 5-6)
  -- =========================================================================

  -- La lógica completa se materializa en tablas temporales para reutilizarlas
  -- entre los pasos de INSERT y la actualización de product_rotation_store.

  -- -------------------------------------------------------------------------
  -- Temp 1: ventas netas mensuales por (store_code, product_code, sale_month)
  -- Ventana completa de 12 meses para capturar H/X y primeras ventas.
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _tmp_monthly_sales ON COMMIT DROP AS
  WITH raw_mv AS (
    SELECT
      em.store_code                                          AS mv_store_code,
      UPPER(TRIM(em.product_code))                          AS mv_product_code,
      date_trunc('month', em.movement_date)::date           AS mv_sale_month,
      -- Las ventas en erp_movements son negativas (reducen stock),
    -- las devoluciones son positivas. Negamos para obtener cantidades positivas netas.
    -em.quantity                                            AS mv_signed_qty
    FROM public.erp_movements em
    WHERE em.source_type IN ('RECEIPT_SALE', 'RECEIPT_RETURN')
      AND em.movement_date >= v_lookback_12m
      AND em.movement_date  < v_month + interval '1 month'
      AND NULLIF(TRIM(em.store_code), '')   IS NOT NULL
      AND NULLIF(TRIM(em.product_code), '') IS NOT NULL
  )
  SELECT
    mv_store_code   AS ms_store_code,
    mv_product_code AS ms_product_code,
    mv_sale_month   AS ms_sale_month,
    GREATEST(0, SUM(mv_signed_qty))::numeric(18,6) AS ms_net_qty
  FROM raw_mv
  GROUP BY mv_store_code, mv_product_code, mv_sale_month;

  CREATE INDEX IF NOT EXISTS _idx_tmp_monthly_sales
    ON _tmp_monthly_sales (ms_store_code, ms_product_code, ms_sale_month);

  -- -------------------------------------------------------------------------
  -- Temp 2: métricas agregadas por (store_code, product_code)
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _tmp_metrics ON COMMIT DROP AS
  SELECT
    ms.ms_store_code                              AS mt_store_code,
    ms.ms_product_code                            AS mt_product_code,
    -- Promedio de ventas netas en los últimos 3 meses completos
    COALESCE(
      SUM(ms.ms_net_qty)
        FILTER (WHERE ms.ms_sale_month >= v_lookback_3m
                  AND ms.ms_sale_month  < v_month)
      / 3.0,
      0
    )::numeric(18,6)                              AS mt_avg_3m,
    -- Último mes con venta positiva dentro de la ventana 12m
    MAX(ms.ms_sale_month)
      FILTER (WHERE ms.ms_net_qty > 0)            AS mt_last_sale_month,
    -- Primer mes con venta positiva dentro de la ventana 12m
    MIN(ms.ms_sale_month)
      FILTER (WHERE ms.ms_net_qty > 0)            AS mt_first_sale_month,
    -- Total de ventas en la ventana completa
    COALESCE(SUM(ms.ms_net_qty), 0)::numeric(18,6) AS mt_sales_total,
    -- Cantidad de meses distintos con venta positiva
    (COUNT(DISTINCT ms.ms_sale_month)
      FILTER (WHERE ms.ms_net_qty > 0))::integer   AS mt_sales_months
  FROM _tmp_monthly_sales ms
  GROUP BY ms.ms_store_code, ms.ms_product_code;

  CREATE INDEX IF NOT EXISTS _idx_tmp_metrics
    ON _tmp_metrics (mt_store_code, mt_product_code);

  -- -------------------------------------------------------------------------
  -- Temp 3: universo de productos a evaluar por tienda GPC
  --   Incluye: todo producto con stock > 0 en esa sede
  --         +  todo producto con movimientos en los últimos 12 meses
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _tmp_scope_gpc ON COMMIT DROP AS
  WITH stores_gpc AS (
    -- Tiendas GPC activas con su store_code derivado
    SELECT
      st.id                                                       AS st_id,
      st.name                                                     AS st_name,
      st.erp_sede                                                 AS st_erp_sede,
      (1000 + SUBSTRING(st.erp_sede FROM 'GPC0*([0-9]+)')::integer)::text
                                                                  AS st_store_code,
      -- store_key = parte luego del último guión, en mayúsculas
      UPPER(TRIM(regexp_replace(st.erp_sede, '^.*-\s*', '')))     AS st_store_key
    FROM public.stores st
    WHERE st.is_active IS DISTINCT FROM false
      -- Solo tiendas GPC (excluye CD-GPC)
      AND st.erp_sede ~ 'GPC[0-9]+'
      AND st.erp_sede NOT ILIKE '%CD-GPC%'
  ),
  -- Productos con stock en la sede
  products_with_stock AS (
    SELECT DISTINCT
      sg_st.st_store_code    AS ps_store_code,
      UPPER(TRIM(sg.codsap)) AS ps_product_code
    FROM public.stock_general sg
    JOIN stores_gpc sg_st
      ON TRIM(sg.sede) = TRIM(sg_st.st_erp_sede)
       OR TRIM(sg.sede) = TRIM(sg_st.st_name)
    WHERE NULLIF(TRIM(sg.codsap), '') IS NOT NULL
      AND sg.stock > 0
  ),
  -- Productos con movimientos recientes en erp_movements (ventana 12m)
  products_with_movements AS (
    SELECT DISTINCT
      ms.ms_store_code    AS pm_store_code,
      ms.ms_product_code  AS pm_product_code
    FROM _tmp_monthly_sales ms
  ),
  combined AS (
    SELECT ps_store_code AS scope_store_code, ps_product_code AS scope_product_code
    FROM products_with_stock
    UNION
    SELECT pm_store_code, pm_product_code
    FROM products_with_movements
    WHERE pm_store_code IN (SELECT st_store_code FROM stores_gpc)
  )
  SELECT
    sg_st.st_store_code   AS sc_store_code,
    sg_st.st_name         AS sc_store_name,
    sg_st.st_erp_sede     AS sc_erp_sede,
    sg_st.st_store_key    AS sc_store_key,
    co.scope_product_code AS sc_product_code,
    cp.description        AS sc_description,
    cp.unit               AS sc_unit,
    cp.product_created_at AS sc_product_created_at
  FROM combined co
  JOIN stores_gpc sg_st
    ON sg_st.st_store_code = co.scope_store_code
  LEFT JOIN public.cyclic_products cp
    ON UPPER(TRIM(cp.sku)) = co.scope_product_code
    AND cp.is_active IS DISTINCT FROM false;

  CREATE INDEX IF NOT EXISTS _idx_tmp_scope_gpc
    ON _tmp_scope_gpc (sc_store_code, sc_product_code);

  -- -------------------------------------------------------------------------
  -- Temp 4: cálculo de categorías para tiendas GPC
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _tmp_rotation_gpc ON COMMIT DROP AS
  SELECT
    sc.sc_store_code         AS rg_store_code,
    sc.sc_store_name         AS rg_store_name,
    sc.sc_erp_sede           AS rg_erp_sede,
    sc.sc_store_key          AS rg_store_key,
    sc.sc_product_code       AS rg_product_code,
    sc.sc_description        AS rg_description,
    sc.sc_unit               AS rg_unit,
    COALESCE(mt.mt_avg_3m, 0)::numeric(18,6)       AS rg_avg_3m,
    mt.mt_last_sale_month                           AS rg_last_sale_month,
    mt.mt_first_sale_month                          AS rg_first_sale_month,
    COALESCE(mt.mt_sales_total, 0)::numeric(18,6)   AS rg_sales_total,
    COALESCE(mt.mt_sales_months, 0)::integer        AS rg_sales_months,
    -- meses desde la última venta (NULL → 99 = nunca vendió)
    COALESCE(
      (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mt.mt_last_sale_month::timestamp)) * 12
      + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mt.mt_last_sale_month::timestamp),
      99
    )::integer                                      AS rg_months_since_last,
    sc.sc_product_created_at                        AS rg_product_created_at,
    CASE
      -- 1. Nuevo: creado este mes O primera venta este mes
      WHEN sc.sc_product_created_at >= v_month
        THEN 'Nuevo'
      WHEN mt.mt_first_sale_month = v_month
        AND COALESCE(
              (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mt.mt_last_sale_month::timestamp)) * 12
              + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mt.mt_last_sale_month::timestamp),
              99
            ) <= 1
        THEN 'Nuevo'
      -- 2. H: sin ventas en 12 meses (o nunca) y producto antiguo
      WHEN COALESCE(
             (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mt.mt_last_sale_month::timestamp)) * 12
             + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mt.mt_last_sale_month::timestamp),
             99
           ) >= 12
        THEN 'H'
      WHEN mt.mt_last_sale_month IS NULL
        AND (sc.sc_product_created_at IS NULL OR sc.sc_product_created_at < v_lookback_12m)
        THEN 'H'
      -- 3. X: sin ventas por 3+ meses
      WHEN COALESCE(
             (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mt.mt_last_sale_month::timestamp)) * 12
             + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mt.mt_last_sale_month::timestamp),
             99
           ) >= 3
        THEN 'X'
      -- 4-7. ABC/D por promedio 3m
      WHEN COALESCE(mt.mt_avg_3m, 0) >= 10 THEN 'A'
      WHEN COALESCE(mt.mt_avg_3m, 0) >= 6  THEN 'B'
      WHEN COALESCE(mt.mt_avg_3m, 0) >= 2  THEN 'C'
      ELSE 'D'
    END                                             AS rg_rotation_category
  FROM _tmp_scope_gpc sc
  LEFT JOIN _tmp_metrics mt
    ON mt.mt_store_code   = sc.sc_store_code
   AND mt.mt_product_code = sc.sc_product_code;

  -- -------------------------------------------------------------------------
  -- Temp 5: métricas CD-GPC (agrega TODAS las tiendas de erp_movements)
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _tmp_metrics_cd ON COMMIT DROP AS
  SELECT
    ms.ms_product_code                              AS mcd_product_code,
    COALESCE(
      SUM(ms.ms_net_qty)
        FILTER (WHERE ms.ms_sale_month >= v_lookback_3m
                  AND ms.ms_sale_month  < v_month)
      / 3.0,
      0
    )::numeric(18,6)                                AS mcd_avg_3m,
    MAX(ms.ms_sale_month)
      FILTER (WHERE ms.ms_net_qty > 0)              AS mcd_last_sale_month,
    MIN(ms.ms_sale_month)
      FILTER (WHERE ms.ms_net_qty > 0)              AS mcd_first_sale_month,
    COALESCE(SUM(ms.ms_net_qty), 0)::numeric(18,6)  AS mcd_sales_total,
    (COUNT(DISTINCT ms.ms_sale_month)
      FILTER (WHERE ms.ms_net_qty > 0))::integer     AS mcd_sales_months
  FROM _tmp_monthly_sales ms
  GROUP BY ms.ms_product_code;

  -- -------------------------------------------------------------------------
  -- Temp 6: scope CD-GPC
  --   Todos los productos que aparecen en erp_movements (cualquier tienda)
  --   más los que tienen stock en la sede CD-GPC
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _tmp_scope_cd ON COMMIT DROP AS
  WITH store_cd AS (
    SELECT
      st.name      AS st_name,
      st.erp_sede  AS st_erp_sede
    FROM public.stores st
    WHERE st.is_active IS DISTINCT FROM false
      AND st.erp_sede ILIKE '%CD-GPC%'
    LIMIT 1
  ),
  products_cd_stock AS (
    SELECT DISTINCT UPPER(TRIM(sg.codsap)) AS scd_product_code
    FROM public.stock_general sg
    JOIN store_cd cd
      ON TRIM(sg.sede) = TRIM(cd.st_erp_sede)
       OR TRIM(sg.sede) = TRIM(cd.st_name)
    WHERE NULLIF(TRIM(sg.codsap), '') IS NOT NULL
      AND sg.stock > 0
  ),
  products_any_movement AS (
    SELECT DISTINCT ms.ms_product_code AS scd_product_code
    FROM _tmp_monthly_sales ms
  ),
  combined_cd AS (
    SELECT scd_product_code FROM products_cd_stock
    UNION
    SELECT scd_product_code FROM products_any_movement
  )
  SELECT
    cc.scd_product_code   AS scd_product_code,
    cp.description        AS scd_description,
    cp.unit               AS scd_unit,
    cp.product_created_at AS scd_product_created_at
  FROM combined_cd cc
  LEFT JOIN public.cyclic_products cp
    ON UPPER(TRIM(cp.sku)) = cc.scd_product_code
    AND cp.is_active IS DISTINCT FROM false;

  -- -------------------------------------------------------------------------
  -- Temp 7: categorías CD-GPC
  -- -------------------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _tmp_rotation_cd ON COMMIT DROP AS
  SELECT
    '0'::text                                       AS rcd_store_code,
    'CD-GPC'::text                                  AS rcd_store_name,
    'CD-GPC'::text                                  AS rcd_store_key,
    scd.scd_product_code                            AS rcd_product_code,
    scd.scd_description                             AS rcd_description,
    scd.scd_unit                                    AS rcd_unit,
    COALESCE(mcd.mcd_avg_3m, 0)::numeric(18,6)      AS rcd_avg_3m,
    mcd.mcd_last_sale_month                         AS rcd_last_sale_month,
    mcd.mcd_first_sale_month                        AS rcd_first_sale_month,
    COALESCE(mcd.mcd_sales_total, 0)::numeric(18,6) AS rcd_sales_total,
    COALESCE(mcd.mcd_sales_months, 0)::integer      AS rcd_sales_months,
    COALESCE(
      (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mcd.mcd_last_sale_month::timestamp)) * 12
      + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mcd.mcd_last_sale_month::timestamp),
      99
    )::integer                                      AS rcd_months_since_last,
    scd.scd_product_created_at                      AS rcd_product_created_at,
    CASE
      WHEN scd.scd_product_created_at >= v_month
        THEN 'Nuevo'
      WHEN mcd.mcd_first_sale_month = v_month
        AND COALESCE(
              (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mcd.mcd_last_sale_month::timestamp)) * 12
              + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mcd.mcd_last_sale_month::timestamp),
              99
            ) <= 1
        THEN 'Nuevo'
      WHEN COALESCE(
             (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mcd.mcd_last_sale_month::timestamp)) * 12
             + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mcd.mcd_last_sale_month::timestamp),
             99
           ) >= 12
        THEN 'H'
      WHEN mcd.mcd_last_sale_month IS NULL
        AND (scd.scd_product_created_at IS NULL OR scd.scd_product_created_at < v_lookback_12m)
        THEN 'H'
      WHEN COALESCE(
             (DATE_PART('year',  v_month::timestamp) - DATE_PART('year',  mcd.mcd_last_sale_month::timestamp)) * 12
             + DATE_PART('month', v_month::timestamp) - DATE_PART('month', mcd.mcd_last_sale_month::timestamp),
             99
           ) >= 3
        THEN 'X'
      -- Umbrales CD-GPC: A≥30, B≥20, C≥10
      WHEN COALESCE(mcd.mcd_avg_3m, 0) >= 30 THEN 'A'
      WHEN COALESCE(mcd.mcd_avg_3m, 0) >= 20 THEN 'B'
      WHEN COALESCE(mcd.mcd_avg_3m, 0) >= 10 THEN 'C'
      ELSE 'D'
    END                                             AS rcd_rotation_category
  FROM _tmp_scope_cd scd
  LEFT JOIN _tmp_metrics_cd mcd
    ON mcd.mcd_product_code = scd.scd_product_code;

  -- =========================================================================
  -- PASO 6 — INSERT en product_rotation_monthly
  --   GPC: store_key = parte después del último guión (ej: "CALLAO")
  --   CD-GPC: store_key = 'CD-GPC'
  -- =========================================================================

  -- Tiendas GPC
  INSERT INTO public.product_rotation_monthly (
    period_month,
    store_key,
    store_name,
    product_code,
    description,
    unit,
    rotation_category,
    source_name,
    uploaded_at,
    updated_at
  )
  SELECT
    v_month                  AS period_month,
    rg.rg_store_key          AS store_key,
    rg.rg_store_name         AS store_name,
    rg.rg_product_code       AS product_code,
    rg.rg_description        AS description,
    rg.rg_unit               AS unit,
    rg.rg_rotation_category  AS rotation_category,
    'calculated'             AS source_name,
    now()                    AS uploaded_at,
    now()                    AS updated_at
  FROM _tmp_rotation_gpc rg
  ON CONFLICT (period_month, store_key, product_code) DO UPDATE SET
    store_name        = EXCLUDED.store_name,
    description       = EXCLUDED.description,
    unit              = EXCLUDED.unit,
    rotation_category = EXCLUDED.rotation_category,
    source_name       = EXCLUDED.source_name,
    updated_at        = now();

  -- CD-GPC
  INSERT INTO public.product_rotation_monthly (
    period_month,
    store_key,
    store_name,
    product_code,
    description,
    unit,
    rotation_category,
    source_name,
    uploaded_at,
    updated_at
  )
  SELECT
    v_month                   AS period_month,
    rcd.rcd_store_key         AS store_key,
    rcd.rcd_store_name        AS store_name,
    rcd.rcd_product_code      AS product_code,
    rcd.rcd_description       AS description,
    rcd.rcd_unit              AS unit,
    rcd.rcd_rotation_category AS rotation_category,
    'calculated'              AS source_name,
    now()                     AS uploaded_at,
    now()                     AS updated_at
  FROM _tmp_rotation_cd rcd
  ON CONFLICT (period_month, store_key, product_code) DO UPDATE SET
    store_name        = EXCLUDED.store_name,
    description       = EXCLUDED.description,
    unit              = EXCLUDED.unit,
    rotation_category = EXCLUDED.rotation_category,
    source_name       = EXCLUDED.source_name,
    updated_at        = now();

  RAISE NOTICE 'product_rotation_monthly actualizado para %', v_month;

  -- =========================================================================
  -- PASO 7 — Actualizar product_rotation_store
  --   Refleja el estado al fin del mes calculado para cada tienda-producto.
  -- =========================================================================

  -- Borrar registros de las tiendas que vamos a recalcular
  DELETE FROM public.product_rotation_store prs
  WHERE prs.store_code IN (
    SELECT DISTINCT rg_store_code FROM _tmp_rotation_gpc
    UNION ALL
    SELECT '0'
  );

  -- Insertar tiendas GPC
  INSERT INTO public.product_rotation_store (
    store_code,
    store_name,
    store_profile,
    product_code,
    description,
    first_movement_date,
    first_sale_date,
    last_sale_date,
    sales_qty_total,
    sales_months,
    avg_sales_month,
    rotation_category,
    calculated_at
  )
  SELECT
    rg.rg_store_code                                   AS store_code,
    rg.rg_store_name                                   AS store_name,
    'old'::text                                        AS store_profile,
    rg.rg_product_code                                 AS product_code,
    rg.rg_description                                  AS description,
    -- first_movement_date: primera venta o fecha de creación de producto
    COALESCE(rg.rg_first_sale_month, rg.rg_product_created_at) AS first_movement_date,
    rg.rg_first_sale_month                             AS first_sale_date,
    rg.rg_last_sale_month                              AS last_sale_date,
    rg.rg_sales_total                                  AS sales_qty_total,
    rg.rg_sales_months::numeric(10,2)                  AS sales_months,
    COALESCE(ROUND(
      rg.rg_sales_total / NULLIF(rg.rg_sales_months::numeric, 0),
      6
    ), 0)                                              AS avg_sales_month,
    rg.rg_rotation_category                            AS rotation_category,
    now()                                              AS calculated_at
  FROM _tmp_rotation_gpc rg
  ON CONFLICT (store_code, product_code) DO UPDATE SET
    store_name        = EXCLUDED.store_name,
    store_profile     = EXCLUDED.store_profile,
    description       = EXCLUDED.description,
    first_movement_date = EXCLUDED.first_movement_date,
    first_sale_date   = EXCLUDED.first_sale_date,
    last_sale_date    = EXCLUDED.last_sale_date,
    sales_qty_total   = EXCLUDED.sales_qty_total,
    sales_months      = EXCLUDED.sales_months,
    avg_sales_month   = EXCLUDED.avg_sales_month,
    rotation_category = EXCLUDED.rotation_category,
    calculated_at     = now();

  -- Insertar CD-GPC (store_code = '0')
  INSERT INTO public.product_rotation_store (
    store_code,
    store_name,
    store_profile,
    product_code,
    description,
    first_movement_date,
    first_sale_date,
    last_sale_date,
    sales_qty_total,
    sales_months,
    avg_sales_month,
    rotation_category,
    calculated_at
  )
  SELECT
    rcd.rcd_store_code                                  AS store_code,
    rcd.rcd_store_name                                  AS store_name,
    'cd'::text                                          AS store_profile,
    rcd.rcd_product_code                                AS product_code,
    rcd.rcd_description                                 AS description,
    COALESCE(rcd.rcd_first_sale_month, rcd.rcd_product_created_at) AS first_movement_date,
    rcd.rcd_first_sale_month                            AS first_sale_date,
    rcd.rcd_last_sale_month                             AS last_sale_date,
    rcd.rcd_sales_total                                 AS sales_qty_total,
    rcd.rcd_sales_months::numeric(10,2)                 AS sales_months,
    COALESCE(ROUND(
      rcd.rcd_sales_total / NULLIF(rcd.rcd_sales_months::numeric, 0),
      6
    ), 0)                                               AS avg_sales_month,
    rcd.rcd_rotation_category                           AS rotation_category,
    now()                                               AS calculated_at
  FROM _tmp_rotation_cd rcd
  ON CONFLICT (store_code, product_code) DO UPDATE SET
    store_name        = EXCLUDED.store_name,
    store_profile     = EXCLUDED.store_profile,
    description       = EXCLUDED.description,
    first_movement_date = EXCLUDED.first_movement_date,
    first_sale_date   = EXCLUDED.first_sale_date,
    last_sale_date    = EXCLUDED.last_sale_date,
    sales_qty_total   = EXCLUDED.sales_qty_total,
    sales_months      = EXCLUDED.sales_months,
    avg_sales_month   = EXCLUDED.avg_sales_month,
    rotation_category = EXCLUDED.rotation_category,
    calculated_at     = now();

  RAISE NOTICE 'product_rotation_store actualizado';

  -- =========================================================================
  -- PASO 8 — Actualizar product_rotation_summary
  -- =========================================================================

  -- Borrar y recrear resúmenes para las tiendas recalculadas
  DELETE FROM public.product_rotation_summary prs_sum
  WHERE prs_sum.store_code IN (
    SELECT DISTINCT rg_store_code FROM _tmp_rotation_gpc
    UNION ALL
    SELECT '0'
  );

  INSERT INTO public.product_rotation_summary (
    store_code,
    store_name,
    store_profile,
    total_codes,
    category_a,
    category_b,
    category_c,
    category_d,
    category_nuevo,
    category_x,
    category_h,
    calculated_at
  )
  SELECT
    prs.store_code,
    MAX(prs.store_name)                                                          AS store_name,
    MAX(prs.store_profile)                                                       AS store_profile,
    COUNT(*)::integer                                                            AS total_codes,
    COUNT(*) FILTER (WHERE prs.rotation_category = 'A')::integer                AS category_a,
    COUNT(*) FILTER (WHERE prs.rotation_category = 'B')::integer                AS category_b,
    COUNT(*) FILTER (WHERE prs.rotation_category = 'C')::integer                AS category_c,
    COUNT(*) FILTER (WHERE prs.rotation_category = 'D')::integer                AS category_d,
    COUNT(*) FILTER (WHERE prs.rotation_category = 'Nuevo')::integer            AS category_nuevo,
    COUNT(*) FILTER (WHERE prs.rotation_category = 'X')::integer                AS category_x,
    COUNT(*) FILTER (WHERE prs.rotation_category = 'H')::integer                AS category_h,
    now()                                                                        AS calculated_at
  FROM public.product_rotation_store prs
  WHERE prs.store_code IN (
    SELECT DISTINCT rg_store_code FROM _tmp_rotation_gpc
    UNION ALL
    SELECT '0'
  )
  GROUP BY prs.store_code
  ON CONFLICT (store_code) DO UPDATE SET
    store_name     = EXCLUDED.store_name,
    store_profile  = EXCLUDED.store_profile,
    total_codes    = EXCLUDED.total_codes,
    category_a     = EXCLUDED.category_a,
    category_b     = EXCLUDED.category_b,
    category_c     = EXCLUDED.category_c,
    category_d     = EXCLUDED.category_d,
    category_nuevo = EXCLUDED.category_nuevo,
    category_x     = EXCLUDED.category_x,
    category_h     = EXCLUDED.category_h,
    calculated_at  = now();

  RAISE NOTICE 'product_rotation_summary actualizado';

  -- Las tablas temporales se limpian automáticamente al terminar la transacción
  -- (ON COMMIT DROP), pero las dropeamos explícitamente por si se llama fuera
  -- de una transacción explícita.
  DROP TABLE IF EXISTS _tmp_monthly_sales;
  DROP TABLE IF EXISTS _tmp_metrics;
  DROP TABLE IF EXISTS _tmp_scope_gpc;
  DROP TABLE IF EXISTS _tmp_rotation_gpc;
  DROP TABLE IF EXISTS _tmp_metrics_cd;
  DROP TABLE IF EXISTS _tmp_scope_cd;
  DROP TABLE IF EXISTS _tmp_rotation_cd;

END;
$$;

-- =============================================================================
-- FUNCIÓN 2: get_rotation_report
-- Devuelve tabla para exportar a Excel con todas las métricas relevantes.
-- Lee de product_rotation_monthly + product_rotation_store.
-- Todos los alias son explícitos para evitar ambigüedad con RETURNS TABLE.
-- Parámetro: p_month — si NULL usa el mes del día de ayer
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_rotation_report(
  p_month date DEFAULT NULL
)
RETURNS TABLE(
  report_store_code        text,
  report_store_name        text,
  report_store_key         text,
  report_product_code      text,
  report_description       text,
  report_unit              text,
  report_rotation_category text,
  report_avg_sales_3m      numeric,
  report_last_sale_month   date,
  report_first_sale_month  date,
  report_sales_qty_total   numeric,
  report_period_month      date
)
LANGUAGE sql
STABLE
AS $$
  WITH v AS (
    SELECT date_trunc('month',
             COALESCE(p_month, current_date - interval '1 day')
           )::date AS month_val
  ),
  -- Construir mapeo store_key → store_code para tiendas GPC
  store_map AS (
    SELECT
      UPPER(TRIM(regexp_replace(st.erp_sede, '^.*-\s*', '')))                  AS sm_store_key,
      (1000 + SUBSTRING(st.erp_sede FROM 'GPC0*([0-9]+)')::integer)::text      AS sm_store_code,
      st.name                                                                   AS sm_store_name
    FROM public.stores st
    WHERE st.is_active IS DISTINCT FROM false
      AND st.erp_sede ~ 'GPC[0-9]+'
      AND st.erp_sede NOT ILIKE '%CD-GPC%'
  ),
  gpc_rows AS (
    SELECT
      sm.sm_store_code                              AS r_store_code,
      sm.sm_store_name                              AS r_store_name,
      prm.store_key                                 AS r_store_key,
      prm.product_code                              AS r_product_code,
      COALESCE(prs.description, prm.description)    AS r_description,
      prm.unit                                      AS r_unit,
      prm.rotation_category                         AS r_rotation_category,
      ROUND(COALESCE(prs.avg_sales_month, 0), 4)    AS r_avg_sales_3m,
      prs.last_sale_date                            AS r_last_sale_month,
      prs.first_sale_date                           AS r_first_sale_month,
      COALESCE(prs.sales_qty_total, 0)              AS r_sales_qty_total,
      prm.period_month                              AS r_period_month
    FROM (SELECT month_val FROM v) vv
    CROSS JOIN public.product_rotation_monthly prm
    JOIN store_map sm
      ON sm.sm_store_key = prm.store_key
    LEFT JOIN public.product_rotation_store prs
      ON prs.store_code   = sm.sm_store_code
     AND prs.product_code = prm.product_code
    WHERE prm.period_month = vv.month_val
      AND prm.store_key   <> 'CD-GPC'
  ),
  cd_rows AS (
    SELECT
      prs_cd.store_code                             AS r_store_code,
      'CD-GPC'                                      AS r_store_name,
      'CD-GPC'                                      AS r_store_key,
      prs_cd.product_code                           AS r_product_code,
      prs_cd.description                            AS r_description,
      NULL::text                                    AS r_unit,
      prs_cd.rotation_category                      AS r_rotation_category,
      ROUND(COALESCE(prs_cd.avg_sales_month, 0), 4) AS r_avg_sales_3m,
      prs_cd.last_sale_date                         AS r_last_sale_month,
      prs_cd.first_sale_date                        AS r_first_sale_month,
      COALESCE(prs_cd.sales_qty_total, 0)           AS r_sales_qty_total,
      (SELECT month_val FROM v)                     AS r_period_month
    FROM public.product_rotation_store prs_cd
    WHERE prs_cd.store_code = '0'
  )
  SELECT
    r.r_store_code,
    r.r_store_name,
    r.r_store_key,
    r.r_product_code,
    r.r_description,
    r.r_unit,
    r.r_rotation_category,
    r.r_avg_sales_3m,
    r.r_last_sale_month,
    r.r_first_sale_month,
    r.r_sales_qty_total,
    r.r_period_month
  FROM (
    SELECT * FROM gpc_rows
    UNION ALL
    SELECT * FROM cd_rows
  ) r
  ORDER BY r.r_store_name ASC, r.r_rotation_category ASC, r.r_avg_sales_3m DESC;
$$;

-- =============================================================================
-- Permisos
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.calculate_product_rotation(date) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_rotation_report(date) TO anon, authenticated, service_role;

-- =============================================================================
-- Notificar a PostgREST que recargue el schema
-- =============================================================================

NOTIFY pgrst, 'reload schema';
