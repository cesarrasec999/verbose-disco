-- El estado de RMS controla qué se puede asignar nuevamente. No debe borrar la
-- evidencia de una asignación o de un escaneo que ya ocurrió: un requerimiento
-- puede pasar a recepcionado después de que el picador culminó su trabajo.
--
-- La UI usa lecturas directas por fecha para cubrir esta regla de inmediato.
-- Esta migración mantiene la misma semántica en los RPC para la consulta sin
-- fecha y para cualquier consumidor futuro de estas funciones.

CREATE OR REPLACE FUNCTION get_picking_assignments_by_date(p_date date)
RETURNS TABLE (assignment jsonb, request jsonb, line jsonb)
LANGUAGE plpgsql STABLE SET search_path = public
AS $$
BEGIN
  IF p_date IS NULL THEN
    RETURN QUERY
      SELECT to_jsonb(a.*), to_jsonb(r.*), to_jsonb(l.*)
      FROM picking_assignments a
      JOIN picking_requests r ON r.id = a.request_id
      JOIN picking_request_lines l ON l.id = a.line_id
      WHERE r.hidden_at IS NULL
        AND a.status <> 'cancelado'
      ORDER BY a.created_at DESC;
    RETURN;
  END IF;

  RETURN QUERY
    WITH candidate_ids AS (
      SELECT a.id FROM picking_assignments a
      WHERE a.picking_date = p_date AND a.status <> 'cancelado'
      UNION ALL
      SELECT a.id FROM picking_assignments a
      LEFT JOIN LATERAL (
        SELECT MIN(s.created_at)::date AS first_scan_date
        FROM picking_scans s WHERE s.request_id = a.request_id
      ) fs ON true
      WHERE a.picking_date IS NULL
        AND a.status <> 'cancelado'
        AND COALESCE(fs.first_scan_date, a.created_at::date) = p_date
    )
    SELECT to_jsonb(a.*), to_jsonb(r.*), to_jsonb(l.*)
    FROM candidate_ids c
    JOIN picking_assignments a ON a.id = c.id
    JOIN picking_requests r ON r.id = a.request_id
    JOIN picking_request_lines l ON l.id = a.line_id
    WHERE r.hidden_at IS NULL
    ORDER BY a.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION get_picking_scans_by_date_range(p_from date, p_to date)
RETURNS TABLE (scan jsonb, assignment jsonb, request jsonb, line jsonb)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT to_jsonb(s.*), to_jsonb(a.*), to_jsonb(r.*), to_jsonb(l.*)
  FROM picking_scans s
  JOIN picking_assignments a ON a.id = s.assignment_id
  JOIN picking_requests r ON r.id = s.request_id
  JOIN picking_request_lines l ON l.id = s.line_id
  WHERE r.hidden_at IS NULL
    AND s.created_at::date >= COALESCE(p_from, '0001-01-01'::date)
    AND s.created_at::date <= COALESCE(p_to, '9999-12-31'::date)
  ORDER BY s.created_at DESC
  LIMIT CASE WHEN p_from IS NULL AND p_to IS NULL THEN 2000 END;
$$;

CREATE OR REPLACE FUNCTION get_my_picking_assignments(
  p_picker_id uuid, p_picker_name text, p_date date
)
RETURNS TABLE (assignment jsonb, request jsonb, line jsonb)
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT to_jsonb(a.*), to_jsonb(r.*), to_jsonb(l.*)
  FROM picking_assignments a
  JOIN picking_requests r ON r.id = a.request_id
  JOIN picking_request_lines l ON l.id = a.line_id
  WHERE r.hidden_at IS NULL
    AND a.status <> 'cancelado'
    AND (a.picker_id = p_picker_id OR a.picker_name = p_picker_name)
    AND COALESCE(a.picking_date, a.created_at::date) = p_date
  ORDER BY a.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_picking_assignments_by_date(date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_picking_scans_by_date_range(date, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_my_picking_assignments(uuid, text, date) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
