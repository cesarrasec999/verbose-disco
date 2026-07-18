-- ============================================================================
-- Inventario General: refresco de stock en tiempo real via trigger en
-- stock_general.
--
-- PROBLEMA QUE RESUELVE
-- Hoy el stock vivo del ERP (stock_general, alimentada cada 5 min por el sync
-- externo \\192.168.5.53\...\erp-sync\sync.js) solo se empuja a la "foto" de
-- una sesion abierta (general_inventory_stock_snapshot) cuando alguien tiene
-- la pestana "Resumen" abierta en el navegador (useEffect + throttle 55s,
-- refreshFullSessionSnapshotFromErp en src/app/inventarios/page.tsx:3073).
-- Si nadie tiene la pestana abierta, la foto queda congelada.
--
-- ESTA MIGRACION mueve esa logica a la base de datos: un trigger AFTER
-- INSERT/UPDATE en stock_general empuja cada cambio real de stock/costo a los
-- snapshots de TODAS las sesiones activas (status NOT IN
-- ('finished','cancelled')) de la tienda correspondiente, replicando EXACTO
-- el algoritmo de proteccion "OK" del cliente
-- (loadProtectedOkProductIdsForStockUpdate, src/app/inventarios/page.tsx
-- lineas 4233-4317): un producto cuyo conteo vigente (validacion > reconteo >
-- conteo original) coincide con el system_stock YA guardado en el snapshot
-- nunca se toca, aunque el ERP cambie.
--
-- El codigo cliente puede quedarse tal cual: el refresco manual/por pestana
-- y este trigger son idempotentes entre si (ambos respetan la misma regla de
-- proteccion); el trigger solo elimina la dependencia de tener un navegador
-- abierto.
--
-- RLS / SECURITY: todas las tablas involucradas tienen RLS habilitado pero
-- con politica permisiva "allow_anon_all" (ALL, USING(true) WITH CHECK(true)
-- para anon+authenticated), verificado contra la BD real el 2026-07-18.
-- El sync ERP ya escribe en stock_general sin problemas con esa politica,
-- asi que el trigger (SECURITY INVOKER, el default) puede leer/escribir todo
-- lo que necesita sin SECURITY DEFINER. Si algun dia se endurecen las
-- politicas RLS de general_inventory_stock_snapshot / *_counts / *_items,
-- habra que revisar si este trigger necesita pasar a SECURITY DEFINER.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Funcion auxiliar: conteo "vigente" de un producto en una sesion.
--
-- Replica DOS fuentes que deben dar el mismo numero (ya coinciden entre si,
-- verificado linea por linea al revisar esta migracion):
--   - loadProtectedOkProductIdsForStockUpdate (src/app/inventarios/page.tsx:
--     4233-4317), la regla de proteccion "OK" que usa el cliente.
--   - get_general_inventory_summary (supabase_inventarios_summary_optimized.sql,
--     funcion SQL YA EN PRODUCCION que calcula el "counted" que ve el
--     validador en Resumen) -- se tomo como referencia principal para el
--     desempate deterministico (item_id DESC) porque es la fuente mas
--     autoritativa: es la que ya corre hoy contra datos reales.
--
--   1. Capa original : SUM(quantity) de general_inventory_counts.
--   2. Capa reconteo : de los recount_items 'counted' del producto, gana el
--      que tiene la fila de recount_counts con timestamp mas reciente
--      (COALESCE(rcc.updated_at, rcc.counted_at, ri.updated_at,
--      ri.created_at), empate por ri.id DESC -- exactamente el ORDER BY de
--      get_general_inventory_summary linea 132). Se suman las filas de
--      recount_counts de ESE item (por unique(recount_item_id) es a lo sumo
--      1, pero se suma por si acaso). Un item 'counted' SIN fila en
--      recount_counts nunca puede ganar (el ganador se deriva de las filas
--      de conteo via el JOIN, no de los items sueltos). Si no hay ganador,
--      la capa no aplica (NULL, no 0).
--   3. Capa validacion (solo si validation_enabled): mismo patron, pero
--      contra validation_items/validation_counts, sumando TODAS las filas
--      de validation_counts del item ganador (esa tabla NO tiene unique por
--      item: puede haber varias, igual que en get_general_inventory_summary
--      linea 176-186).
--   4. Prioridad: validacion (si existe) > reconteo (si existe) > original
--      (default 0) -- mismo orden que el COALESCE de
--      get_general_inventory_summary linea 206.
--
-- La asociacion producto<->conteo se deriva SOLO de recount_items.product_id
-- / validation_items.product_id (el item), nunca de la columna desnormalizada
-- product_id de las tablas *_counts -- asi lo hacen ambas fuentes de
-- referencia, para no divergir si algun dato historico tuviera esa columna
-- desnormalizada distinta del item real.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gi_snapshot_counted_qty(
  p_session_id         uuid,
  p_product_id         uuid,
  p_validation_enabled boolean
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH original_total AS (
    SELECT COALESCE(SUM(COALESCE(c.quantity, 0)), 0) AS total
    FROM general_inventory_counts c
    WHERE c.session_id = p_session_id
      AND c.product_id = p_product_id
  ),
  recount_winner AS (
    -- La asociacion a producto viene SOLO de ri.product_id (el item), igual que
    -- get_general_inventory_summary (supabase_inventarios_summary_optimized.sql
    -- lineas 111-133) y que el JS de referencia -- rcc.product_id es una columna
    -- desnormalizada y NO se filtra por ella, para no divergir si algun dato
    -- historico la tuviera distinta del item. Empate de timestamp: item_id DESC,
    -- deterministico, igual que el ORDER BY de esa funcion (linea 132).
    SELECT rcc.recount_item_id AS item_id
    FROM general_inventory_recount_items ri
    JOIN general_inventory_recount_counts rcc
      ON rcc.recount_item_id = ri.id
     AND rcc.session_id = p_session_id
    WHERE ri.session_id = p_session_id
      AND ri.product_id = p_product_id
      AND ri.status = 'counted'
    ORDER BY COALESCE(rcc.updated_at, rcc.counted_at, ri.updated_at, ri.created_at) DESC NULLS LAST,
             ri.id DESC
    LIMIT 1
  ),
  recount_total AS (
    -- NULL si no hay ganador (capa no aplica); si hay ganador siempre tiene
    -- al menos la fila que lo hizo ganar, asi que el SUM es no-NULL.
    SELECT SUM(COALESCE(rcc.quantity, 0)) AS total
    FROM general_inventory_recount_counts rcc
    WHERE rcc.recount_item_id IN (SELECT item_id FROM recount_winner)
  ),
  validation_winner AS (
    -- Mismo criterio que recount_winner (ver comentario arriba), alineado con
    -- get_general_inventory_summary lineas 152-174.
    SELECT vcc.validation_item_id AS item_id
    FROM general_inventory_validation_items vi
    JOIN general_inventory_validation_counts vcc
      ON vcc.validation_item_id = vi.id
     AND vcc.session_id = p_session_id
    WHERE p_validation_enabled
      AND vi.session_id = p_session_id
      AND vi.product_id = p_product_id
      AND vi.status = 'counted'
    ORDER BY COALESCE(vcc.updated_at, vcc.counted_at, vi.updated_at, vi.created_at) DESC NULLS LAST,
             vi.id DESC
    LIMIT 1
  ),
  validation_total AS (
    -- Aqui SI se suman TODAS las filas del item ganador (no hay unique por
    -- validation_item_id, puede haber mas de una).
    SELECT SUM(COALESCE(vcc.quantity, 0)) AS total
    FROM general_inventory_validation_counts vcc
    WHERE vcc.validation_item_id IN (SELECT item_id FROM validation_winner)
  )
  SELECT COALESCE(
    (SELECT total FROM validation_total),
    (SELECT total FROM recount_total),
    (SELECT total FROM original_total)
  );
$$;

-- Util tambien para verificacion manual de la regla de proteccion via RPC.
GRANT EXECUTE ON FUNCTION gi_snapshot_counted_qty(uuid, uuid, boolean) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2) Funcion del trigger.
--
-- Orden de los chequeos pensado para que el caso comun (fila de una sede sin
-- ninguna sesion de inventario activa -- la enorme mayoria de las escrituras
-- del sync cada 5 min) salga lo antes posible con 1-2 index lookups:
--   a. tienda por sede (indice unico stores_erp_sede_unique)
--   b. EXISTS sesion activa de esa tienda (tabla chica)
--   c. producto por codsap (indice idx_cyclic_products_active_sku_upper
--      sobre upper(trim(sku)) WHERE is_active) -- mismo emparejamiento que
--      normalizeCode(x).toUpperCase() del cliente. El JS ademas limpia un
--      sufijo ".0" de Excel (normalizeCode, replace(/\.0+$/,"")); no se
--      replica aqui porque no ocurre en codsap real del ERP.
--   d. exclusion no-inventariable GLOBAL (cyclic_non_inventory_products,
--      indice idx_cyclic_non_inventory_sku_upper_active) -- igual que
--      fetchInventoryNonInventoryRows (src/features/inventarios/api.ts:131-155).
--   e. loop por sesion activa: exclusion no-inventariable POR SESION
--      (general_inventory_non_inventory_products), regla de proteccion "OK",
--      y upsert.
--
-- Reglas de escritura (mismas que refreshFullSessionSnapshotFromErp):
--   - Producto protegido (counted > 0 AND counted = system_stock actual del
--     snapshot, el valor VIEJO): no se toca nada.
--   - Sin fila previa en el snapshot: se inserta solo si el stock nuevo es
--     > 0 (el cliente tambien alimenta la foto solo con stock > 0). Nunca
--     esta "protegido" un producto sin fila previa.
--   - Con fila previa y no protegido: se actualiza system_stock/cost aunque
--     el stock nuevo sea 0 (el cliente en ese caso borra la fila "fantasma";
--     aqui se prefiere dejarla en 0 y NUNCA borrar -- regla dura del proyecto
--     de no borrar datos). Verificado que esto es invisible para el usuario:
--     get_general_inventory_summary (supabase_inventarios_summary_optimized.sql
--     linea 258) ya filtra "not (system_stock <= 0 and counted <= 0)" --
--     una fila en 0/0 nunca aparece en el Resumen, se comporte igual que si
--     no existiera.
--   - cost = COALESCE(NEW.costo, cyclic_products.cost, 0), mismo fallback que
--     Number(stock?.costo ?? product.cost ?? 0) del JS (page.tsx:3119).
--
-- Cualquier error inesperado se degrada a WARNING para no romper jamas el
-- UPDATE/UPSERT del sync ERP (el sync es mas critico que el refresco de la
-- foto; el refresco manual del cliente sigue existiendo como respaldo).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gi_stock_snapshot_sync_from_erp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_store_id    uuid;
  v_product_id  uuid;
  v_sku         text;
  v_description text;
  v_unit        text;
  v_prod_cost   numeric;
  v_session     RECORD;
  v_old_stock   numeric;
  v_has_row     boolean;
  v_counted     numeric;
  v_new_stock   numeric;
  v_new_cost    numeric;
BEGIN
  IF NEW.sede IS NULL OR NEW.codsap IS NULL OR btrim(NEW.codsap) = '' THEN
    RETURN NEW;
  END IF;

  -- a) Tienda (stores.erp_sede es UNIQUE, mapeo 1:1).
  SELECT s.id INTO v_store_id
  FROM stores s
  WHERE s.is_active = true
    AND s.erp_sede = NEW.sede
  LIMIT 1;
  IF v_store_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- b) Salida rapida si la tienda no tiene ninguna sesion activa.
  IF NOT EXISTS (
    SELECT 1 FROM general_inventory_sessions gs
    WHERE gs.store_id = v_store_id
      AND gs.status NOT IN ('finished', 'cancelled')
  ) THEN
    RETURN NEW;
  END IF;

  -- c) Producto activo por codsap (usa idx_cyclic_products_active_sku_upper).
  SELECT p.id, p.sku, p.description, p.unit, p.cost
    INTO v_product_id, v_sku, v_description, v_unit, v_prod_cost
  FROM cyclic_products p
  WHERE p.is_active = true
    AND upper(trim(p.sku)) = upper(trim(NEW.codsap))
  LIMIT 1;
  IF v_product_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- d) Exclusion no-inventariable global: no tocar jamas el snapshot.
  IF EXISTS (
    SELECT 1 FROM cyclic_non_inventory_products np
    WHERE np.is_active = true
      AND upper(trim(np.sku)) = upper(trim(v_sku))
  ) THEN
    RETURN NEW;
  END IF;

  v_new_stock := COALESCE(NEW.stock, 0);
  v_new_cost  := COALESCE(NEW.costo, v_prod_cost, 0);

  -- e) Todas las sesiones "activas para refresco" de la tienda (mismo
  -- criterio que el cliente: incluye 'planned', 'open' y 'frozen').
  FOR v_session IN
    SELECT gs.id, COALESCE(gs.validation_enabled, false) AS validation_enabled
    FROM general_inventory_sessions gs
    WHERE gs.store_id = v_store_id
      AND gs.status NOT IN ('finished', 'cancelled')
  LOOP
    -- Exclusion no-inventariable a nivel de ESTA sesion.
    IF EXISTS (
      SELECT 1 FROM general_inventory_non_inventory_products snp
      WHERE snp.session_id = v_session.id
        AND upper(trim(snp.sku)) = upper(trim(v_sku))
    ) THEN
      CONTINUE;
    END IF;

    -- system_stock VIEJO ya guardado en el snapshot (indice
    -- idx_gi_snapshot_session_product). Sin fila previa => nunca protegido.
    SELECT ss.system_stock INTO v_old_stock
    FROM general_inventory_stock_snapshot ss
    WHERE ss.session_id = v_session.id
      AND ss.product_id = v_product_id;
    v_has_row := FOUND;

    IF v_has_row THEN
      v_counted := gi_snapshot_counted_qty(v_session.id, v_product_id, v_session.validation_enabled);
      IF v_counted > 0 AND v_counted = v_old_stock THEN
        CONTINUE; -- protegido: el operario ya lo dejo "OK", no se toca.
      END IF;
    ELSIF v_new_stock <= 0 THEN
      CONTINUE; -- sin fila previa y sin stock: no se crea fila (igual que el cliente).
    END IF;

    INSERT INTO general_inventory_stock_snapshot AS ss
      (session_id, product_id, sku, description, unit, system_stock, cost, frozen_at)
    VALUES
      (v_session.id, v_product_id, v_sku, v_description, v_unit, v_new_stock, v_new_cost, now())
    ON CONFLICT (session_id, product_id) DO UPDATE SET
      sku          = EXCLUDED.sku,
      description  = EXCLUDED.description,
      unit         = EXCLUDED.unit,
      system_stock = EXCLUDED.system_stock,
      cost         = EXCLUDED.cost,
      frozen_at    = EXCLUDED.frozen_at;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'gi_stock_snapshot_sync_from_erp fallo (sede=%, codsap=%): %',
    NEW.sede, NEW.codsap, SQLERRM;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3) Triggers en stock_general. Dos separados (INSERT / UPDATE) porque un
-- WHEN que referencia OLD no puede compartirse con INSERT. El del UPDATE solo
-- dispara ante cambio real de stock o costo (el sync tambien toca updated_at
-- en cada ciclo; eso NO debe disparar nada).
-- Cubre los dos patrones de escritura del sync: UPDATE fila-a-fila (mayoria
-- de los ciclos) y UPSERT ON CONFLICT (sede, erp_sku) en reconciliaciones.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_stock_general_gi_snapshot_ins ON stock_general;
CREATE TRIGGER trg_stock_general_gi_snapshot_ins
  AFTER INSERT ON stock_general
  FOR EACH ROW
  EXECUTE FUNCTION gi_stock_snapshot_sync_from_erp();

DROP TRIGGER IF EXISTS trg_stock_general_gi_snapshot_upd ON stock_general;
CREATE TRIGGER trg_stock_general_gi_snapshot_upd
  AFTER UPDATE OF stock, costo ON stock_general
  FOR EACH ROW
  WHEN (NEW.stock IS DISTINCT FROM OLD.stock OR NEW.costo IS DISTINCT FROM OLD.costo)
  EXECUTE FUNCTION gi_stock_snapshot_sync_from_erp();

NOTIFY pgrst, 'reload schema';
