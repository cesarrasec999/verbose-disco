-- ══════════════════════════════════════════════════════════════
--  TOTALES DE VENTAS A CREDITO (server-side)
--  Reemplaza la segunda query del load() de CreditosCobranzasModule
--  que traia importe_total + cumple_documentacion de TODAS las filas
--  filtradas (miles, paginadas de a 1000) solo para sumar/contar en
--  el navegador. Ahora la base devuelve 1 sola fila con SUM/COUNT.
--
--  Nota: la agregacion nativa de PostgREST (select=importe_total.sum())
--  esta deshabilitada en este proyecto (PGRST123), por eso va como RPC.
--
--  Replica EXACTAMENTE los filtros de applyBaseFilters/applyColumnFilters:
--  - p_store / p_status: NULL = sin filtro (el cliente manda NULL cuando
--    storeFilter esta vacio o statusFilter es "all").
--  - p_sub_tab: 'notas_credito' => sales_code = 'R'; cualquier otro valor
--    => sales_code <> 'R' (igual que .neq(), excluye NULL).
--  - p_filters: jsonb { columna: texto } con los filtros de columna ya
--    trimmeados por el cliente; cada uno se aplica como ILIKE '%valor%'.
--    replace(valor,'*','%') replica la traduccion * -> % que PostgREST
--    hace en los patrones like/ilike de la query principal.
--  - fecha_emision/fecha_recepcion/registro se castean a text para el
--    ILIKE (mismo intent que FILTER_EXPR en el cliente).
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_ventas_credito_totales(
  p_date_from date,
  p_date_to   date,
  p_store     text  DEFAULT NULL,
  p_status    text  DEFAULT NULL,
  p_sub_tab   text  DEFAULT 'ventas',
  p_filters   jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  importe_total numeric,
  cumplen       bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(v.importe_total), 0)::numeric              AS importe_total,
    COUNT(*) FILTER (WHERE v.cumple_documentacion)          AS cumplen
  FROM ventas_credito v
  WHERE v.fecha_emision >= p_date_from
    AND v.fecha_emision <= p_date_to
    AND (p_store  IS NULL OR v.store_code  = p_store)
    AND (p_status IS NULL OR v.status_code = p_status)
    AND CASE WHEN p_sub_tab = 'notas_credito'
             THEN v.sales_code = 'R'
             ELSE v.sales_code <> 'R'
        END
    AND (p_filters->>'document_type'           IS NULL OR v.document_type           ILIKE '%' || replace(p_filters->>'document_type', '*', '%') || '%')
    AND (p_filters->>'nc_documento_referencia' IS NULL OR v.nc_documento_referencia ILIKE '%' || replace(p_filters->>'nc_documento_referencia', '*', '%') || '%')
    AND (p_filters->>'store_name'              IS NULL OR v.store_name              ILIKE '%' || replace(p_filters->>'store_name', '*', '%') || '%')
    AND (p_filters->>'serie'                   IS NULL OR v.serie                   ILIKE '%' || replace(p_filters->>'serie', '*', '%') || '%')
    AND (p_filters->>'numero_documento'        IS NULL OR v.numero_documento        ILIKE '%' || replace(p_filters->>'numero_documento', '*', '%') || '%')
    AND (p_filters->>'ruc'                     IS NULL OR v.ruc                     ILIKE '%' || replace(p_filters->>'ruc', '*', '%') || '%')
    AND (p_filters->>'razon_social'            IS NULL OR v.razon_social            ILIKE '%' || replace(p_filters->>'razon_social', '*', '%') || '%')
    AND (p_filters->>'fecha_emision'           IS NULL OR v.fecha_emision::text     ILIKE '%' || replace(p_filters->>'fecha_emision', '*', '%') || '%')
    AND (p_filters->>'condicion'               IS NULL OR v.condicion               ILIKE '%' || replace(p_filters->>'condicion', '*', '%') || '%')
    AND (p_filters->>'asesora_nombre'          IS NULL OR v.asesora_nombre          ILIKE '%' || replace(p_filters->>'asesora_nombre', '*', '%') || '%')
    AND (p_filters->>'asesora_dni'             IS NULL OR v.asesora_dni             ILIKE '%' || replace(p_filters->>'asesora_dni', '*', '%') || '%')
    AND (p_filters->>'registro'                IS NULL OR v.registro::text          ILIKE '%' || replace(p_filters->>'registro', '*', '%') || '%')
    AND (p_filters->>'legajo'                  IS NULL OR v.legajo                  ILIKE '%' || replace(p_filters->>'legajo', '*', '%') || '%')
    AND (p_filters->>'status_label'            IS NULL OR v.status_label            ILIKE '%' || replace(p_filters->>'status_label', '*', '%') || '%')
    AND (p_filters->>'observacion'             IS NULL OR v.observacion             ILIKE '%' || replace(p_filters->>'observacion', '*', '%') || '%')
    AND (p_filters->>'fecha_recepcion'         IS NULL OR v.fecha_recepcion::text   ILIKE '%' || replace(p_filters->>'fecha_recepcion', '*', '%') || '%');
$$;

GRANT EXECUTE ON FUNCTION get_ventas_credito_totales(date, date, text, text, text, jsonb) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
