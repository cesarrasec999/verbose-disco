-- Recomendaciones de asignacion ciclica por valorizado.
-- Devuelve 15 codigos de rotacion prioritaria (A; si no hay A, B; si no hay B, C)
-- y 15 codigos adicionales con mayor valorizado, sin duplicados.

create index if not exists idx_stock_general_sede_codsap
  on public.stock_general (sede, codsap);

create index if not exists idx_cyclic_products_active_sku_upper
  on public.cyclic_products (upper(trim(sku)))
  where is_active = true;

create index if not exists idx_product_rotation_monthly_lookup_upper
  on public.product_rotation_monthly (
    upper(trim(store_key)),
    upper(trim(product_code)),
    period_month desc
  );

create index if not exists idx_cyclic_assignments_store_date_product
  on public.cyclic_assignments (store_id, assigned_date, product_id);

create index if not exists idx_cyclic_assignments_store_product_date
  on public.cyclic_assignments (store_id, product_id, assigned_date);

create index if not exists idx_cyclic_counts_real_assignment
  on public.cyclic_counts (assignment_id)
  where location not in ('__session_counting__', '__session_finished__', '__recount_started__', '__recount_done__');

create index if not exists idx_cyclic_completed_products_store_product
  on public.cyclic_completed_products (store_id, product_id);

create index if not exists idx_cyclic_non_inventory_product_active
  on public.cyclic_non_inventory_products (product_id)
  where is_active = true and product_id is not null;

create index if not exists idx_cyclic_non_inventory_sku_upper_active
  on public.cyclic_non_inventory_products (upper(trim(sku)))
  where is_active = true;

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
already_assigned as materialized (
  select ca.product_id
  from public.cyclic_assignments ca
  where ca.store_id = p_store_id
    and ca.assigned_date = p_assigned_date
),
already_completed as materialized (
  select ccp.product_id
  from public.cyclic_completed_products ccp
  where ccp.store_id = p_store_id
),
already_counted_before as materialized (
  select distinct prev.product_id
  from public.cyclic_assignments prev
  where prev.store_id = p_store_id
    and prev.assigned_date < p_assigned_date
    and exists (
      select 1
      from public.cyclic_counts cc
      where cc.assignment_id = prev.id
        and cc.location not in ('__session_counting__', '__session_finished__', '__recount_started__', '__recount_done__')
    )
),
stock_candidates as materialized (
  select
    sg.codsap,
    sg.stock::numeric as system_stock,
    sg.costo::numeric as stock_cost
  from target_store ts
  join public.stock_general sg
    on sg.sede = ts.sede
  where coalesce(sg.stock::numeric, 0) > 0
),
base as (
  select
    p.id as product_id,
    p.sku::text,
    p.barcode::text,
    p.description::text,
    p.unit::text,
    coalesce(nullif(sc.stock_cost, 0), p.cost::numeric, 0) as cost,
    sc.system_stock,
    coalesce(nullif(sc.stock_cost, 0), p.cost::numeric, 0) * sc.system_stock as inventory_value,
    coalesce(rotation.rotation_category, 'SIN ROTACION') as rotation_category,
    rotation.period_month
  from stock_candidates sc
  join public.cyclic_products p
    on upper(trim(p.sku)) = upper(trim(sc.codsap))
   and coalesce(p.is_active, true) = true
  left join lateral (
    select
      upper(trim(prm.rotation_category)) as rotation_category,
      prm.period_month
    from public.product_rotation_monthly prm
    where upper(trim(prm.store_key)) in (select store_key from store_keys)
      and upper(trim(prm.product_code)) = upper(trim(p.sku))
      and prm.period_month <= date_trunc('month', coalesce(p_assigned_date, current_date))::date
    order by prm.period_month desc
    limit 1
  ) rotation on true
  left join already_assigned aa on aa.product_id = p.id
  left join already_completed ac on ac.product_id = p.id
  left join already_counted_before cb on cb.product_id = p.id
  where aa.product_id is null
    and ac.product_id is null
    and cb.product_id is null
    and not exists (
    select 1
    from public.cyclic_non_inventory_products ni
    where ni.is_active = true
      and (
        (ni.product_id is not null and ni.product_id = p.id)
        or upper(trim(ni.sku)) = upper(trim(p.sku))
      )
  )
),
priority_category as (
  select
    case
      when exists (select 1 from base where rotation_category = 'A') then 'A'
      when exists (select 1 from base where rotation_category = 'B') then 'B'
      when exists (select 1 from base where rotation_category = 'C') then 'C'
      else null
    end as rotation_category
),
priority_ranked as (
  select
    base.rotation_category as recommendation_group,
    base.*,
    row_number() over (
      order by inventory_value desc, system_stock desc, sku asc
    ) as rn
  from base
  join priority_category pc
    on base.rotation_category = pc.rotation_category
),
priority_selected as (
  select
    0 as sort_group,
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
  from priority_ranked
  where rn <= greatest(coalesce(p_a_limit, 15), 0)
),
value_ranked as (
  select
    'VALORIZADO'::text as recommendation_group,
    base.*,
    row_number() over (
      order by inventory_value desc, system_stock desc, sku asc
    ) as rn
  from base
  where not exists (
    select 1
    from priority_selected ps
    where ps.product_id = base.product_id
  )
),
value_selected as (
  select
    1 as sort_group,
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
  from value_ranked
  where rn <= greatest(coalesce(p_other_limit, 15), 0)
),
combined as (
  select * from priority_selected
  union all
  select * from value_selected
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
from combined
order by
  sort_group,
  inventory_value desc,
  sku asc;
$$;

grant execute on function public.get_cyclic_assignment_recommendations(uuid, date, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
