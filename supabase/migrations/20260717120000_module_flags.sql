-- Kill switch de modulos: le permite a la cuenta "admin" (Administrador
-- Principal) deshabilitar/habilitar en caliente cualquiera de los 14
-- modulos de nivel superior de la app, sin deploy. Un modulo deshabilitado
-- muestra un mensaje "Modulo deshabilitado, ponte en contacto con el
-- administrador" a todos los roles salvo Administrador.
--
-- Diseno "fail-open" deliberado: no se seedean filas para los 14 modulos -
-- la AUSENCIA de fila para un module_key significa habilitado. Solo se
-- inserta/actualiza una fila cuando el admin apaga algo. Si la tabla o la
-- query fallan por cualquier motivo (red, RLS, etc.), el cliente trata el
-- error como "nada deshabilitado" en vez de bloquear toda la app por un
-- problema de infraestructura ajeno a esta feature.

CREATE TABLE IF NOT EXISTS module_flags (
  module_key       text        PRIMARY KEY,
  enabled          boolean     NOT NULL DEFAULT true,
  disabled_reason  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        REFERENCES cyclic_users(id)
);

ALTER TABLE module_flags ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon_read_module_flags"  ON module_flags FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_module_flags" ON module_flags FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
