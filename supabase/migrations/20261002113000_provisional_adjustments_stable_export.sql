-- Orden estable para recorrer todos los pendientes por páginas.
-- store_code completa la clave de orden cuando varias tiendas tienen el mismo
-- producto y fecha; así OFFSET nunca repite ni omite una fila entre llamadas.

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
  with base as materialized (
    select
      em.store_code::text,
      em.product_code::text,
      max(em.description)::text as description,
      max(em.unit)::text as unit,
      sum(case when em.reason ilike '%REGULARIZ%' then 0 else em.quantity end)::double precision as qty_ajuste,
      sum(case when em.reason ilike '%REGULARIZ%' then em.quantity else 0 end)::double precision as qty_regulariz,
      sum(em.quantity)::double precision as total_qty,
      sum(coalesce(em.value_total, 0))::double precision as total_value,
      count(*)::integer as record_count,
      max(em.movement_date) as last_date
    from public.erp_movements em
    where em.source_type = 'ADJUSTMENT'
      and em.movement_date >= coalesce(year_start::date, date_trunc('year', current_date)::date)
      and (em.reason ilike '%PROVIS%' or em.reason ilike '%REGULARIZ%')
      and (p_store is null or em.store_code = p_store)
      and (
        nullif(btrim(p_search), '') is null
        or em.product_code ilike '%' || btrim(p_search) || '%'
        or em.description ilike '%' || btrim(p_search) || '%'
      )
    group by em.store_code, em.product_code
    having sum(em.quantity) > 0
  )
  select
    b.store_code,
    b.product_code,
    b.description,
    b.unit,
    b.qty_ajuste,
    b.qty_regulariz,
    b.total_qty,
    b.total_value,
    b.record_count,
    b.last_date,
    lp.last_user,
    null::bigint as total_rows
  from base b
  left join lateral (
    select nullif(em.adjustment_user, '')::text as last_user
    from public.erp_movements em
    where em.source_type = 'ADJUSTMENT'
      and em.store_code = b.store_code
      and em.product_code = b.product_code
      and em.movement_date >= coalesce(year_start::date, date_trunc('year', current_date)::date)
      and em.reason ilike '%PROVIS%'
      and em.reason not ilike '%REGULARIZ%'
      and em.quantity > 0
    order by em.movement_date desc, em.updated_at desc, em.movement_key desc
    limit 1
  ) lp on true
  order by b.last_date desc, b.store_code, b.product_code
  limit least(greatest(coalesce(p_limit, 100), 1), 101)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

grant execute on function public.get_ajustes_provisionales_v2(text, text, text, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
