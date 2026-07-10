-- Referencia al documento original (factura/boleta) al que aplica una
-- nota de credito. En RMS viene en RECEIPT.NoteField para filas con
-- SalesCode='R' (confirmado con datos reales: el DocNumber de la NC trae
-- en NoteField el DocNumber de la factura/boleta que esta regularizando).
-- ReverseDocNo no se usa en este ERP (siempre null).

ALTER TABLE ventas_credito
  ADD COLUMN IF NOT EXISTS nc_documento_referencia text;
