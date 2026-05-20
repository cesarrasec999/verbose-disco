-- Historico de fotografias de valorizado de inventario
-- Ejecutar una sola vez en Supabase SQL Editor.

create table if not exists public.inventory_valuation_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  snapshot_time time not null default '08:00',
  source_name text,
  notes text,
  total_stores integer not null default 0,
  total_codes integer not null default 0,
  total_units numeric not null default 0,
  total_value numeric not null default 0,
  uploaded_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_valuation_snapshot_stores (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.inventory_valuation_snapshots(id) on delete cascade,
  store_id uuid null references public.stores(id) on delete set null,
  store_name text not null,
  sede text,
  codes_with_stock integer not null default 0,
  total_units numeric not null default 0,
  inventory_value numeric not null default 0,
  missing_cost_codes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, store_name)
);

create index if not exists idx_inventory_valuation_snapshots_date
  on public.inventory_valuation_snapshots(snapshot_date desc, snapshot_time desc);

create unique index if not exists uq_inventory_valuation_snapshots_date_time
  on public.inventory_valuation_snapshots(snapshot_date, snapshot_time);

create index if not exists idx_inventory_valuation_snapshot_stores_snapshot
  on public.inventory_valuation_snapshot_stores(snapshot_id);

alter table public.inventory_valuation_snapshots enable row level security;
alter table public.inventory_valuation_snapshot_stores enable row level security;

drop policy if exists "inventory valuation snapshots read" on public.inventory_valuation_snapshots;
create policy "inventory valuation snapshots read"
on public.inventory_valuation_snapshots
for select
using (true);

drop policy if exists "inventory valuation snapshots write" on public.inventory_valuation_snapshots;
create policy "inventory valuation snapshots write"
on public.inventory_valuation_snapshots
for all
using (true)
with check (true);

drop policy if exists "inventory valuation snapshot stores read" on public.inventory_valuation_snapshot_stores;
create policy "inventory valuation snapshot stores read"
on public.inventory_valuation_snapshot_stores
for select
using (true);

drop policy if exists "inventory valuation snapshot stores write" on public.inventory_valuation_snapshot_stores;
create policy "inventory valuation snapshot stores write"
on public.inventory_valuation_snapshot_stores
for all
using (true)
with check (true);
