-- Tablas para el módulo /auditoria
-- Ejecutar en Supabase SQL Editor antes de usar la pantalla.

create table if not exists public.audit_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  auditor_id uuid not null references public.cyclic_users(id),
  status text not null default 'in_progress' check (status in ('in_progress', 'finished', 'cancelled')),
  observation text null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  created_at timestamptz not null default now()
);

alter table public.audit_sessions
  add column if not exists observation text null;

create table if not exists public.audit_session_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.audit_sessions(id) on delete cascade,
  product_id uuid not null references public.cyclic_products(id),
  source text not null default 'selected' check (source in ('selected', 'extra')),
  system_stock numeric not null default 0,
  cost_snapshot numeric not null default 0,
  observation text null,
  created_at timestamptz not null default now(),
  unique (session_id, product_id)
);

alter table public.audit_session_items
  add column if not exists observation text null;

create table if not exists public.audit_counts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.audit_sessions(id) on delete cascade,
  item_id uuid not null references public.audit_session_items(id) on delete cascade,
  product_id uuid not null references public.cyclic_products(id),
  location text not null,
  quantity numeric not null default 0,
  counted_by uuid not null references public.cyclic_users(id),
  counted_at timestamptz not null default now()
);

create index if not exists idx_audit_sessions_store_status on public.audit_sessions(store_id, status);
create index if not exists idx_audit_items_session on public.audit_session_items(session_id);
create index if not exists idx_audit_counts_session on public.audit_counts(session_id);
create index if not exists idx_audit_counts_item on public.audit_counts(item_id);
