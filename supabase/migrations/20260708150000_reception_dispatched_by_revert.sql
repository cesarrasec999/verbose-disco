-- Revierte la migracion anterior: el campo correcto para "quien genera la
-- entrega de la guia de remision" es SLIP.EmployeeCode (personal de
-- almacen que despacha), no INVENTORY_REQUEST.EmployeeCode (quien genero
-- el requerimiento original). Confirmado con caso real T200-00016395:
-- SLIP.EmployeeCode = auxiliar de almacen, INVENTORY_REQUEST.EmployeeCode
-- = trainee supply chain (persona distinta, no la que se queria mostrar).

ALTER TABLE reception_requests
  DROP COLUMN IF EXISTS requested_by_code,
  DROP COLUMN IF EXISTS requested_by_name,
  ADD COLUMN IF NOT EXISTS dispatched_by_code text,
  ADD COLUMN IF NOT EXISTS dispatched_by_name text;
