-- Convierte los tickets numéricos del maestro de ubicaciones a la descripción
-- del último control de tickets cargado por tienda. CD-GPC e Importaciones no
-- participan porque usan formatos de ubicación distintos.

create index if not exists idx_gi_locations_ticket_control_latest
  on public.general_inventory_locations (session_id, created_at desc)
  where nullif(btrim(full_location), '') is not null;

create or replace function public.normalize_product_location_from_ticket_control()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  raw_location text := btrim(coalesce(new.location, ''));
  latest_session_id uuid;
  mapped_location text;
begin
  if new.store_id is null or raw_location !~ '^\d+$' then
    return new;
  end if;

  if exists (
    select 1
    from public.stores s
    where s.id = new.store_id
      and (
        upper(coalesce(s.name, '')) like '%CD-GPC%'
        or upper(coalesce(s.name, '')) like '%IMPORT%'
      )
  ) then
    return new;
  end if;

  select gil.session_id
    into latest_session_id
  from public.general_inventory_locations gil
  join public.general_inventory_sessions gis on gis.id = gil.session_id
  where gis.store_id = new.store_id
    and nullif(btrim(gil.full_location), '') is not null
  order by gil.created_at desc, gis.scheduled_date desc, gil.session_id desc
  limit 1;

  if latest_session_id is null then
    return new;
  end if;

  select nullif(btrim(gil.full_location), '')
    into mapped_location
  from public.general_inventory_locations gil
  where gil.session_id = latest_session_id
    and nullif(btrim(gil.full_location), '') is not null
    and (
      btrim(coalesce(gil.ticket, '')) = raw_location
      or btrim(coalesce(gil.location_code, '')) = raw_location
      or regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', '') = regexp_replace(raw_location, '^0+(?=\d)', '')
    )
  order by gil.created_at desc, gil.id desc
  limit 1;

  if mapped_location is not null then
    new.location := mapped_location;
  end if;
  return new;
end;
$$;

drop trigger if exists product_locations_normalize_ticket_control on public.product_locations;
create trigger product_locations_normalize_ticket_control
before insert or update of location, store_id on public.product_locations
for each row execute function public.normalize_product_location_from_ticket_control();

-- Conversión única de las ubicaciones activas existentes. Cuando ya existe un
-- registro histórico con la descripción final, se reactiva ese registro y se
-- conserva el número original como inactivo: no se borra ni se fusiona nada.
-- El trigger de historial registra ambos cambios.
with latest_control as (
  select store_id, session_id
  from (
    select
      gis.store_id,
      gil.session_id,
      row_number() over (
        partition by gis.store_id
        order by max(gil.created_at) desc, max(gis.scheduled_date) desc, gil.session_id desc
      ) as rn
    from public.general_inventory_locations gil
    join public.general_inventory_sessions gis on gis.id = gil.session_id
    where nullif(btrim(gil.full_location), '') is not null
    group by gis.store_id, gil.session_id
  ) ranked
  where rn = 1
),
ticket_map as (
  select distinct on (lc.store_id, regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', ''))
    lc.store_id,
    regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', '') as ticket_key,
    nullif(btrim(gil.full_location), '') as full_location
  from latest_control lc
  join public.general_inventory_locations gil on gil.session_id = lc.session_id
  where nullif(btrim(gil.full_location), '') is not null
  order by lc.store_id, regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', ''), gil.created_at desc, gil.id desc
),
conversion_base as (
  select
    p.id as source_id,
    p.store_id,
    p.product_id,
    tm.full_location,
    p.last_source,
    p.last_seen_at,
    p.cyclic_registered,
    p.audit_registered,
    p.general_inventory_registered,
    p.stored_quantity,
    p.updated_by,
    p.updated_at as source_updated_at,
    (
      select p2.id
      from public.product_locations p2
      where p2.store_id = p.store_id
        and p2.product_id = p.product_id
        and p2.location = tm.full_location
        and p2.id <> p.id
      order by p2.is_active desc, p2.updated_at desc nulls last
      limit 1
    ) as target_id
  from public.product_locations p
  join public.stores s on s.id = p.store_id
  join ticket_map tm
    on tm.store_id = p.store_id
   and tm.ticket_key = regexp_replace(btrim(p.location), '^0+(?=\d)', '')
  where p.is_active = true
    and btrim(p.location) ~ '^\d+$'
    and p.location <> tm.full_location
    and upper(coalesce(s.name, '')) not like '%CD-GPC%'
    and upper(coalesce(s.name, '')) not like '%IMPORT%'
),
convertible as (
  select
    conversion_base.*,
    row_number() over (
      partition by store_id, product_id, full_location
      order by source_updated_at desc nulls last, source_id
    ) as conversion_rank
  from conversion_base
)
select *
into temporary table ticket_location_conversion
from convertible;

update public.product_locations p
set location = c.full_location,
    updated_at = now()
from ticket_location_conversion c
where c.target_id is null
  and c.conversion_rank = 1
  and p.id = c.source_id;

update public.product_locations p
set is_active = true,
    last_source = c.last_source,
    last_seen_at = c.last_seen_at,
    cyclic_registered = coalesce(p.cyclic_registered, false) or coalesce(c.cyclic_registered, false),
    audit_registered = coalesce(p.audit_registered, false) or coalesce(c.audit_registered, false),
    general_inventory_registered = coalesce(p.general_inventory_registered, false) or coalesce(c.general_inventory_registered, false),
    stored_quantity = coalesce(c.stored_quantity, p.stored_quantity),
    updated_by = c.updated_by,
    updated_at = now()
from ticket_location_conversion c
where c.target_id is not null
  and c.conversion_rank = 1
  and p.id = c.target_id;

update public.product_locations p
set is_active = false,
    updated_at = now()
from ticket_location_conversion c
where (c.target_id is not null or c.conversion_rank > 1)
  and p.id = c.source_id;
