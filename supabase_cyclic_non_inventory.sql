-- Codigos no inventariables para conteos ciclicos.
-- Ejecutar una vez en Supabase SQL Editor. Es idempotente y no borra datos.

create table if not exists public.cyclic_non_inventory_products (
  id uuid primary key default gen_random_uuid(),
  product_id uuid null references public.cyclic_products(id),
  sku text not null,
  description text null,
  is_active boolean not null default true,
  updated_by uuid null references public.cyclic_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sku)
);

create index if not exists idx_cyclic_non_inventory_active_sku
  on public.cyclic_non_inventory_products(is_active, sku);

update public.cyclic_non_inventory_products ni
set product_id = p.id,
    description = coalesce(ni.description, p.description),
    updated_at = now()
from public.cyclic_products p
where p.sku = ni.sku
  and ni.product_id is null;

notify pgrst, 'reload schema';
