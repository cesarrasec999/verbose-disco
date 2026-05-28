-- Endurece la sesion unica sin borrar datos existentes.
-- Mantiene una sola fila por usuario y agrega metadata/indices para checks mas baratos.

alter table public.cyclic_user_sessions
  add column if not exists user_agent text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_cyclic_user_sessions_device
  on public.cyclic_user_sessions(device_id);

create index if not exists idx_cyclic_user_sessions_user_token
  on public.cyclic_user_sessions(user_id, session_token);

create or replace function public.touch_cyclic_user_session_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_cyclic_user_session_updated_at on public.cyclic_user_sessions;
create trigger trg_touch_cyclic_user_session_updated_at
before update on public.cyclic_user_sessions
for each row
execute function public.touch_cyclic_user_session_updated_at();
