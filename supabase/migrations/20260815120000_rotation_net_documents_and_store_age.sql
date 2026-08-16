-- Rotaciones mensuales por documentos de venta netos.
--
-- La rotación no usa unidades vendidas: cuenta documentos de venta distintos
-- y descuenta un documento por cada nota de crédito/devolución registrada.
-- La antigüedad de la tienda se obtiene de la primera venta del ERP:
--   nueva       <= 3 meses
--   desarrollo  > 3 y <= 12 meses
--   antigua     > 12 meses
--
-- Esta migración conserva product_rotation_monthly como fuente de lectura de
-- los módulos de Análisis, Inventarios y Conteo Cíclico. Las columnas nuevas
-- permiten consultar meses históricos sin volver a leer erp_movements.

ALTER TABLE public.product_rotation_monthly
  ADD COLUMN IF NOT EXISTS store_profile text,
  ADD COLUMN IF NOT EXISTS first_sale_date date,
  ADD COLUMN IF NOT EXISTS last_sale_date date,
  ADD COLUMN IF NOT EXISTS sales_documents_total numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_sales_documents_month numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS history_months numeric(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.product_rotation_store
  ADD COLUMN IF NOT EXISTS sales_documents_total numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_sales_documents_month numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS history_months numeric(10, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_product_rotation_monthly_store_period_category
  ON public.product_rotation_monthly (store_key, period_month, rotation_category);

CREATE OR REPLACE FUNCTION public.calculate_product_rotation_net_documents(
  p_target_month date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_month date;
  v_lookback_3m date;
  v_lookback_12m date;
BEGIN
  SET LOCAL statement_timeout = '120s';

  v_month := date_trunc('month', COALESCE(p_target_month, current_date - interval '1 day'))::date;
  v_lookback_3m := v_month - interval '3 months';
  v_lookback_12m := v_month - interval '12 months';

  -- Primera y última venta real por sede. Las devoluciones no hacen que una
  -- tienda parezca antigua y no se usan para definir su fecha de apertura.
  INSERT INTO public.store_movement_history (store_code, first_movement_date, last_movement_date, calculated_at)
  SELECT trim(em.store_code), min(em.movement_date)::date, max(em.movement_date)::date, now()
  FROM public.erp_movements em
  WHERE em.operation = 'Venta'
    AND nullif(trim(em.store_code), '') IS NOT NULL
  GROUP BY trim(em.store_code)
  ON CONFLICT (store_code) DO UPDATE SET
    first_movement_date = excluded.first_movement_date,
    last_movement_date = excluded.last_movement_date,
    calculated_at = now();

  DROP TABLE IF EXISTS _rotation_net_documents_result;

  CREATE TEMP TABLE _rotation_net_documents_result ON COMMIT DROP AS
  WITH
  store_base AS (
    SELECT
      CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        -- El ERP registra Cusco con la sede 1026 aunque la etiqueta comercial
        -- sea GPC027. Se conserva explícitamente para no mezclar sus ventas.
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC027\b' THEN '1026'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$'
          THEN (1000 + st.erp_store_no::integer)::text
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC[0-9]+'
          THEN (1000 + substring(coalesce(st.erp_sede, st.name) from '^GPC0*([0-9]+)')::integer)::text
        ELSE coalesce(st.code, st.erp_store_no, st.name, st.erp_sede)
      END AS store_code,
      coalesce(st.name, st.erp_sede, st.code, st.erp_store_no) AS store_name,
      upper(trim(regexp_replace(coalesce(st.erp_sede, st.name, ''), '^.*-\s*', ''))) AS store_key,
      st.name AS store_sede,
      st.erp_sede,
      coalesce(smh.first_movement_date, min_sales.first_sale_date) AS first_sale_date
    FROM public.stores st
    LEFT JOIN public.store_movement_history smh
      ON smh.store_code = CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC027\b' THEN '1026'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$' THEN (1000 + st.erp_store_no::integer)::text
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC[0-9]+'
          THEN (1000 + substring(coalesce(st.erp_sede, st.name) from '^GPC0*([0-9]+)')::integer)::text
        ELSE coalesce(st.code, st.erp_store_no, st.name, st.erp_sede)
      END
    LEFT JOIN (
      SELECT trim(em.store_code) AS store_code, min(em.movement_date)::date AS first_sale_date
      FROM public.erp_movements em
      WHERE em.operation = 'Venta'
      GROUP BY trim(em.store_code)
    ) min_sales
      ON min_sales.store_code = CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC027\b' THEN '1026'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$' THEN (1000 + st.erp_store_no::integer)::text
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC[0-9]+'
          THEN (1000 + substring(coalesce(st.erp_sede, st.name) from '^GPC0*([0-9]+)')::integer)::text
        ELSE coalesce(st.code, st.erp_store_no, st.name, st.erp_sede)
      END
    WHERE st.is_active IS DISTINCT FROM false
  ),
  store_info AS (
    SELECT
      sb.*,
      CASE
        WHEN sb.store_code = '0' OR sb.store_name ILIKE '%CD-GPC%' THEN 'cd'
        WHEN sb.first_sale_date IS NULL THEN 'new'
        WHEN sb.first_sale_date > v_month - interval '3 months' THEN 'new'
        WHEN sb.first_sale_date > v_month - interval '12 months' THEN 'development'
        ELSE 'old'
      END AS store_profile
    FROM store_base sb
  ),
  sales_docs AS (
    SELECT
      trim(em.store_code) AS store_code,
      upper(trim(em.product_code)) AS product_code,
      date_trunc('month', em.movement_date)::date AS sale_month,
      count(DISTINCT coalesce(nullif(trim(em.document_no), ''), nullif(trim(em.source_id), ''), em.movement_key))::numeric AS sales_documents
    FROM public.erp_movements em
    WHERE em.operation = 'Venta'
      AND em.movement_date >= v_lookback_12m
      AND em.movement_date < v_month + interval '1 month'
      AND nullif(trim(em.store_code), '') IS NOT NULL
      AND nullif(trim(em.product_code), '') IS NOT NULL
    GROUP BY trim(em.store_code), upper(trim(em.product_code)), date_trunc('month', em.movement_date)::date
  ),
  return_docs AS (
    SELECT
      trim(em.store_code) AS store_code,
      upper(trim(em.product_code)) AS product_code,
      date_trunc('month', em.movement_date)::date AS sale_month,
      count(DISTINCT coalesce(nullif(trim(em.document_no), ''), nullif(trim(em.source_id), ''), em.movement_key))::numeric AS return_documents
    FROM public.erp_movements em
    WHERE em.operation = 'Retorno'
      AND em.movement_date >= v_lookback_12m
      AND em.movement_date < v_month + interval '1 month'
      AND nullif(trim(em.store_code), '') IS NOT NULL
      AND nullif(trim(em.product_code), '') IS NOT NULL
    GROUP BY trim(em.store_code), upper(trim(em.product_code)), date_trunc('month', em.movement_date)::date
  ),
  monthly_docs AS (
    SELECT
      coalesce(s.store_code, r.store_code) AS store_code,
      coalesce(s.product_code, r.product_code) AS product_code,
      coalesce(s.sale_month, r.sale_month) AS sale_month,
      greatest(coalesce(s.sales_documents, 0) - coalesce(r.return_documents, 0), 0)::numeric AS net_documents
    FROM sales_docs s
    FULL JOIN return_docs r
      ON r.store_code = s.store_code
     AND r.product_code = s.product_code
     AND r.sale_month = s.sale_month
  ),
  sales_history AS (
    SELECT
      trim(em.store_code) AS store_code,
      upper(trim(em.product_code)) AS product_code,
      min(em.movement_date)::date AS first_sale_date,
      max(em.movement_date)::date AS last_sale_date
    FROM public.erp_movements em
    WHERE em.operation = 'Venta'
      AND nullif(trim(em.store_code), '') IS NOT NULL
      AND nullif(trim(em.product_code), '') IS NOT NULL
    GROUP BY trim(em.store_code), upper(trim(em.product_code))
  ),
  stock_scope AS (
    SELECT DISTINCT
      si.store_code,
      si.store_name,
      si.store_key,
      si.store_profile,
      si.first_sale_date AS store_first_sale_date,
      upper(trim(sg.codsap)) AS product_code
    FROM public.stock_general sg
    JOIN store_info si
      ON trim(sg.sede) = trim(si.store_sede)
      OR trim(sg.sede) = trim(si.erp_sede)
      OR trim(sg.sede) = trim(si.store_name)
    LEFT JOIN public.cyclic_non_inventory_products ni
      ON upper(trim(ni.sku)) = upper(trim(sg.codsap))
     AND ni.is_active IS DISTINCT FROM false
    WHERE nullif(trim(sg.codsap), '') IS NOT NULL
      AND sg.stock > 0
      AND ni.id IS NULL
  ),
  movement_scope AS (
    SELECT DISTINCT
      si.store_code,
      si.store_name,
      si.store_key,
      si.store_profile,
      si.first_sale_date AS store_first_sale_date,
      md.product_code
    FROM monthly_docs md
    JOIN store_info si ON si.store_code = md.store_code
    WHERE md.net_documents > 0
  ),
  scope AS (
    SELECT * FROM stock_scope
    UNION
    SELECT * FROM movement_scope
  ),
  metrics AS (
    SELECT
      sc.*,
      sh.first_sale_date AS product_first_sale_date,
      sh.last_sale_date AS product_last_sale_date,
      coalesce(sum(md.net_documents) FILTER (WHERE md.sale_month >= v_lookback_3m AND md.sale_month < v_month), 0)::numeric AS net_documents_3m,
      coalesce(sum(md.net_documents), 0)::numeric AS net_documents_12m
    FROM scope sc
    LEFT JOIN sales_history sh
      ON sh.store_code = sc.store_code AND sh.product_code = sc.product_code
    LEFT JOIN monthly_docs md
      ON md.store_code = sc.store_code AND md.product_code = sc.product_code
    GROUP BY sc.store_code, sc.store_name, sc.store_key, sc.store_profile,
      sc.store_first_sale_date, sc.product_code, sh.first_sale_date, sh.last_sale_date
  ),
  calculated AS (
    SELECT
      m.*,
      cp.description,
      cp.unit,
      cp.product_created_at,
      CASE
        WHEN m.store_profile = 'new' THEN greatest(
          1::numeric,
          least(
            3::numeric,
            (date_part('year', v_month::timestamp) - date_part('year', date_trunc('month', coalesce(m.store_first_sale_date, v_month))::timestamp)) * 12
            + date_part('month', v_month::timestamp) - date_part('month', date_trunc('month', coalesce(m.store_first_sale_date, v_month))::timestamp)
          )
        )
        ELSE 3::numeric
      END AS history_months_calc
    FROM metrics m
    LEFT JOIN public.cyclic_products cp
      ON upper(trim(cp.sku)) = m.product_code
     AND cp.is_active IS DISTINCT FROM false
  )
  SELECT
    c.store_code,
    c.store_name,
    c.store_key,
    c.store_profile,
    c.product_code,
    coalesce(c.description, c.product_code) AS description,
    c.unit,
    coalesce(c.product_first_sale_date, c.product_created_at) AS first_sale_date,
    c.product_last_sale_date AS last_sale_date,
    c.net_documents_12m AS sales_documents_total,
    c.net_documents_3m / nullif(c.history_months_calc, 0) AS avg_sales_documents_month,
    c.history_months_calc AS history_months,
    CASE
      WHEN c.product_created_at >= v_month OR date_trunc('month', c.product_first_sale_date)::date = v_month THEN 'Nuevo'
      WHEN c.product_last_sale_date IS NULL OR c.product_last_sale_date < v_month - interval '12 months' THEN 'H'
      WHEN c.product_last_sale_date < v_month - interval '3 months' THEN 'X'
      WHEN c.store_profile = 'cd' AND c.net_documents_3m / nullif(c.history_months_calc, 0) >= 30 THEN 'A'
      WHEN c.store_profile = 'cd' AND c.net_documents_3m / nullif(c.history_months_calc, 0) >= 20 THEN 'B'
      WHEN c.store_profile = 'cd' AND c.net_documents_3m / nullif(c.history_months_calc, 0) >= 10 THEN 'C'
      WHEN c.store_profile IN ('new', 'development') AND c.net_documents_3m / nullif(c.history_months_calc, 0) >= 5 THEN 'A'
      WHEN c.store_profile IN ('new', 'development') AND c.net_documents_3m / nullif(c.history_months_calc, 0) >= 3 THEN 'B'
      WHEN c.store_profile IN ('new', 'development') AND c.net_documents_3m / nullif(c.history_months_calc, 0) >= 1 THEN 'C'
      WHEN c.net_documents_3m / nullif(c.history_months_calc, 0) >= 10 THEN 'A'
      WHEN c.net_documents_3m / nullif(c.history_months_calc, 0) >= 6 THEN 'B'
      WHEN c.net_documents_3m / nullif(c.history_months_calc, 0) >= 2 THEN 'C'
      ELSE 'D'
    END AS rotation_category
  FROM calculated c;

  DELETE FROM public.product_rotation_monthly prm WHERE prm.period_month = v_month;

  INSERT INTO public.product_rotation_monthly (
    period_month, store_key, store_name, product_code, description, unit,
    rotation_category, source_name, uploaded_at, updated_at, store_profile,
    first_sale_date, last_sale_date, sales_documents_total,
    avg_sales_documents_month, history_months
  )
  SELECT
    v_month, r.store_key, r.store_name, r.product_code, r.description, r.unit,
    r.rotation_category, 'calculated_net_documents', now(), now(), r.store_profile,
    r.first_sale_date, r.last_sale_date, r.sales_documents_total,
    r.avg_sales_documents_month, r.history_months
  FROM _rotation_net_documents_result r
  ON CONFLICT (period_month, store_key, product_code) DO UPDATE SET
    store_name = excluded.store_name,
    description = excluded.description,
    unit = excluded.unit,
    rotation_category = excluded.rotation_category,
    source_name = excluded.source_name,
    updated_at = now(),
    store_profile = excluded.store_profile,
    first_sale_date = excluded.first_sale_date,
    last_sale_date = excluded.last_sale_date,
    sales_documents_total = excluded.sales_documents_total,
    avg_sales_documents_month = excluded.avg_sales_documents_month,
    history_months = excluded.history_months;

  DELETE FROM public.product_rotation_store prs
  WHERE EXISTS (SELECT 1 FROM _rotation_net_documents_result r WHERE r.store_code = prs.store_code);

  INSERT INTO public.product_rotation_store (
    store_code, store_name, store_profile, product_code, description,
    first_movement_date, first_sale_date, last_sale_date, sales_qty_total,
    sales_months, avg_sales_month, rotation_category, calculated_at,
    sales_documents_total, avg_sales_documents_month, history_months
  )
  SELECT
    r.store_code, r.store_name, r.store_profile, r.product_code, r.description,
    r.first_sale_date, r.first_sale_date, r.last_sale_date, r.sales_documents_total,
    r.history_months, r.avg_sales_documents_month, r.rotation_category, now(),
    r.sales_documents_total, r.avg_sales_documents_month, r.history_months
  FROM _rotation_net_documents_result r;

  INSERT INTO public.product_rotation_summary (
    store_code, store_name, store_profile, total_codes,
    category_a, category_b, category_c, category_d, category_nuevo, category_x, category_h,
    calculated_at
  )
  SELECT
    prs.store_code, max(prs.store_name), max(prs.store_profile), count(*)::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'A')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'B')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'C')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'D')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'Nuevo')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'X')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'H')::integer,
    now()
  FROM public.product_rotation_store prs
  WHERE EXISTS (SELECT 1 FROM _rotation_net_documents_result r WHERE r.store_code = prs.store_code)
  GROUP BY prs.store_code
  ON CONFLICT (store_code) DO UPDATE SET
    store_name = excluded.store_name,
    store_profile = excluded.store_profile,
    total_codes = excluded.total_codes,
    category_a = excluded.category_a,
    category_b = excluded.category_b,
    category_c = excluded.category_c,
    category_d = excluded.category_d,
    category_nuevo = excluded.category_nuevo,
    category_x = excluded.category_x,
    category_h = excluded.category_h,
    calculated_at = now();

  -- Limpia claves históricas que dejaron los cálculos anteriores para CD y Cusco.
  DELETE FROM public.product_rotation_store WHERE store_code IN ('1000', '1027');
  DELETE FROM public.product_rotation_summary WHERE store_code IN ('1000', '1027');

  DROP TABLE IF EXISTS _rotation_net_documents_result;
END;
$$;

-- Conserva el nombre utilizado por el watchdog y por el botón del módulo.
CREATE OR REPLACE FUNCTION public.calculate_product_rotation(p_target_month date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
BEGIN
  PERFORM public.calculate_product_rotation_net_documents(p_target_month);
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_product_rotation_net_documents(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.calculate_product_rotation(date) TO service_role;

-- Reporte histórico: métricas y categoría salen del mismo registro mensual,
-- no del acumulado actual de product_rotation_store.
DROP FUNCTION IF EXISTS public.get_rotation_report(date);

CREATE OR REPLACE FUNCTION public.get_rotation_report(p_month date DEFAULT NULL)
RETURNS TABLE(
  report_store_code text,
  report_store_name text,
  report_store_key text,
  report_product_code text,
  report_description text,
  report_unit text,
  report_rotation_category text,
  report_avg_sales_3m numeric,
  report_last_sale_month date,
  report_first_sale_month date,
  report_sales_qty_total numeric,
  report_period_month date,
  report_stock numeric,
  report_cost numeric,
  report_inventory_value numeric
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH v AS (
    SELECT date_trunc('month', coalesce(p_month, current_date - interval '1 day'))::date AS month_val
  ),
  store_map AS (
    SELECT
      CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC027\b' THEN '1026'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$' THEN (1000 + st.erp_store_no::integer)::text
        ELSE (1000 + substring(coalesce(st.erp_sede, st.name) from '^GPC0*([0-9]+)')::integer)::text
      END AS store_code,
      st.name AS store_name,
      st.erp_sede,
      upper(trim(regexp_replace(coalesce(st.erp_sede, st.name, ''), '^.*-\s*', ''))) AS store_key
    FROM public.stores st
    WHERE st.is_active IS DISTINCT FROM false
      AND st.erp_sede ~ 'GPC[0-9]+'
      AND st.erp_sede NOT ILIKE '%CD-GPC%'
  ),
  rows AS (
    SELECT
      sm.store_code,
      sm.store_name,
      prm.store_key,
      prm.product_code,
      prm.description,
      prm.unit,
      prm.rotation_category,
      coalesce(prm.avg_sales_documents_month, prs.avg_sales_month, 0)::numeric AS avg_sales,
      prm.last_sale_date,
      prm.first_sale_date,
      coalesce(prm.sales_documents_total, prs.sales_qty_total, 0)::numeric AS sales_total,
      prm.period_month,
      coalesce(sum(sg.stock), 0)::numeric AS stock,
      coalesce(max(nullif(sg.costo, 0)), 0)::numeric AS cost
    FROM public.product_rotation_monthly prm
    JOIN store_map sm ON sm.store_key = prm.store_key
    LEFT JOIN public.product_rotation_store prs
      ON prs.store_code = sm.store_code AND prs.product_code = prm.product_code
    LEFT JOIN public.stock_general sg
      ON trim(sg.sede) = trim(sm.erp_sede)
     AND upper(trim(sg.codsap)) = upper(trim(prm.product_code))
    WHERE prm.period_month = (SELECT month_val FROM v)
    GROUP BY sm.store_code, sm.store_name, prm.store_key, prm.product_code,
      prm.description, prm.unit, prm.rotation_category,
      prm.avg_sales_documents_month, prs.avg_sales_month, prm.last_sale_date,
      prm.first_sale_date, prm.sales_documents_total, prs.sales_qty_total, prm.period_month
    UNION ALL
    SELECT
      '0', 'CD-GPC', prm.store_key, prm.product_code, prm.description, prm.unit,
      prm.rotation_category,
      coalesce(prm.avg_sales_documents_month, prs.avg_sales_month, 0)::numeric,
      prm.last_sale_date, prm.first_sale_date,
      coalesce(prm.sales_documents_total, prs.sales_qty_total, 0)::numeric,
      prm.period_month,
      coalesce(sum(sg.stock), 0)::numeric,
      coalesce(max(nullif(sg.costo, 0)), 0)::numeric
    FROM public.product_rotation_monthly prm
    LEFT JOIN public.product_rotation_store prs
      ON prs.store_code = '0' AND prs.product_code = prm.product_code
    LEFT JOIN public.stock_general sg
      ON trim(sg.sede) = 'CD-GPC'
     AND upper(trim(sg.codsap)) = upper(trim(prm.product_code))
    WHERE prm.period_month = (SELECT month_val FROM v)
      AND prm.store_key = 'CD-GPC'
    GROUP BY prm.store_key, prm.product_code, prm.description, prm.unit,
      prm.rotation_category, prm.avg_sales_documents_month, prs.avg_sales_month,
      prm.last_sale_date, prm.first_sale_date, prm.sales_documents_total,
      prs.sales_qty_total, prm.period_month
  )
  SELECT
    r.store_code, r.store_name, r.store_key, r.product_code, r.description,
    r.unit, r.rotation_category, round(r.avg_sales, 4), r.last_sale_date,
    r.first_sale_date, r.sales_total, r.period_month, r.stock, r.cost,
    round(r.stock * r.cost, 2)
  FROM rows r
  ORDER BY r.store_name, r.rotation_category, r.avg_sales DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_rotation_report(date) TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
