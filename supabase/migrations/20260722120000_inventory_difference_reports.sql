-- ============================================================================
-- Modulo nuevo "Diferencias de Inventario": los operadores de cualquier
-- tienda reportan, en el momento, un codigo cuyo stock fisico no coincide
-- con el stock del sistema, con foto de evidencia. Validador/Supervisor/
-- Administrador revisan y marcan cada reporte como regularizado (con
-- numero de ajuste) o rechazado.
--
-- Distinto de "Ajustes Provisionales ERP" (solo lectura de ajustes ya
-- sincronizados desde el ERP) y de los reportes de diferencia de Recepcion
-- (especificos del flujo guia-recepcion). Mismo patron de tabla + bucket +
-- RLS que reception_damage_reports (20260707190000_reception_differences_workflow.sql).
--
-- system_stock_at_report queda congelado para siempre: se llena una sola
-- vez al insertar el reporte, ninguna pantalla ni proceso lo vuelve a
-- tocar despues.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.inventory_difference_reports (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                uuid          REFERENCES public.stores(id),
  store_name              text,
  product_id              uuid          REFERENCES public.cyclic_products(id),
  sku                     text          NOT NULL,
  description             text,
  unit                    text,
  system_stock_at_report  numeric(18,6) NOT NULL DEFAULT 0,
  physical_qty            numeric(18,6) NOT NULL,
  photo_url               text          NOT NULL,
  notes                   text,
  operator_id             uuid          REFERENCES public.cyclic_users(id),
  operator_name           text,
  status                  text          NOT NULL DEFAULT 'pendiente'
                            CHECK (status IN ('pendiente','regularizado','rechazado')),
  adjustment_number       text,
  validated_by            uuid          REFERENCES public.cyclic_users(id),
  validated_by_name       text,
  validated_at            timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT adjustment_number_required_when_regularizado
    CHECK (status <> 'regularizado' OR adjustment_number IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_inv_diff_reports_store    ON public.inventory_difference_reports (store_id);
CREATE INDEX IF NOT EXISTS idx_inv_diff_reports_operator ON public.inventory_difference_reports (operator_id);
CREATE INDEX IF NOT EXISTS idx_inv_diff_reports_status   ON public.inventory_difference_reports (status);
CREATE INDEX IF NOT EXISTS idx_inv_diff_reports_created  ON public.inventory_difference_reports (created_at DESC);

ALTER TABLE public.inventory_difference_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon_read_inv_diff_reports"  ON public.inventory_difference_reports FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_inv_diff_reports" ON public.inventory_difference_reports FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bucket publico para las fotos de evidencia del reporte de diferencia.
INSERT INTO storage.buckets (id, name, public)
VALUES ('inventory-difference-photos', 'inventory-difference-photos', true)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "anon_read_inv_diff_photos" ON storage.objects FOR SELECT TO anon, authenticated
    USING (bucket_id = 'inventory-difference-photos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_inv_diff_photos" ON storage.objects FOR ALL TO anon, authenticated
    USING (bucket_id = 'inventory-difference-photos') WITH CHECK (bucket_id = 'inventory-difference-photos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
