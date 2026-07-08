-- Agrega el estado "rechazado" al workflow de regularizacion de diferencias:
-- la tienda proveedora puede rechazar una diferencia reportada (en vez de
-- solo atenderla), dejando obligatoriamente el motivo en notes. Es un
-- estado terminal, no pasa a "regularizado".

ALTER TABLE reception_difference_regularizations
  DROP CONSTRAINT IF EXISTS reception_difference_regularizations_status_check;

ALTER TABLE reception_difference_regularizations
  ADD CONSTRAINT reception_difference_regularizations_status_check
  CHECK (status IN ('pendiente','atendido','regularizado','rechazado'));
