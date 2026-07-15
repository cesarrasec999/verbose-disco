-- Resumen admin de auditorías (AuditoriaModule.tsx, loadAuditAdminSummary)
-- calculado en la BD.
--
-- Antes el cliente traia, para el rango de fechas seleccionado, TODOS los
-- audit_session_items + TODOS los audit_counts de esas sesiones (paginado en
-- chunks de 200 sesiones) y calculaba en JavaScript: item_count, count_records,
-- audited_items, ok_items, missing_items, surplus_items, not_counted_items,
-- diff_units, diff_value — por sesion. Esto se repetia completo cada vez que
-- se generaba el resumen.
--
-- Esta funcion devuelve, para un conjunto de sesiones, UNA fila por sesion ya
-- con esos 8 agregados calculados. El cliente sigue trayendo audit_sessions
-- (con los joins a stores/cyclic_users para los nombres, ya acotado por rango
-- de fechas y status='finished', eso NO cambia) y hace un merge por session_id
-- con lo que devuelve esta funcion.
--
-- Replica EXACTAMENTE la logica previa del cliente:
--   - counted (cantidad contada por item) = SUM(quantity) de audit_counts
--     agrupado por item_id, dentro de las sesiones dadas.
--   - diff = counted - system_stock (si el item nunca fue contado, counted = 0,
--     por lo que un item con stock > 0 nunca contado cuenta como "faltante" —
--     asi se comportaba el .get(...) || 0 del cliente).
--   - audited_items / ok_items SI requieren que el item tenga al menos un
--     registro en audit_counts (was_counted), a diferencia de missing/surplus
--     que se calculan sobre TODOS los items tengan o no conteo.
--   - count_records = cantidad de FILAS de audit_counts por sesion (no de
--     items distintos).
--
-- Indices que la soportan (ya existentes, no se crean nuevos):
--   - idx_audit_items_session  ON audit_session_items(session_id)
--   - idx_audit_counts_session ON audit_counts(session_id)
--   - idx_audit_counts_item    ON audit_counts(item_id)

CREATE OR REPLACE FUNCTION get_audit_admin_summary(
  p_session_ids uuid[]
)
RETURNS TABLE (
  session_id uuid,
  item_count integer,
  count_records integer,
  audited_items integer,
  ok_items integer,
  missing_items integer,
  surplus_items integer,
  not_counted_items integer,
  diff_units numeric,
  diff_value numeric
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH counted AS (
    SELECT item_id, SUM(quantity) AS counted_qty
    FROM audit_counts
    WHERE session_id = ANY (p_session_ids)
    GROUP BY item_id
  ),
  count_records AS (
    SELECT session_id, COUNT(*) AS records
    FROM audit_counts
    WHERE session_id = ANY (p_session_ids)
    GROUP BY session_id
  ),
  item_diffs AS (
    SELECT
      i.session_id,
      (c.item_id IS NOT NULL) AS was_counted,
      COALESCE(c.counted_qty, 0) - COALESCE(i.system_stock, 0) AS diff,
      COALESCE(i.cost_snapshot, 0) AS cost_snapshot
    FROM audit_session_items i
    LEFT JOIN counted c ON c.item_id = i.id
    WHERE i.session_id = ANY (p_session_ids)
  ),
  item_agg AS (
    SELECT
      session_id,
      COUNT(*) AS item_count,
      COUNT(*) FILTER (WHERE was_counted) AS audited_items,
      COUNT(*) FILTER (WHERE was_counted AND diff = 0) AS ok_items,
      COUNT(*) FILTER (WHERE diff < 0) AS missing_items,
      COUNT(*) FILTER (WHERE diff > 0) AS surplus_items,
      SUM(diff) AS diff_units,
      SUM(diff * cost_snapshot) AS diff_value
    FROM item_diffs
    GROUP BY session_id
  )
  SELECT
    s.id AS session_id,
    COALESCE(a.item_count, 0)::integer,
    COALESCE(cr.records, 0)::integer,
    COALESCE(a.audited_items, 0)::integer,
    COALESCE(a.ok_items, 0)::integer,
    COALESCE(a.missing_items, 0)::integer,
    COALESCE(a.surplus_items, 0)::integer,
    GREATEST(0, COALESCE(a.item_count, 0) - COALESCE(a.audited_items, 0))::integer,
    COALESCE(a.diff_units, 0),
    COALESCE(a.diff_value, 0)
  FROM unnest(p_session_ids) AS s(id)
  LEFT JOIN item_agg a ON a.session_id = s.id
  LEFT JOIN count_records cr ON cr.session_id = s.id;
$$;

GRANT EXECUTE ON FUNCTION get_audit_admin_summary(uuid[]) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
