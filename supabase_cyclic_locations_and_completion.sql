-- Ubicaciones reutilizables y memoria de códigos ya cumplidos en cíclicos.
-- Ejecutar una vez en Supabase SQL Editor.

create table if not exists public.product_locations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid null references public.stores(id) on delete cascade,
  product_id uuid not null references public.cyclic_products(id) on delete cascade,
  sku text not null,
  location text not null,
  is_active boolean not null default true,
  updated_by uuid null references public.cyclic_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, product_id, location)
);

create index if not exists idx_product_locations_store_sku
  on public.product_locations(store_id, sku)
  where is_active = true;

create index if not exists idx_product_locations_product
  on public.product_locations(product_id)
  where is_active = true;

alter table public.product_locations add column if not exists last_source text;
alter table public.product_locations add column if not exists last_seen_at timestamptz not null default now();
alter table public.product_locations add column if not exists cyclic_registered boolean not null default false;
alter table public.product_locations add column if not exists audit_registered boolean not null default false;
alter table public.product_locations add column if not exists general_inventory_registered boolean not null default false;

create index if not exists idx_product_locations_last_source
  on public.product_locations(last_source, last_seen_at desc)
  where is_active = true;

create table if not exists public.cyclic_completed_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.cyclic_products(id) on delete cascade,
  sku text not null,
  completed_date date not null,
  source_assignment_id uuid null references public.cyclic_assignments(id) on delete set null,
  completed_by uuid null references public.cyclic_users(id),
  created_at timestamptz not null default now(),
  unique (store_id, product_id)
);

-- La restriccion unique (store_id, product_id) ya crea un indice equivalente.

notify pgrst, 'reload schema';
