-- Meta mensual de venta tomada de RMS. Una meta nunca se deduce de las
-- ventas: debe venir identificada por tienda y periodo desde el reporte RMS.
CREATE TABLE IF NOT EXISTS public.erp_store_sales_targets (
  target_month date NOT NULL,
  store_key text NOT NULL,
  target_amount numeric NOT NULL DEFAULT 0,
  source_name text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_month, store_key)
);

CREATE INDEX IF NOT EXISTS idx_erp_store_sales_targets_month_store
  ON public.erp_store_sales_targets (target_month DESC, store_key);

ALTER TABLE public.erp_store_sales_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "erp store sales targets select" ON public.erp_store_sales_targets;
CREATE POLICY "erp store sales targets select" ON public.erp_store_sales_targets FOR SELECT USING (true);
DROP POLICY IF EXISTS "erp store sales targets write" ON public.erp_store_sales_targets;
CREATE POLICY "erp store sales targets write" ON public.erp_store_sales_targets FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_store_sales_targets TO anon, authenticated, service_role;

INSERT INTO public.erp_sync_status (id, source_path, synced_at, updated_at)
VALUES ('erp_store_sales_targets', '\\192.168.5.53\\Users\\cesar.quispe\\erp-sync', now(), now())
ON CONFLICT (id) DO UPDATE SET source_path = EXCLUDED.source_path, updated_at = now();

NOTIFY pgrst, 'reload schema';
