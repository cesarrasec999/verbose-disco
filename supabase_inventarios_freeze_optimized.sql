-- Optimiza el congelado de inventario general:
-- 1. Congela solo productos con stock sistemico mayor a 0.
-- 2. Excluye no inventariables globales (cyclic_non_inventory_products) y por sesion.
-- 3. Agrega indices para que el primer congelado no dependa de scans lentos.

create index if not exists idx_stock_general_sede_stock_codsap
  on public.stock_general(sede, codsap)
  where stock > 0;

create index if not exists idx_cyclic_products_sku_active
  on public.cyclic_products(sku)
  where is_active = true;

create index if not exists idx_cyclic_non_inventory_active_sku
  on public.cyclic_non_inventory_products(sku)
  where is_active = true;

-- La restriccion unique (session_id, sku) ya crea un indice equivalente.

create or replace function public.freeze_general_inventory_stock(
  p_session_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_sede text;
  v_inserted integer;
begin
  perform set_config('statement_timeout', '5min', true);

  select s.store_id, coalesce(nullif(st.erp_sede, ''), st.name)
    into v_store_id, v_sede
  from public.general_inventory_sessions s
  join public.stores st on st.id = s.store_id
  where s.id = p_session_id
    and s.status in ('planned', 'open', 'frozen');

  if v_store_id is null then
    raise exception 'Sesion no encontrada o no disponible para congelar';
  end if;

  delete from public.general_inventory_stock_snapshot
  where session_id = p_session_id;

  insert into public.general_inventory_stock_snapshot (
    session_id,
    product_id,
    sku,
    description,
    unit,
    system_stock,
    cost,
    frozen_at
  )
  select
    p_session_id,
    p.id,
    p.sku,
    p.description,
    p.unit,
    sg.stock::numeric,
    coalesce(sg.costo, p.cost, 0)::numeric,
    now()
  from public.stock_general sg
  join public.cyclic_products p
    on p.sku = sg.codsap
  where sg.sede = v_sede
    and sg.stock > 0
    and p.is_active = true
    and not exists (
      select 1
      from public.cyclic_non_inventory_products ni
      where ni.is_active = true
        and ni.sku = p.sku
    )
    and not exists (
      select 1
      from public.general_inventory_non_inventory_products ni
      where ni.session_id = p_session_id
        and ni.sku = p.sku
    );

  get diagnostics v_inserted = row_count;

  update public.general_inventory_sessions
  set status = 'frozen',
      frozen_by = p_user_id,
      stock_frozen_at = now(),
      frozen_total_value = coalesce((
        select round(sum(system_value)::numeric, 2)
        from public.general_inventory_stock_snapshot
        where session_id = p_session_id
      ), 0),
      updated_at = now()
  where id = p_session_id;

  return v_inserted;
end;
$$;
