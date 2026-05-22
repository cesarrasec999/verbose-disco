-- Seguro de ubicaciones para inventarios generales.
-- Activo: solo permite ubicaciones cargadas/registradas en general_inventory_locations.
-- Libre: el app puede crear la ubicacion al guardar conteo o reconteo.

alter table public.general_inventory_sessions
  add column if not exists location_lock_enabled boolean not null default false;

alter table public.general_inventory_sessions
  add column if not exists manual_recount_enabled boolean not null default false;
