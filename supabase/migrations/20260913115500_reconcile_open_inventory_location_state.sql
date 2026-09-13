-- Corrección de datos ya publicados por clientes anteriores durante sesiones
-- abiertas. Los conteos se conservan en general_inventory_counts; el maestro
-- vuelve al último estado confirmado y no se elimina ninguna fila física.
do $$
declare
  affected_store record;
begin
  -- Filas que ya existían antes de iniciar la sesión: se restaura exactamente
  -- su última versión histórica previa a la sesión abierta.
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

  -- Filas creadas solamente por el conteo aún abierto: se conservan como
  -- historial, pero no se muestran como ubicación validada hasta su cierre.
  with open_sessions as (
    select gis.store_id, min(gis.created_at) as opened_at
    from public.general_inventory_sessions gis
    where gis.status = 'open'
    group by gis.store_id
  )
  update public.product_locations pl
     set is_active = false,
         last_source = 'inventario general pendiente de finalizar',
         updated_at = now()
    from open_sessions os
   where pl.store_id = os.store_id
     and pl.last_source = 'inventario general'
     and pl.last_seen_at >= os.opened_at
     and not exists (
       select 1
       from public.product_location_history h
       where h.location_id = pl.id
         and h.occurred_at < os.opened_at
     );

  -- La publicación válida procede exclusivamente de la última sesión cerrada.
  for affected_store in
    select distinct gis.store_id
    from public.general_inventory_sessions gis
    where gis.status = 'open'
  loop
    perform public.sync_general_inventory_locations_for_store(affected_store.store_id);
  end loop;
end;
$$;

