-- Consolida ubicaciones historicas en product_locations.
-- Regla de inventario general:
--   si un codigo tiene reconteo en una sesion, se toman las ubicaciones del reconteo;
--   si no tiene reconteo, se toman las ubicaciones del conteo.

alter table public.product_locations add column if not exists last_source text;
alter table public.product_locations add column if not exists last_seen_at timestamptz not null default now();
alter table public.product_locations add column if not exists cyclic_registered boolean not null default false;
alter table public.product_locations add column if not exists audit_registered boolean not null default false;
alter table public.product_locations add column if not exists general_inventory_registered boolean not null default false;

with gi_recounted_products as (
  select distinct session_id, product_id
  from public.general_inventory_recount_counts
  where product_id is not null
),
raw_locations as (
  select
    cc.store_id,
    cc.product_id,
    cp.sku,
    upper(trim(cc.location)) as location,
    'ciclico'::text as last_source,
    coalesce(cc.updated_at, cc.counted_at, now()) as seen_at
  from public.cyclic_counts cc
  join public.cyclic_products cp on cp.id = cc.product_id
  where cc.location is not null
    and trim(cc.location) <> ''
    and upper(trim(cc.location)) not in ('CODIGO_COMPLETO', 'SIN_FISICO', 'SIN UBICACION', '__SIN_STOCK__')
    and upper(trim(cc.location)) not like '\_\_%' escape '\'

  union all

  select
    s.store_id,
    ac.product_id,
    cp.sku,
    upper(trim(ac.location)) as location,
    'auditoria'::text as last_source,
    coalesce(ac.counted_at, now()) as seen_at
  from public.audit_counts ac
  join public.audit_sessions s on s.id = ac.session_id
  join public.cyclic_products cp on cp.id = ac.product_id
  where ac.location is not null
    and trim(ac.location) <> ''
    and upper(trim(ac.location)) not in ('CODIGO_COMPLETO', 'SIN_FISICO', 'SIN UBICACION', '__SIN_STOCK__')
    and upper(trim(ac.location)) not like '\_\_%' escape '\'

  union all

  select
    s.store_id,
    grc.product_id,
    coalesce(grc.sku, cp.sku) as sku,
    upper(trim(grc.location_code)) as location,
    'inventario general'::text as last_source,
    coalesce(grc.updated_at, grc.counted_at, now()) as seen_at
  from public.general_inventory_recount_counts grc
  join public.general_inventory_sessions s on s.id = grc.session_id
  join public.cyclic_products cp on cp.id = grc.product_id
  where grc.product_id is not null
    and grc.location_code is not null
    and trim(grc.location_code) <> ''
    and upper(trim(grc.location_code)) not in ('CODIGO_COMPLETO', 'SIN_FISICO', 'SIN UBICACION', '__SIN_STOCK__')
    and upper(trim(grc.location_code)) not like '\_\_%' escape '\'

  union all

  select
    s.store_id,
    gc.product_id,
    coalesce(gc.sku, cp.sku) as sku,
    upper(trim(gc.location_code)) as location,
    'inventario general'::text as last_source,
    coalesce(gc.updated_at, gc.counted_at, now()) as seen_at
  from public.general_inventory_counts gc
  join public.general_inventory_sessions s on s.id = gc.session_id
  join public.cyclic_products cp on cp.id = gc.product_id
  where gc.location_code is not null
    and trim(gc.location_code) <> ''
    and upper(trim(gc.location_code)) not in ('CODIGO_COMPLETO', 'SIN_FISICO', 'SIN UBICACION', '__SIN_STOCK__')
    and upper(trim(gc.location_code)) not like '\_\_%' escape '\'
    and not exists (
      select 1
      from gi_recounted_products rp
      where rp.session_id = gc.session_id
        and rp.product_id = gc.product_id
    )
),
ranked_locations as (
  select
    raw_locations.*,
    row_number() over (
      partition by store_id, product_id, location
      order by seen_at desc, last_source
    ) as rn
  from raw_locations
),
merged_locations as (
  select
    store_id,
    product_id,
    max(sku) as sku,
    location,
    max(seen_at) as last_seen_at,
    bool_or(last_source = 'ciclico') as cyclic_registered,
    bool_or(last_source = 'auditoria') as audit_registered,
    bool_or(last_source = 'inventario general') as general_inventory_registered
  from raw_locations
  group by store_id, product_id, location
),
final_locations as (
  select
    ml.store_id,
    ml.product_id,
    ml.sku,
    ml.location,
    rl.last_source,
    ml.last_seen_at,
    ml.cyclic_registered,
    ml.audit_registered,
    ml.general_inventory_registered
  from merged_locations ml
  join ranked_locations rl
    on rl.store_id = ml.store_id
   and rl.product_id = ml.product_id
   and rl.location = ml.location
   and rl.rn = 1
)
insert into public.product_locations (
  store_id,
  product_id,
  sku,
  location,
  is_active,
  updated_at,
  last_source,
  last_seen_at,
  cyclic_registered,
  audit_registered,
  general_inventory_registered
)
select
  store_id,
  product_id,
  sku,
  location,
  true,
  last_seen_at,
  last_source,
  last_seen_at,
  cyclic_registered,
  audit_registered,
  general_inventory_registered
from final_locations
on conflict (store_id, product_id, location) do update set
  sku = excluded.sku,
  is_active = true,
  updated_at = greatest(public.product_locations.updated_at, excluded.updated_at),
  last_source = case
    when excluded.last_seen_at >= public.product_locations.last_seen_at then excluded.last_source
    else public.product_locations.last_source
  end,
  last_seen_at = greatest(public.product_locations.last_seen_at, excluded.last_seen_at),
  cyclic_registered = public.product_locations.cyclic_registered or excluded.cyclic_registered,
  audit_registered = public.product_locations.audit_registered or excluded.audit_registered,
  general_inventory_registered = public.product_locations.general_inventory_registered or excluded.general_inventory_registered;

notify pgrst, 'reload schema';
