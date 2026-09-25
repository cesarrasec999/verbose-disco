-- Al editar o volver a cargar el control de tickets de la última sesión
-- finalizada, vuelve a publicar automáticamente las ubicaciones de la tienda.
-- La reconciliación conserva el historial: las etiquetas anteriores se
-- desactivan, nunca se eliminan.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public.sync_general_inventory_locations_for_store(
  p_store_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_session_id uuid;
  v_finished_at timestamptz;
  v_upserted integer := 0;
begin
  if p_store_id is null or exists (
    select 1
    from public.stores s
    where s.id = p_store_id
      and upper(btrim(s.name)) in ('CD-GPC', 'IMPORTACIONES')
  ) then
    return 0;
  end if;

  select gis.id, gis.finished_at
    into v_session_id, v_finished_at
  from public.general_inventory_sessions gis
  where gis.store_id = p_store_id
    and gis.status = 'finished'
    and gis.finished_at is not null
    and exists (
      select 1
      from public.general_inventory_counts c
      where c.session_id = gis.id
    )
  order by gis.finished_at desc,
           gis.scheduled_date desc nulls last,
           gis.created_at desc,
           gis.id desc
  limit 1;

  if v_session_id is null then
    return 0;
  end if;

  with ticket_map as materialized (
    select distinct on (
      regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', '')
    )
      regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', '') as ticket_key,
      coalesce(
        case
          when nullif(btrim(gil.full_location), '') is not null
            and btrim(gil.full_location) !~ '^\d+$'
          then btrim(gil.full_location)
        end,
        nullif(
          concat_ws(
            '-',
            nullif(btrim(gil.zone), ''),
            nullif(btrim(gil.lineal), ''),
            nullif(btrim(gil.zone_ref), ''),
            case
              when nullif(btrim(gil.reference), '') is null then null
              else '[' || btrim(gil.reference) || ']'
            end
          ),
          ''
        )
      ) as full_location
    from public.general_inventory_locations gil
    where gil.session_id = v_session_id
      and coalesce(gil.is_active, true)
    order by
      regexp_replace(coalesce(gil.ticket, gil.location_code, ''), '^0+(?=\d)', ''),
      gil.created_at desc,
      gil.id desc
  ), desired_locations as materialized (
    select
      c.product_id,
      coalesce(nullif(max(btrim(c.sku)), ''), max(btrim(cp.sku))) as sku,
      coalesce(
        max(tm.full_location),
        max(
          case
            when btrim(c.location_code) ~ '^\d+$'
              then regexp_replace(btrim(c.location_code), '^0+(?=\d)', '')
            else btrim(c.location_code)
          end
        )
      ) as location,
      coalesce(sum(c.quantity), 0) as stored_quantity
    from public.general_inventory_counts c
    left join public.cyclic_products cp on cp.id = c.product_id
    left join ticket_map tm
      on regexp_replace(btrim(c.location_code), '^0+(?=\d)', '') = tm.ticket_key
    where c.session_id = v_session_id
      and nullif(btrim(coalesce(c.location_code, '')), '') is not null
      and upper(btrim(c.location_code)) not in ('SIN_FISICO', '__SESSION_FLAG__')
    group by
      c.product_id,
      coalesce(
        tm.full_location,
        case
          when btrim(c.location_code) ~ '^\d+$'
            then regexp_replace(btrim(c.location_code), '^0+(?=\d)', '')
          else btrim(c.location_code)
        end
      )
  ), deactivated as (
    update public.product_locations pl
       set is_active = false,
           general_inventory_registered = false,
           updated_at = now()
     where pl.store_id = p_store_id
       and pl.last_source = 'inventario general'
       and pl.general_inventory_registered = true
       and pl.last_seen_at = v_finished_at
       and not exists (
         select 1
         from desired_locations d
         where d.product_id = pl.product_id
           and d.location = pl.location
       )
    returning 1
  ), upserted as (
    insert into public.product_locations (
      store_id, product_id, sku, location, is_active,
      updated_at, last_source, last_seen_at,
      general_inventory_registered, stored_quantity
    )
    select
      p_store_id,
      d.product_id,
      upper(d.sku),
      d.location,
      true,
      now(),
      'inventario general',
      v_finished_at,
      true,
      d.stored_quantity
    from desired_locations d
    where nullif(btrim(coalesce(d.sku, '')), '') is not null
      and nullif(btrim(coalesce(d.location, '')), '') is not null
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

-- Un INSERT/UPDATE/DELETE del control reactiva una sola vez el trabajo de la
-- sesión. Durante una carga masiva, el primer registro deja el job pendiente y
-- los siguientes no vuelven a escribirlo.
create or replace function public.enqueue_ticket_control_location_sync()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_session_id uuid := coalesce(new.session_id, old.session_id);
  v_store_id uuid;
  v_latest_session_id uuid;
begin
  select gis.store_id
    into v_store_id
  from public.general_inventory_sessions gis
  where gis.id = v_session_id
    and gis.status = 'finished'
    and gis.finished_at is not null;

  if v_store_id is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select gis.id
    into v_latest_session_id
  from public.general_inventory_sessions gis
  where gis.store_id = v_store_id
    and gis.status = 'finished'
    and gis.finished_at is not null
    and exists (
      select 1
      from public.general_inventory_counts c
      where c.session_id = gis.id
    )
  order by gis.finished_at desc,
           gis.scheduled_date desc nulls last,
           gis.created_at desc,
           gis.id desc
  limit 1;

  if v_latest_session_id is distinct from v_session_id then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  insert into public.general_inventory_location_sync_jobs (
    session_id, store_id, status, attempts, upserted_locations,
    last_error, started_at, completed_at, updated_at
  ) values (
    v_session_id, v_store_id, 'pending', 0, 0,
    null, null, null, now()
  )
  on conflict (session_id) do update
     set store_id = excluded.store_id,
         status = 'pending',
         attempts = 0,
         upserted_locations = 0,
         last_error = null,
         started_at = null,
         completed_at = null,
         updated_at = now()
   where public.general_inventory_location_sync_jobs.status <> 'pending'
      or public.general_inventory_location_sync_jobs.store_id is distinct from excluded.store_id;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists general_inventory_ticket_control_sync_insert_delete
  on public.general_inventory_locations;
create trigger general_inventory_ticket_control_sync_insert_delete
after insert or delete
on public.general_inventory_locations
for each row execute function public.enqueue_ticket_control_location_sync();

drop trigger if exists general_inventory_ticket_control_sync_update
  on public.general_inventory_locations;
create trigger general_inventory_ticket_control_sync_update
after update of session_id, location_code, ticket, zone, lineal, zone_ref,
  reference, full_location, description, is_active
on public.general_inventory_locations
for each row execute function public.enqueue_ticket_control_location_sync();

revoke all on function public.enqueue_ticket_control_location_sync()
  from public, anon, authenticated;

-- Programa una conciliación inicial para la última sesión finalizada de todas
-- las tiendas que ya cuentan con control de tickets. El cron existente procesa
-- estos trabajos en lotes sin bloquear a los operadores.
insert into public.general_inventory_location_sync_jobs (
  session_id, store_id, status, attempts, upserted_locations,
  last_error, started_at, completed_at, updated_at
)
select latest.id, latest.store_id, 'pending', 0, 0,
       null, null, null, now()
from (
  select distinct on (gis.store_id)
    gis.id,
    gis.store_id
  from public.general_inventory_sessions gis
  where gis.status = 'finished'
    and gis.finished_at is not null
    and exists (
      select 1 from public.general_inventory_counts c where c.session_id = gis.id
    )
    and exists (
      select 1 from public.general_inventory_locations gil where gil.session_id = gis.id
    )
  order by gis.store_id,
           gis.finished_at desc,
           gis.scheduled_date desc nulls last,
           gis.created_at desc,
           gis.id desc
) latest
join public.stores s on s.id = latest.store_id
where upper(btrim(s.name)) not in ('CD-GPC', 'IMPORTACIONES')
on conflict (session_id) do update
   set store_id = excluded.store_id,
       status = 'pending',
       attempts = 0,
       upserted_locations = 0,
       last_error = null,
       started_at = null,
       completed_at = null,
       updated_at = now();

notify pgrst, 'reload schema';

commit;
