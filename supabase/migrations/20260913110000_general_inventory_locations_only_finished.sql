-- Las ubicaciones de Inventario General representan exclusivamente una sesión
-- finalizada. Un conteo en curso puede cambiar muchas veces y no debe aparecer
-- en el maestro de Ubicaciones hasta que el inventario se cierre.
--
-- No se elimina ningún registro: al terminar una sesión se hace upsert de sus
-- ubicaciones reales y se conserva toda evidencia anterior.

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
  v_finished_at timestamptz;
  v_location text := btrim(coalesce(p_location_code, ''));
  v_sku text := btrim(coalesce(p_sku, ''));
  v_quantity numeric;
begin
  if p_session_id is null or p_product_id is null
    or v_location = '' or upper(v_location) in ('SIN_FISICO', '__SESSION_FLAG__')
  then
    return;
  end if;

  select store_id, finished_at into v_store_id, v_finished_at
  from public.general_inventory_sessions
  where id = p_session_id
    and status = 'finished';
  if v_store_id is null or v_finished_at is null then return; end if;

  -- CD-GPC e Importaciones conservan su formato propio.
  if exists (
    select 1 from public.stores s
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

  select coalesce(sum(c.quantity), 0) into v_quantity
  from public.general_inventory_counts c
  where c.session_id = p_session_id
    and c.product_id = p_product_id
    and (
      case when btrim(coalesce(c.location_code, '')) ~ '^\d+$'
        then regexp_replace(btrim(c.location_code), '^0+(?=\d)', '')
        else upper(btrim(coalesce(c.location_code, '')))
      end
    ) = (
      case when v_location ~ '^\d+$' then regexp_replace(v_location, '^0+(?=\d)', '')
        else upper(v_location)
      end
    );

  insert into public.product_locations (
    store_id, product_id, sku, location, is_active,
    updated_at, last_source, last_seen_at,
    general_inventory_registered, stored_quantity
  ) values (
    v_store_id, p_product_id, upper(v_sku), v_location, true,
    now(), 'inventario general', v_finished_at, true, v_quantity
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
  v_finished_at timestamptz;
  v_upserted integer := 0;
begin
  if p_store_id is null or exists (
    select 1 from public.stores s
    where s.id = p_store_id
      and upper(btrim(s.name)) in ('CD-GPC', 'IMPORTACIONES')
  ) then
    return 0;
  end if;

  select gis.id, gis.finished_at into v_session_id, v_finished_at
  from public.general_inventory_sessions gis
  where gis.store_id = p_store_id
    and gis.status = 'finished'
    and gis.finished_at is not null
    and exists (select 1 from public.general_inventory_counts c where c.session_id = gis.id)
  order by gis.finished_at desc, gis.scheduled_date desc nulls last, gis.created_at desc, gis.id desc
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
    order by gil.created_at desc, gis.finished_at desc nulls last, gil.session_id desc
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
    select c.product_id,
      coalesce(nullif(max(btrim(c.sku)), ''), max(btrim(cp.sku))) as sku,
      coalesce(max(tm.full_location), max(btrim(c.location_code))) as location,
      coalesce(sum(c.quantity), 0) as stored_quantity
    from public.general_inventory_counts c
    left join public.cyclic_products cp on cp.id = c.product_id
    left join ticket_map tm on regexp_replace(btrim(c.location_code), '^0+(?=\d)', '') = tm.ticket_key
    where c.session_id = v_session_id
      and nullif(btrim(coalesce(c.location_code, '')), '') is not null
      and upper(btrim(c.location_code)) not in ('SIN_FISICO', '__SESSION_FLAG__')
    group by c.product_id, coalesce(tm.full_location,
      case when btrim(c.location_code) ~ '^\d+$' then regexp_replace(btrim(c.location_code), '^0+(?=\d)', '') else btrim(c.location_code) end)
  ), upserted as (
    insert into public.product_locations (
      store_id, product_id, sku, location, is_active,
      updated_at, last_source, last_seen_at,
      general_inventory_registered, stored_quantity
    )
    select p_store_id, product_id, upper(sku), location, true,
      now(), 'inventario general', v_finished_at, true, stored_quantity
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

-- Al cerrar la sesión se sincroniza la tienda una vez. Mientras está abierta,
-- los INSERT/UPDATE de conteos no cambian las ubicaciones visibles.
create or replace function public.sync_general_inventory_locations_after_finished()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'finished' and old.status is distinct from 'finished' then
    perform public.sync_general_inventory_locations_for_store(new.store_id);
  end if;
  return new;
end;
$$;

drop trigger if exists general_inventory_session_location_sync on public.general_inventory_sessions;
create trigger general_inventory_session_location_sync
after update of status on public.general_inventory_sessions
for each row execute function public.sync_general_inventory_locations_after_finished();

-- Repara las fechas técnicas de sincronizaciones anteriores. Actualiza solo
-- ubicaciones que coinciden exactamente con el último inventario terminado;
-- ninguna ubicación histórica se borra ni se desactiva.
create or replace function public.reconcile_general_inventory_location_dates_for_store(
  p_store_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_finished_at timestamptz;
  v_updated integer := 0;
begin
  select id, finished_at into v_session_id, v_finished_at
  from public.general_inventory_sessions
  where store_id = p_store_id and status = 'finished' and finished_at is not null
  order by finished_at desc, id desc limit 1;
  if v_session_id is null then return 0; end if;

  with latest_ticket_control as (
    select gil.session_id
    from public.general_inventory_locations gil
    join public.general_inventory_sessions gis on gis.id = gil.session_id
    where gis.store_id = p_store_id
      and coalesce(nullif(btrim(gil.full_location), ''), nullif(btrim(gil.location_code), '')) is not null
    order by gil.created_at desc, gis.finished_at desc nulls last, gil.session_id desc limit 1
  ), ticket_map as (
    select distinct on (regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', ''))
      regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', '') as ticket_key,
      coalesce(
        case when nullif(btrim(gil.full_location), '') is not null and btrim(gil.full_location) !~ '^\d+$' then btrim(gil.full_location) end,
        nullif(concat_ws('-', nullif(btrim(gil.zone), ''), nullif(btrim(gil.lineal), ''), nullif(btrim(gil.zone_ref), ''), case when nullif(btrim(gil.reference), '') is null then null else '[' || btrim(gil.reference) || ']' end), '')
      ) as full_location
    from public.general_inventory_locations gil join latest_ticket_control ltc on ltc.session_id = gil.session_id
    order by regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', ''), gil.created_at desc, gil.id desc
  ), valid_locations as (
    select c.product_id,
      coalesce(max(tm.full_location), max(btrim(c.location_code))) as location,
      coalesce(sum(c.quantity), 0) as stored_quantity
    from public.general_inventory_counts c
    left join ticket_map tm on regexp_replace(btrim(c.location_code), '^0+(?=\d)', '') = tm.ticket_key
    where c.session_id = v_session_id
      and nullif(btrim(coalesce(c.location_code, '')), '') is not null
      and upper(btrim(c.location_code)) not in ('SIN_FISICO', '__SESSION_FLAG__')
    group by c.product_id, coalesce(tm.full_location,
      case when btrim(c.location_code) ~ '^\d+$' then regexp_replace(btrim(c.location_code), '^0+(?=\d)', '') else btrim(c.location_code) end)
  )
  update public.product_locations pl
  set last_seen_at = v_finished_at,
      stored_quantity = valid_locations.stored_quantity,
      updated_at = now()
  from valid_locations
  where pl.store_id = p_store_id
    and pl.product_id = valid_locations.product_id
    and pl.location = valid_locations.location
    and pl.last_source = 'inventario general';
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

notify pgrst, 'reload schema';
