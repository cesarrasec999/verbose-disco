-- Protección de servidor para clientes PWA/APK/web que todavía tengan una
-- versión anterior abierta: ningún conteo de una sesión abierta puede marcar
-- una ubicación como resultado de inventario general.
create or replace function public.block_open_inventory_location_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_source = 'inventario general'
     and new.last_seen_at is not null
     and exists (
       select 1
       from public.general_inventory_sessions gis
       where gis.store_id = new.store_id
         and gis.status = 'open'
         and new.last_seen_at >= gis.created_at
     ) then
    -- La fuente verídica queda en general_inventory_counts. No se borra ni se
    -- altera el conteo; solamente se impide publicar el maestro antes del cierre.
    if tg_op = 'INSERT' then
      return null;
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists product_locations_block_open_inventory_publish on public.product_locations;
create trigger product_locations_block_open_inventory_publish
before insert or update on public.product_locations
for each row execute function public.block_open_inventory_location_publish();

