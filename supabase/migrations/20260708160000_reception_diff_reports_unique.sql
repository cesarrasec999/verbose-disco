-- Evita reportar la misma diferencia (faltante/sobrante/desmedro) mas de
-- una vez para la misma linea, ya sea por doble clic, reintento tras error
-- de red, o reabrir el requerimiento y volver a reportar.

ALTER TABLE reception_difference_reports
  ADD CONSTRAINT reception_difference_reports_line_kind_unique UNIQUE (line_id, kind);
