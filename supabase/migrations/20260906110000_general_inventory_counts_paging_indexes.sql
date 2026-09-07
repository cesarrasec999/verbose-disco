-- Inventarios generales: consultas de operadores y validadores por sesión.
-- Los índices permiten paginar sin leer ni ordenar todo el historial.
-- No modifican ni eliminan registros de conteo.
CREATE INDEX IF NOT EXISTS idx_gi_counts_session_counted_id
  ON public.general_inventory_counts (session_id, counted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_gi_counts_session_operator_counted_id
  ON public.general_inventory_counts (session_id, operator_id, counted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_gi_counts_session_product_location
  ON public.general_inventory_counts (session_id, product_id, location_id);

CREATE INDEX IF NOT EXISTS idx_gi_counts_session_location
  ON public.general_inventory_counts (session_id, location_code);

CREATE INDEX IF NOT EXISTS idx_gi_session_operators_session_status
  ON public.general_inventory_session_operators (session_id, status, operator_id);

NOTIFY pgrst, 'reload schema';
