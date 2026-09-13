-- Ubicaciones: los conteos de una sesión abierta no son un resultado final y
-- no deben reemplazar el maestro de ubicaciones. Se restaura, sin borrar,
-- el último estado conocido antes de cada sesión todavía abierta. Luego la
-- función vigente vuelve a publicar solamente el último inventario finalizado.

create or replace function public.sync_general_inventory_locations_after_finished()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'finished'
     and new.finished_at is not null
     and (
       old.status is distinct from 'finished'
       or old.finished_at is distinct from new.finished_at
     ) then
    perform public.sync_general_inventory_locations_for_store(new.store_id);
  end if;
  return new;
end;
$$;

drop trigger if exists general_inventory_session_location_sync on public.general_inventory_sessions;
create trigger general_inventory_session_location_sync
after update of status, finished_at on public.general_inventory_sessions
for each row execute function public.sync_general_inventory_locations_after_finished();

do $$
declare
  affected_store record;
begin
  -- product_location_history conserva el estado exacto previo a la sesión.
  -- Esta actualización no elimina filas; restaura cantidad, origen y vigencia.
  with open_sessions as (
    select gis.store_id, min(gis.created_at) as opened_at
    from public.general_inventory_sessions gis
    where gis.status = 'open'
    group by gis.store_id
  ), prior_state as (
    select distinct on (pl.id)
      pl.id as location_id,
      h.location,
      h.stored_quantity,
      h.is_active,
      h.source,
      h.occurred_at
    from public.product_locations pl
    join open_sessions os on os.store_id = pl.store_id
    join public.product_location_history h
      on h.location_id = pl.id
     and h.occurred_at < os.opened_at
    where pl.last_source = 'inventario general'
      and pl.last_seen_at >= os.opened_at
    order by pl.id, h.occurred_at desc
  )
  update public.product_locations pl
     set location = prior_state.location,
         stored_quantity = prior_state.stored_quantity,
         is_active = prior_state.is_active,
         last_source = prior_state.source,
         last_seen_at = prior_state.occurred_at,
         updated_at = now()
    from prior_state
   where pl.id = prior_state.location_id;

  -- Reafirma las cantidades y la fecha de fuente del último inventario ya
  -- finalizado de cada tienda afectada. Las sesiones abiertas quedan fuera.
  for affected_store in
    select distinct gis.store_id
    from public.general_inventory_sessions gis
    where gis.status = 'open'
  loop
    perform public.sync_general_inventory_locations_for_store(affected_store.store_id);
  end loop;
end;
$$;
