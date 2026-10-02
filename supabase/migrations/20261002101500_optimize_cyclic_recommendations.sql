-- Conteo cíclico: recomendaciones rápidas y paginadas.
--
-- La versión anterior normalizaba y ordenaba toda product_rotation_store
-- (168k filas) y product_rotation_monthly (953k filas) antes de limitar a 31
-- resultados. Esta versión parte del stock positivo de una sola sede y busca
-- únicamente la última rotación mensual de cada SKU mediante el índice
-- (store_key, upper(btrim(product_code)), period_month desc).
--
-- No modifica asignaciones, conteos, productos ni rotaciones.

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
  v_kind text := upper(btrim(coalesce(p_kind, 'MIXTA')));
begin
  set local statement_timeout = '20s';

  return query
  with store as materialized (
    select coalesce(nullif(btrim(s.erp_sede), ''), nullif(btrim(s.name), ''), btrim(s.code)) as sede
    from public.stores s
    where s.id = p_store_id
      and coalesce(s.is_active, true)
  ),
  excluded as materialized (
    select ca.product_id
    from public.cyclic_assignments ca
    where ca.store_id = p_store_id
      and ca.assigned_date = p_assigned_date

    union

    select ccp.product_id
    from public.cyclic_completed_products ccp
    where ccp.store_id = p_store_id

    union

    select distinct ca.product_id
    from public.cyclic_assignments ca
    join public.cyclic_counts cc on cc.assignment_id = ca.id
    where ca.store_id = p_store_id
      and ca.assigned_date >= p_assigned_date - interval '365 days'
      and ca.assigned_date <= p_assigned_date
      and cc.location not in (
        '__session_counting__', '__session_finished__',
        '__recount_started__', '__recount_done__'
      )

    union

    select ni.product_id
    from public.cyclic_non_inventory_products ni
    where ni.is_active
      and ni.product_id is not null
  ),
  stock as materialized (
    select
      upper(btrim(sg.codsap)) as product_code,
      max(sg.stock)::numeric as system_stock,
      max(sg.costo)::numeric as stock_cost
    from public.stock_general sg
    cross join store s
    where sg.sede = s.sede
      and sg.stock > 0
      and btrim(coalesce(sg.codsap, '')) <> ''
    group by upper(btrim(sg.codsap))
  ),
  candidates as materialized (
    select
      p.id as product_id,
      p.sku,
      p.barcode,
      p.description,
      p.unit,
      coalesce(nullif(st.stock_cost, 0), p.cost, 0)::numeric as cost,
      st.system_stock,
      coalesce(nullif(st.stock_cost, 0), p.cost, 0)::numeric * st.system_stock as inventory_value,
      coalesce(rot.rotation_category, 'SIN ROTACION') as rotation_category,
      rot.period_month
    from stock st
    cross join store s
    join public.cyclic_products p
      on upper(btrim(p.sku)) = st.product_code
     and p.is_active
    left join excluded e on e.product_id = p.id
    left join lateral (
      select
        nullif(upper(btrim(prm.rotation_category)), '') as rotation_category,
        prm.period_month
      from public.product_rotation_monthly prm
      where prm.store_key = s.sede
        and upper(btrim(prm.product_code)) = st.product_code
        and prm.period_month <= date_trunc('month', p_assigned_date)::date
      order by prm.period_month desc
      limit 1
    ) rot on true
    where e.product_id is null
  ),
  selected as (
    select
      case
        when c.rotation_category in ('A', 'B', 'C') then c.rotation_category
        else 'VALORIZADO'
      end as recommendation_group,
      c.*,
      case c.rotation_category
        when 'A' then 0
        when 'B' then 1
        when 'C' then 2
        else 3
      end as priority
    from candidates c
    where v_kind = 'MIXTA'
       or (v_kind = 'NO_ABC_VALORIZADO' and c.rotation_category not in ('A', 'B', 'C'))
  )
  select
    s.recommendation_group,
    s.product_id,
    s.sku,
    s.barcode,
    s.description,
    s.unit,
    s.cost,
    s.system_stock,
    s.inventory_value,
    s.rotation_category,
    s.period_month
  from selected s
  order by
    case when v_kind = 'MIXTA' then s.priority else 0 end,
    s.inventory_value desc,
    s.sku
  limit least(greatest(coalesce(p_limit, 51), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

grant execute on function public.get_cyclic_assignment_recommendations_page(uuid, date, text, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
