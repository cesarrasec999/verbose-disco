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
      case
        when regexp_replace(coalesce(s.code, ''), '\D', '', 'g') <> ''
          then regexp_replace(coalesce(s.code, ''), '\D', '', 'g')
        when upper(coalesce(s.name, '')) like 'CD-GPC%'
          then '0'
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
  stock_candidates as materialized (
    select p.id as product_id,
           p.sku::text,
           p.barcode::text,
           p.description::text,
           p.unit::text,
           coalesce(nullif(max(sg.costo), 0), p.cost::numeric, 0) as cost,
           max(sg.stock)::numeric as system_stock,
           coalesce(nullif(max(sg.costo), 0), p.cost::numeric, 0) * max(sg.stock) as inventory_value
    from store s
    join public.stock_general sg on sg.sede = s.sede and sg.stock > 0
    join public.cyclic_products p
      on p.is_active = true and upper(trim(p.sku)) = upper(trim(sg.codsap))
    left join excluded ex on ex.product_id = p.id
    left join non_inventory ni on ni.product_id = p.id
    where ex.product_id is null and ni.product_id is null
    group by p.id, p.sku, p.barcode, p.description, p.unit, p.cost
  ),
  candidates as materialized (
    select sc.product_id, sc.sku, sc.barcode, sc.description, sc.unit,
           sc.cost, sc.system_stock, sc.inventory_value,
           sb.sales_amount, sb.sales_quantity
    from stock_candidates sc
    join sales_by_code sb on sb.product_code = upper(trim(sc.sku))
    where sb.sales_amount > 0
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
