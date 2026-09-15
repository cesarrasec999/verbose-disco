-- Seguridad, fase 3: impide acceso PostgREST directo a particiones internas.
--
-- Las consultas de la aplicación usan las tablas padre. El sincronizador ERP
-- usa service_role. No se toca la partición activa de septiembre de 2026 para
-- evitar competir por locks con las cargas que están corriendo.

begin;

set local lock_timeout = '1s';
set local statement_timeout = '20s';

do $block$
declare
  child record;
begin
  for child in
    select child_ns.nspname as schema_name, child_class.relname as table_name
    from pg_inherits inh
    join pg_class parent_class on parent_class.oid = inh.inhparent
    join pg_namespace parent_ns on parent_ns.oid = parent_class.relnamespace
    join pg_class child_class on child_class.oid = inh.inhrelid
    join pg_namespace child_ns on child_ns.oid = child_class.relnamespace
    where parent_ns.nspname = 'public'
      and parent_class.relname in (
        'erp_movements',
        'inventory_valuation_snapshot_products',
        'stock_snapshot_daily'
      )
      and child_class.relname not in (
        'erm_2026_09',
        'ivsp_2026_09',
        'ssd_2026_09'
      )
  loop
    execute format(
      'alter table %I.%I enable row level security',
      child.schema_name,
      child.table_name
    );
    execute format(
      'revoke all on table %I.%I from anon, authenticated',
      child.schema_name,
      child.table_name
    );
  end loop;
end
$block$;

notify pgrst, 'reload schema';

commit;
