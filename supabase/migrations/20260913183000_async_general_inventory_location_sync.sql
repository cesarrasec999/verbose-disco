-- El cierre de Inventario General no debe esperar la reconstrucción completa
-- de product_locations. Antes, el trigger ejecutaba ese trabajo dentro del
-- UPDATE a status='finished'; si demoraba más que statement_timeout, también
-- se revertía el cierre y el usuario debía intentarlo otra vez.
--
-- Esta cola es durable y aditiva: no elimina conteos, reconteos, sesiones ni
-- ubicaciones. El cierre solo encola; un worker procesa después la misma
-- función de sincronización verídica basada en la última sesión finalizada.

create table if not exists public.general_inventory_location_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.general_inventory_sessions(id),
  store_id uuid not null references public.stores(id),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  upserted_locations integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_gi_location_sync_jobs_pending
  on public.general_inventory_location_sync_jobs (status, created_at, id)
  where status in ('pending', 'failed');

alter table public.general_inventory_location_sync_jobs enable row level security;
revoke all on public.general_inventory_location_sync_jobs from anon, authenticated;

create or replace function public.enqueue_general_inventory_location_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'finished'
     and new.finished_at is not null
     and (
       old.status is distinct from 'finished'
       or old.finished_at is distinct from new.finished_at
     ) then
    insert into public.general_inventory_location_sync_jobs (
      session_id, store_id, status, attempts, upserted_locations,
      last_error, started_at, completed_at, updated_at
    ) values (
      new.id, new.store_id, 'pending', 0, 0,
      null, null, null, now()
    )
    on conflict (session_id) do update
       set store_id = excluded.store_id,
           status = 'pending',
           attempts = 0,
           upserted_locations = 0,
           last_error = null,
           started_at = null,
           completed_at = null,
           updated_at = now();
  end if;
  return new;
end;
$$;

-- Reemplaza el trigger pesado conservando su nombre operativo. Desde aquí el
-- UPDATE de cierre solo escribe una fila pequeña en la cola.
drop trigger if exists general_inventory_session_location_sync
  on public.general_inventory_sessions;
create trigger general_inventory_session_location_sync
after update of status, finished_at on public.general_inventory_sessions
for each row execute function public.enqueue_general_inventory_location_sync();

create or replace function public.process_general_inventory_location_sync_queue(
  p_limit integer default 1,
  p_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job record;
  v_upserted integer;
  v_processed integer := 0;
  v_completed integer := 0;
  v_failed integer := 0;
begin
  for v_job in
    select j.id, j.session_id, j.store_id, j.attempts
      from public.general_inventory_location_sync_jobs j
     where j.status in ('pending', 'failed')
       and j.attempts < 10
       and (p_session_id is null or j.session_id = p_session_id)
     order by j.created_at, j.id
     for update skip locked
     limit least(greatest(coalesce(p_limit, 1), 1), 5)
  loop
    v_processed := v_processed + 1;
    begin
      update public.general_inventory_location_sync_jobs j
         set status = 'processing',
             attempts = v_job.attempts + 1,
             started_at = now(),
             last_error = null,
             updated_at = now()
       where j.id = v_job.id;

      -- La función vigente selecciona exclusivamente la última sesión
      -- finalizada de la tienda y conserva el historial mediante UPSERT.
      v_upserted := public.sync_general_inventory_locations_for_store(v_job.store_id);

      update public.general_inventory_location_sync_jobs j
         set status = 'completed',
             upserted_locations = coalesce(v_upserted, 0),
             completed_at = now(),
             last_error = null,
             updated_at = now()
       where j.id = v_job.id;
      v_completed := v_completed + 1;
    exception when others then
      update public.general_inventory_location_sync_jobs j
         set status = case when v_job.attempts + 1 >= 10 then 'failed' else 'pending' end,
             attempts = v_job.attempts + 1,
             last_error = left(sqlerrm, 2000),
             updated_at = now()
       where j.id = v_job.id;
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'completed', v_completed,
    'failed', v_failed
  );
end;
$$;

revoke all on function public.process_general_inventory_location_sync_queue(integer, uuid) from public;
grant execute on function public.process_general_inventory_location_sync_queue(integer, uuid) to anon, authenticated;

-- El cron es el respaldo durable si el usuario cierra el navegador justo
-- después de finalizar. Supabase incluye pg_cron; la creación es idempotente.
create extension if not exists pg_cron;

do $$
begin
  if not exists (
    select 1 from cron.job
    where jobname = 'general-inventory-location-sync'
  ) then
    perform cron.schedule(
      'general-inventory-location-sync',
      '* * * * *',
      'select public.process_general_inventory_location_sync_queue(1, null);'
    );
  end if;
end;
$$;

notify pgrst, 'reload schema';
