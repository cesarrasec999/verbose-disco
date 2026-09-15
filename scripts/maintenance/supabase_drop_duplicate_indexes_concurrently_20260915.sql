-- NO ejecutar como una sola transacción ni durante una sesión crítica.
-- Lista preparada con pg_stat_user_indexes del 15/09/2026.
-- Cada índice conservado tiene una definición equivalente y mayor uso, o es el
-- índice que respalda una restricción UNIQUE.
--
-- Ejecutar una sentencia por vez y volver a medir latencia/escrituras después
-- de cada bloque. DROP INDEX CONCURRENTLY evita bloquear las operaciones normales.

set lock_timeout = '1s';
set statement_timeout = '60s';

drop index concurrently if exists public.idx_credito_clientes_legajo_ruc;
drop index concurrently if exists public.idx_cyclic_assignments_recommendation_store_date_product;
drop index concurrently if exists public.idx_assignments_store_date;
drop index concurrently if exists public.idx_cyclic_completed_products_store_product;
drop index concurrently if exists public.idx_cyclic_completed_store;
drop index concurrently if exists public.idx_cyclic_counts_assignment_location;
drop index concurrently if exists public.idx_counts_assignment;
drop index concurrently if exists public.idx_cyclic_counts_store_id;
drop index concurrently if exists public.idx_cyclic_counts_real_assignment;
drop index concurrently if exists public.idx_cyclic_non_inventory_product_active;
drop index concurrently if exists public.idx_gi_counts_session_location;
drop index concurrently if exists public.idx_gi_counts_session_product;
drop index concurrently if exists public.idx_gi_counts_session_counted_id;
drop index concurrently if exists public.idx_gi_counts_client_uuid;
drop index concurrently if exists public.idx_gi_non_inventory_session_sku;
drop index concurrently if exists public.idx_gi_recount_counts_session_item;
drop index concurrently if exists public.idx_gi_recount_items_session_product_status;
drop index concurrently if exists public.idx_gi_snapshot_session_product;
drop index concurrently if exists public.idx_gi_validation_counts_session_item;
drop index concurrently if exists public.idx_gi_validation_items_session_product_status;

-- Se dejan fuera de esta primera limpieza los pares con uso relevante en ambos
-- lados (usuarios, observaciones, picking y valorizados) hasta observar planes.
