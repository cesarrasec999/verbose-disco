-- Ejecutar solo si Supabase rechaza crear usuarios con role = 'Supervisor'.
-- Amplia cualquier CHECK existente sobre public.cyclic_users.role para incluir el rol de solo lectura.
do $$
declare
  constraint_name text;
begin
  select con.conname
    into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'cyclic_users'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%role%'
  limit 1;

  if constraint_name is not null then
    execute format('alter table public.cyclic_users drop constraint %I', constraint_name);
  end if;

  alter table public.cyclic_users
    add constraint cyclic_users_role_check
    check (role in ('Operario', 'Validador', 'Supervisor', 'Administrador'));
end $$;
