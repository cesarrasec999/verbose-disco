-- Inventario general escalable: cada pantalla de reconteo consulta solo la
-- sesión, el operario y los estados aún atendibles. Estos índices evitan
-- escanear el historial completo cuando aumenten sesiones y usuarios.

CREATE INDEX IF NOT EXISTS idx_gi_recount_items_session_operator_pending
  ON public.general_inventory_recount_items (session_id, assigned_operator_id, status, location_code, value_diff DESC)
  WHERE status IN ('assigned', 'pending');

CREATE INDEX IF NOT EXISTS idx_gi_validation_items_session_operator_pending
  ON public.general_inventory_validation_items (session_id, assigned_operator_id, status, location_code, value_diff DESC)
  WHERE status IN ('assigned', 'pending');

CREATE INDEX IF NOT EXISTS idx_gi_recount_counts_session_product_location
  ON public.general_inventory_recount_counts (session_id, product_id, location_id);

CREATE INDEX IF NOT EXISTS idx_gi_validation_counts_session_product_location
  ON public.general_inventory_validation_counts (session_id, product_id, location_id);

CREATE INDEX IF NOT EXISTS idx_gi_locations_session_active_code
  ON public.general_inventory_locations (session_id, is_active, location_code);

CREATE INDEX IF NOT EXISTS idx_gi_sessions_status_created
  ON public.general_inventory_sessions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gi_session_operators_operator_status_session
  ON public.general_inventory_session_operators (operator_id, status, session_id);
