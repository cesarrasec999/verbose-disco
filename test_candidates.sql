with store as materialized (
  select s.erp_sede as sede, upper(trim(coalesce(s.erp_sede,s.name,s.code))) as erp_upper,
    upper(trim(regexp_replace(coalesce(s.erp_sede,s.name,s.code),'^.*-\s*',''))) as short_key,
    case when regexp_replace(coalesce(s.code,''),'\D','','g')<>'' then (1000+regexp_replace(coalesce(s.code,''),'\D','','g')::integer)::text end as store_code_num
  from public.stores s where s.id = '0bd8ed9b-6a21-4589-9131-afbd0e794fde' limit 1
),
excluded as materialized (
  select ca.product_id from public.cyclic_assignments ca where ca.store_id='0bd8ed9b-6a21-4589-9131-afbd0e794fde' and ca.assigned_date=current_date
  union select ccp.product_id from public.cyclic_completed_products ccp where ccp.store_id='0bd8ed9b-6a21-4589-9131-afbd0e794fde'
  union select distinct ca2.product_id from public.cyclic_assignments ca2
    join public.cyclic_counts cc on cc.assignment_id=ca2.id
    where ca2.store_id='0bd8ed9b-6a21-4589-9131-afbd0e794fde' and ca2.assigned_date>=current_date-interval'365 days' and ca2.assigned_date<current_date
      and cc.location not in('__session_counting__','__session_finished__','__recount_started__','__recount_done__')
),
non_inventory as materialized (
  select ni.product_id from public.cyclic_non_inventory_products ni where ni.is_active=true and ni.product_id is not null
  union select p.id from public.cyclic_products p
    join public.cyclic_non_inventory_products ni2 on ni2.is_active=true and upper(trim(ni2.sku))=upper(trim(p.sku))
  where coalesce(p.is_active,true)=true
),
rot_store as materialized (
  select distinct on (upper(trim(prs.product_code))) upper(trim(prs.product_code)) as sku_upper, upper(trim(prs.rotation_category)) as rotation_category
  from public.product_rotation_store prs cross join store s
  where upper(trim(prs.store_name))=s.erp_upper or prs.store_code=s.store_code_num
  order by upper(trim(prs.product_code)), prs.calculated_at desc nulls last
),
rot_monthly as materialized (
  select distinct on (upper(trim(prm.product_code))) upper(trim(prm.product_code)) as sku_upper, upper(trim(prm.rotation_category)) as rotation_category, prm.period_month
  from public.product_rotation_monthly prm cross join store s
  where upper(trim(prm.store_key))=s.short_key and prm.period_month<=date_trunc('month',current_date)::date
  order by upper(trim(prm.product_code)), prm.period_month desc
),
candidates as materialized (
  select p.id as product_id, p.sku::text, p.barcode::text, p.description::text, p.unit::text,
    coalesce(nullif(sg.costo,0),p.cost::numeric,0) as cost, sg.stock::numeric as system_stock,
    coalesce(nullif(sg.costo,0),p.cost::numeric,0)*sg.stock as inventory_value,
    coalesce(rs.rotation_category,rm.rotation_category,'SIN ROTACION') as rotation_category, rm.period_month
  from store s
  join public.stock_general sg on sg.sede=s.sede and sg.stock>0
  join public.cyclic_products p on upper(trim(p.sku))=upper(trim(sg.codsap)) and coalesce(p.is_active,true)=true
  left join rot_store rs on rs.sku_upper=upper(trim(p.sku))
  left join rot_monthly rm on rm.sku_upper=upper(trim(p.sku))
  left join excluded ex on ex.product_id=p.id
  left join non_inventory ni on ni.product_id=p.id
  where ex.product_id is null and ni.product_id is null
)
select count(*) as total from candidates;
