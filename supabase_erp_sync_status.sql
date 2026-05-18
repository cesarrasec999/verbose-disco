create table if not exists public.erp_sync_status (
  id text primary key,
  source_path text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.erp_sync_status (id, source_path, synced_at, updated_at)
values ('stock_general', '\\192.168.5.51\rms\CESAR\erp-sync', now(), now())
on conflict (id) do update set
  source_path = excluded.source_path,
  updated_at = now();

create index if not exists idx_erp_sync_status_synced_at
  on public.erp_sync_status(synced_at desc);

notify pgrst, 'reload schema';

-- El proceso de sincronizacion del servidor debe ejecutar esto al terminar:
-- update public.erp_sync_status
-- set synced_at = now(),
--     source_path = '\\192.168.5.51\rms\CESAR\erp-sync',
--     updated_at = now()
-- where id = 'stock_general';
