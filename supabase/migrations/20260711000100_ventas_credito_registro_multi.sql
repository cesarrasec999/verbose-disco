-- ══════════════════════════════════════════════════════════════
--  REGISTRO MULTIPLE (creditos y cobranzas)
--  "Registro" pasa de ser una sola opcion (Plataforma/Virtual/
--  Presencial) a permitir seleccionar varias a la vez.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE ventas_credito
  DROP CONSTRAINT ventas_credito_registro_check;

ALTER TABLE ventas_credito
  ALTER COLUMN registro TYPE text[]
  USING (CASE WHEN registro IS NULL OR registro = '' THEN NULL ELSE ARRAY[registro] END);

ALTER TABLE ventas_credito
  ADD CONSTRAINT ventas_credito_registro_check
  CHECK (registro IS NULL OR registro <@ ARRAY['Plataforma','Virtual','Presencial']::text[]);

NOTIFY pgrst, 'reload schema';
