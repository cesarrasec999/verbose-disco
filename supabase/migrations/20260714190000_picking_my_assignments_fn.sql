-- Trae en UNA sola consulta indexada todo lo que necesita la vista del
-- operario de picking (sus asignaciones + el requerimiento + la linea de
-- cada una) PARA UNA FECHA PUNTUAL, en vez de que el cliente arme 3-4
-- fetches encadenados (ids de requerimientos activos -> asignaciones ->
-- requerimientos -> lineas) trayendo el historial completo del operario
-- como hacia antes. Cuentas de picking masivo acumulan miles de
-- asignaciones a lo largo de meses; filtrar por fecha en el servidor
-- reduce el volumen real transferido, no solo lo que se muestra.
--
-- La fecha "efectiva" de una asignacion es picking_date (se graba al
-- crearla, ver PickingModule.tsx linea ~1389); para filas viejas sin ese
-- campo se usa la fecha de creacion como aproximacion.
--
-- El filtro por picker usa el indice existente idx_picking_assignments_picker
-- (picker_id) + el nuevo idx sobre picker_name para el caso de operarios
-- sin picker_id asignado, combinado con idx_picking_assignments_picking_date
-- (ya existente) para la fecha.

CREATE OR REPLACE FUNCTION get_my_picking_assignments(
  p_picker_id uuid,
  p_picker_name text,
  p_date date
)
RETURNS TABLE (
  assignment jsonb,
  request jsonb,
  line jsonb
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    to_jsonb(a.*) AS assignment,
    to_jsonb(r.*) AS request,
    to_jsonb(l.*) AS line
  FROM picking_assignments a
  JOIN picking_requests r ON r.id = a.request_id
  JOIN picking_request_lines l ON l.id = a.line_id
  WHERE r.status_code = 'A'
    AND r.hidden_at IS NULL
    AND a.status <> 'cancelado'
    AND (a.picker_id = p_picker_id OR a.picker_name = p_picker_name)
    AND COALESCE(a.picking_date, a.created_at::date) = p_date
  ORDER BY a.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_my_picking_assignments(uuid, text, date) TO anon, authenticated;

-- Soporte para la mitad del OR que no cubre idx_picking_assignments_picker
-- (operarios cuyas asignaciones viejas se guardaron solo con picker_name).
CREATE INDEX IF NOT EXISTS idx_picking_assignments_picker_name
  ON picking_assignments (picker_name, status);

-- Los escaneos propios del operario ya vienen acotados por picker_id + limit,
-- pero sin indice caen en seq scan a medida que crece picking_scans.
CREATE INDEX IF NOT EXISTS idx_picking_scans_picker
  ON picking_scans (picker_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
