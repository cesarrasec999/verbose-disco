-- Exact duplicate indexes verified against pg_index on 2026-10-09.
-- Production indexes were removed individually with DROP INDEX CONCURRENTLY.
-- This migration keeps fresh databases and migration history aligned.

drop index if exists public.idx_gi_counts_session_product;
drop index if exists public.idx_gi_counts_client_uuid;
drop index if exists public.idx_gi_counts_session_counted_id;
drop index if exists public.idx_gi_recount_counts_session_item;
drop index if exists public.idx_gi_recount_items_session_product_status;
drop index if exists public.idx_product_rotation_store_name_lookup;
drop index if exists public.idx_product_rotation_monthly_lookup_upper;
drop index if exists public.idx_gi_snapshot_session_product;
drop index if exists public.idx_gi_counts_session_location;
drop index if exists public.idx_gi_validation_counts_session_item;
drop index if exists public.idx_gi_validation_items_session_product_status;
drop index if exists public.idx_cyclic_counts_assignment_location;
drop index if exists public.idx_counts_assignment;
drop index if exists public.idx_cyclic_counts_real_assignment;
drop index if exists public.idx_cyclic_counts_store_id;
drop index if exists public.idx_assignments_store_date;
drop index if exists public.idx_cyclic_non_inventory_product_active;
drop index if exists public.idx_gi_non_inventory_session_sku;
drop index if exists public.idx_cyclic_assignments_recommendation_store_date_product;
drop index if exists public.idx_picking_scans_picker;
drop index if exists public.idx_cyclic_completed_store;
