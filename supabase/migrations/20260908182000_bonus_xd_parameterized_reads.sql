-- Keep store keys as query parameters (not a join against JSON cardinality).
-- This makes the date/store index usable on historical monthly partitions.
CREATE OR REPLACE FUNCTION public.get_bonus_xd_value_v2(p_date date,p_rotation_month date,p_stores jsonb)
RETURNS TABLE(store_id uuid,inventory_value numeric,rotation_month date,snapshot_time time)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE v_store jsonb;v_id uuid;v_keys text[];v_period date;
BEGIN
 IF jsonb_array_length(p_stores)>50 THEN RAISE EXCEPTION 'Consulta máximo 50 tiendas por lote'; END IF;
 FOR v_store IN SELECT value FROM jsonb_array_elements(p_stores) LOOP
  v_id:=(v_store->>'id')::uuid;
  v_keys:=ARRAY(SELECT jsonb_array_elements_text(v_store->'keys'));
  SELECT max(r.period_month) INTO v_period FROM product_rotation_monthly r WHERE r.store_key=ANY(v_keys) AND r.period_month<=p_rotation_month;
  IF v_period IS NULL THEN CONTINUE; END IF;
  RETURN QUERY
  WITH vals AS MATERIALIZED (
   SELECT v.product_code,v.inventory_value,v.snapshot_time FROM inventory_valuation_snapshot_products v WHERE v.snapshot_date=p_date AND v.store_key=ANY(v_keys)
  ), latest AS MATERIALIZED (SELECT max(v.snapshot_time) t FROM vals v), xd AS MATERIALIZED (
   SELECT DISTINCT r.product_code FROM product_rotation_monthly r WHERE r.period_month=v_period AND r.store_key=ANY(v_keys) AND r.rotation_category IN ('X','D')
  )
  SELECT v_id,coalesce(sum(v.inventory_value) FILTER(WHERE x.product_code IS NOT NULL AND v.inventory_value>0),0),v_period,l.t
  FROM vals v JOIN latest l ON v.snapshot_time=l.t LEFT JOIN xd x ON x.product_code=v.product_code GROUP BY l.t;
 END LOOP;
END;
$$;
NOTIFY pgrst,'reload schema';
