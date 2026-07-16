-- Modulo nuevo "Checklist" (auditoria diaria de almacenes por auditor).
-- Reemplaza el Google Sheet manual (una pestana por auditor con marcas
-- 1/0/J por tienda y por dia) - ver LOG_PROYECTO.md 2026-07-16.
--
-- checklist_store_assignments: que tienda le toca a que auditor. Separado
-- del modelo general de acceso a tiendas (cyclic_users.store_id /
-- can_access_all_stores) porque los 3 auditores actuales (ricardo, branco,
-- martin) ya tienen can_access_all_stores=true para sus otros modulos
-- (auditoria, inventarios, etc.) pero deben ver solo un subconjunto de
-- tiendas dentro de Checklist especificamente.
--
-- checklist_entries: una fila por tienda+item+dia. Los 7 items son fijos
-- (ver INFO del Sheet original) y se hardcodean en el cliente, no hace
-- falta tabla catalogo para 7 filas que no cambian.

CREATE TABLE IF NOT EXISTS checklist_store_assignments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  auditor_user_id  uuid        NOT NULL REFERENCES cyclic_users(id) ON DELETE CASCADE,
  store_id         uuid        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auditor_user_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_checklist_assignments_auditor ON checklist_store_assignments (auditor_user_id);
CREATE INDEX IF NOT EXISTS idx_checklist_assignments_store   ON checklist_store_assignments (store_id);

CREATE TABLE IF NOT EXISTS checklist_entries (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  item_key     text        NOT NULL,
  entry_date   date        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('cumple', 'no_cumple', 'justificado')),
  notes        text,
  created_by   uuid        REFERENCES cyclic_users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, item_key, entry_date)
);

CREATE INDEX IF NOT EXISTS idx_checklist_entries_store_date ON checklist_entries (store_id, entry_date);

ALTER TABLE checklist_store_assignments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon_read_checklist_store_assignments"  ON checklist_store_assignments FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_checklist_store_assignments" ON checklist_store_assignments FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE checklist_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "anon_read_checklist_entries"  ON checklist_entries FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_write_checklist_entries" ON checklist_entries FOR ALL    TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- "Auditoria de Existencia" por tienda: ERI (ok_items/audited_items*100)
-- de TODAS las sesiones de auditoria de stock (modulo Auditorias)
-- finalizadas de esa tienda dentro del rango dado, sumando codigos de
-- todas las sesiones si hubo 2 o mas (misma logica de join que
-- get_audit_admin_summary, agrupada por tienda en vez de por sesion).
CREATE OR REPLACE FUNCTION get_checklist_existencia_summary(
  p_store_ids uuid[],
  p_from      timestamptz,
  p_to        timestamptz
)
RETURNS TABLE (
  store_id       uuid,
  session_count  integer,
  audited_items  integer,
  ok_items       integer,
  eri            integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH sessions AS (
    SELECT s.id, s.store_id
    FROM audit_sessions s
    WHERE s.store_id = ANY (p_store_ids)
      AND s.status = 'finished'
      AND s.started_at >= p_from
      AND s.started_at < p_to
  ),
  counted AS (
    SELECT item_id, SUM(quantity) AS counted_qty
    FROM audit_counts
    WHERE session_id IN (SELECT id FROM sessions)
    GROUP BY item_id
  ),
  item_diffs AS (
    SELECT
      i.session_id,
      sess.store_id,
      (c.item_id IS NOT NULL) AS was_counted,
      COALESCE(c.counted_qty, 0) - COALESCE(i.system_stock, 0) AS diff
    FROM audit_session_items i
    JOIN sessions sess ON sess.id = i.session_id
    LEFT JOIN counted c ON c.item_id = i.id
  ),
  store_agg AS (
    SELECT
      store_id,
      COUNT(DISTINCT session_id) AS session_count,
      COUNT(*) FILTER (WHERE was_counted) AS audited_items,
      COUNT(*) FILTER (WHERE was_counted AND diff = 0) AS ok_items
    FROM item_diffs
    GROUP BY store_id
  )
  SELECT
    st.id AS store_id,
    COALESCE(a.session_count, 0)::integer,
    COALESCE(a.audited_items, 0)::integer,
    COALESCE(a.ok_items, 0)::integer,
    CASE WHEN COALESCE(a.audited_items, 0) = 0 THEN 0
         ELSE ROUND((a.ok_items::numeric / a.audited_items) * 100)::integer
    END AS eri
  FROM unnest(p_store_ids) AS st(id)
  LEFT JOIN store_agg a ON a.store_id = st.id;
$$;

GRANT EXECUTE ON FUNCTION get_checklist_existencia_summary(uuid[], timestamptz, timestamptz) TO anon, authenticated;

-- Resumen de cumplimiento del checklist diario por tienda en un rango de
-- fechas, agregado en la BD (no en el cliente) - checklist_entries puede
-- superar facil el limite default de 1000 filas por query de
-- PostgREST/Supabase para un rango de un mes con muchas tiendas (7 items x
-- ~26 dias x 30 tiendas > 5000 filas), mismo problema ya visto varias
-- veces en este proyecto (creditos-cobranzas, inventarios,
-- no-inventariables).
-- pct_cumplimiento = cumplio / (cumplio + no_cumplio), igual formula
-- implicita que ya usa el Google Sheet original (justificado no cuenta en
-- el denominador).
CREATE OR REPLACE FUNCTION get_checklist_period_summary(
  p_store_ids uuid[],
  p_from      date,
  p_to        date
)
RETURNS TABLE (
  store_id     uuid,
  cumplio      integer,
  no_cumplio   integer,
  justificado  integer,
  pct          integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    st.id AS store_id,
    COUNT(*) FILTER (WHERE e.status = 'cumple')::integer AS cumplio,
    COUNT(*) FILTER (WHERE e.status = 'no_cumple')::integer AS no_cumplio,
    COUNT(*) FILTER (WHERE e.status = 'justificado')::integer AS justificado,
    CASE WHEN COUNT(*) FILTER (WHERE e.status IN ('cumple', 'no_cumple')) = 0 THEN 0
         ELSE ROUND(
           COUNT(*) FILTER (WHERE e.status = 'cumple')::numeric
           / COUNT(*) FILTER (WHERE e.status IN ('cumple', 'no_cumple')) * 100
         )::integer
    END AS pct
  FROM unnest(p_store_ids) AS st(id)
  LEFT JOIN checklist_entries e
    ON e.store_id = st.id AND e.entry_date >= p_from AND e.entry_date <= p_to
  GROUP BY st.id;
$$;

GRANT EXECUTE ON FUNCTION get_checklist_period_summary(uuid[], date, date) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
