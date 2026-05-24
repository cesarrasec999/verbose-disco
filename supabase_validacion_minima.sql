-- Migracion minima para activar Validacion en Inventarios Generales.
-- Ejecutar una sola vez. No borra ni actualiza registros existentes.

alter table public.general_inventory_sessions
  add column if not exists validation_enabled boolean not null default false;

create table if not exists public.general_inventory_validation_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.general_inventory_sessions(id) on delete cascade,
  source_recount_item_id uuid references public.general_inventory_recount_items(id) on delete set null,
  product_id uuid not null references public.cyclic_products(id),
  location_id uuid references public.general_inventory_locations(id),
  location_code text,
  ticket text,
  zone text,
  zone_ref text,
  lineal text,
  full_location text,
  recount_type text not null check (recount_type in ('surplus', 'missing')),
  sku text not null,
  description text,
  unit text,
  system_stock numeric(14,3) not null default 0,
  counted_qty numeric(14,3) not null default 0,
  diff_qty numeric(14,3) not null default 0,
  cost_snapshot numeric(14,6) not null default 0,
  value_diff numeric(14,2) not null default 0,
  assigned_operator_id uuid references public.general_inventory_operators(id),
  assigned_by uuid references public.cyclic_users(id),
  status text not null default 'assigned' check (status in ('assigned', 'counted', 'reviewed', 'cancelled')),
  location_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, product_id, location_code, recount_type)
);

create table if not exists public.general_inventory_validation_counts (
  id uuid primary key default gen_random_uuid(),
  validation_item_id uuid not null references public.general_inventory_validation_items(id) on delete cascade,
  session_id uuid not null references public.general_inventory_sessions(id) on delete cascade,
  operator_id uuid not null references public.general_inventory_operators(id),
  location_id uuid references public.general_inventory_locations(id),
  location_code text,
  product_id uuid references public.cyclic_products(id),
  sku text,
  description text,
  unit text,
  quantity numeric(14,3) not null check (quantity >= 0),
  cost_snapshot numeric(14,6) not null default 0,
  note text,
  counted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gi_validation_items_session
  on public.general_inventory_validation_items(session_id);

create index if not exists idx_gi_validation_items_operator
  on public.general_inventory_validation_items(assigned_operator_id);

create index if not exists idx_gi_validation_items_session_operator_status
  on public.general_inventory_validation_items(session_id, assigned_operator_id, status);

create index if not exists idx_gi_validation_items_source
  on public.general_inventory_validation_items(source_recount_item_id);

create index if not exists idx_gi_validation_counts_item
  on public.general_inventory_validation_counts(validation_item_id);

create index if not exists idx_gi_validation_counts_session
  on public.general_inventory_validation_counts(session_id);

create index if not exists idx_gi_validation_counts_session_item
  on public.general_inventory_validation_counts(session_id, validation_item_id);

create index if not exists idx_gi_validation_counts_sku
  on public.general_inventory_validation_counts(session_id, sku);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'general_inventory_validation_items'
  ) then
    alter publication supabase_realtime add table public.general_inventory_validation_items;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'general_inventory_validation_counts'
  ) then
    alter publication supabase_realtime add table public.general_inventory_validation_counts;
  end if;
end;
$$;
