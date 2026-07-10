-- ══════════════════════════════════════════════════════════════
--  LEGAJO DE CLIENTES (creditos y cobranzas)
--  Tabla de referencia importada desde la hoja de calculo del
--  equipo de creditos (pestaña "info"): por cada cliente (RUC),
--  la abreviatura del legajo/documentacion que exige para poder
--  facturarle a credito. Por ahora solo se usa la abreviatura
--  para autocompletar la columna "Legajo" en ventas_credito.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE credito_clientes_legajo (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ruc                text          NOT NULL UNIQUE,
  razon_social       text,
  legajo_abreviatura text,         -- ej. "FT-GR", "FT-GR-OC"
  legajo_detalle     text,         -- descripcion completa (ej. "FACTURA Y GUIA DE REMISION")
  modalidad          text,
  contacto_email     text,
  asunto             text,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_credito_clientes_legajo_ruc ON credito_clientes_legajo (ruc);

ALTER TABLE credito_clientes_legajo ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_credito_clientes_legajo"  ON credito_clientes_legajo FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_write_credito_clientes_legajo" ON credito_clientes_legajo FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
