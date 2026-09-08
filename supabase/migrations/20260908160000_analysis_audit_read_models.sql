-- Additive, read-only read models. No count, stock or history is rewritten.
CREATE OR REPLACE FUNCTION public.get_audit_count_totals_v2(p_session_id uuid, p_limit integer DEFAULT 500, p_offset integer DEFAULT 0)
RETURNS TABLE(item_id uuid, quantity numeric, records bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 SELECT c.item_id, sum(c.quantity),count(*) FROM audit_counts c
 WHERE c.session_id=p_session_id GROUP BY c.item_id ORDER BY c.item_id
 LIMIT least(greatest(p_limit,1),500) OFFSET greatest(p_offset,0);
$$;

CREATE OR REPLACE FUNCTION public.get_audit_count_page_v2(p_session_id uuid, p_query text DEFAULT '', p_counter_id uuid DEFAULT NULL, p_limit integer DEFAULT 51, p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid, session_id uuid, item_id uuid, product_id uuid, location text, quantity numeric, counted_at timestamptz, counted_by uuid, counted_by_name text, sku text, description text, unit text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 SELECT c.id,c.session_id,c.item_id,c.product_id,c.location,c.quantity,c.counted_at,c.counted_by,u.full_name,p.sku,p.description,p.unit
 FROM audit_counts c LEFT JOIN cyclic_products p ON p.id=c.product_id LEFT JOIN cyclic_users u ON u.id=c.counted_by
 WHERE c.session_id=p_session_id AND (p_counter_id IS NULL OR c.counted_by=p_counter_id)
 AND (btrim(p_query)='' OR concat_ws(' ',p.sku,p.description,p.unit,c.location,c.quantity::text,u.full_name) ILIKE '%'||btrim(p_query)||'%')
 ORDER BY c.counted_at DESC,c.id DESC LIMIT least(greatest(p_limit,1),101) OFFSET greatest(p_offset,0);
$$;

CREATE OR REPLACE FUNCTION public.get_analysis_coverage_v2(p_store_id uuid)
RETURNS TABLE(store_id uuid,store text,total bigint,sampled bigint,unsampled bigint,pct numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 WITH population AS MATERIALIZED (
   SELECT DISTINCT sg.codsap FROM stock_general sg JOIN stores s ON s.id=p_store_id
     AND sg.sede=coalesce(nullif(s.erp_sede,''),s.name) WHERE sg.stock>0
 ), sampled_products AS (
   SELECT p.sku FROM cyclic_assignments a JOIN cyclic_products p ON p.id=a.product_id
   WHERE a.store_id=p_store_id AND EXISTS(SELECT 1 FROM cyclic_counts c WHERE c.assignment_id=a.id
     AND c.location NOT IN ('__session_counting__','__session_finished__','__recount_started__','__recount_done__'))
   UNION
   SELECT p.sku FROM audit_sessions s JOIN audit_session_items i ON i.session_id=s.id JOIN cyclic_products p ON p.id=i.product_id
   WHERE s.store_id=p_store_id AND s.status='finished' AND EXISTS(SELECT 1 FROM audit_counts c WHERE c.item_id=i.id)
 ), totals AS (
   SELECT count(*) AS n,count(sp.sku) AS done FROM population p LEFT JOIN sampled_products sp ON sp.sku=p.codsap
 )
 SELECT s.id,s.name,t.n,t.done,t.n-t.done,CASE WHEN t.n>0 THEN t.done*100.0/t.n ELSE 0 END
 FROM stores s CROSS JOIN totals t WHERE s.id=p_store_id;
$$;

-- Compact period aggregates. The caller resolves store aliases using one shared map.
CREATE OR REPLACE FUNCTION public.get_bonus_period_sources_v2(p_month date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 SELECT jsonb_build_object(
 'sales',coalesce((SELECT jsonb_agg(x) FROM (SELECT store_key,max(store_name) AS store_name,sum(sales_amount) AS sales_amount
   FROM erp_store_sales_daily WHERE sales_date>=p_month AND sales_date<(p_month+interval '1 month') GROUP BY store_key) x),'[]'::jsonb),
 'targets',coalesce((SELECT jsonb_agg(x) FROM (SELECT store_key,target_amount,source_name,updated_at FROM erp_store_sales_targets WHERE target_month=p_month ORDER BY updated_at,store_key) x),'[]'::jsonb),
 'receipts',coalesce((SELECT jsonb_agg(x) FROM (SELECT destination_store_code,(creation_date AT TIME ZONE 'America/Lima')::date AS creation_date,erp_status,count(*) AS records
   FROM reception_requests WHERE creation_date>=p_month::timestamp AT TIME ZONE 'America/Lima'
    AND creation_date<(p_month+interval '1 month')::timestamp AT TIME ZONE 'America/Lima'
   GROUP BY destination_store_code,(creation_date AT TIME ZONE 'America/Lima')::date,erp_status) x),'[]'::jsonb),
 'losses',coalesce((SELECT jsonb_agg(x) FROM (SELECT store_code,sum(abs(value_total)) AS value_total,count(*) AS records
   FROM erp_movements WHERE movement_date>=p_month::timestamp AT TIME ZONE 'America/Lima'
    AND movement_date<(p_month+interval '1 month')::timestamp AT TIME ZONE 'America/Lima'
    AND ((source_type='ADJUSTMENT' AND reason='15. DESMEDROS') OR (source_type='SLIP_OUT' AND reason='DESMEDROS')) GROUP BY store_code) x),'[]'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.get_bonus_xd_value_v2(p_date date,p_rotation_month date,p_stores jsonb)
RETURNS TABLE(store_id uuid,inventory_value numeric,rotation_month date,snapshot_time time)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 WITH mapping AS MATERIALIZED (
  SELECT (s->>'id')::uuid id,k FROM jsonb_array_elements(p_stores) s CROSS JOIN LATERAL jsonb_array_elements_text(s->'keys') k
 ), periods AS MATERIALIZED (
  SELECT m.id,max(r.period_month) period FROM product_rotation_monthly r JOIN mapping m ON upper(btrim(r.store_key))=m.k
  WHERE r.period_month<=p_rotation_month GROUP BY m.id
 ), xd AS MATERIALIZED (
  SELECT DISTINCT m.id,r.product_code FROM product_rotation_monthly r JOIN mapping m ON upper(btrim(r.store_key))=m.k
  JOIN periods p ON p.id=m.id AND r.period_month=p.period WHERE r.rotation_category IN ('X','D')
 ), valuations AS MATERIALIZED (
  SELECT coalesce(v.store_id,m.id) id,v.product_code,v.inventory_value,v.snapshot_time
  FROM inventory_valuation_snapshot_products v LEFT JOIN mapping m ON v.store_id IS NULL AND upper(btrim(v.store_key))=m.k
  WHERE v.snapshot_date=p_date
 ), times AS (SELECT id,max(snapshot_time) t FROM valuations GROUP BY id)
 SELECT t.id,coalesce(sum(v.inventory_value) FILTER(WHERE x.product_code IS NOT NULL AND v.inventory_value>0),0),p.period,t.t
 FROM times t JOIN periods p ON p.id=t.id JOIN valuations v ON v.id=t.id AND v.snapshot_time=t.t
 LEFT JOIN xd x ON x.id=v.id AND x.product_code=v.product_code GROUP BY t.id,p.period,t.t;
$$;

GRANT EXECUTE ON FUNCTION public.get_audit_count_totals_v2(uuid,integer,integer),public.get_audit_count_page_v2(uuid,text,uuid,integer,integer),public.get_analysis_coverage_v2(uuid),public.get_bonus_period_sources_v2(date),public.get_bonus_xd_value_v2(date,date,jsonb) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
