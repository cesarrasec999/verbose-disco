-- Alinea la clasificación ABCD con Abastecimiento.
--
-- La ventana siempre termina en el mes cerrado solicitado y contiene sus tres
-- meses calendario más recientes. Para tiendas o códigos nuevos, el divisor no
-- se fuerza a tres: usa los meses con historia real hasta el mes cerrado,
-- ambos incluidos. Ej.: alta en junio y cierre julio = 2 meses.
-- Un código con menos de dos meses desde su creación queda SIN ROTACION. X y H
-- se determinan por meses completos sin ventas: 3 y 12, respectivamente.

CREATE INDEX IF NOT EXISTS idx_erp_movements_rotation_sales_returns_normalized
  ON public.erp_movements (upper(btrim(store_code)), upper(btrim(product_code)), movement_date)
  INCLUDE (operation, document_no, source_id, movement_key)
  WHERE operation IN ('Venta', 'Retorno');

CREATE INDEX IF NOT EXISTS idx_cyclic_products_rotation_created_active
  ON public.cyclic_products (upper(btrim(sku)), product_created_at)
  WHERE is_active IS DISTINCT FROM false;

CREATE OR REPLACE FUNCTION public.calculate_product_rotation(p_target_month date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_month date := date_trunc(
    'month',
    COALESCE(p_target_month, current_date - interval '1 month')
  )::date;
BEGIN
  -- Un ciclo cerrado ya almacenado no se vuelve a reconstruir: sus documentos
  -- se recalculan abajo solo para el promedio y la regla de clasificación.
  -- Así se evita repetir el costoso histórico completo cada vez que se corrige
  -- o consulta un período que ya quedó cerrado.
  IF NOT EXISTS (
    SELECT 1
    FROM public.product_rotation_monthly
    WHERE period_month = v_month
  ) THEN
    PERFORM public.calculate_product_rotation_net_documents(v_month);
  END IF;

  WITH store_map AS (
    SELECT
      CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        WHEN left(upper(trim(coalesce(st.erp_sede, st.name, ''))), 6) = 'GPC027' THEN '1026'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$'
          THEN (1000 + st.erp_store_no::integer)::text
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC[0-9]+'
          THEN (1000 + substring(coalesce(st.erp_sede, st.name) from '^GPC0*([0-9]+)')::integer)::text
        ELSE coalesce(st.code, st.erp_store_no, st.name, st.erp_sede)
      END AS store_code,
      coalesce(st.name, st.erp_sede, st.code, st.erp_store_no) AS store_name,
      upper(trim(regexp_replace(coalesce(st.erp_sede, st.name, ''), '^.*-\s*', ''))) AS store_key,
      smh.first_movement_date AS first_sale_date
    FROM public.stores st
    LEFT JOIN public.store_movement_history smh
      ON smh.store_code = CASE
        WHEN coalesce(st.name, st.erp_sede, '') ilike '%CD-GPC%' THEN '0'
        WHEN left(upper(trim(coalesce(st.erp_sede, st.name, ''))), 6) = 'GPC027' THEN '1026'
        WHEN coalesce(st.erp_store_no, '') ~ '^[0-9]+$'
          THEN (1000 + st.erp_store_no::integer)::text
        WHEN coalesce(st.erp_sede, st.name, '') ~* '^GPC[0-9]+'
          THEN (1000 + substring(coalesce(st.erp_sede, st.name) from '^GPC0*([0-9]+)')::integer)::text
        ELSE coalesce(st.code, st.erp_store_no, st.name, st.erp_sede)
      END
    WHERE st.is_active IS DISTINCT FROM false
  ),
  product_catalog AS (
    SELECT DISTINCT ON (upper(btrim(cp.sku)))
      upper(btrim(cp.sku)) AS product_code,
      cp.product_created_at::date AS product_created_date
    FROM public.cyclic_products cp
    WHERE cp.is_active IS DISTINCT FROM false
    ORDER BY upper(btrim(cp.sku)), cp.product_created_at NULLS LAST
  ),
  target_scope AS (
    SELECT
      prm.store_key,
      prm.store_name,
      upper(trim(prm.product_code)) AS product_code,
      sm.store_code,
      sm.first_sale_date AS store_first_sale_date,
      prm.first_sale_date AS product_first_sale_date,
      prm.last_sale_date,
      cp.product_created_at::date AS product_created_date
    FROM public.product_rotation_monthly prm
    JOIN store_map sm
      ON upper(trim(sm.store_name)) = upper(trim(prm.store_name))
    LEFT JOIN product_catalog cp
      ON cp.product_code = upper(trim(prm.product_code))
    WHERE prm.period_month = v_month
  ),
  sales_docs AS (
    SELECT
      ts.store_key,
      ts.store_name,
      ts.product_code,
      date_trunc('month', em.movement_date)::date AS sale_month,
      count(DISTINCT coalesce(nullif(trim(em.document_no), ''), nullif(trim(em.source_id), ''), em.movement_key))::numeric AS documents
    FROM target_scope ts
    JOIN public.erp_movements em
      ON trim(em.store_code) = ts.store_code
     AND upper(trim(em.product_code)) = ts.product_code
    WHERE em.operation = 'Venta'
      AND em.movement_date >= v_month - interval '2 months'
      AND em.movement_date < v_month + interval '1 month'
    GROUP BY ts.store_key, ts.store_name, ts.product_code, date_trunc('month', em.movement_date)::date
  ),
  return_docs AS (
    SELECT
      ts.store_key,
      ts.store_name,
      ts.product_code,
      date_trunc('month', em.movement_date)::date AS sale_month,
      count(DISTINCT coalesce(nullif(trim(em.document_no), ''), nullif(trim(em.source_id), ''), em.movement_key))::numeric AS documents
    FROM target_scope ts
    JOIN public.erp_movements em
      ON trim(em.store_code) = ts.store_code
     AND upper(trim(em.product_code)) = ts.product_code
    WHERE em.operation = 'Retorno'
      AND em.movement_date >= v_month - interval '2 months'
      AND em.movement_date < v_month + interval '1 month'
    GROUP BY ts.store_key, ts.store_name, ts.product_code, date_trunc('month', em.movement_date)::date
  ),
  monthly_net_documents AS (
    SELECT
      coalesce(s.store_key, r.store_key) AS store_key,
      coalesce(s.store_name, r.store_name) AS store_name,
      coalesce(s.product_code, r.product_code) AS product_code,
      greatest(coalesce(s.documents, 0) - coalesce(r.documents, 0), 0)::numeric AS net_documents
    FROM sales_docs s
    FULL JOIN return_docs r
      ON r.store_key = s.store_key
     AND r.store_name = s.store_name
     AND r.product_code = s.product_code
     AND r.sale_month = s.sale_month
  ),
  metrics AS (
    SELECT
      ts.store_key,
      ts.store_name,
      ts.product_code,
      ts.last_sale_date,
      coalesce(ts.product_created_date, ts.product_first_sale_date, ts.store_first_sale_date) AS product_start_date,
      coalesce(sum(mnd.net_documents), 0)::numeric AS net_documents,
      greatest(
        1::numeric,
        least(
          3::numeric,
          coalesce(
            (date_part('year', v_month::timestamp) - date_part('year', date_trunc('month',
              CASE
                WHEN ts.store_first_sale_date IS NULL THEN coalesce(ts.product_created_date, ts.product_first_sale_date)
                WHEN coalesce(ts.product_created_date, ts.product_first_sale_date) IS NULL THEN ts.store_first_sale_date
                ELSE greatest(ts.store_first_sale_date, coalesce(ts.product_created_date, ts.product_first_sale_date))
              END
            )::timestamp)) * 12
              + date_part('month', v_month::timestamp) - date_part('month', date_trunc('month',
                CASE
                  WHEN ts.store_first_sale_date IS NULL THEN coalesce(ts.product_created_date, ts.product_first_sale_date)
                  WHEN coalesce(ts.product_created_date, ts.product_first_sale_date) IS NULL THEN ts.store_first_sale_date
                  ELSE greatest(ts.store_first_sale_date, coalesce(ts.product_created_date, ts.product_first_sale_date))
                END
              )::timestamp)
              + 1,
            3
          )::numeric
        )
      ) AS history_months,
      greatest(
        1::numeric,
        coalesce(
          (date_part('year', v_month::timestamp) - date_part('year', date_trunc('month', coalesce(ts.product_created_date, ts.product_first_sale_date, ts.store_first_sale_date))::timestamp)) * 12
            + date_part('month', v_month::timestamp) - date_part('month', date_trunc('month', coalesce(ts.product_created_date, ts.product_first_sale_date, ts.store_first_sale_date))::timestamp)
            + 1,
          3
        )::numeric
      ) AS product_age_months
    FROM target_scope ts
    LEFT JOIN monthly_net_documents mnd
      ON mnd.store_key = ts.store_key
     AND mnd.store_name = ts.store_name
     AND mnd.product_code = ts.product_code
    GROUP BY ts.store_key, ts.store_name, ts.product_code, ts.store_first_sale_date,
      ts.product_created_date, ts.product_first_sale_date, ts.last_sale_date
  ),
  classified AS (
    SELECT
      m.*,
      m.net_documents / nullif(m.history_months, 0) AS avg_documents,
      CASE
        WHEN m.product_age_months < 2 THEN 'SIN ROTACION'
        WHEN m.last_sale_date IS NULL AND m.product_age_months >= 12 THEN 'H'
        WHEN m.last_sale_date IS NULL AND m.product_age_months >= 3 THEN 'X'
        WHEN m.last_sale_date < v_month - interval '11 months' THEN 'H'
        WHEN m.last_sale_date < v_month - interval '2 months' THEN 'X'
        WHEN m.net_documents / nullif(m.history_months, 0) >= 10 THEN 'A'
        WHEN m.net_documents / nullif(m.history_months, 0) >= 4 THEN 'B'
        WHEN m.net_documents / nullif(m.history_months, 0) >= 2 THEN 'C'
        ELSE 'D'
      END AS rotation_category
    FROM metrics m
  ),
  updated_monthly AS (
    UPDATE public.product_rotation_monthly prm
    SET
      rotation_category = c.rotation_category,
      avg_sales_documents_month = c.avg_documents,
      history_months = c.history_months,
      updated_at = now()
    FROM classified c
    WHERE prm.period_month = v_month
      AND prm.store_key = c.store_key
      AND prm.store_name = c.store_name
      AND upper(trim(prm.product_code)) = c.product_code
    RETURNING prm.store_name, prm.product_code, prm.rotation_category,
      prm.avg_sales_documents_month, prm.history_months
  )
  UPDATE public.product_rotation_store prs
  SET
    rotation_category = um.rotation_category,
    avg_sales_documents_month = um.avg_sales_documents_month,
    avg_sales_month = um.avg_sales_documents_month,
    history_months = um.history_months,
    sales_months = um.history_months,
    calculated_at = now()
  FROM updated_monthly um
  WHERE upper(trim(prs.store_name)) = upper(trim(um.store_name))
    AND upper(trim(prs.product_code)) = upper(trim(um.product_code));

  INSERT INTO public.product_rotation_summary (
    store_code, store_name, store_profile, total_codes,
    category_a, category_b, category_c, category_d, category_nuevo, category_x, category_h,
    calculated_at
  )
  SELECT
    prs.store_code,
    max(prs.store_name),
    max(prs.store_profile),
    count(*)::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'A')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'B')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'C')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'D')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'Nuevo')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'X')::integer,
    count(*) FILTER (WHERE prs.rotation_category = 'H')::integer,
    now()
  FROM public.product_rotation_store prs
  WHERE EXISTS (
    SELECT 1
    FROM public.product_rotation_monthly prm
    WHERE prm.period_month = v_month
      AND upper(trim(prm.store_name)) = upper(trim(prs.store_name))
  )
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
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_product_rotation(date) TO service_role;
NOTIFY pgrst, 'reload schema';
