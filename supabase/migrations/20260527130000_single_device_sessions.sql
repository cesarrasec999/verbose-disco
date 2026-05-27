-- Sesion unica por usuario: cada login reemplaza la sesion anterior.
create table if not exists public.cyclic_user_sessions (
  user_id uuid primary key references public.cyclic_users(id) on delete cascade,
  session_token text not null,
  device_id text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_cyclic_user_sessions_last_seen
  on public.cyclic_user_sessions(last_seen_at);

alter table public.cyclic_user_sessions replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.cyclic_user_sessions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
