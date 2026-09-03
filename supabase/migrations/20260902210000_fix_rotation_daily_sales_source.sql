-- Rotaciones mensuales: la fuente de ventas para ABC es el consolidado diario
-- de RMS. El Kardex (erp_movements) se completa en segundo plano y no puede
-- decidir una rotación mientras su backfill histórico está en curso.
--
-- Para un período cerrado se toman los tres meses calendario que terminan en
-- ese período (ej. julio = mayo, junio y julio) y se dividen por los meses
-- realmente disponibles desde la apertura de la tienda / alta del producto.

CREATE INDEX IF NOT EXISTS idx_erp_product_sales_daily_rotation_period
  ON public.erp_product_sales_daily (sales_date, store_key, product_code)
  INCLUDE (documents, description, unit);

CREATE OR REPLACE FUNCTION public.calculate_product_rotation_net_documents(
  p_target_month date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_month date;
  v_period_start date;
  v_history_start date;
BEGIN
  SET LOCAL statement_timeout = '120s';

  v_month := date_trunc('month', COALESCE(p_target_month, current_date - interval '1 day'))::date;
  v_period_start := (v_month - interval '2 months')::date;
  v_history_start := (v_month - interval '12 months')::date;

  DROP TABLE IF EXISTS _rotation_daily_sales_result;

  CREATE TEMP TABLE _rotation_daily_sales_result ON COMMIT DROP AS
  WITH
  store_base AS (
    SELECT
      CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$' THEN trim(st.erp_store_no)
        ELSE trim(coalesce(st.code, st.erp_store_no, st.name, st.erp_sede))
      END AS erp_store_key,
      coalesce(st.name, st.erp_sede, st.code, st.erp_store_no) AS store_name,
      upper(trim(regexp_replace(coalesce(st.erp_sede, st.name, ''), '^.*-\\s*', ''))) AS store_key,
      st.name AS store_sede,
      st.erp_sede,
      min(sd.sales_date) AS store_first_sale_date
    FROM public.stores st
    LEFT JOIN public.erp_product_sales_daily sd
      ON trim(sd.store_key) = CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$' THEN trim(st.erp_store_no)
        ELSE trim(coalesce(st.code, st.erp_store_no, st.name, st.erp_sede))
      END
    WHERE st.is_active IS DISTINCT FROM false
    GROUP BY st.code, st.name, st.erp_sede, st.erp_store_no
  ),
  daily_docs AS (
    SELECT
      trim(sd.store_key) AS erp_store_key,
      upper(trim(sd.product_code)) AS product_code,
      date_trunc('month', sd.sales_date)::date AS sale_month,
      greatest(sum(coalesce(sd.documents, 0)), 0)::numeric AS net_documents,
      min(sd.sales_date) FILTER (WHERE coalesce(sd.documents, 0) > 0) AS first_sale_date_in_month,
      max(sd.sales_date) FILTER (WHERE coalesce(sd.documents, 0) > 0) AS last_sale_date_in_month
    FROM public.erp_product_sales_daily sd
    WHERE sd.sales_date >= v_history_start
      AND sd.sales_date < (v_month + interval '1 month')::date
      AND nullif(trim(sd.store_key), '') IS NOT NULL
      AND nullif(trim(sd.product_code), '') IS NOT NULL
    GROUP BY trim(sd.store_key), upper(trim(sd.product_code)), date_trunc('month', sd.sales_date)::date
  ),
  daily_history AS (
    SELECT
      erp_store_key,
      product_code,
      min(first_sale_date_in_month) FILTER (WHERE net_documents > 0) AS first_sale_date,
      max(last_sale_date_in_month) FILTER (WHERE net_documents > 0) AS last_sale_date
    FROM daily_docs
    GROUP BY erp_store_key, product_code
  ),
  -- Conserva la última venta histórica ya calculada sin volver a recorrer el
  -- Kardex completo. Esto hace que el cierre mensual sea rápido aun mientras
  -- el backfill de movimientos sigue ejecutándose.
  existing_history AS (
    SELECT
      upper(trim(prm.store_key)) AS store_key,
      upper(trim(prm.product_code)) AS product_code,
      min(prm.first_sale_date) AS first_sale_date,
      max(prm.last_sale_date) AS last_sale_date
    FROM public.product_rotation_monthly prm
    WHERE prm.period_month = v_month
    GROUP BY upper(trim(prm.store_key)), upper(trim(prm.product_code))
  ),
  stock_scope AS (
    SELECT DISTINCT
      sb.erp_store_key,
      sb.store_name,
      sb.store_key,
      sb.store_first_sale_date,
      upper(trim(sg.codsap)) AS product_code
    FROM public.stock_general sg
    JOIN store_base sb
      ON trim(sg.sede) = trim(sb.store_sede)
      OR trim(sg.sede) = trim(sb.erp_sede)
      OR trim(sg.sede) = trim(sb.store_name)
    LEFT JOIN public.cyclic_non_inventory_products ni
      ON upper(trim(ni.sku)) = upper(trim(sg.codsap))
     AND ni.is_active IS DISTINCT FROM false
    WHERE nullif(trim(sg.codsap), '') IS NOT NULL
      AND sg.stock > 0
      AND ni.id IS NULL
  ),
  sales_scope AS (
    SELECT DISTINCT
      sb.erp_store_key,
      sb.store_name,
      sb.store_key,
      sb.store_first_sale_date,
      dd.product_code
    FROM daily_docs dd
    JOIN store_base sb ON sb.erp_store_key = dd.erp_store_key
    WHERE dd.net_documents > 0
  ),
  scope AS (
    SELECT * FROM stock_scope
    UNION
    SELECT * FROM sales_scope
  ),
  metrics AS (
    SELECT
      sc.*,
      least(dh.first_sale_date, eh.first_sale_date) AS product_first_sale_date,
      greatest(dh.last_sale_date, eh.last_sale_date) AS product_last_sale_date,
      coalesce(sum(dd.net_documents) FILTER (
        WHERE dd.sale_month >= v_period_start AND dd.sale_month <= v_month
      ), 0)::numeric AS net_documents_3m,
      coalesce(sum(dd.net_documents), 0)::numeric AS net_documents_12m
    FROM scope sc
    LEFT JOIN daily_history dh
      ON dh.erp_store_key = sc.erp_store_key AND dh.product_code = sc.product_code
    LEFT JOIN existing_history eh
      ON eh.store_key = upper(trim(sc.store_key)) AND eh.product_code = sc.product_code
    LEFT JOIN daily_docs dd
      ON dd.erp_store_key = sc.erp_store_key AND dd.product_code = sc.product_code
    GROUP BY
      sc.erp_store_key, sc.store_name, sc.store_key, sc.store_first_sale_date, sc.product_code,
      dh.first_sale_date, dh.last_sale_date, eh.first_sale_date, eh.last_sale_date
  ),
  calculated AS (
    SELECT
      m.*,
      cp.description,
      cp.unit,
      cp.product_created_at::date AS product_created_at,
      greatest(
        coalesce(m.store_first_sale_date, v_period_start),
        coalesce(cp.product_created_at::date, m.product_first_sale_date, m.store_first_sale_date, v_period_start)
      ) AS activity_start_date
    FROM metrics m
    LEFT JOIN public.cyclic_products cp
      ON upper(trim(cp.sku)) = m.product_code
     AND cp.is_active IS DISTINCT FROM false
  ),
  classified AS (
    SELECT
      c.*,
      greatest(
        1::numeric,
        least(
          3::numeric,
          (
            (extract(year FROM v_month)::integer - extract(year FROM date_trunc('month', c.activity_start_date))::integer) * 12
            + extract(month FROM v_month)::integer - extract(month FROM date_trunc('month', c.activity_start_date))::integer
            + 1
          )::numeric
        )
      ) AS history_months_calc
    FROM calculated c
  )
  SELECT
    c.erp_store_key,
    c.store_name,
    c.store_key,
    c.product_code,
    coalesce(c.description, c.product_code) AS description,
    c.unit,
    c.product_first_sale_date AS first_sale_date,
    c.product_last_sale_date AS last_sale_date,
    c.net_documents_12m AS sales_documents_total,
    c.net_documents_3m / nullif(c.history_months_calc, 0) AS avg_sales_documents_month,
    c.history_months_calc AS history_months,
    CASE
      -- Un producto no recibe rotación hasta completar dos meses calendario.
      WHEN date_trunc('month', c.activity_start_date)::date > (v_month - interval '1 month')::date THEN 'SIN ROTACION'
      -- H requiere evidencia: última venta con un año o más, o un producto
      -- creado hace un año que nunca registró una venta.
      WHEN (c.product_last_sale_date IS NOT NULL
            AND c.product_last_sale_date < (v_month + interval '1 month' - interval '1 year')::date)
        OR (c.product_last_sale_date IS NULL
            AND c.product_created_at IS NOT NULL
            AND c.product_created_at < (v_month + interval '1 month' - interval '1 year')::date) THEN 'H'
      -- X requiere tres meses completos sin venta; si no hay venta conocida,
      -- nunca se infiere H y se mantiene en X.
      WHEN c.product_last_sale_date IS NULL
        OR c.product_last_sale_date < v_period_start THEN 'X'
      WHEN c.net_documents_3m / nullif(c.history_months_calc, 0) >= 10 THEN 'A'
      WHEN c.net_documents_3m / nullif(c.history_months_calc, 0) >= 4 THEN 'B'
      WHEN c.net_documents_3m / nullif(c.history_months_calc, 0) >= 2 THEN 'C'
      ELSE 'D'
    END AS rotation_category
  FROM classified c;

  DELETE FROM public.product_rotation_monthly
  WHERE period_month = v_month;

  INSERT INTO public.product_rotation_monthly (
    period_month, store_key, store_name, product_code, description, unit,
    rotation_category, source_name, uploaded_at, updated_at,
    store_profile, first_sale_date, last_sale_date, sales_documents_total,
    avg_sales_documents_month, history_months
  )
  SELECT
    v_month, r.store_key, r.store_name, r.product_code, r.description, r.unit,
    r.rotation_category, 'calculated_daily_sales_v2', now(), now(),
    CASE WHEN r.erp_store_key = '0' THEN 'cd' ELSE 'retail' END,
    r.first_sale_date, r.last_sale_date, r.sales_documents_total,
    r.avg_sales_documents_month, r.history_months
  FROM _rotation_daily_sales_result r
  ON CONFLICT (period_month, store_key, product_code) DO UPDATE SET
    store_name = excluded.store_name,
    description = excluded.description,
    unit = excluded.unit,
    rotation_category = excluded.rotation_category,
    source_name = excluded.source_name,
    uploaded_at = excluded.uploaded_at,
    updated_at = now(),
    store_profile = excluded.store_profile,
    first_sale_date = excluded.first_sale_date,
    last_sale_date = excluded.last_sale_date,
    sales_documents_total = excluded.sales_documents_total,
    avg_sales_documents_month = excluded.avg_sales_documents_month,
    history_months = excluded.history_months;

  DELETE FROM public.product_rotation_store prs
  WHERE EXISTS (
    SELECT 1
    FROM _rotation_daily_sales_result r
    WHERE r.store_key = prs.store_code
  );

  INSERT INTO public.product_rotation_store (
    store_code, store_name, store_profile, product_code, description,
    first_movement_date, first_sale_date, last_sale_date, sales_qty_total,
    sales_months, avg_sales_month, rotation_category, calculated_at,
    sales_documents_total, avg_sales_documents_month, history_months
  )
  SELECT
    r.store_key, r.store_name,
    CASE WHEN r.erp_store_key = '0' THEN 'cd' ELSE 'retail' END,
    r.product_code, r.description, r.first_sale_date, r.first_sale_date,
    r.last_sale_date, r.sales_documents_total, r.history_months,
    r.avg_sales_documents_month, r.rotation_category, now(),
    r.sales_documents_total, r.avg_sales_documents_month, r.history_months
  FROM _rotation_daily_sales_result r;

  INSERT INTO public.product_rotation_summary (
    store_code, store_name, store_profile, total_codes,
    category_a, category_b, category_c, category_d, category_nuevo, category_x, category_h,
    calculated_at
  )
  SELECT
    r.store_key,
    max(r.store_name),
    max(CASE WHEN r.erp_store_key = '0' THEN 'cd' ELSE 'retail' END),
    count(*)::integer,
    count(*) FILTER (WHERE r.rotation_category = 'A')::integer,
    count(*) FILTER (WHERE r.rotation_category = 'B')::integer,
    count(*) FILTER (WHERE r.rotation_category = 'C')::integer,
    count(*) FILTER (WHERE r.rotation_category = 'D')::integer,
    count(*) FILTER (WHERE r.rotation_category IN ('Nuevo', 'SIN ROTACION'))::integer,
    count(*) FILTER (WHERE r.rotation_category = 'X')::integer,
    count(*) FILTER (WHERE r.rotation_category = 'H')::integer,
    now()
  FROM _rotation_daily_sales_result r
  GROUP BY r.store_key
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
END;
$function$;

-- Todos los puntos de entrada (UI, watchdog y administración) usan la misma
-- rutina; se elimina el camino antiguo que recalculaba desde erp_movements.
CREATE OR REPLACE FUNCTION public.calculate_product_rotation(
  p_target_month date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.calculate_product_rotation_net_documents(p_target_month);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.calculate_product_rotation_net_documents(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.calculate_product_rotation(date) TO service_role;
