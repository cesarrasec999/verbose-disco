-- ══════════════════════════════════════════════════════════════
--  DIFERENCIAS DE RECEPCIÓN: reportes de desmedro + workflow de
--  regularización entre tienda proveedora y tienda receptora
-- ══════════════════════════════════════════════════════════════

-- Reportes de desmedro (producto llegó en mal estado) capturados al
-- completar la recepción. No siempre implican diferencia de cantidad
-- (puede llegar completo pero dañado), por eso es una tabla aparte.
CREATE TABLE IF NOT EXISTS reception_damage_reports (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid          NOT NULL REFERENCES reception_requests(id) ON DELETE CASCADE,
  line_id        text          NOT NULL REFERENCES reception_request_lines(id) ON DELETE CASCADE,
  product_code   text          NOT NULL,
  description    text,
  qty            numeric(18,6) NOT NULL DEFAULT 0,
  notes          text,
  photo_url      text,
  operator_id    uuid          REFERENCES cyclic_users(id),
  operator_name  text,
  created_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reception_damage_request ON reception_damage_reports (request_id);
CREATE INDEX IF NOT EXISTS idx_reception_damage_line    ON reception_damage_reports (line_id);

ALTER TABLE reception_damage_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon_read_reception_damage"  ON reception_damage_reports FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_reception_damage" ON reception_damage_reports FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bucket público para las fotos de evidencia de desmedro
INSERT INTO storage.buckets (id, name, public)
VALUES ('reception-damage-photos', 'reception-damage-photos', true)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "anon_read_damage_photos" ON storage.objects FOR SELECT TO anon, authenticated
    USING (bucket_id = 'reception-damage-photos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_damage_photos" ON storage.objects FOR ALL TO anon, authenticated
    USING (bucket_id = 'reception-damage-photos') WITH CHECK (bucket_id = 'reception-damage-photos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Workflow de regularización por código reportado con diferencia
-- (faltante / sobrante / desmedro). Una fila por diferencia individual,
-- identificada por diff_key (calculado en el cliente):
--   qty:<line_ids>   para faltante/sobrante (cálculo automático de cantidad)
--   dmg:<report_id>  para desmedro (un reporte manual = una regularización)
CREATE TABLE IF NOT EXISTS reception_difference_regularizations (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  diff_key                 text          UNIQUE NOT NULL,
  kind                     text          NOT NULL CHECK (kind IN ('faltante','sobrante','desmedro')),
  destination_store_code   text          NOT NULL,
  source_store_code        text          NOT NULL,
  product_code             text          NOT NULL,
  description              text,
  difference               numeric(18,6),

  status                   text          NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente','solicitado','regularizado')),

  -- Acción de la tienda proveedora: regulariza directo (faltante/desmedro)
  -- o solicita el requerimiento a la receptora (sobrante)
  provider_requirement_ref text,
  provider_notes           text,
  provider_action_by        uuid          REFERENCES cyclic_users(id),
  provider_action_by_name   text,
  provider_action_at        timestamptz,

  -- Acción de la tienda receptora: solo aplica para cerrar un sobrante
  -- ya solicitado por la proveedora
  receiver_requirement_ref text,
  receiver_notes            text,
  receiver_action_by         uuid          REFERENCES cyclic_users(id),
  receiver_action_by_name    text,
  receiver_action_at         timestamptz,

  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reception_diff_reg_dest   ON reception_difference_regularizations (destination_store_code);
CREATE INDEX IF NOT EXISTS idx_reception_diff_reg_source ON reception_difference_regularizations (source_store_code);
CREATE INDEX IF NOT EXISTS idx_reception_diff_reg_status ON reception_difference_regularizations (status);

ALTER TABLE reception_difference_regularizations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon_read_reception_diff_reg"  ON reception_difference_regularizations FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_reception_diff_reg" ON reception_difference_regularizations FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
