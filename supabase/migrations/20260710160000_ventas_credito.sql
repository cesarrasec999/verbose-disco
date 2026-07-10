-- ══════════════════════════════════════════════════════════════
--  VENTAS A CREDITO
--  Ventas (y notas de credito asociadas) tendidas con "LINEA DE
--  CREDITO" en RMS (TENDER.TenderType = 'CR'). Modulo de control de
--  documentacion: cada fila trae datos del ERP (solo lectura, se
--  pisan en cada sync) + un set de columnas editables por el equipo
--  de creditos que el sync NUNCA toca.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE ventas_credito (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id           uuid          NOT NULL UNIQUE,   -- RECEIPT.ReceiptId (RMS)

  -- Datos del ERP (el sync los sobreescribe en cada corrida)
  store_code           text          NOT NULL,
  store_name           text,
  doc_number           text,
  document_type        text,         -- FACTURA / BOLETA / NOTA DE CREDITO
  serie                text,
  numero_documento     text,
  sales_code           text,         -- S = venta, R = nota de credito/devolucion
  ruc                  text,
  razon_social         text,
  fecha_emision        date,
  importe_total        numeric(18,6),
  credito_dias         int,
  condicion            text,         -- "CREDITO 30 DIAS"
  asesora_nombre       text,
  asesora_dni          text,
  status_code          text,
  status_label         text,         -- ACTIVO / ANULADO

  -- Columnas editables por el equipo de creditos (el sync no las toca)
  registro              text         CHECK (registro IS NULL OR registro IN ('Plataforma','Virtual','Presencial')),
  legajo                 text,
  observacion            text,
  fecha_recepcion        date,
  cumple_documentacion    boolean     NOT NULL DEFAULT false,
  updated_by              uuid        REFERENCES cyclic_users(id),

  source_updated_at    timestamptz,
  synced_at            timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_ventas_credito_store      ON ventas_credito (store_code);
CREATE INDEX idx_ventas_credito_status     ON ventas_credito (status_code);
CREATE INDEX idx_ventas_credito_fecha      ON ventas_credito (fecha_emision DESC);
CREATE INDEX idx_ventas_credito_cumple_doc ON ventas_credito (cumple_documentacion);

ALTER TABLE ventas_credito ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_ventas_credito"  ON ventas_credito FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_write_ventas_credito" ON ventas_credito FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
