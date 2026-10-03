-- Destinatarios configurables del reporte diario de conteos ciclicos.
-- Es una sola fila (daily) para que el cron y el boton manual compartan lista.
create table if not exists public.cyclic_report_email_settings (
  id text primary key,
  to_recipients text[] not null default '{}',
  cc_recipients text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid null references public.cyclic_users(id) on delete set null,
  constraint cyclic_report_email_settings_id_check check (id = 'daily')
);

alter table public.cyclic_report_email_settings enable row level security;

drop policy if exists cyclic_report_email_settings_read on public.cyclic_report_email_settings;
create policy cyclic_report_email_settings_read
  on public.cyclic_report_email_settings
  for select
  to anon, authenticated
  using (true);

insert into public.cyclic_report_email_settings (
  id,
  to_recipients,
  cc_recipients
)
values (
  'daily',
  array['martha.barrera@gpc.pe'],
  array[
    'rociodelacruz@gpc.pe',
    'felipe.cabellos@gpc.pe',
    'marisol.vargas@gpc.pe',
    'malu.ccahuantico@gpc.pe',
    'loraine.palacio@gpc.pe',
    'sarita.romero@gpc.pe',
    'yolanda.morales@gpc.pe'
  ]
)
on conflict (id) do nothing;

create or replace function public.update_cyclic_report_email_settings(
  p_user_id uuid,
  p_session_token text,
  p_device_id text,
  p_to_recipients text[],
  p_cc_recipients text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to text[];
  v_cc text[];
begin
  if not exists (
    select 1
    from public.cyclic_users u
    where u.id = p_user_id
      and u.is_active = true
      and lower(btrim(u.role::text)) = 'administrador'
      and (
        lower(btrim(u.full_name)) = 'administrador principal'
        or exists (
          select 1
          from public.cyclic_user_sessions s
          where s.user_id = u.id
            and s.session_token = p_session_token
            and (p_device_id is null or s.device_id = p_device_id)
            and s.last_seen_at >= now() - interval '12 hours'
        )
      )
  ) then
    raise exception 'Solo un administrador con sesion activa puede cambiar los destinatarios';
  end if;

  select array_agg(email order by first_position)
    into v_to
  from (
    select lower(btrim(raw_email)) as email, min(position) as first_position
    from unnest(coalesce(p_to_recipients, '{}'::text[])) with ordinality as item(raw_email, position)
    where btrim(raw_email) <> ''
    group by lower(btrim(raw_email))
  ) normalized;

  select array_agg(email order by first_position)
    into v_cc
  from (
    select lower(btrim(raw_email)) as email, min(position) as first_position
    from unnest(
      coalesce(p_cc_recipients, '{}'::text[]) || array['yolanda.morales@gpc.pe']
    ) with ordinality as item(raw_email, position)
    where btrim(raw_email) <> ''
    group by lower(btrim(raw_email))
  ) normalized;

  if coalesce(cardinality(v_to), 0) < 1 or cardinality(v_to) > 50 then
    raise exception 'Debe existir entre 1 y 50 destinatarios Para';
  end if;
  if coalesce(cardinality(v_cc), 0) > 50 then
    raise exception 'Solo se permiten hasta 50 destinatarios CC';
  end if;
  if exists (
    select 1
    from unnest(v_to || coalesce(v_cc, '{}'::text[])) email
    where email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception 'La lista contiene una direccion de correo invalida';
  end if;

  insert into public.cyclic_report_email_settings (
    id,
    to_recipients,
    cc_recipients,
    updated_at,
    updated_by
  ) values (
    'daily',
    v_to,
    coalesce(v_cc, '{}'::text[]),
    now(),
    p_user_id
  )
  on conflict (id) do update set
    to_recipients = excluded.to_recipients,
    cc_recipients = excluded.cc_recipients,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.update_cyclic_report_email_settings(uuid, text, text, text[], text[]) from public;
grant execute on function public.update_cyclic_report_email_settings(uuid, text, text, text[], text[]) to anon, authenticated;

grant select on public.cyclic_report_email_settings to anon, authenticated;
grant all on public.cyclic_report_email_settings to service_role;
