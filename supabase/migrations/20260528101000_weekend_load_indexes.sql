-- Indices seguros para filtros/consultas concurrentes del fin de semana.
-- Solo crea indices si existen las tablas/columnas; no modifica ni borra datos.

do $$
begin
  if to_regclass('public.picking_requests') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_requests' and column_name = 'status_code')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_requests' and column_name = 'source_store_code')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_requests' and column_name = 'creation_date') then
      execute 'create index if not exists idx_picking_requests_status_source_created on public.picking_requests(status_code, source_store_code, creation_date desc)';
    end if;
  end if;

  if to_regclass('public.picking_assignments') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_assignments' and column_name = 'request_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_assignments' and column_name = 'created_at') then
      execute 'create index if not exists idx_picking_assignments_request_created on public.picking_assignments(request_id, created_at desc)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_assignments' and column_name = 'line_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_assignments' and column_name = 'status') then
      execute 'create index if not exists idx_picking_assignments_line_status on public.picking_assignments(line_id, status)';
    end if;
  end if;

  if to_regclass('public.picking_scans') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_scans' and column_name = 'request_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_scans' and column_name = 'created_at') then
      execute 'create index if not exists idx_picking_scans_request_created on public.picking_scans(request_id, created_at desc)';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_scans' and column_name = 'picker_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'picking_scans' and column_name = 'created_at') then
      execute 'create index if not exists idx_picking_scans_picker_created on public.picking_scans(picker_id, created_at desc)';
    end if;
  end if;

  if to_regclass('public.audit_counts') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_counts' and column_name = 'counted_at') then
      execute 'create index if not exists idx_audit_counts_session_recent on public.audit_counts(session_id, counted_at desc)';
    end if;
  end if;

  if to_regclass('public.cyclic_counts') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cyclic_counts' and column_name = 'assignment_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cyclic_counts' and column_name = 'counted_at') then
      execute 'create index if not exists idx_cyclic_counts_assignment_recent on public.cyclic_counts(assignment_id, counted_at desc)';
    end if;
  end if;
end $$;
