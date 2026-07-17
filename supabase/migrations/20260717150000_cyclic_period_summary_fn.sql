-- ERI de conteos ciclicos por tienda en un rango de fechas, para el Resumen
-- del modulo Checklist (columna nueva "ERI Conteo Ciclico", junto a
-- Cumplimiento Checklist y Auditoria Existencia).
--
-- Replica la misma logica que ya usa CiclicosShell.tsx (dashboard/KPI) en
-- el cliente: agrupa cyclic_assignments por producto (puede haber mas de
-- una asignacion del mismo producto en el rango), un producto "contado" es
-- el que tiene al menos un cyclic_counts real (excluyendo las ubicaciones
-- de control de sesion), diff = contado - stock sistema, ok = diff = 0,
-- ERI = ok / contados * 100 (solo sobre los productos que SI se contaron).
CREATE OR REPLACE FUNCTION get_cyclic_period_summary(
  p_store_ids uuid[],
  p_from      date,
  p_to        date
)
RETURNS TABLE (
  store_id      uuid,
  counted_items integer,
  ok_items      integer,
  eri           integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH assignments AS (
    SELECT ca.id, ca.store_id, ca.product_id, ca.system_stock
    FROM cyclic_assignments ca
    WHERE ca.store_id = ANY (p_store_ids)
      AND ca.assigned_date BETWEEN p_from AND p_to
  ),
  counted AS (
    SELECT cc.assignment_id, SUM(cc.counted_quantity) AS total_counted
    FROM cyclic_counts cc
    JOIN assignments a ON a.id = cc.assignment_id
    WHERE cc.location NOT IN (
      '__session_counting__',
      '__session_finished__',
      '__recount_started__',
      '__recount_done__'
    )
    GROUP BY cc.assignment_id
  ),
  product_agg AS (
    SELECT
      a.store_id,
      a.product_id,
      MAX(a.system_stock) AS system_stock,
      SUM(COALESCE(c.total_counted, 0)) AS total_counted,
      BOOL_OR(c.assignment_id IS NOT NULL) AS was_counted
    FROM assignments a
    LEFT JOIN counted c ON c.assignment_id = a.id
    GROUP BY a.store_id, a.product_id
  )
  SELECT
    st.id AS store_id,
    COALESCE(COUNT(*) FILTER (WHERE pa.was_counted), 0)::integer AS counted_items,
    COALESCE(COUNT(*) FILTER (WHERE pa.was_counted AND (pa.total_counted - pa.system_stock) = 0), 0)::integer AS ok_items,
    CASE WHEN COUNT(*) FILTER (WHERE pa.was_counted) = 0 THEN 0
         ELSE ROUND(
           COUNT(*) FILTER (WHERE pa.was_counted AND (pa.total_counted - pa.system_stock) = 0)::numeric
           / COUNT(*) FILTER (WHERE pa.was_counted) * 100
         )::integer
    END AS eri
  FROM unnest(p_store_ids) AS st(id)
  LEFT JOIN product_agg pa ON pa.store_id = st.id
  GROUP BY st.id;
$$;

GRANT EXECUTE ON FUNCTION get_cyclic_period_summary(uuid[], date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
