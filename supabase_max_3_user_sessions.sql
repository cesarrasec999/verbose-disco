-- Permite hasta 3 dispositivos simultaneos por usuario.
-- Ejecutar una vez en Supabase SQL Editor antes de usar el limite de 3 sesiones.

alter table public.cyclic_user_sessions
  add column if not exists id uuid default gen_random_uuid();

update public.cyclic_user_sessions
set id = gen_random_uuid()
where id is null;

alter table public.cyclic_user_sessions
  alter column id set not null;

do $$
declare
  pk_name text;
begin
  select con.conname
    into pk_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'cyclic_user_sessions'
    and con.contype = 'p'
  limit 1;

  if pk_name is not null then
    execute format('alter table public.cyclic_user_sessions drop constraint %I', pk_name);
  end if;

  if not exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'cyclic_user_sessions'
      and con.contype = 'p'
      and con.conname = 'cyclic_user_sessions_pkey'
  ) then
    alter table public.cyclic_user_sessions
      add constraint cyclic_user_sessions_pkey primary key (id);
  end if;
end $$;

delete from public.cyclic_user_sessions a
using public.cyclic_user_sessions b
where a.id > b.id
  and a.user_id = b.user_id
  and coalesce(a.device_id, '') = coalesce(b.device_id, '');

create unique index if not exists cyclic_user_sessions_user_device_uidx
  on public.cyclic_user_sessions(user_id, device_id);

create index if not exists idx_cyclic_user_sessions_user_last_seen
  on public.cyclic_user_sessions(user_id, last_seen_at desc);

create index if not exists idx_cyclic_user_sessions_user_token
  on public.cyclic_user_sessions(user_id, session_token);
