alter table public.picking_assignments
  add column if not exists picking_date date;

create index if not exists idx_picking_assignments_picking_date
  on public.picking_assignments (picking_date, request_id);

notify pgrst, 'reload schema';
