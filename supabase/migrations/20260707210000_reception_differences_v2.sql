-- ══════════════════════════════════════════════════════════════
--  DIFERENCIAS DE RECEPCIÓN v2: reemplaza el diseño anterior
--  (reception_damage_reports + regularizaciones a 2 acciones) por un
--  reporte unico (faltante/sobrante/desmedro), todos explicitos, y un
--  workflow de 3 estados: pendiente -> atendido -> regularizado
--  (el ultimo paso es automatico, cuando el N° de requerimiento que
--  coloco la tienda proveedora sale como recibido en RMS).
--  Ambas tablas anteriores estaban vacias (recien desplegadas, 0 uso).
-- ══════════════════════════════════════════════════════════════

drop table if exists reception_damage_reports cascade;
drop table if exists reception_difference_regularizations cascade;

-- Reporte explicito de una diferencia. Nada aparece si no se reporta:
--  - "Reportar diferencias" reporta en bloque los faltantes/sobrantes
--    detectados por cantidad (recibido vs pedido) al momento de tocar el boton
--  - "Reportar desmedro" es manual, por codigo, con cantidad/notas/foto
CREATE TABLE reception_difference_reports (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid          NOT NULL REFERENCES reception_requests(id) ON DELETE CASCADE,
  line_id        text          NOT NULL REFERENCES reception_request_lines(id) ON DELETE CASCADE,
  kind           text          NOT NULL CHECK (kind IN ('faltante','sobrante','desmedro')),
  product_code   text          NOT NULL,
  description    text,
  unit           text,
  qty_sent       numeric(18,6),
  qty_received   numeric(18,6),
  qty            numeric(18,6) NOT NULL DEFAULT 0,
  notes          text,
  photo_url      text,
  operator_id    uuid          REFERENCES cyclic_users(id),
  operator_name  text,
  created_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_reception_diff_reports_request ON reception_difference_reports (request_id);
CREATE INDEX idx_reception_diff_reports_line    ON reception_difference_reports (line_id);
CREATE INDEX idx_reception_diff_reports_created ON reception_difference_reports (created_at DESC);

ALTER TABLE reception_difference_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_reception_diff_reports"  ON reception_difference_reports FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_write_reception_diff_reports" ON reception_difference_reports FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);

-- Workflow de atencion/regularizacion por diferencia reportada.
-- Un unico camino para los 3 tipos: la tienda proveedora coloca el N° de
-- requerimiento de regularizacion y lo marca "atendido"; el paso a
-- "regularizado" es automatico (lo hace la app al detectar que ese
-- requerimiento salio como recibido en RMS).
CREATE TABLE reception_difference_regularizations (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  diff_key                text          UNIQUE NOT NULL,
  kind                    text          NOT NULL CHECK (kind IN ('faltante','sobrante','desmedro')),
  destination_store_code  text          NOT NULL,
  source_store_code       text          NOT NULL,
  product_code            text          NOT NULL,
  description             text,

  status                  text          NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente','atendido','regularizado')),

  requirement_ref         text,
  notes                   text,
  attended_by             uuid          REFERENCES cyclic_users(id),
  attended_by_name        text,
  attended_at             timestamptz,
  regularized_at          timestamptz,

  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_reception_diff_reg_dest   ON reception_difference_regularizations (destination_store_code);
CREATE INDEX idx_reception_diff_reg_source ON reception_difference_regularizations (source_store_code);
CREATE INDEX idx_reception_diff_reg_status ON reception_difference_regularizations (status);

ALTER TABLE reception_difference_regularizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_reception_diff_reg"  ON reception_difference_regularizations FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_write_reception_diff_reg" ON reception_difference_regularizations FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
