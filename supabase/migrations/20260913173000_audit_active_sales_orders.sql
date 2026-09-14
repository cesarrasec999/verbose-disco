-- Auditoría: las recomendaciones "VENTA_ACTIVA" deben provenir de órdenes de
-- venta RMS todavía abiertas (SO.StatusCode = 'A'), no de recibos de venta.
-- Las órdenes completadas ya son ventas y permanecen cubiertas por
-- VENTA_HISTORICA. Esta tabla es aditiva y no altera movimientos ni auditorías.
create table if not exists public.erp_sales_order_lines (
  order_id text not null,
  line_id integer not null,
  store_code text not null,
  order_no text,
  order_date date not null,
  status text not null,
  product_code text not null,
  sku text,
  description text,
  quantity numeric not null default 0,
  order_value numeric not null default 0,
  source_changed_at timestamptz,
  sync_run_id uuid,
  is_active boolean not null default true,
  synced_at timestamptz not null default now(),
  primary key (order_id, line_id)
);

create index if not exists idx_erp_sales_order_lines_recommendation
  on public.erp_sales_order_lines (store_code, is_active, status, order_date desc, product_code)
  include (order_value, quantity)
  where is_active and status = 'ACTIVO';

alter table public.erp_sales_order_lines enable row level security;

drop policy if exists "erp_sales_order_lines_read_authenticated" on public.erp_sales_order_lines;
create policy "erp_sales_order_lines_read_authenticated"
  on public.erp_sales_order_lines for select to authenticated using (true);

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
    where s.id = p_store_id and coalesce(s.is_active, true)
  ), excluded as materialized (
    select asi.product_id from public.audit_session_items asi where asi.session_id = p_session_id
    union
    select ni.product_id from public.cyclic_non_inventory_products ni
    where ni.is_active and ni.product_id is not null
  ), return_metrics as materialized (
    select upper(btrim(em.product_code)) as product_code,
           sum(abs(coalesce(em.value_total, 0)))::numeric as metric_value,
           sum(abs(coalesce(em.quantity, 0)))::numeric as metric_quantity
    from public.erp_movements em cross join store s
    where v_kind = 'RETORNO'
      and em.store_code = s.movement_store_key
      and em.movement_date >= (v_from::timestamp at time zone 'America/Lima')
      and em.movement_date < ((v_to + 1)::timestamp at time zone 'America/Lima')
      and em.source_type = 'RECEIPT_RETURN' and em.status = 'ACTIVO'
    group by upper(btrim(em.product_code))
  ), active_order_metrics as materialized (
    select upper(btrim(sol.product_code)) as product_code,
           sum(abs(coalesce(sol.order_value, 0)))::numeric as metric_value,
           sum(abs(coalesce(sol.quantity, 0)))::numeric as metric_quantity
    from public.erp_sales_order_lines sol cross join store s
    where v_kind = 'VENTA_ACTIVA'
      and sol.store_code = s.sales_store_key
      and sol.is_active and sol.status = 'ACTIVO'
      and sol.order_date between v_from and v_to
    group by upper(btrim(sol.product_code))
  ), sales_metrics as materialized (
    select upper(btrim(sd.product_code)) as product_code,
           sum(coalesce(sd.sales_amount, 0))::numeric as metric_value,
           sum(coalesce(sd.quantity, 0))::numeric as metric_quantity
    from public.erp_product_sales_daily sd cross join store s
    where v_kind = 'VENTA_HISTORICA'
      and sd.store_key = s.sales_store_key and sd.sales_date between v_from and v_to
    group by upper(btrim(sd.product_code))
  ), metrics as materialized (
    select * from return_metrics
    union all select * from active_order_metrics
    union all select * from sales_metrics
  ), stock as materialized (
    select upper(btrim(sg.codsap)) as product_code,
           max(sg.stock)::numeric as system_stock,
           max(sg.costo)::numeric as cost
    from public.stock_general sg cross join store s
    where sg.sede = s.sede and sg.stock > 0
    group by upper(btrim(sg.codsap))
  )
  select case v_kind
           when 'RETORNO' then 'RETORNO_NOTA_CREDITO'
           when 'VENTA_ACTIVA' then 'ORDEN_VENTA_ACTIVA_RMS'
           else 'VENTA_ULTIMO_Y_PRESENTE_MES'
         end,
         p.id, p.sku, p.barcode, p.description, p.unit,
         coalesce(nullif(st.cost, 0), p.cost, 0), st.system_stock,
         coalesce(nullif(st.cost, 0), p.cost, 0) * st.system_stock,
         m.metric_value, m.metric_quantity, v_from, v_to
  from metrics m
  join stock st on st.product_code = m.product_code
  join public.cyclic_products p on upper(btrim(p.sku)) = m.product_code and p.is_active
  left join excluded e on e.product_id = p.id
  where e.product_id is null
  order by m.metric_value desc, p.sku
  limit least(greatest(coalesce(p_limit, 51), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

grant select on public.erp_sales_order_lines to authenticated, service_role;
grant insert, update on public.erp_sales_order_lines to service_role;
grant execute on function public.get_audit_assignment_recommendations_page(uuid, uuid, text, date, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
