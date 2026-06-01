-- Recomendaciones de asignacion ciclica por valorizado.
-- Devuelve 15 codigos rotacion A y 15 codigos de otras rotaciones, calculado en SQL.

create or replace function public.get_cyclic_assignment_recommendations(
  p_store_id uuid,
  p_assigned_date date default current_date,
  p_a_limit integer default 15,
  p_other_limit integer default 15
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
language sql
stable
as $$
with target_store as (
  select
    s.id,
    s.code,
    s.name,
    s.erp_sede,
    nullif(trim(coalesce(s.erp_sede, s.name, s.code)), '') as sede
  from public.stores s
  where s.id = p_store_id
    and coalesce(s.is_active, true) = true
  limit 1
),
store_keys as (
  select upper(trim(key_value)) as store_key
  from target_store ts
  cross join lateral (
    values
      (ts.code),
      (ts.name),
      (ts.erp_sede),
      (ts.sede),
      (nullif(trim(regexp_replace(coalesce(ts.erp_sede, ts.name, ''), '^.*-\s*', '')), ''))
  ) keys(key_value)
  where nullif(trim(coalesce(key_value, '')), '') is not null
),
latest_rotation as (
  select distinct on (upper(trim(prm.product_code)))
    upper(trim(prm.product_code)) as product_code,
    upper(trim(prm.rotation_category)) as rotation_category,
    prm.period_month
  from public.product_rotation_monthly prm
  where upper(trim(prm.store_key)) in (select store_key from store_keys)
    and prm.period_month <= date_trunc('month', coalesce(p_assigned_date, current_date))::date
  order by upper(trim(prm.product_code)), prm.period_month desc
),
base as (
  select
    p.id as product_id,
    p.sku::text,
    p.barcode::text,
    p.description::text,
    p.unit::text,
    coalesce(nullif(sg.costo::numeric, 0), p.cost::numeric, 0) as cost,
    coalesce(sg.stock::numeric, 0) as system_stock,
    coalesce(nullif(sg.costo::numeric, 0), p.cost::numeric, 0) * coalesce(sg.stock::numeric, 0) as inventory_value,
    coalesce(lr.rotation_category, 'SIN ROTACION') as rotation_category,
    lr.period_month
  from target_store ts
  join public.stock_general sg
    on sg.sede = ts.sede
   and coalesce(sg.stock::numeric, 0) > 0
  join public.cyclic_products p
    on upper(trim(p.sku)) = upper(trim(sg.codsap))
   and coalesce(p.is_active, true) = true
  left join latest_rotation lr
    on lr.product_code = upper(trim(p.sku))
  where not exists (
    select 1
    from public.cyclic_non_inventory_products ni
    where ni.is_active = true
      and (
        (ni.product_id is not null and ni.product_id = p.id)
        or upper(trim(ni.sku)) = upper(trim(p.sku))
      )
  )
  and not exists (
    select 1
    from public.cyclic_assignments ca
    where ca.store_id = p_store_id
      and ca.product_id = p.id
      and ca.assigned_date = p_assigned_date
  )
  and not exists (
    select 1
    from public.cyclic_completed_products ccp
    where ccp.store_id = p_store_id
      and ccp.product_id = p.id
  )
  and not exists (
    select 1
    from public.cyclic_assignments prev
    join public.cyclic_counts cc
      on cc.assignment_id = prev.id
     and cc.location not in ('__session_counting__', '__session_finished__', '__recount_started__', '__recount_done__')
    where prev.store_id = p_store_id
      and prev.product_id = p.id
      and prev.assigned_date < p_assigned_date
  )
),
ranked as (
  select
    case when rotation_category = 'A' then 'A' else 'OTRAS' end as recommendation_group,
    base.*,
    row_number() over (
      partition by case when rotation_category = 'A' then 'A' else 'OTRAS' end
      order by inventory_value desc, system_stock desc, sku asc
    ) as rn
  from base
)
select
  recommendation_group,
  product_id,
  sku,
  barcode,
  description,
  unit,
  cost,
  system_stock,
  inventory_value,
  rotation_category,
  period_month
from ranked
where (recommendation_group = 'A' and rn <= greatest(coalesce(p_a_limit, 15), 0))
   or (recommendation_group = 'OTRAS' and rn <= greatest(coalesce(p_other_limit, 15), 0))
order by
  case recommendation_group when 'A' then 0 else 1 end,
  inventory_value desc,
  sku asc;
$$;

grant execute on function public.get_cyclic_assignment_recommendations(uuid, date, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
