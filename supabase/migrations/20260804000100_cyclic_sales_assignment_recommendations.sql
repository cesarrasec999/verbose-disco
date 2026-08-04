-- Recomienda los codigos con mayor venta valorizada del ultimo mes calendario
-- completo, respetando stock, no inventariables y exclusiones del recomendador.
create or replace function public.get_cyclic_sales_assignment_recommendations(
  p_store_id uuid,
  p_assigned_date date default current_date,
  p_limit integer default 30
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
  sales_amount numeric,
  sales_quantity numeric,
  sales_period_start date,
  sales_period_end date
)
language plpgsql
volatile
as $$
declare
  v_from date := (date_trunc('month', coalesce(p_assigned_date, current_date)) - interval '1 month')::date;
  v_to date := (date_trunc('month', coalesce(p_assigned_date, current_date)) - interval '1 day')::date;
begin
  set local statement_timeout = '30s';

  return query
  with
  store as materialized (
    select
      s.id,
      s.erp_sede as sede,
      case when regexp_replace(coalesce(s.code, ''), '\D', '', 'g') <> ''
           then (1000 + regexp_replace(coalesce(s.code, ''), '\D', '', 'g')::integer)::text
      end as store_code_num
    from public.stores s
    where s.id = p_store_id and coalesce(s.is_active, true) = true
    limit 1
  ),
  excluded as materialized (
    select ca.product_id from public.cyclic_assignments ca
    where ca.store_id = p_store_id and ca.assigned_date = p_assigned_date
    union
    select ccp.product_id from public.cyclic_completed_products ccp
    where ccp.store_id = p_store_id
    union
    select distinct ca.product_id
    from public.cyclic_assignments ca
    join public.cyclic_counts cc on cc.assignment_id = ca.id
    where ca.store_id = p_store_id
      and ca.assigned_date >= p_assigned_date - interval '365 days'
      and ca.assigned_date < p_assigned_date
      and cc.location not in ('__session_counting__', '__session_finished__', '__recount_started__', '__recount_done__')
    union
    select distinct ca.product_id
    from public.cyclic_assignments ca
    where ca.store_id = p_store_id
      and ca.assigned_date < p_assigned_date
      and ca.assigned_date >= p_assigned_date - interval '3 days'
      and not exists (
        select 1 from public.cyclic_counts cc
        where cc.assignment_id = ca.id
          and cc.location not in ('__session_counting__', '__session_finished__', '__recount_started__', '__recount_done__')
      )
  ),
  non_inventory as materialized (
    select ni.product_id
    from public.cyclic_non_inventory_products ni
    where ni.is_active = true and ni.product_id is not null
    union
    select p.id
    from public.cyclic_products p
    join public.cyclic_non_inventory_products ni
      on ni.is_active = true and upper(trim(ni.sku)) = upper(trim(p.sku))
    where p.is_active = true
  ),
  sales_by_code as materialized (
    select upper(trim(e.product_code)) as product_code,
           round(sum(coalesce(e.sales_amount, 0)), 2) as sales_amount,
           round(sum(coalesce(e.quantity, 0)), 2) as sales_quantity
    from public.erp_product_sales_daily e
    cross join store s
    where e.store_key = s.store_code_num
      and e.sales_date between v_from and v_to
    group by upper(trim(e.product_code))
  ),
  sales_by_product as materialized (
    select coalesce(direct.id, mapped.id) as product_id,
           sum(s.sales_amount)::numeric as sales_amount,
           sum(s.sales_quantity)::numeric as sales_quantity
    from sales_by_code s
    left join lateral (
      select p.id
      from public.cyclic_products p
      where p.is_active = true and upper(trim(p.sku)) = s.product_code
      order by p.id
      limit 1
    ) direct on true
    left join lateral (
      select p.id
      from public.codigos_barra cb
      join public.cyclic_products p on p.is_active = true and upper(trim(p.sku)) = upper(trim(cb.codsap::text))
      where upper(trim(coalesce(cb.alu::text, ''))) = s.product_code
      order by p.id
      limit 1
    ) mapped on true
    where coalesce(direct.id, mapped.id) is not null
    group by coalesce(direct.id, mapped.id)
  ),
  candidates as materialized (
    select p.id as product_id,
           p.sku::text,
           p.barcode::text,
           p.description::text,
           p.unit::text,
           coalesce(nullif(sg.costo, 0), p.cost::numeric, 0) as cost,
           sg.stock::numeric as system_stock,
           coalesce(nullif(sg.costo, 0), p.cost::numeric, 0) * sg.stock as inventory_value,
           sbp.sales_amount,
           sbp.sales_quantity
    from store s
    join public.stock_general sg on sg.sede = s.sede and sg.stock > 0
    join public.cyclic_products p
      on p.is_active = true and upper(trim(p.sku)) = upper(trim(sg.codsap))
    join sales_by_product sbp on sbp.product_id = p.id and sbp.sales_amount > 0
    left join excluded ex on ex.product_id = p.id
    left join non_inventory ni on ni.product_id = p.id
    where ex.product_id is null and ni.product_id is null
  )
  select 'VENTA_ULTIMO_MES'::text,
         c.product_id, c.sku, c.barcode, c.description, c.unit, c.cost,
         c.system_stock, c.inventory_value, c.sales_amount, c.sales_quantity,
         v_from, v_to
  from candidates c
  order by c.sales_amount desc, c.sku
  limit greatest(coalesce(p_limit, 30), 0);
end;
$$;

grant execute on function public.get_cyclic_sales_assignment_recommendations(uuid, date, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
