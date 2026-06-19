-- Indices necesarios

create index if not exists idx_stock_general_sede_codsap
  on public.stock_general (sede, codsap);

create index if not exists idx_cyclic_products_active_sku_upper
  on public.cyclic_products (upper(trim(sku)))
  where is_active = true;

create index if not exists idx_product_rotation_store_name_product
  on public.product_rotation_store (upper(trim(store_name)), upper(trim(product_code)));

create index if not exists idx_product_rotation_store_code_product
  on public.product_rotation_store (store_code, upper(trim(product_code)));

create index if not exists idx_product_rotation_monthly_key_product
  on public.product_rotation_monthly (upper(trim(store_key)), upper(trim(product_code)), period_month desc);

create index if not exists idx_cyclic_assignments_store_date
  on public.cyclic_assignments (store_id, assigned_date);

create index if not exists idx_cyclic_counts_assignment_real
  on public.cyclic_counts (assignment_id)
  where location not in ('__session_counting__', '__session_finished__', '__recount_started__', '__recount_done__');

create index if not exists idx_cyclic_completed_store
  on public.cyclic_completed_products (store_id, product_id);

create index if not exists idx_cyclic_non_inventory_active
  on public.cyclic_non_inventory_products (product_id)
  where is_active = true and product_id is not null;

create index if not exists idx_cyclic_non_inventory_sku_upper_active
  on public.cyclic_non_inventory_products (upper(trim(sku)))
  where is_active = true;

-- Funcion principal

create or replace function public.get_cyclic_assignment_recommendations(
  p_store_id   uuid,
  p_assigned_date date    default current_date,
  p_a_limit    integer  default 15,
  p_other_limit integer  default 15
)
returns table (
  recommendation_group text,
  product_id           uuid,
  sku                  text,
  barcode              text,
  description          text,
  unit                 text,
  cost                 numeric,
  system_stock         numeric,
  inventory_value      numeric,
  rotation_category    text,
  period_month         date
)
language plpgsql
volatile
as $$
begin
  set local statement_timeout = '30s';

  return query
  with
  -- 1. Datos de la tienda
  store as materialized (
    select
      s.erp_sede                                                              as sede,
      upper(trim(coalesce(s.erp_sede, s.name, s.code)))                      as erp_upper,
      upper(trim(regexp_replace(coalesce(s.erp_sede, s.name, s.code),
                                '^.*-\s*', '')))                              as short_key,
      case
        when regexp_replace(coalesce(s.code, ''), '\D', '', 'g') <> ''
        then (1000 + regexp_replace(coalesce(s.code, ''), '\D', '', 'g')::integer)::text
      end                                                                     as store_code_num
    from public.stores s
    where s.id = p_store_id
      and coalesce(s.is_active, true) = true
    limit 1
  ),

  -- 2. Productos excluidos (asignados hoy + completados + contados en ultimo año
  --    + asignados en los ultimos 3 dias y todavia sin contar - evita que el
  --    equipo de campo reciba el mismo codigo de nuevo si se atraso 1-2 dias
  --    en contar la asignacion anterior)
  excluded as materialized (
    select ca0.product_id from public.cyclic_assignments ca0
    where ca0.store_id = p_store_id and ca0.assigned_date = p_assigned_date
    union
    select ccp.product_id from public.cyclic_completed_products ccp
    where ccp.store_id = p_store_id
    union
    select distinct ca.product_id
    from public.cyclic_assignments ca
    join public.cyclic_counts cc on cc.assignment_id = ca.id
    where ca.store_id = p_store_id
      and ca.assigned_date >= p_assigned_date - interval '365 days'
      and ca.assigned_date <  p_assigned_date
      and cc.location not in (
            '__session_counting__', '__session_finished__',
            '__recount_started__',  '__recount_done__')
    union
    select distinct ca2.product_id
    from public.cyclic_assignments ca2
    where ca2.store_id = p_store_id
      and ca2.assigned_date <  p_assigned_date
      and ca2.assigned_date >= p_assigned_date - interval '3 days'
      and not exists (
            select 1 from public.cyclic_counts cc2
            where cc2.assignment_id = ca2.id
              and cc2.location not in (
                    '__session_counting__', '__session_finished__',
                    '__recount_started__',  '__recount_done__')
          )
  ),

  -- 3. Productos no inventariables (excluir de recomendacion)
  non_inventory as materialized (
    select ni0.product_id from public.cyclic_non_inventory_products ni0
    where ni0.is_active = true and ni0.product_id is not null
    union
    select p.id from public.cyclic_products p
    join public.cyclic_non_inventory_products ni2
      on ni2.is_active = true and upper(trim(ni2.sku)) = upper(trim(p.sku))
    where coalesce(p.is_active, true) = true
  ),

  -- 4. Rotacion desde product_rotation_store (match directo por store_name = erp_sede)
  rot_store as materialized (
    select distinct on (upper(trim(prs.product_code)))
      upper(trim(prs.product_code)) as sku_upper,
      upper(trim(prs.rotation_category)) as rotation_category
    from public.product_rotation_store prs
    cross join store s
    where upper(trim(prs.store_name)) = s.erp_upper
       or prs.store_code = s.store_code_num
    order by upper(trim(prs.product_code)), prs.calculated_at desc nulls last
  ),

  -- 5. Rotacion desde product_rotation_monthly (fallback, match por short_key)
  rot_monthly as materialized (
    select distinct on (upper(trim(prm.product_code)))
      upper(trim(prm.product_code)) as sku_upper,
      upper(trim(prm.rotation_category)) as rotation_category,
      prm.period_month
    from public.product_rotation_monthly prm
    cross join store s
    where upper(trim(prm.store_key)) = s.short_key
      and prm.period_month <= date_trunc('month', p_assigned_date)::date
    order by upper(trim(prm.product_code)), prm.period_month desc
  ),

  -- 6. Candidatos: productos en stock, no excluidos, no no-inventariables, con rotacion
  candidates as materialized (
    select
      p.id                                                                         as product_id,
      p.sku::text,
      p.barcode::text,
      p.description::text,
      p.unit::text,
      coalesce(nullif(sg.costo, 0), p.cost::numeric, 0)                           as cost,
      sg.stock::numeric                                                             as system_stock,
      coalesce(nullif(sg.costo, 0), p.cost::numeric, 0) * sg.stock                as inventory_value,
      coalesce(rs.rotation_category, rm.rotation_category, 'SIN ROTACION')        as rotation_category,
      rm.period_month
    from store s
    join public.stock_general sg
      on sg.sede = s.sede and sg.stock > 0
    join public.cyclic_products p
      on upper(trim(p.sku)) = upper(trim(sg.codsap))
     and coalesce(p.is_active, true) = true
    left join rot_store    rs on rs.sku_upper = upper(trim(p.sku))
    left join rot_monthly  rm on rm.sku_upper = upper(trim(p.sku))
    left join excluded     ex on ex.product_id = p.id
    left join non_inventory ni on ni.product_id = p.id
    where ex.product_id is null
      and ni.product_id is null
  ),

  -- 7. Grupo A/B/C: top p_a_limit por rotacion y luego por valorizado
  abc_selected as (
    select
      ranked.rotation_category                as recommendation_group,
      ranked.product_id,
      ranked.sku,
      ranked.barcode,
      ranked.description,
      ranked.unit,
      ranked.cost,
      ranked.system_stock,
      ranked.inventory_value,
      ranked.rotation_category,
      ranked.period_month
    from (
      select
        cand.product_id,
        cand.sku,
        cand.barcode,
        cand.description,
        cand.unit,
        cand.cost,
        cand.system_stock,
        cand.inventory_value,
        cand.rotation_category,
        cand.period_month,
        row_number() over (
          order by
            case cand.rotation_category when 'A' then 0 when 'B' then 1 when 'C' then 2 end,
            cand.inventory_value desc,
            cand.sku
        ) as rn
      from candidates cand
      where cand.rotation_category in ('A', 'B', 'C')
    ) ranked
    where ranked.rn <= greatest(coalesce(p_a_limit, 15), 0)
  ),

  -- 8. Grupo VALORIZADO: top p_other_limit por valorizado, sin duplicar A/B/C
  value_selected as (
    select
      'VALORIZADO'::text      as recommendation_group,
      ranked.product_id,
      ranked.sku,
      ranked.barcode,
      ranked.description,
      ranked.unit,
      ranked.cost,
      ranked.system_stock,
      ranked.inventory_value,
      ranked.rotation_category,
      ranked.period_month
    from (
      select
        cand.product_id,
        cand.sku,
        cand.barcode,
        cand.description,
        cand.unit,
        cand.cost,
        cand.system_stock,
        cand.inventory_value,
        cand.rotation_category,
        cand.period_month,
        row_number() over (order by cand.inventory_value desc, cand.sku) as rn
      from candidates cand
      left join abc_selected abc on abc.product_id = cand.product_id
      where abc.product_id is null
    ) ranked
    where ranked.rn <= greatest(coalesce(p_other_limit, 15), 0)
  )

  select combined.recommendation_group, combined.product_id, combined.sku,
         combined.barcode, combined.description, combined.unit, combined.cost,
         combined.system_stock, combined.inventory_value, combined.rotation_category,
         combined.period_month
  from (
    select 0 as grp, a.recommendation_group, a.product_id, a.sku, a.barcode,
           a.description, a.unit, a.cost, a.system_stock, a.inventory_value,
           a.rotation_category, a.period_month
    from abc_selected a
    union all
    select 1 as grp, v.recommendation_group, v.product_id, v.sku, v.barcode,
           v.description, v.unit, v.cost, v.system_stock, v.inventory_value,
           v.rotation_category, v.period_month
    from value_selected v
  ) combined
  order by combined.grp, combined.inventory_value desc, combined.sku;

end;
$$;

grant execute on function public.get_cyclic_assignment_recommendations(uuid, date, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
