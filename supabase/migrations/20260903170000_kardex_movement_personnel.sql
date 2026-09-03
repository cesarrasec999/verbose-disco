-- Personal responsable entregado por RMS para cada movimiento.
-- Se mantiene adjustment_user por compatibilidad con Ajustes Provisionales;
-- las dos columnas nuevas permiten distinguir solicitante y receptor en una
-- transferencia sin reutilizar documentos o alterar el historial.
ALTER TABLE public.erp_movements
  ADD COLUMN IF NOT EXISTS movement_employee text,
  ADD COLUMN IF NOT EXISTS reception_employee text;

CREATE INDEX IF NOT EXISTS idx_erp_movements_personnel_backfill
  ON public.erp_movements (movement_date, source_type)
  WHERE movement_employee IS NULL OR reception_employee IS NULL;
