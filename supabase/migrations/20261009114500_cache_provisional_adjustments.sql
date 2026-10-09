-- Read model para Ajustes Provisionales.
-- La tabla ERP conserva todo el historial. Esta vista materializada es solo un
-- cache derivado del saldo vigente y se reconstruye desde erp_movements al
-- finalizar cada sincronizacion administrada por el watchdog.

create materialized view public.erp_provisional_adjustments_cache as
select
  date_trunc('year', current_date)::date as year_start,
  em.store_code::text as store_code,
  em.product_code::text as product_code,
  max(em.description)::text as description,
  max(em.unit)::text as unit,
  sum(case when em.reason = '06. INGRESOS PROVISIONALES' then em.quantity else 0 end)::double precision as qty_ajuste,
  sum(case when em.reason = '07. REGULARIZACION DE PROVISIONAL' then em.quantity else 0 end)::double precision as qty_regulariz,
  sum(em.quantity)::double precision as total_qty,
  sum(coalesce(em.value_total, 0))::double precision as total_value,
  count(*)::integer as record_count,
  max(em.movement_date) as last_date,
  (
    array_agg(
      nullif(em.adjustment_user, '')
      order by em.movement_date desc, em.updated_at desc, em.movement_key desc
    ) filter (
      where em.reason = '06. INGRESOS PROVISIONALES'
        and em.quantity > 0
        and nullif(em.adjustment_user, '') is not null
    )
  )[1]::text as last_user
from public.erp_movements em
where em.source_type = 'ADJUSTMENT'
  and em.movement_date >= date_trunc('year', current_date)::date
  and (em.reason ilike '%PROVIS%' or em.reason ilike '%REGULARIZ%')
  and em.reason in ('06. INGRESOS PROVISIONALES', '07. REGULARIZACION DE PROVISIONAL')
group by em.store_code, em.product_code
having sum(em.quantity) > 0;

create unique index erp_provisional_adjustments_cache_pk
  on public.erp_provisional_adjustments_cache (year_start, store_code, product_code);

create index erp_provisional_adjustments_cache_page
  on public.erp_provisional_adjustments_cache (last_date desc, store_code, product_code);

create or replace function public.refresh_erp_provisional_adjustments_cache()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  refreshed_rows integer;
begin
  refresh materialized view concurrently public.erp_provisional_adjustments_cache;
  select count(*)::integer into refreshed_rows
  from public.erp_provisional_adjustments_cache;
  return refreshed_rows;
end;
$$;

revoke all on function public.refresh_erp_provisional_adjustments_cache() from public;
grant execute on function public.refresh_erp_provisional_adjustments_cache() to service_role;

create or replace function public.get_ajustes_provisionales_v2(
  year_start text default null,
  p_store text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(
  store_code text,
  product_code text,
  description text,
  unit text,
  qty_ajuste double precision,
  qty_regulariz double precision,
  total_qty double precision,
  total_value double precision,
  record_count integer,
  last_date timestamp with time zone,
  last_user text,
  total_rows bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.store_code,
    c.product_code,
    c.description,
    c.unit,
    c.qty_ajuste,
    c.qty_regulariz,
    c.total_qty,
    c.total_value,
    c.record_count,
    c.last_date,
    c.last_user,
    null::bigint as total_rows
  from public.erp_provisional_adjustments_cache c
  where c.year_start = coalesce(year_start::date, date_trunc('year', current_date)::date)
    and (p_store is null or c.store_code = p_store)
    and (
      nullif(btrim(p_search), '') is null
      or c.product_code ilike '%' || btrim(p_search) || '%'
      or c.description ilike '%' || btrim(p_search) || '%'
    )
  order by c.last_date desc, c.store_code, c.product_code
  limit least(greatest(coalesce(p_limit, 100), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_ajustes_provisionales(
  year_start text default null,
  p_store text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(
  store_code text,
  product_code text,
  description text,
  unit text,
  qty_ajuste double precision,
  qty_regulariz double precision,
  total_qty double precision,
  total_value double precision,
  record_count integer,
  last_date timestamp with time zone,
  last_user text,
  total_rows bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select r.*
  from public.get_ajustes_provisionales_v2(year_start, p_store, null, p_limit, p_offset) r;
$$;

create or replace function public.get_ajustes_provisionales_store_summary(
  year_start text default null,
  p_store text default null,
  p_search text default null
)
returns table(
  store_code text,
  product_count bigint,
  qty_ajuste double precision,
  qty_regulariz double precision,
  total_qty double precision,
  total_value double precision,
  last_date timestamp with time zone
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.store_code,
    count(*)::bigint as product_count,
    sum(c.qty_ajuste)::double precision as qty_ajuste,
    sum(c.qty_regulariz)::double precision as qty_regulariz,
    sum(c.total_qty)::double precision as total_qty,
    sum(c.total_value)::double precision as total_value,
    max(c.last_date) as last_date
  from public.erp_provisional_adjustments_cache c
  where c.year_start = coalesce(year_start::date, date_trunc('year', current_date)::date)
    and (p_store is null or c.store_code = p_store)
    and (
      nullif(btrim(p_search), '') is null
      or c.product_code ilike '%' || btrim(p_search) || '%'
      or c.description ilike '%' || btrim(p_search) || '%'
    )
  group by c.store_code
  order by c.store_code;
$$;

grant execute on function public.get_ajustes_provisionales_v2(text, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.get_ajustes_provisionales(text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.get_ajustes_provisionales_store_summary(text, text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
