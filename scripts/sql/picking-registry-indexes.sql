-- Run one statement per call, outside a transaction. No existing index is removed.
create index concurrently if not exists idx_picking_registry_cursor
  on public.picking_scans(created_at desc,id desc);
create index concurrently if not exists idx_picking_registry_picker_cursor
  on public.picking_scans(picker_id,created_at desc,id desc);
