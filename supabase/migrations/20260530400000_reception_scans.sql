-- Tabla de scans de recepción (por lectura, permite edición y eliminación por línea)
CREATE TABLE IF NOT EXISTS reception_scans (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid          NOT NULL REFERENCES reception_requests(id) ON DELETE CASCADE,
  line_id        text          NOT NULL REFERENCES reception_request_lines(id) ON DELETE CASCADE,
  operator_id    uuid          REFERENCES cyclic_users(id),
  operator_name  text,
  product_code   text          NOT NULL,
  scanned_code   text,
  qty            numeric(18,6) NOT NULL DEFAULT 1,
  notes          text,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reception_scans_request ON reception_scans (request_id);
CREATE INDEX IF NOT EXISTS idx_reception_scans_line    ON reception_scans (line_id);

ALTER TABLE reception_scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_reception_scans"
  ON reception_scans FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_write_reception_scans"
  ON reception_scans FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
