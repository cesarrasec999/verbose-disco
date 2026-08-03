-- Solicitudes de ajuste por motivo. Mantiene los reportes existentes y agrega
-- un detalle flexible para cruces y transformaciones con varios productos.
alter table public.inventory_difference_reports
  add column if not exists reason text not null default 'ajuste_inventario',
  add column if not exists request_data jsonb not null default '{}'::jsonb;

alter table public.inventory_difference_reports
  drop constraint if exists inventory_difference_reports_reason_check;

alter table public.inventory_difference_reports
  add constraint inventory_difference_reports_reason_check
  check (reason in (
    'cruce_sku',
    'ajuste_inventario',
    'post_inventario',
    'ingreso_provisional',
    'regularizacion_provisional',
    'transformacion_interna'
  ));

-- Algunos motivos no usan cantidad física ni foto (provisionales y
-- transformaciones), por eso dejan de ser obligatorios a nivel de tabla.
alter table public.inventory_difference_reports
  alter column physical_qty drop not null,
  alter column photo_url drop not null;

create index if not exists idx_inv_diff_reports_reason
  on public.inventory_difference_reports (reason);

notify pgrst, 'reload schema';
