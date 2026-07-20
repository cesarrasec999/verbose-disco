-- Optimizacion de Picking para Administrador/Supervisor/Validador (rol "manager"),
-- mismo patron ya aplicado para Operario en 20260714190000_picking_my_assignments_fn.sql.
--
-- Antes: PickingModule.tsx cargaba, en UNA sola pasada al entrar al modulo (sin
-- importar pestana ni fecha seleccionada), TODOS los picking_requests activos
-- (limit 500, aunque hay 1000+), TODAS sus picking_request_lines (31,612 filas)
-- y TODAS sus picking_assignments no canceladas (28,085 filas), paginando de
-- 1000 en 1000. Cada pestana (asignacion/resumen/reportes/registros/productividad)
-- solo filtraba ese dataset gigante en memoria del navegador.
--
-- Ahora cada pestana pide al servidor solo lo que corresponde a la fecha que
-- esta mirando en ese momento. Hay 3 semanticas de fecha distintas sobre las
-- mismas tablas (ver PickingModule.tsx):
--   1) Asignacion: picking_requests.creation_date = fecha elegida. Se resuelve
--      directamente en el cliente con .gte/.lt sobre creation_date (no necesita
--      funcion SQL, es un filtro de una sola tabla); ver indice mas abajo.
--   2) Resumen y Reportes: "fecha efectiva" de una asignacion = picking_date si
--      existe, si no la fecha del primer scan del REQUERIMIENTO (no de la
--      asignacion), si no created_at. Se resuelve con get_picking_assignments_by_date.
--   3) Registros y Productividad: picking_scans.created_at (un dia puntual para
--      Registros, un rango para Productividad). Se resuelve con
--      get_picking_scans_by_date_range.

-- ---------------------------------------------------------------------------
-- 1) Indice para el filtro de Asignacion: picking_requests activos, no
--    ocultos, por creation_date. Antes solo existian indices donde
--    creation_date iba DESPUES de reason/source_store_code (que Asignacion no
--    filtra), por lo que el filtro por fecha no podia usar esos indices de
--    forma eficiente. Parcial (WHERE hidden_at IS NULL) porque hidden_at casi
--    siempre es NULL y es exactamente lo que filtra el cliente.
CREATE INDEX IF NOT EXISTS idx_picking_requests_status_created_visible
  ON public.picking_requests (status_code, creation_date DESC)
  WHERE hidden_at IS NULL;

-- 2) Indice para Registros/Productividad: buscar picking_scans por fecha SIN
--    depender de request_id/picker_id (hoy no existe ningun indice con
--    created_at como columna principal). Sin esto, get_picking_scans_by_date_range
--    cae en seq scan sobre picking_scans completa (20,604 filas hoy, creciendo).
CREATE INDEX IF NOT EXISTS idx_picking_scans_created_at
  ON public.picking_scans (created_at DESC);

-- ---------------------------------------------------------------------------
-- 3) Resumen y Reportes comparten la misma "fecha efectiva" de asignacion.
--
-- picking_date se agrega en cada asignacion desde el 2026-05-29 (ver
-- 20260529133000_picking_date_assignments.sql) y hoy cubre la mayoria de filas
-- activas (26,263 de 28,085); el resto (1,822, historicas, no crece) no tiene
-- picking_date y su fecha efectiva depende del primer scan de su requerimiento.
-- Separamos ambos casos en un UNION para que el camino rapido (picking_date
-- indexado) no pague el costo de la subconsulta de scans, y esa subconsulta
-- solo corra sobre el subconjunto acotado (y estatico) sin picking_date.
--
-- p_date NULL reproduce el comportamiento de "Limpiar fecha" en el cliente
-- (sameDate(valor, "") === true, es decir sin filtro de fecha): devuelve todas
-- las asignaciones activas de requerimientos visibles, igual que el fetch
-- completo original.
CREATE OR REPLACE FUNCTION get_picking_assignments_by_date(p_date date)
RETURNS TABLE (
  assignment jsonb,
  request jsonb,
  line jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_date IS NULL THEN
    RETURN QUERY
      SELECT to_jsonb(a.*), to_jsonb(r.*), to_jsonb(l.*)
      FROM picking_assignments a
      JOIN picking_requests r ON r.id = a.request_id
      JOIN picking_request_lines l ON l.id = a.line_id
      WHERE r.status_code = 'A'
        AND r.hidden_at IS NULL
        AND a.status <> 'cancelado'
      ORDER BY a.created_at DESC;
    RETURN;
  END IF;

  RETURN QUERY
    WITH candidate_ids AS (
      -- Camino rapido: picking_date explicito, usa idx_picking_assignments_picking_date.
      SELECT a.id
      FROM picking_assignments a
      WHERE a.picking_date = p_date
        AND a.status <> 'cancelado'
      UNION ALL
      -- Fallback: asignaciones historicas sin picking_date; la fecha efectiva
      -- es el primer scan de TODO el requerimiento (no solo de esta
      -- asignacion), igual que firstScanDateByRequest en el cliente.
      SELECT a.id
      FROM picking_assignments a
      LEFT JOIN LATERAL (
        SELECT MIN(s.created_at)::date AS first_scan_date
        FROM picking_scans s
        WHERE s.request_id = a.request_id
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
    WHERE r.status_code = 'A'
      AND r.hidden_at IS NULL
    ORDER BY a.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_picking_assignments_by_date(date) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Registros (un dia puntual, p_from = p_to) y Productividad (rango, puede
--    venir con un solo extremo o ninguno) comparten esta funcion.
--
-- Incluye picking_assignments en el join (no solo scan/request/line) porque
-- el boton "Eliminar" de la pestana Registros (deleteScan) busca la
-- asignacion del scan en el estado local (assignments.find); si no viajara
-- aca, ese boton dejaria de funcionar al dejar de traer el dataset completo.
--
-- p_from y p_to NULL (el estado inicial real de Productividad, y el resultado
-- de "Limpiar fecha" en Registros) reproduce el limite de 2000 escaneos mas
-- recientes que ya usaba el fetch completo original (antes ese limite de 2000
-- era GLOBAL para el modulo entero; ahora es especificamente el default de
-- "sin filtro de fecha", mismo numero, mismo orden). Con cualquiera de los
-- dos extremos presente se filtra por rango sin limite: esto corrige que
-- antes, si el usuario elegia un rango viejo, el filtro de fecha se aplicaba
-- en el navegador SOBRE esos mismos 2000 escaneos mas recientes y podia
-- devolver vacio aunque existieran escaneos reales para esa fecha.
CREATE OR REPLACE FUNCTION get_picking_scans_by_date_range(p_from date, p_to date)
RETURNS TABLE (
  scan jsonb,
  assignment jsonb,
  request jsonb,
  line jsonb
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT to_jsonb(s.*), to_jsonb(a.*), to_jsonb(r.*), to_jsonb(l.*)
  FROM picking_scans s
  JOIN picking_assignments a ON a.id = s.assignment_id
  JOIN picking_requests r ON r.id = s.request_id
  JOIN picking_request_lines l ON l.id = s.line_id
  WHERE r.status_code = 'A'
    AND r.hidden_at IS NULL
    AND s.created_at::date >= COALESCE(p_from, '0001-01-01'::date)
    AND s.created_at::date <= COALESCE(p_to, '9999-12-31'::date)
  ORDER BY s.created_at DESC
  LIMIT CASE WHEN p_from IS NULL AND p_to IS NULL THEN 2000 END;
$$;

GRANT EXECUTE ON FUNCTION get_picking_scans_by_date_range(date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
