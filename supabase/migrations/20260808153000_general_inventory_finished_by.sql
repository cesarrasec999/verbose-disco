-- Registra quién finaliza una sesión de Inventarios Generales.
-- Las sesiones históricas no se pueden reconstruir porque antes no se guardaba
-- el usuario de finalización.

alter table public.general_inventory_sessions
  add column if not exists finished_by uuid references public.cyclic_users(id) on delete set null;

alter table public.general_inventory_sessions
  add column if not exists finished_by_name text;

create index if not exists idx_gi_sessions_finished_by
  on public.general_inventory_sessions (finished_by);
