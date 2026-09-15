-- Rendimiento/seguridad, fase 2: elimina políticas SELECT redundantes.
--
-- Cada tabla conserva una política ALL con exactamente los mismos roles y
-- condición true; por tanto el conjunto de filas y operaciones permitidas no
-- cambia. Se evita evaluar dos políticas permisivas para cada lectura.

begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

drop policy if exists business_holidays_select on public.business_holidays;
drop policy if exists anon_read_checklist_entries on public.checklist_entries;
drop policy if exists anon_read_checklist_store_assignments on public.checklist_store_assignments;
drop policy if exists anon_read_credito_clientes_legajo on public.credito_clientes_legajo;
drop policy if exists "erp product sales daily read" on public.erp_product_sales_daily;
drop policy if exists erp_store_sales_daily_select on public.erp_store_sales_daily;
drop policy if exists anon_read_inv_diff_reports on public.inventory_difference_reports;
drop policy if exists "inventory rotation valuation daily read" on public.inventory_rotation_valuation_daily;
drop policy if exists "inventory valuation snapshot stores read" on public.inventory_valuation_snapshot_stores;
drop policy if exists "inventory valuation snapshots read" on public.inventory_valuation_snapshots;
drop policy if exists anon_read_module_flags on public.module_flags;
drop policy if exists product_rotation_monthly_select on public.product_rotation_monthly;
drop policy if exists anon_read_reception_diff_reg on public.reception_difference_regularizations;
drop policy if exists anon_read_reception_diff_reports on public.reception_difference_reports;
drop policy if exists anon_read_reception_records on public.reception_records;
drop policy if exists anon_read_reception_lines on public.reception_request_lines;
drop policy if exists anon_read_reception_requests on public.reception_requests;
drop policy if exists anon_read_reception_scans on public.reception_scans;
drop policy if exists anon_read_ventas_credito on public.ventas_credito;

notify pgrst, 'reload schema';

commit;
