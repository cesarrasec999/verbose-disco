-- Correccion: la columna anterior (dispatched_by_*) traia quien despacha
-- la guia (SLIP) en el CD, pero lo que se necesita mostrar en el reporte de
-- diferencias es quien genera el requerimiento original (INVENTORY_REQUEST),
-- ej. el jefe de tienda que pidio el stock. Son personas distintas.

ALTER TABLE reception_requests
  DROP COLUMN IF EXISTS dispatched_by_code,
  DROP COLUMN IF EXISTS dispatched_by_name,
  ADD COLUMN IF NOT EXISTS requested_by_code text,
  ADD COLUMN IF NOT EXISTS requested_by_name text;
