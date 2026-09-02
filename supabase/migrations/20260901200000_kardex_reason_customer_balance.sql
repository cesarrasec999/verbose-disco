-- Campos de trazabilidad del Kardex centralizado.
-- El saldo se obtiene del reporte RMS cuando está disponible; nunca se infiere
-- a partir del stock actual.
ALTER TABLE public.erp_movements
  ADD COLUMN IF NOT EXISTS balance_after numeric;

COMMENT ON COLUMN public.erp_movements.balance_after IS
  'Saldo de existencias inmediatamente después del movimiento, informado por RMS.';
