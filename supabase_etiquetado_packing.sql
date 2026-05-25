-- Modulo Etiquetado/Packing.
-- Ejecutar una sola vez. No borra ni modifica registros existentes.

create table if not exists public.packing_label_tasks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete set null,
  product_id uuid references public.cyclic_products(id) on delete set null,
  product_code text not null,
  description text,
  unit text,
  action_type text not null check (action_type in ('etiquetar', 'armar')),
  quantity numeric not null default 1,
  status text not null default 'pendiente' check (status in ('pendiente', 'hecho', 'cancelado')),
  note text,
  created_by uuid references public.cyclic_users(id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_packing_label_tasks_created_at
  on public.packing_label_tasks(created_at desc);

create index if not exists idx_packing_label_tasks_product_code
  on public.packing_label_tasks(product_code);

create index if not exists idx_packing_label_tasks_store_status
  on public.packing_label_tasks(store_id, status);

alter table public.packing_label_tasks enable row level security;

drop policy if exists "packing_label_tasks_select" on public.packing_label_tasks;
create policy "packing_label_tasks_select"
on public.packing_label_tasks for select
to anon, authenticated
using (true);

drop policy if exists "packing_label_tasks_insert" on public.packing_label_tasks;
create policy "packing_label_tasks_insert"
on public.packing_label_tasks for insert
to anon, authenticated
with check (true);

drop policy if exists "packing_label_tasks_update" on public.packing_label_tasks;
create policy "packing_label_tasks_update"
on public.packing_label_tasks for update
to anon, authenticated
using (true)
with check (true);
