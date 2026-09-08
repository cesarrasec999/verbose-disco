-- Exact store-key lookups use existing (date,store_key,product_code) indexes.
-- The client sends verified exact and normalized aliases, in small store batches.
CREATE OR REPLACE FUNCTION public.get_bonus_xd_value_v2(p_date date,p_rotation_month date,p_stores jsonb)
RETURNS TABLE(store_id uuid,inventory_value numeric,rotation_month date,snapshot_time time)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 WITH mapping AS MATERIALIZED (
  SELECT (s->>'id')::uuid id,ARRAY(SELECT jsonb_array_elements_text(s->'keys')) keys FROM jsonb_array_elements(p_stores) s
 ), periods AS MATERIALIZED (
  SELECT m.id,m.keys,(SELECT max(r.period_month) FROM product_rotation_monthly r WHERE r.store_key=ANY(m.keys) AND r.period_month<=p_rotation_month) period FROM mapping m
 ), valuations AS MATERIALIZED (
  SELECT m.id,v.product_code,v.inventory_value,v.snapshot_time FROM mapping m
  JOIN inventory_valuation_snapshot_products v ON v.snapshot_date=p_date AND v.store_key=ANY(m.keys)
 ), times AS (SELECT id,max(snapshot_time) t FROM valuations GROUP BY id),
 xd AS MATERIALIZED (
  SELECT DISTINCT p.id,r.product_code FROM periods p JOIN product_rotation_monthly r ON r.period_month=p.period AND r.store_key=ANY(p.keys) WHERE r.rotation_category IN ('X','D')
 )
 SELECT t.id,coalesce(sum(v.inventory_value) FILTER(WHERE x.product_code IS NOT NULL AND v.inventory_value>0),0),p.period,t.t
 FROM times t JOIN periods p ON p.id=t.id AND p.period IS NOT NULL JOIN valuations v ON v.id=t.id AND v.snapshot_time=t.t
 LEFT JOIN xd x ON x.id=v.id AND x.product_code=v.product_code GROUP BY t.id,p.period,t.t;
$$;
NOTIFY pgrst,'reload schema';
