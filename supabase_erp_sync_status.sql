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
  synced_at = excluded.synced_at,
  updated_at = now();

create index if not exists idx_erp_sync_status_synced_at
  on public.erp_sync_status(synced_at desc);

create or replace function public.touch_stock_general_sync_status()
returns trigger
language plpgsql
as $$
begin
  insert into public.erp_sync_status (id, source_path, synced_at, updated_at)
  values ('stock_general', '\\192.168.5.51\rms\CESAR\erp-sync', now(), now())
  on conflict (id) do update set
    source_path = excluded.source_path,
    synced_at = excluded.synced_at,
    updated_at = excluded.updated_at;
  return null;
end;
$$;

drop trigger if exists trg_touch_stock_general_sync_status on public.stock_general;
create trigger trg_touch_stock_general_sync_status
after insert or update or delete on public.stock_general
for each statement
execute function public.touch_stock_general_sync_status();

notify pgrst, 'reload schema';

-- Opcional: si prefieres hacerlo desde el proceso del servidor al terminar:
-- update public.erp_sync_status
-- set synced_at = now(),
--     source_path = '\\192.168.5.51\rms\CESAR\erp-sync',
--     updated_at = now()
-- where id = 'stock_general';
