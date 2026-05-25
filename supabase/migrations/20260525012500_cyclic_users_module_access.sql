-- Permisos por modulo para usuarios del login principal.
-- Aditivo: conserva usuarios existentes y mantiene compatibilidad con la logica por rol.
alter table public.cyclic_users
    add column if not exists module_access jsonb;
