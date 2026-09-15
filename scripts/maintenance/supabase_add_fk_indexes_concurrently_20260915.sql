-- NO ejecutar como una sola transacción ni durante una sesión crítica.
-- Candidatos detectados por el Advisor/pg_constraint el 15/09/2026.
-- CREATE INDEX CONCURRENTLY reduce bloqueos, pero consume CPU/E/S; aplicar por
-- bloques y validar pg_stat_progress_create_index.

set lock_timeout = '1s';
set statement_timeout = '10min';

create index concurrently if not exists idx_audit_counts_counted_by_fk on public.audit_counts(counted_by);
create index concurrently if not exists idx_audit_session_items_product_id_fk on public.audit_session_items(product_id);
create index concurrently if not exists idx_checklist_entries_created_by_fk on public.checklist_entries(created_by);
create index concurrently if not exists idx_cyclic_completed_products_product_id_fk on public.cyclic_completed_products(product_id);
create index concurrently if not exists idx_cyclic_counts_user_id_fk on public.cyclic_counts(user_id);
create index concurrently if not exists idx_gi_counts_product_id_fk on public.general_inventory_counts(product_id);
create index concurrently if not exists idx_gi_observations_product_id_fk on public.general_inventory_item_observations(product_id);
create index concurrently if not exists idx_gi_location_sync_jobs_store_id_fk on public.general_inventory_location_sync_jobs(store_id);
create index concurrently if not exists idx_gi_quantity_edits_editor_id_fk on public.general_inventory_quantity_edits(editor_id);
create index concurrently if not exists idx_gi_quantity_edits_product_id_fk on public.general_inventory_quantity_edits(product_id);
create index concurrently if not exists idx_gi_recount_counts_operator_id_fk on public.general_inventory_recount_counts(operator_id);
create index concurrently if not exists idx_gi_recount_counts_product_id_fk on public.general_inventory_recount_counts(product_id);
create index concurrently if not exists idx_gi_recount_items_product_id_fk on public.general_inventory_recount_items(product_id);
create index concurrently if not exists idx_gi_stock_snapshot_product_id_fk on public.general_inventory_stock_snapshot(product_id);
create index concurrently if not exists idx_gi_validation_counts_operator_id_fk on public.general_inventory_validation_counts(operator_id);
create index concurrently if not exists idx_gi_validation_counts_product_id_fk on public.general_inventory_validation_counts(product_id);
create index concurrently if not exists idx_gi_validation_items_product_id_fk on public.general_inventory_validation_items(product_id);
create index concurrently if not exists idx_inventory_difference_reports_product_id_fk on public.inventory_difference_reports(product_id);
create index concurrently if not exists idx_inventory_difference_reports_validated_by_fk on public.inventory_difference_reports(validated_by);
create index concurrently if not exists idx_module_flags_updated_by_fk on public.module_flags(updated_by);
create index concurrently if not exists idx_picking_write_receipts_actor_id_fk on public.picking_write_receipts(actor_id);
create index concurrently if not exists idx_product_location_history_actor_user_id_fk on public.product_location_history(actor_user_id);
create index concurrently if not exists idx_product_location_operator_records_product_id_fk on public.product_location_operator_records(product_id);
create index concurrently if not exists idx_reception_diff_regularizations_attended_by_fk on public.reception_difference_regularizations(attended_by);
create index concurrently if not exists idx_reception_difference_reports_operator_id_fk on public.reception_difference_reports(operator_id);
create index concurrently if not exists idx_ventas_credito_updated_by_fk on public.ventas_credito(updated_by);
create index concurrently if not exists idx_wms_stock_snapshots_product_id_fk on public.wms_stock_snapshots(product_id);
