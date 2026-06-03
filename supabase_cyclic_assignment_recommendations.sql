-- Recomendaciones de asignacion ciclica por valorizado.
-- Devuelve 15 codigos priorizando rotacion A, B y C; si no alcanza, completa con otros valorizados.
-- Luego devuelve 15 codigos adicionales con mayor valorizado, sin duplicados.

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

create index if not exists idx_product_rotation_store_lookup_upper
  on public.product_rotation_store (
    upper(trim(store_code)),
    upper(trim(product_code))
  );

-- Indice para busqueda por store_name (necesario para el split del OR)
create index if not exists idx_product_rotation_store_name_lookup
  on public.product_rotation_store (
    upper(trim(store_name)),
    upper(trim(product_code))
  );

create index if not exists idx_cyclic_assignments_store_date_product
  on public.cyclic_assignments (store_id, assigned_date, product_id);

create index if not exists idx_cyclic_assignments_store_product_date
  on public.cyclic_assignments (store_id, product_id, assigned_date);

-- FIX: indice sin filtro parcial para que el JOIN en already_counted_before lo use
create index if not exists idx_cyclic_counts_assignment_location
  on public.cyclic_counts (assignment_id, location);

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
  select distinct upper(trim(key_value)) as store_key
  from target_store ts
  cross join lateral (
    values
      (ts.code),
      (ts.name),
      (ts.erp_sede),
      (ts.sede),
      (regexp_replace(coalesce(ts.erp_sede, ts.name, ''), '[^[:alnum:]]+', ' ', 'g')),
      (regexp_replace(coalesce(ts.name, ''), '[^[:alnum:]]+', ' ', 'g')),
      (regexp_replace(coalesce(ts.sede, ''), '[^[:alnum:]]+', ' ', 'g')),
      (nullif(trim(regexp_replace(coalesce(ts.erp_sede, ts.name, ''), '^.*-\s*', '')), '')),
      (nullif(trim(regexp_replace(regexp_replace(coalesce(ts.erp_sede, ts.name, ''), '^.*-\s*', ''), '[^[:alnum:]]+', ' ', 'g')), '')),
      (nullif(trim(regexp_replace(coalesce(ts.erp_sede, ts.name, ''), '^.*\.\s*', '')), ''))
  ) keys(key_value)
  where nullif(trim(coalesce(key_value, '')), '') is not null
),
store_codes as (
  select distinct upper(trim(code_value)) as store_code
  from target_store ts
  cross join lateral (
    values
      (ts.code),
      (regexp_replace(coalesce(ts.erp_sede, ts.name, ''), '^.*?(GPC[0-9]+).*$'::text, '\1')),
      ((1000 + nullif(regexp_replace(coalesce(ts.code, ''), '\D', '', 'g'), '')::integer)::text),
      ((1000 + nullif(substring(coalesce(ts.erp_sede, ts.name, '') from 'GPC0*([0-9]+)'), '')::integer)::text)
  ) codes(code_value)
  where nullif(trim(coalesce(code_value, '')), '') is not null
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
-- FIX: reemplaza el EXISTS correlacionado por un INNER JOIN directo
already_counted_before as materialized (
  select distinct ca.product_id
  from public.cyclic_assignments ca
  inner join public.cyclic_counts cc
    on cc.assignment_id = ca.id
  where ca.store_id = p_store_id
    and ca.assigned_date < p_assigned_date
    and cc.location not in (
      '__session_counting__',
      '__session_finished__',
      '__recount_started__',
      '__recount_done__'
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
-- FIX: separa el OR en dos ramas UNION para usar indices en cada columna
rotation_store as materialized (
  select distinct on (product_code)
    product_code,
    rotation_category
  from (
    select
      upper(trim(prs.product_code)) as product_code,
      upper(trim(prs.rotation_category)) as rotation_category,
      prs.calculated_at
    from public.product_rotation_store prs
    where upper(trim(prs.store_code)) in (select store_code from store_codes)
      and nullif(trim(prs.product_code), '') is not null
    union
    select
      upper(trim(prs.product_code)) as product_code,
      upper(trim(prs.rotation_category)) as rotation_category,
      prs.calculated_at
    from public.product_rotation_store prs
    where upper(trim(prs.store_name)) in (select store_key from store_keys)
      and nullif(trim(prs.product_code), '') is not null
  ) rs_union
  order by product_code, calculated_at desc nulls last
),
rotation_monthly as materialized (
  select distinct on (upper(trim(prm.product_code)))
    upper(trim(prm.product_code)) as product_code,
    upper(trim(prm.rotation_category)) as rotation_category,
    prm.period_month
  from public.product_rotation_monthly prm
  where upper(trim(prm.store_key)) in (select store_key from store_keys)
    and prm.period_month <= date_trunc('month', coalesce(p_assigned_date, current_date))::date
    and nullif(trim(prm.product_code), '') is not null
  order by upper(trim(prm.product_code)), prm.period_month desc
),
-- FIX: materializa base para que no se evalue dos veces (priority + value)
-- FIX: reemplaza NOT EXISTS con LEFT JOIN para non_inventory (evita subquery por fila)
base as materialized (
  select
    p.id as product_id,
    p.sku::text,
    p.barcode::text,
    p.description::text,
    p.unit::text,
    coalesce(nullif(sc.stock_cost, 0), p.cost::numeric, 0) as cost,
    sc.system_stock,
    coalesce(nullif(sc.stock_cost, 0), p.cost::numeric, 0) * sc.system_stock as inventory_value,
    coalesce(rs.rotation_category, rm.rotation_category, 'SIN ROTACION') as rotation_category,
    rm.period_month
  from stock_candidates sc
  join public.cyclic_products p
    on upper(trim(p.sku)) = upper(trim(sc.codsap))
   and coalesce(p.is_active, true) = true
  left join rotation_store rs on rs.product_code = upper(trim(p.sku))
  left join rotation_monthly rm on rm.product_code = upper(trim(p.sku))
  left join already_assigned aa on aa.product_id = p.id
  left join already_completed ac on ac.product_id = p.id
  left join already_counted_before cb on cb.product_id = p.id
  left join public.cyclic_non_inventory_products ni
    on ni.is_active = true
    and (
      (ni.product_id is not null and ni.product_id = p.id)
      or upper(trim(ni.sku)) = upper(trim(p.sku))
    )
  where aa.product_id is null
    and ac.product_id is null
    and cb.product_id is null
    and ni.id is null
),
priority_ranked as (
  select
    case
      when base.rotation_category in ('A', 'B', 'C') then base.rotation_category
      else 'OTROS'
    end as recommendation_group,
    base.*,
    row_number() over (
      order by
        case base.rotation_category
          when 'A' then 0
          when 'B' then 1
          when 'C' then 2
          else 3
        end,
        inventory_value desc,
        system_stock desc,
        sku asc
    ) as rn
  from base
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
-- FIX: reemplaza NOT EXISTS con LEFT JOIN (base ya es MATERIALIZED, es O(n) no O(n^2))
value_ranked as (
  select
    'VALORIZADO'::text as recommendation_group,
    b.product_id,
    b.sku,
    b.barcode,
    b.description,
    b.unit,
    b.cost,
    b.system_stock,
    b.inventory_value,
    b.rotation_category,
    b.period_month,
    row_number() over (
      order by b.inventory_value desc, b.system_stock desc, b.sku asc
    ) as rn
  from base b
  left join priority_selected ps on ps.product_id = b.product_id
  where ps.product_id is null
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
