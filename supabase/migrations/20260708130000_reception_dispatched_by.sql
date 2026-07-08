-- Usuario que genera la guia (SLIP) en la tienda proveedora, sincronizado
-- desde RMS (SLIP.EmployeeCode -> EMPLOYEE.FullName) por sync-recepcion.js.
-- Se muestra en el reporte de diferencias para identificar quien despacho
-- la guia asociada a un faltante/sobrante/desmedro.

ALTER TABLE reception_requests
  ADD COLUMN IF NOT EXISTS dispatched_by_code text,
  ADD COLUMN IF NOT EXISTS dispatched_by_name text;
