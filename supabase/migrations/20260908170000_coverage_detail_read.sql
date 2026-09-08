-- One row per positive-stock code, same population as the coverage dashboard.
CREATE OR REPLACE FUNCTION public.get_analysis_coverage_products_v2(p_store_id uuid,p_limit integer DEFAULT 500,p_offset integer DEFAULT 0)
RETURNS TABLE(sku text,stock numeric,cost numeric,description text,unit text,cyclic_sampled boolean,audit_sampled boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 WITH population AS MATERIALIZED (
  SELECT sg.codsap,sum(sg.stock) stock,sum(sg.stock*sg.costo)/nullif(sum(sg.stock),0) cost
  FROM stock_general sg JOIN stores s ON s.id=p_store_id AND sg.sede=coalesce(nullif(s.erp_sede,''),s.name)
  WHERE sg.stock>0 GROUP BY sg.codsap ORDER BY sg.codsap LIMIT least(greatest(p_limit,1),1000) OFFSET greatest(p_offset,0)
 ), sampled AS (
  SELECT p.sku,true cyclic,false audit FROM cyclic_assignments a JOIN cyclic_products p ON p.id=a.product_id
  WHERE a.store_id=p_store_id AND EXISTS(SELECT 1 FROM cyclic_counts c WHERE c.assignment_id=a.id
   AND c.location NOT IN ('__session_counting__','__session_finished__','__recount_started__','__recount_done__'))
  UNION ALL
  SELECT p.sku,false,true FROM audit_sessions s JOIN audit_session_items i ON i.session_id=s.id JOIN cyclic_products p ON p.id=i.product_id
  WHERE s.store_id=p_store_id AND s.status='finished' AND EXISTS(SELECT 1 FROM audit_counts c WHERE c.item_id=i.id)
 ), grouped AS (SELECT sku,bool_or(cyclic) cyclic,bool_or(audit) audit FROM sampled GROUP BY sku)
 SELECT pop.codsap,pop.stock,pop.cost,coalesce(p.description,'Sin descripción en maestro'),coalesce(p.unit,''),coalesce(g.cyclic,false),coalesce(g.audit,false)
 FROM population pop LEFT JOIN grouped g ON g.sku=pop.codsap
 LEFT JOIN LATERAL (SELECT cp.description,cp.unit FROM cyclic_products cp WHERE cp.sku=pop.codsap ORDER BY cp.is_active DESC,cp.id LIMIT 1) p ON true
 ORDER BY pop.codsap;
$$;
GRANT EXECUTE ON FUNCTION public.get_analysis_coverage_products_v2(uuid,integer,integer) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
