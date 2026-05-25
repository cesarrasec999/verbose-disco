-- Fundacion WMS de convivencia.
-- Seguro para ejecutar: solo crea tablas/indices nuevos si no existen.
-- No borra, no migra y no actualiza registros actuales.

create extension if not exists pgcrypto;

create table if not exists public.wms_workflows (
  id uuid primary key default gen_random_uuid(),
  source_module text not null check (source_module in ('ciclico', 'auditoria', 'inventario_general', 'abastecimiento', 'manual')),
  source_id uuid,
  store_id uuid references public.stores(id) on delete set null,
  store_name text,
  workflow_type text not null,
  status text not null default 'open' check (status in ('planned', 'open', 'paused', 'finished', 'cancelled')),
  scheduled_date date,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wms_tasks (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid references public.wms_workflows(id) on delete set null,
  source_module text not null check (source_module in ('ciclico', 'auditoria', 'inventario_general', 'abastecimiento', 'manual')),
  source_table text,
  source_id uuid,
  task_type text not null check (task_type in ('conteo', 'reconteo', 'validacion', 'ubicacion', 'consulta_stock', 'transferencia', 'ajuste')),
  status text not null default 'pending' check (status in ('pending', 'assigned', 'in_progress', 'saved', 'reviewed', 'cancelled')),
  store_id uuid references public.stores(id) on delete set null,
  product_id uuid references public.cyclic_products(id) on delete set null,
  sku text,
  assigned_operator_id uuid,
  assigned_operator_name text,
  priority integer not null default 0,
  due_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wms_task_lines (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.wms_tasks(id) on delete cascade,
  source_table text,
  source_id uuid,
  location_id uuid,
  location_code text,
  sku text,
  unit text,
  system_qty numeric(14, 3) not null default 0,
  counted_qty numeric(14, 3) not null default 0,
  diff_qty numeric(14, 3) generated always as (counted_qty - system_qty) stored,
  cost numeric(14, 6) not null default 0,
  counted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wms_events (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid references public.wms_workflows(id) on delete set null,
  task_id uuid references public.wms_tasks(id) on delete set null,
  event_type text not null,
  actor_id uuid,
  actor_name text,
  source_module text,
  source_table text,
  source_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.wms_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_module text not null check (source_module in ('ciclico', 'auditoria', 'inventario_general', 'abastecimiento', 'manual', 'rms_sync')),
  source_id uuid,
  store_id uuid references public.stores(id) on delete set null,
  store_key text,
  product_id uuid references public.cyclic_products(id) on delete set null,
  sku text not null,
  stock_qty numeric(14, 3) not null default 0,
  cost numeric(14, 6) not null default 0,
  is_protected boolean not null default false,
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.wms_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  source_system text not null default 'RMS',
  status text not null default 'running' check (status in ('running', 'success', 'warning', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_read integer not null default 0,
  rows_changed integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_wms_workflows_source on public.wms_workflows(source_module, source_id);
create index if not exists idx_wms_workflows_store_status on public.wms_workflows(store_id, status, scheduled_date);
create index if not exists idx_wms_tasks_source on public.wms_tasks(source_module, source_table, source_id);
create index if not exists idx_wms_tasks_operator_status on public.wms_tasks(assigned_operator_id, status, created_at desc);
create index if not exists idx_wms_tasks_store_sku on public.wms_tasks(store_id, sku);
create index if not exists idx_wms_task_lines_task on public.wms_task_lines(task_id);
create index if not exists idx_wms_task_lines_sku_location on public.wms_task_lines(sku, location_code);
create index if not exists idx_wms_events_task_created on public.wms_events(task_id, created_at desc);
create index if not exists idx_wms_events_source on public.wms_events(source_module, source_table, source_id);
create index if not exists idx_wms_stock_snapshots_source on public.wms_stock_snapshots(source_module, source_id);
create index if not exists idx_wms_stock_snapshots_store_sku on public.wms_stock_snapshots(store_key, sku, captured_at desc);
create index if not exists idx_wms_sync_jobs_name_started on public.wms_sync_jobs(job_name, started_at desc);
