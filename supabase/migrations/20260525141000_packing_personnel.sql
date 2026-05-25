-- Personal disponible para Etiquetado/Packing.

create table if not exists public.packing_personnel (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete set null,
  full_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint packing_personnel_full_name_not_empty check (length(trim(full_name)) > 0)
);

create unique index if not exists idx_packing_personnel_store_name
  on public.packing_personnel(coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(full_name)));

create index if not exists idx_packing_personnel_store_active
  on public.packing_personnel(store_id, is_active, full_name);

alter table public.packing_personnel enable row level security;

drop policy if exists "packing_personnel_select" on public.packing_personnel;
create policy "packing_personnel_select"
on public.packing_personnel for select
to anon, authenticated
using (true);

drop policy if exists "packing_personnel_insert" on public.packing_personnel;
create policy "packing_personnel_insert"
on public.packing_personnel for insert
to anon, authenticated
with check (true);

drop policy if exists "packing_personnel_update" on public.packing_personnel;
create policy "packing_personnel_update"
on public.packing_personnel for update
to anon, authenticated
using (true)
with check (true);
