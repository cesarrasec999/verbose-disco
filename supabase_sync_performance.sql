-- Optimizaciones seguras para sincronizacion ERP -> Supabase -> web/app.
-- Ejecutar en Supabase SQL Editor. Es idempotente y no elimina datos.

create index if not exists idx_stock_general_sede_codsap
  on public.stock_general(sede, codsap);

create index if not exists idx_stock_general_codsap_sede
  on public.stock_general(codsap, sede);

create index if not exists idx_codigos_barra_codsap_upc
  on public.codigos_barra(codsap, upc);

create index if not exists idx_codigos_barra_upc_active
  on public.codigos_barra(upc, is_active)
  where upc is not null;

create index if not exists idx_codigos_barra_alu_active
  on public.codigos_barra(alu, is_active)
  where alu is not null;

create index if not exists idx_cyclic_products_sku_active
  on public.cyclic_products(sku, is_active);

create index if not exists idx_cyclic_assignments_date_store
  on public.cyclic_assignments(assigned_date, store_id);

create index if not exists idx_cyclic_assignments_product
  on public.cyclic_assignments(product_id);

create index if not exists idx_cyclic_counts_assignment_location
  on public.cyclic_counts(assignment_id, location);

create index if not exists idx_audit_items_session_product
  on public.audit_session_items(session_id, product_id);

create index if not exists idx_audit_counts_session_item
  on public.audit_counts(session_id, item_id);

create index if not exists idx_gi_counts_session_client_uuid
  on public.general_inventory_counts(session_id, client_uuid)
  where client_uuid is not null;

create index if not exists idx_gi_recount_items_session_operator_status
  on public.general_inventory_recount_items(session_id, assigned_operator_id, status);

create index if not exists idx_gi_recount_counts_session_item
  on public.general_inventory_recount_counts(session_id, recount_item_id);

create or replace function public.refresh_cyclic_assignment_stock(
  p_date date default current_date,
  p_store_id uuid default null
)
returns integer
language plpgsql
security definer
as $$
declare
  v_updated integer := 0;
begin
  perform set_config('statement_timeout', '4min', true);

  with latest_stock as (
    select
      ca.id,
      coalesce(sg.stock, 0)::numeric as stock
    from public.cyclic_assignments ca
    join public.stores st
      on st.id = ca.store_id
    join public.cyclic_products p
      on p.id = ca.product_id
    left join public.stock_general sg
      on sg.sede = coalesce(nullif(st.erp_sede, ''), st.name)
     and sg.codsap = p.sku
    where ca.assigned_date = p_date
      and (p_store_id is null or ca.store_id = p_store_id)
      and not exists (
        select 1
        from public.cyclic_counts cc
        where cc.assignment_id = ca.id
          and coalesce(cc.location, '') not like '__session_%'
      )
  )
  update public.cyclic_assignments ca
  set system_stock = latest_stock.stock
  from latest_stock
  where ca.id = latest_stock.id
    and ca.system_stock is distinct from latest_stock.stock;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

notify pgrst, 'reload schema';
