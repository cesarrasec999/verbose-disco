-- Endurecimiento de seguridad, fase 1.
--
-- Alcance deliberadamente conservador para una base en operación:
--   * no elimina ni modifica filas;
--   * protege respaldos y logs que no deben escribirse por PostgREST;
--   * conserva la lectura del historial de ubicaciones usada por la exportación;
--   * vuelve SECURITY INVOKER las dos vistas señaladas por el Advisor;
--   * fija search_path en funciones no privilegiadas;
--   * retira EXECUTE únicamente de funciones internas de trigger/mantenimiento.

begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- Los respaldos son evidencia de recuperación y no forman parte de ningún flujo
-- de la aplicación. service_role/postgres conservan acceso y no se toca su data.
do $block$
declare
  backup_name text;
begin
  foreach backup_name in array array[
    'gis_backup_20260617',
    'ivsp_backup_20260617',
    'ivss_backup_20260617',
    'product_locations_backup_20260617',
    'stores_backup_20260617'
  ] loop
    if to_regclass(format('public.%I', backup_name)) is not null then
      execute format('alter table public.%I enable row level security', backup_name);
      execute format('revoke all on table public.%I from anon, authenticated', backup_name);
    end if;
  end loop;
end
$block$;

-- El log se escribe exclusivamente dentro de remove_audit_session_item(), que es
-- SECURITY DEFINER. Ningún cliente necesita acceso directo a la tabla.
alter table if exists public.audit_session_item_removal_log enable row level security;
revoke all on table public.audit_session_item_removal_log from anon, authenticated;

-- El trigger SECURITY DEFINER continúa escribiendo el historial. El cliente sólo
-- necesita SELECT para la descarga Excel existente.
alter table if exists public.product_location_history enable row level security;
revoke insert, update, delete, truncate, references, trigger
  on table public.product_location_history from anon, authenticated;
grant select on table public.product_location_history to anon, authenticated;

drop policy if exists product_location_history_api_read
  on public.product_location_history;
create policy product_location_history_api_read
  on public.product_location_history
  for select
  to anon, authenticated
  using (true);

-- Las tablas base ya tienen RLS y políticas compatibles con la lectura actual.
alter view if exists public.abastecimiento_delivery_pending
  set (security_invoker = true);
alter view if exists public.abastecimiento_reception_pending
  set (security_invoker = true);

-- Funciones señaladas por "Function Search Path Mutable". Sólo se cambia la
-- resolución de nombres; no se reemplaza el cuerpo ni se ejecutan las funciones.
alter function public.get_cyclic_assignment_recommendations(uuid, date, integer, integer)
  set search_path = pg_catalog, public;
alter function public.get_cyclic_sales_assignment_recommendations(uuid, date, integer)
  set search_path = pg_catalog, public;
alter function public.get_erp_movement_product_prefixes(text, integer)
  set search_path = pg_catalog, public;
alter function public.get_erp_movement_store_codes()
  set search_path = pg_catalog, public;
alter function public.get_finished_general_inventory_report(date, date)
  set search_path = pg_catalog, public;
alter function public.get_general_inventory_summary(uuid)
  set search_path = pg_catalog, public;
alter function public.refresh_cyclic_assignment_stock(date, uuid)
  set search_path = pg_catalog, public;
alter function public.refresh_cyclic_assignment_stock(date)
  set search_path = pg_catalog, public;
alter function public.refresh_picking_line_totals()
  set search_path = pg_catalog, public;
alter function public.refresh_product_rotations(date, text, text)
  set search_path = pg_catalog, public;
alter function public.refresh_product_rotations(date, text)
  set search_path = pg_catalog, public;
alter function public.refresh_product_rotations(date)
  set search_path = pg_catalog, public;
alter function public.refresh_product_sales_daily(date, date, text, text)
  set search_path = pg_catalog, public;
alter function public.refresh_store_movement_history(text)
  set search_path = pg_catalog, public;
alter function public.touch_cyclic_user_session_updated_at()
  set search_path = pg_catalog, public;
alter function public.touch_stock_general_sync_status()
  set search_path = pg_catalog, public;

-- Estas funciones sólo son invocadas por triggers o por otras funciones del
-- servidor. Quitar EXECUTE a clientes no afecta la ejecución del trigger.
revoke all on function public.block_open_inventory_location_publish()
  from public, anon, authenticated;
revoke all on function public.check_gi_session_not_finished()
  from public, anon, authenticated;
revoke all on function public.enqueue_general_inventory_location_sync()
  from public, anon, authenticated;
revoke all on function public.log_product_location_history()
  from public, anon, authenticated;
revoke all on function public.reconcile_general_inventory_location_dates_for_store(uuid)
  from public, anon, authenticated;
revoke all on function public.sync_general_inventory_location(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.sync_general_inventory_locations_after_finished()
  from public, anon, authenticated;
revoke all on function public.sync_general_inventory_locations_for_store(uuid)
  from public, anon, authenticated;
revoke all on function public.sync_product_location_from_general_inventory_count()
  from public, anon, authenticated;
revoke all on function public.validate_cd_gpc_location_format()
  from public, anon, authenticated;

-- Las RPC usadas por PWA/APK/web mantienen sus grants actuales.

notify pgrst, 'reload schema';

commit;
