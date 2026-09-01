-- Kardex: las consultas siempre se ordenan por fecha descendente y se filtran
-- por rango; estos índices evitan ordenar toda la tabla de movimientos.
CREATE INDEX IF NOT EXISTS idx_erp_movements_kardex_date_desc
  ON public.erp_movements (movement_date DESC, movement_key DESC);

CREATE INDEX IF NOT EXISTS idx_erp_movements_kardex_store_date_desc
  ON public.erp_movements (store_code, movement_date DESC, movement_key DESC);
