-- Optimizacion segura para Inventarios Generales / Reconteo / Validacion.
-- Compatible con Supabase SQL Editor y con esquemas que pueden tener columnas faltantes.
--
-- No borra ni actualiza registros. Solo crea indices cuando la tabla y sus columnas existen.
-- Si algo no existe en tu base actual, se salta y continua.

set statement_timeout = '10min';
set lock_timeout = '15s';

do $$
begin
  if to_regclass('public.general_inventory_counts') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_counts' and column_name = 'product_id') then
      execute 'create index if not exists idx_gi_counts_session_product on public.general_inventory_counts(session_id, product_id)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_counts' and column_name = 'operator_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_counts' and column_name = 'counted_at') then
      execute 'create index if not exists idx_gi_counts_session_operator_recent on public.general_inventory_counts(session_id, operator_id, counted_at desc)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_counts' and column_name = 'location_code') then
      execute 'create index if not exists idx_gi_counts_session_location_code on public.general_inventory_counts(session_id, location_code)';
    end if;
  end if;

  if to_regclass('public.general_inventory_recount_items') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_items' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_items' and column_name = 'status')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_items' and column_name = 'recount_type') then
      execute 'create index if not exists idx_gi_recount_items_session_status_type on public.general_inventory_recount_items(session_id, status, recount_type)';
    end if;
  end if;

  if to_regclass('public.general_inventory_recount_counts') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_counts' and column_name = 'product_id') then
      execute 'create index if not exists idx_gi_recount_counts_session_product on public.general_inventory_recount_counts(session_id, product_id)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_counts' and column_name = 'operator_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_recount_counts' and column_name = 'counted_at') then
      execute 'create index if not exists idx_gi_recount_counts_session_operator_recent on public.general_inventory_recount_counts(session_id, operator_id, counted_at desc)';
    end if;
  end if;

  if to_regclass('public.general_inventory_validation_items') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_items' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_items' and column_name = 'status')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_items' and column_name = 'recount_type') then
      execute 'create index if not exists idx_gi_validation_items_session_status_type on public.general_inventory_validation_items(session_id, status, recount_type)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_items' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_items' and column_name = 'assigned_operator_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_items' and column_name = 'status') then
      execute 'create index if not exists idx_gi_validation_items_session_operator_status on public.general_inventory_validation_items(session_id, assigned_operator_id, status)';
    end if;
  end if;

  if to_regclass('public.general_inventory_validation_counts') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_counts' and column_name = 'validation_item_id') then
      execute 'create index if not exists idx_gi_validation_counts_session_item on public.general_inventory_validation_counts(session_id, validation_item_id)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_counts' and column_name = 'product_id') then
      execute 'create index if not exists idx_gi_validation_counts_session_product on public.general_inventory_validation_counts(session_id, product_id)';
    end if;

    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_counts' and column_name = 'operator_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'general_inventory_validation_counts' and column_name = 'counted_at') then
      execute 'create index if not exists idx_gi_validation_counts_session_operator_recent on public.general_inventory_validation_counts(session_id, operator_id, counted_at desc)';
    end if;
  end if;

  if to_regclass('public.product_locations') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_locations' and column_name = 'store_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_locations' and column_name = 'location')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'product_locations' and column_name = 'is_active') then
      execute 'create index if not exists idx_product_locations_store_location_active on public.product_locations(store_id, location) where is_active = true';
    end if;
  end if;

  if to_regclass('public.cyclic_counts') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cyclic_counts' and column_name = 'store_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cyclic_counts' and column_name = 'user_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cyclic_counts' and column_name = 'counted_at') then
      execute 'create index if not exists idx_cyclic_counts_store_user_recent on public.cyclic_counts(store_id, user_id, counted_at desc)';
    end if;

  end if;

  if to_regclass('public.audit_counts') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_counts' and column_name = 'session_id')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_counts' and column_name = 'counted_by')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_counts' and column_name = 'counted_at') then
      execute 'create index if not exists idx_audit_counts_session_counter_recent on public.audit_counts(session_id, counted_by, counted_at desc)';
    end if;

  end if;
end $$;

notify pgrst, 'reload schema';
