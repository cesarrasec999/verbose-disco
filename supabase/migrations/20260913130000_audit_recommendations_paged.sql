-- Recomendaciones de auditoría y cíclico: lecturas por página, sin tope de
-- resultados. Cada petición trae como máximo 51 filas para detectar si existe
-- otra página, mientras el usuario puede avanzar indefinidamente.
create index if not exists idx_erp_movements_recommendation_store_type_status_date_product
  on public.erp_movements (store_code, source_type, status, movement_date desc, product_code)
  include (value_total, quantity);

create index if not exists idx_erp_sales_daily_recommendation_store_date_product
  on public.erp_product_sales_daily (store_key, sales_date desc, product_code)
  include (sales_amount, quantity);

create index if not exists idx_stock_general_recommendation_sede_product
  on public.stock_general (sede, codsap)
  include (stock, costo)
  where stock > 0;

create index if not exists idx_cyclic_assignments_recommendation_store_date_product
  on public.cyclic_assignments (store_id, assigned_date, product_id);

create or replace function public.get_audit_assignment_recommendations_page(
  p_store_id uuid,
  p_session_id uuid default null,
  p_kind text default 'RETORNO',
  p_reference_date date default current_date,
  p_limit integer default 51,
  p_offset integer default 0
)
returns table (
  recommendation_type text,
  product_id uuid,
  sku text,
  barcode text,
  description text,
  unit text,
  cost numeric,
  system_stock numeric,
  inventory_value numeric,
  metric_value numeric,
  metric_quantity numeric,
  period_start date,
  period_end date
)
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_from date := (date_trunc('month', coalesce(p_reference_date, current_date)) - interval '1 month')::date;
  v_to date := coalesce(p_reference_date, current_date);
  v_kind text := upper(trim(coalesce(p_kind, 'RETORNO')));
begin
  set local statement_timeout = '20s';

  return query
  with store as materialized (
    select s.erp_sede as sede,
           coalesce(nullif(s.erp_store_no, ''), regexp_replace(coalesce(s.code, ''), '\\D', '', 'g')) as sales_store_key,
           case
             when upper(coalesce(s.name, '')) ~ 'GPC[0-9]{3}'
               then '1' || substring(upper(s.name) from 'GPC([0-9]{3})')
             when upper(coalesce(s.name, '')) = 'CD-GPC' then '0'
             else null
           end as movement_store_key
    from public.stores s
    where s.id = p_store_id
      and coalesce(s.is_active, true)
  ), excluded as materialized (
    select asi.product_id
    from public.audit_session_items asi
    where asi.session_id = p_session_id
    union
    select ni.product_id
    from public.cyclic_non_inventory_products ni
    where ni.is_active and ni.product_id is not null
  ), movement_metrics as materialized (
    select upper(btrim(em.product_code)) as product_code,
           sum(abs(coalesce(em.value_total, 0)))::numeric as metric_value,
           sum(abs(coalesce(em.quantity, 0)))::numeric as metric_quantity
    from public.erp_movements em
    cross join store s
    where v_kind in ('RETORNO', 'VENTA_ACTIVA')
      and em.store_code = s.movement_store_key
      and em.movement_date >= (v_from::timestamp at time zone 'America/Lima')
      and em.movement_date < ((v_to + 1)::timestamp at time zone 'America/Lima')
      and ((v_kind = 'RETORNO' and em.source_type = 'RECEIPT_RETURN' and em.status = 'ACTIVO')
        or (v_kind = 'VENTA_ACTIVA' and em.source_type = 'RECEIPT_SALE' and em.status = 'ACTIVO'))
    group by upper(btrim(em.product_code))
  ), sales_metrics as materialized (
    select upper(btrim(sd.product_code)) as product_code,
           sum(coalesce(sd.sales_amount, 0))::numeric as metric_value,
           sum(coalesce(sd.quantity, 0))::numeric as metric_quantity
    from public.erp_product_sales_daily sd
    cross join store s
    where v_kind = 'VENTA_HISTORICA'
      and sd.store_key = s.sales_store_key
      and sd.sales_date between v_from and v_to
    group by upper(btrim(sd.product_code))
  ), metrics as materialized (
    select * from movement_metrics
    union all
    select * from sales_metrics
  ), stock as materialized (
    select upper(btrim(sg.codsap)) as product_code,
           max(sg.stock)::numeric as system_stock,
           max(sg.costo)::numeric as cost
    from public.stock_general sg
    cross join store s
    where sg.sede = s.sede and sg.stock > 0
    group by upper(btrim(sg.codsap))
  )
  select case v_kind
           when 'RETORNO' then 'RETORNO_NOTA_CREDITO'
           when 'VENTA_ACTIVA' then 'VENTA_ACTIVA_RMS'
           else 'VENTA_ULTIMO_Y_PRESENTE_MES'
         end,
         p.id, p.sku, p.barcode, p.description, p.unit,
         coalesce(nullif(st.cost, 0), p.cost, 0), st.system_stock,
         coalesce(nullif(st.cost, 0), p.cost, 0) * st.system_stock,
         m.metric_value, m.metric_quantity, v_from, v_to
  from metrics m
  join stock st on st.product_code = m.product_code
  join public.cyclic_products p
    on upper(btrim(p.sku)) = m.product_code
   and p.is_active
  left join excluded e on e.product_id = p.id
  where e.product_id is null
  order by m.metric_value desc, p.sku
  limit least(greatest(coalesce(p_limit, 51), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.get_cyclic_sales_assignment_recommendations_page(
  p_store_id uuid,
  p_assigned_date date default current_date,
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
  sales_amount numeric,
  sales_quantity numeric,
  sales_period_start date,
  sales_period_end date
)
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_from date := (date_trunc('month', coalesce(p_assigned_date, current_date)) - interval '1 month')::date;
  v_to date := (date_trunc('month', coalesce(p_assigned_date, current_date)) - interval '1 day')::date;
begin
  set local statement_timeout = '20s';

  return query
  with store as materialized (
    select s.erp_sede as sede,
           coalesce(nullif(s.erp_store_no, ''), regexp_replace(coalesce(s.code, ''), '\\D', '', 'g')) as store_key
    from public.stores s
    where s.id = p_store_id and coalesce(s.is_active, true)
  ), excluded as materialized (
    select ca.product_id from public.cyclic_assignments ca
    where ca.store_id = p_store_id and ca.assigned_date = p_assigned_date
    union
    select ccp.product_id from public.cyclic_completed_products ccp where ccp.store_id = p_store_id
    union
    select distinct ca.product_id
    from public.cyclic_assignments ca
    where ca.store_id = p_store_id
      and ca.assigned_date >= p_assigned_date - interval '365 days'
      and exists (
        select 1 from public.cyclic_counts cc
        where cc.assignment_id = ca.id
          and cc.location not in ('__session_counting__', '__session_finished__', '__recount_started__', '__recount_done__')
      )
    union
    select ni.product_id from public.cyclic_non_inventory_products ni
    where ni.is_active and ni.product_id is not null
  ), sales as materialized (
    select upper(btrim(sd.product_code)) as product_code,
           sum(coalesce(sd.sales_amount, 0))::numeric as sales_amount,
           sum(coalesce(sd.quantity, 0))::numeric as sales_quantity
    from public.erp_product_sales_daily sd
    cross join store s
    where sd.store_key = s.store_key and sd.sales_date between v_from and v_to
    group by upper(btrim(sd.product_code))
  ), stock as materialized (
    select upper(btrim(sg.codsap)) as product_code,
           max(sg.stock)::numeric as system_stock,
           max(sg.costo)::numeric as cost
    from public.stock_general sg cross join store s
    where sg.sede = s.sede and sg.stock > 0
    group by upper(btrim(sg.codsap))
  )
  select 'VENTA_ULTIMO_MES'::text, p.id, p.sku, p.barcode, p.description, p.unit,
         coalesce(nullif(st.cost, 0), p.cost, 0), st.system_stock,
         coalesce(nullif(st.cost, 0), p.cost, 0) * st.system_stock,
         sa.sales_amount, sa.sales_quantity, v_from, v_to
  from sales sa
  join stock st on st.product_code = sa.product_code
  join public.cyclic_products p on upper(btrim(p.sku)) = sa.product_code and p.is_active
  left join excluded e on e.product_id = p.id
  where e.product_id is null and sa.sales_amount > 0
  order by sa.sales_amount desc, p.sku
  limit least(greatest(coalesce(p_limit, 51), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

grant execute on function public.get_audit_assignment_recommendations_page(uuid, uuid, text, date, integer, integer),
  public.get_cyclic_sales_assignment_recommendations_page(uuid, date, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
