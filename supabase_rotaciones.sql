CREATE TABLE IF NOT EXISTS public.erp_movements (
  movement_key text PRIMARY KEY,
  source_type text NOT NULL,
  source_id text,
  store_code text NOT NULL,
  movement_date timestamptz NOT NULL,
  operation text NOT NULL,
  document_no text,
  reference_document_no text,
  product_code text NOT NULL,
  description text,
  unit text,
  cost numeric(18, 6),
  quantity numeric(18, 6) NOT NULL DEFAULT 0,
  value_total numeric(18, 6),
  reason text,
  status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.erp_movements ADD COLUMN IF NOT EXISTS reference_document_no text;

CREATE INDEX IF NOT EXISTS idx_erp_movements_date ON public.erp_movements (movement_date);
CREATE INDEX IF NOT EXISTS idx_erp_movements_store_product ON public.erp_movements (store_code, product_code);
CREATE INDEX IF NOT EXISTS idx_erp_movements_operation ON public.erp_movements (operation);
CREATE INDEX IF NOT EXISTS idx_erp_movements_rotation ON public.erp_movements (store_code, operation, product_code, movement_date);
CREATE INDEX IF NOT EXISTS idx_erp_movements_reference_document ON public.erp_movements (store_code, product_code, reference_document_no);

ALTER TABLE public.cyclic_products ADD COLUMN IF NOT EXISTS product_created_at date;
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS store_created_at date;
CREATE INDEX IF NOT EXISTS idx_cyclic_products_product_created_at ON public.cyclic_products (product_created_at);
CREATE INDEX IF NOT EXISTS idx_stores_store_created_at ON public.stores (store_created_at);
CREATE INDEX IF NOT EXISTS idx_stock_general_rotation ON public.stock_general (sede, codsap);
CREATE INDEX IF NOT EXISTS idx_stock_general_rotation_product ON public.stock_general (codsap, sede);

CREATE TABLE IF NOT EXISTS public.product_sales_daily (
  sale_date date NOT NULL,
  store_code text NOT NULL,
  product_code text NOT NULL,
  sale_documents integer NOT NULL DEFAULT 0,
  sale_quantity numeric(18, 6) NOT NULL DEFAULT 0,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_date, store_code, product_code)
);

CREATE INDEX IF NOT EXISTS idx_product_sales_daily_store_product_date
  ON public.product_sales_daily (store_code, product_code, sale_date);
CREATE INDEX IF NOT EXISTS idx_product_sales_daily_product_date
  ON public.product_sales_daily (product_code, sale_date);

CREATE TABLE IF NOT EXISTS public.store_movement_history (
  store_code text PRIMARY KEY,
  first_movement_date date,
  last_movement_date date,
  calculated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_movement_history_first_movement
  ON public.store_movement_history (first_movement_date);

CREATE TABLE IF NOT EXISTS public.product_rotation_store (
  id bigserial PRIMARY KEY,
  store_code text NOT NULL,
  store_name text,
  store_profile text NOT NULL DEFAULT 'old',
  product_code text NOT NULL,
  description text,
  first_movement_date date,
  first_sale_date date,
  last_sale_date date,
  sales_qty_total numeric(18, 6) NOT NULL DEFAULT 0,
  sales_months numeric(10, 2) NOT NULL DEFAULT 12,
  avg_sales_month numeric(18, 6) NOT NULL DEFAULT 0,
  rotation_category text NOT NULL DEFAULT 'D',
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_code, product_code)
);

CREATE INDEX IF NOT EXISTS idx_product_rotation_store_category ON public.product_rotation_store (rotation_category);
CREATE INDEX IF NOT EXISTS idx_product_rotation_store_store ON public.product_rotation_store (store_code);
CREATE INDEX IF NOT EXISTS idx_product_rotation_store_product ON public.product_rotation_store (product_code);

CREATE TABLE IF NOT EXISTS public.product_rotation_summary (
  store_code text PRIMARY KEY,
  store_name text,
  store_profile text NOT NULL DEFAULT 'old',
  total_codes integer NOT NULL DEFAULT 0,
  category_a integer NOT NULL DEFAULT 0,
  category_b integer NOT NULL DEFAULT 0,
  category_c integer NOT NULL DEFAULT 0,
  category_d integer NOT NULL DEFAULT 0,
  category_nuevo integer NOT NULL DEFAULT 0,
  category_x integer NOT NULL DEFAULT 0,
  category_h integer NOT NULL DEFAULT 0,
  calculated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.refresh_product_sales_daily(
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT CURRENT_DATE,
  p_store_code text DEFAULT NULL,
  p_product_prefix text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_date date;
  v_rows integer := 0;
BEGIN
  SELECT COALESCE(p_start_date, MIN(movement_date)::date, p_end_date)
  INTO v_start_date
  FROM public.erp_movements
  WHERE operation IN ('Venta', 'Retorno')
    AND (p_store_code IS NULL OR store_code = p_store_code)
    AND (
      p_product_prefix IS NULL
      OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(product_code)) = UPPER(p_product_prefix))
      OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(product_code)) LIKE UPPER(p_product_prefix) || '%')
    );

  DELETE FROM public.product_sales_daily psd
  WHERE psd.sale_date BETWEEN v_start_date AND p_end_date
    AND (p_store_code IS NULL OR psd.store_code = p_store_code)
    AND (
      p_product_prefix IS NULL
      OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(psd.product_code)) = UPPER(p_product_prefix))
      OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(psd.product_code)) LIKE UPPER(p_product_prefix) || '%')
    );

  INSERT INTO public.product_sales_daily (
    sale_date,
    store_code,
    product_code,
    sale_documents,
    sale_quantity,
    calculated_at
  )
  WITH
  sale_docs AS (
    SELECT
      MIN(movement_date)::date AS sale_date,
      TRIM(store_code) AS store_code,
      UPPER(TRIM(product_code)) AS product_code,
      COALESCE(NULLIF(TRIM(document_no), ''), NULLIF(TRIM(source_id), ''), movement_key) AS sale_document_no,
      SUM(ABS(quantity)) AS sale_qty
    FROM public.erp_movements
    WHERE operation = 'Venta'
      AND movement_date::date BETWEEN v_start_date AND p_end_date
      AND NULLIF(TRIM(store_code), '') IS NOT NULL
      AND NULLIF(TRIM(product_code), '') IS NOT NULL
      AND (p_store_code IS NULL OR store_code = p_store_code)
      AND (
        p_product_prefix IS NULL
        OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(product_code)) = UPPER(p_product_prefix))
        OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(product_code)) LIKE UPPER(p_product_prefix) || '%')
      )
    GROUP BY TRIM(store_code), UPPER(TRIM(product_code)), COALESCE(NULLIF(TRIM(document_no), ''), NULLIF(TRIM(source_id), ''), movement_key)
  ),
  credit_docs AS (
    SELECT
      TRIM(store_code) AS store_code,
      UPPER(TRIM(product_code)) AS product_code,
      TRIM(reference_document_no) AS sale_document_no,
      SUM(ABS(quantity)) AS return_qty
    FROM public.erp_movements
    WHERE operation = 'Retorno'
      AND movement_date::date <= p_end_date
      AND NULLIF(TRIM(store_code), '') IS NOT NULL
      AND NULLIF(TRIM(product_code), '') IS NOT NULL
      AND NULLIF(TRIM(reference_document_no), '') IS NOT NULL
      AND (p_store_code IS NULL OR store_code = p_store_code)
      AND (
        p_product_prefix IS NULL
        OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(product_code)) = UPPER(p_product_prefix))
        OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(product_code)) LIKE UPPER(p_product_prefix) || '%')
      )
    GROUP BY TRIM(store_code), UPPER(TRIM(product_code)), TRIM(reference_document_no)
  ),
  net_docs AS (
    SELECT
      s.sale_date,
      s.store_code,
      s.product_code,
      s.sale_document_no,
      GREATEST(s.sale_qty - COALESCE(c.return_qty, 0), 0) AS net_qty
    FROM sale_docs s
    LEFT JOIN credit_docs c
      ON c.store_code = s.store_code
     AND c.product_code = s.product_code
     AND c.sale_document_no = s.sale_document_no
  )
  SELECT
    sale_date,
    store_code,
    product_code,
    COUNT(*) FILTER (WHERE net_qty > 0)::integer AS sale_documents,
    COALESCE(SUM(net_qty), 0) AS sale_quantity,
    now()
  FROM net_docs
  GROUP BY sale_date, store_code, product_code
  ON CONFLICT (sale_date, store_code, product_code) DO UPDATE SET
    sale_documents = EXCLUDED.sale_documents,
    sale_quantity = EXCLUDED.sale_quantity,
    calculated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_store_movement_history(
  p_store_code text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows integer := 0;
BEGIN
  INSERT INTO public.store_movement_history (
    store_code,
    first_movement_date,
    last_movement_date,
    calculated_at
  )
  SELECT
    TRIM(store_code) AS store_code,
    MIN(movement_date)::date AS first_movement_date,
    MAX(movement_date)::date AS last_movement_date,
    now()
  FROM public.erp_movements
  WHERE NULLIF(TRIM(store_code), '') IS NOT NULL
    AND (p_store_code IS NULL OR store_code = p_store_code)
  GROUP BY TRIM(store_code)
  ON CONFLICT (store_code) DO UPDATE SET
    first_movement_date = EXCLUDED.first_movement_date,
    last_movement_date = EXCLUDED.last_movement_date,
    calculated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_product_rotations(
  p_as_of date DEFAULT CURRENT_DATE,
  p_store_code text DEFAULT NULL,
  p_product_prefix text DEFAULT NULL
)
RETURNS TABLE(processed_rows integer, summary_rows integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_processed integer := 0;
  v_summary integer := 0;
BEGIN
  PERFORM public.refresh_store_movement_history(p_store_code);

  CREATE TEMP TABLE tmp_rotation ON COMMIT DROP AS
  WITH
  store_base AS (
    SELECT
      CASE
        WHEN COALESCE(s.name, s.erp_sede, '') ILIKE '%CD-GPC%' THEN '1000'
        WHEN COALESCE(s.name, s.erp_sede, '') ~* '^GPC[0-9]{3}' THEN
          (1000 + SUBSTRING(COALESCE(s.name, s.erp_sede, '') FROM '^GPC0*([0-9]+)')::integer)::text
        WHEN COALESCE(s.erp_store_no, s.code, '') ~ '^[0-9]+$' THEN
          (1000 + COALESCE(s.erp_store_no, s.code)::integer)::text
        ELSE COALESCE(s.code, s.erp_store_no, s.name, s.erp_sede)
      END AS store_code,
      COALESCE(s.name, s.erp_sede, s.code, s.erp_store_no) AS store_name,
      CASE
        WHEN COALESCE(s.name, s.erp_sede, '') ~* '^GPC0*([0-9]+)' THEN
          SUBSTRING(COALESCE(s.name, s.erp_sede, '') FROM '^GPC0*([0-9]+)')::integer
        ELSE NULL
      END AS store_number,
      s.store_created_at AS store_created_date,
      s.name,
      s.erp_sede
    FROM public.stores s
    WHERE s.is_active IS DISTINCT FROM false
  ),
  store_info AS (
    SELECT
      sb.store_code,
      sb.store_name,
      CASE
        WHEN sb.store_name ILIKE '%CENTRO DISTRIBUCION%' OR sb.store_name ILIKE '%CD-GPC%' THEN 'cd'
        WHEN sb.store_number >= 23
          AND COALESCE(smh.first_movement_date, sb.store_created_date) IS NOT NULL
          AND COALESCE(smh.first_movement_date, sb.store_created_date) > p_as_of - INTERVAL '6 months' THEN 'young'
        ELSE 'old'
      END AS store_profile,
      COALESCE(smh.first_movement_date, sb.store_created_date) AS store_start_date,
      sb.name,
      sb.erp_sede
    FROM store_base sb
    LEFT JOIN public.store_movement_history smh
      ON smh.store_code = sb.store_code
  ),
  master_scope AS (
    SELECT DISTINCT ON (si.store_code, UPPER(TRIM(sg.codsap)))
      si.store_code,
      si.store_name,
      si.store_profile,
      si.store_start_date,
      UPPER(TRIM(sg.codsap)) AS product_code,
      COALESCE(cp.description, UPPER(TRIM(sg.codsap))) AS description,
      cp.product_created_at AS product_created_date
    FROM public.stock_general sg
    JOIN store_info si
      ON TRIM(sg.sede) = TRIM(si.name)
      OR TRIM(sg.sede) = TRIM(si.erp_sede)
      OR TRIM(sg.sede) = TRIM(si.store_name)
    LEFT JOIN public.cyclic_products cp
      ON UPPER(TRIM(cp.sku)) = UPPER(TRIM(sg.codsap))
    LEFT JOIN public.cyclic_non_inventory_products ni
      ON UPPER(TRIM(ni.sku)) = UPPER(TRIM(sg.codsap))
     AND ni.is_active IS DISTINCT FROM false
    WHERE NULLIF(TRIM(sg.codsap), '') IS NOT NULL
      AND ni.id IS NULL
      AND (p_store_code IS NULL OR si.store_code = p_store_code)
      AND (
        p_product_prefix IS NULL
        OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(sg.codsap)) = UPPER(p_product_prefix))
        OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(sg.codsap)) LIKE UPPER(p_product_prefix) || '%')
      )
    ORDER BY si.store_code, UPPER(TRIM(sg.codsap)), cp.is_active DESC NULLS LAST
  ),
  all_sales AS (
    SELECT
      store_code,
      product_code,
      MIN(sale_date) AS first_sale_date,
      MAX(sale_date) AS last_sale_date
    FROM public.product_sales_daily
    WHERE (p_store_code IS NULL OR store_code = p_store_code)
      AND (
        p_product_prefix IS NULL
        OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(product_code)) = UPPER(p_product_prefix))
        OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(product_code)) LIKE UPPER(p_product_prefix) || '%')
      )
    GROUP BY store_code, product_code
  ),
  window_sales_old AS (
    SELECT
      store_code,
      product_code,
      SUM(sale_documents)::numeric AS sale_documents_365d
    FROM public.product_sales_daily
    WHERE sale_date BETWEEN p_as_of - INTERVAL '364 days' AND p_as_of
      AND (p_store_code IS NULL OR store_code = p_store_code)
      AND (
        p_product_prefix IS NULL
        OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(product_code)) = UPPER(p_product_prefix))
        OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(product_code)) LIKE UPPER(p_product_prefix) || '%')
      )
    GROUP BY store_code, product_code
  ),
  window_sales_young AS (
    SELECT
      store_code,
      product_code,
      SUM(sale_documents)::numeric AS sale_documents_90d
    FROM public.product_sales_daily
    WHERE sale_date BETWEEN p_as_of - INTERVAL '89 days' AND p_as_of
      AND (p_store_code IS NULL OR store_code = p_store_code)
      AND (
        p_product_prefix IS NULL
        OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(product_code)) = UPPER(p_product_prefix))
        OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(product_code)) LIKE UPPER(p_product_prefix) || '%')
      )
    GROUP BY store_code, product_code
  ),
  measured AS (
    SELECT
      ms.store_code,
      ms.store_name,
      ms.store_profile,
      ms.store_start_date,
      ms.product_code,
      ms.description,
      COALESCE(a.first_sale_date, ms.product_created_date) AS first_movement_date,
      a.first_sale_date,
      a.last_sale_date,
      CASE
        WHEN ms.store_profile = 'young' THEN COALESCE(wy.sale_documents_90d, 0)
        ELSE COALESCE(wo.sale_documents_365d, 0)
      END AS sales_qty_total,
      GREATEST(
        1,
        LEAST(
          CASE WHEN ms.store_profile = 'young' THEN 3 ELSE 12 END,
          (
            (DATE_PART('year', p_as_of::timestamp) - DATE_PART('year', GREATEST(
              date_trunc('month', COALESCE(ms.store_start_date, p_as_of))::date,
              date_trunc('month', (p_as_of - CASE WHEN ms.store_profile = 'young' THEN INTERVAL '89 days' ELSE INTERVAL '364 days' END))::date
            )::timestamp)) * 12
            + (DATE_PART('month', p_as_of::timestamp) - DATE_PART('month', GREATEST(
              date_trunc('month', COALESCE(ms.store_start_date, p_as_of))::date,
              date_trunc('month', (p_as_of - CASE WHEN ms.store_profile = 'young' THEN INTERVAL '89 days' ELSE INTERVAL '364 days' END))::date
            )::timestamp))
            + 1
          )
        )
      )::numeric AS sales_months,
      ms.product_created_date
    FROM master_scope ms
    LEFT JOIN all_sales a
      ON a.store_code = ms.store_code
     AND UPPER(TRIM(a.product_code)) = ms.product_code
    LEFT JOIN window_sales_old wo
      ON wo.store_code = ms.store_code
     AND UPPER(TRIM(wo.product_code)) = ms.product_code
    LEFT JOIN window_sales_young wy
      ON wy.store_code = ms.store_code
     AND UPPER(TRIM(wy.product_code)) = ms.product_code
  )
  SELECT
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
    ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) AS avg_sales_month,
    CASE
      WHEN product_created_date IS NOT NULL AND product_created_date > p_as_of - INTERVAL '30 days' THEN 'Nuevo'
      WHEN COALESCE(last_sale_date, product_created_date) IS NOT NULL
        AND COALESCE(last_sale_date, product_created_date) <= p_as_of - INTERVAL '1 year' THEN 'H'
      WHEN COALESCE(last_sale_date, product_created_date) IS NOT NULL
        AND COALESCE(last_sale_date, product_created_date) < p_as_of - INTERVAL '3 months' THEN 'X'
      WHEN store_profile = 'cd' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 30 THEN 'A'
      WHEN store_profile = 'cd' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 20 THEN 'B'
      WHEN store_profile = 'cd' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 10 THEN 'C'
      WHEN store_profile = 'young' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 4 THEN 'A'
      WHEN store_profile = 'young' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 2 THEN 'B'
      WHEN store_profile = 'young' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 1 THEN 'C'
      WHEN store_profile = 'old' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 10 THEN 'A'
      WHEN store_profile = 'old' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 6 THEN 'B'
      WHEN store_profile = 'old' AND ROUND(sales_qty_total / NULLIF(sales_months, 0), 6) >= 2 THEN 'C'
      ELSE 'D'
    END AS rotation_category
  FROM measured;

  DELETE FROM public.product_rotation_store prs
  WHERE (p_store_code IS NULL OR prs.store_code = p_store_code)
    AND (
      p_product_prefix IS NULL
      OR (LENGTH(p_product_prefix) >= 9 AND UPPER(TRIM(prs.product_code)) = UPPER(p_product_prefix))
      OR (LENGTH(p_product_prefix) < 9 AND UPPER(TRIM(prs.product_code)) LIKE UPPER(p_product_prefix) || '%')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM tmp_rotation tr
      WHERE tr.store_code = prs.store_code
        AND tr.product_code = prs.product_code
    );

  INSERT INTO public.product_rotation_store (
    store_code, store_name, store_profile, product_code, description,
    first_movement_date, first_sale_date, last_sale_date, sales_qty_total,
    sales_months, avg_sales_month, rotation_category, calculated_at
  )
  SELECT
    store_code, store_name, store_profile, product_code, description,
    first_movement_date, first_sale_date, last_sale_date, sales_qty_total,
    sales_months, avg_sales_month, rotation_category, now()
  FROM tmp_rotation
  ON CONFLICT (store_code, product_code) DO UPDATE SET
    store_name = EXCLUDED.store_name,
    store_profile = EXCLUDED.store_profile,
    description = EXCLUDED.description,
    first_movement_date = EXCLUDED.first_movement_date,
    first_sale_date = EXCLUDED.first_sale_date,
    last_sale_date = EXCLUDED.last_sale_date,
    sales_qty_total = EXCLUDED.sales_qty_total,
    sales_months = EXCLUDED.sales_months,
    avg_sales_month = EXCLUDED.avg_sales_month,
    rotation_category = EXCLUDED.rotation_category,
    calculated_at = now();

  GET DIAGNOSTICS v_processed = ROW_COUNT;

  INSERT INTO public.product_rotation_summary (
    store_code, store_name, store_profile, total_codes,
    category_a, category_b, category_c, category_d, category_nuevo, category_x, category_h,
    calculated_at
  )
  SELECT
    store_code,
    MAX(store_name),
    MAX(store_profile),
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE rotation_category = 'A')::integer,
    COUNT(*) FILTER (WHERE rotation_category = 'B')::integer,
    COUNT(*) FILTER (WHERE rotation_category = 'C')::integer,
    COUNT(*) FILTER (WHERE rotation_category = 'D')::integer,
    COUNT(*) FILTER (WHERE rotation_category = 'Nuevo')::integer,
    COUNT(*) FILTER (WHERE rotation_category = 'X')::integer,
    COUNT(*) FILTER (WHERE rotation_category = 'H')::integer,
    now()
  FROM public.product_rotation_store
  WHERE store_code IN (SELECT DISTINCT store_code FROM tmp_rotation)
  GROUP BY store_code
  ON CONFLICT (store_code) DO UPDATE SET
    store_name = EXCLUDED.store_name,
    store_profile = EXCLUDED.store_profile,
    total_codes = EXCLUDED.total_codes,
    category_a = EXCLUDED.category_a,
    category_b = EXCLUDED.category_b,
    category_c = EXCLUDED.category_c,
    category_d = EXCLUDED.category_d,
    category_nuevo = EXCLUDED.category_nuevo,
    category_x = EXCLUDED.category_x,
    category_h = EXCLUDED.category_h,
    calculated_at = now();

  GET DIAGNOSTICS v_summary = ROW_COUNT;

  RETURN QUERY SELECT v_processed, v_summary;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_erp_movement_store_codes()
RETURNS TABLE(store_code text)
LANGUAGE sql
AS $$
  WITH store_info AS (
    SELECT DISTINCT
      CASE
        WHEN COALESCE(s.name, s.erp_sede, '') ILIKE '%CD-GPC%' THEN '1000'
        WHEN COALESCE(s.name, s.erp_sede, '') ~* '^GPC[0-9]{3}' THEN
          (1000 + SUBSTRING(COALESCE(s.name, s.erp_sede, '') FROM '^GPC0*([0-9]+)')::integer)::text
        WHEN COALESCE(s.erp_store_no, s.code, '') ~ '^[0-9]+$' THEN
          (1000 + COALESCE(s.erp_store_no, s.code)::integer)::text
        ELSE COALESCE(s.code, s.erp_store_no, s.name, s.erp_sede)
      END AS store_code,
      COALESCE(s.name, s.erp_sede, s.code, s.erp_store_no) AS store_name,
      s.name,
      s.erp_sede
    FROM public.stores s
    WHERE s.is_active IS DISTINCT FROM false
  )
  SELECT DISTINCT si.store_code
  FROM public.stock_general sg
  JOIN store_info si
    ON TRIM(sg.sede) = TRIM(si.name)
    OR TRIM(sg.sede) = TRIM(si.erp_sede)
    OR TRIM(sg.sede) = TRIM(si.store_name)
  WHERE NULLIF(si.store_code, '') IS NOT NULL
  ORDER BY si.store_code;
$$;

CREATE OR REPLACE FUNCTION public.get_erp_movement_product_prefixes(p_store_code text, p_len integer DEFAULT 2)
RETURNS TABLE(product_prefix text)
LANGUAGE sql
AS $$
  WITH store_info AS (
    SELECT DISTINCT
      CASE
        WHEN COALESCE(s.name, s.erp_sede, '') ILIKE '%CD-GPC%' THEN '1000'
        WHEN COALESCE(s.name, s.erp_sede, '') ~* '^GPC[0-9]{3}' THEN
          (1000 + SUBSTRING(COALESCE(s.name, s.erp_sede, '') FROM '^GPC0*([0-9]+)')::integer)::text
        WHEN COALESCE(s.erp_store_no, s.code, '') ~ '^[0-9]+$' THEN
          (1000 + COALESCE(s.erp_store_no, s.code)::integer)::text
        ELSE COALESCE(s.code, s.erp_store_no, s.name, s.erp_sede)
      END AS store_code,
      COALESCE(s.name, s.erp_sede, s.code, s.erp_store_no) AS store_name,
      s.name,
      s.erp_sede
    FROM public.stores s
    WHERE s.is_active IS DISTINCT FROM false
  )
  SELECT DISTINCT LEFT(UPPER(TRIM(sg.codsap)), GREATEST(1, p_len))
  FROM public.stock_general sg
  JOIN store_info si
    ON TRIM(sg.sede) = TRIM(si.name)
    OR TRIM(sg.sede) = TRIM(si.erp_sede)
    OR TRIM(sg.sede) = TRIM(si.store_name)
  WHERE si.store_code = p_store_code
    AND NULLIF(TRIM(sg.codsap), '') IS NOT NULL
  ORDER BY 1;
$$;
