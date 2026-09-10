-- Ubicaciones: cada conteo de Inventario General debe alimentar el maestro
-- de la tienda. Es aditivo: no elimina ni desactiva ubicaciones existentes.
-- La normalización de tickets de product_locations traduce los códigos
-- numéricos al texto del último control de tickets antes de este upsert.

create or replace function public.sync_general_inventory_location(
  p_session_id uuid,
  p_product_id uuid,
  p_location_code text,
  p_sku text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_location text := btrim(coalesce(p_location_code, ''));
  v_sku text := btrim(coalesce(p_sku, ''));
  v_quantity numeric;
begin
  if p_session_id is null or p_product_id is null
    or v_location = '' or upper(v_location) in ('SIN_FISICO', '__SESSION_FLAG__')
  then
    return;
  end if;

  select store_id into v_store_id
  from public.general_inventory_sessions
  where id = p_session_id
    and status <> 'cancelled';
  if v_store_id is null then return; end if;

  -- CD-GPC e Importaciones conservan su formato propio; no se fuerza el
  -- catálogo de tickets de tiendas sobre esas ubicaciones.
  if exists (
    select 1
    from public.stores s
    where s.id = v_store_id
      and upper(btrim(s.name)) in ('CD-GPC', 'IMPORTACIONES')
  ) then
    return;
  end if;

  if v_sku = '' then
    select btrim(coalesce(sku, '')) into v_sku
    from public.cyclic_products
    where id = p_product_id;
  end if;
  if v_sku = '' then return; end if;

  -- La cantidad es la suma real del producto en esa ubicación, no solo la
  -- última fila insertada. Así se conserva el resultado si varios operadores
  -- contaron el mismo código/ticket en la misma sesión.
  select coalesce(sum(c.quantity), 0) into v_quantity
  from public.general_inventory_counts c
  where c.session_id = p_session_id
    and c.product_id = p_product_id
    and (
      case
        when btrim(coalesce(c.location_code, '')) ~ '^\d+$'
          then regexp_replace(btrim(c.location_code), '^0+(?=\d)', '')
        else upper(btrim(coalesce(c.location_code, '')))
      end
    ) = (
      case
        when v_location ~ '^\d+$' then regexp_replace(v_location, '^0+(?=\d)', '')
        else upper(v_location)
      end
    );

  insert into public.product_locations (
    store_id, product_id, sku, location, is_active,
    updated_at, last_source, last_seen_at,
    general_inventory_registered, stored_quantity
  ) values (
    v_store_id, p_product_id, upper(v_sku), v_location, true,
    now(), 'inventario general', now(), true, v_quantity
  )
  on conflict (store_id, product_id, location) do update
  set sku = excluded.sku,
      is_active = true,
      updated_at = excluded.updated_at,
      last_source = excluded.last_source,
      last_seen_at = excluded.last_seen_at,
      general_inventory_registered = true,
      stored_quantity = excluded.stored_quantity;
end;
$$;

create or replace function public.sync_product_location_from_general_inventory_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_general_inventory_location(
    new.session_id, new.product_id, new.location_code, new.sku
  );
  return new;
end;
$$;

drop trigger if exists general_inventory_count_location_sync on public.general_inventory_counts;
create trigger general_inventory_count_location_sync
after insert or update of session_id, product_id, location_code, sku, quantity
on public.general_inventory_counts
for each row execute function public.sync_product_location_from_general_inventory_count();

-- Reconstruye una tienda por vez desde su última sesión con conteos. La
-- ejecución por lote usa esta función en transacciones cortas para no bloquear
-- a los operadores mientras el sistema ya está en operación.
create or replace function public.sync_general_inventory_locations_for_store(
  p_store_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_upserted integer := 0;
begin
  if p_store_id is null or exists (
    select 1 from public.stores s
    where s.id = p_store_id
      and upper(btrim(s.name)) in ('CD-GPC', 'IMPORTACIONES')
  ) then
    return 0;
  end if;

  select gis.id into v_session_id
  from public.general_inventory_sessions gis
  where gis.store_id = p_store_id
    and gis.status <> 'cancelled'
    and exists (
      select 1 from public.general_inventory_counts c
      where c.session_id = gis.id
    )
  order by gis.scheduled_date desc nulls last, gis.created_at desc, gis.id desc
  limit 1;
  if v_session_id is null then return 0; end if;

  with latest_ticket_control as (
    select gil.session_id
    from public.general_inventory_locations gil
    join public.general_inventory_sessions gis on gis.id = gil.session_id
    where gis.store_id = p_store_id
      and coalesce(
        case when nullif(btrim(gil.full_location), '') is not null and btrim(gil.full_location) !~ '^\d+$' then btrim(gil.full_location) end,
        nullif(concat_ws('-', nullif(btrim(gil.zone), ''), nullif(btrim(gil.lineal), ''), nullif(btrim(gil.zone_ref), ''), case when nullif(btrim(gil.reference), '') is null then null else '[' || btrim(gil.reference) || ']' end), '')
      ) is not null
    order by gil.created_at desc, gis.scheduled_date desc, gil.session_id desc
    limit 1
  ), ticket_map as (
    select distinct on (regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', ''))
      regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', '') as ticket_key,
      coalesce(
        case when nullif(btrim(gil.full_location), '') is not null and btrim(gil.full_location) !~ '^\d+$' then btrim(gil.full_location) end,
        nullif(concat_ws('-', nullif(btrim(gil.zone), ''), nullif(btrim(gil.lineal), ''), nullif(btrim(gil.zone_ref), ''), case when nullif(btrim(gil.reference), '') is null then null else '[' || btrim(gil.reference) || ']' end), '')
      ) as full_location
    from public.general_inventory_locations gil
    join latest_ticket_control ltc on ltc.session_id = gil.session_id
    order by regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', ''), gil.created_at desc, gil.id desc
  ), locations_to_sync as (
    select
      c.product_id,
      coalesce(nullif(max(btrim(c.sku)), ''), max(btrim(cp.sku))) as sku,
      coalesce(max(tm.full_location), max(btrim(c.location_code))) as location,
      coalesce(sum(c.quantity), 0) as stored_quantity
    from public.general_inventory_counts c
    left join public.cyclic_products cp on cp.id = c.product_id
    left join ticket_map tm
      on regexp_replace(btrim(c.location_code), '^0+(?=\d)', '') = tm.ticket_key
    where c.session_id = v_session_id
      and nullif(btrim(coalesce(c.location_code, '')), '') is not null
      and upper(btrim(c.location_code)) not in ('SIN_FISICO', '__SESSION_FLAG__')
    group by c.product_id, coalesce(tm.full_location,
      case
        when btrim(c.location_code) ~ '^\d+$' then regexp_replace(btrim(c.location_code), '^0+(?=\d)', '')
        else btrim(c.location_code)
      end
    )
  ), upserted as (
    insert into public.product_locations (
      store_id, product_id, sku, location, is_active,
      updated_at, last_source, last_seen_at,
      general_inventory_registered, stored_quantity
    )
    select
      p_store_id, product_id, upper(sku), location, true,
      now(), 'inventario general', now(), true, stored_quantity
    from locations_to_sync
    where nullif(btrim(coalesce(sku, '')), '') is not null
    on conflict (store_id, product_id, location) do update
    set sku = excluded.sku,
        is_active = true,
        updated_at = excluded.updated_at,
        last_source = excluded.last_source,
        last_seen_at = excluded.last_seen_at,
        general_inventory_registered = true,
        stored_quantity = excluded.stored_quantity
    returning 1
  )
  select count(*) into v_upserted from upserted;

  return v_upserted;
end;
$$;

notify pgrst, 'reload schema';
