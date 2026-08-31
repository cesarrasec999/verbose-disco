-- El valorizado por rotacion busca el ultimo ciclo cerrado por tienda y SKU.
-- Estos indices cubren esa ruta sin leer todo el historial de rotaciones ni
-- volver a normalizar el maestro completo en cada consulta.
CREATE INDEX IF NOT EXISTS idx_product_rotation_monthly_store_sku_period
  ON public.product_rotation_monthly (
    store_key,
    upper(btrim(product_code)),
    period_month DESC
  ) INCLUDE (rotation_category);

CREATE INDEX IF NOT EXISTS idx_cyclic_products_active_normalized_sku
  ON public.cyclic_products (upper(btrim(sku)))
  INCLUDE (cost)
  WHERE is_active = true;
