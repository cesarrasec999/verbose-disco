-- ══════════════════════════════════════════════════════════════
--  MÓDULO RECEPCIÓN
--  Las tiendas recepcionan requerimientos aprobados desde CD-GPC
-- ══════════════════════════════════════════════════════════════

-- Requerimientos sincronizados desde ERP (StatusCode = 'D' = Aprobado)
CREATE TABLE IF NOT EXISTS reception_requests (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  erp_inv_request_id     text        UNIQUE NOT NULL,
  inv_request_no         text,
  doc_number             text,
  status_code            text,
  status_name            text,
  request_date           timestamptz,
  creation_date          timestamptz,
  destination_store_code text        NOT NULL,   -- tienda que recibe
  destination_store_name text,
  source_store_code      text        NOT NULL,   -- CD / bodega origen
  source_store_name      text,
  reason                 text,
  notes                  text,
  line_count             int         NOT NULL DEFAULT 0,
  qty_requested_total    numeric(18,6) NOT NULL DEFAULT 0,
  qty_pending_total      numeric(18,6) NOT NULL DEFAULT 0,

  -- Estado de recepción en la app (no viene del ERP)
  reception_status       text        NOT NULL DEFAULT 'pending'
    CHECK (reception_status IN ('pending','in_progress','completed')),
  completed_at           timestamptz,
  completed_by_id        uuid        REFERENCES cyclic_users(id),
  completed_by_name      text,

  source_updated_at      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Líneas de cada requerimiento (sincronizadas desde ERP)
CREATE TABLE IF NOT EXISTS reception_request_lines (
  id                   text        PRIMARY KEY, -- "{erp_inv_request_id}|{line_id}"
  request_id           uuid        NOT NULL REFERENCES reception_requests(id) ON DELETE CASCADE,
  erp_inv_request_id   text        NOT NULL,
  line_id              int         NOT NULL,
  sku                  text,
  product_code         text        NOT NULL,
  barcode              text,
  description          text,
  unit                 text,
  qty_requested        numeric(18,6) NOT NULL DEFAULT 0,
  qty_pending          numeric(18,6) NOT NULL DEFAULT 0,
  source_updated_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Lo que la tienda realmente recibió (ingresado por el operario)
CREATE TABLE IF NOT EXISTS reception_records (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid        NOT NULL REFERENCES reception_requests(id) ON DELETE CASCADE,
  line_id        text        NOT NULL REFERENCES reception_request_lines(id) ON DELETE CASCADE,
  operator_id    uuid        REFERENCES cyclic_users(id),
  operator_name  text,
  product_code   text        NOT NULL,
  description    text,
  unit           text,
  qty_requested  numeric(18,6) NOT NULL DEFAULT 0,
  qty_received   numeric(18,6) NOT NULL DEFAULT 0,
  difference     numeric(18,6) GENERATED ALWAYS AS (qty_received - qty_requested) STORED,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_reception_requests_dest_store
  ON reception_requests (destination_store_code);
CREATE INDEX IF NOT EXISTS idx_reception_requests_status
  ON reception_requests (reception_status);
CREATE INDEX IF NOT EXISTS idx_reception_requests_creation
  ON reception_requests (creation_date DESC);
CREATE INDEX IF NOT EXISTS idx_reception_lines_request
  ON reception_request_lines (request_id);
CREATE INDEX IF NOT EXISTS idx_reception_records_request
  ON reception_records (request_id);

-- RLS
ALTER TABLE reception_requests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reception_request_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reception_records        ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_read_reception_requests"  ON reception_requests       FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_reception_requests" ON reception_requests       FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon_read_reception_lines"     ON reception_request_lines  FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_reception_lines"    ON reception_request_lines  FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon_read_reception_records"   ON reception_records        FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_reception_records"  ON reception_records        FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
