-- Función que calcula el resumen por código de un día/tienda directamente en la BD.
-- Reemplaza el useMemo resumenPorCodigo del cliente, eliminando el envío de miles
-- de filas de assignments+counts al navegador.

CREATE OR REPLACE FUNCTION get_cyclic_day_summary(
  p_store_id uuid,
  p_date     date
)
RETURNS TABLE (
  product_id    uuid,
  sku           text,
  description   text,
  unit          text,
  cost          numeric,
  system_stock  numeric,
  total_counted numeric,
  difference    numeric,
  dif_valorizada numeric
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    ca.product_id,
    cp.sku,
    cp.description,
    cp.unit,
    ROUND(cp.cost::numeric, 6)                                                AS cost,
    ROUND(ca.system_stock::numeric, 2)                                        AS system_stock,

    -- Suma de conteos reales (excluye ubicaciones de control de sesión)
    ROUND(COALESCE(SUM(
      CASE WHEN cc.location NOT IN (
        '__session_counting__',
        '__session_finished__',
        '__recount_started__',
        '__recount_done__'
      ) THEN cc.counted_quantity ELSE 0 END
    ), 0)::numeric, 2)                                                        AS total_counted,

    -- Diferencia = contado - stock sistema
    ROUND(
      COALESCE(SUM(
        CASE WHEN cc.location NOT IN (
          '__session_counting__',
          '__session_finished__',
          '__recount_started__',
          '__recount_done__'
        ) THEN cc.counted_quantity ELSE 0 END
      ), 0)::numeric - ca.system_stock::numeric
    , 2)                                                                      AS difference,

    -- Diferencia valorizada = diferencia × costo
    ROUND(
      (COALESCE(SUM(
        CASE WHEN cc.location NOT IN (
          '__session_counting__',
          '__session_finished__',
          '__recount_started__',
          '__recount_done__'
        ) THEN cc.counted_quantity ELSE 0 END
      ), 0)::numeric - ca.system_stock::numeric) * cp.cost::numeric
    , 2)                                                                      AS dif_valorizada

  FROM cyclic_assignments ca
  JOIN cyclic_products     cp ON cp.id = ca.product_id
  LEFT JOIN cyclic_counts  cc ON cc.assignment_id = ca.id

  WHERE ca.store_id    = p_store_id
    AND ca.assigned_date = p_date

  GROUP BY ca.product_id, cp.sku, cp.description, cp.unit, cp.cost, ca.system_stock
  ORDER BY cp.sku;
$$;

GRANT EXECUTE ON FUNCTION get_cyclic_day_summary(uuid, date) TO anon, authenticated;

-- Índice de soporte para que la función sea rápida
CREATE INDEX IF NOT EXISTS idx_cyclic_assignments_store_date
  ON cyclic_assignments (store_id, assigned_date);

CREATE INDEX IF NOT EXISTS idx_cyclic_counts_assignment_id
  ON cyclic_counts (assignment_id);
