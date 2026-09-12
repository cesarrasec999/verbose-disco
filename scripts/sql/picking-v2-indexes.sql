-- Execute statements INDIVIDUALLY outside a transaction in the target DB.
-- CONCURRENTLY keeps the live scan/assignment tables writable while building.
-- If interrupted, inspect pg_index.indisvalid before retrying; do not drop any
-- existing index automatically. This script does not remove redundant indexes.
create index concurrently if not exists idx_picking_tasks_cursor_v2
  on public.picking_assignments(picker_id,picking_date,created_at desc,id desc)
  where status<>'cancelado';
create index concurrently if not exists idx_picking_tasks_legacy_v2
  on public.picking_assignments(picker_id,created_at desc,id desc)
  where status<>'cancelado' and picking_date is null;
create index concurrently if not exists idx_picking_scans_cursor_v2
  on public.picking_scans(picker_id,request_id,created_at desc,id desc);
create index concurrently if not exists idx_picking_requests_cursor_v2
  on public.picking_requests((coalesce(creation_date,created_at)) desc,id desc) where hidden_at is null;
create index concurrently if not exists idx_picking_lines_cursor_v2
  on public.picking_request_lines(request_id,id);
