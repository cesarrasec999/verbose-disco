-- Clasifica cada asignación sin perder el historial actual.  Las asignaciones
-- existentes conservan el tipo cíclico salvo las realizadas sábado, que pasan
-- a Conteo líder por la regla operativa definida.
ALTER TABLE public.cyclic_assignments
  ADD COLUMN IF NOT EXISTS count_type text NOT NULL DEFAULT 'cyclic';

UPDATE public.cyclic_assignments
SET count_type = 'leader'
WHERE EXTRACT(DOW FROM assigned_date) = 6
  AND count_type = 'cyclic';

ALTER TABLE public.cyclic_assignments
  DROP CONSTRAINT IF EXISTS cyclic_assignments_count_type_check;

ALTER TABLE public.cyclic_assignments
  ADD CONSTRAINT cyclic_assignments_count_type_check
  CHECK (count_type IN ('cyclic', 'leader', 'supervisor'));

-- El mismo SKU puede programarse en tipos distintos el mismo día.  Se elimina
-- sólo el índice/constraint de unicidad anterior con esas tres columnas y se
-- reemplaza por uno que incluye el tipo de conteo.
DO $$
DECLARE
  old_constraint text;
  old_index text;
BEGIN
  SELECT conname INTO old_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.cyclic_assignments'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (store_id, product_id, assigned_date)';

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.cyclic_assignments DROP CONSTRAINT %I', old_constraint);
  END IF;

  SELECT indexrelid::regclass::text INTO old_index
  FROM pg_index
  WHERE indrelid = 'public.cyclic_assignments'::regclass
    AND indisunique
    AND NOT indisprimary
    AND pg_get_indexdef(indexrelid) ~ '\(store_id, product_id, assigned_date\)$';

  IF old_index IS NOT NULL THEN
    EXECUTE format('DROP INDEX IF EXISTS %s', old_index);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_cyclic_assignments_store_product_date_type
  ON public.cyclic_assignments (store_id, product_id, assigned_date, count_type);

CREATE INDEX IF NOT EXISTS idx_cyclic_assignments_store_date_type
  ON public.cyclic_assignments (store_id, assigned_date, count_type);

CREATE INDEX IF NOT EXISTS idx_cyclic_assignments_date_type
  ON public.cyclic_assignments (assigned_date, count_type);

-- El resumen por código debe respetar el tipo seleccionado.  NULL conserva el
-- comportamiento de "todos" para reportes administrativos.
DROP FUNCTION IF EXISTS public.get_cyclic_day_summary(uuid, date);
CREATE FUNCTION public.get_cyclic_day_summary(
  p_store_id uuid,
  p_date date,
  p_count_type text DEFAULT NULL
)
RETURNS TABLE (
  product_id uuid,
  sku text,
  description text,
  unit text,
  cost numeric,
  system_stock numeric,
  total_counted numeric,
  difference numeric,
  dif_valorizada numeric
)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT
    ca.product_id,
    cp.sku,
    cp.description,
    cp.unit,
    ROUND(cp.cost::numeric, 6),
    ROUND(ca.system_stock::numeric, 2),
    ROUND(COALESCE(SUM(CASE WHEN cc.location NOT IN ('__session_counting__','__session_finished__','__recount_started__','__recount_done__') THEN cc.counted_quantity ELSE 0 END), 0)::numeric, 2),
    ROUND(COALESCE(SUM(CASE WHEN cc.location NOT IN ('__session_counting__','__session_finished__','__recount_started__','__recount_done__') THEN cc.counted_quantity ELSE 0 END), 0)::numeric - ca.system_stock::numeric, 2),
    ROUND((COALESCE(SUM(CASE WHEN cc.location NOT IN ('__session_counting__','__session_finished__','__recount_started__','__recount_done__') THEN cc.counted_quantity ELSE 0 END), 0)::numeric - ca.system_stock::numeric) * cp.cost::numeric, 2)
  FROM public.cyclic_assignments ca
  JOIN public.cyclic_products cp ON cp.id = ca.product_id
  LEFT JOIN public.cyclic_counts cc ON cc.assignment_id = ca.id
  WHERE ca.store_id = p_store_id
    AND ca.assigned_date = p_date
    AND (p_count_type IS NULL OR ca.count_type = p_count_type)
  GROUP BY ca.product_id, cp.sku, cp.description, cp.unit, cp.cost, ca.system_stock
  ORDER BY cp.sku;
$$;
GRANT EXECUTE ON FUNCTION public.get_cyclic_day_summary(uuid, date, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
