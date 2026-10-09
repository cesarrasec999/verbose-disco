-- Ajustes Provisionales: evita el timeout bajo carga concurrente del ERP.
--
-- Solo existen dos motivos validos para este modulo. La version anterior
-- hacia una busqueda lateral del ultimo usuario para los ~2,700 productos
-- agregados antes de aplicar LIMIT; en una tabla particionada eso multiplicaba
-- miles de busquedas por las 28 particiones. Ahora el usuario se obtiene en la
-- misma agregacion y cada movimiento elegible se lee una sola vez.

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
      and em.movement_date >= coalesce(year_start::date, date_trunc('year', current_date)::date)
      and (em.reason ilike '%PROVIS%' or em.reason ilike '%REGULARIZ%')
      and em.reason in ('06. INGRESOS PROVISIONALES', '07. REGULARIZACION DE PROVISIONAL')
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
    b.last_user,
    null::bigint as total_rows
  from base b
  order by b.last_date desc, b.store_code, b.product_code
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
  from public.get_ajustes_provisionales_v2(
    year_start,
    p_store,
    null,
    p_limit,
    p_offset
  ) r;
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
  with products as materialized (
    select
      em.store_code::text as store_code,
      em.product_code::text as product_code,
      sum(case when em.reason = '06. INGRESOS PROVISIONALES' then em.quantity else 0 end)::double precision as qty_ajuste,
      sum(case when em.reason = '07. REGULARIZACION DE PROVISIONAL' then em.quantity else 0 end)::double precision as qty_regulariz,
      sum(em.quantity)::double precision as total_qty,
      sum(coalesce(em.value_total, 0))::double precision as total_value,
      max(em.movement_date) as last_date
    from public.erp_movements em
    where em.source_type = 'ADJUSTMENT'
      and em.movement_date >= coalesce(year_start::date, date_trunc('year', current_date)::date)
      and (em.reason ilike '%PROVIS%' or em.reason ilike '%REGULARIZ%')
      and em.reason in ('06. INGRESOS PROVISIONALES', '07. REGULARIZACION DE PROVISIONAL')
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
    p.store_code,
    count(*)::bigint as product_count,
    sum(p.qty_ajuste)::double precision as qty_ajuste,
    sum(p.qty_regulariz)::double precision as qty_regulariz,
    sum(p.total_qty)::double precision as total_qty,
    sum(p.total_value)::double precision as total_value,
    max(p.last_date) as last_date
  from products p
  group by p.store_code
  order by p.store_code;
$$;

grant execute on function public.get_ajustes_provisionales_v2(text, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.get_ajustes_provisionales(text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.get_ajustes_provisionales_store_summary(text, text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
