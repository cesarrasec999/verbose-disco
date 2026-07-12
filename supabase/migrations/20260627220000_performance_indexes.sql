-- Índices de performance para consultas frecuentes.
-- Todos usan IF NOT EXISTS — seguros de re-ejecutar.

-- ── cyclic_assignments ────────────────────────────────────────
-- Dashboard por rango de fechas sin filtro de tienda
-- (.gte assigned_date .lte assigned_date en loadDashboard y loadStoreProgress)
CREATE INDEX IF NOT EXISTS idx_cyclic_assignments_date
  ON public.cyclic_assignments (assigned_date);

-- ── cyclic_counts ─────────────────────────────────────────────
-- loadStoreProgress filtra por store_id (chunked)
CREATE INDEX IF NOT EXISTS idx_cyclic_counts_store_id
  ON public.cyclic_counts (store_id);

-- Flags de sesión: .eq(assignment_id).eq(location, flag)
-- Cubre también .in(assignment_id).in(location, flags)
CREATE INDEX IF NOT EXISTS idx_cyclic_counts_asgn_location
  ON public.cyclic_counts (assignment_id, location);

-- ── cyclic_products ───────────────────────────────────────────
-- Carga inicial: .eq(is_active, true).order(sku)
-- Búsqueda por SKU: .in(sku, chunk).eq(is_active, true)
CREATE INDEX IF NOT EXISTS idx_cyclic_products_active_sku
  ON public.cyclic_products (is_active, sku);

-- ── cyclic_users ──────────────────────────────────────────────
-- Login: .eq(username, ...)  /  unicidad al crear usuario
CREATE INDEX IF NOT EXISTS idx_cyclic_users_username
  ON public.cyclic_users (username);
