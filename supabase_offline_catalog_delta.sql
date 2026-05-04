-- Base para que la app instalada descargue solo cambios diarios del catalogo offline.
-- Ejecutar en Supabase antes de usar la version incremental.

alter table if exists public.stores
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.codigos_barra
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.codigos_barra
  add column if not exists is_active boolean not null default true;

create index if not exists idx_stores_updated_at
  on public.stores(updated_at);

create index if not exists idx_codigos_barra_updated_at
  on public.codigos_barra(updated_at);

create index if not exists idx_codigos_barra_active_updated_at
  on public.codigos_barra(is_active, updated_at);

create index if not exists idx_cyclic_products_updated_at
  on public.cyclic_products(updated_at);

notify pgrst, 'reload schema';
