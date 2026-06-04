-- get_rotation_report actualizado: incluye stock y costo actual de stock_general

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
  report_period_month      date,
  report_stock             numeric,
  report_cost              numeric,
  report_inventory_value   numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH v AS (
    SELECT date_trunc('month',
             COALESCE(p_month, current_date - interval '1 day')
           )::date AS month_val
  ),
  store_map AS (
    SELECT
      UPPER(TRIM(regexp_replace(st.erp_sede, '^.*-\s*', '')))             AS sm_store_key,
      (1000 + SUBSTRING(st.erp_sede FROM 'GPC0*([0-9]+)')::integer)::text AS sm_store_code,
      st.name                                                              AS sm_store_name,
      st.erp_sede                                                          AS sm_sede
    FROM public.stores st
    WHERE st.is_active IS DISTINCT FROM false
      AND st.erp_sede ~ 'GPC[0-9]+'
      AND st.erp_sede NOT ILIKE '%CD-GPC%'
  ),
  gpc_rows AS (
    SELECT
      sm.sm_store_code                                                   AS r_store_code,
      sm.sm_store_name                                                   AS r_store_name,
      prm.store_key                                                      AS r_store_key,
      prm.product_code                                                   AS r_product_code,
      COALESCE(prs.description, prm.description)                        AS r_description,
      prm.unit                                                           AS r_unit,
      prm.rotation_category                                              AS r_rotation_category,
      ROUND(COALESCE(prs.avg_sales_month, 0), 4)                        AS r_avg_sales_3m,
      prs.last_sale_date                                                 AS r_last_sale_month,
      prs.first_sale_date                                                AS r_first_sale_month,
      COALESCE(prs.sales_qty_total, 0)                                  AS r_sales_qty_total,
      prm.period_month                                                   AS r_period_month,
      COALESCE(sg.stock, 0)                                             AS r_stock,
      COALESCE(NULLIF(sg.costo, 0), 0)                                  AS r_cost,
      COALESCE(sg.stock, 0) * COALESCE(NULLIF(sg.costo, 0), 0)         AS r_inventory_value
    FROM (SELECT month_val FROM v) vv
    CROSS JOIN public.product_rotation_monthly prm
    JOIN store_map sm
      ON sm.sm_store_key = prm.store_key
    LEFT JOIN public.product_rotation_store prs
      ON prs.store_code   = sm.sm_store_code
     AND prs.product_code = prm.product_code
    LEFT JOIN public.stock_general sg
      ON trim(sg.sede)          = trim(sm.sm_sede)
     AND upper(trim(sg.codsap)) = prm.product_code
    WHERE prm.period_month = vv.month_val
      AND prm.store_key   <> 'CD-GPC'
  ),
  cd_rows AS (
    SELECT
      prs_cd.store_code                                                  AS r_store_code,
      'CD-GPC'                                                           AS r_store_name,
      'CD-GPC'                                                           AS r_store_key,
      prs_cd.product_code                                                AS r_product_code,
      prs_cd.description                                                 AS r_description,
      NULL::text                                                         AS r_unit,
      prs_cd.rotation_category                                           AS r_rotation_category,
      ROUND(COALESCE(prs_cd.avg_sales_month, 0), 4)                     AS r_avg_sales_3m,
      prs_cd.last_sale_date                                              AS r_last_sale_month,
      prs_cd.first_sale_date                                             AS r_first_sale_month,
      COALESCE(prs_cd.sales_qty_total, 0)                               AS r_sales_qty_total,
      (SELECT month_val FROM v)                                          AS r_period_month,
      COALESCE(sg_cd.stock, 0)                                          AS r_stock,
      COALESCE(NULLIF(sg_cd.costo, 0), 0)                               AS r_cost,
      COALESCE(sg_cd.stock, 0) * COALESCE(NULLIF(sg_cd.costo, 0), 0)   AS r_inventory_value
    FROM public.product_rotation_store prs_cd
    LEFT JOIN public.stock_general sg_cd
      ON trim(sg_cd.sede)          = 'CD-GPC'
     AND upper(trim(sg_cd.codsap)) = prs_cd.product_code
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
    r.r_period_month,
    r.r_stock,
    r.r_cost,
    r.r_inventory_value
  FROM (
    SELECT * FROM gpc_rows
    UNION ALL
    SELECT * FROM cd_rows
  ) r
  ORDER BY r.r_store_name ASC, r.r_rotation_category ASC, r.r_avg_sales_3m DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_rotation_report(date) TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
