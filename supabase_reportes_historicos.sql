-- Historicos para reportes de inventario, rotaciones y ventas por codigo.
-- Ejecutar en Supabase SQL Editor.

create table if not exists public.inventory_valuation_snapshot_products (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.inventory_valuation_snapshots(id) on delete cascade,
  snapshot_date date not null,
  snapshot_time time not null default '08:00',
  store_id uuid null references public.stores(id) on delete set null,
  store_key text not null,
  store_name text not null,
  sede text,
  product_code text not null,
  description text,
  unit text,
  stock numeric not null default 0,
  cost numeric not null default 0,
  inventory_value numeric not null default 0,
  source_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, store_key, product_code)
);

create index if not exists idx_inventory_snapshot_products_date_store
  on public.inventory_valuation_snapshot_products (snapshot_date desc, store_key, product_code);

create index if not exists idx_inventory_snapshot_products_code
  on public.inventory_valuation_snapshot_products (product_code, snapshot_date desc);

create table if not exists public.inventory_rotation_valuation_daily (
  snapshot_date date not null,
  snapshot_time time not null default '08:00',
  store_key text not null,
  store_name text not null,
  rotation_category text not null default 'SIN ROTACION',
  codes_with_stock integer not null default 0,
  total_units numeric not null default 0,
  inventory_value numeric not null default 0,
  calculated_at timestamptz not null default now(),
  primary key (snapshot_date, store_key, rotation_category)
);

create index if not exists idx_inventory_rotation_valuation_daily_date
  on public.inventory_rotation_valuation_daily (snapshot_date desc, store_key);

create table if not exists public.erp_product_sales_daily (
  sales_date date not null,
  store_key text not null,
  store_name text not null,
  product_code text not null,
  description text,
  unit text,
  sales_amount numeric not null default 0,
  cost_amount numeric not null default 0,
  quantity numeric not null default 0,
  documents integer not null default 0,
  source_name text,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (sales_date, store_key, product_code)
);

create index if not exists idx_erp_product_sales_daily_store_date
  on public.erp_product_sales_daily (store_key, sales_date desc);

create index if not exists idx_erp_product_sales_daily_code_date
  on public.erp_product_sales_daily (product_code, sales_date desc);

alter table public.inventory_valuation_snapshot_products enable row level security;
alter table public.inventory_rotation_valuation_daily enable row level security;
alter table public.erp_product_sales_daily enable row level security;

drop policy if exists "inventory valuation snapshot products read" on public.inventory_valuation_snapshot_products;
create policy "inventory valuation snapshot products read"
on public.inventory_valuation_snapshot_products
for select
using (true);

drop policy if exists "inventory valuation snapshot products write" on public.inventory_valuation_snapshot_products;
create policy "inventory valuation snapshot products write"
on public.inventory_valuation_snapshot_products
for all
using (true)
with check (true);

drop policy if exists "inventory rotation valuation daily read" on public.inventory_rotation_valuation_daily;
create policy "inventory rotation valuation daily read"
on public.inventory_rotation_valuation_daily
for select
using (true);

drop policy if exists "inventory rotation valuation daily write" on public.inventory_rotation_valuation_daily;
create policy "inventory rotation valuation daily write"
on public.inventory_rotation_valuation_daily
for all
using (true)
with check (true);

drop policy if exists "erp product sales daily read" on public.erp_product_sales_daily;
create policy "erp product sales daily read"
on public.erp_product_sales_daily
for select
using (true);

drop policy if exists "erp product sales daily write" on public.erp_product_sales_daily;
create policy "erp product sales daily write"
on public.erp_product_sales_daily
for all
using (true)
with check (true);

grant select, insert, update, delete on public.inventory_valuation_snapshot_products to anon, authenticated, service_role;
grant select, insert, update, delete on public.inventory_rotation_valuation_daily to anon, authenticated, service_role;
grant select, insert, update, delete on public.erp_product_sales_daily to anon, authenticated, service_role;

insert into public.erp_sync_status (id, source_path, synced_at, updated_at)
values ('erp_product_sales_daily', '\\192.168.5.51\rms\CESAR\erp-sync', now(), now())
on conflict (id) do update set
  source_path = excluded.source_path,
  updated_at = now();

notify pgrst, 'reload schema';
