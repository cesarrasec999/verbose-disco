-- Picking WMS para requerimientos de inventario ERP.
-- Ejecutar en Supabase antes de activar sync-picking.js.

create table if not exists public.picking_requests (
  id uuid primary key default gen_random_uuid(),
  erp_inv_request_id text not null unique,
  inv_request_no text,
  doc_number text,
  status_code text,
  status_name text,
  request_date timestamptz,
  creation_date timestamptz,
  destination_store_code text not null,
  destination_store_name text,
  source_store_code text not null,
  source_store_name text,
  reason text,
  notes text,
  line_count integer not null default 0,
  qty_requested_total numeric(18, 6) not null default 0,
  qty_pending_total numeric(18, 6) not null default 0,
  source_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.picking_requests
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references public.cyclic_users(id),
  add column if not exists hidden_by_name text,
  add column if not exists hidden_reason text;

create table if not exists public.picking_request_lines (
  id text primary key,
  request_id uuid references public.picking_requests(id) on delete cascade,
  erp_inv_request_id text not null,
  line_id integer not null,
  sku text,
  product_code text not null,
  barcode text,
  description text,
  unit text,
  qty_requested numeric(18, 6) not null default 0,
  qty_pending numeric(18, 6) not null default 0,
  assigned_qty numeric(18, 6) not null default 0,
  picked_qty numeric(18, 6) not null default 0,
  source_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (erp_inv_request_id, line_id)
);

create table if not exists public.picking_assignments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.picking_requests(id) on delete cascade,
  line_id text not null references public.picking_request_lines(id) on delete cascade,
  picker_id uuid references public.cyclic_users(id),
  picker_name text not null,
  assigned_qty numeric(18, 6) not null default 0,
  picked_qty numeric(18, 6) not null default 0,
  status text not null default 'pendiente',
  created_by uuid references public.cyclic_users(id),
  created_by_name text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.picking_scans (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.picking_assignments(id) on delete cascade,
  request_id uuid not null references public.picking_requests(id) on delete cascade,
  line_id text not null references public.picking_request_lines(id) on delete cascade,
  picker_id uuid references public.cyclic_users(id),
  picker_name text,
  location_code text not null,
  scanned_product_code text,
  scanned_barcode text,
  qty numeric(18, 6) not null default 0,
  is_match boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_picking_requests_active
  on public.picking_requests (status_code, reason, creation_date desc);

create index if not exists idx_picking_requests_source
  on public.picking_requests (source_store_code, creation_date desc);

create index if not exists idx_picking_lines_request
  on public.picking_request_lines (request_id);

create index if not exists idx_picking_lines_product
  on public.picking_request_lines (product_code, barcode, sku);

create index if not exists idx_picking_assignments_picker
  on public.picking_assignments (picker_id, status, created_at desc);

create index if not exists idx_picking_assignments_request
  on public.picking_assignments (request_id, line_id);

create index if not exists idx_picking_scans_assignment
  on public.picking_scans (assignment_id, created_at desc);

create or replace function public.refresh_picking_line_totals()
returns trigger
language plpgsql
as $$
begin
  update public.picking_request_lines line
  set assigned_qty = coalesce((
        select sum(assigned_qty)
        from public.picking_assignments a
        where a.line_id = line.id
          and a.status <> 'cancelado'
      ), 0),
      picked_qty = coalesce((
        select sum(picked_qty)
        from public.picking_assignments a
        where a.line_id = line.id
          and a.status <> 'cancelado'
      ), 0),
      updated_at = now()
  where line.id = coalesce(new.line_id, old.line_id);

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_refresh_picking_line_totals on public.picking_assignments;
create trigger trg_refresh_picking_line_totals
after insert or update or delete on public.picking_assignments
for each row execute function public.refresh_picking_line_totals();

grant select, insert, update, delete on public.picking_requests to anon, authenticated, service_role;
grant select, insert, update, delete on public.picking_request_lines to anon, authenticated, service_role;
grant select, insert, update, delete on public.picking_assignments to anon, authenticated, service_role;
grant select, insert, update, delete on public.picking_scans to anon, authenticated, service_role;

insert into public.erp_sync_status (id, source_path, synced_at, updated_at)
values ('picking_requests', '\\192.168.5.53\Users\cesar.quispe\erp-sync', now(), now())
on conflict (id) do update set
  source_path = excluded.source_path,
  updated_at = now();

notify pgrst, 'reload schema';
