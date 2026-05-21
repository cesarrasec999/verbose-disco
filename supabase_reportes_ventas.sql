create table if not exists public.erp_store_sales_daily (
  sales_date date not null,
  store_key text not null,
  store_name text not null,
  sales_amount numeric not null default 0,
  cost_amount numeric not null default 0,
  quantity numeric not null default 0,
  documents integer not null default 0,
  source_name text,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (sales_date, store_key)
);

create index if not exists idx_erp_store_sales_daily_store_date
  on public.erp_store_sales_daily (store_key, sales_date desc);

create index if not exists idx_erp_store_sales_daily_date
  on public.erp_store_sales_daily (sales_date desc);

create table if not exists public.business_holidays (
  holiday_date date primary key,
  name text,
  created_at timestamptz not null default now()
);

alter table public.erp_store_sales_daily enable row level security;
alter table public.business_holidays enable row level security;

drop policy if exists "erp_store_sales_daily_select" on public.erp_store_sales_daily;
create policy "erp_store_sales_daily_select"
  on public.erp_store_sales_daily
  for select
  using (true);

drop policy if exists "erp_store_sales_daily_write" on public.erp_store_sales_daily;
create policy "erp_store_sales_daily_write"
  on public.erp_store_sales_daily
  for all
  using (true)
  with check (true);

drop policy if exists "business_holidays_select" on public.business_holidays;
create policy "business_holidays_select"
  on public.business_holidays
  for select
  using (true);

drop policy if exists "business_holidays_write" on public.business_holidays;
create policy "business_holidays_write"
  on public.business_holidays
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.erp_store_sales_daily to anon, authenticated, service_role;
grant select, insert, update, delete on public.business_holidays to anon, authenticated, service_role;

insert into public.erp_sync_status (id, source_path, synced_at, updated_at)
values ('erp_store_sales_daily', '\\192.168.5.51\rms\CESAR\erp-sync', now(), now())
on conflict (id) do update set
  source_path = excluded.source_path,
  updated_at = now();

notify pgrst, 'reload schema';
