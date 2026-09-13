-- Paginación completa de las recomendaciones de rotación y valorizado en
-- cíclico. No se devuelven listas masivas al navegador.
create or replace function public.get_cyclic_assignment_recommendations_page(
  p_store_id uuid,
  p_assigned_date date default current_date,
  p_kind text default 'MIXTA',
  p_limit integer default 51,
  p_offset integer default 0
)
returns table (
  recommendation_group text,
  product_id uuid,
  sku text,
  barcode text,
  description text,
  unit text,
  cost numeric,
  system_stock numeric,
  inventory_value numeric,
  rotation_category text,
  period_month date
)
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_kind text := upper(trim(coalesce(p_kind, 'MIXTA')));
begin
  set local statement_timeout = '20s';

  return query
  with store as materialized (
    select s.erp_sede as sede,
           upper(trim(coalesce(s.erp_sede, s.name, s.code))) as erp_upper,
           upper(trim(regexp_replace(coalesce(s.erp_sede, s.name, s.code), '^.*-\\s*', ''))) as short_key,
           case when regexp_replace(coalesce(s.code, ''), '\\D', '', 'g') <> ''
             then (1000 + regexp_replace(coalesce(s.code, ''), '\\D', '', 'g')::integer)::text end as store_code_num
    from public.stores s
    where s.id = p_store_id and coalesce(s.is_active, true)
  ), excluded as materialized (
    select ca.product_id from public.cyclic_assignments ca
    where ca.store_id = p_store_id and ca.assigned_date = p_assigned_date
    union select ccp.product_id from public.cyclic_completed_products ccp where ccp.store_id = p_store_id
    union
    select distinct ca.product_id
    from public.cyclic_assignments ca
    where ca.store_id = p_store_id
      and ca.assigned_date >= p_assigned_date - interval '365 days'
      and exists (select 1 from public.cyclic_counts cc where cc.assignment_id = ca.id
                    and cc.location not in ('__session_counting__','__session_finished__','__recount_started__','__recount_done__'))
    union select ni.product_id from public.cyclic_non_inventory_products ni where ni.is_active and ni.product_id is not null
  ), rot_store as materialized (
    select distinct on (upper(trim(prs.product_code))) upper(trim(prs.product_code)) as product_code,
           upper(trim(prs.rotation_category)) as rotation_category
    from public.product_rotation_store prs cross join store s
    where upper(trim(prs.store_name)) = s.erp_upper or prs.store_code = s.store_code_num
    order by upper(trim(prs.product_code)), prs.calculated_at desc nulls last
  ), rot_monthly as materialized (
    select distinct on (upper(trim(prm.product_code))) upper(trim(prm.product_code)) as product_code,
           upper(trim(prm.rotation_category)) as rotation_category, prm.period_month
    from public.product_rotation_monthly prm cross join store s
    where upper(trim(prm.store_key)) = s.short_key
      and prm.period_month <= date_trunc('month', p_assigned_date)::date
    order by upper(trim(prm.product_code)), prm.period_month desc
  ), candidates as materialized (
    select p.id as product_id, p.sku, p.barcode, p.description, p.unit,
           coalesce(nullif(max(sg.costo), 0), p.cost, 0)::numeric as cost,
           max(sg.stock)::numeric as system_stock,
           coalesce(nullif(max(sg.costo), 0), p.cost, 0)::numeric * max(sg.stock) as inventory_value,
           coalesce(rs.rotation_category, rm.rotation_category, 'SIN ROTACION') as rotation_category,
           rm.period_month
    from store s
    join public.stock_general sg on sg.sede = s.sede and sg.stock > 0
    join public.cyclic_products p on upper(trim(p.sku)) = upper(trim(sg.codsap)) and p.is_active
    left join rot_store rs on rs.product_code = upper(trim(p.sku))
    left join rot_monthly rm on rm.product_code = upper(trim(p.sku))
    left join excluded e on e.product_id = p.id
    where e.product_id is null
    group by p.id, p.sku, p.barcode, p.description, p.unit, p.cost, rs.rotation_category, rm.rotation_category, rm.period_month
  ), selected as materialized (
    select case when c.rotation_category in ('A','B','C') then c.rotation_category else 'VALORIZADO' end as recommendation_group,
           c.*,
           case when c.rotation_category = 'A' then 0 when c.rotation_category = 'B' then 1
                when c.rotation_category = 'C' then 2 else 3 end as priority
    from candidates c
    where (v_kind = 'MIXTA' or c.rotation_category not in ('A','B','C'))
  )
  select s.recommendation_group, s.product_id, s.sku, s.barcode, s.description, s.unit,
         s.cost, s.system_stock, s.inventory_value, s.rotation_category, s.period_month
  from selected s
  order by case when v_kind = 'MIXTA' then s.priority else 0 end, s.inventory_value desc, s.sku
  limit least(greatest(coalesce(p_limit, 51), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

grant execute on function public.get_cyclic_assignment_recommendations_page(uuid, date, text, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
