-- Impide que un operario registre o complete recepciones destinadas a otra
-- tienda. También conserva y retira del flujo operativo el incidente
-- confirmado del 21/09/2026 antes de recalcular el estado de cada documento.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table if not exists public.reception_cross_store_incidents (
  id uuid primary key default gen_random_uuid(),
  incident_key text not null unique,
  actor_id uuid references public.cyclic_users(id),
  actor_name text,
  first_event_at timestamptz,
  last_event_at timestamptz,
  scan_count integer not null default 0,
  request_count integer not null default 0,
  completed_request_count integer not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.reception_cross_store_scan_archive (
  incident_id uuid not null references public.reception_cross_store_incidents(id),
  original_scan_id uuid not null,
  request_id uuid not null,
  row_data jsonb not null,
  archived_at timestamptz not null default now(),
  primary key (incident_id, original_scan_id)
);

create table if not exists public.reception_cross_store_request_archive (
  incident_id uuid not null references public.reception_cross_store_incidents(id),
  original_request_id uuid not null,
  row_data jsonb not null,
  archived_at timestamptz not null default now(),
  primary key (incident_id, original_request_id)
);

alter table public.reception_cross_store_incidents enable row level security;
alter table public.reception_cross_store_scan_archive enable row level security;
alter table public.reception_cross_store_request_archive enable row level security;
revoke all on public.reception_cross_store_incidents from public, anon, authenticated;
revoke all on public.reception_cross_store_scan_archive from public, anon, authenticated;
revoke all on public.reception_cross_store_request_archive from public, anon, authenticated;

create or replace function public.reception_actor_can_access_request(
  p_actor_id uuid,
  p_request_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.cyclic_users u
    left join public.stores s on s.id = u.store_id
    join public.reception_requests r on r.id = p_request_id
    where u.id = p_actor_id
      and coalesce(u.is_active, true)
      and (
        coalesce(u.can_access_all_stores, false)
        or u.role in ('Administrador', 'Supervisor', 'Validador')
        or (
          u.store_id is not null
          and (
            btrim(coalesce(r.destination_store_code, '')) = btrim(coalesce(s.code, ''))
            or upper(btrim(coalesce(r.destination_store_name, ''))) = upper(btrim(coalesce(s.erp_sede, '')))
            or upper(btrim(coalesce(r.destination_store_name, ''))) = upper(btrim(coalesce(s.name, '')))
            or (s.code = 'CD-GPC' and btrim(coalesce(r.destination_store_code, '')) = '0')
          )
        )
      )
  );
$$;

revoke all on function public.reception_actor_can_access_request(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.validate_reception_scan_store_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.operator_id is null then
    raise exception using
      errcode = '42501',
      message = 'La recepcion requiere un operador identificado.';
  end if;

  if not public.reception_actor_can_access_request(new.operator_id, new.request_id) then
    raise exception using
      errcode = '42501',
      message = 'No puedes registrar una recepcion destinada a otra tienda.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_reception_scan_store_scope
  on public.reception_scans;
create trigger trg_validate_reception_scan_store_scope
before insert or update of request_id, operator_id
on public.reception_scans
for each row execute function public.validate_reception_scan_store_scope();

create or replace function public.validate_reception_completion_store_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.reception_status = 'completed'
     and (
       old.reception_status is distinct from 'completed'
       or new.completed_by_id is distinct from old.completed_by_id
     ) then
    if new.completed_by_id is null then
      raise exception using
        errcode = '42501',
        message = 'La recepcion completada requiere un operador identificado.';
    end if;

    if not public.reception_actor_can_access_request(new.completed_by_id, new.id) then
      raise exception using
        errcode = '42501',
        message = 'No puedes completar una recepcion destinada a otra tienda.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_reception_completion_store_scope
  on public.reception_requests;
create trigger trg_validate_reception_completion_store_scope
before update of reception_status, completed_by_id
on public.reception_requests
for each row execute function public.validate_reception_completion_store_scope();

do $incident$
declare
  v_incident_id uuid;
  v_actor_id constant uuid := '39479a6b-6cb8-4ce4-9d4d-d0eeead88843'::uuid;
begin
  insert into public.reception_cross_store_incidents (
    incident_key, actor_id, actor_name, first_event_at, last_event_at,
    scan_count, request_count, completed_request_count, notes
  )
  select
    'almacenlurin-2026-09-21-cross-store',
    v_actor_id,
    max(rs.operator_name),
    min(rs.created_at),
    max(rs.created_at),
    count(*)::integer,
    count(distinct rs.request_id)::integer,
    count(distinct r.id) filter (
      where r.reception_status = 'completed' and r.completed_by_id = v_actor_id
    )::integer,
    'Lecturas de un operario de Lurin sobre abastecimientos destinados a otras sedes; preservadas antes de reabrir los documentos.'
  from public.reception_scans rs
  join public.reception_requests r on r.id = rs.request_id
  where rs.operator_id = v_actor_id
    and not public.reception_actor_can_access_request(rs.operator_id, rs.request_id)
  on conflict (incident_key) do update set
    scan_count = excluded.scan_count,
    request_count = excluded.request_count,
    completed_request_count = excluded.completed_request_count,
    notes = excluded.notes
  returning id into v_incident_id;

  insert into public.reception_cross_store_scan_archive (
    incident_id, original_scan_id, request_id, row_data
  )
  select v_incident_id, rs.id, rs.request_id, to_jsonb(rs)
  from public.reception_scans rs
  where rs.operator_id = v_actor_id
    and not public.reception_actor_can_access_request(rs.operator_id, rs.request_id)
  on conflict (incident_id, original_scan_id) do nothing;

  insert into public.reception_cross_store_request_archive (
    incident_id, original_request_id, row_data
  )
  select distinct v_incident_id, r.id, to_jsonb(r)
  from public.reception_requests r
  join public.reception_cross_store_scan_archive a
    on a.incident_id = v_incident_id and a.request_id = r.id
  on conflict (incident_id, original_request_id) do nothing;

  delete from public.reception_scans rs
  using public.reception_cross_store_scan_archive a
  where a.incident_id = v_incident_id
    and rs.id = a.original_scan_id;

  update public.reception_requests r
  set reception_status = case
        when exists (
          select 1 from public.reception_scans rs where rs.request_id = r.id
        ) then 'in_progress'
        else 'pending'
      end,
      completed_at = null,
      completed_by_id = null,
      completed_by_name = null,
      updated_at = now()
  where r.completed_by_id = v_actor_id
    and exists (
      select 1
      from public.reception_cross_store_request_archive a
      where a.incident_id = v_incident_id
        and a.original_request_id = r.id
    )
    and not public.reception_actor_can_access_request(v_actor_id, r.id);

  update public.reception_requests r
  set reception_status = 'pending',
      updated_at = now()
  where r.reception_status = 'in_progress'
    and not exists (
      select 1 from public.reception_scans rs where rs.request_id = r.id
    )
    and exists (
      select 1
      from public.reception_cross_store_request_archive a
      where a.incident_id = v_incident_id
        and a.original_request_id = r.id
    );
end
$incident$;

revoke all on function public.validate_reception_scan_store_scope()
  from public, anon, authenticated;
revoke all on function public.validate_reception_completion_store_scope()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
