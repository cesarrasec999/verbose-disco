-- Apagado temporal seguro del plan de validacion.
-- No elimina tablas ni registros de validacion; solo evita que las sesiones usen esa capa
-- y retira sus tablas del canal realtime para bajar carga.

update public.general_inventory_sessions
set validation_enabled = false,
    updated_at = now()
where coalesce(validation_enabled, false) = true;

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'general_inventory_validation_items'
  ) then
    alter publication supabase_realtime drop table public.general_inventory_validation_items;
  end if;

  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'general_inventory_validation_counts'
  ) then
    alter publication supabase_realtime drop table public.general_inventory_validation_counts;
  end if;
end $$;

notify pgrst, 'reload schema';
