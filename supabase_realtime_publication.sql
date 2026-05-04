-- Asegura que Supabase Realtime emita cambios de las tablas operativas.
-- Ejecutar una vez en Supabase SQL Editor. Es idempotente.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'cyclic_assignments'
  ) then
    alter publication supabase_realtime add table public.cyclic_assignments;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'cyclic_counts'
  ) then
    alter publication supabase_realtime add table public.cyclic_counts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'audit_sessions'
  ) then
    alter publication supabase_realtime add table public.audit_sessions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'audit_session_items'
  ) then
    alter publication supabase_realtime add table public.audit_session_items;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'audit_counts'
  ) then
    alter publication supabase_realtime add table public.audit_counts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'general_inventory_counts'
  ) then
    alter publication supabase_realtime add table public.general_inventory_counts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'general_inventory_recount_items'
  ) then
    alter publication supabase_realtime add table public.general_inventory_recount_items;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'general_inventory_recount_counts'
  ) then
    alter publication supabase_realtime add table public.general_inventory_recount_counts;
  end if;
end;
$$;
